import * as SQLite from 'expo-sqlite';
import { isRetiredContinuityCard } from '../ai/behavior/continuityMatterRecord';
import { canonicalizeJsonV1 } from './syncCrypto';

import {
  getMemoryDatabase as getMemoryDatabaseForSource,
} from '../memory/memoryStore';
import {
  assertSyncDevicePublicIdentityV1,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  isRetiredStayMemoryRecordPayload,
  readBaiyunPostImageAssets,
} from './syncMemoryRecords';
import {
  assertMemoryRecordsDomainOutboxEntry,
  materializeMemoryRecordsMutation,
  type ClaimedMemoryRecordsOutboxEntry,
  type MemoryRecordsDomainOutboxEntry,
  type MemoryRecordsDomainOutboxPort,
  type MemoryRecordsOutboxState,
} from './syncMemoryRecordsOutbox';
import {
  MEMORY_RECORDS_CAPTURE_LEASE_MS,
  MEMORY_RECORDS_EXPECTED_CAPTURE_TRIGGER_COUNT,
  MEMORY_RECORDS_STORAGE_SCHEMA_VERSION,
} from './syncMemoryRecordsSql';
import type {
  JsonValue,
  PlainMutationV1,
  SyncOperation,
} from './syncProtocol';

const getMemoryDatabase = () => getMemoryDatabaseForSource('sync_capture');

type MemoryRecordsOutboxRow = {
  local_sequence: number;
  mutation_id: string;
  revision_id: string;
  parent_revision_ids_json: string;
  vault_id: string;
  source_device_id: string;
  source_sequence: number | null;
  entity_type: MemoryRecordsDomainOutboxEntry['entityType'];
  entity_id: string;
  operation: SyncOperation;
  schema_version: number;
  payload_json: string;
  state: MemoryRecordsOutboxState;
  attempt_count: number;
  available_at: number;
  lease_id: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
};

type RuntimeRow = {
  capture_enabled: number;
  suppress_capture: number;
  vault_id: string | null;
  source_device_id: string | null;
};

type SchemaMetadataRow = {
  schema_version: number;
};

type TriggerCountRow = {
  count: number;
};

const MAX_CLAIM_LIMIT = 100;
const MAX_BACKOFF_MS = 30 * 60_000;

let captureSchemaReady = false;
let captureSchemaPromise: Promise<SQLite.SQLiteDatabase> | undefined;

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertPositiveInteger(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} 必须是 1–${maximum} 的安全整数。`);
  }
}

function assertLeaseId(value: string) {
  if (!value || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error('memory outbox leaseId 格式无效。');
  }
}

function parseJsonArray(raw: string, label: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error(`${label} 必须是字符串数组。`);
  }
  return parsed as string[];
}

function parseJsonValue(raw: string, label: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
  return parsed as JsonValue;
}

function rowToEntry(row: MemoryRecordsOutboxRow): MemoryRecordsDomainOutboxEntry {
  const entry: MemoryRecordsDomainOutboxEntry = {
    localSequence: row.local_sequence,
    mutationId: row.mutation_id,
    revisionId: row.revision_id,
    parentRevisionIds: parseJsonArray(
      row.parent_revision_ids_json,
      'memory outbox parentRevisionIds',
    ),
    vaultId: row.vault_id,
    sourceDeviceId: row.source_device_id,
    sourceSequence: row.source_sequence,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    schemaVersion: row.schema_version,
    payload: parseJsonValue(row.payload_json, 'memory outbox payload'),
    state: row.state,
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  assertMemoryRecordsDomainOutboxEntry(entry);
  return entry;
}

async function loadEntry(
  database: SQLite.SQLiteDatabase,
  localSequence: number,
) {
  const row = await database.getFirstAsync<MemoryRecordsOutboxRow>(
    `SELECT *
     FROM memory_sync_domain_outbox
     WHERE local_sequence = ?`,
    localSequence,
  );
  if (!row) throw new Error('memory outbox 行不存在。');
  return rowToEntry(row);
}

/** Only an exact, previously saved native packet may resume after central heads move. */
export async function isPersistedCapturedMemoryMutation(mutation: PlainMutationV1) {
  if (mutation.entity.domain !== 'memory' || mutation.entity.type !== 'memory'
    || !['upsert', 'delete'].includes(mutation.revision.operation)
    || mutation.revision.parents.length < 2) return false;
  const database = await ensureMemoryRecordsCaptureSchema();
  const rows = await database.getAllAsync<MemoryRecordsOutboxRow>(
    `SELECT * FROM memory_sync_domain_outbox
     WHERE mutation_id = ? OR revision_id = ? LIMIT 2`,
    mutation.mutationId, mutation.revision.id,
  );
  if (rows.length !== 1) return false;
  const entry = rowToEntry(rows[0]);
  if (entry.state === 'quarantined' || entry.sourceSequence === null) return false;
  return canonicalizeJsonV1(materializeMemoryRecordsMutation(entry)) === canonicalizeJsonV1(mutation);
}

function tryPayloadRecord(payload: JsonValue) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = (payload as { record?: unknown }).record;
  return record && typeof record === 'object' && !Array.isArray(record)
    ? record as Record<string, unknown>
    : undefined;
}

async function isRetiredStayEventId(
  database: SQLite.SQLiteDatabase,
  eventId: unknown,
) {
  if (typeof eventId !== 'string' || !eventId) return false;
  const current = await database.getFirstAsync<Record<string, unknown>>(
    'SELECT * FROM continuity_events WHERE id = ? LIMIT 1',
    eventId,
  );
  if (current?.schema_version === 2) return false;
  if (current && isRetiredContinuityCard(current)) return true;
  const revisions = await database.getAllAsync<{ payload_json: string }>(
    `SELECT payload_json FROM memory_sync_revision_log
     WHERE entity_type = 'continuity-event' AND entity_id = ?
     UNION ALL
     SELECT payload_json FROM memory_sync_domain_outbox
     WHERE entity_type = 'continuity-event' AND entity_id = ?`,
    eventId,
    eventId,
  );
  return revisions.some((revision) => {
    try {
      const record = tryPayloadRecord(
        parseJsonValue(revision.payload_json, 'continuity event revision payload'),
      );
      return record ? isRetiredContinuityCard(record) : false;
    } catch {
      return false;
    }
  });
}

async function shouldSuppressRetiredStayEntry(
  database: SQLite.SQLiteDatabase,
  entry: MemoryRecordsDomainOutboxEntry,
) {
  if (entry.entityType === 'continuity-candidate') return true;
  if (isRetiredStayMemoryRecordPayload(entry.entityType, entry.payload)) return true;
  const records = [tryPayloadRecord(entry.payload)].filter(
    (record): record is Record<string, unknown> => Boolean(record),
  );
  if (entry.entityType === 'continuity-event') {
    return isRetiredStayEventId(database, entry.entityId);
  }
  if (entry.entityType === 'continuity-link' && !records.length) {
    try {
      const ids = JSON.parse(entry.entityId) as unknown;
      if (Array.isArray(ids) && await isRetiredStayEventId(database, ids[0])) return true;
    } catch {
      return false;
    }
  }
  if (
    entry.entityType !== 'continuity-transition'
    && entry.entityType !== 'continuity-link'
  ) return false;
  for (const record of records) {
    if (record.primary_intent === 'stay') return true;
    const eventIds = [record.event_id];
    for (const eventId of eventIds) {
      if (await isRetiredStayEventId(database, eventId)) return true;
    }
  }
  return false;
}

export async function ensureMemoryRecordsCaptureSchema() {
  if (captureSchemaReady) return getMemoryDatabase();
  if (!captureSchemaPromise) {
    const schemaPromise = (async () => {
      const database = await getMemoryDatabase();
      const metadata = await database.getFirstAsync<SchemaMetadataRow>(
        `SELECT schema_version
         FROM memory_sync_schema_metadata
         WHERE singleton_id = 1`,
      );
      if (metadata?.schema_version !== MEMORY_RECORDS_STORAGE_SCHEMA_VERSION) {
        throw new Error(
          'memory.records 静态 schema 尚未由 memoryStore 完整安装，拒绝运行期补建。',
        );
      }
      const triggers = await database.getFirstAsync<TriggerCountRow>(
        `SELECT COUNT(*) AS count
         FROM sqlite_master
         WHERE type = 'trigger'
           AND name LIKE 'memory_sync_capture_%'`,
      );
      if (triggers?.count !== MEMORY_RECORDS_EXPECTED_CAPTURE_TRIGGER_COUNT) {
        throw new Error(
          `memory.records 捕获触发器不完整：`
          + `${triggers?.count ?? 0}/${MEMORY_RECORDS_EXPECTED_CAPTURE_TRIGGER_COUNT}。`,
        );
      }
      captureSchemaReady = true;
      return database;
    })();
    captureSchemaPromise = schemaPromise;
    schemaPromise.catch(() => {
      if (captureSchemaPromise === schemaPromise) {
        captureSchemaPromise = undefined;
      }
    });
  }
  return captureSchemaPromise;
}

export async function activateMemoryRecordsCapture(
  identity: SyncDevicePublicIdentityV1,
  updatedAt = Date.now(),
) {
  assertSyncDevicePublicIdentityV1(identity);
  if (identity.state !== 'active' || identity.revokedAt !== null) {
    throw new Error('只有 active 且未撤销的设备可以启用 memory.records 捕获。');
  }
  assertTimestamp(updatedAt, 'memory capture updatedAt');
  const database = await ensureMemoryRecordsCaptureSchema();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const existing = await transaction.getFirstAsync<RuntimeRow>(
      `SELECT capture_enabled, suppress_capture, vault_id, source_device_id
       FROM memory_sync_runtime
       WHERE singleton_id = 1`,
    );
    if (
      existing?.capture_enabled === 1
      && (
        existing.vault_id !== identity.vaultId
        || existing.source_device_id !== identity.deviceId
      )
    ) {
      throw new Error('memory.records 捕获已经绑定到另一 vault/device，拒绝静默换绑。');
    }
    await transaction.runAsync(
      `UPDATE memory_sync_runtime
       SET capture_enabled = 1,
           suppress_capture = 0,
           vault_id = ?,
           source_device_id = ?,
           updated_at = ?
       WHERE singleton_id = 1`,
      identity.vaultId,
      identity.deviceId,
      updatedAt,
    );
  });
}

export async function deactivateMemoryRecordsCapture(updatedAt = Date.now()) {
  assertTimestamp(updatedAt, 'memory capture updatedAt');
  const database = await ensureMemoryRecordsCaptureSchema();
  await database.runAsync(
    `UPDATE memory_sync_runtime
     SET capture_enabled = 0,
         suppress_capture = 0,
         vault_id = NULL,
         source_device_id = NULL,
         updated_at = ?
     WHERE singleton_id = 1`,
    updatedAt,
  );
}

export async function loadMemoryRecordsCaptureRuntime() {
  const database = await ensureMemoryRecordsCaptureSchema();
  const row = await database.getFirstAsync<RuntimeRow>(
    `SELECT capture_enabled, suppress_capture, vault_id, source_device_id
     FROM memory_sync_runtime
     WHERE singleton_id = 1`,
  );
  return {
    captureEnabled: row?.capture_enabled === 1,
    captureSuppressed: row?.suppress_capture === 1,
    vaultId: row?.vault_id ?? null,
    sourceDeviceId: row?.source_device_id ?? null,
  };
}

export async function runWithMemoryRecordsCaptureSuppressed<T>(
  apply: (transaction: SQLite.SQLiteDatabase) => Promise<T>,
) {
  const database = await ensureMemoryRecordsCaptureSchema();
  let result!: T;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const runtime = await transaction.getFirstAsync<RuntimeRow>(
      `SELECT capture_enabled, suppress_capture, vault_id, source_device_id
       FROM memory_sync_runtime
       WHERE singleton_id = 1`,
    );
    if (!runtime || runtime.suppress_capture !== 0) {
      throw new Error('memory.records capture suppression 已被占用。');
    }
    await transaction.runAsync(
      `UPDATE memory_sync_runtime
       SET suppress_capture = 1
       WHERE singleton_id = 1 AND suppress_capture = 0`,
    );
    try {
      result = await apply(transaction);
    } finally {
      await transaction.runAsync(
        `UPDATE memory_sync_runtime
         SET suppress_capture = 0
         WHERE singleton_id = 1`,
      );
    }
  });
  return result;
}

async function releaseExpiredLeases(
  database: SQLite.SQLiteDatabase,
  now: number,
) {
  await database.runAsync(
    `UPDATE memory_sync_domain_outbox
     SET state = 'pending',
         lease_id = NULL,
         lease_expires_at = NULL,
         updated_at = ?
     WHERE state = 'leased'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at <= ?`,
    now,
    now,
  );
}

export const memoryRecordsDomainOutboxPort: MemoryRecordsDomainOutboxPort = {
  async claimPending(input) {
    assertLeaseId(input.leaseId);
    assertTimestamp(input.now, 'memory outbox claim now');
    assertPositiveInteger(input.leaseDurationMs, 'memory outbox leaseDurationMs');
    assertPositiveInteger(input.limit, 'memory outbox claim limit', MAX_CLAIM_LIMIT);
    const database = await ensureMemoryRecordsCaptureSchema();
    let rows: MemoryRecordsOutboxRow[] = [];
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await releaseExpiredLeases(transaction, input.now);
      rows = await transaction.getAllAsync<MemoryRecordsOutboxRow>(
        `SELECT *
         FROM memory_sync_domain_outbox
         WHERE state = 'pending' AND available_at <= ?
         ORDER BY local_sequence ASC
         LIMIT ?`,
        input.now,
        input.limit,
      );
      for (const row of rows) {
        const result = await transaction.runAsync(
          `UPDATE memory_sync_domain_outbox
           SET state = 'leased',
               lease_id = ?,
               lease_expires_at = ?,
               updated_at = ?
           WHERE local_sequence = ? AND state = 'pending'`,
          input.leaseId,
          input.now + input.leaseDurationMs,
          input.now,
          row.local_sequence,
        );
        if (result.changes !== 1) {
          throw new Error('memory outbox 领取竞争失败，事务已回滚。');
        }
      }
    });
    return rows.map((row): ClaimedMemoryRecordsOutboxEntry => {
      const entry = rowToEntry({
        ...row,
        state: 'leased',
        lease_id: input.leaseId,
        lease_expires_at: input.now + input.leaseDurationMs,
        updated_at: input.now,
      });
      return {
        ...entry,
        state: 'leased',
        leaseId: input.leaseId,
        leaseExpiresAt: input.now + input.leaseDurationMs,
      };
    });
  },

  async prepareObjects(entry, now) {
    if (![6, 9].includes(entry.schemaVersion) || entry.operation === 'delete'
      || !['post', 'post-comment'].includes(entry.entityType)) return entry;
    const [{ loadCurrentSyncDevice }, { prepareBaiyunPostImagesPayload }] = await Promise.all([
      import('./syncCurrentDevice'), import('./syncBaiyunPostImagesRuntime'),
    ]);
    const current = await loadCurrentSyncDevice();
    if (!current || current.identity.vaultId !== entry.vaultId || current.identity.deviceId !== entry.sourceDeviceId) {
      throw new Error('post image preparation identity 已变化。');
    }
    const payload = await prepareBaiyunPostImagesPayload({ payload: entry.payload, ...current, now });
    const serialized = JSON.stringify(payload);
    await runWithMemoryRecordsCaptureSuppressed(async transaction => {
      const existing = await loadEntry(transaction, entry.localSequence);
      if (existing.state !== 'leased' || existing.leaseId !== entry.leaseId
        || JSON.stringify(existing.payload) !== JSON.stringify(entry.payload)) throw new Error('post image preparation lease/payload 已变化。');
      if (existing.sourceSequence !== null && serialized !== JSON.stringify(existing.payload)) {
        throw new Error('post image 已分配 sourceSequence，拒绝改写 payload。');
      }
      await transaction.runAsync('UPDATE memory_sync_domain_outbox SET payload_json = ?, updated_at = ? WHERE local_sequence = ? AND lease_id = ?',
        serialized, now, entry.localSequence, entry.leaseId);
      const record = (payload as { record: Record<string, unknown> }).record;
      for (const asset of readBaiyunPostImageAssets(record)) {
        await transaction.runAsync(`UPDATE baiyun_post_images SET object_id = ?, chunk_count = ?
          WHERE id = ? AND width = ? AND height = ? AND byte_size = ?`, asset.object_id, asset.chunk_count,
        asset.id, asset.width, asset.height, asset.byte_size);
      }
    });
    return { ...entry, payload, updatedAt: now };
  },

  async reserveSourceSequence(input) {
    assertPositiveInteger(input.localSequence, 'memory outbox localSequence');
    assertLeaseId(input.leaseId);
    assertPositiveInteger(input.sourceSequence, 'memory outbox sourceSequence');
    assertTimestamp(input.updatedAt, 'memory outbox reserve updatedAt');
    const database = await ensureMemoryRecordsCaptureSchema();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const existing = await loadEntry(transaction, input.localSequence);
      if (
        existing.state !== 'leased'
        || existing.leaseId !== input.leaseId
      ) {
        throw new Error('memory outbox sourceSequence 只能由当前租约写入。');
      }
      if (
        existing.sourceSequence !== null
        && existing.sourceSequence !== input.sourceSequence
      ) {
        throw new Error('memory outbox 已绑定不同 sourceSequence。');
      }
      if (existing.sourceSequence === null) {
        await transaction.runAsync(
          `UPDATE memory_sync_domain_outbox
           SET source_sequence = ?, updated_at = ?
           WHERE local_sequence = ?
             AND state = 'leased'
             AND lease_id = ?
             AND source_sequence IS NULL`,
          input.sourceSequence,
          input.updatedAt,
          input.localSequence,
          input.leaseId,
        );
      }
    });
    const entry = await loadEntry(database, input.localSequence);
    if (
      entry.state !== 'leased'
      || entry.leaseId !== input.leaseId
      || entry.sourceSequence !== input.sourceSequence
      || entry.leaseExpiresAt === null
    ) {
      throw new Error('memory outbox sourceSequence 持久化校验失败。');
    }
    return {
      ...entry,
      state: 'leased',
      leaseId: input.leaseId,
      leaseExpiresAt: entry.leaseExpiresAt,
    };
  },

  async shouldSuppressOutbound(entry) {
    assertMemoryRecordsDomainOutboxEntry(entry);
    const database = await ensureMemoryRecordsCaptureSchema();
    return shouldSuppressRetiredStayEntry(database, entry);
  },

  async markSuppressed(input) {
    assertPositiveInteger(input.localSequence, 'memory outbox localSequence');
    assertLeaseId(input.leaseId);
    assertTimestamp(input.suppressedAt, 'memory outbox suppressedAt');
    const database = await ensureMemoryRecordsCaptureSchema();
    const result = await database.runAsync(
      `UPDATE memory_sync_domain_outbox
       SET state = 'dispatched',
           lease_id = NULL,
           lease_expires_at = NULL,
           dispatched_at = ?,
           updated_at = ?
       WHERE local_sequence = ?
         AND state = 'leased'
         AND lease_id = ?`,
      input.suppressedAt,
      input.suppressedAt,
      input.localSequence,
      input.leaseId,
    );
    if (result.changes !== 1) {
      throw new Error('memory outbox retired-stay 静默归档失败。');
    }
  },

  async markDispatched(input) {
    assertPositiveInteger(input.localSequence, 'memory outbox localSequence');
    assertLeaseId(input.leaseId);
    assertTimestamp(input.dispatchedAt, 'memory outbox dispatchedAt');
    const database = await ensureMemoryRecordsCaptureSchema();
    const result = await database.runAsync(
      `UPDATE memory_sync_domain_outbox
       SET state = 'dispatched',
           lease_id = NULL,
           lease_expires_at = NULL,
           dispatched_at = ?,
           updated_at = ?
       WHERE local_sequence = ?
         AND state = 'leased'
         AND lease_id = ?
         AND source_sequence IS NOT NULL`,
      input.dispatchedAt,
      input.dispatchedAt,
      input.localSequence,
      input.leaseId,
    );
    if (result.changes !== 1) {
      throw new Error('memory outbox dispatched 状态迁移失败。');
    }
  },

  async releaseFailed(input) {
    assertPositiveInteger(input.localSequence, 'memory outbox localSequence');
    assertLeaseId(input.leaseId);
    assertTimestamp(input.failedAt, 'memory outbox failedAt');
    if (
      !input.errorCode
      || input.errorCode.length > 160
      || !/^[a-z0-9][a-z0-9._-]*$/.test(input.errorCode)
    ) {
      throw new Error('memory outbox errorCode 格式无效。');
    }
    const database = await ensureMemoryRecordsCaptureSchema();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const entry = await loadEntry(transaction, input.localSequence);
      if (entry.state !== 'leased' || entry.leaseId !== input.leaseId) {
        throw new Error('memory outbox 失败释放只能由当前租约执行。');
      }
      const nextAttempt = entry.attemptCount + 1;
      const delay = Math.min(MAX_BACKOFF_MS, 1_000 * (2 ** Math.min(nextAttempt, 10)));
      const result = await transaction.runAsync(
        `UPDATE memory_sync_domain_outbox
         SET state = 'pending',
             attempt_count = ?,
             available_at = ?,
             lease_id = NULL,
             lease_expires_at = NULL,
             last_error_code = ?,
             updated_at = ?
         WHERE local_sequence = ?
           AND state = 'leased'
           AND lease_id = ?`,
        nextAttempt,
        input.failedAt + delay,
        input.errorCode,
        input.failedAt,
        input.localSequence,
        input.leaseId,
      );
      if (result.changes !== 1) {
        throw new Error('memory outbox 失败释放状态迁移失败。');
      }
    });
  },
};

export async function loadMemoryRecordsOutboxEntries(options: {
  state?: MemoryRecordsOutboxState;
  limit?: number;
} = {}) {
  const limit = options.limit ?? MAX_CLAIM_LIMIT;
  assertPositiveInteger(limit, 'memory outbox load limit', MAX_CLAIM_LIMIT);
  const database = await ensureMemoryRecordsCaptureSchema();
  const rows = options.state
    ? await database.getAllAsync<MemoryRecordsOutboxRow>(
      `SELECT *
       FROM memory_sync_domain_outbox
       WHERE state = ?
       ORDER BY local_sequence ASC
       LIMIT ?`,
      options.state,
      limit,
    )
    : await database.getAllAsync<MemoryRecordsOutboxRow>(
      `SELECT *
       FROM memory_sync_domain_outbox
       ORDER BY local_sequence ASC
       LIMIT ?`,
      limit,
    );
  return rows.map(rowToEntry);
}

export async function recoverExpiredMemoryRecordsOutboxLeases(
  now = Date.now(),
) {
  assertTimestamp(now, 'memory outbox recovery now');
  const database = await ensureMemoryRecordsCaptureSchema();
  const before = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM memory_sync_domain_outbox
     WHERE state = 'leased'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at <= ?`,
    now,
  );
  await releaseExpiredLeases(database, now);
  return before?.count ?? 0;
}

export type MemoryRecordsDomainDrainSnapshot = {
  pendingOrLeased: number;
  quarantined: number;
  markerMutationId: string | null;
};

export async function loadMemoryRecordsDomainDrainSnapshot(
  markerEntityId: string,
): Promise<MemoryRecordsDomainDrainSnapshot> {
  const database = await ensureMemoryRecordsCaptureSchema();
  const counts = await database.getFirstAsync<{
    pending_or_leased: number;
    quarantined: number;
  }>(
    `SELECT
       SUM(CASE WHEN state IN ('pending', 'leased') THEN 1 ELSE 0 END)
         AS pending_or_leased,
       SUM(CASE WHEN state = 'quarantined' THEN 1 ELSE 0 END)
         AS quarantined
     FROM memory_sync_domain_outbox`,
  );
  const marker = await database.getFirstAsync<{ mutation_id: string }>(
    `SELECT mutation_id
     FROM memory_sync_domain_outbox
     WHERE entity_type = 'lifecycle-event'
       AND entity_id = ?
     ORDER BY local_sequence DESC
     LIMIT 1`,
    markerEntityId,
  );
  return {
    pendingOrLeased: counts?.pending_or_leased ?? 0,
    quarantined: counts?.quarantined ?? 0,
    markerMutationId: marker?.mutation_id ?? null,
  };
}

export const DEFAULT_MEMORY_RECORDS_CAPTURE_LEASE_MS = MEMORY_RECORDS_CAPTURE_LEASE_MS;

export function resetMemoryRecordsCaptureSchemaForTests() {
  captureSchemaReady = false;
  captureSchemaPromise = undefined;
}



