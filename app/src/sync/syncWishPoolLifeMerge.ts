import {
  WISH_POOL_LIFE_RETENTION_CLASS,
  WISH_POOL_LIFE_SCHEMA_VERSION,
  assertWishPoolLifeMutationV1,
  assertWishPoolLifeRecord,
  type WishPoolDiscussionRecord,
  type WishPoolDiscussionStatus,
  type WishPoolLifeEntityType,
  type WishPoolLifeRecordKind,
  type WishPoolStatus,
  type WishPoolWishRecord,
} from './syncWishPoolLife';
import type {
  JsonValue,
  PlainMutationV1,
  SyncOperation,
} from './syncProtocol';
import { mergeWishCollaboration } from './syncWishPoolCollaboration';

export type WishPoolLifeRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: SyncOperation;
  createdAt: number;
  payload: JsonValue;
};

export type WishPoolLifeMergeDecision =
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
        | 'wish-state-divergence'
        | 'wish-content-divergence'
        | 'discussion-state-divergence'
        | 'receipt-divergence'
        | 'pending-intent-divergence';
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
  entityType: WishPoolLifeEntityType,
  entityId: string,
  revision: WishPoolLifeRevisionValue,
) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: '10000000-0000-4000-8000-000000000001',
    vaultId: '20000000-0000-4000-8000-000000000002',
    sourceDeviceId: '30000000-0000-4000-8000-000000000003',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'wish-pool',
      type: entityType,
      id: entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: revision.parentRevisionIds,
      operation: revision.operation,
      schemaVersion: Number(recordOf(revision.payload, 'wish-pool payload').schemaVersion),
    },
    sensitivity: 'high',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: WISH_POOL_LIFE_RETENTION_CLASS,
  };
  assertWishPoolLifeMutationV1(mutation);
}

function payloadKind(revision: WishPoolLifeRevisionValue) {
  if (revision.operation === 'delete') return null;
  const kind = recordOf(
    revision.payload,
    'wish-pool revision payload',
  ).kind;
  if (
    kind !== 'wish'
    && kind !== 'discussion'
    && kind !== 'event'
    && kind !== 'action-receipt'
    && kind !== 'pending-intent'
  ) {
    throw new Error('wish-pool.life revision kind 无效。');
  }
  return kind;
}

function payloadValue(revision: WishPoolLifeRevisionValue) {
  return recordOf(
    recordOf(
      revision.payload,
      'wish-pool revision payload',
    ).value,
    'wish-pool revision value',
  );
}

function recordPayload(
  kind: WishPoolLifeRecordKind,
  entityId: string,
  value: JsonRecord,
) {
  assertWishPoolLifeRecord(kind, entityId, value);
  return {
    schemaVersion: WISH_POOL_LIFE_SCHEMA_VERSION,
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
}): WishPoolLifeMergeDecision {
  return {
    kind: input.keepCurrent ? 'keep-current' : 'merged',
    payload: input.payload,
    operation: input.operation ?? 'upsert',
    resultingHeadRevisionIds: input.heads,
    requiresMergeRevision: true,
    mergeParentRevisionIds: input.heads,
  };
}

function wishStatusCanAdvance(
  from: WishPoolStatus,
  to: WishPoolStatus,
) {
  if (from === to) return true;
  switch (from) {
    case 'candidate':
      return to !== 'candidate';
    case 'not-adopted':
      return false;
    case 'active':
      return (
        to === 'in-progress'
        || to === 'fulfilled'
        || to === 'deferred'
        || to === 'released'
        || to === 'removed'
      );
    case 'in-progress':
      return (
        to === 'fulfilled'
        || to === 'released'
        || to === 'removed'
      );
    case 'deferred':
      return to === 'active' || to === 'released' || to === 'fulfilled';
    case 'fulfilled':
    case 'released':
    case 'removed':
      return false;
  }
}

function discussionStatusCanAdvance(
  from: WishPoolDiscussionStatus,
  to: WishPoolDiscussionStatus,
) {
  if (from === to) return true;
  if (from === 'pending-question') {
    return to === 'question-persisted' || to === 'discussed';
  }
  return from === 'question-persisted' && to === 'discussed';
}

function optionalTimestamp(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function minimumTimestamp(left: unknown, right: unknown) {
  const leftValue = optionalTimestamp(left);
  const rightValue = optionalTimestamp(right);
  if (leftValue === undefined) return rightValue;
  if (rightValue === undefined) return leftValue;
  return Math.min(leftValue, rightValue);
}

function maximumTimestamp(left: unknown, right: unknown) {
  const leftValue = optionalTimestamp(left);
  const rightValue = optionalTimestamp(right);
  if (leftValue === undefined) return rightValue;
  if (rightValue === undefined) return leftValue;
  return Math.max(leftValue, rightValue);
}

function statusJoin<T extends string>(
  current: T,
  incoming: T,
  canAdvance: (from: T, to: T) => boolean,
) {
  if (current === incoming) return current;
  const currentToIncoming = canAdvance(current, incoming);
  const incomingToCurrent = canAdvance(incoming, current);
  if (currentToIncoming && !incomingToCurrent) return incoming;
  if (incomingToCurrent && !currentToIncoming) return current;
  return null;
}

function wishRecord(value: JsonRecord) {
  return value as unknown as WishPoolWishRecord;
}

function discussionRecord(value: JsonRecord) {
  return value as unknown as WishPoolDiscussionRecord;
}

function sameOptionalIdentity(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
) {
  if (
    left !== undefined
    && right !== undefined
    && !compareJson(left, right)
  ) {
    return null;
  }
  return left ?? right;
}

function confirmedRevisedContent(current: WishPoolWishRecord, incoming: WishPoolWishRecord) {
  const revisions = (wish: WishPoolWishRecord) => wish.collaboration?.confirmations
    .filter((item) => item.purpose === 'revise' && item.decision === 'yes') ?? [];
  const left = revisions(current);
  const right = revisions(incoming);
  // A receive/materialization call may replay an old record even when concurrent is false.
  // Use retained joint decisions, never a later unrelated update timestamp, to order edits.
  for (const [wish, newer, older] of [[current, left, right], [incoming, right, left]] as const) {
    if (newer.length > older.length && older.every((old) => newer.some((item) => item.id === old.id))
      && newer.some((item) => !older.some((old) => old.id === item.id)
        && item.wishContent === wish.content && item.pendingText === wish.content)) return wish.content;
  }
  return undefined;
}

// Used by receive materializers too: never overwrite retained joint history with an older wire record.
export function mergeWishPoolWishRecords(current: WishPoolWishRecord, incoming: WishPoolWishRecord, concurrent: boolean) {
  const revision = (value: WishPoolWishRecord): WishPoolLifeRevisionValue => ({
    revisionId: '', parentRevisionIds: [], operation: 'upsert', createdAt: value.updatedAt,
    payload: { schemaVersion: 2, kind: 'wish', value: value as unknown as JsonValue },
  });
  const result = mergeWishRecords({ entityId: current.id, current: revision(current),
    incoming: revision(incoming), heads: [], concurrent });
  if (result.kind === 'conflict') throw new Error(`Wish sync conflict: ${result.conflictingFields.join(',')}`);
  return (result.payload as JsonRecord).value as unknown as WishPoolWishRecord;
}

function mergeWishRecords(input: {
  entityId: string;
  current: WishPoolLifeRevisionValue;
  incoming: WishPoolLifeRevisionValue;
  heads: string[];
  concurrent?: boolean;
}): WishPoolLifeMergeDecision {
  const currentValue = payloadValue(input.current);
  const incomingValue = payloadValue(input.incoming);
  if (compareJson(currentValue, incomingValue)) {
    return mergedDecision({
      payload: input.current.payload,
      heads: input.heads,
    });
  }
  const immutableFields = [
    'id',
    'owner',
    'origin',
    'sourceMessageId',
    'legacyBookshelfItemId',
    'legacyProjectId',
    'createdAt',
  ];
  const currentWish = wishRecord(currentValue);
  const incomingWish = wishRecord(incomingValue);
  const adopted = currentWish.status === 'candidate' ? incomingWish
    : incomingWish.status === 'candidate' ? currentWish : undefined;
  const adoptedContent = adopted?.collaboration?.confirmations.some((item) => (
    item.purpose === 'cast_coin' && item.wishContent === adopted.content
  )) ? adopted.content : undefined;
  const confirmedContent = confirmedRevisedContent(currentWish, incomingWish) ?? adoptedContent;
  if (currentValue.content !== incomingValue.content && confirmedContent === undefined) immutableFields.push('content');
  const immutableConflicts = immutableFields.filter(
    (field) => !compareJson(
      currentValue[field],
      incomingValue[field],
    ),
  );
  if (immutableConflicts.length) {
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: input.heads,
      conflictKind: 'wish-content-divergence',
      conflictingFields: immutableConflicts,
    };
  }
  const current = wishRecord(currentValue);
  const incoming = wishRecord(incomingValue);
  const status = input.concurrent === false && incoming.updatedAt >= current.updatedAt
    && wishStatusCanAdvance(current.status, incoming.status) ? incoming.status : statusJoin(
    current.status,
    incoming.status,
    wishStatusCanAdvance,
  );
  if (!status) {
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: input.heads,
      conflictKind: 'wish-state-divergence',
      conflictingFields: ['status'],
    };
  }
  const removedBy = sameOptionalIdentity(
    currentValue.removedBy,
    incomingValue.removedBy,
  );
  const completionEvidence = sameOptionalIdentity(
    currentValue.completionEvidence,
    incomingValue.completionEvidence,
  );
  if (
    removedBy === null
    || completionEvidence === null
  ) {
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: input.heads,
      conflictKind: 'wish-state-divergence',
      conflictingFields: [
        ...(removedBy === null ? ['removedBy'] : []),
        ...(completionEvidence === null
          ? ['completionEvidence']
          : []),
      ],
    };
  }
  const value: JsonRecord = {
    id: current.id,
    owner: current.owner,
    content: confirmedContent ?? current.content,
    status,
    origin: current.origin,
    pullBaseCount: Math.max(
      current.pullBaseCount,
      incoming.pullBaseCount,
    ),
    createdAt: current.createdAt,
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
  };
  for (const field of [
    'sourceMessageId',
    'legacyBookshelfItemId',
    'legacyProjectId',
  ]) {
    const item = currentValue[field] ?? incomingValue[field];
    if (item !== undefined) value[field] = item;
  }
  for (const field of [
    'lastPulledAt',
    'redrawEligibleAt',
  ]) {
    const item = maximumTimestamp(
      currentValue[field],
      incomingValue[field],
    );
    if (item !== undefined) value[field] = item;
  }
  for (const field of [
    'castAt',
    'startedAt',
    'deferredAt',
    'fulfilledAt',
    'releasedAt',
    'removedAt',
  ]) {
    const item = minimumTimestamp(
      currentValue[field],
      incomingValue[field],
    );
    if (item !== undefined) value[field] = item;
  }
  if (removedBy !== undefined) value.removedBy = removedBy;
  if (completionEvidence !== undefined) {
    value.completionEvidence = completionEvidence;
  }
  try {
    const collaboration = mergeWishCollaboration(input.entityId, current.collaboration, incoming.collaboration, input.concurrent ?? true);
    if (collaboration) {
      // A reply agreed against the old wish must not remain clickable after its text changes.
      const staleDiscussions = [current, incoming].filter((wish) => wish.content !== value.content)
        .flatMap((wish) => wish.collaboration?.discussions ?? []);
      collaboration.discussions = collaboration.discussions.map((discussion) => {
        if (discussion.closedAt !== undefined || !discussion.reply
          || !staleDiscussions.some((old) => old.id === discussion.id
            && old.reply?.messageId === discussion.reply?.messageId
            && old.reply?.requestRevision === discussion.reply?.requestRevision)) return discussion;
        const { reply, ...retained } = discussion;
        return { ...retained, lastDraftReply: reply, revision: discussion.revision + 1,
          decision: 'talking' as const };
      });
      value.collaboration = collaboration as unknown as JsonValue;
    }
  } catch {
    return {
      kind: 'conflict', payload: input.current.payload, operation: 'upsert', resultingHeadRevisionIds: input.heads,
      conflictKind: 'discussion-state-divergence', conflictingFields: ['collaboration'],
    };
  }
  return mergedDecision({
    payload: recordPayload('wish', input.entityId, value),
    heads: input.heads,
  });
}

function mergeDiscussionRecords(input: {
  entityId: string;
  current: WishPoolLifeRevisionValue;
  incoming: WishPoolLifeRevisionValue;
  heads: string[];
}): WishPoolLifeMergeDecision {
  const currentValue = payloadValue(input.current);
  const incomingValue = payloadValue(input.incoming);
  if (compareJson(currentValue, incomingValue)) {
    return mergedDecision({
      payload: input.current.payload,
      heads: input.heads,
    });
  }
  const immutable = [
    'id',
    'wishId',
    'content',
    'removedAt',
    'createdAt',
  ];
  const conflicts = immutable.filter(
    (field) => !compareJson(
      currentValue[field],
      incomingValue[field],
    ),
  );
  const current = discussionRecord(currentValue);
  const incoming = discussionRecord(incomingValue);
  const status = statusJoin(
    current.status,
    incoming.status,
    discussionStatusCanAdvance,
  );
  for (const field of [
    'questionMessageId',
    'discussionReplyMessageId',
  ]) {
    if (
      currentValue[field] !== undefined
      && incomingValue[field] !== undefined
      && !compareJson(currentValue[field], incomingValue[field])
    ) {
      conflicts.push(field);
    }
  }
  if (!status) conflicts.push('status');
  if (conflicts.length) {
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: input.heads,
      conflictKind: 'discussion-state-divergence',
      conflictingFields: uniqueSorted(conflicts),
    };
  }
  const value: JsonRecord = {
    id: current.id,
    wishId: current.wishId,
    content: current.content,
    removedAt: current.removedAt,
    status: status as WishPoolDiscussionStatus,
    createdAt: current.createdAt,
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
  };
  for (const field of [
    'questionMessageId',
    'discussionReplyMessageId',
  ]) {
    const item = currentValue[field] ?? incomingValue[field];
    if (item !== undefined) value[field] = item;
  }
  for (const field of [
    'questionPersistedAt',
    'discussedAt',
  ]) {
    const item = minimumTimestamp(
      currentValue[field],
      incomingValue[field],
    );
    if (item !== undefined) value[field] = item;
  }
  return mergedDecision({
    payload: recordPayload(
      'discussion',
      input.entityId,
      value,
    ),
    heads: input.heads,
  });
}

function stateTransitionRegresses(input: {
  current: WishPoolLifeRevisionValue;
  incoming: WishPoolLifeRevisionValue;
}) {
  if (
    input.current.operation === 'delete'
    && input.incoming.operation === 'restore'
  ) {
    return false;
  }
  const kind = payloadKind(input.current);
  if (kind !== payloadKind(input.incoming)) return true;
  const currentValue = payloadValue(input.current);
  const incomingValue = payloadValue(input.incoming);
  if (kind === 'wish') {
    const immutableFields = [
      'id',
      'owner',
      'content',
      'origin',
      'sourceMessageId',
      'legacyBookshelfItemId',
      'legacyProjectId',
      'createdAt',
    ];
    if (immutableFields.some(
      (field) => !compareJson(currentValue[field], incomingValue[field]),
    )) {
      return true;
    }
    const current = wishRecord(currentValue);
    const incoming = wishRecord(incomingValue);
    if (
      incoming.pullBaseCount < current.pullBaseCount
      || incoming.updatedAt < current.updatedAt
    ) {
      return true;
    }
    for (const field of [
      'lastPulledAt',
      'redrawEligibleAt',
    ]) {
      const before = optionalTimestamp(currentValue[field]);
      const after = optionalTimestamp(incomingValue[field]);
      if (
        before !== undefined
        && (after === undefined || after < before)
      ) {
        return true;
      }
    }
    for (const field of [
      'startedAt',
      'fulfilledAt',
      'releasedAt',
      'removedAt',
      'removedBy',
      'completionEvidence',
    ]) {
      if (
        currentValue[field] !== undefined
        && !compareJson(currentValue[field], incomingValue[field])
      ) {
        return true;
      }
    }
    if (
      currentValue.deferredAt !== undefined
      && !(
        current.status === 'deferred'
        && incoming.status === 'active'
      )
      && !compareJson(
        currentValue.deferredAt,
        incomingValue.deferredAt,
      )
    ) {
      return true;
    }
    return !wishStatusCanAdvance(current.status, incoming.status);
  }
  if (kind === 'discussion') {
    for (const field of [
      'id',
      'wishId',
      'content',
      'removedAt',
      'createdAt',
      'questionMessageId',
      'questionPersistedAt',
      'discussionReplyMessageId',
      'discussedAt',
    ]) {
      if (
        currentValue[field] !== undefined
        && !compareJson(currentValue[field], incomingValue[field])
      ) {
        return true;
      }
    }
    const current = discussionRecord(currentValue);
    const incoming = discussionRecord(incomingValue);
    if (incoming.updatedAt < current.updatedAt) return true;
    return !discussionStatusCanAdvance(
      current.status,
      incoming.status,
    );
  }
  if (kind === 'event' || kind === 'action-receipt') {
    return !compareJson(
      currentValue,
      incomingValue,
    );
  }
  return false;
}

function mergeConcurrentRecord(input: {
  entityId: string;
  current: WishPoolLifeRevisionValue;
  incoming: WishPoolLifeRevisionValue;
  heads: string[];
}): WishPoolLifeMergeDecision {
  const currentKind = payloadKind(input.current);
  const incomingKind = payloadKind(input.incoming);
  if (!currentKind || currentKind !== incomingKind) {
    throw new Error('wish-pool.life 不能跨 record kind 合并。');
  }
  if (currentKind === 'wish') return mergeWishRecords(input);
  if (currentKind === 'discussion') {
    return mergeDiscussionRecords(input);
  }
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
    conflictKind: (
      currentKind === 'pending-intent'
        ? 'pending-intent-divergence'
        : 'receipt-divergence'
    ),
    conflictingFields: changedFields(
      currentValue,
      incomingValue,
    ),
  };
}

export function resolveWishPoolLifeRevisions(input: {
  entityType: WishPoolLifeEntityType;
  entityId: string;
  current: WishPoolLifeRevisionValue | null;
  incoming: WishPoolLifeRevisionValue;
}): WishPoolLifeMergeDecision {
  assertRevision(input.entityType, input.entityId, input.incoming);
  if (input.current === null) {
    if (input.incoming.operation === 'restore') {
      throw new Error('wish-pool.life restore 必须接在 tombstone 之后。');
    }
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
    input.incoming.operation === 'restore'
    && input.current.operation !== 'delete'
  ) {
    const heads = uniqueSorted([
      input.current.revisionId,
      input.incoming.revisionId,
    ]);
    return mergedDecision({
      payload: input.current.payload,
      operation: input.current.operation,
      heads,
      keepCurrent: true,
    });
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
    if (input.current.operation !== 'delete' && input.incoming.operation !== 'delete'
      && payloadKind(input.current) === 'wish' && payloadKind(input.incoming) === 'wish'
      && (payloadValue(input.current).collaboration || payloadValue(input.incoming).collaboration)) {
      return mergeWishRecords({ entityId: input.entityId, current: input.current, incoming: input.incoming, heads, concurrent: false });
    }
    if (stateTransitionRegresses({
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
