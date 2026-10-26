import {
  ACTIVITY_DAILY_SUMMARY_RETENTION_DAYS,
  ACTIVITY_DEFAULT_RAW_RETENTION_DAYS,
  ACTIVITY_OBSERVATIONS_SCHEMA_VERSION,
  type ActivityObservationsEntityType,
  type ActivityObservationsRecordKind,
} from './syncActivityObservations';

export const ACTIVITY_OBSERVATIONS_CAPTURE_SCHEMA_VERSION = 2 as const;
export const ACTIVITY_OBSERVATIONS_STORAGE_SCHEMA_VERSION = 1 as const;
export const ACTIVITY_OBSERVATIONS_CAPTURE_LEASE_MS = 60_000;
export const ACTIVITY_OBSERVATIONS_EXPECTED_CAPTURE_TRIGGER_COUNT = 14;
export const ACTIVITY_OBSERVATIONS_SUMMARY_SHARE_INTERVAL_MS =
  60 * 60 * 1000;

export const ACTIVITY_OBSERVATIONS_DATABASE_CONFIGURATION_SQL = `
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
`;

type CaptureDefinition = {
  kind: ActivityObservationsRecordKind;
  entityType: ActivityObservationsEntityType;
  table: string;
  localIdColumn: string;
  updateColumns: readonly string[];
};

const ALL_CAPTURE_DEFINITIONS: readonly CaptureDefinition[] = [
  {
    kind: 'activity-reading',
    entityType: 'activity-reading',
    table: 'phone_activity_logs',
    localIdColumn: 'id',
    updateColumns: [],
  },
  {
    kind: 'activity-day-summary',
    entityType: 'formal-observation',
    table: 'activity_day_summaries',
    localIdColumn: 'id',
    updateColumns: [
      'segments',
      'total_duration_ms',
      'top_apps_json',
      'generated_at',
      'updated_at',
    ],
  },
  {
    kind: 'activity-care-settings',
    entityType: 'care-policy',
    table: 'activity_care_settings',
    localIdColumn: 'id',
    updateColumns: [
      'enabled',
      'jealousy_enabled',
      'raw_retention_days',
      'updated_at',
    ],
  },
  {
    kind: 'activity-care-rule',
    entityType: 'care-policy',
    table: 'activity_care_rules',
    localIdColumn: 'id',
    updateColumns: [
      'title',
      'threshold_minutes',
      'return_window_minutes',
      'daily_limit_minutes',
      'updated_at',
    ],
  },
  {
    kind: 'activity-feedback',
    entityType: 'formal-observation',
    table: 'activity_feedback',
    localIdColumn: 'id',
    updateColumns: ['title', 'reason', 'status', 'updated_at'],
  },
  {
    kind: 'activity-focus-trigger',
    entityType: 'focus-trigger',
    table: 'activity_focus_triggers',
    localIdColumn: 'id',
    updateColumns: ['outcome', 'updated_at'],
  },
  {
    kind: 'activity-daily-usage',
    entityType: 'formal-observation',
    table: 'activity_daily_usage',
    localIdColumn: 'id',
    updateColumns: ['duration_ms', 'updated_at'],
  },
];

const SUMMARY_CHECKPOINT_DEFINITIONS = ALL_CAPTURE_DEFINITIONS.filter(
  (definition) => (
    definition.kind === 'activity-day-summary'
    || definition.kind === 'activity-daily-usage'
  ),
);

const LIVE_CAPTURE_DEFINITIONS = ALL_CAPTURE_DEFINITIONS.filter(
  (definition) => (
    definition.kind !== 'activity-reading'
    && definition.kind !== 'activity-day-summary'
    && definition.kind !== 'activity-daily-usage'
  ),
);

const CURRENT_SNAPSHOT_DEFINITIONS = ALL_CAPTURE_DEFINITIONS.filter(
  (definition) => definition.kind !== 'activity-reading',
);

function uuidV4Expression() {
  return `(
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    lower(hex(randomblob(6)))
  )`;
}

function unixMillisecondsExpression() {
  return `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;
}

function jsonBoolean(expression: string) {
  return `json(CASE WHEN ${expression} THEN 'true' ELSE 'false' END)`;
}

function entityIdExpression(
  definition: CaptureDefinition,
  row: 'NEW' | 'OLD' | 'ROW',
) {
  return `'${definition.kind}:' ||
    CAST(${row}.${definition.localIdColumn} AS TEXT)`;
}

function recordExpression(
  kind: ActivityObservationsRecordKind,
  row: 'NEW' | 'OLD' | 'ROW',
) {
  if (kind === 'activity-reading') {
    return `json_object(
      'id', ${row}.id,
      'readingKind', ${row}.kind,
      'source', ${row}.source,
      'title', ${row}.title,
      'summary', ${row}.summary,
      'startedAt', ${row}.started_at,
      'endedAt', ${row}.ended_at,
      'durationMs', ${row}.duration_ms,
      'sensitivityLabel', ${row}.sensitive_level,
      'originDeviceId', ${row}.origin_device_id,
      'originPlatform', ${row}.origin_platform,
      'sourceScope', 'origin-device',
      'retentionUntil', ${row}.retention_until,
      'createdAt', ${row}.created_at
    )`;
  }
  if (kind === 'activity-day-summary') {
    return `json_object(
      'id', ${row}.id,
      'dateKey', ${row}.date_key,
      'originDeviceId', ${row}.origin_device_id,
      'originPlatform', ${row}.origin_platform,
      'sourceScope', 'origin-device',
      'segments', ${row}.segments,
      'totalDurationMs', ${row}.total_duration_ms,
      'topApps', json(${row}.top_apps_json),
      'generatedAt', ${row}.generated_at,
      'updatedAt', ${row}.updated_at
    )`;
  }
  if (kind === 'activity-care-settings') {
    return `json_object(
      'id', ${row}.id,
      'enabled', ${jsonBoolean(`${row}.enabled <> 0`)},
      'jealousyEnabled',
        ${jsonBoolean(`${row}.jealousy_enabled <> 0`)},
      'rawRetentionDays', ${row}.raw_retention_days,
      'updatedAt', ${row}.updated_at
    )`;
  }
  if (kind === 'activity-care-rule') {
    return `json_object(
      'id', ${row}.id,
      'ruleKind', ${row}.rule_kind,
      'targetPlatform', ${row}.target_platform,
      'source', ${row}.source,
      'title', ${row}.title,
      'thresholdMinutes', ${row}.threshold_minutes,
      'returnWindowMinutes', ${row}.return_window_minutes,
      'dailyLimitMinutes', ${row}.daily_limit_minutes,
      'updatedAt', ${row}.updated_at
    )`;
  }
  if (kind === 'activity-feedback') {
    return `json_object(
      'id', ${row}.id,
      'feedbackKind', 'jealousy-candidate',
      'targetPlatform', ${row}.target_platform,
      'source', ${row}.source,
      'title', ${row}.title,
      'reason', ${row}.reason,
      'status', ${row}.status,
      'createdAt', ${row}.created_at,
      'updatedAt', ${row}.updated_at
    )`;
  }
  if (kind === 'activity-focus-trigger') {
    return `json_object(
      'id', ${row}.id,
      'ruleId', ${row}.rule_id,
      'ruleKind', ${row}.rule_kind,
      'triggerKind', ${row}.trigger_kind,
      'reason', ${row}.reason,
      'eventStage', ${row}.event_stage,
      'appSource', ${row}.app_source,
      'appTitle', ${row}.app_title,
      'durationMs', ${row}.duration_ms,
      'stage', ${row}.stage,
      'outcome', ${row}.outcome,
      'originDeviceId', ${row}.origin_device_id,
      'originPlatform', ${row}.origin_platform,
      'sourceScope', 'origin-device',
      'triggeredAt', ${row}.triggered_at,
      'updatedAt', ${row}.updated_at
    )`;
  }
  return `json_object(
    'id', ${row}.id,
    'ruleId', ${row}.rule_id,
    'dateKey', ${row}.date_key,
    'durationMs', ${row}.duration_ms,
    'originDeviceId', ${row}.origin_device_id,
    'originPlatform', ${row}.origin_platform,
    'sourceScope', 'origin-device',
    'updatedAt', ${row}.updated_at
  )`;
}

function captureEnabledPredicate() {
  return `EXISTS (
    SELECT 1 FROM activity_sync_runtime
    WHERE singleton_id = 1
      AND capture_enabled = 1
      AND suppress_capture = 0
      AND vault_id IS NOT NULL
      AND source_device_id IS NOT NULL
      AND source_platform IS NOT NULL
  )`;
}

function parentRevisionIdsExpression(
  definition: CaptureDefinition,
  row: 'NEW' | 'OLD' | 'ROW',
) {
  return `COALESCE((
    SELECT json_group_array(revision_id)
    FROM (
      SELECT revision_id
      FROM activity_sync_entity_heads
      WHERE entity_type = '${definition.entityType}'
        AND entity_id = ${entityIdExpression(definition, row)}
      ORDER BY revision_id ASC
    )
  ), json('[]'))`;
}

function insertOutboxStatement(
  definition: CaptureDefinition,
  row: 'NEW' | 'OLD',
  operation: 'delete' | 'upsert',
) {
  const payload = operation === 'delete'
    ? `json_object(
        'schemaVersion', ${ACTIVITY_OBSERVATIONS_SCHEMA_VERSION},
        'kind', '${definition.kind}',
        'deletedAt', ${unixMillisecondsExpression()}
      )`
    : `json_object(
        'schemaVersion', ${ACTIVITY_OBSERVATIONS_SCHEMA_VERSION},
        'kind', '${definition.kind}',
        'record', ${recordExpression(definition.kind, row)}
      )`;
  return `INSERT INTO activity_sync_domain_outbox (
    mutation_id, revision_id, parent_revision_ids_json,
    vault_id, source_device_id, entity_type, entity_id,
    operation, schema_version, payload_json, state,
    available_at, created_at, updated_at
  )
  SELECT
    ${uuidV4Expression()},
    ${uuidV4Expression()},
    ${parentRevisionIdsExpression(definition, row)},
    vault_id,
    source_device_id,
    '${definition.entityType}',
    ${entityIdExpression(definition, row)},
    '${operation}',
    ${ACTIVITY_OBSERVATIONS_SCHEMA_VERSION},
    ${payload},
    'pending',
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()}
  FROM activity_sync_runtime
  WHERE singleton_id = 1;`;
}

function advanceHeadsStatements(
  definition: CaptureDefinition,
  row: 'NEW' | 'OLD',
) {
  return `
  DELETE FROM activity_sync_entity_heads
  WHERE entity_type = '${definition.entityType}'
    AND entity_id = ${entityIdExpression(definition, row)};

  INSERT INTO activity_sync_entity_heads (
    entity_type, entity_id, revision_id, updated_at
  )
  SELECT
    '${definition.entityType}',
    ${entityIdExpression(definition, row)},
    revision_id,
    created_at
  FROM activity_sync_domain_outbox
  WHERE local_sequence = last_insert_rowid();`;
}

function updateChangedPredicate(columns: readonly string[]) {
  return columns
    .map((column) => `OLD.${column} IS NOT NEW.${column}`)
    .join('\n    OR ');
}

function provenancePredicate(
  definition: CaptureDefinition,
  row: 'NEW' | 'ROW',
) {
  if (
    definition.kind === 'activity-reading'
    || definition.kind === 'activity-day-summary'
    || definition.kind === 'activity-focus-trigger'
    || definition.kind === 'activity-daily-usage'
  ) {
    return ` AND ${row}.origin_device_id IS NOT NULL
  AND ${row}.origin_platform IS NOT NULL`;
  }
  return '';
}

function captureTriggers(definition: CaptureDefinition) {
  const triggerKind = definition.kind.replace(/-/gu, '_');
  const updateTrigger = definition.updateColumns.length
    ? `
CREATE TRIGGER IF NOT EXISTS activity_sync_capture_${triggerKind}_update
AFTER UPDATE ON ${definition.table}
WHEN ${captureEnabledPredicate()}
  AND (
    ${updateChangedPredicate(definition.updateColumns)}
  )
BEGIN
  ${insertOutboxStatement(definition, 'NEW', 'upsert')}
  ${advanceHeadsStatements(definition, 'NEW')}
END;`
    : '';
  return `
CREATE TRIGGER IF NOT EXISTS activity_sync_capture_${triggerKind}_insert
AFTER INSERT ON ${definition.table}
WHEN ${captureEnabledPredicate()}${provenancePredicate(definition, 'NEW')}
BEGIN
  ${insertOutboxStatement(definition, 'NEW', 'upsert')}
  ${advanceHeadsStatements(definition, 'NEW')}
END;
${updateTrigger}
CREATE TRIGGER IF NOT EXISTS activity_sync_capture_${triggerKind}_delete
AFTER DELETE ON ${definition.table}
WHEN ${captureEnabledPredicate()}
BEGIN
  ${insertOutboxStatement(definition, 'OLD', 'delete')}
  ${advanceHeadsStatements(definition, 'OLD')}
END;`;
}

function captureDeleteTrigger(definition: CaptureDefinition) {
  const triggerKind = definition.kind.replace(/-/gu, '_');
  return `
CREATE TRIGGER IF NOT EXISTS activity_sync_capture_${triggerKind}_delete
AFTER DELETE ON ${definition.table}
WHEN ${captureEnabledPredicate()}
BEGIN
  ${insertOutboxStatement(definition, 'OLD', 'delete')}
  ${advanceHeadsStatements(definition, 'OLD')}
END;`;
}

export const ACTIVITY_OBSERVATIONS_BUSINESS_SCHEMA_SQL = `
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
  origin_platform TEXT CHECK (
    origin_platform IS NULL OR origin_platform IN ('android', 'windows')
  ),
  retention_until INTEGER
);

CREATE INDEX IF NOT EXISTS idx_phone_activity_created
  ON phone_activity_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS activity_day_summaries (
  id TEXT PRIMARY KEY NOT NULL,
  date_key TEXT NOT NULL,
  origin_device_id TEXT NOT NULL,
  origin_platform TEXT NOT NULL CHECK (
    origin_platform IN ('android', 'windows')
  ),
  segments INTEGER NOT NULL CHECK (segments >= 0),
  total_duration_ms INTEGER NOT NULL CHECK (total_duration_ms >= 0),
  top_apps_json TEXT NOT NULL CHECK (json_valid(top_apps_json)),
  generated_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (date_key, origin_device_id)
);

CREATE TABLE IF NOT EXISTS activity_care_settings (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'global'),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  jealousy_enabled INTEGER NOT NULL CHECK (jealousy_enabled IN (0, 1)),
  raw_retention_days INTEGER NOT NULL DEFAULT ${ACTIVITY_DEFAULT_RAW_RETENTION_DAYS}
    CHECK (raw_retention_days BETWEEN 1 AND 3650),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_care_rules (
  id TEXT PRIMARY KEY NOT NULL,
  rule_kind TEXT NOT NULL CHECK (
    rule_kind IN ('blacklist', 'jealousy', 'whitelist')
  ),
  target_platform TEXT NOT NULL CHECK (
    target_platform IN ('android', 'windows')
  ),
  source TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  threshold_minutes INTEGER NOT NULL
    CHECK (threshold_minutes BETWEEN 1 AND 1440),
  return_window_minutes INTEGER
    CHECK (
      return_window_minutes IS NULL
      OR return_window_minutes BETWEEN 1 AND 1440
    ),
  daily_limit_minutes INTEGER
    CHECK (
      daily_limit_minutes IS NULL
      OR daily_limit_minutes BETWEEN 1 AND 1440
    ),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_feedback (
  id TEXT PRIMARY KEY NOT NULL,
  target_platform TEXT NOT NULL CHECK (
    target_platform IN ('android', 'windows')
  ),
  source TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (
    status IN ('accepted', 'dismissed', 'pending')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_focus_triggers (
  id TEXT PRIMARY KEY NOT NULL,
  rule_id TEXT NOT NULL,
  rule_kind TEXT NOT NULL CHECK (
    rule_kind IN ('blacklist', 'jealousy', 'whitelist')
  ),
  trigger_kind TEXT NOT NULL CHECK (
    trigger_kind IN (
      'blacklist', 'blacklist-return', 'jealousy', 'whitelist'
    )
  ),
  reason TEXT NOT NULL CHECK (
    reason IN (
      'accumulated', 'current', 'jealousy', 'return', 'unknown'
    )
  ),
  event_stage TEXT CHECK (
    event_stage IS NULL OR event_stage IN (
      'daily-limit',
      'daily-summary-praise',
      'first-praise',
      'first-warning',
      'repeat-praise',
      'repeat-warning',
      'return-after-overlay'
    )
  ),
  app_source TEXT NOT NULL DEFAULT '',
  app_title TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  stage INTEGER NOT NULL CHECK (stage IN (1, 2, 3)),
  outcome TEXT NOT NULL CHECK (outcome IN ('observed', 'message-sent')),
  origin_device_id TEXT NOT NULL,
  origin_platform TEXT NOT NULL CHECK (
    origin_platform IN ('android', 'windows')
  ),
  triggered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_focus_trigger_time
  ON activity_focus_triggers(triggered_at DESC);

CREATE TABLE IF NOT EXISTS activity_daily_usage (
  id TEXT PRIMARY KEY NOT NULL,
  rule_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  origin_device_id TEXT NOT NULL,
  origin_platform TEXT NOT NULL CHECK (
    origin_platform IN ('android', 'windows')
  ),
  updated_at INTEGER NOT NULL,
  UNIQUE (rule_id, date_key, origin_device_id)
);
`;

export const ACTIVITY_OBSERVATIONS_CAPTURE_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS activity_sync_runtime (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  capture_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (capture_enabled IN (0, 1)),
  suppress_capture INTEGER NOT NULL DEFAULT 0
    CHECK (suppress_capture IN (0, 1)),
  vault_id TEXT,
  source_device_id TEXT,
  source_platform TEXT CHECK (
    source_platform IS NULL OR source_platform IN ('android', 'windows')
  ),
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO activity_sync_runtime (
  singleton_id, capture_enabled, suppress_capture,
  vault_id, source_device_id, source_platform, updated_at
) VALUES (1, 0, 0, NULL, NULL, NULL, 0);

CREATE TABLE IF NOT EXISTS activity_sync_domain_outbox (
  local_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  parent_revision_ids_json TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  source_sequence INTEGER,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'activity-reading', 'formal-observation',
      'care-policy', 'focus-trigger'
    )
  ),
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 340),
  operation TEXT NOT NULL CHECK (
    operation IN ('upsert', 'delete', 'restore')
  ),
  schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'leased', 'dispatched', 'quarantined')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_id TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  dispatched_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source_device_id, source_sequence)
);

CREATE INDEX IF NOT EXISTS idx_activity_sync_outbox_ready
  ON activity_sync_domain_outbox(state, available_at, local_sequence);

CREATE TABLE IF NOT EXISTS activity_sync_entity_heads (
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'activity-reading', 'formal-observation',
      'care-policy', 'focus-trigger'
    )
  ),
  entity_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id, revision_id)
);

CREATE TABLE IF NOT EXISTS activity_sync_conflicts (
  conflict_id TEXT PRIMARY KEY NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  local_revision_id TEXT,
  incoming_revision_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  local_payload_json TEXT,
  incoming_payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'resolved')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS activity_sync_bootstrap_state (
  adapter_id TEXT NOT NULL,
  bootstrap_version INTEGER NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (
    adapter_id, bootstrap_version, vault_id, source_device_id
  )
);

CREATE TABLE IF NOT EXISTS activity_sync_summary_checkpoints (
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  last_enqueued_at INTEGER NOT NULL,
  PRIMARY KEY (
    vault_id, source_device_id, entity_type, entity_id
  )
);

CREATE TABLE IF NOT EXISTS activity_sync_schema_meta (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  storage_schema_version INTEGER NOT NULL,
  capture_schema_version INTEGER NOT NULL,
  trigger_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO activity_sync_schema_meta (
  singleton_id, storage_schema_version, capture_schema_version,
  trigger_count, updated_at
) VALUES (
  1,
  ${ACTIVITY_OBSERVATIONS_STORAGE_SCHEMA_VERSION},
  ${ACTIVITY_OBSERVATIONS_CAPTURE_SCHEMA_VERSION},
  ${ACTIVITY_OBSERVATIONS_EXPECTED_CAPTURE_TRIGGER_COUNT},
  ${unixMillisecondsExpression()}
)
ON CONFLICT(singleton_id) DO UPDATE SET
  storage_schema_version = excluded.storage_schema_version,
  capture_schema_version = excluded.capture_schema_version,
  trigger_count = excluded.trigger_count,
  updated_at = excluded.updated_at;
`;

export const ACTIVITY_OBSERVATIONS_RETIRED_CAPTURE_TRIGGER_SQL = `
DROP TRIGGER IF EXISTS activity_sync_capture_activity_reading_insert;
DROP TRIGGER IF EXISTS activity_sync_capture_activity_reading_delete;
DROP TRIGGER IF EXISTS activity_sync_capture_activity_day_summary_insert;
DROP TRIGGER IF EXISTS activity_sync_capture_activity_day_summary_update;
DROP TRIGGER IF EXISTS activity_sync_capture_activity_daily_usage_insert;
DROP TRIGGER IF EXISTS activity_sync_capture_activity_daily_usage_update;
`;

export const ACTIVITY_OBSERVATIONS_CAPTURE_TRIGGER_SQL = [
  ...LIVE_CAPTURE_DEFINITIONS.map(captureTriggers),
  ...SUMMARY_CHECKPOINT_DEFINITIONS.map(captureDeleteTrigger),
].join('\n');

export const ACTIVITY_OBSERVATIONS_WRITE_GUARD_SQL = `
CREATE TRIGGER IF NOT EXISTS activity_sync_guard_reading_append_only
BEFORE UPDATE ON phone_activity_logs
WHEN ${captureEnabledPredicate()}
BEGIN
  SELECT RAISE(
    ABORT,
    'activity.observations reading is append-only'
  );
END;

CREATE TRIGGER IF NOT EXISTS activity_sync_guard_summary_identity
BEFORE UPDATE OF
  id, date_key, origin_device_id, origin_platform
ON activity_day_summaries
WHEN OLD.id IS NOT NEW.id
  OR OLD.date_key IS NOT NEW.date_key
  OR OLD.origin_device_id IS NOT NEW.origin_device_id
  OR OLD.origin_platform IS NOT NEW.origin_platform
BEGIN
  SELECT RAISE(
    ABORT,
    'activity.observations day summary identity is immutable'
  );
END;

CREATE TRIGGER IF NOT EXISTS activity_sync_guard_summary_growth
BEFORE UPDATE ON activity_day_summaries
WHEN ${captureEnabledPredicate()}
  AND (
    NEW.segments < OLD.segments
    OR NEW.total_duration_ms < OLD.total_duration_ms
    OR NEW.updated_at < OLD.updated_at
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'activity.observations day summary cannot regress'
  );
END;

CREATE TRIGGER IF NOT EXISTS activity_sync_guard_rule_identity
BEFORE UPDATE OF id, rule_kind, target_platform, source
ON activity_care_rules
WHEN OLD.id IS NOT NEW.id
  OR OLD.rule_kind IS NOT NEW.rule_kind
  OR OLD.target_platform IS NOT NEW.target_platform
  OR OLD.source IS NOT NEW.source
BEGIN
  SELECT RAISE(
    ABORT,
    'activity.observations care rule identity is immutable'
  );
END;

CREATE TRIGGER IF NOT EXISTS activity_sync_guard_feedback_identity
BEFORE UPDATE OF id, target_platform, source, created_at
ON activity_feedback
WHEN OLD.id IS NOT NEW.id
  OR OLD.target_platform IS NOT NEW.target_platform
  OR OLD.source IS NOT NEW.source
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(
    ABORT,
    'activity.observations feedback identity is immutable'
  );
END;

CREATE TRIGGER IF NOT EXISTS activity_sync_guard_feedback_terminal
BEFORE UPDATE OF status ON activity_feedback
WHEN ${captureEnabledPredicate()}
  AND OLD.status <> 'pending'
  AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(
    ABORT,
    'activity.observations feedback terminal state is immutable'
  );
END;

CREATE TRIGGER IF NOT EXISTS activity_sync_guard_trigger_identity
BEFORE UPDATE OF
  id, rule_id, rule_kind, trigger_kind, reason, event_stage,
  app_source, app_title, duration_ms, stage,
  origin_device_id, origin_platform, triggered_at
ON activity_focus_triggers
WHEN OLD.id IS NOT NEW.id
  OR OLD.rule_id IS NOT NEW.rule_id
  OR OLD.rule_kind IS NOT NEW.rule_kind
  OR OLD.trigger_kind IS NOT NEW.trigger_kind
  OR OLD.reason IS NOT NEW.reason
  OR OLD.event_stage IS NOT NEW.event_stage
  OR OLD.app_source IS NOT NEW.app_source
  OR OLD.app_title IS NOT NEW.app_title
  OR OLD.duration_ms IS NOT NEW.duration_ms
  OR OLD.stage IS NOT NEW.stage
  OR OLD.origin_device_id IS NOT NEW.origin_device_id
  OR OLD.origin_platform IS NOT NEW.origin_platform
  OR OLD.triggered_at IS NOT NEW.triggered_at
BEGIN
  SELECT RAISE(
    ABORT,
    'activity.observations focus trigger identity is immutable'
  );
END;

CREATE TRIGGER IF NOT EXISTS activity_sync_guard_trigger_outcome
BEFORE UPDATE OF outcome ON activity_focus_triggers
WHEN ${captureEnabledPredicate()}
  AND OLD.outcome = 'message-sent'
  AND NEW.outcome <> 'message-sent'
BEGIN
  SELECT RAISE(
    ABORT,
    'activity.observations focus trigger outcome cannot regress'
  );
END;

CREATE TRIGGER IF NOT EXISTS activity_sync_guard_usage_identity
BEFORE UPDATE OF
  id, rule_id, date_key, origin_device_id, origin_platform
ON activity_daily_usage
WHEN OLD.id IS NOT NEW.id
  OR OLD.rule_id IS NOT NEW.rule_id
  OR OLD.date_key IS NOT NEW.date_key
  OR OLD.origin_device_id IS NOT NEW.origin_device_id
  OR OLD.origin_platform IS NOT NEW.origin_platform
BEGIN
  SELECT RAISE(
    ABORT,
    'activity.observations daily usage identity is immutable'
  );
END;

CREATE TRIGGER IF NOT EXISTS activity_sync_guard_usage_growth
BEFORE UPDATE ON activity_daily_usage
WHEN ${captureEnabledPredicate()}
  AND (
    NEW.duration_ms < OLD.duration_ms
    OR NEW.updated_at < OLD.updated_at
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'activity.observations daily usage cannot regress'
  );
END;
`;

export const ACTIVITY_OBSERVATIONS_FULL_CAPTURE_SCHEMA_SQL = `
${ACTIVITY_OBSERVATIONS_BUSINESS_SCHEMA_SQL}
${ACTIVITY_OBSERVATIONS_CAPTURE_TABLE_SCHEMA_SQL}
${ACTIVITY_OBSERVATIONS_RETIRED_CAPTURE_TRIGGER_SQL}
${ACTIVITY_OBSERVATIONS_CAPTURE_TRIGGER_SQL}
${ACTIVITY_OBSERVATIONS_WRITE_GUARD_SQL}
`;

function bootstrapInsertSql(definition: CaptureDefinition) {
  return `
INSERT INTO activity_sync_domain_outbox (
  mutation_id, revision_id, parent_revision_ids_json,
  vault_id, source_device_id, entity_type, entity_id,
  operation, schema_version, payload_json, state,
  available_at, created_at, updated_at
)
SELECT
  ${uuidV4Expression()},
  ${uuidV4Expression()},
  ${parentRevisionIdsExpression(definition, 'ROW')},
  runtime.vault_id,
  runtime.source_device_id,
  '${definition.entityType}',
  ${entityIdExpression(definition, 'ROW')},
  'upsert',
  ${ACTIVITY_OBSERVATIONS_SCHEMA_VERSION},
  json_object(
    'schemaVersion', ${ACTIVITY_OBSERVATIONS_SCHEMA_VERSION},
    'kind', '${definition.kind}',
    'record', ${recordExpression(definition.kind, 'ROW')}
  ),
  'pending',
  ?,
  ?,
  ?
FROM ${definition.table} AS ROW
CROSS JOIN activity_sync_runtime AS runtime
WHERE runtime.singleton_id = 1
  ${provenancePredicate(definition, 'ROW')}
ORDER BY CAST(ROW.${definition.localIdColumn} AS TEXT) ASC;
`;
}

export const ACTIVITY_OBSERVATIONS_BOOTSTRAP_INSERT_SQL =
  ALL_CAPTURE_DEFINITIONS.map(bootstrapInsertSql);

function summaryCheckpointInsertSql(definition: CaptureDefinition) {
  const payload = `json_object(
    'schemaVersion', ${ACTIVITY_OBSERVATIONS_SCHEMA_VERSION},
    'kind', '${definition.kind}',
    'record', ${recordExpression(definition.kind, 'ROW')}
  )`;
  return `
INSERT INTO activity_sync_domain_outbox (
  mutation_id, revision_id, parent_revision_ids_json,
  vault_id, source_device_id, entity_type, entity_id,
  operation, schema_version, payload_json, state,
  available_at, created_at, updated_at
)
SELECT
  ${uuidV4Expression()},
  ${uuidV4Expression()},
  ${parentRevisionIdsExpression(definition, 'ROW')},
  runtime.vault_id,
  runtime.source_device_id,
  '${definition.entityType}',
  ${entityIdExpression(definition, 'ROW')},
  'upsert',
  ${ACTIVITY_OBSERVATIONS_SCHEMA_VERSION},
  ${payload},
  'pending',
  ?,
  ?,
  ?
FROM ${definition.table} AS ROW
CROSS JOIN activity_sync_runtime AS runtime
LEFT JOIN activity_sync_summary_checkpoints AS checkpoint
  ON checkpoint.vault_id = runtime.vault_id
 AND checkpoint.source_device_id = runtime.source_device_id
 AND checkpoint.entity_type = '${definition.entityType}'
 AND checkpoint.entity_id = ${entityIdExpression(definition, 'ROW')}
WHERE runtime.singleton_id = 1
  AND runtime.capture_enabled = 1
  AND runtime.suppress_capture = 0
  AND runtime.vault_id IS NOT NULL
  AND runtime.source_device_id IS NOT NULL
  AND checkpoint.payload_fingerprint IS NOT ${payload}
  AND (
    ? <> 0
    OR checkpoint.last_enqueued_at IS NULL
    OR ? - checkpoint.last_enqueued_at
      >= ${ACTIVITY_OBSERVATIONS_SUMMARY_SHARE_INTERVAL_MS}
  )
ORDER BY CAST(ROW.${definition.localIdColumn} AS TEXT) ASC;
`;
}

export const ACTIVITY_OBSERVATIONS_SUMMARY_CHECKPOINT_INSERT_SQL =
  SUMMARY_CHECKPOINT_DEFINITIONS.map(summaryCheckpointInsertSql);

function currentSnapshotSelectSql(definition: CaptureDefinition) {
  const provenance = provenancePredicate(definition, 'ROW')
    .trim()
    .replace(/^AND\s+/u, '');
  const retention = definition.kind === 'activity-reading'
    ? `ROW.retention_until > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      AND ROW.created_at + ${ACTIVITY_DEFAULT_RAW_RETENTION_DAYS * 86_400_000}
        > CAST(strftime('%s', 'now') AS INTEGER) * 1000`
    : definition.kind === 'activity-day-summary'
      || definition.kind === 'activity-daily-usage'
      ? `ROW.date_key >= date(
          'now', 'localtime',
          '-${ACTIVITY_DAILY_SUMMARY_RETENTION_DAYS - 1} days'
        )`
      : '';
  const predicates = [provenance, retention].filter(Boolean).join('\n    AND ');
  return `SELECT
    '${definition.entityType}' AS entity_type,
    ${entityIdExpression(definition, 'ROW')} AS entity_id,
    'upsert' AS operation,
    ${ACTIVITY_OBSERVATIONS_SCHEMA_VERSION} AS schema_version,
    json_object(
      'schemaVersion', ${ACTIVITY_OBSERVATIONS_SCHEMA_VERSION},
      'kind', '${definition.kind}',
      'record', ${recordExpression(definition.kind, 'ROW')}
    ) AS payload_json
  FROM ${definition.table} AS ROW
  ${predicates ? `WHERE ${predicates}` : ''}
  ORDER BY CAST(ROW.${definition.localIdColumn} AS TEXT) ASC`;
}

export const ACTIVITY_OBSERVATIONS_CURRENT_SNAPSHOT_SELECT_SQL =
  CURRENT_SNAPSHOT_DEFINITIONS.map(currentSnapshotSelectSql);

export const ACTIVITY_OBSERVATIONS_RESET_TECHNICAL_STATE_SQL = `
DELETE FROM activity_sync_domain_outbox;
DELETE FROM activity_sync_entity_heads;
DELETE FROM activity_sync_conflicts;
DELETE FROM activity_sync_bootstrap_state;
DELETE FROM activity_sync_summary_checkpoints;
UPDATE activity_sync_runtime
SET capture_enabled = 0,
    suppress_capture = 0,
    vault_id = NULL,
    source_device_id = NULL,
    source_platform = NULL,
    updated_at = 0
WHERE singleton_id = 1;
`;
