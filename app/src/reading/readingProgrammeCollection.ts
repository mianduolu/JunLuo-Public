import JSZip from 'jszip';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { createReadingProgress } from './readingDailyPolicy';
import { canonicalProgrammeSource, parseProgrammeCaptions } from './readingProgrammeSource';
import { segmentProgrammeChapter } from './readingProgrammePolicy';
import { loadReadingChapter, loadReadingLibraryStrict, runReadingStoreExclusive, saveReadingChapterWithinWrite, saveReadingLibrary } from './readingStore';
import { retryReadingSave } from './readingSegmentRuntime';
import type { ReadingBook, ReadingChapter, ReadingProgramme } from './readingTypes';

type CollectionDraft = { epoch: number | null; book: ReadingBook; chapters: ReadingChapter[] };
const hash = (value: unknown) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
const chapterSource = (c: ReadingChapter) => [c.index, c.title, c.textContent, c.paragraphs, c.programmeCues, c.contentBlocks];
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error('collection-manifest-invalid');
  return value.trim();
}

/** A local ZIP contains an ordered manifest and original transcript files, never a job queue. */
export async function parseProgrammeCollection(base64: string): Promise<CollectionDraft> {
  const epoch = captureBackupRestoreDataEpoch();
  if (base64.length > 28_000_000) throw new Error('collection-file-too-large');
  const zip = await JSZip.loadAsync(base64, { base64: true });
  const manifest = zip.file('manifest.json');
  if (!manifest) throw new Error('collection-manifest-missing');
  const raw = JSON.parse(await manifest.async('string'));
  if (raw.version !== 1 || !Array.isArray(raw.episodes) || raw.episodes.length < 2 || raw.episodes.length > 200) throw new Error('collection-manifest-invalid');
  const title = text(raw.title, 160), series = text(raw.series, 500), language = text(raw.language, 24);
  const sourceUrl = canonicalProgrammeSource(text(raw.sourceUrl, 4096));
  const id = `programme-collection-${hash(sourceUrl)}`;
  const episodes: NonNullable<ReadingProgramme['episodes']> = [];
  const chapters: ReadingChapter[] = [];
  let size = 0;
  for (const entry of raw.episodes) {
    const episode = { title: text(entry.title, 160), sourceUrl: canonicalProgrammeSource(text(entry.sourceUrl, 4096)),
      sourceName: text(entry.sourceName, 500), language: text(entry.language, 24), durationMs: entry.durationMs as number };
    if (!Number.isSafeInteger(episode.durationMs) || episode.durationMs <= 0 || episodes.some(e => e.sourceUrl === episode.sourceUrl)) throw new Error('collection-manifest-invalid');
    const filename = text(entry.file, 500);
    const format = filename.split('.').at(-1)?.toLowerCase();
    const file = zip.file(filename);
    if (!file || !['txt', 'srt', 'vtt'].includes(format ?? '')) throw new Error('collection-transcript-missing');
    const body = await file.async('string');
    size += body.length;
    if (size > 10_000_000) throw new Error('collection-file-too-large');
    const parsed = format === 'txt' ? { paragraphs: body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean), cues: [] }
      : parseProgrammeCaptions(body, format as 'srt' | 'vtt');
    if (!parsed.paragraphs.length || (parsed.cues.at(-1)?.endMs ?? 0) > episode.durationMs) throw new Error('collection-transcript-invalid');
    const chapter = segmentProgrammeChapter({ bookId: id, index: episodes.length, title: episode.title,
      textContent: parsed.paragraphs.join('\n\n'), paragraphs: parsed.paragraphs, programmeCues: parsed.cues,
      charCount: parsed.paragraphs.join('\n\n').length, segmentsMeta: [], images: [] }, episode.durationMs);
    if (!chapter.segmentsMeta.length) throw new Error('collection-transcript-invalid');
    chapters.push(chapter); episodes.push(episode);
  }
  const now = Date.now();
  const durationMs = episodes.reduce((sum, e) => sum + e.durationMs, 0);
  if (!Number.isSafeInteger(durationMs)) throw new Error('collection-manifest-invalid');
  const book: ReadingBook = { id, title, author: '佚名', language, contentType: 'programme', fileType: 'url',
    totalChapters: chapters.length, currentChapter: 0, currentParagraph: 0, progressFraction: 0, importedAt: now,
    iReading: createReadingProgress(now), programme: { sourceUrl, series, sourceName: series, language, episodes,
      durationMs, preparation: 'preparing', updatedAt: now,
      sourceVersion: hash([title, sourceUrl, series, language, episodes, chapters.map(chapterSource)]) } };
  return { epoch, book, chapters };
}

/** Reopening the same bundle resumes a partial import; it never resets completed work. */
export async function importProgrammeCollection(draft: CollectionDraft): Promise<ReadingBook> {
  if (draft.epoch === null || draft.epoch !== captureBackupRestoreDataEpoch()) throw new Error('collection-restore');
  return runReadingStoreExclusive(async () => {
    const result = await runBackupRestoreDataEpochCommit(draft.epoch, async () => {
      const library = await loadReadingLibraryStrict();
      const current = library.find(b => b.id === draft.book.id);
      if (current && (current.totalChapters !== draft.book.totalChapters || current.programme?.sourceVersion !== draft.book.programme!.sourceVersion
        || JSON.stringify(current.programme?.episodes) !== JSON.stringify(draft.book.programme!.episodes))) throw new Error('collection-source-changed');
      // Validate every already saved chapter before writing any missing one.
      const existing = await Promise.all(draft.chapters.map(c => loadReadingChapter(c.bookId, c.index, true)));
      for (const [index, saved] of existing.entries()) if (saved && hash(chapterSource(saved)) !== hash(chapterSource(draft.chapters[index]))) throw new Error('collection-source-changed');
      if (current?.programme?.preparation === 'ready' && existing.every(Boolean)) return current;
      const book = current ?? draft.book;
      if (!current) await retryReadingSave(() => saveReadingLibrary([...library, book]));
      for (const [index, chapter] of draft.chapters.entries()) if (!existing[index]) await retryReadingSave(() => saveReadingChapterWithinWrite(chapter));
      const now = Date.now();
      const ready: ReadingBook = { ...book, programme: { ...book.programme!, preparation: 'ready', errorCode: undefined,
        preparedAt: book.programme?.preparedAt ?? now, updatedAt: now } };
      await retryReadingSave(() => saveReadingLibrary([...library.filter(b => b.id !== book.id), ready]));
      return (await loadReadingLibraryStrict()).find(b => b.id === book.id)!;
    });
    if (!result.committed) throw new Error('collection-restore');
    return result.value;
  });
}
