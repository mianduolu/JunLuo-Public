import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  PERSONA_EXPRESSION_OBJECTS_BATCH_CAPTURE_POLICY,
} from './syncPersonaExpressionObjectsApply';
import {
  runPersonaExpressionObjectsBootstrap,
  type PersonaExpressionObjectsBootstrapResult,
} from './syncPersonaExpressionObjectsBootstrap';
import {
  runPersonaExpressionObjectsCaptureExclusive,
} from './syncPersonaExpressionObjectsCaptureQueue';
import {
  preparePersonaExpressionObjectsStorageChangesRuntime,
} from './syncPersonaExpressionObjectsContentRuntime';
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

export type PersonaExpressionObjectsBootstrapRuntimeResult =
  | PersonaExpressionObjectsBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
      objectBackedStickerCount: 0;
    };

export async function runPersonaExpressionObjectsBootstrapRuntime():
Promise<PersonaExpressionObjectsBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
      objectBackedStickerCount: 0,
    };
  }
  return runPersonaExpressionObjectsCaptureExclusive(async () => {
    const {
      expoSyncRandomUuidV1,
    } = await import('./syncCryptoExpo');
    const now = Date.now();
    return runPersonaExpressionObjectsBootstrap({
      identity: currentDevice.identity,
      state: syncBootstrapStatePort,
      storage: RawAsyncStorage,
      prepareChanges: (changes) =>
        preparePersonaExpressionObjectsStorageChangesRuntime({
          changes,
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
        capture: async ({
          operationId,
          mutations,
          businessWrites,
        }) => {
          const performBusinessWrite = async () => {
            if (businessWrites.length) {
              await RawAsyncStorage.multiSet(
                businessWrites.map(
                  ([key, value]) => [key, value] as [string, string],
                ),
              );
            }
          };
          if (!mutations.length) {
            await performBusinessWrite();
            return;
          }
          await captureSyncMutationBatch({
            operationId,
            policy: PERSONA_EXPRESSION_OBJECTS_BATCH_CAPTURE_POLICY,
            durableCapture,
            mutations,
            performBusinessWrite,
            now: () => now,
          });
        },
      },
      now: () => now,
    });
  });
}
