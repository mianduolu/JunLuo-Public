import * as SQLite from 'expo-sqlite';
import { clearRestoredScheduleMemoryUsage } from '../schedule/scheduleReminderTiming';

export type DatabaseImportSource = Uint8Array | {
  directory: string;
  fileName: string;
};

const MAINTENANCE_CONNECTION_OPTIONS = {
  useNewConnection: true,
  // expo-sqlite 16.0.x can crash natively while sweeping statements during
  // close on databases that contain FTS tables. Maintenance code finalizes
  // every statement it creates, so prefer a catchable SQLITE_BUSY close over
  // that unsafe automatic sweep.
  finalizeUnusedStatementsBeforeClosing: false,
} as const;

function normalizeDatabaseDirectory(directory: string) {
  return decodeURIComponent(directory.replace(/^file:\/\//, '')).replace(/\/$/, '');
}

export async function openDatabaseImportSource(source: DatabaseImportSource) {
  if (source instanceof Uint8Array) {
    return SQLite.deserializeDatabaseAsync(source);
  }
  return SQLite.openDatabaseAsync(
    source.fileName,
    MAINTENANCE_CONNECTION_OPTIONS,
    normalizeDatabaseDirectory(source.directory),
  );
}

export async function backupDatabaseToDirectory(databaseName: string, targetDirectory: string) {
  const sourceDatabase = await SQLite.openDatabaseAsync(
    databaseName,
    MAINTENANCE_CONNECTION_OPTIONS,
  );
  try {
    const destinationDatabase = await SQLite.openDatabaseAsync(
      databaseName,
      MAINTENANCE_CONNECTION_OPTIONS,
      normalizeDatabaseDirectory(targetDirectory),
    );
    try {
      await SQLite.backupDatabaseAsync({ sourceDatabase, destDatabase: destinationDatabase });
    } finally {
      await destinationDatabase.closeAsync();
    }
  } finally {
    await sourceDatabase.closeAsync();
  }
}

export async function restoreDatabaseFromDisk(
  source: Exclude<DatabaseImportSource, Uint8Array>,
  destinationName: string,
) {
  const sourceDatabase = await openDatabaseImportSource(source);
  try {
    const destinationDatabase = await SQLite.openDatabaseAsync(
      destinationName,
      MAINTENANCE_CONNECTION_OPTIONS,
    );
    try {
      await SQLite.backupDatabaseAsync({ sourceDatabase, destDatabase: destinationDatabase });
      if (destinationName === 'junluo-schedule.db') await clearRestoredScheduleMemoryUsage(destinationDatabase);
    } finally {
      await destinationDatabase.closeAsync();
    }
  } finally {
    await sourceDatabase.closeAsync();
  }
}

export async function validateDatabaseFile(source: DatabaseImportSource) {
  const database = await openDatabaseImportSource(source);
  try {
    const result = await database.getFirstAsync<{ quick_check?: string }>('PRAGMA quick_check;');
    const value = result?.quick_check;
    if (value !== 'ok') {
      throw new Error(typeof value === 'string' ? value : 'quick_check did not return ok');
    }
  } finally {
    await database.closeAsync();
  }
}
