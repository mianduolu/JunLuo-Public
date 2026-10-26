import {
  assertExpenseLedgerMutationV1,
  expenseLedgerPayload,
  EXPENSE_LEDGER_ADAPTER_ID,
  type ExpenseLedgerRecord,
} from './syncExpenseLedger';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type ExpenseLedgerRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
  schemaVersion: number;
};

export interface ExpenseLedgerBusinessPort {
  upsertRecord(input: {
    entityId: string;
    record: ExpenseLedgerRecord;
    operation: 'upsert' | 'restore';
    revision: ExpenseLedgerRevisionContext;
  }): Promise<void>;
  deleteRecord(input: {
    entityId: string;
    deletedAt: number;
    revision: ExpenseLedgerRevisionContext;
  }): Promise<void>;
}

export class ExpenseLedgerBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: ExpenseLedgerBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertExpenseLedgerMutationV1(mutation);
    const payload = expenseLedgerPayload(mutation);
    const revision: ExpenseLedgerRevisionContext = {
      revisionId: mutation.revision.id,
      parentRevisionIds: [...mutation.revision.parents],
      sourceDeviceId: mutation.sourceDeviceId,
      sourceSequence: mutation.sourceSequence,
      createdAt: mutation.createdAt,
      schemaVersion: mutation.revision.schemaVersion,
    };
    if ('deletedAt' in payload) {
      await this.port.deleteRecord({
        entityId: mutation.entity.id,
        deletedAt: payload.deletedAt,
        revision,
      });
      return;
    }
    await this.port.upsertRecord({
      entityId: mutation.entity.id,
      record: payload.record,
      operation: mutation.revision.operation as 'upsert' | 'restore',
      revision,
    });
  }
}

export const EXPENSE_LEDGER_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: EXPENSE_LEDGER_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertExpenseLedgerMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
