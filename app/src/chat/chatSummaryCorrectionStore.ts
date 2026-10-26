import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import type { MemoryEntry } from '../memory/memoryStore';
import type { ChatContextCompressionState } from './chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from './primaryChat';
import {
  applyChatSummaryCorrections, completeChatSummaryCorrectionReview, pauseChatSummaryCorrectionForDeletion,
  normalizeChatSummaryCorrectionReview, normalizeMemoryChatSummaryCorrection,
  type ChatSummaryCorrectionContext, type ChatSummaryCorrectionReview, type ChatSummaryCorrectionSnapshot,
  type MemoryChatSummaryCorrection,
} from './chatSummaryCorrection';

export type PreparedChatSummaryCorrection = {
  sessionId: string;
  state: ChatContextCompressionState;
  snapshots: ChatSummaryCorrectionSnapshot[];
  memories: MemoryEntry[];
  context: ChatSummaryCorrectionContext;
  fingerprint: string;
  dataEpoch: number;
};

function assertEpoch(epoch: number | null): asserts epoch is number {
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('chat-summary-correction-stale');
}

function snapshotFingerprint(snapshots: readonly ChatSummaryCorrectionSnapshot[]) {
  return JSON.stringify([...snapshots].sort((a, b) => a.memoryId.localeCompare(b.memoryId))
    .map(snapshot => [snapshot.memoryId, snapshot.correction, snapshot.materialHash]));
}

/** Complete collection, including archived cards; corrupt metadata is never an empty collection. */
export async function loadChatSummaryCorrectionSnapshots(): Promise<{
  snapshots: ChatSummaryCorrectionSnapshot[]; memories: MemoryEntry[];
}> {
  const epoch = captureBackupRestoreDataEpoch();
  assertEpoch(epoch);
  const store = await import('../memory/memoryStore');
  const { weeklyTargetHash } = await import('../memory/memoryWeeklyBasis');
  const database = await store.getMemoryDatabase();
  const rows = await database.getAllAsync<Parameters<typeof store.memoryFromRow>[0]>(
    'SELECT * FROM memories WHERE chat_summary_correction_json IS NOT NULL ORDER BY id',
  );
  const snapshots: ChatSummaryCorrectionSnapshot[] = [];
  const memories = rows.map(row => {
    const correction = normalizeMemoryChatSummaryCorrection(JSON.parse(row.chat_summary_correction_json!));
    if (!correction) throw new Error('chat-summary-correction-invalid');
    const memory = store.memoryFromRow(row);
    snapshots.push({ memoryId: memory.id, correction, materialHash: weeklyTargetHash(memory) });
    return memory;
  });
  assertEpoch(epoch);
  return { snapshots, memories };
}

export async function assertChatSummaryCorrectionSnapshotCurrent(prepared: PreparedChatSummaryCorrection): Promise<void> {
  assertEpoch(prepared.dataEpoch);
  const current = await loadChatSummaryCorrectionSnapshots();
  assertEpoch(prepared.dataEpoch);
  if (snapshotFingerprint(current.snapshots) !== prepared.fingerprint) throw new Error('chat-summary-correction-stale');
}

function acceptMatchingReceipts(review: ChatSummaryCorrectionReview | undefined, snapshots: ChatSummaryCorrectionSnapshot[]) {
  const normalized = normalizeChatSummaryCorrectionReview(review);
  if (!normalized?.pending.length) return normalized;
  const receipts = normalized.accepted.filter(receipt => normalized.pending.some(pending => (
    pending.memoryId === receipt.memoryId && pending.correctionId === receipt.correctionId
  )) && snapshots.some(snapshot => snapshot.memoryId === receipt.memoryId
    && snapshot.correction.id === receipt.correctionId && snapshot.materialHash === receipt.materialHash));
  return receipts.length ? completeChatSummaryCorrectionReview(normalized, receipts, snapshots) : normalized;
}

function reviewFingerprint(state: ChatContextCompressionState) {
  return JSON.stringify([state.correctionReview, state.shortLogs?.map(log => [log.id, log.correctionReview])]);
}

/** Receipts belong to the persisted prose. Only its matching current receipts can release sticky remote pending. */
export async function prepareChatSummaryCorrectionState(
  sessionId: string, fallbackState: ChatContextCompressionState, options: { readOnly?: boolean } = {},
): Promise<PreparedChatSummaryCorrection> {
  const epoch = captureBackupRestoreDataEpoch();
  assertEpoch(epoch);
  const storage = await import('./chatStorage');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const [persisted, messageOrder, current] = await Promise.all([
        storage.loadChatContextCompressionState(sessionId),
        storage.loadChatSessionMessageOrder(sessionId, { strict: true }),
        loadChatSummaryCorrectionSnapshots(),
      ]);
      assertEpoch(epoch);
      const context = { sessionId, messageOrder };
      const original = persisted ?? fallbackState;
      const applied = applyChatSummaryCorrections(original, current.snapshots, context);
      const state: ChatContextCompressionState = { ...applied,
        correctionReview: acceptMatchingReceipts(applied.correctionReview, current.snapshots),
        ...(applied.shortLogs ? { shortLogs: applied.shortLogs.map(log => ({ ...log,
          correctionReview: acceptMatchingReceipts(log.correctionReview, current.snapshots),
        })) } : {}),
      };
      const prepared = { sessionId, state, ...current, context, fingerprint: snapshotFingerprint(current.snapshots), dataEpoch: epoch };
      await assertChatSummaryCorrectionSnapshotCurrent(prepared);
      if (!options.readOnly && reviewFingerprint(original) !== reviewFingerprint(state)) {
        prepared.state = await storage.commitChatContextCompressionState(sessionId, state, { expected: persisted, dataEpoch: epoch });
      }
      assertEpoch(epoch);
      return prepared;
    } catch (error) {
      if (attempt || !(error instanceof Error) || error.message !== 'chat-summary-correction-stale'
        || !canCommitBackupRestoreDataEpoch(epoch)) throw error;
    }
  }
  throw new Error('chat-summary-correction-stale');
}

/** Called before deletion and outside the memory transaction. Never reads memoryDB or creates a chat session. */
export async function pauseChatSummaryForDeletedCorrection(memoryId: string, marker: MemoryChatSummaryCorrection): Promise<void> {
  if (!memoryId.trim()) throw new Error('chat-summary-correction-invalid');
  const correction = normalizeMemoryChatSummaryCorrection(marker);
  if (!correction) throw new Error('chat-summary-correction-invalid');
  const epoch = captureBackupRestoreDataEpoch();
  assertEpoch(epoch);
  const storage = await import('./chatStorage');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const [persisted, messageOrder] = await Promise.all([
        storage.loadChatContextCompressionState(PRIMARY_CHAT_SESSION_ID),
        storage.loadChatSessionMessageOrder(PRIMARY_CHAT_SESSION_ID, { strict: true }),
      ]);
      assertEpoch(epoch);
      const original = persisted ?? storage.emptyChatContextCompressionState;
      const context = { sessionId: PRIMARY_CHAT_SESSION_ID, messageOrder };
      const state = pauseChatSummaryCorrectionForDeletion(original, memoryId, correction, context);
      if (reviewFingerprint(original) !== reviewFingerprint(state)) {
        await storage.commitChatContextCompressionState(PRIMARY_CHAT_SESSION_ID, state, { expected: persisted, dataEpoch: epoch });
      }
      assertEpoch(epoch);
      return;
    } catch (error) {
      if (attempt || !(error instanceof Error) || error.message !== 'chat-summary-correction-stale'
        || !canCommitBackupRestoreDataEpoch(epoch)) throw error;
    }
  }
}
