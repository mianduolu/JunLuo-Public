import type { SQLiteDatabase } from 'expo-sqlite';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { stableMemoryHash, makeMemoryCandidateKey } from './memoryAtomicity';
import { memoryCandidateEditableHash, makeReviewCandidates, type MemoryCandidateReview } from './memoryCandidateReview';
import { currentStateVersion, loadMemoryCurrentState, writeMemoryCurrentStateWithDatabase, type MemoryCurrentState } from './memoryCurrentStateStore';
import { getMemoryDatabase, type MemoryDraft } from './memoryStore';
import { runMemoryCandidateSave, updatePendingMemoryCandidates } from './memoryIngestionService';
import { resolveMemoryIngestionItemsWithDatabase, beginMemoryIngestionBatchWithDatabase, registerMemoryIngestionOutcomeWithDatabase } from './memoryIngestionLedger';
import { readUnderstandingMessage, readUnderstandingObservation, understandingMessageHash, prepareUnderstandingMaterials, prepareRecheckMessages, type UnderstandingMaterials, type UnderstandingMessage } from './memoryUnderstanding';
import { buildObservationMemorySourceRefs } from './memorySourceRefs';
import { runMemoryDuplicateCleanupBusinessWrite } from './memoryDuplicateCleanupState';
import { notifyMemoryProcessingWorkAvailable } from './memoryProcessingSignals';
import { runMemoryOrganizerRequestWithDeadline } from './memoryOrganizerRequestLifecycle';
import type { MemoryCurrentStateCandidate, MemoryCurrentStateResolveCandidate } from './memoryCurrentStateCandidates';
import { getVoiceCallMemorySourceInfo, validateVoiceCallMaterialBinding, type VoiceCallMaterialBinding } from '../voiceCall/voiceCallMemorySource';
import { isFocusMemorySource, validateFocusCandidateSources, validateFocusMaterialBindings,
  type FocusMaterialBinding } from '../focus/focusMemorySource';
import type { PostMemoryReadOptions } from '../posts/baiyunPostMemorySource';

export type CurrentStateReview = {
  shiyingComparison?: boolean;
  postComparison?: boolean;
  action: 'create' | 'update' | 'close'; targetCurrentStateId: string | null;
  targetHash?: string; previousTitle?: string; previousContent?: string;
  targetSourcesHash?: string;
  targetFocusBindings?: FocusMaterialBinding[];
  knownAt?: number; evidence: Array<{ sessionId: string; messageId: string; hash: string } | { kind: 'observation'; observationId: string; hash: string }>;
  dataEpoch?: number | null;
};
type Reader = Pick<SQLiteDatabase, 'getFirstAsync' | 'getAllAsync'>;

// A memory transaction must not wait for the chat writer: that writer may be
// checking these same memory rows before appending a proactive reply.
async function readCommittedStateEvidence(sessionId: string, messageId: string, postOptions: PostMemoryReadOptions = {}) {
  if (sessionId.startsWith('post-source:') || sessionId.startsWith('gift-source:')) return readUnderstandingMessage(sessionId, messageId, postOptions);
  if (isFocusMemorySource(sessionId)) return readUnderstandingMessage(sessionId, messageId, { waitForPendingWrites: false });
  if (sessionId.startsWith('reading-auto-v1:')) return readUnderstandingMessage(sessionId, messageId);
  if (sessionId.startsWith('shiying-source-v1:')) return readUnderstandingMessage(sessionId, messageId);
  if (sessionId.startsWith('letter:')) return readUnderstandingMessage(sessionId, messageId);
  if (sessionId.startsWith('voice-call:')) return readUnderstandingMessage(sessionId, messageId, { waitForPendingWrites: false });
  const { loadChatSessionMessagePage } = await import('../chat/chatStorage');
  let beforeIndex: number | undefined;
  for (;;) {
    const page = await loadChatSessionMessagePage(sessionId, { limit: 100, beforeIndex, waitForPendingWrites: false });
    const message = page.messages.find(item => item.id === messageId);
    if (message) return message.deliveryStatus !== 'failed' && (message.role === 'I' || message.role === 'you')
      && message.content.trim() ? { sessionId, message, hash: understandingMessageHash(sessionId, message) } : null;
    if (!page.startIndex || beforeIndex !== undefined && page.startIndex >= beforeIndex) return null;
    beforeIndex = page.startIndex;
  }
}

export const CURRENT_STATE_ORGANIZER_PROMPT = `【记着近况，接着了解】
I 想以后再问问 you 这件事的新情况，才记成近况。
只想记住发生过什么，就记普通记忆。
同一件事有了进展，I 就更新原来的记录；分不清是不是同一件事，就先不合并。
I 记下最新情况，注明是什么时候得知的。
好转了、暂时停下了，都不等于结束；没再提起，I 也不猜现在怎样。
事情结束了，I 才提出收起；还在继续的，就留着。
I 把近况建议和其他候选放在同一个 JSON 数组里，近况只填下面五项。
currentStateAction：新记填 create，更新填 update，确认结束填 close。
targetCurrentStateId：新记填 null；更新或结束，I 填本次材料里的原近况编号。
title：这件事的简短名称。
content：I 写改好后的完整近况；结束时也写清最后的情况。
sourceMessageIds：I 填支持本次新内容的本批原话编号，1–6 个。`;

export function isCurrentStateProposal(item: object) {
  return 'currentStateAction' in item || 'targetCurrentStateId' in item;
}

export function parseCurrentStateProposal(item: Record<string, unknown>, materials?: UnderstandingMaterials) {
  const action = item.currentStateAction;
  const ids = item.sourceMessageIds;
  const observationIds = item.sourceObservationIds ?? [];
  const allowed = ['currentStateAction', 'targetCurrentStateId', 'title', 'content', 'sourceMessageIds',
    ...(materials?.observations?.length || materials?.relatedObservations?.length ? ['sourceObservationIds'] : [])];
  if (!materials?.currentStatesEnabled || !['create', 'update', 'close'].includes(action as string)
    || Object.keys(item).some(key => !allowed.includes(key)) || allowed.some(key => !(key in item))
    || typeof item.title !== 'string' || !item.title.trim() || typeof item.content !== 'string' || !item.content.trim()
    || !Array.isArray(ids) || !Array.isArray(observationIds) || ids.length + observationIds.length < 1 || ids.length + observationIds.length > 6
    || new Set(ids).size !== ids.length || new Set(observationIds).size !== observationIds.length
    || observationIds.some(id => typeof id !== 'string' || !id)
    || ids.some(id => typeof id !== 'string' || !id)) throw new Error('memory-current-state-contract-invalid');
  const target = materials.currentStates?.find(state => state.id === item.targetCurrentStateId);
  if (action === 'create' ? item.targetCurrentStateId !== null : !target || target.status !== 'active') {
    throw new Error('memory-current-state-target-invalid');
  }
  const sources = ids.map(id => {
    const source = materials.batchMessages.find(value => value.message.id === id);
    if (!source) throw new Error('memory-current-state-source-invalid');
    return source;
  });
  const observations = observationIds.map(id => {
    const source = materials.observations?.find(value => value.binding.observationId === id);
    if (!source) throw new Error('memory-current-state-source-invalid');
    return source;
  });
  const times = [...sources.map(source => source.message.createdAt), ...observations.map(source => source.binding.capturedAt)]
    .filter(time => Number.isFinite(time) && time > 0);
  const currentStateReview: CurrentStateReview = {
    action: action as CurrentStateReview['action'], targetCurrentStateId: target?.id ?? null,
    ...(target ? { targetHash: currentStateVersion(target), previousTitle: target.title, previousContent: target.content,
      ...(materials.postComparisonStateIds?.includes(target.id) ? { postComparison: true } : {}),
      ...(materials.shiyingComparisonStateIds?.includes(target.id) ? { shiyingComparison: true } : {}),
      targetSourcesHash: materials.currentStateSourceHashes?.[target.id],
      ...(materials.currentStateFocusBindings?.[target.id]?.length
        ? { targetFocusBindings: materials.currentStateFocusBindings[target.id] } : {}) } : {}),
    knownAt: times.length ? Math.max(...times) : undefined,
    evidence: [...sources.map(source => ({ sessionId: source.sessionId, messageId: source.message.id, hash: source.hash })),
      ...observations.map(source => ({ kind: 'observation' as const, observationId: source.binding.observationId, hash: source.binding.sourceHash }))],
    dataEpoch: materials.dataEpoch,
  };
  // These defaults only adapt the existing local editor carrier. This proposal is
  // committed exclusively to current_states, never materialized as a memory.
  const draft: MemoryDraft = { title: item.title.trim(), content: item.content.trim(), domain: '其他', tags: [],
    recallCues: [], importance: 5, valence: 0.5, arousal: 0.3, pinned: false, anchor: false,
    type: 'dynamic', resolved: false, digested: false, protected: false, sourceType: 'digest' };
  return { ...draft, currentStateReview, sourceMessageIds: ids as string[], sourceObservationIds: observationIds as string[],
    sourceRefs: [...sources.map(({ sessionId, message }) => ({ sessionId, messageId: message.id, role: message.role,
      messageCreatedAt: message.createdAt, relation: 'direct' as const, excerpt: message.content,
      contentHash: getVoiceCallMemorySourceInfo(message)?.contentHash ?? stableMemoryHash(message.content) })),
      ...buildObservationMemorySourceRefs(observations.map(source => source.binding))] };
}

export async function currentStateReviewStatus(database: Reader, candidate: Pick<MemoryCandidateReview, 'currentStateReview' | 'sourceRefs' | 'focusBindings' | 'postBindings' | 'shiyingBindings'> & { voiceBindings?: VoiceCallMaterialBinding[] },
  postOptions: PostMemoryReadOptions = {}) {
  const review = candidate.currentStateReview;
  const targetCurrentState = review?.targetCurrentStateId ? await loadMemoryCurrentState(review.targetCurrentStateId, database) : null;
  const result = (status: NonNullable<MemoryCandidateReview['reviewStatus']>) => ({ status, target: undefined, targetCurrentState });
  if (!review) return result('current');
  if ((candidate.postBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('post-source:')))
    && !(await (await import('../posts/baiyunPostMemorySource')).validatePostCandidateSources(candidate, { ...postOptions, database }))) return result('basis_changed');
  if (!(await validateFocusCandidateSources(candidate))) return result('basis_changed');
  if ((candidate.shiyingBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('shiying-source-v1:')))
    && !(await (await import('../shiying/shiyingMemorySource')).validateShiyingMemoryCandidate(candidate))) return result('basis_changed');
  if (candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('reading-auto-v1:'))
    && !(await (await import('../reading/readingMemoryOrganizationSource')).validateReadingOrganizationCandidate(candidate))) return result('basis_changed');
  if (!(await validateFocusMaterialBindings(review.targetFocusBindings ?? []))) return result('basis_changed');
  for (const binding of candidate.voiceBindings ?? []) if (!(await validateVoiceCallMaterialBinding(binding, undefined, { waitForPendingWrites: false }))) return result('basis_changed');
  if (review.targetCurrentStateId && !targetCurrentState) return result('missing');
  if (targetCurrentState && targetCurrentState.status !== 'active') return result('archived');
  if (review.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(review.dataEpoch)) return result('basis_changed');
  if (!review.evidence.length) return result('basis_changed');
  for (const evidence of review.evidence) {
    const source = 'observationId' in evidence ? await readUnderstandingObservation(evidence.observationId)
      : await readCommittedStateEvidence(evidence.sessionId, evidence.messageId, { ...postOptions, database });
    if (!source || source.hash !== evidence.hash) return result('basis_changed');
  }
  if (targetCurrentState && review.targetSourcesHash) {
    const { loadCurrentStateReadSnapshot } = await import('./memoryReadMaterials');
    const snapshot = await loadCurrentStateReadSnapshot(targetCurrentState.id, 'source', database,
      async (sessionId, messageId) => (await readCommittedStateEvidence(sessionId, messageId, { ...postOptions, database }))?.message ?? null,
      { postComparison: review.postComparison, shiyingComparison: review.shiyingComparison, postOptions });
    if (typeof snapshot === 'string' || stableMemoryHash(JSON.stringify(snapshot.parts)) !== review.targetSourcesHash) return result('basis_changed');
  }
  return result(targetCurrentState && currentStateVersion(targetCurrentState) !== review.targetHash ? 'target_changed' : 'current');
}

export async function validateCurrentStateCandidates<T extends Pick<MemoryCandidateReview, 'currentStateReview'>>(candidates: T[]) {
  if (!candidates.some(candidate => candidate.currentStateReview)) return candidates;
  const database = await getMemoryDatabase();
  for (const candidate of candidates) if ((await currentStateReviewStatus(database, candidate)).status !== 'current') {
    throw new Error('MEMORY_CURRENT_STATE_STALE');
  }
  return candidates;
}

export async function saveCurrentStateReview(candidate: MemoryCandidateReview, options: { dataEpoch?: number | null } = {}) {
  if (options.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(options.dataEpoch)) throw new Error('memory-candidate-write-stale');
  // Drain existing chat writes before entering the memory writer/transaction.
  // The transaction then rereads committed originals without reversing the locks.
  for (const evidence of candidate.currentStateReview?.evidence ?? []) {
    if (options.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(options.dataEpoch)) throw new Error('memory-candidate-write-stale');
    if ('observationId' in evidence) await readUnderstandingObservation(evidence.observationId);
    else await readUnderstandingMessage(evidence.sessionId, evidence.messageId);
    if (options.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(options.dataEpoch)) throw new Error('memory-candidate-write-stale');
  }
  return runMemoryCandidateSave(candidate, async (stored, epoch) => {
    const postOptions: PostMemoryReadOptions = stored.postBindings?.length
      ? { knowledge: await (await import('../posts/baiyunPostMemorySource')).loadPostMemoryKnowledgeSnapshot() } : {};
    const result = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
      const database = await getMemoryDatabase();
      let saved!: MemoryCurrentState;
      await database.withExclusiveTransactionAsync(async transaction => {
        const { loadPendingMemoryCandidatesWithDatabase } = await import('./memoryCandidatePersistence');
        const current = (await loadPendingMemoryCandidatesWithDatabase(transaction,
          { batchIds: (stored.ingestionRefs ?? []).map(ref => ref.batchId) }, postOptions)).find(item => item.reviewId === stored.reviewId);
        if (!current || memoryCandidateEditableHash(current) !== memoryCandidateEditableHash(stored)
          || JSON.stringify(current.currentStateReview) !== JSON.stringify(stored.currentStateReview)) throw new Error('MEMORY_CANDIDATE_CHANGED');
        const checked = await currentStateReviewStatus(transaction, current, postOptions);
        if (checked.status !== 'current') throw new Error('MEMORY_CURRENT_STATE_STALE');
        const review = current.currentStateReview!;
        saved = await writeMemoryCurrentStateWithDatabase(transaction, { action: review.action,
          id: review.targetCurrentStateId ?? undefined, expectedVersion: review.targetHash,
          title: current.title, content: current.content, knownAt: review.knownAt, sourceRefs: current.sourceRefs,
          sourceType: 'candidate', sourceCandidateId: current.reviewId });
        if (current.shiyingBindings?.length && checked.targetCurrentState) {
          const refs = (await import('../shiying/shiyingMemorySource')).replaceShiyingMemorySourceRefs(
            checked.targetCurrentState.sourceRefs, current.sourceRefs ?? [], current.shiyingBindings);
          await transaction.runAsync('UPDATE memory_current_states SET source_refs_json=? WHERE id=?', JSON.stringify(refs), saved.id);
          saved = { ...saved, sourceRefs: refs };
        }
        if ((await currentStateReviewStatus(transaction, { ...current, currentStateReview: { ...review,
          targetCurrentStateId: null } }, postOptions)).status !== 'current') throw new Error('MEMORY_CURRENT_STATE_STALE');
        if (checked.targetCurrentState && review.targetSourcesHash) {
          // Recheck exactly the old quotations used for this proposal. The new
          // saved row has appended sources (and close is no longer active).
          const { loadCurrentStateSourceParts } = await import('./memoryReadMaterials');
          const parts = await loadCurrentStateSourceParts(checked.targetCurrentState,
            async (sessionId, messageId) => (await readCommittedStateEvidence(sessionId, messageId, { ...postOptions, database: transaction }))?.message ?? null);
          if (stableMemoryHash(JSON.stringify(parts)) !== review.targetSourcesHash) throw new Error('MEMORY_CURRENT_STATE_STALE');
        }
        await resolveMemoryIngestionItemsWithDatabase(transaction, current.ingestionRefs ?? [], 'saved', { currentStateId: saved.id });
        if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
      });
      return saved.id;
    }));
    if (!result.committed) throw new Error('数据正在恢复，请稍后确认。');
    notifyMemoryProcessingWorkAvailable('memory_changed');
    return result.value;
  }, options);
}

type StateReviewInput = MemoryCandidateReview | MemoryCurrentStateCandidate | MemoryCurrentStateResolveCandidate;
const rechecks = new Map<string, Promise<MemoryCandidateReview>>();
export function recheckCurrentStateCandidate(input: StateReviewInput) {
  if ('shiyingBindings' in input && input.shiyingBindings?.length) return import('../shiying/shiyingMemoryReview')
    .then(module => module.recheckShiyingMemoryCandidate(input as MemoryCandidateReview));
  const pending = rechecks.get(input.reviewId);
  if (pending) return pending;
  const work = prepareCurrentStateRecheck(input).finally(() => { rechecks.delete(input.reviewId); });
  rechecks.set(input.reviewId, work);
  return work;
}

async function prepareCurrentStateRecheck(input: StateReviewInput): Promise<MemoryCandidateReview> {
  const epoch = captureBackupRestoreDataEpoch();
  const modern = 'origin' in input;
  if (modern) await updatePendingMemoryCandidates([input]);
  const refs = modern ? input.ingestionRefs ?? [] : input.ingestionRef ? [input.ingestionRef] : [];
  if (!refs.length) throw new Error('待核对草稿未写入本地，请稍后再试。');
  const database = await getMemoryDatabase();
  const loadOriginal = async (db: Reader) => db.getFirstAsync<{ candidate_json: string }>(
    "SELECT candidate_json FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ? AND status = 'pending'",
    refs[0].batchId, refs[0].itemKey);
  const row = await loadOriginal(database);
  if (!row) throw new Error('这张草稿已被处理。');
  const original = JSON.parse(row.candidate_json) as StateReviewInput;
  if (original.reviewId !== input.reviewId || original.title !== input.title || original.content !== input.content) {
    throw new Error('草稿已改变，请保留输入后重新核对。');
  }
  const targetId = 'currentStateReview' in original ? original.currentStateReview?.targetCurrentStateId
    : 'stateId' in original ? original.stateId : null;
  const loaded: UnderstandingMessage[] = [];
  for (const ref of original.sourceRefs ?? []) {
    if (ref.sessionId.startsWith('observation-source:')) continue;
    const source = await readUnderstandingMessage(ref.sessionId, ref.messageId);
    if (!source) throw new Error('原话已缺失，草稿仍保留；可以舍弃后自选新的聊天整理。');
    if (!loaded.some(item => item.sessionId === source.sessionId && item.message.id === source.message.id)) loaded.push(source);
  }
  const recheck = await prepareRecheckMessages(loaded, 'letterBindings' in original ? original.letterBindings : [],
    'voiceBindings' in original ? original.voiceBindings : []);
  const { originals, letterBindings, voiceBindings } = recheck;
  const giftSource = originals.some(source => source.sessionId.startsWith('gift-source:'))
    ? await (await import('../gifts/giftMemorySource')).prepareGiftMemoryRecheck(originals, epoch) : undefined;
  const observationBindings = 'observationBindings' in original ? original.observationBindings : [];
  const sessionId = recheck.sessionId || (observationBindings?.length ? (await import('../chat/primaryChat')).PRIMARY_CHAT_SESSION_ID : '');
  const observationMaterials = await (await import('./memoryUnderstanding')).prepareObservationRecheckMaterials(observationBindings, sessionId);
  if (!sessionId || originals.length > 30 || originals.some(source => !source.sessionId.startsWith('letter:') && !source.voiceBinding && source.sessionId !== sessionId)) {
    throw new Error('这张旧稿没有可核对的完整原话，草稿仍保留；可以舍弃后自选聊天整理。');
  }
  const { loadAiConfigPreferencesSnapshot } = await import('../ai/AiConfigPreferences');
  const config = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
  if (!config.memoryOrganizerConnection || !config.memoryOrganizerKey.trim()) throw new Error('请先配置记忆整理模型。');
  const messages = originals.map(source => source.message);
  const materials = await prepareUnderstandingMaterials({ sessionId, messages, continuationEnabled: true,
    targetCurrentStateId: targetId ?? undefined, letterBindings, voiceBindings, observationMaterials });
  const { organizeConversationMemories } = await import('./memoryOrganizer');
  const drafts = await runMemoryOrganizerRequestWithDeadline(signal => organizeConversationMemories({
    apiKey: config.memoryOrganizerKey, connection: config.memoryOrganizerConnection!, messages, understandingMaterials: materials, signal,
    ...(giftSource ? { giftSourceEnvelope: giftSource.envelope } : {}),
  }), { timeoutMs: 60_000 });
  const draft = drafts.find(item => item.currentStateReview && item.currentStateReview.targetCurrentStateId === (targetId ?? null));
  if (!draft) throw new Error('本次没有生成对应近况建议；原稿和输入已保留。');
  const [replacement] = makeReviewCandidates([draft], 'digest', { sessionId, messages });
  if (giftSource) Object.assign(replacement, (await import('../gifts/giftMemorySource')).giftMemoryCandidateForPersistence(replacement));
  const batchId = `current-state-recheck-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const itemKey = makeMemoryCandidateKey(replacement);
  replacement.ingestionRefs = [{ batchId, itemKey }];
  const committed = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(() =>
    database.withExclusiveTransactionAsync(async transaction => {
      const current = await loadOriginal(transaction);
      if (current?.candidate_json !== row.candidate_json) throw new Error('草稿已改变，本次没有覆盖输入。');
      if ((await currentStateReviewStatus(transaction, replacement)).status !== 'current') throw new Error('MEMORY_CURRENT_STATE_STALE');
      if (giftSource && !(await (await import('../gifts/giftMemorySource')).validateGiftMemoryBindings(giftSource.metadata.bindings,
        epoch, { database: transaction }))) throw new Error('MEMORY_SOURCE_CHANGED');
      await beginMemoryIngestionBatchWithDatabase(transaction, { id: batchId,
        sessionId: giftSource ? (await import('../chat/primaryChat')).PRIMARY_CHAT_SESSION_ID : sessionId,
        scopeKey: `current-state-review:${targetId ?? original.reviewId}`, stream: 'manual_digest', advancesCursor: false,
        sourceHash: stableMemoryHash(JSON.stringify([materials.text, materials.batchMessages.map(source => source.hash)])),
        ...(letterBindings[0] || giftSource ? { workMetadata: { version: 1 as const, workId: batchId, messageIds: [],
          ...(letterBindings[0] ? { letter: letterBindings[0] } : {}), ...(giftSource ? { gift: giftSource.metadata } : {}) } } : {}) });
      await resolveMemoryIngestionItemsWithDatabase(transaction, refs, 'suppressed');
      await registerMemoryIngestionOutcomeWithDatabase(transaction, { batchId, pendingItemKeys: [itemKey],
        pendingCandidates: [{ itemKey, candidateJson: JSON.stringify(replacement) }] });
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
    })));
  if (!committed.committed) throw new Error('数据正在恢复，请稍后重新核对。');
  await import('./memoryUnderstandingReview').then(module => module.notifyUnderstandingChanges()).catch(() => undefined);
  return replacement;
}
