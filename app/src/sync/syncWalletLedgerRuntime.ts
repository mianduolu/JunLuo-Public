import type * as SQLite from 'expo-sqlite';

import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  assertSyncDevicePublicIdentityV1,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  assertWalletLedgerPayload,
  WALLET_LEDGER_ADAPTER_ID,
} from './syncWalletLedger';
import {
  promoteWalletLedgerDomainOutbox,
  type PromoteWalletLedgerOutboxReport,
} from './syncWalletLedgerOutbox';
import {
  deactivateWalletLedgerCapture,
  ensureWalletLedgerCaptureSchema,
  recoverExpiredWalletLedgerOutboxLeases,
  walletLedgerDomainOutboxPort,
} from './syncWalletLedgerSqlitePort';
import {
  WALLET_LEDGER_BOOTSTRAP_INSERT_SQL,
  WALLET_LEDGER_CAPTURE_LEASE_MS,
} from './syncWalletLedgerSql';
import {
  enqueueSyncMutationAndAdvanceHeads,
  syncMutationStatePort,
} from './syncMutationStateStore';

export const WALLET_LEDGER_BOOTSTRAP_VERSION = 1 as const;

export type WalletLedgerBootstrapRuntimeResult =
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

export type WalletLedgerPromotionRuntimeResult =
  | {
      status: 'no-current-device';
      recoveredLeaseCount: number;
      report: PromoteWalletLedgerOutboxReport;
    }
  | {
      status: 'completed' | 'partial-failure';
      recoveredLeaseCount: number;
      report: PromoteWalletLedgerOutboxReport;
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
    'SELECT MAX(local_sequence) AS value FROM wallet_sync_domain_outbox',
  );
  return row?.value ?? 0;
}

async function snapshotWalletRows(input: {
  transaction: SQLite.SQLiteDatabase;
  now: number;
}) {
  const before = await latestLocalSequence(input.transaction);
  let mutationCount = 0;
  for (const sql of WALLET_LEDGER_BOOTSTRAP_INSERT_SQL) {
    const result = await input.transaction.runAsync(
      sql,
      input.now,
      input.now,
      input.now,
    );
    mutationCount += result.changes;
  }
  const after = await latestLocalSequence(input.transaction);
  if (after - before !== mutationCount) {
    throw new Error(
      'wallet.ledger bootstrap outbox 序列增量校验失败。',
    );
  }
  const inserted = await input.transaction.getAllAsync<{
    entity_type: string;
    entity_id: string;
    operation: string;
    payload_json: string;
  }>(
    `SELECT entity_type, entity_id, operation, payload_json
     FROM wallet_sync_domain_outbox
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
      throw new Error('wallet.ledger bootstrap 生成了无效 JSON。');
    }
    assertWalletLedgerPayload(
      row.entity_type,
      row.entity_id,
      row.operation,
      payload,
    );
  }
  await input.transaction.runAsync(
    `INSERT OR IGNORE INTO wallet_sync_entity_heads (
       entity_type, entity_id, revision_id, updated_at
     )
     SELECT entity_type, entity_id, revision_id, ?
     FROM wallet_sync_domain_outbox
     WHERE local_sequence > ? AND local_sequence <= ?`,
    input.now,
    before,
    after,
  );
  return mutationCount;
}

export async function bootstrapWalletLedgerForIdentity(input: {
  identity: SyncDevicePublicIdentityV1;
  now: number;
}): Promise<WalletLedgerBootstrapRuntimeResult> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (
    input.identity.state !== 'active'
    || input.identity.revokedAt !== null
  ) {
    throw new Error(
      '只有 active 且未撤销的设备可以 bootstrap wallet.ledger。',
    );
  }
  assertTimestamp(input.now, 'wallet bootstrap now');
  const database = await ensureWalletLedgerCaptureSchema();
  let status: 'already-complete' | 'completed' = 'completed';
  let mutationCount = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const runtime = await transaction.getFirstAsync<RuntimeRow>(
      `SELECT capture_enabled, suppress_capture, vault_id, source_device_id
       FROM wallet_sync_runtime WHERE singleton_id = 1`,
    );
    if (
      runtime?.capture_enabled === 1
      && (
        runtime.vault_id !== input.identity.vaultId
        || runtime.source_device_id !== input.identity.deviceId
      )
    ) {
      throw new Error(
        'wallet.ledger 已绑定另一 active vault/device，拒绝静默换绑。',
      );
    }
    if (runtime?.suppress_capture === 1) {
      throw new Error(
        'wallet.ledger 正在应用远端变更，不能 bootstrap。',
      );
    }
    await transaction.runAsync(
      `UPDATE wallet_sync_runtime
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
      `SELECT completed_at FROM wallet_sync_bootstrap_state
       WHERE adapter_id = ?
         AND bootstrap_version = ?
         AND vault_id = ?
         AND source_device_id = ?`,
      WALLET_LEDGER_ADAPTER_ID,
      WALLET_LEDGER_BOOTSTRAP_VERSION,
      input.identity.vaultId,
      input.identity.deviceId,
    );
    if (completed) {
      status = 'already-complete';
    } else {
      mutationCount = await snapshotWalletRows({
        transaction,
        now: input.now,
      });
      await transaction.runAsync(
        `INSERT INTO wallet_sync_bootstrap_state (
           adapter_id, bootstrap_version, vault_id,
           source_device_id, completed_at
         ) VALUES (?, ?, ?, ?, ?)`,
        WALLET_LEDGER_ADAPTER_ID,
        WALLET_LEDGER_BOOTSTRAP_VERSION,
        input.identity.vaultId,
        input.identity.deviceId,
        input.now,
      );
    }
    await transaction.runAsync(
      `UPDATE wallet_sync_runtime
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

export async function runWalletLedgerBootstrapRuntime(
  now = Date.now(),
): Promise<WalletLedgerBootstrapRuntimeResult> {
  assertTimestamp(now, 'wallet runtime now');
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    await deactivateWalletLedgerCapture(now);
    return {
      status: 'no-current-device',
      mutationCount: 0,
      captureEnabled: false,
    };
  }
  await deactivateWalletLedgerCapture(now);
  return bootstrapWalletLedgerForIdentity({
    identity: currentDevice.identity,
    now,
  });
}

function emptyPromotionReport(): PromoteWalletLedgerOutboxReport {
  return { claimedCount: 0, dispatchedCount: 0, failed: [] };
}

export async function runWalletLedgerOutboxPromotionRuntime(input: {
  limit?: number;
  now?: number;
} = {}): Promise<WalletLedgerPromotionRuntimeResult> {
  const now = input.now ?? Date.now();
  assertTimestamp(now, 'wallet promotion now');
  const recoveredLeaseCount =
    await recoverExpiredWalletLedgerOutboxLeases(now);
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      recoveredLeaseCount,
      report: emptyPromotionReport(),
    };
  }
  const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
  const report = await promoteWalletLedgerDomainOutbox({
    identity: currentDevice.identity,
    leaseId: `wallet-ledger:${expoSyncRandomUuidV1()}`,
    now,
    limit: input.limit ?? 100,
    leaseDurationMs: WALLET_LEDGER_CAPTURE_LEASE_MS,
    domainOutbox: walletLedgerDomainOutboxPort,
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
