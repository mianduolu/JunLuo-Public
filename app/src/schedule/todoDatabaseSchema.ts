import type * as SQLite from 'expo-sqlite';
import { TODO_SEMANTIC_FULL_CAPTURE_SCHEMA_SQL } from '../sync/syncTodoSemanticSql';

const TODO_BUSINESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS todo_items (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'inbox',
  planned_for_date TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  priority TEXT NOT NULL DEFAULT 'normal',
  reminder_mode TEXT NOT NULL DEFAULT 'followup',
  reminder_stage INTEGER NOT NULL DEFAULT 0,
  last_reminded_at INTEGER,
  quadrant TEXT NOT NULL DEFAULT 'q2',
  category TEXT NOT NULL DEFAULT 'other',
  estimated_minutes INTEGER,
  tracked_minutes INTEGER NOT NULL DEFAULT 0,
  goal_id TEXT,
  goal_contribution INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  challenge_id TEXT,
  habit_id TEXT,
  parent_todo_id TEXT,
  parent_occurrence_id TEXT,
  step_order INTEGER,
  todo_type TEXT NOT NULL DEFAULT 'normal',
  inhibit_active_from TEXT,
  inhibit_ended_at INTEGER,
  postpone_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  completion_round INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_todo_status_date
  ON todo_items(status, planned_for_date, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_challenge_date
  ON todo_items(challenge_id, planned_for_date)
  WHERE challenge_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_goal_generated_date
  ON todo_items(goal_id, planned_for_date)
  WHERE source = 'goal' AND goal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS todo_reminder_notifications (
  todo_id TEXT NOT NULL,
  stage INTEGER NOT NULL,
  notification_id TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  PRIMARY KEY (todo_id, stage)
);

CREATE TABLE IF NOT EXISTS todo_inhibit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  todo_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  acknowledged_at INTEGER,
  outcome TEXT NOT NULL DEFAULT 'unrecorded',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(todo_id, date_key)
);

CREATE INDEX IF NOT EXISTS idx_todo_inhibit_logs_date
  ON todo_inhibit_logs(date_key, todo_id);

CREATE TABLE IF NOT EXISTS habits (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL DEFAULT 'you',
  frequency_period TEXT NOT NULL DEFAULT 'legacy',
  minutes INTEGER,
  notes TEXT,
  interval_days INTEGER,
  schedule_start_at INTEGER,
  schedule_rule_updated_at INTEGER,
  schedule_duration_minutes INTEGER,
  schedule_end_mode TEXT,
  schedule_end_at INTEGER,
  schedule_start_reminder_enabled INTEGER,
  schedule_companion_enabled INTEGER,
  title TEXT NOT NULL,
  goal_id TEXT,
  category TEXT NOT NULL DEFAULT 'other',
  frequency TEXT NOT NULL DEFAULT 'daily',
  week_days TEXT NOT NULL DEFAULT '[]',
  target_count INTEGER NOT NULL DEFAULT 1,
  reminder_times TEXT NOT NULL DEFAULT '[]',
  streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  reminder_time TEXT,
  kind TEXT NOT NULL DEFAULT 'habit',
  schedule_enabled INTEGER NOT NULL DEFAULT 0,
  schedule_reminder_minutes_before INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS habit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  completion_activity_ids TEXT NOT NULL DEFAULT '[]',
  habit_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(habit_id, date_key)
);

CREATE INDEX IF NOT EXISTS idx_habits_status_updated
  ON habits(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_habit_logs_date
  ON habit_logs(date_key, completed);

CREATE TABLE IF NOT EXISTS future_self (
  id TEXT PRIMARY KEY NOT NULL,
  identity_statement TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS goal_items (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  life_area TEXT NOT NULL DEFAULT 'growth',
  status TEXT NOT NULL DEFAULT 'active',
  priority TEXT NOT NULL DEFAULT 'normal',
  target_date TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  goal_type TEXT NOT NULL DEFAULT 'direction',
  target_count INTEGER,
  target_unit TEXT,
  estimated_total_minutes INTEGER,
  frequency TEXT NOT NULL DEFAULT 'none',
  week_days TEXT NOT NULL DEFAULT '[]',
  action_title TEXT,
  action_amount INTEGER NOT NULL DEFAULT 1,
  last_direction_check_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goal_status_area
  ON goal_items(status, life_area, updated_at);

CREATE TABLE IF NOT EXISTS goal_progress_events (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(goal_id, kind, source_id)
);

CREATE INDEX IF NOT EXISTS idx_goal_progress_events_goal
  ON goal_progress_events(goal_id, occurred_at);

CREATE TABLE IF NOT EXISTS goal_time_credit_requests (
  id TEXT PRIMARY KEY NOT NULL,
  todo_id TEXT NOT NULL UNIQUE,
  goal_id TEXT NOT NULL,
  todo_title TEXT NOT NULL,
  suggested_minutes INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goal_time_credit_requests_status
  ON goal_time_credit_requests(status, updated_at);

CREATE TABLE IF NOT EXISTS goal_time_credit_card_locators (
  request_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  applied_status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  quadrant TEXT NOT NULL DEFAULT 'q2',
  estimated_minutes INTEGER NOT NULL,
  habit_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_challenges_status
  ON daily_challenges(status, updated_at);

CREATE TABLE IF NOT EXISTS day_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  date_key TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  completed_task_titles TEXT NOT NULL,
  pending_task_titles TEXT NOT NULL,
  minutes_by_category TEXT NOT NULL,
  total_tracked_minutes INTEGER NOT NULL DEFAULT 0,
  goal_notes TEXT NOT NULL,
  habits_done INTEGER NOT NULL DEFAULT 0,
  habits_total INTEGER NOT NULL DEFAULT 0,
  habit_notes TEXT NOT NULL DEFAULT '[]',
  baiyun_message TEXT NOT NULL,
  metrics_snapshot TEXT,
  comparison_snapshot TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS week_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  week_start TEXT NOT NULL UNIQUE,
  week_end TEXT NOT NULL,
  summary TEXT NOT NULL,
  wins TEXT NOT NULL,
  gaps TEXT NOT NULL,
  goal_progress TEXT NOT NULL,
  habit_insights TEXT NOT NULL,
  next_week_suggestions TEXT NOT NULL,
  baiyun_message TEXT NOT NULL,
  metrics_snapshot TEXT,
  comparison_snapshot TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_execution_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  todo_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  paused_at INTEGER,
  ended_at INTEGER,
  accumulated_seconds INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_execution_status
  ON task_execution_sessions(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_task_execution_todo
  ON task_execution_sessions(todo_id, started_at);

CREATE TABLE IF NOT EXISTS task_execution_nudges (
  session_id TEXT NOT NULL,
  todo_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  PRIMARY KEY (session_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_task_execution_nudges_delivery
  ON task_execution_nudges(delivered_at, created_at);

CREATE TABLE IF NOT EXISTS task_execution_migrations (
  key TEXT PRIMARY KEY NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

async function ensureColumn(
  database: SQLite.SQLiteDatabase,
  table: string,
  name: string,
  definition: string,
) {
  const columns = await database.getAllAsync<{ name: string }>(
    `PRAGMA table_info(${table})`,
  );
  if (!columns.some((column) => column.name === name)) {
    await database.execAsync(
      `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,
    );
  }
}

async function migrateBusinessSchema(database: SQLite.SQLiteDatabase) {
  await ensureColumn(database, 'todo_items', 'quadrant', "TEXT NOT NULL DEFAULT 'q2'");
  await ensureColumn(database, 'todo_items', 'category', "TEXT NOT NULL DEFAULT 'other'");
  await ensureColumn(database, 'todo_items', 'estimated_minutes', 'INTEGER');
  await ensureColumn(database, 'todo_items', 'tracked_minutes', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'todo_items', 'goal_id', 'TEXT');
  await ensureColumn(database, 'todo_items', 'goal_contribution', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'todo_items', 'due_date', 'TEXT');
  await ensureColumn(database, 'todo_items', 'challenge_id', 'TEXT');
  await ensureColumn(database, 'todo_items', 'habit_id', 'TEXT');
  await ensureColumn(database, 'todo_items', 'parent_todo_id', 'TEXT');
  await ensureColumn(database, 'todo_items', 'parent_occurrence_id', 'TEXT');
  await ensureColumn(database, 'todo_items', 'step_order', 'INTEGER');
  await ensureColumn(database, 'todo_items', 'todo_type', "TEXT NOT NULL DEFAULT 'normal'");
  await ensureColumn(database, 'todo_items', 'inhibit_active_from', 'TEXT');
  await ensureColumn(database, 'todo_items', 'inhibit_ended_at', 'INTEGER');
  await ensureColumn(database, 'todo_items', 'postpone_count', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'todo_items', 'completion_round', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumn(database, 'habits', 'target_count', 'INTEGER NOT NULL DEFAULT 1');
  await ensureColumn(database, 'habits', 'owner', "TEXT NOT NULL DEFAULT 'you'");
  await ensureColumn(database, 'habits', 'frequency_period', "TEXT NOT NULL DEFAULT 'legacy'");
  await ensureColumn(database, 'habits', 'minutes', 'INTEGER');
  await ensureColumn(database, 'habits', 'notes', 'TEXT');
  await ensureColumn(database, 'habits', 'interval_days', 'INTEGER');
  await ensureColumn(database, 'habits', 'schedule_start_at', 'INTEGER');
  await ensureColumn(database, 'habits', 'schedule_rule_updated_at', 'INTEGER');
  await ensureColumn(database, 'habits', 'schedule_duration_minutes', 'INTEGER');
  await ensureColumn(database, 'habits', 'schedule_end_mode', 'TEXT');
  await ensureColumn(database, 'habits', 'schedule_end_at', 'INTEGER');
  await ensureColumn(database, 'habits', 'schedule_start_reminder_enabled', 'INTEGER');
  await ensureColumn(database, 'habits', 'schedule_companion_enabled', 'INTEGER');
  await ensureColumn(database, 'habit_logs', 'completion_activity_ids', "TEXT NOT NULL DEFAULT '[]'");
  await ensureColumn(database, 'habits', 'reminder_times', "TEXT NOT NULL DEFAULT '[]'");
  await ensureColumn(database, 'habits', 'kind', "TEXT NOT NULL DEFAULT 'habit'");
  await ensureColumn(database, 'habits', 'schedule_enabled', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(
    database,
    'habits',
    'schedule_reminder_minutes_before',
    'INTEGER NOT NULL DEFAULT 10',
  );
  await ensureColumn(database, 'habit_logs', 'completed_count', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumn(database, 'goal_items', 'goal_type', "TEXT NOT NULL DEFAULT 'direction'");
  await ensureColumn(database, 'goal_items', 'target_count', 'INTEGER');
  await ensureColumn(database, 'goal_items', 'target_unit', 'TEXT');
  await ensureColumn(database, 'goal_items', 'estimated_total_minutes', 'INTEGER');
  await ensureColumn(database, 'goal_items', 'frequency', "TEXT NOT NULL DEFAULT 'none'");
  await ensureColumn(database, 'goal_items', 'week_days', "TEXT NOT NULL DEFAULT '[]'");
  await ensureColumn(database, 'goal_items', 'action_title', 'TEXT');
  await ensureColumn(database, 'goal_items', 'action_amount', 'INTEGER NOT NULL DEFAULT 1');
  await ensureColumn(database, 'goal_items', 'last_direction_check_at', 'INTEGER');

  await ensureColumn(database, 'day_reviews', 'habits_done', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'day_reviews', 'habits_total', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'day_reviews', 'habit_notes', "TEXT NOT NULL DEFAULT '[]'");
  await ensureColumn(database, 'day_reviews', 'metrics_snapshot', 'TEXT');
  await ensureColumn(database, 'day_reviews', 'comparison_snapshot', 'TEXT');
  await ensureColumn(database, 'week_reviews', 'metrics_snapshot', 'TEXT');
  await ensureColumn(database, 'week_reviews', 'comparison_snapshot', 'TEXT');
}

export async function initializeTodoDatabase(database: SQLite.SQLiteDatabase) {
  await database.execAsync(TODO_BUSINESS_SCHEMA_SQL);
  await migrateBusinessSchema(database);
  await database.execAsync(TODO_SEMANTIC_FULL_CAPTURE_SCHEMA_SQL);
}
