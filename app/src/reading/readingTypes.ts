export type ReadingFileType = 'epub' | 'txt' | 'pdf' | 'url';

export type ReadingSegmentStatus = 'pending' | 'annotating' | 'done' | 'failed' | 'stale';

export const READING_STORAGE_VERSION = 2;

// Text stays in paragraphs; blocks preserve order without a second source copy.
export type ReadingContentBlock =
  | { kind: 'text'; paragraphIndex: number; startOffset: number; endOffset: number }
  | { kind: 'image'; imageId: string };
export type ReadingImage = {
  id: string; uri: string; sourcePath: string; contentVersion: string; width: number; height: number;
};
export type ReadingContentRange = {
  startBlock: number; startOffset: number; endBlock: number; endOffset: number;
};
export type ReadingImageDescription = {
  imageId: string; contentVersion: string; text: string; savedAt: number;
};
export type ReadingProgramme = {
  episodes?: Array<{ title: string; sourceUrl: string; sourceName: string; language: string; durationMs: number }>;
  sourceUrl: string; series: string; sourceName: string; language: string;
  durationMs?: number;
  preparation: 'missing' | 'preparing' | 'ready' | 'failed';
  updatedAt: number; attemptedAt?: number; preparedAt?: number; errorCode?: string;
  transcriptUrl?: string; format?: 'srt' | 'vtt' | 'html'; sourceVersion?: string;
};
export type ReadingProgrammeCue = { paragraphIndex: number; startMs: number; endMs: number };

export type DailyReadingActivity = {
  memoryIngestionVersion?: 1;
  deferredOpportunity?: { at: number; retryAt: number };
  schedule?: { itemId: string; sourceUpdatedAt: number; windowEndAt: number; plannedMs: number; habitId?: string;
    planRevision?: number; occurrenceId?: string; completionId?: string; totalPlannedMs?: number;
    baseElapsedMs?: number; baseCompletedUnitCount?: number;
    choiceSourceId?: string; choiceVersion?: number; previousActivityId?: string };
  elapsedMs?: number;
  completedUnitCount?: number;
  endedAt?: number;
  id: string;
  status: 'preparing' | 'reading' | 'paused' | 'ended';
  plannedMs: number | null;
  remainingMs: number | null;
  startedAt: number;
  checkpointAt: number;
  updatedAt: number;
  operationId: string;
  focusId?: string;
  focusWorkMs?: number;
  jointOnly?: boolean;
  endReason?: 'duration' | 'focus' | 'manual' | 'complete';
};

export type DailyReadingProgress = {
  version: 1;
  confirmedAt: number;
  start: { chapterIndex: number; segmentIndex: number };
  cursor: { chapterIndex: number; segmentIndex: number };
  remainderMs: number;
  opportunityAt?: number;
  requestReservation?: { id: string; opportunityAt: number; activityId?: string };
  reachedEnd?: boolean;
  completedAll?: boolean;
  needsSourceConfirmation?: boolean;
  activity?: DailyReadingActivity;
  updatedAt: number;
  events: Array<{ id: string; at: number; change: '开始' | '继续' | '暂停' | '本次活动结束' | '已完成全书阅读' | '已读完本期文字稿。' }>;
};

export type ReadingSegmentRequest = {
  memoryIngestionVersion?: 1;
  save?: { attempts: number; phase: 'result' | 'annotations' | 'done';
    outcome: 'pending' | 'unknown' | 'exhausted' | 'complete'; resultRetained: boolean };
  resultActivityId?: string | null;
  id: string;
  runtimeId: string;
  startedAt: number;
  sourceVersion: string;
  kind: 'manual' | 'daily';
  transportStartedAt?: number;
  result?: { annotations: Array<{ p: number; text: string }>; summary: string; savedAt: number };
};

export type ReadingBook = {
  /** Device-local source generation for read-only material cursors, not reading progress. */
  materialSourceRevision?: string;
  id: string;
  title: string;
  author: string;
  language?: string;
  contentType?: 'programme';
  programme?: ReadingProgramme;
  fileType: ReadingFileType;
  fileUri?: string;
  coverUri?: string;
  totalChapters: number;
  currentChapter: number;
  currentParagraph: number;
  progressFraction: number;
  importedAt: number;
  lastOpenedAt?: number;
  iReading?: DailyReadingProgress;
};

/** Original record IDs/positions remain unchanged. No p means historical-only. */
export type ReadingSourceAnchor = { revision: string; originalChapterTitle: string; p?: number; endP?: number };

export type ReadingChapter = {
  sourceRevision?: string;
  bookId: string;
  index: number;
  title: string;
  htmlContent?: string;
  textContent: string;
  paragraphs: string[];
  charCount: number;
  segmentsMeta: ReadingSegmentMeta[];
  contentBlocks?: ReadingContentBlock[];
  images?: ReadingImage[];
  imageDescriptions?: ReadingImageDescription[];
  programmeCues?: ReadingProgrammeCue[];
};

export type ReadingParagraph = {
  index: number;
  text: string;
  charCount: number;
};

export type ReadingSegmentMeta = {
  memoryIngestionVersion?: 1;
  resultActivityId?: string | null;
  segmentIndex: number;
  startP: number;
  endP: number;
  charCount: number;
  status: ReadingSegmentStatus;
  errorMessage?: string;
  updatedAt?: number;
  sourceVersion?: string;
  resultOperationId?: string;
  request?: ReadingSegmentRequest;
  contentRange?: ReadingContentRange;
  programmeRange?: { startMs: number; endMs: number; timed: boolean };
};

export type ReadingAnnotation = {
  memoryIngestionVersion?: 1;
  resultActivityId?: string | null;
  sourceAnchor?: ReadingSourceAnchor;
  id: string;
  bookId: string;
  chapterIndex: number;
  segmentIndex: number;
  p: number;
  type: string;
  text: string;
  createdAt: number;
  updatedAt?: number;
  sourceVersion?: string;
  resultOperationId?: string;
};

export type ReadingSegmentSummary = {
  memoryIngestionVersion?: 1;
  resultActivityId?: string | null;
  sourceAnchor?: ReadingSourceAnchor;
  bookId: string;
  chapterIndex: number;
  segmentIndex: number;
  summary: string;
  createdAt: number;
  updatedAt?: number;
  sourceVersion?: string;
  resultOperationId?: string;
};

export type ReadingResultActionMeta = {
  resultId: string;
  notebookEntryId?: string;
  notebookSavedAt?: number;
  memoryId?: string;
  memorySavedAt?: number;
  updatedAt: number;
};

export type ReadingNote = {
  sourceAnchor?: ReadingSourceAnchor;
  id: string;
  bookId: string;
  chapterIndex: number;
  startP: number;
  endP: number;
  selectedText: string;
  kind: 'my-note' | 'question';
  note?: string;
  question?: string;
  answer?: string;
  createdAt: number;
};

export type ReadingPosition = {
  chapterIndex: number;
  paragraphIndex: number;
};

export type ReadingProgress = ReadingPosition & {
  progressFraction: number;
  updatedAt: number;
};

export type ReadingSession = {
  id: string;
  bookId: string;
  startedAt: number;
  endedAt?: number;
  startPosition: ReadingPosition;
  endPosition?: ReadingPosition;
  activeSeconds?: number;
};

export type ReadingChapterAnnotations = {
  annotations: ReadingAnnotation[];
  summaries: ReadingSegmentSummary[];
};

export type ReadingLibrarySnapshot = {
  version: typeof READING_STORAGE_VERSION;
  books: ReadingBook[];
  updatedAt: number;
};

export type ReadingBookFileStatusKind = 'ok' | 'missing-source' | 'missing-cover' | 'missing-all';

export type ReadingBookFileStatus = {
  bookId: string;
  status: ReadingBookFileStatusKind;
  sourceExists: boolean;
  coverExists: boolean;
  sourceUri?: string;
  coverUri?: string;
};

export type ReadingStorageBookKeyIndex = {
  bookId: string;
  chapterKeys: string[];
  annotationKeys: string[];
  chapterIndexes: number[];
  annotationChapterIndexes: number[];
  notesKey?: string;
};

export type ReadingStorageDiagnostics = {
  version: number | 'legacy-array' | 'missing' | 'invalid';
  bookCount: number;
  chapterKeyCount: number;
  annotationKeyCount: number;
  noteKeyCount: number;
  sessionCount: number;
  orphanKeys: string[];
  missingChapterBookIds: string[];
  missingSourceBookIds: string[];
  missingCoverBookIds: string[];
  repairedBookIds: string[];
};
