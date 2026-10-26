import {
  FOCUS_SEMANTIC_ADAPTER_ID,
} from './syncFocusSemantic';
import {
  deriveFocusSemanticMutationsForStorageChanges,
  FOCUS_SEMANTIC_GLOBAL_STORAGE_KEYS,
  FOCUS_TAGS_STORAGE_KEY,
  type FocusSemanticEnvelopeFactory,
} from './syncFocusSemanticStorageDerivation';
import { syncBootstrapOperationId } from './syncBootstrapContract';
import type { SyncDevicePublicIdentityV1 } from './syncDeviceContract';
import type { SyncDurableIntentState } from './syncRecoveryIntent';
import type { PlainMutationV1 } from './syncProtocol';

export const FOCUS_SEMANTIC_STORAGE_BOOTSTRAP_VERSION = 2 as const;

export type FocusSemanticBootstrapStatePort = {
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

export type FocusSemanticBootstrapStoragePort = {
  multiGet(
    keys: readonly string[],
  ): Promise<readonly (readonly [string, string | null])[]>;
};

export type FocusSemanticBootstrapCapturePort = {
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
};

export type FocusSemanticStorageBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
};

const emptyStorageReader = {
  getItem: async () => null,
};

type FocusSemanticStorageBootstrapInput = {
  identity: SyncDevicePublicIdentityV1;
  state: FocusSemanticBootstrapStatePort;
  storage: FocusSemanticBootstrapStoragePort;
  capture: FocusSemanticBootstrapCapturePort;
  envelopeFactory: FocusSemanticEnvelopeFactory;
  now?: () => number;
};

async function runStorageBootstrapVersion(input: FocusSemanticStorageBootstrapInput,
  version: number, keys: readonly string[]): Promise<FocusSemanticStorageBootstrapResult> {
  const adapterId = FOCUS_SEMANTIC_ADAPTER_ID;
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
  const entries = await input.storage.multiGet(
    keys,
  );
  const allowed = new Set<string>(keys);
  const seen = new Set<string>();
  const changes = entries.flatMap(([key, value]) => {
    if (!allowed.has(key)) {
      throw new Error(`focus.semantic bootstrap 返回未登记 key：${key}。`);
    }
    if (seen.has(key)) {
      throw new Error(`focus.semantic bootstrap 重复返回 key：${key}。`);
    }
    seen.add(key);
    return value === null
      ? []
      : [{ kind: 'set' as const, key, value }];
  });
  const capturedAt = (input.now ?? Date.now)();
  const mutations =
    await deriveFocusSemanticMutationsForStorageChanges({
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

export async function runFocusSemanticStorageBootstrap(input: FocusSemanticStorageBootstrapInput):
Promise<FocusSemanticStorageBootstrapResult> {
  // Keep the original v1 completion and recovery operation intact. The additive
  // v2 snapshot covers only tags, never recapturing accepted active/invite/policy.
  const original = await runStorageBootstrapVersion(input, 1,
    FOCUS_SEMANTIC_GLOBAL_STORAGE_KEYS.filter(key => key !== FOCUS_TAGS_STORAGE_KEY));
  if (original.status === 'pending-recovery') return original;
  const tags = await runStorageBootstrapVersion(input, FOCUS_SEMANTIC_STORAGE_BOOTSTRAP_VERSION,
    [FOCUS_TAGS_STORAGE_KEY]);
  return { ...tags, mutationCount: original.mutationCount + tags.mutationCount };
}
