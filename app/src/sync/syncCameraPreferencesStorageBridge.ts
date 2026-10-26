import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  CAMERA_PREFERENCES_BATCH_CAPTURE_POLICY,
} from './syncCameraPreferencesApply';
import {
  runCameraPreferencesCaptureExclusive,
} from './syncCameraPreferencesCaptureQueue';
import {
  deriveCameraPreferenceMutationsForStorageChanges,
  isCameraPreferencesGlobalStorageKey,
  type CameraPreferencesStorageChange,
} from './syncCameraPreferencesStorageDerivation';
import { hasCurrentSyncDeviceSelection } from './syncCurrentDeviceSelection';

async function performCapturedChangeUnqueued<T>(
  changes: readonly CameraPreferencesStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const globalChanges = changes.filter(
    (change) => isCameraPreferencesGlobalStorageKey(change.key),
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
    await deriveCameraPreferenceMutationsForStorageChanges({
      changes: globalChanges,
      reader: RawAsyncStorage,
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
    policy: CAMERA_PREFERENCES_BATCH_CAPTURE_POLICY,
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
  changes: readonly CameraPreferencesStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  return runCameraPreferencesCaptureExclusive(
    () => performCapturedChangeUnqueued(
      changes,
      performBusinessWrite,
    ),
  );
}

export const cameraPreferencesStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  setItem: (key: string, value: string) =>
    performCapturedChange(
      [{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value),
    ),
  removeItem: (key: string) =>
    performCapturedChange(
      [{ kind: 'remove', key }],
      () => RawAsyncStorage.removeItem(key),
    ),
};
