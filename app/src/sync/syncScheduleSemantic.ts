import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export const SCHEDULE_SEMANTIC_ADAPTER_ID = 'schedule.semantic' as const;
export const SCHEDULE_SEMANTIC_SCHEMA_VERSION = 1 as const;
export const SCHEDULE_SEMANTIC_RETENTION_CLASS = 'schedule-semantic' as const;

/** An older carrier cannot erase the phone's saved plan/execution continuation. */
export function retainScheduleExecution(previous: JsonValue | undefined, incoming: JsonValue | undefined): JsonValue {
  if (!previous || Array.isArray(previous) || typeof previous !== 'object') return incoming ?? null;
  if (!incoming || Array.isArray(incoming) || typeof incoming !== 'object') return previous;
  const priorChoice = previous.readingChoice, nextChoice = incoming.readingChoice;
  const choice = priorChoice && typeof priorChoice === 'object' && !Array.isArray(priorChoice)
    && (!nextChoice || typeof nextChoice !== 'object' || Array.isArray(nextChoice)
      || priorChoice.sourceId === nextChoice.sourceId && Number(priorChoice.version ?? 0) > Number(nextChoice.version ?? 0))
    ? priorChoice : nextChoice;
  const retainChoice = (value: Record<string, JsonValue>) => choice ? { ...value, readingChoice: choice } : value;
  if ('planRevision' in previous && !('planRevision' in incoming)) return retainChoice(previous);
  if (typeof previous.planRevision === 'number' && typeof incoming.planRevision === 'number'
    && incoming.planRevision < previous.planRevision) return retainChoice(previous);
  if (previous.status !== 'planned' && incoming.status === 'planned' && previous.planRevision === incoming.planRevision) return retainChoice(previous);
  const next = { ...incoming };
  for (const key of ['planRevision', 'activityPlanRevision', 'totalPlannedMs', 'completionId', 'originOccurrenceId', 'adjustment', 'durationChange', 'resumeUnscheduled', 'estimatedEndAt']) {
    if (!(key in next) && key in previous && next.activityId === previous.activityId) next[key] = previous[key];
  }
  if (next.activityId === previous.activityId && next.planRevision === previous.planRevision) {
    if (Number(previous.updatedAt) > Number(next.updatedAt)) {
      for (const key of ['resumeUnscheduled', 'estimatedEndAt']) if (key in previous) next[key] = previous[key];
    }
    for (const key of ['elapsedMs', 'completedUnitCount']) {
      if (typeof previous[key] === 'number') next[key] = Math.max(previous[key] as number, typeof next[key] === 'number' ? next[key] as number : 0);
    }
    const old = previous.adjustment, current = next.adjustment;
    if (old && current && typeof old === 'object' && typeof current === 'object' && !Array.isArray(old) && !Array.isArray(current)
      && old.operationId === current.operationId) {
      next.adjustment = { ...old, ...current, cleanupAttempts: Math.max(Number(old.cleanupAttempts ?? 0), Number(current.cleanupAttempts ?? 0)),
        pending: old.pending === false || current.pending === false ? false : true };
    }
    const oldDuration = previous.durationChange, duration = next.durationChange;
    if (oldDuration && duration && typeof oldDuration === 'object' && typeof duration === 'object'
      && !Array.isArray(oldDuration) && !Array.isArray(duration) && oldDuration.operationId === duration.operationId) {
      next.durationChange = { ...duration, applyAttempts: Math.max(Number(oldDuration.applyAttempts ?? 0), Number(duration.applyAttempts ?? 0)),
        pending: oldDuration.pending === false || duration.pending === false ? false : true };
    }
  }
  return retainChoice(next);
}

export const SCHEDULE_SEMANTIC_ENTITY_TYPES = Object.freeze([
  'item',
  'template',
  'pending-intent',
  'alarm',
  'reminder-delivery',
] as const);

export const SCHEDULE_SEMANTIC_RECORD_KINDS = Object.freeze([
  'schedule-item',
  'schedule-occurrence',
  'day-template-instance',
  'day-template-field',
  'goal-suggestion-cooldown',
  'schedule-request',
  'alarm',
  'schedule-occurrence-delivery',
  'schedule-companion-delivery',
] as const);

export const SCHEDULE_DAY_TEMPLATE_FIELDS = Object.freeze([
  'enabled',
  'wakeEnabled',
  'sleepEnabled',
  'wakeTime',
  'sleepTime',
  'breakfast.enabled',
  'breakfast.startTime',
  'breakfast.durationMinutes',
  'lunch.enabled',
  'lunch.startTime',
  'lunch.durationMinutes',
  'dinner.enabled',
  'dinner.startTime',
  'dinner.durationMinutes',
  'nap.enabled',
  'nap.startTime',
  'nap.endTime',
  'nap.durationMinutes',
  'autoBreaks',
  'focusBreakMinutes',
  'physicalBreakMinutes',
] as const);

export const SCHEDULE_GOAL_CATEGORIES = Object.freeze([
  'study',
  'work',
  'health',
  'life',
  'social',
  'leisure',
  'creation',
  'other',
] as const);

export type ScheduleSemanticEntityType =
  typeof SCHEDULE_SEMANTIC_ENTITY_TYPES[number];
export type ScheduleSemanticRecordKind =
  typeof SCHEDULE_SEMANTIC_RECORD_KINDS[number];
export type ScheduleDayTemplateField =
  typeof SCHEDULE_DAY_TEMPLATE_FIELDS[number];
export type ScheduleGoalCategory =
  typeof SCHEDULE_GOAL_CATEGORIES[number];

export type ScheduleSemanticPayloadV1 =
  | {
      schemaVersion: 1;
      kind: ScheduleSemanticRecordKind;
      record: JsonValue & Record<string, JsonValue>;
    }
  | {
      schemaVersion: 1;
      kind: ScheduleSemanticRecordKind;
      deletedAt: number;
    };

const ENTITY_TYPES = new Set<string>(SCHEDULE_SEMANTIC_ENTITY_TYPES);
const RECORD_KINDS = new Set<string>(SCHEDULE_SEMANTIC_RECORD_KINDS);
const TEMPLATE_FIELDS = new Set<string>(SCHEDULE_DAY_TEMPLATE_FIELDS);
const GOAL_CATEGORIES = new Set<string>(SCHEDULE_GOAL_CATEGORIES);
const RECURRENCES = new Set([
  'none',
  'daily',
  'weekdays',
  'legalWorkday',
  'weekly',
  'monthly',
  'yearly',
  'lunarYearly',
]);
const ITEM_STATUSES = new Set(['pending', 'completed', 'cancelled']);
const ITEM_SOURCES = new Set(['manual', 'ai', 'habit']);
const REMINDER_INTENSITIES = new Set(['gentle', 'strong', 'blast']);
const TEMPLATE_INSTANCE_KINDS = new Set([
  'wake',
  'breakfast',
  'lunch',
  'nap',
  'dinner',
  'sleep',
]);
const ALARM_STATUSES = new Set(['pending', 'delivered', 'cancelled']);
const ALARM_SOUND_MODES = new Set(['notification', 'music', 'strong']);
const MUSIC_PLAY_STATUSES = new Set(['pending', 'played', 'failed', 'skipped']);
const STRONG_RING_STATUSES = new Set(['pending', 'started', 'failed', 'stopped']);
const STRONG_RINGTONES = new Set(['default', 'gentle', 'urgent']);
const PENDING_INTENT_STATUSES = new Set(['pending', 'consumed']);
const OCCURRENCE_DELIVERY_STATUSES = new Set([
  'pending',
  'delivered',
  'completed',
  'cancelled',
]);
const COMPANION_EVENT_KINDS = new Set(['upcoming', 'timeUp', 'followUp']);
const COMPANION_EVENT_STATUSES = new Set([
  'pending',
  'delivered',
  'responded',
  'quiet',
]);
const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DEVICE_LOCAL_URI_PATTERN = /^(?:file|content|asset-library|ph|blob):/i;

function recordOf(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
) {
  const expected = new Set(required);
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  const missing = required.filter((key) => !(key in value));
  if (extra.length || missing.length) {
    throw new Error(`${label} 字段集合无效。`);
  }
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

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是 boolean。`);
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
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
  maximum: number,
) {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) {
    throw new Error(`${label} 整数范围无效。`);
  }
}

function assertEnum(
  value: unknown,
  values: ReadonlySet<string>,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !values.has(value)) {
    throw new Error(`${label} 枚举值无效。`);
  }
}

function assertNullableEnum(
  value: unknown,
  values: ReadonlySet<string>,
  label: string,
) {
  if (value === null) return;
  assertEnum(value, values, label);
}

function assertRecurrenceRule(value: unknown) {
  const rule = recordOf(value, 'schedule recurrenceRule');
  const allowed = [
    'type',
    'weekDay',
    'monthDay',
    'month',
    'lunarMonth',
    'lunarDay',
    'lunarIsLeapMonth',
  ];
  const extra = Object.keys(rule).filter((key) => !allowed.includes(key));
  if (extra.length || !('type' in rule)) {
    throw new Error('schedule recurrenceRule 字段集合无效。');
  }
  assertEnum(rule.type, RECURRENCES, 'schedule recurrenceRule.type');
  if ('weekDay' in rule) assertInteger(rule.weekDay, 'schedule weekDay', 0, 6);
  if ('monthDay' in rule) assertInteger(rule.monthDay, 'schedule monthDay', 1, 31);
  if ('month' in rule) assertInteger(rule.month, 'schedule month', 1, 12);
  if ('lunarMonth' in rule) {
    assertInteger(rule.lunarMonth, 'schedule lunarMonth', 1, 12);
  }
  if ('lunarDay' in rule) {
    assertInteger(rule.lunarDay, 'schedule lunarDay', 1, 30);
  }
  if ('lunarIsLeapMonth' in rule) {
    assertBoolean(rule.lunarIsLeapMonth, 'schedule lunarIsLeapMonth');
  }
}

function assertScheduleItemRecord(value: unknown) {
  const item = recordOf(value, 'schedule item record');
  const hasLetterTicketEnabled = 'letterTicketEnabled' in item;
  assertExactKeys(item, [
    'id',
    'title',
    'notes',
    'startAt',
    'endAt',
    'reminderMinutesBefore',
    'recurrence',
    'recurrenceRule',
    'rangeEndAt',
    'status',
    'reminderText',
    'reminderIntensity',
    'source',
    'habitId',
    'habitAnchorKey',
    'todoId',
    'goalId',
    'planId',
    'companionEnabled',
    ...(hasLetterTicketEnabled ? ['letterTicketEnabled'] : []),
    ...['owner', 'readingId', 'execution', 'startReminderEnabled', 'endMode', 'durationMinutes', 'habitCompletionKey'].filter((key) => key in item),
    'createdAt',
    'updatedAt',
  ], 'schedule item record');
  assertString(item.id, 'schedule item id', 242);
  assertString(item.title, 'schedule item title', 1000, true);
  assertString(item.notes, 'schedule item notes', 20_000, true);
  assertTimestamp(item.startAt, 'schedule item startAt');
  assertNullableTimestamp(item.endAt, 'schedule item endAt');
  assertInteger(
    item.reminderMinutesBefore,
    'schedule item reminderMinutesBefore',
    0,
    525_600,
  );
  assertEnum(item.recurrence, RECURRENCES, 'schedule item recurrence');
  assertRecurrenceRule(item.recurrenceRule);
  assertNullableTimestamp(item.rangeEndAt, 'schedule item rangeEndAt');
  assertEnum(item.status, ITEM_STATUSES, 'schedule item status');
  assertString(item.reminderText, 'schedule item reminderText', 10_000, true);
  assertEnum(
    item.reminderIntensity,
    REMINDER_INTENSITIES,
    'schedule item reminderIntensity',
  );
  assertEnum(item.source, ITEM_SOURCES, 'schedule item source');
  if ('startReminderEnabled' in item && item.startReminderEnabled !== null) assertBoolean(item.startReminderEnabled, 'schedule item startReminderEnabled');
  if ('endMode' in item && item.endMode !== null) assertEnum(item.endMode, new Set(['duration', 'fixed']), 'schedule item endMode');
  if ('durationMinutes' in item && item.durationMinutes !== null && (typeof item.durationMinutes !== 'number' || !Number.isFinite(item.durationMinutes)
    || item.durationMinutes <= 0 || item.durationMinutes > 1_000_000)) throw new Error('schedule item durationMinutes 无效。');
  if ('habitCompletionKey' in item) assertNullableString(item.habitCompletionKey, 'schedule item habitCompletionKey', 1024);
  if ('owner' in item) assertEnum(item.owner, new Set(['I', 'you', 'I 和 you']), 'schedule item owner');
  if ('readingId' in item) assertNullableString(item.readingId, 'schedule item readingId', 256);
  if ('execution' in item && item.execution !== null) {
    const execution = recordOf(item.execution, 'schedule execution');
    if (execution.status === 'planned') {
      assertExactKeys(execution, ['status', 'updatedAt', 'planRevision', 'totalPlannedMs',
        ...['durationChange', 'resumeUnscheduled', 'estimatedEndAt', 'readingChoice'].filter(key => key in execution)], 'planned schedule execution');
      for (const key of ['updatedAt', 'planRevision', 'totalPlannedMs']) assertTimestamp(execution[key], `planned schedule execution ${key}`);
    } else {
    assertExactKeys(execution, ['activityId', 'status', 'updatedAt',
      ...['startedAt', 'endedAt', 'elapsedMs', 'completedUnitCount', 'planRevision', 'activityPlanRevision',
        'totalPlannedMs', 'completionId', 'originOccurrenceId', 'adjustment', 'durationChange', 'resumeUnscheduled', 'estimatedEndAt', 'readingChoice'].filter((key) => key in execution)], 'schedule execution');
    assertString(execution.activityId, 'schedule execution activityId', 256);
    assertEnum(execution.status, new Set(['running', 'paused', 'ended', 'completed']), 'schedule execution status');
    for (const key of ['updatedAt', 'startedAt', 'endedAt', 'elapsedMs', 'completedUnitCount', 'planRevision', 'activityPlanRevision', 'totalPlannedMs']) {
      if (key in execution) assertTimestamp(execution[key], `schedule execution ${key}`);
    }
    for (const key of ['completionId', 'originOccurrenceId']) if (key in execution) assertString(execution[key], `schedule execution ${key}`, 512);
    if ('adjustment' in execution) {
      const adjustment = recordOf(execution.adjustment, 'schedule adjustment');
      assertExactKeys(adjustment, ['operationId', 'changedAt', 'action', 'pending',
        ...('readingReplacement' in adjustment ? ['readingReplacement'] : []),
        ...('cleanupAttempts' in adjustment ? ['cleanupAttempts'] : [])], 'schedule adjustment');
      assertString(adjustment.operationId, 'schedule adjustment operationId', 512);
      assertTimestamp(adjustment.changedAt, 'schedule adjustment changedAt');
      assertEnum(adjustment.action, new Set(['reschedule', 'cancel']), 'schedule adjustment action');
      assertBoolean(adjustment.pending, 'schedule adjustment pending');
      if ('readingReplacement' in adjustment) assertBoolean(adjustment.readingReplacement, 'schedule reading replacement');
      if ('cleanupAttempts' in adjustment) {
        assertTimestamp(adjustment.cleanupAttempts, 'schedule adjustment cleanupAttempts');
        if ((adjustment.cleanupAttempts as number) > 4) throw new Error('invalid schedule adjustment cleanupAttempts');
      }
    }
    }
  }
  if (item.execution && typeof item.execution === 'object') {
    const execution = item.execution as Record<string, unknown>;
    if ('readingChoice' in execution) {
      if (item.owner !== 'I') throw new Error('invalid schedule reading choice owner');
      const choice = recordOf(execution.readingChoice, 'schedule reading choice');
      assertExactKeys(choice, ['sourceId', ...('version' in choice ? ['version', 'currentReadingId', 'nextReadingId', 'operationId'] : [])], 'schedule reading choice');
      assertString(choice.sourceId, 'schedule reading choice sourceId', 512);
      if ('version' in choice) {
        assertTimestamp(choice.version, 'schedule reading choice version');
        assertString(choice.operationId, 'schedule reading choice operationId', 512);
        assertNullableString(choice.currentReadingId, 'schedule reading choice currentReadingId', 256);
        assertNullableString(choice.nextReadingId, 'schedule reading choice nextReadingId', 256);
        if (choice.sourceId !== item.id) throw new Error('invalid schedule reading choice root');
      }
    }
    if ('resumeUnscheduled' in execution) assertBoolean(execution.resumeUnscheduled, 'schedule resumeUnscheduled');
    if ('estimatedEndAt' in execution && execution.estimatedEndAt !== null) assertTimestamp(execution.estimatedEndAt, 'schedule estimatedEndAt');
    if ('durationChange' in execution) {
      const change = recordOf(execution.durationChange, 'schedule durationChange');
      assertExactKeys(change, ['operationId', 'effectiveAt', 'elapsedMs', 'remainingMs', 'pending',
        ...('applyAttempts' in change ? ['applyAttempts'] : [])], 'schedule durationChange');
      assertString(change.operationId, 'schedule duration operationId', 512);
      for (const key of ['effectiveAt', 'elapsedMs', 'remainingMs']) assertTimestamp(change[key], `schedule duration ${key}`);
      assertBoolean(change.pending, 'schedule duration pending');
      if ('applyAttempts' in change) {
        assertTimestamp(change.applyAttempts, 'schedule duration applyAttempts');
        if (Number(change.applyAttempts) > 4) throw new Error('invalid schedule duration applyAttempts');
      }
    }
  }
  assertNullableString(item.habitId, 'schedule item habitId', 256);
  assertNullableString(item.habitAnchorKey, 'schedule item habitAnchorKey', 512);
  assertNullableString(item.todoId, 'schedule item todoId', 256);
  assertNullableString(item.goalId, 'schedule item goalId', 256);
  assertNullableString(item.planId, 'schedule item planId', 256);
  assertBoolean(item.companionEnabled, 'schedule item companionEnabled');
  if (hasLetterTicketEnabled) {
    assertBoolean(item.letterTicketEnabled, 'schedule item letterTicketEnabled');
  }
  assertTimestamp(item.createdAt, 'schedule item createdAt');
  assertTimestamp(item.updatedAt, 'schedule item updatedAt');
}

function assertScheduleOccurrenceRecord(value: unknown) {
  const occurrence = recordOf(value, 'schedule occurrence record');
  assertExactKeys(occurrence, [
    'id',
    'itemId',
    'scheduledStartAt',
    'reminderAt',
    'status',
    'completedAt',
    ...('completionRound' in occurrence ? ['completionRound'] : []),
  ], 'schedule occurrence record');
  assertString(occurrence.id, 'schedule occurrence id', 227);
  assertString(occurrence.itemId, 'schedule occurrence itemId', 242);
  assertTimestamp(
    occurrence.scheduledStartAt,
    'schedule occurrence scheduledStartAt',
  );
  assertTimestamp(occurrence.reminderAt, 'schedule occurrence reminderAt');
  assertEnum(
    occurrence.status,
    ITEM_STATUSES,
    'schedule occurrence status',
  );
  assertNullableTimestamp(
    occurrence.completedAt,
    'schedule occurrence completedAt',
  );
  if ('completionRound' in occurrence) assertInteger(occurrence.completionRound, 'schedule occurrence completionRound', 0, Number.MAX_SAFE_INTEGER);
}

export function retainScheduleOccurrenceRound(current: Record<string, JsonValue>, incoming: Record<string, JsonValue>) {
  const record = { ...incoming };
  if (Number(current.completionRound ?? 0) > Number(incoming.completionRound ?? 0)) {
    record.completionRound = current.completionRound;
    record.status = current.status;
    record.completedAt = current.completedAt;
  } else if (!('completionRound' in incoming) && 'completionRound' in current) record.completionRound = current.completionRound;
  return record;
}

function assertDayTemplateInstanceRecord(value: unknown) {
  const instance = recordOf(value, 'day template instance record');
  const { source, enabled, operationId, ...legacy } = instance;
  assertExactKeys(legacy, [
    'id',
    'dateKey',
    'kind',
    'title',
    'startAt',
    'endAt',
    'status',
    'completedAt',
    'templateHash',
    'createdAt',
    'updatedAt',
  ], 'day template instance record');
  assertString(instance.id, 'day template instance id', 234);
  assertString(instance.dateKey, 'day template instance dateKey', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(instance.dateKey as string)) {
    throw new Error('day template instance dateKey 格式无效。');
  }
  assertEnum(instance.kind, TEMPLATE_INSTANCE_KINDS, 'day template kind');
  assertString(instance.title, 'day template title', 1000, true);
  assertNullableTimestamp(instance.startAt, 'day template startAt');
  if ('source' in instance) assertEnum(source, new Set(['usual', 'day']), 'day template source');
  if ('enabled' in instance) assertBoolean(enabled, 'day template enabled');
  if ('operationId' in instance) assertNullableString(operationId, 'day template operationId', 256);
  assertNullableTimestamp(instance.endAt, 'day template endAt');
  assertEnum(instance.status, new Set(['pending', 'completed']), 'day template status');
  assertNullableTimestamp(instance.completedAt, 'day template completedAt');
  assertString(instance.templateHash, 'day template hash', 20_000);
  assertTimestamp(instance.createdAt, 'day template createdAt');
  assertTimestamp(instance.updatedAt, 'day template updatedAt');
}

function assertDayTemplateFieldValue(
  field: ScheduleDayTemplateField,
  value: unknown,
) {
  if (field.endsWith('.enabled') || field === 'enabled' || field === 'wakeEnabled' || field === 'sleepEnabled' || field === 'autoBreaks') {
    assertBoolean(value, `day template ${field}`);
    return;
  }
  if (field.endsWith('Time') || field === 'wakeTime' || field === 'sleepTime') {
    if (typeof value !== 'string' || (value !== '' && !CLOCK_PATTERN.test(value))) {
      throw new Error(`day template ${field} 时间格式无效。`);
    }
    return;
  }
  const maximum = field.endsWith('durationMinutes') ? Number.MAX_SAFE_INTEGER : 60;
  if (field.endsWith('durationMinutes') && value === null) return;
  assertInteger(value, `day template ${field}`, 0, maximum);
}

function assertDayTemplateFieldRecord(value: unknown) {
  const fieldRecord = recordOf(value, 'day template field record');
  const { operationId, ...legacy } = fieldRecord;
  assertExactKeys(
    legacy,
    ['field', 'value'],
    'day template field record',
  );
  if ('operationId' in fieldRecord) assertNullableString(operationId, 'day template operationId', 256);
  assertEnum(fieldRecord.field, TEMPLATE_FIELDS, 'day template field');
  assertDayTemplateFieldValue(
    fieldRecord.field as ScheduleDayTemplateField,
    fieldRecord.value,
  );
}

/** Old clients cannot replace an explicit routine edit with their default layout. */
export function retainDayTemplateRecord(
  kind: ScheduleSemanticRecordKind,
  previous: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
): Record<string, JsonValue> {
  if (kind === 'day-template-field' && previous.operationId && !incoming.operationId) return { ...previous };
  if (kind === 'day-template-instance') {
    if ((previous.source === 'day' || previous.operationId || previous.enabled === false)
      && !('source' in incoming) && !incoming.operationId) return { ...previous };
    return { ...incoming, source: incoming.source ?? previous.source ?? 'usual',
      enabled: incoming.enabled ?? previous.enabled ?? true,
      operationId: 'operationId' in incoming ? incoming.operationId : previous.operationId ?? null };
  }
  return { ...incoming };
}

function assertGoalSuggestionCooldownRecord(value: unknown) {
  const cooldown = recordOf(value, 'goal suggestion cooldown record');
  assertExactKeys(
    cooldown,
    ['category', 'until'],
    'goal suggestion cooldown record',
  );
  assertEnum(cooldown.category, GOAL_CATEGORIES, 'goal suggestion category');
  assertTimestamp(cooldown.until, 'goal suggestion cooldown until');
}

function assertScheduleRequestRecord(value: unknown) {
  const request = recordOf(value, 'schedule request record');
  assertExactKeys(
    request,
    ['request', 'status', 'updatedAt'],
    'schedule request record',
  );
  assertString(request.request, 'schedule request', 20_000);
  if ((request.request as string) !== (request.request as string).trim()) {
    throw new Error('schedule request 必须已经 trim。');
  }
  assertEnum(request.status, PENDING_INTENT_STATUSES, 'schedule request status');
  assertTimestamp(request.updatedAt, 'schedule request updatedAt');
}

function assertMusicSong(value: unknown) {
  if (value === null) return;
  const song = recordOf(value, 'alarm musicSong');
  assertExactKeys(
    song,
    ['id', 'name', 'artist', 'album', 'cover', 'duration'],
    'alarm musicSong',
  );
  assertString(song.id, 'alarm musicSong.id', 512);
  assertString(song.name, 'alarm musicSong.name', 1000);
  assertString(song.artist, 'alarm musicSong.artist', 1000, true);
  assertString(song.album, 'alarm musicSong.album', 1000, true);
  assertString(song.cover, 'alarm musicSong.cover', 4096, true);
  if (DEVICE_LOCAL_URI_PATTERN.test(song.cover as string)) {
    throw new Error('alarm musicSong.cover 不能包含本机 URI。');
  }
  if (
    typeof song.duration !== 'number'
    || !Number.isFinite(song.duration)
    || song.duration < 0
    || song.duration > 7 * 24 * 60 * 60 * 1000
  ) {
    throw new Error('alarm musicSong.duration 无效。');
  }
}

export function assertChatReminderMetadata(value: unknown) {
  if (value === undefined || value === null) return;
  const meta = recordOf(value, 'chat reminder metadata');
  const common = ['version', 'kind', 'revision', 'mode', 'lastOperationId', ...('note' in meta ? ['note'] : [])];
  const optional = meta.kind === 'series'
    ? ['sourceMessageId', 'nextOccurrenceId']
    : ['prepareClaim', 'preparedBody', 'chatDelivery', 'notificationEvidence', 'musicEvidence', 'terminalReason', 'musicControl'];
  const required = meta.kind === 'series'
    ? ['repeat'] : ['seriesId', 'seriesRevision', 'scheduledAt', 'attemptId', 'snoozeCount'];
  assertExactKeys(meta, [...common, ...required, ...optional.filter(key => key in meta)], 'chat reminder metadata');
  if (meta.version !== 1) throw new Error('chat reminder version 无效。');
  assertEnum(meta.kind, new Set(['series', 'occurrence']), 'chat reminder kind');
  assertEnum(meta.mode, new Set(['notification', 'music']), 'chat reminder mode');
  const count = (entry: unknown, label: string, minimum = 0) => {
    if (!Number.isSafeInteger(entry) || (entry as number) < minimum) throw new Error(`${label} 无效。`);
  };
  const text = (object: Record<string, unknown>, key: string, maximum = 10_000) => {
    if (key in object) assertString(object[key], `chat reminder ${key}`, maximum, true);
  };
  const nested = (key: string, mandatory: string[], allowed: string[]) => {
    const object = recordOf(meta[key], `chat reminder ${key}`);
    assertExactKeys(object, [...mandatory, ...allowed.filter(field => field in object)], `chat reminder ${key}`);
    return object;
  };
  count(meta.revision, 'chat reminder revision', 1);
  assertString(meta.lastOperationId, 'chat reminder operation id', 1000);
  text(meta, 'note');
  if (meta.kind === 'series') {
    text(meta, 'sourceMessageId', 1000);
    text(meta, 'nextOccurrenceId', 250);
    const repeat = recordOf(meta.repeat, 'chat reminder repeat');
    assertEnum(repeat.kind, new Set(['once', 'daily', 'weekly']), 'chat reminder repeat kind');
    assertExactKeys(repeat, repeat.kind === 'once' ? ['kind']
      : repeat.kind === 'daily' ? ['kind', 'hour', 'minute'] : ['kind', 'hour', 'minute', 'weekdays'], 'chat reminder repeat');
    if (repeat.kind !== 'once') {
      count(repeat.hour, 'chat reminder hour');
      count(repeat.minute, 'chat reminder minute');
      if ((repeat.hour as number) > 23 || (repeat.minute as number) > 59) throw new Error('chat reminder clock 无效。');
    }
    if (repeat.kind === 'weekly') {
      if (!Array.isArray(repeat.weekdays) || !repeat.weekdays.length
        || new Set(repeat.weekdays).size !== repeat.weekdays.length
        || repeat.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw new Error('chat reminder weekdays 无效。');
      }
    }
    return;
  }
  assertString(meta.seriesId, 'chat reminder series id', 250);
  count(meta.seriesRevision, 'chat reminder series revision', 1);
  assertTimestamp(meta.scheduledAt, 'chat reminder scheduledAt');
  assertString(meta.attemptId, 'chat reminder attempt id', 1000);
  count(meta.snoozeCount, 'chat reminder snooze count');
  if ('terminalReason' in meta) assertEnum(meta.terminalReason, new Set(['missed', 'permission-denied', 'outcome-unknown']), 'chat reminder terminal reason');
  if ('musicControl' in meta) {
    const control = nested('musicControl', ['operationId', 'action', 'at'], ['minutes']);
    text(control, 'operationId', 1000);
    assertEnum(control.action, new Set(['stop', 'snooze']), 'chat reminder music control');
    assertTimestamp(control.at, 'chat reminder music control at');
    if ('minutes' in control) count(control.minutes, 'chat reminder snooze minutes', 1);
  }
  if ('prepareClaim' in meta) {
    const claim = nested('prepareClaim', ['batchId', 'owner', 'claimedAt', 'conversationRevision'], []);
    text(claim, 'batchId', 1000); text(claim, 'owner', 1000); text(claim, 'conversationRevision', 1000);
    assertTimestamp(claim.claimedAt, 'chat reminder claimedAt');
  }
  if ('preparedBody' in meta) {
    const body = nested('preparedBody', ['state', 'conversationRevision', 'generatedAt'], ['body', 'source', 'error']);
    assertEnum(body.state, new Set(['ready', 'quiet', 'failed']), 'chat reminder body state');
    text(body, 'conversationRevision', 1000); text(body, 'body'); text(body, 'error');
    assertTimestamp(body.generatedAt, 'chat reminder generatedAt');
    if ('source' in body) assertEnum(body.source, new Set(['model', 'reviewed_fallback']), 'chat reminder body source');
    if (body.state === 'ready') assertString(body.body, 'chat reminder prepared body', 10_000);
  }
  if ('chatDelivery' in meta) {
    const delivery = nested('chatDelivery', ['messageId', 'body', 'deliveredAt', 'attemptId'], ['state', 'error']);
    text(delivery, 'messageId', 1000); text(delivery, 'body'); text(delivery, 'attemptId', 1000);
    assertTimestamp(delivery.deliveredAt, 'chat reminder deliveredAt');
    if ('state' in delivery) assertEnum(delivery.state, new Set(['pending', 'saved', 'failed', 'unknown']), 'chat reminder delivery state');
    text(delivery, 'error');
    if (delivery.state === 'saved' && delivery.deliveredAt === 0) throw new Error('chat reminder saved 缺少真实送达时间。');
  }
  if ('notificationEvidence' in meta) {
    const receipt = nested('notificationEvidence', ['attemptId', 'state', 'updatedAt'], ['notificationId', 'error']);
    assertEnum(receipt.state, new Set(['pending', 'scheduled', 'shown', 'failed']), 'chat reminder notification state');
    text(receipt, 'attemptId', 1000); text(receipt, 'notificationId', 1000); text(receipt, 'error');
    assertTimestamp(receipt.updatedAt, 'chat reminder notification updatedAt');
  }
  if ('musicEvidence' in meta) {
    const receipt = nested('musicEvidence', ['attemptId', 'state', 'attempts'], ['owner', 'attemptedAt', 'finishedAt', 'error']);
    assertEnum(receipt.state, new Set(['pending', 'claimed', 'played', 'failed', 'skipped']), 'chat reminder music state');
    text(receipt, 'attemptId', 1000); text(receipt, 'owner', 1000); text(receipt, 'error');
    count(receipt.attempts, 'chat reminder music attempts');
    if ('attemptedAt' in receipt) assertTimestamp(receipt.attemptedAt, 'chat reminder attemptedAt');
    if ('finishedAt' in receipt) assertTimestamp(receipt.finishedAt, 'chat reminder finishedAt');
    if (receipt.state === 'played' && (!('attemptedAt' in receipt) || !('finishedAt' in receipt))) {
      throw new Error('chat reminder played 缺少真实播放回执时间。');
    }
  }
}

function assertAlarmRecord(value: unknown) {
  const alarm = recordOf(value, 'alarm record');
  assertExactKeys(alarm, [
    'id',
    'title',
    'message',
    'triggerAt',
    'status',
    'soundMode',
    'musicKeyword',
    'musicSong',
    'musicFallbackToNotification',
    'musicPlayStatus',
    'musicPlayAttemptedAt',
    'musicPlayResultSummary',
    'musicPlayErrorMessage',
    'strongAlarmRingtone',
    'strongAlarmRingStatus',
    'strongAlarmTriggeredAt',
    'strongAlarmNotificationShown',
    'vibrate',
    'createdAt',
    'updatedAt',
    'cancelledAt',
    ...('chatReminder' in alarm ? ['chatReminder'] : []),
  ], 'alarm record');
  assertChatReminderMetadata(alarm.chatReminder);
  assertString(alarm.id, 'alarm id', 250);
  assertString(alarm.title, 'alarm title', 1000, true);
  assertString(alarm.message, 'alarm message', 10_000, true);
  assertTimestamp(alarm.triggerAt, 'alarm triggerAt');
  assertEnum(alarm.status, ALARM_STATUSES, 'alarm status');
  assertEnum(alarm.soundMode, ALARM_SOUND_MODES, 'alarm soundMode');
  assertNullableString(alarm.musicKeyword, 'alarm musicKeyword', 1000);
  assertMusicSong(alarm.musicSong);
  if (alarm.musicFallbackToNotification !== null) {
    assertBoolean(
      alarm.musicFallbackToNotification,
      'alarm musicFallbackToNotification',
    );
  }
  assertNullableEnum(alarm.musicPlayStatus, MUSIC_PLAY_STATUSES, 'alarm musicPlayStatus');
  assertNullableTimestamp(alarm.musicPlayAttemptedAt, 'alarm musicPlayAttemptedAt');
  assertNullableString(
    alarm.musicPlayResultSummary,
    'alarm musicPlayResultSummary',
    10_000,
  );
  assertNullableString(
    alarm.musicPlayErrorMessage,
    'alarm musicPlayErrorMessage',
    10_000,
  );
  assertNullableEnum(
    alarm.strongAlarmRingtone,
    STRONG_RINGTONES,
    'alarm strongAlarmRingtone',
  );
  assertNullableEnum(
    alarm.strongAlarmRingStatus,
    STRONG_RING_STATUSES,
    'alarm strongAlarmRingStatus',
  );
  assertNullableTimestamp(alarm.strongAlarmTriggeredAt, 'alarm strongAlarmTriggeredAt');
  if (alarm.strongAlarmNotificationShown !== null) {
    assertBoolean(
      alarm.strongAlarmNotificationShown,
      'alarm strongAlarmNotificationShown',
    );
  }
  if (alarm.vibrate !== null) assertBoolean(alarm.vibrate, 'alarm vibrate');
  assertTimestamp(alarm.createdAt, 'alarm createdAt');
  assertTimestamp(alarm.updatedAt, 'alarm updatedAt');
  assertNullableTimestamp(alarm.cancelledAt, 'alarm cancelledAt');
}

function assertScheduleOccurrenceDeliveryRecord(value: unknown) {
  const delivery = recordOf(value, 'schedule occurrence delivery record');
  assertExactKeys(delivery, [
    'occurrenceId',
    'scheduledAt',
    'status',
    'deliveredAt',
  ], 'schedule occurrence delivery record');
  assertString(delivery.occurrenceId, 'schedule delivery occurrenceId', 227);
  assertTimestamp(delivery.scheduledAt, 'schedule delivery scheduledAt');
  assertEnum(
    delivery.status,
    OCCURRENCE_DELIVERY_STATUSES,
    'schedule delivery status',
  );
  assertNullableTimestamp(delivery.deliveredAt, 'schedule delivery deliveredAt');
}

function assertScheduleCompanionDeliveryRecord(value: unknown) {
  const delivery = recordOf(value, 'schedule companion delivery record');
  assertExactKeys(delivery, [
    'id',
    'occurrenceId',
    'eventKind',
    'scheduledAt',
    'status',
    'deliveredAt',
    'respondedAt',
    'createdAt',
    'updatedAt',
    ...('reminderBody' in delivery ? ['reminderBody'] : []),
  ], 'schedule companion delivery record');
  assertString(delivery.id, 'schedule companion delivery id', 228);
  assertString(
    delivery.occurrenceId,
    'schedule companion occurrenceId',
    227,
  );
  assertEnum(
    delivery.eventKind,
    COMPANION_EVENT_KINDS,
    'schedule companion eventKind',
  );
  assertTimestamp(delivery.scheduledAt, 'schedule companion scheduledAt');
  assertEnum(
    delivery.status,
    COMPANION_EVENT_STATUSES,
    'schedule companion status',
  );
  assertNullableTimestamp(delivery.deliveredAt, 'schedule companion deliveredAt');
  assertNullableTimestamp(delivery.respondedAt, 'schedule companion respondedAt');
  assertTimestamp(delivery.createdAt, 'schedule companion createdAt');
  assertTimestamp(delivery.updatedAt, 'schedule companion updatedAt');
  if (delivery.reminderBody !== undefined && delivery.reminderBody !== null) {
    const reminder = recordOf(delivery.reminderBody, 'schedule reminder body');
    assertExactKeys(reminder, ['body', 'scheduledAt', 'itemUpdatedAt'], 'schedule reminder body');
    assertString(reminder.body, 'schedule reminder body text', 20_000);
    assertTimestamp(reminder.scheduledAt, 'schedule reminder body scheduledAt');
    assertTimestamp(reminder.itemUpdatedAt, 'schedule reminder body itemUpdatedAt');
    if (reminder.scheduledAt !== delivery.scheduledAt) {
      throw new Error('schedule reminder body 与提醒时间不一致。');
    }
  }
}

export function isScheduleSemanticEntityType(
  value: unknown,
): value is ScheduleSemanticEntityType {
  return typeof value === 'string' && ENTITY_TYPES.has(value);
}

export function isScheduleSemanticRecordKind(
  value: unknown,
): value is ScheduleSemanticRecordKind {
  return typeof value === 'string' && RECORD_KINDS.has(value);
}

export function scheduleSemanticEntityTypeForKind(
  kind: ScheduleSemanticRecordKind,
): ScheduleSemanticEntityType {
  if (
    kind === 'schedule-item'
    || kind === 'schedule-occurrence'
    || kind === 'day-template-instance'
  ) {
    return 'item';
  }
  if (
    kind === 'day-template-field'
    || kind === 'goal-suggestion-cooldown'
  ) {
    return 'template';
  }
  if (kind === 'schedule-request') return 'pending-intent';
  if (kind === 'alarm') return 'alarm';
  return 'reminder-delivery';
}

export function scheduleSemanticEntityId(
  kind: ScheduleSemanticRecordKind,
  record: Record<string, unknown>,
) {
  if (kind === 'schedule-item') {
    assertString(record.id, 'schedule item identity', 242);
    return `schedule-item:${record.id}`;
  }
  if (kind === 'schedule-occurrence') {
    assertString(record.id, 'schedule occurrence identity', 227);
    return `schedule-occurrence:${record.id}`;
  }
  if (kind === 'day-template-instance') {
    assertString(record.id, 'day template instance identity', 234);
    return `day-template-instance:${record.id}`;
  }
  if (kind === 'day-template-field') {
    assertEnum(record.field, TEMPLATE_FIELDS, 'day template field identity');
    return `day-template:${record.field}`;
  }
  if (kind === 'goal-suggestion-cooldown') {
    assertEnum(record.category, GOAL_CATEGORIES, 'goal cooldown identity');
    return `goal-suggestion-cooldown:${record.category}`;
  }
  if (kind === 'schedule-request') return 'schedule-request';
  if (kind === 'alarm') {
    assertString(record.id, 'alarm identity', 250);
    return `alarm:${record.id}`;
  }
  if (kind === 'schedule-occurrence-delivery') {
    assertString(record.occurrenceId, 'schedule delivery identity', 227);
    return `schedule-occurrence-delivery:${record.occurrenceId}`;
  }
  assertString(record.id, 'schedule companion delivery identity', 228);
  return `schedule-companion-delivery:${record.id}`;
}

export function assertScheduleSemanticRecord(
  kind: ScheduleSemanticRecordKind,
  value: unknown,
) {
  if (kind === 'schedule-item') return assertScheduleItemRecord(value);
  if (kind === 'schedule-occurrence') {
    return assertScheduleOccurrenceRecord(value);
  }
  if (kind === 'day-template-instance') {
    return assertDayTemplateInstanceRecord(value);
  }
  if (kind === 'day-template-field') {
    return assertDayTemplateFieldRecord(value);
  }
  if (kind === 'goal-suggestion-cooldown') {
    return assertGoalSuggestionCooldownRecord(value);
  }
  if (kind === 'schedule-request') return assertScheduleRequestRecord(value);
  if (kind === 'alarm') return assertAlarmRecord(value);
  if (kind === 'schedule-occurrence-delivery') {
    return assertScheduleOccurrenceDeliveryRecord(value);
  }
  return assertScheduleCompanionDeliveryRecord(value);
}

function assertScheduleSemanticDeleteEntityId(
  kind: ScheduleSemanticRecordKind,
  entityId: string,
) {
  const prefix = kind === 'schedule-item'
    ? 'schedule-item:'
    : kind === 'schedule-occurrence'
      ? 'schedule-occurrence:'
      : kind === 'day-template-instance'
        ? 'day-template-instance:'
        : kind === 'schedule-occurrence-delivery'
          ? 'schedule-occurrence-delivery:'
          : kind === 'schedule-companion-delivery'
            ? 'schedule-companion-delivery:'
            : null;
  const maximumLocalId = kind === 'schedule-item'
    ? 242
    : kind === 'day-template-instance'
      ? 234
      : kind === 'schedule-companion-delivery'
        ? 228
        : 227;
  if (!prefix) {
    throw new Error(`${kind} 不接受物理删除 mutation。`);
  }
  const localId = entityId.startsWith(prefix)
    ? entityId.slice(prefix.length)
    : '';
  if (!localId || localId.length > maximumLocalId) {
    throw new Error('schedule.semantic delete entity id 与 kind 不一致。');
  }
}

export function assertScheduleSemanticPayload(
  entityType: ScheduleSemanticEntityType,
  entityId: string,
  operation: SyncOperation,
  value: unknown,
): asserts value is ScheduleSemanticPayloadV1 {
  const payload = recordOf(value, 'schedule.semantic payload');
  if (operation === 'delete') {
    assertExactKeys(
      payload,
      ['schemaVersion', 'kind', 'deletedAt'],
      'schedule.semantic delete payload',
    );
    if (payload.schemaVersion !== SCHEDULE_SEMANTIC_SCHEMA_VERSION) {
      throw new Error('schedule.semantic delete schemaVersion 无效。');
    }
    if (!isScheduleSemanticRecordKind(payload.kind)) {
      throw new Error('schedule.semantic delete kind 无效。');
    }
    if (scheduleSemanticEntityTypeForKind(payload.kind) !== entityType) {
      throw new Error('schedule.semantic delete entity type 与 kind 不一致。');
    }
    assertTimestamp(payload.deletedAt, 'schedule.semantic deletedAt');
    assertScheduleSemanticDeleteEntityId(payload.kind, entityId);
    return;
  }
  assertExactKeys(
    payload,
    ['schemaVersion', 'kind', 'record'],
    'schedule.semantic record payload',
  );
  if (payload.schemaVersion !== SCHEDULE_SEMANTIC_SCHEMA_VERSION) {
    throw new Error('schedule.semantic record schemaVersion 无效。');
  }
  if (!isScheduleSemanticRecordKind(payload.kind)) {
    throw new Error('schedule.semantic record kind 无效。');
  }
  if (scheduleSemanticEntityTypeForKind(payload.kind) !== entityType) {
    throw new Error('schedule.semantic entity type 与 kind 不一致。');
  }
  assertScheduleSemanticRecord(payload.kind, payload.record);
  const identity = scheduleSemanticEntityId(
    payload.kind,
    payload.record as Record<string, unknown>,
  );
  if (identity !== entityId) {
    throw new Error('schedule.semantic payload identity 与 entity id 不一致。');
  }
}

export function assertScheduleSemanticMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'schedule'
    || !isScheduleSemanticEntityType(value.entity.type)
  ) {
    throw new Error('schedule.semantic mutation entity 无效。');
  }
  if (
    value.revision.schemaVersion !== SCHEDULE_SEMANTIC_SCHEMA_VERSION
  ) {
    throw new Error('schedule.semantic schemaVersion 无效。');
  }
  if (
    value.revision.operation !== 'upsert'
    && value.revision.operation !== 'restore'
    && value.revision.operation !== 'delete'
    && value.revision.operation !== 'append'
  ) {
    throw new Error('schedule.semantic operation 无效。');
  }
  if (value.sensitivity !== 'high') {
    throw new Error('schedule.semantic sensitivity 必须为 high。');
  }
  if (value.retentionClass !== SCHEDULE_SEMANTIC_RETENTION_CLASS) {
    throw new Error('schedule.semantic retentionClass 无效。');
  }
  if (value.objectRefs.length) {
    throw new Error('schedule.semantic 不接受对象引用。');
  }
  if (
    value.revision.operation === 'append'
    && value.entity.type !== 'reminder-delivery'
  ) {
    throw new Error('schedule.semantic append 只用于 reminder-delivery。');
  }
  assertScheduleSemanticPayload(
    value.entity.type,
    value.entity.id,
    value.revision.operation,
    value.payload,
  );
  assertJsonValue(value.payload);
}

export function scheduleSemanticPayload(
  mutation: PlainMutationV1,
) {
  assertScheduleSemanticMutationV1(mutation);
  return mutation.payload as ScheduleSemanticPayloadV1;
}

export function buildScheduleSemanticMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: ScheduleSemanticEntityType;
  entityId: string;
  operation: 'upsert' | 'restore' | 'delete' | 'append';
  payload: ScheduleSemanticPayloadV1;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'schedule',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: input.operation,
      schemaVersion: SCHEDULE_SEMANTIC_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: input.payload,
    objectRefs: [],
    retentionClass: SCHEDULE_SEMANTIC_RETENTION_CLASS,
  };
  assertScheduleSemanticMutationV1(mutation);
  return mutation;
}

export function scheduleSemanticRecordPayload(input: {
  kind: ScheduleSemanticRecordKind;
  record: JsonValue & Record<string, JsonValue>;
}): ScheduleSemanticPayloadV1 {
  assertScheduleSemanticRecord(input.kind, input.record);
  return {
    schemaVersion: SCHEDULE_SEMANTIC_SCHEMA_VERSION,
    kind: input.kind,
    record: input.record,
  };
}

export function scheduleSemanticDeletePayload(input: {
  kind: ScheduleSemanticRecordKind;
  deletedAt: number;
}): ScheduleSemanticPayloadV1 {
  assertTimestamp(input.deletedAt, 'schedule.semantic deletedAt');
  return {
    schemaVersion: SCHEDULE_SEMANTIC_SCHEMA_VERSION,
    kind: input.kind,
    deletedAt: input.deletedAt,
  };
}
