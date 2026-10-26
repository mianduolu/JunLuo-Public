import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  READING_WORKSPACE_BATCH_CAPTURE_POLICY,
} from './syncReadingWorkspaceApply';
import {
  isReadingWorkspaceStorageCaptureEnabled,
  runReadingWorkspaceCaptureExclusive,
} from './syncReadingWorkspaceCaptureQueue';
import {
  deriveReadingWorkspaceMutationsForStorageChanges,
  hasReadingWorkspaceStorageProjectionChange,
  isReadingWorkspaceManagedStorageKey,
  type ReadingWorkspaceStorageChange,
} from './syncReadingWorkspaceStorageDerivation';
import {
  loadCurrentSyncDevice,
} from './syncCurrentDevice';
import {
  captureSyncMutationBatch,
} from './syncMutationBatchCapture';
import {
  createSyncMutationEnvelope,
} from './syncMutationEnvelope';
import {
  enqueueSyncMutationAndAdvanceHeads,
  syncMutationStatePort,
} from './syncMutationStateStore';
import {
  advanceSyncDurableIntent,
  prepareSyncDurableIntent,
} from './syncStore';

const durableCapture = {
  prepareSyncDurableIntent,
  advanceSyncDurableIntent,
  enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
};

async function performCapturedReadingWorkspaceChangeUnqueued<T>(
  changes: readonly ReadingWorkspaceStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  if (
    !isReadingWorkspaceStorageCaptureEnabled()
    || !changes.some((change) =>
      isReadingWorkspaceManagedStorageKey(change.key))
  ) {
    return performBusinessWrite();
  }
  if (!await hasReadingWorkspaceStorageProjectionChange({
    changes,
    reader: RawAsyncStorage,
  })) {
    return performBusinessWrite();
  }
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) return performBusinessWrite();
  const {
    expoSyncRandomUuidV1,
  } = await import('./syncCryptoExpo');
  const now = Date.now();
  const mutations =
    await deriveReadingWorkspaceMutationsForStorageChanges({
      changes,
      reader: RawAsyncStorage,
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
    policy: READING_WORKSPACE_BATCH_CAPTURE_POLICY,
    durableCapture,
    mutations,
    performBusinessWrite: async () => {
      value = await performBusinessWrite();
    },
    now: () => now,
  });
  return value;
}

function performCapturedReadingWorkspaceChange<T>(
  changes: readonly ReadingWorkspaceStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  return runReadingWorkspaceCaptureExclusive(
    () => performCapturedReadingWorkspaceChangeUnqueued(
      changes,
      performBusinessWrite,
    ),
  );
}

export const readingWorkspaceStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) => RawAsyncStorage.multiGet(keys),
  getAllKeys: () => RawAsyncStorage.getAllKeys(),
  setItem: (key: string, value: string) =>
    performCapturedReadingWorkspaceChange(
      [{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value),
    ),
  multiSet: (entries: readonly (readonly [string, string])[]) => {
    const writable = entries.map(
      ([key, value]) => [key, value] as [string, string],
    );
    return performCapturedReadingWorkspaceChange(
      writable.map(([key, value]) => ({
        kind: 'set' as const,
        key,
        value,
      })),
      () => RawAsyncStorage.multiSet(writable),
    );
  },
  removeItem: (key: string) =>
    performCapturedReadingWorkspaceChange(
      [{ kind: 'remove', key }],
      () => RawAsyncStorage.removeItem(key),
    ),
  multiRemove: (keys: readonly string[]) => {
    const writable = [...keys];
    return performCapturedReadingWorkspaceChange(
      writable.map((key) => ({ kind: 'remove' as const, key })),
      () => RawAsyncStorage.multiRemove(writable),
    );
  },
};
