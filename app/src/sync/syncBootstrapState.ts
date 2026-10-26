import * as SQLite from 'expo-sqlite';

import {
  syncBootstrapOperationId,
} from './syncBootstrapContract';
import type {
  SyncDurableIntentState,
} from './syncRecoveryIntent';
import {
  openInitializedSyncDatabase,
} from './syncDatabaseOpen';

type BootstrapMarkerRow = {
  cursor_value: number;
};

type DurableIntentStateRow = {
  state: SyncDurableIntentState;
};

let bootstrapStateDatabasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

function assertTimestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('bootstrap updatedAt 必须是非负 Unix 毫秒整数。');
  }
}

function bootstrapMarkerStreamId(input: {
  adapterId: string;
  version: number;
  sourceDeviceId: string;
}) {
  return `bootstrap-marker:v${input.version}:${input.adapterId}:${input.sourceDeviceId}`;
}

async function getBootstrapStateDatabase() {
  if (!bootstrapStateDatabasePromise) {
    const openingDatabasePromise = openInitializedSyncDatabase(
      '同步数据库版本高于当前应用，无法读取 bootstrap 状态。',
    );
    const retryableDatabasePromise = openingDatabasePromise.catch(
      (error) => {
        if (
          bootstrapStateDatabasePromise
          === retryableDatabasePromise
        ) {
          bootstrapStateDatabasePromise = undefined;
        }
        throw error;
      },
    );
    bootstrapStateDatabasePromise = retryableDatabasePromise;
  }
  return bootstrapStateDatabasePromise;
}

export async function loadSyncBootstrapState(input: {
  adapterId: string;
  version: number;
  sourceDeviceId: string;
}) {
  const operationId = syncBootstrapOperationId(input);
  const streamId = bootstrapMarkerStreamId(input);
  const database = await getBootstrapStateDatabase();
  const [marker, durableIntent] = await Promise.all([
    database.getFirstAsync<BootstrapMarkerRow>(
      'SELECT cursor_value FROM sync_cursors WHERE stream_id = ?',
      streamId,
    ),
    database.getFirstAsync<DurableIntentStateRow>(
      'SELECT state FROM sync_durable_intents WHERE operation_id = ?',
      operationId,
    ),
  ]);
  return {
    completed: marker?.cursor_value === input.version,
    durableIntentState: durableIntent?.state ?? null,
  };
}

export async function markSyncBootstrapCompleted(input: {
  adapterId: string;
  version: number;
  sourceDeviceId: string;
  updatedAt: number;
}) {
  assertTimestamp(input.updatedAt);
  syncBootstrapOperationId(input);
  const streamId = bootstrapMarkerStreamId(input);
  const database = await getBootstrapStateDatabase();
  await database.runAsync(
    `INSERT INTO sync_cursors (stream_id, cursor_value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(stream_id) DO UPDATE SET
       cursor_value = excluded.cursor_value,
       updated_at = excluded.updated_at`,
    streamId,
    input.version,
    input.updatedAt,
  );
}

export const syncBootstrapStatePort = {
  load: loadSyncBootstrapState,
  markCompleted: markSyncBootstrapCompleted,
};

export async function closeSyncBootstrapStateDatabaseForTests() {
  if (!bootstrapStateDatabasePromise) return;
  const database = await bootstrapStateDatabasePromise;
  await database.closeAsync();
  bootstrapStateDatabasePromise = undefined;
}
