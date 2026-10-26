import {
  TODO_SEMANTIC_SCHEMA_VERSION,
  type TodoSemanticEntityType,
  type TodoSemanticRecordKind,
} from './syncTodoSemantic';

export const TODO_SEMANTIC_CAPTURE_SCHEMA_VERSION = 4 as const;
export const TODO_SEMANTIC_STORAGE_SCHEMA_VERSION = 1 as const;
export const TODO_SEMANTIC_CAPTURE_LEASE_MS = 60_000;

type CaptureAction = 'insert' | 'update' | 'delete';
type CaptureSpec = {
  name: string;
  tableName: string;
  entityType: TodoSemanticEntityType;
  kind: TodoSemanticRecordKind;
  idExpression(row: 'NEW' | 'OLD'): string;
  recordExpression(row: 'NEW' | 'OLD'): string;
  updateColumns: readonly string[];
  rowPredicate?(row: 'NEW' | 'OLD'): string;
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

function jsonArray(expression: string) {
  return `CASE
    WHEN ${expression} IS NOT NULL AND json_valid(${expression})
      AND json_type(${expression}) = 'array'
      THEN json(${expression})
    ELSE json('[]')
  END`;
}

function jsonObjectOrNull(expression: string) {
  return `CASE
    WHEN ${expression} IS NOT NULL AND json_valid(${expression})
      AND json_type(${expression}) = 'object'
      THEN json(${expression})
    ELSE NULL
  END`;
}

function jsonObject(expression: string) {
  return `CASE
    WHEN ${expression} IS NOT NULL AND json_valid(${expression})
      AND json_type(${expression}) = 'object'
      THEN json(${expression})
    ELSE json('{}')
  END`;
}

function prefixedId(prefix: string, row: 'NEW' | 'OLD', column = 'id') {
  return `${sqlString(prefix)} || CAST(${row}.${assertSqlToken(column, 'id column')} AS TEXT)`;
}

const TODO_ITEM_RECORD = (row: 'NEW' | 'OLD') => `json_set(json_object(
  'id', ${row}.id,
  'title', ${row}.title,
  'notes', ${row}.notes,
  'status', ${row}.status,
  'plannedForDate', ${row}.planned_for_date,
  'source', ${row}.source,
  'priority', ${row}.priority,
  'quadrant', ${row}.quadrant,
  'category', ${row}.category,
  'estimatedMinutes', ${row}.estimated_minutes,
  'trackedMinutes', ${row}.tracked_minutes,
  'goalId', ${row}.goal_id,
  'goalContribution', ${row}.goal_contribution,
  'dueDate', ${row}.due_date,
  'challengeId', ${row}.challenge_id,
  'habitId', ${row}.habit_id,
  'type', ${row}.todo_type,
  'inhibitActiveFrom', ${row}.inhibit_active_from,
  'inhibitEndedAt', ${row}.inhibit_ended_at,
  'postponeCount', ${row}.postpone_count,
  'reminderMode', ${row}.reminder_mode,
  'reminderStage', ${row}.reminder_stage,
  'lastRemindedAt', ${row}.last_reminded_at,
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at,
  'completedAt', ${row}.completed_at,
  'completionRound', ${row}.completion_round
), '$.parentTodoId', ${row}.parent_todo_id,
  '$.parentOccurrenceId', ${row}.parent_occurrence_id, '$.stepOrder', ${row}.step_order)`;

const TODO_INHIBIT_LOG_RECORD = (row: 'NEW' | 'OLD') => `json_object(
  'id', ${row}.id,
  'todoId', ${row}.todo_id,
  'dateKey', ${row}.date_key,
  'acknowledgedAt', ${row}.acknowledged_at,
  'outcome', ${row}.outcome,
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at
)`;

const HABIT_RECORD = (row: 'NEW' | 'OLD') => `json_set(json_object(
  'id', ${row}.id,
  'owner', ${row}.owner,
  'frequencyPeriod', ${row}.frequency_period,
  'minutes', ${row}.minutes,
  'title', ${row}.title,
  'goalId', ${row}.goal_id,
  'category', ${row}.category,
  'frequency', ${row}.frequency,
  'weekDays', ${jsonArray(`${row}.week_days`)},
  'targetCount', ${row}.target_count,
  'reminderTimes', ${jsonArray(`${row}.reminder_times`)},
  'streak', ${row}.streak,
  'bestStreak', ${row}.best_streak,
  'reminderTime', ${row}.reminder_time,
  'kind', ${row}.kind,
  'scheduleEnabled', ${jsonBoolean(`${row}.schedule_enabled = 1`)},
  'scheduleReminderMinutesBefore', ${row}.schedule_reminder_minutes_before,
  'status', ${row}.status,
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at
), '$.notes', ${row}.notes, '$.intervalDays', ${row}.interval_days,
  '$.scheduleInstances', json_object(
    'startAt', ${row}.schedule_start_at, 'ruleUpdatedAt', ${row}.schedule_rule_updated_at,
    'durationMinutes', ${row}.schedule_duration_minutes,
    'endMode', ${row}.schedule_end_mode, 'endAt', ${row}.schedule_end_at,
    'startReminderEnabled', CASE WHEN ${row}.schedule_start_reminder_enabled IS NULL THEN NULL ELSE ${jsonBoolean(`${row}.schedule_start_reminder_enabled = 1`)} END,
    'companionEnabled', CASE WHEN ${row}.schedule_companion_enabled IS NULL THEN NULL ELSE ${jsonBoolean(`${row}.schedule_companion_enabled = 1`)} END
  ))`;

const HABIT_LOG_RECORD = (row: 'NEW' | 'OLD') => `json_object(
  'id', ${row}.id,
  'completionActivityIds', ${jsonArray(`${row}.completion_activity_ids`)},
  'habitId', ${row}.habit_id,
  'dateKey', ${row}.date_key,
  'completed', ${jsonBoolean(`${row}.completed = 1`)},
  'completedCount', ${row}.completed_count,
  'note', ${row}.note,
  'completedAt', ${row}.completed_at,
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at
)`;

const FUTURE_SELF_RECORD = (row: 'NEW' | 'OLD') => `json_object(
  'id', ${row}.id,
  'identityStatement', ${row}.identity_statement,
  'notes', ${row}.notes,
  'updatedAt', ${row}.updated_at
)`;

const GOAL_RECORD = (row: 'NEW' | 'OLD') => `json_object(
  'id', ${row}.id,
  'title', ${row}.title,
  'description', ${row}.description,
  'lifeArea', ${row}.life_area,
  'status', ${row}.status,
  'priority', ${row}.priority,
  'targetDate', ${row}.target_date,
  'progress', ${row}.progress,
  'goalType', ${row}.goal_type,
  'targetCount', ${row}.target_count,
  'targetUnit', ${row}.target_unit,
  'estimatedTotalMinutes', ${row}.estimated_total_minutes,
  'frequency', ${row}.frequency,
  'weekDays', ${jsonArray(`${row}.week_days`)},
  'actionTitle', ${row}.action_title,
  'actionAmount', ${row}.action_amount,
  'lastDirectionCheckAt', ${row}.last_direction_check_at,
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at
)`;

const GOAL_PROGRESS_RECORD = (row: 'NEW' | 'OLD') => `json_object(
  'id', ${row}.id,
  'goalId', ${row}.goal_id,
  'kind', ${row}.kind,
  'sourceId', ${row}.source_id,
  'amount', ${row}.amount,
  'note', ${row}.note,
  'occurredAt', ${row}.occurred_at,
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at
)`;

const GOAL_TIME_CREDIT_RECORD = (row: 'NEW' | 'OLD') => `json_object(
  'id', ${row}.id,
  'todoId', ${row}.todo_id,
  'goalId', ${row}.goal_id,
  'todoTitle', ${row}.todo_title,
  'suggestedMinutes', ${row}.suggested_minutes,
  'reason', ${row}.reason,
  'status', ${row}.status,
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at
)`;

const DAILY_CHALLENGE_RECORD = (row: 'NEW' | 'OLD') => `json_object(
  'id', ${row}.id,
  'title', ${row}.title,
  'category', ${row}.category,
  'quadrant', ${row}.quadrant,
  'estimatedMinutes', ${row}.estimated_minutes,
  'habitId', ${row}.habit_id,
  'status', ${row}.status,
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at
)`;

const DAY_REVIEW_RECORD = (row: 'NEW' | 'OLD') => `json_object(
  'id', ${row}.id,
  'dateKey', ${row}.date_key,
  'summary', ${row}.summary,
  'completedTaskTitles', ${jsonArray(`${row}.completed_task_titles`)},
  'pendingTaskTitles', ${jsonArray(`${row}.pending_task_titles`)},
  'minutesByCategory', ${jsonObject(`${row}.minutes_by_category`)},
  'totalTrackedMinutes', ${row}.total_tracked_minutes,
  'goalNotes', ${jsonArray(`${row}.goal_notes`)},
  'habitsDone', ${row}.habits_done,
  'habitsTotal', ${row}.habits_total,
  'habitNotes', ${jsonArray(`${row}.habit_notes`)},
  'baiyunMessage', ${row}.baiyun_message,
  'metricsSnapshot', ${jsonObjectOrNull(`${row}.metrics_snapshot`)},
  'comparison', ${jsonObjectOrNull(`${row}.comparison_snapshot`)},
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at
)`;

const WEEK_REVIEW_RECORD = (row: 'NEW' | 'OLD') => `json_object(
  'id', ${row}.id,
  'weekStart', ${row}.week_start,
  'weekEnd', ${row}.week_end,
  'summary', ${row}.summary,
  'wins', ${jsonArray(`${row}.wins`)},
  'gaps', ${jsonArray(`${row}.gaps`)},
  'goalProgress', ${jsonArray(`${row}.goal_progress`)},
  'habitInsights', ${jsonArray(`${row}.habit_insights`)},
  'nextWeekSuggestions', ${jsonArray(`${row}.next_week_suggestions`)},
  'baiyunMessage', ${row}.baiyun_message,
  'metricsSnapshot', ${jsonObjectOrNull(`${row}.metrics_snapshot`)},
  'comparison', ${jsonObjectOrNull(`${row}.comparison_snapshot`)},
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at
)`;

const TASK_EXECUTION_RECORD = (row: 'NEW' | 'OLD') => `json_object(
  'id', ${row}.id,
  'todoId', ${row}.todo_id,
  'status', ${row}.status,
  'startedAt', ${row}.started_at,
  'pausedAt', ${row}.paused_at,
  'endedAt', ${row}.ended_at,
  'accumulatedSeconds', ${row}.accumulated_seconds,
  'createdAt', ${row}.created_at,
  'updatedAt', ${row}.updated_at
)`;

const TASK_EXECUTION_NUDGE_RECORD =
  (row: 'NEW' | 'OLD') => `json_object(
  'sessionId', ${row}.session_id,
  'todoId', ${row}.todo_id,
  'kind', ${row}.kind,
  'createdAt', ${row}.created_at,
  'deliveredAt', ${row}.delivered_at
)`;

export const TODO_SEMANTIC_CAPTURE_SPECS: readonly CaptureSpec[] = [
  {
    name: 'todo_item',
    tableName: 'todo_items',
    entityType: 'todo',
    kind: 'todo-item',
    idExpression: (row) => prefixedId('todo:', row),
    recordExpression: TODO_ITEM_RECORD,
    updateColumns: [
      'parent_todo_id', 'parent_occurrence_id', 'step_order',
      'title',
      'notes',
      'status',
      'planned_for_date',
      'source',
      'priority',
      'reminder_mode',
      'reminder_stage',
      'last_reminded_at',
      'quadrant',
      'category',
      'estimated_minutes',
      'tracked_minutes',
      'goal_id',
      'goal_contribution',
      'due_date',
      'challenge_id',
      'habit_id',
      'todo_type',
      'inhibit_active_from',
      'inhibit_ended_at',
      'postpone_count',
      'completed_at',
      'completion_round',
    ],
  },
  {
    name: 'todo_inhibit_log',
    tableName: 'todo_inhibit_logs',
    entityType: 'todo',
    kind: 'todo-inhibit-log',
    idExpression: (row) => prefixedId('todo-inhibit-log:', row),
    recordExpression: TODO_INHIBIT_LOG_RECORD,
    updateColumns: ['todo_id', 'date_key', 'acknowledged_at', 'outcome'],
  },
  {
    name: 'habit',
    tableName: 'habits',
    entityType: 'habit',
    kind: 'habit',
    idExpression: (row) => prefixedId('habit:', row),
    recordExpression: HABIT_RECORD,
    updateColumns: [
      'notes', 'interval_days', 'schedule_start_at', 'schedule_rule_updated_at', 'schedule_duration_minutes', 'schedule_end_mode', 'schedule_end_at',
      'schedule_start_reminder_enabled', 'schedule_companion_enabled',
      'owner', 'frequency_period', 'minutes',
      'title',
      'goal_id',
      'category',
      'frequency',
      'week_days',
      'target_count',
      'reminder_times',
      'streak',
      'best_streak',
      'reminder_time',
      'kind',
      'schedule_enabled',
      'schedule_reminder_minutes_before',
      'status',
    ],
  },
  {
    name: 'habit_log',
    tableName: 'habit_logs',
    entityType: 'habit',
    kind: 'habit-log',
    idExpression: (row) => prefixedId('habit-log:', row),
    recordExpression: HABIT_LOG_RECORD,
    updateColumns: [
      'completion_activity_ids',
      'habit_id',
      'date_key',
      'completed',
      'completed_count',
      'note',
      'completed_at',
    ],
  },
  {
    name: 'future_self',
    tableName: 'future_self',
    entityType: 'goal',
    kind: 'future-self',
    idExpression: (row) => prefixedId('future-self:', row),
    recordExpression: FUTURE_SELF_RECORD,
    updateColumns: ['identity_statement', 'notes'],
  },
  {
    name: 'goal',
    tableName: 'goal_items',
    entityType: 'goal',
    kind: 'goal',
    idExpression: (row) => prefixedId('goal:', row),
    recordExpression: GOAL_RECORD,
    updateColumns: [
      'title',
      'description',
      'life_area',
      'status',
      'priority',
      'target_date',
      'progress',
      'goal_type',
      'target_count',
      'target_unit',
      'estimated_total_minutes',
      'frequency',
      'week_days',
      'action_title',
      'action_amount',
      'last_direction_check_at',
    ],
  },
  {
    name: 'goal_progress_event',
    tableName: 'goal_progress_events',
    entityType: 'progress',
    kind: 'goal-progress-event',
    idExpression: (row) => prefixedId('goal-progress:', row),
    recordExpression: GOAL_PROGRESS_RECORD,
    updateColumns: [
      'goal_id',
      'kind',
      'source_id',
      'amount',
      'note',
      'occurred_at',
    ],
  },
  {
    name: 'goal_time_credit',
    tableName: 'goal_time_credit_requests',
    entityType: 'progress',
    kind: 'goal-time-credit-request',
    idExpression: (row) => prefixedId('goal-time-credit:', row),
    recordExpression: GOAL_TIME_CREDIT_RECORD,
    updateColumns: [
      'todo_id',
      'goal_id',
      'todo_title',
      'suggested_minutes',
      'reason',
      'status',
    ],
  },
  {
    name: 'daily_challenge',
    tableName: 'daily_challenges',
    entityType: 'challenge',
    kind: 'daily-challenge',
    idExpression: (row) => prefixedId('challenge:', row),
    recordExpression: DAILY_CHALLENGE_RECORD,
    updateColumns: [
      'title',
      'category',
      'quadrant',
      'estimated_minutes',
      'habit_id',
      'status',
    ],
  },
  {
    name: 'day_review',
    tableName: 'day_reviews',
    entityType: 'review',
    kind: 'day-review',
    idExpression: (row) => prefixedId('day-review:', row),
    recordExpression: DAY_REVIEW_RECORD,
    updateColumns: [
      'date_key',
      'summary',
      'completed_task_titles',
      'pending_task_titles',
      'minutes_by_category',
      'total_tracked_minutes',
      'goal_notes',
      'habits_done',
      'habits_total',
      'habit_notes',
      'baiyun_message',
      'metrics_snapshot',
      'comparison_snapshot',
    ],
  },
  {
    name: 'week_review',
    tableName: 'week_reviews',
    entityType: 'review',
    kind: 'week-review',
    idExpression: (row) => prefixedId('week-review:', row),
    recordExpression: WEEK_REVIEW_RECORD,
    updateColumns: [
      'week_start',
      'week_end',
      'summary',
      'wins',
      'gaps',
      'goal_progress',
      'habit_insights',
      'next_week_suggestions',
      'baiyun_message',
      'metrics_snapshot',
      'comparison_snapshot',
    ],
  },
  {
    name: 'task_execution_session',
    tableName: 'task_execution_sessions',
    entityType: 'execution-session',
    kind: 'task-execution-session',
    idExpression: (row) => prefixedId('task-execution:', row),
    recordExpression: TASK_EXECUTION_RECORD,
    updateColumns: [
      'todo_id',
      'status',
      'started_at',
      'paused_at',
      'ended_at',
      'accumulated_seconds',
    ],
    rowPredicate: (row) => `${row}.status = 'finished'
      AND ${row}.paused_at IS NULL
      AND ${row}.ended_at IS NOT NULL`,
  },
  {
    name: 'task_execution_nudge',
    tableName: 'task_execution_nudges',
    entityType: 'execution-session',
    kind: 'task-execution-nudge',
    idExpression: (row) => (
      `${sqlString('task-execution-nudge:')} || `
      + `CAST(${row}.session_id AS TEXT) || ':' || CAST(${row}.kind AS TEXT)`
    ),
    recordExpression: TASK_EXECUTION_NUDGE_RECORD,
    updateColumns: ['session_id', 'todo_id', 'kind', 'delivered_at'],
  },
];

export const TODO_SEMANTIC_EXPECTED_CAPTURE_TRIGGER_COUNT =
  TODO_SEMANTIC_CAPTURE_SPECS.length * 3;

function parentRevisionIdsExpression(
  entityType: TodoSemanticEntityType,
  entityId: string,
) {
  return `COALESCE((
    SELECT json_group_array(revision_id)
    FROM (
      SELECT revision_id
      FROM todo_sync_entity_heads
      WHERE entity_type = ${sqlString(entityType)}
        AND entity_id = ${entityId}
      ORDER BY revision_id ASC
    )
  ), json('[]'))`;
}

function captureEnabledPredicate() {
  return `EXISTS (
    SELECT 1
    FROM todo_sync_runtime
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
  operation: 'upsert' | 'delete';
}) {
  const entityId = input.spec.idExpression(input.row);
  const payload = input.operation === 'delete'
    ? `json_object(
        'schemaVersion', ${TODO_SEMANTIC_SCHEMA_VERSION},
        'kind', ${sqlString(input.spec.kind)},
        'deletedAt', ${unixMillisecondsExpression()}
      )`
    : `json_object(
        'schemaVersion', ${TODO_SEMANTIC_SCHEMA_VERSION},
        'kind', ${sqlString(input.spec.kind)},
        'record', ${input.spec.recordExpression(input.row)}
      )`;
  return `INSERT INTO todo_sync_domain_outbox (
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
    ${TODO_SEMANTIC_SCHEMA_VERSION},
    ${payload},
    'pending',
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()}
  FROM todo_sync_runtime
  WHERE singleton_id = 1;`;
}

function advanceHeadsStatements(
  spec: CaptureSpec,
  row: 'NEW' | 'OLD',
) {
  const entityId = spec.idExpression(row);
  return `
  DELETE FROM todo_sync_entity_heads
  WHERE entity_type = ${sqlString(spec.entityType)}
    AND entity_id = ${entityId};

  INSERT INTO todo_sync_entity_heads (
    entity_type, entity_id, revision_id, updated_at
  )
  SELECT
    ${sqlString(spec.entityType)},
    ${entityId},
    revision_id,
    created_at
  FROM todo_sync_domain_outbox
  WHERE local_sequence = last_insert_rowid();`;
}

function triggerName(spec: CaptureSpec, action: CaptureAction) {
  return `todo_sync_capture_${assertSqlToken(spec.name, 'spec name')}_${action}`;
}

function buildCaptureTrigger(spec: CaptureSpec, action: CaptureAction) {
  const row = action === 'delete' ? 'OLD' : 'NEW';
  const operation = action === 'delete' ? 'delete' : 'upsert';
  const changed = action === 'update'
    ? ` AND (
      ${updateChangedPredicate(spec)}
    )`
    : '';
  const rowPredicate = spec.rowPredicate
    ? ` AND (${spec.rowPredicate(row)})`
    : '';
  return `
${spec.name === 'todo_item' || spec.name === 'habit' ? `DROP TRIGGER IF EXISTS ${triggerName(spec, action)};` : ''}
CREATE TRIGGER IF NOT EXISTS ${triggerName(spec, action)}
AFTER ${action.toUpperCase()} ON ${assertSqlToken(spec.tableName, 'table name')}
WHEN ${captureEnabledPredicate()}${rowPredicate}${changed}
BEGIN
  ${insertOutboxStatement({ spec, row, operation })}
  ${advanceHeadsStatements(spec, row)}
END;`;
}

export const TODO_SEMANTIC_CAPTURE_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS todo_sync_runtime (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  capture_enabled INTEGER NOT NULL DEFAULT 0 CHECK (capture_enabled IN (0, 1)),
  suppress_capture INTEGER NOT NULL DEFAULT 0 CHECK (suppress_capture IN (0, 1)),
  vault_id TEXT,
  source_device_id TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO todo_sync_runtime (
  singleton_id, capture_enabled, suppress_capture,
  vault_id, source_device_id, updated_at
) VALUES (1, 0, 0, NULL, NULL, 0);

CREATE TABLE IF NOT EXISTS todo_sync_domain_outbox (
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

CREATE INDEX IF NOT EXISTS idx_todo_sync_outbox_ready
  ON todo_sync_domain_outbox(state, available_at, local_sequence);

CREATE TABLE IF NOT EXISTS todo_sync_entity_heads (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id, revision_id)
);

CREATE INDEX IF NOT EXISTS idx_todo_sync_heads_entity
  ON todo_sync_entity_heads(entity_type, entity_id, revision_id);

CREATE TABLE IF NOT EXISTS todo_sync_conflicts (
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

CREATE INDEX IF NOT EXISTS idx_todo_sync_conflicts_pending
  ON todo_sync_conflicts(state, created_at, conflict_id);

CREATE TABLE IF NOT EXISTS todo_sync_bootstrap_state (
  adapter_id TEXT NOT NULL,
  bootstrap_version INTEGER NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (adapter_id, bootstrap_version, vault_id, source_device_id)
);

CREATE TABLE IF NOT EXISTS todo_sync_schema_meta (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  storage_schema_version INTEGER NOT NULL,
  capture_schema_version INTEGER NOT NULL,
  trigger_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO todo_sync_schema_meta (
  singleton_id, storage_schema_version, capture_schema_version,
  trigger_count, updated_at
) VALUES (
  1,
  ${TODO_SEMANTIC_STORAGE_SCHEMA_VERSION},
  ${TODO_SEMANTIC_CAPTURE_SCHEMA_VERSION},
  ${TODO_SEMANTIC_EXPECTED_CAPTURE_TRIGGER_COUNT},
  ${unixMillisecondsExpression()}
)
ON CONFLICT(singleton_id) DO UPDATE SET
  storage_schema_version = excluded.storage_schema_version,
  capture_schema_version = excluded.capture_schema_version,
  trigger_count = excluded.trigger_count,
  updated_at = excluded.updated_at;
`;

export const TODO_SEMANTIC_CAPTURE_TRIGGER_SQL =
  TODO_SEMANTIC_CAPTURE_SPECS.flatMap((spec) => (
    (['insert', 'update', 'delete'] as const).map((action) => (
      buildCaptureTrigger(spec, action)
    ))
  )).join('\n');

export const TODO_SEMANTIC_FULL_CAPTURE_SCHEMA_SQL = `
${TODO_SEMANTIC_CAPTURE_TABLE_SCHEMA_SQL}
${['habit', 'habit_log'].flatMap(name => ['insert', 'update', 'delete'].map(action => `DROP TRIGGER IF EXISTS todo_sync_capture_${name}_${action};`)).join('\n')}
${TODO_SEMANTIC_CAPTURE_TRIGGER_SQL}
`;

export const TODO_SEMANTIC_RESET_TECHNICAL_STATE_SQL = `
DELETE FROM todo_sync_domain_outbox;
DELETE FROM todo_sync_entity_heads;
DELETE FROM todo_sync_conflicts;
DELETE FROM todo_sync_bootstrap_state;
UPDATE todo_sync_runtime
SET capture_enabled = 0,
    suppress_capture = 0,
    vault_id = NULL,
    source_device_id = NULL,
    updated_at = 0
WHERE singleton_id = 1;
`;
