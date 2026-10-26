import type { SQLiteDatabase } from 'expo-sqlite';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import type { MemoryCandidateReview } from './memoryCandidateReview';
import { makeReviewCandidates, memoryCandidateEditableHash } from './memoryCandidateReview';
import { loadPendingMemoryCandidates, runMemoryCandidateSave, updatePendingMemoryCandidates } from './memoryIngestionService';
import { createMemory, getMemoryDatabase, loadMemory, updateMemory, type MemorySourceRefInput } from './memoryStore';
import { readUnderstandingMaterial, readUnderstandingMessage, readUnderstandingObservation, prepareRecheckMessages, type UnderstandingEvidence, type UnderstandingMaterials, type UnderstandingMessage } from './memoryUnderstanding';
import { buildObservationMemorySourceRefs } from './memorySourceRefs';
import { weeklyTargetHash } from './memoryWeeklyBasis';
import { stableMemoryHash, makeMemoryCandidateKey } from './memoryAtomicity';
import { beginMemoryIngestionBatchWithDatabase, loadMemoryIngestionBatchWithDatabase, registerMemoryIngestionOutcomeWithDatabase, resolveMemoryIngestionItemsWithDatabase } from './memoryIngestionLedger';
import { runMemoryOrganizerRequestWithDeadline } from './memoryOrganizerRequestLifecycle';
import { validateVoiceCallMaterialBinding, type VoiceCallMaterialBinding } from '../voiceCall/voiceCallMemorySource';
import type { PostMemoryReadOptions } from '../posts/baiyunPostMemorySource';
import { episodeSummaryDraftHash, isEpisodeSummaryReviewCurrent } from './memoryEpisodeSummaryReview';
import { memoryDehydrationSource } from './memoryCurrentMaterials';
import { runMemoryDuplicateCleanupBusinessWrite } from './memoryDuplicateCleanupState';

export type ContinuationReview = {
  shiyingCorrection?: boolean;
  postCorrection?: boolean;
  readingCorrection?: boolean;
  targetMemoryId: string | null; targetHash?: string; previousTitle?: string; previousContent?: string;
  evidence: UnderstandingEvidence[]; dataEpoch?: number | null;
};
type Reader = Pick<SQLiteDatabase, 'getFirstAsync' | 'getAllAsync'>;

function sourceIds(value: unknown, maximum: number, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum
    || value.some(id => typeof id !== 'string' || !id.trim()) || new Set(value).size !== value.length) {
    throw new Error('memory-continuation-source-invalid');
  }
  return value;
}

export function continuationCandidateEvidence(item: { targetMemoryId?: unknown; sourceMessageIds?: unknown; sourceMemoryIds?: unknown; sourceObservationIds?: unknown }, materials: UnderstandingMaterials) {
  if (!materials.continuationEnabled) throw new Error('memory-continuation-not-enabled');
  const observationIds = sourceIds(item.sourceObservationIds ?? [], 6);
  const messageIds = sourceIds(item.sourceMessageIds, 6, observationIds.length ? 0 : 1);
  if (messageIds.length + observationIds.length > 6) throw new Error('memory-continuation-source-invalid');
  const observations = observationIds.map(id => {
    const source = materials.observations?.find(item => item.binding.observationId === id);
    if (!source) throw new Error('memory-continuation-source-invalid');
    return source;
  });
  const memoryIds = sourceIds(item.sourceMemoryIds, 6);
  if (memoryIds.some(id => materials.postComparisonTargetIds?.includes(id) || materials.readingComparisonTargetIds?.includes(id) || materials.shiyingComparisonTargetIds?.includes(id))) throw new Error('memory-continuation-source-invalid');
  if (item.targetMemoryId !== null && (typeof item.targetMemoryId !== 'string'
    || !materials.episodeTargetIds?.includes(item.targetMemoryId))) throw new Error('memory-continuation-target-invalid');
  const target = item.targetMemoryId === null ? undefined : materials.memories.find(m => m.memory.id === item.targetMemoryId);
  if (item.targetMemoryId !== null && !target) throw new Error('memory-continuation-target-invalid');
  const evidence: UnderstandingEvidence[] = messageIds.map(id => {
    const source = materials.batchMessages.find(m => m.message.id === id);
    if (!source) throw new Error('memory-continuation-source-invalid');
    return { kind: 'message', sessionId: source.sessionId, messageId: id, hash: source.hash };
  });
  evidence.push(...observations.map(source => ({ kind: 'observation' as const, observationId: source.binding.observationId, hash: source.binding.sourceHash })));
  for (const id of new Set([...memoryIds, ...(target ? [target.memory.id] : [])])) {
    const source = materials.memories.find(m => m.memory.id === id);
    if (!source) throw new Error('memory-continuation-source-invalid');
    evidence.push({ kind: 'memory', memoryId: id, hash: source.hash });
  }
  const sourceRefs: MemorySourceRefInput[] = messageIds.map(id => {
    const source = materials.batchMessages.find(m => m.message.id === id)!;
    return { sessionId: source.sessionId, messageId: id, role: source.message.role,
      messageCreatedAt: source.message.createdAt, relation: 'direct' as const, excerpt: source.message.content };
  });
  sourceRefs.push(...buildObservationMemorySourceRefs(observations.map(source => source.binding)));
  for (const id of memoryIds) {
    const source = materials.memories.find(m => m.memory.id === id)!;
    sourceRefs.push(...source.sourceRefs.map(ref => ({ ...ref, relation: 'derived' as const })));
  }
  return { continuationReview: { targetMemoryId: target?.memory.id ?? null,
    ...(target && materials.postComparisonTargetIds?.includes(target.memory.id) ? { postCorrection: true } : {}),
    ...(target && materials.readingComparisonTargetIds?.includes(target.memory.id) ? { readingCorrection: true } : {}),
    ...(target && materials.shiyingComparisonTargetIds?.includes(target.memory.id) ? { shiyingCorrection: true } : {}),
    ...(target ? { targetHash: weeklyTargetHash(target.memory), previousTitle: target.memory.title, previousContent: target.memory.content } : {}),
    evidence, dataEpoch: materials.dataEpoch } satisfies ContinuationReview, sourceRefs };
}

export async function isConversationMemoryCandidateCurrent(database: Reader, candidate: Pick<MemoryCandidateReview, 'continuationReview' | 'postBindings' | 'sourceRefs'> & { voiceBindings?: VoiceCallMaterialBinding[] },
  postOptions: PostMemoryReadOptions = {}) {
  const review = candidate.continuationReview;
  if (!review) return true;
  if ((candidate.postBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('post-source:')))
    && !(await (await import('../posts/baiyunPostMemorySource')).validatePostCandidateSources(candidate, { ...postOptions, database }))) return false;
  for (const binding of candidate.voiceBindings ?? []) if (!(await validateVoiceCallMaterialBinding(binding, undefined, { waitForPendingWrites: false }))) return false;
  if (review.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(review.dataEpoch)) return false;
  if (!review.evidence.length || !review.evidence.some(e => e.kind === 'message' || e.kind === 'observation')) return false;
  const committedOnly = review.evidence.some(evidence => evidence.kind === 'message' && evidence.sessionId.startsWith('voice-call:'));
  for (const evidence of review.evidence) {
    const current = evidence.kind === 'observation' ? await readUnderstandingObservation(evidence.observationId)
      : evidence.kind === 'message' ? await readUnderstandingMessage(evidence.sessionId, evidence.messageId,
      { ...postOptions, database, waitForPendingWrites: !committedOnly })
      : await readUnderstandingMaterial(database, evidence.memoryId, { ...postOptions, allowEpisode: true,
        postComparison: review.postCorrection && evidence.memoryId === review.targetMemoryId,
        readingComparison: review.readingCorrection && evidence.memoryId === review.targetMemoryId,
        shiyingComparison: review.shiyingCorrection && evidence.memoryId === review.targetMemoryId });
    if (!current || current.hash !== evidence.hash) return false;
  }
  if (!review.targetMemoryId) return true;
  const target = await readUnderstandingMaterial(database, review.targetMemoryId, { ...postOptions, allowEpisode: true,
    postComparison: review.postCorrection, readingComparison: review.readingCorrection, shiyingComparison: review.shiyingCorrection });
  return !!target && weeklyTargetHash(target.memory) === review.targetHash;
}

export async function validateConversationMemoryCandidates<T extends Pick<MemoryCandidateReview, 'continuationReview'>>(candidates: T[]) {
  if (!candidates.some(c => c.continuationReview)) return candidates;
  const database = await getMemoryDatabase();
  for (const candidate of candidates) {
    if (!(await isConversationMemoryCandidateCurrent(database, candidate))) throw new Error('MEMORY_CONTINUATION_STALE');
  }
  return candidates;
}

/** A correction's old card is comparison material, not evidence for the new fact. */
export async function rebasePostCorrectionComparison(database: Reader, review: ContinuationReview | undefined,
  postOptions: PostMemoryReadOptions = {}) {
  if ((!review?.postCorrection && !review?.readingCorrection && !review?.shiyingCorrection) || !review.targetMemoryId) return review;
  const target = await readUnderstandingMaterial(database, review.targetMemoryId, { ...postOptions, allowEpisode: true,
    postComparison: review.postCorrection, readingComparison: review.readingCorrection, shiyingComparison: review.shiyingCorrection });
  if (!target) return review;
  return { ...review, targetHash: weeklyTargetHash(target.memory), evidence: review.evidence.map(evidence =>
    evidence.kind === 'memory' && evidence.memoryId === review.targetMemoryId ? { ...evidence, hash: target.hash } : evidence) };
}

export async function saveConversationMemoryCandidate(candidate: MemoryCandidateReview, options: { dataEpoch?: number | null } = {}) {
  if (options.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(options.dataEpoch)) throw new Error('memory-candidate-write-stale');
  const evidence = candidate.continuationReview?.evidence ?? [];
  if (evidence.some(item => item.kind === 'message' && item.sessionId.startsWith('voice-call:'))) {
    for (const item of evidence) if (item.kind === 'message') {
      if (options.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(options.dataEpoch)) throw new Error('memory-candidate-write-stale');
      await readUnderstandingMessage(item.sessionId, item.messageId);
      if (options.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(options.dataEpoch)) throw new Error('memory-candidate-write-stale');
    }
  }
  return runMemoryCandidateSave(candidate, async (stored, dataEpoch) => {
    if (!stored.continuationReview) throw new Error('没有可确认的接续稿。');
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const database = await getMemoryDatabase();
      if (!(await isConversationMemoryCandidateCurrent(database, stored))) throw new Error('原话或原卡已改变，请重新整理；草稿已保留。');
      const review = stored.continuationReview!;
      const current = review.targetMemoryId ? await loadMemory(review.targetMemoryId) : null;
      if (review.targetMemoryId && !current) throw new Error('原卡已不存在；草稿已保留。');
      const oldMaterial = current ? await readUnderstandingMaterial(database, current.id, { allowEpisode: true,
        postComparison: review.postCorrection, readingComparison: review.readingCorrection, shiyingComparison: review.shiyingCorrection }) : null;
      let sourceRefs = stored.readingBindings?.length
        ? (await import('../reading/readingMemoryOrganizationSource')).replaceReadingOrganizationSourceRefs(oldMaterial?.sourceRefs ?? [], stored.sourceRefs ?? [], stored.readingBindings)
        : [...(stored.sourceRefs ?? []), ...(oldMaterial?.sourceRefs ?? [])];
      if (stored.shiyingBindings?.length) sourceRefs = (await import('../shiying/shiyingMemorySource'))
        .replaceShiyingMemorySourceRefs(oldMaterial?.sourceRefs ?? [], stored.sourceRefs ?? [], stored.shiyingBindings);
      const options = { confirmationLevel: 'reviewed' as const, sourceRefs,
        ...(stored.postCorrection || stored.readingCorrection || stored.shiyingCorrection ? { writeIntent: 'correction' as const } : {}),
        ingestionResolutions: stored.ingestionRefs, requirePendingIngestion: true, dataEpoch,
        conversationReview: review, expectedEditableHash: review.targetHash,
        ...(isEpisodeSummaryReviewCurrent(stored) ? { confirmedEpisodeSummary: {
          content: stored.episodeSummary!.trim(), draftHash: stored.episodeSummaryReview!.draftHash,
          ...(stored.episodeSummaryReview!.targetSource ? { targetSource: stored.episodeSummaryReview!.targetSource } : {}),
        } } : {}),
        ingestionExpectedCandidate: { reviewId: stored.reviewId, editableHash: memoryCandidateEditableHash(stored) } };
      if (current) {
        const result = await updateMemory(current.id, { ...current, ...stored,
          // Runtime state and original identity do not come from an extraction draft.
          type: current.type, protected: current.protected, resolved: current.resolved, digested: current.digested,
          source: current.source, sourceType: current.sourceType,
          ...(stored.readingCorrection || stored.shiyingCorrection ? { atomicKind: current.atomicKind, semanticType: current.semanticType,
            understandingSubject: current.understandingSubject } : {}) }, options);
        return result.id;
      }
      return createMemory(stored, options);
    });
    if (!committed.committed) throw new Error('数据正在恢复，请稍后确认。');
    return committed.value;
  }, options);
}

/** A distinct local acknowledgement, never a generic editable-field patch. */
export async function acknowledgeEpisodeSummaryCandidate(candidate: MemoryCandidateReview): Promise<MemoryCandidateReview> {
  const epoch = captureBackupRestoreDataEpoch();
  await updatePendingMemoryCandidates([candidate]);
  const committed = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    let updated!: MemoryCandidateReview;
    await database.withExclusiveTransactionAsync(async transaction => {
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
      const { getMemoryCandidateReviewStatus, loadPendingMemoryCandidatesWithDatabase } = await import('./memoryCandidatePersistence');
      const stored = (await loadPendingMemoryCandidatesWithDatabase(transaction,
        { batchIds: (candidate.ingestionRefs ?? []).map(ref => ref.batchId) })).find(item => item.reviewId === candidate.reviewId);
      if (!stored || memoryCandidateEditableHash(stored) !== memoryCandidateEditableHash(candidate)) throw new Error('MEMORY_CANDIDATE_CHANGED');
      if (!stored.episodeSummaryEnabled || !stored.continuationReview || stored.source !== 'episode-memory'
        || typeof stored.episodeSummary !== 'string' || !stored.episodeSummary.trim() || stored.episodeSummary.trim().length > 120) {
        throw new Error('MEMORY_EPISODE_SUMMARY_INVALID');
      }
      if ((await getMemoryCandidateReviewStatus(transaction, stored)).status !== 'current') throw new Error('MEMORY_CONTINUATION_STALE');
      const target = stored.continuationReview.targetMemoryId ? await readUnderstandingMaterial(transaction,
        stored.continuationReview.targetMemoryId, { allowEpisode: true, postComparison: stored.continuationReview.postCorrection,
          readingComparison: stored.continuationReview.readingCorrection, shiyingComparison: stored.continuationReview.shiyingCorrection }) : null;
      if (stored.continuationReview.targetMemoryId && !target) throw new Error('MEMORY_CONTINUATION_STALE');
      const targetSource = target ? memoryDehydrationSource(target.memory, target.comments) : undefined;
      updated = { ...stored, episodeSummaryReview: { draftHash: episodeSummaryDraftHash(stored, stored.episodeSummary, targetSource),
        ...(targetSource ? { targetSource } : {}) } };
      for (const ref of stored.ingestionRefs ?? []) {
        const result = await transaction.runAsync(
          "UPDATE memory_ingestion_items SET candidate_json = ?, updated_at = ? WHERE batch_id = ? AND item_key = ? AND status = 'pending' AND json_extract(candidate_json, '$.reviewId') = ?",
          JSON.stringify(updated), Date.now(), ref.batchId, ref.itemKey, stored.reviewId);
        if (result.changes !== 1) throw new Error('MEMORY_CANDIDATE_CHANGED');
      }
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
    });
    return updated;
  }));
  if (!committed.committed) throw new Error('MEMORY_DATA_CHANGED');
  return committed.value;
}

const rechecks = new Map<string, Promise<MemoryCandidateReview>>();
export function recheckConversationMemoryCandidate(candidate: MemoryCandidateReview) {
  if (candidate.shiyingBindings?.length) return import('../shiying/shiyingMemoryReview')
    .then(module => module.recheckShiyingMemoryCandidate(candidate));
  if (candidate.readingBindings?.length) return (import('../reading/readingMemoryOrganizationReview')
    .then(module => module.recheckReadingOrganizationCandidate(candidate)));
  const active = rechecks.get(candidate.reviewId);
  if (active) return active;
  const request = prepareConversationRecheck(candidate).finally(() => { rechecks.delete(candidate.reviewId); });
  rechecks.set(candidate.reviewId, request);
  return request;
}

async function prepareConversationRecheck(candidate: MemoryCandidateReview): Promise<MemoryCandidateReview> {
  const epoch = captureBackupRestoreDataEpoch();
  await updatePendingMemoryCandidates([candidate]);
  const pending = await loadPendingMemoryCandidates({ batchIds: (candidate.ingestionRefs ?? []).map(ref => ref.batchId) });
  const original = pending.find(item => item.reviewId === candidate.reviewId);
  const ordinaryLetter = !!(original?.letterBindings?.length || original?.observationBindings?.length) && !original.continuationReview
    && !original.understandingSubject && !original.currentStateReview && !original.weeklyRefresh && original.source !== 'weekly-context';
  if (!original || (!original.continuationReview && !ordinaryLetter)
    || memoryCandidateEditableHash(original) !== memoryCandidateEditableHash(candidate)) {
    throw new Error('草稿已改变，请保留输入后重新核对。');
  }
  const targetId = original.continuationReview?.targetMemoryId ?? null;
  const loaded: UnderstandingMessage[] = [];
  const messageSources = original.continuationReview?.evidence.filter(evidence => evidence.kind === 'message')
    ?? [...(original.sourceRefs ?? []).filter(ref => (ref.relation ?? 'direct') === 'direct'), ...(original.letterBindings ?? [])];
  for (const evidence of messageSources) {
    if (evidence.sessionId.startsWith('observation-source:')) continue;
    if (loaded.some(source => source.sessionId === evidence.sessionId && source.message.id === evidence.messageId)) continue;
    const current = await readUnderstandingMessage(evidence.sessionId, evidence.messageId);
    if (!current) throw new Error('原话已缺失，原稿和输入已保留。');
    loaded.push(current);
  }
  const recheck = await prepareRecheckMessages(loaded, original.letterBindings, original.voiceBindings);
  const sessionId = recheck.sessionId || (original.observationBindings?.length ? (await import('../chat/primaryChat')).PRIMARY_CHAT_SESSION_ID : '');
  const { originals, letterBindings, voiceBindings } = recheck;
  const giftSource = originals.some(source => source.sessionId.startsWith('gift-source:'))
    ? await (await import('../gifts/giftMemorySource')).prepareGiftMemoryRecheck(originals, epoch) : undefined;
  const observationMaterials = await (await import('./memoryUnderstanding')).prepareObservationRecheckMaterials(original.observationBindings, sessionId);
  if (!sessionId || originals.some(source => !source.sessionId.startsWith('letter:') && !source.voiceBinding && source.sessionId !== sessionId)) throw new Error('本批原话无法确认，原稿和输入已保留。');
  const { loadAiConfigPreferencesSnapshot } = await import('../ai/AiConfigPreferences');
  const config = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
  if (!config.memoryOrganizerConnection || !config.memoryOrganizerKey.trim()) throw new Error('请先配置记忆整理模型。');
  const { prepareUnderstandingMaterials } = await import('./memoryUnderstanding');
  const materials = await prepareUnderstandingMaterials({ sessionId, messages: originals.map(source => source.message),
    continuationEnabled: !ordinaryLetter, targetMemoryId: targetId ?? undefined, letterBindings, voiceBindings, observationMaterials,
    recalledIds: original.continuationReview?.evidence.flatMap(evidence => evidence.kind === 'memory' ? [evidence.memoryId] : []) });
  if (targetId && !materials.episodeTargetIds?.includes(targetId)) throw new Error('原卡不可用或未能装入本次材料；草稿已保留。');
  const { organizeConversationMemories } = await import('./memoryOrganizer');
  const drafts = await runMemoryOrganizerRequestWithDeadline(signal => organizeConversationMemories({
    apiKey: config.memoryOrganizerKey, connection: config.memoryOrganizerConnection!, messages: originals.map(source => source.message),
    understandingMaterials: materials, signal,
    episodeSummaryEnabled: original.episodeSummaryEnabled === true,
    ...(giftSource ? { giftSourceEnvelope: giftSource.envelope } : {}),
  }), { timeoutMs: 60_000 });
  const draft = ordinaryLetter ? drafts.length === 1 && !drafts[0].understandingSubject && !drafts[0].currentStateReview
    && !drafts[0].continuationReview && !!(drafts[0].letterBindings?.length || drafts[0].observationBindings?.length) ? drafts[0] : undefined
    : drafts.find(item => item.continuationReview?.targetMemoryId === targetId);
  if (!draft) throw new Error('本次没有生成对应更新稿；原稿和输入已保留。');
  if (ordinaryLetter) {
    draft.sourceRefs = [...draft.sourceMessageIds.map(messageId => {
      const source = originals.find(item => item.message.id === messageId);
      if (!source) throw new Error('MEMORY_SOURCE_CHANGED');
      return { sessionId: source.sessionId, messageId, role: source.message.role,
        messageCreatedAt: source.message.createdAt, relation: 'direct' as const, excerpt: source.message.content };
    }), ...buildObservationMemorySourceRefs(draft.observationBindings ?? [])];
  }
  const [replacement] = makeReviewCandidates([draft], original.origin, { sessionId, messages: originals.map(source => source.message) });
  if (giftSource) Object.assign(replacement, (await import('../gifts/giftMemorySource')).giftMemoryCandidateForPersistence(replacement));
  const batchId = `conversation-review-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const itemKey = makeMemoryCandidateKey(replacement);
  replacement.ingestionRefs = [{ batchId, itemKey }];
  const committed = await runBackupRestoreDataEpochCommit(epoch, async () => {
    const database = await getMemoryDatabase();
    await database.withExclusiveTransactionAsync(async transaction => {
      const { loadPendingMemoryCandidatesWithDatabase } = await import('./memoryCandidatePersistence');
      const current = (await loadPendingMemoryCandidatesWithDatabase(transaction,
        { batchIds: (original.ingestionRefs ?? []).map(ref => ref.batchId) })).find(item => item.reviewId === original.reviewId);
      if (!current || memoryCandidateEditableHash(current) !== memoryCandidateEditableHash(original)
        || JSON.stringify(current.continuationReview) !== JSON.stringify(original.continuationReview)
        || (ordinaryLetter && (JSON.stringify(current.letterBindings) !== JSON.stringify(original.letterBindings)
          || JSON.stringify(current.sourceRefs) !== JSON.stringify(original.sourceRefs)))) throw new Error('草稿已改变，请重新查看；本次没有覆盖输入。');
      if (!(await isConversationMemoryCandidateCurrent(transaction, replacement))) throw new Error('MEMORY_CONTINUATION_STALE');
      if (ordinaryLetter) {
        const { validateLetterBinding } = await import('./letterMemoryIngestion');
        for (const binding of letterBindings) if (!(await validateLetterBinding(binding))) throw new Error('MEMORY_SOURCE_CHANGED');
        for (const source of originals) {
          const currentSource = await readUnderstandingMessage(source.sessionId, source.message.id);
          if (!currentSource || currentSource.hash !== source.hash) throw new Error('MEMORY_SOURCE_CHANGED');
        }
      }
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
      if (giftSource && !(await (await import('../gifts/giftMemorySource')).validateGiftMemoryBindings(giftSource.metadata.bindings,
        epoch, { database: transaction }))) throw new Error('MEMORY_SOURCE_CHANGED');
      const hostBatch = ordinaryLetter ? await loadMemoryIngestionBatchWithDatabase(transaction, current.ingestionRefs![0].batchId) : null;
      if (ordinaryLetter && !hostBatch) throw new Error('MEMORY_CANDIDATE_CHANGED');
      await beginMemoryIngestionBatchWithDatabase(transaction, { id: batchId,
        sessionId: giftSource ? (await import('../chat/primaryChat')).PRIMARY_CHAT_SESSION_ID : hostBatch?.sessionId ?? sessionId,
        scopeKey: `conversation-review:${targetId ?? original.reviewId}`,
        sourceHash: stableMemoryHash(JSON.stringify([materials.text, materials.batchMessages.map(source => source.hash)])), stream: 'manual_digest', advancesCursor: false,
        ...(letterBindings[0] || giftSource ? { workMetadata: { version: 1 as const, workId: batchId, messageIds: [],
          ...(letterBindings[0] ? { letter: letterBindings[0] } : {}), ...(giftSource ? { gift: giftSource.metadata } : {}) } } : {}) });
      await resolveMemoryIngestionItemsWithDatabase(transaction, original.ingestionRefs ?? [], 'suppressed');
      await registerMemoryIngestionOutcomeWithDatabase(transaction, { batchId, pendingItemKeys: [itemKey],
        pendingCandidates: [{ itemKey, candidateJson: JSON.stringify(replacement) }] });
    });
  });
  if (!committed.committed) throw new Error('数据正在恢复，请稍后重新核对。');
  // The existing candidate restore subscription already covers both chat and details.
  await import('./memoryUnderstandingReview').then(module => module.notifyUnderstandingChanges()).catch(() => undefined);
  return replacement;
}
