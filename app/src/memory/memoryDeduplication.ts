import { isBaiyunPostMemory } from '../posts/baiyunPostContract';

export type MemoryDeduplicationMemory = {
  anchor: boolean;
  atomicKind: 'fact' | 'preference' | 'event' | 'relationship_rule' | 'relationship_change' | 'stage_conclusion' | 'unknown';
  confirmationLevel: 'automatic' | 'reviewed' | 'manual';
  content: string;
  domain: string;
  eventTime?: {
    basis: 'explicit' | 'relative' | 'source_message' | 'derived_period' | 'unknown';
    endAt?: number;
    precision: 'instant' | 'day' | 'range' | 'unknown';
    startAt?: number;
    timeExpression?: string;
    timeSourceMessageId?: string;
  };
  id: string;
  pinned: boolean;
  source?: string;
  period?: string;
  tags?: readonly string[];
  protected: boolean;
  tier: 'core' | 'working' | 'peripheral';
  title: string;
  type: 'dynamic' | 'permanent' | 'feel' | 'archived';
  updatedAt: number;
  understandingSubject?: 'I' | 'you';
};
export type MemoryDuplicateRelationship =
  | 'same_stable_memory'
  | 'same_event_restatement'
  | 'stable_replacement'
  | 'event_progress'
  | 'related_separate'
  | 'unrelated';

export type MemoryEventBoundary = {
  time: 'same_or_overlapping' | 'unknown' | 'separate';
  scene: 'same' | 'unknown' | 'separate';
  keyAction: 'same_or_restatement' | 'continues' | 'unknown' | 'separate';
  closure: 'same_event_restatement' | 'new_progress' | 'two_complete_events' | 'unknown';
};

export type MemoryDuplicateAction = 'create' | 'merge' | 'update';

export type MemoryDeduplicationOutcome =
  | 'created'
  | 'reused_exact'
  | 'merged_archived'
  | 'updated_archived'
  | 'suggested'
  | 'kept_separate'
  | 'retry_latest';

export type MemoryDuplicateDecision = {
  action: MemoryDuplicateAction;
  relationship: MemoryDuplicateRelationship;
  targetMemoryId?: string;
  confidence: number;
  eventBoundary: MemoryEventBoundary;
  reason: string;
  mergedContent?: string;
};

const RELATIONSHIPS = new Set<MemoryDuplicateRelationship>([
  'same_stable_memory',
  'same_event_restatement',
  'stable_replacement',
  'event_progress',
  'related_separate',
  'unrelated',
]);
const EVENT_TIME = new Set<MemoryEventBoundary['time']>(['same_or_overlapping', 'unknown', 'separate']);
const EVENT_SCENE = new Set<MemoryEventBoundary['scene']>(['same', 'unknown', 'separate']);
const EVENT_ACTION = new Set<MemoryEventBoundary['keyAction']>([
  'same_or_restatement',
  'continues',
  'unknown',
  'separate',
]);
const EVENT_CLOSURE = new Set<MemoryEventBoundary['closure']>([
  'same_event_restatement',
  'new_progress',
  'two_complete_events',
  'unknown',
]);
const STABLE_UPDATE_DOMAINS = new Set<string>(['喜好', '称呼', '边界', '约定']);
const STABLE_UPDATE_KINDS = new Set<MemoryDeduplicationMemory['atomicKind']>([
  'fact',
  'preference',
  'relationship_rule',
]);
const RELIABLE_EVENT_BASES = new Set([
  'explicit',
  'relative',
  'derived_period',
]);

export function normalizeMemoryExactContent(value: string) {
  return value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function isMemoryDeduplicationProtected(
  memory: Pick<MemoryDeduplicationMemory, 'anchor' | 'confirmationLevel' | 'pinned' | 'protected' | 'tier' | 'source' | 'period' | 'tags' | 'understandingSubject'>,
) {
  return !!memory.understandingSubject || isBaiyunPostMemory(memory)
    || memory.confirmationLevel !== 'automatic'
    || memory.pinned
    || memory.protected
    || memory.anchor
    || memory.tier === 'core';
}

export function isAutomaticMemoryDeduplicationEligible(
  memory: Pick<MemoryDeduplicationMemory, 'anchor' | 'confirmationLevel' | 'pinned' | 'protected' | 'tier' | 'type' | 'source' | 'period' | 'tags' | 'understandingSubject'>,
) {
  return memory.type !== 'archived' && !isMemoryDeduplicationProtected(memory);
}

function reliableEventRange(memory: Pick<MemoryDeduplicationMemory, 'eventTime'>) {
  const eventTime = memory.eventTime;
  if (
    !eventTime
    || !RELIABLE_EVENT_BASES.has(eventTime.basis)
    || !Number.isFinite(eventTime.startAt)
  ) return null;
  const startAt = eventTime.startAt as number;
  const endAt = Number.isFinite(eventTime.endAt) ? eventTime.endAt as number : startAt;
  return { startAt: Math.min(startAt, endAt), endAt: Math.max(startAt, endAt) };
}

export function hasSeparateReliableEventTime(
  source: Pick<MemoryDeduplicationMemory, 'eventTime'>,
  target: Pick<MemoryDeduplicationMemory, 'eventTime'>,
) {
  const sourceRange = reliableEventRange(source);
  const targetRange = reliableEventRange(target);
  return !!sourceRange
    && !!targetRange
    && (sourceRange.endAt < targetRange.startAt || targetRange.endAt < sourceRange.startAt);
}

function isConcreteEvent(memory: Pick<MemoryDeduplicationMemory, 'atomicKind'>) {
  return memory.atomicKind === 'event' || memory.atomicKind === 'relationship_change';
}

export function hasLocalMemorySeparationGate(
  source: Pick<MemoryDeduplicationMemory, 'atomicKind' | 'eventTime' | 'understandingSubject'>,
  target: Pick<MemoryDeduplicationMemory, 'atomicKind' | 'eventTime' | 'understandingSubject'>,
) {
  if (source.understandingSubject || target.understandingSubject) return true;
  if (
    (source.atomicKind === 'stage_conclusion' && isConcreteEvent(target))
    || (target.atomicKind === 'stage_conclusion' && isConcreteEvent(source))
  ) return true;
  return hasSeparateReliableEventTime(source, target);
}

type ExactMemory = Pick<MemoryDeduplicationMemory, 'content' | 'domain'>
  & Partial<Pick<MemoryDeduplicationMemory, 'atomicKind' | 'eventTime' | 'understandingSubject'>>;

export function canReuseExactMemory(source: ExactMemory, target: ExactMemory, sameDirectSource = false) {
  const content = normalizeMemoryExactContent(source.content);
  if (!content || content !== normalizeMemoryExactContent(target.content)
    || !source.atomicKind || source.atomicKind === 'unknown' || source.atomicKind !== target.atomicKind
    || source.domain !== target.domain
    || hasLocalMemorySeparationGate({ ...source, atomicKind: source.atomicKind }, {
      ...target, atomicKind: target.atomicKind ?? 'unknown',
    })) return false;
  if (STABLE_UPDATE_KINDS.has(source.atomicKind)) return true;
  // Matching prose/dates alone cannot identify an event; the original evidence must also match.
  return sameDirectSource
    && (source.eventTime?.startAt ?? null) === (target.eventTime?.startAt ?? null)
    && (source.eventTime?.endAt ?? null) === (target.eventTime?.endAt ?? null)
    && (source.eventTime?.precision ?? 'unknown') === (target.eventTime?.precision ?? 'unknown');
}

export function isStableMemoryReplacementAllowed(
  source: Pick<MemoryDeduplicationMemory, 'atomicKind' | 'domain' | 'understandingSubject'>,
  target: Pick<MemoryDeduplicationMemory, 'atomicKind' | 'domain' | 'understandingSubject'>,
) {
  return !source.understandingSubject && !target.understandingSubject && STABLE_UPDATE_KINDS.has(source.atomicKind)
    && STABLE_UPDATE_KINDS.has(target.atomicKind)
    && STABLE_UPDATE_DOMAINS.has(source.domain)
    && STABLE_UPDATE_DOMAINS.has(target.domain);
}

export function eventBoundaryKeepsMemoriesSeparate(boundary: MemoryEventBoundary) {
  return boundary.time === 'separate'
    || boundary.scene === 'separate'
    || boundary.keyAction === 'continues'
    || boundary.keyAction === 'separate'
    || boundary.closure === 'new_progress'
    || boundary.closure === 'two_complete_events';
}

export function normalizeMemoryDuplicateDecision(
  raw: unknown,
  allowedTargetIds: ReadonlySet<string>,
): MemoryDuplicateDecision {
  const fallback: MemoryDuplicateDecision = {
    action: 'create',
    relationship: 'unrelated',
    confidence: 0,
    eventBoundary: {
      time: 'unknown',
      scene: 'unknown',
      keyAction: 'unknown',
      closure: 'unknown',
    },
    reason: '',
  };
  if (!raw || typeof raw !== 'object') return fallback;
  const record = raw as Record<string, unknown>;
  const allowedFields = new Set([
    'action',
    'relationship',
    'targetMemoryId',
    'confidence',
    'eventBoundary',
    'reason',
    'mergedContent',
  ]);
  if (Object.keys(record).some((field) => !allowedFields.has(field))) return fallback;
  if (record.mergedContent !== undefined && typeof record.mergedContent !== 'string') return fallback;
  const rawAction = typeof record.action === 'string' ? record.action.toLowerCase() : '';
  if (rawAction !== 'create' && rawAction !== 'merge' && rawAction !== 'update') return fallback;
  if (typeof record.relationship !== 'string' || !RELATIONSHIPS.has(record.relationship as MemoryDuplicateRelationship)) {
    return fallback;
  }
  if (!record.eventBoundary || typeof record.eventBoundary !== 'object') return fallback;
  const eventBoundary = record.eventBoundary as Record<string, unknown>;
  const allowedBoundaryFields = new Set(['time', 'scene', 'keyAction', 'closure']);
  if (Object.keys(eventBoundary).some((field) => !allowedBoundaryFields.has(field))) return fallback;
  if (
    typeof eventBoundary.time !== 'string' || !EVENT_TIME.has(eventBoundary.time as MemoryEventBoundary['time'])
    || typeof eventBoundary.scene !== 'string' || !EVENT_SCENE.has(eventBoundary.scene as MemoryEventBoundary['scene'])
    || typeof eventBoundary.keyAction !== 'string' || !EVENT_ACTION.has(eventBoundary.keyAction as MemoryEventBoundary['keyAction'])
    || typeof eventBoundary.closure !== 'string' || !EVENT_CLOSURE.has(eventBoundary.closure as MemoryEventBoundary['closure'])
  ) return fallback;
  const targetMemoryId = typeof record.targetMemoryId === 'string'
    ? record.targetMemoryId.trim()
    : '';
  if (rawAction !== 'create' && (!targetMemoryId || !allowedTargetIds.has(targetMemoryId))) return fallback;
  const confidence = typeof record.confidence === 'number' && Number.isFinite(record.confidence)
    ? Math.max(0, Math.min(1, record.confidence))
    : 0;
  return {
    action: rawAction,
    relationship: record.relationship as MemoryDuplicateRelationship,
    targetMemoryId: rawAction === 'create' ? undefined : targetMemoryId,
    confidence,
    eventBoundary: {
      time: eventBoundary.time as MemoryEventBoundary['time'],
      scene: eventBoundary.scene as MemoryEventBoundary['scene'],
      keyAction: eventBoundary.keyAction as MemoryEventBoundary['keyAction'],
      closure: eventBoundary.closure as MemoryEventBoundary['closure'],
    },
    reason: typeof record.reason === 'string' ? record.reason.trim().slice(0, 60) : '',
    ...(rawAction === 'merge' && record.relationship === 'same_event_restatement'
      && typeof record.mergedContent === 'string' && record.mergedContent.trim()
      ? { mergedContent: record.mergedContent.trim() }
      : {}),
  };
}

export function canExecuteMemoryDuplicateDecision(
  decision: MemoryDuplicateDecision,
  source: MemoryDeduplicationMemory,
  target: MemoryDeduplicationMemory,
) {
  if (
    decision.action === 'create'
    || decision.confidence < 0.9
    || !isAutomaticMemoryDeduplicationEligible(source)
    || !isAutomaticMemoryDeduplicationEligible(target)
    || hasLocalMemorySeparationGate(source, target)
    || eventBoundaryKeepsMemoriesSeparate(decision.eventBoundary)
  ) return false;
  if (decision.action === 'merge') {
    return decision.relationship === 'same_stable_memory'
      || (decision.relationship === 'same_event_restatement'
        && (!!decision.mergedContent?.trim()
          || normalizeMemoryExactContent(source.content) === normalizeMemoryExactContent(target.content)));
  }
  return decision.relationship === 'stable_replacement'
    && isStableMemoryReplacementAllowed(source, target);
}

export function buildMemoryDeduplicationVersion(memory: MemoryDeduplicationMemory) {
  return JSON.stringify({
    anchor: memory.anchor,
    atomicKind: memory.atomicKind,
    confirmationLevel: memory.confirmationLevel,
    content: memory.content,
    domain: memory.domain,
    eventTime: memory.eventTime ?? null,
    id: memory.id,
    pinned: memory.pinned,
    protected: memory.protected,
    source: memory.source ?? null,
    period: memory.period ?? null,
    tags: memory.tags ?? [],
    tier: memory.tier,
    title: memory.title,
    type: memory.type,
    updatedAt: memory.updatedAt,
    understandingSubject: memory.understandingSubject ?? null,
  });
}
