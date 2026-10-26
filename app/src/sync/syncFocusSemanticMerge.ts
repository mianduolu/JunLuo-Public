import {
  assertFocusSemanticMutationV1,
  focusSemanticPayload,
  preserveFocusReadingExtension,
  type FocusSemanticPayloadV1,
} from './syncFocusSemantic';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type FocusSemanticRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityType: string;
  entityId: string;
  payload: JsonValue;
};

export type FocusSemanticConflictKind =
  | 'focus-delete-modify'
  | 'focus-record-divergence'
  | 'focus-current-agreement-divergence'
  | 'focus-policy-field-divergence';

export type FocusSemanticMergeDecision = {
  kind:
    | 'already-current'
    | 'apply-incoming'
    | 'ignore-incoming'
    | 'merged'
    | 'conflict';
  payload: JsonValue;
  operation: PlainMutationV1['revision']['operation'];
  resultingHeadRevisionIds: string[];
  conflictKind?: FocusSemanticConflictKind;
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

function mutationOf(revision: FocusSemanticRevisionValue): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: '40000000-0000-4000-8000-000000000001',
    vaultId: '10000000-0000-4000-8000-000000000001',
    sourceDeviceId: '20000000-0000-4000-8000-000000000002',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'focus',
      type: revision.entityType,
      id: revision.entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: [...revision.parentRevisionIds],
      operation: revision.operation,
      schemaVersion: 1,
    },
    sensitivity: 'high',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: 'focus-semantic',
  };
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
}

function changedFields(
  left: Record<string, JsonValue>,
  right: Record<string, JsonValue>,
) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((field) => !sameValue(left[field], right[field]))
    .sort();
}

function recordPayload(payload: FocusSemanticPayloadV1) {
  if (!('record' in payload)) {
    throw new Error('focus.semantic 当前 revision 不是 record payload。');
  }
  return payload.record as Record<string, JsonValue>;
}

function mergedDecision(input: {
  current: FocusSemanticRevisionValue;
  incoming: FocusSemanticRevisionValue;
  payload: JsonValue;
  operation: PlainMutationV1['revision']['operation'];
}): FocusSemanticMergeDecision {
  const heads = sortedHeads(
    input.current.revisionId,
    input.incoming.revisionId,
  );
  return {
    kind: 'merged',
    payload: input.payload,
    operation: input.operation,
    resultingHeadRevisionIds: heads,
    requiresMergeRevision: true,
    mergeParentRevisionIds: heads,
  };
}

function conflictDecision(input: {
  current: FocusSemanticRevisionValue;
  incoming: FocusSemanticRevisionValue;
  conflictKind: FocusSemanticConflictKind;
  conflictingFields?: string[];
}): FocusSemanticMergeDecision {
  return {
    kind: 'conflict',
    payload: input.current.payload,
    operation: input.current.operation,
    resultingHeadRevisionIds: sortedHeads(
      input.current.revisionId,
      input.incoming.revisionId,
    ),
    conflictKind: input.conflictKind,
    conflictingFields: input.conflictingFields ?? [],
  };
}

export function resolveFocusSemanticRevisions(input: {
  current: FocusSemanticRevisionValue | null;
  incoming: FocusSemanticRevisionValue;
}): FocusSemanticMergeDecision {
  assertFocusSemanticMutationV1(mutationOf(input.incoming));
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertFocusSemanticMutationV1(mutationOf(input.current));
  if (
    input.current.entityType !== input.incoming.entityType
    || input.current.entityId !== input.incoming.entityId
  ) {
    throw new Error('focus.semantic 不能跨实体合并 revision。');
  }
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.current.parentRevisionIds.includes(input.incoming.revisionId)) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.incoming.parentRevisionIds.includes(input.current.revisionId)) {
    const previous = focusSemanticPayload(mutationOf(input.current));
    const next = focusSemanticPayload(mutationOf(input.incoming));
    if ('record' in previous && 'record' in next && previous.kind === next.kind) {
      const record = preserveFocusReadingExtension(previous.record, next.record);
      if (!sameValue(record, next.record)) return mergedDecision({
        current: input.current, incoming: input.incoming,
        payload: { ...next, record } as JsonValue, operation: input.incoming.operation,
      });
    }
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  const currentPayload = focusSemanticPayload(mutationOf(input.current));
  const incomingPayload = focusSemanticPayload(mutationOf(input.incoming));
  if (sameValue(currentPayload, incomingPayload)) {
    return mergedDecision({
      current: input.current,
      incoming: input.incoming,
      payload: currentPayload as JsonValue,
      operation: input.current.operation,
    });
  }
  if (
    input.current.operation === 'delete'
    && input.incoming.operation === 'delete'
  ) {
    if (currentPayload.kind !== incomingPayload.kind) {
      return conflictDecision({
        current: input.current,
        incoming: input.incoming,
        conflictKind: 'focus-record-divergence',
        conflictingFields: ['kind'],
      });
    }
    return mergedDecision({
      current: input.current,
      incoming: input.incoming,
      payload: {
        schemaVersion: 1,
        kind: currentPayload.kind,
        deletedAt: Math.max(
          'deletedAt' in currentPayload ? currentPayload.deletedAt : 0,
          'deletedAt' in incomingPayload ? incomingPayload.deletedAt : 0,
        ),
      },
      operation: 'delete',
    });
  }
  if (
    input.current.operation === 'delete'
    || input.incoming.operation === 'delete'
  ) {
    return conflictDecision({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'focus-delete-modify',
    });
  }
  if (currentPayload.kind !== incomingPayload.kind) {
    return conflictDecision({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'focus-record-divergence',
      conflictingFields: ['kind'],
    });
  }
  const currentRecord = recordPayload(currentPayload);
  const incomingRecord = recordPayload(incomingPayload);
  if (currentPayload.kind === 'focus-invite-cooldown') {
    const offeredAt = Math.max(
      Number(currentRecord.offeredAt),
      Number(incomingRecord.offeredAt),
    );
    return mergedDecision({
      current: input.current,
      incoming: input.incoming,
      payload: {
        schemaVersion: 1,
        kind: currentPayload.kind,
        record: { id: 'primary', offeredAt },
      },
      operation: 'upsert',
    });
  }
  const preservedRecord = preserveFocusReadingExtension(currentRecord, incomingRecord);
  if (sameValue(preservedRecord, currentRecord)) return mergedDecision({
    current: input.current, incoming: input.incoming,
    payload: { ...incomingPayload, record: preservedRecord } as JsonValue, operation: input.incoming.operation,
  });
  const fields = changedFields(currentRecord, preservedRecord);
  const conflictKind = currentPayload.kind === 'focus-current-agreement'
    ? 'focus-current-agreement-divergence'
    : currentPayload.kind === 'companion-policy-field'
      ? 'focus-policy-field-divergence'
      : 'focus-record-divergence';
  return conflictDecision({
    current: input.current,
    incoming: input.incoming,
    conflictKind,
    conflictingFields: fields,
  });
}
