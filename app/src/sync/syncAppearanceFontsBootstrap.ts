import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  APPEARANCE_FONTS_ADAPTER_ID,
} from './syncAppearanceFonts';
import {
  APPEARANCE_FONTS_BATCH_CAPTURE_POLICY,
} from './syncAppearanceFontsApply';
import {
  APPEARANCE_FONT_CHOICE_KEY,
  APPEARANCE_FONT_INDEX_KEY,
  deriveAppearanceFontMutations,
  parseAppearanceFontLocalIndex,
  projectAppearanceFonts,
  type AppearanceFontEnvelopeFactory,
  type AppearanceFontProjection,
} from './syncAppearanceFontsStorageDerivation';
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
  loadSyncEntityHeadOperations,
  syncMutationStatePort,
} from './syncMutationStateStore';
import type { PlainMutationV1 } from './syncProtocol';
import type { SyncDurableIntentState } from './syncRecoveryIntent';
import {
  advanceSyncDurableIntent,
  prepareSyncDurableIntent,
} from './syncStore';

export const APPEARANCE_FONTS_BOOTSTRAP_VERSION = 1 as const;

export type AppearanceFontsBootstrapStatePort = {
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

export type AppearanceFontsBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
  objectCount: number;
};

let captureQueue = Promise.resolve();

export function runAppearanceFontsCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = captureQueue.catch(() => undefined).then(callback);
  captureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

export async function runAppearanceFontsBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: AppearanceFontsBootstrapStatePort;
  buildProjection(): Promise<AppearanceFontProjection[]>;
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
  envelopeFactory: AppearanceFontEnvelopeFactory;
  now?: () => number;
}) {
  const stateInput = {
    adapterId: APPEARANCE_FONTS_ADAPTER_ID,
    version: APPEARANCE_FONTS_BOOTSTRAP_VERSION,
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
    } satisfies AppearanceFontsBootstrapResult;
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
    } satisfies AppearanceFontsBootstrapResult;
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
      objectCount: 0,
    } satisfies AppearanceFontsBootstrapResult;
  }
  const capturedAt = (input.now ?? Date.now)();
  const next = await input.buildProjection();
  const mutations = await deriveAppearanceFontMutations({
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
      (record) => record.kind === 'font-object',
    ).length,
  } satisfies AppearanceFontsBootstrapResult;
}

export type AppearanceFontsBootstrapRuntimeResult =
  | AppearanceFontsBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
      objectCount: 0;
    };

export async function runAppearanceFontsBootstrapRuntime():
Promise<AppearanceFontsBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
      objectCount: 0,
    };
  }
  return runAppearanceFontsCaptureExclusive(async () => {
    const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
    const {
      prepareAppearanceFontIndexRuntime,
    } = await import('./syncAppearanceFontsContentRuntime');
    const now = Date.now();
    const choiceRaw = await RawAsyncStorage.getItem(
      APPEARANCE_FONT_CHOICE_KEY,
    );
    const previousIndex = parseAppearanceFontLocalIndex(
      await RawAsyncStorage.getItem(APPEARANCE_FONT_INDEX_KEY),
    );
    let preparedIndex = previousIndex;
    let preparedRaw = JSON.stringify(previousIndex);
    return runAppearanceFontsBootstrap({
      identity: currentDevice.identity,
      state: syncBootstrapStatePort,
      buildProjection: async () => {
        const prepared = await prepareAppearanceFontIndexRuntime({
          choiceRaw,
          previous: previousIndex,
          identity: currentDevice.identity,
          secrets: currentDevice.secrets,
          now,
        });
        preparedIndex = prepared.index;
        preparedRaw = prepared.raw;
        return projectAppearanceFonts({
          choiceRaw,
          index: preparedIndex,
        });
      },
      envelopeFactory: async (entity) => ({
        ...await createSyncMutationEnvelope({
          identity: currentDevice.identity,
          entity,
          state: syncMutationStatePort,
          randomUuid: expoSyncRandomUuidV1,
          now: () => now,
        }),
        parentOperations:
          await loadSyncEntityHeadOperations(entity),
      }),
      capture: async ({ operationId, mutations }) => {
        await captureSyncMutationBatch({
          operationId,
          policy: APPEARANCE_FONTS_BATCH_CAPTURE_POLICY,
          durableCapture: {
            prepareSyncDurableIntent,
            advanceSyncDurableIntent,
            enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
          },
          mutations,
          performBusinessWrite: () => RawAsyncStorage.setItem(
            APPEARANCE_FONT_INDEX_KEY,
            preparedRaw,
          ),
          now: () => now,
        });
      },
      now: () => now,
    });
  });
}
