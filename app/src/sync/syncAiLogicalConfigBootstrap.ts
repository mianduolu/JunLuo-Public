import RawAsyncStorage from '@react-native-async-storage/async-storage';

import { syncBootstrapOperationId } from './syncBootstrapContract';
import { syncBootstrapStatePort } from './syncBootstrapState';
import type { SyncDevicePublicIdentityV1 } from './syncDeviceContract';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  captureSyncMutationBatch,
} from './syncMutationBatchCapture';
import { createSyncMutationEnvelope } from './syncMutationEnvelope';
import {
  enqueueSyncMutationAndAdvanceHeads,
  syncMutationStatePort,
} from './syncMutationStateStore';
import type { PlainMutationV1 } from './syncProtocol';
import type { SyncDurableIntentState } from './syncRecoveryIntent';
import {
  advanceSyncDurableIntent,
  prepareSyncDurableIntent,
} from './syncStore';
import {
  AI_LOGICAL_CONFIG_ADAPTER_ID,
} from './syncAiLogicalConfig';
import {
  AI_LOGICAL_CONFIG_BATCH_CAPTURE_POLICY,
} from './syncAiLogicalConfigApply';
import {
  deriveAiLogicalConfigMutations,
  readAiLogicalConfigProjection,
  type AiLogicalConfigEnvelopeFactory,
  type AiLogicalConfigProjection,
} from './syncAiLogicalConfigDerivation';

export const AI_LOGICAL_CONFIG_BOOTSTRAP_VERSION = 1 as const;

export type AiLogicalConfigBootstrapStatePort = {
  load(input: {
    adapterId: string;
    version: number;
    sourceDeviceId: string;
  }): Promise<{
    completed: boolean;
    durableIntentState: SyncDurableIntentState | null;
  }>;
  markCompleted(input: {
    adapterId: string;
    version: number;
    sourceDeviceId: string;
    updatedAt: number;
  }): Promise<void>;
};

export type AiLogicalConfigBootstrapCapturePort = {
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
};

export type AiLogicalConfigBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
};

let captureQueue = Promise.resolve();

export function runAiLogicalConfigCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = captureQueue.catch(() => undefined).then(callback);
  captureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

export async function runAiLogicalConfigBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: AiLogicalConfigBootstrapStatePort;
  buildProjection(): Promise<AiLogicalConfigProjection[]>;
  capture: AiLogicalConfigBootstrapCapturePort;
  envelopeFactory: AiLogicalConfigEnvelopeFactory;
  now?: () => number;
}) {
  const stateInput = {
    adapterId: AI_LOGICAL_CONFIG_ADAPTER_ID,
    version: AI_LOGICAL_CONFIG_BOOTSTRAP_VERSION,
    sourceDeviceId: input.identity.deviceId,
  };
  const operationId = syncBootstrapOperationId(stateInput);
  const state = await input.state.load(stateInput);
  if (state.completed) {
    return {
      status: 'already-complete',
      operationId,
      mutationCount: 0,
    } satisfies AiLogicalConfigBootstrapResult;
  }
  if (state.durableIntentState === 'captured') {
    await input.state.markCompleted({
      ...stateInput,
      updatedAt: (input.now ?? Date.now)(),
    });
    return {
      status: 'completed',
      operationId,
      mutationCount: 0,
    } satisfies AiLogicalConfigBootstrapResult;
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
    } satisfies AiLogicalConfigBootstrapResult;
  }
  const capturedAt = (input.now ?? Date.now)();
  const next = await input.buildProjection();
  const mutations = await deriveAiLogicalConfigMutations({
    previous: [],
    next,
    capturedAt,
    envelopeFactory: input.envelopeFactory,
  });
  if (mutations.length) {
    await input.capture.capture({ operationId, mutations });
  }
  await input.state.markCompleted({
    ...stateInput,
    updatedAt: capturedAt,
  });
  return {
    status: 'completed',
    operationId,
    mutationCount: mutations.length,
  } satisfies AiLogicalConfigBootstrapResult;
}

export type AiLogicalConfigBootstrapRuntimeResult =
  | AiLogicalConfigBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
    };

export async function runAiLogicalConfigBootstrapRuntime():
Promise<AiLogicalConfigBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
    };
  }
  return runAiLogicalConfigCaptureExclusive(async () => {
    const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
    const now = Date.now();
    return runAiLogicalConfigBootstrap({
      identity: currentDevice.identity,
      state: syncBootstrapStatePort,
      buildProjection: () => readAiLogicalConfigProjection({
        reader: RawAsyncStorage,
      }),
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
            policy: AI_LOGICAL_CONFIG_BATCH_CAPTURE_POLICY,
            durableCapture: {
              prepareSyncDurableIntent,
              advanceSyncDurableIntent,
              enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
            },
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
