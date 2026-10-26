import type { BodySignalReading, StoredBodySignalReading } from './bodySignalTypes';

export type HeartRateTodaySummary = {
  average: number;
  count: number;
  latestMeasuredAt: number;
  max: number;
  min: number;
};

export type HeartRateTrendText = {
  recentText: string;
  summaryText: string;
};

function readingKey(reading: StoredBodySignalReading) {
  return [
    reading.kind,
    reading.sourceProvider,
    reading.sourceDeviceName ?? '',
    reading.measuredAt,
    reading.value,
  ].join('|');
}

function withStale(reading: StoredBodySignalReading, now: number, staleAfterMs: number): BodySignalReading {
  return {
    ...reading,
    stale: now - reading.measuredAt > staleAfterMs,
  };
}

export function startOfLocalDay(time = Date.now()) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function mergeLiveAndStoredReadings({
  live,
  limit = 20,
  now,
  staleAfterMs,
  stored,
}: {
  live?: BodySignalReading;
  limit?: number;
  now: number;
  staleAfterMs: number;
  stored: StoredBodySignalReading[];
}): BodySignalReading[] {
  const seen = new Set<string>();
  const merged: BodySignalReading[] = [];
  const candidates = [
    ...(live ? [live] : []),
    ...stored.map((reading) => withStale(reading, now, staleAfterMs)),
  ].sort((left, right) => right.measuredAt - left.measuredAt);

  candidates.forEach((reading) => {
    const key = readingKey(reading);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(reading);
  });

  return merged.slice(0, Math.max(0, limit));
}

export function summarizeHeartRateReadings(readings: readonly StoredBodySignalReading[]): HeartRateTodaySummary | undefined {
  const heartRates = readings
    .filter((reading) => reading.kind === 'heart_rate' && Number.isFinite(reading.value) && reading.value > 0)
    .sort((left, right) => right.measuredAt - left.measuredAt);
  if (!heartRates.length) return undefined;

  const values = heartRates.map((reading) => reading.value);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    average: Math.round(total / values.length),
    count: values.length,
    latestMeasuredAt: heartRates[0].measuredAt,
    max: Math.max(...values),
    min: Math.min(...values),
  };
}

export function formatHeartRateTrendText(summary?: HeartRateTodaySummary, recentReadings: readonly BodySignalReading[] = []): HeartRateTrendText {
  const summaryText = summary
    ? `今日 ${summary.count} 个样本 · 平均 ${summary.average} bpm · ${summary.min}-${summary.max}`
    : '今日还没有形成趋势';
  const recentText = recentReadings.length
    ? recentReadings
        .slice(0, 5)
        .map((reading) => `${reading.value} bpm`)
        .join(' · ')
    : '暂无最近读数';

  return { recentText, summaryText };
}
