import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  READING_WORKSPACE_BATCH_CAPTURE_POLICY,
} from './syncReadingWorkspaceApply';
import {
  runReadingWorkspaceBootstrap,
  type ReadingWorkspaceBootstrapResult,
} from './syncReadingWorkspaceBootstrap';
import {
  enableReadingWorkspaceStorageCapture,
  runReadingWorkspaceCaptureExclusive,
} from './syncReadingWorkspaceCaptureQueue';
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

export type ReadingWorkspaceBootstrapRuntimeResult =
  | ReadingWorkspaceBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
    };

export async function runReadingWorkspaceBootstrapRuntime():
Promise<ReadingWorkspaceBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
    };
  }
  return runReadingWorkspaceCaptureExclusive(async () => {
    const {
      expoSyncRandomUuidV1,
    } = await import('./syncCryptoExpo');
    const now = Date.now();
    const result = await runReadingWorkspaceBootstrap({
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
            policy: READING_WORKSPACE_BATCH_CAPTURE_POLICY,
            durableCapture,
            mutations,
            performBusinessWrite: async () => undefined,
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
      enableReadingWorkspaceStorageCapture();
    }
    return result;
  });
}
