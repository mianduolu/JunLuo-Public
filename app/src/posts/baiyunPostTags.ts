import type { SQLiteDatabase } from 'expo-sqlite';
import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { runMemoryDuplicateCleanupBusinessWrite } from '../memory/memoryDuplicateCleanupState';
import { getMemoryDatabase } from '../memory/memoryStore';
import { notifyBaiyunPostsChanged } from './baiyunPostStore';
import type { PostAuthor } from './baiyunPostData';

export type PostTag = { id: string; name: string; scope: 'I' | 'you' | 'both' };

export class PostTagNameConflictError extends Error {
  constructor(public readonly targetId: string) {
    super('baiyun-post-tag-name-conflict');
    this.name = 'PostTagNameConflictError';
  }
}

export function tagAllowsAuthor(tag: PostTag, author: PostAuthor) {
  return tag.scope === 'both' || tag.scope === author;
}

function visibleLength(value: string) {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: new (locale?: string, options?: { granularity: string }) => {
    segment(text: string): Iterable<unknown>;
  } }).Segmenter;
  if (Segmenter) return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)).length;
  // Hermes versions without Segmenter: keep combining marks, skin tones, flags,
  // keycaps and joined emoji together instead of counting their UTF-16 units.
  const clusters = value.match(/\p{Regional_Indicator}{2}|(?:[^\p{M}\u200d]|^)[\p{M}\p{Emoji_Modifier}\u{e0020}-\u{e007f}]*(?:\u200d[^\p{M}\u200d][\p{M}\p{Emoji_Modifier}\u{e0020}-\u{e007f}]*)*/gu);
  return clusters?.filter(Boolean).length ?? 0;
}

export function normalizePostTagName(input: string) {
  if (typeof input !== 'string' || /[\r\n\u0085\u2028\u2029]/u.test(input)) throw new Error('baiyun-post-tag-newline');
  const name = input.trim().replace(/^(?:#\s*)+/u, '').trim().normalize('NFC');
  if (!name || !/[^\s\p{M}\p{Cf}]/u.test(name)) throw new Error('baiyun-post-tag-empty');
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(name)) throw new Error('baiyun-post-tag-control');
  if (visibleLength(name) > 12) throw new Error('baiyun-post-tag-too-long');
  return name;
}

function validScope(scope: PostTag['scope']) {
  if (!['I', 'you', 'both'].includes(scope)) throw new Error('baiyun-post-tag-scope');
  return scope;
}

const schema = `
CREATE TABLE IF NOT EXISTS baiyun_post_tags (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('I', 'you', 'both')),
  merged_into_id TEXT,
  merged_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT 0,
  version_id TEXT NOT NULL DEFAULT 'legacy'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_baiyun_post_tags_active_name
  ON baiyun_post_tags(name) WHERE merged_into_id IS NULL;
CREATE TABLE IF NOT EXISTS baiyun_post_tag_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  seeded INTEGER NOT NULL CHECK (seeded = 1)
);`;

async function initializeTags(db: SQLiteDatabase) {
  await db.execAsync(schema);
  if (await db.getFirstAsync('SELECT seeded FROM baiyun_post_tag_settings WHERE singleton = 1')) return;
  for (const [index, name] of ['日常', '感想', '心情', '发现', '两小只'].entries()) {
    const id = `tag_0${index + 1}`;
    await db.runAsync('INSERT OR IGNORE INTO baiyun_post_tags (id, name, scope, updated_at, version_id) VALUES (?, ?, ?, 0, ?)',
      id, name, index === 4 ? 'both' : 'I', `seed:${id}`);
  }
  await db.runAsync('INSERT INTO baiyun_post_tag_settings (singleton, seeded) VALUES (1, 1)');
}

let tagQueue: Promise<unknown> = Promise.resolve();
function withTags<T>(work: (db: SQLiteDatabase) => Promise<T>, notify = true): Promise<T> {
  const epoch = captureBackupRestoreDataEpoch();
  const task = tagQueue.catch(() => undefined).then(async () => {
    const committed = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
      const database = await getMemoryDatabase();
      let result!: T;
      await database.withExclusiveTransactionAsync(async transaction => {
        await initializeTags(transaction);
        result = await work(transaction);
      });
      return result;
    }));
    if (!committed.committed) throw new Error('baiyun-post-stale');
    if (notify) notifyBaiyunPostsChanged();
    return committed.value;
  });
  tagQueue = task;
  return task;
}

export async function loadPostTags(): Promise<PostTag[]> {
  const database = await getMemoryDatabase();
  // A normal page refresh reads the library; only first use needs the seeding transaction.
  if (await database.getFirstAsync("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'baiyun_post_tag_settings'")
    && await database.getFirstAsync('SELECT seeded FROM baiyun_post_tag_settings WHERE singleton = 1')) {
    return database.getAllAsync<PostTag>('SELECT id, name, scope FROM baiyun_post_tags WHERE merged_into_id IS NULL ORDER BY rowid');
  }
  return withTags(db => db.getAllAsync<PostTag>('SELECT id, name, scope FROM baiyun_post_tags WHERE merged_into_id IS NULL ORDER BY rowid'), false);
}

async function requireTag(db: SQLiteDatabase, id: string) {
  const tag = await db.getFirstAsync<PostTag & { updated_at: number }>('SELECT id, name, scope, updated_at FROM baiyun_post_tags WHERE id = ? AND merged_into_id IS NULL', id);
  if (!tag) throw new Error('baiyun-post-tag-missing');
  return tag;
}

async function assertUniqueName(db: SQLiteDatabase, name: string, exceptId?: string) {
  const existing = await db.getFirstAsync<{ id: string }>('SELECT id FROM baiyun_post_tags WHERE name = ? AND merged_into_id IS NULL', name);
  if (existing && existing.id !== exceptId) throw new PostTagNameConflictError(existing.id);
}

function businessStamp(minimum = 0) {
  const at = Math.max(Date.now(), minimum);
  return { at, id: `post-tag-version-${at}-${Math.random().toString(36).slice(2, 10)}` };
}

/** The parent body/author/publication time stay untouched; only tag references change. */
async function changeReferences(db: SQLiteDatabase, fromId: string, replacement: PostTag | null) {
  const rows = await db.getAllAsync<{ post_id: string; author: PostAuthor; tag_ids_json: string }>(
    `SELECT post_id, author, tag_ids_json FROM baiyun_post_metadata
     WHERE EXISTS (SELECT 1 FROM json_each(tag_ids_json) WHERE value = ?)`, fromId);
  for (const row of rows) {
    const ids = JSON.parse(row.tag_ids_json) as string[];
    const next = [...new Set(ids.flatMap(id => id !== fromId ? [id]
      : replacement && tagAllowsAuthor(replacement, row.author) ? [replacement.id] : []))];
    if (JSON.stringify(next) === row.tag_ids_json) continue;
    await db.runAsync('UPDATE baiyun_post_metadata SET tag_ids_json = ? WHERE post_id = ?', JSON.stringify(next), row.post_id);
    await db.runAsync('UPDATE memories SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?', Date.now(), row.post_id);
  }
}

export async function createPostTag(input: string, scope: PostTag['scope']): Promise<PostTag> {
  const name = normalizePostTagName(input);
  validScope(scope);
  return withTags(async db => {
    await assertUniqueName(db, name);
    const tag = { id: `post-tag-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, name, scope };
    const stamp = businessStamp();
    await db.runAsync('INSERT INTO baiyun_post_tags (id, name, scope, updated_at, version_id) VALUES (?, ?, ?, ?, ?)',
      tag.id, tag.name, tag.scope, stamp.at, stamp.id);
    return tag;
  });
}

export async function updatePostTag(id: string, input: string, scope: PostTag['scope']): Promise<PostTag> {
  const name = normalizePostTagName(input);
  validScope(scope);
  return withTags(async db => {
    const previous = await requireTag(db, id);
    await assertUniqueName(db, name, id);
    const tag = { id, name, scope };
    const stamp = businessStamp(previous.updated_at + 1);
    await db.runAsync('UPDATE baiyun_post_tags SET name = ?, scope = ?, updated_at = ?, version_id = ? WHERE id = ?',
      name, scope, stamp.at, stamp.id, id);
    await changeReferences(db, id, tag);
    return tag;
  });
}

export function mergePostTags(fromId: string, toId: string): Promise<PostTag> {
  return withTags(async db => {
    const from = await requireTag(db, fromId);
    const to = await requireTag(db, toId);
    if (fromId === toId) return { id: to.id, name: to.name, scope: to.scope };
    const merged: PostTag = { id: to.id, name: to.name, scope: from.scope === to.scope ? to.scope : 'both' };
    const stamp = businessStamp(Math.max(from.updated_at, to.updated_at) + 1);
    await db.runAsync('UPDATE baiyun_post_tags SET scope = ?, updated_at = ?, version_id = ? WHERE id = ?',
      merged.scope, stamp.at, stamp.id, toId);
    await changeReferences(db, fromId, merged);
    await db.runAsync('UPDATE baiyun_post_tags SET merged_into_id = ?, merged_at = ?, updated_at = ?, version_id = ? WHERE id = ?',
      toId, stamp.at, stamp.at, stamp.id, fromId);
    return merged;
  });
}

export function deletePostTag(id: string): Promise<void> {
  return withTags(async db => {
    if (await db.getFirstAsync('SELECT id FROM baiyun_post_tags WHERE id = ? AND merged_into_id IS NOT NULL', id)) return;
    await changeReferences(db, id, null);
    await db.runAsync('DELETE FROM baiyun_post_tags WHERE id = ? AND merged_into_id IS NULL', id);
  });
}
