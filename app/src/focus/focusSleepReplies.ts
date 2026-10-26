import { loadAssistantState } from '../ai/assistantState';
import type { ActiveFocusSession, FocusLogEntry } from './focusStore';

type RuntimeFocusLog = Omit<FocusLogEntry, 'sessionId'>;
const SLEEP_MESSAGE_TRIGGER = 'sleeping-you-message';

// Consume the same actual life state as chat; do not predict sleep from the clock.
export async function isFocusSleeping() {
  return (await loadAssistantState()).lifeMode === 'sleeping';
}

export function focusYouMessageTrigger(sleeping: boolean) {
  return sleeping ? SLEEP_MESSAGE_TRIGGER : 'user-chat';
}

export function isFocusSleepMessage(log: RuntimeFocusLog) {
  return log.role === 'you' && log.trigger === SLEEP_MESSAGE_TRIGGER;
}

// The permanent source marker is saved with the raw message, not in a second queue.
// E1's successful reply association is a separate 5.2 step; I records never settle it.
export function selectFocusSleepMessages(active: Pick<ActiveFocusSession, 'logs'> | null) {
  return active?.logs.filter(isFocusSleepMessage) ?? [];
}
