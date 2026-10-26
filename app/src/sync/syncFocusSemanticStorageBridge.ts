import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  FOCUS_SEMANTIC_BATCH_CAPTURE_POLICY,
} from './syncFocusSemanticApply';
import {
  isFocusSemanticStorageCaptureEnabled,
  runFocusSemanticCaptureExclusive,
} from './syncFocusSemanticCaptureQueue';
import {
  deriveFocusSemanticMutationsForStorageChanges,
  hasFocusSemanticStorageProjectionChange,
  isFocusSemanticGlobalStorageKey,
  type FocusSemanticStorageChange,
  type FocusSemanticStorageReadPort,
} from './syncFocusSemanticStorageDerivation';
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

type AsyncStorageBridgePort = FocusSemanticStorageReadPort & {
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

function createFocusSemanticStorageBridge(
  BaseAsyncStorage: AsyncStorageBridgePort,
  queued = true,
) {
  async function performCapturedChangeUnqueued<T>(
    changes: readonly FocusSemanticStorageChange[],
    performBusinessWrite: () => Promise<T>,
  ) {
    const globalChanges = changes.filter(
      (change) => isFocusSemanticGlobalStorageKey(change.key),
    );
    if (!globalChanges.length) return performBusinessWrite();
    if (!isFocusSemanticStorageCaptureEnabled()) {
      return performBusinessWrite();
    }
    if (!await hasFocusSemanticStorageProjectionChange({
      changes: globalChanges,
      reader: BaseAsyncStorage,
    })) {
      return performBusinessWrite();
    }
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) return performBusinessWrite();
    const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
    const now = Date.now();
    const mutations =
      await deriveFocusSemanticMutationsForStorageChanges({
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
      policy: FOCUS_SEMANTIC_BATCH_CAPTURE_POLICY,
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
    changes: readonly FocusSemanticStorageChange[],
    performBusinessWrite: () => Promise<T>,
  ) {
    return queued ? runFocusSemanticCaptureExclusive(
      () => performCapturedChangeUnqueued(changes, performBusinessWrite),
    ) : performCapturedChangeUnqueued(changes, performBusinessWrite);
  }

  return {
    getItem: (key: string) => BaseAsyncStorage.getItem(key),
    multiGet: (keys: readonly string[]) => BaseAsyncStorage.multiGet(keys),
    getAllKeys: () => BaseAsyncStorage.getAllKeys(),
    setItem: (key: string, value: string) => performCapturedChange(
      [{ kind: 'set', key, value }],
      () => BaseAsyncStorage.setItem(key, value),
    ),
    multiSet: (entries: readonly (readonly [string, string])[]) => {
      const writable = entries.map(([key, value]) => (
        [key, value] as [string, string]
      ));
      return performCapturedChange(
        writable.map(([key, value]) => ({
          kind: 'set' as const,
          key,
          value,
        })),
        () => BaseAsyncStorage.multiSet(writable),
      );
    },
    removeItem: (key: string) => performCapturedChange(
      [{ kind: 'remove', key }],
      () => BaseAsyncStorage.removeItem(key),
    ),
    multiRemove: (keys: readonly string[]) => {
      const writable = [...keys];
      return performCapturedChange(
        writable.map((key) => ({ kind: 'remove' as const, key })),
        () => BaseAsyncStorage.multiRemove(writable),
      );
    },
  };
}

export const focusSemanticStorageBridge =
  createFocusSemanticStorageBridge(RawAsyncStorage);

const unqueuedFocusSemanticStorageBridge = createFocusSemanticStorageBridge(RawAsyncStorage, false);
export function runFocusSemanticStorageMutation<T>(
  work: (storage: typeof focusSemanticStorageBridge) => Promise<T>,
): Promise<T> {
  return runFocusSemanticCaptureExclusive(() => work(unqueuedFocusSemanticStorageBridge));
}
