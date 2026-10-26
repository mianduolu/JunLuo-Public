import type { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import type { PreparedJunluoFocusChatTurn } from './focusChatProtocol';
import { makeFocusSessionId } from './focusIdentity';
import type { ActiveFocusSession, FocusLogEntry } from './focusStore';
import type { FocusMemoryReceipt } from './focusMemoryRuntime';

type Log = Omit<FocusLogEntry, 'sessionId'>;
type Epoch = ReturnType<typeof captureBackupRestoreDataEpoch>;

export const FOCUS_CHAT_SAVE_FAILURE_TEXT = '回复已生成，保存未完成。';

// Only the unsaved answer is page-local. Its successful log IDs retain the retry association.
export type FocusChatDelivery = {
  source: Pick<ActiveFocusSession, 'startedAt' | 'mode' | 'userActivity'>;
  epoch: Epoch;
  failure: Log;
  logs: Log[];
  prepared: PreparedJunluoFocusChatTurn | null;
  rawEnvelope: string;
  memoryUsage?: FocusMemoryReceipt;
  canCommit?: () => boolean;
  beforeSave?: () => Promise<boolean>;
};

export function focusChatReplyLogId(failureId: string, index: number) {
  return `${failureId}:chat-reply:${index}`;
}

export function isFocusChatFailure(log: Log) {
  return log.role === 'system'
    && (log.trigger === 'focus-chat-failed' || log.trigger === 'focus-chat-save-failed');
}

export function isFocusChatFailureResolved(log: Log, logs: readonly Log[]) {
  return isFocusChatFailure(log) && logs.some(answer => answer.id === focusChatReplyLogId(log.id, 0)
    && answer.role === 'I' && answer.trigger === 'chat-reply' && answer.content.trim().length > 0);
}

export function focusGenerationReplyLogId(failureId: string, index: number) {
  return `${failureId}:generation-reply:${index}`;
}

export function isFocusGenerationFailureResolved(log: Log, logs: readonly Log[]) {
  if (isFocusChatFailureResolved(log, logs)) return true;
  const purpose = log.trigger === 'focus-opening-failed' ? 'opening'
    : log.trigger === 'focus-generation-failed' ? 'timed-log' : null;
  return log.role === 'system' && purpose !== null && logs.some(answer =>
    answer.id === focusGenerationReplyLogId(log.id, 0) && answer.role === 'I'
    && answer.trigger === purpose && answer.content.trim().length > 0);
}

export async function persistFocusChatDelivery(delivery: FocusChatDelivery, deps: {
  current: () => boolean;
  read: () => Promise<ActiveFocusSession | null>;
  save: (session: ActiveFocusSession) => Promise<unknown>;
  elapsed: () => number;
}): Promise<Log[] | null> {
  if (!deps.current()) return null;
  const sessionId = makeFocusSessionId(delivery.source);
  const before = await deps.read();
  if (!before || makeFocusSessionId(before) !== sessionId || !deps.current()) return null;
  const logs = [...before.logs, ...delivery.logs.filter(log => !before.logs.some(old => old.id === log.id))];
  try {
    await deps.save({ ...before, elapsedSeconds: deps.elapsed(), logs });
  } catch (error) {
    // Auxiliary hooks can fail after the raw journal has already been written.
    console.warn('[focus] chat reply save needs readback', error);
  }
  const actual = await deps.read();
  if (!actual || makeFocusSessionId(actual) !== sessionId || !deps.current()
    || delivery.beforeSave && !await delivery.beforeSave()
    || delivery.logs.some(log => !actual.logs.some(saved => saved.id === log.id
      && saved.role === log.role && saved.trigger === log.trigger && saved.content === log.content
      && saved.createdAt === log.createdAt && saved.elapsedSeconds === log.elapsedSeconds))) return null;
  return actual.logs;
}
