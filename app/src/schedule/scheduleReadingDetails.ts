import { loadScheduleItemById, type ScheduleOccurrence, type ScheduleReadingChoiceValue } from './scheduleStore';
import { loadReadingAnnotations, loadReadingChapter, loadReadingLibraryStrict } from '../reading/readingStore';
import { readingSegmentSourceVersion } from '../reading/readingDailyPolicy';
import type { ReadingBook, ReadingChapter, ReadingChapterAnnotations } from '../reading/readingTypes';

export type ScheduleReadingNotice = { title: string; body: string; code?: string };
export type ScheduleSavedReading = { key: string; title: string; chapter: string; savedAt: number; summary: string; annotations: string[] };
export type ScheduleReadingDetails = {
  current?: ReadingBook; next?: ReadingBook; choiceCurrent?: ReadingBook;
  actualUnavailable?: boolean; showNext?: boolean; currentLabel?: string;
  exhausted: boolean; notices: ScheduleReadingNotice[]; results: ScheduleSavedReading[];
};
export const scheduleReadingReadFailure: ScheduleReadingNotice = {
  title: '阅读状态暂时无法读取', body: '这不代表进度已经丢失。',
};

type ChapterNotes = { book: ReadingBook; chapter: ReadingChapter; notes: ReadingChapterAnnotations };
const savingUnknown: ScheduleReadingNotice = { title: '保存状态暂时无法确认', body: '需要先核对已有记录，暂不显示为已完成。' };

/** Refresh display-only clock values through the same sleep/focus-aware projection
 * used at save time. No settlement, model opportunity, or completion is written. */
export async function loadScheduleDetailOccurrence(occurrence: ScheduleOccurrence, now = Date.now()): Promise<ScheduleOccurrence> {
  const item = await loadScheduleItemById(occurrence.itemId);
  if (!item) throw new Error('schedule-detail-unavailable');
  if (item.owner !== occurrence.owner || item.startAt !== occurrence.scheduledStartAt || item.endAt !== occurrence.endAt
    || item.execution?.activityId !== occurrence.execution?.activityId
    || (item.execution?.planRevision ?? 0) !== (occurrence.execution?.planRevision ?? 0))
    throw new Error('schedule-detail-changed');
  const current = { ...occurrence, status: item.status, execution: item.execution };
  const execution = item.execution;
  if (item.status !== 'pending' || !execution?.activityId || !['running', 'paused'].includes(execution.status)) return current;
  const context = await (await import('./ownScheduleExecution')).readOwnScheduleSaveContext([item], now);
  const projected = context.executions[item.id];
  if (!context.activityReadingIds?.[item.id] || !projected || projected.activityId !== execution.activityId) return current;
  return { ...current, execution: { ...execution, elapsedMs: projected.elapsedMs,
    totalPlannedMs: projected.totalPlannedMs, estimatedEndAt: projected.estimatedEndAt } };
}

/** The view projects stored evidence only; it never settles clocks or prepares material. */
export function projectScheduleReadingDetails(occurrence: ScheduleOccurrence, books: ReadingBook[],
  choice: ScheduleReadingChoiceValue | undefined, sources: ChapterNotes[]): ScheduleReadingDetails {
  const execution = occurrence.execution;
  const actual = books.find(book => book.iReading?.activity?.id === execution?.activityId
    && book.iReading?.activity?.schedule?.itemId === occurrence.itemId);
  const chosen = books.find(book => book.id === (choice ? choice.currentReadingId : occurrence.readingId));
  const started = !!execution && (execution.startedAt !== undefined || execution.status !== 'planned');
  const terminal = occurrence.status === 'completed' || occurrence.status === 'cancelled'
    || execution?.status === 'ended' || execution?.status === 'completed';
  const current = started ? actual : terminal ? undefined : chosen;
  const showNext = !terminal && (!started || !!actual && actual.id === chosen?.id);
  const next = showNext ? books.find(book => book.id === choice?.nextReadingId) : undefined;
  const result: ScheduleReadingDetails = { current, next, choiceCurrent: chosen,
    actualUnavailable: started && !actual, showNext,
    currentLabel: terminal ? '本场阅读' : started ? '当前阅读' : '计划阅读',
    exhausted: !started && !terminal && !!choice && choice.currentReadingId === null, notices: [], results: [] };
  const activityIds = new Set<string>();
  if (execution?.activityId) activityIds.add(execution.activityId);
  if (execution?.completionId) activityIds.add(execution.completionId);
  for (const book of books) {
    const activity = book.iReading?.activity;
    if (activity?.schedule?.itemId !== occurrence.itemId) continue;
    if (execution?.completionId && (activity.schedule.completionId ?? activity.id) !== execution.completionId) continue;
    activityIds.add(activity.id);
    if (activity.schedule.previousActivityId) activityIds.add(activity.schedule.previousActivityId);
  }
  if (current?.programme?.preparation === 'failed' && execution?.startedAt === undefined) result.notices.push({
    title: '阅读材料暂时没备好', body: '尚未开始阅读，可以稍后重试准备。', code: current.programme.errorCode,
  });
  if (!started && !terminal && (choice?.currentReadingId || occurrence.readingId) && !current) result.notices.push({ title: '关联材料不可用', body: '当前阅读来源未找到。' });
  if (showNext && choice?.nextReadingId && !next) result.notices.push({ title: '下一项材料不可用', body: '接续来源未找到。' });
  for (const { book, chapter, notes } of sources) for (const segment of chapter.segmentsMeta) {
    const request = segment.request;
    const version = readingSegmentSourceVersion(chapter, segment);
    const operationId = segment.resultOperationId ?? request?.id;
    const activityId = request ? request.resultActivityId : segment.resultActivityId;
    const belongs = activityIds.has(activityId ?? '');
    const atCursor = !terminal && (activityId === undefined || belongs)
      && current?.id === book.id && book.iReading?.cursor.chapterIndex === chapter.index
      && book.iReading.cursor.segmentIndex === segment.segmentIndex;
    // A previous occurrence's unresolved request blocks this cursor too, but its results
    // must never be attributed to this occurrence. Keep the blocker visible after time ends.
    const previousBlocker = !belongs && !!request && !request.result && segment.status !== 'done'
      && !!(request.transportStartedAt || request.save?.attempts)
      && current?.id === book.id && book.iReading?.cursor.chapterIndex === chapter.index
      && book.iReading.cursor.segmentIndex === segment.segmentIndex;
    if (!belongs && !atCursor && !previousBlocker) continue;
    if ((request && request.sourceVersion !== version) || (segment.sourceVersion && segment.sourceVersion !== version)) continue;
    if (previousBlocker) {
      result.notices.push({ title: '当前段落被旧请求挡住',
        body: '旧请求的结果尚无法确认，这场没有重新请求这一段。可在阅读库中查看该段，并确认是否重新生成。',
        code: 'reading-blocked-by-previous-request' });
      continue;
    }
    const annotations = notes.annotations.filter(note => note.resultOperationId === operationId && note.sourceVersion === version);
    const summary = notes.summaries.find(note => note.resultOperationId === operationId && note.sourceVersion === version);
    const storedResult = request?.result;
    const done = segment.status === 'done' && !!segment.resultOperationId
      && (!request?.save || request.save.outcome === 'complete');
    if (done && belongs && (summary || annotations.length)) {
      const dates = [...annotations.map(note => note.createdAt), ...(summary ? [summary.createdAt] : [])];
      result.results.push({ key: `${book.id}:${chapter.index}:${segment.segmentIndex}:${operationId}`, title: book.title,
        chapter: chapter.title, savedAt: Math.min(...dates), summary: summary?.summary ?? '', annotations: annotations.map(note => note.text) });
    }
    if (done) continue;
    const save = request?.save;
    if (save?.outcome === 'unknown') result.notices.push({ ...savingUnknown,
      code: /^reading-save-failed:(source-check|attempt-record|result-record|annotations|completion-record|save-reconcile)$/.test(segment.errorMessage ?? '')
        ? segment.errorMessage : undefined });
    else if (save && (save.attempts >= 4 || save.outcome === 'exhausted')) result.notices.push({
      title: '自动补存已停止', body: '同一结果的保存尝试已用完，不会自动重新生成。', code: segment.errorMessage,
    });
    else if (storedResult && (!save || save.attempts < 4)) result.notices.push({
      title: '阅读结果已保留，保存尚未完成', body: '后续继续保存这份结果，不重新请求模型。', code: segment.errorMessage,
    });
    else if (save?.resultRetained || save?.attempts) result.notices.push(savingUnknown);
    else if (segment.status === 'failed' || segment.errorMessage === 'reading-request-failed') result.notices.push({
      title: '这段暂时没读成', body: '下次取得阅读机会时，仍从这一段继续，不会跳到后面。', code: segment.errorMessage,
    });
  }
  result.notices = result.notices.filter((notice, index, all) => all.findIndex(other => other.title === notice.title && other.code === notice.code) === index);
  result.results.sort((left, right) => left.savedAt - right.savedAt);
  return result;
}

export function scheduleReadingProgress(book: ReadingBook): string {
  if (book.programme && book.programme.preparation !== 'ready') return book.programme.preparation === 'preparing' ? '文字稿准备中' : '文字稿尚未备好';
  const progress = book.iReading;
  if (!progress) return '尚未开始阅读';
  if (progress.needsSourceConfirmation) return '接读起点待确认';
  if (progress.reachedEnd) return book.contentType === 'programme' ? '已读完本期文字稿。' : '已读到内容末尾';
  return `读到第 ${progress.cursor.chapterIndex + 1} 章 · 第 ${progress.cursor.segmentIndex + 1} 段`;
}

/** Strict reads: failed storage is not an empty library or an exhausted save. */
export async function loadScheduleReadingDetails(occurrence: ScheduleOccurrence): Promise<ScheduleReadingDetails> {
  if (!occurrence.readingId && !occurrence.execution?.readingChoice) return { exhausted: false, notices: [], results: [] };
  const books = await loadReadingLibraryStrict();
  const ref = occurrence.execution?.readingChoice;
  let choice: ScheduleReadingChoiceValue | undefined;
  if (ref) {
    const root = await loadScheduleItemById(ref.sourceId);
    const value = root?.execution?.readingChoice;
    if (!root || root.owner !== 'I' || !value || !('version' in value) || value.sourceId !== root.id) throw new Error('reading-choice-unavailable');
    choice = value;
  }
  const terminal = occurrence.status === 'completed' || occurrence.status === 'cancelled'
    || occurrence.execution?.status === 'ended' || occurrence.execution?.status === 'completed';
  const unstarted = !occurrence.execution || occurrence.execution.status === 'planned' && occurrence.execution.startedAt === undefined;
  const relevant = books.filter(book => book.id === occurrence.readingId
    || !terminal && unstarted && book.id === choice?.currentReadingId
    || book.iReading?.activity?.schedule?.itemId === occurrence.itemId);
  const sources: ChapterNotes[] = [];
  for (const book of relevant) for (let index = 0; index < book.totalChapters; index += 1) {
    const chapter = await loadReadingChapter(book.id, index, true);
    if (!chapter) {
      if (!book.programme || book.programme.preparation === 'ready') throw new Error('reading-chapter-unavailable');
      continue;
    }
    const notes = await loadReadingAnnotations(book.id, index, true);
    sources.push({ book, chapter, notes });
  }
  return projectScheduleReadingDetails(occurrence, books, choice, sources);
}
