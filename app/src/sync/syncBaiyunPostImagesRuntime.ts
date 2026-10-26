import * as FileSystem from 'expo-file-system/legacy';
import { runPostImageFileWork } from '../posts/baiyunPostImageFiles';
import { base64UrlToBytes, deriveSyncVaultKeysV1 } from './syncCrypto';
import { expoSyncRandomUuidV1 } from './syncCryptoExpo';
import type { SyncDevicePublicIdentityV1, SyncDeviceSecretsV1 } from './syncDeviceContract';
import { captureSyncContentObject } from './syncContentObjectCapture';
import { ensureAndroidContentObjectUpload } from './syncAndroidContentObjectUpload';
import { syncAndroidObjectExpoStore } from './syncAndroidObjectExpoStore';
import { readBaiyunPostImageAssets } from './syncMemoryRecords';
import { scheduleSyncObjectUpload } from './syncObjectJobStore';
import { loadSyncObjectExpoManifest, syncObjectExpoFilePort } from './syncObjectExpoFilePort';
import type { JsonValue } from './syncProtocol';

export function baiyunPostImageUri(id: string) {
  if (!/^post-image-\d+-[a-z0-9]+$/.test(id) || !FileSystem.documentDirectory) {
    throw new Error('post image sync path 无效。');
  }
  return `${FileSystem.documentDirectory}post-images/${id}.jpg`;
}

/** Prepare the captured version, never substitute today's group or its order. */
export async function prepareBaiyunPostImagesPayload(input: {
  payload: JsonValue; identity: SyncDevicePublicIdentityV1; secrets: SyncDeviceSecretsV1; now: number;
}): Promise<JsonValue> {
  const value = input.payload as { schemaVersion?: number; record?: Record<string, unknown> };
  if (![6, 9].includes(Number(value.schemaVersion)) || !value.record
    || !('image_assets_json' in value.record)) return input.payload;
  const assets = readBaiyunPostImageAssets(value.record);
  if (!assets.length) return input.payload;
  const keys = deriveSyncVaultKeysV1(base64UrlToBytes(input.secrets.vaultRootSecret, 'post image vault root', 32));
  return runPostImageFileWork(async () => {
    const prepared = [];
    for (const asset of assets) {
      if (asset.object_id !== null && asset.chunk_count !== null) {
        const uri = await syncAndroidObjectExpoStore.verifiedObjectUri(asset.object_id, keys.objectIdKey);
        const manifest = uri ? await loadSyncObjectExpoManifest(asset.object_id) : null;
        if (manifest && manifest.plaintextBytes === asset.byte_size && manifest.chunks.length === asset.chunk_count
          && await ensureAndroidContentObjectUpload({ objectId: asset.object_id, keyId: input.identity.keyId,
            totalChunks: asset.chunk_count, objectIdKey: keys.objectIdKey, now: input.now })) {
          prepared.push(asset); continue;
        }
      }
      const sourceUri = baiyunPostImageUri(asset.id);
      const info = await FileSystem.getInfoAsync(sourceUri);
      if (!info.exists || info.isDirectory || info.size !== asset.byte_size) throw new Error('post image sync source size mismatch');
      const captured = await captureSyncContentObject({ sourceUri, stagingToken: expoSyncRandomUuidV1(), keyId: input.identity.keyId,
        objectIdKey: keys.objectIdKey, files: syncObjectExpoFilePort, jobs: { scheduleUpload: scheduleSyncObjectUpload }, now: input.now });
      if (captured.manifest.plaintextBytes !== asset.byte_size) throw new Error('post image sync staged size mismatch');
      prepared.push({ ...asset, object_id: captured.objectId, chunk_count: captured.manifest.chunks.length });
    }
    return { ...value, record: { ...value.record, image_assets_json: JSON.stringify(prepared) } } as JsonValue;
  });
}
