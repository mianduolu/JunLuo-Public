import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

import {
  createAndroidCurrentSnapshotAsyncSources,
} from './syncAndroidCurrentSnapshotAsyncSources';
import {
  createAndroidCurrentSnapshotSqliteSources,
} from './syncAndroidCurrentSnapshotSqliteSources';
import type { PostReviewOwnerRebind } from './syncBaiyunPostReviewCurrentSnapshot';
import {
  expoSyncRandomUuidV1,
} from './syncCryptoExpo';
import {
  indexCurrentSnapshotMutationSources,
  runCurrentSnapshotReadOnlyRehearsal,
  runNextSyncWorldBaselineBatch,
} from './syncNewWorldBaseline';
import {
  createExpoSyncWorldBaselineStore,
} from './syncNewWorldBaselineExpoStore';
import {
  createNewWorldAndroidStagingSecret,
  loadNewWorldAndroidStagingSecret,
} from './syncNewWorldSecretsExpo';
import { SYNC_WORLD_V2_DATABASE_NAME } from './syncWorld';
import {
  inspectSyncTechnicalReset,
  resetSyncTechnicalState,
  SYNC_TECHNICAL_RESET_MANIFEST,
  type SyncTechnicalResetDatabaseId,
} from './syncTechnicalReset';

export function createAndroidCurrentSnapshotSources(
  staging: Awaited<ReturnType<typeof loadNewWorldAndroidStagingSecret>>,
  postReviewOwnerRebind?: PostReviewOwnerRebind,
) {
  if (postReviewOwnerRebind && staging?.identity.deviceId !== postReviewOwnerRebind.nextDeviceId) {
    throw new Error('post review snapshot target does not match staging identity');
  }
  const asyncSources = createAndroidCurrentSnapshotAsyncSources({ staging });
  const sqliteSources = createAndroidCurrentSnapshotSqliteSources({
    scheduleStorage: asyncSources.scheduleStorage,
    focusStorage: asyncSources.focusStorage,
    postReviewOwnerRebind,
  });
  const sources = Object.freeze([
    ...asyncSources.sources,
    ...sqliteSources,
  ]);
  indexCurrentSnapshotMutationSources(sources);
  return sources;
}

let baselineSourceSession: Readonly<{
  identityKey: string;
  sources: ReturnType<typeof createAndroidCurrentSnapshotSources>;
}> | null = null;

function baselineIdentityKey(
  staging: NonNullable<Awaited<ReturnType<typeof loadNewWorldAndroidStagingSecret>>>,
) {
  return [
    staging.identity.vaultId,
    staging.identity.deviceId,
    staging.identity.keyId,
  ].join(':');
}

function getAndroidNewWorldBaselineSources(
  staging: NonNullable<Awaited<ReturnType<typeof loadNewWorldAndroidStagingSecret>>>,
) {
  const identityKey = baselineIdentityKey(staging);
  if (baselineSourceSession?.identityKey !== identityKey) {
    baselineSourceSession = Object.freeze({
      identityKey,
      sources: createAndroidCurrentSnapshotSources(staging),
    });
  }
  return baselineSourceSession.sources;
}

export function releaseAndroidNewWorldBaselineSources() {
  baselineSourceSession = null;
}

async function withTechnicalDatabase<T>(
  databaseName: string,
  action: (database: SQLite.SQLiteDatabase) => Promise<T>,
) {
  const database = await SQLite.openDatabaseAsync(
    databaseName,
    { useNewConnection: true },
  );
  try {
    await database.execAsync('PRAGMA busy_timeout = 5000;');
    return await action(database);
  } finally {
    await database.closeAsync();
  }
}

export async function runAndroidNewWorldReadOnlySnapshotRehearsal() {
  return runCurrentSnapshotReadOnlyRehearsal({
    sources: createAndroidCurrentSnapshotSources(null),
    pageLimit: 50,
  });
}

export async function inspectAndroidNewWorldTechnicalState() {
  const reports = [];
  for (const entry of SYNC_TECHNICAL_RESET_MANIFEST) {
    reports.push(await withTechnicalDatabase(
      entry.databaseName,
      (database) => inspectSyncTechnicalReset({
        databaseId: entry.databaseId,
        database,
      }),
    ));
  }
  return Object.freeze(reports);
}

export async function resetAndroidNewWorldTechnicalState(
  confirmedDatabaseIds: readonly SyncTechnicalResetDatabaseId[],
) {
  const confirmed = new Set(confirmedDatabaseIds);
  const expected = SYNC_TECHNICAL_RESET_MANIFEST.map(
    (entry) => entry.databaseId,
  );
  if (
    confirmed.size !== expected.length
    || expected.some((databaseId) => !confirmed.has(databaseId))
  ) {
    throw new Error('real technical reset requires the exact nine-database allowlist');
  }
  const reports = [];
  for (const entry of SYNC_TECHNICAL_RESET_MANIFEST) {
    reports.push(await withTechnicalDatabase(
      entry.databaseName,
      (database) => resetSyncTechnicalState({
        databaseId: entry.databaseId,
        database,
      }),
    ));
  }
  return Object.freeze(reports);
}

export async function generateAndroidNewWorldStagingSecrets(input: {
  displayName: string;
}) {
  return createNewWorldAndroidStagingSecret(input);
}

export async function initializeAndroidNewWorldV2Database() {
  const staging = await loadNewWorldAndroidStagingSecret();
  if (!staging) {
    throw new Error('new-world Android staging secret has not been generated');
  }
  return createExpoSyncWorldBaselineStore().initialize({
    world: staging.world,
    identity: staging.identity,
    createdAt: Date.now(),
  });
}

export async function loadAndroidNewWorldLocalSnapshot() {
  const staging = await loadNewWorldAndroidStagingSecret();
  if (!staging) {
    return Object.freeze({
      stagingReady: false,
      databaseInitialized: false,
      baselineComplete: false,
    });
  }
  const directory = SQLite.defaultDatabaseDirectory.replace(/\/+$/u, '');
  const databaseUri = `${directory.startsWith('file://') ? '' : 'file://'}${directory}/${SYNC_WORLD_V2_DATABASE_NAME}`;
  const databaseInfo = await FileSystem.getInfoAsync(databaseUri);
  if (!databaseInfo.exists) {
    return Object.freeze({
      stagingReady: true,
      databaseInitialized: false,
      baselineComplete: false,
    });
  }
  const checkpoint = await createExpoSyncWorldBaselineStore()
    .loadCheckpoint();
  return Object.freeze({
    stagingReady: true,
    databaseInitialized: checkpoint !== null,
    baselineComplete: checkpoint?.state === 'complete',
  });
}

export async function runNextAndroidNewWorldBaselineBatch() {
  const staging = await loadNewWorldAndroidStagingSecret();
  if (!staging) {
    throw new Error('new-world Android staging secret has not been generated');
  }
  try {
    const checkpoint = await runNextSyncWorldBaselineBatch({
      sources: getAndroidNewWorldBaselineSources(staging),
      store: createExpoSyncWorldBaselineStore(),
      identity: staging.identity,
      randomUuid: expoSyncRandomUuidV1,
      pageLimit: 50,
    });
    if (checkpoint.state === 'complete') {
      releaseAndroidNewWorldBaselineSources();
    }
    return checkpoint;
  } catch (error) {
    releaseAndroidNewWorldBaselineSources();
    throw error;
  }
}
