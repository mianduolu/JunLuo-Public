import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { currentStateEmbeddingText, currentStateIndexEligible, loadCurrentStateIndexSource, shiyingRecordProcessingHash, postSourceProcessingHash } from './memoryIndexTargets';
import {
  captureBackupRestoreDataEpoch,
  canCommitBackupRestoreDataEpoch,
  getBackupRestoreRuntimeState,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { isSqliteLockedError } from '../runtime/databaseWorkloadDiagnostics';
import {
  beginRuntimeWorkload,
  type RuntimeWorkloadSpan,
} from '../runtime/runtimeWorkloadDiagnostics';
import {
  getMemoryEmbeddingText,
  getMemoryEmbeddingHash,
  getShiyingRecordEmbeddingHash,
  hasUsableShiyingRecordEmbedding,
  getPostSourceEmbeddingHash,
  hasUsablePostSourceEmbedding,
  hasUsableEmbeddingRow,
  isEmbeddingSettingsCurrent,
  loadEmbeddingSettings,
  loadEmbeddingSettingsSnapshot,
  requestEmbeddingChunks,
  serializeEmbeddingChunks,
} from './memoryEmbedding';
import {
  analyzeDuplicateMemory,
  analyzeMemoryContinuation,
} from './memoryContinuation';
import { runMemoryDuplicateCleanupBusinessWrite } from './memoryDuplicateCleanupState';
import {
  blockMemoryProcessingJob,
  buildMemoryProcessingDesiredHash,
  claimNextMemoryProcessingJob,
  completeMemoryProcessingJobWithDatabase,
  countDueMemoryProcessingJobs,
  deferMemoryProcessingJob,
  deleteMemoryProcessingJobsWithDatabase,
  deleteOrphanMemoryProcessingRows,
  ensureCurrentMemoryProcessingJobWithDatabase,
  ensureMemoryProcessingJobForSourceWithDatabase,
  failMemoryProcessingJob,
  isMemoryProcessingIndexEligible,
  listMemoryIndexTargetKeysetPage,
  currentStateProcessingHash,
  queueCurrentStateEmbeddingWithDatabase,
  queueShiyingRecordEmbeddingWithDatabase,
  queuePostSourceEmbeddingWithDatabase,
  isMemoryProcessingLeaseCurrentWithDatabase,
  loadMemoryProcessingEmbeddingIndexesWithDatabase,
  loadMemoryProcessingSourceWithDatabase,
  loadMemoryProcessingSourcesWithDatabase,
  loadMemoryProcessingSummary,
  reconcileSourceIntegrityJobWithDatabase,
  releaseExpiredMemoryProcessingLeases,
  requeueStaleMemoryProcessingJob,
  resetMemoryProcessingFailures,
  type MemoryProcessingJobLease,
  type MemoryProcessingSourceSnapshot,
  type MemoryProcessingSummary,
  PENDING_WEEKLY_CANDIDATE_SQL,
  WEEKLY_RECHECK_INTENT_SQL,
} from './memoryProcessingQueue';
import { classifyMemoryProcessingError } from './memoryProcessingError';
import {
  canRunMemoryProcessingReconcileSlice,
  createMemoryProcessingReconcileState,
  deferMemoryProcessingReconcileAfterFailure,
  finishMemoryProcessingReconcileSlice,
  memoryProcessingReconcileDelayMs,
  MEMORY_RECONCILE_PAGE_SIZE,
  recordMemoryProcessingReconcileItem,
  requestMemoryProcessingReconcileState,
  type MemoryProcessingReconcileCursor,
  type MemoryProcessingReconcileReason,
} from './memoryProcessingReconcileCore';
import { notifyMemoryProcessingUpdated, notifyMemoryProcessingWorkAvailable } from './memoryProcessingSignals';
import { processWeeklyRefreshJob, reconcileWeeklyRefreshJobs, requeueWeeklyRefreshJob } from './memoryWeeklyRefresh';
import { nextWeeklyPeriodDueAt } from './memoryWeeklySchedule';
import { loadWeeklyTaskIntent } from './memoryWeeklyTaskIntent';
import type { MemoryCandidateReview } from './memoryCandidateReview';
import { getWeeklyContextStatus } from './memoryWeeklyBasis';
import { getUnderstandingStatus } from './memoryUnderstanding';
import { assertMemoryDuplicateCleanupAllowsBusinessWrites } from './memoryDuplicateCleanupState';
import type { MemoryProcessingBatchMode } from './memoryProcessingRuntimeCore';
import {
  deriveMemoryTitle,
  getMemoryDatabase as getMemoryDatabaseForSource,
  loadMemory,
  isCurrentMemory,
  memoryFromRow,
  normalizeMemoryDomain,
} from './memoryStore';

const getMemoryDatabase = () => getMemoryDatabaseForSource('worker');

type WorkerResult = {
  nextWeeklyRefreshDelayMs?: number;
  dueRemaining: number;
  processed: number;
  reconcilePending: boolean;
  reconcileRepairs: number;
  reconcileScanned: number;
  nextReconcileDelayMs: number;
  summary: MemoryProcessingSummary;
};

type ProviderFailure = {
  at: number;
  jobKey: string;
};

const CIRCUIT_WINDOW_MS = 300_000;
const CIRCUIT_PAUSE_MS = 900_000;
const providerFailures = new Map<string, ProviderFailure[]>();
const providerCircuitUntil = new Map<string, number>();

let workerFlight: Promise<WorkerResult> | null = null;
let reconcileState = createMemoryProcessingReconcileState();
let reconcileSpan: RuntimeWorkloadSpan | null = null;
let reconcileSpanGeneration = -1;
let processStartReconcileRequested = false;
let memoryProcessingForegroundActive = true;
let lastObservedDataEpoch: number | null = null;
let reconcileEmbeddingSettingsSnapshot: {
  generation: number;
  settings: Awaited<ReturnType<typeof loadEmbeddingSettingsSnapshot>>;
} | null = null;

async function loadReconcileEmbeddingSettings(generation: number) {
  if (reconcileEmbeddingSettingsSnapshot?.generation === generation) {
    return reconcileEmbeddingSettingsSnapshot.settings;
  }
  const settings = await loadEmbeddingSettingsSnapshot();
  if (reconcileState.generation === generation) {
    reconcileEmbeddingSettingsSnapshot = { generation, settings };
  }
  return settings;
}

function jobKey(lease: MemoryProcessingJobLease) {
  return `${lease.targetKind ?? 'memory'}:${lease.memoryId}:${lease.jobType}`;
}

function isCircuitOpen(provider: string, now: number) {
  const until = providerCircuitUntil.get(provider) ?? 0;
  if (until <= now) {
    providerCircuitUntil.delete(provider);
    return 0;
  }
  return until;
}

function recordProviderFailure(provider: string, lease: MemoryProcessingJobLease, now: number) {
  const recent = (providerFailures.get(provider) ?? [])
    .filter((entry) => now - entry.at <= CIRCUIT_WINDOW_MS);
  const currentKey = jobKey(lease);
  if (!recent.some((entry) => entry.jobKey === currentKey)) {
    recent.push({ at: now, jobKey: currentKey });
  }
  providerFailures.set(provider, recent);
  if (new Set(recent.map((entry) => entry.jobKey)).size >= 3) {
    const until = now + CIRCUIT_PAUSE_MS;
    providerCircuitUntil.set(provider, until);
    return until;
  }
  return 0;
}

function clearProviderFailure(provider: string, lease: MemoryProcessingJobLease) {
  const currentKey = jobKey(lease);
  const remaining = (providerFailures.get(provider) ?? [])
    .filter((entry) => entry.jobKey !== currentKey);
  if (remaining.length) providerFailures.set(provider, remaining);
  else providerFailures.delete(provider);
}

async function sourceStillMatches(lease: MemoryProcessingJobLease) {
  const database = await getMemoryDatabase();
  const source = await loadMemoryProcessingSourceWithDatabase(database, lease.memoryId);
  return !!source
    && buildMemoryProcessingDesiredHash(source, lease.jobType) === lease.desiredHash;
}

async function completeNoopJob(lease: MemoryProcessingJobLease, dataEpoch: number) {
  let completed = false;
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    const database = await getMemoryDatabase();
    await database.withExclusiveTransactionAsync(async (database) => {
      const source = await loadMemoryProcessingSourceWithDatabase(database, lease.memoryId);
      if (!source) {
        await deleteMemoryProcessingJobsWithDatabase(database, lease.memoryId);
        return;
      }
      if (buildMemoryProcessingDesiredHash(source, lease.jobType) !== lease.desiredHash) {
        await requeueStaleMemoryProcessingJob(database, lease);
        return;
      }
      completed = await completeMemoryProcessingJobWithDatabase(database, lease);
    });
  });
  return committed.committed && completed;
}

async function processSourceIntegrity(
  lease: MemoryProcessingJobLease,
  dataEpoch: number,
) {
  let completed = false;
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    const database = await getMemoryDatabase();
    await database.withExclusiveTransactionAsync(async (database) => {
      const source = await loadMemoryProcessingSourceWithDatabase(database, lease.memoryId);
      if (!source) {
        await deleteMemoryProcessingJobsWithDatabase(database, lease.memoryId);
        return;
      }
      if (buildMemoryProcessingDesiredHash(source, lease.jobType) !== lease.desiredHash) {
        await requeueStaleMemoryProcessingJob(database, lease);
        return;
      }
      await reconcileSourceIntegrityJobWithDatabase(database, lease.memoryId);
      const current = await loadMemoryProcessingSourceWithDatabase(database, lease.memoryId);
      if (!current) return;
      const completedHash = buildMemoryProcessingDesiredHash(current, lease.jobType);
      completed = await completeMemoryProcessingJobWithDatabase(
        database,
        lease,
        Date.now(),
        completedHash,
      );
    });
  });
  return committed.committed && completed;
}

async function processEmbedding(
  lease: MemoryProcessingJobLease,
  dataEpoch: number,
  diagnosticParentToken?: number,
) {
  if (lease.targetKind === 'current_state') return processCurrentStateEmbedding(lease, dataEpoch, diagnosticParentToken);
  if (lease.targetKind === 'shiying_record') return processShiyingRecordEmbedding(lease, dataEpoch, diagnosticParentToken);
  if (lease.targetKind === 'post_source') return processPostSourceEmbedding(lease, dataEpoch, diagnosticParentToken);
  const now = Date.now();
  const circuitUntil = isCircuitOpen('embedding', now);
  const database = await getMemoryDatabase();
  if (circuitUntil) {
    await deferMemoryProcessingJob(database, lease, 'provider_circuit', circuitUntil, now);
    return false;
  }
  const [{ settings, apiKey }, source, memory] = await Promise.all([
    loadEmbeddingSettings(),
    loadMemoryProcessingSourceWithDatabase(database, lease.memoryId),
    loadMemory(lease.memoryId),
  ]);
  if (!source || !memory) {
    await database.withExclusiveTransactionAsync(async (database) => {
      await deleteMemoryProcessingJobsWithDatabase(database, lease.memoryId);
    });
    return true;
  }
  if (buildMemoryProcessingDesiredHash(source, lease.jobType) !== lease.desiredHash) {
    await database.withExclusiveTransactionAsync(async (database) => {
      await requeueStaleMemoryProcessingJob(database, lease);
    });
    return false;
  }
  if (!isMemoryProcessingIndexEligible(source) || !(await isCurrentMemory(memory))) {
    await database.withExclusiveTransactionAsync(async (database) => {
      await completeMemoryProcessingJobWithDatabase(database, lease);
    });
    return true;
  }
  if (!settings.enabled) {
    await blockMemoryProcessingJob(database, lease, 'embedding_disabled');
    return false;
  }
  if (!settings.baseUrl.trim() || !settings.model.trim() || !apiKey.trim()) {
    await blockMemoryProcessingJob(database, lease, 'embedding_configuration');
    return false;
  }
  const text = getMemoryEmbeddingText(memory);
  const contentHash = getMemoryEmbeddingHash(text, settings);
  const existing = await database.getFirstAsync<{ model: string; content_hash: string; embedding_json: string }>(
    "SELECT model, content_hash, embedding_json FROM memory_embeddings WHERE target_kind = 'memory' AND memory_id = ?",
    lease.memoryId,
  );
  const { getPostDerivedStatus, preloadPostDerivedReadOptions } = await import('../posts/baiyunPostMemoryBasis');
  if (hasUsableEmbeddingRow(existing, text, settings)) {
    let completed = false;
    const postOptions = await preloadPostDerivedReadOptions(database, [{ kind: 'memory', id: lease.memoryId }]);
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, () => database.withExclusiveTransactionAsync(async (database) => {
      if (!await isMemoryProcessingLeaseCurrentWithDatabase(database, lease)) return;
      if ((await getPostDerivedStatus(database, 'memory', lease.memoryId, undefined, postOptions)).status !== 'current') {
        completed = await completeMemoryProcessingJobWithDatabase(database, lease);
        return;
      }
      const currentIndex = await database.getFirstAsync<{ model: string; content_hash: string; embedding_json: string }>(
        "SELECT model, content_hash, embedding_json FROM memory_embeddings WHERE target_kind = 'memory' AND memory_id = ?", lease.memoryId);
      if (!hasUsableEmbeddingRow(currentIndex, text, settings) || !(await isEmbeddingSettingsCurrent(settings))) {
        await requeueStaleMemoryProcessingJob(database, lease);
        return;
      }
      completed = await completeMemoryProcessingJobWithDatabase(database, lease);
    }));
    if (committed.committed && completed) clearProviderFailure('embedding', lease);
    return committed.committed && completed;
  }
  const vector = await requestEmbeddingChunks(text, settings, apiKey, {
    budget: 'background',
    diagnosticParentToken,
  });
  if (!vector.length) throw new Error('embedding-empty-response');
  const postOptions = await preloadPostDerivedReadOptions(database, [{ kind: 'memory', id: lease.memoryId }]);
  let completed = false;
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    const currentDatabase = await getMemoryDatabase();
    await currentDatabase.withExclusiveTransactionAsync(async (currentDatabase) => {
      if (!await isMemoryProcessingLeaseCurrentWithDatabase(currentDatabase, lease)) return;
      const current = await loadMemoryProcessingSourceWithDatabase(currentDatabase, lease.memoryId);
      if (!current) {
        await deleteMemoryProcessingJobsWithDatabase(currentDatabase, lease.memoryId);
        return;
      }
      if (buildMemoryProcessingDesiredHash(current, lease.jobType) !== lease.desiredHash) {
        await requeueStaleMemoryProcessingJob(currentDatabase, lease);
        return;
      }
      const currentRow = await currentDatabase.getFirstAsync<Parameters<typeof memoryFromRow>[0]>('SELECT * FROM memories WHERE id = ?', lease.memoryId);
      const currentMemory = currentRow ? memoryFromRow(currentRow) : null;
      if (!currentMemory) return;
      if (!isMemoryProcessingIndexEligible(current)
        || !(await (await import('../reading/readingMemoryOrganizationSource')).isReadingOrganizationMemoryCurrent(currentDatabase, lease.memoryId))
        || (await getPostDerivedStatus(currentDatabase, 'memory', lease.memoryId, undefined, postOptions)).status !== 'current'
        || await getWeeklyContextStatus(currentDatabase, currentMemory, postOptions) !== 'current'
        || await getUnderstandingStatus(currentDatabase, currentMemory, postOptions) !== 'current') {
        await completeMemoryProcessingJobWithDatabase(currentDatabase, lease);
        return;
      }
      const currentText = getMemoryEmbeddingText(currentMemory);
      const currentContentHash = getMemoryEmbeddingHash(currentText, settings);
      if (currentContentHash !== contentHash) {
        await requeueStaleMemoryProcessingJob(currentDatabase, lease);
        return;
      }
      if (!(await isEmbeddingSettingsCurrent(settings))) {
        await requeueStaleMemoryProcessingJob(currentDatabase, lease);
        return;
      }
      await currentDatabase.runAsync(
        `INSERT OR REPLACE INTO memory_embeddings (
          target_kind, memory_id, embedding_json, model, content_hash, updated_at
        ) VALUES ('memory', ?, ?, ?, ?, ?)`,
        lease.memoryId,
        serializeEmbeddingChunks(vector),
        settings.model,
        contentHash,
        Date.now(),
      );
      completed = await completeMemoryProcessingJobWithDatabase(currentDatabase, lease);
    });
  });
  if (committed.committed && completed) {
    clearProviderFailure('embedding', lease);
    return true;
  }
  return false;
}

async function processCurrentStateEmbedding(lease: MemoryProcessingJobLease, dataEpoch: number, diagnosticParentToken?: number) {
  const database = await getMemoryDatabase();
  const circuitUntil = isCircuitOpen('embedding', Date.now());
  if (circuitUntil) {
    await deferMemoryProcessingJob(database, lease, 'provider_circuit', circuitUntil);
    return false;
  }
  const [{ settings, apiKey }, source] = await Promise.all([loadEmbeddingSettings(), loadCurrentStateIndexSource(database, lease.memoryId)]);
  if (!currentStateIndexEligible(source) || currentStateProcessingHash(source) !== lease.desiredHash) {
    await runBackupRestoreDataEpochCommit(dataEpoch, () => database.withExclusiveTransactionAsync(async transaction => {
      await requeueStaleMemoryProcessingJob(transaction, lease);
    }));
    return false;
  }
  const { getPostDerivedStatus, preloadPostDerivedReadOptions } = await import('../posts/baiyunPostMemoryBasis');
  if ((await getPostDerivedStatus(database, 'current_state', lease.memoryId)).status !== 'current') {
    await runBackupRestoreDataEpochCommit(dataEpoch, () => database.withExclusiveTransactionAsync(async transaction => {
      await completeMemoryProcessingJobWithDatabase(transaction, lease);
    }));
    return true;
  }
  if (!settings.enabled || !settings.baseUrl.trim() || !settings.model.trim() || !apiKey.trim()) {
    await blockMemoryProcessingJob(database, lease, settings.enabled ? 'embedding_configuration' : 'embedding_disabled');
    return false;
  }
  const text = currentStateEmbeddingText(source), contentHash = getMemoryEmbeddingHash(text, settings);
  const existing = await database.getFirstAsync<{ model: string; content_hash: string; embedding_json: string }>(
    "SELECT model, content_hash, embedding_json FROM memory_embeddings WHERE target_kind = 'current_state' AND memory_id = ?", lease.memoryId);
  const vectors = hasUsableEmbeddingRow(existing, text, settings) ? null
    : await requestEmbeddingChunks(text, settings, apiKey, { budget: 'background', diagnosticParentToken });
  if (vectors && !vectors.length) throw new Error('embedding-empty-response');
  const postOptions = await preloadPostDerivedReadOptions(database, [{ kind: 'current_state', id: lease.memoryId }]);
  let completed = false;
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    const currentDatabase = await getMemoryDatabase();
    await currentDatabase.withExclusiveTransactionAsync(async transaction => {
      if (!await isMemoryProcessingLeaseCurrentWithDatabase(transaction, lease)) return;
      const current = await loadCurrentStateIndexSource(transaction, lease.memoryId);
      if ((await getPostDerivedStatus(transaction, 'current_state', lease.memoryId, undefined, postOptions)).status !== 'current') {
        completed = await completeMemoryProcessingJobWithDatabase(transaction, lease);
        return;
      }
      if (!currentStateIndexEligible(current) || currentStateProcessingHash(current) !== lease.desiredHash
        || getMemoryEmbeddingHash(currentStateEmbeddingText(current), settings) !== contentHash
        || !await isEmbeddingSettingsCurrent(settings)) {
        await requeueStaleMemoryProcessingJob(transaction, lease);
        return;
      }
      if (!vectors) {
        const currentIndex = await transaction.getFirstAsync<{ model: string; content_hash: string; embedding_json: string }>(
          "SELECT model, content_hash, embedding_json FROM memory_embeddings WHERE target_kind = 'current_state' AND memory_id = ?", lease.memoryId);
        if (!hasUsableEmbeddingRow(currentIndex, currentStateEmbeddingText(current), settings)) {
          await requeueStaleMemoryProcessingJob(transaction, lease);
          return;
        }
      }
      if (vectors) await transaction.runAsync(`INSERT OR REPLACE INTO memory_embeddings
        (target_kind, memory_id, embedding_json, model, content_hash, updated_at) VALUES ('current_state', ?, ?, ?, ?, ?)`,
      lease.memoryId, serializeEmbeddingChunks(vectors), settings.model, contentHash, Date.now());
      completed = await completeMemoryProcessingJobWithDatabase(transaction, lease);
    });
  });
  if (committed.committed && completed) clearProviderFailure('embedding', lease);
  return committed.committed && completed;
}

async function processShiyingRecordEmbedding(lease: MemoryProcessingJobLease, dataEpoch: number, diagnosticParentToken?: number) {
  const { loadShiyingMemoryIndexSource } = await import('../shiying/shiyingMemorySource');
  const database = await getMemoryDatabase();
  const source = await loadShiyingMemoryIndexSource(lease.memoryId);
  if (!source || !source.indexText.trim() || shiyingRecordProcessingHash(source) !== lease.desiredHash) {
    await runBackupRestoreDataEpochCommit(dataEpoch, () => database.withExclusiveTransactionAsync(async transaction => {
      await requeueStaleMemoryProcessingJob(transaction, lease, Date.now(), source);
    }));
    return false;
  }
  const circuitUntil = isCircuitOpen('embedding', Date.now());
  if (circuitUntil) {
    await deferMemoryProcessingJob(database, lease, 'provider_circuit', circuitUntil);
    return false;
  }
  const { settings, apiKey } = await loadEmbeddingSettings();
  if (!settings.enabled || !settings.baseUrl.trim() || !settings.model.trim() || !apiKey.trim()) {
    await blockMemoryProcessingJob(database, lease, settings.enabled ? 'embedding_configuration' : 'embedding_disabled');
    return false;
  }
  const contentHash = getShiyingRecordEmbeddingHash(source, settings);
  const existing = await database.getFirstAsync<{ model: string; content_hash: string; embedding_json: string }>(
    "SELECT model, content_hash, embedding_json FROM memory_embeddings WHERE target_kind = 'shiying_record' AND memory_id = ?", lease.memoryId);
  const vectors = hasUsableShiyingRecordEmbedding(existing, source, settings) ? null
    : await requestEmbeddingChunks(source.indexText, settings, apiKey, { budget: 'background', diagnosticParentToken });
  if (vectors && !vectors.length) throw new Error('embedding-empty-response');
  let completed = false;
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, () => database.withExclusiveTransactionAsync(async transaction => {
    if (!await isMemoryProcessingLeaseCurrentWithDatabase(transaction, lease)) return;
    const settingsCurrent = await isEmbeddingSettingsCurrent(settings);
    const current = await loadShiyingMemoryIndexSource(lease.memoryId);
    if (!settingsCurrent || !current || shiyingRecordProcessingHash(current) !== lease.desiredHash
      || getShiyingRecordEmbeddingHash(current, settings) !== contentHash) {
      await requeueStaleMemoryProcessingJob(transaction, lease, Date.now(), current);
      return;
    }
    if (!vectors) {
      const index = await transaction.getFirstAsync<{ model: string; content_hash: string; embedding_json: string }>(
        "SELECT model, content_hash, embedding_json FROM memory_embeddings WHERE target_kind = 'shiying_record' AND memory_id = ?", lease.memoryId);
      if (!hasUsableShiyingRecordEmbedding(index, current, settings)) {
        await requeueStaleMemoryProcessingJob(transaction, lease, Date.now(), current);
        return;
      }
    }
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (vectors) await transaction.runAsync(`INSERT OR REPLACE INTO memory_embeddings
      (target_kind, memory_id, embedding_json, model, content_hash, updated_at) VALUES ('shiying_record', ?, ?, ?, ?, ?)`,
    lease.memoryId, serializeEmbeddingChunks(vectors), settings.model, contentHash, Date.now());
    completed = await completeMemoryProcessingJobWithDatabase(transaction, lease);
  }));
  if (committed.committed && completed) clearProviderFailure('embedding', lease);
  return committed.committed && completed;
}

async function processPostSourceEmbedding(lease: MemoryProcessingJobLease, dataEpoch: number, diagnosticParentToken?: number) {
  const reader = await import('../posts/baiyunPostRecallSource');
  const database = await getMemoryDatabase();
  const source = await reader.loadPostSourceIndexSource(lease.memoryId);
  if (!source || !source.indexText.trim() || postSourceProcessingHash(source) !== lease.desiredHash) {
    await runBackupRestoreDataEpochCommit(dataEpoch, () => database.withExclusiveTransactionAsync(async transaction => {
      await requeueStaleMemoryProcessingJob(transaction, lease, Date.now(), undefined, source);
    }));
    return false;
  }
  const circuitUntil = isCircuitOpen('embedding', Date.now());
  if (circuitUntil) {
    await deferMemoryProcessingJob(database, lease, 'provider_circuit', circuitUntil);
    return false;
  }
  const { settings, apiKey } = await loadEmbeddingSettings();
  if (!settings.enabled || !settings.baseUrl.trim() || !settings.model.trim() || !apiKey.trim()) {
    await blockMemoryProcessingJob(database, lease, settings.enabled ? 'embedding_configuration' : 'embedding_disabled');
    return false;
  }
  const contentHash = getPostSourceEmbeddingHash(source, settings);
  const existing = await database.getFirstAsync<{ model: string; content_hash: string; embedding_json: string }>(
    "SELECT model, content_hash, embedding_json FROM memory_embeddings WHERE target_kind = 'post_source' AND memory_id = ?", lease.memoryId);
  const vectors = hasUsablePostSourceEmbedding(existing, source, settings) ? null
    : await requestEmbeddingChunks(source.indexText, settings, apiKey, { budget: 'background', diagnosticParentToken });
  if (vectors && !vectors.length) throw new Error('embedding-empty-response');
  const knowledge = await (await import('../posts/baiyunPostMemorySource')).loadPostMemoryKnowledgeSnapshot(database);
  let completed = false;
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, () => database.withExclusiveTransactionAsync(async transaction => {
    if (!await isMemoryProcessingLeaseCurrentWithDatabase(transaction, lease)) return;
    const settingsCurrent = await isEmbeddingSettingsCurrent(settings);
    const current = await reader.loadPostSourceIndexSource(lease.memoryId, { database: transaction, knowledge });
    if (!settingsCurrent || !current || postSourceProcessingHash(current) !== lease.desiredHash
      || current.sourceHash !== source.sourceHash || current.indexText !== source.indexText) {
      await requeueStaleMemoryProcessingJob(transaction, lease, Date.now(), undefined, current);
      return;
    }
    if (!vectors) {
      const index = await transaction.getFirstAsync<{ model: string; content_hash: string; embedding_json: string }>(
        "SELECT model, content_hash, embedding_json FROM memory_embeddings WHERE target_kind = 'post_source' AND memory_id = ?", lease.memoryId);
      if (!hasUsablePostSourceEmbedding(index, current, settings)) {
        await requeueStaleMemoryProcessingJob(transaction, lease, Date.now(), undefined, current);
        return;
      }
    }
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (vectors) await transaction.runAsync(`INSERT OR REPLACE INTO memory_embeddings
      (target_kind, memory_id, embedding_json, model, content_hash, updated_at) VALUES ('post_source', ?, ?, ?, ?, ?)`,
    lease.memoryId, serializeEmbeddingChunks(vectors), settings.model, contentHash, Date.now());
    completed = await completeMemoryProcessingJobWithDatabase(transaction, lease);
  }));
  if (committed.committed && completed) clearProviderFailure('embedding', lease);
  return committed.committed && completed;
}

async function assertAutomaticMemoryAnalysisAllowed() {
  if (!(await loadAutomaticRemoteAiPolicy()).enabled) throw new Error('memory-automatic-disabled');
}

async function processMemoryAnalysis(
  lease: MemoryProcessingJobLease,
  dataEpoch: number,
) {
  const database = await getMemoryDatabase();
  const memory = await loadMemory(lease.memoryId);
  if (memory && !(await isCurrentMemory(memory, database))) return completeNoopJob(lease, dataEpoch);
  if (!(await sourceStillMatches(lease))) {
    await database.withExclusiveTransactionAsync(async (database) => {
      await requeueStaleMemoryProcessingJob(database, lease);
    });
    return false;
  }

  if (lease.jobType === 'duplicate_analysis') {
    const localResult = await analyzeDuplicateMemory(lease.memoryId, undefined, {
      dataEpoch,
      expectedHash: lease.desiredHash,
    });
    if (localResult?.outcome === 'retry_latest') {
      await database.withExclusiveTransactionAsync(async (database) => {
        await requeueStaleMemoryProcessingJob(database, lease);
      });
      return false;
    }
    if (localResult) {
      const current = await loadMemoryProcessingSourceWithDatabase(database, lease.memoryId);
      if (!current) return true;
      if (buildMemoryProcessingDesiredHash(current, lease.jobType) !== lease.desiredHash) {
        await database.withExclusiveTransactionAsync(async (database) => {
          await requeueStaleMemoryProcessingJob(database, lease);
        });
        return false;
      }
      return completeNoopJob(lease, dataEpoch);
    }
  }

  await assertAutomaticMemoryAnalysisAllowed();
  const now = Date.now();
  const circuitUntil = isCircuitOpen('memory_organizer', now);
  if (circuitUntil) {
    await deferMemoryProcessingJob(database, lease, 'provider_circuit', circuitUntil, now);
    return false;
  }
  const snapshot = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
  if (!snapshot.memoryOrganizerConnection || !snapshot.memoryOrganizerKey.trim()) {
    await blockMemoryProcessingJob(database, lease, 'memory_organizer_configuration');
    return false;
  }
  if (!(await sourceStillMatches(lease))) {
    await database.withExclusiveTransactionAsync(async (database) => {
      await requeueStaleMemoryProcessingJob(database, lease);
    });
    return false;
  }
  const ai = {
    connection: snapshot.memoryOrganizerConnection,
    apiKey: snapshot.memoryOrganizerKey,
  };
  const analysisResult = lease.jobType === 'duplicate_analysis'
    ? await analyzeDuplicateMemory(lease.memoryId, ai, {
      dataEpoch,
      expectedHash: lease.desiredHash,
      throwOnProviderError: true,
      beforeRemoteRequest: assertAutomaticMemoryAnalysisAllowed,
    })
    : await analyzeMemoryContinuation(lease.memoryId, ai, {
      dataEpoch,
      expectedHash: lease.desiredHash,
      throwOnProviderError: true,
      beforeRemoteRequest: assertAutomaticMemoryAnalysisAllowed,
    });
  if (
    analysisResult
    && 'outcome' in analysisResult
    && analysisResult.outcome === 'retry_latest'
  ) {
    await database.withExclusiveTransactionAsync(async (database) => {
      await requeueStaleMemoryProcessingJob(database, lease);
    });
    return false;
  }
  const current = await loadMemoryProcessingSourceWithDatabase(database, lease.memoryId);
  if (!current) {
    clearProviderFailure('memory_organizer', lease);
    return true;
  }
  if (buildMemoryProcessingDesiredHash(current, lease.jobType) !== lease.desiredHash) {
    await database.withExclusiveTransactionAsync(async (database) => {
      await requeueStaleMemoryProcessingJob(database, lease);
    });
    return false;
  }
  const completed = await completeNoopJob(lease, dataEpoch);
  if (completed) clearProviderFailure('memory_organizer', lease);
  return completed;
}
let weeklyExecutionActive = false;

async function processClaimedJob(
  lease: MemoryProcessingJobLease,
  dataEpoch: number,
  diagnosticParentToken?: number,
  weeklyManual = false,
  replacingWeeklyCandidate?: MemoryCandidateReview,
) {
  if (lease.jobType === 'weekly_refresh' && weeklyExecutionActive) {
    await deferMemoryProcessingJob(await getMemoryDatabase(), lease, 'weekly_request_active', Date.now() + 30_000);
    return false;
  }
  const weekly = lease.jobType === 'weekly_refresh';
  if (weekly) weeklyExecutionActive = true;
  try {
    if (lease.jobType === 'weekly_refresh') {
      weeklyManual ||= !!await loadWeeklyTaskIntent(await getMemoryDatabase(), lease);
      const circuitUntil = isCircuitOpen('memory_organizer', Date.now());
      if (circuitUntil && !weeklyManual) {
        await deferMemoryProcessingJob(await getMemoryDatabase(), lease, 'provider_circuit', circuitUntil);
        return false;
      }
      const completed = await processWeeklyRefreshJob(lease, dataEpoch, weeklyManual, weeklyManual ? replacingWeeklyCandidate : undefined);
      if (completed) clearProviderFailure('memory_organizer', lease);
      return completed;
    }
    if (lease.jobType === 'source_integrity') {
      return await processSourceIntegrity(lease, dataEpoch);
    }
    if (lease.jobType === 'embedding') {
      return await processEmbedding(lease, dataEpoch, diagnosticParentToken);
    }
    return await processMemoryAnalysis(lease, dataEpoch);
  } catch (error) {
    const database = await getMemoryDatabase();
    if (lease.jobType === 'continuation_analysis' && error instanceof Error && error.message === 'memory-edge-material-changed') {
      await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        if (!(await sourceStillMatches(lease))) {
          await database.withExclusiveTransactionAsync(async transaction => {
            await requeueStaleMemoryProcessingJob(transaction, lease);
          });
        } else {
          await failMemoryProcessingJob(database, lease, 'memory_edge_material_changed');
        }
      });
      return false;
    }
    if (lease.jobType === 'weekly_refresh' && error instanceof Error && error.message === 'MEMORY_WEEKLY_STALE') {
      await requeueWeeklyRefreshJob(lease, dataEpoch);
      return false;
    }
    const classification = classifyMemoryProcessingError(error);
    if (classification.kind === 'blocked') {
      await blockMemoryProcessingJob(database, lease, classification.code);
      return false;
    }
    const provider = lease.jobType === 'embedding' ? 'embedding' : 'memory_organizer';
    const circuitUntil = /^(provider|network)_/.test(classification.code)
      ? recordProviderFailure(provider, lease, Date.now())
      : 0;
    if (circuitUntil) {
      await deferMemoryProcessingJob(database, lease, 'provider_circuit', circuitUntil);
      return false;
    }
    await failMemoryProcessingJob(database, lease, classification.code);
    return false;
  } finally {
    if (weekly) weeklyExecutionActive = false;
  }
}

function sourceIntegrityNeedsReconcile(
  source: MemoryProcessingSourceSnapshot,
) {
  if (!source.refs.length) return false;
  const times = source.refs.map((ref) => ref.message_created_at);
  return source.memory.source_trace_mode !== 'exact'
    || source.memory.source_start_at !== Math.min(...times)
    || source.memory.source_end_at !== Math.max(...times);
}

function finishMemoryProcessingReconcileSpan(outcome: 'ok' | 'failed' | 'locked') {
  reconcileSpan?.finish(outcome, {
    itemCount: reconcileState.repairCount,
    memoryCount: reconcileState.scannedCount,
  });
  reconcileSpan = null;
  reconcileSpanGeneration = -1;
}

function parseMemoryProcessingStringArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function buildReconcileEmbeddingInput(source: MemoryProcessingSourceSnapshot) {
  return {
    title: source.memory.title?.trim() || deriveMemoryTitle(source.memory.content),
    content: source.memory.content,
    domain: normalizeMemoryDomain(source.memory.domain),
    tags: parseMemoryProcessingStringArray(source.memory.tags_json),
    recallCues: parseMemoryProcessingStringArray(source.memory.recall_cues_json),
  };
}

function memoryProcessingJobDiagnosticStage(jobType: MemoryProcessingJobLease['jobType']) {
  switch (jobType) {
    case 'embedding': return 'memory.worker_job.embedding' as const;
    case 'source_integrity': return 'memory.worker_job.source_integrity' as const;
    case 'duplicate_analysis': return 'memory.worker_job.duplicate_analysis' as const;
    case 'continuation_analysis': return 'memory.worker_job.continuation_analysis' as const;
    case 'weekly_refresh': return 'memory.worker_batch' as const;
  }
}

export function setMemoryProcessingForegroundActive(active: boolean) {
  memoryProcessingForegroundActive = active;
}

/** Called after a Shiying write has released its existing database queue. */
export async function queueShiyingRecordEmbedding(id: string) {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return false;
  const source = await (await import('../shiying/shiyingMemorySource')).loadShiyingMemoryIndexSource(id);
  const database = await getMemoryDatabase();
  let changed = false;
  const committed = await runBackupRestoreDataEpochCommit(epoch, () => database.withExclusiveTransactionAsync(async transaction => {
    changed = await queueShiyingRecordEmbeddingWithDatabase(transaction, id, source);
  }));
  if (committed.committed) notifyMemoryProcessingWorkAvailable('memory_changed');
  return committed.committed && changed;
}

/** Post/source writes and reading receipts call this after their original write finishes. */
export async function queuePostSourceEmbeddings(postId: string) {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return false;
  const reader = await import('../posts/baiyunPostRecallSource');
  const [database, sources] = await Promise.all([getMemoryDatabase(), reader.listPostSourceIndexSourcesForPost(postId)]);
  const previous = await database.getAllAsync<{ id: string }>(`SELECT memory_id AS id FROM memory_embeddings WHERE target_kind = 'post_source'
    UNION SELECT memory_id AS id FROM memory_processing_jobs WHERE target_kind = 'post_source'`);
  const owners = await reader.resolvePostSourceIds(previous.map(row => row.id));
  const current = new Map(sources.map(source => [source.id, source]));
  const ids = new Set([...current.keys(), ...previous.filter(row => !owners.has(row.id) || owners.get(row.id) === postId).map(row => row.id)]);
  let changed = false;
  const committed = await runBackupRestoreDataEpochCommit(epoch, () => database.withExclusiveTransactionAsync(async transaction => {
    for (const id of ids) if (await queuePostSourceEmbeddingWithDatabase(transaction, id, current.get(id) ?? null)) changed = true;
  }));
  if (committed.committed) notifyMemoryProcessingWorkAvailable('memory_changed');
  return committed.committed && changed;
}

async function listCurrentIndexTargetPage(database: Awaited<ReturnType<typeof getMemoryDatabase>>,
  after: MemoryProcessingReconcileCursor | null, limit: number) {
  const source = await import('../shiying/shiyingMemorySource');
  const postReader = await import('../posts/baiyunPostRecallSource');
  const [page, keys, postKeys, storedPostKeys] = await Promise.all([
    listMemoryIndexTargetKeysetPage(database, { after, limit }),
    source.listShiyingMemoryIndexSourceKeys({ after: after ?? undefined, limit }),
    postReader.listPostSourceIndexSourceKeys({ after: after ?? undefined, limit }),
    database.getAllAsync<{ id: string; updatedAt: number }>(`SELECT * FROM (
      SELECT memory_id AS id, MAX(updated_at) AS updatedAt FROM (
        SELECT memory_id, updated_at FROM memory_embeddings WHERE target_kind = 'post_source'
        UNION ALL SELECT memory_id, updated_at FROM memory_processing_jobs WHERE target_kind = 'post_source') GROUP BY memory_id)
      ${after ? "WHERE updatedAt > ? OR (updatedAt = ? AND (id > ? OR (id = ? AND 'post_source' > ?)))" : ''}
      ORDER BY updatedAt, id LIMIT ?`,
    ...(after ? [after.updatedAt, after.updatedAt, after.id, after.id, after.targetKind ?? 'memory'] : []), limit),
  ]);
  // Keep a shared ID/time distinct across the original and formal-card targets.
  if (after && (after.targetKind ?? 'memory') < 'shiying_record') {
    const same = await source.loadShiyingMemoryIndexSource(after.id);
    if (same?.updatedAt === after.updatedAt) keys.unshift({ id: same.id, updatedAt: same.updatedAt });
  }
  if (after && (after.targetKind ?? 'memory') < 'post_source') {
    const same = await postReader.loadPostSourceIndexSource(after.id);
    if (same?.updatedAt === after.updatedAt) postKeys.unshift({ id: same.id, updatedAt: same.updatedAt });
  }
  const all = [...page, ...keys.map(key => ({ ...key, targetKind: 'shiying_record' as const })),
    ...postKeys.map(key => ({ ...key, targetKind: 'post_source' as const })),
    ...storedPostKeys.map(key => ({ ...key, targetKind: 'post_source' as const }))];
  const byTarget = new Map<string, typeof all[number]>();
  for (const key of all) {
    const identity = JSON.stringify([key.targetKind, key.id]);
    // A stored index's maintenance time cannot move an earlier original out of this page.
    if (!byTarget.has(identity)) byTarget.set(identity, key);
  }
  return [...byTarget.values()].filter(key => !after || key.updatedAt > after.updatedAt || key.updatedAt === after.updatedAt
    && (key.id > after.id || key.id === after.id && key.targetKind > (after.targetKind ?? 'memory')))
    .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1
      : a.targetKind < b.targetKind ? -1 : a.targetKind > b.targetKind ? 1 : 0))
    .slice(0, limit);
}

export function requestMemoryProcessingReconcile(
  reason: MemoryProcessingReconcileReason,
  options: { notBeforeMs?: number } = {},
) {
  if (reason === 'app_started') {
    if (processStartReconcileRequested) return false;
  }
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return false;
  if (reason === 'app_started') processStartReconcileRequested = true;
  if (reconcileSpan) finishMemoryProcessingReconcileSpan('failed');
  const now = Date.now();
  reconcileState = requestMemoryProcessingReconcileState(reconcileState, {
    dataEpoch,
    notBeforeAt: now + Math.max(0, options.notBeforeMs ?? 0),
    now,
    reason,
  });
  lastObservedDataEpoch = dataEpoch;
  return true;
}

function observeMemoryProcessingDataEpoch() {
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return;
  if (lastObservedDataEpoch === null) {
    lastObservedDataEpoch = dataEpoch;
    return;
  }
  if (dataEpoch !== lastObservedDataEpoch) {
    requestMemoryProcessingReconcile('data_epoch_changed');
  }
}

async function reconcileMemoryProcessingPage(
  database: Awaited<ReturnType<typeof getMemoryDatabase>>,
  page: MemoryProcessingReconcileCursor[],
  input: {
    dataEpoch: number;
    diagnosticSpan?: RuntimeWorkloadSpan;
    embeddingEnabled: boolean;
    embeddingModel: string;
    embeddingSettings: Awaited<ReturnType<typeof loadEmbeddingSettingsSnapshot>>;
    generation: number;
  },
) {
  const results: Array<{ cursor: MemoryProcessingReconcileCursor; repairCount: number }> = [];
  const { inspectPostDerivedTargets, preloadPostDerivedReadOptions } = await import('../posts/baiyunPostMemoryBasis');
  const postTargets = page.filter(cursor => cursor.targetKind !== 'shiying_record' && cursor.targetKind !== 'post_source')
    .map(cursor => ({ kind: cursor.targetKind === 'current_state' ? 'current_state' as const : 'memory' as const, id: cursor.id }));
  const shiyingIds = page.filter(cursor => cursor.targetKind === 'shiying_record').map(cursor => cursor.id);
  const shiyingSources = shiyingIds.length
    ? await (await import('../shiying/shiyingMemorySource')).loadShiyingMemoryIndexSources(shiyingIds) : new Map();
  const postSourceIds = page.filter(cursor => cursor.targetKind === 'post_source').map(cursor => cursor.id);
  const postSourceReader = postSourceIds.length ? await import('../posts/baiyunPostRecallSource') : undefined;
  const postSourceKnowledge = postSourceIds.length
    ? await (await import('../posts/baiyunPostMemorySource')).loadPostMemoryKnowledgeSnapshot(database) : undefined;
  const postOptions = await preloadPostDerivedReadOptions(database, postTargets);
  const finishCommitTiming = input.diagnosticSpan?.startTiming('itemCommitMs');
  try {
    const committed = await runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
      await database.withExclusiveTransactionAsync(async (database) => {
        const postSources = postSourceReader
          ? await postSourceReader.loadPostSourceIndexSources(postSourceIds, { database, knowledge: postSourceKnowledge }) : new Map();
        const postSourceIndexes = postSourceIds.length
          ? await loadMemoryProcessingEmbeddingIndexesWithDatabase(database, postSourceIds, 'post_source') : new Map();
        const postStatuses = new Map((await inspectPostDerivedTargets(database, postTargets, postOptions))
          .map(target => [JSON.stringify([target.kind, target.id]), target.status]));
        const finishSourceTiming = input.diagnosticSpan?.startTiming('sourceLoadMs');
        let sources: Awaited<ReturnType<typeof loadMemoryProcessingSourcesWithDatabase>>;
        try {
          sources = await loadMemoryProcessingSourcesWithDatabase(
            database,
            page.filter(key => !key.targetKind || key.targetKind === 'memory').map((key) => key.id),
          );
        } finally {
          finishSourceTiming?.();
        }
        const finishIndexTiming = input.diagnosticSpan?.startTiming('indexLookupMs');
        let indexes: Awaited<ReturnType<typeof loadMemoryProcessingEmbeddingIndexesWithDatabase>>;
        try {
          indexes = input.embeddingEnabled
            ? await loadMemoryProcessingEmbeddingIndexesWithDatabase(
              database,
              page.filter(key => !key.targetKind || key.targetKind === 'memory').map((key) => key.id),
            )
            : new Map();
        } finally {
          finishIndexTiming?.();
        }
        const finishItemTiming = input.diagnosticSpan?.startTiming('itemTotalMs');
        try {
          for (const cursor of page) {
            if (!memoryProcessingForegroundActive || reconcileState.generation !== input.generation) break;
            let repairCount = 0;
            if (cursor.targetKind === 'post_source') {
              const source = postSources.get(cursor.id) ?? null;
              const indexed = postSourceIndexes.get(cursor.id);
              if (!source || !source.indexText.trim() || input.embeddingEnabled && !hasUsablePostSourceEmbedding(indexed && {
                model: indexed.model, content_hash: indexed.contentHash, embedding_json: indexed.embeddingJson,
              }, source, input.embeddingSettings)) {
                if (await queuePostSourceEmbeddingWithDatabase(database, cursor.id, source, Date.now(), true)) repairCount += 1;
              }
              results.push({ cursor, repairCount });
              continue;
            }
            if (cursor.targetKind === 'shiying_record') {
              const source = shiyingSources.get(cursor.id) ?? null;
              const indexed = (await loadMemoryProcessingEmbeddingIndexesWithDatabase(database, [cursor.id], 'shiying_record')).get(cursor.id);
              if (!source || !source.indexText.trim() || input.embeddingEnabled && !hasUsableShiyingRecordEmbedding(indexed && {
                model: indexed.model, content_hash: indexed.contentHash, embedding_json: indexed.embeddingJson,
              }, source, input.embeddingSettings)) {
                if (await queueShiyingRecordEmbeddingWithDatabase(database, cursor.id, source, Date.now(), true)) repairCount += 1;
              }
              results.push({ cursor, repairCount });
              continue;
            }
            if (cursor.targetKind === 'current_state') {
              const state = await loadCurrentStateIndexSource(database, cursor.id);
              if (!currentStateIndexEligible(state)) {
                await queueCurrentStateEmbeddingWithDatabase(database, cursor.id);
              } else if (input.embeddingEnabled && postStatuses.get(JSON.stringify(['current_state', cursor.id])) === 'current') {
                const indexed = (await loadMemoryProcessingEmbeddingIndexesWithDatabase(database, [cursor.id], 'current_state')).get(cursor.id);
                if (!hasUsableEmbeddingRow(indexed && { model: indexed.model, content_hash: indexed.contentHash, embedding_json: indexed.embeddingJson },
                  currentStateEmbeddingText(state), input.embeddingSettings)) {
                  if (await queueCurrentStateEmbeddingWithDatabase(database, cursor.id, Date.now(), true)) repairCount += 1;
                }
              }
              results.push({ cursor, repairCount });
              continue;
            }
            const source = sources.get(cursor.id);
            const itemNow = Date.now();
            if (source && sourceIntegrityNeedsReconcile(source)) {
              const finishSourceJobTiming = input.diagnosticSpan?.startTiming('sourceJobMs');
              try {
                if (await ensureMemoryProcessingJobForSourceWithDatabase(
                  database,
                  source,
                  'source_integrity',
                  { now: itemNow },
                )) repairCount += 1;
              } finally {
                finishSourceJobTiming?.();
              }
            }
            if (source && input.embeddingEnabled && isMemoryProcessingIndexEligible(source)
              && postStatuses.get(JSON.stringify(['memory', cursor.id])) === 'current') {
              const finishMemoryTiming = input.diagnosticSpan?.startTiming('memoryLoadMs');
              let memory: ReturnType<typeof buildReconcileEmbeddingInput>;
              try {
                memory = buildReconcileEmbeddingInput(source);
              } finally {
                finishMemoryTiming?.();
              }
              let expectedHash: string;
              const finishHashTiming = input.diagnosticSpan?.startTiming('hashBuildMs');
              try {
                expectedHash = getMemoryEmbeddingHash(getMemoryEmbeddingText(memory), input.embeddingSettings);
              } finally {
                finishHashTiming?.();
              }
              const indexed = indexes.get(cursor.id);
              if (indexed?.model !== input.embeddingModel || indexed.contentHash !== expectedHash
                || !hasUsableEmbeddingRow({ model: indexed.model, content_hash: indexed.contentHash, embedding_json: indexed.embeddingJson },
                  getMemoryEmbeddingText(memory), input.embeddingSettings)) {
                const finishEmbeddingJobTiming = input.diagnosticSpan?.startTiming('embeddingJobMs');
                try {
                  if (await ensureMemoryProcessingJobForSourceWithDatabase(
                    database,
                    source,
                    'embedding',
                    { forcePending: true, now: itemNow },
                  )) repairCount += 1;
                } finally {
                  finishEmbeddingJobTiming?.();
                }
              }
            }
            results.push({ cursor, repairCount });
          }
        } finally {
          finishItemTiming?.();
        }
      });
    });
    return committed.committed
      ? results
      : page.map((cursor) => ({ cursor, repairCount: 0 }));
  } finally {
    finishCommitTiming?.();
  }
}

async function runMemoryProcessingReconcileSlice(diagnosticSpan?: RuntimeWorkloadSpan) {
  const now = Date.now();
  if (!canRunMemoryProcessingReconcileSlice(reconcileState, {
    foreground: memoryProcessingForegroundActive,
    now,
  })) return;

  const generation = reconcileState.generation;
  if (!reconcileSpan || reconcileSpanGeneration !== generation) {
    reconcileSpan = beginRuntimeWorkload('memory.worker_reconcile');
    reconcileSpanGeneration = generation;
  }

  try {
    const finishDatabaseTiming = diagnosticSpan?.startTiming('databaseOpenMs');
    let database: Awaited<ReturnType<typeof getMemoryDatabase>>;
    try {
      database = await getMemoryDatabase();
    } finally {
      finishDatabaseTiming?.();
    }
    if (reconcileState.cleanupPending) {
      const finishCleanupTiming = diagnosticSpan?.startTiming('cleanupMs');
      let cleanup: Awaited<ReturnType<typeof runBackupRestoreDataEpochCommit>>;
      try {
        cleanup = await runBackupRestoreDataEpochCommit(
          reconcileState.dataEpoch,
          async () => database.withExclusiveTransactionAsync(async (database) => {
            await releaseExpiredMemoryProcessingLeases(database, now);
            await deleteOrphanMemoryProcessingRows(database);
          }),
        );
      } finally {
        finishCleanupTiming?.();
      }
      if (!cleanup.committed) return;
      if (reconcileState.generation !== generation) return;
      reconcileState = { ...reconcileState, cleanupPending: false };
    }

    const finishSettingsTiming = diagnosticSpan?.startTiming('settingsLoadMs');
    let settings: Awaited<ReturnType<typeof loadEmbeddingSettingsSnapshot>>;
    try {
      settings = await loadReconcileEmbeddingSettings(generation);
    } finally {
      finishSettingsTiming?.();
    }
    const finishPageTiming = diagnosticSpan?.startTiming('pageLoadMs');
    let rows: Awaited<ReturnType<typeof listMemoryIndexTargetKeysetPage>>;
    try {
      rows = await listCurrentIndexTargetPage(database, reconcileState.cursor, MEMORY_RECONCILE_PAGE_SIZE + 1);
    } finally {
      finishPageTiming?.();
    }
    const page = rows.slice(0, MEMORY_RECONCILE_PAGE_SIZE);
    let processedItems = 0;
    const results = await reconcileMemoryProcessingPage(database, page, {
      dataEpoch: reconcileState.dataEpoch,
      diagnosticSpan,
      embeddingEnabled: settings.enabled,
      embeddingModel: settings.model,
      embeddingSettings: settings,
      generation,
    });
    for (const result of results) {
      if (reconcileState.generation !== generation) return;
      if (!memoryProcessingForegroundActive) break;
      reconcileState = recordMemoryProcessingReconcileItem(reconcileState, {
        cursor: result.cursor,
        generation,
        repairCount: result.repairCount,
      });
      processedItems += 1;
    }
    if (reconcileState.generation !== generation) return;
    const complete = processedItems === page.length
      && rows.length <= MEMORY_RECONCILE_PAGE_SIZE;
    reconcileState = finishMemoryProcessingReconcileSlice(reconcileState, {
      complete,
      generation,
      now: Date.now(),
    });
    if (complete) finishMemoryProcessingReconcileSpan('ok');
  } catch (error) {
    if (reconcileState.generation === generation) {
      finishMemoryProcessingReconcileSpan(isSqliteLockedError(error) ? 'locked' : 'failed');
      reconcileState = deferMemoryProcessingReconcileAfterFailure(reconcileState, {
        generation,
        now: Date.now(),
      });
    }
    throw error;
  }
}

async function buildMemoryProcessingWorkerResult(
  database: Awaited<ReturnType<typeof getMemoryDatabase>>,
  processed: number,
  options: { countDue?: boolean } = {},
): Promise<WorkerResult> {
  const now = Date.now();
  const nextWeekly = options.countDue === false ? null : await database.getFirstAsync<{ available_at: number | null }>(
    `SELECT MIN(CASE WHEN state = 'leased' THEN lease_expires_at ELSE available_at END) AS available_at
     FROM memory_processing_jobs jobs WHERE job_type = 'weekly_refresh' AND state IN ('pending', 'leased')
       AND (state = 'leased' OR EXISTS (${WEEKLY_RECHECK_INTENT_SQL}) OR NOT EXISTS (${PENDING_WEEKLY_CANDIDATE_SQL}))`);
  return {
    nextWeeklyRefreshDelayMs: options.countDue === false ? undefined
      : Math.max(0, Math.min(nextWeekly?.available_at ?? Infinity, nextWeeklyPeriodDueAt(now)) - now),
    dueRemaining: options.countDue === false
      ? 0
      : await countDueMemoryProcessingJobs(database),
    nextReconcileDelayMs: memoryProcessingReconcileDelayMs(reconcileState, now),
    processed,
    reconcilePending: reconcileState.pending,
    reconcileRepairs: reconcileState.repairCount,
    reconcileScanned: reconcileState.scannedCount,
    summary: await loadMemoryProcessingSummary(database),
  };
}

async function runMemoryProcessingBatchInternal(
  options: { mode?: MemoryProcessingBatchMode } = {},
): Promise<WorkerResult> {
  await assertMemoryDuplicateCleanupAllowsBusinessWrites();
  observeMemoryProcessingDataEpoch();
  if (getBackupRestoreRuntimeState().status !== 'ready') {
    const database = await getMemoryDatabase();
    return buildMemoryProcessingWorkerResult(database, 0, { countDue: false });
  }
  const span = beginRuntimeWorkload('memory.worker_batch');
  let processed = 0;
  try {
    const finishDatabaseTiming = span?.startTiming('databaseOpenMs');
    let database: Awaited<ReturnType<typeof getMemoryDatabase>>;
    try {
      database = await getMemoryDatabase();
    } finally {
      finishDatabaseTiming?.();
    }
    const mode = options.mode ?? 'jobs';
    await reconcileWeeklyRefreshJobs();
    if (mode === 'jobs') {
      const dataEpoch = captureBackupRestoreDataEpoch();
      if (dataEpoch !== null) {
        const lease = await claimNextMemoryProcessingJob(database, { skipWeekly: weeklyExecutionActive });
        if (lease) {
          processed = 1;
          const jobSpan = beginRuntimeWorkload(
            memoryProcessingJobDiagnosticStage(lease.jobType),
            { parentToken: span?.token },
          );
          try {
            const completed = await processClaimedJob(lease, dataEpoch, jobSpan?.token);
            jobSpan?.finish(completed ? 'ok' : 'failed');
          } catch (error) {
            jobSpan?.finish(isSqliteLockedError(error) ? 'locked' : 'failed');
            throw error;
          }
        }
      }
    }
    if (mode === 'reconcile') await runMemoryProcessingReconcileSlice(span ?? undefined);
    const finishResultTiming = span?.startTiming('resultBuildMs');
    let result: WorkerResult;
    try {
      result = await buildMemoryProcessingWorkerResult(database, processed);
    } finally {
      finishResultTiming?.();
    }
    span?.finish('ok', { itemCount: processed });
    return result;
  } catch (error) {
    span?.finish(isSqliteLockedError(error) ? 'locked' : 'failed', {
      itemCount: processed,
    });
    throw error;
  } finally {
    if (processed > 0) notifyMemoryProcessingUpdated();
  }
}

export async function runWeeklyRefreshManually(memoryId: string, replacingWeeklyCandidate?: MemoryCandidateReview,
  dataEpoch = captureBackupRestoreDataEpoch(), targetKind: 'memory' | 'weekly_period' = 'memory') {
  await assertMemoryDuplicateCleanupAllowsBusinessWrites();
  if (dataEpoch === null || !canCommitBackupRestoreDataEpoch(dataEpoch) || !memoryProcessingForegroundActive || weeklyExecutionActive) return;
  const lease = await claimNextMemoryProcessingJob(await getMemoryDatabase(), { weeklyMemoryId: memoryId,
    weeklyTargetKind: targetKind, replacingWeeklyCandidate: !!replacingWeeklyCandidate });
  if (lease) await processClaimedJob(lease, dataEpoch, undefined, true, replacingWeeklyCandidate);
}

export function runMemoryProcessingBatch(
  options: { mode?: MemoryProcessingBatchMode } = {},
) {
  if (workerFlight) return workerFlight;
  const flight = runMemoryDuplicateCleanupBusinessWrite(
    () => runMemoryProcessingBatchInternal(options),
  ).finally(() => {
    if (workerFlight === flight) workerFlight = null;
  });
  workerFlight = flight;
  return flight;
}

export async function resumeBlockedMemoryProcessingJobs() {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    const now = Date.now();
    await database.runAsync(
    `UPDATE memory_processing_jobs
        SET state = 'pending',
            available_at = ?,
            lease_id = NULL,
            lease_expires_at = NULL,
            last_error_code = NULL,
            last_error_at = NULL,
            updated_at = ?
      WHERE state = 'blocked'`,
    now,
    now,
    );
  });
}

export async function reconcileAndRetryMemoryProcessing() {
  await runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    await resetMemoryProcessingFailures(database);
  });
  notifyMemoryProcessingWorkAvailable('manual_retry');
  const database = await getMemoryDatabase();
  return loadMemoryProcessingSummary(database);
}

export async function loadMemoryProcessingWorkerSummary() {
  const database = await getMemoryDatabase();
  return loadMemoryProcessingSummary(database);
}
