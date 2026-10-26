import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  SCHEDULE_SEMANTIC_BATCH_CAPTURE_POLICY,
} from './syncScheduleSemanticApply';
import {
  runScheduleSemanticCaptureExclusive,
} from './syncScheduleSemanticCaptureQueue';
import {
  deriveScheduleSemanticMutationsForStorageChanges,
  isScheduleSemanticGlobalStorageKey,
  type ScheduleSemanticStorageChange,
  type ScheduleSemanticStorageReadPort,
} from './syncScheduleSemanticStorageDerivation';
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

type AsyncStorageBridgePort = ScheduleSemanticStorageReadPort & {
  multiGet(
    keys: readonly string[],
  ): Promise<readonly (readonly [string, string | null])[]>;
  getAllKeys(): Promise<readonly string[]>;
  setItem(key: string, value: string): Promise<void>;
  multiSet(entries: readonly (readonly [string, string])[]): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiRemove(keys: readonly string[]): Promise<void>;
};

const durableCapture = {
  prepareSyncDurableIntent,
  advanceSyncDurableIntent,
  enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
};

function createScheduleSemanticStorageBridge(
  BaseAsyncStorage: AsyncStorageBridgePort,
) {
  async function performCapturedChangeUnqueued<T>(
    changes: readonly ScheduleSemanticStorageChange[],
    performBusinessWrite: () => Promise<T>,
  ) {
    const globalChanges = changes.filter(
      (change) => isScheduleSemanticGlobalStorageKey(change.key),
    );
    if (!globalChanges.length) return performBusinessWrite();
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) return performBusinessWrite();
    const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
    const now = Date.now();
    const mutations =
      await deriveScheduleSemanticMutationsForStorageChanges({
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
      policy: SCHEDULE_SEMANTIC_BATCH_CAPTURE_POLICY,
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
    changes: readonly ScheduleSemanticStorageChange[],
    performBusinessWrite: () => Promise<T>,
  ) {
    return runScheduleSemanticCaptureExclusive(
      () => performCapturedChangeUnqueued(changes, performBusinessWrite),
    );
  }

  return {
    getItem: (key: string) => BaseAsyncStorage.getItem(key),
    multiGet: (keys: readonly string[]) => BaseAsyncStorage.multiGet(keys),
    getAllKeys: () => BaseAsyncStorage.getAllKeys(),
    setItem: (key: string, value: string) =>
      performCapturedChange(
        [{ kind: 'set', key, value }],
        () => BaseAsyncStorage.setItem(key, value),
      ),
    setItemIfCurrent: (key: string, value: string, accepts: (raw: string | null) => boolean) =>
      runScheduleSemanticCaptureExclusive(async () => {
        if (!accepts(await BaseAsyncStorage.getItem(key))) throw new Error('routine-source-changed');
        return performCapturedChangeUnqueued([{ kind: 'set', key, value }], () => BaseAsyncStorage.setItem(key, value));
      }),
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
        () => BaseAsyncStorage.multiSet(writableEntries),
      );
    },
    removeItem: (key: string) =>
      performCapturedChange(
        [{ kind: 'remove', key }],
        () => BaseAsyncStorage.removeItem(key),
      ),
    multiRemove: (keys: readonly string[]) => {
      const writableKeys = [...keys];
      return performCapturedChange(
        writableKeys.map((key) => ({
          kind: 'remove' as const,
          key,
        })),
        () => BaseAsyncStorage.multiRemove(writableKeys),
      );
    },
  };
}

export const scheduleSemanticStorageBridge =
  createScheduleSemanticStorageBridge(RawAsyncStorage);
