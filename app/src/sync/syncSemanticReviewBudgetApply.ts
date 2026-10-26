import type { BaiyunSemanticReviewEntry } from '../ai/behavior/actionBudget';
import {
  assertSemanticReviewBudgetMutationV1,
  SEMANTIC_REVIEW_BUDGET_ADAPTER_ID,
  semanticReviewLedgerRecordFromMutation,
} from './syncSemanticReviewBudget';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type SemanticReviewBudgetRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface SemanticReviewBudgetBusinessPort {
  upsertEntry(input: {
    globalEntryId: string;
    localDate: string;
    remoteAccountId: string;
    entry: BaiyunSemanticReviewEntry;
    revision: SemanticReviewBudgetRevisionContext;
  }): Promise<void>;
}

function revisionContext(
  mutation: PlainMutationV1,
): SemanticReviewBudgetRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

export class SemanticReviewBudgetBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: SemanticReviewBudgetBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertSemanticReviewBudgetMutationV1(mutation);
    const record = semanticReviewLedgerRecordFromMutation(mutation);
    await this.port.upsertEntry({
      globalEntryId: mutation.entity.id,
      localDate: record.localDate,
      remoteAccountId: record.remoteAccountId,
      entry: record.entry,
      revision: revisionContext(mutation),
    });
  }
}

export const SEMANTIC_REVIEW_BUDGET_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: SEMANTIC_REVIEW_BUDGET_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertSemanticReviewBudgetMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
