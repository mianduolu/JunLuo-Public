import {
  assertPeriodHealthMutationV1,
  periodHealthPayload,
  PERIOD_HEALTH_ADAPTER_ID,
  type PeriodHealthEntityType,
  type PeriodHealthRecord,
  type PeriodHealthRecordKind,
} from './syncPeriodHealth';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type PeriodHealthRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface PeriodHealthBusinessPort {
  upsertRecord(input: {
    entityType: PeriodHealthEntityType;
    entityId: string;
    kind: PeriodHealthRecordKind;
    record: PeriodHealthRecord;
    operation: 'upsert' | 'restore';
    revision: PeriodHealthRevisionContext;
  }): Promise<void>;
  deleteRecord(input: {
    entityType: PeriodHealthEntityType;
    entityId: string;
    kind: PeriodHealthRecordKind;
    deletedAt: number;
    revision: PeriodHealthRevisionContext;
  }): Promise<void>;
}

export class PeriodHealthBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: PeriodHealthBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertPeriodHealthMutationV1(mutation);
    const payload = periodHealthPayload(mutation);
    // A retired notification from an old peer is acknowledged but never
    // materialized into a local reminder or a new model request.
    if (payload.kind === 'period-reminder' || payload.kind === 'period-companion-delivery') return;
    const revision: PeriodHealthRevisionContext = {
      revisionId: mutation.revision.id,
      parentRevisionIds: [...mutation.revision.parents],
      sourceDeviceId: mutation.sourceDeviceId,
      sourceSequence: mutation.sourceSequence,
      createdAt: mutation.createdAt,
    };
    if ('deletedAt' in payload) {
      await this.port.deleteRecord({
        entityType: mutation.entity.type as PeriodHealthEntityType,
        entityId: mutation.entity.id,
        kind: payload.kind,
        deletedAt: payload.deletedAt,
        revision,
      });
      return;
    }
    await this.port.upsertRecord({
      entityType: mutation.entity.type as PeriodHealthEntityType,
      entityId: mutation.entity.id,
      kind: payload.kind,
      record: payload.record,
      operation: mutation.revision.operation as 'upsert' | 'restore',
      revision,
    });
  }
}

export const PERIOD_HEALTH_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: PERIOD_HEALTH_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertPeriodHealthMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
