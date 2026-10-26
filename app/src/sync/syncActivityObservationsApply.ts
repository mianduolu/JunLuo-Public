import {
  assertActivityObservationsMutationV1,
  activityObservationsPayload,
  ACTIVITY_OBSERVATIONS_ADAPTER_ID,
  type ActivityObservationsEntityType,
  type ActivityObservationsRecord,
  type ActivityObservationsRecordKind,
} from './syncActivityObservations';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type ActivityObservationsRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface ActivityObservationsBusinessPort {
  upsertRecord(input: {
    entityType: ActivityObservationsEntityType;
    entityId: string;
    kind: ActivityObservationsRecordKind;
    record: ActivityObservationsRecord;
    operation: 'upsert' | 'restore';
    revision: ActivityObservationsRevisionContext;
  }): Promise<void>;
  deleteRecord(input: {
    entityType: ActivityObservationsEntityType;
    entityId: string;
    kind: ActivityObservationsRecordKind;
    deletedAt: number;
    revision: ActivityObservationsRevisionContext;
  }): Promise<void>;
}

export class ActivityObservationsBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: ActivityObservationsBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertActivityObservationsMutationV1(mutation);
    const payload = activityObservationsPayload(mutation);
    const revision: ActivityObservationsRevisionContext = {
      revisionId: mutation.revision.id,
      parentRevisionIds: [...mutation.revision.parents],
      sourceDeviceId: mutation.sourceDeviceId,
      sourceSequence: mutation.sourceSequence,
      createdAt: mutation.createdAt,
    };
    if ('deletedAt' in payload) {
      await this.port.deleteRecord({
        entityType:
          mutation.entity.type as ActivityObservationsEntityType,
        entityId: mutation.entity.id,
        kind: payload.kind,
        deletedAt: payload.deletedAt,
        revision,
      });
      return;
    }
    await this.port.upsertRecord({
      entityType:
        mutation.entity.type as ActivityObservationsEntityType,
      entityId: mutation.entity.id,
      kind: payload.kind,
      record: payload.record,
      operation:
        mutation.revision.operation as 'upsert' | 'restore',
      revision,
    });
  }
}

export const ACTIVITY_OBSERVATIONS_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: ACTIVITY_OBSERVATIONS_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertActivityObservationsMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
