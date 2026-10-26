import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export const FOCUS_SEMANTIC_ADAPTER_ID = 'focus.semantic' as const;
export const FOCUS_SEMANTIC_SCHEMA_VERSION = 1 as const;
export const FOCUS_SEMANTIC_RETENTION_CLASS = 'focus-semantic' as const;

export const FOCUS_SEMANTIC_ENTITY_TYPES = Object.freeze([
  'focus-session',
  'focus-log',
  'focus-tag',
  'focus-invitation',
  'companion-policy',
] as const);

export const FOCUS_SEMANTIC_RECORD_KINDS = Object.freeze([
  'focus-session',
  'focus-log',
  'focus-tag',
  'focus-current-agreement',
  'focus-invitation',
  'focus-invite-cooldown',
  'companion-policy-field',
] as const);

export const FOCUS_COMPANION_POLICY_FIELDS = Object.freeze([
  'idleMinutes',
  'defaultLeaveMinutes',
  'growthDelaySeconds',
  'growthFillSeconds',
] as const);

export type FocusSemanticEntityType =
  typeof FOCUS_SEMANTIC_ENTITY_TYPES[number];
export type FocusSemanticRecordKind =
  typeof FOCUS_SEMANTIC_RECORD_KINDS[number];
export type FocusCompanionPolicyField =
  typeof FOCUS_COMPANION_POLICY_FIELDS[number];

export type FocusSemanticPayloadV1 =
  | {
      schemaVersion: 1;
      kind: FocusSemanticRecordKind;
      record: JsonValue & Record<string, JsonValue>;
    }
  | {
      schemaVersion: 1;
      kind: FocusSemanticRecordKind;
      deletedAt: number;
    };

type FieldValidator = (value: unknown, label: string) => void;

const ENTITY_TYPES = new Set<string>(FOCUS_SEMANTIC_ENTITY_TYPES);
const RECORD_KINDS = new Set<string>(FOCUS_SEMANTIC_RECORD_KINDS);
const FOCUS_MODES = new Set(['support', 'cowork']);
// Transport compatibility only: new sessions are unrated; old history keeps its wire format.
const LEGACY_FOCUS_QUALITY_VALUES = new Set(['', '一般', '良好', '极佳']);
const FOCUS_ROLES = new Set(['system', 'I', 'you']);
const TIMER_MODES = new Set(['stopwatch', 'countdown', 'pomodoro']);
const POLICY_FIELDS = new Set<string>(FOCUS_COMPANION_POLICY_FIELDS);
const REVIEW_CATEGORIES = new Set(['required-study', 'curious-study', 'work', 'create',
  'exercise', 'meal', 'home', 'entertainment', 'on-the-way', 'rest', 'custom']);
const REVIEW_TAG_COLORS = new Set(['#a3ccec', '#e8acc9', '#c5b0e1', '#a7d3bd', '#efd99b', '#efb6a6',
  '#d99b9b', '#e4bd8e', '#c8d394', '#91c9ce', '#98a8d0', '#bfa99a']);

function recordOf(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertString(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false,
): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length > maximumLength
    || (!allowEmpty && value.length < 1)
  ) {
    throw new Error(`${label} 字符串长度无效。`);
  }
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) {
    throw new Error(`${label} 整数范围无效。`);
  }
}

function assertNullableInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (value === null) return;
  assertInteger(value, label, minimum, maximum);
}

function assertFiniteNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(`${label} 数值范围无效。`);
  }
}

function assertEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`${label} 枚举值无效。`);
  }
}

const stringField = (
  maximumLength: number,
  allowEmpty = false,
): FieldValidator => (
  value,
  label,
) => assertString(value, label, maximumLength, allowEmpty);
const timestampField: FieldValidator = assertTimestamp;
const integerField = (
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): FieldValidator => (
  value,
  label,
) => assertInteger(value, label, minimum, maximum);
const nullableIntegerField = (
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): FieldValidator => (
  value,
  label,
) => assertNullableInteger(value, label, minimum, maximum);
const numberField = (
  minimum: number,
  maximum: number,
): FieldValidator => (
  value,
  label,
) => assertFiniteNumber(value, label, minimum, maximum);
const enumField = (
  allowed: ReadonlySet<string>,
): FieldValidator => (
  value,
  label,
) => assertEnum(value, allowed, label);

function assertRecordFields(
  value: unknown,
  label: string,
  fields: Readonly<Record<string, FieldValidator>>,
  optional: Readonly<Record<string, FieldValidator>> = {},
) {
  const record = recordOf(value, label);
  const expected = Object.keys(fields);
  const actual = Object.keys(record);
  if (
    expected.some((field) => !(field in record))
    || actual.some((field) => !(field in fields) && !(field in optional))
  ) {
    throw new Error(`${label} 字段集合无效。`);
  }
  for (const [field, validator] of Object.entries(fields)) {
    validator(record[field], `${label}.${field}`);
  }
  for (const [field, validator] of Object.entries(optional)) {
    if (field in record) validator(record[field], `${label}.${field}`);
  }
}

export function assertFocusReadingBinding(value: unknown, label = 'focus reading') {
  assertRecordFields(value, label, {
    version: (entry, name) => { if (entry !== 1) throw new Error(`${name} 无效。`); },
    bookId: stringField(240), sourceActivityId: stringField(240), sourceOperationId: stringField(240),
    originalRemainingMs: nullableIntegerField(0), boundWorkMs: integerField(0),
  }, {
    choice: (entry, name) => {
      assertRecordFields(entry, name, { next: enumField(new Set(['continue', 'switch'])),
        nextActivity: (text, key) => { if (text !== null) assertString(text, key, 4_000); },
        readingId: (id, key) => { if (id !== null) assertString(id, key, 240); }, savedAt: timestampField });
      const choice = recordOf(entry, name);
      if (choice.next === 'continue' && (choice.nextActivity !== null || choice.readingId !== null)
        || choice.next === 'switch' && choice.nextActivity === null) throw new Error(`${name} 选择字段无效。`);
    },
    transition: (entry, name) => assertRecordFields(entry, name, {
      operationId: stringField(240), at: timestampField, activity: stringField(4_000),
    }, { readingActivityId: stringField(240) }),
    endedAt: timestampField,
  });
}

export function assertFocusReview(value: unknown, label = 'focus review') {
  if (value === null) return;
  assertRecordFields(value, label, {
    version: (entry, name) => { if (entry !== 1) throw new Error(`${name} 无效。`); },
    categoryId: (entry, name) => { if (entry !== null) assertEnum(entry, REVIEW_CATEGORIES, name); },
    spans: (entry, name) => {
      if (!Array.isArray(entry)) throw new Error(`${name} 必须是数组。`);
      let previousEnd = 0;
      for (const [index, span] of entry.entries()) {
        assertRecordFields(span, `${name}[${index}]`, { start: timestampField, end: timestampField });
        const interval = recordOf(span, name);
        if (Number(interval.end) <= Number(interval.start) || Number(interval.start) < previousEnd) {
          throw new Error(`${name} 时间段必须正向、按序且不重叠。`);
        }
        previousEnd = Number(interval.end);
      }
    },
  }, { tag: (entry, name) => assertRecordFields(entry, name, {
    id: stringField(240), label: stringField(32), color: enumField(REVIEW_TAG_COLORS),
  }) });
}

/** Old peers omit chapter-one fields; omission is not a command to erase actual progress. */
export function preserveFocusReadingExtension(current: Record<string, JsonValue>, incoming: Record<string, JsonValue>) {
  const same = typeof current.sessionId === 'string' && current.sessionId === incoming.sessionId
    || typeof current.id === 'string' && current.id === incoming.id;
  if (!same) return incoming;
  const next = { ...incoming };
  // Unknown legacy snapshots cannot erase previously recorded timing evidence.
  if (current.review != null && incoming.review == null) next.review = current.review;
  if (current.reading && !incoming.reading) {
    next.reading = current.reading;
    const old = recordOf(current.reading, 'current reading');
    if (old.transition || old.endedAt !== undefined && current.baiyunActivity === '') next.baiyunActivity = current.baiyunActivity;
  } else if (current.reading && incoming.reading) {
    const old = recordOf(current.reading, 'current reading');
    const fresh = recordOf(incoming.reading, 'incoming reading');
    if (old.sourceActivityId === fresh.sourceActivityId) {
      const merged = { ...fresh };
      for (const field of ['choice', 'transition', 'endedAt']) if (old[field] !== undefined && fresh[field] === undefined) merged[field] = old[field];
      if (old.endedAt !== undefined) merged.endedAt = Math.max(Number(old.endedAt), Number(fresh.endedAt ?? 0));
      if (old.endedAt !== undefined && current.baiyunActivity === '') {
        next.baiyunActivity = '';
        delete merged.choice;
      }
      next.reading = merged as JsonValue;
      if (old.transition && !fresh.transition) next.baiyunActivity = current.baiyunActivity;
    }
  }
  for (const key of ['readingId', 'readingActivityId']) {
    if (current[key] !== undefined && incoming[key] === undefined) next[key] = current[key];
  }
  return next;
}

const RECORD_FIELDS: Readonly<Record<
  FocusSemanticRecordKind,
  Readonly<Record<string, FieldValidator>>
>> = {
  'focus-session': {
    id: stringField(240),
    mode: enumField(FOCUS_MODES),
    userActivity: stringField(4_000),
    baiyunActivity: stringField(4_000, true),
    startedAt: timestampField,
    endedAt: timestampField,
    durationSeconds: integerField(1, 100_000_000),
    quality: enumField(LEGACY_FOCUS_QUALITY_VALUES),
    heartRateAvg: numberField(0, 400),
    temperatureAvg: numberField(0, 100),
    createdAt: timestampField,
  },
  'focus-log': {
    id: stringField(240),
    sessionId: stringField(240),
    role: enumField(FOCUS_ROLES),
    content: stringField(40_000, true),
    createdAt: timestampField,
    elapsedSeconds: integerField(0, 100_000_000),
    trigger: stringField(200),
  },
  'focus-tag': {
    id: stringField(240),
    categoryId: enumField(REVIEW_CATEGORIES),
    label: (value, label) => {
      assertString(value, label, 32);
      if (!value.trim() || value !== value.trim()) throw new Error(`${label} 必须是非空、已去除首尾空白的标签名。`);
    },
    color: enumField(REVIEW_TAG_COLORS),
  },
  'focus-current-agreement': {
    sessionId: stringField(240),
    mode: enumField(FOCUS_MODES),
    userActivity: stringField(4_000),
    baiyunActivity: stringField(4_000, true),
    startedAt: timestampField,
    timerMode: enumField(TIMER_MODES),
    targetSeconds: nullableIntegerField(1, 100_000_000),
    pomodoroGoal: nullableIntegerField(1, 10_000),
    pomodoroWorkSeconds: nullableIntegerField(1, 86_400),
    pomodoroShortBreakSeconds: nullableIntegerField(1, 86_400),
    pomodoroLongBreakSeconds: nullableIntegerField(1, 86_400),
    state: (value, label) => {
      if (value !== 'active') throw new Error(`${label} 必须为 active。`);
    },
  },
  'focus-invitation': {
    id: stringField(240),
    mode: enumField(FOCUS_MODES),
    baiyunActivity: stringField(4_000, true),
    message: stringField(20_000),
    createdAt: timestampField,
    state: (value, label) => {
      if (value !== 'pending') throw new Error(`${label} 必须为 pending。`);
    },
  },
  'focus-invite-cooldown': {
    id: (value, label) => {
      if (value !== 'primary') throw new Error(`${label} 必须为 primary。`);
    },
    offeredAt: timestampField,
  },
  'companion-policy-field': {
    field: enumField(POLICY_FIELDS),
    value: integerField(1, 999),
  },
};

export function isFocusSemanticEntityType(
  value: string,
): value is FocusSemanticEntityType {
  return ENTITY_TYPES.has(value);
}

export function isFocusSemanticRecordKind(
  value: unknown,
): value is FocusSemanticRecordKind {
  return typeof value === 'string' && RECORD_KINDS.has(value);
}

export function focusSemanticEntityTypeForKind(
  kind: FocusSemanticRecordKind,
): FocusSemanticEntityType {
  if (kind === 'focus-session' || kind === 'focus-current-agreement') {
    return 'focus-session';
  }
  if (kind === 'focus-log') return 'focus-log';
  if (kind === 'focus-tag') return 'focus-tag';
  if (kind === 'focus-invitation' || kind === 'focus-invite-cooldown') {
    return 'focus-invitation';
  }
  return 'companion-policy';
}

function prefixedEntityId(prefix: string, value: unknown, label: string) {
  assertString(value, label, 256 - prefix.length);
  return `${prefix}${value}`;
}

export function focusSemanticEntityId(
  kind: FocusSemanticRecordKind,
  record: Record<string, unknown>,
) {
  if (kind === 'focus-session') {
    return prefixedEntityId('focus-session:', record.id, 'focus session id');
  }
  if (kind === 'focus-log') {
    return prefixedEntityId('focus-log:', record.id, 'focus log id');
  }
  if (kind === 'focus-tag') {
    return prefixedEntityId('focus-tag:', record.id, 'focus tag id');
  }
  if (kind === 'focus-current-agreement') {
    return 'focus-current-agreement:primary';
  }
  if (kind === 'focus-invitation') {
    return prefixedEntityId('focus-invitation:', record.id, 'focus invitation id');
  }
  if (kind === 'focus-invite-cooldown') {
    return 'focus-invite-cooldown:primary';
  }
  assertEnum(record.field, POLICY_FIELDS, 'companion policy field');
  return `companion-policy:${record.field}`;
}

export function assertFocusSemanticRecord(
  kind: FocusSemanticRecordKind,
  value: unknown,
) {
  const optional: Readonly<Record<string, FieldValidator>> = kind === 'focus-session' ? { review: assertFocusReview }
    : kind === 'focus-current-agreement' ? { reading: assertFocusReadingBinding }
    : kind === 'focus-invitation' ? {
      readingId: (entry: unknown, label: string) => { if (entry !== null) assertString(entry, label, 240); },
      readingActivityId: stringField(240),
    } : {};
  assertRecordFields(value, `${kind} record`, RECORD_FIELDS[kind], optional);
  if (kind === 'focus-session') {
    const record = recordOf(value, `${kind} record`);
    if (record.review != null) {
      const spans = recordOf(record.review, 'review').spans as Array<{ start: number; end: number }>;
      if (spans.some(span => span.start < Number(record.startedAt) || span.end > Number(record.endedAt))) {
        throw new Error('focus review 时间段必须位于本场开始与结束之间。');
      }
    }
  }
  focusSemanticEntityId(kind, recordOf(value, `${kind} record`));
}

function assertDeleteEntityId(
  kind: FocusSemanticRecordKind,
  entityId: string,
) {
  const prefixes: Readonly<Record<FocusSemanticRecordKind, string>> = {
    'focus-session': 'focus-session:',
    'focus-log': 'focus-log:',
    'focus-tag': 'focus-tag:',
    'focus-current-agreement': 'focus-current-agreement:',
    'focus-invitation': 'focus-invitation:',
    'focus-invite-cooldown': 'focus-invite-cooldown:',
    'companion-policy-field': 'companion-policy:',
  };
  const singleton = kind === 'focus-current-agreement'
    ? 'focus-current-agreement:primary'
    : kind === 'focus-invite-cooldown'
      ? 'focus-invite-cooldown:primary'
      : null;
  if (
    entityId.length > 256
    || !entityId.startsWith(prefixes[kind])
    || entityId.length === prefixes[kind].length
    || (singleton !== null && entityId !== singleton)
  ) {
    throw new Error('focus.semantic delete entity id 与 kind 不一致。');
  }
}

export function assertFocusSemanticPayload(
  entityType: FocusSemanticEntityType,
  entityId: string,
  operation: SyncOperation,
  value: unknown,
): asserts value is FocusSemanticPayloadV1 {
  const payload = recordOf(value, 'focus.semantic payload');
  const schemaValidator: FieldValidator = (field, label) => {
    if (field !== FOCUS_SEMANTIC_SCHEMA_VERSION) {
      throw new Error(`${label} 无效。`);
    }
  };
  const kindValidator: FieldValidator = (field, label) => {
    if (!isFocusSemanticRecordKind(field)) {
      throw new Error(`${label} 无效。`);
    }
  };
  if (operation === 'delete') {
    assertRecordFields(payload, 'focus.semantic delete payload', {
      schemaVersion: schemaValidator,
      kind: kindValidator,
      deletedAt: timestampField,
    });
    const kind = payload.kind as FocusSemanticRecordKind;
    if (focusSemanticEntityTypeForKind(kind) !== entityType) {
      throw new Error('focus.semantic delete entity type 与 kind 不一致。');
    }
    assertDeleteEntityId(kind, entityId);
    return;
  }
  assertRecordFields(payload, 'focus.semantic record payload', {
    schemaVersion: schemaValidator,
    kind: kindValidator,
    record: (field) => assertJsonValue(field),
  });
  const kind = payload.kind as FocusSemanticRecordKind;
  if (focusSemanticEntityTypeForKind(kind) !== entityType) {
    throw new Error('focus.semantic entity type 与 kind 不一致。');
  }
  assertFocusSemanticRecord(kind, payload.record);
  if (
    focusSemanticEntityId(
      kind,
      payload.record as Record<string, unknown>,
    ) !== entityId
  ) {
    throw new Error('focus.semantic payload identity 与 entity id 不一致。');
  }
}

export function assertFocusSemanticMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'focus'
    || !isFocusSemanticEntityType(value.entity.type)
  ) {
    throw new Error('focus.semantic mutation entity 无效。');
  }
  if (value.revision.schemaVersion !== FOCUS_SEMANTIC_SCHEMA_VERSION) {
    throw new Error('focus.semantic schemaVersion 无效。');
  }
  if (
    value.revision.operation !== 'upsert'
    && value.revision.operation !== 'restore'
    && value.revision.operation !== 'delete'
  ) {
    throw new Error('focus.semantic operation 无效。');
  }
  if (value.sensitivity !== 'high') {
    throw new Error('focus.semantic sensitivity 必须为 high。');
  }
  if (value.retentionClass !== FOCUS_SEMANTIC_RETENTION_CLASS) {
    throw new Error('focus.semantic retentionClass 无效。');
  }
  if (value.objectRefs.length) {
    throw new Error('focus.semantic 不接受对象引用。');
  }
  assertFocusSemanticPayload(
    value.entity.type,
    value.entity.id,
    value.revision.operation,
    value.payload,
  );
}

export function focusSemanticPayload(mutation: PlainMutationV1) {
  assertFocusSemanticMutationV1(mutation);
  return mutation.payload as FocusSemanticPayloadV1;
}

export function buildFocusSemanticMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: FocusSemanticEntityType;
  entityId: string;
  operation: 'upsert' | 'restore' | 'delete';
  payload: FocusSemanticPayloadV1;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'focus',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: input.operation,
      schemaVersion: FOCUS_SEMANTIC_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: input.payload,
    objectRefs: [],
    retentionClass: FOCUS_SEMANTIC_RETENTION_CLASS,
  };
  assertFocusSemanticMutationV1(mutation);
  return mutation;
}

export function focusSemanticRecordPayload(input: {
  kind: FocusSemanticRecordKind;
  record: JsonValue & Record<string, JsonValue>;
}): FocusSemanticPayloadV1 {
  assertFocusSemanticRecord(input.kind, input.record);
  return {
    schemaVersion: FOCUS_SEMANTIC_SCHEMA_VERSION,
    kind: input.kind,
    record: input.record,
  };
}

export function focusSemanticDeletePayload(input: {
  kind: FocusSemanticRecordKind;
  deletedAt: number;
}): FocusSemanticPayloadV1 {
  assertTimestamp(input.deletedAt, 'focus.semantic deletedAt');
  return {
    schemaVersion: FOCUS_SEMANTIC_SCHEMA_VERSION,
    kind: input.kind,
    deletedAt: input.deletedAt,
  };
}
