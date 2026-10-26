import {
  PERIOD_HEALTH_SCHEMA_VERSION,
  type PeriodHealthEntityType,
  type PeriodHealthRecordKind,
} from './syncPeriodHealth';

export {
  CAPTURE_DEFINITIONS as PERIOD_HEALTH_CAPTURE_DEFINITIONS,
  entityIdExpression as periodHealthEntityIdExpression,
  recordExpression as periodHealthRecordExpression,
};

export const PERIOD_HEALTH_CAPTURE_SCHEMA_VERSION = 3 as const;
export const PERIOD_HEALTH_STORAGE_SCHEMA_VERSION = 3 as const;
export const PERIOD_HEALTH_CAPTURE_LEASE_MS = 60_000;
export const PERIOD_HEALTH_EXPECTED_CAPTURE_TRIGGER_COUNT = 9;

type RowAlias = 'NEW' | 'OLD' | 'ROW';

type CaptureDefinition = {
  kind: PeriodHealthRecordKind;
  entityType: PeriodHealthEntityType;
  table: string;
  localIdColumn: string;
  updateColumns: readonly string[];
  immutableColumns: readonly string[];
};

const CAPTURE_DEFINITIONS: readonly CaptureDefinition[] = [
  {
    kind: 'period-entry',
    entityType: 'entry',
    table: 'period_entries',
    localIdColumn: 'id',
    updateColumns: ['start_at', 'end_at', 'updated_at'],
    immutableColumns: ['id', 'created_at'],
  },
  {
    kind: 'period-daily-log',
    entityType: 'daily-log',
    table: 'period_daily_logs',
    localIdColumn: 'id',
    updateColumns: [
      'period_id',
      'body_state',
      'flow',
      'pain_level',
      'symptoms',
      'note',
      'updated_at',
    ],
    immutableColumns: ['id', 'date_key', 'created_at'],
  },
  {
    kind: 'period-reminder-settings',
    entityType: 'reminder-semantic',
    table: 'period_reminder_settings',
    localIdColumn: 'id',
    updateColumns: [
      'care_enabled',
      'care_frequency',
      'muted_date_key',
      'updated_at',
    ],
    immutableColumns: ['id'],
  },
];

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

function localIdExpression(
  definition: CaptureDefinition,
  row: RowAlias,
) {
  return `CAST(${row}.${definition.localIdColumn} AS TEXT)`;
}

function entityIdExpression(
  definition: CaptureDefinition,
  row: RowAlias,
) {
  return `'${definition.kind}:' || ${localIdExpression(definition, row)}`;
}

function recordExpression(
  kind: PeriodHealthRecordKind,
  row: RowAlias,
) {
  switch (kind) {
    case 'period-entry':
      return `json_object(
        'id', ${row}.id,
        'startAt', ${row}.start_at,
        'endAt', ${row}.end_at,
        'createdAt', ${row}.created_at,
        'updatedAt', ${row}.updated_at
      )`;
    case 'period-daily-log':
      return `json_object(
        'id', ${row}.id,
        'dateKey', ${row}.date_key,
        'periodId', ${row}.period_id,
        'bodyState', ${row}.body_state,
        'flow', ${row}.flow,
        'painLevel', ${row}.pain_level,
        'symptoms', json(${row}.symptoms),
        'note', ${row}.note,
        'createdAt', ${row}.created_at,
        'updatedAt', ${row}.updated_at
      )`;
    case 'period-companion-delivery':
      throw new Error('period_companion_delivery_retired');
    case 'period-reminder-settings':
      return `json_object(
        'id', ${row}.id,
        'careEnabled', ${jsonBoolean(`${row}.care_enabled <> 0`)},
        'careFrequency', ${row}.care_frequency,
        'mutedDateKey', ${row}.muted_date_key,
        'updatedAt', ${row}.updated_at
      )`;
    case 'period-reminder':
      throw new Error('经期通知记录已退役，不再捕获或导出。');
  }
}

function captureEnabledPredicate() {
  return `EXISTS (
    SELECT 1 FROM period_sync_runtime
    WHERE singleton_id = 1
      AND capture_enabled = 1
      AND suppress_capture = 0
      AND vault_id IS NOT NULL
      AND source_device_id IS NOT NULL
  )`;
}

function parentRevisionIdsExpression(
  definition: CaptureDefinition,
  row: RowAlias,
) {
  return `COALESCE((
    SELECT json_group_array(revision_id)
    FROM (
      SELECT revision_id
      FROM period_sync_entity_heads
      WHERE entity_type = '${definition.entityType}'
        AND entity_id = ${entityIdExpression(definition, row)}
      ORDER BY revision_id ASC
    )
  ), json('[]'))`;
}

function insertOutboxStatement(
  definition: CaptureDefinition,
  row: 'NEW' | 'OLD',
  operation: 'upsert' | 'delete',
) {
  const payload = operation === 'delete'
    ? `json_object(
        'schemaVersion', ${PERIOD_HEALTH_SCHEMA_VERSION},
        'kind', '${definition.kind}',
        'deletedAt', ${unixMillisecondsExpression()}
      )`
    : `json_object(
        'schemaVersion', ${PERIOD_HEALTH_SCHEMA_VERSION},
        'kind', '${definition.kind}',
        'record', ${recordExpression(definition.kind, row)}
      )`;
  return `INSERT INTO period_sync_domain_outbox (
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
    ${PERIOD_HEALTH_SCHEMA_VERSION},
    ${payload},
    'pending',
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()}
  FROM period_sync_runtime
  WHERE singleton_id = 1;`;
}

function advanceHeadsStatements(
  definition: CaptureDefinition,
  row: 'NEW' | 'OLD',
) {
  return `
  DELETE FROM period_sync_entity_heads
  WHERE entity_type = '${definition.entityType}'
    AND entity_id = ${entityIdExpression(definition, row)};

  INSERT INTO period_sync_entity_heads (
    entity_type, entity_id, revision_id, updated_at
  )
  SELECT
    '${definition.entityType}',
    ${entityIdExpression(definition, row)},
    revision_id,
    created_at
  FROM period_sync_domain_outbox
  WHERE local_sequence = last_insert_rowid();`;
}

function updateChangedPredicate(columns: readonly string[]) {
  return columns
    .map((column) => `OLD.${column} IS NOT NEW.${column}`)
    .join('\n    OR ');
}

function captureTriggers(definition: CaptureDefinition) {
  const triggerKind = definition.kind.replace(/-/gu, '_');
  return `
CREATE TRIGGER IF NOT EXISTS period_sync_capture_${triggerKind}_insert
AFTER INSERT ON ${definition.table}
WHEN ${captureEnabledPredicate()}
BEGIN
  ${insertOutboxStatement(definition, 'NEW', 'upsert')}
  ${advanceHeadsStatements(definition, 'NEW')}
END;

CREATE TRIGGER IF NOT EXISTS period_sync_capture_${triggerKind}_update
AFTER UPDATE ON ${definition.table}
WHEN ${captureEnabledPredicate()}
  AND (
    ${updateChangedPredicate(definition.updateColumns)}
  )
BEGIN
  ${insertOutboxStatement(definition, 'NEW', 'upsert')}
  ${advanceHeadsStatements(definition, 'NEW')}
END;

CREATE TRIGGER IF NOT EXISTS period_sync_capture_${triggerKind}_delete
AFTER DELETE ON ${definition.table}
WHEN ${captureEnabledPredicate()}
BEGIN
  ${insertOutboxStatement(definition, 'OLD', 'delete')}
  ${advanceHeadsStatements(definition, 'OLD')}
END;`;
}

function identityGuard(definition: CaptureDefinition) {
  if (!definition.immutableColumns.length) return '';
  const triggerKind = definition.kind.replace(/-/gu, '_');
  return `
CREATE TRIGGER IF NOT EXISTS period_sync_guard_${triggerKind}_identity
BEFORE UPDATE OF ${definition.immutableColumns.join(', ')}
ON ${definition.table}
WHEN ${definition.immutableColumns
    .map((column) => `OLD.${column} IS NOT NEW.${column}`)
    .join('\n  OR ')}
BEGIN
  SELECT RAISE(ABORT, 'period.health ${definition.kind} identity is immutable');
END;`;
}

export const PERIOD_HEALTH_CAPTURE_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS period_sync_runtime (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  capture_enabled INTEGER NOT NULL DEFAULT 0 CHECK (capture_enabled IN (0, 1)),
  suppress_capture INTEGER NOT NULL DEFAULT 0 CHECK (suppress_capture IN (0, 1)),
  vault_id TEXT,
  source_device_id TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO period_sync_runtime (
  singleton_id, capture_enabled, suppress_capture,
  vault_id, source_device_id, updated_at
) VALUES (1, 0, 0, NULL, NULL, 0);

CREATE TABLE IF NOT EXISTS period_sync_domain_outbox (
  local_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  parent_revision_ids_json TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  source_sequence INTEGER,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'entry', 'daily-log', 'companion-delivery', 'reminder-semantic'
    )
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

CREATE INDEX IF NOT EXISTS idx_period_sync_outbox_ready
  ON period_sync_domain_outbox(state, available_at, local_sequence);

CREATE TABLE IF NOT EXISTS period_sync_entity_heads (
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'entry', 'daily-log', 'companion-delivery', 'reminder-semantic'
    )
  ),
  entity_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id, revision_id)
);

CREATE TABLE IF NOT EXISTS period_sync_conflicts (
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

CREATE TABLE IF NOT EXISTS period_sync_pending_notification_cancellations (
  notification_id TEXT PRIMARY KEY NOT NULL,
  reminder_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS period_sync_bootstrap_state (
  adapter_id TEXT NOT NULL,
  bootstrap_version INTEGER NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (adapter_id, bootstrap_version, vault_id, source_device_id)
);

CREATE TABLE IF NOT EXISTS period_sync_schema_meta (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  storage_schema_version INTEGER NOT NULL,
  capture_schema_version INTEGER NOT NULL,
  trigger_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO period_sync_schema_meta (
  singleton_id, storage_schema_version, capture_schema_version,
  trigger_count, updated_at
) VALUES (
  1,
  ${PERIOD_HEALTH_STORAGE_SCHEMA_VERSION},
  ${PERIOD_HEALTH_CAPTURE_SCHEMA_VERSION},
  ${PERIOD_HEALTH_EXPECTED_CAPTURE_TRIGGER_COUNT},
  ${unixMillisecondsExpression()}
)
ON CONFLICT(singleton_id) DO UPDATE SET
  storage_schema_version = excluded.storage_schema_version,
  capture_schema_version = excluded.capture_schema_version,
  trigger_count = excluded.trigger_count,
  updated_at = excluded.updated_at;
`;

export const PERIOD_HEALTH_CAPTURE_TRIGGER_SQL =
  CAPTURE_DEFINITIONS.map(captureTriggers).join('\n');

export const PERIOD_HEALTH_WRITE_GUARD_SQL = `
${CAPTURE_DEFINITIONS.map(identityGuard).join('\n')}

CREATE TRIGGER IF NOT EXISTS period_sync_guard_entry_end_state
BEFORE UPDATE OF end_at ON period_entries
WHEN OLD.end_at IS NOT NULL AND NEW.end_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'period entry end state cannot regress');
END;

`;

export const PERIOD_HEALTH_FULL_CAPTURE_SCHEMA_SQL = `
${PERIOD_HEALTH_CAPTURE_TABLE_SCHEMA_SQL}
${PERIOD_HEALTH_CAPTURE_TRIGGER_SQL}
${PERIOD_HEALTH_WRITE_GUARD_SQL}
`;

function bootstrapInsertSql(definition: CaptureDefinition) {
  return `
INSERT INTO period_sync_domain_outbox (
  mutation_id, revision_id, parent_revision_ids_json,
  vault_id, source_device_id, entity_type, entity_id,
  operation, schema_version, payload_json, state,
  available_at, created_at, updated_at
)
SELECT
  ${uuidV4Expression()},
  ${uuidV4Expression()},
  COALESCE((
    SELECT json_group_array(revision_id)
    FROM (
      SELECT revision_id
      FROM period_sync_entity_heads
      WHERE entity_type = '${definition.entityType}'
        AND entity_id = ${entityIdExpression(definition, 'ROW')}
      ORDER BY revision_id ASC
    )
  ), json('[]')),
  runtime.vault_id,
  runtime.source_device_id,
  '${definition.entityType}',
  ${entityIdExpression(definition, 'ROW')},
  'upsert',
  ${PERIOD_HEALTH_SCHEMA_VERSION},
  json_object(
    'schemaVersion', ${PERIOD_HEALTH_SCHEMA_VERSION},
    'kind', '${definition.kind}',
    'record', ${recordExpression(definition.kind, 'ROW')}
  ),
  'pending',
  ?,
  ?,
  ?
FROM ${definition.table} AS ROW
CROSS JOIN period_sync_runtime AS runtime
WHERE runtime.singleton_id = 1
ORDER BY ${localIdExpression(definition, 'ROW')} ASC;
`;
}

export const PERIOD_HEALTH_BOOTSTRAP_INSERT_SQL =
  CAPTURE_DEFINITIONS.map(bootstrapInsertSql);

function currentSnapshotSelectSql(definition: CaptureDefinition) {
  return `SELECT
    '${definition.entityType}' AS entity_type,
    ${entityIdExpression(definition, 'ROW')} AS entity_id,
    'upsert' AS operation,
    ${PERIOD_HEALTH_SCHEMA_VERSION} AS schema_version,
    json_object(
      'schemaVersion', ${PERIOD_HEALTH_SCHEMA_VERSION},
      'kind', '${definition.kind}',
      'record', ${recordExpression(definition.kind, 'ROW')}
    ) AS payload_json
  FROM ${definition.table} AS ROW
  ORDER BY ${localIdExpression(definition, 'ROW')} ASC`;
}

export const PERIOD_HEALTH_CURRENT_SNAPSHOT_SELECT_SQL =
  CAPTURE_DEFINITIONS.map(currentSnapshotSelectSql);

export const PERIOD_HEALTH_RESET_TECHNICAL_STATE_SQL = `
DELETE FROM period_sync_domain_outbox;
DELETE FROM period_sync_entity_heads;
DELETE FROM period_sync_conflicts;
DELETE FROM period_sync_pending_notification_cancellations;
DELETE FROM period_sync_bootstrap_state;
UPDATE period_sync_runtime
SET capture_enabled = 0,
    suppress_capture = 0,
    vault_id = NULL,
    source_device_id = NULL,
    updated_at = 0
WHERE singleton_id = 1;
`;
