import * as SQLite from 'expo-sqlite';

import {
  assertJsonValue,
  assertPlainMutationV1,
  assertSealedChangeV1,
  computeSyncRetryAt,
  parsePlainMutationV1,
  parseSealedChangeV1,
  type PlainMutationV1,
  type SealedChangeV1,
} from './syncProtocol';
import {
  openInitializedSyncDatabase,
} from './syncDatabaseOpen';
import {
  assertSyncDurableIntent,
  assertSyncDurableIntentTransition,
  type SyncDurableIntent,
  type SyncDurableIntentState,
} from './syncRecoveryIntent';
import type {
  SyncStartupRecoveryReport,
} from './syncRecoveryDispatcher';
import type {
  SyncBootstrapCoordinatorReport,
} from './syncBootstrapCoordinator';
import {
  assertSyncDevicePublicIdentityV1,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceIdentity';
import { assertSyncUuidV4 } from './syncDeviceContract';
import {
  enqueueSyncDatabaseOperation,
  runSyncDatabaseTransaction,
} from './syncDatabaseOperationQueue';
import {
  DELETE_EXPIRED_ACKED_SYNC_OUTBOX_SQL,
  DELETE_EXPIRED_APPLIED_SYNC_INBOX_SQL,
  syncTransportHistoryCutoff,
} from './syncTransportRetentionPolicy';

type OutboxRow = {
  local_sequence: number;
  mutation_json: string;
  attempt_count: number;
};

type InboxRow = {
  relay_cursor: number;
  mutation_id: string;
  sealed_json: string;
  state: 'received' | 'applied' | 'quarantined';
};

type CursorRow = {
  cursor_value: number;
};

type StoredOutboxMutationRow = {
  mutation_json: string;
};

type StoredInboxChangeRow = {
  relay_cursor: number;
  sealed_json: string;
};

type AcknowledgedSelfEchoBatchRow = {
  relay_cursor: number;
  mutation_id: string;
  sealed_json: string;
  inbox_state: 'received' | 'applied' | 'quarantined';
  source_device_id: string;
  outbox_state: string | null;
  mutation_json: string | null;
  revision_json: string | null;
};

type DurableIntentRow = {
  operation_id: string;
  adapter_id: string;
  intent_json: string;
  state: SyncDurableIntentState;
  created_at: number;
  updated_at: number;
};

export type ClaimedOutboxMutation = {
  localSequence: number;
  mutation: PlainMutationV1;
  attemptCount: number;
};

export type PendingInboxChange = {
  relayCursor: number;
  change: SealedChangeV1;
};

export type AcknowledgedSyncSelfEcho = {
  relayCursor: number;
  change: SealedChangeV1;
  mutation: PlainMutationV1;
  sealedJson: string;
  mutationJson: string;
};

export type SyncStoreStartupRecovery = {
  releasedOutboxLeaseCount: number;
  incompleteDurableIntents: SyncDurableIntent[];
  durableIntentRecovery: SyncStartupRecoveryReport;
  bootstrapMigration: SyncBootstrapCoordinatorReport | null;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} 必须是正安全整数。`);
  }
}

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertToken(value: string, label: string, maximumLength = 160) {
  if (!value || value.length > maximumLength || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`${label} 格式无效。`);
  }
}

async function getDatabase() {
  if (!databasePromise) {
    const openingDatabasePromise = openInitializedSyncDatabase(
      '同步数据库版本高于当前应用，已停止同步以保护数据。',
    );
    const retryableDatabasePromise = openingDatabasePromise.catch(
      (error) => {
        if (databasePromise === retryableDatabasePromise) {
          databasePromise = undefined;
        }
        throw error;
      },
    );
    databasePromise = retryableDatabasePromise;
  }
  return databasePromise;
}

async function releaseExpiredSyncOutboxLeases(
  database: SQLite.SQLiteDatabase,
  now: number,
) {
  const result = await database.runAsync(
    `UPDATE sync_outbox
     SET state = 'pending', lease_id = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE state = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
    now,
    now,
  );
  return result.changes;
}

export async function initializeSyncStore(
  now = Date.now(),
): Promise<SyncStoreStartupRecovery> {
  assertTimestamp(now, 'now');
  const database = await getDatabase();
  let releasedOutboxLeaseCount = 0;
  await runSyncDatabaseTransaction(database, async (transaction) => {
    releasedOutboxLeaseCount = await releaseExpiredSyncOutboxLeases(transaction, now);
  });
  const incompleteDurableIntents = await loadIncompleteSyncDurableIntents();
  const durableIntentRecovery: SyncStartupRecoveryReport = incompleteDurableIntents.length
    ? await import('./syncStartupRecovery').then(({ recoverKnownSyncDurableIntents }) => (
        recoverKnownSyncDurableIntents(incompleteDurableIntents)
      ))
    : {
        recoveredOperationIds: [],
        unresolved: [],
      };
  // A completed current-world snapshot already owns the initial data. Resume
  // its original writers instead of capturing every current row a second time.
  const currentWorldReady = await import('./syncAndroidNewWorldLiveCapture')
    .then(({ restoreAndroidNewWorldLiveCapture }) => restoreAndroidNewWorldLiveCapture());
  const bootstrapMigration = currentWorldReady ? null : await import('./syncBootstrapCoordinator')
    .then(({ runAvailableSyncBootstraps }) => runAvailableSyncBootstraps());
  return {
    releasedOutboxLeaseCount,
    incompleteDurableIntents,
    durableIntentRecovery,
    bootstrapMigration,
  };
}

export async function saveSyncDevicePublicIdentity(
  identity: SyncDevicePublicIdentityV1,
  observedAt: number = Date.now(),
) {
  assertSyncDevicePublicIdentityV1(identity);
  assertTimestamp(observedAt, 'device identity observedAt');
  const database = await getDatabase();
  await runSyncDatabaseTransaction(
    database,
    async (transaction) => {
      const existing = await transaction.getFirstAsync<{
        device_id: string;
        vault_id: string;
        key_id: string;
        platform: string;
        display_name: string;
        signing_public_key: string;
        exchange_public_key: string;
        state: 'pending' | 'active' | 'revoked';
        created_at: number;
        revoked_at: number | null;
      }>(
        'SELECT * FROM sync_device_state WHERE device_id = ?',
        identity.deviceId,
      );
      if (existing) {
        if (existing.key_id !== identity.keyId) {
          throw new Error(
            '同一 Android 设备不能在当前同步世界更换 keyId；请重建新世界。',
          );
        }
        if (
          existing.vault_id !== identity.vaultId
          || existing.platform !== identity.platform
          || existing.signing_public_key !== identity.signingPublicKey
          || existing.exchange_public_key !== identity.exchangePublicKey
          || existing.created_at !== identity.createdAt
        ) {
          throw new Error(
            '同一 Android 设备的不可变公开身份发生变化。',
          );
        }
        if (
          existing.state === 'revoked'
          && identity.state !== 'revoked'
        ) {
          throw new Error('已撤销 Android 设备不能恢复为 active。');
        }
        if (
          existing.state === 'active'
          && identity.state === 'pending'
        ) {
          throw new Error('active Android 设备不能退回 pending。');
        }
      }
      await transaction.runAsync(
      `INSERT INTO sync_device_state (
         device_id, vault_id, key_id, platform, display_name,
         signing_public_key, exchange_public_key, state, created_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         display_name = excluded.display_name,
         state = excluded.state,
         revoked_at = excluded.revoked_at`,
      identity.deviceId,
      identity.vaultId,
      identity.keyId,
      identity.platform,
      identity.displayName,
      identity.signingPublicKey,
      identity.exchangePublicKey,
      identity.state,
      identity.createdAt,
      identity.revokedAt,
      );
    },
  );
}

export async function resolveSyncDeviceSigningPublicKeyAt(input: {
  vaultId: string;
  deviceId: string;
  keyId: string;
  createdAt: number;
}) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{
    signing_public_key: string;
    state: 'pending' | 'active' | 'revoked';
    created_at: number;
  }>(
    `SELECT signing_public_key, state, created_at
     FROM sync_device_state
     WHERE vault_id = ? AND device_id = ? AND key_id = ?`,
    input.vaultId,
    input.deviceId,
    input.keyId,
  );
  if (!row || row.created_at > input.createdAt || row.state !== 'active') {
    return null;
  }
  return row.signing_public_key;
}

export async function enqueueSyncMutation(mutation: PlainMutationV1) {
  assertPlainMutationV1(mutation);
  if (mutation.entity.domain === 'behavior' && mutation.entity.type === 'current-action') return;
  const database = await getDatabase();
  await enqueueSyncDatabaseOperation(async () => {
    const serialized = JSON.stringify(mutation);
    const result = await database.runAsync(
      `INSERT OR IGNORE INTO sync_outbox (
         mutation_id, vault_id, source_device_id, source_sequence,
         mutation_json, state, available_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      mutation.mutationId,
      mutation.vaultId,
      mutation.sourceDeviceId,
      mutation.sourceSequence,
      serialized,
      mutation.createdAt,
      mutation.createdAt,
      mutation.createdAt,
    );
    if (result.changes > 0) return;

    const existing = await database.getFirstAsync<StoredOutboxMutationRow>(
      'SELECT mutation_json FROM sync_outbox WHERE mutation_id = ?',
      mutation.mutationId,
    );
    if (!existing || existing.mutation_json !== serialized) {
      throw new Error('相同 mutationId 对应了不同本地变更，已停止同步。');
    }
  });
}

export async function loadAcknowledgedSyncOutboxMutation(
  mutationId: string,
) {
  assertToken(mutationId, 'mutationId');
  const database = await getDatabase();
  const row = await database.getFirstAsync<{
    mutation_json: string;
  }>(
    `SELECT mutation_json
     FROM sync_outbox
     WHERE mutation_id = ? AND state = 'acked'`,
    mutationId,
  );
  return row ? parsePlainMutationV1(row.mutation_json) : null;
}

function selfEchoIdentityMatches(
  change: SealedChangeV1,
  mutation: PlainMutationV1,
) {
  return mutation.protocolVersion === change.protocolVersion
    && mutation.vaultId === change.vaultId
    && mutation.sourceDeviceId === change.sourceDeviceId
    && mutation.sourceSequence === change.sourceSequence
    && mutation.mutationId === change.mutationId
    && mutation.createdAt === change.createdAt;
}

export async function loadAcknowledgedSyncSelfEchoBatch(input: {
  sourceDeviceId: string;
  limit?: number;
}) {
  assertToken(input.sourceDeviceId, 'sourceDeviceId');
  const limit = input.limit ?? 64;
  assertPositiveInteger(limit, 'self echo batch limit');
  if (limit > 64) {
    throw new Error('自家回声批量读取不能超过 64 条。');
  }
  const database = await getDatabase();
  return enqueueSyncDatabaseOperation(async () => {
    const cursor = await database.getFirstAsync<CursorRow>(
      "SELECT cursor_value FROM sync_cursors WHERE stream_id = 'relay-v1'",
    );
    const currentCursor = cursor?.cursor_value ?? 0;
    const rows = await database.getAllAsync<AcknowledgedSelfEchoBatchRow>(
      `SELECT
         inbox.relay_cursor,
         inbox.mutation_id,
         inbox.sealed_json,
         inbox.state AS inbox_state,
         inbox.source_device_id,
         outbox.state AS outbox_state,
         outbox.mutation_json,
         revisions.mutation_json AS revision_json
       FROM sync_inbox AS inbox
       LEFT JOIN sync_outbox AS outbox
         ON outbox.mutation_id = inbox.mutation_id
       LEFT JOIN sync_entity_revisions AS revisions
         ON revisions.mutation_id = inbox.mutation_id
       WHERE inbox.relay_cursor > ?
       ORDER BY inbox.relay_cursor ASC
       LIMIT ?`,
      currentCursor,
      limit,
    );
    const batch: AcknowledgedSyncSelfEcho[] = [];
    let expectedCursor = currentCursor + 1;
    for (const row of rows) {
      if (
        row.relay_cursor !== expectedCursor
        || row.inbox_state !== 'received'
        || row.source_device_id !== input.sourceDeviceId
        || row.outbox_state !== 'acked'
        || !row.mutation_json
        || row.revision_json !== row.mutation_json
      ) {
        break;
      }
      let change: SealedChangeV1;
      let mutation: PlainMutationV1;
      try {
        change = parseSealedChangeV1(row.sealed_json);
        mutation = parsePlainMutationV1(row.mutation_json);
      } catch {
        break;
      }
      if (!selfEchoIdentityMatches(change, mutation)) break;
      batch.push({
        relayCursor: row.relay_cursor,
        change,
        mutation,
        sealedJson: row.sealed_json,
        mutationJson: row.mutation_json,
      });
      expectedCursor += 1;
    }
    return batch;
  });
}

export async function markAcknowledgedSyncSelfEchoBatchApplied(
  entries: AcknowledgedSyncSelfEcho[],
  appliedAt: number,
) {
  if (entries.length === 0) return 0;
  if (entries.length > 64) {
    throw new Error('自家回声批量确认不能超过 64 条。');
  }
  assertTimestamp(appliedAt, 'appliedAt');
  entries.forEach((entry, index) => {
    assertPositiveInteger(entry.relayCursor, `selfEcho[${index}].relayCursor`);
    assertSealedChangeV1(entry.change);
    assertPlainMutationV1(entry.mutation);
    if (
      index > 0
      && entry.relayCursor !== entries[index - 1]!.relayCursor + 1
    ) {
      throw new Error('自家回声批量确认游标不连续。');
    }
  });
  const firstCursor = entries[0]!.relayCursor;
  const lastCursor = entries.at(-1)!.relayCursor;
  const database = await getDatabase();
  await runSyncDatabaseTransaction(database, async (transaction) => {
    const cursor = await transaction.getFirstAsync<CursorRow>(
      "SELECT cursor_value FROM sync_cursors WHERE stream_id = 'relay-v1'",
    );
    if ((cursor?.cursor_value ?? 0) !== firstCursor - 1) {
      throw new Error('自家回声批量确认起点与当前 relay 游标不连续。');
    }
    const rows = await transaction.getAllAsync<AcknowledgedSelfEchoBatchRow>(
      `SELECT
         inbox.relay_cursor,
         inbox.mutation_id,
         inbox.sealed_json,
         inbox.state AS inbox_state,
         inbox.source_device_id,
         outbox.state AS outbox_state,
         outbox.mutation_json,
         revisions.mutation_json AS revision_json
       FROM sync_inbox AS inbox
       LEFT JOIN sync_outbox AS outbox
         ON outbox.mutation_id = inbox.mutation_id
       LEFT JOIN sync_entity_revisions AS revisions
         ON revisions.mutation_id = inbox.mutation_id
       WHERE inbox.relay_cursor BETWEEN ? AND ?
       ORDER BY inbox.relay_cursor ASC`,
      firstCursor,
      lastCursor,
    );
    if (rows.length !== entries.length) {
      throw new Error('自家回声批量确认区间存在缺口。');
    }
    for (const [index, row] of rows.entries()) {
      const entry = entries[index]!;
      if (
        row.relay_cursor !== entry.relayCursor
        || row.mutation_id !== entry.mutation.mutationId
        || row.sealed_json !== entry.sealedJson
        || row.inbox_state !== 'received'
        || row.source_device_id !== entry.mutation.sourceDeviceId
        || row.outbox_state !== 'acked'
        || row.mutation_json !== entry.mutationJson
        || row.revision_json !== entry.mutationJson
        || !selfEchoIdentityMatches(entry.change, entry.mutation)
      ) {
        throw new Error('自家回声批量确认内容在提交前发生变化。');
      }
      for (const objectId of entry.mutation.objectRefs) {
        await transaction.runAsync(
          `INSERT OR IGNORE INTO sync_revision_object_refs (
             revision_id, object_id
           ) VALUES (?, ?)`,
          entry.mutation.revision.id,
          objectId,
        );
      }
    }
    const updated = await transaction.runAsync(
      `UPDATE sync_inbox
       SET state = 'applied', applied_at = ?, error_code = NULL
       WHERE relay_cursor BETWEEN ? AND ? AND state = 'received'`,
      appliedAt,
      firstCursor,
      lastCursor,
    );
    if (updated.changes !== entries.length) {
      throw new Error('自家回声批量确认未完整更新 inbox。');
    }
    await transaction.runAsync(
      `INSERT OR IGNORE INTO sync_applied_mutations (
         mutation_id, relay_cursor, applied_at
       )
       SELECT mutation_id, relay_cursor, ?
       FROM sync_inbox
       WHERE relay_cursor BETWEEN ? AND ?`,
      appliedAt,
      firstCursor,
      lastCursor,
    );
    for (const entry of entries) {
      await transaction.runAsync(
        `INSERT OR IGNORE INTO sync_mutation_relay_receipts_v1 (
           mutation_id, source_device_id, source_sequence,
           relay_cursor, recorded_at
         ) VALUES (?, ?, ?, ?, ?)`,
        entry.mutation.mutationId,
        entry.mutation.sourceDeviceId,
        entry.mutation.sourceSequence,
        entry.relayCursor,
        appliedAt,
      );
    }
    await transaction.runAsync(
      `INSERT INTO sync_cursors (stream_id, cursor_value, updated_at)
       VALUES ('relay-v1', ?, ?)
       ON CONFLICT(stream_id) DO UPDATE SET
         cursor_value = excluded.cursor_value,
         updated_at = excluded.updated_at`,
      lastCursor,
      appliedAt,
    );
  });
  return entries.length;
}

export async function claimSyncOutboxBatch(input: {
  leaseId: string;
  now: number;
  limit?: number;
  leaseDurationMs?: number;
}) {
  const { leaseId, now } = input;
  const limit = input.limit ?? 40;
  const leaseDurationMs = input.leaseDurationMs ?? 60_000;
  assertToken(leaseId, 'leaseId');
  assertTimestamp(now, 'now');
  assertPositiveInteger(limit, 'limit');
  assertPositiveInteger(leaseDurationMs, 'leaseDurationMs');
  if (limit > 100) throw new Error('单次 outbox 领取不能超过 100 项。');

  const database = await getDatabase();
  let rows: OutboxRow[] = [];
  await runSyncDatabaseTransaction(database, async (transaction) => {
    await releaseExpiredSyncOutboxLeases(transaction, now);
    rows = await transaction.getAllAsync<OutboxRow>(
      `SELECT local_sequence, mutation_json, attempt_count
       FROM sync_outbox
       WHERE state = 'pending' AND available_at <= ?
         AND NOT (json_extract(mutation_json, '$.entity.domain') = 'behavior' AND json_extract(mutation_json, '$.entity.type') = 'current-action')
         AND NOT (json_extract(mutation_json, '$.entity.domain') = 'memory' AND json_extract(mutation_json, '$.entity.type') = 'continuity-candidate')
       ORDER BY local_sequence ASC
       LIMIT ?`,
      now,
      limit,
    );
    for (const row of rows) {
      await transaction.runAsync(
        `UPDATE sync_outbox
         SET state = 'leased', lease_id = ?, lease_expires_at = ?, updated_at = ?
         WHERE local_sequence = ? AND state = 'pending'`,
        leaseId,
        now + leaseDurationMs,
        now,
        row.local_sequence,
      );
    }
  });
  return rows.map((row): ClaimedOutboxMutation => ({
    localSequence: row.local_sequence,
    mutation: parsePlainMutationV1(row.mutation_json),
    attemptCount: row.attempt_count,
  }));
}

export async function acknowledgeSyncOutbox(
  leaseId: string,
  acknowledgements: Array<string | {
    mutationId: string;
    relayCursor: number;
  }>,
  acknowledgedAt: number,
) {
  assertToken(leaseId, 'leaseId');
  assertTimestamp(acknowledgedAt, 'acknowledgedAt');
  if (acknowledgements.length === 0) return;
  const database = await getDatabase();
  await runSyncDatabaseTransaction(database, async (transaction) => {
    for (const acknowledgement of acknowledgements) {
      const mutationId = typeof acknowledgement === 'string'
        ? acknowledgement
        : acknowledgement.mutationId;
      assertToken(mutationId, 'mutationId');
      if (typeof acknowledgement !== 'string') {
        assertPositiveInteger(
          acknowledgement.relayCursor,
          'relayCursor',
        );
      }
      const source = await transaction.getFirstAsync<{
        source_device_id: string;
        source_sequence: number;
      }>(
        `SELECT source_device_id, source_sequence FROM sync_outbox
         WHERE mutation_id = ? AND state = 'leased' AND lease_id = ?`,
        mutationId,
        leaseId,
      );
      if (!source) {
        throw new Error(`mutation ${mutationId} 不属于当前 outbox 租约。`);
      }
      const result = await transaction.runAsync(
        `UPDATE sync_outbox
         SET state = 'acked', lease_id = NULL, lease_expires_at = NULL,
             last_error_code = NULL, updated_at = ?
         WHERE mutation_id = ? AND state = 'leased' AND lease_id = ?`,
        acknowledgedAt,
        mutationId,
        leaseId,
      );
      if (result.changes !== 1) {
        throw new Error(`mutation ${mutationId} 不属于当前 outbox 租约。`);
      }
      if (typeof acknowledgement !== 'string') {
        const existingReceipt = await transaction.getFirstAsync<{
          relay_cursor: number;
        }>(
          `SELECT relay_cursor FROM sync_mutation_relay_receipts_v1
           WHERE mutation_id = ?`,
          mutationId,
        );
        if (
          existingReceipt
          && existingReceipt.relay_cursor !== acknowledgement.relayCursor
        ) {
          throw new Error('mutation relay receipt changed');
        }
        await transaction.runAsync(
          `INSERT OR IGNORE INTO sync_mutation_relay_receipts_v1 (
             mutation_id, source_device_id, source_sequence,
             relay_cursor, recorded_at
           ) VALUES (?, ?, ?, ?, ?)`,
          mutationId,
          source.source_device_id,
          source.source_sequence,
          acknowledgement.relayCursor,
          acknowledgedAt,
        );
      }
    }
  });
}

export async function loadSyncMutationRelayReceiptCursor(
  mutationId: string,
) {
  assertToken(mutationId, 'mutationId', 256);
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ relay_cursor: number }>(
    `SELECT relay_cursor
     FROM sync_mutation_relay_receipts_v1
     WHERE mutation_id = ?`,
    mutationId,
  );
  return row?.relay_cursor ?? null;
}

export async function cleanupCompletedSyncTransportHistory(
  now: number,
) {
  const cutoff = syncTransportHistoryCutoff(now);
  const database = await getDatabase();
  let deletedOutbox = 0;
  let deletedInbox = 0;
  await runSyncDatabaseTransaction(database, async (transaction) => {
    deletedOutbox = (await transaction.runAsync(
      DELETE_EXPIRED_ACKED_SYNC_OUTBOX_SQL,
      cutoff,
    )).changes;
    deletedInbox = (await transaction.runAsync(
      DELETE_EXPIRED_APPLIED_SYNC_INBOX_SQL,
      cutoff,
    )).changes;
  });
  return {
    deletedOutbox,
    deletedInbox,
  };
}

export async function failSyncOutboxLease(input: {
  leaseId: string;
  failedAt: number;
  errorCode: string;
  jitterFraction?: number;
}) {
  assertToken(input.leaseId, 'leaseId');
  assertTimestamp(input.failedAt, 'failedAt');
  assertToken(input.errorCode, 'errorCode');
  const database = await getDatabase();
  await runSyncDatabaseTransaction(database, async (transaction) => {
    const rows = await transaction.getAllAsync<{ local_sequence: number; attempt_count: number }>(
      `SELECT local_sequence, attempt_count
       FROM sync_outbox
       WHERE state = 'leased' AND lease_id = ?`,
      input.leaseId,
    );
    for (const row of rows) {
      const attemptCount = row.attempt_count + 1;
      const availableAt = computeSyncRetryAt(
        attemptCount,
        input.failedAt,
        input.jitterFraction ?? 0,
      );
      await transaction.runAsync(
        `UPDATE sync_outbox
         SET state = 'pending', attempt_count = ?, available_at = ?,
             lease_id = NULL, lease_expires_at = NULL,
             last_error_code = ?, updated_at = ?
         WHERE local_sequence = ? AND lease_id = ?`,
        attemptCount,
        availableAt,
        input.errorCode,
        input.failedAt,
        row.local_sequence,
        input.leaseId,
      );
    }
  });
}

export async function storeIncomingSealedChange(
  change: SealedChangeV1,
  relayCursor: number,
  receivedAt: number,
) {
  assertSealedChangeV1(change);
  assertPositiveInteger(relayCursor, 'relayCursor');
  assertTimestamp(receivedAt, 'receivedAt');
  const database = await getDatabase();
  await enqueueSyncDatabaseOperation(async () => {
    const serialized = JSON.stringify(change);
    const existingByCursor = await database.getFirstAsync<InboxRow>(
      'SELECT relay_cursor, mutation_id, sealed_json, state FROM sync_inbox WHERE relay_cursor = ?',
      relayCursor,
    );
    if (existingByCursor) {
      if (
        existingByCursor.mutation_id !== change.mutationId
        || existingByCursor.sealed_json !== serialized
      ) {
        throw new Error('相同 relay cursor 对应了不同密文，已停止同步。');
      }
      return;
    }
    const existingByMutation = await database.getFirstAsync<StoredInboxChangeRow>(
      'SELECT relay_cursor, sealed_json FROM sync_inbox WHERE mutation_id = ?',
      change.mutationId,
    );
    if (existingByMutation) {
      if (
        existingByMutation.relay_cursor !== relayCursor
        || existingByMutation.sealed_json !== serialized
      ) {
        throw new Error('相同 mutationId 对应了不同远端密文，已停止同步。');
      }
      return;
    }
    await database.runAsync(
      `INSERT INTO sync_inbox (
         relay_cursor, mutation_id, vault_id, source_device_id,
         sealed_json, state, received_at
       ) VALUES (?, ?, ?, ?, ?, 'received', ?)`,
      relayCursor,
      change.mutationId,
      change.vaultId,
      change.sourceDeviceId,
      serialized,
      receivedAt,
    );
  });
}

export async function getAppliedRelayCursor() {
  const database = await getDatabase();
  const row = await database.getFirstAsync<CursorRow>(
    "SELECT cursor_value FROM sync_cursors WHERE stream_id = 'relay-v1'",
  );
  return row?.cursor_value ?? 0;
}

export async function saveSyncDeviceFreshnessCheckpoint(input: {
  deviceId: string;
  appliedCursor: number;
  state: 'incremental' | 'refresh-required';
  historyFloorCursor: number;
  refreshRequiredAt: number | null;
  lastAuthenticatedAt: number;
  updatedAt: number;
}) {
  assertSyncUuidV4(input.deviceId, 'deviceId');
  assertTimestamp(input.appliedCursor, 'appliedCursor');
  assertTimestamp(input.historyFloorCursor, 'historyFloorCursor');
  assertTimestamp(input.lastAuthenticatedAt, 'lastAuthenticatedAt');
  assertTimestamp(input.updatedAt, 'updatedAt');
  if (input.refreshRequiredAt !== null) {
    assertTimestamp(input.refreshRequiredAt, 'refreshRequiredAt');
  }
  if (
    (input.state === 'refresh-required')
      !== (input.refreshRequiredAt !== null)
  ) {
    throw new Error('设备刷新状态与时间不一致。');
  }
  const database = await getDatabase();
  await enqueueSyncDatabaseOperation(async () => {
    await database.runAsync(
      `INSERT INTO sync_device_freshness_checkpoint_v2 (
         device_id, applied_cursor, state, history_floor_cursor,
         refresh_required_at, last_reported_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         applied_cursor = MAX(
           sync_device_freshness_checkpoint_v2.applied_cursor,
           excluded.applied_cursor
         ),
         state = excluded.state,
         history_floor_cursor = MAX(
           sync_device_freshness_checkpoint_v2.history_floor_cursor,
           excluded.history_floor_cursor
         ),
         refresh_required_at = excluded.refresh_required_at,
         last_reported_at = MAX(
           sync_device_freshness_checkpoint_v2.last_reported_at,
           excluded.last_reported_at
         ),
         updated_at = MAX(
           sync_device_freshness_checkpoint_v2.updated_at,
           excluded.updated_at
         )`,
      input.deviceId,
      input.appliedCursor,
      input.state,
      input.historyFloorCursor,
      input.refreshRequiredAt,
      input.lastAuthenticatedAt,
      input.updatedAt,
    );
  });
}

export async function loadNextInboxChange(): Promise<PendingInboxChange | null> {
  const database = await getDatabase();
  const cursor = await getAppliedRelayCursor();
  const row = await database.getFirstAsync<InboxRow>(
    `SELECT relay_cursor, mutation_id, sealed_json, state
     FROM sync_inbox
     WHERE relay_cursor > ?
     ORDER BY relay_cursor ASC
     LIMIT 1`,
    cursor,
  );
  if (!row) return null;
  if (row.relay_cursor !== cursor + 1) {
    throw new Error(`inbox 缺少 relay cursor ${cursor + 1}，不能越过缺口。`);
  }
  if (row.state === 'quarantined') {
    throw new Error(`relay cursor ${row.relay_cursor} 正在隔离区，不能推进。`);
  }
  return {
    relayCursor: row.relay_cursor,
    change: parseSealedChangeV1(row.sealed_json),
  };
}

export async function markInboxChangeApplied(
  mutationId: string,
  relayCursor: number,
  appliedAt: number,
) {
  assertToken(mutationId, 'mutationId');
  assertPositiveInteger(relayCursor, 'relayCursor');
  assertTimestamp(appliedAt, 'appliedAt');
  const database = await getDatabase();
  await runSyncDatabaseTransaction(database, async (transaction) => {
    const current = await transaction.getFirstAsync<CursorRow>(
      "SELECT cursor_value FROM sync_cursors WHERE stream_id = 'relay-v1'",
    );
    const currentCursor = current?.cursor_value ?? 0;
    if (relayCursor <= currentCursor) return;
    if (relayCursor !== currentCursor + 1) {
      throw new Error(`不能从 relay cursor ${currentCursor} 跳到 ${relayCursor}。`);
    }
    const row = await transaction.getFirstAsync<InboxRow>(
      `SELECT relay_cursor, mutation_id, sealed_json, state
       FROM sync_inbox WHERE relay_cursor = ?`,
      relayCursor,
    );
    if (!row || row.mutation_id !== mutationId || row.state !== 'received') {
      throw new Error('待应用 inbox 记录不存在、已隔离或 mutationId 不匹配。');
    }
    const sealedChange = parseSealedChangeV1(row.sealed_json);
    await transaction.runAsync(
      `UPDATE sync_inbox
       SET state = 'applied', applied_at = ?, error_code = NULL
       WHERE relay_cursor = ?`,
      appliedAt,
      relayCursor,
    );
    await transaction.runAsync(
      `INSERT OR IGNORE INTO sync_applied_mutations (mutation_id, relay_cursor, applied_at)
       VALUES (?, ?, ?)`,
      mutationId,
      relayCursor,
      appliedAt,
    );
    await transaction.runAsync(
      `INSERT OR IGNORE INTO sync_mutation_relay_receipts_v1 (
         mutation_id, source_device_id, source_sequence,
         relay_cursor, recorded_at
       ) VALUES (?, ?, ?, ?, ?)`,
      mutationId,
      sealedChange.sourceDeviceId,
      sealedChange.sourceSequence,
      relayCursor,
      appliedAt,
    );
    await transaction.runAsync(
      `INSERT INTO sync_cursors (stream_id, cursor_value, updated_at)
       VALUES ('relay-v1', ?, ?)
       ON CONFLICT(stream_id) DO UPDATE SET
         cursor_value = excluded.cursor_value,
         updated_at = excluded.updated_at`,
      relayCursor,
      appliedAt,
    );
  });
}

export async function quarantineInboxChange(input: {
  mutationId: string;
  relayCursor: number;
  errorCode: string;
  detail?: string;
  createdAt: number;
}) {
  assertToken(input.mutationId, 'mutationId');
  assertPositiveInteger(input.relayCursor, 'relayCursor');
  assertToken(input.errorCode, 'errorCode');
  assertTimestamp(input.createdAt, 'createdAt');
  const detail = (input.detail ?? '').slice(0, 1000);
  const database = await getDatabase();
  await runSyncDatabaseTransaction(database, async (transaction) => {
    const result = await transaction.runAsync(
      `UPDATE sync_inbox
       SET state = 'quarantined', error_code = ?
       WHERE relay_cursor = ? AND mutation_id = ? AND state = 'received'`,
      input.errorCode,
      input.relayCursor,
      input.mutationId,
    );
    if (result.changes !== 1) {
      throw new Error('无法隔离不存在或已处理的 inbox 记录。');
    }
    await transaction.runAsync(
      `INSERT INTO sync_quarantine (
         direction, mutation_id, relay_cursor, error_code, detail, created_at
       ) VALUES ('inbox', ?, ?, ?, ?, ?)`,
      input.mutationId,
      input.relayCursor,
      input.errorCode,
      detail,
      input.createdAt,
    );
  });
}

export async function prepareSyncDurableIntent(intent: SyncDurableIntent) {
  assertSyncDurableIntent(intent);
  if (intent.state !== 'prepared') {
    throw new Error('新 durable intent 必须从 prepared 状态开始。');
  }
  const serialized = JSON.stringify(intent.intent);
  const database = await getDatabase();
  await enqueueSyncDatabaseOperation(async () => {
    const result = await database.runAsync(
      `INSERT OR IGNORE INTO sync_durable_intents (
         operation_id, adapter_id, intent_json, state, created_at, updated_at
       ) VALUES (?, ?, ?, 'prepared', ?, ?)`,
      intent.operationId,
      intent.adapterId,
      serialized,
      intent.createdAt,
      intent.updatedAt,
    );
    if (result.changes > 0) return;
    const existing = await database.getFirstAsync<DurableIntentRow>(
      `SELECT operation_id, adapter_id, intent_json, state, created_at, updated_at
       FROM sync_durable_intents WHERE operation_id = ?`,
      intent.operationId,
    );
    if (
      !existing
      || existing.adapter_id !== intent.adapterId
      || existing.intent_json !== serialized
      || existing.created_at !== intent.createdAt
    ) {
      throw new Error('相同 operationId 对应了不同 durable intent，已停止同步。');
    }
  });
}

export async function advanceSyncDurableIntent(input: {
  operationId: string;
  from: SyncDurableIntentState;
  to: SyncDurableIntentState;
  updatedAt: number;
}) {
  assertToken(input.operationId, 'operationId');
  assertTimestamp(input.updatedAt, 'updatedAt');
  assertSyncDurableIntentTransition(input.from, input.to);
  const database = await getDatabase();
  await runSyncDatabaseTransaction(database, async (transaction) => {
    const result = await transaction.runAsync(
      `UPDATE sync_durable_intents
       SET state = ?, updated_at = ?
       WHERE operation_id = ? AND state = ? AND state != ?`,
      input.to,
      input.updatedAt,
      input.operationId,
      input.from,
      input.to,
    );
    if (result.changes === 1) return;
    if (result.changes !== 0) {
      throw new Error('durable intent 状态发生并发变化，未推进。');
    }
    const row = await transaction.getFirstAsync<{ state: SyncDurableIntentState }>(
      'SELECT state FROM sync_durable_intents WHERE operation_id = ?',
      input.operationId,
    );
    if (!row) throw new Error('durable intent 不存在。');
    if (row.state === input.to) return;
    if (row.state !== input.from) {
      throw new Error(`durable intent 当前为 ${row.state}，不能按 ${input.from} 推进。`);
    }
    throw new Error('durable intent 状态发生并发变化，未推进。');
  });
}

export async function loadIncompleteSyncDurableIntents() {
  const database = await getDatabase();
  const rows = await enqueueSyncDatabaseOperation(
    () => database.getAllAsync<DurableIntentRow>(
      `SELECT operation_id, adapter_id, intent_json, state, created_at, updated_at
       FROM sync_durable_intents
       WHERE state != 'captured'
       ORDER BY created_at ASC, operation_id ASC`,
    ),
  );
  return rows.map((row): SyncDurableIntent => {
    const intent: unknown = JSON.parse(row.intent_json);
    assertJsonValue(intent, 'intent');
    const restored: SyncDurableIntent = {
      operationId: row.operation_id,
      adapterId: row.adapter_id,
      intent,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    assertSyncDurableIntent(restored);
    return restored;
  });
}

function restoreSyncDurableIntent(row: DurableIntentRow) {
  const intent: unknown = JSON.parse(row.intent_json);
  assertJsonValue(intent, 'intent');
  const restored: SyncDurableIntent = {
    operationId: row.operation_id,
    adapterId: row.adapter_id,
    intent,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  assertSyncDurableIntent(restored);
  return restored;
}

export async function loadSyncDurableIntent(operationId: string) {
  assertToken(operationId, 'operationId');
  const database = await getDatabase();
  const row = await enqueueSyncDatabaseOperation(
    () => database.getFirstAsync<DurableIntentRow>(
      `SELECT operation_id, adapter_id, intent_json, state, created_at, updated_at
       FROM sync_durable_intents WHERE operation_id = ?`,
      operationId,
    ),
  );
  return row ? restoreSyncDurableIntent(row) : null;
}

/** Discard only the exact, still-unwritten intent a caller proved was cancelled. */
export async function discardPreparedSyncDurableIntent(intent: SyncDurableIntent) {
  assertSyncDurableIntent(intent);
  if (intent.state !== 'prepared') throw new Error('Only a prepared intent can be discarded.');
  const database = await getDatabase();
  await runSyncDatabaseTransaction(database, async (transaction) => {
    const row = await transaction.getFirstAsync<DurableIntentRow>(
      `SELECT operation_id, adapter_id, intent_json, state, created_at, updated_at
       FROM sync_durable_intents WHERE operation_id = ?`, intent.operationId,
    );
    if (!row) return;
    if (row.state !== 'prepared' || row.adapter_id !== intent.adapterId
      || row.intent_json !== JSON.stringify(intent.intent) || row.created_at !== intent.createdAt) {
      throw new Error('Durable intent changed; cancellation was not applied.');
    }
    await transaction.runAsync(
      `DELETE FROM sync_durable_intents WHERE operation_id = ? AND state = 'prepared'`, intent.operationId,
    );
  });
}

export async function closeSyncDatabaseForTests() {
  if (!databasePromise) return;
  const database = await databasePromise;
  await database.closeAsync();
  databasePromise = undefined;
}
