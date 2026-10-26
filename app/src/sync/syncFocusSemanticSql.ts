import {
  FOCUS_SEMANTIC_SCHEMA_VERSION,
  type FocusSemanticEntityType,
  type FocusSemanticRecordKind,
} from './syncFocusSemantic';

export const FOCUS_SEMANTIC_CAPTURE_SCHEMA_VERSION = 1 as const;
export const FOCUS_SEMANTIC_STORAGE_SCHEMA_VERSION = 1 as const;
export const FOCUS_SEMANTIC_CAPTURE_LEASE_MS = 60_000;

type CaptureAction = 'insert' | 'update' | 'delete';
type CaptureSpec = {
  name: string;
  tableName: string;
  entityType: FocusSemanticEntityType;
  kind: FocusSemanticRecordKind;
  idExpression(row: 'NEW' | 'OLD'): string;
  recordExpression(row: 'NEW' | 'OLD'): string;
  updateColumns: readonly string[];
};

const TOKEN_PATTERN = /^[a-z][a-z0-9_]*$/;

function token(value: string, label: string) {
  if (!TOKEN_PATTERN.test(value)) throw new Error(`${label} 不是受控 SQL token。`);
  return value;
}

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

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

function prefixedId(prefix: string, row: 'NEW' | 'OLD') {
  return `${sqlString(prefix)} || CAST(${row}.id AS TEXT)`;
}

const FOCUS_SESSION_RECORD = (row: 'NEW' | 'OLD') => {
  const base = `json_object(
  'id', ${row}.id,
  'mode', ${row}.mode,
  'userActivity', ${row}.user_activity,
  'baiyunActivity', ${row}.baiyun_activity,
  'startedAt', ${row}.started_at,
  'endedAt', ${row}.ended_at,
  'durationSeconds', ${row}.duration_seconds,
  'quality', ${row}.quality,
  'heartRateAvg', ${row}.heart_rate_avg,
  'temperatureAvg', ${row}.temperature_avg,
  'createdAt', ${row}.created_at
)`;
  return `CASE WHEN ${row}.review_json IS NULL THEN ${base}
    ELSE json_set(${base}, '$.review', json(${row}.review_json)) END`;
};

const FOCUS_LOG_RECORD = (row: 'NEW' | 'OLD') => `json_object(
  'id', ${row}.id,
  'sessionId', ${row}.session_id,
  'role', ${row}.role,
  'content', ${row}.content,
  'createdAt', ${row}.created_at,
  'elapsedSeconds', ${row}.elapsed_seconds,
  'trigger', ${row}.trigger
)`;

export const FOCUS_SEMANTIC_CAPTURE_SPECS:
readonly CaptureSpec[] = [
  {
    name: 'focus_session',
    tableName: 'focus_sessions',
    entityType: 'focus-session',
    kind: 'focus-session',
    idExpression: (row) => prefixedId('focus-session:', row),
    recordExpression: FOCUS_SESSION_RECORD,
    updateColumns: [
      'mode',
      'user_activity',
      'baiyun_activity',
      'started_at',
      'ended_at',
      'duration_seconds',
      'quality',
      'heart_rate_avg',
      'temperature_avg',
      'created_at',
      'review_json',
    ],
  },
  {
    name: 'focus_log',
    tableName: 'focus_logs',
    entityType: 'focus-log',
    kind: 'focus-log',
    idExpression: (row) => prefixedId('focus-log:', row),
    recordExpression: FOCUS_LOG_RECORD,
    updateColumns: [
      'session_id',
      'role',
      'content',
      'created_at',
      'elapsed_seconds',
      'trigger',
    ],
  },
];

export const FOCUS_SEMANTIC_EXPECTED_CAPTURE_TRIGGER_COUNT =
  FOCUS_SEMANTIC_CAPTURE_SPECS.length * 3;

function captureEnabledPredicate() {
  return `EXISTS (
    SELECT 1 FROM focus_sync_runtime
    WHERE singleton_id = 1
      AND capture_enabled = 1
      AND suppress_capture = 0
      AND vault_id IS NOT NULL
      AND source_device_id IS NOT NULL
  )`;
}

function parentRevisionIdsExpression(
  entityType: FocusSemanticEntityType,
  entityId: string,
) {
  return `COALESCE((
    SELECT json_group_array(revision_id)
    FROM (
      SELECT revision_id
      FROM focus_sync_entity_heads
      WHERE entity_type = ${sqlString(entityType)}
        AND entity_id = ${entityId}
      ORDER BY revision_id ASC
    )
  ), json('[]'))`;
}

function insertOutboxStatement(input: {
  spec: CaptureSpec;
  row: 'NEW' | 'OLD';
  operation: 'upsert' | 'delete';
}) {
  const entityId = input.spec.idExpression(input.row);
  const payload = input.operation === 'delete'
    ? `json_object(
        'schemaVersion', ${FOCUS_SEMANTIC_SCHEMA_VERSION},
        'kind', ${sqlString(input.spec.kind)},
        'deletedAt', ${unixMillisecondsExpression()}
      )`
    : `json_object(
        'schemaVersion', ${FOCUS_SEMANTIC_SCHEMA_VERSION},
        'kind', ${sqlString(input.spec.kind)},
        'record', ${input.spec.recordExpression(input.row)}
      )`;
  return `INSERT INTO focus_sync_domain_outbox (
    mutation_id, revision_id, parent_revision_ids_json,
    vault_id, source_device_id, entity_type, entity_id,
    operation, schema_version, payload_json, state,
    available_at, created_at, updated_at
  )
  SELECT
    ${uuidV4Expression()},
    ${uuidV4Expression()},
    ${parentRevisionIdsExpression(input.spec.entityType, entityId)},
    vault_id,
    source_device_id,
    ${sqlString(input.spec.entityType)},
    ${entityId},
    ${sqlString(input.operation)},
    ${FOCUS_SEMANTIC_SCHEMA_VERSION},
    ${payload},
    'pending',
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()}
  FROM focus_sync_runtime
  WHERE singleton_id = 1;`;
}

function advanceHeadsStatements(spec: CaptureSpec, row: 'NEW' | 'OLD') {
  const entityId = spec.idExpression(row);
  return `
  DELETE FROM focus_sync_entity_heads
  WHERE entity_type = ${sqlString(spec.entityType)}
    AND entity_id = ${entityId};

  INSERT INTO focus_sync_entity_heads (
    entity_type, entity_id, revision_id, updated_at
  )
  SELECT
    ${sqlString(spec.entityType)},
    ${entityId},
    revision_id,
    created_at
  FROM focus_sync_domain_outbox
  WHERE local_sequence = last_insert_rowid();`;
}

function triggerName(spec: CaptureSpec, action: CaptureAction) {
  return `focus_sync_capture_${token(spec.name, 'spec name')}_${action}`;
}

function buildCaptureTrigger(spec: CaptureSpec, action: CaptureAction) {
  const row = action === 'delete' ? 'OLD' : 'NEW';
  const operation = action === 'delete' ? 'delete' : 'upsert';
  const changed = action === 'update'
    ? ` AND (${spec.updateColumns.map((column) => {
      const name = token(column, `${spec.name} update column`);
      return `OLD.${name} IS NOT NEW.${name}`;
    }).join(' OR ')})`
    : '';
  return `
CREATE TRIGGER IF NOT EXISTS ${triggerName(spec, action)}
AFTER ${action.toUpperCase()} ON ${token(spec.tableName, 'table name')}
WHEN ${captureEnabledPredicate()}${changed}
BEGIN
  ${insertOutboxStatement({ spec, row, operation })}
  ${advanceHeadsStatements(spec, row)}
END;`;
}

export const FOCUS_SEMANTIC_CAPTURE_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS focus_sync_runtime (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  capture_enabled INTEGER NOT NULL DEFAULT 0 CHECK (capture_enabled IN (0, 1)),
  suppress_capture INTEGER NOT NULL DEFAULT 0 CHECK (suppress_capture IN (0, 1)),
  vault_id TEXT,
  source_device_id TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO focus_sync_runtime (
  singleton_id, capture_enabled, suppress_capture,
  vault_id, source_device_id, updated_at
) VALUES (1, 0, 0, NULL, NULL, 0);

CREATE TABLE IF NOT EXISTS focus_sync_domain_outbox (
  local_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  parent_revision_ids_json TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  source_sequence INTEGER,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 256),
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'restore')),
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

CREATE INDEX IF NOT EXISTS idx_focus_sync_outbox_ready
  ON focus_sync_domain_outbox(state, available_at, local_sequence);

CREATE TABLE IF NOT EXISTS focus_sync_entity_heads (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id, revision_id)
);

CREATE INDEX IF NOT EXISTS idx_focus_sync_heads_entity
  ON focus_sync_entity_heads(entity_type, entity_id, revision_id);

CREATE TABLE IF NOT EXISTS focus_sync_conflicts (
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

CREATE TABLE IF NOT EXISTS focus_sync_bootstrap_state (
  adapter_id TEXT NOT NULL,
  bootstrap_version INTEGER NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (adapter_id, bootstrap_version, vault_id, source_device_id)
);

CREATE TABLE IF NOT EXISTS focus_sync_schema_meta (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  storage_schema_version INTEGER NOT NULL,
  capture_schema_version INTEGER NOT NULL,
  trigger_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO focus_sync_schema_meta (
  singleton_id, storage_schema_version, capture_schema_version,
  trigger_count, updated_at
) VALUES (
  1,
  ${FOCUS_SEMANTIC_STORAGE_SCHEMA_VERSION},
  ${FOCUS_SEMANTIC_CAPTURE_SCHEMA_VERSION},
  ${FOCUS_SEMANTIC_EXPECTED_CAPTURE_TRIGGER_COUNT},
  ${unixMillisecondsExpression()}
)
ON CONFLICT(singleton_id) DO UPDATE SET
  storage_schema_version = excluded.storage_schema_version,
  capture_schema_version = excluded.capture_schema_version,
  trigger_count = excluded.trigger_count,
  updated_at = excluded.updated_at;
`;

export const FOCUS_SEMANTIC_CAPTURE_TRIGGER_SQL =
  FOCUS_SEMANTIC_CAPTURE_SPECS.flatMap((spec) => (
    (['insert', 'update', 'delete'] as const).map((action) => (
      buildCaptureTrigger(spec, action)
    ))
  )).join('\n');

export const FOCUS_SEMANTIC_FULL_CAPTURE_SCHEMA_SQL = `
${FOCUS_SEMANTIC_CAPTURE_TABLE_SCHEMA_SQL}
${FOCUS_SEMANTIC_CAPTURE_TRIGGER_SQL}
`;

export const FOCUS_SEMANTIC_RESET_TECHNICAL_STATE_SQL = `
DELETE FROM focus_sync_domain_outbox;
DELETE FROM focus_sync_entity_heads;
DELETE FROM focus_sync_conflicts;
DELETE FROM focus_sync_bootstrap_state;
UPDATE focus_sync_runtime
SET capture_enabled = 0,
    suppress_capture = 0,
    vault_id = NULL,
    source_device_id = NULL,
    updated_at = 0
WHERE singleton_id = 1;
`;
