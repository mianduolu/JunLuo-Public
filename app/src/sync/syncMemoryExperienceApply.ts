import {
  assertMemoryExperienceMutationV1,
  type MemoryExperienceEntityType,
  type MemoryExperienceRecordKind,
} from './syncMemoryExperience';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type {
  JsonValue,
  PlainMutationV1,
} from './syncProtocol';

export type MemoryExperienceRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface MemoryExperienceBusinessPort {
  upsertRecord(input: {
    entityType: MemoryExperienceEntityType;
    entityId: string;
    kind: MemoryExperienceRecordKind;
    value: JsonValue;
    revision: MemoryExperienceRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    entityType: MemoryExperienceEntityType;
    entityId: string;
    deletedAt: number;
    revision: MemoryExperienceRevisionContext;
  }): Promise<void>;
}

function revisionContext(
  mutation: PlainMutationV1,
): MemoryExperienceRevisionContext {
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
    throw new Error('memory.experience payload 必须是对象。');
  }
  return mutation.payload;
}

export class MemoryExperienceBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: MemoryExperienceBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertMemoryExperienceMutationV1(mutation);
    const payload = payloadRecord(mutation);
    const revision = revisionContext(mutation);
    const entityType = mutation.entity.type as MemoryExperienceEntityType;
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
      kind: payload.kind as MemoryExperienceRecordKind,
      value: payload.value as JsonValue,
      revision,
    });
  }
}

export const MEMORY_EXPERIENCE_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: 'memory.experience',
  isMutationAllowed(mutation) {
    try {
      assertMemoryExperienceMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
