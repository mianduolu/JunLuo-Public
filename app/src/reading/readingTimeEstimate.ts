import { loadReadingAnnotations, loadReadingChapter } from './readingStore';
import { readingSegmentSourceVersion, READING_INTERVAL_MS } from './readingDailyPolicy';
import type { ReadingBook } from './readingTypes';

export type ReadingTimeEstimate = { remainingSegments: number; minutesUntilNext: number; estimatedMinutes: number };

export function readingTimeEstimate(remainingSegments: number, remainderMs: number): ReadingTimeEstimate {
  const minutesUntilNext = remainingSegments ? Math.ceil((READING_INTERVAL_MS - remainderMs % READING_INTERVAL_MS) / 60_000) : 0;
  return { remainingSegments, minutesUntilNext,
    estimatedMinutes: remainingSegments ? minutesUntilNext + (remainingSegments - 1) * 25 : 0 };
}

/** Only existing, version-matched source/results count. This never segments or requests material. */
export async function loadReadingTimeEstimate(book: ReadingBook): Promise<ReadingTimeEstimate | null> {
  const progress = book.iReading;
  if (!progress || progress.needsSourceConfirmation || progress.requestReservation
    || book.programme && book.programme.preparation !== 'ready' || !Number.isSafeInteger(book.totalChapters)
    || book.totalChapters <= 0 || !Number.isFinite(progress.remainderMs) || progress.remainderMs < 0) return null;
  let remaining = 0;
  try {
    for (let index = progress.cursor.chapterIndex; index < book.totalChapters; index += 1) {
      const chapter = await loadReadingChapter(book.id, index, true);
      if (!chapter?.segmentsMeta.length) return null;
      const notes = await loadReadingAnnotations(book.id, index, true);
      const parts = chapter.segmentsMeta.filter(part => index !== progress.cursor.chapterIndex || part.segmentIndex >= progress.cursor.segmentIndex);
      for (const part of parts) {
        const version = readingSegmentSourceVersion(chapter, part);
        if (part.status === 'done') {
          if (part.sourceVersion !== version || !part.resultOperationId || ![...notes.annotations, ...notes.summaries]
            .some(note => note.sourceVersion === version && note.resultOperationId === part.resultOperationId)) return null;
          continue;
        }
        if (part.status === 'stale') return null;
        const request = part.request;
        if (request?.sourceVersion === version && request.result && request.save?.resultRetained) continue;
        if (request?.save || part.status === 'annotating' || request?.transportStartedAt && part.status !== 'failed') return null;
        remaining += 1;
      }
    }
    return readingTimeEstimate(remaining, progress.remainderMs);
  } catch { return null; }
}

export function readingTimeEstimateMaterial(estimate: ReadingTimeEstimate | null, prepared = true) {
  if (!prepared) return '阅读材料尚未备齐，暂时无法估算剩余阅读时间。';
  if (!estimate) return '剩余阅读时间暂时无法估算。';
  return `还需阅读：${estimate.remainingSegments} 段\n距离下一次阅读机会：还需 ${estimate.minutesUntilNext} 分钟有效阅读\n顺利读完这些内容：还需累计约 ${estimate.estimatedMinutes} 分钟有效阅读\n\n以上时间不含暂停、准备材料和等待请求结果；请求失败时，实际所需时间会增加。`;
}
