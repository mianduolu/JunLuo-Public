/** Local data contracts. No model material, scheduling, image IO or sync protocol. */
export type PostAuthor = 'I' | 'you';

export type PostImageGroupRef = {
  id: string;
  version: number;
  imageIds: string[];
};

export type PostBody = {
  content: string;
  imageGroup: PostImageGroupRef | null;
};

export type PostData = PostBody & {
  title?: string;
  id: string;
  author: PostAuthor;
  createdAt: number;
  updatedAt: number;
  contentVersion?: number;
  tagIds: string[];
};

export type PostCommentData = PostBody & {
  // source remains stable when the append-only memory row is replaced on edit.
  source: string;
  storageId: string;
  postId: string;
  author: PostAuthor;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
};

export function normalizePostBody(body: PostBody): PostBody {
  const content = body.content.trim();
  const group = body.imageGroup;
  if (group && (!group.id.trim() || !Number.isSafeInteger(group.version) || group.version < 1
    || group.imageIds.length < 1 || group.imageIds.length > 9
    || group.imageIds.some(id => !id.trim()) || new Set(group.imageIds).size !== group.imageIds.length)) {
    throw new Error('baiyun-post-invalid-images');
  }
  if (!content && !group) throw new Error('baiyun-post-empty');
  return { content, imageGroup: group ? { ...group, imageIds: [...group.imageIds] } : null };
}

export function normalizePostTagIds(tagIds: readonly string[]) {
  if (tagIds.length > 3 || tagIds.some(id => !id.trim()) || new Set(tagIds).size !== tagIds.length) {
    throw new Error('baiyun-post-invalid-tags');
  }
  return [...tagIds];
}

export function orderPostComments(comments: readonly PostCommentData[]) {
  return [...comments].sort((a, b) => a.createdAt - b.createdAt || a.source.localeCompare(b.source));
}

/** Deleted tail comments disappear; interior markers retain only their position. */
export function visiblePostComments(comments: readonly PostCommentData[]) {
  const ordered = orderPostComments(comments);
  const lastLive = ordered.findLastIndex(comment => !comment.deleted);
  return ordered.slice(0, lastLive + 1);
}

export type PostReplySnapshot = {
  postId: string;
  postKey: string;
  comments: { source: string; key: string }[];
};

function postKey(post: PostData) {
  return JSON.stringify([post.id, post.author, post.createdAt, post.updatedAt,
    post.content, post.tagIds, post.imageGroup, post.title ?? '']);
}

function commentKey(comment: PostCommentData) {
  return JSON.stringify([comment.storageId, comment.postId, comment.source, comment.author,
    comment.createdAt, comment.updatedAt, comment.content, comment.imageGroup]);
}

/** Capture exactly the comments actually supplied to a request, not a live list. */
export function capturePostReplySnapshot(post: PostData, comments: readonly PostCommentData[]): PostReplySnapshot {
  if (comments.some(comment => comment.deleted || comment.postId !== post.id)
    || new Set(comments.map(comment => comment.source)).size !== comments.length) {
    throw new Error('baiyun-post-invalid-snapshot');
  }
  return { postId: post.id, postKey: postKey(post),
    comments: comments.map(comment => ({ source: comment.source, key: commentKey(comment) })) };
}

/** New arrivals may wait for another turn; changed or missing inputs invalidate this one. */
export function isPostReplySnapshotCurrent(snapshot: PostReplySnapshot, post: PostData | null,
  comments: readonly PostCommentData[]) {
  if (!post || post.id !== snapshot.postId || postKey(post) !== snapshot.postKey) return false;
  return snapshot.comments.every(input => {
    const matches = comments.filter(comment => comment.postId === post.id && comment.source === input.source);
    return matches.length === 1 && !matches[0].deleted && commentKey(matches[0]) === input.key;
  });
}
