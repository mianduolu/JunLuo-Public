import {
  BODY_SIGNAL_ACTIVITY_MAX_AGE_MS,
  BODY_SIGNAL_NAVIGATION_MAX_AGE_MS,
  isNavigationAppLabel,
} from './bodySignalContext';

export type BodySignalNavigationSessionEvent = {
  kind: 'navigation_enter' | 'navigation_exit';
  appFamily: 'amap' | 'baidu_map' | 'tencent_map' | 'google_maps';
  observedAt: number;
};

export type BodySignalNavigationEvidenceStatus = {
  available: boolean;
  active: boolean;
  lastObservedAt?: number;
};

export type BodySignalNavigationLog = {
  created_at: number;
  ended_at?: number | null;
  kind: string;
  source: string;
  started_at?: number | null;
  title: string;
};

export const BODY_SIGNAL_NAVIGATION_ENTER_KIND = 'body_signal_navigation_enter';
export const BODY_SIGNAL_NAVIGATION_EXIT_KIND = 'body_signal_navigation_exit';

export type ResolvedBodySignalNavigationEvidence = {
  active: boolean;
  observedAt?: number;
};

function observedAt(log: BodySignalNavigationLog): number {
  return log.started_at ?? log.ended_at ?? log.created_at;
}

export function resolveBodySignalNavigationEvidence(
  at: number,
  logs: readonly BodySignalNavigationLog[],
): ResolvedBodySignalNavigationEvidence {
  let activeSince: number | undefined;
  let lastExitAt: number | undefined;
  let legacyObservedAt: number | undefined;
  let latestSessionAt: number | undefined;
  logs.forEach((log) => {
    const timestamp = observedAt(log);
    if (!(timestamp <= at)) return;
    if (log.kind === BODY_SIGNAL_NAVIGATION_ENTER_KIND || log.kind === BODY_SIGNAL_NAVIGATION_EXIT_KIND) {
      if (latestSessionAt === undefined || timestamp >= latestSessionAt) {
        latestSessionAt = timestamp;
        activeSince = log.kind === BODY_SIGNAL_NAVIGATION_ENTER_KIND ? timestamp : undefined;
        lastExitAt = log.kind === BODY_SIGNAL_NAVIGATION_EXIT_KIND ? timestamp : undefined;
      }
    } else if (isNavigationAppLabel(`${log.source} ${log.title}`)
      && (legacyObservedAt === undefined || timestamp >= legacyObservedAt)) {
      legacyObservedAt = timestamp;
    }
  });

  if (activeSince !== undefined && at - activeSince <= BODY_SIGNAL_ACTIVITY_MAX_AGE_MS) {
    return { active: true, observedAt: activeSince };
  }
  const tailObservedAt = Math.max(lastExitAt ?? 0, legacyObservedAt ?? 0) || undefined;
  if (tailObservedAt !== undefined && at - tailObservedAt <= BODY_SIGNAL_NAVIGATION_MAX_AGE_MS) {
    return { active: false, observedAt: tailObservedAt };
  }
  return { active: false };
}
