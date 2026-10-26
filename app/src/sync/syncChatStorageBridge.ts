import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  CHAT_CORE_BATCH_CAPTURE_POLICY,
} from './syncChatCoreApply';
import {
  runChatCoreCaptureExclusive,
} from './syncChatCoreCaptureQueue';
import {
  linkChatCoreMutationsToObjects,
} from './syncChatObjectLink';
import {
  deriveChatCoreMutationsForStorageChanges,
  assertPrimaryChatStorageChanges,
  CHAT_SESSIONS_KEY,
  CHAT_SESSION_MESSAGE_PREFIX,
  type ChatStorageChange,
} from './syncChatStorageDerivation';
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

export {
  deriveChatCoreMutationsForStorageChanges,
};
export type {
  ChatStorageBridgeEnvelopeFactory,
  ChatStorageBridgeReadPort,
  ChatStorageChange,
} from './syncChatStorageDerivation';

const PENDING_CHAT_CAPTURE_KEY =
  'junluo.sync.chatCorePendingCapture.v1';

type PendingChatCapture = {
  createdAt: number;
  changes: ChatStorageChange[];
  beforeEntries: Array<[string, string | null]>;
};

const durableCapture = {
  prepareSyncDurableIntent,
  advanceSyncDurableIntent,
  enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
};

function isChatSyncChange(change: ChatStorageChange) {
  return change.key === CHAT_SESSIONS_KEY
    || change.key.startsWith(CHAT_SESSION_MESSAGE_PREFIX);
}

async function loadPendingChatCaptures() {
  const raw = await RawAsyncStorage.getItem(PENDING_CHAT_CAPTURE_KEY);
  if (!raw) return [] as PendingChatCapture[];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('chat.core 待补寄记录格式无效。');
  }
  return parsed as PendingChatCapture[];
}

async function savePendingChatCaptures(
  pending: readonly PendingChatCapture[],
) {
  if (!pending.length) {
    await RawAsyncStorage.removeItem(PENDING_CHAT_CAPTURE_KEY);
    return;
  }
  await RawAsyncStorage.setItem(
    PENDING_CHAT_CAPTURE_KEY,
    JSON.stringify(pending),
  );
}

async function appendPendingChatCapture(
  changes: readonly ChatStorageChange[],
  beforeValues: ReadonlyMap<string, string | null>,
  createdAt: number,
) {
  const syncChanges = changes.filter(isChatSyncChange);
  if (!syncChanges.length) return;
  const pending = await loadPendingChatCaptures();
  pending.push({
    createdAt,
    changes: syncChanges.map((change) => ({ ...change })),
    beforeEntries: syncChanges.map((change) => [
      change.key,
      beforeValues.get(change.key) ?? null,
    ]),
  });
  await savePendingChatCaptures(pending);
}

async function deriveLinkedChatMutations(input: {
  changes: readonly ChatStorageChange[];
  reader: { getItem(key: string): Promise<string | null> };
  currentDevice: NonNullable<Awaited<ReturnType<typeof loadCurrentSyncDevice>>>;
  now: number;
}) {
  assertPrimaryChatStorageChanges(input.changes);
  const {
    expoSyncRandomUuidV1,
  } = await import('./syncCryptoExpo');
  const attachmentObjectIds = await import('./syncChatObjectCaptureRuntime')
    .then(({ captureChatObjectsForStorageChanges }) => (
      captureChatObjectsForStorageChanges({
        changes: input.changes,
        identity: input.currentDevice.identity,
        secrets: input.currentDevice.secrets,
        now: input.now,
      })
    ));
  const mutations = linkChatCoreMutationsToObjects(
    await deriveChatCoreMutationsForStorageChanges({
      changes: input.changes,
      reader: input.reader,
      deletedAt: input.now,
      envelopeFactory: (entity) => createSyncMutationEnvelope({
        identity: input.currentDevice.identity,
        entity,
        state: syncMutationStatePort,
        randomUuid: expoSyncRandomUuidV1,
        now: () => input.now,
      }),
    }),
    attachmentObjectIds,
  );
  return { mutations, randomUuid: expoSyncRandomUuidV1 };
}

async function flushPendingChatCapturesLocked(
  currentDevice: NonNullable<Awaited<ReturnType<typeof loadCurrentSyncDevice>>>,
) {
  const pending = await loadPendingChatCaptures();
  while (pending.length) {
    const next = pending[0];
    const beforeValues = new Map(next.beforeEntries);
    const { mutations } = await deriveLinkedChatMutations({
      changes: next.changes,
      reader: {
        getItem: async (key) => beforeValues.get(key) ?? null,
      },
      currentDevice,
      now: next.createdAt,
    });
    for (const mutation of mutations) {
      if (!CHAT_CORE_BATCH_CAPTURE_POLICY.isMutationAllowed(mutation)) {
        throw new Error('chat.core 待补寄记录生成了不允许的 mutation。');
      }
      await enqueueSyncMutationAndAdvanceHeads(mutation);
    }
    pending.shift();
    await savePendingChatCaptures(pending);
  }
}

export async function flushPendingChatStorageSyncCapture() {
  return runChatCoreCaptureExclusive(async () => {
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) return;
    await flushPendingChatCapturesLocked(currentDevice);
  });
}

async function performCapturedStorageChange<T>(
  changes: readonly ChatStorageChange[],
  performBusinessWrite: () => Promise<T>,
  capture: boolean,
) {
  assertPrimaryChatStorageChanges(changes);
  if (!capture) return performBusinessWrite();
  return runChatCoreCaptureExclusive(async () => {
    let localWriteStarted = false;
    let localWriteResult: { value: T } | undefined;
    const beforeValues = new Map<string, string | null>();
    let beforeReads: Promise<void>[] = [];
    let currentDevice:
      | Awaited<ReturnType<typeof loadCurrentSyncDevice>>
      | undefined;
    const writeLocally = async () => {
      localWriteStarted = true;
      const value = await performBusinessWrite();
      localWriteResult = { value };
      return value;
    };

    try {
      currentDevice = await loadCurrentSyncDevice();
      if (!currentDevice) return writeLocally();
      beforeReads = changes.filter(isChatSyncChange).map(async (change) => {
        beforeValues.set(
          change.key,
          await RawAsyncStorage.getItem(change.key),
        );
      });
      await Promise.all(beforeReads);
      await flushPendingChatCapturesLocked(currentDevice);
      const now = Date.now();
      const { mutations, randomUuid } = await deriveLinkedChatMutations({
        changes,
        reader: {
          getItem: async (key) => (
            beforeValues.has(key)
              ? beforeValues.get(key) ?? null
              : RawAsyncStorage.getItem(key)
          ),
        },
        currentDevice,
        now,
      });
      if (!mutations.length) return writeLocally();
      await captureSyncMutationBatch({
        operationId: randomUuid(),
        policy: CHAT_CORE_BATCH_CAPTURE_POLICY,
        durableCapture,
        mutations,
        performBusinessWrite: async () => {
          await writeLocally();
        },
        now: () => now,
      });
      return localWriteResult!.value;
    } catch (error) {
      if (localWriteResult) {
        console.warn('[sync-chat-storage] sync capture failed after local chat write', error);
        return localWriteResult.value;
      }
      if (localWriteStarted) throw error;
      if (currentDevice) {
        await Promise.allSettled(beforeReads);
        // A missing snapshot is unknown, not an empty record. Preserve it before overwriting locally.
        await Promise.all(changes.filter(isChatSyncChange).filter((change) => !beforeValues.has(change.key))
          .map(async (change) => beforeValues.set(change.key, await RawAsyncStorage.getItem(change.key))));
      }
      console.warn('[sync-chat-storage] sync capture unavailable; keeping local chat write', error);
      const value = await performBusinessWrite();
      if (currentDevice) {
        try {
          await appendPendingChatCapture(changes, beforeValues, Date.now());
        } catch (pendingError) {
          console.warn('[sync-chat-storage] could not record chat changes for later sync', pendingError);
        }
      }
      return value;
    }
  });
}

function createChatStorageSyncBridge(capture: boolean) {
  return {
    getItem: (key: string) => RawAsyncStorage.getItem(key),
    multiGet: (keys: readonly string[]) => RawAsyncStorage.multiGet(keys),
    setItem: (key: string, value: string) => performCapturedStorageChange(
      [{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value),
      capture,
    ),
    multiSet: (entries: readonly (readonly [string, string])[]) => {
      const writableEntries = entries.map(([key, value]) => [key, value] as [string, string]);
      return performCapturedStorageChange(
        writableEntries.map(([key, value]) => ({ kind: 'set' as const, key, value })),
        () => RawAsyncStorage.multiSet(writableEntries),
        capture,
      );
    },
    removeItem: (key: string) => performCapturedStorageChange(
      [{ kind: 'remove', key }],
      () => RawAsyncStorage.removeItem(key),
      capture,
    ),
    multiRemove: (keys: readonly string[]) => {
      const writableKeys = [...keys];
      return performCapturedStorageChange(
        writableKeys.map((key) => ({ kind: 'remove' as const, key })),
        () => RawAsyncStorage.multiRemove(writableKeys),
        capture,
      );
    },
  };
}

export const chatStorageSyncBridge = createChatStorageSyncBridge(true);
// Replay origin belongs to each write, never to a process-wide async scope.
export const chatStorageSyncReplayBridge = createChatStorageSyncBridge(false);
