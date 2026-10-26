import type { SQLiteDatabase } from 'expo-sqlite';
import { normalizePostBody, normalizePostTagIds, type PostAuthor, type PostImageGroupRef } from './baiyunPostData';
import { POST_IMAGE_SCHEMA_SQL, validatePostImageAttachment } from './baiyunPostImageData';
import { POST_NOTIFICATION_SCHEMA_SQL, recordPostNotificationArrival } from './baiyunPostNotificationData';

export type PostMetadata = { author: PostAuthor; title?: string; tagIds: string[]; imageGroup: PostImageGroupRef | null; consumeDraftId?: string; notificationBackground?: boolean };

const postPredicate = `(source IN ('baiyun-post', 'baiyun-reflection') OR period = 'reflection'
  OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(tags_json) THEN
    CASE WHEN json_type(tags_json) = 'array' THEN tags_json ELSE '[]' END ELSE '[]' END)
    WHERE value IN ('白云心声', '白云沉淀')))`;

/** Domain metadata only: bodies remain in memories / memory_comments. Wire schema is unchanged. */
export const POST_METADATA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS baiyun_post_metadata (
  post_id TEXT PRIMARY KEY NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('I', 'you')),
  tag_ids_json TEXT NOT NULL DEFAULT '[]',
  image_group_json TEXT,
  title TEXT
);
CREATE TABLE IF NOT EXISTS baiyun_post_comment_metadata (
  post_id TEXT NOT NULL,
  source TEXT NOT NULL,
  current_id TEXT,
  author TEXT NOT NULL CHECK (author IN ('I', 'you')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  image_group_json TEXT,
  PRIMARY KEY (post_id, source)
);
CREATE TABLE IF NOT EXISTS baiyun_post_content_versions (
  post_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS baiyun_post_body_version AFTER UPDATE OF content, title ON memories
  WHEN (NEW.content IS NOT OLD.content OR NEW.title IS NOT OLD.title)
    AND EXISTS (SELECT 1 FROM baiyun_post_metadata WHERE post_id = NEW.id)
BEGIN
  INSERT INTO baiyun_post_content_versions(post_id, version) VALUES (NEW.id, 1)
    ON CONFLICT(post_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS baiyun_post_material_version AFTER UPDATE OF image_group_json ON baiyun_post_metadata
  WHEN NEW.image_group_json IS NOT OLD.image_group_json
BEGIN
  INSERT INTO baiyun_post_content_versions(post_id, version) VALUES (NEW.post_id, 1)
    ON CONFLICT(post_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS baiyun_post_title_version AFTER UPDATE OF title ON baiyun_post_metadata
  WHEN NEW.title IS NOT OLD.title
BEGIN
  INSERT INTO baiyun_post_content_versions(post_id, version) VALUES (NEW.post_id, 1)
    ON CONFLICT(post_id) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER IF NOT EXISTS baiyun_post_version_deleted AFTER DELETE ON baiyun_post_metadata
BEGIN DELETE FROM baiyun_post_content_versions WHERE post_id = OLD.post_id; END;
INSERT OR IGNORE INTO baiyun_post_metadata(post_id, author)
  SELECT id, 'I' FROM memories WHERE ${postPredicate};
INSERT OR IGNORE INTO baiyun_post_comment_metadata(post_id, source, current_id, author, created_at, updated_at)
  SELECT c.memory_id, COALESCE(c.source, 'baiyun-post-comment:' || c.id), c.id,
    CASE WHEN c.author IN ('you', '小仓鼠') THEN 'you' ELSE 'I' END, c.created_at, c.created_at
  FROM memory_comments c JOIN baiyun_post_metadata p ON p.post_id = c.memory_id
  WHERE c.author IN ('I', 'you', '白云小姐', '小仓鼠') AND c.kind IN ('comment', 'feel')
  ORDER BY c.created_at, c.id;
CREATE TRIGGER IF NOT EXISTS baiyun_post_metadata_insert AFTER INSERT ON memories
  WHEN ${postPredicate.replace(/\b(source|period|tags_json)\b/g, 'NEW.$1')}
BEGIN
  INSERT OR IGNORE INTO baiyun_post_metadata(post_id, author) VALUES (NEW.id, 'I');
END;
DROP TRIGGER IF EXISTS baiyun_post_metadata_delete;
CREATE TRIGGER IF NOT EXISTS baiyun_post_metadata_delete BEFORE DELETE ON memories
BEGIN
  DELETE FROM baiyun_post_comment_metadata WHERE post_id = OLD.id;
  DELETE FROM baiyun_post_metadata WHERE post_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS baiyun_post_comment_metadata_insert AFTER INSERT ON memory_comments
  WHEN EXISTS (SELECT 1 FROM baiyun_post_metadata WHERE post_id = NEW.memory_id)
    AND NEW.author IN ('I', 'you', '白云小姐', '小仓鼠') AND NEW.kind IN ('comment', 'feel')
BEGIN
  INSERT OR IGNORE INTO baiyun_post_comment_metadata(post_id, source, current_id, author, created_at, updated_at)
    VALUES (NEW.memory_id, COALESCE(NEW.source, 'baiyun-post-comment:' || NEW.id), NEW.id,
      CASE WHEN NEW.author IN ('you', '小仓鼠') THEN 'you' ELSE 'I' END, NEW.created_at, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS baiyun_post_comment_metadata_delete AFTER DELETE ON memory_comments
BEGIN
  UPDATE baiyun_post_comment_metadata SET current_id = NULL, deleted = 1, image_group_json = NULL,
    updated_at = MAX(updated_at + 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
    WHERE post_id = OLD.memory_id AND current_id = OLD.id;
END;
${POST_IMAGE_SCHEMA_SQL}
${POST_NOTIFICATION_SCHEMA_SQL}
`;

/** Runs inside the existing memory transaction, so metadata failure rolls back the body too. */
export async function writePostMetadata(database: SQLiteDatabase, id: string, metadata: PostMetadata, creating = false) {
  if (metadata.author !== 'I' && metadata.author !== 'you') throw new Error('baiyun-post-invalid-author');
  const row = await database.getFirstAsync<{ post_id: string; author: string; content: string }>(
    'SELECT p.post_id, p.author, m.content FROM baiyun_post_metadata p JOIN memories m ON m.id = p.post_id WHERE p.post_id = ?', id);
  if (!row) throw new Error('baiyun-post-missing');
  if (!creating && row.author !== metadata.author) throw new Error('baiyun-post-author-immutable');
  normalizePostBody({ content: row.content, imageGroup: metadata.imageGroup });
  await validatePostImageAttachment(database, { postId: id, commentSource: null }, metadata.imageGroup);
  await database.runAsync('UPDATE baiyun_post_metadata SET author = ?, tag_ids_json = ?, image_group_json = ? WHERE post_id = ?',
    metadata.author, JSON.stringify(normalizePostTagIds(metadata.tagIds)),
    metadata.imageGroup ? JSON.stringify(metadata.imageGroup) : null, id);
  if (metadata.title !== undefined) {
    if (typeof metadata.title !== 'string') throw new Error('baiyun-post-invalid-title');
    // Upgrade old databases only when writing a title, inside the same content transaction.
    if (!await database.getFirstAsync("SELECT name FROM pragma_table_info('baiyun_post_metadata') WHERE name = 'title'")) {
      await database.execAsync('ALTER TABLE baiyun_post_metadata ADD COLUMN title TEXT');
    }
    await database.runAsync('UPDATE baiyun_post_metadata SET title = ? WHERE post_id = ?', metadata.title.trim(), id);
  }
  if (metadata.consumeDraftId) {
    if (!creating || metadata.author !== 'you') throw new Error('baiyun-post-draft-invalid-publication');
    await (await import('./baiyunPostDraft')).consumePostDraft(database, metadata.consumeDraftId);
  }
  if (creating && metadata.author === 'I' && metadata.notificationBackground !== undefined) {
    await recordPostNotificationArrival(database, id, '', `post:${id}`, metadata.notificationBackground);
  }
}
