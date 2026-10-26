import { presentMiBand6SleepDay } from './miBand6SleepPolicy';
import type { MiBand6SavedSleep, MiBand6SleepBatch } from './miBand6SleepTypes';

export type SleepTrendDay = {
  dateKey: string;
  totalMinutes?: number;
  deepMinutes?: number;
  lightMinutes?: number;
  text: string;
  note?: string;
};
export type BodySignalSleepSummary = {
  deviceProfileId: string;
  days: SleepTrendDay[];
  recordedNights: number;
  averageMinutes?: number;
  unreviewedNights: number;
  axisHours: number;
  defaultDateKey: string;
};

/** Uses the saved sleep contract's UTC+8 wake dates, independent of phone timezone. */
export function buildBodySignalSleepSummary(
  history: { records: MiBand6SavedSleep[]; lastBatch?: MiBand6SleepBatch },
  deviceProfileId: string,
  now: number,
): BodySignalSleepSummary {
  const day = 86_400_000, offset = 8 * 3_600_000;
  const today = Math.floor((now + offset) / day) * day;
  const records = new Map(history.records
    .filter(record => record.deviceProfileId === deviceProfileId && record.sourceProvider === 'mi_band_6')
    .map(record => [record.dateKey, record]));
  const batch = history.lastBatch;
  const statuses = new Map(batch?.deviceProfileId === deviceProfileId && batch.sourceProvider === 'mi_band_6'
    ? batch.days.map(item => [item.dateKey, item]) : []);
  const days: SleepTrendDay[] = Array.from({ length: 7 }, (_, index) => {
    const dateKey = new Date(today - (6 - index) * day).toISOString().slice(0, 10);
    const record = records.get(dateKey);
    const display = presentMiBand6SleepDay(dateKey, record, statuses.get(dateKey));
    return { ...display, ...(record ? { totalMinutes: record.totalMinutes } : {}),
      ...(record?.stages ? { deepMinutes: record.stages.deepMinutes, lightMinutes: record.stages.lightMinutes } : {}) };
  });
  const recorded = days.filter(item => item.totalMinutes !== undefined);
  return {
    deviceProfileId, days, recordedNights: recorded.length,
    ...(recorded.length ? { averageMinutes: Math.round(recorded.reduce((sum, item) => sum + item.totalMinutes!, 0) / recorded.length) } : {}),
    unreviewedNights: recorded.filter(item => item.note !== undefined).length,
    axisHours: Math.max(1, Math.ceil(Math.max(0, ...recorded.map(item => item.totalMinutes!)) / 60)),
    defaultDateKey: recorded[recorded.length - 1]?.dateKey ?? days[6].dateKey,
  };
}
