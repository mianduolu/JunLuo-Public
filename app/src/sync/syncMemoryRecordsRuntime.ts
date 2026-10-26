import type * as SQLite from 'expo-sqlite';
import { ensurePostReviewColumns } from './syncBaiyunPostReviews';

import {
  loadCurrentSyncDevice,
} from './syncCurrentDevice';
import type {
  SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  assertMemoryRecordPayload,
  MEMORY_RECORDS_SCHEMA_VERSION,
  MEMORY_RECORD_ENTITY_SPECS,
  type MemoryRecordEntitySpec,
} from './syncMemoryRecords';
import {
  promoteMemoryRecordsDomainOutbox,
  type PromoteMemoryRecordsOutboxReport,
} from './syncMemoryRecordsOutbox';
import {
  deactivateMemoryRecordsCapture,
  ensureMemoryRecordsCaptureSchema,
  memoryRecordsDomainOutboxPort,
  recoverExpiredMemoryRecordsOutboxLeases,
} from './syncMemoryRecordsSqlitePort';
import {
  enqueueCapturedMemoryRecordMutation,
  syncMutationStatePort,
} from './syncMutationStateStore';
import {
  getSyncEntityIdMaximumLength,
  type JsonValue,
} from './syncProtocol';

export const MEMORY_RECORDS_BOOTSTRAP_VERSION = 7 as const;
export const MEMORY_RECORDS_ADAPTER_ID = 'memory.records' as const;

export type MemoryRecordsBootstrapRuntimeResult =
  | {
      status: 'no-current-device';
      mutationCount: 0;
      captureEnabled: false;
    }
  | {
      status: 'already-complete' | 'completed';
      mutationCount: number;
      captureEnabled: true;
    };

export type MemoryRecordsPromotionRuntimeResult =
  | {
      status: 'no-current-device';
      recoveredLeaseCount: number;
      report: PromoteMemoryRecordsOutboxReport;
    }
  | {
      status: 'completed' | 'partial-failure';
      recoveredLeaseCount: number;
      report: PromoteMemoryRecordsOutboxReport;
    };

type BootstrapStateRow = {
  completed_at: number;
};

type RuntimeRow = {
  capture_enabled: number;
  suppress_capture: number;
  vault_id: string | null;
  source_device_id: string | null;
};

type HeadRow = {
  revision_id: string;
};

type GeneratedIdsRow = {
  mutation_id: string;
  revision_id: string;
};

const UUID_V4_SQL = `(
  lower(hex(randomblob(4))) || '-' ||
  lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
  substr('89ab', (random() & 3) + 1, 1) ||
  substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
  lower(hex(randomblob(6)))
)`;

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

export function buildMemoryRecordCurrentSnapshotEntityId(
  spec: MemoryRecordEntitySpec,
  record: Record<string, unknown>,
) {
  const values = spec.idColumns.map((column) => record[column]);
  if (values.some((value) => typeof value !== 'string' || !value)) {
    throw new Error(`memory.records ${spec.entityType} 缺少稳定业务 ID。`);
  }
  const entityId = values.length === 1
    ? values[0] as string
    : JSON.stringify(values);
  const maximumLength = getSyncEntityIdMaximumLength('memory', spec.entityType);
  if (entityId.length > maximumLength) {
    throw new Error(`memory.records ${spec.entityType} 复合业务 ID 超过 ${maximumLength} 字符。`);
  }
  return entityId;
}

export function buildMemoryRecordCurrentSnapshotRecord(
  spec: MemoryRecordEntitySpec,
  row: unknown,
) {
  const raw = recordOf(row, `memory.records bootstrap ${spec.tableName} row`);
  const record = Object.fromEntries(
    Object.keys(spec.fields).map((field) => [field, raw[field]]),
  );
  assertMemoryRecordPayload(
    spec.entityType,
    spec.insertOperation,
    {
      schemaVersion: spec.schemaVersion ?? MEMORY_RECORDS_SCHEMA_VERSION,
      record,
    },
  );
  return record as JsonValue & Record<string, unknown>;
}

async function generatedIds(transaction: SQLite.SQLiteDatabase) {
  const row = await transaction.getFirstAsync<GeneratedIdsRow>(
    `SELECT ${UUID_V4_SQL} AS mutation_id, ${UUID_V4_SQL} AS revision_id`,
  );
  if (!row) throw new Error('memory.records bootstrap 无法生成 mutation/revision ID。');
  return row;
}

async function isRetiredStayContinuityEventId(
  transaction: SQLite.SQLiteDatabase,
  eventId: unknown,
) {
  if (typeof eventId !== 'string' || !eventId) return false;
  const row = await transaction.getFirstAsync<{ primary_intent: string }>(
    'SELECT primary_intent FROM continuity_events WHERE id = ? LIMIT 1',
    eventId,
  );
  return row?.primary_intent === 'stay';
}

async function shouldSkipRetiredStaySnapshot(input: {
  transaction: SQLite.SQLiteDatabase;
  spec: MemoryRecordEntitySpec;
  row: Record<string, unknown>;
}) {
  if (input.spec.entityType === 'continuity-event') {
    return input.row.primary_intent === 'stay';
  }
  if (input.spec.entityType === 'continuity-candidate') {
    return true;
  }
  if (
    input.spec.entityType === 'continuity-transition'
    || input.spec.entityType === 'continuity-link'
  ) {
    return isRetiredStayContinuityEventId(input.transaction, input.row.event_id);
  }
  return false;
}

async function snapshotSpec(input: {
  transaction: SQLite.SQLiteDatabase;
  identity: SyncDevicePublicIdentityV1;
  spec: MemoryRecordEntitySpec;
  createdAt: number;
}) {
  const orderBy = input.spec.idColumns.map((column) => `"${column}" ASC`).join(', ');
  const rows = await input.transaction.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM "${input.spec.snapshotTableName ?? input.spec.tableName}" ORDER BY ${orderBy}`,
  );
  let mutationCount = 0;
  for (const row of rows) {
    if (input.spec.entityType === 'post-review' && row.owner_device_id !== input.identity.deviceId) continue;
    if (input.spec.entityType === 'post-review-action' && row.state !== 'pending' && row.owner_device_id !== input.identity.deviceId) continue;
    if (await shouldSkipRetiredStaySnapshot({
      transaction: input.transaction,
      spec: input.spec,
      row,
    })) continue;
    const record = buildMemoryRecordCurrentSnapshotRecord(input.spec, row);
    const entityId = buildMemoryRecordCurrentSnapshotEntityId(
      input.spec,
      record,
    );
    const parents = await input.transaction.getAllAsync<HeadRow>(
      `SELECT revision_id
       FROM memory_sync_entity_heads
       WHERE entity_type = ? AND entity_id = ?
       ORDER BY revision_id ASC`,
      input.spec.entityType,
      entityId,
    );
    if (parents.length > 32) {
      throw new Error('memory.records bootstrap entity heads 超过协议上限。');
    }
    const ids = await generatedIds(input.transaction);
    await input.transaction.runAsync(
      `INSERT INTO memory_sync_domain_outbox (
         mutation_id, revision_id, parent_revision_ids_json,
         vault_id, source_device_id, entity_type, entity_id,
         operation, schema_version, payload_json, state,
         available_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ids.mutation_id,
      ids.revision_id,
      JSON.stringify(parents.map((parent) => parent.revision_id)),
      input.identity.vaultId,
      input.identity.deviceId,
      input.spec.entityType,
      entityId,
      input.spec.insertOperation,
      input.spec.schemaVersion ?? MEMORY_RECORDS_SCHEMA_VERSION,
      JSON.stringify({
        schemaVersion: input.spec.schemaVersion ?? MEMORY_RECORDS_SCHEMA_VERSION,
        record,
      }),
      input.createdAt,
      input.createdAt,
      input.createdAt,
    );
    await input.transaction.runAsync(
      `DELETE FROM memory_sync_entity_heads
       WHERE entity_type = ? AND entity_id = ?`,
      input.spec.entityType,
      entityId,
    );
    await input.transaction.runAsync(
      `INSERT INTO memory_sync_entity_heads (
         entity_type, entity_id, revision_id, updated_at
       ) VALUES (?, ?, ?, ?)`,
      input.spec.entityType,
      entityId,
      ids.revision_id,
      input.createdAt,
    );
    mutationCount += 1;
  }
  return mutationCount;
}

export async function bootstrapMemoryRecordSpecsForIdentity(input: {
  adapterId: string;
  bootstrapVersion: number;
  identity: SyncDevicePublicIdentityV1;
  now: number;
  specs: readonly MemoryRecordEntitySpec[];
}): Promise<MemoryRecordsBootstrapRuntimeResult> {
  assertTimestamp(input.now, `${input.adapterId} bootstrap now`);
  if (
    !/^[a-z][a-z0-9.-]{0,79}$/.test(input.adapterId)
    || !Number.isSafeInteger(input.bootstrapVersion)
    || input.bootstrapVersion < 1
  ) {
    throw new Error('memory SQLite bootstrap adapter/version 无效。');
  }
  if (!input.specs.length) {
    throw new Error(`${input.adapterId} bootstrap 没有登记实体。`);
  }
  const database = await ensureMemoryRecordsCaptureSchema();
  let status: 'already-complete' | 'completed' = 'completed';
  let mutationCount = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const runtime = await transaction.getFirstAsync<RuntimeRow>(
      `SELECT capture_enabled, suppress_capture, vault_id, source_device_id
       FROM memory_sync_runtime WHERE singleton_id = 1`,
    );
    if (
      runtime?.capture_enabled === 1
      && (
        runtime.vault_id !== input.identity.vaultId
        || runtime.source_device_id !== input.identity.deviceId
      )
    ) {
      throw new Error('memory.records 已绑定另一 active vault/device，拒绝静默换绑。');
    }
    if (runtime?.suppress_capture === 1) {
      throw new Error('memory.records 正在应用远端变更，不能同时执行 bootstrap。');
    }
    await transaction.runAsync(
      `UPDATE memory_sync_runtime
       SET capture_enabled = 0,
           suppress_capture = 0,
           vault_id = ?,
           source_device_id = ?,
           updated_at = ?
       WHERE singleton_id = 1`,
      input.identity.vaultId,
      input.identity.deviceId,
      input.now,
    );
    // Persist identity while the original draft still contains reviewId; terminal
    // settlement later may intentionally remove its editor JSON.
    await ensurePostReviewColumns(transaction);
    const completed = await transaction.getFirstAsync<BootstrapStateRow>(
      `SELECT completed_at
       FROM memory_sync_bootstrap_state
       WHERE adapter_id = ?
         AND bootstrap_version = ?
         AND vault_id = ?
         AND source_device_id = ?`,
      input.adapterId,
      input.bootstrapVersion,
      input.identity.vaultId,
      input.identity.deviceId,
    );
    if (completed) {
      status = 'already-complete';
    } else {
      const previous = input.adapterId === MEMORY_RECORDS_ADAPTER_ID && input.bootstrapVersion >= 3
        ? await transaction.getFirstAsync<BootstrapStateRow & { bootstrap_version: number }>(`SELECT completed_at, bootstrap_version FROM memory_sync_bootstrap_state
            WHERE adapter_id = ? AND bootstrap_version IN (2,3,4,5,6) AND bootstrap_version < ? AND vault_id = ? AND source_device_id = ?
            ORDER BY bootstrap_version DESC LIMIT 1`,
          input.adapterId, input.bootstrapVersion, input.identity.vaultId, input.identity.deviceId) : null;
      const reviewKinds = ['post-review', 'post-review-action'];
      const addedKinds = previous?.bootstrap_version === 6 ? reviewKinds
        : previous?.bootstrap_version === 5 ? ['post-tag', ...reviewKinds]
        : previous?.bootstrap_version === 4 ? ['post-confirmation', 'post-tag', ...reviewKinds]
        : previous?.bootstrap_version === 3 ? ['post', 'post-comment', 'post-confirmation', 'post-tag', ...reviewKinds]
          : ['post', 'post-comment', 'post-tag', 'post-confirmation', ...reviewKinds];
      for (const spec of input.specs.filter(spec => !previous || addedKinds.includes(spec.entityType))) {
        mutationCount += await snapshotSpec({
          transaction,
          identity: input.identity,
          spec,
          createdAt: input.now,
        });
      }
      await transaction.runAsync(
        `INSERT INTO memory_sync_bootstrap_state (
           adapter_id, bootstrap_version, vault_id, source_device_id, completed_at
         ) VALUES (?, ?, ?, ?, ?)`,
        input.adapterId,
        input.bootstrapVersion,
        input.identity.vaultId,
        input.identity.deviceId,
        input.now,
      );
    }
    await transaction.runAsync(
      `UPDATE memory_sync_runtime
       SET capture_enabled = 1,
           suppress_capture = 0,
           updated_at = ?
       WHERE singleton_id = 1
         AND vault_id = ?
         AND source_device_id = ?`,
      input.now,
      input.identity.vaultId,
      input.identity.deviceId,
    );
  });
  return {
    status,
    mutationCount,
    captureEnabled: true as const,
  };
}

export async function runMemoryRecordsBootstrapRuntime(
  now = Date.now(),
  options: { allowDuringBackupRestore?: boolean } = {},
): Promise<MemoryRecordsBootstrapRuntimeResult> {
  assertTimestamp(now, 'memory.records bootstrap now');
  const currentDevice = await loadCurrentSyncDevice({
    allowDuringBackupRestore: options.allowDuringBackupRestore,
  });
  if (!currentDevice) {
    await deactivateMemoryRecordsCapture(now);
    return {
      status: 'no-current-device',
      mutationCount: 0,
      captureEnabled: false,
    };
  }
  const specs = MEMORY_RECORD_ENTITY_SPECS.filter(
    (spec) => (
      (spec.bootstrapAdapterId ?? MEMORY_RECORDS_ADAPTER_ID)
      === MEMORY_RECORDS_ADAPTER_ID
    ),
  );
  return bootstrapMemoryRecordSpecsForIdentity({
    adapterId: MEMORY_RECORDS_ADAPTER_ID,
    bootstrapVersion: MEMORY_RECORDS_BOOTSTRAP_VERSION,
    identity: currentDevice.identity,
    now,
    specs,
  });
}

function emptyPromotionReport(): PromoteMemoryRecordsOutboxReport {
  return {
    claimedCount: 0,
    dispatchedCount: 0,
    failed: [],
  };
}

export async function runMemoryRecordsOutboxPromotionRuntime(input: {
  now?: number;
  batchLimit?: number;
  maximumBatches?: number;
} = {}): Promise<MemoryRecordsPromotionRuntimeResult> {
  const now = input.now ?? Date.now();
  const batchLimit = input.batchLimit ?? 100;
  const maximumBatches = input.maximumBatches ?? 100;
  assertTimestamp(now, 'memory.records promotion now');
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 100) {
    throw new Error('memory.records promotion batchLimit 必须在 1–100 之间。');
  }
  if (!Number.isSafeInteger(maximumBatches) || maximumBatches < 1 || maximumBatches > 1_000) {
    throw new Error('memory.records promotion maximumBatches 必须在 1–1000 之间。');
  }
  const recoveredLeaseCount = await recoverExpiredMemoryRecordsOutboxLeases(now);
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      recoveredLeaseCount,
      report: emptyPromotionReport(),
    };
  }
  const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
  const aggregate = emptyPromotionReport();
  for (let index = 0; index < maximumBatches; index += 1) {
    const leaseId = `memory-records:${await expoSyncRandomUuidV1()}`;
    const report = await promoteMemoryRecordsDomainOutbox({
      identity: currentDevice.identity,
      leaseId,
      now,
      limit: batchLimit,
      leaseDurationMs: 60_000,
      domainOutbox: memoryRecordsDomainOutboxPort,
      mutationState: syncMutationStatePort,
      centralOutbox: {
        enqueueSyncMutation: enqueueCapturedMemoryRecordMutation,
      },
    });
    aggregate.claimedCount += report.claimedCount;
    aggregate.dispatchedCount += report.dispatchedCount;
    aggregate.failed.push(...report.failed);
    if (report.failed.length || report.claimedCount < batchLimit) break;
  }
  return {
    status: aggregate.failed.length ? 'partial-failure' : 'completed',
    recoveredLeaseCount,
    report: aggregate,
  };
}


