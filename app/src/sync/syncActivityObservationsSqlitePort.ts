import type * as SQLite from 'expo-sqlite';

import { getPhoneActivityDatabase } from '../phoneActivity/phoneActivityStore';
import {
  assertActivityObservationsDomainOutboxEntry,
  type ActivityObservationsDomainOutboxEntry,
  type ActivityObservationsDomainOutboxPort,
  type ActivityObservationsOutboxState,
  type ClaimedActivityObservationsOutboxEntry,
} from './syncActivityObservationsOutbox';
import {
  ACTIVITY_OBSERVATIONS_CAPTURE_SCHEMA_VERSION,
  ACTIVITY_OBSERVATIONS_EXPECTED_CAPTURE_TRIGGER_COUNT,
  ACTIVITY_OBSERVATIONS_STORAGE_SCHEMA_VERSION,
} from './syncActivityObservationsSql';
import type { JsonValue, SyncOperation } from './syncProtocol';

type ActivityObservationsOutboxRow = {
  local_sequence: number;
  mutation_id: string;
  revision_id: string;
  parent_revision_ids_json: string;
  vault_id: string;
  source_device_id: string;
  source_sequence: number | null;
  entity_type: ActivityObservationsDomainOutboxEntry['entityType'];
  entity_id: string;
  operation: SyncOperation;
  schema_version: number;
  payload_json: string;
  state: ActivityObservationsOutboxState;
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
  source_platform: 'android' | 'windows' | null;
};

type SchemaMetadataRow = {
  storage_schema_version: number;
  capture_schema_version: number;
  trigger_count: number;
};

const MAX_CLAIM_LIMIT = 100;
const MAX_BACKOFF_MS = 30 * 60_000;

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertPositiveInteger(
  value: number,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} 必须是 1–${maximum} 的安全整数。`);
  }
}

function assertLeaseId(value: string) {
  if (
    !value
    || value.length > 160
    || !/^[A-Za-z0-9._:-]+$/u.test(value)
  ) {
    throw new Error('activity.observations outbox leaseId 格式无效。');
  }
}

function parseJsonArray(raw: string, label: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
  if (
    !Array.isArray(parsed)
    || parsed.some((value) => typeof value !== 'string')
  ) {
    throw new Error(`${label} 必须是字符串数组。`);
  }
  return parsed as string[];
}

function parseJsonValue(raw: string, label: string) {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
}

function rowToEntry(
  row: ActivityObservationsOutboxRow,
): ActivityObservationsDomainOutboxEntry {
  const entry: ActivityObservationsDomainOutboxEntry = {
    localSequence: row.local_sequence,
    mutationId: row.mutation_id,
    revisionId: row.revision_id,
    parentRevisionIds: parseJsonArray(
      row.parent_revision_ids_json,
      'activity observations parentRevisionIds',
    ),
    vaultId: row.vault_id,
    sourceDeviceId: row.source_device_id,
    sourceSequence: row.source_sequence,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    schemaVersion: row.schema_version,
    payload: parseJsonValue(row.payload_json, 'activity observations payload'),
    state: row.state,
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  assertActivityObservationsDomainOutboxEntry(entry);
  return entry;
}

async function loadEntry(
  database: SQLite.SQLiteDatabase,
  localSequence: number,
) {
  const row = await database.getFirstAsync<ActivityObservationsOutboxRow>(
    `SELECT * FROM activity_sync_domain_outbox
     WHERE local_sequence = ?`,
    localSequence,
  );
  if (!row) throw new Error('activity observations outbox 行不存在。');
  return rowToEntry(row);
}

export async function ensureActivityObservationsCaptureSchema() {
  const database = await getPhoneActivityDatabase();
  const metadata = await database.getFirstAsync<SchemaMetadataRow>(
    `SELECT storage_schema_version, capture_schema_version, trigger_count
     FROM activity_sync_schema_meta WHERE singleton_id = 1`,
  );
  if (
    metadata?.storage_schema_version
      !== ACTIVITY_OBSERVATIONS_STORAGE_SCHEMA_VERSION
    || metadata.capture_schema_version
      !== ACTIVITY_OBSERVATIONS_CAPTURE_SCHEMA_VERSION
    || metadata.trigger_count
      !== ACTIVITY_OBSERVATIONS_EXPECTED_CAPTURE_TRIGGER_COUNT
  ) {
    throw new Error(
      'activity.observations 静态 schema 元数据不完整，拒绝启用捕获。',
    );
  }
  const triggers = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM sqlite_master
     WHERE type = 'trigger'
       AND name LIKE 'activity_sync_capture_%'`,
  );
  if (
    triggers?.count
      !== ACTIVITY_OBSERVATIONS_EXPECTED_CAPTURE_TRIGGER_COUNT
  ) {
    throw new Error(
      `activity.observations 捕获触发器不完整：${triggers?.count ?? 0}/`
      + `${ACTIVITY_OBSERVATIONS_EXPECTED_CAPTURE_TRIGGER_COUNT}。`,
    );
  }
  return database;
}

export async function deactivateActivityObservationsCapture(
  updatedAt = Date.now(),
) {
  assertTimestamp(updatedAt, 'activity observations capture updatedAt');
  const database = await ensureActivityObservationsCaptureSchema();
  await database.runAsync(
    `UPDATE activity_sync_runtime
     SET capture_enabled = 0,
         suppress_capture = 0,
         vault_id = NULL,
         source_device_id = NULL,
         source_platform = NULL,
         updated_at = ?
     WHERE singleton_id = 1`,
    updatedAt,
  );
}

export async function loadActivityObservationsCaptureRuntime() {
  const database = await ensureActivityObservationsCaptureSchema();
  const row = await database.getFirstAsync<RuntimeRow>(
    `SELECT capture_enabled, suppress_capture, vault_id,
            source_device_id, source_platform
     FROM activity_sync_runtime WHERE singleton_id = 1`,
  );
  return {
    captureEnabled: row?.capture_enabled === 1,
    captureSuppressed: row?.suppress_capture === 1,
    vaultId: row?.vault_id ?? null,
    sourceDeviceId: row?.source_device_id ?? null,
    sourcePlatform: row?.source_platform ?? null,
  };
}

export async function runWithActivityObservationsCaptureSuppressed<T>(
  apply: (transaction: SQLite.SQLiteDatabase) => Promise<T>,
) {
  const database = await ensureActivityObservationsCaptureSchema();
  let result!: T;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const runtime = await transaction.getFirstAsync<RuntimeRow>(
      `SELECT capture_enabled, suppress_capture, vault_id,
              source_device_id, source_platform
       FROM activity_sync_runtime WHERE singleton_id = 1`,
    );
    if (!runtime || runtime.suppress_capture !== 0) {
      throw new Error(
        'activity.observations capture suppression 已被占用。',
      );
    }
    await transaction.runAsync(
      `UPDATE activity_sync_runtime SET suppress_capture = 1
       WHERE singleton_id = 1 AND suppress_capture = 0`,
    );
    try {
      result = await apply(transaction);
    } finally {
      await transaction.runAsync(
        `UPDATE activity_sync_runtime SET suppress_capture = 0
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
    `UPDATE activity_sync_domain_outbox
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

export const activityObservationsDomainOutboxPort:
ActivityObservationsDomainOutboxPort = {
  async claimPending(input) {
    assertLeaseId(input.leaseId);
    assertTimestamp(input.now, 'activity observations claim now');
    assertPositiveInteger(
      input.leaseDurationMs,
      'activity observations leaseDurationMs',
    );
    assertPositiveInteger(
      input.limit,
      'activity observations claim limit',
      MAX_CLAIM_LIMIT,
    );
    const database = await ensureActivityObservationsCaptureSchema();
    let rows: ActivityObservationsOutboxRow[] = [];
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await releaseExpiredLeases(transaction, input.now);
      rows = await transaction.getAllAsync<ActivityObservationsOutboxRow>(
        `SELECT * FROM activity_sync_domain_outbox
         WHERE state = 'pending' AND available_at <= ?
         ORDER BY local_sequence ASC LIMIT ?`,
        input.now,
        input.limit,
      );
      for (const row of rows) {
        const result = await transaction.runAsync(
          `UPDATE activity_sync_domain_outbox
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
          throw new Error(
            'activity observations outbox 领取竞争失败，事务已回滚。',
          );
        }
      }
    });
    return rows.map((row): ClaimedActivityObservationsOutboxEntry => {
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

  async reserveSourceSequence(input) {
    assertPositiveInteger(
      input.localSequence,
      'activity observations localSequence',
    );
    assertLeaseId(input.leaseId);
    assertPositiveInteger(
      input.sourceSequence,
      'activity observations sourceSequence',
    );
    assertTimestamp(input.updatedAt, 'activity observations reserve updatedAt');
    const database = await ensureActivityObservationsCaptureSchema();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const existing = await loadEntry(
        transaction,
        input.localSequence,
      );
      if (
        existing.state !== 'leased'
        || existing.leaseId !== input.leaseId
      ) {
        throw new Error(
          'activity observations sourceSequence 只能由当前租约写入。',
        );
      }
      if (
        existing.sourceSequence !== null
        && existing.sourceSequence !== input.sourceSequence
      ) {
        throw new Error(
          'activity observations outbox 已绑定不同 sourceSequence。',
        );
      }
      if (existing.sourceSequence === null) {
        const result = await transaction.runAsync(
          `UPDATE activity_sync_domain_outbox
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
        if (result.changes !== 1) {
          throw new Error(
            'activity observations sourceSequence 持久化失败。',
          );
        }
      }
    });
    const entry = await loadEntry(database, input.localSequence);
    if (
      entry.state !== 'leased'
      || entry.leaseId !== input.leaseId
      || entry.sourceSequence !== input.sourceSequence
      || entry.leaseExpiresAt === null
    ) {
      throw new Error(
        'activity observations sourceSequence 持久化校验失败。',
      );
    }
    return {
      ...entry,
      state: 'leased',
      leaseId: input.leaseId,
      leaseExpiresAt: entry.leaseExpiresAt,
    };
  },

  async markDispatched(input) {
    assertPositiveInteger(
      input.localSequence,
      'activity observations localSequence',
    );
    assertLeaseId(input.leaseId);
    assertTimestamp(
      input.dispatchedAt,
      'activity observations dispatchedAt',
    );
    const database = await ensureActivityObservationsCaptureSchema();
    const result = await database.runAsync(
      `UPDATE activity_sync_domain_outbox
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
      throw new Error(
        'activity observations outbox dispatched 状态迁移失败。',
      );
    }
  },

  async releaseFailed(input) {
    assertPositiveInteger(
      input.localSequence,
      'activity observations localSequence',
    );
    assertLeaseId(input.leaseId);
    assertTimestamp(input.failedAt, 'activity observations failedAt');
    if (
      !input.errorCode
      || input.errorCode.length > 160
      || !/^[a-z0-9][a-z0-9._-]*$/u.test(input.errorCode)
    ) {
      throw new Error('activity observations errorCode 格式无效。');
    }
    const database = await ensureActivityObservationsCaptureSchema();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const entry = await loadEntry(
        transaction,
        input.localSequence,
      );
      if (
        entry.state !== 'leased'
        || entry.leaseId !== input.leaseId
      ) {
        throw new Error(
          'activity observations outbox 失败释放只能由当前租约执行。',
        );
      }
      const nextAttempt = entry.attemptCount + 1;
      const delay = Math.min(
        MAX_BACKOFF_MS,
        1_000 * (2 ** Math.min(nextAttempt, 10)),
      );
      const result = await transaction.runAsync(
        `UPDATE activity_sync_domain_outbox
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
        throw new Error(
          'activity observations outbox 失败释放状态迁移失败。',
        );
      }
    });
  },
};

export async function recoverExpiredActivityObservationsOutboxLeases(
  now = Date.now(),
) {
  assertTimestamp(now, 'activity observations recovery now');
  const database = await ensureActivityObservationsCaptureSchema();
  const before = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count FROM activity_sync_domain_outbox
     WHERE state = 'leased'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at <= ?`,
    now,
  );
  await releaseExpiredLeases(database, now);
  return before?.count ?? 0;
}
