import {
  type InnerThoughtSourceKind,
  type JunluoInnerOperationRef,
  type JunluoInnerThoughtV2,
  type JunluoReceiptSourceKind,
  type JunluoThoughtAttemptOutcome,
  type JunluoThoughtStateV1,
  type JunluoThoughtStateV2,
} from './junluoInnerState';
import {
  mergeJunluoProcessedOperations,
  upgradeJunluoThoughtState,
} from './junluoInnerStatePersistence';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FLIT_TTL_MS = 72 * HOUR_MS;
const FIXATION_TTL_MS = 14 * DAY_MS;
const REVIEW_DELAYS_MS = [6 * HOUR_MS, 24 * HOUR_MS, 72 * HOUR_MS] as const;

export type JunluoThoughtReviewChoice = 'choose_again' | 'release';
export type JunluoThoughtReviewDecision = {
  choice: JunluoThoughtReviewChoice;
  thoughtId: string;
};

function operation(operationId: string, occurredAt: number): JunluoInnerOperationRef {
  return { occurredAt, operationId };
}

function hasOperation(state: JunluoThoughtStateV2, operationId: string) {
  return state.recentProcessedOperations.some((entry) => entry.operationId === operationId);
}

function withOperation(
  state: JunluoThoughtStateV2,
  op: JunluoInnerOperationRef,
  thoughts: readonly JunluoInnerThoughtV2[],
) {
  return {
    ...state,
    recentProcessedOperations: mergeJunluoProcessedOperations(
      state.recentProcessedOperations,
      [op],
    ),
    thoughts,
    updatedAt: Math.max(state.updatedAt, op.occurredAt),
  } satisfies JunluoThoughtStateV2;
}

function dormant(
  thought: JunluoInnerThoughtV2,
  op: JunluoInnerOperationRef,
) {
  return {
    ...thought,
    lastTransition: op,
    nextReviewAt: null,
    state: 'dormant' as const,
    updatedAt: op.occurredAt,
  };
}

function pruneThoughts(
  thoughts: readonly JunluoInnerThoughtV2[],
  now: number,
  operationId: string,
  retainedThoughtIds: ReadonlySet<string> = new Set(),
) {
  const fresh = thoughts.filter(
    (entry) => entry.state !== 'flit' || now - entry.updatedAt <= FLIT_TTL_MS,
  );
  const flits = fresh
    .filter((entry) => entry.state === 'flit')
    .sort((left, right) => right.createdAt - left.createdAt || right.thoughtId.localeCompare(left.thoughtId))
    .slice(0, 12);
  const keptFlits = new Set(flits.map((entry) => entry.thoughtId));
  let next = thoughts.flatMap((entry) => {
    if (entry.state !== 'flit' || keptFlits.has(entry.thoughtId)) return [entry];
    return retainedThoughtIds.has(entry.thoughtId)
      ? [dormant(entry, operation(`${operationId}:retained:${entry.thoughtId}`, now))] : [];
  });

  next = next.map((entry) => {
    if (entry.state !== 'fixation') return entry;
    const lastChosenAt = entry.lastChosenAt ?? entry.updatedAt;
    if (now - lastChosenAt < FIXATION_TTL_MS) return entry;
    return dormant(entry, operation(`${operationId}:stale:${entry.thoughtId}`, now));
  });

  const fixations = next
    .filter((entry) => entry.state === 'fixation')
    .sort((left, right) => (
      (right.lastChosenAt ?? right.updatedAt) - (left.lastChosenAt ?? left.updatedAt)
      || right.thoughtId.localeCompare(left.thoughtId)
    ));
  const keptFixations = new Set(fixations.slice(0, 3).map((entry) => entry.thoughtId));
  next = next.map((entry) => (
    entry.state === 'fixation' && !keptFixations.has(entry.thoughtId)
      ? dormant(entry, operation(`${operationId}:cap:${entry.thoughtId}`, now))
      : entry
  ));

  const keepLatest = (state: 'dormant' | 'resolved' | 'released', limit: number) => new Set(
    next
      .filter((entry) => entry.state === state && !retainedThoughtIds.has(entry.thoughtId))
      .sort((left, right) => right.updatedAt - left.updatedAt || right.thoughtId.localeCompare(left.thoughtId))
      .slice(0, limit)
      .map((entry) => entry.thoughtId),
  );
  const keptDormant = keepLatest('dormant', 24);
  const keptTerminal = new Set(
    next
      .filter((entry) => (entry.state === 'resolved' || entry.state === 'released') && !retainedThoughtIds.has(entry.thoughtId))
      .sort((left, right) => right.updatedAt - left.updatedAt || right.thoughtId.localeCompare(left.thoughtId))
      .slice(0, 24)
      .map((entry) => entry.thoughtId),
  );
  return next.filter((entry) => (
    retainedThoughtIds.has(entry.thoughtId) || (entry.state === 'dormant' ? keptDormant.has(entry.thoughtId)
      : entry.state === 'resolved' || entry.state === 'released' ? keptTerminal.has(entry.thoughtId)
          : true)
  ));
}

function requireV2(state: JunluoThoughtStateV1) {
  const upgraded = upgradeJunluoThoughtState(state);
  if (!upgraded) throw new Error('念头状态无法升级到 V2。');
  return upgraded;
}

export function advanceJunluoThoughtLifecycle(input: {
  now: number;
  operationId: string;
  state: JunluoThoughtStateV1;
  retainedThoughtIds?: ReadonlySet<string>;
}) {
  const state = requireV2(input.state);
  if (hasOperation(state, input.operationId)) return state;
  const thoughts = pruneThoughts(state.thoughts, input.now, input.operationId, input.retainedThoughtIds);
  if (thoughts.length === state.thoughts.length
    && thoughts.every((entry, index) => entry === state.thoughts[index])) return state;
  return withOperation(state, operation(input.operationId, input.now), thoughts);
}

export function recordJunluoThoughtAttempt(input: {
  occurredAt: number;
  operationId: string;
  outcome: JunluoThoughtAttemptOutcome;
  sourceId: string;
  sourceKind: JunluoReceiptSourceKind;
  state: JunluoThoughtStateV1;
  thoughtId: string;
  retainedThoughtIds?: ReadonlySet<string>;
}) {
  const state = requireV2(input.state);
  if (hasOperation(state, input.operationId)) return state;
  const index = state.thoughts.findIndex((entry) => entry.thoughtId === input.thoughtId);
  if (index < 0) return state;
  const current = state.thoughts[index];
  if (current.state === 'resolved' || current.state === 'released') return state;
  const op = operation(input.operationId, input.occurredAt);
  const lastAttempt = {
    ...op,
    outcome: input.outcome,
    sourceId: input.sourceId,
    sourceKind: input.sourceKind,
  };
  const next: JunluoInnerThoughtV2 = input.outcome === 'success'
    ? {
        ...current,
        attemptCount: current.attemptCount + 1,
        lastAttempt,
        lastOutcome: null,
        lastTransition: op,
        missedReviewCount: 0,
        nextReviewAt: null,
        reviewStage: 0,
        state: 'resolved',
        updatedAt: input.occurredAt,
      }
    : {
        ...current,
        attemptCount: current.attemptCount + 1,
        lastAttempt,
        lastOutcome: input.outcome,
        lastTransition: op,
        missedReviewCount: 0,
        nextReviewAt: input.occurredAt + REVIEW_DELAYS_MS[0],
        reviewStage: 0,
        state: 'unfulfilled_candidate',
        updatedAt: input.occurredAt,
      };
  const thoughts = [...state.thoughts];
  thoughts[index] = next;
  return withOperation(state, op, pruneThoughts(thoughts, input.occurredAt, input.operationId, input.retainedThoughtIds));
}

export function selectDueJunluoThoughtReview(
  stateInput: JunluoThoughtStateV1,
  now: number,
) {
  const state = requireV2(stateInput);
  return state.thoughts
    .filter((entry) => (
      entry.state === 'unfulfilled_candidate'
      && entry.nextReviewAt !== null
      && entry.nextReviewAt <= now
    ))
    .sort((left, right) => (
      Number(left.nextReviewAt) - Number(right.nextReviewAt)
      || left.createdAt - right.createdAt
      || left.thoughtId.localeCompare(right.thoughtId)
    ))[0] ?? null;
}

export function applyJunluoThoughtReviewDecision(input: {
  decision: JunluoThoughtReviewDecision | null;
  now: number;
  operationId: string;
  reviewThoughtId: string;
  state: JunluoThoughtStateV1;
  retainedThoughtIds?: ReadonlySet<string>;
}) {
  const state = requireV2(input.state);
  if (hasOperation(state, input.operationId)) return state;
  const index = state.thoughts.findIndex((entry) => entry.thoughtId === input.reviewThoughtId);
  if (index < 0) return state;
  const current = state.thoughts[index];
  if (
    current.state !== 'unfulfilled_candidate'
    || current.nextReviewAt === null
    || current.nextReviewAt > input.now
  ) return state;
  const op = operation(input.operationId, input.now);
  const exactDecision = input.decision?.thoughtId === input.reviewThoughtId
    ? input.decision.choice
    : null;
  let next: JunluoInnerThoughtV2;
  if (exactDecision === 'choose_again') {
    next = {
      ...current,
      lastChosenAt: input.now,
      lastTransition: op,
      missedReviewCount: 0,
      nextReviewAt: null,
      reviewStage: 0,
      state: 'fixation',
      updatedAt: input.now,
    };
  } else if (exactDecision === 'release') {
    next = {
      ...current,
      lastTransition: op,
      missedReviewCount: 0,
      nextReviewAt: null,
      reviewStage: 0,
      state: 'released',
      updatedAt: input.now,
    };
  } else {
    const missedReviewCount = Math.min(3, current.missedReviewCount + 1);
    next = missedReviewCount >= 3
      ? dormant({ ...current, missedReviewCount }, op)
      : {
          ...current,
          lastTransition: op,
          missedReviewCount,
          nextReviewAt: input.now + REVIEW_DELAYS_MS[missedReviewCount],
          reviewStage: missedReviewCount as 1 | 2,
          updatedAt: input.now,
        };
  }
  const thoughts = [...state.thoughts];
  thoughts[index] = next;
  return withOperation(state, op, pruneThoughts(thoughts, input.now, input.operationId, input.retainedThoughtIds));
}

export function reselectJunluoThoughtSource(input: {
  now: number;
  operationId: string;
  sourceId: string;
  sourceKind: InnerThoughtSourceKind;
  state: JunluoThoughtStateV1;
  retainedThoughtIds?: ReadonlySet<string>;
}) {
  const state = requireV2(input.state);
  if (hasOperation(state, input.operationId)) return state;
  const index = state.thoughts.findIndex((entry) => (
    entry.sourceId === input.sourceId && entry.sourceKind === input.sourceKind
  ));
  if (index < 0 || state.thoughts[index].state !== 'dormant') return state;
  const op = operation(input.operationId, input.now);
  const thoughts = [...state.thoughts];
  thoughts[index] = {
    ...thoughts[index],
    lastChosenAt: input.now,
    lastTransition: op,
    missedReviewCount: 0,
    nextReviewAt: null,
    reviewStage: 0,
    state: 'fixation',
    updatedAt: input.now,
  };
  return withOperation(state, op, pruneThoughts(thoughts, input.now, input.operationId, input.retainedThoughtIds));
}
