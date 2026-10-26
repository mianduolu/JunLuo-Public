import { pruneBodySignalActivityHistory } from './bodySignalActivityStore';
import { getBodySignalDatabase } from './bodySignalStore';
import { activityHours, activityWeek, presentActivityDay, type ActivityDayView, type ActivityHourView,
  type ActivitySummaryRow } from './bodySignalActivitySummary';

export type ActivityDeviceOption = { id: string; displayName: string; isPrimary: boolean };
export type BodySignalActivityOverview = {
  deviceProfileId?: string; devices: ActivityDeviceOption[]; days: ActivityDayView[];
  today: ActivityDayView; hours: ActivityHourView[]; readAt: number;
};

const pending = new Map<string, Promise<BodySignalActivityOverview>>();
export type BodySignalActivityReadOptions = { readOnly?: boolean };
export function loadBodySignalActivityOverview(deviceProfileId?: string,
  options: BodySignalActivityReadOptions = {}): Promise<BodySignalActivityOverview> {
  const key = JSON.stringify([deviceProfileId ?? '', Boolean(options.readOnly)]);
  const current = pending.get(key);
  if (current) return current;
  const task = readOverview(deviceProfileId, options.readOnly).finally(() => { if (pending.get(key) === task) pending.delete(key); });
  pending.set(key, task);
  return task;
}

async function readOverview(requested?: string, readOnly = false): Promise<BodySignalActivityOverview> {
  const restore = readOnly ? await import('../backup/backupRestoreCoordinator') : undefined;
  const epoch = restore?.captureBackupRestoreDataEpoch();
  if (restore && !restore.canCommitBackupRestoreDataEpoch(epoch ?? null)) throw new Error('activity-read-restore-unavailable');
  // This performs bounded local housekeeping, never a device refresh.
  if (!readOnly) await pruneBodySignalActivityHistory();
  const database = await getBodySignalDatabase();
  const now = Date.now();
  const week = activityWeek(now);
  const rows = await database.getAllAsync<{ id: string; display_name: string; is_primary: number }>(
    `SELECT id, display_name, is_primary FROM body_signal_devices d
     WHERE (is_primary = 1 AND retired_at IS NULL) OR EXISTS (
       SELECT 1 FROM body_signal_activity_daily_summaries s WHERE s.device_profile_id = d.id
       AND s.source_provider = 'mi_band_6' AND s.date_key >= ? AND s.date_key <= ?)
     ORDER BY is_primary DESC, last_connected_at DESC, id`, week[0], week[6]);
  const devices = rows.map(row => ({ id: row.id, displayName: row.display_name, isPrimary: row.is_primary === 1 }));
  const selected = requested ? devices.find(item => item.id === requested) : devices[0];
  const summaries = selected ? await database.getAllAsync<ActivitySummaryRow>(
    `SELECT * FROM body_signal_activity_daily_summaries WHERE device_profile_id = ?
     AND source_provider = 'mi_band_6' AND date_key >= ? AND date_key <= ? ORDER BY date_key`,
    selected.id, week[0], week[6]) : [];
  const samples = selected ? await database.getAllAsync<{ started_at: number; ended_at: number; steps: number | null }>(
    `SELECT started_at, ended_at, steps FROM body_signal_activity_samples WHERE device_profile_id = ?
     AND source_provider = 'mi_band_6' AND started_at >= ? AND ended_at <= ?
     AND provider_sample_key = 'minute:' || started_at ORDER BY started_at`,
    selected.id, Math.floor(now / 60000) * 60000 - 86400000, now) : [];
  const byDate = new Map(summaries.map(summary => [summary.date_key, summary]));
  const days = week.map(date => presentActivityDay(date, byDate.get(date), now));
  if (restore && !restore.canCommitBackupRestoreDataEpoch(epoch ?? null)) throw new Error('activity-read-restore-changed');
  return { devices, deviceProfileId: selected?.id, days, today: days[6], hours: activityHours(samples, now), readAt: now };
}
