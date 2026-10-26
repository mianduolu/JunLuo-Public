import { activeBodySignalActivityAt, isNavigationAppLabel, resolveBodySignalContext, type ResolvedBodySignalContext } from './bodySignalContext';
import { resolveBodySignalNavigationEvidence, type BodySignalNavigationLog } from './bodySignalNavigation';
import type { BodySignalActivityContextSupport } from './bodySignalActivityContext';
import type { BodySignalContextObservation, BodySignalSleepSession, BodySignalWorkoutSession } from './bodySignalStructuredTypes';

export type BodySignalReadingContext = ResolvedBodySignalContext & {
  deviceProfileId?: string;
  measuredAt: number;
  revision: string;
};

export type BodySignalReadingContextInput = { deviceProfileId?: string; measuredAt: number };
export type BodySignalReadingContextEvidence = {
  deviceProfileIds: readonly string[];
  support: BodySignalActivityContextSupport;
  activity: readonly BodySignalContextObservation[];
  navigation: readonly (BodySignalNavigationLog & { id?: string | number })[];
  sleep: readonly BodySignalSleepSession[];
  workouts: readonly BodySignalWorkoutSession[];
};

export function unknownBodySignalReadingContext(reading: BodySignalReadingContextInput): BodySignalReadingContext {
  return { deviceProfileId: reading.deviceProfileId, measuredAt: reading.measuredAt,
    confidence: 0, context: 'unknown', source: 'none', revision: 'unknown' };
}

export function resolveBodySignalReadingContext(
  reading: BodySignalReadingContextInput,
  evidence: BodySignalReadingContextEvidence,
): BodySignalReadingContext {
  const at = reading.measuredAt;
  if (!reading.deviceProfileId || !evidence.deviceProfileIds.includes(reading.deviceProfileId)
    || !Number.isFinite(at) || at <= 0) return unknownBodySignalReadingContext(reading);
  const sleep = evidence.sleep.find(item => item.deviceProfileId === reading.deviceProfileId
    && item.startedAt <= at && item.endedAt >= at && (item.confidence === 'high' || item.confidence === 'medium'));
  const workout = evidence.workouts.find(item => item.deviceProfileId === reading.deviceProfileId
    && item.startedAt <= at && (item.endedAt === undefined || item.endedAt >= at));
  const { support } = evidence;
  const activityAllowed = support.supported && support.permissionGranted && support.enabled && !!support.bootSessionId;
  const activity = activityAllowed
    ? activeBodySignalActivityAt(at, evidence.activity, support.bootSessionId, true) : undefined;
  const navigation = activityAllowed && support.navigationEvidenceAvailable
    ? resolveBodySignalNavigationEvidence(at, evidence.navigation) : undefined;
  const resolved = resolveBodySignalContext(at, {
    activity, navigationActive: navigation?.active, navigationObservedAt: navigation?.observedAt,
    ...(sleep ? { sleep: { startedAt: sleep.startedAt, endedAt: sleep.endedAt,
      confidence: sleep.confidence === 'high' ? 0.9 : 0.7 } } : {}),
    ...(workout ? { workout: { startedAt: workout.startedAt, endedAt: workout.endedAt } } : {}),
  });
  if (resolved.context === 'unknown' || !Number.isFinite(resolved.observedAt)) return unknownBodySignalReadingContext(reading);
  // Only the evidence used for this dated reading belongs to its version.
  const activityVersion = activity && [activity.id, activity.activity, activity.startedAt, activity.endedAt,
    activity.expiresAt, activity.confidence, activity.source, activity.transition, activity.bootSessionId];
  const navigationVersion = navigation && evidence.navigation
    .filter(log => (log.started_at ?? log.ended_at ?? log.created_at) === navigation.observedAt)
    .filter(log => log.kind === 'body_signal_navigation_enter' || log.kind === 'body_signal_navigation_exit'
      || isNavigationAppLabel(`${log.source} ${log.title}`))
    .map(log => [log.id, log.kind, log.source, log.title, navigation.observedAt, navigation.active]);
  const used = resolved.source === 'sleep' ? [sleep?.id, sleep?.startedAt, sleep?.endedAt, sleep?.confidence, sleep?.sourceProvider]
    : resolved.source === 'workout' ? [workout?.id, workout?.startedAt, workout?.endedAt, workout?.status, workout?.sourceProvider]
      : resolved.source === 'navigation_app' ? [activityVersion, navigationVersion] : activityVersion;
  return { ...resolved, deviceProfileId: reading.deviceProfileId, measuredAt: at,
    revision: JSON.stringify([resolved.context, resolved.source, resolved.observedAt, resolved.confidence, used]) };
}

function recordedTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatBodySignalReadingContext(context: BodySignalReadingContext): string {
  const time = recordedTime(context.measuredAt);
  if (context.context === 'unknown' || context.observedAt === undefined || context.source === 'none') {
    return `穿戴设备在 ${time} 记下了这次心率，不过当时的线索还不够，暂时不知道 you 那会儿在做什么。`;
  }
  const state = { active: '正在活动', navigation: '在外出途中', resting: '正在休息', sleeping: '正在睡觉' }[context.context];
  const source = { activity_transition: '手机活动记录', navigation_app: '导航和手机活动记录',
    workout: '运动记录', sleep: '已验证的睡眠记录' }[context.source];
  return `穿戴设备在 ${time} 记下这次心率时，you 那会儿可能${state}。\n这是结合 ${recordedTime(context.observedAt)} 留下的${source}判断的；现在的情况可能已经不同了。`;
}
