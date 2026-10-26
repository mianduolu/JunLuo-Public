import type {
  ChatSession,
} from '../chat/chatStorage';
import {
  expoSyncRandomUuidV1,
} from './syncCryptoExpo';
import {
  CHAT_CORE_BATCH_CAPTURE_POLICY,
} from './syncChatCoreApply';
import {
  planChatCoreStateMutations,
} from './syncChatCoreCapturePlan';
import {
  loadCurrentSyncDevice,
} from './syncCurrentDevice';
import {
  captureSyncMutationBatch,
} from './syncMutationBatchCapture';
import {
  createSyncMutationEnvelope,
} from './syncMutationEnvelope';
import {
  enqueueSyncMutationAndAdvanceHeads,
  syncMutationStatePort,
} from './syncMutationStateStore';
import {
  advanceSyncDurableIntent,
  prepareSyncDurableIntent,
} from './syncStore';

const durableCapture = {
  prepareSyncDurableIntent,
  advanceSyncDurableIntent,
  enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
};

export async function captureChatCoreStateWrite<T>(input: {
  beforeSessions: readonly ChatSession[];
  afterSessions: readonly ChatSession[];
  performBusinessWrite(): Promise<T>;
  attachmentObjectIds?: Readonly<Record<string, string>>;
  deletedAt?: number;
}) {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      value: await input.performBusinessWrite(),
      captured: false,
      mutationCount: 0,
    };
  }
  const deletedAt = input.deletedAt ?? Date.now();
  const mutations = await planChatCoreStateMutations({
    beforeSessions: input.beforeSessions,
    afterSessions: input.afterSessions,
    attachmentObjectIds: input.attachmentObjectIds,
    envelopeFactory: (entity) => createSyncMutationEnvelope({
      identity: currentDevice.identity,
      entity,
      state: syncMutationStatePort,
      randomUuid: expoSyncRandomUuidV1,
    }),
  });
  if (!mutations.length) {
    return {
      value: await input.performBusinessWrite(),
      captured: false,
      mutationCount: 0,
    };
  }
  const operationId = expoSyncRandomUuidV1();
  let value!: T;
  await captureSyncMutationBatch({
    operationId,
    policy: CHAT_CORE_BATCH_CAPTURE_POLICY,
    durableCapture,
    mutations,
    performBusinessWrite: async () => {
      value = await input.performBusinessWrite();
    },
    now: () => deletedAt,
  });
  return {
    value,
    captured: true,
    mutationCount: mutations.length,
  };
}
