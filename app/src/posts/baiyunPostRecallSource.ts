import type { SQLiteDatabase } from 'expo-sqlite';
import { stableMemoryHash } from '../memory/memoryAtomicity';
import { getMemoryDatabase } from '../memory/memoryStore';
import { orderPostComments } from './baiyunPostData';
import { ensurePostReadingStarted, selectKnownPostMaterial } from './baiyunPostKnown';
import { buildPostMemoryOriginals, loadPostMemoryKnowledgeSnapshot, type PostMemoryOriginal, type PostMemoryReadOptions } from './baiyunPostMemorySource';
import { postReadRef, type PostKnownMaterial } from './baiyunPostReading';
import { loadLocalBaiyunPost, loadLocalBaiyunPostComments, loadLocalBaiyunPostPage } from './baiyunPostStore';

export type PostRecallReadOptions = PostMemoryReadOptions & { readOnly?: boolean };
export type PostRecallSource = PostMemoryOriginal & { sourceVersion: string; indexText: string; updatedAt: number };
export type PostRecallSnapshot = {
  postId: string; material: PostKnownMaterial; sources: PostRecallSource[]; materialHash: string; updatedAt: number;
};
export type PostSourceIndexSource = {
  id: string; postId: string; messageId: string; content: string; indexText: string; updatedAt: number; sourceHash: string;
};

function check(signal?: AbortSignal) {
  if (signal?.aborted) throw Object.assign(new Error('POST_RECALL_CANCELLED'), { name: 'AbortError' });
}

/** Versions describe current material and qualification, never when it was read again. */
export function createPostRecallSnapshot(material: PostKnownMaterial): PostRecallSnapshot {
  const originals = buildPostMemoryOriginals([material]);
  const ordered = [material.post, ...orderPostComments(material.comments)];
  const sources = ordered.flatMap(item => originals.filter(original => original.messageId === ('source' in item
    ? `comment:${material.post.id}:${item.source}` : `post:${material.post.id}`))).map(original => {
    const item = original.kind === 'post' ? material.post
      : material.comments.find(comment => original.messageId === `comment:${material.post.id}:${comment.source}`)!;
    return { ...original, updatedAt: item.updatedAt, indexText: original.content,
      sourceVersion: stableMemoryHash(JSON.stringify([original.sourceHash, postReadRef(item, material.images)])) };
  });
  const materialHash = stableMemoryHash(JSON.stringify([material.post.id, material.post.author, material.post.createdAt,
    postReadRef(material.post, material.images), material.tags,
    sources.map(source => [source.messageId, source.sourceVersion]) ]));
  return { postId: material.post.id, material: { ...material, comments: orderPostComments(material.comments) }, sources,
    materialHash, updatedAt: Math.max(material.post.updatedAt, ...sources.map(source => source.updatedAt)) };
}

async function context(options: PostRecallReadOptions, postIds?: readonly string[]) {
  check(options.signal);
  const database = (options.database ?? await getMemoryDatabase()) as SQLiteDatabase;
  let knowledge = options.knowledge ?? await loadPostMemoryKnowledgeSnapshot(database, options.signal);
  if (!knowledge.reading && !options.knowledge && !options.database) {
    knowledge = { ...knowledge, reading: await ensurePostReadingStarted(options.readOnly) };
  }
  if (options.database && options.knowledge) {
    const ids = postIds ? [...new Set(postIds)] : undefined;
    const vision = await database.getAllAsync<import('./baiyunPostMemorySource').PostMemoryVisionRow>(
      `SELECT owner_key,group_key,description FROM baiyun_post_image_vision${ids ? ' WHERE post_id IN (SELECT value FROM json_each(?))' : ''}`,
      ...(ids ? [JSON.stringify(ids)] : []));
    knowledge = { reading: knowledge.reading, vision };
  }
  check(options.signal);
  // A source read does not seed tag defaults or open a nested write transaction.
  const table = await database.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='baiyun_post_tags'");
  const tags = table ? await database.getAllAsync<{ id: string; name: string }>(
    'SELECT id,name FROM baiyun_post_tags WHERE merged_into_id IS NULL ORDER BY rowid') : [];
  return { database, knowledge, tags };
}

export async function loadPostRecallSnapshot(postId: string, options: PostRecallReadOptions = {}): Promise<PostRecallSnapshot | null> {
  const { database, knowledge, tags } = await context(options, [postId]);
  const [post, comments] = await Promise.all([loadLocalBaiyunPost(postId, database), loadLocalBaiyunPostComments(postId, database)]);
  check(options.signal);
  if (!post) return null;
  const material = selectKnownPostMaterial(post, comments, knowledge.reading, tags, knowledge.vision);
  return material ? createPostRecallSnapshot(material) : null;
}

export async function listPostRecallSnapshots(options: PostRecallReadOptions = {}): Promise<PostRecallSnapshot[]> {
  const { database, knowledge, tags } = await context(options);
  const page = await loadLocalBaiyunPostPage(database);
  check(options.signal);
  return page.posts.flatMap(post => {
    const material = selectKnownPostMaterial(post, page.comments, knowledge.reading, tags, knowledge.vision);
    return material ? [createPostRecallSnapshot(material)] : [];
  });
}

/** Logical IDs are matched in SQL; colons in either original identity are never parsed heuristically. */
export async function resolvePostSourceIds(ids: readonly string[], options: PostRecallReadOptions = {}): Promise<Map<string, string>> {
  check(options.signal);
  const database = options.database ?? await getMemoryDatabase();
  if (!ids.length) return new Map();
  const rows = await database.getAllAsync<{ id: string; post_id: string }>(
    `SELECT 'post:' || post_id AS id, post_id FROM baiyun_post_metadata
      WHERE 'post:' || post_id IN (SELECT value FROM json_each(?))
     UNION ALL SELECT 'comment:' || post_id || ':' || source AS id, post_id FROM baiyun_post_comment_metadata
      WHERE 'comment:' || post_id || ':' || source IN (SELECT value FROM json_each(?))`, JSON.stringify(ids), JSON.stringify(ids));
  check(options.signal);
  const result = new Map<string, string>();
  for (const row of rows) {
    if (result.has(row.id)) throw new Error('POST_RECALL_SOURCE_CONFLICT');
    result.set(row.id, row.post_id);
  }
  return result;
}

function indexSource(source: PostRecallSource): PostSourceIndexSource {
  return { id: source.messageId, postId: source.postId, messageId: source.messageId, content: source.content,
    indexText: source.content, updatedAt: source.updatedAt, sourceHash: source.sourceVersion };
}
export async function listPostSourceIndexSourcesForPost(postId: string, options: PostRecallReadOptions = {}): Promise<PostSourceIndexSource[]> {
  return (await loadPostRecallSnapshot(postId, options))?.sources.map(indexSource) ?? [];
}
export async function loadPostSourceIndexSources(ids: readonly string[], options: PostRecallReadOptions = {}): Promise<Map<string, PostSourceIndexSource>> {
  const owners = await resolvePostSourceIds(ids, options), wanted = new Set(ids), result = new Map<string, PostSourceIndexSource>();
  for (const postId of new Set(owners.values())) {
    for (const source of await listPostSourceIndexSourcesForPost(postId, options)) if (wanted.has(source.id)) result.set(source.id, source);
  }
  return result;
}
export async function loadPostSourceIndexSource(id: string, options: PostRecallReadOptions = {}): Promise<PostSourceIndexSource | null> {
  return (await loadPostSourceIndexSources([id], options)).get(id) ?? null;
}
export async function listPostSourceIndexSourceKeys(options: PostRecallReadOptions & { after?: { id: string; updatedAt: number }; limit?: number } = {}) {
  return (await listPostRecallSnapshots(options)).flatMap(snapshot => snapshot.sources.map(source => ({ id: source.messageId, updatedAt: source.updatedAt })))
    .filter(key => !options.after || key.updatedAt > options.after.updatedAt || key.updatedAt === options.after.updatedAt && key.id > options.after.id)
    .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, Math.min(1000, options.limit ?? 100)));
}

/** The source write/read receipt is already committed. Indexing failure cannot undo it. */
export function notifyPostRecallSourceChanged(postId: string) {
  void import('../memory/memoryProcessingWorker').then(module => module.queuePostSourceEmbeddings(postId)).catch(() => {
    void import('../memory/memoryProcessingSignals').then(module => module.notifyMemoryProcessingWorkAvailable('memory_changed')).catch(() => undefined);
  });
}
