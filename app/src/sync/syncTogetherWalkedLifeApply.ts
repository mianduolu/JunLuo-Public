import {
  assertTogetherWalkedLifeMutationV1,
  type TogetherWalkedLifeEntityType,
  type TogetherWalkedLifeRecord,
  type TogetherWalkedLifeRecordKind,
} from './syncTogetherWalkedLife';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type {
  PlainMutationV1,
} from './syncProtocol';

export type TogetherWalkedLifeRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface TogetherWalkedLifeBusinessPort {
  upsertRecord(input: {
    entityType: TogetherWalkedLifeEntityType;
    entityId: string;
    kind: TogetherWalkedLifeRecordKind;
    value: TogetherWalkedLifeRecord;
    revision: TogetherWalkedLifeRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    entityType: TogetherWalkedLifeEntityType;
    entityId: string;
    deletedAt: number;
    revision: TogetherWalkedLifeRevisionContext;
  }): Promise<void>;
}

function payloadRecord(mutation: PlainMutationV1) {
  if (
    !mutation.payload
    || typeof mutation.payload !== 'object'
    || Array.isArray(mutation.payload)
  ) {
    throw new Error('together-walked.life payload 必须是对象。');
  }
  return mutation.payload;
}

function revisionContext(
  mutation: PlainMutationV1,
): TogetherWalkedLifeRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

export class TogetherWalkedLifeBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(
    private readonly port: TogetherWalkedLifeBusinessPort,
  ) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertTogetherWalkedLifeMutationV1(mutation);
    const payload = payloadRecord(mutation);
    const entityType =
      mutation.entity.type as TogetherWalkedLifeEntityType;
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
      kind: payload.kind as TogetherWalkedLifeRecordKind,
      value: payload.value as TogetherWalkedLifeRecord,
      revision,
    });
  }
}

export const TOGETHER_WALKED_LIFE_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: 'together-walked.life',
  isMutationAllowed(mutation) {
    try {
      assertTogetherWalkedLifeMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
