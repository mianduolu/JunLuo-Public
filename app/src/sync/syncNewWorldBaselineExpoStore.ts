import type * as SQLite from 'expo-sqlite';

import {
  openInitializedSyncDatabase,
} from './syncDatabaseOpen';
import {
  runSyncDatabaseTransaction,
} from './syncDatabaseOperationQueue';
import type {
  SyncWorldBaselineStoreV1,
} from './syncNewWorldBaseline';
import {
  createSyncWorldBaselineSqliteStore,
  type SyncWorldBaselineSqliteDatabasePort,
  type SyncWorldBaselineSqliteQueryPort,
} from './syncNewWorldBaselineSqliteStore';
import {
  SYNC_WORLD_V2_DATABASE_NAME,
  type SyncDatabaseFileName,
} from './syncWorld';

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;
const dedicatedDatabasePromises = new Map<
  string,
  Promise<SQLite.SQLiteDatabase>
>();

export async function getExpoSyncWorldV2Database() {
  if (!databasePromise) {
    const opening = openInitializedSyncDatabase(
      '新同步数据库版本高于当前应用，已停止建立新世界。',
      SYNC_WORLD_V2_DATABASE_NAME,
    );
    const retryable = opening.catch((error) => {
      if (databasePromise === retryable) databasePromise = undefined;
      throw error;
    });
    databasePromise = retryable;
  }
  return databasePromise;
}

export async function closeExpoSyncWorldV2Database() {
  if (!databasePromise) return;
  const database = await databasePromise;
  await database.closeAsync();
  databasePromise = undefined;
}

function asQueryPort(
  database: SQLite.SQLiteDatabase,
): SyncWorldBaselineSqliteQueryPort {
  return {
    getFirstAsync: (source, ...parameters) => (
      database.getFirstAsync(source, ...parameters as SQLite.SQLiteBindValue[])
    ),
    runAsync: async (source, ...parameters) => {
      const result = await database.runAsync(
        source,
        ...parameters as SQLite.SQLiteBindValue[],
      );
      return { changes: result.changes };
    },
  };
}

function databasePortFor(
  database: SQLite.SQLiteDatabase,
): SyncWorldBaselineSqliteDatabasePort {
  return {
    ...asQueryPort(database),
    withTransaction: (task) => runSyncDatabaseTransaction(
      database,
      (transaction) => task(asQueryPort(transaction)),
    ),
  };
}

async function openDedicatedDatabase(databaseName: SyncDatabaseFileName) {
  const existing = dedicatedDatabasePromises.get(databaseName);
  if (existing) return existing;
  const opening = openInitializedSyncDatabase(
    '紧急重建暂存数据库版本高于当前应用，已停止切换。',
    databaseName,
  );
  const retryable = opening.catch((error) => {
    if (dedicatedDatabasePromises.get(databaseName) === retryable) {
      dedicatedDatabasePromises.delete(databaseName);
    }
    throw error;
  });
  dedicatedDatabasePromises.set(databaseName, retryable);
  return retryable;
}

export async function closeDedicatedSyncWorldDatabase(
  databaseName: SyncDatabaseFileName,
) {
  const promise = dedicatedDatabasePromises.get(databaseName);
  if (!promise) return;
  const database = await promise;
  await database.closeAsync();
  dedicatedDatabasePromises.delete(databaseName);
}

export function createExpoSyncWorldBaselineStore(input: {
  databaseName?: SyncDatabaseFileName;
} = {}): SyncWorldBaselineStoreV1 {
  const databaseName = input.databaseName ?? SYNC_WORLD_V2_DATABASE_NAME;
  return createSyncWorldBaselineSqliteStore({
    getDatabase: async () => databasePortFor(
      databaseName === SYNC_WORLD_V2_DATABASE_NAME
        ? await getExpoSyncWorldV2Database()
        : await openDedicatedDatabase(databaseName),
    ),
  });
}
