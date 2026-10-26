import {
  assertNearbyWorldHealthMutationV1,
  NEARBY_WORLD_LEGACY_LOCATION_RETENTION_CLASS,
  NEARBY_WORLD_PRECISE_LOCATION_RETENTION_CLASS,
  NEARBY_WORLD_PRECISE_LOCATION_RETENTION_MS,
  NEARBY_WORLD_PREVIOUS_LOCATION_RETENTION_CLASS,
  type NearbyWorldRecordKind,
} from './syncNearbyWorldHealth';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type NearbyWorldHealthRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityType: string;
  entityId: string;
  payload: JsonValue;
};

export type NearbyWorldHealthMergeDecision = {
  kind:
    | 'already-current'
    | 'apply-incoming'
    | 'conflict'
    | 'ignore-incoming'
    | 'merged';
  payload: JsonValue;
  operation: 'append' | 'upsert' | 'restore' | 'delete';
  resultingHeadRevisionIds: string[];
  conflictKind?:
    | 'nearby-settings-divergence'
    | 'nearby-immutable-record-divergence';
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

function mutationOf(
  revision: NearbyWorldHealthRevisionValue,
): PlainMutationV1 {
  const payload = revision.payload as Record<string, unknown>;
  const kind = payload.kind as NearbyWorldRecordKind | undefined;
  const payloadValue = (
    payload.value
    && typeof payload.value === 'object'
    && !Array.isArray(payload.value)
  )
    ? payload.value as Record<string, unknown>
    : null;
  const locationRetentionMs = kind === 'nearby-location-observation'
    && typeof payloadValue?.observedAt === 'number'
    && typeof payloadValue.retainedUntil === 'number'
    ? payloadValue.retainedUntil - payloadValue.observedAt
    : null;
  const retentionClass = kind === 'nearby-settings-field'
    ? 'nearby-settings'
    : kind === 'nearby-location-observation'
      ? locationRetentionMs !== null
        && locationRetentionMs > 30 * 24 * 60 * 60 * 1000
        ? NEARBY_WORLD_LEGACY_LOCATION_RETENTION_CLASS
        : locationRetentionMs !== null
          && locationRetentionMs > NEARBY_WORLD_PRECISE_LOCATION_RETENTION_MS
          ? NEARBY_WORLD_PREVIOUS_LOCATION_RETENTION_CLASS
          : NEARBY_WORLD_PRECISE_LOCATION_RETENTION_CLASS
      : 'nearby-movement-history';
  return {
    protocolVersion: 1,
    mutationId: '40000000-0000-4000-8000-000000000001',
    vaultId: '10000000-0000-4000-8000-000000000001',
    sourceDeviceId: typeof payloadValue?.sourceDeviceId === 'string'
      ? payloadValue.sourceDeviceId
      : '20000000-0000-4000-8000-000000000002',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'nearby-world',
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
    retentionClass,
  };
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalJson(entry)}`
    ))
    .join(',')}}`;
}

function operationOf(
  revision: NearbyWorldHealthRevisionValue,
): 'append' | 'upsert' | 'restore' | 'delete' {
  if (
    revision.operation === 'append'
    || revision.operation === 'upsert'
    || revision.operation === 'restore'
    || revision.operation === 'delete'
  ) {
    return revision.operation;
  }
  throw new Error('nearby-world.health merge operation 无效。');
}

function recordKind(revision: NearbyWorldHealthRevisionValue) {
  const payload = revision.payload as Record<string, unknown>;
  return payload.kind as NearbyWorldRecordKind;
}

export function resolveNearbyWorldHealthRevisions(input: {
  current: NearbyWorldHealthRevisionValue | null;
  incoming: NearbyWorldHealthRevisionValue;
}): NearbyWorldHealthMergeDecision {
  assertNearbyWorldHealthMutationV1(mutationOf(input.incoming));
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: operationOf(input.incoming),
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertNearbyWorldHealthMutationV1(mutationOf(input.current));
  if (
    input.current.entityType !== input.incoming.entityType
    || input.current.entityId !== input.incoming.entityId
  ) {
    throw new Error('nearby-world.health 不能跨实体合并 revision。');
  }
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: operationOf(input.current),
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  const currentDelete = input.current.operation === 'delete';
  const incomingDelete = input.incoming.operation === 'delete';
  if (currentDelete || incomingDelete) {
    if (
      incomingDelete
      && input.incoming.parentRevisionIds.includes(
        input.current.revisionId,
      )
    ) {
      return {
        kind: 'apply-incoming',
        payload: input.incoming.payload,
        operation: 'delete',
        resultingHeadRevisionIds: [input.incoming.revisionId],
      };
    }
    if (
      currentDelete
      && input.current.parentRevisionIds.includes(
        input.incoming.revisionId,
      )
    ) {
      return {
        kind: 'ignore-incoming',
        payload: input.current.payload,
        operation: 'delete',
        resultingHeadRevisionIds: [input.current.revisionId],
      };
    }
    const heads = sortedHeads(
      input.current.revisionId,
      input.incoming.revisionId,
    );
    if (currentDelete && incomingDelete) {
      const currentPayload = input.current.payload as Record<string, unknown>;
      const incomingPayload = input.incoming.payload as Record<string, unknown>;
      return {
        kind: 'merged',
        payload: {
          schemaVersion: 1,
          kind: recordKind(input.incoming),
          deletedAt: Math.max(
            Number(currentPayload.deletedAt ?? 0),
            Number(incomingPayload.deletedAt ?? 0),
          ),
        },
        operation: 'delete',
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
      conflictKind: 'nearby-immutable-record-divergence',
    };
  }
  const samePayload = canonicalJson(input.current.payload)
    === canonicalJson(input.incoming.payload);
  if (input.current.parentRevisionIds.includes(input.incoming.revisionId)) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: operationOf(input.current),
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.incoming.parentRevisionIds.includes(input.current.revisionId)) {
    if (
      recordKind(input.current) !== 'nearby-settings-field'
      && !samePayload
    ) {
      return {
        kind: 'conflict',
        payload: input.current.payload,
        operation: operationOf(input.current),
        resultingHeadRevisionIds: sortedHeads(
          input.current.revisionId,
          input.incoming.revisionId,
        ),
        conflictKind: 'nearby-immutable-record-divergence',
      };
    }
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
  if (samePayload) {
    return {
      kind: 'merged',
      payload: input.current.payload,
      operation: operationOf(input.current),
      resultingHeadRevisionIds: heads,
      requiresMergeRevision: true,
      mergeParentRevisionIds: heads,
    };
  }
  const settings = recordKind(input.current) === 'nearby-settings-field';
  const currentValue = (
    input.current.payload as Record<string, unknown>
  ).value as Record<string, unknown> | undefined;
  return {
    kind: 'conflict',
    payload: input.current.payload,
    operation: operationOf(input.current),
    resultingHeadRevisionIds: heads,
    conflictKind: settings
      ? 'nearby-settings-divergence'
      : 'nearby-immutable-record-divergence',
    ...(settings && typeof currentValue?.field === 'string'
      ? { conflictingFields: [currentValue.field] }
      : {}),
  };
}
