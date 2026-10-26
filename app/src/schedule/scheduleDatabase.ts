import * as SQLite from 'expo-sqlite';
import { initializeScheduleDatabase } from './scheduleDatabaseSchema';

import {
  SCHEDULE_SEMANTIC_DATABASE_NAME,
} from '../sync/syncScheduleSemanticSql';

let scheduleDatabasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

export async function getScheduleDatabase() {
  if (!scheduleDatabasePromise) {
    scheduleDatabasePromise = SQLite.openDatabaseAsync(
      SCHEDULE_SEMANTIC_DATABASE_NAME,
    ).then(async (database) => {
      try {
        await initializeScheduleDatabase(database);
        return database;
      } catch (error) {
        await database.closeAsync().catch(() => undefined);
        scheduleDatabasePromise = undefined;
        throw error;
      }
    });
  }
  return scheduleDatabasePromise;
}

export async function closeScheduleDatabase() {
  if (!scheduleDatabasePromise) return;
  const database = await scheduleDatabasePromise;
  scheduleDatabasePromise = undefined;
  await database.closeAsync();
}
