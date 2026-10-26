import {
  EXPENSE_LEDGER_SCHEMA_VERSION,
} from './syncExpenseLedger';

export const EXPENSE_LEDGER_CAPTURE_SCHEMA_VERSION = 2 as const;
export const EXPENSE_LEDGER_STORAGE_SCHEMA_VERSION = 2 as const;
export const EXPENSE_LEDGER_CAPTURE_LEASE_MS = 60_000;
export const EXPENSE_LEDGER_EXPECTED_CAPTURE_TRIGGER_COUNT = 3;

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

function entityId(row: 'NEW' | 'OLD' | 'ROW') {
  return `'expense-entry:' || CAST(${row}.id AS TEXT)`;
}

function recordExpression(row: 'NEW' | 'OLD' | 'ROW') {
  return `json_object(
    'id', ${row}.id,
    'type', ${row}.type,
    'amount', ${row}.amount,
    'category', ${row}.category,
    'note', ${row}.note,
    'occurredAt', ${row}.occurred_at,
    'source', ${row}.source,
    'createdAt', ${row}.created_at,
    'updatedAt', ${row}.updated_at,
    'originalExpenseId', ${row}.original_expense_id
  )`;
}

function captureEnabledPredicate() {
  return `EXISTS (
    SELECT 1 FROM expense_sync_runtime
    WHERE singleton_id = 1
      AND capture_enabled = 1
      AND suppress_capture = 0
      AND vault_id IS NOT NULL
      AND source_device_id IS NOT NULL
  )`;
}

function parentRevisionIdsExpression(row: 'NEW' | 'OLD') {
  return `COALESCE((
    SELECT json_group_array(revision_id)
    FROM (
      SELECT revision_id
      FROM expense_sync_entity_heads
      WHERE entity_type = 'expense-entry'
        AND entity_id = ${entityId(row)}
      ORDER BY revision_id ASC
    )
  ), json('[]'))`;
}

function insertOutboxStatement(
  row: 'NEW' | 'OLD',
  operation: 'upsert' | 'delete',
) {
  const payload = operation === 'delete'
    ? `json_object(
        'schemaVersion', ${EXPENSE_LEDGER_SCHEMA_VERSION},
        'kind', 'expense-entry',
        'deletedAt', ${unixMillisecondsExpression()}
      )`
    : `json_object(
        'schemaVersion', ${EXPENSE_LEDGER_SCHEMA_VERSION},
        'kind', 'expense-entry',
        'record', ${recordExpression(row)}
      )`;
  return `INSERT INTO expense_sync_domain_outbox (
    mutation_id, revision_id, parent_revision_ids_json,
    vault_id, source_device_id, entity_type, entity_id,
    operation, schema_version, payload_json, state,
    available_at, created_at, updated_at
  )
  SELECT
    ${uuidV4Expression()},
    ${uuidV4Expression()},
    ${parentRevisionIdsExpression(row)},
    vault_id,
    source_device_id,
    'expense-entry',
    ${entityId(row)},
    '${operation}',
    ${EXPENSE_LEDGER_SCHEMA_VERSION},
    ${payload},
    'pending',
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()}
  FROM expense_sync_runtime
  WHERE singleton_id = 1;`;
}

function advanceHeadsStatements(row: 'NEW' | 'OLD') {
  return `
  DELETE FROM expense_sync_entity_heads
  WHERE entity_type = 'expense-entry'
    AND entity_id = ${entityId(row)};

  INSERT INTO expense_sync_entity_heads (
    entity_type, entity_id, revision_id, updated_at
  )
  SELECT
    'expense-entry',
    ${entityId(row)},
    revision_id,
    created_at
  FROM expense_sync_domain_outbox
  WHERE local_sequence = last_insert_rowid();`;
}

export const EXPENSE_LEDGER_CAPTURE_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS expense_sync_runtime (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  capture_enabled INTEGER NOT NULL DEFAULT 0 CHECK (capture_enabled IN (0, 1)),
  suppress_capture INTEGER NOT NULL DEFAULT 0 CHECK (suppress_capture IN (0, 1)),
  vault_id TEXT,
  source_device_id TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO expense_sync_runtime (
  singleton_id, capture_enabled, suppress_capture,
  vault_id, source_device_id, updated_at
) VALUES (1, 0, 0, NULL, NULL, 0);

CREATE TABLE IF NOT EXISTS expense_sync_domain_outbox (
  local_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  parent_revision_ids_json TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  source_sequence INTEGER,
  entity_type TEXT NOT NULL CHECK (entity_type = 'expense-entry'),
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

CREATE INDEX IF NOT EXISTS idx_expense_sync_outbox_ready
  ON expense_sync_domain_outbox(state, available_at, local_sequence);

CREATE TABLE IF NOT EXISTS expense_sync_entity_heads (
  entity_type TEXT NOT NULL CHECK (entity_type = 'expense-entry'),
  entity_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id, revision_id)
);

CREATE TABLE IF NOT EXISTS expense_sync_conflicts (
  conflict_id TEXT PRIMARY KEY NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type = 'expense-entry'),
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

CREATE TABLE IF NOT EXISTS expense_sync_bootstrap_state (
  adapter_id TEXT NOT NULL,
  bootstrap_version INTEGER NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (adapter_id, bootstrap_version, vault_id, source_device_id)
);

CREATE TABLE IF NOT EXISTS expense_sync_schema_meta (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  storage_schema_version INTEGER NOT NULL,
  capture_schema_version INTEGER NOT NULL,
  trigger_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO expense_sync_schema_meta (
  singleton_id, storage_schema_version, capture_schema_version,
  trigger_count, updated_at
) VALUES (
  1,
  ${EXPENSE_LEDGER_STORAGE_SCHEMA_VERSION},
  ${EXPENSE_LEDGER_CAPTURE_SCHEMA_VERSION},
  ${EXPENSE_LEDGER_EXPECTED_CAPTURE_TRIGGER_COUNT},
  ${unixMillisecondsExpression()}
)
ON CONFLICT(singleton_id) DO UPDATE SET
  storage_schema_version = excluded.storage_schema_version,
  capture_schema_version = excluded.capture_schema_version,
  trigger_count = excluded.trigger_count,
  updated_at = excluded.updated_at;
`;

export const EXPENSE_LEDGER_CAPTURE_TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS expense_sync_capture_entry_insert
AFTER INSERT ON expense_entries
WHEN ${captureEnabledPredicate()}
BEGIN
  ${insertOutboxStatement('NEW', 'upsert')}
  ${advanceHeadsStatements('NEW')}
END;

CREATE TRIGGER IF NOT EXISTS expense_sync_capture_entry_update
AFTER UPDATE ON expense_entries
WHEN ${captureEnabledPredicate()}
  AND (
    OLD.type IS NOT NEW.type
    OR OLD.amount IS NOT NEW.amount
    OR OLD.category IS NOT NEW.category
    OR OLD.note IS NOT NEW.note
    OR OLD.occurred_at IS NOT NEW.occurred_at
    OR OLD.source IS NOT NEW.source
    OR OLD.created_at IS NOT NEW.created_at
    OR OLD.updated_at IS NOT NEW.updated_at
    OR OLD.original_expense_id IS NOT NEW.original_expense_id
  )
BEGIN
  ${insertOutboxStatement('NEW', 'upsert')}
  ${advanceHeadsStatements('NEW')}
END;

CREATE TRIGGER IF NOT EXISTS expense_sync_capture_entry_delete
AFTER DELETE ON expense_entries
WHEN ${captureEnabledPredicate()}
BEGIN
  ${insertOutboxStatement('OLD', 'delete')}
  ${advanceHeadsStatements('OLD')}
END;
`;

export const EXPENSE_LEDGER_IDENTITY_GUARD_SQL = `
CREATE TRIGGER IF NOT EXISTS expense_sync_guard_entry_identity
BEFORE UPDATE OF id ON expense_entries
WHEN OLD.id IS NOT NEW.id
BEGIN
  SELECT RAISE(ABORT, 'expense entry identity is immutable');
END;
`;

export const EXPENSE_LEDGER_FULL_CAPTURE_SCHEMA_SQL = `
DROP TRIGGER IF EXISTS expense_sync_capture_entry_insert;
DROP TRIGGER IF EXISTS expense_sync_capture_entry_update;
DROP TRIGGER IF EXISTS expense_sync_capture_entry_delete;
${EXPENSE_LEDGER_CAPTURE_TABLE_SCHEMA_SQL}
${EXPENSE_LEDGER_CAPTURE_TRIGGER_SQL}
${EXPENSE_LEDGER_IDENTITY_GUARD_SQL}
`;

export const EXPENSE_LEDGER_BOOTSTRAP_INSERT_SQL = `
INSERT INTO expense_sync_domain_outbox (
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
      FROM expense_sync_entity_heads
      WHERE entity_type = 'expense-entry'
        AND entity_id = ${entityId('ROW')}
      ORDER BY revision_id ASC
    )
  ), json('[]')),
  runtime.vault_id,
  runtime.source_device_id,
  'expense-entry',
  ${entityId('ROW')},
  'upsert',
  ${EXPENSE_LEDGER_SCHEMA_VERSION},
  json_object(
    'schemaVersion', ${EXPENSE_LEDGER_SCHEMA_VERSION},
    'kind', 'expense-entry',
    'record', ${recordExpression('ROW')}
  ),
  'pending',
  ?,
  ?,
  ?
FROM expense_entries AS ROW
CROSS JOIN expense_sync_runtime AS runtime
WHERE runtime.singleton_id = 1
ORDER BY ROW.id ASC;
`;

export const EXPENSE_LEDGER_CURRENT_SNAPSHOT_SELECT_SQL = [
  `SELECT
    'expense-entry' AS entity_type,
    ${entityId('ROW')} AS entity_id,
    'upsert' AS operation,
    ${EXPENSE_LEDGER_SCHEMA_VERSION} AS schema_version,
    json_object(
      'schemaVersion', ${EXPENSE_LEDGER_SCHEMA_VERSION},
      'kind', 'expense-entry',
      'record', ${recordExpression('ROW')}
    ) AS payload_json
  FROM expense_entries AS ROW
  ORDER BY ROW.id ASC`,
] as const;

export const EXPENSE_LEDGER_PRESERVED_REFUND_RELATION_SQL = `
  conflict_id LIKE 'refund-relation:%'
  AND EXISTS (
    SELECT 1 FROM expense_entries AS entry
    WHERE entry.type = 'refund'
      AND 'expense-entry:' || entry.original_expense_id = expense_sync_conflicts.entity_id
  )
`;

export const EXPENSE_LEDGER_RESET_TECHNICAL_STATE_SQL = `
DELETE FROM expense_sync_domain_outbox;
DELETE FROM expense_sync_entity_heads;
DELETE FROM expense_sync_conflicts
WHERE NOT (${EXPENSE_LEDGER_PRESERVED_REFUND_RELATION_SQL});
DELETE FROM expense_sync_bootstrap_state;
UPDATE expense_sync_runtime
SET capture_enabled = 0,
    suppress_capture = 0,
    vault_id = NULL,
    source_device_id = NULL,
    updated_at = 0
WHERE singleton_id = 1;
`;
