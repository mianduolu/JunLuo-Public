import {
  runActivityObservationsOutboxPromotionRuntime,
} from './syncActivityObservationsRuntime';
import {
  runBodySignalHealthOutboxPromotionRuntime,
} from './syncBodySignalHealthRuntime';

const MAX_DOMAIN_PROMOTION_CLAIM = 100;

export async function prepareAndPromoteHighNoiseDomains(input: {
  mode: 'automatic' | 'manual';
  limit: number;
  now: number;
}) {
  const bodyLimit = Math.min(
    MAX_DOMAIN_PROMOTION_CLAIM,
    Math.max(1, Math.floor(input.limit / 2)),
  );
  const body = await runBodySignalHealthOutboxPromotionRuntime({
    limit: bodyLimit,
    now: input.now,
    prepareSummaries: true,
    summaryMode: input.mode,
  });
  if (body.status === 'partial-failure') {
    throw new Error('body-signal.health 有汇总同步件尚未安全入队。');
  }
  const activityLimit = Math.min(
    MAX_DOMAIN_PROMOTION_CLAIM,
    Math.max(
      1,
      input.limit - body.report.dispatchedCount,
    ),
  );
  const activity = await runActivityObservationsOutboxPromotionRuntime({
    limit: activityLimit,
    now: input.now,
    refreshCapturedRows: true,
    summaryMode: input.mode,
  });
  if (activity.status === 'partial-failure') {
    throw new Error('activity.observations 有汇总同步件尚未安全入队。');
  }
  return body.report.dispatchedCount + activity.report.dispatchedCount;
}
