import type { SQLiteDatabase } from 'expo-sqlite';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { getBodySignalDatabase } from './bodySignalStore';
import { loadMiBand6SleepHistory } from './miBand6SleepStore';
import { buildSleepHeartRateBuckets, buildSleepHeartRateNight, buildSleepHeartRateReference,
  sleepHeartRateDateKey, sleepHeartRateSourceKey, SLEEP_HEART_RATE_BUCKET_MS,
  SLEEP_HEART_RATE_RETENTION_MS, type SleepHeartRateBucket,
  type SleepHeartRateNight, type SleepHeartRateReference } from './bodySignalSleepHeartRate';
import type { StoredBodySignalReading } from './bodySignalTypes';

const DAY = 86_400_000;
const TABLE = 'body_signal_sleep_heart_rate_buckets';
type BucketRow = { device_profile_id: string; wake_date_key: string; bucket_started_at: number;
  value: number; reading_count: number; sleep_provider: string; heart_rate_provider: string;
  algorithm_version: string; source_key: string; unreviewed: number };
type ReadingRow = { id: string; measured_at: number; value: number; confidence: StoredBodySignalReading['confidence'];
  device_profile_id: string; kind: StoredBodySignalReading['kind']; source_provider: StoredBodySignalReading['sourceProvider']; unit: string };
export type SleepHeartRateSnapshot = { deviceProfileId: string; nights: Record<string, SleepHeartRateNight>;
  reference: SleepHeartRateReference; refreshError?: string };
const listeners = new Set<() => void>();
let refreshFailure: { epoch: number | null; message: string } | undefined;

export function subscribeSleepHeartRateChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish() { for (const listener of listeners) listener(); }

async function readBuckets(database: SQLiteDatabase, deviceProfileId: string, now: number): Promise<SleepHeartRateBucket[]> {
  const rows = await database.getAllAsync<BucketRow>(`SELECT * FROM ${TABLE}
    WHERE device_profile_id = ? AND sleep_provider = 'mi_band_6' AND heart_rate_provider = 'standard_gatt'
      AND algorithm_version = 'mi-band-6-sleep-v2' AND bucket_started_at > ? AND bucket_started_at <= ?
    ORDER BY bucket_started_at`, deviceProfileId, now - SLEEP_HEART_RATE_RETENTION_MS, now - SLEEP_HEART_RATE_BUCKET_MS);
  return rows.filter(row => Number.isFinite(row.value) && row.value > 0 && Number.isSafeInteger(row.reading_count)
    && row.reading_count > 0 && Number.isSafeInteger(row.bucket_started_at)
    && row.bucket_started_at % SLEEP_HEART_RATE_BUCKET_MS === 0 && /^[a-f0-9]{64}$/.test(row.source_key)
    && /^\d{4}-\d{2}-\d{2}$/.test(row.wake_date_key) && [0, 1].includes(row.unreviewed))
    .map(row => ({ deviceProfileId: row.device_profile_id, wakeDateKey: row.wake_date_key,
      bucketStartedAt: row.bucket_started_at, value: row.value, readingCount: row.reading_count,
      sleepProvider: 'mi_band_6', heartRateProvider: 'standard_gatt', algorithmVersion: row.algorithm_version,
      sourceKey: row.source_key, unreviewed: row.unreviewed === 1 }));
}

/** Read-only: viewing and retrying cannot schedule collection or derivation. */
export async function loadSleepHeartRateSnapshot(deviceProfileId: string, now = Date.now()): Promise<SleepHeartRateSnapshot> {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) throw new Error('sleep_heart_rate_restore_pending');
  const database = await getBodySignalDatabase();
  const profile = await database.getFirstAsync<{ family: string }>('SELECT family FROM body_signal_devices WHERE id = ?', deviceProfileId);
  const history = profile?.family === 'mi_band_6'
    ? await loadMiBand6SleepHistory(deviceProfileId, now, database) : { records: [], lastBatch: undefined };
  const records = new Map(history.records.map(record => [record.dateKey, record]));
  const oldest = sleepHeartRateDateKey(now - 6 * DAY);
  const statuses = new Map(history.lastBatch?.days.map(day => [day.dateKey, day.status]));
  const buckets = profile?.family === 'mi_band_6' ? (await readBuckets(database, deviceProfileId, now))
    // Natural seven-day expiry does not invalidate the separately retained learning evidence.
    .filter(bucket => bucket.wakeDateKey < oldest || (records.has(bucket.wakeDateKey)
      && bucket.sourceKey === sleepHeartRateSourceKey(records.get(bucket.wakeDateKey)!)))
    .map(bucket => ({ ...bucket, unreviewed: statuses.has(bucket.wakeDateKey)
      ? statuses.get(bucket.wakeDateKey) !== 'recorded' : bucket.unreviewed })) : [];
  const nights: Record<string, SleepHeartRateNight> = {};
  for (let index = 0; index < 7; index++) {
    const date = sleepHeartRateDateKey(now - index * DAY);
    nights[date] = buildSleepHeartRateNight(records.get(date), buckets, now,
      statuses.has(date) && statuses.get(date) !== 'recorded');
  }
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('sleep_heart_rate_restore_changed');
  return { deviceProfileId, nights, reference: buildSleepHeartRateReference(buckets, deviceProfileId, now),
    ...(refreshFailure?.epoch === epoch ? { refreshError: refreshFailure.message } : {}) };
}

/** Called by the existing runtime, never by a page. Read and commit share one DB snapshot. */
export async function refreshSleepHeartRateHistory(now = Date.now(), signal?: AbortSignal): Promise<void> {
  const epoch = captureBackupRestoreDataEpoch();
  const active = () => {
    if (signal?.aborted || !canCommitBackupRestoreDataEpoch(epoch)) throw new Error('sleep_heart_rate_cancelled');
  };
  if (epoch === null || signal?.aborted) return;
  try {
    const database = await getBodySignalDatabase();
    const commit = () => runBackupRestoreDataEpochCommit(epoch, () => database.withExclusiveTransactionAsync(async transaction => {
      active();
      await transaction.runAsync(`DELETE FROM ${TABLE} WHERE bucket_started_at <= ?`, now - SLEEP_HEART_RATE_RETENTION_MS);
      const profiles = await transaction.getAllAsync<{ id: string }>("SELECT id FROM body_signal_devices WHERE family = 'mi_band_6'");
      // Never replace a previously complete bucket with only the tail surviving raw retention.
      const rawStartedAt = Math.ceil((now - 3 * DAY) / SLEEP_HEART_RATE_BUCKET_MS) * SLEEP_HEART_RATE_BUCKET_MS;
      for (const profile of profiles) {
        active();
        const history = await loadMiBand6SleepHistory(profile.id, now, transaction);
        const statuses = new Map(history.lastBatch?.days.map(day => [day.dateKey, day.status]));
        const rows = await transaction.getAllAsync<ReadingRow>(`SELECT id, measured_at, value, confidence,
          device_profile_id, kind, source_provider, unit FROM body_signal_readings
          WHERE device_profile_id = ? AND kind = 'heart_rate' AND source_provider = 'standard_gatt'
            AND measured_at >= ? AND measured_at <= ? AND retention_until > ? ORDER BY measured_at, id`,
        profile.id, rawStartedAt, now, now);
        const readings = rows.map(row => ({ id: row.id, measuredAt: row.measured_at, value: row.value,
          confidence: row.confidence, deviceProfileId: row.device_profile_id, kind: row.kind,
          sourceProvider: row.source_provider, unit: row.unit }));
        const keys = new Set(history.records.map(record => record.dateKey));
        const retained = await readBuckets(transaction, profile.id, now);
        for (const bucket of retained) {
          if (bucket.wakeDateKey >= sleepHeartRateDateKey(now - 6 * DAY) && !keys.has(bucket.wakeDateKey)) {
            await transaction.runAsync(`DELETE FROM ${TABLE} WHERE device_profile_id = ? AND wake_date_key = ?`, profile.id, bucket.wakeDateKey);
          }
        }
        for (const record of history.records) {
          const sourceKey = sleepHeartRateSourceKey(record);
          await transaction.runAsync(`DELETE FROM ${TABLE} WHERE device_profile_id = ? AND wake_date_key = ?
            AND (? IS NULL OR source_key <> ?)`, profile.id, record.dateKey, sourceKey ?? null, sourceKey ?? null);
          const unreviewed = statuses.has(record.dateKey) ? statuses.get(record.dateKey) !== 'recorded'
            : retained.some(bucket => bucket.wakeDateKey === record.dateKey && bucket.unreviewed);
          if (statuses.has(record.dateKey)) await transaction.runAsync(`UPDATE ${TABLE} SET unreviewed = ?
            WHERE device_profile_id = ? AND wake_date_key = ?`, Number(unreviewed), profile.id, record.dateKey);
          if (!sourceKey) continue;
          for (const bucket of buildSleepHeartRateBuckets(record, readings, now)) {
            await transaction.runAsync(`INSERT INTO ${TABLE}
              (device_profile_id, wake_date_key, bucket_started_at, value, reading_count, sleep_provider,
                heart_rate_provider, algorithm_version, source_key, unreviewed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(device_profile_id, wake_date_key, bucket_started_at) DO UPDATE SET
                value = excluded.value, reading_count = excluded.reading_count, source_key = excluded.source_key,
                algorithm_version = excluded.algorithm_version, unreviewed = excluded.unreviewed`,
            bucket.deviceProfileId, bucket.wakeDateKey, bucket.bucketStartedAt, bucket.value, bucket.readingCount,
            bucket.sleepProvider, bucket.heartRateProvider, bucket.algorithmVersion, bucket.sourceKey, Number(unreviewed));
          }
        }
      }
      active();
    }));
    const result = await (async () => {
      const delays = [150, 450, 1000];
      for (let attempt = 0; ; attempt++) {
        active();
        try { return await commit(); }
        catch (error) {
          // Expo opens a separate transaction connection. Retry only after its rollback,
          // re-reading all sources; never keep a restore lease or DB lock while waiting.
          if (attempt >= delays.length || !/database (?:table )?is locked|\bSQLITE_BUSY\b/i.test(String(error))) throw error;
          await new Promise<void>(resolve => setTimeout(resolve, delays[attempt]));
        }
      }
    })();
    if (result.committed && canCommitBackupRestoreDataEpoch(epoch) && !signal?.aborted) {
      refreshFailure = undefined;
      publish();
    }
  } catch (error) {
    if (signal?.aborted || !canCommitBackupRestoreDataEpoch(epoch)) return;
    refreshFailure = { epoch, message: '睡眠心率参考暂未更新，已有记录仍可查看；下次本地维护会重试。' };
    publish();
    throw error;
  }
}
