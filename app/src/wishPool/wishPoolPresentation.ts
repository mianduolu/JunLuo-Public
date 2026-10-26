import type { WishDiscussion } from './wishPoolDiscussionState';
import type { WishItem, WishPoolSnapshot, WishStatus } from './wishPoolStore';

export const WISH_STATUS_LABELS: Record<WishStatus, string> = {
  candidate: '待商量', 'not-adopted': '未投币', active: '已入池',
  'in-progress': '进行中', deferred: '暂缓', fulfilled: '已完成', released: '已放下', removed: '已移除',
};
export const WISH_PURPOSE_LABELS = { cast_coin: '投币', revise: '修改', progress: '进展', complete: '完成', release: '放下' } as const;
export const WISH_BOOK_FILTERS = ['全部', '待商量', '池中', '已完成', '已放下', '未投币', '旧移除'] as const;
export type WishBookFilter = typeof WISH_BOOK_FILTERS[number];
export const wishOwnerLabel = (owner: WishItem['owner']) => owner === 'I' ? '白云小姐' : '小仓鼠';
export const wishDate = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
};

export function wishBookEntries(snapshot: WishPoolSnapshot, filter: WishBookFilter) {
  return snapshot.wishes.filter((wish) => {
    if (filter === '全部') return true;
    if (filter === '池中') return ['active', 'in-progress', 'deferred'].includes(wish.status);
    if (filter === '旧移除') return wish.status === 'removed';
    return WISH_STATUS_LABELS[wish.status] === filter;
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

// Both random and specified draw controls use the same visible set. Reading the book never draws.
export function visibleWishCoins(snapshot: WishPoolSnapshot, now: number) {
  return snapshot.wishes.filter((wish) => wish.owner === 'I' && wish.status === 'active'
    && (wish.lastPulledAt === undefined || wish.lastPulledAt + 7 * 86400000 <= now)
    && (wish.redrawEligibleAt === undefined || wish.redrawEligibleAt <= now));
}

export function wishConfirmationLabel(discussion: WishDiscussion): string | null {
  if (discussion.closedAt !== undefined || discussion.decision === 'talking'
    || !discussion.reply || discussion.reply.requestRevision !== discussion.revision - 1) return null;
  const labels = {
    cast_coin: { yes: '确认投币', no: '确认不投币' },
    revise: { yes: '确认修改', no: '保留原样' },
    progress: { yes: '记下进展', no: '这次不记' },
    complete: { yes: '确认完成', no: '还没完成' },
    release: { yes: '确认放下', no: '继续留着' },
  };
  return labels[discussion.purpose][discussion.decision];
}
