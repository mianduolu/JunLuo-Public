import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const PROACTIVE_LEDGER_ADAPTER_ID =
  'proactive.ledger' as const;
export const PROACTIVE_LEDGER_SCHEMA_VERSION = 1 as const;

export type ProactiveLedgerEntityType =
  | 'intent'
  | 'agent-task'
  | 'delivery'
  | 'voyage';

export type ProactiveLedgerRecordKind =
  | 'agent-task'
  | 'active-message-delivery'
  | 'web-voyage-log'
  | 'web-voyage-share-intent'
  | 'social-action-log'
  | 'social-draft'
  | 'social-share-intent'
  | 'social-comment-reply'
  | 'share-response-exchange';

export type ProactiveAgentTaskStatus =
  | 'pending'
  | 'delivered'
  | 'cancelled'
  | 'expired';

export type ProactiveAgentTaskRecord = {
  id: string;
  title: string;
  message: string;
  triggerAt: number;
  status: ProactiveAgentTaskStatus;
  sourceMessageId?: string;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  cancelledAt?: number;
};

export type ProactiveActiveDeliveryRecord = {
  id: string;
  deliveredAt: number;
  messageCount: number;
  priority: 'critical' | 'contextual' | 'soft';
  source: string;
  topicKey?: string;
};

export type ProactiveWebVoyageLogRecord = {
  at: number;
  detail: string;
  id: string;
  reason: string;
  status: 'skipped' | 'searching' | 'completed' | 'blocked' | 'failed';
  driveKey?: string;
  driveLabel?: string;
  driveReason?: string;
  evidenceConfidence?: string;
  evidenceStatus?: string;
  evidenceSummary?: string;
  evidenceVerdict?: string;
  evidenceWarnings?: string[];
  failureReason?: string;
  fetchMode?: 'http' | 'browser';
  providerId?: string;
  providerLabel?: string;
  query?: string;
  readingStatus?: 'body_excerpt' | 'search_preview' | 'metadata_only';
  shareError?: string;
  shareAttemptedAt?: number;
  shareCancelledAt?: number;
  shareChatHandoffAt?: number;
  sharedAt?: number;
  shareStatus?: 'none' | 'pending' | 'delivered' | 'failed';
  sourceType?: 'web' | 'github';
  stage?: 'waiting' | 'query' | 'search' | 'fetch' | 'summarize' | 'completed';
  summary?: string;
  title?: string;
  url?: string;
};

export type ProactiveWebVoyageShareIntentRecord = {
  at: number;
  id: string;
  logId: string;
  query: string;
  summary: string;
  title: string;
  driveLabel?: string;
  driveReason?: string;
  evidenceSummary?: string;
  evidenceVerdict?: string;
  sourceType?: 'web' | 'github';
  url?: string;
};

export type ProactiveSocialActionLogRecord = {
  action: 'browse' | 'search' | 'like' | 'favorite' | 'follow' | 'comment' | 'post';
  at: number;
  detail: string;
  id: string;
  platform: 'weibo' | 'xiaohongshu' | 'junluo';
  reason: string;
  status: 'planned' | 'blocked' | 'completed';
  thoughtText?: string;
};

export type ProactiveSocialDraftRecord = {
  content: string;
  createdAt: number;
  id: string;
  kind: 'post' | 'own_post_comment';
  platform: 'weibo' | 'xiaohongshu' | 'junluo';
  reason: string;
  status: 'pending' | 'approved' | 'discarded';
  updatedAt: number;
  approvedAt?: number;
  title?: string;
};

export type ProactiveSocialCommentReplyRecord = {
  commentId: string;
};

export type ProactiveShareResponseExchangeRecord = {
  id: string;
  sessionId: string;
  origin: 'chat_action' | 'letter' | 'web_voyage' | 'social_share' | 'life_project_share';
  invitationKind: 'self_driven' | 'you_invited';
  sourcePlanId?: string;
  sourceMessageIds: string[];
  responseDriveKeys: Array<'reflection' | 'social'>;
  excerpt: string;
  state: 'waiting' | 'engaged' | 'declined' | 'unanswered';
  createdAt: number;
  resolvedAt?: number;
  responseMessageId?: string;
};

type JsonRecord = Record<string, unknown>;

const APPEND_ONLY_KINDS = new Set<ProactiveLedgerRecordKind>([
  'active-message-delivery',
  'web-voyage-share-intent',
  'social-action-log',
  'social-share-intent',
  'social-comment-reply',
]);

const KIND_ENTITY: Readonly<
  Record<ProactiveLedgerRecordKind, ProactiveLedgerEntityType>
> = {
  'agent-task': 'agent-task',
  'active-message-delivery': 'delivery',
  'web-voyage-log': 'voyage',
  'web-voyage-share-intent': 'intent',
  'social-action-log': 'voyage',
  'social-draft': 'voyage',
  'social-share-intent': 'intent',
  'social-comment-reply': 'delivery',
  'share-response-exchange': 'intent',
};

function recordOf(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as JsonRecord;
}

function assertKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) {
    throw new Error(
      `${label} 包含未允许字段：${extra.sort().join(', ')}。`,
    );
  }
  const missing = required.filter((key) => !(key in value));
  if (missing.length) {
    throw new Error(`${label} 缺少字段：${missing.join(', ')}。`);
  }
}

function assertString(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false,
) {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length < 1)
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
  if (value !== undefined) {
    assertString(value, label, maximumLength, true);
  }
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertOptionalTimestamp(value: unknown, label: string) {
  if (value !== undefined) assertTimestamp(value, label);
}

function assertPositiveInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} 必须是正安全整数。`);
  }
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

function assertOptionalStringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${label} 数组长度无效。`);
  }
  value.forEach((item, index) => {
    assertString(item, `${label}[${index}]`, maximumLength);
  });
}

function assertEntityId(value: JsonRecord, entityId: string) {
  assertString(value.id, 'proactive ledger record id', 256);
  if (value.id !== entityId) {
    throw new Error('proactive ledger record id 与 entity id 不一致。');
  }
}

function assertAgentTask(entityId: string, value: JsonRecord) {
  assertKeys(
    value,
    [
      'id',
      'title',
      'message',
      'triggerAt',
      'status',
      'createdAt',
      'updatedAt',
    ],
    [
      'sourceMessageId',
      'deliveredAt',
      'cancelledAt',
    ],
    'proactive agent task',
  );
  assertEntityId(value, entityId);
  assertString(value.title, 'agent task title', 240);
  assertString(value.message, 'agent task message', 4000);
  assertTimestamp(value.triggerAt, 'agent task triggerAt');
  assertEnum(
    value.status,
    ['pending', 'delivered', 'cancelled', 'expired'],
    'agent task status',
  );
  assertOptionalString(
    value.sourceMessageId,
    'agent task sourceMessageId',
    256,
  );
  assertTimestamp(value.createdAt, 'agent task createdAt');
  assertTimestamp(value.updatedAt, 'agent task updatedAt');
  assertOptionalTimestamp(value.deliveredAt, 'agent task deliveredAt');
  assertOptionalTimestamp(value.cancelledAt, 'agent task cancelledAt');
}

function assertActiveDelivery(entityId: string, value: JsonRecord) {
  assertKeys(
    value,
    ['id', 'deliveredAt', 'messageCount', 'priority', 'source'],
    ['topicKey'],
    'proactive active delivery',
  );
  assertEntityId(value, entityId);
  assertTimestamp(value.deliveredAt, 'active delivery deliveredAt');
  assertPositiveInteger(value.messageCount, 'active delivery messageCount');
  assertEnum(
    value.priority,
    ['critical', 'contextual', 'soft'],
    'active delivery priority',
  );
  assertString(value.source, 'active delivery source', 80);
  assertOptionalString(value.topicKey, 'active delivery topicKey', 1024);
}

function assertWebVoyageLog(entityId: string, value: JsonRecord) {
  assertKeys(
    value,
    ['at', 'detail', 'id', 'reason', 'status'],
    [
      'driveKey',
      'driveLabel',
      'driveReason',
      'evidenceConfidence',
      'evidenceStatus',
      'evidenceSummary',
      'evidenceVerdict',
      'evidenceWarnings',
      'failureReason',
      'fetchMode',
      'providerId',
      'providerLabel',
      'query',
      'readingStatus',
      'shareError',
      'shareAttemptedAt',
      'shareCancelledAt',
      'shareChatHandoffAt',
      'sharedAt',
      'shareStatus',
      'sourceType',
      'stage',
      'summary',
      'title',
      'url',
    ],
    'proactive web voyage log',
  );
  assertEntityId(value, entityId);
  assertTimestamp(value.at, 'web voyage at');
  assertString(value.detail, 'web voyage detail', 1000, true);
  assertString(value.reason, 'web voyage reason', 500, true);
  assertEnum(
    value.status,
    ['skipped', 'searching', 'completed', 'blocked', 'failed'],
    'web voyage status',
  );
  assertOptionalString(value.driveKey, 'web voyage driveKey', 80);
  assertOptionalString(value.driveLabel, 'web voyage driveLabel', 80);
  assertOptionalString(value.driveReason, 'web voyage driveReason', 500);
  assertOptionalString(
    value.evidenceConfidence,
    'web voyage evidenceConfidence',
    80,
  );
  assertOptionalString(
    value.evidenceStatus,
    'web voyage evidenceStatus',
    80,
  );
  assertOptionalString(
    value.evidenceSummary,
    'web voyage evidenceSummary',
    1000,
  );
  assertOptionalString(
    value.evidenceVerdict,
    'web voyage evidenceVerdict',
    160,
  );
  assertOptionalStringArray(
    value.evidenceWarnings,
    'web voyage evidenceWarnings',
    8,
    240,
  );
  assertOptionalString(
    value.failureReason,
    'web voyage failureReason',
    500,
  );
  if (value.fetchMode !== undefined) {
    assertEnum(value.fetchMode, ['http', 'browser'], 'web voyage fetchMode');
  }
  assertOptionalString(value.providerId, 'web voyage providerId', 120);
  assertOptionalString(value.providerLabel, 'web voyage providerLabel', 160);
  assertOptionalString(value.query, 'web voyage query', 160);
  if (value.readingStatus !== undefined) {
    assertEnum(value.readingStatus, ['body_excerpt', 'search_preview', 'metadata_only'], 'web voyage readingStatus');
  }
  assertOptionalString(value.shareError, 'web voyage shareError', 500);
  assertOptionalTimestamp(value.shareAttemptedAt, 'web voyage shareAttemptedAt');
  assertOptionalTimestamp(value.shareCancelledAt, 'web voyage shareCancelledAt');
  assertOptionalTimestamp(value.shareChatHandoffAt, 'web voyage shareChatHandoffAt');
  assertOptionalTimestamp(value.sharedAt, 'web voyage sharedAt');
  if (value.shareStatus !== undefined) {
    assertEnum(
      value.shareStatus,
      ['none', 'pending', 'delivered', 'failed'],
      'web voyage shareStatus',
    );
  }
  if (value.sourceType !== undefined) {
    assertEnum(value.sourceType, ['web', 'github'], 'web voyage sourceType');
  }
  if (value.stage !== undefined) {
    assertEnum(
      value.stage,
      ['waiting', 'query', 'search', 'fetch', 'summarize', 'completed'],
      'web voyage stage',
    );
  }
  assertOptionalString(value.summary, 'web voyage summary', 1000);
  assertOptionalString(value.title, 'web voyage title', 300);
  assertOptionalString(value.url, 'web voyage url', 4096);
}

function assertWebVoyageShare(entityId: string, value: JsonRecord) {
  assertKeys(
    value,
    ['at', 'id', 'logId', 'query', 'summary', 'title'],
    [
      'driveLabel',
      'driveReason',
      'evidenceSummary',
      'evidenceVerdict',
      'sourceType',
      'url',
    ],
    'proactive web voyage share intent',
  );
  assertEntityId(value, entityId);
  assertTimestamp(value.at, 'web voyage share at');
  assertString(value.logId, 'web voyage share logId', 256);
  assertString(value.query, 'web voyage share query', 160);
  assertString(value.summary, 'web voyage share summary', 1200);
  assertString(value.title, 'web voyage share title', 300);
  assertOptionalString(value.driveLabel, 'web share driveLabel', 80);
  assertOptionalString(value.driveReason, 'web share driveReason', 500);
  assertOptionalString(
    value.evidenceSummary,
    'web share evidenceSummary',
    1000,
  );
  assertOptionalString(
    value.evidenceVerdict,
    'web share evidenceVerdict',
    160,
  );
  if (value.sourceType !== undefined) {
    assertEnum(value.sourceType, ['web', 'github'], 'web share sourceType');
  }
  assertOptionalString(value.url, 'web share url', 4096);
}

function assertSocialLog(entityId: string, value: JsonRecord) {
  assertKeys(
    value,
    ['action', 'at', 'detail', 'id', 'platform', 'reason', 'status'],
    ['thoughtText'],
    'proactive social action log',
  );
  assertEntityId(value, entityId);
  assertEnum(
    value.action,
    ['browse', 'search', 'like', 'favorite', 'follow', 'comment', 'post'],
    'social action',
  );
  assertTimestamp(value.at, 'social action at');
  assertString(value.detail, 'social action detail', 1200, true);
  assertEnum(
    value.platform,
    ['weibo', 'xiaohongshu', 'junluo'],
    'social platform',
  );
  assertString(value.reason, 'social action reason', 500, true);
  assertEnum(
    value.status,
    ['planned', 'blocked', 'completed'],
    'social action status',
  );
  assertOptionalString(value.thoughtText, 'social thoughtText', 500);
}

function assertSocialDraft(entityId: string, value: JsonRecord) {
  assertKeys(
    value,
    [
      'content',
      'createdAt',
      'id',
      'kind',
      'platform',
      'reason',
      'status',
      'updatedAt',
    ],
    ['approvedAt', 'title'],
    'proactive social draft',
  );
  assertEntityId(value, entityId);
  assertString(value.content, 'social draft content', 1200);
  assertTimestamp(value.createdAt, 'social draft createdAt');
  assertEnum(
    value.kind,
    ['post', 'own_post_comment'],
    'social draft kind',
  );
  assertEnum(
    value.platform,
    ['weibo', 'xiaohongshu', 'junluo'],
    'social draft platform',
  );
  assertString(value.reason, 'social draft reason', 500, true);
  assertEnum(
    value.status,
    ['pending', 'approved', 'discarded'],
    'social draft status',
  );
  assertTimestamp(value.updatedAt, 'social draft updatedAt');
  assertOptionalTimestamp(value.approvedAt, 'social draft approvedAt');
  assertOptionalString(value.title, 'social draft title', 160);
}

function assertSocialShare(entityId: string, value: JsonRecord) {
  // Historical wire payload only. New captures and business materialization are retired.
  assertKeys(
    value,
    ['at', 'id', 'text'],
    [],
    'proactive social share intent',
  );
  assertEntityId(value, entityId);
  assertTimestamp(value.at, 'social share at');
  assertString(value.text, 'social share text', 1200);
}

function assertSocialCommentReply(entityId: string, value: JsonRecord) {
  assertKeys(
    value,
    ['commentId'],
    [],
    'proactive social comment reply',
  );
  assertString(value.commentId, 'social comment id', 256);
  if (value.commentId !== entityId) {
    throw new Error('social comment id 与 entity id 不一致。');
  }
}

function assertShareResponseExchange(entityId: string, value: JsonRecord) {
  assertKeys(
    value,
    [
      'id',
      'sessionId',
      'origin',
      'invitationKind',
      'sourceMessageIds',
      'responseDriveKeys',
      'excerpt',
      'state',
      'createdAt',
    ],
    ['sourcePlanId', 'resolvedAt', 'responseMessageId'],
    'proactive share response exchange',
  );
  assertEntityId(value, entityId);
  assertString(value.sessionId, 'share response sessionId', 256);
  assertEnum(
    value.origin,
    ['chat_action', 'letter', 'web_voyage', 'social_share', 'life_project_share'],
    'share response origin',
  );
  assertEnum(
    value.invitationKind,
    ['self_driven', 'you_invited'],
    'share response invitationKind',
  );
  if (
    !Array.isArray(value.sourceMessageIds)
    || value.sourceMessageIds.length < 1
    || value.sourceMessageIds.length > 16
  ) {
    throw new Error('share response sourceMessageIds 数组长度无效。');
  }
  value.sourceMessageIds.forEach((id) => assertString(id, 'share response sourceMessageId', 256));
  if (!Array.isArray(value.responseDriveKeys) || value.responseDriveKeys.length > 2) {
    throw new Error('share response responseDriveKeys 数组长度无效。');
  }
  value.responseDriveKeys.forEach((key) => assertEnum(
    key,
    ['reflection', 'social'],
    'share response drive key',
  ));
  assertString(value.excerpt, 'share response excerpt', 320, true);
  assertEnum(
    value.state,
    ['waiting', 'engaged', 'declined', 'unanswered'],
    'share response state',
  );
  assertTimestamp(value.createdAt, 'share response createdAt');
  assertOptionalString(value.sourcePlanId, 'share response sourcePlanId', 256);
  assertOptionalTimestamp(value.resolvedAt, 'share response resolvedAt');
  assertOptionalString(value.responseMessageId, 'share response responseMessageId', 256);
}

export function proactiveLedgerEntityTypeForKind(
  kind: ProactiveLedgerRecordKind,
) {
  return KIND_ENTITY[kind];
}

export function proactiveLedgerOperationForKind(
  kind: ProactiveLedgerRecordKind,
): 'append' | 'upsert' {
  return APPEND_ONLY_KINDS.has(kind) ? 'append' : 'upsert';
}

export function proactiveLedgerRetentionForKind(
  kind: ProactiveLedgerRecordKind,
) {
  if (kind === 'web-voyage-log' || kind === 'social-action-log') {
    return 'voyage-history';
  }
  if (
    kind === 'web-voyage-share-intent'
    || kind === 'social-share-intent'
    || kind === 'social-draft'
  ) {
    return 'proactive-intent';
  }
  return 'relationship-history';
}

export function assertProactiveLedgerRecord(
  kind: ProactiveLedgerRecordKind,
  entityId: string,
  value: unknown,
) {
  const record = recordOf(value, `proactive.ledger ${kind}`);
  assertJsonValue(record);
  switch (kind) {
    case 'agent-task':
      assertAgentTask(entityId, record);
      return;
    case 'active-message-delivery':
      assertActiveDelivery(entityId, record);
      return;
    case 'web-voyage-log':
      assertWebVoyageLog(entityId, record);
      return;
    case 'web-voyage-share-intent':
      assertWebVoyageShare(entityId, record);
      return;
    case 'social-action-log':
      assertSocialLog(entityId, record);
      return;
    case 'social-draft':
      assertSocialDraft(entityId, record);
      return;
    case 'social-share-intent':
      assertSocialShare(entityId, record);
      return;
    case 'social-comment-reply':
      assertSocialCommentReply(entityId, record);
      return;
    case 'share-response-exchange':
      assertShareResponseExchange(entityId, record);
  }
}

export function assertProactiveLedgerMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'proactive'
    || !['intent', 'agent-task', 'delivery', 'voyage'].includes(
      value.entity.type,
    )
  ) {
    throw new Error('proactive.ledger mutation entity 无效。');
  }
  if (
    value.revision.schemaVersion !== PROACTIVE_LEDGER_SCHEMA_VERSION
  ) {
    throw new Error('proactive.ledger schemaVersion 无效。');
  }
  if (value.sensitivity !== 'high') {
    throw new Error('proactive.ledger sensitivity 必须为 high。');
  }
  if (value.objectRefs.length) {
    throw new Error('proactive.ledger 不接受对象引用。');
  }
  if (
    value.revision.operation !== 'append'
    && value.revision.operation !== 'upsert'
    && value.revision.operation !== 'restore'
  ) {
    throw new Error('proactive.ledger 不接受物理或同步删除。');
  }
  const payload = recordOf(value.payload, 'proactive.ledger payload');
  assertKeys(
    payload,
    ['schemaVersion', 'kind', 'value'],
    [],
    'proactive.ledger payload',
  );
  if (payload.schemaVersion !== PROACTIVE_LEDGER_SCHEMA_VERSION) {
    throw new Error('proactive.ledger payload schemaVersion 无效。');
  }
  if (
    typeof payload.kind !== 'string'
    || !(payload.kind in KIND_ENTITY)
  ) {
    throw new Error('proactive.ledger kind 无效。');
  }
  const kind = payload.kind as ProactiveLedgerRecordKind;
  if (value.entity.type !== proactiveLedgerEntityTypeForKind(kind)) {
    throw new Error('proactive.ledger kind 与 entity type 不匹配。');
  }
  const expectedOperation = proactiveLedgerOperationForKind(kind);
  if (
    value.revision.operation !== expectedOperation
    && !(
      expectedOperation === 'upsert'
      && value.revision.operation === 'restore'
    )
  ) {
    throw new Error('proactive.ledger kind 与 operation 不匹配。');
  }
  if (
    value.retentionClass !== proactiveLedgerRetentionForKind(kind)
  ) {
    throw new Error('proactive.ledger retentionClass 无效。');
  }
  assertProactiveLedgerRecord(kind, value.entity.id, payload.value);
}

export function buildProactiveLedgerRecordMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  kind: ProactiveLedgerRecordKind;
  entityId: string;
  value: JsonValue;
  operation?: 'append' | 'upsert' | 'restore';
}) {
  if (input.kind === 'social-share-intent') throw new Error('retired-social-share-intent');
  const entityType = proactiveLedgerEntityTypeForKind(input.kind);
  const value = input.kind === 'share-response-exchange'
    ? { ...recordOf(input.value, 'share response exchange') } : input.value;
  if (input.kind === 'share-response-exchange') delete (value as Record<string, unknown>).sourcePlanId;
  const operation =
    input.operation ?? proactiveLedgerOperationForKind(input.kind);
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'proactive',
      type: entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation,
      schemaVersion: PROACTIVE_LEDGER_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: PROACTIVE_LEDGER_SCHEMA_VERSION,
      kind: input.kind,
      value: value as JsonValue,
    },
    objectRefs: [],
    retentionClass: proactiveLedgerRetentionForKind(input.kind),
  };
  assertProactiveLedgerMutationV1(mutation);
  return mutation;
}
