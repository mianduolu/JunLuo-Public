import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  NEARBY_WORLD_HEALTH_BATCH_CAPTURE_POLICY,
} from './syncNearbyWorldHealthApply';
import {
  runNearbyWorldHealthBootstrap,
  type NearbyWorldHealthBootstrapResult,
} from './syncNearbyWorldHealthBootstrap';
import {
  runNearbyWorldHealthCaptureExclusive,
} from './syncNearbyWorldHealthCaptureQueue';
import { syncBootstrapStatePort } from './syncBootstrapState';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  captureSyncMutationBatch,
} from './syncMutationBatchCapture';
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

export type NearbyWorldHealthBootstrapRuntimeResult =
  | NearbyWorldHealthBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
    };

export async function runNearbyWorldHealthBootstrapRuntime():
Promise<NearbyWorldHealthBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
    };
  }
  return runNearbyWorldHealthCaptureExclusive(async () => {
    const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
    const now = Date.now();
    return runNearbyWorldHealthBootstrap({
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
            policy: NEARBY_WORLD_HEALTH_BATCH_CAPTURE_POLICY,
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
