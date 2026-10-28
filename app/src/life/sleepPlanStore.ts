import {
  ensureAssistantLifeDay, getAssistantLifeDayKey, getLocalDateKey, loadAssistantLifeDay, loadAssistantLifeDays, saveAssistantLifeDay,
  listAssistantLifeDays, type AssistantLifeDay,
} from '../ai/assistantLifeTimeline';
import { loadAssistantState } from '../ai/assistantState';
import { assistantLifeStateStorageBridge as AsyncStorage } from '../sync/syncAssistantLifeStateStorageBridge';
import RawAsyncStorage from '@react-native-async-storage/async-storage';
import { SLEEP_REPLY_DRAFT_KEY, readSleepReplyDraft, type SleepReplyDraft } from './sleepPlanPolicy';
import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import {
  changeMorningWakeTime, changeNightSleepTime, changeNightWakeTime, isNightWakeDecisionPending, localSleepNightKey,
  nextSleepDateKey, parseSleepScheduleTime, formatSleepLocalTime, sleepWakeTarget, type SleepPlanContext,
  type SleepOpportunity, type SleepScheduleResult,
  CHAT_SLEEP_LEAD_MS, CHAT_SLEEP_QUIET_MS, CHAT_SLEEP_ROUND_MS, MIN_MAIN_SLEEP_MS, nightSleepPhaseAt, pendingSleepDueAt,
  type ChatSleepPlanContext, type SleepPlanEvent, type SleepScheduleSnapshot,
  canNearStatusChangeSleepSchedule, canNaturallyWakeEarly, sleepWakeAlarmAt,
  startDeliveredSleepFarewell, type SleepGreetingBoundary, type SleepGreetingReceipt,
} from './sleepPlanPolicy';

// Serialize the existing two-day writes and reject superseded model replies.
let pendingWrite: Promise<unknown> = Promise.resolve();
export function withSleepPlanWrite<T>(operation: () => Promise<T>): Promise<T> {
  const task = pendingWrite.then(operation, operation);
  pendingWrite = task.catch(() => undefined);
  return task;
}

export async function loadPendingSleepReply() {
  await pendingWrite;
  return readSleepReplyDraft(await RawAsyncStorage.getItem(SLEEP_REPLY_DRAFT_KEY));
}

// The chat writer must not wait on the sleep writer, which may be reading chat.
export async function isPendingSleepReplyCurrent(draft: SleepReplyDraft) {
  return await RawAsyncStorage.getItem(SLEEP_REPLY_DRAFT_KEY) === JSON.stringify(draft);
}

export function discardPendingSleepReply(expected?: SleepReplyDraft) {
  return withSleepPlanWrite(async () => {
    if (!expected || await RawAsyncStorage.getItem(SLEEP_REPLY_DRAFT_KEY) === JSON.stringify(expected)) {
      await RawAsyncStorage.removeItem(SLEEP_REPLY_DRAFT_KEY);
    }
  });
}

export async function savePendingSleepReply(draft: SleepReplyDraft, epoch: number | null, current: () => Promise<boolean>) {
  const serialized = JSON.stringify(draft);
  const saved = await runBackupRestoreDataEpochCommit(epoch, () => withSleepPlanWrite(async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        if (!await current()) throw new Error('sleep-opportunity-stale');
        const previous = await RawAsyncStorage.getItem(SLEEP_REPLY_DRAFT_KEY);
        if (previous !== null && previous !== serialized) throw new Error('sleep-reply-draft-busy');
        await RawAsyncStorage.setItem(SLEEP_REPLY_DRAFT_KEY, serialized);
        if (!canCommitBackupRestoreDataEpoch(epoch) || !await current()) {
          if (await RawAsyncStorage.getItem(SLEEP_REPLY_DRAFT_KEY) === serialized) await RawAsyncStorage.removeItem(SLEEP_REPLY_DRAFT_KEY);
          throw new Error('sleep-opportunity-stale');
        }
        return;
      } catch (error) {
        if (attempt === 3 || !canCommitBackupRestoreDataEpoch(epoch)) throw error;
      }
    }
  }));
  if (!saved.committed) throw new Error('sleep-epoch-stale');
}

function addEvent(day: AssistantLifeDay, event: SleepPlanEvent) {
  const plan = day.nightSleepPlan!;
  if (!plan.events?.some(item => item.id === event.id)) plan.events = [...(plan.events ?? []), event];
}

async function refreshSleepRecovery(day: AssistantLifeDay, now: number) {
  const plan = day.nightSleepPlan!;
  if (plan.actualSleepAt === undefined || plan.actualWakeAt !== undefined || nightSleepPhaseAt(day, now) !== 'sleeping') return;
  const startedAt = Math.max(plan.actualSleepAt, ...(plan.events ?? []).filter(event => event.kind === 'sleep_return' && event.at <= now).map(event => event.at));
  const { getSleepRecoveryProjection } = await import('./lifeRhythm');
  const projection = await getSleepRecoveryProjection(now);
  if (!projection.reliable) return;
  const sameSegment = plan.recovery?.sleepStartedAt === startedAt;
  plan.recovery = { sleepStartedAt: startedAt, checkedAt: now,
    eligible: sameSegment ? plan.recovery!.eligible : !projection.recovered,
    estimatedAt: projection.recoveryAt ?? (sameSegment && plan.recovery?.eligible && projection.recovered ? now : undefined) };
}

function rememberChatWindow(day: AssistantLifeDay, now: number) {
  const plan = day.nightSleepPlan!;
  if (plan.actualSleepAt === undefined && plan.actualWakeAt === undefined) {
    if (plan.chatOpenedAt === undefined && now >= day.sleepTargetAt - CHAT_SLEEP_LEAD_MS) plan.chatOpenedAt = now;
    if (now > plan.originalSleepAt && now < day.sleepTargetAt) {
      addEvent(day, { id: `${day.dateKey}:late`, kind: 'late', at: now, sleepAt: plan.originalSleepAt });
    }
  }
}

function rememberCurrentPoke(day: AssistantLifeDay, state: Awaited<ReturnType<typeof loadAssistantState>>, now: number) {
  const plan = day.nightSleepPlan!, until = state.manualWakeUntil;
  if (state.wakeSource !== 'poke' || state.lifeMode === 'sleeping' || until === undefined || until <= now
    || plan.actualSleepAt === undefined || plan.actualWakeAt !== undefined) return;
  const at = until - 15 * 60_000;
  if (at >= plan.actualSleepAt && at <= now) addEvent(day, { id: `poke:${at}`, kind: 'poke_awake', at, until });
}

export async function ensureSleepNight(nightKey: string) {
  let day = await ensureAssistantLifeDay(new Date(`${nightKey}T12:00:00`).getTime());
  if (!day.nightSleepPlan) {
    const next = await ensureAssistantLifeDay(new Date(`${nextSleepDateKey(nightKey)}T12:00:00`).getTime());
    day = { ...day, sleepPlanUpdatedAt: Date.now(), nightSleepPlan: { originalSleepAt: day.sleepTargetAt, originalWakeAt: next.wakeTargetAt, revision: 0 } };
    await saveAssistantLifeDay(day);
  }
  return day;
}

export function sleepContext(day: AssistantLifeDay, now: number): SleepPlanContext {
  const plan = day.nightSleepPlan!;
  return {
    nightKey: day.dateKey, revision: plan.revision, requestAt: now,
    originalSleepAt: plan.originalSleepAt, originalWakeAt: plan.originalWakeAt,
    currentSleepAt: day.sleepTargetAt, currentWakeAt: sleepWakeTarget(plan, plan.actualSleepAt ?? day.sleepTargetAt),
  };
}

export async function captureSleepPlanContext(now = Date.now()): Promise<SleepPlanContext | null> {
  const state = await loadAssistantState();
  if (state.lifeMode === 'sleeping') return null;
  const context = await readSleepSchedule(now);
  return context ? { ...context, manualWakeUntil: state.manualWakeUntil } : null;
}

/** Near status edits the still-awake night, or the next night after the previous wake. */
export async function captureNearStatusSleepContext(now = Date.now()): Promise<SleepPlanContext | null> {
  const state = await loadAssistantState();
  if (state.lifeMode === 'sleeping' || (state.manualWakeUntil ?? 0) > now || (state.manualSleepUntil ?? 0) > now) return null;
  return withSleepPlanWrite(async () => {
    const currentKey = getLocalDateKey(new Date(now));
    const selected = await readRelevantSleepNight(now);
    const day = selected?.nightSleepPlan ? selected : await ensureSleepNight(currentKey);
    if (!canNearStatusChangeSleepSchedule(day, now)) return null;
    return { ...sleepContext(day, now), manualWakeUntil: state.manualWakeUntil };
  });
}

export async function readRelevantSleepNight(now = Date.now()): Promise<AssistantLifeDay | null> {
  const previousDate = new Date(now);
  previousDate.setDate(previousDate.getDate() - 1);
  const [previous, current] = await loadAssistantLifeDays([
    getLocalDateKey(previousDate), getLocalDateKey(new Date(now)),
  ]);
  const keys = await listAssistantLifeDays(Number.MAX_SAFE_INTEGER);
  const candidates = [previous, current].filter((value): value is AssistantLifeDay => !!value);
  const historicalKeys = new Set(keys
    .filter(key => key <= getLocalDateKey(new Date(now)) && !candidates.some(day => day.dateKey === key)));
  const historicalDays = await loadAssistantLifeDays([...historicalKeys], { unfinishedSleepAt: now });
  for (const day of historicalDays) {
    if (day?.nightSleepPlan && (day.nightSleepPlan.actualWakeAt === undefined || day.nightSleepPlan.actualWakeAt > now)) candidates.push(day);
  }
  const active = candidates.filter(day => {
    const plan = day.nightSleepPlan;
    return plan && (plan.actualWakeAt === undefined || plan.actualWakeAt > now) && (plan.pendingSleep || plan.actualSleepAt !== undefined
      || plan.scheduleChangedAt !== undefined || day.dateKey < getLocalDateKey(new Date(now))
      && now < sleepWakeTarget(plan, day.sleepTargetAt));
  }).sort((a, b) => {
    const priority = (day: AssistantLifeDay) => day.nightSleepPlan?.actualSleepAt !== undefined ? 3
      : day.nightSleepPlan?.pendingSleep ? 2 : day.nightSleepPlan?.scheduleChangedAt !== undefined ? 1 : 0;
    return priority(b) - priority(a) || b.dateKey.localeCompare(a.dateKey);
  });
  return active[0] ?? current;
}

/** A query never initializes days, settles sleep, or changes the native schedule. */
export async function readSleepSchedule(now = Date.now()): Promise<SleepScheduleSnapshot | null> {
  const day = await readRelevantSleepNight(now);
  const plan = day?.nightSleepPlan;
  return day && plan ? { ...sleepContext(day, now), actualSleepAt: plan.actualSleepAt,
    actualPhase: nightSleepPhaseAt(day, now),
    morningAwakeAt: plan.morningAwakeAt, actualWakeAt: plan.actualWakeAt,
    ...(plan.pendingSleep ? { pendingSleep: { decidedAt: plan.pendingSleep.decidedAt,
      hardDeadlineAt: plan.pendingSleep.hardDeadlineAt, dueAt: plan.pendingSleep.dueAt } } : {}) } : null;
}

export async function saveNightAndMorning(day: AssistantLifeDay, now: number) {
  const plan = day.nightSleepPlan!;
  const wakeAt = plan.actualWakeAt ?? sleepWakeTarget(plan, plan.actualSleepAt ?? day.sleepTargetAt);
  const night = plan.actualWakeAt === undefined ? day : changeNightWakeTime(day, plan.actualWakeAt);
  const entries: [string, string][] = [];
  const lastKey = getLocalDateKey(new Date(Math.max(wakeAt, day.sleepTargetAt)));
  const projectionKeys = [...new Set([nextSleepDateKey(day.dateKey), getLocalDateKey(new Date(day.sleepTargetAt)), lastKey,
    ...(await listAssistantLifeDays(Number.MAX_SAFE_INTEGER))])].filter(key => key === nextSleepDateKey(day.dateKey)
      || key > day.dateKey && key <= lastKey).sort();
  for (const key of projectionKeys) {
    const midnight = new Date(`${key}T00:00:00`).getTime();
    const end = new Date(`${nextSleepDateKey(key)}T00:00:00`).getTime();
    const next = await ensureAssistantLifeDay(new Date(`${key}T12:00:00`).getTime());
    const projection = changeMorningWakeTime(next, Math.min(end, Math.max(midnight, wakeAt)), night);
    entries.push([getAssistantLifeDayKey(key), JSON.stringify({ ...projection, sleepPlanUpdatedAt: now })]);
  }
  entries.push([getAssistantLifeDayKey(day.dateKey), JSON.stringify({ ...night, sleepPlanUpdatedAt: now })]);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { await AsyncStorage.multiSet(entries); return; }
    catch (error) {
      const persisted = await AsyncStorage.multiGet(entries.map(([key]) => key)).catch(() => []);
      if (entries.every(([key, value]) => persisted.some(([storedKey, storedValue]) => storedKey === key && storedValue === value))) return;
      if (attempt === 3) throw error;
    }
  }
}

export async function commitSleepScheduleDecision(input: {
  context: SleepPlanContext; sleepAt?: unknown; wakeAt?: unknown; messageId: string;
  phase: 'prepare' | 'wake' | 'near-status'; now?: number;
  deferGreeting?: { sessionId: string; messageId: string };
}): Promise<SleepScheduleResult> {
  return withSleepPlanWrite(() => commitSleepScheduleDecisionUnlocked(input));
}

async function commitSleepScheduleDecisionUnlocked(input: Parameters<typeof commitSleepScheduleDecision>[0],
  chat?: ChatSleepPlanContext): Promise<SleepScheduleResult> {
    const now = input.now ?? Date.now();
    const day = await loadAssistantLifeDay(input.context.nightKey);
    const result = (status: SleepScheduleResult['status'], value = day): SleepScheduleResult => ({
      subject: 'I', ok: status === 'applied' || status === 'unchanged', status,
      sleepAt: value ? formatSleepLocalTime(value.sleepTargetAt) : null,
      wakeAt: value?.nightSleepPlan ? formatSleepLocalTime(sleepWakeTarget(value.nightSleepPlan, value.nightSleepPlan.actualSleepAt ?? value.sleepTargetAt)) : null,
    });
    if (!day?.nightSleepPlan) return result('unavailable');
    if (day.nightSleepPlan.lastMessageId === input.messageId) return result('unchanged');
    if (day.nightSleepPlan.revision !== input.context.revision || day.nightSleepPlan.actualWakeAt) return result('stale');
    const state = await loadAssistantState();
    if (input.phase === 'near-status') {
      const active = await readRelevantSleepNight(now);
      if (state.lifeMode === 'sleeping' || (state.manualWakeUntil ?? 0) > now || (state.manualSleepUntil ?? 0) > now
        || active?.dateKey !== day.dateKey || day.nightSleepPlan.actualSleepAt !== undefined || now >= day.sleepTargetAt) return result('stale');
    }
    if (state.wakeSource === 'poke' && (state.manualWakeUntil ?? 0) > Math.max(now, input.context.manualWakeUntil ?? 0)) return result('stale');
    if (input.sleepAt === undefined && input.wakeAt === undefined) return result('invalid_time');
    const sleep = input.sleepAt === undefined ? day.sleepTargetAt : parseSleepScheduleTime(input.sleepAt);
    const wake = input.wakeAt === undefined ? undefined : parseSleepScheduleTime(input.wakeAt);
    const continuing = input.phase === 'wake' && !chat && input.sleepAt !== undefined;
    if (sleep === null || wake === null
      || (input.sleepAt !== undefined && ((!continuing && day.nightSleepPlan.actualSleepAt !== undefined) || sleep < input.context.requestAt - 1000))
      || (wake !== undefined && wake < input.context.requestAt - 1000)) return result('invalid_time');
    const nextSleep = input.sleepAt === undefined ? sleep : Math.max(now, sleep);
    const nextWake = wake === undefined ? sleepWakeTarget(day.nightSleepPlan, day.nightSleepPlan.actualSleepAt ?? nextSleep) : Math.max(now, wake);
    if (continuing && (day.nightSleepPlan.actualSleepAt === undefined || sleep > now || wake === undefined || wake <= now)) return result('invalid_time');
    if (input.phase === 'wake') {
      if (wake === undefined || nextWake < now) return result('invalid_time');
      const plan = day.nightSleepPlan;
      plan.explicitWakeAt = nextWake; plan.lastMessageId = input.messageId; plan.revision += 1; plan.scheduleChangedAt = now;
      plan.pendingSleep = undefined; plan.recovery = undefined;
      plan.morningAwakeAt ??= now;
      addEvent(day, { id: `${day.dateKey}:morning-awake`, kind: 'morning_awake', at: plan.morningAwakeAt });
      addEvent(day, { id: `schedule:${input.messageId}`, kind: 'schedule', at: now, wakeAt: nextWake, toolCallId: input.messageId });
      if (continuing) addEvent(day, { id: `return:${input.messageId}`, kind: 'sleep_return', at: now, sleepAt: now, toolCallId: input.messageId });
      else if (nextWake === now) {
        plan.actualWakeAt = now;
        addEvent(day, { id: `${day.dateKey}:get-up`, kind: 'get_up', at: now, wakeAt: now });
      }
      await saveNightAndMorning(day, now);
      if (continuing) { await refreshSleepRecovery(day, now); await saveNightAndMorning(day, now); }
      return result('applied');
    }
    if (nextWake <= nextSleep || nextWake <= now || nextWake - nextSleep < MIN_MAIN_SLEEP_MS) return result('invalid_time');
    if (nextSleep === day.sleepTargetAt && nextWake === sleepWakeTarget(day.nightSleepPlan, day.nightSleepPlan.actualSleepAt ?? day.sleepTargetAt)) return result('unchanged');
    if (input.phase === 'near-status' && !canNearStatusChangeSleepSchedule(day, now)) return result('stale');
    const next = input.sleepAt === undefined ? { ...day } : changeNightSleepTime(day, nextSleep,
      nextWake < new Date(`${nextSleepDateKey(day.dateKey)}T00:00:00`).getTime());
    rememberChatWindow(day, now);
    next.nightSleepPlan = {
      ...day.nightSleepPlan, revision: day.nightSleepPlan.revision + 1, scheduleChangedAt: now,
      ...(wake !== undefined ? { explicitWakeAt: nextWake } : {}),
      actualSleepAt: day.nightSleepPlan.actualSleepAt ?? (nextSleep <= now && !input.deferGreeting ? nextSleep : undefined), lastMessageId: input.messageId,
      ...(input.sleepAt !== undefined ? { pendingSleep: undefined, recovery: undefined } : {}),
    };
    if (input.deferGreeting && nextSleep <= now && next.nightSleepPlan.actualSleepAt === undefined) {
      next.nightSleepPlan.pendingSleep = { id: `greeting:${input.messageId}`, kind: 'sleep', decidedAt: now,
        hardDeadlineAt: nextSleep, round: 1, roundStartedAt: now, roundDeadlineAt: now + CHAT_SLEEP_ROUND_MS,
        sessionId: input.deferGreeting.sessionId, turnId: input.deferGreeting.messageId,
        sourceMessageIds: [input.deferGreeting.messageId],
        greeting: { fallbackAt: nextSleep, waitingUntil: now + CHAT_SLEEP_ROUND_MS } };
    }
    addEvent(next, { id: `schedule:${input.messageId}`, kind: 'schedule', at: now,
      ...(input.sleepAt !== undefined && nextSleep !== day.sleepTargetAt ? { sleepAt: nextSleep } : {}),
      ...(wake !== undefined && nextWake !== sleepWakeTarget(day.nightSleepPlan, day.nightSleepPlan.actualSleepAt ?? day.sleepTargetAt) ? { wakeAt: nextWake } : {}),
      toolCallId: input.messageId, ...(input.phase === 'near-status' ? { turnId: input.messageId } : {}),
      ...(chat ? { sessionId: chat.sessionId, turnId: chat.turnId, messageIds: chat.sourceMessageIds } : {}) });
    if (day.nightSleepPlan.actualSleepAt === undefined && next.nightSleepPlan.actualSleepAt !== undefined) {
      addEvent(next, { id: `${day.dateKey}:sleep`, kind: 'sleep', at: next.nightSleepPlan.actualSleepAt,
        sleepAt: next.nightSleepPlan.actualSleepAt, toolCallId: input.messageId,
        ...(input.phase === 'near-status' ? { turnId: input.messageId } : {}) });
    }
    await saveNightAndMorning(next, now);
    if (next.nightSleepPlan.actualSleepAt !== undefined) { await refreshSleepRecovery(next, now); await saveNightAndMorning(next, now); }
    return result('applied', next);
}

export async function updateSleepOpportunity(nightKey: string, phase: 'prepare' | 'wake',
  update: (current: SleepOpportunity | undefined, day: AssistantLifeDay) => SleepOpportunity | undefined, now = Date.now()) {
  return withSleepPlanWrite(async () => {
    const day = await loadAssistantLifeDay(nightKey);
    if (!day?.nightSleepPlan) return null;
    const opportunity = update(day.nightSleepPlan[phase], day);
    if (!opportunity) return null;
    await saveAssistantLifeDay({ ...day, sleepPlanUpdatedAt: now, nightSleepPlan: { ...day.nightSleepPlan, [phase]: opportunity } });
    return opportunity;
  });
}

export async function markSleepWakeSettled(nightKey: string, now: number, expectedRevision?: number) {
  return withSleepPlanWrite(async () => {
    const day = await loadAssistantLifeDay(nightKey);
    if (!day?.nightSleepPlan || day.nightSleepPlan.actualWakeAt
      || expectedRevision !== undefined && day.nightSleepPlan.revision !== expectedRevision) return;
    day.nightSleepPlan = { ...day.nightSleepPlan, actualWakeAt: now,
      morningAwakeAt: day.nightSleepPlan.morningAwakeAt ?? now, pendingSleep: undefined };
    addEvent(day, { id: `${nightKey}:get-up`, kind: 'get_up', at: now, wakeAt: now });
    await saveNightAndMorning(day, now);
  });
}

/** A receipt for the exact saved message; this path never requests a model. */
export async function recordSleepGreetingDelivery(boundary: SleepGreetingBoundary, receipt: SleepGreetingReceipt,
  now = Date.now()) {
  return withSleepPlanWrite(async () => {
    const day = await loadAssistantLifeDay(boundary.nightKey), plan = day?.nightSleepPlan;
    if (!day || !plan) return false;
    const opportunity = boundary.phase === 'return' ? undefined : plan[boundary.phase];
    if (opportunity?.greeting?.messageId === receipt.messageId
      || boundary.phase === 'return' && plan.events?.some(event => event.id === boundary.episodeId && event.greeting?.messageId === receipt.messageId)) return true;
    const live = plan.actualWakeAt === undefined && (boundary.phase !== 'prepare' || plan.actualSleepAt === undefined)
      && (boundary.phase !== 'return'
      || !plan.events?.some(event => (event.kind === 'sleep_return' || event.kind === 'morning_awake') && event.at >= boundary.dueAt));
    if (boundary.phase !== 'return' && opportunity?.messageId === receipt.messageId) {
      plan[boundary.phase] = { ...opportunity, greeting: receipt, deliveredAt: receipt.deliveredAt };
    }
    if (boundary.phase === 'return' && receipt.deliveredAt >= boundary.deadlineAt) return false;
    if (live && boundary.phase !== 'wake') startDeliveredSleepFarewell(day, {
      boundary: boundary.phase === 'prepare' ? { ...boundary, deadlineAt: day.sleepTargetAt } : boundary,
      receipt, now: receipt.deliveredAt });
    await saveNightAndMorning(day, now);
    return true;
  });
}

export async function recordSleepGreetingAttempt(boundary: SleepGreetingBoundary, opportunityId: string) {
  if (boundary.phase !== 'return') return;
  return withSleepPlanWrite(async () => {
    const day = await loadAssistantLifeDay(boundary.nightKey);
    const event = day?.nightSleepPlan?.events?.find(value => value.id === boundary.episodeId && value.kind === 'poke_awake');
    if (!day || !event || event.greetingOpportunityId && event.greetingOpportunityId !== opportunityId) throw Error('sleep-fragment-stale');
    event.greetingOpportunityId = opportunityId;
    await saveNightAndMorning(day, Date.now());
  });
}

export async function finishFailedSleepFarewell(nightKey: string, messageId: string, now = Date.now()) {
  return withSleepPlanWrite(async () => {
    const day = await loadAssistantLifeDay(nightKey), pending = day?.nightSleepPlan?.pendingSleep;
    if (!day || !pending?.greeting || pending.greeting.deliveredAt !== undefined || pending.turnId !== messageId
      || pending.kind !== 'sleep') return;
    pending.turnEndedAt = Math.min(now, pending.roundDeadlineAt);
    pending.dueAt = Math.max(now, day.sleepTargetAt);
    pending.greeting.waitingUntil = pending.dueAt;
    await saveNightAndMorning(day, now);
  });
}

/** Returned only by a successful new early-wake write; never reconstructed from a loaded night. */
export type FreshEarlyWake = {
  nightKey: string; revision: number; actualSleepAt: number; morningAwakeAt: number; formalWakeAt: number;
};

export async function settleSleepNight(now: number): Promise<FreshEarlyWake | undefined> {
  return withSleepPlanWrite(async () => {
    const day = await readRelevantSleepNight(now);
    if (!day?.nightSleepPlan || day.nightSleepPlan.actualWakeAt !== undefined) return;
    const before = JSON.stringify(day.nightSleepPlan);
    const plan = day.nightSleepPlan;
    rememberChatWindow(day, now);
    const pending = plan.pendingSleep;
    if (pending && pending.turnEndedAt === undefined && now >= pending.roundDeadlineAt) {
      pending.turnEndedAt = pending.roundDeadlineAt;
      pending.dueAt = pending.greeting ? pending.greeting.waitingUntil : pending.roundDeadlineAt + CHAT_SLEEP_QUIET_MS;
    }
    const due = pendingSleepDueAt(plan);
    const state = await loadAssistantState();
    rememberCurrentPoke(day, state, now);
    if (pending && due !== undefined && now >= due) {
      const settledAt = pending.greeting ? now : due;
      if (pending.kind === 'sleep') {
        const changed = changeNightSleepTime(day, settledAt);
        day.segments = changed.segments; day.sleepTargetAt = changed.sleepTargetAt;
        plan.actualSleepAt = settledAt;
      }
      addEvent(day, { id: `sleep:${pending.id}`, kind: pending.kind === 'return' ? 'sleep_return' : 'sleep', at: settledAt,
        sleepAt: settledAt, sessionId: pending.sessionId, turnId: pending.turnId,
        messageIds: pending.sourceMessageIds, toolCallId: pending.id });
      plan.pendingSleep = undefined;
      plan.revision += 1;
    } else if (!pending && plan.actualSleepAt === undefined && now >= day.sleepTargetAt
      && (state.manualWakeUntil ?? 0) <= now) {
      plan.actualSleepAt = day.sleepTargetAt;
      plan.revision += 1;
      addEvent(day, { id: `${day.dateKey}:sleep`, kind: 'sleep', at: day.sleepTargetAt, sleepAt: day.sleepTargetAt });
    }
    const poke = plan.events?.filter(event => event.kind === 'poke_awake').at(-1);
    if (!plan.pendingSleep && poke?.until !== undefined && now >= poke.until
      && !plan.events?.some(event => event.kind === 'sleep_return' && event.at >= poke.at)
      && !plan.events?.some(event => event.kind === 'morning_awake' && event.at >= poke.at)) {
      addEvent(day, { id: `return:${poke.id}`, kind: 'sleep_return', at: now, sleepAt: now });
    }
    if (JSON.stringify(plan) !== before) await saveNightAndMorning(day, now);
    if (plan.actualSleepAt !== undefined && !plan.pendingSleep && nightSleepPhaseAt(day, now) === 'sleeping') {
      const startedAt = Math.max(plan.actualSleepAt, ...(plan.events ?? []).filter(event => event.kind === 'sleep_return' && event.at <= now).map(event => event.at));
      if (plan.recovery?.sleepStartedAt !== startedAt) {
        await refreshSleepRecovery(day, startedAt);
        if (!plan.recovery) await refreshSleepRecovery(day, now);
        await saveNightAndMorning(day, now);
      }
    }
    const wakeAt = sleepWakeTarget(plan, plan.actualSleepAt ?? day.sleepTargetAt);
    let freshEarlyWake: FreshEarlyWake | undefined;
    let recoveredEarly = false;
    if (now < wakeAt && !plan.wake && plan.morningAwakeAt === undefined && !plan.pendingSleep && plan.recovery?.eligible
      && plan.recovery.estimatedAt !== undefined && now >= sleepWakeAlarmAt(day, now) && nightSleepPhaseAt(day, now) === 'sleeping') {
      const projection = await (await import('./lifeRhythm')).getSleepRecoveryProjection(now);
      recoveredEarly = canNaturallyWakeEarly(day, now, projection);
      if (!recoveredEarly) plan.recovery = { ...plan.recovery, checkedAt: now, estimatedAt: projection.recoveryAt };
    }
    if (!plan.wake && plan.actualSleepAt !== undefined && plan.morningAwakeAt === undefined
      && !plan.pendingSleep && (now >= wakeAt || recoveredEarly)) {
      plan.morningAwakeAt = recoveredEarly ? now : wakeAt;
      addEvent(day, { id: `${day.dateKey}:morning-awake`, kind: 'morning_awake', at: plan.morningAwakeAt });
      if (recoveredEarly) freshEarlyWake = { nightKey: day.dateKey, revision: plan.revision,
        actualSleepAt: plan.actualSleepAt, morningAwakeAt: plan.morningAwakeAt, formalWakeAt: wakeAt };
    }
    if (plan.morningAwakeAt !== undefined && plan.actualWakeAt === undefined && now >= wakeAt
      && (plan.wake && ['complete', 'failed', 'skipped'].includes(plan.wake.status)
        || plan.events?.some(event => event.kind === 'schedule' && event.wakeAt !== undefined && event.at >= plan.morningAwakeAt!))) {
      plan.actualWakeAt = wakeAt;
      addEvent(day, { id: `${day.dateKey}:get-up`, kind: 'get_up', at: wakeAt, wakeAt });
    }
    if (JSON.stringify(plan) !== before) await saveNightAndMorning(day, now);
    return freshEarlyWake;
  });
}

type ChatSleepTurn = { sessionId: string; turnId: string; sourceMessageIds?: string[]; now?: number; replySaved?: boolean };

function wasChatSleepTurnSuperseded(events: SleepPlanEvent[] | undefined, input: ChatSleepTurn) {
  return events?.some(event => (event.kind === 'schedule' || event.kind === 'sleep' || event.kind === 'sleep_return')
    && event.sessionId === input.sessionId && event.turnId !== input.turnId && event.messageIds?.includes(input.turnId));
}

export async function captureChatSleepContext(input: ChatSleepTurn, readOnly = false): Promise<ChatSleepPlanContext | null> {
  return withSleepPlanWrite(async () => {
    const now = input.now ?? Date.now();
    const day = await readRelevantSleepNight(now);
    if (!day?.nightSleepPlan || day.nightSleepPlan.actualWakeAt !== undefined) return null;
    const state = await loadAssistantState();
    const plan = day.nightSleepPlan;
    const before = JSON.stringify(plan);
    if (!readOnly) {
      rememberChatWindow(day, now);
      rememberCurrentPoke(day, state, now);
    }
    let mode: ChatSleepPlanContext['mode'] | undefined;
    let hardDeadlineAt: number | undefined;
    if (state.wakeSource === 'poke' && ((state.manualWakeUntil ?? 0) > now || plan.pendingSleep?.kind === 'return')
      && plan.actualSleepAt !== undefined
      && nightSleepPhaseAt(day, now) !== 'sleeping') {
      mode = 'poke'; hardDeadlineAt = state.manualWakeUntil;
    } else if (plan.morningAwakeAt !== undefined && nightSleepPhaseAt(day, now) === 'awake') mode = 'morning';
    else if (plan.actualSleepAt === undefined && plan.chatOpenedAt !== undefined && state.lifeMode !== 'sleeping') {
      mode = 'bedtime'; hardDeadlineAt = plan.pendingSleep?.hardDeadlineAt ?? day.sleepTargetAt;
    }
    if (!readOnly && JSON.stringify(plan) !== before) await saveNightAndMorning(day, now);
    return mode ? { ...sleepContext(day, now), mode, sessionId: input.sessionId, turnId: input.turnId,
      sourceMessageIds: input.sourceMessageIds, manualWakeUntil: state.manualWakeUntil, hardDeadlineAt } : null;
  });
}

export async function commitChatSleepScheduleDecision(input: {
  context: ChatSleepPlanContext; input: Record<string, unknown>; callId: string; now?: number;
}): Promise<SleepScheduleResult> {
  return withSleepPlanWrite(async () => {
    const now = input.now ?? Date.now(), context = input.context, values = input.input;
    const day = await loadAssistantLifeDay(context.nightKey);
    const result = (status: SleepScheduleResult['status'], sleepAt?: number): SleepScheduleResult => ({
      subject: 'I', ok: ['applied', 'unchanged', 'pending_sleep'].includes(status), status,
      sleepAt: sleepAt !== undefined ? formatSleepLocalTime(sleepAt) : day ? formatSleepLocalTime(day.sleepTargetAt) : null,
      wakeAt: day?.nightSleepPlan ? formatSleepLocalTime(sleepWakeTarget(day.nightSleepPlan, day.nightSleepPlan.actualSleepAt ?? day.sleepTargetAt)) : null,
    });
    if (!day?.nightSleepPlan) return result('unavailable');
    const plan = day.nightSleepPlan;
    const previous = plan.events?.find(event => event.toolCallId === input.callId);
    if (previous) return result(previous.kind === 'sleep_intent' ? 'pending_sleep' : 'unchanged', previous.kind === 'sleep_intent' ? previous.at : undefined);
    if (plan.revision !== context.revision || plan.actualWakeAt !== undefined) return result('stale');
    const state = await loadAssistantState();
    const isPoke = context.mode === 'poke';
    const validMode = isPoke ? state.wakeSource === 'poke' && state.manualWakeUntil === context.manualWakeUntil
      && ((state.manualWakeUntil ?? 0) > now || plan.pendingSleep?.kind === 'return') && plan.actualSleepAt !== undefined
      && nightSleepPhaseAt(day, now) === 'awake'
      : context.mode === 'morning' ? plan.morningAwakeAt !== undefined && nightSleepPhaseAt(day, now) === 'awake'
        : plan.actualSleepAt === undefined && plan.chatOpenedAt !== undefined && state.lifeMode !== 'sleeping';
    if (!validMode) return result('stale');
    if (Object.keys(values).some(key => key !== 'sleepAt' && key !== 'wakeAt')
      || values.sleepAt === undefined && values.wakeAt === undefined) return result('invalid_time');
    const sleep = values.sleepAt === undefined ? undefined : parseSleepScheduleTime(values.sleepAt);
    const wake = values.wakeAt === undefined ? undefined : parseSleepScheduleTime(values.wakeAt);
    if (sleep === null || wake === null || sleep !== undefined && sleep < context.requestAt - 1000
      || wake !== undefined && wake < context.requestAt - 1000
      || context.mode === 'morning' && sleep !== undefined
      || isPoke && (wake !== undefined || sleep === undefined || sleep > now)) return result('invalid_time');
    if (sleep !== undefined && sleep <= now) {
      const nextWake = wake ?? sleepWakeTarget(plan, now);
      if (!isPoke && nextWake - now < MIN_MAIN_SLEEP_MS || wake !== undefined && wake <= now) return result('invalid_time');
      const hardDeadlineAt = isPoke ? state.manualWakeUntil! : plan.pendingSleep?.hardDeadlineAt ?? day.sleepTargetAt;
      const roundStartedAt = context.turnStartedAt ?? context.requestAt;
      if (!plan.pendingSleep && now >= roundStartedAt + CHAT_SLEEP_ROUND_MS) return result('stale');
      plan.pendingSleep ??= { id: input.callId, kind: isPoke ? 'return' : 'sleep', decidedAt: now,
        hardDeadlineAt, round: 1, roundStartedAt, roundDeadlineAt: roundStartedAt + CHAT_SLEEP_ROUND_MS,
        sessionId: context.sessionId, turnId: context.turnId, sourceMessageIds: context.sourceMessageIds,
        ...(isPoke ? { greeting: { fallbackAt: hardDeadlineAt, waitingUntil: hardDeadlineAt } } : {}) };
      if (wake !== undefined) plan.explicitWakeAt = wake;
      plan.lastMessageId = input.callId; plan.revision += 1;
      addEvent(day, { id: `intent:${input.callId}`, kind: 'sleep_intent', at: now, sleepAt: now,
        ...(wake !== undefined ? { wakeAt: wake } : {}), sessionId: context.sessionId, turnId: context.turnId,
        messageIds: context.sourceMessageIds, toolCallId: input.callId });
      if (!isPoke && !plan.prepare && !plan.prepareStatus) plan.prepare = { status: 'skipped', requestCount: 0 };
      else if (!isPoke && plan.prepare && ['requesting', 'retry'].includes(plan.prepare.status)) {
        plan.prepare = { ...plan.prepare, status: 'skipped', retryAt: undefined };
      }
      await saveNightAndMorning(day, now);
      return result('pending_sleep', now);
    }
    return commitSleepScheduleDecisionUnlocked({ context, ...values, messageId: input.callId,
      phase: context.mode === 'morning' ? 'wake' : 'prepare', now }, context);
  });
}

export async function beginChatSleepTurn(input: ChatSleepTurn, allowNextRound = true) {
  return withSleepPlanWrite(async () => {
    const now = input.now ?? Date.now(), day = await readRelevantSleepNight(now), plan = day?.nightSleepPlan;
    if (!day || !plan || plan.actualWakeAt !== undefined) return;
    if (wasChatSleepTurnSuperseded(plan.events, input)) return;
    const pending = plan.pendingSleep;
    if (pending) {
      // A reply may cover several saved you messages; accepting one new message alone cannot take over an in-flight turn.
      if (pending.sessionId === input.sessionId && pending.turnId !== input.turnId
        && pending.turnEndedAt === undefined && now < pending.roundDeadlineAt
        && input.sourceMessageIds?.includes(pending.turnId) && input.sourceMessageIds.at(-1) === input.turnId) {
        plan.pendingSleep = { ...pending, turnId: input.turnId, sourceMessageIds: [...input.sourceMessageIds] };
        await saveNightAndMorning(day, now);
        return;
      }
      if (!allowNextRound || pending.sessionId === input.sessionId && pending.turnId === input.turnId || pending.round === 2
        || pending.greeting && now >= pending.greeting.waitingUntil
        || pending.turnEndedAt === undefined || now >= pendingSleepDueAt(plan)!) return;
      plan.pendingSleep = { ...pending, round: 2, roundStartedAt: now, roundDeadlineAt: now + CHAT_SLEEP_ROUND_MS,
        sessionId: input.sessionId, turnId: input.turnId, sourceMessageIds: input.sourceMessageIds,
        turnEndedAt: undefined, dueAt: undefined };
    } else {
      const state = await loadAssistantState();
      rememberCurrentPoke(day, state, now);
      const isPoke = state.wakeSource === 'poke' && (state.manualWakeUntil ?? 0) > now;
      const target = isPoke ? state.manualWakeUntil! : day.sleepTargetAt;
      if ((!isPoke && plan.actualSleepAt !== undefined) || state.lifeMode === 'sleeping'
        || now < target - CHAT_SLEEP_QUIET_MS || now >= target) return;
      rememberChatWindow(day, now);
      plan.pendingSleep = { id: `farewell:${input.sessionId}:${input.turnId}`, kind: isPoke ? 'return' : 'sleep',
        decidedAt: now, hardDeadlineAt: target, round: 1, roundStartedAt: now, roundDeadlineAt: now + CHAT_SLEEP_ROUND_MS,
        sessionId: input.sessionId, turnId: input.turnId, sourceMessageIds: input.sourceMessageIds,
        greeting: { fallbackAt: target, waitingUntil: target } };
    }
    await saveNightAndMorning(day, now);
  });
}

export async function finishChatSleepTurn(input: ChatSleepTurn) {
  return withSleepPlanWrite(async () => {
    const now = input.now ?? Date.now(), day = await readRelevantSleepNight(now), pending = day?.nightSleepPlan?.pendingSleep;
    if (!day || !pending || pending.sessionId !== input.sessionId || pending.turnId !== input.turnId
      || pending.turnEndedAt !== undefined) return;
    const endedAt = Math.min(now, pending.roundDeadlineAt);
    const greeting = pending.greeting;
    const successful = input.replySaved === true && now <= pending.roundDeadlineAt;
    const waitingUntil = greeting ? successful ? now + CHAT_SLEEP_QUIET_MS : greeting.waitingUntil : undefined;
    const dueAt = greeting ? Math.max(waitingUntil!, pending.kind === 'sleep' ? day.sleepTargetAt : -Infinity) : endedAt + CHAT_SLEEP_QUIET_MS;
    day.nightSleepPlan!.pendingSleep = { ...pending, turnEndedAt: endedAt,
      sourceMessageIds: input.sourceMessageIds ?? pending.sourceMessageIds,
      ...(greeting ? { greeting: { ...greeting, ...(successful ? { deliveredAt: now } : {}), waitingUntil: waitingUntil! } } : {}),
      dueAt };
    await saveNightAndMorning(day, now);
  });
}

export async function markMorningAwake(nightKey: string, now: number) {
  return withSleepPlanWrite(async () => {
    const day = await loadAssistantLifeDay(nightKey), plan = day?.nightSleepPlan;
    if (!day || !plan || plan.actualSleepAt === undefined || plan.actualWakeAt !== undefined) return;
    plan.morningAwakeAt = now; plan.pendingSleep = undefined; plan.revision += 1;
    addEvent(day, { id: `${nightKey}:morning-awake`, kind: 'morning_awake', at: now });
    await saveNightAndMorning(day, now);
  });
}

export async function recordSleepPokeAwake(now: number, until: number) {
  return withSleepPlanWrite(async () => {
    const day = await readRelevantSleepNight(now), plan = day?.nightSleepPlan;
    if (!day || !plan || plan.actualSleepAt === undefined || plan.actualWakeAt !== undefined
      || nightSleepPhaseAt(day, now) !== 'sleeping') return;
    addEvent(day, { id: `poke:${now}`, kind: 'poke_awake', at: now, until });
    await saveNightAndMorning(day, now);
  });
}

export async function isChatSleepReplyCurrent(input: ChatSleepTurn & { startedAt: number }) {
  const now = input.now ?? Date.now(), previous = new Date(now); previous.setDate(previous.getDate() - 1);
  const days = await loadAssistantLifeDays([getLocalDateKey(previous), getLocalDateKey(new Date(now))]);
  const relevant = await readRelevantSleepNight(now);
  if (relevant && !days.some(day => day?.dateKey === relevant.dateKey)) days.push(relevant);
  if (days.some(day => wasChatSleepTurnSuperseded(day?.nightSleepPlan?.events, input))) return false;
  const storedPending = relevant?.nightSleepPlan?.pendingSleep;
  // A greeting at the original half-hour lead does not close ordinary chat before the actual bedtime.
  const pending = storedPending?.greeting && storedPending.kind === 'sleep'
    && storedPending.turnEndedAt !== undefined && now < relevant!.sleepTargetAt
    && (storedPending.round === 2 || now >= storedPending.greeting.waitingUntil) ? undefined : storedPending;
  if (pending && (pending.sessionId !== input.sessionId || pending.turnId !== input.turnId
    || pending.turnEndedAt !== undefined || now >= pending.roundDeadlineAt)) return false;
  if (relevant && nightSleepPhaseAt(relevant, now) === 'sleeping') return false;
  return !days.some(day => day?.nightSleepPlan && (
    day.nightSleepPlan.actualSleepAt !== undefined && day.nightSleepPlan.actualSleepAt >= input.startedAt
      && day.nightSleepPlan.actualSleepAt <= now
    || day.nightSleepPlan.events?.some(event => (event.kind === 'sleep' || event.kind === 'sleep_return')
      && event.at >= input.startedAt && event.at <= now)));
}

export async function upcomingSleepNights(now: number) {
  const currentKey = getLocalDateKey(new Date(now));
  const previousDate = new Date(now);
  previousDate.setDate(previousDate.getDate() - 1);
  const previousKey = getLocalDateKey(previousDate);
  return withSleepPlanWrite(async () => {
    const active = await readRelevantSleepNight(now);
    if (active?.nightSleepPlan && active.nightSleepPlan.actualWakeAt === undefined) return [active];
    const days = [await ensureSleepNight(currentKey)];
    const previous = await loadAssistantLifeDay(previousKey);
    if (previous && (localSleepNightKey(now) === previousKey || (previous.nightSleepPlan && (!previous.nightSleepPlan.actualWakeAt || sleepWakeTarget(previous.nightSleepPlan, previous.nightSleepPlan.actualSleepAt ?? previous.sleepTargetAt) > now)))) {
      days.unshift(await ensureSleepNight(previousKey));
    }
    return days;
  });
}
