import {
  assertSyncDevicePublicIdentityV1,
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  assertMemoryRecordPayload,
  assertMemoryRecordsMutationV1,
  isRetiredStayMemoryRecordPayload,
  MEMORY_RECORD_ENTITY_SPECS,
  MEMORY_RECORDS_RETENTION_CLASS,
  MEMORY_RECORDS_SCHEMA_VERSION,
  getMemoryRecordObjectRefs,
  type MemoryRecordEntityType,
} from './syncMemoryRecords';
import type {
  SyncMutationStatePort,
} from './syncMutationEnvelope';
import {
  assertJsonValue,
  getSyncEntityIdMaximumLength,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export type MemoryRecordsOutboxState =
  | 'pending'
  | 'leased'
  | 'dispatched'
  | 'quarantined';

export type MemoryRecordsDomainOutboxEntry = {
  localSequence: number;
  mutationId: string;
  revisionId: string;
  parentRevisionIds: string[];
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number | null;
  entityType: MemoryRecordEntityType;
  entityId: string;
  operation: SyncOperation;
  schemaVersion: number;
  payload: JsonValue;
  state: MemoryRecordsOutboxState;
  attemptCount: number;
  availableAt: number;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ClaimedMemoryRecordsOutboxEntry = MemoryRecordsDomainOutboxEntry & {
  state: 'leased';
  leaseId: string;
  leaseExpiresAt: number;
};

export interface MemoryRecordsDomainOutboxPort {
  claimPending(input: {
    leaseId: string;
    now: number;
    leaseDurationMs: number;
    limit: number;
  }): Promise<ClaimedMemoryRecordsOutboxEntry[]>;
  reserveSourceSequence(input: {
    localSequence: number;
    leaseId: string;
    sourceSequence: number;
    updatedAt: number;
  }): Promise<ClaimedMemoryRecordsOutboxEntry>;
  prepareObjects?(entry: ClaimedMemoryRecordsOutboxEntry, now: number): Promise<ClaimedMemoryRecordsOutboxEntry>;
  shouldSuppressOutbound(entry: ClaimedMemoryRecordsOutboxEntry): Promise<boolean>;
  markSuppressed(input: {
    localSequence: number;
    leaseId: string;
    suppressedAt: number;
  }): Promise<void>;
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

export interface MemoryRecordsCentralOutboxPort {
  enqueueSyncMutation(mutation: PlainMutationV1): Promise<void>;
}

export type PromoteMemoryRecordsOutboxReport = {
  claimedCount: number;
  dispatchedCount: number;
  failed: Array<{
    localSequence: number;
    errorCode: string;
  }>;
};

const OPERATIONS = new Set<SyncOperation>(['upsert', 'delete', 'restore', 'append']);
const ENTITY_TYPES = new Set<MemoryRecordEntityType>(
  MEMORY_RECORD_ENTITY_SPECS.map((spec) => spec.entityType),
);
const STATES = new Set<MemoryRecordsOutboxState>([
  'pending',
  'leased',
  'dispatched',
  'quarantined',
]);
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function assertSafeInteger(value: unknown, label: string, minimum = 0): asserts value is number {
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

function assertToken(value: unknown, label: string, maximumLength = 160): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
    || !/^[a-z0-9][a-z0-9._-]*$/.test(value)
  ) {
    throw new Error(`${label} 格式无效。`);
  }
}

export function assertMemoryRecordsDomainOutboxEntry(
  value: MemoryRecordsDomainOutboxEntry,
) {
  assertSafeInteger(value.localSequence, 'memory outbox localSequence', 1);
  assertSyncUuidV4(value.mutationId, 'memory outbox mutationId');
  assertSyncUuidV4(value.revisionId, 'memory outbox revisionId');
  if (!Array.isArray(value.parentRevisionIds) || value.parentRevisionIds.length > 32) {
    throw new Error('memory outbox parentRevisionIds 必须是最多 32 项的数组。');
  }
  value.parentRevisionIds.forEach((id, index) => (
    assertSyncUuidV4(id, `memory outbox parentRevisionIds[${index}]`)
  ));
  if (new Set(value.parentRevisionIds).size !== value.parentRevisionIds.length) {
    throw new Error('memory outbox parentRevisionIds 不能重复。');
  }
  assertSyncUuidV4(value.vaultId, 'memory outbox vaultId');
  assertSyncUuidV4(value.sourceDeviceId, 'memory outbox sourceDeviceId');
  assertNullableSafeInteger(value.sourceSequence, 'memory outbox sourceSequence', 1);
  if (!ENTITY_TYPES.has(value.entityType)) {
    throw new Error('memory outbox entityType 无效。');
  }
  if (
    typeof value.entityId !== 'string'
    || value.entityId.length < 1
    || value.entityId.length > getSyncEntityIdMaximumLength('memory', value.entityType)
  ) {
    throw new Error('memory outbox entityId 长度无效。');
  }
  if (!OPERATIONS.has(value.operation)) {
    throw new Error('memory outbox operation 无效。');
  }
  if (
    value.schemaVersion !== 1
    && value.schemaVersion !== 2
    && value.schemaVersion !== 3
    && value.schemaVersion !== 4
    && value.schemaVersion !== MEMORY_RECORDS_SCHEMA_VERSION
    && value.schemaVersion !== 6
    && value.schemaVersion !== 9
    && value.schemaVersion !== 10
    && value.schemaVersion !== 7
    && value.schemaVersion !== 8
  ) {
    throw new Error('memory outbox schemaVersion 无效。');
  }
  assertJsonValue(value.payload);
  assertMemoryRecordPayload(value.entityType, value.operation, value.payload);
  const payloadSchemaVersion = value.payload
    && typeof value.payload === 'object'
    && !Array.isArray(value.payload)
    ? (value.payload as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (payloadSchemaVersion !== value.schemaVersion) {
    throw new Error('memory outbox 与 payload schemaVersion 不一致。');
  }
  if (!STATES.has(value.state)) {
    throw new Error('memory outbox state 无效。');
  }
  assertSafeInteger(value.attemptCount, 'memory outbox attemptCount');
  assertSafeInteger(value.availableAt, 'memory outbox availableAt');
  if (value.leaseId !== null && (
    !value.leaseId
    || value.leaseId.length > 160
    || !/^[A-Za-z0-9._:-]+$/.test(value.leaseId)
  )) {
    throw new Error('memory outbox leaseId 格式无效。');
  }
  assertNullableSafeInteger(value.leaseExpiresAt, 'memory outbox leaseExpiresAt');
  assertSafeInteger(value.createdAt, 'memory outbox createdAt');
  assertSafeInteger(value.updatedAt, 'memory outbox updatedAt');
}

export function materializeMemoryRecordsMutation(
  entry: MemoryRecordsDomainOutboxEntry,
): PlainMutationV1 {
  assertMemoryRecordsDomainOutboxEntry(entry);
  if (isRetiredStayMemoryRecordPayload(entry.entityType, entry.payload)) {
    throw new Error('memory outbox 不外发已退役 stay 记录。');
  }
  if (entry.sourceSequence === null) {
    throw new Error('memory outbox 尚未分配 sourceSequence。');
  }
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: entry.mutationId,
    vaultId: entry.vaultId,
    sourceDeviceId: entry.sourceDeviceId,
    sourceSequence: entry.sourceSequence,
    createdAt: entry.createdAt,
    entity: {
      domain: 'memory',
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
    objectRefs: getMemoryRecordObjectRefs(entry.payload),
    retentionClass: MEMORY_RECORDS_RETENTION_CLASS,
  };
  assertMemoryRecordsMutationV1(mutation);
  return mutation;
}

function errorCodeOf(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  if (/heads 已变化|latest heads|entity heads/i.test(raw)) return 'entity-heads-changed';
  if (/identity|device|vault|撤销|active/i.test(raw)) return 'device-identity-invalid';
  if (/schema|payload|entity|mutation/i.test(raw)) return 'invalid-memory-mutation';
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
    throw new Error('只有 active 且未撤销的本机设备可以搬运 memory outbox。');
  }
  if (!input.leaseId || input.leaseId.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(input.leaseId)) {
    throw new Error('memory outbox leaseId 格式无效。');
  }
  assertSafeInteger(input.now, 'memory outbox promotion now');
  assertSafeInteger(input.limit, 'memory outbox promotion limit', 1);
  assertSafeInteger(input.leaseDurationMs, 'memory outbox leaseDurationMs', 1);
}

export async function promoteMemoryRecordsDomainOutbox(input: {
  identity: SyncDevicePublicIdentityV1;
  leaseId: string;
  now: number;
  limit: number;
  leaseDurationMs: number;
  domainOutbox: MemoryRecordsDomainOutboxPort;
  mutationState: Pick<SyncMutationStatePort, 'allocateSyncSourceSequence'>;
  centralOutbox: MemoryRecordsCentralOutboxPort;
}): Promise<PromoteMemoryRecordsOutboxReport> {
  assertPromotionInput(input);
  const claimed = await input.domainOutbox.claimPending({
    leaseId: input.leaseId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    limit: input.limit,
  });
  const report: PromoteMemoryRecordsOutboxReport = {
    claimedCount: claimed.length,
    dispatchedCount: 0,
    failed: [],
  };
  for (const originalEntry of claimed) {
    let entry = originalEntry;
    try {
      assertMemoryRecordsDomainOutboxEntry(entry);
      if (
        entry.vaultId !== input.identity.vaultId
        || entry.sourceDeviceId !== input.identity.deviceId
      ) {
        throw new Error('memory outbox identity 与当前 active device 不一致。');
      }
      if (
        isRetiredStayMemoryRecordPayload(entry.entityType, entry.payload)
        || await input.domainOutbox.shouldSuppressOutbound(entry)
      ) {
        await input.domainOutbox.markSuppressed({
          localSequence: entry.localSequence,
          leaseId: input.leaseId,
          suppressedAt: input.now,
        });
        continue;
      }
      if (input.domainOutbox.prepareObjects) entry = await input.domainOutbox.prepareObjects(entry, input.now);
      if (entry.sourceSequence === null) {
        const sourceSequence = await input.mutationState.allocateSyncSourceSequence(
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
      const mutation = materializeMemoryRecordsMutation(entry);
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
        throw new Error('memory outbox errorCode 内部格式无效。');
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
