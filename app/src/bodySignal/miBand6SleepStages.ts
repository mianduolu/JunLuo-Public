import type { MiBand6SleepDuration, MiBand6SleepSegment, MiBand6SleepStages } from './miBand6SleepTypes';

const MINUTE = 60_000;

/** Final version-2 output codes, after the existing interval adjustment. */
export function miBand6SleepStagesFromSegments(duration: MiBand6SleepDuration,
  raw: readonly (readonly [number, number, number])[], origin: number): MiBand6SleepStages | undefined {
  const result: MiBand6SleepStages = { deepMinutes: 0, lightMinutes: 0, segments: [] };
  let previousEnd = duration.startedAt;
  for (const [left, right, code] of raw) {
    const startedAt = origin + left * MINUTE, endedAt = origin + (right + 1) * MINUTE;
    if (![3, 4, 5, 7].includes(code) || startedAt !== previousEnd || endedAt <= startedAt
      || endedAt > duration.endedAt) return undefined;
    previousEnd = endedAt;
    if (code === 3 || code === 7) continue; // Non-wear and awake are not sleep percentages.
    const stage = code === 5 ? 'deep' : 'light';
    const minutes = (endedAt - startedAt) / MINUTE;
    if (stage === 'deep') result.deepMinutes += minutes; else result.lightMinutes += minutes;
    result.segments.push({ stage, startedAt, endedAt });
  }
  if (previousEnd !== duration.endedAt) return undefined;
  return validateMiBand6SleepStages(duration, result);
}

/** Invalid staging never invalidates an independently valid duration. */
export function validateMiBand6SleepStages(duration: MiBand6SleepDuration, value: unknown): MiBand6SleepStages | undefined {
  if (!Number.isSafeInteger(duration.totalMinutes) || duration.totalMinutes <= 0 || duration.totalMinutes > 1860) return undefined;
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as MiBand6SleepStages;
  if (!Array.isArray(candidate.segments) || !candidate.segments.length || candidate.segments.length > 200) return undefined;
  let previousEnd = duration.startedAt, deepMinutes = 0, lightMinutes = 0;
  const segments: MiBand6SleepSegment[] = [];
  for (const segment of candidate.segments) {
    if (!segment || !['deep', 'light'].includes(segment.stage)
      || !Number.isSafeInteger(segment.startedAt) || !Number.isSafeInteger(segment.endedAt)
      || segment.startedAt % MINUTE !== 0 || segment.endedAt % MINUTE !== 0
      || segment.startedAt < previousEnd || segment.endedAt <= segment.startedAt || segment.endedAt > duration.endedAt) return undefined;
    const minutes = (segment.endedAt - segment.startedAt) / MINUTE;
    if (segment.stage === 'deep') deepMinutes += minutes; else lightMinutes += minutes;
    segments.push({ stage: segment.stage, startedAt: segment.startedAt, endedAt: segment.endedAt });
    previousEnd = segment.endedAt;
  }
  if (deepMinutes + lightMinutes !== duration.totalMinutes
    || candidate.deepMinutes !== deepMinutes || candidate.lightMinutes !== lightMinutes) return undefined;
  return { deepMinutes, lightMinutes, segments };
}

/** Largest remainder allocation; a tie awards the remaining point to deep. */
export function miBand6SleepPercentages(deepMinutes: number, lightMinutes: number): { deep: number; light: number } {
  const total = deepMinutes + lightMinutes;
  if (!Number.isSafeInteger(deepMinutes) || !Number.isSafeInteger(lightMinutes)
    || deepMinutes < 0 || lightMinutes < 0 || total <= 0 || total > 1860) throw new RangeError('sleep_invalid_stage_minutes');
  const deepNumerator = deepMinutes * 100, lightNumerator = lightMinutes * 100;
  let deep = Math.floor(deepNumerator / total), light = Math.floor(lightNumerator / total);
  if (deep + light < 100) {
    if (deepNumerator % total >= lightNumerator % total) deep++; else light++;
  }
  return { deep, light };
}
