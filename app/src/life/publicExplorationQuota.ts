// One local execution budget; logs and shares retain their existing sync domain.
export const PUBLIC_EXPLORATION_STATE_KEY = 'junluo.life.webVoyage.state.v1';
export const LEGACY_GITHUB_VOYAGE_STATE_KEY = 'junluo.life.githubVoyage.state.v1';

export type PublicExplorationQuota = {
  quotaVersion: 2;
  dateKey: string;
  attemptCountToday: number;
  consecutiveFailures: number;
  lastAttemptAt?: number;
  lastCompletedAt?: number;
};
type PreviousQuota = Omit<PublicExplorationQuota, 'quotaVersion'> & { quotaVersion?: 2 };

export function explorationDateKey(now: number) {
  const date = new Date(now);
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}

function readQuota(raw: string | null | undefined): PreviousQuota | undefined {
  if (raw === null || raw === undefined) return undefined;
  const value = JSON.parse(raw) as PreviousQuota;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value.quotaVersion !== undefined && value.quotaVersion !== 2)
    || typeof value.dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.dateKey)
    || explorationDateKey(new Date(`${value.dateKey}T12:00:00`).getTime()) !== value.dateKey
    || !Number.isSafeInteger(value.attemptCountToday) || value.attemptCountToday < 0
    || !Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 0
    || [value.lastAttemptAt, value.lastCompletedAt].some(time => time !== undefined
      && (!Number.isSafeInteger(time) || time < 0))) throw new Error('public-exploration-quota-invalid');
  return value;
}

function latest(...times: Array<number | undefined>) {
  const present = times.filter((time): time is number => time !== undefined);
  return present.length ? Math.max(...present) : undefined;
}

/** Read raw legacy values: the former GitHub normalizer discarded midnight timestamps. */
export function normalizePublicExplorationQuota(
  webRaw: string | null | undefined, githubRaw: string | null | undefined, now: number,
): PublicExplorationQuota {
  const web = readQuota(webRaw);
  const github = web?.quotaVersion === 2 ? undefined : readQuota(githubRaw);
  const dateKey = explorationDateKey(now);
  const today = [web, github].filter((state): state is PreviousQuota => !!state && state.dateKey === dateKey);
  const attemptCountToday = today.reduce((count, state) => count + state.attemptCountToday, 0);
  if (!Number.isSafeInteger(attemptCountToday)) throw new Error('public-exploration-quota-invalid');
  return {
    quotaVersion: 2, dateKey, attemptCountToday,
    consecutiveFailures: Math.max(0, ...today.map(state => state.consecutiveFailures)),
    lastAttemptAt: latest(web?.lastAttemptAt, github?.lastAttemptAt),
    lastCompletedAt: latest(web?.lastCompletedAt, github?.lastCompletedAt),
  };
}

/** Restoring a copy never refunds this phone's attempts or adds the same attempts twice. */
export function restorePublicExplorationQuota(
  current: Record<string, string>, restored: Record<string, string>, now: number,
) {
  if (![current, restored].some(storage => storage[PUBLIC_EXPLORATION_STATE_KEY] !== undefined
    || storage[LEGACY_GITHUB_VOYAGE_STATE_KEY] !== undefined)) return restored;
  const read = (storage: Record<string, string>) => normalizePublicExplorationQuota(
    storage[PUBLIC_EXPLORATION_STATE_KEY], storage[LEGACY_GITHUB_VOYAGE_STATE_KEY], now);
  const local = read(current), incoming = read(restored);
  const combined: PublicExplorationQuota = {
    ...incoming, attemptCountToday: Math.max(local.attemptCountToday, incoming.attemptCountToday),
    consecutiveFailures: Math.max(local.consecutiveFailures, incoming.consecutiveFailures),
    lastAttemptAt: latest(local.lastAttemptAt, incoming.lastAttemptAt),
    lastCompletedAt: latest(local.lastCompletedAt, incoming.lastCompletedAt),
  };
  return { ...restored, [PUBLIC_EXPLORATION_STATE_KEY]: JSON.stringify(combined) };
}
