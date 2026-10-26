import { orderPostComments, type PostCommentData, type PostData } from './baiyunPostData';

/** References only: never a second copy of a post, comment or model prompt. */
export type PostReadRef = { source: string | null; revision: string; image?: string };
export type PostReading = { source: string; postId: string; at: number; refs: PostReadRef[]; added: PostReadRef[] };
export type PostReadingState = { activatedAt: number; rounds: PostReading[] };
export type PostKnownMaterial = { post: PostData; comments: PostCommentData[]; tags: string[];
  images: Record<string, string>; readings: PostReading[] };

// Two independent 32-bit accumulators; persisted keys are bounded and contain no text.
export function postMaterialKey(value: unknown): string {
  const text = JSON.stringify(value);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}-${text.length}`;
}

/** Tag management is not new reading. Physical comment row IDs are not identities. */
export function postReadRef(item: PostData | PostCommentData, images: Readonly<Record<string, { description: string } | string | null | undefined>> = {}): PostReadRef {
  const image = item.imageGroup && images[item.imageGroup.id];
  return { source: 'source' in item ? item.source : null,
    revision: postMaterialKey([item.author, item.createdAt, 'source' in item ? item.updatedAt : item.contentVersion ?? 0,
      item.content, 'title' in item ? item.title ?? '' : '', item.imageGroup]),
    ...(image ? { image: postMaterialKey([item.imageGroup, typeof image === 'string' ? image : image.description]) } : {}) };
}

export function hasReadVersion(state: PostReadingState | undefined, postId: string, ref: PostReadRef, image = false) {
  return !!state?.rounds.some(round => round.postId === postId && round.refs.some(known => known.source === ref.source
    && known.revision === ref.revision && (!image || known.image === ref.image)));
}

export function recordPostReading(state: PostReadingState, input: Omit<PostReading, 'added'>): PostReadingState {
  // Re-saving or re-reading identical inputs never becomes another experience.
  const previous = state.rounds.find(round => round.source === input.source && round.postId === input.postId);
  const added = input.refs.filter(ref => !hasReadVersion(state, input.postId, ref)
    || !!ref.image && !hasReadVersion(state, input.postId, ref, true));
  if (previous && !added.length) return state;
  // A manually retried task may really read an edited version. Keep only newly known
  // versions in that experience, not the earlier round's already-consumed lines.
  return { ...state, rounds: [...state.rounds, { ...input, added }] };
}

export function validatePostReadingState(value: PostReadingState | undefined) {
  if (value === undefined) return;
  const validRef = (ref: PostReadRef) => ref && (ref.source === null || typeof ref.source === 'string')
    && typeof ref.revision === 'string' && (ref.image === undefined || typeof ref.image === 'string');
  if (!value || !Number.isSafeInteger(value.activatedAt) || !Array.isArray(value.rounds)
    || value.rounds.some(round => !round || typeof round.source !== 'string' || typeof round.postId !== 'string'
      || !Number.isSafeInteger(round.at) || !Array.isArray(round.refs) || !Array.isArray(round.added)
      || !round.refs.every(validRef) || !round.added.every(validRef))) throw new Error('baiyun-post-reply-state-invalid');
}

function time(at: number) { return new Date(at).toLocaleString('zh-CN', { hour12: false }); }
export function knownPostImageLine(item: PostData | PostCommentData, images: Readonly<Record<string, string>>) {
  return item.imageGroup ? `图片（${item.imageGroup.imageIds.length} 张）：${images[item.imageGroup.id] ?? '这组图片尚未成功识别。'}` : '';
}
export function knownPostCommentLine(comment: PostCommentData, images: Readonly<Record<string, string>>) {
  return [comment.content.trim() ? `${time(comment.createdAt)} ${comment.author}：${comment.content}`
    : `${time(comment.createdAt)} ${comment.author} 留下了一条图片评论。`, knownPostImageLine(comment, images)].filter(Boolean).join('\n');
}
export function buildPostRecallMaterial(material: PostKnownMaterial) {
  const { post, comments, images, tags } = material;
  const body = [`发布者：${post.author}`, `发布时间：${time(post.createdAt)}`,
    post.title?.trim() ? `标题：${post.title}` : '', `正文：${post.content.trim() ? post.content : '这条动态没有附带文字。'}`,
    tags.length ? `tag：${tags.join('、')}` : '', knownPostImageLine(post, images)].filter(Boolean).join('\n');
  return `【I 想起的一条动态】\n\n聊到这里，I 忽然想起了这条动态。\n\n${body}`
    + (comments.length ? `\n\n【相关评论】\n\n${orderPostComments(comments).map(line => knownPostCommentLine(line, images)).join('\n\n')}` : '');
}

export function postExperienceHeader(post: PostData) {
  return `【动态下面聊过的话】\n\n动态发表时间：${time(post.createdAt)}` + (post.title?.trim() ? `\n标题：${post.title}` : '');
}
export function postExperienceBody(material: PostKnownMaterial) {
  const { post, images } = material;
  return [`${post.author} 的动态：`, post.content.trim() ? post.content : '正文：这条动态没有附带文字。',
    knownPostImageLine(post, images)].filter(Boolean).join('\n');
}
