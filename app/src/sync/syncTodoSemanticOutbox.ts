import {
  assertSyncDevicePublicIdentityV1,
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type { SyncMutationStatePort } from './syncMutationEnvelope';
import {
  assertTodoSemanticMutationV1,
  assertTodoSemanticPayload,
  isTodoSemanticEntityType,
  TODO_SEMANTIC_RETENTION_CLASS,
  TODO_SEMANTIC_SCHEMA_VERSION,
  type TodoSemanticEntityType,
} from './syncTodoSemantic';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export type TodoSemanticOutboxState =
  | 'pending'
  | 'leased'
  | 'dispatched'
  | 'quarantined';

export type TodoSemanticDomainOutboxEntry = {
  localSequence: number;
  mutationId: string;
  revisionId: string;
  parentRevisionIds: string[];
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number | null;
  entityType: TodoSemanticEntityType;
  entityId: string;
  operation: SyncOperation;
  schemaVersion: number;
  payload: JsonValue;
  state: TodoSemanticOutboxState;
  attemptCount: number;
  availableAt: number;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ClaimedTodoSemanticOutboxEntry =
  TodoSemanticDomainOutboxEntry & {
    state: 'leased';
    leaseId: string;
    leaseExpiresAt: number;
  };

export interface TodoSemanticDomainOutboxPort {
  claimPending(input: {
    leaseId: string;
    now: number;
    leaseDurationMs: number;
    limit: number;
  }): Promise<ClaimedTodoSemanticOutboxEntry[]>;
  reserveSourceSequence(input: {
    localSequence: number;
    leaseId: string;
    sourceSequence: number;
    updatedAt: number;
  }): Promise<ClaimedTodoSemanticOutboxEntry>;
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

export interface TodoSemanticCentralOutboxPort {
  enqueueSyncMutation(mutation: PlainMutationV1): Promise<void>;
}

export type PromoteTodoSemanticOutboxReport = {
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
]);
const STATES = new Set<TodoSemanticOutboxState>([
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
) {
  if (value === null) return;
  assertSafeInteger(value, label, minimum);
}

export function assertTodoSemanticDomainOutboxEntry(
  value: TodoSemanticDomainOutboxEntry,
) {
  assertSafeInteger(value.localSequence, 'todo outbox localSequence', 1);
  assertSyncUuidV4(value.mutationId, 'todo outbox mutationId');
  assertSyncUuidV4(value.revisionId, 'todo outbox revisionId');
  if (
    !Array.isArray(value.parentRevisionIds)
    || value.parentRevisionIds.length > 32
  ) {
    throw new Error('todo outbox parentRevisionIds 必须是最多 32 项的数组。');
  }
  value.parentRevisionIds.forEach((id, index) => (
    assertSyncUuidV4(id, `todo outbox parentRevisionIds[${index}]`)
  ));
  if (new Set(value.parentRevisionIds).size !== value.parentRevisionIds.length) {
    throw new Error('todo outbox parentRevisionIds 不能重复。');
  }
  assertSyncUuidV4(value.vaultId, 'todo outbox vaultId');
  assertSyncUuidV4(value.sourceDeviceId, 'todo outbox sourceDeviceId');
  assertNullableSafeInteger(
    value.sourceSequence,
    'todo outbox sourceSequence',
    1,
  );
  if (!isTodoSemanticEntityType(value.entityType)) {
    throw new Error('todo outbox entityType 无效。');
  }
  if (
    typeof value.entityId !== 'string'
    || value.entityId.length < 1
    || value.entityId.length > 256
  ) {
    throw new Error('todo outbox entityId 长度无效。');
  }
  if (!OPERATIONS.has(value.operation)) {
    throw new Error('todo outbox operation 无效。');
  }
  if (value.schemaVersion !== TODO_SEMANTIC_SCHEMA_VERSION) {
    throw new Error('todo outbox schemaVersion 无效。');
  }
  assertJsonValue(value.payload);
  assertTodoSemanticPayload(
    value.entityType,
    value.entityId,
    value.operation,
    value.payload,
  );
  if (!STATES.has(value.state)) {
    throw new Error('todo outbox state 无效。');
  }
  assertSafeInteger(value.attemptCount, 'todo outbox attemptCount');
  assertSafeInteger(value.availableAt, 'todo outbox availableAt');
  if (
    value.leaseId !== null
    && (
      !value.leaseId
      || value.leaseId.length > 160
      || !/^[A-Za-z0-9._:-]+$/.test(value.leaseId)
    )
  ) {
    throw new Error('todo outbox leaseId 格式无效。');
  }
  assertNullableSafeInteger(
    value.leaseExpiresAt,
    'todo outbox leaseExpiresAt',
  );
  assertSafeInteger(value.createdAt, 'todo outbox createdAt');
  assertSafeInteger(value.updatedAt, 'todo outbox updatedAt');
}

export function materializeTodoSemanticMutation(
  entry: TodoSemanticDomainOutboxEntry,
): PlainMutationV1 {
  assertTodoSemanticDomainOutboxEntry(entry);
  if (entry.sourceSequence === null) {
    throw new Error('todo outbox 尚未分配 sourceSequence。');
  }
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: entry.mutationId,
    vaultId: entry.vaultId,
    sourceDeviceId: entry.sourceDeviceId,
    sourceSequence: entry.sourceSequence,
    createdAt: entry.createdAt,
    entity: {
      domain: 'todo',
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
    retentionClass: TODO_SEMANTIC_RETENTION_CLASS,
  };
  assertTodoSemanticMutationV1(mutation);
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
    return 'invalid-todo-mutation';
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
    throw new Error('只有 active 且未撤销的设备可以搬运 todo outbox。');
  }
  if (
    !input.leaseId
    || input.leaseId.length > 160
    || !/^[A-Za-z0-9._:-]+$/.test(input.leaseId)
  ) {
    throw new Error('todo outbox leaseId 格式无效。');
  }
  assertSafeInteger(input.now, 'todo outbox promotion now');
  assertSafeInteger(input.limit, 'todo outbox promotion limit', 1);
  assertSafeInteger(
    input.leaseDurationMs,
    'todo outbox leaseDurationMs',
    1,
  );
}

export async function promoteTodoSemanticDomainOutbox(input: {
  identity: SyncDevicePublicIdentityV1;
  leaseId: string;
  now: number;
  limit: number;
  leaseDurationMs: number;
  domainOutbox: TodoSemanticDomainOutboxPort;
  mutationState: Pick<SyncMutationStatePort, 'allocateSyncSourceSequence'>;
  centralOutbox: TodoSemanticCentralOutboxPort;
}): Promise<PromoteTodoSemanticOutboxReport> {
  assertPromotionInput(input);
  const claimed = await input.domainOutbox.claimPending({
    leaseId: input.leaseId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    limit: input.limit,
  });
  const report: PromoteTodoSemanticOutboxReport = {
    claimedCount: claimed.length,
    dispatchedCount: 0,
    failed: [],
  };
  for (const originalEntry of claimed) {
    let entry = originalEntry;
    try {
      assertTodoSemanticDomainOutboxEntry(entry);
      if (
        entry.vaultId !== input.identity.vaultId
        || entry.sourceDeviceId !== input.identity.deviceId
      ) {
        throw new Error(
          'todo outbox identity 与当前 active device 不一致。',
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
      const mutation = materializeTodoSemanticMutation(entry);
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
        throw new Error('todo outbox errorCode 内部格式无效。');
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
