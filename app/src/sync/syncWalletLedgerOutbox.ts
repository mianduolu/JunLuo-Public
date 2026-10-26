import {
  assertSyncDevicePublicIdentityV1,
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type { SyncMutationStatePort } from './syncMutationEnvelope';
import {
  assertWalletLedgerMutationV1,
  assertWalletLedgerPayload,
  isWalletLedgerEntityType,
  WALLET_LEDGER_RETENTION_CLASS,
  WALLET_LEDGER_SCHEMA_VERSION,
  type WalletLedgerEntityType,
} from './syncWalletLedger';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export type WalletLedgerOutboxState =
  | 'pending'
  | 'leased'
  | 'dispatched'
  | 'quarantined';

export type WalletLedgerDomainOutboxEntry = {
  localSequence: number;
  mutationId: string;
  revisionId: string;
  parentRevisionIds: string[];
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number | null;
  entityType: WalletLedgerEntityType;
  entityId: string;
  operation: SyncOperation;
  schemaVersion: number;
  payload: JsonValue;
  state: WalletLedgerOutboxState;
  attemptCount: number;
  availableAt: number;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ClaimedWalletLedgerOutboxEntry =
  WalletLedgerDomainOutboxEntry & {
    state: 'leased';
    leaseId: string;
    leaseExpiresAt: number;
  };

export interface WalletLedgerDomainOutboxPort {
  claimPending(input: {
    leaseId: string;
    now: number;
    leaseDurationMs: number;
    limit: number;
  }): Promise<ClaimedWalletLedgerOutboxEntry[]>;
  reserveSourceSequence(input: {
    localSequence: number;
    leaseId: string;
    sourceSequence: number;
    updatedAt: number;
  }): Promise<ClaimedWalletLedgerOutboxEntry>;
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

export type PromoteWalletLedgerOutboxReport = {
  claimedCount: number;
  dispatchedCount: number;
  failed: Array<{ localSequence: number; errorCode: string }>;
};

const STATES = new Set<WalletLedgerOutboxState>([
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
    throw new Error('wallet outbox leaseId 格式无效。');
  }
}

export function assertWalletLedgerDomainOutboxEntry(
  value: WalletLedgerDomainOutboxEntry,
) {
  assertInteger(value.localSequence, 'wallet localSequence', 1);
  assertSyncUuidV4(value.mutationId, 'wallet mutationId');
  assertSyncUuidV4(value.revisionId, 'wallet revisionId');
  if (
    !Array.isArray(value.parentRevisionIds)
    || value.parentRevisionIds.length > 32
  ) {
    throw new Error('wallet parentRevisionIds 必须是最多 32 项。');
  }
  value.parentRevisionIds.forEach((id, index) => (
    assertSyncUuidV4(id, `wallet parentRevisionIds[${index}]`)
  ));
  if (
    new Set(value.parentRevisionIds).size
    !== value.parentRevisionIds.length
  ) {
    throw new Error('wallet parentRevisionIds 不能重复。');
  }
  assertSyncUuidV4(value.vaultId, 'wallet vaultId');
  assertSyncUuidV4(value.sourceDeviceId, 'wallet sourceDeviceId');
  assertNullableInteger(value.sourceSequence, 'wallet sourceSequence', 1);
  if (!isWalletLedgerEntityType(value.entityType)) {
    throw new Error('wallet outbox entityType 无效。');
  }
  if (!value.entityId || value.entityId.length > 256) {
    throw new Error('wallet outbox entityId 长度无效。');
  }
  if (value.operation !== 'upsert') {
    throw new Error('wallet outbox operation 无效。');
  }
  if (value.schemaVersion !== WALLET_LEDGER_SCHEMA_VERSION) {
    throw new Error('wallet outbox schemaVersion 无效。');
  }
  assertJsonValue(value.payload);
  assertWalletLedgerPayload(
    value.entityType,
    value.entityId,
    value.operation,
    value.payload,
  );
  if (!STATES.has(value.state)) {
    throw new Error('wallet outbox state 无效。');
  }
  assertInteger(value.attemptCount, 'wallet attemptCount');
  assertInteger(value.availableAt, 'wallet availableAt');
  if (value.leaseId !== null) assertLeaseId(value.leaseId);
  assertNullableInteger(value.leaseExpiresAt, 'wallet leaseExpiresAt');
  assertInteger(value.createdAt, 'wallet createdAt');
  assertInteger(value.updatedAt, 'wallet updatedAt');
}

export function materializeWalletLedgerMutation(
  entry: WalletLedgerDomainOutboxEntry,
): PlainMutationV1 {
  assertWalletLedgerDomainOutboxEntry(entry);
  if (entry.sourceSequence === null) {
    throw new Error('wallet outbox 尚未分配 sourceSequence。');
  }
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: entry.mutationId,
    vaultId: entry.vaultId,
    sourceDeviceId: entry.sourceDeviceId,
    sourceSequence: entry.sourceSequence,
    createdAt: entry.createdAt,
    entity: {
      domain: 'wallet',
      type: entry.entityType,
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
    retentionClass: WALLET_LEDGER_RETENTION_CLASS,
  };
  assertWalletLedgerMutationV1(mutation);
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
  if (/schema|payload|entity|mutation|wallet/i.test(raw)) {
    return 'invalid-wallet-mutation';
  }
  return 'promotion-failed';
}

export async function promoteWalletLedgerDomainOutbox(input: {
  identity: SyncDevicePublicIdentityV1;
  leaseId: string;
  now: number;
  limit: number;
  leaseDurationMs: number;
  domainOutbox: WalletLedgerDomainOutboxPort;
  mutationState: Pick<
    SyncMutationStatePort,
    'allocateSyncSourceSequence'
  >;
  centralOutbox: {
    enqueueSyncMutation(mutation: PlainMutationV1): Promise<void>;
  };
}): Promise<PromoteWalletLedgerOutboxReport> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (
    input.identity.state !== 'active'
    || input.identity.revokedAt !== null
  ) {
    throw new Error(
      '只有 active 且未撤销的设备可以搬运 wallet outbox。',
    );
  }
  assertLeaseId(input.leaseId);
  assertInteger(input.now, 'wallet promotion now');
  assertInteger(input.limit, 'wallet promotion limit', 1);
  assertInteger(input.leaseDurationMs, 'wallet leaseDurationMs', 1);
  const claimed = await input.domainOutbox.claimPending({
    leaseId: input.leaseId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    limit: input.limit,
  });
  const report: PromoteWalletLedgerOutboxReport = {
    claimedCount: claimed.length,
    dispatchedCount: 0,
    failed: [],
  };
  for (const original of claimed) {
    let entry = original;
    try {
      assertWalletLedgerDomainOutboxEntry(entry);
      if (
        entry.vaultId !== input.identity.vaultId
        || entry.sourceDeviceId !== input.identity.deviceId
      ) {
        throw new Error(
          'wallet outbox identity 与当前 active device 不一致。',
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
        materializeWalletLedgerMutation(entry),
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
