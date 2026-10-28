import {
  type BaiyunEmotionId,
  type BaiyunEmotionTarget,
  type BaiyunLifePortraitStateId,
  type JunluoAffectStateV1,
  type JunluoDesireId,
  type JunluoThoughtStateV1,
  type JunluoThoughtStateV2,
} from './junluoInnerState';
import {
  mergeJunluoProcessedOperations,
  reconcileJunluoRelationshipPhase,
  upgradeJunluoThoughtState,
} from './junluoInnerStatePersistence';
import {
  advanceJunluoThoughtLifecycle,
  applyJunluoThoughtReviewDecision,
} from './junluoThoughtLifecycle';

export type AfterglowCounterIdea = { keyword: string; targetCount: number | null; days: number | null };

type EmotionInput = {
  id: BaiyunEmotionId;
  strength: 'soft' | 'clear' | 'strong';
  target: BaiyunEmotionTarget;
  reason?: string | null;
};

type ExistingInternalUpdates = {
  affect: null | {
    emotions: null | { primary: EmotionInput; secondary: readonly EmotionInput[] };
    lifeState: BaiyunLifePortraitStateId | null;
    relationshipChoice: 'closer' | 'steady' | 'farther' | 'consider_leaving' | null;
    relationshipFeeling: 'warm' | 'mixed' | 'unhappy' | 'averse' | null;
    strain: 'clear' | 'tense' | 'blocked' | null;
  };
  thought: null | {
    decision: null | { choice: 'choose_again' | 'release'; thoughtId: string };
    new: null | { content: string; desireId: Exclude<JunluoDesireId, 'remind_you'> };
  };
};

const STRENGTH_VALUE = { soft: 0.35, clear: 0.65, strong: 0.90 } as const;
const FEELING_TARGET = { warm: 0.75, mixed: 0, unhappy: -0.45, averse: -0.85 } as const;
const STRAIN_TARGET = { clear: 0.15, tense: 0.55, blocked: 0.90 } as const;
const CHOICE_DELTA = { closer: 0.04, steady: 0, farther: -0.04, consider_leaving: -0.08 } as const;
const HOUR_MS = 60 * 60 * 1000;

function clamp(value: number, min = 0, max = 1) { return Math.max(min, Math.min(max, value)); }
function moveToward(value: number, target: number, maxStep: number) {
  return value + Math.max(-maxStep, Math.min(maxStep, target - value));
}
function operation(generationKey: string, basket: string, now: number) {
  return { occurredAt: now, operationId: `${generationKey}:${basket}` };
}
function localDateKey(timestamp: number) {
  const date = new Date(timestamp);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
function limitedRelationshipChoiceDelta(
  state: JunluoAffectStateV1,
  movement: NonNullable<ExistingInternalUpdates['affect']>['relationshipChoice'],
  now: number,
) {
  if (movement === null || movement === 'steady') return 0;
  const intended = CHOICE_DELTA[movement];
  const today = localDateKey(now);
  const used = state.recentProcessedOperations.reduce((sum, entry) => {
    if (localDateKey(entry.occurredAt) !== today) return sum;
    const marker = ':relationship-choice:';
    const index = entry.operationId.lastIndexOf(marker);
    if (index < 0) return sum;
    const previous = entry.operationId.slice(index + marker.length) as keyof typeof CHOICE_DELTA;
    return previous in CHOICE_DELTA ? sum + CHOICE_DELTA[previous] : sum;
  }, 0);
  if (intended > 0) return Math.min(intended, Math.max(0, 0.12 - Math.max(0, used)));
  return Math.max(intended, Math.min(0, -0.08 - Math.min(0, used)));
}
function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16);
}

export function applyJunluoAffectBasket(input: {
  basket: NonNullable<ExistingInternalUpdates['affect']>;
  generationKey: string;
  now: number;
  sleeping: boolean;
  state: JunluoAffectStateV1;
}) {
  const op = operation(input.generationKey, 'affect', input.now);
  if (input.state.recentProcessedOperations.some((entry) => entry.operationId === op.operationId)) return input.state;
  const emotion = (item: EmotionInput, index: number) => ({
    emotionId: item.id,
    intensity: STRENGTH_VALUE[item.strength],
    occurredAt: input.now,
    operationId: `${op.operationId}:emotion:${index}`,
    sourceId: input.generationKey,
    target: item.target,
    ...(item.reason === null || typeof item.reason === 'string' ? { reason: item.reason } : {}),
  });
  const lifeStateId = input.sleeping
    ? 'asleep'
    : input.basket.lifeState === 'asleep'
      ? input.state.lifeState?.stateId === 'asleep' ? 'calm' : null
      : input.basket.lifeState;
  const relationshipFeeling = input.basket.relationshipFeeling === null ? input.state.relationshipFeeling : {
    lastOperation: op,
    sourceId: input.generationKey,
    updatedAt: input.now,
    value: moveToward(input.state.relationshipFeeling.value, FEELING_TARGET[input.basket.relationshipFeeling], 0.12),
  };
  const strain = input.basket.strain === null ? input.state.strain : {
    lastOperation: op,
    sourceId: input.generationKey,
    updatedAt: input.now,
    value: moveToward(input.state.strain.value, STRAIN_TARGET[input.basket.strain], 0.18),
  };
  const choiceMovement = input.basket.relationshipChoice;
  const choiceOperation = choiceMovement === null
    ? null
    : operation(input.generationKey, `relationship-choice:${choiceMovement}`, input.now);
  const choiceDelta = limitedRelationshipChoiceDelta(input.state, choiceMovement, input.now);
  const relationshipChoice = choiceMovement === null ? input.state.relationshipChoice : {
    lastOperation: choiceOperation!,
    sourceId: input.generationKey,
    updatedAt: input.now,
    value: clamp(input.state.relationshipChoice.value + choiceDelta),
  };
  const choiceEvidence = choiceMovement === null || choiceMovement === 'steady'
    ? input.state.relationshipChoiceEvidence
    : input.state.relationshipChoiceEvidence.some(
      (entry) => entry.operationId === choiceOperation?.operationId,
    )
      ? input.state.relationshipChoiceEvidence
      : [...input.state.relationshipChoiceEvidence, {
        evidenceId: `relationship-choice-${hash(choiceOperation!.operationId)}`,
        localDate: localDateKey(input.now),
        movement: choiceMovement,
        occurredAt: input.now,
        operationId: choiceOperation!.operationId,
      }];
  const next = {
    ...input.state,
    emotions: input.basket.emotions === null ? input.state.emotions : {
      primary: emotion(input.basket.emotions.primary, 0),
      secondary: input.basket.emotions.secondary.map((item, index) => emotion(item, index + 1)),
    },
    emotionsLastOperation: input.basket.emotions === null ? input.state.emotionsLastOperation : op,
    lifeState: lifeStateId === null ? input.state.lifeState : {
      occurredAt: input.now,
      operationId: `${op.operationId}:life`,
      sourceId: input.generationKey,
      stateId: lifeStateId,
    },
    lifeStateLastOperation: lifeStateId === null ? input.state.lifeStateLastOperation : op,
    recentProcessedOperations: mergeJunluoProcessedOperations(
      input.state.recentProcessedOperations,
      choiceOperation ? [op, choiceOperation] : [op],
    ),
    relationshipChoice,
    relationshipChoiceEvidence: choiceEvidence,
    relationshipFeeling,
    strain,
    updatedAt: input.now,
  } satisfies JunluoAffectStateV1;
  return reconcileJunluoRelationshipPhase(next);
}

export function retractJunluoRelationshipChoiceEvidence(input: {
  evidenceId: string;
  now: number;
  operationId: string;
  state: JunluoAffectStateV1;
}) {
  if (!input.state.relationshipChoiceEvidence.some(
    (entry) => entry.evidenceId === input.evidenceId,
  )) return input.state;
  if (input.state.relationshipChoiceRetractions.some(
    (entry) => entry.operationId === input.operationId
      || entry.targetEvidenceId === input.evidenceId,
  )) return input.state;
  const op = { occurredAt: input.now, operationId: input.operationId };
  return reconcileJunluoRelationshipPhase({
    ...input.state,
    recentProcessedOperations: mergeJunluoProcessedOperations(
      input.state.recentProcessedOperations,
      [op],
    ),
    relationshipChoiceRetractions: [
      ...input.state.relationshipChoiceRetractions,
      {
        occurredAt: input.now,
        operationId: input.operationId,
        targetEvidenceId: input.evidenceId,
      },
    ],
    updatedAt: Math.max(input.state.updatedAt, input.now),
  });
}

export function applyJunluoThoughtBasket(input: {
  basket: NonNullable<ExistingInternalUpdates['thought']>;
  generationKey: string;
  now: number;
  reviewThoughtId?: string | null;
  state: JunluoThoughtStateV1;
  retainedThoughtIds?: ReadonlySet<string>;
}): JunluoThoughtStateV2 {
  const upgraded = upgradeJunluoThoughtState(input.state);
  if (!upgraded) throw new Error('念头状态无法升级到 V2。');
  const op = operation(input.generationKey, 'thought', input.now);
  let next = upgraded;
  if (!next.recentProcessedOperations.some((entry) => entry.operationId === op.operationId)) {
    let thoughts = next.thoughts;
    if (input.basket.new) {
    const thoughtId = `thought-current-state-${hash(input.generationKey)}`;
    if (!thoughts.some((entry) => entry.thoughtId === thoughtId)) {
      thoughts = [...thoughts, {
        attemptCount: 0,
        content: input.basket.new.content,
        createdAt: input.now,
        desireId: input.basket.new.desireId,
        lastAttempt: null,
        lastChosenAt: null,
        lastOutcome: null,
        lastTransition: op,
        missedReviewCount: 0,
        nextReviewAt: null,
        reviewStage: 0 as const,
        sourceId: input.generationKey,
        sourceKind: 'current_state' as const,
        state: 'flit' as const,
        thoughtId,
        updatedAt: input.now,
      }];
    }
  }
    next = {
      ...next,
      recentProcessedOperations: mergeJunluoProcessedOperations(next.recentProcessedOperations, [op]),
      thoughts,
      updatedAt: Math.max(next.updatedAt, input.now),
    };
  }
  if (input.reviewThoughtId) {
    next = applyJunluoThoughtReviewDecision({
      retainedThoughtIds: input.retainedThoughtIds,
      decision: input.basket.decision,
      now: input.now,
      operationId: `${input.generationKey}:thought-review`,
      reviewThoughtId: input.reviewThoughtId,
      state: next,
    });
  }
  return advanceJunluoThoughtLifecycle({
    retainedThoughtIds: input.retainedThoughtIds,
    now: input.now,
    operationId: `${input.generationKey}:thought-lifecycle`,
    state: next,
  });
}

export type StructuredReminderCandidate = {
  dueAt: number;
  id: string;
  intensity: 'gentle' | 'low' | 'ordinary' | 'strong' | 'normal' | 'music' | 'blast' | 'high';
};

export const JUNLUO_REMINDER_LOOKBACK_MS = 24 * HOUR_MS;

export function calculateRemindYouValue(candidates: readonly StructuredReminderCandidate[], now: number) {
  const base = { gentle: 0.35, low: 0.35, ordinary: 0.35, strong: 0.60, normal: 0.60, music: 0.60, blast: 0.80, high: 0.80 } as const;
  return candidates.reduce((highest, candidate) => {
    if (!Number.isFinite(candidate.dueAt) || candidate.dueAt < now - JUNLUO_REMINDER_LOOKBACK_MS) return highest;
    if (candidate.dueAt <= now) return 1;
    const remaining = candidate.dueAt - now;
    if (remaining > 6 * HOUR_MS) return highest;
    return Math.max(highest, Math.min(1, base[candidate.intensity] + (1 - remaining / (6 * HOUR_MS)) * 0.20));
  }, 0);
}

export function resolveBaiyunPortraitState(input: {
  affect: JunluoAffectStateV1;
  sleeping: boolean;
}) {
  if (input.sleeping) return 'asleep' as const;
  if (input.affect.lifeState?.stateId === 'sleepy') return 'sleepy' as const;
  if (input.affect.lifeState?.stateId === 'tired') return 'tired' as const;
  return input.affect.emotions.primary?.emotionId ?? 'calm';
}
