import { Platform } from 'react-native';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { readingHostState } from '../life/readingActivityRuntime';
import { controlReadingActivity, settleReadingActivity, finishScheduledReadingActivity, resizeScheduledReadingActivity } from '../reading/readingDailyRuntime';
import { settleReadingClock } from '../reading/readingDailyPolicy';
import { readSleepSchedule } from '../life/sleepPlanStore';
import type { ScheduleSaveContext } from './scheduleDurationPolicy';
import { loadReadingLibraryStrict } from '../reading/readingStore';
import { prepareProgramme } from '../reading/readingProgrammeStore';
import type { DailyReadingActivity, ReadingBook } from '../reading/readingTypes';
import { recordHabitActivityCompletion } from './habitStore';
import { isOwnScheduleAdjustmentInFlight } from './ownedDayPlanStore';
import { reconcileOwnReadingContinuation, reconcileOwnReadingReplacement, resolveOwnReadingStart } from './ownReadingContinuation';
import { applyOccurrenceCompletionReceipt, loadOwnedScheduleItems, loadOwnScheduleAdjustments, loadScheduleItemById, saveScheduleExecution,
  type ScheduleExecution, type ScheduleItem } from './scheduleStore';

type Binding = NonNullable<DailyReadingActivity['schedule']>;
export async function readOwnScheduledReadingBoundary(binding: Binding, activityId: string): Promise<number | null> {
  const item = await loadScheduleItemById(binding.itemId);
  if (item?.execution?.activityId === activityId && item.execution.durationChange?.pending
    && (item.execution.planRevision ?? 0) > (binding.planRevision ?? 0)) return item.execution.durationChange.effectiveAt;
  if (item?.execution?.activityId === activityId && item.execution.adjustment
    && (item.execution.planRevision ?? 0) !== (binding.planRevision ?? 0)) return item.execution.adjustment.changedAt;
  return item && item.status === 'cancelled' ? item.updatedAt : null;
}
export async function isOwnScheduledReadingRequestAllowed(binding: Binding, activityId: string): Promise<boolean> {
  if (isOwnScheduleAdjustmentInFlight(binding.itemId)) return false;
  const item = await loadScheduleItemById(binding.itemId);
  return !!item && item.owner === 'I' && item.status === 'pending' && !item.execution?.adjustment?.pending && !item.execution?.durationChange?.pending
    && (item.execution?.planRevision ?? 0) === (binding.planRevision ?? 0)
    && (!item.execution?.activityId || item.execution.activityId === activityId);
}

/** A read-only projection for the transaction's commit-time choice. It never
 * obtains the reading write lock or settles a model opportunity to storage. */
export async function readOwnScheduleSaveContext(items: ScheduleItem[], now = Date.now()): Promise<ScheduleSaveContext> {
  const [books, host, sleep, session] = await Promise.all([loadReadingLibraryStrict(), readingHostState(now), readSleepSchedule(now),
    (await import('../focus/focusStore')).loadActiveFocusSession(true)]);
  const { projectFocusReadingClock } = await import('../focus/focusReadingPolicy');
  const { makeFocusSessionId } = await import('../focus/focusIdentity');
  const at = (time: number): ScheduleSaveContext => {
    const executions: Record<string, ScheduleExecution> = {};
    const activityReadingIds: Record<string, string> = {};
    const until = host.sleeping && host.sleepingAt !== undefined ? Math.min(time, host.sleepingAt) : time;
    const projected = session ? projectFocusReadingClock(session, until) : undefined;
    const focus = session && projected ? { sessionId: makeFocusSessionId(session), effectiveWorkMs: projected.effectiveWorkMs,
      paused: session.paused || projected.inBreak, ended: projected.completed } : host.focus;
    for (const item of items) {
      if (item.execution) executions[item.id] = item.execution;
      const book = books.find(value => value.iReading?.activity?.schedule?.itemId === item.id
        && (!item.execution?.activityId || value.iReading.activity.id === item.execution.activityId));
      if (!book?.iReading?.activity || item.execution?.adjustment?.pending || item.execution?.durationChange?.pending) continue;
      const activity = settleReadingClock(book.iReading, Math.max(book.iReading.activity.checkpointAt, until), focus).state.activity!;
      if (host.sleeping && activity.status === 'reading') activity.status = 'paused';
      activityReadingIds[item.id] = book.id;
      executions[item.id] = executionOf(activity, item.execution ?? undefined);
    }
    return { now: time, executions, activityReadingIds, sleepIntervals: sleep && sleep.currentWakeAt > time && sleep.currentWakeAt > sleep.currentSleepAt
      ? [{ start: sleep.currentSleepAt, end: sleep.currentWakeAt }] : [], at };
  };
  return at(now);
}

function executionOf(activity: DailyReadingActivity, prior?: ScheduleExecution): ScheduleExecution {
  const binding = activity.schedule!;
  const elapsedMs = (binding.baseElapsedMs ?? 0) + (activity.elapsedMs ?? 0);
  const completedUnitCount = (binding.baseCompletedUnitCount ?? 0) + (activity.completedUnitCount ?? 0);
  const completed = activity.status === 'ended' && completedUnitCount > 0
    && (activity.endReason === 'complete' || elapsedMs >= (binding.totalPlannedMs ?? binding.plannedMs));
  return { ...(prior?.readingChoice ? { readingChoice: prior.readingChoice } : {}),
    activityId: activity.id, status: completed ? 'completed' : activity.status === 'reading' ? 'running'
    : activity.status === 'ended' ? 'ended' : 'paused', startedAt: activity.startedAt,
    ...(activity.endedAt === undefined ? {} : { endedAt: activity.endedAt }), updatedAt: activity.updatedAt,
    elapsedMs, completedUnitCount, planRevision: binding.planRevision ?? 0, activityPlanRevision: binding.planRevision ?? 0,
    totalPlannedMs: binding.totalPlannedMs ?? binding.plannedMs, completionId: binding.completionId ?? activity.id,
    estimatedEndAt: activity.status === 'reading' && activity.remainingMs !== null
      ? activity.checkpointAt + activity.remainingMs : null,
    ...(binding.occurrenceId ? { originOccurrenceId: binding.occurrenceId } : {}) };
}

/** The activity and existing habit log keep the identity across a partial cross-store save. */
export async function persistOwnReadingExecution(book: ReadingBook) {
  const activity = book.iReading?.activity;
  if (!activity?.schedule) return;
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return;
  await runBackupRestoreDataEpochCommit(epoch, async () => {
    const item = await loadScheduleItemById(activity.schedule!.itemId);
    if (!item || item.owner !== 'I' || item.status === 'cancelled' || item.execution?.adjustment?.pending || item.execution?.durationChange?.pending
      || (item.execution?.planRevision ?? 0) !== (activity.schedule!.planRevision ?? 0)) return;
    // The A segment remains historical after B starts; only the current shared segment may settle this slot.
    const allBooks = activity.schedule!.choiceSourceId ? await loadReadingLibraryStrict() : [];
    if (allBooks.some(other => other.id !== book.id && other.iReading?.activity?.schedule?.previousActivityId === activity.id)) return;
    const execution = { ...executionOf(activity), ...(item.execution?.readingChoice ? { readingChoice: item.execution.readingChoice } : {}),
      ...(item.execution?.startedAt !== undefined ? { startedAt: Math.min(item.execution.startedAt, activity.startedAt) } : {}),
      ...(item.execution?.durationChange ? { durationChange: item.execution.durationChange } : {}),
      resumeUnscheduled: activity.status === 'paused' };
    if (item.execution?.activityId && item.execution.activityId !== activity.id
      && item.execution.activityId !== activity.schedule!.previousActivityId
      && (item.execution.activityPlanRevision ?? 0) >= (activity.schedule!.planRevision ?? 0)) return;
    if (item.execution && (item.execution.updatedAt > execution.updatedAt
      || (item.execution.completedUnitCount ?? 0) > (execution.completedUnitCount ?? 0)
      || item.execution.status === 'completed' && execution.status !== 'completed')) return;
    if (JSON.stringify(item.execution) !== JSON.stringify(execution)) await saveScheduleExecution(item.id, execution, item.updatedAt);
    if (execution.status !== 'completed') return;
    if (activity.schedule!.habitId) await recordHabitActivityCompletion(activity.schedule!.habitId, execution.completionId!,
      activity.endedAt ?? activity.updatedAt);
    const occurrenceId = activity.schedule!.occurrenceId ?? `${item.id}:${item.startAt}`;
    if (item.status === 'pending' && occurrenceId === `${item.id}:${item.startAt}`)
      await applyOccurrenceCompletionReceipt(occurrenceId, activity.endedAt ?? activity.updatedAt);
  });
}

async function readyItem(item: ScheduleItem, now: number, books: ReadingBook[]) {
  const execution = item.execution;
  if (execution?.adjustment?.readingReplacement) return null; // Applied through the saved current-slot operation below.
  const canResume = execution?.adjustment?.action === 'reschedule' && !execution.adjustment.pending
    && (execution.activityPlanRevision ?? 0) < (execution.planRevision ?? 0)
    && (execution.elapsedMs ?? 0) < (execution.totalPlannedMs ?? 0);
  if (item.owner !== 'I' || item.status !== 'pending' || execution && execution.status !== 'planned' && !canResume || !item.readingId
    || item.recurrence !== 'none' || item.startAt > now || !item.endAt || item.endAt <= now) return null;
  const selected = item.execution?.readingChoice ? await (await import('./ownedDayPlanStore')).loadOwnReadingChoice(item) : null;
  let book = books.find(book => book.id === (item.execution?.readingChoice ? selected?.choice.currentReadingId : item.readingId));
  if (book?.iReading?.reachedEnd && selected?.choice.nextReadingId) book = books.find(book => book.id === selected.choice.nextReadingId);
  // A continuation never downloads an unexpectedly unavailable B in place of reading it.
  if (book && selected && book.id !== item.readingId
    && !(await (await import('./ownReadingSelectionMaterial')).ownReadingAvailability([book]))[book.id].ready) return null;
  return book?.iReading && !book.iReading.needsSourceConfirmation && !book.iReading.reachedEnd ? book : null;
}

/** Finish only the old execution segment; never credit its result to a newly saved occurrence. */
export async function reconcileOwnScheduleAdjustments(now = Date.now()): Promise<void> {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return;
  const items = await loadOwnScheduleAdjustments();
  for (const item of items) {
    const prior = item.execution!;
    if (prior.durationChange?.pending && prior.status !== 'planned') {
      const change = prior.durationChange;
      if ((change.applyAttempts ?? 0) >= 4) continue;
      const counted = { ...change, applyAttempts: (change.applyAttempts ?? 0) + 1 };
      const prepared = await runBackupRestoreDataEpochCommit(epoch, () => saveScheduleExecution(item.id,
        { ...prior, durationChange: counted }, item.updatedAt));
      if (!prepared.committed) return;
      const result = await resizeScheduledReadingActivity({ itemId: item.id, activityId: prior.activityId,
        ...change, planRevision: prior.planRevision ?? 0, sourceUpdatedAt: item.updatedAt, windowEndAt: item.endAt ?? item.startAt, now });
      if (!result.ok) continue;
      await runBackupRestoreDataEpochCommit(epoch, async () => {
        const latest = await loadScheduleItemById(item.id);
        if (!latest?.execution || latest.execution.status === 'planned' || latest.execution.planRevision !== prior.planRevision
          || latest.execution.durationChange?.operationId !== change.operationId) return;
        const progress = result.activity ? executionOf(result.activity, latest.execution) : latest.execution;
        await saveScheduleExecution(item.id, { ...progress,
          ...(latest.execution.resumeUnscheduled ? { resumeUnscheduled: true as const } : {}),
          durationChange: { ...counted, pending: false } }, latest.updatedAt);
      });
      continue;
    }
    const adjustment = prior.adjustment;
    if (!adjustment?.pending) continue;
    if (prior.status === 'planned') continue;
    if ((adjustment.cleanupAttempts ?? 0) >= 4) continue;
    const counted = { ...adjustment, cleanupAttempts: (adjustment.cleanupAttempts ?? 0) + 1 };
    const prepared = await runBackupRestoreDataEpochCommit(epoch, () => saveScheduleExecution(item.id,
      { ...prior, updatedAt: Math.max(now, prior.updatedAt), adjustment: counted }, item.updatedAt));
    if (!prepared.committed) return;
    const result = await finishScheduledReadingActivity({ itemId: item.id, activityId: prior.activityId,
      operationId: adjustment.operationId, now: Math.min(now, adjustment.changedAt), keepFocusBinding: adjustment.readingReplacement });
    if (!result.ok) continue;
    await runBackupRestoreDataEpochCommit(epoch, async () => {
      const latest = await loadScheduleItemById(item.id);
      if (!latest?.execution || latest.execution.status === 'planned' || latest.execution.planRevision !== prior.planRevision
        || latest.execution.adjustment?.operationId !== adjustment.operationId || !latest.execution.adjustment.pending) return;
      const a = result.activity;
      const progress = a && a.id === prior.activityId && a.schedule?.itemId === item.id ? executionOf(a) : null;
      await saveScheduleExecution(item.id, { ...latest.execution, status: 'ended',
        elapsedMs: Math.max(prior.elapsedMs ?? 0, progress?.elapsedMs ?? 0),
        completedUnitCount: Math.max(prior.completedUnitCount ?? 0, progress?.completedUnitCount ?? 0),
        endedAt: a?.endedAt ?? adjustment.changedAt, updatedAt: Math.max(now, prior.updatedAt),
        adjustment: { ...counted, pending: false } }, latest.updatedAt);
    });
  }
}

async function startItem(item: ScheduleItem, now: number, epoch: number) {
  const selection = await resolveOwnReadingStart(item);
  if (!selection) return;
  item = selection.item;
  const selectedBook = (await loadReadingLibraryStrict()).find(book => book.id === selection.bookId);
  if (!selectedBook || selectedBook.programme?.preparation === 'ready' || !selectedBook.programme) {
    if (!selectedBook || !(await (await import('./ownReadingSelectionMaterial')).ownReadingAvailability([selectedBook], true))[selectedBook.id].ready) return;
  }
  const prior = item.execution, revision = prior?.planRevision ?? 0;
  const totalPlannedMs = prior?.totalPlannedMs ?? item.endAt! - item.startAt;
  const baseElapsedMs = prior?.elapsedMs ?? 0;
  const operationId = revision ? `schedule:${item.id}:r${revision}` : `schedule:${item.id}`;
  const binding = { itemId: item.id, sourceUpdatedAt: item.updatedAt, windowEndAt: item.endAt!,
    plannedMs: Math.max(0, totalPlannedMs - baseElapsedMs), totalPlannedMs, baseElapsedMs,
    baseCompletedUnitCount: prior?.completedUnitCount ?? 0, planRevision: revision,
    ...(selection.sourceId ? { choiceSourceId: selection.sourceId, choiceVersion: selection.version } : {}),
    completionId: prior?.completionId ?? operationId, occurrenceId: `${item.id}:${item.startAt}`,
    ...(item.habitId ? { habitId: item.habitId } : {}) };
  const result = await controlReadingActivity({ action: 'start', bookId: selection.bookId,
    minutes: binding.plannedMs / 60_000, operationId, expectedActivityId: null, now, schedule: binding,
    beforeStart: async () => {
      const latest = await loadScheduleItemById(item.id);
      const at = Math.max(now, Date.now());
      const host = await readingHostState(at);
      return canCommitBackupRestoreDataEpoch(epoch) && !!latest && latest.updatedAt === item.updatedAt
        && latest.owner === 'I' && latest.status === 'pending' && !latest.execution?.adjustment?.pending
        && (latest.execution?.planRevision ?? 0) === revision && Math.max(at, Date.now()) < latest.endAt!
        && !host.sleeping && (!host.focus || host.focus.ended);
    } });
  if (result.ok) {
    const book = (await loadReadingLibraryStrict()).find(book => book.id === selection.bookId);
    if (book) await persistOwnReadingExecution(book);
  }
}

/** One local check; the existing life/native coordinator owns every wake. */
export async function runOwnScheduleExecution(now = Date.now()): Promise<void> {
  if (Platform.OS !== 'android') return;
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return;
  await (await import('./ownScheduleSave')).resumeOwnScheduleSaves(epoch);
  await (await import('./userRoutineStore')).resumeUserRoutineSaves(epoch);
  await reconcileOwnScheduleAdjustments(now);
  const items = await loadOwnedScheduleItems(now - 24 * 60 * 60_000, now + 1);
  for (const item of items) if (item.execution?.adjustment?.readingReplacement) await reconcileOwnReadingReplacement(item, now);
  const host = await readingHostState(now);
  await settleReadingActivity({ now, ...host });
  for (const book of await loadReadingLibraryStrict()) if (book.iReading?.reachedEnd && book.iReading.activity?.schedule?.choiceSourceId) {
    await reconcileOwnReadingContinuation(book.id, now);
  }
  const books = await loadReadingLibraryStrict();
  for (const book of books) await persistOwnReadingExecution(book);
  if (!canCommitBackupRestoreDataEpoch(epoch) || host.sleeping || (host.focus && !host.focus.ended)
    || books.some(book => book.iReading?.activity && book.iReading.activity.status !== 'ended')) return;
  for (const item of items) {
    const book = await readyItem(item, now, books);
    if (!book) continue;
    if (book.programme && book.programme.preparation !== 'ready') {
      if (book.programme.preparation === 'missing') {
        // The programme store persists failure and owns deduplication; this never retries it.
        void prepareProgramme(book.id).then(async () => {
          if (!canCommitBackupRestoreDataEpoch(epoch)) return;
          const at = Date.now();
          const current = await loadScheduleItemById(item.id);
          if (!current || current.updatedAt !== item.updatedAt || at >= item.endAt!) return;
          const prepared = (await loadReadingLibraryStrict()).find(value => value.id === book.id);
          if (prepared?.programme?.preparation !== 'ready') return;
          await startItem(item, at, epoch);
        }).catch(() => undefined);
      }
      return;
    }
    await startItem(item, now, epoch);
    return;
  }
}

export async function getOwnScheduleWakeAt(now = Date.now()): Promise<number | null> {
  if (Platform.OS !== 'android') return null;
  const [host, books, items] = await Promise.all([readingHostState(now), loadReadingLibraryStrict(),
    loadOwnedScheduleItems(now - 24 * 60 * 60_000, now + 90 * 24 * 60 * 60_000)]);
  if (host.sleeping || (host.focus && !host.focus.ended)
    || books.some(book => book.iReading?.activity && book.iReading.activity.status !== 'ended')) return null;
  const starts = (await Promise.all(items.map(async item => {
    const at = Math.max(now + 1000, item.startAt);
    const book = await readyItem(item, at, books);
    return book && (!book.programme || ['missing', 'ready'].includes(book.programme.preparation)) ? [at] : [];
  }))).flat();
  return starts.length ? Math.min(...starts) : null;
}
