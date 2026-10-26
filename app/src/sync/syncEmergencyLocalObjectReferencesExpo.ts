import RawAsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';
import { File } from 'expo-file-system';
import { emitChatDataChanged } from '../chat/chatDataChanges';
import { base64UrlToBytes, deriveSyncVaultKeysV1 } from './syncCrypto';
import { scanSyncContentObject } from './syncContentObjectCapture';
import { syncAndroidObjectExpoStore } from './syncAndroidObjectExpoStore';
import { openInitializedSyncDatabase } from './syncDatabaseOpen';
import { runSyncDatabaseTransaction } from './syncDatabaseOperationQueue';
import {
  collectEmergencyLocalObjectIds,
  isEmergencyObjectReferenceStorageKey,
  rebindEmergencyLocalObjectReferences,
} from './syncEmergencyLocalObjectReferences';
import {
  loadNewWorldAndroidSecretSlot,
  NEW_WORLD_REBUILD_ROLLBACK_SECRET_KEY,
  type NewWorldAndroidStagingSecretV1,
} from './syncNewWorldSecretsExpo';
import { computeSyncObjectIdV1 } from './syncObjectProtocol';
import { getSyncObjectExpoDirectories, loadSyncObjectExpoManifest, syncObjectExpoFilePort } from './syncObjectExpoFilePort';
import {
  parseTogetherWalkedLifeLocalIndex,
  prepareTogetherWalkedLifeLocalIndex,
  TOGETHER_WALKED_LIFE_GLOBAL_KEYS,
  TOGETHER_WALKED_LIFE_INDEX_KEY,
} from './syncTogetherWalkedLifeStorageDerivation';

/** Rebind current local file references before retiring the old world's files. */
export async function rebindEmergencyAndroidLocalObjectReferences(
  secret: NewWorldAndroidStagingSecretV1,
) {
  const keys = deriveSyncVaultKeysV1(base64UrlToBytes(secret.secrets.vaultRootSecret, 'current vault root', 32));
  const central = await openInitializedSyncDatabase('新世界对象索引版本不受支持。');
  let memory: SQLite.SQLiteDatabase | null = null;
  try {
    memory = await SQLite.openDatabaseAsync('junluo-memory.db', { useNewConnection: true });
    const jobs = await central.getAllAsync<{ object_id: string; total_chunks: number }>(
      'SELECT object_id, total_chunks FROM sync_object_jobs WHERE key_id = ?', secret.identity.keyId,
    );
    const jobsById = new Map(jobs.map(job => [job.object_id, job]));
    const storageKeys = (await RawAsyncStorage.getAllKeys()).filter(isEmergencyObjectReferenceStorageKey);
    const storage = new Map<string, string>();
    for (let offset = 0; offset < storageKeys.length; offset += 64) {
      for (const [key, raw] of await RawAsyncStorage.multiGet(storageKeys.slice(offset, offset + 64))) {
        if (raw !== null) storage.set(key, raw);
      }
    }
    const images = await memory.getAllAsync<{ object_id: string; chunk_count: number }>(
      'SELECT DISTINCT object_id, chunk_count FROM baiyun_post_images WHERE object_id IS NOT NULL',
    );
    const referenced = new Set(images.map(image => image.object_id));
    for (const [key, raw] of storage) {
      collectEmergencyLocalObjectIds(key, raw).forEach(id => referenced.add(id));
    }
    if (!referenced.size) {
      await RawAsyncStorage.removeItem('junluo.sync.chatCorePendingCapture.v1');
      return { reboundObjects: 0, changedStorageKeys: 0, changedImages: 0, unrelatedReferences: 0 };
    }
    const replacements = new Map<string, { objectId: string; keyId: string; localUri: string }>();
    const objectsRoot = getSyncObjectExpoDirectories().objects.uri.replace(/\/+$/u, '');
    const previous = await loadNewWorldAndroidSecretSlot(NEW_WORLD_REBUILD_ROLLBACK_SECRET_KEY);
    if (previous && previous.identity.vaultId !== secret.identity.vaultId) {
      const previousKeys = deriveSyncVaultKeysV1(base64UrlToBytes(previous.secrets.vaultRootSecret, 'previous vault root', 32));
      for (const job of jobs) {
        const localUri = await syncAndroidObjectExpoStore.verifiedObjectUri(job.object_id, keys.objectIdKey);
        const manifest = await loadSyncObjectExpoManifest(job.object_id);
        if (!localUri || !manifest || manifest.chunks.length !== job.total_chunks) {
          throw new Error('新世界当前文件尚未完整核验。');
        }
        const oldId = computeSyncObjectIdV1(previousKeys.objectIdKey,
          base64UrlToBytes(manifest.plaintextSha256, 'current object hash', 32));
        if (referenced.has(oldId)) replacements.set(oldId, { objectId: job.object_id, keyId: secret.identity.keyId, localUri });
      }
    }
    let unrelatedReferences = 0;
    for (const objectId of referenced) {
      if (jobsById.has(objectId) || replacements.has(objectId)) continue;
      // With a preceding identity, current files already supplied every mapping.
      if (previous || !new File(`${objectsRoot}/${objectId}`).exists) { unrelatedReferences += 1; continue; }
      const scanned = await scanSyncContentObject(`${objectsRoot}/${objectId}`, keys.objectIdKey, syncObjectExpoFilePort);
      const job = jobsById.get(scanned.objectId);
      // An unused local index may refer to a file outside the current baseline.
      if (!job) { unrelatedReferences += 1; continue; }
      const localUri = await syncAndroidObjectExpoStore.verifiedObjectUri(scanned.objectId, keys.objectIdKey);
      const manifest = await loadSyncObjectExpoManifest(scanned.objectId);
      if (!localUri || !manifest || manifest.chunks.length !== job.total_chunks) {
        throw new Error('新世界当前文件尚未完整核验。');
      }
      replacements.set(objectId, { objectId: scanned.objectId, keyId: secret.identity.keyId, localUri });
    }
    const updated = new Map(storage);
    for (const [key, raw] of storage) {
      updated.set(key, rebindEmergencyLocalObjectReferences(key, raw, replacements));
    }
    const indexRaw = updated.get(TOGETHER_WALKED_LIFE_INDEX_KEY);
    if (indexRaw && indexRaw !== storage.get(TOGETHER_WALKED_LIFE_INDEX_KEY)) {
      const index = parseTogetherWalkedLifeLocalIndex(indexRaw);
      if (index.draftFingerprint !== undefined) {
        const prepared = await prepareTogetherWalkedLifeLocalIndex({
          raw: Object.fromEntries(await Promise.all(TOGETHER_WALKED_LIFE_GLOBAL_KEYS.map(async key => [
            key, updated.get(key) ?? await RawAsyncStorage.getItem(key),
          ]))),
          previous: index, keyId: secret.identity.keyId, now: index.updatedAt,
          capture: { capture: async () => { throw new Error('引用更新不能新增业务文件。'); } },
        });
        updated.set(TOGETHER_WALKED_LIFE_INDEX_KEY, JSON.stringify({ ...index, draftFingerprint: prepared.draftFingerprint }));
      }
    }
    const changed = [...updated].filter(([key, raw]) => raw !== storage.get(key));
    if (changed.length) await RawAsyncStorage.multiSet(changed);
    if (changed.some(([key]) => key.startsWith('junluo.chat.'))) emitChatDataChanged('restore');
    let changedImages = 0;
    await runSyncDatabaseTransaction(memory, async transaction => {
      const runtime = await transaction.getFirstAsync<{ suppress_capture: number }>(
        'SELECT suppress_capture FROM memory_sync_runtime WHERE singleton_id=1',
      );
      await transaction.runAsync('UPDATE memory_sync_runtime SET suppress_capture=1 WHERE singleton_id=1');
      for (const image of images) {
        const replacement = replacements.get(image.object_id);
        if (!replacement) continue;
        if (jobsById.get(replacement.objectId)?.total_chunks !== image.chunk_count) {
          throw new Error('动态图片换钥前后分块数不同。');
        }
        const result = await transaction.runAsync(
          'UPDATE baiyun_post_images SET object_id=? WHERE object_id=?', replacement.objectId, image.object_id,
        );
        changedImages += result.changes;
      }
      await transaction.runAsync('UPDATE memory_sync_runtime SET suppress_capture=? WHERE singleton_id=1', runtime?.suppress_capture ?? 0);
    });
    // Fresh baseline owns current messages; old before/after packets must not replay.
    await RawAsyncStorage.removeItem('junluo.sync.chatCorePendingCapture.v1');
    return { reboundObjects: replacements.size, changedStorageKeys: changed.length, changedImages, unrelatedReferences };
  } finally {
    await Promise.all([central.closeAsync(), memory?.closeAsync()]);
  }
}
