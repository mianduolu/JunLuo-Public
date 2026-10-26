import {
  LETTERS_LIFE_ADAPTER_ID,
  assertLettersLifeMutationV1,
  type LettersLifeEntityType,
  type LettersLifeRecordKind,
} from './syncLettersLife';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type {
  JsonValue,
  PlainMutationV1,
} from './syncProtocol';

export type LettersLifeRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface LettersLifeBusinessPort {
  upsertRecord(input: {
    entityType: LettersLifeEntityType;
    entityId: string;
    kind: LettersLifeRecordKind;
    value: JsonValue;
    revision: LettersLifeRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    entityType: LettersLifeEntityType;
    entityId: string;
    deletedAt: number;
    revision: LettersLifeRevisionContext;
  }): Promise<void>;
}

function revisionContext(
  mutation: PlainMutationV1,
): LettersLifeRevisionContext {
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
    throw new Error('letters.life payload 必须是对象。');
  }
  return mutation.payload;
}

export class LettersLifeBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: LettersLifeBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertLettersLifeMutationV1(mutation);
    const payload = payloadRecord(mutation);
    const revision = revisionContext(mutation);
    const entityType = mutation.entity.type as LettersLifeEntityType;
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
      kind: payload.kind as LettersLifeRecordKind,
      value: payload.value as JsonValue,
      revision,
    });
  }
}

export const LETTERS_LIFE_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: LETTERS_LIFE_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertLettersLifeMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
