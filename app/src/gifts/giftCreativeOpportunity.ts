export type GiftCreativeSource = {
  wantOperationId: string | null;
  thoughtId: string | null;
  thoughtTransitionOperationId: string | null;
};
export type GiftCreativeOpportunity = {
  key: string;
  cycle: number;
  source: GiftCreativeSource;
  status: 'ready' | 'started' | 'none' | 'completed' | 'failed';
  attempt: number;
};
export type GiftCreativeOpportunityState = {
  version: 1;
  visible: boolean;
  cycle: number;
  serial: number;
  current: GiftCreativeOpportunity | null;
};
export type GiftCreativeOpportunityInput = {
  visible: boolean;
  wantOperationId?: string | null;
  thought?: { thoughtId: string; transitionOperationId: string } | null;
};
export type GiftCreativeOpportunityEvent = {
  key: string;
  attempt: number;
  event: 'budget-deferred' | 'started' | 'none' | 'completed' | 'failed' | 'retry';
};

export function createGiftCreativeOpportunityState(): GiftCreativeOpportunityState {
  return { version: 1, visible: false, cycle: 0, serial: 0, current: null };
}
function id(value: string | null | undefined) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw Error('gift-creative-invalid-source');
  return value;
}
function source(input: GiftCreativeOpportunityInput): GiftCreativeSource {
  return { wantOperationId: id(input.wantOperationId), thoughtId: id(input.thought?.thoughtId),
    thoughtTransitionOperationId: id(input.thought?.transitionOperationId) };
}
function assertState(state: GiftCreativeOpportunityState) {
  if (state.version !== 1 || typeof state.visible !== 'boolean'
    || !Number.isSafeInteger(state.cycle) || state.cycle < 0 || !Number.isSafeInteger(state.serial) || state.serial < 0
    || state.current && (!state.current.key || !Number.isSafeInteger(state.current.cycle) || state.current.cycle < 1
      || state.current.cycle > state.cycle || !Number.isSafeInteger(state.current.attempt) || state.current.attempt < 0
      || !['ready', 'started', 'none', 'completed', 'failed'].includes(state.current.status))) throw Error('gift-creative-invalid-state');
}
function hasNewSource(previous: GiftCreativeSource, next: GiftCreativeSource) {
  // Losing an optional source is not a new subjective operation.
  return !!next.wantOperationId && next.wantOperationId !== previous.wantOperationId
    || !!next.thoughtId && (next.thoughtId !== previous.thoughtId
      || next.thoughtTransitionOperationId !== previous.thoughtTransitionOperationId);
}

/** The caller owns the existing visibility threshold; clocks and dates are not identities. */
export function selectGiftCreativeOpportunity(state: GiftCreativeOpportunityState, input: GiftCreativeOpportunityInput): {
  state: GiftCreativeOpportunityState;
  action: 'none' | 'ready' | 'retry-required' | 'reconciliation-required';
  opportunity: GiftCreativeOpportunity | null;
} {
  assertState(state);
  if (typeof input.visible !== 'boolean') throw Error('gift-creative-invalid-source');
  const nextSource = source(input);
  let next = state.visible === input.visible ? state : { ...state, visible: input.visible,
    cycle: state.cycle + Number(input.visible) };
  if (next.current?.status === 'started') return { state: next, action: 'reconciliation-required', opportunity: next.current };
  if (!input.visible) return { state: next, action: 'none', opportunity: next.current };
  if (!next.current || next.current.cycle !== next.cycle || hasNewSource(next.current.source, nextSource)) {
    const serial = next.serial + 1;
    if (!Number.isSafeInteger(serial) || !Number.isSafeInteger(next.cycle)) throw Error('gift-creative-invalid-state');
    next = { ...next, serial, current: { key: `gift-creative:${serial}:${JSON.stringify([next.cycle,
      nextSource.wantOperationId, nextSource.thoughtId, nextSource.thoughtTransitionOperationId])}`,
      cycle: next.cycle, source: nextSource, status: 'ready', attempt: 0 } };
  }
  return { state: next, opportunity: next.current,
    action: next.current!.status === 'ready' ? 'ready' : next.current!.status === 'failed' ? 'retry-required' : 'none' };
}

/** Persist a changed `started` transition by CAS before transport; repeated starts grant no new transport. */
export function transitionGiftCreativeOpportunity(state: GiftCreativeOpportunityState, event: GiftCreativeOpportunityEvent): {
  state: GiftCreativeOpportunityState; changed: boolean;
} {
  assertState(state);
  const current = state.current;
  if (!current || current.key !== event.key || current.attempt !== event.attempt) throw Error('gift-creative-opportunity-stale');
  if (event.event === 'budget-deferred' || current.status === event.event) return { state, changed: false };
  let next: GiftCreativeOpportunity;
  if (event.event === 'retry') {
    if (current.status !== 'failed' || !state.visible) throw Error('gift-creative-opportunity-not-ready');
    const attempt = current.attempt + 1;
    if (!Number.isSafeInteger(attempt)) throw Error('gift-creative-invalid-state');
    next = { ...current, status: 'ready', attempt };
  } else if (event.event === 'started') {
    if (current.status !== 'ready' || !state.visible) throw Error('gift-creative-opportunity-not-ready');
    next = { ...current, status: 'started' };
  } else {
    if (current.status !== 'started' || !['none', 'completed', 'failed'].includes(event.event)) throw Error('gift-creative-opportunity-not-started');
    next = { ...current, status: event.event };
  }
  return { state: { ...state, current: next }, changed: true };
}
