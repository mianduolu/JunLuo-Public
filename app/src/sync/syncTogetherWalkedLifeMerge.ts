import {
  assertTogetherWalkedLifeMutationV1,
  TOGETHER_WALKED_LIFE_RETENTION_CLASS,
  TOGETHER_WALKED_LIFE_SCHEMA_VERSION,
  type TogetherWalkedLifeEntityType,
} from './syncTogetherWalkedLife';
import type {
  JsonValue,
  PlainMutationV1,
  SyncOperation,
} from './syncProtocol';

export type TogetherWalkedLifeRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: SyncOperation;
  createdAt: number;
  payload: JsonValue;
};

export type TogetherWalkedLifeMergeDecision =
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
      conflictKind:
        | 'entry-divergence'
        | 'journey-divergence'
        | 'draft-divergence'
        | 'image-object-divergence';
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
    return Array.isArray(right)
      && left.length === right.length
      && left.every(
        (item, index) => compareJson(item, right[index]),
      );
  }
  if (typeof left !== 'object' || Array.isArray(right)) return false;
  const leftRecord = left as JsonRecord;
  const rightRecord = right as JsonRecord;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key, index) => (
        key === rightKeys[index]
        && compareJson(leftRecord[key], rightRecord[key])
      ),
    );
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function payloadRecord(revision: TogetherWalkedLifeRevisionValue) {
  if (revision.operation === 'delete') return null;
  const payload = recordOf(
    revision.payload,
    'together-walked revision payload',
  );
  return recordOf(
    payload.value,
    'together-walked revision value',
  );
}

function objectRefs(revision: TogetherWalkedLifeRevisionValue) {
  const payload = revision.operation === 'delete'
    ? null
    : recordOf(
        revision.payload,
        'together-walked revision payload',
      );
  if (!payload) return [];
  const value = recordOf(
    payload.value,
    'together-walked revision value',
  );
  const objectId = payload.kind === 'image-object'
    ? value.objectId
    : payload.kind === 'entry' || payload.kind === 'draft'
      ? value.imageObjectId
      : undefined;
  return typeof objectId === 'string' ? [objectId] : [];
}

function assertRevision(
  entityType: TogetherWalkedLifeEntityType,
  entityId: string,
  revision: TogetherWalkedLifeRevisionValue,
) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: '10000000-0000-4000-8000-000000000001',
    vaultId: '20000000-0000-4000-8000-000000000002',
    sourceDeviceId: '30000000-0000-4000-8000-000000000003',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'together-walked',
      type: entityType,
      id: entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: revision.parentRevisionIds,
      operation: revision.operation,
      schemaVersion: TOGETHER_WALKED_LIFE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: revision.payload,
    objectRefs: objectRefs(revision),
    retentionClass: TOGETHER_WALKED_LIFE_RETENTION_CLASS,
  };
  assertTogetherWalkedLifeMutationV1(mutation);
}

function mergedDecision(input: {
  selected: TogetherWalkedLifeRevisionValue;
  heads: string[];
  keepCurrent: boolean;
}): TogetherWalkedLifeMergeDecision {
  return {
    kind: input.keepCurrent ? 'keep-current' : 'merged',
    payload: input.selected.payload,
    operation: input.selected.operation,
    resultingHeadRevisionIds: input.heads,
    requiresMergeRevision: true,
    mergeParentRevisionIds: input.heads,
  };
}

function changedFields(left: JsonRecord, right: JsonRecord) {
  return [...new Set([
    ...Object.keys(left),
    ...Object.keys(right),
  ])].filter(
    (field) => !compareJson(left[field], right[field]),
  ).sort();
}

function conflictKind(entityType: TogetherWalkedLifeEntityType) {
  return `${entityType}-divergence` as
    | 'entry-divergence'
    | 'journey-divergence'
    | 'draft-divergence'
    | 'image-object-divergence';
}

export function resolveTogetherWalkedLifeRevisions(input: {
  entityType: TogetherWalkedLifeEntityType;
  entityId: string;
  current: TogetherWalkedLifeRevisionValue | null;
  incoming: TogetherWalkedLifeRevisionValue;
}): TogetherWalkedLifeMergeDecision {
  assertRevision(input.entityType, input.entityId, input.incoming);
  if (input.current === null) {
    if (input.incoming.operation === 'restore') {
      throw new Error(
        'together-walked.life restore 必须接在 tombstone 之后。',
      );
    }
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
      selected: input.current,
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
        selected: input.current,
        heads,
        keepCurrent: true,
      });
    }
    const currentValue = payloadRecord(input.current);
    const incomingValue = payloadRecord(input.incoming);
    if (
      currentValue
      && incomingValue
      && Number(incomingValue.updatedAt)
        < Number(currentValue.updatedAt)
    ) {
      return mergedDecision({
        selected: input.current,
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
    const deleted = currentDeleted ? input.current : input.incoming;
    return mergedDecision({
      selected: deleted,
      heads,
      keepCurrent: currentDeleted,
    });
  }
  const currentValue = payloadRecord(input.current)!;
  const incomingValue = payloadRecord(input.incoming)!;
  if (compareJson(currentValue, incomingValue)) {
    return mergedDecision({
      selected: input.current,
      heads,
      keepCurrent: true,
    });
  }
  const selected = (
    Number(currentValue.updatedAt)
      > Number(incomingValue.updatedAt)
    || (
      currentValue.updatedAt === incomingValue.updatedAt
      && input.current.revisionId.localeCompare(
        input.incoming.revisionId,
      ) >= 0
    )
  )
    ? input.current
    : input.incoming;
  return {
    kind: 'conflict',
    payload: selected.payload,
    operation: selected.operation,
    resultingHeadRevisionIds: heads,
    conflictKind: conflictKind(input.entityType),
    conflictingFields: changedFields(
      currentValue,
      incomingValue,
    ),
  };
}
