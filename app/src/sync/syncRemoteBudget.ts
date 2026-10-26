import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  AI_CALL_KINDS,
  AI_CALL_PURPOSES,
  AI_CALL_PRIORITIES,
  type AiCallBudgetRecord,
} from '../ai/aiCallBudgetStorage';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const REMOTE_BUDGET_ADAPTER_ID = 'usage.remote-budget' as const;
export const REMOTE_BUDGET_SCHEMA_VERSION = 1 as const;
export const REMOTE_BUDGET_RETENTION_CLASS =
  'rolling-remote-budget-24h' as const;
export const REMOTE_BUDGET_ENTITY_TYPE =
  'remote-account-budget' as const;
export const REMOTE_BUDGET_RECORD_KIND =
  'remote-call-counted' as const;

export type RemoteBudgetEventRecord = Pick<
  AiCallBudgetRecord,
  'endedAt' | 'id' | 'kind' | 'priority' | 'remoteAccountId' | 'startedAt' | 'purpose' | 'costRestricted'
> & {
  remoteAccountId: string;
};

function recordOf(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = [],
) {
  const allowedSet = new Set([...allowed, ...optional]);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !(key in value));
  if (extra.length) {
    throw new Error(`${label} 包含未允许字段：${extra.sort().join(', ')}。`);
  }
  if (missing.length) {
    throw new Error(`${label} 缺少字段：${missing.join(', ')}。`);
  }
}

function assertString(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
  ) {
    throw new Error(`${label} 必须是 1–${maximumLength} 字符的字符串。`);
  }
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

export function assertRemoteBudgetEventRecord(
  entityId: string,
  value: unknown,
): asserts value is RemoteBudgetEventRecord {
  const record = recordOf(value, 'remote budget event');
  assertJsonValue(record);
  assertExactKeys(
    record,
    [
      'id',
      'endedAt',
      'kind',
      'priority',
      'remoteAccountId',
      'startedAt',
    ],
    'remote budget event',
    ['purpose', 'costRestricted'],
  );
  assertString(record.id, 'remote budget event id', 256);
  if (record.id !== entityId) {
    throw new Error('remote budget event id 与 entity id 不一致。');
  }
  assertString(record.remoteAccountId, 'remote account id', 256);
  if (
    typeof record.kind !== 'string'
    || !AI_CALL_KINDS.includes(record.kind as typeof AI_CALL_KINDS[number])
  ) {
    throw new Error('remote budget call kind 无效。');
  }
  if (
    typeof record.priority !== 'string'
    || !AI_CALL_PRIORITIES.includes(
      record.priority as typeof AI_CALL_PRIORITIES[number],
    )
  ) {
    throw new Error('remote budget priority 无效。');
  }
  assertTimestamp(record.startedAt, 'remote budget startedAt');
  assertTimestamp(record.endedAt, 'remote budget endedAt');
  if (Number(record.endedAt) < Number(record.startedAt)) {
    throw new Error('remote budget endedAt 不能早于 startedAt。');
  }
  if (record.purpose !== undefined && !AI_CALL_PURPOSES.includes(record.purpose as typeof AI_CALL_PURPOSES[number])) {
    throw new Error('remote budget purpose 无效。');
  }
  if (record.costRestricted !== undefined && (record.costRestricted !== true
    || !['inner-wants', 'inner-affect', 'home-status'].includes(String(record.purpose)))) {
    throw new Error('remote budget costRestricted 必须对应三卷请求。');
  }
}

// Completion advances one explicit-purpose request, never its identity or counted start.
export function mergeRemoteBudgetEventMetadata(left: RemoteBudgetEventRecord, right: RemoteBudgetEventRecord): RemoteBudgetEventRecord | null {
  if (left.id !== right.id || left.kind !== right.kind
    || left.priority !== right.priority || left.remoteAccountId !== right.remoteAccountId
    || left.startedAt !== right.startedAt || (left.purpose && right.purpose && left.purpose !== right.purpose)) return null;
  if (left.endedAt !== right.endedAt && !(left.purpose && right.purpose
    || left.purpose && right.endedAt === right.startedAt
    || right.purpose && left.endedAt === left.startedAt)) return null;
  const purpose = left.purpose ?? right.purpose;
  return { ...left, endedAt: Math.max(left.endedAt, right.endedAt), ...(purpose ? { purpose } : {}),
    ...(left.costRestricted || right.costRestricted ? { costRestricted: true as const } : {}) };
}

export function assertRemoteBudgetMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'usage'
    || value.entity.type !== REMOTE_BUDGET_ENTITY_TYPE
  ) {
    throw new Error('usage.remote-budget mutation entity 无效。');
  }
  if (value.revision.schemaVersion !== REMOTE_BUDGET_SCHEMA_VERSION) {
    throw new Error('usage.remote-budget schemaVersion 无效。');
  }
  if (value.revision.operation !== 'append') {
    throw new Error('usage.remote-budget 只接受 append。');
  }
  if (value.sensitivity !== 'high') {
    throw new Error('usage.remote-budget sensitivity 必须为 high。');
  }
  if (value.retentionClass !== REMOTE_BUDGET_RETENTION_CLASS) {
    throw new Error('usage.remote-budget retentionClass 无效。');
  }
  if (value.objectRefs.length) {
    throw new Error('usage.remote-budget 不接受对象引用。');
  }
  const payload = recordOf(value.payload, 'usage.remote-budget payload');
  assertExactKeys(
    payload,
    ['schemaVersion', 'kind', 'value'],
    'usage.remote-budget payload',
  );
  if (payload.schemaVersion !== REMOTE_BUDGET_SCHEMA_VERSION) {
    throw new Error('usage.remote-budget payload schemaVersion 无效。');
  }
  if (payload.kind !== REMOTE_BUDGET_RECORD_KIND) {
    throw new Error('usage.remote-budget kind 无效。');
  }
  assertRemoteBudgetEventRecord(value.entity.id, payload.value);
}

export function buildRemoteBudgetEventMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  value: RemoteBudgetEventRecord;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'usage',
      type: REMOTE_BUDGET_ENTITY_TYPE,
      id: input.value.id,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'append',
      schemaVersion: REMOTE_BUDGET_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: REMOTE_BUDGET_SCHEMA_VERSION,
      kind: REMOTE_BUDGET_RECORD_KIND,
      value: input.value as unknown as JsonValue,
    },
    objectRefs: [],
    retentionClass: REMOTE_BUDGET_RETENTION_CLASS,
  };
  assertRemoteBudgetMutationV1(mutation);
  return mutation;
}
