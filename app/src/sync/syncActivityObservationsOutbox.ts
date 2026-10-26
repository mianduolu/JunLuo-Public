import {
  assertSyncDevicePublicIdentityV1,
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type { SyncMutationStatePort } from './syncMutationEnvelope';
import {
  assertActivityObservationsMutationV1,
  assertActivityObservationsPayload,
  ACTIVITY_RECORD_RETENTION_CLASS,
  ACTIVITY_OBSERVATIONS_SCHEMA_VERSION,
  ACTIVITY_RAW_RETENTION_CLASS,
  isActivityObservationsEntityType,
  type ActivityObservationsEntityType,
  type ActivityObservationsPayloadV1,
} from './syncActivityObservations';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export type ActivityObservationsOutboxState =
  | 'pending'
  | 'leased'
  | 'dispatched'
  | 'quarantined';

export type ActivityObservationsDomainOutboxEntry = {
  localSequence: number;
  mutationId: string;
  revisionId: string;
  parentRevisionIds: string[];
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number | null;
  entityType: ActivityObservationsEntityType;
  entityId: string;
  operation: SyncOperation;
  schemaVersion: number;
  payload: JsonValue;
  state: ActivityObservationsOutboxState;
  attemptCount: number;
  availableAt: number;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ClaimedActivityObservationsOutboxEntry =
  ActivityObservationsDomainOutboxEntry & {
    state: 'leased';
    leaseId: string;
    leaseExpiresAt: number;
  };

export interface ActivityObservationsDomainOutboxPort {
  claimPending(input: {
    leaseId: string;
    now: number;
    leaseDurationMs: number;
    limit: number;
  }): Promise<ClaimedActivityObservationsOutboxEntry[]>;
  reserveSourceSequence(input: {
    localSequence: number;
    leaseId: string;
    sourceSequence: number;
    updatedAt: number;
  }): Promise<ClaimedActivityObservationsOutboxEntry>;
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

export type PromoteActivityObservationsOutboxReport = {
  claimedCount: number;
  dispatchedCount: number;
  failed: Array<{ localSequence: number; errorCode: string }>;
};

const STATES = new Set<ActivityObservationsOutboxState>([
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
    throw new Error(
      `${label} 必须是大于等于 ${minimum} 的安全整数。`,
    );
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
    throw new Error('activity.observations outbox leaseId 格式无效。');
  }
}

export function assertActivityObservationsDomainOutboxEntry(
  value: ActivityObservationsDomainOutboxEntry,
) {
  assertInteger(value.localSequence, 'activity observations localSequence', 1);
  assertSyncUuidV4(value.mutationId, 'activity observations mutationId');
  assertSyncUuidV4(value.revisionId, 'activity observations revisionId');
  if (
    !Array.isArray(value.parentRevisionIds)
    || value.parentRevisionIds.length > 32
  ) {
    throw new Error('activity observations parentRevisionIds 必须是最多 32 项。');
  }
  value.parentRevisionIds.forEach((id, index) => (
    assertSyncUuidV4(id, `activity observations parentRevisionIds[${index}]`)
  ));
  if (
    new Set(value.parentRevisionIds).size
    !== value.parentRevisionIds.length
  ) {
    throw new Error('activity observations parentRevisionIds 不能重复。');
  }
  assertSyncUuidV4(value.vaultId, 'activity observations vaultId');
  assertSyncUuidV4(value.sourceDeviceId, 'activity observations sourceDeviceId');
  assertNullableInteger(
    value.sourceSequence,
    'activity observations sourceSequence',
    1,
  );
  if (!isActivityObservationsEntityType(value.entityType)) {
    throw new Error('activity observations outbox entityType 无效。');
  }
  if (!value.entityId || value.entityId.length > 256) {
    throw new Error('activity observations outbox entityId 长度无效。');
  }
  if (
    value.operation !== 'upsert'
    && value.operation !== 'delete'
    && value.operation !== 'restore'
  ) {
    throw new Error('activity observations outbox operation 无效。');
  }
  if (value.schemaVersion !== ACTIVITY_OBSERVATIONS_SCHEMA_VERSION) {
    throw new Error('activity observations outbox schemaVersion 无效。');
  }
  assertJsonValue(value.payload);
  assertActivityObservationsPayload(
    value.entityType,
    value.entityId,
    value.operation,
    value.payload,
  );
  if (!STATES.has(value.state)) {
    throw new Error('activity observations outbox state 无效。');
  }
  assertInteger(value.attemptCount, 'activity observations attemptCount');
  assertInteger(value.availableAt, 'activity observations availableAt');
  if (value.leaseId !== null) assertLeaseId(value.leaseId);
  assertNullableInteger(
    value.leaseExpiresAt,
    'activity observations leaseExpiresAt',
  );
  assertInteger(value.createdAt, 'activity observations createdAt');
  assertInteger(value.updatedAt, 'activity observations updatedAt');
}

export function materializeActivityObservationsMutation(
  entry: ActivityObservationsDomainOutboxEntry,
): PlainMutationV1 {
  assertActivityObservationsDomainOutboxEntry(entry);
  if (entry.sourceSequence === null) {
    throw new Error(
      'activity.observations outbox 尚未分配 sourceSequence。',
    );
  }
  const payload = entry.payload as ActivityObservationsPayloadV1;
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: entry.mutationId,
    vaultId: entry.vaultId,
    sourceDeviceId: entry.sourceDeviceId,
    sourceSequence: entry.sourceSequence,
    createdAt: entry.createdAt,
    entity: {
      domain: 'activity',
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
    retentionClass: payload.kind === 'activity-reading'
      ? ACTIVITY_RAW_RETENTION_CLASS
      : ACTIVITY_RECORD_RETENTION_CLASS,
  };
  assertActivityObservationsMutationV1(mutation);
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
  if (/schema|payload|entity|mutation|activity/iu.test(raw)) {
    return 'invalid-activity-observations-mutation';
  }
  return 'promotion-failed';
}

export async function promoteActivityObservationsDomainOutbox(input: {
  identity: SyncDevicePublicIdentityV1;
  leaseId: string;
  now: number;
  limit: number;
  leaseDurationMs: number;
  domainOutbox: ActivityObservationsDomainOutboxPort;
  mutationState: Pick<
    SyncMutationStatePort,
    'allocateSyncSourceSequence'
  >;
  centralOutbox: {
    enqueueSyncMutation(mutation: PlainMutationV1): Promise<void>;
  };
}): Promise<PromoteActivityObservationsOutboxReport> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (
    input.identity.state !== 'active'
    || input.identity.revokedAt !== null
  ) {
    throw new Error(
      '只有 active 且未撤销的设备可以搬运 activity.observations outbox。',
    );
  }
  assertLeaseId(input.leaseId);
  assertInteger(input.now, 'activity observations promotion now');
  assertInteger(input.limit, 'activity observations promotion limit', 1);
  assertInteger(
    input.leaseDurationMs,
    'activity observations leaseDurationMs',
    1,
  );
  const claimed = await input.domainOutbox.claimPending({
    leaseId: input.leaseId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    limit: input.limit,
  });
  const report: PromoteActivityObservationsOutboxReport = {
    claimedCount: claimed.length,
    dispatchedCount: 0,
    failed: [],
  };
  for (const original of claimed) {
    let entry = original;
    try {
      assertActivityObservationsDomainOutboxEntry(entry);
      if (
        entry.vaultId !== input.identity.vaultId
        || entry.sourceDeviceId !== input.identity.deviceId
      ) {
        throw new Error(
          'activity observations outbox identity 与当前 active device 不一致。',
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
        materializeActivityObservationsMutation(entry),
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
