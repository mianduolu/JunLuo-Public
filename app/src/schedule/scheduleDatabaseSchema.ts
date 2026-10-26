import type * as SQLite from 'expo-sqlite';
import {
  SCHEDULE_SEMANTIC_CAPTURE_TABLE_SCHEMA_SQL,
  SCHEDULE_SEMANTIC_CAPTURE_TRIGGER_SQL,
} from '../sync/syncScheduleSemanticSql';

const SCHEDULE_BUSINESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schedule_items (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  reminder_minutes_before INTEGER NOT NULL DEFAULT 0,
  recurrence TEXT NOT NULL DEFAULT 'none',
  recurrence_rule TEXT,
  range_end_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  reminder_text TEXT NOT NULL,
  reminder_intensity TEXT NOT NULL DEFAULT 'gentle',
  source TEXT NOT NULL DEFAULT 'manual',
  owner TEXT NOT NULL DEFAULT 'you',
  reading_id TEXT,
  execution_json TEXT,
  start_reminder_enabled INTEGER,
  end_mode TEXT,
  duration_minutes REAL,
  habit_completion_key TEXT,
  habit_id TEXT,
  habit_anchor_key TEXT,
  todo_id TEXT,
  goal_id TEXT,
  plan_id TEXT,
  companion_enabled INTEGER NOT NULL DEFAULT 0,
  letter_ticket_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_occurrences (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL,
  scheduled_start_at INTEGER NOT NULL,
  reminder_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  notification_id TEXT,
  chat_delivered_at INTEGER,
  completed_at INTEGER,
  completion_round INTEGER NOT NULL DEFAULT 0,
  UNIQUE(item_id, scheduled_start_at)
);

CREATE INDEX IF NOT EXISTS idx_schedule_occurrence_due
  ON schedule_occurrences(reminder_at, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_habit_anchor
  ON schedule_items(habit_anchor_key)
  WHERE habit_anchor_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS day_template_instances (
  id TEXT PRIMARY KEY NOT NULL,
  date_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  start_at INTEGER,
  end_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  completed_at INTEGER,
  template_hash TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'usual',
  enabled INTEGER NOT NULL DEFAULT 1,
  operation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(date_key, kind)
);

CREATE INDEX IF NOT EXISTS idx_day_template_instances_date
  ON day_template_instances(date_key, start_at);

CREATE INDEX IF NOT EXISTS idx_day_template_instances_completed
  ON day_template_instances(completed_at);

CREATE TABLE IF NOT EXISTS schedule_companion_events (
  id TEXT PRIMARY KEY NOT NULL,
  occurrence_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  notification_id TEXT,
  delivered_at INTEGER,
  responded_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(occurrence_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_schedule_companion_due
  ON schedule_companion_events(status, scheduled_at);
`;

async function applyLegacyScheduleMigrations(
  database: SQLite.SQLiteDatabase,
) {
  const routineColumns = await database.getAllAsync<{ name: string; notnull: number }>('PRAGMA table_info(day_template_instances)');
  if (routineColumns.find(column => column.name === 'start_at')?.notnull) {
    // SQLite cannot remove NOT NULL in place. The temporary replacement is only
    // a transactional schema migration, not an additional business table.
    await database.withExclusiveTransactionAsync(async transaction => {
      await transaction.execAsync(`
        CREATE TABLE day_template_instances_upgrade (
          id TEXT PRIMARY KEY NOT NULL, date_key TEXT NOT NULL, kind TEXT NOT NULL,
          title TEXT NOT NULL, start_at INTEGER, end_at INTEGER,
          status TEXT NOT NULL DEFAULT 'pending', completed_at INTEGER,
          template_hash TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'usual',
          enabled INTEGER NOT NULL DEFAULT 1, operation_id TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(date_key, kind)
        );
        INSERT INTO day_template_instances_upgrade
          (id,date_key,kind,title,start_at,end_at,status,completed_at,template_hash,source,enabled,operation_id,created_at,updated_at)
          SELECT id,date_key,kind,title,start_at,end_at,status,completed_at,template_hash,
            ${routineColumns.some(column => column.name === 'source') ? 'source' : "'usual'"},
            ${routineColumns.some(column => column.name === 'enabled') ? 'enabled' : '1'},
            ${routineColumns.some(column => column.name === 'operation_id') ? 'operation_id' : 'NULL'},created_at,updated_at
          FROM day_template_instances;
        DROP TABLE day_template_instances;
        ALTER TABLE day_template_instances_upgrade RENAME TO day_template_instances;
        CREATE INDEX idx_day_template_instances_date ON day_template_instances(date_key,start_at);
        CREATE INDEX idx_day_template_instances_completed ON day_template_instances(completed_at);
      `);
    });
  } else {
    for (const [name, type] of [['source', "TEXT NOT NULL DEFAULT 'usual'"], ['enabled', 'INTEGER NOT NULL DEFAULT 1'], ['operation_id', 'TEXT']]) {
      if (!routineColumns.some(column => column.name === name)) await database.execAsync(`ALTER TABLE day_template_instances ADD COLUMN ${name} ${type};`);
    }
  }
  const columns = await database.getAllAsync<{ name: string }>(
    'PRAGMA table_info(schedule_items)',
  );
  if (!columns.some((column) => column.name === 'reminder_intensity')) {
    await database.execAsync(
      "ALTER TABLE schedule_items ADD COLUMN reminder_intensity TEXT NOT NULL DEFAULT 'gentle';",
    );
  }
  for (const [name, type] of [['owner', "TEXT NOT NULL DEFAULT 'you'"], ['reading_id', 'TEXT'], ['execution_json', 'TEXT'],
    ['start_reminder_enabled', 'INTEGER'], ['end_mode', 'TEXT'], ['duration_minutes', 'REAL'], ['habit_completion_key', 'TEXT']]) {
    if (!columns.some((column) => column.name === name)) {
      await database.execAsync(`ALTER TABLE schedule_items ADD COLUMN ${name} ${type};`);
    }
  }
  if (!columns.some((column) => column.name === 'recurrence_rule')) {
    await database.execAsync(
      'ALTER TABLE schedule_items ADD COLUMN recurrence_rule TEXT;',
    );
  }
  if (!columns.some((column) => column.name === 'range_end_at')) {
    await database.execAsync(
      'ALTER TABLE schedule_items ADD COLUMN range_end_at INTEGER;',
    );
  }
  if (!columns.some((column) => column.name === 'habit_id')) {
    await database.execAsync(
      'ALTER TABLE schedule_items ADD COLUMN habit_id TEXT;',
    );
  }
  if (!columns.some((column) => column.name === 'habit_anchor_key')) {
    await database.execAsync(
      'ALTER TABLE schedule_items ADD COLUMN habit_anchor_key TEXT;',
    );
  }
  if (!columns.some((column) => column.name === 'todo_id')) {
    await database.execAsync(
      'ALTER TABLE schedule_items ADD COLUMN todo_id TEXT;',
    );
  }
  if (!columns.some((column) => column.name === 'goal_id')) {
    await database.execAsync(
      'ALTER TABLE schedule_items ADD COLUMN goal_id TEXT;',
    );
  }
  if (!columns.some((column) => column.name === 'plan_id')) {
    await database.execAsync(
      'ALTER TABLE schedule_items ADD COLUMN plan_id TEXT;',
    );
  }
  if (!columns.some((column) => column.name === 'companion_enabled')) {
    await database.execAsync(
      'ALTER TABLE schedule_items ADD COLUMN companion_enabled INTEGER NOT NULL DEFAULT 0;',
    );
  }
  if (!columns.some((column) => column.name === 'letter_ticket_enabled')) {
    await database.execAsync(
      'ALTER TABLE schedule_items ADD COLUMN letter_ticket_enabled INTEGER NOT NULL DEFAULT 0;',
    );
  }
  const occurrenceColumns = await database.getAllAsync<{ name: string }>(
    'PRAGMA table_info(schedule_occurrences)',
  );
  if (!occurrenceColumns.some((column) => column.name === 'completed_at')) {
    await database.execAsync(
      'ALTER TABLE schedule_occurrences ADD COLUMN completed_at INTEGER;',
    );
  }
  if (!occurrenceColumns.some((column) => column.name === 'completion_round')) {
    await database.execAsync(
      'ALTER TABLE schedule_occurrences ADD COLUMN completion_round INTEGER NOT NULL DEFAULT 0;',
    );
  }
  const eventColumns = await database.getAllAsync<{ name: string }>(
    'PRAGMA table_info(schedule_companion_events)',
  );
  if (!eventColumns.some((column) => column.name === 'preparation_json')) {
    await database.execAsync('ALTER TABLE schedule_companion_events ADD COLUMN preparation_json TEXT;');
  }
  for (const [name, type] of [['reminder_body_json', 'TEXT'], ['notified_at', 'INTEGER'], ['recovery_handled_at', 'INTEGER']]) {
    if (!eventColumns.some((column) => column.name === name)) {
      await database.execAsync(`ALTER TABLE schedule_companion_events ADD COLUMN ${name} ${type};`);
    }
  }
}

export async function initializeScheduleDatabase(database: SQLite.SQLiteDatabase) {
        await database.execAsync(SCHEDULE_BUSINESS_SCHEMA_SQL);
        await applyLegacyScheduleMigrations(database);
        await database.execAsync(SCHEDULE_SEMANTIC_CAPTURE_TABLE_SCHEMA_SQL);
        await database.execAsync(SCHEDULE_SEMANTIC_CAPTURE_TRIGGER_SQL);
}
