import type {
  SubjectiveMessage,
} from '../ai/subjectiveMessages';
import type {
  ChatSession,
} from '../chat/chatStorage';
import { assertPrimaryChatSessionId } from '../chat/primaryChat';
import {
  assertChatCoreMutationV1,
  buildChatAttachmentMetadataMutation,
  buildChatDeleteMutation,
  buildChatMessageMutation,
  buildChatSessionMutation,
  buildChatSummaryMutation,
  extractChatAttachmentMetadata,
  selectChatSummaryForSync,
  type ChatCoreMutationEnvelope,
  type ChatSessionSyncField,
} from './syncChatCore';
import type {
  SyncMutationEntityRef,
} from './syncMutationEnvelope';
import type {
  PlainMutationV1,
} from './syncProtocol';

export const CHAT_SESSIONS_KEY = 'junluo.chat.sessions';
const ACTIVE_CHAT_SESSION_KEY = 'junluo.chat.activeSessionId';
export const CHAT_SESSION_MESSAGE_PREFIX = 'junluo.chat.sessionMessage.';
const CHAT_SESSION_MESSAGE_ORDER_PREFIX = 'junluo.chat.sessionMessageOrder.';
const CHAT_SESSION_MESSAGES_PREFIX = 'junluo.chat.sessionMessages.';

type StorageSet = {
  kind: 'set';
  key: string;
  value: string;
};

type StorageRemove = {
  kind: 'remove';
  key: string;
};

export type ChatStorageChange = StorageSet | StorageRemove;

export function assertPrimaryChatStorageChanges(changes: readonly ChatStorageChange[]) {
  for (const change of changes) {
    if (change.kind !== 'set') continue;
    if (change.key === CHAT_SESSIONS_KEY) {
      parseSessionIndexes(change.value).forEach(session => assertPrimaryChatSessionId(session.id));
    } else if (change.key === ACTIVE_CHAT_SESSION_KEY) {
      assertPrimaryChatSessionId(change.value);
    } else if (change.key.startsWith(CHAT_SESSION_MESSAGE_PREFIX)) {
      const message = parseMessage(change.value, 'next chat message');
      if (!message) throw new Error('消息存储不能为空。');
      assertPrimaryChatSessionId(messageIdentityFromKey(change.key, message).sessionId);
    } else {
      const prefix = [CHAT_SESSION_MESSAGE_ORDER_PREFIX, CHAT_SESSION_MESSAGES_PREFIX].find(value => change.key.startsWith(value));
      if (prefix) assertPrimaryChatSessionId(decodeURIComponent(change.key.slice(prefix.length)));
    }
  }
}

export function deriveLegacyChatMessageStorageChanges(
  sessionsRaw: string | null,
) {
  if (!sessionsRaw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(sessionsRaw);
  } catch {
    throw new Error('chat.core bootstrap 会话索引不是有效 JSON。');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('chat.core bootstrap 会话索引必须是数组。');
  }
  const changes: ChatStorageChange[] = [];
  for (const rawSession of parsed) {
    if (
      !isRecord(rawSession)
      || typeof rawSession.id !== 'string'
      || !Array.isArray(rawSession.messages)
    ) {
      continue;
    }
    for (const rawMessage of rawSession.messages) {
      if (!isRecord(rawMessage) || typeof rawMessage.id !== 'string') continue;
      changes.push({
        kind: 'set',
        key: `${CHAT_SESSION_MESSAGE_PREFIX}${encodeURIComponent(rawSession.id)}.${encodeURIComponent(rawMessage.id)}`,
        value: JSON.stringify(rawMessage),
      });
    }
  }
  return changes;
}

type ChatSessionIndexRecord = Pick<
  ChatSession,
  | 'id'
  | 'title'
  | 'customTitle'
  | 'memoryOrganizedThroughId'
  | 'proactiveMemoryReviewedThroughId'
  | 'contextCompression'
  | 'createdAt'
  | 'updatedAt'
> & {
  messageCount: number;
};

export type ChatStorageBridgeReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type ChatStorageBridgeEnvelopeFactory = (
  entity: SyncMutationEntityRef,
) => Promise<ChatCoreMutationEnvelope>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseSessionIndexes(raw: string | null) {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('chat session index 不是有效 JSON，不能捕获同步变更。');
  }
  if (!Array.isArray(parsed)) throw new Error('chat session index 必须是数组。');
  const sessions: ChatSessionIndexRecord[] = [];
  for (const value of parsed) {
    if (
      !isRecord(value)
      || typeof value.id !== 'string'
      || typeof value.title !== 'string'
      || typeof value.customTitle !== 'boolean'
      || typeof value.createdAt !== 'number'
      || typeof value.updatedAt !== 'number'
    ) {
      throw new Error('chat session index 记录缺少稳定字段。');
    }
    sessions.push(value as unknown as ChatSessionIndexRecord);
  }
  return sessions;
}

function parseMessage(raw: string | null, label: string) {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
  if (
    !isRecord(parsed)
    || typeof parsed.id !== 'string'
    || (parsed.role !== 'I' && parsed.role !== 'you')
    || typeof parsed.content !== 'string'
    || typeof parsed.createdAt !== 'number'
  ) {
    throw new Error(`${label} 缺少稳定消息字段。`);
  }
  return parsed as unknown as SubjectiveMessage;
}

function sessionFieldsChanged(
  before: ChatSessionIndexRecord,
  after: ChatSessionIndexRecord,
) {
  const fields: ChatSessionSyncField[] = [];
  for (const field of ['title', 'customTitle', 'createdAt', 'updatedAt'] as const) {
    if (before[field] !== after[field]) fields.push(field);
  }
  return fields;
}

function summaryShape(session: ChatSessionIndexRecord) {
  return {
    memoryOrganizedThroughId: session.memoryOrganizedThroughId ?? null,
    proactiveMemoryReviewedThroughId: session.proactiveMemoryReviewedThroughId ?? null,
    summary: selectChatSummaryForSync(session.contextCompression),
  };
}

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sessionForBuilder(session: ChatSessionIndexRecord) {
  return {
    id: session.id,
    title: session.title,
    customTitle: session.customTitle,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

async function buildSessionIndexMutations(input: {
  beforeRaw: string | null;
  afterRaw: string | null;
  deletedAt: number;
  envelopeFactory: ChatStorageBridgeEnvelopeFactory;
}) {
  const mutations: PlainMutationV1[] = [];
  const before = parseSessionIndexes(input.beforeRaw);
  const after = parseSessionIndexes(input.afterRaw);
  const beforeById = new Map(before.map((session) => [session.id, session]));
  const afterById = new Map(after.map((session) => [session.id, session]));

  for (const oldSession of [...before].sort((left, right) => left.id.localeCompare(right.id))) {
    if (afterById.has(oldSession.id)) continue;
    mutations.push(buildChatDeleteMutation({
      envelope: await input.envelopeFactory({
        domain: 'chat',
        type: 'session',
        id: oldSession.id,
      }),
      entityType: 'session',
      entityId: oldSession.id,
      deletedAt: input.deletedAt,
    }));
  }
  for (const nextSession of [...after].sort((left, right) => left.id.localeCompare(right.id))) {
    assertPrimaryChatSessionId(nextSession.id);
    const oldSession = beforeById.get(nextSession.id);
    if (!oldSession) {
      mutations.push(buildChatSessionMutation({
        envelope: await input.envelopeFactory({
          domain: 'chat',
          type: 'session',
          id: nextSession.id,
        }),
        session: sessionForBuilder(nextSession),
      }));
      mutations.push(buildChatSummaryMutation({
        envelope: await input.envelopeFactory({
          domain: 'chat',
          type: 'message-summary',
          id: nextSession.id,
        }),
        sessionId: nextSession.id,
        compression: nextSession.contextCompression,
        memoryOrganizedThroughId: nextSession.memoryOrganizedThroughId ?? null,
        proactiveMemoryReviewedThroughId: nextSession.proactiveMemoryReviewedThroughId ?? null,
      }));
      continue;
    }
    const changedFields = sessionFieldsChanged(oldSession, nextSession);
    if (changedFields.length) {
      const portableFields = changedFields.includes('createdAt')
        ? changedFields
        : [...changedFields, 'createdAt' as const];
      mutations.push(buildChatSessionMutation({
        envelope: await input.envelopeFactory({
          domain: 'chat',
          type: 'session',
          id: nextSession.id,
        }),
        session: sessionForBuilder(nextSession),
        changedFields: portableFields,
      }));
    }
    if (!jsonEqual(summaryShape(oldSession), summaryShape(nextSession))) {
      mutations.push(buildChatSummaryMutation({
        envelope: await input.envelopeFactory({
          domain: 'chat',
          type: 'message-summary',
          id: nextSession.id,
        }),
        sessionId: nextSession.id,
        compression: nextSession.contextCompression,
        memoryOrganizedThroughId: nextSession.memoryOrganizedThroughId ?? null,
        proactiveMemoryReviewedThroughId: nextSession.proactiveMemoryReviewedThroughId ?? null,
      }));
    }
  }
  return mutations;
}

function messageIdentityFromKey(key: string, message: SubjectiveMessage) {
  const encodedMessageSuffix = `.${encodeURIComponent(message.id)}`;
  const encodedPair = key.slice(CHAT_SESSION_MESSAGE_PREFIX.length);
  if (!encodedPair.endsWith(encodedMessageSuffix)) {
    throw new Error('chat message storage key 与消息 ID 不一致。');
  }
  const encodedSessionId = encodedPair.slice(0, -encodedMessageSuffix.length);
  if (!encodedSessionId) throw new Error('chat message storage key 缺少 session ID。');
  return {
    sessionId: decodeURIComponent(encodedSessionId),
    messageId: message.id,
  };
}

function messageUpsertMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  sessionId: string;
  message: SubjectiveMessage;
}) {
  const mutation = buildChatMessageMutation(input);
  mutation.revision.operation = 'upsert';
  assertChatCoreMutationV1(mutation);
  return mutation;
}

async function buildMessageMutations(input: {
  change: ChatStorageChange;
  beforeRaw: string | null;
  deletedAt: number;
  envelopeFactory: ChatStorageBridgeEnvelopeFactory;
}) {
  const before = parseMessage(input.beforeRaw, 'stored chat message');
  const after = input.change.kind === 'set'
    ? parseMessage(input.change.value, 'next chat message')
    : null;
  if (before && after && jsonEqual(before, after)) return [];
  const reference = after ?? before;
  if (!reference) return [];
  const { sessionId, messageId } = messageIdentityFromKey(input.change.key, reference);
  if (!after) {
    return [buildChatDeleteMutation({
      envelope: await input.envelopeFactory({
        domain: 'chat',
        type: 'subjective-message',
        id: messageId,
      }),
      entityType: 'subjective-message',
      entityId: messageId,
      deletedAt: input.deletedAt,
    })];
  }
  assertPrimaryChatSessionId(sessionId);

  const attachments = extractChatAttachmentMetadata(after)
    .sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
  const mutations: PlainMutationV1[] = [
    (before ? messageUpsertMutation : buildChatMessageMutation)({
      envelope: await input.envelopeFactory({
        domain: 'chat',
        type: 'subjective-message',
        id: messageId,
      }),
      sessionId,
      message: after,
    }),
  ];
  for (const attachment of attachments) {
    mutations.push(buildChatAttachmentMetadataMutation({
      envelope: await input.envelopeFactory({
        domain: 'chat',
        type: 'attachment-metadata',
        id: attachment.attachmentId,
      }),
      attachment,
    }));
  }
  return mutations;
}

function isMessageRecordKey(key: string) {
  return key.startsWith(CHAT_SESSION_MESSAGE_PREFIX);
}

function isTechnicalChatKey(key: string) {
  return (
    key === ACTIVE_CHAT_SESSION_KEY
    || key.startsWith(CHAT_SESSION_MESSAGE_ORDER_PREFIX)
    || key.startsWith(CHAT_SESSION_MESSAGES_PREFIX)
  );
}

export async function deriveChatCoreMutationsForStorageChanges(input: {
  changes: readonly ChatStorageChange[];
  reader: ChatStorageBridgeReadPort;
  envelopeFactory: ChatStorageBridgeEnvelopeFactory;
  deletedAt: number;
}) {
  assertPrimaryChatStorageChanges(input.changes);
  const lastChangeByKey = new Map<string, ChatStorageChange>();
  input.changes.forEach((change) => lastChangeByKey.set(change.key, change));
  const changes = [...lastChangeByKey.values()].sort((left, right) => left.key.localeCompare(right.key));
  const mutations: PlainMutationV1[] = [];

  for (const change of changes) {
    if (change.key === CHAT_SESSIONS_KEY) {
      mutations.push(...await buildSessionIndexMutations({
        beforeRaw: await input.reader.getItem(change.key),
        afterRaw: change.kind === 'set' ? change.value : null,
        deletedAt: input.deletedAt,
        envelopeFactory: input.envelopeFactory,
      }));
      continue;
    }
    if (isMessageRecordKey(change.key)) {
      mutations.push(...await buildMessageMutations({
        change,
        beforeRaw: await input.reader.getItem(change.key),
        deletedAt: input.deletedAt,
        envelopeFactory: input.envelopeFactory,
      }));
      continue;
    }
    if (!isTechnicalChatKey(change.key)) {
      throw new Error(`chatStorage 尝试写入未登记 key：${change.key}。`);
    }
  }
  return mutations;
}
