import {
  SCHEDULE_SEMANTIC_SCHEMA_VERSION,
  type ScheduleSemanticEntityType,
  type ScheduleSemanticRecordKind,
} from './syncScheduleSemantic';

export const SCHEDULE_SEMANTIC_DATABASE_NAME = 'junluo-schedule.db' as const;
export const SCHEDULE_SEMANTIC_CAPTURE_SCHEMA_VERSION = 4 as const;
export const SCHEDULE_SEMANTIC_STORAGE_SCHEMA_VERSION = 1 as const;
export const SCHEDULE_SEMANTIC_CAPTURE_LEASE_MS = 60_000;

type CaptureAction = 'insert' | 'update' | 'delete';
type CaptureSpec = {
  name: string;
  tableName: string;
  entityType: ScheduleSemanticEntityType;
  kind: ScheduleSemanticRecordKind;
  idExpression(row: 'NEW' | 'OLD'): string;
  recordExpression(row: 'NEW' | 'OLD'): string;
  updateColumns: readonly string[];
  insertOperation?: 'upsert' | 'append';
};

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

function jsonBoolean(expression: string) {
  return `CASE WHEN ${expression} THEN json('true') ELSE json('false') END`;
}

function prefixedId(prefix: string, row: 'NEW' | 'OLD', column = 'id') {
  return `${sqlString(prefix)} || CAST(${row}.${assertSqlToken(column, 'id column')} AS TEXT)`;
}

const SCHEDULE_ITEM_RECORD = (row: 'NEW' | 'OLD') => `json_set(json_object(
  'id', ${row}.id,
  'title', ${row}.title,
  'notes', ${row}.notes,
  'startAt', ${row}.start_at,
  'endAt', ${row}.end_at,
  'reminderMinutesBefore', ${row}.reminder_minutes_before,
  'recurrence', ${row}.recurrence,
  'recurrenceRule', CASE
    WHEN ${row}.recurrence_rule IS NOT NULL
      AND json_valid(${row}.recurrence_rule)
      THEN json(${row}.recurrence_rule)
    ELSE json_object('type', ${row}.recurrence)
  END,
  'rangeEndAt', ${row}.range_end_at,
  'status', ${row}.status,
  'reminderText', ${row}.reminder_text,
  'reminderIntensity', ${row}.reminder_intensity,
  'source', ${row}.source,
  'owner', ${row}.owner,
  'readingId', ${row}.reading_id,
  'execution', json(${row}.execution_json),
  'habitId', ${row}.habit_id,
  'habitAnchorKey', ${row}.habit_anchor_key,
  'todoId', ${row}.todo_id,
  'goalId', ${row}.goal_id,
  'planId', ${row}.plan_id,
  'companionEnabled', ${jsonBoolean(`${row}.companion_enabled = 1`)},
  'letterTicketEnabled', ${jsonBoolean(`${row}.letter_ticket_enabled = 1`)},
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at
),
  '$.startReminderEnabled', CASE WHEN ${row}.start_reminder_enabled IS NULL THEN NULL ELSE ${jsonBoolean(`${row}.start_reminder_enabled = 1`)} END,
  '$.endMode', ${row}.end_mode,
  '$.durationMinutes', ${row}.duration_minutes,
  '$.habitCompletionKey', ${row}.habit_completion_key
)`;

const SCHEDULE_OCCURRENCE_RECORD = (row: 'NEW' | 'OLD') => `json_object(
  'id', ${row}.id,
  'itemId', ${row}.item_id,
  'scheduledStartAt', ${row}.scheduled_start_at,
  'reminderAt', ${row}.reminder_at,
  'status', ${row}.status,
  'completedAt', ${row}.completed_at,
  'completionRound', ${row}.completion_round
)`;

const SCHEDULE_OCCURRENCE_DELIVERY_RECORD =
  (row: 'NEW' | 'OLD') => `json_object(
  'occurrenceId', ${row}.id,
  'scheduledAt', ${row}.reminder_at,
  'status', CASE
    WHEN ${row}.status = 'cancelled' THEN 'cancelled'
    WHEN ${row}.status = 'completed' THEN 'completed'
    WHEN ${row}.chat_delivered_at IS NOT NULL THEN 'delivered'
    ELSE 'pending'
  END,
  'deliveredAt', ${row}.chat_delivered_at
)`;

const DAY_TEMPLATE_INSTANCE_RECORD = (row: 'NEW' | 'OLD') => `json_object(
  'id', ${row}.id,
  'dateKey', ${row}.date_key,
  'kind', ${row}.kind,
  'title', ${row}.title,
  'startAt', ${row}.start_at,
  'endAt', ${row}.end_at,
  'status', ${row}.status,
  'completedAt', ${row}.completed_at,
  'templateHash', ${row}.template_hash,
  'source', ${row}.source,
  'enabled', ${jsonBoolean(`${row}.enabled = 1`)},
  'operationId', ${row}.operation_id,
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at
)`;

const SCHEDULE_COMPANION_DELIVERY_RECORD =
  (row: 'NEW' | 'OLD') => `json_object(
  'id', ${row}.id,
  'occurrenceId', ${row}.occurrence_id,
  'eventKind', ${row}.kind,
  'scheduledAt', ${row}.scheduled_at,
  'status', ${row}.status,
  'deliveredAt', ${row}.delivered_at,
  'respondedAt', ${row}.responded_at,
  'reminderBody', json(${row}.reminder_body_json),
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at
)`;

export const SCHEDULE_SEMANTIC_CAPTURE_SPECS: readonly CaptureSpec[] = [
  {
    name: 'schedule_item',
    tableName: 'schedule_items',
    entityType: 'item',
    kind: 'schedule-item',
    idExpression: (row) => prefixedId('schedule-item:', row),
    recordExpression: SCHEDULE_ITEM_RECORD,
    updateColumns: [
      'start_reminder_enabled', 'end_mode', 'duration_minutes', 'habit_completion_key',
      'title',
      'notes',
      'start_at',
      'end_at',
      'reminder_minutes_before',
      'recurrence',
      'recurrence_rule',
      'range_end_at',
      'status',
      'reminder_text',
      'reminder_intensity',
      'source',
      'owner',
      'reading_id',
      'execution_json',
      'habit_id',
      'habit_anchor_key',
      'todo_id',
      'goal_id',
      'plan_id',
      'companion_enabled',
      'letter_ticket_enabled',
    ],
  },
  {
    name: 'schedule_occurrence',
    tableName: 'schedule_occurrences',
    entityType: 'item',
    kind: 'schedule-occurrence',
    idExpression: (row) => prefixedId('schedule-occurrence:', row),
    recordExpression: SCHEDULE_OCCURRENCE_RECORD,
    updateColumns: [
      'item_id',
      'scheduled_start_at',
      'reminder_at',
      'status',
      'completed_at',
      'completion_round',
    ],
  },
  {
    name: 'schedule_occurrence_delivery',
    tableName: 'schedule_occurrences',
    entityType: 'reminder-delivery',
    kind: 'schedule-occurrence-delivery',
    idExpression: (row) => prefixedId(
      'schedule-occurrence-delivery:',
      row,
    ),
    recordExpression: SCHEDULE_OCCURRENCE_DELIVERY_RECORD,
    updateColumns: [
      'reminder_at',
      'status',
      'chat_delivered_at',
    ],
  },
  {
    name: 'day_template_instance',
    tableName: 'day_template_instances',
    entityType: 'item',
    kind: 'day-template-instance',
    idExpression: (row) => prefixedId('day-template-instance:', row),
    recordExpression: DAY_TEMPLATE_INSTANCE_RECORD,
    updateColumns: [
      'date_key',
      'kind',
      'title',
      'start_at',
      'end_at',
      'status',
      'completed_at',
      'template_hash',
      'source',
      'enabled',
      'operation_id',
    ],
  },
  {
    name: 'schedule_companion_delivery',
    tableName: 'schedule_companion_events',
    entityType: 'reminder-delivery',
    kind: 'schedule-companion-delivery',
    idExpression: (row) => prefixedId(
      'schedule-companion-delivery:',
      row,
    ),
    recordExpression: SCHEDULE_COMPANION_DELIVERY_RECORD,
    updateColumns: [
      'occurrence_id',
      'kind',
      'scheduled_at',
      'status',
      'delivered_at',
      'responded_at',
      'reminder_body_json',
    ],
    insertOperation: 'append',
  },
];

function currentSnapshotSelectSql(spec: CaptureSpec) {
  const entityId = spec.idExpression('NEW').replace(/\bNEW\./g, 'SOURCE.');
  const record = spec.recordExpression('NEW').replace(/\bNEW\./g, 'SOURCE.');
  return `SELECT
    ${sqlString(spec.entityType)} AS entity_type,
    ${entityId} AS entity_id,
    ${sqlString(spec.insertOperation ?? 'upsert')} AS operation,
    ${SCHEDULE_SEMANTIC_SCHEMA_VERSION} AS schema_version,
    json_object(
      'schemaVersion', ${SCHEDULE_SEMANTIC_SCHEMA_VERSION},
      'kind', ${sqlString(spec.kind)},
      'record', ${record}
    ) AS payload_json
  FROM ${spec.tableName} AS SOURCE
  ORDER BY entity_id ASC`;
}

export const SCHEDULE_SEMANTIC_CURRENT_SNAPSHOT_SELECT_SQL =
  SCHEDULE_SEMANTIC_CAPTURE_SPECS.map(currentSnapshotSelectSql);

export const SCHEDULE_SEMANTIC_EXPECTED_CAPTURE_TRIGGER_COUNT =
  SCHEDULE_SEMANTIC_CAPTURE_SPECS.length * 3;

function parentRevisionIdsExpression(
  entityType: ScheduleSemanticEntityType,
  entityId: string,
) {
  return `COALESCE((
    SELECT json_group_array(revision_id)
    FROM (
      SELECT revision_id
      FROM schedule_sync_entity_heads
      WHERE entity_type = ${sqlString(entityType)}
        AND entity_id = ${entityId}
      ORDER BY revision_id ASC
    )
  ), json('[]'))`;
}

function captureEnabledPredicate() {
  return `EXISTS (
    SELECT 1
    FROM schedule_sync_runtime
    WHERE singleton_id = 1
      AND capture_enabled = 1
      AND suppress_capture = 0
      AND vault_id IS NOT NULL
      AND source_device_id IS NOT NULL
  )`;
}

function updateChangedPredicate(spec: CaptureSpec) {
  return spec.updateColumns.map((column) => {
    const token = assertSqlToken(column, `${spec.name} update column`);
    return `OLD.${token} IS NOT NEW.${token}`;
  }).join('\n      OR ');
}

function insertOutboxStatement(input: {
  spec: CaptureSpec;
  row: 'NEW' | 'OLD';
  operation: 'upsert' | 'append' | 'delete';
}) {
  const entityId = input.spec.idExpression(input.row);
  const payload = input.operation === 'delete'
    ? `json_object(
        'schemaVersion', ${SCHEDULE_SEMANTIC_SCHEMA_VERSION},
        'kind', ${sqlString(input.spec.kind)},
        'deletedAt', ${unixMillisecondsExpression()}
      )`
    : `json_object(
        'schemaVersion', ${SCHEDULE_SEMANTIC_SCHEMA_VERSION},
        'kind', ${sqlString(input.spec.kind)},
        'record', ${input.spec.recordExpression(input.row)}
      )`;
  return `INSERT INTO schedule_sync_domain_outbox (
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
    ${SCHEDULE_SEMANTIC_SCHEMA_VERSION},
    ${payload},
    'pending',
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()}
  FROM schedule_sync_runtime
  WHERE singleton_id = 1;`;
}

function advanceHeadsStatements(
  spec: CaptureSpec,
  row: 'NEW' | 'OLD',
) {
  const entityId = spec.idExpression(row);
  return `
  DELETE FROM schedule_sync_entity_heads
  WHERE entity_type = ${sqlString(spec.entityType)}
    AND entity_id = ${entityId};

  INSERT INTO schedule_sync_entity_heads (
    entity_type, entity_id, revision_id, updated_at
  )
  SELECT
    ${sqlString(spec.entityType)},
    ${entityId},
    revision_id,
    created_at
  FROM schedule_sync_domain_outbox
  WHERE local_sequence = last_insert_rowid();`;
}

function triggerName(spec: CaptureSpec, action: CaptureAction) {
  return `schedule_sync_capture_${assertSqlToken(spec.name, 'spec name')}_${action}`;
}

function buildCaptureTrigger(spec: CaptureSpec, action: CaptureAction) {
  const row = action === 'delete' ? 'OLD' : 'NEW';
  const operation = action === 'delete'
    ? 'delete'
    : action === 'insert'
      ? spec.insertOperation ?? 'upsert'
      : 'upsert';
  const changed = action === 'update'
    ? ` AND (
      ${updateChangedPredicate(spec)}
    )`
    : '';
  return `
${spec.name === 'schedule_companion_delivery' || spec.name === 'schedule_item' || spec.name === 'schedule_occurrence' ? `DROP TRIGGER IF EXISTS ${triggerName(spec, action)};` : ''}
CREATE TRIGGER IF NOT EXISTS ${triggerName(spec, action)}
AFTER ${action.toUpperCase()} ON ${assertSqlToken(spec.tableName, 'table name')}
WHEN ${captureEnabledPredicate()}${changed}
BEGIN
  ${insertOutboxStatement({ spec, row, operation })}
  ${advanceHeadsStatements(spec, row)}
END;`;
}

export const SCHEDULE_SEMANTIC_CAPTURE_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schedule_sync_runtime (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  capture_enabled INTEGER NOT NULL DEFAULT 0 CHECK (capture_enabled IN (0, 1)),
  suppress_capture INTEGER NOT NULL DEFAULT 0 CHECK (suppress_capture IN (0, 1)),
  vault_id TEXT,
  source_device_id TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schedule_sync_runtime (
  singleton_id, capture_enabled, suppress_capture,
  vault_id, source_device_id, updated_at
) VALUES (1, 0, 0, NULL, NULL, 0);

CREATE TABLE IF NOT EXISTS schedule_sync_domain_outbox (
  local_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  parent_revision_ids_json TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  source_sequence INTEGER,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 256),
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

CREATE INDEX IF NOT EXISTS idx_schedule_sync_outbox_ready
  ON schedule_sync_domain_outbox(state, available_at, local_sequence);

CREATE TABLE IF NOT EXISTS schedule_sync_entity_heads (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id, revision_id)
);

CREATE INDEX IF NOT EXISTS idx_schedule_sync_heads_entity
  ON schedule_sync_entity_heads(entity_type, entity_id, revision_id);

CREATE TABLE IF NOT EXISTS schedule_sync_pending_delivery_apply (
  entity_id TEXT PRIMARY KEY NOT NULL,
  record_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_sync_conflicts (
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

CREATE INDEX IF NOT EXISTS idx_schedule_sync_conflicts_pending
  ON schedule_sync_conflicts(state, created_at, conflict_id);

CREATE TABLE IF NOT EXISTS schedule_sync_bootstrap_state (
  adapter_id TEXT NOT NULL,
  bootstrap_version INTEGER NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (adapter_id, bootstrap_version, vault_id, source_device_id)
);

CREATE TABLE IF NOT EXISTS schedule_sync_schema_meta (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  storage_schema_version INTEGER NOT NULL,
  capture_schema_version INTEGER NOT NULL,
  trigger_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO schedule_sync_schema_meta (
  singleton_id, storage_schema_version, capture_schema_version,
  trigger_count, updated_at
) VALUES (
  1,
  ${SCHEDULE_SEMANTIC_STORAGE_SCHEMA_VERSION},
  ${SCHEDULE_SEMANTIC_CAPTURE_SCHEMA_VERSION},
  ${SCHEDULE_SEMANTIC_EXPECTED_CAPTURE_TRIGGER_COUNT},
  ${unixMillisecondsExpression()}
)
ON CONFLICT(singleton_id) DO UPDATE SET
  storage_schema_version = excluded.storage_schema_version,
  capture_schema_version = excluded.capture_schema_version,
  trigger_count = excluded.trigger_count,
  updated_at = excluded.updated_at;
`;

export const SCHEDULE_SEMANTIC_CAPTURE_TRIGGER_SQL =
  SCHEDULE_SEMANTIC_CAPTURE_SPECS.flatMap((spec) => (
    (['insert', 'update', 'delete'] as const).map((action) => (
      buildCaptureTrigger(spec, action)
    ))
  )).join('\n');

export const SCHEDULE_SEMANTIC_FULL_CAPTURE_SCHEMA_SQL = `
${SCHEDULE_SEMANTIC_CAPTURE_TABLE_SCHEMA_SQL}
${SCHEDULE_SEMANTIC_CAPTURE_TRIGGER_SQL}
`;

export const SCHEDULE_SEMANTIC_RESET_TECHNICAL_STATE_SQL = `
DELETE FROM schedule_sync_domain_outbox;
DELETE FROM schedule_sync_entity_heads;
DELETE FROM schedule_sync_conflicts;
DELETE FROM schedule_sync_pending_delivery_apply;
DELETE FROM schedule_sync_bootstrap_state;
UPDATE schedule_sync_runtime
SET capture_enabled = 0,
    suppress_capture = 0,
    vault_id = NULL,
    source_device_id = NULL,
    updated_at = 0
WHERE singleton_id = 1;
`;
