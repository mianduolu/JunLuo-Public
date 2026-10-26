import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { RunOpenAiCompatibleToolAgentTurnOptions } from '../ai/toolAgentProvider';
import type { JunLuoToolResult } from '../tools/toolTypes';
import { createToolAgentHostCallId } from '../tools/toolAgentHostIdentity';
import { loadToolAuditRecord, recordCameraToolReply } from '../tools/toolAuditStore';
import { loadChatSessionMessage, loadChatSessionMessagePage, loadChatStateFast } from '../chat/chatStorage';
import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { buildCameraModelObservationInnerMaterial, buildCameraModelObservationLateInstruction,
  CAMERA_LOOK_ONCE_TOOL_ID } from './cameraModelObservationMaterials';

export type CameraLateSettlement = Parameters<NonNullable<RunOpenAiCompatibleToolAgentTurnOptions['onLateSettlement']>>[0];

export async function cameraReplySourceIsCurrent(sessionId: string, sourceMessageId: string,
  source?: Pick<SubjectiveMessage, 'content' | 'createdAt'>) {
  const chat = await loadChatStateFast({ activeMessageLimit: 1 });
  const session = chat.sessions.find(item => item.id === sessionId);
  if (!session || chat.activeSessionId !== sessionId) return false;
  let beforeIndex: number | undefined;
  for (;;) {
    const page = await loadChatSessionMessagePage(sessionId, { limit: 32, beforeIndex });
    const latestYou = page.messages.filter(message => message.role === 'you').at(-1);
    if (latestYou) return latestYou.id === sourceMessageId && latestYou.deliveryStatus !== 'failed'
      && (!source || latestYou.content === source.content && latestYou.createdAt === source.createdAt);
    if (!page.messages.length || page.startIndex === 0) return false;
    beforeIndex = page.startIndex;
  }
}

/** Link IDs only, after the real body commit. No model text or observation copies. */
export async function recordCameraObservationReply(input: {
  turnId: string; sessionId: string; dataEpoch: number;
  results: readonly JunLuoToolResult[]; messageIds: readonly string[];
}) {
  const results = input.results.filter(result => result.toolId === CAMERA_LOOK_ONCE_TOOL_ID
    && Boolean(buildCameraModelObservationInnerMaterial(result)));
  if (!results.length || !input.messageIds.length) return;
  await runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
    const messages = await Promise.all(input.messageIds.map(id => loadChatSessionMessage(input.sessionId, id)));
    if (messages.some(message => !message || message.role !== 'I' || !message.content.trim() || message.deliveryStatus === 'failed')) return;
    for (const result of results) {
      if (!canCommitBackupRestoreDataEpoch(input.dataEpoch)) return;
      const auditId = createToolAgentHostCallId(input.turnId, result.callId);
      const audit = await loadToolAuditRecord(auditId);
      if (!audit || audit.toolId !== CAMERA_LOOK_ONCE_TOOL_ID || audit.status !== result.status
        || audit.finishedAt !== result.finishedAt) continue;
      await recordCameraToolReply(auditId, { sessionId: input.sessionId, messageIds: [...input.messageIds] });
    }
  });
}

/** A live original turn's handoff, not a persisted queue or a new contact. */
export function createCameraReplyContinuation(ports: {
  current(): Promise<boolean>;
  delivered(): Promise<SubjectiveMessage[]>;
  continue(event: CameraLateSettlement, instruction: string): Promise<void>;
}) {
  let pending: CameraLateSettlement | undefined;
  let attempted = false;
  let running: Promise<void> | undefined;
  const drain = () => {
    if (!pending || attempted) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      if (!await ports.current()) return;
      const messages = (await ports.delivered()).filter(message => message.role === 'I'
        && message.content.trim() && message.deliveryStatus !== 'failed');
      if (!messages.length || !await ports.current()) return;
      attempted = true;
      const instruction = buildCameraModelObservationLateInstruction(messages.map(message => ({
        role: 'I', createdAt: message.createdAt, content: message.content,
      })));
      await ports.continue(pending!, instruction);
    })().finally(() => { running = undefined; });
    return running;
  };
  return {
    async bodyCommitted() {
      // An earlier read may still be returning the pre-commit empty message list.
      if (running) await running;
      await drain();
    },
    async settled(event: CameraLateSettlement) {
      if (!event.dataEpochStillCurrent || event.result.toolId !== CAMERA_LOOK_ONCE_TOOL_ID
        || !buildCameraModelObservationInnerMaterial(event.result)) return;
      pending = event;
      await drain();
    },
  };
}
