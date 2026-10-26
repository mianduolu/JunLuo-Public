import {
  assertResearchMaterialsMutationV1,
  researchMaterialMutationValue,
} from './syncResearchMaterials';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type ResearchMaterialsRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityType: string;
  entityId: string;
  payload: JsonValue;
};

export type ResearchMaterialsMergeDecision = {
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
    | 'research-material-divergence'
    | 'research-material-delete-edit';
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

function mutationOf(
  revision: ResearchMaterialsRevisionValue,
): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: '40000000-0000-4000-8000-000000000001',
    vaultId: '10000000-0000-4000-8000-000000000001',
    sourceDeviceId: '20000000-0000-4000-8000-000000000002',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'research',
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
    retentionClass: 'research-material-long-term',
  };
}

function operationOf(
  revision: ResearchMaterialsRevisionValue,
): 'upsert' | 'restore' | 'delete' {
  if (
    revision.operation === 'upsert'
    || revision.operation === 'restore'
    || revision.operation === 'delete'
  ) {
    return revision.operation;
  }
  throw new Error('research.materials merge operation 无效。');
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
    .map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
}

function differingFields(
  current: ResearchMaterialsRevisionValue,
  incoming: ResearchMaterialsRevisionValue,
) {
  const left = researchMaterialMutationValue(
    mutationOf(current),
  ).value as Record<string, unknown> | undefined;
  const right = researchMaterialMutationValue(
    mutationOf(incoming),
  ).value as Record<string, unknown> | undefined;
  if (!left || !right) return ['*'];
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) =>
      canonicalJson(left[key]) !== canonicalJson(right[key]))
    .sort();
}

export function resolveResearchMaterialRevisions(input: {
  current: ResearchMaterialsRevisionValue | null;
  incoming: ResearchMaterialsRevisionValue;
}): ResearchMaterialsMergeDecision {
  assertResearchMaterialsMutationV1(mutationOf(input.incoming));
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: operationOf(input.incoming),
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertResearchMaterialsMutationV1(mutationOf(input.current));
  if (
    input.current.entityType !== input.incoming.entityType
    || input.current.entityId !== input.incoming.entityId
  ) {
    throw new Error('research.materials 不能跨实体合并 revision。');
  }
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: operationOf(input.current),
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (
    input.current.parentRevisionIds
      .includes(input.incoming.revisionId)
  ) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: operationOf(input.current),
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (
    input.incoming.parentRevisionIds
      .includes(input.current.revisionId)
  ) {
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
      conflictKind: 'research-material-delete-edit',
      conflictingFields: ['*'],
    };
  }
  const currentValue = researchMaterialMutationValue(
    mutationOf(input.current),
  ).value;
  const incomingValue = researchMaterialMutationValue(
    mutationOf(input.incoming),
  ).value;
  if (canonicalJson(currentValue) === canonicalJson(incomingValue)) {
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
    conflictKind: 'research-material-divergence',
    conflictingFields: differingFields(
      input.current,
      input.incoming,
    ),
  };
}
