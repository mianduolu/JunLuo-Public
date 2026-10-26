import {
  READING_NOTE_KINDS,
  readingResultProof,
  readingSourceAnchor,
  type ReadingWorkspaceAnnotationRecord,
  type ReadingWorkspaceNoteRecord,
  type ReadingWorkspaceSegmentSummaryRecord,
} from './syncReadingWorkspace';
import {
  ensureReadingWorkspaceUnique,
  makeReadingWorkspaceDescriptor,
  parseReadingWorkspaceJson,
  readingWorkspaceBookId,
  readingWorkspaceInteger,
  readingWorkspaceOptionalInteger,
  readingWorkspaceOptionalString,
  readingWorkspaceRecordOf,
  readingWorkspaceString,
} from './syncReadingWorkspaceStorageDerivation';
import {
  makeReadingWorkspaceEntityId,
} from './syncReadingWorkspaceIdentity';
import type {
  JsonValue,
} from './syncProtocol';

type IndexedReadingKey = {
  bookId: string;
  index: number;
};

function annotationRecord(
  value: unknown,
  key: IndexedReadingKey,
  index: number,
) {
  const item = readingWorkspaceRecordOf(
    value,
    `reading annotations[${index}]`,
  );
  const bookId = readingWorkspaceBookId(
    item.bookId,
    'reading annotation bookId',
  );
  const chapterIndex = readingWorkspaceInteger(
    item.chapterIndex,
    'reading annotation chapterIndex',
    100_000,
  );
  if (bookId !== key.bookId || chapterIndex !== key.index) {
    throw new Error('reading annotation key 与内容身份不一致。');
  }
  const annotationId = readingWorkspaceString(
    item.id,
    'reading annotation id',
    180,
  );
  const updatedAt = readingWorkspaceOptionalInteger(
    item.updatedAt,
    'reading annotation updatedAt',
  );
  const record: ReadingWorkspaceAnnotationRecord = {
    annotationId,
    bookId,
    chapterIndex,
    segmentIndex: readingWorkspaceInteger(
      item.segmentIndex,
      'reading annotation segmentIndex',
      1_000_000,
    ),
    paragraphIndex: readingWorkspaceInteger(
      item.p,
      'reading annotation paragraphIndex',
      1_000_000,
    ),
    type: readingWorkspaceString(
      item.type,
      'reading annotation type',
      24,
    ),
    text: readingWorkspaceString(
      item.text,
      'reading annotation text',
      900,
    ),
    createdAt: readingWorkspaceInteger(
      item.createdAt,
      'reading annotation createdAt',
    ),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...readingResultProof(item),
    ...readingSourceAnchor(item),
  };
  return makeReadingWorkspaceDescriptor(
    'annotation',
    makeReadingWorkspaceEntityId(
      'annotation',
      bookId,
      chapterIndex,
      annotationId,
    ),
    'annotation',
    record as unknown as JsonValue,
  );
}

function summaryRecord(
  value: unknown,
  key: IndexedReadingKey,
  index: number,
) {
  const item = readingWorkspaceRecordOf(
    value,
    `reading summaries[${index}]`,
  );
  const bookId = readingWorkspaceBookId(
    item.bookId,
    'reading summary bookId',
  );
  const chapterIndex = readingWorkspaceInteger(
    item.chapterIndex,
    'reading summary chapterIndex',
    100_000,
  );
  if (bookId !== key.bookId || chapterIndex !== key.index) {
    throw new Error('reading summary key 与内容身份不一致。');
  }
  const segmentIndex = readingWorkspaceInteger(
    item.segmentIndex,
    'reading summary segmentIndex',
    1_000_000,
  );
  const updatedAt = readingWorkspaceOptionalInteger(
    item.updatedAt,
    'reading summary updatedAt',
  );
  const record: ReadingWorkspaceSegmentSummaryRecord = {
    bookId,
    chapterIndex,
    segmentIndex,
    summary: readingWorkspaceString(
      item.summary,
      'reading summary',
      900,
    ),
    createdAt: readingWorkspaceInteger(
      item.createdAt,
      'reading summary createdAt',
    ),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...readingResultProof(item),
    ...readingSourceAnchor(item, false),
  };
  return makeReadingWorkspaceDescriptor(
    'result',
    makeReadingWorkspaceEntityId(
      'segment-summary',
      bookId,
      chapterIndex,
      segmentIndex,
    ),
    'segment-summary',
    record as unknown as JsonValue,
  );
}

export function deriveReadingWorkspaceAnnotationRecords(
  raw: string,
  key: IndexedReadingKey,
) {
  const value = readingWorkspaceRecordOf(
    parseReadingWorkspaceJson(raw, 'reading chapter annotations'),
    'reading chapter annotations',
  );
  if (!Array.isArray(value.annotations) || !Array.isArray(value.summaries)) {
    throw new Error('reading chapter annotations 结构无效。');
  }
  const records = [
    ...value.annotations.map((item, index) =>
      annotationRecord(item, key, index)),
    ...value.summaries.map((item, index) =>
      summaryRecord(item, key, index)),
  ];
  ensureReadingWorkspaceUnique(records, 'reading annotation/result');
  return records;
}

export function deriveReadingWorkspaceNoteRecords(
  raw: string,
  bookId: string,
) {
  const parsed = parseReadingWorkspaceJson(raw, 'reading notes');
  if (!Array.isArray(parsed) || parsed.length > 100_000) {
    throw new Error('reading notes 必须是有效数组。');
  }
  const records = parsed.map((value, index) => {
    const item = readingWorkspaceRecordOf(
      value,
      `reading notes[${index}]`,
    );
    const itemBookId = readingWorkspaceBookId(
      item.bookId,
      'reading note bookId',
    );
    if (itemBookId !== bookId) {
      throw new Error('reading note key 与内容 bookId 不一致。');
    }
    const noteId = readingWorkspaceString(
      item.id,
      'reading note id',
      180,
    );
    const kind = readingWorkspaceString(
      item.kind,
      'reading note kind',
      16,
    );
    if (!READING_NOTE_KINDS.includes(
      kind as typeof READING_NOTE_KINDS[number],
    )) {
      throw new Error('reading note kind 无效。');
    }
    const note = readingWorkspaceOptionalString(
      item.note,
      'reading note',
      1200,
    );
    const question = readingWorkspaceOptionalString(
      item.question,
      'reading question',
      400,
    );
    const answer = readingWorkspaceOptionalString(
      item.answer,
      'reading answer',
      1600,
    );
    const record: ReadingWorkspaceNoteRecord = {
      noteId,
      bookId,
      chapterIndex: readingWorkspaceInteger(
        item.chapterIndex,
        'reading note chapterIndex',
        100_000,
      ),
      startP: readingWorkspaceInteger(
        item.startP,
        'reading note startP',
        1_000_000,
      ),
      endP: readingWorkspaceInteger(
        item.endP,
        'reading note endP',
        1_000_000,
      ),
      selectedText: readingWorkspaceString(
        item.selectedText,
        'reading selectedText',
        1200,
      ),
      kind: kind as ReadingWorkspaceNoteRecord['kind'],
      ...readingSourceAnchor(item),
      ...(note !== undefined ? { note } : {}),
      ...(question !== undefined ? { question } : {}),
      ...(answer !== undefined ? { answer } : {}),
      createdAt: readingWorkspaceInteger(
        item.createdAt,
        'reading note createdAt',
      ),
    };
    return makeReadingWorkspaceDescriptor(
      'result',
      makeReadingWorkspaceEntityId('note', bookId, noteId),
      'note',
      record as unknown as JsonValue,
    );
  });
  ensureReadingWorkspaceUnique(records, 'reading note');
  return records;
}
