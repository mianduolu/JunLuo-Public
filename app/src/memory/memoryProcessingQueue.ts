import type { SQLiteDatabase } from 'expo-sqlite';
import type { PostSourceIndexSource } from '../posts/baiyunPostRecallSource';
import { isBaiyunPostMemory } from '../posts/baiyunPostContract';
import { currentStateProcessingHash, currentStateIndexEligible, loadCurrentStateIndexSource, shiyingRecordProcessingHash, postSourceProcessingHash, MEMORY_PROCESSING_SCHEMA_SQL, memoryProcessingMigrationSql, type MemoryIndexTargetKind, type MemoryProcessingTargetKind } from './memoryIndexTargets';
export { currentStateProcessingHash, MEMORY_PROCESSING_SCHEMA_SQL, memoryProcessingMigrationSql } from './memoryIndexTargets';

export const MEMORY_PROCESSING_JOB_TYPES = [
  'embedding',
  'duplicate_analysis',
  'continuation_analysis',
  'source_integrity',
  'weekly_refresh',
] as const;

export type MemoryProcessingJobType = (typeof MEMORY_PROCESSING_JOB_TYPES)[number];
export type MemoryProcessingJobState = 'pending' | 'leased' | 'blocked' | 'failed' | 'completed';
type ShiyingIndexSource = { id: string; sourceContentHash: string; materialHash: string; indexText: string };

export type MemoryProcessingJobLease = {
  targetKind?: MemoryProcessingTargetKind;
  memoryId: string;
  jobType: MemoryProcessingJobType;
  desiredHash: string;
  attemptCount: number;
  leaseId: string;
  leaseExpiresAt: number;
};

export type MemoryProcessingSummary = {
  blocked: number;
  completed: number;
  failed: number;
  leased: number;
  pending: number;
  total: number;
  lastCompletedAt?: number;
};

type MemoryProcessingJobRow = {
  target_kind: MemoryProcessingTargetKind;
  memory_id: string;
  job_type: MemoryProcessingJobType;
  desired_hash: string;
  state: MemoryProcessingJobState;
  attempt_count: number;
  available_at: number;
  lease_id: string | null;
  lease_expires_at: number | null;
  last_error_code: string | null;
  last_error_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
};

type MemoryProcessingSourceRow = {
  id: string;
  title: string;
  content: string;
  domain: string;
  tags_json: string;
  recall_cues_json: string;
  importance: number;
  pinned: number;
  anchor: number;
  type: string;
  tier: string;
  semantic_type: string;
  understanding_subject?: 'I' | 'you' | null;
  atomic_kind: string;
  event_at: number | null;
  event_start_at: number | null;
  event_end_at: number | null;
  event_time_precision: string;
  event_time_basis: string;
  confirmation_level: string;
  source_trace_mode: string;
  source_start_at: number | null;
  source_end_at: number | null;
  source: string | null;
  source_type: string;
  period: string | null;
  updated_at: number;
};

type MemoryProcessingSourceRefRow = {
  session_id: string;
  message_id: string;
  role: string;
  message_created_at: number;
  relation: string;
};

export type MemoryProcessingSourceSnapshot = {
  memory: MemoryProcessingSourceRow;
  refs: MemoryProcessingSourceRefRow[];
};

export type MemoryProcessingEmbeddingIndexSnapshot = {
  contentHash: string;
  model: string;
  embeddingJson: string;
};

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000] as const;
const MAX_ATTEMPTS = 6;

function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeErrorCode(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 80);
  return normalized || 'unknown_error';
}

function parseTags(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function isMemoryProcessingIndexEligible(source: MemoryProcessingSourceSnapshot) {
  return source.memory.type !== 'archived' && source.memory.type !== 'feel'
    && !isBaiyunPostMemory({
      source: source.memory.source ?? undefined,
      period: source.memory.period ?? undefined,
      tags: parseTags(source.memory.tags_json),
    });
}

export function isMemoryProcessingTimelineEligible(source: MemoryProcessingSourceSnapshot) {
  if (!isMemoryProcessingIndexEligible(source) || source.memory.understanding_subject) return false;
  const tags = parseTags(source.memory.tags_json);
  return source.memory.period !== 'whisper'
    && source.memory.source !== 'assistant-life-state'
    && !tags.some((tag) => tag.toLowerCase() === 'whisper' || tag === '碎碎念' || tag === '白云动态');
}

export function buildMemoryProcessingDesiredHash(
  source: MemoryProcessingSourceSnapshot,
  jobType: MemoryProcessingJobType,
) {
  const memory = source.memory;
  if (jobType === 'embedding') {
    return hashText(JSON.stringify({
      title: memory.title,
      content: memory.content,
      domain: memory.domain,
      tags: memory.tags_json,
      recallCues: memory.recall_cues_json,
      eligible: isMemoryProcessingIndexEligible(source),
    }));
  }
  if (jobType === 'source_integrity') {
    return hashText(JSON.stringify({
      traceMode: memory.source_trace_mode,
      startAt: memory.source_start_at,
      endAt: memory.source_end_at,
      refs: source.refs.map((ref) => [
        ref.session_id,
        ref.message_id,
        ref.role,
        ref.message_created_at,
        ref.relation,
      ]),
    }));
  }
  return hashText(JSON.stringify({
    title: memory.title,
    content: memory.content,
    domain: memory.domain,
    tags: memory.tags_json,
    importance: memory.importance,
    pinned: memory.pinned,
    anchor: memory.anchor,
    type: memory.type,
    tier: memory.tier,
    semanticType: memory.semantic_type,
    understandingSubject: memory.understanding_subject ?? null,
    atomicKind: memory.atomic_kind,
    eventAt: memory.event_at,
    eventStartAt: memory.event_start_at,
    eventEndAt: memory.event_end_at,
    eventTimePrecision: memory.event_time_precision,
    eventTimeBasis: memory.event_time_basis,
    confirmationLevel: memory.confirmation_level,
    sourceStartAt: memory.source_start_at,
    sourceEndAt: memory.source_end_at,
  }));
}

export function retryDelayAfterFailure(attemptCount: number) {
  if (attemptCount >= MAX_ATTEMPTS) return null;
  return RETRY_DELAYS_MS[Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, attemptCount - 1))];
}

export async function ensureMemoryProcessingSchema(database: SQLiteDatabase) {
  const existing = await database.getFirstAsync<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_processing_jobs'");
  if (existing && (!existing.sql.includes("'post_source'") || !existing.sql.includes("'weekly_period'") || !/job_type\s+IN\s*\([^)]*'weekly_refresh'/.test(existing.sql) || !existing.sql.includes('target_kind'))) {
    await database.withExclusiveTransactionAsync(async transaction => {
      await transaction.execAsync(memoryProcessingMigrationSql(existing.sql.includes('target_kind')));
    });
    return;
  }
  await database.execAsync(MEMORY_PROCESSING_SCHEMA_SQL);
}

export async function ensureWeeklyRefreshJobWithDatabase(database: SQLiteDatabase, memoryId: string, desiredHash: string, forcePending = false, targetKind: 'memory' | 'weekly_period' = 'memory') {
  return upsertJobForCurrentHash(database, { memoryId, desiredHash, forcePending, targetKind, allowCreate: true, jobType: 'weekly_refresh', now: Date.now() });
}

// Review ownership is global across old session batches, first drafts and updates.
export const PENDING_WEEKLY_CANDIDATE_SQL = `SELECT 1 FROM memory_ingestion_items i
  JOIN memory_ingestion_batches b ON b.id = i.batch_id
  WHERE b.stream = 'weekly' AND i.status = 'pending' AND i.candidate_json IS NOT NULL
    AND b.status IN ('pending', 'ready', 'failed', 'waiting')`;

export const WEEKLY_RECHECK_INTENT_SQL = `SELECT 1 FROM memory_ingestion_batches task_intent
  WHERE task_intent.id = 'weekly-task:' || jobs.target_kind || ':' || jobs.memory_id
    AND json_type(task_intent.work_metadata_json, '$.replacingCandidate') = 'object'`;

export async function hasPendingWeeklyCandidate(database: Pick<SQLiteDatabase, 'getFirstAsync'>) {
  return !!await database.getFirstAsync(`${PENDING_WEEKLY_CANDIDATE_SQL} LIMIT 1`);
}

export async function loadMemoryProcessingSourceWithDatabase(
  database: SQLiteDatabase,
  memoryId: string,
): Promise<MemoryProcessingSourceSnapshot | null> {
  const memory = await database.getFirstAsync<MemoryProcessingSourceRow>(
    `SELECT id, title, content, domain, tags_json, recall_cues_json, importance, pinned, anchor,
            type, tier, semantic_type, atomic_kind, event_at, event_start_at, event_end_at,
            event_time_precision, event_time_basis, confirmation_level, source_trace_mode,
            source_start_at, source_end_at, source, source_type, period, updated_at, understanding_subject
       FROM memories
      WHERE id = ?`,
    memoryId,
  );
  if (!memory) return null;
  const refs = await database.getAllAsync<MemoryProcessingSourceRefRow>(
    `SELECT session_id, message_id, role, message_created_at, relation
       FROM memory_source_refs
      WHERE memory_id = ?
      ORDER BY message_created_at ASC, session_id ASC, message_id ASC, relation ASC`,
    memoryId,
  );
  return { memory, refs };
}

export async function loadMemoryProcessingSourcesWithDatabase(
  database: SQLiteDatabase,
  memoryIds: string[],
) {
  const uniqueIds = Array.from(new Set(memoryIds.filter(Boolean)));
  const sources = new Map<string, MemoryProcessingSourceSnapshot>();
  if (!uniqueIds.length) return sources;
  const placeholders = uniqueIds.map(() => '?').join(',');
  const memories = await database.getAllAsync<MemoryProcessingSourceRow>(
    `SELECT id, title, content, domain, tags_json, recall_cues_json, importance, pinned, anchor,
            type, tier, semantic_type, atomic_kind, event_at, event_start_at, event_end_at,
            event_time_precision, event_time_basis, confirmation_level, source_trace_mode,
            source_start_at, source_end_at, source, source_type, period, updated_at, understanding_subject
       FROM memories
      WHERE id IN (${placeholders})`,
    ...uniqueIds,
  );
  for (const memory of memories) sources.set(memory.id, { memory, refs: [] });
  const refs = await database.getAllAsync<MemoryProcessingSourceRefRow & { memory_id: string }>(
    `SELECT memory_id, session_id, message_id, role, message_created_at, relation
       FROM memory_source_refs
      WHERE memory_id IN (${placeholders})
      ORDER BY memory_id ASC, message_created_at ASC, session_id ASC, message_id ASC, relation ASC`,
    ...uniqueIds,
  );
  for (const ref of refs) sources.get(ref.memory_id)?.refs.push(ref);
  return sources;
}

export async function loadMemoryProcessingEmbeddingIndexesWithDatabase(
  database: SQLiteDatabase,
  memoryIds: string[],
  targetKind: MemoryIndexTargetKind = 'memory',
) {
  const uniqueIds = Array.from(new Set(memoryIds.filter(Boolean)));
  const indexes = new Map<string, MemoryProcessingEmbeddingIndexSnapshot>();
  if (!uniqueIds.length) return indexes;
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = await database.getAllAsync<{
    memory_id: string;
    model: string;
    content_hash: string;
    embedding_json: string;
  }>(
    `SELECT memory_id, model, content_hash, embedding_json
       FROM memory_embeddings
      WHERE target_kind = ? AND memory_id IN (${placeholders})`,
    targetKind,
    ...uniqueIds,
  );
  for (const row of rows) {
    indexes.set(row.memory_id, { contentHash: row.content_hash, model: row.model, embeddingJson: row.embedding_json });
  }
  return indexes;
}

async function upsertJobForCurrentHash(
  database: SQLiteDatabase,
  input: {
    allowCreate: boolean;
    desiredHash: string;
    forcePending?: boolean;
    jobType: MemoryProcessingJobType;
    memoryId: string;
    now: number;
    preserveCompleted?: boolean;
    targetKind?: MemoryProcessingTargetKind;
  },
) {
  const existing = await database.getFirstAsync<MemoryProcessingJobRow>(
    'SELECT * FROM memory_processing_jobs WHERE target_kind = ? AND memory_id = ? AND job_type = ?',
    input.targetKind ?? 'memory',
    input.memoryId,
    input.jobType,
  );
  if (!existing) {
    if (!input.allowCreate) return false;
    await database.runAsync(
      `INSERT INTO memory_processing_jobs (
        target_kind, memory_id, job_type, desired_hash, state, attempt_count, available_at,
        lease_id, lease_expires_at, last_error_code, last_error_at, completed_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      input.targetKind ?? 'memory',
      input.memoryId,
      input.jobType,
      input.desiredHash,
      input.now,
      input.now,
      input.now,
    );
    return true;
  }
  if (input.preserveCompleted && existing.state === 'completed') return false;
  // A material change must never revoke the lease of an active weekly request.
  if (input.jobType === 'weekly_refresh' && existing.state === 'leased') return false;
  if (existing.desired_hash === input.desiredHash) {
    if (!input.forcePending || (input.jobType !== 'weekly_refresh' && (existing.state === 'pending' || existing.state === 'leased'))) {
      return false;
    }
  }
  await database.runAsync(
    `UPDATE memory_processing_jobs
        SET desired_hash = ?,
            state = 'pending',
            attempt_count = 0,
            available_at = ?,
            lease_id = NULL,
            lease_expires_at = NULL,
            last_error_code = NULL,
            last_error_at = NULL,
            completed_at = NULL,
            updated_at = ?
      WHERE target_kind = ? AND memory_id = ? AND job_type = ?`,
    input.desiredHash,
    input.now,
    input.now,
    input.targetKind ?? 'memory',
    input.memoryId,
    input.jobType,
  );
  return true;
}

export async function ensureMemoryProcessingJobForSourceWithDatabase(
  database: SQLiteDatabase,
  source: MemoryProcessingSourceSnapshot,
  jobType: MemoryProcessingJobType,
  options: { allowCreate?: boolean; forcePending?: boolean; now?: number } = {},
) {
  return upsertJobForCurrentHash(database, {
    allowCreate: options.allowCreate ?? true,
    desiredHash: buildMemoryProcessingDesiredHash(source, jobType),
    forcePending: options.forcePending,
    jobType,
    memoryId: source.memory.id,
    now: options.now ?? Date.now(),
  });
}

export async function ensureCurrentMemoryProcessingJobWithDatabase(
  database: SQLiteDatabase,
  memoryId: string,
  jobType: MemoryProcessingJobType,
  options: { allowCreate?: boolean; forcePending?: boolean; now?: number } = {},
) {
  const source = await loadMemoryProcessingSourceWithDatabase(database, memoryId);
  if (!source) return false;
  return ensureMemoryProcessingJobForSourceWithDatabase(database, source, jobType, options);
}

async function markJobsObsoleteWithDatabase(
  database: SQLiteDatabase,
  memoryId: string,
  jobTypes: MemoryProcessingJobType[],
  now: number,
) {
  for (const jobType of jobTypes) {
    await database.runAsync(
      `UPDATE memory_processing_jobs
          SET state = 'completed',
              lease_id = NULL,
              lease_expires_at = NULL,
              last_error_code = 'obsolete',
              last_error_at = NULL,
              completed_at = ?,
              updated_at = ?
        WHERE target_kind = 'memory' AND memory_id = ? AND job_type = ? AND state != 'completed'`,
      now,
      now,
      memoryId,
      jobType,
    );
  }
}

export async function enqueueMemoryCreateJobsWithDatabase(
  database: SQLiteDatabase,
  memoryId: string,
  now = Date.now(),
) {
  const source = await loadMemoryProcessingSourceWithDatabase(database, memoryId);
  if (!source) return;
  await upsertJobForCurrentHash(database, {
    allowCreate: true,
    desiredHash: buildMemoryProcessingDesiredHash(source, 'source_integrity'),
    jobType: 'source_integrity',
    memoryId,
    now,
  });
  if (!isMemoryProcessingIndexEligible(source)) return;
  await upsertJobForCurrentHash(database, {
    allowCreate: true,
    desiredHash: buildMemoryProcessingDesiredHash(source, 'embedding'),
    jobType: 'embedding',
    memoryId,
    now,
  });
  if (!isMemoryProcessingTimelineEligible(source)) return;
  for (const jobType of ['duplicate_analysis', 'continuation_analysis'] as const) {
    await upsertJobForCurrentHash(database, {
      allowCreate: true,
      desiredHash: buildMemoryProcessingDesiredHash(source, jobType),
      jobType,
      memoryId,
      now,
    });
  }
}

export async function enqueueMemoryUpdateJobsWithDatabase(
  database: SQLiteDatabase,
  memoryId: string,
  now = Date.now(),
) {
  const source = await loadMemoryProcessingSourceWithDatabase(database, memoryId);
  if (!source) return;
  await upsertJobForCurrentHash(database, {
    allowCreate: true,
    desiredHash: buildMemoryProcessingDesiredHash(source, 'source_integrity'),
    jobType: 'source_integrity',
    memoryId,
    now,
  });
  if (!isMemoryProcessingIndexEligible(source)) {
    await markJobsObsoleteWithDatabase(
      database,
      memoryId,
      ['embedding', 'duplicate_analysis', 'continuation_analysis'],
      now,
    );
    return;
  }
  await upsertJobForCurrentHash(database, {
    allowCreate: true,
    desiredHash: buildMemoryProcessingDesiredHash(source, 'embedding'),
    jobType: 'embedding',
    memoryId,
    now,
  });
  if (!isMemoryProcessingTimelineEligible(source)) {
    await markJobsObsoleteWithDatabase(
      database,
      memoryId,
      ['duplicate_analysis', 'continuation_analysis'],
      now,
    );
    return;
  }
  await upsertJobForCurrentHash(database, {
    allowCreate: true,
    desiredHash: buildMemoryProcessingDesiredHash(source, 'continuation_analysis'),
    jobType: 'continuation_analysis',
    memoryId,
    now,
  });
  await upsertJobForCurrentHash(database, {
    allowCreate: false,
    desiredHash: buildMemoryProcessingDesiredHash(source, 'duplicate_analysis'),
    jobType: 'duplicate_analysis',
    memoryId,
    now,
    preserveCompleted: true,
  });
}

export async function enqueueMemoryMergeTargetJobsWithDatabase(
  database: SQLiteDatabase,
  memoryId: string,
  now = Date.now(),
) {
  const source = await loadMemoryProcessingSourceWithDatabase(database, memoryId);
  if (!source) return;
  await upsertJobForCurrentHash(database, {
    allowCreate: true,
    desiredHash: buildMemoryProcessingDesiredHash(source, 'source_integrity'),
    jobType: 'source_integrity',
    memoryId,
    now,
  });
  if (isMemoryProcessingIndexEligible(source)) {
    await upsertJobForCurrentHash(database, {
      allowCreate: true,
      desiredHash: buildMemoryProcessingDesiredHash(source, 'embedding'),
      jobType: 'embedding',
      memoryId,
      now,
    });
  } else {
    await markJobsObsoleteWithDatabase(database, memoryId, ['embedding'], now);
  }
  await markJobsObsoleteWithDatabase(
    database,
    memoryId,
    ['duplicate_analysis', 'continuation_analysis'],
    now,
  );
}

export async function deleteMemoryProcessingJobsWithDatabase(
  database: SQLiteDatabase,
  memoryId: string,
  targetKind: MemoryProcessingTargetKind = 'memory',
) {
  await database.runAsync('DELETE FROM memory_processing_jobs WHERE target_kind = ? AND memory_id = ?', targetKind, memoryId);
}

export async function queueCurrentStateEmbeddingWithDatabase(database: SQLiteDatabase, id: string, now = Date.now(), forcePending = false) {
  const source = await loadCurrentStateIndexSource(database, id);
  if (!currentStateIndexEligible(source)) {
    await deleteMemoryProcessingJobsWithDatabase(database, id, 'current_state');
    await database.runAsync("DELETE FROM memory_embeddings WHERE target_kind = 'current_state' AND memory_id = ?", id);
    return false;
  }
  return upsertJobForCurrentHash(database, { allowCreate: true, targetKind: 'current_state', memoryId: id,
    jobType: 'embedding', desiredHash: currentStateProcessingHash(source), now, forcePending });
}

/** Source reads happen before entering the memory transaction; Shiying keeps its own queue. */
export async function queueShiyingRecordEmbeddingWithDatabase(database: SQLiteDatabase, id: string,
  source: ShiyingIndexSource | null, now = Date.now(), forcePending = false) {
  if (!source || !source.indexText.trim()) {
    await deleteMemoryProcessingJobsWithDatabase(database, id, 'shiying_record');
    await database.runAsync("DELETE FROM memory_embeddings WHERE target_kind = 'shiying_record' AND memory_id = ?", id);
    return false;
  }
  if (source.id !== id) throw new Error('shiying_memory_index_source_mismatch');
  return upsertJobForCurrentHash(database, { allowCreate: true, targetKind: 'shiying_record', memoryId: id,
    jobType: 'embedding', desiredHash: shiyingRecordProcessingHash(source), now, forcePending });
}

/** The caller captures actual-reading facts before entering the SQLite write. */
export async function queuePostSourceEmbeddingWithDatabase(database: SQLiteDatabase, id: string,
  source: PostSourceIndexSource | null, now = Date.now(), forcePending = false) {
  if (!source || !source.indexText.trim()) {
    await deleteMemoryProcessingJobsWithDatabase(database, id, 'post_source');
    await database.runAsync("DELETE FROM memory_embeddings WHERE target_kind = 'post_source' AND memory_id = ?", id);
    return false;
  }
  if (source.id !== id) throw new Error('post_source_index_source_mismatch');
  return upsertJobForCurrentHash(database, { allowCreate: true, targetKind: 'post_source', memoryId: id,
    jobType: 'embedding', desiredHash: postSourceProcessingHash(source), now, forcePending });
}

export async function releaseExpiredMemoryProcessingLeases(
  database: SQLiteDatabase,
  now = Date.now(),
) {
  const result = await database.runAsync(
    `UPDATE memory_processing_jobs
        SET state = 'pending',
            lease_id = NULL,
            lease_expires_at = NULL,
            available_at = ?,
            updated_at = ?
      WHERE state = 'leased'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?`,
    now,
    now,
    now,
  );
  return result.changes;
}

export async function claimNextMemoryProcessingJob(
  database: SQLiteDatabase,
  input: { leaseDurationMs?: number; now?: number; weeklyMemoryId?: string; weeklyTargetKind?: 'memory' | 'weekly_period'; replacingWeeklyCandidate?: boolean; skipWeekly?: boolean } = {},
): Promise<MemoryProcessingJobLease | null> {
  const now = input.now ?? Date.now();
  const leaseDurationMs = input.leaseDurationMs ?? 120_000;
  let claimed: MemoryProcessingJobLease | null = null;
  await database.withExclusiveTransactionAsync(async (database) => {
    await releaseExpiredMemoryProcessingLeases(database, now);
    const row = await database.getFirstAsync<MemoryProcessingJobRow>(
      `SELECT jobs.*
         FROM memory_processing_jobs jobs
        WHERE jobs.state = 'pending'
          AND jobs.available_at <= ?
          AND (? IS NULL OR (jobs.target_kind = ? AND jobs.memory_id = ? AND jobs.job_type = 'weekly_refresh'))
          AND (jobs.job_type != 'weekly_refresh' OR (
            ? = 0 AND NOT EXISTS (SELECT 1 FROM memory_processing_jobs busy WHERE busy.job_type = 'weekly_refresh' AND busy.state = 'leased')
            AND (? = 1 OR EXISTS (${WEEKLY_RECHECK_INTENT_SQL}) OR NOT EXISTS (${PENDING_WEEKLY_CANDIDATE_SQL}))
          ))
          AND (
            jobs.job_type != 'continuation_analysis'
            OR NOT EXISTS (
              SELECT 1
                FROM memory_processing_jobs duplicate_job
               WHERE duplicate_job.memory_id = jobs.memory_id
                 AND duplicate_job.target_kind = jobs.target_kind
                 AND duplicate_job.job_type = 'duplicate_analysis'
                 AND duplicate_job.desired_hash = jobs.desired_hash
                 AND duplicate_job.state != 'completed'
            )
          )
        ORDER BY CASE jobs.job_type
          WHEN 'source_integrity' THEN 0
          WHEN 'embedding' THEN 1
          WHEN 'duplicate_analysis' THEN 2
          ELSE 3
        END, jobs.available_at ASC, jobs.updated_at ASC
        LIMIT 1`,
      now,
      input.weeklyMemoryId ?? null,
      input.weeklyTargetKind ?? 'memory',
      input.weeklyMemoryId ?? null,
      input.skipWeekly ? 1 : 0,
      input.replacingWeeklyCandidate ? 1 : 0,
    );
    if (!row) return;
    const leaseId = `memory-job-${now}-${Math.random().toString(36).slice(2, 10)}`;
    const leaseExpiresAt = now + leaseDurationMs;
    const updated = await database.runAsync(
      `UPDATE memory_processing_jobs
          SET state = 'leased', lease_id = ?, lease_expires_at = ?, updated_at = ?
        WHERE target_kind = ? AND memory_id = ? AND job_type = ? AND desired_hash = ? AND state = 'pending'`,
      leaseId,
      leaseExpiresAt,
      now,
      row.target_kind,
      row.memory_id,
      row.job_type,
      row.desired_hash,
    );
    if (updated.changes !== 1) return;
    claimed = {
      targetKind: row.target_kind,
      memoryId: row.memory_id,
      jobType: row.job_type,
      desiredHash: row.desired_hash,
      attemptCount: row.attempt_count,
      leaseId,
      leaseExpiresAt,
    };
  });
  return claimed;
}

function leaseWhere() {
  return `target_kind = ? AND memory_id = ? AND job_type = ? AND desired_hash = ?
    AND state = 'leased' AND lease_id = ?`;
}

export async function completeMemoryProcessingJobWithDatabase(
  database: SQLiteDatabase,
  lease: MemoryProcessingJobLease,
  now = Date.now(),
  completedHash = lease.desiredHash,
) {
  const result = await database.runAsync(
    `UPDATE memory_processing_jobs
        SET desired_hash = ?,
            state = 'completed',
            lease_id = NULL,
            lease_expires_at = NULL,
            last_error_code = NULL,
            last_error_at = NULL,
            completed_at = ?,
            updated_at = ?
      WHERE ${leaseWhere()}`,
    completedHash,
    now,
    now,
    lease.targetKind ?? 'memory',
    lease.memoryId,
    lease.jobType,
    lease.desiredHash,
    lease.leaseId,
  );
  return result.changes === 1;
}

export async function blockMemoryProcessingJob(
  database: SQLiteDatabase,
  lease: MemoryProcessingJobLease,
  errorCode: string,
  now = Date.now(),
) {
  const result = await database.runAsync(
    `UPDATE memory_processing_jobs
        SET state = 'blocked',
            lease_id = NULL,
            lease_expires_at = NULL,
            last_error_code = ?,
            last_error_at = ?,
            completed_at = NULL,
            updated_at = ?
      WHERE ${leaseWhere()}`,
    normalizeErrorCode(errorCode),
    now,
    now,
    lease.targetKind ?? 'memory',
    lease.memoryId,
    lease.jobType,
    lease.desiredHash,
    lease.leaseId,
  );
  return result.changes === 1;
}

export async function deferMemoryProcessingJob(
  database: SQLiteDatabase,
  lease: MemoryProcessingJobLease,
  errorCode: string,
  availableAt: number,
  now = Date.now(),
) {
  const result = await database.runAsync(
    `UPDATE memory_processing_jobs
        SET state = 'pending',
            available_at = ?,
            lease_id = NULL,
            lease_expires_at = NULL,
            last_error_code = ?,
            last_error_at = ?,
            completed_at = NULL,
            updated_at = ?
      WHERE ${leaseWhere()}`,
    availableAt,
    normalizeErrorCode(errorCode),
    now,
    now,
    lease.targetKind ?? 'memory',
    lease.memoryId,
    lease.jobType,
    lease.desiredHash,
    lease.leaseId,
  );
  return result.changes === 1;
}

export async function failMemoryProcessingJob(
  database: SQLiteDatabase,
  lease: MemoryProcessingJobLease,
  errorCode: string,
  now = Date.now(),
) {
  const nextAttempt = lease.attemptCount + 1;
  const delay = retryDelayAfterFailure(nextAttempt);
  const nextState: MemoryProcessingJobState = delay === null ? 'failed' : 'pending';
  const result = await database.runAsync(
    `UPDATE memory_processing_jobs
        SET state = ?,
            attempt_count = ?,
            available_at = ?,
            lease_id = NULL,
            lease_expires_at = NULL,
            last_error_code = ?,
            last_error_at = ?,
            completed_at = NULL,
            updated_at = ?
      WHERE ${leaseWhere()}`,
    nextState,
    nextAttempt,
    delay === null ? now : now + delay,
    normalizeErrorCode(errorCode),
    now,
    now,
    lease.targetKind ?? 'memory',
    lease.memoryId,
    lease.jobType,
    lease.desiredHash,
    lease.leaseId,
  );
  return { applied: result.changes === 1, attemptCount: nextAttempt, state: nextState };
}

export async function requeueStaleMemoryProcessingJob(
  database: SQLiteDatabase,
  lease: MemoryProcessingJobLease,
  now = Date.now(),
  shiyingSource?: ShiyingIndexSource | null,
  postSource?: PostSourceIndexSource | null,
) {
  if (lease.targetKind === 'post_source') {
    if (!await isMemoryProcessingLeaseCurrentWithDatabase(database, lease) || postSource === undefined) return false;
    if (!postSource || !postSource.indexText.trim()) return queuePostSourceEmbeddingWithDatabase(database, lease.memoryId, postSource, now);
    const result = await database.runAsync(`UPDATE memory_processing_jobs SET desired_hash = ?, state = 'pending',
      attempt_count = 0, available_at = ?, lease_id = NULL, lease_expires_at = NULL,
      last_error_code = 'stale_source', last_error_at = ?, completed_at = NULL, updated_at = ? WHERE ${leaseWhere()}`,
    postSourceProcessingHash(postSource), now, now, now, 'post_source', lease.memoryId, lease.jobType, lease.desiredHash, lease.leaseId);
    return result.changes === 1;
  }
  if (lease.targetKind === 'shiying_record') {
    if (!await isMemoryProcessingLeaseCurrentWithDatabase(database, lease)) return false;
    // The caller rereads the independent original store before this SQL commit.
    if (shiyingSource === undefined) return false;
    const current = shiyingSource;
    if (!current || !current.indexText.trim()) return queueShiyingRecordEmbeddingWithDatabase(database, lease.memoryId, current, now);
    const result = await database.runAsync(`UPDATE memory_processing_jobs SET desired_hash = ?, state = 'pending',
      attempt_count = 0, available_at = ?, lease_id = NULL, lease_expires_at = NULL,
      last_error_code = 'stale_source', last_error_at = ?, completed_at = NULL, updated_at = ? WHERE ${leaseWhere()}`,
    shiyingRecordProcessingHash(current), now, now, now, 'shiying_record', lease.memoryId, lease.jobType, lease.desiredHash, lease.leaseId);
    return result.changes === 1;
  }
  if (lease.targetKind === 'current_state') {
    if (!await isMemoryProcessingLeaseCurrentWithDatabase(database, lease)) return false;
    const current = await loadCurrentStateIndexSource(database, lease.memoryId);
    if (!currentStateIndexEligible(current)) return queueCurrentStateEmbeddingWithDatabase(database, lease.memoryId, now);
    const result = await database.runAsync(`UPDATE memory_processing_jobs SET desired_hash = ?, state = 'pending',
      attempt_count = 0, available_at = ?, lease_id = NULL, lease_expires_at = NULL,
      last_error_code = 'stale_source', last_error_at = ?, completed_at = NULL, updated_at = ? WHERE ${leaseWhere()}`,
    currentStateProcessingHash(current), now, now, now, 'current_state', lease.memoryId, lease.jobType, lease.desiredHash, lease.leaseId);
    return result.changes === 1;
  }
  const source = await loadMemoryProcessingSourceWithDatabase(database, lease.memoryId);
  if (!source) {
    await deleteMemoryProcessingJobsWithDatabase(database, lease.memoryId);
    return false;
  }
  const desiredHash = buildMemoryProcessingDesiredHash(source, lease.jobType);
  const result = await database.runAsync(
    `UPDATE memory_processing_jobs
        SET desired_hash = ?,
            state = 'pending',
            attempt_count = 0,
            available_at = ?,
            lease_id = NULL,
            lease_expires_at = NULL,
            last_error_code = 'stale_source',
            last_error_at = ?,
            completed_at = NULL,
            updated_at = ?
      WHERE ${leaseWhere()}`,
    desiredHash,
    now,
    now,
    now,
    lease.targetKind ?? 'memory',
    lease.memoryId,
    lease.jobType,
    lease.desiredHash,
    lease.leaseId,
  );
  return result.changes === 1;
}

export async function isMemoryProcessingLeaseCurrentWithDatabase(database: SQLiteDatabase, lease: MemoryProcessingJobLease) {
  return !!await database.getFirstAsync(`SELECT 1 FROM memory_processing_jobs WHERE ${leaseWhere()}`,
    lease.targetKind ?? 'memory', lease.memoryId, lease.jobType, lease.desiredHash, lease.leaseId);
}

export async function resetMemoryProcessingFailures(
  database: SQLiteDatabase,
  now = Date.now(),
) {
  const result = await database.runAsync(
    `UPDATE memory_processing_jobs
        SET state = 'pending',
            attempt_count = 0,
            available_at = ?,
            lease_id = NULL,
            lease_expires_at = NULL,
            last_error_code = NULL,
            last_error_at = NULL,
            completed_at = NULL,
            updated_at = ?
      WHERE state IN ('failed', 'blocked')`,
    now,
    now,
  );
  return result.changes;
}

export async function countDueMemoryProcessingJobs(
  database: SQLiteDatabase,
  now = Date.now(),
) {
  const row = await database.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) AS count
       FROM memory_processing_jobs jobs
      WHERE state = 'pending' AND available_at <= ?
        AND (job_type != 'weekly_refresh' OR ((EXISTS (${WEEKLY_RECHECK_INTENT_SQL}) OR NOT EXISTS (${PENDING_WEEKLY_CANDIDATE_SQL}))
          AND NOT EXISTS (SELECT 1 FROM memory_processing_jobs busy WHERE busy.job_type = 'weekly_refresh' AND busy.state = 'leased')))`,
    now,
  );
  return row?.count ?? 0;
}

export async function loadMemoryProcessingSummary(
  database: SQLiteDatabase,
): Promise<MemoryProcessingSummary> {
  const rows = await database.getAllAsync<{ state: MemoryProcessingJobState; count: number }>(
    'SELECT state, COUNT(*) AS count FROM memory_processing_jobs GROUP BY state',
  );
  const summary: MemoryProcessingSummary = {
    blocked: 0,
    completed: 0,
    failed: 0,
    leased: 0,
    pending: 0,
    total: 0,
  };
  for (const row of rows) {
    summary[row.state] = row.count;
    summary.total += row.count;
  }
  const completed = await database.getFirstAsync<{ completed_at: number | null }>(
    'SELECT MAX(completed_at) AS completed_at FROM memory_processing_jobs',
  );
  if (completed?.completed_at) summary.lastCompletedAt = completed.completed_at;
  return summary;
}

export async function listMemoryProcessingKeysetPage(
  database: SQLiteDatabase,
  input: {
    after?: { id: string; updatedAt: number } | null;
    limit?: number;
  } = {},
) {
  const limit = Math.max(1, Math.trunc(input.limit ?? 10));
  const rows = input.after
    ? await database.getAllAsync<{ id: string; updated_at: number }>(
      `SELECT id, updated_at
         FROM memories
        WHERE updated_at > ? OR (updated_at = ? AND id > ?)
        ORDER BY updated_at ASC, id ASC
        LIMIT ?`,
      input.after.updatedAt,
      input.after.updatedAt,
      input.after.id,
      limit,
    )
    : await database.getAllAsync<{ id: string; updated_at: number }>(
      `SELECT id, updated_at
         FROM memories
        ORDER BY updated_at ASC, id ASC
        LIMIT ?`,
      limit,
    );
  return rows.map((row) => ({ id: row.id, updatedAt: row.updated_at }));
}

export async function listMemoryIndexTargetKeysetPage(database: SQLiteDatabase, input: {
  after?: { id: string; updatedAt: number; targetKind?: MemoryIndexTargetKind } | null; limit?: number;
} = {}) {
  const after = input.after;
  const rows = await database.getAllAsync<{ id: string; updated_at: number; target_kind: MemoryIndexTargetKind }>(
    `SELECT * FROM (SELECT id, updated_at, 'memory' AS target_kind FROM memories
      UNION ALL SELECT id, updated_at, 'current_state' AS target_kind FROM memory_current_states)
      ${after ? 'WHERE updated_at > ? OR (updated_at = ? AND (id > ? OR (id = ? AND target_kind > ?)))' : ''}
      ORDER BY updated_at ASC, id ASC, target_kind ASC LIMIT ?`,
    ...(after ? [after.updatedAt, after.updatedAt, after.id, after.id, after.targetKind ?? 'memory'] : []),
    Math.max(1, Math.trunc(input.limit ?? 10)));
  return rows.map(row => ({ id: row.id, updatedAt: row.updated_at, targetKind: row.target_kind }));
}

export async function reconcileSourceIntegrityJobWithDatabase(
  database: SQLiteDatabase,
  memoryId: string,
  now = Date.now(),
) {
  const source = await loadMemoryProcessingSourceWithDatabase(database, memoryId);
  if (!source) return false;
  const times = source.refs.map((ref) => ref.message_created_at).filter(Number.isFinite);
  const expectedStart = times.length ? Math.min(...times) : source.memory.source_start_at;
  const expectedEnd = times.length ? Math.max(...times) : source.memory.source_end_at;
  const expectedMode = times.length ? 'exact' : source.memory.source_trace_mode;
  const mismatched = source.memory.source_start_at !== expectedStart
    || source.memory.source_end_at !== expectedEnd
    || source.memory.source_trace_mode !== expectedMode;
  if (mismatched) {
    await database.runAsync(
      `UPDATE memories
          SET source_start_at = ?, source_end_at = ?, source_trace_mode = ?, updated_at = ?
        WHERE id = ?`,
      expectedStart ?? null,
      expectedEnd ?? null,
      expectedMode,
      now,
      memoryId,
    );
  }
  return mismatched;
}

export async function deleteOrphanMemoryProcessingRows(database: SQLiteDatabase) {
  const refs = await database.runAsync(
    `DELETE FROM memory_source_refs
      WHERE NOT EXISTS (SELECT 1 FROM memories WHERE memories.id = memory_source_refs.memory_id)`,
  );
  const jobs = await database.runAsync(
    `DELETE FROM memory_processing_jobs
      WHERE (target_kind = 'memory' AND NOT EXISTS (SELECT 1 FROM memories WHERE memories.id = memory_processing_jobs.memory_id))
         OR (target_kind = 'current_state' AND NOT EXISTS (SELECT 1 FROM memory_current_states WHERE memory_current_states.id = memory_processing_jobs.memory_id))`,
  );
  return { jobCount: jobs.changes, sourceRefCount: refs.changes };
}
