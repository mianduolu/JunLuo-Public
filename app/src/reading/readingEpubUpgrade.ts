import type { ParsedEpubContent } from './epubContent';
import { computeOrderedReadingSegments } from './readingContent';
import type { ReadingChapter, ReadingSegmentMeta } from './readingTypes';

/** Source identities are EPUB paths, not new chapter numbers. Pure-image entries remain candidates. */
export type EpubSourceChapter = ParsedEpubContent & {
  sourcePath: string;
  sourceVersion: string;
  spineIndex: number;
  title: string;
  legacyParagraphs: string[];
};

type Mapping =
  | { status: 'needs-confirmation'; reason: 'paragraphs-changed' | 'unread-boundary' | 'saved-tail' }
  | { status: 'pending-result' }
  | { status: 'mapped'; chapterIndex: number; sourcePath: string; paragraphs: string[];
      contentBlocks: NonNullable<ReadingChapter['contentBlocks']>;
      imageReferences: EpubSourceChapter['imageReferences']; segmentsMeta: ReadingSegmentMeta[] };

/** Never guess a source chapter by a shifted index or repeated title/text. */
export function findLegacyEpubSourceChapter(chapter: ReadingChapter, sources: EpubSourceChapter[]): EpubSourceChapter | undefined {
  const matches = sources.filter(source => source.legacyParagraphs.length === chapter.paragraphs.length
    && source.legacyParagraphs.every((text, index) => text === chapter.paragraphs[index]));
  return matches.length === 1 ? matches[0] : undefined;
}

/** No writes and no progress reset. Only an untouched, exactly identified tail may be repartitioned. */
export function mapLegacyEpubChapter(chapter: ReadingChapter, source: EpubSourceChapter, unreadSegmentIndex: number): Mapping {
  const equal = (paragraphs: string[]) => paragraphs.length === chapter.paragraphs.length
    && paragraphs.every((text, index) => text === chapter.paragraphs[index]);
  if (!equal(source.legacyParagraphs) || !equal(source.paragraphs)) return { status: 'needs-confirmation', reason: 'paragraphs-changed' };
  const unread = chapter.segmentsMeta.find(part => part.segmentIndex === unreadSegmentIndex);
  if (!unread || unread.contentRange || !Number.isSafeInteger(unread.startP) || unread.startP < 0
    || unread.startP >= chapter.paragraphs.length) return { status: 'needs-confirmation', reason: 'unread-boundary' };
  const tail = chapter.segmentsMeta.filter(part => part.segmentIndex >= unreadSegmentIndex);
  if (tail.some(part => part.request || part.status === 'annotating')) return { status: 'pending-result' };
  if (tail.some(part => part.status === 'done' || part.sourceVersion || part.resultOperationId)) {
    return { status: 'needs-confirmation', reason: 'saved-tail' };
  }
  if (chapter.segmentsMeta.some(part => part.segmentIndex < unreadSegmentIndex && part.endP >= unread.startP)) {
    return { status: 'needs-confirmation', reason: 'unread-boundary' };
  }
  const blocks = source.contentBlocks;
  let startBlock = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.kind === 'text' && block.paragraphIndex < unread.startP) startBlock = index + 1;
  }
  // Images between the last old paragraph and the unread one have never been read.
  // Retain them without replaying or relabelling any already-read text.
  const segments = computeOrderedReadingSegments(source, { startBlock, segmentIndex: unreadSegmentIndex });
  if (!segments.length) return { status: 'needs-confirmation', reason: 'unread-boundary' };
  return { status: 'mapped', chapterIndex: chapter.index, sourcePath: source.sourcePath,
    paragraphs: [...chapter.paragraphs], contentBlocks: blocks.map(block => ({ ...block })),
    imageReferences: source.imageReferences.map(image => ({ ...image })),
    segmentsMeta: [...chapter.segmentsMeta.filter(part => part.segmentIndex < unreadSegmentIndex).map(part => ({ ...part })), ...segments] };
}
