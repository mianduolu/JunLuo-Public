import * as SQLite from 'expo-sqlite';

import {
  bytesToBase64Url,
  canonicalizeJsonBytesV1,
  canonicalizeJsonV1,
  sha256BytesV1,
} from './syncCrypto';
import {
  resolveAndroidSyncDomain,
} from './syncAndroidDomainCatalog';
import {
  assertPlainMutationV1,
  isRetiredCurrentActionMutation,
  type PlainMutationV1,
} from './syncProtocol';
import {
  openInitializedSyncDatabase,
} from './syncDatabaseOpen';
import {
  enqueueSyncDatabaseOperation,
  runSyncDatabaseTransaction,
} from './syncDatabaseOperationQueue';

type RevisionRow = {
  revision_id: string;
  mutation_id: string;
  domain: string;
  entity_type: string;
  entity_id: string;
  operation: PlainMutationV1['revision']['operation'];
  mutation_json: string;
};

type HeadRow = {
  revision_id: string;
  operation: PlainMutationV1['revision']['operation'];
};

let ledgerDatabasePromise: Promise<SQLite.SQLiteDatabase> | undefined;
const MANUAL_OBJECT_SCAN_CURSOR_PREFIX =
  'manual-object-scan-v1:';

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

async function getLedgerDatabase() {
  if (!ledgerDatabasePromise) {
    const openingDatabasePromise = openInitializedSyncDatabase(
      '同步数据库版本高于当前应用，已停止远端账本应用。',
    );
    const retryableDatabasePromise = openingDatabasePromise.catch(
      (error) => {
        if (ledgerDatabasePromise === retryableDatabasePromise) {
          ledgerDatabasePromise = undefined;
        }
        throw error;
      },
    );
    ledgerDatabasePromise = retryableDatabasePromise;
  }
  return ledgerDatabasePromise;
}

function conflictIdFor(input: {
  domain: string;
  entityType: string;
  entityId: string;
  revisionIds: string[];
}) {
  return bytesToBase64Url(sha256BytesV1(
    canonicalizeJsonBytesV1({
      context: 'junluo.sync.v1/entity-conflict',
      domain: input.domain,
      entityType: input.entityType,
      entityId: input.entityId,
      revisionIds: [...input.revisionIds].sort(),
    }),
  ));
}

async function insertObjectReferences(
  transaction: SQLite.SQLiteDatabase,
  mutation: PlainMutationV1,
) {
  for (const objectId of mutation.objectRefs) {
    await transaction.runAsync(
      `INSERT OR IGNORE INTO sync_revision_object_refs (
         revision_id, object_id
       ) VALUES (?, ?)`,
      mutation.revision.id,
      objectId,
    );
  }
}

async function collapseEquivalentDeleteHeads(
  transaction: SQLite.SQLiteDatabase,
  domain: string,
  entityType: string,
  entityId: string,
) {
  const heads = await transaction.getAllAsync<HeadRow>(
    `SELECT heads.revision_id, revisions.operation
     FROM sync_entity_heads AS heads
     INNER JOIN sync_entity_revisions AS revisions
       ON revisions.revision_id = heads.revision_id
     WHERE heads.domain = ?
       AND heads.entity_type = ?
       AND heads.entity_id = ?
     ORDER BY heads.revision_id ASC`,
    domain,
    entityType,
    entityId,
  );
  if (
    heads.length < 2
    || heads.some((head) => head.operation !== 'delete')
  ) {
    return null;
  }
  const winnerRevisionId = heads[0]!.revision_id;
  const removed = await transaction.runAsync(
    `DELETE FROM sync_entity_heads
     WHERE domain = ?
       AND entity_type = ?
       AND entity_id = ?
       AND revision_id <> ?`,
    domain,
    entityType,
    entityId,
    winnerRevisionId,
  );
  return {
    winnerRevisionId,
    removedHeads: removed.changes,
  };
}

export async function resolveEquivalentAndroidDeleteHeadConflicts(
  resolvedAt: number,
  limit = 128,
) {
  assertTimestamp(resolvedAt, 'resolvedAt');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) {
    throw new Error('等价删除冲突清理 limit 必须为 1..512。');
  }
  const database = await getLedgerDatabase();
  return runSyncDatabaseTransaction(database, async (transaction) => {
    const candidates = await transaction.getAllAsync<{
      domain: string;
      entity_type: string;
      entity_id: string;
    }>(
      `SELECT DISTINCT domain, entity_type, entity_id
       FROM sync_entity_conflicts AS conflicts
       WHERE conflicts.state = 'pending'
         AND 2 <= (
           SELECT COUNT(*)
           FROM sync_entity_heads AS heads
           WHERE heads.domain = conflicts.domain
             AND heads.entity_type = conflicts.entity_type
             AND heads.entity_id = conflicts.entity_id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM sync_entity_heads AS heads
           INNER JOIN sync_entity_revisions AS revisions
             ON revisions.revision_id = heads.revision_id
           WHERE heads.domain = conflicts.domain
             AND heads.entity_type = conflicts.entity_type
             AND heads.entity_id = conflicts.entity_id
             AND revisions.operation <> 'delete'
         )
       ORDER BY domain, entity_type, entity_id
       LIMIT ?`,
      limit,
    );
    let collapsedEntities = 0;
    let resolvedConflicts = 0;
    for (const candidate of candidates) {
      const collapsed = await collapseEquivalentDeleteHeads(
        transaction,
        candidate.domain,
        candidate.entity_type,
        candidate.entity_id,
      );
      if (!collapsed) continue;
      const resolved = await transaction.runAsync(
        `UPDATE sync_entity_conflicts
         SET state = 'resolved', resolved_at = ?
         WHERE domain = ?
           AND entity_type = ?
           AND entity_id = ?
           AND state = 'pending'`,
        resolvedAt,
        candidate.domain,
        candidate.entity_type,
        candidate.entity_id,
      );
      collapsedEntities += 1;
      resolvedConflicts += resolved.changes;
    }
    return {
      collapsedEntities,
      resolvedConflicts,
      hasMore: candidates.length === limit,
    };
  });
}

export async function inspectAndroidSyncMutationParentDependencies(
  mutation: PlainMutationV1,
) {
  assertPlainMutationV1(mutation);
  const database = await getLedgerDatabase();
  return enqueueSyncDatabaseOperation(async () => {
    const missing: string[] = [];
    for (const parentId of mutation.revision.parents) {
      const existing = await database.getFirstAsync(
        `SELECT 1 FROM sync_entity_revisions
         WHERE revision_id = ?`,
        parentId,
      );
      if (existing) continue;
      missing.push(parentId);
    }
    return { missing };
  });
}

export async function applyVerifiedAndroidSyncMutation(
  mutation: PlainMutationV1,
  appliedAt: number,
) {
  assertPlainMutationV1(mutation);
  assertTimestamp(appliedAt, 'appliedAt');
  const retired = isRetiredCurrentActionMutation(mutation);
  const adapterId = retired ? 'behavior.current-action' : resolveAndroidSyncDomain(mutation).adapterId;
  const database = await getLedgerDatabase();
  let result!: {
    status: 'applied' | 'already-applied' | 'conflict';
    adapterId: string;
    revisionIds: string[];
    conflictId: string | null;
    current: boolean;
  };

  await runSyncDatabaseTransaction(database, async (transaction) => {
    const existingMutation = await transaction.getFirstAsync<RevisionRow>(
      'SELECT * FROM sync_entity_revisions WHERE mutation_id = ?',
      mutation.mutationId,
    );
    if (existingMutation) {
      const existing = JSON.parse(existingMutation.mutation_json) as unknown;
      if (canonicalizeJsonV1(existing) !== canonicalizeJsonV1(mutation)) {
        throw new Error(
          '同一 mutationId 已对应另一份 Android 修订账本内容。',
        );
      }
      await insertObjectReferences(transaction, mutation);
      const heads = await transaction.getAllAsync<{ revision_id: string }>(
        `SELECT revision_id FROM sync_entity_heads
         WHERE domain = ? AND entity_type = ? AND entity_id = ?
         ORDER BY revision_id ASC`,
        mutation.entity.domain,
        mutation.entity.type,
        mutation.entity.id,
      );
      result = {
        status: 'already-applied',
        adapterId,
        revisionIds: heads.map((row) => row.revision_id),
        conflictId: null,
        current: !retired && heads.length === 1
          && heads[0]?.revision_id === mutation.revision.id,
      };
      return;
    }

    const sameRevision = await transaction.getFirstAsync<{
      mutation_id: string;
    }>(
      'SELECT mutation_id FROM sync_entity_revisions WHERE revision_id = ?',
      mutation.revision.id,
    );
    if (sameRevision) {
      throw new Error('同一 revisionId 已属于另一条 mutation。');
    }

    const parentOperations: string[] = [];
    for (const parentId of mutation.revision.parents) {
      const parent = await transaction.getFirstAsync<{
        domain: string;
        entity_type: string;
        entity_id: string;
        operation: string;
      }>(
        `SELECT domain, entity_type, entity_id, operation
         FROM sync_entity_revisions WHERE revision_id = ?`,
        parentId,
      );
      if (!parent) {
        throw new Error(`修订父节点 ${parentId} 尚未落盘。`);
      }
      if (
        parent.domain !== mutation.entity.domain
        || parent.entity_type !== mutation.entity.type
        || parent.entity_id !== mutation.entity.id
      ) {
        throw new Error('revision parent 属于另一实体。');
      }
      parentOperations.push(parent.operation);
    }
    const hasDeleteParent = parentOperations.includes('delete');
    if (
      hasDeleteParent
      && mutation.revision.operation !== 'delete'
      && mutation.revision.operation !== 'restore'
    ) {
      throw new Error('墓碑后继只能继续 delete 或显式 restore。');
    }
    if (
      mutation.revision.operation === 'restore'
      && !hasDeleteParent
    ) {
      throw new Error('restore 必须直接引用至少一个 delete parent。');
    }

    const headRows = await transaction.getAllAsync<HeadRow>(
      `SELECT heads.revision_id, revisions.operation
       FROM sync_entity_heads AS heads
       INNER JOIN sync_entity_revisions AS revisions
         ON revisions.revision_id = heads.revision_id
       WHERE heads.domain = ?
         AND heads.entity_type = ?
         AND heads.entity_id = ?
       ORDER BY heads.revision_id ASC`,
      mutation.entity.domain,
      mutation.entity.type,
      mutation.entity.id,
    );
    if (headRows.length === 0 && mutation.revision.parents.length > 0
      // Retired current-action keeps exact history/parent validation above,
      // but intentionally has no active business heads.
      && !retired) {
      throw new Error('有父节点的实体不应缺少 current head。');
    }
    const parentIds = new Set(mutation.revision.parents);
    const concurrentHeads = headRows.filter(
      (row) => !parentIds.has(row.revision_id),
    );
    const equivalentDeleteHeads =
      mutation.revision.operation === 'delete'
      && concurrentHeads.length > 0
      && concurrentHeads.every(
        (row) => row.operation === 'delete',
      );
    const conflict = concurrentHeads.length > 0
      && !equivalentDeleteHeads;

    await transaction.runAsync(
      `INSERT INTO sync_entity_revisions (
         revision_id, mutation_id, domain, entity_type,
         entity_id, parents_json, operation, schema_version,
         mutation_json, source_device_id, source_sequence, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      mutation.revision.id,
      mutation.mutationId,
      mutation.entity.domain,
      mutation.entity.type,
      mutation.entity.id,
      canonicalizeJsonV1([...mutation.revision.parents].sort()),
      mutation.revision.operation,
      mutation.revision.schemaVersion,
      JSON.stringify(mutation),
      mutation.sourceDeviceId,
      mutation.sourceSequence,
      mutation.createdAt,
    );
    await insertObjectReferences(transaction, mutation);
    if (retired) {
      result = { status: 'applied', adapterId, revisionIds: [], conflictId: null, current: false };
      return;
    }
    for (const parentId of mutation.revision.parents) {
      await transaction.runAsync(
        `DELETE FROM sync_entity_heads
         WHERE domain = ? AND entity_type = ?
           AND entity_id = ? AND revision_id = ?`,
        mutation.entity.domain,
        mutation.entity.type,
        mutation.entity.id,
        parentId,
      );
    }
    await transaction.runAsync(
      `INSERT INTO sync_entity_heads (
         domain, entity_type, entity_id, revision_id, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
      mutation.entity.domain,
      mutation.entity.type,
      mutation.entity.id,
      mutation.revision.id,
      appliedAt,
    );

    if (equivalentDeleteHeads) {
      await collapseEquivalentDeleteHeads(
        transaction,
        mutation.entity.domain,
        mutation.entity.type,
        mutation.entity.id,
      );
    }

    let conflictId: string | null = null;
    if (conflict) {
      const revisionIds = [
        ...concurrentHeads.map((row) => row.revision_id),
        mutation.revision.id,
      ].sort();
      conflictId = conflictIdFor({
        domain: mutation.entity.domain,
        entityType: mutation.entity.type,
        entityId: mutation.entity.id,
        revisionIds,
      });
      const deleteEdit = mutation.revision.operation === 'delete'
        || concurrentHeads.some((row) => row.operation === 'delete');
      await transaction.runAsync(
        `INSERT OR IGNORE INTO sync_entity_conflicts (
           conflict_id, domain, entity_type, entity_id,
           kind, revision_ids_json, conflicting_fields_json,
           state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        conflictId,
        mutation.entity.domain,
        mutation.entity.type,
        mutation.entity.id,
        deleteEdit ? 'delete-edit' : 'same-field',
        canonicalizeJsonV1(revisionIds),
        canonicalizeJsonV1(['$record']),
        appliedAt,
      );
    } else if (headRows.length > 0) {
      await transaction.runAsync(
        `UPDATE sync_entity_conflicts
         SET state = 'resolved', resolved_at = ?
         WHERE domain = ? AND entity_type = ?
           AND entity_id = ? AND state = 'pending'`,
        appliedAt,
        mutation.entity.domain,
        mutation.entity.type,
        mutation.entity.id,
      );
    }

    const resultingHeads = await transaction.getAllAsync<{
      revision_id: string;
    }>(
      `SELECT revision_id FROM sync_entity_heads
       WHERE domain = ? AND entity_type = ? AND entity_id = ?
       ORDER BY revision_id ASC`,
      mutation.entity.domain,
      mutation.entity.type,
      mutation.entity.id,
    );
    result = {
      status: conflict ? 'conflict' : 'applied',
      adapterId,
      revisionIds: resultingHeads.map((row) => row.revision_id),
      conflictId,
      current: resultingHeads.length === 1
        && resultingHeads[0]?.revision_id === mutation.revision.id,
    };
  });
  return result;
}

export async function androidSyncLedgerSnapshot() {
  const database = await getLedgerDatabase();
  return enqueueSyncDatabaseOperation(async () => {
    const counts = await database.getFirstAsync<{
      pending_outbox: number;
      received_inbox: number;
      pending_conflicts: number;
      quarantined: number;
      object_jobs: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM sync_outbox
          WHERE state IN ('pending', 'leased'))
           AS pending_outbox,
         (SELECT COUNT(*) FROM sync_inbox WHERE state = 'received')
           AS received_inbox,
         (SELECT COUNT(*) FROM sync_entity_conflicts WHERE state = 'pending')
           AS pending_conflicts,
         (SELECT COUNT(*) FROM sync_inbox WHERE state = 'quarantined')
           AS quarantined,
         (SELECT COUNT(*) FROM sync_object_jobs
          WHERE state IN ('pending', 'running', 'failed'))
           AS object_jobs`,
    );
    return {
      pendingOutbox: counts?.pending_outbox ?? 0,
      receivedInbox: counts?.received_inbox ?? 0,
      pendingConflicts: counts?.pending_conflicts ?? 0,
      quarantined: counts?.quarantined ?? 0,
      objectJobs: counts?.object_jobs ?? 0,
    };
  });
}

export async function listCurrentAndroidSyncObjectIds(input: {
  limit?: number;
  afterObjectId?: string | null;
} = {}) {
  const limit = input.limit ?? 64;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
    throw new Error('Android current object limit 必须为 1..256。');
  }
  const afterObjectId = input.afterObjectId ?? '';
  const database = await getLedgerDatabase();
  const rows = await database.getAllAsync<{ object_id: string }>(
    `SELECT DISTINCT refs.object_id
     FROM sync_entity_heads AS heads
     INNER JOIN sync_revision_object_refs AS refs
       ON refs.revision_id = heads.revision_id
     WHERE refs.object_id > ?
     ORDER BY refs.object_id ASC
     LIMIT ?`,
    afterObjectId,
    limit,
  );
  return rows.map((row) => row.object_id);
}

export async function loadAndroidManualObjectScanCursor() {
  const database = await getLedgerDatabase();
  return enqueueSyncDatabaseOperation(async () => {
    const rows = await database.getAllAsync<{
      stream_id: string;
    }>(
      `SELECT stream_id FROM sync_cursors
       WHERE stream_id LIKE ?
       ORDER BY updated_at DESC, stream_id ASC
       LIMIT 2`,
      `${MANUAL_OBJECT_SCAN_CURSOR_PREFIX}%`,
    );
    if (rows.length > 1) {
      throw new Error('Android 手动对象扫描存在多个持久游标。');
    }
    const streamId = rows[0]?.stream_id;
    if (!streamId) return null;
    const objectId = streamId.slice(
      MANUAL_OBJECT_SCAN_CURSOR_PREFIX.length,
    );
    if (!/^[A-Za-z0-9_-]{43}$/.test(objectId)) {
      throw new Error('Android 手动对象扫描游标损坏。');
    }
    return objectId;
  });
}

export async function saveAndroidManualObjectScanCursor(input: {
  afterObjectId: string | null;
  updatedAt: number;
}) {
  if (
    input.afterObjectId !== null
    && !/^[A-Za-z0-9_-]{43}$/.test(input.afterObjectId)
  ) {
    throw new Error('Android 手动对象扫描 objectId 无效。');
  }
  assertTimestamp(input.updatedAt, 'object scan updatedAt');
  const database = await getLedgerDatabase();
  await runSyncDatabaseTransaction(database, async (transaction) => {
    await transaction.runAsync(
      'DELETE FROM sync_cursors WHERE stream_id LIKE ?',
      `${MANUAL_OBJECT_SCAN_CURSOR_PREFIX}%`,
    );
    if (input.afterObjectId !== null) {
      await transaction.runAsync(
        `INSERT INTO sync_cursors (
           stream_id, cursor_value, updated_at
         ) VALUES (?, 1, ?)`,
        `${MANUAL_OBJECT_SCAN_CURSOR_PREFIX}${input.afterObjectId}`,
        input.updatedAt,
      );
    }
  });
}

export async function closeAndroidSyncLedgerForTests() {
  if (!ledgerDatabasePromise) return;
  const database = await ledgerDatabasePromise;
  await database.closeAsync();
  ledgerDatabasePromise = undefined;
}
