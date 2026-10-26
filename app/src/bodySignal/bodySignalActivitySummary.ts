export const ACTIVITY_MINUTE = 60_000;

export function activityDateKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function activityDay(time: number) {
  const date = new Date(time);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return { dateKey: activityDateKey(time), startedAt: start.getTime(), endedAt: end.getTime(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || `UTC-offset:${date.getTimezoneOffset()}` };
}

export function activityWeek(now: number): string[] {
  const today = new Date(now);
  return Array.from({ length: 7 }, (_, index) => activityDateKey(
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6 + index).getTime()));
}

export type ActivitySummaryRow = {
  id: string; device_profile_id: string; source_provider: string; date_key: string;
  steps: number; active_minutes: number; sample_count: number; updated_at: number;
  summary_version: number; day_started_at: number | null; day_ended_at: number | null;
  timezone_id: string | null; first_sample_at: number | null; last_sample_at: number | null;
  sealed_through_at: number | null; coverage_uncertain: number;
};

export type ActivityDayView = {
  dateKey: string; steps?: number; steppingMinutes?: number; coveredMinutes?: number;
  expectedMinutes?: number; lastRecordedAt?: number;
  coverage: 'missing' | 'partial' | 'complete' | 'ongoing' | 'unknown';
};

export function presentActivityDay(dateKey: string, row: ActivitySummaryRow | undefined, now: number): ActivityDayView {
  if (!row) return { dateKey, coverage: 'missing' };
  if (row.summary_version !== 1) return { dateKey, steps: row.steps, coverage: 'unknown' };
  const expected = row.day_started_at !== null && row.day_ended_at !== null
    ? (row.day_ended_at - row.day_started_at) / ACTIVITY_MINUTE : undefined;
  const complete = !row.coverage_uncertain && expected !== undefined && row.sample_count === expected
    && row.first_sample_at === row.day_started_at && row.last_sample_at === row.day_ended_at;
  return { dateKey, steps: row.steps, steppingMinutes: row.active_minutes, coveredMinutes: row.sample_count,
    expectedMinutes: expected, lastRecordedAt: row.last_sample_at ?? undefined,
    coverage: row.coverage_uncertain ? 'unknown' : dateKey === activityDateKey(now) ? 'ongoing'
      : complete && row.day_ended_at! <= now ? 'complete' : 'partial' };
}

export type ActivityHourView = { startedAt: number; endedAt: number; steps?: number; coveredMinutes: number };
export function activityHours(samples: readonly { started_at: number; ended_at: number; steps: number | null }[], now: number): ActivityHourView[] {
  const end = Math.floor(now / ACTIVITY_MINUTE) * ACTIVITY_MINUTE;
  const start = end - 24 * 60 * ACTIVITY_MINUTE;
  const hours: ActivityHourView[] = Array.from({ length: 24 }, (_, index) => ({
    startedAt: start + index * 60 * ACTIVITY_MINUTE, endedAt: start + (index + 1) * 60 * ACTIVITY_MINUTE,
    coveredMinutes: 0,
  }));
  for (const sample of samples) {
    if (sample.started_at < start || sample.ended_at > end || sample.steps === null
      || sample.ended_at - sample.started_at !== ACTIVITY_MINUTE) continue;
    const hour = hours[Math.floor((sample.started_at - start) / (60 * ACTIVITY_MINUTE))];
    if (!hour) continue;
    hour.steps = (hour.steps ?? 0) + sample.steps;
    hour.coveredMinutes++;
  }
  return hours;
}

export const activityCoverageLabel: Record<ActivityDayView['coverage'], string> = {
  missing: '暂无记录', partial: '部分记录', complete: '全天记录完整', ongoing: '今天仍在记录', unknown: '覆盖情况未知',
};
