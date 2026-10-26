import { readNativePhoneCareFollowUp, writeNativePhoneCareFollowUp } from '../backend/phoneActivityNative';
import type { PhoneCareFollowUp } from './phoneCareFollowUp';

export const readPhoneCareFollowUp = readNativePhoneCareFollowUp;

export async function changePhoneCareFollowUp(task: PhoneCareFollowUp, patch: Partial<PhoneCareFollowUp>) {
  const next = { ...task, ...patch, revision: task.revision + 1 };
  if (!await writeNativePhoneCareFollowUp(task.revision, next)) return null;
  return next;
}

export async function stopPhoneCareFollowUp(reason: string, sessionId?: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const task = await readPhoneCareFollowUp();
    if (!task || task.status === 'finished' || (sessionId && task.sessionId !== sessionId)) return;
    if (await changePhoneCareFollowUp(task, {
      status: 'finished', finishedReason: reason, preparedMessage: undefined,
    })) return;
  }
}

// Called inside the existing chat write queue, after saving the source text.
// Only message references are kept; there is no second copy of the conversation.
export async function observePhoneCareChatChanges(
  sessionId: string,
  changes: readonly { id: string; role: string }[],
  removedIds: readonly string[],
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const task = await readPhoneCareFollowUp();
    if (!task || task.status === 'finished' || task.sessionId !== sessionId) return;
    const sourceChanged = changes.some((m) => m.id === task.lastIMessageId)
      || removedIds.includes(task.lastIMessageId)
      || (!!task.lastYouMessageId && removedIds.includes(task.lastYouMessageId));
    const you = changes.filter((m) => m.role === 'you').at(-1);
    if (!sourceChanged && !you) return;
    if (await changePhoneCareFollowUp(task, {
      status: 'finished',
      finishedReason: sourceChanged ? 'input_changed' : 'you_replied',
      preparedMessage: undefined,
      nextCheckAt: 0,
    })) return;
  }
}
