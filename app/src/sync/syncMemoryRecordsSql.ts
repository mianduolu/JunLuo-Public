import {
  DEFAULT_MEMORY_RECORD_CAPTURE_ACTIONS,
  MEMORY_RECORDS_SCHEMA_VERSION,
  MEMORY_RECORD_ENTITY_SPECS,
  type MemoryRecordCaptureAction,
  type MemoryRecordEntitySpec,
} from './syncMemoryRecords';
import { POST_SYNC_BASE_SCHEMA_SQL } from './syncBaiyunPostRecordsSql';
import { POST_CONFIRMATIONS_SCHEMA_SQL } from './syncBaiyunPostConfirmations';
import { POST_REVIEW_SCHEMA_SQL, buildPostReviewCaptureIdentitySql, buildPostReviewCapturePredicate } from './syncBaiyunPostReviews';

export const MEMORY_RECORDS_DATABASE_NAME = 'junluo-memory.db' as const;
export const MEMORY_RECORDS_CAPTURE_SCHEMA_VERSION = 15 as const;
export const MEMORY_RECORDS_STORAGE_SCHEMA_VERSION = 17 as const;
export const MEMORY_RECORDS_EXPECTED_CAPTURE_TRIGGER_COUNT =
  4 + MEMORY_RECORD_ENTITY_SPECS.reduce(
    (count, spec) => count + (
      spec.entityType === 'continuity-candidate' ? [] : spec.captureActions ?? DEFAULT_MEMORY_RECORD_CAPTURE_ACTIONS
    ).length,
    0,
  );
export const MEMORY_RECORDS_CAPTURE_LEASE_MS = 60_000;

const TOKEN_PATTERN = /^[a-z][a-z0-9_]*$/;

function assertSqlToken(value: string, label: string) {
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

function entityIdExpression(spec: MemoryRecordEntitySpec, rowAlias: 'NEW' | 'OLD') {
  const columns = spec.idColumns.map((column) => (
    `${rowAlias}.${assertSqlToken(column, `${spec.entityType} id column`)}`
  ));
  if (columns.length === 1) return `CAST(${columns[0]} AS TEXT)`;
  return `json_array(${columns.join(', ')})`;
}

function recordExpression(spec: MemoryRecordEntitySpec, rowAlias: 'NEW' | 'OLD') {
  const fields = Object.keys(spec.fields);
  if (spec.snapshotTableName) return `(SELECT json_object(${fields.map(field => `${sqlString(field)}, s.${field}`).join(', ')})
    FROM ${spec.snapshotTableName} s WHERE ${spec.idColumns.map(field => `s.${field} = ${rowAlias}.${field}`).join(' AND ')})`;
  return `json_object(
    ${fields.map((field) => (
      `${sqlString(field)}, ${rowAlias}.${assertSqlToken(field, `${spec.entityType} field`)}`
    )).join(',\n    ')}
  )`;
}

function parentRevisionIdsExpression(entityType: string, entityId: string) {
  return `COALESCE((
    SELECT json_group_array(revision_id)
    FROM (
      SELECT revision_id
      FROM memory_sync_entity_heads
      WHERE entity_type = ${sqlString(entityType)}
        AND entity_id = ${entityId}
      ORDER BY revision_id ASC
    )
  ), json('[]'))`;
}

function captureEnabledPredicate() {
  return `EXISTS (
    SELECT 1
    FROM memory_sync_runtime
    WHERE singleton_id = 1
      AND capture_enabled = 1
      AND suppress_capture = 0
      AND vault_id IS NOT NULL
      AND source_device_id IS NOT NULL
  )`;
}

function insertOutboxStatement(input: {
  spec: MemoryRecordEntitySpec;
  rowAlias: 'NEW' | 'OLD';
  operation: 'upsert' | 'append' | 'delete';
}) {
  const { spec, rowAlias, operation } = input;
  const schemaVersion = spec.schemaVersion ?? MEMORY_RECORDS_SCHEMA_VERSION;
  const entityId = entityIdExpression(spec, rowAlias);
  const payload = operation === 'delete'
    ? `json_object(
        'schemaVersion', ${schemaVersion},
        'deletedAt', ${unixMillisecondsExpression()}${spec.entityType === 'memory' ? `, 'chatSummaryCorrection', ${rowAlias}.chat_summary_correction_json` : spec.entityType === 'post' ? `, 'chatSummaryCorrection', (SELECT chat_summary_correction_json FROM memories WHERE id = ${rowAlias}.post_id)` : ''}
      )`
    : `json_object(
        'schemaVersion', ${schemaVersion},
        'record', ${recordExpression(spec, rowAlias)}
      )`;
  return `INSERT INTO memory_sync_domain_outbox (
    mutation_id, revision_id, parent_revision_ids_json,
    vault_id, source_device_id, entity_type, entity_id,
    operation, schema_version, payload_json, state,
    available_at, created_at, updated_at
  )
  SELECT
    ${uuidV4Expression()},
    ${uuidV4Expression()},
    ${parentRevisionIdsExpression(spec.entityType, entityId)},
    vault_id,
    source_device_id,
    ${sqlString(spec.entityType)},
    ${entityId},
    ${sqlString(operation)},
    ${schemaVersion},
    ${payload},
    'pending',
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()}
  FROM memory_sync_runtime
  WHERE singleton_id = 1;`;
}

function advanceHeadsStatements(spec: MemoryRecordEntitySpec, rowAlias: 'NEW' | 'OLD') {
  const entityId = entityIdExpression(spec, rowAlias);
  return `
  DELETE FROM memory_sync_entity_heads
  WHERE entity_type = ${sqlString(spec.entityType)}
    AND entity_id = ${entityId};

  INSERT INTO memory_sync_entity_heads (
    entity_type, entity_id, revision_id, updated_at
  )
  SELECT
    ${sqlString(spec.entityType)},
    ${entityId},
    revision_id,
    created_at
  FROM memory_sync_domain_outbox
  WHERE local_sequence = last_insert_rowid();`;
}

function triggerName(spec: MemoryRecordEntitySpec, action: MemoryRecordCaptureAction) {
  return `memory_sync_capture_${assertSqlToken(spec.tableName, 'table name')}_${action}`;
}

function buildCaptureTrigger(
  spec: MemoryRecordEntitySpec,
  action: MemoryRecordCaptureAction,
) {
  const rowAlias = action === 'delete' ? 'OLD' : 'NEW';
  const operation = action === 'insert' ? spec.insertOperation : action === 'delete' ? 'delete' : 'upsert';
  const review = spec.entityType === 'post-review';
  const reviewAction = spec.entityType === 'post-review-action';
  const extraPredicate = review ? ` AND ${buildPostReviewCapturePredicate(action as 'insert' | 'update')}`
    : reviewAction ? ` AND (NEW.state='pending' OR NEW.owner_device_id=(SELECT source_device_id FROM memory_sync_runtime WHERE singleton_id=1))` : '';
  const updateFields = review ? 'candidate_json,status,memory_id,resolved_at,updated_at'
    : reviewAction ? 'state,error,resolved_at' : spec.entityType === 'current-state'
      ? Object.keys(spec.fields).map(field => assertSqlToken(field, 'field')).join(', ') : null;
  return `
DROP TRIGGER IF EXISTS ${triggerName(spec, action)};
CREATE TRIGGER IF NOT EXISTS ${triggerName(spec, action)}
AFTER ${action.toUpperCase()}${updateFields && action === 'update' ? ` OF ${updateFields}` : ''} ON ${assertSqlToken(spec.tableName, 'table name')}
WHEN ${captureEnabledPredicate()}${extraPredicate}
BEGIN
  ${review ? buildPostReviewCaptureIdentitySql(action as 'insert' | 'update') : ''}
  ${insertOutboxStatement({ spec, rowAlias, operation })}
  ${advanceHeadsStatements(spec, rowAlias)}
END;`;
}

export const MEMORY_RECORDS_CAPTURE_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_sync_runtime (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  capture_enabled INTEGER NOT NULL DEFAULT 0 CHECK (capture_enabled IN (0, 1)),
  suppress_capture INTEGER NOT NULL DEFAULT 0 CHECK (suppress_capture IN (0, 1)),
  vault_id TEXT,
  source_device_id TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO memory_sync_runtime (
  singleton_id, capture_enabled, suppress_capture, vault_id, source_device_id, updated_at
) VALUES (1, 0, 0, NULL, NULL, 0);

CREATE TABLE IF NOT EXISTS memory_sync_domain_outbox (
  local_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  parent_revision_ids_json TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  source_sequence INTEGER,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND
    CASE WHEN entity_type = 'continuity-link' THEN 2048 ELSE 256 END),
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'restore', 'append')),
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

CREATE INDEX IF NOT EXISTS idx_memory_sync_outbox_ready
  ON memory_sync_domain_outbox(state, available_at, local_sequence);

CREATE TABLE IF NOT EXISTS memory_sync_entity_heads (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id, revision_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_sync_heads_entity
  ON memory_sync_entity_heads(entity_type, entity_id, revision_id);

CREATE TABLE IF NOT EXISTS memory_sync_conflicts (
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

CREATE INDEX IF NOT EXISTS idx_memory_sync_conflicts_pending
  ON memory_sync_conflicts(state, created_at, conflict_id);
`;

/** Rebuild the existing outbox without changing any captured mutation or lease. */
export function buildMemoryRecordsOutboxIdUpgradeSql(
  tableSql: string | null | undefined,
  referringTriggers: readonly { name: string; sql: string }[],
) {
  if (!tableSql || /CASE\s+WHEN\s+entity_type\s*=\s*'continuity-link'\s+THEN\s+2048\s+ELSE\s+256\s+END/i.test(tableSql)) return '';
  const tableSchema = MEMORY_RECORDS_CAPTURE_TABLE_SCHEMA_SQL.match(
    /CREATE TABLE IF NOT EXISTS memory_sync_domain_outbox \([\s\S]*?\n\);/,
  )![0];
  const columns = [
    'local_sequence', 'mutation_id', 'revision_id', 'parent_revision_ids_json',
    'vault_id', 'source_device_id', 'source_sequence', 'entity_type', 'entity_id',
    'operation', 'schema_version', 'payload_json', 'state', 'attempt_count',
    'available_at', 'lease_id', 'lease_expires_at', 'last_error_code',
    'dispatched_at', 'created_at', 'updated_at',
  ].join(', ');
  const temporaryTable = 'memory_sync_domain_outbox_upgrade';
  return `
    ${referringTriggers.map(trigger => `DROP TRIGGER "${trigger.name.replace(/"/g, '""')}";`).join('\n')}
    ${tableSchema.replace('IF NOT EXISTS memory_sync_domain_outbox', temporaryTable)}
    INSERT INTO ${temporaryTable} (${columns}) SELECT ${columns} FROM memory_sync_domain_outbox;
    INSERT INTO sqlite_sequence (name, seq) SELECT '${temporaryTable}',
      COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'memory_sync_domain_outbox'), 0)
      WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = '${temporaryTable}');
    UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence
      WHERE name = 'memory_sync_domain_outbox'), 0)) WHERE name = '${temporaryTable}';
    DROP TABLE memory_sync_domain_outbox;
    ALTER TABLE ${temporaryTable} RENAME TO memory_sync_domain_outbox;
    CREATE INDEX idx_memory_sync_outbox_ready ON memory_sync_domain_outbox(state, available_at, local_sequence);
    ${referringTriggers.map(trigger => `${trigger.sql};`).join('\n')}
  `;
}

export const MEMORY_RECORDS_AUXILIARY_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS style_memories (
  id TEXT PRIMARY KEY NOT NULL,
  context TEXT NOT NULL,
  feeling_before TEXT NOT NULL,
  reply TEXT NOT NULL,
  hamster_reaction TEXT NOT NULL,
  quality REAL NOT NULL,
  mass REAL NOT NULL,
  embedding_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_style_memories_accessed
  ON style_memories(last_accessed_at DESC);

CREATE TABLE IF NOT EXISTS continuity_events (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  subject TEXT NOT NULL,
  returning_subject TEXT,
  primary_intent TEXT,
  parent_event_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  coalescing_key TEXT,
  focus_excerpt TEXT,
  item_name TEXT,
  progress TEXT,
  duration_ms INTEGER,
  care_time_sources_json TEXT,
  care_evidence_json TEXT,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_global_basis_json TEXT,
  occurred_at INTEGER NOT NULL,
  occurred_local_date TEXT NOT NULL,
  timezone_offset_minutes INTEGER NOT NULL,
  next_action_at INTEGER,
  resume_condition_json TEXT,
  required_behaviors_json TEXT,
  completion_rule_json TEXT NOT NULL,
  permission_requirements_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  last_attempt_outcome TEXT,
  pause_reason_code TEXT,
  cancelled_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  cancelled_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS continuity_event_transitions (
  id TEXT PRIMARY KEY NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL,
  transition_kind TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  from_stage TEXT,
  to_stage TEXT,
  reason_code TEXT,
  evidence_id TEXT,
  evidence_kind TEXT,
  evidence_source_id TEXT,
  evidence_outcome TEXT,
  occurred_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS continuity_event_links (
  event_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, relation, target_kind, target_id)
);

CREATE TABLE IF NOT EXISTS continuity_event_candidates (
  id TEXT PRIMARY KEY NOT NULL,
  candidate_key TEXT NOT NULL UNIQUE,
  candidate_kind TEXT NOT NULL CHECK (candidate_kind IN ('create_event', 'resolve_event')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'dismissed', 'expired')),
  event_kind TEXT,
  primary_intent TEXT,
  target_event_id TEXT,
  proposed_resolution TEXT CHECK (
    proposed_resolution IS NULL
    OR proposed_resolution IN ('progressed', 'completed', 'cancelled')
  ),
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  detection_basis TEXT NOT NULL CHECK (
    detection_basis IN ('local_explicit', 'semantic', 'combined')
  ),
  confidence REAL NOT NULL,
  reason_codes_json TEXT NOT NULL,
  coalescing_key TEXT,
  result_event_id TEXT,
  occurred_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  schema_version INTEGER NOT NULL DEFAULT 1,
  CHECK (
    (candidate_kind = 'create_event'
      AND event_kind IS NOT NULL
      AND primary_intent IS NOT NULL
      AND target_event_id IS NULL
      AND proposed_resolution IS NULL)
    OR
    (candidate_kind = 'resolve_event'
      AND event_kind IS NULL
      AND primary_intent IS NULL
      AND target_event_id IS NOT NULL
      AND proposed_resolution IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_continuity_candidates_pending
  ON continuity_event_candidates(state, expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_continuity_candidates_message
  ON continuity_event_candidates(session_id, message_id, state);
CREATE INDEX IF NOT EXISTS idx_continuity_candidates_target
  ON continuity_event_candidates(target_event_id, state);

CREATE INDEX IF NOT EXISTS idx_continuity_events_open
  ON continuity_events(status, next_action_at, occurred_at);
CREATE INDEX IF NOT EXISTS idx_continuity_events_coalescing
  ON continuity_events(kind, coalescing_key, status);
CREATE INDEX IF NOT EXISTS idx_continuity_events_parent
  ON continuity_events(parent_event_id, status);
CREATE INDEX IF NOT EXISTS idx_continuity_transitions_event
  ON continuity_event_transitions(event_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_continuity_links_target
  ON continuity_event_links(target_kind, target_id);

CREATE TABLE IF NOT EXISTS memory_current_states (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  resolved_at INTEGER,
  resolve_reason TEXT,
  source_type TEXT NOT NULL,
  source_memory_id TEXT,
  source_candidate_id TEXT,
  source_title TEXT,
  created_at INTEGER NOT NULL,
  known_at INTEGER,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  last_used_at INTEGER,
  last_spoken_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memory_current_states_status_expires
  ON memory_current_states(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_memory_current_states_updated
  ON memory_current_states(updated_at);

CREATE TABLE IF NOT EXISTS memory_topic_overrides (
  topic_key TEXT PRIMARY KEY NOT NULL,
  display_name TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`;

export const MEMORY_RECORDS_BOOTSTRAP_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_sync_bootstrap_state (
  adapter_id TEXT NOT NULL,
  bootstrap_version INTEGER NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (adapter_id, bootstrap_version, vault_id, source_device_id)
);
`;

export const MEMORY_RECORDS_APPLY_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_sync_revision_log (
  revision_id TEXT PRIMARY KEY NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  parent_revision_ids_json TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'restore', 'append')),
  schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  mutation_json TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (source_device_id, source_sequence)
);

CREATE INDEX IF NOT EXISTS idx_memory_sync_revision_entity
  ON memory_sync_revision_log(entity_type, entity_id, created_at, revision_id);

CREATE TABLE IF NOT EXISTS memory_sync_applied_mutations (
  mutation_id TEXT PRIMARY KEY NOT NULL,
  revision_id TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

export const MEMORY_RECORDS_SCHEMA_MARKER_SQL = `
CREATE TABLE IF NOT EXISTS memory_sync_schema_metadata (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL,
  installed_at INTEGER NOT NULL
);

INSERT OR REPLACE INTO memory_sync_schema_metadata (
  singleton_id, schema_version, installed_at
) VALUES (
  1,
  ${MEMORY_RECORDS_STORAGE_SCHEMA_VERSION},
  ${unixMillisecondsExpression()}
);
`;

export function buildMemoryRecordsCaptureTriggersSql() {
  const spec = MEMORY_RECORD_ENTITY_SPECS.find(item => item.entityType === 'post')!;
  const versionTriggers = ['insert', 'update'].map(action => `
    DROP TRIGGER IF EXISTS memory_sync_capture_post_version_${action};
    CREATE TRIGGER IF NOT EXISTS memory_sync_capture_post_version_${action} AFTER ${action.toUpperCase()} ON baiyun_post_content_versions
    WHEN ${captureEnabledPredicate()} AND EXISTS (SELECT 1 FROM memory_sync_posts WHERE post_id = NEW.post_id)
    BEGIN ${insertOutboxStatement({ spec, rowAlias: 'NEW', operation: 'upsert' })}
      ${advanceHeadsStatements(spec, 'NEW')} END;`).join('\n');
  const visionTriggers = ['insert', 'update'].map(action => `
    DROP TRIGGER IF EXISTS memory_sync_capture_post_vision_${action};
    CREATE TRIGGER IF NOT EXISTS memory_sync_capture_post_vision_${action} AFTER ${action.toUpperCase()}${action === 'update' ? ' OF description' : ''}
      ON baiyun_post_image_vision
    WHEN ${captureEnabledPredicate()} AND length(trim(NEW.description)) > 0
      ${action === 'update' ? 'AND NEW.description IS NOT OLD.description' : ''}
    BEGIN
      UPDATE baiyun_post_metadata SET author=author WHERE post_id=NEW.post_id AND NEW.comment_source IS NULL
        AND NEW.group_key=json_array(json_extract(image_group_json,'$.id'),json_extract(image_group_json,'$.version'),
          json(json_extract(image_group_json,'$.imageIds')));
      UPDATE baiyun_post_comment_metadata SET author=author WHERE post_id=NEW.post_id AND source=NEW.comment_source AND deleted=0
        AND NEW.group_key=json_array(json_extract(image_group_json,'$.id'),json_extract(image_group_json,'$.version'),
          json(json_extract(image_group_json,'$.imageIds')));
    END;`).join('\n');
  return MEMORY_RECORD_ENTITY_SPECS
    .filter((spec) => spec.entityType !== 'continuity-candidate')
    .flatMap((spec) => (
      (spec.captureActions ?? DEFAULT_MEMORY_RECORD_CAPTURE_ACTIONS)
        .map((action) => buildCaptureTrigger(spec, action))
    ))
    .join('\n') + versionTriggers + visionTriggers;
}

/** Rebuild only the existing table to remove its former NOT NULL expiry constraint. */
export function buildMemoryCurrentStateUpgradeSql(columns: readonly { name: string; notnull?: number }[]) {
  if (!columns.length) return '';
  const names = new Set(columns.map(column => column.name));
  if (!columns.find(column => column.name === 'expires_at')?.notnull) {
    return [!names.has('known_at') ? 'ALTER TABLE memory_current_states ADD COLUMN known_at INTEGER;' : '',
      !names.has('source_refs_json') ? "ALTER TABLE memory_current_states ADD COLUMN source_refs_json TEXT NOT NULL DEFAULT '[]';" : '',
      !names.has('last_used_at') ? 'ALTER TABLE memory_current_states ADD COLUMN last_used_at INTEGER;' : '',
      !names.has('last_spoken_at') ? 'ALTER TABLE memory_current_states ADD COLUMN last_spoken_at INTEGER;' : ''].join('\n');
  }
  const schema = MEMORY_RECORDS_AUXILIARY_TABLE_SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS memory_current_states \([\s\S]*?\n\);/)![0];
  const fields = [...Object.keys(MEMORY_RECORD_ENTITY_SPECS.find(spec => spec.entityType === 'current-state')!.fields), 'last_used_at', 'last_spoken_at'];
  return `
    DROP TRIGGER IF EXISTS memory_sync_capture_memory_current_states_insert;
    DROP TRIGGER IF EXISTS memory_sync_capture_memory_current_states_update;
    DROP TRIGGER IF EXISTS memory_sync_capture_memory_current_states_delete;
    ${schema.replace('IF NOT EXISTS memory_current_states', 'memory_current_states_upgrade')}
    INSERT INTO memory_current_states_upgrade (${fields.join(', ')})
      SELECT ${fields.map(field => names.has(field) ? field : field === 'source_refs_json' ? "'[]'" : 'NULL').join(', ')} FROM memory_current_states;
    DROP TABLE memory_current_states;
    ALTER TABLE memory_current_states_upgrade RENAME TO memory_current_states;
  `;
}

export function buildMemoryRecordsCaptureSchemaSql() {
  return [
    MEMORY_RECORDS_AUXILIARY_TABLE_SCHEMA_SQL,
    MEMORY_RECORDS_CAPTURE_TABLE_SCHEMA_SQL,
    POST_SYNC_BASE_SCHEMA_SQL,
    POST_CONFIRMATIONS_SCHEMA_SQL,
    POST_REVIEW_SCHEMA_SQL,
    buildMemoryRecordsCaptureTriggersSql(),
  ].join('\n');
}

export function buildMemoryRecordsStorageSchemaSql() {
  return [
    buildMemoryRecordsCaptureSchemaSql(),
    MEMORY_RECORDS_BOOTSTRAP_TABLE_SCHEMA_SQL,
    MEMORY_RECORDS_APPLY_TABLE_SCHEMA_SQL,
    MEMORY_RECORDS_SCHEMA_MARKER_SQL,
  ].join('\n');
}

export const MEMORY_RECORDS_RESET_TECHNICAL_STATE_SQL = `
DELETE FROM memory_sync_domain_outbox;
DELETE FROM memory_sync_entity_heads;
DELETE FROM memory_sync_conflicts;
DELETE FROM memory_sync_bootstrap_state;
DELETE FROM memory_sync_revision_log;
DELETE FROM memory_sync_applied_mutations;
UPDATE memory_sync_runtime
SET capture_enabled = 0,
    suppress_capture = 0,
    vault_id = NULL,
    source_device_id = NULL,
    updated_at = 0
WHERE singleton_id = 1;
`;
