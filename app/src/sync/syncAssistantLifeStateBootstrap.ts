import {
  ASSISTANT_LIFE_STATE_ADAPTER_ID,
} from './syncAssistantLifeState';
import {
  ASSISTANT_LIFE_STATE_FIXED_GLOBAL_KEYS,
  deriveAssistantLifeStateMutationsForStorageChanges,
  isAssistantLifeDayStorageKey,
  type AssistantLifeStateEnvelopeFactory,
} from './syncAssistantLifeStateStorageDerivation';
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

export const ASSISTANT_LIFE_STATE_BOOTSTRAP_VERSION = 1 as const;

export type AssistantLifeStateBootstrapStatePort = {
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

export type AssistantLifeStateBootstrapStoragePort = {
  getAllKeys(): Promise<readonly string[]>;
  multiGet(
    keys: readonly string[],
  ): Promise<readonly (readonly [string, string | null])[]>;
};

export type AssistantLifeStateBootstrapCapturePort = {
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
};

export type AssistantLifeStateBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
};

const emptyStorageReader = {
  getItem: async () => null,
};

export async function runAssistantLifeStateBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: AssistantLifeStateBootstrapStatePort;
  storage: AssistantLifeStateBootstrapStoragePort;
  capture: AssistantLifeStateBootstrapCapturePort;
  envelopeFactory: AssistantLifeStateEnvelopeFactory;
  now?: () => number;
}): Promise<AssistantLifeStateBootstrapResult> {
  const adapterId = ASSISTANT_LIFE_STATE_ADAPTER_ID;
  const version = ASSISTANT_LIFE_STATE_BOOTSTRAP_VERSION;
  const sourceDeviceId = input.identity.deviceId;
  const operationId = syncBootstrapOperationId({
    adapterId,
    version,
    sourceDeviceId,
  });
  const stateInput = {
    adapterId,
    version,
    sourceDeviceId,
  };
  const state = await input.state.load(stateInput);
  if (state.completed) {
    return {
      status: 'already-complete',
      operationId,
      mutationCount: 0,
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
    };
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
    };
  }

  const allKeys = await input.storage.getAllKeys();
  const dynamicDayKeys = allKeys.filter(isAssistantLifeDayStorageKey);
  const keys = [
    ...ASSISTANT_LIFE_STATE_FIXED_GLOBAL_KEYS,
    ...dynamicDayKeys,
  ].filter((key, index, values) => values.indexOf(key) === index);
  const values = await input.storage.multiGet(keys);
  const allowedKeys = new Set(keys);
  const seenKeys = new Set<string>();
  const changes = values.flatMap(([key, value]) => {
    if (!allowedKeys.has(key)) {
      throw new Error(`assistant.life-state bootstrap 返回未登记 key：${key}。`);
    }
    if (seenKeys.has(key)) {
      throw new Error(`assistant.life-state bootstrap 重复返回 key：${key}。`);
    }
    seenKeys.add(key);
    return value === null
      ? []
      : [{ kind: 'set' as const, key, value }];
  });
  const capturedAt = (input.now ?? Date.now)();
  const mutations = await deriveAssistantLifeStateMutationsForStorageChanges({
    changes,
    reader: emptyStorageReader,
    capturedAt,
    envelopeFactory: input.envelopeFactory,
  });
  if (mutations.length) {
    await input.capture.capture({
      operationId,
      mutations,
    });
  }
  await input.state.markCompleted({
    ...stateInput,
    updatedAt: capturedAt,
  });
  return {
    status: 'completed',
    operationId,
    mutationCount: mutations.length,
  };
}
