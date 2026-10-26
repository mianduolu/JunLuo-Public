import type * as SQLite from 'expo-sqlite';
import {
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { createShiyingEntryFactContentHash } from './shiyingJournalContract';

import {
  assertShiyingDeterministicId,
  assertShiyingHash,
  assertShiyingLifeDate,
  assertShiyingUuidV4,
  canonicalJsonV1,
  parseShiyingCoverageReceiptV1,
  parseShiyingEntryV1,
  parseShiyingMessageCursorV1,
  parseShiyingSummaryV1,
  serializeShiyingCoverageReceiptV1,
  serializeShiyingSummaryV1,
  type ShiyingCoverageReceiptV1,
  type ShiyingEntryStatus,
  type ShiyingEntryV1,
  type ShiyingLane,
  type ShiyingMessageCursorV1,
  type ShiyingRole,
  type ShiyingSummaryV1,
} from './shiyingContract';
import {
  runShiyingDatabaseOperation,
  runShiyingTransaction,
} from './shiyingDatabase';
import { compareShiyingMessageCursor } from './shiyingWindow';
import {
  bindShiyingAutomaticBatchInTransaction,
  closeShiyingAutomaticBatchInTransaction,
  notifyShiyingAutomaticStateChanged,
  reserveShiyingAutomaticCallInTransaction,
  releaseShiyingAutomaticCallBeforeRequestInTransaction,
} from './shiyingAutomaticStore';
import {
  parseShiyingManualRunV1,
  type ShiyingManualRunV1,
  type ShiyingRunCandidateV1,
} from './shiyingRunState';

const entryChangeListeners = new Set<() => void>();
export function subscribeShiyingEntryChanges(listener: () => void) {
  entryChangeListeners.add(listener);
  return () => { entryChangeListeners.delete(listener); };
}
export function notifyShiyingEntryChanges() {
  for (const listener of entryChangeListeners) {
    try { listener(); } catch { console.warn('shiying_entry_observer_failed'); }
  }
}

/** Device-local insertion cursor; never a business identity or a synchronized field. */
async function readShiyingNotificationReceiptBaseline(database: SQLite.SQLiteDatabase) {
  return (
    await database.getFirstAsync<{ receiptRowId: number }>(
      'SELECT COALESCE(MAX(rowid), 0) AS receiptRowId FROM shiying_coverage_receipts;',
    )
  )?.receiptRowId ?? 0;
}
export function getShiyingNotificationReceiptBaseline() {
  return runShiyingDatabaseOperation(readShiyingNotificationReceiptBaseline);
}
/** Keep only the local cursor write ordered with entry commits; never await permission or OS work here. */
export function establishShiyingNotificationReceiptBaseline<T>(saveLocalCursor: (receiptRowId: number) => Promise<T>) {
  return runShiyingDatabaseOperation(async database => saveLocalCursor(await readShiyingNotificationReceiptBaseline(database)));
}

export type ShiyingNotificationBatch = {
  batchId: string; receiptRowId: number; hasPendingEntries: boolean;
};
export function listShiyingNotificationBatches(afterReceiptRowId: number, limit = 30): Promise<ShiyingNotificationBatch[]> {
  if (!Number.isSafeInteger(afterReceiptRowId) || afterReceiptRowId < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw storeError('notification_cursor_invalid');
  return runShiyingDatabaseOperation(async database => {
    const rows = await database.getAllAsync<{ batchId: string; receiptRowId: number; pending: number }>(
      `SELECT receipts.batch_id AS batchId, MAX(receipts.rowid) AS receiptRowId,
              EXISTS(SELECT 1 FROM shiying_entries AS entries
                     WHERE entries.batch_id = receipts.batch_id
                       AND entries.status = 'active' AND entries.presented_at IS NULL) AS pending
         FROM shiying_coverage_receipts AS receipts
        WHERE receipts.lane = 'live'
        GROUP BY receipts.batch_id HAVING MAX(receipts.rowid) > ?
        ORDER BY receiptRowId ASC, receipts.batch_id ASC LIMIT ?;`, afterReceiptRowId, limit,
    );
    return rows.map(row => ({ batchId: row.batchId, receiptRowId: row.receiptRowId, hasPendingEntries: row.pending !== 0 }));
  });
}
export function hasShiyingPendingBatch(batchId: string) {
  assertShiyingDeterministicId(batchId, 'batch');
  return runShiyingDatabaseOperation(async database => Boolean(await database.getFirstAsync<{ id: string }>(
    `SELECT id FROM shiying_entries WHERE batch_id = ? AND status = 'active'
       AND presented_at IS NULL LIMIT 1;`, batchId,
  )));
}

export function hasShiyingPendingEntryIds(ids: readonly string[]) {
  ids.forEach(id => assertShiyingUuidV4(id, 'notification_entry_id'));
  if (ids.length > 93) throw storeError('notification_entry_count');
  return runShiyingDatabaseOperation(async database => {
    for (const id of ids) if (await database.getFirstAsync(
      "SELECT id FROM shiying_entries WHERE id=? AND status='active' AND presented_at IS NULL;", id,
    )) return true;
    return false;
  });
}

type EntryRow = {
  id: string;
  batch_id: string;
  life_date: string;
  category: ShiyingEntryV1['category'];
  body: string;
  event_started_at: number;
  event_ended_at: number;
  status: ShiyingEntryStatus;
  edited_at: number | null;
  rejected_at: number | null;
  presented_at: number | null;
  created_at: number;
  updated_at: number;
  payload_version: 1;
};

type EntrySourceRow = {
  ordinal: number;
  session_id: string;
  message_id: string;
  role: ShiyingEntryV1['sources'][number]['role'];
  evidence_kind: ShiyingEntryV1['sources'][number]['evidenceKind'];
  message_created_at: number;
  excerpt_snapshot: string;
  evidence_quote: string | null;
  content_hash: string;
};

type SummaryRow = {
  id: string;
  kind: ShiyingSummaryV1['kind'];
  period_start_life_date: string;
  period_end_life_date: string;
  fact_summary: string;
  baiyun_note: string;
  input_hash: string;
  contract_version: number;
  status: ShiyingEntryStatus;
  dirty: number;
  rejected_at: number | null;
  presented_at: number | null;
  created_at: number;
  updated_at: number;
  payload_version: 1;
};

type CoverageRow = {
  id: string;
  lane: ShiyingLane;
  batch_id: string;
  chunk_id: string;
  chunk_index: number;
  life_date_start: string;
  life_date_end: string;
  window_start_cursor_json: string | null;
  window_end_cursor_json: string;
  input_hash: string;
  contract_version: number;
  outcome: ShiyingCoverageReceiptV1['outcome'];
  executor_device_id: string | null;
  completed_at: number;
  updated_at: number;
  payload_version: 1;
};

type CoverageSourceRow = {
  ordinal: number;
  session_id: string;
  message_id: string;
  role: ShiyingCoverageReceiptV1['sources'][number]['role'];
  message_created_at: number;
  content_hash: string;
};

type CoverageKnowledgeSourceRow = {
  session_id: string;
  message_id: string;
  role: ShiyingRole;
  message_created_at: number;
  content_hash: string;
};

type RunRow = {
  batch_id: string;
  lane: 'live';
  life_date_start: string;
  life_date_end: string;
  window_start_cursor_json: string | null;
  window_end_cursor_json: string;
  status: ShiyingManualRunV1['status'];
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
};

type RunChunkRow = {
  chunk_index: number;
  chunk_id: string;
  operation_id: string;
  input_hash: string;
  overlap_from_previous: number;
  estimated_tokens: number;
  status: ShiyingManualRunV1['chunks'][number]['status'];
  attempt_count: number;
  last_error_code: string | null;
  started_at: number | null;
  completed_at: number | null;
  materials_json: string;
  candidates_json: string | null;
};

function storeError(code: string, id?: string): Error {
  return new Error(id ? `shiying_store_${code}:${id}` : `shiying_store_${code}`);
}

function parseStoredCursor(raw: string, code: string) {
  try {
    return parseShiyingMessageCursorV1(JSON.parse(raw) as unknown);
  } catch {
    throw storeError(code);
  }
}

function parseStoredJson(raw: string, code: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw storeError(code);
  }
}

export async function loadManualRunWithDatabase(
  database: SQLite.SQLiteDatabase,
): Promise<ShiyingManualRunV1 | null> {
  const row = await database.getFirstAsync<RunRow>(
    `SELECT * FROM shiying_runs WHERE lane = 'live' LIMIT 1;`,
  );
  if (!row) return null;
  const chunkRows = await database.getAllAsync<RunChunkRow>(
    `SELECT * FROM shiying_run_chunks
      WHERE run_id = ?
      ORDER BY chunk_index ASC;`,
    row.batch_id,
  );
  return parseShiyingManualRunV1({
    batchId: row.batch_id,
    lane: row.lane,
    lifeDateStart: row.life_date_start,
    lifeDateEnd: row.life_date_end,
    windowStartCursor: row.window_start_cursor_json === null
      ? null
      : parseStoredJson(row.window_start_cursor_json, 'run_start_cursor_corrupt'),
    windowEndCursor: parseStoredJson(row.window_end_cursor_json, 'run_end_cursor_corrupt'),
    status: row.status,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    chunks: chunkRows.map((chunk) => ({
      chunkIndex: chunk.chunk_index,
      chunkId: chunk.chunk_id,
      operationId: chunk.operation_id,
      inputHash: chunk.input_hash,
      overlapFromPrevious: chunk.overlap_from_previous,
      estimatedTokens: chunk.estimated_tokens,
      status: chunk.status,
      attemptCount: chunk.attempt_count,
      lastErrorCode: chunk.last_error_code,
      startedAt: chunk.started_at,
      completedAt: chunk.completed_at,
      materials: parseStoredJson(chunk.materials_json, 'run_materials_corrupt'),
      candidates: chunk.candidates_json === null
        ? null
        : parseStoredJson(chunk.candidates_json, 'run_candidates_corrupt'),
    })),
  });
}

async function insertManualRunWithDatabase(
  database: SQLite.SQLiteDatabase,
  rawRun: ShiyingManualRunV1,
) {
  const run = parseShiyingManualRunV1(rawRun);
  await database.runAsync(
    `INSERT INTO shiying_runs (
       batch_id, lane, life_date_start, life_date_end,
       window_start_cursor_json, window_end_cursor_json,
       status, last_error_code, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    run.batchId,
    run.lane,
    run.lifeDateStart,
    run.lifeDateEnd,
    run.windowStartCursor === null ? null : canonicalJsonV1(run.windowStartCursor),
    canonicalJsonV1(run.windowEndCursor),
    run.status,
    run.lastErrorCode,
    run.createdAt,
    run.updatedAt,
  );
  for (const chunk of run.chunks) {
    await database.runAsync(
      `INSERT INTO shiying_run_chunks (
         run_id, chunk_index, chunk_id, operation_id, input_hash,
         overlap_from_previous, estimated_tokens, status, attempt_count,
         last_error_code, started_at, completed_at, materials_json, candidates_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      run.batchId,
      chunk.chunkIndex,
      chunk.chunkId,
      chunk.operationId,
      chunk.inputHash,
      chunk.overlapFromPrevious,
      chunk.estimatedTokens,
      chunk.status,
      chunk.attemptCount,
      chunk.lastErrorCode,
      chunk.startedAt,
      chunk.completedAt,
      canonicalJsonV1(chunk.materials),
      chunk.candidates === null ? null : canonicalJsonV1(chunk.candidates),
    );
  }
  return run;
}

export async function loadEntryWithDatabase(
  database: SQLite.SQLiteDatabase,
  id: string,
): Promise<ShiyingEntryV1 | null> {
  const row = await database.getFirstAsync<EntryRow>(
    'SELECT * FROM shiying_entries WHERE id = ? LIMIT 1;',
    id,
  );
  if (!row) return null;
  const sourceRows = await database.getAllAsync<EntrySourceRow>(
    `SELECT ordinal, session_id, message_id, role, evidence_kind,
            message_created_at, excerpt_snapshot, evidence_quote, content_hash
       FROM shiying_entry_sources
      WHERE entry_id = ?
      ORDER BY ordinal ASC;`,
    id,
  );
  return parseShiyingEntryV1({
    payloadVersion: row.payload_version,
    id: row.id,
    batchId: row.batch_id,
    lifeDate: row.life_date,
    category: row.category,
    body: row.body,
    eventStartedAt: row.event_started_at,
    eventEndedAt: row.event_ended_at,
    status: row.status,
    editedAt: row.edited_at,
    rejectedAt: row.rejected_at,
    presentedAt: row.presented_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sources: sourceRows.map((source) => ({
      ordinal: source.ordinal,
      sessionId: source.session_id,
      messageId: source.message_id,
      messageCreatedAt: source.message_created_at,
      role: source.role,
      evidenceKind: source.evidence_kind,
      excerptSnapshot: source.excerpt_snapshot,
      evidenceQuote: source.evidence_quote,
      contentHash: source.content_hash,
    })),
  });
}

export async function loadSummaryWithDatabase(
  database: SQLite.SQLiteDatabase,
  id: string,
): Promise<ShiyingSummaryV1 | null> {
  const row = await database.getFirstAsync<SummaryRow>(
    'SELECT * FROM shiying_summaries WHERE id = ? LIMIT 1;',
    id,
  );
  if (!row) return null;
  if (row.payload_version !== 1) throw storeError('summary_version_mismatch', id);
  const sources = await database.getAllAsync<{ ordinal: number; source_id: string; source_kind: string }>(
    `SELECT ordinal, source_id, source_kind
       FROM shiying_summary_sources
      WHERE summary_id = ?
      ORDER BY ordinal ASC;`,
    id,
  );
  if (sources.some((source, index) => source.ordinal !== index || source.source_kind !== 'entry')) {
    throw storeError('summary_source_order_corrupt', id);
  }
  return parseShiyingSummaryV1({
    payloadVersion: row.payload_version,
    id: row.id,
    kind: row.kind,
    periodStartLifeDate: row.period_start_life_date,
    periodEndLifeDate: row.period_end_life_date,
    factSummary: row.fact_summary,
    baiyunNote: row.baiyun_note,
    inputHash: row.input_hash,
    contractVersion: row.contract_version,
    status: row.status,
    dirty: row.dirty === 1,
    rejectedAt: row.rejected_at,
    presentedAt: row.presented_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceEntryIds: sources.map((source) => source.source_id),
  });
}

export async function loadCoverageWithDatabase(
  database: SQLite.SQLiteDatabase,
  id: string,
): Promise<ShiyingCoverageReceiptV1 | null> {
  const row = await database.getFirstAsync<CoverageRow>(
    'SELECT * FROM shiying_coverage_receipts WHERE id = ? LIMIT 1;',
    id,
  );
  if (!row) return null;
  const sources = await database.getAllAsync<CoverageSourceRow>(
    `SELECT ordinal, session_id, message_id, role, message_created_at, content_hash
       FROM shiying_coverage_sources
      WHERE receipt_id = ?
      ORDER BY ordinal ASC;`,
    id,
  );
  return parseShiyingCoverageReceiptV1({
    payloadVersion: row.payload_version,
    id: row.id,
    lane: row.lane,
    batchId: row.batch_id,
    chunkId: row.chunk_id,
    chunkIndex: row.chunk_index,
    lifeDateStart: row.life_date_start,
    lifeDateEnd: row.life_date_end,
    windowStartCursor: row.window_start_cursor_json === null
      ? null
      : parseStoredCursor(row.window_start_cursor_json, 'coverage_start_cursor_corrupt'),
    windowEndCursor: parseStoredCursor(
      row.window_end_cursor_json,
      'coverage_end_cursor_corrupt',
    ),
    inputHash: row.input_hash,
    contractVersion: row.contract_version,
    outcome: row.outcome,
    executorDeviceId: row.executor_device_id,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    sources: sources.map((source) => ({
      ordinal: source.ordinal,
      sessionId: source.session_id,
      messageId: source.message_id,
      messageCreatedAt: source.message_created_at,
      role: source.role,
      contentHash: source.content_hash,
    })),
  });
}

async function insertEntryWithDatabase(
  database: SQLite.SQLiteDatabase,
  rawEntry: ShiyingEntryV1,
) {
  const entry = parseShiyingEntryV1(rawEntry);
  await database.runAsync(
    `INSERT INTO shiying_entries (
       id, batch_id, life_date, category, body, event_started_at, event_ended_at,
       status, edited_at, rejected_at, presented_at, created_at, updated_at,
       payload_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    entry.id,
    entry.batchId,
    entry.lifeDate,
    entry.category,
    entry.body,
    entry.eventStartedAt,
    entry.eventEndedAt,
    entry.status,
    entry.editedAt,
    entry.rejectedAt,
    entry.presentedAt,
    entry.createdAt,
    entry.updatedAt,
    entry.payloadVersion,
  );
  for (const source of entry.sources) {
    await database.runAsync(
      `INSERT INTO shiying_entry_sources (
         entry_id, ordinal, session_id, message_id, role, evidence_kind,
         message_created_at, excerpt_snapshot, evidence_quote, content_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      entry.id,
      source.ordinal,
      source.sessionId,
      source.messageId,
      source.role,
      source.evidenceKind,
      source.messageCreatedAt,
      source.excerptSnapshot,
      source.evidenceQuote,
      source.contentHash,
    );
  }
  await (await import('./shiyingReviewStore')).markShiyingReviewPeriodDirtyWithDatabase(database, 'entry', entry.id, entry.lifeDate);
  return entry;
}

async function insertCoverageWithDatabase(
  database: SQLite.SQLiteDatabase,
  rawCoverage: ShiyingCoverageReceiptV1,
) {
  const coverage = parseShiyingCoverageReceiptV1(rawCoverage);
  await database.runAsync(
    `INSERT INTO shiying_coverage_receipts (
       id, lane, batch_id, chunk_id, chunk_index, life_date_start, life_date_end,
       window_start_cursor_json, window_end_cursor_json, input_hash,
       contract_version, outcome, executor_device_id, completed_at, updated_at,
       payload_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    coverage.id,
    coverage.lane,
    coverage.batchId,
    coverage.chunkId,
    coverage.chunkIndex,
    coverage.lifeDateStart,
    coverage.lifeDateEnd,
    coverage.windowStartCursor === null
      ? null
      : canonicalJsonV1(coverage.windowStartCursor),
    canonicalJsonV1(coverage.windowEndCursor),
    coverage.inputHash,
    coverage.contractVersion,
    coverage.outcome,
    coverage.executorDeviceId,
    coverage.completedAt,
    coverage.updatedAt,
    coverage.payloadVersion,
  );
  for (const source of coverage.sources) {
    await database.runAsync(
      `INSERT INTO shiying_coverage_sources (
         receipt_id, ordinal, session_id, message_id, role,
         message_created_at, content_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
      coverage.id,
      source.ordinal,
      source.sessionId,
      source.messageId,
      source.role,
      source.messageCreatedAt,
      source.contentHash,
    );
  }
  return coverage;
}

function assertEntriesMatchCoverage(
  coverage: ShiyingCoverageReceiptV1,
  entries: readonly ShiyingEntryV1[],
) {
  if (entries.length > 3) throw storeError('entry_limit_exceeded', coverage.id);
  if (
    (coverage.outcome === 'zero' && entries.length !== 0)
    || (coverage.outcome === 'entries' && entries.length < 1)
  ) {
    throw storeError('coverage_outcome_mismatch', coverage.id);
  }
  const coveredSources = new Map(coverage.sources.map((source) => [
    canonicalJsonV1([source.sessionId, source.messageId]),
    source,
  ]));
  for (const entry of entries) {
    if (
      entry.batchId !== coverage.batchId
      || entry.lifeDate < coverage.lifeDateStart
      || entry.lifeDate > coverage.lifeDateEnd
      || entry.status !== 'active'
      || entry.editedAt !== null
      || entry.rejectedAt !== null
      || entry.presentedAt !== null
      || entry.createdAt !== entry.updatedAt
    ) {
      throw storeError('entry_not_new_for_coverage', entry.id);
    }
    for (const source of entry.sources) {
      const covered = coveredSources.get(canonicalJsonV1([source.sessionId, source.messageId]));
      if (!covered || covered.contentHash !== source.contentHash || covered.role !== source.role) {
        throw storeError('entry_source_not_covered', entry.id);
      }
    }
  }
}

function sourceIdentity(source: { sessionId: string; messageId: string }) {
  return canonicalJsonV1([source.sessionId, source.messageId]);
}

function assertRunBatchResult(input: {
  run: ShiyingManualRunV1;
  coverages: readonly ShiyingCoverageReceiptV1[];
  entries: readonly ShiyingEntryV1[];
}) {
  if (input.entries.length > 3) throw storeError('entry_limit_exceeded', input.run.batchId);
  if (input.coverages.length !== input.run.chunks.length) {
    throw storeError('run_coverage_count', input.run.batchId);
  }
  if (input.run.chunks.some((chunk) => chunk.status !== 'completed')) {
    throw storeError('run_not_completed', input.run.batchId);
  }
  const coveredSources = new Map<string, ShiyingCoverageReceiptV1['sources'][number]>();
  input.coverages.forEach((coverage, index) => {
    const chunk = input.run.chunks[index];
    if (
      coverage.batchId !== input.run.batchId
      || coverage.lane !== input.run.lane
      || coverage.chunkIndex !== index
      || coverage.chunkId !== chunk.chunkId
      || coverage.inputHash !== chunk.inputHash
      || coverage.lifeDateStart !== input.run.lifeDateStart
      || coverage.lifeDateEnd !== input.run.lifeDateEnd
      || canonicalJsonV1(coverage.windowStartCursor) !== canonicalJsonV1(input.run.windowStartCursor)
      || canonicalJsonV1(coverage.windowEndCursor) !== canonicalJsonV1(input.run.windowEndCursor)
      || coverage.completedAt !== chunk.completedAt
      || coverage.updatedAt !== chunk.completedAt
    ) {
      throw storeError('run_coverage_mismatch', coverage.id);
    }
    const expectedSources = chunk.materials.map((material, ordinal) => ({
      ordinal,
      sessionId: material.sessionId,
      messageId: material.messageId,
      role: material.role,
      messageCreatedAt: material.messageCreatedAt,
      contentHash: material.contentHash,
    }));
    if (canonicalJsonV1(coverage.sources) !== canonicalJsonV1(expectedSources)) {
      throw storeError('run_coverage_sources', coverage.id);
    }
    coverage.sources.forEach((source) => coveredSources.set(sourceIdentity(source), source));
  });

  for (const entry of input.entries) {
    if (
      entry.batchId !== input.run.batchId
      || entry.lifeDate < input.run.lifeDateStart
      || entry.lifeDate > input.run.lifeDateEnd
      || entry.status !== 'active'
      || entry.editedAt !== null
      || entry.rejectedAt !== null
      || entry.presentedAt !== null
      || entry.createdAt !== entry.updatedAt
    ) {
      throw storeError('entry_not_new_for_run', entry.id);
    }
    for (const source of entry.sources) {
      const covered = coveredSources.get(sourceIdentity(source));
      if (!covered || covered.contentHash !== source.contentHash || covered.role !== source.role) {
        throw storeError('entry_source_not_covered', entry.id);
      }
    }
  }

  for (const coverage of input.coverages) {
    const coverageSourceIds = new Set(coverage.sources.map(sourceIdentity));
    const hasSelectedSource = input.entries.some((entry) => (
      entry.sources.some((source) => coverageSourceIds.has(sourceIdentity(source)))
    ));
    if (coverage.outcome !== (hasSelectedSource ? 'entries' : 'zero')) {
      throw storeError('run_coverage_outcome', coverage.id);
    }
  }
}

export async function markShiyingFactDependentsDirty(
  database: SQLite.SQLiteDatabase,
  kind: 'entry' | 'record',
  id: string,
  updatedAt: number,
) {
  await (await import('./shiyingSummaryStore')).markShiyingSummaryDependentsDirtyWithDatabase(database, kind, id, updatedAt, { invalidated: true });
  const source = await database.getFirstAsync<{ date: string }>(kind === 'entry'
    ? 'SELECT life_date AS date FROM shiying_entries WHERE id=?;'
    : 'SELECT record_date AS date FROM shiying_records WHERE id=?;', id);
  if (source) await (await import('./shiyingReviewStore')).markShiyingReviewPeriodDirtyWithDatabase(database, kind, id, source.date);
  await database.runAsync(
    `UPDATE shiying_summaries
        SET dirty = 1,
            updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
      WHERE status = 'active'
        AND id IN (
          SELECT summary_id
            FROM shiying_summary_sources
           WHERE source_kind = ? AND source_id = ?
        );`,
    updatedAt,
    updatedAt,
    kind,
    id,
  );
  await database.runAsync(
    `UPDATE shiying_events SET dirty = 1,
       updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
       WHERE id IN (SELECT n.event_id FROM shiying_event_nodes n
         JOIN shiying_event_node_sources s ON s.node_id = n.id
         WHERE s.source_kind = ? AND s.source_id = ?);`,
    updatedAt, updatedAt, kind, id,
  );
}

export function commitShiyingCoverageResult(input: {
  coverage: ShiyingCoverageReceiptV1;
  entries: readonly ShiyingEntryV1[];
}) {
  const coverage = parseShiyingCoverageReceiptV1(input.coverage);
  const entries = input.entries.map(parseShiyingEntryV1);
  assertEntriesMatchCoverage(coverage, entries);
  return runShiyingTransaction(async (database) => {
    const existing = await loadCoverageWithDatabase(database, coverage.id);
    if (existing) {
      if (
        serializeShiyingCoverageReceiptV1(existing)
        !== serializeShiyingCoverageReceiptV1(coverage)
      ) {
        throw storeError('coverage_conflict', coverage.id);
      }
      return { coverage: existing, entries: [] as ShiyingEntryV1[], replayed: true };
    }
    await insertCoverageWithDatabase(database, coverage);
    const insertedEntries: ShiyingEntryV1[] = [];
    for (const entry of entries) {
      insertedEntries.push(await insertEntryWithDatabase(database, entry));
    }
    return { coverage, entries: insertedEntries, replayed: false };
  }).then(result => { notifyShiyingEntryChanges(); return result; });
}

export function getShiyingManualRun() {
  return runShiyingDatabaseOperation(loadManualRunWithDatabase);
}

export async function createShiyingManualRun(
  rawRun: ShiyingManualRunV1,
  automatic?: { nightLifeDate: string },
) {
  const run = parseShiyingManualRunV1(rawRun);
  const result = await runShiyingTransaction(async (database) => {
    if (await database.getFirstAsync("SELECT id FROM shiying_backfill_tasks WHERE status='running';")) {
      throw storeError('backfill_running');
    }
    const existing = await loadManualRunWithDatabase(database);
    if (existing) {
      if (canonicalJsonV1(existing) !== canonicalJsonV1(run)) {
        throw storeError('run_already_exists', existing.batchId);
      }
      return existing;
    }
    if (automatic && !await bindShiyingAutomaticBatchInTransaction(database, {
      batchId: run.batchId, nightLifeDate: automatic.nightLifeDate, at: run.updatedAt,
    })) throw storeError('automatic_not_permitted', run.batchId);
    return insertManualRunWithDatabase(database, run);
  });
  if (automatic) notifyShiyingAutomaticStateChanged();
  return result;
}

/** Reservation and in-flight marker either commit together or both roll back. */
export async function startShiyingAutomaticRunChunk(input: {
  batchId: string; chunkIndex: number; nightLifeDate: string; startedAt: number;
}) {
  assertShiyingDeterministicId(input.batchId, 'batch');
  if (!Number.isSafeInteger(input.startedAt) || input.startedAt < 0
    || !Number.isSafeInteger(input.chunkIndex) || input.chunkIndex < 0) {
    throw storeError('automatic_started_at', input.batchId);
  }
  const result = await runShiyingTransaction(async (database) => {
    const run = await loadManualRunWithDatabase(database);
    if (!run || run.batchId !== input.batchId) throw storeError('run_missing', input.batchId);
    const chunk = run.chunks[input.chunkIndex];
    if (run.status !== 'pending' || !chunk || chunk.status !== 'pending') {
      throw storeError('automatic_chunk_not_pending', input.batchId);
    }
    if (!await reserveShiyingAutomaticCallInTransaction(database, {
      batchId: input.batchId, nightLifeDate: input.nightLifeDate, at: input.startedAt,
    })) return null;
    const next: ShiyingManualRunV1 = { ...run, updatedAt: Math.max(run.updatedAt, input.startedAt),
      chunks: run.chunks.map(item => item.chunkIndex !== input.chunkIndex ? item : {
        ...item, status: 'in_flight', attemptCount: item.attemptCount + 1,
        lastErrorCode: null, startedAt: input.startedAt, completedAt: null, candidates: null,
      }) };
    await database.runAsync('DELETE FROM shiying_runs WHERE batch_id = ?;', run.batchId);
    return insertManualRunWithDatabase(database, next);
  });
  if (result) notifyShiyingAutomaticStateChanged();
  return result;
}

/** Only called when the request adapter has not been entered at all. Never used after a crash. */
export async function cancelShiyingAutomaticRunChunkBeforeRequest(input: {
  batchId: string; chunkIndex: number; nightLifeDate: string; startedAt: number; at: number;
}): Promise<ShiyingManualRunV1> {
  const result = await runShiyingTransaction(async database => {
    const run = await loadManualRunWithDatabase(database);
    const chunk = run?.chunks[input.chunkIndex];
    if (!run || run.batchId !== input.batchId || !chunk
      || chunk.status !== 'in_flight' || chunk.startedAt !== input.startedAt) {
      throw storeError('automatic_cancel_conflict', input.batchId);
    }
    await releaseShiyingAutomaticCallBeforeRequestInTransaction(database, {
      batchId: input.batchId, nightLifeDate: input.nightLifeDate, at: input.at,
    });
    const next: ShiyingManualRunV1 = { ...run, updatedAt: Math.max(run.updatedAt, input.at),
      chunks: run.chunks.map(item => item.chunkIndex !== input.chunkIndex ? item : {
        ...item, status: 'pending', attemptCount: item.attemptCount - 1, startedAt: null,
      }) };
    await database.runAsync('DELETE FROM shiying_runs WHERE batch_id = ?;', run.batchId);
    return insertManualRunWithDatabase(database, next);
  });
  notifyShiyingAutomaticStateChanged();
  return result;
}

export function replaceShiyingManualRun(rawRun: ShiyingManualRunV1) {
  const run = parseShiyingManualRunV1(rawRun);
  return runShiyingTransaction(async (database) => {
    const existing = await loadManualRunWithDatabase(database);
    if (!existing) throw storeError('run_missing', run.batchId);
    if (existing.batchId !== run.batchId) throw storeError('run_conflict', run.batchId);
    if (run.createdAt !== existing.createdAt || run.updatedAt < existing.updatedAt) {
      throw storeError('run_time_regression', run.batchId);
    }
    await database.runAsync('DELETE FROM shiying_runs WHERE batch_id = ?;', run.batchId);
    return insertManualRunWithDatabase(database, run);
  });
}

export type ShiyingRunChunkSaveInput = {
  batchId: string;
  chunkIndex: number;
  chunkId: string;
  inputHash: string;
  attemptCount: number;
  startedAt: number | null;
  completedAt: number;
  candidates: ShiyingRunCandidateV1[];
};

// The response belongs to one exact request attempt, never to a newer attempt or basket.
export function saveShiyingManualRunChunkResult(input: ShiyingRunChunkSaveInput) {
  return runShiyingTransaction(async (database) => {
    const existing = await loadManualRunWithDatabase(database);
    if (!existing || existing.batchId !== input.batchId) throw storeError('run_missing', input.batchId);
    const chunk = existing.chunks[input.chunkIndex];
    if (!chunk || chunk.chunkId !== input.chunkId || chunk.inputHash !== input.inputHash
      || chunk.attemptCount !== input.attemptCount || chunk.startedAt !== input.startedAt) {
      throw storeError('run_chunk_attempt_conflict', input.batchId);
    }
    if (chunk.status === 'completed') {
      if (chunk.completedAt !== input.completedAt || canonicalJsonV1(chunk.candidates) !== canonicalJsonV1(input.candidates)) {
        throw storeError('run_chunk_result_conflict', input.batchId);
      }
      return existing;
    }
    if (chunk.status !== 'in_flight') throw storeError('run_chunk_attempt_conflict', input.batchId);
    const next = parseShiyingManualRunV1({
      ...existing, status: 'pending', lastErrorCode: null,
      updatedAt: Math.max(existing.updatedAt, input.completedAt),
      chunks: existing.chunks.map((item) => item.chunkIndex === input.chunkIndex ? {
        ...item, status: 'completed', lastErrorCode: null,
        completedAt: input.completedAt, candidates: input.candidates,
      } : item),
    });
    await database.runAsync('DELETE FROM shiying_runs WHERE batch_id = ?;', existing.batchId);
    return insertManualRunWithDatabase(database, next);
  });
}

export async function abandonShiyingManualRun(batchId: string) {
  assertShiyingDeterministicId(batchId, 'batch');
  const result = await runShiyingTransaction(async (database) => {
    const existing = await loadManualRunWithDatabase(database);
    if (!existing) return false;
    if (existing.batchId !== batchId) throw storeError('run_conflict', batchId);
    await database.runAsync('DELETE FROM shiying_runs WHERE batch_id = ?;', batchId);
    await closeShiyingAutomaticBatchInTransaction(database, { batchId, at: Math.max(existing.updatedAt, Date.now()) });
    return true;
  });
  if (result) notifyShiyingAutomaticStateChanged();
  return result;
}

export async function commitShiyingManualRunResult(input: {
  batchId: string;
  coverages: readonly ShiyingCoverageReceiptV1[];
  entries: readonly ShiyingEntryV1[];
}) {
  assertShiyingDeterministicId(input.batchId, 'batch');
  const coverages = input.coverages.map(parseShiyingCoverageReceiptV1);
  const entries = input.entries.map(parseShiyingEntryV1);
  const result = await runShiyingTransaction(async (database) => {
    if (!coverages.length || coverages.some((item) => item.batchId !== input.batchId)
      || entries.some((item) => item.batchId !== input.batchId)
      || new Set(coverages.map((item) => item.id)).size !== coverages.length
      || new Set(entries.map((item) => item.id)).size !== entries.length) {
      throw storeError('run_result_identity', input.batchId);
    }
    const existingCoverages = await Promise.all(coverages.map((item) => loadCoverageWithDatabase(database, item.id)));
    if (existingCoverages.some(Boolean)) {
      const receiptCount = await database.getFirstAsync<{ count: number }>(
        'SELECT COUNT(*) AS count FROM shiying_coverage_receipts WHERE batch_id = ?;', input.batchId);
      if (receiptCount?.count !== coverages.length || existingCoverages.some((item, index) => !item
        || serializeShiyingCoverageReceiptV1(item) !== serializeShiyingCoverageReceiptV1(coverages[index]))) {
        throw storeError('coverage_conflict', input.batchId);
      }
      const currentEntries: ShiyingEntryV1[] = [];
      for (const entry of entries) {
        const current = await loadEntryWithDatabase(database, entry.id);
        if (!current || current.batchId !== input.batchId) throw storeError('entry_replay_conflict', entry.id);
        currentEntries.push(current);
      }
      // A lost acknowledgement must not overwrite edits, rejection, presentation or a newer run.
      await closeShiyingAutomaticBatchInTransaction(database, {
        batchId: input.batchId, at: Math.max(...coverages.map(item => item.completedAt)),
      });
      return { coverages: existingCoverages as ShiyingCoverageReceiptV1[], entries: currentEntries };
    }
    const run = await loadManualRunWithDatabase(database);
    if (!run || run.batchId !== input.batchId) throw storeError('run_missing', input.batchId);
    assertRunBatchResult({ run, coverages, entries });
    for (const coverage of coverages) {
      if (await loadCoverageWithDatabase(database, coverage.id)) {
        throw storeError('coverage_conflict', coverage.id);
      }
    }
    for (const coverage of coverages) await insertCoverageWithDatabase(database, coverage);
    const insertedEntries: ShiyingEntryV1[] = [];
    for (const entry of entries) {
      insertedEntries.push(await insertEntryWithDatabase(database, entry));
    }
    await database.runAsync('DELETE FROM shiying_runs WHERE batch_id = ?;', run.batchId);
    await closeShiyingAutomaticBatchInTransaction(database, {
      batchId: run.batchId, at: Math.max(run.updatedAt, ...coverages.map(item => item.completedAt)),
    });
    return { coverages, entries: insertedEntries };
  });
  notifyShiyingAutomaticStateChanged();
  notifyShiyingEntryChanges();
  return result;
}

/** Read-only acknowledgement check for the in-process recovery banner. Writes still reconcile atomically above. */
export function isShiyingManualRunResultCommitted(input: {
  batchId: string; coverages: readonly ShiyingCoverageReceiptV1[]; entries: readonly ShiyingEntryV1[];
}) {
  return runShiyingDatabaseOperation(async database => {
    const count = await database.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM shiying_coverage_receipts WHERE batch_id = ?;', input.batchId);
    if (!input.coverages.length || count?.count !== input.coverages.length) return false;
    for (const coverage of input.coverages) {
      const current = await loadCoverageWithDatabase(database, coverage.id);
      if (!current || serializeShiyingCoverageReceiptV1(current) !== serializeShiyingCoverageReceiptV1(coverage)) return false;
    }
    for (const entry of input.entries) {
      const current = await loadEntryWithDatabase(database, entry.id);
      if (!current || current.batchId !== input.batchId) return false;
    }
    return true;
  });
}

/** Caller owns the domain transaction. Reconcile only this backfill attempt's receipt set. */
export async function commitShiyingBackfillDayWithDatabase(database: SQLite.SQLiteDatabase, input: {
  batchId: string; lifeDate: string;
  coverages: readonly ShiyingCoverageReceiptV1[]; entries: readonly ShiyingEntryV1[];
}) {
  assertShiyingLifeDate(input.lifeDate, 'backfill_date');
  const coverages = input.coverages.map(parseShiyingCoverageReceiptV1);
  const entries = input.entries.map(parseShiyingEntryV1);
  if (!coverages.length || entries.length > 3
    || new Set(coverages.map(item => item.id)).size !== coverages.length
    || new Set(entries.map(item => item.id)).size !== entries.length
    || coverages.some(item => item.lane !== 'backfill' || item.batchId !== input.batchId
      || item.lifeDateStart !== input.lifeDate || item.lifeDateEnd !== input.lifeDate)
    || entries.some(item => item.batchId !== input.batchId || item.lifeDate !== input.lifeDate)) {
    throw storeError('backfill_result_identity');
  }
  const existing = await Promise.all(coverages.map(item => loadCoverageWithDatabase(database, item.id)));
  if (existing.some(Boolean)) {
    if (existing.some((item, index) => !item || serializeShiyingCoverageReceiptV1(item)
      !== serializeShiyingCoverageReceiptV1(coverages[index]))) throw storeError('coverage_conflict', input.batchId);
    const current: ShiyingEntryV1[] = [];
    for (const entry of entries) {
      const value = await loadEntryWithDatabase(database, entry.id);
      if (!value || value.batchId !== input.batchId) throw storeError('entry_replay_conflict', entry.id);
      current.push(value);
    }
    return current;
  }
  const sources = new Map(coverages.flatMap(item => item.sources).map(source => [sourceIdentity(source), source]));
  for (const entry of entries) {
    if (entry.status !== 'active' || entry.editedAt !== null || entry.rejectedAt !== null
      || entry.presentedAt !== null || entry.updatedAt !== entry.createdAt) throw storeError('entry_not_new_for_run', entry.id);
    for (const source of entry.sources) {
      const covered = sources.get(sourceIdentity(source));
      if (!covered || covered.contentHash !== source.contentHash || covered.role !== source.role
        || covered.messageCreatedAt !== source.messageCreatedAt) throw storeError('entry_source_not_covered', entry.id);
    }
  }
  for (const coverage of coverages) {
    const ids = new Set(coverage.sources.map(sourceIdentity));
    const selected = entries.some(entry => entry.sources.some(source => ids.has(sourceIdentity(source))));
    if (coverage.outcome !== (selected ? 'entries' : 'zero')) throw storeError('run_coverage_outcome', coverage.id);
    await insertCoverageWithDatabase(database, coverage);
  }
  const inserted: ShiyingEntryV1[] = [];
  for (const entry of entries) inserted.push(await insertEntryWithDatabase(database, entry));
  return inserted;
}

export function getShiyingEntryById(id: string) {
  assertShiyingUuidV4(id, 'entry_lookup_id');
  return runShiyingDatabaseOperation((database) => loadEntryWithDatabase(database, id));
}

export type ListShiyingEntriesOptions = {
  lifeDate?: string;
  status?: ShiyingEntryStatus | 'all';
  pendingOnly?: boolean;
  batchId?: string;
};

export type ShiyingLifeDateGroup = {
  lifeDate: string;
  activeCount: number;
};

export type ShiyingLifeDatePage = {
  groups: ShiyingLifeDateGroup[];
  nextBeforeLifeDate: string | null;
};

export type ListShiyingLifeDateGroupsOptions = {
  beforeLifeDate?: string;
  limit?: number;
};

export function listShiyingEntries(options: ListShiyingEntriesOptions = {}) {
  if (options.lifeDate !== undefined) {
    assertShiyingLifeDate(options.lifeDate, 'entry_list_life_date');
  }
  if (
    options.status !== undefined
    && options.status !== 'active'
    && options.status !== 'rejected'
    && options.status !== 'all'
  ) {
    throw storeError('entry_list_status');
  }
  if (options.batchId !== undefined) {
    assertShiyingDeterministicId(options.batchId, 'batch');
  }
  return runShiyingDatabaseOperation(async (database) => {
    const clauses: string[] = [];
    const parameters: SQLite.SQLiteBindValue[] = [];
    const status = options.status ?? 'active';
    if (status !== 'all') {
      clauses.push('status = ?');
      parameters.push(status);
    }
    if (options.lifeDate !== undefined) {
      clauses.push('life_date = ?');
      parameters.push(options.lifeDate);
    }
    if (options.pendingOnly) clauses.push('presented_at IS NULL');
    if (options.batchId !== undefined) {
      clauses.push('batch_id = ?');
      parameters.push(options.batchId);
    }
    const rows = await database.getAllAsync<{ id: string }>(
      `SELECT id FROM shiying_entries
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY life_date DESC, event_started_at DESC, id DESC;`,
      parameters,
    );
    const entries: ShiyingEntryV1[] = [];
    for (const row of rows) {
      const entry = await loadEntryWithDatabase(database, row.id);
      if (entry) entries.push(entry);
    }
    return entries;
  });
}

export function listShiyingLifeDateGroups(
  options: ListShiyingLifeDateGroupsOptions = {},
) {
  if (options.beforeLifeDate !== undefined) {
    assertShiyingLifeDate(options.beforeLifeDate, 'entry_group_before_life_date');
  }
  const limit = options.limit ?? 30;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw storeError('entry_group_limit');
  }

  return runShiyingDatabaseOperation(async (database): Promise<ShiyingLifeDatePage> => {
    const rows = await database.getAllAsync<{
      life_date: string;
      active_count: number;
    }>(
      `SELECT life_date, COUNT(*) AS active_count
         FROM shiying_entries
        WHERE status = 'active'
          ${options.beforeLifeDate === undefined ? '' : 'AND life_date < ?'}
        GROUP BY life_date
        ORDER BY life_date DESC
        LIMIT ?;`,
      ...(options.beforeLifeDate === undefined ? [] : [options.beforeLifeDate]),
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const groups = rows.slice(0, limit).map((row) => {
      assertShiyingLifeDate(row.life_date, 'entry_group_life_date');
      if (!Number.isSafeInteger(row.active_count) || row.active_count < 1) {
        throw storeError('entry_group_count');
      }
      return {
        lifeDate: row.life_date,
        activeCount: row.active_count,
      };
    });
    return {
      groups,
      nextBeforeLifeDate: hasMore ? groups.at(-1)?.lifeDate ?? null : null,
    };
  });
}

export function replaceShiyingEntryBody(input: {
  id: string;
  body: string;
  editedAt: number;
  expectedContentHash?: string;
}) {
  assertShiyingUuidV4(input.id, 'entry_edit_id');
  if (input.expectedContentHash !== undefined) {
    assertShiyingHash(input.expectedContentHash, 'entry_edit_expected_hash');
  }
  return runShiyingTransaction(async (database) => {
    const current = await loadEntryWithDatabase(database, input.id);
    if (!current) throw storeError('entry_not_found', input.id);
    if (current.status === 'rejected') throw storeError('entry_rejected', input.id);
    if (input.expectedContentHash !== undefined
      && createShiyingEntryFactContentHash(current) !== input.expectedContentHash) {
      throw storeError('entry_content_conflict', input.id);
    }
    if (current.body === input.body) return current;
    const next = parseShiyingEntryV1({
      ...current,
      body: input.body,
      editedAt: input.editedAt,
      updatedAt: input.editedAt,
    });
    if (input.editedAt < current.updatedAt) throw storeError('entry_time_regression', input.id);
    await database.runAsync(
      `UPDATE shiying_entries
          SET body = ?, edited_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active';`,
      next.body,
      next.editedAt,
      next.updatedAt,
      next.id,
    );
    await markShiyingFactDependentsDirty(database, 'entry', next.id, next.updatedAt);
    return next;
  });
}

/** The editor keeps its opening version and restore epoch, including after a failed save. */
export function createShiyingEntryEditorSave(entry: ShiyingEntryV1, ports: {
  captureEpoch?: typeof captureBackupRestoreDataEpoch;
  protect?: typeof runBackupRestoreDataEpochCommit;
  replace?: typeof replaceShiyingEntryBody;
  now?: () => number;
} = {}) {
  const snapshot = parseShiyingEntryV1(entry);
  const expectedContentHash = createShiyingEntryFactContentHash(snapshot);
  const epoch = (ports.captureEpoch ?? captureBackupRestoreDataEpoch)();
  return async (body: string): Promise<ShiyingEntryV1> => {
    const result = await (ports.protect ?? runBackupRestoreDataEpochCommit)(epoch, () => (
      (ports.replace ?? replaceShiyingEntryBody)({
        id: snapshot.id,
        body,
        expectedContentHash,
        editedAt: Math.max((ports.now ?? Date.now)(), snapshot.updatedAt),
      })
    ));
    if (!result.committed) throw new Error('shiying_entry_restore_changed');
    return result.value;
  };
}

export function rejectShiyingEntry(input: { id: string; rejectedAt: number }) {
  assertShiyingUuidV4(input.id, 'entry_reject_id');
  return runShiyingTransaction(async (database) => {
    const current = await loadEntryWithDatabase(database, input.id);
    if (!current) throw storeError('entry_not_found', input.id);
    if (current.status === 'rejected') return current;
    if (input.rejectedAt < current.updatedAt) throw storeError('entry_time_regression', input.id);
    const next = parseShiyingEntryV1({
      ...current,
      status: 'rejected',
      rejectedAt: input.rejectedAt,
      updatedAt: input.rejectedAt,
    });
    await database.runAsync(
      `UPDATE shiying_entries
          SET status = 'rejected', rejected_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active';`,
      next.rejectedAt,
      next.updatedAt,
      next.id,
    );
    await markShiyingFactDependentsDirty(database, 'entry', next.id, next.updatedAt);
    return next;
  }).then(result => { notifyShiyingEntryChanges(); return result; });
}

export function markShiyingEntriesPresented(input: {
  entryIds: readonly string[];
  presentedAt: number;
}) {
  if (new Set(input.entryIds).size !== input.entryIds.length) {
    throw storeError('entry_present_duplicate');
  }
  input.entryIds.forEach((id) => assertShiyingUuidV4(id, 'entry_present_id'));
  return runShiyingTransaction(async (database) => {
    const entries: ShiyingEntryV1[] = [];
    for (const id of input.entryIds) {
      const current = await loadEntryWithDatabase(database, id);
      if (!current) throw storeError('entry_not_found', id);
      if (current.status !== 'active') throw storeError('entry_rejected', id);
      if (current.presentedAt !== null) {
        entries.push(current);
        continue;
      }
      if (input.presentedAt < current.updatedAt) throw storeError('entry_time_regression', id);
      const next = parseShiyingEntryV1({
        ...current,
        presentedAt: input.presentedAt,
        updatedAt: input.presentedAt,
      });
      await database.runAsync(
        `UPDATE shiying_entries
            SET presented_at = ?, updated_at = ?
          WHERE id = ? AND presented_at IS NULL AND status = 'active';`,
        next.presentedAt,
        next.updatedAt,
        next.id,
      );
      entries.push(next);
    }
    return entries;
  }).then(result => { notifyShiyingEntryChanges(); return result; });
}

export function saveShiyingSummary(rawSummary: ShiyingSummaryV1) {
  const summary = parseShiyingSummaryV1(rawSummary);
  return runShiyingTransaction(async (database) => {
    const existing = await loadSummaryWithDatabase(database, summary.id);
    if (existing) {
      if (serializeShiyingSummaryV1(existing) !== serializeShiyingSummaryV1(summary)) {
        throw storeError('summary_conflict', summary.id);
      }
      return existing;
    }
    for (const entryId of summary.sourceEntryIds) {
      const entry = await loadEntryWithDatabase(database, entryId);
      if (!entry || entry.status !== 'active') {
        throw storeError('summary_source_unavailable', entryId);
      }
    }
    await database.runAsync(
      `INSERT INTO shiying_summaries (
         id, kind, period_start_life_date, period_end_life_date,
         fact_summary, baiyun_note, input_hash, contract_version, status, dirty,
         rejected_at, presented_at, created_at, updated_at, payload_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      summary.id,
      summary.kind,
      summary.periodStartLifeDate,
      summary.periodEndLifeDate,
      summary.factSummary,
      summary.baiyunNote,
      summary.inputHash,
      summary.contractVersion,
      summary.status,
      summary.dirty ? 1 : 0,
      summary.rejectedAt,
      summary.presentedAt,
      summary.createdAt,
      summary.updatedAt,
      summary.payloadVersion,
    );
    for (let ordinal = 0; ordinal < summary.sourceEntryIds.length; ordinal += 1) {
      await database.runAsync(
        `INSERT INTO shiying_summary_sources
          (summary_id, ordinal, source_kind, source_id, content_hash, image_ids_json)
         VALUES (?, ?, 'entry', ?, NULL, '[]');`,
        summary.id,
        ordinal,
        summary.sourceEntryIds[ordinal],
      );
    }
    return summary;
  });
}

export function getShiyingSummaryById(id: string) {
  assertShiyingDeterministicId(id, 'summary');
  return runShiyingDatabaseOperation((database) => loadSummaryWithDatabase(database, id));
}

export function rejectShiyingSummary(input: { id: string; rejectedAt: number }) {
  assertShiyingDeterministicId(input.id, 'summary');
  return runShiyingTransaction(async (database) => {
    const current = await loadSummaryWithDatabase(database, input.id);
    if (!current) throw storeError('summary_not_found', input.id);
    if (current.status === 'rejected') return current;
    if (input.rejectedAt < current.updatedAt) throw storeError('summary_time_regression', input.id);
    const next = parseShiyingSummaryV1({
      ...current,
      status: 'rejected',
      rejectedAt: input.rejectedAt,
      updatedAt: input.rejectedAt,
    });
    await database.runAsync(
      `UPDATE shiying_summaries
          SET status = 'rejected', rejected_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active';`,
      next.rejectedAt,
      next.updatedAt,
      next.id,
    );
    return next;
  });
}

export function markShiyingSummaryPresented(input: { id: string; presentedAt: number }) {
  assertShiyingDeterministicId(input.id, 'summary');
  return runShiyingTransaction(async (database) => {
    const current = await loadSummaryWithDatabase(database, input.id);
    if (!current) throw storeError('summary_not_found', input.id);
    if (current.status !== 'active') throw storeError('summary_rejected', input.id);
    if (current.presentedAt !== null) return current;
    if (input.presentedAt < current.updatedAt) throw storeError('summary_time_regression', input.id);
    const next = parseShiyingSummaryV1({
      ...current,
      presentedAt: input.presentedAt,
      updatedAt: input.presentedAt,
    });
    await database.runAsync(
      `UPDATE shiying_summaries
          SET presented_at = ?, updated_at = ?
        WHERE id = ? AND presented_at IS NULL AND status = 'active';`,
      next.presentedAt,
      next.updatedAt,
      next.id,
    );
    return next;
  });
}

export function getShiyingCoverageReceiptById(id: string) {
  assertShiyingDeterministicId(id, 'coverage');
  return runShiyingDatabaseOperation((database) => loadCoverageWithDatabase(database, id));
}

export function isShiyingSourceCovered(input: {
  lane: ShiyingLane;
  sessionId: string;
  messageId: string;
  contentHash: string;
}) {
  if (input.lane !== 'live' && input.lane !== 'backfill') throw storeError('coverage_lane');
  if (!input.sessionId || !input.messageId) throw storeError('coverage_source_identity');
  assertShiyingHash(input.contentHash, 'coverage_source_lookup_hash');
  return runShiyingDatabaseOperation(async (database) => {
    const row = await database.getFirstAsync<{ covered: number }>(
      `SELECT 1 AS covered
         FROM shiying_coverage_sources AS sources
         JOIN shiying_coverage_receipts AS receipts
           ON receipts.id = sources.receipt_id
        WHERE receipts.lane = ?
          AND sources.session_id = ?
          AND sources.message_id = ?
          AND sources.content_hash = ?
        LIMIT 1;`,
      input.lane,
      input.sessionId,
      input.messageId,
      input.contentHash,
    );
    return row?.covered === 1;
  });
}

export type ShiyingCoverageKnowledgeV1 = {
  firstLiveLifeDate: string | null;
  latestLiveEndCursor: ShiyingMessageCursorV1 | null;
  coveredSources: Array<{
    sessionId: string;
    messageId: string;
    role: ShiyingRole;
    messageCreatedAt: number;
    contentHash: string;
  }>;
};

export function getShiyingCoverageKnowledge(input: {
  messageCreatedAtStart: number;
  messageCreatedAtEnd: number;
}) {
  if (
    !Number.isSafeInteger(input.messageCreatedAtStart)
    || input.messageCreatedAtStart < 0
    || !Number.isSafeInteger(input.messageCreatedAtEnd)
    || input.messageCreatedAtEnd < input.messageCreatedAtStart
  ) {
    throw storeError('coverage_knowledge_range');
  }

  return runShiyingDatabaseOperation(async (database): Promise<ShiyingCoverageKnowledgeV1> => {
    const liveRows = await database.getAllAsync<{
      life_date_start: string;
      window_end_cursor_json: string;
    }>(
      `SELECT life_date_start, window_end_cursor_json
         FROM shiying_coverage_receipts
        WHERE lane = 'live';`,
    );

    let firstLiveLifeDate: string | null = null;
    let latestLiveEndCursor: ShiyingMessageCursorV1 | null = null;
    for (const row of liveRows) {
      assertShiyingLifeDate(row.life_date_start, 'coverage_knowledge_life_date');
      const cursor = parseStoredCursor(
        row.window_end_cursor_json,
        'coverage_knowledge_cursor_corrupt',
      );
      if (firstLiveLifeDate === null || row.life_date_start < firstLiveLifeDate) {
        firstLiveLifeDate = row.life_date_start;
      }
      if (
        latestLiveEndCursor === null
        || compareShiyingMessageCursor(cursor, latestLiveEndCursor) > 0
      ) {
        latestLiveEndCursor = cursor;
      }
    }

    const sourceRows = await database.getAllAsync<CoverageKnowledgeSourceRow>(
      `SELECT DISTINCT
              sources.session_id,
              sources.message_id,
              sources.role,
              sources.message_created_at,
              sources.content_hash
         FROM shiying_coverage_sources AS sources
         JOIN shiying_coverage_receipts AS receipts
           ON receipts.id = sources.receipt_id
        WHERE sources.message_created_at >= ?
          AND sources.message_created_at <= ?;`,
      input.messageCreatedAtStart,
      input.messageCreatedAtEnd,
    );
    const coveredSources = sourceRows.map((row) => {
      if (
        !row.session_id
        || row.session_id !== row.session_id.trim()
        || !row.message_id
        || row.message_id !== row.message_id.trim()
        || (row.role !== 'I' && row.role !== 'you')
        || !Number.isSafeInteger(row.message_created_at)
        || row.message_created_at < 0
      ) {
        throw storeError('coverage_knowledge_source_corrupt');
      }
      assertShiyingHash(row.content_hash, 'coverage_knowledge_source_hash');
      return {
        sessionId: row.session_id,
        messageId: row.message_id,
        role: row.role,
        messageCreatedAt: row.message_created_at,
        contentHash: row.content_hash,
      };
    }).sort((left, right) => (
      compareShiyingMessageCursor(left, right)
      || (left.role < right.role ? -1 : left.role > right.role ? 1 : 0)
      || (left.contentHash < right.contentHash ? -1 : left.contentHash > right.contentHash ? 1 : 0)
    ));

    return { firstLiveLifeDate, latestLiveEndCursor, coveredSources };
  });
}
