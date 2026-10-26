import { memoryCandidateEditableHash, type MemoryCandidateReview } from './memoryCandidateReview';
import { runMemoryCandidateSave } from './memoryIngestionService';
import { createMemory } from './memoryStore';
import { notifyWeeklyRefreshChanges, saveWeeklyRefreshCandidate } from './memoryWeeklyRefresh';
import { notifyMemoryProcessingWorkAvailable } from './memoryProcessingSignals';

export async function saveWeeklyCandidate(candidate: MemoryCandidateReview) {
  if (candidate.weeklyRefresh) return saveWeeklyRefreshCandidate(candidate);
  if (candidate.source !== 'weekly-context' || !candidate.weeklyContextBasis) throw new Error('MEMORY_WEEKLY_STALE');
  const id = await runMemoryCandidateSave(candidate, (stored, dataEpoch) => createMemory(stored, {
    confirmationLevel: 'reviewed', sourceRefs: stored.sourceRefs,
    ingestionResolutions: stored.ingestionRefs, requirePendingIngestion: true, dataEpoch,
    ingestionExpectedCandidate: { reviewId: stored.reviewId, editableHash: memoryCandidateEditableHash(stored) },
  }));
  notifyWeeklyRefreshChanges();
  notifyMemoryProcessingWorkAvailable('memory_changed');
  return id;
}
