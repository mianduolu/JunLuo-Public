import {
  assertVaultExportableSessionMutationV1,
  VAULT_EXPORTABLE_SESSIONS_ADAPTER_ID,
  type VaultExportableSessionRecordV1,
} from './syncVaultExportableSessions';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type VaultExportableSessionRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface VaultExportableSessionBusinessPort {
  upsert(input: {
    record: VaultExportableSessionRecordV1;
    revision: VaultExportableSessionRevisionContext;
  }): Promise<void>;
  revoke(input: {
    secretId: string;
    revokedAt: number;
    revision: VaultExportableSessionRevisionContext;
  }): Promise<void>;
}

function revisionContext(
  mutation: PlainMutationV1,
): VaultExportableSessionRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

export class VaultExportableSessionBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(
    private readonly port: VaultExportableSessionBusinessPort,
  ) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertVaultExportableSessionMutationV1(mutation);
    const payload = mutation.payload as Record<string, unknown>;
    const revision = revisionContext(mutation);
    if (mutation.revision.operation === 'delete') {
      await this.port.revoke({
        secretId: payload.secretId as string,
        revokedAt: payload.revokedAt as number,
        revision,
      });
      return;
    }
    await this.port.upsert({
      record: payload.session as VaultExportableSessionRecordV1,
      revision,
    });
  }
}

export const VAULT_EXPORTABLE_SESSIONS_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: VAULT_EXPORTABLE_SESSIONS_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertVaultExportableSessionMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
