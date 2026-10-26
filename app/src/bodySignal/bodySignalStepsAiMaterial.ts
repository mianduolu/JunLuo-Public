import { ACTIVITY_MINUTE, activityDay, activityWeek, type ActivitySummaryRow } from './bodySignalActivitySummary';

export type BodySignalStepsAiMaterial = {
  id: string;
  version: string;
  text: string;
  occurredAt: number;
  expiresAt: number;
};

type StepsDay = { date: string; steps?: number; last?: number; coverage?: string; occurredAt: number };
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const minute = (value: unknown): value is number => whole(value) && value % ACTIVITY_MINUTE === 0;
const clock = (time: number) => {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

export function presentBodySignalStepsDay(date: string, row: ActivitySummaryRow | undefined, today: boolean, now: number): StepsDay {
  const day = activityDay(new Date(`${date}T12:00:00`).getTime());
  const result: StepsDay = { date, occurredAt: day.startedAt };
  if (!row || !whole(row.steps) || row.steps < 0) return result;
  result.steps = row.steps;
  result.coverage = '完整性未确认';
  const compatible = row.day_started_at === day.startedAt && row.day_ended_at === day.endedAt
    && row.timezone_id === day.timezone;
  const limit = Math.min(day.endedAt, Math.floor(now / ACTIVITY_MINUTE) * ACTIVITY_MINUTE);
  if (compatible && minute(row.last_sample_at) && row.last_sample_at > day.startedAt && row.last_sample_at <= limit) {
    result.last = row.last_sample_at;
    result.occurredAt = result.last;
  }
  if (row.summary_version !== 1 || row.coverage_uncertain !== 0 || !compatible
    || result.last === undefined || !minute(row.first_sample_at)
    || row.first_sample_at < day.startedAt || row.first_sample_at >= result.last
    || !whole(row.sample_count) || row.sample_count <= 0
    || row.sample_count > (result.last - row.first_sample_at) / ACTIVITY_MINUTE) return result;
  const expectedEnd = today ? result.last : day.endedAt;
  const complete = row.first_sample_at === day.startedAt && result.last === expectedEnd
    && row.sample_count === (expectedEnd - day.startedAt) / ACTIVITY_MINUTE;
  result.coverage = complete ? (today ? '截至最新记录完整' : '记录完整') : '部分记录';
  return result;
}

/** Dated step facts only. Coverage describes received minutes, never a physical activity state. */
export function buildBodySignalStepsAiMaterial(
  rows: readonly ActivitySummaryRow[], deviceProfileId: string, now: number,
): BodySignalStepsAiMaterial | undefined {
  const window = activityWeek(now).slice(-4).reverse();
  const days = window.map((date, index) => presentBodySignalStepsDay(date, rows.find(row => row.date_key === date
    && row.device_profile_id === deviceProfileId && row.source_provider === 'mi_band_6'), index === 0, now));
  const recorded = days.filter(day => day.steps !== undefined);
  if (!recorded.length) return undefined;
  const today = days[0];
  const day = activityDay(now);
  return {
    id: `body-signal:steps:${deviceProfileId}`,
    version: JSON.stringify([deviceProfileId, 'mi_band_6', day.timezone, window,
      days.map((item, index) => [item.date, item.steps ?? null, index === 0 ? item.last ?? null : null, item.coverage ?? null])]),
    occurredAt: Math.max(...recorded.map(item => item.occurredAt)),
    expiresAt: day.endedAt,
    text: [
      '【I看到的you的步数记录】',
      today.steps === undefined ? `今天（${today.date}）暂无记录。`
        : `今天（${today.date}）已记录${today.steps}步，${today.last === undefined ? '' : `最新记录到${clock(today.last)}，`}${today.coverage}。`,
      `前三天：${days.slice(1).map(item => item.steps === undefined ? `${item.date} 暂无记录`
        : `${item.date} ${item.steps}步（${item.coverage}）`).join('；')}。`,
    ].join('\n'),
  };
}

function calendarIdentity(now: number) {
  const day = activityDay(now);
  return JSON.stringify([day.dateKey, day.timezone, day.startedAt, day.endedAt, new Date(now).getTimezoneOffset()]);
}

/** Query summaries directly: the page overview also prunes history and is not a material reader. */
export async function loadBodySignalStepsAiMaterial(now = Date.now()): Promise<BodySignalStepsAiMaterial | undefined> {
  const calendar = calendarIdentity(Date.now());
  if (calendarIdentity(now) !== calendar) throw new Error('steps-material-calendar-changed');
  const { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } = await import('../backup/backupRestoreCoordinator');
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) throw new Error('steps-material-restore-unavailable');
  const { loadPersistedPrimaryBodySignalDeviceProfile } = await import('./device/bodySignalDeviceRepository');
  const profile = await loadPersistedPrimaryBodySignalDeviceProfile();
  if (!profile || profile.family !== 'mi_band_6') {
    if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('steps-material-restore-changed');
    return undefined;
  }
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  const dates = activityWeek(now).slice(-4);
  const rows = await database.getAllAsync<ActivitySummaryRow>(
    `SELECT * FROM body_signal_activity_daily_summaries WHERE device_profile_id = ?
     AND source_provider = 'mi_band_6' AND date_key >= ? AND date_key <= ? ORDER BY date_key`,
    profile.id, dates[0], dates[3]);
  const current = await loadPersistedPrimaryBodySignalDeviceProfile();
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('steps-material-restore-changed');
  if (current?.id !== profile.id || current.family !== 'mi_band_6') throw new Error('steps-material-profile-changed');
  if (calendarIdentity(Date.now()) !== calendar) throw new Error('steps-material-calendar-changed');
  return buildBodySignalStepsAiMaterial(rows, profile.id, now);
}
