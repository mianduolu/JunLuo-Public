import {
  assertWalletLedgerMutationV1,
  isWalletLedgerEntityType,
  WALLET_LEDGER_RETENTION_CLASS,
  WALLET_LEDGER_SCHEMA_VERSION,
  type WalletLedgerEntityType,
} from './syncWalletLedger';
import type {
  JsonValue,
  PlainMutationV1,
  SyncOperation,
} from './syncProtocol';

export type WalletLedgerRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: SyncOperation;
  createdAt: number;
  payload: JsonValue;
};

export type WalletLedgerMergeDecision =
  | {
      kind: 'already-current' | 'apply-incoming' | 'ignore-incoming';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
    }
  | {
      kind: 'merged';
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
      conflictKind:
        | 'append-only-rewrite'
        | 'append-identity-divergence'
        | 'cas-divergence'
        | 'decision-invalid-transition'
        | 'decision-transition-divergence';
      conflictingFields: string[];
    };

type JsonRecord = { [key: string]: JsonValue };

const APPEND_ONLY_KINDS: readonly WalletLedgerEntityType[] = [
  'transaction',
  'snapshot',
];

const DECISION_IMMUTABLE_FIELDS = [
  'id',
  'walletId',
  'fundCode',
  'fundName',
  'fundType',
  'action',
  'amount',
  'confidence',
  'reasoning',
  'riskWarning',
  'whyNotMore',
  'source',
  'suggestedNav',
  'suggestedNavSource',
  'suggestedNavAt',
  'createdAt',
] as const;

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
      && left.every((item, index) => compareJson(item, right[index]))
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
  entityType: WalletLedgerEntityType,
  entityId: string,
  revision: WalletLedgerRevisionValue,
) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: '10000000-0000-4000-8000-000000000001',
    vaultId: '20000000-0000-4000-8000-000000000002',
    sourceDeviceId: '30000000-0000-4000-8000-000000000003',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'wallet',
      type: entityType,
      id: entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: revision.parentRevisionIds,
      operation: revision.operation,
      schemaVersion: WALLET_LEDGER_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: WALLET_LEDGER_RETENTION_CLASS,
  };
  assertWalletLedgerMutationV1(mutation);
}

function payloadRecord(revision: WalletLedgerRevisionValue) {
  return recordOf(
    recordOf(revision.payload, 'wallet revision payload').record,
    'wallet revision record',
  );
}

function changedFields(left: JsonRecord, right: JsonRecord) {
  return [...new Set([
    ...Object.keys(left),
    ...Object.keys(right),
  ])].filter(
    (field) => !compareJson(left[field], right[field]),
  ).sort();
}

function decisionTransitionAllowed(
  current: JsonRecord,
  incoming: JsonRecord,
) {
  if (
    DECISION_IMMUTABLE_FIELDS.some(
      (field) => !compareJson(current[field], incoming[field]),
    )
  ) {
    return false;
  }
  const currentStatus = current.status;
  const incomingStatus = incoming.status;
  if (
    typeof currentStatus !== 'string'
    || typeof incomingStatus !== 'string'
  ) {
    return false;
  }
  if (currentStatus === incomingStatus) return true;
  if (currentStatus === 'proposed') {
    return [
      'approved',
      'rejected',
      'deferred',
      'executed',
      'expired',
      'blocked',
    ].includes(incomingStatus);
  }
  return currentStatus === 'approved' && incomingStatus === 'executed';
}

function conflict(input: {
  current: WalletLedgerRevisionValue;
  incoming: WalletLedgerRevisionValue;
  conflictKind: Extract<
    WalletLedgerMergeDecision,
    { kind: 'conflict' }
  >['conflictKind'];
  conflictingFields: string[];
}): WalletLedgerMergeDecision {
  return {
    kind: 'conflict',
    payload: input.current.payload,
    operation: input.current.operation,
    resultingHeadRevisionIds: uniqueSorted([
      input.current.revisionId,
      input.incoming.revisionId,
    ]),
    conflictKind: input.conflictKind,
    conflictingFields: input.conflictingFields,
  };
}

function merged(
  current: WalletLedgerRevisionValue,
  incoming: WalletLedgerRevisionValue,
): WalletLedgerMergeDecision {
  const heads = uniqueSorted([
    current.revisionId,
    incoming.revisionId,
  ]);
  return {
    kind: 'merged',
    payload: current.payload,
    operation: current.operation,
    resultingHeadRevisionIds: heads,
    requiresMergeRevision: true,
    mergeParentRevisionIds: heads,
  };
}

export function resolveWalletLedgerRevisions(input: {
  entityType: string;
  entityId: string;
  current: WalletLedgerRevisionValue | null;
  incoming: WalletLedgerRevisionValue;
}): WalletLedgerMergeDecision {
  if (!isWalletLedgerEntityType(input.entityType)) {
    throw new Error('wallet.ledger merge entity type 无效。');
  }
  const entityType = input.entityType;
  assertRevision(entityType, input.entityId, input.incoming);
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertRevision(entityType, input.entityId, input.current);
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
  const currentRecord = payloadRecord(input.current);
  const incomingRecord = payloadRecord(input.incoming);
  const fields = changedFields(currentRecord, incomingRecord);
  if (
    input.incoming.parentRevisionIds.includes(
      input.current.revisionId,
    )
  ) {
    if (APPEND_ONLY_KINDS.includes(entityType)) {
      if (compareJson(currentRecord, incomingRecord)) {
        return {
          kind: 'ignore-incoming',
          payload: input.current.payload,
          operation: input.current.operation,
          resultingHeadRevisionIds: [input.current.revisionId],
        };
      }
      return conflict({
        current: input.current,
        incoming: input.incoming,
        conflictKind: 'append-only-rewrite',
        conflictingFields: fields,
      });
    }
    if (
      entityType === 'decision'
      && !decisionTransitionAllowed(currentRecord, incomingRecord)
    ) {
      return conflict({
        current: input.current,
        incoming: input.incoming,
        conflictKind: 'decision-invalid-transition',
        conflictingFields: fields,
      });
    }
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  if (compareJson(currentRecord, incomingRecord)) {
    return merged(input.current, input.incoming);
  }
  if (APPEND_ONLY_KINDS.includes(entityType)) {
    return conflict({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'append-identity-divergence',
      conflictingFields: fields,
    });
  }
  if (entityType === 'decision') {
    return conflict({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'decision-transition-divergence',
      conflictingFields: fields,
    });
  }
  return conflict({
    current: input.current,
    incoming: input.incoming,
    conflictKind: 'cas-divergence',
    conflictingFields: fields,
  });
}
