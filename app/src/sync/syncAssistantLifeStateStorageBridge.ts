import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  ASSISTANT_LIFE_STATE_BATCH_CAPTURE_POLICY,
} from './syncAssistantLifeStateApply';
import {
  runAssistantLifeStateCaptureExclusive,
} from './syncAssistantLifeStateCaptureQueue';
import {
  deriveAssistantLifeStateMutationsForStorageChanges,
  type AssistantLifeStateStorageChange,
} from './syncAssistantLifeStateStorageDerivation';
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

async function performCapturedAssistantLifeStateChangeUnqueued<T>(
  changes: readonly AssistantLifeStateStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) return performBusinessWrite();
  const {
    expoSyncRandomUuidV1,
  } = await import('./syncCryptoExpo');
  const now = Date.now();
  const mutations = await deriveAssistantLifeStateMutationsForStorageChanges({
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
    policy: ASSISTANT_LIFE_STATE_BATCH_CAPTURE_POLICY,
    durableCapture,
    mutations,
    performBusinessWrite: async () => {
      value = await performBusinessWrite();
    },
    now: () => now,
  });
  return value;
}

async function performCapturedAssistantLifeStateChange<T>(
  changes: readonly AssistantLifeStateStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  return runAssistantLifeStateCaptureExclusive(
    () => performCapturedAssistantLifeStateChangeUnqueued(
      changes,
      performBusinessWrite,
    ),
  );
}

export const assistantLifeStateStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) => RawAsyncStorage.multiGet(keys),
  getAllKeys: () => RawAsyncStorage.getAllKeys(),
  setLocalItem: (key: string, value: string) =>
    RawAsyncStorage.setItem(key, value),
  setItem: (key: string, value: string) =>
    performCapturedAssistantLifeStateChange(
      [{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value),
    ),
  multiSet: (entries: readonly (readonly [string, string])[]) => {
    const writableEntries = entries.map(
      ([key, value]) => [key, value] as [string, string],
    );
    return performCapturedAssistantLifeStateChange(
      writableEntries.map(([key, value]) => ({
        kind: 'set' as const,
        key,
        value,
      })),
      () => RawAsyncStorage.multiSet(writableEntries),
    );
  },
  removeItem: (key: string) =>
    performCapturedAssistantLifeStateChange(
      [{ kind: 'remove', key }],
      () => RawAsyncStorage.removeItem(key),
    ),
  multiRemove: (keys: readonly string[]) => {
    const writableKeys = [...keys];
    return performCapturedAssistantLifeStateChange(
      writableKeys.map((key) => ({ kind: 'remove' as const, key })),
      () => RawAsyncStorage.multiRemove(writableKeys),
    );
  },
};
