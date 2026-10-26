import { REPLY_IDLE_DELAY_MS } from '../chat/chatReplyScheduling';
import {
  createChatReplyWaitState,
  fireChatReplyWait,
  queueChatReplyWait,
  reviseChatReplyDraft,
  type ChatReplyWaitState,
} from '../chat/chatReplyWaitState';

type PendingWait = {
  resolve: (ready: boolean) => void;
  state: ChatReplyWaitState;
  enabled?: boolean;
};

// This only batches messages before a request. A running answer is never cancelled.
export function createFocusReplyWait(options: {
  getDraft: () => string;
  loadWaitingMode: () => Promise<boolean>;
}) {
  let pending: PendingWait | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const cancel = () => {
    clearTimer();
    const previous = pending;
    pending = undefined;
    previous?.resolve(false);
  };
  const arm = (wait: PendingWait) => {
    if (pending !== wait || wait.enabled === undefined) return;
    clearTimer();
    const delayMs = wait.enabled ? REPLY_IDLE_DELAY_MS : 0;
    const next = queueChatReplyWait(wait.state, { delayMs, hasDraft: !!options.getDraft().trim() });
    wait.state = next.state;
    const start = () => { pending = undefined; wait.resolve(true); };
    if (next.effect === 'start') return start();
    if (next.effect !== 'schedule') return;
    const draftRevision = wait.state.draftRevision;
    timer = setTimeout(() => {
      timer = undefined;
      const fired = fireChatReplyWait(wait.state, {
        draftRevision, hasDraft: !!options.getDraft().trim(), identityMatches: pending === wait,
      });
      wait.state = fired.state;
      if (fired.effect === 'start') start();
    }, delayMs);
  };
  return {
    wait: () => {
      cancel();
      return new Promise<boolean>((resolve) => {
        const next: PendingWait = { resolve, state: createChatReplyWaitState() };
        pending = next;
        void options.loadWaitingMode().catch(() => true).then((enabled) => {
          next.enabled = enabled;
          arm(next);
        });
      });
    },
    draftChanged: () => {
      if (!pending) return;
      clearTimer();
      pending.state = reviseChatReplyDraft(pending.state, !!options.getDraft().trim()).state;
      arm(pending);
    },
    cancel,
  };
}
