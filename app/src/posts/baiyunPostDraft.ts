import type { SQLiteDatabase } from 'expo-sqlite';
import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { getMemoryDatabase } from '../memory/memoryStore';
import { normalizePostTagIds } from './baiyunPostData';
import { collectUnusedPostImages, loadPostImageAssets } from './baiyunPostImageFiles';

export const POST_DRAFT_IMAGE_KEY = 'post-publish-draft';
export type PostDraft = { id: string; title?: string; content: string; imageIds: string[]; tagIds: string[] };
type DraftRow = { id: string; title?: string; content: string; image_ids_json: string; tag_ids_json: string };

// Local only: no memory entry, outbox, model material or sync record is created.
const schema = `CREATE TABLE IF NOT EXISTS baiyun_post_publish_draft (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  id TEXT NOT NULL, content TEXT NOT NULL, image_ids_json TEXT NOT NULL, tag_ids_json TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT ''
);`;
let draftWork: Promise<unknown> = Promise.resolve();

function serialDraft<T>(work: () => Promise<T>): Promise<T> {
  const epoch = captureBackupRestoreDataEpoch();
  const next = draftWork.catch(() => undefined).then(async () => {
    const result = await runBackupRestoreDataEpochCommit(epoch, work);
    if (!result.committed) throw new Error('baiyun-post-stale');
    return result.value;
  });
  draftWork = next;
  return next;
}

function snapshot(draft: PostDraft): PostDraft {
  if (!draft.id.trim() || typeof draft.content !== 'string') throw new Error('baiyun-post-invalid-draft');
  if (draft.title !== undefined && typeof draft.title !== 'string') throw new Error('baiyun-post-invalid-title');
  if (draft.imageIds.length > 9 || draft.imageIds.some(id => !id.trim())
    || new Set(draft.imageIds).size !== draft.imageIds.length) throw new Error('baiyun-post-invalid-images');
  return { id: draft.id, title: draft.title ?? '', content: draft.content, imageIds: [...draft.imageIds], tagIds: normalizePostTagIds(draft.tagIds) };
}

export function emptyPostDraft(): PostDraft {
  return { id: `post-draft-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`, title: '', content: '', imageIds: [], tagIds: [] };
}

async function readDraft(database: SQLiteDatabase): Promise<PostDraft | null> {
  const row = await database.getFirstAsync<DraftRow>('SELECT * FROM baiyun_post_publish_draft WHERE singleton = 1');
  return row ? snapshot({ id: row.id, title: row.title, content: row.content,
    imageIds: JSON.parse(row.image_ids_json), tagIds: JSON.parse(row.tag_ids_json) }) : null;
}

export function loadPostDraft(): Promise<PostDraft | null> {
  return serialDraft(async () => {
    const database = await getMemoryDatabase();
    await database.execAsync(schema);
    return readDraft(database);
  });
}

async function replaceImageReferences(database: SQLiteDatabase, imageIds: readonly string[]) {
  const current = await database.getAllAsync<{ image_id: string }>('SELECT image_id FROM baiyun_post_image_drafts WHERE draft_key = ?', POST_DRAFT_IMAGE_KEY);
  if (current.length === imageIds.length && current.every(row => imageIds.includes(row.image_id))) return false;
  for (const id of imageIds) {
    if (!await database.getFirstAsync('SELECT id FROM baiyun_post_images WHERE id = ?', id)) {
      throw new Error('baiyun-post-image-missing');
    }
  }
  await database.runAsync('DELETE FROM baiyun_post_image_drafts WHERE draft_key = ?', POST_DRAFT_IMAGE_KEY);
  for (const id of imageIds) {
    await database.runAsync('INSERT INTO baiyun_post_image_drafts(draft_key, image_id) VALUES (?, ?)', POST_DRAFT_IMAGE_KEY, id);
  }
  return current.some(row => !imageIds.includes(row.image_id));
}

// Cleanup is retryable on next open; a file-unlink failure cannot undo a saved draft.
async function collectAfterCommit() {
  await collectUnusedPostImages().catch(() => undefined);
}

/** Call after picker import completes; caller must not save stale imageIds during that import. */
export async function savePostDraft(draft: PostDraft): Promise<void> {
  const value = snapshot(draft); // Snapshot now, not after earlier saves finish.
  return serialDraft(async () => {
    const database = await getMemoryDatabase();
    await database.execAsync(schema);
    await loadPostImageAssets(value.imageIds);
    let removedImages = false;
    await database.withExclusiveTransactionAsync(async transaction => {
      const current = await readDraft(transaction);
      if (current && current.id !== value.id) throw new Error('baiyun-post-draft-stale');
      if (!await transaction.getFirstAsync("SELECT name FROM pragma_table_info('baiyun_post_publish_draft') WHERE name = 'title'")) {
        await transaction.execAsync("ALTER TABLE baiyun_post_publish_draft ADD COLUMN title TEXT NOT NULL DEFAULT ''");
      }
      removedImages = await replaceImageReferences(transaction, value.imageIds);
      await transaction.runAsync(`INSERT INTO baiyun_post_publish_draft(singleton, id, content, image_ids_json, tag_ids_json, title)
        VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
        id = excluded.id, content = excluded.content, image_ids_json = excluded.image_ids_json, tag_ids_json = excluded.tag_ids_json, title = excluded.title`,
      value.id, value.content, JSON.stringify(value.imageIds), JSON.stringify(value.tagIds), value.title ?? '');
    });
    if (removedImages) await collectAfterCommit();
  });
}

/** Publication calls this inside its existing transaction, after attaching the formal image group. */
export async function consumePostDraft(transaction: SQLiteDatabase, id: string): Promise<void> {
  await transaction.execAsync(schema);
  const result = await transaction.runAsync('DELETE FROM baiyun_post_publish_draft WHERE singleton = 1 AND id = ?', id);
  if (result.changes !== 1) throw new Error('baiyun-post-draft-stale');
  await transaction.runAsync('DELETE FROM baiyun_post_image_drafts WHERE draft_key = ?', POST_DRAFT_IMAGE_KEY);
}

export function discardPostDraft(id: string): Promise<void> {
  return serialDraft(async () => {
    const database = await getMemoryDatabase();
    await database.execAsync(schema);
    let removed = false;
    await database.withExclusiveTransactionAsync(async transaction => {
      const current = await readDraft(transaction);
      if (current && current.id !== id) return;
      if (current) await consumePostDraft(transaction, id);
      else await transaction.runAsync('DELETE FROM baiyun_post_image_drafts WHERE draft_key = ?', POST_DRAFT_IMAGE_KEY);
      removed = true;
    });
    if (removed) await collectAfterCommit();
  });
}

/** Page-open recovery only, before picker work: remove imports never saved into this draft. */
export function reconcilePostDraftImages(): Promise<void> {
  return serialDraft(async () => {
    const database = await getMemoryDatabase();
    await database.execAsync(schema);
    const draft = await readDraft(database);
    const reference = await database.getFirstAsync('SELECT image_id FROM baiyun_post_image_drafts WHERE draft_key = ? LIMIT 1', POST_DRAFT_IMAGE_KEY);
    // Opening a text-only/empty draft must not compete for a database write lock.
    if (draft?.imageIds.length || reference) {
      await database.withExclusiveTransactionAsync(async transaction => {
        const current = await readDraft(transaction);
        await replaceImageReferences(transaction, current?.imageIds ?? []);
      });
    }
    await collectAfterCommit();
  });
}
