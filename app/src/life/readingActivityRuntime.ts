import { loadAiConfigPreferencesSnapshot, resolveLifeCreativeConfig } from '../ai/AiConfigPreferences';
import { beginReadingBudgetRequest, getReadingBudgetRetryAt } from '../ai/aiCallBudget';
import { isChatReplyInFlight } from '../ai/aiRuntimeScheduler';
import { loadAutomaticRemoteAiPolicy, isAutomaticRemoteAiAllowed } from '../runtime/automaticRemoteAiPolicy';
import { getNextReadingWake, loadCurrentReadingActivity, runDailyReadingCheck, settleReadingActivity } from '../reading/readingDailyRuntime';
import { loadReadingLibraryStrict } from '../reading/readingStore';
import { loadActiveFocusSession } from '../focus/focusStore';
import { makeFocusSessionId } from '../focus/focusIdentity';
import { projectFocusReadingClock, focusReadingWorkTargetAt } from '../focus/focusReadingPolicy';
import { reconcileFocusReadingSession } from '../focus/focusReadingRuntime';
import { READING_INTERVAL_MS } from '../reading/readingDailyPolicy';
import { readSleepSchedule } from './sleepPlanStore';
import type { SleepNativeWakeTask } from './sleepNativeWake';
import { findReadingSleepBoundary } from './readingSleepBoundary';
import { prepareProgramme, settleInterruptedProgrammePreparations } from '../reading/readingProgrammeStore';

export async function readingHostState(now: number) {
  const [sleep, focus] = await Promise.all([readSleepSchedule(now), loadActiveFocusSession(true)]);
  const savedBoundary = await findReadingSleepBoundary(now);
  const sleeping = savedBoundary !== undefined || sleep?.actualPhase === 'sleeping';
  const sleepingAt = savedBoundary ?? (sleep?.actualPhase === 'sleeping' ? sleep.actualSleepAt : undefined);
  const clock = focus ? projectFocusReadingClock(focus, Math.min(now, sleepingAt ?? now)) : null;
  return { sleeping, sleepingAt, focus: focus && clock ? {
    sessionId: makeFocusSessionId(focus), effectiveWorkMs: clock.effectiveWorkMs,
    paused: focus.paused || clock.inBreak, ended: clock.completed,
    remainingWorkMs: clock.totalWorkMs === null ? null : Math.max(0, clock.totalWorkMs - clock.effectiveWorkMs),
  } : undefined };
}

/** Shared by background and manual continuation. Manual callers retain their
 * own admission rules; this only checks real sleep and the bound focus. */
export async function isReadingTransportHostAvailable(focusId?: string) {
  const host = await readingHostState(Date.now());
  return !host.sleeping && (!focusId || host.focus?.sessionId === focusId
    && !host.focus.paused && !host.focus.ended);
}

/** Called only by existing life/native checks. It does not own a timer. */
export async function runReadingActivityTick(now = Date.now(), allowRequest = true) {
  await settleInterruptedProgrammePreparations();
  await reconcileFocusReadingSession(undefined, now);
  const state = await readingHostState(now);
  const selection = (await loadReadingLibraryStrict()).find(book => book.iReading?.activity?.status === 'preparing');
  const selectedActivity = selection?.iReading?.activity;
  if (selection?.programme?.preparation === 'missing' && selectedActivity && !state.sleeping
    && (!selectedActivity.focusId || state.focus?.sessionId === selectedActivity.focusId && !state.focus.paused && !state.focus.ended)) {
    // Selection owns this single download. Failed/interrupted preparations require an explicit retry.
    void prepareProgramme(selection.id).then(async () => {
      const at = Date.now();
      await settleReadingActivity({ now: at, ...await readingHostState(at) });
      await (await import('./sleepPlanRuntime')).reconcileSleepPlanLocally();
    }).catch(() => undefined);
  }
  if (!allowRequest) { await settleReadingActivity({ now, ...state }); return 'local-only'; }
  const [snapshot, policy] = await Promise.all([loadAiConfigPreferencesSnapshot(), loadAutomaticRemoteAiPolicy()]);
  const config = resolveLifeCreativeConfig(snapshot);
  if (!config.connection || !config.apiKey.trim()) { await settleReadingActivity({ now, ...state }); return 'unconfigured'; }
  return runDailyReadingCheck({ now, ...state,
    runtime: { ...config, profile: snapshot.profile, visionConnection: snapshot.visionConnection, visionKey: snapshot.visionKey },
    automaticEnabled: isAutomaticRemoteAiAllowed(policy), chatBusy: isChatReplyInFlight(),
    canRequest: async () => {
      if (isChatReplyInFlight() || !isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())) return false;
      // Vision and reading can be separated by a pause, break or a different
      // focus. Re-read the host at each transport, not just at the first tick.
      const current = await loadCurrentReadingActivity(Date.now());
      return isReadingTransportHostAvailable(current?.focusId);
    },
    beginBudgetRequest: (requestId, dataEpoch, beforeTransport, transport) => beginReadingBudgetRequest({
      connection: transport?.connection ?? config.connection!, requestId, dataEpoch, beforeTransport,
      ...(transport ? { batch: { connections: transport.connections, index: transport.index } } : {}),
    }),
  });
}

/** Returns one member of the existing all-domain replacement list. */
export async function getReadingActivityWakeTask(now = Date.now()): Promise<SleepNativeWakeTask | null> {
  const [sleep, focus, books, snapshot, policy] = await Promise.all([
    readSleepSchedule(now), loadActiveFocusSession(true), loadReadingLibraryStrict(),
    loadAiConfigPreferencesSnapshot(), loadAutomaticRemoteAiPolicy(),
  ]);
  if (sleep?.actualPhase === 'sleeping') return null;
  const book = books.find(item => item.iReading?.activity?.status === 'reading');
  const progress = book?.iReading, activity = progress?.activity;
  const config = resolveLifeCreativeConfig(snapshot);
  const canRequest = isAutomaticRemoteAiAllowed(policy) && !!config.connection && !!config.apiKey.trim();
  const freshControl = !!activity && progress?.events.some(event => event.id === activity.operationId
    && event.at === activity.checkpointAt && (event.change === '开始' || event.change === '继续'));
  const seenOpportunity = progress?.opportunityAt !== undefined && !!activity
    && progress.opportunityAt <= activity.checkpointAt && !freshControl;
  const untilNext = READING_INTERVAL_MS - (progress?.remainderMs ?? 0);
  let requestAt = canRequest ? (await getNextReadingWake(now))?.at : undefined;
  let localAt = activity?.remainingMs !== null && activity?.remainingMs !== undefined
    ? activity.checkpointAt + activity.remainingMs : undefined;
  if (canRequest && activity && seenOpportunity) requestAt = activity.checkpointAt + untilNext;
  const deferred = activity?.deferredOpportunity;
  const deferredRetryAt = canRequest && deferred && progress?.opportunityAt === deferred.at && !progress.requestReservation
    ? deferred.retryAt : undefined;
  if (deferredRetryAt !== undefined) requestAt = deferredRetryAt;
  // A repeated query must return the same boundary. Busy chat may wait on the
  // existing 25-minute grid, rather than moving a "now + delay" alarm forever.
  if (canRequest && activity && isChatReplyInFlight() && requestAt !== undefined && requestAt <= now) {
    const first = activity.checkpointAt + untilNext;
    requestAt = first + Math.max(0, Math.floor((now - first) / READING_INTERVAL_MS) + 1) * READING_INTERVAL_MS;
  }
  if (focus?.reading && !focus.reading.endedAt) {
    const clock = projectFocusReadingClock(focus, now);
    if (focus.paused) return null;
    if (activity?.focusId === makeFocusSessionId(focus) && progress) {
      const baseWork = activity.focusWorkMs ?? clock.effectiveWorkMs;
      let workUntilOpportunity = progress.opportunityAt === undefined || seenOpportunity ? untilNext : 0;
      // An opportunity first met at the break boundary may run once work resumes.
      if (progress.opportunityAt !== undefined
        && projectFocusReadingClock(focus, activity.checkpointAt).inBreak) workUntilOpportunity = 1;
      if (isChatReplyInFlight()) {
        const elapsed = Math.max(0, clock.effectiveWorkMs - baseWork);
        if (workUntilOpportunity <= elapsed) workUntilOpportunity +=
          (Math.floor((elapsed - workUntilOpportunity) / READING_INTERVAL_MS) + 1) * READING_INTERVAL_MS;
      }
      requestAt = deferredRetryAt !== undefined && (!isChatReplyInFlight() || deferredRetryAt > now)
        ? deferredRetryAt
        : canRequest ? focusReadingWorkTargetAt(focus, baseWork + workUntilOpportunity) ?? undefined : undefined;
      localAt = activity.remainingMs === null ? undefined
        : focusReadingWorkTargetAt(focus, baseWork + activity.remainingMs) ?? undefined;
    }
    const binding = focus.reading;
    if (binding.choice && !binding.transition && binding.originalRemainingMs !== null) {
      const source = books.find(item => item.id === binding.bookId)?.iReading?.activity;
      const sameScheduledActivity = source?.schedule && source.id === binding.sourceActivityId
        && source.operationId === binding.sourceOperationId;
      const transitionWork = sameScheduledActivity && source.remainingMs !== null && source.focusWorkMs !== undefined
        ? source.focusWorkMs + source.remainingMs : binding.boundWorkMs + binding.originalRemainingMs;
      const transitionAt = focusReadingWorkTargetAt(focus, transitionWork);
      // A failed/deleted source must not keep replaying a past transition alarm.
      if (transitionAt !== null && source?.id === binding.sourceActivityId
        && source.operationId === binding.sourceOperationId && source.status !== 'paused'
        && transitionAt > source.checkpointAt) localAt = Math.min(localAt ?? Infinity, transitionAt);
    }
    const focusEndAt = clock.totalWorkMs === null ? null : focusReadingWorkTargetAt(focus, clock.totalWorkMs);
    if (focusEndAt !== null) localAt = Math.min(localAt ?? Infinity, focusEndAt);
    // During a break a due note waits for the next work interval, not another prompt.
    if (clock.inBreak && requestAt !== undefined && requestAt <= now) {
      requestAt = focusReadingWorkTargetAt(focus, clock.effectiveWorkMs + 1) ?? undefined;
    }
  }
  if (requestAt !== undefined && config.connection && requestAt <= now + READING_INTERVAL_MS) {
    requestAt = Math.max(requestAt, await getReadingBudgetRetryAt(config.connection, now) ?? requestAt);
  }
  // A retained unpaid retry (including a budget delay) waits for actual focus work.
  if (deferredRetryAt !== undefined && requestAt !== undefined && focus?.reading && !focus.reading.endedAt
    && activity?.focusId === makeFocusSessionId(focus)) {
    const retryClock = projectFocusReadingClock(focus, Math.max(now, requestAt));
    if (retryClock.inBreak) requestAt = focusReadingWorkTargetAt(focus, retryClock.effectiveWorkMs + 1) ?? undefined;
  }
  const at = Math.min(requestAt ?? Infinity, localAt ?? Infinity);
  if (at === undefined || !Number.isFinite(at) || at <= 0) return null;
  const id = activity?.id ?? focus?.reading?.sourceActivityId;
  return id ? { id: `reading:${id}`, at, nightKey: id, phase: 'reading' } : null;
}
