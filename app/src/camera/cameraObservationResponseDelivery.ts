import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { JunLuoToolResult } from '../tools/toolTypes';
import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { loadChatSessionMessage } from '../chat/chatStorage';
import {
  getCameraObservationRecord, getCameraObservationResponse, listPendingCameraObservationResponses,
  cancelCameraObservationResponse, saveCameraObservationReplyDraft, completeCameraObservationResponses,
} from './cameraObservationStore';
import type { CameraObservationReplyDraft, CameraObservationResponse } from './cameraObservationTypes';
import { buildCameraObservationResponseContext } from './cameraEvidenceFusion';
import { buildCameraObservationResponseMaterial } from './cameraObservationResponseMaterials';

type FreshManualReply = { observationId: string; dataEpoch: number };
let freshManualReply: FreshManualReply | undefined;
const freshListeners = new Set<() => void>();

/** Volatile click authority. Reloading this module cannot recover permission to make a paid request. */
export function armFreshCameraManualReply(observationId: string, dataEpoch: number | null) {
  if (dataEpoch === null || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
  freshManualReply = { observationId, dataEpoch };
  for (const listener of freshListeners) listener();
}

export function subscribeFreshCameraManualReply(listener: () => void) {
  freshListeners.add(listener);
  return () => { freshListeners.delete(listener); };
}

export function takeFreshCameraManualReply() {
  const intent = freshManualReply;
  freshManualReply = undefined;
  return intent && canCommitBackupRestoreDataEpoch(intent.dataEpoch) ? intent : undefined;
}

export function cameraObservationIdsFromResults(results: readonly JunLuoToolResult[]) {
  return [...new Set(results.filter(result => result.toolId === 'camera.look_once' && result.ok && result.status === 'success')
    .map(result => (result.data as { observationId?: unknown } | undefined)?.observationId)
    .filter((id): id is string => typeof id === 'string' && !!id.trim()))];
}

async function sourceExists(response: CameraObservationResponse) {
  if (response.binding.origin !== 'chat_tool') return true;
  const source = await loadChatSessionMessage(response.binding.targetSessionId, response.binding.sourceTurnId);
  return source?.role === 'you' && source.deliveryStatus !== 'failed';
}

/** One deterministic pending observation, never lexical relevance or an automatic contact. */
export async function prepareCameraObservationResponse(input: {
  sessionId: string; dataEpoch: number; observationId?: string; manualShare?: boolean;
}) {
  if (!canCommitBackupRestoreDataEpoch(input.dataEpoch)) return;
  const candidates = input.observationId ? [await getCameraObservationResponse(input.observationId)]
    : await listPendingCameraObservationResponses(input.sessionId);
  for (const response of candidates) {
    if (!response || response.binding.targetSessionId !== input.sessionId
      || !['pending', 'draft_ready'].includes(response.status)) continue;
    if (!await sourceExists(response)) {
      await runBackupRestoreDataEpochCommit(input.dataEpoch, () => cancelCameraObservationResponse(response.observationId));
      continue;
    }
    const record = await getCameraObservationRecord(response.observationId).catch(() => undefined);
    if (!record || !canCommitBackupRestoreDataEpoch(input.dataEpoch)) continue;
    if (response.draft) {
      const saved = await Promise.all(response.draft.messages.map(message => loadChatSessionMessage(input.sessionId, message.id)));
      if (saved.some((message, index) => message && (message.role !== 'I' || message.content !== response.draft!.messages[index].content))) {
        throw new Error('camera_reply_saved_message_conflict');
      }
      // Even fully saved bodies enter local recovery: the adopted inner reaction may still need saving.
      // Stable message IDs make re-saving the bodies idempotent; no model is invoked here.
    }
    let ownDraft = response.draft;
    const current = async () => {
      if (!canCommitBackupRestoreDataEpoch(input.dataEpoch)) return false;
      const actual = await getCameraObservationResponse(response.observationId);
      if (!actual || actual.status === 'cancelled' || actual.binding.targetSessionId !== input.sessionId
        || actual.binding.sourceTurnId !== response.binding.sourceTurnId || !await sourceExists(actual)) return false;
      if (actual.status === 'draft_ready' && actual.draft?.replyId !== ownDraft?.replyId) return false;
      if (actual.status === 'delivered' && (!ownDraft || actual.messageIds.join('\0') !== ownDraft.messages.map(m => m.id).join('\0'))) return false;
      return !!await getCameraObservationRecord(response.observationId).catch(() => undefined)
        && canCommitBackupRestoreDataEpoch(input.dataEpoch);
    };
    let logs: Parameters<typeof buildCameraObservationResponseContext>[0] = [];
    if (record.sourceKind !== 'pc_webcam') try {
      const { loadPersistedPhoneUsageSegmentsOverlapping } = await import('../phoneActivity/phoneActivityStore');
      logs = await loadPersistedPhoneUsageSegmentsOverlapping(record.capturedAt - 30 * 60_000, record.capturedAt);
    } catch { /* Optional, existing read-only activity context. */ }
    const material = buildCameraObservationResponseMaterial({ record, requestedAt: response.binding.requestedAt,
      manualShare: input.manualShare === true && response.binding.origin === 'manual_share',
      responseContext: buildCameraObservationResponseContext(logs, record.capturedAt) });
    if (!await current()) return;
    return { response, record, material, current, ownDraft: (draft: CameraObservationReplyDraft) => { ownDraft = draft; } };
  }
}

export async function saveCameraResponseDraft(input: {
  observationIds: string[]; replyId: string; messages: SubjectiveMessage[]; adoptedReply?: string;
  dataEpoch: number; canCommit?: () => boolean;
}) {
  if (!input.observationIds.length) return;
  const current = () => canCommitBackupRestoreDataEpoch(input.dataEpoch) && (input.canCommit?.() ?? true);
  if (!current()) throw new Error('camera_reply_stale');
  const boundIds: string[] = [];
  for (const id of [...new Set(input.observationIds)]) {
    const response = await getCameraObservationResponse(id);
    if (!response) {
      // Existing unbound records never acquire a reply obligation during migration/replay.
      await getCameraObservationRecord(id);
      continue;
    }
    if (response.status === 'cancelled' || !await sourceExists(response)) throw new Error('camera_reply_stale');
    boundIds.push(id);
  }
  if (!boundIds.length) return;
  const commit = await runBackupRestoreDataEpochCommit(input.dataEpoch, () => saveCameraObservationReplyDraft(
    boundIds, { replyId: input.replyId, messages: input.messages,
      ...(input.adoptedReply !== undefined ? { adoptedReply: input.adoptedReply } : {}) }, current));
  if (!commit.committed) throw new Error('camera_reply_stale');
}

export async function cameraObservationResponsesCurrent(observationIds: string[], allowDelivered = false) {
  for (const id of observationIds) {
    if (!await getCameraObservationRecord(id).catch(() => undefined)) return false;
    const response = await getCameraObservationResponse(id);
    if (response && (response.status === 'cancelled' || response.status === 'delivered' && !allowDelivered || !await sourceExists(response))) return false;
  }
  return true;
}

/** True saved I bodies are the receipt. A rendered bubble or a model's promise is not delivery. */
export async function completeCameraResponseDelivery(input: {
  observationIds: string[]; sessionId: string; messageIds: readonly string[];
  dataEpoch: number; canCommit?: () => boolean;
}) {
  if (!input.observationIds.length || !input.messageIds.length) return;
  const current = () => canCommitBackupRestoreDataEpoch(input.dataEpoch) && (input.canCommit?.() ?? true);
  if (!current()) return;
  const saved = await Promise.all(input.messageIds.map(id => loadChatSessionMessage(input.sessionId, id)));
  if (saved.some(message => !message || message.role !== 'I' || !message.content.trim() || message.deliveryStatus === 'failed')) return;
  for (const id of [...new Set(input.observationIds)]) {
    const response = await getCameraObservationResponse(id);
    if (!response || response.status === 'cancelled' || response.binding.targetSessionId !== input.sessionId) continue;
    if (response.draft && response.draft.messages.some(message => !saved.some(item => item?.id === message.id && item.content === message.content))) continue;
    await runBackupRestoreDataEpochCommit(input.dataEpoch, () => completeCameraObservationResponses([id], [...input.messageIds], current));
  }
}

