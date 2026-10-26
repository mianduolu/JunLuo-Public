import {
  assertToolsAuditMutationV1,
  TOOLS_AUDIT_ADAPTER_ID,
  toolsAuditMutationValue,
  type ToolsAuditRecordKind,
  type ToolsAuditRecordValue,
} from './syncToolsAudit';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type ToolsAuditRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface ToolsAuditBusinessPort {
  upsertAuditRecord(input: {
    kind: ToolsAuditRecordKind;
    value: ToolsAuditRecordValue;
    revision: ToolsAuditRevisionContext;
  }): Promise<void>;
  deleteAuditEvent(input: {
    callId: string;
    deletedAt: number;
    revision: ToolsAuditRevisionContext;
  }): Promise<void>;
}

export class ToolsAuditBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: ToolsAuditBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertToolsAuditMutationV1(mutation);
    const revision: ToolsAuditRevisionContext = {
      revisionId: mutation.revision.id,
      parentRevisionIds: [...mutation.revision.parents],
      sourceDeviceId: mutation.sourceDeviceId,
      sourceSequence: mutation.sourceSequence,
      createdAt: mutation.createdAt,
    };
    if (mutation.revision.operation === 'delete') {
      const payload = mutation.payload as Record<string, unknown>;
      await this.port.deleteAuditEvent({
        callId: mutation.entity.id,
        deletedAt: Number(payload.deletedAt),
        revision,
      });
      return;
    }
    const { kind, value } = toolsAuditMutationValue(mutation);
    await this.port.upsertAuditRecord({
      kind,
      value,
      revision,
    });
  }
}

export const TOOLS_AUDIT_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: TOOLS_AUDIT_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertToolsAuditMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
