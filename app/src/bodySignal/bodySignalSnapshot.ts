import {
  mergeLiveAndStoredReadings,
  startOfLocalDay,
  summarizeHeartRateReadings,
} from './bodySignalHistory';
import type {
  BodySignalLiveSnapshot,
  BodySignalReading,
  BodySignalSnapshot,
  StoredBodySignalReading,
} from './bodySignalTypes';

export const BODY_SIGNAL_STALE_MS = 2 * 60 * 1000;
export const BODY_SIGNAL_RECEIVING_GRACE_MS = 15 * 1000;

export type BuildBodySignalSnapshotInput = {
  live: BodySignalLiveSnapshot;
  now: number;
  persistedBattery?: StoredBodySignalReading;
  persistedHeartRate?: StoredBodySignalReading;
  recentStoredHeartRates?: StoredBodySignalReading[];
  receivingGraceMs?: number;
  staleAfterMs?: number;
  todayStoredHeartRates?: StoredBodySignalReading[];
};

function withStale(reading: StoredBodySignalReading | undefined, now: number, staleAfterMs: number): BodySignalReading | undefined {
  if (!reading) return undefined;
  return {
    ...reading,
    stale: now - reading.measuredAt > staleAfterMs,
  };
}

function shouldHideMeasurementError(errorMessage: string | undefined, heartRate: BodySignalReading | undefined): boolean {
  if (!errorMessage || !heartRate || heartRate.stale) return false;
  return /disconnect|disconnected|断开/i.test(errorMessage);
}

export function buildBodySignalSnapshot({
  live,
  now,
  persistedBattery,
  persistedHeartRate,
  recentStoredHeartRates = [],
  receivingGraceMs = BODY_SIGNAL_RECEIVING_GRACE_MS,
  staleAfterMs = BODY_SIGNAL_STALE_MS,
  todayStoredHeartRates = [],
}: BuildBodySignalSnapshotInput): BodySignalSnapshot {
  const heartRate = withStale(live.heartRate, now, staleAfterMs)
    ?? withStale(persistedHeartRate, now, staleAfterMs);
  const battery = withStale([live.battery, persistedBattery].filter((reading): reading is StoredBodySignalReading =>
    Boolean(reading && (!live.connection.deviceProfileId || reading.deviceProfileId === live.connection.deviceProfileId
      || (live.connection.deviceFamily === 'smarthealth_r99' && !reading.deviceProfileId && reading.sourceProvider === 'smarthealth_r99'))))
    .sort((left, right) => right.measuredAt - left.measuredAt)[0], now, staleAfterMs);
  const heartRateMeasurementErrorMessage = shouldHideMeasurementError(live.heartRateMeasurementErrorMessage, heartRate)
    ? undefined
    : live.heartRateMeasurementErrorMessage;
  const isMeasuringHeartRate = live.heartRateMeasurementStatus === 'starting'
    || live.heartRateMeasurementStatus === 'waiting';
  const isReceivingHeartRate = Boolean(
    heartRate && now - heartRate.measuredAt <= receivingGraceMs,
  );
  const recentHeartRates = mergeLiveAndStoredReadings({
    live: heartRate,
    now,
    staleAfterMs,
    stored: recentStoredHeartRates,
  });
  const todayReadings = mergeLiveAndStoredReadings({
    live: heartRate && heartRate.measuredAt >= startOfLocalDay(now) ? heartRate : undefined,
    limit: Number.MAX_SAFE_INTEGER,
    now,
    staleAfterMs,
    stored: todayStoredHeartRates,
  });

  return {
    battery,
    batteryCharging: battery && !battery.stale && live.connection.isConnected
      && battery.deviceProfileId === live.battery?.deviceProfileId && battery.measuredAt === live.battery?.measuredAt
      ? live.batteryCharging : undefined,
    canMeasureHeartRate: live.canMeasureHeartRate,
    connection: live.connection,
    heartRate,
    heartRateContinuousSession: live.heartRateContinuousSession
      ? { ...live.heartRateContinuousSession }
      : undefined,
    heartRateControlMode: live.heartRateControlMode,
    heartRateMeasurementErrorMessage,
    heartRateMeasurementStatus: live.heartRateMeasurementStatus,
    heartRateTodaySummary: summarizeHeartRateReadings(todayReadings),
    isConnectionBusy: live.isConnectionBusy,
    isMeasuringHeartRate,
    isReceivingHeartRate,
    recentHeartRates,
  };
}
