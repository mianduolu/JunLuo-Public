import RawAsyncStorage from '@react-native-async-storage/async-storage';

import type {
  AppearanceWeatherStorageChange,
} from './syncAppearanceWeatherStorageDerivation';
import { hasCurrentSyncDeviceSelection } from './syncCurrentDeviceSelection';
const WEATHER_ANIMATION_KEY =
  'junluo.weatherAnimationEnabled' as const;
const WEATHER_OBSERVATION_KEY =
  'junluo.weather.lastSuccessful' as const;

async function performCapturedChanges<T>(
  changes: readonly AppearanceWeatherStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const applicable = changes.filter((change) => (
    change.key === WEATHER_ANIMATION_KEY
    || change.key === WEATHER_OBSERVATION_KEY
  ));
  if (!applicable.length) return performBusinessWrite();
  if (!(await hasCurrentSyncDeviceSelection())) return performBusinessWrite();
  const [
    {
      appearanceWeatherStorageOverrides,
      deriveAppearanceWeatherMutations,
      projectAppearanceWeather,
    },
    { APPEARANCE_WEATHER_BATCH_CAPTURE_POLICY },
    { runAppearanceWeatherCaptureExclusive },
    { loadCurrentSyncDevice },
    { captureSyncMutationBatch },
    { createSyncMutationEnvelope },
    {
      enqueueSyncMutationAndAdvanceHeads,
      syncMutationStatePort,
    },
    {
      advanceSyncDurableIntent,
      prepareSyncDurableIntent,
    },
    { expoSyncRandomUuidV1 },
  ] = await Promise.all([
    import('./syncAppearanceWeatherStorageDerivation'),
    import('./syncAppearanceWeatherApply'),
    import('./syncAppearanceWeatherBootstrap'),
    import('./syncCurrentDevice'),
    import('./syncMutationBatchCapture'),
    import('./syncMutationEnvelope'),
    import('./syncMutationStateStore'),
    import('./syncStore'),
    import('./syncCryptoExpo'),
  ]);
  return runAppearanceWeatherCaptureExclusive(async () => {
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) return performBusinessWrite();
    const now = Date.now();
    const [previousAnimationRaw, previousObservationRaw] =
      await Promise.all([
        RawAsyncStorage.getItem(WEATHER_ANIMATION_KEY),
        RawAsyncStorage.getItem(WEATHER_OBSERVATION_KEY),
      ]);
    const overrides = appearanceWeatherStorageOverrides(applicable);
    const nextAnimationRaw = overrides.animationRaw === undefined
      ? previousAnimationRaw
      : overrides.animationRaw;
    const nextObservationRaw = overrides.observationRaw === undefined
      ? previousObservationRaw
      : overrides.observationRaw;
    const previous = projectAppearanceWeather({
      animationRaw: previousAnimationRaw,
      observationRaw: previousObservationRaw,
      now,
    });
    const next = projectAppearanceWeather({
      animationRaw: nextAnimationRaw,
      observationRaw: nextObservationRaw,
      now,
    });
    const mutations = await deriveAppearanceWeatherMutations({
      previous,
      next,
      capturedAt: now,
      envelopeFactory: (entity) => createSyncMutationEnvelope({
        identity: currentDevice.identity,
        entity,
        state: syncMutationStatePort,
        randomUuid: expoSyncRandomUuidV1,
        now: () => now,
      }),
    });
    if (!mutations.length) return performBusinessWrite();
    let value!: T;
    await captureSyncMutationBatch({
      operationId: expoSyncRandomUuidV1(),
      policy: APPEARANCE_WEATHER_BATCH_CAPTURE_POLICY,
      durableCapture: {
        prepareSyncDurableIntent,
        advanceSyncDurableIntent,
        enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
      },
      mutations,
      performBusinessWrite: async () => {
        value = await performBusinessWrite();
      },
      now: () => now,
    });
    return value;
  });
}

export const appearanceWeatherStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) => RawAsyncStorage.multiGet([...keys]),
  getAllKeys: () => RawAsyncStorage.getAllKeys(),
  setItem: (key: string, value: string) =>
    performCapturedChanges(
      [{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value),
    ),
  removeItem: (key: string) =>
    performCapturedChanges(
      [{ kind: 'remove', key }],
      () => RawAsyncStorage.removeItem(key),
    ),
  multiSet: (entries: readonly (readonly [string, string])[]) =>
    performCapturedChanges(
      entries.map(([key, value]) => ({
        kind: 'set' as const,
        key,
        value,
      })),
      () => RawAsyncStorage.multiSet(
        entries.map(([key, value]) => [key, value]),
      ),
    ),
  multiRemove: (keys: readonly string[]) =>
    performCapturedChanges(
      keys.map((key) => ({ kind: 'remove' as const, key })),
      () => RawAsyncStorage.multiRemove([...keys]),
    ),
};
