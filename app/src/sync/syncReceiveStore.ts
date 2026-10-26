import * as SQLite from 'expo-sqlite';

import { assertSyncUuidV4 } from './syncDeviceContract';
import { openInitializedSyncDatabase } from './syncDatabaseOpen';
import {
  enqueueSyncDatabaseOperation,
  runSyncDatabaseTransaction,
} from './syncDatabaseOperationQueue';
import {
  assertSealedChangeV1,
  type SealedChangeV1,
} from './syncProtocol';
import type { SyncRelayPullChangesResponseV1 } from './syncRelayClient';

type CursorRow = { cursor_value: number };
type ChangeInboxRow = {
  relay_cursor: number;
  mutation_id: string;
  sealed_json: string;
  state: 'received' | 'applied' | 'quarantined';
};
type IncomingChange = {
  relayCursor: number;
  mutationId: string;
  vaultId: string;
  sourceDeviceId: string;
  sealedJson: string;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} 必须是正安全整数。`);
  }
}

async function getDatabase() {
  if (!databasePromise) {
    const openingDatabasePromise = openInitializedSyncDatabase(
      '同步数据库版本高于当前应用，已停止接收以保护数据。',
    );
    const retryableDatabasePromise = openingDatabasePromise.catch((error) => {
      if (databasePromise === retryableDatabasePromise) {
        databasePromise = undefined;
      }
      throw error;
    });
    databasePromise = retryableDatabasePromise;
  }
  return databasePromise;
}

async function currentCursor(database: SQLite.SQLiteDatabase) {
  const row = await database.getFirstAsync<CursorRow>(
    "SELECT cursor_value FROM sync_cursors WHERE stream_id = 'relay-v1'",
  );
  return row?.cursor_value ?? 0;
}

async function receiveFetchCursor(database: SQLite.SQLiteDatabase) {
  const applied = await currentCursor(database);
  const rows = await database.getAllAsync<{ relay_cursor: number }>(
    `SELECT relay_cursor FROM sync_inbox
     WHERE relay_cursor > ? ORDER BY relay_cursor ASC`,
    applied,
  );
  let expected = applied + 1;
  for (const row of rows) {
    if (row.relay_cursor !== expected) {
      throw new Error(
        `暂存 inbox 缺少 relay cursor ${expected}，不能越过缺口预取。`,
      );
    }
    expected += 1;
  }
  return expected - 1;
}

const BULK_CHANGE_PAGE_CTE = `
  WITH incoming AS (
    SELECT
      CAST(json_extract(value, '$.relayCursor') AS INTEGER) AS relay_cursor,
      json_extract(value, '$.mutationId') AS mutation_id,
      json_extract(value, '$.vaultId') AS vault_id,
      json_extract(value, '$.sourceDeviceId') AS source_device_id,
      json_extract(value, '$.sealedJson') AS sealed_json
    FROM json_each(?)
  )`;

export async function storeAndroidSyncRelayPage(
  page: SyncRelayPullChangesResponseV1,
  expectedVaultId: string,
  receivedAt: number,
) {
  assertSyncUuidV4(expectedVaultId, 'expectedVaultId');
  assertTimestamp(receivedAt, 'receivedAt');
  if (
    !Number.isSafeInteger(page.nextCursor)
    || page.nextCursor < 0
    || typeof page.hasMore !== 'boolean'
    || page.changes.length > 100
  ) {
    throw new Error('Android relay page 合同无效。');
  }
  const incoming: IncomingChange[] = page.changes.map((item) => {
    assertPositiveInteger(item.relayCursor, 'relayCursor');
    assertSealedChangeV1(item.change);
    if (item.change.vaultId !== expectedVaultId) {
      throw new Error('Android relay page 包含其他 vault 密文。');
    }
    return {
      relayCursor: item.relayCursor,
      mutationId: item.change.mutationId,
      vaultId: item.change.vaultId,
      sourceDeviceId: item.change.sourceDeviceId,
      sealedJson: JSON.stringify(item.change),
    };
  });
  const database = await getDatabase();
  await runSyncDatabaseTransaction(database, async (transaction) => {
    const after = await receiveFetchCursor(transaction);
    incoming.forEach((entry, index) => {
      if (entry.relayCursor !== after + index + 1) {
        throw new Error('Android relay page 存在 cursor 缺口或重复。');
      }
    });
    if (page.nextCursor !== (incoming.at(-1)?.relayCursor ?? after)) {
      throw new Error('Android relay page nextCursor 与内容不一致。');
    }
    if (incoming.length === 0) return;
    const serialized = JSON.stringify(incoming);
    const collision = await transaction.getFirstAsync(
      `${BULK_CHANGE_PAGE_CTE}
       SELECT 1 AS invalid
       FROM incoming
       LEFT JOIN sync_inbox AS by_cursor
         ON by_cursor.relay_cursor = incoming.relay_cursor
       LEFT JOIN sync_inbox AS by_mutation
         ON by_mutation.mutation_id = incoming.mutation_id
       WHERE (
         by_cursor.relay_cursor IS NOT NULL
         AND (
           by_cursor.mutation_id != incoming.mutation_id
           OR by_cursor.sealed_json != incoming.sealed_json
         )
       ) OR (
         by_mutation.mutation_id IS NOT NULL
         AND by_mutation.relay_cursor != incoming.relay_cursor
       )
       LIMIT 1`,
      serialized,
    );
    if (collision) {
      throw new Error('Android 普通密文页与既有 cursor 或 mutationId 冲突。');
    }
    await transaction.runAsync(
      `${BULK_CHANGE_PAGE_CTE}
       INSERT OR IGNORE INTO sync_inbox (
         relay_cursor, mutation_id, vault_id, source_device_id,
         sealed_json, state, received_at
       )
       SELECT relay_cursor, mutation_id, vault_id, source_device_id,
              sealed_json, 'received', ?
       FROM incoming`,
      serialized,
      receivedAt,
    );
    const verified = await transaction.getFirstAsync<{ count: number }>(
      `${BULK_CHANGE_PAGE_CTE}
       SELECT COUNT(*) AS count
       FROM incoming
       INNER JOIN sync_inbox AS stored
         ON stored.relay_cursor = incoming.relay_cursor
        AND stored.mutation_id = incoming.mutation_id
        AND stored.vault_id = incoming.vault_id
        AND stored.source_device_id = incoming.source_device_id
        AND stored.sealed_json = incoming.sealed_json`,
      serialized,
    );
    if (verified?.count !== incoming.length) {
      throw new Error('Android 普通密文页没有完整原子落盘。');
    }
  });
}

export async function getAndroidSyncReceiveFetchCursor() {
  const database = await getDatabase();
  return enqueueSyncDatabaseOperation(() => receiveFetchCursor(database));
}

// Explicit manual maintenance only. Re-enter normal verification at the same cursor.
export async function retryNextAndroidTheaterSchemaQuarantine(
  verifyForkBoundary?: (entry: { kind: 'change'; relayCursor: number; change: SealedChangeV1 }, detail: string) => Promise<boolean>,
) {
  const database = await getDatabase();
  type ForkCandidate = { id: number; mutation_id: string; relay_cursor: number; sealed_json: string; detail: string };
  let verified: ForkCandidate | null = null;
  if (verifyForkBoundary) {
    // Crypto stays outside this queue: resolving the signing key uses the same database queue.
    const candidate = await enqueueSyncDatabaseOperation(async () => database.getFirstAsync<ForkCandidate>(
      `SELECT q.id, q.mutation_id, i.relay_cursor, i.sealed_json, q.detail FROM sync_quarantine q
       JOIN sync_inbox i ON i.relay_cursor=q.relay_cursor AND i.mutation_id=q.mutation_id
       WHERE i.relay_cursor=? AND i.state='quarantined' AND q.direction='inbox'
         AND i.error_code='domain.invalid-or-unresolved-mutation' AND q.error_code=i.error_code
         AND q.detail IN ('theater.isolated payload 版本或 kind 无效。',
           'shared experience 包含未允许字段：theaterSelections。', 'experience processed kind 无效。',
           'experience batch 包含未允许字段：theaterSelection。', 'experience kind 无效。')
         AND q.id=(SELECT MAX(id) FROM sync_quarantine WHERE direction='inbox'
           AND mutation_id=i.mutation_id AND relay_cursor=i.relay_cursor)`, await currentCursor(database) + 1,
    ));
    if (candidate) try {
      const change: unknown = JSON.parse(candidate.sealed_json);
      assertSealedChangeV1(change);
      if (change.mutationId === candidate.mutation_id && await verifyForkBoundary({ kind: 'change', relayCursor: candidate.relay_cursor, change }, candidate.detail)) verified = candidate;
    } catch { /* A bad signature/body or unrelated error stays quarantined. */ }
  }
  return runSyncDatabaseTransaction(database, async (transaction) => {
    const nextCursor = await currentCursor(transaction) + 1;
    const row = await transaction.getFirstAsync<{ id: number; mutation_id: string }>(
      `SELECT q.id, q.mutation_id FROM sync_quarantine AS q
       JOIN sync_inbox AS i ON i.relay_cursor = q.relay_cursor AND i.mutation_id = q.mutation_id
       WHERE i.relay_cursor = ? AND i.state = 'quarantined'
         AND i.error_code = 'domain.invalid-or-unresolved-mutation'
         AND q.direction = 'inbox' AND q.error_code = 'domain.invalid-or-unresolved-mutation'
         AND (q.detail IN ('theater.isolated 不支持 schema 2。', 'theater.isolated schemaVersion 无效。')
           OR (q.detail=? AND q.id=? AND i.sealed_json=? AND i.mutation_id=?))
         AND q.id = (SELECT MAX(latest.id) FROM sync_quarantine AS latest
           WHERE latest.direction = 'inbox' AND latest.mutation_id = i.mutation_id
             AND latest.relay_cursor = i.relay_cursor)`,
      nextCursor, verified?.detail ?? '', verified?.id ?? -1, verified?.sealed_json ?? '', verified?.mutation_id ?? '',
    );
    if (!row) return false;
    const result = await transaction.runAsync(
      `UPDATE sync_inbox SET state = 'received', error_code = NULL
       WHERE relay_cursor = ? AND mutation_id = ? AND state = 'quarantined'`,
      nextCursor, row.mutation_id,
    );
    if (result.changes !== 1) throw new Error('theater-schema-retry-inbox-changed');
    await transaction.runAsync('DELETE FROM sync_quarantine WHERE id = ?', row.id);
    return true;
  });
}

export async function listReceivedAndroidSyncInboxChangesAfter(input: {
  afterRelayCursor: number;
  limit: number;
}) {
  if (!Number.isSafeInteger(input.afterRelayCursor) || input.afterRelayCursor < 0) {
    throw new Error('afterRelayCursor 必须是非负安全整数。');
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 4_096) {
    throw new Error('Android 依赖预取范围必须在 1–4096 项。');
  }
  const database = await getDatabase();
  return enqueueSyncDatabaseOperation(async () => {
    const rows = await database.getAllAsync<{
      relay_cursor: number;
      sealed_json: string;
    }>(
      `SELECT relay_cursor, sealed_json FROM sync_inbox
       WHERE relay_cursor > ? AND state = 'received'
       ORDER BY relay_cursor ASC LIMIT ?`,
      input.afterRelayCursor,
      input.limit,
    );
    return rows.map((row) => {
      const change: unknown = JSON.parse(row.sealed_json);
      assertSealedChangeV1(change);
      return { kind: 'change' as const, relayCursor: row.relay_cursor, change };
    });
  });
}

export async function loadNextAndroidSyncRelayInboxEntry() {
  const database = await getDatabase();
  const cursor = await currentCursor(database);
  const row = await database.getFirstAsync<ChangeInboxRow>(
    `SELECT relay_cursor, mutation_id, sealed_json, state
     FROM sync_inbox WHERE relay_cursor > ?
     ORDER BY relay_cursor ASC LIMIT 1`,
    cursor,
  );
  if (!row) return null;
  if (row.relay_cursor !== cursor + 1) {
    throw new Error(`inbox 缺少 relay cursor ${cursor + 1}，不能越过缺口。`);
  }
  if (row.state === 'quarantined') {
    throw new Error(`relay cursor ${row.relay_cursor} 正在隔离，不能推进。`);
  }
  const change: unknown = JSON.parse(row.sealed_json);
  assertSealedChangeV1(change);
  return { kind: 'change' as const, relayCursor: row.relay_cursor, change };
}

export async function closeAndroidSyncReceiveDatabaseForTests() {
  const database = await databasePromise;
  databasePromise = undefined;
  if (database) await database.closeAsync();
}
