import {
  assertAssistantLifeStateMutationV1,
  isLegacyWantsStateRecord,
  type AssistantLifeStateEntityType,
  type AssistantLifeStateRecordKind,
} from './syncAssistantLifeState';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type {
  JsonValue,
  PlainMutationV1,
} from './syncProtocol';

export type AssistantLifeStateRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface AssistantLifeStateBusinessPort {
  upsertRecord(input: {
    entityType: AssistantLifeStateEntityType;
    entityId: string;
    kind: AssistantLifeStateRecordKind;
    value: JsonValue;
    revision: AssistantLifeStateRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    entityType: AssistantLifeStateEntityType;
    entityId: string;
    deletedAt: number;
    revision: AssistantLifeStateRevisionContext;
  }): Promise<void>;
}

function revisionContext(
  mutation: PlainMutationV1,
): AssistantLifeStateRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

function payloadRecord(mutation: PlainMutationV1) {
  if (
    !mutation.payload
    || typeof mutation.payload !== 'object'
    || Array.isArray(mutation.payload)
  ) {
    throw new Error('assistant.life-state payload 必须是对象。');
  }
  return mutation.payload;
}

export class AssistantLifeStateBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: AssistantLifeStateBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertAssistantLifeStateMutationV1(mutation);
    const payload = payloadRecord(mutation);
    const revision = revisionContext(mutation);
    const entityType = mutation.entity.type as AssistantLifeStateEntityType;
    if (mutation.revision.operation === 'delete') {
      await this.port.tombstone({
        entityType,
        entityId: mutation.entity.id,
        deletedAt: payload.deletedAt as number,
        revision,
      });
      return;
    }
    if (isLegacyWantsStateRecord(payload.kind as AssistantLifeStateRecordKind, payload.value)) return;
    await this.port.upsertRecord({
      entityType,
      entityId: mutation.entity.id,
      kind: payload.kind as AssistantLifeStateRecordKind,
      value: payload.value as JsonValue,
      revision,
    });
  }
}

export const ASSISTANT_LIFE_STATE_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: 'assistant.life-state',
  isMutationAllowed(mutation) {
    try {
      assertAssistantLifeStateMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
