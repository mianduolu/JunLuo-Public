export type PostNotificationPayload = {
  kind: 'baiyun-post'; groupKey: string; requestId: string;
  postId: string; commentSource: string | null; createdAt: number; silent: boolean;
};

export function isPostNotificationPayload(value: unknown): value is PostNotificationPayload {
  if (!value || typeof value !== 'object') return false;
  const data = value as PostNotificationPayload;
  return data.kind === 'baiyun-post' && typeof data.groupKey === 'string' && !!data.groupKey
    && typeof data.requestId === 'string' && !!data.requestId && typeof data.postId === 'string' && !!data.postId
    && (data.commentSource === null || typeof data.commentSource === 'string')
    && Number.isFinite(data.createdAt) && typeof data.silent === 'boolean';
}

export function postNotificationBehavior(data: unknown, active: boolean) {
  if (!isPostNotificationPayload(data)) return null;
  return { shouldPlaySound: !active && !data.silent, shouldSetBadge: false,
    shouldShowBanner: !active && !data.silent, shouldShowList: !active || data.silent };
}

export function postNotificationPreview(content: string, title?: string | null) {
  const text = (content.trim() || title?.trim() || '').replace(/\s+/gu, ' ');
  const characters = Array.from(text);
  return characters.length > 60 ? `${characters.slice(0, 60).join('')}…` : text;
}
