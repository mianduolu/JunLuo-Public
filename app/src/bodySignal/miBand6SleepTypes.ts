export const MI_BAND_6_SLEEP_STREAM = 'sleep_history';
export type MiBand6SleepDayStatus = 'recorded' | 'pending' | 'coverage_missing' | 'not_detected' | 'unsupported';
export type MiBand6SleepDuration = { startedAt: number; endedAt: number; totalMinutes: number };
export type MiBand6SleepSegment = { stage: 'deep' | 'light'; startedAt: number; endedAt: number };
export type MiBand6SleepStages = { deepMinutes: number; lightMinutes: number; segments: MiBand6SleepSegment[] };
export type MiBand6SleepAnalysis = { duration: MiBand6SleepDuration; stages?: MiBand6SleepStages };
export type MiBand6SleepDay = {
  dateKey: string;
  status: MiBand6SleepDayStatus;
  duration?: MiBand6SleepDuration;
  stages?: MiBand6SleepStages;
};
export type MiBand6SleepBatch = {
  deviceProfileId: string;
  sourceProvider: 'mi_band_6';
  algorithmVersion: string;
  requestedAt: number;
  observedAt: number;
  coverageStartedAt: number;
  coverageEndedAt: number;
  days: MiBand6SleepDay[];
};
export type MiBand6SavedSleep = MiBand6SleepDuration & {
  dateKey: string;
  deviceProfileId: string;
  sourceProvider: 'mi_band_6';
  algorithmVersion: string;
  updatedAt: number;
  stages?: MiBand6SleepStages;
};
