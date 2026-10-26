import type * as SQLite from 'expo-sqlite';

import { freezeLegacyExecutionSessions } from '../schedule/taskExecutionStore';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  assertSyncDevicePublicIdentityV1,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  TODO_SEMANTIC_ADAPTER_ID,
} from './syncTodoSemantic';
import {
  TODO_SEMANTIC_BOOTSTRAP_INSERT_SQL,
} from './syncTodoSemanticBootstrapSql';
import {
  promoteTodoSemanticDomainOutbox,
  type PromoteTodoSemanticOutboxReport,
} from './syncTodoSemanticOutbox';
import {
  deactivateTodoSemanticCapture,
  ensureTodoSemanticCaptureSchema,
  recoverExpiredTodoSemanticOutboxLeases,
  todoSemanticDomainOutboxPort,
} from './syncTodoSemanticSqlitePort';
import {
  TODO_SEMANTIC_CAPTURE_LEASE_MS,
} from './syncTodoSemanticSql';
import {
  enqueueSyncMutationAndAdvanceHeads,
  syncMutationStatePort,
} from './syncMutationStateStore';

export const TODO_SEMANTIC_SQLITE_BOOTSTRAP_VERSION = 1 as const;

export type TodoSemanticSqliteBootstrapRuntimeResult =
  | {
      status: 'no-current-device';
      mutationCount: 0;
      captureEnabled: false;
    }
  | {
      status: 'already-complete' | 'completed';
      mutationCount: number;
      captureEnabled: true;
    };

export type TodoSemanticBootstrapRuntimeResult =
  TodoSemanticSqliteBootstrapRuntimeResult;

export type TodoSemanticPromotionRuntimeResult =
  | {
      status: 'no-current-device';
      recoveredLeaseCount: number;
      report: PromoteTodoSemanticOutboxReport;
    }
  | {
      status: 'completed' | 'partial-failure';
      recoveredLeaseCount: number;
      report: PromoteTodoSemanticOutboxReport;
    };

type RuntimeRow = {
  capture_enabled: number;
  suppress_capture: number;
  vault_id: string | null;
  source_device_id: string | null;
};

type BootstrapStateRow = {
  completed_at: number;
};

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

async function latestLocalSequence(
  transaction: SQLite.SQLiteDatabase,
) {
  const row = await transaction.getFirstAsync<{ value: number | null }>(
    'SELECT MAX(local_sequence) AS value FROM todo_sync_domain_outbox',
  );
  return row?.value ?? 0;
}

async function advanceBootstrapHeads(input: {
  transaction: SQLite.SQLiteDatabase;
  afterSequence: number;
  throughSequence: number;
  updatedAt: number;
}) {
  if (input.throughSequence <= input.afterSequence) return;
  const excessiveParents =
    await input.transaction.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM todo_sync_domain_outbox
       WHERE local_sequence > ?
         AND local_sequence <= ?
         AND json_array_length(parent_revision_ids_json) > 32`,
      input.afterSequence,
      input.throughSequence,
    );
  if ((excessiveParents?.count ?? 0) > 0) {
    throw new Error(
      'todo.semantic bootstrap entity heads 超过协议上限。',
    );
  }
  await input.transaction.runAsync(
    `INSERT OR IGNORE INTO todo_sync_entity_heads (
       entity_type, entity_id, revision_id, updated_at
     )
     SELECT entity_type, entity_id, revision_id, ?
     FROM todo_sync_domain_outbox
     WHERE local_sequence > ? AND local_sequence <= ?`,
    input.updatedAt,
    input.afterSequence,
    input.throughSequence,
  );
}

async function snapshotTodoBusinessRows(input: {
  transaction: SQLite.SQLiteDatabase;
  now: number;
}) {
  let mutationCount = 0;
  for (const statement of TODO_SEMANTIC_BOOTSTRAP_INSERT_SQL) {
    const before = await latestLocalSequence(input.transaction);
    const result = await input.transaction.runAsync(
      statement,
      input.now,
      input.now,
      input.now,
    );
    const after = await latestLocalSequence(input.transaction);
    if (after - before !== result.changes) {
      throw new Error(
        'todo.semantic bootstrap outbox 序列增量校验失败。',
      );
    }
    await advanceBootstrapHeads({
      transaction: input.transaction,
      afterSequence: before,
      throughSequence: after,
      updatedAt: input.now,
    });
    mutationCount += result.changes;
  }
  return mutationCount;
}

export async function bootstrapTodoSemanticSqliteForIdentity(input: {
  identity: SyncDevicePublicIdentityV1;
  now: number;
}): Promise<TodoSemanticSqliteBootstrapRuntimeResult> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (
    input.identity.state !== 'active'
    || input.identity.revokedAt !== null
  ) {
    throw new Error(
      '只有 active 且未撤销的设备可以 bootstrap todo.semantic。',
    );
  }
  assertTimestamp(input.now, 'todo.semantic SQLite bootstrap now');
  const database = await ensureTodoSemanticCaptureSchema();
  let status: 'already-complete' | 'completed' = 'completed';
  let mutationCount = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const runtime = await transaction.getFirstAsync<RuntimeRow>(
      `SELECT capture_enabled, suppress_capture, vault_id, source_device_id
       FROM todo_sync_runtime
       WHERE singleton_id = 1`,
    );
    if (
      runtime?.capture_enabled === 1
      && (
        runtime.vault_id !== input.identity.vaultId
        || runtime.source_device_id !== input.identity.deviceId
      )
    ) {
      throw new Error(
        'todo.semantic 已绑定另一 active vault/device，拒绝静默换绑。',
      );
    }
    if (runtime?.suppress_capture === 1) {
      throw new Error(
        'todo.semantic 正在应用远端变更，不能同时执行 bootstrap。',
      );
    }
    await transaction.runAsync(
      `UPDATE todo_sync_runtime
       SET capture_enabled = 0,
           suppress_capture = 0,
           vault_id = ?,
           source_device_id = ?,
           updated_at = ?
       WHERE singleton_id = 1`,
      input.identity.vaultId,
      input.identity.deviceId,
      input.now,
    );
    const completed = await transaction.getFirstAsync<BootstrapStateRow>(
      `SELECT completed_at
       FROM todo_sync_bootstrap_state
       WHERE adapter_id = ?
         AND bootstrap_version = ?
         AND vault_id = ?
         AND source_device_id = ?`,
      TODO_SEMANTIC_ADAPTER_ID,
      TODO_SEMANTIC_SQLITE_BOOTSTRAP_VERSION,
      input.identity.vaultId,
      input.identity.deviceId,
    );
    if (completed) {
      status = 'already-complete';
    } else {
      mutationCount = await snapshotTodoBusinessRows({
        transaction,
        now: input.now,
      });
      await transaction.runAsync(
        `INSERT INTO todo_sync_bootstrap_state (
           adapter_id, bootstrap_version, vault_id,
           source_device_id, completed_at
         ) VALUES (?, ?, ?, ?, ?)`,
        TODO_SEMANTIC_ADAPTER_ID,
        TODO_SEMANTIC_SQLITE_BOOTSTRAP_VERSION,
        input.identity.vaultId,
        input.identity.deviceId,
        input.now,
      );
    }
    await transaction.runAsync(
      `UPDATE todo_sync_runtime
       SET capture_enabled = 1,
           suppress_capture = 0,
           vault_id = ?,
           source_device_id = ?,
           updated_at = ?
       WHERE singleton_id = 1`,
      input.identity.vaultId,
      input.identity.deviceId,
      input.now,
    );
  });
  return {
    status,
    mutationCount,
    captureEnabled: true,
  };
}

export async function runTodoSemanticBootstrapRuntime(
  now = Date.now(),
): Promise<TodoSemanticBootstrapRuntimeResult> {
  assertTimestamp(now, 'todo.semantic runtime now');
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    await deactivateTodoSemanticCapture(now);
    return {
      status: 'no-current-device',
      mutationCount: 0,
      captureEnabled: false,
    };
  }
  await deactivateTodoSemanticCapture(now);
  await freezeLegacyExecutionSessions(now);
  return bootstrapTodoSemanticSqliteForIdentity({
    identity: currentDevice.identity,
    now,
  });
}

function emptyPromotionReport(): PromoteTodoSemanticOutboxReport {
  return {
    claimedCount: 0,
    dispatchedCount: 0,
    failed: [],
  };
}

export async function runTodoSemanticOutboxPromotionRuntime(input: {
  limit?: number;
  now?: number;
} = {}): Promise<TodoSemanticPromotionRuntimeResult> {
  const now = input.now ?? Date.now();
  assertTimestamp(now, 'todo.semantic promotion now');
  const recoveredLeaseCount =
    await recoverExpiredTodoSemanticOutboxLeases(now);
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      recoveredLeaseCount,
      report: emptyPromotionReport(),
    };
  }
  const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
  const report = await promoteTodoSemanticDomainOutbox({
    identity: currentDevice.identity,
    leaseId: `todo-semantic:${expoSyncRandomUuidV1()}`,
    now,
    limit: input.limit ?? 100,
    leaseDurationMs: TODO_SEMANTIC_CAPTURE_LEASE_MS,
    domainOutbox: todoSemanticDomainOutboxPort,
    mutationState: syncMutationStatePort,
    centralOutbox: {
      enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
    },
  });
  return {
    status: report.failed.length ? 'partial-failure' : 'completed',
    recoveredLeaseCount,
    report,
  };
}
