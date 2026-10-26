import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { beginMemoryCandidateEdit, memoryCandidateEditableHash, type MemoryCandidateReview } from '../memory/memoryCandidateReview';
import { updatePendingMemoryCandidates } from '../memory/memoryIngestionService';
import { beginMemoryIngestionBatchWithDatabase, registerMemoryIngestionOutcomeWithDatabase } from '../memory/memoryIngestionLedger';
import { getMemoryDatabase } from '../memory/memoryStore';
import { makeMemoryCandidateKey } from '../memory/memoryAtomicity';
import { runMemoryDuplicateCleanupBusinessWrite } from '../memory/memoryDuplicateCleanupState';
import { makeUnderstandingBasis } from '../memory/memoryUnderstanding';
import { notifyMemoryProcessingUpdated } from '../memory/memoryProcessingSignals';
import { loadReadingOrganizationSource, readingOrganizationSentHash, replaceReadingOrganizationSourceRefs,
  validateReadingOrganizationBinding, type ReadingOrganizationBinding } from './readingMemoryOrganizationSource';
import { prepareReadingOrganizationFragment } from './readingMemoryOrganizationProtocol';
import { restoreReadingOrganizationMaterial } from './readingMemoryIngestion';

const inFlight = new Map<string, { hash: string; promise: Promise<MemoryCandidateReview> }>();

/** The user sees the new original beside the unchanged draft before saving it. No model request. */
export function recheckReadingOrganizationCandidate(candidate: MemoryCandidateReview): Promise<MemoryCandidateReview> {
  const hash = memoryCandidateEditableHash(candidate);
  const previous = inFlight.get(candidate.reviewId);
  if (previous) return previous.hash === hash ? previous.promise : Promise.reject(new Error('MEMORY_CANDIDATE_CHANGED'));
  const promise = recheck(candidate, hash);
  inFlight.set(candidate.reviewId, { hash, promise });
  void promise.finally(() => { if (inFlight.get(candidate.reviewId)?.promise === promise) inFlight.delete(candidate.reviewId); }).catch(() => undefined);
  return promise;
}

async function recheck(candidate: MemoryCandidateReview, hash: string) {
  const epoch = captureBackupRestoreDataEpoch();
  await updatePendingMemoryCandidates([candidate], { dataEpoch: epoch });
  const db = await getMemoryDatabase('ingestion');
  const first = candidate.ingestionRefs?.[0];
  const row = first ? await db.getFirstAsync<{ candidate_json: string }>(
    "SELECT candidate_json FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ? AND status IN ('pending', 'waiting')", first.batchId, first.itemKey) : null;
  const original = row ? JSON.parse(row.candidate_json) as MemoryCandidateReview : null;
  if (!original?.readingBindings?.length || original.reviewId !== candidate.reviewId || memoryCandidateEditableHash(original) !== hash) throw new Error('MEMORY_CANDIDATE_CHANGED');
  const materials: Awaited<ReturnType<typeof restoreReadingOrganizationMaterial>>[] = [];
  let remaining = 6000;
  for (const binding of original.readingBindings) {
    const source = await loadReadingOrganizationSource(binding.sessionId, true);
    if (!source) throw new Error('阅读原记录无法对应，编辑稿已保留。');
    let next: ReadingOrganizationBinding = binding;
    if (!(await validateReadingOrganizationBinding(binding))) {
      const fragment = prepareReadingOrganizationFragment(source.snapshot, { messageId: source.message.id, reference: 'R999999' }, remaining);
      if (fragment.status !== 'ready') throw new Error('阅读原文超出本次核对容量，编辑稿已保留。');
      next = { ...source.identity, sessionId: source.sessionId, messageId: source.message.id, sourceHash: source.sourceHash,
        bookRange: fragment.bookRange, contentRange: fragment.contentRange, bookStart: 0, contentStart: 0,
        nextBookOffset: fragment.nextBookOffset, nextContentOffset: fragment.nextContentOffset,
        sentHash: readingOrganizationSentHash(fragment.bookText, fragment.messageContent) };
    }
    const material = await restoreReadingOrganizationMaterial(next, '');
    remaining -= material.content.length + 2;
    if (remaining < 0) throw new Error('阅读原文超出本次核对容量，编辑稿已保留。');
    materials.push(material);
  }
  const bindings = materials.map(material => material.binding);
  const directRefs = materials.map(material => ({ sessionId: material.binding.sessionId, messageId: material.message.id,
    role: material.message.role, messageCreatedAt: material.message.createdAt, relation: 'direct' as const, excerpt: material.message.content }));
  const previousSessions = new Set(original.readingBindings.map(binding => binding.sessionId));
  const nextSource = (sessionId: string, messageId: string) => materials.find(material => material.message.id === messageId
    && original.readingBindings!.some(binding => binding.sessionId === sessionId && binding.messageId === messageId));
  const evidence = (values: NonNullable<MemoryCandidateReview['continuationReview']>['evidence']) => values.map(item => {
    if (item.kind !== 'message' || !previousSessions.has(item.sessionId)) return item;
    const material = nextSource(item.sessionId, item.messageId);
    if (!material) throw new Error('READING_ORGANIZATION_SOURCE_INVALID');
    return { ...item, sessionId: material.binding.sessionId, messageId: material.message.id, hash: material.binding.sourceHash };
  });
  let updated: MemoryCandidateReview = { ...original, readingBindings: bindings,
    sourceRefs: replaceReadingOrganizationSourceRefs(original.sourceRefs ?? [], directRefs, bindings),
    readingSourcePreview: materials.map(material => material.content).join('\n\n'),
    ...(original.continuationReview ? { continuationReview: { ...original.continuationReview, dataEpoch: epoch,
      evidence: evidence(original.continuationReview.evidence) } } : {}),
    ...(original.understandingBasis && original.understandingSubject ? { understandingBasis:
      makeUnderstandingBasis(original.understandingSubject, evidence(original.understandingBasis.evidence)) } : {}),
    ...(original.currentStateReview ? { currentStateReview: { ...original.currentStateReview, dataEpoch: epoch,
      evidence: original.currentStateReview.evidence.map(item => {
        if ('kind' in item || !previousSessions.has(item.sessionId)) return item;
        const material = nextSource(item.sessionId, item.messageId);
        if (!material) throw new Error('READING_ORGANIZATION_SOURCE_INVALID');
        return { ...item, sessionId: material.binding.sessionId, messageId: material.message.id, hash: material.binding.sourceHash };
      }) } } : {}),
    reviewStatus: 'current', understandingStale: false };
  const committed = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
    await db.withExclusiveTransactionAsync(async transaction => {
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
      const rows = await transaction.getAllAsync<{ batch_id: string; item_key: string; candidate_json: string; session_id: string | null }>(
        `SELECT i.batch_id, i.item_key, i.candidate_json, b.session_id FROM memory_ingestion_items i JOIN memory_ingestion_batches b ON b.id=i.batch_id
         WHERE i.status IN ('pending', 'waiting') AND json_extract(i.candidate_json, '$.reviewId')=?`, original.reviewId);
      if (!rows.length || rows.some(row => memoryCandidateEditableHash(JSON.parse(row.candidate_json)) !== hash
        || JSON.stringify(JSON.parse(row.candidate_json).readingBindings) !== JSON.stringify(original.readingBindings))) throw new Error('MEMORY_CANDIDATE_CHANGED');
      const registrations: Array<{ batchId: string; itemKey: string }> = [];
      for (const material of materials) {
        if (!(await validateReadingOrganizationBinding(material.binding, material.message))) throw new Error('MEMORY_SOURCE_CHANGED');
        const batch = { ...material.batch, sessionId: rows.find(row => row.session_id)?.session_id ?? undefined };
        const storedBatch = await beginMemoryIngestionBatchWithDatabase(transaction, batch);
        if (storedBatch && ['resolved', 'no_value'].includes(storedBatch.status)) continue;
        const pending = await transaction.getAllAsync<{ item_key: string; candidate_json: string }>(
          "SELECT item_key,candidate_json FROM memory_ingestion_items WHERE batch_id=? AND status IN ('pending','waiting')", batch.id);
        if (pending.some(item => JSON.parse(item.candidate_json)?.reviewId !== original.reviewId)) throw new Error('MEMORY_CANDIDATE_CHANGED');
        if (!pending.length) registrations.push({ batchId: batch.id, itemKey: makeMemoryCandidateKey(updated) });
      }
      for (const ref of registrations) await registerMemoryIngestionOutcomeWithDatabase(transaction, {
        batchId: ref.batchId, pendingItemKeys: [ref.itemKey],
        pendingCandidates: [{ itemKey: ref.itemKey, candidateJson: JSON.stringify(updated) }],
      });
      const actual = await transaction.getAllAsync<{ batch_id: string; item_key: string }>(
        "SELECT batch_id,item_key FROM memory_ingestion_items WHERE status IN ('pending','waiting') AND json_extract(candidate_json,'$.reviewId')=?", original.reviewId);
      const refs = actual.map(row => ({ batchId: row.batch_id, itemKey: row.item_key }));
      updated = { ...updated, ingestionRefs: refs };
      for (const ref of refs) await transaction.runAsync(
        "UPDATE memory_ingestion_items SET candidate_json=?, updated_at=? WHERE batch_id=? AND item_key=? AND status IN ('pending', 'waiting')",
        JSON.stringify(updated), Date.now(), ref.batchId, ref.itemKey);
      for (const material of materials) if (!(await validateReadingOrganizationBinding(material.binding))) throw new Error('MEMORY_SOURCE_CHANGED');
      if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
    });
  }));
  if (!committed.committed) throw new Error('MEMORY_DATA_CHANGED');
  notifyMemoryProcessingUpdated();
  return beginMemoryCandidateEdit(updated);
}
