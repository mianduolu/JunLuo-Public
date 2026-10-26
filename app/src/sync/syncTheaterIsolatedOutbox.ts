import {
  assertSyncDevicePublicIdentityV1,
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type { SyncMutationStatePort } from './syncMutationEnvelope';
import {
  assertTheaterIsolatedMutationV1,
  assertTheaterIsolatedPayload,
  THEATER_ISOLATED_ENTITY_TYPE,
  THEATER_ISOLATED_RETENTION_CLASS,
} from './syncTheaterIsolated';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export type TheaterIsolatedOutboxState =
  | 'pending'
  | 'leased'
  | 'dispatched'
  | 'quarantined';

export type TheaterIsolatedDomainOutboxEntry = {
  localSequence: number;
  mutationId: string;
  revisionId: string;
  parentRevisionIds: string[];
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number | null;
  entityType: typeof THEATER_ISOLATED_ENTITY_TYPE;
  entityId: string;
  operation: SyncOperation;
  schemaVersion: number;
  payload: JsonValue;
  state: TheaterIsolatedOutboxState;
  attemptCount: number;
  availableAt: number;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ClaimedTheaterIsolatedOutboxEntry =
  TheaterIsolatedDomainOutboxEntry & {
    state: 'leased';
    leaseId: string;
    leaseExpiresAt: number;
  };

export interface TheaterIsolatedDomainOutboxPort {
  claimPending(input: {
    leaseId: string;
    now: number;
    leaseDurationMs: number;
    limit: number;
  }): Promise<ClaimedTheaterIsolatedOutboxEntry[]>;
  reserveSourceSequence(input: {
    localSequence: number;
    leaseId: string;
    sourceSequence: number;
    updatedAt: number;
  }): Promise<ClaimedTheaterIsolatedOutboxEntry>;
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

export type PromoteTheaterIsolatedOutboxReport = {
  claimedCount: number;
  dispatchedCount: number;
  failed: Array<{ localSequence: number; errorCode: string }>;
};

const OPERATIONS = new Set<SyncOperation>([
  'upsert',
  'delete',
  'restore',
]);
const STATES = new Set<TheaterIsolatedOutboxState>([
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
    throw new Error('theater outbox leaseId 格式无效。');
  }
}

export function assertTheaterIsolatedDomainOutboxEntry(
  value: TheaterIsolatedDomainOutboxEntry,
) {
  assertInteger(value.localSequence, 'theater localSequence', 1);
  assertSyncUuidV4(value.mutationId, 'theater mutationId');
  assertSyncUuidV4(value.revisionId, 'theater revisionId');
  if (
    !Array.isArray(value.parentRevisionIds)
    || value.parentRevisionIds.length > 32
  ) {
    throw new Error('theater parentRevisionIds 必须是最多 32 项。');
  }
  value.parentRevisionIds.forEach((id, index) => (
    assertSyncUuidV4(id, `theater parentRevisionIds[${index}]`)
  ));
  if (
    new Set(value.parentRevisionIds).size
    !== value.parentRevisionIds.length
  ) {
    throw new Error('theater parentRevisionIds 不能重复。');
  }
  assertSyncUuidV4(value.vaultId, 'theater vaultId');
  assertSyncUuidV4(value.sourceDeviceId, 'theater sourceDeviceId');
  assertNullableInteger(value.sourceSequence, 'theater sourceSequence', 1);
  if (value.entityType !== THEATER_ISOLATED_ENTITY_TYPE) {
    throw new Error('theater outbox entityType 无效。');
  }
  if (!value.entityId || value.entityId.length > 256) {
    throw new Error('theater outbox entityId 长度无效。');
  }
  if (!OPERATIONS.has(value.operation)) {
    throw new Error('theater outbox operation 无效。');
  }
  if (value.schemaVersion !== (value.payload as { schemaVersion?: unknown })?.schemaVersion
    || ![1, 2].includes(value.schemaVersion)) {
    throw new Error('theater outbox schemaVersion 无效。');
  }
  assertJsonValue(value.payload);
  assertTheaterIsolatedPayload(
    value.entityId,
    value.operation,
    value.payload,
  );
  if (!STATES.has(value.state)) {
    throw new Error('theater outbox state 无效。');
  }
  assertInteger(value.attemptCount, 'theater attemptCount');
  assertInteger(value.availableAt, 'theater availableAt');
  if (value.leaseId !== null) assertLeaseId(value.leaseId);
  assertNullableInteger(
    value.leaseExpiresAt,
    'theater leaseExpiresAt',
  );
  assertInteger(value.createdAt, 'theater createdAt');
  assertInteger(value.updatedAt, 'theater updatedAt');
}

export function materializeTheaterIsolatedMutation(
  entry: TheaterIsolatedDomainOutboxEntry,
): PlainMutationV1 {
  assertTheaterIsolatedDomainOutboxEntry(entry);
  if (entry.sourceSequence === null) {
    throw new Error('theater outbox 尚未分配 sourceSequence。');
  }
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: entry.mutationId,
    vaultId: entry.vaultId,
    sourceDeviceId: entry.sourceDeviceId,
    sourceSequence: entry.sourceSequence,
    createdAt: entry.createdAt,
    entity: {
      domain: 'theater',
      type: THEATER_ISOLATED_ENTITY_TYPE,
      id: entry.entityId,
    },
    revision: {
      id: entry.revisionId,
      parents: [...entry.parentRevisionIds],
      operation: entry.operation,
      schemaVersion: entry.schemaVersion,
    },
    sensitivity: 'high',
    payload: entry.payload,
    objectRefs: [],
    retentionClass: THEATER_ISOLATED_RETENTION_CLASS,
  };
  assertTheaterIsolatedMutationV1(mutation);
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
  if (/schema|payload|entity|mutation|theater/i.test(raw)) {
    return 'invalid-theater-mutation';
  }
  return 'promotion-failed';
}

export async function promoteTheaterIsolatedDomainOutbox(input: {
  identity: SyncDevicePublicIdentityV1;
  leaseId: string;
  now: number;
  limit: number;
  leaseDurationMs: number;
  domainOutbox: TheaterIsolatedDomainOutboxPort;
  mutationState: Pick<
    SyncMutationStatePort,
    'allocateSyncSourceSequence'
  >;
  centralOutbox: {
    enqueueSyncMutation(mutation: PlainMutationV1): Promise<void>;
  };
}): Promise<PromoteTheaterIsolatedOutboxReport> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (
    input.identity.state !== 'active'
    || input.identity.revokedAt !== null
  ) {
    throw new Error(
      '只有 active 且未撤销的设备可以搬运 theater outbox。',
    );
  }
  assertLeaseId(input.leaseId);
  assertInteger(input.now, 'theater promotion now');
  assertInteger(input.limit, 'theater promotion limit', 1);
  assertInteger(
    input.leaseDurationMs,
    'theater leaseDurationMs',
    1,
  );
  const claimed = await input.domainOutbox.claimPending({
    leaseId: input.leaseId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    limit: input.limit,
  });
  const report: PromoteTheaterIsolatedOutboxReport = {
    claimedCount: claimed.length,
    dispatchedCount: 0,
    failed: [],
  };
  for (const original of claimed) {
    let entry = original;
    try {
      assertTheaterIsolatedDomainOutboxEntry(entry);
      if (
        entry.vaultId !== input.identity.vaultId
        || entry.sourceDeviceId !== input.identity.deviceId
      ) {
        throw new Error(
          'theater outbox identity 与当前 active device 不一致。',
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
        materializeTheaterIsolatedMutation(entry),
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
