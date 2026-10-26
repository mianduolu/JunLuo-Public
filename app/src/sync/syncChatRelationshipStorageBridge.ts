import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  CHAT_RELATIONSHIP_BATCH_CAPTURE_POLICY,
} from './syncChatRelationshipApply';
import {
  runChatRelationshipCaptureExclusive,
} from './syncChatRelationshipCaptureQueue';
import {
  deriveChatRelationshipMutationsForStorageChanges,
  type ChatRelationshipStorageChange,
} from './syncChatRelationshipStorageDerivation';
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

async function performCapturedRelationshipChangeUnqueued<T>(
  changes: readonly ChatRelationshipStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) return performBusinessWrite();
  const {
    expoSyncRandomUuidV1,
  } = await import('./syncCryptoExpo');
  const now = Date.now();
  const mutations = await deriveChatRelationshipMutationsForStorageChanges({
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
    policy: CHAT_RELATIONSHIP_BATCH_CAPTURE_POLICY,
    durableCapture,
    mutations,
    performBusinessWrite: async () => {
      value = await performBusinessWrite();
    },
    now: () => now,
  });
  return value;
}

async function performCapturedRelationshipChange<T>(
  changes: readonly ChatRelationshipStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  return runChatRelationshipCaptureExclusive(
    () => performCapturedRelationshipChangeUnqueued(changes, performBusinessWrite),
  );
}

export const chatRelationshipStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) => RawAsyncStorage.multiGet(keys),
  setItem: (key: string, value: string) => performCapturedRelationshipChange(
    [{ kind: 'set', key, value }],
    () => RawAsyncStorage.setItem(key, value),
  ),
  multiSet: (entries: readonly (readonly [string, string])[]) => {
    const writableEntries = entries.map(([key, value]) => [key, value] as [string, string]);
    return performCapturedRelationshipChange(
      writableEntries.map(([key, value]) => ({ kind: 'set' as const, key, value })),
      () => RawAsyncStorage.multiSet(writableEntries),
    );
  },
  removeItem: (key: string) => performCapturedRelationshipChange(
    [{ kind: 'remove', key }],
    () => RawAsyncStorage.removeItem(key),
  ),
  multiRemove: (keys: readonly string[]) => {
    const writableKeys = [...keys];
    return performCapturedRelationshipChange(
      writableKeys.map((key) => ({ kind: 'remove' as const, key })),
      () => RawAsyncStorage.multiRemove(writableKeys),
    );
  },
};
