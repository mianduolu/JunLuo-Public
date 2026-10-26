import type { ChatCoreMutationEnvelope } from './syncChatCore';
import { readWishCollaboration, type WishCollaborationState } from '../wishPool/wishPoolDiscussionState';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const WISH_POOL_LIFE_ADAPTER_ID = 'wish-pool.life' as const;
export const WISH_POOL_LIFE_SCHEMA_VERSION = 2 as const;
export const WISH_POOL_LIFE_RETENTION_CLASS =
  'relationship-history' as const;
export const WISH_POOL_PENDING_INTENT_ENTITY_ID =
  'chat-handoff' as const;

export const WISH_POOL_OWNERS = Object.freeze(['I', 'you'] as const);
export const WISH_POOL_STATUSES = Object.freeze([
  'candidate',
  'not-adopted',
  'active',
  'in-progress',
  'deferred',
  'fulfilled',
  'released',
  'removed',
] as const);
export const WISH_POOL_ORIGINS = Object.freeze([
  'manual',
  'chat',
  'proactive',
  'bookshelf-review',
] as const);
export const WISH_POOL_EVENT_TYPES = Object.freeze([
  'proposed',
  'discussion-confirmed',
  'created',
  'pulled',
  'started',
  'deferred',
  'reactivated',
  'fulfilled',
  'released',
  'removed',
  'removal-question-persisted',
  'removal-discussed',
] as const);
export const WISH_POOL_DISCUSSION_STATUSES = Object.freeze([
  'pending-question',
  'question-persisted',
  'discussed',
] as const);
export const WISH_POOL_RECEIPT_OPERATIONS = Object.freeze([
  'propose',
  'create',
  'pull',
  'start',
  'defer',
  'fulfill',
  'release',
] as const);
export const WISH_POOL_EVIDENCE_KINDS = Object.freeze([
  'you-confirmation',
  'tool-success',
] as const);

export type WishPoolLifeEntityType =
  | 'wish'
  | 'discussion'
  | 'receipt'
  | 'pending-intent';
export type WishPoolLifeRecordKind =
  | 'wish'
  | 'discussion'
  | 'event'
  | 'action-receipt'
  | 'pending-intent';
export type WishPoolOwner = typeof WISH_POOL_OWNERS[number];
export type WishPoolStatus = typeof WISH_POOL_STATUSES[number];
export type WishPoolOrigin = typeof WISH_POOL_ORIGINS[number];
export type WishPoolEventType =
  typeof WISH_POOL_EVENT_TYPES[number];
export type WishPoolDiscussionStatus =
  typeof WISH_POOL_DISCUSSION_STATUSES[number];
export type WishPoolReceiptOperation =
  typeof WISH_POOL_RECEIPT_OPERATIONS[number];
export type WishPoolEvidenceKind =
  typeof WISH_POOL_EVIDENCE_KINDS[number];

export type WishPoolCompletionEvidenceRecord = {
  kind: WishPoolEvidenceKind;
  sourceId: string;
  occurredAt: number;
};

export type WishPoolWishRecord = {
  collaboration?: WishCollaborationState;
  castAt?: number;
  id: string;
  owner: WishPoolOwner;
  content: string;
  status: WishPoolStatus;
  origin: WishPoolOrigin;
  sourceMessageId?: string;
  legacyBookshelfItemId?: string;
  legacyProjectId?: string;
  pullBaseCount: number;
  lastPulledAt?: number;
  redrawEligibleAt?: number;
  startedAt?: number;
  deferredAt?: number;
  fulfilledAt?: number;
  releasedAt?: number;
  removedAt?: number;
  removedBy?: WishPoolOwner;
  completionEvidence?: WishPoolCompletionEvidenceRecord;
  createdAt: number;
  updatedAt: number;
};

export type WishPoolDiscussionRecord = {
  id: string;
  wishId: string;
  content: string;
  removedAt: number;
  status: WishPoolDiscussionStatus;
  questionMessageId?: string;
  questionPersistedAt?: number;
  discussionReplyMessageId?: string;
  discussedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type WishPoolEventRecord = {
  id: string;
  type: WishPoolEventType;
  wishId: string;
  actor?: WishPoolOwner;
  sourceId?: string;
  evidence?: WishPoolCompletionEvidenceRecord;
  occurredAt: number;
};

export type WishPoolActionReceiptRecord = {
  operation: WishPoolReceiptOperation;
  sourceId: string;
  wishId: string;
  occurredAt: number;
};

export type WishPoolPendingIntentRecord = {
  wishId: string;
  owner: WishPoolOwner;
  content: string;
  status: WishPoolStatus;
  createdAt: number;
};

function recordOf(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in value));
  if (extra.length || missing.length) {
    throw new Error(`${label} 字段集合无效。`);
  }
}

function assertString(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
  ) {
    throw new Error(`${label} 字符串长度无效。`);
  }
}

function assertOptionalString(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  if (value !== undefined) assertString(value, label, maximumLength);
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertOptionalTimestamp(value: unknown, label: string) {
  if (value !== undefined) assertTimestamp(value, label);
}

function assertEnum(
  value: unknown,
  allowed: readonly string[],
  label: string,
) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${label} 无效。`);
  }
}

function assertWishPoolLifeEntityId(
  entityType: WishPoolLifeEntityType,
  entityId: string,
) {
  if (entityType === 'wish' || entityType === 'discussion') {
    assertString(entityId, `wish-pool ${entityType} entity id`, 200);
    return;
  }
  if (entityType === 'pending-intent') {
    if (entityId !== WISH_POOL_PENDING_INTENT_ENTITY_ID) {
      throw new Error('pending-intent entity id 无效。');
    }
    return;
  }
  const eventPrefix = 'event:';
  if (entityId.startsWith(eventPrefix)) {
    assertString(
      entityId.slice(eventPrefix.length),
      'wish-pool event entity id',
      200,
    );
    return;
  }
  for (const operation of WISH_POOL_RECEIPT_OPERATIONS) {
    const actionPrefix = `action:${operation}:`;
    if (entityId.startsWith(actionPrefix)) {
      assertString(
        entityId.slice(actionPrefix.length),
        'wish-pool action receipt entity id',
        200,
      );
      return;
    }
  }
  throw new Error('wish-pool receipt entity id 无效。');
}

function assertEvidence(value: unknown, label: string) {
  if (value === undefined) return;
  const evidence = recordOf(value, label);
  assertKeys(
    evidence,
    ['kind', 'sourceId', 'occurredAt'],
    [],
    label,
  );
  assertEnum(
    evidence.kind,
    WISH_POOL_EVIDENCE_KINDS,
    `${label}.kind`,
  );
  assertString(evidence.sourceId, `${label}.sourceId`, 200);
  assertTimestamp(evidence.occurredAt, `${label}.occurredAt`);
}

function assertWishRecord(
  entityId: string,
  value: Record<string, unknown>,
) {
  assertKeys(
    value,
    [
      'id',
      'owner',
      'content',
      'status',
      'origin',
      'pullBaseCount',
      'createdAt',
      'updatedAt',
    ],
    [
      'collaboration',
      'castAt',
      'sourceMessageId',
      'legacyBookshelfItemId',
      'legacyProjectId',
      'lastPulledAt',
      'redrawEligibleAt',
      'startedAt',
      'deferredAt',
      'fulfilledAt',
      'releasedAt',
      'removedAt',
      'removedBy',
      'completionEvidence',
    ],
    'wish-pool wish',
  );
  assertString(value.id, 'wish id', 200);
  if (value.id !== entityId) {
    throw new Error('wish id 与 entity id 不一致。');
  }
  assertEnum(value.owner, WISH_POOL_OWNERS, 'wish owner');
  assertString(value.content, 'wish content', 640);
  if (Array.from(value.content as string).length > 160) {
    throw new Error('wish content 不能超过 160 个字符。');
  }
  assertEnum(value.status, WISH_POOL_STATUSES, 'wish status');
  assertEnum(value.origin, WISH_POOL_ORIGINS, 'wish origin');
  for (const field of [
    'sourceMessageId',
    'legacyBookshelfItemId',
    'legacyProjectId',
  ]) {
    assertOptionalString(value[field], `wish ${field}`, 200);
  }
  if (
    !Number.isSafeInteger(value.pullBaseCount)
    || Number(value.pullBaseCount) < 0
  ) {
    throw new Error('wish pullBaseCount 无效。');
  }
  for (const field of [
    'castAt',
    'lastPulledAt',
    'redrawEligibleAt',
    'startedAt',
    'deferredAt',
    'fulfilledAt',
    'releasedAt',
    'removedAt',
  ]) {
    assertOptionalTimestamp(value[field], `wish ${field}`);
  }
  if (value.removedBy !== undefined) {
    assertEnum(value.removedBy, WISH_POOL_OWNERS, 'wish removedBy');
  }
  assertEvidence(value.completionEvidence, 'wish completionEvidence');
  const collaboration = value.collaboration === undefined ? undefined
    : readWishCollaboration(value.collaboration, [{ id: entityId }]);
  const status = value.status as WishPoolStatus;
  if (
    status === 'in-progress'
    && value.startedAt === undefined
  ) {
    throw new Error('in-progress wish 必须包含 startedAt。');
  }
  if (
    status === 'deferred'
    && (
      value.owner !== 'you'
      || value.deferredAt === undefined
    )
  ) {
    throw new Error('deferred wish 必须属于 you 并包含 deferredAt。');
  }
  if (
    status === 'fulfilled'
    && (
      value.fulfilledAt === undefined
      || value.completionEvidence === undefined
      || (value.startedAt === undefined && !collaboration?.confirmations.some((item) => (
        item.purpose === 'complete' && item.decision === 'yes'
        && item.confirmedAt === value.fulfilledAt
        && item.sourceId === recordOf(value.completionEvidence, 'completion evidence').sourceId
      )))
    )
  ) {
    throw new Error('fulfilled wish 缺少开始或完成证据。');
  }
  if (
    status === 'released'
    && value.releasedAt === undefined
  ) {
    throw new Error('released wish 必须包含 releasedAt。');
  }
  if (
    status === 'removed'
    && (
      value.owner !== 'I'
      || value.removedBy !== 'you'
      || value.removedAt === undefined
    )
  ) {
    throw new Error('removed wish 必须是由 you 移除的 I 愿望。');
  }
  if (
    status !== 'fulfilled'
    && (
      value.fulfilledAt !== undefined
      || value.completionEvidence !== undefined
    )
  ) {
    throw new Error('非 fulfilled wish 不能包含完成证据。');
  }
  if (status !== 'released' && value.releasedAt !== undefined) {
    throw new Error('非 released wish 不能包含 releasedAt。');
  }
  if (
    status !== 'removed'
    && (value.removedAt !== undefined || value.removedBy !== undefined)
  ) {
    throw new Error('非 removed wish 不能包含移除证据。');
  }
  if (
    status === 'fulfilled'
    && recordOf(
      value.completionEvidence,
      'wish completionEvidence',
    ).occurredAt !== value.fulfilledAt
  ) {
    throw new Error('完成证据时间必须与 fulfilledAt 一致。');
  }
  assertTimestamp(value.createdAt, 'wish createdAt');
  assertTimestamp(value.updatedAt, 'wish updatedAt');
}

function assertDiscussionRecord(
  entityId: string,
  value: Record<string, unknown>,
) {
  assertKeys(
    value,
    [
      'id',
      'wishId',
      'content',
      'removedAt',
      'status',
      'createdAt',
      'updatedAt',
    ],
    [
      'questionMessageId',
      'questionPersistedAt',
      'discussionReplyMessageId',
      'discussedAt',
    ],
    'wish-pool discussion',
  );
  assertString(value.id, 'discussion id', 200);
  if (value.id !== entityId) {
    throw new Error('discussion id 与 entity id 不一致。');
  }
  assertString(value.wishId, 'discussion wishId', 200);
  assertString(value.content, 'discussion content', 640);
  if (Array.from(value.content as string).length > 160) {
    throw new Error('discussion content 不能超过 160 个字符。');
  }
  assertTimestamp(value.removedAt, 'discussion removedAt');
  assertEnum(
    value.status,
    WISH_POOL_DISCUSSION_STATUSES,
    'discussion status',
  );
  assertOptionalString(
    value.questionMessageId,
    'discussion questionMessageId',
    200,
  );
  assertOptionalString(
    value.discussionReplyMessageId,
    'discussion discussionReplyMessageId',
    200,
  );
  assertOptionalTimestamp(
    value.questionPersistedAt,
    'discussion questionPersistedAt',
  );
  assertOptionalTimestamp(value.discussedAt, 'discussion discussedAt');
  const hasQuestionMessage = value.questionMessageId !== undefined;
  const hasQuestionTimestamp = value.questionPersistedAt !== undefined;
  if (hasQuestionMessage !== hasQuestionTimestamp) {
    throw new Error('discussion 提问消息与时间必须成对出现。');
  }
  const hasReplyMessage =
    value.discussionReplyMessageId !== undefined;
  const hasDiscussedTimestamp = value.discussedAt !== undefined;
  if (hasReplyMessage !== hasDiscussedTimestamp) {
    throw new Error('discussion 回复消息与时间必须成对出现。');
  }
  const status = value.status as WishPoolDiscussionStatus;
  if (
    status !== 'pending-question'
    && (!hasQuestionMessage || !hasQuestionTimestamp)
  ) {
    throw new Error('question-persisted discussion 缺少提问证据。');
  }
  if (
    status === 'discussed'
    && (!hasReplyMessage || !hasDiscussedTimestamp)
  ) {
    throw new Error('discussed discussion 缺少回复证据。');
  }
  assertTimestamp(value.createdAt, 'discussion createdAt');
  assertTimestamp(value.updatedAt, 'discussion updatedAt');
}

export function wishPoolEventEntityId(id: string) {
  return `event:${id}`;
}

export function wishPoolActionReceiptEntityId(
  operation: WishPoolReceiptOperation,
  sourceId: string,
) {
  return `action:${operation}:${sourceId}`;
}

function assertEventRecord(
  entityId: string,
  value: Record<string, unknown>,
) {
  assertKeys(
    value,
    ['id', 'type', 'wishId', 'occurredAt'],
    ['actor', 'sourceId', 'evidence'],
    'wish-pool event',
  );
  assertString(value.id, 'event id', 200);
  if (wishPoolEventEntityId(value.id as string) !== entityId) {
    throw new Error('event identity 无效。');
  }
  assertEnum(value.type, WISH_POOL_EVENT_TYPES, 'event type');
  assertString(value.wishId, 'event wishId', 200);
  if (value.actor !== undefined) {
    assertEnum(value.actor, WISH_POOL_OWNERS, 'event actor');
  }
  assertOptionalString(value.sourceId, 'event sourceId', 200);
  assertEvidence(value.evidence, 'event evidence');
  assertTimestamp(value.occurredAt, 'event occurredAt');
}

function assertActionReceiptRecord(
  entityId: string,
  value: Record<string, unknown>,
) {
  assertKeys(
    value,
    ['operation', 'sourceId', 'wishId', 'occurredAt'],
    [],
    'wish-pool action receipt',
  );
  assertEnum(
    value.operation,
    WISH_POOL_RECEIPT_OPERATIONS,
    'receipt operation',
  );
  assertString(value.sourceId, 'receipt sourceId', 200);
  assertString(value.wishId, 'receipt wishId', 200);
  if (
    wishPoolActionReceiptEntityId(
      value.operation as WishPoolReceiptOperation,
      value.sourceId as string,
    ) !== entityId
  ) {
    throw new Error('action receipt identity 无效。');
  }
  assertTimestamp(value.occurredAt, 'receipt occurredAt');
}

function assertPendingIntentRecord(
  entityId: string,
  value: Record<string, unknown>,
) {
  assertKeys(
    value,
    ['wishId', 'owner', 'content', 'status', 'createdAt'],
    [],
    'wish-pool pending intent',
  );
  if (entityId !== WISH_POOL_PENDING_INTENT_ENTITY_ID) {
    throw new Error('pending-intent entity id 无效。');
  }
  assertString(value.wishId, 'pending wishId', 200);
  assertEnum(value.owner, WISH_POOL_OWNERS, 'pending owner');
  assertString(value.content, 'pending content', 640);
  if (Array.from(value.content as string).length > 160) {
    throw new Error('pending content 不能超过 160 个字符。');
  }
  assertEnum(value.status, WISH_POOL_STATUSES, 'pending status');
  assertTimestamp(value.createdAt, 'pending createdAt');
}

export function assertWishPoolLifeRecord(
  kind: WishPoolLifeRecordKind,
  entityId: string,
  value: unknown,
) {
  const record = recordOf(value, `wish-pool.life ${kind}`);
  assertJsonValue(record);
  switch (kind) {
    case 'wish':
      assertWishRecord(entityId, record);
      return;
    case 'discussion':
      assertDiscussionRecord(entityId, record);
      return;
    case 'event':
      assertEventRecord(entityId, record);
      return;
    case 'action-receipt':
      assertActionReceiptRecord(entityId, record);
      return;
    case 'pending-intent':
      assertPendingIntentRecord(entityId, record);
  }
}

function kindMatchesEntity(
  entityType: string,
  kind: WishPoolLifeRecordKind,
) {
  return (
    entityType === kind
    || (
      entityType === 'receipt'
      && (kind === 'event' || kind === 'action-receipt')
    )
  );
}

export function assertWishPoolLifeMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'wish-pool'
    || ![
      'wish',
      'discussion',
      'receipt',
      'pending-intent',
    ].includes(value.entity.type)
  ) {
    throw new Error('wish-pool.life mutation entity 无效。');
  }
  assertWishPoolLifeEntityId(
    value.entity.type as WishPoolLifeEntityType,
    value.entity.id,
  );
  if (value.revision.schemaVersion !== 1 && value.revision.schemaVersion !== WISH_POOL_LIFE_SCHEMA_VERSION) {
    throw new Error('wish-pool.life schemaVersion 无效。');
  }
  if (value.sensitivity !== 'high') {
    throw new Error('wish-pool.life sensitivity 必须为 high。');
  }
  if (value.retentionClass !== WISH_POOL_LIFE_RETENTION_CLASS) {
    throw new Error('wish-pool.life retentionClass 无效。');
  }
  if (value.objectRefs.length) {
    throw new Error('wish-pool.life 不接受对象引用。');
  }
  const payload = recordOf(value.payload, 'wish-pool.life payload');
  if (value.revision.operation === 'delete') {
    assertKeys(
      payload,
      ['schemaVersion', 'deletedAt'],
      [],
      'wish-pool.life delete',
    );
    if (payload.schemaVersion !== value.revision.schemaVersion) {
      throw new Error('wish-pool.life delete schemaVersion 无效。');
    }
    assertTimestamp(payload.deletedAt, 'wish-pool.life deletedAt');
    return;
  }
  if (
    value.revision.operation !== 'upsert'
    && value.revision.operation !== 'restore'
  ) {
    throw new Error(
      'wish-pool.life 只允许 upsert、restore 或 delete。',
    );
  }
  assertKeys(
    payload,
    ['schemaVersion', 'kind', 'value'],
    [],
    'wish-pool.life record',
  );
  if (payload.schemaVersion !== value.revision.schemaVersion) {
    throw new Error('wish-pool.life record schemaVersion 无效。');
  }
  const kind = payload.kind as WishPoolLifeRecordKind;
  if (
    ![
      'wish',
      'discussion',
      'event',
      'action-receipt',
      'pending-intent',
    ].includes(kind)
    || !kindMatchesEntity(value.entity.type, kind)
  ) {
    throw new Error('wish-pool.life kind 与 entity type 不匹配。');
  }
  assertWishPoolLifeRecord(kind, value.entity.id, payload.value);
  assertWishPoolLifeRecordVersion(kind, payload.value, payload.schemaVersion as number);
}

export function assertWishPoolLifeRecordVersion(kind: WishPoolLifeRecordKind, value: unknown, version: number) {
  if (version !== 1 && version !== 2) throw new Error('Unsupported wish-pool record version.');
  const record = recordOf(value, 'wish-pool versioned record');
  if (version === 1 && (
    record.collaboration !== undefined || record.castAt !== undefined
    || record.status === 'candidate' || record.status === 'not-adopted'
    || (kind === 'event' && (record.type === 'proposed' || record.type === 'discussion-confirmed'))
    || (kind === 'action-receipt' && record.operation === 'propose')
  )) throw new Error('Wish-pool v2 fields cannot be written as v1.');
}

export function buildWishPoolLifeRecordMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: WishPoolLifeEntityType;
  entityId: string;
  kind: WishPoolLifeRecordKind;
  value: JsonValue;
  operation?: 'upsert' | 'restore';
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'wish-pool',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: input.operation ?? 'upsert',
      schemaVersion: WISH_POOL_LIFE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: WISH_POOL_LIFE_SCHEMA_VERSION,
      kind: input.kind,
      value: input.value,
    },
    objectRefs: [],
    retentionClass: WISH_POOL_LIFE_RETENTION_CLASS,
  };
  assertWishPoolLifeMutationV1(mutation);
  return mutation;
}

export function buildWishPoolLifeDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: WishPoolLifeEntityType;
  entityId: string;
  deletedAt: number;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'wish-pool',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'delete',
      schemaVersion: WISH_POOL_LIFE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: WISH_POOL_LIFE_SCHEMA_VERSION,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: WISH_POOL_LIFE_RETENTION_CLASS,
  };
  assertWishPoolLifeMutationV1(mutation);
  return mutation;
}
