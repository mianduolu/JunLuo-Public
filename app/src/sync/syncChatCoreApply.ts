import { stripRetiredActionMetadata } from '../ai/retiredAssistantFeatureData';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import {
  assertChatCoreMutationV1,
  type ChatCoreEntityType,
} from './syncChatCore';
import type {
  JsonValue,
  PlainMutationV1,
} from './syncProtocol';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';

export type ChatCoreRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface ChatCoreBusinessPort {
  upsertSessionFields(input: {
    sessionId: string;
    fields: { [key: string]: JsonValue };
    revision: ChatCoreRevisionContext;
  }): Promise<void>;
  upsertMessage(input: {
    sessionId: string;
    message: { [key: string]: JsonValue };
    appendOnly: boolean;
    revision: ChatCoreRevisionContext;
  }): Promise<void>;
  upsertSummary(input: {
    sessionId: string;
    memoryOrganizedThroughId: string | null;
    proactiveMemoryReviewedThroughId: string | null;
    summary: { [key: string]: JsonValue };
    revision: ChatCoreRevisionContext;
  }): Promise<void>;
  upsertAttachmentMetadata(input: {
    attachmentId: string;
    messageId: string;
    kind: 'voice' | 'image' | 'sticker';
    metadata: { [key: string]: JsonValue };
    objectId: string | null;
    revision: ChatCoreRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    entityType: ChatCoreEntityType;
    entityId: string;
    deletedAt: number;
    revision: ChatCoreRevisionContext;
  }): Promise<void>;
}

function recordOf(value: JsonValue, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as { [key: string]: JsonValue };
}

function nullableString(value: JsonValue, label: string) {
  if (value !== null && typeof value !== 'string') {
    throw new Error(`${label} 必须是 string 或 null。`);
  }
  return value as string | null;
}

function revisionContext(mutation: PlainMutationV1): ChatCoreRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

export function isChatCoreMutationV1(value: PlainMutationV1) {
  try {
    assertChatCoreMutationV1(value);
    return true;
  } catch {
    return false;
  }
}

/** The protocol still validates old revisions; only the primary world may be materialized. */
export function isPrimaryChatCoreMutation(mutation: PlainMutationV1) {
  if (mutation.revision.operation === 'delete') return true;
  if (mutation.entity.type === 'session') return mutation.entity.id === PRIMARY_CHAT_SESSION_ID;
  if (mutation.entity.type === 'subjective-message' || mutation.entity.type === 'message-summary') {
    return recordOf(mutation.payload, 'chat.core payload').sessionId === PRIMARY_CHAT_SESSION_ID;
  }
  // Attachment metadata has no session field. Its URI is attached only to a live message.
  return true;
}

export const CHAT_CORE_BATCH_CAPTURE_POLICY: SyncMutationBatchCapturePolicy = {
  adapterId: 'chat.core',
  isMutationAllowed: isChatCoreMutationV1,
};

export class ChatCoreBusinessApplier implements SyncMutationBusinessApplier {
  constructor(private readonly port: ChatCoreBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertChatCoreMutationV1(mutation);
    if (!isPrimaryChatCoreMutation(mutation)) return;
    const payload = recordOf(mutation.payload, 'chat.core payload');
    const revision = revisionContext(mutation);
    if (mutation.revision.operation === 'delete') {
      await this.port.tombstone({
        entityType: mutation.entity.type as ChatCoreEntityType,
        entityId: mutation.entity.id,
        deletedAt: payload.deletedAt as number,
        revision,
      });
      return;
    }

    switch (mutation.entity.type as ChatCoreEntityType) {
      case 'session':
        await this.port.upsertSessionFields({
          sessionId: mutation.entity.id,
          fields: recordOf(payload.fields, 'chat session fields'),
          revision,
        });
        return;
      case 'subjective-message':
        await this.port.upsertMessage({
          sessionId: payload.sessionId as string,
          message: stripRetiredActionMetadata(recordOf(payload.message, 'chat message')),
          appendOnly: mutation.revision.operation === 'append',
          revision,
        });
        return;
      case 'message-summary':
        await this.port.upsertSummary({
          sessionId: payload.sessionId as string,
          memoryOrganizedThroughId: nullableString(
            payload.memoryOrganizedThroughId,
            'memoryOrganizedThroughId',
          ),
          proactiveMemoryReviewedThroughId: nullableString(
            payload.proactiveMemoryReviewedThroughId,
            'proactiveMemoryReviewedThroughId',
          ),
          summary: recordOf(payload.summary, 'chat summary'),
          revision,
        });
        return;
      case 'attachment-metadata':
        await this.port.upsertAttachmentMetadata({
          attachmentId: payload.attachmentId as string,
          messageId: payload.messageId as string,
          kind: payload.kind as 'voice' | 'image' | 'sticker',
          metadata: recordOf(payload.metadata, 'chat attachment metadata'),
          objectId: nullableString(payload.objectId, 'chat attachment objectId'),
          revision,
        });
    }
  }
}
