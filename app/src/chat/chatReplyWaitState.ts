export type ChatReplyWaitPhase = 'idle' | 'scheduled' | 'pausedByDraft' | 'running';

export type ChatReplyWaitState = {
  draftRevision: number;
  phase: ChatReplyWaitPhase;
};

export type ChatReplyWaitEffect = 'none' | 'cancel' | 'schedule' | 'start';

export type ChatReplyWaitTransition = {
  effect: ChatReplyWaitEffect;
  state: ChatReplyWaitState;
};

export function createChatReplyWaitState(): ChatReplyWaitState {
  return { draftRevision: 0, phase: 'idle' };
}

export function queueChatReplyWait(
  state: ChatReplyWaitState,
  input: { delayMs: number; hasDraft: boolean },
): ChatReplyWaitTransition {
  if (input.hasDraft) {
    return { effect: 'cancel', state: { ...state, phase: 'pausedByDraft' } };
  }
  if (input.delayMs <= 0) {
    return { effect: 'start', state: { ...state, phase: 'running' } };
  }
  return { effect: 'schedule', state: { ...state, phase: 'scheduled' } };
}

export function reviseChatReplyDraft(
  state: ChatReplyWaitState,
  hasDraft: boolean,
): ChatReplyWaitTransition {
  const next = { ...state, draftRevision: state.draftRevision + 1 };
  if (state.phase === 'scheduled') {
    return hasDraft
      ? { effect: 'cancel', state: { ...next, phase: 'pausedByDraft' } }
      : { effect: 'schedule', state: next };
  }
  if (state.phase === 'pausedByDraft') {
    return hasDraft
      ? { effect: 'none', state: next }
      : { effect: 'schedule', state: { ...next, phase: 'scheduled' } };
  }
  if (state.phase === 'running' && hasDraft) {
    return { effect: 'cancel', state: { ...next, phase: 'pausedByDraft' } };
  }
  return { effect: 'none', state: next };
}

export function fireChatReplyWait(
  state: ChatReplyWaitState,
  input: { draftRevision: number; hasDraft: boolean; identityMatches: boolean },
): ChatReplyWaitTransition {
  if (
    state.phase !== 'scheduled'
    || state.draftRevision !== input.draftRevision
    || !input.identityMatches
  ) {
    return { effect: 'none', state };
  }
  if (input.hasDraft) {
    return { effect: 'none', state: { ...state, phase: 'pausedByDraft' } };
  }
  return { effect: 'start', state: { ...state, phase: 'running' } };
}

export function resetChatReplyWait(state: ChatReplyWaitState): ChatReplyWaitState {
  return { ...state, phase: 'idle' };
}
