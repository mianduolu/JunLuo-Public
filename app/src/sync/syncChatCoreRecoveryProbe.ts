import RawAsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';

import {
  buildChatMessageMutation,
  buildChatSessionMutation,
} from './syncChatCore';
import type {
  PlainMutationV1,
} from './syncProtocol';
import {
  SYNC_DATABASE_NAME,
} from './syncSchema';
import {
  prepareSyncDurableIntent,
  type SyncStoreStartupRecovery,
} from './syncStore';

const PROBE_META_KEY = 'junluo.sync.probe.chat-core-recovery.v1';
const PROBE_BACKUP_KEY = `${PROBE_META_KEY}.storage-backup`;
const PROBE_OPERATION_ID = 'redmi-chat-core-recovery-v1';
const PROBE_VAULT_ID = 'f3000000-0000-4000-8000-000000000001';
const PROBE_DEVICE_ID = 'f3000000-0000-4000-8000-000000000002';
const PROBE_SESSION_MUTATION_ID = 'f3000000-0000-4000-8000-000000000003';
const PROBE_SESSION_REVISION_ID = 'f3000000-0000-4000-8000-000000000004';
const PROBE_MESSAGE_MUTATION_ID = 'f3000000-0000-4000-8000-000000000005';
const PROBE_MESSAGE_REVISION_ID = 'f3000000-0000-4000-8000-000000000006';
const PROBE_SESSION_ID = '__sync_chat_core_recovery_probe_session__';
const PROBE_MESSAGE_ID = '__sync_chat_core_recovery_probe_message__';
const PROBE_TEXT = '[sync recovery probe]';

const CHAT_CORE_EXACT_KEYS = new Set([
  'junluo.chat.primaryMessages',
  'junluo.chat.memoryOrganizedThrough',
  'junluo.chat.sessions',
  'junluo.chat.activeSessionId',
]);
const CHAT_CORE_KEY_PREFIXES = [
  'junluo.chat.sessionMessages.',
  'junluo.chat.sessionMessageOrder.',
  'junluo.chat.sessionMessage.',
] as const;

type CountRow = {
  count: number;
};

type StateRow = {
  state: string;
};

type ProbeMeta = {
  phase: 'arming' | 'prepared' | 'restoring';
  createdAt: number;
};

type ChatCoreStorageBackup = {
  entries: [string, string][];
};

let chatCoreRecoveryProbePromise: Promise<void> | undefined;

function expectProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[sync-chat-core-probe] ${message}`);
}

function parseJson<T>(raw: string | null, label: string): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`[sync-chat-core-probe] ${label} 不是有效 JSON。`);
  }
}

function readProbeMeta(raw: string | null) {
  const meta = parseJson<ProbeMeta>(raw, '探针阶段');
  if (!meta) return null;
  expectProbe(
    (
      meta.phase === 'arming'
      || meta.phase === 'prepared'
      || meta.phase === 'restoring'
    )
      && Number.isSafeInteger(meta.createdAt)
      && meta.createdAt >= 0,
    '探针阶段结构无效。',
  );
  return meta;
}

function readBackup(raw: string | null) {
  const backup = parseJson<ChatCoreStorageBackup>(raw, '聊天存储备份');
  if (!backup) return null;
  expectProbe(Array.isArray(backup.entries), '聊天存储备份结构无效。');
  const seen = new Set<string>();
  for (const entry of backup.entries) {
    expectProbe(
      Array.isArray(entry)
        && entry.length === 2
        && typeof entry[0] === 'string'
        && typeof entry[1] === 'string'
        && isChatCoreStorageKey(entry[0])
        && !seen.has(entry[0]),
      '聊天存储备份条目无效。',
    );
    seen.add(entry[0]);
  }
  return backup;
}

function isChatCoreStorageKey(key: string) {
  return CHAT_CORE_EXACT_KEYS.has(key)
    || CHAT_CORE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function sortedEntries(entries: readonly [string, string][]) {
  return [...entries].sort(([left], [right]) => left.localeCompare(right));
}

async function captureChatCoreStorage(): Promise<ChatCoreStorageBackup> {
  const keys = (await RawAsyncStorage.getAllKeys())
    .filter(isChatCoreStorageKey)
    .sort();
  const entries = keys.length
    ? (await RawAsyncStorage.multiGet(keys))
      .filter((entry): entry is [string, string] => entry[1] !== null)
    : [];
  return {
    entries: sortedEntries(entries),
  };
}

function snapshotsEqual(
  left: ChatCoreStorageBackup,
  right: ChatCoreStorageBackup,
) {
  return JSON.stringify(sortedEntries(left.entries))
    === JSON.stringify(sortedEntries(right.entries));
}

function createProbeMutations(createdAt: number): PlainMutationV1[] {
  const sessionMutation = buildChatSessionMutation({
    envelope: {
      mutationId: PROBE_SESSION_MUTATION_ID,
      vaultId: PROBE_VAULT_ID,
      sourceDeviceId: PROBE_DEVICE_ID,
      sourceSequence: 9_300_000_001,
      revisionId: PROBE_SESSION_REVISION_ID,
      parentRevisionIds: [],
      createdAt,
    },
    session: {
      id: PROBE_SESSION_ID,
      title: PROBE_TEXT,
      customTitle: true,
      createdAt,
      updatedAt: createdAt,
    },
  });
  const messageMutation = buildChatMessageMutation({
    envelope: {
      mutationId: PROBE_MESSAGE_MUTATION_ID,
      vaultId: PROBE_VAULT_ID,
      sourceDeviceId: PROBE_DEVICE_ID,
      sourceSequence: 9_300_000_002,
      revisionId: PROBE_MESSAGE_REVISION_ID,
      parentRevisionIds: [],
      createdAt,
    },
    sessionId: PROBE_SESSION_ID,
    message: {
      id: PROBE_MESSAGE_ID,
      role: 'you',
      content: PROBE_TEXT,
      createdAt,
    },
  });
  return [sessionMutation, messageMutation];
}

async function openProbeDatabase() {
  return SQLite.openDatabaseAsync(SYNC_DATABASE_NAME, { useNewConnection: true });
}

async function assertNoNonProbeSyncRows() {
  const database = await openProbeDatabase();
  try {
    const [outbox, intents] = await Promise.all([
      database.getFirstAsync<CountRow>(
        `SELECT COUNT(*) AS count
         FROM sync_outbox
         WHERE mutation_id NOT IN (?, ?)`,
        PROBE_SESSION_MUTATION_ID,
        PROBE_MESSAGE_MUTATION_ID,
      ),
      database.getFirstAsync<CountRow>(
        'SELECT COUNT(*) AS count FROM sync_durable_intents WHERE operation_id != ?',
        PROBE_OPERATION_ID,
      ),
    ]);
    expectProbe(
      (outbox?.count ?? -1) === 0 && (intents?.count ?? -1) === 0,
      '同步库存在非探针待处理记录，拒绝运行。',
    );
  } finally {
    await database.closeAsync();
  }
}

async function cleanupProbeDatabase() {
  const database = await openProbeDatabase();
  try {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        `DELETE FROM sync_entity_heads
         WHERE revision_id IN (?, ?)`,
        PROBE_SESSION_REVISION_ID,
        PROBE_MESSAGE_REVISION_ID,
      );
      await transaction.runAsync(
        `DELETE FROM sync_entity_revisions
         WHERE revision_id IN (?, ?)`,
        PROBE_SESSION_REVISION_ID,
        PROBE_MESSAGE_REVISION_ID,
      );
      await transaction.runAsync(
        `DELETE FROM sync_outbox
         WHERE mutation_id IN (?, ?)`,
        PROBE_SESSION_MUTATION_ID,
        PROBE_MESSAGE_MUTATION_ID,
      );
      await transaction.runAsync(
        'DELETE FROM sync_durable_intents WHERE operation_id = ?',
        PROBE_OPERATION_ID,
      );
    });
  } finally {
    await database.closeAsync();
  }
}

async function restoreChatCoreStorage(backup: ChatCoreStorageBackup) {
  const currentKeys = (await RawAsyncStorage.getAllKeys()).filter(isChatCoreStorageKey);
  if (currentKeys.length) await RawAsyncStorage.multiRemove(currentKeys);
  if (backup.entries.length) await RawAsyncStorage.multiSet(backup.entries);
}

async function restoreAndCleanup(
  meta: ProbeMeta,
  backup: ChatCoreStorageBackup,
) {
  await RawAsyncStorage.setItem(PROBE_META_KEY, JSON.stringify({
    phase: 'restoring',
    createdAt: meta.createdAt,
  } satisfies ProbeMeta));
  await restoreChatCoreStorage(backup);
  await cleanupProbeDatabase();
  const restored = await captureChatCoreStorage();
  expectProbe(
    snapshotsEqual(restored, backup),
    '聊天核心存储没有逐键、逐字恢复。',
  );
  await RawAsyncStorage.multiRemove([PROBE_META_KEY, PROBE_BACKUP_KEY]);
  await assertNoNonProbeSyncRows();
}

async function runPhaseOne() {
  await assertNoNonProbeSyncRows();
  expectProbe(
    await RawAsyncStorage.getItem(PROBE_BACKUP_KEY) === null,
    '发现旧聊天存储备份，拒绝覆盖。',
  );
  const backup = await captureChatCoreStorage();
  const createdAt = Date.now();
  const armingMeta: ProbeMeta = {
    phase: 'arming',
    createdAt,
  };
  await RawAsyncStorage.setItem(PROBE_BACKUP_KEY, JSON.stringify(backup));
  await RawAsyncStorage.setItem(PROBE_META_KEY, JSON.stringify(armingMeta));
  await prepareSyncDurableIntent({
    operationId: PROBE_OPERATION_ID,
    adapterId: 'chat.core',
    intent: {
      kind: 'sync-mutation-batch-v1',
      mutations: createProbeMutations(createdAt),
    },
    state: 'prepared',
    createdAt,
    updatedAt: createdAt,
  });
  await RawAsyncStorage.setItem(PROBE_META_KEY, JSON.stringify({
    phase: 'prepared',
    createdAt,
  } satisfies ProbeMeta));
  console.info('[sync-chat-core-probe] PHASE1_READY');
}

async function assertRecoveredBusinessState() {
  const sessionsRaw = await RawAsyncStorage.getItem('junluo.chat.sessions');
  const sessions = parseJson<unknown[]>(sessionsRaw, '会话索引');
  expectProbe(
    Array.isArray(sessions)
      && sessions.some((session) => (
        !!session
        && typeof session === 'object'
        && !Array.isArray(session)
        && (session as { id?: unknown }).id === PROBE_SESSION_ID
      )),
    '恢复后没有物化探针会话。',
  );
  const encodedSessionId = encodeURIComponent(PROBE_SESSION_ID);
  const encodedMessageId = encodeURIComponent(PROBE_MESSAGE_ID);
  const orderRaw = await RawAsyncStorage.getItem(
    `junluo.chat.sessionMessageOrder.${encodedSessionId}`,
  );
  const order = parseJson<{ messages?: { id?: unknown }[] }>(orderRaw, '探针消息顺序');
  expectProbe(
    Array.isArray(order?.messages)
      && order.messages.some((entry) => entry.id === PROBE_MESSAGE_ID),
    '恢复后没有物化探针消息顺序。',
  );
  const messageRaw = await RawAsyncStorage.getItem(
    `junluo.chat.sessionMessage.${encodedSessionId}.${encodedMessageId}`,
  );
  const message = parseJson<{ id?: unknown; content?: unknown }>(messageRaw, '探针消息正文');
  expectProbe(
    message?.id === PROBE_MESSAGE_ID && message.content === PROBE_TEXT,
    '恢复后没有物化探针消息正文。',
  );
}

async function assertRecoveredSyncState() {
  const database = await openProbeDatabase();
  try {
    const [intent, outbox, revisions, heads] = await Promise.all([
      database.getFirstAsync<StateRow>(
        'SELECT state FROM sync_durable_intents WHERE operation_id = ?',
        PROBE_OPERATION_ID,
      ),
      database.getFirstAsync<CountRow>(
        `SELECT COUNT(*) AS count
         FROM sync_outbox
         WHERE mutation_id IN (?, ?) AND state = 'pending'`,
        PROBE_SESSION_MUTATION_ID,
        PROBE_MESSAGE_MUTATION_ID,
      ),
      database.getFirstAsync<CountRow>(
        `SELECT COUNT(*) AS count
         FROM sync_entity_revisions
         WHERE revision_id IN (?, ?)`,
        PROBE_SESSION_REVISION_ID,
        PROBE_MESSAGE_REVISION_ID,
      ),
      database.getFirstAsync<CountRow>(
        `SELECT COUNT(*) AS count
         FROM sync_entity_heads
         WHERE revision_id IN (?, ?)`,
        PROBE_SESSION_REVISION_ID,
        PROBE_MESSAGE_REVISION_ID,
      ),
    ]);
    expectProbe(intent?.state === 'captured', 'durable intent 未推进到 captured。');
    expectProbe((outbox?.count ?? 0) === 2, '两条恢复 mutation 未完整进入 pending outbox。');
    expectProbe((revisions?.count ?? 0) === 2, '两条恢复 revision 未完整持久化。');
    expectProbe((heads?.count ?? 0) === 2, '两条恢复 entity head 未完整持久化。');
  } finally {
    await database.closeAsync();
  }
}

async function runPhaseTwo(
  startupRecovery: SyncStoreStartupRecovery,
  meta: ProbeMeta,
  backup: ChatCoreStorageBackup,
) {
  expectProbe(
    startupRecovery.durableIntentRecovery.recoveredOperationIds
      .includes(PROBE_OPERATION_ID),
    '正式启动恢复没有报告探针 operation。',
  );
  await assertRecoveredBusinessState();
  await assertRecoveredSyncState();
  await restoreAndCleanup(meta, backup);
  console.info('[sync-chat-core-probe] PASS');
}

async function runProbeInternal(startupRecovery: SyncStoreStartupRecovery) {
  const [metaRaw, backupRaw] = await RawAsyncStorage.multiGet([
    PROBE_META_KEY,
    PROBE_BACKUP_KEY,
  ]).then((entries) => entries.map(([, value]) => value));
  const meta = readProbeMeta(metaRaw);
  const backup = readBackup(backupRaw);
  if (!meta) {
    expectProbe(backup === null, '存在聊天存储备份但没有探针阶段，拒绝继续。');
    await runPhaseOne();
    return;
  }
  expectProbe(backup !== null, '探针阶段存在但聊天存储备份缺失。');
  if (meta.phase === 'restoring') {
    await restoreAndCleanup(meta, backup);
    console.info('[sync-chat-core-probe] PASS_AFTER_INTERRUPTED_CLEANUP');
    return;
  }
  if (meta.phase === 'arming') {
    await restoreAndCleanup(meta, backup);
    await runPhaseOne();
    return;
  }
  await runPhaseTwo(startupRecovery, meta, backup);
}

export function runSyncChatCoreRecoveryProbe(
  startupRecovery: SyncStoreStartupRecovery,
) {
  if (!chatCoreRecoveryProbePromise) {
    chatCoreRecoveryProbePromise = runProbeInternal(startupRecovery);
  }
  return chatCoreRecoveryProbePromise;
}
