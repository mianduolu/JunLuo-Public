import type * as SQLite from 'expo-sqlite';

import {
  runSerializedPhoneActivityDatabaseOperation,
} from '../phoneActivity/phoneActivityDatabaseQueue';
import type {
  ActivityObservationsBusinessPort,
} from './syncActivityObservationsApply';
import {
  assertActivityObservationsRecord,
  activityObservationsLocalId,
  type ActivityCareRuleRecord,
  type ActivityCareSettingsRecord,
  type ActivityDailyUsageRecord,
  type ActivityDaySummaryRecord,
  type ActivityFeedbackRecord,
  type ActivityFocusTriggerRecord,
  type ActivityObservationsRecord,
  type ActivityObservationsRecordKind,
  type ActivityReadingRecord,
} from './syncActivityObservations';

type SqlTransaction = Pick<
  SQLite.SQLiteDatabase,
  'getFirstAsync' | 'runAsync'
>;

type ReadingIdentityRow = {
  id: string;
  kind: string;
  source: string;
  title: string;
  summary: string;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number;
  sensitive_level: string;
  origin_device_id: string | null;
  origin_platform: string | null;
  retention_until: number | null;
  created_at: number;
};

function sameReading(
  row: ReadingIdentityRow,
  record: ActivityReadingRecord,
) {
  return (
    row.id === record.id
    && row.kind === record.readingKind
    && row.source === record.source
    && row.title === record.title
    && row.summary === record.summary
    && row.started_at === record.startedAt
    && row.ended_at === record.endedAt
    && row.duration_ms === record.durationMs
    && row.sensitive_level === record.sensitivityLabel
    && row.origin_device_id === record.originDeviceId
    && row.origin_platform === record.originPlatform
    && row.retention_until === record.retentionUntil
    && row.created_at === record.createdAt
  );
}

async function applyReading(
  transaction: SqlTransaction,
  record: ActivityReadingRecord,
) {
  const result = await transaction.runAsync(
    `INSERT OR IGNORE INTO phone_activity_logs (
       id, device_id, kind, source, title, summary,
       started_at, ended_at, duration_ms, sensitive_level, created_at,
       origin_device_id, origin_platform, retention_until
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    record.id,
    record.originDeviceId,
    record.readingKind,
    record.source,
    record.title,
    record.summary,
    record.startedAt,
    record.endedAt,
    record.durationMs,
    record.sensitivityLabel,
    record.createdAt,
    record.originDeviceId,
    record.originPlatform,
    record.retentionUntil,
  );
  if (result.changes === 1) return;
  const existing = await transaction.getFirstAsync<ReadingIdentityRow>(
    `SELECT id, kind, source, title, summary,
            started_at, ended_at, duration_ms, sensitive_level,
            origin_device_id, origin_platform, retention_until, created_at
     FROM phone_activity_logs WHERE id = ?`,
    record.id,
  );
  if (!existing || !sameReading(existing, record)) {
    throw new Error(
      'activity.observations reading append identity 冲突。',
    );
  }
}

async function applyDaySummary(
  transaction: SqlTransaction,
  record: ActivityDaySummaryRecord,
) {
  await transaction.runAsync(
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
       updated_at = excluded.updated_at`,
    record.id,
    record.dateKey,
    record.originDeviceId,
    record.originPlatform,
    record.segments,
    record.totalDurationMs,
    JSON.stringify(record.topApps),
    record.generatedAt,
    record.updatedAt,
  );
}

async function applyCareSettings(
  transaction: SqlTransaction,
  record: ActivityCareSettingsRecord,
) {
  await transaction.runAsync(
    `INSERT INTO activity_care_settings (
       id, enabled, jealousy_enabled, raw_retention_days, updated_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       jealousy_enabled = excluded.jealousy_enabled,
       raw_retention_days = excluded.raw_retention_days,
       updated_at = excluded.updated_at`,
    record.id,
    record.enabled ? 1 : 0,
    record.jealousyEnabled ? 1 : 0,
    record.rawRetentionDays,
    record.updatedAt,
  );
}

async function applyCareRule(
  transaction: SqlTransaction,
  record: ActivityCareRuleRecord,
) {
  await transaction.runAsync(
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
    record.id,
    record.ruleKind,
    record.targetPlatform,
    record.source,
    record.title,
    record.thresholdMinutes,
    record.returnWindowMinutes,
    record.dailyLimitMinutes,
    record.updatedAt,
  );
}

async function applyFeedback(
  transaction: SqlTransaction,
  record: ActivityFeedbackRecord,
) {
  await transaction.runAsync(
    `INSERT INTO activity_feedback (
       id, target_platform, source, title, reason,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       reason = excluded.reason,
       status = excluded.status,
       updated_at = excluded.updated_at`,
    record.id,
    record.targetPlatform,
    record.source,
    record.title,
    record.reason,
    record.status,
    record.createdAt,
    record.updatedAt,
  );
}

async function applyFocusTrigger(
  transaction: SqlTransaction,
  record: ActivityFocusTriggerRecord,
) {
  await transaction.runAsync(
    `INSERT INTO activity_focus_triggers (
       id, rule_id, rule_kind, trigger_kind, reason, event_stage,
       app_source, app_title, duration_ms, stage, outcome,
       origin_device_id, origin_platform, triggered_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       outcome = excluded.outcome,
       updated_at = excluded.updated_at`,
    record.id,
    record.ruleId,
    record.ruleKind,
    record.triggerKind,
    record.reason,
    record.eventStage,
    record.appSource,
    record.appTitle,
    record.durationMs,
    record.stage,
    record.outcome,
    record.originDeviceId,
    record.originPlatform,
    record.triggeredAt,
    record.updatedAt,
  );
}

async function applyDailyUsage(
  transaction: SqlTransaction,
  record: ActivityDailyUsageRecord,
) {
  await transaction.runAsync(
    `INSERT INTO activity_daily_usage (
       id, rule_id, date_key, duration_ms,
       origin_device_id, origin_platform, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       duration_ms = excluded.duration_ms,
       updated_at = excluded.updated_at`,
    record.id,
    record.ruleId,
    record.dateKey,
    record.durationMs,
    record.originDeviceId,
    record.originPlatform,
    record.updatedAt,
  );
}

export async function applyActivityObservationsRecordToSqlite(input: {
  transaction: SqlTransaction;
  kind: ActivityObservationsRecordKind;
  entityId: string;
  record: ActivityObservationsRecord;
}) {
  assertActivityObservationsRecord(
    input.kind,
    input.entityId,
    input.record,
  );
  if (input.kind === 'activity-reading') {
    await applyReading(
      input.transaction,
      input.record as ActivityReadingRecord,
    );
  } else if (input.kind === 'activity-day-summary') {
    await applyDaySummary(
      input.transaction,
      input.record as ActivityDaySummaryRecord,
    );
  } else if (input.kind === 'activity-care-settings') {
    await applyCareSettings(
      input.transaction,
      input.record as ActivityCareSettingsRecord,
    );
  } else if (input.kind === 'activity-care-rule') {
    await applyCareRule(
      input.transaction,
      input.record as ActivityCareRuleRecord,
    );
  } else if (input.kind === 'activity-feedback') {
    await applyFeedback(
      input.transaction,
      input.record as ActivityFeedbackRecord,
    );
  } else if (input.kind === 'activity-focus-trigger') {
    await applyFocusTrigger(
      input.transaction,
      input.record as ActivityFocusTriggerRecord,
    );
  } else {
    await applyDailyUsage(
      input.transaction,
      input.record as ActivityDailyUsageRecord,
    );
  }
}

export async function deleteActivityObservationsRecordFromSqlite(input: {
  transaction: SqlTransaction;
  kind: ActivityObservationsRecordKind;
  entityId: string;
}) {
  const localId = activityObservationsLocalId(
    input.kind,
    input.entityId,
  );
  const tables: Record<ActivityObservationsRecordKind, string> = {
    'activity-reading': 'phone_activity_logs',
    'activity-day-summary': 'activity_day_summaries',
    'activity-care-settings': 'activity_care_settings',
    'activity-care-rule': 'activity_care_rules',
    'activity-feedback': 'activity_feedback',
    'activity-focus-trigger': 'activity_focus_triggers',
    'activity-daily-usage': 'activity_daily_usage',
  };
  await input.transaction.runAsync(
    `DELETE FROM ${tables[input.kind]} WHERE id = ?`,
    localId,
  );
}

async function runSuppressed<T>(
  apply: (transaction: SQLite.SQLiteDatabase) => Promise<T>,
) {
  return runSerializedPhoneActivityDatabaseOperation(async () => {
    const { runWithActivityObservationsCaptureSuppressed } =
      await import('./syncActivityObservationsSqlitePort');
    return runWithActivityObservationsCaptureSuppressed(apply);
  });
}

async function mirrorCarePolicy() {
  const { loadActivityCarePolicySnapshot } =
    await import('../phoneActivity/phoneActivityStore');
  const { mirrorPhoneActivityProactiveSettings } =
    await import('../proactive/phoneActivityRules');
  await mirrorPhoneActivityProactiveSettings(
    await loadActivityCarePolicySnapshot(),
  );
}

function isCarePolicyKind(kind: ActivityObservationsRecordKind) {
  return (
    kind === 'activity-care-settings'
    || kind === 'activity-care-rule'
    || kind === 'activity-feedback'
  );
}

export const activityObservationsSqliteBusinessPort:
ActivityObservationsBusinessPort = {
  upsertRecord: async (input) => {
    await runSuppressed(async (transaction) => {
      await applyActivityObservationsRecordToSqlite({
        transaction,
        kind: input.kind,
        entityId: input.entityId,
        record: input.record,
      });
    });
    if (isCarePolicyKind(input.kind)) await mirrorCarePolicy();
  },
  deleteRecord: async (input) => {
    await runSuppressed(async (transaction) => {
      await deleteActivityObservationsRecordFromSqlite({
        transaction,
        kind: input.kind,
        entityId: input.entityId,
      });
    });
    if (isCarePolicyKind(input.kind)) await mirrorCarePolicy();
  },
};
