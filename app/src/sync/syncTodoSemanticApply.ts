import {
  assertTodoSemanticMutationV1,
  todoSemanticPayload,
  TODO_SEMANTIC_ADAPTER_ID,
  type TodoSemanticEntityType,
  type TodoSemanticRecordKind,
} from './syncTodoSemantic';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type TodoSemanticRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface TodoSemanticBusinessPort {
  upsertRecord(input: {
    entityType: TodoSemanticEntityType;
    entityId: string;
    kind: TodoSemanticRecordKind;
    record: JsonValue & Record<string, JsonValue>;
    operation: 'upsert' | 'restore';
    revision: TodoSemanticRevisionContext;
  }): Promise<void>;
  deleteRecord(input: {
    entityType: TodoSemanticEntityType;
    entityId: string;
    kind: TodoSemanticRecordKind;
    deletedAt: number;
    revision: TodoSemanticRevisionContext;
  }): Promise<void>;
}

export class TodoSemanticBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: TodoSemanticBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertTodoSemanticMutationV1(mutation);
    const payload = todoSemanticPayload(mutation);
    const revision: TodoSemanticRevisionContext = {
      revisionId: mutation.revision.id,
      parentRevisionIds: [...mutation.revision.parents],
      sourceDeviceId: mutation.sourceDeviceId,
      sourceSequence: mutation.sourceSequence,
      createdAt: mutation.createdAt,
    };
    if ('deletedAt' in payload) {
      await this.port.deleteRecord({
        entityType: mutation.entity.type as TodoSemanticEntityType,
        entityId: mutation.entity.id,
        kind: payload.kind,
        deletedAt: payload.deletedAt,
        revision,
      });
      return;
    }
    await this.port.upsertRecord({
      entityType: mutation.entity.type as TodoSemanticEntityType,
      entityId: mutation.entity.id,
      kind: payload.kind,
      record: payload.record,
      operation: mutation.revision.operation as 'upsert' | 'restore',
      revision,
    });
  }
}

export const TODO_SEMANTIC_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: TODO_SEMANTIC_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertTodoSemanticMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
