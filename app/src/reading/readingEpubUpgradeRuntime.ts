import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { readEpubSourceChapters, prepareEpubSourceImages, renderEpubChapterHtml } from './epubImport';
import { findLegacyEpubSourceChapter, mapLegacyEpubChapter, type EpubSourceChapter } from './readingEpubUpgrade';
import { createReadingProgress, readingSegmentSourceVersion } from './readingDailyPolicy';
import { retryReadingSave } from './readingSegmentRuntime';
import { getReadingBookDirectory, getReadingBookFileStatus, loadReadingAnnotations, loadReadingChapter,
  loadReadingLibraryStrict, runReadingStoreExclusive, saveReadingChapterWithinWrite, saveReadingLibrary } from './readingStore';
import type { ReadingBook, ReadingImage } from './readingTypes';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { computeOrderedReadingSegments } from './readingContent';
import { recoverReadingAnchor } from './readingSourceAnchor';
import { loadReadingNotes, saveReadingNotes, saveReadingAnnotations } from './readingStore';

type Position = { chapterIndex: number; segmentIndex: number };
type Options = { now?: number; decodeImage?: (base64: string, sourcePath: string) => Promise<{ width: number; height: number }> };
export type EpubRecoveryChoice = { chapterIndex: number; blockIndex: number; revision: string; dataEpoch: number };
export type EpubRecoveryPreview = { dataEpoch: number; chapters: Array<{
  index: number; title: string; revision: string; blocks: Array<{ index: number; label: string }>;
}> };

function recoveryGroups(sources: EpubSourceChapter[]) {
  const textStarts = sources.flatMap((source, index) => source.legacyParagraphs.length ? [index] : []);
  return textStarts.map((start, index) => {
    const group = sources.slice(index === 0 ? 0 : start, textStarts[index + 1] ?? sources.length);
    const paragraphs: string[] = [];
    const contentBlocks = group.flatMap(source => {
      const offset = paragraphs.length;
      paragraphs.push(...source.paragraphs);
      return source.contentBlocks.map(block => block.kind === 'text' ? { ...block, paragraphIndex: block.paragraphIndex + offset } : { ...block });
    });
    return { group, paragraphs, contentBlocks, title: sources[start].title,
      revision: bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(group.map(s => [s.sourcePath, s.sourceVersion]))))) };
  });
}

async function recoverySource(bookId: string) {
  const book = (await loadReadingLibraryStrict()).find(item => item.id === bookId);
  if (!book || book.fileType !== 'epub') throw new Error('reading-epub-book-missing');
  const files = await getReadingBookFileStatus(book);
  if (!files.sourceUri) throw new Error('reading-epub-source-missing');
  const groups = recoveryGroups(await readEpubSourceChapters(files.sourceUri));
  // This repair changes the old extractor's paragraphs, not the identity of an unrelated replacement book.
  if (groups.length !== book.totalChapters) throw new Error('reading-epub-chapter-structure-changed');
  return { book, uri: files.sourceUri, groups };
}

/** Read-only original-source picker. Its choice is bound to the shown source and restore epoch. */
export async function previewLegacyEpubRecovery(bookId: string): Promise<EpubRecoveryPreview> {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) throw new Error('reading-source-restore');
  const { groups } = await recoverySource(bookId);
  const saved = await Promise.all(groups.map((_, index) => loadReadingChapter(bookId, index)));
  return { dataEpoch: epoch, chapters: groups.map((g, index) => ({ index, title: g.title, revision: g.revision,
    blocks: g.contentBlocks.map((block, index) => ({ index, label: block.kind === 'image' ? '插图'
      : g.paragraphs[block.paragraphIndex].slice(block.startOffset, block.endOffset) }))
      .filter(block => saved[index]?.sourceRevision !== g.revision || saved[index]?.segmentsMeta.some(part =>
        part.contentRange?.startBlock === block.index && part.contentRange.startOffset === 0)) })) };
}

/** Approved legacy exception: keep old result identities; only exact anchors attach to the replacement text. */
export async function recoverLegacyEpubReadingSource(bookId: string, choice: EpubRecoveryChoice, options: Options = {}) {
  const committed = await runReadingStoreExclusive(() => runBackupRestoreDataEpochCommit(choice.dataEpoch, async () => {
    const { book, uri, groups } = await recoverySource(bookId);
    const selected = groups[choice.chapterIndex];
    if (!selected || selected.revision !== choice.revision || !Number.isSafeInteger(choice.blockIndex)
      || !selected.contentBlocks[choice.blockIndex]) throw new Error('reading-epub-choice-changed');
    const now = options.now ?? Date.now();
    const previous = book.iReading ?? createReadingProgress(now);
    const chapters = await Promise.all(groups.map((_, index) => loadReadingChapter(bookId, index)));
    if (book.iReading && !previous.needsSourceConfirmation) {
      // A repeated UI callback after a successful repair must not rewind later reading.
      if (chapters[choice.chapterIndex]?.sourceRevision === choice.revision) return true;
      throw new Error('reading-start-already-confirmed');
    }
    if (chapters.some(chapter => !chapter || chapter.segmentsMeta.some(part => part.request || part.status === 'annotating'))) {
      throw new Error('reading-epub-result-pending');
    }
    const writeState = async (state: typeof previous) => {
      const latest = await loadReadingLibraryStrict();
      await retryReadingSave(() => saveReadingLibrary(latest.map(item => item.id === bookId ? { ...item, iReading: state } : item)));
    };
    await writeState({ ...previous, needsSourceConfirmation: true, updatedAt: Math.max(now, previous.updatedAt + 1) });
    let selectedSegment: number | undefined;
    for (const [index, group] of groups.entries()) {
      const old = chapters[index]!;
      if (old.sourceRevision === group.revision) {
        if (index === choice.chapterIndex) selectedSegment = old.segmentsMeta.find(part => part.contentRange
          && part.contentRange.startBlock === choice.blockIndex && part.contentRange.startOffset === 0)?.segmentIndex;
        continue;
      }
      // Already ordered, untouched chapters retain their adopted ranges and results.
      if (old.contentBlocks && index !== choice.chapterIndex) continue;
      const records = await loadReadingAnnotations(bookId, index, true);
      const notes = await loadReadingNotes(bookId, true);
      const firstId = 1 + Math.max(-1, ...old.segmentsMeta.map(s => s.segmentIndex),
        ...records.annotations.map(s => s.segmentIndex), ...records.summaries.map(s => s.segmentIndex));
      const blocksBefore = index === choice.chapterIndex ? choice.blockIndex : 0;
      const prefix = blocksBefore ? computeOrderedReadingSegments({ ...group, contentBlocks: group.contentBlocks.slice(0, blocksBefore) }, { segmentIndex: firstId }) : [];
      const tail = computeOrderedReadingSegments(group, { segmentIndex: firstId + prefix.length, startBlock: blocksBefore });
      const images = new Map<string, ReadingImage>();
      for (const source of group.group) for (const image of await prepareEpubSourceImages(uri, getReadingBookDirectory(bookId), source, options)) images.set(image.id, image);
      const next = { ...old, title: group.title, sourceRevision: group.revision, paragraphs: group.paragraphs,
        textContent: group.paragraphs.join('\n\n'), charCount: group.paragraphs.reduce((n, p) => n + p.length, 0),
        contentBlocks: group.contentBlocks, images: [...images.values()], imageDescriptions: undefined,
        segmentsMeta: [...prefix, ...tail], htmlContent: renderEpubChapterHtml(group.paragraphs, group.contentBlocks,
          [...images.values()], group.group.flatMap(source => source.imageReferences)) };
      // Save identity/attachment metadata before replacing the source. Retrying does not change IDs or dates.
      await retryReadingSave(() => saveReadingAnnotations(bookId, index, {
        annotations: records.annotations.map(item => ({ ...item, sourceAnchor: recoverReadingAnchor(old, group.paragraphs, group.revision, item, item.p) })),
        summaries: records.summaries.map(item => ({ ...item, sourceAnchor: recoverReadingAnchor(old, group.paragraphs, group.revision, item) })),
      }));
      await retryReadingSave(() => saveReadingNotes(bookId, notes.map(item => item.chapterIndex !== index ? item
        : { ...item, sourceAnchor: recoverReadingAnchor(old, group.paragraphs, group.revision, item, item.startP, item.endP) })));
      await retryReadingSave(() => saveReadingChapterWithinWrite(next));
      if (index === choice.chapterIndex) selectedSegment = tail[0]?.segmentIndex;
    }
    if (selectedSegment === undefined) throw new Error('reading-epub-choice-unavailable');
    await writeState({ ...previous, cursor: { chapterIndex: choice.chapterIndex, segmentIndex: selectedSegment },
      needsSourceConfirmation: false, reachedEnd: false, completedAll: false, updatedAt: Math.max(now, previous.updatedAt + 2) });
    return true;
  }));
  return committed.committed && committed.value;
}
export type LegacyEpubUpgradeResult = { status: 'ready' | 'needs-confirmation' | 'pending-result' | 'unavailable'; reason?: string };

export function ensureLegacyEpubReadingSource(bookId: string, options: Options = {}) {
  return upgrade(bookId, undefined, options);
}

/** Explicit selection retains elapsed work/history; it cannot waive an uncertain source mapping. */
export function confirmLegacyEpubReadingSource(bookId: string, position: Position, options: Options = {}) {
  return upgrade(bookId, position, options);
}

async function upgrade(bookId: string, confirmed: Position | undefined, options: Options): Promise<LegacyEpubUpgradeResult> {
  const epoch = captureBackupRestoreDataEpoch();
  try {
    // This is a one-time local-file upgrade, with no network or model under either lock.
    const result = await runReadingStoreExclusive(() => runBackupRestoreDataEpochCommit(epoch, async (): Promise<LegacyEpubUpgradeResult> => {
      const books = await loadReadingLibraryStrict();
      let book = books.find(item => item.id === bookId);
      if (!book) return { status: 'unavailable', reason: 'book-missing' };
      if (book.fileType !== 'epub') return { status: 'ready' };
      const position = confirmed ?? book.iReading?.cursor;
      if (!position) return { status: 'needs-confirmation', reason: 'start-missing' };
      const now = options.now ?? Date.now();
      const writeState = async (needs: boolean) => {
        const previous = book!.iReading;
        if (!previous && (!confirmed || needs)) return;
        const state = previous ?? createReadingProgress(now, position.chapterIndex, position.segmentIndex);
        const iReading = { ...state, needsSourceConfirmation: needs,
          ...(!needs && confirmed ? { cursor: { ...position }, reachedEnd: false, completedAll: false } : {}),
          updatedAt: Math.max(now, state.updatedAt + 1) };
        const next: ReadingBook = { ...book!, iReading };
        await retryReadingSave(() => saveReadingLibrary(books.map(item => item.id === bookId ? next : item)));
        book = next;
      };
      const needs = async (reason: string): Promise<LegacyEpubUpgradeResult> => {
        if (!book!.iReading?.needsSourceConfirmation) await writeState(true);
        return { status: 'needs-confirmation', reason };
      };
      const chapter = await loadReadingChapter(bookId, position.chapterIndex);
      const segment = chapter?.segmentsMeta.find(part => part.segmentIndex === position.segmentIndex);
      if (!chapter || !segment) return needs('position-missing');
      if (segment.request || segment.status === 'annotating') return { status: 'pending-result' };
      if (segment.status === 'done') {
        const results = await loadReadingAnnotations(bookId, chapter.index);
        if (segment.resultOperationId && segment.sourceVersion === readingSegmentSourceVersion(chapter, segment)
          && [...results.annotations, ...results.summaries].some(item => item.resultOperationId === segment.resultOperationId
            && item.sourceVersion === segment.sourceVersion)) return { status: 'pending-result' };
        return needs('saved-tail');
      }
      if (book.iReading?.needsSourceConfirmation && !confirmed) return { status: 'needs-confirmation' };
      if (chapter.contentBlocks && segment.contentRange) {
        if (confirmed) await writeState(false);
        return { status: 'ready' };
      }
      const files = await getReadingBookFileStatus(book);
      if (!files.sourceUri) return { status: 'unavailable', reason: 'source-missing' };
      const sources = await readEpubSourceChapters(files.sourceUri);
      const textSources = sources.filter(source => source.legacyParagraphs.length > 0);
      // A formerly dropped text page or skipped broken spine entry is not silently assigned a chapter number.
      if (textSources.length !== book.totalChapters || sources.some(source => !source.legacyParagraphs.length && source.paragraphs.length)) {
        return needs('spine-unmapped');
      }
      const source = findLegacyEpubSourceChapter(chapter, sources);
      if (!source || source !== textSources[position.chapterIndex]) return needs('chapter-unmapped');
      const sourceIndex = sources.indexOf(source);
      if (!confirmed) {
        const previousSource = textSources[position.chapterIndex - 1];
        const earlierPictures = sources.slice(previousSource ? sources.indexOf(previousSource) + 1 : 0, sourceIndex)
          .flatMap(item => item.contentBlocks);
        if (earlierPictures.length && position.chapterIndex > 0) {
          const previousChapter = await loadReadingChapter(bookId, position.chapterIndex - 1);
          const savedTail = previousChapter?.contentBlocks?.slice(-earlierPictures.length);
          if (JSON.stringify(savedTail) !== JSON.stringify(earlierPictures)) return needs('earlier-picture-unread');
        } else if (earlierPictures.length && segment.startP > 0) return needs('earlier-picture-unread');
      }
      const nextText = sources.findIndex((item, index) => index > sourceIndex && item.legacyParagraphs.length > 0);
      const group: EpubSourceChapter[] = [
        ...(position.chapterIndex === 0 ? sources.slice(0, sourceIndex) : []), source,
        ...sources.slice(sourceIndex + 1, nextText < 0 ? sources.length : nextText),
      ];
      if (group.some(item => item !== source && item.paragraphs.length)) return needs('picture-neighbor-unmapped');
      const combined: EpubSourceChapter = { ...source,
        contentBlocks: group.flatMap(item => item.contentBlocks), imageReferences: group.flatMap(item => item.imageReferences) };
      const mapping = mapLegacyEpubChapter(chapter, combined, position.segmentIndex);
      if (mapping.status === 'pending-result') return mapping;
      if (mapping.status !== 'mapped') return needs(mapping.reason);
      const annotations = await loadReadingAnnotations(bookId, chapter.index);
      if ([...annotations.annotations, ...annotations.summaries].some(item => item.segmentIndex >= position.segmentIndex)) return needs('saved-tail');
      const images = new Map<string, ReadingImage>();
      for (const item of group) {
        for (const image of await prepareEpubSourceImages(files.sourceUri, getReadingBookDirectory(bookId), item, options)) images.set(image.id, image);
      }
      // A crash after the chapter write remains visibly unfinished, never a silent text-only success.
      await writeState(true);
      await retryReadingSave(() => saveReadingChapterWithinWrite({ ...chapter, paragraphs: mapping.paragraphs,
        contentBlocks: mapping.contentBlocks, images: [...images.values()], segmentsMeta: mapping.segmentsMeta,
        htmlContent: renderEpubChapterHtml(mapping.paragraphs, mapping.contentBlocks, [...images.values()], mapping.imageReferences) }));
      await writeState(false);
      return { status: 'ready' };
    }));
    return result.committed ? result.value : { status: 'unavailable', reason: 'data-restored' };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : 'source-unavailable' };
  }
}
