import {
  APPEARANCE_BACKGROUND_RETENTION,
  appearanceBackgroundMutationValue,
  assertAppearanceBackgroundMutationV1,
} from './syncAppearanceBackground';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type AppearanceBackgroundRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityType: string;
  entityId: string;
  payload: JsonValue;
};

export type AppearanceBackgroundMergeDecision = {
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
    | 'appearance-background-divergence'
    | 'appearance-background-delete-edit';
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

function objectRefsForRevision(
  revision: AppearanceBackgroundRevisionValue,
) {
  if (revision.operation === 'delete') return [];
  const payload = revision.payload as {
    value?: {
      objectId?: unknown;
      imageObjectId?: unknown;
    };
  };
  const objectId = revision.entityType === 'background-object'
    ? payload.value?.objectId
    : payload.value?.imageObjectId;
  return typeof objectId === 'string' ? [objectId] : [];
}

function mutationOf(
  revision: AppearanceBackgroundRevisionValue,
): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: '40000000-0000-4000-8000-000000000001',
    vaultId: '10000000-0000-4000-8000-000000000001',
    sourceDeviceId: '20000000-0000-4000-8000-000000000002',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'appearance',
      type: revision.entityType,
      id: revision.entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: revision.parentRevisionIds,
      operation: revision.operation,
      schemaVersion: 1,
    },
    sensitivity: 'private',
    payload: revision.payload,
    objectRefs: objectRefsForRevision(revision),
    retentionClass: APPEARANCE_BACKGROUND_RETENTION,
  };
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
}

function operationOf(
  revision: AppearanceBackgroundRevisionValue,
): 'upsert' | 'restore' | 'delete' {
  if (
    revision.operation === 'upsert'
    || revision.operation === 'restore'
    || revision.operation === 'delete'
  ) {
    return revision.operation;
  }
  throw new Error('appearance.background merge operation 无效。');
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

function valueOf(revision: AppearanceBackgroundRevisionValue) {
  return appearanceBackgroundMutationValue(
    mutationOf(revision),
  ).value;
}

function differingFields(
  current: AppearanceBackgroundRevisionValue,
  incoming: AppearanceBackgroundRevisionValue,
) {
  const left = valueOf(current) as unknown as
    Record<string, unknown> | undefined;
  const right = valueOf(incoming) as unknown as
    Record<string, unknown> | undefined;
  if (!left || !right) return ['*'];
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) =>
      canonicalJson(left[key]) !== canonicalJson(right[key]))
    .sort();
}

export function resolveAppearanceBackgroundRevisions(input: {
  current: AppearanceBackgroundRevisionValue | null;
  incoming: AppearanceBackgroundRevisionValue;
}): AppearanceBackgroundMergeDecision {
  assertAppearanceBackgroundMutationV1(mutationOf(input.incoming));
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: operationOf(input.incoming),
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertAppearanceBackgroundMutationV1(mutationOf(input.current));
  if (
    input.current.entityType !== input.incoming.entityType
    || input.current.entityId !== input.incoming.entityId
  ) {
    throw new Error(
      'appearance.background 不能跨实体合并 revision。',
    );
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
      conflictKind: 'appearance-background-delete-edit',
      conflictingFields: ['*'],
    };
  }
  if (
    canonicalJson(valueOf(input.current))
      === canonicalJson(valueOf(input.incoming))
  ) {
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
    conflictKind: 'appearance-background-divergence',
    conflictingFields: differingFields(
      input.current,
      input.incoming,
    ),
  };
}
