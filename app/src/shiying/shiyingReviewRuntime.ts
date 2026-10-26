import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { isChatReplyInFlight } from '../ai/aiRuntimeScheduler';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { getAutomaticCostRestriction, isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import type { ScreenName } from '../types/navigation';
import { createShiyingSummaryId } from './shiyingContract';
import { resolveShiyingPickupModelConfig } from './shiyingCoordinator';
import { runShiyingDatabaseOperation } from './shiyingDatabase';
import { shiyingRecordCoordinator } from './shiyingRecordCoordinator';
import { subscribeShiyingImageNotes } from './shiyingImageCoordinator';
import { subscribeShiyingEntryChanges } from './shiyingStore';
import { getShiyingReviewRecoveryState, runShiyingWeeklyReview } from './shiyingReviewCoordinator';
import { getShiyingReviewRun, getShiyingReviewPeriodState } from './shiyingReviewStore';
import { getShiyingReviewWeek, shiyingWeekForDate, loadShiyingWeeklyReviewState, subscribeShiyingWeeklyReviewState,
  isShiyingReviewKindEnabled, getShiyingReviewAutoFloor, type ShiyingReviewKind } from './shiyingReviewPolicy';
import { getShiyingLatestClosedPeriod, shiyingPeriodForDate } from './shiyingPeriodReview';
import { subscribeShiyingSummaryChanges } from './shiyingSummaryStore';
import { isShiyingBackfillExecuting, subscribeShiyingBackfillExecution } from './shiyingBackfillState';

/** Date/receipt metadata only. Never loads a paper or its image files. */
export async function findShiyingAutomaticReviewWeek(floor: string, now = Date.now()) {
  const latest = getShiyingReviewWeek(now);
  const dates = await runShiyingDatabaseOperation(db => db.getAllAsync<{ date: string }>(
    `SELECT life_date AS date FROM shiying_entries WHERE status='active' AND life_date BETWEEN ? AND ?
     UNION SELECT record_date AS date FROM shiying_records WHERE record_date BETWEEN ? AND ?
     UNION SELECT period_start_life_date AS date FROM shiying_summaries WHERE kind='week' AND dirty=1
       AND period_start_life_date BETWEEN ? AND ? ORDER BY date DESC;`, floor, latest.end, floor, latest.end, floor, latest.start));
  const weeks = [...new Set([latest.start, ...dates.map(({ date }) => shiyingWeekForDate(date).start)])]
    .filter(start => start >= floor && start <= latest.start).sort().reverse();
  let dirty: string | null = null;
  for (const start of weeks) {
    const period = shiyingWeekForDate(start);
    const rejected = await runShiyingDatabaseOperation(db => db.getFirstAsync<{ status: string; edited_at: number | null }>(
      'SELECT status,edited_at FROM shiying_summaries WHERE id=?;', createShiyingSummaryId({ kind: 'week', periodStartLifeDate: start, periodEndLifeDate: period.end })));
    if (rejected?.status === 'rejected' || rejected?.edited_at !== null && rejected?.edited_at !== undefined) continue;
    const state = await getShiyingReviewPeriodState(start, period.end);
    if (!state) return start;
    if (state.dirty && dirty === null) dirty = start;
  }
  return dirty;
}

/** Lightweight fixed-date metadata; bodies are loaded only after choosing one task. */
export async function findShiyingAutomaticReviewPeriod(kind: 'month' | 'year', floor: string, now = Date.now()) {
  const latest = getShiyingLatestClosedPeriod(kind, now); if (!latest || floor > latest.start) return null;
  const dates = await runShiyingDatabaseOperation(db => db.getAllAsync<{ date: string }>(
    `SELECT life_date AS date FROM shiying_entries WHERE status='active' AND life_date BETWEEN ? AND ?
     UNION SELECT record_date AS date FROM shiying_records WHERE record_date BETWEEN ? AND ?
     UNION SELECT period_start_life_date AS date FROM shiying_summaries WHERE kind=? AND dirty=1
       AND period_start_life_date BETWEEN ? AND ? ORDER BY date DESC;`, floor, latest.end, floor, latest.end, kind, floor, latest.start));
  const starts = [...new Set([latest.start, ...dates.map(({ date }) => shiyingPeriodForDate(kind, date).start)])]
    .filter(start => start >= floor && start <= latest.start).sort().reverse();
  let dirty: string | null = null;
  for (const start of starts) {
    const period = shiyingPeriodForDate(kind, start);
    const row = await runShiyingDatabaseOperation(db => db.getFirstAsync<{ status: string; edited_at: number | null }>(
      'SELECT status,edited_at FROM shiying_summaries WHERE id=?;', createShiyingSummaryId({ kind, periodStartLifeDate: start, periodEndLifeDate: period.end })));
    if (row?.status === 'rejected' || row?.edited_at !== null && row?.edited_at !== undefined) continue;
    const receipt = await getShiyingReviewPeriodState(start, period.end, kind);
    if (!receipt) return start;
    if (receipt.dirty && dirty === null) dirty = start;
  }
  return dirty;
}

export function createShiyingReviewRuntime(options: {
  isActive: () => boolean; screen: () => ScreenName;
  now?: () => number; state?: typeof loadShiyingWeeklyReviewState;
  policy?: typeof loadAutomaticRemoteAiPolicy; config?: typeof loadAiConfigPreferencesSnapshot;
  getRun?: typeof getShiyingReviewRun; recovery?: typeof getShiyingReviewRecoveryState;
  selectWeek?: typeof findShiyingAutomaticReviewWeek; run?: typeof runShiyingWeeklyReview;
  selectPeriod?: typeof findShiyingAutomaticReviewPeriod;
  chatBusy?: typeof isChatReplyInFlight;
  subscribe?: (wake: () => void) => () => void;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
}) {
  const now = options.now ?? Date.now, setTimer = options.setTimer ?? setTimeout, clearTimer = options.clearTimer ?? clearTimeout;
  const state = options.state ?? loadShiyingWeeklyReviewState, busy = options.chatBusy ?? isChatReplyInFlight;
  let stopped = false, running = false, timer: ReturnType<typeof setTimeout> | null = null;
  const active = () => !stopped && options.isActive();
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const allowed = async (epoch: number, kind: ShiyingReviewKind, baseUrl?: string) => {
    if (!active() || busy() || isShiyingBackfillExecuting() || !canCommitBackupRestoreDataEpoch(epoch)) return false;
    const policy = await (options.policy ?? loadAutomaticRemoteAiPolicy)();
    if (!isAutomaticRemoteAiAllowed(policy, options.screen())) return false;
    if (baseUrl && getAutomaticCostRestriction({ policy, baseUrl, now: now(), purpose: 'shiying-review' }).mode === 'wait') return false;
    const settings = await state();
    return active() && !busy() && !isShiyingBackfillExecuting() && canCommitBackupRestoreDataEpoch(epoch)
      && isShiyingReviewKindEnabled(settings, kind);
  };
  async function selectTarget() {
    const settings = await state();
    for (const kind of ['week', 'month', 'year'] as const) {
      const existing = await (options.getRun ?? getShiyingReviewRun)(kind);
      const recovery = await (options.recovery ?? getShiyingReviewRecoveryState)(kind);
      if (existing || recovery.kind !== 'none') {
        // An unfinished higher article blocks lower kinds even while its switch is off.
        if (existing || ['save_pending', 'finalize', 'retry_confirmation_required', 'blocked'].includes(recovery.kind))
          return { kind, periodStart: existing?.periodStart ?? null, recovery, enabled: isShiyingReviewKindEnabled(settings, kind) };
      }
      const floor = getShiyingReviewAutoFloor(settings, kind);
      if (!isShiyingReviewKindEnabled(settings, kind) || floor === null) continue;
      const periodStart = kind === 'week' ? await (options.selectWeek ?? findShiyingAutomaticReviewWeek)(floor, now())
        : await (options.selectPeriod ?? findShiyingAutomaticReviewPeriod)(kind, floor, now());
      if (periodStart !== null) return { kind, periodStart, recovery, enabled: true };
    }
    return null;
  }
  function schedule(delay: number) { if (!active()) return; clear(); timer = setTimer(() => { timer = null; void check(); }, delay); }
  function wake() { if (active() && !running) schedule(0); }
  async function check() {
    if (!active() || running) return;
    running = true;
    try {
      const initial = await state();
      const epoch = captureBackupRestoreDataEpoch();
      if (!['week', 'month', 'year'].some(kind => isShiyingReviewKindEnabled(initial, kind as ShiyingReviewKind)) || epoch === null) return;
      // Bounded local passes allow a saved week to hand the remaining shared quota to a month.
      for (let pass = 0; pass < 6; pass++) {
        const settings = await state(), today = new Date(now());
        const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const target = await selectTarget(); if (!target || !target.enabled || target.periodStart === null) return;
        if (['busy', 'save_pending', 'blocked', 'retry_confirmation_required'].includes(target.recovery.kind)) return;
        if (settings.day !== null && day <= settings.day && settings.reservedCalls >= 2 && target.recovery.kind !== 'finalize') return;
        if (!await allowed(epoch, target.kind)) return;
        const config = resolveShiyingPickupModelConfig(await (options.config ?? loadAiConfigPreferencesSnapshot)({ maxAgeMs: 0, readOnly: true }));
        if ((!config && target.recovery.kind !== 'finalize') || config && !await allowed(epoch, target.kind, config.connection.baseUrl)) return;
        const result = await (options.run ?? runShiyingWeeklyReview)({ kind: target.kind, periodStart: target.periodStart, automatic: true,
          canRequest: async () => {
            if (!await allowed(epoch, target.kind, config?.connection.baseUrl)) return false;
            const next = await selectTarget();
            return active() && !busy() && !isShiyingBackfillExecuting() && canCommitBackupRestoreDataEpoch(epoch)
              && next?.kind === target.kind && next.periodStart === target.periodStart;
          } });
        if (!['completed', 'direct', 'no_material'].includes(result.kind)) return;
        const next = await selectTarget();
        if (next?.kind === target.kind && next.periodStart === target.periodStart) return;
      }
    } catch { /* Only technical state lives in the run; no private contents in logs. */ }
    finally { running = false; if (active()) schedule(60_000); }
  }
  const subscribe = options.subscribe ?? ((wake: () => void) => {
    const releases = [subscribeShiyingWeeklyReviewState(wake), subscribeShiyingEntryChanges(wake),
      subscribeShiyingImageNotes(wake), subscribeShiyingSummaryChanges(wake), shiyingRecordCoordinator.subscribe(wake),
      subscribeShiyingBackfillExecution(wake)];
    return () => releases.forEach(release => release());
  });
  const unsubscribe = subscribe(wake);
  return { wake, check, pause: clear, stop() { stopped = true; clear(); unsubscribe(); } };
}
