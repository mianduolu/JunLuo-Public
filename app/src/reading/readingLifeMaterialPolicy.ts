import type { ReadingBook, ReadingSession } from './readingTypes';

const DAY_MS = 24 * 60 * 60 * 1000;
const PROGRESS_RETENTION_DAYS = 5;
const RESULT_RETENTION_DAYS = 2;

export type CoReadingResultKind = 'summary' | 'annotation' | 'my-note' | 'question';

export type CoReadingResultCandidate = {
  id: string;
  bookId: string;
  chapterIndex: number;
  kind: CoReadingResultKind;
  occurredAt: number;
  segmentIndex?: number;
  paragraphIndex?: number;
  text?: string;
  question?: string;
  answer?: string;
};

export type CoReadingProgressMaterial = {
  bookId: string;
  title: string;
  chapterIndex: number;
  totalChapters: number;
  paragraphIndex: number;
  todayActiveSeconds: number;
  lastActivityAt: number;
  dayAge: number;
  importance: 'high' | 'medium';
  sharedRecently: boolean;
  expiresAt: number;
  fingerprintKey: string;
};

export type CoReadingResultMaterial = {
  id: string;
  bookId: string;
  title: string;
  chapterIndex: number;
  kind: CoReadingResultKind;
  occurredAt: number;
  dayAge: number;
  text?: string;
  question?: string;
  answer?: string;
  expiresAt: number;
  fingerprintKey: string;
};

export type ReadingLifeMaterialSnapshot = {
  progress?: CoReadingProgressMaterial;
  result?: CoReadingResultMaterial;
};

function compactText(value: unknown, limit = 160) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function localDaySerial(timestamp: number) {
  const date = new Date(timestamp);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

export function getLocalReadingDayAge(occurredAt: number, now: number) {
  return Math.max(0, localDaySerial(now) - localDaySerial(occurredAt));
}

function getLocalExpiryAt(occurredAt: number, retentionDays: number) {
  const expiry = new Date(occurredAt);
  expiry.setHours(0, 0, 0, 0);
  expiry.setDate(expiry.getDate() + retentionDays);
  return expiry.getTime();
}

function sessionActivityAt(session: ReadingSession) {
  const startedAt = Number.isFinite(session.startedAt) ? session.startedAt : 0;
  const endedAt = typeof session.endedAt === 'number' && Number.isFinite(session.endedAt)
    ? session.endedAt
    : startedAt;
  return Math.max(startedAt, endedAt);
}

function normalizeResultCandidate(
  candidate: CoReadingResultCandidate,
  booksById: Map<string, ReadingBook>,
): CoReadingResultCandidate | null {
  if (!booksById.has(candidate.bookId) || !candidate.id || !Number.isFinite(candidate.occurredAt)) return null;
  const base = {
    ...candidate,
    chapterIndex: Math.max(0, Math.round(candidate.chapterIndex)),
  };
  if (candidate.kind === 'question') {
    const question = compactText(candidate.question, 160);
    const answer = compactText(candidate.answer, 220);
    return question && answer ? { ...base, question, answer, text: undefined } : null;
  }
  const text = compactText(candidate.text, 220);
  return text ? { ...base, text, question: undefined, answer: undefined } : null;
}

function isBaiyunParticipation(candidate: CoReadingResultCandidate) {
  return candidate.kind === 'summary' || candidate.kind === 'annotation' || candidate.kind === 'question';
}

export function buildReadingLifeMaterialSnapshot(input: {
  books: ReadingBook[];
  sessions: ReadingSession[];
  results: CoReadingResultCandidate[];
  now?: number;
}): ReadingLifeMaterialSnapshot {
  const now = input.now ?? Date.now();
  const booksById = new Map(input.books.map((book) => [book.id, book]));
  const results = input.results
    .map((candidate) => normalizeResultCandidate(candidate, booksById))
    .filter((candidate): candidate is CoReadingResultCandidate => !!candidate);
  const recentResults = results.filter((candidate) => getLocalReadingDayAge(candidate.occurredAt, now) < RESULT_RETENTION_DAYS);

  const latestSession = input.sessions
    .filter((session) => booksById.has(session.bookId) && Number.isFinite(session.startedAt) && session.startedAt > 0)
    .slice()
    .sort((left, right) => sessionActivityAt(right) - sessionActivityAt(left))[0];

  let progress: CoReadingProgressMaterial | undefined;
  if (latestSession) {
    const book = booksById.get(latestSession.bookId);
    const lastActivityAt = sessionActivityAt(latestSession);
    const dayAge = getLocalReadingDayAge(lastActivityAt, now);
    if (book && dayAge < PROGRESS_RETENTION_DAYS) {
      const todayActiveSeconds = input.sessions
        .filter((session) =>
          session.bookId === book.id &&
          Number.isFinite(session.startedAt) &&
          getLocalReadingDayAge(sessionActivityAt(session), now) === 0)
        .reduce((total, session) => total + (
          typeof session.activeSeconds === 'number' && Number.isFinite(session.activeSeconds)
            ? Math.max(0, Math.round(session.activeSeconds))
            : 0
        ), 0);
      const chapterIndex = Math.min(
        Math.max(0, Math.round(book.currentChapter)),
        Math.max(0, Math.round(book.totalChapters) - 1),
      );
      const sharedRecently = recentResults.some((candidate) =>
        candidate.bookId === book.id && isBaiyunParticipation(candidate));
      progress = {
        bookId: book.id,
        title: book.title,
        chapterIndex,
        totalChapters: Math.max(1, Math.round(book.totalChapters)),
        paragraphIndex: Math.max(0, Math.round(book.currentParagraph)),
        todayActiveSeconds,
        lastActivityAt,
        dayAge,
        importance: dayAge === 0 ? 'high' : 'medium',
        sharedRecently,
        expiresAt: getLocalExpiryAt(lastActivityAt, PROGRESS_RETENTION_DAYS),
        fingerprintKey: [
          book.id,
          `chapter:${chapterIndex}`,
          `minutes:${Math.floor(todayActiveSeconds / 600)}`,
          dayAge === 0 ? 'today' : 'recent',
          sharedRecently ? 'shared' : 'solo',
        ].join('|'),
      };
    }
  }

  let latestResult = recentResults
    .slice()
    .sort((left, right) => right.occurredAt - left.occurredAt || left.id.localeCompare(right.id))[0];
  if (latestResult?.segmentIndex !== undefined
    && (latestResult.kind === 'summary' || latestResult.kind === 'annotation')) {
    // 同次保存已有相同时间与分段编号，不另造批次记录。
    const batch = recentResults.filter((candidate) =>
      candidate.bookId === latestResult.bookId
      && candidate.chapterIndex === latestResult.chapterIndex
      && candidate.segmentIndex === latestResult.segmentIndex
      && candidate.occurredAt === latestResult.occurredAt
      && (candidate.kind === 'summary' || candidate.kind === 'annotation'));
    latestResult = batch.find((candidate) => candidate.kind === 'summary')
      ?? batch.reduce((last, candidate) =>
        (candidate.paragraphIndex ?? -1) >= (last.paragraphIndex ?? -1) ? candidate : last);
  }
  let result: CoReadingResultMaterial | undefined;
  if (latestResult) {
    const book = booksById.get(latestResult.bookId);
    if (book) {
      const dayAge = getLocalReadingDayAge(latestResult.occurredAt, now);
      result = {
        ...latestResult,
        title: book.title,
        dayAge,
        expiresAt: getLocalExpiryAt(latestResult.occurredAt, RESULT_RETENTION_DAYS),
        fingerprintKey: [
          latestResult.bookId,
          latestResult.id,
          latestResult.kind,
          latestResult.occurredAt,
          latestResult.text ?? '',
          latestResult.question ?? '',
          latestResult.answer ?? '',
        ].join('|'),
      };
    }
  }

  return { progress, result };
}

function formatTodayReadingTime(seconds: number) {
  if (seconds <= 0) return '';
  return `；you 今天有效阅读约 ${Math.max(1, Math.round(seconds / 60))} 分钟`;
}

export function formatCoReadingProgressPrompt(progress: CoReadingProgressMaterial) {
  const chapter = progress.chapterIndex + 1;
  const timeText = progress.dayAge === 0 ? formatTodayReadingTime(progress.todayActiveSeconds) : '';
  if (progress.sharedRecently) {
    return `共读：I 最近和 you 一起读《${progress.title}》，当前进度为第 ${chapter} / ${progress.totalChapters} 章，读到 P${progress.paragraphIndex}${timeText}。`;
  }
  if (progress.dayAge === 0) {
    return `共读：you 今天在共读里读《${progress.title}》，当前进度为第 ${chapter} / ${progress.totalChapters} 章，读到 P${progress.paragraphIndex}${timeText}。`;
  }
  return `共读：you 最近在共读里读《${progress.title}》，上次进度为第 ${chapter} / ${progress.totalChapters} 章，读到 P${progress.paragraphIndex}。`;
}

export function formatCoReadingResultPrompt(result: CoReadingResultMaterial) {
  if (result.kind === 'summary') {
    return `共读成果：I 和 you 共读《${result.title}》时，I 留下了读后感：${result.text}。`;
  }
  if (result.kind === 'annotation') {
    return `共读成果：I 和 you 共读《${result.title}》时，I 留下了一条批注：${result.text}。`;
  }
  if (result.kind === 'my-note') {
    return `共读成果：you 读《${result.title}》时写下笔记：${result.text}。`;
  }
  return `共读成果：you 在读《${result.title}》时问 I：${result.question}；I 回答：${result.answer}。`;
}
