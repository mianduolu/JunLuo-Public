import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  NEARBY_WORLD_HEALTH_BATCH_CAPTURE_POLICY,
} from './syncNearbyWorldHealthApply';
import {
  runNearbyWorldHealthCaptureExclusive,
} from './syncNearbyWorldHealthCaptureQueue';
import {
  deriveNearbyWorldHealthMutationsForStorageChanges,
  isNearbyWorldHealthGlobalStorageKey,
  type NearbyWorldStorageChange,
} from './syncNearbyWorldHealthStorageDerivation';
import { hasCurrentSyncDeviceSelection } from './syncCurrentDeviceSelection';

async function performCapturedChangeUnqueued<T>(
  changes: readonly NearbyWorldStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const globalChanges = changes.filter(
    (change) => isNearbyWorldHealthGlobalStorageKey(change.key),
  );
  if (!globalChanges.length) return performBusinessWrite();
  if (!(await hasCurrentSyncDeviceSelection())) return performBusinessWrite();
  const [
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
    import('./syncCurrentDevice'),
    import('./syncMutationBatchCapture'),
    import('./syncMutationEnvelope'),
    import('./syncMutationStateStore'),
    import('./syncStore'),
    import('./syncCryptoExpo'),
  ]);
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) return performBusinessWrite();
  const durableCapture = {
    prepareSyncDurableIntent,
    advanceSyncDurableIntent,
    enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
  };
  const now = Date.now();
  const mutations =
    await deriveNearbyWorldHealthMutationsForStorageChanges({
      changes: globalChanges,
      reader: RawAsyncStorage,
      sourceDeviceId: currentDevice.identity.deviceId,
      sourcePlatform: currentDevice.identity.platform,
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
    policy: NEARBY_WORLD_HEALTH_BATCH_CAPTURE_POLICY,
    durableCapture,
    mutations,
    performBusinessWrite: async () => {
      value = await performBusinessWrite();
    },
    now: () => now,
  });
  return value;
}

function performCapturedChange<T>(
  changes: readonly NearbyWorldStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  return runNearbyWorldHealthCaptureExclusive(
    () => performCapturedChangeUnqueued(changes, performBusinessWrite),
  );
}

export const nearbyWorldHealthStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) => RawAsyncStorage.multiGet(keys),
  getAllKeys: () => RawAsyncStorage.getAllKeys(),
  setItem: (key: string, value: string) =>
    performCapturedChange(
      [{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value),
    ),
  multiSet: (entries: readonly (readonly [string, string])[]) => {
    const writableEntries = entries.map(
      ([key, value]) => [key, value] as [string, string],
    );
    return performCapturedChange(
      writableEntries.map(([key, value]) => ({
        kind: 'set' as const,
        key,
        value,
      })),
      () => RawAsyncStorage.multiSet(writableEntries),
    );
  },
  removeItem: (key: string) =>
    performCapturedChange(
      [{ kind: 'remove', key }],
      () => RawAsyncStorage.removeItem(key),
    ),
  multiRemove: (keys: readonly string[]) => {
    const writableKeys = [...keys];
    return performCapturedChange(
      writableKeys.map((key) => ({
        kind: 'remove' as const,
        key,
      })),
      () => RawAsyncStorage.multiRemove(writableKeys),
    );
  },
};
