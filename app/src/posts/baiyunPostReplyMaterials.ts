import { readJsonObjects } from '../ai/shortJsonObjects';
import { orderPostComments, type PostCommentData, type PostData, type PostImageGroupRef } from './baiyunPostData';

// Exact approved texts: docs/双向动态脑暴笔记.md. Optional title approved in chapter 5.
export type PostLookKind = 'posts' | 'comments' | 'both';
const LOOK_LINES: Record<PostLookKind, string> = {
  posts: 'you 发了一条新动态。I 这会儿想去看一眼吗？',
  comments: 'you 在动态下留了新评论。I 这会儿想去看一眼吗？',
  both: 'you 发了新动态，也在动态下留了新评论。I 这会儿想去看一眼吗？',
};

export function buildPostLookPrompt(base: string, kind?: PostLookKind): string {
  if (!kind) return base;
  const shape = '{"wants":[{"id":"...","change":"..."}]}';
  const ending = '写好后，I 只发送这个 JSON。';
  if (!base.includes(shape) || !base.endsWith(ending)) throw new Error('post-look-base-changed');
  return base.replace(shape, '{"wants":[{"id":"...","change":"..."}],"lookAtPost":true}')
    .replace(ending, `${LOOK_LINES[kind]}\n\n"lookAtPost": true 或 false\n\n${ending}`);
}

/** This decision is independent of whether the wants payload is valid. */
export function parsePostLookDecision(raw: string): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const decision = (parsed as Record<string, unknown>).lookAtPost;
    return typeof decision === 'boolean' ? decision : undefined;
  } catch { return undefined; }
}

export function postReplyTask(initial: boolean): string {
  return `【评论动态】\n\n${initial
    ? 'I 看到 you 发的新动态啦，想给you留评论。'
    : 'I 看到 you 在动态下新留的评论啦，想接着和you聊聊。'}\n\n{"content":"..."}`;
}

type PublishTag = { id: string; name: string; scope: 'I' | 'you' | 'both' };
function availablePublishTags(tags: readonly PublishTag[]) {
  return tags.filter(tag => tag.scope === 'I' || tag.scope === 'both');
}

export function buildPostPublishTask(tags: readonly PublishTag[]): string {
  const available = availablePublishTags(tags);
  const opening = '【发条动态】\n\nI 想发条动态啦。';
  if (!available.length) return `${opening}\n\n{"content":"..."}`;
  const lines = available.map(tag => `${tag.id}｜${tag.name}${tag.name === '两小只'
    ? '（指 I 和 you，记录彼此的相处、关系与共同经历）' : ''}`);
  return `${opening}\n\n动态的tag从下方挑一到三个。\n\n{"content":"...","tagIds":["..."]}\n\n${lines.join('\n')}`;
}

export function parsePostPublishResult(raw: string, tags: readonly PublishTag[]): { content: string; tagIds: string[] } | null {
  const objects = readJsonObjects(raw);
  if (objects.length !== 1) return null;
  const parsed = objects[0] as Record<string, unknown>;
  if (typeof parsed.content !== 'string' || !parsed.content.trim()) return null;
  const allowed = new Set(availablePublishTags(tags).map(tag => tag.id));
  const tagIds = Array.isArray(parsed.tagIds)
    ? [...new Set(parsed.tagIds.filter((id): id is string => typeof id === 'string' && allowed.has(id)))].slice(0, 3)
    : [];
  return { content: parsed.content.trim(), tagIds };
}

export type PostReplyImageMaterial = { description: string; recovered: boolean } | null;
export type PostReplyMaterialsInput = {
  now: number;
  post: PostData;
  oldComments: readonly PostCommentData[];
  newComments: readonly PostCommentData[];
  tagNames: readonly string[];
  // Missing means still pending, not failed; null is a completed unsuccessful opportunity.
  images: Readonly<Record<string, PostReplyImageMaterial | undefined>>;
};

function time(at: number) { return new Date(at).toLocaleString('zh-CN', { hour12: false }); }

function imageLine(group: PostImageGroupRef | null, images: PostReplyMaterialsInput['images']): string {
  if (!group) return '';
  const material = images[group.id];
  if (material === undefined) throw new Error('post-image-material-pending');
  if (material !== null && !material.description.trim()) throw new Error('post-image-material-empty');
  return `图片（${group.imageIds.length} 张）：${material === null
    ? 'I 这次没能看见这组图片，不知道图片里是什么。'
    : `${material.recovered ? '这组图片上次没成功显示，这次 I 能看到啦。' : ''}${material.description}`}`;
}

function commentLine(comment: PostCommentData, images: PostReplyMaterialsInput['images']): string {
  const text = comment.content.trim()
    ? `${time(comment.createdAt)} ${comment.author}：${comment.content}`
    : `${time(comment.createdAt)} ${comment.author} 留下了一条图片评论。`;
  return [text, imageLine(comment.imageGroup, images)].filter(Boolean).join('\n');
}

/** Receives already selected inputs; never reads storage or acknowledges image receipts. */
export function buildPostReplyMaterials(input: PostReplyMaterialsInput): string {
  const { post, images, oldComments, newComments } = input;
  const comments = [...oldComments, ...newComments];
  if (comments.some(comment => comment.postId !== post.id || comment.deleted)
    || new Set(comments.map(comment => comment.source)).size !== comments.length
    || newComments.some(comment => comment.author !== 'you')) throw new Error('post-reply-invalid-materials');
  const postLines = [
    `发布者：${post.author}`,
    `发布时间：${time(post.createdAt)}`,
    post.title?.trim() ? `标题：${post.title}` : '',
    `正文：${post.content.trim() ? post.content : '这条动态没有附带文字。'}`,
    input.tagNames.length ? `tag：${input.tagNames.join('、')}` : '',
    imageLine(post.imageGroup, images),
  ].filter(Boolean).join('\n');
  return [
    `【此刻】\n\n现在：${time(input.now)}`,
    `【I 正在看的动态】\n\n${postLines}`,
    oldComments.length ? `【最近的评论】\n\n${orderPostComments(oldComments).map(comment => commentLine(comment, images)).join('\n\n')}` : '',
    newComments.length ? `【I 现在读到的评论】\n\n${orderPostComments(newComments).map(comment => commentLine(comment, images)).join('\n\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

export function selectPostReplyComments(postId: string, all: readonly PostCommentData[], handledSources: readonly string[]) {
  const handled = new Set(handledSources);
  const live = orderPostComments(all.filter(comment => comment.postId === postId && !comment.deleted));
  const newComments = live.filter(comment => comment.author === 'you' && !handled.has(comment.source));
  const oldComments = live.filter(comment => comment.author === 'I' || handled.has(comment.source)).slice(-6);
  return { oldComments, newComments };
}

/** Estimate the entire request in fits, including fixed/new inputs and reserved output. */
export function fitPostReplyComments(oldComments: readonly PostCommentData[], fits: (old: readonly PostCommentData[]) => boolean): PostCommentData[] | null {
  const retained = orderPostComments(oldComments);
  while (!fits(retained)) {
    if (!retained.length) return null;
    retained.shift();
  }
  return retained;
}
