import {
  assertReadingObjectsMutationV1,
  type ReadingObjectEntityType,
  type ReadingObjectRecord,
} from './syncReadingObjects';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type {
  PlainMutationV1,
} from './syncProtocol';

export type ReadingObjectsRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface ReadingObjectsBusinessPort {
  upsertRecord(input: {
    entityType: ReadingObjectEntityType;
    entityId: string;
    value: ReadingObjectRecord;
    revision: ReadingObjectsRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    entityType: ReadingObjectEntityType;
    entityId: string;
    deletedAt: number;
    revision: ReadingObjectsRevisionContext;
  }): Promise<void>;
}

function payloadRecord(mutation: PlainMutationV1) {
  if (
    !mutation.payload
    || typeof mutation.payload !== 'object'
    || Array.isArray(mutation.payload)
  ) {
    throw new Error('reading.objects payload 必须是对象。');
  }
  return mutation.payload;
}

function revisionContext(
  mutation: PlainMutationV1,
): ReadingObjectsRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

export class ReadingObjectsBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: ReadingObjectsBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertReadingObjectsMutationV1(mutation);
    const payload = payloadRecord(mutation);
    const entityType = mutation.entity.type as ReadingObjectEntityType;
    const revision = revisionContext(mutation);
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
      value: payload.value as ReadingObjectRecord,
      revision,
    });
  }
}

export const READING_OBJECTS_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: 'reading.objects',
  isMutationAllowed(mutation) {
    try {
      assertReadingObjectsMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
