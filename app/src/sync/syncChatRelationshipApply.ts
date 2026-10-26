import {
  assertChatRelationshipMutationV1,
  type ChatRelationshipEntityType,
  type ChatRelationshipRecordKind,
} from './syncChatRelationship';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type {
  JsonValue,
  PlainMutationV1,
} from './syncProtocol';

export type ChatRelationshipRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface ChatRelationshipBusinessPort {
  upsertRecord(input: {
    entityType: ChatRelationshipEntityType;
    entityId: string;
    kind: ChatRelationshipRecordKind;
    value: JsonValue;
    revision: ChatRelationshipRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    entityType: ChatRelationshipEntityType;
    entityId: string;
    deletedAt: number;
    revision: ChatRelationshipRevisionContext;
  }): Promise<void>;
}

function revisionContext(mutation: PlainMutationV1): ChatRelationshipRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

function payloadRecord(mutation: PlainMutationV1) {
  if (!mutation.payload || typeof mutation.payload !== 'object' || Array.isArray(mutation.payload)) {
    throw new Error('chat.relationship-state payload 必须是对象。');
  }
  return mutation.payload;
}

export class ChatRelationshipBusinessApplier implements SyncMutationBusinessApplier {
  constructor(private readonly port: ChatRelationshipBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertChatRelationshipMutationV1(mutation);
    const payload = payloadRecord(mutation);
    const revision = revisionContext(mutation);
    const entityType = mutation.entity.type as ChatRelationshipEntityType;
    if (mutation.revision.operation === 'delete') {
      await this.port.tombstone({
        entityType,
        entityId: mutation.entity.id,
        deletedAt: payload.deletedAt as number,
        revision,
      });
      return;
    }
    await this.port.upsertRecord({
      entityType,
      entityId: mutation.entity.id,
      kind: payload.kind as ChatRelationshipRecordKind,
      value: payload.value,
      revision,
    });
  }
}

export const CHAT_RELATIONSHIP_BATCH_CAPTURE_POLICY: SyncMutationBatchCapturePolicy = {
  adapterId: 'chat.relationship-state',
  isMutationAllowed(mutation) {
    try {
      assertChatRelationshipMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
