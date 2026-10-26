import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { markNotebookEntryInteracted, type NotebookInteractionHandoff } from './notebookStore';
import type { createChatReplyController, ChatReplyPhase } from './chatReplyRuntime';
import { beginChatReplyBackground } from './chatReplyBackground';
import {
  fireChatReplyWait,
  queueChatReplyWait,
  resetChatReplyWait,
  type ChatReplyWaitState,
} from './chatReplyWaitState';

export const REPLY_IDLE_DELAY_MS = 3000;
const SLOW_NETWORK_HINT_DELAY_MS = 10000;

export function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type ChatReplySchedulingRef<T> = { current: T };
const waitingBackground = new WeakMap<object, () => void>();

export function releaseChatReplyWaitBackground(timerRef: object) {
  waitingBackground.get(timerRef)?.();
  waitingBackground.delete(timerRef);
}

export type ChatReplySchedulingOptions = {
  activeSessionRef: ChatReplySchedulingRef<string | null>;
  draftRef: ChatReplySchedulingRef<string>;
  pendingNotebookReplyRef: ChatReplySchedulingRef<{ handoff: NotebookInteractionHandoff; instruction: string } | null>;
  pendingReplyDataEpochRef: ChatReplySchedulingRef<number | null>;
  pendingReplySessionIdRef: ChatReplySchedulingRef<string | null>;
  replySessionIdRef: ChatReplySchedulingRef<string | null>;
  replyTimerRef: ChatReplySchedulingRef<ReturnType<typeof setTimeout> | null>;
  replyWaitStateRef: ChatReplySchedulingRef<ChatReplyWaitState>;
  requestRef: ChatReplySchedulingRef<AbortController | null>;
  sendingRef: ChatReplySchedulingRef<boolean>;
  slowNetworkTimerRef: ChatReplySchedulingRef<ReturnType<typeof setTimeout> | null>;
  waitingModeEnabledRef: ChatReplySchedulingRef<boolean>;
  waitingToReplyRef: ChatReplySchedulingRef<boolean>;
  setReplyPhase: (phase: ChatReplyPhase) => void;
  setReplySessionId: (sessionId: string | null) => void;
  setWaitingToReply: (value: boolean) => void;
  runReply: ReturnType<typeof createChatReplyController>['runReply'];
};

export function createChatReplyScheduling({
  activeSessionRef,
  draftRef,
  pendingNotebookReplyRef,
  pendingReplyDataEpochRef,
  pendingReplySessionIdRef,
  replySessionIdRef,
  replyTimerRef,
  replyWaitStateRef,
  requestRef,
  sendingRef,
  slowNetworkTimerRef,
  waitingModeEnabledRef,
  waitingToReplyRef,
  setReplyPhase,
  setReplySessionId,
  setWaitingToReply,
  runReply,
}: ChatReplySchedulingOptions) {
  const clearSlowNetworkTimer = () => {
    if (slowNetworkTimerRef.current) {
      clearTimeout(slowNetworkTimerRef.current);
      slowNetworkTimerRef.current = null;
    }
  };

  const startSlowNetworkTimer = (controller: AbortController) => {
    clearSlowNetworkTimer();
    slowNetworkTimerRef.current = setTimeout(() => {
      if (requestRef.current === controller && sendingRef.current) {
        setReplyPhase('slowNetwork');
      }
    }, SLOW_NETWORK_HINT_DELAY_MS);
  };

  const cancelPendingReplyWait = () => {
    releaseChatReplyWaitBackground(replyTimerRef);
    if (replyTimerRef.current) clearTimeout(replyTimerRef.current);
    replyTimerRef.current = null;
    replyWaitStateRef.current = resetChatReplyWait(replyWaitStateRef.current);
    pendingReplyDataEpochRef.current = null;
    if (waitingToReplyRef.current) setWaitingToReply(false);
    waitingToReplyRef.current = false;
    if (!sendingRef.current) {
      clearSlowNetworkTimer();
      pendingReplySessionIdRef.current = null;
      replySessionIdRef.current = null;
      setReplySessionId(null);
      setReplyPhase('idle');
    }
  };

  const pausePendingReplyWaitForOutgoingMessage = () => {
    if (!waitingToReplyRef.current) return false;
    releaseChatReplyWaitBackground(replyTimerRef);
    const targetSessionId = pendingReplySessionIdRef.current ?? replySessionIdRef.current ?? activeSessionRef.current;
    if (replyTimerRef.current) clearTimeout(replyTimerRef.current);
    replyTimerRef.current = null;
    replyWaitStateRef.current = queueChatReplyWait(replyWaitStateRef.current, { delayMs: REPLY_IDLE_DELAY_MS, hasDraft: true }).state;
    clearSlowNetworkTimer();
    pendingReplySessionIdRef.current = targetSessionId;
    replySessionIdRef.current = targetSessionId;
    setReplySessionId(targetSessionId);
    setReplyPhase('waitingForUser');
    return true;
  };

  const runReplyWithPendingNotebookInteraction = (dataEpoch = captureBackupRestoreDataEpoch()) => {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    const pendingNotebookReply = pendingNotebookReplyRef.current;
    pendingNotebookReplyRef.current = null;
    void runReply({ dataEpoch, interactionInstruction: pendingNotebookReply?.instruction }).then((replied) => {
      if (replyWaitStateRef.current.phase === 'running') replyWaitStateRef.current = resetChatReplyWait(replyWaitStateRef.current);
      if (replied && pendingNotebookReply) {
        void runBackupRestoreDataEpochCommit(dataEpoch,
          () => markNotebookEntryInteracted(pendingNotebookReply.handoff.entryId)).catch(() => undefined);
      }
    });
  };

  const scheduleReply = (delay = waitingModeEnabledRef.current ? REPLY_IDLE_DELAY_MS : 0, targetSessionId = activeSessionRef.current, dataEpoch = captureBackupRestoreDataEpoch()) => {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) {
      releaseChatReplyWaitBackground(replyTimerRef);
      return;
    }
    if (replyTimerRef.current) clearTimeout(replyTimerRef.current);
    clearSlowNetworkTimer();
    pendingReplySessionIdRef.current = targetSessionId;
    pendingReplyDataEpochRef.current = dataEpoch;
    replySessionIdRef.current = targetSessionId;
    setReplySessionId(targetSessionId);
    const transition = queueChatReplyWait(replyWaitStateRef.current, { delayMs: delay, hasDraft: !!draftRef.current.trim() });
    replyWaitStateRef.current = transition.state;
    if (transition.effect === 'start') {
      replyTimerRef.current = null;
      waitingToReplyRef.current = false;
      setWaitingToReply(false);
      pendingReplyDataEpochRef.current = null;
      runReplyWithPendingNotebookInteraction(dataEpoch);
      releaseChatReplyWaitBackground(replyTimerRef);
      return;
    }
    waitingToReplyRef.current = true;
    setWaitingToReply(true);
    setReplyPhase('waitingForUser');
    if (transition.effect !== 'schedule') {
      releaseChatReplyWaitBackground(replyTimerRef);
      return void (replyTimerRef.current = null);
    }
    const finishPrevious = waitingBackground.get(replyTimerRef);
    waitingBackground.set(replyTimerRef, beginChatReplyBackground());
    finishPrevious?.();
    const draftRevision = transition.state.draftRevision;
    replyTimerRef.current = setTimeout(() => {
      replyTimerRef.current = null;
      const identityMatches = pendingReplySessionIdRef.current === targetSessionId
        && pendingReplyDataEpochRef.current === dataEpoch && activeSessionRef.current === targetSessionId
        && canCommitBackupRestoreDataEpoch(dataEpoch);
      const fired = fireChatReplyWait(replyWaitStateRef.current, { draftRevision, hasDraft: !!draftRef.current.trim(), identityMatches });
      replyWaitStateRef.current = fired.state;
      if (fired.effect !== 'start') {
        releaseChatReplyWaitBackground(replyTimerRef);
        return void setReplyPhase('waitingForUser');
      }
      waitingToReplyRef.current = false;
      setWaitingToReply(false);
      pendingReplyDataEpochRef.current = null;
      runReplyWithPendingNotebookInteraction(dataEpoch);
      releaseChatReplyWaitBackground(replyTimerRef);
    }, delay);
  };

  return {
    clearSlowNetworkTimer,
    startSlowNetworkTimer,
    cancelPendingReplyWait,
    pausePendingReplyWaitForOutgoingMessage,
    scheduleReply,
  };
}
