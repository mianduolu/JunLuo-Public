export const JUNLUO_INNER_STATE_KEYS = Object.freeze({
  desire: 'junluo.inner.desireState.v1',
  affect: 'junluo.inner.affectState.v1',
  thought: 'junluo.inner.thoughtState.v1',
} as const);

export const JUNLUO_INNER_STATE_SYNC_SPECS = Object.freeze({
  desire: Object.freeze({
    adapterId: 'assistant.life-state',
    entityType: 'inner-state',
    entityId: 'desire',
    kind: 'inner-desire-state',
  }),
  affect: Object.freeze({
    adapterId: 'assistant.life-state',
    entityType: 'inner-state',
    entityId: 'affect',
    kind: 'inner-affect-state',
  }),
  thought: Object.freeze({
    adapterId: 'assistant.life-state',
    entityType: 'inner-state',
    entityId: 'thoughts',
    kind: 'inner-thought-state',
  }),
} as const);

export const JUNLUO_DESIRE_IDS = [
  'miss_you',
  'be_chosen',
  'care_for_you',
  'speak_to_you',
  'explore_world',
  'own_time',
  'affection_with_you',
  'desire_you',
  'rest',
  'remind_you',
] as const;

export type JunluoDesireId = typeof JUNLUO_DESIRE_IDS[number];

export const JUNLUO_DESIRE_LABELS: Record<JunluoDesireId, string> = {
  miss_you: '想念 you',
  be_chosen: '想被 you 选择',
  care_for_you: '想照顾 you',
  speak_to_you: '想说给 you 听',
  explore_world: '想看看世界',
  own_time: '想做自己的事',
  affection_with_you: '想和 you 贴贴',
  desire_you: '想要 you',
  rest: '想安静休息',
  remind_you: '想提醒 you',
};

export type JunluoInnerOperationRef = {
  occurredAt: number;
  operationId: string;
};

export const JUNLUO_INNER_PROCESSED_OPERATION_LIMIT = 64;

export type JunluoWantChange = {
  id: Exclude<JunluoDesireId, 'remind_you'>;
  change: '更想一点' | '更想一些' | '更想很多'
    | '更不愿意一点' | '更不愿意一些' | '更不愿意很多'
    | '满足一点' | '满足一些' | '满足很多';
};

export type JunluoDesireTimeContext = {
  awake: boolean;
  busy: boolean;
  relationshipChoice: number;
  lastYouMessageAt: number | null;
};

export type JunluoDesireDimension = {
  currentValue: number;
  lastSubjectiveSatisfaction: JunluoInnerOperationRef | null;
  lastValueChange: JunluoInnerOperationRef | null;
  updatedAt: number;
  // Effective pause anchor after clock repair; the original receipt remains untouched.
  satisfactionClockAt?: number;
};

export type JunluoDesireState = {
  activatedAt: number;
  clock: {
    settledAt: number;
    context: JunluoDesireTimeContext | null;
    correction?: { at: number; from: number };
  };
  desires: Record<JunluoDesireId, JunluoDesireDimension>;
  recentProcessedOperations: readonly JunluoInnerOperationRef[];
  schemaVersion: 4;
  updatedAt: number;
};

export const BAIYUN_EMOTION_IDS = [
  'calm',
  'happy',
  'affectionate',
  'longing',
  'expectant',
  'relieved',
  'proud',
  'shy',
  'sad',
  'hurt',
  'disappointed',
  'lonely',
  'afraid',
  'anxious',
  'angry',
  'jealous',
  'guilty',
  'frustrated',
  'confused',
  'surprised',
  'pained',
] as const;

export type BaiyunEmotionId = typeof BAIYUN_EMOTION_IDS[number];

export const BAIYUN_LIFE_PORTRAIT_STATE_IDS = [
  'calm',
  'tired',
  'sleepy',
  'asleep',
] as const;

export type BaiyunLifePortraitStateId = typeof BAIYUN_LIFE_PORTRAIT_STATE_IDS[number];
export type BaiyunPortraitStateId = BaiyunEmotionId | BaiyunLifePortraitStateId;
export type BaiyunEmotionTarget = 'I' | 'you' | 'other' | 'situation';

export type JunluoEmotionComponentV1 = {
  emotionId: BaiyunEmotionId;
  intensity: number;
  occurredAt: number;
  operationId: string;
  sourceId: string;
  target: BaiyunEmotionTarget;
  reason?: string | null;
};

export type JunluoEmotionSnapshotV1 = {
  primary: JunluoEmotionComponentV1 | null;
  secondary: readonly JunluoEmotionComponentV1[];
};

export type JunluoLifePortraitStateV1 = {
  occurredAt: number;
  operationId: string;
  sourceId: string;
  stateId: BaiyunLifePortraitStateId;
};

export type JunluoInnerScalarV1 = {
  lastOperation: JunluoInnerOperationRef | null;
  sourceId: string | null;
  updatedAt: number;
  value: number;
};

export const RELATIONSHIP_CHOICE_MOVEMENTS = [
  'closer',
  'steady',
  'farther',
  'consider_leaving',
] as const;

export type RelationshipChoiceMovement = typeof RELATIONSHIP_CHOICE_MOVEMENTS[number];

export type JunluoRelationshipChoiceEvidenceV1 = {
  evidenceId: string;
  localDate: string;
  movement: RelationshipChoiceMovement;
  occurredAt: number;
  operationId: string;
};

export type JunluoRelationshipChoiceRetractionV1 = {
  occurredAt: number;
  operationId: string;
  targetEvidenceId: string;
};

export const RELATIONSHIP_PHASES = [
  'together',
  'taking_space',
  'considering_exit',
  'ended',
  'rebuilding',
] as const;

export type RelationshipPhase = typeof RELATIONSHIP_PHASES[number];

export type JunluoRelationshipPhaseV2 = {
  activatedAt: number;
  enteredAt: number;
  lastOperation: JunluoInnerOperationRef | null;
  phase: RelationshipPhase;
};

export type JunluoAffectStateLegacyV1 = {
  emotions: JunluoEmotionSnapshotV1;
  emotionsLastOperation: JunluoInnerOperationRef | null;
  lifeState: JunluoLifePortraitStateV1 | null;
  lifeStateLastOperation: JunluoInnerOperationRef | null;
  recentProcessedOperations: readonly JunluoInnerOperationRef[];
  relationshipChoice: JunluoInnerScalarV1;
  relationshipChoiceEvidence: readonly JunluoRelationshipChoiceEvidenceV1[];
  relationshipChoiceRetractions: readonly JunluoRelationshipChoiceRetractionV1[];
  relationshipFeeling: JunluoInnerScalarV1;
  schemaVersion: 1;
  strain: JunluoInnerScalarV1;
  updatedAt: number;
};

export type JunluoAffectStateV2 = Omit<JunluoAffectStateLegacyV1, 'schemaVersion'> & {
  relationshipPhase: JunluoRelationshipPhaseV2;
  schemaVersion: 2;
};

// 保留旧工程名，避免第五章换轨期间让无关消费者一起改名；运行值已经是 V2。
export type JunluoAffectStateV1 = JunluoAffectStateV2;

export const INNER_THOUGHT_STATES = [
  'flit',
  'unfulfilled_candidate',
  'fixation',
  'dormant',
  'resolved',
  'released',
] as const;

export type InnerThoughtState = typeof INNER_THOUGHT_STATES[number];

export const INNER_THOUGHT_SOURCE_KINDS = [
  'current_state',
  'dream',
  'life_action',
  'proactive_message',
  'share',
  'action_plan',
  'tool_execution',
  'device_execution',
] as const;

export type InnerThoughtSourceKind = typeof INNER_THOUGHT_SOURCE_KINDS[number];

export type JunluoInnerThoughtLegacyV1 = {
  content: string;
  createdAt: number;
  desireId: JunluoDesireId;
  sourceId: string;
  sourceKind: InnerThoughtSourceKind;
  state: InnerThoughtState;
  thoughtId: string;
  lastTransition: JunluoInnerOperationRef;
  updatedAt: number;
};

export type JunluoThoughtStateLegacyV1 = {
  recentProcessedOperations: readonly JunluoInnerOperationRef[];
  schemaVersion: 1;
  thoughts: readonly JunluoInnerThoughtLegacyV1[];
  updatedAt: number;
};

export const JUNLUO_THOUGHT_ATTEMPT_OUTCOMES = [
  'success',
  'failed',
  'blocked',
  'incomplete',
] as const;

export type JunluoThoughtAttemptOutcome = typeof JUNLUO_THOUGHT_ATTEMPT_OUTCOMES[number];
export type JunluoThoughtUnfinishedOutcome = Exclude<JunluoThoughtAttemptOutcome, 'success'>;

export const JUNLUO_RECEIPT_SOURCE_KINDS = [
  'baiyun_post',
  'chat_turn',
  'chat_action',
  'share_response',
  'web_voyage',
  'github_voyage',
  'social_exploration',
  'life_action',
  'sleep_episode',
  'reminder',
  'inner_state',
  'dream',
  'proactive_message',
  'tool_execution',
  'device_execution',
  'focus',
  'letter',
] as const;

export type JunluoReceiptSourceKind = typeof JUNLUO_RECEIPT_SOURCE_KINDS[number];

export type JunluoThoughtAttemptV2 = JunluoInnerOperationRef & {
  outcome: JunluoThoughtAttemptOutcome;
  sourceId: string;
  sourceKind: JunluoReceiptSourceKind;
};

export type JunluoInnerThoughtV2 = JunluoInnerThoughtLegacyV1 & {
  attemptCount: number;
  lastAttempt: JunluoThoughtAttemptV2 | null;
  lastChosenAt: number | null;
  lastOutcome: JunluoThoughtUnfinishedOutcome | null;
  missedReviewCount: number;
  nextReviewAt: number | null;
  reviewStage: 0 | 1 | 2;
};

export type JunluoThoughtStateV2 = {
  recentProcessedOperations: readonly JunluoInnerOperationRef[];
  schemaVersion: 2;
  thoughts: readonly JunluoInnerThoughtV2[];
  updatedAt: number;
};

// 保留旧工程名，避免第七章换轨期间让消费者一起改名；读取端兼容 V1，运行值升级为 V2。
export type JunluoInnerThoughtV1 = JunluoInnerThoughtLegacyV1 | JunluoInnerThoughtV2;
export type JunluoThoughtStateV1 = JunluoThoughtStateLegacyV1 | JunluoThoughtStateV2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isId(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isTimestamp(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isUnit(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isSignedUnit(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= 1;
}

function isOneOf<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value as T[number]);
}

function isOperationRef(value: unknown): value is JunluoInnerOperationRef {
  return isRecord(value)
    && hasExactKeys(value, ['occurredAt', 'operationId'])
    && isTimestamp(value.occurredAt)
    && isId(value.operationId);
}

function isOperationRefList(value: unknown): value is readonly JunluoInnerOperationRef[] {
  if (!Array.isArray(value) || value.length > JUNLUO_INNER_PROCESSED_OPERATION_LIMIT) return false;
  if (!value.every(isOperationRef)) return false;
  return new Set(value.map((entry) => entry.operationId)).size === value.length;
}

function isDesireDimension(value: unknown): value is JunluoDesireDimension {
  return isRecord(value)
    && hasExactKeys(value, [
      'currentValue',
      'lastSubjectiveSatisfaction',
      'lastValueChange',
      'updatedAt',
      ...('satisfactionClockAt' in value ? ['satisfactionClockAt'] : []),
    ])
    && isSignedUnit(value.currentValue)
    && (value.lastSubjectiveSatisfaction === null || isOperationRef(value.lastSubjectiveSatisfaction))
    && (value.lastValueChange === null || isOperationRef(value.lastValueChange))
    && isTimestamp(value.updatedAt)
    && (!('satisfactionClockAt' in value) || (isTimestamp(value.satisfactionClockAt)
      && value.lastSubjectiveSatisfaction !== null));
}

export function isJunluoDesireTimeContext(value: unknown): value is JunluoDesireTimeContext {
  return isRecord(value)
    && hasExactKeys(value, ['awake', 'busy', 'relationshipChoice', 'lastYouMessageAt'])
    && typeof value.awake === 'boolean'
    && typeof value.busy === 'boolean'
    && isUnit(value.relationshipChoice)
    && (value.lastYouMessageAt === null || isTimestamp(value.lastYouMessageAt));
}

export function isJunluoDesireState(value: unknown): value is JunluoDesireState {
  if (!isRecord(value) || !hasExactKeys(value, [
    'activatedAt',
    'clock',
    'desires',
    'recentProcessedOperations',
    'schemaVersion',
    'updatedAt',
  ])) return false;
  const desires = value.desires;
  if (
    value.schemaVersion !== 4
    || !isTimestamp(value.activatedAt)
    || !isOperationRefList(value.recentProcessedOperations)
    || !isTimestamp(value.updatedAt)
    || Number(value.updatedAt) < Number(value.activatedAt)
    || !isRecord(value.clock)
    || !hasExactKeys(value.clock, ['settledAt', 'context', ...('correction' in value.clock ? ['correction'] : [])])
    || !isTimestamp(value.clock.settledAt)
    || Number(value.clock.settledAt) > Number(value.updatedAt)
    || (value.clock.context !== null && !isJunluoDesireTimeContext(value.clock.context))
    || !isRecord(desires)
  ) return false;
  if ('correction' in value.clock) {
    const correction = value.clock.correction;
    if (!isRecord(correction) || !hasExactKeys(correction, ['at', 'from'])
      || !isTimestamp(correction.at) || !isTimestamp(correction.from)
      || Number(correction.from) <= Number(correction.at)
      || Number(correction.at) > Number(value.clock.settledAt)) return false;
  }
  if (!hasExactKeys(desires, JUNLUO_DESIRE_IDS)) return false;
  const clock = value.clock;
  return JUNLUO_DESIRE_IDS.every((id) => isDesireDimension(desires[id]))
    && JUNLUO_DESIRE_IDS.every(id => {
      const anchor = (desires[id] as JunluoDesireDimension).satisfactionClockAt;
      return anchor === undefined || ('correction' in clock && anchor <= Number(clock.settledAt));
    })
    && isUnit((desires.remind_you as JunluoDesireDimension).currentValue);
}

function isEmotionComponent(value: unknown): value is JunluoEmotionComponentV1 {
  return isRecord(value)
    && hasExactKeys(value, ['emotionId', 'intensity', 'occurredAt', 'operationId', 'sourceId', 'target',
      ...(Object.hasOwn(value, 'reason') ? ['reason'] : [])])
    && (!Object.hasOwn(value, 'reason') || value.reason === null || typeof value.reason === 'string')
    && isOneOf(BAIYUN_EMOTION_IDS, value.emotionId)
    && isUnit(value.intensity)
    && isTimestamp(value.occurredAt)
    && isId(value.operationId)
    && isId(value.sourceId)
    && isOneOf(['I', 'you', 'other', 'situation'] as const, value.target);
}

function isEmotionSnapshot(value: unknown): value is JunluoEmotionSnapshotV1 {
  if (!isRecord(value) || !hasExactKeys(value, ['primary', 'secondary'])) return false;
  if (value.primary !== null && !isEmotionComponent(value.primary)) return false;
  if (!Array.isArray(value.secondary) || value.secondary.length > 1) return false;
  if (value.primary === null && value.secondary.length > 0) return false;
  return value.secondary.every(isEmotionComponent);
}

function isLifeState(value: unknown): value is JunluoLifePortraitStateV1 {
  return isRecord(value)
    && hasExactKeys(value, ['occurredAt', 'operationId', 'sourceId', 'stateId'])
    && isTimestamp(value.occurredAt)
    && isId(value.operationId)
    && isId(value.sourceId)
    && isOneOf(BAIYUN_LIFE_PORTRAIT_STATE_IDS, value.stateId);
}

function isInnerScalar(value: unknown, signed = false): value is JunluoInnerScalarV1 {
  return isRecord(value)
    && hasExactKeys(value, ['lastOperation', 'sourceId', 'updatedAt', 'value'])
    && (value.lastOperation === null || isOperationRef(value.lastOperation))
    && (value.sourceId === null || isId(value.sourceId))
    && isTimestamp(value.updatedAt)
    && (signed ? isSignedUnit(value.value) : isUnit(value.value));
}

function isRelationshipChoiceEvidence(value: unknown): value is JunluoRelationshipChoiceEvidenceV1 {
  return isRecord(value)
    && hasExactKeys(value, ['evidenceId', 'localDate', 'movement', 'occurredAt', 'operationId'])
    && isId(value.evidenceId)
    && typeof value.localDate === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value.localDate)
    && isOneOf(RELATIONSHIP_CHOICE_MOVEMENTS, value.movement)
    && isTimestamp(value.occurredAt)
    && isId(value.operationId);
}

function isRelationshipChoiceRetraction(value: unknown): value is JunluoRelationshipChoiceRetractionV1 {
  return isRecord(value)
    && hasExactKeys(value, ['occurredAt', 'operationId', 'targetEvidenceId'])
    && isTimestamp(value.occurredAt)
    && isId(value.operationId)
    && isId(value.targetEvidenceId);
}

function hasValidAffectStateBody(value: Record<string, unknown>) {
  const evidence = value.relationshipChoiceEvidence;
  const retractions = value.relationshipChoiceRetractions;
  if (!Array.isArray(evidence) || !evidence.every(isRelationshipChoiceEvidence)) return false;
  if (!Array.isArray(retractions) || !retractions.every(isRelationshipChoiceRetraction)) return false;
  const evidenceIds = new Set(evidence.map((entry) => entry.evidenceId));
  if (evidenceIds.size !== evidence.length) return false;
  if (new Set(evidence.map((entry) => entry.operationId)).size !== evidence.length) return false;
  if (!retractions.every((entry) => evidenceIds.has(entry.targetEvidenceId))) return false;
  if (new Set(retractions.map((entry) => entry.operationId)).size !== retractions.length) return false;
  return isEmotionSnapshot(value.emotions)
    && (value.emotionsLastOperation === null || isOperationRef(value.emotionsLastOperation))
    && (value.lifeState === null || isLifeState(value.lifeState))
    && (value.lifeStateLastOperation === null || isOperationRef(value.lifeStateLastOperation))
    && isOperationRefList(value.recentProcessedOperations)
    && isInnerScalar(value.relationshipChoice)
    && isInnerScalar(value.relationshipFeeling, true)
    && isInnerScalar(value.strain)
    && isTimestamp(value.updatedAt);
}

export function isJunluoAffectStateLegacyV1(
  value: unknown,
): value is JunluoAffectStateLegacyV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'emotions',
    'emotionsLastOperation',
    'lifeState',
    'lifeStateLastOperation',
    'recentProcessedOperations',
    'relationshipChoice',
    'relationshipChoiceEvidence',
    'relationshipChoiceRetractions',
    'relationshipFeeling',
    'schemaVersion',
    'strain',
    'updatedAt',
  ])) return false;
  return value.schemaVersion === 1 && hasValidAffectStateBody(value);
}

function isRelationshipPhase(value: unknown): value is JunluoRelationshipPhaseV2 {
  if (!isRecord(value)
    || !hasExactKeys(value, ['activatedAt', 'enteredAt', 'lastOperation', 'phase'])
    || !isTimestamp(value.activatedAt)
    || !isTimestamp(value.enteredAt)
  ) return false;
  if (!isOneOf(RELATIONSHIP_PHASES, value.phase)) return false;
  if (Number(value.enteredAt) < Number(value.activatedAt)) return false;
  if (value.lastOperation === null) return value.phase === 'together';
  return isOperationRef(value.lastOperation)
    && value.lastOperation.occurredAt === value.enteredAt;
}

export function isJunluoAffectStateV1(value: unknown): value is JunluoAffectStateV2 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'emotions',
    'emotionsLastOperation',
    'lifeState',
    'lifeStateLastOperation',
    'recentProcessedOperations',
    'relationshipChoice',
    'relationshipChoiceEvidence',
    'relationshipChoiceRetractions',
    'relationshipFeeling',
    'relationshipPhase',
    'schemaVersion',
    'strain',
    'updatedAt',
  ])) return false;
  return value.schemaVersion === 2
    && isRelationshipPhase(value.relationshipPhase)
    && hasValidAffectStateBody(value);
}

function isThoughtLegacyV1(value: unknown): value is JunluoInnerThoughtLegacyV1 {
  return isRecord(value)
    && hasExactKeys(value, [
      'content',
      'createdAt',
      'desireId',
      'sourceId',
      'sourceKind',
      'state',
      'thoughtId',
      'lastTransition',
      'updatedAt',
    ])
    && typeof value.content === 'string'
    && value.content.length > 0
    && value.content.length <= 160
    && isTimestamp(value.createdAt)
    && isOneOf(JUNLUO_DESIRE_IDS, value.desireId)
    && isId(value.sourceId)
    && isOneOf(INNER_THOUGHT_SOURCE_KINDS, value.sourceKind)
    && isOneOf(INNER_THOUGHT_STATES, value.state)
    && isId(value.thoughtId)
    && isOperationRef(value.lastTransition)
    && isTimestamp(value.updatedAt);
}

function hasUniqueThoughtIdsAndSources(
  thoughts: readonly JunluoInnerThoughtLegacyV1[],
) {
  const thoughtIds = new Set<string>();
  const sourceIds = new Set<string>();
  for (const thought of thoughts) {
    const sourceKey = `${thought.sourceKind}\u0000${thought.sourceId}`;
    if (thoughtIds.has(thought.thoughtId) || sourceIds.has(sourceKey)) return false;
    thoughtIds.add(thought.thoughtId);
    sourceIds.add(sourceKey);
  }
  return true;
}

export function isJunluoThoughtStateLegacyV1(
  value: unknown,
): value is JunluoThoughtStateLegacyV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'recentProcessedOperations',
    'schemaVersion',
    'thoughts',
    'updatedAt',
  ])) return false;
  if (
    value.schemaVersion !== 1
    || !isOperationRefList(value.recentProcessedOperations)
    || !Array.isArray(value.thoughts)
    || !isTimestamp(value.updatedAt)
  ) return false;
  return value.thoughts.every(isThoughtLegacyV1)
    && hasUniqueThoughtIdsAndSources(value.thoughts);
}

function isThoughtAttempt(value: unknown): value is JunluoThoughtAttemptV2 {
  return isRecord(value)
    && hasExactKeys(value, ['occurredAt', 'operationId', 'outcome', 'sourceId', 'sourceKind'])
    && isTimestamp(value.occurredAt)
    && isId(value.operationId)
    && isOneOf(JUNLUO_THOUGHT_ATTEMPT_OUTCOMES, value.outcome)
    && isId(value.sourceId)
    && isOneOf(JUNLUO_RECEIPT_SOURCE_KINDS, value.sourceKind);
}

function isThoughtV2(value: unknown): value is JunluoInnerThoughtV2 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'attemptCount',
    'content',
    'createdAt',
    'desireId',
    'lastAttempt',
    'lastChosenAt',
    'lastOutcome',
    'lastTransition',
    'missedReviewCount',
    'nextReviewAt',
    'reviewStage',
    'sourceId',
    'sourceKind',
    'state',
    'thoughtId',
    'updatedAt',
  ])) return false;
  const legacy = {
    content: value.content,
    createdAt: value.createdAt,
    desireId: value.desireId,
    lastTransition: value.lastTransition,
    sourceId: value.sourceId,
    sourceKind: value.sourceKind,
    state: value.state,
    thoughtId: value.thoughtId,
    updatedAt: value.updatedAt,
  };
  const lastAttempt = value.lastAttempt as JunluoThoughtAttemptV2 | null;
  return isThoughtLegacyV1(legacy)
    && Number.isSafeInteger(value.attemptCount)
    && Number(value.attemptCount) >= 0
    && (lastAttempt === null || isThoughtAttempt(lastAttempt))
    && (value.lastChosenAt === null || isTimestamp(value.lastChosenAt))
    && (value.lastOutcome === null || isOneOf(['failed', 'blocked', 'incomplete'] as const, value.lastOutcome))
    && Number.isSafeInteger(value.missedReviewCount)
    && Number(value.missedReviewCount) >= 0
    && Number(value.missedReviewCount) <= 3
    && (value.nextReviewAt === null || isTimestamp(value.nextReviewAt))
    && typeof value.reviewStage === 'number'
    && Number.isInteger(value.reviewStage)
    && [0, 1, 2].includes(value.reviewStage)
    && Number(value.attemptCount) >= (lastAttempt === null ? 0 : 1)
    && (lastAttempt?.outcome === 'success' ? value.state === 'resolved' : true)
    && (value.lastOutcome === null || lastAttempt?.outcome === value.lastOutcome)
    && (value.state === 'unfulfilled_candidate'
      ? (value.lastOutcome !== null && value.nextReviewAt !== null)
        || (value.attemptCount === 0 && value.lastOutcome === null && value.nextReviewAt === null)
      : value.nextReviewAt === null);
}

export function isJunluoThoughtStateV2(value: unknown): value is JunluoThoughtStateV2 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'recentProcessedOperations',
    'schemaVersion',
    'thoughts',
    'updatedAt',
  ])) return false;
  if (
    value.schemaVersion !== 2
    || !isOperationRefList(value.recentProcessedOperations)
    || !Array.isArray(value.thoughts)
    || !isTimestamp(value.updatedAt)
  ) return false;
  return value.thoughts.every(isThoughtV2)
    && hasUniqueThoughtIdsAndSources(value.thoughts);
}

export function isJunluoThoughtStateV1(value: unknown): value is JunluoThoughtStateV1 {
  return isJunluoThoughtStateLegacyV1(value) || isJunluoThoughtStateV2(value);
}
