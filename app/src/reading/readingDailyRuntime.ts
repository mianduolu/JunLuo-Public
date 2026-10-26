import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { runScheduledAiCall } from '../ai/aiRuntimeScheduler';
import { requestDailyReadingAnnotation, type ReadingAiRuntime, type ReadingTransport } from './readingAi';
import { createReadingProgress, formatReadingPosition, formatReadingTime, READING_INTERVAL_MS, readingSegmentSourceVersion, settleReadingClock, type ReadingFocusClock } from './readingDailyPolicy';
import { loadReadingAnnotations, loadReadingChapter, loadReadingLibraryStrict, runReadingStoreExclusive, saveReadingLibrary } from './readingStore';
import { pendingReadingSettlement, resumeReadingSettlement, retryReadingSave, runReadingSegment } from './readingSegmentRuntime';
import type { DailyReadingActivity, DailyReadingProgress, ReadingBook } from './readingTypes';
import { prepareReadingRequestSource } from './readingIllustratedRequest';
import { buildProgrammeCollectionMaterial } from './readingProgrammePolicy';

export type CurrentReadingActivity = DailyReadingActivity & { activityId: string; bookId: string; title: string; contentType?: 'programme' };
export type ReadingControlResult = { ok: boolean; activity?: CurrentReadingActivity; reason?: string };
const snapshot = (book: ReadingBook): CurrentReadingActivity | null => book.iReading?.activity
  ? { ...book.iReading.activity, activityId: book.iReading.activity.id, bookId: book.id, title: book.title, contentType: book.contentType } : null;
const currentBook = (books: ReadingBook[]) => books.filter(b => b.iReading?.activity && b.iReading.activity.status !== 'ended')
  .sort((a, b) => b.iReading!.activity!.updatedAt - a.iReading!.activity!.updatedAt)[0];

async function scheduledClock(state: DailyReadingProgress, now: number, focus?: ReadingFocusClock) {
  const activity = state.activity;
  if (!activity?.schedule || activity.status === 'ended') return { now, focus };
  const boundary = await (await import('../schedule/ownScheduleExecution')).readOwnScheduledReadingBoundary(activity.schedule, activity.id);
  if (boundary === null || boundary >= now) return { now, focus };
  if (activity.focusId) {
    const session = await (await import('../focus/focusStore')).loadActiveFocusSession(true);
    const { makeFocusSessionId } = await import('../focus/focusIdentity');
    if (session && makeFocusSessionId(session) === activity.focusId) {
      const clock = (await import('../focus/focusReadingPolicy')).projectFocusReadingClock(session, boundary);
      focus = { sessionId: activity.focusId, effectiveWorkMs: clock.effectiveWorkMs,
        paused: session.paused || clock.inBreak, ended: clock.completed };
    } else focus = undefined;
  }
  return { now: Math.max(activity.checkpointAt, boundary), focus };
}

async function canRequestForActivity(activity?: DailyReadingActivity) {
  return !activity?.schedule || (await import('../schedule/ownScheduleExecution'))
    .isOwnScheduledReadingRequestAllowed(activity.schedule, activity.id);
}

async function writeBook(books: ReadingBook[], book: ReadingBook) {
  const activity = book.iReading?.activity;
  if (activity?.deferredOpportunity && (activity.status === 'ended'
    || activity.deferredOpportunity.at !== book.iReading?.opportunityAt)) {
    const { deferredOpportunity: _deferred, ...nextActivity } = activity;
    book = { ...book, iReading: { ...book.iReading!, activity: nextActivity } };
  }
  const previous = books.find(item => item.id === book.id)?.iReading;
  const oldBook = books.find(item => item.id === book.id);
  if (oldBook?.iReading?.activity?.status === 'ended' && oldBook.iReading.activity.memoryIngestionVersion === 1
    && oldBook.iReading.activity.id !== book.iReading?.activity?.id) {
    await (await import('./readingMemoryIngestion')).registerReadingMemoryActivity(oldBook);
  }
  if (book.iReading) book.iReading.updatedAt = Math.max(book.iReading.updatedAt, (previous?.updatedAt ?? -1) + 1);
  await retryReadingSave(() => saveReadingLibrary(books.map(b => b.id === book.id ? book : b)));
  await registerReadingMemoryActivityAfterSave(book);
}

async function registerReadingMemoryActivityAfterSave(book: ReadingBook) {
  if (book.iReading?.activity?.memoryIngestionVersion !== 1) return;
  try { await (await import('./readingMemoryIngestion')).registerReadingMemoryActivity(book); }
  catch { console.warn('[reading-memory] activity-registration-failed'); }
}

async function mutate<T>(fn: (books: ReadingBook[]) => Promise<T>, epoch = captureBackupRestoreDataEpoch()): Promise<T> {
  const result = await runReadingStoreExclusive(() => runBackupRestoreDataEpochCommit(epoch, async () => fn(await loadReadingLibraryStrict())));
  if (!result.committed) throw new Error('reading-restore');
  return result.value;
}

export async function loadCurrentReadingActivity(now = Date.now()): Promise<CurrentReadingActivity | null> {
  const book = currentBook(await loadReadingLibraryStrict());
  if (!book) return null;
  const clock = await scheduledClock(book.iReading!, now);
  return snapshot({ ...book, iReading: settleReadingClock(book.iReading!, clock.now, clock.focus).state });
}

export async function confirmReadingStart(bookId: string, position: { chapterIndex: number; segmentIndex: number }, now = Date.now()) {
  const current = (await loadReadingLibraryStrict()).find(book => book.id === bookId);
  if (current?.fileType === 'epub' && (!current.iReading || current.iReading.needsSourceConfirmation)) {
    const result = await (await import('./readingEpubUpgradeRuntime')).confirmLegacyEpubReadingSource(bookId, position, { now });
    return result.status === 'ready';
  }
  return mutate(async books => {
    const book = books.find(b => b.id === bookId);
    if (!book) return false;
    if (book.iReading) return true;
    const chapter = await loadReadingChapter(bookId, position.chapterIndex);
    if (!chapter?.segmentsMeta.some(s => s.segmentIndex === position.segmentIndex)) return false;
    await writeBook(books, { ...book, iReading: createReadingProgress(now, position.chapterIndex, position.segmentIndex) });
    return true;
  });
}

export async function settleReadingActivity(input: { now?: number; focus?: ReadingFocusClock; sleeping?: boolean; sleepingAt?: number }) {
  const now = input.now ?? Date.now();
  return mutate(async books => {
    const book = currentBook(books);
    if (!book) return { activity: null as CurrentReadingActivity | null, overflowMs: 0, endedActivityId: undefined as string | undefined };
    const boundary = input.sleeping && typeof input.sleepingAt === 'number' && Number.isFinite(input.sleepingAt)
      ? Math.min(now, Math.max(book.iReading!.activity!.checkpointAt, input.sleepingAt)) : now;
    const clock = await scheduledClock(book.iReading!, boundary, input.focus);
    const settled = settleReadingClock(book.iReading!, clock.now, clock.focus);
    const a = settled.state.activity;
    if (a?.status === 'preparing' && book.programme?.preparation === 'ready' && !input.sleeping
      && (!a.focusId || input.focus?.sessionId === a.focusId && !input.focus.paused && !input.focus.ended)) {
      a.status = 'reading'; a.startedAt = now; a.checkpointAt = now; a.updatedAt = now;
      a.remainingMs = a.focusId && input.focus?.remainingWorkMs !== undefined
        ? input.focus.remainingWorkMs : a.plannedMs;
      settled.state.events = [...settled.state.events, { id: `${a.id}:prepared`, at: now, change: '开始' as const }].slice(-8);
    }
    if (input.sleeping && (a?.status === 'reading' || a?.status === 'preparing')) {
      a.status = 'paused';
      settled.state.events = [...settled.state.events, { id: `${a.id}:sleep:${boundary}`, at: boundary, change: '暂停' as const }].slice(-8);
    }
    const next = { ...book, iReading: settled.state };
    if (JSON.stringify(book.iReading) !== JSON.stringify(next.iReading)) await writeBook(books, next);
    return { activity: snapshot(next), overflowMs: settled.overflowMs,
      endedActivityId: next.iReading.activity?.status === 'ended' ? next.iReading.activity.id : undefined };
  });
}

export async function controlReadingActivity(input: {
  action: 'start' | 'pause' | 'resume' | 'end'; bookId?: string; minutes?: number;
  operationId: string; expectedActivityId?: string | null; sleeping?: boolean; now?: number; focus?: ReadingFocusClock;
  schedule?: DailyReadingActivity['schedule']; beforeStart?: () => Promise<boolean>;
}): Promise<ReadingControlResult> {
  const now = input.now ?? Date.now();
  if (!input.operationId || !Number.isFinite(now) || now < 0 || !['start', 'pause', 'resume', 'end'].includes(input.action)) return { ok: false, reason: '阅读参数无效。' };
  const plannedMs = input.schedule?.plannedMs ?? input.minutes! * 60_000;
  if (input.action === 'start' && (!input.bookId || !Number.isSafeInteger(plannedMs) || plannedMs <= 0
    || (!input.schedule && !Number.isSafeInteger(input.minutes))
    || !Number.isFinite(new Date(now + plannedMs).getTime()))) return { ok: false, reason: '阅读参数无效。' };
  let failurePhase: 'reading' | 'source' | 'saving' = 'reading';
  try {
    return await mutate(async books => {
      const repeated = books.find(b => b.iReading?.activity?.operationId === input.operationId || b.iReading?.events.some(e => e.id === input.operationId));
      if (repeated) {
        if ((input.action === 'resume' || input.action === 'pause') && repeated.iReading?.activity?.schedule) {
          failurePhase = 'saving';
          await (await import('../schedule/ownScheduleExecution')).persistOwnReadingExecution(repeated);
        }
        await registerReadingMemoryActivityAfterSave(repeated);
        return { ok: true, activity: snapshot(repeated)! };
      }
      let book: ReadingBook | undefined = currentBook(books);
      if (input.expectedActivityId !== undefined && (book?.iReading?.activity?.id ?? null) !== input.expectedActivityId) return { ok: false, reason: '当前阅读活动已变化，本次操作未执行。' };
      if ((input.action === 'start' || input.action === 'resume') && input.sleeping) return { ok: false, reason: '当前正在睡眠，本次阅读未开始或继续。' };
      if (input.action === 'start') {
        if (book) return { ok: false, reason: '已有阅读活动，请先结束本次阅读。' };
        book = books.find(b => b.id === input.bookId);
        if (!book) return { ok: false, reason: '未找到这本书。' };
        if (!book.iReading || book.iReading.needsSourceConfirmation) return { ok: false, reason: '这本书需要先确认接读起点。' };
        if (book.iReading.activity?.schedule) await (await import('../schedule/ownScheduleExecution')).persistOwnReadingExecution(book);
        if (book.iReading.reachedEnd) return { ok: false, reason: book.programme ? '这期节目没有可继续读取的内容。' : '这本书没有可继续读取的内容。' };
        failurePhase = 'source';
        const chapter = await loadReadingChapter(book.id, book.iReading.cursor.chapterIndex);
        const preparing = !!book.programme && book.programme.preparation !== 'ready';
        if (!preparing && !chapter?.segmentsMeta.some(s => s.segmentIndex === book!.iReading!.cursor.segmentIndex)) return { ok: false, reason: '原文暂时无法读取。' };
        if (input.beforeStart && !await input.beforeStart()) return { ok: false, reason: '当前阅读活动已变化，本次操作未执行。' };
        book = { ...book, iReading: { ...book.iReading, activity: { id: input.operationId, operationId: input.operationId,
          memoryIngestionVersion: 1,
          ...(input.schedule ? { schedule: { ...input.schedule } } : {}), elapsedMs: 0, completedUnitCount: 0,
          status: preparing ? 'preparing' : 'reading', startedAt: now, checkpointAt: now, updatedAt: now,
          plannedMs, remainingMs: preparing ? null : plannedMs } } };
      } else {
        if (!book) return { ok: false, reason: '没有可以操作的阅读活动。' };
        if (!await canRequestForActivity(book.iReading!.activity)) return { ok: false, reason: '当前阅读活动已变化，本次操作未执行。' };
        book = { ...book, iReading: settleReadingClock(book.iReading!, now, input.focus).state };
        const activity = book.iReading!.activity!;
        if (activity.status === 'ended') return { ok: false, reason: '当前阅读活动已变化，本次操作未执行。' };
        if (input.action === 'resume' && book.programme?.episodes) {
          const chapter = await loadReadingChapter(book.id, book.iReading!.cursor.chapterIndex);
          if (!chapter?.segmentsMeta.some(s => s.segmentIndex === book!.iReading!.cursor.segmentIndex)) return { ok: false, reason: '原文暂时无法读取。' };
        }
        if (input.action === 'resume' && activity.schedule && activity.remainingMs !== null) {
          const permitted = await (await import('../schedule/ownedDayPlanStore')).canResumeOwnSchedule(activity.schedule.itemId, activity.remainingMs, now);
          if (!permitted.ok) return { ok: false, reason: permitted.conflict
            ? (await import('../schedule/ownScheduleSave')).formatScheduleSaveConflict(permitted.conflict)
            : '当前阅读活动已变化，本次操作未执行。' };
        }
        activity.status = input.action === 'pause' ? 'paused' : input.action === 'resume'
          ? book.programme && (book.programme.preparation !== 'ready' || activity.remainingMs === null && activity.plannedMs !== null) ? 'preparing' : 'reading' : 'ended';
        activity.checkpointAt = now;
        activity.updatedAt = now;
        activity.operationId = input.operationId;
        if (input.action === 'end') { activity.remainingMs = 0; activity.endReason = 'manual'; activity.endedAt = now; }
      }
      const state = book.iReading!;
      state.updatedAt = now;
      const change = input.action === 'start' ? '开始' : input.action === 'pause' ? '暂停' : input.action === 'resume' ? '继续' : '本次活动结束';
      if (state.activity?.status !== 'preparing') state.events = [...state.events, { id: input.operationId, at: now, change }].slice(-8) as DailyReadingProgress['events'];
      failurePhase = 'saving';
      await writeBook(books, book);
      if ((input.action === 'resume' || input.action === 'pause') && book.iReading?.activity?.schedule)
        await (await import('../schedule/ownScheduleExecution')).persistOwnReadingExecution(book);
      return { ok: true, activity: snapshot(book)! };
    });
  } catch { return { ok: false, reason: (failurePhase as string) === 'saving' ? '阅读安排的保存结果暂时无法确认。'
    : (failurePhase as string) === 'source' ? '原文暂时无法读取。' : '阅读记录暂时无法读取。' }; }
}

export async function bindReadingActivityToFocus(input: { activityId: string; sessionId: string; effectiveWorkMs: number; now?: number }): Promise<ReadingControlResult> {
  const now = input.now ?? Date.now();
  return mutate(async books => {
    const book = currentBook(books);
    if (!book || book.iReading!.activity!.id !== input.activityId) return { ok: false, reason: '当前阅读活动已变化，本次操作未执行。' };
    if (!await canRequestForActivity(book.iReading!.activity)) return { ok: false, reason: '当前阅读活动已变化，本次操作未执行。' };
    if (book.iReading!.activity!.focusId === input.sessionId) return { ok: true, activity: snapshot(book)! };
    const state = settleReadingClock(book.iReading!, now).state;
    state.activity = { ...state.activity!, focusId: input.sessionId, focusWorkMs: input.effectiveWorkMs };
    const next = { ...book, iReading: state };
    await writeBook(books, next);
    return { ok: true, activity: snapshot(next)! };
  });
}

/** The schedule is already saved. Finish this execution segment, never the book or a replacement activity. */
export async function finishScheduledReadingActivity(input: {
  itemId: string; activityId: string; operationId: string; now?: number; focus?: ReadingFocusClock; keepFocusBinding?: boolean;
}): Promise<ReadingControlResult> {
  const now = input.now ?? Date.now();
  const epoch = captureBackupRestoreDataEpoch();
  let focus = input.focus;
  if (!focus) {
    const { loadActiveFocusSession } = await import('../focus/focusStore');
    const session = await loadActiveFocusSession(true);
    if (session) {
      const { projectFocusReadingClock } = await import('../focus/focusReadingPolicy');
      const { makeFocusSessionId } = await import('../focus/focusIdentity');
      const clock = projectFocusReadingClock(session, now);
      focus = { sessionId: makeFocusSessionId(session), effectiveWorkMs: clock.effectiveWorkMs,
        paused: session.paused || clock.inBreak, ended: clock.completed };
    }
  }
  try {
    const result = await mutate<ReadingControlResult>(async books => {
      const book = books.find(entry => entry.iReading?.activity?.id === input.activityId
        && entry.iReading.activity.schedule?.itemId === input.itemId);
      if (!book?.iReading) return { ok: true };
      if (book.iReading.activity!.status === 'ended') return { ok: true, activity: snapshot(book)! };
      const state = settleReadingClock(book.iReading, now, focus).state;
      state.activity = { ...state.activity!, status: 'ended', endReason: 'manual', endedAt: now,
        checkpointAt: now, updatedAt: now, operationId: input.operationId };
      state.opportunityAt = undefined;
      state.events = [...state.events.filter(event => event.id !== input.operationId),
        { id: input.operationId, at: now, change: '本次活动结束' as const }].slice(-8);
      const next = { ...book, iReading: state };
      await writeBook(books, next);
      return { ok: true, activity: snapshot(next)! };
    }, epoch);
    if (result.activity && !input.keepFocusBinding) await (await import('../focus/focusReadingRuntime')).finishFocusReadingActivity(input.activityId, now, epoch);
    return result;
  } catch { return { ok: false, reason: '阅读安排的保存结果暂时无法确认。' }; }
}

/** Apply a persisted duration choice on the same activity, without replaying
 * controls or disturbing notes, the reading interval, or the focus binding. */
export async function resizeScheduledReadingActivity(input: {
  itemId: string; activityId: string; operationId: string; effectiveAt: number; elapsedMs: number;
  remainingMs: number; planRevision: number; sourceUpdatedAt: number; windowEndAt: number; now?: number;
}): Promise<ReadingControlResult> {
  const now = input.now ?? Date.now();
  try {
    return await mutate(async books => {
      const book = books.find(value => value.iReading?.activity?.id === input.activityId
        && value.iReading.activity.schedule?.itemId === input.itemId);
      if (!book?.iReading) return { ok: false, reason: '当前阅读活动已变化，本次操作未执行。' };
      const original = book.iReading.activity!, revision = original.schedule!.planRevision ?? 0;
      if (revision >= input.planRevision) return { ok: revision === input.planRevision, activity: snapshot(book)! };
      const item = await (await import('../schedule/scheduleStore')).loadScheduleItemById(input.itemId);
      if (!item || item.status !== 'pending' || item.execution?.durationChange?.operationId !== input.operationId
        || item.execution.planRevision !== input.planRevision) return { ok: false, reason: '当前阅读活动已变化，本次操作未执行。' };
      if (original.status === 'ended') {
        if (original.endedAt === undefined || original.endedAt < input.effectiveAt)
          return { ok: false, reason: '这项活动已经结束，本次时长修改没有生效。' };
        // A previously sent chapter can finish the book between the calendar
        // commit and its local application. Adopt only the saved binding; never
        // revive the terminal activity or discard the real chapter result.
        const totalPlannedMs = input.elapsedMs + input.remainingMs;
        const plannedMs = totalPlannedMs - (original.schedule!.baseElapsedMs ?? 0);
        const next = { ...book, iReading: { ...book.iReading, activity: { ...original, plannedMs,
          schedule: { ...original.schedule!, planRevision: input.planRevision, sourceUpdatedAt: input.sourceUpdatedAt,
            windowEndAt: input.windowEndAt, totalPlannedMs, plannedMs } } } };
        await writeBook(books, next);
        return { ok: true, activity: snapshot(next)! };
      }
      const focusAt = async (at: number) => {
        if (!original.focusId) return undefined;
        const session = await (await import('../focus/focusStore')).loadActiveFocusSession(true);
        if (!session || (await import('../focus/focusIdentity')).makeFocusSessionId(session) !== original.focusId) return undefined;
        const clock = (await import('../focus/focusReadingPolicy')).projectFocusReadingClock(session, at);
        return { sessionId: original.focusId, effectiveWorkMs: clock.effectiveWorkMs,
          paused: session.paused || clock.inBreak, ended: clock.completed };
      };
      let state = settleReadingClock(book.iReading, input.effectiveAt, await focusAt(input.effectiveAt)).state;
      if (state.activity!.status === 'ended') return { ok: false, reason: '这项活动已经结束，本次时长修改没有生效。' };
      const activity = state.activity!, base = activity.schedule!.baseElapsedMs ?? 0;
      const totalPlannedMs = input.elapsedMs + input.remainingMs;
      const recordedElapsed = Math.max(activity.elapsedMs ?? 0, input.elapsedMs - base);
      const retainedWork = recordedElapsed - (activity.elapsedMs ?? 0);
      activity.elapsedMs = recordedElapsed;
      state.remainderMs = (state.remainderMs + retainedWork) % READING_INTERVAL_MS;
      activity.plannedMs = totalPlannedMs - base;
      activity.remainingMs = activity.status === 'preparing' ? null
        : Math.max(0, totalPlannedMs - base - (activity.elapsedMs ?? 0));
      activity.schedule = { ...activity.schedule!, sourceUpdatedAt: input.sourceUpdatedAt, windowEndAt: input.windowEndAt,
        planRevision: input.planRevision, plannedMs: activity.plannedMs, totalPlannedMs };
      activity.updatedAt = Math.max(activity.updatedAt, input.effectiveAt);
      state.updatedAt = Math.max(state.updatedAt, input.effectiveAt);
      const host = await (await import('../life/readingActivityRuntime')).readingHostState(now);
      const until = host.sleeping && host.sleepingAt !== undefined ? Math.min(now, host.sleepingAt) : now;
      state = settleReadingClock(state, Math.max(activity.checkpointAt, until), await focusAt(until)).state;
      if (host.sleeping && state.activity!.status === 'reading') state.activity!.status = 'paused';
      const next = { ...book, iReading: state };
      await writeBook(books, next);
      return { ok: true, activity: snapshot(next)! };
    });
  } catch { return { ok: false, reason: '阅读安排的保存结果暂时无法确认。' }; }
}

export async function startReadingActivityForFocus(input: { bookId: string; sessionId: string; remainingMs: number | null; effectiveWorkMs: number; operationId: string; now?: number }): Promise<ReadingControlResult> {
  const now = input.now ?? Date.now();
  if (!input.operationId || !input.sessionId || (input.remainingMs !== null && (!Number.isFinite(input.remainingMs) || input.remainingMs <= 0))
    || !Number.isFinite(input.effectiveWorkMs) || input.effectiveWorkMs < 0) return { ok: false, reason: '阅读参数无效。' };
  return mutate(async books => {
    const repeated = books.find(b => b.iReading?.activity?.operationId === input.operationId);
    if (repeated) { await registerReadingMemoryActivityAfterSave(repeated); return { ok: true, activity: snapshot(repeated)! }; }
    if (currentBook(books)) return { ok: false, reason: '已有阅读活动，请先结束本次阅读。' };
    const book = books.find(b => b.id === input.bookId);
    if (!book) return { ok: false, reason: '未找到这本书。' };
    if (!book.iReading || book.iReading.needsSourceConfirmation) return { ok: false, reason: '这本书需要先确认接读起点。' };
    if (book.iReading.activity?.schedule) await (await import('../schedule/ownScheduleExecution')).persistOwnReadingExecution(book);
    if (book.iReading.reachedEnd) return { ok: false, reason: book.programme ? '这期节目没有可继续读取的内容。' : '这本书没有可继续读取的内容。' };
    const chapter = await loadReadingChapter(book.id, book.iReading.cursor.chapterIndex);
    const preparing = !!book.programme && book.programme.preparation !== 'ready';
    if (!preparing && !chapter?.segmentsMeta.some(s => s.segmentIndex === book.iReading!.cursor.segmentIndex)) return { ok: false, reason: '原文暂时无法读取。' };
    const state: DailyReadingProgress = { ...book.iReading, updatedAt: now, activity: { id: input.operationId, operationId: input.operationId,
      memoryIngestionVersion: 1,
      status: preparing ? 'preparing' : 'reading', plannedMs: input.remainingMs, remainingMs: preparing ? null : input.remainingMs, startedAt: now, checkpointAt: now, updatedAt: now,
      focusId: input.sessionId, focusWorkMs: input.effectiveWorkMs, jointOnly: true },
      events: preparing ? book.iReading.events : [...book.iReading.events, { id: input.operationId, at: now, change: '开始' as const }].slice(-8) };
    const next = { ...book, iReading: state };
    await writeBook(books, next);
    return { ok: true, activity: snapshot(next)! };
  });
}

export async function continueReadingActivityForFocus(input: { activityId: string; sessionId: string; remainingMs: number | null; effectiveWorkMs?: number; operationId: string; now?: number }): Promise<ReadingControlResult> {
  const now = input.now ?? Date.now();
  return mutate(async books => {
    const book = books.find(b => b.iReading?.activity?.id === input.activityId);
    if (!book || (currentBook(books) && currentBook(books)!.id !== book.id)) return { ok: false, reason: '当前阅读活动已变化，本次操作未执行。' };
    if (book.iReading!.activity!.operationId === input.operationId) return { ok: true, activity: snapshot(book)! };
    if (!await canRequestForActivity(book.iReading!.activity)) return { ok: false, reason: '当前阅读活动已变化，本次操作未执行。' };
    if (book.iReading!.reachedEnd || book.iReading!.activity!.focusId !== input.sessionId
      || (book.iReading!.activity!.status === 'ended' && book.iReading!.activity!.endReason !== 'duration')) return { ok: false, reason: '当前阅读活动已变化，本次操作未执行。' };
    const state: DailyReadingProgress = { ...book.iReading!, updatedAt: now, activity: { ...book.iReading!.activity!, operationId: input.operationId,
      status: 'reading', endReason: undefined, plannedMs: input.remainingMs, remainingMs: input.remainingMs, checkpointAt: now, updatedAt: now,
      focusId: input.sessionId, focusWorkMs: input.effectiveWorkMs ?? book.iReading!.activity!.focusWorkMs, jointOnly: true },
      events: [...book.iReading!.events, { id: input.operationId, at: now, change: '继续' as const }].slice(-8) };
    const next = { ...book, iReading: state };
    await writeBook(books, next);
    return { ok: true, activity: snapshot(next)! };
  });
}

export async function getNextReadingWake(now = Date.now()) {
  const book = currentBook(await loadReadingLibraryStrict());
  if (!book || book.iReading!.activity!.status !== 'reading') return null;
  const state = settleReadingClock(book.iReading!, now).state;
  const a = state.activity!;
  if (a.status === 'ended') return { activityId: a.id, at: book.iReading!.activity!.checkpointAt + (book.iReading!.activity!.remainingMs ?? 0) };
  if (state.opportunityAt !== undefined) return { activityId: a.id, at: state.opportunityAt };
  return { activityId: a.id, at: now + Math.min(READING_INTERVAL_MS - state.remainderMs, a.remainingMs ?? Infinity) };
}

export async function advanceSavedSegments(bookId: string, now: number) {
  return mutate(async books => {
    let book = books.find(b => b.id === bookId);
    if (!book?.iReading) return null;
    const state = { ...book.iReading, cursor: { ...book.iReading.cursor }, activity: book.iReading.activity ? { ...book.iReading.activity } : undefined };
    let resultBelongsToActivity = true;
    while (state.cursor.chapterIndex < book.totalChapters) {
      const chapter = await loadReadingChapter(bookId, state.cursor.chapterIndex);
      if (book.programme?.episodes && !chapter?.segmentsMeta.length) {
        // A missing episode is not an empty book chapter: keep this exact position.
        if (state.activity && state.activity.status !== 'ended') state.activity = { ...state.activity, status: 'paused', checkpointAt: now, updatedAt: now };
        break;
      }
      if (!chapter) throw new Error('reading-source-unavailable');
      const segment = chapter.segmentsMeta.find(s => s.segmentIndex >= state.cursor.segmentIndex);
      if (!segment) { state.cursor = { chapterIndex: state.cursor.chapterIndex + 1, segmentIndex: 0 }; continue; }
      state.cursor.segmentIndex = segment.segmentIndex;
      if (segment.status !== 'done' || segment.sourceVersion !== readingSegmentSourceVersion(chapter, segment) || !segment.resultOperationId) break;
      const results = await loadReadingAnnotations(bookId, chapter.index);
      if (![...results.annotations, ...results.summaries].some(r => r.resultOperationId === segment.resultOperationId && r.sourceVersion === segment.sourceVersion)) break;
      resultBelongsToActivity = segment.resultActivityId === undefined || segment.resultActivityId === state.activity?.id;
      if (state.requestReservation?.id === segment.resultOperationId) {
        const sameActivity = !!state.activity && (!state.requestReservation.activityId || state.requestReservation.activityId === state.activity.id);
        resultBelongsToActivity = sameActivity;
        if (sameActivity) state.activity!.completedUnitCount = (state.activity!.completedUnitCount ?? 0) + 1;
        state.requestReservation = undefined;
      }
      state.cursor.segmentIndex += 1;
    }
    if (state.cursor.chapterIndex >= book.totalChapters) {
      state.reachedEnd = true;
      state.completedAll = book.totalChapters > 0;
      for (let index = 0; index < book.totalChapters && state.completedAll; index += 1) {
        const source = await loadReadingChapter(bookId, index);
        const results = await loadReadingAnnotations(bookId, index);
        state.completedAll = !!source?.segmentsMeta.length && source.segmentsMeta.every(part =>
          (!source.contentBlocks || !!part.contentRange)
          &&
          part.status === 'done' && part.sourceVersion === readingSegmentSourceVersion(source, part) && !!part.resultOperationId
          && [...results.annotations, ...results.summaries].some(r => r.resultOperationId === part.resultOperationId && r.sourceVersion === part.sourceVersion));
      }
      if (!book.iReading.reachedEnd && resultBelongsToActivity && state.activity?.status !== 'ended' && state.activity
        && !state.activity.schedule?.choiceSourceId) {
        state.activity = { ...state.activity, status: 'ended', endReason: 'complete', remainingMs: 0, updatedAt: now, endedAt: now };
        state.events = [...state.events, { id: `${state.activity.id}:complete`, at: now,
          change: state.completedAll ? book.programme ? '已读完本期文字稿。' as const : '已完成全书阅读' as const : '本次活动结束' as const }].slice(-8);
      }
    }
    state.updatedAt = now;
    book = { ...book, iReading: state };
    await writeBook(books, book);
    return book;
  });
}

export async function runDailyReadingCheck(input: {
  runtime: ReadingAiRuntime; automaticEnabled: boolean; chatBusy: boolean; sleeping: boolean;
  now?: number; focus?: ReadingFocusClock; sleepingAt?: number; canRequest?: () => Promise<boolean>;
  beginBudgetRequest: (requestId: string, dataEpoch: number, beforeTransport: () => Promise<void>, transport?: ReadingTransport) => Promise<void>;
  requestAnnotation?: typeof requestDailyReadingAnnotation;
}) {
  const now = input.now ?? Date.now();
  const settled = await settleReadingActivity({ now, focus: input.focus, sleeping: input.sleeping, sleepingAt: input.sleepingAt });
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return 'restore';
  const all = await loadReadingLibraryStrict();
  let unstartedDeferred: DailyReadingActivity['deferredOpportunity'];
  const releaseUnstarted = (requestId: string) => mutate(async books => {
    const latest = books.find(b => b.iReading?.requestReservation?.id === requestId);
    if (!latest?.iReading || latest.iReading.requestReservation?.id !== requestId) return;
    await writeBook(books, { ...latest, iReading: { ...latest.iReading,
      opportunityAt: latest.iReading.opportunityAt ?? (latest.iReading.activity?.id === latest.iReading.requestReservation.activityId
        && latest.iReading.activity?.status === 'reading' ? latest.iReading.requestReservation.opportunityAt : undefined),
      ...(unstartedDeferred && latest.iReading.activity?.status === 'reading'
        && latest.iReading.activity.id === latest.iReading.requestReservation.activityId
        && (latest.iReading.opportunityAt === undefined || latest.iReading.opportunityAt === latest.iReading.requestReservation.opportunityAt)
        && unstartedDeferred.at === latest.iReading.requestReservation.opportunityAt
        ? { activity: { ...latest.iReading.activity, deferredOpportunity: unstartedDeferred } } : {}),
      requestReservation: undefined, updatedAt: Date.now() } });
  });
  // Finish a return we still actually hold, even after pause/end or disabling automatic requests.
  // This path cannot call the model and does not create another reading opportunity.
  const localBook = pendingReadingSettlement(all);
  if (localBook) {
    try {
      const result = await resumeReadingSettlement(localBook, releaseUnstarted);
      if (result.status === 'saved') {
        const saved = await advanceSavedSegments(localBook.id, now);
        if (saved?.iReading?.reachedEnd && saved.iReading.activity?.schedule?.choiceSourceId) {
          await (await import('../schedule/ownReadingContinuation')).reconcileOwnReadingContinuation(localBook.id, now);
        }
      }
      return result.status;
    } catch {
      // A temporarily unreadable old return must not take away another activity's opportunity.
      if (!currentBook(all) || currentBook(all)!.id === localBook.id) return 'failed';
    }
  }
  // A legal result that already reached disk may finish saving even after the activity stopped.
  let candidate = currentBook(all) ?? all.find(b => b.iReading?.activity?.id === settled.endedActivityId)
    ?? all.find(b => b.iReading?.activity?.status === 'ended' && ['duration', 'focus'].includes(b.iReading.activity.endReason ?? '')
      && b.iReading.opportunityAt === now);
  if (!candidate) {
    for (const book of all) {
      if (!book.iReading) continue;
      const chapter = await loadReadingChapter(book.id, book.iReading.cursor.chapterIndex);
      if (chapter?.segmentsMeta.some(s => s.segmentIndex === book.iReading!.cursor.segmentIndex && s.request?.result)) { candidate = book; break; }
    }
  }
  if (!candidate?.iReading) return 'idle';
  const clearDeferred = () => !candidate!.iReading!.activity?.deferredOpportunity ? Promise.resolve() : mutate(async books => {
    const latest = books.find(value => value.id === candidate!.id);
    if (!latest?.iReading?.activity?.deferredOpportunity || latest.iReading.activity.id !== candidate!.iReading!.activity?.id
      || latest.iReading.activity.deferredOpportunity.at !== candidate!.iReading!.activity!.deferredOpportunity!.at) return;
    const { deferredOpportunity: _deferred, ...activity } = latest.iReading.activity;
    await writeBook(books, { ...latest, iReading: { ...latest.iReading, activity, updatedAt: Date.now() } });
  }, epoch);
  if (candidate.programme?.preparation !== undefined && candidate.programme.preparation !== 'ready') { await clearDeferred(); return 'deferred'; }
  let book: ReadingBook | null;
  try { book = await advanceSavedSegments(candidate.id, now); }
  catch (error) {
    await clearDeferred();
    if (candidate.iReading.activity?.deferredOpportunity && error instanceof Error && error.message === 'reading-source-unavailable') return 'source-unavailable';
    throw error;
  }
  if (!book?.iReading || book.iReading.reachedEnd) {
    if (book?.iReading?.activity?.schedule?.choiceSourceId) await (await import('../schedule/ownReadingContinuation'))
      .reconcileOwnReadingContinuation(book.id, now);
    return 'complete';
  }
  let chapter = await loadReadingChapter(book.id, book.iReading.cursor.chapterIndex);
  let segment = chapter?.segmentsMeta.find(s => s.segmentIndex === book!.iReading!.cursor.segmentIndex);
  if (!chapter || !segment) { await clearDeferred(); return 'source-unavailable'; }
  const pendingResult = !!segment.request?.result;
  if (!pendingResult && book.fileType === 'epub' && (!chapter.contentBlocks || !segment.contentRange || book.iReading.needsSourceConfirmation)) {
    const upgraded = await (await import('./readingEpubUpgradeRuntime')).ensureLegacyEpubReadingSource(book.id, { now });
    if (upgraded.status !== 'ready') { await clearDeferred(); return upgraded.status === 'needs-confirmation' ? 'source-confirmation-required' : 'source-unavailable'; }
    book = (await loadReadingLibraryStrict()).find(item => item.id === book!.id)!;
    chapter = await loadReadingChapter(book.id, book.iReading!.cursor.chapterIndex);
    segment = chapter?.segmentsMeta.find(part => part.segmentIndex === book!.iReading!.cursor.segmentIndex);
    if (!chapter || !segment) { await clearDeferred(); return 'source-unavailable'; }
  }
  if (!book?.iReading) return 'source-unavailable';
  const atExactEnd = book.iReading.activity?.status === 'ended' && ['duration', 'focus'].includes(book.iReading.activity.endReason ?? '')
    && book.iReading.opportunityAt === now;
  if (!pendingResult && (!input.automaticEnabled || input.chatBusy || input.sleeping || input.focus?.paused
    || (book.iReading.activity?.status !== 'reading' && !atExactEnd) || book.iReading.opportunityAt === undefined)) { await clearDeferred(); return 'deferred'; }
  const deferred = book.iReading.activity?.deferredOpportunity;
  if (!pendingResult && deferred && deferred.at === book.iReading.opportunityAt && now < deferred.retryAt) return 'deferred';
  let started = false;
  const deferUnpaid = () => mutate(async books => {
    const latest = books.find(value => value.id === book!.id), progress = latest?.iReading, activity = progress?.activity;
    const at = Date.now();
    if (!latest || !progress || !activity || activity.id !== book!.iReading!.activity?.id
      || activity.status !== 'reading' || progress.opportunityAt !== book!.iReading!.opportunityAt
      || progress.opportunityAt === undefined || progress.requestReservation
      || settleReadingClock(progress, at, input.focus).state.activity?.status !== 'reading'
      || !await canRequestForActivity(activity)) return;
    await writeBook(books, { ...latest, iReading: { ...progress, updatedAt: at,
      activity: { ...activity, deferredOpportunity: { at: progress.opportunityAt, retryAt: at + 60_000 } } } });
  }, epoch);
  const run = async () => {
    if (!pendingResult) ({ chapter, segment } = await prepareReadingRequestSource({ ...input.runtime, book, chapter: chapter!, segment: segment! }));
    const result = await runReadingSegment({ book, chapter: chapter!, segment: segment!, kind: 'daily', dataEpoch: epoch,
      beforeTransport: async (requestId, transport) => {
        if (input.canRequest && !await input.canRequest()) throw new Error('reading-host-deferred');
        if (!await canRequestForActivity(book.iReading!.activity)) throw new Error('reading-activity-changed');
        await input.beginBudgetRequest(requestId, epoch, async () => {
          await mutate(async books => {
            const latest = books.find(b => b.id === book.id);
            if (!await canRequestForActivity(latest?.iReading?.activity)) throw new Error('reading-activity-changed');
            if (transport && transport.index > 0) {
              if (latest?.iReading?.activity?.status !== 'reading' || latest.iReading.activity.id !== book.iReading!.activity!.id
                || latest.iReading.requestReservation?.id !== requestId) throw new Error('reading-activity-paused');
              return;
            }
            if (!latest?.iReading || latest.iReading.opportunityAt === undefined || latest.iReading.activity?.id !== book.iReading!.activity!.id) throw new Error('reading-opportunity-changed');
            if (!atExactEnd && latest.iReading.activity.status !== 'reading') throw new Error('reading-activity-paused');
            unstartedDeferred = latest.iReading.activity.deferredOpportunity;
            const { deferredOpportunity: _deferred, ...activity } = latest.iReading.activity;
            await writeBook(books, { ...latest, iReading: { ...latest.iReading, activity, opportunityAt: undefined,
              requestReservation: { id: requestId, opportunityAt: latest.iReading.opportunityAt, activityId: latest.iReading.activity.id }, updatedAt: Date.now() } });
          });
        }, transport);
        started = true;
      },
      onUnstarted: releaseUnstarted,
      request: beforeTransport => (input.requestAnnotation ?? requestDailyReadingAnnotation)({ ...input.runtime, book, chapter: chapter!, segment: segment!, beforeTransport }),
    });
    if (result.status === 'saved') {
      const saved = await advanceSavedSegments(book.id, Date.now());
      if (saved?.iReading?.reachedEnd && saved.iReading.activity?.schedule?.choiceSourceId) {
        await (await import('../schedule/ownReadingContinuation')).reconcileOwnReadingContinuation(book.id, Date.now());
      }
    }
    else if (!started) await clearDeferred();
    return result.status;
  };
  try {
    if (pendingResult) return await run();
    const result = await runScheduledAiCall('reading', 'background', run);
    if (!('value' in result)) {
      if (result.reason.startsWith('busy:')) await deferUnpaid();
      else await clearDeferred();
    }
    return 'value' in result ? result.value : 'deferred';
  } catch (error) {
    if (!started && book.iReading.activity?.deferredOpportunity
      && error instanceof Error && /^reading-budget-deferred(?::\d+)?$/.test(error.message)) await deferUnpaid();
    else await clearDeferred();
    return started ? 'failed' : 'deferred';
  }
}

export async function buildDailyReadingCurrentMaterial(now = Date.now()) {
  const a = await loadCurrentReadingActivity(now);
  if (!a || a.status === 'ended') return '';
  const book = (await loadReadingLibraryStrict()).find(b => b.id === a.bookId);
  const collection = book ? buildProgrammeCollectionMaterial(book) : '';
  if (a.status === 'preparing') return `【I 的阅读】\n\n节目：${a.title}\n字幕正在准备。`;
  return `【I 的阅读】\n\n${a.contentType === 'programme' ? '节目' : '书名'}：${a.title}\n当前状态：${a.status === 'paused' ? '已暂停' : '阅读中'}\n${a.plannedMs === null || a.remainingMs === null
    ? 'I 这次的阅读随这场共同专注结束。' : `这次安排读：${a.plannedMs / 60_000} 分钟\n这次还剩：${Math.ceil(a.remainingMs / 60_000)} 分钟`}` + (collection ? `\n\n${collection}` : '');
}

export async function buildDailyReadingFocusMaterial(_now = Date.now()) {
  const book = currentBook(await loadReadingLibraryStrict());
  if (!book?.iReading) return '';
  const cursor = book.iReading.cursor;
  let selected: Awaited<ReturnType<typeof loadReadingAnnotations>>['summaries'][number] | undefined;
  for (let index = cursor.chapterIndex; index >= 0 && !selected; index -= 1) {
    const chapter = await loadReadingChapter(book.id, index);
    if (!chapter) continue;
    const notes = await loadReadingAnnotations(book.id, index);
    selected = notes.summaries.filter(s => {
      const part = chapter.segmentsMeta.find(p => p.segmentIndex === s.segmentIndex);
      return (index < cursor.chapterIndex || s.segmentIndex < cursor.segmentIndex) && part?.status === 'done'
        && !!s.sourceVersion && s.sourceVersion === readingSegmentSourceVersion(chapter, part);
    }).sort((a, b) => b.segmentIndex - a.segmentIndex)[0];
  }
  if (!selected) return '';
  const position = formatReadingPosition(selected.chapterIndex, selected.segmentIndex);
  return `【I 这会儿在读的内容】\n\n名称：${book.title}\n已读到：${position}\n\n【I 留下的读后感】\n\n对应位置：${position}\n记录时间：${formatReadingTime(selected.createdAt)}\n${selected.summary}`;
}
