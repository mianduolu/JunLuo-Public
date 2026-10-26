import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { beginMemoryCandidateEdit, memoryCandidateEditableHash, type MemoryCandidateReview } from '../memory/memoryCandidateReview';
import { updatePendingMemoryCandidates } from '../memory/memoryIngestionService';
import { beginMemoryIngestionBatchWithDatabase, registerMemoryIngestionOutcomeWithDatabase } from '../memory/memoryIngestionLedger';
import { getMemoryDatabase } from '../memory/memoryStore';
import { makeMemoryCandidateKey } from '../memory/memoryAtomicity';
import { runMemoryDuplicateCleanupBusinessWrite } from '../memory/memoryDuplicateCleanupState';
import { makeUnderstandingBasis } from '../memory/memoryUnderstanding';
import { notifyMemoryProcessingUpdated } from '../memory/memoryProcessingSignals';
import { loadShiyingMemorySnapshot, makeShiyingMemoryBinding, replaceShiyingMemorySourceRefs,
  validateShiyingMemoryBinding, type ShiyingMemoryBinding } from './shiyingMemorySource';
import { prepareShiyingOrganizationFragment } from './shiyingMemoryOrganizationProtocol';
import { restoreShiyingOrganizationMaterial, type PreparedShiyingOrganizationMaterial } from './shiyingMemoryIngestion';

const inFlight = new Map<string, { hash: string; promise: Promise<MemoryCandidateReview> }>();
/** Explicit local comparison preserves the edited prose; it never asks a model. */
export function recheckShiyingMemoryCandidate(candidate: MemoryCandidateReview): Promise<MemoryCandidateReview> {
  const hash = memoryCandidateEditableHash(candidate), previous = inFlight.get(candidate.reviewId);
  if (previous) return previous.hash === hash ? previous.promise : Promise.reject(new Error('MEMORY_CANDIDATE_CHANGED'));
  const promise = recheck(candidate, hash); inFlight.set(candidate.reviewId, { hash, promise });
  void promise.finally(() => { if (inFlight.get(candidate.reviewId)?.promise === promise) inFlight.delete(candidate.reviewId); }).catch(() => undefined);
  return promise;
}
async function recheck(candidate: MemoryCandidateReview, hash: string) {
  const epoch = captureBackupRestoreDataEpoch();
  await updatePendingMemoryCandidates([candidate], { dataEpoch: epoch });
  const db = await getMemoryDatabase('ingestion'), first = candidate.ingestionRefs?.[0];
  const row = first ? await db.getFirstAsync<{ candidate_json: string }>(
    "SELECT candidate_json FROM memory_ingestion_items WHERE batch_id=? AND item_key=? AND status IN ('pending','waiting')", first.batchId, first.itemKey) : null;
  const original = row ? JSON.parse(row.candidate_json) as MemoryCandidateReview : null;
  if (!original?.shiyingBindings?.length || original.reviewId !== candidate.reviewId || memoryCandidateEditableHash(original) !== hash) throw new Error('MEMORY_CANDIDATE_CHANGED');
  const materials: PreparedShiyingOrganizationMaterial[] = []; let remaining = 6000;
  for (const recordId of new Set(original.shiyingBindings.map(binding => binding.recordId))) {
    const snapshot = await loadShiyingMemorySnapshot(recordId);
    if (!snapshot) throw new Error('拾荧原纸条已不存在，编辑稿保留，暂不能保存。');
    const previous = original.shiyingBindings.filter(binding => binding.recordId === recordId);
    let bindings: ShiyingMemoryBinding[];
    if ((await Promise.all(previous.map(binding => validateShiyingMemoryBinding(binding)))).every(Boolean)) bindings = previous;
    else {
      if (previous.some(binding => binding.part === 'image_note') && !snapshot.imageNote) throw new Error('当前图片记录尚不可用，编辑稿已保留。');
      const body = previous.some(binding => binding.part === 'body'), image = previous.some(binding => binding.part === 'image_note');
      const fragment = prepareShiyingOrganizationFragment(snapshot, {
        bodyStart: body ? 0 : snapshot.body.length, imageNoteStart: image ? 0 : snapshot.imageNote?.body.length ?? 0,
        references: { body: 'S999998', imageNote: 'S999999' } }, remaining);
      if (fragment.status !== 'ready' || body && !fragment.ranges.body || image && !fragment.ranges.imageNote) {
        throw new Error('纸条原文超出本次核对容量，编辑稿已保留。');
      }
      bindings = [];
      if (fragment.ranges.body) bindings.push(makeShiyingMemoryBinding(snapshot, 'body', fragment.ranges.body));
      if (fragment.ranges.imageNote) bindings.push(makeShiyingMemoryBinding(snapshot, 'image_note', fragment.ranges.imageNote));
    }
    const material = await restoreShiyingOrganizationMaterial(bindings, '');
    remaining -= material.content.length + 2;
    if (remaining < 0) throw new Error('纸条原文超出本次核对容量，编辑稿已保留。');
    materials.push(material);
  }
  const bindings = materials.flatMap(material => material.bindings), messages = materials.flatMap(material => material.messages);
  const refs = bindings.map(binding => {
    const message = messages.find(message => message.id === binding.messageId)!;
    return { sessionId: binding.sessionId, messageId: message.id, role: message.role,
      messageCreatedAt: message.createdAt, relation: 'direct' as const, excerpt: message.content };
  });
  const previousSessions = new Set(original.shiyingBindings.map(binding => binding.sessionId));
  const replaceEvidence = <T extends { sessionId: string; messageId: string; hash: string }>(item: T): T => {
    if (!previousSessions.has(item.sessionId)) return item;
    const binding = bindings.find(binding => binding.messageId === item.messageId);
    if (!binding) throw new Error('SHIYING_MEMORY_SOURCE_INVALID');
    return { ...item, sessionId: binding.sessionId, hash: binding.sourceHash };
  };
  const evidence = (values: NonNullable<MemoryCandidateReview['continuationReview']>['evidence']) => values.map(item => item.kind === 'message' ? replaceEvidence(item) : item);
  let updated: MemoryCandidateReview = { ...original, shiyingBindings: bindings,
    sourceRefs: replaceShiyingMemorySourceRefs(original.sourceRefs ?? [], refs, bindings),
    readingSourcePreview: materials.map(material => material.content).join('\n\n'),
    ...(original.continuationReview ? { continuationReview: { ...original.continuationReview, dataEpoch: epoch, evidence: evidence(original.continuationReview.evidence) } } : {}),
    ...(original.understandingBasis && original.understandingSubject ? { understandingBasis:
      makeUnderstandingBasis(original.understandingSubject, evidence(original.understandingBasis.evidence)) } : {}),
    ...(original.currentStateReview ? { currentStateReview: { ...original.currentStateReview, dataEpoch: epoch,
      evidence: original.currentStateReview.evidence.map(item => 'kind' in item ? item : replaceEvidence(item)) } } : {}),
    reviewStatus: 'current', understandingStale: false };
  // The exact statement is evidence owned by the host, never a rewritten editable draft.
  if (updated.understandingReview?.understandingKind === 'stated' && updated.understandingSubject
    && !messages.some(message => message.role === updated.understandingSubject && message.content.includes(updated.understandingReview!.statedQuote ?? ''))) {
    const direct = messages.find(message => message.role === updated.understandingSubject);
    if (!direct) throw new Error('新原文中未找到这份认识的直接说法，编辑稿已保留。');
    updated = { ...updated, understandingReview: { ...updated.understandingReview, statedQuote: direct.content } };
  }
  const committed = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
    await db.withExclusiveTransactionAsync(async tx => {
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
      const rows = await tx.getAllAsync<{ batch_id: string; item_key: string; candidate_json: string; session_id: string | null }>(
        `SELECT i.batch_id,i.item_key,i.candidate_json,b.session_id FROM memory_ingestion_items i JOIN memory_ingestion_batches b ON b.id=i.batch_id
          WHERE i.status IN ('pending','waiting') AND json_extract(i.candidate_json,'$.reviewId')=?`, original.reviewId);
      if (!rows.length || rows.some(row => memoryCandidateEditableHash(JSON.parse(row.candidate_json)) !== hash
        || JSON.stringify(JSON.parse(row.candidate_json).shiyingBindings) !== JSON.stringify(original.shiyingBindings))) throw new Error('MEMORY_CANDIDATE_CHANGED');
      for (const material of materials) {
        for (const binding of material.bindings) if (!(await validateShiyingMemoryBinding(binding))) throw new Error('MEMORY_SOURCE_CHANGED');
        const batch = { ...material.batch, sessionId: rows.find(row => row.session_id)?.session_id ?? undefined };
        const stored = await beginMemoryIngestionBatchWithDatabase(tx, batch);
        if (stored && ['resolved', 'no_value'].includes(stored.status)) continue;
        const itemKey = makeMemoryCandidateKey(updated);
        await registerMemoryIngestionOutcomeWithDatabase(tx, { batchId: batch.id, pendingItemKeys: [itemKey],
          pendingCandidates: [{ itemKey, candidateJson: JSON.stringify(updated) }] });
      }
      const actual = await tx.getAllAsync<{ batch_id: string; item_key: string }>(
        "SELECT batch_id,item_key FROM memory_ingestion_items WHERE status IN ('pending','waiting') AND json_extract(candidate_json,'$.reviewId')=?", original.reviewId);
      updated = { ...updated, ingestionRefs: actual.map(row => ({ batchId: row.batch_id, itemKey: row.item_key })) };
      for (const ref of updated.ingestionRefs!) await tx.runAsync(
        "UPDATE memory_ingestion_items SET candidate_json=?,updated_at=? WHERE batch_id=? AND item_key=? AND status IN ('pending','waiting')",
        JSON.stringify(updated), Date.now(), ref.batchId, ref.itemKey);
      for (const binding of bindings) if (!(await validateShiyingMemoryBinding(binding))) throw new Error('MEMORY_SOURCE_CHANGED');
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
    });
  }));
  if (!committed.committed) throw new Error('MEMORY_DATA_CHANGED');
  notifyMemoryProcessingUpdated(); return beginMemoryCandidateEdit(updated);
}
