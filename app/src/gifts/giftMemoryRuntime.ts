import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { runBudgetedAiCall } from '../ai/aiCallBudget';
import { isChatReplyInFlight } from '../ai/aiRuntimeScheduler';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { isJunluoWantsAwake, isWantsClockOwner } from '../life/junluoDesireRuntime';
import { filterAutomaticMemoryCandidates } from '../memory/memoryAdmissionControl';
import { makeMemoryCandidateKey, stableMemoryHash } from '../memory/memoryAtomicity';
import { makeReviewCandidates, memoryCandidateTargetKey, type MemoryCandidateReview } from '../memory/memoryCandidateReview';
import { prepareConversationMaterials } from '../memory/memoryConversationMaterials';
import { runMemoryDuplicateCleanupBusinessWrite } from '../memory/memoryDuplicateCleanupState';
import { loadMemoryIngestionBatchWithDatabase, type MemoryIngestionBatch } from '../memory/memoryIngestionLedger';
import { beginMemoryIngestionBatch, loadMemoryIngestionBatch, loadPendingMemoryCandidates,
  markMemoryIngestionBatchFailed, registerMemoryIngestionOutcome } from '../memory/memoryIngestionService';
import { organizeConversationMemories } from '../memory/memoryOrganizer';
import { runMemoryOrganizerRequestWithDeadline } from '../memory/memoryOrganizerRequestLifecycle';
import { getMemoryDatabase } from '../memory/memoryStore';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { loadAndroidSyncNetworkClass } from '../sync/syncAndroidNetworkClass';
import { giftMemoryCandidateForPersistence, giftMemorySourceEnvelope, listGiftMemorySourceSessionIds, readGiftMemorySource, validateGiftMemoryBindings,
  type GiftMemoryBinding, type GiftMemorySource } from './giftMemorySource';

type PaidResult = { batchId: string; dataEpoch: number | null; candidates: MemoryCandidateReview[];
  admitted?: { candidates: MemoryCandidateReview[]; suppressedItemKeys: string[] } };
const unsaved = new Map<string, PaidResult>();
let running: Promise<void> | undefined;
const bindingKey = (binding: GiftMemoryBinding) => JSON.stringify([binding.sessionId, binding.messageId, binding.sourceHash, binding.giftHash]);
const registered = (batch: MemoryIngestionBatch) => ['ready', 'resolved', 'no_value'].includes(batch.status)
  || batch.status === 'waiting' && batch.itemCount > 0;
const checkEpoch = (epoch: number | null) => { if (!canCommitBackupRestoreDataEpoch(epoch)) throw Error('MEMORY_DATA_CHANGED'); };

async function giftBatches() {
  const database = await getMemoryDatabase();
  const rows = await database.getAllAsync<{ id: string }>("SELECT id FROM memory_ingestion_batches WHERE stream = 'gift' ORDER BY created_at, id");
  const result: MemoryIngestionBatch[] = [];
  for (const row of rows) { const batch = await loadMemoryIngestionBatch(row.id); if (batch) result.push(batch); }
  return result;
}

async function clearCached(batchId: string, epoch: number | null) {
  const database = await getMemoryDatabase();
  const result = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(() =>
    database.withExclusiveTransactionAsync(async transaction => {
      const batch = await loadMemoryIngestionBatchWithDatabase(transaction, batchId);
      if (!batch?.workMetadata?.gift) return;
      const { cachedCandidates: _cached, suppressedItemKeys: _suppressed, ...gift } = batch.workMetadata.gift;
      await transaction.runAsync('UPDATE memory_ingestion_batches SET work_metadata_json = ? WHERE id = ?',
        JSON.stringify({ ...batch.workMetadata, gift }), batchId);
    })));
  if (!result.committed) throw Error('MEMORY_DATA_CHANGED');
}

async function cachePaid(paid: PaidResult) {
  checkEpoch(paid.dataEpoch);
  if (!paid.admitted) {
    const direct = (candidate: MemoryCandidateReview) => !!candidate.currentStateReview
      || !!candidate.continuationReview && (candidate.atomicKind === 'stage_conclusion' || !!candidate.continuationReview.targetMemoryId);
    const ordinary = await filterAutomaticMemoryCandidates(paid.candidates.filter(candidate => !candidate.understandingSubject && !direct(candidate)));
    const accepted = paid.candidates.filter(candidate => candidate.understandingSubject || direct(candidate)
      || ordinary.some(item => item.reviewId === candidate.reviewId));
    paid.admitted = { candidates: accepted.map(candidate => ({ ...candidate,
      ingestionRefs: [{ batchId: paid.batchId, itemKey: makeMemoryCandidateKey(candidate) }] })),
      suppressedItemKeys: paid.candidates.filter(candidate => !accepted.includes(candidate)).map(makeMemoryCandidateKey) };
  }
  const database = await getMemoryDatabase();
  const result = await runBackupRestoreDataEpochCommit(paid.dataEpoch, () => runMemoryDuplicateCleanupBusinessWrite(() =>
    database.withExclusiveTransactionAsync(async transaction => {
      const batch = await loadMemoryIngestionBatchWithDatabase(transaction, paid.batchId), gift = batch?.workMetadata?.gift;
      if (!batch || !gift || gift.dataEpoch !== paid.dataEpoch
        || !await validateGiftMemoryBindings(gift.bindings, paid.dataEpoch, { database: transaction })) throw Error('MEMORY_SOURCE_CHANGED');
      if (registered(batch)) return;
      await transaction.runAsync('UPDATE memory_ingestion_batches SET work_metadata_json = ? WHERE id = ?',
        JSON.stringify({ ...batch.workMetadata, gift: { ...gift, cachedCandidates: paid.admitted!.candidates,
          suppressedItemKeys: paid.admitted!.suppressedItemKeys } }), paid.batchId);
    })));
  if (!result.committed) throw Error('MEMORY_DATA_CHANGED');
  unsaved.delete(paid.batchId);
}

/** Local recovery is allowed while automatic requests are paused. */
async function recover(epoch: number | null) {
  for (const [id, paid] of unsaved) {
    if (!canCommitBackupRestoreDataEpoch(paid.dataEpoch)) { unsaved.delete(id); continue; }
    try { await cachePaid(paid); }
    catch (error) { if (error instanceof Error && error.message === 'MEMORY_SOURCE_CHANGED') unsaved.delete(id); else throw error; }
  }
  for (const batch of await giftBatches()) {
    const gift = batch.workMetadata?.gift;
    if (!gift?.cachedCandidates || gift.dataEpoch !== epoch) continue;
    if (registered(batch)) { await clearCached(batch.id, epoch); continue; }
    if (!await validateGiftMemoryBindings(gift.bindings, epoch)) continue;
    const outcome = await runBackupRestoreDataEpochCommit(epoch, () => registerMemoryIngestionOutcome({ batchId: batch.id,
      canCommit: () => canCommitBackupRestoreDataEpoch(epoch),
      pendingItemKeys: gift.cachedCandidates!.map(makeMemoryCandidateKey), suppressedItemKeys: gift.suppressedItemKeys,
      pendingCandidates: gift.cachedCandidates!.map(candidate => ({ itemKey: makeMemoryCandidateKey(candidate), candidateJson: JSON.stringify(candidate) })) }));
    if (!outcome.committed) throw Error('MEMORY_DATA_CHANGED');
    if (outcome.value && registered(outcome.value)) await clearCached(batch.id, epoch);
  }
}

async function requestConfig(epoch: number | null) {
  if (!canCommitBackupRestoreDataEpoch(epoch) || !isWantsClockOwner() || isChatReplyInFlight()) return null;
  if (!await isJunluoWantsAwake()) return null;
  if (!isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy({ strict: true }))
    || await loadAndroidSyncNetworkClass() === 'offline') return null;
  const config = await loadAiConfigPreferencesSnapshot({ readOnly: true, maxAgeMs: 0 });
  if (!config.profile.proactiveMemorySuggestions || !config.memoryOrganizerConnection || !config.memoryOrganizerKey.trim()
    || !canCommitBackupRestoreDataEpoch(epoch) || isChatReplyInFlight()) return null;
  return { connection: config.memoryOrganizerConnection, apiKey: config.memoryOrganizerKey };
}

function nextMessages(source: GiftMemorySource, processed: Set<string>) {
  const messages = source.messages.filter(message => {
    const binding = source.bindings.find(value => value.messageId === message.id)!;
    return !processed.has(bindingKey(binding));
  }).slice(0, 30);
  return { messages, bindings: source.bindings.filter(binding => messages.some(message => message.id === binding.messageId)) };
}

/** Called only by the existing gift/life opportunity; page and game activity stay local. */
export function runGiftMemoryTick(options: { allowRequest?: boolean } = {}): Promise<void> {
  if (running) return running;
  const operation = tick(options);
  running = operation;
  void operation.finally(() => { if (running === operation) running = undefined; }).catch(() => undefined);
  return operation;
}

async function tick(options: { allowRequest?: boolean }) {
  const epoch = captureBackupRestoreDataEpoch();
  await recover(epoch);
  if (options.allowRequest === false) return;
  const config = await requestConfig(epoch);
  if (!config) return;
  const batches = await giftBatches();
  // A paid result whose local write is still failing owns the next opportunity.
  if (unsaved.size || batches.some(batch => !registered(batch) && batch.workMetadata?.gift?.dataEpoch === epoch
    && batch.workMetadata.gift.cachedCandidates !== undefined)) return;
  const processed = new Set(batches.filter(registered).flatMap(batch => batch.workMetadata?.gift?.bindings ?? []).map(bindingKey));
  for (const sessionId of await listGiftMemorySourceSessionIds()) {
    const source = await readGiftMemorySource(sessionId);
    if (!source || source.dataEpoch !== epoch) continue;
    const { messages, bindings } = nextMessages(source, processed);
    if (!messages.length) continue;
    const sourceHash = stableMemoryHash(JSON.stringify(bindings)), id = `${sessionId}:memory:${sourceHash}:e${epoch}`;
    const commit = await runBackupRestoreDataEpochCommit(epoch, () => beginMemoryIngestionBatch({ id, stream: 'gift',
      scopeKey: sessionId, sessionId: PRIMARY_CHAT_SESSION_ID, advancesCursor: false, sourceHash,
      sourceFirstMessageId: messages[0].id, sourceLastMessageId: messages.at(-1)!.id,
      sourceFirstAt: Math.min(...messages.map(message => message.createdAt)), sourceLastAt: Math.max(...messages.map(message => message.createdAt)),
      workMetadata: { version: 1, workId: id, messageIds: messages.map(message => message.id), gift: { bindings, dataEpoch: epoch } } }));
    if (!commit.committed) return;
    try {
      await runBudgetedAiCall('memoryPostOrganize', 'background', admission => runMemoryOrganizerRequestWithDeadline(async signal => {
        if (!await requestConfig(epoch) || !await validateGiftMemoryBindings(bindings, epoch)) throw Error('MEMORY_SOURCE_CHANGED');
        const materials = await prepareConversationMaterials({ sessionId, messages, signal, background: true });
        const targets = new Set([...(materials.episodeTargetIds ?? []), ...materials.targets.map(memory => memory.id),
          ...(materials.currentStates ?? []).map(state => `current_state:${state.id}`)]);
        if ((await loadPendingMemoryCandidates({ sessionId: PRIMARY_CHAT_SESSION_ID })).some(candidate => {
          const target = memoryCandidateTargetKey(candidate); return target && targets.has(target);
        })) return;
        const assertTransportReady = async () => {
          const latest = await requestConfig(epoch);
          if (!latest || latest.apiKey !== config.apiKey || JSON.stringify(latest.connection) !== JSON.stringify(config.connection)
            || !await validateGiftMemoryBindings(bindings, epoch)) throw Error('MEMORY_SOURCE_CHANGED');
          checkEpoch(epoch);
        };
        const proposals = await organizeConversationMemories({ ...config, messages, understandingMaterials: materials,
          signal, giftSourceEnvelope: giftMemorySourceEnvelope(source, messages),
          beforeTransport: () => admission.beforeTransport(assertTransportReady, assertTransportReady) });
        checkEpoch(epoch);
        const all = makeReviewCandidates(proposals, 'proposal', { messages, sessionId,
          sourceStartAt: Math.min(...messages.map(message => message.createdAt)), sourceEndAt: Math.max(...messages.map(message => message.createdAt)) })
          .map(giftMemoryCandidateForPersistence);
        const paid: PaidResult = { batchId: id, dataEpoch: epoch, candidates: all };
        unsaved.set(id, paid);
        await cachePaid(paid);
      }), { connection: config.connection, dataEpoch: epoch, purpose: 'other' });
      await recover(epoch);
    } catch (error) {
      if (canCommitBackupRestoreDataEpoch(epoch)) await markMemoryIngestionBatchFailed(id);
      throw error;
    }
    // One real gift batch per existing opportunity; the budget owns subsequent timing.
    return;
  }
}
