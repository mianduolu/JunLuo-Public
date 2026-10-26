export const AI_BACKGROUND_WINDOW_MS = 4 * 60 * 1000;
export const AI_MAX_BACKGROUND_PER_WINDOW = 2;
export const AI_DEFAULT_BACKGROUND_INTERVAL_MS = 12 * 60 * 1000;

const KIND_BACKGROUND_INTERVAL_MS: Partial<Record<string, number>> = {
  affectState: 0, // Six-round eligibility / life and failure spacing belong to this paper.
  sleepNearStatus: 0, // Persisted sleep slots control spacing; the shared budget still applies.
  afterglow: 5 * 60 * 1000, // The reader enforces 15m for new batches and 5m for its two retries.
  cameraVision: 0, // The camera interval and its single immediate retry own spacing.
  reading: 0, // Saved effective reading time owns each 25-minute opportunity.
  dayPlan: 0, // Each persisted sleep/wake opportunity owns its three transports, including tools.
  postReply: 0, // A saved first-paper choice owns eligibility; the shared budget still applies.
  postVision: 0, // Each image group's persisted opportunity owns its two attempts.
  giftReception: 0, // The saved gift decision and attempt own this opportunity.
  giftUnderstanding: 0, // Each saved original advances in its existing gift order.
  giftReply: 0, // Each saved you echo and selected original own their work stages.
  giftCreation: 0, // A durable own-time opportunity owns at most three transports.
  lifeStatePolish: 30 * 60 * 1000,
  contextualLetter: 45 * 60 * 1000,
  dream: 30 * 60 * 1000,
  embeddingBackfill: 20 * 60 * 1000,
  proactive: 0, // The unified opportunity owns its 5/15/30m wait and single 5m retry.
};

export type BackgroundBudgetRecord = {
  startedAt?: number;
  endedAt: number;
  kind: string;
  priority: string;
};

export function getBackgroundCallRetryAfter(
  records: BackgroundBudgetRecord[],
  kind: string,
  now: number,
  skipKindInterval = false,
) {
  const recentBackground = records
    .filter((record) =>
      record.priority === 'background'
      && now - record.endedAt < AI_BACKGROUND_WINDOW_MS,
    )
    .sort((left, right) => left.endedAt - right.endedAt);
  const windowRetryAfter = recentBackground.length >= AI_MAX_BACKGROUND_PER_WINDOW
    ? recentBackground[recentBackground.length - AI_MAX_BACKGROUND_PER_WINDOW].endedAt
      + AI_BACKGROUND_WINDOW_MS
    : 0;

  const lastSameKind = records
    .filter((record) => record.kind === kind)
    .sort((left, right) => right.endedAt - left.endedAt)[0];
  const interval = KIND_BACKGROUND_INTERVAL_MS[kind] ?? AI_DEFAULT_BACKGROUND_INTERVAL_MS;
  const kindRetryAfter = lastSameKind && !skipKindInterval ? (
    (kind === 'afterglow' || kind === 'lifeStatePolish')
      ? lastSameKind.startedAt ?? lastSameKind.endedAt
      : lastSameKind.endedAt
  ) + interval : 0;
  const retryAfter = Math.max(windowRetryAfter, kindRetryAfter);
  return retryAfter > now ? retryAfter : undefined;
}

export function getBackgroundCallBatchRetryAfter(
  records: BackgroundBudgetRecord[],
  kind: string,
  now: number,
  requestedCount: number,
  skipKindInterval = false,
) {
  if (!Number.isInteger(requestedCount) || requestedCount < 1) return now;
  const recentBackground = records
    .filter((record) => record.priority === 'background' && now - record.endedAt < AI_BACKGROUND_WINDOW_MS)
    .sort((left, right) => left.endedAt - right.endedAt);
  const available = Math.max(0, AI_MAX_BACKGROUND_PER_WINDOW - recentBackground.length);
  const capacityRetryAfter = available >= requestedCount
    ? 0
    : recentBackground[Math.max(0, recentBackground.length - (AI_MAX_BACKGROUND_PER_WINDOW - requestedCount + 1))]?.endedAt
      + AI_BACKGROUND_WINDOW_MS;
  const ordinaryRetryAfter = getBackgroundCallRetryAfter(records, kind, now, skipKindInterval) ?? 0;
  const retryAfter = Math.max(capacityRetryAfter || 0, ordinaryRetryAfter);
  return retryAfter > now ? retryAfter : undefined;
}
