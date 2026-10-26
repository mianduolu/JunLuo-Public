import type * as SQLite from 'expo-sqlite';

import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  assertSyncDevicePublicIdentityV1,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  assertPeriodHealthPayload,
  PERIOD_HEALTH_ADAPTER_ID,
} from './syncPeriodHealth';
import {
  promotePeriodHealthDomainOutbox,
  type PromotePeriodHealthOutboxReport,
} from './syncPeriodHealthOutbox';
import {
  deactivatePeriodHealthCapture,
  ensurePeriodHealthCaptureSchema,
  periodHealthDomainOutboxPort,
  recoverExpiredPeriodHealthOutboxLeases,
} from './syncPeriodHealthSqlitePort';
import {
  PERIOD_HEALTH_BOOTSTRAP_INSERT_SQL,
  PERIOD_HEALTH_CAPTURE_LEASE_MS,
} from './syncPeriodHealthSql';
import {
  enqueueSyncMutationAndAdvanceHeads,
  syncMutationStatePort,
} from './syncMutationStateStore';

export const PERIOD_HEALTH_BOOTSTRAP_VERSION = 1 as const;

export type PeriodHealthBootstrapRuntimeResult =
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

export type PeriodHealthPromotionRuntimeResult =
  | {
      status: 'no-current-device';
      recoveredLeaseCount: number;
      report: PromotePeriodHealthOutboxReport;
    }
  | {
      status: 'completed' | 'partial-failure';
      recoveredLeaseCount: number;
      report: PromotePeriodHealthOutboxReport;
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
    'SELECT MAX(local_sequence) AS value FROM period_sync_domain_outbox',
  );
  return row?.value ?? 0;
}

async function snapshotPeriodHealthRows(input: {
  transaction: SQLite.SQLiteDatabase;
  now: number;
}) {
  let mutationCount = 0;
  for (const statement of PERIOD_HEALTH_BOOTSTRAP_INSERT_SQL) {
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
        'period.health bootstrap outbox 序列增量校验失败。',
      );
    }
    const inserted = await input.transaction.getAllAsync<{
      entity_type: string;
      entity_id: string;
      operation: string;
      payload_json: string;
    }>(
      `SELECT entity_type, entity_id, operation, payload_json
       FROM period_sync_domain_outbox
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
          'period.health bootstrap 生成了无效 JSON。',
        );
      }
      assertPeriodHealthPayload(
        row.entity_type,
        row.entity_id,
        row.operation,
        payload,
      );
    }
    await input.transaction.runAsync(
      `INSERT OR IGNORE INTO period_sync_entity_heads (
         entity_type, entity_id, revision_id, updated_at
       )
       SELECT entity_type, entity_id, revision_id, ?
       FROM period_sync_domain_outbox
       WHERE local_sequence > ? AND local_sequence <= ?`,
      input.now,
      before,
      after,
    );
    mutationCount += result.changes;
  }
  return mutationCount;
}

export async function bootstrapPeriodHealthForIdentity(input: {
  identity: SyncDevicePublicIdentityV1;
  now: number;
}): Promise<PeriodHealthBootstrapRuntimeResult> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (
    input.identity.state !== 'active'
    || input.identity.revokedAt !== null
  ) {
    throw new Error(
      '只有 active 且未撤销的设备可以 bootstrap period.health。',
    );
  }
  assertTimestamp(input.now, 'period.health bootstrap now');
  const database = await ensurePeriodHealthCaptureSchema();
  let status: 'already-complete' | 'completed' = 'completed';
  let mutationCount = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const runtime = await transaction.getFirstAsync<RuntimeRow>(
      `SELECT capture_enabled, suppress_capture, vault_id, source_device_id
       FROM period_sync_runtime WHERE singleton_id = 1`,
    );
    if (
      runtime?.capture_enabled === 1
      && (
        runtime.vault_id !== input.identity.vaultId
        || runtime.source_device_id !== input.identity.deviceId
      )
    ) {
      throw new Error(
        'period.health 已绑定另一 active vault/device，拒绝静默换绑。',
      );
    }
    if (runtime?.suppress_capture === 1) {
      throw new Error(
        'period.health 正在应用远端变更，不能 bootstrap。',
      );
    }
    await transaction.runAsync(
      `UPDATE period_sync_runtime
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
      `SELECT completed_at FROM period_sync_bootstrap_state
       WHERE adapter_id = ?
         AND bootstrap_version = ?
         AND vault_id = ?
         AND source_device_id = ?`,
      PERIOD_HEALTH_ADAPTER_ID,
      PERIOD_HEALTH_BOOTSTRAP_VERSION,
      input.identity.vaultId,
      input.identity.deviceId,
    );
    if (completed) {
      status = 'already-complete';
    } else {
      mutationCount = await snapshotPeriodHealthRows({
        transaction,
        now: input.now,
      });
      await transaction.runAsync(
        `INSERT INTO period_sync_bootstrap_state (
           adapter_id, bootstrap_version, vault_id,
           source_device_id, completed_at
         ) VALUES (?, ?, ?, ?, ?)`,
        PERIOD_HEALTH_ADAPTER_ID,
        PERIOD_HEALTH_BOOTSTRAP_VERSION,
        input.identity.vaultId,
        input.identity.deviceId,
        input.now,
      );
    }
    await transaction.runAsync(
      `UPDATE period_sync_runtime
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

export async function runPeriodHealthBootstrapRuntime(
  now = Date.now(),
): Promise<PeriodHealthBootstrapRuntimeResult> {
  assertTimestamp(now, 'period.health runtime now');
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    await deactivatePeriodHealthCapture(now);
    return {
      status: 'no-current-device',
      mutationCount: 0,
      captureEnabled: false,
    };
  }
  await deactivatePeriodHealthCapture(now);
  return bootstrapPeriodHealthForIdentity({
    identity: currentDevice.identity,
    now,
  });
}

function emptyPromotionReport(): PromotePeriodHealthOutboxReport {
  return { claimedCount: 0, dispatchedCount: 0, failed: [] };
}

export async function runPeriodHealthOutboxPromotionRuntime(input: {
  limit?: number;
  now?: number;
} = {}): Promise<PeriodHealthPromotionRuntimeResult> {
  const now = input.now ?? Date.now();
  assertTimestamp(now, 'period.health promotion now');
  const recoveredLeaseCount =
    await recoverExpiredPeriodHealthOutboxLeases(now);
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      recoveredLeaseCount,
      report: emptyPromotionReport(),
    };
  }
  const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
  const report = await promotePeriodHealthDomainOutbox({
    identity: currentDevice.identity,
    leaseId: `period-health:${expoSyncRandomUuidV1()}`,
    now,
    limit: input.limit ?? 100,
    leaseDurationMs: PERIOD_HEALTH_CAPTURE_LEASE_MS,
    domainOutbox: periodHealthDomainOutboxPort,
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
