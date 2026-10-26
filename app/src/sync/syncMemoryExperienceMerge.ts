import {
  assertMemoryExperienceMutationV1,
  assertMemoryExperienceRecord,
  MEMORY_EXPERIENCE_SCHEMA_VERSION,
  mergePostReadingSyncValuesV1,
  mergePostNoticeReadSyncValuesV1,
  type PostReadingSyncValueV1,
  type PostNoticeReadSyncValueV1,
  type MemoryExperienceRecordKind,
} from './syncMemoryExperience';
import type {
  JsonValue,
  PlainMutationV1,
  SyncOperation,
} from './syncProtocol';

export type MemoryExperienceRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: SyncOperation;
  createdAt: number;
  payload: JsonValue;
};

export type MemoryExperienceMergeDecision =
  | {
      kind: 'already-current' | 'apply-incoming';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
    }
  | {
      kind: 'keep-current' | 'merged';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
      requiresMergeRevision: true;
      mergeParentRevisionIds: string[];
    }
  | {
      kind: 'conflict';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
      conflictKind: 'delete-modify' | 'immutable-dream-mismatch';
      conflictingFields: string[];
    };

function recordOf(value: unknown, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, JsonValue>;
}

function payloadRecord(revision: MemoryExperienceRevisionValue) {
  return recordOf(revision.payload, 'memory.experience revision payload');
}

function payloadKind(revision: MemoryExperienceRevisionValue) {
  if (revision.operation === 'delete') return null;
  const kind = payloadRecord(revision).kind;
  if (typeof kind !== 'string') {
    throw new Error('memory.experience revision 缺少 kind。');
  }
  return kind as MemoryExperienceRecordKind;
}

function payloadValue(revision: MemoryExperienceRevisionValue) {
  return recordOf(
    payloadRecord(revision).value,
    'memory.experience revision value',
  );
}

function compareJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => compareJson(value, right[index]));
  }
  if (typeof left !== 'object' || Array.isArray(right)) return false;
  const leftRecord = left as Record<string, JsonValue>;
  const rightRecord = right as Record<string, JsonValue>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key, index) => (
        key === rightKeys[index]
        && compareJson(leftRecord[key], rightRecord[key])
      ),
    )
  );
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function assertRevision(
  entityType: 'dream' | 'interaction-fact',
  entityId: string,
  revision: MemoryExperienceRevisionValue,
) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: '10000000-0000-4000-8000-000000000001',
    vaultId: '20000000-0000-4000-8000-000000000002',
    sourceDeviceId: '30000000-0000-4000-8000-000000000003',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'memory',
      type: entityType,
      id: entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: revision.parentRevisionIds,
      operation: revision.operation,
      schemaVersion: MEMORY_EXPERIENCE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: 'relationship-history',
  };
  assertMemoryExperienceMutationV1(mutation);
}

function recordPayload(
  kind: MemoryExperienceRecordKind,
  entityId: string,
  value: Record<string, JsonValue>,
) {
  assertMemoryExperienceRecord(kind, entityId, value);
  return {
    schemaVersion: MEMORY_EXPERIENCE_SCHEMA_VERSION,
    kind,
    value,
  } satisfies JsonValue;
}

function laterDate(left: JsonValue | undefined, right: JsonValue | undefined) {
  const leftValue = typeof left === 'string' ? left : null;
  const rightValue = typeof right === 'string' ? right : null;
  if (leftValue === null) return rightValue;
  if (rightValue === null) return leftValue;
  return leftValue.localeCompare(rightValue) >= 0 ? leftValue : rightValue;
}

function mergeConcurrentRecords(input: {
  entityId: string;
  current: MemoryExperienceRevisionValue;
  incoming: MemoryExperienceRevisionValue;
  heads: string[];
}): MemoryExperienceMergeDecision {
  const currentKind = payloadKind(input.current);
  const incomingKind = payloadKind(input.incoming);
  if (!currentKind || !incomingKind || currentKind !== incomingKind) {
    throw new Error('memory.experience 并发 revision kind 不一致。');
  }
  const currentValue = payloadValue(input.current);
  const incomingValue = payloadValue(input.incoming);
  if (compareJson(currentValue, incomingValue)) {
    return {
      kind: 'keep-current',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: input.heads,
      requiresMergeRevision: true,
      mergeParentRevisionIds: input.heads,
    };
  }
  if (currentKind === 'post-reading' || currentKind === 'post-notice-read') {
    const value = currentKind === 'post-reading'
      ? mergePostReadingSyncValuesV1(currentValue as unknown as PostReadingSyncValueV1, incomingValue as unknown as PostReadingSyncValueV1)
      : mergePostNoticeReadSyncValuesV1(currentValue as unknown as PostNoticeReadSyncValueV1, incomingValue as unknown as PostNoticeReadSyncValueV1);
    return { kind: 'merged', payload: recordPayload(currentKind, input.entityId, value as unknown as Record<string, JsonValue>),
      operation: 'upsert', resultingHeadRevisionIds: input.heads, requiresMergeRevision: true, mergeParentRevisionIds: input.heads };
  }
  if (currentKind === 'dream-state') {
    const value = {
      lastAttemptDateKey: laterDate(
        currentValue.lastAttemptDateKey,
        incomingValue.lastAttemptDateKey,
      ),
      lastBackfillDateKey: laterDate(
        currentValue.lastBackfillDateKey,
        incomingValue.lastBackfillDateKey,
      ),
    };
    return {
      kind: 'merged',
      payload: recordPayload(currentKind, input.entityId, value),
      operation: 'upsert',
      resultingHeadRevisionIds: input.heads,
      requiresMergeRevision: true,
      mergeParentRevisionIds: input.heads,
    };
  }
  if (currentKind === 'action-suggestion-cooldown') {
    const selected = Number(currentValue.at) >= Number(incomingValue.at)
      ? currentValue
      : incomingValue;
    return {
      kind: 'merged',
      payload: recordPayload(currentKind, input.entityId, selected),
      operation: 'upsert',
      resultingHeadRevisionIds: input.heads,
      requiresMergeRevision: true,
      mergeParentRevisionIds: input.heads,
    };
  }
  if (currentKind === 'baiyun-heart-viewed') {
    const currentAt = Number(currentValue.viewedAt);
    const incomingAt = Number(incomingValue.viewedAt);
    const selected = currentAt === incomingAt
      ? (
          String(currentValue.memoryId).localeCompare(
            String(incomingValue.memoryId),
          ) >= 0
            ? currentValue
            : incomingValue
        )
      : currentAt > incomingAt
        ? currentValue
        : incomingValue;
    return {
      kind: 'merged',
      payload: recordPayload(currentKind, input.entityId, selected),
      operation: 'upsert',
      resultingHeadRevisionIds: input.heads,
      requiresMergeRevision: true,
      mergeParentRevisionIds: input.heads,
    };
  }
  const preferred = input.current.revisionId.localeCompare(
    input.incoming.revisionId,
  ) <= 0
    ? input.current
    : input.incoming;
  return {
    kind: 'conflict',
    payload: preferred.payload,
    operation: preferred.operation,
    resultingHeadRevisionIds: input.heads,
    conflictKind: 'immutable-dream-mismatch',
    conflictingFields: ['value'],
  };
}

export function resolveMemoryExperienceRevisions(input: {
  entityType: 'dream' | 'interaction-fact';
  entityId: string;
  current: MemoryExperienceRevisionValue | null;
  incoming: MemoryExperienceRevisionValue;
}): MemoryExperienceMergeDecision {
  assertRevision(input.entityType, input.entityId, input.incoming);
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertRevision(input.entityType, input.entityId, input.current);
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.incoming.parentRevisionIds.includes(input.current.revisionId)) {
    if (
      input.current.operation === 'delete'
      && input.incoming.operation !== 'restore'
    ) {
      return {
        kind: 'keep-current',
        payload: input.current.payload,
        operation: 'delete',
        resultingHeadRevisionIds: [input.incoming.revisionId],
        requiresMergeRevision: true,
        mergeParentRevisionIds: uniqueSorted([
          input.current.revisionId,
          input.incoming.revisionId,
        ]),
      };
    }
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  const heads = uniqueSorted([
    input.current.revisionId,
    input.incoming.revisionId,
  ]);
  const currentDeleted = input.current.operation === 'delete';
  const incomingDeleted = input.incoming.operation === 'delete';
  if (currentDeleted || incomingDeleted) {
    if (currentDeleted && incomingDeleted) {
      const selected = input.current.createdAt === input.incoming.createdAt
        ? (
            input.current.revisionId.localeCompare(input.incoming.revisionId) >= 0
              ? input.current
              : input.incoming
          )
        : input.current.createdAt > input.incoming.createdAt
          ? input.current
          : input.incoming;
      return {
        kind: selected === input.current ? 'keep-current' : 'merged',
        payload: selected.payload,
        operation: 'delete',
        resultingHeadRevisionIds: heads,
        requiresMergeRevision: true,
        mergeParentRevisionIds: heads,
      };
    }
    const deleted = currentDeleted ? input.current : input.incoming;
    return {
      kind: 'conflict',
      payload: deleted.payload,
      operation: 'delete',
      resultingHeadRevisionIds: heads,
      conflictKind: 'delete-modify',
      conflictingFields: [],
    };
  }
  return mergeConcurrentRecords({
    entityId: input.entityId,
    current: input.current,
    incoming: input.incoming,
    heads,
  });
}
