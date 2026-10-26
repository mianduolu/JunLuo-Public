import { innerMaterialKey } from '../chat/chatAfterglowState';
import type { LifeMaterialItem } from '../ai/lifeMaterialHub';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { JunLuoToolAuditRecord } from '../tools/toolAuditTypes';
import type { JunLuoToolResult } from '../tools/toolTypes';
import type { CameraObservationRecordV1 } from './cameraObservationTypes';
import { buildCameraModelObservationInnerMaterial, buildCameraModelObservationSummary, CAMERA_LOOK_ONCE_TOOL_ID } from './cameraModelObservationMaterials';

const PREFIX = 'camera-tool:';
type MaterialRef = { id: string; createdAt: number; revision: string };
export type CameraModelObservationInnerMaterialPorts = {
  listAudits(): Promise<readonly JunLuoToolAuditRecord[]>;
  audit(callId: string): Promise<JunLuoToolAuditRecord | null | undefined>;
  message(sessionId: string, messageId: string): Promise<SubjectiveMessage | null | undefined>;
  observation(actionId: string): Promise<CameraObservationRecordV1 | null | undefined>;
};
const ports: CameraModelObservationInnerMaterialPorts = {
  listAudits: async () => (await import('../tools/toolAuditStore')).loadRecentToolCalls(200),
  audit: async callId => (await import('../tools/toolAuditStore')).loadToolAuditRecord(callId),
  message: async (sessionId, messageId) => (await import('../chat/chatStorage')).loadChatSessionMessage(sessionId, messageId),
  observation: async actionId => (await import('./cameraObservationStore')).getCameraObservationRecordByActionId(actionId),
};

export const isCameraModelObservationMaterialId = (id: string) => id.startsWith(PREFIX) && id.length > PREFIX.length;
const validTime = (at: unknown, now: number): at is number => typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 && at <= now;

async function loadMaterial(callId: string, now: number, source: CameraModelObservationInnerMaterialPorts): Promise<LifeMaterialItem | undefined> {
  const audit = await source.audit(callId);
  if (!audit || audit.callId !== callId || audit.toolId !== CAMERA_LOOK_ONCE_TOOL_ID
    || (audit.source !== 'chat' && audit.source !== 'proactive')
    || audit.agent?.settlement === 'aborted' || audit.agent?.settlement === 'outcome_unknown'
    || !validTime(audit.finishedAt, now) || !audit.cameraReply?.sessionId || !audit.cameraReply.messageIds.length) return;
  const replyIds = [...new Set(audit.cameraReply.messageIds)];
  const replies = await Promise.all(replyIds.map(id => source.message(audit.cameraReply!.sessionId, id)));
  if (replies.some((message, index) => !message || message.id !== replyIds[index] || message.role !== 'I'
    || message.deliveryStatus === 'failed' || !message.content.trim() || !validTime(message.createdAt, now))) return;
  const base = { callId, toolId: CAMERA_LOOK_ONCE_TOOL_ID, startedAt: audit.startedAt ?? audit.createdAt, finishedAt: audit.finishedAt };
  let result: JunLuoToolResult;
  let observation: CameraObservationRecordV1 | undefined;
  if (audit.status === 'success') {
    observation = await source.observation(callId) ?? undefined;
    if (!observation || observation.actionId !== callId || observation.triggerKind !== 'action_opportunity'
      || !observation.observationId || !validTime(observation.persistedAt, now)
      || observation.cleanup.cleanupState !== 'verified_deleted' || !observation.cleanup.deletionVerified) return;
    result = { ...base, ok: true, status: 'success', summary: buildCameraModelObservationSummary(observation) };
  } else {
    const failure = audit.status === 'error' && audit.resultSummary === '本次摄像头观察未完成。'
      ? { status: 'error' as const, code: 'CAMERA_OBSERVATION_FAILED' as const }
      : audit.status === 'cancelled' && audit.resultSummary === '本次摄像头观察已取消。'
        ? { status: 'cancelled' as const, code: 'CANCELLED_BY_YOU' as const }
        : audit.status === 'permission_denied' && audit.resultSummary === '本次摄像头观察未获执行许可。'
          ? { status: 'permission_denied' as const, code: 'PERMISSION_DENIED' as const } : undefined;
    if (!failure) return;
    result = { ...base, ok: false, status: failure.status, summary: audit.resultSummary!,
      error: { code: failure.code, message: failure.code } };
  }
  const promptLine = buildCameraModelObservationInnerMaterial(result);
  return {
    id: `${PREFIX}${callId}`, source: 'tool-audit', title: CAMERA_LOOK_ONCE_TOOL_ID,
    summary: result.summary, promptLine, occurredAt: audit.finishedAt, importance: 'low', freshness: 'recent',
    fingerprint: innerMaterialKey([callId, audit.status, audit.finishedAt, result.summary, observation,
      audit.cameraReply.sessionId, replies.map(message => [message!.id, message!.createdAt, message!.role, message!.content])]),
  };
}

/** Only these two papers call this collector; camera never joins the global life hub. */
export async function loadCameraModelObservationInnerMaterials(input: {
  now: number; activatedAt: number; read: Readonly<Record<string, string>>; refs?: readonly MaterialRef[];
}, source: CameraModelObservationInnerMaterialPorts = ports): Promise<LifeMaterialItem[]> {
  const ids = input.refs !== undefined
    ? input.refs.filter(ref => isCameraModelObservationMaterialId(ref.id)).map(ref => ref.id.slice(PREFIX.length))
    : (await source.listAudits()).filter(audit => audit.toolId === CAMERA_LOOK_ONCE_TOOL_ID && audit.cameraReply).map(audit => audit.callId);
  const items: LifeMaterialItem[] = [];
  for (const id of new Set(ids)) {
    if (Object.hasOwn(input.read, `${PREFIX}${id}`)) continue;
    const item = await loadMaterial(id, input.now, source).catch(() => undefined);
    if (item && item.occurredAt > input.activatedAt) items.push(item);
  }
  return items.sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id));
}

/** Re-read original IDs, never the current recent-list membership or an old summary copy. */
export async function cameraModelObservationInnerSourcesMatch(refs: readonly MaterialRef[],
  source: CameraModelObservationInnerMaterialPorts = ports): Promise<boolean> {
  for (const ref of refs) {
    if (!isCameraModelObservationMaterialId(ref.id)) return false;
    const current = await loadMaterial(ref.id.slice(PREFIX.length), Date.now(), source).catch(() => undefined);
    if (!current || current.occurredAt !== ref.createdAt || current.fingerprint !== ref.revision) return false;
  }
  return true;
}
