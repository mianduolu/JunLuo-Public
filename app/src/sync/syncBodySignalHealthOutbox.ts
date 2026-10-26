import {
  assertSyncDevicePublicIdentityV1,
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type { SyncMutationStatePort } from './syncMutationEnvelope';
import {
  assertBodySignalHealthMutationV1,
  assertBodySignalHealthPayload,
  BODY_SIGNAL_DERIVED_RETENTION_CLASS,
  BODY_SIGNAL_HEALTH_SCHEMA_VERSION,
  BODY_SIGNAL_RAW_RETENTION_CLASS,
  isBodySignalHealthEntityType,
  type BodySignalHealthEntityType,
  type BodySignalHealthPayloadV1,
} from './syncBodySignalHealth';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export type BodySignalHealthOutboxState =
  | 'pending'
  | 'leased'
  | 'dispatched'
  | 'quarantined';

export type BodySignalHealthDomainOutboxEntry = {
  localSequence: number;
  mutationId: string;
  revisionId: string;
  parentRevisionIds: string[];
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number | null;
  entityType: BodySignalHealthEntityType;
  entityId: string;
  operation: SyncOperation;
  schemaVersion: number;
  payload: JsonValue;
  state: BodySignalHealthOutboxState;
  attemptCount: number;
  availableAt: number;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ClaimedBodySignalHealthOutboxEntry =
  BodySignalHealthDomainOutboxEntry & {
    state: 'leased';
    leaseId: string;
    leaseExpiresAt: number;
  };

export interface BodySignalHealthDomainOutboxPort {
  claimPending(input: {
    leaseId: string;
    now: number;
    leaseDurationMs: number;
    limit: number;
  }): Promise<ClaimedBodySignalHealthOutboxEntry[]>;
  reserveSourceSequence(input: {
    localSequence: number;
    leaseId: string;
    sourceSequence: number;
    updatedAt: number;
  }): Promise<ClaimedBodySignalHealthOutboxEntry>;
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

export type PromoteBodySignalHealthOutboxReport = {
  claimedCount: number;
  dispatchedCount: number;
  failed: Array<{ localSequence: number; errorCode: string }>;
};

const STATES = new Set<BodySignalHealthOutboxState>([
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
    throw new Error('body-signal.health outbox leaseId 格式无效。');
  }
}

export function assertBodySignalHealthDomainOutboxEntry(
  value: BodySignalHealthDomainOutboxEntry,
) {
  assertInteger(value.localSequence, 'body signal localSequence', 1);
  assertSyncUuidV4(value.mutationId, 'body signal mutationId');
  assertSyncUuidV4(value.revisionId, 'body signal revisionId');
  if (
    !Array.isArray(value.parentRevisionIds)
    || value.parentRevisionIds.length > 32
  ) {
    throw new Error('body signal parentRevisionIds 必须是最多 32 项。');
  }
  value.parentRevisionIds.forEach((id, index) => (
    assertSyncUuidV4(id, `body signal parentRevisionIds[${index}]`)
  ));
  if (
    new Set(value.parentRevisionIds).size
    !== value.parentRevisionIds.length
  ) {
    throw new Error('body signal parentRevisionIds 不能重复。');
  }
  assertSyncUuidV4(value.vaultId, 'body signal vaultId');
  assertSyncUuidV4(value.sourceDeviceId, 'body signal sourceDeviceId');
  assertNullableInteger(
    value.sourceSequence,
    'body signal sourceSequence',
    1,
  );
  if (!isBodySignalHealthEntityType(value.entityType)) {
    throw new Error('body signal outbox entityType 无效。');
  }
  if (!value.entityId || value.entityId.length > 256) {
    throw new Error('body signal outbox entityId 长度无效。');
  }
  if (
    value.operation !== 'upsert'
    && value.operation !== 'delete'
    && value.operation !== 'restore'
  ) {
    throw new Error('body signal outbox operation 无效。');
  }
  if (value.schemaVersion !== BODY_SIGNAL_HEALTH_SCHEMA_VERSION) {
    throw new Error('body signal outbox schemaVersion 无效。');
  }
  assertJsonValue(value.payload);
  assertBodySignalHealthPayload(
    value.entityType,
    value.entityId,
    value.operation,
    value.payload,
  );
  if (!STATES.has(value.state)) {
    throw new Error('body signal outbox state 无效。');
  }
  assertInteger(value.attemptCount, 'body signal attemptCount');
  assertInteger(value.availableAt, 'body signal availableAt');
  if (value.leaseId !== null) assertLeaseId(value.leaseId);
  assertNullableInteger(
    value.leaseExpiresAt,
    'body signal leaseExpiresAt',
  );
  assertInteger(value.createdAt, 'body signal createdAt');
  assertInteger(value.updatedAt, 'body signal updatedAt');
}

export function materializeBodySignalHealthMutation(
  entry: BodySignalHealthDomainOutboxEntry,
): PlainMutationV1 {
  assertBodySignalHealthDomainOutboxEntry(entry);
  if (entry.sourceSequence === null) {
    throw new Error(
      'body-signal.health outbox 尚未分配 sourceSequence。',
    );
  }
  const payload = entry.payload as BodySignalHealthPayloadV1;
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: entry.mutationId,
    vaultId: entry.vaultId,
    sourceDeviceId: entry.sourceDeviceId,
    sourceSequence: entry.sourceSequence,
    createdAt: entry.createdAt,
    entity: {
      domain: 'body-signal',
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
    retentionClass: payload.kind === 'body-signal-reading'
      ? BODY_SIGNAL_RAW_RETENTION_CLASS
      : BODY_SIGNAL_DERIVED_RETENTION_CLASS,
  };
  assertBodySignalHealthMutationV1(mutation);
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
  if (/schema|payload|entity|mutation|body.signal/iu.test(raw)) {
    return 'invalid-body-signal-mutation';
  }
  return 'promotion-failed';
}

export async function promoteBodySignalHealthDomainOutbox(input: {
  identity: SyncDevicePublicIdentityV1;
  leaseId: string;
  now: number;
  limit: number;
  leaseDurationMs: number;
  domainOutbox: BodySignalHealthDomainOutboxPort;
  mutationState: Pick<
    SyncMutationStatePort,
    'allocateSyncSourceSequence'
  >;
  centralOutbox: {
    enqueueSyncMutation(mutation: PlainMutationV1): Promise<void>;
  };
}): Promise<PromoteBodySignalHealthOutboxReport> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (
    input.identity.state !== 'active'
    || input.identity.revokedAt !== null
  ) {
    throw new Error(
      '只有 active 且未撤销的设备可以搬运 body-signal.health outbox。',
    );
  }
  assertLeaseId(input.leaseId);
  assertInteger(input.now, 'body signal promotion now');
  assertInteger(input.limit, 'body signal promotion limit', 1);
  assertInteger(
    input.leaseDurationMs,
    'body signal leaseDurationMs',
    1,
  );
  const claimed = await input.domainOutbox.claimPending({
    leaseId: input.leaseId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    limit: input.limit,
  });
  const report: PromoteBodySignalHealthOutboxReport = {
    claimedCount: claimed.length,
    dispatchedCount: 0,
    failed: [],
  };
  for (const original of claimed) {
    let entry = original;
    try {
      assertBodySignalHealthDomainOutboxEntry(entry);
      if (
        entry.vaultId !== input.identity.vaultId
        || entry.sourceDeviceId !== input.identity.deviceId
      ) {
        throw new Error(
          'body signal outbox identity 与当前 active device 不一致。',
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
        materializeBodySignalHealthMutation(entry),
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
