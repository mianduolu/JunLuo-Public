import type * as SQLite from 'expo-sqlite';

import {
  runSyncDatabaseTransaction,
} from './syncDatabaseOperationQueue';
import {
  getExpoSyncWorldV2Database,
} from './syncNewWorldBaselineExpoStore';
import {
  initializeNewWorldLiveCursor,
  type NewWorldLiveCursorQueryPort,
} from './syncNewWorldLiveCursor';
import {
  loadNewWorldAndroidStagingSecret,
} from './syncNewWorldSecretsExpo';
import {
  createAndroidSyncRelayClient,
} from './syncRelayClientExpo';

function queryPort(
  database: SQLite.SQLiteDatabase,
): NewWorldLiveCursorQueryPort {
  return {
    getFirstAsync: (source, ...parameters) => database.getFirstAsync(
      source,
      ...parameters as SQLite.SQLiteBindValue[],
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

export async function ensureAndroidNewWorldLiveCursor(input: {
  baseUrl: string;
  now?: () => number;
}) {
  const staging = await loadNewWorldAndroidStagingSecret();
  if (!staging) {
    throw new Error('Android 新世界设备尚未建立。');
  }
  const database = await getExpoSyncWorldV2Database();
  const existing = await database.getFirstAsync<{
    cursor_value: number;
  }>(
    "SELECT cursor_value FROM sync_cursors WHERE stream_id = 'relay-v1'",
  );
  if (existing && existing.cursor_value > 0) {
    return Object.freeze({
      state: 'already-initialized' as const,
      relayCursor: existing.cursor_value,
    });
  }
  const relay = createAndroidSyncRelayClient({
    baseUrl: input.baseUrl,
  });
  const enrollment = {
    publicIdentity: staging.identity,
    secrets: staging.secrets,
  };
  const baseline = await relay.getCurrentBaseline(enrollment);
  return initializeNewWorldLiveCursor({
    database: {
      withTransaction: (task) => runSyncDatabaseTransaction(
        database,
        (transaction) => task(queryPort(transaction)),
      ),
    },
    identity: staging.identity,
    baseline,
    now: (input.now ?? Date.now)(),
  });
}
