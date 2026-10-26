import {
  assertProactiveLedgerMutationV1,
  PROACTIVE_LEDGER_ADAPTER_ID,
  type ProactiveLedgerEntityType,
  type ProactiveLedgerRecordKind,
} from './syncProactiveLedger';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type {
  JsonValue,
  PlainMutationV1,
} from './syncProtocol';

export type ProactiveLedgerRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface ProactiveLedgerBusinessPort {
  upsertRecord(input: {
    entityType: ProactiveLedgerEntityType;
    entityId: string;
    kind: ProactiveLedgerRecordKind;
    value: JsonValue;
    revision: ProactiveLedgerRevisionContext;
  }): Promise<void>;
}

function payloadRecord(mutation: PlainMutationV1) {
  if (
    !mutation.payload
    || typeof mutation.payload !== 'object'
    || Array.isArray(mutation.payload)
  ) {
    throw new Error('proactive.ledger payload 必须是对象。');
  }
  return mutation.payload;
}

function revisionContext(
  mutation: PlainMutationV1,
): ProactiveLedgerRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

export class ProactiveLedgerBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: ProactiveLedgerBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertProactiveLedgerMutationV1(mutation);
    const payload = payloadRecord(mutation);
    await this.port.upsertRecord({
      entityType: mutation.entity.type as ProactiveLedgerEntityType,
      entityId: mutation.entity.id,
      kind: payload.kind as ProactiveLedgerRecordKind,
      value: payload.value as JsonValue,
      revision: revisionContext(mutation),
    });
  }
}

export const PROACTIVE_LEDGER_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: PROACTIVE_LEDGER_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertProactiveLedgerMutationV1(mutation);
      return payloadRecord(mutation).kind !== 'social-share-intent';
    } catch {
      return false;
    }
  },
};
