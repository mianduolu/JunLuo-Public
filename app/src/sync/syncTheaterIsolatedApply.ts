import {
  assertTheaterIsolatedMutationV1,
  theaterIsolatedPayload,
  THEATER_ISOLATED_ADAPTER_ID,
  type TheaterIsolatedRecordKind,
} from './syncTheaterIsolated';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type TheaterIsolatedRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface TheaterIsolatedBusinessPort {
  upsertRecord(input: {
    entityId: string;
    kind: TheaterIsolatedRecordKind;
    record: JsonValue & Record<string, JsonValue>;
    operation: 'upsert' | 'restore';
    revision: TheaterIsolatedRevisionContext;
  }): Promise<void>;
  deleteRecord(input: {
    entityId: string;
    kind: TheaterIsolatedRecordKind;
    deletedAt: number;
    revision: TheaterIsolatedRevisionContext;
  }): Promise<void>;
}

export class TheaterIsolatedBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: TheaterIsolatedBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertTheaterIsolatedMutationV1(mutation);
    const payload = theaterIsolatedPayload(mutation);
    const revision: TheaterIsolatedRevisionContext = {
      revisionId: mutation.revision.id,
      parentRevisionIds: [...mutation.revision.parents],
      sourceDeviceId: mutation.sourceDeviceId,
      sourceSequence: mutation.sourceSequence,
      createdAt: mutation.createdAt,
    };
    if ('deletedAt' in payload) {
      await this.port.deleteRecord({
        entityId: mutation.entity.id,
        kind: payload.kind,
        deletedAt: payload.deletedAt,
        revision,
      });
      return;
    }
    await this.port.upsertRecord({
      entityId: mutation.entity.id,
      kind: payload.kind,
      record: payload.record as JsonValue & Record<string, JsonValue>,
      operation: mutation.revision.operation as 'upsert' | 'restore',
      revision,
    });
  }
}

export const THEATER_ISOLATED_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: THEATER_ISOLATED_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertTheaterIsolatedMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
