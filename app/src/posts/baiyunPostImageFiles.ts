import * as FileSystem from 'expo-file-system/legacy';
import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { getMemoryDatabase } from '../memory/memoryStore';
import { writeStringFileSafely } from '../storage/safeFileWrite';
import { compressPostImage } from './baiyunPostImageCodec';
import { newPostImageId } from './baiyunPostImageData';

export type PostImageAsset = { id: string; uri: string; width: number; height: number; byteSize: number; mimeType: 'image/jpeg' };
type AssetRow = { id: string; width: number; height: number; byte_size: number };
let fileWork: Promise<unknown> = Promise.resolve();
function serialFiles<T>(work: () => Promise<T>): Promise<T> {
  const next = fileWork.catch(() => undefined).then(work);
  fileWork = next;
  return next;
}
/** Sync staging/materialization shares the existing import and collection writer. */
export const runPostImageFileWork = serialFiles;
export const POST_IMAGE_FILES_CHANGED = 'junluo.baiyunPosts.imagesMaterialized';
function directory() {
  if (!FileSystem.documentDirectory) throw new Error('baiyun-post-image-storage-unavailable');
  return `${FileSystem.documentDirectory}post-images/`;
}
function imageUri(id: string) {
  if (!/^post-image-\d+-[a-z0-9]+$/.test(id)) throw new Error('baiyun-post-image-invalid-id');
  return `${directory()}${id}.jpg`;
}
function asset(row: AssetRow): PostImageAsset {
  return { id: row.id, uri: imageUri(row.id), width: row.width, height: row.height, byteSize: row.byte_size, mimeType: 'image/jpeg' };
}
async function commit<T>(epoch: number | null, work: () => Promise<T>) {
  const result = await runBackupRestoreDataEpochCommit(epoch, work);
  if (!result.committed) throw new Error('baiyun-post-stale');
  return result.value;
}

export async function loadPostImageAssets(imageIds: readonly string[]): Promise<PostImageAsset[]> {
  if (!imageIds.length) return [];
  const database = await getMemoryDatabase();
  const result: PostImageAsset[] = [];
  for (const id of imageIds) {
    const row = await database.getFirstAsync<AssetRow>('SELECT * FROM baiyun_post_images WHERE id = ?', id);
    if (!row) throw new Error('baiyun-post-image-missing');
    const item = asset(row);
    if (!(await FileSystem.getInfoAsync(item.uri)).exists) throw new Error('baiyun-post-image-file-missing');
    result.push(item);
  }
  return result;
}

/** Temporary picker URIs never escape this import. Only the compressed JPEG is retained. */
export function importPostImages(draftKey: string, uris: readonly string[]): Promise<PostImageAsset[]> {
  if (!draftKey.trim() || !uris.length || uris.length > 9 || uris.some(uri => !uri.trim())) {
    return Promise.reject(new Error('baiyun-post-invalid-images'));
  }
  const epoch = captureBackupRestoreDataEpoch();
  return serialFiles(async () => {
    const database = await getMemoryDatabase();
    const count = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM baiyun_post_image_drafts WHERE draft_key = ?', draftKey);
    if ((count?.count ?? 0) + uris.length > 9) throw new Error('baiyun-post-invalid-images');
    const imported: PostImageAsset[] = [];
    try {
      for (const uri of uris) {
        const encoded = await compressPostImage(uri); // Never decode nine source photos concurrently.
        const id = newPostImageId();
        const target = imageUri(id);
        await commit(epoch, async () => {
          await writeStringFileSafely(target, encoded.base64, { encoding: FileSystem.EncodingType.Base64, minimumBytes: 1 });
          try {
            const info = await FileSystem.getInfoAsync(target);
            if (!info.exists || info.isDirectory) throw new Error('baiyun-post-image-file-missing');
            await database.withExclusiveTransactionAsync(async transaction => {
              await transaction.runAsync('INSERT INTO baiyun_post_images(id, width, height, byte_size) VALUES (?, ?, ?, ?)', id, encoded.width, encoded.height, info.size);
              await transaction.runAsync('INSERT INTO baiyun_post_image_drafts(draft_key, image_id) VALUES (?, ?)', draftKey, id);
            });
            imported.push({ id, uri: target, width: encoded.width, height: encoded.height, byteSize: info.size, mimeType: 'image/jpeg' });
          } catch (error) {
            await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
            throw error;
          }
        });
      }
      return imported;
    } catch (error) {
      await commit(epoch, async () => {
        for (const item of imported) await database.runAsync('DELETE FROM baiyun_post_image_drafts WHERE draft_key = ? AND image_id = ?', draftKey, item.id);
        await collectUnused();
      }).catch(() => undefined);
      throw error;
    }
  });
}

/** Chapter 4 calls this after saving draft order, successful publication, or explicit discard. */
export function retainPostDraftImages(draftKey: string, imageIds: readonly string[]) {
  if (!draftKey.trim() || imageIds.length > 9 || new Set(imageIds).size !== imageIds.length) {
    return Promise.reject(new Error('baiyun-post-invalid-images'));
  }
  const nextIds = [...imageIds];
  const epoch = captureBackupRestoreDataEpoch();
  return serialFiles(() => commit(epoch, async () => {
    const database = await getMemoryDatabase();
    const references = await database.getAllAsync<{ image_id: string }>('SELECT image_id FROM baiyun_post_image_drafts WHERE draft_key = ?', draftKey);
    if (references.length === nextIds.length && references.every(row => nextIds.includes(row.image_id))) return;
    let removed = false;
    await database.withExclusiveTransactionAsync(async transaction => {
      // Re-read inside the write transaction; another save may have changed this key while waiting.
      const current = await transaction.getAllAsync<{ image_id: string }>('SELECT image_id FROM baiyun_post_image_drafts WHERE draft_key = ?', draftKey);
      if (current.length === nextIds.length && current.every(row => nextIds.includes(row.image_id))) return;
      for (const id of nextIds) {
        if (!await transaction.getFirstAsync('SELECT id FROM baiyun_post_images WHERE id = ?', id)) throw new Error('baiyun-post-image-missing');
      }
      await transaction.runAsync('DELETE FROM baiyun_post_image_drafts WHERE draft_key = ?', draftKey);
      for (const id of nextIds) await transaction.runAsync('INSERT INTO baiyun_post_image_drafts(draft_key, image_id) VALUES (?, ?)', draftKey, id);
      removed = current.some(row => !nextIds.includes(row.image_id));
    });
    if (removed) return collectUnused();
  }));
}

async function collectUnused() {
  const database = await getMemoryDatabase();
  // A captured older full version still needs its JPEG until the existing object
  // store owns a verified copy. Prepared versions no longer pin the domain copy.
  const hasOutbox = await database.getFirstAsync("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_sync_domain_outbox'");
  const keptIdsSql = `SELECT image_id FROM baiyun_post_image_references${hasOutbox ? `
    UNION SELECT json_extract(asset.value, '$.id') FROM memory_sync_domain_outbox o,
      json_each(CASE WHEN json_valid(o.payload_json) THEN COALESCE(json_extract(o.payload_json, '$.record.image_assets_json'), '[]') ELSE '[]' END) asset
    WHERE o.state IN ('pending', 'leased') AND o.entity_type IN ('post', 'post-comment')
      AND o.operation <> 'delete' AND json_extract(asset.value, '$.object_id') IS NULL` : ''}`;
  const unused = await database.getFirstAsync(`SELECT id FROM baiyun_post_images WHERE id NOT IN (${keptIdsSql}) LIMIT 1`);
  if (unused) {
    await database.withExclusiveTransactionAsync(async transaction => {
      await transaction.runAsync(`DELETE FROM baiyun_post_images WHERE id NOT IN (${keptIdsSql})`);
    });
  }
  const kept = new Set((await database.getAllAsync<{ id: string }>('SELECT id FROM baiyun_post_images')).map(row => `${row.id}.jpg`));
  const dir = directory();
  if (!(await FileSystem.getInfoAsync(dir)).exists) return { deleted: 0, failed: 0 };
  let deleted = 0, failed = 0;
  // A crash between DB commit and unlink is recovered on the next collection. Own directory only.
  for (const name of await FileSystem.readDirectoryAsync(dir)) {
    if (kept.has(name) || !/^post-image-\d+-[a-z0-9]+\.jpg(?:\.junluo-(?:safe|rollback)-[^/\\]+(?:\.tmp)?)?$/.test(name)) continue;
    const uri = `${dir}${name}`;
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || info.isDirectory) continue;
    try { await FileSystem.deleteAsync(uri, { idempotent: true }); deleted += 1; } catch { failed += 1; }
  }
  return { deleted, failed };
}

/** Also call when reopening the chapter-4 page; failed file deletion remains retryable. */
export function collectUnusedPostImages() {
  const epoch = captureBackupRestoreDataEpoch();
  return serialFiles(() => commit(epoch, collectUnused));
}

/** Cold-page recovery: interrupted comment/edit composers have no persistent draft. */
export function releaseAbandonedPostEditorImages(activeKeys: ReadonlySet<string>) {
  const epoch = captureBackupRestoreDataEpoch();
  return serialFiles(() => commit(epoch, async () => {
    const database = await getMemoryDatabase();
    const rows = await database.getAllAsync<{ draft_key: string }>(`SELECT DISTINCT draft_key FROM baiyun_post_image_drafts
      WHERE draft_key LIKE 'post-edit-%' OR draft_key LIKE 'post-comment-%'`);
    if (rows.some(row => !activeKeys.has(row.draft_key))) {
      await database.withExclusiveTransactionAsync(async transaction => {
        for (const row of rows) if (!activeKeys.has(row.draft_key)) {
          await transaction.runAsync('DELETE FROM baiyun_post_image_drafts WHERE draft_key = ?', row.draft_key);
        }
      });
    }
    return collectUnused();
  }));
}

export async function readPostImagesForVision(imageIds: readonly string[]) {
  const images = await loadPostImageAssets(imageIds);
  const result: { imageDataUrl: string; mimeType: string }[] = [];
  for (const image of images) result.push({ mimeType: image.mimeType,
    imageDataUrl: await FileSystem.readAsStringAsync(image.uri, { encoding: FileSystem.EncodingType.Base64 }) });
  return result;
}
