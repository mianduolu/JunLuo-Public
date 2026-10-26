import type * as SQLite from 'expo-sqlite';
import { hasTheaterStorySchema } from './syncTheaterStorySqlite';
import { THEATER_STORY_BOOTSTRAP_INSERT_SQL } from './syncTheaterStorySql';

import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  assertSyncDevicePublicIdentityV1,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  assertTheaterIsolatedPayload,
  THEATER_ISOLATED_ADAPTER_ID,
} from './syncTheaterIsolated';
import {
  promoteTheaterIsolatedDomainOutbox,
  type PromoteTheaterIsolatedOutboxReport,
} from './syncTheaterIsolatedOutbox';
import {
  deactivateTheaterIsolatedCapture,
  ensureTheaterIsolatedCaptureSchema,
  recoverExpiredTheaterIsolatedOutboxLeases,
  theaterIsolatedDomainOutboxPort,
} from './syncTheaterIsolatedSqlitePort';
import {
  THEATER_ISOLATED_BOOTSTRAP_INSERT_SQL,
  THEATER_ISOLATED_CAPTURE_LEASE_MS,
} from './syncTheaterIsolatedSql';
import {
  enqueueSyncMutationAndAdvanceHeads,
  syncMutationStatePort,
} from './syncMutationStateStore';

export const THEATER_ISOLATED_BOOTSTRAP_VERSION = 1 as const;

export type TheaterIsolatedBootstrapRuntimeResult =
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

export type TheaterIsolatedPromotionRuntimeResult =
  | {
      status: 'no-current-device';
      recoveredLeaseCount: number;
      report: PromoteTheaterIsolatedOutboxReport;
    }
  | {
      status: 'completed' | 'partial-failure';
      recoveredLeaseCount: number;
      report: PromoteTheaterIsolatedOutboxReport;
    };

type RuntimeRow = {
  capture_enabled: number;
  suppress_capture: number;
  vault_id: string | null;
  source_device_id: string | null;
};

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

async function latestLocalSequence(
  transaction: SQLite.SQLiteDatabase,
) {
  const row = await transaction.getFirstAsync<{
    value: number | null;
  }>(
    'SELECT MAX(local_sequence) AS value FROM theater_sync_domain_outbox',
  );
  return row?.value ?? 0;
}

async function advanceBootstrapHeads(input: {
  transaction: SQLite.SQLiteDatabase;
  afterSequence: number;
  throughSequence: number;
  updatedAt: number;
}) {
  if (input.throughSequence <= input.afterSequence) return;
  const excessiveParents =
    await input.transaction.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM theater_sync_domain_outbox
       WHERE local_sequence > ?
         AND local_sequence <= ?
         AND json_array_length(parent_revision_ids_json) > 32`,
      input.afterSequence,
      input.throughSequence,
    );
  if ((excessiveParents?.count ?? 0) > 0) {
    throw new Error(
      'theater.isolated bootstrap entity heads 超过协议上限。',
    );
  }
  await input.transaction.runAsync(
    `INSERT OR IGNORE INTO theater_sync_entity_heads (
       entity_type, entity_id, revision_id, updated_at
     )
     SELECT entity_type, entity_id, revision_id, ?
     FROM theater_sync_domain_outbox
     WHERE local_sequence > ? AND local_sequence <= ?`,
    input.updatedAt,
    input.afterSequence,
    input.throughSequence,
  );
}

async function snapshotTheaterRows(input: {
  transaction: SQLite.SQLiteDatabase;
  now: number;
}) {
  let mutationCount = 0;
  const statements = await hasTheaterStorySchema(input.transaction)
    ? THEATER_STORY_BOOTSTRAP_INSERT_SQL : THEATER_ISOLATED_BOOTSTRAP_INSERT_SQL;
  for (const statement of statements) {
    const before = await latestLocalSequence(input.transaction);
    const result = await input.transaction.runAsync(
      statement,
      input.now,
      input.now,
      input.now,
    );
    const after = await latestLocalSequence(input.transaction);
    if (after - before !== result.changes) {
      throw new Error(
        'theater.isolated bootstrap outbox 序列增量校验失败。',
      );
    }
    const inserted = await input.transaction.getAllAsync<{
      entity_id: string;
      operation: string;
      payload_json: string;
    }>(
      `SELECT entity_id, operation, payload_json
       FROM theater_sync_domain_outbox
       WHERE local_sequence > ? AND local_sequence <= ?
       ORDER BY local_sequence ASC`,
      before,
      after,
    );
    for (const row of inserted) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json) as unknown;
      } catch {
        throw new Error(
          'theater.isolated bootstrap 生成了无效 JSON。',
        );
      }
      assertTheaterIsolatedPayload(
        row.entity_id,
        row.operation,
        payload,
      );
    }
    await advanceBootstrapHeads({
      transaction: input.transaction,
      afterSequence: before,
      throughSequence: after,
      updatedAt: input.now,
    });
    mutationCount += result.changes;
  }
  return mutationCount;
}

export async function bootstrapTheaterIsolatedForIdentity(input: {
  identity: SyncDevicePublicIdentityV1;
  now: number;
}): Promise<TheaterIsolatedBootstrapRuntimeResult> {
  assertSyncDevicePublicIdentityV1(input.identity);
  if (
    input.identity.state !== 'active'
    || input.identity.revokedAt !== null
  ) {
    throw new Error(
      '只有 active 且未撤销的设备可以 bootstrap theater.isolated。',
    );
  }
  assertTimestamp(input.now, 'theater bootstrap now');
  const database = await ensureTheaterIsolatedCaptureSchema();
  const bootstrapVersion = await hasTheaterStorySchema(database) ? 2 : THEATER_ISOLATED_BOOTSTRAP_VERSION;
  let status: 'already-complete' | 'completed' = 'completed';
  let mutationCount = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const runtime = await transaction.getFirstAsync<RuntimeRow>(
      `SELECT capture_enabled, suppress_capture, vault_id, source_device_id
       FROM theater_sync_runtime WHERE singleton_id = 1`,
    );
    if (
      runtime?.capture_enabled === 1
      && (
        runtime.vault_id !== input.identity.vaultId
        || runtime.source_device_id !== input.identity.deviceId
      )
    ) {
      throw new Error(
        'theater.isolated 已绑定另一 active vault/device，拒绝静默换绑。',
      );
    }
    if (runtime?.suppress_capture === 1) {
      throw new Error(
        'theater.isolated 正在应用远端变更，不能 bootstrap。',
      );
    }
    await transaction.runAsync(
      `UPDATE theater_sync_runtime
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
    const completed = await transaction.getFirstAsync<{
      completed_at: number;
    }>(
      `SELECT completed_at FROM theater_sync_bootstrap_state
       WHERE adapter_id = ?
         AND bootstrap_version = ?
         AND vault_id = ?
         AND source_device_id = ?`,
      THEATER_ISOLATED_ADAPTER_ID,
      bootstrapVersion,
      input.identity.vaultId,
      input.identity.deviceId,
    );
    if (completed) {
      status = 'already-complete';
    } else {
      mutationCount = await snapshotTheaterRows({
        transaction,
        now: input.now,
      });
      await transaction.runAsync(
        `INSERT INTO theater_sync_bootstrap_state (
           adapter_id, bootstrap_version, vault_id,
           source_device_id, completed_at
         ) VALUES (?, ?, ?, ?, ?)`,
        THEATER_ISOLATED_ADAPTER_ID,
        bootstrapVersion,
        input.identity.vaultId,
        input.identity.deviceId,
        input.now,
      );
    }
    await transaction.runAsync(
      `UPDATE theater_sync_runtime
       SET capture_enabled = 1,
           suppress_capture = 0,
           vault_id = ?,
           source_device_id = ?,
           updated_at = ?
       WHERE singleton_id = 1`,
      input.identity.vaultId,
      input.identity.deviceId,
      input.now,
    );
  });
  return { status, mutationCount, captureEnabled: true };
}

export async function runTheaterIsolatedBootstrapRuntime(
  now = Date.now(),
): Promise<TheaterIsolatedBootstrapRuntimeResult> {
  assertTimestamp(now, 'theater runtime now');
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    await deactivateTheaterIsolatedCapture(now);
    return {
      status: 'no-current-device',
      mutationCount: 0,
      captureEnabled: false,
    };
  }
  await deactivateTheaterIsolatedCapture(now);
  return bootstrapTheaterIsolatedForIdentity({
    identity: currentDevice.identity,
    now,
  });
}

function emptyPromotionReport(): PromoteTheaterIsolatedOutboxReport {
  return { claimedCount: 0, dispatchedCount: 0, failed: [] };
}

export async function runTheaterIsolatedOutboxPromotionRuntime(input: {
  limit?: number;
  now?: number;
} = {}): Promise<TheaterIsolatedPromotionRuntimeResult> {
  const now = input.now ?? Date.now();
  assertTimestamp(now, 'theater promotion now');
  const recoveredLeaseCount =
    await recoverExpiredTheaterIsolatedOutboxLeases(now);
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      recoveredLeaseCount,
      report: emptyPromotionReport(),
    };
  }
  const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
  const report = await promoteTheaterIsolatedDomainOutbox({
    identity: currentDevice.identity,
    leaseId: `theater-isolated:${expoSyncRandomUuidV1()}`,
    now,
    limit: input.limit ?? 100,
    leaseDurationMs: THEATER_ISOLATED_CAPTURE_LEASE_MS,
    domainOutbox: theaterIsolatedDomainOutboxPort,
    mutationState: syncMutationStatePort,
    centralOutbox: {
      enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
    },
  });
  return {
    status: report.failed.length ? 'partial-failure' : 'completed',
    recoveredLeaseCount,
    report,
  };
}
