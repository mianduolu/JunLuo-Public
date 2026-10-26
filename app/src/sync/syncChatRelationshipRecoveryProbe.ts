import RawAsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';

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

const PROBE_META_KEY = 'junluo.sync.probe.chat-relationship-recovery.v1';
const PROBE_BACKUP_KEY = `${PROBE_META_KEY}.favorites-backup`;
const FAVORITES_KEY = 'junluo.chat.favoriteMessages';
const PROBE_OPERATION_ID = 'redmi-chat-relationship-recovery-v1';
const PROBE_MUTATION_ID = 'f2000000-0000-4000-8000-000000000001';
const PROBE_REVISION_ID = 'f2000000-0000-4000-8000-000000000002';
const PROBE_VAULT_ID = 'f2000000-0000-4000-8000-000000000003';
const PROBE_DEVICE_ID = 'f2000000-0000-4000-8000-000000000004';
const PROBE_ENTITY_ID = '__sync_relationship_recovery_probe__';

type CountRow = {
  count: number;
};

type StateRow = {
  state: string;
};

type ProbeMeta = {
  phase: 'arming' | 'prepared';
  createdAt: number;
};

type FavoritesBackup = {
  hadValue: boolean;
  value: string | null;
};

let relationshipRecoveryProbePromise: Promise<void> | undefined;

function expectProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[sync-chat-relationship-probe] ${message}`);
}

function parseJson<T>(raw: string | null, label: string): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`[sync-chat-relationship-probe] ${label} 不是有效 JSON。`);
  }
}

function createProbeMutation(createdAt: number): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: PROBE_MUTATION_ID,
    vaultId: PROBE_VAULT_ID,
    sourceDeviceId: PROBE_DEVICE_ID,
    sourceSequence: 9_200_000_001,
    createdAt,
    entity: {
      domain: 'chat',
      type: 'favorite',
      id: PROBE_ENTITY_ID,
    },
    revision: {
      id: PROBE_REVISION_ID,
      parents: [],
      operation: 'append',
      schemaVersion: 1,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: 1,
      kind: 'favorite',
      value: {
        id: PROBE_ENTITY_ID,
        messageId: PROBE_ENTITY_ID,
        content: '[sync recovery probe]',
        messageCreatedAt: createdAt,
        savedAt: createdAt,
      },
    },
    objectRefs: [],
    retentionClass: 'relationship-history',
  };
}

async function openProbeDatabase() {
  return SQLite.openDatabaseAsync(SYNC_DATABASE_NAME, { useNewConnection: true });
}

async function assertNoNonProbeSyncRows() {
  const database = await openProbeDatabase();
  try {
    const [outbox, intents] = await Promise.all([
      database.getFirstAsync<CountRow>(
        'SELECT COUNT(*) AS count FROM sync_outbox WHERE mutation_id != ?',
        PROBE_MUTATION_ID,
      ),
      database.getFirstAsync<CountRow>(
        'SELECT COUNT(*) AS count FROM sync_durable_intents WHERE operation_id != ?',
        PROBE_OPERATION_ID,
      ),
    ]);
    expectProbe(
      (outbox?.count ?? -1) === 0 && (intents?.count ?? -1) === 0,
      '同步库存在非探针记录，拒绝运行。',
    );
  } finally {
    await database.closeAsync();
  }
}

async function restoreFavoritesAndCleanup(backup: FavoritesBackup) {
  if (backup.hadValue) {
    expectProbe(backup.value !== null, '收藏备份标记与值不一致。');
    await RawAsyncStorage.setItem(FAVORITES_KEY, backup.value);
  } else {
    await RawAsyncStorage.removeItem(FAVORITES_KEY);
  }
  const database = await openProbeDatabase();
  try {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        'DELETE FROM sync_entity_heads WHERE revision_id = ?',
        PROBE_REVISION_ID,
      );
      await transaction.runAsync(
        'DELETE FROM sync_entity_revisions WHERE revision_id = ?',
        PROBE_REVISION_ID,
      );
      await transaction.runAsync(
        'DELETE FROM sync_outbox WHERE mutation_id = ?',
        PROBE_MUTATION_ID,
      );
      await transaction.runAsync(
        'DELETE FROM sync_durable_intents WHERE operation_id = ?',
        PROBE_OPERATION_ID,
      );
    });
  } finally {
    await database.closeAsync();
  }
  await RawAsyncStorage.multiRemove([PROBE_META_KEY, PROBE_BACKUP_KEY]);
}

async function runPhaseOne() {
  await assertNoNonProbeSyncRows();
  expectProbe(
    await RawAsyncStorage.getItem(PROBE_BACKUP_KEY) === null,
    '发现旧收藏备份，拒绝覆盖。',
  );
  const originalFavorites = await RawAsyncStorage.getItem(FAVORITES_KEY);
  const backup: FavoritesBackup = {
    hadValue: originalFavorites !== null,
    value: originalFavorites,
  };
  const createdAt = Date.now();
  await RawAsyncStorage.setItem(PROBE_BACKUP_KEY, JSON.stringify(backup));
  await RawAsyncStorage.setItem(PROBE_META_KEY, JSON.stringify({
    phase: 'arming',
    createdAt,
  } satisfies ProbeMeta));
  const mutation = createProbeMutation(createdAt);
  await prepareSyncDurableIntent({
    operationId: PROBE_OPERATION_ID,
    adapterId: 'chat.relationship-state',
    intent: {
      kind: 'sync-mutation-batch-v1',
      mutations: [mutation],
    },
    state: 'prepared',
    createdAt,
    updatedAt: createdAt,
  });
  await RawAsyncStorage.setItem(PROBE_META_KEY, JSON.stringify({
    phase: 'prepared',
    createdAt,
  } satisfies ProbeMeta));
  console.info('[sync-chat-relationship-probe] PHASE1_READY');
}

async function runPhaseTwo(
  startupRecovery: SyncStoreStartupRecovery,
  backup: FavoritesBackup,
) {
  expectProbe(
    startupRecovery.durableIntentRecovery.recoveredOperationIds
      .includes(PROBE_OPERATION_ID),
    '正式启动恢复没有报告探针 operation。',
  );
  const rawFavorites = await RawAsyncStorage.getItem(FAVORITES_KEY);
  const favorites = parseJson<unknown[]>(rawFavorites, '收藏列表');
  expectProbe(
    Array.isArray(favorites)
      && favorites.some((favorite) => (
        !!favorite
        && typeof favorite === 'object'
        && !Array.isArray(favorite)
        && (favorite as { id?: unknown }).id === PROBE_ENTITY_ID
      )),
    '恢复后没有物化探针收藏。',
  );
  const database = await openProbeDatabase();
  try {
    const [intent, outbox, revision, head] = await Promise.all([
      database.getFirstAsync<StateRow>(
        'SELECT state FROM sync_durable_intents WHERE operation_id = ?',
        PROBE_OPERATION_ID,
      ),
      database.getFirstAsync<StateRow>(
        'SELECT state FROM sync_outbox WHERE mutation_id = ?',
        PROBE_MUTATION_ID,
      ),
      database.getFirstAsync<CountRow>(
        'SELECT COUNT(*) AS count FROM sync_entity_revisions WHERE revision_id = ?',
        PROBE_REVISION_ID,
      ),
      database.getFirstAsync<CountRow>(
        'SELECT COUNT(*) AS count FROM sync_entity_heads WHERE revision_id = ?',
        PROBE_REVISION_ID,
      ),
    ]);
    expectProbe(intent?.state === 'captured', 'durable intent 未推进到 captured。');
    expectProbe(outbox?.state === 'pending', '恢复 mutation 未进入 pending outbox。');
    expectProbe((revision?.count ?? 0) === 1, '恢复 revision 未持久化。');
    expectProbe((head?.count ?? 0) === 1, '恢复 entity head 未持久化。');
  } finally {
    await database.closeAsync();
  }
  await restoreFavoritesAndCleanup(backup);
  await assertNoNonProbeSyncRows();
  expectProbe(
    await RawAsyncStorage.getItem(FAVORITES_KEY) === backup.value,
    '收藏原值没有逐字恢复。',
  );
  console.info('[sync-chat-relationship-probe] PASS');
}

async function runProbeInternal(startupRecovery: SyncStoreStartupRecovery) {
  const [metaRaw, backupRaw] = await RawAsyncStorage.multiGet([
    PROBE_META_KEY,
    PROBE_BACKUP_KEY,
  ]).then((entries) => entries.map(([, value]) => value));
  const meta = parseJson<ProbeMeta>(metaRaw, '探针阶段');
  const backup = parseJson<FavoritesBackup>(backupRaw, '收藏备份');
  if (!meta) {
    expectProbe(backup === null, '存在收藏备份但没有探针阶段，拒绝继续。');
    await runPhaseOne();
    return;
  }
  expectProbe(backup !== null, '探针阶段存在但收藏备份缺失。');
  if (meta.phase === 'arming') {
    await restoreFavoritesAndCleanup(backup);
    await runPhaseOne();
    return;
  }
  expectProbe(meta.phase === 'prepared', `未知探针阶段 ${(meta as ProbeMeta).phase}。`);
  await runPhaseTwo(startupRecovery, backup);
}

export function runSyncChatRelationshipRecoveryProbe(
  startupRecovery: SyncStoreStartupRecovery,
) {
  if (!relationshipRecoveryProbePromise) {
    relationshipRecoveryProbePromise = runProbeInternal(startupRecovery);
  }
  return relationshipRecoveryProbePromise;
}
