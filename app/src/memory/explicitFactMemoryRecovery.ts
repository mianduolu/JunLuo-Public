import type { AiConnection } from '../ai/types';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { loadChatPreferences } from '../chat/chatPreferences';
import { loadChatSessionMessage } from '../chat/chatStorage';
import { loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { filterAutomaticMemoryCandidates } from './memoryAdmissionControl';
import { makeMemoryIngestionSourceHash, stableMemoryHash } from './memoryAtomicity';
import type { MemoryCandidateReview } from './memoryCandidateReview';
import {
  beginMemoryIngestionBatch, loadDueExplicitFactBatchIds, loadMemoryIngestionBatch,
  loadPendingMemoryCandidates, markMemoryIngestionBatchFailed,
  registerMemoryIngestionOutcome, resolveMemoryIngestionItems,
} from './memoryIngestionService';
import { extractExplicitFactMemory } from './memoryOrganizer';
import { hasMemoryOrganizerConfig } from './memoryOrganizerConfigNotice';
import { runMemoryOrganizerRequestWithDeadline } from './memoryOrganizerRequestLifecycle';
import { classifyMemoryProcessingError } from './memoryProcessingError';
import { buildSingleMemorySourceRef } from './memorySourceRefs';
import { createMemory, loadMemories } from './memoryStore';

export const EXPLICIT_FACT_RETRY_DELAY_MS = 5 * 60_000;
let pendingRuns = 0;
let runTail: Promise<void> = Promise.resolve();
let retryNotBefore = 0;
let lastConfiguration = '';
let blockedConfiguration = '';

export async function enqueueExplicitFactMemory(input: {
  dataEpoch: number | null; force: boolean; message: SubjectiveMessage; sessionId: string;
}) {
  const { dataEpoch, force, message, sessionId } = input;
  const sourceHash = makeMemoryIngestionSourceHash([message]);
  const id = `memory-ingestion-explicit_fact-${stableMemoryHash(`${sessionId}\u0000${sourceHash}`)}`;
  return runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    const stored = await loadChatSessionMessage(sessionId, message.id);
    if (!stored || stored.role !== 'you' || makeMemoryIngestionSourceHash([stored]) !== sourceHash) return;
    if (await loadMemoryIngestionBatch(id)) return;
    await beginMemoryIngestionBatch({
      id, stream: 'explicit_fact', sessionId, sourceHash, advancesCursor: false,
      // These scopes preserve the existing music opt-in when automatic facts are off.
      scopeKey: force ? 'music_preference' : 'explicit_fact',
      sourceFirstAt: message.createdAt, sourceLastAt: message.createdAt,
      sourceFirstMessageId: message.id, sourceLastMessageId: message.id,
    });
  });
}

type RecoveryOptions = {
  ai: { connection?: AiConnection; key: string };
  automaticEnabled: boolean;
  getAutomaticEnabled?: () => boolean;
  afterReply?: boolean;
  canRun?: () => boolean;
};

export function resumeExplicitFactMemories(input: RecoveryOptions) {
  if (!input.afterReply && pendingRuns > 0) return Promise.resolve(undefined);
  pendingRuns += 1;
  const result = runTail.then(() => processOneExplicitFact(input)).finally(() => { pendingRuns -= 1; });
  runTail = result.then(() => undefined, () => undefined);
  return result;
}

async function processOneExplicitFact(input: RecoveryOptions) {
  if (!hasMemoryOrganizerConfig(input.ai)) return;
  const { ai } = input;
  const configuration = JSON.stringify([ai.connection, ai.key]);
  const configurationChanged = Boolean(lastConfiguration && lastConfiguration !== configuration);
  if (configurationChanged) retryNotBefore = 0;
  lastConfiguration = configuration;
  if (blockedConfiguration === configuration || Date.now() < retryNotBefore) return;
  const dataEpoch = captureBackupRestoreDataEpoch();
  const canRun = () => canCommitBackupRestoreDataEpoch(dataEpoch) && (input.canRun?.() ?? true);
  if (!canRun()) return;
  let batchId: string | undefined;
  try {
    if (!input.afterReply && !(await loadAutomaticRemoteAiPolicy()).enabled) return;
    const { musicEnabled } = await loadChatPreferences();
    const [due] = await loadDueExplicitFactBatchIds({
      automaticEnabled: input.getAutomaticEnabled?.() ?? input.automaticEnabled, musicEnabled,
      retryBefore: Date.now() - (configurationChanged ? 0 : EXPLICIT_FACT_RETRY_DELAY_MS),
    });
    if (!due || !canRun()) return;
    batchId = due.id;
    const batch = await loadMemoryIngestionBatch(batchId);
    if (!batch?.sessionId || !batch.sourceFirstMessageId) return;
    const { sessionId } = batch;
    const isCurrentlyAllowed = async () => {
      const music = batch.scopeKey === 'music_preference' && (await loadChatPreferences()).musicEnabled;
      const remote = input.afterReply || (await loadAutomaticRemoteAiPolicy()).enabled;
      return remote && canRun() && ((input.getAutomaticEnabled?.() ?? input.automaticEnabled) || music);
    };
    const message = await loadChatSessionMessage(sessionId, batch.sourceFirstMessageId);
    let [candidate] = await loadPendingMemoryCandidates({ batchIds: [batchId] });
    const finishWithoutMemory = () => runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      if (candidate?.ingestionRefs?.length) await resolveMemoryIngestionItems(candidate.ingestionRefs, 'suppressed');
      else await registerMemoryIngestionOutcome({ batchId: batch.id, pendingItemKeys: [] });
    });
    if (!message || message.role !== 'you' || makeMemoryIngestionSourceHash([message]) !== batch.sourceHash) {
      await finishWithoutMemory();
      return;
    }
    if (!canRun()) return;
    if (!candidate) {
      const existing = (await loadMemories({ currentOnly: true })).filter(memory => !memory.understandingSubject);
      const drafts = await runMemoryOrganizerRequestWithDeadline(async (signal) => {
        if (!await isCurrentlyAllowed()) throw new Error('memory-retry-paused');
        return extractExplicitFactMemory({
          apiKey: ai.key, connection: ai.connection!, message, signal,
          existingMemories: existing.map((memory) => memory.content),
        });
      });
      // Foreground/setting changes pause new work, but never discard a paid result.
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      if (!drafts[0]) { await finishWithoutMemory(); return; }
      const ref = { batchId, itemKey: 'explicit_fact' };
      const pending: MemoryCandidateReview = {
        ...drafts[0], reviewId: batchId, origin: 'proposal', ingestionRefs: [ref],
        sourceStartAt: message.createdAt, sourceEndAt: message.createdAt,
        sourceRefs: buildSingleMemorySourceRef(sessionId, message),
      };
      await runBackupRestoreDataEpochCommit(dataEpoch, () => registerMemoryIngestionOutcome({
        batchId: batch.id, pendingItemKeys: [ref.itemKey],
        pendingCandidates: [{ itemKey: ref.itemKey, candidateJson: JSON.stringify(pending) }],
      }));
      [candidate] = await loadPendingMemoryCandidates({ batchIds: [batchId] });
      if (!candidate) return;
    }
    // Reload after the request: a deleted/edited source must not become a new memory.
    const currentSource = await loadChatSessionMessage(sessionId, message.id);
    if (!currentSource || makeMemoryIngestionSourceHash([currentSource]) !== batch.sourceHash) {
      await finishWithoutMemory(); return;
    }
    const existing = (await loadMemories({ currentOnly: true })).filter(memory => !memory.understandingSubject);
    if (!(await filterAutomaticMemoryCandidates([candidate], { existingMemories: existing })).length) {
      await finishWithoutMemory(); return;
    }
    if (!await isCurrentlyAllowed()) return;
    const created = await runBackupRestoreDataEpochCommit(dataEpoch, () => createMemory(candidate, {
      confirmationLevel: 'automatic', dataEpoch,
      continuationAi: { apiKey: ai.key, connection: ai.connection! },
      ingestionResolutions: candidate.ingestionRefs, requirePendingIngestion: true,
      sourceRefs: candidate.sourceRefs, sourceTraceMode: 'exact',
    }));
    if (created.committed && canRun()) return { sessionId, title: candidate.title };
  } catch (error) {
    if (error instanceof Error && error.message === 'memory-retry-paused') return;
    const classification = classifyMemoryProcessingError(error);
    if (classification.kind === 'blocked') blockedConfiguration = configuration;
    retryNotBefore = Date.now() + EXPLICIT_FACT_RETRY_DELAY_MS;
    if (batchId) await runBackupRestoreDataEpochCommit(dataEpoch, () => markMemoryIngestionBatchFailed(batchId!)).catch(() => undefined);
  }
}
