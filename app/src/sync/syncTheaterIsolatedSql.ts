import {
  type TheaterIsolatedRecordKind,
} from './syncTheaterIsolated';

export const THEATER_ISOLATED_CAPTURE_SCHEMA_VERSION = 1 as const;
export const THEATER_ISOLATED_STORAGE_SCHEMA_VERSION = 1 as const;
export const THEATER_ISOLATED_CAPTURE_LEASE_MS = 60_000;

type CaptureAction = 'insert' | 'update' | 'delete';
type SqlRowAlias = 'NEW' | 'OLD' | 'ROW';
export type CaptureSpec = {
  schemaVersion?: 1 | 2;
  predicate?: (row: 'NEW' | 'OLD') => string;
  name: string;
  tableName: string;
  kindExpression(row: SqlRowAlias): string;
  entityIdExpression(row: SqlRowAlias): string;
  recordExpression(row: SqlRowAlias): string;
  updateColumns: readonly string[];
};

const TOKEN_PATTERN = /^[a-z][a-z0-9_]*$/;

function token(value: string, label: string) {
  if (!TOKEN_PATTERN.test(value)) {
    throw new Error(`${label} 不是受控 SQL token。`);
  }
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

function fixedKind(kind: TheaterIsolatedRecordKind) {
  return () => sqlString(kind);
}

function prefixedId(prefix: string, row: SqlRowAlias) {
  return `${sqlString(prefix)} || CAST(${row}.id AS TEXT)`;
}

const PERSONA_RECORD = (row: SqlRowAlias) => `json_object(
  'id', ${row}.id,
  'name', ${row}.name,
  'persona', ${row}.persona,
  'temperature', ${row}.temperature,
  'contextLimit', ${row}.context_limit,
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at
)`;

const CONVERSATION_RECORD = (row: SqlRowAlias) => `json_object(
  'id', ${row}.id,
  'title', ${row}.title,
  'personaId', ${row}.persona_id,
  'personaSnapshot', ${row}.persona_snapshot,
  'storyState', ${row}.story_state,
  'summaryInterval', ${row}.summary_interval,
  'lastSummarizedMessageCount', ${row}.last_summarized_message_count,
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at
)`;

function messageKindExpression(row: SqlRowAlias) {
  return `CASE WHEN ${row}.role = 'system'
    THEN 'legacy-context-note'
    ELSE 'message'
  END`;
}

function messageEntityIdExpression(row: SqlRowAlias) {
  return `CASE WHEN ${row}.role = 'system'
    THEN 'context-note:' || CAST(${row}.id AS TEXT)
    ELSE 'message:' || CAST(${row}.id AS TEXT)
  END`;
}

const MESSAGE_RECORD = (row: SqlRowAlias) => `CASE
  WHEN ${row}.role = 'system' THEN json_object(
    'id', ${row}.id,
    'conversationId', ${row}.conversation_id,
    'content', ${row}.content,
    'createdAt', ${row}.created_at,
    'updatedAt', ${row}.updated_at
  )
  ELSE json_object(
    'id', ${row}.id,
    'conversationId', ${row}.conversation_id,
    'role', ${row}.role,
    'content', ${row}.content,
    'createdAt', ${row}.created_at,
    'updatedAt', ${row}.updated_at
  )
END`;

export const THEATER_ISOLATED_CAPTURE_SPECS:
readonly CaptureSpec[] = [
  {
    name: 'persona',
    tableName: 'theater_personas',
    kindExpression: fixedKind('persona'),
    entityIdExpression: (row) => prefixedId('persona:', row),
    recordExpression: PERSONA_RECORD,
    updateColumns: [
      'name',
      'persona',
      'temperature',
      'context_limit',
      'created_at',
      'updated_at',
    ],
  },
  {
    name: 'conversation',
    tableName: 'theater_conversations',
    kindExpression: fixedKind('conversation'),
    entityIdExpression: (row) => prefixedId('conversation:', row),
    recordExpression: CONVERSATION_RECORD,
    updateColumns: [
      'title',
      'persona_id',
      'persona_snapshot',
      'story_state',
      'summary_interval',
      'last_summarized_message_count',
      'created_at',
      'updated_at',
    ],
  },
  {
    name: 'message',
    tableName: 'theater_messages',
    kindExpression: messageKindExpression,
    entityIdExpression: messageEntityIdExpression,
    recordExpression: MESSAGE_RECORD,
    updateColumns: [
      'conversation_id',
      'role',
      'content',
      'created_at',
      'updated_at',
    ],
  },
];

export const THEATER_ISOLATED_EXPECTED_CAPTURE_TRIGGER_COUNT =
  THEATER_ISOLATED_CAPTURE_SPECS.length * 3;

export function captureEnabledPredicate() {
  return `EXISTS (
    SELECT 1 FROM theater_sync_runtime
    WHERE singleton_id = 1
      AND capture_enabled = 1
      AND suppress_capture = 0
      AND vault_id IS NOT NULL
      AND source_device_id IS NOT NULL
  )`;
}

function parentRevisionIdsExpression(entityId: string) {
  return `COALESCE((
    SELECT json_group_array(revision_id)
    FROM (
      SELECT revision_id
      FROM theater_sync_entity_heads
      WHERE entity_type = 'theater-record'
        AND entity_id = ${entityId}
      ORDER BY revision_id ASC
    )
  ), json('[]'))`;
}

function insertOutboxStatement(input: {
  spec: CaptureSpec;
  row: 'NEW' | 'OLD';
  operation: 'upsert' | 'delete';
  condition?: string;
}) {
  const schemaVersion = input.spec.schemaVersion ?? 1;
  const entityId = input.spec.entityIdExpression(input.row);
  const kind = input.spec.kindExpression(input.row);
  const payload = input.operation === 'delete'
    ? `json_object(
        'schemaVersion', ${schemaVersion},
        'kind', ${kind},
        'deletedAt', ${unixMillisecondsExpression()}
      )`
    : `json_object(
        'schemaVersion', ${schemaVersion},
        'kind', ${kind},
        'record', ${input.spec.recordExpression(input.row)}
      )`;
  return `INSERT INTO theater_sync_domain_outbox (
    mutation_id, revision_id, parent_revision_ids_json,
    vault_id, source_device_id, entity_type, entity_id,
    operation, schema_version, payload_json, state,
    available_at, created_at, updated_at
  )
  SELECT
    ${uuidV4Expression()},
    ${uuidV4Expression()},
    ${parentRevisionIdsExpression(entityId)},
    vault_id,
    source_device_id,
    'theater-record',
    ${entityId},
    ${sqlString(input.operation)},
    ${schemaVersion},
    ${payload},
    'pending',
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()}
  FROM theater_sync_runtime
  WHERE singleton_id = 1${input.condition ? ` AND (${input.condition})` : ''};`;
}

function advanceHeadsStatements(spec: CaptureSpec, row: 'NEW' | 'OLD', condition?: string) {
  const entityId = spec.entityIdExpression(row);
  return `
  DELETE FROM theater_sync_entity_heads
  WHERE entity_type = 'theater-record'
    AND entity_id = ${entityId}${condition ? ` AND (${condition})` : ''};

  INSERT INTO theater_sync_entity_heads (
    entity_type, entity_id, revision_id, updated_at
  )
  SELECT
    'theater-record',
    ${entityId},
    revision_id,
    created_at
  FROM theater_sync_domain_outbox
  WHERE local_sequence = last_insert_rowid()${condition ? ` AND (${condition})` : ''};`;
}

export function buildCaptureUpsertBody(spec: CaptureSpec, condition: string) {
  return `${insertOutboxStatement({ spec, row: 'NEW', operation: 'upsert', condition })}
    ${advanceHeadsStatements(spec, 'NEW', condition)}`;
}

function triggerName(spec: CaptureSpec, action: CaptureAction) {
  return `theater_sync_capture_${token(spec.name, 'spec name')}_${action}`;
}

export function buildCaptureTrigger(spec: CaptureSpec, action: CaptureAction, forceUpsert = false) {
  const row = action === 'delete' ? 'OLD' : 'NEW';
  const operation = action === 'delete' && !forceUpsert ? 'delete' : 'upsert';
  const changed = action === 'update'
    ? ` AND (${spec.updateColumns.map((column) => {
      const name = token(column, `${spec.name} update column`);
      return `OLD.${name} IS NOT NEW.${name}`;
    }).join(' OR ')})`
    : '';
  return `
CREATE TRIGGER IF NOT EXISTS ${triggerName(spec, action)}
AFTER ${action.toUpperCase()} ON ${token(spec.tableName, 'table name')}
WHEN ${captureEnabledPredicate()}${changed}${spec.predicate ? ` AND (${spec.predicate(row)})` : ''}
BEGIN
  ${insertOutboxStatement({ spec, row, operation })}
  ${advanceHeadsStatements(spec, row)}
END;`;
}

export const THEATER_ISOLATED_CAPTURE_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS theater_sync_runtime (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  capture_enabled INTEGER NOT NULL DEFAULT 0 CHECK (capture_enabled IN (0, 1)),
  suppress_capture INTEGER NOT NULL DEFAULT 0 CHECK (suppress_capture IN (0, 1)),
  vault_id TEXT,
  source_device_id TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO theater_sync_runtime (
  singleton_id, capture_enabled, suppress_capture,
  vault_id, source_device_id, updated_at
) VALUES (1, 0, 0, NULL, NULL, 0);

CREATE TABLE IF NOT EXISTS theater_sync_domain_outbox (
  local_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  parent_revision_ids_json TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  source_sequence INTEGER,
  entity_type TEXT NOT NULL CHECK (entity_type = 'theater-record'),
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

CREATE INDEX IF NOT EXISTS idx_theater_sync_outbox_ready
  ON theater_sync_domain_outbox(state, available_at, local_sequence);

CREATE TABLE IF NOT EXISTS theater_sync_entity_heads (
  entity_type TEXT NOT NULL CHECK (entity_type = 'theater-record'),
  entity_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id, revision_id)
);

CREATE INDEX IF NOT EXISTS idx_theater_sync_heads_entity
  ON theater_sync_entity_heads(entity_type, entity_id, revision_id);

CREATE TABLE IF NOT EXISTS theater_sync_conflicts (
  conflict_id TEXT PRIMARY KEY NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type = 'theater-record'),
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

CREATE TABLE IF NOT EXISTS theater_sync_bootstrap_state (
  adapter_id TEXT NOT NULL,
  bootstrap_version INTEGER NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (adapter_id, bootstrap_version, vault_id, source_device_id)
);

CREATE TABLE IF NOT EXISTS theater_sync_schema_meta (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  storage_schema_version INTEGER NOT NULL,
  capture_schema_version INTEGER NOT NULL,
  trigger_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO theater_sync_schema_meta (
  singleton_id, storage_schema_version, capture_schema_version,
  trigger_count, updated_at
) VALUES (
  1,
  ${THEATER_ISOLATED_STORAGE_SCHEMA_VERSION},
  ${THEATER_ISOLATED_CAPTURE_SCHEMA_VERSION},
  ${THEATER_ISOLATED_EXPECTED_CAPTURE_TRIGGER_COUNT},
  ${unixMillisecondsExpression()}
)
ON CONFLICT(singleton_id) DO UPDATE SET
  storage_schema_version = excluded.storage_schema_version,
  capture_schema_version = excluded.capture_schema_version,
  trigger_count = excluded.trigger_count,
  updated_at = excluded.updated_at;
`;

export const THEATER_ISOLATED_CAPTURE_TRIGGER_SQL =
  THEATER_ISOLATED_CAPTURE_SPECS.flatMap((spec) => (
    (['insert', 'update', 'delete'] as const).map((action) => (
      buildCaptureTrigger(spec, action)
    ))
  )).join('\n');

export const THEATER_ISOLATED_IDENTITY_GUARD_SQL = `
CREATE TRIGGER IF NOT EXISTS theater_sync_guard_persona_identity
BEFORE UPDATE OF id ON theater_personas
WHEN OLD.id IS NOT NEW.id
BEGIN
  SELECT RAISE(ABORT, 'theater persona identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS theater_sync_guard_conversation_identity
BEFORE UPDATE OF id ON theater_conversations
WHEN OLD.id IS NOT NEW.id
BEGIN
  SELECT RAISE(ABORT, 'theater conversation identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS theater_sync_guard_message_identity
BEFORE UPDATE OF id, conversation_id, role ON theater_messages
WHEN OLD.id IS NOT NEW.id
  OR OLD.conversation_id IS NOT NEW.conversation_id
  OR OLD.role IS NOT NEW.role
BEGIN
  SELECT RAISE(ABORT, 'theater message identity and role are immutable');
END;
`;

export const THEATER_ISOLATED_FULL_CAPTURE_SCHEMA_SQL = `
${THEATER_ISOLATED_CAPTURE_TABLE_SCHEMA_SQL}
${THEATER_ISOLATED_CAPTURE_TRIGGER_SQL}
${THEATER_ISOLATED_IDENTITY_GUARD_SQL}
`;

export function bootstrapInsertStatement(spec: CaptureSpec) {
  const schemaVersion = spec.schemaVersion ?? 1;
  const kind = spec.kindExpression('ROW');
  const entityId = spec.entityIdExpression('ROW');
  return `INSERT INTO theater_sync_domain_outbox (
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
        FROM theater_sync_entity_heads
        WHERE entity_type = 'theater-record'
          AND entity_id = ${entityId}
        ORDER BY revision_id ASC
      )
    ), json('[]')),
    runtime.vault_id,
    runtime.source_device_id,
    'theater-record',
    ${entityId},
    'upsert',
    ${schemaVersion},
    json_object(
      'schemaVersion', ${schemaVersion},
      'kind', ${kind},
      'record', ${spec.recordExpression('ROW')}
    ),
    'pending',
    ?,
    ?,
    ?
  FROM ${token(spec.tableName, 'bootstrap table')} AS ROW
  CROSS JOIN theater_sync_runtime AS runtime
  WHERE runtime.singleton_id = 1
  ORDER BY ROW.id ASC`;
}

export const THEATER_ISOLATED_BOOTSTRAP_INSERT_SQL =
  THEATER_ISOLATED_CAPTURE_SPECS.map(bootstrapInsertStatement);

export function currentSnapshotSelectSql(spec: CaptureSpec) {
  const schemaVersion = spec.schemaVersion ?? 1;
  const entityId = spec.entityIdExpression('ROW');
  return `SELECT
    'theater-record' AS entity_type,
    ${entityId} AS entity_id,
    'upsert' AS operation,
    ${schemaVersion} AS schema_version,
    json_object(
      'schemaVersion', ${schemaVersion},
      'kind', ${spec.kindExpression('ROW')},
      'record', ${spec.recordExpression('ROW')}
    ) AS payload_json
  FROM ${token(spec.tableName, 'current snapshot table')} AS ROW
  ORDER BY ROW.id ASC`;
}

export const THEATER_ISOLATED_CURRENT_SNAPSHOT_SELECT_SQL =
  THEATER_ISOLATED_CAPTURE_SPECS.map(currentSnapshotSelectSql);

export const THEATER_ISOLATED_RESET_TECHNICAL_STATE_SQL = `
DELETE FROM theater_sync_domain_outbox;
DELETE FROM theater_sync_entity_heads;
DELETE FROM theater_sync_conflicts;
DELETE FROM theater_sync_bootstrap_state;
UPDATE theater_sync_runtime
SET capture_enabled = 0,
    suppress_capture = 0,
    vault_id = NULL,
    source_device_id = NULL,
    updated_at = 0
WHERE singleton_id = 1;
`;
