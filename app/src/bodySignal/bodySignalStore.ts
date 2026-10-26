import * as SQLite from 'expo-sqlite';

import { openDatabaseImportSource, type DatabaseImportSource } from '../backup/sqliteBackupFiles';
import {
  BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS,
  type BodySignalHealthCollectionPolicyRecord,
  type BodySignalSamplingMethod,
} from '../sync/syncBodySignalHealth';
import {
  BODY_SIGNAL_HEALTH_RESET_TECHNICAL_STATE_SQL,
} from '../sync/syncBodySignalHealthSql';
import { initializeBodySignalDatabase } from './bodySignalDatabaseSchema';
import type {
  BodySignalConfidence,
  BodySignalKind,
  BodySignalProvider,
  StoredBodySignalReading,
} from './bodySignalTypes';
import {
  BODY_SIGNAL_SCHEDULED_SAMPLING_INTERVAL_MINUTES,
  BODY_SIGNAL_SCHEDULED_SAMPLING_MAX_WINDOW_SECONDS,
  defaultBodySignalScheduledSamplingSettings,
  type BodySignalScheduledSamplingSettings,
  type BodySignalScheduledSamplingWindow,
} from './bodySignalScheduledSampling';

type BodySignalReadingRow = {
  confidence: BodySignalConfidence;
  device_profile_id: string | null;
  id: string;
  kind: BodySignalKind;
  measured_at: number;
  source_device_name: string | null;
  source_provider: BodySignalProvider;
  unit: string;
  value: number;
};

type BodySignalSyncRuntimeRow = {
  source_device_id: string | null;
  source_platform: 'android' | 'windows' | null;
};

type BodySignalCollectionPolicyRow = {
  auto_measure_after_reconnect: number;
  auto_reconnect_enabled: number;
  preferred_device_alias: string | null;
  raw_retention_days: number;
  updated_at: number;
};

type BodySignalScheduledSamplingPolicyRow = {
  enabled: number;
  pause_until: number | null;
  updated_at: number;
};

type BodySignalScheduledSamplingWindowRow = {
  device_profile_id: string;
  duration_ms: number;
  ended_at: number;
  id: string;
  reading_count: number;
  reason: BodySignalScheduledSamplingWindow['reason'];
  requested_at: number;
  result: BodySignalScheduledSamplingWindow['result'];
  started_at: number | null;
  trigger: BodySignalScheduledSamplingWindow['trigger'];
};

const BODY_SIGNAL_DEDUPE_WINDOW_MS = 15 * 1000;
const DAY_MS = 86_400_000;
let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;
const readingSavedListeners = new Set<(reading: StoredBodySignalReading & { id: string }) => void>();

async function loadLegacyDeviceProfilesForMigration() {
  try {
    const [{ default: AsyncStorage }, registry] = await Promise.all([
      import('@react-native-async-storage/async-storage'),
      import('./device/bodySignalDeviceRegistry'),
    ]);
    const raw = await AsyncStorage.getItem(
      registry.BODY_SIGNAL_DEVICE_REGISTRY_STORAGE_KEY,
    );
    return registry.parseBodySignalDeviceRegistry(raw).profiles;
  } catch {
    return [];
  }
}

function makeId(kind: BodySignalKind, measuredAt: number) {
  return `body-signal-${kind}-${measuredAt}-${Math.random().toString(36).slice(2, 10)}`;
}

async function getDatabase() {
  if (!databasePromise) {
    let openedDatabase: SQLite.SQLiteDatabase | undefined;
    const initialization: Promise<SQLite.SQLiteDatabase> = Promise.all([
      SQLite.openDatabaseAsync('junluo-body-signal.db'),
      loadLegacyDeviceProfilesForMigration(),
    ]).then(async ([database, legacyProfiles]) => {
      openedDatabase = database;
      await initializeBodySignalDatabase(database, legacyProfiles);
      return database;
    }).catch(async (error: unknown) => {
      // Release this failed opening before allowing the next normal access to retry.
      try {
        await openedDatabase?.closeAsync();
      } catch {
        // Keep the original initialization error if cleanup also fails.
      }
      if (databasePromise === initialization) databasePromise = undefined;
      throw error;
    });
    databasePromise = initialization;
  }
  return databasePromise;
}

export async function getBodySignalDatabase() {
  return getDatabase();
}

export async function exportBodySignalDatabase() {
  const database = await getDatabase();
  return database.serializeAsync();
}

export async function importBodySignalDatabase(sourceFile: DatabaseImportSource) {
  if (databasePromise) {
    const openDatabase = await databasePromise;
    await openDatabase.closeAsync();
    databasePromise = undefined;
  }
  const source = await openDatabaseImportSource(sourceFile);
  const destination = await SQLite.openDatabaseAsync('junluo-body-signal.db');
  try {
    await SQLite.backupDatabaseAsync({ sourceDatabase: source, destDatabase: destination });
  } finally {
    await source.closeAsync();
    await destination.closeAsync();
  }
  databasePromise = undefined;
  const importedDatabase = await getDatabase();
  await importedDatabase.execAsync(
    BODY_SIGNAL_HEALTH_RESET_TECHNICAL_STATE_SQL,
  );
}

export async function clearBodySignalDatabase() {
  const database = await getDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.execAsync(`
      UPDATE body_signal_sync_runtime
      SET capture_enabled = 0, suppress_capture = 0;
      DELETE FROM body_signal_care_event_evidence;
      DELETE FROM body_signal_care_events;
      DELETE FROM body_signal_evaluation_cursors;
      DELETE FROM body_signal_discomfort_reports;
      DELETE FROM body_signal_context_observations;
      DELETE FROM body_signal_workout_reading_links;
      DELETE FROM body_signal_sleep_heart_rate_buckets;
      DELETE FROM body_signal_sleep_stages;
      DELETE FROM body_signal_sleep_sessions;
      DELETE FROM body_signal_activity_daily_summaries;
      DELETE FROM body_signal_activity_samples;
      DELETE FROM body_signal_workout_sessions;
      DELETE FROM body_signal_sync_cursors;
      DELETE FROM body_signal_companion_associations;
      DELETE FROM body_signal_sampling_windows;
      DELETE FROM body_signal_guardian_sampling_policy;
      DELETE FROM body_signal_device_capabilities;
      DELETE FROM body_signal_personal_baselines;
      DELETE FROM body_signal_care_summaries;
      DELETE FROM body_signal_readings;
      DELETE FROM body_signal_devices;
      DELETE FROM body_signal_collection_policy;
      ${BODY_SIGNAL_HEALTH_RESET_TECHNICAL_STATE_SQL}
    `);
  });
}

function fromRow(row: BodySignalReadingRow): StoredBodySignalReading {
  return {
    confidence: row.confidence,
    ...(row.device_profile_id ? { deviceProfileId: row.device_profile_id } : {}),
    kind: row.kind,
    measuredAt: row.measured_at,
    ...(row.source_device_name ? { sourceDeviceName: row.source_device_name } : {}),
    sourceProvider: row.source_provider,
    unit: row.unit,
    value: row.value,
  };
}

export async function saveBodySignalReading(reading: StoredBodySignalReading) {
  await persistBodySignalReading(reading);
}

export async function saveBodySignalGuardianReading(eventId: string, reading: StoredBodySignalReading) {
  const validHeartRate = reading.kind === 'heart_rate' && reading.sourceProvider === 'standard_gatt'
    && reading.unit === 'bpm' && reading.value > 0 && reading.value <= 300;
  const validBattery = reading.kind === 'battery' && reading.sourceProvider === 'mi_band_6'
    && reading.unit === '%' && Number.isInteger(reading.value) && reading.value >= 0 && reading.value <= 100;
  if (!eventId.trim() || !reading.deviceProfileId || (!validHeartRate && !validBattery)
    || !Number.isFinite(reading.measuredAt) || reading.measuredAt <= 0
    || !Number.isFinite(reading.value)) {
    throw new Error('invalid-guardian-reading');
  }
  return persistBodySignalReading(reading, `guardian:${eventId}`);
}

async function persistBodySignalReading(reading: StoredBodySignalReading, guardianId?: string): Promise<'saved' | 'already_saved'> {
  const database = await getDatabase();
  let savedReading: (StoredBodySignalReading & { id: string }) | undefined;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    if (guardianId) {
      const existing = await transaction.getFirstAsync<BodySignalReadingRow>(
        `SELECT id, kind, value, unit, measured_at, source_provider, device_profile_id, source_device_name, confidence
           FROM body_signal_readings WHERE id = ? OR (
             device_profile_id = ? AND kind = ? AND source_provider = ?
             AND measured_at = ? AND value = ? AND unit = ?)
           ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`,
        guardianId, reading.deviceProfileId ?? null, reading.kind, reading.sourceProvider,
        reading.measuredAt, reading.value, reading.unit, guardianId,
      );
      if (existing) {
        if (existing.device_profile_id !== reading.deviceProfileId || existing.kind !== reading.kind
          || existing.source_provider !== reading.sourceProvider || existing.measured_at !== reading.measuredAt
          || existing.value !== reading.value || existing.unit !== reading.unit) throw new Error('guardian-reading-conflict');
        return;
      }
    } else {
      const recentSameSource = await transaction.getAllAsync<BodySignalReadingRow>(
        `SELECT id, kind, value, unit, measured_at, source_provider,
                device_profile_id,
                source_device_name, confidence
           FROM body_signal_readings
          WHERE kind = ?
            AND source_provider = ?
            AND measured_at >= ?
          ORDER BY measured_at DESC
          LIMIT 20`,
        reading.kind,
        reading.sourceProvider,
        reading.measuredAt - BODY_SIGNAL_DEDUPE_WINDOW_MS,
      );
      const duplicate = recentSameSource.some((row) => (
        row.value === reading.value
        && (row.device_profile_id ?? undefined) === reading.deviceProfileId
        && (row.source_device_name ?? undefined) === reading.sourceDeviceName
      ));
      if (duplicate) return;
    }

    const now = Date.now();
    const runtime =
      await transaction.getFirstAsync<BodySignalSyncRuntimeRow>(
        `SELECT source_device_id, source_platform
         FROM body_signal_sync_runtime WHERE singleton_id = 1`,
      );
    const policy = await transaction.getFirstAsync<{
      raw_retention_days: number;
    }>(
      `SELECT raw_retention_days
       FROM body_signal_collection_policy WHERE id = 'global'`,
    );
    const originDeviceId = runtime?.source_device_id ?? null;
    const originPlatform = runtime?.source_platform ?? null;
    const retentionDays = Math.min(
      policy?.raw_retention_days
        ?? BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS,
      BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS,
    );
    const samplingMethod: BodySignalSamplingMethod = 'unknown';
    const id = guardianId ?? makeId(reading.kind, reading.measuredAt);

    await transaction.runAsync(
      `INSERT INTO body_signal_readings (
         id, kind, value, unit, measured_at,
         source_provider, source_device_name, confidence, created_at,
         received_at, origin_device_id, origin_platform,
         clock_confidence, sampling_method, retention_until,
         device_profile_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      reading.kind,
      reading.value,
      reading.unit,
      reading.measuredAt,
      reading.sourceProvider,
      reading.sourceDeviceName ?? null,
      reading.confidence,
      now,
      now,
      originDeviceId,
      originPlatform,
      'app-clock',
      samplingMethod,
      reading.measuredAt + retentionDays * DAY_MS,
      reading.deviceProfileId ?? null,
    );
    savedReading = { ...reading, id };

    if (!originDeviceId || !originPlatform) return;
    const dateKey = localDateKey(reading.measuredAt);
    const summaryId = [
      reading.kind,
      originDeviceId,
      dateKey,
    ].join(':');
    await transaction.runAsync(
      `INSERT INTO body_signal_care_summaries (
         id, date_key, kind, origin_device_id, origin_platform,
         sample_count, average, minimum, maximum,
         first_measured_at, last_measured_at, generated_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         sample_count = body_signal_care_summaries.sample_count + 1,
         average = (
           body_signal_care_summaries.average
             * body_signal_care_summaries.sample_count
           + excluded.average
         ) / (body_signal_care_summaries.sample_count + 1),
         minimum = MIN(
           body_signal_care_summaries.minimum,
           excluded.minimum
         ),
         maximum = MAX(
           body_signal_care_summaries.maximum,
           excluded.maximum
         ),
         first_measured_at = MIN(
           body_signal_care_summaries.first_measured_at,
           excluded.first_measured_at
         ),
         last_measured_at = MAX(
           body_signal_care_summaries.last_measured_at,
           excluded.last_measured_at
         ),
         generated_at = excluded.generated_at,
         updated_at = excluded.updated_at`,
      summaryId,
      dateKey,
      reading.kind,
      originDeviceId,
      originPlatform,
      reading.value,
      reading.value,
      reading.value,
      reading.measuredAt,
      reading.measuredAt,
      now,
      now,
    );
  });
  if (savedReading) {
    const emittedReading = savedReading;
    readingSavedListeners.forEach((listener) => listener(emittedReading));
  }
  return savedReading ? 'saved' : 'already_saved';
}

function localDateKey(time: number) {
  const date = new Date(time);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function loadBodySignalCollectionPolicyRecord():
Promise<BodySignalHealthCollectionPolicyRecord | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<BodySignalCollectionPolicyRow>(
    `SELECT auto_measure_after_reconnect, auto_reconnect_enabled,
            preferred_device_alias, raw_retention_days, updated_at
     FROM body_signal_collection_policy WHERE id = 'global'`,
  );
  if (!row) return null;
  return {
    id: 'global',
    autoMeasureAfterReconnect: row.auto_measure_after_reconnect === 1,
    autoReconnectEnabled: row.auto_reconnect_enabled === 1,
    preferredDeviceAlias: row.preferred_device_alias,
    rawRetentionDays: row.raw_retention_days,
    updatedAt: row.updated_at,
  };
}

export async function saveBodySignalCollectionPolicyRecord(
  policy: Omit<BodySignalHealthCollectionPolicyRecord, 'id'>,
) {
  const database = await getDatabase();
  await database.runAsync(
    `INSERT INTO body_signal_collection_policy (
       id, auto_measure_after_reconnect, auto_reconnect_enabled,
       preferred_device_alias, raw_retention_days, updated_at
     ) VALUES ('global', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       auto_measure_after_reconnect =
         excluded.auto_measure_after_reconnect,
       auto_reconnect_enabled = excluded.auto_reconnect_enabled,
       preferred_device_alias = excluded.preferred_device_alias,
       raw_retention_days = excluded.raw_retention_days,
       updated_at = excluded.updated_at`,
    policy.autoMeasureAfterReconnect ? 1 : 0,
    policy.autoReconnectEnabled ? 1 : 0,
    policy.preferredDeviceAlias,
    policy.rawRetentionDays,
    policy.updatedAt,
  );
}

export async function loadScheduledSamplingSettings(): Promise<BodySignalScheduledSamplingSettings> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<BodySignalScheduledSamplingPolicyRow>(
    `SELECT enabled, pause_until, updated_at
       FROM body_signal_guardian_sampling_policy
      WHERE singleton_id = 1`,
  );
  if (!row) return defaultBodySignalScheduledSamplingSettings();
  return {
    enabled: row.enabled === 1,
    intervalMinutes: BODY_SIGNAL_SCHEDULED_SAMPLING_INTERVAL_MINUTES,
    maxWindowSeconds: BODY_SIGNAL_SCHEDULED_SAMPLING_MAX_WINDOW_SECONDS,
    ...(row.pause_until ? { pauseUntil: row.pause_until } : {}),
    updatedAt: row.updated_at,
  };
}

export async function saveScheduledSamplingSettings(
  settings: Pick<BodySignalScheduledSamplingSettings, 'enabled' | 'pauseUntil'>,
): Promise<BodySignalScheduledSamplingSettings> {
  const database = await getDatabase();
  const updatedAt = Date.now();
  await database.runAsync(
    `INSERT INTO body_signal_guardian_sampling_policy (
       singleton_id, enabled, pause_until, updated_at
     ) VALUES (1, ?, ?, ?)
     ON CONFLICT(singleton_id) DO UPDATE SET
       enabled = excluded.enabled,
       pause_until = excluded.pause_until,
       updated_at = excluded.updated_at`,
    settings.enabled ? 1 : 0,
    settings.pauseUntil ?? null,
    updatedAt,
  );
  return {
    enabled: settings.enabled,
    intervalMinutes: BODY_SIGNAL_SCHEDULED_SAMPLING_INTERVAL_MINUTES,
    maxWindowSeconds: BODY_SIGNAL_SCHEDULED_SAMPLING_MAX_WINDOW_SECONDS,
    ...(settings.pauseUntil ? { pauseUntil: settings.pauseUntil } : {}),
    updatedAt,
  };
}

export async function saveScheduledSamplingWindow(
  window: BodySignalScheduledSamplingWindow,
): Promise<void> {
  const database = await getDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `INSERT INTO body_signal_sampling_windows (
         id, device_profile_id, trigger, reason, result,
         requested_at, started_at, ended_at,
         reading_count, duration_ms, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      window.id,
      window.deviceProfileId,
      window.trigger,
      window.reason,
      window.result,
      window.requestedAt,
      window.startedAt ?? null,
      window.endedAt,
      window.readingCount,
      window.durationMs,
      Date.now(),
    );
    await transaction.runAsync(
      `DELETE FROM body_signal_sampling_windows
        WHERE id NOT IN (
          SELECT id FROM body_signal_sampling_windows
          ORDER BY ended_at DESC, id DESC
          LIMIT 512
        )`,
    );
  });
}

export function subscribeBodySignalReadingSaved(
  listener: (reading: StoredBodySignalReading & { id: string }) => void,
): () => void {
  readingSavedListeners.add(listener);
  return () => readingSavedListeners.delete(listener);
}

export async function loadRecentScheduledSamplingWindows(
  limit: number,
): Promise<BodySignalScheduledSamplingWindow[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<BodySignalScheduledSamplingWindowRow>(
    `SELECT id, device_profile_id, trigger, reason, result,
            requested_at, started_at, ended_at, reading_count, duration_ms
       FROM body_signal_sampling_windows
      ORDER BY ended_at DESC, id DESC
      LIMIT ?`,
    Math.max(0, Math.min(512, Math.floor(limit))),
  );
  return rows.map((row) => ({
    deviceProfileId: row.device_profile_id,
    durationMs: row.duration_ms,
    endedAt: row.ended_at,
    id: row.id,
    readingCount: row.reading_count,
    reason: row.reason,
    requestedAt: row.requested_at,
    result: row.result,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    trigger: row.trigger,
  }));
}

export async function loadLatestBodySignalReading(kind: BodySignalKind, deviceProfileId?: string, sourceProvider?: BodySignalProvider) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<BodySignalReadingRow>(
    `SELECT id, kind, value, unit, measured_at, source_provider, source_device_name,
            confidence, device_profile_id
       FROM body_signal_readings
      WHERE kind = ?${deviceProfileId ? ' AND device_profile_id = ?' : ''}${sourceProvider ? ' AND source_provider = ?' : ''}
      ORDER BY measured_at DESC
      LIMIT 1`,
    kind,
    ...(deviceProfileId ? [deviceProfileId] : []),
    ...(sourceProvider ? [sourceProvider] : []),
  );
  return row ? fromRow(row) : undefined;
}

export async function loadBodySignalReadingRecordById(id: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<BodySignalReadingRow>(
    `SELECT id, kind, value, unit, measured_at, source_provider, source_device_name,
            confidence, device_profile_id
       FROM body_signal_readings WHERE id = ?`,
    id,
  );
  return row ? { ...fromRow(row), id: row.id } : undefined;
}

export async function loadBodySignalReadingsAt(kind: BodySignalKind, measuredAt: number) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<BodySignalReadingRow>(
    `SELECT id, kind, value, unit, measured_at, source_provider, source_device_name,
            confidence, device_profile_id
       FROM body_signal_readings WHERE kind = ? AND measured_at = ?`,
    kind, measuredAt,
  );
  return rows.map(fromRow);
}

export async function loadRecentBodySignalReadings(kind: BodySignalKind, limit: number) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<BodySignalReadingRow>(
    `SELECT id, kind, value, unit, measured_at, source_provider, source_device_name,
            confidence, device_profile_id
       FROM body_signal_readings
      WHERE kind = ?
      ORDER BY measured_at DESC
      LIMIT ?`,
    kind,
    Math.max(0, Math.floor(limit)),
  );
  return rows.map(fromRow);
}

export async function loadBodySignalReadingsSince(kind: BodySignalKind, since: number) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<BodySignalReadingRow>(
    `SELECT id, kind, value, unit, measured_at, source_provider, source_device_name,
            confidence, device_profile_id
       FROM body_signal_readings
      WHERE kind = ?
        AND measured_at >= ?
      ORDER BY measured_at DESC`,
    kind,
    since,
  );
  return rows.map(fromRow);
}

export async function loadBodySignalReadingRecordsSince(
  kind: BodySignalKind,
  since: number,
  localLiveOnly = false,
): Promise<Array<StoredBodySignalReading & { id: string }>> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<BodySignalReadingRow>(
    `SELECT id, kind, value, unit, measured_at, source_provider, source_device_name,
            confidence, device_profile_id
       FROM body_signal_readings
      WHERE kind = ? AND measured_at >= ?
        ${localLiveOnly ? `AND source_provider = 'standard_gatt'
          AND (origin_device_id IS NULL OR origin_device_id =
            (SELECT source_device_id FROM body_signal_sync_runtime WHERE singleton_id = 1))` : ''}
      ORDER BY measured_at ASC, id ASC`,
    kind,
    since,
  );
  return rows.map((row) => ({ ...fromRow(row), id: row.id }));
}
