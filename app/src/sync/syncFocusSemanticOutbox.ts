import {
  assertSyncDevicePublicIdentityV1,
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type { SyncMutationStatePort } from './syncMutationEnvelope';
import {
  assertFocusSemanticMutationV1,
  assertFocusSemanticPayload,
  isFocusSemanticEntityType,
  FOCUS_SEMANTIC_RETENTION_CLASS,
  FOCUS_SEMANTIC_SCHEMA_VERSION,
  type FocusSemanticEntityType,
} from './syncFocusSemantic';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export type FocusSemanticOutboxState =
  | 'pending'
  | 'leased'
  | 'dispatched'
  | 'quarantined';

export type FocusSemanticDomainOutboxEntry = {
  localSequence: number;
  mutationId: string;
  revisionId: string;
  parentRevisionIds: string[];
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number | null;
  entityType: FocusSemanticEntityType;
  entityId: string;
  operation: SyncOperation;
  schemaVersion: number;
  payload: JsonValue;
  state: FocusSemanticOutboxState;
  attemptCount: number;
  availableAt: number;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ClaimedFocusSemanticOutboxEntry =
  FocusSemanticDomainOutboxEntry & {
    state: 'leased';
    leaseId: string;
    leaseExpiresAt: number;
  };

export interface FocusSemanticDomainOutboxPort {
  claimPending(input: {
    leaseId: string;
    now: number;
    leaseDurationMs: number;
    limit: number;
  }): Promise<ClaimedFocusSemanticOutboxEntry[]>;
  reserveSourceSequence(input: {
    localSequence: number;
    leaseId: string;
    sourceSequence: number;
    updatedAt: number;
  }): Promise<ClaimedFocusSemanticOutboxEntry>;
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

export type PromoteFocusSemanticOutboxReport = {
  claimedCount: number;
  dispatchedCount: number;
  failed: Array<{ localSequence: number; errorCode: string }>;
};

const OPERATIONS = new Set<SyncOperation>(['upsert', 'delete', 'restore']);
const STATES = new Set<FocusSemanticOutboxState>([
  'pending',
  'leased',
  'dispatched',
  'quarantined',
]);

function assertInteger(value: unknown, label: string, minimum = 0) {
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
  if (!value || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error('focus outbox leaseId 格式无效。');
  }
}

export function assertFocusSemanticDomainOutboxEntry(
  value: FocusSemanticDomainOutboxEntry,
) {
  assertInteger(value.localSequence, 'focus outbox localSequence', 1);
  assertSyncUuidV4(value.mutationId, 'focus outbox mutationId');
  assertSyncUuidV4(value.revisionId, 'focus outbox revisionId');
  if (
    !Array.isArray(value.parentRevisionIds)
    || value.parentRevisionIds.length > 32
  ) {
    throw new Error('focus outbox parentRevisionIds 必须是最多 32 项。');
  }
  value.parentRevisionIds.forEach((id, index) => (
    assertSyncUuidV4(id, `focus outbox parentRevisionIds[${index}]`)
  ));
  if (new Set(value.parentRevisionIds).size !== value.parentRevisionIds.length) {
    throw new Error('focus outbox parentRevisionIds 不能重复。');
  }
  assertSyncUuidV4(value.vaultId, 'focus outbox vaultId');
  assertSyncUuidV4(value.sourceDeviceId, 'focus outbox sourceDeviceId');
  assertNullableInteger(value.sourceSequence, 'focus sourceSequence', 1);
  if (!isFocusSemanticEntityType(value.entityType)) {
    throw new Error('focus outbox entityType 无效。');
  }
  if (!value.entityId || value.entityId.length > 256) {
    throw new Error('focus outbox entityId 长度无效。');
  }
  if (!OPERATIONS.has(value.operation)) {
    throw new Error('focus outbox operation 无效。');
  }
  if (value.schemaVersion !== FOCUS_SEMANTIC_SCHEMA_VERSION) {
    throw new Error('focus outbox schemaVersion 无效。');
  }
  assertJsonValue(value.payload);
  assertFocusSemanticPayload(
    value.entityType,
    value.entityId,
    value.operation,
    value.payload,
  );
  if (!STATES.has(value.state)) {
    throw new Error('focus outbox state 无效。');
  }
  assertInteger(value.attemptCount, 'focus outbox attemptCount');
  assertInteger(value.availableAt, 'focus outbox availableAt');
  if (value.leaseId !== null) assertLeaseId(value.leaseId);
  assertNullableInteger(value.leaseExpiresAt, 'focus leaseExpiresAt');
  assertInteger(value.createdAt, 'focus outbox createdAt');
  assertInteger(value.updatedAt, 'focus outbox updatedAt');
}

export function materializeFocusSemanticMutation(
  entry: FocusSemanticDomainOutboxEntry,
): PlainMutationV1 {
  assertFocusSemanticDomainOutboxEntry(entry);
  if (entry.sourceSequence === null) {
    throw new Error('focus outbox 尚未分配 sourceSequence。');
  }
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: entry.mutationId,
    vaultId: entry.vaultId,
    sourceDeviceId: entry.sourceDeviceId,
    sourceSequence: entry.sourceSequence,
    createdAt: entry.createdAt,
    entity: {
      domain: 'focus',
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
    retentionClass: FOCUS_SEMANTIC_RETENTION_CLASS,
  };
  assertFocusSemanticMutationV1(mutation);
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
    return 'invalid-focus-mutation';
  }
  return 'promotion-failed';
}

export async function promoteFocusSemanticDomainOutbox(input: {
  identity: SyncDevicePublicIdentityV1;
  leaseId: string;
  now: number;
  limit: number;
  leaseDurationMs: number;
  domainOutbox: FocusSemanticDomainOutboxPort;
  mutationState: Pick<SyncMutationStatePort, 'allocateSyncSourceSequence'>;
  centralOutbox: { enqueueSyncMutation(mutation: PlainMutationV1): Promise<void> };
}): Promise<PromoteFocusSemanticOutboxReport> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (input.identity.state !== 'active' || input.identity.revokedAt !== null) {
    throw new Error('只有 active 且未撤销的设备可以搬运 focus outbox。');
  }
  assertLeaseId(input.leaseId);
  assertInteger(input.now, 'focus promotion now');
  assertInteger(input.limit, 'focus promotion limit', 1);
  assertInteger(input.leaseDurationMs, 'focus leaseDurationMs', 1);
  const claimed = await input.domainOutbox.claimPending({
    leaseId: input.leaseId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    limit: input.limit,
  });
  const report: PromoteFocusSemanticOutboxReport = {
    claimedCount: claimed.length,
    dispatchedCount: 0,
    failed: [],
  };
  for (const original of claimed) {
    let entry = original;
    try {
      assertFocusSemanticDomainOutboxEntry(entry);
      if (
        entry.vaultId !== input.identity.vaultId
        || entry.sourceDeviceId !== input.identity.deviceId
      ) {
        throw new Error('focus outbox identity 与当前 active device 不一致。');
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
        materializeFocusSemanticMutation(entry),
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
      report.failed.push({ localSequence: entry.localSequence, errorCode });
    }
  }
  return report;
}
