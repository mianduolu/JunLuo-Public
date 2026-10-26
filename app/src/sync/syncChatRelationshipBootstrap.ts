import type {
  SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  CHAT_RELATIONSHIP_BATCH_CAPTURE_POLICY,
} from './syncChatRelationshipApply';
import {
  CHAT_RELATIONSHIP_KEYS,
  deriveChatRelationshipMutationsForStorageChanges,
  type ChatRelationshipEnvelopeFactory,
} from './syncChatRelationshipStorageDerivation';
import {
  syncBootstrapOperationId,
} from './syncBootstrapContract';
import type {
  SyncDurableIntentState,
} from './syncRecoveryIntent';
import type {
  PlainMutationV1,
} from './syncProtocol';

export const CHAT_RELATIONSHIP_BOOTSTRAP_VERSION = 1 as const;

export const CHAT_RELATIONSHIP_BOOTSTRAP_KEYS = Object.freeze([
  CHAT_RELATIONSHIP_KEYS.favorites,
  CHAT_RELATIONSHIP_KEYS.likedStyleReferences,
  CHAT_RELATIONSHIP_KEYS.preferences,
  CHAT_RELATIONSHIP_KEYS.keywordCounters,
  CHAT_RELATIONSHIP_KEYS.notebook,
  CHAT_RELATIONSHIP_KEYS.sleepState,
] as const);

export type ChatRelationshipBootstrapStatePort = {
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

export type ChatRelationshipBootstrapStoragePort = {
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
};

export type ChatRelationshipBootstrapCapturePort = {
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
};

export type ChatRelationshipBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
};

const emptyStorageReader = {
  getItem: async () => null,
};

export async function runChatRelationshipBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: ChatRelationshipBootstrapStatePort;
  storage: ChatRelationshipBootstrapStoragePort;
  capture: ChatRelationshipBootstrapCapturePort;
  envelopeFactory: ChatRelationshipEnvelopeFactory;
  now?: () => number;
}): Promise<ChatRelationshipBootstrapResult> {
  const adapterId = CHAT_RELATIONSHIP_BATCH_CAPTURE_POLICY.adapterId;
  const version = CHAT_RELATIONSHIP_BOOTSTRAP_VERSION;
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

  const values = await input.storage.multiGet(CHAT_RELATIONSHIP_BOOTSTRAP_KEYS);
  const allowedKeys = new Set<string>(CHAT_RELATIONSHIP_BOOTSTRAP_KEYS);
  const seenKeys = new Set<string>();
  const changes = values.flatMap(([key, value]) => {
    if (!allowedKeys.has(key)) {
      throw new Error(`chat.relationship-state bootstrap 返回未登记 key：${key}。`);
    }
    if (seenKeys.has(key)) {
      throw new Error(`chat.relationship-state bootstrap 重复返回 key：${key}。`);
    }
    seenKeys.add(key);
    return value === null ? [] : [{ kind: 'set' as const, key, value }];
  });
  const capturedAt = (input.now ?? Date.now)();
  const mutations = await deriveChatRelationshipMutationsForStorageChanges({
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
