import type { AiConnection } from '../ai/types';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { ChatContextCompressionState } from './chatStorage';
import type { useChatSessionsController } from './useChatSessionsController';
import type { MemoryEntry } from '../memory/memoryStore';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { formatMemoryEventTimeLabel } from '../memory/memoryAtomicity';
import { applyChatSummaryCorrections, completeChatSummaryCorrectionReview, formatChatSummaryCorrections,
  type ChatSummaryCorrectionReview } from './chatSummaryCorrection';
import { assertChatSummaryCorrectionSnapshotCurrent, prepareChatSummaryCorrectionState } from './chatSummaryCorrectionStore';
import {
  appendChatShortLog,
  createChatShortLog,
  estimateTextTokens,
  generateContextSummary,
  getCompressionCandidates,
  getShortLogCandidates,
  shouldCompressContext,
  shouldGenerateShortLog,
} from './contextCompression';

type ChatSessionsController = ReturnType<typeof useChatSessionsController>;

export type ChatContextCompressorOptions = {
  activeSessionRef: { current: string | null };
  chatConnection?: AiConnection;
  chatKey: string;
  memoryOrganizerConnection?: AiConnection;
  memoryOrganizerKey: string;
  compressionInFlightRef: { current: boolean };
  compressionStateRef: { current: ChatContextCompressionState };
  setCompressingContext: (value: boolean) => void;
  setCompressionState: (value: ChatContextCompressionState) => void;
  showTransientMemoryNotice: (notice: string) => void;
  setError: (message: string | null) => void;
  patchSession: ChatSessionsController['patchSession'];
};

export function createChatContextCompressor({
  activeSessionRef,
  chatConnection,
  chatKey,
  memoryOrganizerConnection,
  memoryOrganizerKey,
  compressionInFlightRef,
  compressionStateRef,
  setCompressingContext,
  setCompressionState,
  showTransientMemoryNotice,
  setError,
  patchSession,
}: ChatContextCompressorOptions) {
  const compressConversationContext = async (
    currentMessages: SubjectiveMessage[],
    manual = false,
  ) => {
    if (compressionInFlightRef.current || !chatConnection) return;
    const targetSessionId = activeSessionRef.current;
    if (!targetSessionId) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    const initialState = compressionStateRef.current;
    if (!manual && !shouldCompressContext(currentMessages, initialState, chatConnection)
      && !shouldGenerateShortLog(currentMessages, initialState, false)) return;
    const summaryConnection = memoryOrganizerConnection ?? chatConnection;
    const summaryKey = memoryOrganizerConnection ? memoryOrganizerKey : chatKey;
    if (!summaryKey.trim()) {
      if (manual) setError('没有可用于生成上下文摘要的连接。');
      return;
    }

    compressionInFlightRef.current = true;
    let attemptedCompression = false;
    setCompressingContext(true);
    try {
      const prepared = await prepareChatSummaryCorrectionState(targetSessionId, initialState);
      const currentState = prepared.state;
      const storage = await import('./chatStorage');
      const memoryStore = await import('../memory/memoryStore');
      const usedMemories = new Map<string, MemoryEntry>();
      const assertCurrent = async () => {
        if (activeSessionRef.current !== targetSessionId) throw new Error('chat-summary-correction-stale');
        await assertChatSummaryCorrectionSnapshotCurrent(prepared);
        for (const memory of usedMemories.values()) {
          if (!await memoryStore.isCurrentMemory(memory)) throw new Error('chat-summary-correction-source-changed');
        }
        if (activeSessionRef.current !== targetSessionId) throw new Error('chat-summary-correction-stale');
      };
      const materialsFor = async (review: ChatSummaryCorrectionReview | undefined) => {
        const materials: MemoryEntry[] = [];
        const receipts = [];
        for (const pending of review?.pending ?? []) {
          const snapshot = prepared.snapshots.find(item => item.memoryId === pending.memoryId && item.correction.id === pending.correctionId);
          const memory = prepared.memories.find(item => item.id === pending.memoryId);
          if (!snapshot || !memory || !await memoryStore.isCurrentMemory(memory)) throw new Error('chat-summary-correction-source-changed');
          materials.push(memory); usedMemories.set(memory.id, memory);
          receipts.push({ memoryId: memory.id, correctionId: snapshot.correction.id, materialHash: snapshot.materialHash });
        }
        return { receipts, corrections: formatChatSummaryCorrections(materials.map(memory => ({
          title: memory.title, content: memory.content, timeLabel: formatMemoryEventTimeLabel(memory.eventTime),
          tags: memory.tags, recallCues: memory.recallCues, rememberedReason: memory.rememberedReason,
        }))) };
      };
      await assertCurrent();
      // Preparation has already persisted new pauses; publish that same durable draft before generation.
      compressionStateRef.current = currentState;
      setCompressionState(currentState);
      patchSession(targetSessionId, { contextCompression: currentState });
      const shouldCompress = manual || shouldCompressContext(currentMessages, currentState, chatConnection);
      const shouldCreateShortLog = shouldGenerateShortLog(currentMessages, currentState, manual);
      const candidates = shouldCompress ? getCompressionCandidates(currentMessages, currentState) : [];
      const rebuildMain = manual && !!currentState.correctionReview?.pending.length;
      const pendingLog = (manual || shouldCreateShortLog)
        ? currentState.shortLogs?.find(log => log.correctionReview?.pending.length) : undefined;
      const shortLogCandidates = !pendingLog && shouldCreateShortLog ? getShortLogCandidates(currentMessages, currentState) : [];
      attemptedCompression = candidates.length > 0 || rebuildMain;
      if (!attemptedCompression && !pendingLog && !shortLogCandidates.length) {
        if (manual) showTransientMemoryNotice('最近六轮会保留原文，现在还没有更早的对话可以整理。');
        return;
      }
      let next: ChatContextCompressionState = {
        ...currentState,
        shortLogs: currentState.shortLogs ?? [],
      };
      let compressed = false;
      let shortLogged = false;

      if (attemptedCompression) {
        const boundary = candidates[candidates.length - 1];
        const target = applyChatSummaryCorrections({ ...currentState,
          summarizedThroughMessageId: boundary?.id ?? currentState.summarizedThroughMessageId,
          correctionReview: currentState.correctionReview ?? { version: 1 as const, accepted: [], pending: [] },
        }, prepared.snapshots, prepared.context);
        const materials = await materialsFor(target.correctionReview);
        await assertCurrent();
        const summary = await generateContextSummary({
          apiKey: summaryKey,
          connection: summaryConnection,
          messages: candidates,
          previousSummary: currentState.summary,
          corrections: materials.corrections,
        });
        await assertCurrent();
        const endId = boundary?.id ?? currentState.summarizedThroughMessageId;
        const retained = currentMessages.slice(currentMessages.findIndex((message) => message.id === endId) + 1);
        next = {
          ...next,
          summaryVersion: 2,
          summary,
          summarizedThroughMessageId: endId,
          summarizedThroughAt: boundary?.createdAt ?? currentState.summarizedThroughAt,
          correctionReview: completeChatSummaryCorrectionReview(target.correctionReview, materials.receipts, prepared.snapshots),
          lastCompressedAt: Math.max(Date.now(), (currentState.lastCompressedAt ?? 0) + 1),
          lastBeforeTokens: currentState.currentWindowTokens || estimateTextTokens(currentMessages.map((message) => message.content).join('\n')),
          lastAfterTokens: estimateTextTokens(`${summary}\n${retained.map((message) => message.content).join('\n')}`),
          currentWindowTokens: estimateTextTokens(`${summary}\n${retained.map((message) => message.content).join('\n')}`),
          promptBreakdown: currentState.promptBreakdown,
          tokenSource: 'estimate',
          lastError: undefined,
          lastFailedAt: undefined,
        };
        compressed = true;
      }

      if (pendingLog || shortLogCandidates.length) {
        const logReview = pendingLog?.correctionReview ?? applyChatSummaryCorrections({ summary: '', shortLogs: [{
          id: 'new-range', startMessageId: shortLogCandidates[0].id,
          endMessageId: shortLogCandidates[shortLogCandidates.length - 1].id,
          correctionReview: undefined as ChatSummaryCorrectionReview | undefined,
        }] }, prepared.snapshots, prepared.context).shortLogs[0].correctionReview;
        const materials = await materialsFor(logReview);
        await assertCurrent();
        const shortSummary = await generateContextSummary({
          apiKey: summaryKey,
          connection: summaryConnection,
          messages: shortLogCandidates,
          previousSummary: pendingLog?.summary,
          corrections: materials.corrections,
        });
        await assertCurrent();
        const title = shortSummary.replace(/\s+/g, ' ').trim();
        const shortLog = pendingLog ? { ...pendingLog, summary: shortSummary,
          title: title.length > 18 ? `${title.slice(0, 18)}...` : title,
          correctionReview: completeChatSummaryCorrectionReview(logReview, materials.receipts, prepared.snapshots),
        } : createChatShortLog(shortLogCandidates, shortSummary, manual ? 'manual' : 'auto');
        if (shortLog) {
          if (!pendingLog) shortLog.correctionReview = completeChatSummaryCorrectionReview(logReview, materials.receipts, prepared.snapshots);
          next = pendingLog ? { ...next, shortLogs: next.shortLogs?.map(log => log.id === pendingLog.id ? shortLog : log) }
            : appendChatShortLog(next, shortLog);
          shortLogged = true;
        }
      }

      if (!compressed && !shortLogged) {
        if (manual) showTransientMemoryNotice('这段聊天暂时不需要整理。');
        return;
      }
      await assertCurrent();
      const committed = await storage.commitChatContextCompressionState(targetSessionId, next, {
        expected: currentState, dataEpoch: prepared.dataEpoch, shouldCommit: () => activeSessionRef.current === targetSessionId,
      });
      if (activeSessionRef.current !== targetSessionId) return;
      compressionStateRef.current = committed;
      setCompressionState(committed);
      patchSession(targetSessionId, { contextCompression: committed });
      if (manual) {
        showTransientMemoryNotice(compressed
          ? '更早的对话已经压成摘要，最近几轮仍会保留原文。'
          : '这段聊天的小便签已经整理好，完整聊天记录还在。');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'summary-failed';
      if (attemptedCompression || manual) {
        const failed: ChatContextCompressionState = {
          ...compressionStateRef.current,
          lastError: `上下文整理失败：${message}`,
          lastFailedAt: Date.now(),
        };
        if (activeSessionRef.current === targetSessionId && canCommitBackupRestoreDataEpoch(dataEpoch)) {
          compressionStateRef.current = failed;
          setCompressionState(failed);
        }
      }
      if (manual) setError('上下文整理失败，稍后再试。');
    } finally {
      compressionInFlightRef.current = false;
      setCompressingContext(false);
    }
  };

  return { compressConversationContext };
}
