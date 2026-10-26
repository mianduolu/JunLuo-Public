import type {
  BodySignalActivityDailySummary,
  BodySignalActivitySample,
} from './bodySignalStructuredTypes';
import {
  assertBodySignalActivityDailySummary,
  assertBodySignalActivitySample,
} from './bodySignalStructuredValidation';
import type { BodySignalDeviceProfile } from './device/bodySignalDeviceTypes';
import type { MiBand6ActivityBatch, MiBand6ActivitySaveResult } from './miBand6ActivityTypes';
import { activitySummaryWriter, initializeActivitySummaryBatch, type ActivityMinuteRow } from './bodySignalActivitySummaryStore';

const ACTIVITY_MINUTE_MS = 60_000;
const ACTIVITY_MAX_BYTES = 128 * 1024;
const ACTIVITY_MAX_SAMPLES = 16_384;
const ACTIVITY_MAX_NORMALIZED_BYTES = 256 * 1024;
const ACTIVITY_DETAIL_RETENTION_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_CLEANUP_BATCH_SIZE = 256;
const ACTIVITY_CLEANUP_MAX_BATCHES = 8;

function oldestActivitySummaryDate(now = Date.now()): string {
  const date = new Date(now);
  date.setDate(date.getDate() - 6);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

let cleanupPending: Promise<{ samplesDeleted: number; summariesDeleted: number }> | undefined;

// Run only during existing activity work. Bound each transaction and each invocation.
export function pruneBodySignalActivityHistory() {
  if (cleanupPending) return cleanupPending;
  const task = (async () => {
    const { getBodySignalDatabase } = await import('./bodySignalStore');
    const database = await getBodySignalDatabase();
    const cutoff = Date.now() - ACTIVITY_DETAIL_RETENTION_MS;
    const oldestDate = oldestActivitySummaryDate();
    const result = { samplesDeleted: 0, summariesDeleted: 0 };
    for (let batch = 0; batch < ACTIVITY_CLEANUP_MAX_BATCHES; batch++) {
      let samples = 0;
      let summaries = 0;
      let initialized = 0;
      await database.withExclusiveTransactionAsync(async transaction => {
        initialized = await initializeActivitySummaryBatch(transaction, ACTIVITY_CLEANUP_BATCH_SIZE);
        const expired = await transaction.getAllAsync<ActivityMinuteRow>(
          `SELECT * FROM body_signal_activity_samples WHERE ended_at <= ? AND summary_date_key IS NOT NULL
           ORDER BY ended_at, id LIMIT ?`, cutoff, ACTIVITY_CLEANUP_BATCH_SIZE);
        for (const row of expired) {
          await transaction.runAsync(`UPDATE body_signal_activity_daily_summaries
            SET sealed_through_at = MAX(COALESCE(sealed_through_at, 0), ?)
            WHERE device_profile_id = ? AND source_provider = ? AND date_key = ?`,
          row.ended_at, row.device_profile_id, row.source_provider, row.summary_date_key);
        }
        samples = (await transaction.runAsync(
          `DELETE FROM body_signal_activity_samples WHERE id IN (
             SELECT id FROM body_signal_activity_samples WHERE ended_at <= ? AND summary_date_key IS NOT NULL
             ORDER BY ended_at, id LIMIT ?
           )`, cutoff, ACTIVITY_CLEANUP_BATCH_SIZE,
        )).changes;
        summaries = (await transaction.runAsync(
          `DELETE FROM body_signal_activity_daily_summaries WHERE id IN (
             SELECT id FROM body_signal_activity_daily_summaries WHERE date_key < ? LIMIT 32
           )`, oldestDate,
        )).changes;
      });
      result.samplesDeleted += samples;
      result.summariesDeleted += summaries;
      if (samples < ACTIVITY_CLEANUP_BATCH_SIZE && summaries < 32 && initialized < ACTIVITY_CLEANUP_BATCH_SIZE) break;
    }
    return result;
  })();
  cleanupPending = task;
  void task.finally(() => { if (cleanupPending === task) cleanupPending = undefined; }).catch(() => undefined);
  return task;
}

function normalizeMiBand6ActivityBatch(batch: MiBand6ActivityBatch): MiBand6ActivityBatch {
  const now = Date.now();
  for (const value of [batch.requestedSinceAt, batch.startedAt, batch.observedAt]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > now
      || !Number.isFinite(new Date(value).getTime())) {
      throw new RangeError('activity_invalid_time');
    }
  }
  if (batch.requestedSinceAt % ACTIVITY_MINUTE_MS !== 0
    || batch.startedAt % ACTIVITY_MINUTE_MS !== 0
    || batch.requestedSinceAt > batch.startedAt || batch.startedAt > batch.observedAt) {
    throw new RangeError('activity_invalid_minute');
  }
  if (!Array.isArray(batch.samples) || batch.samples.length > ACTIVITY_MAX_SAMPLES
    || !Number.isSafeInteger(batch.packetCount) || batch.packetCount < 0
    || batch.packetCount > 8192) {
    throw new RangeError('activity_invalid_size');
  }
  if (!Number.isInteger(batch.reportedSize) || batch.reportedSize < 0 || batch.reportedSize > ACTIVITY_MAX_SAMPLES
    || !Number.isInteger(batch.byteCount) || batch.byteCount < batch.samples.length * 8
    || batch.byteCount > ACTIVITY_MAX_BYTES || batch.byteCount % 8 !== 0) throw new RangeError('activity_invalid_size');
  const closedCount = Math.min(batch.reportedSize,
    Math.floor((batch.observedAt - batch.startedAt) / ACTIVITY_MINUTE_MS));
  if (batch.byteCount !== batch.reportedSize * 8 || batch.samples.length < closedCount
    || batch.samples.length > batch.reportedSize) throw new RangeError('activity_length_mismatch');
  if (batch.reportedSize > 0
    && batch.startedAt + (batch.reportedSize - 1) * ACTIVITY_MINUTE_MS > batch.observedAt) {
    throw new RangeError('activity_future_sample');
  }
  if (new TextEncoder().encode(JSON.stringify(batch)).byteLength > ACTIVITY_MAX_NORMALIZED_BYTES) {
    throw new RangeError('activity_normalized_size_exceeded');
  }
  const samples: MiBand6ActivityBatch['samples'] = [];
  for (const sample of batch.samples) {
    if (!Array.isArray(sample) || sample.length !== 2
      || [sample[0], sample[1]].some(value => !Number.isSafeInteger(value) || value < 0 || value > 255)) {
      throw new RangeError('activity_invalid_sample');
    }
    samples.push([sample[0], sample[1]]);
  }
  if (samples.length > 0
    && batch.startedAt + (samples.length - 1) * ACTIVITY_MINUTE_MS > batch.observedAt) {
    throw new RangeError('activity_future_sample');
  }
  return {
    requestedSinceAt: batch.requestedSinceAt,
    startedAt: batch.startedAt,
    observedAt: batch.observedAt,
    samples,
    reportedSize: batch.reportedSize,
    byteCount: batch.byteCount,
    packetCount: batch.packetCount,
  };
}

export async function saveMiBand6ActivityBatch(
  deviceProfileId: string,
  input: MiBand6ActivityBatch,
): Promise<MiBand6ActivitySaveResult> {
  if (typeof deviceProfileId !== 'string' || !deviceProfileId.trim()) {
    throw new RangeError('activity_profile_missing');
  }
  const batch = normalizeMiBand6ActivityBatch(input);
  const result: MiBand6ActivitySaveResult = {
    savedCount: 0,
    ...(batch.requestedSinceAt < batch.startedAt ? {
      gap: { startedAt: batch.requestedSinceAt, endedAt: batch.startedAt },
    } : {}),
  };
  // Use the observation time even on pending-event replay: an open minute stays incomplete.
  const completedCount = Math.min(batch.samples.length,
    Math.floor((batch.observedAt - batch.startedAt) / ACTIVITY_MINUTE_MS));
  const retentionCutoff = Date.now() - ACTIVITY_DETAIL_RETENTION_MS;
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const profile = await transaction.getFirstAsync<Pick<BodySignalDeviceProfile, 'family'>>(
      'SELECT family FROM body_signal_devices WHERE id = ?',
      deviceProfileId,
    );
    if (!profile) throw new Error('activity_profile_missing');
    if (profile.family !== 'mi_band_6') throw new Error('activity_profile_unsupported');
    const previous = await transaction.getAllAsync<ActivityMinuteRow & { intensity: number | null }>(
      `SELECT * FROM body_signal_activity_samples
        WHERE device_profile_id = ? AND source_provider = 'mi_band_6' AND started_at >= ? AND started_at < ?`,
      deviceProfileId, batch.startedAt, batch.startedAt + completedCount * ACTIVITY_MINUTE_MS,
    );
    const byMinute = new Map(previous.map(row => [row.started_at, row]));
    const summaryWriter = activitySummaryWriter(transaction);
    for (let index = 0; index < completedCount; index++) {
      const startedAt = batch.startedAt + index * ACTIVITY_MINUTE_MS;
      if (startedAt + ACTIVITY_MINUTE_MS <= retentionCutoff) continue;
      const [steps, intensity] = batch.samples[index];
      const key = `minute:${startedAt}`;
      const old = byMinute.get(startedAt);
      if (old && old.updated_at >= batch.observedAt) continue;
      const changed = !old || old.steps !== steps || old.intensity !== intensity;
      const sample: ActivityMinuteRow = { id: `mi_band_6:activity:${deviceProfileId}:${startedAt}`,
        device_profile_id: deviceProfileId, source_provider: 'mi_band_6', provider_sample_key: key,
        started_at: startedAt, ended_at: startedAt + ACTIVITY_MINUTE_MS, steps,
        updated_at: batch.observedAt, summary_date_key: old?.summary_date_key ?? null };
      if (!await summaryWriter.apply(sample, old)) continue;
      // A newer identical observation still advances its watermark, so older corrections cannot win.
      await transaction.runAsync(
        `INSERT INTO body_signal_activity_samples (
           id, device_profile_id, source_provider, provider_sample_key,
           started_at, ended_at, steps, intensity, created_at, updated_at, summary_date_key
         ) VALUES (?, ?, 'mi_band_6', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_profile_id, source_provider, provider_sample_key) DO UPDATE SET
           steps = excluded.steps,
           intensity = excluded.intensity,
           summary_date_key = excluded.summary_date_key,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at > body_signal_activity_samples.updated_at`,
        `mi_band_6:activity:${deviceProfileId}:${startedAt}`,
        deviceProfileId,
        key,
        startedAt,
        startedAt + ACTIVITY_MINUTE_MS,
        steps,
        intensity,
        batch.observedAt,
        batch.observedAt,
        sample.summary_date_key,
      );
      if (changed) result.savedCount += 1;
    }
    await summaryWriter.flush();
    if (completedCount === 0) return;
    const syncedThroughAt = batch.startedAt + completedCount * ACTIVITY_MINUTE_MS;
    await transaction.runAsync(
      `INSERT INTO body_signal_sync_cursors (
         device_profile_id, source_provider, stream, synced_through_at, updated_at
       ) VALUES (?, 'mi_band_6', 'activity_history', ?, ?)
       ON CONFLICT(device_profile_id, source_provider, stream) DO UPDATE SET
         synced_through_at = excluded.synced_through_at,
         updated_at = MAX(body_signal_sync_cursors.updated_at, excluded.updated_at)
       WHERE body_signal_sync_cursors.synced_through_at IS NULL
          OR excluded.synced_through_at > body_signal_sync_cursors.synced_through_at`,
      deviceProfileId,
      syncedThroughAt,
      batch.observedAt,
    );
    const cursor = await transaction.getFirstAsync<{ synced_through_at: number }>(
      `SELECT synced_through_at FROM body_signal_sync_cursors
        WHERE device_profile_id = ? AND source_provider = 'mi_band_6' AND stream = 'activity_history'`,
      deviceProfileId,
    );
    result.syncedThroughAt = cursor!.synced_through_at;
  });
  // A cleanup failure must not turn a committed batch into a failed save/ACK.
  await pruneBodySignalActivityHistory().catch(() => undefined);
  return result;
}

export async function saveBodySignalActivitySample(
  sample: BodySignalActivitySample,
): Promise<void> {
  assertBodySignalActivitySample(sample);
  if (sample.endedAt <= Date.now() - ACTIVITY_DETAIL_RETENTION_MS) return;
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.withExclusiveTransactionAsync(async transaction => {
  const previous = await transaction.getFirstAsync<ActivityMinuteRow>(`SELECT * FROM body_signal_activity_samples
    WHERE device_profile_id = ? AND source_provider = ? AND provider_sample_key = ?`,
  sample.deviceProfileId, sample.sourceProvider, sample.providerSampleKey);
  if (previous && previous.updated_at >= sample.updatedAt) return;
  const row: ActivityMinuteRow = { id: sample.id, device_profile_id: sample.deviceProfileId,
    source_provider: sample.sourceProvider, provider_sample_key: sample.providerSampleKey,
    started_at: sample.startedAt, ended_at: sample.endedAt, steps: sample.steps ?? null,
    updated_at: sample.updatedAt, summary_date_key: previous?.summary_date_key ?? null };
  if (previous && (previous.started_at !== sample.startedAt || previous.ended_at !== sample.endedAt)) {
    throw new Error('activity_sample_identity_changed');
  }
  const writer = activitySummaryWriter(transaction);
  if (!await writer.apply(row, previous ?? undefined)) return;
  await transaction.runAsync(
    `INSERT INTO body_signal_activity_samples (
       id, device_profile_id, source_provider, provider_sample_key,
       started_at, ended_at, steps, distance_meters, calories_kcal,
       intensity, heart_rate, created_at, updated_at, summary_date_key
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_profile_id, source_provider, provider_sample_key)
     DO UPDATE SET
       ended_at = excluded.ended_at,
       steps = excluded.steps,
       distance_meters = excluded.distance_meters,
       calories_kcal = excluded.calories_kcal,
       intensity = excluded.intensity,
       heart_rate = excluded.heart_rate,
       summary_date_key = excluded.summary_date_key,
       updated_at = excluded.updated_at`,
    sample.id,
    sample.deviceProfileId,
    sample.sourceProvider,
    sample.providerSampleKey,
    sample.startedAt,
    sample.endedAt,
    sample.steps ?? null,
    sample.distanceMeters ?? null,
    sample.caloriesKcal ?? null,
    sample.intensity ?? null,
    sample.heartRate ?? null,
    sample.createdAt,
    sample.updatedAt,
    row.summary_date_key,
  );
  await writer.flush();
  });
  await pruneBodySignalActivityHistory().catch(() => undefined);
}

export async function loadBodySignalActivitySamplesSince(
  deviceProfileId: string,
  since: number,
): Promise<BodySignalActivitySample[]> {
  await pruneBodySignalActivityHistory().catch(() => undefined);
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  const rows = await database.getAllAsync<Record<string, string | number | null>>(
    `SELECT * FROM body_signal_activity_samples
      WHERE device_profile_id = ? AND ended_at >= ? AND ended_at > ?
      ORDER BY started_at ASC`,
    deviceProfileId,
    since,
    Date.now() - ACTIVITY_DETAIL_RETENTION_MS,
  );
  return rows.map((row) => ({
    ...(row.calories_kcal !== null ? { caloriesKcal: Number(row.calories_kcal) } : {}),
    createdAt: Number(row.created_at),
    deviceProfileId: String(row.device_profile_id),
    ...(row.distance_meters !== null ? { distanceMeters: Number(row.distance_meters) } : {}),
    endedAt: Number(row.ended_at),
    ...(row.heart_rate !== null ? { heartRate: Number(row.heart_rate) } : {}),
    id: String(row.id),
    ...(row.intensity !== null ? { intensity: Number(row.intensity) } : {}),
    providerSampleKey: String(row.provider_sample_key),
    sourceProvider: String(row.source_provider) as BodySignalActivitySample['sourceProvider'],
    startedAt: Number(row.started_at),
    ...(row.steps !== null ? { steps: Number(row.steps) } : {}),
    updatedAt: Number(row.updated_at),
  }));
}

export async function saveBodySignalActivityDailySummary(
  summary: BodySignalActivityDailySummary,
): Promise<void> {
  assertBodySignalActivityDailySummary(summary);
  if (summary.dateKey < oldestActivitySummaryDate()) return;
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.withExclusiveTransactionAsync(async transaction => {
  const existing = await transaction.getFirstAsync<{ summary_version: number }>(
    `SELECT summary_version FROM body_signal_activity_daily_summaries
     WHERE device_profile_id = ? AND source_provider = ? AND date_key = ?`,
    summary.deviceProfileId, summary.sourceProvider, summary.dateKey);
  if (existing?.summary_version === 1) throw new Error('activity_derived_summary_read_only');
  await transaction.runAsync(
    `INSERT INTO body_signal_activity_daily_summaries (
       id, device_profile_id, source_provider, date_key, steps,
       distance_meters, calories_kcal, active_minutes,
       sedentary_minutes, sample_count, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_profile_id, source_provider, date_key) DO UPDATE SET
       steps = excluded.steps,
       distance_meters = excluded.distance_meters,
       calories_kcal = excluded.calories_kcal,
       active_minutes = excluded.active_minutes,
       sedentary_minutes = excluded.sedentary_minutes,
       sample_count = excluded.sample_count,
       updated_at = excluded.updated_at`,
    summary.id,
    summary.deviceProfileId,
    summary.sourceProvider,
    summary.dateKey,
    summary.steps,
    summary.distanceMeters ?? null,
    summary.caloriesKcal ?? null,
    summary.activeMinutes,
    summary.sedentaryMinutes,
    summary.sampleCount,
    summary.updatedAt,
  );
  });
  await pruneBodySignalActivityHistory().catch(() => undefined);
}
