import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, DeviceEventEmitter } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';

import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { runMemoryDuplicateCleanupBusinessWrite } from '../memory/memoryDuplicateCleanupState';
import { archiveMemory, createMemory, getMemoryDatabase, hardDeleteMemory, loadMemories, loadMemory, loadMemoryComments, memoryFromRow, updateMemory } from '../memory/memoryStore';
import { BAIYUN_POST_RUNTIME_KEY, BAIYUN_POST_SOURCE, emptyBaiyunPostRuntime, isBaiyunPostMemory,
  type BaiyunPost, type BaiyunPostComment, type BaiyunPostRuntime } from './baiyunPostContract';
import { capturePostReplySnapshot, isPostReplySnapshotCurrent, normalizePostBody, normalizePostTagIds,
  orderPostComments, type PostBody, type PostData, type PostCommentData, type PostReplySnapshot } from './baiyunPostData';
import type { PostMetadata } from './baiyunPostMetadata';
import { parsePostReplyState } from './baiyunPostReplyState';
import { parsePostMemoryRuntimeState } from './baiyunPostMemoryState';
import { recordPostNotificationArrival } from './baiyunPostNotificationData';
import { acknowledgePostImageRecovery, validatePostImageAttachment, type PostImageReceipt } from './baiyunPostImageData';

const CHANGED = 'junluo.baiyunPosts.changed';
let requestedTab: 'posts' | 'letters' | 'notebook' | null = null;
let runtimeWrite = Promise.resolve();

export function requestCorrespondenceTab(tab: 'posts' | 'letters' | 'notebook') { requestedTab = tab; notifyBaiyunPostsChanged(); }
export async function consumeCorrespondenceTab() {
  const tab = requestedTab; requestedTab = null;
  return tab;
}
export function notifyBaiyunPostsChanged() { DeviceEventEmitter.emit(CHANGED); }
function notifyPostRecallSources(postId: string) {
  void import('./baiyunPostRecallSource').then(module => module.notifyPostRecallSourceChanged(postId)).catch(() => undefined);
}
export function subscribeBaiyunPosts(listener: () => void) {
  const subscription = DeviceEventEmitter.addListener(CHANGED, listener);
  return () => subscription.remove();
}

export async function loadBaiyunPostRuntime(): Promise<BaiyunPostRuntime> {
  const raw = await AsyncStorage.getItem(BAIYUN_POST_RUNTIME_KEY);
  if (!raw) return emptyBaiyunPostRuntime();
  try {
    const value = JSON.parse(raw) as BaiyunPostRuntime;
    return { ...emptyBaiyunPostRuntime(),
      attempts: Array.isArray(value.attempts) ? value.attempts.filter(Number.isFinite) : [],
      lastAttemptAt: Number.isFinite(value.lastAttemptAt) ? value.lastAttemptAt : null,
      offeredRefs: Array.isArray(value.offeredRefs) ? value.offeredRefs.filter(ref => typeof ref === 'string') : [],
      stateMaterial: typeof value.stateMaterial === 'string' ? value.stateMaterial : '',
      replyFailures: value.replyFailures && typeof value.replyFailures === 'object' ? value.replyFailures : {},
      sleepingReplies: Object.fromEntries(Object.entries(value.sleepingReplies ?? {}).filter(([, item]) =>
        item && typeof item.postId === 'string' && (!item.content || (typeof item.content === 'string' && typeof item.inputKey === 'string')))),
      replies: parsePostReplyState(value.replies),
      memoryOrganization: parsePostMemoryRuntimeState(value.memoryOrganization),
    };
  } catch (error) {
    if (error instanceof Error && ['baiyun-post-reply-state-invalid', 'baiyun-post-memory-state-invalid'].includes(error.message)) throw error;
    return emptyBaiyunPostRuntime();
  }
}

function writeBaiyunPostRuntime(change: (state: BaiyunPostRuntime) => BaiyunPostRuntime | Promise<BaiyunPostRuntime>, dataEpoch: number | null, capture: boolean) {
  const changedReadingPosts: string[] = [];
  const task = runtimeWrite.catch(() => undefined).then(async () => {
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const current = await loadBaiyunPostRuntime();
      const before = JSON.stringify(current);
      const changed = await change(current), next = JSON.stringify(changed);
      if (next !== before) {
        const readingChanged = JSON.stringify(current.replies?.reading) !== JSON.stringify(changed.replies?.reading);
        const writer = capture && readingChanged ? (await import('../sync/syncMemoryExperienceStorageBridge')).memoryExperienceStorageBridge : AsyncStorage;
        await writer.setItem(BAIYUN_POST_RUNTIME_KEY, next);
        if (readingChanged) {
          const versions = (state: BaiyunPostRuntime, postId: string) => JSON.stringify([...new Set(
            (state.replies?.reading?.rounds ?? []).filter(round => round.postId === postId)
              .flatMap(round => round.refs.map(ref => JSON.stringify(ref))))].sort());
          for (const postId of new Set([...(current.replies?.reading?.rounds ?? []), ...(changed.replies?.reading?.rounds ?? [])].map(round => round.postId))) {
            if (versions(current, postId) !== versions(changed, postId)) changedReadingPosts.push(postId);
          }
        }
      }
    });
    if (!committed.committed) throw new Error('baiyun-post-stale');
  });
  runtimeWrite = task.catch(() => undefined);
  return task.then(() => { for (const postId of changedReadingPosts) notifyPostRecallSources(postId); });
}

export function updateBaiyunPostRuntime(change: (state: BaiyunPostRuntime) => BaiyunPostRuntime, dataEpoch = captureBackupRestoreDataEpoch()) {
  return writeBaiyunPostRuntime(change, dataEpoch, true);
}

/** The existing writer owns both paths. Incoming facts never recapture a packet. */
export async function mergeSyncedBaiyunPostReading(value: import('../sync/syncMemoryExperience').PostReadingSyncValueV1 | null) {
  const sync = await import('../sync/syncMemoryExperience');
  await writeBaiyunPostRuntime(async current => {
    const replies = current.replies ?? { posts: {}, papers: {} };
    if (value === null) { const { reading: _reading, ...kept } = replies; return { ...current, replies: kept }; }
    const database = await getMemoryDatabase();
    const hasLog = await database.getFirstAsync("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_sync_revision_log'");
    const deleted = await database.getAllAsync<{ entity_id: string }>(`SELECT DISTINCT h.entity_id FROM memory_sync_entity_heads h
      LEFT JOIN memory_sync_domain_outbox o ON o.revision_id=h.revision_id
      ${hasLog ? 'LEFT JOIN memory_sync_revision_log r ON r.revision_id=h.revision_id' : ''}
      WHERE h.entity_type='post' AND ${hasLog ? 'COALESCE(r.operation,o.operation)' : 'o.operation'}='delete'`);
    const removed = new Set(deleted.map(row => row.entity_id));
    for (const postId of new Set(value.rounds.map(round => round.postId).filter(id => !removed.has(id)))) {
      const parent = await database.getFirstAsync(`SELECT p.post_id FROM baiyun_post_metadata p
        JOIN memories m ON m.id=p.post_id WHERE p.post_id=?`, postId);
      if (!parent) throw new Error('baiyun-post-reading-parent-pending');
    }
    const merged = sync.mergePostReadingSyncValuesV1(sync.projectPostReadingSyncValueV1(replies.reading), value);
    merged.rounds = merged.rounds.filter(round => !removed.has(round.postId));
    return { ...current, replies: { ...replies, reading: sync.materializePostReadingSyncValueV1(merged) } };
  }, captureBackupRestoreDataEpoch(), false);
}

export async function loadBaiyunPosts(): Promise<BaiyunPost[]> {
  // Legacy model consumers are I-only until chapters 5/6 wire the approved materials.
  const authors = await (await getMemoryDatabase()).getAllAsync<{ post_id: string }>(
    "SELECT post_id FROM baiyun_post_metadata WHERE author = 'you'");
  const youPosts = new Set(authors.map(row => row.post_id));
  return (await loadMemories()).filter(memory => memory.type !== 'archived' && isBaiyunPostMemory(memory))
    .filter(memory => !youPosts.has(memory.id))
    .map(memory => ({ id: memory.id, title: memory.title, content: memory.content, createdAt: memory.createdAt,
      updatedAt: memory.updatedAt, legacy: memory.source !== BAIYUN_POST_SOURCE }))
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
}

/** Select only parents of potentially new conversation records, not the whole memory corpus. */
export async function loadBaiyunPostsForExperience(after: number, ownerId?: string): Promise<BaiyunPost[]> {
  const database = await getMemoryDatabase();
  const parents = ownerId ? [{ memory_id: ownerId }]
    : await database.getAllAsync<{ memory_id: string }>(
      'SELECT DISTINCT memory_id FROM memory_comments WHERE created_at > ?', after);
  const result: BaiyunPost[] = [];
  for (const { memory_id } of parents) {
    if ((await readPostMetadata(memory_id))?.author === 'you') continue;
    const post = await loadMemory(memory_id);
    if (post && post.type !== 'archived' && isBaiyunPostMemory(post)) result.push({ id: post.id,
      title: post.title, content: post.content, createdAt: post.createdAt, updatedAt: post.updatedAt,
      legacy: post.source !== BAIYUN_POST_SOURCE });
  }
  return result;
}

export async function loadBaiyunPostComments(postId: string): Promise<BaiyunPostComment[]> {
  const post = await loadMemory(postId);
  if (!post || post.type === 'archived' || !isBaiyunPostMemory(post)) return [];
  return (await loadMemoryComments(postId)).flatMap(comment => {
    const author = comment.author === 'you' || comment.author === '小仓鼠' ? 'you'
      : comment.author === 'I' || comment.author === '白云小姐' ? 'I' : null;
    if (!author || !['comment', 'feel'].includes(comment.kind)) return [];
    return [{ id: comment.id, postId, source: comment.source ?? `baiyun-post-comment:${comment.id}`, author,
      content: comment.content, createdAt: comment.createdAt } as BaiyunPostComment];
  }).sort((left, right) => left.createdAt - right.createdAt || left.source.localeCompare(right.source));
}

export async function loadBaiyunPostSnapshot() {
  const [posts, runtime] = await Promise.all([loadBaiyunPosts(), loadBaiyunPostRuntime()]);
  const comments = (await Promise.all(posts.map(post => loadBaiyunPostComments(post.id)))).flat();
  return { posts, comments, failures: runtime.replyFailures, sleepingReplies: runtime.sleepingReplies };
}

export async function loadBaiyunPostRecall(query: string, readOnly = false) {
  return (await import('./baiyunPostKnown')).loadKnownPostRecall(query, readOnly);
}

async function writePost(change: () => Promise<void>, dataEpoch = captureBackupRestoreDataEpoch()) {
  const result = await runBackupRestoreDataEpochCommit(dataEpoch, change);
  if (!result.committed) throw new Error('baiyun-post-stale');
  notifyBaiyunPostsChanged();
}

async function cleanupPostImagesAfterWrite() {
  // A filesystem failure must not misreport a committed content edit/deletion as unsaved.
  // The page's next open retries the same narrowly scoped unreferenced-file collection.
  try { await (await import('./baiyunPostImageFiles')).collectUnusedPostImages(); }
  catch { console.warn('baiyun-post-image-cleanup-deferred'); }
}

export async function createBaiyunPost(content: string) {
  return createLocalBaiyunPost({ content, imageGroup: null, author: 'I', tagIds: [] });
}

export async function createLocalBaiyunPost(input: PostBody & PostMetadata) {
  const body = normalizePostBody(input);
  const metadata = { author: input.author, title: input.title ?? '', tagIds: normalizePostTagIds(input.tagIds), imageGroup: body.imageGroup, consumeDraftId: input.consumeDraftId,
    notificationBackground: AppState.currentState === 'background' };
  let id = '';
  await writePost(async () => { id = await createMemory({ title: '', content: body.content, domain: '日常', tags: [], recallCues: [],
    type: 'feel', tier: 'working', semanticType: 'other', source: BAIYUN_POST_SOURCE, period: 'post', sourceType: 'automatic',
    importance: 5, valence: 0.5, arousal: 0.5, pinned: false, resolved: true, anchor: false, digested: false, protected: false },
    { postMetadata: metadata }); });
  notifyPostRecallSources(id);
  return id;
}

export async function editBaiyunPost(id: string, content: string) {
  if (!content.trim()) throw new Error('baiyun-post-empty');
  await writePost(async () => {
    const current = await loadMemory(id);
    if (!current || current.type === 'archived' || !isBaiyunPostMemory(current)) throw new Error('baiyun-post-missing');
    const metadata = await readPostMetadata(id);
    if (!metadata) throw new Error('baiyun-post-missing');
    await updateMemory(id, { ...current, content: content.trim() },
      { postMetadata: metadata, postExpectedUpdatedAt: current.updatedAt, confirmationLevel: current.confirmationLevel });
  });
  notifyPostRecallSources(id);
}
export async function deleteBaiyunPost(id: string) {
  const epoch = captureBackupRestoreDataEpoch();
  await writePost(async () => {
    const current = await loadMemory(id);
    if (!current || !isBaiyunPostMemory(current)) return;
    if (current.type !== 'archived') await archiveMemory(id);
    await hardDeleteMemory(id);
  }, epoch);
  notifyPostRecallSources(id);
  await updateBaiyunPostRuntime(state => ({ ...state,
    replyFailures: Object.fromEntries(Object.entries(state.replyFailures).filter(([, postId]) => postId !== id)),
    sleepingReplies: Object.fromEntries(Object.entries(state.sleepingReplies).filter(([, item]) => item.postId !== id)),
    ...(state.replies ? { replies: { ...state.replies,
      ...(state.replies.reading ? { reading: { ...state.replies.reading, rounds: state.replies.reading.rounds.filter(round => round.postId !== id) } } : {}),
      posts: Object.fromEntries(Object.entries(state.replies.posts).filter(([postId]) => postId !== id)) } } : {}),
  }), epoch);
  await cleanupPostImagesAfterWrite();
}

// Comments are append-only sync entities: edits replace a row in one transaction.
export async function saveBaiyunPostComment(input: { postId: string; author: 'I' | 'you'; content: string; source: string; createdAt?: number;
  imageGroup?: PostBody['imageGroup']; snapshot?: PostReplySnapshot; imageReceipts?: readonly PostImageReceipt[];
  tagSnapshot?: readonly { id: string; name: string; scope: string }[]; dataEpoch?: number | null; notificationGroupKey?: string }, onCommitted?: () => void) {
  const body = normalizePostBody({ content: input.content, imageGroup: input.imageGroup ?? null });
  if (!input.source.trim() || !['I', 'you'].includes(input.author)) throw new Error('baiyun-post-comment-invalid');
  const epoch = input.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : input.dataEpoch;
  const database = await getMemoryDatabase();
  const id = `comment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const createdAt = input.createdAt ?? Date.now();
  let inserted = false;
  const committed = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
    let savedId = id;
    await database.withExclusiveTransactionAsync(async transaction => {
      const parent = await loadLocalBaiyunPost(input.postId, transaction);
      if (!parent) throw new Error('baiyun-post-missing');
      const existing = await transaction.getFirstAsync<{ current_id: string | null; deleted: number; author: string }>(
        'SELECT current_id, deleted, author FROM baiyun_post_comment_metadata WHERE post_id = ? AND source = ?', input.postId, input.source);
      if (existing) {
        if (existing.deleted || !existing.current_id) throw new Error('baiyun-post-comment-deleted');
        if (existing.author !== input.author) throw new Error('baiyun-post-comment-source-conflict');
        savedId = existing.current_id; return;
      }
      if (input.snapshot && (input.snapshot.postId !== input.postId || !isPostReplySnapshotCurrent(input.snapshot,
        parent, await loadLocalBaiyunPostComments(input.postId, transaction)))) throw new Error('baiyun-post-stale');
      if (input.tagSnapshot) {
        for (const tag of input.tagSnapshot) {
          const current = await transaction.getFirstAsync<{ name: string; scope: string }>(
            'SELECT name, scope FROM baiyun_post_tags WHERE id = ? AND merged_into_id IS NULL', tag.id);
          if (!current || current.name !== tag.name || current.scope !== tag.scope) throw new Error('baiyun-post-stale');
        }
      }
      await validatePostImageAttachment(transaction, { postId: input.postId, commentSource: input.source }, body.imageGroup);
      await transaction.runAsync("INSERT INTO memory_comments (id, memory_id, content, source_type, kind, author, valence, arousal, source, created_at) VALUES (?, ?, ?, 'chat', 'comment', ?, NULL, NULL, ?, ?)",
        id, input.postId, body.content, input.author, input.source, createdAt);
      await transaction.runAsync('UPDATE baiyun_post_comment_metadata SET image_group_json = ? WHERE post_id = ? AND source = ?',
        body.imageGroup ? JSON.stringify(body.imageGroup) : null, input.postId, input.source);
      if (input.imageReceipts?.length) {
        if (input.author !== 'I' || !input.snapshot) throw new Error('baiyun-post-image-receipt-without-reply');
        const seenSources = new Set(input.snapshot.comments.map(comment => comment.source));
        if (input.imageReceipts.some(receipt => receipt.owner.commentSource !== null && !seenSources.has(receipt.owner.commentSource))) {
          throw new Error('baiyun-post-image-receipt-outside-input');
        }
        await acknowledgePostImageRecovery(transaction, input.postId, input.imageReceipts);
      }
      inserted = true;
      if (input.author === 'I') await recordPostNotificationArrival(transaction, input.postId, input.source,
        input.notificationGroupKey ?? input.source, AppState.currentState === 'background');
    });
    return savedId;
  }));
  if (!committed.committed) throw new Error('baiyun-post-stale');
  // Let the composer release its saved draft before list refresh and auxiliary bookkeeping.
  onCommitted?.();
  notifyBaiyunPostsChanged();
  if (inserted) notifyPostRecallSources(input.postId);
  if (inserted && input.author === 'you') {
    await (await import('../life/junluoDesireRuntime')).noteJunluoYouMessage(createdAt);
  }
  return committed.value;
}

export async function editBaiyunPostComment(id: string, content: string) {
  if (!content.trim()) throw new Error('baiyun-post-comment-empty');
  let postId: string | undefined;
  await writePost(() => runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    await database.withExclusiveTransactionAsync(async (database) => {
      const row = await database.getFirstAsync<{ memory_id: string; source: string | null; author: string; created_at: number }>('SELECT memory_id, source, author, created_at FROM memory_comments WHERE id = ?', id);
      if (!row) throw new Error('baiyun-post-comment-missing');
      postId = row.memory_id;
      const parentRow = await database.getFirstAsync<Parameters<typeof memoryFromRow>[0]>('SELECT * FROM memories WHERE id = ?', row.memory_id);
      const parent = parentRow ? memoryFromRow(parentRow) : null;
      if (!parent || parent.type === 'archived' || !isBaiyunPostMemory(parent)) throw new Error('baiyun-post-missing');
      const replacementId = `comment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await database.runAsync(`INSERT INTO memory_comments (id, memory_id, content, source_type, kind, author, valence, arousal, source, created_at)
        SELECT ?, memory_id, ?, source_type, kind, author, valence, arousal, COALESCE(source, ?), created_at FROM memory_comments WHERE id = ?`,
        replacementId, content.trim(), `baiyun-post-comment:${id}`, id);
      await database.runAsync('UPDATE baiyun_post_comment_metadata SET current_id = ?, updated_at = MAX(updated_at + 1, ?) WHERE post_id = ? AND current_id = ?',
        replacementId, Date.now(), row.memory_id, id);
      await database.runAsync('DELETE FROM memory_comments WHERE id = ?', id);
    });
  }));
  if (postId) notifyPostRecallSources(postId);
}

export async function deleteBaiyunPostComment(id: string) {
  let postId: string | undefined;
  await writePost(() => runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    const row = await database.getFirstAsync<{ memory_id: string }>('SELECT memory_id FROM memory_comments WHERE id = ?', id);
    if (!row) return;
    postId = row.memory_id;
    const post = await loadMemory(row.memory_id);
    if (!post || !isBaiyunPostMemory(post)) throw new Error('baiyun-post-missing');
    await database.runAsync('DELETE FROM memory_comments WHERE id = ?', id);
  }));
  if (postId) notifyPostRecallSources(postId);
  await cleanupPostImagesAfterWrite();
}

async function readPostMetadata(id: string): Promise<PostMetadata | null> {
  const row = await (await getMemoryDatabase()).getFirstAsync<{
    author: 'I' | 'you'; title?: string | null; tag_ids_json: string; image_group_json: string | null;
  }>('SELECT * FROM baiyun_post_metadata WHERE post_id = ?', id);
  return row ? { author: row.author, title: row.title ?? undefined, tagIds: JSON.parse(row.tag_ids_json),
    imageGroup: row.image_group_json ? JSON.parse(row.image_group_json) : null } : null;
}

type LocalPostRow = {
  post_id: string;
  content: string; created_at: number; updated_at: number; source: string; period: string; tags_json: string;
  author: 'I' | 'you'; title?: string | null; tag_ids_json: string; image_group_json: string | null;
  content_version?: number;
};
function localPostFromRow(row: LocalPostRow): PostData | null {
  let tags: string[] = [];
  try {
    const value: unknown = JSON.parse(row.tags_json);
    if (Array.isArray(value)) tags = value.filter((tag): tag is string => typeof tag === 'string');
  } catch { /* Match the legacy memory reader's empty-tag fallback. */ }
  if (!isBaiyunPostMemory({ source: row.source, period: row.period, tags })) return null;
  return { id: row.post_id, title: row.title ?? undefined, content: row.content, createdAt: row.created_at, updatedAt: row.updated_at,
    contentVersion: row.content_version ?? 0,
    author: row.author, tagIds: JSON.parse(row.tag_ids_json), imageGroup: row.image_group_json ? JSON.parse(row.image_group_json) : null };
}

/** New local consumers use explicit authors. Old model consumers remain on the I-only adapter. */
export async function loadLocalBaiyunPost(id: string, database?: SQLiteDatabase): Promise<PostData | null> {
  const connection = database ?? await getMemoryDatabase();
  const row = await connection.getFirstAsync<LocalPostRow & { legacy_title: string }>(`SELECT m.content, m.created_at, m.updated_at, m.source, m.period, m.tags_json, m.title AS legacy_title,
      p.*, COALESCE(v.version, 0) AS content_version FROM memories m
    JOIN baiyun_post_metadata p ON p.post_id = m.id LEFT JOIN baiyun_post_content_versions v ON v.post_id = p.post_id
    WHERE m.id = ? AND m.type <> 'archived'`, id);
  const post = row ? localPostFromRow(row) : null;
  return post && row ? { ...post, title: post.title ?? (row.source !== BAIYUN_POST_SOURCE ? row.legacy_title : '') } : null;
}

/** UI-only batch read: three queries, no full memory corpus or query per post. */
export async function loadLocalBaiyunPostPage(connection?: SQLiteDatabase): Promise<{ posts: PostData[]; comments: PostCommentData[] }> {
  const database = connection ?? await getMemoryDatabase();
  const rows = await database.getAllAsync<LocalPostRow & { legacy_title: string }>(`SELECT
    m.content, m.created_at, m.updated_at, m.source, m.period, m.tags_json, m.title AS legacy_title, p.*, COALESCE(v.version, 0) AS content_version
    FROM baiyun_post_metadata p JOIN memories m ON m.id = p.post_id LEFT JOIN baiyun_post_content_versions v ON v.post_id = p.post_id
    WHERE m.type <> 'archived'`);
  const posts = rows.flatMap(row => {
    const post = localPostFromRow(row);
    return post ? [{ ...post, title: post.title ?? (row.source !== BAIYUN_POST_SOURCE ? row.legacy_title : '') }] : [];
  }).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  if (!posts.length) return { posts, comments: [] };
  const ids = new Set(posts.map(post => post.id));
  const conflicts = await database.getAllAsync<{ memory_id: string }>(`SELECT c.memory_id FROM memory_comments c
    JOIN baiyun_post_metadata p ON p.post_id = c.memory_id
    WHERE c.kind IN ('comment', 'feel') AND c.author IN ('I', 'you', '白云小姐', '小仓鼠')
    GROUP BY c.memory_id, COALESCE(c.source, 'baiyun-post-comment:' || c.id) HAVING COUNT(*) > 1`);
  if (conflicts.some(row => ids.has(row.memory_id))) throw new Error('baiyun-post-comment-source-conflict');
  const comments = await database.getAllAsync<LocalCommentRow & { post_id: string }>(`SELECT m.*, c.content
    FROM baiyun_post_comment_metadata m LEFT JOIN memory_comments c ON c.id = m.current_id AND c.memory_id = m.post_id`);
  return { posts, comments: orderPostComments(comments.filter(row => ids.has(row.post_id))
    .map(row => localCommentFromRow(row.post_id, row))) };
}

export async function loadLocalBaiyunPosts(): Promise<PostData[]> {
  const database = await getMemoryDatabase();
  const rows = await database.getAllAsync<{ post_id: string }>('SELECT post_id FROM baiyun_post_metadata');
  const posts = await Promise.all(rows.map(row => loadLocalBaiyunPost(row.post_id)));
  return posts.filter((post): post is PostData => post !== null)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

type LocalCommentRow = {
  source: string; current_id: string | null; author: 'I' | 'you'; created_at: number; updated_at: number;
  deleted: number; image_group_json: string | null; content: string | null;
};
function localCommentFromRow(postId: string, row: LocalCommentRow): PostCommentData {
  if (!row.deleted && row.content === null) throw new Error('baiyun-post-comment-source-conflict');
  return { source: row.source, storageId: row.current_id ?? '', postId, author: row.author,
    createdAt: row.created_at, updatedAt: row.updated_at, deleted: Boolean(row.deleted),
    content: row.deleted ? '' : row.content!,
    imageGroup: !row.deleted && row.image_group_json ? JSON.parse(row.image_group_json) : null };
}

export async function loadLocalBaiyunPostComments(postId: string, connection?: SQLiteDatabase): Promise<PostCommentData[]> {
  const database = connection ?? await getMemoryDatabase();
  if (!await loadLocalBaiyunPost(postId, database)) return [];
  // Existing wire IDs cannot resolve two concurrent replacements of one logical comment.
  // Do not silently choose one; chapter 7 owns cross-device version resolution.
  const conflict = await database.getFirstAsync(`SELECT source FROM memory_comments
    WHERE memory_id = ? AND kind IN ('comment', 'feel') AND author IN ('I', 'you', '白云小姐', '小仓鼠')
    GROUP BY COALESCE(source, 'baiyun-post-comment:' || id) HAVING COUNT(*) > 1`, postId);
  if (conflict) throw new Error('baiyun-post-comment-source-conflict');
  const rows = await database.getAllAsync<LocalCommentRow>(`SELECT m.*, c.content FROM baiyun_post_comment_metadata m
    LEFT JOIN memory_comments c ON c.id = m.current_id AND c.memory_id = m.post_id
    WHERE m.post_id = ?`, postId);
  return orderPostComments(rows.map(row => localCommentFromRow(postId, row)));
}

export async function editLocalBaiyunPost(id: string, body: PostBody & { title?: string }, mode: 'edit' | 'repair', tagIds?: readonly string[]) {
  const normalized = normalizePostBody(body);
  await writePost(async () => {
    const current = await loadLocalBaiyunPost(id);
    const memory = await loadMemory(id);
    if (!current || !memory) throw new Error('baiyun-post-missing');
    if (current.author !== (mode === 'edit' ? 'you' : 'I')) throw new Error('baiyun-post-wrong-edit-mode');
    await updateMemory(id, { ...memory, content: normalized.content }, {
      postMetadata: { author: current.author, title: body.title, tagIds: tagIds === undefined ? current.tagIds : normalizePostTagIds(tagIds), imageGroup: normalized.imageGroup },
      postExpectedUpdatedAt: current.updatedAt,
      confirmationLevel: memory.confirmationLevel,
    });
  });
  notifyPostRecallSources(id);
  await cleanupPostImagesAfterWrite();
}

export async function setLocalBaiyunPostTags(id: string, tagIds: readonly string[]) {
  const normalized = normalizePostTagIds(tagIds);
  await writePost(async () => {
    const current = await loadLocalBaiyunPost(id);
    const memory = await loadMemory(id);
    if (!current || !memory) throw new Error('baiyun-post-missing');
    await updateMemory(id, memory, { postMetadata: { ...current, tagIds: normalized }, postExpectedUpdatedAt: current.updatedAt,
      confirmationLevel: memory.confirmationLevel });
  });
  notifyPostRecallSources(id);
}

/** Stable (postId, source) API; replacing the physical append-only row never changes identity. */
export async function editLocalBaiyunPostComment(postId: string, source: string, body: PostBody, mode: 'edit' | 'repair') {
  const normalized = normalizePostBody(body);
  await writePost(() => runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    await database.withExclusiveTransactionAsync(async transaction => {
      const comments = await loadLocalBaiyunPostComments(postId, transaction);
      const current = comments.find(comment => comment.source === source && !comment.deleted);
      if (!current) throw new Error('baiyun-post-comment-missing');
      if (current.author !== (mode === 'edit' ? 'you' : 'I')) throw new Error('baiyun-post-wrong-edit-mode');
      await validatePostImageAttachment(transaction, { postId, commentSource: source }, normalized.imageGroup);
      const replacementId = `comment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await transaction.runAsync(`INSERT INTO memory_comments (id, memory_id, content, source_type, kind, author, valence, arousal, source, created_at)
        SELECT ?, memory_id, ?, source_type, kind, author, valence, arousal, ?, created_at FROM memory_comments WHERE id = ?`,
        replacementId, normalized.content, source, current.storageId);
      await transaction.runAsync(`UPDATE baiyun_post_comment_metadata SET current_id = ?, updated_at = ?, image_group_json = ?
        WHERE post_id = ? AND source = ?`, replacementId, Math.max(Date.now(), current.updatedAt + 1),
        normalized.imageGroup ? JSON.stringify(normalized.imageGroup) : null, postId, source);
      await transaction.runAsync('DELETE FROM memory_comments WHERE id = ?', current.storageId);
    });
  }));
  notifyPostRecallSources(postId);
  await cleanupPostImagesAfterWrite();
}

export async function deleteLocalBaiyunPostComment(postId: string, source: string) {
  const epoch = captureBackupRestoreDataEpoch();
  await writePost(() => runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    await database.withExclusiveTransactionAsync(async transaction => {
      const current = (await loadLocalBaiyunPostComments(postId, transaction)).find(comment => comment.source === source && !comment.deleted);
      if (!current) return;
      if (current.author !== 'you') throw new Error('baiyun-post-wrong-delete-author');
      await transaction.runAsync('DELETE FROM memory_comments WHERE id = ?', current.storageId);
    });
  }), epoch);
  notifyPostRecallSources(postId);
  await updateBaiyunPostRuntime(state => {
    const replyFailures = { ...state.replyFailures };
    if (replyFailures[source] === postId) delete replyFailures[source];
    const sleepingReplies = { ...state.sleepingReplies };
    if (sleepingReplies[source]?.postId === postId) delete sleepingReplies[source];
    return { ...state, replyFailures, sleepingReplies };
  }, epoch);
  await cleanupPostImagesAfterWrite();
}

export async function captureLocalBaiyunPostReply(postId: string, sources: readonly string[]) {
  const post = await loadLocalBaiyunPost(postId);
  if (!post) throw new Error('baiyun-post-missing');
  const comments = await loadLocalBaiyunPostComments(postId);
  const selected = sources.map(source => {
    const comment = comments.find(item => item.source === source && !item.deleted);
    if (!comment) throw new Error('baiyun-post-comment-missing');
    return comment;
  });
  return capturePostReplySnapshot(post, selected);
}
