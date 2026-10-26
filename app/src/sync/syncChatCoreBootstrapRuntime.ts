import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  runChatCoreBootstrap,
  type ChatCoreBootstrapResult,
} from './syncChatCoreBootstrap';
import {
  CHAT_CORE_BATCH_CAPTURE_POLICY,
} from './syncChatCoreApply';
import {
  captureChatObjectsForStorageChanges,
} from './syncChatObjectCaptureRuntime';
import {
  runChatCoreCaptureExclusive,
} from './syncChatCoreCaptureQueue';
import type {
  ChatStorageChange,
} from './syncChatStorageDerivation';
import {
  CHAT_SESSIONS_KEY,
  CHAT_SESSION_MESSAGE_PREFIX,
  deriveLegacyChatMessageStorageChanges,
} from './syncChatStorageDerivation';
import {
  syncBootstrapStatePort,
} from './syncBootstrapState';
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

export async function loadChatCoreBootstrapChanges() {
  const allKeys = await RawAsyncStorage.getAllKeys();
  const messageKeys = allKeys
    .filter((key) => key.startsWith(CHAT_SESSION_MESSAGE_PREFIX))
    .sort();
  const keys = [CHAT_SESSIONS_KEY, ...messageKeys];
  const entries = await RawAsyncStorage.multiGet(keys);
  const values = new Map(entries);
  const sessionsRaw = values.get(CHAT_SESSIONS_KEY) ?? null;
  const byKey = new Map<string, ChatStorageChange>();
  if (sessionsRaw !== null) {
    byKey.set(CHAT_SESSIONS_KEY, {
      kind: 'set',
      key: CHAT_SESSIONS_KEY,
      value: sessionsRaw,
    });
  }
  for (const change of deriveLegacyChatMessageStorageChanges(sessionsRaw)) {
    byKey.set(change.key, change);
  }
  for (const key of messageKeys) {
    const value = values.get(key);
    if (value === null || value === undefined) continue;
    byKey.set(key, { kind: 'set', key, value });
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export type ChatCoreBootstrapRuntimeResult =
  | ChatCoreBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
      objectCount: 0;
    };

export async function runChatCoreBootstrapRuntime():
Promise<ChatCoreBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
      objectCount: 0,
    };
  }
  return runChatCoreCaptureExclusive(async () => {
    const {
      expoSyncRandomUuidV1,
    } = await import('./syncCryptoExpo');
    const now = Date.now();
    return runChatCoreBootstrap({
      identity: currentDevice.identity,
      state: syncBootstrapStatePort,
      loadChanges: loadChatCoreBootstrapChanges,
      prepareObjects: (changes) => captureChatObjectsForStorageChanges({
        changes,
        identity: currentDevice.identity,
        secrets: currentDevice.secrets,
        now,
      }),
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
          policy: CHAT_CORE_BATCH_CAPTURE_POLICY,
          durableCapture,
          mutations,
          performBusinessWrite: async () => undefined,
          now: () => now,
        });
      },
      now: () => now,
    });
  });
}
