import type { SQLiteDatabase } from 'expo-sqlite';
import { memoryCandidateEditableFields, memoryCandidateEditableHash, type MemoryCandidateReview } from '../memory/memoryCandidateReview';
import type { PostReviewActionRecord } from '../sync/syncBaiyunPostReviews';

type ReviewRow = { status: string; candidate_json: string | null; post_review_owner_device_id: string | null };
export type PostReviewOwnerPort = {
  database: SQLiteDatabase;
  ownerDeviceId: string;
  edit(candidate: MemoryCandidateReview, expectedHash: string): Promise<MemoryCandidateReview>;
  save(candidate: MemoryCandidateReview): Promise<unknown>;
  discard(candidate: MemoryCandidateReview): Promise<void>;
  compare(candidate: MemoryCandidateReview, targetHash: string): Promise<unknown>;
};

// Transport applies only business rows. Only the generating phone executes the
// human decision, through the same review/save functions as its own editor.
export async function processSharedPostReviewAction(id: string, port: PostReviewOwnerPort) {
  const action = await port.database.getFirstAsync<PostReviewActionRecord>('SELECT * FROM baiyun_post_review_actions WHERE id=?', id);
  if (!action || action.state !== 'pending' || action.owner_device_id !== port.ownerDeviceId) return;
  const finish = (state: 'applied' | 'rejected', error: string | null = null) => port.database.runAsync(
    "UPDATE baiyun_post_review_actions SET state=?, error=?, resolved_at=? WHERE id=? AND state='pending'", state, error, Date.now(), id);
  const rows = await port.database.getAllAsync<ReviewRow>(
    `SELECT i.status,i.candidate_json,COALESCE(i.post_review_owner_device_id,
      (SELECT source_device_id FROM memory_sync_runtime WHERE singleton_id=1)) AS post_review_owner_device_id FROM memory_ingestion_items i
      JOIN memory_ingestion_batches b ON b.id=i.batch_id
      WHERE b.stream='post' AND i.post_review_id=?`, action.review_id);
  if (!rows.length || rows.some(row => row.post_review_owner_device_id !== port.ownerDeviceId)) {
    await finish('rejected', '草稿已不存在或确认设备已变化，请刷新。'); return;
  }
  const requested = JSON.parse(action.candidate_json) as MemoryCandidateReview;
  const desiredHash = memoryCandidateEditableHash(requested);
  if (rows.every(row => row.status === 'saved' && row.candidate_json
    && JSON.parse(row.candidate_json).savedReviewId === action.review_id
    && JSON.parse(row.candidate_json).savedEditableHash === desiredHash) && action.action === 'save') {
    await finish('applied'); return;
  }
  if (rows.every(row => row.status === 'discarded') && action.action === 'discard') { await finish('applied'); return; }
  if (rows.some(row => row.status !== 'pending' || !row.candidate_json)) {
    await finish('rejected', '这份草稿已处理或暂不能审核，请刷新。'); return;
  }
  const original = JSON.parse(rows[0].candidate_json!) as MemoryCandidateReview;
  if (original.reviewId !== action.review_id || rows.some(row => JSON.parse(row.candidate_json!).reviewId !== action.review_id)) {
    await finish('rejected', '草稿身份已变化，请刷新。'); return;
  }
  if (rows.some(row => memoryCandidateEditableHash(JSON.parse(row.candidate_json!)) !== memoryCandidateEditableHash(original))) {
    await finish('rejected', '草稿的关联条目不一致，请在手机重新核对。'); return;
  }
  // Incoming identity, evidence, epochs and correction bindings are never used.
  const desired = { ...original, ...memoryCandidateEditableFields({ ...requested,
    currentStateReview: original.currentStateReview, understandingSubject: original.understandingSubject,
    source: original.source, origin: original.origin }) };
  if (action.action !== 'discard' && (!desired.title.trim() || !desired.content.trim() || (desired.rememberedReason ?? '').trim().length > 80)) {
    await finish('rejected', '标题和正文不能为空，记住的理由最多80字符。'); return;
  }
  const currentHash = memoryCandidateEditableHash(original);
  if (currentHash !== action.expected_editable_hash && currentHash !== memoryCandidateEditableHash(desired)) {
    await finish('rejected', '手机上的草稿已修改，请刷新后重新审核。'); return;
  }
  try {
    const stored = await port.edit(desired, currentHash);
    if (action.action === 'save') await port.save(stored);
    else if (action.action === 'discard') await port.discard(stored);
    else if (action.action === 'compare') {
      if (!action.target_hash) throw new Error('MEMORY_CANDIDATE_CHANGED');
      const acknowledged = stored.currentStateReview?.targetHash ?? stored.understandingReview?.targetHash ?? stored.continuationReview?.targetHash;
      if (acknowledged !== action.target_hash) await port.compare(stored, action.target_hash);
    }
    await finish('applied');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // SQL/I/O failures keep the inbox/request pending for its existing retry.
    // Semantic rejection is a durable answer; repeating it cannot change data.
    if (!/MEMORY_CANDIDATE_|POST_MEMORY_SOURCE_|MEMORY_DATA_CHANGED|memory-candidate-write-stale|MEMORY_UNDERSTANDING_STALE|current-state-target-changed|memory-understanding|memory-source-changed/.test(message)) throw error;
    await finish('rejected', '依据、原卡或草稿已变化，请刷新；依据变化请在手机重新核对。');
  }
}

export async function processPhonePostReviewAction(id: string) {
  const [{ getMemoryDatabase }, ingestion, runtime, reviewPersistence, epoch] = await Promise.all([
    import('../memory/memoryStore'), import('../memory/memoryIngestionService'), import('./baiyunPostMemoryRuntime'),
    import('../memory/memoryCandidatePersistence'), import('../backup/backupRestoreCoordinator'),
  ]);
  const database = await getMemoryDatabase();
  const identity = await database.getFirstAsync<{ source_device_id: string | null }>('SELECT source_device_id FROM memory_sync_runtime WHERE singleton_id=1');
  if (!identity?.source_device_id) return;
  const dataEpoch = epoch.captureBackupRestoreDataEpoch();
  const check = () => { if (!epoch.canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('MEMORY_DATA_CHANGED'); };
  await processSharedPostReviewAction(id, { database, ownerDeviceId: identity.source_device_id,
    edit: async (candidate, expectedHash) => {
      check();
      const commit = await epoch.runBackupRestoreDataEpochCommit(dataEpoch, () => database.withExclusiveTransactionAsync(async transaction => {
        check();
        const ref = candidate.ingestionRefs?.[0];
        const row = ref && await transaction.getFirstAsync<{ candidate_json: string | null }>(
          "SELECT candidate_json FROM memory_ingestion_items WHERE batch_id=? AND item_key=? AND status='pending'", ref.batchId, ref.itemKey);
        if (!row?.candidate_json || memoryCandidateEditableHash(JSON.parse(row.candidate_json)) !== expectedHash) throw new Error('MEMORY_CANDIDATE_CHANGED');
        await reviewPersistence.updatePendingMemoryCandidatesWithDatabase(transaction, [candidate]);
      }));
      if (!commit.committed) throw new Error('MEMORY_DATA_CHANGED');
      return candidate;
    },
    save: candidate => runtime.savePostReviewCandidate(candidate, dataEpoch, false),
    discard: candidate => runtime.discardPostReviewCandidate(candidate, dataEpoch, false),
    compare: async (candidate, targetHash) => { check(); return ingestion.acknowledgeMemoryCandidateTarget(candidate, targetHash); },
  });
}
