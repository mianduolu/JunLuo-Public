import type * as SQLite from 'expo-sqlite';

import { ensureBodySignalCollectionPolicyRecord } from '../bodySignal/bodySignalSettingsStore';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  assertSyncDevicePublicIdentityV1,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  assertBodySignalHealthPayload,
  BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS,
  BODY_SIGNAL_DAILY_SUMMARY_RETENTION_DAYS,
  BODY_SIGNAL_HEALTH_ADAPTER_ID,
} from './syncBodySignalHealth';
import {
  promoteBodySignalHealthDomainOutbox,
  type PromoteBodySignalHealthOutboxReport,
} from './syncBodySignalHealthOutbox';
import {
  bodySignalHealthDomainOutboxPort,
  deactivateBodySignalHealthCapture,
  ensureBodySignalHealthCaptureSchema,
  recoverExpiredBodySignalHealthOutboxLeases,
} from './syncBodySignalHealthSqlitePort';
import {
  BODY_SIGNAL_HEALTH_BOOTSTRAP_INSERT_SQL,
  BODY_SIGNAL_HEALTH_CAPTURE_LEASE_MS,
  BODY_SIGNAL_HEALTH_PREPARE_SUMMARIES_SQL,
  BODY_SIGNAL_HEALTH_SUMMARY_CHECKPOINT_INSERT_SQL,
  BODY_SIGNAL_HEALTH_SUMMARY_SHARE_INTERVAL_MS,
} from './syncBodySignalHealthSql';
import {
  enqueueSyncMutationAndAdvanceHeads,
  syncMutationStatePort,
} from './syncMutationStateStore';

export const BODY_SIGNAL_HEALTH_BOOTSTRAP_VERSION = 1 as const;

function localDateKey(value: number) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function oldestRetainedLocalDateKey(now: number, days: number) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days + 1);
  return localDateKey(date.getTime());
}

export type BodySignalHealthBootstrapRuntimeResult =
  | {
      status: 'no-current-device';
      mutationCount: 0;
      captureEnabled: false;
      prunedReadingCount: 0;
    }
  | {
      status: 'already-complete' | 'completed';
      mutationCount: number;
      captureEnabled: true;
      prunedReadingCount: number;
    };

export type BodySignalHealthPromotionRuntimeResult =
  | {
      status: 'no-current-device';
      recoveredLeaseCount: number;
      report: PromoteBodySignalHealthOutboxReport;
    }
  | {
      status: 'completed' | 'partial-failure';
      recoveredLeaseCount: number;
      report: PromoteBodySignalHealthOutboxReport;
    };

type RuntimeRow = {
  capture_enabled: number;
  suppress_capture: number;
  vault_id: string | null;
  source_device_id: string | null;
  source_platform: 'android' | 'windows' | null;
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
    'SELECT MAX(local_sequence) AS value '
    + 'FROM body_signal_sync_domain_outbox',
  );
  return row?.value ?? 0;
}

async function prepareBodySignalRows(input: {
  transaction: SQLite.SQLiteDatabase;
  identity: SyncDevicePublicIdentityV1;
  now: number;
  rawRetentionDays: number;
}) {
  const retentionMs = input.rawRetentionDays * 86_400_000;
  await input.transaction.runAsync(
    `UPDATE body_signal_readings
     SET received_at = COALESCE(received_at, created_at),
         origin_device_id = COALESCE(origin_device_id, ?),
         origin_platform = COALESCE(origin_platform, ?),
         clock_confidence = COALESCE(
           clock_confidence,
           'app-clock'
         ),
         sampling_method = COALESCE(
           sampling_method,
           'imported'
         ),
         retention_until = MIN(
           COALESCE(retention_until, measured_at + ?),
           measured_at + ?
         )`,
    input.identity.deviceId,
    input.identity.platform,
    retentionMs,
    retentionMs,
  );
  const pruned = await input.transaction.runAsync(
    `DELETE FROM body_signal_readings
     WHERE retention_until IS NOT NULL
       AND retention_until <= ?`,
    input.now,
  );
  await input.transaction.runAsync(
    BODY_SIGNAL_HEALTH_PREPARE_SUMMARIES_SQL,
    input.now,
  );
  await input.transaction.runAsync(
    'DELETE FROM body_signal_care_summaries WHERE date_key < ?',
    oldestRetainedLocalDateKey(
      input.now,
      BODY_SIGNAL_DAILY_SUMMARY_RETENTION_DAYS,
    ),
  );
  return pruned.changes;
}

async function snapshotBodySignalRows(input: {
  transaction: SQLite.SQLiteDatabase;
  now: number;
}) {
  const before = await latestLocalSequence(input.transaction);
  let mutationCount = 0;
  for (const statement of BODY_SIGNAL_HEALTH_BOOTSTRAP_INSERT_SQL) {
    const result = await input.transaction.runAsync(
      statement,
      input.now,
      input.now,
      input.now,
    );
    mutationCount += result.changes;
  }
  const after = await latestLocalSequence(input.transaction);
  if (after - before !== mutationCount) {
    throw new Error(
      'body-signal.health bootstrap outbox 序列增量校验失败。',
    );
  }
  const inserted = await input.transaction.getAllAsync<{
    entity_type: string;
    entity_id: string;
    operation: string;
    payload_json: string;
  }>(
    `SELECT entity_type, entity_id, operation, payload_json
     FROM body_signal_sync_domain_outbox
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
        'body-signal.health bootstrap 生成了无效 JSON。',
      );
    }
    assertBodySignalHealthPayload(
      row.entity_type,
      row.entity_id,
      row.operation,
      payload,
    );
  }
  await input.transaction.runAsync(
    `INSERT OR IGNORE INTO body_signal_sync_entity_heads (
       entity_type, entity_id, revision_id, updated_at
     )
     SELECT entity_type, entity_id, revision_id, ?
     FROM body_signal_sync_domain_outbox
     WHERE local_sequence > ? AND local_sequence <= ?`,
    input.now,
    before,
    after,
  );
  return mutationCount;
}

async function pruneExpiredBodySignalReadings(now: number) {
  const database = await ensureBodySignalHealthCaptureSchema();
  let pruned = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const retentionMs =
      BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS * 86_400_000;
    await transaction.runAsync(
      `UPDATE body_signal_readings
       SET retention_until = MIN(
         COALESCE(retention_until, measured_at + ?),
         measured_at + ?
       )`,
      retentionMs,
      retentionMs,
    );
    const result = await transaction.runAsync(
      `DELETE FROM body_signal_readings
       WHERE retention_until IS NOT NULL
         AND retention_until <= ?`,
      now,
    );
    pruned = result.changes;
    await transaction.runAsync(
      'DELETE FROM body_signal_care_summaries WHERE date_key < ?',
      oldestRetainedLocalDateKey(
        now,
        BODY_SIGNAL_DAILY_SUMMARY_RETENTION_DAYS,
      ),
    );
  });
  return pruned;
}

type SummaryPreparationMode = 'automatic' | 'manual';

export async function prepareBodySignalSummariesForSync(input: {
  mode: SummaryPreparationMode;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  assertTimestamp(now, 'body signal summary now');
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) return 0;
  const database = await ensureBodySignalHealthCaptureSchema();
  let enqueued = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const automaticScan = await transaction.getFirstAsync<{
      last_enqueued_at: number;
    }>(
      `SELECT last_enqueued_at
       FROM body_signal_sync_summary_checkpoints
       WHERE vault_id = ? AND source_device_id = ?
         AND entity_type = '__runtime__' AND entity_id = 'last-scan'`,
      currentDevice.identity.vaultId,
      currentDevice.identity.deviceId,
    );
    if (
      input.mode === 'automatic'
      && automaticScan
      && now - automaticScan.last_enqueued_at
        < BODY_SIGNAL_HEALTH_SUMMARY_SHARE_INTERVAL_MS
    ) {
      return;
    }
    await transaction.runAsync(BODY_SIGNAL_HEALTH_PREPARE_SUMMARIES_SQL, now);
    const before = await latestLocalSequence(transaction);
    for (const statement of BODY_SIGNAL_HEALTH_SUMMARY_CHECKPOINT_INSERT_SQL) {
      const result = await transaction.runAsync(
        statement,
        now,
        now,
        now,
        input.mode === 'manual' ? 1 : 0,
        now,
      );
      enqueued += result.changes;
    }
    const after = await latestLocalSequence(transaction);
    if (after - before !== enqueued) {
      throw new Error('body-signal.health 汇总检查点序列校验失败。');
    }
    await transaction.runAsync(
      `DELETE FROM body_signal_sync_entity_heads
       WHERE EXISTS (
         SELECT 1 FROM body_signal_sync_domain_outbox AS pending
         WHERE pending.local_sequence > ?
           AND pending.local_sequence <= ?
           AND pending.entity_type = body_signal_sync_entity_heads.entity_type
           AND pending.entity_id = body_signal_sync_entity_heads.entity_id
       )`,
      before,
      after,
    );
    await transaction.runAsync(
      `INSERT OR IGNORE INTO body_signal_sync_entity_heads (
         entity_type, entity_id, revision_id, updated_at
       )
       SELECT entity_type, entity_id, revision_id, ?
       FROM body_signal_sync_domain_outbox
       WHERE local_sequence > ? AND local_sequence <= ?`,
      now,
      before,
      after,
    );
    await transaction.runAsync(
      `INSERT INTO body_signal_sync_summary_checkpoints (
         vault_id, source_device_id, entity_type, entity_id,
         payload_fingerprint, last_enqueued_at
       )
       SELECT vault_id, source_device_id, entity_type, entity_id,
              payload_json, ?
       FROM body_signal_sync_domain_outbox
       WHERE local_sequence > ? AND local_sequence <= ?
       ON CONFLICT(vault_id, source_device_id, entity_type, entity_id)
       DO UPDATE SET
         payload_fingerprint = excluded.payload_fingerprint,
         last_enqueued_at = excluded.last_enqueued_at`,
      now,
      before,
      after,
    );
    await transaction.runAsync(
      `INSERT INTO body_signal_sync_summary_checkpoints (
         vault_id, source_device_id, entity_type, entity_id,
         payload_fingerprint, last_enqueued_at
       ) VALUES (?, ?, '__runtime__', 'last-scan', '', ?)
       ON CONFLICT(vault_id, source_device_id, entity_type, entity_id)
       DO UPDATE SET last_enqueued_at = excluded.last_enqueued_at`,
      currentDevice.identity.vaultId,
      currentDevice.identity.deviceId,
      now,
    );
  });
  return enqueued;
}

export async function bootstrapBodySignalHealthForIdentity(input: {
  identity: SyncDevicePublicIdentityV1;
  now: number;
}): Promise<BodySignalHealthBootstrapRuntimeResult> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (
    input.identity.state !== 'active'
    || input.identity.revokedAt !== null
  ) {
    throw new Error(
      '只有 active 且未撤销的设备可以 bootstrap body-signal.health。',
    );
  }
  assertTimestamp(input.now, 'body signal bootstrap now');
  const policy = await ensureBodySignalCollectionPolicyRecord();
  const database = await ensureBodySignalHealthCaptureSchema();
  let status: 'already-complete' | 'completed' = 'completed';
  let wasAlreadyComplete = false;
  let mutationCount = 0;
  let prunedReadingCount = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const runtime = await transaction.getFirstAsync<RuntimeRow>(
      `SELECT capture_enabled, suppress_capture, vault_id,
              source_device_id, source_platform
       FROM body_signal_sync_runtime WHERE singleton_id = 1`,
    );
    if (
      runtime?.capture_enabled === 1
      && (
        runtime.vault_id !== input.identity.vaultId
        || runtime.source_device_id !== input.identity.deviceId
        || runtime.source_platform !== input.identity.platform
      )
    ) {
      throw new Error(
        'body-signal.health 已绑定另一 active vault/device，拒绝静默换绑。',
      );
    }
    if (runtime?.suppress_capture === 1) {
      throw new Error(
        'body-signal.health 正在应用远端变更，不能 bootstrap。',
      );
    }
    await transaction.runAsync(
      `UPDATE body_signal_sync_runtime
       SET capture_enabled = 0,
           suppress_capture = 0,
           vault_id = ?,
           source_device_id = ?,
           source_platform = ?,
           updated_at = ?
       WHERE singleton_id = 1`,
      input.identity.vaultId,
      input.identity.deviceId,
      input.identity.platform,
      input.now,
    );
    const completed = await transaction.getFirstAsync<{
      completed_at: number;
    }>(
      `SELECT completed_at FROM body_signal_sync_bootstrap_state
       WHERE adapter_id = ?
         AND bootstrap_version = ?
         AND vault_id = ?
         AND source_device_id = ?`,
      BODY_SIGNAL_HEALTH_ADAPTER_ID,
      BODY_SIGNAL_HEALTH_BOOTSTRAP_VERSION,
      input.identity.vaultId,
      input.identity.deviceId,
    );
    if (completed) {
      status = 'already-complete';
      wasAlreadyComplete = true;
    } else {
      prunedReadingCount = await prepareBodySignalRows({
        transaction,
        identity: input.identity,
        now: input.now,
        rawRetentionDays: Math.min(
          policy.rawRetentionDays,
          BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS,
        ),
      });
      mutationCount = await snapshotBodySignalRows({
        transaction,
        now: input.now,
      });
      await transaction.runAsync(
        `INSERT INTO body_signal_sync_bootstrap_state (
           adapter_id, bootstrap_version, vault_id,
           source_device_id, completed_at
         ) VALUES (?, ?, ?, ?, ?)`,
        BODY_SIGNAL_HEALTH_ADAPTER_ID,
        BODY_SIGNAL_HEALTH_BOOTSTRAP_VERSION,
        input.identity.vaultId,
        input.identity.deviceId,
        input.now,
      );
    }
    await transaction.runAsync(
      `UPDATE body_signal_sync_runtime
       SET capture_enabled = 1,
           suppress_capture = 0,
           vault_id = ?,
           source_device_id = ?,
           source_platform = ?,
           updated_at = ?
       WHERE singleton_id = 1`,
      input.identity.vaultId,
      input.identity.deviceId,
      input.identity.platform,
      input.now,
    );
  });
  if (wasAlreadyComplete) {
    prunedReadingCount = await pruneExpiredBodySignalReadings(input.now);
  }
  return {
    status,
    mutationCount,
    captureEnabled: true,
    prunedReadingCount,
  };
}

export async function runBodySignalHealthBootstrapRuntime(
  now = Date.now(),
): Promise<BodySignalHealthBootstrapRuntimeResult> {
  assertTimestamp(now, 'body signal runtime now');
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    await deactivateBodySignalHealthCapture(now);
    return {
      status: 'no-current-device',
      mutationCount: 0,
      captureEnabled: false,
      prunedReadingCount: 0,
    };
  }
  await deactivateBodySignalHealthCapture(now);
  return bootstrapBodySignalHealthForIdentity({
    identity: currentDevice.identity,
    now,
  });
}

function emptyPromotionReport(): PromoteBodySignalHealthOutboxReport {
  return { claimedCount: 0, dispatchedCount: 0, failed: [] };
}

export async function runBodySignalHealthOutboxPromotionRuntime(input: {
  limit?: number;
  now?: number;
  prepareSummaries?: boolean;
  summaryMode?: SummaryPreparationMode;
} = {}): Promise<BodySignalHealthPromotionRuntimeResult> {
  const now = input.now ?? Date.now();
  assertTimestamp(now, 'body signal promotion now');
  const recoveredLeaseCount =
    await recoverExpiredBodySignalHealthOutboxLeases(now);
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      recoveredLeaseCount,
      report: emptyPromotionReport(),
    };
  }
  if (input.prepareSummaries ?? true) {
    await prepareBodySignalSummariesForSync({
      mode: input.summaryMode ?? 'manual',
      now,
    });
  }
  const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
  const report = await promoteBodySignalHealthDomainOutbox({
    identity: currentDevice.identity,
    leaseId: `body-signal-health:${expoSyncRandomUuidV1()}`,
    now,
    limit: input.limit ?? 100,
    leaseDurationMs: BODY_SIGNAL_HEALTH_CAPTURE_LEASE_MS,
    domainOutbox: bodySignalHealthDomainOutboxPort,
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
