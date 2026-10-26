import type * as SQLite from 'expo-sqlite';

import { observeDatabaseWorkload } from '../runtime/databaseWorkloadDiagnostics';

let syncDatabaseOperationQueue = Promise.resolve();

export function enqueueSyncDatabaseOperation<T>(
  operation: () => Promise<T>,
) {
  const current = syncDatabaseOperationQueue
    .catch(() => undefined)
    .then(() => observeDatabaseWorkload('database.sync.operation', operation));
  syncDatabaseOperationQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

export function runSyncDatabaseTransaction<T>(
  database: SQLite.SQLiteDatabase,
  operation: (transaction: SQLite.SQLiteDatabase) => Promise<T>,
) {
  return enqueueSyncDatabaseOperation(async () => {
    await database.execAsync('BEGIN IMMEDIATE');
    try {
      const result = await operation(database);
      await database.execAsync('COMMIT');
      return result;
    } catch (error) {
      await database.execAsync('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}
