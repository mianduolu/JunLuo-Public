import type * as SQLite from 'expo-sqlite';
import { retainSavedPostConfirmations } from '../sync/syncBaiyunPostConfirmations';
import { memoryCandidateEditableHash, type MemoryCandidateReview } from './memoryCandidateReview';
import { stableMemoryHash } from './memoryAtomicity';

export function matchesSavedMemoryCandidateReceipt(candidateJson: string | null | undefined,
  expected: { reviewId: string; editableHash: string }) {
  try {
    const receipt = candidateJson ? JSON.parse(candidateJson) : null;
    return receipt?.savedReviewId === expected.reviewId && receipt?.savedEditableHash === expected.editableHash;
  } catch { return false; }
}

export type MemoryIngestionStream = 'manual_digest' | 'proactive' | 'episode' | 'weekly' | 'voice_call' | 'explicit_fact' | 'current_state' | 'history_import' | 'letter' | 'post' | 'observation' | 'gift';
export type MemoryIngestionBatchStatus = 'pending' | 'ready' | 'resolved' | 'no_value' | 'failed' | 'stale' | 'waiting';
export type MemoryIngestionItemStatus = 'pending' | 'saved' | 'discarded' | 'suppressed' | 'waiting';

export type MemoryIngestionWaiting = {
  reason: 'pending_target' | 'needs_recheck';
  targetMemoryIds: string[];
};
export type MemoryIngestionWorkMetadata = {
  version: 1;
  workId: string;
  messageIds: string[];
  selectedMessageIds?: string[];
  lifeSelfRegistration?: import('./lifeSelfMemoryIngestion').LifeSelfRegistration;
  lifeSelfBindings?: import('../life/lifeSelfMemorySource').LifeSelfBinding[];
  lifeSelfWork?: import('./lifeSelfMemoryIngestion').LifeSelfWorkSource[];
  letter?: import('./letterMemoryIngestion').LetterMaterialBinding;
  observations?: import('./memoryObservationIngestion').ObservationMaterialBinding[];
  observationWork?: Array<{ observationId: string; sourceHash: string }>;
  observationRegistration?: { observationId: string; sourceHash: string; capturedAt: number };
  voiceCall?: { callId: string; bindings: import('../voiceCall/voiceCallMemorySource').VoiceCallMaterialBinding[]; selectionWorkId?: string };
  letterRegistration?: { sessionId: string; messageId: string; sourceHash: string; availableAt: number };
  readingRegistration?: import('../reading/readingMemoryIngestion').ReadingActivityRegistration;
  readings?: import('../reading/readingMemoryOrganizationSource').ReadingOrganizationBinding[];
  readingWork?: import('../reading/readingMemoryIngestion').ReadingWorkSource[];
  shiyingRegistration?: { recordId: string; availableAt: number; bodyVersion?: string; imageNoteVersion?: string;
    replacedSources?: string[] };
  shiying?: import('../shiying/shiyingMemorySource').ShiyingMemoryBinding[];
  shiyingWork?: import('../shiying/shiyingMemoryIngestion').ShiyingWorkSource[];
  waiting?: MemoryIngestionWaiting;
  gift?: { bindings: import('../gifts/giftMemorySource').GiftMemoryBinding[]; dataEpoch: number | null;
    cachedCandidates?: MemoryCandidateReview[]; suppressedItemKeys?: string[] };
  post?: { bindings: import('../posts/baiyunPostMemorySource').PostMaterialBinding[];
    corrections?: Array<{ kind: 'memory' | 'current_state'; id: string; key: string }>;
    newRanges: import('../posts/baiyunPostMemorySource').PostMaterialRange[];
    cachedCandidates?: MemoryCandidateReview[]; dataEpoch: number | null;
    replaces?: { reviewId: string; editableHash: string; refs: MemoryIngestionItemRef[] } };
};

function parseWorkMetadata(value: string | null | undefined): MemoryIngestionWorkMetadata | undefined {
  try {
    const parsed = value ? JSON.parse(value) : undefined;
    if (parsed?.version !== 1 || typeof parsed.workId !== 'string' || !parsed.workId
      || !Array.isArray(parsed.messageIds) || !parsed.messageIds.every((id: unknown) => typeof id === 'string')
      || (parsed.selectedMessageIds !== undefined && (!Array.isArray(parsed.selectedMessageIds)
        || !parsed.selectedMessageIds.every((id: unknown) => typeof id === 'string')))) return undefined;
    return parsed;
  } catch { return undefined; }
}

export type MemoryIngestionItemRef = {
  batchId: string;
  itemKey: string;
};

export type MemoryIngestionBatchInput = {
  advancesCursor: boolean;
  id: string;
  scopeKey: string;
  sessionId?: string;
  sourceFirstAt?: number;
  sourceFirstMessageId?: string;
  sourceHash: string;
  sourceLastAt?: number;
  sourceLastMessageId?: string;
  stream: MemoryIngestionStream;
  workMetadata?: MemoryIngestionWorkMetadata;
};

export type MemoryIngestionBatch = MemoryIngestionBatchInput & {
  completedAt?: number;
  createdAt: number;
  itemCount: number;
  resolvedCount: number;
  status: MemoryIngestionBatchStatus;
  updatedAt: number;
};

export type MemoryIngestionCursor = {
  batchId?: string;
  scopeKey: string;
  stream: MemoryIngestionStream;
  throughCreatedAt: number;
  throughMessageId: string;
  updatedAt: number;
};

type BatchRow = {
  advances_cursor: number;
  completed_at: number | null;
  created_at: number;
  id: string;
  item_count: number;
  resolved_count: number;
  scope_key: string;
  session_id: string | null;
  source_first_at: number | null;
  source_first_message_id: string | null;
  source_hash: string;
  source_last_at: number | null;
  source_last_message_id: string | null;
  status: string;
  stream: string;
  updated_at: number;
  work_metadata_json?: string | null;
};

type CursorRow = {
  batch_id: string | null;
  scope_key: string;
  stream: string;
  through_created_at: number;
  through_message_id: string;
  updated_at: number;
};

function normalizeBatchStatus(value: string): MemoryIngestionBatchStatus {
  return ['pending', 'ready', 'resolved', 'no_value', 'failed', 'stale', 'waiting'].includes(value)
    ? value as MemoryIngestionBatchStatus
    : 'pending';
}

function batchFromRow(row: BatchRow): MemoryIngestionBatch {
  return {
    advancesCursor: row.advances_cursor === 1,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    id: row.id,
    itemCount: row.item_count,
    resolvedCount: row.resolved_count,
    scopeKey: row.scope_key,
    sessionId: row.session_id ?? undefined,
    sourceFirstAt: row.source_first_at ?? undefined,
    sourceFirstMessageId: row.source_first_message_id ?? undefined,
    sourceHash: row.source_hash,
    sourceLastAt: row.source_last_at ?? undefined,
    sourceLastMessageId: row.source_last_message_id ?? undefined,
    status: normalizeBatchStatus(row.status),
    stream: row.stream as MemoryIngestionStream,
    updatedAt: row.updated_at,
    workMetadata: parseWorkMetadata(row.work_metadata_json),
  };
}

export async function loadPostMemoryIngestionBatchesWithDatabase(database: SQLite.SQLiteDatabase) {
  return (await database.getAllAsync<BatchRow>(
    "SELECT * FROM memory_ingestion_batches WHERE stream = 'post' ORDER BY created_at, id")).map(batchFromRow);
}

export const MEMORY_INGESTION_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS memory_ingestion_batches (
      id TEXT PRIMARY KEY NOT NULL,
      stream TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      session_id TEXT,
      source_first_message_id TEXT,
      source_last_message_id TEXT,
      source_first_at INTEGER,
      source_last_at INTEGER,
      source_hash TEXT NOT NULL,
      work_metadata_json TEXT,
      advances_cursor INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      item_count INTEGER NOT NULL DEFAULT 0,
      resolved_count INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_ingestion_items (
      batch_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      memory_id TEXT,
      candidate_json TEXT,
      post_review_id TEXT,
      post_review_owner_device_id TEXT,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (batch_id, item_key)
    );
    CREATE TABLE IF NOT EXISTS memory_ingestion_cursors (
      scope_key TEXT NOT NULL,
      stream TEXT NOT NULL,
      through_message_id TEXT NOT NULL,
      through_created_at INTEGER NOT NULL,
      batch_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope_key, stream)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_ingestion_batches_scope
      ON memory_ingestion_batches(scope_key, stream, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_ingestion_items_status
      ON memory_ingestion_items(batch_id, status);
  `;

export async function ensureMemoryIngestionSchema(database: SQLite.SQLiteDatabase) {
  await database.execAsync(MEMORY_INGESTION_SCHEMA_SQL);
  const columns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(memory_ingestion_items)');
  if (!columns.some((column) => column.name === 'candidate_json')) {
    await database.execAsync('ALTER TABLE memory_ingestion_items ADD COLUMN candidate_json TEXT');
  }
  const batchColumns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(memory_ingestion_batches)');
  if (!batchColumns.some(column => column.name === 'work_metadata_json')) {
    await database.execAsync('ALTER TABLE memory_ingestion_batches ADD COLUMN work_metadata_json TEXT');
  }
}

export async function loadMemoryIngestionBatchWithDatabase(
  database: SQLite.SQLiteDatabase,
  batchId: string,
) {
  const row = await database.getFirstAsync<BatchRow>(
    'SELECT * FROM memory_ingestion_batches WHERE id = ? LIMIT 1',
    batchId,
  );
  return row ? batchFromRow(row) : null;
}

export type MemoryIngestionWork = {
  workId: string;
  selectedMessageIds: string[];
  completedMessageIds: string[];
  remainingMessageIds: string[];
  batches: MemoryIngestionBatch[];
};

export async function loadMemoryIngestionWorkWithDatabase(database: SQLite.SQLiteDatabase, scopeKey: string, workId: string): Promise<MemoryIngestionWork | null> {
  const rows = await database.getAllAsync<BatchRow>(
    `SELECT * FROM memory_ingestion_batches WHERE scope_key = ? AND stream = 'manual_digest' AND advances_cursor = 0
     AND json_valid(work_metadata_json) AND json_extract(work_metadata_json, '$.workId') = ? ORDER BY created_at, id`, scopeKey, workId);
  const batches = rows.map(batchFromRow);
  const selectedMessageIds = batches.find(batch => batch.workMetadata?.selectedMessageIds)?.workMetadata?.selectedMessageIds;
  // Old non-contiguous selections cannot be reconstructed from their endpoints.
  if (!selectedMessageIds) return null;
  const completed = new Set(batches.filter(batch => ['ready', 'resolved', 'no_value'].includes(batch.status))
    .flatMap(batch => batch.workMetadata?.messageIds ?? []));
  return { workId, selectedMessageIds, batches,
    completedMessageIds: selectedMessageIds.filter(id => completed.has(id)),
    remainingMessageIds: selectedMessageIds.filter(id => !completed.has(id)) };
}

export async function loadLatestUnfinishedMemoryIngestionWorkWithDatabase(database: SQLite.SQLiteDatabase, scopeKey: string) {
  const rows = await database.getAllAsync<BatchRow>(
    `SELECT * FROM memory_ingestion_batches WHERE scope_key = ? AND stream = 'manual_digest' AND advances_cursor = 0
     AND json_valid(work_metadata_json) AND json_type(work_metadata_json, '$.selectedMessageIds') = 'array'
     ORDER BY created_at DESC, id DESC`, scopeKey);
  for (const row of rows) {
    const metadata = parseWorkMetadata(row.work_metadata_json);
    if (!metadata) continue;
    const work = await loadMemoryIngestionWorkWithDatabase(database, scopeKey, metadata.workId);
    if (work?.remainingMessageIds.length) return work;
  }
  return null;
}

export async function updateMemoryIngestionBatchWaitingWithDatabase(database: SQLite.SQLiteDatabase, batchId: string,
  waiting?: MemoryIngestionWaiting, now = Date.now()) {
  const batch = await loadMemoryIngestionBatchWithDatabase(database, batchId);
  if (!batch || ['resolved', 'no_value', 'stale'].includes(batch.status)) return batch;
  const metadata: MemoryIngestionWorkMetadata = { ...(batch.workMetadata ?? { version: 1, workId: batch.id, messageIds: [] }), waiting };
  await database.runAsync(`UPDATE memory_ingestion_batches SET work_metadata_json = ?, status = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify(metadata), waiting ? 'waiting' : batch.itemCount ? 'ready' : 'pending', now, batchId);
  return loadMemoryIngestionBatchWithDatabase(database, batchId);
}

export async function loadWaitingMemoryCandidatesWithDatabase(database: SQLite.SQLiteDatabase, batchId: string) {
  const rows = await database.getAllAsync<{ item_key: string; candidate_json: string }>(
    "SELECT item_key, candidate_json FROM memory_ingestion_items WHERE batch_id = ? AND status = 'waiting' AND candidate_json IS NOT NULL ORDER BY created_at, item_key", batchId);
  return rows.map(row => ({ itemKey: row.item_key, candidate: JSON.parse(row.candidate_json) as MemoryCandidateReview }));
}

export async function releaseMemoryIngestionBatchWaitingWithDatabase(database: SQLite.SQLiteDatabase, batchId: string,
  isCurrent: (candidate: MemoryCandidateReview) => Promise<boolean | MemoryCandidateReview['reviewStatus']>, now = Date.now()) {
  const batch = await loadMemoryIngestionBatchWithDatabase(database, batchId);
  if (!batch || batch.status !== 'waiting') return batch;
  const targets = batch.workMetadata?.waiting?.targetMemoryIds ?? [];
  const waiting = await loadWaitingMemoryCandidatesWithDatabase(database, batchId);
  // A stale draft is already visible as pending, while its range still waits.
  // Recheck that retained draft before clearing the batch's waiting metadata.
  if (batch.itemCount && (!waiting.length || batch.workMetadata?.waiting?.reason === 'needs_recheck')) {
    const visible = await database.getAllAsync<{ item_key: string; candidate_json: string }>(
      "SELECT item_key, candidate_json FROM memory_ingestion_items WHERE batch_id = ? AND status = 'pending' AND candidate_json IS NOT NULL ORDER BY created_at, item_key", batchId);
    waiting.push(...visible.map(row => ({ itemKey: row.item_key, candidate: JSON.parse(row.candidate_json) as MemoryCandidateReview })));
  }
  const blockedByAnotherDraft = (target: string, reviewId = '') => database.getFirstAsync(
      `SELECT 1 FROM memory_ingestion_items WHERE status = 'pending'
       AND COALESCE(json_extract(candidate_json, '$.reviewId'), '') != ?
       AND (json_extract(candidate_json, '$.understandingReview.targetMemoryId') = ?
         OR json_extract(candidate_json, '$.continuationReview.targetMemoryId') = ?
         OR json_extract(candidate_json, '$.readingReview.targetMemoryId') = ?
         OR 'current_state:' || json_extract(candidate_json, '$.currentStateReview.targetCurrentStateId') = ?) LIMIT 1`, reviewId, target, target, target, target);
  // A blocked extraction without proposals still waits for all of its targets.
  if (!waiting.length && !batch.itemCount) {
    for (const target of targets) {
      if (await blockedByAnotherDraft(target)) return batch;
    }
    return updateMemoryIngestionBatchWaitingWithDatabase(database, batchId, undefined, now);
  }
  const affectedBatches = new Set([batchId]);
  const promotedTargets = new Set<string>();
  for (const item of waiting) {
    const refs = new Map([...(item.candidate.ingestionRefs ?? []), { batchId, itemKey: item.itemKey }]
      .map(ref => [`${ref.batchId}\u0000${ref.itemKey}`, ref]));
    const copies = await database.getAllAsync<{ batch_id: string; item_key: string; candidate_json: string }>(
      `SELECT batch_id, item_key, candidate_json FROM memory_ingestion_items
       WHERE status IN ('pending', 'waiting') AND json_extract(candidate_json, '$.reviewId') = ?
         AND (${[...refs.values()].map(() => '(batch_id = ? AND item_key = ?)').join(' OR ')})
       ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, updated_at DESC`,
      item.candidate.reviewId, ...[...refs.values()].flatMap(ref => [ref.batchId, ref.itemKey]));
    if (!copies.length) continue;
    // An already visible copy owns the edits. Promote every owned copy together.
    const candidate = JSON.parse(copies[0].candidate_json) as MemoryCandidateReview;
    const target = candidate.currentStateReview?.targetCurrentStateId ? `current_state:${candidate.currentStateReview.targetCurrentStateId}`
      : candidate.understandingReview?.targetMemoryId ?? candidate.continuationReview?.targetMemoryId ?? candidate.readingReview?.targetMemoryId;
    if (target && (promotedTargets.has(target) || await blockedByAnotherDraft(target, candidate.reviewId))) continue;
    if (target) promotedTargets.add(target);
    const status = await isCurrent(candidate);
    const current = status === true || status === 'current';
    const promoted = { ...candidate, reviewStatus: current ? 'current' : typeof status === 'string' ? status : 'basis_changed' };
    await database.runAsync(
      `UPDATE memory_ingestion_items SET status = 'pending', candidate_json = ?, updated_at = ?
       WHERE status IN ('pending', 'waiting') AND json_extract(candidate_json, '$.reviewId') = ?
         AND (${copies.map(() => '(batch_id = ? AND item_key = ?)').join(' OR ')})`,
      JSON.stringify(promoted), now, candidate.reviewId, ...copies.flatMap(copy => [copy.batch_id, copy.item_key]));
    for (const copy of copies) {
      affectedBatches.add(copy.batch_id);
      if (!current) await updateMemoryIngestionBatchWaitingWithDatabase(database, copy.batch_id,
        { reason: 'needs_recheck', targetMemoryIds: target ? [target] : [] }, now);
    }
    if (!current) break;
  }
  for (const affected of affectedBatches) {
    const unresolved = await database.getFirstAsync(
      `SELECT 1 FROM memory_ingestion_items WHERE batch_id = ?
       AND (status = 'waiting' OR (status = 'pending' AND COALESCE(json_extract(candidate_json, '$.reviewStatus'), 'current') != 'current')) LIMIT 1`, affected);
    if (!unresolved) await updateMemoryIngestionBatchWaitingWithDatabase(database, affected, undefined, now);
    await refreshMemoryIngestionBatch(database, affected, now);
  }
  return loadMemoryIngestionBatchWithDatabase(database, batchId);
}

export async function beginMemoryIngestionBatchWithDatabase(
  database: SQLite.SQLiteDatabase,
  input: MemoryIngestionBatchInput,
  now = Date.now(),
) {
  await database.runAsync(
    `INSERT INTO memory_ingestion_batches (
      id, stream, scope_key, session_id,
      source_first_message_id, source_last_message_id, source_first_at, source_last_at,
      source_hash, advances_cursor, work_metadata_json, status, item_count, resolved_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = CASE
        WHEN memory_ingestion_batches.status IN ('ready', 'resolved', 'no_value', 'waiting', 'stale') THEN memory_ingestion_batches.status
        ELSE 'pending'
      END,
      updated_at = excluded.updated_at`,
    input.id,
    input.stream,
    input.scopeKey,
    input.sessionId ?? null,
    input.sourceFirstMessageId ?? null,
    input.sourceLastMessageId ?? null,
    input.sourceFirstAt ?? null,
    input.sourceLastAt ?? null,
    input.sourceHash,
    input.advancesCursor ? 1 : 0,
    input.workMetadata ? JSON.stringify(input.workMetadata) : null,
    now,
    now,
  );
  return loadMemoryIngestionBatchWithDatabase(database, input.id);
}

async function advanceMemoryIngestionCursor(
  database: SQLite.SQLiteDatabase,
  batch: MemoryIngestionBatch,
  now: number,
) {
  if (
    !batch.advancesCursor
    || !batch.sourceLastMessageId
    || typeof batch.sourceLastAt !== 'number'
  ) return;
  if (batch.stream === 'manual_digest' || batch.stream === 'proactive') {
    const waiting = await database.getFirstAsync(
      `SELECT 1 FROM memory_ingestion_batches WHERE scope_key = ? AND advances_cursor = 1
       AND stream IN ('manual_digest', 'proactive') AND status = 'waiting'
       AND source_first_at <= ? LIMIT 1`, batch.scopeKey, batch.sourceLastAt);
    if (waiting) return;
  }
  await database.runAsync(
    `INSERT INTO memory_ingestion_cursors (
      scope_key, stream, through_message_id, through_created_at, batch_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key, stream) DO UPDATE SET
      through_message_id = excluded.through_message_id,
      through_created_at = excluded.through_created_at,
      batch_id = excluded.batch_id,
      updated_at = excluded.updated_at
    WHERE excluded.through_created_at >= memory_ingestion_cursors.through_created_at`,
    batch.scopeKey,
    batch.stream,
    batch.sourceLastMessageId,
    batch.sourceLastAt,
    batch.id,
    now,
  );
}

async function refreshMemoryIngestionBatch(
  database: SQLite.SQLiteDatabase,
  batchId: string,
  now: number,
) {
  const counts = await database.getFirstAsync<{ item_count: number; pending_count: number; waiting_count: number }>(
    `SELECT
       COUNT(*) AS item_count,
       SUM(CASE WHEN status IN ('pending', 'waiting') THEN 1 ELSE 0 END) AS pending_count,
       SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting_count
     FROM memory_ingestion_items
     WHERE batch_id = ?`,
    batchId,
  );
  const itemCount = counts?.item_count ?? 0;
  const pendingCount = counts?.pending_count ?? 0;
  const resolvedCount = Math.max(0, itemCount - pendingCount);
  const existing = await loadMemoryIngestionBatchWithDatabase(database, batchId);
  const waiting = !!counts?.waiting_count || !!existing?.workMetadata?.waiting;
  const completed = pendingCount === 0 && !waiting;
  const status: MemoryIngestionBatchStatus = waiting ? 'waiting' : completed
    ? itemCount ? 'resolved' : 'no_value'
    : 'ready';
  await database.runAsync(
    `UPDATE memory_ingestion_batches
     SET status = ?, item_count = ?, resolved_count = ?,
         completed_at = ?, updated_at = ?
     WHERE id = ?`,
    status,
    itemCount,
    resolvedCount,
    completed ? now : null,
    now,
    batchId,
  );
  const batch = await loadMemoryIngestionBatchWithDatabase(database, batchId);
  if (batch && !waiting && (batch.stream === 'manual_digest' || batch.stream === 'proactive')) {
    // Reviewing a saved draft is independent of having processed its source messages.
    await advanceMemoryIngestionCursor(database, { ...batch, stream: 'proactive' }, now);
    await advanceMemoryIngestionCursor(database, { ...batch, stream: 'manual_digest' }, now);
  } else if (completed && batch) {
    await advanceMemoryIngestionCursor(database, batch, now);
  }
  return batch;
}

export async function loadChatMemoryIngestionProgressWithDatabase(database: SQLite.SQLiteDatabase, scopeKey: string) {
  // Older ready batches already contain durable drafts, but did not move the bookmark.
  const previous = await database.getFirstAsync<{ through_created_at: number }>(
    `SELECT through_created_at FROM memory_ingestion_cursors WHERE scope_key = ?
     AND stream IN ('proactive', 'manual_digest') ORDER BY through_created_at DESC LIMIT 1`, scopeKey);
  const processed = await database.getFirstAsync<BatchRow>(
    `SELECT * FROM memory_ingestion_batches WHERE scope_key = ? AND advances_cursor = 1
     AND stream IN ('proactive', 'manual_digest') AND source_last_message_id IS NOT NULL
     AND (status IN ('ready', 'resolved', 'no_value') OR (item_count > 0 AND status IN ('pending', 'failed')))
     AND NOT EXISTS (SELECT 1 FROM memory_ingestion_items i WHERE i.batch_id = memory_ingestion_batches.id AND i.status = 'waiting')
     ORDER BY source_last_at DESC, created_at DESC LIMIT 1`, scopeKey);
  if (processed && (!previous || (processed.source_last_at ?? -1) > previous.through_created_at)) {
    const batch = batchFromRow(processed);
    await advanceMemoryIngestionCursor(database, { ...batch, stream: 'proactive' }, Date.now());
    await advanceMemoryIngestionCursor(database, { ...batch, stream: 'manual_digest' }, Date.now());
  }
  const cursors = await database.getAllAsync<CursorRow>(
    `SELECT * FROM memory_ingestion_cursors WHERE scope_key = ? AND stream IN ('proactive', 'manual_digest')
     ORDER BY through_created_at DESC, updated_at DESC`, scopeKey);
  const latest = cursors[0];
  if (latest) {
    for (const stream of ['proactive', 'manual_digest'] as const) {
      await database.runAsync(`INSERT INTO memory_ingestion_cursors
        (scope_key, stream, through_message_id, through_created_at, batch_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scope_key, stream) DO UPDATE SET
        through_message_id = excluded.through_message_id, through_created_at = excluded.through_created_at,
        batch_id = excluded.batch_id, updated_at = excluded.updated_at`,
      scopeKey, stream, latest.through_message_id, latest.through_created_at, latest.batch_id, latest.updated_at);
    }
  }
  const retry = await database.getFirstAsync<BatchRow>(
    `SELECT * FROM memory_ingestion_batches WHERE scope_key = ? AND advances_cursor = 1
     AND stream IN ('proactive', 'manual_digest') AND (status = 'waiting' OR (status IN ('pending', 'failed') AND item_count = 0))
     AND source_first_at > ? ORDER BY source_first_at, created_at LIMIT 1`, scopeKey, latest?.through_created_at ?? -1);
  return { cursor: await loadMemoryIngestionCursorWithDatabase(database, scopeKey, 'proactive'),
    retry: retry ? batchFromRow(retry) : null };
}

export async function registerMemoryIngestionOutcomeWithDatabase(
  database: SQLite.SQLiteDatabase,
  input: {
    batchId: string;
    pendingItemKeys: string[];
    suppressedItemKeys?: string[];
    pendingCandidates?: Array<{ itemKey: string; candidateJson: string }>;
  },
  now = Date.now(),
) {
  const batch = await loadMemoryIngestionBatchWithDatabase(database, input.batchId);
  if (!batch) return null;
  // Settled batches stay settled even if an in-flight extraction changes its item keys.
  if (batch.status === 'resolved' || batch.status === 'no_value' || batch.status === 'stale') return batch;
  if (
    batch?.stream === 'proactive'
    && batch.advancesCursor
    && !batch.workMetadata?.observations?.length
    && batch.sourceLastMessageId
    && typeof batch.sourceLastAt === 'number'
  ) {
    const cursor = await loadMemoryIngestionCursorWithDatabase(
      database,
      batch.scopeKey,
      'proactive',
    );
    const coveredByNewerCursor = Boolean(cursor && cursor.batchId !== batch.id && (
      cursor.throughCreatedAt > batch.sourceLastAt
      || (
        cursor.throughCreatedAt === batch.sourceLastAt
        && cursor.throughMessageId === batch.sourceLastMessageId
      )
    ));
    if (coveredByNewerCursor) {
      await database.runAsync(
        `UPDATE memory_ingestion_items
         SET status = 'suppressed', resolved_at = ?, updated_at = ?, candidate_json = NULL
         WHERE batch_id = ? AND status = 'pending'`,
        now,
        now,
        batch.id,
      );
      await database.runAsync(
        `UPDATE memory_ingestion_batches
         SET status = 'stale', resolved_count = item_count, completed_at = ?, updated_at = ?
         WHERE id = ? AND status NOT IN ('resolved', 'no_value')`,
        now,
        now,
        batch.id,
      );
      return loadMemoryIngestionBatchWithDatabase(database, batch.id);
    }
  }
  // A completed extraction is resumed from its stored candidates, never replaced by a rerun.
  if (batch?.itemCount && await database.getFirstAsync(
    `SELECT 1 FROM memory_ingestion_items
     WHERE batch_id = ? AND status IN ('pending', 'waiting') AND candidate_json IS NOT NULL LIMIT 1`,
    input.batchId,
  )) return batch;
  const blockedCandidateKeys = new Set<string>();
  const waitingCandidateKeys = new Set<string>();
  const waitingTargets = new Set<string>();
  const proposedTargets = new Set<string>();
  const explicitSelection = batch.stream === 'post' || !!batch.workMetadata?.voiceCall?.selectionWorkId || batch.stream === 'manual_digest' && !batch.advancesCursor
    && (!!batch.workMetadata?.workId || batch.scopeKey.startsWith('reading-result:')
      || (batch.id.startsWith('memory-ingestion-manual_digest-') && /-selected(?:-|$)/.test(batch.id)));
  for (const value of input.pendingCandidates ?? []) {
    const candidate = JSON.parse(value.candidateJson) as MemoryCandidateReview;
    const target = candidate.currentStateReview?.targetCurrentStateId ? `current_state:${candidate.currentStateReview.targetCurrentStateId}`
      : candidate.understandingReview?.targetMemoryId ?? candidate.continuationReview?.targetMemoryId ?? candidate.readingReview?.targetMemoryId;
    if (target) {
      const pendingTarget = proposedTargets.has(target) || await database.getFirstAsync(
        `SELECT 1 FROM memory_ingestion_items WHERE batch_id != ? AND status = 'pending'
         AND COALESCE(json_extract(candidate_json, '$.reviewId'), '') != ?
         AND (json_extract(candidate_json, '$.understandingReview.targetMemoryId') = ?
           OR json_extract(candidate_json, '$.continuationReview.targetMemoryId') = ?
           OR json_extract(candidate_json, '$.readingReview.targetMemoryId') = ?
           OR 'current_state:' || json_extract(candidate_json, '$.currentStateReview.targetCurrentStateId') = ?) LIMIT 1`, input.batchId, candidate.reviewId, target, target, target, target);
      proposedTargets.add(target);
      if (pendingTarget) { waitingCandidateKeys.add(value.itemKey); waitingTargets.add(target); continue; }
    }
    if (!candidate.understandingSubject) {
      if (explicitSelection) continue;
      // The existing item key includes the original message IDs, when available.
      // Without those IDs, require the same whole input, not merely similar prose.
      const discarded = await database.getFirstAsync(
        `SELECT 1 FROM memory_ingestion_items i JOIN memory_ingestion_batches b ON b.id = i.batch_id
         WHERE i.batch_id != ? AND i.item_key = ? AND i.status = 'discarded'
           AND b.scope_key = ? AND b.session_id IS ?
           AND (? = 1 OR b.source_hash = ?) LIMIT 1`,
        input.batchId, value.itemKey, batch.scopeKey, batch.sessionId ?? null,
        Array.isArray(candidate.sourceRefs) && candidate.sourceRefs.length > 0 ? 1 : 0, batch.sourceHash);
      if (discarded) blockedCandidateKeys.add(value.itemKey);
      continue;
    }
    const existing = await database.getFirstAsync(
      `SELECT 1 FROM memory_ingestion_items WHERE batch_id != ?
        AND item_key = ? AND status IN ('saved', 'discarded') AND ? = 0 LIMIT 1`, input.batchId, value.itemKey,
      batch.scopeKey.startsWith('understanding-review:') || explicitSelection ? 1 : 0);
    if (existing) blockedCandidateKeys.add(value.itemKey);
  }
  const pendingKeys = Array.from(new Set(input.pendingItemKeys.filter(key => !!key && !blockedCandidateKeys.has(key))));
  const suppressedKeys = Array.from(new Set([...(input.suppressedItemKeys ?? []), ...blockedCandidateKeys].filter(Boolean)));
  await database.runAsync(
    `UPDATE memory_ingestion_items
     SET status = 'suppressed', resolved_at = ?, updated_at = ?
     WHERE batch_id = ? AND status = 'pending'`,
    now,
    now,
    input.batchId,
  );
  for (const itemKey of pendingKeys) {
    await database.runAsync(
      `INSERT INTO memory_ingestion_items (
        batch_id, item_key, status, created_at, updated_at
      ) VALUES (?, ?, 'pending', ?, ?)
      ON CONFLICT(batch_id, item_key) DO UPDATE SET
        status = CASE
          WHEN memory_ingestion_items.status IN ('saved', 'discarded') THEN memory_ingestion_items.status
          ELSE 'pending'
        END,
        resolved_at = CASE
          WHEN memory_ingestion_items.status IN ('saved', 'discarded') THEN memory_ingestion_items.resolved_at
          ELSE NULL
        END,
        updated_at = excluded.updated_at`,
      input.batchId,
      itemKey,
      now,
      now,
    );
  }
  for (const itemKey of suppressedKeys) {
    await database.runAsync(
      `INSERT INTO memory_ingestion_items (
        batch_id, item_key, status, resolved_at, created_at, updated_at
      ) VALUES (?, ?, 'suppressed', ?, ?, ?)
      ON CONFLICT(batch_id, item_key) DO UPDATE SET
        status = CASE
          WHEN memory_ingestion_items.status IN ('saved', 'discarded') THEN memory_ingestion_items.status
          ELSE 'suppressed'
        END,
        resolved_at = CASE
          WHEN memory_ingestion_items.status IN ('saved', 'discarded') THEN memory_ingestion_items.resolved_at
          ELSE excluded.resolved_at
        END,
        updated_at = excluded.updated_at`,
      input.batchId,
      itemKey,
      now,
      now,
      now,
    );
  }
  for (const candidate of input.pendingCandidates ?? []) {
    if (blockedCandidateKeys.has(candidate.itemKey)) continue;
    await database.runAsync(
      `UPDATE memory_ingestion_items SET candidate_json = ?
       WHERE batch_id = ? AND item_key = ? AND status = 'pending'`,
      candidate.candidateJson, input.batchId, candidate.itemKey,
    );
  }
  for (const itemKey of waitingCandidateKeys) await database.runAsync(
    "UPDATE memory_ingestion_items SET status = 'waiting' WHERE batch_id = ? AND item_key = ? AND status = 'pending'",
    input.batchId, itemKey);
  if (waitingCandidateKeys.size) await updateMemoryIngestionBatchWaitingWithDatabase(database, batch.id,
    { reason: 'pending_target', targetMemoryIds: [...waitingTargets] }, now);
  await settleMemoryIngestionPayloads(database, input.batchId);
  return refreshMemoryIngestionBatch(database, input.batchId, now);
}

async function settleMemoryIngestionPayloads(database: SQLite.SQLiteDatabase, batchId: string, currentStateId?: string, savedWeeklyVersion?: string) {
  const rows = await database.getAllAsync<{ item_key: string; candidate_json: string; status: string }>(
    `SELECT item_key, candidate_json, status FROM memory_ingestion_items
     WHERE batch_id = ? AND status NOT IN ('pending', 'waiting') AND candidate_json IS NOT NULL
       AND json_type(candidate_json, '$.reviewedSourceRefs') IS NULL`, batchId);
  for (const row of rows) {
    const candidate = JSON.parse(row.candidate_json) as MemoryCandidateReview;
    // The saved receipt can recognize a repeated confirmation without retaining
    // its text. A different editor's unsaved draft must not receive false success.
    const reviewedSourceRefs = (candidate.sourceRefs ?? []).filter(ref => candidate.understandingSubject || ref.relation === 'direct')
      .map(({ sessionId, messageId }) => ({ sessionId, messageId }));
    const savedReceipt = row.status === 'saved' && candidate.reviewId
      ? { savedReviewId: candidate.reviewId, savedEditableHash: memoryCandidateEditableHash(candidate),
        ...(candidate.source === 'weekly-context' && savedWeeklyVersion ? { savedWeeklyVersion } : {}),
        ...(candidate.currentStateReview && currentStateId ? { savedCurrentStateId: currentStateId } : {}) } : {};
    await database.runAsync('UPDATE memory_ingestion_items SET candidate_json = ? WHERE batch_id = ? AND item_key = ?',
      reviewedSourceRefs.length || 'savedReviewId' in savedReceipt ? JSON.stringify({ reviewedSourceRefs, ...savedReceipt }) : null, batchId, row.item_key);
  }
}

export async function resolveMemoryIngestionItemsWithDatabase(
  database: SQLite.SQLiteDatabase,
  refs: MemoryIngestionItemRef[],
  resolution: 'saved' | 'discarded' | 'suppressed',
  options: { memoryId?: string; currentStateId?: string; savedWeeklyVersion?: string; now?: number;
    expectedCandidate?: { reviewId: string; editableHash: string }; expectedCandidateJsonHash?: string } = {},
) {
  const now = options.now ?? Date.now();
  const uniqueRefs = new Map(refs.map((ref) => [`${ref.batchId}\u0000${ref.itemKey}`, ref]));
  if (options.expectedCandidate || options.expectedCandidateJsonHash) {
    for (const ref of uniqueRefs.values()) {
      const row = await database.getFirstAsync<{ status: string; candidate_json: string | null }>(
        'SELECT status, candidate_json FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ?', ref.batchId, ref.itemKey);
      if (!row?.candidate_json || !['pending', 'waiting'].includes(row.status)) throw new Error('MEMORY_CANDIDATE_CHANGED');
      if (options.expectedCandidateJsonHash && stableMemoryHash(row.candidate_json) !== options.expectedCandidateJsonHash) throw new Error('MEMORY_CANDIDATE_CHANGED');
      if (options.expectedCandidate) {
        const candidate = JSON.parse(row.candidate_json) as MemoryCandidateReview;
        if (candidate.reviewId !== options.expectedCandidate.reviewId || memoryCandidateEditableHash(candidate) !== options.expectedCandidate.editableHash) throw new Error('MEMORY_CANDIDATE_CHANGED');
      }
    }
  }
  const batchIds = new Set<string>();
  for (const ref of uniqueRefs.values()) {
    batchIds.add(ref.batchId);
    await database.runAsync(
      `UPDATE memory_ingestion_items
       SET status = ?, memory_id = ?, resolved_at = ?, updated_at = ?
       WHERE batch_id = ? AND item_key = ? AND (status = 'pending' OR (status = 'waiting' AND ? != 'saved'))`,
      resolution,
      resolution === 'saved' ? options.memoryId ?? null : null,
      now,
      now,
      ref.batchId,
      ref.itemKey,
      resolution,
    );
  }
  for (const batchId of batchIds) {
    await settleMemoryIngestionPayloads(database, batchId, options.currentStateId, options.savedWeeklyVersion);
    if (resolution === 'saved') await retainSavedPostConfirmations(database, batchId);
    const batch = await loadMemoryIngestionBatchWithDatabase(database, batchId);
    if (batch?.workMetadata?.waiting && batch.itemCount) {
      const targets = JSON.stringify(batch.workMetadata.waiting.targetMemoryIds);
      const outstanding = await database.getFirstAsync(
        `SELECT 1 FROM memory_ingestion_items WHERE batch_id = ? AND status IN ('pending', 'waiting')
         AND (status = 'waiting' OR json_extract(candidate_json, '$.understandingReview.targetMemoryId') IN (SELECT value FROM json_each(?))
           OR json_extract(candidate_json, '$.continuationReview.targetMemoryId') IN (SELECT value FROM json_each(?))
           OR json_extract(candidate_json, '$.readingReview.targetMemoryId') IN (SELECT value FROM json_each(?))
           OR 'current_state:' || json_extract(candidate_json, '$.currentStateReview.targetCurrentStateId') IN (SELECT value FROM json_each(?))) LIMIT 1`,
        batchId, targets, targets, targets, targets);
      if (!outstanding) await updateMemoryIngestionBatchWaitingWithDatabase(database, batchId, undefined, now);
    }
    await refreshMemoryIngestionBatch(database, batchId, now);
  }
}

export async function markMemoryIngestionBatchFailedWithDatabase(
  database: SQLite.SQLiteDatabase,
  batchId: string,
  now = Date.now(),
) {
  await database.runAsync(
    `UPDATE memory_ingestion_batches
     SET status = 'failed', updated_at = ?
     WHERE id = ? AND status NOT IN ('ready', 'resolved', 'no_value', 'waiting', 'stale')`,
    now,
    batchId,
  );
}

export async function loadMemoryIngestionCursorWithDatabase(
  database: SQLite.SQLiteDatabase,
  scopeKey: string,
  stream: MemoryIngestionStream,
) {
  const row = await database.getFirstAsync<CursorRow>(
    `SELECT * FROM memory_ingestion_cursors
     WHERE scope_key = ? AND stream = ?
     LIMIT 1`,
    scopeKey,
    stream,
  );
  if (!row) return null;
  return {
    batchId: row.batch_id ?? undefined,
    scopeKey: row.scope_key,
    stream: row.stream as MemoryIngestionStream,
    throughCreatedAt: row.through_created_at,
    throughMessageId: row.through_message_id,
    updatedAt: row.updated_at,
  } satisfies MemoryIngestionCursor;
}

export async function seedMemoryIngestionCursorWithDatabase(
  database: SQLite.SQLiteDatabase,
  input: Omit<MemoryIngestionCursor, 'updatedAt' | 'batchId'>,
  now = Date.now(),
) {
  await database.runAsync(
    `INSERT OR IGNORE INTO memory_ingestion_cursors (
      scope_key, stream, through_message_id, through_created_at, batch_id, updated_at
    ) VALUES (?, ?, ?, ?, NULL, ?)`,
    input.scopeKey,
    input.stream,
    input.throughMessageId,
    input.throughCreatedAt,
    now,
  );
  return loadMemoryIngestionCursorWithDatabase(database, input.scopeKey, input.stream);
}
