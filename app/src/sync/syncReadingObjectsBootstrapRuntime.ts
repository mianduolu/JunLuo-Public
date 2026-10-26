import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  READING_OBJECTS_BATCH_CAPTURE_POLICY,
} from './syncReadingObjectsApply';
import {
  runReadingObjectsBootstrap,
  type ReadingObjectsBootstrapResult,
} from './syncReadingObjectsBootstrap';
import {
  enableReadingObjectsStorageCapture,
  runReadingObjectsCaptureExclusive,
} from './syncReadingObjectsCaptureQueue';
import {
  prepareReadingObjectsIndexForLibraryRuntime,
} from './syncReadingObjectsContentRuntime';
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
  READING_OBJECTS_INDEX_KEY,
  READING_OBJECTS_LIBRARY_KEY,
  serializeReadingObjectsLocalIndex,
} from './syncReadingObjectsStorageDerivation';
import {
  advanceSyncDurableIntent,
  prepareSyncDurableIntent,
} from './syncStore';

const durableCapture = {
  prepareSyncDurableIntent,
  advanceSyncDurableIntent,
  enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
};

export type ReadingObjectsBootstrapRuntimeResult =
  | ReadingObjectsBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
      objectCount: 0;
    };

function emptyLibraryRaw() {
  return JSON.stringify({
    version: 2,
    books: [],
    updatedAt: 0,
  });
}

export async function runReadingObjectsBootstrapRuntime():
Promise<ReadingObjectsBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
      objectCount: 0,
    };
  }
  return runReadingObjectsCaptureExclusive(async () => {
    const {
      expoSyncRandomUuidV1,
    } = await import('./syncCryptoExpo');
    const now = Date.now();
    const result = await runReadingObjectsBootstrap({
      identity: currentDevice.identity,
      state: syncBootstrapStatePort,
      buildIndex: async () => prepareReadingObjectsIndexForLibraryRuntime({
        libraryRaw: await RawAsyncStorage.getItem(
          READING_OBJECTS_LIBRARY_KEY,
        ) ?? emptyLibraryRaw(),
        identity: currentDevice.identity,
        secrets: currentDevice.secrets,
        now,
      }),
      envelopeFactory: (entity) => createSyncMutationEnvelope({
        identity: currentDevice.identity,
        entity,
        state: syncMutationStatePort,
        randomUuid: expoSyncRandomUuidV1,
        now: () => now,
      }),
      capture: {
        capture: async ({ operationId, mutations, index }) => {
          const performBusinessWrite = () => RawAsyncStorage.setItem(
            READING_OBJECTS_INDEX_KEY,
            serializeReadingObjectsLocalIndex(index),
          );
          if (!mutations.length) {
            await performBusinessWrite();
            return;
          }
          await captureSyncMutationBatch({
            operationId,
            policy: READING_OBJECTS_BATCH_CAPTURE_POLICY,
            durableCapture,
            mutations,
            performBusinessWrite,
            now: () => now,
          });
        },
      },
      now: () => now,
    });
    if (
      result.status === 'completed'
      || result.status === 'already-complete'
    ) {
      enableReadingObjectsStorageCapture();
    }
    return result;
  });
}
