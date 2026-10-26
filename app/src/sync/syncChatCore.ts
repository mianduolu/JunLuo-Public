import { normalizeChatSummaryCorrectionReview } from '../chat/chatSummaryCorrection';
import type {
  ChatContextCompressionState,
  ChatSession,
} from '../chat/chatStorage';
import { stripRetiredActionMetadata } from '../ai/retiredAssistantFeatureData';
import { isReadingReference } from '../reading/readingReference';
import { isChatTextFileReference } from '../chat/chatTextFileReference';
import { isChatImageObservationMetadata, isChatImageReviewAttempt } from '../chat/chatImageRecord';
import { assertPokeInteractionRecord } from './syncChatRelationship';
import { isTheaterBackstageMessageSource } from '../ai/subjectiveMessages';
import { isChatReminderPlanCard } from '../chat/chatReminderPlan';
import type {
  MessageImage,
  MessageSticker,
  MessageVoice,
  SubjectiveMessage,
} from '../ai/subjectiveMessages';
import {
  assertJsonValue,
  assertPlainMutationV1,
  assertSubjectiveRole,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export const CHAT_CORE_SCHEMA_VERSION = 1 as const;
export const CHAT_SUMMARY_REVIEW_SCHEMA_VERSION = 2 as const;
export const CHAT_CORE_RETENTION_CLASS = 'relationship-history' as const;

export type ChatCoreEntityType =
  | 'session'
  | 'subjective-message'
  | 'message-summary'
  | 'attachment-metadata';

export type ChatCoreMutationEnvelope = {
  mutationId: string;
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number;
  revisionId: string;
  parentRevisionIds: string[];
  createdAt: number;
};

export type ChatSessionSyncField =
  | 'title'
  | 'customTitle'
  | 'createdAt'
  | 'updatedAt';

export type ChatAttachmentMetadataV1 = {
  attachmentId: string;
  messageId: string;
  kind: 'voice' | 'image' | 'sticker';
  metadata: { [key: string]: JsonValue };
  objectId: string | null;
};

const CHAT_SESSION_FIELDS = new Set<ChatSessionSyncField>([
  'title',
  'customTitle',
  'createdAt',
  'updatedAt',
]);
const CHAT_CORE_ENTITY_TYPES = new Set<ChatCoreEntityType>([
  'session',
  'subjective-message',
  'message-summary',
  'attachment-metadata',
]);
const SYNC_MESSAGE_KEYS = new Set([
  'id',
  'role',
  'content',
  'createdAt',
  'actionPlanId',
  'actionSourceKey',
  'deliveryStatus',
  'deliveryError',
  'sendPreparation',
  'source',
  'pokeInteraction',
  'theaterBackstage',
  'theaterBackstagePending',
  'schedulePlanCard',
  'expensePlanCard',
  'reminderPlanCard',
  'reminderOccurrenceId',
  'reminderAttemptId',
  'goalTimeCreditCard',
  'scheduleChangeCard',
  'toolCallCards',
  'scheduleOccurrenceId',
  'scheduleReminderPersona',
  'scheduleCompanionEventId',
  'scheduleCompanionKind',
  'taskExecutionSessionId',
  'taskExecutionNudgeKind',
  'musicCard',
  'musicCards',
  'replyTo',
  'readingReference',
  'fallbackDiagnostics',
  'generationDiagnostics',
  'voice',
  'voiceCallRecord',
  'images',
  'chatImageReviewAttempt',
  'sticker',
]);
const SUMMARY_KEYS = new Set([
  'summaryVersion',
  'summary',
  'summarizedThroughMessageId',
  'summarizedThroughAt',
  'lastCompressedAt',
  'shortLogs',
]);

export function chatSummarySchemaVersion(summary: Record<string, unknown>): 1 | 2 {
  return summary.correctionReview !== undefined || (Array.isArray(summary.shortLogs)
    && summary.shortLogs.some(log => log && typeof log === 'object' && log.correctionReview !== undefined))
    ? CHAT_SUMMARY_REVIEW_SCHEMA_VERSION : CHAT_CORE_SCHEMA_VERSION;
}

function assertCorrectionReview(value: unknown, label: string) {
  try {
    if (!normalizeChatSummaryCorrectionReview(value)) throw new Error('chat-summary-correction-invalid');
  } catch { throw new Error(`${label} 格式无效。`); }
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string) {
  const expectedKeys = new Set(expected);
  const extra = Object.keys(record).filter((key) => !expectedKeys.has(key));
  if (extra.length) {
    throw new Error(`${label} 包含未允许字段：${extra.sort().join(', ')}。`);
  }
  const missing = expected.filter((key) => !(key in record));
  if (missing.length) {
    throw new Error(`${label} 缺少字段：${missing.join(', ')}。`);
  }
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string) {
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length) {
    throw new Error(`${label} 包含未允许字段：${extra.sort().join(', ')}。`);
  }
}

function jsonRecord(value: unknown, label: string) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error(`${label} 不能序列化为 JSON。`);
  }
  const parsed: unknown = JSON.parse(serialized);
  assertJsonValue(parsed, label);
  return recordOf(parsed, label) as { [key: string]: JsonValue };
}

function withoutUri<T extends { uri: string }>(value: T) {
  const { uri: _localUri, ...metadata } = value;
  return metadata;
}

function assertChatImageReviewAttempt(message: Record<string, unknown>) {
  if (message.chatImageReviewAttempt !== undefined && (message.role !== 'you'
    || !isChatImageReviewAttempt(message.chatImageReviewAttempt))) {
    throw new Error('chat message chatImageReviewAttempt 无效。');
  }
}

function assertSendPreparation(message: Record<string, unknown>) {
  if (message.sendPreparation !== undefined && (message.role !== 'you' || message.sendPreparation !== 'sleep')) {
    throw new Error('chat message sendPreparation 无效。');
  }
}

function assertChatImageObservationMetadata(image: Record<string, unknown>) {
  if (!isChatImageObservationMetadata(image)) throw new Error('chat image observation metadata 无效。');
}

export function sanitizeChatMessageForSync(message: SubjectiveMessage) {
  assertSubjectiveRole(message.role);
  const sanitized = jsonRecord(stripRetiredActionMetadata(message), 'chat message');
  assertAllowedKeys(sanitized, SYNC_MESSAGE_KEYS, 'chat message');
  assertChatImageReviewAttempt(sanitized);
  assertSendPreparation(sanitized);
  if (sanitized.readingReference !== undefined && (message.role !== 'you' || !isReadingReference(sanitized.readingReference))) {
    throw new Error('chat message readingReference 无效。');
  }
  assertTheaterBackstageSource(sanitized);
  if (sanitized.reminderPlanCard !== undefined) {
    const card = recordOf(sanitized.reminderPlanCard, 'chat reminder plan card');
    if (Array.isArray(card.rows)) for (const row of card.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      for (const field of ['expected', 'result']) {
        const record = row[field];
        if (record && typeof record === 'object' && !Array.isArray(record)) {
          for (const key of ['notificationId', 'strongAlarmNativeId', 'strongAlarmExactAlarmAllowed', 'strongAlarmNotificationEnabled', 'strongAlarmBatteryOptimizationIgnored']) delete record[key];
        }
      }
    }
  }
  assertChatReminderMessageMetadata(sanitized);
  if (sanitized.pokeInteraction !== undefined) {
    if (message.role !== 'I') throw new Error('poke interaction 只能关联 I 回复。');
    assertPokeInteractionRecord(sanitized.pokeInteraction);
  }

  if (message.voice) {
    sanitized.voice = jsonRecord(
      withoutUri(message.voice),
      'chat message voice metadata',
    );
  }
  if (message.images) {
    sanitized.images = message.images.map((image) => {
      const metadata = jsonRecord(withoutUri(image), 'chat message image metadata');
      assertChatImageObservationMetadata(metadata);
      return metadata;
    });
  }
  if (message.sticker) {
    sanitized.sticker = jsonRecord(
      withoutUri(message.sticker),
      'chat message sticker metadata',
    );
  }
  return sanitized;
}

function attachmentMetadata(
  messageId: string,
  kind: ChatAttachmentMetadataV1['kind'],
  attachmentId: string,
  value: MessageVoice | MessageImage | MessageSticker,
  objectId: string | null,
): ChatAttachmentMetadataV1 {
  return {
    attachmentId,
    messageId,
    kind,
    metadata: jsonRecord(withoutUri(value), `chat ${kind} attachment metadata`),
    objectId,
  };
}

export function extractChatAttachmentMetadata(
  message: SubjectiveMessage,
  objectIds: Readonly<Record<string, string>> = {},
) {
  const attachments: ChatAttachmentMetadataV1[] = [];
  if (message.voice) {
    const attachmentId = `${message.id}:voice`;
    attachments.push(attachmentMetadata(
      message.id,
      'voice',
      attachmentId,
      message.voice,
      objectIds[attachmentId] ?? null,
    ));
  }
  for (const image of message.images ?? []) {
    attachments.push(attachmentMetadata(
      message.id,
      'image',
      image.id,
      image,
      objectIds[image.id] ?? null,
    ));
  }
  if (message.sticker) {
    attachments.push(attachmentMetadata(
      message.id,
      'sticker',
      message.sticker.id,
      message.sticker,
      objectIds[message.sticker.id] ?? null,
    ));
  }
  return attachments;
}

export function selectChatSummaryForSync(
  compression: ChatContextCompressionState | undefined,
) {
  const source = compression ?? {
    summaryVersion: 2,
    summary: '',
    summarizedThroughMessageId: null,
    summarizedThroughAt: null,
    lastCompressedAt: null,
    shortLogs: [],
  };
  const reviewFields = compression?.correctionReview !== undefined || source.shortLogs?.some(log => log.correctionReview !== undefined);
  return jsonRecord({
    summaryVersion: source.summaryVersion,
    summary: source.summary,
    summarizedThroughMessageId: source.summarizedThroughMessageId,
    summarizedThroughAt: source.summarizedThroughAt,
    lastCompressedAt: source.lastCompressedAt,
    shortLogs: source.shortLogs ?? [],
    ...(reviewFields ? { correctionReview: compression?.correctionReview ?? null } : {}),
  }, 'chat message summary');
}

function buildMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: ChatCoreEntityType;
  entityId: string;
  operation: SyncOperation;
  payload: JsonValue;
  objectRefs?: string[];
  schemaVersion?: 1 | 2;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'chat',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: input.operation,
      schemaVersion: input.schemaVersion ?? CHAT_CORE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: input.payload,
    objectRefs: [...(input.objectRefs ?? [])],
    retentionClass: CHAT_CORE_RETENTION_CLASS,
  };
  assertChatCoreMutationV1(mutation);
  return mutation;
}

export function buildChatSessionMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  session: Pick<ChatSession, 'id' | 'title' | 'customTitle' | 'createdAt' | 'updatedAt'>;
  changedFields?: readonly ChatSessionSyncField[];
}) {
  const changedFields = input.changedFields ?? [...CHAT_SESSION_FIELDS];
  if (!changedFields.length || changedFields.some((field) => !CHAT_SESSION_FIELDS.has(field))) {
    throw new Error('chat session changedFields 不能为空或包含未知字段。');
  }
  const fields: { [key: string]: JsonValue } = {};
  for (const field of changedFields) {
    fields[field] = input.session[field];
  }
  return buildMutation({
    envelope: input.envelope,
    entityType: 'session',
    entityId: input.session.id,
    operation: 'upsert',
    payload: {
      schemaVersion: CHAT_CORE_SCHEMA_VERSION,
      fields,
    },
  });
}

export function buildChatMessageMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  sessionId: string;
  message: SubjectiveMessage;
  objectRefs?: string[];
}) {
  const message = sanitizeChatMessageForSync(input.message);
  return buildMutation({
    envelope: input.envelope,
    entityType: 'subjective-message',
    entityId: input.message.id,
    operation: 'append',
    payload: {
      schemaVersion: CHAT_CORE_SCHEMA_VERSION,
      sessionId: input.sessionId,
      message,
    },
    objectRefs: input.objectRefs,
  });
}

export function buildChatSummaryMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  sessionId: string;
  compression?: ChatContextCompressionState;
  memoryOrganizedThroughId: string | null;
  proactiveMemoryReviewedThroughId: string | null;
}) {
  const summary = selectChatSummaryForSync(input.compression);
  const schemaVersion = chatSummarySchemaVersion(summary);
  return buildMutation({
    envelope: input.envelope,
    entityType: 'message-summary',
    entityId: input.sessionId,
    operation: 'upsert',
    schemaVersion,
    payload: {
      schemaVersion,
      sessionId: input.sessionId,
      memoryOrganizedThroughId: input.memoryOrganizedThroughId,
      proactiveMemoryReviewedThroughId: input.proactiveMemoryReviewedThroughId,
      summary,
    },
  });
}

export function buildChatAttachmentMetadataMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  attachment: ChatAttachmentMetadataV1;
}) {
  return buildMutation({
    envelope: input.envelope,
    entityType: 'attachment-metadata',
    entityId: input.attachment.attachmentId,
    operation: 'upsert',
    payload: {
      schemaVersion: CHAT_CORE_SCHEMA_VERSION,
      ...input.attachment,
    },
    objectRefs: input.attachment.objectId ? [input.attachment.objectId] : [],
  });
}

export function buildChatDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: ChatCoreEntityType;
  entityId: string;
  deletedAt: number;
}) {
  return buildMutation({
    envelope: input.envelope,
    entityType: input.entityType,
    entityId: input.entityId,
    operation: 'delete',
    payload: {
      schemaVersion: CHAT_CORE_SCHEMA_VERSION,
      deletedAt: input.deletedAt,
    },
  });
}

function assertTheaterBackstageSource(message: Record<string, unknown>) {
  if (message.theaterBackstage !== undefined && (
    message.role !== 'I' || !isTheaterBackstageMessageSource(message.theaterBackstage)
  )) throw new Error('chat message theaterBackstage 只能包含 I 回复的有效轻量来源。');
  if (message.theaterBackstagePending !== undefined && (
    message.theaterBackstagePending !== true || message.role !== 'I' || !isTheaterBackstageMessageSource(message.theaterBackstage)
  )) throw new Error('chat message theaterBackstagePending 只能是带有效幕后来源的 I 回复等待确认标记。');
}

function assertChatReminderMessageMetadata(message: Record<string, unknown>) {
  if (message.reminderPlanCard !== undefined) {
    if (message.role !== 'I' || !isChatReminderPlanCard(message.reminderPlanCard)) throw new Error('chat message reminderPlanCard 无效。');
    const card = message.reminderPlanCard;
    for (const row of card.rows) for (const record of [row.expected, row.result]) {
      if (record && ['notificationId', 'strongAlarmNativeId', 'strongAlarmExactAlarmAllowed', 'strongAlarmNotificationEnabled', 'strongAlarmBatteryOptimizationIgnored']
        .some(key => key in record)) throw new Error('chat message reminderPlanCard 不允许设备绑定。');
    }
  }
  const fields = ['reminderOccurrenceId', 'reminderAttemptId'];
  if (fields.some(key => key in message)) {
    if (message.role !== 'I' || message.source !== 'schedule-reminder' || fields.some(key => typeof message[key] !== 'string'
      || !(message[key] as string).trim() || (message[key] as string).length > 1000
      || /^(?:[a-z]:[\\/]|file:|content:|\/|\\\\)/i.test(message[key] as string))) throw new Error('chat message reminder occurrence 标记无效。');
  }
}

function assertMessagePayload(payload: Record<string, unknown>, mutation: PlainMutationV1) {
  assertExactKeys(payload, ['schemaVersion', 'sessionId', 'message'], 'chat message payload');
  if (typeof payload.sessionId !== 'string' || !payload.sessionId) {
    throw new Error('chat message sessionId 格式无效。');
  }
  const message = recordOf(payload.message, 'chat message');
  assertChatReminderMessageMetadata(message);
  if (message.expensePlanCard !== undefined) {
    const card = recordOf(message.expensePlanCard, 'chat message expensePlanCard');
    if (message.role !== 'I' || card.version !== 1 || !Array.isArray(card.rows)) throw new Error('chat message expensePlanCard 无效。');
  }
  assertAllowedKeys(message, SYNC_MESSAGE_KEYS, 'chat message');
  assertChatImageReviewAttempt(message);
  assertSendPreparation(message);
  assertTheaterBackstageSource(message);
  if (message.id !== mutation.entity.id) {
    throw new Error('chat message id 与 entity.id 不一致。');
  }
  assertSubjectiveRole(message.role);
  if (Array.isArray(message.toolCallCards)) {
    for (const card of message.toolCallCards) {
      if (card && typeof card === 'object' && 'fileReference' in card
        && !isChatTextFileReference(card.fileReference)) throw new Error('chat fileReference 格式无效。');
    }
  }
  if (message.readingReference !== undefined && (message.role !== 'you' || !isReadingReference(message.readingReference))) {
    throw new Error('chat message readingReference 无效。');
  }
  if (typeof message.content !== 'string' || !Number.isSafeInteger(message.createdAt)) {
    throw new Error('chat message 正文或时间无效。');
  }
  if (message.pokeInteraction !== undefined) {
    if (message.role !== 'I') throw new Error('poke interaction 只能关联 I 回复。');
    assertPokeInteractionRecord(message.pokeInteraction);
  }
  for (const field of ['actionPlanId', 'actionSourceKey'] as const) {
    if (
      field in message
      && (typeof message[field] !== 'string' || !message[field])
    ) {
      throw new Error(`chat message ${field} 必须是非空字符串。`);
    }
  }
  const voice = message.voice == null ? null : recordOf(message.voice, 'chat message voice metadata');
  if (voice && 'uri' in voice) throw new Error('chat message voice metadata 不能包含本地 uri。');
  if (message.images != null) {
    if (!Array.isArray(message.images)) throw new Error('chat message images 必须是数组。');
    message.images.forEach((image, index) => {
      const metadata = recordOf(image, `chat message images[${index}]`);
      assertChatImageObservationMetadata(metadata);
      if ('uri' in metadata) {
        throw new Error('chat message image metadata 不能包含本地 uri。');
      }
    });
  }
  const sticker = message.sticker == null ? null : recordOf(message.sticker, 'chat message sticker metadata');
  if (sticker && 'uri' in sticker) throw new Error('chat message sticker metadata 不能包含本地 uri。');
}

function assertSessionPayload(payload: Record<string, unknown>) {
  assertExactKeys(payload, ['schemaVersion', 'fields'], 'chat session payload');
  const fields = recordOf(payload.fields, 'chat session fields');
  assertAllowedKeys(fields, CHAT_SESSION_FIELDS, 'chat session fields');
  if (!Object.keys(fields).length) throw new Error('chat session fields 不能为空。');
  if ('title' in fields && typeof fields.title !== 'string') throw new Error('chat session title 必须是字符串。');
  if ('customTitle' in fields && typeof fields.customTitle !== 'boolean') {
    throw new Error('chat session customTitle 必须是布尔值。');
  }
  for (const timestampField of ['createdAt', 'updatedAt'] as const) {
    if (timestampField in fields && !Number.isSafeInteger(fields[timestampField])) {
      throw new Error(`chat session ${timestampField} 必须是整数。`);
    }
  }
}

function assertSummaryPayload(payload: Record<string, unknown>, mutation: PlainMutationV1) {
  assertExactKeys(
    payload,
    [
      'schemaVersion',
      'sessionId',
      'memoryOrganizedThroughId',
      'proactiveMemoryReviewedThroughId',
      'summary',
    ],
    'chat summary payload',
  );
  if (payload.sessionId !== mutation.entity.id) {
    throw new Error('chat summary sessionId 与 entity.id 不一致。');
  }
  for (const cursor of ['memoryOrganizedThroughId', 'proactiveMemoryReviewedThroughId'] as const) {
    if (payload[cursor] !== null && typeof payload[cursor] !== 'string') {
      throw new Error(`chat summary ${cursor} 格式无效。`);
    }
  }
  const summary = recordOf(payload.summary, 'chat summary');
  const reviewed = mutation.revision.schemaVersion === CHAT_SUMMARY_REVIEW_SCHEMA_VERSION;
  assertExactKeys(summary, [...SUMMARY_KEYS, ...(reviewed ? ['correctionReview'] : [])], 'chat summary');
  if (!reviewed) {
    if (chatSummarySchemaVersion(summary) !== CHAT_CORE_SCHEMA_VERSION) throw new Error('chat summary v1 不允许更正依据。');
    return;
  }
  if (summary.summaryVersion !== 2 || !Array.isArray(summary.shortLogs)) throw new Error('chat summary v2 格式无效。');
  if (summary.correctionReview !== null) assertCorrectionReview(summary.correctionReview, 'chat summary.correctionReview');
  for (const value of summary.shortLogs) {
    const log = recordOf(value, 'chat summary shortLog');
    if (log.correctionReview !== undefined) assertCorrectionReview(log.correctionReview, 'chat summary shortLog.correctionReview');
  }
}

function assertAttachmentPayload(payload: Record<string, unknown>, mutation: PlainMutationV1) {
  assertExactKeys(
    payload,
    ['schemaVersion', 'attachmentId', 'messageId', 'kind', 'metadata', 'objectId'],
    'chat attachment payload',
  );
  if (payload.attachmentId !== mutation.entity.id) {
    throw new Error('chat attachmentId 与 entity.id 不一致。');
  }
  if (typeof payload.messageId !== 'string' || !payload.messageId) {
    throw new Error('chat attachment messageId 格式无效。');
  }
  if (payload.kind !== 'voice' && payload.kind !== 'image' && payload.kind !== 'sticker') {
    throw new Error('chat attachment kind 不受支持。');
  }
  const metadata = recordOf(payload.metadata, 'chat attachment metadata');
  if (payload.kind === 'image') assertChatImageObservationMetadata(metadata);
  if ('uri' in metadata) throw new Error('chat attachment metadata 不能包含本地 uri。');
  if (payload.objectId !== null && typeof payload.objectId !== 'string') {
    throw new Error('chat attachment objectId 格式无效。');
  }
  const expectedRefs = payload.objectId === null ? [] : [payload.objectId as string];
  if (
    expectedRefs.length !== mutation.objectRefs.length
    || expectedRefs.some((objectId, index) => mutation.objectRefs[index] !== objectId)
  ) {
    throw new Error('chat attachment objectId 与 objectRefs 不一致。');
  }
}

export function assertChatCoreMutationV1(value: unknown): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  const mutation = value;
  if (mutation.entity.domain !== 'chat' || !CHAT_CORE_ENTITY_TYPES.has(mutation.entity.type as ChatCoreEntityType)) {
    throw new Error('mutation 不是受支持的 chat.core entity。');
  }
  const reviewedSummary = mutation.entity.type === 'message-summary' && mutation.revision.operation !== 'delete'
    && mutation.revision.schemaVersion === CHAT_SUMMARY_REVIEW_SCHEMA_VERSION;
  if (mutation.revision.schemaVersion !== CHAT_CORE_SCHEMA_VERSION && !reviewedSummary) {
    throw new Error('chat.core schemaVersion 不受支持。');
  }
  if (mutation.sensitivity !== 'high' || mutation.retentionClass !== CHAT_CORE_RETENTION_CLASS) {
    throw new Error('chat.core 敏感级别或留存分类不正确。');
  }
  const payload = recordOf(mutation.payload, 'chat.core payload');
  if (payload.schemaVersion !== mutation.revision.schemaVersion) {
    throw new Error('chat.core payload schemaVersion 不受支持。');
  }
  if (mutation.revision.operation === 'delete') {
    assertExactKeys(payload, ['schemaVersion', 'deletedAt'], 'chat delete payload');
    if (!Number.isSafeInteger(payload.deletedAt)) throw new Error('chat delete deletedAt 必须是整数。');
    return;
  }

  switch (mutation.entity.type as ChatCoreEntityType) {
    case 'session':
      if (mutation.revision.operation !== 'upsert') throw new Error('chat session 只允许 upsert 或 delete。');
      assertSessionPayload(payload);
      return;
    case 'subjective-message':
      if (mutation.revision.operation !== 'append' && mutation.revision.operation !== 'upsert') {
        throw new Error('chat message 只允许 append、upsert 或 delete。');
      }
      assertMessagePayload(payload, mutation);
      return;
    case 'message-summary':
      if (mutation.revision.operation !== 'upsert') throw new Error('chat summary 只允许 upsert 或 delete。');
      assertSummaryPayload(payload, mutation);
      return;
    case 'attachment-metadata':
      if (mutation.revision.operation !== 'upsert') throw new Error('chat attachment 只允许 upsert 或 delete。');
      assertAttachmentPayload(payload, mutation);
  }
}
