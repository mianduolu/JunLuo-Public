import {
  assertBehaviorRoutingFieldValue,
  assertBehaviorRoutingMutationV1,
  BEHAVIOR_ROUTING_ADAPTER_ID,
  type BehaviorRoutingField,
  type BehaviorRoutingFieldValue,
} from './syncBehaviorRouting';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type BehaviorRoutingRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface BehaviorRoutingBusinessPort {
  upsertField(input: {
    field: BehaviorRoutingField;
    value: BehaviorRoutingFieldValue;
    revision: BehaviorRoutingRevisionContext;
  }): Promise<void>;
  deleteField(input: {
    field: BehaviorRoutingField;
    revision: BehaviorRoutingRevisionContext;
  }): Promise<void>;
}

function payloadRecord(mutation: PlainMutationV1) {
  if (
    !mutation.payload
    || typeof mutation.payload !== 'object'
    || Array.isArray(mutation.payload)
  ) {
    throw new Error('behavior.routing payload 必须是对象。');
  }
  return mutation.payload;
}

function revisionContext(
  mutation: PlainMutationV1,
): BehaviorRoutingRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

export class BehaviorRoutingBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: BehaviorRoutingBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertBehaviorRoutingMutationV1(mutation);
    const field = mutation.entity.id as BehaviorRoutingField;
    const revision = revisionContext(mutation);
    if (mutation.revision.operation === 'delete') {
      await this.port.deleteField({ field, revision });
      return;
    }
    const payload = payloadRecord(mutation);
    assertBehaviorRoutingFieldValue(field, payload.value);
    await this.port.upsertField({
      field,
      value: payload.value,
      revision,
    });
  }
}

export const BEHAVIOR_ROUTING_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: BEHAVIOR_ROUTING_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertBehaviorRoutingMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
