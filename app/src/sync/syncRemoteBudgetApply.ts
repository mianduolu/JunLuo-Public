import {
  assertRemoteBudgetMutationV1,
  REMOTE_BUDGET_ADAPTER_ID,
  type RemoteBudgetEventRecord,
} from './syncRemoteBudget';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type RemoteBudgetRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface RemoteBudgetBusinessPort {
  appendEvent(input: {
    entityId: string;
    value: RemoteBudgetEventRecord;
    revision: RemoteBudgetRevisionContext;
  }): Promise<void>;
}

function payloadRecord(mutation: PlainMutationV1) {
  if (
    !mutation.payload
    || typeof mutation.payload !== 'object'
    || Array.isArray(mutation.payload)
  ) {
    throw new Error('usage.remote-budget payload 必须是对象。');
  }
  return mutation.payload;
}

function revisionContext(
  mutation: PlainMutationV1,
): RemoteBudgetRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

export class RemoteBudgetBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: RemoteBudgetBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertRemoteBudgetMutationV1(mutation);
    const payload = payloadRecord(mutation);
    await this.port.appendEvent({
      entityId: mutation.entity.id,
      value: payload.value as unknown as RemoteBudgetEventRecord,
      revision: revisionContext(mutation),
    });
  }
}

export const REMOTE_BUDGET_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: REMOTE_BUDGET_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertRemoteBudgetMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
