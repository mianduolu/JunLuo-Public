import {
  assertReadingObjectsMutationV1,
  READING_OBJECTS_RETENTION_CLASS,
  READING_OBJECTS_SCHEMA_VERSION,
  type ReadingObjectEntityType,
  type ReadingObjectRecord,
} from './syncReadingObjects';
import type {
  JsonValue,
  PlainMutationV1,
  SyncOperation,
} from './syncProtocol';

export type ReadingObjectsRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: SyncOperation;
  createdAt: number;
  payload: JsonValue;
};

export type ReadingObjectsMergeDecision =
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
      conflictKind: 'delete-modify' | 'object-link-divergence';
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
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left)) {
    return Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => compareJson(item, right[index]));
  }
  if (typeof left !== 'object' || Array.isArray(right)) return false;
  const leftRecord = left as JsonRecord;
  const rightRecord = right as JsonRecord;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index]
      && compareJson(leftRecord[key], rightRecord[key]));
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function selectRevision(
  current: ReadingObjectsRevisionValue,
  incoming: ReadingObjectsRevisionValue,
) {
  if (current.createdAt !== incoming.createdAt) {
    return current.createdAt > incoming.createdAt ? current : incoming;
  }
  return current.revisionId.localeCompare(incoming.revisionId) >= 0
    ? current
    : incoming;
}

function objectRecord(revision: ReadingObjectsRevisionValue) {
  if (revision.operation === 'delete') return null;
  const payload = recordOf(revision.payload, 'reading object revision payload');
  if (payload.kind !== 'object-link') {
    throw new Error('reading object revision kind 无效。');
  }
  return recordOf(payload.value, 'reading object revision value');
}

function objectRefs(revision: ReadingObjectsRevisionValue) {
  const record = objectRecord(revision);
  return record ? [record.objectId as string] : [];
}

function assertRevision(
  entityType: ReadingObjectEntityType,
  entityId: string,
  revision: ReadingObjectsRevisionValue,
) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: '10000000-0000-4000-8000-000000000001',
    vaultId: '20000000-0000-4000-8000-000000000002',
    sourceDeviceId: '30000000-0000-4000-8000-000000000003',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'reading',
      type: entityType,
      id: entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: revision.parentRevisionIds,
      operation: revision.operation,
      schemaVersion: READING_OBJECTS_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: revision.payload,
    objectRefs: objectRefs(revision),
    retentionClass: READING_OBJECTS_RETENTION_CLASS,
  };
  assertReadingObjectsMutationV1(mutation);
}

function changedFields(left: JsonRecord, right: JsonRecord) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((field) => !compareJson(left[field], right[field]))
    .sort();
}

export function resolveReadingObjectsRevisions(input: {
  entityType: ReadingObjectEntityType;
  entityId: string;
  current: ReadingObjectsRevisionValue | null;
  incoming: ReadingObjectsRevisionValue;
}): ReadingObjectsMergeDecision {
  assertRevision(input.entityType, input.entityId, input.incoming);
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertRevision(input.entityType, input.entityId, input.current);
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.current.parentRevisionIds.includes(input.incoming.revisionId)) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.incoming.parentRevisionIds.includes(input.current.revisionId)) {
    if (
      input.current.operation === 'delete'
      && input.incoming.operation !== 'restore'
    ) {
      const heads = uniqueSorted([
        input.current.revisionId,
        input.incoming.revisionId,
      ]);
      return {
        kind: 'keep-current',
        payload: input.current.payload,
        operation: 'delete',
        resultingHeadRevisionIds: heads,
        requiresMergeRevision: true,
        mergeParentRevisionIds: heads,
      };
    }
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  const heads = uniqueSorted([
    input.current.revisionId,
    input.incoming.revisionId,
  ]);
  const currentDeleted = input.current.operation === 'delete';
  const incomingDeleted = input.incoming.operation === 'delete';
  if (currentDeleted || incomingDeleted) {
    if (currentDeleted && incomingDeleted) {
      const selected = selectRevision(input.current, input.incoming);
      return {
        kind: selected === input.current ? 'keep-current' : 'merged',
        payload: selected.payload,
        operation: 'delete',
        resultingHeadRevisionIds: heads,
        requiresMergeRevision: true,
        mergeParentRevisionIds: heads,
      };
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
  const currentValue = objectRecord(input.current) as unknown as ReadingObjectRecord;
  const incomingValue = objectRecord(input.incoming) as unknown as ReadingObjectRecord;
  if (compareJson(
    currentValue as unknown as JsonValue,
    incomingValue as unknown as JsonValue,
  )) {
    return {
      kind: 'keep-current',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: heads,
      requiresMergeRevision: true,
      mergeParentRevisionIds: heads,
    };
  }
  const selected = selectRevision(input.current, input.incoming);
  return {
    kind: 'conflict',
    payload: selected.payload,
    operation: selected.operation,
    resultingHeadRevisionIds: heads,
    conflictKind: 'object-link-divergence',
    conflictingFields: changedFields(
      currentValue as unknown as JsonRecord,
      incomingValue as unknown as JsonRecord,
    ),
  };
}
