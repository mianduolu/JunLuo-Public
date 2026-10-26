import {
  createFiniteDeletionCompactionV1,
  FINITE_DELETION_MAX_PER_ROUND,
  FINITE_DELETION_MIN_AGE_MS,
  verifyFiniteDeletionCompactionV1,
  type FiniteDeletionCompactionV1,
  type FiniteDeletionTargetV1,
} from './syncFiniteHistory';
import { expoSyncRandomUuidV1 } from './syncCryptoExpo';
import {
  assertFiniteDeletionLocalCleanupSnapshot,
  resolveFiniteDeletionCleanupPlan,
} from './syncFiniteDeletionCore';
import {
  resolveAndroidSyncDomain,
} from './syncAndroidDomainCatalog';
import {
  openInitializedSyncDatabase,
} from './syncDatabaseOpen';
import { runSyncDatabaseTransaction } from './syncDatabaseOperationQueue';
import { resolveSyncDeviceSigningPublicKeyAt } from './syncStore';
import type {
  SyncRelayActiveEnrollmentV1,
  SyncRelayClient,
} from './syncRelayClient';
import {
  parsePlainMutationV1,
  type PlainMutationV1,
} from './syncProtocol';
import { assertOrdinarySyncAllowed } from './syncEmergencyWorldRebuildStore';

type CandidateRow = {
  domain: string;
  entity_type: string;
  entity_id: string;
  revision_id: string;
  mutation_id: string;
  mutation_json: string;
  created_at: number;
};

type RevisionReceiptRow = {
  mutation_id: string;
  revision_id: string;
  source_device_id: string;
  source_sequence: number;
  relay_cursor: number | null;
};

let databasePromise: ReturnType<typeof openInitializedSyncDatabase> | undefined;

async function getDatabase() {
  if (!databasePromise) {
    const opening = openInitializedSyncDatabase(
      '同步数据库版本高于当前应用，已停止有限删除整理。',
    );
    const retryable = opening.catch((error) => {
      if (databasePromise === retryable) databasePromise = undefined;
      throw error;
    });
    databasePromise = retryable;
  }
  return databasePromise;
}

export async function closeAndroidFiniteDeletionDatabase() {
  if (!databasePromise) return;
  const database = await databasePromise;
  await database.closeAsync();
  databasePromise = undefined;
}

async function listCandidates(now: number) {
  const database = await getDatabase();
  return database.getAllAsync<CandidateRow>(
    `SELECT r.domain, r.entity_type, r.entity_id,
            r.revision_id, r.mutation_id, r.mutation_json, r.created_at
     FROM sync_entity_heads AS h
     INNER JOIN sync_entity_revisions AS r
       ON r.revision_id = h.revision_id
     WHERE r.operation = 'delete'
       AND r.created_at <= ?
       AND 1 = (
         SELECT COUNT(*) FROM sync_entity_heads AS other
         WHERE other.domain = h.domain
           AND other.entity_type = h.entity_type
           AND other.entity_id = h.entity_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM sync_entity_conflicts AS conflict
         WHERE conflict.domain = h.domain
           AND conflict.entity_type = h.entity_type
           AND conflict.entity_id = h.entity_id
           AND conflict.state = 'pending'
       )
     ORDER BY r.created_at, r.revision_id
     LIMIT ?`,
    now - FINITE_DELETION_MIN_AGE_MS,
    FINITE_DELETION_MAX_PER_ROUND,
  );
}

async function loadTargets(candidate: CandidateRow) {
  const database = await getDatabase();
  return database.getAllAsync<RevisionReceiptRow>(
    `SELECT r.mutation_id, r.revision_id, r.source_device_id,
            r.source_sequence, receipt.relay_cursor
     FROM sync_entity_revisions AS r
     LEFT JOIN sync_mutation_relay_receipts_v1 AS receipt
       ON receipt.mutation_id = r.mutation_id
     WHERE r.domain = ? AND r.entity_type = ? AND r.entity_id = ?
     ORDER BY r.mutation_id`,
    candidate.domain,
    candidate.entity_type,
    candidate.entity_id,
  );
}

async function persistReceipts(
  receipts: Array<{
    mutationId: string;
    sourceDeviceId: string;
    sourceSequence: number;
    relayCursor: number;
  }>,
  recordedAt: number,
) {
  const database = await getDatabase();
  await runSyncDatabaseTransaction(database, async (transaction) => {
    for (const receipt of receipts) {
      const existing = await transaction.getFirstAsync<{
        source_device_id: string;
        source_sequence: number;
        relay_cursor: number;
      }>(
        `SELECT source_device_id, source_sequence, relay_cursor
         FROM sync_mutation_relay_receipts_v1 WHERE mutation_id = ?`,
        receipt.mutationId,
      );
      if (existing) {
        if (
          existing.source_device_id !== receipt.sourceDeviceId
          || existing.source_sequence !== receipt.sourceSequence
          || existing.relay_cursor !== receipt.relayCursor
        ) {
          throw new Error('mutation relay receipt changed');
        }
      } else {
        await transaction.runAsync(
          `INSERT INTO sync_mutation_relay_receipts_v1 (
             mutation_id, source_device_id, source_sequence,
             relay_cursor, recorded_at
           ) VALUES (?, ?, ?, ?, ?)`,
          receipt.mutationId,
          receipt.sourceDeviceId,
          receipt.sourceSequence,
          receipt.relayCursor,
          recordedAt,
        );
      }
    }
  });
}

async function completeTargets(
  relay: SyncRelayClient,
  enrollment: SyncRelayActiveEnrollmentV1,
  rows: RevisionReceiptRow[],
  now: number,
): Promise<FiniteDeletionTargetV1[] | null> {
  const missing = rows.filter((row) => row.relay_cursor === null);
  for (let index = 0; index < missing.length; index += 32) {
    const ids = missing
      .slice(index, index + 32)
      .map((row) => row.mutation_id)
      .sort();
    const response = await relay.lookupMutationRelayReceipts(
      enrollment,
      ids,
    );
    if (response.missingMutationIds.length > 0) return null;
    await persistReceipts(response.receipts, now);
  }
  const complete = missing.length ? await loadTargetsByIdentity(rows) : rows;
  if (complete.some((row) => row.relay_cursor === null)) return null;
  return complete.map((row) => ({
    mutationId: row.mutation_id,
    revisionId: row.revision_id,
    sourceDeviceId: row.source_device_id,
    sourceSequence: row.source_sequence,
    relayCursor: Number(row.relay_cursor),
  }));
}

async function loadTargetsByIdentity(rows: RevisionReceiptRow[]) {
  const database = await getDatabase();
  const values: RevisionReceiptRow[] = [];
  for (const row of rows) {
    const refreshed = await database.getFirstAsync<RevisionReceiptRow>(
      `SELECT r.mutation_id, r.revision_id, r.source_device_id,
              r.source_sequence, receipt.relay_cursor
       FROM sync_entity_revisions AS r
       LEFT JOIN sync_mutation_relay_receipts_v1 AS receipt
         ON receipt.mutation_id = r.mutation_id
       WHERE r.mutation_id = ?`,
      row.mutation_id,
    );
    if (!refreshed) throw new Error('有限删除目标在准备期间发生变化。');
    values.push(refreshed);
  }
  return values;
}

async function savePrepared(compaction: FiniteDeletionCompactionV1, now: number) {
  const database = await getDatabase();
  await database.runAsync(
    `INSERT INTO sync_finite_deletion_compactions_v1 (
       compaction_id, tombstone_mutation_id, tombstone_revision_id,
       request_json, state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'prepared', ?, ?)
     ON CONFLICT(compaction_id) DO UPDATE SET updated_at = excluded.updated_at`,
    compaction.compactionId,
    compaction.tombstoneMutationId,
    compaction.tombstoneRevisionId,
    JSON.stringify(compaction),
    now,
    now,
  );
}

async function markSubmitted(compactionId: string, now: number) {
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE sync_finite_deletion_compactions_v1
     SET state = 'local-cleanup', attempt_count = attempt_count + 1,
         last_error_code = NULL, updated_at = ?
     WHERE compaction_id = ?`,
    now,
    compactionId,
  );
}

async function cleanupLocalCompaction(
  compaction: FiniteDeletionCompactionV1,
  now: number,
) {
  const database = await getDatabase();
  const localState = await database.getFirstAsync<{ state: string }>(
    `SELECT state FROM sync_finite_deletion_compactions_v1
     WHERE compaction_id = ?`,
    compaction.compactionId,
  );
  if (localState?.state === 'acknowledged' || localState?.state === 'complete') {
    return;
  }
  const tombstoneMutation = parsePlainMutationV1(
    (await database.getFirstAsync<{ mutation_json: string }>(
      `SELECT mutation_json FROM sync_entity_revisions
       WHERE revision_id = ?`,
      compaction.tombstoneRevisionId,
    ))?.mutation_json ?? '',
  );
  if (
    tombstoneMutation.revision.operation !== 'delete'
    || tombstoneMutation.mutationId !== compaction.tombstoneMutationId
    || tombstoneMutation.entity.domain !== compaction.domain
    || tombstoneMutation.entity.type !== compaction.entityType
    || tombstoneMutation.entity.id !== compaction.entityId
  ) {
    throw new Error('有限删除 tombstone 身份不一致。');
  }
  const adapter = resolveAndroidSyncDomain(tombstoneMutation);
  resolveFiniteDeletionCleanupPlan(adapter.adapterId);
  await runSyncDatabaseTransaction(database, async (transaction) => {
    const heads = await transaction.getAllAsync<{
      revision_id: string;
      operation: PlainMutationV1['revision']['operation'];
    }>(
      `SELECT h.revision_id, r.operation FROM sync_entity_heads h
       INNER JOIN sync_entity_revisions r ON r.revision_id = h.revision_id
       WHERE h.domain = ? AND h.entity_type = ? AND h.entity_id = ?`,
      compaction.domain,
      compaction.entityType,
      compaction.entityId,
    );
    const pending = await transaction.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count FROM sync_entity_conflicts
       WHERE domain = ? AND entity_type = ? AND entity_id = ?
         AND state = 'pending'`,
      compaction.domain,
      compaction.entityType,
      compaction.entityId,
    );
    const actual = await transaction.getAllAsync<{ mutation_id: string }>(
      `SELECT mutation_id FROM sync_entity_revisions
       WHERE domain = ? AND entity_type = ? AND entity_id = ?
       ORDER BY mutation_id`,
      compaction.domain,
      compaction.entityType,
      compaction.entityId,
    );
    assertFiniteDeletionLocalCleanupSnapshot({
      compaction,
      heads: heads.map((row) => ({ revisionId: row.revision_id, operation: row.operation })),
      pendingConflictCount: pending?.count ?? 0,
      actualMutationIds: actual.map((row) => row.mutation_id),
    });
    const affectedObjects = await transaction.getAllAsync<{
      object_id: string;
    }>(
      `SELECT DISTINCT refs.object_id
       FROM sync_entity_revisions AS revisions
       INNER JOIN sync_revision_object_refs AS refs
         ON refs.revision_id = revisions.revision_id
       WHERE revisions.domain = ?
         AND revisions.entity_type = ?
         AND revisions.entity_id = ?
       ORDER BY refs.object_id`,
      compaction.domain,
      compaction.entityType,
      compaction.entityId,
    );
    for (const target of compaction.targets) {
      await transaction.runAsync(
        `DELETE FROM sync_outbox WHERE mutation_id = ?`,
        target.mutationId,
      );
      await transaction.runAsync(
        `DELETE FROM sync_inbox WHERE mutation_id = ?`,
        target.mutationId,
      );
      await transaction.runAsync(
        `DELETE FROM sync_applied_mutations WHERE mutation_id = ?`,
        target.mutationId,
      );
      await transaction.runAsync(
        `DELETE FROM sync_mutation_relay_receipts_v1 WHERE mutation_id = ?`,
        target.mutationId,
      );
      await transaction.runAsync(
        `DELETE FROM sync_quarantine WHERE mutation_id = ?`,
        target.mutationId,
      );
    }
    await transaction.runAsync(
      `DELETE FROM sync_entity_conflicts
       WHERE domain = ? AND entity_type = ? AND entity_id = ?`,
      compaction.domain,
      compaction.entityType,
      compaction.entityId,
    );
    await transaction.runAsync(
      `DELETE FROM sync_entity_heads
       WHERE domain = ? AND entity_type = ? AND entity_id = ?`,
      compaction.domain,
      compaction.entityType,
      compaction.entityId,
    );
    await transaction.runAsync(
      `DELETE FROM sync_revision_object_refs
       WHERE revision_id IN (
         SELECT revision_id FROM sync_entity_revisions
         WHERE domain = ? AND entity_type = ? AND entity_id = ?
       )`,
      compaction.domain,
      compaction.entityType,
      compaction.entityId,
    );
    await transaction.runAsync(
      `DELETE FROM sync_entity_revisions
       WHERE domain = ? AND entity_type = ? AND entity_id = ?`,
      compaction.domain,
      compaction.entityType,
      compaction.entityId,
    );
    for (const object of affectedObjects) {
      const live = await transaction.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM sync_revision_object_refs AS refs
         INNER JOIN sync_entity_heads AS heads
           ON heads.revision_id = refs.revision_id
         WHERE refs.object_id = ?`,
        object.object_id,
      );
      if ((live?.count ?? 0) !== 0) continue;
      const job = await transaction.getFirstAsync<{
        state: string;
      }>(
        `SELECT state FROM sync_object_jobs WHERE object_id = ?`,
        object.object_id,
      );
      if (job?.state !== 'verified') continue;
      const retention = await transaction.getFirstAsync<{
        unreferenced_at: number | null;
        local_evicted_at: number | null;
      }>(
        `SELECT unreferenced_at, local_evicted_at
         FROM sync_object_retention_state WHERE object_id = ?`,
        object.object_id,
      );
      await transaction.runAsync(
        `INSERT INTO sync_object_retention_state (
           object_id, unreferenced_at, local_evicted_at, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(object_id) DO UPDATE SET
           unreferenced_at = COALESCE(
             sync_object_retention_state.unreferenced_at,
             excluded.unreferenced_at
           ),
           updated_at = excluded.updated_at`,
        object.object_id,
        retention?.unreferenced_at ?? now,
        retention?.local_evicted_at ?? null,
        now,
      );
    }
    await transaction.runAsync(
      `UPDATE sync_finite_deletion_compactions_v1
       SET state = 'acknowledged', updated_at = ?
       WHERE compaction_id = ?`,
      now,
      compaction.compactionId,
    );
  });
}

export async function runAndroidFiniteDeletionMaintenance(input: {
  relay: SyncRelayClient;
  enrollment: SyncRelayActiveEnrollmentV1;
  now: number;
  shouldContinue: () => boolean;
}) {
  await assertOrdinarySyncAllowed();
  const pending = await input.relay.listPendingFiniteDeletions(
    input.enrollment,
  );
  let acknowledged = 0;
  for (const compaction of pending) {
    if (!input.shouldContinue()) break;
    const publicKey = await resolveSyncDeviceSigningPublicKeyAt({
      vaultId: compaction.vaultId,
      deviceId: compaction.sourceDeviceId,
      keyId: compaction.keyId,
      createdAt: compaction.deletedAt,
    });
    if (!publicKey) {
      throw new Error('有限删除来源设备未登记、尚未激活或已经撤销。');
    }
    if (!verifyFiniteDeletionCompactionV1(compaction, publicKey)) {
      throw new Error('有限删除签名验证失败。');
    }
    await cleanupLocalCompaction(compaction, input.now);
    await input.relay.acknowledgeFiniteDeletion(
      input.enrollment,
      compaction.compactionId,
      input.now,
    );
    acknowledged += 1;
  }

  const candidates = await listCandidates(input.now);
  let submitted = 0;
  for (const candidate of candidates) {
    if (!input.shouldContinue()) break;
    const targets = await completeTargets(
      input.relay,
      input.enrollment,
      await loadTargets(candidate),
      input.now,
    );
    if (!targets) continue;
    if (!targets.some((target) => target.mutationId === candidate.mutation_id)) {
      throw new Error('有限删除目标缺少 tombstone 回执。');
    }
    // Equivalent deletes share one UUID-selected head; the relay boundary uses the last real delete.
    const tombstone = targets.reduce((latest, target) =>
      target.relayCursor > latest.relayCursor ? target : latest);
    const selected = tombstone.revisionId === candidate.revision_id
      ? candidate
      : await (await getDatabase()).getFirstAsync<{ mutation_json: string }>(
        `SELECT mutation_json FROM sync_entity_revisions
         WHERE revision_id = ? AND domain = ? AND entity_type = ? AND entity_id = ?`,
        tombstone.revisionId, candidate.domain, candidate.entity_type, candidate.entity_id,
      );
    if (!selected) throw new Error('有限删除目标在准备期间发生变化。');
    const mutation = parsePlainMutationV1(selected.mutation_json);
    if (mutation.revision.operation !== 'delete') {
      throw new Error('有限删除历史包含晚于 tombstone 的 revision。');
    }
    if (mutation.createdAt > input.now - FINITE_DELETION_MIN_AGE_MS) continue;
    const existing = await (await getDatabase()).getFirstAsync<{ state: string }>(
      `SELECT state FROM sync_finite_deletion_compactions_v1
       WHERE tombstone_revision_id = ?`,
      tombstone.revisionId,
    );
    if (existing) continue;
    const compaction = createFiniteDeletionCompactionV1({
      version: 1,
      compactionId: expoSyncRandomUuidV1(),
      vaultId: input.enrollment.publicIdentity.vaultId,
      sourceDeviceId: input.enrollment.publicIdentity.deviceId,
      keyId: input.enrollment.publicIdentity.keyId,
      domain: mutation.entity.domain,
      entityType: mutation.entity.type,
      entityId: mutation.entity.id,
      tombstoneMutationId: mutation.mutationId,
      tombstoneRevisionId: mutation.revision.id,
      deletedAt: mutation.createdAt,
      tombstoneRelayCursor: tombstone.relayCursor,
      targets,
    }, input.enrollment.secrets.signingPrivateKey);
    await savePrepared(compaction, input.now);
    await input.relay.compactFiniteDeletion(
      input.enrollment,
      compaction,
    );
    await markSubmitted(compaction.compactionId, input.now);
    submitted += 1;
  }
  return { submitted, acknowledged, hasMore: candidates.length >= 32 };
}
