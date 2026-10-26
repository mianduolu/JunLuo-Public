import { loadReadingLibraryStrict } from '../reading/readingStore';
import { readSleepSchedule } from '../life/sleepPlanStore';
import { findReadingSleepBoundary } from '../life/readingSleepBoundary';
import {
  bindReadingActivityToFocus,
  buildDailyReadingCurrentMaterial,
  buildDailyReadingFocusMaterial,
  continueReadingActivityForFocus,
  loadCurrentReadingActivity,
  settleReadingActivity,
  startReadingActivityForFocus,
} from '../reading/readingDailyRuntime';
import { makeFocusSessionId } from './focusIdentity';
import { buildFocusReadingCatalog, selectFocusReadingCatalogBooks, type FocusNextActivityChoice } from './focusGenerationPolicy';
import { finishFocusReadingBinding, focusReadingSwitchLabel, focusReadingWorkTargetAt, projectFocusReadingClock } from './focusReadingPolicy';
import { loadActiveFocusSession, loadRecentFocusSessions, loadFocusLogs, updateActiveFocusReadingState, type ActiveFocusSession, type FocusSession, type PendingFocusInvite } from './focusStore';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';

export async function loadFocusReadingContext(now = Date.now()) {
  const [current, library, currentPaper, backgroundPaper] = await Promise.all([
    loadCurrentReadingActivity(now), loadReadingLibraryStrict(),
    buildDailyReadingCurrentMaterial(now), buildDailyReadingFocusMaterial(now),
  ]);
  const books = selectFocusReadingCatalogBooks(library.filter(book => book.iReading && !book.iReading.needsSourceConfirmation && !book.iReading.reachedEnd));
  return { current: current?.status === 'ended' ? null : current,
    books, currentPaper, backgroundPaper: backgroundPaper || currentPaper, catalogPaper: buildFocusReadingCatalog(books) };
}

/** Called after duration selection, before the existing opening request. No extra model call. */
export async function bindFocusReadingSession(session: ActiveFocusSession, invite?: Pick<PendingFocusInvite, 'readingId' | 'readingActivityId'>, now = Date.now()) {
  const sessionId = makeFocusSessionId(session);
  const clock = projectFocusReadingClock(session, now);
  const current = await loadCurrentReadingActivity(now);
  if ((current || invite?.readingId) && (await readSleepSchedule(now))?.actualPhase === 'sleeping') {
    throw new Error('当前正在睡眠，本次阅读未开始或继续。');
  }
  if (current && current.status !== 'ended') {
    if (!['reading', 'preparing'].includes(current.status) || (invite?.readingActivityId && invite.readingActivityId !== current.activityId)) {
      throw new Error('当前阅读活动已变化，本次操作未执行。');
    }
    const result = await bindReadingActivityToFocus({ activityId: current.activityId, sessionId,
      effectiveWorkMs: clock.effectiveWorkMs, now });
    if (!result.ok) throw new Error(result.reason ?? '阅读安排未保存成功。');
    return { ...session, baiyunActivity: `读《${current.title}》`, reading: { version: 1 as const,
      bookId: current.bookId, sourceActivityId: current.activityId,
      sourceOperationId: current.operationId,
      originalRemainingMs: current.remainingMs, boundWorkMs: clock.effectiveWorkMs } };
  }
  if (invite?.readingActivityId) throw new Error('当前阅读活动已变化，本次操作未执行。');
  if (!invite?.readingId) return session;
  const result = await startReadingActivityForFocus({ bookId: invite.readingId, sessionId,
    remainingMs: clock.totalWorkMs, effectiveWorkMs: clock.effectiveWorkMs,
    operationId: `${sessionId}:reading:start`, now });
  if (!result.ok || !result.activity) throw new Error(result.reason ?? '阅读安排未保存成功。');
  return { ...session, baiyunActivity: `读《${result.activity.title}》`, reading: { version: 1 as const,
    bookId: result.activity.bookId, sourceActivityId: result.activity.activityId,
    sourceOperationId: result.activity.operationId,
    originalRemainingMs: null, boundWorkMs: clock.effectiveWorkMs } };
}

export function focusReadingOpeningActivity(session: ActiveFocusSession) {
  const binding = session.reading;
  if (!binding || binding.originalRemainingMs === null || binding.originalRemainingMs <= 0) return undefined;
  const totalMs = projectFocusReadingClock(session, session.startedAt).totalWorkMs;
  if (totalMs !== null && totalMs <= binding.originalRemainingMs) return undefined;
  return { remainingActivityMinutes: binding.originalRemainingMs / 60_000,
    focusMinutes: totalMs === null ? null : totalMs / 60_000 };
}

/** A retry describes the current work clock, never the opening's old remaining time. */
export function focusReadingRetryOpeningActivity(session: ActiveFocusSession, now = Date.now()) {
  const binding = session.reading;
  if (!binding || binding.originalRemainingMs === null || binding.originalRemainingMs <= 0
    || binding.choice || binding.transition || binding.endedAt !== undefined) return undefined;
  const clock = projectFocusReadingClock(session, now);
  const remainingMs = binding.originalRemainingMs - Math.max(0, clock.effectiveWorkMs - binding.boundWorkMs);
  if (remainingMs <= 0 || clock.completed
    || (clock.totalWorkMs !== null && clock.totalWorkMs <= clock.effectiveWorkMs + remainingMs)) return undefined;
  return { remainingActivityMinutes: remainingMs / 60_000,
    focusMinutes: clock.totalWorkMs === null ? null : clock.totalWorkMs / 60_000,
    elapsedWorkMinutes: clock.effectiveWorkMs / 60_000 };
}

export async function saveFocusNextActivityChoice(sessionId: string, sourceActivityId: string, choice: FocusNextActivityChoice,
  now = Date.now(), dataEpoch = captureBackupRestoreDataEpoch(), canSave?: (session: ActiveFocusSession) => boolean) {
  return updateActiveFocusReadingState(sessionId, session => {
    if (!session.reading || session.reading.sourceActivityId !== sourceActivityId
      || session.reading.transition || session.reading.endedAt || session.reading.choice
      || (canSave && !canSave(session))) return session;
    return { ...session, reading: { ...session.reading, choice: { ...choice, savedAt: now } } };
  }, dataEpoch);
}

/** A failed initial focus save must not leave an independent activity attached to a missing timer. */
export async function recoverFailedFocusReadingStart(session: ActiveFocusSession, now = Date.now()) {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return null;
  const current = await loadActiveFocusSession(true);
  const sessionId = makeFocusSessionId(session);
  if (current && makeFocusSessionId(current) === sessionId) return current;
  const reading = await loadCurrentReadingActivity(now);
  if (reading?.focusId === sessionId && canCommitBackupRestoreDataEpoch(epoch)) {
    await settleReadingActivity({ now, focus: { sessionId, effectiveWorkMs: reading.focusWorkMs ?? 0,
      paused: true, ended: true } });
  }
  return null;
}

let reconcileTail: Promise<unknown> = Promise.resolve();

/** A content switch inside the scheduled duration is not the opening paper's later choice. */
export async function reconcileScheduledFocusReadingSwitch(now = Date.now()) {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return;
  const current = await loadActiveFocusSession(true);
  if (!current?.reading || current.reading.endedAt || current.reading.transition) return;
  const sessionId = makeFocusSessionId(current);
  const book = (await loadReadingLibraryStrict()).find(book => book.iReading?.activity?.focusId === sessionId
    && book.iReading.activity.schedule?.previousActivityId === current.reading!.sourceActivityId);
  const activity = book?.iReading?.activity;
  if (!book || !activity || activity.status === 'ended') return;
  await updateActiveFocusReadingState(sessionId, latest => {
      if (!latest.reading || latest.reading.endedAt || latest.reading.transition
        || latest.reading.sourceActivityId !== activity.schedule?.previousActivityId) return latest;
    const title = `读《${book.title}》`, logId = `${activity.id}:system`;
    return { ...latest, baiyunActivity: title,
      reading: { ...latest.reading, bookId: book.id, sourceActivityId: activity.id, sourceOperationId: activity.operationId },
      logs: latest.logs.some(log => log.id === logId) ? latest.logs : [...latest.logs,
        { id: logId, role: 'system', content: focusReadingSwitchLabel(title), createdAt: activity.startedAt,
          elapsedSeconds: Math.floor(projectFocusReadingClock(latest, activity.startedAt).effectiveWorkMs / 1000), trigger: 'activity-switch-reading' }] };
  }, epoch);
}
/** Also used by a saved schedule cancellation/reschedule. No model request or timer change. */
export async function finishFocusReadingActivity(activityId: string, now = Date.now(), dataEpoch = captureBackupRestoreDataEpoch()) {
  const current = await loadActiveFocusSession(true);
  if (!current?.reading || current.reading.endedAt !== undefined) return current;
  const reading = await loadCurrentReadingActivity(now);
  const sleeping = (await readSleepSchedule(now))?.actualPhase === 'sleeping';
  return updateActiveFocusReadingState(makeFocusSessionId(current), latest =>
    finishFocusReadingBinding(latest, activityId, now, !sleeping && (!reading || reading.activityId === activityId)), dataEpoch);
}

export function reconcileFocusReadingSession(session?: ActiveFocusSession, now = Date.now(), ended = false,
  completion?: { session: FocusSession; dataEpoch: number }): Promise<ActiveFocusSession | null> {
  const work = reconcileTail.then(async () => {
    if (completion && !canCommitBackupRestoreDataEpoch(completion.dataEpoch)) return null;
    await reconcileScheduledFocusReadingSwitch(now);
    const epoch = captureBackupRestoreDataEpoch();
    if (epoch === null) return session ?? null;
    const stored = await loadActiveFocusSession(true);
    if (completion && (!ended || !session || completion.session.id !== makeFocusSessionId(session)
      || completion.dataEpoch !== epoch || !canCommitBackupRestoreDataEpoch(epoch))) return stored;
    const current = stored ?? (completion && session ? session : null);
    if (!current || (session && makeFocusSessionId(current) !== makeFocusSessionId(session))) return current;
    const binding = current.reading;
    if (!binding || binding.endedAt) return current;
    const sessionId = makeFocusSessionId(current);
    const clock = projectFocusReadingClock(current, now);
    const isEnded = ended || clock.completed;
    const sleepingAt = await findReadingSleepBoundary(now);
    const completedAt = clock.completed ? focusReadingEndAt(current) : undefined;
    const settledAt = Math.min(now, sleepingAt ?? Infinity, completedAt ?? Infinity);
    const readingClock = projectFocusReadingClock(current, settledAt);
    const projection = { sessionId, effectiveWorkMs: readingClock.effectiveWorkMs,
      paused: current.paused || clock.inBreak, ended: isEnded,
      remainingWorkMs: clock.totalWorkMs === null ? null : Math.max(0, clock.totalWorkMs - clock.effectiveWorkMs) };
    const sleeping = sleepingAt !== undefined || (await readSleepSchedule(now))?.actualPhase === 'sleeping';
    await settleReadingActivity({ now: settledAt, focus: projection, sleeping, sleepingAt });
    if (!canCommitBackupRestoreDataEpoch(epoch)) return current;
    if (isEnded) {
      return updateActiveFocusReadingState(sessionId, latest => ({ ...latest,
        reading: latest.reading ? { ...latest.reading, endedAt: completedAt ?? now } : undefined }), epoch);
    }
    const boundActivityId = binding.transition?.readingActivityId ?? binding.sourceActivityId;
    const boundBook = (await loadReadingLibraryStrict()).find(book => book.iReading?.activity?.id === boundActivityId);
    const boundActivity = boundBook?.iReading?.activity;
    if (boundActivity?.status === 'ended'
      && (boundActivity.endReason !== 'duration' || !!binding.transition || !binding.choice)) {
      return finishFocusReadingActivity(boundActivity.id, boundActivity.endedAt ?? now, epoch);
    }
    const sameScheduledActivity = boundActivity?.schedule && boundActivity.id === binding.sourceActivityId
      && boundActivity.operationId === binding.sourceOperationId;
    const dueWork = sameScheduledActivity && boundActivity.remainingMs !== null && boundActivity.focusWorkMs !== undefined
      ? boundActivity.status === 'ended' && boundActivity.endReason === 'duration' && boundActivity.endedAt !== undefined
        ? projectFocusReadingClock(current, boundActivity.endedAt).effectiveWorkMs
        : boundActivity.focusWorkMs + boundActivity.remainingMs
      : binding.boundWorkMs + (binding.originalRemainingMs ?? Infinity);
    if (sleeping || projection.paused || binding.transition || !binding.choice || clock.effectiveWorkMs < dueWork) return current;
    const operationId = `${sessionId}:reading:next`;
    const books = await loadReadingLibraryStrict();
    const source = books.find(book => book.id === binding.bookId);
    const applied = books.find(book => book.iReading?.activity?.operationId === operationId);
    const schedule = source?.iReading?.activity?.schedule;
    if (!applied && schedule && !await (await import('../schedule/ownScheduleExecution'))
      .isOwnScheduledReadingRequestAllowed(schedule, binding.sourceActivityId)) return current;
    if (!applied && (!source?.iReading || source.iReading.activity?.id !== binding.sourceActivityId
      || source.iReading.activity.operationId !== binding.sourceOperationId || source.iReading.reachedEnd
      || source.iReading.activity.status === 'paused')) return current;
    const stillSame = await loadCurrentReadingActivity(now);
    if (stillSame && stillSame.activityId !== binding.sourceActivityId && stillSame.operationId !== operationId) return current;
    // A delayed callback starts now, not at a fictional past boundary.
    const startedWorkMs = applied?.iReading?.activity?.focusWorkMs ?? clock.effectiveWorkMs;
    const remainingMs = clock.totalWorkMs === null ? null : Math.max(0, clock.totalWorkMs - startedWorkMs);
    if (remainingMs === 0) return current;
    const choice = binding.choice;
    const result = choice.next === 'continue'
      ? await continueReadingActivityForFocus({ activityId: binding.sourceActivityId, sessionId,
        remainingMs, effectiveWorkMs: startedWorkMs, operationId, now })
      : choice.readingId ? await startReadingActivityForFocus({ bookId: choice.readingId, sessionId,
        remainingMs, effectiveWorkMs: startedWorkMs, operationId, now }) : { ok: true, activity: undefined };
    if (!result.ok || !canCommitBackupRestoreDataEpoch(epoch)) return current;
    const activity = choice.next === 'continue' ? current.baiyunActivity
      : result.activity ? `读《${result.activity.title}》` : choice.nextActivity!;
    const actualAt = applied?.iReading?.events.find(event => event.id === operationId)?.at ?? now;
    const switched = await updateActiveFocusReadingState(sessionId, latest => {
      if (!latest.reading || latest.reading.sourceActivityId !== binding.sourceActivityId || latest.reading.endedAt) return latest;
      const logId = `${operationId}:system`;
      return { ...latest, baiyunActivity: activity,
        reading: { ...latest.reading, transition: { operationId, at: actualAt, activity,
          ...(result.activity ? { readingActivityId: result.activity.activityId } : {}) } },
        logs: choice.next === 'switch' && !latest.logs.some(log => log.id === logId)
          ? [...latest.logs, { id: logId, role: 'system', content: focusReadingSwitchLabel(activity),
            createdAt: actualAt, elapsedSeconds: Math.floor(projectFocusReadingClock(current, actualAt).effectiveWorkMs / 1000),
            trigger: result.activity ? 'activity-switch-reading' : 'activity-switch-conceptual' }]
          : latest.logs };
    }, epoch);
    // Recovery after a saved start may settle elapsed work once, from that actual start.
    if (result.activity) await settleReadingActivity({ now, focus: projection });
    return switched;
  });
  reconcileTail = work.catch(() => undefined);
  return work;
}

/** Only actual transitions are facts; a future choice is not an activity yet. */
export async function loadFocusActivityFacts(now = Date.now()) {
  const active = await loadActiveFocusSession(true);
  const transition = active?.reading?.transition;
  const conceptual = transition && !transition.readingActivityId && active.reading?.choice?.next === 'switch';
  const records: Array<{ id: string; at: number; activity: string; change: '开始' | '本次活动结束' }> = [];
  let current: { id: string; activity: string; status: '已暂停' | '进行中' } | undefined;
  if (active && conceptual) {
    const clock = projectFocusReadingClock(active, now);
    const endedAt = active.reading?.endedAt ?? (clock.completed ? focusReadingEndAt(active) : undefined);
    if (!endedAt) current = { id: transition.operationId, activity: transition.activity,
      status: active.paused || clock.inBreak ? '已暂停' : '进行中' };
    records.push({ id: transition.operationId, at: transition.at, activity: transition.activity, change: '开始' });
    if (endedAt) records.push({ id: `${transition.operationId}:end`, at: endedAt, activity: transition.activity, change: '本次活动结束' });
  }
  for (const session of await loadRecentFocusSessions(4)) {
    const logs = await loadFocusLogs(session.id);
    const lastSwitch = logs.filter(log => log.trigger === 'activity-switch-conceptual'
      && log.content === focusReadingSwitchLabel(session.baiyunActivity)).at(-1);
    if (!lastSwitch || lastSwitch.createdAt > now) continue;
    const id = lastSwitch.id.replace(/:system$/u, '');
    records.push({ id, at: lastSwitch.createdAt, activity: session.baiyunActivity, change: '开始' });
    if (session.endedAt <= now) records.push({ id: `${id}:end`, at: session.endedAt, activity: session.baiyunActivity, change: '本次活动结束' });
  }
  const unique = [...new Map(records.map(record => [record.id, record])).values()]
    .filter(record => record.at <= now).sort((a, b) => b.at - a.at);
  return { current, records: unique };
}

function focusReadingEndAt(session: ActiveFocusSession) {
  const total = projectFocusReadingClock(session, session.startedAt).totalWorkMs;
  return total === null ? undefined : focusReadingWorkTargetAt(session, total) ?? undefined;
}
