import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const PERIOD_HEALTH_ADAPTER_ID = 'period.health' as const;
export const PERIOD_HEALTH_SCHEMA_VERSION = 1 as const;
export const PERIOD_HEALTH_RETENTION_CLASS = 'health-record' as const;

export const PERIOD_HEALTH_ENTITY_TYPES = [
  'entry',
  'daily-log',
  'companion-delivery',
  'reminder-semantic',
] as const;

export const PERIOD_HEALTH_RECORD_KINDS = [
  'period-entry',
  'period-daily-log',
  'period-companion-delivery',
  'period-reminder-settings',
  'period-reminder',
] as const;

export type PeriodHealthEntityType =
  (typeof PERIOD_HEALTH_ENTITY_TYPES)[number];
export type PeriodHealthRecordKind =
  (typeof PERIOD_HEALTH_RECORD_KINDS)[number];

export type PeriodHealthEntryRecord = {
  id: string;
  startAt: number;
  endAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type PeriodHealthDailyLogRecord = {
  id: string;
  dateKey: string;
  periodId: string | null;
  bodyState: 'normal' | 'uncertain' | 'period';
  flow: 'none' | 'spotting' | 'light' | 'medium' | 'heavy';
  painLevel: number;
  symptoms: string[];
  note: string;
  createdAt: number;
  updatedAt: number;
};

// Legacy sync envelope decoding only; never captured or materialized after retirement.
export type PeriodHealthCompanionDeliveryRecord = {
  id: string;
  eventKey: string;
  periodId: string;
  dateKey: string;
  kind:
    | 'start'
    | 'pain'
    | 'night'
    | 'end'
    | 'uncertain-followup'
    | 'care-morning'
    | 'care-afternoon'
    | 'care-evening';
  status: 'pending' | 'sent' | 'failed';
  messageIds: string[];
  error: string;
  createdAt: number;
  updatedAt: number;
};

export type PeriodHealthReminderSettingsRecord = {
  id: 'global';
  careEnabled: boolean;
  careFrequency: 'standard';
  mutedDateKey: string | null;
  updatedAt: number;
};

export type PeriodHealthReminderRecord = {
  id: string;
  eventKey: string;
  kind: 'prediction' | 'supplies';
  scheduledAt: number;
  title: string;
  body: string;
  generatedByAi: boolean;
  createdAt: number;
  updatedAt: number;
};

export type PeriodHealthRecordByKind = {
  'period-entry': PeriodHealthEntryRecord;
  'period-daily-log': PeriodHealthDailyLogRecord;
  'period-companion-delivery': PeriodHealthCompanionDeliveryRecord;
  'period-reminder-settings': PeriodHealthReminderSettingsRecord;
  'period-reminder': PeriodHealthReminderRecord;
};

export type PeriodHealthRecord =
  PeriodHealthRecordByKind[PeriodHealthRecordKind];

export type PeriodHealthPayloadV1 =
  | {
      [Kind in PeriodHealthRecordKind]: {
        schemaVersion: typeof PERIOD_HEALTH_SCHEMA_VERSION;
        kind: Kind;
        record: PeriodHealthRecordByKind[Kind];
      };
    }[PeriodHealthRecordKind]
  | {
      schemaVersion: typeof PERIOD_HEALTH_SCHEMA_VERSION;
      kind: PeriodHealthRecordKind;
      deletedAt: number;
    };

type UnknownRecord = Record<string, unknown>;

const KIND_ENTITY_TYPES: Record<
  PeriodHealthRecordKind,
  PeriodHealthEntityType
> = {
  'period-entry': 'entry',
  'period-daily-log': 'daily-log',
  'period-companion-delivery': 'companion-delivery',
  'period-reminder-settings': 'reminder-semantic',
  'period-reminder': 'reminder-semantic',
};

function recordOf(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as UnknownRecord;
}

function assertExactKeys(
  record: UnknownRecord,
  expectedKeys: readonly string[],
  label: string,
) {
  const expected = new Set(expectedKeys);
  const extras = Object.keys(record).filter((key) => !expected.has(key));
  const missing = expectedKeys.filter((key) => !(key in record));
  if (extras.length || missing.length) {
    throw new Error(
      `${label} 字段无效`
      + `${extras.length ? `，多余：${extras.sort().join(', ')}` : ''}`
      + `${missing.length ? `，缺少：${missing.join(', ')}` : ''}。`,
    );
  }
}

function assertString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): asserts value is string {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || value.length > maximum
    || value.includes('\0')
  ) {
    throw new Error(`${label} 必须是有效且不超过 ${maximum} 字符的文本。`);
  }
}

function assertLocalId(value: unknown, label: string): asserts value is string {
  assertString(value, label, 220);
  if (/[\r\n]/u.test(value)) {
    throw new Error(`${label} 不能包含换行。`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertNullableTimestamp(
  value: unknown,
  label: string,
): asserts value is number | null {
  if (value !== null) assertTimestamp(value, label);
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} 必须是布尔值。`);
  }
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} 无效。`);
  }
}

function assertNullableLocalId(
  value: unknown,
  label: string,
): asserts value is string | null {
  if (value !== null) assertLocalId(value, label);
}

function assertDateKey(
  value: unknown,
  label: string,
): asserts value is string {
  assertString(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${label} 必须是 YYYY-MM-DD。`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    throw new Error(`${label} 不是有效日期。`);
  }
}

function assertNullableDateKey(
  value: unknown,
  label: string,
): asserts value is string | null {
  if (value !== null) assertDateKey(value, label);
}

function assertUniqueStringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumItemLength: number,
): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${label} 项数无效。`);
  }
  value.forEach((item, index) => (
    assertString(item, `${label}[${index}]`, maximumItemLength)
  ));
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} 不能重复。`);
  }
}

export function isPeriodHealthEntityType(
  value: unknown,
): value is PeriodHealthEntityType {
  return (
    typeof value === 'string'
    && (PERIOD_HEALTH_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

export function isPeriodHealthRecordKind(
  value: unknown,
): value is PeriodHealthRecordKind {
  return (
    typeof value === 'string'
    && (PERIOD_HEALTH_RECORD_KINDS as readonly string[]).includes(value)
  );
}

export function periodHealthEntityTypeForKind(
  kind: PeriodHealthRecordKind,
) {
  return KIND_ENTITY_TYPES[kind];
}

export function periodHealthEntityId(
  kind: PeriodHealthRecordKind,
  localId: string,
) {
  assertLocalId(localId, `period.health ${kind} local id`);
  return `${kind}:${localId}`;
}

export function periodHealthLocalId(
  kind: PeriodHealthRecordKind,
  entityId: string,
) {
  assertString(entityId, `period.health ${kind} entity id`, 256);
  const prefix = `${kind}:`;
  if (!entityId.startsWith(prefix)) {
    throw new Error(`period.health ${kind} entity id 前缀无效。`);
  }
  const localId = entityId.slice(prefix.length);
  assertLocalId(localId, `period.health ${kind} local id`);
  return localId;
}

function assertEntryRecord(
  entityId: string,
  value: unknown,
): asserts value is PeriodHealthEntryRecord {
  const record = recordOf(value, 'period entry record');
  assertExactKeys(record, [
    'id',
    'startAt',
    'endAt',
    'createdAt',
    'updatedAt',
  ], 'period entry record');
  assertLocalId(record.id, 'period entry id');
  if (periodHealthEntityId('period-entry', record.id) !== entityId) {
    throw new Error('period entry id 与 entity id 不一致。');
  }
  assertTimestamp(record.startAt, 'period entry startAt');
  assertNullableTimestamp(record.endAt, 'period entry endAt');
  assertTimestamp(record.createdAt, 'period entry createdAt');
  assertTimestamp(record.updatedAt, 'period entry updatedAt');
  if (record.endAt !== null && record.endAt < record.startAt) {
    throw new Error('period entry endAt 不能早于 startAt。');
  }
}

function assertDailyLogRecord(
  entityId: string,
  value: unknown,
): asserts value is PeriodHealthDailyLogRecord {
  const record = recordOf(value, 'period daily log record');
  assertExactKeys(record, [
    'id',
    'dateKey',
    'periodId',
    'bodyState',
    'flow',
    'painLevel',
    'symptoms',
    'note',
    'createdAt',
    'updatedAt',
  ], 'period daily log record');
  assertLocalId(record.id, 'period daily log id');
  if (periodHealthEntityId('period-daily-log', record.id) !== entityId) {
    throw new Error('period daily log id 与 entity id 不一致。');
  }
  assertDateKey(record.dateKey, 'period daily log dateKey');
  assertNullableLocalId(record.periodId, 'period daily log periodId');
  assertEnum(
    record.bodyState,
    ['normal', 'uncertain', 'period'],
    'period daily log bodyState',
  );
  assertEnum(
    record.flow,
    ['none', 'spotting', 'light', 'medium', 'heavy'],
    'period daily log flow',
  );
  if (
    typeof record.painLevel !== 'number'
    || !Number.isSafeInteger(record.painLevel)
    || record.painLevel < 0
    || record.painLevel > 5
  ) {
    throw new Error('period daily log painLevel 必须是 0–5 整数。');
  }
  assertUniqueStringArray(
    record.symptoms,
    'period daily log symptoms',
    64,
    500,
  );
  assertString(record.note, 'period daily log note', 850_000, true);
  assertTimestamp(record.createdAt, 'period daily log createdAt');
  assertTimestamp(record.updatedAt, 'period daily log updatedAt');
}

function assertCompanionDeliveryRecord(
  entityId: string,
  value: unknown,
): asserts value is PeriodHealthCompanionDeliveryRecord {
  const record = recordOf(value, 'period companion delivery record');
  assertExactKeys(record, [
    'id',
    'eventKey',
    'periodId',
    'dateKey',
    'kind',
    'status',
    'messageIds',
    'error',
    'createdAt',
    'updatedAt',
  ], 'period companion delivery record');
  assertLocalId(record.id, 'period companion delivery id');
  if (
    periodHealthEntityId('period-companion-delivery', record.id)
    !== entityId
  ) {
    throw new Error('period companion delivery id 与 entity id 不一致。');
  }
  assertString(record.eventKey, 'period companion eventKey', 1_024);
  assertLocalId(record.periodId, 'period companion periodId');
  assertDateKey(record.dateKey, 'period companion dateKey');
  assertEnum(record.kind, [
    'start',
    'pain',
    'night',
    'end',
    'uncertain-followup',
    'care-morning',
    'care-afternoon',
    'care-evening',
  ], 'period companion kind');
  assertEnum(
    record.status,
    ['pending', 'sent', 'failed'],
    'period companion status',
  );
  assertUniqueStringArray(
    record.messageIds,
    'period companion messageIds',
    64,
    256,
  );
  assertString(record.error, 'period companion error', 10_000, true);
  assertTimestamp(record.createdAt, 'period companion createdAt');
  assertTimestamp(record.updatedAt, 'period companion updatedAt');
}

function assertReminderSettingsRecord(
  entityId: string,
  value: unknown,
): asserts value is PeriodHealthReminderSettingsRecord {
  const record = recordOf(value, 'period reminder settings record');
  assertExactKeys(record, [
    'id',
    'careEnabled',
    'careFrequency',
    'mutedDateKey',
    ...('predictionEnabled' in record ? ['predictionEnabled'] : []),
    ...('suppliesEnabled' in record ? ['suppliesEnabled'] : []),
    'updatedAt',
  ], 'period reminder settings record');
  if (
    record.id !== 'global'
    || entityId !== periodHealthEntityId(
      'period-reminder-settings',
      'global',
    )
  ) {
    throw new Error('period reminder settings identity 无效。');
  }
  assertBoolean(record.careEnabled, 'period reminder settings careEnabled');
  if (record.careFrequency !== 'standard') {
    throw new Error('period reminder settings careFrequency 无效。');
  }
  assertNullableDateKey(
    record.mutedDateKey,
    'period reminder settings mutedDateKey',
  );
  // Old sync/backup input may still carry the retired flags. Validate, then
  // discard them at the existing payload boundary; current writers omit both.
  if ('predictionEnabled' in record) assertBoolean(record.predictionEnabled, 'retired predictionEnabled');
  if ('suppliesEnabled' in record) assertBoolean(record.suppliesEnabled, 'retired suppliesEnabled');
  assertTimestamp(record.updatedAt, 'period reminder settings updatedAt');
}

function assertReminderRecord(
  entityId: string,
  value: unknown,
): asserts value is PeriodHealthReminderRecord {
  const record = recordOf(value, 'period reminder record');
  assertExactKeys(record, [
    'id',
    'eventKey',
    'kind',
    'scheduledAt',
    'title',
    'body',
    'generatedByAi',
    'createdAt',
    'updatedAt',
  ], 'period reminder record');
  assertLocalId(record.id, 'period reminder id');
  if (periodHealthEntityId('period-reminder', record.id) !== entityId) {
    throw new Error('period reminder id 与 entity id 不一致。');
  }
  assertString(record.eventKey, 'period reminder eventKey', 1_024);
  assertEnum(record.kind, ['prediction', 'supplies'], 'period reminder kind');
  assertTimestamp(record.scheduledAt, 'period reminder scheduledAt');
  assertString(record.title, 'period reminder title', 100_000, true);
  assertString(record.body, 'period reminder body', 850_000, true);
  assertBoolean(record.generatedByAi, 'period reminder generatedByAi');
  assertTimestamp(record.createdAt, 'period reminder createdAt');
  assertTimestamp(record.updatedAt, 'period reminder updatedAt');
}

export function assertPeriodHealthRecord(
  kind: PeriodHealthRecordKind,
  entityId: string,
  value: unknown,
): asserts value is PeriodHealthRecord {
  if (kind === 'period-entry') {
    assertEntryRecord(entityId, value);
  } else if (kind === 'period-daily-log') {
    assertDailyLogRecord(entityId, value);
  } else if (kind === 'period-companion-delivery') {
    assertCompanionDeliveryRecord(entityId, value);
  } else if (kind === 'period-reminder-settings') {
    assertReminderSettingsRecord(entityId, value);
  } else {
    assertReminderRecord(entityId, value);
  }
}

export function assertPeriodHealthPayload(
  entityType: string,
  entityId: string,
  operation: string,
  value: unknown,
): asserts value is PeriodHealthPayloadV1 {
  if (!isPeriodHealthEntityType(entityType)) {
    throw new Error('period.health entity type 无效。');
  }
  const payload = recordOf(value, 'period.health payload');
  if (
    payload.schemaVersion !== PERIOD_HEALTH_SCHEMA_VERSION
    || !isPeriodHealthRecordKind(payload.kind)
  ) {
    throw new Error('period.health payload 版本或 kind 无效。');
  }
  if (periodHealthEntityTypeForKind(payload.kind) !== entityType) {
    throw new Error('period.health kind 与 entity type 不匹配。');
  }
  periodHealthLocalId(payload.kind, entityId);
  if (operation === 'delete') {
    assertExactKeys(
      payload,
      ['schemaVersion', 'kind', 'deletedAt'],
      'period.health delete payload',
    );
    assertTimestamp(payload.deletedAt, 'period.health deletedAt');
    return;
  }
  if (operation !== 'upsert' && operation !== 'restore') {
    throw new Error('period.health 只允许 upsert、restore 或 delete。');
  }
  assertExactKeys(
    payload,
    ['schemaVersion', 'kind', 'record'],
    'period.health record payload',
  );
  assertPeriodHealthRecord(payload.kind, entityId, payload.record);
}

export function assertPeriodHealthMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'period'
    || !isPeriodHealthEntityType(value.entity.type)
  ) {
    throw new Error('period.health mutation entity 无效。');
  }
  if (value.revision.schemaVersion !== PERIOD_HEALTH_SCHEMA_VERSION) {
    throw new Error('period.health schemaVersion 无效。');
  }
  if (
    value.revision.operation !== 'upsert'
    && value.revision.operation !== 'restore'
    && value.revision.operation !== 'delete'
  ) {
    throw new Error('period.health operation 无效。');
  }
  if (
    value.sensitivity !== 'highest'
    || value.retentionClass !== PERIOD_HEALTH_RETENTION_CLASS
  ) {
    throw new Error('period.health 最高敏留存合同无效。');
  }
  if (value.objectRefs.length !== 0) {
    throw new Error('period.health 不接受对象引用。');
  }
  assertPeriodHealthPayload(
    value.entity.type,
    value.entity.id,
    value.revision.operation,
    value.payload,
  );
}

export function periodHealthPayload(mutation: PlainMutationV1) {
  assertPeriodHealthMutationV1(mutation);
  const payload = mutation.payload as PeriodHealthPayloadV1;
  if (payload.kind === 'period-reminder-settings' && 'record' in payload) {
    const { predictionEnabled: _prediction, suppliesEnabled: _supplies, ...record } =
      payload.record as PeriodHealthReminderSettingsRecord & { predictionEnabled?: boolean; suppliesEnabled?: boolean };
    return { ...payload, record };
  }
  return payload;
}

export function periodHealthRecordPayload<Kind extends PeriodHealthRecordKind>(
  input: {
    kind: Kind;
    entityId: string;
    record: PeriodHealthRecordByKind[Kind];
  },
): PeriodHealthPayloadV1 {
  assertPeriodHealthRecord(input.kind, input.entityId, input.record);
  return {
    schemaVersion: PERIOD_HEALTH_SCHEMA_VERSION,
    kind: input.kind,
    record: input.record,
  } as PeriodHealthPayloadV1;
}

export function periodHealthDeletePayload(input: {
  kind: PeriodHealthRecordKind;
  entityId: string;
  deletedAt: number;
}): PeriodHealthPayloadV1 {
  periodHealthLocalId(input.kind, input.entityId);
  assertTimestamp(input.deletedAt, 'period.health deletedAt');
  return {
    schemaVersion: PERIOD_HEALTH_SCHEMA_VERSION,
    kind: input.kind,
    deletedAt: input.deletedAt,
  };
}

export function buildPeriodHealthMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: PeriodHealthEntityType;
  entityId: string;
  operation: 'upsert' | 'restore' | 'delete';
  payload: PeriodHealthPayloadV1;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'period',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: input.operation,
      schemaVersion: PERIOD_HEALTH_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: input.payload as JsonValue,
    objectRefs: [],
    retentionClass: PERIOD_HEALTH_RETENTION_CLASS,
  };
  assertPeriodHealthMutationV1(mutation);
  return mutation;
}
