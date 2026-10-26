import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  TOGETHER_WALKED_LIFE_BATCH_CAPTURE_POLICY,
} from './syncTogetherWalkedLifeApply';
import {
  runTogetherWalkedLifeBootstrap,
  type TogetherWalkedLifeBootstrapResult,
} from './syncTogetherWalkedLifeBootstrap';
import {
  enableTogetherWalkedLifeStorageCapture,
  runTogetherWalkedLifeCaptureExclusive,
} from './syncTogetherWalkedLifeCaptureQueue';
import {
  prepareTogetherWalkedLifeLocalIndexRuntime,
} from './syncTogetherWalkedLifeContentRuntime';
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
import {
  deriveTogetherWalkedLifeMutations,
  emptyTogetherWalkedLifeLocalIndex,
  emptyTogetherWalkedLifeRawSnapshot,
  parseTogetherWalkedLifeLocalIndex,
  serializeTogetherWalkedLifeLocalIndex,
  TOGETHER_WALKED_LIFE_GLOBAL_KEYS,
  TOGETHER_WALKED_LIFE_INDEX_KEY,
  type TogetherWalkedLifeRawSnapshot,
} from './syncTogetherWalkedLifeStorageDerivation';

const durableCapture = {
  prepareSyncDurableIntent,
  advanceSyncDurableIntent,
  enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
};

export type TogetherWalkedLifeBootstrapRuntimeResult =
  | TogetherWalkedLifeBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
      objectCount: 0;
    };

async function readRawSnapshot():
Promise<TogetherWalkedLifeRawSnapshot> {
  return Object.fromEntries(
    await RawAsyncStorage.multiGet(
      TOGETHER_WALKED_LIFE_GLOBAL_KEYS,
    ),
  );
}

export async function runTogetherWalkedLifeBootstrapRuntime():
Promise<TogetherWalkedLifeBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
      objectCount: 0,
    };
  }
  return runTogetherWalkedLifeCaptureExclusive(async () => {
    const {
      expoSyncRandomUuidV1,
    } = await import('./syncCryptoExpo');
    const now = Date.now();
    const result = await runTogetherWalkedLifeBootstrap({
      identity: currentDevice.identity,
      state: syncBootstrapStatePort,
      build: async () => {
        const raw = await readRawSnapshot();
        const previousIndex = parseTogetherWalkedLifeLocalIndex(
          await RawAsyncStorage.getItem(
            TOGETHER_WALKED_LIFE_INDEX_KEY,
          ),
        );
        const index =
          await prepareTogetherWalkedLifeLocalIndexRuntime({
            raw,
            previous: previousIndex,
            identity: currentDevice.identity,
            secrets: currentDevice.secrets,
            now,
          });
        const mutations =
          await deriveTogetherWalkedLifeMutations({
            previousRaw: emptyTogetherWalkedLifeRawSnapshot(),
            nextRaw: raw,
            previousIndex: emptyTogetherWalkedLifeLocalIndex(),
            nextIndex: index,
            capturedAt: now,
            envelopeFactory: (entity) =>
              createSyncMutationEnvelope({
                identity: currentDevice.identity,
                entity,
                state: syncMutationStatePort,
                randomUuid: expoSyncRandomUuidV1,
                now: () => now,
              }),
          });
        return { mutations, index };
      },
      capture: {
        capture: async ({ operationId, mutations, index }) => {
          const performBusinessWrite = () =>
            RawAsyncStorage.setItem(
              TOGETHER_WALKED_LIFE_INDEX_KEY,
              serializeTogetherWalkedLifeLocalIndex(index),
            );
          if (!mutations.length) {
            await performBusinessWrite();
            return;
          }
          await captureSyncMutationBatch({
            operationId,
            policy: TOGETHER_WALKED_LIFE_BATCH_CAPTURE_POLICY,
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
      enableTogetherWalkedLifeStorageCapture();
    }
    return result;
  });
}
