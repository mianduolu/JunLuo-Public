import { activityWeek } from './bodySignalActivitySummary';
import { analyzeMiBand6Sleep, MI_BAND_6_SLEEP_ALGORITHM_VERSION } from './miBand6SleepDuration';
import type { MiBand6SleepRead } from './miBand6SleepInspection';
import type { MiBand6SleepBatch, MiBand6SleepDay, MiBand6SavedSleep } from './miBand6SleepTypes';

const MINUTE = 60_000;
export function buildMiBand6SleepBatch(read: MiBand6SleepRead, now: number): MiBand6SleepBatch {
  if (read.timezoneOffsetMinutes !== 480 || new Date(now).getTimezoneOffset() !== -480) {
    throw new Error('sleep_timezone_unsupported');
  }
  const rows = new Map(read.minutes.map(row => [row.startedAt, row]));
  if (rows.size !== read.minutes.length) throw new Error('sleep_duplicate_minute');
  const days: MiBand6SleepDay[] = activityWeek(now).map(dateKey => {
    const midnight = Date.parse(`${dateKey}T00:00:00+08:00`);
    const start = midnight - 6 * 60 * MINUTE;
    const end = midnight + 25 * 60 * MINUTE;
    // Use the full independently verified 31-hour input contract. No guessed
    // "enough minutes after waking" threshold; incomplete current days wait.
    if (end > read.endedAt && end > now) return { dateKey, status: 'pending' };
    if (read.startedAt > start || read.endedAt < end) return { dateKey, status: 'coverage_missing' };
    for (let at = start; at < end; at += MINUTE) {
      const row = rows.get(at);
      if (!row || row.raw[0] === 126 || row.raw[0] === 254 || !row.raw.some(Boolean)) {
        return { dateKey, status: 'coverage_missing' };
      }
    }
    try {
      const analysis = analyzeMiBand6Sleep(read.minutes, dateKey);
      if (!analysis) return { dateKey, status: 'not_detected' };
      const { duration, stages } = analysis;
      // Wake-date ownership is checked independently of native day selection.
      const wakeDate = new Date(duration.endedAt + 8 * 3600_000).toISOString().slice(0, 10);
      if (wakeDate !== dateKey || duration.endedAt > read.endedAt || duration.startedAt < start) {
        return { dateKey, status: 'unsupported' };
      }
      return { dateKey, status: 'recorded', duration, ...(stages ? { stages } : {}) };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('sleep_')) return { dateKey, status: 'unsupported' };
      throw error;
    }
  });
  return { deviceProfileId: read.deviceProfileId, sourceProvider: 'mi_band_6',
    algorithmVersion: MI_BAND_6_SLEEP_ALGORITHM_VERSION,
    requestedAt: read.capture.requestedAt, observedAt: read.observedAt,
    coverageStartedAt: read.startedAt, coverageEndedAt: read.endedAt, days };
}

export function presentMiBand6SleepDay(dateKey: string, record?: MiBand6SavedSleep, latest?: MiBand6SleepDay) {
  if (record) {
    const hours = Math.floor(record.totalMinutes / 60), minutes = record.totalMinutes % 60;
    return { dateKey, text: `${hours ? `${hours}小时` : ''}${minutes || !hours ? `${minutes}分` : ''}`,
      note: latest && latest.status !== 'recorded' ? '保留此前记录，本次尚未复核' : undefined };
  }
  const text = latest?.status === 'pending' ? '等待记录完整'
    : latest?.status === 'coverage_missing' ? '记录覆盖不足'
      : latest?.status === 'unsupported' ? '当前记录暂不能解析'
        : latest?.status === 'not_detected' ? '尚未识别到主要睡眠' : '暂无已保存记录';
  return { dateKey, text, note: undefined };
}
