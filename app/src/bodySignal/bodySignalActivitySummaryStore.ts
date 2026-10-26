import type { SQLiteDatabase } from 'expo-sqlite';
import { ACTIVITY_MINUTE, activityDateKey, activityDay, activityWeek, type ActivitySummaryRow } from './bodySignalActivitySummary';

type Transaction = Pick<SQLiteDatabase, 'getFirstAsync' | 'getAllAsync' | 'runAsync'>;
export type ActivityMinuteRow = {
  id: string; device_profile_id: string; source_provider: string; provider_sample_key: string;
  started_at: number; ended_at: number; steps: number | null; updated_at: number; summary_date_key: string | null;
};

// Cache only for this transaction, so a full day's transfer writes its summary once.
export function activitySummaryWriter(transaction: Transaction, now = Date.now()) {
  const cache = new Map<string, ActivitySummaryRow>();
  const dirty = new Set<string>();
  const sealedByDevice = new Map<string, number>();
  const oldest = activityWeek(now)[0];
  return {
    async apply(sample: ActivityMinuteRow, previous?: ActivityMinuteRow): Promise<boolean> {
      if (previous?.summary_date_key && previous.steps !== null && sample.steps === null) {
        throw new Error('activity_counted_steps_required');
      }
      if (sample.source_provider !== 'mi_band_6' || sample.steps === null
        || sample.ended_at - sample.started_at !== ACTIVITY_MINUTE
        || sample.started_at % ACTIVITY_MINUTE !== 0 || sample.ended_at > now
        || sample.provider_sample_key !== `minute:${sample.started_at}`) return true;
      if (!previous) {
        if (!sealedByDevice.has(sample.device_profile_id)) {
          const sealed = await transaction.getFirstAsync<{ boundary: number | null }>(
            `SELECT MAX(sealed_through_at) AS boundary FROM body_signal_activity_daily_summaries
             WHERE device_profile_id = ? AND source_provider = 'mi_band_6'`, sample.device_profile_id);
          sealedByDevice.set(sample.device_profile_id, sealed?.boundary ?? 0);
        }
        if (sample.ended_at <= sealedByDevice.get(sample.device_profile_id)!) return false;
      }
      const dateKey = previous?.summary_date_key ?? sample.summary_date_key ?? activityDateKey(sample.started_at);
      sample.summary_date_key = dateKey;
      if (dateKey < oldest) return true;
      const key = JSON.stringify([sample.device_profile_id, sample.source_provider, dateKey]);
      let summary = cache.get(key);
      const counted = previous?.summary_date_key != null && previous.steps !== null;
      // Counted corrections to a loaded summary use neither day bounds nor timezone.
      // Cache misses still resolve them before the original database await.
      const day = summary && counted ? undefined : activityDay(sample.started_at);
      if (!summary) {
        summary = await transaction.getFirstAsync<ActivitySummaryRow>(
          `SELECT * FROM body_signal_activity_daily_summaries
           WHERE device_profile_id = ? AND source_provider = ? AND date_key = ?`,
          sample.device_profile_id, sample.source_provider, dateKey) ?? {
          id: `activity-day:${key}`, device_profile_id: sample.device_profile_id, source_provider: sample.source_provider,
          date_key: dateKey, steps: 0, active_minutes: 0, sample_count: 0, updated_at: sample.updated_at,
          summary_version: 1, day_started_at: day!.startedAt, day_ended_at: day!.endedAt, timezone_id: day!.timezone,
          first_sample_at: null, last_sample_at: null, sealed_through_at: null, coverage_uncertain: 0,
        };
        cache.set(key, summary);
      }
      // Legacy totals have no per-minute provenance. Preserve them without adding possibly duplicate data.
      if (summary.summary_version !== 1) return true;
      if (!previous && summary.sealed_through_at !== null && sample.ended_at <= summary.sealed_through_at) return false;
      summary.steps += sample.steps - (counted ? previous.steps ?? 0 : 0);
      summary.active_minutes += Number(sample.steps > 0) - (counted ? Number((previous.steps ?? 0) > 0) : 0);
      if (!counted) {
        summary.sample_count++;
        summary.first_sample_at = Math.min(summary.first_sample_at ?? sample.started_at, sample.started_at);
        summary.last_sample_at = Math.max(summary.last_sample_at ?? sample.ended_at, sample.ended_at);
        if (summary.timezone_id !== day!.timezone || summary.day_started_at !== day!.startedAt
          || summary.day_ended_at !== day!.endedAt) summary.coverage_uncertain = 1;
      }
      summary.updated_at = Math.max(summary.updated_at, sample.updated_at);
      dirty.add(key);
      return true;
    },
    async flush() {
      for (const key of dirty) {
        const s = cache.get(key)!;
        await transaction.runAsync(`INSERT INTO body_signal_activity_daily_summaries (
          id, device_profile_id, source_provider, date_key, steps, active_minutes, sedentary_minutes, sample_count,
          updated_at, summary_version, day_started_at, day_ended_at, timezone_id, first_sample_at, last_sample_at,
          sealed_through_at, coverage_uncertain
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_profile_id, source_provider, date_key) DO UPDATE SET
          steps=excluded.steps, active_minutes=excluded.active_minutes, sample_count=excluded.sample_count,
          updated_at=excluded.updated_at, first_sample_at=excluded.first_sample_at, last_sample_at=excluded.last_sample_at,
          coverage_uncertain=excluded.coverage_uncertain`,
        s.id, s.device_profile_id, s.source_provider, s.date_key, s.steps, s.active_minutes, s.sample_count,
        s.updated_at, s.summary_version, s.day_started_at, s.day_ended_at, s.timezone_id, s.first_sample_at,
        s.last_sample_at, s.sealed_through_at, s.coverage_uncertain);
      }
    },
  };
}

export async function initializeActivitySummaryBatch(transaction: Transaction, limit: number, now = Date.now()) {
  const rows = await transaction.getAllAsync<ActivityMinuteRow>(`SELECT * FROM body_signal_activity_samples
    WHERE summary_date_key IS NULL AND ended_at <= ? ORDER BY ended_at, id LIMIT ?`, now, limit);
  const writer = activitySummaryWriter(transaction, now);
  for (const row of rows) {
    const accepted = await writer.apply(row);
    // Mark unsupported/legacy rows handled, without interpreting their fields as Mi Band minutes.
    const dateKey = row.summary_date_key ?? activityDateKey(row.started_at);
    if (!accepted) throw new Error('activity_summary_replay_conflict');
    await transaction.runAsync('UPDATE body_signal_activity_samples SET summary_date_key = ? WHERE id = ?', dateKey, row.id);
  }
  await writer.flush();
  return rows.length;
}
