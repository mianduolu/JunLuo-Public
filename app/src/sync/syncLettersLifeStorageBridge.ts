import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  LETTERS_LIFE_BATCH_CAPTURE_POLICY,
} from './syncLettersLifeApply';
import {
  runLettersLifeCaptureExclusive,
} from './syncLettersLifeCaptureQueue';
import {
  deriveLettersLifeMutationsForStorageChanges,
  type LettersLifeStorageChange,
} from './syncLettersLifeStorageDerivation';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import { captureSyncMutationBatch } from './syncMutationBatchCapture';
import { createSyncMutationEnvelope } from './syncMutationEnvelope';
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

async function performCapturedLettersLifeChangeUnqueued<T>(
  changes: readonly LettersLifeStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) return performBusinessWrite();
  const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
  const now = Date.now();
  const mutations = await deriveLettersLifeMutationsForStorageChanges({
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
    policy: LETTERS_LIFE_BATCH_CAPTURE_POLICY,
    durableCapture,
    mutations,
    performBusinessWrite: async () => {
      value = await performBusinessWrite();
    },
    now: () => now,
  });
  return value;
}

function performCapturedLettersLifeChange<T>(
  changes: readonly LettersLifeStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  return runLettersLifeCaptureExclusive(
    () => performCapturedLettersLifeChangeUnqueued(
      changes,
      performBusinessWrite,
    ),
  );
}

export const lettersLifeStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) => RawAsyncStorage.multiGet(keys),
  getAllKeys: () => RawAsyncStorage.getAllKeys(),
  setItem: (key: string, value: string) =>
    performCapturedLettersLifeChange(
      [{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value),
    ),
  multiSet: (entries: readonly (readonly [string, string])[]) => {
    const writableEntries = entries.map(
      ([key, value]) => [key, value] as [string, string],
    );
    return performCapturedLettersLifeChange(
      writableEntries.map(([key, value]) => ({
        kind: 'set' as const,
        key,
        value,
      })),
      () => RawAsyncStorage.multiSet(writableEntries),
    );
  },
  removeItem: (key: string) =>
    performCapturedLettersLifeChange(
      [{ kind: 'remove', key }],
      () => RawAsyncStorage.removeItem(key),
    ),
  multiRemove: (keys: readonly string[]) => {
    const writableKeys = [...keys];
    return performCapturedLettersLifeChange(
      writableKeys.map((key) => ({
        kind: 'remove' as const,
        key,
      })),
      () => RawAsyncStorage.multiRemove(writableKeys),
    );
  },
};
