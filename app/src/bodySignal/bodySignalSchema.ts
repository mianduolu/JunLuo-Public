import type { SQLiteDatabase } from 'expo-sqlite';

import type { BodySignalDeviceProfile } from './device/bodySignalDeviceTypes';

export const BODY_SIGNAL_BUSINESS_SCHEMA_VERSION = 8;

export const BODY_SIGNAL_STRUCTURED_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS body_signal_sleep_heart_rate_buckets (
    device_profile_id TEXT NOT NULL,
    wake_date_key TEXT NOT NULL,
    bucket_started_at INTEGER NOT NULL CHECK (bucket_started_at > 0 AND bucket_started_at % 300000 = 0),
    value REAL NOT NULL CHECK (value > 0),
    reading_count INTEGER NOT NULL CHECK (reading_count > 0),
    sleep_provider TEXT NOT NULL CHECK (sleep_provider = 'mi_band_6'),
    heart_rate_provider TEXT NOT NULL CHECK (heart_rate_provider = 'standard_gatt'),
    algorithm_version TEXT NOT NULL CHECK (algorithm_version = 'mi-band-6-sleep-v2'),
    source_key TEXT NOT NULL,
    unreviewed INTEGER NOT NULL DEFAULT 0 CHECK (unreviewed IN (0, 1)),
    PRIMARY KEY (device_profile_id, wake_date_key, bucket_started_at),
    FOREIGN KEY (device_profile_id) REFERENCES body_signal_devices(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_body_signal_sleep_heart_rate_expiry
    ON body_signal_sleep_heart_rate_buckets(bucket_started_at);

  CREATE TABLE IF NOT EXISTS body_signal_business_schema_meta (
    singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
    schema_version INTEGER NOT NULL,
    migrated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS body_signal_devices (
    id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    family TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    authorized_association_id TEXT,
    last_advertising_id TEXT,
    protocol_identity TEXT,
    service_fingerprint TEXT,
    transport_identity TEXT,
    last_connected_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    retired_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_body_signal_devices_one_primary
    ON body_signal_devices(is_primary)
    WHERE is_primary = 1 AND retired_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_body_signal_devices_last_connected
    ON body_signal_devices(last_connected_at DESC);

  CREATE TABLE IF NOT EXISTS body_signal_device_capabilities (
    device_profile_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    support_level TEXT NOT NULL,
    evidence_id TEXT,
    verified_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (device_profile_id, capability),
    FOREIGN KEY (device_profile_id) REFERENCES body_signal_devices(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS body_signal_companion_associations (
    association_id INTEGER PRIMARY KEY NOT NULL,
    device_profile_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'revoked', 'unsupported')),
    observation_enabled INTEGER NOT NULL DEFAULT 0 CHECK (observation_enabled IN (0, 1)),
    last_appeared_at INTEGER,
    last_disappeared_at INTEGER,
    last_error_code TEXT,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (device_profile_id) REFERENCES body_signal_devices(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_body_signal_companion_device
    ON body_signal_companion_associations(device_profile_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS body_signal_guardian_sampling_policy (
    singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    pause_until INTEGER,
    updated_at INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO body_signal_guardian_sampling_policy (
    singleton_id, enabled, pause_until, updated_at
  ) VALUES (1, 0, NULL, 0);

  CREATE TABLE IF NOT EXISTS body_signal_sampling_windows (
    id TEXT PRIMARY KEY NOT NULL,
    device_profile_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    reason TEXT NOT NULL,
    result TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER NOT NULL,
    reading_count INTEGER NOT NULL DEFAULT 0 CHECK (reading_count >= 0),
    duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    created_at INTEGER NOT NULL,
    FOREIGN KEY (device_profile_id) REFERENCES body_signal_devices(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_body_signal_sampling_windows_time
    ON body_signal_sampling_windows(ended_at DESC);

  CREATE TABLE IF NOT EXISTS body_signal_sync_cursors (
    device_profile_id TEXT NOT NULL,
    source_provider TEXT NOT NULL,
    stream TEXT NOT NULL,
    cursor TEXT,
    synced_through_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (device_profile_id, source_provider, stream),
    FOREIGN KEY (device_profile_id) REFERENCES body_signal_devices(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS body_signal_activity_samples (
    id TEXT PRIMARY KEY NOT NULL,
    device_profile_id TEXT NOT NULL,
    source_provider TEXT NOT NULL,
    provider_sample_key TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL CHECK (ended_at >= started_at),
    steps INTEGER CHECK (steps IS NULL OR steps >= 0),
    distance_meters REAL CHECK (distance_meters IS NULL OR distance_meters >= 0),
    calories_kcal REAL CHECK (calories_kcal IS NULL OR calories_kcal >= 0),
    intensity REAL CHECK (intensity IS NULL OR intensity >= 0),
    heart_rate REAL CHECK (heart_rate IS NULL OR heart_rate > 0),
    summary_date_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (device_profile_id, source_provider, provider_sample_key),
    FOREIGN KEY (device_profile_id) REFERENCES body_signal_devices(id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_body_signal_activity_device_time
    ON body_signal_activity_samples(device_profile_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS body_signal_activity_daily_summaries (
    id TEXT PRIMARY KEY NOT NULL,
    device_profile_id TEXT NOT NULL,
    source_provider TEXT NOT NULL,
    date_key TEXT NOT NULL,
    steps INTEGER NOT NULL DEFAULT 0 CHECK (steps >= 0),
    distance_meters REAL CHECK (distance_meters IS NULL OR distance_meters >= 0),
    calories_kcal REAL CHECK (calories_kcal IS NULL OR calories_kcal >= 0),
    active_minutes INTEGER NOT NULL DEFAULT 0 CHECK (active_minutes >= 0),
    sedentary_minutes INTEGER NOT NULL DEFAULT 0 CHECK (sedentary_minutes >= 0),
    sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
    summary_version INTEGER NOT NULL DEFAULT 0,
    day_started_at INTEGER,
    day_ended_at INTEGER,
    timezone_id TEXT,
    first_sample_at INTEGER,
    last_sample_at INTEGER,
    sealed_through_at INTEGER,
    coverage_uncertain INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE (device_profile_id, source_provider, date_key),
    FOREIGN KEY (device_profile_id) REFERENCES body_signal_devices(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS body_signal_sleep_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    device_profile_id TEXT NOT NULL,
    source_provider TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL CHECK (ended_at >= started_at),
    total_minutes INTEGER NOT NULL CHECK (total_minutes >= 0),
    confidence TEXT NOT NULL,
    wake_date_key TEXT,
    algorithm_version TEXT,
    context_eligible INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (device_profile_id) REFERENCES body_signal_devices(id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_body_signal_sleep_device_time
    ON body_signal_sleep_sessions(device_profile_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS body_signal_sleep_stages (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    stage TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL CHECK (ended_at >= started_at),
    UNIQUE (session_id, sequence),
    FOREIGN KEY (session_id) REFERENCES body_signal_sleep_sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS body_signal_workout_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    device_profile_id TEXT NOT NULL,
    source_provider TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= started_at),
    steps INTEGER CHECK (steps IS NULL OR steps >= 0),
    distance_meters REAL CHECK (distance_meters IS NULL OR distance_meters >= 0),
    calories_kcal REAL CHECK (calories_kcal IS NULL OR calories_kcal >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (device_profile_id) REFERENCES body_signal_devices(id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_body_signal_workout_device_time
    ON body_signal_workout_sessions(device_profile_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS body_signal_workout_reading_links (
    workout_session_id TEXT NOT NULL,
    reading_id TEXT NOT NULL,
    linked_at INTEGER NOT NULL,
    PRIMARY KEY (workout_session_id, reading_id),
    FOREIGN KEY (workout_session_id) REFERENCES body_signal_workout_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (reading_id) REFERENCES body_signal_readings(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS body_signal_personal_baselines (
    id TEXT PRIMARY KEY NOT NULL,
    device_profile_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    context_bucket TEXT NOT NULL,
    distinct_date_count INTEGER NOT NULL DEFAULT 0 CHECK (distinct_date_count >= 0),
    bucket_count INTEGER NOT NULL DEFAULT 0 CHECK (bucket_count >= 0),
    sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
    median REAL NOT NULL DEFAULT 0,
    mad REAL NOT NULL DEFAULT 0 CHECK (mad >= 0),
    p10 REAL NOT NULL DEFAULT 0,
    p90 REAL NOT NULL DEFAULT 0,
    average REAL NOT NULL,
    minimum REAL NOT NULL,
    maximum REAL NOT NULL,
    standard_deviation REAL CHECK (standard_deviation IS NULL OR standard_deviation >= 0),
    window_started_at INTEGER NOT NULL,
    window_ended_at INTEGER NOT NULL CHECK (window_ended_at >= window_started_at),
    algorithm_version INTEGER NOT NULL DEFAULT 1,
    readiness TEXT NOT NULL DEFAULT 'learning' CHECK (readiness IN ('learning', 'mature')),
    updated_at INTEGER NOT NULL,
    UNIQUE (device_profile_id, kind, context_bucket)
  );

  CREATE TABLE IF NOT EXISTS body_signal_care_events (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    context_bucket TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('observe', 'support', 'concern')),
    status TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('high', 'low')),
    dedupe_key TEXT NOT NULL,
    baseline_id TEXT,
    context_confidence REAL NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    handled_at INTEGER,
    dismissed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_body_signal_care_events_status_time
    ON body_signal_care_events(status, observed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_body_signal_care_events_dedupe
    ON body_signal_care_events(dedupe_key, observed_at DESC);
  CREATE TABLE IF NOT EXISTS body_signal_care_event_evidence (
    id TEXT PRIMARY KEY NOT NULL,
    event_id TEXT NOT NULL,
    reading_id TEXT,
    kind TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT NOT NULL,
    measured_at INTEGER NOT NULL,
    source_provider TEXT NOT NULL,
    source_device_name TEXT,
    confidence TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES body_signal_care_events(id) ON DELETE CASCADE,
    FOREIGN KEY (reading_id) REFERENCES body_signal_readings(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS body_signal_context_observations (
    id TEXT PRIMARY KEY NOT NULL,
    context_bucket TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    transition_type TEXT,
    source TEXT NOT NULL,
    boot_session_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_body_signal_context_time
    ON body_signal_context_observations(started_at DESC);

  CREATE TABLE IF NOT EXISTS body_signal_discomfort_reports (
    id TEXT PRIMARY KEY NOT NULL,
    category TEXT NOT NULL,
    source_message_id TEXT NOT NULL UNIQUE,
    observed_at INTEGER NOT NULL,
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_body_signal_discomfort_time
    ON body_signal_discomfort_reports(observed_at DESC);

  CREATE TABLE IF NOT EXISTS body_signal_evaluation_cursors (
    device_profile_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    last_reading_id TEXT,
    last_measured_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (device_profile_id, kind)
  );
`;

type ColumnInfo = { name: string };
type SchemaVersionRow = { schema_version: number };
type ForeignKeyViolation = { table: string };

function finiteTimestamp(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value as number) : fallback;
}

export function selectPrimaryBodySignalDeviceId(
  profiles: readonly BodySignalDeviceProfile[],
): string | undefined {
  if (profiles.length === 0) return undefined;
  const ordered = [...profiles].sort((left, right) => {
    const primaryDifference = Number(right.isPrimary) - Number(left.isPrimary);
    if (primaryDifference !== 0) return primaryDifference;
    const connectedDifference = (right.lastConnectedAt ?? 0) - (left.lastConnectedAt ?? 0);
    if (connectedDifference !== 0) return connectedDifference;
    return right.updatedAt - left.updatedAt;
  });
  return ordered[0]?.id;
}

export function normalizeLegacyBodySignalDeviceProfiles(
  profiles: readonly BodySignalDeviceProfile[],
): BodySignalDeviceProfile[] {
  const now = Date.now();
  const seen = new Set<string>();
  const valid = profiles.filter((profile) => {
    if (!profile || typeof profile.id !== 'string' || !profile.id.trim()) return false;
    if (seen.has(profile.id)) return false;
    seen.add(profile.id);
    return typeof profile.displayName === 'string' && Boolean(profile.displayName.trim());
  });
  const primaryId = selectPrimaryBodySignalDeviceId(valid);
  return valid.map((profile) => ({
    ...profile,
    createdAt: finiteTimestamp(profile.createdAt, now),
    displayName: profile.displayName.trim(),
    isPrimary: profile.id === primaryId,
    updatedAt: finiteTimestamp(profile.updatedAt, now),
  }));
}

async function ensureReadingDeviceProfileColumn(database: SQLiteDatabase): Promise<void> {
  const columns = await database.getAllAsync<ColumnInfo>('PRAGMA table_info(body_signal_readings)');
  if (columns.some((column) => column.name === 'device_profile_id')) return;
  await database.execAsync(
    `ALTER TABLE body_signal_readings
     ADD COLUMN device_profile_id TEXT
     REFERENCES body_signal_devices(id) ON DELETE SET NULL;`,
  );
  await database.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_body_signal_readings_device_time
       ON body_signal_readings(device_profile_id, measured_at DESC);`,
  );
}

async function insertLegacyProfiles(
  database: SQLiteDatabase,
  profiles: readonly BodySignalDeviceProfile[],
): Promise<void> {
  const normalized = normalizeLegacyBodySignalDeviceProfiles(profiles);
  for (const profile of normalized) {
    await database.runAsync(
      `INSERT INTO body_signal_devices (
         id, display_name, family, is_primary,
         authorized_association_id, last_advertising_id,
         protocol_identity, service_fingerprint, transport_identity,
         last_connected_at, created_at, updated_at, retired_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO NOTHING`,
      profile.id,
      profile.displayName,
      profile.family,
      profile.isPrimary ? 1 : 0,
      profile.authorizedAssociationId ?? null,
      profile.lastAdvertisingId ?? null,
      profile.protocolIdentity ?? null,
      profile.serviceFingerprint ?? null,
      profile.transportIdentity ?? null,
      profile.lastConnectedAt ?? null,
      profile.createdAt,
      profile.updatedAt,
    );
  }
}

async function columnNames(database: SQLiteDatabase, table: string): Promise<Set<string>> {
  const rows = await database.getAllAsync<ColumnInfo>(`PRAGMA table_info(${table})`);
  return new Set(rows.map((row) => row.name));
}

async function migrateVersionFiveTables(database: SQLiteDatabase): Promise<void> {
  const baselineColumns = await columnNames(database, 'body_signal_personal_baselines');
  if (!baselineColumns.has('device_profile_id')) {
    await database.execAsync(`
      ALTER TABLE body_signal_personal_baselines RENAME TO body_signal_personal_baselines_v4;
      CREATE TABLE body_signal_personal_baselines (
        id TEXT PRIMARY KEY NOT NULL,
        device_profile_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        context_bucket TEXT NOT NULL,
        distinct_date_count INTEGER NOT NULL DEFAULT 0 CHECK (distinct_date_count >= 0),
        bucket_count INTEGER NOT NULL DEFAULT 0 CHECK (bucket_count >= 0),
        sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
        median REAL NOT NULL DEFAULT 0,
        mad REAL NOT NULL DEFAULT 0 CHECK (mad >= 0),
        p10 REAL NOT NULL DEFAULT 0,
        p90 REAL NOT NULL DEFAULT 0,
        average REAL NOT NULL,
        minimum REAL NOT NULL,
        maximum REAL NOT NULL,
        standard_deviation REAL CHECK (standard_deviation IS NULL OR standard_deviation >= 0),
        window_started_at INTEGER NOT NULL,
        window_ended_at INTEGER NOT NULL CHECK (window_ended_at >= window_started_at),
        algorithm_version INTEGER NOT NULL DEFAULT 1,
        readiness TEXT NOT NULL DEFAULT 'learning' CHECK (readiness IN ('learning', 'mature')),
        updated_at INTEGER NOT NULL,
        UNIQUE (device_profile_id, kind, context_bucket)
      );
      INSERT INTO body_signal_personal_baselines (
        id, device_profile_id, kind, context_bucket, sample_count,
        median, p10, p90, average, minimum, maximum, standard_deviation,
        window_started_at, window_ended_at, updated_at
      )
      SELECT id, 'legacy-unassigned', kind, context_bucket, sample_count,
             average, minimum, maximum, average, minimum, maximum, standard_deviation,
             window_started_at, window_ended_at, updated_at
        FROM body_signal_personal_baselines_v4;
      DROP TABLE body_signal_personal_baselines_v4;
    `);
  }

  const eventColumns = await columnNames(database, 'body_signal_care_events');
  const additions: ReadonlyArray<[string, string]> = [
    ['reason_code', "TEXT NOT NULL DEFAULT 'context_explained'"],
    ['direction', "TEXT NOT NULL DEFAULT 'high'"],
    ['dedupe_key', "TEXT NOT NULL DEFAULT ''"],
    ['baseline_id', 'TEXT'],
    ['context_confidence', 'REAL NOT NULL DEFAULT 0'],
    ['expires_at', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [name, definition] of additions) {
    if (!eventColumns.has(name)) {
      await database.execAsync(`ALTER TABLE body_signal_care_events ADD COLUMN ${name} ${definition};`);
    }
  }
  await database.execAsync(`
    UPDATE body_signal_care_events
       SET severity = CASE severity
         WHEN 'info' THEN 'observe'
         WHEN 'attention' THEN 'support'
         WHEN 'urgent' THEN 'concern'
         ELSE severity
       END,
       dedupe_key = CASE WHEN dedupe_key = '' THEN id ELSE dedupe_key END,
       expires_at = CASE WHEN expires_at = 0 THEN observed_at + 7200000 ELSE expires_at END;
    CREATE INDEX IF NOT EXISTS idx_body_signal_care_events_dedupe
      ON body_signal_care_events(dedupe_key, observed_at DESC);
  `);

  const contextColumns = await columnNames(database, 'body_signal_context_observations');
  if (!contextColumns.has('boot_session_id')) {
    await database.execAsync(
      'ALTER TABLE body_signal_context_observations ADD COLUMN boot_session_id TEXT;',
    );
  }
}

async function migrateActivitySummaryColumns(database: SQLiteDatabase): Promise<void> {
  const samples = await columnNames(database, 'body_signal_activity_samples');
  if (!samples.has('summary_date_key')) await database.execAsync('ALTER TABLE body_signal_activity_samples ADD COLUMN summary_date_key TEXT;');
  const summaries = await columnNames(database, 'body_signal_activity_daily_summaries');
  for (const [name, definition] of Object.entries({ summary_version: 'INTEGER NOT NULL DEFAULT 0',
    day_started_at: 'INTEGER', day_ended_at: 'INTEGER', timezone_id: 'TEXT', first_sample_at: 'INTEGER',
    last_sample_at: 'INTEGER', sealed_through_at: 'INTEGER', coverage_uncertain: 'INTEGER NOT NULL DEFAULT 0' })) {
    if (!summaries.has(name)) await database.execAsync(`ALTER TABLE body_signal_activity_daily_summaries ADD COLUMN ${name} ${definition};`);
  }
}

async function migrateSleepDurationColumns(database: SQLiteDatabase): Promise<void> {
  const columns = await columnNames(database, 'body_signal_sleep_sessions');
  for (const [name, definition] of Object.entries({ wake_date_key: 'TEXT', algorithm_version: 'TEXT',
    context_eligible: 'INTEGER NOT NULL DEFAULT 1' })) {
    if (!columns.has(name)) await database.execAsync(`ALTER TABLE body_signal_sleep_sessions ADD COLUMN ${name} ${definition};`);
  }
}

export async function migrateBodySignalBusinessSchema(
  database: SQLiteDatabase,
  legacyProfiles: readonly BodySignalDeviceProfile[] = [],
): Promise<void> {
  await database.execAsync('PRAGMA foreign_keys = ON;');
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.execAsync(BODY_SIGNAL_STRUCTURED_SCHEMA_SQL);
    await ensureReadingDeviceProfileColumn(transaction);
    const contextColumns = await columnNames(transaction, 'body_signal_context_observations');
    if (!contextColumns.has('boot_session_id')) {
      await transaction.execAsync(
        'ALTER TABLE body_signal_context_observations ADD COLUMN boot_session_id TEXT;',
      );
    }
    const version = await transaction.getFirstAsync<SchemaVersionRow>(
      `SELECT schema_version
         FROM body_signal_business_schema_meta
        WHERE singleton_id = 1`,
    );
    if ((version?.schema_version ?? 0) > BODY_SIGNAL_BUSINESS_SCHEMA_VERSION) {
      throw new Error(`Unsupported body signal schema ${version?.schema_version}`);
    }
    if ((version?.schema_version ?? 0) < 5) {
      await insertLegacyProfiles(transaction, legacyProfiles);
      await migrateVersionFiveTables(transaction);
    }
    await migrateActivitySummaryColumns(transaction);
    await migrateSleepDurationColumns(transaction);
    const violations = await transaction.getAllAsync<ForeignKeyViolation>(
      'PRAGMA foreign_key_check',
    );
    if (violations.length > 0) {
      throw new Error(`Body signal migration found ${violations.length} foreign key violation(s)`);
    }
    await transaction.runAsync(
      `INSERT INTO body_signal_business_schema_meta (
         singleton_id, schema_version, migrated_at
       ) VALUES (1, ?, ?)
       ON CONFLICT(singleton_id) DO UPDATE SET
         schema_version = excluded.schema_version,
         migrated_at = excluded.migrated_at`,
      BODY_SIGNAL_BUSINESS_SCHEMA_VERSION,
      Date.now(),
    );
  });
}
