import {
  assertCameraPreferencesMutationV1,
  cameraPreferenceMutationValue,
  type CameraPreferenceFieldValue,
} from './syncCameraPreferences';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type CameraPreferencesRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityType: string;
  entityId: string;
  payload: JsonValue;
};

export type CameraPreferencesMergeDecision = {
  kind:
    | 'already-current'
    | 'apply-incoming'
    | 'conflict'
    | 'ignore-incoming'
    | 'merged';
  payload: JsonValue;
  operation: 'upsert' | 'restore';
  resultingHeadRevisionIds: string[];
  conflictKind?: 'camera-preference-divergence';
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

function mutationOf(
  revision: CameraPreferencesRevisionValue,
): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: '40000000-0000-4000-8000-000000000001',
    vaultId: '10000000-0000-4000-8000-000000000001',
    sourceDeviceId: '20000000-0000-4000-8000-000000000002',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'camera',
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
    retentionClass: 'camera-perception-policy',
  };
}

function operationOf(
  revision: CameraPreferencesRevisionValue,
): 'upsert' | 'restore' {
  if (
    revision.operation === 'upsert'
    || revision.operation === 'restore'
  ) {
    return revision.operation;
  }
  throw new Error('camera.preferences merge operation 无效。');
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
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
    .map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalJson(entry)}`
    ))
    .join(',')}}`;
}

function valueOf(revision: CameraPreferencesRevisionValue) {
  return cameraPreferenceMutationValue(mutationOf(revision));
}

function payloadWithValue(
  revision: CameraPreferencesRevisionValue,
  value: CameraPreferenceFieldValue,
) {
  const payload = revision.payload as Record<string, JsonValue>;
  const record = payload.value as Record<string, JsonValue>;
  return {
    ...payload,
    value: {
      ...record,
      value: value as JsonValue,
    },
  } as JsonValue;
}

function mergedDecision(input: {
  current: CameraPreferencesRevisionValue;
  incoming: CameraPreferencesRevisionValue;
  value: CameraPreferenceFieldValue;
}): CameraPreferencesMergeDecision {
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

export function resolveCameraPreferenceRevisions(input: {
  current: CameraPreferencesRevisionValue | null;
  incoming: CameraPreferencesRevisionValue;
}): CameraPreferencesMergeDecision {
  assertCameraPreferencesMutationV1(mutationOf(input.incoming));
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: operationOf(input.incoming),
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertCameraPreferencesMutationV1(mutationOf(input.current));
  if (
    input.current.entityType !== input.incoming.entityType
    || input.current.entityId !== input.incoming.entityId
  ) {
    throw new Error(
      'camera.preferences 不能跨实体或字段合并 revision。',
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
    input.current.parentRevisionIds.includes(
      input.incoming.revisionId,
    )
  ) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: operationOf(input.current),
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (
    input.incoming.parentRevisionIds.includes(
      input.current.revisionId,
    )
  ) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: operationOf(input.incoming),
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  const currentValue = valueOf(input.current);
  const incomingValue = valueOf(input.incoming);
  if (
    canonicalJson(currentValue.value)
    === canonicalJson(incomingValue.value)
  ) {
    return mergedDecision({
      current: input.current,
      incoming: input.incoming,
      value: currentValue.value,
    });
  }
  const heads = sortedHeads(
    input.current.revisionId,
    input.incoming.revisionId,
  );
  return {
    kind: 'conflict',
    payload: input.current.payload,
    operation: operationOf(input.current),
    resultingHeadRevisionIds: heads,
    conflictKind: 'camera-preference-divergence',
    conflictingFields: [currentValue.field],
  };
}
