import { startOfLocalDay } from './bodySignalHistory';
import { BODY_SIGNAL_STALE_MS, buildBodySignalSnapshot } from './bodySignalSnapshot';
import {
  loadBodySignalReadingsSince,
  loadLatestBodySignalReading,
  loadRecentBodySignalReadings,
} from './bodySignalStore';
import type { BodySignalLiveSnapshot, StoredBodySignalReading } from './bodySignalTypes';
import { colmiBodySignalProvider } from './colmi/colmiBodySignalProvider';
import { loadPersistedBodySignalDeviceProfiles } from './device/bodySignalDeviceRepository';

export async function loadSelectedBodySignalBattery(connection: BodySignalLiveSnapshot['connection']) {
  const profiles = await loadPersistedBodySignalDeviceProfiles();
  const profile = connection.deviceProfileId ? profiles.find(item => item.id === connection.deviceProfileId)
    : !connection.isConnected ? profiles.find(item => item.isPrimary) : undefined;
  if (profile) {
    const reading = await loadLatestBodySignalReading('battery', profile.id);
    if (reading || profile.family !== 'smarthealth_r99') return reading;
    // R99's frozen legacy records predate profile attribution; never borrow Mi Band records.
    const legacy = await loadLatestBodySignalReading('battery', undefined, 'smarthealth_r99');
    return legacy && !legacy.deviceProfileId ? legacy : undefined;
  }
  if (connection.isConnected) return undefined;
  const legacy = await loadLatestBodySignalReading('battery');
  return legacy?.sourceProvider === 'mi_band_6' ? undefined : legacy;
}

function emptyLiveSnapshot(): BodySignalLiveSnapshot {
  return {
    canMeasureHeartRate: false,
    connection: {
      isConnected: false,
      statusMessage: '未连接',
    },
    heartRateControlMode: 'none',
    heartRateMeasurementStatus: 'idle',
    isConnectionBusy: false,
  };
}

async function readOrFallback<T>(operation: Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation;
  } catch {
    return fallback;
  }
}

export async function loadBodySignalSnapshot(now = Date.now()) {
  let live: BodySignalLiveSnapshot;
  try {
    live = colmiBodySignalProvider.getSnapshot();
  } catch {
    live = emptyLiveSnapshot();
  }

  const [persistedBattery, persistedHeartRate, recentStoredHeartRates, todayStoredHeartRates] = await Promise.all([
    readOrFallback<StoredBodySignalReading | undefined>(
      loadSelectedBodySignalBattery(live.connection),
      undefined,
    ),
    readOrFallback<StoredBodySignalReading | undefined>(
      loadLatestBodySignalReading('heart_rate'),
      undefined,
    ),
    readOrFallback(loadRecentBodySignalReadings('heart_rate', 20), []),
    readOrFallback(loadBodySignalReadingsSince('heart_rate', startOfLocalDay(now)), []),
  ]);

  return buildBodySignalSnapshot({
    live,
    now,
    persistedBattery,
    persistedHeartRate,
    recentStoredHeartRates,
    staleAfterMs: BODY_SIGNAL_STALE_MS,
    todayStoredHeartRates,
  });
}
