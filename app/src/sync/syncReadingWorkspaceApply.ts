import {
  READING_WORKSPACE_ADAPTER_ID,
  assertReadingWorkspaceMutationV1,
  type ReadingWorkspaceEntityType,
  type ReadingWorkspaceRecordKind,
} from './syncReadingWorkspace';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type {
  JsonValue,
  PlainMutationV1,
} from './syncProtocol';

export type ReadingWorkspaceRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface ReadingWorkspaceBusinessPort {
  upsertRecord(input: {
    entityType: ReadingWorkspaceEntityType;
    entityId: string;
    kind: ReadingWorkspaceRecordKind;
    value: JsonValue;
    revision: ReadingWorkspaceRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    entityType: ReadingWorkspaceEntityType;
    entityId: string;
    deletedAt: number;
    revision: ReadingWorkspaceRevisionContext;
  }): Promise<void>;
}

function payloadRecord(mutation: PlainMutationV1) {
  if (
    !mutation.payload
    || typeof mutation.payload !== 'object'
    || Array.isArray(mutation.payload)
  ) {
    throw new Error('reading.workspace payload 必须是对象。');
  }
  return mutation.payload;
}

function revisionContext(
  mutation: PlainMutationV1,
): ReadingWorkspaceRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

export class ReadingWorkspaceBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: ReadingWorkspaceBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertReadingWorkspaceMutationV1(mutation);
    const payload = payloadRecord(mutation);
    const entityType =
      mutation.entity.type as ReadingWorkspaceEntityType;
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
      kind: payload.kind as ReadingWorkspaceRecordKind,
      value: payload.value as JsonValue,
      revision,
    });
  }
}

export const READING_WORKSPACE_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: READING_WORKSPACE_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertReadingWorkspaceMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
