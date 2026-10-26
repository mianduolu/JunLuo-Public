import {
  assertBehaviorRoutingMutationV1,
} from './syncBehaviorRouting';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type BehaviorRoutingRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityId: string;
  payload: JsonValue;
};

export type BehaviorRoutingMergeDecision = {
  kind:
    | 'already-current'
    | 'apply-incoming'
    | 'conflict'
    | 'ignore-incoming'
    | 'merged';
  payload: JsonValue;
  operation: 'upsert' | 'delete';
  resultingHeadRevisionIds: string[];
  conflictKind?:
    | 'routing-setting-divergence'
    | 'routing-delete-modify';
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

function mutationOf(
  revision: BehaviorRoutingRevisionValue,
): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: '40000000-0000-4000-8000-000000000001',
    vaultId: '10000000-0000-4000-8000-000000000001',
    sourceDeviceId: '20000000-0000-4000-8000-000000000002',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'behavior',
      type: 'logical-route',
      id: revision.entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: revision.parentRevisionIds,
      operation: revision.operation,
      schemaVersion: 1,
    },
    sensitivity: 'high',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: 'behavior-routing-setting',
  };
}

function assertRevision(revision: BehaviorRoutingRevisionValue) {
  assertBehaviorRoutingMutationV1(mutationOf(revision));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
}

export function resolveBehaviorRoutingRevisions(input: {
  current: BehaviorRoutingRevisionValue | null;
  incoming: BehaviorRoutingRevisionValue;
}): BehaviorRoutingMergeDecision {
  assertRevision(input.incoming);
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation as 'upsert' | 'delete',
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertRevision(input.current);
  if (input.current.entityId !== input.incoming.entityId) {
    throw new Error('behavior.routing 不能跨字段合并 revision。');
  }
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: input.current.operation as 'upsert' | 'delete',
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.current.parentRevisionIds.includes(input.incoming.revisionId)) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: input.current.operation as 'upsert' | 'delete',
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.incoming.parentRevisionIds.includes(input.current.revisionId)) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation as 'upsert' | 'delete',
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  const heads = sortedHeads(
    input.current.revisionId,
    input.incoming.revisionId,
  );
  if (
    input.current.operation === input.incoming.operation
    && stableJson(input.current.payload) === stableJson(input.incoming.payload)
  ) {
    return {
      kind: 'merged',
      payload: input.current.payload,
      operation: input.current.operation as 'upsert' | 'delete',
      resultingHeadRevisionIds: heads,
      requiresMergeRevision: true,
      mergeParentRevisionIds: heads,
    };
  }
  const deleteModify =
    input.current.operation === 'delete'
    || input.incoming.operation === 'delete';
  const deleted = input.current.operation === 'delete'
    ? input.current
    : input.incoming;
  return {
    kind: 'conflict',
    payload: deleteModify ? deleted.payload : input.current.payload,
    operation: deleteModify ? 'delete' : 'upsert',
    resultingHeadRevisionIds: heads,
    conflictKind: deleteModify
      ? 'routing-delete-modify'
      : 'routing-setting-divergence',
    conflictingFields: [input.current.entityId],
  };
}
