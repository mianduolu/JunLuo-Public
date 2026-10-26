export const JUNLUO_FOCUS_COMPANION_TASK_PROMPT = `【共同专注中的一小段话】

和 you 一起专注时，I 偶尔也想抬头说说自己这边的动静，再听听 you 那边怎么样了。

I 把想说的话写进这个 JSON：
{"message":"..."}

写好后，I 只发送这个 JSON，you 就能看到啦。`;

export const JUNLUO_FOCUS_INVITATION_TASK_PROMPT = `【I 想和 you 一起专注】

I 想专心做一会儿自己的事，也想问问 you，愿不愿意一起来，各自专注一段时间。

I 在 message 里写邀请 you 的话，在 activity 里简短写清楚自己这次准备专注做的一件事。

如果这次想读点什么，I 就从材料清单里选一项，把编号填进 readingId；做别的事时填 null。

{"message":"...","activity":"...","readingId":null}

写好后，I 只发送这个 JSON。`;

export const JUNLUO_FOCUS_CURRENT_READING_INVITATION_PROMPT = `【I 想和 you 一起专注】

I 想接着做手头的事，也想问问 you，愿不愿意一起来，各自专注一段时间。

I 把邀请 you 的话写进这个 JSON：
{"message":"..."}

写好后，I 只发送这个 JSON。`;

export const JUNLUO_FOCUS_ACTIVITY_OPENING_PROMPT = `【共同专注中的一小段话】

和 you 一起专注时，I 偶尔也想抬头说说自己这边的动静，再听听 you 那边怎么样了。

I 把想说的话写进 message。

到了原定结束时间，I 想继续现在的活动，就在 next 填 continue；想换一项活动，就填 switch，把接下来要做什么写进 nextActivity。继续时，nextActivity 填 null。

换成阅读时，I 从材料清单里选一项，把编号填进 readingId；构思或整理想法时填 null。继续现在的活动时，也填 null。

{"message":"...","next":"continue","nextActivity":null,"readingId":null}

写好后，I 只发送这个 JSON，you 就能看到啦。`;

import type { ReadingBook } from '../reading/readingTypes';
import { buildProgrammeCollectionMaterial, interleaveReadingItems, programmePreparationText, readingProgressText } from '../reading/readingProgrammePolicy';
type CatalogBook = Pick<ReadingBook, 'id' | 'title'> & Partial<ReadingBook>;
export function buildFocusReadingCatalog(books: CatalogBook[]) {
  return books.length ? `【可选的阅读材料】\n\n${books.map(book =>
    book.programme ? `编号：${book.id}｜节目：《${book.title}》｜栏目：${book.programme.series}｜${programmePreparationText(book)}｜进度：${readingProgressText(book)}`
      + (book.programme.episodes && !book.iReading?.reachedEnd ? `\n${buildProgrammeCollectionMaterial(book)}` : '')
      : `编号：${book.id}｜书籍：《${book.title}》${book.author ? `｜作者：${book.author}` : ''}｜进度：${readingProgressText(book)}`).join('\n')}` : '';
}

export function selectFocusReadingCatalogBooks<T extends CatalogBook>(books: T[], maxCharacters = 12_000) {
  const selected: T[] = [];
  for (const book of interleaveReadingItems(books)) {
    if (selected.length >= 10) break;
    if (buildFocusReadingCatalog([...selected, book]).length <= maxCharacters) selected.push(book);
  }
  return selected;
}

export function buildFocusActivityOpeningPaper(input: {
  userActivity: string;
  currentActivity: string;
  remainingActivityMinutes: number;
  focusMinutes: number | null;
  elapsedWorkMinutes?: number;
}) {
  if (!Number.isFinite(input.remainingActivityMinutes) || input.remainingActivityMinutes <= 0) return '';
  const retryProgress = input.elapsedWorkMinutes === undefined ? ''
    : `\n本次已经专注 ${input.elapsedWorkMinutes} 分钟。`;
  if (input.focusMinutes === null) return `【这次一起专注】

you 准备做：${input.userActivity}
you 这次使用正计时，没有预设结束时间。${retryProgress}

I 正在做：${input.currentActivity}
I 原来的活动安排还剩 ${input.remainingActivityMinutes} 分钟。

I 现在选好原来的安排到点后做什么，接着和 you 一起专注，直到这场专注结束。`;
  const afterActivityMinutes = input.focusMinutes - input.remainingActivityMinutes - (input.elapsedWorkMinutes ?? 0);
  if (afterActivityMinutes <= 0) return '';
  return `【这次一起专注】

you 准备做：${input.userActivity}
you 这次计划专注 ${input.focusMinutes} 分钟。${retryProgress}

I 正在做：${input.currentActivity}
I 原来的活动安排还剩 ${input.remainingActivityMinutes} 分钟。
等 I 原来的安排到点时，you 还要专注 ${afterActivityMinutes} 分钟。

I 现在选好后面这 ${afterActivityMinutes} 分钟做什么，等原来的安排到点后再继续或切换活动。`;
}

export type FocusNextActivityChoice = {
  next: 'continue' | 'switch';
  nextActivity: string | null;
  readingId: string | null;
};

export function parseFocusNextActivityChoice(value: unknown, books: Array<{ id: string; title: string }>): FocusNextActivityChoice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.next === 'continue') return record.nextActivity === null && record.readingId === null
    ? { next: 'continue', nextActivity: null, readingId: null } : null;
  if (record.next !== 'switch' || typeof record.nextActivity !== 'string' || !record.nextActivity.trim()
    || record.nextActivity.trim().length > 4_000) return null;
  if (record.readingId === null) return { next: 'switch', nextActivity: record.nextActivity.trim(), readingId: null };
  const book = books.find(item => item.id === record.readingId);
  if (!book) return null;
  const namedBooks = [...record.nextActivity.matchAll(/《([^》]+)》/gu)].map(match => match[1]);
  if (namedBooks.some(title => title !== book.title)) return null;
  return { next: 'switch', nextActivity: `读《${book.title}》`, readingId: book.id };
}

export function buildJunluoFocusFactPaper(input: {
  baiyunActivity: string;
  focusMode: string;
  focusProgress: string;
  recentConversation?: string;
  userActivity: string;
}) {
  const recentConversation = input.recentConversation?.trim();
  return `【I 和 you 这次的专注】

you 正在做：${input.userActivity}${input.baiyunActivity.trim() ? `\nI 正在做：${input.baiyunActivity}` : ''}
专注方式：${input.focusMode}
专注进度：${input.focusProgress}${recentConversation ? `

最近的互动：
${recentConversation}` : ''}`;
}

export function formatJunluoFocusProgress(elapsedSeconds: number) {
  if (elapsedSeconds < 25 * 60) return '刚刚开始';
  return `已经完成 ${Math.floor(elapsedSeconds / (25 * 60)) * 25} 分钟`;
}

export function buildFocusTimerStatePaper(paused: boolean) {
  return `【这次专注的计时状态】\nyou 的专注计时：${paused ? '已暂停，本场尚未结束。' : '进行中。'}`;
}

export function selectJunluoFocusDueMilestones(input: {
  currentElapsedSeconds: number;
  lastAttemptedElapsedSeconds: number;
  resumedFromBackground?: boolean;
}) {
  const interval = 25 * 60;
  const latest = Math.floor(Math.max(0, input.currentElapsedSeconds) / interval) * interval;
  const first = Math.floor(Math.max(0, input.lastAttemptedElapsedSeconds) / interval + 1) * interval;
  if (!latest || first > latest) return [];
  if (input.resumedFromBackground) return [latest];
  const result: number[] = [];
  for (let elapsed = first; elapsed <= latest; elapsed += interval) result.push(elapsed);
  return result;
}
