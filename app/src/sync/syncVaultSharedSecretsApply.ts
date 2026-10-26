import {
  assertVaultSharedSecretMutationV1,
  VAULT_SHARED_SECRETS_ADAPTER_ID,
  type VaultSharedSecretRecordV1,
} from './syncVaultSharedSecrets';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type VaultSharedSecretRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface VaultSharedSecretBusinessPort {
  upsert(input: {
    record: VaultSharedSecretRecordV1;
    revision: VaultSharedSecretRevisionContext;
  }): Promise<void>;
  revoke(input: {
    secretId: string;
    revokedAt: number;
    revision: VaultSharedSecretRevisionContext;
  }): Promise<void>;
}

function revisionContext(
  mutation: PlainMutationV1,
): VaultSharedSecretRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

export class VaultSharedSecretBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(
    private readonly port: VaultSharedSecretBusinessPort,
  ) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertVaultSharedSecretMutationV1(mutation);
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
      record: payload.secret as VaultSharedSecretRecordV1,
      revision,
    });
  }
}

export const VAULT_SHARED_SECRETS_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: VAULT_SHARED_SECRETS_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertVaultSharedSecretMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
