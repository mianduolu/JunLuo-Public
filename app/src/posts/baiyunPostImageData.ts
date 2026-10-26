import type { SQLiteDatabase } from 'expo-sqlite';
import { normalizePostBody, type PostImageGroupRef } from './baiyunPostData';

export type PostImageOwner = { postId: string; commentSource: string | null };
export type PostImageReceipt = { owner: PostImageOwner; group: PostImageGroupRef };
export const postImageOwnerKey = (owner: PostImageOwner) => JSON.stringify([owner.postId, owner.commentSource]);
export const postImageGroupKey = (group: PostImageGroupRef) => JSON.stringify([group.id, group.version, group.imageIds]);
export const newPostImageId = () => `post-image-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

export function revisePostImageGroup(previous: PostImageGroupRef | null, imageIds: readonly string[]): PostImageGroupRef | null {
  if (!imageIds.length) return null;
  const unchanged = previous && JSON.stringify(previous.imageIds) === JSON.stringify(imageIds);
  return normalizePostBody({ content: '', imageGroup: {
    id: previous?.id ?? newPostImageId(), version: unchanged ? previous.version : (previous?.version ?? 0) + 1,
    imageIds: [...imageIds],
  } }).imageGroup;
}

// Images have no body copy and no new sync domain. Chapter 7 owns wire / backup mapping.
export const POST_IMAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS baiyun_post_images (
  id TEXT PRIMARY KEY NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, byte_size INTEGER NOT NULL,
  object_id TEXT, chunk_count INTEGER
);
CREATE TABLE IF NOT EXISTS baiyun_post_image_drafts (
  draft_key TEXT NOT NULL, image_id TEXT NOT NULL, PRIMARY KEY (draft_key, image_id)
);
CREATE TABLE IF NOT EXISTS baiyun_post_image_vision (
  owner_key TEXT PRIMARY KEY NOT NULL, post_id TEXT NOT NULL, comment_source TEXT,
  group_key TEXT NOT NULL, description TEXT, failed_before INTEGER NOT NULL DEFAULT 0,
  recovered_pending INTEGER NOT NULL DEFAULT 0, opportunity_id TEXT NOT NULL, opportunity_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE VIEW IF NOT EXISTS baiyun_post_image_references AS
  SELECT j.value AS image_id FROM baiyun_post_metadata p, json_each(p.image_group_json, '$.imageIds') j
  UNION SELECT j.value FROM baiyun_post_comment_metadata c, json_each(c.image_group_json, '$.imageIds') j WHERE c.deleted = 0
  UNION SELECT image_id FROM baiyun_post_image_drafts;
CREATE TRIGGER IF NOT EXISTS baiyun_post_image_post_changed AFTER UPDATE OF image_group_json ON baiyun_post_metadata
  WHEN NEW.image_group_json IS NOT OLD.image_group_json
BEGIN DELETE FROM baiyun_post_image_vision WHERE post_id = OLD.post_id AND comment_source IS NULL; END;
CREATE TRIGGER IF NOT EXISTS baiyun_post_image_post_deleted AFTER DELETE ON baiyun_post_metadata
BEGIN DELETE FROM baiyun_post_image_vision WHERE post_id = OLD.post_id; END;
CREATE TRIGGER IF NOT EXISTS baiyun_post_image_comment_changed AFTER UPDATE OF image_group_json, deleted ON baiyun_post_comment_metadata
  WHEN NEW.image_group_json IS NOT OLD.image_group_json OR NEW.deleted <> OLD.deleted
BEGIN DELETE FROM baiyun_post_image_vision WHERE post_id = OLD.post_id AND comment_source = OLD.source; END;
CREATE TRIGGER IF NOT EXISTS baiyun_post_image_comment_deleted AFTER DELETE ON baiyun_post_comment_metadata
BEGIN DELETE FROM baiyun_post_image_vision WHERE post_id = OLD.post_id AND comment_source = OLD.source; END;
`;

export async function loadPostImageGroup(database: SQLiteDatabase, owner: PostImageOwner): Promise<PostImageGroupRef | null> {
  const row = owner.commentSource === null
    ? await database.getFirstAsync<{ image_group_json: string | null }>(`SELECT p.image_group_json FROM baiyun_post_metadata p
        JOIN memories m ON m.id = p.post_id WHERE p.post_id = ? AND m.type <> 'archived'`, owner.postId)
    : await database.getFirstAsync<{ image_group_json: string | null }>(`SELECT p.image_group_json FROM baiyun_post_comment_metadata p
        JOIN memories m ON m.id = p.post_id JOIN memory_comments c ON c.id = p.current_id AND c.memory_id = p.post_id
        WHERE p.post_id = ? AND p.source = ? AND p.deleted = 0 AND m.type <> 'archived'`, owner.postId, owner.commentSource);
  return row?.image_group_json ? JSON.parse(row.image_group_json) : null;
}

/** Same transaction as the body/association write; cleanup cannot race an unvalidated attachment. */
export async function validatePostImageAttachment(database: SQLiteDatabase, owner: PostImageOwner, group: PostImageGroupRef | null) {
  if (!group) return;
  normalizePostBody({ content: '', imageGroup: group });
  const current = await loadPostImageGroup(database, owner);
  if (current?.id === group.id) {
    const expected = revisePostImageGroup(current, group.imageIds)!;
    if (expected.version !== group.version) throw new Error('baiyun-post-image-version');
  }
  const owners = await database.getAllAsync<{ post_id: string; source: string | null }>(`
    SELECT post_id, NULL AS source FROM baiyun_post_metadata WHERE json_extract(image_group_json, '$.id') = ?
    UNION ALL SELECT post_id, source FROM baiyun_post_comment_metadata WHERE deleted = 0 AND json_extract(image_group_json, '$.id') = ?`, group.id, group.id);
  if (owners.some(row => row.post_id !== owner.postId || row.source !== owner.commentSource)) throw new Error('baiyun-post-image-group-owner');
  for (const id of group.imageIds) {
    if (!await database.getFirstAsync('SELECT id FROM baiyun_post_images WHERE id = ?', id)) throw new Error('baiyun-post-image-missing');
  }
}

/** Called only inside a successfully saving I-comment transaction. Rollback preserves the hint. */
export async function acknowledgePostImageRecovery(database: SQLiteDatabase, postId: string, receipts: readonly PostImageReceipt[]) {
  for (const receipt of receipts) {
    if (receipt.owner.postId !== postId) throw new Error('baiyun-post-image-receipt-owner');
    await database.runAsync(`UPDATE baiyun_post_image_vision SET recovered_pending = 0
      WHERE owner_key = ? AND group_key = ? AND description IS NOT NULL`, postImageOwnerKey(receipt.owner), postImageGroupKey(receipt.group));
  }
}
