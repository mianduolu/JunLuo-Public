import {
  BEHAVIOR_ROUTING_BATCH_CAPTURE_POLICY,
} from './syncBehaviorRoutingApply';
import {
  runBehaviorRoutingCaptureExclusive,
} from './syncBehaviorRoutingCaptureQueue';
import {
  deriveBehaviorRoutingMutationsForStorageChanges,
  isBehaviorRoutingGlobalStorageKey,
  type BehaviorRoutingStorageChange,
} from './syncBehaviorRoutingStorageDerivation';
import BaseAsyncStorage from '@react-native-async-storage/async-storage';
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

async function performCapturedBehaviorRoutingChangeUnqueued<T>(
  changes: readonly BehaviorRoutingStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const globalChanges = changes.filter(
    (change) => isBehaviorRoutingGlobalStorageKey(change.key),
  );
  if (!globalChanges.length) return performBusinessWrite();
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) return performBusinessWrite();
  const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
  const now = Date.now();
  const mutations = await deriveBehaviorRoutingMutationsForStorageChanges({
    changes: globalChanges,
    reader: BaseAsyncStorage,
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
    policy: BEHAVIOR_ROUTING_BATCH_CAPTURE_POLICY,
    durableCapture,
    mutations,
    performBusinessWrite: async () => {
      value = await performBusinessWrite();
    },
    now: () => now,
  });
  return value;
}

function performCapturedBehaviorRoutingChange<T>(
  changes: readonly BehaviorRoutingStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  return runBehaviorRoutingCaptureExclusive(
    () => performCapturedBehaviorRoutingChangeUnqueued(
      changes,
      performBusinessWrite,
    ),
  );
}

export const behaviorRoutingStorageBridge = {
  getItem: (key: string) => BaseAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) => BaseAsyncStorage.multiGet(keys),
  getAllKeys: () => BaseAsyncStorage.getAllKeys(),
  setItem: (key: string, value: string) =>
    performCapturedBehaviorRoutingChange(
      [{ kind: 'set', key, value }],
      () => BaseAsyncStorage.setItem(key, value),
    ),
  multiSet: (entries: readonly (readonly [string, string])[]) => {
    const writableEntries = entries.map(
      ([key, value]) => [key, value] as [string, string],
    );
    return performCapturedBehaviorRoutingChange(
      writableEntries.map(([key, value]) => ({
        kind: 'set' as const,
        key,
        value,
      })),
      () => BaseAsyncStorage.multiSet(writableEntries),
    );
  },
  removeItem: (key: string) =>
    performCapturedBehaviorRoutingChange(
      [{ kind: 'remove', key }],
      () => BaseAsyncStorage.removeItem(key),
    ),
  multiRemove: (keys: readonly string[]) => {
    const writableKeys = [...keys];
    return performCapturedBehaviorRoutingChange(
      writableKeys.map((key) => ({
        kind: 'remove' as const,
        key,
      })),
      () => BaseAsyncStorage.multiRemove(writableKeys),
    );
  },
};
