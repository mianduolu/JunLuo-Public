import type * as SQLite from 'expo-sqlite';

import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  assertSyncDevicePublicIdentityV1,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  FOCUS_SEMANTIC_ADAPTER_ID,
} from './syncFocusSemantic';
import {
  runFocusSemanticStorageBootstrapRuntime,
  type FocusSemanticStorageBootstrapRuntimeResult,
} from './syncFocusSemanticBootstrapRuntime';
import {
  disableFocusSemanticStorageCapture,
  enableFocusSemanticStorageCapture,
} from './syncFocusSemanticCaptureQueue';
import {
  FOCUS_SEMANTIC_BOOTSTRAP_INSERT_SQL,
} from './syncFocusSemanticBootstrapSql';
import {
  promoteFocusSemanticDomainOutbox,
  type PromoteFocusSemanticOutboxReport,
} from './syncFocusSemanticOutbox';
import {
  deactivateFocusSemanticCapture,
  ensureFocusSemanticCaptureSchema,
  focusSemanticDomainOutboxPort,
  recoverExpiredFocusSemanticOutboxLeases,
} from './syncFocusSemanticSqlitePort';
import {
  FOCUS_SEMANTIC_CAPTURE_LEASE_MS,
} from './syncFocusSemanticSql';
import {
  enqueueSyncMutationAndAdvanceHeads,
  syncMutationStatePort,
} from './syncMutationStateStore';

export const FOCUS_SEMANTIC_SQLITE_BOOTSTRAP_VERSION = 1 as const;

export type FocusSemanticSqliteBootstrapRuntimeResult =
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

export type FocusSemanticBootstrapRuntimeResult = {
  sqlite: FocusSemanticSqliteBootstrapRuntimeResult;
  storage: FocusSemanticStorageBootstrapRuntimeResult;
};

export type FocusSemanticPromotionRuntimeResult =
  | {
      status: 'no-current-device';
      recoveredLeaseCount: number;
      report: PromoteFocusSemanticOutboxReport;
    }
  | {
      status: 'completed' | 'partial-failure';
      recoveredLeaseCount: number;
      report: PromoteFocusSemanticOutboxReport;
    };

type RuntimeRow = {
  capture_enabled: number;
  suppress_capture: number;
  vault_id: string | null;
  source_device_id: string | null;
};

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

async function latestLocalSequence(transaction: SQLite.SQLiteDatabase) {
  const row = await transaction.getFirstAsync<{ value: number | null }>(
    'SELECT MAX(local_sequence) AS value FROM focus_sync_domain_outbox',
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
       FROM focus_sync_domain_outbox
       WHERE local_sequence > ?
         AND local_sequence <= ?
         AND json_array_length(parent_revision_ids_json) > 32`,
      input.afterSequence,
      input.throughSequence,
    );
  if ((excessiveParents?.count ?? 0) > 0) {
    throw new Error('focus.semantic bootstrap entity heads 超过协议上限。');
  }
  await input.transaction.runAsync(
    `INSERT OR IGNORE INTO focus_sync_entity_heads (
       entity_type, entity_id, revision_id, updated_at
     )
     SELECT entity_type, entity_id, revision_id, ?
     FROM focus_sync_domain_outbox
     WHERE local_sequence > ? AND local_sequence <= ?`,
    input.updatedAt,
    input.afterSequence,
    input.throughSequence,
  );
}

async function snapshotFocusRows(input: {
  transaction: SQLite.SQLiteDatabase;
  now: number;
}) {
  let mutationCount = 0;
  for (const statement of FOCUS_SEMANTIC_BOOTSTRAP_INSERT_SQL) {
    const before = await latestLocalSequence(input.transaction);
    const result = await input.transaction.runAsync(
      statement,
      input.now,
      input.now,
      input.now,
    );
    const after = await latestLocalSequence(input.transaction);
    if (after - before !== result.changes) {
      throw new Error('focus.semantic bootstrap outbox 序列增量校验失败。');
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

export async function bootstrapFocusSemanticSqliteForIdentity(input: {
  identity: SyncDevicePublicIdentityV1;
  now: number;
}): Promise<FocusSemanticSqliteBootstrapRuntimeResult> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (
    input.identity.state !== 'active'
    || input.identity.revokedAt !== null
  ) {
    throw new Error(
      '只有 active 且未撤销的设备可以 bootstrap focus.semantic。',
    );
  }
  assertTimestamp(input.now, 'focus SQLite bootstrap now');
  const database = await ensureFocusSemanticCaptureSchema();
  let status: 'already-complete' | 'completed' = 'completed';
  let mutationCount = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const runtime = await transaction.getFirstAsync<RuntimeRow>(
      `SELECT capture_enabled, suppress_capture, vault_id, source_device_id
       FROM focus_sync_runtime WHERE singleton_id = 1`,
    );
    if (
      runtime?.capture_enabled === 1
      && (
        runtime.vault_id !== input.identity.vaultId
        || runtime.source_device_id !== input.identity.deviceId
      )
    ) {
      throw new Error(
        'focus.semantic 已绑定另一 active vault/device，拒绝静默换绑。',
      );
    }
    if (runtime?.suppress_capture === 1) {
      throw new Error('focus.semantic 正在应用远端变更，不能 bootstrap。');
    }
    await transaction.runAsync(
      `UPDATE focus_sync_runtime
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
    const completed = await transaction.getFirstAsync<{ completed_at: number }>(
      `SELECT completed_at FROM focus_sync_bootstrap_state
       WHERE adapter_id = ?
         AND bootstrap_version = ?
         AND vault_id = ?
         AND source_device_id = ?`,
      FOCUS_SEMANTIC_ADAPTER_ID,
      FOCUS_SEMANTIC_SQLITE_BOOTSTRAP_VERSION,
      input.identity.vaultId,
      input.identity.deviceId,
    );
    if (completed) {
      status = 'already-complete';
    } else {
      mutationCount = await snapshotFocusRows({
        transaction,
        now: input.now,
      });
      await transaction.runAsync(
        `INSERT INTO focus_sync_bootstrap_state (
           adapter_id, bootstrap_version, vault_id,
           source_device_id, completed_at
         ) VALUES (?, ?, ?, ?, ?)`,
        FOCUS_SEMANTIC_ADAPTER_ID,
        FOCUS_SEMANTIC_SQLITE_BOOTSTRAP_VERSION,
        input.identity.vaultId,
        input.identity.deviceId,
        input.now,
      );
    }
    await transaction.runAsync(
      `UPDATE focus_sync_runtime
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
  return { status, mutationCount, captureEnabled: true };
}

export async function runFocusSemanticSqliteBootstrapRuntime(
  now = Date.now(),
): Promise<FocusSemanticSqliteBootstrapRuntimeResult> {
  assertTimestamp(now, 'focus runtime now');
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    await deactivateFocusSemanticCapture(now);
    return {
      status: 'no-current-device',
      mutationCount: 0,
      captureEnabled: false,
    };
  }
  await deactivateFocusSemanticCapture(now);
  return bootstrapFocusSemanticSqliteForIdentity({
    identity: currentDevice.identity,
    now,
  });
}

export async function runFocusSemanticBootstrapRuntime():
Promise<FocusSemanticBootstrapRuntimeResult> {
  disableFocusSemanticStorageCapture();
  const sqlite = await runFocusSemanticSqliteBootstrapRuntime();
  const storage = await runFocusSemanticStorageBootstrapRuntime();
  if (
    sqlite.status !== 'no-current-device'
    && (
      storage.status === 'completed'
      || storage.status === 'already-complete'
    )
  ) {
    enableFocusSemanticStorageCapture();
  }
  return { sqlite, storage };
}

function emptyPromotionReport(): PromoteFocusSemanticOutboxReport {
  return { claimedCount: 0, dispatchedCount: 0, failed: [] };
}

export async function runFocusSemanticOutboxPromotionRuntime(input: {
  limit?: number;
  now?: number;
} = {}): Promise<FocusSemanticPromotionRuntimeResult> {
  const now = input.now ?? Date.now();
  assertTimestamp(now, 'focus promotion now');
  const recoveredLeaseCount =
    await recoverExpiredFocusSemanticOutboxLeases(now);
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      recoveredLeaseCount,
      report: emptyPromotionReport(),
    };
  }
  const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
  const report = await promoteFocusSemanticDomainOutbox({
    identity: currentDevice.identity,
    leaseId: `focus-semantic:${expoSyncRandomUuidV1()}`,
    now,
    limit: input.limit ?? 100,
    leaseDurationMs: FOCUS_SEMANTIC_CAPTURE_LEASE_MS,
    domainOutbox: focusSemanticDomainOutboxPort,
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
