import RawAsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { nextReadingMaterialRevision, readingMaterialSource, retainLocalReadingMaterialRevision } from '../reading/readingMaterialSource';

import {
  assertReadingWorkspaceRecord,
  retainReadingDailyState,
  readingResultProof,
  sharedReadingRequest,
  retainReadingRequest,
  readingSourceAnchor,
  retainReadingWorkspaceExtensions,
  type ReadingWorkspaceAnnotationRecord,
  type ReadingWorkspaceBookRecord,
  type ReadingWorkspaceChapterRecord,
  type ReadingWorkspaceNoteRecord,
  type ReadingWorkspaceParagraphRecord,
  type ReadingWorkspaceResultActionRecord,
  type ReadingWorkspaceSegmentSummaryRecord,
  type ReadingWorkspaceSessionRecord,
  type ReadingWorkspaceWebClipRecord,
} from './syncReadingWorkspace';
import type {
  ReadingWorkspaceBusinessPort,
} from './syncReadingWorkspaceApply';
import {
  READING_WORKSPACE_ANNOTATIONS_PREFIX,
  READING_WORKSPACE_CHAPTER_PREFIX,
  READING_WORKSPACE_LIBRARY_KEY,
  READING_WORKSPACE_NOTES_PREFIX,
  READING_WORKSPACE_RESULT_ACTIONS_PREFIX,
  READING_WORKSPACE_SESSIONS_KEY,
  READING_WORKSPACE_WEB_CLIPS_KEY,
  deriveReadingWorkspaceRecordsForRawStorage,
  isReadingWorkspaceManagedStorageKey,
} from './syncReadingWorkspaceStorageDerivation';
import {
  makeReadingWorkspaceEntityId,
} from './syncReadingWorkspaceIdentity';

type StoredBook = Omit<ReadingWorkspaceBookRecord, 'bookId'> & {
  id: string;
  fileUri?: string;
  coverUri?: string;
  materialSourceRevision?: string;
};

type StoredSegment = Omit<ReadingWorkspaceChapterRecord['segments'][number], 'request'> & {
  request?: unknown;
  errorMessage?: string;
  status: 'pending' | 'annotating' | 'done' | 'failed' | 'stale';
};

type StoredChapter = {
  sourceRevision?: string;
  bookId: string;
  index: number;
  title: string;
  htmlContent?: string;
  textContent: string;
  paragraphs: string[];
  charCount: number;
  segmentsMeta: StoredSegment[];
  contentBlocks?: ReadingWorkspaceChapterRecord['contentBlocks'];
  images?: Array<Omit<NonNullable<ReadingWorkspaceChapterRecord['images']>[number], 'fileName'> & { uri: string }>;
  imageDescriptions?: ReadingWorkspaceChapterRecord['imageDescriptions'];
  programmeCues?: ReadingWorkspaceChapterRecord['programmeCues'];
};

type ChapterStage = {
  metadata: ReadingWorkspaceChapterRecord;
  paragraphs: Record<string, string>;
};

const READING_STORAGE_VERSION = 2;
const STAGE_PREFIX =
  'junluo.sync.reading.workspace.chapterStage.';

let readingWorkspaceApplyQueue = Promise.resolve();

function enqueueReadingWorkspaceApply<T>(
  callback: () => Promise<T>,
) {
  const current = readingWorkspaceApplyQueue
    .catch(() => undefined)
    .then(async () => (await import('../reading/readingStore')).runReadingStoreExclusive(callback));
  readingWorkspaceApplyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function chapterKey(bookId: string, chapterIndex: number) {
  return `${READING_WORKSPACE_CHAPTER_PREFIX}${bookId}.${chapterIndex}.v1`;
}

function annotationsKey(bookId: string, chapterIndex: number) {
  return `${READING_WORKSPACE_ANNOTATIONS_PREFIX}${bookId}.${chapterIndex}.v1`;
}

function notesKey(bookId: string) {
  return `${READING_WORKSPACE_NOTES_PREFIX}${bookId}.v1`;
}

function resultActionsKey(bookId: string) {
  return `${READING_WORKSPACE_RESULT_ACTIONS_PREFIX}${bookId}.v1`;
}

function stageKey(entityId: string) {
  return `${STAGE_PREFIX}${entityId}.v1`;
}

async function loadLibrary() {
  const raw = await RawAsyncStorage.getItem(
    READING_WORKSPACE_LIBRARY_KEY,
  );
  const parsed = parseJson<unknown>(raw, null);
  if (Array.isArray(parsed)) return parsed as StoredBook[];
  if (
    parsed
    && typeof parsed === 'object'
    && Array.isArray((parsed as { books?: unknown }).books)
  ) {
    return (parsed as { books: StoredBook[] }).books;
  }
  return [];
}

async function saveLibrary(books: StoredBook[], updatedAt: number) {
  books = retainLocalReadingMaterialRevision(books, await loadLibrary());
  await RawAsyncStorage.setItem(
    READING_WORKSPACE_LIBRARY_KEY,
    JSON.stringify({
      version: READING_STORAGE_VERSION,
      books,
      updatedAt,
    }),
  );
}

async function loadChapter(bookId: string, chapterIndex: number) {
  return parseJson<StoredChapter | null>(
    await RawAsyncStorage.getItem(chapterKey(bookId, chapterIndex)),
    null,
  );
}

async function saveChapter(chapter: StoredChapter) {
  if (readingMaterialSource(await loadChapter(chapter.bookId, chapter.index)) !== readingMaterialSource(chapter)) {
    await invalidateMaterialSource(chapter.bookId);
  }
  await RawAsyncStorage.setItem(
    chapterKey(chapter.bookId, chapter.index),
    JSON.stringify(chapter),
  );
}

async function invalidateMaterialSource(bookId: string) {
  const books = await loadLibrary();
  if (!books.some(book => book.id === bookId)) return;
  await RawAsyncStorage.setItem(READING_WORKSPACE_LIBRARY_KEY, JSON.stringify({
    version: READING_STORAGE_VERSION, updatedAt: Date.now(),
    books: books.map(book => book.id === bookId ? { ...book, materialSourceRevision: nextReadingMaterialRevision() } : book),
  }));
}

async function loadStage(entityId: string) {
  return parseJson<ChapterStage | null>(
    await RawAsyncStorage.getItem(stageKey(entityId)),
    null,
  );
}

async function saveStage(entityId: string, stage: ChapterStage) {
  await RawAsyncStorage.setItem(
    stageKey(entityId),
    JSON.stringify(stage),
  );
}

function sharedSegments(
  incoming: ReadingWorkspaceChapterRecord,
  existing: StoredChapter | null,
): StoredSegment[] {
  return incoming.segments.map((segment) => {
    const local = existing?.segmentsMeta.find(
      (candidate) => candidate.segmentIndex === segment.segmentIndex
        && candidate.startP === segment.startP && candidate.endP === segment.endP,
    );
    if (local?.contentRange && !segment.contentRange) return local;
    if (local?.programmeRange && !segment.programmeRange) return local;
    if (JSON.stringify(local?.programmeRange) !== JSON.stringify(segment.programmeRange)) return { ...segment };
    if (JSON.stringify(local?.contentRange) !== JSON.stringify(segment.contentRange)) return { ...segment };
    const proof = readingResultProof(segment.sourceVersion ? segment : local ?? segment, local);
    const mergedRequest = retainReadingRequest(local?.request, segment.request);
    const localRequest = local?.request as { id?: string; sourceVersion?: string; result?: unknown } | undefined;
    const pendingRequest = mergedRequest ? { request: { ...mergedRequest,
      ...(mergedRequest.id === localRequest?.id && mergedRequest.sourceVersion === localRequest.sourceVersion
        && localRequest.result ? { result: localRequest.result } : {}) } } : local?.request ? { request: local.request } : {};
    if (segment.status === 'done') {
      return { ...segment, ...proof, ...pendingRequest, status: 'done' };
    }
    if (
      local
      && ['annotating', 'done', 'failed', 'stale'].includes(local.status)
    ) {
      return {
        ...segment,
        ...proof,
        ...pendingRequest,
        status: local.status,
        ...(local.errorMessage
          ? { errorMessage: local.errorMessage }
          : {}),
        ...(local.updatedAt !== undefined
          ? { updatedAt: local.updatedAt }
          : {}),
      };
    }
    return { ...segment, ...proof, ...pendingRequest, status: 'pending' };
  });
}

function stageComplete(stage: ChapterStage) {
  for (
    let index = 0;
    index < stage.metadata.paragraphCount;
    index += 1
  ) {
    if (typeof stage.paragraphs[String(index)] !== 'string') return false;
  }
  return true;
}

async function materializeStage(
  entityId: string,
  stage: ChapterStage,
) {
  if (!stageComplete(stage)) {
    await saveStage(entityId, stage);
    return;
  }
  const existing = await loadChapter(
    stage.metadata.bookId,
    stage.metadata.chapterIndex,
  );
  if (existing?.sourceRevision !== undefined && stage.metadata.sourceRevision === undefined) {
    await RawAsyncStorage.removeItem(stageKey(entityId));
    return;
  }
  const paragraphs = Array.from(
    { length: stage.metadata.paragraphCount },
    (_, index) => stage.paragraphs[String(index)],
  );
  const textContent = paragraphs.join('\n\n');
  const sameParagraphs = existing
    && JSON.stringify(existing.paragraphs) === JSON.stringify(paragraphs);
  const previousMetadata = existing ? {
    ...(existing.sourceRevision !== undefined ? { sourceRevision: existing.sourceRevision } : {}),
    bookId: existing.bookId, chapterIndex: existing.index, charCount: existing.charCount,
    paragraphCount: existing.paragraphs.length, segments: existing.segmentsMeta,
    ...(existing.contentBlocks ? { contentBlocks: existing.contentBlocks } : {}),
    ...(existing.images ? { images: existing.images.map(({ uri, ...image }) => ({ ...image, fileName: uri.slice(uri.lastIndexOf('/') + 1) })) } : {}),
    ...(existing.imageDescriptions ? { imageDescriptions: existing.imageDescriptions } : {}),
    ...(existing.programmeCues ? { programmeCues: existing.programmeCues } : {}),
  } : {};
  const metadata = (sameParagraphs && existing?.sourceRevision === stage.metadata.sourceRevision
    ? retainReadingWorkspaceExtensions('chapter', previousMetadata, stage.metadata as unknown as Record<string, unknown>)
    : stage.metadata) as ReadingWorkspaceChapterRecord;
  if (metadata.contentBlocks?.some(block => block.kind === 'text' && block.endOffset > (paragraphs[block.paragraphIndex]?.length ?? 0))) {
    throw new Error('reading text block source range 无效。');
  }
  const images = metadata.images?.map(({ fileName, ...image }) => {
    const local = existing?.images?.find(old => old.id === image.id && old.contentVersion === image.contentVersion
      && old.uri.slice(old.uri.lastIndexOf('/') + 1) === fileName);
    if (!local && !FileSystem.documentDirectory) throw new Error('reading image 本地目录不可用。');
    return { ...image, uri: local?.uri ?? `${FileSystem.documentDirectory}reading/books/${stage.metadata.bookId}/images/${fileName}` };
  });
  await saveChapter({
    ...(metadata.sourceRevision !== undefined ? { sourceRevision: metadata.sourceRevision } : {}),
    bookId: stage.metadata.bookId,
    index: stage.metadata.chapterIndex,
    title: stage.metadata.title,
    ...(sameParagraphs && existing?.htmlContent
      ? { htmlContent: existing.htmlContent }
      : {}),
    textContent,
    paragraphs,
    charCount: stage.metadata.charCount,
    segmentsMeta: sharedSegments(metadata, sameParagraphs && existing?.sourceRevision === metadata.sourceRevision ? existing : null),
    ...(metadata.contentBlocks !== undefined ? { contentBlocks: metadata.contentBlocks } : {}),
    ...(images !== undefined ? { images } : {}),
    ...(metadata.imageDescriptions !== undefined ? { imageDescriptions: metadata.imageDescriptions } : {}),
    ...(metadata.programmeCues !== undefined ? { programmeCues: metadata.programmeCues } : {}),
  });
  await RawAsyncStorage.removeItem(stageKey(entityId));
}

async function upsertBook(
  input: Parameters<ReadingWorkspaceBusinessPort['upsertRecord']>[0],
) {
  const record = input.value as unknown as ReadingWorkspaceBookRecord;
  const books = await loadLibrary();
  const existing = books.find((book) => book.id === record.bookId);
  const retained = retainReadingWorkspaceExtensions('book', existing ?? {}, record as unknown as Record<string, unknown>) as ReadingWorkspaceBookRecord;
  const { bookId, ...shared } = retained;
  const next: StoredBook = {
    ...shared,
    ...(retainReadingDailyState(existing?.iReading, record.iReading)
      ? { iReading: retainReadingDailyState(existing?.iReading, record.iReading) } : {}),
    id: bookId,
    ...(existing?.fileUri ? { fileUri: existing.fileUri } : {}),
    ...(existing?.coverUri ? { coverUri: existing.coverUri } : {}),
  };
  await saveLibrary(
    [next, ...books.filter((book) => book.id !== record.bookId)],
    input.revision.createdAt,
  );
}

async function upsertChapter(
  input: Parameters<ReadingWorkspaceBusinessPort['upsertRecord']>[0],
) {
  const record = input.value as unknown as ReadingWorkspaceChapterRecord;
  const existing = await loadChapter(record.bookId, record.chapterIndex);
  if (existing?.sourceRevision !== undefined && record.sourceRevision === undefined) return;
  const previousStage = await loadStage(input.entityId);
  const paragraphs: Record<string, string> = {};
  (existing?.sourceRevision === record.sourceRevision ? existing?.paragraphs : [])
    ?.slice(0, record.paragraphCount)
    .forEach((text, index) => {
      paragraphs[String(index)] = text;
    });
  if (previousStage && previousStage.metadata.sourceRevision === record.sourceRevision) {
    for (const [index, text] of Object.entries(previousStage.paragraphs)) {
      if (Number(index) < record.paragraphCount) paragraphs[index] = text;
    }
  }
  const stage = { metadata: record, paragraphs };
  if (record.paragraphCount === 0 || stageComplete(stage)) {
    await materializeStage(input.entityId, stage);
  } else {
    await saveStage(input.entityId, stage);
  }
}

async function upsertParagraph(
  input: Parameters<ReadingWorkspaceBusinessPort['upsertRecord']>[0],
) {
  const record = input.value as unknown as ReadingWorkspaceParagraphRecord;
  const chapterEntityId = makeReadingWorkspaceEntityId(
    'chapter',
    record.bookId,
    record.chapterIndex,
  );
  let stage = await loadStage(chapterEntityId);
  if (!stage) {
    const existing = await loadChapter(
      record.bookId,
      record.chapterIndex,
    );
    if (!existing) {
      throw new Error(
        'reading paragraph 缺少先行 chapter metadata。',
      );
    }
    if (existing.sourceRevision !== record.sourceRevision) {
      if (existing.sourceRevision !== undefined && record.sourceRevision === undefined) return;
      throw new Error('reading paragraph sourceRevision 等待对应章节。');
    }
    stage = {
      metadata: {
        ...(existing.sourceRevision !== undefined ? { sourceRevision: existing.sourceRevision } : {}),
        bookId: existing.bookId,
        chapterIndex: existing.index,
        title: existing.title,
        charCount: existing.charCount,
        paragraphCount: Math.max(
          existing.paragraphs.length,
          record.paragraphIndex + 1,
        ),
        segments: existing.segmentsMeta.map((segment) => ({
          segmentIndex: segment.segmentIndex,
          startP: segment.startP,
          endP: segment.endP,
          charCount: segment.charCount,
          status: segment.status === 'done' ? 'done' : 'pending',
          ...readingResultProof(segment),
          ...(sharedReadingRequest(segment.request) ? { request: sharedReadingRequest(segment.request) } : {}),
          ...(segment.contentRange ? { contentRange: segment.contentRange } : {}),
          ...(segment.programmeRange ? { programmeRange: segment.programmeRange } : {}),
          ...(segment.updatedAt !== undefined
            ? { updatedAt: segment.updatedAt }
            : {}),
        })),
        ...(existing.contentBlocks ? { contentBlocks: existing.contentBlocks } : {}),
        ...(existing.images ? { images: existing.images.map(({ uri, ...image }) => ({ ...image, fileName: uri.slice(uri.lastIndexOf('/') + 1) })) } : {}),
        ...(existing.imageDescriptions ? { imageDescriptions: existing.imageDescriptions } : {}),
        ...(existing.programmeCues ? { programmeCues: existing.programmeCues } : {}),
      },
      paragraphs: Object.fromEntries(
        existing.paragraphs.map((text, index) => [String(index), text]),
      ),
    };
  }
  if (stage.metadata.sourceRevision !== record.sourceRevision) {
    if (stage.metadata.sourceRevision !== undefined && record.sourceRevision === undefined) return;
    throw new Error('reading paragraph sourceRevision 与暂存章节不一致。');
  }
  stage.paragraphs[String(record.paragraphIndex)] = record.text;
  await materializeStage(chapterEntityId, stage);
}

async function upsertSession(
  input: Parameters<ReadingWorkspaceBusinessPort['upsertRecord']>[0],
) {
  const record = input.value as unknown as ReadingWorkspaceSessionRecord;
  const sessions = parseJson<Record<string, unknown>[]>(
    await RawAsyncStorage.getItem(READING_WORKSPACE_SESSIONS_KEY),
    [],
  );
  const next = {
    id: record.sessionId,
    bookId: record.bookId,
    startedAt: record.startedAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    startPosition: {
      chapterIndex: record.startChapterIndex,
      paragraphIndex: record.startParagraphIndex,
    },
    ...(record.endChapterIndex !== undefined
      && record.endParagraphIndex !== undefined
      ? {
          endPosition: {
            chapterIndex: record.endChapterIndex,
            paragraphIndex: record.endParagraphIndex,
          },
        }
      : {}),
    ...(record.activeSeconds !== undefined
      ? { activeSeconds: record.activeSeconds }
      : {}),
  };
  await RawAsyncStorage.setItem(
    READING_WORKSPACE_SESSIONS_KEY,
    JSON.stringify([
      ...sessions.filter((session) => session.id !== record.sessionId),
      next,
    ].slice(-500)),
  );
}

async function loadAnnotations(bookId: string, chapterIndex: number) {
  return parseJson<{
    annotations: Record<string, unknown>[];
    summaries: Record<string, unknown>[];
  }>(
    await RawAsyncStorage.getItem(
      annotationsKey(bookId, chapterIndex),
    ),
    { annotations: [], summaries: [] },
  );
}

async function upsertAnnotation(
  input: Parameters<ReadingWorkspaceBusinessPort['upsertRecord']>[0],
) {
  let record = input.value as unknown as ReadingWorkspaceAnnotationRecord;
  const storage = await loadAnnotations(
    record.bookId,
    record.chapterIndex,
  );
  const old = storage.annotations.find(item => item.id === record.annotationId);
  if (old) record = retainReadingWorkspaceExtensions('annotation', { ...old, annotationId: old.id, paragraphIndex: old.p },
    record as unknown as Record<string, unknown>) as ReadingWorkspaceAnnotationRecord;
  const proof = readingResultProof(record.sourceVersion ? record :
    old?.text === record.text && old?.createdAt === record.createdAt
      && old?.p === record.paragraphIndex && old?.segmentIndex === record.segmentIndex ? old : record);
  const next = {
    ...proof,
    ...readingSourceAnchor(record),
    id: record.annotationId,
    bookId: record.bookId,
    chapterIndex: record.chapterIndex,
    segmentIndex: record.segmentIndex,
    p: record.paragraphIndex,
    type: record.type,
    text: record.text,
    createdAt: record.createdAt,
    ...(record.updatedAt !== undefined
      ? { updatedAt: record.updatedAt }
      : {}),
  };
  storage.annotations = [
    ...storage.annotations.filter(
      (item) => item.id !== record.annotationId,
    ),
    next,
  ].sort((left, right) => Number(left.p) - Number(right.p));
  await RawAsyncStorage.setItem(
    annotationsKey(record.bookId, record.chapterIndex),
    JSON.stringify(storage),
  );
}

async function upsertSummary(
  input: Parameters<ReadingWorkspaceBusinessPort['upsertRecord']>[0],
) {
  let record =
    input.value as unknown as ReadingWorkspaceSegmentSummaryRecord;
  const storage = await loadAnnotations(
    record.bookId,
    record.chapterIndex,
  );
  const old = storage.summaries.find(item => item.segmentIndex === record.segmentIndex);
  if (old) record = retainReadingWorkspaceExtensions('segment-summary', old,
    record as unknown as Record<string, unknown>) as ReadingWorkspaceSegmentSummaryRecord;
  const proof = readingResultProof(record.sourceVersion ? record :
    old?.summary === record.summary && old?.createdAt === record.createdAt ? old : record);
  storage.summaries = [
    ...storage.summaries.filter(
      (item) => item.segmentIndex !== record.segmentIndex,
    ),
    {
      ...proof,
      ...readingSourceAnchor(record, false),
      bookId: record.bookId,
      chapterIndex: record.chapterIndex,
      segmentIndex: record.segmentIndex,
      summary: record.summary,
      createdAt: record.createdAt,
      ...(record.updatedAt !== undefined
        ? { updatedAt: record.updatedAt }
        : {}),
    },
  ].sort(
    (left, right) =>
      Number(left.segmentIndex) - Number(right.segmentIndex),
  );
  await RawAsyncStorage.setItem(
    annotationsKey(record.bookId, record.chapterIndex),
    JSON.stringify(storage),
  );
}

async function upsertNote(
  input: Parameters<ReadingWorkspaceBusinessPort['upsertRecord']>[0],
) {
  let record = input.value as unknown as ReadingWorkspaceNoteRecord;
  const key = notesKey(record.bookId);
  const notes = parseJson<Record<string, unknown>[]>(
    await RawAsyncStorage.getItem(key),
    [],
  );
  const old = notes.find(item => item.id === record.noteId);
  if (old) record = retainReadingWorkspaceExtensions('note', { ...old, noteId: old.id },
    record as unknown as Record<string, unknown>) as ReadingWorkspaceNoteRecord;
  const next = {
    ...readingSourceAnchor(record),
    id: record.noteId,
    bookId: record.bookId,
    chapterIndex: record.chapterIndex,
    startP: record.startP,
    endP: record.endP,
    selectedText: record.selectedText,
    kind: record.kind,
    ...(record.note !== undefined ? { note: record.note } : {}),
    ...(record.question !== undefined
      ? { question: record.question }
      : {}),
    ...(record.answer !== undefined ? { answer: record.answer } : {}),
    createdAt: record.createdAt,
  };
  await RawAsyncStorage.setItem(
    key,
    JSON.stringify([
      next,
      ...notes.filter((note) => note.id !== record.noteId),
    ]),
  );
}

async function upsertResultAction(
  input: Parameters<ReadingWorkspaceBusinessPort['upsertRecord']>[0],
) {
  const record =
    input.value as unknown as ReadingWorkspaceResultActionRecord;
  const key = resultActionsKey(record.bookId);
  const actions = parseJson<Record<string, Record<string, unknown>>>(
    await RawAsyncStorage.getItem(key),
    {},
  );
  actions[record.resultId] = {
    resultId: record.resultId,
    ...(record.notebookEntryId !== undefined
      ? { notebookEntryId: record.notebookEntryId }
      : {}),
    ...(record.notebookSavedAt !== undefined
      ? { notebookSavedAt: record.notebookSavedAt }
      : {}),
    ...(record.memoryId !== undefined
      ? { memoryId: record.memoryId }
      : {}),
    ...(record.memorySavedAt !== undefined
      ? { memorySavedAt: record.memorySavedAt }
      : {}),
    updatedAt: record.updatedAt,
  };
  await RawAsyncStorage.setItem(key, JSON.stringify(actions));
}

async function upsertWebClip(
  input: Parameters<ReadingWorkspaceBusinessPort['upsertRecord']>[0],
) {
  const record = input.value as unknown as ReadingWorkspaceWebClipRecord;
  const clips = parseJson<Record<string, unknown>[]>(
    await RawAsyncStorage.getItem(READING_WORKSPACE_WEB_CLIPS_KEY),
    [],
  );
  const next = {
    id: record.clipId,
    url: record.url,
    title: record.title,
    ...(record.excerpt !== undefined
      ? { excerpt: record.excerpt }
      : {}),
    capturedAt: record.capturedAt,
  };
  await RawAsyncStorage.setItem(
    READING_WORKSPACE_WEB_CLIPS_KEY,
    JSON.stringify([
      next,
      ...clips.filter((clip) => clip.id !== record.clipId),
    ]),
  );
}

async function upsertRecord(
  input: Parameters<ReadingWorkspaceBusinessPort['upsertRecord']>[0],
) {
  assertReadingWorkspaceRecord(
    input.kind,
    input.entityId,
    input.value,
  );
  switch (input.kind) {
    case 'book':
      return upsertBook(input);
    case 'chapter':
      return upsertChapter(input);
    case 'paragraph':
      return upsertParagraph(input);
    case 'session':
      return upsertSession(input);
    case 'annotation':
      return upsertAnnotation(input);
    case 'segment-summary':
      return upsertSummary(input);
    case 'note':
      return upsertNote(input);
    case 'result-action':
      return upsertResultAction(input);
    case 'web-clip':
      return upsertWebClip(input);
  }
}

async function removeBook(bookId: string, deletedAt: number) {
  const books = await loadLibrary();
  await saveLibrary(
    books.filter((book) => book.id !== bookId),
    deletedAt,
  );
  const keys = await RawAsyncStorage.getAllKeys();
  const bookDynamicKeys = keys.filter((key) => (
    key.startsWith(`${READING_WORKSPACE_CHAPTER_PREFIX}${bookId}.`)
    || key.startsWith(
      `${READING_WORKSPACE_ANNOTATIONS_PREFIX}${bookId}.`,
    )
    || key === notesKey(bookId)
    || key === resultActionsKey(bookId)
  ));
  const stageKeys = keys.filter((key) => key.startsWith(STAGE_PREFIX));
  const stageEntries = stageKeys.length
    ? await RawAsyncStorage.multiGet(stageKeys)
    : [];
  const matchingStageKeys = stageEntries.flatMap(([key, raw]) => {
    const stage = parseJson<ChapterStage | null>(raw, null);
    return stage?.metadata.bookId === bookId ? [key] : [];
  });
  const removableKeys = [
    ...bookDynamicKeys,
    ...matchingStageKeys,
  ];
  if (removableKeys.length) {
    await RawAsyncStorage.multiRemove(removableKeys);
  }
  const sessions = parseJson<Record<string, unknown>[]>(
    await RawAsyncStorage.getItem(READING_WORKSPACE_SESSIONS_KEY),
    [],
  );
  await RawAsyncStorage.setItem(
    READING_WORKSPACE_SESSIONS_KEY,
    JSON.stringify(
      sessions.filter((session) => session.bookId !== bookId),
    ),
  );
}

async function removeDescriptor(
  descriptor: ReturnType<
    typeof deriveReadingWorkspaceRecordsForRawStorage
  >[number],
  key: string,
  deletedAt: number,
) {
  const value = descriptor.value as Record<string, unknown>;
  switch (descriptor.kind) {
    case 'book':
      return removeBook(String(value.bookId), deletedAt);
    case 'chapter':
      await invalidateMaterialSource(String(value.bookId));
      await RawAsyncStorage.multiRemove([
        key,
        stageKey(descriptor.entityId),
      ]);
      return;
    case 'paragraph':
      return;
    case 'session': {
      const sessions = parseJson<Record<string, unknown>[]>(
        await RawAsyncStorage.getItem(key),
        [],
      );
      await RawAsyncStorage.setItem(
        key,
        JSON.stringify(
          sessions.filter(
            (session) => session.id !== value.sessionId,
          ),
        ),
      );
      return;
    }
    case 'annotation': {
      const storage = await loadAnnotations(
        String(value.bookId),
        Number(value.chapterIndex),
      );
      storage.annotations = storage.annotations.filter(
        (item) => item.id !== value.annotationId,
      );
      await RawAsyncStorage.setItem(key, JSON.stringify(storage));
      return;
    }
    case 'segment-summary': {
      const storage = await loadAnnotations(
        String(value.bookId),
        Number(value.chapterIndex),
      );
      storage.summaries = storage.summaries.filter(
        (item) => item.segmentIndex !== value.segmentIndex,
      );
      await RawAsyncStorage.setItem(key, JSON.stringify(storage));
      return;
    }
    case 'note': {
      const notes = parseJson<Record<string, unknown>[]>(
        await RawAsyncStorage.getItem(key),
        [],
      );
      await RawAsyncStorage.setItem(
        key,
        JSON.stringify(
          notes.filter((note) => note.id !== value.noteId),
        ),
      );
      return;
    }
    case 'result-action': {
      const actions = parseJson<Record<string, Record<string, unknown>>>(
        await RawAsyncStorage.getItem(key),
        {},
      );
      delete actions[String(value.resultId)];
      await RawAsyncStorage.setItem(key, JSON.stringify(actions));
      return;
    }
    case 'web-clip': {
      const clips = parseJson<Record<string, unknown>[]>(
        await RawAsyncStorage.getItem(key),
        [],
      );
      await RawAsyncStorage.setItem(
        key,
        JSON.stringify(
          clips.filter((clip) => clip.id !== value.clipId),
        ),
      );
    }
  }
}

async function tombstone(
  input: Parameters<ReadingWorkspaceBusinessPort['tombstone']>[0],
) {
  const keys = (await RawAsyncStorage.getAllKeys())
    .filter(isReadingWorkspaceManagedStorageKey);
  const entries = await RawAsyncStorage.multiGet(keys);
  for (const [key, raw] of entries) {
    if (raw === null) continue;
    const descriptor = deriveReadingWorkspaceRecordsForRawStorage(
      key,
      raw,
    ).find((candidate) => candidate.entityId === input.entityId);
    if (descriptor) {
      await removeDescriptor(descriptor, key, input.deletedAt);
      return;
    }
  }
}

export const readingWorkspaceAsyncStorageBusinessPort:
ReadingWorkspaceBusinessPort = {
  upsertRecord: (input) => enqueueReadingWorkspaceApply(
    () => upsertRecord(input),
  ),
  tombstone: (input) => enqueueReadingWorkspaceApply(
    () => tombstone(input),
  ),
};
