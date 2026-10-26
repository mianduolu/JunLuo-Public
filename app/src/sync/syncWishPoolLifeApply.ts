import {
  WISH_POOL_LIFE_ADAPTER_ID,
  assertWishPoolLifeMutationV1,
  type WishPoolLifeEntityType,
  type WishPoolLifeRecordKind,
} from './syncWishPoolLife';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type {
  JsonValue,
  PlainMutationV1,
} from './syncProtocol';

export type WishPoolLifeRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface WishPoolLifeBusinessPort {
  upsertRecord(input: {
    entityType: WishPoolLifeEntityType;
    entityId: string;
    kind: WishPoolLifeRecordKind;
    value: JsonValue;
    revision: WishPoolLifeRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    entityType: WishPoolLifeEntityType;
    entityId: string;
    deletedAt: number;
    revision: WishPoolLifeRevisionContext;
  }): Promise<void>;
}

function revisionContext(
  mutation: PlainMutationV1,
): WishPoolLifeRevisionContext {
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
    throw new Error('wish-pool.life payload 必须是对象。');
  }
  return mutation.payload;
}

export class WishPoolLifeBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: WishPoolLifeBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertWishPoolLifeMutationV1(mutation);
    const payload = payloadRecord(mutation);
    const revision = revisionContext(mutation);
    const entityType = mutation.entity.type as WishPoolLifeEntityType;
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
      kind: payload.kind as WishPoolLifeRecordKind,
      value: payload.value as JsonValue,
      revision,
    });
  }
}

export const WISH_POOL_LIFE_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: WISH_POOL_LIFE_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertWishPoolLifeMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
