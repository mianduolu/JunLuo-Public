import type {
  SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  MEMORY_EXPERIENCE_ADAPTER_ID,
} from './syncMemoryExperience';
import {
  MEMORY_EXPERIENCE_GLOBAL_KEYS,
  MEMORY_EXPERIENCE_KEYS,
  deriveMemoryExperienceMutationsForStorageChanges,
  type MemoryExperienceEnvelopeFactory,
} from './syncMemoryExperienceStorageDerivation';
import {
  syncBootstrapOperationId,
} from './syncBootstrapContract';
import type {
  SyncDurableIntentState,
} from './syncRecoveryIntent';
import type {
  PlainMutationV1,
} from './syncProtocol';

export const MEMORY_EXPERIENCE_BOOTSTRAP_VERSION = 2 as const;

export type MemoryExperienceBootstrapStatePort = {
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

export type MemoryExperienceBootstrapStoragePort = {
  multiGet(
    keys: readonly string[],
  ): Promise<readonly (readonly [string, string | null])[]>;
};

export type MemoryExperienceBootstrapCapturePort = {
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
};

export type MemoryExperienceBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
};

const emptyStorageReader = {
  getItem: async () => null,
};

export async function runMemoryExperienceBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: MemoryExperienceBootstrapStatePort;
  storage: MemoryExperienceBootstrapStoragePort;
  capture: MemoryExperienceBootstrapCapturePort;
  envelopeFactory: MemoryExperienceEnvelopeFactory;
  now?: () => number;
}): Promise<MemoryExperienceBootstrapResult> {
  const adapterId = MEMORY_EXPERIENCE_ADAPTER_ID;
  const version = MEMORY_EXPERIENCE_BOOTSTRAP_VERSION;
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

  const previous = await input.state.load({ ...stateInput, version: 1 });
  const keys = previous.completed ? [MEMORY_EXPERIENCE_KEYS.postRuntime, MEMORY_EXPERIENCE_KEYS.postNoticeRead] : MEMORY_EXPERIENCE_GLOBAL_KEYS;
  const values = await input.storage.multiGet(keys);
  const allowedKeys = new Set<string>(keys);
  const seenKeys = new Set<string>();
  const changes = values.flatMap(([key, value]) => {
    if (!allowedKeys.has(key)) {
      throw new Error(`memory.experience bootstrap 返回未登记 key：${key}。`);
    }
    if (seenKeys.has(key)) {
      throw new Error(`memory.experience bootstrap 重复返回 key：${key}。`);
    }
    seenKeys.add(key);
    return value === null
      ? []
      : [{ kind: 'set' as const, key, value }];
  });
  const capturedAt = (input.now ?? Date.now)();
  const mutations = await deriveMemoryExperienceMutationsForStorageChanges({
    changes,
    reader: emptyStorageReader,
    deletedAt: capturedAt,
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
