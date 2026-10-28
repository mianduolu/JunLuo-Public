import { Platform } from 'react-native';
import { loadAssistantLifeDay, loadAssistantLifeDays, listAssistantLifeDays, saveAssistantLifeDay, type AssistantLifeDay } from '../ai/assistantLifeTimeline';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { loadAutonomySettings } from './autonomySettings';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { isChatReplyInFlight, runScheduledAiCall } from '../ai/aiRuntimeScheduler';
import { beginReadingBudgetRequest, getReadingBudgetRetryAt } from '../ai/aiCallBudget';
import { loadAiConfigPreferencesSnapshot, resolveLifeCreativeConfig } from '../ai/AiConfigPreferences';
import type { AssistantLifeTransportDiagnostic } from '../ai/assistantLifeGenerationShared';
import { withSleepPlanWrite, readSleepSchedule, upcomingSleepNights } from './sleepPlanStore';
import { sleepWakeTarget } from './sleepPlanPolicy';
import { getOwnDayPlanRequestLimit, selectOwnDayPlanOpportunity, type OwnDayPlanRun } from '../schedule/ownDayPlanPolicy';
import { loadOwnDayPlanMaterials, ownDayPlanReadingVersion } from '../schedule/ownDayPlanMaterials';
import { prepareOwnDayPlanRequest, ownDayPlanTools } from '../schedule/ownDayPlanGeneration';
import { prepareOwnedDayPlanBatch, persistOwnedDayPlanBatch, reconcileOwnedDayPlanBatch } from '../schedule/ownedDayPlanStore';
import { ownScheduleEntryIsFinal } from '../schedule/ownScheduleSave';
import { loadOwnActiveHabits } from '../schedule/habitStore';
import { loadOwnedScheduleItems, schedulePlanVersion } from '../schedule/scheduleStore';
import { loadReadingLibraryStrict } from '../reading/readingStore';
import { prepareProgramme } from '../reading/readingProgrammeStore';
import { createOwnScheduleTurn } from '../tools/ownScheduleTurn';
import { executeToolCall } from '../tools/toolExecution';
import { registerBuiltinTools } from '../tools/builtin/registerBuiltinTools';
import { TOOL_AGENT_MAX_CALLS_PER_ROUND, TOOL_AGENT_MAX_CALLS_PER_TURN } from '../tools/toolAgentLoop';
import type { SleepNativeWakeTask } from './sleepNativeWake';

type Phase = 'prepare' | 'wake';
let active: Promise<void> | null = null;

async function writeRun(key: string, phase: Phase, epoch: number, change: (old: OwnDayPlanRun | undefined) => OwnDayPlanRun) {
  const saved = await runBackupRestoreDataEpochCommit(epoch, () => withSleepPlanWrite(async () => {
    const day = await loadAssistantLifeDay(key);
    if (!day?.nightSleepPlan) throw new Error('day-plan-night-unavailable');
    const run = change(day.nightSleepPlan.dayPlan?.[phase]);
    day.nightSleepPlan.dayPlan = { ...day.nightSleepPlan.dayPlan, [phase]: run };
    for (let attempt = 0; ; attempt += 1) {
      try { await saveAssistantLifeDay(day); break; }
      catch (error) { if (attempt === 3) throw error; }
    }
    return run;
  }));
  if (!saved.committed) throw new Error('day-plan-restore');
  return saved.value;
}

async function eligibleDays(now: number, enabledAt: number) {
  // Existing indexed nights include a cross-date unfinished sleep. No historical interaction scan.
  const upcoming = await upcomingSleepNights(now);
  const recent = await loadAssistantLifeDays(await listAssistantLifeDays());
  return [...new Map([...upcoming, ...recent.filter((day): day is AssistantLifeDay => !!day
    && (day.nightSleepPlan?.actualWakeAt ?? 0) >= enabledAt)].map(day => [day.dateKey, day])).values()]
    .sort((a, b) => b.sleepTargetAt - a.sleepTargetAt);
}
async function pick(now: number) {
  const settings = await loadAutonomySettings();
  if (!settings.dailyPlanningActivatedAt) return null;
  const sleep = await readSleepSchedule(now);
  if (sleep?.actualPhase === 'sleeping') return null;
  const days = await eligibleDays(now, settings.dailyPlanningActivatedAt);
  for (const day of days) for (const phase of ['prepare', 'wake'] as const) {
    if (day.nightSleepPlan?.dayPlan?.[phase]?.status === 'saving') return { day, phase };
  }
  const latestWake = Math.max(0, ...days.map(day => day.nightSleepPlan?.actualWakeAt ?? 0));
  const latestSleep = Math.max(0, ...days.map(day => day.nightSleepPlan?.actualSleepAt ?? 0));
  for (const day of days) for (const phase of ['prepare', 'wake'] as const) {
    const plan = day.nightSleepPlan, run = plan?.dayPlan?.[phase];
    if (run?.paperCorrection && !run.batch && (phase === 'prepare' ? now >= day.sleepTargetAt
      : plan?.actualWakeAt !== undefined && (plan.actualWakeAt < latestWake || plan.actualWakeAt < latestSleep))) {
      return { day, phase, expiredCorrection: true };
    }
  }
  if (!settings.dailyPlanningEnabled || !settings.masterEnabled) return null;
  for (const day of days) {
    const plan = day.nightSleepPlan;
    if (!plan) continue;
    // Once a later sleep has started, don't resurrect an unattempted previous morning.
    if (plan.actualWakeAt !== undefined && (plan.actualWakeAt < latestWake || plan.actualWakeAt < latestSleep)) continue;
    const phase = selectOwnDayPlanOpportunity({ now, enabledAt: Math.max(settings.dailyPlanningActivatedAt, plan.dayPlan?.restoredAt ?? 0),
      sleepAt: day.sleepTargetAt, wakeAt: sleepWakeTarget(plan, plan.actualSleepAt ?? day.sleepTargetAt),
      actualWakeAt: plan.actualWakeAt, sleeping: false, state: plan.dayPlan });
    if (phase) return { day, phase };
  }
  return null;
}

async function sourcesValid(run: OwnDayPlanRun, key: string, phase: Phase, requireRequest: boolean) {
  const now = Date.now();
  const [day, sleep, settings, policy] = await Promise.all([loadAssistantLifeDay(key), readSleepSchedule(now),
    loadAutonomySettings(), loadAutomaticRemoteAiPolicy()]);
  if (!day?.nightSleepPlan || (day.nightSleepPlan.scheduleChangedAt ?? 0) !== run.sleepRevision) return false;
  if (requireRequest && (!settings.dailyPlanningEnabled || !settings.masterEnabled || isChatReplyInFlight() || sleep?.actualPhase === 'sleeping'
    || !isAutomaticRemoteAiAllowed(policy) || phase === 'prepare' && now >= day.sleepTargetAt)) return false;
  const [schedules, habits, books] = await Promise.all([loadOwnedScheduleItems(run.bounds.startAt, run.bounds.endAt),
    loadOwnActiveHabits(), loadReadingLibraryStrict()]);
  const same = (a: Record<string, number>, b: Record<string, number>) => Object.keys(a).length === Object.keys(b).length
    && Object.entries(a).every(([id, version]) => b[id] === version);
  if (!same(run.habitVersions, Object.fromEntries(habits.map(item => [item.id, item.updatedAt])))
    || !run.batch && !same(run.scheduleVersions, Object.fromEntries(schedules.map(item => [item.id, schedulePlanVersion(item)])))) return false;
  return Object.entries(run.readingVersions).every(([id, version]) => books.some(book => book.id === id && ownDayPlanReadingVersion(book) === version));
}

async function runOnce(now: number, allowRequest: boolean) {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null || Platform.OS !== 'android' || isChatReplyInFlight()) return;
  const selected = await pick(now);
  if (!selected) return;
  const { day, phase } = selected, key = day.dateKey;
  let run = day.nightSleepPlan!.dayPlan?.[phase];
  const update = async (change: Partial<OwnDayPlanRun>) => {
    const apply = (old: OwnDayPlanRun | undefined): OwnDayPlanRun => ({ ...old!, ...change,
      ...(change.status === 'failed' || change.status === 'complete' ? { paperCorrection: undefined } : {}),
      updatedAt: Math.max(Date.now(), (old?.updatedAt ?? 0) + 1) });
    run = await writeRun(key, phase, epoch, apply);
    return run;
  };
  const current = (requireRequest: boolean) => sourcesValid(run!, key, phase, requireRequest);
  if ('expiredCorrection' in selected && selected.expiredCorrection) {
    await update({ status: 'failed', reason: 'planning-window-ended' }); return;
  }
  if (run?.status === 'requesting' || run?.pendingTool) {
    // A restarted host cannot assume a lost response/tool receipt never executed. No replay.
    await update({ status: 'failed', reason: 'interrupted-outcome-unknown' }); return;
  }
  if (run?.retryAt !== undefined && now < run.retryAt) return;
  const policy = await loadAutomaticRemoteAiPolicy();
  if (!run?.batch && (!allowRequest || !isAutomaticRemoteAiAllowed(policy))) return;
  const configSnapshot = await loadAiConfigPreferencesSnapshot();
  const config = resolveLifeCreativeConfig(configSnapshot);
  if (!run?.batch && (!config.connection || !config.apiKey.trim())) return;
  if (!run) {
    const startAt = Math.ceil((phase === 'prepare' ? sleepWakeTarget(day.nightSleepPlan!, day.sleepTargetAt) : now) / 60_000) * 60_000;
    const bounds = { startAt, endAt: startAt + 24 * 60 * 60_000, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    const materials = await loadOwnDayPlanMaterials(day, now, bounds);
    const initial: OwnDayPlanRun = { id: `day-plan:${key}:${phase}`, status: 'ready', createdAt: now, updatedAt: now,
      bounds, requestCount: 0, saveAttempts: 0, scheduleVersions: materials.scheduleVersions,
      habitVersions: materials.habitVersions, readingVersions: materials.readingVersions,
      readingLabels: materials.readingLabels, expectedChoiceVersions: materials.expectedChoiceVersions,
      sleepRevision: day.nightSleepPlan!.scheduleChangedAt ?? 0 };
    run = await writeRun(key, phase, epoch, old => old ?? initial);
  }
  if (!await current(false)) { await update({ status: 'failed', reason: 'source-changed' }); return; }
  const savePaper = async () => {
    if (!run?.batch) return;
    const finish = async () => {
      await update({ status: 'complete', reason: undefined, retryAt: undefined });
      const books = await loadReadingLibraryStrict();
      const ids = [...new Set([...(run!.prepareIds ?? []), ...run!.batch!.entries.flatMap(entry => entry.saved && entry.readingId ? [entry.readingId] : [])])];
      for (const id of ids) if (books.some(book => book.id === id && book.programme?.preparation === 'missing')) {
        void prepareProgramme(id).catch(() => undefined);
      }
    };
    const reconciled = await reconcileOwnedDayPlanBatch(run.batch);
    await update({ batch: reconciled });
    if (reconciled.entries.every(entry => entry.saved)) {
      await finish();
      return;
    }
    while (run.saveAttempts < 4 && run.batch!.entries.some(entry => !entry.saved && !ownScheduleEntryIsFinal(entry))) {
      if (isChatReplyInFlight() || (await readSleepSchedule(Date.now()))?.actualPhase === 'sleeping') return;
      if (!canCommitBackupRestoreDataEpoch(epoch) || !await current(false)) return;
      await update({ status: 'saving', saveAttempts: run.saveAttempts + 1 });
      try {
        const saved = await runBackupRestoreDataEpochCommit(epoch, () => persistOwnedDayPlanBatch(run!.batch!));
        if (!saved.committed) return;
        await update({ batch: saved.value });
        if (run!.batch!.entries.every(entry => entry.saved)) {
          await finish();
          return;
        }
      } catch { /* The same stable batch is retried locally, never regenerated. */ }
    }
    if (run!.saveAttempts >= 4) {
      if (!canCommitBackupRestoreDataEpoch(epoch) || !await current(false)) return;
      let confirmed: NonNullable<OwnDayPlanRun['batch']>;
      try { confirmed = await reconcileOwnedDayPlanBatch(run!.batch!); }
      catch { return; } // Keep saving when the final receipt is unreadable; the original recovery checks it again.
      if (!canCommitBackupRestoreDataEpoch(epoch) || !await current(false)) return;
      try {
        await update({ batch: confirmed });
        if (confirmed.entries.every(entry => entry.saved)) {
          await finish();
          return;
        }
      } catch { return; } // A failed final receipt keeps its saved progress for the original local recovery.
    }
    const remaining = run!.batch!.entries.filter(entry => !entry.saved);
    const reason = remaining.every(ownScheduleEntryIsFinal) ? 'schedule-adjustment-rejected'
      : remaining.some(entry => entry.error === 'schedule-duration-context-unavailable') ? 'schedule-duration-context-unavailable'
        : 'local-save-exhausted';
    await update({ status: 'failed', reason });
  };
  if (run.batch) { await savePaper(); return; }
  registerBuiltinTools();
  const host = await createOwnScheduleTurn({ dataEpoch: epoch, lifeAgent: true, habitVersions: run.habitVersions,
    onHabitsSaved: async habitVersions => { await update({ habitVersions }); },
    isCurrent: () => !!run && current(true) });
  while (run!.requestCount < getOwnDayPlanRequestLimit(run!)) {
    if (!await current(true)) return;
    const fresh = await loadAssistantLifeDay(key);
    if (!fresh?.nightSleepPlan) return;
    const materials = await loadOwnDayPlanMaterials(fresh, Date.now(), run!.bounds, run!.readingLabels);
    const prepared = await prepareOwnDayPlanRequest({ connection: config.connection!, profile: configSnapshot.profile, run: run!, materials });
    if (!prepared.fits) { await update({ status: 'failed', reason: 'local-capacity-blocked' }); return; }
    const controller = new AbortController();
    let transportStarted = false;
    let lastTransport: AssistantLifeTransportDiagnostic | undefined;
    let stage = 'transport';
    const requestId = `${run!.id}:${run!.requestCount + 1}`;
    try {
      const response = await prepared.execute({ apiKey: config.apiKey, signal: controller.signal,
        onStage: value => { stage = value; },
        onTransportAttempt: transport => {
          lastTransport = transport;
          if (transport.outcome === 'started') transportStarted = true;
        },
        onRequestStart: async () => {
          if (!await current(true)) throw new Error('day-plan-not-current');
          await beginReadingBudgetRequest({ kind: 'dayPlan', connection: config.connection!, dataEpoch: epoch, requestId,
            beforeTransport: async () => { await update({ status: 'requesting', requestId, requestCount: run!.requestCount + 1,
              ...(run!.paperCorrection ? { paperCorrection: { ...run!.paperCorrection, attempted: true } } : {}),
              readingLabels: materials.readingLabels, expectedChoiceVersions: materials.expectedChoiceVersions,
              retryAt: undefined, requests: [...(run!.requests ?? []), { id: requestId, startedAt: Date.now(), outcome: 'started' }] }); } });
        },
      });
      stage = 'accept-response';
      await update({ requests: run!.requests?.map(request => request.id === requestId
        ? { ...request, endedAt: Date.now(), outcome: response.kind === 'invalid-paper'
          ? run!.paperCorrection ? 'failed' : 'invalid-paper' : 'response', promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens } : request) });
      if (!await current(false)) { await update({ status: 'failed', reason: 'source-changed' }); return; }
      if (response.kind === 'invalid-paper') {
        const errorDiagnostic = { stage: response.reason === 'day-plan-invalid-paper' ? 'paper-json' : 'paper-parse', code: response.reason, errorName: 'Error',
          ...(lastTransport?.httpStatus !== undefined ? { httpStatus: lastTransport.httpStatus } : {}),
          ...(lastTransport ? { transportOutcome: lastTransport.outcome } : {}) };
        if (run!.paperCorrection) {
          await update({ status: 'failed', reason: response.reason, errorDiagnostic,
            requests: run!.requests?.map(request => request.id === requestId ? { ...request, outcome: 'failed' } : request) });
          return;
        }
        await update({ status: 'ready', reason: 'paper-correction', errorDiagnostic,
          paperCorrection: { content: response.content, checks: response.checks, requestId, attempted: false },
          requests: run!.requests?.map(request => request.id === requestId ? { ...request, outcome: 'invalid-paper' } : request) });
        continue;
      }
      if (response.kind === 'paper') {
        const books = await loadReadingLibraryStrict(), habits = await loadOwnActiveHabits();
        const availability = await (await import('../schedule/ownReadingSelectionMaterial')).ownReadingAvailability(books);
        const shown = new Set(prepared.candidateIds);
        for (const receipt of run!.tools ?? []) if (receipt.toolId === 'reading.list' && receipt.result.ok) {
          const data = receipt.result.data as { books?: Array<{ bookId: string }>; episodes?: Array<{ episodeId: string }> };
          for (const book of data?.books ?? []) shown.add(book.bookId);
          for (const episode of data?.episodes ?? []) shown.add(episode.episodeId);
        }
        for (const item of await loadOwnedScheduleItems(run!.bounds.startAt, run!.bounds.endAt)) {
          if (item.readingId) shown.add(item.readingId);
          const choice = (await (await import('../schedule/ownedDayPlanStore')).loadOwnReadingChoice(item))?.choice;
          if (choice) {
            if (choice.currentReadingId) shown.add(choice.currentReadingId);
            if (choice.nextReadingId) shown.add(choice.nextReadingId);
          }
        }
        for (const [id, value] of Object.entries(availability)) if (!shown.has(id)) value.ready = false;
        if (response.paper.prepareIds.some(id => run!.readingVersions[id] === undefined || !books.some(book => book.id === id && book.programme))
          || response.paper.entries.some(entry => entry.readingId && (run!.readingVersions[entry.readingId] === undefined || !books.some(book => book.id === entry.readingId))
            || entry.habitId && !habits.some(habit => habit.id === entry.habitId))) throw new Error('day-plan-invalid-reference');
        stage = 'prepare-batch';
        const batch = await prepareOwnedDayPlanBatch({ opId: run!.id, entries: response.paper.entries, cancelIds: response.paper.cancelIds,
          allowedOwners: ['I'], expectedVersions: run!.scheduleVersions,
          readingLabels: run!.readingLabels, expectedChoiceVersions: run!.expectedChoiceVersions,
          readingAvailability: availability,
          planningStartAt: run!.bounds.startAt, planningEndAt: run!.bounds.endAt });
        await update({ status: 'saving', batch, prepareIds: response.paper.prepareIds, paperCorrection: undefined, errorDiagnostic: undefined });
        await savePaper(); return;
      }
      if (response.calls.length > TOOL_AGENT_MAX_CALLS_PER_ROUND
        || (run!.tools?.length ?? 0) + response.calls.length > TOOL_AGENT_MAX_CALLS_PER_TURN) throw new Error('day-plan-tool-limit');
      stage = 'execute-tools';
      for (const [index, invocation] of response.calls.entries()) {
        if (!await current(true)) throw new Error('day-plan-not-current');
        const toolId = invocation.toolId;
        if (!ownDayPlanTools.some(tool => tool.id === toolId)) throw new Error('day-plan-tool-forbidden');
        const call = { callId: `${requestId}:tool:${index}`, toolId, input: invocation.input, requestedBy: 'life_agent' as const, createdAt: Date.now() };
        await update({ pendingTool: call });
        const result = await executeToolCall(call, { ownSchedule: host.execute });
        const readingVersions = { ...run!.readingVersions };
        if (toolId === 'reading.list' && result.ok) {
          const data = result.data as { books?: Array<{ bookId: string }>; episodes?: Array<{ episodeId: string }> };
          const ids = [...(data?.books ?? []).map(book => book.bookId), ...(data?.episodes ?? []).map(episode => episode.episodeId)];
          for (const book of await loadReadingLibraryStrict()) if (ids.includes(book.id)) readingVersions[book.id] = ownDayPlanReadingVersion(book);
        }
        await update({ pendingTool: undefined, tools: [...(run!.tools ?? []), { ...call, result }], readingVersions,
          habitVersions: { ...host.habitVersions } });
      }
      await update({ status: 'ready' });
    } catch (error) {
      if (!canCommitBackupRestoreDataEpoch(epoch)) return;
      const message = error instanceof Error ? error.message : '';
      // Keep only bounded technical categories, never provider bodies, URLs or credentials.
      const transportReason = lastTransport?.outcome === 'http-error'
        && Number.isInteger(lastTransport.httpStatus) && lastTransport.httpStatus! >= 400 && lastTransport.httpStatus! <= 599
        ? `day-plan-http-${lastTransport.httpStatus}`
        : lastTransport && ['network-error', 'timeout', 'aborted'].includes(lastTransport.outcome)
          ? `day-plan-${lastTransport.outcome}` : 'day-plan-request-failed';
      const reason = /^(day-plan-|reading-budget-|invalid-day-plan-|schedule-|reading-choice-)[a-z0-9:-]+$/.test(message)
        || ['duplicate-day-plan-id', 'duplicate-schedule-target', 'duplicate-reading-choice-target', 'invalid-reading-label',
          'invalid-reading-reference', 'invalid-habit-reference'].includes(message) ? message.slice(0, 160)
        : /^own-day-plan-(invalid-response-json|timeout|aborted|http-[45]\d{2})$/.test(message)
          ? message.slice(4)
          : message === '接着已有安排做和重新选择内容，只能填写一种。这次接续还没保存。' ? 'day-plan-mixed-reading-choice'
            : /^标签 r[1-9]\d* 对应了不止一项安排，无法确定要接着哪项做，这次接续还没保存。$/.test(message) ? 'day-plan-duplicate-reading-label'
              : /^找不到标签 r[1-9]\d* 对应的安排，这次接续还没保存。$/.test(message) ? 'day-plan-reading-label-unavailable' : transportReason;
      const errorDiagnostic = { stage, code: reason,
        errorName: error instanceof Error && ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError'].includes(error.name) ? error.name : 'Error',
        ...(lastTransport?.httpStatus !== undefined ? { httpStatus: lastTransport.httpStatus } : {}),
        ...(lastTransport ? { transportOutcome: lastTransport.outcome } : {}) };
      if (!transportStarted && run!.requestId === requestId && run!.status === 'requesting') {
        await update({ status: 'ready', requestCount: run!.requestCount - 1, requestId: undefined,
          ...(run!.paperCorrection ? { paperCorrection: { ...run!.paperCorrection, attempted: false } } : {}),
          requests: run!.requests?.map(request => request.id === requestId
            ? { ...request, outcome: 'not-started', endedAt: Date.now() } : request) });
      }
      if (!transportStarted && reason.includes('budget-deferred')) {
        const retryAt = await getReadingBudgetRetryAt(config.connection!, Date.now(), 'dayPlan');
        await update({ status: 'waiting', retryAt: retryAt ?? Date.now() + 60_000, reason: 'budget' });
      } else await update({ status: 'failed', reason, errorDiagnostic, requests: run!.requests?.map(request => request.id === requestId
        ? { ...request, outcome: transportStarted ? 'failed' : 'not-started', endedAt: Date.now() } : request) });
      return;
    }
  }
  await update({ status: 'failed', reason: 'request-limit' });
}

export function runOwnDayPlanTick(now = Date.now(), allowRequest = true) {
  if (active) return active;
  active = (allowRequest ? runScheduledAiCall('dayPlan', 'background', () => runOnce(now, true)).then(() => undefined) : runOnce(now, false))
    .finally(() => { active = null; });
  return active;
}

export async function getOwnDayPlanWakeTask(now = Date.now()): Promise<SleepNativeWakeTask | null> {
  if (Platform.OS !== 'android') return null;
  const settings = await loadAutonomySettings();
  if (!settings.dailyPlanningActivatedAt) return null;
  const selected = await pick(now);
  const candidates: Array<{ at: number; key: string }> = [];
  if (selected) {
    const run = selected.day.nightSleepPlan!.dayPlan?.[selected.phase];
    const policy = await loadAutomaticRemoteAiPolicy();
    const config = resolveLifeCreativeConfig(await loadAiConfigPreferencesSnapshot());
    if (run?.batch || isAutomaticRemoteAiAllowed(policy) && config.connection && config.apiKey.trim()) {
      const retryAt = config.connection ? await getReadingBudgetRetryAt(config.connection, now, 'dayPlan') : undefined;
      candidates.push({ key: selected.day.dateKey,
        at: Math.max(now + 60_000, run?.retryAt ?? 0, retryAt ?? 0) });
    }
  } else if (settings.dailyPlanningEnabled && settings.masterEnabled) for (const day of await eligibleDays(now, settings.dailyPlanningActivatedAt)) {
    if (!day.nightSleepPlan?.dayPlan?.prepare && day.sleepTargetAt - 30 * 60_000 > now)
      candidates.push({ at: day.sleepTargetAt - 30 * 60_000, key: day.dateKey });
  }
  const next = candidates.sort((a, b) => a.at - b.at)[0];
  return next ? { id: 'own-day-plan', at: next.at, nightKey: next.key, phase: 'day_plan' } : null;
}
