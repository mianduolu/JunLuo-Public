import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  WISH_POOL_LIFE_BATCH_CAPTURE_POLICY,
} from './syncWishPoolLifeApply';
import {
  runWishPoolLifeCaptureExclusive,
} from './syncWishPoolLifeCaptureQueue';
import {
  deriveWishPoolLifeMutationsForStorageChanges,
  type WishPoolLifeStorageChange,
} from './syncWishPoolLifeStorageDerivation';
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

async function performCapturedWishPoolLifeChangeUnqueued<T>(
  changes: readonly WishPoolLifeStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) return performBusinessWrite();
  const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
  const now = Date.now();
  const mutations =
    await deriveWishPoolLifeMutationsForStorageChanges({
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
    policy: WISH_POOL_LIFE_BATCH_CAPTURE_POLICY,
    durableCapture,
    mutations,
    performBusinessWrite: async () => {
      value = await performBusinessWrite();
    },
    now: () => now,
  });
  return value;
}

function performCapturedWishPoolLifeChange<T>(
  changes: readonly WishPoolLifeStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  return runWishPoolLifeCaptureExclusive(
    () => performCapturedWishPoolLifeChangeUnqueued(
      changes,
      performBusinessWrite,
    ),
  );
}

export const wishPoolLifeStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) => RawAsyncStorage.multiGet(keys),
  getAllKeys: () => RawAsyncStorage.getAllKeys(),
  setItem: (key: string, value: string) =>
    performCapturedWishPoolLifeChange(
      [{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value),
    ),
  multiSet: (entries: readonly (readonly [string, string])[]) => {
    const writableEntries = entries.map(
      ([key, value]) => [key, value] as [string, string],
    );
    return performCapturedWishPoolLifeChange(
      writableEntries.map(([key, value]) => ({
        kind: 'set' as const,
        key,
        value,
      })),
      () => RawAsyncStorage.multiSet(writableEntries),
    );
  },
  removeItem: (key: string) =>
    performCapturedWishPoolLifeChange(
      [{ kind: 'remove', key }],
      () => RawAsyncStorage.removeItem(key),
    ),
  multiRemove: (keys: readonly string[]) => {
    const writableKeys = [...keys];
    return performCapturedWishPoolLifeChange(
      writableKeys.map((key) => ({
        kind: 'remove' as const,
        key,
      })),
      () => RawAsyncStorage.multiRemove(writableKeys),
    );
  },
};

// Protect the entire read/modify/write, not only the final storage write, against sync apply.
export function runWishPoolLifeStorageMutation<T>(
  work: (write: (key: string, value: string) => Promise<void>) => Promise<T>,
) {
  return runWishPoolLifeCaptureExclusive(() => work((key, value) =>
    performCapturedWishPoolLifeChangeUnqueued([{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value))));
}
