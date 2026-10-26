import {
  assertWalletLedgerMutationV1,
  walletLedgerPayload,
  WALLET_LEDGER_ADAPTER_ID,
  type WalletLedgerEntityType,
  type WalletLedgerRecord,
} from './syncWalletLedger';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type WalletLedgerRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface WalletLedgerBusinessPort {
  upsertRecord(input: {
    entityType: WalletLedgerEntityType;
    entityId: string;
    record: WalletLedgerRecord;
    revision: WalletLedgerRevisionContext;
  }): Promise<void>;
}

export class WalletLedgerBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: WalletLedgerBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertWalletLedgerMutationV1(mutation);
    const payload = walletLedgerPayload(mutation);
    await this.port.upsertRecord({
      entityType: payload.kind,
      entityId: mutation.entity.id,
      record: payload.record,
      revision: {
        revisionId: mutation.revision.id,
        parentRevisionIds: [...mutation.revision.parents],
        sourceDeviceId: mutation.sourceDeviceId,
        sourceSequence: mutation.sourceSequence,
        createdAt: mutation.createdAt,
      },
    });
  }
}

export const WALLET_LEDGER_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: WALLET_LEDGER_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertWalletLedgerMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
