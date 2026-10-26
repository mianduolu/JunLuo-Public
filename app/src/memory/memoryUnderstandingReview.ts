import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { stableMemoryHash, makeMemoryCandidateKey } from './memoryAtomicity';
import { makeReviewCandidates, memoryCandidateEditSession, memoryCandidateEditableHash, type MemoryCandidateReview } from './memoryCandidateReview';
import { loadPendingMemoryCandidates, resolveMemoryIngestionItems, runMemoryCandidateSave } from './memoryIngestionService';
import { beginMemoryIngestionBatchWithDatabase, registerMemoryIngestionOutcomeWithDatabase, resolveMemoryIngestionItemsWithDatabase } from './memoryIngestionLedger';
import { organizeConversationMemories } from './memoryOrganizer';
import { runMemoryOrganizerRequestWithDeadline } from './memoryOrganizerRequestLifecycle';
import { createMemory, getMemoryDatabase, loadMemory, loadMemorySourceRefs, updateMemory, type MemoryEntry } from './memoryStore';
import { getUnderstandingStatus, isUnderstandingCandidateCurrent, prepareUnderstandingMaterials, prepareRecheckMessages, readUnderstandingMaterial, readUnderstandingMessage, readUnderstandingObservation, understandingMessageValue } from './memoryUnderstanding';
import { isLifeSelfMemorySource, prepareLifeSelfFragment, validateLifeSelfBinding,
  renderLifeSelfMaterial } from '../life/lifeSelfMemorySource';
import { restoreLifeSelfOrganizationMaterials, type PreparedLifeSelfOrganizationMaterial } from './lifeSelfMemoryIngestion';

const listeners = new Set<() => void>();
export function subscribeUnderstandingChanges(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyUnderstandingChanges() { for (const listener of listeners) { try { listener(); } catch { /* Commit already succeeded. */ } } }

export async function loadUnderstandingEvidence(memory: Pick<MemoryEntry, 'understandingBasis'>) {
  const database = await getMemoryDatabase();
  return Promise.all((memory.understandingBasis?.evidence ?? []).map(async evidence => {
    if (evidence.kind === 'observation') {
      const original = await readUnderstandingObservation(evidence.observationId);
      return { key: `observation-source:${evidence.observationId}`, label: original ? '观察记录已找到' : '观察记录未找到',
        current: original?.hash === evidence.hash, text: original ? JSON.stringify(original.record.result) : '' };
    }
    if (evidence.kind === 'message') {
      const original = await readUnderstandingMessage(evidence.sessionId, evidence.messageId);
      return { key: `${evidence.sessionId}:${evidence.messageId}`, label: evidence.sessionId.startsWith('letter:') ? '信件原文' : '原话', current: original?.hash === evidence.hash,
        text: original ? `${original.message.role === 'I' ? '白云小姐' : '小仓鼠'} · ${new Date(original.message.createdAt).toLocaleString('zh-CN')}\n${original.message.content}` : '原话已缺失' };
    }
    const material = await readUnderstandingMaterial(database, evidence.memoryId);
    return { key: evidence.memoryId, label: '经历', current: material?.hash === evidence.hash,
      text: material ? [material.memory.title, material.memory.content, ...material.comments.map(c => c.content)].join('\n') : '经历已缺失或不再适合作为依据' };
  }));
}

export async function saveUnderstandingCandidate(candidate: MemoryCandidateReview, options: { dataEpoch?: number | null } = {}) {
  if (options.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(options.dataEpoch)) throw new Error('memory-candidate-write-stale');
  const evidence = candidate.understandingBasis?.evidence ?? [];
  if (evidence.some(item => item.kind === 'message' && item.sessionId.startsWith('voice-call:'))) {
    for (const item of evidence) if (item.kind === 'message') {
      if (options.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(options.dataEpoch)) throw new Error('memory-candidate-write-stale');
      await readUnderstandingMessage(item.sessionId, item.messageId);
      if (options.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(options.dataEpoch)) throw new Error('memory-candidate-write-stale');
    }
  }
  return runMemoryCandidateSave(candidate, async (stored, dataEpoch) => {
  if (!stored?.understandingReview || !stored.understandingBasis || stored.understandingStale) throw new Error('这份认识的依据或原稿已改变，请重新核对。');
  const target = stored.understandingReview;
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    const database = await getMemoryDatabase();
    if (!(await isUnderstandingCandidateCurrent(database, stored))) throw new Error('这份认识的依据或原稿已改变，请重新核对。');
    let sourceRefs = stored.readingBindings?.length && target.targetMemoryId
      ? (await import('../reading/readingMemoryOrganizationSource')).replaceReadingOrganizationSourceRefs(
        await loadMemorySourceRefs(target.targetMemoryId, database), stored.sourceRefs ?? [], stored.readingBindings) : stored.sourceRefs;
    if (stored.shiyingBindings?.length && target.targetMemoryId) sourceRefs = (await import('../shiying/shiyingMemorySource'))
      .replaceShiyingMemorySourceRefs(await loadMemorySourceRefs(target.targetMemoryId, database), sourceRefs ?? [], stored.shiyingBindings);
    const options = { confirmationLevel: 'reviewed' as const, sourceRefs, ingestionResolutions: stored.ingestionRefs,
      ...(stored.postCorrection || stored.readingCorrection || stored.shiyingCorrection ? { writeIntent: 'correction' as const } : {}),
      requirePendingIngestion: true, understandingReviewed: true, understandingExpectedTargetHash: target.targetHash, dataEpoch,
      ingestionExpectedCandidate: { reviewId: stored.reviewId, editableHash: memoryCandidateEditableHash(stored) } };
    if (target.targetMemoryId) {
      const current = await loadMemory(target.targetMemoryId);
      if (!current) throw new Error('原认识已不存在。');
      await updateMemory(current.id, { ...current, ...stored, ...(stored.readingCorrection || stored.shiyingCorrection ? {
        type: current.type, source: current.source, sourceType: current.sourceType, atomicKind: current.atomicKind,
        semanticType: current.semanticType, protected: current.protected, digested: current.digested, resolved: current.resolved,
      } : {}) }, options);
      return current.id;
    }
    return createMemory(stored, options);
  });
  if (!committed.committed) throw new Error('数据正在恢复，请稍后确认。');
  notifyUnderstandingChanges();
  return committed.value;
  }, options);
}

export async function discardUnderstandingCandidate(candidate: MemoryCandidateReview) {
  await resolveMemoryIngestionItems(candidate.ingestionRefs ?? [], 'discarded', {
    expectedCandidate: { reviewId: candidate.reviewId,
      editableHash: candidate[memoryCandidateEditSession]?.hash ?? memoryCandidateEditableHash(candidate) },
  });
  notifyUnderstandingChanges();
}

const rechecks = new Map<string, Promise<MemoryCandidateReview | undefined>>();
export function recheckUnderstanding(input: string | MemoryCandidateReview) {
  if (typeof input !== 'string' && input.shiyingBindings?.length) return import('../shiying/shiyingMemoryReview')
    .then(module => module.recheckShiyingMemoryCandidate(input));
  if (typeof input !== 'string' && input.readingBindings?.length) return import('../reading/readingMemoryOrganizationReview')
    .then(module => module.recheckReadingOrganizationCandidate(input));
  const key = typeof input === 'string' ? input : input.understandingReview?.targetMemoryId ?? input.reviewId;
  const active = rechecks.get(key);
  if (active) return active;
  const request = prepareRecheck(input).finally(() => { rechecks.delete(key); });
  rechecks.set(key, request);
  return request;
}

async function prepareRecheck(input: string | MemoryCandidateReview) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const targetId = typeof input === 'string' ? input : input.understandingReview?.targetMemoryId;
  const pending = typeof input === 'string' ? await loadPendingMemoryCandidates({ understandingMemoryId: input })
    : await loadPendingMemoryCandidates({ batchIds: (input.ingestionRefs ?? []).map(ref => ref.batchId) });
  const oldCandidate = typeof input === 'string' ? pending[0] : pending.find(c => c.reviewId === input.reviewId);
  const target = targetId ? await loadMemory(targetId) : null;
  const original = target ?? oldCandidate;
  if (!original?.understandingSubject || original.type === 'archived') throw new Error('没有可以重新核对的认识。');
  const candidateVersion = (candidate: MemoryCandidateReview | undefined) => {
    if (!candidate) return undefined;
    const { understandingStale: _status, reviewStatus: _reviewStatus, ...editable } = candidate;
    return JSON.stringify(editable);
  };
  const originalCandidateJson = candidateVersion(oldCandidate);
  const config = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
  if (!config.memoryOrganizerConnection || !config.memoryOrganizerKey.trim()) throw new Error('请先配置记忆整理模型。');
  const messages = [];
  const observationMaterials: import('./memoryObservationIngestion').PreparedObservationMaterial[] = [];
  const recalledIds = [];
  // Reload originals at their present version; missing originals are never invented.
  for (const evidence of original.understandingBasis?.evidence ?? []) {
    if (evidence.kind === 'memory') recalledIds.push(evidence.memoryId);
    else if (evidence.kind === 'observation') {
      const current = await readUnderstandingObservation(evidence.observationId);
      if (!current) throw new Error('观察记录未找到；原稿和草稿已保留。');
      const { prepareObservationFragment, restoreObservationMaterial, validateObservationBinding } = await import('./memoryObservationIngestion');
      const previous = oldCandidate?.observationBindings?.find(binding => binding.observationId === evidence.observationId);
      const remaining = 6000 - observationMaterials.reduce((sum, source) => sum + source.content.length + 2, 0);
      const fragment = previous && await validateObservationBinding(previous)
        ? { binding: previous }
        : prepareObservationFragment(current.record, 0, remaining);
      if (!fragment) throw new Error('观察材料超出本次容量；原稿和草稿已保留。');
      const restored = await restoreObservationMaterial(fragment.binding, '');
      if (restored.content.length > remaining) throw new Error('观察材料超出本次容量；原稿和草稿已保留。');
      observationMaterials.push(restored);
    }
    else {
      const message = await readUnderstandingMessage(evidence.sessionId, evidence.messageId);
      if (!message && isLifeSelfMemorySource(evidence.sessionId)) throw new Error('MEMORY_SOURCE_CHANGED');
      if (message) messages.push(message);
    }
  }
  if (target) {
    const refs = await (await getMemoryDatabase()).getAllAsync<{ session_id: string; message_id: string }>(
      "SELECT session_id, message_id FROM memory_source_refs WHERE memory_id = ? AND relation = 'direct' ORDER BY message_created_at", target.id);
    for (const ref of refs) {
      if (ref.session_id.startsWith('observation-source:')) continue;
      if (messages.some(m => m.sessionId === ref.session_id && m.message.id === ref.message_id)) continue;
      const message = await readUnderstandingMessage(ref.session_id, ref.message_id);
      if (message) messages.push(message);
    }
  }
  const lifeSelfMaterials: PreparedLifeSelfOrganizationMaterial[] = [];
  let remainingSelf = 6000, explorationIndex = 0, wishIndex = 0;
  for (const originalMessage of messages.filter(source => isLifeSelfMemorySource(source.sessionId))) {
    const source = originalMessage.lifeSelfSource;
    if (!source) throw new Error('MEMORY_SOURCE_CHANGED');
    const reference = source.kind === 'exploration' ? `E${++explorationIndex}` : `W${++wishIndex}`;
    const previous = oldCandidate?.lifeSelfBindings?.find(binding => binding.sessionId === source.sessionId && binding.messageId === source.message.id);
    const reusable = previous && await validateLifeSelfBinding(previous);
    const prepared = reusable ? (() => {
      const content = renderLifeSelfMaterial(source, previous, reference);
      return { binding: { ...previous, reference, sentHash: stableMemoryHash(content) }, content };
    })() : prepareLifeSelfFragment(source, 0, remainingSelf, reference);
    if (!prepared || prepared.content.length + 2 > remainingSelf) throw new Error('LIFE_SELF_MEMORY_MATERIAL_TOO_LARGE');
    const [material] = await restoreLifeSelfOrganizationMaterials([prepared.binding], '');
    lifeSelfMaterials.push(material);
    remainingSelf -= material.content.length + 2;
  }
  const recheckSources = await prepareRecheckMessages(messages, oldCandidate?.letterBindings, oldCandidate?.voiceBindings);
  const letterMessages = [...recheckSources.originals.filter(source => source.letterBinding || source.voiceBinding).map(source => source.message),
    ...lifeSelfMaterials.map(source => source.message)];
  const materials = await prepareUnderstandingMaterials({ sessionId: '', messages: letterMessages, recalledIds, targetMemoryId: target?.id,
    letterBindings: recheckSources.letterBindings, voiceBindings: recheckSources.voiceBindings, observationMaterials, lifeSelfMaterials });
  if (target && !materials.targets.some(memory => memory.id === target.id)) throw new Error('原认识超出本次材料容量，请先缩短正文再重新核对；原稿和草稿已保留。');
  // Rechecks have no new chat batch: all original quotations remain in the bounded material message.
  for (const originalMessage of recheckSources.originals.filter(source => !source.letterBinding && !source.voiceBinding && !isLifeSelfMemorySource(source.sessionId))) {
    if (materials.messages.some(m => m.message.id === originalMessage.message.id)) continue;
    const text = JSON.stringify(understandingMessageValue(originalMessage.sessionId, originalMessage.message));
    if (materials.text.length + text.length + 1 > 6000) continue;
    materials.messages.push(originalMessage);
    materials.text += `\n${text}`;
  }
  if (!materials.messages.length && !materials.memories.length && !materials.batchMessages.length && !materials.observations?.length) throw new Error('没有可读取的原话或经历；原稿和草稿已保留。');
  const giftOriginals = [...materials.batchMessages, ...materials.messages].filter(source => source.sessionId.startsWith('gift-source:'));
  const giftSource = giftOriginals.length
    ? await (await import('../gifts/giftMemorySource')).prepareGiftMemoryRecheck(giftOriginals, dataEpoch) : undefined;
  const candidates = await runMemoryOrganizerRequestWithDeadline(signal => organizeConversationMemories({
    apiKey: config.memoryOrganizerKey, connection: config.memoryOrganizerConnection!, messages: letterMessages, understandingMaterials: materials, signal,
    ...(giftSource ? { giftSourceEnvelope: giftSource.envelope } : {}),
  }));
  const draft = candidates.find(c => c.understandingSubject === original.understandingSubject
    && c.understandingReview?.targetMemoryId === (target?.id ?? null));
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('数据正在恢复，请稍后重新核对。');
  const sourceHash = stableMemoryHash(materials.text);
  // An explicit retry gets its own ledger attempt; it never overwrites an edited pending item during generation.
  const batchId = `understanding-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [candidate] = draft ? makeReviewCandidates([draft], 'digest') : [];
  if (candidate && giftSource) Object.assign(candidate, (await import('../gifts/giftMemorySource')).giftMemoryCandidateForPersistence(candidate));
  if (candidate) candidate.ingestionRefs = [{ batchId, itemKey: makeMemoryCandidateKey(candidate) }];
  const result = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    const database = await getMemoryDatabase();
    await database.withExclusiveTransactionAsync(async transaction => {
      if (targetId) {
        const currentPending = await import('./memoryCandidatePersistence').then(m => m.loadPendingMemoryCandidatesWithDatabase(transaction, { understandingMemoryId: targetId }));
        if (currentPending.some(item => item.reviewId !== oldCandidate?.reviewId)) throw new Error('已有新的待确认草稿，请先查看；本次结果未覆盖它。');
      }
      if (oldCandidate) {
        // Compare the editable draft as well as its fixed target before replacing it.
        const restored = await import('./memoryCandidatePersistence').then(m => m.loadPendingMemoryCandidatesWithDatabase(transaction, { batchIds: (oldCandidate.ingestionRefs ?? []).map(r => r.batchId) }));
        if (candidateVersion(restored.find(c => c.reviewId === oldCandidate.reviewId)) !== originalCandidateJson) throw new Error('草稿已改变，请保留新输入后重新核对。');
      }
      if (candidate && !(await isUnderstandingCandidateCurrent(transaction, candidate))) throw new Error('MEMORY_UNDERSTANDING_STALE');
      if (giftSource && !(await (await import('../gifts/giftMemorySource')).validateGiftMemoryBindings(giftSource.metadata.bindings,
        dataEpoch, { database: transaction }))) throw new Error('MEMORY_SOURCE_CHANGED');
      await beginMemoryIngestionBatchWithDatabase(transaction, { id: batchId, scopeKey: `understanding-review:${target?.id ?? oldCandidate?.reviewId}`,
        sourceHash, stream: 'manual_digest', advancesCursor: false,
        ...(recheckSources.letterBindings[0] || giftSource || lifeSelfMaterials.length ? { sessionId: (await import('../chat/primaryChat')).PRIMARY_CHAT_SESSION_ID,
          workMetadata: { version: 1 as const, workId: batchId, messageIds: [],
            ...(recheckSources.letterBindings[0] ? { letter: recheckSources.letterBindings[0] } : {}),
            ...(lifeSelfMaterials.length ? { lifeSelfBindings: lifeSelfMaterials.map(source => source.binding) } : {}),
            ...(giftSource ? { gift: giftSource.metadata } : {}) } } : {}) });
      if (candidate && oldCandidate) await resolveMemoryIngestionItemsWithDatabase(transaction, oldCandidate.ingestionRefs ?? [], 'suppressed');
      await registerMemoryIngestionOutcomeWithDatabase(transaction, { batchId, pendingItemKeys: candidate ? [makeMemoryCandidateKey(candidate)] : [],
        pendingCandidates: candidate ? [{ itemKey: makeMemoryCandidateKey(candidate), candidateJson: JSON.stringify(candidate) }] : [] });
    });
  });
  if (!result.committed) throw new Error('数据正在恢复，请稍后重新核对。');
  notifyUnderstandingChanges();
  if (!candidate) throw new Error('本次没有生成更新稿；原稿和输入已保留。');
  return candidate;
}

export async function getUnderstandingReviewStatus(memory: MemoryEntry) {
  return getUnderstandingStatus(await getMemoryDatabase(), memory);
}
