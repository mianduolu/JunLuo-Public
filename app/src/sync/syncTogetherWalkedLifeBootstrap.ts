import {
  TOGETHER_WALKED_LIFE_ADAPTER_ID,
} from './syncTogetherWalkedLife';
import {
  syncBootstrapOperationId,
} from './syncBootstrapContract';
import type {
  SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type {
  SyncDurableIntentState,
} from './syncRecoveryIntent';
import type {
  PlainMutationV1,
} from './syncProtocol';
import type {
  TogetherWalkedLifeLocalIndex,
} from './syncTogetherWalkedLifeStorageDerivation';

export const TOGETHER_WALKED_LIFE_BOOTSTRAP_VERSION = 1 as const;

export type TogetherWalkedLifeBootstrapStatePort = {
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

export type TogetherWalkedLifeBootstrapCapturePort = {
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
    index: TogetherWalkedLifeLocalIndex;
  }): Promise<void>;
};

export type TogetherWalkedLifeBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
  objectCount: number;
};

export async function runTogetherWalkedLifeBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: TogetherWalkedLifeBootstrapStatePort;
  build(): Promise<{
    mutations: PlainMutationV1[];
    index: TogetherWalkedLifeLocalIndex;
  }>;
  capture: TogetherWalkedLifeBootstrapCapturePort;
  now?: () => number;
}): Promise<TogetherWalkedLifeBootstrapResult> {
  const adapterId = TOGETHER_WALKED_LIFE_ADAPTER_ID;
  const version = TOGETHER_WALKED_LIFE_BOOTSTRAP_VERSION;
  const sourceDeviceId = input.identity.deviceId;
  const operationId = syncBootstrapOperationId({
    adapterId,
    version,
    sourceDeviceId,
  });
  const stateInput = { adapterId, version, sourceDeviceId };
  const state = await input.state.load(stateInput);
  if (state.completed) {
    return {
      status: 'already-complete',
      operationId,
      mutationCount: 0,
      objectCount: 0,
    };
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
    };
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
      objectCount: 0,
    };
  }
  const built = await input.build();
  if (built.mutations.length || built.index.objects.length) {
    await input.capture.capture({
      operationId,
      mutations: built.mutations,
      index: built.index,
    });
  }
  await input.state.markCompleted({
    ...stateInput,
    updatedAt: (input.now ?? Date.now)(),
  });
  return {
    status: 'completed',
    operationId,
    mutationCount: built.mutations.length,
    objectCount: built.index.objects.length,
  };
}
