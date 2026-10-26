import { assertReadingDailyState, assertReadingProgramme, retainReadingDailyState, retainReadingRequest } from '../sync/syncReadingWorkspace';
import { normalizeDailyReadingProgress, normalizeReadingSegmentRequest } from './readingDailyValidation';
import type { DailyReadingProgress, ReadingChapter, ReadingSegmentRequest } from './readingTypes';

const LIBRARY_KEY = 'junluo.reading.library.v1';
type StoredBook = Record<string, unknown> & { id?: string; iReading?: unknown };

function parseLibrary(raw: string | undefined, required: boolean) {
  if (raw === undefined) return null;
  try {
    const value: unknown = JSON.parse(raw);
    const books = Array.isArray(value) ? value : (value as { books?: unknown } | null)?.books;
    if (!Array.isArray(books) || books.some(book => !book || typeof book !== 'object' || typeof book.id !== 'string')) {
      throw new Error('阅读备份书架无效。');
    }
    return { value, books: books as StoredBook[] };
  } catch (error) {
    if (required) throw error;
    return null;
  }
}

function stateOf(value: unknown, required: boolean): DailyReadingProgress | undefined {
  if (value === undefined) return undefined;
  try {
    assertReadingDailyState(value);
    return normalizeDailyReadingProgress(value);
  } catch (error) {
    if (required) throw error;
    return undefined;
  }
}

// Compare original content and segmentation only, never stale result status or you's page.
function sameBookSource(
  current: Record<string, string>, restored: Record<string, string>,
  local: StoredBook, incoming: StoredBook,
) {
  if (!['id', 'importedAt', 'fileType', 'totalChapters', 'contentType'].every(key => local[key] === incoming[key])
    || !Number.isSafeInteger(incoming.totalChapters) || Number(incoming.totalChapters) <= 0) return false;
  const oldProgramme = local.programme as { episodes?: unknown; sourceUrl?: string } | undefined;
  const newProgramme = incoming.programme as { episodes?: unknown; sourceUrl?: string } | undefined;
  if ((oldProgramme?.episodes || newProgramme?.episodes) && oldProgramme?.sourceUrl !== newProgramme?.sourceUrl) return false;
  if (oldProgramme?.episodes && newProgramme?.episodes && JSON.stringify(oldProgramme.episodes) !== JSON.stringify(newProgramme.episodes)) return false;
  try {
    for (let index = 0; index < Number(incoming.totalChapters); index += 1) {
      const key = `junluo.reading.chapter.${incoming.id}.${index}.v1`;
      if (!current[key] || !restored[key]) return false;
      const left = JSON.parse(current[key]), right = JSON.parse(restored[key]);
      for (const chapter of [left, right]) {
        if (chapter.bookId !== incoming.id || chapter.index !== index || !Array.isArray(chapter.paragraphs)
          || !chapter.paragraphs.every((p: unknown) => typeof p === 'string') || !Array.isArray(chapter.segmentsMeta)) return false;
      }
      const source = (chapter: typeof left) => ({ paragraphs: chapter.paragraphs, sourceRevision: chapter.sourceRevision,
        contentBlocks: chapter.contentBlocks, programmeCues: chapter.programmeCues,
        images: chapter.images?.map((image: Record<string, unknown>) =>
          [image.id, image.sourcePath, image.fileName, image.contentVersion, image.width, image.height]),
        segments: chapter.segmentsMeta.map((part: Record<string, unknown>) =>
          [part.segmentIndex, part.startP, part.endP, part.charCount, part.contentRange, part.programmeRange]) });
      if (JSON.stringify(source(left)) !== JSON.stringify(source(right))) return false;
    }
    return true;
  } catch { return false; }
}

function resultProof(storage: Record<string, string>, bookId: string, chapterIndex: number, request: ReadingSegmentRequest) {
  try {
    const notes = JSON.parse(storage[`junluo.reading.annotations.${bookId}.${chapterIndex}.v1`] ?? 'null');
    if (!notes || !Array.isArray(notes.annotations) || !Array.isArray(notes.summaries)) return null;
    const located = (item: Record<string, unknown>) => item && item.bookId === bookId && item.chapterIndex === chapterIndex
      && Number.isInteger(item.segmentIndex) && typeof item.createdAt === 'number';
    if (!notes.annotations.every((item: Record<string, unknown>) => located(item) && typeof item.id === 'string'
      && Number.isInteger(item.p) && typeof item.text === 'string' && item.text.trim())
      || !notes.summaries.every((item: Record<string, unknown>) => located(item) && typeof item.summary === 'string' && item.summary.trim())) return null;
    const belongs = (item: Record<string, unknown>) => item?.resultOperationId === request.id && item.sourceVersion === request.sourceVersion;
    const annotations = notes.annotations.filter(belongs), summaries = notes.summaries.filter(belongs);
    if (!annotations.length && !summaries.length) return null;
    if (request.result && (annotations.length !== request.result.annotations.length
      || !request.result.annotations.every((item, position) => annotations.some((note: Record<string, unknown>) =>
        note.id === `${request.id}:annotation:${position}` && note.p === item.p && note.text === item.text.trim()))
      || (request.result.summary.trim() && !summaries.some((note: Record<string, unknown>) => note.summary === request.result!.summary.trim())))) return null;
    return JSON.stringify({ annotations, summaries });
  } catch { return null; }
}

/** Only the original chapter holds a pending body. Restoring never copies the notes collection. */
function restoreChapterRequests(current: Record<string, string>, restored: Record<string, string>, book: StoredBook,
  sameSource: boolean, output: Record<string, string>) {
  if (!Number.isSafeInteger(book.totalChapters) || Number(book.totalChapters) <= 0) return;
  for (let index = 0; index < Number(book.totalChapters); index += 1) {
    const key = `junluo.reading.chapter.${book.id}.${index}.v1`;
    if (!restored[key]) continue;
    let incoming: ReadingChapter, local: ReadingChapter | undefined;
    try {
      incoming = JSON.parse(restored[key]);
      local = sameSource ? JSON.parse(current[key]) : undefined;
    } catch { continue; }
    if (!Array.isArray(incoming?.segmentsMeta)) continue;
    const segmentsMeta = incoming.segmentsMeta.map(segment => {
      const previous = local?.segmentsMeta.find(part => part.segmentIndex === segment.segmentIndex);
      const oldRequest = normalizeReadingSegmentRequest(previous?.request);
      const newRequest = normalizeReadingSegmentRequest(segment.request);
      if ((previous?.request && !oldRequest) || (segment.request && !newRequest)) throw new Error('reading-restore-request-invalid');
      const shared = retainReadingRequest(oldRequest, newRequest);
      if (!shared) return segment;
      const matches = (request?: ReadingSegmentRequest) => request?.id === shared.id && request.sourceVersion === shared.sourceVersion;
      const result = (matches(newRequest) ? newRequest?.result : undefined) ?? (matches(oldRequest) ? oldRequest?.result : undefined);
      const request: ReadingSegmentRequest = { ...shared, ...(result ? { result } : {}) };
      const restoredProof = resultProof(restored, book.id!, index, request);
      const oldProof = sameSource ? resultProof(current, book.id!, index, request) : null;
      const restoredDone = segment.status === 'done' && segment.resultOperationId === request.id && segment.sourceVersion === request.sourceVersion;
      const retainedDone = previous?.status === 'done' && previous.resultOperationId === request.id && previous.sourceVersion === request.sourceVersion;
      if (restoredProof && (restoredDone || (retainedDone && restoredProof === oldProof))
        && (!oldProof || !retainedDone || restoredProof === oldProof)) {
        delete request.result;
        request.save = { ...shared.save, phase: 'done', outcome: 'complete', resultRetained: true };
        return { ...segment, request, status: 'done' as const, resultOperationId: request.id, sourceVersion: request.sourceVersion,
          resultActivityId: request.resultActivityId, memoryIngestionVersion: request.memoryIngestionVersion,
          updatedAt: restoredDone ? segment.updatedAt : previous?.updatedAt };
      }
      if (request.save?.outcome === 'complete') request.save = { ...request.save, phase: result ? 'annotations' : 'result',
        outcome: 'unknown', resultRetained: !!result };
      else if (request.save) request.save.resultRetained = !!result;
      return { ...segment, request, status: 'annotating' as const, resultOperationId: undefined, sourceVersion: undefined,
        resultActivityId: undefined, memoryIngestionVersion: undefined };
    });
    if (JSON.stringify(segmentsMeta) !== JSON.stringify(incoming.segmentsMeta)) output[key] = JSON.stringify({ ...incoming, segmentsMeta });
  }
}

/** Restore existing records; no copied source/notes, elapsed-time settlement or model request. */
export function restoreDailyReadingProgress(
  current: Record<string, string>, restored: Record<string, string>, now: number,
): Record<string, string> {
  const incoming = parseLibrary(restored[LIBRARY_KEY], true);
  if (!incoming) return restored;
  const local = parseLibrary(current[LIBRARY_KEY], false);
  const output = { ...restored };
  let changed = false;
  const books = incoming.books.map(book => {
    const oldBook = local?.books.find(item => item.id === book.id);
    const saved = stateOf(book.iReading, true);
    const previous = stateOf(oldBook?.iReading, false);
    const sameSource = !!oldBook && sameBookSource(current, restored, oldBook, book);
    const oldProgramme = oldBook?.programme as { episodes?: unknown } | undefined;
    const newProgramme = book.programme as { episodes?: unknown } | undefined;
    if (sameSource && oldProgramme?.episodes && newProgramme && newProgramme.episodes === undefined) {
      assertReadingProgramme(oldProgramme); assertReadingProgramme(newProgramme);
      if (oldProgramme.sourceUrl === newProgramme.sourceUrl) {
        book = { ...book, programme: { ...newProgramme, episodes: oldProgramme.episodes, sourceVersion: oldProgramme.sourceVersion } };
        changed = true;
      }
    }
    restoreChapterRequests(current, restored, book, sameSource, output);
    const state = previous && sameSource
      ? normalizeDailyReadingProgress(retainReadingDailyState(previous, saved)) : saved;
    if (!state) return book;
    if (state.activity) {
      state.activity = { ...state.activity,
        status: state.activity.status === 'ended' ? 'ended' : 'paused',
        checkpointAt: now, updatedAt: now, operationId: `reading-restore:${now}`,
      };
      delete state.activity.focusId;
      delete state.activity.focusWorkMs;
      delete state.activity.jointOnly;
      delete state.activity.deferredOpportunity;
    }
    state.updatedAt = Math.max(state.updatedAt + 1, now);
    changed = true;
    return { ...book, iReading: state };
  });
  if (!changed) return output;
  const library = Array.isArray(incoming.value) ? books : { ...(incoming.value as object), books };
  return { ...output, [LIBRARY_KEY]: JSON.stringify(library) };
}
