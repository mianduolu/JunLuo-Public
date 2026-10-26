import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import type { JunLuoToolCall } from '../tools/toolTypes';
import { createToolErrorResult, createToolSuccessResult } from '../tools/toolResult';
import { createToolError } from '../tools/toolErrors';
import { contactIsPaused } from './unifiedContact';
import { applyContactPauseUpdate, readContactPause } from './unifiedContactStore';

// Source identity belongs to the live chat host, not tool arguments.
export function createContactManagementTurn(input: {
  sessionId: string;
  message?: Pick<SubjectiveMessage, 'id' | 'role' | 'createdAt'>;
  dataEpoch: number;
  signal?: AbortSignal;
  isCurrent?: () => Promise<boolean>;
}) {
  const current = async () => !!input.sessionId && input.message?.role === 'you'
    && Number.isFinite(input.message.createdAt) && !input.signal?.aborted
    && canCommitBackupRestoreDataEpoch(input.dataEpoch) && !!await input.isCurrent?.()
    && !input.signal?.aborted && canCommitBackupRestoreDataEpoch(input.dataEpoch);
  return async (call: JunLuoToolCall) => {
    const action = call.toolId.slice('proactive_contact.'.length);
    const invalid = () => createToolErrorResult(call, createToolError('INVALID_ARGUMENTS', 'contact-arguments-invalid'));
    if (!['get_status', 'pause', 'resume'].includes(action)) return invalid();
    if (Object.keys(call.input).some(key => action !== 'pause' || key !== 'durationMinutes')) return invalid();
    let until: number | undefined;
    if ('durationMinutes' in call.input) {
      const duration = call.input.durationMinutes;
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return invalid();
      until = (input.message?.createdAt ?? NaN) + duration * 60_000;
      if (!Number.isFinite(until) || !Number.isFinite(new Date(until).getTime())
        || until <= (input.message?.createdAt ?? Infinity)) return invalid();
    }
    try {
      if (call.requestedBy !== 'chat' || call.sourceMessageId !== input.message?.id || !await current()) {
        return createToolErrorResult(call, createToolError('PERMISSION_DENIED', 'contact-turn-stale'));
      }
      if (action !== 'get_status') {
        await applyContactPauseUpdate({ state: action === 'pause' ? '暂停' : '恢复',
          sourceMessageId: input.message!.id, sourceAt: input.message!.createdAt, until, isCurrent: current });
      }
      const pause = await readContactPause();
      const paused = contactIsPaused(pause, Date.now());
      return createToolSuccessResult(call, paused ? '主动联系已暂停' : '主动联系未暂停', {
        paused, until: paused ? pause!.until : null,
      });
    } catch (error) {
      return createToolErrorResult(call, createToolError('EXECUTION_FAILED',
        error instanceof Error && error.message === 'contact-turn-stale' ? error.message : 'contact-state-unavailable'));
    }
  };
}
