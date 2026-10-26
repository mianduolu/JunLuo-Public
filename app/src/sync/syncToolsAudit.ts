import type {
  JunLuoToolAuditRecord,
  JunLuoToolInputPreviewValue,
  JunLuoToolPermissionAuthorizationSource,
} from '../tools/toolAuditTypes';
import {
  previewToolInputValue,
  sanitizeToolAuditFieldName,
  sanitizeToolAuditText,
} from '../tools/toolInputPreview';
import type { JunLuoToolCallSource } from '../tools/toolTypes';
import { normalizeMusicPlaybackObservations } from '../music/musicPlaybackObservation';
import { normalizeOwnScheduleSave } from '../schedule/ownScheduleSaveState';
import { normalizeUserRoutineSave } from '../schedule/userRoutineSaveState';
import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const TOOLS_AUDIT_ADAPTER_ID = 'tools.audit' as const;
export const TOOLS_AUDIT_SCHEMA_VERSION = 1 as const;
export const TOOLS_AUDIT_EVENT_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type ToolsAuditRecordKind =
  | 'call-intent'
  | 'call-result'
  | 'audit-event';

export type ToolsAuditRecordValue = JunLuoToolAuditRecord;

export type ToolsAuditPayloadV1 =
  | {
      schemaVersion: typeof TOOLS_AUDIT_SCHEMA_VERSION;
      kind: ToolsAuditRecordKind;
      value: ToolsAuditRecordValue;
    }
  | {
      schemaVersion: typeof TOOLS_AUDIT_SCHEMA_VERSION;
      kind: 'audit-event';
      deletedAt: number;
    };

type UnknownRecord = Record<string, unknown>;

const KIND_ENTITY: Readonly<Record<ToolsAuditRecordKind, string>> = {
  'call-intent': 'call-intent',
  'call-result': 'call-result',
  'audit-event': 'audit-event',
};

const KIND_OPERATION: Readonly<
  Record<ToolsAuditRecordKind, 'append' | 'upsert'>
> = {
  'call-intent': 'append',
  'call-result': 'append',
  'audit-event': 'upsert',
};

const KIND_RETENTION: Readonly<Record<ToolsAuditRecordKind, string>> = {
  'call-intent': 'tools-formal-action',
  'call-result': 'tools-formal-result',
  'audit-event': 'tools-audit-180d',
};

const SOURCES: readonly JunLuoToolCallSource[] = [
  'chat',
  'proactive',
  'life_agent',
  'social_agent',
  'background',
  'manual',
];

const PERMISSION_SOURCES:
readonly JunLuoToolPermissionAuthorizationSource[] = [
  'bypass',
  'tool_override',
  'package_override',
  'global_default',
  'tool_definition',
  'risk_default',
  'session_grant',
  'today_grant',
  'parameter_grant',
  'prompt',
];

const TERMINAL_STATUSES = new Set([
  'permission_denied',
  'success',
  'error',
  'cancelled',
]);

function recordOf(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as UnknownRecord;
}

function assertKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !(key in value));
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length || extras.length) {
    throw new Error(`${label} 字段集合无效。`);
  }
}

function assertString(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false,
) {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || value.length > maximumLength
  ) {
    throw new Error(`${label} 字符串长度无效。`);
  }
}

function assertOptionalString(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  if (value !== undefined) {
    assertString(value, label, maximumLength, true);
  }
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertOptionalTimestamp(value: unknown, label: string) {
  if (value !== undefined) assertTimestamp(value, label);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value as UnknownRecord)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalJson(entry)}`
    ))
    .join(',')}}`;
}

function assertPreviewValue(
  value: unknown,
  fieldName: string,
): asserts value is JunLuoToolInputPreviewValue {
  if (
    value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('tools.audit preview number 无效。');
    }
    return;
  }
  if (typeof value === 'string') {
    if (
      value === '[redacted]'
      || /^\[private text: \d+ chars\]$/u.test(value)
    ) {
      return;
    }
    if (
      value.length > 120
      || previewToolInputValue(value, fieldName) !== value
    ) {
      throw new Error('tools.audit preview 未保持脱敏。');
    }
    return;
  }
  const object = recordOf(value, 'tools.audit preview value');
  if (object.type === 'array') {
    assertKeys(object, ['type', 'length'], [], 'tools.audit array preview');
    if (!Number.isSafeInteger(object.length) || Number(object.length) < 0) {
      throw new Error('tools.audit array preview length 无效。');
    }
    return;
  }
  if (object.type === 'object') {
    assertKeys(object, ['type', 'keys'], [], 'tools.audit object preview');
    if (!Array.isArray(object.keys) || object.keys.length > 12) {
      throw new Error('tools.audit object preview keys 无效。');
    }
    object.keys.forEach((key) => {
      assertString(key, 'tools.audit nested field', 64);
      if (sanitizeToolAuditFieldName(String(key)) !== key) {
        throw new Error('tools.audit nested field 未保持脱敏。');
      }
    });
    return;
  }
  if (object.type === 'unknown') {
    assertKeys(object, ['type'], [], 'tools.audit unknown preview');
    return;
  }
  throw new Error('tools.audit preview 类型无效。');
}

function assertInputPreview(value: unknown) {
  const preview = recordOf(value, 'tools.audit inputPreview');
  if (Object.keys(preview).length > 12) {
    throw new Error('tools.audit inputPreview 字段过多。');
  }
  for (const [fieldName, nested] of Object.entries(preview)) {
    if (
      fieldName.length > 64
      || sanitizeToolAuditFieldName(fieldName) !== fieldName
    ) {
      throw new Error('tools.audit inputPreview 字段名未保持脱敏。');
    }
    assertPreviewValue(nested, fieldName);
  }
}

function assertSanitizedAuditText(
  value: unknown,
  label: string,
) {
  assertString(value, label, 240, true);
  if (sanitizeToolAuditText(String(value)) !== value) {
    throw new Error(`${label} 未保持脱敏。`);
  }
}

export function assertToolsAuditRecord(
  kind: ToolsAuditRecordKind,
  entityId: string,
  value: unknown,
): asserts value is ToolsAuditRecordValue {
  const record = recordOf(value, `tools.audit ${kind}`);
  assertKeys(
    record,
    [
      'callId',
      'toolId',
      'packageId',
      'source',
      'inputPreview',
      'permissionDecision',
      'status',
      'createdAt',
    ],
    [
      'executionId',
      'sourceMessageId',
      'permissionSource',
      'permissionGrantId',
      'permissionExpiresAt',
      'permissionSilent',
      'resultSummary',
      'errorMessage',
      'startedAt',
      'finishedAt',
      ...(kind === 'audit-event' ? ['musicPlayback', 'scheduleSave', 'routineSave'] : []),
    ],
    `tools.audit ${kind}`,
  );
  assertString(record.callId, 'tools.audit callId', 512);
  if (record.callId !== entityId) {
    throw new Error('tools.audit callId 与 entity id 不一致。');
  }
  assertOptionalString(record.executionId, 'tools.audit executionId', 512);
  assertString(record.toolId, 'tools.audit toolId', 256);
  assertString(record.packageId, 'tools.audit packageId', 256, true);
  if (
    typeof record.source !== 'string'
    || !SOURCES.includes(record.source as JunLuoToolCallSource)
  ) {
    throw new Error('tools.audit source 无效。');
  }
  assertOptionalString(
    record.sourceMessageId,
    'tools.audit sourceMessageId',
    512,
  );
  assertInputPreview(record.inputPreview);
  if (
    typeof record.permissionDecision !== 'string'
    || ![
      'not_checked',
      'allowed',
      'denied',
      'cancelled',
    ].includes(record.permissionDecision)
  ) {
    throw new Error('tools.audit permissionDecision 无效。');
  }
  if (
    record.permissionSource !== undefined
    && (
      typeof record.permissionSource !== 'string'
      || !PERMISSION_SOURCES.includes(
        (
          record.permissionSource
        ) as JunLuoToolPermissionAuthorizationSource,
      )
    )
  ) {
    throw new Error('tools.audit permissionSource 无效。');
  }
  assertOptionalString(
    record.permissionGrantId,
    'tools.audit permissionGrantId',
    512,
  );
  assertOptionalTimestamp(
    record.permissionExpiresAt,
    'tools.audit permissionExpiresAt',
  );
  if (
    record.permissionSilent !== undefined
    && typeof record.permissionSilent !== 'boolean'
  ) {
    throw new Error('tools.audit permissionSilent 无效。');
  }
  if (
    typeof record.status !== 'string'
    || ![
      'requested',
      'permission_denied',
      'running',
      'success',
      'error',
      'cancelled',
    ].includes(record.status)
  ) {
    throw new Error('tools.audit status 无效。');
  }
  if (record.resultSummary !== undefined) {
    assertSanitizedAuditText(
      record.resultSummary,
      'tools.audit resultSummary',
    );
  }
  if (record.errorMessage !== undefined) {
    assertSanitizedAuditText(
      record.errorMessage,
      'tools.audit errorMessage',
    );
  }
  assertTimestamp(record.createdAt, 'tools.audit createdAt');
  assertOptionalTimestamp(record.startedAt, 'tools.audit startedAt');
  assertOptionalTimestamp(record.finishedAt, 'tools.audit finishedAt');
  if (record.musicPlayback !== undefined) {
    if (record.toolId !== 'music.play' || !Array.isArray(record.musicPlayback)) {
      throw new Error('tools.audit musicPlayback 只属于原播放调用。');
    }
    const normalized = normalizeMusicPlaybackObservations(record.musicPlayback);
    if (canonicalJson(normalized) !== canonicalJson(record.musicPlayback)) {
      throw new Error('tools.audit musicPlayback 字段、身份或顺序无效。');
    }
  }
  if (record.scheduleSave !== undefined) {
    const normalized = normalizeOwnScheduleSave(record.scheduleSave);
    if (record.toolId !== 'schedule.save_own' || !normalized || normalized.batch.opId !== record.callId
      || canonicalJson(normalized) !== canonicalJson(record.scheduleSave)) throw new Error('invalid schedule save continuation');
  }
  if (record.routineSave !== undefined) {
    const normalized = normalizeUserRoutineSave(record.routineSave);
    if (record.toolId !== 'schedule.save_routine' || !normalized || normalized.operationId !== record.callId
      || canonicalJson(normalized) !== canonicalJson(record.routineSave)) throw new Error('invalid routine save continuation');
  }
  if (
    typeof record.startedAt === 'number'
    && record.startedAt < Number(record.createdAt)
  ) {
    throw new Error('tools.audit startedAt 不能早于 createdAt。');
  }
  if (
    typeof record.finishedAt === 'number'
    && record.finishedAt < Number(record.startedAt ?? record.createdAt)
  ) {
    throw new Error('tools.audit finishedAt 不能早于开始时间。');
  }
  if (kind === 'call-intent') {
    if (
      record.status !== 'requested'
      || record.permissionDecision !== 'not_checked'
      || record.startedAt !== undefined
      || record.finishedAt !== undefined
      || record.resultSummary !== undefined
      || record.errorMessage !== undefined
    ) {
      throw new Error('tools.audit call-intent 必须是不可变请求快照。');
    }
  }
  if (
    kind === 'call-result'
    && (
      !TERMINAL_STATUSES.has(String(record.status))
      || record.finishedAt === undefined
    )
  ) {
    throw new Error('tools.audit call-result 必须是带完成时间的终态。');
  }
  assertJsonValue(record);
}

export function toolsAuditEntityTypeForKind(
  kind: ToolsAuditRecordKind,
) {
  return KIND_ENTITY[kind];
}

export function toolsAuditOperationForKind(
  kind: ToolsAuditRecordKind,
) {
  return KIND_OPERATION[kind];
}

export function toolsAuditRetentionForKind(
  kind: ToolsAuditRecordKind,
) {
  return KIND_RETENTION[kind];
}

export function assertToolsAuditMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'tools'
    || !Object.values(KIND_ENTITY).includes(value.entity.type)
  ) {
    throw new Error('tools.audit mutation entity 无效。');
  }
  if (
    value.revision.schemaVersion !== TOOLS_AUDIT_SCHEMA_VERSION
    || value.sensitivity !== 'highest'
    || value.objectRefs.length !== 0
  ) {
    throw new Error('tools.audit protocol metadata 无效。');
  }
  const payload = recordOf(value.payload, 'tools.audit payload');
  if (value.revision.operation === 'delete') {
    assertKeys(
      payload,
      ['schemaVersion', 'kind', 'deletedAt'],
      [],
      'tools.audit tombstone',
    );
    if (
      payload.schemaVersion !== TOOLS_AUDIT_SCHEMA_VERSION
      || payload.kind !== 'audit-event'
      || value.entity.type !== 'audit-event'
      || value.retentionClass !== 'tools-audit-180d'
    ) {
      throw new Error('tools.audit event tombstone metadata 无效。');
    }
    assertTimestamp(payload.deletedAt, 'tools.audit deletedAt');
    assertJsonValue(payload);
    return;
  }
  assertKeys(
    payload,
    ['schemaVersion', 'kind', 'value'],
    [],
    'tools.audit payload',
  );
  if (
    payload.schemaVersion !== TOOLS_AUDIT_SCHEMA_VERSION
    || typeof payload.kind !== 'string'
    || !(payload.kind in KIND_ENTITY)
  ) {
    throw new Error('tools.audit payload metadata 无效。');
  }
  const kind = payload.kind as ToolsAuditRecordKind;
  if (
    value.entity.type !== toolsAuditEntityTypeForKind(kind)
    || value.revision.operation !== toolsAuditOperationForKind(kind)
    || value.retentionClass !== toolsAuditRetentionForKind(kind)
  ) {
    throw new Error('tools.audit kind metadata 无效。');
  }
  assertToolsAuditRecord(kind, value.entity.id, payload.value);
}

export function toolsAuditMutationValue(
  mutation: PlainMutationV1,
) {
  assertToolsAuditMutationV1(mutation);
  const payload = mutation.payload as UnknownRecord;
  if (mutation.revision.operation === 'delete') {
    throw new Error('tools.audit tombstone 不含 value。');
  }
  return {
    kind: payload.kind as ToolsAuditRecordKind,
    value: payload.value as unknown as ToolsAuditRecordValue,
  };
}

export function buildToolsAuditMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  kind: ToolsAuditRecordKind;
  value: ToolsAuditRecordValue;
}) {
  assertToolsAuditRecord(input.kind, input.value.callId, input.value);
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'tools',
      type: toolsAuditEntityTypeForKind(input.kind),
      id: input.value.callId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: toolsAuditOperationForKind(input.kind),
      schemaVersion: TOOLS_AUDIT_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: {
      schemaVersion: TOOLS_AUDIT_SCHEMA_VERSION,
      kind: input.kind,
      value: input.value as unknown as JsonValue,
    },
    objectRefs: [],
    retentionClass: toolsAuditRetentionForKind(input.kind),
  };
  assertToolsAuditMutationV1(mutation);
  return mutation;
}

export function buildToolsAuditEventDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  callId: string;
  deletedAt: number;
}) {
  assertString(input.callId, 'tools.audit callId', 512);
  assertTimestamp(input.deletedAt, 'tools.audit deletedAt');
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'tools',
      type: 'audit-event',
      id: input.callId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'delete',
      schemaVersion: TOOLS_AUDIT_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: {
      schemaVersion: TOOLS_AUDIT_SCHEMA_VERSION,
      kind: 'audit-event',
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: 'tools-audit-180d',
  };
  assertToolsAuditMutationV1(mutation);
  return mutation;
}

export function toolsAuditRecordsEqual(
  left: ToolsAuditRecordValue,
  right: ToolsAuditRecordValue,
) {
  return canonicalJson(left) === canonicalJson(right);
}

function callIntentCanonicalJson(
  record: ToolsAuditRecordValue,
) {
  const comparable = { ...record };
  delete comparable.executionId;
  return canonicalJson(comparable);
}

export function toolsAuditRecordsEqualForKind(
  kind: ToolsAuditRecordKind,
  left: ToolsAuditRecordValue,
  right: ToolsAuditRecordValue,
) {
  if (kind === 'call-intent') {
    return callIntentCanonicalJson(left)
      === callIntentCanonicalJson(right);
  }
  return toolsAuditRecordsEqual(left, right);
}
