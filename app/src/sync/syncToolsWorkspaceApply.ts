import {
  assertToolsWorkspaceMutationV1,
  TOOLS_WORKSPACE_ADAPTER_ID,
  toolsWorkspaceMutationValue,
  type ToolsWorkspaceRecordKind,
  type ToolsWorkspaceRecordValue,
} from './syncToolsWorkspace';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type ToolsWorkspaceRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface ToolsWorkspaceBusinessPort {
  upsert(input: {
    kind: ToolsWorkspaceRecordKind;
    value: ToolsWorkspaceRecordValue;
    revision: ToolsWorkspaceRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    kind: ToolsWorkspaceRecordKind;
    entityId: string;
    deletedAt: number;
    revision: ToolsWorkspaceRevisionContext;
  }): Promise<void>;
}

function revisionContext(
  mutation: PlainMutationV1,
): ToolsWorkspaceRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

export class ToolsWorkspaceBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: ToolsWorkspaceBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertToolsWorkspaceMutationV1(mutation);
    const decoded = toolsWorkspaceMutationValue(mutation);
    const revision = revisionContext(mutation);
    if (mutation.revision.operation === 'delete') {
      await this.port.tombstone({
        kind: decoded.kind,
        entityId: mutation.entity.id,
        deletedAt: decoded.deletedAt!,
        revision,
      });
      return;
    }
    await this.port.upsert({
      kind: decoded.kind,
      value: decoded.value!,
      revision,
    });
  }
}

export const TOOLS_WORKSPACE_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: TOOLS_WORKSPACE_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertToolsWorkspaceMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
