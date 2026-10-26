import type * as SQLite from 'expo-sqlite';
import type {
  ScheduleSemanticBusinessPort,
  ScheduleSemanticRevisionContext,
} from './syncScheduleSemanticApply';
import {
  runWithScheduleSemanticCaptureSuppressed,
} from './syncScheduleSemanticSqlitePort';
import { writeSqliteRecord, deleteSqliteRecord } from './syncScheduleSemanticSqliteRecordApply';

type IncomingScheduleRevision = {
  entityType: string;
  entityId: string;
  revision: ScheduleSemanticRevisionContext;
};

async function shouldApplyReceivedRevision(
  transaction: SQLite.SQLiteDatabase,
  input: IncomingScheduleRevision,
) {
  const heads = await transaction.getAllAsync<{ revision_id: string }>(
    'SELECT revision_id FROM schedule_sync_entity_heads WHERE entity_type = ? AND entity_id = ?',
    input.entityType, input.entityId,
  );
  if (heads.length === 0) return true;
  if (heads.every(head => head.revision_id === input.revision.revisionId)) return false;
  if (heads.every(head => input.revision.parentRevisionIds.includes(head.revision_id))) return true;
  const parentsByRevision = new Map<string, string[]>([
    [input.revision.revisionId, input.revision.parentRevisionIds],
  ]);
  async function parentsOf(revisionId: string) {
    const cached = parentsByRevision.get(revisionId);
    if (cached) return cached;
    const local = await transaction.getFirstAsync<{ parent_revision_ids_json: string }>(
      `SELECT parent_revision_ids_json FROM schedule_sync_domain_outbox
       WHERE revision_id = ? AND entity_type = ? AND entity_id = ?`,
      revisionId, input.entityType, input.entityId,
    );
    let parents: string[];
    if (local) {
      const value: unknown = JSON.parse(local.parent_revision_ids_json);
      if (!Array.isArray(value) || value.some(parent => typeof parent !== 'string')) {
        throw new Error('schedule.semantic 本地父版本登记无效，已保留收件。');
      }
      parents = value;
    } else {
      const { loadSyncRevisionMutation } = await import('./syncMutationStateStore');
      const mutation = await loadSyncRevisionMutation(revisionId);
      if (!mutation || mutation.entity.domain !== 'schedule'
        || mutation.entity.type !== input.entityType || mutation.entity.id !== input.entityId) {
        throw new Error('schedule.semantic 父版本证据尚未齐全，已保留收件。');
      }
      parents = mutation.revision.parents;
    }
    parentsByRevision.set(revisionId, parents);
    return parents;
  }
  async function isAncestor(ancestor: string, descendant: string) {
    const pending = [descendant];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const revisionId = pending.pop()!;
      if (revisionId === ancestor) return true;
      if (visited.has(revisionId)) continue;
      visited.add(revisionId);
      pending.push(...await parentsOf(revisionId));
    }
    return false;
  }
  let alreadyAhead = true;
  for (const head of heads) {
    if (!await isAncestor(input.revision.revisionId, head.revision_id)) alreadyAhead = false;
  }
  if (alreadyAhead) return false;
  for (const head of heads) {
    if (!await isAncestor(head.revision_id, input.revision.revisionId)) {
      throw new Error('schedule.semantic 本机修改与来信并发，已保留业务、待发记录和收件。');
    }
  }
  return true;
}

async function registerReceivedRevision(
  transaction: SQLite.SQLiteDatabase,
  input: IncomingScheduleRevision,
) {
  await transaction.runAsync(
    'DELETE FROM schedule_sync_entity_heads WHERE entity_type = ? AND entity_id = ?',
    input.entityType, input.entityId,
  );
  await transaction.runAsync(
    `INSERT INTO schedule_sync_entity_heads (entity_type, entity_id, revision_id, updated_at)
     VALUES (?, ?, ?, ?)`,
    input.entityType, input.entityId, input.revision.revisionId, input.revision.createdAt,
  );
}

export const scheduleSemanticSqliteBusinessPort:
ScheduleSemanticBusinessPort = {
  upsertRecord: (input) => (
    runWithScheduleSemanticCaptureSuppressed(async (transaction) => {
      if (!await shouldApplyReceivedRevision(transaction, input)) return;
      await writeSqliteRecord({
        transaction,
        kind: input.kind,
        record: input.record,
        createdAt: input.revision.createdAt,
      });
      await registerReceivedRevision(transaction, input);
    })
  ),
  deleteRecord: (input) => (
    runWithScheduleSemanticCaptureSuppressed(async (transaction) => {
      if (!await shouldApplyReceivedRevision(transaction, input)) return;
      await deleteSqliteRecord({
        transaction,
        kind: input.kind,
        entityId: input.entityId,
      });
      await registerReceivedRevision(transaction, input);
    })
  ),
};
