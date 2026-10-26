import type {
  BodySignalActivityType,
  BodySignalContextBucket,
  BodySignalContextObservation,
} from './bodySignalStructuredTypes';

export const BODY_SIGNAL_ACTIVITY_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const BODY_SIGNAL_NAVIGATION_MAX_AGE_MS = 10 * 60 * 1000;
export const BODY_SIGNAL_RESTING_MIN_MS = 5 * 60 * 1000;
export const BODY_SIGNAL_RESTING_EXIT_GRACE_MS = 2 * 60 * 1000;

export type BodySignalContextEvidence = {
  activity?: BodySignalContextObservation;
  navigationActive?: boolean;
  navigationObservedAt?: number;
  sleep?: { startedAt: number; endedAt: number; confidence?: number };
  workout?: { startedAt: number; endedAt?: number };
};

export type ResolvedBodySignalContext = {
  confidence: number;
  context: BodySignalContextBucket;
  observedAt?: number;
  source: BodySignalContextObservation['source'] | 'none';
};

export function isMovementActivity(activity: BodySignalActivityType): boolean {
  return activity === 'walking'
    || activity === 'running'
    || activity === 'on_bicycle'
    || activity === 'in_vehicle';
}

export function activeBodySignalActivityAt(
  at: number,
  observations: readonly BodySignalContextObservation[],
  bootSessionId?: string,
  requireCurrentBoot = false,
): BodySignalContextObservation | undefined {
  const state = new Map<BodySignalActivityType, BodySignalContextObservation>();
  let recentlyExitedStill: BodySignalContextObservation | undefined;
  let recentlyExitedStillAt: number | undefined;
  const ordered = observations
    .filter((item) => !requireCurrentBoot || !bootSessionId || item.bootSessionId === bootSessionId)
    .filter((item) => item.startedAt <= at && item.startedAt >= at - BODY_SIGNAL_ACTIVITY_MAX_AGE_MS)
    .sort((left, right) => left.startedAt - right.startedAt);

  for (const item of ordered) {
    if (item.transition === 'exit') {
      const previous = state.get(item.activity);
      state.delete(item.activity);
      if (
        item.activity === 'still'
        && previous
        && at - item.startedAt <= BODY_SIGNAL_RESTING_EXIT_GRACE_MS
      ) {
        recentlyExitedStill = previous;
        recentlyExitedStillAt = item.startedAt;
      }
      continue;
    }
    if (item.transition !== 'enter') continue;
    state.set(item.activity, item);
    if (isMovementActivity(item.activity)) {
      recentlyExitedStill = undefined;
      recentlyExitedStillAt = undefined;
      state.delete('still');
    }
  }

  const active = [...state.values()].sort((left, right) => right.startedAt - left.startedAt)[0];
  if (active) return active;
  if (!recentlyExitedStill || recentlyExitedStillAt === undefined) return undefined;
  return { ...recentlyExitedStill, endedAt: recentlyExitedStillAt };
}

export function resolveBodySignalContext(
  at: number,
  evidence: BodySignalContextEvidence,
): ResolvedBodySignalContext {
  if (evidence.sleep && at >= evidence.sleep.startedAt && at <= evidence.sleep.endedAt) {
    return { confidence: evidence.sleep.confidence ?? 0.9, context: 'sleeping', observedAt: evidence.sleep.startedAt, source: 'sleep' };
  }

  const activity = evidence.activity;
  const activityIsFresh = Boolean(
    activity
    && activity.startedAt <= at
    && at <= Math.min(activity.expiresAt, activity.startedAt + BODY_SIGNAL_ACTIVITY_MAX_AGE_MS),
  );
  const navigationMaxAge = evidence.navigationActive
    ? BODY_SIGNAL_ACTIVITY_MAX_AGE_MS
    : BODY_SIGNAL_NAVIGATION_MAX_AGE_MS;
  const navigationIsFresh = evidence.navigationObservedAt !== undefined
    && evidence.navigationObservedAt <= at
    && at - evidence.navigationObservedAt <= navigationMaxAge;
  if (navigationIsFresh && activityIsFresh && activity && isMovementActivity(activity.activity)) {
    return {
      confidence: Math.min(activity.confidence, 0.9),
      context: 'navigation',
      observedAt: Math.max(activity.startedAt, evidence.navigationObservedAt ?? 0),
      source: 'navigation_app',
    };
  }

  const workoutActive = evidence.workout
    && evidence.workout.startedAt <= at
    && (evidence.workout.endedAt === undefined || evidence.workout.endedAt >= at);
  if (workoutActive || (activityIsFresh && activity && isMovementActivity(activity.activity))) {
    return {
      confidence: workoutActive ? 0.9 : activity?.confidence ?? 0.6,
      context: 'active',
      observedAt: workoutActive ? evidence.workout?.startedAt : activity?.startedAt,
      source: workoutActive ? 'workout' : 'activity_transition',
    };
  }

  if (
    activityIsFresh
    && activity?.activity === 'still'
    && at - activity.startedAt >= BODY_SIGNAL_RESTING_MIN_MS
  ) {
    return { confidence: activity.confidence, context: 'resting', observedAt: activity.startedAt, source: 'activity_transition' };
  }
  return { confidence: 0, context: 'unknown', source: 'none' };
}

const NAVIGATION_APP_PATTERN = /(高德地图|百度地图|腾讯地图|google maps|amap|baidumap|tencent\.map)/i;

export function isNavigationAppLabel(value: string | undefined): boolean {
  return Boolean(value && NAVIGATION_APP_PATTERN.test(value));
}
