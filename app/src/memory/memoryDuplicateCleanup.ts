import * as FileSystem from 'expo-file-system/legacy';

import {
  markBackupRestoreRecoveryBlocked,
  markBackupRestoreRuntimeReady,
  runBackupRestoreExclusive,
} from '../backup/backupRestoreCoordinator';
import {
  backupDatabaseToDirectory,
  restoreDatabaseFromDisk,
  validateDatabaseFile,
} from '../backup/sqliteBackupFiles';

import {
  deletableMemoryDuplicateCleanupLifecycleId,
  hasReliableMemoryDuplicateCleanupEventTime,
  isLegacyAutomaticLifeStateMemory,
  MEMORY_DUPLICATE_CLEANUP_BATCH_SIZE,
  memoryDuplicateCleanupPauseReasonAfterBatch,
  normalizeMemoryDuplicateCleanupText,
  type MemoryDuplicateCleanupCandidateLifecycle,
  type MemoryDuplicateCleanupPauseReason,
  type MemoryDuplicateCleanupResumePhase,
  type MemoryDuplicateCleanupRow,
} from './memoryDuplicateCleanupCore';
import {
  loadMemoryDuplicateCleanupJournal,
  saveMemoryDuplicateCleanupJournal,
  type MemoryDuplicateCleanupJournalV1,
} from './memoryDuplicateCleanupState';
import { runMemoryRecordsBootstrapRuntime } from '../sync/syncMemoryRecordsRuntime';
import {
  closeMemoryDatabaseForMaintenance,
  compactMemoryDatabaseForMaintenance,
  getMemoryDatabase,
} from './memoryStore';

const DATABASE_NAME = 'junluo-memory.db';
const ROLLBACK_FOLDER = 'memory-duplicate-cleanup-rollback';

export type MemoryDuplicateCleanupPreview = {
  candidates: number;
  duplicateGroups: number;
  skipped: number;
  lifecycleEvents: number;
};

let activeRun: Promise<MemoryDuplicateCleanupJournalV1> | null = null;
let pauseRequested = false;

type MemoryDatabase = Awaited<ReturnType<typeof getMemoryDatabase>>;

type MemoryDuplicateCleanupScan = MemoryDuplicateCleanupPreview & {
  candidateBatch: MemoryDuplicateCleanupCandidateLifecycle[];
  duplicateRows: number;
  skippedLifecycle: number;
  skippedProtected: number;
  skippedRelationships: number;
  skippedReliableEventTime: number;
};

type MemoryDuplicateCleanupScanStatsRow = {
  candidates: number;
  duplicateRows: number;
  groupCount: number;
  skippedLifecycle: number;
  skippedProtected: number;
  skippedRelationships: number;
  skippedReliableEventTime: number;
};

const CLEANUP_ROWS_SQL = `
    SELECT
      memory.id,
      memory.title,
      memory.content,
      memory.created_at AS createdAt,
      memory.source,
      memory.confirmation_level AS confirmationLevel,
      memory.pinned,
      memory.protected,
      memory.anchor,
      memory.tier,
      memory.type,
      memory.event_at AS eventAt,
      memory.event_start_at AS eventStartAt,
      memory.event_end_at AS eventEndAt,
      memory.event_time_precision AS eventTimePrecision,
      memory.event_time_basis AS eventTimeBasis,
      (
        (SELECT COUNT(*) FROM memory_comments WHERE memory_id = memory.id)
        + (SELECT COUNT(*) FROM memory_source_refs WHERE memory_id = memory.id)
        + (SELECT COUNT(*) FROM memory_edges WHERE source_id = memory.id OR target_id = memory.id)
        + (SELECT COUNT(*) FROM memory_recall_feedback WHERE memory_id = memory.id)
        + (SELECT COUNT(*) FROM memory_timeline_members WHERE memory_id = memory.id)
        + (SELECT COUNT(*) FROM memory_current_states WHERE source_memory_id = memory.id)
        + (SELECT COUNT(*) FROM continuity_event_links
             WHERE target_kind = 'memory' AND target_id = memory.id)
        + (SELECT COUNT(*) FROM memory_merge_recovery_snapshots
             WHERE source_memory_id = memory.id OR target_memory_id = memory.id)
        + (SELECT COUNT(*) FROM memory_ingestion_items WHERE memory_id = memory.id)
        + (SELECT COUNT(*) FROM memory_lifecycle_events
             WHERE related_memory_id = memory.id)
      ) AS relationCount,
      (SELECT COUNT(*) FROM memory_lifecycle_events WHERE memory_id = memory.id)
        AS lifecycleCount,
      soleLifecycle.id AS soleLifecycleId,
      soleLifecycle.event_type AS soleLifecycleEventType,
      soleLifecycle.actor AS soleLifecycleActor,
      soleLifecycle.operation_id AS soleLifecycleOperationId,
      soleLifecycle.related_memory_id AS soleLifecycleRelatedMemoryId,
      soleLifecycle.reason_code AS soleLifecycleReasonCode,
      soleLifecycle.comment_id AS soleLifecycleCommentId
    FROM memories memory
    LEFT JOIN memory_lifecycle_events soleLifecycle
      ON soleLifecycle.memory_id = memory.id
      AND NOT EXISTS (
        SELECT 1
        FROM memory_lifecycle_events otherLifecycle
        WHERE otherLifecycle.memory_id = memory.id
          AND otherLifecycle.id <> soleLifecycle.id
      )
    WHERE memory.source = 'assistant-life-state'
      AND memory.confirmation_level = 'automatic'
  `;

const CLEANUP_SCAN_TABLE = 'memory_duplicate_cleanup_scan';
const CLEANUP_MAIN_WRITE_LOCK_SQL = 'UPDATE memories SET id = id WHERE 0';

const CLEANUP_SCAN_SCHEMA_SQL = `
  DROP TABLE IF EXISTS temp.${CLEANUP_SCAN_TABLE};
  CREATE TEMP TABLE ${CLEANUP_SCAN_TABLE} (
    id TEXT PRIMARY KEY NOT NULL,
    normalized_title TEXT NOT NULL,
    normalized_content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    has_reliable_event_time INTEGER NOT NULL CHECK (
      has_reliable_event_time IN (0, 1)
    ),
    is_deletable_memory INTEGER NOT NULL CHECK (
      is_deletable_memory IN (0, 1)
    ),
    has_relationships INTEGER NOT NULL CHECK (
      has_relationships IN (0, 1)
    ),
    lifecycle_event_id TEXT
  );
  CREATE INDEX temp.memory_duplicate_cleanup_scan_group_idx
    ON ${CLEANUP_SCAN_TABLE} (
      normalized_title,
      normalized_content,
      created_at,
      id
    );
`;

const CLEANUP_SCAN_RANKED_CTE = `
  WITH ranked AS (
    SELECT
      scan.*,
      COUNT(*) OVER (
        PARTITION BY normalized_title, normalized_content
      ) AS group_size,
      ROW_NUMBER() OVER (
        PARTITION BY normalized_title, normalized_content
        ORDER BY created_at ASC, id ASC
      ) AS group_row,
      MAX(has_reliable_event_time) OVER (
        PARTITION BY normalized_title, normalized_content
      ) AS group_has_reliable_event_time
    FROM ${CLEANUP_SCAN_TABLE} scan
  )
`;

const CLEANUP_SCAN_STATS_SQL = `
  ${CLEANUP_SCAN_RANKED_CTE}
  SELECT
    COALESCE(SUM(CASE
      WHEN group_size > 1 AND group_row = 1 THEN 1 ELSE 0
    END), 0) AS groupCount,
    COALESCE(SUM(CASE
      WHEN group_size > 1 AND group_row > 1 THEN 1 ELSE 0
    END), 0) AS duplicateRows,
    COALESCE(SUM(CASE
      WHEN group_size > 1
        AND group_row > 1
        AND group_has_reliable_event_time = 1
      THEN 1 ELSE 0
    END), 0) AS skippedReliableEventTime,
    COALESCE(SUM(CASE
      WHEN group_size > 1
        AND group_row > 1
        AND group_has_reliable_event_time = 0
        AND is_deletable_memory = 0
      THEN 1 ELSE 0
    END), 0) AS skippedProtected,
    COALESCE(SUM(CASE
      WHEN group_size > 1
        AND group_row > 1
        AND group_has_reliable_event_time = 0
        AND is_deletable_memory = 1
        AND has_relationships = 1
      THEN 1 ELSE 0
    END), 0) AS skippedRelationships,
    COALESCE(SUM(CASE
      WHEN group_size > 1
        AND group_row > 1
        AND group_has_reliable_event_time = 0
        AND is_deletable_memory = 1
        AND has_relationships = 0
        AND lifecycle_event_id IS NULL
      THEN 1 ELSE 0
    END), 0) AS skippedLifecycle,
    COALESCE(SUM(CASE
      WHEN group_size > 1
        AND group_row > 1
        AND group_has_reliable_event_time = 0
        AND is_deletable_memory = 1
        AND has_relationships = 0
        AND lifecycle_event_id IS NOT NULL
      THEN 1 ELSE 0
    END), 0) AS candidates
  FROM ranked
`;

const CLEANUP_SCAN_CANDIDATES_SQL = `
  ${CLEANUP_SCAN_RANKED_CTE}
  SELECT id AS memoryId, lifecycle_event_id AS lifecycleEventId
  FROM ranked
  WHERE group_size > 1
    AND group_row > 1
    AND group_has_reliable_event_time = 0
    AND is_deletable_memory = 1
    AND has_relationships = 0
    AND lifecycle_event_id IS NOT NULL
  ORDER BY created_at ASC, id ASC
  LIMIT ?
`;

function rollbackDirectory() {
  if (!FileSystem.documentDirectory) {
    throw new Error('memory-cleanup-document-directory-unavailable');
  }
  return `${FileSystem.documentDirectory}${ROLLBACK_FOLDER}/`;
}

async function scanCleanupFromDatabase(
  database: MemoryDatabase,
  candidateLimit: number,
): Promise<MemoryDuplicateCleanupScan> {
  // Expo's exclusive transaction uses its own SQLite connection. Keep the
  // normalized scan index in SQLite's file-backed temp store so the JS heap
  // only owns the current source row and the bounded candidate batch.
  await database.execAsync('PRAGMA temp_store = FILE');
  await database.execAsync(CLEANUP_SCAN_SCHEMA_SQL);
  try {
    const insert = await database.prepareAsync(`
      INSERT INTO ${CLEANUP_SCAN_TABLE} (
        id,
        normalized_title,
        normalized_content,
        created_at,
        has_reliable_event_time,
        is_deletable_memory,
        has_relationships,
        lifecycle_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    try {
      for await (const row of database.getEachAsync<MemoryDuplicateCleanupRow>(
        CLEANUP_ROWS_SQL,
      )) {
        await insert.executeAsync(
          row.id,
          normalizeMemoryDuplicateCleanupText(row.title),
          normalizeMemoryDuplicateCleanupText(row.content),
          row.createdAt,
          hasReliableMemoryDuplicateCleanupEventTime(row) ? 1 : 0,
          isLegacyAutomaticLifeStateMemory(row) ? 1 : 0,
          row.relationCount > 0 ? 1 : 0,
          deletableMemoryDuplicateCleanupLifecycleId(row),
        );
      }
    } finally {
      await insert.finalizeAsync();
    }

    const stats = await database.getFirstAsync<MemoryDuplicateCleanupScanStatsRow>(
      CLEANUP_SCAN_STATS_SQL,
    );
    if (!stats) throw new Error('memory-cleanup-scan-stats-unavailable');
    const candidateBatch: MemoryDuplicateCleanupCandidateLifecycle[] = [];
    if (candidateLimit > 0) {
      for await (const candidate of database.getEachAsync<
        MemoryDuplicateCleanupCandidateLifecycle
      >(CLEANUP_SCAN_CANDIDATES_SQL, candidateLimit)) {
        candidateBatch.push(candidate);
      }
    }
    const skippedProtected = Number(stats.skippedProtected);
    const skippedReliableEventTime = Number(stats.skippedReliableEventTime);
    const skippedRelationships = Number(stats.skippedRelationships);
    const skippedLifecycle = Number(stats.skippedLifecycle);
    return {
      candidates: Number(stats.candidates),
      duplicateGroups: Number(stats.groupCount),
      duplicateRows: Number(stats.duplicateRows),
      skipped: skippedProtected
        + skippedReliableEventTime
        + skippedRelationships
        + skippedLifecycle,
      lifecycleEvents: Number(stats.candidates),
      candidateBatch,
      skippedProtected,
      skippedReliableEventTime,
      skippedRelationships,
      skippedLifecycle,
    };
  } finally {
    await database.execAsync(`DROP TABLE IF EXISTS temp.${CLEANUP_SCAN_TABLE}`);
  }
}

async function scanCleanup(candidateLimit = 0) {
  const database = await getMemoryDatabase('store');
  const outcome: { scan?: MemoryDuplicateCleanupScan } = {};
  await database.withExclusiveTransactionAsync(async (transaction) => {
    outcome.scan = await scanCleanupFromDatabase(transaction, candidateLimit);
  });
  const scan = outcome.scan;
  if (!scan) throw new Error('memory-cleanup-scan-unavailable');
  return scan;
}

export async function previewMemoryDuplicateCleanup(): Promise<MemoryDuplicateCleanupPreview> {
  const selection = await scanCleanup();
  return {
    candidates: selection.candidates,
    duplicateGroups: selection.duplicateGroups,
    skipped: selection.skipped,
    lifecycleEvents: selection.lifecycleEvents,
  };
}

async function removeRollbackBackup() {
  await FileSystem.deleteAsync(rollbackDirectory(), { idempotent: true });
}

async function hasUsableRollbackBackup() {
  const source = {
    directory: rollbackDirectory(),
    fileName: DATABASE_NAME,
  } as const;
  const info = await FileSystem.getInfoAsync(
    `${source.directory}${source.fileName}`,
  );
  if (!info.exists || !('size' in info) || !info.size) return false;
  await validateDatabaseFile(source);
  return true;
}

async function createRollbackBackup() {
  const directory = rollbackDirectory();
  await FileSystem.deleteAsync(directory, { idempotent: true });
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  await backupDatabaseToDirectory(DATABASE_NAME, directory);
  const info = await FileSystem.getInfoAsync(`${directory}${DATABASE_NAME}`);
  if (!info.exists || !('size' in info) || !info.size) {
    throw new Error('memory-cleanup-backup-empty');
  }
  await validateDatabaseFile({ directory, fileName: DATABASE_NAME });
}

async function failBeforeCleanup(error: unknown, journal: MemoryDuplicateCleanupJournalV1) {
  await removeRollbackBackup().catch(() => undefined);
  const failed: MemoryDuplicateCleanupJournalV1 = {
    ...journal,
    phase: 'failed-restored',
    updatedAt: Date.now(),
    lastErrorCode: error instanceof Error
      ? error.message.slice(0, 120)
      : 'memory-cleanup-backup-failed',
    resumePhase: null,
    pauseReason: null,
  };
  await saveMemoryDuplicateCleanupJournal(failed);
  markBackupRestoreRuntimeReady();
  return failed;
}

async function restoreRollbackBackup(error: unknown) {
  try {
    await closeMemoryDatabaseForMaintenance();
    await restoreDatabaseFromDisk({
      directory: rollbackDirectory(),
      fileName: DATABASE_NAME,
    }, DATABASE_NAME);
    await getMemoryDatabase('store');
    const restored: MemoryDuplicateCleanupJournalV1 = {
      version: 1,
      phase: 'failed-restored',
      totalCandidates: 0,
      processedCandidates: 0,
      deletedLifecycleEvents: 0,
      skippedCandidates: 0,
      publishedThroughCursor: null,
      waitingDeviceCount: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      lastErrorCode: error instanceof Error ? error.message.slice(0, 120) : 'cleanup-failed',
      resumePhase: null,
      pauseReason: null,
    };
    await saveMemoryDuplicateCleanupJournal(restored);
    await removeRollbackBackup();
    markBackupRestoreRuntimeReady();
    return restored;
  } catch (restoreError) {
    const blocked: MemoryDuplicateCleanupJournalV1 = {
      version: 1,
      phase: 'recovery-blocked',
      totalCandidates: 0,
      processedCandidates: 0,
      deletedLifecycleEvents: 0,
      skippedCandidates: 0,
      publishedThroughCursor: null,
      waitingDeviceCount: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      lastErrorCode: restoreError instanceof Error
        ? restoreError.message.slice(0, 120)
        : 'cleanup-restore-failed',
      resumePhase: null,
      pauseReason: null,
    };
    await saveMemoryDuplicateCleanupJournal(blocked);
    markBackupRestoreRecoveryBlocked(restoreError);
    return blocked;
  }
}

async function deleteNextBatch() {
  const database = await getMemoryDatabase('store');
  const outcome: { result?: {
    removed: number;
    scan: MemoryDuplicateCleanupScan;
    skipped: number;
  } } = {};
  await database.withExclusiveTransactionAsync(async (transaction) => {
    // Expo starts this connection with a deferred BEGIN. A TEMP-table write
    // does not prove that the main database is write-locked, so convert the
    // main transaction before scanning and requalifying the deletion batch.
    await transaction.runAsync(CLEANUP_MAIN_WRITE_LOCK_SQL);
    // Rebuild the exact normalized selection after taking the write lock. The
    // only IDs retained in JS are this transaction's at-most-25 candidates.
    const scan = await scanCleanupFromDatabase(
      transaction,
      MEMORY_DUPLICATE_CLEANUP_BATCH_SIZE,
    );
    let removed = 0;
    let skipped = 0;
    for (const candidate of scan.candidateBatch) {
      const id = candidate.memoryId;
      const lifecycleEventId = candidate.lifecycleEventId;
      const lifecycleDeletion = await transaction.runAsync(`
        DELETE FROM memory_lifecycle_events
        WHERE id = ?
          AND memory_id = ?
          AND related_memory_id IS NULL
          AND comment_id IS NULL
          AND (
            event_type = 'created'
            OR (
              event_type = 'baseline'
              AND actor = 'migration'
              AND reason_code = 'pre_lifecycle_memory'
              AND operation_id = 'baseline:' || ?
            )
          )
          AND (
            SELECT COUNT(*)
            FROM memory_lifecycle_events ownLifecycle
            WHERE ownLifecycle.memory_id = ?
          ) = 1
          AND NOT EXISTS (
            SELECT 1
            FROM memory_lifecycle_events reverseLifecycle
            WHERE reverseLifecycle.related_memory_id = ?
          )
      `, lifecycleEventId, id, id, id, id);
      if (lifecycleDeletion.changes !== 1) {
        skipped += 1;
        continue;
      }
      await transaction.runAsync("DELETE FROM memory_processing_jobs WHERE target_kind = 'memory' AND memory_id = ?", id);
      await transaction.runAsync("DELETE FROM memory_embeddings WHERE target_kind = 'memory' AND memory_id = ?", id);
      await transaction.runAsync('DELETE FROM memories WHERE id = ?', id);
      removed += 1;
    }
    outcome.result = { removed, scan, skipped };
  });
  const result = outcome.result;
  if (!result) throw new Error('memory-cleanup-delete-result-unavailable');
  if (result.scan.candidateBatch.length > 0 && result.removed === 0) {
    throw new Error('memory-cleanup-exclusive-revalidation-made-no-progress');
  }
  return result;
}

function pausedCleanupJournal(
  journal: MemoryDuplicateCleanupJournalV1,
  resumePhase: MemoryDuplicateCleanupResumePhase,
  pauseReason: MemoryDuplicateCleanupPauseReason,
): MemoryDuplicateCleanupJournalV1 {
  return {
    ...journal,
    phase: 'paused',
    resumePhase,
    pauseReason,
    updatedAt: Date.now(),
  };
}

async function blockCleanupRecovery(
  journal: MemoryDuplicateCleanupJournalV1,
  errorCode: string,
) {
  const error = new Error(errorCode);
  const blocked: MemoryDuplicateCleanupJournalV1 = {
    ...journal,
    phase: 'recovery-blocked',
    resumePhase: null,
    pauseReason: null,
    updatedAt: Date.now(),
    lastErrorCode: errorCode,
  };
  await saveMemoryDuplicateCleanupJournal(blocked);
  markBackupRestoreRecoveryBlocked(error);
  return blocked;
}

async function executeCleanup(): Promise<MemoryDuplicateCleanupJournalV1> {
  return runBackupRestoreExclusive(async () => {
    let journal = await loadMemoryDuplicateCleanupJournal();
    try {
      if (journal?.phase === 'recovery-blocked') {
        markBackupRestoreRecoveryBlocked(new Error(
          journal.lastErrorCode ?? 'memory-cleanup-recovery-blocked',
        ));
        return journal;
      }
      if (journal && ['publishing', 'waiting-windows'].includes(journal.phase)) {
        await removeRollbackBackup().catch(() => undefined);
        markBackupRestoreRuntimeReady();
        return journal;
      }
      if (!journal || ['complete', 'failed-restored'].includes(journal.phase)) {
        const preview = await previewMemoryDuplicateCleanup();
        journal = {
          version: 1,
          phase: 'backing-up',
          totalCandidates: preview.candidates,
          processedCandidates: 0,
          deletedLifecycleEvents: 0,
          skippedCandidates: preview.skipped,
          publishedThroughCursor: null,
          waitingDeviceCount: 0,
          startedAt: Date.now(),
          updatedAt: Date.now(),
          lastErrorCode: null,
          resumePhase: null,
          pauseReason: null,
        };
        await saveMemoryDuplicateCleanupJournal(journal);
      }

      if (journal.phase === 'paused') {
        journal = {
          ...journal,
          phase: journal.resumePhase ?? 'cleaning',
          resumePhase: null,
          pauseReason: null,
          updatedAt: Date.now(),
          lastErrorCode: null,
        };
        await saveMemoryDuplicateCleanupJournal(journal);
      }

      if (journal.phase === 'backing-up') {
        try {
          const memoryRecords = await runMemoryRecordsBootstrapRuntime(
            Date.now(),
            { allowDuringBackupRestore: true },
          );
          if (!memoryRecords.captureEnabled) {
            throw new Error('memory-cleanup-memory-records-capture-unavailable');
          }
          // The cleanup journal already blocks uncoordinated memory writers,
          // while the exclusive coordinator has drained coordinated writes.
          // Keep the shared read connection open: expo-sqlite's online backup
          // uses a separate connection and produces a consistent snapshot,
          // while closing an FTS-backed connection under a live reader can
          // crash natively instead of returning a catchable SQLite error.
          await createRollbackBackup();
        } catch (error) {
          return failBeforeCleanup(error, journal);
        }
        journal = {
          ...journal,
          phase: 'cleaning',
          resumePhase: null,
          pauseReason: null,
          updatedAt: Date.now(),
          lastErrorCode: null,
        };
        await saveMemoryDuplicateCleanupJournal(journal);
      } else {
        const rollbackAvailable = await hasUsableRollbackBackup();
        if (!rollbackAvailable && journal.phase === 'verifying') {
          const verification = await previewMemoryDuplicateCleanup();
          if (verification.candidates !== 0) {
            throw new Error('memory-cleanup-verified-backup-missing');
          }
          const publishing: MemoryDuplicateCleanupJournalV1 = {
            ...journal,
            phase: 'publishing',
            processedCandidates: journal.totalCandidates,
            updatedAt: Date.now(),
            lastErrorCode: null,
            resumePhase: null,
            pauseReason: null,
          };
          await saveMemoryDuplicateCleanupJournal(publishing);
          markBackupRestoreRuntimeReady();
          return publishing;
        }
        if (!rollbackAvailable) {
          throw new Error('memory-cleanup-rollback-backup-unavailable');
        }
      }

      if (journal.phase === 'cleaning') {
        while (true) {
          const latest = await loadMemoryDuplicateCleanupJournal();
          if (latest?.phase === 'paused') return latest;
          const deletion = await deleteNextBatch();
          const selection = deletion.scan;
          if (!selection.candidateBatch.length) {
            journal = pausedCleanupJournal(
              journal,
              'compacting',
              'before-compaction',
            );
            await saveMemoryDuplicateCleanupJournal(journal);
            return journal;
          }
          const remaining = Math.max(0, selection.candidates - deletion.removed);
          const previousProcessedCandidates = journal.processedCandidates;
          const nextProcessedCandidates = Math.max(
            journal.processedCandidates + deletion.removed + deletion.skipped,
            journal.totalCandidates - remaining,
          );
          const durable = await loadMemoryDuplicateCleanupJournal();
          const pauseReason = memoryDuplicateCleanupPauseReasonAfterBatch({
            durablePauseReason: durable?.phase === 'paused'
              ? durable.pauseReason ?? 'manual'
              : null,
            nextProcessedCandidates,
            pauseRequested,
            previousProcessedCandidates,
            remainingCandidates: remaining,
          });
          journal = {
            ...journal,
            phase: pauseReason ? 'paused' : 'cleaning',
            processedCandidates: nextProcessedCandidates,
            deletedLifecycleEvents:
              journal.deletedLifecycleEvents + deletion.removed,
            skippedCandidates: Math.max(
              journal.skippedCandidates + deletion.skipped,
              selection.skippedProtected
                + selection.skippedReliableEventTime
                + selection.skippedRelationships
                + selection.skippedLifecycle,
            ),
            updatedAt: Date.now(),
            resumePhase: pauseReason ? 'cleaning' : null,
            pauseReason,
          };
          await saveMemoryDuplicateCleanupJournal(journal);
          if (pauseReason) return journal;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }

      if (journal.phase === 'compacting') {
        await compactMemoryDatabaseForMaintenance();
        journal = {
          ...journal,
          phase: 'verifying',
          resumePhase: null,
          pauseReason: null,
          updatedAt: Date.now(),
        };
        await saveMemoryDuplicateCleanupJournal(journal);
      }

      const verification = await previewMemoryDuplicateCleanup();
      if (verification.candidates !== 0) {
        throw new Error('memory-cleanup-candidates-remain');
      }

      const publishing: MemoryDuplicateCleanupJournalV1 = {
        ...journal,
        phase: 'publishing',
        processedCandidates: journal.totalCandidates,
        updatedAt: Date.now(),
        resumePhase: null,
        pauseReason: null,
      };
      journal = publishing;
      await saveMemoryDuplicateCleanupJournal(publishing);
      await removeRollbackBackup().catch(async (error) => {
        const cleanupWarning: MemoryDuplicateCleanupJournalV1 = {
          ...publishing,
          updatedAt: Date.now(),
          lastErrorCode: error instanceof Error
            ? `rollback-cleanup:${error.message}`.slice(0, 120)
            : 'rollback-cleanup-failed',
        };
        journal = cleanupWarning;
        await saveMemoryDuplicateCleanupJournal(cleanupWarning);
      });
      markBackupRestoreRuntimeReady();
      return journal;
    } catch (error) {
      const durable = await loadMemoryDuplicateCleanupJournal().catch(() => null);
      if (durable && ['publishing', 'waiting-windows', 'complete'].includes(durable.phase)) {
        await removeRollbackBackup().catch(() => undefined);
        markBackupRestoreRuntimeReady();
        return durable;
      }
      return restoreRollbackBackup(error);
    }
  });
}

export function startOrResumeMemoryDuplicateCleanup() {
  if (activeRun) return activeRun;
  pauseRequested = false;
  activeRun = executeCleanup().finally(() => {
    activeRun = null;
  });
  return activeRun;
}

export async function recoverMemoryDuplicateCleanupAfterRestart() {
  const journal = await loadMemoryDuplicateCleanupJournal();
  if (!journal) return null;
  if (journal.phase === 'recovery-blocked') {
    if (await hasUsableRollbackBackup().catch(() => false)) {
      return restoreRollbackBackup(new Error(
        journal.lastErrorCode ?? 'memory-cleanup-recovery-retry',
      ));
    }
    const error = new Error(
      journal.lastErrorCode ?? 'memory-cleanup-rollback-backup-unavailable',
    );
    markBackupRestoreRecoveryBlocked(error);
    return journal;
  }
  if (journal.phase === 'paused') {
    return journal;
  }
  if (journal.phase === 'backing-up') {
    await removeRollbackBackup().catch(() => undefined);
    const paused = pausedCleanupJournal(journal, 'backing-up', 'restart');
    await saveMemoryDuplicateCleanupJournal(paused);
    markBackupRestoreRuntimeReady();
    return paused;
  }
  if (journal.phase === 'cleaning' || journal.phase === 'compacting') {
    if (!await hasUsableRollbackBackup().catch(() => false)) {
      return blockCleanupRecovery(
        journal,
        'memory-cleanup-rollback-backup-unavailable',
      );
    }
    const paused = pausedCleanupJournal(journal, journal.phase, 'restart');
    await saveMemoryDuplicateCleanupJournal(paused);
    markBackupRestoreRuntimeReady();
    return paused;
  }
  if (journal.phase === 'verifying') {
    const paused = pausedCleanupJournal(journal, 'verifying', 'restart');
    await saveMemoryDuplicateCleanupJournal(paused);
    markBackupRestoreRuntimeReady();
    return paused;
  }
  // A deliberate pause remains paused. Publishing/waiting is resumed by the
  // one-time automatic drain scheduler rather than rerunning local deletion.
  if (['publishing', 'waiting-windows', 'complete', 'failed-restored'].includes(journal.phase)) {
    await removeRollbackBackup().catch(() => undefined);
    markBackupRestoreRuntimeReady();
  }
  return journal;
}

export async function pauseMemoryDuplicateCleanup() {
  pauseRequested = true;
  const journal = await loadMemoryDuplicateCleanupJournal();
  if (!journal || journal.phase !== 'cleaning') return journal;
  const paused = pausedCleanupJournal(journal, 'cleaning', 'manual');
  await saveMemoryDuplicateCleanupJournal(paused);
  return paused;
}
