import * as SQLite from 'expo-sqlite';

import { openDatabaseImportSource, type DatabaseImportSource } from '../backup/sqliteBackupFiles';

import {
  ACTIVITY_DEFAULT_RAW_RETENTION_DAYS,
} from '../sync/syncActivityObservations';
import {
  ACTIVITY_OBSERVATIONS_DATABASE_CONFIGURATION_SQL,
  ACTIVITY_OBSERVATIONS_FULL_CAPTURE_SCHEMA_SQL,
  ACTIVITY_OBSERVATIONS_RESET_TECHNICAL_STATE_SQL,
} from '../sync/syncActivityObservationsSql';
import { isVisiblePhoneActivityLog } from './phoneActivityVisibility';
import type {
  PhoneActivityJealousyCandidate,
  PhoneActivityProactiveSettings,
} from '../proactive/phoneActivityRules';

import {
  loadNativePhoneActivityLogs,
  loadNativePhoneActivityLogsPageForRestore,
} from '../backend/phoneActivityNative';
import { observeRuntimeWorkload } from '../runtime/runtimeWorkloadDiagnostics';
import { runSerializedPhoneActivityDatabaseOperation } from './phoneActivityDatabaseQueue';

export type PhoneActivityLog = {
  id: string;
  device_id: string;
  kind: string;
  source: string;
  title: string;
  summary: string;
  started_at?: number | null;
  ended_at?: number | null;
  duration_ms: number;
  sensitive_level: string;
  created_at: number;
  origin_device_id?: string | null;
  origin_platform?: 'android' | 'windows' | null;
  retention_until?: number | null;
};

export type PhoneActivitySummary = {
  status: string;
  minutes: number;
  count: number;
  summary: string;
  updatedAt: number;
};

export type PhoneUsageAppSummary = {
  durationMs: number;
  segments: number;
  source: string;
  title: string;
};

export type PhoneUsageDaySummary = {
  dateKey: string;
  segments: number;
  topApps: PhoneUsageAppSummary[];
  totalDurationMs: number;
};

export type PhoneUsageSummary = {
  days: PhoneUsageDaySummary[];
  segmentCount: number;
  todayTopApps: PhoneUsageAppSummary[];
  updatedAt: number;
  weekTopApps: PhoneUsageAppSummary[];
};

type PhoneActivityRow = {
  id: string;
  device_id: string;
  kind: string;
  source: string;
  title: string;
  summary: string;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number;
  sensitive_level: string;
  created_at: number;
  origin_device_id: string | null;
  origin_platform: 'android' | 'windows' | null;
  retention_until: number | null;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

function fromRow(row: PhoneActivityRow): PhoneActivityLog {
  return {
    id: row.id,
    device_id: row.device_id,
    kind: row.kind,
    source: row.source,
    title: row.title,
    summary: row.summary,
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_ms: row.duration_ms,
    sensitive_level: row.sensitive_level,
    created_at: row.created_at,
    origin_device_id: row.origin_device_id,
    origin_platform: row.origin_platform,
    retention_until: row.retention_until,
  };
}

async function getDatabase() {
  if (!databasePromise) {
    const openingDatabasePromise = SQLite.openDatabaseAsync(
      'junluo-phone-activity.db',
    ).then(async (database) => {
      await database.execAsync(
        ACTIVITY_OBSERVATIONS_DATABASE_CONFIGURATION_SQL,
      );
      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS phone_activity_logs (
          id TEXT PRIMARY KEY NOT NULL,
          device_id TEXT NOT NULL DEFAULT 'junluo-android',
          kind TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          started_at INTEGER,
          ended_at INTEGER,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          sensitive_level TEXT NOT NULL DEFAULT 'normal',
          created_at INTEGER NOT NULL,
          origin_device_id TEXT,
          origin_platform TEXT,
          retention_until INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_phone_activity_created
          ON phone_activity_logs(created_at DESC);
      `);
      await database.execAsync(
        'ALTER TABLE phone_activity_logs ADD COLUMN origin_device_id TEXT;',
      ).catch(() => undefined);
      await database.execAsync(
        'ALTER TABLE phone_activity_logs ADD COLUMN origin_platform TEXT;',
      ).catch(() => undefined);
      await database.execAsync(
        'ALTER TABLE phone_activity_logs ADD COLUMN retention_until INTEGER;',
      ).catch(() => undefined);
      await database.execAsync(
        ACTIVITY_OBSERVATIONS_FULL_CAPTURE_SCHEMA_SQL,
      );
      return database;
    });
    const retryableDatabasePromise = openingDatabasePromise.catch(
      (error) => {
        if (databasePromise === retryableDatabasePromise) {
          databasePromise = undefined;
        }
        throw error;
      },
    );
    databasePromise = retryableDatabasePromise;
  }
  return databasePromise;
}

export async function getPhoneActivityDatabase() {
  return getDatabase();
}

function startOfTodayMs(now = new Date()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function localDateKey(value: number) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfLocalDayMs(value: number, dayOffset = 0) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date.getTime();
}

function addUsage(target: Map<string, PhoneUsageAppSummary>, log: PhoneActivityLog, durationMs: number) {
  const source = log.source?.trim() || '';
  const title = log.title?.trim() || log.summary?.trim() || source || '未知 App';
  if (!source || !isVisiblePhoneActivityLog(log)) return false;
  const key = source || title;
  const current = target.get(key) ?? { durationMs: 0, segments: 0, source, title };
  current.durationMs += durationMs;
  current.segments += 1;
  target.set(key, current);
  return true;
}

function sortedUsageApps(map: Map<string, PhoneUsageAppSummary>, limit = 6) {
  return Array.from(map.values())
    .filter((item) => item.durationMs > 0)
    .sort((a, b) => b.durationMs - a.durationMs || a.title.localeCompare(b.title, 'zh-CN'))
    .slice(0, limit);
}

async function savePhoneActivityLogs(logs: PhoneActivityLog[]) {
  if (!logs.length) return;
  await runSerializedPhoneActivityDatabaseOperation(async () => {
    const database = await getDatabase();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const runtime = await transaction.getFirstAsync<{
        capture_enabled: number;
        source_device_id: string | null;
        source_platform: 'android' | 'windows' | null;
      }>(
        `SELECT capture_enabled, source_device_id, source_platform
         FROM activity_sync_runtime WHERE singleton_id = 1`,
      );
      const settings = await transaction.getFirstAsync<{
        raw_retention_days: number;
      }>(
        `SELECT raw_retention_days
         FROM activity_care_settings WHERE id = 'global'`,
      );
      const runtimeOrigin = runtime?.capture_enabled === 1
        ? runtime
        : null;
      const retentionDays = Math.min(
        settings?.raw_retention_days
          ?? ACTIVITY_DEFAULT_RAW_RETENTION_DAYS,
        ACTIVITY_DEFAULT_RAW_RETENTION_DAYS,
      );
      for (let offset = 0; offset < logs.length; offset += 50) {
        const batch = logs.slice(offset, offset + 50);
        const parameters = batch.flatMap((log) => {
          const createdAt = log.created_at || Date.now();
          return [
            log.id,
            log.device_id || 'junluo-android',
            log.kind,
            log.source || '',
            log.title || '',
            log.summary || '',
            log.started_at ?? null,
            log.ended_at ?? null,
            log.duration_ms || 0,
            log.sensitive_level || 'normal',
            createdAt,
            log.origin_device_id ?? runtimeOrigin?.source_device_id ?? null,
            log.origin_platform ?? runtimeOrigin?.source_platform ?? null,
            log.retention_until
              ?? createdAt + retentionDays * 86_400_000,
          ];
        });
        await transaction.runAsync(
          `INSERT INTO phone_activity_logs (
             id, device_id, kind, source, title, summary,
             started_at, ended_at, duration_ms, sensitive_level, created_at,
             origin_device_id, origin_platform, retention_until
           ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
           ON CONFLICT(id) DO NOTHING`,
          ...parameters,
        );
      }
    });
  });
}

type PhoneActivityRestoreDrainIo = {
  loadPage: (afterCreatedAt: number, afterId: string, limit: number) => Promise<unknown[]>;
  saveLogs: (logs: PhoneActivityLog[]) => Promise<void>;
};

function requirePhoneActivityRestoreLog(value: unknown): PhoneActivityLog {
  if (!value || typeof value !== 'object') throw new Error('手机活动 staging 中存在无效记录。');
  const log = value as Partial<PhoneActivityLog>;
  if (
    typeof log.id !== 'string'
    || !log.id
    || typeof log.device_id !== 'string'
    || typeof log.kind !== 'string'
    || typeof log.source !== 'string'
    || typeof log.title !== 'string'
    || typeof log.summary !== 'string'
    || typeof log.duration_ms !== 'number'
    || !Number.isFinite(log.duration_ms)
    || typeof log.sensitive_level !== 'string'
    || typeof log.created_at !== 'number'
    || !Number.isFinite(log.created_at)
  ) {
    throw new Error('手机活动 staging 中存在字段不完整的记录。');
  }
  return log as PhoneActivityLog;
}

export async function drainNativePhoneActivityLogsForRestore(
  pageSize = 500,
  io: PhoneActivityRestoreDrainIo = {
    loadPage: loadNativePhoneActivityLogsPageForRestore,
    saveLogs: savePhoneActivityLogs,
  },
) {
  const safePageSize = Math.max(1, Math.min(1000, Math.round(pageSize)));
  let afterCreatedAt = -1;
  let afterId = '';
  let drained = 0;

  while (true) {
    const page = await io.loadPage(afterCreatedAt, afterId, safePageSize);
    if (page.length > safePageSize) throw new Error('手机活动恢复分页超过请求上限。');
    if (!page.length) return drained;
    const logs = page.map(requirePhoneActivityRestoreLog);
    for (const log of logs) {
      const advances = log.created_at > afterCreatedAt
        || (log.created_at === afterCreatedAt && log.id > afterId);
      if (!advances) throw new Error('手机活动恢复分页游标没有向前推进。');
      afterCreatedAt = log.created_at;
      afterId = log.id;
    }
    await io.saveLogs(logs);
    drained += logs.length;
    if (logs.length < safePageSize) return drained;
  }
}

export async function syncNativePhoneActivityLogs(
  sinceMs = 0,
  limit = 200,
  diagnosticParentToken?: number,
) {
  const loadLogs = () => loadNativePhoneActivityLogs(sinceMs, limit).catch(() => [] as PhoneActivityLog[]);
  const logs = diagnosticParentToken
    ? await observeRuntimeWorkload(
        'phone_activity.native_read',
        loadLogs,
        (items) => ({ itemCount: items.length }),
        { parentToken: diagnosticParentToken },
      )
    : await loadLogs();
  const persistLogs = () => savePhoneActivityLogs(logs);
  if (diagnosticParentToken) {
    await observeRuntimeWorkload(
      'phone_activity.sqlite_persist',
      persistLogs,
      () => ({ itemCount: logs.length }),
      { parentToken: diagnosticParentToken },
    );
  } else {
    await persistLogs();
  }
  return logs.length;
}

export async function loadPersistedPhoneActivityLogsBetween(since: number, through: number, limit = 1000) {
  const database = await getDatabase();
  return database.getAllAsync<Pick<PhoneActivityLog, 'id' | 'kind' | 'source' | 'title' | 'started_at' | 'ended_at' | 'created_at'>>(
    `SELECT id, kind, source, title, started_at, ended_at, created_at FROM phone_activity_logs
      WHERE COALESCE(started_at, ended_at, created_at) BETWEEN ? AND ?
      ORDER BY COALESCE(started_at, ended_at, created_at) DESC LIMIT ?`,
    since, through, Math.max(0, Math.min(1000, Math.floor(limit))),
  );
}

export async function loadPersistedPhoneUsageSegmentsOverlapping(
  since: number,
  through: number,
  limit = 1000,
) {
  if (!Number.isFinite(since) || !Number.isFinite(through) || through <= since) return [];
  const rows = await (await getDatabase()).getAllAsync<PhoneActivityRow>(
    `SELECT * FROM phone_activity_logs
     WHERE kind = 'foreground_app_duration'
       AND sensitive_level != 'blocked'
       AND COALESCE(started_at, created_at) < ?
       AND COALESCE(ended_at, COALESCE(started_at, created_at) + duration_ms) > ?
     ORDER BY COALESCE(ended_at, created_at) DESC
     LIMIT ?`,
    through,
    since,
    Math.max(1, Math.min(1000, Math.floor(limit))),
  );
  return rows.map(fromRow).filter(isVisiblePhoneActivityLog);
}

export async function loadRecentPhoneActivityLogs(limit = 20, diagnosticParentToken?: number, readOnly = false) {
  if (!readOnly) await syncNativePhoneActivityLogs(0, Math.max(limit, 100), diagnosticParentToken);
  const loadRows = async () => {
    const database = await getDatabase();
    return database.getAllAsync<PhoneActivityRow>(
      'SELECT * FROM phone_activity_logs ORDER BY created_at DESC LIMIT ?',
      limit,
    );
  };
  const rows = diagnosticParentToken
    ? await observeRuntimeWorkload(
        'phone_activity.summary_query',
        loadRows,
        (items) => ({ itemCount: items.length }),
        { parentToken: diagnosticParentToken },
      )
    : await loadRows();
  return rows.map(fromRow);
}

export async function loadTodayPhoneActivityLogs(limit = 100) {
  const since = startOfTodayMs();
  await syncNativePhoneActivityLogs(since, Math.max(limit, 200));
  const database = await getDatabase();
  const rows = await database.getAllAsync<PhoneActivityRow>(
    'SELECT * FROM phone_activity_logs WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?',
    since,
    limit,
  );
  return rows.map(fromRow);
}

export async function loadPhoneActivityLogsForDate(dateKey: string, limit = 100) {
  const [year, month, day] = dateKey.split('-').map((value) => Number(value));
  const since = new Date(year, month - 1, day).getTime();
  const until = new Date(year, month - 1, day + 1).getTime();
  const syncLimit = dateKey === localDateKey(Date.now()) ? Math.max(limit, 200) : 3000;
  await syncNativePhoneActivityLogs(since, syncLimit);
  const database = await getDatabase();
  const rows = await database.getAllAsync<PhoneActivityRow>(
    'SELECT * FROM phone_activity_logs WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?',
    since,
    until,
    limit,
  );
  return rows.map(fromRow);
}

export async function loadPhoneUsageSummary(days = 7, topAppLimit = 6): Promise<PhoneUsageSummary> {
  const safeDays = Math.max(1, Math.min(14, Math.round(days)));
  const now = Date.now();
  const todayStart = startOfTodayMs(new Date(now));
  const since = startOfLocalDayMs(todayStart, 1 - safeDays);
  await syncNativePhoneActivityLogs(since, 3000);
  const database = await getDatabase();
  const rows = await database.getAllAsync<PhoneActivityRow>(
    `SELECT * FROM phone_activity_logs
     WHERE kind = ? AND sensitive_level != ? AND (created_at >= ? OR ended_at >= ?)
     ORDER BY created_at DESC
     LIMIT ?`,
    'foreground_app_duration',
    'blocked',
    since,
    since,
    3000,
  );
  return buildPhoneUsageSummary(rows.map(fromRow), safeDays, now, topAppLimit);
}

// Both persisted and native fallback records use the same local-day accounting.
export function buildPhoneUsageSummary(logs: readonly PhoneActivityLog[], days = 7, now = Date.now(), topAppLimit = 6): PhoneUsageSummary {
  const safeDays = Math.max(1, Math.min(14, Math.round(days)));
  const todayStart = startOfTodayMs(new Date(now));
  const since = startOfLocalDayMs(todayStart, 1 - safeDays);
  const weekApps = new Map<string, PhoneUsageAppSummary>();
  const todayApps = new Map<string, PhoneUsageAppSummary>();
  const dayApps = new Map<string, Map<string, PhoneUsageAppSummary>>();
  const dayTotals = new Map<string, { segments: number; totalDurationMs: number }>();
  let segmentCount = 0;

  logs.forEach((log) => {
    if (log.kind !== 'foreground_app_duration' || log.sensitive_level === 'blocked') return;
    const rawStart = log.started_at ?? log.created_at;
    const rawEnd = log.ended_at ?? (rawStart + Math.max(0, log.duration_ms || 0));
    const start = Math.max(rawStart, since);
    const end = Math.min(rawEnd, now);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    let cursor = start;
    let counted = false;
    while (cursor < end) {
      const nextDayStart = startOfLocalDayMs(cursor, 1);
      const chunkEnd = Math.min(end, nextDayStart);
      const durationMs = chunkEnd - cursor;
      if (durationMs > 0) {
        const dateKey = localDateKey(cursor);
        const apps = dayApps.get(dateKey) ?? new Map<string, PhoneUsageAppSummary>();
        dayApps.set(dateKey, apps);
        const visible = addUsage(apps, log, durationMs);
        addUsage(weekApps, log, durationMs);
        if (cursor >= todayStart || chunkEnd > todayStart) {
          addUsage(todayApps, log, durationMs);
        }
        if (!visible) {
          cursor = chunkEnd;
          continue;
        }
        const total = dayTotals.get(dateKey) ?? { segments: 0, totalDurationMs: 0 };
        total.totalDurationMs += durationMs;
        if (!counted) {
          total.segments += 1;
          counted = true;
        }
        dayTotals.set(dateKey, total);
      }
      cursor = chunkEnd;
    }
    if (counted) segmentCount += 1;
  });

  const daySummaries: PhoneUsageDaySummary[] = Array.from({ length: safeDays }, (_, index) => {
    const dayStart = startOfLocalDayMs(todayStart, -index);
    const dateKey = localDateKey(dayStart);
    const total = dayTotals.get(dateKey) ?? { segments: 0, totalDurationMs: 0 };
    return {
      dateKey,
      segments: total.segments,
      topApps: sortedUsageApps(dayApps.get(dateKey) ?? new Map<string, PhoneUsageAppSummary>(), 2),
      totalDurationMs: total.totalDurationMs,
    };
  });

  return {
    days: daySummaries,
    segmentCount,
    todayTopApps: sortedUsageApps(todayApps, topAppLimit),
    updatedAt: now,
    weekTopApps: sortedUsageApps(weekApps, topAppLimit),
  };
}

export async function summarizePhoneActivity(
  minutes = 30,
  diagnosticParentToken?: number,
): Promise<PhoneActivitySummary | null> {
  const since = Date.now() - minutes * 60 * 1000;
  await syncNativePhoneActivityLogs(since, 120, diagnosticParentToken);
  const loadRows = async () => {
    const database = await getDatabase();
    return database.getAllAsync<PhoneActivityRow>(
      'SELECT * FROM phone_activity_logs WHERE created_at >= ? AND sensitive_level != ? ORDER BY created_at DESC LIMIT 20',
      since,
      'blocked',
    );
  };
  const rows = diagnosticParentToken
    ? await observeRuntimeWorkload(
        'phone_activity.summary_query',
        loadRows,
        (items) => ({ itemCount: items.length }),
        { parentToken: diagnosticParentToken },
      )
    : await loadRows();
  const visibleRows = rows.map(fromRow).filter(isVisiblePhoneActivityLog);
  const foreground = visibleRows.filter((row) => row.kind === 'foreground_app' || row.kind === 'foreground_app_duration');
  const names = Array.from(new Set(foreground.map((row) => row.title || row.source).filter(Boolean))).slice(0, 4);
  return {
    status: 'ok',
    minutes,
    count: visibleRows.length,
    summary: names.length ? `最近 ${minutes} 分钟看见：${names.join('、')}` : '最近没有可用的手机活动摘要',
    updatedAt: Date.now(),
  };
}

export async function exportPhoneActivityDatabase() {
  await syncNativePhoneActivityLogs(0, 500);
  const database = await getDatabase();
  return database.serializeAsync();
}

export async function importPhoneActivityDatabase(sourceFile: DatabaseImportSource) {
  await runSerializedPhoneActivityDatabaseOperation(async () => {
    if (databasePromise) {
      const openDatabase = await databasePromise;
      await openDatabase.closeAsync();
      databasePromise = undefined;
    }
    const source = await openDatabaseImportSource(sourceFile);
    const destination = await SQLite.openDatabaseAsync('junluo-phone-activity.db');
    try {
      await SQLite.backupDatabaseAsync({ sourceDatabase: source, destDatabase: destination });
    } finally {
      await source.closeAsync();
      await destination.closeAsync();
    }
    databasePromise = undefined;
    const importedDatabase = await getDatabase();
    await importedDatabase.execAsync(
      ACTIVITY_OBSERVATIONS_RESET_TECHNICAL_STATE_SQL,
    );
  });
}

export async function clearPhoneActivityDatabase() {
  await runSerializedPhoneActivityDatabaseOperation(async () => {
    const database = await getDatabase();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(`
        UPDATE activity_sync_runtime
        SET capture_enabled = 0, suppress_capture = 0;
        DELETE FROM activity_day_summaries;
        DELETE FROM activity_care_settings;
        DELETE FROM activity_care_rules;
        DELETE FROM activity_feedback;
        DELETE FROM activity_focus_triggers;
        DELETE FROM activity_daily_usage;
        DELETE FROM phone_activity_logs;
        ${ACTIVITY_OBSERVATIONS_RESET_TECHNICAL_STATE_SQL}
      `);
    });
  });
}

type ActivityCareSettingsRow = {
  enabled: number;
  jealousy_enabled: number;
};

type ActivityCareRuleRow = {
  id: string;
  rule_kind: 'blacklist' | 'jealousy' | 'whitelist';
  source: string;
  title: string;
  threshold_minutes: number;
  return_window_minutes: number | null;
  daily_limit_minutes: number | null;
};

type ActivityFeedbackRow = {
  id: string;
  source: string;
  title: string;
  reason: string;
  status: PhoneActivityJealousyCandidate['status'];
  created_at: number;
};

function scopedActivityPolicyId(
  platform: 'android' | 'windows',
  localId: string,
) {
  return `${platform}:${localId}`;
}

function localActivityPolicyId(
  platform: 'android' | 'windows',
  scopedId: string,
) {
  const prefix = `${platform}:`;
  return scopedId.startsWith(prefix)
    ? scopedId.slice(prefix.length)
    : scopedId;
}

export async function saveActivityCarePolicySnapshot(
  settings: PhoneActivityProactiveSettings,
  targetPlatform: 'android' | 'windows' = 'android',
  updatedAt = Date.now(),
) {
  await runSerializedPhoneActivityDatabaseOperation(async () => {
    const database = await getDatabase();
    await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `INSERT INTO activity_care_settings (
         id, enabled, jealousy_enabled, raw_retention_days, updated_at
       ) VALUES ('global', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         enabled = excluded.enabled,
         jealousy_enabled = excluded.jealousy_enabled,
         raw_retention_days = excluded.raw_retention_days,
         updated_at = excluded.updated_at`,
      settings.enabled ? 1 : 0,
      settings.jealousyEnabled ? 1 : 0,
      ACTIVITY_DEFAULT_RAW_RETENTION_DAYS,
      updatedAt,
    );
    const ruleIds = settings.rules.map((rule) => (
      scopedActivityPolicyId(targetPlatform, rule.id)
    ));
    const candidateIds = (settings.jealousyCandidateApps ?? []).map(
      (candidate) => scopedActivityPolicyId(targetPlatform, candidate.id),
    );
    const rulePlaceholders = ruleIds.map(() => '?').join(', ');
    const candidatePlaceholders = candidateIds.map(() => '?').join(', ');
    await transaction.runAsync(
      `DELETE FROM activity_care_rules
       WHERE target_platform = ?
       ${ruleIds.length ? `AND id NOT IN (${rulePlaceholders})` : ''}`,
      targetPlatform,
      ...ruleIds,
    );
    await transaction.runAsync(
      `DELETE FROM activity_feedback
       WHERE target_platform = ?
       ${candidateIds.length
        ? `AND id NOT IN (${candidatePlaceholders})`
        : ''}`,
      targetPlatform,
      ...candidateIds,
    );
    for (const rule of settings.rules) {
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
        scopedActivityPolicyId(targetPlatform, rule.id),
        rule.kind,
        targetPlatform,
        rule.source,
        rule.title,
        rule.thresholdMinutes,
        rule.returnWindowMinutes ?? null,
        rule.dailyLimitMinutes ?? null,
        updatedAt,
      );
    }
    for (const candidate of settings.jealousyCandidateApps ?? []) {
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
        scopedActivityPolicyId(targetPlatform, candidate.id),
        targetPlatform,
        candidate.source,
        candidate.title,
        candidate.reason,
        candidate.status,
        candidate.createdAt,
        updatedAt,
      );
      }
    });
  });
}

export async function loadActivityCarePolicySnapshot(
  targetPlatform: 'android' | 'windows' = 'android',
): Promise<PhoneActivityProactiveSettings> {
  const database = await getDatabase();
  const [settings, rules, candidates] = await Promise.all([
    database.getFirstAsync<ActivityCareSettingsRow>(
      `SELECT enabled, jealousy_enabled
       FROM activity_care_settings WHERE id = 'global'`,
    ),
    database.getAllAsync<ActivityCareRuleRow>(
      `SELECT id, rule_kind, source, title, threshold_minutes,
              return_window_minutes, daily_limit_minutes
       FROM activity_care_rules
       WHERE target_platform = ? ORDER BY id ASC`,
      targetPlatform,
    ),
    database.getAllAsync<ActivityFeedbackRow>(
      `SELECT id, source, title, reason, status, created_at
       FROM activity_feedback
       WHERE target_platform = ? ORDER BY created_at ASC, id ASC`,
      targetPlatform,
    ),
  ]);
  return {
    enabled: settings?.enabled !== 0,
    jealousyEnabled: settings?.jealousy_enabled === 1,
    jealousyCandidateApps: candidates.map((candidate) => ({
      id: localActivityPolicyId(targetPlatform, candidate.id),
      title: candidate.title,
      source: candidate.source,
      reason: candidate.reason,
      createdAt: candidate.created_at,
      status: candidate.status,
    })),
    rules: rules.map((rule) => ({
      id: localActivityPolicyId(targetPlatform, rule.id),
      kind: rule.rule_kind,
      title: rule.title,
      source: rule.source,
      thresholdMinutes: rule.threshold_minutes,
      returnWindowMinutes: rule.return_window_minutes ?? undefined,
      dailyLimitMinutes: rule.daily_limit_minutes ?? undefined,
    })),
  };
}
