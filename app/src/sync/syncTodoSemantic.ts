import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export const TODO_SEMANTIC_ADAPTER_ID = 'todo.semantic' as const;
export const TODO_SEMANTIC_SCHEMA_VERSION = 1 as const;
export const TODO_SEMANTIC_RETENTION_CLASS = 'todo-semantic' as const;

export const TODO_SEMANTIC_ENTITY_TYPES = Object.freeze([
  'todo',
  'habit',
  'goal',
  'progress',
  'challenge',
  'review',
  'execution-session',
] as const);

export const TODO_SEMANTIC_RECORD_KINDS = Object.freeze([
  'todo-item',
  'todo-inhibit-log',
  'habit',
  'habit-log',
  'future-self',
  'goal',
  'goal-progress-event',
  'goal-time-credit-request',
  'daily-challenge',
  'day-review',
  'week-review',
  'task-execution-session',
  'task-execution-nudge',
] as const);

export type TodoSemanticEntityType =
  typeof TODO_SEMANTIC_ENTITY_TYPES[number];
export type TodoSemanticRecordKind =
  typeof TODO_SEMANTIC_RECORD_KINDS[number];

export type TodoSemanticPayloadV1 =
  | {
      schemaVersion: 1;
      kind: TodoSemanticRecordKind;
      record: JsonValue & Record<string, JsonValue>;
    }
  | {
      schemaVersion: 1;
      kind: TodoSemanticRecordKind;
      deletedAt: number;
    };

type FieldValidator = (value: unknown, label: string) => void;

const ENTITY_TYPES = new Set<string>(TODO_SEMANTIC_ENTITY_TYPES);
const RECORD_KINDS = new Set<string>(TODO_SEMANTIC_RECORD_KINDS);
const TODO_STATUSES = new Set([
  'inbox',
  'today',
  'scheduled',
  'completed',
  'cancelled',
  'expired',
]);
const TODO_SOURCES = new Set(['manual', 'ai', 'daily-challenge', 'goal']);
const PRIORITIES = new Set(['low', 'normal', 'high']);
const QUADRANTS = new Set(['q1', 'q2', 'q3', 'q4']);
const CATEGORIES = new Set([
  'study',
  'work',
  'health',
  'life',
  'social',
  'leisure',
  'creation',
  'other',
]);
const TODO_TYPES = new Set(['normal', 'inhibit']);
const REMINDER_MODES = new Set(['none', 'gentle', 'followup']);
const INHIBIT_OUTCOMES = new Set(['unrecorded', 'kept', 'slipped']);
const HABIT_FREQUENCIES = new Set(['daily', 'weekly', 'custom', 'interval']);
const HABIT_KINDS = new Set(['habit', 'daily-challenge']);
const ACTIVE_ARCHIVED = new Set(['active', 'archived']);
const LIFE_AREAS = new Set([
  'health',
  'work',
  'relationships',
  'growth',
  'leisure',
  'creation',
  'other',
]);
const GOAL_STATUSES = new Set(['active', 'completed', 'paused']);
const GOAL_TYPES = new Set(['countdown', 'time_based', 'direction']);
const GOAL_FREQUENCIES = new Set(['daily', 'weekly', 'none']);
const GOAL_PROGRESS_KINDS = new Set([
  'todo-completion',
  'todo-time-credit',
  'schedule-completion',
  'manual-adjustment',
]);
const TIME_CREDIT_STATUSES = new Set([
  'pending',
  'proposed',
  'confirmed',
  'skipped',
  'cancelled',
]);
const EXECUTION_NUDGE_KINDS = new Set([
  'timeReached',
  'stuck',
  'breakNeeded',
]);
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

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

function assertNullableString(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  if (value === null) return;
  assertString(value, label, maximumLength);
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertNullableTimestamp(value: unknown, label: string) {
  if (value === null) return;
  assertTimestamp(value, label);
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

function assertBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} 必须是 boolean。`);
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

function assertNullableDateKey(value: unknown, label: string) {
  if (value === null) return;
  assertString(value, label, 10);
  if (!DATE_KEY_PATTERN.test(value)) {
    throw new Error(`${label} 日期格式无效。`);
  }
}

function assertDateKey(value: unknown, label: string) {
  assertString(value, label, 10);
  if (!DATE_KEY_PATTERN.test(value)) {
    throw new Error(`${label} 日期格式无效。`);
  }
}

function assertStringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumItemLength: number,
  itemPattern?: RegExp,
) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${label} 数组长度无效。`);
  }
  value.forEach((item, index) => {
    assertString(item, `${label}[${index}]`, maximumItemLength);
    if (itemPattern && !itemPattern.test(item)) {
      throw new Error(`${label}[${index}] 格式无效。`);
    }
  });
}

function assertWeekDays(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > 7) {
    throw new Error(`${label} 数组长度无效。`);
  }
  const seen = new Set<number>();
  value.forEach((item, index) => {
    assertInteger(item, `${label}[${index}]`, 1, 7);
    if (seen.has(item as number)) {
      throw new Error(`${label} 不接受重复星期。`);
    }
    seen.add(item as number);
  });
}

function assertJsonObjectOrNull(value: unknown, label: string) {
  if (value === null) return;
  recordOf(value, label);
  assertJsonValue(value);
}

function assertMinutesByCategory(value: unknown, label: string) {
  const record = recordOf(value, label);
  const keys = Object.keys(record);
  if (keys.some((key) => !CATEGORIES.has(key))) {
    throw new Error(`${label} 包含未知分类。`);
  }
  for (const [key, amount] of Object.entries(record)) {
    assertInteger(amount, `${label}.${key}`, 0, 10_000_000);
  }
}

const stringField = (
  maximumLength: number,
  allowEmpty = false,
): FieldValidator => (
  value,
  label,
) => assertString(value, label, maximumLength, allowEmpty);
const nullableStringField = (
  maximumLength: number,
): FieldValidator => (
  value,
  label,
) => assertNullableString(value, label, maximumLength);
const timestampField: FieldValidator = assertTimestamp;
const nullableTimestampField: FieldValidator = assertNullableTimestamp;
const booleanField: FieldValidator = assertBoolean;
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
) {
  const record = recordOf(value, label);
  const expected = Object.keys(fields);
  const actual = Object.keys(record);
  const missing = expected.filter((key) => !(key in record));
  const extra = actual.filter((key) => !(key in fields));
  if (missing.length || extra.length) {
    throw new Error(`${label} 字段集合无效。`);
  }
  for (const [field, validator] of Object.entries(fields)) {
    validator(record[field], `${label}.${field}`);
  }
}

const TODO_ITEM_FIELDS: Readonly<Record<string, FieldValidator>> = {
  id: stringField(251),
  title: stringField(200),
  notes: stringField(4_000, true),
  status: enumField(TODO_STATUSES),
  plannedForDate: assertNullableDateKey,
  source: enumField(TODO_SOURCES),
  priority: enumField(PRIORITIES),
  quadrant: enumField(QUADRANTS),
  category: enumField(CATEGORIES),
  estimatedMinutes: nullableIntegerField(1, 1_000_000),
  trackedMinutes: integerField(0, 100_000_000),
  goalId: nullableStringField(240),
  goalContribution: integerField(0, 100_000_000),
  dueDate: assertNullableDateKey,
  challengeId: nullableStringField(240),
  habitId: nullableStringField(240),
  type: enumField(TODO_TYPES),
  inhibitActiveFrom: assertNullableDateKey,
  inhibitEndedAt: nullableTimestampField,
  postponeCount: integerField(0, 1_000_000),
  reminderMode: enumField(REMINDER_MODES),
  reminderStage: integerField(0, 1_000_000),
  lastRemindedAt: nullableTimestampField,
  createdAt: timestampField,
  updatedAt: timestampField,
  completedAt: nullableTimestampField,
};

const RECORD_FIELDS: Readonly<Record<
  TodoSemanticRecordKind,
  Readonly<Record<string, FieldValidator>>
>> = {
  'todo-item': TODO_ITEM_FIELDS,
  'todo-inhibit-log': {
    id: stringField(239),
    todoId: stringField(240),
    dateKey: assertDateKey,
    acknowledgedAt: nullableTimestampField,
    outcome: enumField(INHIBIT_OUTCOMES),
    createdAt: timestampField,
    updatedAt: timestampField,
  },
  habit: {
    id: stringField(250),
    title: stringField(200),
    goalId: nullableStringField(240),
    category: enumField(CATEGORIES),
    frequency: enumField(HABIT_FREQUENCIES),
    weekDays: assertWeekDays,
    targetCount: integerField(1, 1_000_000),
    reminderTimes: (value, label) => assertStringArray(
      value,
      label,
      24,
      5,
      CLOCK_PATTERN,
    ),
    streak: integerField(0, 1_000_000),
    bestStreak: integerField(0, 1_000_000),
    reminderTime: (value, label) => {
      if (value === null) return;
      assertString(value, label, 5);
      if (!CLOCK_PATTERN.test(value)) {
        throw new Error(`${label} 时间格式无效。`);
      }
    },
    kind: enumField(HABIT_KINDS),
    scheduleEnabled: booleanField,
    scheduleReminderMinutesBefore: integerField(0, 1_440),
    status: enumField(ACTIVE_ARCHIVED),
    createdAt: timestampField,
    updatedAt: timestampField,
  },
  'habit-log': {
    id: stringField(246),
    habitId: stringField(240),
    dateKey: assertDateKey,
    completed: booleanField,
    completedCount: integerField(0, 1_000_000),
    note: stringField(4_000, true),
    completedAt: nullableTimestampField,
    createdAt: timestampField,
    updatedAt: timestampField,
  },
  'future-self': {
    id: stringField(240),
    identityStatement: stringField(2_000, true),
    notes: stringField(20_000, true),
    updatedAt: timestampField,
  },
  goal: {
    id: stringField(251),
    title: stringField(200),
    description: stringField(20_000, true),
    lifeArea: enumField(LIFE_AREAS),
    status: enumField(GOAL_STATUSES),
    priority: enumField(PRIORITIES),
    targetDate: assertNullableDateKey,
    progress: integerField(0, 100),
    goalType: enumField(GOAL_TYPES),
    targetCount: nullableIntegerField(1, 100_000_000),
    targetUnit: nullableStringField(200),
    estimatedTotalMinutes: nullableIntegerField(1, 100_000_000),
    frequency: enumField(GOAL_FREQUENCIES),
    weekDays: assertWeekDays,
    actionTitle: nullableStringField(1_000),
    actionAmount: integerField(1, 100_000_000),
    lastDirectionCheckAt: nullableTimestampField,
    createdAt: timestampField,
    updatedAt: timestampField,
  },
  'goal-progress-event': {
    id: stringField(242),
    goalId: stringField(240),
    kind: enumField(GOAL_PROGRESS_KINDS),
    sourceId: stringField(240),
    amount: integerField(0, 100_000_000),
    note: stringField(4_000, true),
    occurredAt: timestampField,
    createdAt: timestampField,
    updatedAt: timestampField,
  },
  'goal-time-credit-request': {
    id: stringField(239),
    todoId: stringField(240),
    goalId: stringField(240),
    todoTitle: stringField(1_000),
    suggestedMinutes: nullableIntegerField(1, 100_000_000),
    reason: stringField(4_000, true),
    status: enumField(TIME_CREDIT_STATUSES),
    createdAt: timestampField,
    updatedAt: timestampField,
  },
  'daily-challenge': {
    id: stringField(246),
    title: stringField(200),
    category: enumField(CATEGORIES),
    quadrant: enumField(QUADRANTS),
    estimatedMinutes: integerField(1, 1_000_000),
    habitId: stringField(240),
    status: enumField(ACTIVE_ARCHIVED),
    createdAt: timestampField,
    updatedAt: timestampField,
  },
  'day-review': {
    id: stringField(245),
    dateKey: assertDateKey,
    summary: stringField(50_000, true),
    completedTaskTitles: (value, label) => assertStringArray(
      value,
      label,
      2_000,
      2_000,
    ),
    pendingTaskTitles: (value, label) => assertStringArray(
      value,
      label,
      2_000,
      2_000,
    ),
    minutesByCategory: assertMinutesByCategory,
    totalTrackedMinutes: integerField(0, 100_000_000),
    goalNotes: (value, label) => assertStringArray(
      value,
      label,
      2_000,
      10_000,
    ),
    habitsDone: integerField(0, 1_000_000),
    habitsTotal: integerField(0, 1_000_000),
    habitNotes: (value, label) => assertStringArray(
      value,
      label,
      2_000,
      10_000,
    ),
    baiyunMessage: stringField(100_000, true),
    metricsSnapshot: assertJsonObjectOrNull,
    comparison: assertJsonObjectOrNull,
    createdAt: timestampField,
    updatedAt: timestampField,
  },
  'week-review': {
    id: stringField(244),
    weekStart: assertDateKey,
    weekEnd: assertDateKey,
    summary: stringField(100_000, true),
    wins: (value, label) => assertStringArray(value, label, 2_000, 10_000),
    gaps: (value, label) => assertStringArray(value, label, 2_000, 10_000),
    goalProgress: (value, label) => assertStringArray(
      value,
      label,
      2_000,
      10_000,
    ),
    habitInsights: (value, label) => assertStringArray(
      value,
      label,
      2_000,
      10_000,
    ),
    nextWeekSuggestions: (value, label) => assertStringArray(
      value,
      label,
      2_000,
      10_000,
    ),
    baiyunMessage: stringField(100_000, true),
    metricsSnapshot: assertJsonObjectOrNull,
    comparison: assertJsonObjectOrNull,
    createdAt: timestampField,
    updatedAt: timestampField,
  },
  'task-execution-session': {
    id: stringField(233),
    todoId: stringField(240),
    status: (value, label) => {
      if (value !== 'finished') {
        throw new Error(`${label} 只接受已冻结或完成的执行历史。`);
      }
    },
    startedAt: timestampField,
    pausedAt: (value, label) => {
      if (value !== null) {
        throw new Error(`${label} 必须为 null。`);
      }
    },
    endedAt: timestampField,
    accumulatedSeconds: integerField(0, 10_000_000_000),
    createdAt: timestampField,
    updatedAt: timestampField,
  },
  'task-execution-nudge': {
    sessionId: stringField(220),
    todoId: stringField(240),
    kind: enumField(EXECUTION_NUDGE_KINDS),
    createdAt: timestampField,
    deliveredAt: nullableTimestampField,
  },
};

export function isTodoSemanticEntityType(
  value: string,
): value is TodoSemanticEntityType {
  return ENTITY_TYPES.has(value);
}

export function isTodoSemanticRecordKind(
  value: unknown,
): value is TodoSemanticRecordKind {
  return typeof value === 'string' && RECORD_KINDS.has(value);
}

export function todoSemanticEntityTypeForKind(
  kind: TodoSemanticRecordKind,
): TodoSemanticEntityType {
  if (kind === 'todo-item' || kind === 'todo-inhibit-log') return 'todo';
  if (kind === 'habit' || kind === 'habit-log') return 'habit';
  if (kind === 'future-self' || kind === 'goal') return 'goal';
  if (
    kind === 'goal-progress-event'
    || kind === 'goal-time-credit-request'
  ) {
    return 'progress';
  }
  if (kind === 'daily-challenge') return 'challenge';
  if (kind === 'day-review' || kind === 'week-review') return 'review';
  return 'execution-session';
}

function prefixedEntityId(
  prefix: string,
  localId: unknown,
  label: string,
) {
  assertString(localId, label, 256 - prefix.length);
  return `${prefix}${localId}`;
}

export function todoSemanticEntityId(
  kind: TodoSemanticRecordKind,
  record: Record<string, unknown>,
) {
  if (kind === 'todo-item') {
    return prefixedEntityId('todo:', record.id, 'todo identity');
  }
  if (kind === 'todo-inhibit-log') {
    return prefixedEntityId(
      'todo-inhibit-log:',
      record.id,
      'todo inhibit log identity',
    );
  }
  if (kind === 'habit') {
    return prefixedEntityId('habit:', record.id, 'habit identity');
  }
  if (kind === 'habit-log') {
    return prefixedEntityId('habit-log:', record.id, 'habit log identity');
  }
  if (kind === 'future-self') {
    if (record.id !== 'primary') {
      throw new Error('future-self identity 必须为 primary。');
    }
    return 'future-self:primary';
  }
  if (kind === 'goal') {
    return prefixedEntityId('goal:', record.id, 'goal identity');
  }
  if (kind === 'goal-progress-event') {
    return prefixedEntityId(
      'goal-progress:',
      record.id,
      'goal progress identity',
    );
  }
  if (kind === 'goal-time-credit-request') {
    return prefixedEntityId(
      'goal-time-credit:',
      record.id,
      'goal time credit identity',
    );
  }
  if (kind === 'daily-challenge') {
    return prefixedEntityId(
      'challenge:',
      record.id,
      'daily challenge identity',
    );
  }
  if (kind === 'day-review') {
    return prefixedEntityId('day-review:', record.id, 'day review identity');
  }
  if (kind === 'week-review') {
    return prefixedEntityId(
      'week-review:',
      record.id,
      'week review identity',
    );
  }
  if (kind === 'task-execution-session') {
    return prefixedEntityId(
      'task-execution:',
      record.id,
      'task execution identity',
    );
  }
  assertString(record.sessionId, 'task execution nudge session identity', 220);
  assertEnum(
    record.kind,
    EXECUTION_NUDGE_KINDS,
    'task execution nudge kind identity',
  );
  const id = `task-execution-nudge:${record.sessionId}:${record.kind}`;
  if (id.length > 256) {
    throw new Error('task execution nudge identity 长度无效。');
  }
  return id;
}

export function assertTodoSemanticRecord(
  kind: TodoSemanticRecordKind,
  value: unknown,
) {
  const record = recordOf(value, `${kind} record`);
  const optional: Readonly<Record<string, FieldValidator>> = kind === 'habit' ? {
    owner: enumField(new Set(['I', 'you'])),
    frequencyPeriod: enumField(new Set(['legacy', 'day', 'week', 'weekdays'])),
    minutes: nullableIntegerField(1, 1_000_000),
    notes: (value, label) => { if (value !== null) assertString(value, label, 20_000, true); },
    intervalDays: nullableIntegerField(1, 1_000_000),
    scheduleInstances: (value, label) => {
      const settings = recordOf(value, label);
      const fields: Record<string, FieldValidator> = {
        startAt: nullableTimestampField, ruleUpdatedAt: nullableTimestampField,
        endMode: (value, label) => { if (value !== null) assertEnum(value, new Set(['duration', 'fixed']), label); }, endAt: nullableTimestampField,
        durationMinutes: (minutes, field) => {
          if (minutes !== null && (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || minutes > 1_000_000)) throw new Error(`${field} 无效。`);
        },
        startReminderEnabled: (value, label) => { if (value !== null) assertBoolean(value, label); },
        companionEnabled: (value, label) => { if (value !== null) assertBoolean(value, label); },
      };
      assertRecordFields(settings, label, Object.fromEntries(Object.entries(fields).filter(([key]) => key in settings)));
    },
  } : kind === 'todo-item' ? {
    completionRound: (value, label) => assertInteger(value, label, 0, Number.MAX_SAFE_INTEGER),
    parentTodoId: nullableStringField(240),
    parentOccurrenceId: nullableStringField(512),
    stepOrder: nullableIntegerField(1, 1_000_000),
  } : kind === 'habit-log' ? {
    completionActivityIds: (ids, label) => assertStringArray(ids, label, 1_000_000, 240),
  } : {};
  assertRecordFields(value, `${kind} record`, { ...RECORD_FIELDS[kind],
    ...Object.fromEntries(Object.entries(optional).filter(([key]) => key in record)),
  });
  if (kind === 'habit' && record.frequency === 'interval' && record.intervalDays == null) throw new Error('interval habit 缺少 intervalDays。');
  todoSemanticEntityId(kind, recordOf(value, `${kind} record`));
}

export function preserveOwnHabitFields(kind: TodoSemanticRecordKind, current: Record<string, JsonValue>, incoming: Record<string, JsonValue>) {
  const result = { ...incoming };
  for (const field of kind === 'habit' ? ['owner', 'frequencyPeriod', 'minutes', 'notes', 'intervalDays', 'scheduleInstances']
    : kind === 'todo-item' ? ['parentTodoId', 'parentOccurrenceId', 'stepOrder']
    : kind === 'habit-log' ? ['completionActivityIds'] : []) {
    if (!(field in incoming) && field in current) result[field] = current[field];
  }
  if (kind === 'habit') {
    if (current.frequency === 'interval' && !('intervalDays' in incoming)) result.frequency = 'interval';
    if (current.scheduleInstances && typeof current.scheduleInstances === 'object' && !Array.isArray(current.scheduleInstances)
      && incoming.scheduleInstances && typeof incoming.scheduleInstances === 'object' && !Array.isArray(incoming.scheduleInstances)) {
      result.scheduleInstances = { ...current.scheduleInstances, ...incoming.scheduleInstances };
    }
  }
  if (kind === 'habit' && current.owner === 'I' && current.status === 'archived' && !('owner' in incoming)) result.status = 'archived';
  if (kind === 'todo-item' && Number(current.completionRound ?? 0) > Number(incoming.completionRound ?? 0)) {
    result.completionRound = current.completionRound;
    result.status = current.status;
    result.completedAt = current.completedAt;
  } else if (kind === 'todo-item' && !('completionRound' in incoming) && 'completionRound' in current) {
    result.completionRound = current.completionRound;
  }
  if (kind === 'habit-log' && Array.isArray(current.completionActivityIds) && current.completionActivityIds.length) {
    const ids = [...new Set([...current.completionActivityIds, ...(Array.isArray(incoming.completionActivityIds) ? incoming.completionActivityIds : [])])].sort();
    result.completionActivityIds = ids;
    result.completedCount = Math.max(Number(current.completedCount), Number(incoming.completedCount), ids.length);
    result.completed = current.completed === true || incoming.completed === true;
    result.completedAt = Math.max(Number(current.completedAt), Number(incoming.completedAt)) || null;
  }
  return result;
}

function assertDeleteEntityId(
  kind: TodoSemanticRecordKind,
  entityId: string,
) {
  const prefixes: Readonly<Record<TodoSemanticRecordKind, string>> = {
    'todo-item': 'todo:',
    'todo-inhibit-log': 'todo-inhibit-log:',
    habit: 'habit:',
    'habit-log': 'habit-log:',
    'future-self': 'future-self:',
    goal: 'goal:',
    'goal-progress-event': 'goal-progress:',
    'goal-time-credit-request': 'goal-time-credit:',
    'daily-challenge': 'challenge:',
    'day-review': 'day-review:',
    'week-review': 'week-review:',
    'task-execution-session': 'task-execution:',
    'task-execution-nudge': 'task-execution-nudge:',
  };
  const prefix = prefixes[kind];
  if (
    entityId.length > 256
    || !entityId.startsWith(prefix)
    || entityId.length === prefix.length
    || (kind === 'future-self' && entityId !== 'future-self:primary')
  ) {
    throw new Error('todo.semantic delete entity id 与 kind 不一致。');
  }
}

export function assertTodoSemanticPayload(
  entityType: TodoSemanticEntityType,
  entityId: string,
  operation: SyncOperation,
  value: unknown,
): asserts value is TodoSemanticPayloadV1 {
  const payload = recordOf(value, 'todo.semantic payload');
  if (operation === 'delete') {
    assertRecordFields(payload, 'todo.semantic delete payload', {
      schemaVersion: (field, label) => {
        if (field !== TODO_SEMANTIC_SCHEMA_VERSION) {
          throw new Error(`${label} 无效。`);
        }
      },
      kind: (field, label) => {
        if (!isTodoSemanticRecordKind(field)) {
          throw new Error(`${label} 无效。`);
        }
      },
      deletedAt: timestampField,
    });
    const kind = payload.kind as TodoSemanticRecordKind;
    if (todoSemanticEntityTypeForKind(kind) !== entityType) {
      throw new Error('todo.semantic delete entity type 与 kind 不一致。');
    }
    assertDeleteEntityId(kind, entityId);
    return;
  }
  assertRecordFields(payload, 'todo.semantic record payload', {
    schemaVersion: (field, label) => {
      if (field !== TODO_SEMANTIC_SCHEMA_VERSION) {
        throw new Error(`${label} 无效。`);
      }
    },
    kind: (field, label) => {
      if (!isTodoSemanticRecordKind(field)) {
        throw new Error(`${label} 无效。`);
      }
    },
    record: (field) => assertJsonValue(field),
  });
  const kind = payload.kind as TodoSemanticRecordKind;
  if (todoSemanticEntityTypeForKind(kind) !== entityType) {
    throw new Error('todo.semantic entity type 与 kind 不一致。');
  }
  assertTodoSemanticRecord(kind, payload.record);
  const identity = todoSemanticEntityId(
    kind,
    payload.record as Record<string, unknown>,
  );
  if (identity !== entityId) {
    throw new Error('todo.semantic payload identity 与 entity id 不一致。');
  }
}

export function assertTodoSemanticMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'todo'
    || !isTodoSemanticEntityType(value.entity.type)
  ) {
    throw new Error('todo.semantic mutation entity 无效。');
  }
  if (value.revision.schemaVersion !== TODO_SEMANTIC_SCHEMA_VERSION) {
    throw new Error('todo.semantic schemaVersion 无效。');
  }
  if (
    value.revision.operation !== 'upsert'
    && value.revision.operation !== 'restore'
    && value.revision.operation !== 'delete'
  ) {
    throw new Error('todo.semantic operation 无效。');
  }
  if (value.sensitivity !== 'high') {
    throw new Error('todo.semantic sensitivity 必须为 high。');
  }
  if (value.retentionClass !== TODO_SEMANTIC_RETENTION_CLASS) {
    throw new Error('todo.semantic retentionClass 无效。');
  }
  if (value.objectRefs.length) {
    throw new Error('todo.semantic 不接受对象引用。');
  }
  assertTodoSemanticPayload(
    value.entity.type,
    value.entity.id,
    value.revision.operation,
    value.payload,
  );
  assertJsonValue(value.payload);
}

export function todoSemanticPayload(mutation: PlainMutationV1) {
  assertTodoSemanticMutationV1(mutation);
  return mutation.payload as TodoSemanticPayloadV1;
}

export function buildTodoSemanticMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: TodoSemanticEntityType;
  entityId: string;
  operation: 'upsert' | 'restore' | 'delete';
  payload: TodoSemanticPayloadV1;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'todo',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: input.operation,
      schemaVersion: TODO_SEMANTIC_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: input.payload,
    objectRefs: [],
    retentionClass: TODO_SEMANTIC_RETENTION_CLASS,
  };
  assertTodoSemanticMutationV1(mutation);
  return mutation;
}

export function todoSemanticRecordPayload(input: {
  kind: TodoSemanticRecordKind;
  record: JsonValue & Record<string, JsonValue>;
}): TodoSemanticPayloadV1 {
  assertTodoSemanticRecord(input.kind, input.record);
  return {
    schemaVersion: TODO_SEMANTIC_SCHEMA_VERSION,
    kind: input.kind,
    record: input.record,
  };
}

export function todoSemanticDeletePayload(input: {
  kind: TodoSemanticRecordKind;
  deletedAt: number;
}): TodoSemanticPayloadV1 {
  assertTimestamp(input.deletedAt, 'todo.semantic deletedAt');
  return {
    schemaVersion: TODO_SEMANTIC_SCHEMA_VERSION,
    kind: input.kind,
    deletedAt: input.deletedAt,
  };
}
