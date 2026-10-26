import { bucketBodySignalBaselineSamples, buildBodySignalPersonalBaseline } from './bodySignalBaseline';
import { sha256 } from '@noble/hashes/sha2.js';
import type { StoredBodySignalReading } from './bodySignalTypes';
import { validateMiBand6SleepStages } from './miBand6SleepStages';
import type { MiBand6SavedSleep } from './miBand6SleepTypes';

export const SLEEP_HEART_RATE_BUCKET_MS = 300_000;
export const SLEEP_HEART_RATE_RETENTION_MS = 28 * 86_400_000;
const RAW_RETENTION_MS = 3 * 86_400_000;
const ALGORITHM_VERSION = 'mi-band-6-sleep-v2';

export type SleepHeartRateBucket = {
  deviceProfileId: string;
  wakeDateKey: string;
  bucketStartedAt: number;
  value: number;
  readingCount: number;
  sleepProvider: 'mi_band_6';
  heartRateProvider: 'standard_gatt';
  algorithmVersion: string;
  sourceKey: string;
  unreviewed: boolean;
};
export type SleepHeartRateReference = {
  bucketCount: number;
  dateCount: number;
  readiness: 'learning' | 'mature';
  median?: number;
  unreviewed: boolean;
};
export type SleepHeartRateNight = {
  status: 'available' | 'no_sleep' | 'no_stages' | 'no_readings' | 'raw_expired';
  median?: number;
  buckets: SleepHeartRateBucket[];
  unreviewed: boolean;
};

function validTime(at: number): boolean {
  return Number.isSafeInteger(at) && at > 0 && Number.isFinite(new Date(at).getTime());
}

export function sleepHeartRateDateKey(at: number): string {
  return new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** Canonical evidence identity: repeated observations alone never revise attribution. */
export function sleepHeartRateSourceKey(record: MiBand6SavedSleep): string | undefined {
  if (!record || record.algorithmVersion !== ALGORITHM_VERSION || record.sourceProvider !== 'mi_band_6'
    || !record.deviceProfileId?.trim() || !validTime(record.startedAt) || !validTime(record.endedAt)
    || record.startedAt >= record.endedAt || sleepHeartRateDateKey(record.endedAt) !== record.dateKey) return undefined;
  const stages = validateMiBand6SleepStages(record, record.stages);
  if (!stages) return undefined;
  const canonical = JSON.stringify([record.algorithmVersion, record.startedAt, record.endedAt, record.totalMinutes,
    stages.segments.map(segment => [segment.startedAt, segment.endedAt, segment.stage])]);
  return Array.from(sha256(Uint8Array.from(canonical, character => character.charCodeAt(0))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function buildSleepHeartRateBuckets(record: MiBand6SavedSleep,
  readings: readonly (StoredBodySignalReading & { id: string })[], now: number): SleepHeartRateBucket[] {
  const sourceKey = sleepHeartRateSourceKey(record);
  if (!sourceKey || !validTime(now) || record.endedAt > now) return [];
  const segments = record.stages!.segments;
  const seen = new Set<string>();
  const samples: { measuredAt: number; value: number }[] = [];
  const counts = new Map<number, number>();
  for (const reading of readings) {
    if (!reading.id || seen.has(reading.id) || reading.deviceProfileId !== record.deviceProfileId
      || reading.sourceProvider !== 'standard_gatt' || reading.kind !== 'heart_rate' || reading.unit !== 'bpm'
      || !['high', 'medium'].includes(reading.confidence) || !validTime(reading.measuredAt)
      || !Number.isFinite(reading.value) || reading.value <= 0) continue;
    const bucket = Math.floor(reading.measuredAt / SLEEP_HEART_RATE_BUCKET_MS) * SLEEP_HEART_RATE_BUCKET_MS;
    // Do not replace a previously learned whole bucket with a partially expired raw window.
    if (bucket < now - RAW_RETENTION_MS || bucket + SLEEP_HEART_RATE_BUCKET_MS > now
      || !segments.some(segment => reading.measuredAt >= segment.startedAt && reading.measuredAt < segment.endedAt)) continue;
    seen.add(reading.id);
    samples.push({ measuredAt: reading.measuredAt, value: reading.value });
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return bucketBodySignalBaselineSamples(samples).map(sample => ({
    deviceProfileId: record.deviceProfileId, wakeDateKey: record.dateKey,
    bucketStartedAt: sample.measuredAt, value: sample.value, readingCount: counts.get(sample.measuredAt)!,
    sleepProvider: 'mi_band_6', heartRateProvider: 'standard_gatt',
    algorithmVersion: ALGORITHM_VERSION, sourceKey, unreviewed: false,
  }));
}

function retainedBuckets(buckets: readonly SleepHeartRateBucket[], profile: string, now: number): SleepHeartRateBucket[] {
  if (!profile || !validTime(now)) return [];
  const unique = new Map<number, SleepHeartRateBucket>();
  for (const bucket of buckets) {
    if (bucket.deviceProfileId !== profile || bucket.sleepProvider !== 'mi_band_6'
      || bucket.heartRateProvider !== 'standard_gatt' || bucket.algorithmVersion !== ALGORITHM_VERSION
      || !bucket.sourceKey || !validTime(bucket.bucketStartedAt) || bucket.bucketStartedAt % SLEEP_HEART_RATE_BUCKET_MS !== 0
      || bucket.bucketStartedAt <= now - SLEEP_HEART_RATE_RETENTION_MS
      || bucket.bucketStartedAt + SLEEP_HEART_RATE_BUCKET_MS > now
      || !Number.isFinite(bucket.value) || bucket.value <= 0
      || !Number.isSafeInteger(bucket.readingCount) || bucket.readingCount <= 0) continue;
    if (!unique.has(bucket.bucketStartedAt)) unique.set(bucket.bucketStartedAt, bucket);
  }
  return [...unique.values()].sort((a, b) => a.bucketStartedAt - b.bucketStartedAt);
}

export function buildSleepHeartRateReference(buckets: readonly SleepHeartRateBucket[],
  deviceProfileId: string, now: number): SleepHeartRateReference {
  const retained = retainedBuckets(buckets, deviceProfileId, now);
  const baseline = buildBodySignalPersonalBaseline({ context: 'sleeping', deviceProfileId, now,
    dateKeyForTimestamp: sleepHeartRateDateKey,
    samples: retained.map(bucket => ({ measuredAt: bucket.bucketStartedAt, value: bucket.value })),
  });
  return { bucketCount: baseline?.bucketCount ?? 0, dateCount: baseline?.dateCount ?? 0,
    readiness: baseline?.readiness ?? 'learning',
    ...(baseline ? { median: baseline.median } : {}), unreviewed: retained.some(bucket => bucket.unreviewed) };
}

export function buildSleepHeartRateNight(record: MiBand6SavedSleep | undefined,
  buckets: readonly SleepHeartRateBucket[], now: number, unreviewed = false): SleepHeartRateNight {
  if (!record) return { status: 'no_sleep', buckets: [], unreviewed: false };
  const sourceKey = sleepHeartRateSourceKey(record);
  if (!sourceKey) return { status: 'no_stages', buckets: [], unreviewed };
  const selected = retainedBuckets(buckets.filter(bucket => bucket.wakeDateKey === record.dateKey
    && bucket.sourceKey === sourceKey), record.deviceProfileId, now);
  if (!selected.length) return { status: record.endedAt <= now - RAW_RETENTION_MS ? 'raw_expired' : 'no_readings',
    buckets: [], unreviewed };
  const reference = buildSleepHeartRateReference(selected, record.deviceProfileId, now);
  return { status: 'available', buckets: selected, median: reference.median,
    unreviewed: unreviewed || reference.unreviewed };
}
