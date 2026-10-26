import type { BodySignalKind } from './bodySignalTypes';
import type {
  BodySignalContextBucket,
  BodySignalPersonalBaseline,
} from './bodySignalStructuredTypes';

export const BODY_SIGNAL_BASELINE_ALGORITHM_VERSION = 1;
export const BODY_SIGNAL_BASELINE_MIN_BUCKETS = 20;
export const BODY_SIGNAL_BASELINE_MIN_DATES = 7;
export const BODY_SIGNAL_BASELINE_WINDOW_DAYS = 28;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

export type BodySignalBaselineSample = {
  measuredAt: number;
  value: number;
};

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function bucketBodySignalBaselineSamples(
  samples: readonly BodySignalBaselineSample[],
): BodySignalBaselineSample[] {
  const buckets = new Map<number, number[]>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.value) || !Number.isFinite(sample.measuredAt)) continue;
    const bucket = Math.floor(sample.measuredAt / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
    const values = buckets.get(bucket) ?? [];
    values.push(sample.value);
    buckets.set(bucket, values);
  }
  return [...buckets.entries()]
    .map(([measuredAt, values]) => ({ measuredAt, value: median(values) }))
    .sort((left, right) => left.measuredAt - right.measuredAt);
}

export function buildBodySignalPersonalBaseline(input: {
  context: BodySignalContextBucket;
  deviceProfileId: string;
  kind?: BodySignalKind;
  now?: number;
  dateKeyForTimestamp?: (timestamp: number) => string;
  samples: readonly BodySignalBaselineSample[];
}): BodySignalPersonalBaseline | undefined {
  const now = input.now ?? Date.now();
  const windowStartedAt = now - BODY_SIGNAL_BASELINE_WINDOW_DAYS * 86_400_000;
  const raw = input.samples.filter((sample) => sample.measuredAt >= windowStartedAt && sample.measuredAt <= now);
  const buckets = bucketBodySignalBaselineSamples(raw);
  if (buckets.length === 0) return undefined;
  const values = buckets.map((sample) => sample.value);
  const central = median(values);
  const deviations = values.map((value) => Math.abs(value - central));
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  const dateCount = new Set(buckets.map((sample) => (input.dateKeyForTimestamp ?? localDateKey)(sample.measuredAt))).size;
  const kind = input.kind ?? 'heart_rate';
  return {
    algorithmVersion: BODY_SIGNAL_BASELINE_ALGORITHM_VERSION,
    average,
    bucketCount: buckets.length,
    context: input.context,
    dateCount,
    deviceProfileId: input.deviceProfileId,
    id: `baseline:${input.deviceProfileId}:${kind}:${input.context}`,
    kind,
    mad: median(deviations),
    maximum: Math.max(...values),
    median: central,
    minimum: Math.min(...values),
    p10: percentile(values, 0.1),
    p90: percentile(values, 0.9),
    readiness: dateCount >= BODY_SIGNAL_BASELINE_MIN_DATES
      && buckets.length >= BODY_SIGNAL_BASELINE_MIN_BUCKETS
      ? 'mature'
      : 'learning',
    sampleCount: raw.length,
    standardDeviation: Math.sqrt(variance),
    updatedAt: now,
    windowEndedAt: now,
    windowStartedAt,
  };
}

export function bodySignalBaselineThresholds(baseline: BodySignalPersonalBaseline) {
  const robustSigma = 1.4826 * baseline.mad;
  const regularDelta = Math.max(12, 3 * robustSigma);
  const clearDelta = Math.max(25, 5 * robustSigma);
  return {
    clearHigh: baseline.median + clearDelta,
    clearLow: baseline.median - clearDelta,
    regularHigh: baseline.median + regularDelta,
    regularLow: baseline.median - regularDelta,
  };
}
