import type * as SQLite from 'expo-sqlite';
import { canonicalizeContinuityMatterRecord, isRetiredContinuityCard, legacyContinuityMatterNeedsEvidence, CONTINUITY_MATTER_REAL_EVIDENCE } from '../ai/behavior/continuityMatterRecord';
import { isBaiyunPostMemory } from '../posts/baiyunPostContract';
import { notifyMemoryProcessingWorkAvailable } from '../memory/memoryProcessingSignals';
import { buildBaiyunPostBusinessStatements } from './syncBaiyunPostRecordsSql';
import { normalizePostConfirmationRecord } from './syncBaiyunPostConfirmations';

import {
  assertMemoryRecordsMutationV1,
  getMemoryRecordEntitySpec,
  isRetiredStayMemoryRecordsMutation,
  type MemoryRecordEntitySpec,
  type MemoryRecordEntityType,
} from './syncMemoryRecords';
import type {
  MemoryRecordsApplyPort,
  MemoryRecordsEntityRef,
} from './syncMemoryRecordsApply';
import type {
  MemoryRecordMergeDecision,
  MemoryRecordRevisionValue,
} from './syncMemoryRecordsMerge';
import { mergeMemoryStatsPayload, sameMemoryRecordPayload } from './syncMemoryRecordsMerge';
import { memoryRecordCorrectionMarker } from './syncMemoryRecordsMerge';
import {
  ensureMemoryRecordsCaptureSchema,
  runWithMemoryRecordsCaptureSuppressed,
} from './syncMemoryRecordsSqlitePort';
import { loadSyncRevisionMutation, loadSyncEntityHeadMutations } from './syncMutationStateStore';
import { planCurrentMemoryProjection } from './syncMemoryCurrentProjection';
import {
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

type AppliedRow = {
  mutation_id: string;
};

export type MemoryCorrectionDeleteBinding = { memoryId: string; chatSummaryCorrection: string };
type MemoryCorrectionDeleteHandler = (binding: MemoryCorrectionDeleteBinding) => Promise<void>;
const defaultCorrectionDeleteHandler: MemoryCorrectionDeleteHandler = async binding => {
  const { normalizeMemoryChatSummaryCorrection } = await import('../chat/chatSummaryCorrection');
  const marker = normalizeMemoryChatSummaryCorrection(JSON.parse(binding.chatSummaryCorrection));
  if (!marker) throw new Error('memory.records delete correction marker 无效。');
  const { pauseChatSummaryForDeletedCorrection } = await import('../chat/chatSummaryCorrectionStore');
  await pauseChatSummaryForDeletedCorrection(binding.memoryId, marker);
};
let correctionDeleteHandler = defaultCorrectionDeleteHandler;

/** Tests may override the local pause IO; production always has the real lazy handler. */
export function setMemoryRecordsCorrectionDeleteHandler(handler: MemoryCorrectionDeleteHandler | null) {
  const previous = correctionDeleteHandler;
  correctionDeleteHandler = handler ?? defaultCorrectionDeleteHandler;
  return () => { correctionDeleteHandler = previous; };
}

async function correctionDeleteBindings(
  database: Pick<SQLite.SQLiteDatabase, 'getFirstAsync'>,
  input: { mutation: PlainMutationV1; decision: MemoryRecordMergeDecision },
): Promise<MemoryCorrectionDeleteBinding[]> {
  const entityType = input.mutation.entity.type as MemoryRecordEntityType;
  if (!['memory', 'post'].includes(entityType) || input.decision.operation !== 'delete'
    || input.decision.kind === 'already-current' || input.decision.kind === 'ignore-incoming') return [];
  const local = await database.getFirstAsync<{ chat_summary_correction_json: string | null }>(
    'SELECT chat_summary_correction_json FROM memories WHERE id = ?', input.mutation.entity.id);
  const markers = [local?.chat_summary_correction_json ?? null,
    memoryRecordCorrectionMarker(entityType, 'delete', input.decision.payload)]
    .filter((marker): marker is string => marker !== null);
  return [...new Set(markers)].sort().map(chatSummaryCorrection => ({
    memoryId: input.mutation.entity.id, chatSummaryCorrection,
  }));
}

type HeadRow = {
  revision_id: string;
};

type RevisionRow = {
  revision_id: string;
  parent_revision_ids_json: string;
  operation: SyncOperation;
  payload_json: string;
  created_at: number;
  mutation_json: string | null;
};

type LocalRevisionRow = {
  mutation_id: string;
  revision_id: string;
  parent_revision_ids_json: string;
  vault_id: string;
  source_device_id: string;
  source_sequence: number | null;
  entity_type: string;
  entity_id: string;
  operation: SyncOperation;
  schema_version: number;
  payload_json: string;
  created_at: number;
};

type RuntimeRow = {
  capture_enabled: number;
  vault_id: string | null;
  source_device_id: string | null;
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

function parseJsonValue(raw: string, label: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
  return parsed as JsonValue;
}

function parseParents(raw: string) {
  const parsed = parseJsonValue(raw, 'memory revision parents');
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('memory revision parents 必须是字符串数组。');
  }
  return parsed as string[];
}

function revisionFromRow(row: RevisionRow): MemoryRecordRevisionValue {
  return {
    revisionId: row.revision_id,
    parentRevisionIds: parseParents(row.parent_revision_ids_json),
    operation: row.operation,
    createdAt: row.created_at,
    payload: parseJsonValue(row.payload_json, 'memory revision payload'),
  };
}

function payloadRecord(payload: JsonValue) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('memory.records payload 必须是对象。');
  }
  const record = (payload as { record?: unknown }).record;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('memory.records payload.record 必须是对象。');
  }
  return record as Record<string, JsonValue>;
}

async function isRetiredStayEventId(
  transaction: SQLite.SQLiteDatabase,
  eventId: string,
) {
  const local = await transaction.getFirstAsync<Record<string, unknown>>(
    'SELECT * FROM continuity_events WHERE id = ? LIMIT 1',
    eventId,
  );
  if (local?.schema_version === 2) return false;
  if (local && isRetiredContinuityCard(local)) return true;
  const revisions = await transaction.getAllAsync<{ payload_json: string }>(
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
      const record = payloadRecord(parseJsonValue(
        revision.payload_json,
        'continuity event revision payload',
      ));
      return isRetiredContinuityCard(record);
    } catch {
      return false;
    }
  });
}

async function isRetiredStayBusinessMutation(
  transaction: SQLite.SQLiteDatabase,
  mutation: PlainMutationV1,
) {
  if (mutation.entity.type === 'continuity-candidate') return true;
  if (mutation.entity.type === 'continuity-event' && mutation.revision.operation !== 'delete'
    && isRetiredContinuityCard(payloadRecord(mutation.payload))) return true;
  if (isRetiredStayMemoryRecordsMutation(mutation)) return true;
  const entityType = mutation.entity.type as MemoryRecordEntityType;
  if (entityType === 'continuity-event') {
    return isRetiredStayEventId(transaction, mutation.entity.id);
  }
  if (entityType === 'continuity-link' && mutation.revision.operation === 'delete') {
    const ids = decodeEntityIds(getMemoryRecordEntitySpec(entityType)!, mutation.entity.id);
    return isRetiredStayEventId(transaction, ids[0]);
  }
  if (entityType === 'continuity-transition' && mutation.revision.operation === 'delete') {
    const transition = await transaction.getFirstAsync<{ event_id: string }>(
      'SELECT event_id FROM continuity_event_transitions WHERE id = ? LIMIT 1',
      mutation.entity.id,
    );
    return typeof transition?.event_id === 'string'
      && isRetiredStayEventId(transaction, transition.event_id);
  }
  if (entityType === 'continuity-candidate' && mutation.revision.operation === 'delete') {
    const candidate = await transaction.getFirstAsync<{
      primary_intent: string;
      target_event_id: string | null;
      result_event_id: string | null;
    }>(
      `SELECT primary_intent, target_event_id, result_event_id
       FROM continuity_event_candidates
       WHERE id = ? LIMIT 1`,
      mutation.entity.id,
    );
    if (candidate?.primary_intent === 'stay') return true;
    const eventIds = [candidate?.target_event_id, candidate?.result_event_id]
      .filter((eventId): eventId is string => typeof eventId === 'string');
    for (const eventId of eventIds) {
      if (await isRetiredStayEventId(transaction, eventId)) return true;
    }
    return false;
  }
  if (mutation.revision.operation === 'delete') return false;
  const record = payloadRecord(mutation.payload);
  if (entityType === 'continuity-transition' || entityType === 'continuity-link') {
    const eventId = record.event_id;
    return typeof eventId === 'string'
      && isRetiredStayEventId(transaction, eventId);
  }
  if (entityType === 'continuity-candidate') {
    for (const eventId of [record.target_event_id, record.result_event_id]) {
      if (
        typeof eventId === 'string'
        && await isRetiredStayEventId(transaction, eventId)
      ) return true;
    }
    return false;
  }
  return false;
}

function decodeEntityIds(spec: MemoryRecordEntitySpec, entityId: string) {
  if (spec.idColumns.length === 1) return [entityId];
  let values: unknown;
  try {
    values = JSON.parse(entityId);
  } catch {
    throw new Error(`memory.records ${spec.entityType} 复合 entityId 不是有效 JSON。`);
  }
  if (
    !Array.isArray(values)
    || values.length !== spec.idColumns.length
    || values.some((value) => typeof value !== 'string' || !value)
  ) {
    throw new Error(`memory.records ${spec.entityType} 复合 entityId 无效。`);
  }
  return values as string[];
}

function sqlColumn(name: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error('memory.records SQL column 不是受控 token。');
  }
  return `"${name}"`;
}

async function applyBusinessView(input: {
  transaction: SQLite.SQLiteDatabase;
  entityType: MemoryRecordEntityType;
  entityId: string;
  operation: SyncOperation;
  payload: JsonValue;
  applyingPostBody?: boolean;
  preservePostImages?: boolean;
}) {
  const spec = getMemoryRecordEntitySpec(input.entityType);
  if (!spec) throw new Error('memory.records apply entityType 无效。');
  if (input.entityType === 'post-review' || input.entityType === 'post-review-action') {
    if (input.operation === 'delete') throw new Error('共享审核不支持删除。');
    const review = await import('./syncBaiyunPostReviews');
    const record = payloadRecord(input.payload);
    if (input.entityType === 'post-review') await review.applySharedPostReview(input.transaction, record);
    else await review.applySharedPostReviewAction(input.transaction, record);
    return;
  }
  if (input.entityType === 'post-confirmation' && input.operation !== 'delete') {
    const record = payloadRecord(input.payload);
    for (const [kind, id] of [['memory', record.memory_id], ['current-state', record.current_state_id]] as const) {
      if (typeof id !== 'string') continue;
      const heads = await input.transaction.getAllAsync<{ revision_id: string }>(
        'SELECT revision_id FROM memory_sync_entity_heads WHERE entity_type = ? AND entity_id = ?', kind, id);
      for (const head of heads) if ((await loadRevisionFromDatabase(input.transaction, head.revision_id))?.operation === 'delete') return;
    }
    const previous = await input.transaction.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM baiyun_post_confirmations WHERE batch_id=? AND item_key=?', record.batch_id as string, record.item_key as string);
    if (previous && JSON.stringify(normalizePostConfirmationRecord(previous)) !== JSON.stringify(normalizePostConfirmationRecord(record))) {
      throw new Error('post-confirmation 同一确认身份对应了不同内容。');
    }
  }
  if (!input.applyingPostBody && (input.entityType === 'memory' || input.entityType === 'comment')) {
    const legacy = input.operation === 'delete' ? null : payloadRecord(input.payload);
    const row = input.entityType === 'comment' && !legacy
      ? await input.transaction.getFirstAsync<{ memory_id: string }>('SELECT memory_id FROM memory_comments WHERE id = ?', input.entityId) : null;
    const postId = input.entityType === 'memory' ? input.entityId : String(legacy?.memory_id ?? row?.memory_id ?? '');
    if (postId && await input.transaction.getFirstAsync(`SELECT 1 FROM memory_sync_entity_heads
      WHERE entity_type = 'post' AND entity_id = ? LIMIT 1`, postId)) return;
  }
  if (['post', 'post-comment', 'post-tag'].includes(input.entityType)) {
    const record = input.operation === 'delete' ? {} : { ...payloadRecord(input.payload) };
    if (input.entityType === 'post' && input.preservePostImages) {
      delete record.image_group_json; delete record.image_assets_json; delete record.image_description;
    }
    if (input.operation !== 'delete') {
      const ids = spec.idColumns.map(column => record[column]);
      if ((ids.length === 1 ? ids[0] : JSON.stringify(ids)) !== input.entityId) throw new Error('post entity ID 不一致。');
    }
    if (input.entityType === 'post-comment') {
      const postId = String(input.operation === 'delete' ? decodeEntityIds(spec, input.entityId)[0] : record.post_id);
      if (!await input.transaction.getFirstAsync('SELECT post_id FROM baiyun_post_metadata WHERE post_id = ?', postId)) {
        const heads = await input.transaction.getAllAsync<{ revision_id: string }>(
          "SELECT revision_id FROM memory_sync_entity_heads WHERE entity_type = 'post' AND entity_id = ?", postId);
        for (const head of heads) if ((await loadRevisionFromDatabase(input.transaction, head.revision_id))?.operation === 'delete') return;
        throw new Error('post comment parent 尚未到达。');
      }
    }
    if (input.entityType === 'post' && input.operation === 'delete') {
      await applyBusinessView({ ...input, entityType: 'memory', applyingPostBody: true });
    }
    for (const statement of buildBaiyunPostBusinessStatements(input.entityType, input.entityId, input.operation, record)) {
      await input.transaction.runAsync(statement.sql, ...statement.params);
    }
    return;
  }
  if (input.operation === 'delete') {
    const ids = decodeEntityIds(spec, input.entityId);
    const where = spec.idColumns.map((column) => `${sqlColumn(column)} = ?`).join(' AND ');
    if (input.entityType === 'continuity-event') {
      await input.transaction.runAsync('DELETE FROM continuity_event_links WHERE event_id = ?', ids[0]);
      await input.transaction.runAsync('DELETE FROM continuity_event_transitions WHERE event_id = ?', ids[0]);
    }
    if (input.entityType === 'memory') {
      const memoryId = ids[0];
      await input.transaction.runAsync(
        `UPDATE memory_current_states
         SET source_type = 'manual', source_memory_id = NULL, source_title = NULL
         WHERE source_memory_id = ?`,
        memoryId,
      );
      await input.transaction.runAsync(
        'UPDATE memory_ingestion_items SET memory_id = NULL WHERE memory_id = ?',
        memoryId,
      );
      await input.transaction.runAsync(
        'DELETE FROM memory_timeline_members WHERE memory_id = ?',
        memoryId,
      );
      await input.transaction.runAsync(
        'DELETE FROM memory_recall_feedback WHERE memory_id = ?',
        memoryId,
      );
      await input.transaction.runAsync(
        'DELETE FROM memory_comments WHERE source = ?',
        memoryId,
      );
      await input.transaction.runAsync(
        'DELETE FROM memory_comments WHERE memory_id = ?',
        memoryId,
      );
      await input.transaction.runAsync(
        'DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?',
        memoryId,
        memoryId,
      );
      await input.transaction.runAsync(
        "DELETE FROM memory_embeddings WHERE target_kind = 'memory' AND memory_id = ?",
        memoryId,
      );
      await input.transaction.runAsync(
        'DELETE FROM memory_source_refs WHERE memory_id = ?',
        memoryId,
      );
      await input.transaction.runAsync(
        "DELETE FROM memory_processing_jobs WHERE target_kind = 'memory' AND memory_id = ?",
        memoryId,
      );
      await input.transaction.runAsync(
        'DELETE FROM memory_lifecycle_events WHERE memory_id = ? OR related_memory_id = ?',
        memoryId,
        memoryId,
      );
      await input.transaction.runAsync(
        `DELETE FROM memory_merge_recovery_snapshots
         WHERE source_memory_id = ? OR target_memory_id = ?`,
        memoryId,
        memoryId,
      );
      await input.transaction.runAsync(
        `DELETE FROM continuity_event_links
         WHERE relation = 'memory' AND target_kind = 'memory' AND target_id = ?`,
        memoryId,
      );
    }
    if (input.entityType === 'current-state') {
      await input.transaction.runAsync("DELETE FROM memory_embeddings WHERE target_kind = 'current_state' AND memory_id = ?", ids[0]);
      await input.transaction.runAsync("DELETE FROM memory_processing_jobs WHERE target_kind = 'current_state' AND memory_id = ?", ids[0]);
      await input.transaction.runAsync(
        `DELETE FROM continuity_event_links
         WHERE relation = 'current_state'
           AND target_kind = 'memory_current_state'
           AND target_id = ?`,
        ids[0],
      );
    }
    await input.transaction.runAsync(
      `DELETE FROM ${sqlColumn(spec.tableName)} WHERE ${where}`,
      ...ids,
    );
    return;
  }
  let record = payloadRecord(input.payload);
  if (input.entityType === 'current-state') record = { known_at: null, source_refs_json: '[]', ...record };
  if (input.entityType === 'continuity-candidate') return;
  if (input.entityType === 'continuity-link' || input.entityType === 'continuity-transition') {
    const heads = await input.transaction.getAllAsync<{ revision_id: string }>(
      "SELECT revision_id FROM memory_sync_entity_heads WHERE entity_type = 'continuity-event' AND entity_id = ?",
      String(record.event_id),
    );
    for (const head of heads) {
      if ((await loadRevisionFromDatabase(input.transaction, head.revision_id))?.operation === 'delete') return;
    }
  }
  if (input.entityType === 'continuity-event') {
    if (isRetiredContinuityCard(record)) return;
    if (legacyContinuityMatterNeedsEvidence(record)) {
      const evidence = await input.transaction.getFirstAsync<{ id: string }>(
        `SELECT id FROM continuity_event_transitions WHERE event_id = ? AND evidence_outcome = 'succeeded'
         AND evidence_kind IN (${CONTINUITY_MATTER_REAL_EVIDENCE.map(() => '?').join(',')}) LIMIT 1`,
        input.entityId, ...CONTINUITY_MATTER_REAL_EVIDENCE,
      );
      if (!evidence) return;
    }
    record = canonicalizeContinuityMatterRecord(record);
  }
  const columns = Object.keys(spec.fields);
  const values = columns.map((column) => {
    const value = record[column];
    if (value === undefined && spec.fields[column].startsWith('nullable')) return null;
    return value as string | number | null;
  });
  const updateColumns = columns.filter((column) => !spec.idColumns.includes(column));
  const conflictColumns = spec.idColumns.map(sqlColumn).join(', ');
  const update = updateColumns.length
    ? `DO UPDATE SET ${updateColumns.map((column) => (
      `${sqlColumn(column)} = excluded.${sqlColumn(column)}`
    )).join(', ')}`
    : 'DO NOTHING';
  await input.transaction.runAsync(
    `INSERT INTO ${sqlColumn(spec.tableName)} (
       ${columns.map(sqlColumn).join(', ')}
     ) VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT (${conflictColumns}) ${update}`,
    ...values,
  );
  if (input.entityType === 'current-state') {
    const { queueCurrentStateEmbeddingWithDatabase } = await import('../memory/memoryProcessingQueue');
    await queueCurrentStateEmbeddingWithDatabase(input.transaction, input.entityId);
  }
  if (input.entityType === 'continuity-transition' && record.evidence_outcome === 'succeeded'
    && CONTINUITY_MATTER_REAL_EVIDENCE.includes(record.evidence_kind as typeof CONTINUITY_MATTER_REAL_EVIDENCE[number])) {
    const eventId = String(record.event_id);
    const present = await input.transaction.getFirstAsync<{ id: string }>('SELECT id FROM continuity_events WHERE id = ?', eventId);
    if (!present) {
      const heads = await input.transaction.getAllAsync<{ revision_id: string }>(
        "SELECT revision_id FROM memory_sync_entity_heads WHERE entity_type = 'continuity-event' AND entity_id = ?", eventId,
      );
      const head = heads.length === 1 ? await loadRevisionFromDatabase(input.transaction, heads[0].revision_id) : null;
      if (head && head.operation !== 'delete' && legacyContinuityMatterNeedsEvidence(payloadRecord(head.payload))
        && !isRetiredContinuityCard(payloadRecord(head.payload))) {
        await applyBusinessView({ ...input, entityType: 'continuity-event', entityId: eventId, operation: 'upsert', payload: head.payload });
      }
    }
  }
}

async function ensureApplySchema() {
  return ensureMemoryRecordsCaptureSchema();
}

async function loadRevisionFromDatabase(
  database: SQLite.SQLiteDatabase,
  revisionId: string,
  entity?: MemoryRecordsEntityRef,
) {
  const row = await database.getFirstAsync<RevisionRow>(
    `SELECT revision_id, parent_revision_ids_json, operation,
            payload_json, created_at, mutation_json
     FROM memory_sync_revision_log
     WHERE revision_id = ?
     UNION ALL
     SELECT revision_id, parent_revision_ids_json, operation,
            payload_json, created_at, NULL AS mutation_json
     FROM memory_sync_domain_outbox
     WHERE revision_id = ?
     LIMIT 1`,
    revisionId,
    revisionId,
  );
  if (row) return revisionFromRow(row);
  // A current-state rebuild keeps verified baseline revisions in the central
  // ledger. Read them there instead of copying old history into the native DB.
  const mutation = await loadSyncRevisionMutation(revisionId);
  if (!mutation) return null;
  assertMemoryRecordsMutationV1(mutation);
  if (entity && (mutation.entity.type !== entity.entityType
    || mutation.entity.id !== entity.entityId)) {
    throw new Error('memory.records 当前中央版本与实体不一致。');
  }
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: mutation.revision.parents,
    operation: mutation.revision.operation,
    createdAt: mutation.createdAt,
    payload: mutation.payload,
  };
}

function localRevisionMatchesMutation(
  row: LocalRevisionRow,
  mutation: PlainMutationV1,
) {
  return (
    row.mutation_id === mutation.mutationId
    && row.revision_id === mutation.revision.id
    && row.vault_id === mutation.vaultId
    && row.source_device_id === mutation.sourceDeviceId
    && row.source_sequence === mutation.sourceSequence
    && row.entity_type === mutation.entity.type
    && row.entity_id === mutation.entity.id
    && row.operation === mutation.revision.operation
    && row.schema_version === mutation.revision.schemaVersion
    && JSON.stringify(parseParents(row.parent_revision_ids_json))
      === JSON.stringify(mutation.revision.parents)
    && JSON.stringify(parseJsonValue(row.payload_json, 'local memory revision payload'))
      === JSON.stringify(mutation.payload)
    && row.created_at === mutation.createdAt
  );
}

async function insertIncomingRevision(
  transaction: SQLite.SQLiteDatabase,
  mutation: PlainMutationV1,
) {
  const serialized = JSON.stringify(mutation);
  const local = await transaction.getFirstAsync<LocalRevisionRow>(
    `SELECT mutation_id, revision_id, parent_revision_ids_json,
            vault_id, source_device_id, source_sequence,
            entity_type, entity_id, operation, schema_version,
            payload_json, created_at
     FROM memory_sync_domain_outbox
     WHERE revision_id = ? OR mutation_id = ?
     LIMIT 1`,
    mutation.revision.id,
    mutation.mutationId,
  );
  if (local) {
    if (!localRevisionMatchesMutation(local, mutation)) {
      throw new Error('远端 mutation/revision ID 与本地域 outbox 内容冲突。');
    }
    return;
  }
  const existing = await transaction.getFirstAsync<RevisionRow>(
    `SELECT revision_id, parent_revision_ids_json, operation,
            payload_json, created_at, mutation_json
     FROM memory_sync_revision_log
     WHERE revision_id = ? OR mutation_id = ?
     LIMIT 1`,
    mutation.revision.id,
    mutation.mutationId,
  );
  if (existing) {
    if (existing.mutation_json !== serialized) {
      throw new Error('相同 memory mutation/revision ID 对应不同内容。');
    }
    return;
  }
  await transaction.runAsync(
    `INSERT INTO memory_sync_revision_log (
       revision_id, mutation_id, entity_type, entity_id,
       parent_revision_ids_json, operation, schema_version,
       payload_json, mutation_json, source_device_id,
       source_sequence, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    mutation.revision.id,
    mutation.mutationId,
    mutation.entity.type,
    mutation.entity.id,
    JSON.stringify(mutation.revision.parents),
    mutation.revision.operation,
    mutation.revision.schemaVersion,
    JSON.stringify(mutation.payload),
    serialized,
    mutation.sourceDeviceId,
    mutation.sourceSequence,
    mutation.createdAt,
  );
}

async function generatedIds(transaction: SQLite.SQLiteDatabase) {
  const row = await transaction.getFirstAsync<GeneratedIdsRow>(
    `SELECT ${UUID_V4_SQL} AS mutation_id, ${UUID_V4_SQL} AS revision_id`,
  );
  if (!row) throw new Error('memory.records apply 无法生成 merge IDs。');
  return row;
}

async function insertMergeRevision(input: {
  transaction: SQLite.SQLiteDatabase;
  mutation: PlainMutationV1;
  parentRevisionIds: string[];
  operation: SyncOperation;
  payload: JsonValue;
  createdAt: number;
}) {
  const runtime = await input.transaction.getFirstAsync<RuntimeRow>(
    `SELECT capture_enabled, vault_id, source_device_id
     FROM memory_sync_runtime WHERE singleton_id = 1`,
  );
  if (
    !runtime
    || runtime.capture_enabled !== 1
    || runtime.vault_id !== input.mutation.vaultId
    || !runtime.source_device_id
  ) {
    throw new Error('memory.records merge revision 缺少匹配的 active capture identity。');
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
    JSON.stringify(input.parentRevisionIds),
    input.mutation.vaultId,
    runtime.source_device_id,
    input.mutation.entity.type,
    input.mutation.entity.id,
    input.operation,
    (input.payload as { schemaVersion: number }).schemaVersion,
    JSON.stringify(input.payload),
    input.createdAt,
    input.createdAt,
    input.createdAt,
  );
  return ids.revision_id;
}

function stableConflictId(localRevisionId: string | null, incomingRevisionId: string) {
  return [localRevisionId ?? 'none', incomingRevisionId].sort().join(':');
}

function isConflictDecision(
  decision: MemoryRecordMergeDecision,
): decision is Extract<MemoryRecordMergeDecision, { kind: 'conflict' }> {
  return decision.kind === 'conflict';
}

async function loadMemoryProjectionPayload(database: Pick<SQLite.SQLiteDatabase, 'getFirstAsync'>, entityId: string): Promise<JsonValue | null> {
  const row = await database.getFirstAsync<Record<string, JsonValue>>('SELECT * FROM memories WHERE id = ?', entityId);
  return row ? { schemaVersion: 10, record: Object.fromEntries(
    Object.keys(getMemoryRecordEntitySpec('memory')!.fields).map(field => [field, row[field] ?? null]),
  ) } : null;
}

export const memoryRecordsSqliteApplyPort: MemoryRecordsApplyPort = {
  async loadSelectedCurrentMemory(entityId) {
    const [heads, postHeads] = await Promise.all([
      loadSyncEntityHeadMutations({ domain: 'memory', type: 'memory', id: entityId }),
      loadSyncEntityHeadMutations({ domain: 'memory', type: 'post', id: entityId }),
    ]);
    return !postHeads.length && heads.length === 1 && heads[0].revision.operation === 'upsert' ? heads[0] : null;
  },

  async loadCurrentMemoryPayload(entityId) {
    return loadMemoryProjectionPayload(await ensureApplySchema(), entityId);
  },

  async hasAppliedMutation(mutationId) {
    const database = await ensureApplySchema();
    const row = await database.getFirstAsync<AppliedRow>(
      `SELECT mutation_id
       FROM memory_sync_applied_mutations
       WHERE mutation_id = ?`,
      mutationId,
    );
    return !!row;
  },

  async loadCurrentHeadRevisions(entity: MemoryRecordsEntityRef) {
    const database = await ensureApplySchema();
    const heads = await database.getAllAsync<HeadRow>(
      `SELECT revision_id
       FROM memory_sync_entity_heads
       WHERE entity_type = ? AND entity_id = ?
       ORDER BY revision_id ASC`,
      entity.entityType,
      entity.entityId,
    );
    const revisions: MemoryRecordRevisionValue[] = [];
    for (const head of heads) {
      const revision = await loadRevisionFromDatabase(database, head.revision_id, entity);
      if (!revision) {
        throw new Error(`memory.records head 缺少 revision：${head.revision_id}。`);
      }
      revisions.push(revision);
    }
    return revisions;
  },

  async loadRevision(revisionId) {
    const database = await ensureApplySchema();
    return loadRevisionFromDatabase(database, revisionId);
  },

  async commitAppliedMutation(input) {
    assertPlainMutationV1(input.mutation);
    const database = await ensureApplySchema();
    const preparedDeletes = await correctionDeleteBindings(database, input);
    for (const binding of preparedDeletes) await correctionDeleteHandler(binding);
    let conflict = false;
    let resultingHeadRevisionIds: string[] = [];
    let youMessageAt: number | null = null;
    let changedPostId: string | null = null;
    await runWithMemoryRecordsCaptureSuppressed(async (transaction) => {
      if (JSON.stringify(await correctionDeleteBindings(transaction, input)) !== JSON.stringify(preparedDeletes)) {
        throw new Error('memory.records delete correction marker 已变化，需重新准备。');
      }
      const applied = await transaction.getFirstAsync<AppliedRow>(
        `SELECT mutation_id
         FROM memory_sync_applied_mutations
         WHERE mutation_id = ?`,
        input.mutation.mutationId,
      );
      if (applied && !input.reconcileCurrentMemory) {
        resultingHeadRevisionIds = input.currentHeadRevisionIds;
        return;
      }
      const actualHeadRows = await transaction.getAllAsync<HeadRow>(
        `SELECT revision_id
         FROM memory_sync_entity_heads
         WHERE entity_type = ? AND entity_id = ?
         ORDER BY revision_id ASC`,
        input.mutation.entity.type,
        input.mutation.entity.id,
      );
      const actualHeads = actualHeadRows.map((row) => row.revision_id);
      const expectedHeads = [...input.currentHeadRevisionIds].sort();
      if (JSON.stringify(actualHeads) !== JSON.stringify(expectedHeads)) {
        throw new Error('memory.records entity heads 已变化，需基于最新 heads 重试。');
      }
      await insertIncomingRevision(transaction, input.mutation);
      let decision = input.decision;
      if (input.reconcileCurrentMemory) {
        const selected = await memoryRecordsSqliteApplyPort.loadSelectedCurrentMemory!(input.mutation.entity.id);
        if (input.mutation.entity.type !== 'memory' || !selected || selected.revision.id !== input.mutation.revision.id) {
          throw new Error('memory 当前中央稿已变化，需重读后对齐。');
        }
        const heads: MemoryRecordRevisionValue[] = [];
        for (const id of actualHeads) {
          const revision = await loadRevisionFromDatabase(transaction, id, { entityType: 'memory', entityId: input.mutation.entity.id });
          if (!revision) throw new Error('memory 当前本地稿缺少父依据。');
          heads.push(revision);
        }
        const plan = await planCurrentMemoryProjection({ incoming: { revisionId: selected.revision.id,
          parentRevisionIds: selected.revision.parents, operation: selected.revision.operation,
          createdAt: selected.createdAt, payload: selected.payload }, heads,
          business: await loadMemoryProjectionPayload(transaction, input.mutation.entity.id),
          loadRevision: id => loadRevisionFromDatabase(transaction, id) });
        if (!plan) throw new Error('memory 出现新的本地内容，保留原稿并停止对齐。');
        if (plan.aligned) { resultingHeadRevisionIds = actualHeads; return; }
        const parents = [...new Set([...actualHeads, selected.revision.id])].sort();
        decision = !plan.requiresMerge && sameMemoryRecordPayload(plan.payload, selected.payload)
          ? { kind: 'apply-incoming', payload: plan.payload, operation: 'upsert', resultingHeadRevisionIds: [selected.revision.id] }
          : { kind: 'merged', payload: plan.payload, operation: 'upsert', resultingHeadRevisionIds: parents,
            requiresMergeRevision: true, mergeParentRevisionIds: parents };
      }
      if (['memory', 'post'].includes(input.mutation.entity.type) && decision.operation !== 'delete') {
        const entityType = input.mutation.entity.type as 'memory' | 'post';
        if (input.mutation.revision.schemaVersion !== 10
          && !memoryRecordCorrectionMarker(entityType, decision.operation, decision.payload)) {
          const spec = getMemoryRecordEntitySpec(entityType)!;
          const local = await transaction.getFirstAsync<Record<string, JsonValue>>(
            entityType === 'memory' ? 'SELECT * FROM memories WHERE id = ?'
              : 'SELECT * FROM memory_sync_posts WHERE post_id = ?', input.mutation.entity.id);
          const localPayload: JsonValue | null = local ? { schemaVersion: 10,
            record: Object.fromEntries(Object.keys(spec.fields).map(field => [field, local[field] ?? null])) } : null;
          if (localPayload && memoryRecordCorrectionMarker(entityType, 'upsert', localPayload)) {
            const payload = mergeMemoryStatsPayload(localPayload, entityType, decision.payload);
            const parents = [...new Set([...input.currentHeadRevisionIds, input.mutation.revision.id])].sort();
            decision = { kind: 'merged', payload, operation: decision.operation as 'upsert' | 'restore',
              resultingHeadRevisionIds: parents, requiresMergeRevision: true, mergeParentRevisionIds: parents };
          }
        }
        const currentStats = await transaction.getFirstAsync<Record<string, JsonValue>>(
          `SELECT stats_semantics_version,activation_count,last_active_at,surface_count,last_mentioned_at
           FROM memories WHERE id=?`, input.mutation.entity.id);
        if (currentStats) {
          const statsPayload: JsonValue = { schemaVersion: 9, record: entityType === 'memory'
            ? currentStats : { memory_json: JSON.stringify(currentStats) } };
          const payload = mergeMemoryStatsPayload(decision.payload, entityType, statsPayload);
          if (!sameMemoryRecordPayload(payload, decision.payload)) {
            const parents = [...new Set([...input.currentHeadRevisionIds, input.mutation.revision.id])].sort();
            decision = decision.kind === 'conflict'
              ? { ...decision, payload, requiresMergeRevision: true, mergeParentRevisionIds: parents }
              : { kind: 'merged', payload, operation: decision.operation as 'upsert' | 'restore',
                resultingHeadRevisionIds: parents, requiresMergeRevision: true, mergeParentRevisionIds: parents };
          }
        }
      }
      const retiredStay = await isRetiredStayBusinessMutation(
        transaction,
        input.mutation,
      );
      if (retiredStay && input.mutation.entity.type === 'continuity-event') {
        await transaction.runAsync('DELETE FROM continuity_event_links WHERE event_id = ?', input.mutation.entity.id);
        await transaction.runAsync('DELETE FROM continuity_event_transitions WHERE event_id = ?', input.mutation.entity.id);
        await transaction.runAsync('DELETE FROM continuity_events WHERE id = ?', input.mutation.entity.id);
      }
      conflict = !retiredStay && isConflictDecision(decision);
      if (
        !retiredStay
        &&
        decision.kind !== 'already-current'
        && decision.kind !== 'ignore-incoming'
      ) {
        if (['comment', 'post-comment'].includes(input.mutation.entity.type) && decision.operation !== 'delete') {
          const logical = payloadRecord(decision.payload);
          const record: Record<string, unknown> | null = input.mutation.entity.type === 'post-comment'
            ? logical.deleted === 0 ? JSON.parse(String(logical.comment_json)) : null : logical;
          const hasBody = typeof record?.content === 'string' && !!record.content.trim()
            || input.mutation.entity.type === 'post-comment' && logical.image_group_json != null;
          if (record?.author === 'you' && hasBody) {
            const existing = await transaction.getFirstAsync<{ id: string }>(
              `SELECT id FROM memory_comments WHERE id = ?
               OR (memory_id = ? AND source IS NOT NULL AND source = ?) LIMIT 1`,
              input.mutation.entity.type === 'post-comment' ? record.id as string : input.mutation.entity.id,
              record.memory_id as string, record.source as string | null,
            );
            if (!existing) {
              const memory = await transaction.getFirstAsync<{ source: string; period: string; tags_json: string }>(
                'SELECT source, period, tags_json FROM memories WHERE id = ?', record.memory_id as string,
              );
              let tags: string[] = [];
              try {
                const parsed: unknown = JSON.parse(memory?.tags_json ?? '[]');
                if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string');
              } catch { /* Legacy malformed tags do not invalidate an otherwise saved comment. */ }
              if (memory && isBaiyunPostMemory({ ...memory, tags })) youMessageAt = record.created_at as number;
            }
          }
        }
        await applyBusinessView({
          transaction,
          entityType: input.mutation.entity.type as MemoryRecordEntityType,
          entityId: input.mutation.entity.id,
          operation: decision.operation,
          payload: decision.payload,
          preservePostImages: input.mutation.entity.type === 'post' && input.mutation.revision.schemaVersion === 5
            && decision.operation !== 'delete' && payloadRecord(decision.payload).image_group_json === null
            && payloadRecord(decision.payload).image_assets_json === '[]',
        });
        if (input.mutation.entity.type === 'post') changedPostId = input.mutation.entity.id;
        else if (input.mutation.entity.type === 'post-comment') {
          const [postId] = JSON.parse(input.mutation.entity.id) as [string, string];
          changedPostId = postId;
        }
      }
      const untouchedHeads = input.reconcileCurrentMemory ? [] : input.currentHeadRevisionIds.filter(
        (revisionId) => (
          revisionId !== input.selectedCurrentRevisionId
          && !input.mutation.revision.parents.includes(revisionId)
        ),
      );
      let nextHeads = retiredStay
        ? [...input.currentHeadRevisionIds]
        : [
            ...untouchedHeads,
            ...decision.resultingHeadRevisionIds,
          ];
      if (conflict && ['memory', 'post'].includes(input.mutation.entity.type) && decision.operation !== 'delete') {
        const kind = input.mutation.entity.type as 'memory' | 'post';
        const repaired: string[] = [];
        for (const id of [...new Set(nextHeads)]) {
          const branch = await loadRevisionFromDatabase(transaction, id);
          if (!branch || branch.operation === 'delete') { repaired.push(id); continue; }
          const payload = mergeMemoryStatsPayload(branch.payload, kind, decision.payload);
          if (sameMemoryRecordPayload(payload, branch.payload)) { repaired.push(id); continue; }
          repaired.push(await insertMergeRevision({ transaction, mutation: input.mutation,
            parentRevisionIds: [id], operation: branch.operation, payload,
            createdAt: Math.max(Date.now(), input.mutation.createdAt) }));
        }
        nextHeads = repaired;
      } else if (
        !retiredStay
        && 'requiresMergeRevision' in decision
        && decision.requiresMergeRevision
      ) {
        const mergeParents = [...new Set([
          ...untouchedHeads,
          ...(decision.mergeParentRevisionIds ?? []),
        ])].sort();
        const mergeRevisionId = await insertMergeRevision({
          transaction,
          mutation: input.mutation,
          parentRevisionIds: mergeParents,
          operation: decision.operation,
          payload: decision.payload,
          createdAt: Math.max(Date.now(), input.mutation.createdAt),
        });
        nextHeads = [mergeRevisionId];
      }
      if (!retiredStay && isConflictDecision(decision)) {
        const localRevision = input.selectedCurrentRevisionId
          ? await loadRevisionFromDatabase(transaction, input.selectedCurrentRevisionId)
          : null;
        await transaction.runAsync(
          `INSERT OR IGNORE INTO memory_sync_conflicts (
             conflict_id, entity_type, entity_id,
             local_revision_id, incoming_revision_id, kind,
             local_payload_json, incoming_payload_json,
             state, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          stableConflictId(
            input.selectedCurrentRevisionId,
            input.mutation.revision.id,
          ),
          input.mutation.entity.type,
          input.mutation.entity.id,
          input.selectedCurrentRevisionId,
          input.mutation.revision.id,
          decision.conflictKind,
          localRevision ? JSON.stringify(localRevision.payload) : null,
          JSON.stringify(input.mutation.payload),
          Date.now(),
        );
      }
      nextHeads = [...new Set(nextHeads)].sort();
      await transaction.runAsync(
        `DELETE FROM memory_sync_entity_heads
         WHERE entity_type = ? AND entity_id = ?`,
        input.mutation.entity.type,
        input.mutation.entity.id,
      );
      for (const revisionId of nextHeads) {
        await transaction.runAsync(
          `INSERT INTO memory_sync_entity_heads (
             entity_type, entity_id, revision_id, updated_at
           ) VALUES (?, ?, ?, ?)`,
          input.mutation.entity.type,
          input.mutation.entity.id,
          revisionId,
          Date.now(),
        );
      }
      if (!applied) await transaction.runAsync(
        `INSERT INTO memory_sync_applied_mutations (
           mutation_id, revision_id, applied_at
         ) VALUES (?, ?, ?)`,
        input.mutation.mutationId,
        input.mutation.revision.id,
        Date.now(),
      );
      if (input.reconcileCurrentMemory && (await memoryRecordsSqliteApplyPort.loadSelectedCurrentMemory!(input.mutation.entity.id))?.revision.id !== input.mutation.revision.id) {
        throw new Error('memory 当前中央稿已变化，本次对齐已撤回。');
      }
      resultingHeadRevisionIds = nextHeads;
    });
    if (changedPostId !== null) {
      const postId = changedPostId;
      void import('../posts/baiyunPostRecallSource').then(module => module.notifyPostRecallSourceChanged(postId))
        .catch(() => notifyMemoryProcessingWorkAvailable('memory_changed'));
    }
    if (youMessageAt !== null) {
      await (await import('../life/junluoDesireRuntime')).noteJunluoYouMessage(youMessageAt);
    }
    if (['post', 'post-comment'].includes(input.mutation.entity.type) && input.mutation.objectRefs.length) {
      // Business commit owns the current group. Bind an earlier verified file
      // afterwards; a file failure must remain retryable without rolling back text.
      const owner = input.mutation.entity.type === 'post'
        ? { postId: input.mutation.entity.id, commentSource: null }
        : (() => { const [postId, commentSource] = JSON.parse(input.mutation.entity.id); return { postId, commentSource }; })();
      try {
        await (await import('./syncBaiyunPostImagesMaterialization')).materializeCurrentBaiyunPostImages(owner);
      } catch (error) {
        console.warn('memory.records post image binding deferred', error);
      }
    }
    if (['memory', 'comment', 'post', 'post-comment', 'source-reference', 'current-state'].includes(input.mutation.entity.type)) {
      notifyMemoryProcessingWorkAvailable('memory_changed');
    }
    return {
      conflict,
      resultingHeadRevisionIds,
    };
  },
};

export function resetMemoryRecordsApplySchemaForTests() {
  // Static schema readiness is owned by memoryStore and has no local cache.
}

