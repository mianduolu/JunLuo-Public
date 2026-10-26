import {
  beginMemoryIngestionBatchWithDatabase,
  loadMemoryIngestionBatchWithDatabase,
  loadMemoryIngestionCursorWithDatabase,
  loadChatMemoryIngestionProgressWithDatabase,
  markMemoryIngestionBatchFailedWithDatabase,
  matchesSavedMemoryCandidateReceipt,
  registerMemoryIngestionOutcomeWithDatabase,
  resolveMemoryIngestionItemsWithDatabase,
  seedMemoryIngestionCursorWithDatabase,
  loadMemoryIngestionWorkWithDatabase,
  loadLatestUnfinishedMemoryIngestionWorkWithDatabase,
  updateMemoryIngestionBatchWaitingWithDatabase,
  loadWaitingMemoryCandidatesWithDatabase,
  releaseMemoryIngestionBatchWaitingWithDatabase,
  type MemoryIngestionWaiting,
  type MemoryIngestionBatchInput,
  type MemoryIngestionItemRef,
  type MemoryIngestionStream,
} from './memoryIngestionLedger';
import { runMemoryDuplicateCleanupBusinessWrite } from './memoryDuplicateCleanupState';
import { getMemoryDatabase as getMemoryDatabaseForSource } from './memoryStore';
import { memoryCandidateEditSession, memoryCandidateEditableHash, type MemoryCandidateReview } from './memoryCandidateReview';
import { notifyMemoryProcessingUpdated } from './memoryProcessingSignals';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { SQLiteDatabase } from 'expo-sqlite';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { isMemoryDatabaseBusy } from './memoryDatabaseWrites';
import {
  loadPendingMemoryCandidatesWithDatabase,
  getMemoryCandidateReviewStatus,
  updatePendingMemoryCandidatesWithDatabase,
  type PendingMemoryCandidateQuery,
} from './memoryCandidatePersistence';
import { weeklyTargetHash } from './memoryWeeklyBasis';
import { makeMemoryIngestionSourceHash } from './memoryAtomicity';
import type { PostMemoryReadOptions } from '../posts/baiyunPostMemorySource';

const getMemoryDatabase = () => getMemoryDatabaseForSource('ingestion');

export async function beginMemoryIngestionBatch(input: MemoryIngestionBatchInput) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    await database.withExclusiveTransactionAsync(async (database) => {
      await beginMemoryIngestionBatchWithDatabase(database, input);
    });
    return loadMemoryIngestionBatchWithDatabase(database, input.id);
  });
}

export async function loadMemoryIngestionBatch(batchId: string) {
  const database = await getMemoryDatabase();
  return loadMemoryIngestionBatchWithDatabase(database, batchId);
}

export async function loadMemoryIngestionWork(scopeKey: string, workId: string) {
  return loadMemoryIngestionWorkWithDatabase(await getMemoryDatabase(), scopeKey, workId);
}

export async function loadLatestUnfinishedMemoryIngestionWork(scopeKey: string) {
  return loadLatestUnfinishedMemoryIngestionWorkWithDatabase(await getMemoryDatabase(), scopeKey);
}

export async function updateMemoryIngestionBatchWaiting(batchId: string, waiting?: MemoryIngestionWaiting) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    await database.withExclusiveTransactionAsync(async transaction => {
      await updateMemoryIngestionBatchWaitingWithDatabase(transaction, batchId, waiting);
    });
    return loadMemoryIngestionBatchWithDatabase(database, batchId);
  });
}

export async function loadWaitingMemoryCandidates(batchId: string) {
  return loadWaitingMemoryCandidatesWithDatabase(await getMemoryDatabase(), batchId);
}

export async function releaseMemoryIngestionBatchWaiting(batchId: string) {
  const epoch = captureBackupRestoreDataEpoch();
  const result = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    const postOptions: PostMemoryReadOptions = await database.getFirstAsync(
      "SELECT 1 FROM memory_ingestion_items WHERE batch_id = ? AND json_array_length(candidate_json, '$.postBindings') > 0 LIMIT 1", batchId)
      ? { knowledge: await (await import('../posts/baiyunPostMemorySource')).loadPostMemoryKnowledgeSnapshot(database) } : {};
    await database.withExclusiveTransactionAsync(async transaction => {
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('memory-candidate-write-stale');
      await releaseMemoryIngestionBatchWaitingWithDatabase(transaction, batchId, async candidate =>
        (await getMemoryCandidateReviewStatus(transaction, candidate, postOptions)).status);
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('memory-candidate-write-stale');
    });
    return loadMemoryIngestionBatchWithDatabase(database, batchId);
  }));
  if (!result.committed) throw new Error('memory-candidate-write-stale');
  return result.value;
}

export async function loadSelectedMemoryIngestionBatch(scopeKey: string, sourceHash: string, sourceBatchId: string) {
  const database = await getMemoryDatabase();
  const row = await database.getFirstAsync<{ id: string }>(
    `SELECT id FROM memory_ingestion_batches WHERE scope_key = ?
     AND (source_hash = ? OR (id LIKE ? AND status IN ('pending', 'ready', 'failed')))
     AND stream = 'manual_digest' AND advances_cursor = 0 ORDER BY
     CASE WHEN status IN ('pending', 'ready', 'failed') THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 1`,
    scopeKey, sourceHash, `${sourceBatchId}-selected%`);
  return row ? loadMemoryIngestionBatchWithDatabase(database, row.id) : null;
}

export async function loadDueExplicitFactBatchIds(input: {
  automaticEnabled: boolean; musicEnabled: boolean; retryBefore: number;
}) {
  const database = await getMemoryDatabase();
  return database.getAllAsync<{ id: string }>(
    `SELECT id FROM memory_ingestion_batches
     WHERE stream = 'explicit_fact' AND status IN ('pending', 'ready', 'failed')
       AND (status IN ('pending', 'ready') OR updated_at <= ?)
       AND (? = 1 OR (scope_key = 'music_preference' AND ? = 1))
     ORDER BY updated_at, id LIMIT 1`,
    input.retryBefore, input.automaticEnabled ? 1 : 0, input.musicEnabled ? 1 : 0,
  );
}

export async function registerMemoryIngestionOutcome(input: {
  batchId: string;
  additionalBatchIds?: string[];
  canCommit?: () => boolean;
  pendingItemKeys: string[];
  suppressedItemKeys?: string[];
  pendingCandidates?: Array<{ itemKey: string; candidateJson: string }>;
}) {
  const result = await runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    const proposed = (input.pendingCandidates ?? []).map(value => JSON.parse(value.candidateJson) as MemoryCandidateReview);
    const preloadedBatches = await Promise.all([...new Set([input.batchId, ...(input.additionalBatchIds ?? [])])]
      .map(id => loadMemoryIngestionBatchWithDatabase(database, id)));
    const postOptions: PostMemoryReadOptions = proposed.some(candidate => candidate.origin === 'post' || candidate.postBindings?.length)
      || preloadedBatches.some(batch => batch?.workMetadata?.post)
      ? { knowledge: await (await import('../posts/baiyunPostMemorySource')).loadPostMemoryKnowledgeSnapshot(database) } : {};
    await database.withExclusiveTransactionAsync(async transaction => {
      if (input.canCommit && !input.canCommit()) throw new Error('memory-organizer-cancelled');
      const batch = await loadMemoryIngestionBatchWithDatabase(transaction, input.batchId);
      const ordinaryPass = batch?.advancesCursor && ['proactive', 'manual_digest'].includes(batch.stream);
      const reviewedKeys = new Set<string>();
      const readingBindings = new Map<string, import('../reading/readingMemoryOrganizationSource').ReadingOrganizationBinding>();
      for (const value of input.pendingCandidates ?? []) {
        const candidate = JSON.parse(value.candidateJson) as MemoryCandidateReview;
        if ((candidate.lifeSelfBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('life-self-v1:')))
          && !(await (await import('./lifeSelfMemoryIngestion')).validateLifeSelfCandidateSources(candidate))) throw new Error('MEMORY_SOURCE_CHANGED');
        if ((candidate.shiyingBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('shiying-source-v1:')))
          && !(await (await import('../shiying/shiyingMemorySource')).validateShiyingMemoryCandidate(candidate))) throw new Error('MEMORY_SOURCE_CHANGED');
        if (candidate.readingBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('reading-auto-v1:'))) {
          if (!(await (await import('../reading/readingMemoryOrganizationSource')).validateReadingOrganizationCandidate(candidate))) throw new Error('MEMORY_SOURCE_CHANGED');
          for (const binding of candidate.readingBindings ?? []) readingBindings.set(JSON.stringify(binding), binding);
        }
        if (candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('gift-source:'))
          && !(await (await import('../gifts/giftMemorySource')).validateGiftCandidateSources(candidate, { database: transaction }))) throw new Error('MEMORY_SOURCE_CHANGED');
        if (!(await (await import('../focus/focusMemorySource')).validateFocusCandidateSources(candidate))) throw new Error('MEMORY_SOURCE_CHANGED');
        if ((candidate.observationBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('observation-source:')))
          && !(await (await import('./memoryUnderstanding')).validateObservationCandidateSources(candidate))) throw new Error('MEMORY_SOURCE_CHANGED');
        if ((candidate.origin === 'post' || candidate.postBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('post-source:')))
          && !(await (await import('../posts/baiyunPostMemorySource')).validatePostCandidateSources(candidate, { ...postOptions, database: transaction }))) throw new Error('MEMORY_SOURCE_CHANGED');
        for (const binding of candidate.voiceBindings ?? []) {
          if (!(await (await import('../voiceCall/voiceCallMemorySource')).validateVoiceCallMaterialBinding(binding, undefined,
            { waitForPendingWrites: false }))) throw new Error('MEMORY_SOURCE_CHANGED');
        }
        if (candidate.currentStateReview) {
          const { currentStateReviewStatus } = await import('./memoryCurrentStateReview');
          if ((await currentStateReviewStatus(transaction, candidate, postOptions)).status !== 'current') throw new Error('MEMORY_CURRENT_STATE_STALE');
        }
        if (candidate.continuationReview) {
          const { isConversationMemoryCandidateCurrent } = await import('./memoryEpisodeReview');
          if (!(await isConversationMemoryCandidateCurrent(transaction, candidate, postOptions))) throw new Error('MEMORY_CONTINUATION_STALE');
        }
        // Context can contain old evidence, and another review may finish during generation.
        // Recheck at registration; explicit selected/recheck flows remain available.
        if (ordinaryPass && candidate.sourceRefs?.length) {
          let allReviewed = true;
          for (const sessionId of new Set(candidate.sourceRefs.map(ref => ref.sessionId))) {
            if (sessionId.startsWith('letter:') || sessionId.startsWith('observation-source:') || sessionId.startsWith('shiying-source-v1:') || sessionId.startsWith('life-self-v1:')) { allReviewed = false; break; }
            const ids = candidate.sourceRefs.filter(ref => ref.sessionId === sessionId).map(ref => ref.messageId);
            const reviewed = await loadReviewedChatMessageIds(transaction, sessionId, ids);
            if (ids.some(id => !reviewed.has(id))) { allReviewed = false; break; }
          }
          if (allReviewed) { reviewedKeys.add(value.itemKey); continue; }
        }
        if (candidate.understandingSubject) {
          const { isUnderstandingCandidateCurrent } = await import('./memoryUnderstanding');
          if (!(await isUnderstandingCandidateCurrent(transaction, candidate, postOptions))) throw new Error('MEMORY_UNDERSTANDING_STALE');
        }
      }
      for (const batchId of new Set([input.batchId, ...(input.additionalBatchIds ?? [])])) {
      const sourceBatch = await loadMemoryIngestionBatchWithDatabase(transaction, batchId);
      const metadata = sourceBatch?.workMetadata;
      for (const binding of metadata?.lifeSelfBindings ?? []) {
        if (!(await (await import('../life/lifeSelfMemorySource')).validateLifeSelfBinding(binding))) throw new Error('MEMORY_SOURCE_CHANGED');
      }
      for (const binding of metadata?.shiying ?? []) {
        if (!(await (await import('../shiying/shiyingMemorySource')).validateShiyingMemoryBinding(binding))) throw new Error('MEMORY_SOURCE_CHANGED');
      }
      const letter = metadata?.letter;
      const voice = metadata?.voiceCall;
      const post = metadata?.post;
      const gift = metadata?.gift;
      for (const binding of metadata?.readings ?? []) {
        if (!(await (await import('../reading/readingMemoryOrganizationSource')).validateReadingOrganizationBinding(binding))) throw new Error('MEMORY_SOURCE_CHANGED');
        readingBindings.set(JSON.stringify(binding), binding);
      }
      if (gift && !(await (await import('../gifts/giftMemorySource')).validateGiftMemoryBindings(gift.bindings, gift.dataEpoch,
        { database: transaction }))) throw new Error('MEMORY_SOURCE_CHANGED');
      for (const binding of metadata?.observations ?? []) {
        if (!(await (await import('./memoryObservationIngestion')).validateObservationBinding(binding))) throw new Error('MEMORY_SOURCE_CHANGED');
      }
      if (post && (!canCommitBackupRestoreDataEpoch(post.dataEpoch)
        || !(await (await import('../posts/baiyunPostMemorySource')).validatePostMaterialBindings(post.bindings, undefined,
          { ...postOptions, database: transaction })))) throw new Error('MEMORY_SOURCE_CHANGED');
      for (const binding of voice?.bindings ?? []) {
        if (!(await (await import('../voiceCall/voiceCallMemorySource')).validateVoiceCallMaterialBinding(binding, undefined,
          { waitForPendingWrites: false }))) throw new Error('MEMORY_SOURCE_CHANGED');
      }
      if (letter && !(await (await import('./letterMemoryIngestion')).validateLetterBinding(letter))) throw new Error('MEMORY_SOURCE_CHANGED');
      await registerMemoryIngestionOutcomeWithDatabase(transaction, {
        ...input,
        batchId,
        pendingItemKeys: input.pendingItemKeys.filter(key => !reviewedKeys.has(key) && (sourceBatch?.scopeKey !== 'shiying-record'
          || input.pendingCandidates?.some(value => value.itemKey === key && (JSON.parse(value.candidateJson) as MemoryCandidateReview).ingestionRefs?.some(ref => ref.batchId === batchId)))),
        pendingCandidates: input.pendingCandidates?.filter(value => !reviewedKeys.has(value.itemKey) && (sourceBatch?.scopeKey !== 'shiying-record'
          || (JSON.parse(value.candidateJson) as MemoryCandidateReview).ingestionRefs?.some(ref => ref.batchId === batchId))),
        suppressedItemKeys: [...(input.suppressedItemKeys ?? []), ...reviewedKeys],
      });
      }
      for (const binding of readingBindings.values()) {
        if (!(await (await import('../reading/readingMemoryOrganizationSource')).validateReadingOrganizationBinding(binding))) throw new Error('MEMORY_SOURCE_CHANGED');
      }
      for (const sourceBatch of preloadedBatches) for (const binding of sourceBatch?.workMetadata?.shiying ?? []) {
        if (!(await (await import('../shiying/shiyingMemorySource')).validateShiyingMemoryBinding(binding))) throw new Error('MEMORY_SOURCE_CHANGED');
      }
      if (input.canCommit && !input.canCommit()) throw new Error('memory-organizer-cancelled');
    });
    return loadMemoryIngestionBatchWithDatabase(database, input.batchId);
  });
  notifyMemoryProcessingUpdated();
  return result;
}

/** Only an extraction with no retained proposals can be superseded by changed source text. */
export async function retireChangedMemoryExtraction(batchId: string) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    const result = await database.runAsync("UPDATE memory_ingestion_batches SET status = 'stale', updated_at = ? WHERE id = ? AND item_count = 0 AND status IN ('pending', 'failed')", Date.now(), batchId);
    return result.changes > 0;
  });
}

export const retireChangedLetterExtraction = retireChangedMemoryExtraction;

export async function markMemoryIngestionBatchFailed(batchId: string) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    await markMemoryIngestionBatchFailedWithDatabase(database, batchId);
  });
}

let candidateEdits: Promise<void> = Promise.resolve();
let pendingCandidateEdits: {
  epoch: number | null;
  candidates: Map<string, MemoryCandidateReview>;
  write: Promise<void>;
} | undefined;
const candidateInvalidationListeners = new Set<(sessionId: string) => void>();

export function subscribeMemoryCandidateInvalidation(listener: (sessionId: string) => void) {
  candidateInvalidationListeners.add(listener);
  return () => { candidateInvalidationListeners.delete(listener); };
}

export async function loadPendingMemoryCandidates(query: PendingMemoryCandidateQuery) {
  await candidateEdits;
  return loadPendingMemoryCandidatesWithDatabase(await getMemoryDatabase(), query);
}

const candidateSaves = new Map<string, { editableHash: string; promise: Promise<string> }>();

// Chat and detail editors share this commit gate. Waiting for the autosave tail
// alone is insufficient: that tail intentionally absorbs earlier write errors.
export function runMemoryCandidateSave(candidate: MemoryCandidateReview,
  save: (stored: MemoryCandidateReview, dataEpoch: number | null) => Promise<string>,
  options: { dataEpoch?: number | null } = {}) {
  if (options.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(options.dataEpoch)) {
    return Promise.reject(new Error('memory-candidate-write-stale'));
  }
  const key = candidate.reviewId;
  const editableHash = memoryCandidateEditableHash(candidate);
  const active = candidateSaves.get(key);
  if (active) return active.editableHash === editableHash ? active.promise : Promise.reject(new Error('MEMORY_CANDIDATE_CHANGED'));
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const operation = (async () => {
    if (options.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('memory-candidate-write-stale');
    await updatePendingMemoryCandidates([candidate]);
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('memory-candidate-write-stale');
    const refs = candidate.ingestionRefs ?? [];
    if (!refs.length) return save(candidate, dataEpoch);
    const database = await getMemoryDatabase();
    if (options.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('memory-candidate-write-stale');
    // Repair a legacy partial promotion before committing the visible draft.
    // A different draft targeting the same card remains a blocker.
    for (const ref of refs) {
      const waiting = await database.getFirstAsync(
        "SELECT 1 FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ? AND status = 'waiting' AND json_extract(candidate_json, '$.reviewId') = ?",
        ref.batchId, ref.itemKey, candidate.reviewId);
      if (waiting) await releaseMemoryIngestionBatchWaiting(ref.batchId);
    }
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('memory-candidate-write-stale');
    const pending = await loadPendingMemoryCandidates({ batchIds: [...new Set(refs.map(ref => ref.batchId))] });
    if (options.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('memory-candidate-write-stale');
    const stored = pending.find(item => item.reviewId === candidate.reviewId);
    if (!stored) {
      const rows = await Promise.all(refs.map(ref => database.getFirstAsync<{ status: string; memory_id: string | null; candidate_json: string | null }>(
        'SELECT status, memory_id, candidate_json FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ?', ref.batchId, ref.itemKey)));
      if (options.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('memory-candidate-write-stale');
      const savedId = rows[0]?.memory_id;
      if (candidate.currentStateReview) {
        const stateId = rows[0]?.candidate_json ? JSON.parse(rows[0].candidate_json).savedCurrentStateId : null;
        if (stateId && rows.every(row => row?.status === 'saved' && row.candidate_json
          && JSON.parse(row.candidate_json).savedCurrentStateId === stateId
          && matchesSavedMemoryCandidateReceipt(row.candidate_json, { reviewId: candidate.reviewId, editableHash }))
          && await database.getFirstAsync('SELECT id FROM memory_current_states WHERE id = ?', stateId)
          && canCommitBackupRestoreDataEpoch(dataEpoch)) return stateId as string;
      }
      if (savedId && rows.every(row => row?.status === 'saved' && row.memory_id === savedId
        && matchesSavedMemoryCandidateReceipt(row.candidate_json, { reviewId: candidate.reviewId, editableHash }))
        && await database.getFirstAsync('SELECT id FROM memories WHERE id = ?', savedId)
        && canCommitBackupRestoreDataEpoch(dataEpoch)) return savedId;
      throw new Error('MEMORY_CANDIDATE_CHANGED');
    }
    if (memoryCandidateEditableHash(stored) !== memoryCandidateEditableHash(candidate)) throw new Error('MEMORY_CANDIDATE_CHANGED');
    if (stored.reviewStatus && stored.reviewStatus !== 'current') throw new Error(`MEMORY_CANDIDATE_${stored.reviewStatus.toUpperCase()}：${stored.reviewStatus === 'target_changed'
      ? '原卡已改变，请重新核对原卡与编辑稿。' : '依据或原卡已改变，请重新核对。'}`);
    return save(stored, dataEpoch);
  })();
  candidateSaves.set(key, { editableHash, promise: operation });
  void operation.finally(() => { if (candidateSaves.get(key)?.promise === operation) candidateSaves.delete(key); }).catch(() => undefined);
  void operation.then(() => notifyMemoryProcessingUpdated(), () => undefined);
  return operation;
}

export async function acknowledgeMemoryCandidateTarget(candidate: MemoryCandidateReview, expectedTargetHash: string) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  await updatePendingMemoryCandidates([candidate]);
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    const postOptions: PostMemoryReadOptions = candidate.postBindings?.length
      ? { knowledge: await (await import('../posts/baiyunPostMemorySource')).loadPostMemoryKnowledgeSnapshot(database) } : {};
    let updated!: MemoryCandidateReview;
    await database.withExclusiveTransactionAsync(async transaction => {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('memory-candidate-write-stale');
      const stored = (await loadPendingMemoryCandidatesWithDatabase(transaction, {
        batchIds: (candidate.ingestionRefs ?? []).map(ref => ref.batchId),
      }, postOptions)).find(item => item.reviewId === candidate.reviewId);
      if (!stored || memoryCandidateEditableHash(stored) !== memoryCandidateEditableHash(candidate)) throw new Error('MEMORY_CANDIDATE_CHANGED');
      const checked = await getMemoryCandidateReviewStatus(transaction, stored, postOptions);
      if (stored.currentStateReview) {
        const state = 'targetCurrentState' in checked ? checked.targetCurrentState : null;
        const { currentStateVersion } = await import('./memoryCurrentStateStore');
        if (checked.status !== 'target_changed' || !state || currentStateVersion(state) !== expectedTargetHash) throw new Error('MEMORY_CANDIDATE_CHANGED');
        updated = { ...stored, reviewStatus: 'current', currentStateReview: { ...stored.currentStateReview,
          targetHash: expectedTargetHash, previousTitle: state.title, previousContent: state.content } };
        for (const ref of stored.ingestionRefs ?? []) await transaction.runAsync(
          "UPDATE memory_ingestion_items SET candidate_json = ?, updated_at = ? WHERE batch_id = ? AND item_key = ? AND status = 'pending'",
          JSON.stringify(updated), Date.now(), ref.batchId, ref.itemKey);
        return;
      }
      const { status, target } = checked;
      if (status !== 'target_changed' || !target || weeklyTargetHash(target) !== expectedTargetHash) throw new Error('MEMORY_CANDIDATE_CHANGED');
      const comparison = { targetHash: expectedTargetHash, previousTitle: target.title, previousContent: target.content };
      const continuation = stored.continuationReview?.postCorrection || stored.continuationReview?.readingCorrection || stored.continuationReview?.shiyingCorrection
        ? await (await import('./memoryEpisodeReview')).rebasePostCorrectionComparison(transaction, stored.continuationReview, postOptions) : stored.continuationReview;
      updated = { ...stored, reviewStatus: 'current', understandingStale: false,
        ...(stored.readingBinding ? { readingReview: { targetMemoryId: target.id,
          targetHash: expectedTargetHash, previousDraft: { ...target } } } : {}),
        ...(stored.weeklyRefresh ? { weeklyRefresh: { ...stored.weeklyRefresh, ...comparison } } : {}),
        ...(stored.understandingReview ? { understandingReview: { ...stored.understandingReview, ...comparison } } : {}),
        ...(stored.continuationReview ? { continuationReview: { ...continuation!, ...comparison } } : {}),
      };
      if (stored.readingBindings?.length && !stored.readingBinding) {
        if (stored.understandingSubject !== target.understandingSubject) throw new Error('READING_MEMORY_TARGET_KIND_CHANGED');
        if (stored.understandingReview) updated.understandingReview = { ...stored.understandingReview,
          ...comparison, targetMemoryId: target.id };
        if (stored.continuationReview) {
          const material = await (await import('./memoryUnderstanding')).readUnderstandingMaterial(transaction, target.id,
            { allowEpisode: true, readingComparison: true });
          if (!material) throw new Error('MEMORY_EDIT_CONFLICT');
          updated.continuationReview = { ...continuation!, ...comparison, targetMemoryId: target.id, readingCorrection: true,
            evidence: [...continuation!.evidence.filter(item => item.kind !== 'memory' || item.memoryId !== target.id),
              { kind: 'memory', memoryId: target.id, hash: material.hash }] };
        }
        updated.readingCorrection = true;
      }
      for (const ref of stored.ingestionRefs ?? []) await transaction.runAsync(
        "UPDATE memory_ingestion_items SET candidate_json = ?, updated_at = ? WHERE batch_id = ? AND item_key = ? AND status = 'pending'",
        JSON.stringify(updated), Date.now(), ref.batchId, ref.itemKey);
    });
    return updated;
  }));
  if (!committed.committed) throw new Error('memory-candidate-write-stale');
  notifyMemoryProcessingUpdated();
  return committed.value;
}

async function loadReviewedChatMessageIds(database: SQLiteDatabase, sessionId: string, messageIds: string[]) {
  const ids = JSON.stringify(messageIds);
  const rows = await database.getAllAsync<{ message_id: string }>(
    `SELECT DISTINCT r.message_id FROM memory_source_refs r JOIN memories m ON m.id = r.memory_id
     WHERE r.session_id = ? AND r.relation = 'direct' AND m.confirmation_level IN ('reviewed', 'manual')
       AND r.message_id IN (SELECT value FROM json_each(?))
     UNION
     SELECT json_extract(r.value, '$.messageId') AS message_id
     FROM memory_ingestion_items i, json_each(i.candidate_json, '$.reviewedSourceRefs') r
     WHERE i.status IN ('saved', 'discarded') AND json_extract(r.value, '$.sessionId') = ?
       AND json_extract(r.value, '$.messageId') IN (SELECT value FROM json_each(?))
     UNION
     SELECT r.value AS message_id FROM memory_ingestion_batches b, json_each(b.work_metadata_json, '$.messageIds') r
     WHERE b.session_id = ? AND b.stream IN ('manual_digest', 'proactive') AND b.status IN ('ready', 'resolved', 'no_value')
       AND r.value IN (SELECT value FROM json_each(?))
     UNION
     SELECT json_extract(r.value, '$.messageId') AS message_id
     FROM memory_ingestion_items i JOIN memory_ingestion_batches b ON b.id = i.batch_id,
       json_each(i.candidate_json, '$.sourceRefs') r
     WHERE b.session_id = ? AND b.stream = 'episode' AND b.status IN ('ready', 'resolved', 'no_value')
       AND i.status = 'pending' AND json_extract(r.value, '$.sessionId') = ?
       AND json_extract(r.value, '$.relation') = 'direct'
       AND json_extract(r.value, '$.messageId') IN (SELECT value FROM json_each(?))`,
    sessionId, ids, sessionId, ids, sessionId, ids, sessionId, sessionId, ids);
  const reviewed = new Set(rows.map(row => row.message_id));
  const legacyEpisodes = await database.getAllAsync<{ source_first_message_id: string; source_last_message_id: string; source_hash: string }>(
    `SELECT source_first_message_id, source_last_message_id, source_hash FROM memory_ingestion_batches
     WHERE session_id = ? AND stream = 'episode' AND status IN ('ready', 'resolved', 'no_value')
       AND source_first_message_id IS NOT NULL AND source_last_message_id IS NOT NULL`, sessionId);
  if (legacyEpisodes.length && messageIds.some(id => !reviewed.has(id))) {
    const { loadChatSessionMessages } = await import('../chat/chatStorage');
    const originals = await loadChatSessionMessages(sessionId);
    const indexById = new Map(originals.map((message, index) => [message.id, index]));
    const requested = new Set(messageIds);
    for (const batch of legacyEpisodes) {
      const start = indexById.get(batch.source_first_message_id);
      const end = indexById.get(batch.source_last_message_id);
      if (start === undefined || end === undefined || end < start) continue;
      const range = originals.slice(start, end + 1);
      // Endpoints alone cannot prove an old selection; require the exact ordered
      // material fingerprint written by the retired episode entry.
      if (makeMemoryIngestionSourceHash(range) !== batch.source_hash) continue;
      for (const message of range) if (requested.has(message.id)) reviewed.add(message.id);
    }
  }
  return reviewed;
}

export async function filterUnreviewedChatMemoryMessages(sessionId: string, messages: SubjectiveMessage[]) {
  if (!messages.length) return [];
  const reviewed = await loadReviewedChatMessageIds(await getMemoryDatabase(), sessionId, messages.map(message => message.id));
  return messages.filter(message => !reviewed.has(message.id));
}

export function updatePendingMemoryCandidates(candidates: MemoryCandidateReview[], options: { dataEpoch?: number | null } = {}) {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return Promise.reject(new Error('memory-candidate-write-stale'));
  const editKey = (candidate: MemoryCandidateReview) => `${candidate.reviewId}\u0000${candidate[memoryCandidateEditSession]?.id ?? ''}`;
  if (pendingCandidateEdits?.epoch === dataEpoch) {
    for (const candidate of candidates) pendingCandidateEdits.candidates.set(editKey(candidate), candidate);
    return pendingCandidateEdits.write;
  }
  const batch = { epoch: dataEpoch, candidates: new Map(candidates.map(candidate => [editKey(candidate), candidate])), write: Promise.resolve() };
  const write = candidateEdits.then(async () => {
    // Coalesce typing without postponing the first edit indefinitely.
    await new Promise(resolve => setTimeout(resolve, 200));
    if (pendingCandidateEdits === batch) pendingCandidateEdits = undefined;
    const edits = [...batch.candidates.values()];
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await runBackupRestoreDataEpochCommit(dataEpoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
          const database = await getMemoryDatabase();
          let acknowledgments: Awaited<ReturnType<typeof updatePendingMemoryCandidatesWithDatabase>> = [];
          await database.withExclusiveTransactionAsync(async transaction => {
            // Recheck after waiting for other database writes, not only before queuing.
            if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('memory-candidate-write-stale');
            acknowledgments = await updatePendingMemoryCandidatesWithDatabase(transaction, edits);
          });
          return acknowledgments;
        }));
        if (!result.committed) throw new Error('memory-candidate-write-stale');
        for (const acknowledgment of result.value) acknowledgment.session.hash = acknowledgment.hash;
        break;
      } catch (error) {
        if (!isMemoryDatabaseBusy(error) || attempt >= 2 || !canCommitBackupRestoreDataEpoch(dataEpoch)) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 200 : 500));
      }
    }
    notifyMemoryProcessingUpdated();
    if (edits.some(candidate => candidate.weeklyRefresh)) {
      // Notification failure cannot turn a committed edit into a failed save.
      void import('./memoryWeeklyRefresh').then(module => module.notifyWeeklyRefreshChanges()).catch(() => undefined);
    }
  });
  batch.write = write;
  pendingCandidateEdits = batch;
  candidateEdits = write.catch(() => undefined);
  // Keep errors identifiable without logging SQL, candidate text or source messages.
  void write.catch(error => console.warn('[memory-candidate-write]',
    isMemoryDatabaseBusy(error) ? 'database_busy' : !canCommitBackupRestoreDataEpoch(dataEpoch) ? 'data_changed' : 'write_failed'));
  return write;
}

export async function clearMemoryIngestionForSession(
  sessionId: string,
  removed?: { fromAt: number } | { messageId: string },
) {
  await candidateEdits;
  await runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    const condition = !removed ? '' : 'fromAt' in removed
      ? ' AND (source_last_at >= ? OR source_last_at IS NULL)'
      : ` AND (source_first_message_id = ? OR source_last_message_id = ? OR id IN (
          SELECT batch_id FROM memory_ingestion_items
          WHERE EXISTS (SELECT 1 FROM json_each(candidate_json, '$.sourceRefs') ref
            WHERE json_extract(ref.value, '$.messageId') = ?)
          OR EXISTS (SELECT 1 FROM json_each(candidate_json, '$.reviewedSourceRefs') ref
            WHERE json_extract(ref.value, '$.messageId') = ?))
          OR EXISTS (SELECT 1 FROM json_each(work_metadata_json, '$.messageIds') WHERE value = ?)
          OR EXISTS (SELECT 1 FROM json_each(work_metadata_json, '$.selectedMessageIds') WHERE value = ?))`;
    const values = !removed ? [sessionId] : 'fromAt' in removed
      ? [sessionId, removed.fromAt] : [sessionId, removed.messageId, removed.messageId, removed.messageId, removed.messageId, removed.messageId, removed.messageId];
    await database.withExclusiveTransactionAsync(async (database) => {
      const batches = await database.getAllAsync<{ id: string; stream: string; work_metadata_json: string | null }>(
        `SELECT id, stream, work_metadata_json FROM memory_ingestion_batches WHERE session_id = ?
          AND stream != 'letter' AND json_type(work_metadata_json, '$.letter') IS NULL${condition}`, ...values,
      );
      for (const batch of batches) {
        // Evidence-dependent and legacy state drafts remain available for explicit
        // rechecking/discard even when their original chat was deleted.
        await database.runAsync(`DELETE FROM memory_ingestion_items WHERE batch_id = ?
          AND NOT (status IN ('pending', 'waiting') AND (COALESCE(json_extract(candidate_json, '$.understandingSubject'), '') IN ('I', 'you')
            OR json_extract(candidate_json, '$.continuationReview.targetMemoryId') IS NOT NULL
            OR json_type(candidate_json, '$.currentStateReview') IS NOT NULL
            OR ? = 'current_state'))`, batch.id, batch.stream);
        const pending = await database.getFirstAsync('SELECT 1 FROM memory_ingestion_items WHERE batch_id = ? LIMIT 1', batch.id);
        if (!pending && !(removed && batch.work_metadata_json)) await database.runAsync('DELETE FROM memory_ingestion_batches WHERE id = ?', batch.id);
      }
      if (!removed || 'fromAt' in removed) {
        await database.runAsync(
          `DELETE FROM memory_ingestion_cursors WHERE scope_key = ?${removed ? ' AND through_created_at >= ?' : ''}`,
          ...values,
        );
      }
    });
  });
  for (const listener of candidateInvalidationListeners) listener(sessionId);
  notifyMemoryProcessingUpdated();
}

export async function resolveMemoryIngestionItems(
  refs: MemoryIngestionItemRef[],
  resolution: 'saved' | 'discarded' | 'suppressed',
  options: { expectedCandidate?: { reviewId: string; editableHash: string }; expectedCandidateJsonHash?: string; dataEpoch?: number | null } = {},
) {
  if (!refs.length) return;
  const epoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const outcome = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    await database.withExclusiveTransactionAsync(async transaction => {
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
      await resolveMemoryIngestionItemsWithDatabase(transaction, refs, resolution, options);
    });
  }));
  if (!outcome.committed) throw new Error('MEMORY_DATA_CHANGED');
  notifyMemoryProcessingUpdated();
}

export async function loadMemoryIngestionCursor(scopeKey: string, stream: MemoryIngestionStream) {
  const database = await getMemoryDatabase();
  return loadMemoryIngestionCursorWithDatabase(database, scopeKey, stream);
}

export async function loadChatMemoryIngestionProgress(scopeKey: string) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    let result!: Awaited<ReturnType<typeof loadChatMemoryIngestionProgressWithDatabase>>;
    await database.withExclusiveTransactionAsync(async transaction => {
      result = await loadChatMemoryIngestionProgressWithDatabase(transaction, scopeKey);
    });
    return result;
  });
}

export async function seedMemoryIngestionCursor(input: {
  scopeKey: string;
  stream: MemoryIngestionStream;
  throughCreatedAt: number;
  throughMessageId: string;
}) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    await database.withExclusiveTransactionAsync(async (database) => {
      await seedMemoryIngestionCursorWithDatabase(database, input);
    });
    return loadMemoryIngestionCursorWithDatabase(database, input.scopeKey, input.stream);
  });
}
