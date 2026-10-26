import {
  assertRemoteBudgetMutationV1,
  mergeRemoteBudgetEventMetadata,
  type RemoteBudgetEventRecord,
} from './syncRemoteBudget';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type RemoteBudgetRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  payload: JsonValue;
};

export type RemoteBudgetMergeDecision = {
  kind:
    | 'already-current'
    | 'apply-incoming'
    | 'conflict'
    | 'ignore-incoming'
    | 'keep-current';
  payload: JsonValue;
  operation: PlainMutationV1['revision']['operation'];
  resultingHeadRevisionIds: string[];
  conflictKind?: 'remote-budget-event-divergence';
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

function mutationOf(
  entityId: string,
  revision: RemoteBudgetRevisionValue,
): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: '40000000-0000-4000-8000-000000000001',
    vaultId: '10000000-0000-4000-8000-000000000001',
    sourceDeviceId: '20000000-0000-4000-8000-000000000002',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'usage',
      type: 'remote-account-budget',
      id: entityId,
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
    retentionClass: 'rolling-remote-budget-24h',
  };
}

function assertRevision(
  entityId: string,
  revision: RemoteBudgetRevisionValue,
) {
  assertRemoteBudgetMutationV1(mutationOf(entityId, revision));
}

function payloadEvent(revision: RemoteBudgetRevisionValue) {
  const payload = revision.payload as {
    value: RemoteBudgetEventRecord;
  };
  return payload.value;
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
}

export function resolveRemoteBudgetRevisions(input: {
  entityId: string;
  current: RemoteBudgetRevisionValue | null;
  incoming: RemoteBudgetRevisionValue;
}): RemoteBudgetMergeDecision {
  assertRevision(input.entityId, input.incoming);
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: 'append',
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertRevision(input.entityId, input.current);
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: 'append',
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.current.parentRevisionIds.includes(input.incoming.revisionId)) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: 'append',
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.incoming.parentRevisionIds.includes(input.current.revisionId)) {
    const merged = mergeRemoteBudgetEventMetadata(payloadEvent(input.current), payloadEvent(input.incoming));
    if (!merged) {
      throw new Error('append-only remote budget successor 改写了事件。');
    }
    const needsMerge = merged.purpose !== payloadEvent(input.incoming).purpose
      || merged.costRestricted !== payloadEvent(input.incoming).costRestricted
      || merged.endedAt !== payloadEvent(input.incoming).endedAt;
    const heads = sortedHeads(input.current.revisionId, input.incoming.revisionId);
    return {
      kind: 'apply-incoming',
      payload: { ...(input.incoming.payload as Record<string, JsonValue>), value: merged as unknown as JsonValue },
      operation: 'append',
      resultingHeadRevisionIds: [input.incoming.revisionId],
      ...(needsMerge ? { requiresMergeRevision: true, mergeParentRevisionIds: heads } : {}),
    };
  }
  const heads = sortedHeads(
    input.current.revisionId,
    input.incoming.revisionId,
  );
  const merged = mergeRemoteBudgetEventMetadata(payloadEvent(input.current), payloadEvent(input.incoming));
  if (merged) {
    return {
      kind: 'keep-current',
      payload: { ...(input.current.payload as Record<string, JsonValue>), value: merged as unknown as JsonValue },
      operation: 'append',
      resultingHeadRevisionIds: heads,
      requiresMergeRevision: true,
      mergeParentRevisionIds: heads,
    };
  }
  return {
    kind: 'conflict',
    payload: input.current.payload,
    operation: 'append',
    resultingHeadRevisionIds: heads,
    conflictKind: 'remote-budget-event-divergence',
  };
}
