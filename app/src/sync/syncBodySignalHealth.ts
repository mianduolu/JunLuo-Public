import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertSyncUuidV4,
  type SyncPlatform,
} from './syncDeviceContract';
import {
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const BODY_SIGNAL_HEALTH_ADAPTER_ID =
  'body-signal.health' as const;
export const BODY_SIGNAL_HEALTH_SCHEMA_VERSION = 1 as const;
export const BODY_SIGNAL_RAW_RETENTION_CLASS =
  'body-signal-raw-365d' as const;
export const BODY_SIGNAL_DERIVED_RETENTION_CLASS =
  'health-record' as const;
export const BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS = 3;
export const BODY_SIGNAL_DAILY_SUMMARY_RETENTION_DAYS = 7;

export const BODY_SIGNAL_HEALTH_ENTITY_TYPES = [
  'reading',
  'care-summary',
  'collection-policy',
] as const;

export const BODY_SIGNAL_HEALTH_RECORD_KINDS = [
  'body-signal-reading',
  'body-signal-care-summary',
  'body-signal-collection-policy',
] as const;

export type BodySignalHealthEntityType =
  (typeof BODY_SIGNAL_HEALTH_ENTITY_TYPES)[number];
export type BodySignalHealthRecordKind =
  (typeof BODY_SIGNAL_HEALTH_RECORD_KINDS)[number];
export type BodySignalHealthKind =
  | 'battery'
  | 'heart_rate'
  | 'hrv'
  | 'spo2'
  | 'stress';
export type BodySignalHealthProvider =
  | 'colmi_rxx'
  | 'smarthealth_r99'
  | 'standard_gatt'
  | 'mi_band_6'
  | 'unknown';
export type BodySignalHealthConfidence =
  | 'high'
  | 'low'
  | 'medium'
  | 'unknown';
export type BodySignalClockConfidence =
  | 'app-clock'
  | 'device-clock'
  | 'unknown';
export type BodySignalSamplingMethod =
  | 'ble-live'
  | 'ble-single'
  | 'imported'
  | 'manual'
  | 'unknown';

export type BodySignalHealthReadingRecord = {
  id: string;
  kind: BodySignalHealthKind;
  value: number;
  unit: string;
  measuredAt: number;
  receivedAt: number;
  originDeviceId: string;
  originPlatform: SyncPlatform;
  sourceProvider: BodySignalHealthProvider;
  sourceDeviceAlias: string | null;
  confidence: BodySignalHealthConfidence;
  clockConfidence: BodySignalClockConfidence;
  samplingMethod: BodySignalSamplingMethod;
  retentionUntil: number;
  createdAt: number;
};

export type BodySignalHealthCareSummaryRecord = {
  id: string;
  dateKey: string;
  kind: BodySignalHealthKind;
  originDeviceId: string;
  originPlatform: SyncPlatform;
  sourceScope: 'origin-device';
  sampleCount: number;
  average: number;
  minimum: number;
  maximum: number;
  firstMeasuredAt: number;
  lastMeasuredAt: number;
  generatedAt: number;
  updatedAt: number;
};

export type BodySignalHealthCollectionPolicyRecord = {
  id: 'global';
  autoMeasureAfterReconnect: boolean;
  autoReconnectEnabled: boolean;
  preferredDeviceAlias: string | null;
  rawRetentionDays: number;
  updatedAt: number;
};

export type BodySignalHealthRecordByKind = {
  'body-signal-reading': BodySignalHealthReadingRecord;
  'body-signal-care-summary': BodySignalHealthCareSummaryRecord;
  'body-signal-collection-policy': BodySignalHealthCollectionPolicyRecord;
};

export type BodySignalHealthRecord =
  BodySignalHealthRecordByKind[BodySignalHealthRecordKind];

export type BodySignalHealthPayloadV1 =
  | {
      [Kind in BodySignalHealthRecordKind]: {
        schemaVersion: typeof BODY_SIGNAL_HEALTH_SCHEMA_VERSION;
        kind: Kind;
        record: BodySignalHealthRecordByKind[Kind];
      };
    }[BodySignalHealthRecordKind]
  | {
      schemaVersion: typeof BODY_SIGNAL_HEALTH_SCHEMA_VERSION;
      kind: BodySignalHealthRecordKind;
      deletedAt: number;
    };

type UnknownRecord = Record<string, unknown>;

const KIND_ENTITY_TYPES: Record<
  BodySignalHealthRecordKind,
  BodySignalHealthEntityType
> = {
  'body-signal-reading': 'reading',
  'body-signal-care-summary': 'care-summary',
  'body-signal-collection-policy': 'collection-policy',
};

const MAC_ADDRESS_PATTERN =
  /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/iu;

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

function assertFiniteNumber(
  value: unknown,
  label: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} 必须是有限数值。`);
  }
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

function assertDateKey(value: unknown, label: string): asserts value is string {
  assertString(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${label} 必须是 YYYY-MM-DD。`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`${label} 不是有效日期。`);
  }
}

function assertDeviceAlias(
  value: unknown,
  label: string,
): asserts value is string | null {
  if (value === null) return;
  assertString(value, label, 120);
  if (MAC_ADDRESS_PATTERN.test(value.trim())) {
    throw new Error(`${label} 不能是 BLE/MAC 地址。`);
  }
}

function assertPlatform(
  value: unknown,
  label: string,
): asserts value is SyncPlatform {
  assertEnum(value, ['android', 'windows'], label);
}

function assertKindValue(
  kind: BodySignalHealthKind,
  value: number,
  unit: string,
) {
  const contracts: Record<
    BodySignalHealthKind,
    { minimum: number; maximum: number; unit: string }
  > = {
    battery: { minimum: 0, maximum: 100, unit: '%' },
    heart_rate: { minimum: 1, maximum: 300, unit: 'bpm' },
    hrv: { minimum: 0, maximum: 10_000, unit: 'ms' },
    spo2: { minimum: 0, maximum: 100, unit: '%' },
    stress: { minimum: 0, maximum: 100, unit: 'score' },
  };
  const contract = contracts[kind];
  if (
    value < contract.minimum
    || value > contract.maximum
    || unit !== contract.unit
  ) {
    throw new Error(`body signal ${kind} 数值或单位无效。`);
  }
}

export function isBodySignalHealthEntityType(
  value: unknown,
): value is BodySignalHealthEntityType {
  return (
    typeof value === 'string'
    && (BODY_SIGNAL_HEALTH_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

export function isBodySignalHealthRecordKind(
  value: unknown,
): value is BodySignalHealthRecordKind {
  return (
    typeof value === 'string'
    && (BODY_SIGNAL_HEALTH_RECORD_KINDS as readonly string[]).includes(value)
  );
}

export function bodySignalHealthEntityTypeForKind(
  kind: BodySignalHealthRecordKind,
) {
  return KIND_ENTITY_TYPES[kind];
}

export function bodySignalHealthEntityId(
  kind: BodySignalHealthRecordKind,
  localId: string,
) {
  assertLocalId(localId, `body-signal.health ${kind} local id`);
  return `${kind}:${localId}`;
}

export function bodySignalHealthLocalId(
  kind: BodySignalHealthRecordKind,
  entityId: string,
) {
  assertString(entityId, `body-signal.health ${kind} entity id`, 256);
  const prefix = `${kind}:`;
  if (!entityId.startsWith(prefix)) {
    throw new Error(`body-signal.health ${kind} entity id 前缀无效。`);
  }
  const localId = entityId.slice(prefix.length);
  assertLocalId(localId, `body-signal.health ${kind} local id`);
  return localId;
}

export function bodySignalCareSummaryId(input: {
  dateKey: string;
  kind: BodySignalHealthKind;
  originDeviceId: string;
}) {
  assertDateKey(input.dateKey, 'body signal care summary dateKey');
  assertSyncUuidV4(input.originDeviceId, 'body signal care summary originDeviceId');
  return `${input.kind}:${input.originDeviceId}:${input.dateKey}`;
}

function assertReadingRecord(
  entityId: string,
  value: unknown,
): asserts value is BodySignalHealthReadingRecord {
  const record = recordOf(value, 'body signal reading record');
  assertExactKeys(record, [
    'id',
    'kind',
    'value',
    'unit',
    'measuredAt',
    'receivedAt',
    'originDeviceId',
    'originPlatform',
    'sourceProvider',
    'sourceDeviceAlias',
    'confidence',
    'clockConfidence',
    'samplingMethod',
    'retentionUntil',
    'createdAt',
  ], 'body signal reading record');
  assertLocalId(record.id, 'body signal reading id');
  if (bodySignalHealthEntityId('body-signal-reading', record.id) !== entityId) {
    throw new Error('body signal reading id 与 entity id 不一致。');
  }
  assertEnum(record.kind, [
    'battery',
    'heart_rate',
    'hrv',
    'spo2',
    'stress',
  ], 'body signal reading kind');
  assertFiniteNumber(record.value, 'body signal reading value');
  assertString(record.unit, 'body signal reading unit', 32);
  assertKindValue(record.kind, record.value, record.unit);
  assertTimestamp(record.measuredAt, 'body signal reading measuredAt');
  assertTimestamp(record.receivedAt, 'body signal reading receivedAt');
  assertTimestamp(record.createdAt, 'body signal reading createdAt');
  assertTimestamp(record.retentionUntil, 'body signal reading retentionUntil');
  if (record.measuredAt > record.receivedAt + 86_400_000) {
    throw new Error('body signal reading measuredAt 不能明显晚于 receivedAt。');
  }
  if (record.retentionUntil <= record.measuredAt) {
    throw new Error('body signal reading retentionUntil 必须晚于 measuredAt。');
  }
  assertSyncUuidV4(record.originDeviceId, 'body signal reading originDeviceId');
  assertPlatform(record.originPlatform, 'body signal reading originPlatform');
  assertEnum(record.sourceProvider, [
    'colmi_rxx',
    'smarthealth_r99',
    'standard_gatt',
    'mi_band_6',
    'unknown',
  ], 'body signal reading sourceProvider');
  assertDeviceAlias(
    record.sourceDeviceAlias,
    'body signal reading sourceDeviceAlias',
  );
  assertEnum(record.confidence, [
    'high',
    'low',
    'medium',
    'unknown',
  ], 'body signal reading confidence');
  assertEnum(record.clockConfidence, [
    'app-clock',
    'device-clock',
    'unknown',
  ], 'body signal reading clockConfidence');
  assertEnum(record.samplingMethod, [
    'ble-live',
    'ble-single',
    'imported',
    'manual',
    'unknown',
  ], 'body signal reading samplingMethod');
}

function assertCareSummaryRecord(
  entityId: string,
  value: unknown,
): asserts value is BodySignalHealthCareSummaryRecord {
  const record = recordOf(value, 'body signal care summary record');
  assertExactKeys(record, [
    'id',
    'dateKey',
    'kind',
    'originDeviceId',
    'originPlatform',
    'sourceScope',
    'sampleCount',
    'average',
    'minimum',
    'maximum',
    'firstMeasuredAt',
    'lastMeasuredAt',
    'generatedAt',
    'updatedAt',
  ], 'body signal care summary record');
  assertDateKey(record.dateKey, 'body signal care summary dateKey');
  assertEnum(record.kind, [
    'battery',
    'heart_rate',
    'hrv',
    'spo2',
    'stress',
  ], 'body signal care summary kind');
  assertSyncUuidV4(
    record.originDeviceId,
    'body signal care summary originDeviceId',
  );
  assertPlatform(
    record.originPlatform,
    'body signal care summary originPlatform',
  );
  if (record.sourceScope !== 'origin-device') {
    throw new Error('body signal care summary sourceScope 无效。');
  }
  const expectedId = bodySignalCareSummaryId({
    dateKey: record.dateKey,
    kind: record.kind,
    originDeviceId: record.originDeviceId,
  });
  if (
    record.id !== expectedId
    || bodySignalHealthEntityId(
      'body-signal-care-summary',
      record.id,
    ) !== entityId
  ) {
    throw new Error('body signal care summary identity 无效。');
  }
  if (
    typeof record.sampleCount !== 'number'
    || !Number.isSafeInteger(record.sampleCount)
    || record.sampleCount < 1
  ) {
    throw new Error('body signal care summary sampleCount 必须是正整数。');
  }
  assertFiniteNumber(record.average, 'body signal care summary average');
  assertFiniteNumber(record.minimum, 'body signal care summary minimum');
  assertFiniteNumber(record.maximum, 'body signal care summary maximum');
  if (
    record.minimum > record.average
    || record.average > record.maximum
  ) {
    throw new Error('body signal care summary 数值范围无效。');
  }
  assertKindValue(record.kind, record.minimum, unitForKind(record.kind));
  assertKindValue(record.kind, record.average, unitForKind(record.kind));
  assertKindValue(record.kind, record.maximum, unitForKind(record.kind));
  assertTimestamp(
    record.firstMeasuredAt,
    'body signal care summary firstMeasuredAt',
  );
  assertTimestamp(
    record.lastMeasuredAt,
    'body signal care summary lastMeasuredAt',
  );
  assertTimestamp(record.generatedAt, 'body signal care summary generatedAt');
  assertTimestamp(record.updatedAt, 'body signal care summary updatedAt');
  if (record.firstMeasuredAt > record.lastMeasuredAt) {
    throw new Error('body signal care summary 时间范围无效。');
  }
}

function unitForKind(kind: BodySignalHealthKind) {
  if (kind === 'heart_rate') return 'bpm';
  if (kind === 'hrv') return 'ms';
  if (kind === 'stress') return 'score';
  return '%';
}

function assertCollectionPolicyRecord(
  entityId: string,
  value: unknown,
): asserts value is BodySignalHealthCollectionPolicyRecord {
  const record = recordOf(value, 'body signal collection policy record');
  assertExactKeys(record, [
    'id',
    'autoMeasureAfterReconnect',
    'autoReconnectEnabled',
    'preferredDeviceAlias',
    'rawRetentionDays',
    'updatedAt',
  ], 'body signal collection policy record');
  if (
    record.id !== 'global'
    || entityId !== bodySignalHealthEntityId(
      'body-signal-collection-policy',
      'global',
    )
  ) {
    throw new Error('body signal collection policy identity 无效。');
  }
  assertBoolean(
    record.autoMeasureAfterReconnect,
    'body signal collection policy autoMeasureAfterReconnect',
  );
  assertBoolean(
    record.autoReconnectEnabled,
    'body signal collection policy autoReconnectEnabled',
  );
  assertDeviceAlias(
    record.preferredDeviceAlias,
    'body signal collection policy preferredDeviceAlias',
  );
  if (
    typeof record.rawRetentionDays !== 'number'
    || !Number.isSafeInteger(record.rawRetentionDays)
    || record.rawRetentionDays < 1
    || record.rawRetentionDays > 3_650
  ) {
    throw new Error('body signal collection policy rawRetentionDays 无效。');
  }
  assertTimestamp(record.updatedAt, 'body signal collection policy updatedAt');
}

export function assertBodySignalHealthRecord(
  kind: BodySignalHealthRecordKind,
  entityId: string,
  value: unknown,
): asserts value is BodySignalHealthRecord {
  if (kind === 'body-signal-reading') {
    assertReadingRecord(entityId, value);
  } else if (kind === 'body-signal-care-summary') {
    assertCareSummaryRecord(entityId, value);
  } else {
    assertCollectionPolicyRecord(entityId, value);
  }
}

function retentionClassForKind(kind: BodySignalHealthRecordKind) {
  return kind === 'body-signal-reading'
    ? BODY_SIGNAL_RAW_RETENTION_CLASS
    : BODY_SIGNAL_DERIVED_RETENTION_CLASS;
}

export function assertBodySignalHealthPayload(
  entityType: string,
  entityId: string,
  operation: string,
  value: unknown,
): asserts value is BodySignalHealthPayloadV1 {
  if (!isBodySignalHealthEntityType(entityType)) {
    throw new Error('body-signal.health entity type 无效。');
  }
  const payload = recordOf(value, 'body-signal.health payload');
  if (
    payload.schemaVersion !== BODY_SIGNAL_HEALTH_SCHEMA_VERSION
    || !isBodySignalHealthRecordKind(payload.kind)
  ) {
    throw new Error('body-signal.health payload 版本或 kind 无效。');
  }
  if (bodySignalHealthEntityTypeForKind(payload.kind) !== entityType) {
    throw new Error('body-signal.health kind 与 entity type 不匹配。');
  }
  bodySignalHealthLocalId(payload.kind, entityId);
  if (operation === 'delete') {
    assertExactKeys(
      payload,
      ['schemaVersion', 'kind', 'deletedAt'],
      'body-signal.health delete payload',
    );
    assertTimestamp(payload.deletedAt, 'body-signal.health deletedAt');
    return;
  }
  if (operation !== 'upsert' && operation !== 'restore') {
    throw new Error('body-signal.health operation 无效。');
  }
  assertExactKeys(
    payload,
    ['schemaVersion', 'kind', 'record'],
    'body-signal.health record payload',
  );
  assertBodySignalHealthRecord(payload.kind, entityId, payload.record);
}

export function assertBodySignalHealthMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'body-signal'
    || !isBodySignalHealthEntityType(value.entity.type)
  ) {
    throw new Error('body-signal.health mutation entity 无效。');
  }
  if (value.revision.schemaVersion !== BODY_SIGNAL_HEALTH_SCHEMA_VERSION) {
    throw new Error('body-signal.health schemaVersion 无效。');
  }
  assertBodySignalHealthPayload(
    value.entity.type,
    value.entity.id,
    value.revision.operation,
    value.payload,
  );
  const payload = value.payload as BodySignalHealthPayloadV1;
  if (
    value.sensitivity !== 'highest'
    || value.retentionClass !== retentionClassForKind(payload.kind)
  ) {
    throw new Error('body-signal.health 最高敏留存合同无效。');
  }
  if (value.objectRefs.length !== 0) {
    throw new Error('body-signal.health 不接受对象引用。');
  }
}

export function bodySignalHealthPayload(mutation: PlainMutationV1) {
  assertBodySignalHealthMutationV1(mutation);
  return mutation.payload as BodySignalHealthPayloadV1;
}

export function bodySignalHealthRecordPayload<
  Kind extends BodySignalHealthRecordKind,
>(input: {
  kind: Kind;
  entityId: string;
  record: BodySignalHealthRecordByKind[Kind];
}): BodySignalHealthPayloadV1 {
  assertBodySignalHealthRecord(input.kind, input.entityId, input.record);
  return {
    schemaVersion: BODY_SIGNAL_HEALTH_SCHEMA_VERSION,
    kind: input.kind,
    record: input.record,
  } as BodySignalHealthPayloadV1;
}

export function bodySignalHealthDeletePayload(input: {
  kind: BodySignalHealthRecordKind;
  entityId: string;
  deletedAt: number;
}): BodySignalHealthPayloadV1 {
  bodySignalHealthLocalId(input.kind, input.entityId);
  assertTimestamp(input.deletedAt, 'body-signal.health deletedAt');
  return {
    schemaVersion: BODY_SIGNAL_HEALTH_SCHEMA_VERSION,
    kind: input.kind,
    deletedAt: input.deletedAt,
  };
}

export function buildBodySignalHealthMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: BodySignalHealthEntityType;
  entityId: string;
  operation: 'upsert' | 'restore' | 'delete';
  payload: BodySignalHealthPayloadV1;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'body-signal',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: input.operation,
      schemaVersion: BODY_SIGNAL_HEALTH_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: input.payload as JsonValue,
    objectRefs: [],
    retentionClass: retentionClassForKind(input.payload.kind),
  };
  assertBodySignalHealthMutationV1(mutation);
  return mutation;
}
