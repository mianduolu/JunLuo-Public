import {
  runFocusTimerExecutionOnce,
  type FocusTimerExecutionIdentity,
  type FocusTimerExecutionOncePorts,
} from './focusTimerExecutionOnceCore';

export function executeFocusTimerCompletionOnce(
  identity: FocusTimerExecutionIdentity,
  callbacks: FocusTimerExecutionOncePorts,
) {
  return runFocusTimerExecutionOnce(identity, callbacks);
}
