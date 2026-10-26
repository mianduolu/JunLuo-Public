import type * as SQLite from 'expo-sqlite';
import { openDatabaseImportSource, type DatabaseImportSource } from '../backup/sqliteBackupFiles';
import {
  THEATER_ISOLATED_CAPTURE_TABLE_SCHEMA_SQL,
  THEATER_ISOLATED_RESET_TECHNICAL_STATE_SQL,
} from '../sync/syncTheaterIsolatedSql';
import { migrateTheaterStoryDatabase } from './theaterStoryMigration';
import { validateTheaterStoryDatabase } from './theaterStoryValidation';

// Only restore staging databases may be passed here. Never open the live store.
export async function prepareTheaterStoryRestore(database: SQLite.SQLiteDatabase): Promise<void> {
  const integrity = await database.getFirstAsync<{ quick_check: string }>('PRAGMA quick_check;');
  if (integrity?.quick_check !== 'ok') throw new Error('theater-story-invalid-database');
  await database.execAsync(THEATER_ISOLATED_CAPTURE_TABLE_SCHEMA_SQL);
  await database.execAsync('UPDATE theater_sync_runtime SET capture_enabled = 0 WHERE singleton_id = 1;');
  // Expo exclusive transactions open a new connection. Deserialized :memory:
  // backups must migrate on their original, privately owned staging connection.
  await migrateTheaterStoryDatabase({
    execAsync: database.execAsync.bind(database),
    runAsync: database.runAsync.bind(database),
    getAllAsync: database.getAllAsync.bind(database),
    getFirstAsync: database.getFirstAsync.bind(database),
    withExclusiveTransactionAsync: async (work) => {
      await database.withTransactionAsync(async () => { await work(database); });
    },
  });
  await validateTheaterStoryDatabase(database);
  await database.execAsync('UPDATE theater_conversations SET legacy_sync_open = 0;');
  await database.execAsync(THEATER_ISOLATED_RESET_TECHNICAL_STATE_SQL);
}

export async function prepareTheaterBackupBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const database = await openDatabaseImportSource(bytes);
  try {
    await prepareTheaterStoryRestore(database);
    return await database.serializeAsync();
  } finally {
    await database.closeAsync();
  }
}

export async function prepareTheaterBackupFile(
  source: Exclude<DatabaseImportSource, Uint8Array>,
): Promise<void> {
  const database = await openDatabaseImportSource(source);
  try {
    await prepareTheaterStoryRestore(database);
  } finally {
    await database.closeAsync();
  }
}
