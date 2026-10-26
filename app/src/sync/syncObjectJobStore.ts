import * as SQLite from 'expo-sqlite';

import {
  canEvictLocalSyncObject,
} from './syncObjectPolicy';
import {
  assertPlainMutationV1,
  type PlainMutationV1,
} from './syncProtocol';
import {
  openInitializedSyncDatabase,
} from './syncDatabaseOpen';
import {
  enqueueSyncDatabaseOperation,
} from './syncDatabaseOperationQueue';

export type SyncObjectJob = {
  objectId: string;
  direction: 'upload' | 'download';
  keyId: string;
  totalChunks: number;
  completedChunks: number;
  state: 'pending' | 'running' | 'verified' | 'failed';
  pinned: boolean;
  localUri: string | null;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
};

type ObjectJobRow = {
  object_id: string;
  direction: SyncObjectJob['direction'];
  key_id: string;
  total_chunks: number;
  completed_chunks: number;
  state: SyncObjectJob['state'];
  pinned: number;
  local_uri: string | null;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
};

type ObjectRetentionStateRow = {
  unreferenced_at: number | null;
  local_evicted_at: number | null;
};

type ObjectMaterializationRow = {
  object_id: string;
  adapter_id: string;
  reference_fingerprint: string;
  state: SyncObjectMaterializationState['state'];
  last_error_code: string | null;
  updated_at: number;
};

type VerifiedObjectRetentionRow = ObjectRetentionStateRow & {
  object_id: string;
  state: SyncObjectJob['state'];
  pinned: number;
  local_uri: string | null;
};

export const MAX_ANDROID_OBJECT_TRANSFERS_PER_DIRECTION = 16;

export type SyncObjectProgressSnapshot = {
  objectJobs: number;
  blockedObjectJobs: number;
  completedObjectChunks: number;
  totalObjectChunks: number;
};

export async function loadSyncObjectProgressSnapshot():
Promise<SyncObjectProgressSnapshot> {
  const database = await getObjectJobDatabase();
  const row = await enqueueSyncDatabaseOperation(() => (
    database.getFirstAsync<{
      object_jobs: number;
      blocked_object_jobs: number;
      completed_chunks: number;
      total_chunks: number;
    }>(
      `SELECT COUNT(*) AS object_jobs,
              COALESCE(SUM(CASE
                WHEN last_error_code = 'object.source-missing' THEN 1
                ELSE 0
              END), 0) AS blocked_object_jobs,
              COALESCE(SUM(completed_chunks), 0) AS completed_chunks,
              COALESCE(SUM(total_chunks), 0) AS total_chunks
       FROM sync_object_jobs
       WHERE state != 'verified'`,
    )
  ));
  return {
    objectJobs: row?.object_jobs ?? 0,
    blockedObjectJobs: row?.blocked_object_jobs ?? 0,
    completedObjectChunks: row?.completed_chunks ?? 0,
    totalObjectChunks: row?.total_chunks ?? 0,
  };
}

type MutationJsonRow = {
  mutation_json: string;
};

type ObjectReferenceCountRow = {
  object_id: string;
  live_count: number;
};

export type SyncCurrentObjectReference = {
  domain: string;
  entityType: string;
  entityId: string;
  mutation: PlainMutationV1;
};

export type SyncObjectMaterializationState = {
  objectId: string;
  adapterId: string;
  referenceFingerprint: string;
  state: 'pending' | 'materialized' | 'failed';
  lastErrorCode: string | null;
  updatedAt: number;
};

export type SyncObjectRetentionCandidate = {
  objectId: string;
  pinned: boolean;
  remoteVerified: boolean;
  liveReferenceCount: number;
  unreferencedAt: number | null;
  localUri: string;
};

type DeviceSigningRow = {
  vault_id: string;
  key_id: string;
  signing_public_key: string;
  state: 'pending' | 'active' | 'revoked';
};

let objectJobDatabasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertUuid(value: string, label: string) {
  expect(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value),
    `${label} 必须是小写 UUID v4。`,
  );
}

function assertObjectId(value: string) {
  expect(/^[A-Za-z0-9_-]{43}$/.test(value), 'objectId 必须是 32 bytes 无填充 base64url。');
}

function rowToJob(row: ObjectJobRow): SyncObjectJob {
  return {
    objectId: row.object_id,
    direction: row.direction,
    keyId: row.key_id,
    totalChunks: row.total_chunks,
    completedChunks: row.completed_chunks,
    state: row.state,
    pinned: row.pinned === 1,
    localUri: row.local_uri,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getObjectJobDatabase() {
  if (!objectJobDatabasePromise) {
    const openingDatabasePromise = openInitializedSyncDatabase(
      '同步数据库版本高于当前应用，无法调度对象任务。',
    );
    const retryableDatabasePromise = openingDatabasePromise.catch(
      (error) => {
        if (
          objectJobDatabasePromise
          === retryableDatabasePromise
        ) {
          objectJobDatabasePromise = undefined;
        }
        throw error;
      },
    );
    objectJobDatabasePromise = retryableDatabasePromise;
  }
  return objectJobDatabasePromise;
}

export async function scheduleSyncObjectUpload(input: {
  objectId: string;
  keyId: string;
  totalChunks: number;
  localUri: string;
  now: number;
}) {
  assertObjectId(input.objectId);
  assertUuid(input.keyId, 'object job keyId');
  expect(
    Number.isSafeInteger(input.totalChunks)
      && input.totalChunks >= 1
      && input.totalChunks <= 100_000,
    'object job totalChunks 无效。',
  );
  expect(/^file:\/\//.test(input.localUri), 'object job localUri 必须是本机 file URI。');
  expect(Number.isSafeInteger(input.now) && input.now >= 0, 'object job now 无效。');
  const database = await getObjectJobDatabase();
  await enqueueSyncDatabaseOperation(() => (
    database.withExclusiveTransactionAsync(async (transaction) => {
    const existing = await transaction.getFirstAsync<ObjectJobRow>(
      `SELECT object_id, direction, key_id, total_chunks, completed_chunks,
              state, pinned, local_uri, last_error_code, created_at, updated_at
       FROM sync_object_jobs WHERE object_id = ?`,
      input.objectId,
    );
    if (existing) {
      expect(existing.key_id === input.keyId, '同一 objectId 已属于不同 keyId。');
      expect(
        existing.total_chunks === input.totalChunks,
        '同一 objectId 的 totalChunks 不一致。',
      );
      await transaction.runAsync(
        `UPDATE sync_object_jobs
         SET direction = 'upload',
             state = CASE WHEN state = 'verified' THEN 'verified' ELSE 'pending' END,
             completed_chunks = CASE WHEN state = 'verified' THEN total_chunks ELSE completed_chunks END,
             local_uri = ?,
             last_error_code = NULL,
             updated_at = ?
         WHERE object_id = ?`,
        input.localUri,
        input.now,
        input.objectId,
      );
      return;
    }
    await transaction.runAsync(
      `INSERT INTO sync_object_jobs (
         object_id, direction, key_id, total_chunks, completed_chunks,
         state, pinned, local_uri, last_error_code, created_at, updated_at
       ) VALUES (?, 'upload', ?, ?, 0, 'pending', 0, ?, NULL, ?, ?)`,
      input.objectId,
      input.keyId,
      input.totalChunks,
      input.localUri,
      input.now,
      input.now,
    );
    })
  ));
}

export async function loadSyncObjectJob(objectId: string) {
  assertObjectId(objectId);
  const database = await getObjectJobDatabase();
  const row = await enqueueSyncDatabaseOperation(() => (
    database.getFirstAsync<ObjectJobRow>(
      `SELECT object_id, direction, key_id, total_chunks, completed_chunks,
              state, pinned, local_uri, last_error_code, created_at, updated_at
       FROM sync_object_jobs WHERE object_id = ?`,
      objectId,
    )
  ));
  return row ? rowToJob(row) : null;
}


export async function scheduleSyncObjectDownload(input: {
  objectId: string;
  keyId: string;
  totalChunks: number;
  now: number;
}) {
  assertObjectId(input.objectId);
  assertUuid(input.keyId, 'object download keyId');
  expect(
    Number.isSafeInteger(input.totalChunks)
      && input.totalChunks >= 1
      && input.totalChunks <= 100_000,
    'object download totalChunks 无效。',
  );
  expect(
    Number.isSafeInteger(input.now) && input.now >= 0,
    'object download now 无效。',
  );
  const database = await getObjectJobDatabase();
  await enqueueSyncDatabaseOperation(() => (
    database.withExclusiveTransactionAsync(async (transaction) => {
    const existing = await transaction.getFirstAsync<ObjectJobRow>(
      `SELECT object_id, direction, key_id, total_chunks, completed_chunks,
              state, pinned, local_uri, last_error_code, created_at, updated_at
       FROM sync_object_jobs WHERE object_id = ?`,
      input.objectId,
    );
    if (existing) {
      if (existing.local_uri && existing.state === 'verified') return;
      if (
        existing.direction === 'upload'
        && existing.state !== 'verified'
      ) {
        throw new Error('尚未验收的 upload 不能改为 download。');
      }
      await transaction.runAsync(
        `UPDATE sync_object_jobs
         SET direction = 'download',
             state = CASE WHEN state = 'running' THEN 'running' ELSE 'pending' END,
             completed_chunks = CASE WHEN state = 'verified' THEN 0 ELSE completed_chunks END,
             last_error_code = NULL,
             updated_at = ?
         WHERE object_id = ?`,
        input.now,
        input.objectId,
      );
      return;
    }
    await transaction.runAsync(
      `INSERT INTO sync_object_jobs (
         object_id, direction, key_id, total_chunks, completed_chunks,
         state, pinned, local_uri, last_error_code, created_at, updated_at
       ) VALUES (?, 'download', ?, ?, 0, 'pending', 0, NULL, NULL, ?, ?)`,
      input.objectId,
      input.keyId,
      input.totalChunks,
      input.now,
      input.now,
    );
    })
  ));
}

export async function listRunnableSyncObjectJobs(
  direction: SyncObjectJob['direction'],
  limit = MAX_ANDROID_OBJECT_TRANSFERS_PER_DIRECTION,
  input: { includeSourceMissing?: boolean } = {},
) {
  expect(
    direction === 'upload' || direction === 'download',
    'object job direction 无效。',
  );
  expect(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 16,
    'object job list limit 必须为 1..16。',
  );
  const database = await getObjectJobDatabase();
  const rows = await enqueueSyncDatabaseOperation(() => (
    database.getAllAsync<ObjectJobRow>(
      `SELECT object_id, direction, key_id, total_chunks,
              completed_chunks, state, pinned, local_uri,
              last_error_code, created_at, updated_at
       FROM sync_object_jobs
       WHERE direction = ? AND state IN ('pending', 'running', 'failed')
         AND (? = 1 OR COALESCE(last_error_code, '') != 'object.source-missing')
       ORDER BY updated_at ASC, object_id ASC
       LIMIT ?`,
      direction,
      input.includeSourceMissing === false ? 0 : 1,
      limit,
    )
  ));
  return rows.map(rowToJob);
}

export async function startSyncObjectUploadJob(
  objectId: string,
  startedAt: number,
) {
  assertObjectId(objectId);
  expect(Number.isSafeInteger(startedAt) && startedAt >= 0, 'object upload startedAt 无效。');
  const database = await getObjectJobDatabase();
  let job: SyncObjectJob | null = null;
  await enqueueSyncDatabaseOperation(() => (
    database.withExclusiveTransactionAsync(async (transaction) => {
    const row = await transaction.getFirstAsync<ObjectJobRow>(
      `SELECT object_id, direction, key_id, total_chunks,
              completed_chunks, state, pinned, local_uri,
              last_error_code, created_at, updated_at
       FROM sync_object_jobs WHERE object_id = ?`,
      objectId,
    );
    if (!row || row.direction !== 'upload' || !row.local_uri) {
      throw new Error('object upload 任务不存在或缺少受管本机文件。');
    }
    await transaction.runAsync(
      `UPDATE sync_object_jobs
       SET state = 'running', last_error_code = NULL,
           updated_at = ? WHERE object_id = ?`,
      startedAt,
      objectId,
    );
    row.state = 'running';
    row.last_error_code = null;
    row.updated_at = startedAt;
    job = rowToJob(row);
    })
  ));
  return job!;
}

export async function startSyncObjectDownloadJob(input: {
  objectId: string;
  keyId: string;
  totalChunks: number;
  completedChunks: number;
  stagingUri: string;
  startedAt: number;
}) {
  assertObjectId(input.objectId);
  assertUuid(input.keyId, 'object download keyId');
  expect(
    Number.isSafeInteger(input.totalChunks)
      && input.totalChunks >= 1
      && input.totalChunks <= 100_000
      && Number.isSafeInteger(input.completedChunks)
      && input.completedChunks >= 0
      && input.completedChunks <= input.totalChunks,
    'object download chunk 计数无效。',
  );
  expect(/^file:\/\//.test(input.stagingUri), 'object download stagingUri 必须是 file URI。');
  expect(Number.isSafeInteger(input.startedAt) && input.startedAt >= 0, 'object download startedAt 无效。');
  const database = await getObjectJobDatabase();
  let job: SyncObjectJob | null = null;
  await enqueueSyncDatabaseOperation(() => (
    database.withExclusiveTransactionAsync(async (transaction) => {
    const row = await transaction.getFirstAsync<ObjectJobRow>(
      `SELECT object_id, direction, key_id, total_chunks,
              completed_chunks, state, pinned, local_uri,
              last_error_code, created_at, updated_at
       FROM sync_object_jobs WHERE object_id = ?`,
      input.objectId,
    );
    if (
      row
      && row.direction === 'upload'
      && row.state !== 'verified'
    ) {
      throw new Error('同一 objectId 的下载任务合同发生变化。');
    }
    const mayRebindUnstartedManifest = !!row
      && row.direction === 'download'
      && row.state !== 'running'
      && row.completed_chunks === 0;
    if (
      row
      && row.total_chunks !== input.totalChunks
      && !mayRebindUnstartedManifest
    ) {
      throw new Error('同一 objectId 的 totalChunks 发生变化。');
    }
    if (row) {
      await transaction.runAsync(
        `UPDATE sync_object_jobs
         SET direction = 'download', state = 'running',
             key_id = ?, total_chunks = ?,
             completed_chunks = ?, local_uri = ?,
             last_error_code = NULL, updated_at = ?
         WHERE object_id = ?`,
        input.keyId,
        input.totalChunks,
        input.completedChunks,
        input.stagingUri,
        input.startedAt,
        input.objectId,
      );
    } else {
      await transaction.runAsync(
        `INSERT INTO sync_object_jobs (
           object_id, direction, key_id, total_chunks,
           completed_chunks, state, pinned, local_uri,
           last_error_code, created_at, updated_at
         ) VALUES (?, 'download', ?, ?, ?, 'running', 0, ?, NULL, ?, ?)`,
        input.objectId,
        input.keyId,
        input.totalChunks,
        input.completedChunks,
        input.stagingUri,
        input.startedAt,
        input.startedAt,
      );
    }
    const next = await transaction.getFirstAsync<ObjectJobRow>(
      `SELECT object_id, direction, key_id, total_chunks,
              completed_chunks, state, pinned, local_uri,
              last_error_code, created_at, updated_at
       FROM sync_object_jobs WHERE object_id = ?`,
      input.objectId,
    );
    if (!next) throw new Error('object download 任务落盘失败。');
    job = rowToJob(next);
    })
  ));
  return job!;
}

export async function updateSyncObjectJobProgress(input: {
  objectId: string;
  direction: SyncObjectJob['direction'];
  completedChunks: number;
  updatedAt: number;
}) {
  assertObjectId(input.objectId);
  expect(Number.isSafeInteger(input.completedChunks) && input.completedChunks >= 0, 'object job completedChunks 无效。');
  expect(Number.isSafeInteger(input.updatedAt) && input.updatedAt >= 0, 'object job updatedAt 无效。');
  const database = await getObjectJobDatabase();
  const result = await enqueueSyncDatabaseOperation(() => (
    database.runAsync(
      `UPDATE sync_object_jobs
       SET completed_chunks = ?, updated_at = ?
       WHERE object_id = ? AND direction = ? AND state = 'running'
         AND ? BETWEEN completed_chunks AND total_chunks`,
      input.completedChunks,
      input.updatedAt,
      input.objectId,
      input.direction,
      input.completedChunks,
    )
  ));
  if (result.changes !== 1) {
    throw new Error('object job 进度不能倒退或任务不存在。');
  }
}

export async function markSyncObjectJobVerified(input: {
  objectId: string;
  direction: SyncObjectJob['direction'];
  localUri: string;
  verifiedAt: number;
}) {
  assertObjectId(input.objectId);
  expect(/^file:\/\//.test(input.localUri), 'verified object localUri 必须是 file URI。');
  expect(Number.isSafeInteger(input.verifiedAt) && input.verifiedAt >= 0, 'object verifiedAt 无效。');
  const database = await getObjectJobDatabase();
  await enqueueSyncDatabaseOperation(() => (
    database.withExclusiveTransactionAsync(async (transaction) => {
    const result = await transaction.runAsync(
      `UPDATE sync_object_jobs
       SET state = 'verified', completed_chunks = total_chunks,
           local_uri = ?, last_error_code = NULL, updated_at = ?
       WHERE object_id = ? AND direction = ?
         AND state IN ('running', 'verified')`,
      input.localUri,
      input.verifiedAt,
      input.objectId,
      input.direction,
    );
    if (result.changes !== 1) {
      throw new Error('object job 无法标记 verified。');
    }
    const liveReferenceCount = (
      await currentObjectReferencesIn(transaction, input.objectId)
    ).length;
    const existing = await transaction.getFirstAsync<
      ObjectRetentionStateRow
    >(
      `SELECT unreferenced_at, local_evicted_at
       FROM sync_object_retention_state WHERE object_id = ?`,
      input.objectId,
    );
    const unreferencedAt = liveReferenceCount === 0
      ? existing?.unreferenced_at ?? input.verifiedAt
      : null;
    await transaction.runAsync(
      `INSERT INTO sync_object_retention_state (
         object_id, unreferenced_at, local_evicted_at, updated_at
       ) VALUES (?, ?, NULL, ?)
       ON CONFLICT(object_id) DO UPDATE SET
         unreferenced_at = excluded.unreferenced_at,
         local_evicted_at = NULL,
         updated_at = excluded.updated_at`,
      input.objectId,
      unreferencedAt,
      input.verifiedAt,
    );
    })
  ));
}

export async function markSyncObjectJobFailed(input: {
  objectId: string;
  direction: SyncObjectJob['direction'];
  errorCode: string;
  failedAt: number;
}) {
  assertObjectId(input.objectId);
  expect(/^[a-z0-9._-]{1,80}$/.test(input.errorCode), 'object job errorCode 格式无效。');
  expect(Number.isSafeInteger(input.failedAt) && input.failedAt >= 0, 'object failedAt 无效。');
  const database = await getObjectJobDatabase();
  const result = await enqueueSyncDatabaseOperation(() => (
    database.runAsync(
      `UPDATE sync_object_jobs
       SET state = 'failed', last_error_code = ?, updated_at = ?
       WHERE object_id = ? AND direction = ? AND state = 'running'`,
      input.errorCode,
      input.failedAt,
      input.objectId,
      input.direction,
    )
  ));
  if (result.changes !== 1) throw new Error('object job 无法标记 failed。');
}

export async function resolveSyncObjectSigningPublicKey(input: {
  vaultId: string;
  deviceId: string;
  keyId: string;
}) {
  assertUuid(input.vaultId, 'object signer vaultId');
  assertUuid(input.deviceId, 'object signer deviceId');
  assertUuid(input.keyId, 'object signer keyId');
  const database = await getObjectJobDatabase();
  const row = await enqueueSyncDatabaseOperation(() => (
    database.getFirstAsync<DeviceSigningRow>(
      `SELECT vault_id, key_id, signing_public_key, state
       FROM sync_device_state
       WHERE device_id = ? AND key_id = ?`,
      input.deviceId,
      input.keyId,
    )
  ));
  if (
    !row
    || row.vault_id !== input.vaultId
    || row.key_id !== input.keyId
  ) {
    throw new Error('object 来源设备、vault 或 keyId 未登记。');
  }
  if (row.state === 'pending') {
    throw new Error('pending 设备不能签署同步对象。');
  }
  return row.signing_public_key;
}

function rowToMaterializationState(
  row: ObjectMaterializationRow,
): SyncObjectMaterializationState {
  return {
    objectId: row.object_id,
    adapterId: row.adapter_id,
    referenceFingerprint: row.reference_fingerprint,
    state: row.state,
    lastErrorCode: row.last_error_code,
    updatedAt: row.updated_at,
  };
}

function assertAdapterId(value: string) {
  expect(
    /^[a-z0-9][a-z0-9.-]{0,79}$/.test(value),
    'object materialization adapterId 无效。',
  );
}

function assertReferenceFingerprint(value: string) {
  expect(
    typeof value === 'string'
      && value.length >= 2
      && value.length <= 16_384,
    'object materialization referenceFingerprint 无效。',
  );
}

export async function listVerifiedSyncObjectJobs(input: {
  limit?: number;
  afterObjectId?: string | null;
} = {}) {
  const limit = input.limit ?? 16;
  expect(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 256,
    'verified object job limit 必须为 1..256。',
  );
  if (input.afterObjectId) assertObjectId(input.afterObjectId);
  const database = await getObjectJobDatabase();
  const rows = await enqueueSyncDatabaseOperation(() => (
    input.afterObjectId
      ? database.getAllAsync<ObjectJobRow>(
      `SELECT object_id, direction, key_id, total_chunks,
              completed_chunks, state, pinned, local_uri,
              last_error_code, created_at, updated_at
       FROM sync_object_jobs
       WHERE state = 'verified' AND local_uri IS NOT NULL
         AND object_id > ?
       ORDER BY object_id ASC LIMIT ?`,
      input.afterObjectId,
      limit,
    )
      : database.getAllAsync<ObjectJobRow>(
      `SELECT object_id, direction, key_id, total_chunks,
              completed_chunks, state, pinned, local_uri,
              last_error_code, created_at, updated_at
       FROM sync_object_jobs
       WHERE state = 'verified' AND local_uri IS NOT NULL
       ORDER BY object_id ASC LIMIT ?`,
      limit,
    )
  ));
  return rows.map(rowToJob);
}

export async function loadSyncObjectMaterializationState(input: {
  objectId: string;
  adapterId: string;
}) {
  assertObjectId(input.objectId);
  assertAdapterId(input.adapterId);
  const database = await getObjectJobDatabase();
  const row = await enqueueSyncDatabaseOperation(() => (
    database.getFirstAsync<ObjectMaterializationRow>(
      `SELECT object_id, adapter_id, reference_fingerprint,
              state, last_error_code, updated_at
       FROM sync_object_materializations
       WHERE object_id = ? AND adapter_id = ?`,
      input.objectId,
      input.adapterId,
    )
  ));
  return row ? rowToMaterializationState(row) : null;
}

export async function saveSyncObjectMaterializationState(input: {
  objectId: string;
  adapterId: string;
  referenceFingerprint: string;
  state: SyncObjectMaterializationState['state'];
  lastErrorCode?: string | null;
  updatedAt: number;
}) {
  assertObjectId(input.objectId);
  assertAdapterId(input.adapterId);
  assertReferenceFingerprint(input.referenceFingerprint);
  expect(
    input.state === 'pending'
      || input.state === 'materialized'
      || input.state === 'failed',
    'object materialization state 无效。',
  );
  expect(
    input.lastErrorCode === undefined
      || input.lastErrorCode === null
      || /^[a-z0-9._-]{1,80}$/.test(input.lastErrorCode),
    'object materialization lastErrorCode 无效。',
  );
  expect(
    Number.isSafeInteger(input.updatedAt) && input.updatedAt >= 0,
    'object materialization updatedAt 无效。',
  );
  const database = await getObjectJobDatabase();
  await enqueueSyncDatabaseOperation(() => (
    database.withExclusiveTransactionAsync(async (transaction) => {
    const job = await transaction.getFirstAsync<{
      state: SyncObjectJob['state'];
      local_uri: string | null;
    }>(
      `SELECT state, local_uri FROM sync_object_jobs
       WHERE object_id = ?`,
      input.objectId,
    );
    if (job?.state !== 'verified' || !job.local_uri) {
      throw new Error(
        '只有已验证且仍在本机的对象可以登记物化状态。',
      );
    }
    await transaction.runAsync(
      `INSERT INTO sync_object_materializations (
         object_id, adapter_id, reference_fingerprint,
         state, last_error_code, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(object_id, adapter_id) DO UPDATE SET
         reference_fingerprint = excluded.reference_fingerprint,
         state = excluded.state,
         last_error_code = excluded.last_error_code,
         updated_at = excluded.updated_at`,
      input.objectId,
      input.adapterId,
      input.referenceFingerprint,
      input.state,
      input.lastErrorCode ?? null,
      input.updatedAt,
    );
    })
  ));
}

async function currentObjectReferencesIn(
  database: SQLite.SQLiteDatabase,
  objectId: string,
) {
  const rows = await database.getAllAsync<MutationJsonRow>(
    `SELECT revisions.mutation_json
     FROM sync_revision_object_refs AS refs
       INDEXED BY idx_sync_revision_object_refs_object
     INNER JOIN sync_entity_heads AS heads
       ON heads.revision_id = refs.revision_id
     INNER JOIN sync_entity_revisions AS revisions
       ON revisions.revision_id = heads.revision_id
     WHERE refs.object_id = ?
     ORDER BY heads.domain ASC, heads.entity_type ASC,
              heads.entity_id ASC, heads.revision_id ASC`,
    objectId,
  );
  return rows.map((row, index): SyncCurrentObjectReference => {
    let mutation: unknown;
    try {
      mutation = JSON.parse(row.mutation_json);
      assertPlainMutationV1(mutation);
    } catch {
      throw new Error(
        `同步对象 current revision ${index} 无效，已停止对象处理。`,
      );
    }
    return {
      domain: mutation.entity.domain,
      entityType: mutation.entity.type,
      entityId: mutation.entity.id,
      mutation,
    };
  });
}

export async function listCurrentSyncObjectReferences(
  objectId: string,
) {
  assertObjectId(objectId);
  const database = await getObjectJobDatabase();
  return enqueueSyncDatabaseOperation(
    () => currentObjectReferencesIn(database, objectId),
  );
}

export async function countLiveSyncObjectReferences(
  objectId: string,
) {
  assertObjectId(objectId);
  const database = await getObjectJobDatabase();
  return enqueueSyncDatabaseOperation(async () => (
    (await currentObjectReferencesIn(database, objectId)).length
  ));
}

export async function setSyncObjectPinned(input: {
  objectId: string;
  pinned: boolean;
  updatedAt: number;
}) {
  assertObjectId(input.objectId);
  expect(typeof input.pinned === 'boolean', 'object pinned 必须是 boolean。');
  expect(
    Number.isSafeInteger(input.updatedAt) && input.updatedAt >= 0,
    'object pin updatedAt 无效。',
  );
  const database = await getObjectJobDatabase();
  const result = await enqueueSyncDatabaseOperation(() => (
    database.runAsync(
      `UPDATE sync_object_jobs SET pinned = ?, updated_at = ?
       WHERE object_id = ?`,
      input.pinned ? 1 : 0,
      input.updatedAt,
      input.objectId,
    )
  ));
  if (result.changes !== 1) throw new Error('object pin 目标不存在。');
  const job = await loadSyncObjectJob(input.objectId);
  return {
    objectId: input.objectId,
    pinned: input.pinned,
    needsDownload: !job?.localUri,
  };
}

export async function refreshSyncObjectRetentionClocks(
  observedAt: number,
) {
  expect(
    Number.isSafeInteger(observedAt) && observedAt >= 0,
    'object retention observedAt 无效。',
  );
  const database = await getObjectJobDatabase();
  await enqueueSyncDatabaseOperation(() => (
    database.withExclusiveTransactionAsync(async (transaction) => {
    const referenceRows = await transaction.getAllAsync<
      ObjectReferenceCountRow
    >(
      `SELECT refs.object_id, COUNT(*) AS live_count
       FROM sync_revision_object_refs AS refs
         INDEXED BY idx_sync_revision_object_refs_object
       INNER JOIN sync_entity_heads AS heads
         ON heads.revision_id = refs.revision_id
       GROUP BY refs.object_id`,
    );
    const referenceCounts = new Map(
      referenceRows.map((row) => [row.object_id, row.live_count]),
    );
    const jobs = await transaction.getAllAsync<{ object_id: string }>(
      `SELECT object_id FROM sync_object_jobs
       WHERE state = 'verified'`,
    );
    for (const job of jobs) {
      const existing = await transaction.getFirstAsync<
        ObjectRetentionStateRow
      >(
        `SELECT unreferenced_at, local_evicted_at
         FROM sync_object_retention_state WHERE object_id = ?`,
        job.object_id,
      );
      const unreferencedAt = (referenceCounts.get(job.object_id) ?? 0) === 0
        ? existing?.unreferenced_at ?? observedAt
        : null;
      await transaction.runAsync(
        `INSERT INTO sync_object_retention_state (
           object_id, unreferenced_at, local_evicted_at, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(object_id) DO UPDATE SET
           unreferenced_at = excluded.unreferenced_at,
           updated_at = excluded.updated_at`,
        job.object_id,
        unreferencedAt,
        existing?.local_evicted_at ?? null,
        observedAt,
      );
    }
    })
  ));
}

export async function listUnreferencedVerifiedSyncObjects(
  limit = 16,
) {
  expect(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 256,
    'object retention limit 必须为 1..256。',
  );
  const database = await getObjectJobDatabase();
  const rows = await enqueueSyncDatabaseOperation(() => (
    database.getAllAsync<VerifiedObjectRetentionRow>(
      `SELECT jobs.object_id, jobs.state, jobs.pinned, jobs.local_uri,
              retention.unreferenced_at, retention.local_evicted_at
       FROM sync_object_jobs AS jobs
       INNER JOIN sync_object_retention_state AS retention
         ON retention.object_id = jobs.object_id
       WHERE jobs.state = 'verified'
         AND jobs.local_uri IS NOT NULL
         AND retention.unreferenced_at IS NOT NULL
         AND retention.local_evicted_at IS NULL
       ORDER BY retention.unreferenced_at ASC, jobs.object_id ASC
       LIMIT ?`,
      limit,
    )
  ));
  return rows.map((row): SyncObjectRetentionCandidate => ({
    objectId: row.object_id,
    pinned: row.pinned === 1,
    remoteVerified: row.state === 'verified',
    liveReferenceCount: 0,
    unreferencedAt: row.unreferenced_at,
    localUri: row.local_uri!,
  }));
}

export async function listSyncObjectManagementRecords(
  limit = 256,
) {
  expect(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 256,
    'object management limit 必须为 1..256。',
  );
  const database = await getObjectJobDatabase();
  return enqueueSyncDatabaseOperation(async () => {
    const records: Array<{
      objectId: string;
      direction: SyncObjectJob['direction'];
      state: SyncObjectJob['state'];
      pinned: boolean;
      localUri: string | null;
      lastErrorCode: string | null;
      totalChunks: number;
      completedChunks: number;
      unreferencedAt: number | null;
      localEvictedAt: number | null;
      liveReferenceCount: number;
      routes: Array<{ domain: string; entityType: string }>;
    }> = [];
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const rows = await transaction.getAllAsync<{
        object_id: string;
        direction: SyncObjectJob['direction'] | null;
        state: SyncObjectJob['state'] | null;
        pinned: number | null;
        local_uri: string | null;
        last_error_code: string | null;
        total_chunks: number | null;
        completed_chunks: number | null;
        unreferenced_at: number | null;
        local_evicted_at: number | null;
      }>(
        `WITH candidate_ids AS (
           SELECT object_id FROM sync_object_jobs
           UNION
           SELECT refs.object_id
           FROM sync_entity_heads AS heads
           INNER JOIN sync_revision_object_refs AS refs
             ON refs.revision_id = heads.revision_id
         )
         SELECT candidates.object_id,
                jobs.direction, jobs.state, jobs.pinned,
                jobs.local_uri, jobs.last_error_code,
                jobs.total_chunks, jobs.completed_chunks,
                retention.unreferenced_at,
                retention.local_evicted_at
         FROM candidate_ids AS candidates
         LEFT JOIN sync_object_jobs AS jobs
           ON jobs.object_id = candidates.object_id
         LEFT JOIN sync_object_retention_state AS retention
           ON retention.object_id = candidates.object_id
         ORDER BY candidates.object_id ASC
         LIMIT ?`,
        limit,
      );
      for (const row of rows) {
        const routes = await transaction.getAllAsync<{
          domain: string;
          entity_type: string;
        }>(
          `SELECT DISTINCT heads.domain, heads.entity_type
           FROM sync_entity_heads AS heads
           INNER JOIN sync_revision_object_refs AS refs
             ON refs.revision_id = heads.revision_id
           WHERE refs.object_id = ?
           ORDER BY heads.domain ASC, heads.entity_type ASC`,
          row.object_id,
        );
        records.push({
          objectId: row.object_id,
          direction: row.direction ?? 'download',
          state: row.state ?? 'pending',
          pinned: row.pinned === 1,
          localUri: row.local_uri,
          lastErrorCode: row.last_error_code,
          totalChunks: row.total_chunks ?? 0,
          completedChunks: row.completed_chunks ?? 0,
          unreferencedAt: row.unreferenced_at,
          localEvictedAt: row.local_evicted_at,
          liveReferenceCount: routes.length,
          routes: routes.map((route) => ({
            domain: route.domain,
            entityType: route.entity_type,
          })),
        });
      }
    });
    return records;
  });
}

export async function loadSyncObjectRetentionCandidate(
  objectId: string,
) {
  assertObjectId(objectId);
  const database = await getObjectJobDatabase();
  return enqueueSyncDatabaseOperation(async () => {
    let candidate: SyncObjectRetentionCandidate | null = null;
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const row = await transaction.getFirstAsync<
        VerifiedObjectRetentionRow
      >(
        `SELECT jobs.object_id, jobs.state, jobs.pinned, jobs.local_uri,
                retention.unreferenced_at, retention.local_evicted_at
         FROM sync_object_jobs AS jobs
         INNER JOIN sync_object_retention_state AS retention
           ON retention.object_id = jobs.object_id
         WHERE jobs.object_id = ?`,
        objectId,
      );
      if (
        !row
        || !row.local_uri
        || row.local_evicted_at !== null
      ) {
        return;
      }
      candidate = {
        objectId: row.object_id,
        pinned: row.pinned === 1,
        remoteVerified: row.state === 'verified',
        liveReferenceCount: (
          await currentObjectReferencesIn(transaction, objectId)
        ).length,
        unreferencedAt: row.unreferenced_at,
        localUri: row.local_uri,
      };
    });
    return candidate;
  });
}

export async function markSyncObjectLocalEvicted(input: {
  objectId: string;
  evictedAt: number;
}) {
  assertObjectId(input.objectId);
  expect(
    Number.isSafeInteger(input.evictedAt) && input.evictedAt >= 0,
    'object evictedAt 无效。',
  );
  const database = await getObjectJobDatabase();
  await enqueueSyncDatabaseOperation(() => (
    database.withExclusiveTransactionAsync(async (transaction) => {
    const row = await transaction.getFirstAsync<
      VerifiedObjectRetentionRow
    >(
      `SELECT jobs.object_id, jobs.state, jobs.pinned, jobs.local_uri,
              retention.unreferenced_at, retention.local_evicted_at
       FROM sync_object_jobs AS jobs
       INNER JOIN sync_object_retention_state AS retention
         ON retention.object_id = jobs.object_id
       WHERE jobs.object_id = ?`,
      input.objectId,
    );
    const liveReferenceCount = (
      await currentObjectReferencesIn(transaction, input.objectId)
    ).length;
    if (
      !row
      || !row.local_uri
      || row.local_evicted_at !== null
      || !canEvictLocalSyncObject({
        pinned: row.pinned === 1,
        remoteVerified: row.state === 'verified',
        liveReferenceCount,
        unreferencedAt: row.unreferenced_at,
        now: input.evictedAt,
      })
    ) {
      throw new Error('object 不满足本机安全回收条件。');
    }
    await transaction.runAsync(
      `UPDATE sync_object_jobs
       SET local_uri = NULL, updated_at = ?
       WHERE object_id = ?`,
      input.evictedAt,
      input.objectId,
    );
    await transaction.runAsync(
      `UPDATE sync_object_retention_state
       SET local_evicted_at = ?, updated_at = ?
       WHERE object_id = ?`,
      input.evictedAt,
      input.evictedAt,
      input.objectId,
    );
    })
  ));
  return {
    objectId: input.objectId,
    evictedAt: input.evictedAt,
  };
}

export async function removeUnreferencedSyncObjectJob(
  objectId: string,
) {
  assertObjectId(objectId);
  const database = await getObjectJobDatabase();
  await enqueueSyncDatabaseOperation(() => (
    database.withExclusiveTransactionAsync(
      async (transaction) => {
      if (
        (await currentObjectReferencesIn(
          transaction,
          objectId,
        )).length !== 0
      ) {
        throw new Error(
          '仍有 current head 引用，不能清理本机对象任务。',
        );
      }
      await transaction.runAsync(
        'DELETE FROM sync_object_jobs WHERE object_id = ?',
        objectId,
      );
      },
    )
  ));
}

export async function closeSyncObjectJobDatabaseForTests() {
  if (!objectJobDatabasePromise) return;
  const database = await objectJobDatabasePromise;
  await enqueueSyncDatabaseOperation(() => database.closeAsync());
  objectJobDatabasePromise = undefined;
}
