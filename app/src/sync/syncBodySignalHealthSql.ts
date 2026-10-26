import {
  BODY_SIGNAL_DAILY_SUMMARY_RETENTION_DAYS,
  BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS,
  BODY_SIGNAL_HEALTH_SCHEMA_VERSION,
  type BodySignalHealthRecordKind,
} from './syncBodySignalHealth';

export {
  ALL_CAPTURE_DEFINITIONS as BODY_SIGNAL_HEALTH_CAPTURE_DEFINITIONS,
  entityIdExpression as bodySignalHealthEntityIdExpression,
  recordExpression as bodySignalHealthRecordExpression,
};

export const BODY_SIGNAL_HEALTH_CAPTURE_SCHEMA_VERSION = 2 as const;
export const BODY_SIGNAL_HEALTH_STORAGE_SCHEMA_VERSION = 1 as const;
export const BODY_SIGNAL_HEALTH_CAPTURE_LEASE_MS = 60_000;
export const BODY_SIGNAL_HEALTH_EXPECTED_CAPTURE_TRIGGER_COUNT = 4;
export const BODY_SIGNAL_HEALTH_SUMMARY_SHARE_INTERVAL_MS =
  60 * 60 * 1000;

type CaptureDefinition = {
  kind: BodySignalHealthRecordKind;
  entityType: 'care-summary' | 'collection-policy' | 'reading';
  table: string;
  localIdColumn: string;
  updateColumns: readonly string[];
};

const ALL_CAPTURE_DEFINITIONS: readonly CaptureDefinition[] = [
  {
    kind: 'body-signal-reading',
    entityType: 'reading',
    table: 'body_signal_readings',
    localIdColumn: 'id',
    updateColumns: [],
  },
  {
    kind: 'body-signal-care-summary',
    entityType: 'care-summary',
    table: 'body_signal_care_summaries',
    localIdColumn: 'id',
    updateColumns: [
      'sample_count',
      'average',
      'minimum',
      'maximum',
      'first_measured_at',
      'last_measured_at',
      'generated_at',
      'updated_at',
    ],
  },
  {
    kind: 'body-signal-collection-policy',
    entityType: 'collection-policy',
    table: 'body_signal_collection_policy',
    localIdColumn: 'id',
    updateColumns: [
      'auto_measure_after_reconnect',
      'auto_reconnect_enabled',
      'preferred_device_alias',
      'raw_retention_days',
      'updated_at',
    ],
  },
];

const SUMMARY_CHECKPOINT_DEFINITIONS = ALL_CAPTURE_DEFINITIONS.filter(
  (definition) => definition.kind === 'body-signal-care-summary',
);

const LIVE_CAPTURE_DEFINITIONS = ALL_CAPTURE_DEFINITIONS.filter(
  (definition) => definition.kind === 'body-signal-collection-policy',
);

const CURRENT_SNAPSHOT_DEFINITIONS = ALL_CAPTURE_DEFINITIONS.filter(
  (definition) => definition.kind !== 'body-signal-reading',
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

function sharedDeviceAliasExpression(
  row: 'NEW' | 'OLD' | 'ROW',
) {
  const value = `${row}.source_device_name`;
  const colonMac =
    `'[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:`
    + `[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:`
    + `[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]'`;
  const hyphenMac = colonMac.replaceAll(':', '-');
  return `CASE
    WHEN length(trim(${value})) = 17
      AND (lower(trim(${value})) GLOB ${colonMac}
        OR lower(trim(${value})) GLOB ${hyphenMac})
    THEN NULL
    ELSE ${value}
  END`;
}

function entityIdExpression(
  definition: CaptureDefinition,
  row: 'NEW' | 'OLD' | 'ROW',
) {
  return `'${definition.kind}:' || CAST(${row}.${definition.localIdColumn} AS TEXT)`;
}

function recordExpression(
  kind: BodySignalHealthRecordKind,
  row: 'NEW' | 'OLD' | 'ROW',
) {
  if (kind === 'body-signal-reading') {
    return `json_object(
      'id', ${row}.id,
      'kind', ${row}.kind,
      'value', ${row}.value,
      'unit', ${row}.unit,
      'measuredAt', ${row}.measured_at,
      'receivedAt', ${row}.received_at,
      'originDeviceId', ${row}.origin_device_id,
      'originPlatform', ${row}.origin_platform,
      'sourceProvider', ${row}.source_provider,
      'sourceDeviceAlias',
        ${sharedDeviceAliasExpression(row)},
      'confidence', ${row}.confidence,
      'clockConfidence', ${row}.clock_confidence,
      'samplingMethod', ${row}.sampling_method,
      'retentionUntil', ${row}.retention_until,
      'createdAt', ${row}.created_at
    )`;
  }
  if (kind === 'body-signal-care-summary') {
    return `json_object(
      'id', ${row}.id,
      'dateKey', ${row}.date_key,
      'kind', ${row}.kind,
      'originDeviceId', ${row}.origin_device_id,
      'originPlatform', ${row}.origin_platform,
      'sourceScope', 'origin-device',
      'sampleCount', ${row}.sample_count,
      'average', ${row}.average,
      'minimum', ${row}.minimum,
      'maximum', ${row}.maximum,
      'firstMeasuredAt', ${row}.first_measured_at,
      'lastMeasuredAt', ${row}.last_measured_at,
      'generatedAt', ${row}.generated_at,
      'updatedAt', ${row}.updated_at
    )`;
  }
  return `json_object(
    'id', ${row}.id,
    'autoMeasureAfterReconnect',
      ${jsonBoolean(`${row}.auto_measure_after_reconnect <> 0`)},
    'autoReconnectEnabled',
      ${jsonBoolean(`${row}.auto_reconnect_enabled <> 0`)},
    'preferredDeviceAlias', ${row}.preferred_device_alias,
    'rawRetentionDays', ${row}.raw_retention_days,
    'updatedAt', ${row}.updated_at
  )`;
}

function captureEnabledPredicate() {
  return `EXISTS (
    SELECT 1 FROM body_signal_sync_runtime
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
      FROM body_signal_sync_entity_heads
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
        'schemaVersion', ${BODY_SIGNAL_HEALTH_SCHEMA_VERSION},
        'kind', '${definition.kind}',
        'deletedAt', ${unixMillisecondsExpression()}
      )`
    : `json_object(
        'schemaVersion', ${BODY_SIGNAL_HEALTH_SCHEMA_VERSION},
        'kind', '${definition.kind}',
        'record', ${recordExpression(definition.kind, row)}
      )`;
  return `INSERT INTO body_signal_sync_domain_outbox (
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
    ${BODY_SIGNAL_HEALTH_SCHEMA_VERSION},
    ${payload},
    'pending',
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()}
  FROM body_signal_sync_runtime
  WHERE singleton_id = 1;`;
}

function advanceHeadsStatements(
  definition: CaptureDefinition,
  row: 'NEW' | 'OLD',
) {
  return `
  DELETE FROM body_signal_sync_entity_heads
  WHERE entity_type = '${definition.entityType}'
    AND entity_id = ${entityIdExpression(definition, row)};

  INSERT INTO body_signal_sync_entity_heads (
    entity_type, entity_id, revision_id, updated_at
  )
  SELECT
    '${definition.entityType}',
    ${entityIdExpression(definition, row)},
    revision_id,
    created_at
  FROM body_signal_sync_domain_outbox
  WHERE local_sequence = last_insert_rowid();`;
}

function updateChangedPredicate(columns: readonly string[]) {
  return columns
    .map((column) => `OLD.${column} IS NOT NEW.${column}`)
    .join('\n    OR ');
}

function captureTriggers(definition: CaptureDefinition) {
  const triggerKind = definition.kind.replace(/-/gu, '_');
  const insertProvenance = definition.kind === 'body-signal-reading'
    ? ` AND NEW.origin_device_id IS NOT NULL
  AND NEW.origin_platform IS NOT NULL
  AND NEW.received_at IS NOT NULL
  AND NEW.clock_confidence IS NOT NULL
  AND NEW.sampling_method IS NOT NULL
  AND NEW.retention_until IS NOT NULL`
    : '';
  const updateTrigger = definition.updateColumns.length
    ? `
CREATE TRIGGER IF NOT EXISTS body_signal_sync_capture_${triggerKind}_update
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
CREATE TRIGGER IF NOT EXISTS body_signal_sync_capture_${triggerKind}_insert
AFTER INSERT ON ${definition.table}
WHEN ${captureEnabledPredicate()}${insertProvenance}
BEGIN
  ${insertOutboxStatement(definition, 'NEW', 'upsert')}
  ${advanceHeadsStatements(definition, 'NEW')}
END;
${updateTrigger}
CREATE TRIGGER IF NOT EXISTS body_signal_sync_capture_${triggerKind}_delete
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
CREATE TRIGGER IF NOT EXISTS body_signal_sync_capture_${triggerKind}_delete
AFTER DELETE ON ${definition.table}
WHEN ${captureEnabledPredicate()}
BEGIN
  ${insertOutboxStatement(definition, 'OLD', 'delete')}
  ${advanceHeadsStatements(definition, 'OLD')}
END;`;
}

export const BODY_SIGNAL_HEALTH_BUSINESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS body_signal_care_summaries (
  id TEXT PRIMARY KEY NOT NULL,
  date_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('battery', 'heart_rate', 'hrv', 'spo2', 'stress')
  ),
  origin_device_id TEXT NOT NULL,
  origin_platform TEXT NOT NULL CHECK (
    origin_platform IN ('android', 'windows')
  ),
  sample_count INTEGER NOT NULL CHECK (sample_count >= 1),
  average REAL NOT NULL,
  minimum REAL NOT NULL,
  maximum REAL NOT NULL,
  first_measured_at INTEGER NOT NULL,
  last_measured_at INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (date_key, kind, origin_device_id)
);

CREATE INDEX IF NOT EXISTS idx_body_signal_summaries_date_kind
  ON body_signal_care_summaries(date_key, kind, origin_device_id);

CREATE TABLE IF NOT EXISTS body_signal_collection_policy (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'global'),
  auto_measure_after_reconnect INTEGER NOT NULL DEFAULT 1
    CHECK (auto_measure_after_reconnect IN (0, 1)),
  auto_reconnect_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (auto_reconnect_enabled IN (0, 1)),
  preferred_device_alias TEXT,
  raw_retention_days INTEGER NOT NULL DEFAULT ${BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS}
    CHECK (raw_retention_days BETWEEN 1 AND 3650),
  updated_at INTEGER NOT NULL
);
`;

export const BODY_SIGNAL_HEALTH_CAPTURE_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS body_signal_sync_runtime (
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

INSERT OR IGNORE INTO body_signal_sync_runtime (
  singleton_id, capture_enabled, suppress_capture,
  vault_id, source_device_id, source_platform, updated_at
) VALUES (1, 0, 0, NULL, NULL, NULL, 0);

CREATE TABLE IF NOT EXISTS body_signal_sync_domain_outbox (
  local_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  parent_revision_ids_json TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  source_sequence INTEGER,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN ('reading', 'care-summary', 'collection-policy')
  ),
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 256),
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

CREATE INDEX IF NOT EXISTS idx_body_signal_sync_outbox_ready
  ON body_signal_sync_domain_outbox(
    state, available_at, local_sequence
  );

CREATE TABLE IF NOT EXISTS body_signal_sync_entity_heads (
  entity_type TEXT NOT NULL CHECK (
    entity_type IN ('reading', 'care-summary', 'collection-policy')
  ),
  entity_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id, revision_id)
);

CREATE TABLE IF NOT EXISTS body_signal_sync_conflicts (
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

CREATE TABLE IF NOT EXISTS body_signal_sync_bootstrap_state (
  adapter_id TEXT NOT NULL,
  bootstrap_version INTEGER NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (
    adapter_id, bootstrap_version, vault_id, source_device_id
  )
);

CREATE TABLE IF NOT EXISTS body_signal_sync_summary_checkpoints (
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

CREATE TABLE IF NOT EXISTS body_signal_sync_schema_meta (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  storage_schema_version INTEGER NOT NULL,
  capture_schema_version INTEGER NOT NULL,
  trigger_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO body_signal_sync_schema_meta (
  singleton_id, storage_schema_version, capture_schema_version,
  trigger_count, updated_at
) VALUES (
  1,
  ${BODY_SIGNAL_HEALTH_STORAGE_SCHEMA_VERSION},
  ${BODY_SIGNAL_HEALTH_CAPTURE_SCHEMA_VERSION},
  ${BODY_SIGNAL_HEALTH_EXPECTED_CAPTURE_TRIGGER_COUNT},
  ${unixMillisecondsExpression()}
)
ON CONFLICT(singleton_id) DO UPDATE SET
  storage_schema_version = excluded.storage_schema_version,
  capture_schema_version = excluded.capture_schema_version,
  trigger_count = excluded.trigger_count,
  updated_at = excluded.updated_at;
`;

export const BODY_SIGNAL_HEALTH_RETIRED_CAPTURE_TRIGGER_SQL = `
DROP TRIGGER IF EXISTS body_signal_sync_capture_body_signal_reading_insert;
DROP TRIGGER IF EXISTS body_signal_sync_capture_body_signal_reading_delete;
DROP TRIGGER IF EXISTS body_signal_sync_capture_body_signal_care_summary_insert;
DROP TRIGGER IF EXISTS body_signal_sync_capture_body_signal_care_summary_update;
`;

export const BODY_SIGNAL_HEALTH_CAPTURE_TRIGGER_SQL = [
  ...LIVE_CAPTURE_DEFINITIONS.map(captureTriggers),
  ...SUMMARY_CHECKPOINT_DEFINITIONS.map(captureDeleteTrigger),
].join('\n');

export const BODY_SIGNAL_HEALTH_WRITE_GUARD_SQL = `
CREATE TRIGGER IF NOT EXISTS body_signal_sync_guard_reading_append_only
BEFORE UPDATE ON body_signal_readings
WHEN ${captureEnabledPredicate()}
BEGIN
  SELECT RAISE(
    ABORT,
    'body-signal.health reading is append-only'
  );
END;

CREATE TRIGGER IF NOT EXISTS body_signal_sync_guard_summary_identity
BEFORE UPDATE OF
  id, date_key, kind, origin_device_id, origin_platform
ON body_signal_care_summaries
WHEN OLD.id IS NOT NEW.id
  OR OLD.date_key IS NOT NEW.date_key
  OR OLD.kind IS NOT NEW.kind
  OR OLD.origin_device_id IS NOT NEW.origin_device_id
  OR OLD.origin_platform IS NOT NEW.origin_platform
BEGIN
  SELECT RAISE(
    ABORT,
    'body-signal.health care summary identity is immutable'
  );
END;

CREATE TRIGGER IF NOT EXISTS body_signal_sync_guard_summary_growth
BEFORE UPDATE ON body_signal_care_summaries
WHEN ${captureEnabledPredicate()}
  AND (
    NEW.sample_count < OLD.sample_count
    OR NEW.first_measured_at > OLD.first_measured_at
    OR NEW.last_measured_at < OLD.last_measured_at
    OR NEW.minimum > OLD.minimum
    OR NEW.maximum < OLD.maximum
    OR NEW.updated_at < OLD.updated_at
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'body-signal.health care summary cannot regress'
  );
END;

CREATE TRIGGER IF NOT EXISTS body_signal_sync_guard_policy_identity
BEFORE UPDATE OF id ON body_signal_collection_policy
WHEN OLD.id IS NOT NEW.id
BEGIN
  SELECT RAISE(
    ABORT,
    'body-signal.health collection policy identity is immutable'
  );
END;
`;

export const BODY_SIGNAL_HEALTH_PREPARE_SUMMARIES_SQL = `
INSERT OR IGNORE INTO body_signal_care_summaries (
  id, date_key, kind, origin_device_id, origin_platform,
  sample_count, average, minimum, maximum,
  first_measured_at, last_measured_at, generated_at, updated_at
)
SELECT
  kind || ':' || origin_device_id || ':' ||
    strftime(
      '%Y-%m-%d',
      measured_at / 1000,
      'unixepoch',
      'localtime'
    ),
  strftime(
    '%Y-%m-%d',
    measured_at / 1000,
    'unixepoch',
    'localtime'
  ) AS date_key,
  kind,
  origin_device_id,
  origin_platform,
  COUNT(*),
  AVG(value),
  MIN(value),
  MAX(value),
  MIN(measured_at),
  MAX(measured_at),
  MAX(received_at),
  ?
FROM body_signal_readings
WHERE origin_device_id IS NOT NULL
  AND origin_platform IS NOT NULL
GROUP BY
  strftime(
    '%Y-%m-%d',
    measured_at / 1000,
    'unixepoch',
    'localtime'
  ),
  kind,
  origin_device_id,
  origin_platform
ORDER BY
  strftime(
    '%Y-%m-%d',
    measured_at / 1000,
    'unixepoch',
    'localtime'
  ) ASC,
  kind ASC,
  origin_device_id ASC;
`;

export const BODY_SIGNAL_HEALTH_FULL_CAPTURE_SCHEMA_SQL = `
${BODY_SIGNAL_HEALTH_BUSINESS_SCHEMA_SQL}
${BODY_SIGNAL_HEALTH_CAPTURE_TABLE_SCHEMA_SQL}
${BODY_SIGNAL_HEALTH_RETIRED_CAPTURE_TRIGGER_SQL}
${BODY_SIGNAL_HEALTH_CAPTURE_TRIGGER_SQL}
${BODY_SIGNAL_HEALTH_WRITE_GUARD_SQL}
`;

function bootstrapInsertSql(definition: CaptureDefinition) {
  const provenance = definition.kind === 'body-signal-reading'
    ? `AND ROW.origin_device_id IS NOT NULL
  AND ROW.origin_platform IS NOT NULL
  AND ROW.received_at IS NOT NULL
  AND ROW.clock_confidence IS NOT NULL
  AND ROW.sampling_method IS NOT NULL
  AND ROW.retention_until IS NOT NULL`
    : '';
  return `
INSERT INTO body_signal_sync_domain_outbox (
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
  ${BODY_SIGNAL_HEALTH_SCHEMA_VERSION},
  json_object(
    'schemaVersion', ${BODY_SIGNAL_HEALTH_SCHEMA_VERSION},
    'kind', '${definition.kind}',
    'record', ${recordExpression(definition.kind, 'ROW')}
  ),
  'pending',
  ?,
  ?,
  ?
FROM ${definition.table} AS ROW
CROSS JOIN body_signal_sync_runtime AS runtime
WHERE runtime.singleton_id = 1
  ${provenance}
ORDER BY CAST(ROW.${definition.localIdColumn} AS TEXT) ASC;
`;
}

export const BODY_SIGNAL_HEALTH_BOOTSTRAP_INSERT_SQL =
  ALL_CAPTURE_DEFINITIONS.map(bootstrapInsertSql);

function summaryCheckpointInsertSql(definition: CaptureDefinition) {
  const payload = `json_object(
    'schemaVersion', ${BODY_SIGNAL_HEALTH_SCHEMA_VERSION},
    'kind', '${definition.kind}',
    'record', ${recordExpression(definition.kind, 'ROW')}
  )`;
  return `
INSERT INTO body_signal_sync_domain_outbox (
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
  ${BODY_SIGNAL_HEALTH_SCHEMA_VERSION},
  ${payload},
  'pending',
  ?,
  ?,
  ?
FROM ${definition.table} AS ROW
CROSS JOIN body_signal_sync_runtime AS runtime
LEFT JOIN body_signal_sync_summary_checkpoints AS checkpoint
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
      >= ${BODY_SIGNAL_HEALTH_SUMMARY_SHARE_INTERVAL_MS}
  )
ORDER BY CAST(ROW.${definition.localIdColumn} AS TEXT) ASC;
`;
}

export const BODY_SIGNAL_HEALTH_SUMMARY_CHECKPOINT_INSERT_SQL =
  SUMMARY_CHECKPOINT_DEFINITIONS.map(summaryCheckpointInsertSql);

function currentSnapshotSelectSql(definition: CaptureDefinition) {
  const provenance = definition.kind === 'body-signal-reading'
    ? `ROW.origin_device_id IS NOT NULL
      AND ROW.origin_platform IS NOT NULL
      AND ROW.received_at IS NOT NULL
      AND ROW.clock_confidence IS NOT NULL
      AND ROW.sampling_method IS NOT NULL
      AND ROW.retention_until IS NOT NULL`
    : '';
  const retention = definition.kind === 'body-signal-reading'
    ? `ROW.retention_until > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      AND ROW.measured_at + ${BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS * 86_400_000}
        > CAST(strftime('%s', 'now') AS INTEGER) * 1000`
    : definition.kind === 'body-signal-care-summary'
      ? `ROW.date_key >= date(
          'now', 'localtime',
          '-${BODY_SIGNAL_DAILY_SUMMARY_RETENTION_DAYS - 1} days'
        )`
      : '';
  const predicates = [provenance.trim(), retention]
    .filter(Boolean)
    .join('\n    AND ');
  return `SELECT
    '${definition.entityType}' AS entity_type,
    ${entityIdExpression(definition, 'ROW')} AS entity_id,
    'upsert' AS operation,
    ${BODY_SIGNAL_HEALTH_SCHEMA_VERSION} AS schema_version,
    json_object(
      'schemaVersion', ${BODY_SIGNAL_HEALTH_SCHEMA_VERSION},
      'kind', '${definition.kind}',
      'record', ${recordExpression(definition.kind, 'ROW')}
    ) AS payload_json
  FROM ${definition.table} AS ROW
  ${predicates ? `WHERE ${predicates}` : ''}
  ORDER BY CAST(ROW.${definition.localIdColumn} AS TEXT) ASC`;
}

export const BODY_SIGNAL_HEALTH_CURRENT_SNAPSHOT_SELECT_SQL =
  CURRENT_SNAPSHOT_DEFINITIONS.map(currentSnapshotSelectSql);

export const BODY_SIGNAL_HEALTH_RESET_TECHNICAL_STATE_SQL = `
DELETE FROM body_signal_sync_domain_outbox;
DELETE FROM body_signal_sync_entity_heads;
DELETE FROM body_signal_sync_conflicts;
DELETE FROM body_signal_sync_bootstrap_state;
DELETE FROM body_signal_sync_summary_checkpoints;
UPDATE body_signal_sync_runtime
SET capture_enabled = 0,
    suppress_capture = 0,
    vault_id = NULL,
    source_device_id = NULL,
    source_platform = NULL,
    updated_at = 0
WHERE singleton_id = 1;
`;
