import { parsePostReplyState } from '../posts/baiyunPostReplyState';
import { parsePostMemoryRuntimeState } from '../posts/baiyunPostMemoryState';

export const POST_BACKUP_FOLDER = 'post-images';
export const POST_BACKUP_PREFIX = 'JunLuo/files/post-images/';
export const RUNTIME = 'junluo.baiyunPosts.runtime.v1';
export const READ = 'junluo.posts.heartRead.v1';
export const NOTICES = 'junluo.posts.notifications.v1';
export const KEYS = [RUNTIME, READ, NOTICES, 'junluo.memory.baiyunHeartViewedThroughId'];
export type PostBackupImage = { id: string; width: number; height: number; byte_size: number };
export type PostBackupOptions = {
  acceptedMissingPostImageIds?: readonly string[];
  /** Only the existing restore/rollback entry may reuse its already-held exclusive window. */
  postCaptureAlreadyExclusive?: boolean;
};
export class PostBackupMissingImagesError extends Error {
  constructor(readonly imageIds: string[], readonly operation: 'export' | 'restore') {
    super(`这次${operation === 'export' ? '备份' : '还原'}有 ${imageIds.length} 张动态图片缺失。文字、草稿和图片位置仍可保留。`);
    this.name = 'PostBackupMissingImagesError';
  }
}
export const validPostImageId = (id: unknown): id is string =>
  typeof id === 'string' && /^post-image-\d+-[a-z0-9]+$/.test(id);
export function assertMissingPostImageIds(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some(id => !validPostImageId(id)) || new Set(value).size !== value.length)
    throw new Error('动态缺图清单无效。');
}
export function acceptPostMissing(ids: string[], accepted: readonly string[] | undefined, operation: 'export' | 'restore') {
  if (ids.some(id => !accepted?.includes(id))) throw new PostBackupMissingImagesError(ids, operation);
}
export function validatePostBackupStorage(storage: Readonly<Record<string, string>>) {
  if (storage[RUNTIME] !== undefined) {
    const runtime = JSON.parse(storage[RUNTIME]);
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) throw new Error('动态运行记录无效。');
    parsePostReplyState(runtime.replies);
    parsePostMemoryRuntimeState(runtime.memoryOrganization);
  }
  if (storage[READ] !== undefined) {
    const read = JSON.parse(storage[READ]);
    if (!read || !Number.isFinite(read.since) || !Array.isArray(read.seen) || read.seen.some((key: unknown) => typeof key !== 'string'))
      throw new Error('动态已读记录无效。');
  }
  if (storage[NOTICES] !== undefined) {
    const journal = JSON.parse(storage[NOTICES]);
    if (!journal || Array.isArray(journal) || typeof journal !== 'object'
      || Object.values(journal).some((item: any) => !item || !['attempted', 'sent', 'closed'].includes(item.phase)
        || !Number.isSafeInteger(item.revision) || typeof item.signature !== 'string')) throw new Error('动态通知记录无效。');
  }
}
