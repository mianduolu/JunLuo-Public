import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  PROACTIVE_LEDGER_BATCH_CAPTURE_POLICY,
} from './syncProactiveLedgerApply';
import {
  runProactiveLedgerCaptureExclusive,
} from './syncProactiveLedgerCaptureQueue';
import {
  deriveProactiveLedgerMutationsForStorageChanges,
  isProactiveLedgerGlobalStorageKey,
  type ProactiveLedgerStorageChange,
} from './syncProactiveLedgerStorageDerivation';
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

async function performCapturedProactiveLedgerChangeUnqueued<T>(
  changes: readonly ProactiveLedgerStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const globalChanges = changes.filter(
    (change) => isProactiveLedgerGlobalStorageKey(change.key),
  );
  if (!globalChanges.length) return performBusinessWrite();
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) return performBusinessWrite();
  const {
    expoSyncRandomUuidV1,
  } = await import('./syncCryptoExpo');
  const now = Date.now();
  const mutations =
    await deriveProactiveLedgerMutationsForStorageChanges({
      changes: globalChanges,
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
    policy: PROACTIVE_LEDGER_BATCH_CAPTURE_POLICY,
    durableCapture,
    mutations,
    performBusinessWrite: async () => {
      value = await performBusinessWrite();
    },
    now: () => now,
  });
  return value;
}

function performCapturedProactiveLedgerChange<T>(
  changes: readonly ProactiveLedgerStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  return runProactiveLedgerCaptureExclusive(
    () => performCapturedProactiveLedgerChangeUnqueued(
      changes,
      performBusinessWrite,
    ),
  );
}

export const proactiveLedgerStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) => RawAsyncStorage.multiGet(keys),
  getAllKeys: () => RawAsyncStorage.getAllKeys(),
  setItem: (key: string, value: string) =>
    performCapturedProactiveLedgerChange(
      [{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value),
    ),
  multiSet: (entries: readonly (readonly [string, string])[]) => {
    const writableEntries = entries.map(
      ([key, value]) => [key, value] as [string, string],
    );
    return performCapturedProactiveLedgerChange(
      writableEntries.map(([key, value]) => ({
        kind: 'set' as const,
        key,
        value,
      })),
      () => RawAsyncStorage.multiSet(writableEntries),
    );
  },
  removeItem: (key: string) =>
    performCapturedProactiveLedgerChange(
      [{ kind: 'remove', key }],
      () => RawAsyncStorage.removeItem(key),
    ),
  multiRemove: (keys: readonly string[]) => {
    const writableKeys = [...keys];
    return performCapturedProactiveLedgerChange(
      writableKeys.map((key) => ({
        kind: 'remove' as const,
        key,
      })),
      () => RawAsyncStorage.multiRemove(writableKeys),
    );
  },
};
