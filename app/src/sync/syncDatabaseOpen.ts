import * as SQLite from 'expo-sqlite';

import {
  initializeSyncDatabaseSchema,
} from './syncDatabaseMigration';
import {
  enqueueSyncDatabaseOperation,
} from './syncDatabaseOperationQueue';
import {
  SYNC_DATABASE_NAME,
} from './syncSchema';
import type {
  SyncDatabaseFileName,
} from './syncWorld';
import { assertSyncDatabaseFileName } from './syncWorld';

export function openInitializedSyncDatabase(
  newerVersionMessage: string,
  databaseName: SyncDatabaseFileName = SYNC_DATABASE_NAME,
) {
  assertSyncDatabaseFileName(databaseName);
  return enqueueSyncDatabaseOperation(async () => {
    const database = await SQLite.openDatabaseAsync(
      databaseName,
    );
    try {
      await initializeSyncDatabaseSchema(
        database,
        newerVersionMessage,
      );
      return database;
    } catch (error) {
      await database.closeAsync().catch(() => undefined);
      throw error;
    }
  });
}
