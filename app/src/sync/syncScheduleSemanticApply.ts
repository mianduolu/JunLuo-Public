import {
  assertScheduleSemanticMutationV1,
  scheduleSemanticPayload,
  SCHEDULE_SEMANTIC_ADAPTER_ID,
  type ScheduleSemanticEntityType,
  type ScheduleSemanticRecordKind,
} from './syncScheduleSemantic';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type ScheduleSemanticRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface ScheduleSemanticBusinessPort {
  upsertRecord(input: {
    entityType: ScheduleSemanticEntityType;
    entityId: string;
    kind: ScheduleSemanticRecordKind;
    record: JsonValue & Record<string, JsonValue>;
    operation: 'upsert' | 'restore' | 'append';
    revision: ScheduleSemanticRevisionContext;
  }): Promise<void>;
  deleteRecord(input: {
    entityType: ScheduleSemanticEntityType;
    entityId: string;
    kind: ScheduleSemanticRecordKind;
    deletedAt: number;
    revision: ScheduleSemanticRevisionContext;
  }): Promise<void>;
}

export class ScheduleSemanticBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: ScheduleSemanticBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertScheduleSemanticMutationV1(mutation);
    const payload = scheduleSemanticPayload(mutation);
    const revision: ScheduleSemanticRevisionContext = {
      revisionId: mutation.revision.id,
      parentRevisionIds: [...mutation.revision.parents],
      sourceDeviceId: mutation.sourceDeviceId,
      sourceSequence: mutation.sourceSequence,
      createdAt: mutation.createdAt,
    };
    if ('deletedAt' in payload) {
      await this.port.deleteRecord({
        entityType: mutation.entity.type as ScheduleSemanticEntityType,
        entityId: mutation.entity.id,
        kind: payload.kind,
        deletedAt: payload.deletedAt,
        revision,
      });
      return;
    }
    await this.port.upsertRecord({
      entityType: mutation.entity.type as ScheduleSemanticEntityType,
      entityId: mutation.entity.id,
      kind: payload.kind,
      record: payload.record,
      operation: mutation.revision.operation as 'upsert' | 'restore' | 'append',
      revision,
    });
  }
}

export const SCHEDULE_SEMANTIC_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: SCHEDULE_SEMANTIC_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertScheduleSemanticMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
