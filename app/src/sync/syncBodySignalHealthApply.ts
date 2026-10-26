import {
  assertBodySignalHealthMutationV1,
  bodySignalHealthPayload,
  BODY_SIGNAL_HEALTH_ADAPTER_ID,
  type BodySignalHealthEntityType,
  type BodySignalHealthRecord,
  type BodySignalHealthRecordKind,
} from './syncBodySignalHealth';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type BodySignalHealthRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface BodySignalHealthBusinessPort {
  upsertRecord(input: {
    entityType: BodySignalHealthEntityType;
    entityId: string;
    kind: BodySignalHealthRecordKind;
    record: BodySignalHealthRecord;
    operation: 'upsert' | 'restore';
    revision: BodySignalHealthRevisionContext;
  }): Promise<void>;
  deleteRecord(input: {
    entityType: BodySignalHealthEntityType;
    entityId: string;
    kind: BodySignalHealthRecordKind;
    deletedAt: number;
    revision: BodySignalHealthRevisionContext;
  }): Promise<void>;
}

export class BodySignalHealthBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: BodySignalHealthBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertBodySignalHealthMutationV1(mutation);
    const payload = bodySignalHealthPayload(mutation);
    const revision: BodySignalHealthRevisionContext = {
      revisionId: mutation.revision.id,
      parentRevisionIds: [...mutation.revision.parents],
      sourceDeviceId: mutation.sourceDeviceId,
      sourceSequence: mutation.sourceSequence,
      createdAt: mutation.createdAt,
    };
    if ('deletedAt' in payload) {
      await this.port.deleteRecord({
        entityType:
          mutation.entity.type as BodySignalHealthEntityType,
        entityId: mutation.entity.id,
        kind: payload.kind,
        deletedAt: payload.deletedAt,
        revision,
      });
      return;
    }
    await this.port.upsertRecord({
      entityType:
        mutation.entity.type as BodySignalHealthEntityType,
      entityId: mutation.entity.id,
      kind: payload.kind,
      record: payload.record,
      operation:
        mutation.revision.operation as 'upsert' | 'restore',
      revision,
    });
  }
}

export const BODY_SIGNAL_HEALTH_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: BODY_SIGNAL_HEALTH_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertBodySignalHealthMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
