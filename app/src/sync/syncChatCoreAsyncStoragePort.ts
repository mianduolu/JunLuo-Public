import { stripRetiredActionMetadata } from '../ai/retiredAssistantFeatureData';
import { isReadingReference } from '../reading/readingReference';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { registerLateInnerUpdateMessages } from '../chat/chatAfterglowState';
import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import type {
  MessageImage,
  MessageSticker,
  MessageVoice,
  SubjectiveMessage,
} from '../ai/subjectiveMessages';
import {
  emptyChatContextCompressionState,
  loadChatSessionMessages,
  loadChatSessionSnapshot,
  loadChatState,
  mergeAndSaveChatSessionMessages,
  patchChatSessionFields,
  replaceChatSessionMessages,
  type ChatContextCompressionState,
} from '../chat/chatStorage';
import {
  assertChatCoreMutationV1,
} from './syncChatCore';
import type {
  SyncCurrentObjectReference,
} from './syncObjectJobStore';
import {
  emitChatMessagesAppended,
} from '../chat/chatMessageEvents';
import {
  assertSubjectiveRole,
  type JsonValue,
} from './syncProtocol';
import type {
  ChatCoreBusinessPort,
} from './syncChatCoreApply';

type JsonRecord = { [key: string]: JsonValue };

let chatCoreApplyQueue = Promise.resolve();

function enqueueChatCoreApply<T>(apply: () => Promise<T>) {
  const current = chatCoreApplyQueue.catch(() => undefined).then(apply);
  chatCoreApplyQueue = current.then(() => undefined, () => undefined);
  return current;
}

function recordOf(value: JsonValue | undefined, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as JsonRecord;
}

function hasLocalUri(value: unknown): value is { uri: string } {
  return !!value
    && typeof value === 'object'
    && typeof (value as { uri?: unknown }).uri === 'string'
    && !!(value as { uri: string }).uri;
}

function mergeVoiceWithLocalUri(
  incoming: JsonValue | undefined,
  existing: MessageVoice | undefined,
) {
  if (!incoming || !existing || !hasLocalUri(existing)) return undefined;
  return {
    ...recordOf(incoming, 'sync voice metadata'),
    uri: existing.uri,
  } as MessageVoice;
}

function mergeImagesWithLocalUris(
  incoming: JsonValue | undefined,
  existing: MessageImage[] | undefined,
) {
  if (!Array.isArray(incoming) || !existing?.length) return undefined;
  const existingById = new Map(existing.map((image) => [image.id, image]));
  const materialized: MessageImage[] = [];
  for (const value of incoming) {
    const metadata = recordOf(value, 'sync image metadata');
    const id = typeof metadata.id === 'string' ? metadata.id : '';
    const local = existingById.get(id);
    if (!local || !hasLocalUri(local)) continue;
    materialized.push({
      ...metadata,
      uri: local.uri,
    } as MessageImage);
  }
  return materialized.length ? materialized : undefined;
}

function mergeStickerWithLocalUri(
  incoming: JsonValue | undefined,
  existing: MessageSticker | undefined,
) {
  if (!incoming || !existing || !hasLocalUri(existing)) return undefined;
  const metadata = recordOf(incoming, 'sync sticker metadata');
  if (metadata.id !== existing.id) return undefined;
  return {
    ...metadata,
    uri: existing.uri,
  } as MessageSticker;
}

export function materializeSyncChatMessage(
  incoming: JsonRecord,
  existing?: SubjectiveMessage,
): SubjectiveMessage {
  assertSubjectiveRole(incoming.role);
  if (incoming.readingReference !== undefined && (incoming.role !== 'you' || !isReadingReference(incoming.readingReference))) {
    throw new Error('sync chat message readingReference 无效。');
  }
  if (
    typeof incoming.id !== 'string'
    || typeof incoming.content !== 'string'
    || !Number.isSafeInteger(incoming.createdAt)
  ) {
    throw new Error('sync chat message 必填字段无效。');
  }
  const next = {
    ...stripRetiredActionMetadata(incoming),
    ...(incoming.role === 'you' && existing?.id === incoming.id && existing.role === 'you' && existing.readingReference
      ? { readingReference: existing.readingReference } : {}),
    ...(incoming.role === 'I' && incoming.pokeInteraction === undefined && existing?.id === incoming.id && existing.role === 'I'
      && existing.pokeInteraction ? { pokeInteraction: existing.pokeInteraction } : {}),
    voice: mergeVoiceWithLocalUri(incoming.voice, existing?.voice),
    images: mergeImagesWithLocalUris(incoming.images, existing?.images),
    sticker: mergeStickerWithLocalUri(incoming.sticker, existing?.sticker),
  } as unknown as SubjectiveMessage;
  if (!next.voice) delete next.voice;
  if (!next.images) delete next.images;
  if (!next.sticker) delete next.sticker;
  return next;
}

type MaterializedChatAttachment = {
  attachmentId: string;
  messageId: string;
  kind: 'voice' | 'image' | 'sticker';
  metadata: JsonRecord;
};

function chatAttachmentsForObject(
  objectId: string,
  references: readonly SyncCurrentObjectReference[],
) {
  const byAttachmentId = new Map<
    string,
    MaterializedChatAttachment
  >();
  for (const reference of references) {
    const mutation = reference.mutation;
    assertChatCoreMutationV1(mutation);
    if (mutation.entity.type !== 'attachment-metadata') continue;
    const payload = recordOf(
      mutation.payload,
      'chat attachment materialization payload',
    );
    if (payload.objectId !== objectId) continue;
    if (
      typeof payload.attachmentId !== 'string'
      || payload.attachmentId !== mutation.entity.id
      || typeof payload.messageId !== 'string'
      || (
        payload.kind !== 'voice'
        && payload.kind !== 'image'
        && payload.kind !== 'sticker'
      )
    ) {
      throw new Error('chat.objects 附件引用索引损坏。');
    }
    const attachment: MaterializedChatAttachment = {
      attachmentId: payload.attachmentId,
      messageId: payload.messageId,
      kind: payload.kind,
      metadata: recordOf(
        payload.metadata,
        'chat attachment materialization metadata',
      ),
    };
    const existing = byAttachmentId.get(attachment.attachmentId);
    if (
      existing
      && JSON.stringify(existing) !== JSON.stringify(attachment)
    ) {
      throw new Error(
        'chat.objects 同一附件存在未解决的 current-head 冲突。',
      );
    }
    byAttachmentId.set(attachment.attachmentId, attachment);
  }
  return [...byAttachmentId.values()];
}

function attachVerifiedChatObject(
  message: SubjectiveMessage,
  attachment: MaterializedChatAttachment,
  localUri: string,
) {
  if (attachment.kind === 'voice') {
    return {
      ...message,
      voice: {
        ...attachment.metadata,
        uri: localUri,
      } as MessageVoice,
    };
  }
  if (attachment.kind === 'sticker') {
    if (typeof attachment.metadata.id !== 'string') {
      throw new Error('chat.objects sticker metadata id 无效。');
    }
    return {
      ...message,
      sticker: {
        ...attachment.metadata,
        uri: localUri,
      } as MessageSticker,
    };
  }
  if (typeof attachment.metadata.id !== 'string') {
    throw new Error('chat.objects image metadata id 无效。');
  }
  const image = {
    ...attachment.metadata,
    uri: localUri,
  } as MessageImage;
  const images = [...(message.images ?? [])];
  const existingIndex = images.findIndex(
    (candidate) => candidate.id === image.id,
  );
  if (existingIndex >= 0) images[existingIndex] = image;
  else images.push(image);
  return {
    ...message,
    images,
  };
}

export async function materializeSyncChatObject(input: {
  objectId: string;
  localUri: string;
  references: readonly SyncCurrentObjectReference[];
}) {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(input.objectId)
    || !/^file:\/\//.test(input.localUri)
  ) {
    throw new Error('chat.objects materialize 输入无效。');
  }
  const attachments = chatAttachmentsForObject(
    input.objectId,
    input.references,
  );
  if (!attachments.length) {
    return {
      handled: false as const,
      pending: true as const,
      changed: false,
    };
  }
  return enqueueChatCoreApply(async () => {
    if (!await loadChatSessionSnapshot(PRIMARY_CHAT_SESSION_ID, { messageLimit: 1 })) {
      return { handled: false, pending: true, changed: false };
    }
    const stored = await loadChatState();
    const remaining = new Map(
      attachments.map((attachment) => [
        attachment.attachmentId,
        attachment,
      ]),
    );
    let changed = false;
    for (const session of stored.sessions) {
      await replaceChatSessionMessages(session.id, (messages) => {
        let sessionChanged = false;
        const nextMessages = messages.map((message) => {
          const applicable = [...remaining.values()].filter(
            (attachment) => attachment.messageId === message.id,
          );
          let next = message;
          for (const attachment of applicable) {
            next = attachVerifiedChatObject(next, attachment, input.localUri);
            remaining.delete(attachment.attachmentId);
            sessionChanged = true;
            changed = true;
          }
          return next;
        });
        return sessionChanged ? nextMessages : messages;
      }, { activeSessionId: stored.activeSessionId });
    }
    return {
      handled: remaining.size === 0,
      pending: remaining.size > 0,
      changed,
    };
  });
}

function sharedCompressionState(
  existing: ChatContextCompressionState | undefined,
  shared: JsonRecord,
): ChatContextCompressionState {
  return {
    ...emptyChatContextCompressionState,
    ...existing,
    summaryVersion: shared.summaryVersion as number,
    summary: shared.summary as string,
    summarizedThroughMessageId: shared.summarizedThroughMessageId as string | null,
    summarizedThroughAt: shared.summarizedThroughAt as number | null,
    lastCompressedAt: shared.lastCompressedAt as number | null,
    shortLogs: shared.shortLogs as ChatContextCompressionState['shortLogs'],
    correctionReview: shared.correctionReview as ChatContextCompressionState['correctionReview'] ?? undefined,
  };
}

async function applySessionFields(
  input: Parameters<ChatCoreBusinessPort['upsertSessionFields']>[0],
) {
  if (input.sessionId !== PRIMARY_CHAT_SESSION_ID) return;
  const fields = input.fields;
  await patchChatSessionFields(input.sessionId, {
    ...(typeof fields.title === 'string' ? { title: fields.title } : {}),
    ...(typeof fields.customTitle === 'boolean' ? { customTitle: fields.customTitle } : {}),
    ...(typeof fields.createdAt === 'number' ? { createdAt: fields.createdAt } : {}),
    ...(typeof fields.updatedAt === 'number' ? { updatedAt: fields.updatedAt } : {}),
  }, { syncOrigin: 'remote' });
}

async function applyMessage(
  input: Parameters<ChatCoreBusinessPort['upsertMessage']>[0],
) {
  if (input.sessionId !== PRIMARY_CHAT_SESSION_ID) return;
  if (!await loadChatSessionSnapshot(input.sessionId, { messageLimit: 1 })) {
    throw new Error('聊天消息的主聊天尚未存在，不能用子消息重新建立会话。');
  }
  const stored = await loadChatState();
  const session = stored.sessions.find((entry) => entry.id === input.sessionId);
  if (!session) throw new Error('聊天消息缺少已存在的主聊天，不能重新建立会话。');
  const currentMessages = await loadChatSessionMessages(input.sessionId);
  const existing = currentMessages.find((message) => message.id === input.message.id);
  const nextMessage = materializeSyncChatMessage(input.message, existing);
  if (existing && input.appendOnly) return;
  // Claim only genuinely new IDs before materialization. Failed sync retries retain the
  // same unread reference; an edit or duplicate replay must not make old text unread.
  if (!existing) await registerLateInnerUpdateMessages(input.sessionId, [nextMessage], captureBackupRestoreDataEpoch());

  await mergeAndSaveChatSessionMessages(input.sessionId, [nextMessage], {
    activeSessionId: stored.activeSessionId,
    syncOrigin: 'remote',
  });
  emitChatMessagesAppended({
    sessionId: input.sessionId,
    messages: [nextMessage],
    source: 'sync-chat-core',
  });
}

async function applySummary(
  input: Parameters<ChatCoreBusinessPort['upsertSummary']>[0],
) {
  if (input.sessionId !== PRIMARY_CHAT_SESSION_ID) return;
  if (!await loadChatSessionSnapshot(input.sessionId, { messageLimit: 1 })) {
    throw new Error('聊天摘要的主聊天尚未存在，不能重新建立会话。');
  }
  const stored = await loadChatState();
  const session = stored.sessions.find((entry) => entry.id === input.sessionId);
  if (!session) throw new Error('chat summary 的 session 尚未 materialize。');
  await mergeAndSaveChatSessionMessages(input.sessionId, [], {
    activeSessionId: stored.activeSessionId,
    contextCompression: sharedCompressionState(session.contextCompression, input.summary),
    summaryWriteMode: 'sync',
    syncOrigin: 'remote',
    memoryOrganizedThroughId: input.memoryOrganizedThroughId,
    proactiveMemoryReviewedThroughId: input.proactiveMemoryReviewedThroughId,
  });
}

async function applyTombstone(
  input: Parameters<ChatCoreBusinessPort['tombstone']>[0],
) {
  if (input.entityType === 'session') {
    if (input.entityId !== PRIMARY_CHAT_SESSION_ID) return;
    throw new Error('主聊天不接受整段删除，已停止应用并保留原记录。');
  }
  if (input.entityType === 'message-summary' && input.entityId !== PRIMARY_CHAT_SESSION_ID) return;
  if (!await loadChatSessionSnapshot(PRIMARY_CHAT_SESSION_ID, { messageLimit: 1 })) return;
  const stored = await loadChatState();
  if (input.entityType === 'subjective-message') {
    for (const session of stored.sessions) {
      await replaceChatSessionMessages(
        session.id,
        (messages) => messages.some((message) => message.id === input.entityId)
          ? messages.filter((message) => message.id !== input.entityId) : messages,
        { activeSessionId: stored.activeSessionId, syncOrigin: 'remote', deletedMessageIds: [input.entityId] },
      );
      return;
    }
    return;
  }
  if (input.entityType === 'message-summary') {
    const session = stored.sessions.find((entry) => entry.id === input.entityId);
    if (!session) return;
    await mergeAndSaveChatSessionMessages(session.id, [], {
      activeSessionId: stored.activeSessionId,
      contextCompression: emptyChatContextCompressionState,
      summaryWriteMode: 'reset',
      syncOrigin: 'remote',
      memoryOrganizedThroughId: null,
      proactiveMemoryReviewedThroughId: null,
    });
  }
}

export const chatCoreAsyncStorageBusinessPort: ChatCoreBusinessPort = {
  upsertSessionFields: (input) => enqueueChatCoreApply(() => applySessionFields(input)),
  upsertMessage: (input) => enqueueChatCoreApply(() => applyMessage(input)),
  upsertSummary: (input) => enqueueChatCoreApply(() => applySummary(input)),
  upsertAttachmentMetadata: async () => {
    // The immutable sync_entity_revisions row remains authoritative until chat.objects
    // materializes a verified local URI; no device path is fabricated here.
  },
  tombstone: (input) => enqueueChatCoreApply(() => applyTombstone(input)),
};
