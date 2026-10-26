import * as FileSystem from 'expo-file-system/legacy';
import { DeviceEventEmitter } from 'react-native';
import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { getMemoryDatabase } from '../memory/memoryStore';
import { POST_IMAGE_FILES_CHANGED, runPostImageFileWork } from '../posts/baiyunPostImageFiles';
import { copyFileSafely } from '../storage/safeFileWrite';
import type { AndroidSyncObjectMaterializer } from './syncAndroidObjectMaterializationCore';
import { baiyunPostImageUri } from './syncBaiyunPostImagesRuntime';
import { loadSyncObjectJob } from './syncObjectJobStore';

type Asset = { id: string; object_id: string; width: number; height: number; byte_size: number };
const CURRENT_ASSETS_SQL = `SELECT DISTINCT i.* FROM baiyun_post_images i WHERE i.object_id IS NOT NULL AND (
  EXISTS (SELECT 1 FROM baiyun_post_metadata p JOIN memories m ON m.id = p.post_id,
    json_each(p.image_group_json, '$.imageIds') j WHERE j.value = i.id AND m.type <> 'archived')
  OR EXISTS (SELECT 1 FROM baiyun_post_comment_metadata c JOIN memories m ON m.id = c.post_id,
    json_each(c.image_group_json, '$.imageIds') j WHERE j.value = i.id AND c.deleted = 0 AND m.type <> 'archived'))`;

/** Only attach a verified file to an asset still used by the current formal view. */
export const materializeBaiyunPostImageObject: AndroidSyncObjectMaterializer['materializeVerifiedObject'] = async input => {
  if (!/^file:\/\//.test(input.localUri)) throw new Error('post image verified file URI 无效。');
  const epoch = captureBackupRestoreDataEpoch();
  return runPostImageFileWork(async () => {
    const database = await getMemoryDatabase();
    const assets = await database.getAllAsync<Asset>(`${CURRENT_ASSETS_SQL} AND i.object_id = ?`, input.objectId);
    if (!assets.length) return { handled: false, pending: true, changed: false };
    let changed = false;
    for (const asset of assets) {
      const current = await database.getFirstAsync<Asset>(`${CURRENT_ASSETS_SQL} AND i.id = ? AND i.object_id = ?`, asset.id, input.objectId);
      if (!current) continue;
      const source = await FileSystem.getInfoAsync(input.localUri);
      if (!source.exists || source.isDirectory || source.size !== current.byte_size) throw new Error('post image materialized size mismatch');
      const target = baiyunPostImageUri(asset.id);
      const committed = await runBackupRestoreDataEpochCommit(epoch, async () => {
        // Reads and file work hold no SQLite transaction and no object-store lock.
        if (!await database.getFirstAsync(`${CURRENT_ASSETS_SQL} AND i.id = ? AND i.object_id = ?`, asset.id, input.objectId)) return false;
        await copyFileSafely({ from: input.localUri, to: target, minimumBytes: current.byte_size });
        const saved = await FileSystem.getInfoAsync(target);
        if (!saved.exists || saved.isDirectory || saved.size !== current.byte_size) throw new Error('post image materialized size mismatch');
        if (!await database.getFirstAsync(`${CURRENT_ASSETS_SQL} AND i.id = ? AND i.object_id = ?`, asset.id, input.objectId)) {
          // A deletion during IO must not leave a late image behind. Another
          // still-live mapping owns its own file and is never removed here.
          if (!await database.getFirstAsync(`${CURRENT_ASSETS_SQL} AND i.id = ?`, asset.id)) {
            await FileSystem.deleteAsync(target, { idempotent: true });
          }
          return false;
        }
        return true;
      });
      changed ||= committed.committed && committed.value;
    }
    if (changed) DeviceEventEmitter.emit(POST_IMAGE_FILES_CHANGED);
    return { handled: true, changed };
  });
};

/** Called after business commit: a previously verified file may arrive first. */
export async function materializeCurrentBaiyunPostImages(owner?: { postId: string; commentSource: string | null }) {
  const database = await getMemoryDatabase();
  const ownerSql = owner ? owner.commentSource === null
    ? " AND i.id IN (SELECT j.value FROM baiyun_post_metadata p, json_each(p.image_group_json, '$.imageIds') j WHERE p.post_id = ?)"
    : " AND i.id IN (SELECT j.value FROM baiyun_post_comment_metadata c, json_each(c.image_group_json, '$.imageIds') j WHERE c.post_id = ? AND c.source = ? AND c.deleted = 0)" : '';
  const assets = await database.getAllAsync<Asset>(CURRENT_ASSETS_SQL + ownerSql,
    ...(owner ? owner.commentSource === null ? [owner.postId] : [owner.postId, owner.commentSource] : []));
  let changed = false;
  for (const objectId of new Set(assets.map(asset => asset.object_id))) {
    const job = await loadSyncObjectJob(objectId);
    if (job?.state !== 'verified' || !job.localUri) continue;
    const result = await materializeBaiyunPostImageObject({ objectId, localUri: job.localUri, references: [] });
    changed ||= result.changed === true;
  }
  return { changed };
}
