import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import {
  makeReadingWorkspaceEntityId,
} from './syncReadingWorkspaceIdentity';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const READING_WORKSPACE_ADAPTER_ID =
  'reading.workspace' as const;
export const READING_WORKSPACE_SCHEMA_VERSION = 1 as const;
export const READING_WORKSPACE_RETENTION_CLASS =
  'reading-workspace' as const;

export const READING_FILE_TYPES = Object.freeze([
  'epub',
  'txt',
  'pdf',
  'url',
] as const);
export const READING_SHARED_SEGMENT_STATUSES = Object.freeze([
  'pending',
  'done',
] as const);
export const READING_NOTE_KINDS = Object.freeze([
  'my-note',
  'question',
] as const);

export type ReadingWorkspaceEntityType =
  | 'book'
  | 'chapter'
  | 'paragraph'
  | 'session'
  | 'annotation'
  | 'result'
  | 'web-clip';

export type ReadingWorkspaceRecordKind =
  | 'book'
  | 'chapter'
  | 'paragraph'
  | 'session'
  | 'annotation'
  | 'segment-summary'
  | 'note'
  | 'result-action'
  | 'web-clip';

export type ReadingWorkspaceBookRecord = {
  bookId: string;
  title: string;
  author: string;
  language?: string;
  contentType?: 'programme';
  programme?: ReadingWorkspaceProgramme;
  fileType: typeof READING_FILE_TYPES[number];
  totalChapters: number;
  currentChapter: number;
  currentParagraph: number;
  progressFraction: number;
  importedAt: number;
  lastOpenedAt?: number;
  iReading?: ReadingDailyStateRecord;
};

export type ReadingWorkspaceProgramme = {
  episodes?: Array<{ title: string; sourceUrl: string; sourceName: string; language: string; durationMs: number }>;
  sourceUrl: string; series: string; sourceName: string; language: string; durationMs?: number;
  preparation: 'missing' | 'preparing' | 'ready' | 'failed'; updatedAt: number;
  attemptedAt?: number; preparedAt?: number; errorCode?: string; transcriptUrl?: string;
  format?: 'srt' | 'vtt' | 'html'; sourceVersion?: string;
};

export type ReadingDailyStateRecord = {
  version: 1; confirmedAt: number; start: { chapterIndex: number; segmentIndex: number };
  cursor: { chapterIndex: number; segmentIndex: number }; remainderMs: number; opportunityAt?: number;
  requestReservation?: { id: string; opportunityAt: number; activityId?: string };
  reachedEnd?: boolean; completedAll?: boolean; needsSourceConfirmation?: boolean; updatedAt: number;
  activity?: { id: string; status: 'preparing' | 'reading' | 'paused' | 'ended'; plannedMs: number | null; remainingMs: number | null;
    memoryIngestionVersion?: 1;
    schedule?: { itemId: string; sourceUpdatedAt: number; windowEndAt: number; plannedMs: number; habitId?: string;
      planRevision?: number; occurrenceId?: string; completionId?: string; totalPlannedMs?: number;
      baseElapsedMs?: number; baseCompletedUnitCount?: number; choiceSourceId?: string; choiceVersion?: number; previousActivityId?: string };
    elapsedMs?: number; completedUnitCount?: number; endedAt?: number; deferredOpportunity?: { at: number; retryAt: number };
    startedAt: number; checkpointAt: number; updatedAt: number; operationId: string; focusId?: string; focusWorkMs?: number;
    jointOnly?: boolean; endReason?: 'duration' | 'focus' | 'manual' | 'complete' };
  events: Array<{ id: string; at: number; change: '开始' | '继续' | '暂停' | '本次活动结束' | '已完成全书阅读' | '已读完本期文字稿。' }>;
};

export type ReadingWorkspaceSegmentRecord = {
  memoryIngestionVersion?: 1;
  request?: ReadingWorkspaceRequestRecord;
  resultActivityId?: string | null;
  segmentIndex: number;
  startP: number;
  endP: number;
  charCount: number;
  status: typeof READING_SHARED_SEGMENT_STATUSES[number];
  updatedAt?: number;
  sourceVersion?: string;
  resultOperationId?: string;
  contentRange?: { startBlock: number; startOffset: number; endBlock: number; endOffset: number };
  programmeRange?: { startMs: number; endMs: number; timed: boolean };
};

export type ReadingWorkspaceRequestRecord = {
  memoryIngestionVersion?: 1;
  id: string; runtimeId: string; startedAt: number; sourceVersion: string; kind: 'manual' | 'daily';
  transportStartedAt?: number; resultActivityId?: string | null;
  save: { attempts: number; phase: 'result' | 'annotations' | 'done';
    outcome: 'pending' | 'unknown' | 'exhausted' | 'complete'; resultRetained: boolean };
};

/** Only persistence metadata travels; the pending result remains in its original local chapter. */
export function sharedReadingRequest(value: unknown): ReadingWorkspaceRequestRecord | undefined {
  if (!value || typeof value !== 'object' || !(value as Record<string, unknown>).save) return undefined;
  const v = value as ReadingWorkspaceRequestRecord;
  for (const field of ['id', 'runtimeId', 'sourceVersion'] as const) assertString(v[field], field, 300);
  assertInteger(v.startedAt, 'request startedAt'); assertOptionalInteger(v.transportStartedAt, 'request transportStartedAt');
  assertEnum(v.kind, ['manual', 'daily'], 'request kind');
  if (v.resultActivityId !== null) assertOptionalString(v.resultActivityId, 'request activity', 300);
  if (v.memoryIngestionVersion !== undefined && (v.memoryIngestionVersion !== 1 || !v.resultActivityId)) throw new Error('reading request memory proof 无效。');
  const save = recordOf(v.save, 'reading result save');
  assertKeys(save, ['attempts', 'phase', 'outcome', 'resultRetained'], [], 'reading result save');
  assertInteger(save.attempts, 'reading save attempts', 4);
  assertEnum(save.phase, ['result', 'annotations', 'done'], 'reading save phase');
  assertEnum(save.outcome, ['pending', 'unknown', 'exhausted', 'complete'], 'reading save outcome');
  if (typeof save.resultRetained !== 'boolean') throw new Error('reading save retained 无效。');
  return { id: v.id, runtimeId: v.runtimeId, sourceVersion: v.sourceVersion, startedAt: v.startedAt, kind: v.kind,
    ...(v.transportStartedAt !== undefined ? { transportStartedAt: v.transportStartedAt } : {}),
    ...(v.resultActivityId !== undefined ? { resultActivityId: v.resultActivityId } : {}),
    ...(v.memoryIngestionVersion === 1 ? { memoryIngestionVersion: 1 as const } : {}), save: { ...v.save } };
}

export function retainReadingRequest(current: unknown, incoming: unknown): ReadingWorkspaceRequestRecord | undefined {
  const old = sharedReadingRequest(current), next = sharedReadingRequest(incoming);
  if (!old) return next;
  if (!next) return old;
  if (old.id !== next.id || old.sourceVersion !== next.sourceVersion) return next.startedAt >= old.startedAt ? next : old;
  const winner = old.save.outcome === 'complete' || old.save.attempts > next.save.attempts ? old : next;
  const other = winner === old ? next : old;
  const resultActivityId = winner.resultActivityId === undefined ? other.resultActivityId : winner.resultActivityId;
  const memoryIngestionVersion = winner.memoryIngestionVersion ?? (resultActivityId === other.resultActivityId ? other.memoryIngestionVersion : undefined);
  return { ...winner, ...(resultActivityId !== undefined ? { resultActivityId } : {}),
    ...(memoryIngestionVersion === 1 ? { memoryIngestionVersion: 1 as const } : {}),
    save: { ...winner.save, attempts: Math.max(old.save.attempts, next.save.attempts),
    resultRetained: old.save.resultRetained || next.save.resultRetained } };
}

export type ReadingWorkspaceContentBlock =
  | { kind: 'text'; paragraphIndex: number; startOffset: number; endOffset: number }
  | { kind: 'image'; imageId: string };
export type ReadingWorkspaceImage = {
  id: string; sourcePath: string; fileName: string; contentVersion: string; width: number; height: number;
};
export type ReadingWorkspaceImageDescription = { imageId: string; contentVersion: string; text: string; savedAt: number };

export type ReadingWorkspaceChapterRecord = {
  sourceRevision?: string;
  bookId: string;
  chapterIndex: number;
  title: string;
  charCount: number;
  paragraphCount: number;
  segments: ReadingWorkspaceSegmentRecord[];
  contentBlocks?: ReadingWorkspaceContentBlock[];
  images?: ReadingWorkspaceImage[];
  imageDescriptions?: ReadingWorkspaceImageDescription[];
  programmeCues?: Array<{ paragraphIndex: number; startMs: number; endMs: number }>;
};

export type ReadingWorkspaceParagraphRecord = {
  sourceRevision?: string;
  bookId: string;
  chapterIndex: number;
  paragraphIndex: number;
  text: string;
  orderedContent?: true;
};

export type ReadingWorkspaceSessionRecord = {
  sessionId: string;
  bookId: string;
  startedAt: number;
  endedAt?: number;
  startChapterIndex: number;
  startParagraphIndex: number;
  endChapterIndex?: number;
  endParagraphIndex?: number;
  activeSeconds?: number;
};

export type ReadingWorkspaceAnnotationRecord = {
  memoryIngestionVersion?: 1;
  resultActivityId?: string | null;
  sourceAnchor?: ReadingWorkspaceSourceAnchor;
  annotationId: string;
  bookId: string;
  chapterIndex: number;
  segmentIndex: number;
  paragraphIndex: number;
  type: string;
  text: string;
  createdAt: number;
  updatedAt?: number;
  sourceVersion?: string;
  resultOperationId?: string;
};

export type ReadingWorkspaceSegmentSummaryRecord = {
  memoryIngestionVersion?: 1;
  resultActivityId?: string | null;
  sourceAnchor?: ReadingWorkspaceSourceAnchor;
  bookId: string;
  chapterIndex: number;
  segmentIndex: number;
  summary: string;
  createdAt: number;
  updatedAt?: number;
  sourceVersion?: string;
  resultOperationId?: string;
};

export type ReadingWorkspaceNoteRecord = {
  sourceAnchor?: ReadingWorkspaceSourceAnchor;
  noteId: string;
  bookId: string;
  chapterIndex: number;
  startP: number;
  endP: number;
  selectedText: string;
  kind: typeof READING_NOTE_KINDS[number];
  note?: string;
  question?: string;
  answer?: string;
  createdAt: number;
};

export type ReadingWorkspaceSourceAnchor = { revision: string; originalChapterTitle: string; p?: number; endP?: number };

export type ReadingWorkspaceResultActionRecord = {
  bookId: string;
  resultId: string;
  notebookEntryId?: string;
  notebookSavedAt?: number;
  memoryId?: string;
  memorySavedAt?: number;
  updatedAt: number;
};

export type ReadingWorkspaceWebClipRecord = {
  clipId: string;
  url: string;
  title: string;
  excerpt?: string;
  capturedAt: number;
};

export type ReadingWorkspaceRecord =
  | ReadingWorkspaceBookRecord
  | ReadingWorkspaceChapterRecord
  | ReadingWorkspaceParagraphRecord
  | ReadingWorkspaceSessionRecord
  | ReadingWorkspaceAnnotationRecord
  | ReadingWorkspaceSegmentSummaryRecord
  | ReadingWorkspaceNoteRecord
  | ReadingWorkspaceResultActionRecord
  | ReadingWorkspaceWebClipRecord;

function recordOf(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) {
    throw new Error(`${label} 包含未允许字段：${extra.sort().join(', ')}。`);
  }
  const missing = required.filter((key) => !(key in value));
  if (missing.length) {
    throw new Error(`${label} 缺少字段：${missing.join(', ')}。`);
  }
}

function assertString(
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
}

function assertOptionalString(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  if (value !== undefined) {
    assertString(value, label, maximumLength, true);
  }
}

function assertInteger(
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
}

function assertOptionalInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (value !== undefined) assertInteger(value, label, maximum);
}

function assertFraction(value: unknown, label: string) {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) {
    throw new Error(`${label} 必须在 0–1 之间。`);
  }
}

function assertEnum(
  value: unknown,
  allowed: readonly string[],
  label: string,
) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${label} 无效。`);
  }
}

function assertIdentity(
  entityId: string,
  kind: Parameters<typeof makeReadingWorkspaceEntityId>[0],
  ...parts: Array<string | number>
) {
  if (entityId !== makeReadingWorkspaceEntityId(kind, ...parts)) {
    throw new Error(`reading.workspace ${kind} entity id 不一致。`);
  }
}

function assertBook(entityId: string, value: Record<string, unknown>) {
  assertKeys(
    value,
    [
      'bookId',
      'title',
      'author',
      'fileType',
      'totalChapters',
      'currentChapter',
      'currentParagraph',
      'progressFraction',
      'importedAt',
    ],
    ['language', 'lastOpenedAt', 'iReading', 'contentType', 'programme'],
    'reading book',
  );
  assertString(value.bookId, 'reading bookId', 128);
  assertIdentity(entityId, 'book', value.bookId as string);
  assertString(value.title, 'reading title', 160);
  assertString(value.author, 'reading author', 120);
  assertOptionalString(value.language, 'reading language', 24);
  assertEnum(value.fileType, READING_FILE_TYPES, 'reading fileType');
  assertInteger(value.totalChapters, 'reading totalChapters', 100_000);
  assertInteger(value.currentChapter, 'reading currentChapter', 100_000);
  assertInteger(value.currentParagraph, 'reading currentParagraph', 1_000_000);
  assertFraction(value.progressFraction, 'reading progressFraction');
  assertInteger(value.importedAt, 'reading importedAt');
  assertOptionalInteger(value.lastOpenedAt, 'reading lastOpenedAt');
  if (value.iReading !== undefined) assertReadingDailyState(value.iReading);
  if (value.contentType !== undefined && value.contentType !== 'programme') throw new Error('reading contentType 无效。');
  if ((value.contentType === 'programme') !== (value.programme !== undefined)) throw new Error('reading programme identity 无效。');
  if (value.programme !== undefined) assertReadingProgramme(value.programme);
}

export function assertReadingProgramme(value: unknown): asserts value is ReadingWorkspaceProgramme {
  const p = recordOf(value, 'reading programme');
  assertKeys(p, ['sourceUrl', 'series', 'sourceName', 'language', 'preparation', 'updatedAt'],
    ['durationMs', 'attemptedAt', 'preparedAt', 'errorCode', 'transcriptUrl', 'format', 'sourceVersion', 'episodes'], 'reading programme');
  if (p.episodes !== undefined) {
    if (!Array.isArray(p.episodes) || p.episodes.length < 2 || p.episodes.length > 200) throw new Error('reading programme episodes');
    for (const item of p.episodes) {
      const e = recordOf(item, 'programme episode');
      assertKeys(e, ['title', 'sourceUrl', 'sourceName', 'language', 'durationMs'], [], 'programme episode');
      assertString(e.title, 'episode title', 160); assertString(e.sourceUrl, 'episode sourceUrl', 4096);
      assertString(e.sourceName, 'episode sourceName', 500); assertString(e.language, 'episode language', 24);
      assertInteger(e.durationMs, 'episode durationMs');
      if (!e.durationMs) throw new Error('episode durationMs');
    }
    if (new Set(p.episodes.map(e => e.sourceUrl)).size !== p.episodes.length) throw new Error('duplicate programme episode');
  }
  assertString(p.sourceUrl, 'reading programme sourceUrl', 4096);
  for (const key of ['series', 'sourceName']) assertString(p[key], `reading programme ${key}`, 500);
  assertString(p.language, 'reading programme language', 24);
  assertEnum(p.preparation, ['missing', 'preparing', 'ready', 'failed'], 'reading programme preparation');
  assertInteger(p.updatedAt, 'reading programme updatedAt');
  for (const key of ['durationMs', 'attemptedAt', 'preparedAt']) assertOptionalInteger(p[key], `reading programme ${key}`);
  if (p.durationMs === 0) throw new Error('reading programme durationMs 无效。');
  assertOptionalString(p.errorCode, 'reading programme errorCode', 300);
  assertOptionalString(p.transcriptUrl, 'reading programme transcriptUrl', 4096);
  assertOptionalString(p.sourceVersion, 'reading programme sourceVersion', 160);
  if (p.format !== undefined) assertEnum(p.format, ['srt', 'vtt', 'html'], 'reading programme format');
}

/** A catalogue-only carrier cannot turn already saved transcript material back into missing. */
export function retainReadingProgramme(current: unknown, incoming: unknown): ReadingWorkspaceProgramme | undefined {
  if (current !== undefined) assertReadingProgramme(current);
  if (incoming !== undefined) assertReadingProgramme(incoming);
  const old = current as ReadingWorkspaceProgramme | undefined;
  let next = incoming as ReadingWorkspaceProgramme | undefined;
  if (!old) return next;
  if (!next) return old;
  if (old.sourceUrl !== next.sourceUrl) return next;
  if (old.episodes && !next.episodes) next = { ...next, episodes: old.episodes, sourceVersion: old.sourceVersion };
  if (old.preparation === 'ready' && next.preparation !== 'ready') return old;
  if (next.preparation === 'ready' && old.preparation !== 'ready') return next;
  if (next.episodes && !old.episodes) return next;
  if (next.updatedAt !== old.updatedAt) return next.updatedAt > old.updatedAt ? next : old;
  return JSON.stringify(next) > JSON.stringify(old) ? next : old;
}

export function assertReadingDailyState(value: unknown): asserts value is ReadingDailyStateRecord {
  const v = recordOf(value, 'I reading');
  assertKeys(v, ['version', 'confirmedAt', 'start', 'cursor', 'remainderMs', 'updatedAt', 'events'],
    ['opportunityAt', 'requestReservation', 'reachedEnd', 'completedAll', 'needsSourceConfirmation', 'activity'], 'I reading');
  if (v.version !== 1) throw new Error('I reading version');
  for (const field of ['confirmedAt', 'updatedAt', 'remainderMs']) assertInteger(v[field], field);
  if (Number(v.remainderMs) >= 25 * 60_000) throw new Error('I reading remainder');
  assertOptionalInteger(v.opportunityAt, 'I reading opportunity');
  for (const field of ['reachedEnd', 'completedAll', 'needsSourceConfirmation']) if (v[field] !== undefined && typeof v[field] !== 'boolean') throw new Error('I reading flag');
  for (const field of ['start', 'cursor']) {
    const p = recordOf(v[field], field);
    assertKeys(p, ['chapterIndex', 'segmentIndex'], [], field);
    assertInteger(p.chapterIndex, field); assertInteger(p.segmentIndex, field);
  }
  if (v.requestReservation !== undefined) {
    const r = recordOf(v.requestReservation, 'reading reservation');
    assertKeys(r, ['id', 'opportunityAt'], ['activityId'], 'reading reservation');
    assertString(r.id, 'reading reservation id', 300); assertInteger(r.opportunityAt, 'reading reservation time');
    assertOptionalString(r.activityId, 'reading reservation activity', 300);
  }
  if (v.activity !== undefined) {
    const a = recordOf(v.activity, 'reading activity');
    assertKeys(a, ['id', 'status', 'plannedMs', 'remainingMs', 'startedAt', 'checkpointAt', 'updatedAt', 'operationId'],
      ['focusId', 'focusWorkMs', 'jointOnly', 'endReason', 'schedule', 'elapsedMs', 'completedUnitCount', 'endedAt', 'deferredOpportunity', 'memoryIngestionVersion'], 'reading activity');
    assertString(a.id, 'reading activity id', 300); assertString(a.operationId, 'reading operation id', 300);
    assertEnum(a.status, ['preparing', 'reading', 'paused', 'ended'], 'reading activity status');
    if (a.memoryIngestionVersion !== undefined && a.memoryIngestionVersion !== 1) throw new Error('reading activity memory version 无效。');
    if (a.status === 'preparing' && a.remainingMs !== null) throw new Error('reading preparing remainingMs 必须为空。');
    for (const key of ['startedAt', 'checkpointAt', 'updatedAt']) assertInteger(a[key], key);
    for (const key of ['plannedMs', 'remainingMs']) if (a[key] !== null) assertInteger(a[key], key);
    assertOptionalString(a.focusId, 'reading focus id', 300); assertOptionalInteger(a.focusWorkMs, 'reading focus work');
    for (const key of ['elapsedMs', 'completedUnitCount', 'endedAt']) assertOptionalInteger(a[key], key);
    if (a.deferredOpportunity !== undefined) {
      const deferred = recordOf(a.deferredOpportunity, 'reading deferred opportunity');
      assertKeys(deferred, ['at', 'retryAt'], [], 'reading deferred opportunity');
      assertInteger(deferred.at, 'reading deferred at'); assertInteger(deferred.retryAt, 'reading deferred retry');
      if (Number(deferred.retryAt) <= Number(deferred.at)) throw new Error('reading deferred retry');
    }
    if (a.schedule !== undefined) {
      const schedule = recordOf(a.schedule, 'reading schedule');
      assertKeys(schedule, ['itemId', 'sourceUpdatedAt', 'windowEndAt', 'plannedMs'],
        ['habitId', 'planRevision', 'occurrenceId', 'completionId', 'totalPlannedMs', 'baseElapsedMs', 'baseCompletedUnitCount', 'choiceSourceId', 'choiceVersion', 'previousActivityId'], 'reading schedule');
      assertString(schedule.itemId, 'reading schedule item', 242);
      assertOptionalString(schedule.habitId, 'reading schedule habit', 256);
      for (const key of ['sourceUpdatedAt', 'windowEndAt', 'plannedMs']) assertInteger(schedule[key], key);
      for (const key of ['planRevision', 'totalPlannedMs', 'baseElapsedMs', 'baseCompletedUnitCount', 'choiceVersion']) assertOptionalInteger(schedule[key], key);
      for (const key of ['occurrenceId', 'completionId', 'choiceSourceId', 'previousActivityId']) assertOptionalString(schedule[key], key, 300);
    }
    if (a.jointOnly !== undefined && typeof a.jointOnly !== 'boolean') throw new Error('reading joint flag');
    if (a.endReason !== undefined) assertEnum(a.endReason, ['duration', 'focus', 'manual', 'complete'], 'reading end reason');
  }
  if (!Array.isArray(v.events) || v.events.length > 8) throw new Error('I reading events');
  for (const value of v.events) {
    const e = recordOf(value, 'reading event');
    assertKeys(e, ['id', 'at', 'change'], [], 'reading event');
    assertString(e.id, 'reading event id', 300); assertInteger(e.at, 'reading event at');
    assertEnum(e.change, ['开始', '继续', '暂停', '本次活动结束', '已完成全书阅读', '已读完本期文字稿。'], 'reading event change');
  }
}

/** A legacy carrier may update you's page but cannot erase I's independent progress. */
export function retainReadingDailyState(current: unknown, incoming: unknown): ReadingDailyStateRecord | undefined {
  if (current !== undefined) assertReadingDailyState(current);
  if (incoming !== undefined) assertReadingDailyState(incoming);
  if (!current) return incoming as ReadingDailyStateRecord | undefined;
  if (!incoming) return current as ReadingDailyStateRecord;
  const old = current as ReadingDailyStateRecord, next = incoming as ReadingDailyStateRecord;
  const sameActivity = !!old.activity && old.activity.id === next.activity?.id;
  const oldRevision = old.activity?.schedule?.planRevision ?? 0, nextRevision = next.activity?.schedule?.planRevision ?? 0;
  const winner = sameActivity && oldRevision !== nextRevision ? nextRevision > oldRevision ? next : old
    : next.updatedAt > old.updatedAt ? next : old;
  const other = winner === next ? old : next;
  const result = winner.needsSourceConfirmation === undefined && other.needsSourceConfirmation !== undefined
    ? { ...winner, needsSourceConfirmation: other.needsSourceConfirmation } : { ...winner };
  if (winner.activity && other.activity?.id === winner.activity.id) {
    result.activity = { ...winner.activity };
    if (other.activity.status === 'ended' && other.activity.endReason === 'manual' && winner.activity.status !== 'ended') {
      result.activity = { ...other.activity };
    }
    if (result.activity.schedule && other.activity.schedule?.itemId === result.activity.schedule.itemId) {
      result.activity.schedule = { ...other.activity.schedule, ...result.activity.schedule };
    }
    for (const field of ['schedule', 'elapsedMs', 'completedUnitCount', 'endedAt', 'memoryIngestionVersion'] as const) {
      if (result.activity[field] === undefined && other.activity[field] !== undefined) {
        Object.assign(result.activity, { [field]: other.activity[field] });
      }
    }
    for (const field of ['elapsedMs', 'completedUnitCount'] as const) {
      if (other.activity[field] !== undefined) result.activity[field] = Math.max(result.activity[field] ?? 0, other.activity[field]);
    }
  }
  if (result.requestReservation && other.requestReservation?.id === result.requestReservation.id
    && result.requestReservation.activityId === undefined && other.requestReservation.activityId !== undefined) {
    result.requestReservation = { ...result.requestReservation, activityId: other.requestReservation.activityId };
  }
  return result;
}

export function readingResultProof(record: { sourceVersion?: unknown; resultOperationId?: unknown; resultActivityId?: unknown; memoryIngestionVersion?: unknown },
  previous?: { sourceVersion?: unknown; resultOperationId?: unknown; resultActivityId?: unknown; memoryIngestionVersion?: unknown }) {
  assertOptionalString(record.sourceVersion, 'reading source version', 160);
  assertOptionalString(record.resultOperationId, 'reading result operation', 300);
  const sameResult = !!record.resultOperationId && !!record.sourceVersion && record.resultOperationId === previous?.resultOperationId && record.sourceVersion === previous?.sourceVersion;
  const resultActivityId = record.resultActivityId !== undefined ? record.resultActivityId
    : sameResult
      ? previous?.resultActivityId : undefined;
  if (resultActivityId !== null) assertOptionalString(resultActivityId, 'reading result activity', 300);
  const memoryIngestionVersion = record.memoryIngestionVersion !== undefined ? record.memoryIngestionVersion : (sameResult && resultActivityId === previous?.resultActivityId ? previous?.memoryIngestionVersion : undefined);
  if (memoryIngestionVersion !== undefined && (memoryIngestionVersion !== 1 || !resultActivityId || !record.resultOperationId || !record.sourceVersion)) throw new Error('reading result memory proof 无效。');
  return {
    ...(record.sourceVersion !== undefined ? { sourceVersion: record.sourceVersion as string } : {}),
    ...(record.resultOperationId !== undefined ? { resultOperationId: record.resultOperationId as string } : {}),
    ...(resultActivityId !== undefined ? { resultActivityId: resultActivityId as string | null } : {}),
    ...(memoryIngestionVersion === 1 ? { memoryIngestionVersion: 1 as const } : {}),
  };
}

export function readingSourceAnchor(record: { sourceAnchor?: unknown }, positions = true): { sourceAnchor?: ReadingWorkspaceSourceAnchor } {
  if (record.sourceAnchor === undefined) return {};
  const anchor = recordOf(record.sourceAnchor, 'reading source anchor');
  assertKeys(anchor, ['revision', 'originalChapterTitle'], positions ? ['p', 'endP'] : [], 'reading source anchor');
  assertString(anchor.revision, 'reading source revision', 160);
  assertString(anchor.originalChapterTitle, 'reading original chapter title', 160, true);
  if (anchor.p !== undefined) assertInteger(anchor.p, 'reading source p', 1_000_000);
  if (anchor.endP !== undefined) {
    assertInteger(anchor.endP, 'reading source endP', 1_000_000);
    if (anchor.p === undefined || Number(anchor.endP) < Number(anchor.p)) throw new Error('reading source anchor range');
  }
  return { sourceAnchor: { ...anchor } as ReadingWorkspaceSourceAnchor };
}

/** Upgrade fields are retained only on the same real source, never on edited result text. */
export function retainReadingWorkspaceExtensions(
  kind: string, current: Record<string, unknown>, incoming: Record<string, unknown>,
): Record<string, unknown> {
  if ((kind === 'chapter' || kind === 'paragraph') && current.sourceRevision !== undefined
    && incoming.sourceRevision === undefined) return { ...current };
  if (['annotation', 'segment-summary', 'note'].includes(kind) && current.sourceAnchor !== undefined && incoming.sourceAnchor === undefined) {
    const identity = kind === 'annotation' ? ['annotationId', 'bookId', 'chapterIndex']
      : kind === 'note' ? ['noteId', 'bookId'] : ['bookId', 'chapterIndex', 'segmentIndex'];
    if (identity.every(key => current[key] === incoming[key])) {
      const originalFields = kind === 'annotation' ? ['chapterIndex', 'segmentIndex', 'paragraphIndex', 'createdAt', 'sourceVersion', 'resultOperationId']
        : kind === 'note' ? ['chapterIndex', 'startP', 'endP', 'createdAt'] : ['createdAt', 'sourceVersion', 'resultOperationId'];
      incoming = { ...incoming, ...readingSourceAnchor(current, kind !== 'segment-summary'),
        ...Object.fromEntries(originalFields.filter(key => current[key] !== undefined).map(key => [key, current[key]])) };
    }
  }
  if (kind === 'book') {
    const iReading = retainReadingDailyState(current.iReading, incoming.iReading);
    const programme = retainReadingProgramme(current.programme, incoming.programme);
    return { ...incoming, ...(iReading ? { iReading } : {}),
      ...(programme ? { programme, contentType: 'programme' } : {}),
      ...(programme && programme === current.programme && current.totalChapters !== undefined
        && Number(incoming.totalChapters) < Number(current.totalChapters) ? { totalChapters: current.totalChapters } : {}),
    };
  }
  if (kind === 'chapter' && Array.isArray(current.segments) && Array.isArray(incoming.segments)) {
    const sameChapter = ['bookId', 'chapterIndex', 'charCount', 'paragraphCount'].every(key => current[key] === incoming[key])
      && current.sourceRevision === incoming.sourceRevision;
    const extended = sameChapter ? retainReadingChapterContent(current, incoming) : incoming;
    return { ...extended, segments: incoming.segments.map((item: Record<string, unknown>) => {
      const old = (current.segments as Record<string, unknown>[]).find(part =>
        ['segmentIndex', 'startP', 'endP', 'charCount'].every(key => part[key] === item[key]));
      if (sameChapter && !item.contentRange && old?.contentRange) return { ...old };
      if (sameChapter && !item.programmeRange && old?.programmeRange) return { ...old };
      if (JSON.stringify(item.programmeRange) !== JSON.stringify(old?.programmeRange)) return item;
      if (JSON.stringify(item.contentRange) !== JSON.stringify(old?.contentRange)) return item;
      const request = retainReadingRequest(old?.request, item.request);
      return { ...item, ...readingResultProof(!item.sourceVersion && old?.sourceVersion ? old : item, old),
        ...(request ? { request } : {}) };
    }) };
  }
  if (kind === 'annotation' || kind === 'segment-summary') {
    incoming = { ...incoming, ...readingResultProof(incoming, current) };
    const fields = kind === 'annotation'
      ? ['annotationId', 'bookId', 'chapterIndex', 'segmentIndex', 'paragraphIndex', 'text', 'createdAt']
      : ['bookId', 'chapterIndex', 'segmentIndex', 'summary', 'createdAt'];
    if (!incoming.sourceVersion && current.sourceVersion && fields.every(key => current[key] === incoming[key])) {
      return { ...incoming, ...readingResultProof(current) };
    }
  }
  if (kind === 'paragraph' && current.orderedContent === true && incoming.orderedContent === undefined
    && ['bookId', 'chapterIndex', 'paragraphIndex', 'text'].every(key => current[key] === incoming[key])) return { ...incoming, orderedContent: true };
  return incoming;
}

/** Descriptions are observations of one image version, not chapter source changes. */
export function retainReadingChapterContent(current: Record<string, unknown>, incoming: Record<string, unknown>) {
  const contentBlocks = incoming.contentBlocks ?? current.contentBlocks;
  const images = incoming.images ?? current.images;
  const programmeCues = incoming.programmeCues ?? current.programmeCues;
  const descriptions = new Map<string, ReadingWorkspaceImageDescription>();
  for (const entry of [...(current.imageDescriptions as ReadingWorkspaceImageDescription[] ?? []),
    ...(incoming.imageDescriptions as ReadingWorkspaceImageDescription[] ?? [])]) {
    if (!(images as ReadingWorkspaceImage[] | undefined)?.some(image => image.id === entry.imageId && image.contentVersion === entry.contentVersion)) continue;
    const key = `${entry.imageId}\u0000${entry.contentVersion}`;
    const old = descriptions.get(key);
    if (!old || entry.savedAt > old.savedAt || (entry.savedAt === old.savedAt && entry.text > old.text)) descriptions.set(key, entry);
  }
  return { ...incoming,
    ...(incoming.sourceRevision !== undefined || current.sourceRevision !== undefined ? { sourceRevision: incoming.sourceRevision ?? current.sourceRevision } : {}),
    ...(contentBlocks !== undefined ? { contentBlocks } : {}),
    ...(images !== undefined ? { images } : {}),
    ...(programmeCues !== undefined ? { programmeCues } : {}),
    ...(current.imageDescriptions !== undefined || incoming.imageDescriptions !== undefined
      ? { imageDescriptions: [...descriptions.values()].sort((a, b) => a.imageId.localeCompare(b.imageId)) } : {}),
  };
}

function assertContentRange(value: unknown, label: string) {
  const range = recordOf(value, label);
  assertKeys(range, ['startBlock', 'startOffset', 'endBlock', 'endOffset'], [], label);
  for (const key of ['startBlock', 'startOffset', 'endBlock', 'endOffset']) assertInteger(range[key], `${label}.${key}`, 10_000_000);
  if (Number(range.startBlock) > Number(range.endBlock)
    || (range.startBlock === range.endBlock && Number(range.startOffset) >= Number(range.endOffset))) throw new Error(`${label} range 无效。`);
}

function assertSegment(value: unknown, label: string) {
  const segment = recordOf(value, label);
  assertKeys(
    segment,
    ['segmentIndex', 'startP', 'endP', 'charCount', 'status'],
    ['updatedAt', 'sourceVersion', 'resultOperationId', 'resultActivityId', 'memoryIngestionVersion', 'contentRange', 'programmeRange', 'request'],
    label,
  );
  assertInteger(segment.segmentIndex, `${label}.segmentIndex`, 1_000_000);
  assertInteger(segment.startP, `${label}.startP`, 1_000_000);
  assertInteger(segment.endP, `${label}.endP`, 1_000_000);
  if (Number(segment.endP) < Number(segment.startP)) {
    throw new Error(`${label}.endP 不能小于 startP。`);
  }
  assertInteger(segment.charCount, `${label}.charCount`, 10_000_000);
  assertEnum(
    segment.status,
    READING_SHARED_SEGMENT_STATUSES,
    `${label}.status`,
  );
  assertOptionalInteger(segment.updatedAt, `${label}.updatedAt`);
  readingResultProof(segment);
  if (segment.request !== undefined) {
    const request = recordOf(segment.request, 'reading request');
    assertKeys(request, ['id', 'runtimeId', 'startedAt', 'sourceVersion', 'kind', 'save'],
      ['transportStartedAt', 'resultActivityId', 'memoryIngestionVersion'], 'reading request');
    sharedReadingRequest(request);
  }
  if (segment.contentRange !== undefined) assertContentRange(segment.contentRange, `${label}.range`);
  if (segment.programmeRange !== undefined) {
    const range = recordOf(segment.programmeRange, 'reading programme range');
    assertKeys(range, ['startMs', 'endMs', 'timed'], [], 'reading programme range');
    assertInteger(range.startMs, 'reading programme range startMs');
    assertInteger(range.endMs, 'reading programme range endMs');
    if (Number(range.endMs) <= Number(range.startMs) || typeof range.timed !== 'boolean') throw new Error('reading programme range 无效。');
  }
}

function assertChapter(entityId: string, value: Record<string, unknown>) {
  assertKeys(
    value,
    [
      'bookId',
      'chapterIndex',
      'title',
      'charCount',
      'paragraphCount',
      'segments',
    ],
    ['contentBlocks', 'images', 'imageDescriptions', 'programmeCues', 'sourceRevision'],
    'reading chapter',
  );
  assertString(value.bookId, 'reading chapter bookId', 128);
  assertInteger(value.chapterIndex, 'reading chapterIndex', 100_000);
  assertIdentity(
    entityId,
    'chapter',
    value.bookId as string,
    value.chapterIndex as number,
  );
  assertString(value.title, 'reading chapter title', 160);
  assertOptionalString(value.sourceRevision, 'reading chapter sourceRevision', 160);
  assertInteger(value.charCount, 'reading chapter charCount', 10_000_000);
  assertInteger(
    value.paragraphCount,
    'reading chapter paragraphCount',
    1_000_000,
  );
  if (!Array.isArray(value.segments) || value.segments.length > 100_000) {
    throw new Error('reading chapter segments 无效。');
  }
  value.segments.forEach((segment, index) =>
    assertSegment(segment, `reading chapter segments[${index}]`));
  if (value.programmeCues !== undefined) {
    if (!Array.isArray(value.programmeCues) || value.programmeCues.length > 1_000_000) throw new Error('reading programme cues 无效。');
    let lastStart = -1;
    const paragraphs = new Set<number>();
    for (const raw of value.programmeCues) {
      const cue = recordOf(raw, 'reading programme cue');
      assertKeys(cue, ['paragraphIndex', 'startMs', 'endMs'], [], 'reading programme cue');
      for (const key of ['paragraphIndex', 'startMs', 'endMs']) assertInteger(cue[key], `reading programme cue ${key}`);
      const paragraphIndex = Number(cue.paragraphIndex), startMs = Number(cue.startMs);
      if (paragraphIndex >= Number(value.paragraphCount) || paragraphs.has(paragraphIndex) || startMs < lastStart
        || Number(cue.endMs) <= startMs) throw new Error('reading programme cue range 无效。');
      paragraphs.add(paragraphIndex); lastStart = startMs;
    }
  }
  if (value.images !== undefined) {
    if (!Array.isArray(value.images) || value.images.length > 20_000) throw new Error('reading images 无效。');
    const ids = new Set<string>();
    for (const raw of value.images) {
      const image = recordOf(raw, 'reading image');
      assertKeys(image, ['id', 'sourcePath', 'fileName', 'contentVersion', 'width', 'height'], [], 'reading image');
      for (const key of ['id', 'sourcePath']) assertString(image[key], `reading image ${key}`, 2000);
      assertString(image.fileName, 'reading image fileName', 160);
      if (/[\/\\\u0000-\u001f\u007f]/.test(image.fileName as string) || ['.', '..'].includes(image.fileName as string)) throw new Error('reading image fileName 无效。');
      assertString(image.contentVersion, 'reading image version', 160);
      for (const key of ['width', 'height']) { assertInteger(image[key], `reading image ${key}`, 1_000_000); if (!image[key]) throw new Error('reading image size 无效。'); }
      if (ids.has(image.id as string)) throw new Error('reading image id 重复。');
      ids.add(image.id as string);
    }
  }
  if (value.contentBlocks !== undefined) {
    if (!Array.isArray(value.contentBlocks) || value.contentBlocks.length > 1_000_000) throw new Error('reading contentBlocks 无效。');
    for (const raw of value.contentBlocks) {
      const block = recordOf(raw, 'reading content block');
      if (block.kind === 'text') {
        assertKeys(block, ['kind', 'paragraphIndex', 'startOffset', 'endOffset'], [], 'reading text block');
        for (const key of ['paragraphIndex', 'startOffset', 'endOffset']) assertInteger(block[key], `reading block ${key}`, 10_000_000);
        if (Number(block.paragraphIndex) >= Number(value.paragraphCount) || Number(block.startOffset) >= Number(block.endOffset)) throw new Error('reading text block range 无效。');
      } else if (block.kind === 'image') {
        assertKeys(block, ['kind', 'imageId'], [], 'reading image block');
        if (!(value.images as ReadingWorkspaceImage[] | undefined)?.some(image => image.id === block.imageId)) throw new Error('reading image block reference 无效。');
      } else throw new Error('reading content block kind 无效。');
    }
  }
  for (const segment of value.segments as ReadingWorkspaceSegmentRecord[]) if (segment.contentRange) {
    const blocks = value.contentBlocks as ReadingWorkspaceContentBlock[] | undefined;
    const range = segment.contentRange;
    if (!blocks || range.endBlock >= blocks.length) throw new Error('reading content range 无效。');
    for (const [index, offset] of [[range.startBlock, range.startOffset], [range.endBlock, range.endOffset]]) {
      const block = blocks[index];
      if (!block || offset > (block.kind === 'image' ? 1 : block.endOffset - block.startOffset)) throw new Error('reading content range offset 无效。');
    }
  }
  if (value.imageDescriptions !== undefined) {
    if (!Array.isArray(value.imageDescriptions) || value.imageDescriptions.length > 20_000) throw new Error('reading image descriptions 无效。');
    const ids = new Set<string>();
    for (const raw of value.imageDescriptions) {
      const description = recordOf(raw, 'reading image description');
      assertKeys(description, ['imageId', 'contentVersion', 'text', 'savedAt'], [], 'reading image description');
      assertString(description.text, 'reading image description text', 100_000);
      assertInteger(description.savedAt, 'reading image description savedAt');
      if (!(value.images as ReadingWorkspaceImage[] | undefined)?.some(image => image.id === description.imageId && image.contentVersion === description.contentVersion)) throw new Error('reading image description version 无效。');
      if (ids.has(description.imageId as string)) throw new Error('reading image description 重复。');
      ids.add(description.imageId as string);
    }
  }
}

function assertParagraph(
  entityId: string,
  value: Record<string, unknown>,
) {
  assertKeys(
    value,
    ['bookId', 'chapterIndex', 'paragraphIndex', 'text'],
    ['orderedContent', 'sourceRevision'],
    'reading paragraph',
  );
  assertString(value.bookId, 'reading paragraph bookId', 128);
  assertInteger(value.chapterIndex, 'reading paragraph chapterIndex', 100_000);
  assertInteger(value.paragraphIndex, 'reading paragraph index', 1_000_000);
  if (value.orderedContent !== undefined && value.orderedContent !== true) throw new Error('reading paragraph orderedContent 无效。');
  assertOptionalString(value.sourceRevision, 'reading paragraph sourceRevision', 160);
  assertString(value.text, 'reading paragraph text', value.orderedContent === true ? 2_000_000 : 4000);
  assertIdentity(
    entityId,
    'paragraph',
    value.bookId as string,
    value.chapterIndex as number,
    value.paragraphIndex as number,
  );
}

function assertSession(entityId: string, value: Record<string, unknown>) {
  assertKeys(
    value,
    [
      'sessionId',
      'bookId',
      'startedAt',
      'startChapterIndex',
      'startParagraphIndex',
    ],
    [
      'endedAt',
      'endChapterIndex',
      'endParagraphIndex',
      'activeSeconds',
    ],
    'reading session',
  );
  assertString(value.sessionId, 'reading sessionId', 180);
  assertString(value.bookId, 'reading session bookId', 128);
  assertIdentity(
    entityId,
    'session',
    value.bookId as string,
    value.sessionId as string,
  );
  assertInteger(value.startedAt, 'reading session startedAt');
  assertOptionalInteger(value.endedAt, 'reading session endedAt');
  assertInteger(
    value.startChapterIndex,
    'reading session startChapterIndex',
    100_000,
  );
  assertInteger(
    value.startParagraphIndex,
    'reading session startParagraphIndex',
    1_000_000,
  );
  assertOptionalInteger(
    value.endChapterIndex,
    'reading session endChapterIndex',
    100_000,
  );
  assertOptionalInteger(
    value.endParagraphIndex,
    'reading session endParagraphIndex',
    1_000_000,
  );
  assertOptionalInteger(
    value.activeSeconds,
    'reading session activeSeconds',
    10_000_000_000,
  );
  const hasEndChapter = value.endChapterIndex !== undefined;
  const hasEndParagraph = value.endParagraphIndex !== undefined;
  if (hasEndChapter !== hasEndParagraph) {
    throw new Error('reading session 结束位置必须成对出现。');
  }
}

function assertAnnotation(
  entityId: string,
  value: Record<string, unknown>,
) {
  assertKeys(
    value,
    [
      'annotationId',
      'bookId',
      'chapterIndex',
      'segmentIndex',
      'paragraphIndex',
      'type',
      'text',
      'createdAt',
    ],
    ['updatedAt', 'sourceVersion', 'resultOperationId', 'resultActivityId', 'memoryIngestionVersion', 'sourceAnchor'],
    'reading annotation',
  );
  assertString(value.annotationId, 'reading annotationId', 180);
  assertString(value.bookId, 'reading annotation bookId', 128);
  assertIdentity(
    entityId,
    'annotation',
    value.bookId as string,
    value.chapterIndex as number,
    value.annotationId as string,
  );
  assertInteger(value.chapterIndex, 'reading annotation chapterIndex', 100_000);
  assertInteger(value.segmentIndex, 'reading annotation segmentIndex', 1_000_000);
  assertInteger(value.paragraphIndex, 'reading annotation paragraphIndex', 1_000_000);
  assertString(value.type, 'reading annotation type', 24);
  assertString(value.text, 'reading annotation text', 900);
  assertInteger(value.createdAt, 'reading annotation createdAt');
  assertOptionalInteger(value.updatedAt, 'reading annotation updatedAt');
  readingSourceAnchor(value);
  readingResultProof(value);
}

function assertSummary(entityId: string, value: Record<string, unknown>) {
  assertKeys(
    value,
    ['bookId', 'chapterIndex', 'segmentIndex', 'summary', 'createdAt'],
    ['updatedAt', 'sourceVersion', 'resultOperationId', 'resultActivityId', 'memoryIngestionVersion', 'sourceAnchor'],
    'reading segment summary',
  );
  assertString(value.bookId, 'reading summary bookId', 128);
  assertInteger(value.chapterIndex, 'reading summary chapterIndex', 100_000);
  assertInteger(value.segmentIndex, 'reading summary segmentIndex', 1_000_000);
  assertIdentity(
    entityId,
    'segment-summary',
    value.bookId as string,
    value.chapterIndex as number,
    value.segmentIndex as number,
  );
  assertString(value.summary, 'reading summary', 900);
  assertInteger(value.createdAt, 'reading summary createdAt');
  assertOptionalInteger(value.updatedAt, 'reading summary updatedAt');
  readingSourceAnchor(value, false);
  readingResultProof(value);
}

function assertNote(entityId: string, value: Record<string, unknown>) {
  assertKeys(
    value,
    [
      'noteId',
      'bookId',
      'chapterIndex',
      'startP',
      'endP',
      'selectedText',
      'kind',
      'createdAt',
    ],
    ['note', 'question', 'answer', 'sourceAnchor'],
    'reading note',
  );
  assertString(value.noteId, 'reading noteId', 180);
  assertString(value.bookId, 'reading note bookId', 128);
  assertIdentity(
    entityId,
    'note',
    value.bookId as string,
    value.noteId as string,
  );
  assertInteger(value.chapterIndex, 'reading note chapterIndex', 100_000);
  assertInteger(value.startP, 'reading note startP', 1_000_000);
  assertInteger(value.endP, 'reading note endP', 1_000_000);
  if (Number(value.endP) < Number(value.startP)) {
    throw new Error('reading note endP 不能小于 startP。');
  }
  assertString(value.selectedText, 'reading selectedText', 1200);
  assertEnum(value.kind, READING_NOTE_KINDS, 'reading note kind');
  assertOptionalString(value.note, 'reading note text', 1200);
  assertOptionalString(value.question, 'reading question', 400);
  assertOptionalString(value.answer, 'reading answer', 1600);
  assertInteger(value.createdAt, 'reading note createdAt');
  readingSourceAnchor(value);
}

function assertResultAction(
  entityId: string,
  value: Record<string, unknown>,
) {
  assertKeys(
    value,
    ['bookId', 'resultId', 'updatedAt'],
    [
      'notebookEntryId',
      'notebookSavedAt',
      'memoryId',
      'memorySavedAt',
    ],
    'reading result action',
  );
  assertString(value.bookId, 'reading result action bookId', 128);
  assertString(value.resultId, 'reading resultId', 180);
  assertIdentity(
    entityId,
    'result-action',
    value.bookId as string,
    value.resultId as string,
  );
  assertOptionalString(
    value.notebookEntryId,
    'reading notebookEntryId',
    160,
  );
  assertOptionalInteger(
    value.notebookSavedAt,
    'reading notebookSavedAt',
  );
  assertOptionalString(value.memoryId, 'reading memoryId', 160);
  assertOptionalInteger(value.memorySavedAt, 'reading memorySavedAt');
  assertInteger(value.updatedAt, 'reading result action updatedAt');
}

function assertWebClip(entityId: string, value: Record<string, unknown>) {
  assertKeys(
    value,
    ['clipId', 'url', 'title', 'capturedAt'],
    ['excerpt'],
    'reading web clip',
  );
  assertString(value.clipId, 'reading clipId', 180);
  assertIdentity(entityId, 'web-clip', value.clipId as string);
  assertString(value.url, 'reading clip url', 4096);
  assertString(value.title, 'reading clip title', 240);
  assertOptionalString(value.excerpt, 'reading clip excerpt', 8000);
  assertInteger(value.capturedAt, 'reading clip capturedAt');
}

const KIND_ENTITY: Readonly<
  Record<ReadingWorkspaceRecordKind, ReadingWorkspaceEntityType>
> = {
  book: 'book',
  chapter: 'chapter',
  paragraph: 'paragraph',
  session: 'session',
  annotation: 'annotation',
  'segment-summary': 'result',
  note: 'result',
  'result-action': 'result',
  'web-clip': 'web-clip',
};

export function assertReadingWorkspaceRecord(
  kind: ReadingWorkspaceRecordKind,
  entityId: string,
  value: unknown,
) {
  const record = recordOf(value, `reading.workspace ${kind}`);
  assertJsonValue(record);
  switch (kind) {
    case 'book':
      return assertBook(entityId, record);
    case 'chapter':
      return assertChapter(entityId, record);
    case 'paragraph':
      return assertParagraph(entityId, record);
    case 'session':
      return assertSession(entityId, record);
    case 'annotation':
      return assertAnnotation(entityId, record);
    case 'segment-summary':
      return assertSummary(entityId, record);
    case 'note':
      return assertNote(entityId, record);
    case 'result-action':
      return assertResultAction(entityId, record);
    case 'web-clip':
      return assertWebClip(entityId, record);
  }
}

export function assertReadingWorkspaceMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  const entityTypes = new Set(Object.values(KIND_ENTITY));
  if (
    value.entity.domain !== 'reading'
    || !entityTypes.has(value.entity.type as ReadingWorkspaceEntityType)
  ) {
    throw new Error('reading.workspace mutation entity 无效。');
  }
  if (
    value.revision.schemaVersion !== READING_WORKSPACE_SCHEMA_VERSION
    || value.sensitivity !== 'high'
    || value.retentionClass !== READING_WORKSPACE_RETENTION_CLASS
  ) {
    throw new Error('reading.workspace mutation 元数据无效。');
  }
  if (value.objectRefs.length) {
    throw new Error('reading.workspace 不接受文件对象；应交给 reading.objects。');
  }
  const payload = recordOf(value.payload, 'reading.workspace payload');
  if (value.revision.operation === 'delete') {
    assertKeys(
      payload,
      ['schemaVersion', 'deletedAt'],
      [],
      'reading.workspace delete',
    );
    if (payload.schemaVersion !== READING_WORKSPACE_SCHEMA_VERSION) {
      throw new Error('reading.workspace delete schemaVersion 无效。');
    }
    assertInteger(payload.deletedAt, 'reading.workspace deletedAt');
    return;
  }
  if (
    value.revision.operation !== 'upsert'
    && value.revision.operation !== 'restore'
  ) {
    throw new Error('reading.workspace 只允许 upsert、restore 或 delete。');
  }
  assertKeys(
    payload,
    ['schemaVersion', 'kind', 'value'],
    [],
    'reading.workspace record payload',
  );
  if (payload.schemaVersion !== READING_WORKSPACE_SCHEMA_VERSION) {
    throw new Error('reading.workspace record schemaVersion 无效。');
  }
  const kind = payload.kind as ReadingWorkspaceRecordKind;
  if (!(kind in KIND_ENTITY)) {
    throw new Error('reading.workspace record kind 无效。');
  }
  if (KIND_ENTITY[kind] !== value.entity.type) {
    throw new Error('reading.workspace kind 与 entity type 不匹配。');
  }
  assertReadingWorkspaceRecord(kind, value.entity.id, payload.value);
}

export function buildReadingWorkspaceRecordMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: ReadingWorkspaceEntityType;
  entityId: string;
  kind: ReadingWorkspaceRecordKind;
  value: JsonValue;
  operation?: 'upsert' | 'restore';
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'reading',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: input.operation ?? 'upsert',
      schemaVersion: READING_WORKSPACE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: READING_WORKSPACE_SCHEMA_VERSION,
      kind: input.kind,
      value: input.value,
    },
    objectRefs: [],
    retentionClass: READING_WORKSPACE_RETENTION_CLASS,
  };
  assertReadingWorkspaceMutationV1(mutation);
  return mutation;
}

export function buildReadingWorkspaceDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: ReadingWorkspaceEntityType;
  entityId: string;
  deletedAt: number;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'reading',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'delete',
      schemaVersion: READING_WORKSPACE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: READING_WORKSPACE_SCHEMA_VERSION,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: READING_WORKSPACE_RETENTION_CLASS,
  };
  assertReadingWorkspaceMutationV1(mutation);
  return mutation;
}
