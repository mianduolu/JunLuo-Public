import type { AiConnection } from '../ai/types';
import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { runBudgetedAiCall } from '../ai/aiCallBudget';
import { loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { stableMemoryHash, makeMemoryCandidateKey } from '../memory/memoryAtomicity';
import { makeReviewCandidates, memoryCandidateEditableHash, memoryCandidateTargetKey, type MemoryCandidateReview } from '../memory/memoryCandidateReview';
import { prepareConversationMaterials } from '../memory/memoryConversationMaterials';
import { loadMemoryIngestionBatch, loadPendingMemoryCandidates, registerMemoryIngestionOutcome,
  resolveMemoryIngestionItems, runMemoryCandidateSave, updatePendingMemoryCandidates } from '../memory/memoryIngestionService';
import { beginMemoryIngestionBatchWithDatabase, loadMemoryIngestionBatchWithDatabase, registerMemoryIngestionOutcomeWithDatabase,
  resolveMemoryIngestionItemsWithDatabase, releaseMemoryIngestionBatchWaitingWithDatabase, type MemoryIngestionBatch } from '../memory/memoryIngestionLedger';
import { loadPostMemoryIngestionBatchesWithDatabase } from '../memory/memoryIngestionLedger';
import { getMemoryCandidateReviewStatus } from '../memory/memoryCandidatePersistence';
import { runMemoryDuplicateCleanupBusinessWrite } from '../memory/memoryDuplicateCleanupState';
import { organizePostMemories } from '../memory/memoryOrganizer';
import { runMemoryOrganizerRequestWithDeadline } from '../memory/memoryOrganizerRequestLifecycle';
import { createMemory, getMemoryDatabase } from '../memory/memoryStore';
import { saveCurrentStateReview } from '../memory/memoryCurrentStateReview';
import { saveConversationMemoryCandidate } from '../memory/memoryEpisodeReview';
import { saveUnderstandingCandidate } from '../memory/memoryUnderstandingReview';
import { notifyMemoryProcessingUpdated } from '../memory/memoryProcessingSignals';
import { preparePostMemoryMaterials } from './baiyunPostMemoryMaterials';
import { loadPostMemoryOriginals, loadPostMemoryKnowledgeSnapshot, validatePostMaterialBindings, type PostMaterialRange } from './baiyunPostMemorySource';
import { loadBaiyunPostRuntime, notifyBaiyunPostsChanged, updateBaiyunPostRuntime } from './baiyunPostStore';
import { postDateKey } from './baiyunPostContract';
import type { PostMemoryRuntimeState } from './baiyunPostMemoryState';
import { preparePostCorrectionTargets, validatePostCorrectionTargets, type PostCorrectionTarget } from './baiyunPostMemoryCorrections';

const SCOPE = 'post-memory';
let running: Promise<PostMemoryRuntimeState> | null = null;
let registration: Promise<unknown> = Promise.resolve();
const checkEpoch = (epoch: number | null) => { if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED'); };
async function state(patch: Partial<PostMemoryRuntimeState>, epoch: number | null) {
  checkEpoch(epoch);
  await updateBaiyunPostRuntime(runtime => ({ ...runtime, memoryOrganization: { version: 1, ...runtime.memoryOrganization, ...patch } }), epoch);
  notifyBaiyunPostsChanged();
  return (await loadBaiyunPostRuntime()).memoryOrganization!;
}

export async function loadPostReviewCandidates() { return loadPendingMemoryCandidates({ post: true }); }

async function batches() {
  return loadPostMemoryIngestionBatchesWithDatabase(await getMemoryDatabase());
}

async function processedRanges(): Promise<PostMaterialRange[]> {
  return (await batches()).filter(batch => ['resolved', 'no_value'].includes(batch.status))
    .flatMap(batch => batch.workMetadata?.post?.newRanges ?? []);
}

async function clearCached(batchId: string, epoch: number | null, retire = false) {
  const database = await getMemoryDatabase();
  await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(() => database.withExclusiveTransactionAsync(async transaction => {
    const latest = await loadMemoryIngestionBatchWithDatabase(transaction, batchId);
    if (!latest?.workMetadata?.post) return;
    const { cachedCandidates: _candidates, replaces: _replaces, ...post } = latest.workMetadata.post;
    await transaction.runAsync('UPDATE memory_ingestion_batches SET work_metadata_json = ? WHERE id = ?',
      JSON.stringify({ ...latest.workMetadata, post }), batchId);
    if (retire && !latest.itemCount) await transaction.runAsync(
      "UPDATE memory_ingestion_batches SET status = 'failed', completed_at = NULL, updated_at = ? WHERE id = ?", Date.now(), batchId);
  })));
}

/** Paid results stay in the existing batch JSON until registration succeeds. */
function registerCached(batch: MemoryIngestionBatch, epoch: number | null): Promise<boolean> {
  // Recovery and foreground preparation can meet here. Reload after joining
  // the local registration lane so an old snapshot cannot overwrite edits.
  const operation = registration.then(async () => {
    checkEpoch(epoch);
    const latest = await loadMemoryIngestionBatch(batch.id);
    return latest ? registerCachedBatch(latest, epoch) : false;
  });
  registration = operation.then(() => undefined, () => undefined);
  return operation;
}

async function registerCachedBatch(batch: MemoryIngestionBatch, epoch: number | null) {
  const work = batch.workMetadata?.post;
  if (!work?.cachedCandidates) return false;
  if (['ready', 'resolved', 'no_value', 'waiting'].includes(batch.status) && batch.itemCount) { await clearCached(batch.id, epoch); return true; }
  const valid = await validatePostMaterialBindings(work.bindings);
  if (!valid || work.dataEpoch !== epoch) {
    if (work.replaces || !work.cachedCandidates.length) {
      // There is no new review to preserve. Keep the original draft and leave
      // all ranges unconsumed, allowing a later explicit recheck to start.
      await clearCached(batch.id, epoch, true);
      await state({ status: 'needs_recheck', cachedBatchId: undefined }, epoch);
      return false;
    }
    // A generated proposal is kept for review, but cannot be saved against new sources.
    const database = await getMemoryDatabase();
    const result = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(() => database.withExclusiveTransactionAsync(async transaction => {
      await registerMemoryIngestionOutcomeWithDatabase(transaction, { batchId: batch.id,
        pendingItemKeys: work.cachedCandidates!.map(makeMemoryCandidateKey),
        pendingCandidates: work.cachedCandidates!.map(candidate => ({ itemKey: makeMemoryCandidateKey(candidate),
          candidateJson: JSON.stringify({ ...candidate, reviewStatus: 'basis_changed' }) })) });
    })));
    if (!result.committed) throw new Error('MEMORY_DATA_CHANGED');
    await state({ status: 'needs_recheck', cachedBatchId: undefined }, epoch);
    return true;
  }
  if (work.replaces) {
    const knowledge = await loadPostMemoryKnowledgeSnapshot(), database = await getMemoryDatabase();
    let commit;
    try { commit = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(() => database.withExclusiveTransactionAsync(async transaction => {
      const previous = await transaction.getFirstAsync<{ candidate_json: string }>(
        "SELECT candidate_json FROM memory_ingestion_items WHERE status = 'pending' AND json_extract(candidate_json, '$.reviewId') = ?", work.replaces!.reviewId);
      if (!previous || memoryCandidateEditableHash(JSON.parse(previous.candidate_json)) !== work.replaces!.editableHash) throw new Error('MEMORY_CANDIDATE_CHANGED');
      if (!(await validatePostMaterialBindings(work.bindings, undefined, { database: transaction, knowledge }))) throw new Error('POST_MEMORY_SOURCE_CHANGED');
      for (const candidate of work.cachedCandidates!) {
        if ((await getMemoryCandidateReviewStatus(transaction, candidate, { database: transaction, knowledge })).status !== 'current') throw new Error('POST_MEMORY_SOURCE_CHANGED');
      }
      await resolveMemoryIngestionItemsWithDatabase(transaction, work.replaces!.refs, 'suppressed');
      await registerMemoryIngestionOutcomeWithDatabase(transaction, { batchId: batch.id, pendingItemKeys: work.cachedCandidates!.map(makeMemoryCandidateKey),
        pendingCandidates: work.cachedCandidates!.map(candidate => ({ itemKey: makeMemoryCandidateKey(candidate), candidateJson: JSON.stringify(candidate) })) });
    }))); } catch (error) {
      if (error instanceof Error && ['MEMORY_CANDIDATE_CHANGED', 'POST_MEMORY_SOURCE_CHANGED'].includes(error.message)) {
        await clearCached(batch.id, epoch, true);
        await state({ status: 'needs_recheck', cachedBatchId: undefined }, epoch);
        return false;
      }
      throw error;
    }
    if (!commit.committed) throw new Error('MEMORY_DATA_CHANGED');
  } else await registerMemoryIngestionOutcome({ batchId: batch.id, canCommit: () => canCommitBackupRestoreDataEpoch(epoch),
      pendingItemKeys: work.cachedCandidates.map(makeMemoryCandidateKey),
      pendingCandidates: work.cachedCandidates.map(candidate => ({ itemKey: makeMemoryCandidateKey(candidate), candidateJson: JSON.stringify(candidate) })) });
  await clearCached(batch.id, epoch);
  await state({ cachedBatchId: undefined, status: work.cachedCandidates.length ? 'ready' : 'empty', error: undefined }, epoch);
  notifyMemoryProcessingUpdated();
  return true;
}

export async function recoverPostMemoryOrganization(epoch = captureBackupRestoreDataEpoch()) {
  checkEpoch(epoch);
  for (const batch of await batches()) {
    if (!['resolved', 'no_value', 'stale'].includes(batch.status) && batch.workMetadata?.post?.cachedCandidates) await registerCached(batch, epoch);
    if (batch.status === 'waiting') {
      const knowledge = await loadPostMemoryKnowledgeSnapshot();
      const database = await getMemoryDatabase();
      await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(() => database.withExclusiveTransactionAsync(async transaction => {
        await releaseMemoryIngestionBatchWaitingWithDatabase(transaction, batch.id, async candidate =>
          (await getMemoryCandidateReviewStatus(transaction, candidate, { database: transaction, knowledge })).status);
      })));
    }
  }
}

export function organizePostMemory(input: { manual?: boolean; now?: number; apiKey?: string; connection?: AiConnection;
  recheck?: MemoryCandidateReview } = {}): Promise<PostMemoryRuntimeState> {
  // A normal/manual wake joins this exact preparation. Rechecking a different
  // proposal must wait and prepare its own sources, never reuse another result.
  if (running) {
    const current = running;
    if (input.recheck) return current.catch(() => undefined).then(() => organizePostMemory(input));
    if (input.manual) return (async () => {
      await current.catch(() => undefined);
      // A manual click must not be swallowed by an automatic no-op (before
      // evening/day limit). Pending/settled checks below avoid a second call.
      return organizePostMemory(input);
    })();
    return current;
  }
  const operation = runOrganization(input);
  running = operation;
  void operation.finally(() => { if (running === operation) running = null; }).catch(() => undefined);
  return operation;
}

async function runOrganization(input: Parameters<typeof organizePostMemory>[0] = {}) {
  const epoch = captureBackupRestoreDataEpoch(), now = input.now ?? Date.now(), day = postDateKey(now);
  await recoverPostMemoryOrganization(epoch);
  const pending = await loadPostReviewCandidates();
  if (!input.recheck && (pending.length || (await batches()).some(batch => batch.status === 'waiting'))) return state({ status: 'waiting_review' }, epoch);
  if (input.recheck && !pending.some(candidate => candidate.reviewId === input.recheck!.reviewId)) throw new Error('POST_MEMORY_REVIEW_PENDING');
  const preservedReviews = new Set(input.recheck ? pending.map(candidate => candidate.reviewId) : []);
  if (input.recheck) await updatePendingMemoryCandidates([input.recheck]);
  const runtime = (await loadBaiyunPostRuntime()).memoryOrganization;
  if (!input.manual && (new Date(now).getHours() < 21 || runtime?.automaticDay === day)) {
    return runtime?.automaticDay === day ? runtime : state({ status: 'before_evening' }, epoch);
  }
  const policy = await loadAutomaticRemoteAiPolicy();
  if (!input.manual && !policy.enabled) return state({ status: 'disabled' }, epoch);
  const config = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
  const connection = input.connection ?? config.memoryOrganizerConnection, apiKey = input.apiKey ?? config.memoryOrganizerKey;
  if (!connection || !apiKey.trim()) return state({ status: 'configuration' }, epoch);
  const originals = await loadPostMemoryOriginals(input.recheck?.postBindings?.map(binding => binding.postId));
  const correctionTarget = input.recheck?.postCorrection ? input.recheck.currentStateReview?.targetCurrentStateId
    ? { kind: 'current_state' as const, id: input.recheck.currentStateReview.targetCurrentStateId }
    : { kind: 'memory' as const, id: (input.recheck.understandingReview?.targetMemoryId ?? input.recheck.continuationReview?.targetMemoryId)! } : undefined;
  let corrections: PostCorrectionTarget[] = input.recheck && !correctionTarget ? []
    : (await preparePostCorrectionTargets(originals, await batches(), { target: correctionTarget, retry: !!input.recheck })).slice(0, 2);
  if (correctionTarget && !corrections.length) return state({ status: 'needs_recheck' }, epoch);
  const correctedSourceIds = new Set(corrections.flatMap(target => target.sourceIds));
  const correctionOriginals = originals.filter(original => correctedSourceIds.has(original.messageId));
  const material = preparePostMemoryMaterials(corrections.length ? correctionOriginals : originals,
    input.recheck || corrections.length ? [] : await processedRanges());
  if (!material.newRanges.length) return state({ status: material.blocked.length ? 'long_sentence' : 'empty' }, epoch);
  const sourceHash = stableMemoryHash(JSON.stringify([material.bindings, corrections.map(target => target.key)]));
  const batchId = `post-memory:${sourceHash}${input.recheck ? `:recheck:${input.recheck.reviewId}` : ''}`;
  const existing = await loadMemoryIngestionBatch(batchId);
  if (existing?.workMetadata?.post?.cachedCandidates) {
    if (await registerCached(existing, epoch)) return (await loadBaiyunPostRuntime()).memoryOrganization ?? { version: 1 };
  }
  checkEpoch(epoch);
  const requestId = `${batchId}:${now}`;
  try {
    const generated = await runBudgetedAiCall('memoryPostOrganize', input.manual ? 'normal' : 'background', admission =>
      runMemoryOrganizerRequestWithDeadline(async signal => {
        const understandingMaterials = await prepareConversationMaterials({ sessionId: SCOPE, messages: material.messages,
          postBindings: material.bindings, signal, background: !input.manual,
          postCorrectionTargets: corrections,
          targetMemoryId: input.recheck?.understandingReview?.targetMemoryId ?? input.recheck?.continuationReview?.targetMemoryId ?? undefined,
          targetCurrentStateId: input.recheck?.currentStateReview?.targetCurrentStateId ?? undefined });
        corrections = corrections.filter(target => target.kind === 'memory'
          ? understandingMaterials.targets.some(memory => memory.id === target.id) || understandingMaterials.memories.some(item => item.memory.id === target.id)
          : understandingMaterials.currentStates?.some(state => state.id === target.id));
        if (correctedSourceIds.size && !corrections.length) throw new Error('POST_MEMORY_CORRECTION_TARGET_UNAVAILABLE');
        await validatePostCorrectionTargets(corrections);
        return organizePostMemories({ apiKey, connection, materials: material, understandingMaterials, signal,
          beforeTransport: () => admission.beforeTransport(async () => {
            checkEpoch(epoch);
            if ((await loadPostReviewCandidates()).some(candidate => !preservedReviews.has(candidate.reviewId))) throw new Error('POST_MEMORY_REVIEW_PENDING');
            await updateBaiyunPostRuntime(value => {
              if (!input.manual && value.memoryOrganization?.automaticDay === day) throw new Error('POST_MEMORY_DAILY_LIMIT');
              return { ...value, memoryOrganization: { ...value.memoryOrganization, version: 1,
                ...(input.manual ? {} : { automaticDay: day }), requestId, status: 'running', error: undefined } };
            }, epoch);
          }, () => checkEpoch(epoch)) });
      }), { connection, dataEpoch: epoch, ...(input.manual ? {} : { purpose: 'other' as const }) });
    if (generated.ok === false) return state({ status: 'budget', retryAt: generated.retryAfter }, epoch);
    checkEpoch(epoch);
    let candidates = makeReviewCandidates(generated.value, 'post', { messages: material.messages });
    if (corrections.length) {
      const seen = new Set<string>();
      for (const candidate of candidates) {
        const key = memoryCandidateTargetKey(candidate);
        const target = corrections.find(target => (target.kind === 'current_state' ? `current_state:${target.id}` : target.id) === key);
        if (!target || seen.has(key!) || !(candidate.sourceRefs ?? []).some(ref => ref.relation === 'direct'
          && target.sourceIds.includes(ref.messageId) && material.bindings.some(binding => binding.purpose === 'new'
            && binding.sessionId === ref.sessionId && binding.messageId === ref.messageId))) throw new Error('POST_MEMORY_CORRECTION_NO_MATCH');
        seen.add(key!);
      }
      await validatePostCorrectionTargets(corrections);
      candidates = candidates.map(candidate => ({ ...candidate, postCorrection: true }));
    }
    if (input.recheck) {
      const previous = input.recheck;
      const target = memoryCandidateTargetKey(previous);
      const matching = candidates.filter(candidate => memoryCandidateTargetKey(candidate) === target
        && !!candidate.currentStateReview === !!previous.currentStateReview && candidate.understandingSubject === previous.understandingSubject
        && !!candidate.continuationReview === !!previous.continuationReview);
      if (matching.length !== 1) throw new Error('POST_MEMORY_RECHECK_NO_MATCH');
      candidates = matching;
    }
    candidates = candidates.map(candidate => ({ ...candidate, postDataEpoch: epoch, ingestionRefs: [{ batchId, itemKey: makeMemoryCandidateKey(candidate) }] }));
    const database = await getMemoryDatabase();
    const workMetadata = { version: 1 as const, workId: batchId, messageIds: material.messages.map(message => message.id),
      post: { bindings: material.bindings, newRanges: material.newRanges, cachedCandidates: candidates, dataEpoch: epoch,
        ...(corrections.length ? { corrections: corrections.map(({ kind, id, key }) => ({ kind, id, key })) } : {}),
        ...(input.recheck ? { replaces: { reviewId: input.recheck.reviewId, editableHash: memoryCandidateEditableHash(input.recheck), refs: input.recheck.ingestionRefs ?? [] } } : {}) } };
    const cacheResult = () => runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(() => database.withExclusiveTransactionAsync(async transaction => {
      await beginMemoryIngestionBatchWithDatabase(transaction, { id: batchId, stream: 'post', scopeKey: SCOPE,
        advancesCursor: false, sourceHash, workMetadata });
      // Failed registrations retain this exact paid result, with stable review IDs.
      await transaction.runAsync('UPDATE memory_ingestion_batches SET work_metadata_json = ? WHERE id = ? AND item_count = 0',
        JSON.stringify(workMetadata), batchId);
    })));
    // Retry local registration writes only; the paid generation is never rerun
    // within this processing identity. A restore still terminates immediately.
    for (let attempt = 0; ; attempt++) {
      try { const commit = await cacheResult(); if (!commit.committed) throw new Error('MEMORY_DATA_CHANGED'); break; }
      catch (error) { if (attempt >= 2 || !canCommitBackupRestoreDataEpoch(epoch)) throw error; }
    }
    await state({ cachedBatchId: batchId }, epoch);
    await registerCached((await loadMemoryIngestionBatch(batchId))!, epoch);
    return (await loadBaiyunPostRuntime()).memoryOrganization!;
  } catch (error) {
    if (canCommitBackupRestoreDataEpoch(epoch)) await state({ status: 'failed', error: error instanceof Error ? error.message : 'post-memory-failed' }, epoch);
    throw error;
  }
}

export async function savePostReviewCandidate(candidate: MemoryCandidateReview, epoch = captureBackupRestoreDataEpoch(), continueOrganization = true) {
  checkEpoch(epoch);
  if (candidate.origin !== 'post' || !candidate.postBindings?.length) throw new Error('POST_MEMORY_SOURCE_INVALID');
  if ((candidate.rememberedReason ?? '').trim().length > 80) throw new Error('记住的理由最多80字符，请缩短后保存。');
  let saved: unknown;
  if (candidate.currentStateReview) saved = await saveCurrentStateReview(candidate, { dataEpoch: epoch });
  else if (candidate.continuationReview) saved = await saveConversationMemoryCandidate(candidate, { dataEpoch: epoch });
  else if (candidate.understandingSubject) saved = await saveUnderstandingCandidate(candidate, { dataEpoch: epoch });
  else saved = await runMemoryCandidateSave(candidate, (stored, dataEpoch) => createMemory(stored, {
    confirmationLevel: 'reviewed', ingestionResolutions: stored.ingestionRefs, requirePendingIngestion: true, dataEpoch,
    ingestionExpectedCandidate: { reviewId: stored.reviewId, editableHash: memoryCandidateEditableHash(stored) },
    sourceRefs: stored.sourceRefs, sourceTraceMode: 'exact',
  }), { dataEpoch: epoch });
  notifyMemoryProcessingUpdated(); notifyBaiyunPostsChanged();
  if (continueOrganization) void organizePostMemory().catch(() => undefined);
  return saved;
}

export async function discardPostReviewCandidate(candidate: MemoryCandidateReview, epoch = captureBackupRestoreDataEpoch(), continueOrganization = true) {
  checkEpoch(epoch);
  const result = await runBackupRestoreDataEpochCommit(epoch, () => resolveMemoryIngestionItems(candidate.ingestionRefs ?? [], 'discarded', {
    dataEpoch: epoch, expectedCandidate: { reviewId: candidate.reviewId, editableHash: memoryCandidateEditableHash(candidate) },
  }));
  if (!result.committed) throw new Error('MEMORY_DATA_CHANGED');
  notifyMemoryProcessingUpdated(); notifyBaiyunPostsChanged();
  if (continueOrganization) void organizePostMemory().catch(() => undefined);
}

export async function loadPostMemoryOrganizationStatus() {
  return (await loadBaiyunPostRuntime()).memoryOrganization;
}

export async function loadPostReviewSourceText(candidate: MemoryCandidateReview) {
  const originals = await loadPostMemoryOriginals(candidate.postBindings?.map(binding => binding.postId));
  return (candidate.postBindings ?? []).map(binding => {
    const current = originals.find(item => item.sessionId === binding.sessionId && item.messageId === binding.messageId);
    if (!current) return '原话未找到';
    return `${current.kind === 'post' ? '原动态' : '留言'} · ${current.role === 'I' ? '白云小姐' : '小仓鼠'} · ${new Date(current.createdAt).toLocaleString('zh-CN', { hour12: false })}\n${current.content}`;
  }).join('\n\n');
}
