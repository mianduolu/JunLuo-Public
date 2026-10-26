import type { ReadingChapter, ReadingSourceAnchor } from './readingTypes';

export function normalizeReadingSourceAnchor(value: unknown): ReadingSourceAnchor | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('reading-source-anchor-invalid');
  const item = value as ReadingSourceAnchor;
  if (typeof item.revision !== 'string' || !item.revision || typeof item.originalChapterTitle !== 'string'
    || (item.p !== undefined && (!Number.isSafeInteger(item.p) || item.p < 0))
    || (item.endP !== undefined && (item.p === undefined || !Number.isSafeInteger(item.endP) || item.endP < item.p))) {
    throw new Error('reading-source-anchor-invalid');
  }
  return { revision: item.revision, originalChapterTitle: item.originalChapterTitle,
    ...(item.p !== undefined ? { p: item.p } : {}), ...(item.endP !== undefined ? { endP: item.endP } : {}) };
}

export function readingSourceParagraph(chapter: ReadingChapter | null, item: { sourceAnchor?: ReadingSourceAnchor }, originalP: number) {
  const anchor = item.sourceAnchor;
  if (!anchor) return originalP;
  return anchor.revision === chapter?.sourceRevision && anchor.p !== undefined && chapter.paragraphs[anchor.p] !== undefined
    ? anchor.p : undefined;
}

/** Only exact, unique paragraph text is a reliable attachment. Old p is never rewritten. */
export function recoverReadingAnchor(old: ReadingChapter, paragraphs: string[], revision: string,
  item: { sourceAnchor?: ReadingSourceAnchor }, startP?: number, endP = startP): ReadingSourceAnchor {
  if (item.sourceAnchor?.revision === revision) return item.sourceAnchor;
  const first = startP === undefined ? undefined : readingSourceParagraph(old, item, startP);
  const last = item.sourceAnchor?.endP ?? endP;
  const text = first === undefined || last === undefined ? [] : old.paragraphs.slice(first, last + 1);
  const matches = text.length ? paragraphs.flatMap((_, p) => text.every((line, offset) => line === paragraphs[p + offset]) ? [p] : []) : [];
  return { revision, originalChapterTitle: item.sourceAnchor?.originalChapterTitle ?? old.title,
    ...(matches.length === 1 ? { p: matches[0], endP: matches[0] + text.length - 1 } : {}) };
}
