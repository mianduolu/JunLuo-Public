import {
  readingStorageBridge as AsyncStorage,
} from '../sync/syncReadingObjectsStorageBridge';
import * as FileSystem from 'expo-file-system/legacy';
import { normalizeReadingSourceAnchor } from './readingSourceAnchor';
import { nextReadingMaterialRevision, readingMaterialSource, retainLocalReadingMaterialRevision } from './readingMaterialSource';

import {
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';

import type {
  ReadingAnnotation,
  ReadingBook,
  ReadingBookFileStatus,
  ReadingChapter,
  ReadingChapterAnnotations,
  ReadingLibrarySnapshot,
  ReadingNote,
  ReadingPosition,
  ReadingSegmentMeta,
  ReadingSegmentStatus,
  ReadingSession,
  ReadingSegmentSummary,
  ReadingStorageBookKeyIndex,
  ReadingStorageDiagnostics,
} from './readingTypes';
import { READING_STORAGE_VERSION } from './readingTypes';
import { createReadingProgress, readingSegmentSourceVersion } from './readingDailyPolicy';
import { normalizeDailyReadingProgress, normalizeReadingSegmentRequest } from './readingDailyValidation';
import { normalizeReadingContent, validReadingRange } from './readingContent';
import { normalizeReadingProgramme, normalizeProgrammeCues } from './readingProgrammePolicy';

let readingWriteTail: Promise<unknown> = Promise.resolve();
export function runReadingStoreExclusive<T>(work: () => Promise<T>): Promise<T> {
  const result = readingWriteTail.then(work, work);
  readingWriteTail = result.then(() => undefined, () => undefined);
  return result;
}

export const READING_LIBRARY_KEY = 'junluo.reading.library.v1';
export const READING_SESSIONS_KEY = 'junluo.reading.sessions.v1';
export const READING_FILES_FOLDER = 'reading/books';
export const READING_AI_LEGACY_DEBUG_KEY = 'junluo.reading.ai.lastAnnotationDebug.v1';

const CHAPTER_PREFIX = 'junluo.reading.chapter.';
const ANNOTATIONS_PREFIX = 'junluo.reading.annotations.';
const NOTES_PREFIX = 'junluo.reading.notes.';
const RESULT_ACTIONS_PREFIX = 'junluo.reading.resultActions.';
const SEGMENT_MAX_CHARS = 5000;
const SEGMENT_TAIL_MERGE_CHARS = 500;
const STALE_ANNOTATING_MS = 10 * 60 * 1000;

export function makeReadingId(prefix: string, now = Date.now()) {
  return `${prefix}-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

function isSafeReadingBookId(bookId: unknown): bookId is string {
  return typeof bookId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(bookId);
}

export function getReadingChapterKey(bookId: string, chapterIndex: number) {
  return `${CHAPTER_PREFIX}${bookId}.${chapterIndex}.v1`;
}

export function getReadingAnnotationsKey(bookId: string, chapterIndex: number) {
  return `${ANNOTATIONS_PREFIX}${bookId}.${chapterIndex}.v1`;
}

export function getReadingNotesKey(bookId: string) {
  return `${NOTES_PREFIX}${bookId}.v1`;
}

export function getReadingResultActionsKey(bookId: string) {
  return `${RESULT_ACTIONS_PREFIX}${bookId}.v1`;
}

export function getReadingBookDirectory(bookId: string) {
  if (!FileSystem.documentDirectory) {
    throw new Error('当前设备无法访问应用文件目录。');
  }
  if (!isSafeReadingBookId(bookId)) throw new Error('共读书籍 ID 无效。');
  return `${FileSystem.documentDirectory}${READING_FILES_FOLDER}/${bookId}/`;
}

function getReadingSourceCandidates(book: ReadingBook) {
  const directory = getReadingBookDirectory(book.id);
  const candidates = [
    book.fileUri,
    book.fileType === 'txt' ? `${directory}source.txt` : undefined,
    book.fileType === 'epub' ? `${directory}source.epub` : undefined,
    `${directory}source.${book.fileType}`,
  ].filter((uri): uri is string => !!uri);
  return Array.from(new Set(candidates));
}

async function fileExists(uri?: string) {
  if (!uri) return false;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && !info.isDirectory;
  } catch {
    return false;
  }
}

async function directoryExists(uri: string) {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && info.isDirectory;
  } catch {
    return false;
  }
}

async function firstExistingFile(uris: string[]) {
  for (const uri of uris) {
    if (await fileExists(uri)) return uri;
  }
  return undefined;
}

async function findCoverFile(bookId: string) {
  const directory = getReadingBookDirectory(bookId);
  if (!await directoryExists(directory)) return undefined;
  try {
    const names = await FileSystem.readDirectoryAsync(directory);
    const coverName = names.find((name) => /^cover\.[a-z0-9]+$/i.test(name));
    return coverName ? `${directory}${coverName}` : undefined;
  } catch {
    return undefined;
  }
}

function parseIndexedReadingKey(key: string, prefix: string) {
  if (!key.startsWith(prefix) || !key.endsWith('.v1')) return null;
  const body = key.slice(prefix.length, -3);
  const lastDot = body.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const bookId = body.slice(0, lastDot);
  const index = Number(body.slice(lastDot + 1));
  if (!bookId || !Number.isFinite(index)) return null;
  return { bookId, index: Math.max(0, Math.round(index)) };
}

function parseNotesKey(key: string) {
  if (!key.startsWith(NOTES_PREFIX) || !key.endsWith('.v1')) return null;
  const bookId = key.slice(NOTES_PREFIX.length, -3);
  return bookId || null;
}

function clampText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizeBook(value: unknown): ReadingBook | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<ReadingBook>;
  if (!isSafeReadingBookId(item.id) || typeof item.title !== 'string') return null;
  const totalChapters = Math.max(0, Math.round(Number(item.totalChapters ?? 0)));
  const currentChapter = Math.min(
    Math.max(0, Math.round(Number(item.currentChapter ?? 0))),
    Math.max(0, totalChapters - 1),
  );
  return {
    id: item.id,
    ...(typeof item.materialSourceRevision === 'string' ? { materialSourceRevision: item.materialSourceRevision } : {}),
    title: clampText(item.title, 160) || '未命名的书',
    author: clampText(item.author, 120) === '君落粘贴的文字' || clampText(item.author, 120) === '你粘贴的文字'
      ? '小仓鼠粘贴的文字'
      : clampText(item.author, 120) || '佚名',
    language: clampText(item.language, 24) || undefined,
    ...(item.contentType === 'programme' && normalizeReadingProgramme(item.programme)
      ? { contentType: 'programme' as const, programme: normalizeReadingProgramme(item.programme) } : {}),
    fileType: item.fileType === 'txt' || item.fileType === 'pdf' || item.fileType === 'url' ? item.fileType : 'epub',
    fileUri: typeof item.fileUri === 'string' ? item.fileUri : undefined,
    coverUri: typeof item.coverUri === 'string' ? item.coverUri : undefined,
    totalChapters,
    currentChapter,
    currentParagraph: Math.max(0, Math.round(Number(item.currentParagraph ?? 0))),
    progressFraction: Math.max(0, Math.min(1, Number(item.progressFraction ?? 0))),
    importedAt: typeof item.importedAt === 'number' ? item.importedAt : Date.now(),
    lastOpenedAt: typeof item.lastOpenedAt === 'number' ? item.lastOpenedAt : undefined,
    iReading: normalizeDailyReadingProgress(item.iReading),
  };
}

function normalizeSegment(value: unknown, fallbackIndex: number): ReadingSegmentMeta | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<ReadingSegmentMeta>;
  const status: ReadingSegmentStatus =
    item.status === 'annotating' ||
    item.status === 'done' ||
    item.status === 'failed' ||
    item.status === 'stale'
      ? item.status
      : 'pending';
  const startP = Math.max(0, Math.round(Number(item.startP ?? 0)));
  const endP = Math.max(startP, Math.round(Number(item.endP ?? startP)));
  return {
    segmentIndex: Math.max(0, Math.round(Number(item.segmentIndex ?? fallbackIndex))),
    startP,
    endP,
    charCount: Math.max(0, Math.round(Number(item.charCount ?? 0))),
    status,
    errorMessage: clampText(item.errorMessage, 160) || undefined,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : undefined,
    sourceVersion: typeof item.sourceVersion === 'string' ? item.sourceVersion : undefined,
    resultOperationId: typeof item.resultOperationId === 'string' ? item.resultOperationId : undefined,
    request: normalizeReadingSegmentRequest(item.request),
    ...(item.resultActivityId === null || typeof item.resultActivityId === 'string' ? { resultActivityId: item.resultActivityId } : {}),
    ...(item.memoryIngestionVersion === 1 && item.resultActivityId && item.resultOperationId && item.sourceVersion ? { memoryIngestionVersion: 1 as const } : {}),
    contentRange: validReadingRange(item.contentRange),
    ...(item.programmeRange && Number.isFinite(item.programmeRange.startMs) && item.programmeRange.startMs >= 0
      && Number.isFinite(item.programmeRange.endMs) && item.programmeRange.endMs > item.programmeRange.startMs
      && typeof item.programmeRange.timed === 'boolean' ? { programmeRange: { ...item.programmeRange } } : {}),
  };
}

function normalizeChapter(value: unknown): ReadingChapter | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<ReadingChapter>;
  if (typeof item.bookId !== 'string' || typeof item.index !== 'number') return null;
  const paragraphs = Array.isArray(item.paragraphs)
    ? item.paragraphs.map((paragraph) => item.contentBlocks !== undefined && typeof paragraph === 'string'
      ? paragraph : clampText(paragraph, 4000)).filter(Boolean)
    : [];
  const textContent = clampText(item.textContent, 2_000_000) || paragraphs.join('\n\n');
  return {
    bookId: item.bookId,
    index: Math.max(0, Math.round(item.index)),
    title: clampText(item.title, 160) || `第 ${Math.max(0, Math.round(item.index)) + 1} 章`,
    htmlContent: typeof item.htmlContent === 'string' ? item.htmlContent.slice(0, 2_500_000) : undefined,
    textContent,
    paragraphs,
    sourceRevision: typeof item.sourceRevision === 'string' ? item.sourceRevision : undefined,
    charCount: Math.max(0, Math.round(Number(item.charCount ?? textContent.length))),
    segmentsMeta: Array.isArray(item.segmentsMeta)
      ? item.segmentsMeta.map(normalizeSegment).filter((segment): segment is ReadingSegmentMeta => !!segment)
      : computeReadingSegments(paragraphs),
    ...normalizeReadingContent(item, paragraphs),
    ...(item.programmeCues ? { programmeCues: normalizeProgrammeCues(item.programmeCues, paragraphs.length) } : {}),
  };
}

function normalizeAnnotation(value: unknown): ReadingAnnotation | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<ReadingAnnotation>;
  if (
    typeof item.id !== 'string' ||
    typeof item.bookId !== 'string' ||
    typeof item.chapterIndex !== 'number' ||
    typeof item.segmentIndex !== 'number' ||
    typeof item.p !== 'number'
  ) {
    return null;
  }
  const text = clampText(item.text, 900);
  if (!text) return null;
  return {
    sourceAnchor: normalizeReadingSourceAnchor(item.sourceAnchor),
    id: item.id,
    bookId: item.bookId,
    chapterIndex: item.chapterIndex,
    segmentIndex: item.segmentIndex,
    p: item.p,
    type: clampText(item.type, 24) || '共读',
    text,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : undefined,
    sourceVersion: typeof item.sourceVersion === 'string' ? item.sourceVersion : undefined,
    resultOperationId: typeof item.resultOperationId === 'string' ? item.resultOperationId : undefined,
    ...(item.resultActivityId === null || typeof item.resultActivityId === 'string' ? { resultActivityId: item.resultActivityId } : {}),
    ...(item.memoryIngestionVersion === 1 && item.resultActivityId && item.resultOperationId && item.sourceVersion ? { memoryIngestionVersion: 1 as const } : {}),
  };
}

function normalizeSummary(value: unknown): ReadingSegmentSummary | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<ReadingSegmentSummary>;
  if (
    typeof item.bookId !== 'string' ||
    typeof item.chapterIndex !== 'number' ||
    typeof item.segmentIndex !== 'number'
  ) {
    return null;
  }
  const summary = clampText(item.summary, 900);
  if (!summary) return null;
  return {
    sourceAnchor: normalizeReadingSourceAnchor(item.sourceAnchor),
    bookId: item.bookId,
    chapterIndex: item.chapterIndex,
    segmentIndex: item.segmentIndex,
    summary,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : undefined,
    sourceVersion: typeof item.sourceVersion === 'string' ? item.sourceVersion : undefined,
    resultOperationId: typeof item.resultOperationId === 'string' ? item.resultOperationId : undefined,
    ...(item.resultActivityId === null || typeof item.resultActivityId === 'string' ? { resultActivityId: item.resultActivityId } : {}),
    ...(item.memoryIngestionVersion === 1 && item.resultActivityId && item.resultOperationId && item.sourceVersion ? { memoryIngestionVersion: 1 as const } : {}),
  };
}

function normalizeNote(value: unknown): ReadingNote | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<ReadingNote>;
  if (
    typeof item.id !== 'string' ||
    typeof item.bookId !== 'string' ||
    typeof item.chapterIndex !== 'number' ||
    typeof item.startP !== 'number' ||
    typeof item.endP !== 'number'
  ) {
    return null;
  }
  const selectedText = clampText(item.selectedText, 1200);
  if (!selectedText) return null;
  return {
    sourceAnchor: normalizeReadingSourceAnchor(item.sourceAnchor),
    id: item.id,
    bookId: item.bookId,
    chapterIndex: item.chapterIndex,
    startP: item.startP,
    endP: Math.max(item.startP, item.endP),
    selectedText,
    kind: item.kind === 'question' ? 'question' : 'my-note',
    note: clampText(item.note, 1200) || undefined,
    question: clampText(item.question, 400) || undefined,
    answer: clampText(item.answer, 1600) || undefined,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
  };
}

function normalizeSession(value: unknown): ReadingSession | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<ReadingSession>;
  if (typeof item.id !== 'string' || typeof item.bookId !== 'string' || typeof item.startedAt !== 'number') return null;
  const startPosition = normalizePosition(item.startPosition);
  return {
    id: item.id,
    bookId: item.bookId,
    startedAt: item.startedAt,
    endedAt: typeof item.endedAt === 'number' ? item.endedAt : undefined,
    startPosition,
    endPosition: item.endPosition ? normalizePosition(item.endPosition) : undefined,
    activeSeconds: typeof item.activeSeconds === 'number' ? Math.max(0, Math.round(item.activeSeconds)) : undefined,
  };
}

function normalizePosition(value: unknown): ReadingPosition {
  const item = value && typeof value === 'object' ? value as Partial<ReadingPosition> : {};
  return {
    chapterIndex: Math.max(0, Math.round(Number(item.chapterIndex ?? 0))),
    paragraphIndex: Math.max(0, Math.round(Number(item.paragraphIndex ?? 0))),
  };
}

function normalizeLibrarySnapshot(value: unknown): ReadingLibrarySnapshot {
  const rawBooks: unknown[] = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as Partial<ReadingLibrarySnapshot>).books)
      ? (value as Partial<ReadingLibrarySnapshot>).books ?? []
      : [];
  const books = rawBooks
    .map(normalizeBook)
    .filter((book): book is ReadingBook => !!book)
    .sort((left, right) => (right.lastOpenedAt ?? right.importedAt) - (left.lastOpenedAt ?? left.importedAt));
  return {
    version: READING_STORAGE_VERSION,
    books,
    updatedAt: Date.now(),
  };
}

function getRawStorageVersion(value: unknown): ReadingStorageDiagnostics['version'] {
  if (Array.isArray(value)) return 'legacy-array';
  if (!value || typeof value !== 'object') return 'invalid';
  const version = (value as Partial<ReadingLibrarySnapshot>).version;
  return typeof version === 'number' ? version : 'invalid';
}

export function computeReadingSegments(paragraphs: string[], maxChars = SEGMENT_MAX_CHARS): ReadingSegmentMeta[] {
  const segments: ReadingSegmentMeta[] = [];
  let startP = 0;
  let charCount = 0;

  paragraphs.forEach((paragraph, index) => {
    const paragraphLength = paragraph.length;
    if (index > startP && charCount + paragraphLength > maxChars) {
      segments.push({
        segmentIndex: segments.length,
        startP,
        endP: index - 1,
        charCount,
        status: 'pending',
      });
      startP = index;
      charCount = 0;
    }
    charCount += paragraphLength;
  });

  if (paragraphs.length) {
    segments.push({
      segmentIndex: segments.length,
      startP,
      endP: paragraphs.length - 1,
      charCount,
      status: 'pending',
    });
  }

  if (segments.length > 1 && segments[segments.length - 1].charCount < SEGMENT_TAIL_MERGE_CHARS) {
    const tail = segments.pop()!;
    const previous = segments[segments.length - 1];
    segments[segments.length - 1] = {
      ...previous,
      endP: tail.endP,
      charCount: previous.charCount + tail.charCount,
    };
  }

  return segments.map((segment, index) => ({ ...segment, segmentIndex: index }));
}

export function buildAnnotateText(paragraphs: string[], startP: number, endP: number) {
  const safeStart = Math.max(0, Math.round(startP));
  const safeEnd = Math.min(paragraphs.length - 1, Math.max(safeStart, Math.round(endP)));
  if (safeEnd < safeStart) return '';
  return paragraphs
    .slice(safeStart, safeEnd + 1)
    .map((paragraph, offset) => ({ p: safeStart + offset, text: paragraph.trim() }))
    .filter((paragraph) => paragraph.text)
    .map((paragraph) => `【P${paragraph.p}】${paragraph.text}`)
    .join('\n\n');
}

export async function loadReadingLibrary() {
  const raw = await AsyncStorage.getItem(READING_LIBRARY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeLibrarySnapshot(parsed).books;
  } catch {
    return [];
  }
}

/** Runtime controls must distinguish unreadable storage from an empty library. */
export async function loadReadingLibraryStrict() {
  const raw = await AsyncStorage.getItem(READING_LIBRARY_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) && (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as ReadingLibrarySnapshot).books))) {
    throw new Error('reading-library-invalid');
  }
  const rawBooks = Array.isArray(parsed) ? parsed : (parsed as ReadingLibrarySnapshot).books;
  if (rawBooks.some(book => book && typeof book === 'object' && (book as ReadingBook).iReading !== undefined
    && !normalizeDailyReadingProgress((book as ReadingBook).iReading))) throw new Error('reading-progress-invalid');
  return normalizeLibrarySnapshot(parsed).books;
}

export async function saveReadingLibrary(books: ReadingBook[]) {
  const snapshot = normalizeLibrarySnapshot(retainLocalReadingMaterialRevision(books, await loadReadingLibraryStrict()));
  await AsyncStorage.setItem(READING_LIBRARY_KEY, JSON.stringify(snapshot));
  return snapshot.books;
}

export async function migrateReadingStorageIfNeeded() {
  await AsyncStorage.removeItem(READING_AI_LEGACY_DEBUG_KEY).catch(() => undefined);
  const raw = await AsyncStorage.getItem(READING_LIBRARY_KEY);
  if (!raw) {
    await AsyncStorage.setItem(READING_LIBRARY_KEY, JSON.stringify({
      version: READING_STORAGE_VERSION,
      books: [],
      updatedAt: Date.now(),
    } satisfies ReadingLibrarySnapshot));
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    await AsyncStorage.setItem(READING_LIBRARY_KEY, JSON.stringify({
      version: READING_STORAGE_VERSION,
      books: [],
      updatedAt: Date.now(),
    } satisfies ReadingLibrarySnapshot));
    return [];
  }
  const snapshot = normalizeLibrarySnapshot(parsed);
  const needsWrite =
    Array.isArray(parsed) ||
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as Partial<ReadingLibrarySnapshot>).version !== READING_STORAGE_VERSION ||
    JSON.stringify(snapshot.books) !== JSON.stringify((parsed as Partial<ReadingLibrarySnapshot>).books ?? parsed);
  if (needsWrite) {
    await AsyncStorage.setItem(READING_LIBRARY_KEY, JSON.stringify(snapshot));
  }

  const keyIndex = await scanReadingBookKeys();
  await Promise.all(keyIndex.filter((entry) => !!entry.notesKey).map(async (entry) => {
    const notes = await loadReadingNotes(entry.bookId);
    await saveReadingNotes(entry.bookId, notes);
  }));

  return snapshot.books;
}

export async function scanReadingBookKeys(): Promise<ReadingStorageBookKeyIndex[]> {
  const keys = await AsyncStorage.getAllKeys();
  const map = new Map<string, ReadingStorageBookKeyIndex>();
  const ensure = (bookId: string) => {
    const current = map.get(bookId);
    if (current) return current;
    const entry: ReadingStorageBookKeyIndex = {
      bookId,
      chapterKeys: [],
      annotationKeys: [],
      chapterIndexes: [],
      annotationChapterIndexes: [],
    };
    map.set(bookId, entry);
    return entry;
  };

  keys.forEach((key) => {
    const chapter = parseIndexedReadingKey(key, CHAPTER_PREFIX);
    if (chapter) {
      const entry = ensure(chapter.bookId);
      entry.chapterKeys.push(key);
      entry.chapterIndexes.push(chapter.index);
      return;
    }
    const annotations = parseIndexedReadingKey(key, ANNOTATIONS_PREFIX);
    if (annotations) {
      const entry = ensure(annotations.bookId);
      entry.annotationKeys.push(key);
      entry.annotationChapterIndexes.push(annotations.index);
      return;
    }
    const notesBookId = parseNotesKey(key);
    if (notesBookId) {
      ensure(notesBookId).notesKey = key;
    }
  });

  return Array.from(map.values()).map((entry) => ({
    ...entry,
    chapterKeys: entry.chapterKeys.sort(),
    annotationKeys: entry.annotationKeys.sort(),
    chapterIndexes: Array.from(new Set(entry.chapterIndexes)).sort((left, right) => left - right),
    annotationChapterIndexes: Array.from(new Set(entry.annotationChapterIndexes)).sort((left, right) => left - right),
  }));
}

export async function getReadingBookFileStatus(book: ReadingBook): Promise<ReadingBookFileStatus> {
  if (book.programme) {
    const chapter = await loadReadingChapter(book.id, 0);
    const sourceExists = !!chapter?.paragraphs.length;
    return { bookId: book.id, status: sourceExists ? 'ok' : 'missing-source', sourceExists, coverExists: true };
  }
  const sourceUri = await firstExistingFile(getReadingSourceCandidates(book));
  const coverUri = await firstExistingFile([book.coverUri].filter((uri): uri is string => !!uri)) ?? await findCoverFile(book.id);
  const sourceExists = !!sourceUri;
  const coverExists = !book.coverUri || !!coverUri;
  const status = sourceExists && coverExists
    ? 'ok'
    : sourceExists
      ? 'missing-cover'
      : coverExists
        ? 'missing-source'
        : 'missing-all';
  return {
    bookId: book.id,
    status,
    sourceExists,
    coverExists,
    sourceUri,
    coverUri,
  };
}

export async function repairReadingBookFiles() {
  const library = await loadReadingLibrary();
  const repairedBookIds: string[] = [];
  const nextLibrary: ReadingBook[] = [];

  for (const book of library) {
    const status = await getReadingBookFileStatus(book);
    const nextBook = {
      ...book,
      fileUri: status.sourceUri ?? book.fileUri,
      coverUri: status.coverUri ?? book.coverUri,
    };
    const repaired = nextBook.fileUri !== book.fileUri || nextBook.coverUri !== book.coverUri;
    if (repaired) repairedBookIds.push(book.id);
    nextLibrary.push(nextBook);
  }

  if (repairedBookIds.length) {
    await saveReadingLibrary(nextLibrary);
  }

  return { books: repairedBookIds.length ? nextLibrary : library, repairedBookIds };
}

export async function getReadingStorageDiagnostics(repairedBookIds: string[] = []): Promise<ReadingStorageDiagnostics> {
  const raw = await AsyncStorage.getItem(READING_LIBRARY_KEY);
  let version: ReadingStorageDiagnostics['version'] = raw ? 'invalid' : 'missing';
  if (raw) {
    try {
      version = getRawStorageVersion(JSON.parse(raw) as unknown);
    } catch {
      version = 'invalid';
    }
  }
  const books = await loadReadingLibrary();
  const bookIds = new Set(books.map((book) => book.id));
  const keyIndex = await scanReadingBookKeys();
  const sessions = await loadReadingSessions();
  const orphanKeys = keyIndex
    .filter((entry) => !bookIds.has(entry.bookId))
    .flatMap((entry) => [...entry.chapterKeys, ...entry.annotationKeys, entry.notesKey].filter((key): key is string => !!key));
  const missingChapterBookIds = books
    .filter((book) => {
      const entry = keyIndex.find((item) => item.bookId === book.id);
      return !entry || entry.chapterIndexes.length < book.totalChapters;
    })
    .map((book) => book.id);
  const fileStatuses = await Promise.all(books.map(getReadingBookFileStatus));

  return {
    version,
    bookCount: books.length,
    chapterKeyCount: keyIndex.reduce((sum, entry) => sum + entry.chapterKeys.length, 0),
    annotationKeyCount: keyIndex.reduce((sum, entry) => sum + entry.annotationKeys.length, 0),
    noteKeyCount: keyIndex.filter((entry) => !!entry.notesKey).length,
    sessionCount: sessions.length,
    orphanKeys,
    missingChapterBookIds,
    missingSourceBookIds: fileStatuses.filter((item) => !item.sourceExists).map((item) => item.bookId),
    missingCoverBookIds: fileStatuses.filter((item) => !item.coverExists).map((item) => item.bookId),
    repairedBookIds,
  };
}

export async function upsertReadingBook(book: ReadingBook) {
  return runReadingStoreExclusive(async () => {
    const library = await loadReadingLibrary();
    const previous = library.find(item => item.id === book.id);
    const iReading = previous?.iReading && (!book.iReading || previous.iReading.updatedAt > book.iReading.updatedAt)
      ? previous.iReading : book.iReading ?? (!previous ? createReadingProgress(Date.now()) : undefined);
    const next = [{ ...book, iReading }, ...library.filter((item) => item.id !== book.id)];
    return saveReadingLibrary(next);
  });
}

export async function deleteReadingBookRecord(bookId: string, options?: { unpublishedImportEpoch: number | null }) {
  return runReadingStoreExclusive(async () => {
  if (!isSafeReadingBookId(bookId)) return false;
  const dataEpoch = options ? options.unpublishedImportEpoch : captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return false;
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    const library = options ? await loadReadingLibraryStrict() : await loadReadingLibrary();
    if (options && library.some(book => book.id === bookId)) return false;
    const keyIndex = await scanReadingBookKeys();
    const targetIndex = keyIndex.find((item) => item.bookId === bookId);
    const dynamicKeys = [
      ...(targetIndex?.chapterKeys ?? []),
      ...(targetIndex?.annotationKeys ?? []),
      targetIndex?.notesKey,
      getReadingResultActionsKey(bookId),
    ].filter((key): key is string => !!key);
    await AsyncStorage.multiRemove(dynamicKeys);
    if (!options) {
      const sessions = await loadReadingSessions();
      await saveReadingSessions(sessions.filter((session) => session.bookId !== bookId));
      await saveReadingLibrary(library.filter((book) => book.id !== bookId));
    }
    try {
      await FileSystem.deleteAsync(getReadingBookDirectory(bookId), { idempotent: true });
    } catch (error) {
      if (options) throw error;
      // File cleanup should not block removing the library record.
    }
    return true;
  });
  return committed.committed ? committed.value : false;
  });
}

export async function loadReadingChapter(bookId: string, chapterIndex: number, strict = false) {
  const raw = await AsyncStorage.getItem(getReadingChapterKey(bookId, chapterIndex));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const normalized = normalizeChapter(parsed as unknown);
    if (strict && (!normalized || (Array.isArray(parsed.segmentsMeta) && parsed.segmentsMeta.some((segment: ReadingSegmentMeta, index: number) =>
      segment.request && !normalized.segmentsMeta[index]?.request)))) throw new Error('reading-chapter-invalid');
    return normalized;
  } catch (error) {
    if (strict) throw error;
    return null;
  }
}

export async function saveReadingChapter(chapter: ReadingChapter) {
  return runReadingStoreExclusive(() => saveReadingChapterWithinWrite(chapter));
}

/** Caller must already hold runReadingStoreExclusive; no network may run inside it. */
export async function saveReadingChapterWithinWrite(chapter: ReadingChapter) {
  const normalized = normalizeChapter(chapter);
  if (!normalized) throw new Error('章节数据无效。');
  const previous = await loadReadingChapter(normalized.bookId, normalized.index, true);
  if (readingMaterialSource(previous) !== readingMaterialSource(normalized)) {
    const books = await loadReadingLibraryStrict();
    if (books.some(book => book.id === normalized.bookId)) {
      // Invalidate before writing: an uncertain/failed source write must not keep old cursors valid.
      const snapshot = normalizeLibrarySnapshot(books.map(book => book.id === normalized.bookId
        ? { ...book, materialSourceRevision: nextReadingMaterialRevision() } : book));
      await AsyncStorage.setItem(READING_LIBRARY_KEY, JSON.stringify(snapshot));
    }
  }
  await AsyncStorage.setItem(getReadingChapterKey(normalized.bookId, normalized.index), JSON.stringify(normalized));
  return normalized;
}

export async function updateReadingSegmentStatus(
  bookId: string,
  chapterIndex: number,
  segmentIndex: number,
  status: ReadingSegmentStatus,
  errorMessage?: string,
) {
  return runReadingStoreExclusive(async () => {
  const chapter = await loadReadingChapter(bookId, chapterIndex);
  if (!chapter) return null;
  const updatedAt = Date.now();
  const nextChapter = {
    ...chapter,
    segmentsMeta: chapter.segmentsMeta.map((segment) =>
      segment.segmentIndex === segmentIndex
        ? {
          ...segment,
          errorMessage: errorMessage ? clampText(errorMessage, 160) : undefined,
          status,
          updatedAt,
        }
        : segment,
    ),
  };
  return saveReadingChapterWithinWrite(nextChapter);
  });
}

export async function markStaleReadingSegments(bookId: string, chapterIndex: number) {
  return runReadingStoreExclusive(async () => {
  const chapter = await loadReadingChapter(bookId, chapterIndex);
  if (!chapter) return null;
  const now = Date.now();
  let changed = false;
  const nextChapter = {
    ...chapter,
    segmentsMeta: chapter.segmentsMeta.map((segment) => {
      if (segment.status !== 'annotating' || segment.request?.transportStartedAt
        || (segment.request?.save && segment.request.save.attempts > 0)) return segment;
      if (segment.updatedAt && now - segment.updatedAt < STALE_ANNOTATING_MS) return segment;
      changed = true;
      return {
        ...segment,
        errorMessage: '上次共读中断了，可以重新邀请白云读这一段。',
        status: 'stale' as ReadingSegmentStatus,
        updatedAt: now,
      };
    }),
  };
  return changed ? saveReadingChapterWithinWrite(nextChapter) : chapter;
  });
}

export async function resetReadingSegment(bookId: string, chapterIndex: number, segmentIndex: number) {
  return runReadingStoreExclusive(() => resetReadingSegmentWithinWrite(bookId, chapterIndex, segmentIndex));
}

/** Caller holds the reading lock. A fixed identity permits read-back after a lost write acknowledgement. */
export async function resetReadingSegmentWithinWrite(bookId: string, chapterIndex: number, segmentIndex: number,
  operationId = makeReadingId('reading-result')) {
    const chapter = await loadReadingChapter(bookId, chapterIndex, true);
    if (!chapter) return null;
    const now = Date.now();
    return saveReadingChapterWithinWrite({ ...chapter, segmentsMeta: chapter.segmentsMeta.map(segment => {
      if (segment.segmentIndex !== segmentIndex) return segment;
      const id = operationId;
      return { ...segment, status: 'pending', errorMessage: undefined, sourceVersion: undefined, resultOperationId: undefined, resultActivityId: undefined, memoryIngestionVersion: undefined,
        updatedAt: now, request: { id, runtimeId: id, sourceVersion: readingSegmentSourceVersion(chapter, segment),
          kind: 'manual', startedAt: now, save: { attempts: 0, phase: 'result', outcome: 'pending', resultRetained: false } } };
    }) });
}

export async function saveReadingProgress(bookId: string, chapterIndex: number, paragraphIndex: number) {
  const library = await loadReadingLibrary();
  const book = library.find((item) => item.id === bookId);
  if (!book) return null;
  const progressFraction = book.totalChapters > 0
    ? Math.min(1, Math.max(0, (chapterIndex + 1) / book.totalChapters))
    : 0;
  const nextBook = {
    ...book,
    currentChapter: Math.max(0, chapterIndex),
    currentParagraph: Math.max(0, paragraphIndex),
    progressFraction,
    lastOpenedAt: Date.now(),
  };
  await upsertReadingBook(nextBook);
  return nextBook;
}

export async function loadReadingAnnotations(bookId: string, chapterIndex: number, strict = false): Promise<ReadingChapterAnnotations> {
  const raw = await AsyncStorage.getItem(getReadingAnnotationsKey(bookId, chapterIndex));
  if (!raw) return { annotations: [], summaries: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<ReadingChapterAnnotations>;
    const normalized = {
      annotations: Array.isArray(parsed.annotations)
        ? parsed.annotations.map(normalizeAnnotation).filter((item): item is ReadingAnnotation => !!item)
        : [],
      summaries: Array.isArray(parsed.summaries)
        ? parsed.summaries.map(normalizeSummary).filter((item): item is ReadingSegmentSummary => !!item)
        : [],
    };
    if (strict && (!Array.isArray(parsed.annotations) || !Array.isArray(parsed.summaries)
      || normalized.annotations.length !== parsed.annotations.length || normalized.summaries.length !== parsed.summaries.length)) {
      throw new Error('reading-results-invalid');
    }
    return normalized;
  } catch (error) {
    if (strict) throw error;
    return { annotations: [], summaries: [] };
  }
}

export async function saveReadingAnnotations(
  bookId: string,
  chapterIndex: number,
  value: ReadingChapterAnnotations,
) {
  const normalized: ReadingChapterAnnotations = {
    annotations: value.annotations.map(normalizeAnnotation).filter((item): item is ReadingAnnotation => !!item),
    summaries: value.summaries.map(normalizeSummary).filter((item): item is ReadingSegmentSummary => !!item),
  };
  await AsyncStorage.setItem(getReadingAnnotationsKey(bookId, chapterIndex), JSON.stringify(normalized));
  return normalized;
}

export async function upsertReadingAnnotations(
  bookId: string,
  chapterIndex: number,
  segmentIndex: number,
  annotations: Array<Omit<ReadingAnnotation, 'id' | 'bookId' | 'chapterIndex' | 'segmentIndex' | 'createdAt' | 'type'>>,
  summary: string,
  identity?: { operationId: string; sourceVersion: string; createdAt: number; resultActivityId?: string | null; memoryIngestionVersion?: 1 },
) {
  const current = await loadReadingAnnotations(bookId, chapterIndex, !!identity);
  const now = identity?.createdAt ?? Date.now();
  if (identity && annotations.every((item, index) => current.annotations.some(saved => saved.id === `${identity.operationId}:annotation:${index}`
    && saved.sourceVersion === identity.sourceVersion && saved.p === item.p && saved.text === item.text.trim()
    && (identity.memoryIngestionVersion !== 1 || saved.memoryIngestionVersion === 1 && saved.resultActivityId === identity.resultActivityId)))
    && current.annotations.filter(item => item.resultOperationId === identity.operationId).length === annotations.length
    && (!summary.trim() || current.summaries.some(saved => saved.resultOperationId === identity.operationId
      && saved.sourceVersion === identity.sourceVersion && saved.summary === summary.trim()
      && (identity.memoryIngestionVersion !== 1 || saved.memoryIngestionVersion === 1 && saved.resultActivityId === identity.resultActivityId)))) return current;
  // createdAt 保留真实时间；复用 updatedAt 作为本章单调保存版本，避免同毫秒回落到随机 ID 排序。
  const updatedAt = [...current.annotations, ...current.summaries].reduce((latest, item) => {
    const previous = item.updatedAt ?? item.createdAt;
    return Number.isFinite(previous) ? Math.max(latest, previous + 1) : latest;
  }, now);
  const nextAnnotations = current.annotations.filter((item) => item.segmentIndex !== segmentIndex);
  annotations.forEach((item, index) => {
    nextAnnotations.push({
      ...item,
      // ponytail: 仅兼容既有同步必填字段，不再分类或展示标签。
      type: '共读',
      id: identity ? `${identity.operationId}:annotation:${index}` : makeReadingId('reading-anno', now),
      bookId,
      chapterIndex,
      segmentIndex,
      createdAt: now,
      updatedAt,
      ...(identity ? { sourceVersion: identity.sourceVersion, resultOperationId: identity.operationId,
        ...(identity.resultActivityId !== undefined ? { resultActivityId: identity.resultActivityId } : {}),
        ...(identity.memoryIngestionVersion === 1 && identity.resultActivityId ? { memoryIngestionVersion: 1 as const } : {}) } : {}),
    });
  });
  const nextSummaries = current.summaries.filter((item) => item.segmentIndex !== segmentIndex);
  if (summary.trim()) {
    nextSummaries.push({
      bookId,
      chapterIndex,
      segmentIndex,
      summary: summary.trim(),
      createdAt: now,
      updatedAt,
      ...(identity ? { sourceVersion: identity.sourceVersion, resultOperationId: identity.operationId,
        ...(identity.resultActivityId !== undefined ? { resultActivityId: identity.resultActivityId } : {}),
        ...(identity.memoryIngestionVersion === 1 && identity.resultActivityId ? { memoryIngestionVersion: 1 as const } : {}) } : {}),
    });
  }
  return saveReadingAnnotations(bookId, chapterIndex, {
    annotations: nextAnnotations.sort((left, right) => left.p - right.p),
    summaries: nextSummaries.sort((left, right) => left.segmentIndex - right.segmentIndex),
  });
}

export async function loadReadingNotes(bookId: string, strict = false) {
  const raw = await AsyncStorage.getItem(getReadingNotesKey(bookId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const normalized = Array.isArray(parsed)
      ? parsed.map(normalizeNote).filter((item): item is ReadingNote => !!item)
        .sort((left, right) => right.createdAt - left.createdAt)
      : [];
    if (strict && (!Array.isArray(parsed) || normalized.length !== parsed.length)) throw new Error('reading-notes-invalid');
    return normalized;
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

export async function saveReadingNotes(bookId: string, notes: ReadingNote[]) {
  const normalized = notes.map(normalizeNote).filter((item): item is ReadingNote => !!item);
  await AsyncStorage.setItem(getReadingNotesKey(bookId), JSON.stringify(normalized));
  return normalized;
}

export async function upsertReadingNote(note: Omit<ReadingNote, 'id' | 'createdAt'> & { id?: string; createdAt?: number }) {
  const current = await loadReadingNotes(note.bookId);
  const entry: ReadingNote = {
    ...note,
    id: note.id ?? makeReadingId('reading-note'),
    createdAt: note.createdAt ?? Date.now(),
  };
  return saveReadingNotes(note.bookId, [entry, ...current.filter((item) => item.id !== entry.id)]);
}

export async function deleteReadingNote(bookId: string, noteId: string) {
  const current = await loadReadingNotes(bookId);
  return saveReadingNotes(bookId, current.filter((note) => note.id !== noteId));
}

export async function loadReadingSessions() {
  const raw = await AsyncStorage.getItem(READING_SESSIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.map(normalizeSession).filter((item): item is ReadingSession => !!item)
      : [];
  } catch {
    return [];
  }
}

export async function saveReadingSessions(sessions: ReadingSession[]) {
  const normalized = sessions.map(normalizeSession).filter((item): item is ReadingSession => !!item).slice(-500);
  await AsyncStorage.setItem(READING_SESSIONS_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function startReadingSession(bookId: string, startPosition: ReadingPosition) {
  const sessions = await loadReadingSessions();
  const session: ReadingSession = {
    id: makeReadingId('reading-session'),
    bookId,
    startedAt: Date.now(),
    startPosition,
    activeSeconds: 0,
  };
  await saveReadingSessions([...sessions, session]);
  return session;
}

export async function finishReadingSession(sessionId: string, endPosition: ReadingPosition, activeSeconds?: number) {
  const sessions = await loadReadingSessions();
  const now = Date.now();
  return saveReadingSessions(sessions.map((session) => {
    if (session.id !== sessionId) return session;
    const sessionSeconds = typeof activeSeconds === 'number'
      ? Math.max(0, Math.round(activeSeconds))
      : Math.max(0, Math.round((now - session.startedAt) / 1000));
    return {
      ...session,
      endedAt: now,
      endPosition,
      activeSeconds: sessionSeconds,
    };
  }));
}
