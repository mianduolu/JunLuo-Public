import { isPostReplySnapshotCurrent, orderPostComments, type PostCommentData, type PostData, type PostReplySnapshot } from './baiyunPostData';
import type { PostImageReceipt } from './baiyunPostImageData';
import { postReadRef, recordPostReading, validatePostReadingState, type PostReading, type PostReadingState } from './baiyunPostReading';

export type PostLookKind = 'posts' | 'comments' | 'both';
export type PostReplyWork = {
  source: string; postId: string; opportunityAt: number; initial: boolean;
  notificationGroupKey?: string;
  phase: 'ready' | 'generating' | 'generated' | 'failed' | 'capacity' | 'stale';
  newSources: string[];
  snapshot?: PostReplySnapshot;
  tagSnapshot?: { id: string; name: string; scope: string }[];
  oldSources?: string[];
  content?: string;
  imageReceipts?: PostImageReceipt[];
  reading?: Omit<PostReading, 'added'>;
};
export type PostReplyProgress = {
  initialHandled: boolean; handledSources: string[]; lastOpportunityAt: number; work?: PostReplyWork;
};
export type PostLookPaper = { key: string; kind?: PostLookKind; decision?: boolean };
export type PostReplyState = {
  posts: Record<string, PostReplyProgress>;
  papers: Partial<Record<'inner' | 'shared', PostLookPaper>>;
  reading?: PostReadingState;
};
export const emptyPostReplyState = (): PostReplyState => ({ posts: {}, papers: {} });

export function initializePostReading(state: PostReplyState, posts: readonly PostData[], comments: readonly PostCommentData[], now: number): PostReadingState {
  if (state.reading) return state.reading;
  let reading: PostReadingState = { activatedAt: now, rounds: [] };
  for (const progress of Object.values(state.posts)) {
    const work = progress.work, post = work && posts.find(item => item.id === work.postId);
    const lines = comments.filter(line => line.postId === work?.postId);
    if (!work?.snapshot || !work.content || work.phase !== 'generated' || !post
      || !isPostReplySnapshotCurrent(work.snapshot, post, lines)) continue;
    reading = recordPostReading(reading, { source: work.source, postId: post.id, at: now - 1,
      refs: [postReadRef(post), ...lines.filter(line => work.snapshot!.comments.some(ref => ref.source === line.source)).map(line => postReadRef(line))] });
  }
  return reading;
}

/** Old runtimes have no conversation state. Never silently reset a damaged paid-work journal. */
export function parsePostReplyState(value: unknown): PostReplyState {
  if (value === undefined) return emptyPostReplyState();
  if (!value || typeof value !== 'object') throw new Error('baiyun-post-reply-state-invalid');
  const state = value as PostReplyState;
  validatePostReadingState(state.reading);
  if (!state.posts || typeof state.posts !== 'object' || !state.papers || typeof state.papers !== 'object')
    throw new Error('baiyun-post-reply-state-invalid');
  for (const [id, progress] of Object.entries(state.posts)) {
    if (progress?.work?.reading) {
      const input = progress.work.reading;
      validatePostReadingState({ activatedAt: input.at, rounds: [{ ...input, added: [] }] });
      if (input.postId !== id || input.source !== progress.work.source) throw new Error('baiyun-post-reply-state-invalid');
    }
    if (!progress || typeof progress.initialHandled !== 'boolean' || !Array.isArray(progress.handledSources)
      || progress.handledSources.some(source => typeof source !== 'string') || !Number.isSafeInteger(progress.lastOpportunityAt)
      || (progress.work && (progress.work.postId !== id || !progress.work.source
        || (progress.work.notificationGroupKey !== undefined && (typeof progress.work.notificationGroupKey !== 'string' || !progress.work.notificationGroupKey))
        || !Array.isArray(progress.work.newSources) || !Number.isSafeInteger(progress.work.opportunityAt)
        || !['ready', 'generating', 'generated', 'failed', 'capacity', 'stale'].includes(progress.work.phase))))
      throw new Error('baiyun-post-reply-state-invalid');
  }
  return state;
}

/** Exact source identities survive comment deletion. Timestamps never guess which reply answered which text. */
export function reconcilePostReplyState(state: PostReplyState, posts: readonly PostData[], comments: readonly PostCommentData[]): PostReplyState {
  const next: PostReplyState = { ...state, posts: {} };
  if (state.reading) next.reading = { ...state.reading, rounds: state.reading.rounds.filter(round => posts.some(post => post.id === round.postId)) };
  for (const post of posts) {
    const lines = comments.filter(line => line.postId === post.id);
    const replies = new Set(lines.filter(line => line.author === 'I').map(line => line.source));
    const previous = state.posts[post.id];
    const handled = new Set(previous?.handledSources ?? []);
    for (const line of lines) if (line.author === 'you' && replies.has(`${line.source}:reply`)) handled.add(line.source);
    const work = previous?.work;
    const committed = work && replies.has(work.source);
    if (committed) work.newSources.forEach(source => handled.add(source));
    next.posts[post.id] = {
      initialHandled: Boolean(previous?.initialHandled || replies.size || (committed && work.initial)),
      handledSources: [...handled], lastOpportunityAt: previous?.lastOpportunityAt ?? 0,
      ...(work && !committed ? { work } : {}),
    };
  }
  return next;
}

export function pendingPostReplies(state: PostReplyState, posts: readonly PostData[], comments: readonly PostCommentData[]) {
  return posts.flatMap(post => {
    const progress = state.posts[post.id];
    const newComments = orderPostComments(comments.filter(line => line.postId === post.id && line.author === 'you'
      && !line.deleted && !progress?.handledSources.includes(line.source)));
    const initial = post.author === 'you' && !progress?.initialHandled;
    const work = progress?.work;
    if (work && (['ready', 'generating', 'generated'].includes(work.phase)
      || !newComments.some(line => !work.newSources.includes(line.source)))) return [];
    if (!initial && !newComments.length) return [];
    return [{ postId: post.id, initial, newSources: newComments.map(line => line.source),
      waitingAt: initial ? post.createdAt : newComments[0].createdAt }];
  }).sort((a, b) => a.waitingAt - b.waitingAt || a.postId.localeCompare(b.postId));
}

export function postLookKind(pending: ReturnType<typeof pendingPostReplies>): PostLookKind | undefined {
  const posts = pending.some(item => item.initial), comments = pending.some(item => item.newSources.length);
  return posts && comments ? 'both' : posts ? 'posts' : comments ? 'comments' : undefined;
}

export function claimPostReplies(state: PostReplyState, pending: ReturnType<typeof pendingPostReplies>, key: string, now: number) {
  const posts = { ...state.posts };
  for (const item of pending.slice(0, 3)) {
    const previous = posts[item.postId] ?? { initialHandled: false, handledSources: [], lastOpportunityAt: 0 };
    const opportunityAt = Math.max(now, previous.lastOpportunityAt + 1);
    posts[item.postId] = { ...previous, lastOpportunityAt: opportunityAt, work: {
      source: `post-reply:${key}:${item.postId}`, notificationGroupKey: `look:${key}`, postId: item.postId, initial: item.initial,
      opportunityAt, phase: 'ready', newSources: item.newSources,
    } };
  }
  return { ...state, posts };
}
