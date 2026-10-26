import { resolveMemoryCalendarTime } from './memoryCalendarTime';

export type MemoryAtomicKind =
  | 'fact'
  | 'preference'
  | 'event'
  | 'relationship_rule'
  | 'relationship_change'
  | 'stage_conclusion'
  | 'unknown';

export type MemoryEventTimePrecision = 'instant' | 'day' | 'range' | 'unknown';
export type MemoryEventTimeBasis = 'explicit' | 'relative' | 'source_message' | 'derived_period' | 'unknown';

export type MemoryEventTime = {
  basis: MemoryEventTimeBasis;
  endAt?: number;
  precision: MemoryEventTimePrecision;
  startAt?: number;
  timeExpression?: string;
  timeSourceMessageId?: string;
};

export type MemoryExtractionBasis =
  | 'direct_single_message'
  | 'direct_multi_message'
  | 'derived_memories'
  | 'imported_text'
  | 'manual'
  | 'unknown';

export type MemoryAtomicSourceMessage = {
  content: string;
  createdAt: number;
  id: string;
};

const ATOMIC_KINDS = new Set<MemoryAtomicKind>([
  'fact',
  'preference',
  'event',
  'relationship_rule',
  'relationship_change',
  'stage_conclusion',
  'unknown',
]);
const EVENT_TIME_PRECISIONS = new Set<MemoryEventTimePrecision>(['instant', 'day', 'range', 'unknown']);
const MODEL_EVENT_TIME_BASES = new Set<MemoryEventTimeBasis>(['explicit', 'relative', 'source_message', 'unknown']);
const EVENT_TIME_BASES = new Set<MemoryEventTimeBasis>([...MODEL_EVENT_TIME_BASES, 'derived_period']);
const EXTRACTION_BASES = new Set<MemoryExtractionBasis>([
  'direct_single_message',
  'direct_multi_message',
  'derived_memories',
  'imported_text',
  'manual',
  'unknown',
]);

function finiteTimestamp(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function localDayRange(timestamp: number) {
  const date = new Date(timestamp);
  const startAt = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return {
    endAt: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() - 1,
    startAt,
  };
}

export function normalizeMemoryAtomicKind(value: unknown): MemoryAtomicKind {
  return typeof value === 'string' && ATOMIC_KINDS.has(value as MemoryAtomicKind)
    ? value as MemoryAtomicKind
    : 'unknown';
}

export function isModelMemoryAtomicKind(value: unknown): value is Exclude<MemoryAtomicKind, 'unknown'> {
  return normalizeMemoryAtomicKind(value) !== 'unknown';
}

export function normalizeMemoryExtractionBasis(value: unknown): MemoryExtractionBasis {
  return typeof value === 'string' && EXTRACTION_BASES.has(value as MemoryExtractionBasis)
    ? value as MemoryExtractionBasis
    : 'unknown';
}

export function normalizeStoredMemoryEventTime(value: {
  basis?: unknown;
  endAt?: unknown;
  precision?: unknown;
  startAt?: unknown;
  timeExpression?: unknown;
  timeSourceMessageId?: unknown;
}): MemoryEventTime | undefined {
  const precision = typeof value.precision === 'string'
    && EVENT_TIME_PRECISIONS.has(value.precision as MemoryEventTimePrecision)
    ? value.precision as MemoryEventTimePrecision
    : 'unknown';
  const basis = typeof value.basis === 'string' && EVENT_TIME_BASES.has(value.basis as MemoryEventTimeBasis)
    ? value.basis as MemoryEventTimeBasis
    : 'unknown';
  const startAt = finiteTimestamp(value.startAt);
  const endAt = finiteTimestamp(value.endAt);
  const timeExpression = typeof value.timeExpression === 'string'
    ? value.timeExpression.trim()
    : '';
  const timeSourceMessageId = typeof value.timeSourceMessageId === 'string'
    ? value.timeSourceMessageId.trim()
    : '';
  const evidence = {
    ...(timeExpression ? { timeExpression } : {}),
    ...(timeSourceMessageId ? { timeSourceMessageId } : {}),
  };
  if (precision === 'unknown' || startAt === undefined) {
    return timeExpression || timeSourceMessageId
      ? { basis: 'unknown', precision: 'unknown', ...evidence }
      : undefined;
  }
  if (precision === 'instant') return { basis, precision, startAt, ...evidence };
  if (precision === 'day') {
    const range = localDayRange(startAt);
    return { basis, precision, ...range, ...evidence };
  }
  if (endAt === undefined || endAt < startAt) return undefined;
  return { basis, endAt, precision, startAt, ...evidence };
}

export function normalizeModelMemoryEventTime(
  value: unknown,
  options: {
    candidateText?: string;
    legacyEventAt?: unknown;
    sourceMessages?: MemoryAtomicSourceMessage[];
    sourceText?: string;
    observationCapturedAt?: number[];
  } = {},
): MemoryEventTime | undefined {
  if (!value || typeof value !== 'object') {
    const legacyEventAt = finiteTimestamp(options.legacyEventAt);
    return legacyEventAt === undefined
      ? undefined
      : { basis: 'unknown', precision: 'instant', startAt: legacyEventAt };
  }
  const raw = value as Record<string, unknown>;
  const precision = typeof raw.precision === 'string'
    && EVENT_TIME_PRECISIONS.has(raw.precision as MemoryEventTimePrecision)
    ? raw.precision as MemoryEventTimePrecision
    : 'unknown';
  const basis = typeof raw.basis === 'string' && MODEL_EVENT_TIME_BASES.has(raw.basis as MemoryEventTimeBasis)
    ? raw.basis as MemoryEventTimeBasis
    : 'unknown';

  const sourceMessages = options.sourceMessages ?? [];
  const requestedSourceId = typeof raw.timeSourceMessageId === 'string'
    ? raw.timeSourceMessageId.trim()
    : '';
  const sourceMessage = sourceMessages.find((message) => message.id === requestedSourceId);
  const timeExpression = typeof raw.timeExpression === 'string'
    ? raw.timeExpression.trim()
    : '';
  const containsExpression = (text: string) => text.replace(/\s+/g, '').includes(timeExpression.replace(/\s+/g, ''));
  const sourceSupportsExpression = !!timeExpression && (!requestedSourceId || !!sourceMessage) && (
    sourceMessage ? containsExpression(sourceMessage.content)
      : sourceMessages.some((message) => containsExpression(message.content))
        || (!!options.sourceText && containsExpression(options.sourceText))
  );
  // A frame can establish its own capture instant, not when a continuing event began or ended.
  const frameTime = !requestedSourceId && basis === 'explicit' && precision === 'instant'
    ? options.observationCapturedAt?.find(time => Number.isFinite(time) && timeExpression === new Date(time).toISOString()) : undefined;
  if (frameTime !== undefined) return finiteTimestamp(raw.startAt) === frameTime && raw.endAt == null
    ? { basis, precision, startAt: frameTime, timeExpression } : undefined;
  const unresolvedTime: MemoryEventTime | undefined = sourceSupportsExpression
    ? {
        basis: 'unknown', precision: 'unknown', timeExpression,
        ...(sourceMessage ? { timeSourceMessageId: sourceMessage.id } : {}),
      }
    : undefined;
  // A calendar phrase can be quoted, tentative, or corrected later. Calendar
  // arithmetic must not turn the organizer's uncertainty into a definite date.
  if (precision === 'unknown' || basis === 'unknown') return unresolvedTime;
  const calendarResolution = basis === 'source_message'
    ? { blocksModelFallback: false }
    : resolveMemoryCalendarTime({
        candidateText: options.candidateText,
        requestedExpression: timeExpression,
        requestedSourceId,
        sourceMessages,
      });
  const deterministicCalendar = calendarResolution.eventTime;
  if (deterministicCalendar) {
    const modelStartAt = finiteTimestamp(raw.startAt);
    const modelEndAt = finiteTimestamp(raw.endAt);
    if (
      precision === 'range'
      && modelStartAt !== undefined
      && modelEndAt !== undefined
      && modelEndAt < modelStartAt
    ) return undefined;
    if (
      deterministicCalendar.precision === 'day'
      && precision === 'instant'
      && modelStartAt !== undefined
    ) {
      const shift = deterministicCalendar.startAt! - localDayRange(modelStartAt).startAt;
      return {
        basis: deterministicCalendar.basis,
        precision: 'instant',
        startAt: modelStartAt + shift,
        timeExpression: deterministicCalendar.timeExpression,
        timeSourceMessageId: deterministicCalendar.timeSourceMessageId,
      };
    }
    if (
      deterministicCalendar.precision === 'day'
      && precision === 'range'
      && modelStartAt !== undefined
      && modelEndAt !== undefined
      && modelEndAt >= modelStartAt
    ) {
      const shift = deterministicCalendar.startAt! - localDayRange(modelStartAt).startAt;
      return {
        ...deterministicCalendar,
        endAt: modelEndAt + shift,
        precision: 'range',
        startAt: modelStartAt + shift,
      };
    }
    return deterministicCalendar;
  }
  if (calendarResolution.blocksModelFallback) return unresolvedTime;

  if (basis === 'source_message') {
    if (!sourceMessage) return undefined;
    return {
      basis,
      precision: 'instant',
      startAt: sourceMessage.createdAt,
      timeSourceMessageId: sourceMessage.id,
    };
  }
  if (basis === 'relative' && (!sourceMessage || !sourceSupportsExpression)) return undefined;
  if (basis === 'explicit' && (!timeExpression || !sourceSupportsExpression)) return undefined;

  const startAt = finiteTimestamp(raw.startAt);
  const endAt = finiteTimestamp(raw.endAt);
  if (startAt === undefined) return unresolvedTime;
  const evidence = {
    ...(timeExpression ? { timeExpression } : {}),
    ...(sourceMessage ? { timeSourceMessageId: sourceMessage.id } : {}),
  };
  if (precision === 'instant') return { basis, precision, startAt, ...evidence };
  if (precision === 'day') {
    return { basis, precision, ...localDayRange(startAt), ...evidence };
  }
  if (endAt === undefined || endAt < startAt) return undefined;
  return { basis, endAt, precision, startAt, ...evidence };
}

export function makeDerivedPeriodEventTime(startAt: number, endAt: number): MemoryEventTime {
  return {
    basis: 'derived_period',
    endAt: Math.max(startAt, endAt),
    precision: 'range',
    startAt,
  };
}

export function deriveMemoryExtractionBasis(input: {
  existing?: unknown;
  origin?: string;
  sourceRefCount?: number;
  sourceType?: string;
}) {
  const existing = normalizeMemoryExtractionBasis(input.existing);
  if (existing !== 'unknown') return existing;
  if (input.origin === 'history_import' || input.sourceType === 'history-import') return 'imported_text' as const;
  if (input.origin === 'weekly' || input.sourceType === 'weekly-context') return 'derived_memories' as const;
  if ((input.sourceRefCount ?? 0) > 1) return 'direct_multi_message' as const;
  if (input.sourceRefCount === 1) return 'direct_single_message' as const;
  if (input.sourceType === 'manual') return 'manual' as const;
  return 'unknown' as const;
}

export function stableMemoryHash(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function makeMemoryIngestionSourceHash(messages: Array<{
  content: string;
  createdAt: number;
  id: string;
  role: string;
}>) {
  return stableMemoryHash(messages.map((message) => [
    message.id,
    message.role,
    message.createdAt,
    stableMemoryHash(message.content),
  ].join('\u0000')).join('\u0001'));
}

export function makeMemoryCandidateKey(candidate: {
  observationBindings?: Array<{ observationId: string; sourceHash: string; start: number; end: number }>;
  letterBindings?: Array<{ sessionId: string; messageId: string; sourceHash: string; start: number; end: number }>;
  currentStateReview?: { action: string; targetCurrentStateId: string | null; targetHash?: string; evidence: unknown[] };
  understandingSubject?: 'I' | 'you';
  understandingBasis?: { hash: string };
  understandingReview?: { targetMemoryId: string | null; targetHash?: string;
    understandingKind?: 'stated' | 'pattern' | 'situational'; statedQuote?: string | null; patternEvidence?: unknown };
  atomicKind?: MemoryAtomicKind;
  candidateKind?: string;
  content: string;
  eventTime?: MemoryEventTime;
  sourceRefs?: Array<{ messageId: string; sessionId: string }>;
  title: string;
}): string {
  if (candidate.observationBindings?.length) {
    const { observationBindings, ...rest } = candidate;
    return `observation-${stableMemoryHash(JSON.stringify([makeMemoryCandidateKey(rest), observationBindings.map(binding =>
      [binding.observationId, binding.sourceHash, binding.start, binding.end])]))}`;
  }
  if (candidate.letterBindings?.length) {
    const { letterBindings, ...rest } = candidate;
    return `letter-${stableMemoryHash(JSON.stringify([makeMemoryCandidateKey(rest), letterBindings.map(binding =>
      [binding.sessionId, binding.messageId, binding.sourceHash, binding.start, binding.end])]))}`;
  }
  if (candidate.currentStateReview) return `current-state-${stableMemoryHash(JSON.stringify([
    candidate.currentStateReview, candidate.title, candidate.content,
  ]))}`;
  if (candidate.understandingSubject) return `understanding-${stableMemoryHash(JSON.stringify([
    candidate.understandingSubject, candidate.understandingReview?.targetMemoryId,
    candidate.understandingReview?.targetHash, candidate.understandingBasis?.hash,
    candidate.understandingReview?.targetMemoryId ? null : [candidate.title, candidate.content],
    ...(candidate.understandingReview?.understandingKind ? [candidate.understandingReview.understandingKind,
      candidate.understandingReview.statedQuote, candidate.understandingReview.patternEvidence] : []),
  ]))}`;
  const sourceIds = (candidate.sourceRefs ?? [])
    .map((ref) => `${ref.sessionId}:${ref.messageId}`)
    .sort()
    .join(',');
  return stableMemoryHash([
    candidate.atomicKind ?? 'unknown',
    candidate.candidateKind ?? 'long_term',
    sourceIds,
    candidate.eventTime?.precision ?? 'unknown',
    candidate.eventTime?.startAt ?? '',
    candidate.eventTime?.endAt ?? '',
    candidate.title.replace(/\s+/g, '').toLowerCase(),
    candidate.content.replace(/\s+/g, '').toLowerCase(),
  ].join('\u0000'));
}

export function getMemoryAtomicKindLabel(kind: MemoryAtomicKind) {
  return {
    event: '事件',
    fact: '事实',
    preference: '偏好',
    relationship_change: '关系变化',
    relationship_rule: '关系规则',
    stage_conclusion: '阶段结论',
    unknown: '未分类',
  }[kind];
}

export function getMemoryExtractionBasisLabel(basis: MemoryExtractionBasis) {
  return {
    derived_memories: '旧记忆派生',
    direct_multi_message: '多句直接来源',
    direct_single_message: '单句直接来源',
    imported_text: '历史导入',
    manual: '手动创建',
    unknown: '来源类型未标注',
  }[basis];
}

export function formatMemoryEventTimeLabel(eventTime?: MemoryEventTime) {
  const startAt = getMemoryOccurrenceStart(eventTime);
  if (startAt === undefined || !eventTime) {
    return eventTime?.timeExpression ? `时间线索：${eventTime.timeExpression}（具体日期未定）` : '时间未确定';
  }
  const start = new Date(startAt).toLocaleString('zh-CN', {
    day: '2-digit',
    hour: eventTime.precision === 'instant' ? '2-digit' : undefined,
    minute: eventTime.precision === 'instant' ? '2-digit' : undefined,
    month: '2-digit',
    year: 'numeric',
  });
  if (eventTime.precision !== 'range' || !eventTime.endAt) return start;
  const end = new Date(eventTime.endAt).toLocaleDateString('zh-CN');
  return `${start} 至 ${end}`;
}

// Legacy eventAt can contain a message/save time. Only the structured time
// with a known basis can serve as an occurrence date.
export function getMemoryOccurrenceStart(eventTime?: MemoryEventTime): number | undefined {
  if (!eventTime || eventTime.basis === 'unknown' || eventTime.precision === 'unknown') return undefined;
  const startAt = finiteTimestamp(eventTime.startAt);
  if (startAt === undefined) return undefined;
  if (eventTime.precision === 'range') {
    const endAt = finiteTimestamp(eventTime.endAt);
    if (endAt === undefined || endAt < startAt) return undefined;
  }
  return startAt;
}
