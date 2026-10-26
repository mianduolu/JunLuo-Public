import {
  AI_LOGICAL_CONFIG_RETENTION,
  assertAiLogicalConfigMutationV1,
  aiLogicalConfigMutationValue,
} from './syncAiLogicalConfig';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type AiLogicalConfigRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityType: string;
  entityId: string;
  payload: JsonValue;
};

export type AiLogicalConfigMergeDecision = {
  kind:
    | 'already-current'
    | 'apply-incoming'
    | 'conflict'
    | 'ignore-incoming'
    | 'merged';
  payload: JsonValue;
  operation: 'upsert' | 'restore' | 'delete';
  resultingHeadRevisionIds: string[];
  conflictKind?:
    | 'ai-logical-config-divergence'
    | 'ai-logical-config-delete-edit';
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

function mutationOf(
  revision: AiLogicalConfigRevisionValue,
): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: '40000000-0000-4000-8000-000000000001',
    vaultId: '10000000-0000-4000-8000-000000000001',
    sourceDeviceId: '20000000-0000-4000-8000-000000000002',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'ai-config',
      type: revision.entityType,
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
    retentionClass: AI_LOGICAL_CONFIG_RETENTION,
  };
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
}

function operationOf(
  revision: AiLogicalConfigRevisionValue,
): 'upsert' | 'restore' | 'delete' {
  if (
    revision.operation === 'upsert'
    || revision.operation === 'restore'
    || revision.operation === 'delete'
  ) {
    return revision.operation;
  }
  throw new Error('ai.logical-config merge operation 无效。');
}

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'updatedAt')
      .map(([key, nested]) => [key, comparable(nested)]),
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function valueOf(revision: AiLogicalConfigRevisionValue) {
  return aiLogicalConfigMutationValue(mutationOf(revision)).value;
}

function differingFields(
  current: AiLogicalConfigRevisionValue,
  incoming: AiLogicalConfigRevisionValue,
) {
  const left = comparable(valueOf(current)) as Record<string, unknown> | undefined;
  const right = comparable(valueOf(incoming)) as Record<string, unknown> | undefined;
  if (!left || !right) return ['*'];
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => canonicalJson(left[key]) !== canonicalJson(right[key]))
    .sort();
}

export function resolveAiLogicalConfigRevisions(input: {
  current: AiLogicalConfigRevisionValue | null;
  incoming: AiLogicalConfigRevisionValue;
}): AiLogicalConfigMergeDecision {
  assertAiLogicalConfigMutationV1(mutationOf(input.incoming));
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: operationOf(input.incoming),
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertAiLogicalConfigMutationV1(mutationOf(input.current));
  if (
    input.current.entityType !== input.incoming.entityType
    || input.current.entityId !== input.incoming.entityId
  ) {
    throw new Error('ai.logical-config 不能跨实体合并 revision。');
  }
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: operationOf(input.current),
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.current.parentRevisionIds.includes(input.incoming.revisionId)) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: operationOf(input.current),
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.incoming.parentRevisionIds.includes(input.current.revisionId)) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: operationOf(input.incoming),
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  const heads = sortedHeads(
    input.current.revisionId,
    input.incoming.revisionId,
  );
  const currentDelete = input.current.operation === 'delete';
  const incomingDelete = input.incoming.operation === 'delete';
  if (currentDelete !== incomingDelete) {
    return {
      kind: 'conflict',
      payload: currentDelete
        ? input.current.payload
        : input.incoming.payload,
      operation: 'delete',
      resultingHeadRevisionIds: heads,
      conflictKind: 'ai-logical-config-delete-edit',
      conflictingFields: ['*'],
    };
  }
  const same = canonicalJson(comparable(valueOf(input.current)))
    === canonicalJson(comparable(valueOf(input.incoming)));
  if (same) {
    return {
      kind: 'merged',
      payload: input.current.payload,
      operation: operationOf(input.current),
      resultingHeadRevisionIds: heads,
      requiresMergeRevision: true,
      mergeParentRevisionIds: heads,
    };
  }
  return {
    kind: 'conflict',
    payload: input.current.payload,
    operation: operationOf(input.current),
    resultingHeadRevisionIds: heads,
    conflictKind: 'ai-logical-config-divergence',
    conflictingFields: differingFields(input.current, input.incoming),
  };
}
