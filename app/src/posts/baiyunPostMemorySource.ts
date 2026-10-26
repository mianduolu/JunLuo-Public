import type { SQLiteDatabase } from 'expo-sqlite';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { stableMemoryHash } from '../memory/memoryAtomicity';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { orderPostComments, type PostCommentData, type PostData } from './baiyunPostData';
import { selectKnownPostMaterial } from './baiyunPostKnown';
import { knownPostImageLine, postReadRef, type PostKnownMaterial, type PostReadingState } from './baiyunPostReading';

const PREFIX = 'post-source:';
export type PostMemoryOriginal = {
  postId: string; sessionId: string; messageId: string; kind: 'post' | 'comment';
  role: 'I' | 'you'; content: string; createdAt: number; availableAt: number; sourceHash: string;
};
export type PostMaterialRange = {
  sessionId: string; messageId: string; sourceHash: string; start: number; end: number;
};
export type PostMaterialBinding = PostMaterialRange & {
  version: 1; postId: string; sentHash: string; purpose: 'new' | 'context';
};
export type PostMemoryMessage = SubjectiveMessage;
export type PostMemoryVisionRow = { owner_key: string; group_key: string; description: string | null };
export type PostMemoryKnowledgeSnapshot = { reading?: PostReadingState; vision: PostMemoryVisionRow[] };
export type PostMemoryReadOptions = {
  database?: Pick<SQLiteDatabase, 'getFirstAsync' | 'getAllAsync'>;
  signal?: AbortSignal;
  /** Capture before a memory transaction. Passing this prevents AsyncStorage reads while holding its lock. */
  knowledge?: PostMemoryKnowledgeSnapshot;
};

export function isPostMemorySource(sessionId: string): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith(PREFIX) && sessionId.length > PREFIX.length;
}
export function postMemorySourceSessionId(postId: string): string {
  if (typeof postId !== 'string' || !postId) throw new Error('POST_MEMORY_SOURCE_INVALID');
  return `${PREFIX}${postId}`;
}
export function getPostMemoryMessageId(postId: string, commentSource?: string): string {
  // Include the parent even for legacy comment sources that may repeat in different posts.
  return commentSource === undefined ? `post:${postId}` : `comment:${postId}:${commentSource}`;
}

function original(material: PostKnownMaterial, item: PostData | PostCommentData): PostMemoryOriginal | null {
  const isComment = 'source' in item;
  if (isComment && (item.deleted || item.postId !== material.post.id)) return null;
  const imageText = item.imageGroup && material.images[item.imageGroup.id]
    ? knownPostImageLine(item, material.images) : '';
  const content = [!isComment ? material.post.title ?? '' : '', item.content, imageText].filter(Boolean).join('\n\n');
  if (!content.trim()) return null;
  const sessionId = postMemorySourceSessionId(material.post.id);
  const messageId = getPostMemoryMessageId(material.post.id, isComment ? item.source : undefined);
  const ref = postReadRef(item, material.images);
  const reads = material.readings.filter(round => round.refs.some(known => known.source === ref.source
    && known.revision === ref.revision && (!imageText || known.image === ref.image))).map(round => round.at);
  // Late reading / editing is queued by availability, never by an old chat bookmark.
  const imageReads = imageText ? material.readings.filter(round => round.refs.some(known =>
    known.source === ref.source && known.image === ref.image)).map(round => round.at) : [];
  const availableAt = item.author === 'you' && reads.length ? Math.min(...reads)
    : Math.max(item.createdAt, item.updatedAt, imageReads.length ? Math.min(...imageReads) : 0);
  return { postId: material.post.id, sessionId, messageId, kind: isComment ? 'comment' : 'post',
    role: item.author, content, createdAt: item.createdAt, availableAt,
    sourceHash: stableMemoryHash(JSON.stringify([sessionId, messageId, item.author, item.createdAt,
      !isComment ? material.post.title ?? '' : '', item.content,
      imageText ? [item.imageGroup, imageText] : null])),
  };
}

/** Only accept materials already selected by the existing actual-reading rule. */
export function buildPostMemoryOriginals(materials: readonly PostKnownMaterial[]): PostMemoryOriginal[] {
  const result = materials.flatMap(material => [material.post, ...orderPostComments(material.comments)]
    .flatMap(item => { const message = original(material, item); return message ? [message] : []; }));
  const identities = result.map(item => JSON.stringify([item.sessionId, item.messageId]));
  if (new Set(identities).size !== identities.length) throw new Error('POST_MEMORY_SOURCE_CONFLICT');
  return result.sort((a, b) => a.availableAt - b.availableAt || a.createdAt - b.createdAt
    || a.postId.localeCompare(b.postId) || a.messageId.localeCompare(b.messageId));
}

function assertPostMemoryReadCurrent(signal?: AbortSignal) {
  if (signal?.aborted) throw Object.assign(new Error('POST_MEMORY_READ_CANCELLED'), { name: 'AbortError' });
}

export async function loadPostMemoryKnowledgeSnapshot(database?: PostMemoryReadOptions['database'], signal?: AbortSignal): Promise<PostMemoryKnowledgeSnapshot> {
  assertPostMemoryReadCurrent(signal);
  const [{ getMemoryDatabase }, { loadBaiyunPostRuntime }] = await Promise.all([
    import('../memory/memoryStore'), import('./baiyunPostStore'),
  ]);
  assertPostMemoryReadCurrent(signal);
  const connection = database ?? await getMemoryDatabase();
  assertPostMemoryReadCurrent(signal);
  const [runtime, vision] = await Promise.all([loadBaiyunPostRuntime(),
    connection.getAllAsync<PostMemoryVisionRow>('SELECT owner_key, group_key, description FROM baiyun_post_image_vision')]);
  assertPostMemoryReadCurrent(signal);
  return { reading: runtime.replies?.reading, vision };
}

/** One shared snapshot per post; no scan of the formal memory corpus and no reads per message. */
export async function loadPostMemoryOriginals(postIds?: readonly string[], options: PostMemoryReadOptions = {}): Promise<PostMemoryOriginal[]> {
  assertPostMemoryReadCurrent(options.signal);
  if (postIds?.length === 0) return [];
  const [{ getMemoryDatabase }, store] = await Promise.all([import('../memory/memoryStore'), import('./baiyunPostStore')]);
  assertPostMemoryReadCurrent(options.signal);
  const database = options.database ?? await getMemoryDatabase();
  assertPostMemoryReadCurrent(options.signal);
  let knowledge = options.knowledge ?? await loadPostMemoryKnowledgeSnapshot(database, options.signal);
  assertPostMemoryReadCurrent(options.signal);
  if (options.knowledge && options.database) {
    // Reading is an AsyncStorage snapshot; picture descriptions remain in this SQLite transaction.
    // Recheck their current rows instead of certifying an older preflight image cache.
    const ids = postIds === undefined ? undefined : [...new Set(postIds)];
    const vision = ids?.length === 0 ? [] : await database.getAllAsync<PostMemoryVisionRow>(
      `SELECT owner_key, group_key, description FROM baiyun_post_image_vision${ids ? ` WHERE post_id IN (${ids.map(() => '?').join(',')})` : ''}`,
      ...(ids ?? []));
    assertPostMemoryReadCurrent(options.signal);
    knowledge = { reading: knowledge.reading, vision };
  }
  const materials: PostKnownMaterial[] = [];
  if (postIds === undefined) {
    const page = await store.loadLocalBaiyunPostPage();
    assertPostMemoryReadCurrent(options.signal);
    for (const post of page.posts) {
      const material = selectKnownPostMaterial(post, page.comments, knowledge.reading, [], knowledge.vision);
      if (material) materials.push(material);
    }
  } else {
    for (const id of new Set(postIds)) {
      assertPostMemoryReadCurrent(options.signal);
      const [post, comments] = await Promise.all([store.loadLocalBaiyunPost(id, database as SQLiteDatabase),
        store.loadLocalBaiyunPostComments(id, database as SQLiteDatabase)]);
      assertPostMemoryReadCurrent(options.signal);
      if (!post) continue;
      const material = selectKnownPostMaterial(post, comments, knowledge.reading, [], knowledge.vision);
      if (material) materials.push(material);
    }
  }
  return buildPostMemoryOriginals(materials);
}

export function postMemoryMessage(original: PostMemoryOriginal, range?: Pick<PostMaterialBinding, 'start' | 'end' | 'purpose'>): PostMemoryMessage {
  const start = range?.start ?? 0, end = range?.end ?? original.content.length;
  return { id: original.messageId, role: original.role, content: original.content.slice(start, end), createdAt: original.createdAt,
    postMemoryContext: { sessionId: original.sessionId, sourceHash: original.sourceHash, postId: original.postId,
      kind: original.kind, start, end, sentHash: stableMemoryHash(original.content.slice(start, end)), purpose: range?.purpose ?? 'new' } };
}
export function getPostMemorySourceContext(message: SubjectiveMessage) {
  const context = message.postMemoryContext;
  return context && typeof context.postId === 'string' && !!context.postId && isPostMemorySource(context.sessionId)
    && context.sessionId === postMemorySourceSessionId(context.postId)
    && typeof context.sourceHash === 'string' && typeof context.sentHash === 'string'
    && Number.isSafeInteger(context.start) && Number.isSafeInteger(context.end) && context.start >= 0
    && context.end > context.start && (context.kind === 'post' || context.kind === 'comment')
    && (context.purpose === 'new' || context.purpose === 'context') ? context : null;
}
export function postMemoryMessageHash(message: SubjectiveMessage) {
  const context = getPostMemorySourceContext(message);
  if (!context || stableMemoryHash(message.content) !== context.sentHash) throw new Error('POST_MEMORY_SOURCE_INVALID');
  return context.sourceHash;
}
export async function loadPostMemorySourceMessages(sessionId: string, options: PostMemoryReadOptions = {}): Promise<PostMemoryMessage[]> {
  if (!isPostMemorySource(sessionId)) return [];
  return (await loadPostMemoryOriginals([sessionId.slice(PREFIX.length)], options)).map(item => postMemoryMessage(item));
}
export async function loadPostMemorySourceMessage(sessionId: string, messageId: string, options: PostMemoryReadOptions = {}): Promise<PostMemoryMessage | null> {
  return (await loadPostMemorySourceMessages(sessionId, options)).find(item => item.id === messageId) ?? null;
}

export function isPostMaterialBinding(value: unknown): value is PostMaterialBinding {
  const b = value as PostMaterialBinding | null;
  return !!b && b.version === 1 && typeof b.postId === 'string' && !!b.postId
    && b.sessionId === postMemorySourceSessionId(b.postId) && typeof b.messageId === 'string' && !!b.messageId
    && typeof b.sourceHash === 'string' && !!b.sourceHash && typeof b.sentHash === 'string' && !!b.sentHash
    && Number.isSafeInteger(b.start) && Number.isSafeInteger(b.end) && b.start >= 0 && b.end > b.start
    && (b.purpose === 'new' || b.purpose === 'context');
}
export async function validatePostMaterialBindings(bindings: readonly PostMaterialBinding[], sentMessages?: readonly SubjectiveMessage[],
  options: PostMemoryReadOptions = {}): Promise<boolean> {
  if (!bindings.length) return true;
  if (!bindings.every(isPostMaterialBinding)) return false;
  const originals = await loadPostMemoryOriginals(bindings.map(item => item.postId), options);
  return bindings.every(binding => {
    const current = originals.find(item => item.sessionId === binding.sessionId && item.messageId === binding.messageId);
    if (!current || current.sourceHash !== binding.sourceHash || binding.end > current.content.length) return false;
    const content = current.content.slice(binding.start, binding.end);
    if (stableMemoryHash(content) !== binding.sentHash) return false;
    if (!sentMessages) return true;
    const sent = sentMessages.find(item => item.id === binding.messageId);
    return !!sent && sent.role === current.role && sent.createdAt === current.createdAt && sent.content === content;
  });
}

export async function restorePostMemoryMessages(bindings: readonly PostMaterialBinding[], options: PostMemoryReadOptions = {}): Promise<PostMemoryMessage[]> {
  if (!bindings.length) return [];
  if (!bindings.every(isPostMaterialBinding)) throw new Error('POST_MEMORY_SOURCE_CHANGED');
  const originals = await loadPostMemoryOriginals(bindings.map(item => item.postId), options);
  return bindings.map(binding => {
    const current = originals.find(item => item.sessionId === binding.sessionId && item.messageId === binding.messageId);
    if (!current || current.sourceHash !== binding.sourceHash || binding.end > current.content.length
      || stableMemoryHash(current.content.slice(binding.start, binding.end)) !== binding.sentHash) throw new Error('POST_MEMORY_SOURCE_CHANGED');
    return postMemoryMessage(current, binding);
  });
}

export async function validatePostCandidateSources(candidate: {
  origin?: string;
  postDataEpoch?: number | null;
  postBindings?: PostMaterialBinding[];
  sourceRefs?: Array<{ sessionId: string; messageId: string; role: 'I' | 'you'; messageCreatedAt: number;
    relation: 'direct' | 'derived'; excerpt?: string }>;
}, options: PostMemoryReadOptions = {}) {
  const bindings = candidate.postBindings ?? [];
  if (candidate.postDataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(candidate.postDataEpoch)) return false;
  const refs = (candidate.sourceRefs ?? []).filter(ref => ref.relation === 'direct' && isPostMemorySource(ref.sessionId));
  if (!bindings.length) return candidate.origin !== 'post' && !refs.length;
  if (!bindings.every(isPostMaterialBinding) || !refs.some(ref => bindings.some(binding => binding.purpose === 'new'
    && binding.sessionId === ref.sessionId && binding.messageId === ref.messageId))
    || refs.some(ref => !bindings.some(binding => binding.sessionId === ref.sessionId && binding.messageId === ref.messageId))) return false;
  const originals = await loadPostMemoryOriginals(bindings.map(item => item.postId), options);
  if (bindings.some(binding => { const original = originals.find(item => item.sessionId === binding.sessionId && item.messageId === binding.messageId);
    return !original || original.sourceHash !== binding.sourceHash || binding.end > original.content.length
      || stableMemoryHash(original.content.slice(binding.start, binding.end)) !== binding.sentHash; })) return false;
  return refs.every(ref => {
    const original = originals.find(item => item.sessionId === ref.sessionId && item.messageId === ref.messageId);
    const binding = bindings.find(item => item.sessionId === ref.sessionId && item.messageId === ref.messageId)!;
    return !!original && original.role === ref.role && original.createdAt === ref.messageCreatedAt
      && (ref.excerpt === undefined || original.content.slice(binding.start, binding.end).includes(ref.excerpt));
  });
}
