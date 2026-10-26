import {
  assertDesktopPreferencesMutationV1,
  desktopPreferenceMutationValue,
} from './syncDesktopPreferences';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type DesktopPreferencesRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityType: string;
  entityId: string;
  payload: JsonValue;
};

export type DesktopPreferencesMergeDecision = {
  kind:
    | 'already-current'
    | 'apply-incoming'
    | 'conflict'
    | 'ignore-incoming'
    | 'merged';
  payload: JsonValue;
  operation: 'upsert' | 'restore';
  resultingHeadRevisionIds: string[];
  conflictKind?: 'desktop-preference-divergence';
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

function mutationOf(
  revision: DesktopPreferencesRevisionValue,
): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: '40000000-0000-4000-8000-000000000001',
    vaultId: '10000000-0000-4000-8000-000000000001',
    sourceDeviceId: '20000000-0000-4000-8000-000000000002',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'desktop',
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
    retentionClass: 'desktop-preferences-long-term',
  };
}

function operationOf(
  revision: DesktopPreferencesRevisionValue,
): 'upsert' | 'restore' {
  if (
    revision.operation === 'upsert'
    || revision.operation === 'restore'
  ) {
    return revision.operation;
  }
  throw new Error('desktop.preferences merge operation 无效。');
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
    .map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function payloadWithIncomingValue(
  revision: DesktopPreferencesRevisionValue,
  value: JsonValue,
) {
  const payload = revision.payload as Record<string, JsonValue>;
  const record = payload.value as Record<string, JsonValue>;
  return {
    ...payload,
    value: {
      ...record,
      value,
    },
  } as JsonValue;
}

export function resolveDesktopPreferenceRevisions(input: {
  current: DesktopPreferencesRevisionValue | null;
  incoming: DesktopPreferencesRevisionValue;
}): DesktopPreferencesMergeDecision {
  assertDesktopPreferencesMutationV1(mutationOf(input.incoming));
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: operationOf(input.incoming),
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertDesktopPreferencesMutationV1(mutationOf(input.current));
  if (
    input.current.entityType !== input.incoming.entityType
    || input.current.entityId !== input.incoming.entityId
  ) {
    throw new Error(
      'desktop.preferences 不能跨实体或字段合并 revision。',
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
  const current = desktopPreferenceMutationValue(
    mutationOf(input.current),
  );
  const incoming = desktopPreferenceMutationValue(
    mutationOf(input.incoming),
  );
  const heads = sortedHeads(
    input.current.revisionId,
    input.incoming.revisionId,
  );
  if (
    canonicalJson(current.value)
      === canonicalJson(incoming.value)
  ) {
    return {
      kind: 'merged',
      payload: payloadWithIncomingValue(
        input.current,
        current.value as JsonValue,
      ),
      operation: 'upsert',
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
    conflictKind: 'desktop-preference-divergence',
    conflictingFields: [current.field],
  };
}
