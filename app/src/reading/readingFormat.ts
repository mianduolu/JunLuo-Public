export function formatPercent(value: number): `${number}%` {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` as `${number}%`;
}

export function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
  });
}

export function formatRelativeTime(timestamp?: number) {
  if (!timestamp) return '还没开始读';
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚读过';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`;
  if (diff < 172_800_000) return '昨天';
  return formatDate(timestamp);
}

export function todayStart() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function truncate(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

export function filterReadingBooks<T extends { title: string; author?: string }>(books: readonly T[], query: string): T[] {
  const words = query.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return books.filter(book => {
    const text = `${book.title} ${book.author ?? ''}`.normalize('NFKC').toLowerCase();
    return words.every(word => text.includes(word));
  });
}
