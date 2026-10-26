import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { loadReadingChapter, loadReadingLibraryStrict, runReadingStoreExclusive, saveReadingLibrary } from '../reading/readingStore';
import { settleReadingClock } from '../reading/readingDailyPolicy';
import type { DailyReadingActivity, ReadingBook } from '../reading/readingTypes';
import { readingHostState } from '../life/readingActivityRuntime';
import { loadOwnReadingChoice } from './ownedDayPlanStore';
import { loadScheduleItemById, saveScheduleExecution, type ScheduleItem } from './scheduleStore';
import { ownReadingAvailability } from './ownReadingSelectionMaterial';

/** Resolve the saved shared cursor at actual start, never from the original title/book cache. */
export async function resolveOwnReadingStart(item: ScheduleItem): Promise<{ item: ScheduleItem; bookId: string; version?: number; sourceId?: string } | null> {
  if (!item.execution?.readingChoice) return item.readingId ? { item, bookId: item.readingId } : null;
  let source = await loadOwnReadingChoice(item);
  if (!source) return null;
  let books = await loadReadingLibraryStrict();
  for (let remainingChoices = 2; remainingChoices > 0 && source?.choice.currentReadingId; remainingChoices -= 1) {
    let current = books.find(book => book.id === source!.choice.currentReadingId);
    if (current?.iReading && (!current.iReading.activity || current.iReading.activity.status === 'ended')) {
      // Manual co-reading results use the same segment store, before creating any new activity.
      current = await (await import('../reading/readingDailyRuntime')).advanceSavedSegments(current.id, Date.now()) ?? undefined;
    }
    if (!current?.iReading?.reachedEnd) break;
    const epoch = captureBackupRestoreDataEpoch();
    if (epoch === null || !source.root.execution) return null;
    const moved = await runBackupRestoreDataEpochCommit(epoch, async () => {
      const root = await loadScheduleItemById(source!.root.id);
      const choice = root?.execution?.readingChoice;
      if (!root?.execution || !choice || !('version' in choice) || choice.version !== source!.choice.version) return false;
      await saveScheduleExecution(root.id, { ...root.execution, readingChoice: { ...choice,
        version: choice.version + 1, currentReadingId: choice.nextReadingId, nextReadingId: null,
        operationId: `reading-start:${item.id}:${choice.version}` } }, root.updatedAt);
      return true;
    });
    if (!moved.committed || !moved.value) return null;
    const latest = await loadScheduleItemById(item.id);
    if (!latest) return null;
    item = latest;
    source = await loadOwnReadingChoice(item);
    books = await loadReadingLibraryStrict();
  }
  if (!source?.choice.currentReadingId) return null;
  return { item, bookId: source.choice.currentReadingId, sourceId: source.root.id, version: source.choice.version };
}

/** Uses the existing local check and the existing two stores; no request or new wake is created. */
export async function reconcileOwnReadingContinuation(bookId: string, now: number): Promise<void> {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return;
  const host = await readingHostState(now);
  if (host.sleeping || host.focus?.paused || host.focus?.ended) return;
  let switched: { before: string; after: string } | undefined;
  await runReadingStoreExclusive(() => runBackupRestoreDataEpochCommit(epoch, async () => {
    const books = await loadReadingLibraryStrict();
    const source = books.find(book => book.id === bookId);
    const original = source?.iReading?.activity;
    if (!source?.iReading?.reachedEnd || !original?.schedule?.choiceSourceId || original.status !== 'reading') return;
    if (original.focusId && host.focus?.sessionId !== original.focusId) return;
    const last = await loadReadingChapter(source.id, source.totalChapters - 1);
    const finalResult = last?.segmentsMeta.at(-1);
    if (!finalResult || finalResult.status !== 'done' || finalResult.resultActivityId !== undefined && finalResult.resultActivityId !== original.id) return;
    const item = await loadScheduleItemById(original.schedule.itemId);
    if (!item || item.owner !== 'I' || item.status !== 'pending' || item.execution?.adjustment?.pending || item.execution?.durationChange?.pending
      || (item.execution?.planRevision ?? 0) !== (original.schedule.planRevision ?? 0)
      || item.execution?.activityId && item.execution.activityId !== original.id) return;
    const resolved = await loadOwnReadingChoice(item);
    if (!resolved?.root.execution) return;
    const operationId = `reading-next:${original.id}`;
    const recovered = resolved.choice.operationId === operationId;
    // A future slot may change the shared choice without interrupting this A segment.
    // A can finish, but must not consume that future choice immediately.
    const choiceChanged = !recovered && resolved.choice.currentReadingId !== source.id;
    const state = settleReadingClock(source.iReading, now, host.focus).state;
    const activity = state.activity!;
    if (activity.status !== 'reading' || activity.remainingMs === null || activity.remainingMs <= 0) return;
    const nextId = choiceChanged ? null : recovered ? resolved.choice.currentReadingId : resolved.choice.nextReadingId;
    const next = books.find(book => book.id === nextId);
    const available = next ? (await ownReadingAvailability([next], true))[next.id].ready : false;
    const version = recovered ? resolved.choice.version : resolved.choice.version + 1;
    const latestHost = await readingHostState(now);
    if (latestHost.sleeping || original.focusId && (latestHost.focus?.sessionId !== original.focusId
      || latestHost.focus.paused || latestHost.focus.ended)) return;
    // Persist the cursor first. Its operation identity allows a lost acknowledgement to finish
    // from the same A activity, with its actual remaining time, after a process restart.
    if (!recovered && !choiceChanged) {
      await saveScheduleExecution(resolved.root.id, { ...resolved.root.execution, readingChoice: { ...resolved.choice,
        currentReadingId: nextId, nextReadingId: null, version, operationId } }, resolved.root.updatedAt);
    }
    if (!canCommitBackupRestoreDataEpoch(epoch)) return;
    const ended: ReadingBook = { ...source, iReading: { ...state, updatedAt: Math.max(now, state.updatedAt + 1),
      activity: { ...activity, status: 'ended', endedAt: now, updatedAt: now,
        endReason: nextId && !available ? 'manual' : 'complete', remainingMs: 0 },
      events: [...state.events, { id: `${operationId}:end`, at: now, change: '本次活动结束' as const }].slice(-8) } };
    if (!next?.iReading || !available || next.id === source.id) {
      await saveReadingLibrary(books.map(book => book.id === source.id ? ended : book));
      return;
    }
    if (books.some(book => book.id !== source.id && book.iReading?.activity && book.iReading.activity.status !== 'ended')) return;
    const binding = activity.schedule!;
    const nextActivity: DailyReadingActivity = {
      id: `${original.id}:next`, operationId: `${original.id}:next`, status: 'reading',
      startedAt: now, checkpointAt: now, updatedAt: now, elapsedMs: 0, completedUnitCount: 0,
      plannedMs: activity.remainingMs, remainingMs: activity.remainingMs,
      ...(activity.focusId ? { focusId: activity.focusId, focusWorkMs: host.focus!.effectiveWorkMs, jointOnly: activity.jointOnly } : {}),
      schedule: { ...binding, choiceVersion: version, previousActivityId: original.id,
        plannedMs: activity.remainingMs, baseElapsedMs: (binding.baseElapsedMs ?? 0) + (activity.elapsedMs ?? 0),
        baseCompletedUnitCount: (binding.baseCompletedUnitCount ?? 0) + (activity.completedUnitCount ?? 0) },
    };
    const continued: ReadingBook = { ...next, iReading: { ...next.iReading, activity: nextActivity,
      updatedAt: Math.max(now, next.iReading.updatedAt + 1),
      events: [...next.iReading.events, { id: nextActivity.id, at: now, change: '开始' as const }].slice(-8) } };
    await saveReadingLibrary(books.map(book => book.id === source.id ? ended : book.id === next.id ? continued : book));
    switched = { before: original.id, after: nextActivity.id };
  }));
  if (switched) await (await import('../focus/focusReadingRuntime')).reconcileScheduledFocusReadingSwitch(now);
}

/** Complete a saved current-content replacement; it is not a new schedule or a resume decision. */
export async function reconcileOwnReadingReplacement(item: ScheduleItem, now: number): Promise<void> {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null || !item.execution?.adjustment?.readingReplacement) return;
  const host = await readingHostState(now);
  if (host.sleeping) return;
  let switched = false;
  await runReadingStoreExclusive(() => runBackupRestoreDataEpochCommit(epoch, async () => {
    const latest = await loadScheduleItemById(item.id);
    const execution = latest?.execution, adjustment = execution?.adjustment;
    if (!latest || latest.owner !== 'I' || latest.status !== 'pending' || !execution || execution.status !== 'ended'
      || !adjustment?.readingReplacement || adjustment.pending || (adjustment.cleanupAttempts ?? 0) >= 4
      || (execution.activityPlanRevision ?? 0) >= (execution.planRevision ?? 0)) return;
    const books = await loadReadingLibraryStrict();
    if (books.some(book => book.iReading?.activity && book.iReading.activity.status !== 'ended')) return;
    const old = books.find(book => book.iReading?.activity?.id === execution.activityId);
    const previous = old?.iReading?.activity;
    const resolved = await loadOwnReadingChoice(latest);
    const next = books.find(book => book.id === resolved?.choice.currentReadingId);
    const remainingMs = (execution.totalPlannedMs ?? 0) - (execution.elapsedMs ?? 0);
    if (!previous?.schedule || !next?.iReading || !resolved || remainingMs <= 0
      || !(await ownReadingAvailability([next], true))[next.id].ready) return;
    const latestHost = await readingHostState(now);
    if (latestHost.sleeping) return;
    const focus = previous.focusId && latestHost.focus?.sessionId === previous.focusId && !latestHost.focus.ended ? latestHost.focus : undefined;
    if (previous.focusId && !focus || latestHost.focus && !latestHost.focus.ended && !focus) return;
    await saveScheduleExecution(latest.id, { ...execution,
      adjustment: { ...adjustment, cleanupAttempts: (adjustment.cleanupAttempts ?? 0) + 1 } }, latest.updatedAt);
    const paused = execution.resumeUnscheduled || focus?.paused;
    const id = `${adjustment.operationId}:reading`;
    const activity: DailyReadingActivity = { id, operationId: id, status: paused ? 'paused' : 'reading',
      plannedMs: remainingMs, remainingMs, startedAt: now, checkpointAt: now, updatedAt: now, elapsedMs: 0, completedUnitCount: 0,
      ...(focus ? { focusId: previous.focusId, focusWorkMs: focus.effectiveWorkMs, jointOnly: previous.jointOnly } : {}),
      schedule: { ...previous.schedule, sourceUpdatedAt: latest.updatedAt, windowEndAt: latest.endAt ?? now,
        planRevision: execution.planRevision, plannedMs: remainingMs, totalPlannedMs: execution.totalPlannedMs,
        baseElapsedMs: execution.elapsedMs ?? 0, baseCompletedUnitCount: execution.completedUnitCount ?? 0,
        choiceSourceId: resolved.root.id, choiceVersion: resolved.choice.version, previousActivityId: previous.id } };
    await saveReadingLibrary(books.map(book => book.id === next.id ? { ...book, iReading: { ...next.iReading!, activity,
      updatedAt: Math.max(now, next.iReading!.updatedAt + 1), events: [...next.iReading!.events,
        { id, at: now, change: paused ? '暂停' as const : '开始' as const }].slice(-8) } } : book));
    switched = true;
  }));
  if (switched) await (await import('../focus/focusReadingRuntime')).reconcileScheduledFocusReadingSwitch(now);
}
