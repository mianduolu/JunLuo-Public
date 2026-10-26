import {
  appearanceWeatherMutationValue,
  assertAppearanceWeatherMutationV1,
} from './syncAppearanceWeather';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type AppearanceWeatherRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityType: string;
  entityId: string;
  payload: JsonValue;
  retentionClass: string;
};

export type AppearanceWeatherMergeDecision = {
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
    | 'appearance-weather-divergence'
    | 'appearance-weather-delete-edit';
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

function mutationOf(
  revision: AppearanceWeatherRevisionValue,
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
    objectRefs: [],
    retentionClass: revision.retentionClass,
  };
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
}

function operationOf(
  revision: AppearanceWeatherRevisionValue,
): 'upsert' | 'restore' | 'delete' {
  if (
    revision.operation === 'upsert'
    || revision.operation === 'restore'
    || revision.operation === 'delete'
  ) {
    return revision.operation;
  }
  throw new Error('appearance.weather merge operation 无效。');
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

function valueOf(revision: AppearanceWeatherRevisionValue) {
  return appearanceWeatherMutationValue(
    mutationOf(revision),
  ).value;
}

function differingFields(
  current: AppearanceWeatherRevisionValue,
  incoming: AppearanceWeatherRevisionValue,
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

export function resolveAppearanceWeatherRevisions(input: {
  current: AppearanceWeatherRevisionValue | null;
  incoming: AppearanceWeatherRevisionValue;
}): AppearanceWeatherMergeDecision {
  assertAppearanceWeatherMutationV1(mutationOf(input.incoming));
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: operationOf(input.incoming),
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertAppearanceWeatherMutationV1(mutationOf(input.current));
  if (
    input.current.entityType !== input.incoming.entityType
    || input.current.entityId !== input.incoming.entityId
  ) {
    throw new Error('appearance.weather 不能跨实体合并 revision。');
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
      conflictKind: 'appearance-weather-delete-edit',
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
    conflictKind: 'appearance-weather-divergence',
    conflictingFields: differingFields(
      input.current,
      input.incoming,
    ),
  };
}
