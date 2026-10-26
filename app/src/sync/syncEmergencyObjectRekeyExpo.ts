import RawAsyncStorage from '@react-native-async-storage/async-storage';
import type * as SQLite from 'expo-sqlite';

import {
  base64UrlToBytes,
  deriveSyncVaultKeysV1,
} from './syncCrypto';
import { expoSyncRandomUuidV1 } from './syncCryptoExpo';
import {
  captureSyncContentObject,
  scanSyncContentObject,
} from './syncContentObjectCapture';
import { syncAndroidObjectExpoStore } from './syncAndroidObjectExpoStore';
import { openInitializedSyncDatabase } from './syncDatabaseOpen';
import { runSyncDatabaseTransaction } from './syncDatabaseOperationQueue';
import type { NewWorldAndroidStagingSecretV1 } from './syncNewWorldSecretsExpo';
import type { CurrentSnapshotMutationSourceV1 } from './syncNewWorldBaseline';
import { loadSyncObjectExpoManifest, syncObjectExpoFilePort } from './syncObjectExpoFilePort';
import { rekeyEmergencySyncMutationObjectIds } from './syncEmergencyObjectRekeyPure';
import {
  assertPlainMutationV1,
  type PlainMutationV1,
} from './syncProtocol';

const OBJECT_ID = /^[A-Za-z0-9_-]{43}$/u;
const FILE_URI_FIELDS = Object.freeze([
  'localUri',
  'uri',
  'sourceUri',
  'imageUri',
  'fileUri',
]);

export class EmergencyRebuildMissingObjectsError extends Error {
  readonly code = 'object.current-source-missing';

  constructor(readonly missingCount: number) {
    super(`有 ${missingCount} 个当前文件在手机上找不到原文件。`);
  }
}

function isFileUri(value: unknown): value is string {
  return typeof value === 'string' && /^file:\/\//u.test(value);
}

function collectObjectUris(
  value: unknown,
  targetIds: ReadonlySet<string>,
  result: Map<string, Set<string>>,
) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) collectObjectUris(entry, targetIds, result);
    return;
  }
  const record = value as Record<string, unknown>;
  const objectId = typeof record.objectId === 'string'
    && targetIds.has(record.objectId)
    ? record.objectId
    : null;
  if (objectId) {
    const uris = result.get(objectId) ?? new Set<string>();
    for (const field of FILE_URI_FIELDS) {
      if (isFileUri(record[field])) uris.add(record[field]);
    }
    result.set(objectId, uris);
  }
  for (const nested of Object.values(record)) {
    collectObjectUris(nested, targetIds, result);
  }
}

async function discoverBusinessObjectUris(targetIds: ReadonlySet<string>) {
  const found = new Map<string, Set<string>>();
  const keys = await RawAsyncStorage.getAllKeys();
  for (let offset = 0; offset < keys.length; offset += 64) {
    const rows = await RawAsyncStorage.multiGet(keys.slice(offset, offset + 64));
    for (const [, raw] of rows) {
      if (!raw || ![...targetIds].some((objectId) => raw.includes(objectId))) {
        continue;
      }
      try {
        collectObjectUris(JSON.parse(raw) as unknown, targetIds, found);
      } catch {
        // A non-JSON business value cannot carry a structured object reference.
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return found;
}

async function scheduleStagedUpload(input: {
  database: SQLite.SQLiteDatabase;
  objectId: string;
  keyId: string;
  totalChunks: number;
  localUri: string;
  now: number;
}) {
  await runSyncDatabaseTransaction(
    input.database,
    async (transaction) => {
      const existing = await transaction.getFirstAsync<{
        key_id: string;
        total_chunks: number;
      }>(
        `SELECT key_id, total_chunks FROM sync_object_jobs
         WHERE object_id = ?`,
        input.objectId,
      );
      if (existing) {
        if (
          existing.key_id !== input.keyId
          || existing.total_chunks !== input.totalChunks
        ) {
          throw new Error('staged object job identity changed');
        }
        await transaction.runAsync(
          `UPDATE sync_object_jobs
           SET direction = 'upload', state = 'pending', local_uri = ?,
               last_error_code = NULL, updated_at = ?
           WHERE object_id = ?`,
          input.localUri,
          input.now,
          input.objectId,
        );
        return;
      }
      await transaction.runAsync(
        `INSERT INTO sync_object_jobs (
           object_id, direction, key_id, total_chunks, completed_chunks,
           state, pinned, local_uri, last_error_code, created_at, updated_at
         ) VALUES (?, 'upload', ?, ?, 0, 'pending', 0, ?, NULL, ?, ?)`,
        input.objectId,
        input.keyId,
        input.totalChunks,
        input.localUri,
        input.now,
        input.now,
      );
    },
  );
}

export function createEmergencyObjectRekeySession(input: {
  oldSecret: NewWorldAndroidStagingSecretV1;
  newSecret: NewWorldAndroidStagingSecretV1;
  stagedDatabaseName: string;
  now?: () => number;
}) {
  const oldKeys = deriveSyncVaultKeysV1(base64UrlToBytes(
    input.oldSecret.secrets.vaultRootSecret,
    'old vaultRootSecret',
    32,
  ));
  const newKeys = deriveSyncVaultKeysV1(base64UrlToBytes(
    input.newSecret.secrets.vaultRootSecret,
    'new vaultRootSecret',
    32,
  ));
  const replacements = new Map<string, string>();
  const now = input.now ?? Date.now;
  let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

  const database = () => {
    if (!databasePromise) {
      databasePromise = openInitializedSyncDatabase(
        '紧急重建对象暂存库版本高于当前应用，已停止切换。',
        input.stagedDatabaseName,
      );
    }
    return databasePromise;
  };

  const resolveSourceUri = async (
    oldObjectId: string,
    candidates: readonly string[],
  ) => {
    for (const uri of candidates) {
      try {
        const scanned = await scanSyncContentObject(
          uri,
          oldKeys.objectIdKey,
          syncObjectExpoFilePort,
        );
        if (scanned.objectId === oldObjectId) return uri;
      } catch {
        // Try the next current business path, then the verified local copy.
      }
    }
    return syncAndroidObjectExpoStore.verifiedObjectUri(
      oldObjectId,
      oldKeys.objectIdKey,
    );
  };

  const prepare = async (objectIds: readonly string[]) => {
    const missing = objectIds.filter((objectId) => !replacements.has(objectId));
    if (!missing.length) return;
    missing.forEach((objectId) => {
      if (!OBJECT_ID.test(objectId)) {
        throw new Error('current snapshot objectId is invalid');
      }
    });
    const candidates = await discoverBusinessObjectUris(new Set(missing));
    let missingCount = 0;
    for (const oldObjectId of missing) {
      const sourceUri = await resolveSourceUri(
        oldObjectId,
        [...(candidates.get(oldObjectId) ?? [])],
      );
      if (!sourceUri) {
        missingCount += 1;
        continue;
      }
      const stagedDatabase = await database();
      const captured = await captureSyncContentObject({
        sourceUri,
        stagingToken: await expoSyncRandomUuidV1(),
        keyId: input.newSecret.identity.keyId,
        objectIdKey: newKeys.objectIdKey,
        files: syncObjectExpoFilePort,
        jobs: {
          scheduleUpload: (job) => scheduleStagedUpload({
            ...job,
            database: stagedDatabase,
          }),
        },
        now: now(),
      });
      replacements.set(oldObjectId, captured.objectId);
    }
    if (missingCount > 0) {
      throw new EmergencyRebuildMissingObjectsError(missingCount);
    }
  };

  const transformMutation = async (mutation: PlainMutationV1) => {
    const objectIds = [...new Set(mutation.objectRefs)];
    if (mutation.entity.domain === 'gifts') {
      // The gift snapshot captures its real local originals with the supplied
      // new-world keys. Register those verified objects in the same staged
      // transfer queue, rather than interpreting their new IDs as old IDs.
      for (const objectId of objectIds) {
        if (replacements.has(objectId)) continue;
        const localUri = await syncAndroidObjectExpoStore.verifiedObjectUri(objectId, newKeys.objectIdKey);
        const manifest = localUri ? await loadSyncObjectExpoManifest(objectId) : null;
        if (!localUri || !manifest) throw new EmergencyRebuildMissingObjectsError(1);
        await scheduleStagedUpload({ database: await database(), objectId, keyId: input.newSecret.identity.keyId,
          totalChunks: manifest.chunks.length, localUri, now: now() });
        replacements.set(objectId, objectId);
      }
      return mutation;
    }
    await prepare(objectIds);
    if (!objectIds.length) return mutation;
    const transformed = rekeyEmergencySyncMutationObjectIds(mutation, replacements);
    assertPlainMutationV1(transformed);
    return transformed;
  };

  return {
    wrapSources(sources: readonly CurrentSnapshotMutationSourceV1[]) {
      return Object.freeze(sources.map((source): CurrentSnapshotMutationSourceV1 => ({
        adapterId: source.adapterId,
        readMutationPage: async (request) => {
          const page = await source.readMutationPage(request);
          const mutations = [];
          for (const mutation of page.mutations) {
            mutations.push(await transformMutation(mutation));
          }
          return Object.freeze({
            mutations: Object.freeze(mutations),
            nextPageToken: page.nextPageToken,
          });
        },
      })));
    },
    snapshot() {
      return Object.freeze({
        completedFiles: replacements.size,
        replacements: new Map(replacements),
      });
    },
    async close() {
      if (!databasePromise) return;
      const open = await databasePromise;
      await open.closeAsync();
      databasePromise = null;
    },
  };
}
