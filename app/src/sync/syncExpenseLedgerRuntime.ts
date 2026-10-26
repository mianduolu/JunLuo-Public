import type * as SQLite from 'expo-sqlite';

import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  assertSyncDevicePublicIdentityV1,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  assertExpenseLedgerPayload,
  EXPENSE_LEDGER_ADAPTER_ID,
} from './syncExpenseLedger';
import {
  promoteExpenseLedgerDomainOutbox,
  type PromoteExpenseLedgerOutboxReport,
} from './syncExpenseLedgerOutbox';
import {
  deactivateExpenseLedgerCapture,
  ensureExpenseLedgerCaptureSchema,
  expenseLedgerDomainOutboxPort,
  recoverExpiredExpenseLedgerOutboxLeases,
} from './syncExpenseLedgerSqlitePort';
import {
  EXPENSE_LEDGER_BOOTSTRAP_INSERT_SQL,
  EXPENSE_LEDGER_CAPTURE_LEASE_MS,
} from './syncExpenseLedgerSql';
import {
  enqueueSyncMutationAndAdvanceHeads,
  syncMutationStatePort,
} from './syncMutationStateStore';

export const EXPENSE_LEDGER_BOOTSTRAP_VERSION = 1 as const;

export type ExpenseLedgerBootstrapRuntimeResult =
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

export type ExpenseLedgerPromotionRuntimeResult =
  | {
      status: 'no-current-device';
      recoveredLeaseCount: number;
      report: PromoteExpenseLedgerOutboxReport;
    }
  | {
      status: 'completed' | 'partial-failure';
      recoveredLeaseCount: number;
      report: PromoteExpenseLedgerOutboxReport;
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

async function latestLocalSequence(
  transaction: SQLite.SQLiteDatabase,
) {
  const row = await transaction.getFirstAsync<{
    value: number | null;
  }>(
    'SELECT MAX(local_sequence) AS value FROM expense_sync_domain_outbox',
  );
  return row?.value ?? 0;
}

async function snapshotExpenseRows(input: {
  transaction: SQLite.SQLiteDatabase;
  now: number;
}) {
  const before = await latestLocalSequence(input.transaction);
  const result = await input.transaction.runAsync(
    EXPENSE_LEDGER_BOOTSTRAP_INSERT_SQL,
    input.now,
    input.now,
    input.now,
  );
  const after = await latestLocalSequence(input.transaction);
  if (after - before !== result.changes) {
    throw new Error(
      'expense.ledger bootstrap outbox 序列增量校验失败。',
    );
  }
  const inserted = await input.transaction.getAllAsync<{
    entity_id: string;
    operation: string;
    payload_json: string;
  }>(
    `SELECT entity_id, operation, payload_json
     FROM expense_sync_domain_outbox
     WHERE local_sequence > ? AND local_sequence <= ?
     ORDER BY local_sequence ASC`,
    before,
    after,
  );
  for (const row of inserted) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      throw new Error(
        'expense.ledger bootstrap 生成了无效 JSON。',
      );
    }
    assertExpenseLedgerPayload(
      row.entity_id,
      row.operation,
      payload,
    );
  }
  await input.transaction.runAsync(
    `INSERT OR IGNORE INTO expense_sync_entity_heads (
       entity_type, entity_id, revision_id, updated_at
     )
     SELECT entity_type, entity_id, revision_id, ?
     FROM expense_sync_domain_outbox
     WHERE local_sequence > ? AND local_sequence <= ?`,
    input.now,
    before,
    after,
  );
  return result.changes;
}

export async function bootstrapExpenseLedgerForIdentity(input: {
  identity: SyncDevicePublicIdentityV1;
  now: number;
}): Promise<ExpenseLedgerBootstrapRuntimeResult> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (
    input.identity.state !== 'active'
    || input.identity.revokedAt !== null
  ) {
    throw new Error(
      '只有 active 且未撤销的设备可以 bootstrap expense.ledger。',
    );
  }
  assertTimestamp(input.now, 'expense bootstrap now');
  const database = await ensureExpenseLedgerCaptureSchema();
  let status: 'already-complete' | 'completed' = 'completed';
  let mutationCount = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const runtime = await transaction.getFirstAsync<RuntimeRow>(
      `SELECT capture_enabled, suppress_capture, vault_id, source_device_id
       FROM expense_sync_runtime WHERE singleton_id = 1`,
    );
    if (
      runtime?.capture_enabled === 1
      && (
        runtime.vault_id !== input.identity.vaultId
        || runtime.source_device_id !== input.identity.deviceId
      )
    ) {
      throw new Error(
        'expense.ledger 已绑定另一 active vault/device，拒绝静默换绑。',
      );
    }
    if (runtime?.suppress_capture === 1) {
      throw new Error(
        'expense.ledger 正在应用远端变更，不能 bootstrap。',
      );
    }
    await transaction.runAsync(
      `UPDATE expense_sync_runtime
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
    const completed = await transaction.getFirstAsync<{
      completed_at: number;
    }>(
      `SELECT completed_at FROM expense_sync_bootstrap_state
       WHERE adapter_id = ?
         AND bootstrap_version = ?
         AND vault_id = ?
         AND source_device_id = ?`,
      EXPENSE_LEDGER_ADAPTER_ID,
      EXPENSE_LEDGER_BOOTSTRAP_VERSION,
      input.identity.vaultId,
      input.identity.deviceId,
    );
    if (completed) {
      status = 'already-complete';
    } else {
      mutationCount = await snapshotExpenseRows({
        transaction,
        now: input.now,
      });
      await transaction.runAsync(
        `INSERT INTO expense_sync_bootstrap_state (
           adapter_id, bootstrap_version, vault_id,
           source_device_id, completed_at
         ) VALUES (?, ?, ?, ?, ?)`,
        EXPENSE_LEDGER_ADAPTER_ID,
        EXPENSE_LEDGER_BOOTSTRAP_VERSION,
        input.identity.vaultId,
        input.identity.deviceId,
        input.now,
      );
    }
    await transaction.runAsync(
      `UPDATE expense_sync_runtime
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

export async function runExpenseLedgerBootstrapRuntime(
  now = Date.now(),
): Promise<ExpenseLedgerBootstrapRuntimeResult> {
  assertTimestamp(now, 'expense runtime now');
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    await deactivateExpenseLedgerCapture(now);
    return {
      status: 'no-current-device',
      mutationCount: 0,
      captureEnabled: false,
    };
  }
  await deactivateExpenseLedgerCapture(now);
  return bootstrapExpenseLedgerForIdentity({
    identity: currentDevice.identity,
    now,
  });
}

function emptyPromotionReport(): PromoteExpenseLedgerOutboxReport {
  return { claimedCount: 0, dispatchedCount: 0, failed: [] };
}

export async function runExpenseLedgerOutboxPromotionRuntime(input: {
  limit?: number;
  now?: number;
} = {}): Promise<ExpenseLedgerPromotionRuntimeResult> {
  const now = input.now ?? Date.now();
  assertTimestamp(now, 'expense promotion now');
  const recoveredLeaseCount =
    await recoverExpiredExpenseLedgerOutboxLeases(now);
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      recoveredLeaseCount,
      report: emptyPromotionReport(),
    };
  }
  const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
  const report = await promoteExpenseLedgerDomainOutbox({
    identity: currentDevice.identity,
    leaseId: `expense-ledger:${expoSyncRandomUuidV1()}`,
    now,
    limit: input.limit ?? 100,
    leaseDurationMs: EXPENSE_LEDGER_CAPTURE_LEASE_MS,
    domainOutbox: expenseLedgerDomainOutboxPort,
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
