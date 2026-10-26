import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const EXPENSE_LEDGER_ADAPTER_ID = 'expense.ledger' as const;
export const EXPENSE_LEDGER_SCHEMA_VERSION = 2 as const;
export type ExpenseLedgerSchemaVersion = 1 | 2;
export const EXPENSE_LEDGER_RETENTION_CLASS =
  'financial-ledger' as const;
export const EXPENSE_LEDGER_ENTITY_TYPE = 'expense-entry' as const;

export type ExpenseLedgerRecord = {
  id: string;
  type: 'expense' | 'income' | 'refund';
  amount: number;
  category: string;
  note: string;
  occurredAt: number;
  source: 'manual' | 'chat';
  createdAt: number;
  updatedAt: number;
  originalExpenseId?: string | null;
};

export type ExpenseLedgerPayloadV1 =
  | {
      schemaVersion: ExpenseLedgerSchemaVersion;
      kind: typeof EXPENSE_LEDGER_ENTITY_TYPE;
      record: ExpenseLedgerRecord;
    }
  | {
      schemaVersion: ExpenseLedgerSchemaVersion;
      kind: typeof EXPENSE_LEDGER_ENTITY_TYPE;
      deletedAt: number;
    };

type UnknownRecord = Record<string, unknown>;

function recordOf(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as UnknownRecord;
}

function assertExactKeys(
  record: UnknownRecord,
  keys: readonly string[],
  label: string,
) {
  const expected = new Set(keys);
  const extras = Object.keys(record).filter(
    (key) => !expected.has(key),
  );
  const missing = keys.filter((key) => !(key in record));
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

function assertAmount(value: unknown) {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('expense amount 必须是非负有限数值。');
  }
}

export function expenseLedgerEntityId(localId: string) {
  assertLocalId(localId, 'expense local id');
  return `expense-entry:${localId}`;
}

export function expenseLedgerLocalId(entityId: string) {
  assertString(entityId, 'expense entity id', 256);
  const prefix = 'expense-entry:';
  if (!entityId.startsWith(prefix)) {
    throw new Error('expense.ledger entity id 前缀无效。');
  }
  const localId = entityId.slice(prefix.length);
  assertLocalId(localId, 'expense local id');
  return localId;
}

export function assertExpenseLedgerRecord(
  entityId: string,
  value: unknown,
  schemaVersion: ExpenseLedgerSchemaVersion = EXPENSE_LEDGER_SCHEMA_VERSION,
): asserts value is ExpenseLedgerRecord {
  const record = recordOf(value, 'expense ledger record');
  assertExactKeys(record, [
    'id',
    'type',
    'amount',
    'category',
    'note',
    'occurredAt',
    'source',
    'createdAt',
    'updatedAt',
    ...(schemaVersion === 2 && 'originalExpenseId' in record
      ? ['originalExpenseId'] : []),
  ], 'expense ledger record');
  assertLocalId(record.id, 'expense record id');
  if (expenseLedgerEntityId(record.id) !== entityId) {
    throw new Error('expense record id 与 entity id 不一致。');
  }
  if (
    record.type !== 'expense' && record.type !== 'income'
    && !(schemaVersion === 2 && record.type === 'refund')
  ) {
    throw new Error('expense type 无效。');
  }
  assertAmount(record.amount);
  if (record.type === 'refund' && (record.amount as number) <= 0) {
    throw new Error('refund amount 必须大于零。');
  }
  if (record.originalExpenseId != null) {
    assertLocalId(record.originalExpenseId, 'expense originalExpenseId');
    if (record.type !== 'refund' || record.originalExpenseId === record.id) {
      throw new Error('expense originalExpenseId 关联无效。');
    }
  }
  assertString(record.category, 'expense category', 10_000, true);
  assertString(record.note, 'expense note', 850_000, true);
  assertTimestamp(record.occurredAt, 'expense occurredAt');
  if (record.source !== 'manual' && record.source !== 'chat') {
    throw new Error('expense source 无效。');
  }
  assertTimestamp(record.createdAt, 'expense createdAt');
  assertTimestamp(record.updatedAt, 'expense updatedAt');
}

export function assertExpenseLedgerPayload(
  entityId: string,
  operation: string,
  value: unknown,
): asserts value is ExpenseLedgerPayloadV1 {
  const payload = recordOf(value, 'expense.ledger payload');
  if (
    (payload.schemaVersion !== 1 && payload.schemaVersion !== 2)
    || payload.kind !== EXPENSE_LEDGER_ENTITY_TYPE
  ) {
    throw new Error('expense.ledger payload 版本或 kind 无效。');
  }
  expenseLedgerLocalId(entityId);
  if (operation === 'delete') {
    assertExactKeys(
      payload,
      ['schemaVersion', 'kind', 'deletedAt'],
      'expense delete payload',
    );
    assertTimestamp(payload.deletedAt, 'expense deletedAt');
    return;
  }
  if (operation !== 'upsert' && operation !== 'restore') {
    throw new Error(
      'expense.ledger 只允许 upsert、restore 或 delete。',
    );
  }
  assertExactKeys(
    payload,
    ['schemaVersion', 'kind', 'record'],
    'expense record payload',
  );
  assertExpenseLedgerRecord(entityId, payload.record, payload.schemaVersion);
}

export function assertExpenseLedgerMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'expense'
    || value.entity.type !== EXPENSE_LEDGER_ENTITY_TYPE
  ) {
    throw new Error('expense.ledger mutation entity 无效。');
  }
  if (
    value.revision.schemaVersion !== 1 && value.revision.schemaVersion !== 2
  ) {
    throw new Error('expense.ledger schemaVersion 无效。');
  }
  if (
    value.revision.operation !== 'upsert'
    && value.revision.operation !== 'restore'
    && value.revision.operation !== 'delete'
  ) {
    throw new Error('expense.ledger operation 无效。');
  }
  if (
    value.sensitivity !== 'highest'
    || value.retentionClass !== EXPENSE_LEDGER_RETENTION_CLASS
  ) {
    throw new Error('expense.ledger 最高敏留存合同无效。');
  }
  if (value.objectRefs.length !== 0) {
    throw new Error('expense.ledger 不接受对象引用。');
  }
  assertExpenseLedgerPayload(
    value.entity.id,
    value.revision.operation,
    value.payload,
  );
  if ((value.payload as { schemaVersion: number }).schemaVersion
      !== value.revision.schemaVersion) {
    throw new Error('expense.ledger payload 与 revision 版本不一致。');
  }
}

export function expenseLedgerPayload(mutation: PlainMutationV1) {
  assertExpenseLedgerMutationV1(mutation);
  return mutation.payload as ExpenseLedgerPayloadV1;
}

export function buildExpenseLedgerMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityId: string;
  operation: 'upsert' | 'restore' | 'delete';
  payload: ExpenseLedgerPayloadV1;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'expense',
      type: EXPENSE_LEDGER_ENTITY_TYPE,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: input.operation,
      schemaVersion: input.payload.schemaVersion,
    },
    sensitivity: 'highest',
    payload: input.payload,
    objectRefs: [],
    retentionClass: EXPENSE_LEDGER_RETENTION_CLASS,
  };
  assertExpenseLedgerMutationV1(mutation);
  return mutation;
}

export function expenseLedgerRecordPayload(input: {
  entityId: string;
  record: JsonValue & Record<string, JsonValue>;
}): ExpenseLedgerPayloadV1 {
  assertExpenseLedgerRecord(input.entityId, input.record);
  return {
    schemaVersion: EXPENSE_LEDGER_SCHEMA_VERSION,
    kind: EXPENSE_LEDGER_ENTITY_TYPE,
    record: input.record as ExpenseLedgerRecord,
  };
}

export function expenseLedgerDeletePayload(input: {
  entityId: string;
  deletedAt: number;
}): ExpenseLedgerPayloadV1 {
  expenseLedgerLocalId(input.entityId);
  assertTimestamp(input.deletedAt, 'expense deletedAt');
  return {
    schemaVersion: EXPENSE_LEDGER_SCHEMA_VERSION,
    kind: EXPENSE_LEDGER_ENTITY_TYPE,
    deletedAt: input.deletedAt,
  };
}
