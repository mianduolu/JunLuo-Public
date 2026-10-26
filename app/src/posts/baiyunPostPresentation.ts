import { visiblePostComments, type PostAuthor, type PostCommentData, type PostData } from './baiyunPostData';

export type PostFilter = { year: string; month: string; author: PostAuthor | ''; tag: string };
export const defaultPostFilter = (): PostFilter => ({ year: '', month: '', author: '', tag: '' });
export function filterPosts(posts: readonly PostData[], filter: PostFilter) {
  return posts.filter(post => {
    const date = new Date(post.createdAt);
    return (!filter.year || String(date.getFullYear()) === filter.year)
      && (!filter.month || String(date.getMonth() + 1) === filter.month)
      && (!filter.author || post.author === filter.author)
      && (!filter.tag || (filter.tag === '__untagged' ? !post.tagIds.length : post.tagIds.includes(filter.tag)));
  }).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}
export type PostCommentOrder = 'newest' | 'oldest';
export function displayedPostComments(comments: readonly PostCommentData[], expanded: boolean, order: PostCommentOrder = 'newest') {
  const visible = visiblePostComments(comments);
  const ordered = order === 'newest' ? [...visible].reverse() : visible;
  return expanded ? ordered : ordered.slice(0, 6);
}
export function movePostImage(ids: readonly string[], index: number, direction: -1 | 1) {
  const next = [...ids], target = index + direction;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
export function postTime(at: number) {
  return new Date(at).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false });
}
export const postAuthorName = (author: PostAuthor) => author === 'I' ? '白云小姐' : '小仓鼠';
