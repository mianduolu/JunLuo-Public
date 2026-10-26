import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  MEMORY_EXPERIENCE_BATCH_CAPTURE_POLICY,
} from './syncMemoryExperienceApply';
import {
  runMemoryExperienceCaptureExclusive,
} from './syncMemoryExperienceCaptureQueue';
import {
  deriveMemoryExperienceMutationsForStorageChanges,
  type MemoryExperienceStorageChange,
} from './syncMemoryExperienceStorageDerivation';
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

async function performCapturedMemoryExperienceChangeUnqueued<T>(
  changes: readonly MemoryExperienceStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) return performBusinessWrite();
  const {
    expoSyncRandomUuidV1,
  } = await import('./syncCryptoExpo');
  const now = Date.now();
  const mutations = await deriveMemoryExperienceMutationsForStorageChanges({
    changes,
    reader: RawAsyncStorage,
    deletedAt: now,
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
    policy: MEMORY_EXPERIENCE_BATCH_CAPTURE_POLICY,
    durableCapture,
    mutations,
    performBusinessWrite: async () => {
      value = await performBusinessWrite();
    },
    now: () => now,
  });
  return value;
}

async function performCapturedMemoryExperienceChange<T>(
  changes: readonly MemoryExperienceStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  return runMemoryExperienceCaptureExclusive(
    () => performCapturedMemoryExperienceChangeUnqueued(
      changes,
      performBusinessWrite,
    ),
  );
}

export const memoryExperienceStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) => RawAsyncStorage.multiGet(keys),
  setItem: (key: string, value: string) =>
    performCapturedMemoryExperienceChange(
      [{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value),
    ),
  multiSet: (entries: readonly (readonly [string, string])[]) => {
    const writableEntries = entries.map(
      ([key, value]) => [key, value] as [string, string],
    );
    return performCapturedMemoryExperienceChange(
      writableEntries.map(([key, value]) => ({
        kind: 'set' as const,
        key,
        value,
      })),
      () => RawAsyncStorage.multiSet(writableEntries),
    );
  },
  removeItem: (key: string) =>
    performCapturedMemoryExperienceChange(
      [{ kind: 'remove', key }],
      () => RawAsyncStorage.removeItem(key),
    ),
  multiRemove: (keys: readonly string[]) => {
    const writableKeys = [...keys];
    return performCapturedMemoryExperienceChange(
      writableKeys.map((key) => ({ kind: 'remove' as const, key })),
      () => RawAsyncStorage.multiRemove(writableKeys),
    );
  },
};
