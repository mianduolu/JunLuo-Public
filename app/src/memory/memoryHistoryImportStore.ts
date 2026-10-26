import type { AiConnection } from '../ai/types';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import type { MemoryCandidateReview } from './memoryCandidateReview';
import { appendMemoryCandidateReviews, memoryCandidateEditableHash } from './memoryCandidateReview';
import { runMemoryCandidateSave } from './memoryIngestionService';
import { loadPendingMemoryCandidatesWithDatabase, updatePendingMemoryCandidatesWithDatabase } from './memoryCandidatePersistence';
import { runMemoryDuplicateCleanupBusinessWrite } from './memoryDuplicateCleanupState';
import {
  beginMemoryIngestionBatchWithDatabase, loadMemoryIngestionBatchWithDatabase,
  markMemoryIngestionBatchFailedWithDatabase, registerMemoryIngestionOutcomeWithDatabase,
  resolveMemoryIngestionItemsWithDatabase,
} from './memoryIngestionLedger';
import { generateHistoryImportCandidates, HISTORY_IMPORT_CHUNKS_PER_RUN, type HistoryImportChunk, type HistoryImportPreview } from './memoryHistoryImport';
import { createMemory, deriveMemoryTitle, getMemoryDatabase } from './memoryStore';
import { notifyMemoryProcessingUpdated } from './memoryProcessingSignals';

export type HistoryImportCandidate = MemoryCandidateReview & {
  duplicateHint?: string;
  historyImportId: string;
  historyChunkIndex: number;
  fileName: string;
};

export type HistoryImportDocument = {
  id: string; fileName: string; chunkCount: number; completedChunks: number;
  remainingChunks: number; failedChunks: number; running: boolean;
};

type ImportRow = { id: string; file_name: string; original_content: string; chunks_json: string };
const listeners = new Set<() => void>();
const flights = new Map<string, Promise<void>>();
let writes: Promise<unknown> = Promise.resolve();

async function databaseForImport() {
  const database = await getMemoryDatabase('ingestion');
  await database.execAsync(`CREATE TABLE IF NOT EXISTS memory_history_imports (
    id TEXT PRIMARY KEY NOT NULL, file_name TEXT NOT NULL, original_content TEXT NOT NULL,
    chunks_json TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  return database;
}

function publish() { notifyMemoryProcessingUpdated(); for (const listener of listeners) { try { listener(); } catch { /* A committed import stays committed. */ } } }

export function subscribeHistoryImports(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function write<T>(work: () => Promise<T>, dataEpoch = captureBackupRestoreDataEpoch()): Promise<T> {
  const operation = writes.then(async () => {
    const result = await runBackupRestoreDataEpochCommit(dataEpoch, () => runMemoryDuplicateCleanupBusinessWrite(work));
    if (!result.committed) throw new Error('history-import-data-changed');
    publish();
    return result.value;
  });
  writes = operation.catch(() => undefined);
  return operation;
}

function batchId(importId: string, index: number) { return `${importId}-chunk-${index}`; }

export function stageHistoryImport(preview: HistoryImportPreview) {
  return write(async () => {
    const database = await databaseForImport();
    // Selecting the same source again resumes its saved decisions, including discarded cards.
    const existing = await database.getFirstAsync<{ id: string }>(
      'SELECT id FROM memory_history_imports WHERE original_content = ? LIMIT 1', preview.originalContent,
    );
    if (existing) return existing.id;
    const id = `history-import-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await database.withExclusiveTransactionAsync(async (database) => {
      await database.runAsync(
        'INSERT INTO memory_history_imports (id, file_name, original_content, chunks_json, created_at) VALUES (?, ?, ?, ?, ?)',
        id, preview.fileName, preview.originalContent, JSON.stringify(preview.chunks), Date.now(),
      );
      for (const chunk of preview.chunks) {
        await beginMemoryIngestionBatchWithDatabase(database, {
          id: batchId(id, chunk.index), stream: 'history_import', scopeKey: id,
          sourceHash: String(chunk.index), advancesCursor: false,
        });
      }
    });
    return id;
  });
}

export async function loadHistoryImportState() {
  await writes;
  const database = await databaseForImport();
  const rows = await database.getAllAsync<{
    id: string; file_name: string; chunk_count: number; completed: number; failed: number;
  }>(`SELECT h.id, h.file_name, json_array_length(h.chunks_json) AS chunk_count,
      SUM(CASE WHEN b.status IN ('ready', 'resolved', 'no_value') THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN b.status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM memory_history_imports h LEFT JOIN memory_ingestion_batches b
      ON b.scope_key = h.id AND b.stream = 'history_import'
    GROUP BY h.id ORDER BY h.created_at DESC, h.id`);
  const batches = await database.getAllAsync<{ id: string }>(
    "SELECT id FROM memory_ingestion_batches WHERE stream = 'history_import' AND status IN ('pending', 'ready', 'failed')",
  );
  const candidates = await loadPendingMemoryCandidatesWithDatabase(database, { batchIds: batches.map((batch) => batch.id) });
  return {
    documents: rows.map((row): HistoryImportDocument => ({
      id: row.id, fileName: row.file_name, chunkCount: row.chunk_count,
      completedChunks: row.completed ?? 0, remainingChunks: row.chunk_count - (row.completed ?? 0),
      failedChunks: row.failed ?? 0, running: flights.has(row.id),
    })),
    candidates: appendMemoryCandidateReviews([], candidates) as HistoryImportCandidate[],
  };
}

export function processStoredHistoryImport(
  importId: string,
  ai: { apiKey: string; connection: AiConnection },
  annotate: (candidates: HistoryImportCandidate[]) => Promise<HistoryImportCandidate[]> = async (candidates) => candidates,
) {
  const existing = flights.get(importId);
  if (existing) return existing;
  const dataEpoch = captureBackupRestoreDataEpoch();
  const operation = (async () => {
    await writes;
    const database = await databaseForImport();
    const stored = await database.getFirstAsync<ImportRow>('SELECT * FROM memory_history_imports WHERE id = ?', importId);
    if (!stored) throw new Error('history-import-source-missing');
    const chunks = JSON.parse(stored.chunks_json) as HistoryImportChunk[];
    let attempted = 0;
    for (const chunk of chunks) {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const id = batchId(importId, chunk.index);
      const batch = await loadMemoryIngestionBatchWithDatabase(database, id);
      if (!batch || ['ready', 'resolved', 'no_value'].includes(batch.status)) continue;
      if (attempted >= HISTORY_IMPORT_CHUNKS_PER_RUN) break;
      attempted += 1;
      // A saved result is usable even when a later annotation or UI refresh failed.
      const pending = await loadPendingMemoryCandidatesWithDatabase(database, { batchIds: [id] });
      if (pending.length) continue;
      const result = await generateHistoryImportCandidates(ai, {
        chunks: [chunk], cleanedContent: chunk.content, originalContent: stored.original_content,
        fileName: stored.file_name, estimatedCandidates: 6, needsAi: true, totalChars: chunk.content.length,
      }, { limitChunks: 1 });
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      if (result.skipped) {
        await write(() => markMemoryIngestionBatchFailedWithDatabase(database, id), dataEpoch);
        continue;
      }
      const candidates = result.candidates.map((candidate, index): HistoryImportCandidate => ({
        ...candidate, origin: 'history_import', reviewId: `${id}-candidate-${index}`,
        historyImportId: importId, historyChunkIndex: chunk.index, fileName: stored.file_name,
        ingestionRefs: [{ batchId: id, itemKey: String(index) }],
      }));
      await write(() => database.withExclusiveTransactionAsync(async (database) => {
        await registerMemoryIngestionOutcomeWithDatabase(database, {
          batchId: id, pendingItemKeys: candidates.map((_, index) => String(index)),
          pendingCandidates: candidates.map((candidate, index) => ({ itemKey: String(index), candidateJson: JSON.stringify(candidate) })),
        });
      }), dataEpoch);
      // Hints are optional: a hint failure must not discard an already generated result.
      try {
        const annotated = await annotate(candidates);
        await write(async () => {
          const current = await loadPendingMemoryCandidatesWithDatabase(database, { batchIds: [id] });
          await updatePendingMemoryCandidatesWithDatabase(database, current.map((candidate) => {
            const hint = annotated.find((item) => item.reviewId === candidate.reviewId);
            return hint ? { ...candidate, admission: hint.admission, duplicateHint: hint.duplicateHint } : candidate;
          }), { hostHints: true });
        }, dataEpoch);
      } catch { /* The original candidates remain available for review. */ }
    }
  })().finally(() => { flights.delete(importId); publish(); });
  flights.set(importId, operation);
  publish();
  return operation;
}

export function updateStoredHistoryCandidate(candidate: HistoryImportCandidate) {
  return write(async () => {
    const database = await databaseForImport();
    let acknowledgments: Awaited<ReturnType<typeof updatePendingMemoryCandidatesWithDatabase>> = [];
    await database.withExclusiveTransactionAsync(async transaction => { acknowledgments = await updatePendingMemoryCandidatesWithDatabase(transaction, [candidate]); });
    for (const acknowledgment of acknowledgments) acknowledgment.session.hash = acknowledgment.hash;
  });
}

export function resolveStoredHistoryCandidate(
  candidate: HistoryImportCandidate,
  resolution: 'saved' | 'discarded',
  ai?: { apiKey: string; connection: AiConnection },
) {
  if (resolution === 'saved') return runMemoryCandidateSave(candidate, (latest, dataEpoch) => write(async () => {
    if (!latest.content.trim()) throw new Error('history-import-empty-candidate');
    return createMemory({
      ...latest, title: latest.title.trim() || deriveMemoryTitle(latest.content), content: latest.content.trim(),
      rememberedReason: latest.rememberedReason?.trim(), source: 'history-import', sourceType: 'digest',
      tags: Array.from(new Set(['历史导入', ...(latest.tags ?? [])])),
      recallCues: Array.from(new Set([...(latest.recallCues ?? []), '历史导入'])),
    }, {
      confirmationLevel: 'reviewed', continuationAi: ai, dataEpoch,
      ingestionResolutions: latest.ingestionRefs, requirePendingIngestion: true, sourceTraceMode: 'none',
      ingestionExpectedCandidate: { reviewId: latest.reviewId, editableHash: memoryCandidateEditableHash(latest) },
    });
  }, dataEpoch));
  return write(async () => {
    const database = await databaseForImport();
    const candidates = await loadPendingMemoryCandidatesWithDatabase(database, {
      batchIds: (candidate.ingestionRefs ?? []).map((ref) => ref.batchId),
    });
    const latest = appendMemoryCandidateReviews([], candidates).find((item) => item.reviewId === candidate.reviewId);
    if (!latest) return; // Repeated taps cannot save or revive an already resolved card.
    await database.withExclusiveTransactionAsync((database) => resolveMemoryIngestionItemsWithDatabase(database, latest.ingestionRefs ?? [], 'discarded', {
      expectedCandidate: { reviewId: candidate.reviewId, editableHash: memoryCandidateEditableHash(candidate) },
    }));
  });
}

export async function loadHistoryImportSource(query: { importId: string } | { memoryId: string }) {
  await writes;
  const database = await databaseForImport();
  const row = 'importId' in query
    ? await database.getFirstAsync<ImportRow>('SELECT * FROM memory_history_imports WHERE id = ?', query.importId)
    : await database.getFirstAsync<ImportRow>(`SELECT h.* FROM memory_history_imports h
        JOIN memory_ingestion_batches b ON b.scope_key = h.id AND b.stream = 'history_import'
        JOIN memory_ingestion_items i ON i.batch_id = b.id
        WHERE i.memory_id = ? LIMIT 1`, query.memoryId);
  return row ? { fileName: row.file_name, content: row.original_content } : null;
}
