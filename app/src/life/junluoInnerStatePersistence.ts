import {
  JUNLUO_DESIRE_IDS,
  JUNLUO_INNER_PROCESSED_OPERATION_LIMIT,
  JUNLUO_INNER_STATE_KEYS,
  type JunluoAffectStateV1,
  type JunluoAffectStateLegacyV1,
  type JunluoDesireDimension,
  type JunluoDesireState,
  type JunluoInnerOperationRef,
  type JunluoInnerThoughtLegacyV1,
  type JunluoInnerThoughtV2,
  type JunluoThoughtStateV1,
  type JunluoThoughtStateV2,
  type RelationshipPhase,
  isJunluoAffectStateV1,
  isJunluoAffectStateLegacyV1,
  isJunluoDesireState,
  isJunluoThoughtStateV1,
  isJunluoThoughtStateV2,
} from './junluoInnerState';

const TERMINAL_THOUGHT_STATES = new Set(['resolved', 'released']);

function compareOperation(
  left: JunluoInnerOperationRef | null,
  right: JunluoInnerOperationRef | null,
) {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  return left.occurredAt - right.occurredAt
    || left.operationId.localeCompare(right.operationId);
}

function latestOperation(
  values: readonly (JunluoInnerOperationRef | null)[],
) {
  return values.reduce<JunluoInnerOperationRef | null>(
    (latest, value) => compareOperation(latest, value) >= 0 ? latest : value,
    null,
  );
}

function selectByOperation<T>(
  left: T,
  right: T,
  operation: (value: T) => JunluoInnerOperationRef | null,
  updatedAt: (value: T) => number,
) {
  const comparison = compareOperation(operation(left), operation(right));
  if (comparison !== 0) return comparison > 0 ? left : right;
  const updatedComparison = updatedAt(left) - updatedAt(right);
  if (updatedComparison !== 0) return updatedComparison > 0 ? left : right;
  return JSON.stringify(left).localeCompare(JSON.stringify(right)) >= 0 ? left : right;
}

export function mergeJunluoProcessedOperations(
  left: readonly JunluoInnerOperationRef[],
  right: readonly JunluoInnerOperationRef[],
) {
  const byId = new Map<string, JunluoInnerOperationRef>();
  for (const operation of [...left, ...right]) {
    const existing = byId.get(operation.operationId);
    if (!existing || compareOperation(existing, operation) < 0) {
      byId.set(operation.operationId, operation);
    }
  }
  return [...byId.values()]
    .sort(compareOperation)
    .slice(-JUNLUO_INNER_PROCESSED_OPERATION_LIMIT);
}

const JUNLUO_DESIRE_BASELINES = {
  miss_you: 0.56,
  be_chosen: 0.48,
  care_for_you: 0.52,
  speak_to_you: 0.46,
  explore_world: 0.50,
  own_time: 0.44,
  affection_with_you: 0.50,
  desire_you: 0.34,
  rest: 0.30,
  remind_you: 0,
} as const satisfies Record<typeof JUNLUO_DESIRE_IDS[number], number>;

export function getJunluoDesireBaseline(id: typeof JUNLUO_DESIRE_IDS[number]) {
  return JUNLUO_DESIRE_BASELINES[id];
}

function emptyDesireDimension(id: typeof JUNLUO_DESIRE_IDS[number]): JunluoDesireDimension {
  return {
    currentValue: JUNLUO_DESIRE_BASELINES[id],
    lastSubjectiveSatisfaction: null,
    lastValueChange: null,
    updatedAt: 0,
  };
}

export function createDefaultJunluoDesireState(now = 0): JunluoDesireState {
  return {
    activatedAt: now,
    clock: { settledAt: now, context: null },
    desires: Object.fromEntries(
      JUNLUO_DESIRE_IDS.map((id) => [id, {
        ...emptyDesireDimension(id),
        updatedAt: now,
      }]),
    ) as JunluoDesireState['desires'],
    recentProcessedOperations: [],
    schemaVersion: 4,
    updatedAt: now,
  };
}

export function upgradeJunluoDesireState(
  value: unknown,
): JunluoDesireState | null {
  if (isJunluoDesireState(value)) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const legacy = value as Record<string, unknown>;
  if (legacy.schemaVersion === 3) {
    const candidate = { ...legacy, schemaVersion: 4 };
    if (!isJunluoDesireState(candidate)
      || JUNLUO_DESIRE_IDS.some(id => candidate.desires[id].currentValue < 0)) return null;
    // Keep the saved values, not a retrospective application of the new signed clock.
    return { ...candidate, clock: { ...candidate.clock, context: null } };
  }
  if (legacy.schemaVersion !== 1 && legacy.schemaVersion !== 2) return null;
  const keys = ['desires', 'recentProcessedOperations', 'schemaVersion', 'updatedAt'];
  if (legacy.schemaVersion === 2) keys.push('activatedAt');
  if (Object.keys(legacy).sort().join() !== keys.sort().join()) return null;
  if (!legacy.desires || typeof legacy.desires !== 'object' || Array.isArray(legacy.desires)) return null;
  if (Object.keys(legacy.desires).sort().join() !== [...JUNLUO_DESIRE_IDS].sort().join()) return null;
  const desires: Record<string, unknown> = {};
  for (const id of JUNLUO_DESIRE_IDS) {
    const old = (legacy.desires as Record<string, unknown>)[id];
    if (!old || typeof old !== 'object' || Array.isArray(old)) return null;
    const dimension = old as Record<string, unknown>;
    if (typeof dimension.currentValue !== 'number' || !Number.isFinite(dimension.currentValue)
      || dimension.currentValue < 0 || dimension.currentValue > 1) return null;
    if (Object.keys(dimension).sort().join() !== [
      'currentValue', 'lastFocus', 'lastRealReceipt', 'lastSubjectiveSatisfaction',
      'lastValueChange', 'updatedAt',
    ].sort().join()) return null;
    const satisfaction = validSavedOperation(dimension.lastSubjectiveSatisfaction, dimension.updatedAt);
    // Old execution/focus records remain business history elsewhere; they are not subjective changes.
    const lastChange = validSavedOperation(dimension.lastValueChange, dimension.updatedAt);
    const oldFocus = validSavedOperation(dimension.lastFocus, dimension.updatedAt);
    const oldReceipt = validSavedOperation(dimension.lastRealReceipt, dimension.updatedAt);
    desires[id] = {
      currentValue: dimension.currentValue,
      lastSubjectiveSatisfaction: satisfaction,
      lastValueChange: lastChange && (
        lastChange.operationId !== oldFocus?.operationId
        && lastChange.operationId !== oldReceipt?.operationId
      ) ? lastChange : satisfaction,
      updatedAt: dimension.updatedAt,
    };
  }
  const upgraded = {
    activatedAt: legacy.schemaVersion === 2 ? legacy.activatedAt : legacy.updatedAt,
    clock: { settledAt: legacy.updatedAt, context: null },
    desires,
    recentProcessedOperations: legacy.recentProcessedOperations,
    schemaVersion: 4,
    updatedAt: legacy.updatedAt,
  };
  return isJunluoDesireState(upgraded) ? upgraded : null;
}

function validSavedOperation(value: unknown, updatedAt: unknown): JunluoInnerOperationRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const operation = value as Record<string, unknown>;
  return Object.keys(operation).sort().join() === 'occurredAt,operationId'
    && Number.isSafeInteger(operation.occurredAt) && Number(operation.occurredAt) >= 0
    && Number(operation.occurredAt) <= Number(updatedAt)
    && typeof operation.operationId === 'string'
    && operation.operationId.length > 0 && operation.operationId.length <= 256
    ? { occurredAt: Number(operation.occurredAt), operationId: operation.operationId }
    : null;
}

export function createDefaultJunluoAffectState(): JunluoAffectStateV1 {
  return {
    emotions: { primary: null, secondary: [] },
    emotionsLastOperation: null,
    lifeState: null,
    lifeStateLastOperation: null,
    recentProcessedOperations: [],
    relationshipChoice: {
      lastOperation: null,
      sourceId: null,
      updatedAt: 0,
      value: 0.75,
    },
    relationshipChoiceEvidence: [],
    relationshipChoiceRetractions: [],
    relationshipFeeling: {
      lastOperation: null,
      sourceId: null,
      updatedAt: 0,
      value: 0.45,
    },
    relationshipPhase: {
      activatedAt: 0,
      enteredAt: 0,
      lastOperation: null,
      phase: 'together',
    },
    schemaVersion: 2,
    strain: {
      lastOperation: null,
      sourceId: null,
      updatedAt: 0,
      value: 0.2,
    },
    updatedAt: 0,
  };
}

export function upgradeJunluoAffectState(
  value: unknown,
): JunluoAffectStateV1 | null {
  if (isJunluoAffectStateV1(value)) return value;
  if (!isJunluoAffectStateLegacyV1(value)) return null;
  const activatedAt = value.updatedAt;
  return {
    ...value,
    relationshipPhase: {
      activatedAt,
      enteredAt: activatedAt,
      lastOperation: null,
      phase: 'together',
    },
    schemaVersion: 2,
  };
}

export function createDefaultJunluoThoughtState(): JunluoThoughtStateV2 {
  return {
    recentProcessedOperations: [],
    schemaVersion: 2,
    thoughts: [],
    updatedAt: 0,
  };
}

function upgradeJunluoThought(
  thought: JunluoInnerThoughtLegacyV1,
): JunluoInnerThoughtV2 {
  if ('attemptCount' in thought) return thought as JunluoInnerThoughtV2;
  return {
    ...thought,
    attemptCount: 0,
    lastAttempt: null,
    lastChosenAt: null,
    lastOutcome: null,
    missedReviewCount: 0,
    nextReviewAt: null,
    reviewStage: 0,
  };
}

export function upgradeJunluoThoughtState(
  value: unknown,
): JunluoThoughtStateV2 | null {
  if (isJunluoThoughtStateV2(value)) return value;
  if (!isJunluoThoughtStateV1(value) || value.schemaVersion !== 1) return null;
  return {
    recentProcessedOperations: value.recentProcessedOperations,
    schemaVersion: 2,
    thoughts: value.thoughts.map(upgradeJunluoThought),
    updatedAt: value.updatedAt,
  };
}

export function mergeJunluoDesireStates(
  left: JunluoDesireState,
  right: JunluoDesireState,
): JunluoDesireState {
  if (!isJunluoDesireState(left) || !isJunluoDesireState(right)) {
    throw new Error('十维欲望同步只接受当前严格合同。');
  }
  // The phone owns one numeric clock. Keep its values and settled interval together.
  // A pre-repair future timestamp is not newer evidence. Do not reimport its future
  // receipt ordering either: the repaired snapshot already retained its known identities.
  if (Boolean(left.clock.correction) !== Boolean(right.clock.correction)) {
    return left.clock.correction ? left : right;
  }
  const winner = left.updatedAt !== right.updatedAt
    ? left.updatedAt > right.updatedAt ? left : right
    : selectByOperation(left, right,
      (state) => latestOperation(state.recentProcessedOperations),
      (state) => state.clock.settledAt);
  return {
    ...winner,
    recentProcessedOperations: mergeJunluoProcessedOperations(
      left.recentProcessedOperations,
      right.recentProcessedOperations,
    ),
  };
}

function mergeById<T>(
  left: readonly T[],
  right: readonly T[],
  id: (value: T) => string,
  operation: (value: T) => JunluoInnerOperationRef,
) {
  const byId = new Map<string, T>();
  for (const value of [...left, ...right]) {
    const key = id(value);
    const existing = byId.get(key);
    if (!existing || compareOperation(operation(existing), operation(value)) < 0) {
      byId.set(key, value);
    }
  }
  return [...byId.values()].sort((a, b) => id(a).localeCompare(id(b)));
}

const DAY_MS = 24 * 60 * 60 * 1000;

function localDateKey(timestamp: number) {
  const date = new Date(timestamp);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function activeRelationshipEvidence(state: JunluoAffectStateV1) {
  const retracted = new Set(
    state.relationshipChoiceRetractions.map((entry) => entry.targetEvidenceId),
  );
  return state.relationshipChoiceEvidence
    .filter((entry) => !retracted.has(entry.evidenceId))
    .sort((left, right) => left.occurredAt - right.occurredAt
      || left.operationId.localeCompare(right.operationId));
}

export function reconcileJunluoRelationshipPhase(
  input: JunluoAffectStateV1,
): JunluoAffectStateV1 {
  const evidence = activeRelationshipEvidence(input).filter(
    (entry) => entry.occurredAt >= input.relationshipPhase.activatedAt,
  );
  const phaseOperation = input.relationshipPhase.lastOperation;
  const phaseTriggerStillExists = phaseOperation === null
    ? input.relationshipPhase.phase === 'together'
    : evidence.some((entry) => (
        `${entry.operationId}:phase:${input.relationshipPhase.phase}`
        === phaseOperation.operationId
      ));
  const hasLaterRetraction = phaseOperation !== null
    && input.relationshipChoiceRetractions.some(
      (entry) => entry.occurredAt >= phaseOperation.occurredAt,
    );
  const resumeCurrentPhase = phaseOperation !== null
    && phaseTriggerStillExists
    && !hasLaterRetraction;
  let phase: RelationshipPhase = resumeCurrentPhase
    ? input.relationshipPhase.phase
    : 'together';
  let enteredAt = resumeCurrentPhase
    ? input.relationshipPhase.enteredAt
    : input.relationshipPhase.activatedAt;
  let lastOperation: JunluoInnerOperationRef | null = resumeCurrentPhase
    ? phaseOperation
    : null;
  let exitWindow: typeof evidence = resumeCurrentPhase && phase === 'taking_space'
    ? evidence.filter((entry) => (
        entry.movement === 'consider_leaving'
        && entry.occurredAt === enteredAt
      ))
    : [];
  let rebuildingClosers: typeof evidence = [];
  const pendingEvidence = resumeCurrentPhase
    ? evidence.filter((entry) => entry.occurredAt > enteredAt)
    : evidence;

  const transition = (
    next: RelationshipPhase,
    entry: typeof evidence[number],
  ) => {
    phase = next;
    enteredAt = entry.occurredAt;
    lastOperation = {
      occurredAt: entry.occurredAt,
      operationId: `${entry.operationId}:phase:${next}`,
    };
  };

  for (const entry of pendingEvidence) {
    if (entry.movement === 'closer') exitWindow = [];
    else if (entry.movement === 'consider_leaving') exitWindow = [...exitWindow, entry];

    if (phase === 'together') {
      if (entry.movement === 'farther' || entry.movement === 'consider_leaving') {
        transition('taking_space', entry);
      }
      continue;
    }

    if (phase === 'taking_space') {
      if (entry.movement === 'closer') {
        transition('together', entry);
        continue;
      }
      const firstLeaving = exitWindow[0];
      if (
        input.relationshipChoice.value <= 0.20
        && firstLeaving
        && new Set(exitWindow.map((item) => item.localDate)).size >= 3
        && entry.occurredAt - firstLeaving.occurredAt >= 2 * DAY_MS
      ) {
        transition('considering_exit', entry);
      }
      continue;
    }

    if (phase === 'considering_exit') {
      if (entry.movement === 'closer') {
        transition('together', entry);
        continue;
      }
      if (
        entry.movement === 'consider_leaving'
        && input.relationshipChoice.value <= 0.15
        && entry.localDate !== localDateKey(enteredAt)
        && entry.occurredAt - enteredAt >= DAY_MS
      ) {
        rebuildingClosers = [];
        transition('ended', entry);
      }
      continue;
    }

    if (phase === 'ended') {
      if (entry.movement !== 'closer') continue;
      rebuildingClosers = [...rebuildingClosers, entry];
      if (
        input.relationshipChoice.value >= 0.30
        && new Set(rebuildingClosers.map((item) => item.localDate)).size >= 3
      ) {
        transition('rebuilding', entry);
      }
      continue;
    }

    if (entry.movement === 'farther' || entry.movement === 'consider_leaving') {
      rebuildingClosers = [];
      transition('ended', entry);
      continue;
    }
    if (
      entry.movement === 'closer'
      && input.relationshipChoice.value >= 0.55
      && entry.localDate !== localDateKey(enteredAt)
    ) {
      transition('together', entry);
    }
  }

  return {
    ...input,
    relationshipPhase: {
      activatedAt: input.relationshipPhase.activatedAt,
      enteredAt,
      lastOperation,
      phase,
    },
  };
}

export function mergeJunluoAffectStates(
  left: JunluoAffectStateV1,
  right: JunluoAffectStateV1,
): JunluoAffectStateV1 {
  const emotionSource = compareOperation(
    left.emotionsLastOperation,
    right.emotionsLastOperation,
  ) >= 0 ? left : right;
  const lifeStateSource = compareOperation(
    left.lifeStateLastOperation,
    right.lifeStateLastOperation,
  ) >= 0 ? left : right;
  const relationshipChoiceEvidence = mergeById(
    left.relationshipChoiceEvidence,
    right.relationshipChoiceEvidence,
    (value) => value.evidenceId,
    (value) => ({ occurredAt: value.occurredAt, operationId: value.operationId }),
  );
  const relationshipChoiceRetractions = mergeById(
    left.relationshipChoiceRetractions,
    right.relationshipChoiceRetractions,
    (value) => value.operationId,
    (value) => ({ occurredAt: value.occurredAt, operationId: value.operationId }),
  ).filter((entry) => relationshipChoiceEvidence.some(
    (evidence) => evidence.evidenceId === entry.targetEvidenceId,
  ));
  const phaseSource = compareOperation(
    left.relationshipPhase.lastOperation,
    right.relationshipPhase.lastOperation,
  ) >= 0 ? left : right;
  const phaseSourceEvidenceIds = new Set(
    phaseSource.relationshipChoiceEvidence.map((entry) => entry.evidenceId),
  );
  const mergedActivatedAt = Math.max(
    left.relationshipPhase.activatedAt,
    right.relationshipPhase.activatedAt,
  );
  const mustRebuildPhaseFromEvidence = relationshipChoiceEvidence.some(
    (entry) => !phaseSourceEvidenceIds.has(entry.evidenceId)
      && entry.occurredAt <= phaseSource.relationshipPhase.enteredAt,
  );
  const merged = {
    emotions: emotionSource.emotions,
    emotionsLastOperation: emotionSource.emotionsLastOperation,
    lifeState: lifeStateSource.lifeState,
    lifeStateLastOperation: lifeStateSource.lifeStateLastOperation,
    recentProcessedOperations: mergeJunluoProcessedOperations(
      left.recentProcessedOperations,
      right.recentProcessedOperations,
    ),
    relationshipChoice: selectByOperation(
      left.relationshipChoice,
      right.relationshipChoice,
      (value) => value.lastOperation,
      (value) => value.updatedAt,
    ),
    relationshipChoiceEvidence,
    relationshipChoiceRetractions,
    relationshipFeeling: selectByOperation(
      left.relationshipFeeling,
      right.relationshipFeeling,
      (value) => value.lastOperation,
      (value) => value.updatedAt,
    ),
    relationshipPhase: {
      ...(mustRebuildPhaseFromEvidence
        ? {
            enteredAt: mergedActivatedAt,
            lastOperation: null,
            phase: 'together' as const,
          }
        : phaseSource.relationshipPhase),
      activatedAt: mergedActivatedAt,
    },
    schemaVersion: 2,
    strain: selectByOperation(
      left.strain,
      right.strain,
      (value) => value.lastOperation,
      (value) => value.updatedAt,
    ),
    updatedAt: Math.max(left.updatedAt, right.updatedAt),
  } satisfies JunluoAffectStateV1;
  return reconcileJunluoRelationshipPhase(merged);
}

function thoughtSource(value: JunluoInnerThoughtV2) {
  return `${value.sourceKind}\u0000${value.sourceId}`;
}

function mergeThought(
  left: JunluoInnerThoughtV2,
  right: JunluoInnerThoughtV2,
) {
  if (
    thoughtSource(left) !== thoughtSource(right)
    || left.desireId !== right.desireId
    || left.createdAt !== right.createdAt
    || left.content !== right.content
  ) {
    throw new Error(`念头 ${left.thoughtId} 的不可变来源发生冲突。`);
  }
  const leftTerminal = TERMINAL_THOUGHT_STATES.has(left.state);
  const rightTerminal = TERMINAL_THOUGHT_STATES.has(right.state);
  if (leftTerminal !== rightTerminal) return leftTerminal ? left : right;
  return selectByOperation(
    left,
    right,
    (value) => value.lastTransition,
    (value) => value.updatedAt,
  );
}

function normalizeMergedThoughts(
  thoughts: readonly JunluoInnerThoughtV2[],
  now: number,
  retainedThoughtIds: ReadonlySet<string> = new Set(),
) {
  const hour = 60 * 60 * 1000;
  const fresh = thoughts.filter(
    (entry) => entry.state !== 'flit' || now - entry.updatedAt <= 72 * hour,
  );
  const keepFlits = new Set(
    fresh
      .filter((entry) => entry.state === 'flit')
      .sort((a, b) => b.createdAt - a.createdAt || b.thoughtId.localeCompare(a.thoughtId))
      .slice(0, 12)
      .map((entry) => entry.thoughtId),
  );
  let next = thoughts.flatMap((entry) => {
    if (entry.state !== 'flit' || keepFlits.has(entry.thoughtId)) return [entry];
    return retainedThoughtIds.has(entry.thoughtId) ? [{ ...entry, state: 'dormant' as const,
      nextReviewAt: null, updatedAt: now,
      lastTransition: { occurredAt: now, operationId: `merge:thought-retained:${entry.thoughtId}:${now}` } }] : [];
  });
  next = next.map((entry) => {
    if (entry.state !== 'fixation') return entry;
    if (now - (entry.lastChosenAt ?? entry.updatedAt) < 14 * 24 * hour) return entry;
    const lastTransition = {
      occurredAt: now,
      operationId: `merge:thought-stale:${entry.thoughtId}:${now}`,
    };
    return {
      ...entry,
      lastTransition,
      nextReviewAt: null,
      state: 'dormant' as const,
      updatedAt: now,
    };
  });
  const keepFixations = new Set(
    next
      .filter((entry) => entry.state === 'fixation')
      .sort((a, b) => (
        (b.lastChosenAt ?? b.updatedAt) - (a.lastChosenAt ?? a.updatedAt)
        || b.thoughtId.localeCompare(a.thoughtId)
      ))
      .slice(0, 3)
      .map((entry) => entry.thoughtId),
  );
  next = next.map((entry) => {
    if (entry.state !== 'fixation' || keepFixations.has(entry.thoughtId)) return entry;
    const lastTransition = {
      occurredAt: now,
      operationId: `merge:thought-cap:${entry.thoughtId}:${now}`,
    };
    return {
      ...entry,
      lastTransition,
      nextReviewAt: null,
      state: 'dormant' as const,
      updatedAt: now,
    };
  });
  const keepDormant = new Set(
    next.filter((entry) => entry.state === 'dormant' && !retainedThoughtIds.has(entry.thoughtId))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.thoughtId.localeCompare(a.thoughtId))
      .slice(0, 24)
      .map((entry) => entry.thoughtId),
  );
  const keepTerminal = new Set(
    next.filter((entry) => TERMINAL_THOUGHT_STATES.has(entry.state) && !retainedThoughtIds.has(entry.thoughtId))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.thoughtId.localeCompare(a.thoughtId))
      .slice(0, 24)
      .map((entry) => entry.thoughtId),
  );
  return next.filter((entry) => (
    retainedThoughtIds.has(entry.thoughtId) || (entry.state === 'dormant' ? keepDormant.has(entry.thoughtId)
      : TERMINAL_THOUGHT_STATES.has(entry.state) ? keepTerminal.has(entry.thoughtId)
        : true)
  ));
}

/** Keep only explicitly referenced missing originals; incoming same-ID state remains authoritative. */
export function retainMissingJunluoThoughtOriginals(
  current: unknown, incoming: unknown, retainedThoughtIds: ReadonlySet<string>,
): JunluoThoughtStateV2 {
  const previous = upgradeJunluoThoughtState(current);
  const next = upgradeJunluoThoughtState(incoming);
  if (!previous || !next) throw new Error('念头状态无法升级到 V2。');
  const incomingIds = new Set(next.thoughts.map(entry => entry.thoughtId));
  const now = Math.max(previous.updatedAt, next.updatedAt);
  const missing = previous.thoughts.filter(entry => retainedThoughtIds.has(entry.thoughtId) && !incomingIds.has(entry.thoughtId))
    .map(entry => TERMINAL_THOUGHT_STATES.has(entry.state) || entry.state === 'dormant' ? entry : {
      ...entry, state: 'dormant' as const, nextReviewAt: null, updatedAt: now,
      lastTransition: { occurredAt: now, operationId: `sync:thought-original:${entry.thoughtId}:${now}` },
    });
  if (!missing.length) return next;
  return { ...next, thoughts: [...next.thoughts, ...missing] };
}

export function mergeJunluoThoughtStates(
  left: JunluoThoughtStateV1,
  right: JunluoThoughtStateV1,
  retainedThoughtIds?: ReadonlySet<string>,
): JunluoThoughtStateV2 {
  const upgradedLeft = upgradeJunluoThoughtState(left);
  const upgradedRight = upgradeJunluoThoughtState(right);
  if (!upgradedLeft || !upgradedRight) {
    throw new Error('念头状态无法升级到 V2。');
  }
  const byThoughtId = new Map<string, JunluoInnerThoughtV2>();
  for (const thought of [...upgradedLeft.thoughts, ...upgradedRight.thoughts]) {
    const existing = byThoughtId.get(thought.thoughtId);
    byThoughtId.set(
      thought.thoughtId,
      existing ? mergeThought(existing, thought) : thought,
    );
  }
  const bySource = new Map<string, JunluoInnerThoughtV2>();
  for (const thought of byThoughtId.values()) {
    const source = thoughtSource(thought);
    const existing = bySource.get(source);
    if (existing && existing.thoughtId !== thought.thoughtId) {
      throw new Error(`念头来源 ${source} 对应了多个 thoughtId。`);
    }
    bySource.set(source, thought);
  }
  const updatedAt = Math.max(upgradedLeft.updatedAt, upgradedRight.updatedAt);
  return {
    recentProcessedOperations: mergeJunluoProcessedOperations(
      upgradedLeft.recentProcessedOperations,
      upgradedRight.recentProcessedOperations,
    ),
    schemaVersion: 2,
    thoughts: normalizeMergedThoughts([...byThoughtId.values()], updatedAt, retainedThoughtIds).sort(
      (a, b) => a.createdAt - b.createdAt || a.thoughtId.localeCompare(b.thoughtId),
    ),
    updatedAt,
  };
}

export function prepareJunluoInnerStateRestoreStorage(
  currentStorage: Readonly<Record<string, string>>,
  restoredStorage: Readonly<Record<string, string>>,
) {
  const next = { ...restoredStorage };
  const restoredDesireRaw = next[JUNLUO_INNER_STATE_KEYS.desire];
  if (restoredDesireRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(restoredDesireRaw);
    } catch {
      throw new Error(`备份中的 ${JUNLUO_INNER_STATE_KEYS.desire} 不是有效 JSON。`);
    }
    const upgraded = upgradeJunluoDesireState(parsed);
    if (!upgraded) {
      throw new Error(`备份中的 ${JUNLUO_INNER_STATE_KEYS.desire} 不符合可升级的十维严格合同。`);
    }
    next[JUNLUO_INNER_STATE_KEYS.desire] = JSON.stringify(upgraded);
  }
  const restoredAffectRaw = next[JUNLUO_INNER_STATE_KEYS.affect];
  if (restoredAffectRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(restoredAffectRaw);
    } catch {
      throw new Error(`备份中的 ${JUNLUO_INNER_STATE_KEYS.affect} 不是有效 JSON。`);
    }
    const upgraded = upgradeJunluoAffectState(parsed);
    if (!upgraded) {
      throw new Error(`备份中的 ${JUNLUO_INNER_STATE_KEYS.affect} 不符合 V1／V2 严格合同。`);
    }
    next[JUNLUO_INNER_STATE_KEYS.affect] = JSON.stringify(upgraded);
  }
  const restoredThoughtRaw = next[JUNLUO_INNER_STATE_KEYS.thought];
  if (restoredThoughtRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(restoredThoughtRaw);
    } catch {
      throw new Error(`备份中的 ${JUNLUO_INNER_STATE_KEYS.thought} 不是有效 JSON。`);
    }
    const upgraded = upgradeJunluoThoughtState(parsed);
    if (!upgraded) {
      throw new Error(`备份中的 ${JUNLUO_INNER_STATE_KEYS.thought} 不符合 V1／V2 严格合同。`);
    }
    next[JUNLUO_INNER_STATE_KEYS.thought] = JSON.stringify(upgraded);
  }
  return next;
}
