import {
  type ReadingWorkspaceResultActionRecord,
  type ReadingWorkspaceSessionRecord,
  type ReadingWorkspaceWebClipRecord,
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

export function deriveReadingWorkspaceSessionRecords(raw: string) {
  const parsed = parseReadingWorkspaceJson(raw, 'reading sessions');
  if (!Array.isArray(parsed) || parsed.length > 500) {
    throw new Error('reading sessions 必须是最多 500 条的数组。');
  }
  const records = parsed.map((value, index) => {
    const item = readingWorkspaceRecordOf(
      value,
      `reading sessions[${index}]`,
    );
    const sessionId = readingWorkspaceString(
      item.id,
      'reading session id',
      180,
    );
    const bookId = readingWorkspaceBookId(
      item.bookId,
      'reading session bookId',
    );
    const start = readingWorkspaceRecordOf(
      item.startPosition,
      'reading startPosition',
    );
    const end = item.endPosition === undefined
      ? undefined
      : readingWorkspaceRecordOf(
          item.endPosition,
          'reading endPosition',
        );
    const endedAt = readingWorkspaceOptionalInteger(
      item.endedAt,
      'reading endedAt',
    );
    const activeSeconds = readingWorkspaceOptionalInteger(
      item.activeSeconds,
      'reading activeSeconds',
      10_000_000_000,
    );
    const record: ReadingWorkspaceSessionRecord = {
      sessionId,
      bookId,
      startedAt: readingWorkspaceInteger(
        item.startedAt,
        'reading startedAt',
      ),
      ...(endedAt !== undefined ? { endedAt } : {}),
      startChapterIndex: readingWorkspaceInteger(
        start.chapterIndex,
        'reading start chapterIndex',
        100_000,
      ),
      startParagraphIndex: readingWorkspaceInteger(
        start.paragraphIndex,
        'reading start paragraphIndex',
        1_000_000,
      ),
      ...(end ? {
        endChapterIndex: readingWorkspaceInteger(
          end.chapterIndex,
          'reading end chapterIndex',
          100_000,
        ),
        endParagraphIndex: readingWorkspaceInteger(
          end.paragraphIndex,
          'reading end paragraphIndex',
          1_000_000,
        ),
      } : {}),
      ...(activeSeconds !== undefined ? { activeSeconds } : {}),
    };
    return makeReadingWorkspaceDescriptor(
      'session',
      makeReadingWorkspaceEntityId('session', bookId, sessionId),
      'session',
      record as unknown as JsonValue,
    );
  });
  ensureReadingWorkspaceUnique(records, 'reading session');
  return records;
}

export function deriveReadingWorkspaceResultActionRecords(
  raw: string,
  bookId: string,
) {
  const parsed = readingWorkspaceRecordOf(
    parseReadingWorkspaceJson(raw, 'reading result actions'),
    'reading result actions',
  );
  const records = Object.entries(parsed).map(([mapKey, value]) => {
    const item = readingWorkspaceRecordOf(
      value,
      `reading result action ${mapKey}`,
    );
    const resultId = readingWorkspaceString(
      item.resultId,
      'reading resultId',
      180,
    );
    if (mapKey !== resultId) {
      throw new Error(
        'reading result action map key 与 resultId 不一致。',
      );
    }
    const notebookEntryId = readingWorkspaceOptionalString(
      item.notebookEntryId,
      'reading notebookEntryId',
      160,
    );
    const notebookSavedAt = readingWorkspaceOptionalInteger(
      item.notebookSavedAt,
      'reading notebookSavedAt',
    );
    const memoryId = readingWorkspaceOptionalString(
      item.memoryId,
      'reading memoryId',
      160,
    );
    const memorySavedAt = readingWorkspaceOptionalInteger(
      item.memorySavedAt,
      'reading memorySavedAt',
    );
    const record: ReadingWorkspaceResultActionRecord = {
      bookId,
      resultId,
      ...(notebookEntryId !== undefined ? { notebookEntryId } : {}),
      ...(notebookSavedAt !== undefined ? { notebookSavedAt } : {}),
      ...(memoryId !== undefined ? { memoryId } : {}),
      ...(memorySavedAt !== undefined ? { memorySavedAt } : {}),
      updatedAt: readingWorkspaceInteger(
        item.updatedAt,
        'reading action updatedAt',
      ),
    };
    return makeReadingWorkspaceDescriptor(
      'result',
      makeReadingWorkspaceEntityId(
        'result-action',
        bookId,
        resultId,
      ),
      'result-action',
      record as unknown as JsonValue,
    );
  });
  ensureReadingWorkspaceUnique(records, 'reading result action');
  return records;
}

export function deriveReadingWorkspaceWebClipRecords(raw: string) {
  const parsed = parseReadingWorkspaceJson(raw, 'reading web clips');
  if (!Array.isArray(parsed) || parsed.length > 20_000) {
    throw new Error('reading web clips 必须是有效数组。');
  }
  const records = parsed.map((value, index) => {
    const item = readingWorkspaceRecordOf(
      value,
      `reading web clips[${index}]`,
    );
    const clipId = readingWorkspaceString(
      item.id,
      'reading clip id',
      180,
    );
    const excerpt = readingWorkspaceOptionalString(
      item.excerpt,
      'reading clip excerpt',
      8000,
    );
    const record: ReadingWorkspaceWebClipRecord = {
      clipId,
      url: readingWorkspaceString(
        item.url,
        'reading clip url',
        4096,
      ),
      title: readingWorkspaceString(
        item.title,
        'reading clip title',
        240,
      ),
      ...(excerpt !== undefined ? { excerpt } : {}),
      capturedAt: readingWorkspaceInteger(
        item.capturedAt,
        'reading clip capturedAt',
      ),
    };
    return makeReadingWorkspaceDescriptor(
      'web-clip',
      makeReadingWorkspaceEntityId('web-clip', clipId),
      'web-clip',
      record as unknown as JsonValue,
    );
  });
  ensureReadingWorkspaceUnique(records, 'reading web clip');
  return records;
}
