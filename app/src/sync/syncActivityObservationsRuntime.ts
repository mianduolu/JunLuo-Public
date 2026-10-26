import type * as SQLite from 'expo-sqlite';

import { runSerializedPhoneActivityDatabaseOperation } from '../phoneActivity/phoneActivityDatabaseQueue';
import {
  loadPhoneActivityProactiveSettings,
  type PhoneActivityProactiveSettings,
} from '../proactive/phoneActivityRules';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  assertSyncDevicePublicIdentityV1,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  ACTIVITY_DEFAULT_RAW_RETENTION_DAYS,
  ACTIVITY_DAILY_SUMMARY_RETENTION_DAYS,
  assertActivityObservationsPayload,
  ACTIVITY_OBSERVATIONS_ADAPTER_ID,
} from './syncActivityObservations';
import {
  promoteActivityObservationsDomainOutbox,
  type PromoteActivityObservationsOutboxReport,
} from './syncActivityObservationsOutbox';
import {
  activityObservationsDomainOutboxPort,
  deactivateActivityObservationsCapture,
  ensureActivityObservationsCaptureSchema,
  recoverExpiredActivityObservationsOutboxLeases,
} from './syncActivityObservationsSqlitePort';
import {
  ACTIVITY_OBSERVATIONS_BOOTSTRAP_INSERT_SQL,
  ACTIVITY_OBSERVATIONS_CAPTURE_LEASE_MS,
  ACTIVITY_OBSERVATIONS_SUMMARY_CHECKPOINT_INSERT_SQL,
  ACTIVITY_OBSERVATIONS_SUMMARY_SHARE_INTERVAL_MS,
} from './syncActivityObservationsSql';
import {
  enqueueSyncMutationAndAdvanceHeads,
  syncMutationStatePort,
} from './syncMutationStateStore';

export const ACTIVITY_OBSERVATIONS_BOOTSTRAP_VERSION = 1 as const;

export type ActivityObservationsBootstrapRuntimeResult =
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

export type ActivityObservationsPromotionRuntimeResult =
  | {
      status: 'no-current-device';
      recoveredLeaseCount: number;
      report: PromoteActivityObservationsOutboxReport;
    }
  | {
      status: 'completed' | 'partial-failure';
      recoveredLeaseCount: number;
      report: PromoteActivityObservationsOutboxReport;
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
    + 'FROM activity_sync_domain_outbox',
  );
  return row?.value ?? 0;
}

type ActivityLogRow = {
  id: string;
  source: string;
  title: string;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number;
  created_at: number;
  origin_device_id: string;
  origin_platform: 'android' | 'windows';
};

type ActivityRuleRow = {
  id: string;
  source: string;
  target_platform: 'android' | 'windows';
};

type SummaryAccumulator = {
  segments: number;
  totalDurationMs: number;
  apps: Map<string, {
    source: string;
    title: string;
    durationMs: number;
    segments: number;
  }>;
};

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

function nextLocalDayStart(value: number) {
  const date = new Date(value);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function scopedPolicyId(
  platform: 'android' | 'windows',
  localId: string,
) {
  return `${platform}:${localId}`;
}

async function materializeCarePolicy(input: {
  transaction: SQLite.SQLiteDatabase;
  settings: PhoneActivityProactiveSettings;
  platform: 'android' | 'windows';
  now: number;
}) {
  await input.transaction.runAsync(
    `INSERT INTO activity_care_settings (
       id, enabled, jealousy_enabled, raw_retention_days, updated_at
     ) VALUES ('global', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       jealousy_enabled = excluded.jealousy_enabled,
       raw_retention_days = excluded.raw_retention_days,
       updated_at = excluded.updated_at`,
    input.settings.enabled ? 1 : 0,
    input.settings.jealousyEnabled ? 1 : 0,
    ACTIVITY_DEFAULT_RAW_RETENTION_DAYS,
    input.now,
  );
  const ruleIds = input.settings.rules.map((rule) => (
    scopedPolicyId(input.platform, rule.id)
  ));
  const candidateIds = (input.settings.jealousyCandidateApps ?? []).map(
    (candidate) => scopedPolicyId(input.platform, candidate.id),
  );
  await input.transaction.runAsync(
    `DELETE FROM activity_care_rules
     WHERE target_platform = ?
     ${ruleIds.length
      ? `AND id NOT IN (${ruleIds.map(() => '?').join(', ')})`
      : ''}`,
    input.platform,
    ...ruleIds,
  );
  await input.transaction.runAsync(
    `DELETE FROM activity_feedback
     WHERE target_platform = ?
     ${candidateIds.length
      ? `AND id NOT IN (${candidateIds.map(() => '?').join(', ')})`
      : ''}`,
    input.platform,
    ...candidateIds,
  );
  for (const rule of input.settings.rules) {
    await input.transaction.runAsync(
      `INSERT INTO activity_care_rules (
         id, rule_kind, target_platform, source, title,
         threshold_minutes, return_window_minutes,
         daily_limit_minutes, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         threshold_minutes = excluded.threshold_minutes,
         return_window_minutes = excluded.return_window_minutes,
         daily_limit_minutes = excluded.daily_limit_minutes,
         updated_at = excluded.updated_at`,
      scopedPolicyId(input.platform, rule.id),
      rule.kind,
      input.platform,
      rule.source,
      rule.title,
      rule.thresholdMinutes,
      rule.returnWindowMinutes ?? null,
      rule.dailyLimitMinutes ?? null,
      input.now,
    );
  }
  for (const candidate of input.settings.jealousyCandidateApps ?? []) {
    await input.transaction.runAsync(
      `INSERT INTO activity_feedback (
         id, target_platform, source, title, reason,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         reason = excluded.reason,
         status = excluded.status,
         updated_at = excluded.updated_at`,
      scopedPolicyId(input.platform, candidate.id),
      input.platform,
      candidate.source,
      candidate.title,
      candidate.reason,
      candidate.status,
      candidate.createdAt,
      input.now,
    );
  }
}

async function refreshDerivedActivityRows(input: {
  transaction: SQLite.SQLiteDatabase;
  now: number;
}) {
  const logs = await input.transaction.getAllAsync<ActivityLogRow>(
    `SELECT id, source, title, started_at, ended_at,
            duration_ms, created_at, origin_device_id, origin_platform
     FROM phone_activity_logs
     WHERE kind = 'foreground_app_duration'
       AND sensitive_level <> 'blocked'
       AND origin_device_id IS NOT NULL
       AND origin_platform IS NOT NULL
       AND source <> ''
     ORDER BY created_at ASC, id ASC`,
  );
  const rules = await input.transaction.getAllAsync<ActivityRuleRow>(
    `SELECT id, source, target_platform
     FROM activity_care_rules ORDER BY id ASC`,
  );
  const summaries = new Map<string, SummaryAccumulator>();
  const dailyUsage = new Map<string, {
    id: string;
    ruleId: string;
    dateKey: string;
    durationMs: number;
    originDeviceId: string;
    originPlatform: 'android' | 'windows';
  }>();
  for (const log of logs) {
    const rawStart = log.started_at ?? log.created_at;
    const rawEnd = log.ended_at
      ?? rawStart + Math.max(0, log.duration_ms);
    if (rawEnd <= rawStart) continue;
    let cursor = rawStart;
    while (cursor < rawEnd) {
      const chunkEnd = Math.min(rawEnd, nextLocalDayStart(cursor));
      const durationMs = chunkEnd - cursor;
      if (durationMs <= 0) break;
      const dateKey = localDateKey(cursor);
      const summaryId = `${log.origin_device_id}:${dateKey}`;
      const summary = summaries.get(summaryId) ?? {
        segments: 0,
        totalDurationMs: 0,
        apps: new Map(),
      };
      summary.segments += 1;
      summary.totalDurationMs += durationMs;
      const app = summary.apps.get(log.source) ?? {
        source: log.source,
        title: log.title || log.source,
        durationMs: 0,
        segments: 0,
      };
      app.durationMs += durationMs;
      app.segments += 1;
      summary.apps.set(log.source, app);
      summaries.set(summaryId, summary);
      for (const rule of rules) {
        if (
          rule.target_platform !== log.origin_platform
          || rule.source !== log.source
        ) {
          continue;
        }
        const usageId =
          `${log.origin_device_id}:${dateKey}:${rule.id}`;
        const usage = dailyUsage.get(usageId) ?? {
          id: usageId,
          ruleId: rule.id,
          dateKey,
          durationMs: 0,
          originDeviceId: log.origin_device_id,
          originPlatform: log.origin_platform,
        };
        usage.durationMs += durationMs;
        dailyUsage.set(usageId, usage);
      }
      cursor = chunkEnd;
    }
  }
  for (const [id, summary] of summaries) {
    const separator = id.lastIndexOf(':');
    const originDeviceId = id.slice(0, separator);
    const dateKey = id.slice(separator + 1);
    const sourceLog = logs.find(
      (log) => log.origin_device_id === originDeviceId,
    );
    if (!sourceLog) continue;
    const topApps = [...summary.apps.values()]
      .sort(
        (left, right) => right.durationMs - left.durationMs
          || left.title.localeCompare(right.title, 'zh-CN'),
      )
      .slice(0, 12);
    await input.transaction.runAsync(
      `INSERT INTO activity_day_summaries (
         id, date_key, origin_device_id, origin_platform,
         segments, total_duration_ms, top_apps_json,
         generated_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         segments = excluded.segments,
         total_duration_ms = excluded.total_duration_ms,
         top_apps_json = excluded.top_apps_json,
         generated_at = excluded.generated_at,
         updated_at = excluded.updated_at
       WHERE activity_day_summaries.segments IS NOT excluded.segments
          OR activity_day_summaries.total_duration_ms
             IS NOT excluded.total_duration_ms
          OR activity_day_summaries.top_apps_json
             IS NOT excluded.top_apps_json`,
      id,
      dateKey,
      originDeviceId,
      sourceLog.origin_platform,
      summary.segments,
      summary.totalDurationMs,
      JSON.stringify(topApps),
      input.now,
      input.now,
    );
  }
  for (const usage of dailyUsage.values()) {
    await input.transaction.runAsync(
      `INSERT INTO activity_daily_usage (
         id, rule_id, date_key, duration_ms,
         origin_device_id, origin_platform, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         duration_ms = excluded.duration_ms,
         updated_at = excluded.updated_at
       WHERE activity_daily_usage.duration_ms
         IS NOT excluded.duration_ms`,
      usage.id,
      usage.ruleId,
      usage.dateKey,
      usage.durationMs,
      usage.originDeviceId,
      usage.originPlatform,
      input.now,
    );
  }
  const summaryCutoff = oldestRetainedLocalDateKey(
    input.now,
    ACTIVITY_DAILY_SUMMARY_RETENTION_DAYS,
  );
  await input.transaction.runAsync(
    'DELETE FROM activity_day_summaries WHERE date_key < ?',
    summaryCutoff,
  );
  await input.transaction.runAsync(
    'DELETE FROM activity_daily_usage WHERE date_key < ?',
    summaryCutoff,
  );
}

async function prepareInitialActivityRows(input: {
  transaction: SQLite.SQLiteDatabase;
  identity: SyncDevicePublicIdentityV1;
  now: number;
  rawRetentionDays: number;
}) {
  const retentionMs = input.rawRetentionDays * 86_400_000;
  await input.transaction.runAsync(
    `UPDATE phone_activity_logs
     SET origin_device_id = COALESCE(origin_device_id, ?),
         origin_platform = COALESCE(origin_platform, ?),
         retention_until = MIN(
           COALESCE(retention_until, created_at + ?),
           created_at + ?
         )`,
    input.identity.deviceId,
    input.identity.platform,
    retentionMs,
    retentionMs,
  );
  const pruned = await input.transaction.runAsync(
    `DELETE FROM phone_activity_logs
     WHERE retention_until IS NOT NULL
       AND retention_until <= ?`,
    input.now,
  );
  await refreshDerivedActivityRows(input);
  return pruned.changes;
}

async function snapshotActivityRows(input: {
  transaction: SQLite.SQLiteDatabase;
  now: number;
}) {
  const before = await latestLocalSequence(input.transaction);
  let mutationCount = 0;
  for (const statement of ACTIVITY_OBSERVATIONS_BOOTSTRAP_INSERT_SQL) {
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
      'activity.observations bootstrap outbox 序列增量校验失败。',
    );
  }
  const inserted = await input.transaction.getAllAsync<{
    entity_type: string;
    entity_id: string;
    operation: string;
    payload_json: string;
  }>(
    `SELECT entity_type, entity_id, operation, payload_json
     FROM activity_sync_domain_outbox
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
        'activity.observations bootstrap 生成了无效 JSON。',
      );
    }
    assertActivityObservationsPayload(
      row.entity_type,
      row.entity_id,
      row.operation,
      payload,
    );
  }
  await input.transaction.runAsync(
    `INSERT OR IGNORE INTO activity_sync_entity_heads (
       entity_type, entity_id, revision_id, updated_at
     )
     SELECT entity_type, entity_id, revision_id, ?
     FROM activity_sync_domain_outbox
     WHERE local_sequence > ? AND local_sequence <= ?`,
    input.now,
    before,
    after,
  );
  return mutationCount;
}

async function refreshCapturedActivityRows(now: number) {
  const database = await ensureActivityObservationsCaptureSchema();
  let prunedReadingCount = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const retentionMs =
      ACTIVITY_DEFAULT_RAW_RETENTION_DAYS * 86_400_000;
    await transaction.runAsync(
      `UPDATE phone_activity_logs
       SET retention_until = MIN(
         COALESCE(retention_until, created_at + ?),
         created_at + ?
       )`,
      retentionMs,
      retentionMs,
    );
    const result = await transaction.runAsync(
      `DELETE FROM phone_activity_logs
       WHERE retention_until IS NOT NULL
         AND retention_until <= ?`,
      now,
    );
    prunedReadingCount = result.changes;
    await refreshDerivedActivityRows({ transaction, now });
  });
  return prunedReadingCount;
}

export async function bootstrapActivityObservationsForIdentity(input: {
  identity: SyncDevicePublicIdentityV1;
  now: number;
}): Promise<ActivityObservationsBootstrapRuntimeResult> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (
    input.identity.state !== 'active'
    || input.identity.revokedAt !== null
  ) {
    throw new Error(
      '只有 active 且未撤销的设备可以 bootstrap activity.observations。',
    );
  }
  assertTimestamp(input.now, 'activity observations bootstrap now');
  const settings = await loadPhoneActivityProactiveSettings();
  const database = await ensureActivityObservationsCaptureSchema();
  let status: 'already-complete' | 'completed' = 'completed';
  let wasAlreadyComplete = false;
  let mutationCount = 0;
  let prunedReadingCount = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const runtime = await transaction.getFirstAsync<RuntimeRow>(
      `SELECT capture_enabled, suppress_capture, vault_id,
              source_device_id, source_platform
       FROM activity_sync_runtime WHERE singleton_id = 1`,
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
        'activity.observations 已绑定另一 active vault/device，拒绝静默换绑。',
      );
    }
    if (runtime?.suppress_capture === 1) {
      throw new Error(
        'activity.observations 正在应用远端变更，不能 bootstrap。',
      );
    }
    await transaction.runAsync(
      `UPDATE activity_sync_runtime
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
      `SELECT completed_at FROM activity_sync_bootstrap_state
       WHERE adapter_id = ?
         AND bootstrap_version = ?
         AND vault_id = ?
         AND source_device_id = ?`,
      ACTIVITY_OBSERVATIONS_ADAPTER_ID,
      ACTIVITY_OBSERVATIONS_BOOTSTRAP_VERSION,
      input.identity.vaultId,
      input.identity.deviceId,
    );
    if (completed) {
      status = 'already-complete';
      wasAlreadyComplete = true;
    } else {
      await materializeCarePolicy({
        transaction,
        settings,
        platform: input.identity.platform,
        now: input.now,
      });
      prunedReadingCount = await prepareInitialActivityRows({
        transaction,
        identity: input.identity,
        now: input.now,
        rawRetentionDays: ACTIVITY_DEFAULT_RAW_RETENTION_DAYS,
      });
      mutationCount = await snapshotActivityRows({
        transaction,
        now: input.now,
      });
      await transaction.runAsync(
        `INSERT INTO activity_sync_bootstrap_state (
           adapter_id, bootstrap_version, vault_id,
           source_device_id, completed_at
         ) VALUES (?, ?, ?, ?, ?)`,
        ACTIVITY_OBSERVATIONS_ADAPTER_ID,
        ACTIVITY_OBSERVATIONS_BOOTSTRAP_VERSION,
        input.identity.vaultId,
        input.identity.deviceId,
        input.now,
      );
    }
    await transaction.runAsync(
      `UPDATE activity_sync_runtime
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
    prunedReadingCount = await refreshCapturedActivityRows(input.now);
  }
  return {
    status,
    mutationCount,
    captureEnabled: true,
    prunedReadingCount,
  };
}

export async function runActivityObservationsBootstrapRuntime(
  now = Date.now(),
): Promise<ActivityObservationsBootstrapRuntimeResult> {
  return runSerializedPhoneActivityDatabaseOperation(async () => {
    assertTimestamp(now, 'activity observations runtime now');
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) {
      await deactivateActivityObservationsCapture(now);
      return {
        status: 'no-current-device',
        mutationCount: 0,
        captureEnabled: false,
        prunedReadingCount: 0,
      };
    }
    await deactivateActivityObservationsCapture(now);
    return bootstrapActivityObservationsForIdentity({
      identity: currentDevice.identity,
      now,
    });
  });
}

type SummaryPreparationMode = 'automatic' | 'manual';

async function prepareActivitySummariesInDatabase(input: {
  database: SQLite.SQLiteDatabase;
  identity: SyncDevicePublicIdentityV1;
  mode: SummaryPreparationMode;
  now: number;
}) {
  let enqueued = 0;
  await input.database.withExclusiveTransactionAsync(async (transaction) => {
    const automaticScan = await transaction.getFirstAsync<{
      last_enqueued_at: number;
    }>(
      `SELECT last_enqueued_at
       FROM activity_sync_summary_checkpoints
       WHERE vault_id = ? AND source_device_id = ?
         AND entity_type = '__runtime__' AND entity_id = 'last-scan'`,
      input.identity.vaultId,
      input.identity.deviceId,
    );
    if (
      input.mode === 'automatic'
      && automaticScan
      && input.now - automaticScan.last_enqueued_at
        < ACTIVITY_OBSERVATIONS_SUMMARY_SHARE_INTERVAL_MS
    ) {
      return;
    }
    await refreshDerivedActivityRows({ transaction, now: input.now });
    const before = await latestLocalSequence(transaction);
    for (const statement of ACTIVITY_OBSERVATIONS_SUMMARY_CHECKPOINT_INSERT_SQL) {
      const result = await transaction.runAsync(
        statement,
        input.now,
        input.now,
        input.now,
        input.mode === 'manual' ? 1 : 0,
        input.now,
      );
      enqueued += result.changes;
    }
    const after = await latestLocalSequence(transaction);
    if (after - before !== enqueued) {
      throw new Error('activity.observations 汇总检查点序列校验失败。');
    }
    await transaction.runAsync(
      `DELETE FROM activity_sync_entity_heads
       WHERE EXISTS (
         SELECT 1 FROM activity_sync_domain_outbox AS pending
         WHERE pending.local_sequence > ?
           AND pending.local_sequence <= ?
           AND pending.entity_type = activity_sync_entity_heads.entity_type
           AND pending.entity_id = activity_sync_entity_heads.entity_id
       )`,
      before,
      after,
    );
    await transaction.runAsync(
      `INSERT OR IGNORE INTO activity_sync_entity_heads (
         entity_type, entity_id, revision_id, updated_at
       )
       SELECT entity_type, entity_id, revision_id, ?
       FROM activity_sync_domain_outbox
       WHERE local_sequence > ? AND local_sequence <= ?`,
      input.now,
      before,
      after,
    );
    await transaction.runAsync(
      `INSERT INTO activity_sync_summary_checkpoints (
         vault_id, source_device_id, entity_type, entity_id,
         payload_fingerprint, last_enqueued_at
       )
       SELECT vault_id, source_device_id, entity_type, entity_id,
              payload_json, ?
       FROM activity_sync_domain_outbox
       WHERE local_sequence > ? AND local_sequence <= ?
       ON CONFLICT(vault_id, source_device_id, entity_type, entity_id)
       DO UPDATE SET
         payload_fingerprint = excluded.payload_fingerprint,
         last_enqueued_at = excluded.last_enqueued_at`,
      input.now,
      before,
      after,
    );
    await transaction.runAsync(
      `INSERT INTO activity_sync_summary_checkpoints (
         vault_id, source_device_id, entity_type, entity_id,
         payload_fingerprint, last_enqueued_at
       ) VALUES (?, ?, '__runtime__', 'last-scan', '', ?)
       ON CONFLICT(vault_id, source_device_id, entity_type, entity_id)
       DO UPDATE SET last_enqueued_at = excluded.last_enqueued_at`,
      input.identity.vaultId,
      input.identity.deviceId,
      input.now,
    );
  });
  return enqueued;
}

export async function prepareActivityObservationSummariesForSync(input: {
  mode: SummaryPreparationMode;
  now?: number;
}) {
  return runSerializedPhoneActivityDatabaseOperation(async () => {
    const now = input.now ?? Date.now();
    assertTimestamp(now, 'activity observations summary now');
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) return 0;
    return prepareActivitySummariesInDatabase({
      database: await ensureActivityObservationsCaptureSchema(),
      identity: currentDevice.identity,
      mode: input.mode,
      now,
    });
  });
}

function emptyPromotionReport(): PromoteActivityObservationsOutboxReport {
  return { claimedCount: 0, dispatchedCount: 0, failed: [] };
}

export async function runActivityObservationsOutboxPromotionRuntime(input: {
  limit?: number;
  now?: number;
  refreshCapturedRows?: boolean;
  summaryMode?: SummaryPreparationMode;
} = {}): Promise<ActivityObservationsPromotionRuntimeResult> {
  return runSerializedPhoneActivityDatabaseOperation(async () => {
    const now = input.now ?? Date.now();
    assertTimestamp(now, 'activity observations promotion now');
    const recoveredLeaseCount =
      await recoverExpiredActivityObservationsOutboxLeases(now);
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) {
      return {
        status: 'no-current-device',
        recoveredLeaseCount,
        report: emptyPromotionReport(),
      };
    }
    if (input.refreshCapturedRows ?? true) {
      await prepareActivitySummariesInDatabase({
        database: await ensureActivityObservationsCaptureSchema(),
        identity: currentDevice.identity,
        mode: input.summaryMode ?? 'manual',
        now,
      });
    }
    const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
    const report = await promoteActivityObservationsDomainOutbox({
      identity: currentDevice.identity,
      leaseId: `activity-observations:${expoSyncRandomUuidV1()}`,
      now,
      limit: input.limit ?? 100,
      leaseDurationMs: ACTIVITY_OBSERVATIONS_CAPTURE_LEASE_MS,
      domainOutbox: activityObservationsDomainOutboxPort,
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
  });
}
