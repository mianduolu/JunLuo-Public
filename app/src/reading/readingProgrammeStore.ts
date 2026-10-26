import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { createReadingProgress, readingSegmentSourceVersion } from './readingDailyPolicy';
import { selectedReadingBlocks } from './readingContent';
import { segmentProgrammeChapter } from './readingProgrammePolicy';
import { canonicalProgrammeSource, programmeDownloadSupported, fetchProgrammeCatalog, fetchProgrammeDuration, fetchProgrammeTranscript, parseProgrammeCaptions,
  type ProgrammeEpisode, type ProgrammeFetcher, type ProgrammeTranscript } from './readingProgrammeSource';
import { loadReadingChapter, loadReadingLibraryStrict, runReadingStoreExclusive, saveReadingChapterWithinWrite, saveReadingLibrary } from './readingStore';
import { retryReadingSave } from './readingSegmentRuntime';
import type { ReadingBook, ReadingChapter } from './readingTypes';

const activeDownloads = new Map<string, Promise<ReadingBook>>();
export const programmeDownloadActive = (id: string) => activeDownloads.has(id);
const publicFetch: ProgrammeFetcher = (url, options) => fetch(url, options);
const transcriptVersion = (paragraphs: string[], cues: ProgrammeTranscript['cues']) =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([paragraphs, cues]))));

export const canDownloadProgramme = (book: ReadingBook) => !!book.programme && !book.programme.episodes && programmeDownloadSupported(book.programme.sourceUrl);

/** Explicit metadata save only. Existing identity, transcript and reading progress win on repeat. */
export async function addProgrammeToLibrary(input: { title: string; sourceUrl: string; series: string; language: string }) {
  const epoch = captureBackupRestoreDataEpoch();
  const title = input.title.trim(), series = input.series.trim(), language = input.language.trim();
  if (!title || title.length > 160 || !series || series.length > 500
    || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language) || language.length > 24
    || input.sourceUrl.length > 4096) throw new Error('programme-metadata-invalid');
  const sourceUrl = canonicalProgrammeSource(input.sourceUrl.trim());
  const id = `programme-${bytesToHex(sha256(new TextEncoder().encode(sourceUrl)))}`;
  return commit(epoch, async () => {
    const books = await loadReadingLibraryStrict();
    const existing = books.find(book => book.id === id || book.programme?.sourceUrl === sourceUrl);
    if (existing) return existing;
    const now = Date.now();
    const book: ReadingBook = { id, title, author: '', language, contentType: 'programme', fileType: 'url',
      totalChapters: 0, currentChapter: 0, currentParagraph: 0, progressFraction: 0, importedAt: now,
      iReading: createReadingProgress(now), programme: { sourceUrl, series, sourceName: new URL(sourceUrl).hostname,
        language, preparation: 'missing', updatedAt: now } };
    await retryReadingSave(() => saveReadingLibrary([...books, book]));
    return book;
  });
}

/** An interrupted download is not a live job. Explicit retry may finish a saved source locally. */
export async function settleInterruptedProgrammePreparations() {
  const epoch = captureBackupRestoreDataEpoch();
  return commit(epoch, async () => {
    const books = await loadReadingLibraryStrict();
    let changed = false;
    const next = books.map(book => {
      if (book.programme?.preparation !== 'preparing' || activeDownloads.has(book.id)) return book;
      changed = true;
      return { ...book, programme: { ...book.programme, preparation: 'failed' as const,
        errorCode: 'programme-preparation-interrupted', updatedAt: Date.now() } };
    });
    if (changed) await retryReadingSave(() => saveReadingLibrary(next));
  });
}

export function retainProgrammeAdoptedPrefix(old: ReadingChapter, next: ReadingChapter) {
  const protectedParts = old.segmentsMeta.filter(p => p.status === 'done' || p.request);
  if (!protectedParts.length) return next;
  const last = protectedParts.at(-1)!;
  const prefix = old.segmentsMeta.filter(p => p.segmentIndex <= last.segmentIndex);
  if (!last.contentRange || prefix.some(p => !p.contentRange || readingSegmentSourceVersion(old, p) !== readingSegmentSourceVersion(next, p))) {
    throw new Error('programme-version-unmapped');
  }
  const end = last.contentRange;
  const after = (b: number, offset: number) => b > end.endBlock || b === end.endBlock && offset >= end.endOffset;
  const tail = next.segmentsMeta.filter(p => p.contentRange && after(p.contentRange.endBlock, p.contentRange.endOffset)
    && !(p.contentRange.endBlock === end.endBlock && p.contentRange.endOffset === end.endOffset)).map((p, index) => {
      const range = { ...p.contentRange! };
      if (!after(range.startBlock, range.startOffset)) { range.startBlock = end.endBlock; range.startOffset = end.endOffset; }
      const part = { ...p, contentRange: range, segmentIndex: last.segmentIndex + 1 + index };
      const selected = selectedReadingBlocks(next, part);
      const ids = selected.filter(b => b.block.kind === 'text').map(b => b.block.kind === 'text' ? b.block.paragraphIndex : 0);
      return { ...part, startP: Math.min(...ids), endP: Math.max(...ids), charCount: selected.reduce((n, b) => n + b.text.length, 0) };
    });
  return { ...next, segmentsMeta: [...prefix, ...tail] };
}

async function commit<T>(epoch: number | null, work: () => Promise<T>) {
  if (epoch === null) throw new Error('programme-restore');
  const result = await runReadingStoreExclusive(() => runBackupRestoreDataEpochCommit(epoch, work));
  if (!result.committed) throw new Error('programme-restore');
  return result.value;
}

/** Called only by explicit catalogue actions. Refresh never overwrites prepared source or progress. */
export async function refreshProgrammeCatalog(page: number | string = 1, fetcher: ProgrammeFetcher = publicFetch, now = Date.now()) {
  const epoch = captureBackupRestoreDataEpoch();
  const result = await fetchProgrammeCatalog(page, fetcher);
  if (result.episodes.some(episode => episode.title.length > 160)) throw new Error('programme-title-capacity');
  await commit(epoch, async () => {
    const books = await loadReadingLibraryStrict();
    const added: ReadingBook[] = result.episodes.filter(e => !books.some(b => b.id === e.id)).map(e => ({
      id: e.id, title: e.title, author: '', language: e.language, contentType: 'programme', fileType: 'url',
      totalChapters: 0, currentChapter: 0, currentParagraph: 0, progressFraction: 0, importedAt: now,
      iReading: createReadingProgress(now), programme: { sourceUrl: e.sourceUrl, series: e.series,
        sourceName: e.sourceName, language: e.language, durationMs: e.durationMs, preparation: 'missing', updatedAt: now },
    }));
    await retryReadingSave(() => saveReadingLibrary([...books, ...added]));
  });
  return result;
}

async function saveTranscript(book: ReadingBook, transcript: ProgrammeTranscript, epoch: number | null, attemptedAt: number) {
  const hash = transcriptVersion(transcript.paragraphs, transcript.cues);
  const now = Date.now();
  return commit(epoch, async () => {
    const books = await loadReadingLibraryStrict();
    const current = books.find(b => b.id === book.id);
    if (!current?.programme || current.programme.sourceUrl !== book.programme!.sourceUrl
      || current.programme.attemptedAt !== attemptedAt) throw new Error('programme-source-changed');
    const old = await loadReadingChapter(book.id, 0);
    const chapter: ReadingChapter = segmentProgrammeChapter({ bookId: book.id, index: 0, title: book.title,
      textContent: transcript.text, paragraphs: transcript.paragraphs,
      charCount: transcript.text.length, segmentsMeta: [], programmeCues: transcript.cues, images: [],
      contentBlocks: transcript.paragraphs.map((p, paragraphIndex) => ({ kind: 'text', paragraphIndex, startOffset: 0, endOffset: p.length })),
    }, transcript.durationMs);
    const ready = chapter.segmentsMeta.length > 0;
    // If a prior local save reached disk, preserve its request/result identities.
    let savedChapter: ReadingChapter;
    try { savedChapter = old?.segmentsMeta.length && transcriptVersion(old.paragraphs, old.programmeCues ?? []) === hash
      ? old : old ? retainProgrammeAdoptedPrefix(old, chapter) : chapter; }
    catch (error) {
      // Preserve the original source/results on an unresolvable edit, but stop automatic consumption.
      await retryReadingSave(() => saveReadingLibrary(books.map(b => b.id === book.id ? { ...b,
        programme: { ...current.programme!, preparation: 'failed', errorCode: 'programme-version-unmapped', updatedAt: now } } : b)));
      throw error;
    }
    const oldLastIndex = Math.max(-1, ...(old?.segmentsMeta.map(part => part.segmentIndex) ?? []));
    const firstNew = savedChapter.segmentsMeta.find(part => part.segmentIndex > oldLastIndex && part.status !== 'done' && !part.request);
    const progress = current.iReading?.reachedEnd && firstNew ? {
      ...current.iReading, cursor: { chapterIndex: 0, segmentIndex: firstNew.segmentIndex },
      reachedEnd: false, completedAll: false, updatedAt: Math.max(now, current.iReading.updatedAt + 1),
    } : current.iReading;
    const next: ReadingBook = { ...current, iReading: progress, totalChapters: 1, language: transcript.language,
      programme: { ...current.programme, preparation: ready ? 'ready' : 'failed', preparedAt: ready ? (current.programme.sourceVersion === hash ? current.programme.preparedAt ?? now : now) : undefined,
        durationMs: transcript.durationMs, transcriptUrl: transcript.sourceUrl, format: transcript.format,
        sourceVersion: hash, updatedAt: now, errorCode: ready ? undefined : 'programme-duration-missing' } };
    // Metadata is not a second transcript. It identifies a partial chapter save so an
    // explicit retry can finish local persistence without downloading the source again.
    await retryReadingSave(() => saveReadingLibrary(books.map(b => b.id === book.id
      ? { ...next, programme: { ...next.programme!, preparation: 'preparing' } } : b)));
    await retryReadingSave(() => saveReadingChapterWithinWrite(savedChapter));
    await retryReadingSave(() => saveReadingLibrary(books.map(b => b.id === book.id ? next : b)));
    return next;
  });
}

/** Download and local retries share one promise. No automatic retry after network failure. */
export function prepareProgramme(id: string, fetcher: ProgrammeFetcher = publicFetch): Promise<ReadingBook> {
  const existing = activeDownloads.get(id);
  if (existing) return existing;
  const work = prepareProgrammeOnce(id, fetcher).finally(() => { if (activeDownloads.get(id) === work) activeDownloads.delete(id); });
  activeDownloads.set(id, work);
  return work;
}
async function prepareProgrammeOnce(id: string, fetcher: ProgrammeFetcher) {
  const epoch = captureBackupRestoreDataEpoch();
  const attemptedAt = Date.now();
  const book = await commit(epoch, async () => {
    const books = await loadReadingLibraryStrict();
    const current = books.find(b => b.id === id);
    if (!current?.programme) throw new Error('programme-not-found');
    if (current.programme.episodes) throw new Error('collection-use-bundle');
    if (current.programme.preparation === 'ready') return current;
    const next: ReadingBook = { ...current, programme: { ...current.programme, preparation: 'preparing',
      attemptedAt, updatedAt: attemptedAt, errorCode: undefined } };
    await retryReadingSave(() => saveReadingLibrary(books.map(b => b.id === id ? next : b)));
    return next;
  });
  if (book.programme!.preparation === 'ready') return book;
  try {
    const saved = await loadReadingChapter(id, 0);
    if (saved && book.programme!.sourceVersion === transcriptVersion(saved.paragraphs, saved.programmeCues ?? [])
      && book.programme!.format && book.programme!.transcriptUrl) {
      const durationMs = book.programme!.durationMs
        ?? await fetchProgrammeDuration({ id, title: book.title, ...book.programme! }, fetcher);
      return await saveTranscript(book, { text: saved.textContent, paragraphs: saved.paragraphs,
        cues: saved.programmeCues ?? [], durationMs,
        format: book.programme!.format!, sourceUrl: book.programme!.transcriptUrl!, language: book.programme!.language }, epoch, attemptedAt);
    }
    const episode: ProgrammeEpisode = { id, title: book.title, ...book.programme! };
    const transcript = await fetchProgrammeTranscript(episode, fetcher);
    return await saveTranscript(book, transcript, epoch, attemptedAt);
  } catch (error) {
    const code = error instanceof Error && /^programme-[\w-]+$/.test(error.message) ? error.message : 'programme-preparation-failed';
    await commit(epoch, async () => {
      const books = await loadReadingLibraryStrict();
      const current = books.find(b => b.id === id);
      if (!current?.programme || current.programme.attemptedAt !== attemptedAt || current.programme.preparation === 'ready') return;
      await retryReadingSave(() => saveReadingLibrary(books.map(b => b.id === id ? { ...b,
        programme: { ...current.programme!, preparation: 'failed', errorCode: code, updatedAt: Date.now() } } : b)));
    });
    throw error;
  }
}

/** Explicit file import. Caption voices stay source text, never become conversation roles. */
export async function importProgrammeTranscript(id: string, text: string, format: 'srt' | 'vtt' | 'txt', durationMs?: number) {
  const epoch = captureBackupRestoreDataEpoch();
  const attemptedAt = Date.now();
  const book = await commit(epoch, async () => {
    const books = await loadReadingLibraryStrict();
    const current = books.find(b => b.id === id);
    if (!current?.programme) throw new Error('programme-not-found');
    if (current.programme.episodes) throw new Error('collection-use-bundle');
    const next = { ...current, programme: { ...current.programme, attemptedAt, updatedAt: attemptedAt } };
    await retryReadingSave(() => saveReadingLibrary(books.map(b => b.id === id ? next : b)));
    return next;
  });
  const parsed = format === 'txt' ? { paragraphs: text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean), cues: [] }
    : parseProgrammeCaptions(text, format);
  const resolvedDuration = durationMs ?? parsed.cues.at(-1)?.endMs ?? book.programme!.durationMs;
  return saveTranscript(book, { ...parsed, text: parsed.paragraphs.join('\n\n'), format: format === 'txt' ? 'html' : format,
    durationMs: resolvedDuration, language: book.programme!.language, sourceUrl: book.programme!.sourceUrl }, epoch, attemptedAt);
}
