import { decodeSleepRecord, prepareSleepRecords, requireSleepVersion2, unsupported } from './miBand6SleepDurationInput';
import { candidateRanges } from './miBand6SleepDurationCandidates';
import { prepareSleepIntervals } from './miBand6SleepDurationIntervals';
import { mainDurationSegments, summarizeDuration } from './miBand6SleepDurationAdjustment';
import { miBand6SleepStagesFromSegments } from './miBand6SleepStages';
import type { MiBand6SleepAnalysis, MiBand6SleepDuration } from './miBand6SleepTypes';

export const MI_BAND_6_SLEEP_ALGORITHM_VERSION = 'mi-band-6-sleep-v2';
export type MiBand6SleepRawMinute = { startedAt: number; raw: readonly number[] };

const MINUTE = 60000;
const DAY = 1440 * MINUTE;
const MAX_INPUT_MINUTES = 14 * 1440;
const MISSING = [126, 0, 0, 254, 0, 0, 0, 0];
const invalid = (): never => { throw new Error('sleep_duration_invalid_input'); };

/**
 * Independent duration rules for the verified UTC+8 / version-2 / day=1 /
 * whole-day=1 branch. A raw row is kind, activity, steps, HR, four extra bytes.
 * Reads the previous/current/next date and returns one main sleep, end exclusive.
 * Missing rows are category 126, not zero sleep. Unverified branches and native
 * buffer-boundary cases throw sleep_duration_unsupported; no main sleep yields
 * undefined. No current time, storage, or device access.
 */
export function calculateMiBand6SleepDuration(
  minutes: readonly MiBand6SleepRawMinute[], localDate: string,
): { startedAt: number; endedAt: number; totalMinutes: number } | undefined {
  return analyzeMiBand6Sleep(minutes, localDate)?.duration;
}

/** Duration and optional verified deep/light output from the same calculation. */
export function analyzeMiBand6Sleep(
  minutes: readonly MiBand6SleepRawMinute[], localDate: string,
): MiBand6SleepAnalysis | undefined {
  if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) invalid();
  const midnight = Date.parse(`${localDate}T00:00:00+08:00`);
  if (!Number.isFinite(midnight) || new Date(midnight + 8 * 60 * MINUTE).toISOString().slice(0, 10) !== localDate) invalid();
  if (!Array.isArray(minutes) || minutes.length > MAX_INPUT_MINUTES) invalid();
  if (minutes.length === 0) unsupported();
  const lookup = new Map<number, readonly number[]>();
  for (const minute of minutes) {
    if (!minute || !Number.isSafeInteger(minute.startedAt) || minute.startedAt % MINUTE !== 0 ||
        Math.abs(minute.startedAt) > 8640000000000000 || !Array.isArray(minute.raw) || minute.raw.length !== 8 ||
        Array.from(minute.raw).some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255) || lookup.has(minute.startedAt)) invalid();
    lookup.set(minute.startedAt, minute.raw);
  }
  const first = midnight - DAY;
  const records = Array.from({ length: 4320 }, (_, i) => decodeSleepRecord(lookup.get(first + i * MINUTE) ?? MISSING));
  requireSleepVersion2(records);
  const core = records.slice(1080, 2940).map((row, i) => {
    const copy = row.slice();
    if (i >= 1800) copy[3] = 0;
    return copy;
  });
  const { records: prepared, lower, upper } = prepareSleepRecords(core);
  const initial = candidateRanges(prepared, lower, upper);
  const { intervals, main } = prepareSleepIntervals(prepared, initial);
  if (main < 0) return undefined;
  const [start, end] = intervals[main];
  const segments = mainDurationSegments(prepared, intervals, main);
  const totalMinutes = summarizeDuration(start + 1080, end + 1080, segments);
  if (totalMinutes === undefined) return undefined;
  const duration: MiBand6SleepDuration = {
    startedAt: midnight + (start - 360) * MINUTE, endedAt: midnight + (end + 1 - 360) * MINUTE, totalMinutes,
  };
  const stages = miBand6SleepStagesFromSegments(duration, segments, first);
  return { duration, ...(stages ? { stages } : {}) };
}
