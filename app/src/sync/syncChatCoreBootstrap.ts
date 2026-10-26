import {
  CHAT_CORE_BATCH_CAPTURE_POLICY,
} from './syncChatCoreApply';
import {
  linkChatCoreMutationsToObjects,
} from './syncChatObjectLink';
import {
  deriveChatCoreMutationsForStorageChanges,
  assertPrimaryChatStorageChanges,
  type ChatStorageBridgeEnvelopeFactory,
  type ChatStorageChange,
} from './syncChatStorageDerivation';
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

export const CHAT_CORE_BOOTSTRAP_VERSION = 1 as const;

export type ChatCoreBootstrapStatePort = {
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

export type ChatCoreBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
  objectCount: number;
};

const emptyStorageReader = {
  getItem: async () => null,
};

export async function runChatCoreBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: ChatCoreBootstrapStatePort;
  loadChanges(): Promise<ChatStorageChange[]>;
  prepareObjects(changes: readonly ChatStorageChange[]): Promise<Readonly<Record<string, string>>>;
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
  envelopeFactory: ChatStorageBridgeEnvelopeFactory;
  now?: () => number;
}): Promise<ChatCoreBootstrapResult> {
  const adapterId = CHAT_CORE_BATCH_CAPTURE_POLICY.adapterId;
  const version = CHAT_CORE_BOOTSTRAP_VERSION;
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

  const changes = await input.loadChanges();
  assertPrimaryChatStorageChanges(changes);
  const duplicateKeys = changes
    .map((change) => change.key)
    .filter((key, index, keys) => keys.indexOf(key) !== index);
  if (duplicateKeys.length) {
    throw new Error(`chat.core bootstrap 返回重复 key：${duplicateKeys[0]}。`);
  }
  const capturedAt = (input.now ?? Date.now)();
  const attachmentObjectIds = await input.prepareObjects(changes);
  const mutations = linkChatCoreMutationsToObjects(
    await deriveChatCoreMutationsForStorageChanges({
      changes,
      reader: emptyStorageReader,
      deletedAt: capturedAt,
      envelopeFactory: input.envelopeFactory,
    }),
    attachmentObjectIds,
  );
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
    objectCount: new Set(Object.values(attachmentObjectIds)).size,
  };
}
