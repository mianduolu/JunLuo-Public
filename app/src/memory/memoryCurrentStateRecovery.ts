import type { MemoryCurrentStateCandidate, MemoryCurrentStateResolveCandidate } from './memoryCurrentStateCandidates';
import { stableMemoryHash } from './memoryAtomicity';
import {
  beginMemoryIngestionBatchWithDatabase, registerMemoryIngestionOutcomeWithDatabase,
  resolveMemoryIngestionItemsWithDatabase,
} from './memoryIngestionLedger';
import { getMemoryDatabase } from './memoryStore';
import { runMemoryDuplicateCleanupBusinessWrite } from './memoryDuplicateCleanupState';
import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';

type StateReview = MemoryCurrentStateCandidate | MemoryCurrentStateResolveCandidate;

// Each card uses the existing ingestion ledger; saved/discarded decisions survive reopening.
export async function queueCurrentStateReviews(sessionId: string, candidates: StateReview[]) {
  if (!candidates.length) return;
  const epoch = captureBackupRestoreDataEpoch();
  await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
    const connection = await getMemoryDatabase('current_state');
    await connection.withExclusiveTransactionAsync(async (database) => {
      for (const candidate of candidates) {
        if (!('stateId' in candidate) && candidate.sourceCandidateId && !await database.getFirstAsync(
          `SELECT 1 FROM memory_ingestion_items i JOIN memory_ingestion_batches b ON b.id = i.batch_id
           WHERE b.session_id = ? AND b.stream != 'current_state'
             AND json_extract(i.candidate_json, '$.reviewId') = ? LIMIT 1`, sessionId, candidate.sourceCandidateId,
        )) continue;
        const identity = 'stateId' in candidate
          ? `resolve:${candidate.stateId}:${candidate.reason}` : candidate.reviewId;
        const id = `memory-current-state-review-${stableMemoryHash(`${sessionId}\u0000${identity}`)}`;
        const refs = candidate.sourceRefs ?? [];
        const batch = await beginMemoryIngestionBatchWithDatabase(database, {
          id, stream: 'current_state', sessionId, scopeKey: sessionId, advancesCursor: false,
          sourceHash: stableMemoryHash(identity),
          sourceFirstMessageId: refs[0]?.messageId,
          sourceLastMessageId: refs[refs.length - 1]?.messageId,
          sourceFirstAt: refs[0]?.messageCreatedAt,
          sourceLastAt: refs[refs.length - 1]?.messageCreatedAt,
        });
        if (batch && ['resolved', 'no_value', 'stale'].includes(batch.status)) continue;
        if (!('stateId' in candidate) && await database.getFirstAsync(
          `SELECT 1 FROM memory_ingestion_items i JOIN memory_ingestion_batches b ON b.id = i.batch_id
           WHERE b.stream = 'current_state' AND b.session_id = ? AND b.id != ? AND i.status = 'pending'
             AND json_type(i.candidate_json, '$.stateId') IS NULL
             AND json_extract(i.candidate_json, '$.title') = ?
             AND json_extract(i.candidate_json, '$.content') = ? LIMIT 1`,
          sessionId, id, candidate.title, candidate.content,
        )) {
          await registerMemoryIngestionOutcomeWithDatabase(database, { batchId: id, pendingItemKeys: [] });
          continue;
        }
        await registerMemoryIngestionOutcomeWithDatabase(database, {
          batchId: id, pendingItemKeys: ['card'],
          pendingCandidates: [{ itemKey: 'card', candidateJson: JSON.stringify({
            ...candidate, requiresRecheck: true, ingestionRef: { batchId: id, itemKey: 'card' },
          }) }],
        });
      }
    });
  }));
}

export async function loadPendingCurrentStateReviews(sessionId: string, _now = Date.now()) {
  const database = await getMemoryDatabase('current_state');
  const rows = await database.getAllAsync<{ candidate_json: string }>(
    `SELECT i.candidate_json FROM memory_ingestion_items i
     JOIN memory_ingestion_batches b ON b.id = i.batch_id
     WHERE b.stream = 'current_state' AND b.session_id = ?
       AND b.status IN ('pending', 'ready', 'failed', 'waiting') AND i.status = 'pending'
       AND i.candidate_json IS NOT NULL ORDER BY i.created_at, b.id`, sessionId,
  );
  const currentStateCandidates: MemoryCurrentStateCandidate[] = [];
  const currentStateResolveCandidates: MemoryCurrentStateResolveCandidate[] = [];
  for (const row of rows) {
    const candidate = JSON.parse(row.candidate_json) as StateReview;
    if (!candidate || typeof candidate.reviewId !== 'string' || typeof candidate.title !== 'string'
      || typeof candidate.content !== 'string' || !candidate.ingestionRef) {
      throw new Error('current-state-review-invalid');
    }
    if ('stateId' in candidate) {
      currentStateResolveCandidates.push({ ...candidate, requiresRecheck: true });
    } else {
      currentStateCandidates.push({ ...candidate, requiresRecheck: true });
    }
  }
  return { currentStateCandidates, currentStateResolveCandidates };
}

export async function discardCurrentStateReview(candidate: StateReview) {
  if (!candidate.ingestionRef) return;
  const database = await getMemoryDatabase('current_state');
  await runMemoryDuplicateCleanupBusinessWrite(() => database.withExclusiveTransactionAsync(
    (transaction) => resolveMemoryIngestionItemsWithDatabase(transaction, [candidate.ingestionRef!], 'discarded'),
  ));
}
