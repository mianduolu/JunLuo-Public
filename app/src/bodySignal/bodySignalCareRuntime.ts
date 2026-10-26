import { AppState } from 'react-native';

import { bodySignalBaselineThresholds, buildBodySignalPersonalBaseline } from './bodySignalBaseline';
import {
  activeBodySignalActivityAt,
  BODY_SIGNAL_ACTIVITY_MAX_AGE_MS,
  BODY_SIGNAL_RESTING_MIN_MS,
  isMovementActivity,
  isNavigationAppLabel,
  resolveBodySignalContext,
  type ResolvedBodySignalContext,
} from './bodySignalContext';
import {
  BODY_SIGNAL_NAVIGATION_ENTER_KIND,
  BODY_SIGNAL_NAVIGATION_EXIT_KIND,
  resolveBodySignalNavigationEvidence,
} from './bodySignalNavigation';
import {
  acknowledgeActivityContextEvents,
  disableActivityTransitions,
  enableActivityTransitions,
  getActivityContextSupport,
  getPendingActivityContextEvents,
  refreshActivityTransitionsIfStale,
  requestActivityRecognitionPermission,
  subscribeActivityContext,
  type BodySignalActivityContextSupport,
} from './bodySignalActivityContext';
import {
  loadBodySignalPersonalBaseline,
  loadRecentBodySignalCareEvents,
  saveBodySignalPersonalBaseline,
} from './bodySignalCareStore';
import { evaluateBodySignalHeartRateEvent, type BodySignalEvaluatedHeartRate } from './bodySignalCareEvents';
import {
  loadBodySignalEvaluationCursor,
  loadRecentBodySignalContextObservations,
  saveBodySignalContextObservation,
  saveBodySignalEvaluationCursor,
} from './bodySignalContextStore';
import { loadBodySignalSleepSessionsSince } from './bodySignalSleepStore';
import {
  loadBodySignalReadingRecordsSince,
  subscribeBodySignalReadingSaved,
} from './bodySignalStore';
import type {
  BodySignalCareEvent,
  BodySignalContextBucket,
  BodySignalContextObservation,
  BodySignalPersonalBaseline,
  BodySignalSleepSession,
  BodySignalWorkoutSession,
} from './bodySignalStructuredTypes';
import { loadBodySignalWorkoutSessionsSince } from './bodySignalWorkoutStore';
import { loadPersistedBodySignalDeviceProfiles } from './device/bodySignalDeviceRepository';
import type { BodySignalDeviceProfile } from './device/bodySignalDeviceTypes';
import { loadRecentPhoneActivityLogs, type PhoneActivityLog } from '../phoneActivity/phoneActivityStore';
import type { StoredBodySignalReading } from './bodySignalTypes';
import type { HeartCareObservation } from './bodySignalProactiveCare';

const DAY_MS = 86_400_000;
const BASELINE_WINDOW_MS = 28 * DAY_MS;
const BASELINE_REFRESH_MS = 15 * 60_000;
const EVENT_LOOKBACK_MS = 2 * 60 * 60_000;

type HeartRateRecord = StoredBodySignalReading & { id: string };

export type BodySignalCareRuntimeSnapshot = {
  activitySupport: BodySignalActivityContextSupport;
  baseline?: BodySignalPersonalBaseline;
  currentContext: BodySignalContextBucket;
  currentContextConfidence: number;
  currentContextSource: ResolvedBodySignalContext['source'];
  currentContextUpdatedAt?: number;
  isEvaluating: boolean;
  lastErrorCode?: string;
  recentEvents: BodySignalCareEvent[];
};

type EvidenceCache = {
  activity: BodySignalContextObservation[];
  activitySupport: BodySignalActivityContextSupport;
  bootSessionId?: string;
  navigation: PhoneActivityLog[];
  sleep: BodySignalSleepSession[];
  workouts: BodySignalWorkoutSession[];
};

const unsupportedActivitySupport: BodySignalActivityContextSupport = {
  enabled: false,
  permissionGranted: false,
  reason: 'not_loaded',
  supported: false,
};

let snapshot: BodySignalCareRuntimeSnapshot = {
  activitySupport: unsupportedActivitySupport,
  currentContext: 'unknown',
  currentContextConfidence: 0,
  currentContextSource: 'none',
  isEvaluating: false,
  recentEvents: [],
};
let runtimeTail: Promise<void> = Promise.resolve();
let runtimeStarted = false;
let activityLedgerPollTimer: ReturnType<typeof setInterval> | undefined;
let activityRegistrationHealthCheck: Promise<void> | undefined;
let restingBoundaryTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(value: BodySignalCareRuntimeSnapshot) => void>();

function emit(patch: Partial<BodySignalCareRuntimeSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener(snapshot));
}

function enqueue(task: () => Promise<void>) {
  runtimeTail = runtimeTail.then(task, task).catch((error) => {
    emit({ isEvaluating: false, lastErrorCode: error instanceof Error ? error.message : 'care_runtime_failed' });
  });
  return runtimeTail;
}

function checkActivityRegistrationHealth(): Promise<void> {
  if (activityRegistrationHealthCheck) return activityRegistrationHealthCheck;
  activityRegistrationHealthCheck = (async () => {
    const support = await getActivityContextSupport().catch(() => unsupportedActivitySupport);
    emit({ activitySupport: support });
    if (!support.supported || !support.permissionGranted || !support.enabled) return;
    await refreshActivityTransitionsIfStale();
    emit({ activitySupport: await getActivityContextSupport().catch(() => support) });
  })().catch(() => undefined).finally(() => {
    activityRegistrationHealthCheck = undefined;
  });
  return activityRegistrationHealthCheck;
}

function scheduleRestingBoundaryEvaluation(now: number, cache: EvidenceCache) {
  if (restingBoundaryTimer) clearTimeout(restingBoundaryTimer);
  restingBoundaryTimer = undefined;
  const activity = activeBodySignalActivityAt(now, cache.activity, cache.bootSessionId, true);
  if (activity?.activity !== 'still' || activity.transition !== 'enter') return;
  const dueAt = activity.startedAt + BODY_SIGNAL_RESTING_MIN_MS;
  if (dueAt <= now) return;
  restingBoundaryTimer = setTimeout(() => {
    restingBoundaryTimer = undefined;
    void evaluatePendingBodySignalReadings();
  }, dueAt - now + 250);
}

function contextAt(
  at: number,
  profileId: string,
  cache: EvidenceCache,
  options: { allowActivityEvidence?: boolean; requireCurrentBoot?: boolean } = {},
): ResolvedBodySignalContext {
  const sleep = cache.sleep.find((item) => (
    item.deviceProfileId === profileId && item.startedAt <= at && item.endedAt >= at
  ));
  const workout = cache.workouts.find((item) => (
    item.deviceProfileId === profileId
    && item.startedAt <= at
    && (item.endedAt === undefined || item.endedAt >= at)
  ));
  const allowActivityEvidence = options.allowActivityEvidence !== false;
  const navigation = allowActivityEvidence && cache.activitySupport.navigationEvidenceAvailable !== false
    ? resolveBodySignalNavigationEvidence(at, cache.navigation)
    : undefined;
  return resolveBodySignalContext(at, {
    activity: allowActivityEvidence
      ? activeBodySignalActivityAt(
          at,
          cache.activity,
          cache.bootSessionId,
          options.requireCurrentBoot === true,
        )
      : undefined,
    navigationActive: navigation?.active,
    navigationObservedAt: navigation?.observedAt,
    ...(sleep ? { sleep: { confidence: sleep.confidence === 'high' ? 0.9 : 0.7, endedAt: sleep.endedAt, startedAt: sleep.startedAt } } : {}),
    ...(workout ? { workout: { endedAt: workout.endedAt, startedAt: workout.startedAt } } : {}),
  });
}

function readingProfile(
  reading: HeartRateRecord,
  profiles: readonly BodySignalDeviceProfile[],
): BodySignalDeviceProfile | undefined {
  if (reading.deviceProfileId) return profiles.find((profile) => profile.id === reading.deviceProfileId);
  if (reading.sourceDeviceName) {
    const byName = profiles.find((profile) => profile.displayName === reading.sourceDeviceName);
    if (byName) return byName;
  }
  return profiles.find((profile) => profile.isPrimary);
}

async function loadEvidence(now: number, readOnly = false): Promise<EvidenceCache> {
  const support = await getActivityContextSupport().catch(() => unsupportedActivitySupport);
  const [activity, navigation, sleep, workouts] = await Promise.all([
    loadRecentBodySignalContextObservations(now - BASELINE_WINDOW_MS, 512),
    loadRecentPhoneActivityLogs(1000, undefined, readOnly).catch(() => []),
    loadBodySignalSleepSessionsSince(now - BASELINE_WINDOW_MS),
    loadBodySignalWorkoutSessionsSince(now - BASELINE_WINDOW_MS),
  ]);
  if (!readOnly) emit({ activitySupport: support });
  return { activity, activitySupport: support, bootSessionId: support.bootSessionId,
    navigation: navigation.filter((log) => log.kind === BODY_SIGNAL_NAVIGATION_ENTER_KIND
      || log.kind === BODY_SIGNAL_NAVIGATION_EXIT_KIND
      || isNavigationAppLabel(`${log.source} ${log.title}`)),
    sleep, workouts };
}

async function drainNativeActivityEvents() {
  const events = await getPendingActivityContextEvents();
  const persistedEventIds: string[] = [];
  for (const event of events) {
    const movement = isMovementActivity(event.activity);
    await saveBodySignalContextObservation({
      activity: event.activity,
      bootSessionId: event.bootSessionId,
      confidence: 0.85,
      context: movement ? 'active' : 'unknown',
      createdAt: Date.now(),
      ...(event.transition === 'exit' ? { endedAt: event.observedAt } : {}),
      expiresAt: event.observedAt + BODY_SIGNAL_ACTIVITY_MAX_AGE_MS,
      id: event.eventId,
      source: 'activity_transition',
      startedAt: event.observedAt,
      transition: event.transition,
    });
    persistedEventIds.push(event.eventId);
  }
  if (persistedEventIds.length) await acknowledgeActivityContextEvents(persistedEventIds);
}

function evaluatedReading(reading: HeartRateRecord): BodySignalEvaluatedHeartRate {
  return {
    confidence: reading.confidence,
    id: reading.id,
    measuredAt: reading.measuredAt,
    sourceDeviceName: reading.sourceDeviceName,
    sourceProvider: reading.sourceProvider,
    value: reading.value,
  };
}


async function refreshBaseline(
  deviceProfileId: string,
  context: BodySignalContextBucket,
  readings: readonly HeartRateRecord[],
  cache: EvidenceCache,
  now: number,
): Promise<BodySignalPersonalBaseline | undefined> {
  const stored = await loadBodySignalPersonalBaseline(deviceProfileId, 'heart_rate', context);
  const sameDay = stored && new Date(stored.updatedAt).toDateString() === new Date(now).toDateString();
  if (stored && sameDay && now - stored.updatedAt < BASELINE_REFRESH_MS) return stored;
  const samples = readings
    // Keep the complete current observation window out of its own reference.
    .filter((reading) => reading.measuredAt < now - 30 * 60_000)
    .filter((reading) => contextAt(reading.measuredAt, deviceProfileId, cache).context === context)
    .map((reading) => ({ measuredAt: reading.measuredAt, value: reading.value }));
  const baseline = buildBodySignalPersonalBaseline({ context, deviceProfileId, now, samples });
  if (baseline) await saveBodySignalPersonalBaseline(baseline);
  return baseline;
}


async function evaluateInternal(options: { reconsiderRecent?: boolean } = {}) {
  const now = Date.now();
  emit({ isEvaluating: true, lastErrorCode: undefined });
  await drainNativeActivityEvents();
  const [profiles, readings, cache] = await Promise.all([
    loadPersistedBodySignalDeviceProfiles(),
    loadBodySignalReadingRecordsSince('heart_rate', now - BASELINE_WINDOW_MS),
    loadEvidence(now),
  ]);
  const primary = profiles.find((profile) => profile.isPrimary);
  const liveActivityEvidenceAllowed = cache.activitySupport.supported
    && cache.activitySupport.permissionGranted
    && cache.activitySupport.enabled;
  const currentContext = primary
    ? contextAt(now, primary.id, cache, {
        allowActivityEvidence: liveActivityEvidenceAllowed,
        requireCurrentBoot: true,
      })
    : { confidence: 0, context: 'unknown' as const, source: 'none' as const };
  if (primary && liveActivityEvidenceAllowed) {
    scheduleRestingBoundaryEvaluation(now, cache);
  } else if (restingBoundaryTimer) {
    clearTimeout(restingBoundaryTimer);
    restingBoundaryTimer = undefined;
  }
  let currentBaseline: BodySignalPersonalBaseline | undefined;

  for (const profile of profiles) {
    const profileReadings = readings.filter((reading) => readingProfile(reading, profiles)?.id === profile.id);
    if (profileReadings.length === 0) continue;
    const byContext = new Map<BodySignalContextBucket, HeartRateRecord[]>();
    for (const reading of profileReadings) {
      const resolved = contextAt(reading.measuredAt, profile.id, cache);
      const group = byContext.get(resolved.context) ?? [];
      group.push(reading);
      byContext.set(resolved.context, group);
    }
    for (const context of byContext.keys()) {
      const baseline = await refreshBaseline(profile.id, context, profileReadings, cache, now);
      if (profile.isPrimary && context === currentContext.context) currentBaseline = baseline;
    }

    const cursor = await loadBodySignalEvaluationCursor(profile.id);
    const cursorAt = options.reconsiderRecent ? now - EVENT_LOOKBACK_MS : cursor?.lastMeasuredAt ?? now - EVENT_LOOKBACK_MS;
    const pending = profileReadings.filter((reading) => (
      reading.measuredAt > cursorAt
      || (
        !options.reconsiderRecent
        && reading.measuredAt === cursorAt
        && !!cursor?.lastReadingId
        && reading.id > cursor.lastReadingId
      )
    ));
    for (const reading of pending) {
      if (!options.reconsiderRecent) {
        await saveBodySignalEvaluationCursor({ deviceProfileId: profile.id, lastMeasuredAt: reading.measuredAt, lastReadingId: reading.id });
      }
    }
  }

  // The local episode owns event creation; historical reevaluation cannot reopen care.
  await import('./bodySignalProactiveCareRuntime').then(({ observeBodySignalCareEpisode }) => observeBodySignalCareEpisode());
  void import('../life/sleepPlanRuntime').then(module => module.reconcileSleepPlanLocally()).catch(() => undefined);
  emit({
    baseline: currentBaseline,
    currentContext: currentContext.context,
    currentContextConfidence: currentContext.confidence,
    currentContextSource: currentContext.source,
    currentContextUpdatedAt: currentContext.observedAt
      ?? (liveActivityEvidenceAllowed
        ? cache.activitySupport.lastNativeObservationAt ?? cache.activitySupport.lastNativeEventAt
        : undefined),
    isEvaluating: false,
    recentEvents: await loadRecentBodySignalCareEvents(10),
  });
}

export function getBodySignalCareRuntimeSnapshot(): BodySignalCareRuntimeSnapshot {
  return snapshot;
}

export function subscribeBodySignalCareRuntime(
  listener: (value: BodySignalCareRuntimeSnapshot) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function evaluatePendingBodySignalReadings(): Promise<void> {
  return enqueue(() => evaluateInternal());
}

export async function requestAndEnableBodySignalActivityContext(): Promise<boolean> {
  const granted = await requestActivityRecognitionPermission();
  if (!granted) {
    await enqueue(() => evaluateInternal());
    return false;
  }
  const enabled = await enableActivityTransitions();
  await enqueue(() => evaluateInternal());
  return enabled;
}

// Only the live main device participates. History remains readable but cannot bootstrap care.
export async function loadHeartCareObservation(since: number, now = Date.now(), readOnly = false): Promise<HeartCareObservation | null> {
  if (!readOnly) await drainNativeActivityEvents();
  const [profiles, readings, cache] = await Promise.all([
    loadPersistedBodySignalDeviceProfiles(),
    loadBodySignalReadingRecordsSince('heart_rate', now - 40 * 60_000, true),
    loadEvidence(now, readOnly),
  ]);
  const profile = profiles.find((p) => p.isPrimary);
  if (!profile) return null;
  const currentReadings = readings.filter((r) => r.deviceProfileId === profile.id && Number.isFinite(r.value) && r.value > 0
    && Number.isFinite(r.measuredAt) && r.measuredAt <= now)
    .sort((a, b) => a.measuredAt - b.measuredAt || a.id.localeCompare(b.id));
  const latest = currentReadings.at(-1);
  if (!latest) return null;
  const activityAllowed = cache.activitySupport.supported && cache.activitySupport.permissionGranted && cache.activitySupport.enabled;
  const resolve = (at: number) => contextAt(at, profile.id, cache, {
    allowActivityEvidence: activityAllowed, requireCurrentBoot: true,
  });
  const resolved = resolve(latest.measuredAt);
  const baseline = await loadBodySignalPersonalBaseline(profile.id, 'heart_rate', resolved.context);
  const candidate = evaluateBodySignalHeartRateEvent({ baseline: baseline ?? undefined, context: resolved.context,
    contextConfidence: resolved.confidence, deviceProfileId: profile.id, now,
    readings: currentReadings.filter((r) => r.measuredAt > since).map((r) => ({
      ...evaluatedReading(r), context: resolve(r.measuredAt).context, deviceProfileId: profile.id,
    })),
  });
  const activity = activityAllowed ? activeBodySignalActivityAt(latest.measuredAt, cache.activity, cache.bootSessionId, true) : undefined;
  const references = new Map<BodySignalContextBucket, BodySignalPersonalBaseline | undefined>([[resolved.context, baseline]]);
  let latestNormal: HeartCareObservation['latestNormal'];
  for (const reading of [...currentReadings].reverse()) {
    if (reading.measuredAt <= since || now - reading.measuredAt > 600_000) break;
    const context = resolve(reading.measuredAt).context;
    if (!references.has(context)) references.set(context, await loadBodySignalPersonalBaseline(profile.id, 'heart_rate', context));
    const reference = references.get(context);
    if (reference?.readiness !== 'mature' || reference.deviceProfileId !== profile.id || reference.context !== context
      || reference.kind !== 'heart_rate' || !Number.isFinite(reference.median)
      || !Number.isFinite(reference.mad) || reference.mad < 0) continue;
    const limits = bodySignalBaselineThresholds(reference);
    if (reading.value > limits.regularLow && reading.value < limits.regularHigh) {
      latestNormal = { id: reading.id, measuredAt: reading.measuredAt }; break;
    }
  }
  return { deviceProfileId: profile.id, latest: evaluatedReading(latest), baseline: baseline ?? undefined,
    candidate, context: resolved.context, latestNormal,
    activityText: resolved.context === 'unknown' ? undefined : activity?.activity ?? resolved.context };
}

export async function disableBodySignalActivityContext(): Promise<void> {
  await disableActivityTransitions();
  await enqueue(() => evaluateInternal());
}

export function startBodySignalCareRuntime(): () => void {
  if (runtimeStarted) return () => undefined;
  runtimeStarted = true;
  const stopReading = subscribeBodySignalReadingSaved(() => {
    void evaluatePendingBodySignalReadings();
  });
  const stopActivity = subscribeActivityContext(() => {
    void evaluatePendingBodySignalReadings();
  });
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void checkActivityRegistrationHealth();
      void evaluatePendingBodySignalReadings();
    }
  });
  activityLedgerPollTimer = setInterval(() => {
    if (AppState.currentState !== 'active') return;
    void getPendingActivityContextEvents().then((events) => {
      if (events.length) void evaluatePendingBodySignalReadings();
    }).catch(() => undefined);
  }, 15_000);
  void getActivityContextSupport().then(async (support) => {
    if (!support.supported || !support.permissionGranted || !support.enabled) return;
    await enableActivityTransitions();
    await evaluatePendingBodySignalReadings();
  }).catch(() => undefined);
  void evaluatePendingBodySignalReadings();
  return () => {
    runtimeStarted = false;
    if (activityLedgerPollTimer) clearInterval(activityLedgerPollTimer);
    activityLedgerPollTimer = undefined;
    if (restingBoundaryTimer) clearTimeout(restingBoundaryTimer);
    restingBoundaryTimer = undefined;
    stopReading();
    stopActivity();
    appState.remove();
  };
}
