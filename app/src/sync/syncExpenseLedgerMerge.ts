import {
  assertExpenseLedgerMutationV1,
  EXPENSE_LEDGER_RETENTION_CLASS,
} from './syncExpenseLedger';
import type {
  JsonValue,
  PlainMutationV1,
  SyncOperation,
} from './syncProtocol';

export type ExpenseLedgerRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: SyncOperation;
  createdAt: number;
  payload: JsonValue;
  schemaVersion?: number;
};

export type ExpenseLedgerMergeDecision =
  | {
      kind: 'already-current' | 'apply-incoming' | 'ignore-incoming';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
    }
  | {
      kind: 'keep-current' | 'merged';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
      requiresMergeRevision: true;
      mergeParentRevisionIds: string[];
    }
  | {
      kind: 'conflict';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
      conflictKind: 'delete-modify' | 'entry-field-divergence';
      conflictingFields: string[];
    };

type JsonRecord = { [key: string]: JsonValue };

function recordOf(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as JsonRecord;
}

function compareJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (
    left === null
    || right === null
    || typeof left !== typeof right
  ) {
    return false;
  }
  if (Array.isArray(left)) {
    return (
      Array.isArray(right)
      && left.length === right.length
      && left.every(
        (item, index) => compareJson(item, right[index]),
      )
    );
  }
  if (typeof left !== 'object' || Array.isArray(right)) return false;
  const leftRecord = left as JsonRecord;
  const rightRecord = right as JsonRecord;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key, index) => (
        key === rightKeys[index]
        && compareJson(leftRecord[key], rightRecord[key])
      ),
    )
  );
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function assertRevision(
  entityId: string,
  revision: ExpenseLedgerRevisionValue,
) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: '10000000-0000-4000-8000-000000000001',
    vaultId: '20000000-0000-4000-8000-000000000002',
    sourceDeviceId: '30000000-0000-4000-8000-000000000003',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'expense',
      type: 'expense-entry',
      id: entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: revision.parentRevisionIds,
      operation: revision.operation,
      schemaVersion: revision.schemaVersion
        ?? Number(recordOf(revision.payload, 'expense payload').schemaVersion),
    },
    sensitivity: 'highest',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: EXPENSE_LEDGER_RETENTION_CLASS,
  };
  assertExpenseLedgerMutationV1(mutation);
}

function payloadRecord(revision: ExpenseLedgerRevisionValue) {
  const record = recordOf(
    recordOf(
      revision.payload,
      'expense revision payload',
    ).record,
    'expense revision record',
  );
  return { ...record, originalExpenseId: record.originalExpenseId ?? null };
}

function changedFields(left: JsonRecord, right: JsonRecord) {
  return [...new Set([
    ...Object.keys(left),
    ...Object.keys(right),
  ])].filter(
    (field) => !compareJson(left[field], right[field]),
  ).sort();
}

function mergedDecision(input: {
  payload: JsonValue;
  operation: SyncOperation;
  heads: string[];
  keepCurrent?: boolean;
}): ExpenseLedgerMergeDecision {
  return {
    kind: input.keepCurrent ? 'keep-current' : 'merged',
    payload: input.payload,
    operation: input.operation,
    resultingHeadRevisionIds: input.heads,
    requiresMergeRevision: true,
    mergeParentRevisionIds: input.heads,
  };
}

export function resolveExpenseLedgerRevisions(input: {
  entityId: string;
  current: ExpenseLedgerRevisionValue | null;
  incoming: ExpenseLedgerRevisionValue;
}): ExpenseLedgerMergeDecision {
  assertRevision(input.entityId, input.incoming);
  if (input.current === null) {
    if (input.incoming.operation === 'restore') {
      throw new Error(
        'expense.ledger restore 必须接在 tombstone 之后。',
      );
    }
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertRevision(input.entityId, input.current);
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (
    input.current.parentRevisionIds.includes(
      input.incoming.revisionId,
    )
  ) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  const heads = uniqueSorted([
    input.current.revisionId,
    input.incoming.revisionId,
  ]);
  if (
    input.incoming.operation === 'restore'
    && input.current.operation !== 'delete'
  ) {
    return mergedDecision({
      payload: input.current.payload,
      operation: input.current.operation,
      heads,
      keepCurrent: true,
    });
  }
  if (
    input.incoming.parentRevisionIds.includes(
      input.current.revisionId,
    )
  ) {
    if (
      input.current.operation === 'delete'
      && input.incoming.operation !== 'restore'
    ) {
      return mergedDecision({
        payload: input.current.payload,
        operation: 'delete',
        heads,
        keepCurrent: true,
      });
    }
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  const currentDeleted = input.current.operation === 'delete';
  const incomingDeleted = input.incoming.operation === 'delete';
  if (currentDeleted || incomingDeleted) {
    if (currentDeleted && incomingDeleted) {
      const currentWins = (
        input.current.createdAt > input.incoming.createdAt
        || (
          input.current.createdAt === input.incoming.createdAt
          && input.current.revisionId.localeCompare(
            input.incoming.revisionId,
          ) >= 0
        )
      );
      const selected = currentWins ? input.current : input.incoming;
      return mergedDecision({
        payload: selected.payload,
        operation: 'delete',
        heads,
        keepCurrent: currentWins,
      });
    }
    const deleted = currentDeleted ? input.current : input.incoming;
    return {
      kind: 'conflict',
      payload: deleted.payload,
      operation: 'delete',
      resultingHeadRevisionIds: heads,
      conflictKind: 'delete-modify',
      conflictingFields: [],
    };
  }
  const currentRecord = payloadRecord(input.current);
  const incomingRecord = payloadRecord(input.incoming);
  if (compareJson(currentRecord, incomingRecord)) {
    return mergedDecision({
      payload: input.current.payload,
      operation: input.current.operation,
      heads,
    });
  }
  return {
    kind: 'conflict',
    payload: input.current.payload,
    operation: input.current.operation,
    resultingHeadRevisionIds: heads,
    conflictKind: 'entry-field-divergence',
    conflictingFields: changedFields(
      currentRecord,
      incomingRecord,
    ),
  };
}
