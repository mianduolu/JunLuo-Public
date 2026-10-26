import {
  JUNLUO_DESIRE_IDS,
  type JunluoDesireId,
  type JunluoDesireState,
  type JunluoDesireTimeContext,
  type JunluoWantChange,
} from './junluoInnerState';
import {
  getJunluoDesireBaseline,
  mergeJunluoProcessedOperations,
} from './junluoInnerStatePersistence';

const HOUR_MS = 60 * 60 * 1000;
const SATISFACTION_PAUSE_MS = {
  affection_with_you: HOUR_MS,
  desire_you: 2 * HOUR_MS,
  explore_world: HOUR_MS / 2,
  own_time: HOUR_MS / 2,
} as const;
export const JUNLUO_DESIRE_VISIBLE_THRESHOLD = 0.08;

export const DESIRE_LINES: Record<JunluoDesireId, string> = {
  miss_you: 'I 想念 you。',
  be_chosen: 'I 想被 you 选择。',
  care_for_you: 'I 想照顾 you。',
  speak_to_you: 'I 有些话想说给 you 听。',
  explore_world: 'I 想看看世界。',
  own_time: 'I 想做自己的事。',
  affection_with_you: 'I 想和 you 贴贴。',
  desire_you: 'I 想要 you。',
  rest: 'I 想安静休息。',
  remind_you: 'I 想提醒 you 一件已经记下来的事。',
};

export const JUNLUO_DESIRE_PROMPT_PAPER_PREFIX = '【I 此刻比较明显的愿望】';
export const JUNLUO_DESIRE_PROMPT_PAPER_SUFFIX = '这些愿望可以自然地流进 I 此刻的想法、生活或表达里。';

export type JunluoDesireStructuralSources = {
  remindYouValue?: number;
  sleepDebt?: number;
  sleepPressure?: number;
};

export type JunluoDesireEffectiveDimension = {
  baseValue: number;
  baseline: number;
  changedAt: number;
  effectiveValue: number;
  id: JunluoDesireId;
  structuralFloor: number | null;
};

export type JunluoDesireEffectiveSnapshot = {
  at: number;
  desires: Record<JunluoDesireId, JunluoDesireEffectiveDimension>;
  restSources: { subjective: number; sleepDebt: number; sleepPressure: number };
  selectedIds: readonly JunluoDesireId[];
};

function clamp(value: number, minimum = -1) {
  return Math.max(minimum, Math.min(1, Number.isFinite(value) ? value : 0));
}

// Only the live phone boundary supplies `now`. This does not undo numeric history.
export function repairJunluoDesireClock(state: JunluoDesireState, now: number): JunluoDesireState {
  if (state.clock.settledAt <= now) return state;
  const correction = state.clock.correction ?? { at: now, from: state.clock.settledAt };
  const desires = Object.fromEntries(JUNLUO_DESIRE_IDS.map(id => {
    const dimension = state.desires[id];
    const satisfaction = dimension.lastSubjectiveSatisfaction;
    // Only an existing receipt for this exact operation can establish a real earlier time.
    // Request start/response times and dates embedded in IDs are not save evidence.
    const reliable = satisfaction && [dimension.lastValueChange, ...state.recentProcessedOperations]
      .find(ref => ref?.operationId === satisfaction.operationId && ref.occurredAt <= now);
    return [id, {
      ...dimension,
      updatedAt: Math.min(dimension.updatedAt, now),
      ...(satisfaction && satisfaction.occurredAt > now ? {
        satisfactionClockAt: dimension.satisfactionClockAt ?? reliable?.occurredAt ?? correction.at,
      } : {}),
    }];
  })) as JunluoDesireState['desires'];
  return {
    ...state,
    activatedAt: Math.min(state.activatedAt, now),
    clock: { ...state.clock, settledAt: now, correction },
    desires,
    // These bounded receipts are deduplication ordering, not satisfaction history.
    // Put old future receipts before new writes, so a full list cannot evict a new operation.
    recentProcessedOperations: state.recentProcessedOperations.map(ref => ref.occurredAt > now
      ? { ...ref, occurredAt: Math.max(0, now - 1) } : ref),
    updatedAt: now,
  };
}

function timeChange(state: JunluoDesireState, id: JunluoDesireId, now: number) {
  const { context, settledAt } = state.clock;
  if (!context?.awake || now <= settledAt) return 0;
  const hours = (now - settledAt) / HOUR_MS;
  const relationshipRate = context.relationshipChoice < 0.15 ? -0.02
    : context.relationshipChoice < 0.30 ? -0.01 : 0;
  const close = context.relationshipChoice >= 0.55;
  if (id === 'be_chosen') return relationshipRate * hours;
  if (id === 'miss_you') {
    if (relationshipRate) return relationshipRate * hours;
    if (!close || state.desires[id].currentValue < 0 || context.lastYouMessageAt === null) return 0;
    return 0.02 * Math.max(0, now - Math.max(
      settledAt, context.lastYouMessageAt + HOUR_MS / 2,
    )) / HOUR_MS;
  }
  if (id === 'affection_with_you' || id === 'desire_you') {
    if (relationshipRate) return relationshipRate * hours;
    if (!close) return 0;
  } else if (id !== 'explore_world' && id !== 'own_time') {
    return 0;
  }
  if (context.busy || state.desires[id].currentValue < 0) return 0;
  const satisfactionAt = state.desires[id].satisfactionClockAt
    ?? state.desires[id].lastSubjectiveSatisfaction?.occurredAt;
  const start = satisfactionAt === undefined ? settledAt
    : Math.max(settledAt, satisfactionAt + SATISFACTION_PAUSE_MS[id]);
  const rate = id === 'affection_with_you' || id === 'own_time' ? 0.02 : 0.01;
  return rate * Math.max(0, now - start) / HOUR_MS;
}

export function settleJunluoDesireTime(input: {
  state: JunluoDesireState;
  now: number;
  nextContext?: JunluoDesireTimeContext;
}): JunluoDesireState {
  const { state, now } = input;
  if (now < state.clock.settledAt) return state;
  const nextContext = input.nextContext ?? state.clock.context;
  if (now === state.clock.settledAt
    && JSON.stringify(nextContext) === JSON.stringify(state.clock.context)) return state;
  const desires = Object.fromEntries(JUNLUO_DESIRE_IDS.map((id) => {
    const current = state.desires[id];
    const currentValue = clamp(current.currentValue + timeChange(state, id, now), id === 'remind_you' ? 0 : -1);
    return [id, currentValue === current.currentValue ? current : {
      ...current, currentValue, updatedAt: now,
    }];
  })) as JunluoDesireState['desires'];
  return {
    ...state,
    activatedAt: state.activatedAt || now,
    clock: { ...state.clock, settledAt: now, context: nextContext },
    desires,
    updatedAt: Math.max(now, state.updatedAt),
  };
}

const WANT_CHANGES: Record<JunluoWantChange['change'], number> = {
  更想一点: 0.05,
  更想一些: 0.15,
  更想很多: 0.25,
  更不愿意一点: 0.05,
  更不愿意一些: 0.15,
  更不愿意很多: 0.25,
  满足一点: 0.05,
  满足一些: 0.15,
  满足很多: 0.25,
};

export function applyJunluoWants(input: {
  state: JunluoDesireState;
  changes: readonly JunluoWantChange[];
  now: number;
  operationId: string;
  allowSleepingSettlement?: boolean;
}): JunluoDesireState {
  if (input.state.recentProcessedOperations.some(
    (entry) => entry.operationId === input.operationId,
  )) return input.state;
  const now = Math.max(input.now, input.state.clock.settledAt);
  const state = settleJunluoDesireTime({ state: input.state, now });
  if (state.clock.context?.awake === false && !input.allowSleepingSettlement) return state;
  const operation = { occurredAt: now, operationId: input.operationId };
  const desires = { ...state.desires };
  const used = new Set<JunluoDesireId>();
  for (const change of input.changes) {
    if (used.size >= 3) break;
    if (used.has(change.id)) continue;
    used.add(change.id);
    const current = desires[change.id];
    const rate = WANT_CHANGES[change.change];
    const satisfaction = change.change.startsWith('满足');
    // At zero or below there is no positive want to satisfy, nor a new quiet period.
    if (satisfaction && current.currentValue <= 0) continue;
    const currentValue = satisfaction ? current.currentValue * (1 - rate)
      : change.change.startsWith('更不愿意') ? current.currentValue - (current.currentValue + 1) * rate
        : current.currentValue + (1 - current.currentValue) * rate;
    desires[change.id] = {
      ...current,
      currentValue: clamp(currentValue),
      lastSubjectiveSatisfaction: satisfaction ? operation : current.lastSubjectiveSatisfaction,
      lastValueChange: operation,
      updatedAt: now,
    };
    if (satisfaction) delete desires[change.id].satisfactionClockAt;
  }
  return {
    ...state,
    desires,
    recentProcessedOperations: mergeJunluoProcessedOperations(state.recentProcessedOperations, [operation]),
    updatedAt: Math.max(state.updatedAt, now),
  };
}

function selectVisibleDesires(desires: JunluoDesireEffectiveSnapshot['desires']) {
  const order = new Map(JUNLUO_DESIRE_IDS.map((id, index) => [id, index]));
  return JUNLUO_DESIRE_IDS
    .filter((id) => desires[id].effectiveValue > 0
      && desires[id].effectiveValue + 1e-9 >= desires[id].baseline + JUNLUO_DESIRE_VISIBLE_THRESHOLD)
    .sort((left, right) => {
      if (left === 'remind_you') return -1;
      if (right === 'remind_you') return 1;
      const leftExcess = desires[left].effectiveValue - desires[left].baseline;
      const rightExcess = desires[right].effectiveValue - desires[right].baseline;
      return rightExcess - leftExcess
        || desires[right].changedAt - desires[left].changedAt
        || (order.get(left) ?? 0) - (order.get(right) ?? 0);
    })
    .slice(0, 2);
}

export function calculateJunluoDesireSnapshot(input: {
  now: number;
  state: JunluoDesireState;
  structural?: JunluoDesireStructuralSources;
}): JunluoDesireEffectiveSnapshot {
  const state = input.state;
  const structural = input.structural ?? {};
  const restSources = {
    subjective: state.desires.rest.currentValue,
    sleepDebt: clamp(structural.sleepDebt ?? 0, 0),
    sleepPressure: clamp(structural.sleepPressure ?? 0, 0),
  };
  const desires = Object.fromEntries(JUNLUO_DESIRE_IDS.map((id) => {
    const dimension = state.desires[id];
    const structuralFloor = id === 'remind_you' ? clamp(structural.remindYouValue ?? 0, 0) : null;
    return [id, {
      baseValue: dimension.currentValue,
      baseline: getJunluoDesireBaseline(id),
      changedAt: dimension.updatedAt,
      effectiveValue: id === 'remind_you' ? structuralFloor!
        : dimension.currentValue,
      id,
      structuralFloor,
    } satisfies JunluoDesireEffectiveDimension];
  })) as JunluoDesireEffectiveSnapshot['desires'];
  return { at: input.now, desires, restSources, selectedIds: selectVisibleDesires(desires) };
}

export function buildJunluoDesirePromptPaper(snapshot: JunluoDesireEffectiveSnapshot) {
  const selectedIds = snapshot.selectedIds.filter(id => snapshot.desires[id].effectiveValue > 0);
  if (!selectedIds.length) return '';
  return `${JUNLUO_DESIRE_PROMPT_PAPER_PREFIX}\n\n${selectedIds
    .map((id) => DESIRE_LINES[id])
    .join('\n')}\n\n${JUNLUO_DESIRE_PROMPT_PAPER_SUFFIX}`;
}
