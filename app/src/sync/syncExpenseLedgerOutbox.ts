import {
  assertSyncDevicePublicIdentityV1,
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type { SyncMutationStatePort } from './syncMutationEnvelope';
import {
  assertExpenseLedgerMutationV1,
  assertExpenseLedgerPayload,
  EXPENSE_LEDGER_ENTITY_TYPE,
  EXPENSE_LEDGER_RETENTION_CLASS,
} from './syncExpenseLedger';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export type ExpenseLedgerOutboxState =
  | 'pending'
  | 'leased'
  | 'dispatched'
  | 'quarantined';

export type ExpenseLedgerDomainOutboxEntry = {
  localSequence: number;
  mutationId: string;
  revisionId: string;
  parentRevisionIds: string[];
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number | null;
  entityType: typeof EXPENSE_LEDGER_ENTITY_TYPE;
  entityId: string;
  operation: SyncOperation;
  schemaVersion: number;
  payload: JsonValue;
  state: ExpenseLedgerOutboxState;
  attemptCount: number;
  availableAt: number;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ClaimedExpenseLedgerOutboxEntry =
  ExpenseLedgerDomainOutboxEntry & {
    state: 'leased';
    leaseId: string;
    leaseExpiresAt: number;
  };

export interface ExpenseLedgerDomainOutboxPort {
  claimPending(input: {
    leaseId: string;
    now: number;
    leaseDurationMs: number;
    limit: number;
  }): Promise<ClaimedExpenseLedgerOutboxEntry[]>;
  reserveSourceSequence(input: {
    localSequence: number;
    leaseId: string;
    sourceSequence: number;
    updatedAt: number;
  }): Promise<ClaimedExpenseLedgerOutboxEntry>;
  markDispatched(input: {
    localSequence: number;
    leaseId: string;
    dispatchedAt: number;
  }): Promise<void>;
  releaseFailed(input: {
    localSequence: number;
    leaseId: string;
    failedAt: number;
    errorCode: string;
  }): Promise<void>;
}

export type PromoteExpenseLedgerOutboxReport = {
  claimedCount: number;
  dispatchedCount: number;
  failed: Array<{ localSequence: number; errorCode: string }>;
};

const OPERATIONS = new Set<SyncOperation>([
  'upsert',
  'delete',
  'restore',
]);
const STATES = new Set<ExpenseLedgerOutboxState>([
  'pending',
  'leased',
  'dispatched',
  'quarantined',
]);

function assertInteger(
  value: unknown,
  label: string,
  minimum = 0,
) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} 必须是大于等于 ${minimum} 的安全整数。`);
  }
}

function assertNullableInteger(
  value: unknown,
  label: string,
  minimum = 0,
) {
  if (value === null) return;
  assertInteger(value, label, minimum);
}

function assertLeaseId(value: string) {
  if (
    !value
    || value.length > 160
    || !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new Error('expense outbox leaseId 格式无效。');
  }
}

export function assertExpenseLedgerDomainOutboxEntry(
  value: ExpenseLedgerDomainOutboxEntry,
) {
  assertInteger(value.localSequence, 'expense localSequence', 1);
  assertSyncUuidV4(value.mutationId, 'expense mutationId');
  assertSyncUuidV4(value.revisionId, 'expense revisionId');
  if (
    !Array.isArray(value.parentRevisionIds)
    || value.parentRevisionIds.length > 32
  ) {
    throw new Error('expense parentRevisionIds 必须是最多 32 项。');
  }
  value.parentRevisionIds.forEach((id, index) => (
    assertSyncUuidV4(id, `expense parentRevisionIds[${index}]`)
  ));
  if (
    new Set(value.parentRevisionIds).size
    !== value.parentRevisionIds.length
  ) {
    throw new Error('expense parentRevisionIds 不能重复。');
  }
  assertSyncUuidV4(value.vaultId, 'expense vaultId');
  assertSyncUuidV4(value.sourceDeviceId, 'expense sourceDeviceId');
  assertNullableInteger(value.sourceSequence, 'expense sourceSequence', 1);
  if (value.entityType !== EXPENSE_LEDGER_ENTITY_TYPE) {
    throw new Error('expense outbox entityType 无效。');
  }
  if (!value.entityId || value.entityId.length > 256) {
    throw new Error('expense outbox entityId 长度无效。');
  }
  if (!OPERATIONS.has(value.operation)) {
    throw new Error('expense outbox operation 无效。');
  }
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    throw new Error('expense outbox schemaVersion 无效。');
  }
  assertJsonValue(value.payload);
  assertExpenseLedgerPayload(
    value.entityId,
    value.operation,
    value.payload,
  );
  if ((value.payload as { schemaVersion: number }).schemaVersion
      !== value.schemaVersion) {
    throw new Error('expense outbox payload 与 schemaVersion 不一致。');
  }
  if (!STATES.has(value.state)) {
    throw new Error('expense outbox state 无效。');
  }
  assertInteger(value.attemptCount, 'expense attemptCount');
  assertInteger(value.availableAt, 'expense availableAt');
  if (value.leaseId !== null) assertLeaseId(value.leaseId);
  assertNullableInteger(
    value.leaseExpiresAt,
    'expense leaseExpiresAt',
  );
  assertInteger(value.createdAt, 'expense createdAt');
  assertInteger(value.updatedAt, 'expense updatedAt');
}

export function materializeExpenseLedgerMutation(
  entry: ExpenseLedgerDomainOutboxEntry,
): PlainMutationV1 {
  assertExpenseLedgerDomainOutboxEntry(entry);
  if (entry.sourceSequence === null) {
    throw new Error('expense outbox 尚未分配 sourceSequence。');
  }
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: entry.mutationId,
    vaultId: entry.vaultId,
    sourceDeviceId: entry.sourceDeviceId,
    sourceSequence: entry.sourceSequence,
    createdAt: entry.createdAt,
    entity: {
      domain: 'expense',
      type: EXPENSE_LEDGER_ENTITY_TYPE,
      id: entry.entityId,
    },
    revision: {
      id: entry.revisionId,
      parents: [...entry.parentRevisionIds],
      operation: entry.operation,
      schemaVersion: entry.schemaVersion,
    },
    sensitivity: 'highest',
    payload: entry.payload,
    objectRefs: [],
    retentionClass: EXPENSE_LEDGER_RETENTION_CLASS,
  };
  assertExpenseLedgerMutationV1(mutation);
  return mutation;
}

function errorCodeOf(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  if (/heads 已变化|latest heads|entity heads/i.test(raw)) {
    return 'entity-heads-changed';
  }
  if (/identity|device|vault|撤销|active/i.test(raw)) {
    return 'device-identity-invalid';
  }
  if (/schema|payload|entity|mutation|expense/i.test(raw)) {
    return 'invalid-expense-mutation';
  }
  return 'promotion-failed';
}

export async function promoteExpenseLedgerDomainOutbox(input: {
  identity: SyncDevicePublicIdentityV1;
  leaseId: string;
  now: number;
  limit: number;
  leaseDurationMs: number;
  domainOutbox: ExpenseLedgerDomainOutboxPort;
  mutationState: Pick<
    SyncMutationStatePort,
    'allocateSyncSourceSequence'
  >;
  centralOutbox: {
    enqueueSyncMutation(mutation: PlainMutationV1): Promise<void>;
  };
}): Promise<PromoteExpenseLedgerOutboxReport> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (
    input.identity.state !== 'active'
    || input.identity.revokedAt !== null
  ) {
    throw new Error(
      '只有 active 且未撤销的设备可以搬运 expense outbox。',
    );
  }
  assertLeaseId(input.leaseId);
  assertInteger(input.now, 'expense promotion now');
  assertInteger(input.limit, 'expense promotion limit', 1);
  assertInteger(
    input.leaseDurationMs,
    'expense leaseDurationMs',
    1,
  );
  const claimed = await input.domainOutbox.claimPending({
    leaseId: input.leaseId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    limit: input.limit,
  });
  const report: PromoteExpenseLedgerOutboxReport = {
    claimedCount: claimed.length,
    dispatchedCount: 0,
    failed: [],
  };
  for (const original of claimed) {
    let entry = original;
    try {
      assertExpenseLedgerDomainOutboxEntry(entry);
      if (
        entry.vaultId !== input.identity.vaultId
        || entry.sourceDeviceId !== input.identity.deviceId
      ) {
        throw new Error(
          'expense outbox identity 与当前 active device 不一致。',
        );
      }
      if (entry.sourceSequence === null) {
        const sourceSequence =
          await input.mutationState.allocateSyncSourceSequence(
            entry.sourceDeviceId,
            input.now,
          );
        entry = await input.domainOutbox.reserveSourceSequence({
          localSequence: entry.localSequence,
          leaseId: input.leaseId,
          sourceSequence,
          updatedAt: input.now,
        });
      }
      await input.centralOutbox.enqueueSyncMutation(
        materializeExpenseLedgerMutation(entry),
      );
      await input.domainOutbox.markDispatched({
        localSequence: entry.localSequence,
        leaseId: input.leaseId,
        dispatchedAt: input.now,
      });
      report.dispatchedCount += 1;
    } catch (error) {
      const errorCode = errorCodeOf(error);
      await input.domainOutbox.releaseFailed({
        localSequence: entry.localSequence,
        leaseId: input.leaseId,
        failedAt: input.now,
        errorCode,
      });
      report.failed.push({
        localSequence: entry.localSequence,
        errorCode,
      });
    }
  }
  return report;
}
