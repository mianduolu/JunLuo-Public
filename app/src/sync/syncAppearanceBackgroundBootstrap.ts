import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  APPEARANCE_BACKGROUND_ADAPTER_ID,
} from './syncAppearanceBackground';
import {
  APPEARANCE_BACKGROUND_BATCH_CAPTURE_POLICY,
} from './syncAppearanceBackgroundApply';
import {
  APPEARANCE_BACKGROUND_INDEX_KEY,
  APPEARANCE_BACKGROUND_SETTINGS_KEY,
  deriveAppearanceBackgroundMutations,
  parseAppearanceBackgroundLocalIndex,
  projectAppearanceBackground,
  type AppearanceBackgroundEnvelopeFactory,
  type AppearanceBackgroundProjection,
} from './syncAppearanceBackgroundStorageDerivation';
import { syncBootstrapOperationId } from './syncBootstrapContract';
import { syncBootstrapStatePort } from './syncBootstrapState';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import type { SyncDevicePublicIdentityV1 } from './syncDeviceContract';
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

export const APPEARANCE_BACKGROUND_BOOTSTRAP_VERSION = 1 as const;

export type AppearanceBackgroundBootstrapStatePort = {
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

export type AppearanceBackgroundBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
  objectCount: number;
};

let captureQueue = Promise.resolve();

export function runAppearanceBackgroundCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = captureQueue.catch(() => undefined).then(callback);
  captureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

export async function runAppearanceBackgroundBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: AppearanceBackgroundBootstrapStatePort;
  buildProjection(): Promise<AppearanceBackgroundProjection[]>;
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
  envelopeFactory: AppearanceBackgroundEnvelopeFactory;
  now?: () => number;
}) {
  const stateInput = {
    adapterId: APPEARANCE_BACKGROUND_ADAPTER_ID,
    version: APPEARANCE_BACKGROUND_BOOTSTRAP_VERSION,
    sourceDeviceId: input.identity.deviceId,
  };
  const operationId = syncBootstrapOperationId(stateInput);
  const state = await input.state.load(stateInput);
  if (state.completed) {
    return {
      status: 'already-complete',
      operationId,
      mutationCount: 0,
      objectCount: 0,
    } satisfies AppearanceBackgroundBootstrapResult;
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
      objectCount: 0,
    } satisfies AppearanceBackgroundBootstrapResult;
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
      objectCount: 0,
    } satisfies AppearanceBackgroundBootstrapResult;
  }
  const capturedAt = (input.now ?? Date.now)();
  const next = await input.buildProjection();
  const mutations = await deriveAppearanceBackgroundMutations({
    previous: [],
    next,
    capturedAt,
    envelopeFactory: input.envelopeFactory,
  });
  if (mutations.length) {
    await input.capture({ operationId, mutations });
  }
  await input.state.markCompleted({
    ...stateInput,
    updatedAt: capturedAt,
  });
  return {
    status: 'completed',
    operationId,
    mutationCount: mutations.length,
    objectCount: next.filter(
      (record) => record.kind === 'background-object',
    ).length,
  } satisfies AppearanceBackgroundBootstrapResult;
}

export type AppearanceBackgroundBootstrapRuntimeResult =
  | AppearanceBackgroundBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
      objectCount: 0;
    };

export async function runAppearanceBackgroundBootstrapRuntime():
Promise<AppearanceBackgroundBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
      objectCount: 0,
    };
  }
  return runAppearanceBackgroundCaptureExclusive(async () => {
    const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
    const {
      prepareAppearanceBackgroundIndexRuntime,
    } = await import('./syncAppearanceBackgroundContentRuntime');
    const now = Date.now();
    const settingsRaw = await RawAsyncStorage.getItem(
      APPEARANCE_BACKGROUND_SETTINGS_KEY,
    );
    const previousIndex = parseAppearanceBackgroundLocalIndex(
      await RawAsyncStorage.getItem(APPEARANCE_BACKGROUND_INDEX_KEY),
    );
    let preparedRaw = JSON.stringify(previousIndex);
    return runAppearanceBackgroundBootstrap({
      identity: currentDevice.identity,
      state: syncBootstrapStatePort,
      buildProjection: async () => {
        const prepared = await prepareAppearanceBackgroundIndexRuntime({
          settingsRaw,
          previous: previousIndex,
          identity: currentDevice.identity,
          secrets: currentDevice.secrets,
          now,
        });
        preparedRaw = prepared.raw;
        return projectAppearanceBackground({
          settingsRaw,
          index: prepared.index,
        });
      },
      envelopeFactory: (entity) => createSyncMutationEnvelope({
        identity: currentDevice.identity,
        entity,
        state: syncMutationStatePort,
        randomUuid: expoSyncRandomUuidV1,
        now: () => now,
      }),
      capture: async ({ operationId, mutations }) => {
        await captureSyncMutationBatch({
          operationId,
          policy: APPEARANCE_BACKGROUND_BATCH_CAPTURE_POLICY,
          durableCapture: {
            prepareSyncDurableIntent,
            advanceSyncDurableIntent,
            enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
          },
          mutations,
          performBusinessWrite: () => RawAsyncStorage.setItem(
            APPEARANCE_BACKGROUND_INDEX_KEY,
            preparedRaw,
          ),
          now: () => now,
        });
      },
      now: () => now,
    });
  });
}
