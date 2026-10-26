import type * as SQLite from 'expo-sqlite';
import { beginMemoryCandidateEdit, memoryCandidateEditSession, memoryCandidateEditableHash, memoryCandidateEditableFields, type MemoryCandidateReview, type MemoryCandidateEditSession } from './memoryCandidateReview';
import { isWeeklyCandidateCurrent, weeklyTargetHash } from './memoryWeeklyBasis';
import { isUnderstandingCandidateCurrent } from './memoryUnderstanding';
import { isConversationMemoryCandidateCurrent, rebasePostCorrectionComparison } from './memoryEpisodeReview';
import { memoryFromRow } from './memoryStore';
import { currentStateReviewStatus } from './memoryCurrentStateReview';
import { isFocusMemorySource, validateFocusCandidateSources } from '../focus/focusMemorySource';
import type { PostMemoryReadOptions } from '../posts/baiyunPostMemorySource';

export type PendingMemoryCandidateQuery = ({ sessionId: string } | { batchIds: string[] } | { post: true } | { weekly: true } | { weeklyMemoryId?: string } | { understandingMemoryId: string }
  | { readingResult: { bookId: string; resultId: string } }) & { includeWaiting?: boolean };

export async function getMemoryCandidateReviewStatus(database: Pick<SQLite.SQLiteDatabase, 'getFirstAsync' | 'getAllAsync'>, candidate: MemoryCandidateReview,
  postOptions: PostMemoryReadOptions = {}): Promise<{
  status: NonNullable<MemoryCandidateReview['reviewStatus']>; target?: import('./memoryStore').MemoryEntry;
  targetCurrentState?: import('./memoryCurrentStateStore').MemoryCurrentState | null;
}> {
  if ((candidate.lifeSelfBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('life-self-v1:')))
    && !(await (await import('./lifeSelfMemoryIngestion')).validateLifeSelfCandidateSources(candidate))) return { status: 'basis_changed' };
  if (candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('gift-source:'))
    && !(await (await import('../gifts/giftMemorySource')).validateGiftCandidateSources(candidate, { database }))) return { status: 'basis_changed' };
  if (!(await validateFocusCandidateSources(candidate))) return { status: 'basis_changed' };
  if ((candidate.shiyingBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('shiying-source-v1:')))
    && !(await (await import('../shiying/shiyingMemorySource')).validateShiyingMemoryCandidate(candidate))) return { status: 'basis_changed' };
  if ((candidate.readingBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('reading-auto-v1:')))
    && !(await (await import('../reading/readingMemoryOrganizationSource')).validateReadingOrganizationCandidate(candidate))) return { status: 'basis_changed' };
  if ((candidate.observationBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('observation-source:')))
    && !(await (await import('./memoryUnderstanding')).validateObservationCandidateSources(candidate))) return { status: 'basis_changed' };
  for (const binding of candidate.letterBindings ?? []) {
    if (!(await (await import('./letterMemoryIngestion')).validateLetterBinding(binding))) return { status: 'basis_changed' };
  }
  if ((candidate.origin === 'post' || candidate.postBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('post-source:')))
    && !(await (await import('../posts/baiyunPostMemorySource')).validatePostCandidateSources(candidate, { ...postOptions, database }))) return { status: 'basis_changed' };
  if (candidate.readingBinding) {
    const { validateReadingMemoryBinding } = await import('../reading/readingMemorySource');
    const { canCommitBackupRestoreDataEpoch } = await import('../backup/backupRestoreCoordinator');
    if (!canCommitBackupRestoreDataEpoch(candidate.readingBinding.dataEpoch)
      || !(await validateReadingMemoryBinding(candidate.readingBinding))) return { status: 'basis_changed' };
    const source = `reading:${candidate.readingBinding.bookId}:${candidate.readingBinding.resultId}`;
    const rows = await (await import('../reading/readingMemoryReview')).loadReadingMemoryTargets(database, candidate.readingBinding);
    if (rows.length > 1) throw new Error('READING_MEMORY_MULTIPLE_TARGETS');
    const memory = candidate.readingReview ? rows.find(row => row.id === candidate.readingReview!.targetMemoryId) : rows[0];
    if (candidate.readingReview && !memory) return { status: 'missing' };
    if (memory?.type === 'archived') return { status: 'archived', target: memory };
    return { status: memory && candidate.readingReview?.targetHash !== weeklyTargetHash(memory)
      ? 'target_changed' : 'current', target: memory };
  }
  if (candidate.origin === 'voice_call' && !candidate.voiceBindings?.length) return { status: 'basis_changed' };
  if (candidate.readingBindings?.length) {
    const expected = candidate.understandingReview?.targetMemoryId ?? candidate.continuationReview?.targetMemoryId;
    const module = await import('../reading/readingMemoryOrganizationSource');
    const ids = new Set((await Promise.all(candidate.readingBindings.map(binding => module.readingOrganizationTargetIds(database, binding)))).flat());
    if (ids.size > 1 || expected && [...ids].some(id => id !== expected)) throw new Error('READING_MEMORY_MULTIPLE_TARGETS');
    if (!expected && ids.size) {
      const row = await database.getFirstAsync<Parameters<typeof memoryFromRow>[0]>('SELECT * FROM memories WHERE id=?', [...ids][0]);
      const target = row ? memoryFromRow(row) : undefined;
      return { status: !target ? 'missing' : target.type === 'archived' ? 'archived' : 'target_changed', target };
    }
  }
  for (const binding of candidate.voiceBindings ?? []) {
    const { validateVoiceCallMaterialBinding } = await import('../voiceCall/voiceCallMemorySource');
    if (!(await validateVoiceCallMaterialBinding(binding, undefined, { waitForPendingWrites: false }))) return { status: 'basis_changed' };
  }
  if (candidate.currentStateReview) return currentStateReviewStatus(database, candidate, postOptions);
  const targetId = candidate.weeklyRefresh?.memoryId ?? candidate.understandingReview?.targetMemoryId ?? candidate.continuationReview?.targetMemoryId;
  const row = targetId ? await database.getFirstAsync<Parameters<typeof memoryFromRow>[0]>('SELECT * FROM memories WHERE id = ?', targetId) : null;
  const target = row ? memoryFromRow(row) : undefined;
  if (candidate.source === 'weekly-context' && !candidate.weeklyRefresh && candidate.date) {
    const weeklyTarget = await database.getFirstAsync<Parameters<typeof memoryFromRow>[0]>(
      "SELECT * FROM memories WHERE source = 'weekly-context' AND date = ? ORDER BY updated_at DESC, id ASC LIMIT 1", candidate.date);
    if (weeklyTarget) return { status: 'target_changed', target: memoryFromRow(weeklyTarget) };
  }
  const result = (status: NonNullable<MemoryCandidateReview['reviewStatus']>) => ({ status, target });
  if (targetId && !target) return result('missing');
  if (target?.type === 'archived') return result('archived');
  const targetHash = target ? weeklyTargetHash(target) : undefined;
  // Check evidence independently, without treating an editable target conflict as
  // evidence invalidation. Acknowledging a target can never certify new evidence.
  const rebased = { ...candidate,
    ...(candidate.weeklyRefresh ? { weeklyRefresh: { ...candidate.weeklyRefresh, targetHash: targetHash! } } : {}),
    ...(candidate.understandingReview ? { understandingReview: { ...candidate.understandingReview, targetHash } } : {}),
    ...(candidate.continuationReview ? { continuationReview: { ...(candidate.continuationReview.postCorrection || candidate.continuationReview.readingCorrection || candidate.continuationReview.shiyingCorrection
      ? (await rebasePostCorrectionComparison(database, candidate.continuationReview, postOptions))! : candidate.continuationReview), targetHash } } : {}),
  };
  if (!(await isWeeklyCandidateCurrent(database, rebased, postOptions)) || !(await isUnderstandingCandidateCurrent(database, rebased, postOptions))
    || !(await isConversationMemoryCandidateCurrent(database, rebased, postOptions))) return result('basis_changed');
  const previousHash = candidate.weeklyRefresh?.targetHash ?? candidate.understandingReview?.targetHash ?? candidate.continuationReview?.targetHash;
  return result(target && previousHash !== targetHash ? 'target_changed' : 'current');
}

export async function loadPendingMemoryCandidatesWithDatabase(
  database: SQLite.SQLiteDatabase,
  query: PendingMemoryCandidateQuery,
  postOptions: PostMemoryReadOptions = {},
) {
  const values = 'sessionId' in query ? [query.sessionId] : 'batchIds' in query ? query.batchIds
    : 'readingResult' in query ? [query.readingResult.bookId, query.readingResult.resultId]
    : 'understandingMemoryId' in query ? [query.understandingMemoryId] : 'weeklyMemoryId' in query && query.weeklyMemoryId ? [query.weeklyMemoryId] : [];
  if ('batchIds' in query && !values.length) return [];
  const condition = 'sessionId' in query
    ? "((b.session_id = ? AND b.stream NOT IN ('explicit_fact', 'current_state', 'history_import', 'post')) OR b.stream = 'weekly' OR (b.scope_key LIKE 'understanding-review:%' AND b.stream != 'post'))"
    : 'batchIds' in query ? `b.id IN (${values.map(() => '?').join(',')})`
      : 'readingResult' in query ? "json_extract(i.candidate_json, '$.readingBinding.bookId') = ? AND json_extract(i.candidate_json, '$.readingBinding.resultId') = ?"
      : 'understandingMemoryId' in query ? "json_extract(i.candidate_json, '$.understandingReview.targetMemoryId') = ?"
      : 'post' in query ? "b.stream = 'post'"
      : 'weekly' in query ? "b.stream = 'weekly'"
      : `b.stream = 'weekly' AND b.scope_key LIKE 'weekly-refresh:%'${values.length ? " AND json_extract(i.candidate_json, '$.weeklyRefresh.memoryId') = ?" : ''}`;
  const rows = await database.getAllAsync<{
    batch_id: string; item_key: string; candidate_json: string;
  }>(
    `SELECT i.batch_id, i.item_key, i.candidate_json
     FROM memory_ingestion_items i JOIN memory_ingestion_batches b ON b.id = i.batch_id
     WHERE i.status ${query.includeWaiting ? "IN ('pending', 'waiting')" : "= 'pending'"} AND i.candidate_json IS NOT NULL
       AND b.status IN ('pending', 'ready', 'failed', 'waiting') AND ${condition}
     ORDER BY CASE WHEN b.stream = 'weekly' THEN i.created_at ELSE i.updated_at END, i.batch_id, i.item_key`,
    ...values,
  );
  const candidates = new Map<string, MemoryCandidateReview>();
  for (const row of rows) {
    const candidate = JSON.parse(row.candidate_json) as MemoryCandidateReview;
    if (!candidate || typeof candidate.reviewId !== 'string' || typeof candidate.content !== 'string'
      || typeof candidate.title !== 'string' || !Array.isArray(candidate.tags)) {
      throw new Error('memory-ingestion-candidate-invalid');
    }
    if (candidate.lifeSelfBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('life-self-v1:'))
      || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('gift-source:'))
      || candidate.focusBindings?.length || candidate.sourceRefs?.some(ref => isFocusMemorySource(ref.sessionId))
      || candidate.postBindings?.length || candidate.origin === 'post' || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('post-source:'))
      || candidate.observationBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('observation-source:'))
      || candidate.shiyingBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('shiying-source-v1:'))
      || candidate.letterBindings?.length || candidate.readingBinding || candidate.readingBindings?.length || candidate.origin === 'voice_call' || candidate.understandingSubject || candidate.source === 'weekly-context' || candidate.continuationReview || candidate.currentStateReview) {
      candidate.reviewStatus = (await getMemoryCandidateReviewStatus(database, candidate, postOptions)).status;
    }
    if (candidate.understandingSubject) candidate.understandingStale = candidate.reviewStatus !== 'current';
    const previous = candidates.get(candidate.reviewId);
    const refs = new Map([
      ...(previous?.ingestionRefs ?? []), ...(candidate.ingestionRefs ?? []),
      { batchId: row.batch_id, itemKey: row.item_key },
    ].map((ref) => [`${ref.batchId}\u0000${ref.itemKey}`, ref]));
    candidates.set(candidate.reviewId, { ...candidate, ingestionRefs: [...refs.values()] });
  }
  const result = [...candidates.values()].map(candidate => beginMemoryCandidateEdit(candidate));
  const firstWeekly = result.find(candidate => candidate.source === 'weekly-context');
  return 'sessionId' in query ? result.filter(candidate => candidate.source !== 'weekly-context' || candidate === firstWeekly) : result;
}

export async function updatePendingMemoryCandidatesWithDatabase(
  database: SQLite.SQLiteDatabase,
  candidates: MemoryCandidateReview[],
  options: { hostHints?: boolean } = {},
) {
  const acknowledgments: Array<{ session: MemoryCandidateEditSession; hash: string }> = [];
  for (const candidate of candidates) {
    const refs = candidate.ingestionRefs ?? [];
    if (!refs.length) continue;
    const previous = await database.getFirstAsync<{ candidate_json: string | null }>(
      "SELECT candidate_json FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ? AND status IN ('pending', 'waiting')", refs[0].batchId, refs[0].itemKey);
    const original = previous?.candidate_json ? JSON.parse(previous.candidate_json) as MemoryCandidateReview : null;
    // A save/discard can finish during the typing delay. Its late edit is obsolete,
    // and must not roll back edits to other cards in the same batch.
    if (!original) continue;
    if (original.reviewId !== candidate.reviewId) throw new Error('MEMORY_CANDIDATE_CHANGED');
    const referenceRows = await database.getAllAsync<{ batch_id: string; item_key: string }>(
      `SELECT i.batch_id, i.item_key FROM memory_ingestion_items i JOIN memory_ingestion_batches b ON b.id = i.batch_id
       WHERE i.status IN ('pending', 'waiting') AND b.stream != 'current_state' AND json_extract(i.candidate_json, '$.reviewId') = ?`, original.reviewId);
    const ownedRefs = referenceRows.map(row => ({ batchId: row.batch_id, itemKey: row.item_key }));
    if (!ownedRefs.length) continue;
    const persisted = { ...original, ingestionRefs: ownedRefs,
      ...(options.hostHints ? { admission: candidate.admission,
        duplicateHint: (candidate as MemoryCandidateReview & { duplicateHint?: string }).duplicateHint } : {}),
      ...memoryCandidateEditableFields({ ...candidate,
      understandingSubject: original.understandingSubject, source: original.source, origin: original.origin,
      currentStateReview: original.currentStateReview, readingBinding: original.readingBinding,
      continuationReview: original.continuationReview, episodeSummaryEnabled: original.episodeSummaryEnabled }) };
    const session = candidate[memoryCandidateEditSession];
    const originalHash = memoryCandidateEditableHash(original);
    const persistedHash = memoryCandidateEditableHash(persisted);
    if (session && session.hash !== originalHash && persistedHash !== originalHash) throw new Error('MEMORY_CANDIDATE_CHANGED');
    // One statement updates all refs; edits cannot resurrect saved/discarded items.
    await database.runAsync(
      `UPDATE memory_ingestion_items SET candidate_json = ?, updated_at = ?
       WHERE status IN ('pending', 'waiting') AND json_extract(candidate_json, '$.reviewId') = ?
         AND (${ownedRefs.map(() => '(batch_id = ? AND item_key = ?)').join(' OR ')})`,
      JSON.stringify(persisted), Date.now(), original.reviewId, ...ownedRefs.flatMap((ref) => [ref.batchId, ref.itemKey]),
    );
    if (session) acknowledgments.push({ session, hash: persistedHash });
  }
  return acknowledgments;
}
