import {
  assertPersonaExpressionObjectsMutationV1,
  assertPersonaExpressionObjectsRecord,
  PERSONA_EXPRESSION_OBJECTS_RETENTION_CLASS,
  PERSONA_EXPRESSION_OBJECTS_SCHEMA_VERSION,
  type PersonaExpressionObjectsEntityType,
  type PersonaExpressionObjectsRecordKind,
  type PersonaStickerMetadataRecord,
} from './syncPersonaExpressionObjects';
import type {
  JsonValue,
  PlainMutationV1,
  SyncOperation,
} from './syncProtocol';

export type PersonaExpressionObjectsRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: SyncOperation;
  createdAt: number;
  payload: JsonValue;
};

export type PersonaExpressionObjectsMergeDecision =
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
        | 'delete-modify'
        | 'expression-field-divergence'
        | 'sticker-metadata-divergence';
      conflictingFields: string[];
    };

type JsonRecord = { [key: string]: JsonValue };

function recordOf(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as JsonRecord;
}

function payloadKind(revision: PersonaExpressionObjectsRevisionValue) {
  if (revision.operation === 'delete') return null;
  const kind = recordOf(revision.payload, 'expression revision payload').kind;
  if (kind !== 'expression-field' && kind !== 'sticker-metadata') {
    throw new Error('persona.expression-objects revision kind 无效。');
  }
  return kind;
}

function payloadValue(revision: PersonaExpressionObjectsRevisionValue) {
  return recordOf(
    recordOf(revision.payload, 'expression revision payload').value,
    'expression revision value',
  );
}

function compareJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) {
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

function selectRevision(
  current: PersonaExpressionObjectsRevisionValue,
  incoming: PersonaExpressionObjectsRevisionValue,
) {
  if (current.createdAt !== incoming.createdAt) {
    return current.createdAt > incoming.createdAt ? current : incoming;
  }
  return current.revisionId.localeCompare(incoming.revisionId) >= 0
    ? current
    : incoming;
}

function objectRefsForRevision(
  revision: PersonaExpressionObjectsRevisionValue,
) {
  if (revision.operation === 'delete') return [];
  const payload = recordOf(revision.payload, 'expression revision payload');
  if (payload.kind !== 'sticker-metadata') return [];
  const value = recordOf(payload.value, 'sticker revision value');
  return [value.objectId as string];
}

function assertRevision(
  entityType: PersonaExpressionObjectsEntityType,
  entityId: string,
  revision: PersonaExpressionObjectsRevisionValue,
) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: '10000000-0000-4000-8000-000000000001',
    vaultId: '20000000-0000-4000-8000-000000000002',
    sourceDeviceId: '30000000-0000-4000-8000-000000000003',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'persona',
      type: entityType,
      id: entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: revision.parentRevisionIds,
      operation: revision.operation,
      schemaVersion: PERSONA_EXPRESSION_OBJECTS_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: revision.payload,
    objectRefs: objectRefsForRevision(revision),
    retentionClass: PERSONA_EXPRESSION_OBJECTS_RETENTION_CLASS,
  };
  assertPersonaExpressionObjectsMutationV1(mutation);
}

function changedFields(left: JsonRecord, right: JsonRecord) {
  return [...new Set([
    ...Object.keys(left),
    ...Object.keys(right),
  ])].filter(
    (field) => !compareJson(left[field], right[field]),
  ).sort();
}

function concurrentRecordDecision(input: {
  entityId: string;
  current: PersonaExpressionObjectsRevisionValue;
  incoming: PersonaExpressionObjectsRevisionValue;
  heads: string[];
}): PersonaExpressionObjectsMergeDecision {
  const currentKind = payloadKind(input.current);
  const incomingKind = payloadKind(input.incoming);
  if (!currentKind || currentKind !== incomingKind) {
    throw new Error('persona.expression-objects 并发 record kind 不一致。');
  }
  const currentValue = payloadValue(input.current);
  const incomingValue = payloadValue(input.incoming);
  assertPersonaExpressionObjectsRecord(
    currentKind,
    input.entityId,
    currentValue,
  );
  assertPersonaExpressionObjectsRecord(
    incomingKind,
    input.entityId,
    incomingValue,
  );
  if (compareJson(currentValue, incomingValue)) {
    return {
      kind: 'keep-current',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: input.heads,
      requiresMergeRevision: true,
      mergeParentRevisionIds: input.heads,
    };
  }
  const selected = selectRevision(input.current, input.incoming);
  return {
    kind: 'conflict',
    payload: selected.payload,
    operation: selected.operation,
    resultingHeadRevisionIds: input.heads,
    conflictKind: currentKind === 'expression-field'
      ? 'expression-field-divergence'
      : 'sticker-metadata-divergence',
    conflictingFields: currentKind === 'expression-field'
      ? ['text']
      : changedFields(currentValue, incomingValue),
  };
}

export function resolvePersonaExpressionObjectsRevisions(input: {
  entityType: PersonaExpressionObjectsEntityType;
  entityId: string;
  current: PersonaExpressionObjectsRevisionValue | null;
  incoming: PersonaExpressionObjectsRevisionValue;
}): PersonaExpressionObjectsMergeDecision {
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
  return concurrentRecordDecision({
    entityId: input.entityId,
    current: input.current,
    incoming: input.incoming,
    heads,
  });
}
