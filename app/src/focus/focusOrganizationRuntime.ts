import type { AiConnection } from '../ai/types';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { stableMemoryHash, makeMemoryCandidateKey } from '../memory/memoryAtomicity';
import { makeReviewCandidates, memoryCandidateEditableHash, type MemoryCandidateReview } from '../memory/memoryCandidateReview';
import { prepareConversationMaterials } from '../memory/memoryConversationMaterials';
import { beginMemoryIngestionBatch, loadMemoryIngestionBatch, loadPendingMemoryCandidates, registerMemoryIngestionOutcome,
  resolveMemoryIngestionItems, runMemoryCandidateSave } from '../memory/memoryIngestionService';
import { organizeFocusRecord } from '../memory/memoryOrganizer';
import { runMemoryOrganizerRequestWithDeadline } from '../memory/memoryOrganizerRequestLifecycle';
import { createMemory } from '../memory/memoryStore';
import { saveCurrentStateReview } from '../memory/memoryCurrentStateReview';
import { saveConversationMemoryCandidate } from '../memory/memoryEpisodeReview';
import { saveUnderstandingCandidate } from '../memory/memoryUnderstandingReview';
import { notifyMemoryProcessingUpdated } from '../memory/memoryProcessingSignals';
import { focusMemorySourceSessionId, focusMemoryMessageHash, loadFocusMemoryMessages } from './focusMemorySource';
import { buildFocusOrganizationMaterial } from './focusOrganizationProtocol';
import { loadFocusOrganization, loadFocusReviewRecords, loadFocusSessionById, markFocusOrganizationRegistered, saveFocusOrganization } from './focusStore';
import type { FocusOrganizationRecord } from './focusSummaryRecord';

export const focusOrganizationBatchId = (sessionId: string) => `focus-organization:${sessionId}`;
const running = new Map<string, Promise<FocusOrganizationRecord | null>>();
const checkEpoch = (epoch: number | null) => {
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
};

export async function loadFocusReviewCandidates(sessionId: string) {
  return loadPendingMemoryCandidates({ batchIds: [focusOrganizationBatchId(sessionId)] });
}

export async function loadUnfinishedFocusReviews() {
  const records = await loadFocusReviewRecords();
  const reviews = await Promise.all(records.map(async ({ session, record }) => {
    const pending = await loadFocusReviewCandidates(session.id);
    if (pending.length || record.registered) return { session, count: pending.length };
    const batch = await loadMemoryIngestionBatch(focusOrganizationBatchId(session.id));
    return { session, count: batch && ['ready', 'resolved', 'no_value'].includes(batch.status) ? 0 : record.candidates!.length };
  }));
  return reviews.filter(review => review.count > 0);
}

async function registerCachedResult(sessionId: string, record: FocusOrganizationRecord, epoch: number | null) {
  checkEpoch(epoch);
  if (record.registered || record.candidates === undefined) return record;
  const batchId = focusOrganizationBatchId(sessionId);
  const existing = await loadMemoryIngestionBatch(batchId);
  if (!existing || !['ready', 'resolved', 'no_value'].includes(existing.status)) {
    const session = await loadFocusSessionById(sessionId);
    if (!session) throw new Error('MEMORY_SOURCE_CHANGED');
    const candidates = record.candidates.map(candidate => ({ ...candidate,
      ingestionRefs: [{ batchId, itemKey: makeMemoryCandidateKey(candidate) }] }));
    const began = await runBackupRestoreDataEpochCommit(epoch, () => beginMemoryIngestionBatch({
      id: batchId, stream: 'manual_digest', advancesCursor: false, scopeKey: `focus:${sessionId}`,
      sessionId: focusMemorySourceSessionId(sessionId),
      sourceHash: stableMemoryHash(JSON.stringify(record.candidates)),
      sourceFirstAt: session.startedAt, sourceLastAt: session.endedAt,
      sourceFirstMessageId: candidates[0]?.sourceRefs?.[0]?.messageId,
      sourceLastMessageId: candidates.at(-1)?.sourceRefs?.at(-1)?.messageId,
    }));
    if (!began.committed) throw new Error('MEMORY_DATA_CHANGED');
    checkEpoch(epoch);
    await registerMemoryIngestionOutcome({ batchId, canCommit: () => canCommitBackupRestoreDataEpoch(epoch),
      pendingItemKeys: candidates.map(makeMemoryCandidateKey),
      pendingCandidates: candidates.map(candidate => ({ itemKey: makeMemoryCandidateKey(candidate), candidateJson: JSON.stringify(candidate) })),
    });
  }
  checkEpoch(epoch);
  const saved = await markFocusOrganizationRegistered(sessionId, epoch);
  if (!saved) throw new Error('focus-result-save-failed');
  notifyMemoryProcessingUpdated();
  return saved;
}

/** Restore a cached result without contacting a model again. */
export async function recoverFocusOrganization(sessionId: string, epoch = captureBackupRestoreDataEpoch()) {
  checkEpoch(epoch);
  const record = await loadFocusOrganization(sessionId);
  return record ? registerCachedResult(sessionId, record, epoch) : null;
}

export function organizeFocusSession(input: {
  sessionId: string; apiKey: string; connection: AiConnection; dataEpoch?: number | null; retryIncomplete?: boolean;
}) {
  const current = running.get(input.sessionId);
  if (current) return current;
  const operation = runOrganization(input);
  running.set(input.sessionId, operation);
  void operation.finally(() => { if (running.get(input.sessionId) === operation) running.delete(input.sessionId); }).catch(() => undefined);
  return operation;
}

async function runOrganization(input: Parameters<typeof organizeFocusSession>[0]) {
  const epoch = input.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : input.dataEpoch;
  checkEpoch(epoch);
  const cached = await loadFocusOrganization(input.sessionId);
  // Partial successes also remain available. A failed ledger write only retries
  // registration, not the expensive model generation.
  if (cached && !(input.retryIncomplete && (!cached.summary || cached.candidates === undefined))) {
    return registerCachedResult(input.sessionId, cached, epoch);
  }
  const session = await loadFocusSessionById(input.sessionId);
  if (!session) throw new Error('MEMORY_SOURCE_CHANGED');
  if (!input.apiKey.trim()) throw new Error('focus-organizer-not-configured');
  const sessionId = focusMemorySourceSessionId(session.id);
  const messages = await loadFocusMemoryMessages(sessionId);
  const sourceVersion = JSON.stringify(messages.map(message => [message.id, focusMemoryMessageHash(message)]));
  checkEpoch(epoch);
  const result = await runMemoryOrganizerRequestWithDeadline(async signal => {
    const materials = await prepareConversationMaterials({ sessionId, messages, focusWholeSession: true, signal });
    checkEpoch(epoch);
    return organizeFocusRecord({ apiKey: input.apiKey, connection: input.connection, messages,
      understandingMaterials: materials, recordMaterial: buildFocusOrganizationMaterial(session, messages),
      renderRecordMaterial: references => buildFocusOrganizationMaterial(session, messages, references), signal });
  }, { timeoutMs: 60_000 });
  checkEpoch(epoch);
  const currentSession = await loadFocusSessionById(session.id);
  if (!currentSession || (['startedAt', 'endedAt', 'durationSeconds', 'mode', 'userActivity', 'baiyunActivity'] as const)
    .some(key => currentSession[key] !== session[key])
    || JSON.stringify((await loadFocusMemoryMessages(sessionId)).map(message => [message.id, focusMemoryMessageHash(message)])) !== sourceVersion) {
    throw new Error('MEMORY_SOURCE_CHANGED');
  }
  checkEpoch(epoch);
  const record: FocusOrganizationRecord = { version: 1, summary: result.summary, registered: false,
    candidates: result.candidates === undefined ? undefined : makeReviewCandidates(result.candidates, 'proposal', {
      sessionId, messages, sourceStartAt: session.startedAt, sourceEndAt: session.endedAt,
    }) };
  const saved = await saveFocusOrganization(session.id, record, epoch);
  if (!saved) throw new Error('focus-result-save-failed');
  return registerCachedResult(session.id, saved, epoch);
}

export async function saveFocusReviewCandidate(candidate: MemoryCandidateReview, epoch = captureBackupRestoreDataEpoch()) {
  checkEpoch(epoch);
  const result = candidate.currentStateReview ? await saveCurrentStateReview(candidate, { dataEpoch: epoch })
    : candidate.continuationReview ? await saveConversationMemoryCandidate(candidate, { dataEpoch: epoch })
    : candidate.understandingSubject ? await saveUnderstandingCandidate(candidate, { dataEpoch: epoch })
    : await runMemoryCandidateSave(candidate, (stored, dataEpoch) => createMemory({ ...stored }, {
    confirmationLevel: 'reviewed', ingestionResolutions: stored.ingestionRefs,
    requirePendingIngestion: !!stored.ingestionRefs?.length, dataEpoch,
    ingestionExpectedCandidate: { reviewId: stored.reviewId, editableHash: memoryCandidateEditableHash(stored) },
    sourceRefs: stored.sourceRefs, sourceTraceMode: stored.sourceRefs?.length ? 'exact' : 'none',
  }), { dataEpoch: epoch });
  notifyMemoryProcessingUpdated();
  return result;
}

export async function discardFocusReviewCandidate(candidate: MemoryCandidateReview, epoch = captureBackupRestoreDataEpoch()) {
  checkEpoch(epoch);
  if (!candidate.ingestionRefs?.length) throw new Error('FOCUS_MEMORY_DRAFT_MISSING');
  const result = await runBackupRestoreDataEpochCommit(epoch, () => resolveMemoryIngestionItems(candidate.ingestionRefs!, 'discarded'));
  if (!result.committed) throw new Error('MEMORY_DATA_CHANGED');
  notifyMemoryProcessingUpdated();
}
