import { activityDay, activityWeek, type ActivitySummaryRow } from './bodySignalActivitySummary';
import { presentBodySignalStepsDay } from './bodySignalStepsAiMaterial';
import { buildBodySignalSleepSummary } from './bodySignalSleepSummary';
import type { MiBand6SavedSleep, MiBand6SleepBatch } from './miBand6SleepTypes';

export type BodySignalHistoryToolMetric = 'steps' | 'sleep';
export type BodySignalHistoryToolRead = { text: string; failed: boolean };

const NO_PROFILE = '当前没有可查询这项记录的主设备。';
const READ_FAILED = '这次暂时没能读取记录。';
const missingDay = (date: string) => `${date} 暂无已保存记录。`;
const clock = (time: number) => {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};
const duration = (minutes: number) => {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `${hours ? `${hours}小时` : ''}${rest || !hours ? `${rest}分` : ''}`;
};

export function formatBodySignalStepsHistoryForTool(
  rows: readonly ActivitySummaryRow[], deviceProfileId: string, now: number,
): string {
  const days = activityWeek(now).reverse().map((date, index) => presentBodySignalStepsDay(
    date, rows.find(row => row.date_key === date && row.device_profile_id === deviceProfileId
      && row.source_provider === 'mi_band_6'), index === 0, now,
  ));
  if (days.every(day => day.steps === undefined)) return '近七天暂无已保存的步数记录。';
  return ['【I查到的you的步数记录】', ...days.map(day => day.steps === undefined
    ? missingDay(day.date)
    : `${day.date} 已记录${day.steps}步，${day.last === undefined ? '' : `最新记录到${clock(day.last)}，`}${day.coverage}。`,
  )].join('\n');
}

export function formatBodySignalSleepHistoryForTool(
  history: { records: MiBand6SavedSleep[]; lastBatch?: MiBand6SleepBatch },
  deviceProfileId: string, now: number,
): string {
  const days = buildBodySignalSleepSummary(history, deviceProfileId, now).days.slice().reverse();
  if (days.every(day => day.totalMinutes === undefined)) return '近七天暂无已保存的主要睡眠记录。';
  return ['【I查到的you的主要睡眠记录】', ...days.map(day => day.totalMinutes === undefined
    ? missingDay(day.dateKey)
    : `${day.dateKey} ${duration(day.totalMinutes)}${day.note ? '（尚未复核）' : ''}。`,
  )].join('\n');
}

function calendarIdentity(metric: BodySignalHistoryToolMetric, now: number): string {
  if (metric === 'sleep') return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
  const day = activityDay(now);
  return JSON.stringify([day.dateKey, day.timezone, day.startedAt, day.endedAt, new Date(now).getTimezoneOffset()]);
}

/** Local saved facts only; failures never become an empty history or leak native diagnostics. */
export async function loadBodySignalHistoryForTool(
  metric: BodySignalHistoryToolMetric, now = Date.now(),
): Promise<BodySignalHistoryToolRead> {
  try {
    const calendar = calendarIdentity(metric, now);
    const { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } = await import('../backup/backupRestoreCoordinator');
    const epoch = captureBackupRestoreDataEpoch();
    if (epoch === null || calendarIdentity(metric, Date.now()) !== calendar) throw new Error('history-unavailable');
    const { loadPersistedPrimaryBodySignalDeviceProfile } = await import('./device/bodySignalDeviceRepository');
    const profile = await loadPersistedPrimaryBodySignalDeviceProfile();
    let text = NO_PROFILE;
    if (profile?.family === 'mi_band_6') {
      if (metric === 'steps') {
        const { getBodySignalDatabase } = await import('./bodySignalStore');
        const database = await getBodySignalDatabase();
        const dates = activityWeek(now);
        const rows = await database.getAllAsync<ActivitySummaryRow>(
          `SELECT * FROM body_signal_activity_daily_summaries WHERE device_profile_id = ?
           AND source_provider = 'mi_band_6' AND date_key BETWEEN ? AND ? ORDER BY date_key`,
          profile.id, dates[0], dates[6],
        );
        text = formatBodySignalStepsHistoryForTool(rows, profile.id, now);
      } else {
        const { loadMiBand6SleepHistory } = await import('./miBand6SleepStore');
        text = formatBodySignalSleepHistoryForTool(await loadMiBand6SleepHistory(profile.id, now), profile.id, now);
      }
    }
    const current = await loadPersistedPrimaryBodySignalDeviceProfile();
    if (!canCommitBackupRestoreDataEpoch(epoch) || calendarIdentity(metric, Date.now()) !== calendar
      || current?.id !== profile?.id || current?.family !== profile?.family) throw new Error('history-changed');
    return { text, failed: false };
  } catch {
    return { text: READ_FAILED, failed: true };
  }
}
