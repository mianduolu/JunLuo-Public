import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  APPEARANCE_WEATHER_ADAPTER_ID,
} from './syncAppearanceWeather';
import {
  APPEARANCE_WEATHER_BATCH_CAPTURE_POLICY,
} from './syncAppearanceWeatherApply';
import {
  APPEARANCE_WEATHER_ANIMATION_KEY,
  APPEARANCE_WEATHER_OBSERVATION_KEY,
  deriveAppearanceWeatherMutations,
  projectAppearanceWeather,
  type AppearanceWeatherEnvelopeFactory,
  type AppearanceWeatherProjection,
} from './syncAppearanceWeatherStorageDerivation';
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

export const APPEARANCE_WEATHER_BOOTSTRAP_VERSION = 1 as const;

export type AppearanceWeatherBootstrapStatePort = {
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

export type AppearanceWeatherBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
  observationCount: number;
};

let captureQueue = Promise.resolve();

export function runAppearanceWeatherCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = captureQueue.catch(() => undefined).then(callback);
  captureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

export async function runAppearanceWeatherBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: AppearanceWeatherBootstrapStatePort;
  buildProjection(): Promise<AppearanceWeatherProjection[]>;
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
  envelopeFactory: AppearanceWeatherEnvelopeFactory;
  now?: () => number;
}) {
  const stateInput = {
    adapterId: APPEARANCE_WEATHER_ADAPTER_ID,
    version: APPEARANCE_WEATHER_BOOTSTRAP_VERSION,
    sourceDeviceId: input.identity.deviceId,
  };
  const operationId = syncBootstrapOperationId(stateInput);
  const state = await input.state.load(stateInput);
  if (state.completed) {
    return {
      status: 'already-complete',
      operationId,
      mutationCount: 0,
      observationCount: 0,
    } satisfies AppearanceWeatherBootstrapResult;
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
      observationCount: 0,
    } satisfies AppearanceWeatherBootstrapResult;
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
      observationCount: 0,
    } satisfies AppearanceWeatherBootstrapResult;
  }
  const capturedAt = (input.now ?? Date.now)();
  const next = await input.buildProjection();
  const mutations = await deriveAppearanceWeatherMutations({
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
    observationCount: next.filter(
      (record) => record.kind === 'weather-observation',
    ).length,
  } satisfies AppearanceWeatherBootstrapResult;
}

export type AppearanceWeatherBootstrapRuntimeResult =
  | AppearanceWeatherBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
      observationCount: 0;
    };

export async function runAppearanceWeatherBootstrapRuntime():
Promise<AppearanceWeatherBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
      observationCount: 0,
    };
  }
  return runAppearanceWeatherCaptureExclusive(async () => {
    const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
    const now = Date.now();
    const [animationRaw, observationRaw] = await Promise.all([
      RawAsyncStorage.getItem(APPEARANCE_WEATHER_ANIMATION_KEY),
      RawAsyncStorage.getItem(APPEARANCE_WEATHER_OBSERVATION_KEY),
    ]);
    return runAppearanceWeatherBootstrap({
      identity: currentDevice.identity,
      state: syncBootstrapStatePort,
      buildProjection: async () => projectAppearanceWeather({
        animationRaw,
        observationRaw,
        now,
      }),
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
          policy: APPEARANCE_WEATHER_BATCH_CAPTURE_POLICY,
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
      now: () => now,
    });
  });
}
