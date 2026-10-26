import { useEffect, useMemo, useState } from 'react';

import { colmiBodySignalProvider } from './colmi/colmiBodySignalProvider';
import {
  loadBodySignalReadingsSince,
  loadLatestBodySignalReading,
  loadRecentBodySignalReadings,
  subscribeBodySignalReadingSaved,
} from './bodySignalStore';
import { startOfLocalDay } from './bodySignalHistory';
import { loadSelectedBodySignalBattery } from './bodySignalReader';
import { BODY_SIGNAL_STALE_MS, buildBodySignalSnapshot } from './bodySignalSnapshot';
import type { BodySignalLiveSnapshot, BodySignalSnapshot, StoredBodySignalReading } from './bodySignalTypes';

const BODY_SIGNAL_CLOCK_TICK_MS = 30 * 1000;

function storedReadingKey(reading: StoredBodySignalReading) {
  return [
    reading.kind,
    reading.sourceProvider,
    reading.sourceDeviceName ?? '',
    reading.measuredAt,
    reading.value,
  ].join('|');
}

function addStoredReading(readings: StoredBodySignalReading[], reading: StoredBodySignalReading, limit: number) {
  const next = [reading, ...readings];
  const seen = new Set<string>();
  return next
    .sort((left, right) => right.measuredAt - left.measuredAt)
    .filter((item) => {
      const key = storedReadingKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

export function useBodySignalSnapshot(): BodySignalSnapshot {
  const [liveSnapshot, setLiveSnapshot] = useState<BodySignalLiveSnapshot>(() => colmiBodySignalProvider.getSnapshot());
  const [persistedBattery, setPersistedBattery] = useState<StoredBodySignalReading | undefined>();
  const [persistedHeartRate, setPersistedHeartRate] = useState<StoredBodySignalReading | undefined>();
  const [recentStoredHeartRates, setRecentStoredHeartRates] = useState<StoredBodySignalReading[]>([]);
  const [todayStoredHeartRates, setTodayStoredHeartRates] = useState<StoredBodySignalReading[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => colmiBodySignalProvider.subscribe(setLiveSnapshot), []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      loadLatestBodySignalReading('heart_rate'),
      loadRecentBodySignalReadings('heart_rate', 20),
      loadBodySignalReadingsSince('heart_rate', startOfLocalDay()),
    ])
      .then(([latestHeartRate, recent, today]) => {
        if (cancelled) return;
        setPersistedHeartRate(latestHeartRate);
        setRecentStoredHeartRates(recent);
        setTodayStoredHeartRates(today);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void loadSelectedBodySignalBattery(liveSnapshot.connection).then(reading => {
        if (!cancelled) setPersistedBattery(reading);
      }).catch(() => undefined);
    };
    setPersistedBattery(undefined);
    refresh();
    const unsubscribe = subscribeBodySignalReadingSaved(reading => { if (reading.kind === 'battery') refresh(); });
    return () => { cancelled = true; unsubscribe(); };
  }, [liveSnapshot.connection.deviceProfileId, liveSnapshot.connection.isConnected]);

  useEffect(() => {
    const reading = liveSnapshot.heartRate;
    if (!reading) return;
    setPersistedHeartRate(reading);
    setRecentStoredHeartRates((current) => addStoredReading(current, reading, 20));
    if (reading.measuredAt >= startOfLocalDay()) {
      setTodayStoredHeartRates((current) => addStoredReading(current, reading, Number.MAX_SAFE_INTEGER));
    }
  }, [liveSnapshot.heartRate]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), BODY_SIGNAL_CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return useMemo(
    () => buildBodySignalSnapshot({
      live: liveSnapshot,
      now,
      persistedBattery,
      persistedHeartRate,
      recentStoredHeartRates,
      staleAfterMs: BODY_SIGNAL_STALE_MS,
      todayStoredHeartRates,
    }),
    [liveSnapshot, now, persistedBattery, persistedHeartRate, recentStoredHeartRates, todayStoredHeartRates],
  );
}
