import { assistantLifeStateStorageBridge as AsyncStorage } from '../sync/syncAssistantLifeStateStorageBridge';
import type { SyncPersistenceMode } from '../sync/syncPersistenceMode';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { actualSleepDurationMs, isNightWakeDecisionPending, nightSleepPhaseAt, pendingSleepDueAt, sleepPhaseBoundaries, sleepWakeTarget } from './sleepPlanPolicy';

import type { AssistantLifeMode } from '../ai/assistantState';
import {
  getLocalDateKey,
  loadAssistantLifeDay,
  resolveAssistantLifeSegment,
  type AssistantLifeDay,
} from '../ai/assistantLifeTimeline';
import { calculateJunluoDesireSnapshot } from './junluoDesireMetabolism';
import { loadJunluoAffectState, loadJunluoDesireState } from './junluoInnerStateStore';
import { createDefaultJunluoAffectState, createDefaultJunluoDesireState,
  upgradeJunluoAffectState, upgradeJunluoDesireState } from './junluoInnerStatePersistence';
import { JUNLUO_INNER_STATE_KEYS } from './junluoInnerState';

export const LIFE_RHYTHM_STATE_KEY = 'junluo.life.rhythm.state.v1';

const RHYTHM_SCHEMA_VERSION = 2 as const;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const STEP_MS = 15 * MINUTE_MS;
const MAX_CATCH_UP_MS = 72 * HOUR_MS;
const LONG_GAP_REPLAY_MS = 24 * HOUR_MS;

export type LifeRhythmPhase = 'awake' | 'sleeping';

export type LifeRhythmState = {
  alertness: number;
  lastSleepDurationMinutes?: number;
  lastSleepEndedAt?: number;
  lastSleepStartedAt?: number;
  lastSleepWasMain?: boolean;
  lastTickAt: number;
  lastWakeAt?: number;
  phase: LifeRhythmPhase;
  phaseStartedAt: number;
  restQuality: number;
  schemaVersion: typeof RHYTHM_SCHEMA_VERSION;
  sleepDebt: number;
  sleepPressure: number;
  updatedAt: number;
  wakePressure: number;
};

export type RhythmSleepEpisode = {
  durationMinutes: number;
  endedAt?: number;
  id: string;
  isMain: boolean;
  startedAt: number;
};

export type RhythmSnapshot = LifeRhythmState & {
  label: string;
  modeHint: 'sleepy' | 'awake' | 'resting' | 'steady';
  sleepEpisode?: RhythmSleepEpisode;
};

export type RhythmPhaseInterval = {
  endAt: number;
  phase: LifeRhythmPhase;
  scheduledSleeping: boolean;
  startAt: number;
  /** Only the saved, actual wake-from-sleep event can enable this multiplier. */
  pokeAwakeStartedAt?: number;
  sleepEpisode?: RhythmSleepEpisode;
};

export type RhythmTickOptions = {
  lifeMode?: AssistantLifeMode;
  manualOverrideStartedAt?: number;
  manualSleepUntil?: number;
  manualWakeUntil?: number;
  now?: number;
};

export type RhythmInfluences = {
  rest: number;
  exploreWorld: number;
  ownTime: number;
  speakToYou: number;
  strain: number;
};

const PHASE_SEEDS: Record<LifeRhythmPhase, Pick<LifeRhythmState, 'alertness' | 'restQuality' | 'sleepDebt' | 'sleepPressure' | 'wakePressure'>> = {
  awake: {
    alertness: 0.68,
    restQuality: 0.62,
    sleepDebt: 0.18,
    sleepPressure: 0.3,
    wakePressure: 0.68,
  },
  sleeping: {
    alertness: 0.42,
    restQuality: 0.62,
    sleepDebt: 0.22,
    sleepPressure: 0.64,
    wakePressure: 0.2,
  },
};

function clamp(value: number, min = 0, max = 1) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function finiteTimestamp(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function hourOfDay(now: number) {
  const date = new Date(now);
  return date.getHours() + date.getMinutes() / 60;
}

function inferPhase(now: number): LifeRhythmPhase {
  const hour = hourOfDay(now);
  return hour >= 22.5 || hour < 7 ? 'sleeping' : 'awake';
}

function inferredPhaseStartAt(now: number, phase: LifeRhythmPhase) {
  const date = new Date(now);
  if (phase === 'awake') {
    date.setHours(7, 0, 0, 0);
    if (date.getTime() > now) date.setDate(date.getDate() - 1);
  } else {
    date.setHours(22, 30, 0, 0);
    if (date.getTime() > now) date.setDate(date.getDate() - 1);
  }
  return date.getTime();
}

function blendLegacy(value: unknown, seed: number) {
  const oldValue = typeof value === 'number' && Number.isFinite(value) ? clamp(value) : seed;
  return clamp(oldValue * 0.35 + seed * 0.65);
}

export function normalizeRhythmState(value: unknown, now = Date.now(), phaseHint?: LifeRhythmPhase): LifeRhythmState {
  const candidate = value && typeof value === 'object' ? value as Partial<LifeRhythmState> : {};
  const isV2 = candidate.schemaVersion === RHYTHM_SCHEMA_VERSION
    && (candidate.phase === 'awake' || candidate.phase === 'sleeping');
  const phase = isV2 ? candidate.phase as LifeRhythmPhase : phaseHint ?? inferPhase(now);
  const seed = PHASE_SEEDS[phase];
  // An older caller is not authority to rewind values already settled by a newer tick.
  const savedTickAt = finiteTimestamp(candidate.lastTickAt) ?? now;
  const lastTickAt = isV2 ? savedTickAt : Math.min(now, savedTickAt);
  const phaseStartedAt = isV2
    ? Math.min(lastTickAt, finiteTimestamp(candidate.phaseStartedAt) ?? inferredPhaseStartAt(lastTickAt, phase))
    : inferredPhaseStartAt(now, phase);
  return {
    alertness: isV2 ? clamp(candidate.alertness ?? seed.alertness) : blendLegacy(candidate.alertness, seed.alertness),
    lastSleepDurationMinutes: typeof candidate.lastSleepDurationMinutes === 'number'
      && Number.isFinite(candidate.lastSleepDurationMinutes) && candidate.lastSleepDurationMinutes >= 0
      ? candidate.lastSleepDurationMinutes : undefined,
    lastSleepEndedAt: finiteTimestamp(candidate.lastSleepEndedAt),
    lastSleepStartedAt: finiteTimestamp(candidate.lastSleepStartedAt),
    lastSleepWasMain: typeof candidate.lastSleepWasMain === 'boolean' ? candidate.lastSleepWasMain : undefined,
    lastTickAt,
    lastWakeAt: isV2 ? finiteTimestamp(candidate.lastWakeAt) : phase === 'awake' ? phaseStartedAt : undefined,
    phase,
    phaseStartedAt,
    restQuality: isV2 ? clamp(candidate.restQuality ?? seed.restQuality, 0.2, 0.92) : blendLegacy(candidate.restQuality, seed.restQuality),
    schemaVersion: RHYTHM_SCHEMA_VERSION,
    sleepDebt: isV2 ? clamp(candidate.sleepDebt ?? seed.sleepDebt) : blendLegacy(candidate.sleepDebt, seed.sleepDebt),
    sleepPressure: isV2 ? clamp(candidate.sleepPressure ?? seed.sleepPressure) : blendLegacy(candidate.sleepPressure, seed.sleepPressure),
    updatedAt: finiteTimestamp(candidate.updatedAt) ?? now,
    wakePressure: isV2 ? clamp(candidate.wakePressure ?? seed.wakePressure) : blendLegacy(candidate.wakePressure, seed.wakePressure),
  };
}

function nightFactor(now: number) {
  const hour = hourOfDay(now);
  if (hour >= 23 || hour < 5) return 1;
  if (hour >= 21 || hour < 7) return 0.55;
  return 0;
}

function dayFactor(now: number) {
  const hour = hourOfDay(now);
  if (hour >= 8 && hour < 18) return 1;
  if (hour >= 6 && hour < 22) return 0.55;
  return 0;
}

function isNightMinute(now: number) {
  const hour = new Date(now).getHours();
  return hour >= 23 || hour < 7;
}

export function isMainSleepInterval(startedAt: number, endedAt: number) {
  const durationMinutes = Math.max(0, (endedAt - startedAt) / MINUTE_MS);
  if (durationMinutes < 90) return false;
  let nightMinutes = 0;
  for (let cursor = startedAt; cursor < endedAt; cursor += STEP_MS) {
    const endAt = Math.min(endedAt, cursor + STEP_MS);
    if (isNightMinute(cursor + (endAt - cursor) / 2)) nightMinutes += (endAt - cursor) / MINUTE_MS;
  }
  return nightMinutes >= 30;
}

function completeSleepEpisode(state: LifeRhythmState, endedAt: number): LifeRhythmState {
  const startedAt = state.lastSleepStartedAt ?? state.phaseStartedAt;
  const durationMinutes = (state.lastSleepEndedAt === undefined || state.lastSleepEndedAt === endedAt) && state.lastSleepDurationMinutes !== undefined
    ? state.lastSleepDurationMinutes + (state.lastSleepEndedAt === undefined ? Math.max(0, endedAt - state.lastTickAt) / MINUTE_MS : 0)
    : Math.max(0, (endedAt - startedAt) / MINUTE_MS);
  return {
    ...state,
    lastSleepDurationMinutes: durationMinutes,
    lastSleepEndedAt: endedAt,
    lastSleepStartedAt: startedAt,
    lastSleepWasMain: state.lastSleepWasMain === true || isMainSleepInterval(startedAt, endedAt),
  };
}

function transitionPhase(state: LifeRhythmState, phase: LifeRhythmPhase, at: number) {
  if (state.phase === phase) return state;
  if (phase === 'sleeping') {
    return {
      ...state,
      lastSleepDurationMinutes: 0,
      lastSleepEndedAt: undefined,
      lastSleepStartedAt: at,
      lastSleepWasMain: undefined,
      phase,
      phaseStartedAt: at,
      wakePressure: Math.min(state.wakePressure, 0.25),
    };
  }
  const completed = completeSleepEpisode(state, at);
  return {
    ...completed,
    lastWakeAt: at,
    phase,
    phaseStartedAt: at,
  };
}

export function advanceRhythmState(
  initial: LifeRhythmState,
  intervals: RhythmPhaseInterval[],
  influences: RhythmInfluences,
): LifeRhythmState {
  const fatigue = clamp(influences.rest);
  const stress = clamp(influences.strain);
  const curiosity = clamp(influences.exploreWorld);
  const reflection = clamp(influences.ownTime);
  const social = clamp(influences.speakToYou);
  const attachment = 0.5;
  let state = { ...initial };

  for (const interval of intervals) {
    if (interval.endAt <= interval.startAt) continue;
    state = transitionPhase(state, interval.phase, interval.startAt);
    const hours = (interval.endAt - interval.startAt) / HOUR_MS;
    const midpoint = interval.startAt + (interval.endAt - interval.startAt) / 2;
    const night = nightFactor(midpoint);
    const day = dayFactor(midpoint);

    if (interval.phase === 'awake') {
      const pokeHours = interval.pokeAwakeStartedAt === undefined ? 0 : Math.max(0,
        Math.min(interval.endAt, interval.pokeAwakeStartedAt + 15 * MINUTE_MS)
          - Math.max(interval.startAt, interval.pokeAwakeStartedAt)) / HOUR_MS;
      const sleepPressure = clamp(
        state.sleepPressure
          + (hours + pokeHours) * 1.25 * (0.022 + night * 0.032 + fatigue * 0.012 + stress * 0.006 - Math.max(curiosity, reflection) * 0.006),
      );
      state = {
        ...state,
        alertness: clamp(
          state.alertness
            - hours * (0.008 + sleepPressure * 0.015 + state.sleepDebt * 0.008 - Math.max(curiosity, social) * 0.006),
        ),
        lastTickAt: interval.endAt,
        restQuality: clamp(
          state.restQuality + (0.62 - state.restQuality) * (1 - Math.exp(-0.03 * hours)),
          0.2,
          0.92,
        ),
        sleepDebt: clamp(
          state.sleepDebt + hours * (interval.scheduledSleeping ? 0.055 : Math.max(0, sleepPressure - 0.65) * 0.008),
        ),
        sleepPressure,
        wakePressure: clamp(state.wakePressure - hours * (0.045 + night * 0.025)),
      };
    } else {
      const targetRestQuality = clamp(0.78 - stress * 0.28 + attachment * 0.06, 0.3, 0.9);
      state = {
        ...state,
        alertness: clamp(state.alertness + hours * (0.025 + state.restQuality * 0.025)),
        lastTickAt: interval.endAt,
        lastSleepDurationMinutes: ((state.lastSleepEndedAt === undefined ? state.lastSleepDurationMinutes
          : undefined) ?? Math.max(0, (interval.startAt - (state.lastSleepStartedAt ?? state.phaseStartedAt)) / MINUTE_MS)) + hours * 60,
        lastSleepEndedAt: undefined,
        restQuality: clamp(
          state.restQuality + (targetRestQuality - state.restQuality) * (1 - Math.exp(-hours / 3)),
          0.2,
          0.92,
        ),
        sleepDebt: clamp(state.sleepDebt - hours * (0.045 + state.restQuality * 0.035)),
        sleepPressure: clamp(state.sleepPressure - hours * (0.05 + state.restQuality * 0.03)),
        wakePressure: clamp(state.wakePressure + hours * (0.055 + day * 0.045)),
      };
    }
    if (interval.sleepEpisode) {
      const episode = interval.sleepEpisode;
      state = { ...state, lastSleepStartedAt: episode.startedAt, lastSleepEndedAt: episode.endedAt,
        lastSleepDurationMinutes: episode.durationMinutes, lastSleepWasMain: episode.isMain };
    }
  }
  return {
    ...state,
    updatedAt: intervals[intervals.length - 1]?.endAt ?? state.updatedAt,
  };
}

export function isSleepRecovered(state: Pick<LifeRhythmState, 'sleepPressure' | 'sleepDebt'>): boolean {
  return Number.isFinite(state.sleepPressure) && Number.isFinite(state.sleepDebt)
    && state.sleepPressure >= 0 && state.sleepPressure <= .10 && state.sleepDebt >= 0 && state.sleepDebt <= .08;
}

/** Read-only forecast through the production sleep calculation, not a second recovery formula. */
export function estimateSleepRecoveryAt(state: LifeRhythmState, now: number, influences: RhythmInfluences): number | undefined {
  if (!Number.isFinite(now) || now <= 0 || isSleepRecovered(state)
    || [state.sleepPressure, state.sleepDebt, state.restQuality, ...Object.values(influences)]
      .some(value => !Number.isFinite(value) || value < -1 || value > 1)
    || state.sleepPressure < 0 || state.sleepDebt < 0 || state.restQuality < .2) return undefined;
  let projected = { ...state };
  // At the slowest existing recovery rate normalized pressure/debt both recover within 24 h.
  for (let cursor = now; cursor < now + 24 * HOUR_MS; cursor += STEP_MS) {
    const endAt = cursor + STEP_MS;
    const advanceTo = (at: number) => advanceRhythmState(projected,
      [{ startAt: cursor, endAt: at, phase: 'sleeping', scheduledSleeping: true }], influences);
    const next = advanceTo(endAt);
    if (isSleepRecovered(next)) {
      let lower = cursor, upper = endAt;
      while (upper - lower > 1) {
        const middle = Math.floor((lower + upper) / 2);
        if (isSleepRecovered(advanceTo(middle))) upper = middle;
        else lower = middle;
      }
      return upper;
    }
    projected = next;
  }
  return undefined;
}

function defaultScheduledPhase(now: number): LifeRhythmPhase {
  return inferPhase(now);
}

/** Interpret a saved, due wake arrangement without inventing a get-up/model decision.
 * Reads also serve desire settlement and run inside the sleep writer's projections.
 * Never call that writer here: it would re-enter its own serialized queue.
 */
function withDueWakeBoundary(day: AssistantLifeDay | null) {
  let plan = day?.nightSleepPlan;
  if (!day || !plan || plan.actualWakeAt !== undefined || plan.wake?.status === 'requesting') return day;
  const pending = plan.pendingSleep;
  if (pending) {
    const dueAt = pendingSleepDueAt(plan)!;
    plan = { ...plan, pendingSleep: undefined,
      actualSleepAt: pending.kind === 'sleep' ? dueAt : plan.actualSleepAt,
      events: [...(plan.events ?? []),
        { id: `${pending.id}:quiet`, kind: 'morning_awake', at: pending.decidedAt },
        { id: `sleep:${pending.id}`, kind: pending.kind === 'return' ? 'sleep_return' : 'sleep', at: dueAt }] };
    day = { ...day, nightSleepPlan: plan, sleepTargetAt: pending.kind === 'sleep' ? dueAt : day.sleepTargetAt };
  }
  // Default bedtime is a local deadline too; projecting it never executes an activity.
  if (plan.actualSleepAt === undefined) {
    plan = { ...plan, actualSleepAt: day.sleepTargetAt };
    day = { ...day, nightSleepPlan: plan };
  }
  const wakeAt = sleepWakeTarget(plan, plan.actualSleepAt ?? day.sleepTargetAt);
  // Real saved events win; this is not a repair of previously polluted history.
  if ((plan.morningAwakeAt ?? -Infinity) > wakeAt || (plan.events ?? []).some(event =>
    event.kind === 'sleep_return' && event.at >= wakeAt
      || ['morning_awake', 'get_up'].includes(event.kind) && event.at > wakeAt)) return day;
  return { ...day, nightSleepPlan: { ...plan,
    morningAwakeAt: plan.morningAwakeAt ?? wakeAt,
    // A calculation-only end releases the old night before the following night's schedule.
    // Neither this projection nor its event is persisted or used as a model decision.
    actualWakeAt: wakeAt,
    events: [...(plan.events ?? []), { id: `${day.dateKey}:due-wake-boundary`, kind: 'morning_awake' as const, at: wakeAt }],
  } };
}

function activeRecordedNight(days: Iterable<AssistantLifeDay | null | undefined>, at: number) {
  return [...days].filter((day): day is AssistantLifeDay => !!day?.nightSleepPlan
    && Math.min(day.nightSleepPlan.actualSleepAt ?? day.nightSleepPlan.originalSleepAt, day.nightSleepPlan.originalSleepAt) <= at
    && (day.nightSleepPlan.actualWakeAt === undefined || at < day.nightSleepPlan.actualWakeAt))
    .sort((a, b) => Number(b.nightSleepPlan!.actualSleepAt !== undefined) - Number(a.nightSleepPlan!.actualSleepAt !== undefined)
      || a.nightSleepPlan!.originalSleepAt - b.nightSleepPlan!.originalSleepAt)[0];
}

function recordedSleepEpisode(day: AssistantLifeDay | undefined, at: number): RhythmSleepEpisode | undefined {
  const plan = day?.nightSleepPlan;
  if (!day || plan?.actualSleepAt === undefined || at < plan.actualSleepAt) return undefined;
  const awake = nightSleepPhaseAt(day, at) === 'awake';
  const endedAt = awake ? Math.max(plan.actualSleepAt, ...[plan.morningAwakeAt, plan.actualWakeAt,
    ...(plan.events ?? []).filter(event => ['poke_awake', 'morning_awake', 'get_up'].includes(event.kind)).map(event => event.at)]
    .filter((time): time is number => time !== undefined && time <= at)) : undefined;
  return { id: `sleep-${plan.actualSleepAt}`, startedAt: plan.actualSleepAt, endedAt,
    durationMinutes: actualSleepDurationMs(day, at) / MINUTE_MS, isMain: true };
}

async function scheduledPhaseAt(now: number, cache: Map<string, Awaited<ReturnType<typeof loadAssistantLifeDay>>>) {
  const previousDate = new Date(now);
  previousDate.setDate(previousDate.getDate() - 1);
  const previousKey = getLocalDateKey(previousDate);
  if (!cache.has(previousKey)) cache.set(previousKey, withDueWakeBoundary(await loadAssistantLifeDay(previousKey)));
  const previous = cache.get(previousKey);
  const dateKey = getLocalDateKey(new Date(now));
  if (!cache.has(dateKey)) cache.set(dateKey, withDueWakeBoundary(await loadAssistantLifeDay(dateKey)));
  const day = cache.get(dateKey);
  const active = activeRecordedNight(cache.values(), now);
  const activePhase = active && nightSleepPhaseAt(active, now);
  if (activePhase) return activePhase;
  const currentActual = day && nightSleepPhaseAt(day, now);
  if (currentActual) return currentActual;
  const previousActual = previous && nightSleepPhaseAt(previous, now);
  if (previousActual && (!day || now < day.sleepTargetAt)) return previousActual;
  if (isNightWakeDecisionPending(previous ?? null, now)) return 'sleeping';
  if (!day?.segments.length) return defaultScheduledPhase(now);
  return resolveAssistantLifeSegment(day, now).lifeMode === 'sleeping' ? 'sleeping' : 'awake';
}

export async function buildPhaseIntervals(
  startAt: number,
  endAt: number,
  options: RhythmTickOptions,
): Promise<RhythmPhaseInterval[]> {
  if (startAt === endAt) return [];
  const intervals: RhythmPhaseInterval[] = [];
  const cache = new Map<string, Awaited<ReturnType<typeof loadAssistantLifeDay>>>();
  const { readRelevantSleepNight } = await import('./sleepPlanStore');
  for (const day of await Promise.all([readRelevantSleepNight(startAt), readRelevantSleepNight(endAt)])) {
    if (day) cache.set(day.dateKey, withDueWakeBoundary(day));
  }
  for (let cursor = startAt; cursor < endAt;) {
    const overrideStartedAt = options.manualOverrideStartedAt ?? (options.manualWakeUntil !== undefined ? options.manualWakeUntil - 15 * MINUTE_MS : startAt);
    const key = getLocalDateKey(new Date(cursor));
    if (!cache.has(key)) cache.set(key, withDueWakeBoundary(await loadAssistantLifeDay(key)));
    const midnight = new Date(cursor); midnight.setHours(24, 0, 0, 0);
    const previousDate = new Date(cursor); previousDate.setDate(previousDate.getDate() - 1);
    const previousKey = getLocalDateKey(previousDate);
    if (!cache.has(previousKey)) cache.set(previousKey, withDueWakeBoundary(await loadAssistantLifeDay(previousKey)));
    const recorded = activeRecordedNight(cache.values(), cursor);
    const days = [...new Set([recorded, cache.get(previousKey), cache.get(key)])].filter((day): day is AssistantLifeDay => !!day);
    const events = days.flatMap(day => day.nightSleepPlan?.events ?? []);
    const boundaries = [midnight.getTime(), overrideStartedAt, options.manualSleepUntil, options.manualWakeUntil,
      ...days.flatMap(sleepPhaseBoundaries),
      ...events.filter(event => event.kind === 'poke_awake').map(event => event.at + 15 * MINUTE_MS),
      ...((cache.get(key)?.segments ?? []).flatMap((segment) => [segment.startAt, segment.endAt]))]
      .filter((value): value is number => value !== undefined && value > cursor);
    const stepEnd = Math.min(endAt, cursor + STEP_MS, ...boundaries);
    const midpoint = cursor + (stepEnd - cursor) / 2;
    const scheduledPhase = await scheduledPhaseAt(midpoint, cache);
    const returnedAt = events
      .filter(event => event.kind === 'sleep_return' && event.at >= overrideStartedAt)
      .reduce((earliest, event) => Math.min(earliest, event.at), Infinity);
    const manualWakeUntil = Math.min(options.manualWakeUntil ?? -Infinity, returnedAt);
    let phase = scheduledPhase;
    if (midpoint >= overrideStartedAt && typeof options.manualSleepUntil === 'number' && midpoint < options.manualSleepUntil) {
      phase = 'sleeping';
    } else if (midpoint >= overrideStartedAt && midpoint < manualWakeUntil) {
      phase = 'awake';
    }
    const poke = days.flatMap(day => (day.nightSleepPlan?.events ?? [])
      .filter(event => event.kind === 'poke_awake' && event.at <= midpoint && event.at + 15 * MINUTE_MS > midpoint
        && nightSleepPhaseAt(day, event.at - 1) === 'sleeping'))
      .sort((a, b) => b.at - a.at)[0];
    const plan = recorded?.nightSleepPlan;
    const scheduledSleeping = plan ? midpoint >= (plan.actualSleepAt ?? recorded!.sleepTargetAt)
      && midpoint < (plan.actualWakeAt ?? sleepWakeTarget(plan, plan.actualSleepAt ?? recorded!.sleepTargetAt))
      : scheduledPhase === 'sleeping';
    intervals.push({
      endAt: stepEnd,
      phase,
      scheduledSleeping,
      startAt: cursor,
      ...(phase === 'awake' && poke ? { pokeAwakeStartedAt: poke.at } : {}),
      ...(recorded?.nightSleepPlan?.actualSleepAt !== undefined
        ? { sleepEpisode: recordedSleepEpisode(recorded, stepEnd) } : {}),
    });
    cursor = stepEnd;
  }
  return intervals;
}

function rebaseLongGap(state: LifeRhythmState, now: number) {
  const phase = inferPhase(now - LONG_GAP_REPLAY_MS);
  const seed = PHASE_SEEDS[phase];
  return normalizeRhythmState({
    ...state,
    ...seed,
    lastTickAt: now - LONG_GAP_REPLAY_MS,
    phase,
    phaseStartedAt: inferredPhaseStartAt(now - LONG_GAP_REPLAY_MS, phase),
    schemaVersion: RHYTHM_SCHEMA_VERSION,
    updatedAt: now - LONG_GAP_REPLAY_MS,
  }, now - LONG_GAP_REPLAY_MS, phase);
}

export async function loadRhythmState(now = Date.now()) {
  const raw = await AsyncStorage.getItem(LIFE_RHYTHM_STATE_KEY);
  if (!raw) return normalizeRhythmState(undefined, now);
  try {
    return normalizeRhythmState(JSON.parse(raw) as unknown, now);
  } catch {
    return normalizeRhythmState(undefined, now);
  }
}

export async function saveRhythmState(
  state: LifeRhythmState,
  persistenceMode: SyncPersistenceMode = 'synchronized',
) {
  const normalized = normalizeRhythmState(state, Date.now(), state.phase);
  await (persistenceMode === 'local-only'
    ? AsyncStorage.setLocalItem(LIFE_RHYTHM_STATE_KEY, JSON.stringify(normalized))
    : AsyncStorage.setItem(LIFE_RHYTHM_STATE_KEY, JSON.stringify(normalized)));
  return normalized;
}

export function buildRhythmSnapshot(state: LifeRhythmState, now = Date.now()): RhythmSnapshot {
  const modeHint =
    state.sleepPressure > 0.72 ? 'sleepy'
      : state.wakePressure > 0.7 ? 'awake'
        : state.alertness < 0.34 ? 'resting'
          : 'steady';
  const label =
    modeHint === 'sleepy' ? '困意很明显'
      : modeHint === 'awake' ? '醒意比较足'
        : modeHint === 'resting' ? '想慢一点休息'
          : '节奏平稳';
  const sleepEpisode = state.phase === 'sleeping'
    ? {
      durationMinutes: state.lastSleepDurationMinutes !== undefined && state.lastSleepEndedAt === undefined
        ? state.lastSleepDurationMinutes + Math.max(0, now - state.lastTickAt) / MINUTE_MS
        : Math.max(0, (now - (state.lastSleepStartedAt ?? state.phaseStartedAt)) / MINUTE_MS),
      id: `sleep-${state.lastSleepStartedAt ?? state.phaseStartedAt}`,
      isMain: state.lastSleepWasMain === true || isMainSleepInterval(state.lastSleepStartedAt ?? state.phaseStartedAt, now),
      startedAt: state.lastSleepStartedAt ?? state.phaseStartedAt,
    }
    : state.lastSleepStartedAt && state.lastSleepEndedAt && typeof state.lastSleepDurationMinutes === 'number'
      ? {
        durationMinutes: state.lastSleepDurationMinutes,
        endedAt: state.lastSleepEndedAt,
        id: `sleep-${state.lastSleepStartedAt}`,
        isMain: state.lastSleepWasMain === true,
        startedAt: state.lastSleepStartedAt,
      }
      : undefined;
  return { ...state, label, modeHint, sleepEpisode };
}

export async function getRhythmSnapshot(now = Date.now()) {
  return buildRhythmSnapshot(await loadRhythmState(now), now);
}

async function readRhythmInfluences(state: LifeRhythmState, now: number): Promise<RhythmInfluences> {
  const [desire, affect] = await Promise.all([
    loadJunluoDesireState().catch(() => createDefaultJunluoDesireState()),
    loadJunluoAffectState().catch(() => createDefaultJunluoAffectState()),
  ]);
  return calculateRhythmInfluences(state, now, desire, affect);
}

function calculateRhythmInfluences(state: LifeRhythmState, now: number,
  desire: ReturnType<typeof createDefaultJunluoDesireState>, affect: ReturnType<typeof createDefaultJunluoAffectState>): RhythmInfluences {
  // Use the pre-tick rhythm once, including when approximating an offline gap.
  const { desires } = calculateJunluoDesireSnapshot({
    now,
    state: desire,
    structural: {
      sleepPressure: state.sleepPressure,
      sleepDebt: state.sleepDebt,
    },
  });
  return {
    rest: desires.rest.effectiveValue,
    exploreWorld: desires.explore_world.effectiveValue,
    ownTime: desires.own_time.effectiveValue,
    speakToYou: desires.speak_to_you.effectiveValue,
    strain: affect.strain.value,
  };
}

export async function getSleepRecoveryProjection(now = Date.now()): Promise<{ recovered: boolean; recoveryAt?: number; reliable?: true }> {
  if (!Number.isFinite(now) || now <= 0) return { recovered: false };
  const raw = await AsyncStorage.getItem(LIFE_RHYTHM_STATE_KEY);
  if (!raw) return { recovered: false };
  let saved: LifeRhythmState;
  try { saved = JSON.parse(raw) as LifeRhythmState; } catch { return { recovered: false }; }
  if (!saved || saved.schemaVersion !== RHYTHM_SCHEMA_VERSION || !Number.isFinite(saved.lastTickAt)
    || saved.lastTickAt > now || now - saved.lastTickAt > MAX_CATCH_UP_MS
    || [saved.sleepPressure, saved.sleepDebt, saved.restQuality].some(value => !Number.isFinite(value) || value < 0 || value > 1)
    || saved.restQuality < .2) return { recovered: false };
  const state = normalizeRhythmState(saved, now);
  const [desireRaw, affectRaw] = await Promise.all([
    AsyncStorage.getItem(JUNLUO_INNER_STATE_KEYS.desire), AsyncStorage.getItem(JUNLUO_INNER_STATE_KEYS.affect),
  ]);
  let influences: RhythmInfluences;
  try {
    const desire = desireRaw ? upgradeJunluoDesireState(JSON.parse(desireRaw)) : createDefaultJunluoDesireState(now);
    const affect = affectRaw ? upgradeJunluoAffectState(JSON.parse(affectRaw)) : createDefaultJunluoAffectState();
    if (!desire || !affect) return { recovered: false };
    influences = calculateRhythmInfluences(state, now, desire, affect);
  } catch { return { recovered: false }; }
  const assistant = await (await import('../ai/assistantState')).loadAssistantState();
  const options = { manualWakeUntil: assistant.manualWakeUntil, manualSleepUntil: assistant.manualSleepUntil,
    manualOverrideStartedAt: assistant.manualWakeUntil !== undefined ? assistant.manualWakeUntil - 15 * MINUTE_MS : assistant.updatedAt };
  const intervals = await buildPhaseIntervals(state.lastTickAt, now, options);
  const current = advanceRhythmState(state, intervals, influences);
  return { recovered: isSleepRecovered(current), recoveryAt: estimateSleepRecoveryAt(current, now, influences), reliable: true };
}

// Serialize the local read/calculate/write, not just the final storage call.
let rhythmWriteTail: Promise<unknown> = Promise.resolve();
function runRhythmWrite(work: (assertCurrent: () => void) => Promise<RhythmSnapshot>) {
  const epoch = captureBackupRestoreDataEpoch();
  const assertCurrent = () => {
    if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('rhythm-data-epoch-changed');
  };
  const pending = rhythmWriteTail.catch(() => undefined).then(async () => {
    const saved = await runBackupRestoreDataEpochCommit(epoch, () => work(assertCurrent));
    if (!saved.committed) throw new Error('rhythm-data-epoch-changed');
    return saved.value;
  });
  rhythmWriteTail = pending.catch(() => undefined);
  return pending;
}

export async function runRhythmTick(
  options: RhythmTickOptions = {},
  persistenceMode: SyncPersistenceMode = 'synchronized',
) {
  const now = options.now ?? Date.now();
  return runRhythmWrite(assertCurrent => settleRhythmTick(options, persistenceMode, now, assertCurrent));
}

async function settleRhythmTick(options: RhythmTickOptions, persistenceMode: SyncPersistenceMode,
  now: number, assertCurrent: () => void) {
  let state = await loadRhythmState(now);
  assertCurrent();
  if (now < state.lastTickAt) return buildRhythmSnapshot(state, state.lastTickAt);
  if (now - state.lastTickAt > MAX_CATCH_UP_MS) state = rebaseLongGap(state, now);
  const influences = await readRhythmInfluences(state, now);
  const startAt = Math.min(now, state.lastTickAt);
  const intervals = await buildPhaseIntervals(startAt, now, options);
  const advanced = advanceRhythmState(state, intervals, influences);
  // Intervals end immediately before now; a boundary callback must also enter
  // the phase beginning at now, without the manual override's extra relief.
  const currentPhase = (await buildPhaseIntervals(now, now + 1, options))[0].phase;
  const next = transitionPhase(advanced, currentPhase, now);
  assertCurrent();
  await saveRhythmState(next, persistenceMode);
  assertCurrent();
  await (await import('./junluoDesireRuntime')).settleJunluoSleepIntervals(intervals, next.phase === 'awake', now);
  return buildRhythmSnapshot(next, now);
}

export async function applySleepWakeOverride(kind: 'sleep' | 'wake', now = Date.now()) {
  return runRhythmWrite(assertCurrent => settleSleepWakeOverride(kind, now, assertCurrent));
}

async function settleSleepWakeOverride(kind: 'sleep' | 'wake', now: number, assertCurrent: () => void) {
  const state = await loadRhythmState(now);
  assertCurrent();
  if (now < state.lastTickAt) return buildRhythmSnapshot(state, state.lastTickAt);
  const phase: LifeRhythmPhase = kind === 'sleep' ? 'sleeping' : 'awake';
  if (state.phase === phase) return buildRhythmSnapshot(state, now);
  const transitioned = transitionPhase(state, phase, now);
  const next: LifeRhythmState = { ...transitioned, alertness: state.alertness,
    sleepPressure: state.sleepPressure, wakePressure: state.wakePressure, lastTickAt: now, updatedAt: now };
  await saveRhythmState(next);
  assertCurrent();
  await (await import('./junluoDesireRuntime')).noteJunluoSleepPhase(next.phase === 'awake', now);
  return buildRhythmSnapshot(next, now);
}
