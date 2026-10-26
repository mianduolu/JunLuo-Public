import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  READING_OBJECTS_BATCH_CAPTURE_POLICY,
} from './syncReadingObjectsApply';
import {
  enableReadingObjectsStorageCapture,
  isReadingObjectsStorageCaptureEnabled,
  runReadingObjectsCaptureExclusive,
} from './syncReadingObjectsCaptureQueue';
import {
  READING_OBJECTS_BOOTSTRAP_VERSION,
} from './syncReadingObjectsBootstrap';
import {
  READING_OBJECTS_ADAPTER_ID,
} from './syncReadingObjects';
import {
  deriveReadingObjectsMutations,
  parseReadingObjectsLocalIndex,
  READING_OBJECTS_INDEX_KEY,
  READING_OBJECTS_LIBRARY_KEY,
  serializeReadingObjectsLocalIndex,
} from './syncReadingObjectsStorageDerivation';
import {
  readingWorkspaceStorageBridge,
} from './syncReadingWorkspaceStorageBridge';
import {
  syncBootstrapStatePort,
} from './syncBootstrapState';
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

async function captureReadingObjectsForLibraryRaw(
  libraryRaw: string,
  options: { forceCapture?: boolean } = {},
) {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) return;
  await runReadingObjectsCaptureExclusive(async () => {
    if (
      !options.forceCapture
      && !isReadingObjectsStorageCaptureEnabled()
    ) {
      const bootstrap = await syncBootstrapStatePort.load({
        adapterId: READING_OBJECTS_ADAPTER_ID,
        version: READING_OBJECTS_BOOTSTRAP_VERSION,
        sourceDeviceId: currentDevice.identity.deviceId,
      });
      if (!bootstrap.completed) return;
      enableReadingObjectsStorageCapture();
    }
    const {
      prepareReadingObjectsIndexForLibraryRuntime,
    } = await import('./syncReadingObjectsContentRuntime');
    const now = Date.now();
    const previous = parseReadingObjectsLocalIndex(
      await RawAsyncStorage.getItem(READING_OBJECTS_INDEX_KEY),
    );
    const next = await prepareReadingObjectsIndexForLibraryRuntime({
      libraryRaw,
      identity: currentDevice.identity,
      secrets: currentDevice.secrets,
      now,
    });
    const {
      expoSyncRandomUuidV1,
    } = await import('./syncCryptoExpo');
    const mutations = await deriveReadingObjectsMutations({
      previous,
      next,
      capturedAt: now,
      envelopeFactory: (entity) => createSyncMutationEnvelope({
        identity: currentDevice.identity,
        entity,
        state: syncMutationStatePort,
        randomUuid: expoSyncRandomUuidV1,
        now: () => now,
      }),
    });
    const previousRaw = serializeReadingObjectsLocalIndex(previous);
    const nextRaw = serializeReadingObjectsLocalIndex(next);
    if (!mutations.length && previousRaw === nextRaw) return;
    const performBusinessWrite = () => RawAsyncStorage.setItem(
      READING_OBJECTS_INDEX_KEY,
      nextRaw,
    );
    if (!mutations.length) {
      await performBusinessWrite();
      return;
    }
    await captureSyncMutationBatch({
      operationId: expoSyncRandomUuidV1(),
      policy: READING_OBJECTS_BATCH_CAPTURE_POLICY,
      durableCapture,
      mutations,
      performBusinessWrite,
      now: () => now,
    });
  });
}

export async function reconcileReadingObjectsStorageBridge() {
  const libraryRaw = await RawAsyncStorage.getItem(
    READING_OBJECTS_LIBRARY_KEY,
  );
  if (libraryRaw === null) return;
  await captureReadingObjectsForLibraryRaw(libraryRaw, {
    forceCapture: true,
  });
  enableReadingObjectsStorageCapture();
}

function emptyLibraryRaw() {
  return JSON.stringify({
    version: 2,
    books: [],
    updatedAt: Date.now(),
  });
}

export const readingStorageBridge = {
  getItem: (key: string) => readingWorkspaceStorageBridge.getItem(key),
  multiGet: (keys: readonly string[]) =>
    readingWorkspaceStorageBridge.multiGet(keys),
  getAllKeys: () => readingWorkspaceStorageBridge.getAllKeys(),
  async setItem(key: string, value: string) {
    if (key === READING_OBJECTS_LIBRARY_KEY) {
      await captureReadingObjectsForLibraryRaw(value);
    }
    return readingWorkspaceStorageBridge.setItem(key, value);
  },
  async multiSet(entries: readonly (readonly [string, string])[]) {
    const library = [...entries].reverse().find(
      ([key]) => key === READING_OBJECTS_LIBRARY_KEY,
    );
    if (library) await captureReadingObjectsForLibraryRaw(library[1]);
    return readingWorkspaceStorageBridge.multiSet(entries);
  },
  async removeItem(key: string) {
    if (key === READING_OBJECTS_LIBRARY_KEY) {
      await captureReadingObjectsForLibraryRaw(emptyLibraryRaw());
    }
    return readingWorkspaceStorageBridge.removeItem(key);
  },
  async multiRemove(keys: readonly string[]) {
    if (keys.includes(READING_OBJECTS_LIBRARY_KEY)) {
      await captureReadingObjectsForLibraryRaw(emptyLibraryRaw());
    }
    return readingWorkspaceStorageBridge.multiRemove(keys);
  },
};
