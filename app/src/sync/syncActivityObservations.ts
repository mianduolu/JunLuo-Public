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

export const ACTIVITY_OBSERVATIONS_ADAPTER_ID =
  'activity.observations' as const;
export const ACTIVITY_OBSERVATIONS_SCHEMA_VERSION = 1 as const;
export const ACTIVITY_RAW_RETENTION_CLASS =
  'activity-raw-180d' as const;
export const ACTIVITY_RECORD_RETENTION_CLASS =
  'activity-record' as const;
export const ACTIVITY_DEFAULT_RAW_RETENTION_DAYS = 3;
export const ACTIVITY_DAILY_SUMMARY_RETENTION_DAYS = 7;

export const ACTIVITY_OBSERVATIONS_ENTITY_TYPES = [
  'activity-reading',
  'formal-observation',
  'care-policy',
  'focus-trigger',
] as const;

export const ACTIVITY_OBSERVATIONS_RECORD_KINDS = [
  'activity-reading',
  'activity-day-summary',
  'activity-care-settings',
  'activity-care-rule',
  'activity-feedback',
  'activity-focus-trigger',
  'activity-daily-usage',
] as const;

export type ActivityObservationsEntityType =
  (typeof ACTIVITY_OBSERVATIONS_ENTITY_TYPES)[number];
export type ActivityObservationsRecordKind =
  (typeof ACTIVITY_OBSERVATIONS_RECORD_KINDS)[number];
export type ActivityRuleKind =
  | 'blacklist'
  | 'jealousy'
  | 'whitelist';
export type ActivityTriggerKind =
  | 'blacklist'
  | 'blacklist-return'
  | 'jealousy'
  | 'whitelist';
export type ActivityTriggerReason =
  | 'accumulated'
  | 'current'
  | 'jealousy'
  | 'return'
  | 'unknown';
export type ActivityRuleEventStage =
  | 'daily-limit'
  | 'daily-summary-praise'
  | 'first-praise'
  | 'first-warning'
  | 'repeat-praise'
  | 'repeat-warning'
  | 'return-after-overlay';

export type ActivityReadingRecord = {
  id: string;
  readingKind: string;
  source: string;
  title: string;
  summary: string;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number;
  sensitivityLabel: string;
  originDeviceId: string;
  originPlatform: SyncPlatform;
  sourceScope: 'origin-device';
  retentionUntil: number;
  createdAt: number;
};

export type ActivityUsageAppSummaryRecord = {
  source: string;
  title: string;
  durationMs: number;
  segments: number;
};

export type ActivityDaySummaryRecord = {
  id: string;
  dateKey: string;
  originDeviceId: string;
  originPlatform: SyncPlatform;
  sourceScope: 'origin-device';
  segments: number;
  totalDurationMs: number;
  topApps: ActivityUsageAppSummaryRecord[];
  generatedAt: number;
  updatedAt: number;
};

export type ActivityCareSettingsRecord = {
  id: 'global';
  enabled: boolean;
  jealousyEnabled: boolean;
  rawRetentionDays: number;
  updatedAt: number;
};

export type ActivityCareRuleRecord = {
  id: string;
  ruleKind: ActivityRuleKind;
  targetPlatform: SyncPlatform;
  source: string;
  title: string;
  thresholdMinutes: number;
  returnWindowMinutes: number | null;
  dailyLimitMinutes: number | null;
  updatedAt: number;
};

export type ActivityFeedbackRecord = {
  id: string;
  feedbackKind: 'jealousy-candidate';
  targetPlatform: SyncPlatform;
  source: string;
  title: string;
  reason: string;
  status: 'accepted' | 'dismissed' | 'pending';
  createdAt: number;
  updatedAt: number;
};

export type ActivityFocusTriggerRecord = {
  id: string;
  ruleId: string;
  ruleKind: ActivityRuleKind;
  triggerKind: ActivityTriggerKind;
  reason: ActivityTriggerReason;
  eventStage: ActivityRuleEventStage | null;
  appSource: string;
  appTitle: string;
  durationMs: number;
  stage: 1 | 2 | 3;
  outcome: 'message-sent' | 'observed';
  originDeviceId: string;
  originPlatform: SyncPlatform;
  sourceScope: 'origin-device';
  triggeredAt: number;
  updatedAt: number;
};

export type ActivityDailyUsageRecord = {
  id: string;
  ruleId: string;
  dateKey: string;
  durationMs: number;
  originDeviceId: string;
  originPlatform: SyncPlatform;
  sourceScope: 'origin-device';
  updatedAt: number;
};

export type ActivityObservationsRecordByKind = {
  'activity-reading': ActivityReadingRecord;
  'activity-day-summary': ActivityDaySummaryRecord;
  'activity-care-settings': ActivityCareSettingsRecord;
  'activity-care-rule': ActivityCareRuleRecord;
  'activity-feedback': ActivityFeedbackRecord;
  'activity-focus-trigger': ActivityFocusTriggerRecord;
  'activity-daily-usage': ActivityDailyUsageRecord;
};

export type ActivityObservationsRecord =
  ActivityObservationsRecordByKind[ActivityObservationsRecordKind];

export type ActivityObservationsPayloadV1 =
  | {
      [Kind in ActivityObservationsRecordKind]: {
        schemaVersion: typeof ACTIVITY_OBSERVATIONS_SCHEMA_VERSION;
        kind: Kind;
        record: ActivityObservationsRecordByKind[Kind];
      };
    }[ActivityObservationsRecordKind]
  | {
      schemaVersion: typeof ACTIVITY_OBSERVATIONS_SCHEMA_VERSION;
      kind: ActivityObservationsRecordKind;
      deletedAt: number;
    };

type UnknownRecord = Record<string, unknown>;

const KIND_ENTITY_TYPES: Record<
  ActivityObservationsRecordKind,
  ActivityObservationsEntityType
> = {
  'activity-reading': 'activity-reading',
  'activity-day-summary': 'formal-observation',
  'activity-care-settings': 'care-policy',
  'activity-care-rule': 'care-policy',
  'activity-feedback': 'formal-observation',
  'activity-focus-trigger': 'focus-trigger',
  'activity-daily-usage': 'formal-observation',
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
  assertString(value, label, 300);
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

function assertNonNegativeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 必须是非负整数。`);
  }
}

function assertPositiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < 1
    || (value as number) > maximum
  ) {
    throw new Error(`${label} 必须是 1 到 ${maximum} 的整数。`);
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

function assertPlatform(
  value: unknown,
  label: string,
): asserts value is SyncPlatform {
  assertEnum(value, ['android', 'windows'], label);
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

function assertOrigin(
  record: UnknownRecord,
  label: string,
): asserts record is UnknownRecord & {
  originDeviceId: string;
  originPlatform: SyncPlatform;
  sourceScope: 'origin-device';
} {
  assertSyncUuidV4(record.originDeviceId, `${label} originDeviceId`);
  assertPlatform(record.originPlatform, `${label} originPlatform`);
  if (record.sourceScope !== 'origin-device') {
    throw new Error(`${label} sourceScope 无效。`);
  }
}

export function isActivityObservationsEntityType(
  value: unknown,
): value is ActivityObservationsEntityType {
  return (
    typeof value === 'string'
    && (ACTIVITY_OBSERVATIONS_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

export function isActivityObservationsRecordKind(
  value: unknown,
): value is ActivityObservationsRecordKind {
  return (
    typeof value === 'string'
    && (ACTIVITY_OBSERVATIONS_RECORD_KINDS as readonly string[]).includes(value)
  );
}

export function activityObservationsEntityTypeForKind(
  kind: ActivityObservationsRecordKind,
) {
  return KIND_ENTITY_TYPES[kind];
}

export function activityObservationsEntityId(
  kind: ActivityObservationsRecordKind,
  localId: string,
) {
  assertLocalId(localId, `activity.observations ${kind} local id`);
  return `${kind}:${localId}`;
}

export function activityObservationsLocalId(
  kind: ActivityObservationsRecordKind,
  entityId: string,
) {
  assertString(entityId, `activity.observations ${kind} entity id`, 340);
  const prefix = `${kind}:`;
  if (!entityId.startsWith(prefix)) {
    throw new Error(`activity.observations ${kind} entity id 前缀无效。`);
  }
  const localId = entityId.slice(prefix.length);
  assertLocalId(localId, `activity.observations ${kind} local id`);
  return localId;
}

export function activityDaySummaryId(input: {
  dateKey: string;
  originDeviceId: string;
}) {
  assertDateKey(input.dateKey, 'activity day summary dateKey');
  assertSyncUuidV4(input.originDeviceId, 'activity day summary originDeviceId');
  return `${input.originDeviceId}:${input.dateKey}`;
}

export function activityDailyUsageId(input: {
  dateKey: string;
  originDeviceId: string;
  ruleId: string;
}) {
  assertDateKey(input.dateKey, 'activity daily usage dateKey');
  assertSyncUuidV4(input.originDeviceId, 'activity daily usage originDeviceId');
  assertLocalId(input.ruleId, 'activity daily usage ruleId');
  return `${input.originDeviceId}:${input.dateKey}:${input.ruleId}`;
}

function assertReadingRecord(
  entityId: string,
  value: unknown,
): asserts value is ActivityReadingRecord {
  const record = recordOf(value, 'activity reading record');
  assertExactKeys(record, [
    'id',
    'readingKind',
    'source',
    'title',
    'summary',
    'startedAt',
    'endedAt',
    'durationMs',
    'sensitivityLabel',
    'originDeviceId',
    'originPlatform',
    'sourceScope',
    'retentionUntil',
    'createdAt',
  ], 'activity reading record');
  assertLocalId(record.id, 'activity reading id');
  if (activityObservationsEntityId('activity-reading', record.id) !== entityId) {
    throw new Error('activity reading id 与 entity id 不一致。');
  }
  assertString(record.readingKind, 'activity reading kind', 80);
  assertString(record.source, 'activity reading source', 512, true);
  assertString(record.title, 'activity reading title', 300, true);
  assertString(record.summary, 'activity reading summary', 2_000, true);
  assertNullableTimestamp(record.startedAt, 'activity reading startedAt');
  assertNullableTimestamp(record.endedAt, 'activity reading endedAt');
  assertNonNegativeInteger(record.durationMs, 'activity reading durationMs');
  assertString(
    record.sensitivityLabel,
    'activity reading sensitivityLabel',
    80,
  );
  assertOrigin(record, 'activity reading');
  assertTimestamp(record.retentionUntil, 'activity reading retentionUntil');
  assertTimestamp(record.createdAt, 'activity reading createdAt');
  const evidenceAt = record.startedAt ?? record.createdAt;
  if (record.retentionUntil <= evidenceAt) {
    throw new Error('activity reading retentionUntil 必须晚于活动发生时间。');
  }
  if (
    record.startedAt !== null
    && record.endedAt !== null
    && record.endedAt < record.startedAt
  ) {
    throw new Error('activity reading 时间范围无效。');
  }
}

function assertUsageAppSummary(
  value: unknown,
): asserts value is ActivityUsageAppSummaryRecord {
  const record = recordOf(value, 'activity usage app summary');
  assertExactKeys(record, [
    'source',
    'title',
    'durationMs',
    'segments',
  ], 'activity usage app summary');
  assertString(record.source, 'activity usage app source', 512);
  assertString(record.title, 'activity usage app title', 300);
  assertNonNegativeInteger(
    record.durationMs,
    'activity usage app durationMs',
  );
  assertPositiveInteger(record.segments, 'activity usage app segments', 1_000_000);
}

function assertDaySummaryRecord(
  entityId: string,
  value: unknown,
): asserts value is ActivityDaySummaryRecord {
  const record = recordOf(value, 'activity day summary record');
  assertExactKeys(record, [
    'id',
    'dateKey',
    'originDeviceId',
    'originPlatform',
    'sourceScope',
    'segments',
    'totalDurationMs',
    'topApps',
    'generatedAt',
    'updatedAt',
  ], 'activity day summary record');
  assertDateKey(record.dateKey, 'activity day summary dateKey');
  assertOrigin(record, 'activity day summary');
  const expectedId = activityDaySummaryId({
    dateKey: record.dateKey,
    originDeviceId: record.originDeviceId,
  });
  if (
    record.id !== expectedId
    || activityObservationsEntityId(
      'activity-day-summary',
      record.id,
    ) !== entityId
  ) {
    throw new Error('activity day summary identity 无效。');
  }
  assertNonNegativeInteger(record.segments, 'activity day summary segments');
  assertNonNegativeInteger(
    record.totalDurationMs,
    'activity day summary totalDurationMs',
  );
  if (!Array.isArray(record.topApps) || record.topApps.length > 50) {
    throw new Error('activity day summary topApps 无效。');
  }
  record.topApps.forEach(assertUsageAppSummary);
  assertTimestamp(record.generatedAt, 'activity day summary generatedAt');
  assertTimestamp(record.updatedAt, 'activity day summary updatedAt');
}

function assertCareSettingsRecord(
  entityId: string,
  value: unknown,
): asserts value is ActivityCareSettingsRecord {
  const record = recordOf(value, 'activity care settings record');
  assertExactKeys(record, [
    'id',
    'enabled',
    'jealousyEnabled',
    'rawRetentionDays',
    'updatedAt',
  ], 'activity care settings record');
  if (
    record.id !== 'global'
    || activityObservationsEntityId(
      'activity-care-settings',
      record.id,
    ) !== entityId
  ) {
    throw new Error('activity care settings identity 无效。');
  }
  assertBoolean(record.enabled, 'activity care settings enabled');
  assertBoolean(
    record.jealousyEnabled,
    'activity care settings jealousyEnabled',
  );
  assertPositiveInteger(
    record.rawRetentionDays,
    'activity care settings rawRetentionDays',
    3_650,
  );
  assertTimestamp(record.updatedAt, 'activity care settings updatedAt');
}

function assertRuleRecord(
  entityId: string,
  value: unknown,
): asserts value is ActivityCareRuleRecord {
  const record = recordOf(value, 'activity care rule record');
  assertExactKeys(record, [
    'id',
    'ruleKind',
    'targetPlatform',
    'source',
    'title',
    'thresholdMinutes',
    'returnWindowMinutes',
    'dailyLimitMinutes',
    'updatedAt',
  ], 'activity care rule record');
  assertLocalId(record.id, 'activity care rule id');
  if (
    activityObservationsEntityId('activity-care-rule', record.id) !== entityId
  ) {
    throw new Error('activity care rule identity 无效。');
  }
  assertEnum(
    record.ruleKind,
    ['blacklist', 'jealousy', 'whitelist'],
    'activity care rule kind',
  );
  assertPlatform(record.targetPlatform, 'activity care rule targetPlatform');
  assertString(record.source, 'activity care rule source', 512, true);
  assertString(record.title, 'activity care rule title', 300);
  if (!record.source && !record.title) {
    throw new Error('activity care rule 必须包含 source 或 title。');
  }
  assertPositiveInteger(
    record.thresholdMinutes,
    'activity care rule thresholdMinutes',
    1_440,
  );
  if (record.returnWindowMinutes !== null) {
    assertPositiveInteger(
      record.returnWindowMinutes,
      'activity care rule returnWindowMinutes',
      1_440,
    );
  }
  if (record.dailyLimitMinutes !== null) {
    assertPositiveInteger(
      record.dailyLimitMinutes,
      'activity care rule dailyLimitMinutes',
      1_440,
    );
  }
  assertTimestamp(record.updatedAt, 'activity care rule updatedAt');
}

function assertFeedbackRecord(
  entityId: string,
  value: unknown,
): asserts value is ActivityFeedbackRecord {
  const record = recordOf(value, 'activity feedback record');
  assertExactKeys(record, [
    'id',
    'feedbackKind',
    'targetPlatform',
    'source',
    'title',
    'reason',
    'status',
    'createdAt',
    'updatedAt',
  ], 'activity feedback record');
  assertLocalId(record.id, 'activity feedback id');
  if (
    activityObservationsEntityId('activity-feedback', record.id) !== entityId
  ) {
    throw new Error('activity feedback identity 无效。');
  }
  if (record.feedbackKind !== 'jealousy-candidate') {
    throw new Error('activity feedback kind 无效。');
  }
  assertPlatform(record.targetPlatform, 'activity feedback targetPlatform');
  assertString(record.source, 'activity feedback source', 512, true);
  assertString(record.title, 'activity feedback title', 300);
  assertString(record.reason, 'activity feedback reason', 140, true);
  assertEnum(
    record.status,
    ['accepted', 'dismissed', 'pending'],
    'activity feedback status',
  );
  assertTimestamp(record.createdAt, 'activity feedback createdAt');
  assertTimestamp(record.updatedAt, 'activity feedback updatedAt');
}

function assertFocusTriggerRecord(
  entityId: string,
  value: unknown,
): asserts value is ActivityFocusTriggerRecord {
  const record = recordOf(value, 'activity focus trigger record');
  assertExactKeys(record, [
    'id',
    'ruleId',
    'ruleKind',
    'triggerKind',
    'reason',
    'eventStage',
    'appSource',
    'appTitle',
    'durationMs',
    'stage',
    'outcome',
    'originDeviceId',
    'originPlatform',
    'sourceScope',
    'triggeredAt',
    'updatedAt',
  ], 'activity focus trigger record');
  assertLocalId(record.id, 'activity focus trigger id');
  if (
    activityObservationsEntityId('activity-focus-trigger', record.id)
      !== entityId
  ) {
    throw new Error('activity focus trigger identity 无效。');
  }
  assertLocalId(record.ruleId, 'activity focus trigger ruleId');
  assertEnum(
    record.ruleKind,
    ['blacklist', 'jealousy', 'whitelist'],
    'activity focus trigger ruleKind',
  );
  assertEnum(
    record.triggerKind,
    ['blacklist', 'blacklist-return', 'jealousy', 'whitelist'],
    'activity focus trigger triggerKind',
  );
  assertEnum(
    record.reason,
    ['accumulated', 'current', 'jealousy', 'return', 'unknown'],
    'activity focus trigger reason',
  );
  if (record.eventStage !== null) {
    assertEnum(record.eventStage, [
      'daily-limit',
      'daily-summary-praise',
      'first-praise',
      'first-warning',
      'repeat-praise',
      'repeat-warning',
      'return-after-overlay',
    ], 'activity focus trigger eventStage');
  }
  assertString(record.appSource, 'activity focus trigger appSource', 512, true);
  assertString(record.appTitle, 'activity focus trigger appTitle', 300);
  assertNonNegativeInteger(
    record.durationMs,
    'activity focus trigger durationMs',
  );
  if (record.stage !== 1 && record.stage !== 2 && record.stage !== 3) {
    throw new Error('activity focus trigger stage 无效。');
  }
  assertEnum(
    record.outcome,
    ['message-sent', 'observed'],
    'activity focus trigger outcome',
  );
  assertOrigin(record, 'activity focus trigger');
  assertTimestamp(record.triggeredAt, 'activity focus trigger triggeredAt');
  assertTimestamp(record.updatedAt, 'activity focus trigger updatedAt');
}

function assertDailyUsageRecord(
  entityId: string,
  value: unknown,
): asserts value is ActivityDailyUsageRecord {
  const record = recordOf(value, 'activity daily usage record');
  assertExactKeys(record, [
    'id',
    'ruleId',
    'dateKey',
    'durationMs',
    'originDeviceId',
    'originPlatform',
    'sourceScope',
    'updatedAt',
  ], 'activity daily usage record');
  assertLocalId(record.ruleId, 'activity daily usage ruleId');
  assertDateKey(record.dateKey, 'activity daily usage dateKey');
  assertOrigin(record, 'activity daily usage');
  const expectedId = activityDailyUsageId({
    dateKey: record.dateKey,
    originDeviceId: record.originDeviceId,
    ruleId: record.ruleId,
  });
  if (
    record.id !== expectedId
    || activityObservationsEntityId(
      'activity-daily-usage',
      record.id,
    ) !== entityId
  ) {
    throw new Error('activity daily usage identity 无效。');
  }
  assertNonNegativeInteger(
    record.durationMs,
    'activity daily usage durationMs',
  );
  assertTimestamp(record.updatedAt, 'activity daily usage updatedAt');
}

export function assertActivityObservationsRecord(
  kind: ActivityObservationsRecordKind,
  entityId: string,
  value: unknown,
): asserts value is ActivityObservationsRecord {
  if (kind === 'activity-reading') {
    assertReadingRecord(entityId, value);
  } else if (kind === 'activity-day-summary') {
    assertDaySummaryRecord(entityId, value);
  } else if (kind === 'activity-care-settings') {
    assertCareSettingsRecord(entityId, value);
  } else if (kind === 'activity-care-rule') {
    assertRuleRecord(entityId, value);
  } else if (kind === 'activity-feedback') {
    assertFeedbackRecord(entityId, value);
  } else if (kind === 'activity-focus-trigger') {
    assertFocusTriggerRecord(entityId, value);
  } else {
    assertDailyUsageRecord(entityId, value);
  }
}

export function activityObservationsRetentionClassForKind(
  kind: ActivityObservationsRecordKind,
) {
  return kind === 'activity-reading'
    ? ACTIVITY_RAW_RETENTION_CLASS
    : ACTIVITY_RECORD_RETENTION_CLASS;
}

export function assertActivityObservationsPayload(
  entityType: string,
  entityId: string,
  operation: string,
  value: unknown,
): asserts value is ActivityObservationsPayloadV1 {
  if (!isActivityObservationsEntityType(entityType)) {
    throw new Error('activity.observations entity type 无效。');
  }
  const payload = recordOf(value, 'activity.observations payload');
  if (
    payload.schemaVersion !== ACTIVITY_OBSERVATIONS_SCHEMA_VERSION
    || !isActivityObservationsRecordKind(payload.kind)
  ) {
    throw new Error('activity.observations payload 版本或 kind 无效。');
  }
  if (activityObservationsEntityTypeForKind(payload.kind) !== entityType) {
    throw new Error('activity.observations kind 与 entity type 不匹配。');
  }
  activityObservationsLocalId(payload.kind, entityId);
  if (operation === 'delete') {
    assertExactKeys(
      payload,
      ['schemaVersion', 'kind', 'deletedAt'],
      'activity.observations delete payload',
    );
    assertTimestamp(
      payload.deletedAt,
      'activity.observations deletedAt',
    );
    return;
  }
  if (operation !== 'upsert' && operation !== 'restore') {
    throw new Error('activity.observations operation 无效。');
  }
  assertExactKeys(
    payload,
    ['schemaVersion', 'kind', 'record'],
    'activity.observations record payload',
  );
  assertActivityObservationsRecord(payload.kind, entityId, payload.record);
}

export function assertActivityObservationsMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'activity'
    || !isActivityObservationsEntityType(value.entity.type)
  ) {
    throw new Error('activity.observations mutation entity 无效。');
  }
  if (
    value.revision.schemaVersion
      !== ACTIVITY_OBSERVATIONS_SCHEMA_VERSION
  ) {
    throw new Error('activity.observations schemaVersion 无效。');
  }
  assertActivityObservationsPayload(
    value.entity.type,
    value.entity.id,
    value.revision.operation,
    value.payload,
  );
  const payload = value.payload as ActivityObservationsPayloadV1;
  if (
    value.sensitivity !== 'highest'
    || value.retentionClass
      !== activityObservationsRetentionClassForKind(payload.kind)
  ) {
    throw new Error('activity.observations 最高敏留存合同无效。');
  }
  if (value.objectRefs.length !== 0) {
    throw new Error('activity.observations 不接受对象引用。');
  }
}

export function activityObservationsPayload(mutation: PlainMutationV1) {
  assertActivityObservationsMutationV1(mutation);
  return mutation.payload as ActivityObservationsPayloadV1;
}

export function activityObservationsRecordPayload<
  Kind extends ActivityObservationsRecordKind,
>(input: {
  kind: Kind;
  entityId: string;
  record: ActivityObservationsRecordByKind[Kind];
}): ActivityObservationsPayloadV1 {
  assertActivityObservationsRecord(
    input.kind,
    input.entityId,
    input.record,
  );
  return {
    schemaVersion: ACTIVITY_OBSERVATIONS_SCHEMA_VERSION,
    kind: input.kind,
    record: input.record,
  } as ActivityObservationsPayloadV1;
}

export function activityObservationsDeletePayload(input: {
  kind: ActivityObservationsRecordKind;
  entityId: string;
  deletedAt: number;
}): ActivityObservationsPayloadV1 {
  activityObservationsLocalId(input.kind, input.entityId);
  assertTimestamp(input.deletedAt, 'activity.observations deletedAt');
  return {
    schemaVersion: ACTIVITY_OBSERVATIONS_SCHEMA_VERSION,
    kind: input.kind,
    deletedAt: input.deletedAt,
  };
}

export function buildActivityObservationsMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: ActivityObservationsEntityType;
  entityId: string;
  operation: 'delete' | 'restore' | 'upsert';
  payload: ActivityObservationsPayloadV1;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'activity',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: input.operation,
      schemaVersion: ACTIVITY_OBSERVATIONS_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: input.payload as JsonValue,
    objectRefs: [],
    retentionClass: activityObservationsRetentionClassForKind(
      input.payload.kind,
    ),
  };
  assertActivityObservationsMutationV1(mutation);
  return mutation;
}
