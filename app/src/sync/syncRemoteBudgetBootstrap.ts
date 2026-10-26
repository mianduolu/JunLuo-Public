import { REMOTE_BUDGET_ADAPTER_ID } from './syncRemoteBudget';
import {
  deriveRemoteBudgetMutationsForStorageChanges,
  REMOTE_BUDGET_GLOBAL_KEYS,
  type RemoteBudgetEnvelopeFactory,
} from './syncRemoteBudgetStorageDerivation';
import { syncBootstrapOperationId } from './syncBootstrapContract';
import type { SyncDevicePublicIdentityV1 } from './syncDeviceContract';
import type { SyncDurableIntentState } from './syncRecoveryIntent';
import type { PlainMutationV1 } from './syncProtocol';

export const REMOTE_BUDGET_BOOTSTRAP_VERSION = 1 as const;

export type RemoteBudgetBootstrapStatePort = {
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

export type RemoteBudgetBootstrapStoragePort = {
  multiGet(
    keys: readonly string[],
  ): Promise<readonly (readonly [string, string | null])[]>;
};

export type RemoteBudgetBootstrapCapturePort = {
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
};

export type RemoteBudgetBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
};

const emptyStorageReader = {
  getItem: async () => null,
};

export async function runRemoteBudgetBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: RemoteBudgetBootstrapStatePort;
  storage: RemoteBudgetBootstrapStoragePort;
  capture: RemoteBudgetBootstrapCapturePort;
  envelopeFactory: RemoteBudgetEnvelopeFactory;
  now?: () => number;
}): Promise<RemoteBudgetBootstrapResult> {
  const adapterId = REMOTE_BUDGET_ADAPTER_ID;
  const version = REMOTE_BUDGET_BOOTSTRAP_VERSION;
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
  const entries = await input.storage.multiGet(REMOTE_BUDGET_GLOBAL_KEYS);
  const allowed = new Set<string>(REMOTE_BUDGET_GLOBAL_KEYS);
  const seen = new Set<string>();
  const changes = entries.flatMap(([key, value]) => {
    if (!allowed.has(key)) {
      throw new Error(
        `usage.remote-budget bootstrap 返回未登记 key：${key}。`,
      );
    }
    if (seen.has(key)) {
      throw new Error(
        `usage.remote-budget bootstrap 重复返回 key：${key}。`,
      );
    }
    seen.add(key);
    return value === null
      ? []
      : [{ kind: 'set' as const, key, value }];
  });
  const capturedAt = (input.now ?? Date.now)();
  const mutations = await deriveRemoteBudgetMutationsForStorageChanges({
    changes,
    reader: emptyStorageReader,
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
  };
}
