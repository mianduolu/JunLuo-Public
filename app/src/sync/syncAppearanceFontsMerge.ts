import {
  APPEARANCE_FONTS_RETENTION,
  appearanceFontMutationValue,
  assertAppearanceFontMutationV1,
} from './syncAppearanceFonts';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type AppearanceFontRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityType: string;
  entityId: string;
  payload: JsonValue;
};

export type AppearanceFontMergeDecision = {
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
    | 'appearance-font-divergence'
    | 'appearance-font-delete-edit';
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

function mutationOf(
  revision: AppearanceFontRevisionValue,
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
    retentionClass: APPEARANCE_FONTS_RETENTION,
  };
}

function objectRefsForRevision(
  revision: AppearanceFontRevisionValue,
) {
  if (revision.operation === 'delete') return [];
  const payload = revision.payload as {
    value?: {
      objectId?: unknown;
      requiredObjectId?: unknown;
    };
  };
  const objectId = revision.entityType === 'font-object'
    ? payload.value?.objectId
    : payload.value?.requiredObjectId;
  return typeof objectId === 'string' ? [objectId] : [];
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
}

function operationOf(
  revision: AppearanceFontRevisionValue,
): 'upsert' | 'restore' | 'delete' {
  if (
    revision.operation === 'upsert'
    || revision.operation === 'restore'
    || revision.operation === 'delete'
  ) {
    return revision.operation;
  }
  throw new Error('appearance.fonts merge operation 无效。');
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

function valueOf(revision: AppearanceFontRevisionValue) {
  return appearanceFontMutationValue(mutationOf(revision)).value;
}

function differingFields(
  current: AppearanceFontRevisionValue,
  incoming: AppearanceFontRevisionValue,
) {
  const left = valueOf(current) as Record<string, unknown> | undefined;
  const right = valueOf(incoming) as Record<string, unknown> | undefined;
  if (!left || !right) return ['*'];
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) =>
      canonicalJson(left[key]) !== canonicalJson(right[key]))
    .sort();
}

export function resolveAppearanceFontRevisions(input: {
  current: AppearanceFontRevisionValue | null;
  incoming: AppearanceFontRevisionValue;
}): AppearanceFontMergeDecision {
  assertAppearanceFontMutationV1(mutationOf(input.incoming));
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: operationOf(input.incoming),
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertAppearanceFontMutationV1(mutationOf(input.current));
  if (
    input.current.entityType !== input.incoming.entityType
    || input.current.entityId !== input.incoming.entityId
  ) {
    throw new Error('appearance.fonts 不能跨实体合并 revision。');
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
      conflictKind: 'appearance-font-delete-edit',
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
    conflictKind: 'appearance-font-divergence',
    conflictingFields: differingFields(input.current, input.incoming),
  };
}
