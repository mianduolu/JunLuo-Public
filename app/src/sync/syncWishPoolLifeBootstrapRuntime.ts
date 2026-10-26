import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  WISH_POOL_LIFE_BATCH_CAPTURE_POLICY,
} from './syncWishPoolLifeApply';
import {
  runWishPoolLifeBootstrap,
  type WishPoolLifeBootstrapResult,
} from './syncWishPoolLifeBootstrap';
import {
  runWishPoolLifeCaptureExclusive,
} from './syncWishPoolLifeCaptureQueue';
import { syncBootstrapStatePort } from './syncBootstrapState';
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

export type WishPoolLifeBootstrapRuntimeResult =
  | WishPoolLifeBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
    };

export async function runWishPoolLifeBootstrapRuntime():
Promise<WishPoolLifeBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
    };
  }
  return runWishPoolLifeCaptureExclusive(async () => {
    const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
    const now = Date.now();
    return runWishPoolLifeBootstrap({
      identity: currentDevice.identity,
      state: syncBootstrapStatePort,
      storage: RawAsyncStorage,
      envelopeFactory: (entity) => createSyncMutationEnvelope({
        identity: currentDevice.identity,
        entity,
        state: syncMutationStatePort,
        randomUuid: expoSyncRandomUuidV1,
        now: () => now,
      }),
      capture: {
        capture: async ({ operationId, mutations }) => {
          await captureSyncMutationBatch({
            operationId,
            policy: WISH_POOL_LIFE_BATCH_CAPTURE_POLICY,
            durableCapture,
            mutations,
            performBusinessWrite: async () => undefined,
            now: () => now,
          });
        },
      },
      now: () => now,
    });
  });
}
