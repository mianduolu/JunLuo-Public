import * as SQLite from 'expo-sqlite';

import { FOCUS_SEMANTIC_FULL_CAPTURE_SCHEMA_SQL } from '../sync/syncFocusSemanticSql';

export const FOCUS_DATABASE_NAME = 'junluo-focus.db' as const;

const FOCUS_BUSINESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS focus_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  mode TEXT NOT NULL DEFAULT 'support',
  user_activity TEXT NOT NULL,
  baiyun_activity TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  quality TEXT NOT NULL, -- Legacy storage only; new sessions write an empty value, never a rating.
  heart_rate_avg REAL NOT NULL,
  temperature_avg REAL NOT NULL,
  created_at INTEGER NOT NULL,
  review_json TEXT
);

CREATE TABLE IF NOT EXISTS focus_logs (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  elapsed_seconds INTEGER NOT NULL,
  trigger TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_focus_sessions_started_at
  ON focus_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_focus_logs_session_id
  ON focus_logs(session_id, created_at ASC);
`;

let focusDatabasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

async function openFocusDatabase() {
  const database = await SQLite.openDatabaseAsync(FOCUS_DATABASE_NAME);
  await database.execAsync(FOCUS_BUSINESS_SCHEMA_SQL);
  const columns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(focus_sessions)');
  if (!columns.some(column => column.name === 'review_json')) {
    await database.withTransactionAsync(async () => {
      await database.execAsync(`ALTER TABLE focus_sessions ADD COLUMN review_json TEXT;
        DROP TRIGGER IF EXISTS focus_sync_capture_focus_session_insert;
        DROP TRIGGER IF EXISTS focus_sync_capture_focus_session_update;
        DROP TRIGGER IF EXISTS focus_sync_capture_focus_session_delete;`);
    });
  }
  await database.execAsync(FOCUS_SEMANTIC_FULL_CAPTURE_SCHEMA_SQL);
  return database;
}

export function getFocusDatabase() {
  if (!focusDatabasePromise) {
    focusDatabasePromise = openFocusDatabase().catch((error) => {
      focusDatabasePromise = undefined;
      throw error;
    });
  }
  return focusDatabasePromise;
}

export async function closeFocusDatabase() {
  const current = focusDatabasePromise;
  focusDatabasePromise = undefined;
  if (!current) return;
  const database = await current;
  await database.closeAsync();
}
