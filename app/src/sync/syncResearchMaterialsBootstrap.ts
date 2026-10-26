import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  RESEARCH_MATERIALS_ADAPTER_ID,
} from './syncResearchMaterials';
import {
  RESEARCH_MATERIALS_BATCH_CAPTURE_POLICY,
} from './syncResearchMaterialsApply';
import {
  RESEARCH_MATERIALS_MOBILE_CACHE_PREFIX,
  deriveMobileResearchMaterialMutations,
  projectMobileResearchMaterials,
  type ResearchMaterialsEnvelopeFactory,
} from './syncResearchMaterialsStorageDerivation';
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

export const RESEARCH_MATERIALS_BOOTSTRAP_VERSION = 1 as const;

export type ResearchMaterialsBootstrapStatePort = {
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

export type ResearchMaterialsBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
  networkMaterialCount: number;
};

let captureQueue = Promise.resolve();

export function runResearchMaterialsCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = captureQueue.catch(() => undefined).then(callback);
  captureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

export async function runResearchMaterialsBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: ResearchMaterialsBootstrapStatePort;
  buildEntries(): Promise<readonly (
    readonly [string, string | null]
  )[]>;
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
  envelopeFactory: ResearchMaterialsEnvelopeFactory;
  now?: () => number;
}) {
  const stateInput = {
    adapterId: RESEARCH_MATERIALS_ADAPTER_ID,
    version: RESEARCH_MATERIALS_BOOTSTRAP_VERSION,
    sourceDeviceId: input.identity.deviceId,
  };
  const operationId = syncBootstrapOperationId(stateInput);
  const state = await input.state.load(stateInput);
  if (state.completed) {
    return {
      status: 'already-complete',
      operationId,
      mutationCount: 0,
      networkMaterialCount: 0,
    } satisfies ResearchMaterialsBootstrapResult;
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
      networkMaterialCount: 0,
    } satisfies ResearchMaterialsBootstrapResult;
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
      networkMaterialCount: 0,
    } satisfies ResearchMaterialsBootstrapResult;
  }
  const capturedAt = (input.now ?? Date.now)();
  const next = projectMobileResearchMaterials(
    await input.buildEntries(),
  );
  const mutations = await deriveMobileResearchMaterialMutations({
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
    networkMaterialCount: next.length,
  } satisfies ResearchMaterialsBootstrapResult;
}

export type ResearchMaterialsBootstrapRuntimeResult =
  | ResearchMaterialsBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
      networkMaterialCount: 0;
    };

export async function runResearchMaterialsBootstrapRuntime():
Promise<ResearchMaterialsBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
      networkMaterialCount: 0,
    };
  }
  return runResearchMaterialsCaptureExclusive(async () => {
    const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
    const now = Date.now();
    return runResearchMaterialsBootstrap({
      identity: currentDevice.identity,
      state: syncBootstrapStatePort,
      buildEntries: async () => {
        const keys = (await RawAsyncStorage.getAllKeys())
          .filter((key) => key.startsWith(
            RESEARCH_MATERIALS_MOBILE_CACHE_PREFIX,
          ));
        return RawAsyncStorage.multiGet(keys);
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
          policy: RESEARCH_MATERIALS_BATCH_CAPTURE_POLICY,
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
