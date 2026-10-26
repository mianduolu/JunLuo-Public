import * as SQLite from 'expo-sqlite';

import {
  assertPlainMutationV1,
  getSyncEntityIdMaximumLength,
  type PlainMutationV1,
} from './syncProtocol';
import { notifyAutomaticDataSyncWorkAvailable } from './automaticDataSyncEvents';
import {
  assertSyncUuidV4,
} from './syncDeviceContract';
import {
  openInitializedSyncDatabase,
} from './syncDatabaseOpen';
import {
  enqueueSyncDatabaseOperation,
} from './syncDatabaseOperationQueue';
import type {
  SyncMutationEntityRef,
  SyncMutationStatePort,
} from './syncMutationEnvelope';

type StoredMutationRow = {
  mutation_json: string;
};

type EntityHeadRow = {
  revision_id: string;
};

type EntityHeadOperationRow = {
  operation: string;
};

const DOMAIN_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const HIGH_SENSITIVITY_RETENTION_SCAN_CURSOR_PREFIX =
  'high-sensitivity-retention-scan-v1:';
const HIGH_SENSITIVITY_RETENTION_TARGET_COUNT = 8;
let mutationStateDatabasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertEntityRef(entity: SyncMutationEntityRef) {
  if (
    !DOMAIN_TOKEN_PATTERN.test(entity.domain)
    || entity.domain.length > 80
    || !DOMAIN_TOKEN_PATTERN.test(entity.type)
    || entity.type.length > 80
    || !entity.id
    || entity.id.length > getSyncEntityIdMaximumLength(entity.domain, entity.type)
  ) {
    throw new Error('sync entity ref 格式无效。');
  }
}

function sourceSequenceStreamId(sourceDeviceId: string) {
  assertSyncUuidV4(sourceDeviceId, 'sourceDeviceId');
  return `source-sequence-v1:${sourceDeviceId}`;
}

async function getMutationStateDatabase() {
  if (!mutationStateDatabasePromise) {
    const openingDatabasePromise = openInitializedSyncDatabase(
      '同步数据库版本高于当前应用，已停止 mutation 分配以保护数据。',
    );
    const retryableDatabasePromise = openingDatabasePromise.catch(
      (error) => {
        if (
          mutationStateDatabasePromise
          === retryableDatabasePromise
        ) {
          mutationStateDatabasePromise = undefined;
        }
        throw error;
      },
    );
    mutationStateDatabasePromise = retryableDatabasePromise;
  }
  return mutationStateDatabasePromise;
}

export async function allocateSyncSourceSequence(
  sourceDeviceId: string,
  allocatedAt: number,
) {
  const streamId = sourceSequenceStreamId(sourceDeviceId);
  assertTimestamp(allocatedAt, 'allocatedAt');
  const database = await getMutationStateDatabase();
  let nextSequence = 0;
  await enqueueSyncDatabaseOperation(() => (
    database.withExclusiveTransactionAsync(async (transaction) => {
      // Preserve JS number arithmetic when a previously safe cursor is exhausted.
      const row = await transaction.getFirstAsync<{ cursor_value: number }>(
        `INSERT INTO sync_cursors (stream_id, cursor_value, updated_at)
         SELECT ?, CAST(max(
           coalesce((SELECT cursor_value FROM sync_cursors WHERE stream_id = ?), 0),
           coalesce((SELECT MAX(source_sequence) FROM sync_outbox WHERE source_device_id = ?), 0)
         ) AS REAL) + 1.0, ?
         ON CONFLICT(stream_id) DO UPDATE SET
           cursor_value = excluded.cursor_value,
           updated_at = excluded.updated_at
         RETURNING cursor_value`,
        streamId,
        streamId,
        sourceDeviceId,
        allocatedAt,
      );
      nextSequence = row!.cursor_value;
    })
  ));
  return nextSequence;
}

export async function loadSyncEntityHeadRevisionIds(entity: SyncMutationEntityRef) {
  assertEntityRef(entity);
  const database = await getMutationStateDatabase();
  const rows = await enqueueSyncDatabaseOperation(() => (
    database.getAllAsync<EntityHeadRow>(
      `SELECT revision_id
       FROM sync_entity_heads
       WHERE domain = ? AND entity_type = ? AND entity_id = ?
       ORDER BY revision_id ASC`,
      entity.domain,
      entity.type,
      entity.id,
    )
  ));
  rows.forEach((row, index) => assertSyncUuidV4(row.revision_id, `entityHead[${index}]`));
  return rows.map((row) => row.revision_id);
}

// Legacy conversation ids differ from v2 story ids. Consult the existing ledger
// even after the business row was deleted, including its finite-cleanup receipt.
export async function hasTheaterStorySyncHistory(conversationId: string) {
  const entityId = `story:${conversationId}`;
  assertEntityRef({ domain: 'theater', type: 'theater-record', id: entityId });
  const database = await getMutationStateDatabase();
  return enqueueSyncDatabaseOperation(async () => Boolean(await database.getFirstAsync(
    `SELECT 1 FROM sync_entity_revisions
     WHERE domain = 'theater' AND entity_type = 'theater-record' AND entity_id = ?
     UNION ALL SELECT 1 FROM sync_finite_deletion_compactions_v1
     WHERE json_extract(request_json, '$.domain') = 'theater'
       AND json_extract(request_json, '$.entityType') = 'theater-record'
       AND json_extract(request_json, '$.entityId') = ? LIMIT 1`, entityId, entityId,
  )));
}

export async function loadSyncEntityHeadMutations(
  entity: SyncMutationEntityRef,
) {
  assertEntityRef(entity);
  const database = await getMutationStateDatabase();
  const rows = await enqueueSyncDatabaseOperation(() => (
    database.getAllAsync<StoredMutationRow>(
      `SELECT revisions.mutation_json
       FROM sync_entity_heads AS heads
       INNER JOIN sync_entity_revisions AS revisions
         ON revisions.revision_id = heads.revision_id
       WHERE heads.domain = ?
         AND heads.entity_type = ?
         AND heads.entity_id = ?
       ORDER BY heads.revision_id ASC`,
      entity.domain,
      entity.type,
      entity.id,
    )
  ));
  return rows.map((row, index) => {
    let mutation: unknown;
    try {
      mutation = JSON.parse(row.mutation_json) as unknown;
    } catch (error) {
      throw new Error(`sync entity head ${index} JSON 损坏。`, {
        cause: error,
      });
    }
    assertPlainMutationV1(mutation);
    return mutation;
  });
}

export async function loadSyncBaiyunPostTagHeadMutations() {
  const database = await getMutationStateDatabase();
  const rows = await enqueueSyncDatabaseOperation(() => database.getAllAsync<StoredMutationRow>(
    `SELECT revisions.mutation_json FROM sync_entity_heads heads
     JOIN sync_entity_revisions revisions ON revisions.revision_id = heads.revision_id
     WHERE heads.domain = 'memory' AND heads.entity_type = 'post-tag'
     ORDER BY heads.entity_id, heads.revision_id`,
  ));
  return rows.map(row => {
    const mutation: unknown = JSON.parse(row.mutation_json);
    assertPlainMutationV1(mutation);
    return mutation;
  });
}

export async function loadSyncEntityHeadOperations(
  entity: SyncMutationEntityRef,
) {
  assertEntityRef(entity);
  const database = await getMutationStateDatabase();
  const rows = await enqueueSyncDatabaseOperation(() => (
    database.getAllAsync<EntityHeadOperationRow>(
      `SELECT revisions.operation
       FROM sync_entity_heads AS heads
       INNER JOIN sync_entity_revisions AS revisions
         ON revisions.revision_id = heads.revision_id
       WHERE heads.domain = ?
         AND heads.entity_type = ?
         AND heads.entity_id = ?
       ORDER BY heads.revision_id ASC`,
      entity.domain,
      entity.type,
      entity.id,
    )
  ));
  return rows.map((row, index) => {
    if (
      row.operation !== 'upsert'
      && row.operation !== 'restore'
      && row.operation !== 'delete'
    ) {
      throw new Error(`sync entity head ${index} operation 无效。`);
    }
    return row.operation;
  });
}

export async function loadSyncRevisionMutation(revisionId: string): Promise<PlainMutationV1 | null> {
  assertSyncUuidV4(revisionId, 'revisionId');
  const database = await getMutationStateDatabase();
  const row = await enqueueSyncDatabaseOperation(() => database.getFirstAsync<StoredMutationRow>(
    'SELECT mutation_json FROM sync_entity_revisions WHERE revision_id = ?', revisionId,
  ));
  if (!row) return null;
  const mutation: unknown = JSON.parse(row.mutation_json);
  assertPlainMutationV1(mutation);
  return mutation;
}

function sameSortedValues(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

export async function collapseSyncEntityHeads(entity: SyncMutationEntityRef, revisionId: string, expectedHeadIds: string[], resolvedAt: number) {
  assertEntityRef(entity);
  assertTimestamp(resolvedAt, 'resolvedAt');
  if (!expectedHeadIds.includes(revisionId)) throw new Error('Selected sync head is missing.');
  const database = await getMutationStateDatabase();
  await enqueueSyncDatabaseOperation(() => database.withExclusiveTransactionAsync(async transaction => {
    const rows = await transaction.getAllAsync<EntityHeadRow>(
      'SELECT revision_id FROM sync_entity_heads WHERE domain=? AND entity_type=? AND entity_id=?', entity.domain, entity.type, entity.id);
    if (!sameSortedValues(rows.map(row => row.revision_id), expectedHeadIds)) throw new Error('Post sync heads changed; retry reconciliation.');
    await transaction.runAsync('DELETE FROM sync_entity_heads WHERE domain=? AND entity_type=? AND entity_id=? AND revision_id<>?',
      entity.domain, entity.type, entity.id, revisionId);
    await transaction.runAsync("UPDATE sync_entity_conflicts SET state='resolved',resolved_at=? WHERE domain=? AND entity_type=? AND entity_id=? AND state='pending'",
      resolvedAt, entity.domain, entity.type, entity.id);
  }));
}

class SyncEntityHeadsChangedError extends Error {}

export async function enqueueSyncMutationAndAdvanceHeads(mutation: PlainMutationV1) {
  if (mutation.entity.domain === 'behavior' && mutation.entity.type === 'current-action') return;
  assertPlainMutationV1(mutation);
  const database = await getMutationStateDatabase();
  const serialized = JSON.stringify(mutation);
  try {
  await enqueueSyncDatabaseOperation(() => (
    database.withExclusiveTransactionAsync(async (transaction) => {
    const insert = await transaction.runAsync(
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
    if (insert.changes === 0) {
      const existing = await transaction.getFirstAsync<StoredMutationRow>(
        'SELECT mutation_json FROM sync_outbox WHERE mutation_id = ?',
        mutation.mutationId,
      );
      if (!existing || existing.mutation_json !== serialized) {
        throw new Error('相同 mutationId 对应了不同本地变更，已停止同步。');
      }
    }

    const revisionInsert = await transaction.runAsync(
      `INSERT INTO sync_entity_revisions (
         revision_id, mutation_id, domain, entity_type, entity_id,
         parents_json, operation, schema_version, mutation_json,
         source_device_id, source_sequence, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(revision_id) DO NOTHING`,
      mutation.revision.id,
      mutation.mutationId,
      mutation.entity.domain,
      mutation.entity.type,
      mutation.entity.id,
      JSON.stringify(mutation.revision.parents),
      mutation.revision.operation,
      mutation.revision.schemaVersion,
      serialized,
      mutation.sourceDeviceId,
      mutation.sourceSequence,
      mutation.createdAt,
    );
    if (revisionInsert.changes === 0) {
      const storedRevision = await transaction.getFirstAsync<StoredMutationRow>(
        'SELECT mutation_json FROM sync_entity_revisions WHERE revision_id = ?',
        mutation.revision.id,
      );
      if (!storedRevision || storedRevision.mutation_json !== serialized) {
        throw new Error('相同 revisionId 对应了不同 mutation，已停止同步。');
      }
    }

    const currentHeadRows = await transaction.getAllAsync<EntityHeadRow>(
      `SELECT revision_id
       FROM sync_entity_heads
       WHERE domain = ? AND entity_type = ? AND entity_id = ?
       ORDER BY revision_id ASC`,
      mutation.entity.domain,
      mutation.entity.type,
      mutation.entity.id,
    );
    const currentHeads = currentHeadRows.map((row) => row.revision_id);
    if (currentHeads.length === 1 && currentHeads[0] === mutation.revision.id) return;
    if (!sameSortedValues(currentHeads, mutation.revision.parents)) {
      throw new SyncEntityHeadsChangedError('sync entity heads 已变化，当前 mutation 必须重新基于最新 heads 构造。');
    }
    await transaction.runAsync(
      `DELETE FROM sync_entity_heads
       WHERE domain = ? AND entity_type = ? AND entity_id = ?`,
      mutation.entity.domain,
      mutation.entity.type,
      mutation.entity.id,
    );
    await transaction.runAsync(
      `INSERT INTO sync_entity_heads (
         domain, entity_type, entity_id, revision_id, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
      mutation.entity.domain,
      mutation.entity.type,
      mutation.entity.id,
      mutation.revision.id,
      mutation.createdAt,
    );
    if (mutation.entity.domain === 'wish-pool' && mutation.entity.type === 'wish'
      || mutation.revision.parents.length >= 2
      && (mutation.entity.domain === 'life' && mutation.entity.type === 'drive-state'
        || mutation.entity.domain === 'memory' && mutation.entity.type === 'memory')
      || mutation.entity.domain === 'memory' && mutation.revision.parents.length >= 2
      && (['post', 'post-comment', 'post-tag'].includes(mutation.entity.type)
        || mutation.entity.type === 'memory' && !!await transaction.getFirstAsync(
          "SELECT 1 FROM sync_entity_heads WHERE domain = 'memory' AND entity_type = 'post' AND entity_id = ? LIMIT 1", mutation.entity.id)
        || mutation.entity.type === 'interaction-fact' && ['post-reading', 'post-notice-read'].includes(mutation.entity.id))) {
      await transaction.runAsync(
        `UPDATE sync_entity_conflicts SET state = 'resolved', resolved_at = ?
         WHERE domain = ? AND entity_type = ? AND entity_id = ? AND state = 'pending'`,
        mutation.createdAt, mutation.entity.domain, mutation.entity.type, mutation.entity.id,
      );
    }
    })
  ));
  } catch (error) {
    // A post was already captured against its native head while an incoming
    // head advanced centrally. Its signed version remains a real concurrent
    // edit. Generated multi-parent merges still need an exact CAS and retry.
    if (!(error instanceof SyncEntityHeadsChangedError) || mutation.entity.domain !== 'memory'
      || mutation.revision.parents.length > 1) throw error;
    const postMemoryShadow = mutation.entity.type === 'memory'
      && (await loadSyncEntityHeadMutations({ domain: 'memory', type: 'post', id: mutation.entity.id })).length > 0;
    if (!['post', 'post-comment', 'post-tag'].includes(mutation.entity.type) && !postMemoryShadow) throw error;
    const { applyVerifiedAndroidSyncMutation } = await import('./syncAndroidMutationLedger');
    await applyVerifiedAndroidSyncMutation(mutation, mutation.createdAt);
    const { enqueueSyncMutation } = await import('./syncStore');
    await enqueueSyncMutation(mutation);
  }
  notifyAutomaticDataSyncWorkAvailable();
}

/** Native capture already fixed this version before central heads advanced. */
export async function enqueueCapturedMemoryRecordMutation(mutation: PlainMutationV1) {
  try {
    await enqueueSyncMutationAndAdvanceHeads(mutation);
  } catch (error) {
    if (!(error instanceof SyncEntityHeadsChangedError)
      || mutation.entity.domain !== 'memory' || mutation.entity.type !== 'memory') throw error;
    if (mutation.revision.parents.length !== 1) {
      if (mutation.revision.parents.length < 2
        || !['upsert', 'delete'].includes(mutation.revision.operation)) throw error;
      const { isPersistedCapturedMemoryMutation } = await import('./syncMemoryRecordsSqlitePort');
      if (!await isPersistedCapturedMemoryMutation(mutation)) throw error;
    }
    const { applyVerifiedAndroidSyncMutation } = await import('./syncAndroidMutationLedger');
    await applyVerifiedAndroidSyncMutation(mutation, mutation.createdAt);
    const { enqueueSyncMutation } = await import('./syncStore');
    await enqueueSyncMutation(mutation);
    notifyAutomaticDataSyncWorkAvailable();
  }
}

/** Native capture already fixed this version before central heads advanced. */
export async function enqueueCapturedScheduleSemanticMutation(mutation: PlainMutationV1) {
  try { await enqueueSyncMutationAndAdvanceHeads(mutation); }
  catch (error) {
    if (!(error instanceof SyncEntityHeadsChangedError) || mutation.entity.domain !== 'schedule'
      || mutation.revision.parents.length > 1) throw error;
    const { applyVerifiedAndroidSyncMutation } = await import('./syncAndroidMutationLedger');
    await applyVerifiedAndroidSyncMutation(mutation, mutation.createdAt);
    const { enqueueSyncMutation } = await import('./syncStore');
    await enqueueSyncMutation(mutation);
    notifyAutomaticDataSyncWorkAvailable();
  }
}

const HIGH_SENSITIVITY_RETENTION_TARGETS = new Set([
  'body-signal\u0000reading',
  'body-signal\u0000care-summary',
  'activity\u0000activity-reading',
  'activity\u0000formal-observation',
  'nearby-world\u0000location-observation',
  'nearby-world\u0000movement-event',
  'tools\u0000visit',
  'tools\u0000audit-event',
]);

export async function listCurrentSingleHeadMutationsForRetention(input: {
  domain: string;
  entityType: string;
  limit?: number;
  after?: { createdAt: number; entityId: string };
}) {
  const limit = input.limit ?? 128;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) {
    throw new Error('高敏留存 current-head 扫描上限必须为 1..512。');
  }
  if (!HIGH_SENSITIVITY_RETENTION_TARGETS.has(
    `${input.domain}\u0000${input.entityType}`,
  )) {
    throw new Error('高敏留存 current-head 扫描领域无效。');
  }
  if (
    input.after
    && (
      !Number.isSafeInteger(input.after.createdAt)
      || input.after.createdAt < 0
      || !input.after.entityId
      || input.after.entityId.length > 256
    )
  ) {
    throw new Error('高敏留存 current-head 扫描游标无效。');
  }
  const database = await getMutationStateDatabase();
  const afterCreatedAt = input.after?.createdAt ?? 0;
  const afterEntityId = input.after?.entityId ?? '';
  const rows = await enqueueSyncDatabaseOperation(() => (
    database.getAllAsync<StoredMutationRow>(
      `SELECT revisions.mutation_json
       FROM sync_entity_revisions AS revisions
         INDEXED BY idx_sync_entity_revisions_retention_scan
       INNER JOIN sync_entity_heads AS heads
         ON heads.revision_id = revisions.revision_id
        AND heads.domain = revisions.domain
        AND heads.entity_type = revisions.entity_type
        AND heads.entity_id = revisions.entity_id
       WHERE revisions.domain = ?
         AND revisions.entity_type = ?
         AND revisions.operation <> 'delete'
         AND (
           revisions.created_at > ?
           OR (
             revisions.created_at = ?
             AND revisions.entity_id > ?
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM sync_entity_heads AS other
           WHERE other.domain = heads.domain
             AND other.entity_type = heads.entity_type
             AND other.entity_id = heads.entity_id
             AND other.revision_id <> heads.revision_id
         )
       ORDER BY revisions.created_at ASC, revisions.entity_id ASC
       LIMIT ?`,
      input.domain,
      input.entityType,
      afterCreatedAt,
      afterCreatedAt,
      afterEntityId,
      limit,
    )
  ));
  return rows.map((row, index) => {
    let mutation: unknown;
    try {
      mutation = JSON.parse(row.mutation_json) as unknown;
    } catch (error) {
      throw new Error(`高敏留存 current head ${index} JSON 损坏。`, {
        cause: error,
      });
    }
    assertPlainMutationV1(mutation);
    return mutation;
  });
}

export type HighSensitivityRetentionScanCursor = {
  targetIndex: number;
  createdAt: number;
  entityId: string;
};

function assertHighSensitivityRetentionScanCursor(
  cursor: HighSensitivityRetentionScanCursor,
) {
  if (
    !Number.isSafeInteger(cursor.targetIndex)
    || cursor.targetIndex < 0
    || cursor.targetIndex > HIGH_SENSITIVITY_RETENTION_TARGET_COUNT
    || !Number.isSafeInteger(cursor.createdAt)
    || cursor.createdAt < 0
    || cursor.entityId.length > 256
    || (
      cursor.targetIndex === HIGH_SENSITIVITY_RETENTION_TARGET_COUNT
      && (cursor.createdAt !== 0 || cursor.entityId !== '')
    )
    || (
      cursor.targetIndex < HIGH_SENSITIVITY_RETENTION_TARGET_COUNT
      && cursor.createdAt > 0
      && !cursor.entityId
    )
  ) {
    throw new Error('高敏留存持久扫描游标无效。');
  }
}

function highSensitivityRetentionScanStreamId(
  cursor: HighSensitivityRetentionScanCursor,
) {
  assertHighSensitivityRetentionScanCursor(cursor);
  return HIGH_SENSITIVITY_RETENTION_SCAN_CURSOR_PREFIX
    + encodeURIComponent(JSON.stringify(cursor));
}

export async function loadHighSensitivityRetentionScanState() {
  const database = await getMutationStateDatabase();
  return enqueueSyncDatabaseOperation(async () => {
    const rows = await database.getAllAsync<{
      stream_id: string;
      updated_at: number;
    }>(
      `SELECT stream_id, updated_at
       FROM sync_cursors
       WHERE stream_id LIKE ?
       ORDER BY updated_at DESC, stream_id ASC
       LIMIT 2`,
      `${HIGH_SENSITIVITY_RETENTION_SCAN_CURSOR_PREFIX}%`,
    );
    if (rows.length > 1) {
      throw new Error('高敏留存存在多个持久扫描游标。');
    }
    const row = rows[0];
    if (!row) return null;
    let cursor: HighSensitivityRetentionScanCursor;
    try {
      cursor = JSON.parse(decodeURIComponent(row.stream_id.slice(
        HIGH_SENSITIVITY_RETENTION_SCAN_CURSOR_PREFIX.length,
      ))) as HighSensitivityRetentionScanCursor;
    } catch (error) {
      throw new Error('高敏留存持久扫描游标损坏。', {
        cause: error,
      });
    }
    assertHighSensitivityRetentionScanCursor(cursor);
    assertTimestamp(row.updated_at, 'retention scan updatedAt');
    return { cursor, updatedAt: row.updated_at };
  });
}

export async function saveHighSensitivityRetentionScanState(input: {
  cursor: HighSensitivityRetentionScanCursor;
  updatedAt: number;
}) {
  const streamId = highSensitivityRetentionScanStreamId(input.cursor);
  assertTimestamp(input.updatedAt, 'retention scan updatedAt');
  const database = await getMutationStateDatabase();
  await enqueueSyncDatabaseOperation(() => (
    database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        'DELETE FROM sync_cursors WHERE stream_id LIKE ?',
        `${HIGH_SENSITIVITY_RETENTION_SCAN_CURSOR_PREFIX}%`,
      );
      await transaction.runAsync(
        `INSERT INTO sync_cursors (
           stream_id, cursor_value, updated_at
         ) VALUES (?, 1, ?)`,
        streamId,
        input.updatedAt,
      );
    })
  ));
}

export const syncMutationStatePort: SyncMutationStatePort = {
  allocateSyncSourceSequence,
  loadSyncEntityHeadRevisionIds,
};

export async function closeSyncMutationStateDatabaseForTests() {
  if (!mutationStateDatabasePromise) return;
  const database = await mutationStateDatabasePromise;
  await enqueueSyncDatabaseOperation(() => database.closeAsync());
  mutationStateDatabasePromise = undefined;
}
