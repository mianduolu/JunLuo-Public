import {
  CURRENT_SNAPSHOT_MODE,
} from './syncCurrentSnapshot';
import type {
  ChatStorageBridgeEnvelopeFactory,
  ChatStorageChange,
} from './syncChatStorageDerivation';
import {
  CHAT_SESSIONS_KEY,
  CHAT_SESSION_MESSAGE_PREFIX,
  deriveChatCoreMutationsForStorageChanges,
  deriveLegacyChatMessageStorageChanges,
} from './syncChatStorageDerivation';
import type {
  CurrentSnapshotMutationSourceV1,
} from './syncNewWorldBaseline';
import type {
  PlainMutationV1,
} from './syncProtocol';

const CHAT_CORE_STORAGE_READ_LIMIT = 20;

type ChatCoreCurrentSnapshotStoragePort = Readonly<{
  getAllKeys(): Promise<readonly string[]>;
  getItem(key: string): Promise<string | null>;
  multiGet(keys: readonly string[]): Promise<readonly [string, string | null][]>;
}>;

type ChatCoreCursor =
  | Readonly<{ phase: 'sessions'; mutationOffset: number }>
  | Readonly<{
      phase: 'messages';
      keyIndex: number;
      mutationOffset: number;
    }>;

type ChatCoreSnapshotIndex = Readonly<{
  sessionsRaw: string | null;
  legacyByKey: ReadonlyMap<string, ChatStorageChange>;
  splitKeys: readonly string[];
  splitKeySet: ReadonlySet<string>;
  messageKeys: readonly string[];
}>;

function parseNonNegativeInteger(value: string, label: string) {
  if (!/^(0|[1-9]\d{0,8})$/u.test(value)) {
    throw new Error(`chat.core current snapshot ${label} is invalid`);
  }
  return Number(value);
}

function parseCursor(pageToken: string | null): ChatCoreCursor {
  if (pageToken === null) return { phase: 'sessions', mutationOffset: 0 };
  const parts = pageToken.split(':');
  if (parts.length === 2 && parts[0] === 's') {
    return {
      phase: 'sessions',
      mutationOffset: parseNonNegativeInteger(parts[1], 'session offset'),
    };
  }
  if (parts.length === 3 && parts[0] === 'm') {
    return {
      phase: 'messages',
      keyIndex: parseNonNegativeInteger(parts[1], 'message key index'),
      mutationOffset: parseNonNegativeInteger(parts[2], 'message offset'),
    };
  }
  throw new Error('chat.core current snapshot page token is invalid');
}

function sessionsToken(mutationOffset: number) {
  return `s:${mutationOffset}`;
}

function messagesToken(keyIndex: number, mutationOffset: number) {
  return `m:${keyIndex}:${mutationOffset}`;
}

const emptyStorageReader = {
  getItem: async () => null,
};

async function deriveChanges(input: {
  changes: readonly ChatStorageChange[];
  capturedAt: number;
  createEnvelopeFactory(): ChatStorageBridgeEnvelopeFactory;
}) {
  return deriveChatCoreMutationsForStorageChanges({
    changes: input.changes,
    reader: emptyStorageReader,
    deletedAt: input.capturedAt,
    envelopeFactory: input.createEnvelopeFactory(),
  });
}

export function createChatCoreCurrentSnapshotSource(input: {
  storage: ChatCoreCurrentSnapshotStoragePort;
  capturedAt: number;
  createEnvelopeFactory(): ChatStorageBridgeEnvelopeFactory;
}): CurrentSnapshotMutationSourceV1 {
  let snapshotIndex: Promise<ChatCoreSnapshotIndex> | null = null;
  const loadSnapshotIndex = () => {
    if (!snapshotIndex) {
      const loading = Promise.all([
        input.storage.getItem(CHAT_SESSIONS_KEY),
        input.storage.getAllKeys(),
      ]).then(([sessionsRaw, allKeys]) => {
        const legacyChanges = deriveLegacyChatMessageStorageChanges(sessionsRaw);
        const legacyByKey = new Map(
          legacyChanges.map((change) => [change.key, change]),
        );
        const splitKeys = allKeys
          .filter((key) => key.startsWith(CHAT_SESSION_MESSAGE_PREFIX))
          .sort();
        return Object.freeze({
          sessionsRaw,
          legacyByKey,
          splitKeys: Object.freeze(splitKeys),
          splitKeySet: new Set(splitKeys),
          messageKeys: Object.freeze([...new Set([
            ...legacyByKey.keys(),
            ...splitKeys,
          ])].sort()),
        });
      });
      const retryable = loading.catch((error) => {
        if (snapshotIndex === retryable) snapshotIndex = null;
        throw error;
      });
      snapshotIndex = retryable;
    }
    return snapshotIndex;
  };
  return Object.freeze({
    adapterId: 'chat.core',
    readMutationPage: async ({ mode, pageToken, limit }: {
      mode: typeof CURRENT_SNAPSHOT_MODE;
      pageToken: string | null;
      limit: number;
    }) => {
      if (mode !== CURRENT_SNAPSHOT_MODE) {
        throw new Error('chat.core current snapshot received an unknown mode');
      }
      let cursor = parseCursor(pageToken);
      const mutations: PlainMutationV1[] = [];
      const {
        sessionsRaw,
        legacyByKey,
        splitKeys,
        splitKeySet,
        messageKeys,
      } = await loadSnapshotIndex();

      const finishPage = (
        pageMutations: readonly PlainMutationV1[],
        nextPageToken: string | null,
      ) => {
        if (nextPageToken === null) snapshotIndex = null;
        return Object.freeze({
          mutations: Object.freeze([...pageMutations]),
          nextPageToken,
        });
      };

      if (cursor.phase === 'sessions') {
        const sessionMutations = sessionsRaw === null
          ? []
          : await deriveChanges({
              changes: [{
                kind: 'set',
                key: CHAT_SESSIONS_KEY,
                value: sessionsRaw,
              }],
              capturedAt: input.capturedAt,
              createEnvelopeFactory: input.createEnvelopeFactory,
            });
        const remaining = sessionMutations.slice(cursor.mutationOffset);
        const accepted = remaining.slice(0, limit);
        mutations.push(...accepted);
        const nextSessionOffset = cursor.mutationOffset + accepted.length;
        if (nextSessionOffset < sessionMutations.length) {
          return finishPage(mutations, sessionsToken(nextSessionOffset));
        }
        cursor = { phase: 'messages', keyIndex: 0, mutationOffset: 0 };
        if (mutations.length === limit) {
          return finishPage(
            mutations,
            messageKeys.length ? messagesToken(0, 0) : null,
          );
        }
      }

      while (
        mutations.length < limit
        && cursor.phase === 'messages'
        && cursor.keyIndex < messageKeys.length
      ) {
        const baseKeyIndex: number = cursor.keyIndex;
        const startingMutationOffset = cursor.mutationOffset;
        const batchKeys = messageKeys.slice(
          baseKeyIndex,
          baseKeyIndex + CHAT_CORE_STORAGE_READ_LIMIT,
        );
        const storedByKey = new Map(await input.storage.multiGet(
          batchKeys.filter((key) => splitKeySet.has(key)),
        ));
        for (let batchIndex = 0; batchIndex < batchKeys.length; batchIndex += 1) {
          const keyIndex: number = baseKeyIndex + batchIndex;
          const key = batchKeys[batchIndex];
          const storedValue = storedByKey.get(key);
          const change = storedValue !== null && storedValue !== undefined
            ? { kind: 'set' as const, key, value: storedValue }
            : legacyByKey.get(key);
          const messageMutations = change
            ? await deriveChanges({
                changes: [change],
                capturedAt: input.capturedAt,
                createEnvelopeFactory: input.createEnvelopeFactory,
              })
            : [];
          const messageOffset = batchIndex === 0 ? startingMutationOffset : 0;
          const available = limit - mutations.length;
          const accepted = messageMutations.slice(
            messageOffset,
            messageOffset + available,
          );
          mutations.push(...accepted);
          const nextMessageOffset = messageOffset + accepted.length;
          if (nextMessageOffset < messageMutations.length) {
            return finishPage(
              mutations,
              messagesToken(keyIndex, nextMessageOffset),
            );
          }
          const nextKeyIndex: number = keyIndex + 1;
          if (mutations.length === limit) {
            return finishPage(
              mutations,
              nextKeyIndex < messageKeys.length
                ? messagesToken(nextKeyIndex, 0)
                : null,
            );
          }
          cursor = {
            phase: 'messages',
            keyIndex: nextKeyIndex,
            mutationOffset: 0,
          };
        }
      }

      return finishPage(mutations, null);
    },
  });
}
