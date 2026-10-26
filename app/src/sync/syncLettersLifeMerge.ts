import {
  assertLettersLifeMutationV1,
  assertLettersLifeRecord,
  LETTERS_LIFE_RETENTION_CLASS,
  LETTERS_LIFE_SCHEMA_VERSION,
  type LetterStatus,
  type LettersLifeDeliveryStateRecord,
  type LettersLifeEntityType,
  type LettersLifeLetterRecord,
  type LettersLifeRelationshipDateRecord,
  type LettersLifeRecordKind,
} from './syncLettersLife';
import type {
  JsonValue,
  PlainMutationV1,
  SyncOperation,
} from './syncProtocol';

export type LettersLifeRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: SyncOperation;
  createdAt: number;
  payload: JsonValue;
};

export type LettersLifeMergeDecision =
  | {
      kind: 'already-current' | 'apply-incoming' | 'ignore-incoming';
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
      conflictKind:
        | 'delete-modify'
        | 'letter-content-divergence'
        | 'delivery-state-divergence'
        | 'relationship-date-divergence'
        | 'settings-divergence';
      conflictingFields: string[];
    };

type JsonRecord = { [key: string]: JsonValue };

function recordOf(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as JsonRecord;
}

function compareJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (
    left === null
    || right === null
    || typeof left !== typeof right
  ) {
    return false;
  }
  if (Array.isArray(left)) {
    return (
      Array.isArray(right)
      && left.length === right.length
      && left.every(
        (item, index) => compareJson(item, right[index]),
      )
    );
  }
  if (typeof left !== 'object' || Array.isArray(right)) return false;
  const leftRecord = left as JsonRecord;
  const rightRecord = right as JsonRecord;
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
  entityType: LettersLifeEntityType,
  entityId: string,
  revision: LettersLifeRevisionValue,
) {
  const payloadSchemaVersion = (() => {
    const payload = recordOf(revision.payload, 'letters revision payload');
    return payload.schemaVersion === 1 ? 1 : LETTERS_LIFE_SCHEMA_VERSION;
  })();
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: '10000000-0000-4000-8000-000000000001',
    vaultId: '20000000-0000-4000-8000-000000000002',
    sourceDeviceId: '30000000-0000-4000-8000-000000000003',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'letters',
      type: entityType,
      id: entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: revision.parentRevisionIds,
      operation: revision.operation,
      schemaVersion: payloadSchemaVersion,
    },
    sensitivity: 'high',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: LETTERS_LIFE_RETENTION_CLASS,
  };
  assertLettersLifeMutationV1(mutation);
}

function payloadKind(revision: LettersLifeRevisionValue) {
  if (revision.operation === 'delete') return null;
  const kind = recordOf(revision.payload, 'letters revision payload').kind;
  if (
    kind !== 'letter'
    && kind !== 'delivery-state'
    && kind !== 'letter-settings'
    && kind !== 'relationship-date'
  ) {
    throw new Error('letters.life revision kind 无效。');
  }
  return kind;
}

function payloadValue(revision: LettersLifeRevisionValue) {
  return recordOf(
    recordOf(revision.payload, 'letters revision payload').value,
    'letters revision value',
  );
}

function recordPayload(
  kind: LettersLifeRecordKind,
  entityId: string,
  value: JsonRecord,
) {
  assertLettersLifeRecord(kind, entityId, value);
  return {
    schemaVersion: LETTERS_LIFE_SCHEMA_VERSION,
    kind,
    value,
  } as JsonValue;
}

function changedFields(left: JsonRecord, right: JsonRecord) {
  return [...new Set([
    ...Object.keys(left),
    ...Object.keys(right),
  ])].filter(
    (field) => !compareJson(left[field], right[field]),
  ).sort();
}

function mergedDecision(input: {
  payload: JsonValue;
  operation?: SyncOperation;
  heads: string[];
  keepCurrent?: boolean;
}): LettersLifeMergeDecision {
  return {
    kind: input.keepCurrent ? 'keep-current' : 'merged',
    payload: input.payload,
    operation: input.operation ?? 'upsert',
    resultingHeadRevisionIds: input.heads,
    requiresMergeRevision: true,
    mergeParentRevisionIds: input.heads,
  };
}

function optionalStringArray(value: JsonValue | undefined) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function mergeLetterRecords(input: {
  entityId: string;
  current: LettersLifeRevisionValue;
  incoming: LettersLifeRevisionValue;
  heads: string[];
}): LettersLifeMergeDecision {
  const current = payloadValue(input.current);
  const incoming = payloadValue(input.incoming);
  if (compareJson(current, incoming)) {
    return mergedDecision({
      payload: input.current.payload,
      heads: input.heads,
    });
  }
  const immutable = [
    'id',
    'kind',
    'direction',
    'title',
    'content',
    'createdAt',
    'source',
  ];
  const immutableConflicts = immutable.filter(
    (field) => !compareJson(current[field], incoming[field]),
  );
  if (immutableConflicts.length) {
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: input.heads,
      conflictKind: 'letter-content-divergence',
      conflictingFields: immutableConflicts,
    };
  }
  const optionalImmutable = ['generationKey', 'openWhen', 'dateTicketId'];
  const optionalImmutableConflicts = optionalImmutable.filter((field) => (
    current[field] !== undefined
    && incoming[field] !== undefined
    && !compareJson(current[field], incoming[field])
  ));
  if (optionalImmutableConflicts.length) {
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: input.heads,
      conflictKind: 'letter-content-divergence',
      conflictingFields: optionalImmutableConflicts,
    };
  }
  const currentReply = current.replyContent;
  const incomingReply = incoming.replyContent;
  if (
    currentReply !== undefined
    && incomingReply !== undefined
    && !compareJson(currentReply, incomingReply)
  ) {
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: input.heads,
      conflictKind: 'letter-content-divergence',
      conflictingFields: ['replyContent'],
    };
  }
  const value: JsonRecord = {
    id: current.id,
    kind: current.kind,
    direction: current.direction,
    title: current.title,
    content: current.content,
    createdAt: current.createdAt,
  };
  const source = current.source ?? incoming.source;
  const replyContent = currentReply ?? incomingReply;
  const chatMessageIds = uniqueSorted([
    ...optionalStringArray(current.chatMessageIds),
    ...optionalStringArray(incoming.chatMessageIds),
  ]);
  const memoryIds = uniqueSorted([
    ...optionalStringArray(current.memoryIds),
    ...optionalStringArray(incoming.memoryIds),
  ]);
  const sourceIds = uniqueSorted([
    ...optionalStringArray(current.sourceIds),
    ...optionalStringArray(incoming.sourceIds),
  ]);
  if (source !== undefined) value.source = source;
  if (replyContent !== undefined) value.replyContent = replyContent;
  if (chatMessageIds.length) value.chatMessageIds = chatMessageIds;
  if (memoryIds.length) value.memoryIds = memoryIds;
  const generationKey = current.generationKey ?? incoming.generationKey;
  const openWhen = current.openWhen ?? incoming.openWhen;
  const dateTicketId = current.dateTicketId ?? incoming.dateTicketId;
  if (generationKey !== undefined) value.generationKey = generationKey;
  if (sourceIds.length) value.sourceIds = sourceIds;
  if (openWhen !== undefined) value.openWhen = openWhen;
  if (dateTicketId !== undefined) value.dateTicketId = dateTicketId;
  return mergedDecision({
    payload: recordPayload('letter', input.entityId, value),
    heads: input.heads,
  });
}

function statusCanAdvance(from: LetterStatus, to: LetterStatus) {
  if (from === to) return true;
  switch (from) {
    case 'waiting_I':
      return to === 'failed' || to === 'completed';
    case 'failed':
      return to === 'completed';
    case 'waiting_you':
      return to === 'completed';
    case 'sealed':
      return to === 'ready_to_open' || to === 'completed';
    case 'ready_to_open':
      return to === 'completed';
    case 'completed':
      return false;
  }
}

function deliveryRecord(
  revision: LettersLifeRevisionValue,
) {
  return payloadValue(revision) as unknown as
    LettersLifeDeliveryStateRecord;
}

function deliveryTransitionRegresses(input: {
  current: LettersLifeRevisionValue;
  incoming: LettersLifeRevisionValue;
}) {
  if (
    payloadKind(input.current) !== 'delivery-state'
    || payloadKind(input.incoming) !== 'delivery-state'
    || input.incoming.operation === 'restore'
  ) {
    return false;
  }
  const current = deliveryRecord(input.current);
  const incoming = deliveryRecord(input.incoming);
  return !statusCanAdvance(current.status, incoming.status);
}

function optionalTimestamp(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function mergeEventTimestamp(left: unknown, right: unknown) {
  const leftValue = optionalTimestamp(left);
  const rightValue = optionalTimestamp(right);
  if (leftValue === undefined) return rightValue;
  if (rightValue === undefined) return leftValue;
  return Math.min(leftValue, rightValue);
}

function mergeDeliveryRecords(input: {
  entityId: string;
  current: LettersLifeRevisionValue;
  incoming: LettersLifeRevisionValue;
  heads: string[];
}): LettersLifeMergeDecision {
  const current = deliveryRecord(input.current);
  const incoming = deliveryRecord(input.incoming);
  if (
    current.dueAt !== undefined
    && incoming.dueAt !== undefined
    && current.dueAt !== incoming.dueAt
  ) {
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: input.heads,
      conflictKind: 'delivery-state-divergence',
      conflictingFields: ['dueAt'],
    };
  }
  let status: LetterStatus;
  if (statusCanAdvance(current.status, incoming.status)) {
    status = incoming.status;
  } else if (statusCanAdvance(incoming.status, current.status)) {
    status = current.status;
  } else {
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: input.heads,
      conflictKind: 'delivery-state-divergence',
      conflictingFields: ['status'],
    };
  }
  const value: JsonRecord = {
    letterId: current.letterId,
    status,
  };
  const dueAt = current.dueAt ?? incoming.dueAt;
  const deliveredAt = mergeEventTimestamp(
    current.deliveredAt,
    incoming.deliveredAt,
  );
  const openedAt = mergeEventTimestamp(
    current.openedAt,
    incoming.openedAt,
  );
  const completedAt = mergeEventTimestamp(
    current.completedAt,
    incoming.completedAt,
  );
  if (dueAt !== undefined) value.dueAt = dueAt;
  if (deliveredAt !== undefined) value.deliveredAt = deliveredAt;
  if (openedAt !== undefined) value.openedAt = openedAt;
  if (completedAt !== undefined) value.completedAt = completedAt;
  return mergedDecision({
    payload: recordPayload('delivery-state', input.entityId, value),
    heads: input.heads,
  });
}

function mergeSettingsRecords(input: {
  entityId: string;
  current: LettersLifeRevisionValue;
  incoming: LettersLifeRevisionValue;
  heads: string[];
}): LettersLifeMergeDecision {
  const current = payloadValue(input.current);
  const incoming = payloadValue(input.incoming);
  if (current.defaultReplyDelayHours !== incoming.defaultReplyDelayHours) {
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: input.heads,
      conflictKind: 'settings-divergence',
      conflictingFields: ['defaultReplyDelayHours'],
    };
  }
  const value: JsonRecord = {
    settingsId: current.settingsId,
    defaultReplyDelayHours: current.defaultReplyDelayHours,
  };
  const lastProactiveRequestAt = Math.max(
    optionalTimestamp(current.lastProactiveRequestAt) ?? 0,
    optionalTimestamp(incoming.lastProactiveRequestAt) ?? 0,
  );
  const lastProactiveSavedAt = Math.max(
    optionalTimestamp(current.lastProactiveSavedAt) ?? 0,
    optionalTimestamp(incoming.lastProactiveSavedAt) ?? 0,
  );
  if (lastProactiveRequestAt) value.lastProactiveRequestAt = lastProactiveRequestAt;
  if (lastProactiveSavedAt) value.lastProactiveSavedAt = lastProactiveSavedAt;
  const unionFields = ['offeredDateTicketIds', 'settledSourceIds', 'recentGenerationKeys'] as const;
  for (const field of unionFields) {
    const merged = uniqueSorted([
      ...optionalStringArray(current[field]),
      ...optionalStringArray(incoming[field]),
    ]);
    if (merged.length) value[field] = merged;
  }
  return mergedDecision({
    payload: recordPayload('letter-settings', input.entityId, value),
    heads: input.heads,
  });
}

function mergeRelationshipDateRecords(input: {
  entityId: string;
  current: LettersLifeRevisionValue;
  incoming: LettersLifeRevisionValue;
  heads: string[];
}): LettersLifeMergeDecision {
  const current = payloadValue(input.current) as unknown as LettersLifeRelationshipDateRecord;
  const incoming = payloadValue(input.incoming) as unknown as LettersLifeRelationshipDateRecord;
  if (compareJson(current as unknown as JsonValue, incoming as unknown as JsonValue)) {
    return mergedDecision({ payload: input.current.payload, heads: input.heads });
  }
  const incomingWins = (
    incoming.updatedAt > current.updatedAt
    || (
      incoming.updatedAt === current.updatedAt
      && input.incoming.revisionId.localeCompare(input.current.revisionId) > 0
    )
  );
  const selected = incomingWins ? incoming : current;
  return mergedDecision({
    payload: recordPayload(
      'relationship-date',
      input.entityId,
      selected as unknown as JsonRecord,
    ),
    heads: input.heads,
    keepCurrent: !incomingWins,
  });
}

function mergeConcurrentRecord(input: {
  entityId: string;
  current: LettersLifeRevisionValue;
  incoming: LettersLifeRevisionValue;
  heads: string[];
}): LettersLifeMergeDecision {
  const currentKind = payloadKind(input.current);
  const incomingKind = payloadKind(input.incoming);
  if (!currentKind || currentKind !== incomingKind) {
    throw new Error('letters.life 不能跨 record kind 合并。');
  }
  if (currentKind === 'letter') return mergeLetterRecords(input);
  if (currentKind === 'delivery-state') {
    return mergeDeliveryRecords(input);
  }
  if (currentKind === 'letter-settings') return mergeSettingsRecords(input);
  if (currentKind === 'relationship-date') return mergeRelationshipDateRecords(input);
  const currentValue = payloadValue(input.current);
  const incomingValue = payloadValue(input.incoming);
  if (compareJson(currentValue, incomingValue)) {
    return mergedDecision({
      payload: input.current.payload,
      heads: input.heads,
    });
  }
  return {
    kind: 'conflict',
    payload: input.current.payload,
    operation: 'upsert',
    resultingHeadRevisionIds: input.heads,
    conflictKind: 'settings-divergence',
    conflictingFields: changedFields(currentValue, incomingValue),
  };
}

export function resolveLettersLifeRevisions(input: {
  entityType: LettersLifeEntityType;
  entityId: string;
  current: LettersLifeRevisionValue | null;
  incoming: LettersLifeRevisionValue;
}): LettersLifeMergeDecision {
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
  if (
    input.current.parentRevisionIds.includes(
      input.incoming.revisionId,
    )
  ) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (
    input.incoming.parentRevisionIds.includes(
      input.current.revisionId,
    )
  ) {
    const heads = uniqueSorted([
      input.current.revisionId,
      input.incoming.revisionId,
    ]);
    if (
      input.current.operation === 'delete'
      && input.incoming.operation !== 'restore'
    ) {
      return mergedDecision({
        payload: input.current.payload,
        operation: 'delete',
        heads,
        keepCurrent: true,
      });
    }
    if (deliveryTransitionRegresses({
      current: input.current,
      incoming: input.incoming,
    })) {
      return mergedDecision({
        payload: input.current.payload,
        operation: input.current.operation,
        heads,
        keepCurrent: true,
      });
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
      const currentWins = (
        input.current.createdAt > input.incoming.createdAt
        || (
          input.current.createdAt === input.incoming.createdAt
          && input.current.revisionId.localeCompare(
            input.incoming.revisionId,
          ) >= 0
        )
      );
      const selected = currentWins ? input.current : input.incoming;
      return mergedDecision({
        payload: selected.payload,
        operation: 'delete',
        heads,
        keepCurrent: currentWins,
      });
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
  return mergeConcurrentRecord({
    entityId: input.entityId,
    current: input.current,
    incoming: input.incoming,
    heads,
  });
}
