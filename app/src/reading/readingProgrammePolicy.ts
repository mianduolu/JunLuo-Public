import type { ReadingBook, ReadingChapter, ReadingProgramme, ReadingProgrammeCue, ReadingSegmentMeta } from './readingTypes';
import { computeOrderedReadingSegments, selectedReadingBlocks } from './readingContent';
import { formatReadingPosition, READING_INTERVAL_MS } from './readingDailyPolicy';

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
export function normalizeReadingProgramme(value: unknown): ReadingProgramme | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as ReadingProgramme;
  if (v.episodes !== undefined && (!Array.isArray(v.episodes) || v.episodes.length < 2 || v.episodes.length > 200
    || !v.episodes.every(e => e && [e.title, e.sourceUrl, e.sourceName, e.language].every(s => typeof s === 'string' && !!s.trim())
      && Number.isSafeInteger(e.durationMs) && e.durationMs > 0)
    || new Set(v.episodes.map(e => e.sourceUrl)).size !== v.episodes.length)) throw new Error('collection-manifest-invalid');
  if (![v.sourceUrl, v.series, v.sourceName, v.language].every(s => typeof s === 'string' && !!s.trim())
    || !['missing', 'preparing', 'ready', 'failed'].includes(v.preparation)
    || typeof v.updatedAt !== 'number' || !Number.isFinite(v.updatedAt) || v.updatedAt < 0) return undefined;
  return { sourceUrl: v.sourceUrl, series: v.series, sourceName: v.sourceName, language: v.language,
    ...(v.episodes ? { episodes: v.episodes.map(e => ({
        title: e.title, sourceUrl: e.sourceUrl, sourceName: e.sourceName, language: e.language, durationMs: e.durationMs })) } : {}),
    preparation: v.preparation, updatedAt: v.updatedAt,
    ...(positive(v.durationMs) ? { durationMs: v.durationMs } : {}),
    ...(positive(v.attemptedAt) ? { attemptedAt: v.attemptedAt } : {}),
    ...(positive(v.preparedAt) ? { preparedAt: v.preparedAt } : {}),
    ...(typeof v.errorCode === 'string' ? { errorCode: v.errorCode } : {}),
    ...(typeof v.transcriptUrl === 'string' ? { transcriptUrl: v.transcriptUrl } : {}),
    ...(['srt', 'vtt', 'html'].includes(v.format ?? '') ? { format: v.format } : {}),
    ...(typeof v.sourceVersion === 'string' ? { sourceVersion: v.sourceVersion } : {}),
  };
}

export function normalizeProgrammeCues(value: unknown, paragraphCount: number): ReadingProgrammeCue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((v, i) => v && Number.isSafeInteger(v.paragraphIndex) && v.paragraphIndex >= 0 && v.paragraphIndex < paragraphCount
    && Number.isFinite(v.startMs) && v.startMs >= 0 && Number.isFinite(v.endMs) && v.endMs > v.startMs
    && (!i || v.startMs >= value[i - 1].startMs))) return undefined;
  return value.map(v => ({ paragraphIndex: v.paragraphIndex, startMs: v.startMs, endMs: v.endMs }));
}

export function programmePreparationText(book: Pick<ReadingBook, 'programme'>) {
  return ({ missing: '字幕尚未准备。', preparing: '字幕正在准备。', ready: '字幕已准备好。', failed: '字幕暂时没备好。' })[book.programme?.preparation ?? 'missing'];
}
export function readingProgressText(book: Pick<ReadingBook, 'iReading' | 'programme'>) {
  const progress = book.iReading;
  return !progress || progress.needsSourceConfirmation ? '待确认起点' : progress.completedAll ? (book.programme?.episodes ? '本次接读已到结尾' : book.programme ? '已读完本期文字稿。' : '已完成全书阅读')
    : progress.reachedEnd ? '本次接读已到结尾'
      : progress.cursor.chapterIndex === 0 && progress.cursor.segmentIndex === 0 && !progress.activity ? '尚未开始'
        : `从${formatReadingPosition(progress.cursor.chapterIndex, progress.cursor.segmentIndex)}接读`;
}

/** Preserve each category's existing order, without letting a large shelf hide programmes. */
export function interleaveReadingItems<T extends { contentType?: string }>(items: T[]): T[] {
  const books = items.filter(b => b.contentType !== 'programme');
  const episodes = items.filter(b => b.contentType === 'programme');
  return Array.from({ length: Math.max(books.length, episodes.length) }, (_, i) => [books[i], episodes[i]])
    .flat().filter((item): item is T => !!item);
}

/** Each time bucket is capacity-split; dense subtitles require later 25-minute opportunities. */
export function segmentProgrammeChapter(chapter: ReadingChapter, durationMs?: number): ReadingChapter {
  const cues = chapter.programmeCues;
  if (!cues?.length && !positive(durationMs)) return { ...chapter, segmentsMeta: [] };
  const lengths = chapter.paragraphs.map(p => p.length);
  const totalChars = lengths.reduce((a, b) => a + b, 0);
  let consumed = 0;
  const spans = chapter.paragraphs.map((p, index) => {
    const cue = cues?.find(c => c.paragraphIndex === index);
    const startMs = cue?.startMs ?? consumed / Math.max(1, totalChars) * durationMs!;
    consumed += p.length;
    return { startMs, endMs: cue?.endMs ?? consumed / Math.max(1, totalChars) * durationMs! };
  });
  const blocks: NonNullable<ReadingChapter['contentBlocks']> = [];
  const blockSpans: Array<{ startMs: number; endMs: number }> = [];
  chapter.paragraphs.forEach((text, paragraphIndex) => {
    const span = spans[paragraphIndex];
    let startOffset = 0, startMs = span.startMs;
    while (startOffset < text.length) {
      const endMs = Math.min(span.endMs, (Math.floor(startMs / READING_INTERVAL_MS) + 1) * READING_INTERVAL_MS);
      let endOffset = endMs === span.endMs ? text.length
        : Math.max(startOffset + 1, Math.floor((endMs - span.startMs) / (span.endMs - span.startMs) * text.length));
      if (endOffset < text.length && /[\uD800-\uDBFF]/.test(text[endOffset - 1])) endOffset += 1;
      blocks.push({ kind: 'text', paragraphIndex, startOffset, endOffset });
      blockSpans.push({ startMs, endMs });
      startOffset = endOffset; startMs = endMs;
    }
  });
  const prepared = { ...chapter, contentBlocks: blocks };
  const count = blocks.length;
  const parts: ReadingSegmentMeta[] = [];
  let startBlock = 0;
  while (startBlock < count) {
    const first = blockSpans[startBlock];
    const boundary = (Math.floor(first.startMs / READING_INTERVAL_MS) + 1) * READING_INTERVAL_MS;
    let endBlock = startBlock + 1;
    while (endBlock < count && blockSpans[endBlock].startMs < boundary) endBlock += 1;
    // Limit the slice at a real paragraph boundary, retaining original paragraph indices.
    const view = { ...prepared, contentBlocks: blocks.slice(0, endBlock) };
    const segments = computeOrderedReadingSegments(view, { startBlock, segmentIndex: parts.length });
    for (const part of segments) {
      const range = part.contentRange!;
      const last = range.endOffset === 0 ? range.endBlock - 1 : range.endBlock;
      // Persist integer milliseconds. Outward rounding keeps even sub-ms ranges
      // nonempty; source blocks and the 25-minute opportunity boundaries stay intact.
      part.programmeRange = { startMs: Math.floor(blockSpans[range.startBlock].startMs),
        endMs: Math.ceil(blockSpans[Math.max(range.startBlock, last)].endMs), timed: !!cues?.length };
      parts.push(part);
    }
    startBlock = endBlock;
  }
  return { ...prepared, segmentsMeta: parts };
}

function timestamp(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
export function buildProgrammeCollectionMaterial(book: Pick<ReadingBook, 'title' | 'programme' | 'iReading'>, chapterIndex = book.iReading?.cursor.chapterIndex ?? 0) {
  const episode = book.programme?.episodes?.[chapterIndex];
  return episode ? `【节目合集】\n合集：${book.title}\n当前：第 ${chapterIndex + 1} 集《${episode.title}》\n后续按这份合集已保存的目录顺序接读。` : '';
}
export function buildProgrammeMetadata(book: ReadingBook, segment: ReadingSegmentMeta, chapterIndex = book.iReading?.cursor.chapterIndex ?? 0) {
  const p = book.programme!;
  const episode = p.episodes?.[chapterIndex];
  const range = segment.programmeRange;
  return (episode ? `${buildProgrammeCollectionMaterial(book, chapterIndex)}\n\n` : '')
    + `【节目】${episode?.title ?? book.title}\n【栏目】${p.series}\n【来源】${episode?.sourceName ?? p.sourceName}\n【原文语言】${episode?.language ?? p.language}\n【本次阅读位置】第 ${segment.segmentIndex + 1} 段${range?.timed ? '' : '（按全文粗分）'}`
    + (range?.timed ? `\n【对应节目时间】${timestamp(range.startMs)}—${timestamp(range.endMs)}` : '');
}
export function buildProgrammeSource(chapter: ReadingChapter, segment: ReadingSegmentMeta) {
  return '【这次读到的内容】\n\n以下是节目的文字稿。\n\n' + selectedReadingBlocks(chapter, segment)
    .filter(b => b.block.kind === 'text').map(b => `[${b.block.kind === 'text' ? b.block.paragraphIndex : 0}] ${b.text}`).join('\n\n');
}
