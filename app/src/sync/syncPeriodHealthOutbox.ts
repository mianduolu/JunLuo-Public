import {
  assertSyncDevicePublicIdentityV1,
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type { SyncMutationStatePort } from './syncMutationEnvelope';
import {
  assertPeriodHealthMutationV1,
  assertPeriodHealthPayload,
  isPeriodHealthEntityType,
  PERIOD_HEALTH_RETENTION_CLASS,
  PERIOD_HEALTH_SCHEMA_VERSION,
  type PeriodHealthEntityType,
} from './syncPeriodHealth';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export type PeriodHealthOutboxState =
  | 'pending'
  | 'leased'
  | 'dispatched'
  | 'quarantined';

export type PeriodHealthDomainOutboxEntry = {
  localSequence: number;
  mutationId: string;
  revisionId: string;
  parentRevisionIds: string[];
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number | null;
  entityType: PeriodHealthEntityType;
  entityId: string;
  operation: SyncOperation;
  schemaVersion: number;
  payload: JsonValue;
  state: PeriodHealthOutboxState;
  attemptCount: number;
  availableAt: number;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ClaimedPeriodHealthOutboxEntry =
  PeriodHealthDomainOutboxEntry & {
    state: 'leased';
    leaseId: string;
    leaseExpiresAt: number;
  };

export interface PeriodHealthDomainOutboxPort {
  claimPending(input: {
    leaseId: string;
    now: number;
    leaseDurationMs: number;
    limit: number;
  }): Promise<ClaimedPeriodHealthOutboxEntry[]>;
  reserveSourceSequence(input: {
    localSequence: number;
    leaseId: string;
    sourceSequence: number;
    updatedAt: number;
  }): Promise<ClaimedPeriodHealthOutboxEntry>;
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

export type PromotePeriodHealthOutboxReport = {
  claimedCount: number;
  dispatchedCount: number;
  failed: Array<{ localSequence: number; errorCode: string }>;
};

const OPERATIONS = new Set<SyncOperation>([
  'upsert',
  'delete',
  'restore',
]);
const STATES = new Set<PeriodHealthOutboxState>([
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
    || !/^[A-Za-z0-9._:-]+$/u.test(value)
  ) {
    throw new Error('period.health outbox leaseId 格式无效。');
  }
}

export function assertPeriodHealthDomainOutboxEntry(
  value: PeriodHealthDomainOutboxEntry,
) {
  assertInteger(value.localSequence, 'period.health localSequence', 1);
  assertSyncUuidV4(value.mutationId, 'period.health mutationId');
  assertSyncUuidV4(value.revisionId, 'period.health revisionId');
  if (
    !Array.isArray(value.parentRevisionIds)
    || value.parentRevisionIds.length > 32
  ) {
    throw new Error('period.health parentRevisionIds 必须是最多 32 项。');
  }
  value.parentRevisionIds.forEach((id, index) => (
    assertSyncUuidV4(id, `period.health parentRevisionIds[${index}]`)
  ));
  if (
    new Set(value.parentRevisionIds).size
    !== value.parentRevisionIds.length
  ) {
    throw new Error('period.health parentRevisionIds 不能重复。');
  }
  assertSyncUuidV4(value.vaultId, 'period.health vaultId');
  assertSyncUuidV4(value.sourceDeviceId, 'period.health sourceDeviceId');
  assertNullableInteger(
    value.sourceSequence,
    'period.health sourceSequence',
    1,
  );
  if (!isPeriodHealthEntityType(value.entityType)) {
    throw new Error('period.health outbox entityType 无效。');
  }
  if (!value.entityId || value.entityId.length > 256) {
    throw new Error('period.health outbox entityId 长度无效。');
  }
  if (!OPERATIONS.has(value.operation)) {
    throw new Error('period.health outbox operation 无效。');
  }
  if (value.schemaVersion !== PERIOD_HEALTH_SCHEMA_VERSION) {
    throw new Error('period.health outbox schemaVersion 无效。');
  }
  assertJsonValue(value.payload);
  assertPeriodHealthPayload(
    value.entityType,
    value.entityId,
    value.operation,
    value.payload,
  );
  if (!STATES.has(value.state)) {
    throw new Error('period.health outbox state 无效。');
  }
  assertInteger(value.attemptCount, 'period.health attemptCount');
  assertInteger(value.availableAt, 'period.health availableAt');
  if (value.leaseId !== null) assertLeaseId(value.leaseId);
  assertNullableInteger(
    value.leaseExpiresAt,
    'period.health leaseExpiresAt',
  );
  assertInteger(value.createdAt, 'period.health createdAt');
  assertInteger(value.updatedAt, 'period.health updatedAt');
}

export function materializePeriodHealthMutation(
  entry: PeriodHealthDomainOutboxEntry,
): PlainMutationV1 {
  assertPeriodHealthDomainOutboxEntry(entry);
  if (entry.sourceSequence === null) {
    throw new Error('period.health outbox 尚未分配 sourceSequence。');
  }
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: entry.mutationId,
    vaultId: entry.vaultId,
    sourceDeviceId: entry.sourceDeviceId,
    sourceSequence: entry.sourceSequence,
    createdAt: entry.createdAt,
    entity: {
      domain: 'period',
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
    retentionClass: PERIOD_HEALTH_RETENTION_CLASS,
  };
  assertPeriodHealthMutationV1(mutation);
  return mutation;
}

function errorCodeOf(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  if (/heads 已变化|latest heads|entity heads/iu.test(raw)) {
    return 'entity-heads-changed';
  }
  if (/identity|device|vault|撤销|active/iu.test(raw)) {
    return 'device-identity-invalid';
  }
  if (/schema|payload|entity|mutation|period/iu.test(raw)) {
    return 'invalid-period-health-mutation';
  }
  return 'promotion-failed';
}

export async function promotePeriodHealthDomainOutbox(input: {
  identity: SyncDevicePublicIdentityV1;
  leaseId: string;
  now: number;
  limit: number;
  leaseDurationMs: number;
  domainOutbox: PeriodHealthDomainOutboxPort;
  mutationState: Pick<
    SyncMutationStatePort,
    'allocateSyncSourceSequence'
  >;
  centralOutbox: {
    enqueueSyncMutation(mutation: PlainMutationV1): Promise<void>;
  };
}): Promise<PromotePeriodHealthOutboxReport> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (
    input.identity.state !== 'active'
    || input.identity.revokedAt !== null
  ) {
    throw new Error(
      '只有 active 且未撤销的设备可以搬运 period.health outbox。',
    );
  }
  assertLeaseId(input.leaseId);
  assertInteger(input.now, 'period.health promotion now');
  assertInteger(input.limit, 'period.health promotion limit', 1);
  assertInteger(
    input.leaseDurationMs,
    'period.health leaseDurationMs',
    1,
  );
  const claimed = await input.domainOutbox.claimPending({
    leaseId: input.leaseId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    limit: input.limit,
  });
  const report: PromotePeriodHealthOutboxReport = {
    claimedCount: claimed.length,
    dispatchedCount: 0,
    failed: [],
  };
  for (const original of claimed) {
    let entry = original;
    try {
      assertPeriodHealthDomainOutboxEntry(entry);
      if (
        entry.vaultId !== input.identity.vaultId
        || entry.sourceDeviceId !== input.identity.deviceId
      ) {
        throw new Error(
          'period.health outbox identity 与当前 active device 不一致。',
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
        materializePeriodHealthMutation(entry),
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
