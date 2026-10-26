import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import {
  deriveReadingWorkspaceAnnotationRecords,
  deriveReadingWorkspaceNoteRecords,
} from './syncReadingWorkspaceStorageCollectionsA';
import {
  deriveReadingWorkspaceResultActionRecords,
  deriveReadingWorkspaceSessionRecords,
  deriveReadingWorkspaceWebClipRecords,
} from './syncReadingWorkspaceStorageCollectionsB';
import {
  buildReadingWorkspaceDeleteMutation,
  buildReadingWorkspaceRecordMutation,
  READING_FILE_TYPES,
  READING_NOTE_KINDS,
  assertReadingWorkspaceRecord,
  retainReadingDailyState,
  readingResultProof,
  sharedReadingRequest,
  type ReadingWorkspaceBookRecord,
  type ReadingWorkspaceChapterRecord,
  type ReadingWorkspaceEntityType,
  type ReadingWorkspaceParagraphRecord,
  type ReadingWorkspaceRecordKind,
} from './syncReadingWorkspace';
import {
  makeReadingWorkspaceEntityId,
} from './syncReadingWorkspaceIdentity';
import type {
  JsonValue,
  PlainMutationV1,
} from './syncProtocol';

export const READING_WORKSPACE_LIBRARY_KEY =
  'junluo.reading.library.v1' as const;
export const READING_WORKSPACE_SESSIONS_KEY =
  'junluo.reading.sessions.v1' as const;
export const READING_WORKSPACE_WEB_CLIPS_KEY =
  'junluo.reading.webClips.v1' as const;
export const READING_WORKSPACE_CHAPTER_PREFIX =
  'junluo.reading.chapter.' as const;
export const READING_WORKSPACE_ANNOTATIONS_PREFIX =
  'junluo.reading.annotations.' as const;
export const READING_WORKSPACE_NOTES_PREFIX =
  'junluo.reading.notes.' as const;
export const READING_WORKSPACE_RESULT_ACTIONS_PREFIX =
  'junluo.reading.resultActions.' as const;

export type ReadingWorkspaceStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type ReadingWorkspaceStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type ReadingWorkspaceEnvelopeFactory = (
  entity: {
    domain: 'reading';
    type: ReadingWorkspaceEntityType;
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

type IndexedKey = {
  bookId: string;
  index: number;
};

type ManagedReadingKey =
  | { kind: 'library' }
  | { kind: 'sessions' }
  | { kind: 'web-clips' }
  | ({ kind: 'chapter' | 'annotations' } & IndexedKey)
  | { kind: 'notes' | 'result-actions'; bookId: string };

export type ReadingWorkspaceRecordDescriptor = {
  entityType: ReadingWorkspaceEntityType;
  entityId: string;
  kind: ReadingWorkspaceRecordKind;
  value: JsonValue;
};

const BOOK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const INTEGER_PATTERN = /^(0|[1-9][0-9]{0,8})$/;

export function readingWorkspaceRecordOf(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

export function parseReadingWorkspaceJson(
  raw: string,
  label: string,
): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
}

export function readingWorkspaceString(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false,
) {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length < 1)
    || value.length > maximumLength
  ) {
    throw new Error(`${label} 长度无效。`);
  }
  return value;
}

export function readingWorkspaceOptionalString(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  return value === undefined
    ? undefined
    : readingWorkspaceString(value, label, maximumLength, true);
}

export function readingWorkspaceInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < 0
    || Number(value) > maximum
  ) {
    throw new Error(`${label} 必须是有效非负整数。`);
  }
  return Number(value);
}

export function readingWorkspaceOptionalInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  return value === undefined
    ? undefined
    : readingWorkspaceInteger(value, label, maximum);
}

export function readingWorkspaceBookId(value: unknown, label: string) {
  const bookId = readingWorkspaceString(value, label, 128);
  if (!BOOK_ID_PATTERN.test(bookId)) {
    throw new Error(`${label} 格式无效。`);
  }
  return bookId;
}

function parseIndexedKey(key: string, prefix: string): IndexedKey | null {
  if (!key.startsWith(prefix) || !key.endsWith('.v1')) return null;
  const body = key.slice(prefix.length, -3);
  const split = body.lastIndexOf('.');
  if (split < 1) return null;
  const bookId = body.slice(0, split);
  const indexText = body.slice(split + 1);
  if (!BOOK_ID_PATTERN.test(bookId) || !INTEGER_PATTERN.test(indexText)) {
    return null;
  }
  const index = Number(indexText);
  return Number.isSafeInteger(index) ? { bookId, index } : null;
}

function parseBookKey(key: string, prefix: string) {
  if (!key.startsWith(prefix) || !key.endsWith('.v1')) return null;
  const bookId = key.slice(prefix.length, -3);
  return BOOK_ID_PATTERN.test(bookId) ? bookId : null;
}

export function parseReadingWorkspaceManagedKey(
  key: string,
): ManagedReadingKey | null {
  if (key === READING_WORKSPACE_LIBRARY_KEY) return { kind: 'library' };
  if (key === READING_WORKSPACE_SESSIONS_KEY) return { kind: 'sessions' };
  if (key === READING_WORKSPACE_WEB_CLIPS_KEY) return { kind: 'web-clips' };
  const chapter = parseIndexedKey(
    key,
    READING_WORKSPACE_CHAPTER_PREFIX,
  );
  if (chapter) return { kind: 'chapter', ...chapter };
  const annotations = parseIndexedKey(
    key,
    READING_WORKSPACE_ANNOTATIONS_PREFIX,
  );
  if (annotations) return { kind: 'annotations', ...annotations };
  const notes = parseBookKey(key, READING_WORKSPACE_NOTES_PREFIX);
  if (notes) return { kind: 'notes', bookId: notes };
  const actions = parseBookKey(
    key,
    READING_WORKSPACE_RESULT_ACTIONS_PREFIX,
  );
  return actions
    ? { kind: 'result-actions', bookId: actions }
    : null;
}

export function isReadingWorkspaceManagedStorageKey(key: string) {
  return parseReadingWorkspaceManagedKey(key) !== null;
}

export function makeReadingWorkspaceDescriptor(
  entityType: ReadingWorkspaceEntityType,
  entityId: string,
  kind: ReadingWorkspaceRecordKind,
  value: JsonValue,
): ReadingWorkspaceRecordDescriptor {
  assertReadingWorkspaceRecord(kind, entityId, value);
  return { entityType, entityId, kind, value };
}

function fractionValue(value: unknown, label: string) {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) {
    throw new Error(`${label} 必须在 0–1 之间。`);
  }
  return value;
}

function bookRecord(
  value: unknown,
  index: number,
): ReadingWorkspaceRecordDescriptor {
  const item = readingWorkspaceRecordOf(
    value,
    `reading library books[${index}]`,
  );
  const bookId = readingWorkspaceBookId(item.id, 'reading book id');
  const fileType = readingWorkspaceString(
    item.fileType,
    'reading fileType',
    12,
  );
  if (!READING_FILE_TYPES.includes(
    fileType as typeof READING_FILE_TYPES[number],
  )) {
    throw new Error('reading fileType 无效。');
  }
  const language = readingWorkspaceOptionalString(
    item.language,
    'reading language',
    24,
  );
  const lastOpenedAt = readingWorkspaceOptionalInteger(
    item.lastOpenedAt,
    'reading lastOpenedAt',
  );
  const record: ReadingWorkspaceBookRecord = {
    bookId,
    title: readingWorkspaceString(item.title, 'reading title', 160),
    author: readingWorkspaceString(item.author, 'reading author', 120),
    ...(language !== undefined ? { language } : {}),
    ...(item.contentType !== undefined ? { contentType: item.contentType as 'programme' } : {}),
    ...(item.programme !== undefined ? { programme: item.programme as ReadingWorkspaceBookRecord['programme'] } : {}),
    fileType: fileType as ReadingWorkspaceBookRecord['fileType'],
    totalChapters: readingWorkspaceInteger(
      item.totalChapters,
      'reading totalChapters',
      100_000,
    ),
    currentChapter: readingWorkspaceInteger(
      item.currentChapter,
      'reading currentChapter',
      100_000,
    ),
    currentParagraph: readingWorkspaceInteger(
      item.currentParagraph,
      'reading currentParagraph',
      1_000_000,
    ),
    progressFraction: fractionValue(
      item.progressFraction,
      'reading progressFraction',
    ),
    importedAt: readingWorkspaceInteger(
      item.importedAt,
      'reading importedAt',
    ),
    ...(lastOpenedAt !== undefined ? { lastOpenedAt } : {}),
    ...(item.iReading !== undefined ? { iReading: retainReadingDailyState(undefined, item.iReading) } : {}),
  };
  return makeReadingWorkspaceDescriptor(
    'book',
    makeReadingWorkspaceEntityId('book', bookId),
    'book',
    record as unknown as JsonValue,
  );
}

export function deriveReadingWorkspaceLibraryRecords(raw: string) {
  const parsed = parseReadingWorkspaceJson(raw, 'reading library');
  const books = Array.isArray(parsed)
    ? parsed
    : readingWorkspaceRecordOf(parsed, 'reading library').books;
  if (!Array.isArray(books) || books.length > 10_000) {
    throw new Error('reading library books 无效。');
  }
  const records = books.map(bookRecord);
  ensureReadingWorkspaceUnique(records, 'reading library book');
  return records;
}

function sharedSegment(value: unknown, index: number) {
  const item = readingWorkspaceRecordOf(
    value,
    `reading segments[${index}]`,
  );
  const status = item.status === 'done' ? 'done' : 'pending';
  const updatedAt = status === 'done'
    ? readingWorkspaceOptionalInteger(
        item.updatedAt,
        'reading segment updatedAt',
      )
    : undefined;
  return {
    segmentIndex: readingWorkspaceInteger(
      item.segmentIndex,
      'reading segmentIndex',
      1_000_000,
    ),
    startP: readingWorkspaceInteger(
      item.startP,
      'reading segment startP',
      1_000_000,
    ),
    endP: readingWorkspaceInteger(
      item.endP,
      'reading segment endP',
      1_000_000,
    ),
    charCount: readingWorkspaceInteger(
      item.charCount,
      'reading segment charCount',
      10_000_000,
    ),
    status,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...readingResultProof(item),
    ...(sharedReadingRequest(item.request) ? { request: sharedReadingRequest(item.request) } : {}),
    ...(item.contentRange !== undefined ? { contentRange: item.contentRange as ReadingWorkspaceChapterRecord['segments'][number]['contentRange'] } : {}),
    ...(item.programmeRange !== undefined ? { programmeRange: item.programmeRange as ReadingWorkspaceChapterRecord['segments'][number]['programmeRange'] } : {}),
  } as const;
}

export function deriveReadingWorkspaceChapterRecords(
  raw: string,
  key: IndexedKey,
): ReadingWorkspaceRecordDescriptor[] {
  const item = readingWorkspaceRecordOf(
    parseReadingWorkspaceJson(raw, 'reading chapter'),
    'reading chapter',
  );
  const bookId = readingWorkspaceBookId(
    item.bookId,
    'reading chapter bookId',
  );
  const chapterIndex = readingWorkspaceInteger(
    item.index,
    'reading chapter index',
    100_000,
  );
  if (bookId !== key.bookId || chapterIndex !== key.index) {
    throw new Error('reading chapter key 与正文身份不一致。');
  }
  if (!Array.isArray(item.paragraphs) || item.paragraphs.length > 1_000_000) {
    throw new Error('reading chapter paragraphs 无效。');
  }
  const paragraphs = item.paragraphs.map((paragraph, index) =>
    readingWorkspaceString(
      paragraph,
      `reading paragraph[${index}]`,
      item.contentBlocks !== undefined ? 2_000_000 : 4000,
    ));
  if (!Array.isArray(item.segmentsMeta) || item.segmentsMeta.length > 100_000) {
    throw new Error('reading chapter segmentsMeta 无效。');
  }
  const chapter: ReadingWorkspaceChapterRecord = {
    bookId,
    chapterIndex,
    title: readingWorkspaceString(
      item.title,
      'reading chapter title',
      160,
    ),
    charCount: readingWorkspaceInteger(
      item.charCount,
      'reading chapter charCount',
      10_000_000,
    ),
    paragraphCount: paragraphs.length,
    segments: item.segmentsMeta.map(sharedSegment),
    ...(item.sourceRevision !== undefined ? { sourceRevision: readingWorkspaceString(item.sourceRevision, 'reading sourceRevision', 160) } : {}),
    ...(item.contentBlocks !== undefined ? { contentBlocks: item.contentBlocks as ReadingWorkspaceChapterRecord['contentBlocks'] } : {}),
    ...(Array.isArray(item.images) ? { images: item.images.map(raw => {
      const image = readingWorkspaceRecordOf(raw, 'reading image');
      const uri = readingWorkspaceString(image.uri, 'reading image uri', 10_000);
      return { id: image.id, sourcePath: image.sourcePath, contentVersion: image.contentVersion,
        width: image.width, height: image.height, fileName: uri.slice(uri.lastIndexOf('/') + 1) };
    }) as ReadingWorkspaceChapterRecord['images'] } : {}),
    ...(item.imageDescriptions !== undefined ? { imageDescriptions: item.imageDescriptions as ReadingWorkspaceChapterRecord['imageDescriptions'] } : {}),
    ...(item.programmeCues !== undefined ? { programmeCues: item.programmeCues as ReadingWorkspaceChapterRecord['programmeCues'] } : {}),
  };
  if (chapter.contentBlocks?.some(block => block.kind === 'text' && block.endOffset > (paragraphs[block.paragraphIndex]?.length ?? 0))) {
    throw new Error('reading text block source range 无效。');
  }
  const records = [
    makeReadingWorkspaceDescriptor(
      'chapter',
      makeReadingWorkspaceEntityId('chapter', bookId, chapterIndex),
      'chapter',
      chapter as unknown as JsonValue,
    ),
  ];
  paragraphs.forEach((text, paragraphIndex) => {
    const paragraph: ReadingWorkspaceParagraphRecord = {
      bookId,
      chapterIndex,
      paragraphIndex,
      text,
      ...(chapter.sourceRevision !== undefined ? { sourceRevision: chapter.sourceRevision } : {}),
      ...(item.contentBlocks !== undefined ? { orderedContent: true as const } : {}),
    };
    records.push(makeReadingWorkspaceDescriptor(
      'paragraph',
      makeReadingWorkspaceEntityId(
        'paragraph',
        bookId,
        chapterIndex,
        paragraphIndex,
      ),
      'paragraph',
      paragraph as unknown as JsonValue,
    ));
  });
  return records;
}

export function ensureReadingWorkspaceUnique(
  records: ReadingWorkspaceRecordDescriptor[],
  label: string,
) {
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.entityId)) {
      throw new Error(`${label} 包含重复实体。`);
    }
    ids.add(record.entityId);
  }
}

export function deriveReadingWorkspaceRecordsForRawStorage(
  key: string,
  raw: string | null,
): ReadingWorkspaceRecordDescriptor[] {
  if (raw === null) return [];
  const managed = parseReadingWorkspaceManagedKey(key);
  if (!managed) return [];
  switch (managed.kind) {
    case 'library':
      return deriveReadingWorkspaceLibraryRecords(raw);
    case 'sessions':
      return deriveReadingWorkspaceSessionRecords(raw);
    case 'web-clips':
      return deriveReadingWorkspaceWebClipRecords(raw);
    case 'chapter':
      return deriveReadingWorkspaceChapterRecords(raw, managed);
    case 'annotations':
      return deriveReadingWorkspaceAnnotationRecords(raw, managed);
    case 'notes':
      return deriveReadingWorkspaceNoteRecords(raw, managed.bookId);
    case 'result-actions':
      return deriveReadingWorkspaceResultActionRecords(
        raw,
        managed.bookId,
      );
  }
}

function byEntity(records: ReadingWorkspaceRecordDescriptor[]) {
  return new Map(records.map((record) => [record.entityId, record]));
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function deriveReadingWorkspaceMutationsForStorageChanges(
  input: {
    changes: readonly ReadingWorkspaceStorageChange[];
    reader: ReadingWorkspaceStorageReadPort;
    capturedAt: number;
    envelopeFactory: ReadingWorkspaceEnvelopeFactory;
  },
) {
  readingWorkspaceInteger(
    input.capturedAt,
    'reading.workspace capture time',
  );
  const seen = new Set<string>();
  const mutations: PlainMutationV1[] = [];
  for (const change of input.changes) {
    if (seen.has(change.key)) {
      throw new Error(
        `reading.workspace 同批重复变更 key：${change.key}。`,
      );
    }
    seen.add(change.key);
    if (!isReadingWorkspaceManagedStorageKey(change.key)) continue;
    const previous = byEntity(
      deriveReadingWorkspaceRecordsForRawStorage(
        change.key,
        await input.reader.getItem(change.key),
      ),
    );
    const next = byEntity(
      deriveReadingWorkspaceRecordsForRawStorage(
        change.key,
        change.kind === 'set' ? change.value : null,
      ),
    );
    const entityIds = [...new Set([
      ...previous.keys(),
      ...next.keys(),
    ])].sort();
    for (const entityId of entityIds) {
      const before = previous.get(entityId);
      const after = next.get(entityId);
      if (sameJson(before, after)) continue;
      const source = after ?? before;
      if (!source) continue;
      const envelope = await input.envelopeFactory({
        domain: 'reading',
        type: source.entityType,
        id: source.entityId,
      });
      mutations.push(after
        ? buildReadingWorkspaceRecordMutation({
            envelope,
            entityType: after.entityType,
            entityId: after.entityId,
            kind: after.kind,
            value: after.value,
          })
        : buildReadingWorkspaceDeleteMutation({
            envelope,
            entityType: source.entityType,
            entityId: source.entityId,
            deletedAt: input.capturedAt,
          }));
    }
  }
  return mutations;
}

export async function hasReadingWorkspaceStorageProjectionChange(input: {
  changes: readonly ReadingWorkspaceStorageChange[];
  reader: ReadingWorkspaceStorageReadPort;
}) {
  const seen = new Set<string>();
  for (const change of input.changes) {
    if (seen.has(change.key)) {
      throw new Error(
        `reading.workspace 同批重复变更 key：${change.key}。`,
      );
    }
    seen.add(change.key);
    if (!isReadingWorkspaceManagedStorageKey(change.key)) continue;
    const previous = deriveReadingWorkspaceRecordsForRawStorage(
      change.key,
      await input.reader.getItem(change.key),
    );
    const next = deriveReadingWorkspaceRecordsForRawStorage(
      change.key,
      change.kind === 'set' ? change.value : null,
    );
    if (!sameJson(previous, next)) return true;
  }
  return false;
}
