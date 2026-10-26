import {
  assertRelationshipAuthorizationMutationV1,
  relationshipAuthorizationMutationValue,
  type RelationshipAuthorizationField,
  type RelationshipAuthorizationFieldValue,
  type RelationshipContactPauseValue,
} from './syncRelationshipAuthorization';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type RelationshipAuthorizationRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityType: string;
  entityId: string;
  payload: JsonValue;
};

export type RelationshipAuthorizationMergeDecision = {
  kind:
    | 'already-current'
    | 'apply-incoming'
    | 'conflict'
    | 'ignore-incoming'
    | 'merged';
  payload: JsonValue;
  operation: 'upsert' | 'restore';
  resultingHeadRevisionIds: string[];
  conflictKind?:
    | 'authorization-preference-divergence'
    | 'safety-boundary-divergence';
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

function mutationOf(
  revision: RelationshipAuthorizationRevisionValue,
): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: '40000000-0000-4000-8000-000000000001',
    vaultId: '10000000-0000-4000-8000-000000000001',
    sourceDeviceId: '20000000-0000-4000-8000-000000000002',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'relationship',
      type: revision.entityType,
      id: revision.entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: revision.parentRevisionIds,
      operation: revision.operation,
      schemaVersion: 1,
    },
    sensitivity: 'highest',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: 'relationship-authorization',
  };
}

function valueOf(revision: RelationshipAuthorizationRevisionValue) {
  return relationshipAuthorizationMutationValue(mutationOf(revision));
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
}

function payloadWithValue(
  revision: RelationshipAuthorizationRevisionValue,
  value: RelationshipAuthorizationFieldValue,
) {
  const payload = revision.payload as Record<string, JsonValue>;
  return { ...payload, value } as JsonValue;
}

function sameValue(
  left: RelationshipAuthorizationFieldValue,
  right: RelationshipAuthorizationFieldValue,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergedDecision(input: {
  current: RelationshipAuthorizationRevisionValue;
  incoming: RelationshipAuthorizationRevisionValue;
  value: RelationshipAuthorizationFieldValue;
}): RelationshipAuthorizationMergeDecision {
  const heads = sortedHeads(
    input.current.revisionId,
    input.incoming.revisionId,
  );
  return {
    kind: 'merged',
    payload: payloadWithValue(input.current, input.value),
    operation: 'upsert',
    resultingHeadRevisionIds: heads,
    requiresMergeRevision: true,
    mergeParentRevisionIds: heads,
  };
}

export function resolveRelationshipAuthorizationRevisions(input: {
  current: RelationshipAuthorizationRevisionValue | null;
  incoming: RelationshipAuthorizationRevisionValue;
}): RelationshipAuthorizationMergeDecision {
  assertRelationshipAuthorizationMutationV1(mutationOf(input.incoming));
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation as 'upsert' | 'restore',
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertRelationshipAuthorizationMutationV1(mutationOf(input.current));
  if (
    input.current.entityType !== input.incoming.entityType
    || input.current.entityId !== input.incoming.entityId
  ) {
    throw new Error(
      'relationship.authorization 不能跨实体或字段合并 revision。',
    );
  }
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: input.current.operation as 'upsert' | 'restore',
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.current.parentRevisionIds.includes(input.incoming.revisionId)) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: input.current.operation as 'upsert' | 'restore',
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.current.entityId === 'contactPause') {
    const previous = valueOf(input.current) as RelationshipContactPauseValue;
    const incoming = valueOf(input.incoming) as RelationshipContactPauseValue;
    const newer = incoming.sourceAt - previous.sourceAt
      || (incoming.sourceMessageId === previous.sourceMessageId
        ? Number(incoming.sourceKind === 'explicit') - Number(previous.sourceKind === 'explicit') : 0);
    if (newer !== 0) return mergedDecision({ ...input, current: input.current, value: newer > 0 ? incoming : previous });
  }
  if (input.incoming.parentRevisionIds.includes(input.current.revisionId)) {
    if (input.current.entityId === 'dailyPlanningActivatedAt') {
      const left = valueOf(input.current); const right = valueOf(input.incoming);
      const earliest = left === null ? right : right === null ? left : Math.min(Number(left), Number(right));
      if (earliest !== right) return mergedDecision({ ...input, current: input.current, value: earliest });
    }
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation as 'upsert' | 'restore',
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }

  const currentValue = valueOf(input.current);
  const incomingValue = valueOf(input.incoming);
  if (sameValue(currentValue, incomingValue)) {
    return mergedDecision({
      ...input,
      current: input.current,
      value: currentValue,
    });
  }

  const field = input.current.entityId as RelationshipAuthorizationField;
  if (field === 'dailyPlanningActivatedAt') return mergedDecision({ ...input, current: input.current,
    value: currentValue === null ? incomingValue : incomingValue === null ? currentValue : Math.min(Number(currentValue), Number(incomingValue)),
  });
  if (typeof currentValue === 'boolean' && typeof incomingValue === 'boolean') {
    return mergedDecision({
      ...input,
      current: input.current,
      value: field === 'firstPromptAnswered'
        ? currentValue || incomingValue
        : currentValue && incomingValue,
    });
  }
  if (
    field === 'safeWord'
    && typeof currentValue === 'string'
    && typeof incomingValue === 'string'
  ) {
    if (!currentValue || !incomingValue) {
      return mergedDecision({
        ...input,
        current: input.current,
        value: currentValue || incomingValue,
      });
    }
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: sortedHeads(
        input.current.revisionId,
        input.incoming.revisionId,
      ),
      conflictKind: 'safety-boundary-divergence',
      conflictingFields: [field],
    };
  }
  return {
    kind: 'conflict',
    payload: input.current.payload,
    operation: 'upsert',
    resultingHeadRevisionIds: sortedHeads(
      input.current.revisionId,
      input.incoming.revisionId,
    ),
    conflictKind: 'authorization-preference-divergence',
    conflictingFields: [field],
  };
}
