import {
  assertFocusSemanticMutationV1,
  focusSemanticPayload,
  FOCUS_SEMANTIC_ADAPTER_ID,
  type FocusSemanticEntityType,
  type FocusSemanticRecordKind,
} from './syncFocusSemantic';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type FocusSemanticRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface FocusSemanticBusinessPort {
  upsertRecord(input: {
    entityType: FocusSemanticEntityType;
    entityId: string;
    kind: FocusSemanticRecordKind;
    record: JsonValue & Record<string, JsonValue>;
    operation: 'upsert' | 'restore';
    revision: FocusSemanticRevisionContext;
  }): Promise<void>;
  deleteRecord(input: {
    entityType: FocusSemanticEntityType;
    entityId: string;
    kind: FocusSemanticRecordKind;
    deletedAt: number;
    revision: FocusSemanticRevisionContext;
  }): Promise<void>;
}

export class FocusSemanticBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: FocusSemanticBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertFocusSemanticMutationV1(mutation);
    const payload = focusSemanticPayload(mutation);
    const revision: FocusSemanticRevisionContext = {
      revisionId: mutation.revision.id,
      parentRevisionIds: [...mutation.revision.parents],
      sourceDeviceId: mutation.sourceDeviceId,
      sourceSequence: mutation.sourceSequence,
      createdAt: mutation.createdAt,
    };
    if ('deletedAt' in payload) {
      await this.port.deleteRecord({
        entityType: mutation.entity.type as FocusSemanticEntityType,
        entityId: mutation.entity.id,
        kind: payload.kind,
        deletedAt: payload.deletedAt,
        revision,
      });
      return;
    }
    await this.port.upsertRecord({
      entityType: mutation.entity.type as FocusSemanticEntityType,
      entityId: mutation.entity.id,
      kind: payload.kind,
      record: payload.record,
      operation: mutation.revision.operation as 'upsert' | 'restore',
      revision,
    });
  }
}

export const FOCUS_SEMANTIC_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: FOCUS_SEMANTIC_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertFocusSemanticMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
