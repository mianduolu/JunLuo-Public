import {
  assertSyncDevicePublicIdentityV1,
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type { SyncMutationStatePort } from './syncMutationEnvelope';
import {
  assertScheduleSemanticMutationV1,
  assertScheduleSemanticPayload,
  isScheduleSemanticEntityType,
  SCHEDULE_SEMANTIC_RETENTION_CLASS,
  SCHEDULE_SEMANTIC_SCHEMA_VERSION,
  type ScheduleSemanticEntityType,
} from './syncScheduleSemantic';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export type ScheduleSemanticOutboxState =
  | 'pending'
  | 'leased'
  | 'dispatched'
  | 'quarantined';

export type ScheduleSemanticDomainOutboxEntry = {
  localSequence: number;
  mutationId: string;
  revisionId: string;
  parentRevisionIds: string[];
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number | null;
  entityType: ScheduleSemanticEntityType;
  entityId: string;
  operation: SyncOperation;
  schemaVersion: number;
  payload: JsonValue;
  state: ScheduleSemanticOutboxState;
  attemptCount: number;
  availableAt: number;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ClaimedScheduleSemanticOutboxEntry =
  ScheduleSemanticDomainOutboxEntry & {
    state: 'leased';
    leaseId: string;
    leaseExpiresAt: number;
  };

export interface ScheduleSemanticDomainOutboxPort {
  claimPending(input: {
    leaseId: string;
    now: number;
    leaseDurationMs: number;
    limit: number;
  }): Promise<ClaimedScheduleSemanticOutboxEntry[]>;
  reserveSourceSequence(input: {
    localSequence: number;
    leaseId: string;
    sourceSequence: number;
    updatedAt: number;
  }): Promise<ClaimedScheduleSemanticOutboxEntry>;
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

export interface ScheduleSemanticCentralOutboxPort {
  enqueueSyncMutation(mutation: PlainMutationV1): Promise<void>;
}

export type PromoteScheduleSemanticOutboxReport = {
  claimedCount: number;
  dispatchedCount: number;
  failed: Array<{
    localSequence: number;
    errorCode: string;
  }>;
};

const OPERATIONS = new Set<SyncOperation>([
  'upsert',
  'delete',
  'restore',
  'append',
]);
const STATES = new Set<ScheduleSemanticOutboxState>([
  'pending',
  'leased',
  'dispatched',
  'quarantined',
]);
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function assertSafeInteger(
  value: unknown,
  label: string,
  minimum = 0,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} 必须是大于等于 ${minimum} 的安全整数。`);
  }
}

function assertNullableSafeInteger(
  value: unknown,
  label: string,
  minimum = 0,
): asserts value is number | null {
  if (value === null) return;
  assertSafeInteger(value, label, minimum);
}

export function assertScheduleSemanticDomainOutboxEntry(
  value: ScheduleSemanticDomainOutboxEntry,
) {
  assertSafeInteger(value.localSequence, 'schedule outbox localSequence', 1);
  assertSyncUuidV4(value.mutationId, 'schedule outbox mutationId');
  assertSyncUuidV4(value.revisionId, 'schedule outbox revisionId');
  if (
    !Array.isArray(value.parentRevisionIds)
    || value.parentRevisionIds.length > 32
  ) {
    throw new Error('schedule outbox parentRevisionIds 必须是最多 32 项的数组。');
  }
  value.parentRevisionIds.forEach((id, index) => (
    assertSyncUuidV4(id, `schedule outbox parentRevisionIds[${index}]`)
  ));
  if (new Set(value.parentRevisionIds).size !== value.parentRevisionIds.length) {
    throw new Error('schedule outbox parentRevisionIds 不能重复。');
  }
  assertSyncUuidV4(value.vaultId, 'schedule outbox vaultId');
  assertSyncUuidV4(value.sourceDeviceId, 'schedule outbox sourceDeviceId');
  assertNullableSafeInteger(
    value.sourceSequence,
    'schedule outbox sourceSequence',
    1,
  );
  if (!isScheduleSemanticEntityType(value.entityType)) {
    throw new Error('schedule outbox entityType 无效。');
  }
  if (
    typeof value.entityId !== 'string'
    || value.entityId.length < 1
    || value.entityId.length > 256
  ) {
    throw new Error('schedule outbox entityId 长度无效。');
  }
  if (!OPERATIONS.has(value.operation)) {
    throw new Error('schedule outbox operation 无效。');
  }
  if (value.schemaVersion !== SCHEDULE_SEMANTIC_SCHEMA_VERSION) {
    throw new Error('schedule outbox schemaVersion 无效。');
  }
  assertJsonValue(value.payload);
  assertScheduleSemanticPayload(
    value.entityType,
    value.entityId,
    value.operation,
    value.payload,
  );
  if (!STATES.has(value.state)) {
    throw new Error('schedule outbox state 无效。');
  }
  assertSafeInteger(value.attemptCount, 'schedule outbox attemptCount');
  assertSafeInteger(value.availableAt, 'schedule outbox availableAt');
  if (
    value.leaseId !== null
    && (
      !value.leaseId
      || value.leaseId.length > 160
      || !/^[A-Za-z0-9._:-]+$/.test(value.leaseId)
    )
  ) {
    throw new Error('schedule outbox leaseId 格式无效。');
  }
  assertNullableSafeInteger(
    value.leaseExpiresAt,
    'schedule outbox leaseExpiresAt',
  );
  assertSafeInteger(value.createdAt, 'schedule outbox createdAt');
  assertSafeInteger(value.updatedAt, 'schedule outbox updatedAt');
}

export function materializeScheduleSemanticMutation(
  entry: ScheduleSemanticDomainOutboxEntry,
): PlainMutationV1 {
  assertScheduleSemanticDomainOutboxEntry(entry);
  if (entry.sourceSequence === null) {
    throw new Error('schedule outbox 尚未分配 sourceSequence。');
  }
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: entry.mutationId,
    vaultId: entry.vaultId,
    sourceDeviceId: entry.sourceDeviceId,
    sourceSequence: entry.sourceSequence,
    createdAt: entry.createdAt,
    entity: {
      domain: 'schedule',
      type: entry.entityType,
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
    retentionClass: SCHEDULE_SEMANTIC_RETENTION_CLASS,
  };
  assertScheduleSemanticMutationV1(mutation);
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
  if (/schema|payload|entity|mutation/i.test(raw)) {
    return 'invalid-schedule-mutation';
  }
  return 'promotion-failed';
}

function assertPromotionInput(input: {
  identity: SyncDevicePublicIdentityV1;
  leaseId: string;
  now: number;
  limit: number;
  leaseDurationMs: number;
}) {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (input.identity.state !== 'active' || input.identity.revokedAt !== null) {
    throw new Error('只有 active 且未撤销的设备可以搬运 schedule outbox。');
  }
  if (
    !input.leaseId
    || input.leaseId.length > 160
    || !/^[A-Za-z0-9._:-]+$/.test(input.leaseId)
  ) {
    throw new Error('schedule outbox leaseId 格式无效。');
  }
  assertSafeInteger(input.now, 'schedule outbox promotion now');
  assertSafeInteger(input.limit, 'schedule outbox promotion limit', 1);
  assertSafeInteger(
    input.leaseDurationMs,
    'schedule outbox leaseDurationMs',
    1,
  );
}

export async function promoteScheduleSemanticDomainOutbox(input: {
  identity: SyncDevicePublicIdentityV1;
  leaseId: string;
  now: number;
  limit: number;
  leaseDurationMs: number;
  domainOutbox: ScheduleSemanticDomainOutboxPort;
  mutationState: Pick<SyncMutationStatePort, 'allocateSyncSourceSequence'>;
  centralOutbox: ScheduleSemanticCentralOutboxPort;
}): Promise<PromoteScheduleSemanticOutboxReport> {
  assertPromotionInput(input);
  const claimed = await input.domainOutbox.claimPending({
    leaseId: input.leaseId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    limit: input.limit,
  });
  const report: PromoteScheduleSemanticOutboxReport = {
    claimedCount: claimed.length,
    dispatchedCount: 0,
    failed: [],
  };
  for (const originalEntry of claimed) {
    let entry = originalEntry;
    try {
      assertScheduleSemanticDomainOutboxEntry(entry);
      if (
        entry.vaultId !== input.identity.vaultId
        || entry.sourceDeviceId !== input.identity.deviceId
      ) {
        throw new Error(
          'schedule outbox identity 与当前 active device 不一致。',
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
      const mutation = materializeScheduleSemanticMutation(entry);
      await input.centralOutbox.enqueueSyncMutation(mutation);
      await input.domainOutbox.markDispatched({
        localSequence: entry.localSequence,
        leaseId: input.leaseId,
        dispatchedAt: input.now,
      });
      report.dispatchedCount += 1;
    } catch (error) {
      const errorCode = errorCodeOf(error);
      if (!ERROR_CODE_PATTERN.test(errorCode)) {
        throw new Error('schedule outbox errorCode 内部格式无效。');
      }
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
