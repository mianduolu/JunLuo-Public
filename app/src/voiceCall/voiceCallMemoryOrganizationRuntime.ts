import type { AiConnection } from '../ai/types';
import { canCommitBackupRestoreDataEpoch, subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { getMemoryDatabase, loadMemories } from '../memory/memoryStore';
import { beginMemoryIngestionBatch, loadMemoryIngestionBatch, registerMemoryIngestionOutcome,
  releaseMemoryIngestionBatchWaiting, loadPendingMemoryCandidates, updateMemoryIngestionBatchWaiting } from '../memory/memoryIngestionService';
import { loadMemoryIngestionBatchWithDatabase, type MemoryIngestionBatch } from '../memory/memoryIngestionLedger';
import { makeMemoryCandidateKey, stableMemoryHash } from '../memory/memoryAtomicity';
import { makeReviewCandidates, memoryCandidateTargetKey } from '../memory/memoryCandidateReview';
import { filterAutomaticMemoryCandidates, annotateManualMemoryCandidates } from '../memory/memoryAdmissionControl';
import { filterAutomaticLongMemoryCandidates, annotateManualLongMemoryCandidates } from '../memory/memoryImportanceGate';
import { prepareConversationMaterials } from '../memory/memoryConversationMaterials';
import { notifyMemoryProcessingUpdated } from '../memory/memoryProcessingSignals';
import { buildVoiceCallMaterialMessage, getVoiceCallMemorySessionId, validateVoiceCallMaterialBindings,
  type VoiceCallMaterialBinding } from './voiceCallMemorySource';
import { prepareVoiceCallMemoryBatch, type VoiceCallMemorySegment } from './voiceCallMemoryOrganization';
import { summarizeVoiceCallRecord } from './voiceCallRecordSummary';
import type { VoiceCallRecord } from './voiceCallRecord';

type SaveOptions = { dataEpoch: number | null; saveRecord: (record: VoiceCallRecord) => Promise<boolean> };
const running = new Map<string, Promise<VoiceCallRecord>>();
export function isVoiceCallMemoryOrganizationRunning(callId: string) { return running.has(callId); }

export async function loadVoiceCallMemoryBatches(callId: string) {
  const database = await getMemoryDatabase('ingestion');
  const rows = await database.getAllAsync<{ id: string }>(
    "SELECT id FROM memory_ingestion_batches WHERE stream = 'voice_call' AND source_last_message_id = ? ORDER BY created_at, id",
    `voice-call-record-${callId}`);
  const batches: MemoryIngestionBatch[] = [];
  for (const row of rows) {
    const batch = await loadMemoryIngestionBatchWithDatabase(database, row.id);
    if (batch?.workMetadata?.voiceCall?.callId === callId) batches.push(batch);
  }
  return batches;
}

export function completedVoiceCallRanges(batches: readonly MemoryIngestionBatch[]) {
  return batches.filter(batch => !batch.workMetadata?.voiceCall?.selectionWorkId && ['ready','resolved','no_value'].includes(batch.status))
    .flatMap(batch => batch.workMetadata?.voiceCall?.bindings ?? []);
}
const checkEpoch = (epoch: number | null) => { if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED'); };
async function checkBindings(bindings: readonly VoiceCallMaterialBinding[], epoch: number | null) {
  checkEpoch(epoch);
  if (!(await validateVoiceCallMaterialBindings(bindings))) throw new Error('MEMORY_SOURCE_CHANGED');
  checkEpoch(epoch);
}

async function registerSegment(record: VoiceCallRecord, segment: VoiceCallMemorySegment, mode: 'automatic'|'manual', epoch: number | null,
  canCommit: () => boolean = () => true) {
  await checkBindings(segment.bindings, epoch);
  if (!canCommit()) throw new Error('memory-organizer-cancelled');
  const existing = await loadMemoryIngestionBatch(segment.batchId);
  if (existing?.status === 'waiting') {
    const released = await releaseMemoryIngestionBatchWaiting(segment.batchId);
    if (released?.status === 'waiting') { segment.candidateStatus = 'waiting'; return; }
    if (released && ['ready', 'resolved', 'no_value'].includes(released.status)) {
      segment.candidateStatus = 'registered'; delete segment.candidates; return;
    }
    segment.candidateStatus = segment.candidates !== undefined ? 'cached' : 'failed';
  }
  if (existing && ['ready','resolved','no_value'].includes(existing.status)) {
    segment.candidateStatus = 'registered'; delete segment.candidates; return;
  }
  if (segment.candidates === undefined) return;
  const messages = segment.bindings.map(binding => {
    const turn = record.turns.find(turn => turn.role === binding.role && turn.turnId === binding.turnId);
    if (!turn) throw new Error('MEMORY_SOURCE_CHANGED');
    return buildVoiceCallMaterialMessage(record, turn, binding.start, binding.end).message;
  });
  const all = makeReviewCandidates(segment.candidates, 'voice_call', { messages,
    sessionId: getVoiceCallMemorySessionId(record.callId), sourceStartAt: messages[0]?.createdAt, sourceEndAt: messages[messages.length-1]?.createdAt });
  const direct = (candidate: typeof all[number]) => !!candidate.understandingSubject || !!candidate.currentStateReview
    || !!candidate.continuationReview && (candidate.atomicKind === 'stage_conclusion' || !!candidate.continuationReview.targetMemoryId);
  const ordinary = all.filter(candidate => !direct(candidate));
  const memories = mode === 'manual' ? await loadMemories({ includeArchived: false, currentOnly: true }) : undefined;
  const acceptedOrdinary = mode === 'automatic' ? await filterAutomaticLongMemoryCandidates(await filterAutomaticMemoryCandidates(ordinary))
    : await annotateManualLongMemoryCandidates(await annotateManualMemoryCandidates(ordinary, { existingMemories: memories! }), { existingMemories: memories! });
  const accepted = [...all.filter(direct), ...acceptedOrdinary].map(candidate => ({ ...candidate,
    ingestionRefs: [{ batchId: segment.batchId, itemKey: makeMemoryCandidateKey(candidate) }] }));
  const keys = new Set(accepted.map(makeMemoryCandidateKey));
  checkEpoch(epoch);
  const outcome = await registerMemoryIngestionOutcome({ batchId: segment.batchId,
    canCommit: () => canCommitBackupRestoreDataEpoch(epoch) && canCommit(), pendingItemKeys: [...keys],
    suppressedItemKeys: all.map(makeMemoryCandidateKey).filter(key => !keys.has(key)),
    pendingCandidates: accepted.map(candidate => ({ itemKey: makeMemoryCandidateKey(candidate), candidateJson: JSON.stringify(candidate) })) });
  if (!outcome || outcome.status === 'stale') throw new Error('MEMORY_SOURCE_CHANGED');
  segment.candidateStatus = outcome.status === 'waiting' ? 'waiting' : 'registered';
  delete segment.candidates;
  notifyMemoryProcessingUpdated();
}

async function updateStatus(record: VoiceCallRecord) {
  const state = record.memoryOrganization!;
  const batches = (await loadVoiceCallMemoryBatches(record.callId)).filter(batch =>
    !state.segments.some(segment => segment.batchId === batch.id && segment.sourceStale));
  const next = prepareVoiceCallMemoryBatch(record, completedVoiceCallRanges(batches));
  state.status = batches.some(batch => batch.status === 'waiting') ? 'waiting'
    : state.segments.some(segment => !segment.sourceStale && (segment.candidateStatus === 'failed' || segment.candidateStatus === 'cached' || !segment.summaryValid)) ? 'failed'
      : next.blocked ? 'failed' : next.bindings.length || next.remaining ? 'remaining' : 'complete';
  if (next.blocked) state.failureReason = '电话单句过长，暂未整理';
  record.summary = state.segments.find(segment => !segment.sourceStale && segment.summaryValid && segment.summary)?.summary ?? record.summary;
  record.summaryStatus = state.segments.some(segment => segment.summaryValid) ? 'ready' : 'failed';
}

export async function recoverVoiceCallMemoryResults(record: VoiceCallRecord, options: SaveOptions): Promise<VoiceCallRecord> {
  if (!record.memoryOrganization) return record;
  checkEpoch(options.dataEpoch);
  const next = JSON.parse(JSON.stringify(record)) as VoiceCallRecord;
  for (const segment of next.memoryOrganization!.segments) {
    if (!segment.sourceStale && (segment.candidateStatus === 'cached' || segment.candidateStatus === 'waiting')) {
      try { await registerSegment(next, segment, segment.mode ?? 'automatic', options.dataEpoch); }
      catch (error) { if (error instanceof Error && error.message === 'MEMORY_SOURCE_CHANGED') segment.sourceStale = true; else throw error; }
    }
  }
  await updateStatus(next);
  if (!(await options.saveRecord(next))) return next;
  notifyMemoryProcessingUpdated();
  return next;
}

export function organizeVoiceCallMemoryRecord(input: SaveOptions & {
  record: VoiceCallRecord; apiKey: string; connection: AiConnection; mode: 'automatic'|'manual';
  signal?: AbortSignal; canCommit?: () => boolean;
  selectionWorkId?: string;
}): Promise<VoiceCallRecord> {
  const current = running.get(input.record.callId);
  if (current) return current;
  const operation = runOrganization(input);
  running.set(input.record.callId, operation);
  void operation.finally(() => { if (running.get(input.record.callId) === operation) running.delete(input.record.callId); }).catch(() => undefined);
  return operation;
}

async function runOrganization(input: Parameters<typeof organizeVoiceCallMemoryRecord>[0]) {
  const record = JSON.parse(JSON.stringify(input.record)) as VoiceCallRecord;
  record.memoryOrganization ??= { version: 1, status: 'unstarted', segments: [] };
  const state = record.memoryOrganization;
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  const unsubscribe = subscribeBackupRestoreRuntimeState(() => { if (!canCommitBackupRestoreDataEpoch(input.dataEpoch)) abort(); });
  const check = () => {
    checkEpoch(input.dataEpoch);
    if (controller.signal.aborted || input.signal?.aborted || input.canCommit && !input.canCommit()) throw new Error('memory-organizer-cancelled');
  };
  const saveRecord = async () => {
    check();
    const saved = await input.saveRecord(record);
    if (!saved) { state.status = 'failed'; state.failureReason = 'voice_record_write_failed'; }
    return saved;
  };
  try {
    check();
    for (const segment of state.segments) {
      if (!segment.sourceStale && !(await validateVoiceCallMaterialBindings(segment.bindings))) segment.sourceStale = true;
    }
    const relevant = () => state.segments.filter(segment => !segment.sourceStale && segment.selectionWorkId === input.selectionWorkId);
    const recoveredResult = relevant().some(segment => segment.candidateStatus === 'cached'
      || segment.candidateStatus === 'waiting' && segment.candidates !== undefined);
    for (const segment of relevant()) if (segment.candidateStatus === 'cached' || segment.candidateStatus === 'waiting') {
      await registerSegment(record, segment, segment.mode ?? input.mode, input.dataEpoch, () => !controller.signal.aborted && (input.canCommit?.() ?? true));
    }
    check();
    if (recoveredResult && !relevant().some(segment => !segment.summaryValid || segment.candidateStatus === 'failed')) {
      await updateStatus(record); await saveRecord(); return record;
    }
    const batches = (await loadVoiceCallMemoryBatches(record.callId)).filter(batch =>
      !state.segments.some(segment => segment.batchId === batch.id && segment.sourceStale));
    if (batches.some(batch => batch.status === 'waiting')) {
      await updateStatus(record); await saveRecord(); return record;
    }
    const failed = relevant().find(segment => !segment.summaryValid || segment.candidateStatus === 'failed');
    let processed = input.selectionWorkId ? [] : completedVoiceCallRanges(batches);
    if (failed) {
      // Retry only this range. Already registered candidates are never regenerated into another draft.
      await checkBindings(failed.bindings, input.dataEpoch);
      processed = processed.filter(binding => !failed.bindings.some(old => old.messageId === binding.messageId && old.start === binding.start && old.end === binding.end));
    }
    let batch = prepareVoiceCallMemoryBatch(record, processed);
    if (failed) {
      const wanted = new Set(failed.bindings.map(binding => `${binding.messageId}:${binding.start}:${binding.end}`));
      if (batch.bindings.length !== wanted.size || batch.bindings.some(binding => !wanted.has(`${binding.messageId}:${binding.start}:${binding.end}`))) {
        // A shorter last batch must not consume the later range when retrying a partial result.
        const limited = { ...record, turns: failed.bindings.map(binding => record.turns.find(turn => turn.turnId === binding.turnId && turn.role === binding.role)!) };
        batch = prepareVoiceCallMemoryBatch(limited, processed);
        if (batch.bindings.some(binding => !wanted.has(`${binding.messageId}:${binding.start}:${binding.end}`))) throw new Error('MEMORY_SOURCE_CHANGED');
      }
    }
    if (!batch.bindings.length) {
      await updateStatus(record); await saveRecord(); return record;
    }
    const segment = failed ?? { batchId: input.selectionWorkId ? `${batch.batchId}-${stableMemoryHash(input.selectionWorkId)}` : batch.batchId,
      bindings: batch.bindings, mode: input.mode, selectionWorkId: input.selectionWorkId, summaryValid: false, candidateStatus: 'failed' as const };
    if (!failed) state.segments.push(segment);
    batch = { ...batch, batchId: segment.batchId };
    await beginMemoryIngestionBatch({ id: segment.batchId, advancesCursor: false, stream: 'voice_call',
      scopeKey: `voice-call:${record.callId}`, sessionId: PRIMARY_CHAT_SESSION_ID,
      sourceFirstAt: record.startedAt, sourceLastAt: record.endedAt,
      sourceFirstMessageId: `voice-call-record-${record.callId}`, sourceLastMessageId: `voice-call-record-${record.callId}`,
      sourceHash: stableMemoryHash(JSON.stringify(segment.bindings)),
      workMetadata: { version: 1, workId: record.callId, messageIds: segment.bindings.map(binding => binding.messageId),
        voiceCall: { callId: record.callId, bindings: segment.bindings, selectionWorkId: input.selectionWorkId } } });
    state.status = 'running'; delete state.failureReason;
    if (!(await saveRecord())) return record;
    const materials = await prepareConversationMaterials({ sessionId: getVoiceCallMemorySessionId(record.callId),
      messages: batch.messages, voiceBindings: batch.bindings, signal: controller.signal, background: input.mode === 'automatic' });
    check();
    const targets = new Set([...materials.targets.map(memory => memory.id), ...(materials.episodeTargetIds ?? []),
      ...(materials.currentStates ?? []).map(state => `current_state:${state.id}`)]);
    const pending = await loadPendingMemoryCandidates({ sessionId: PRIMARY_CHAT_SESSION_ID });
    const blockers = [...new Set(pending.map(memoryCandidateTargetKey).filter((target): target is string => !!target && targets.has(target)))];
    if (blockers.length && segment.candidateStatus !== 'registered') {
      await updateMemoryIngestionBatchWaiting(segment.batchId, { reason: 'pending_target', targetMemoryIds: blockers });
      segment.candidateStatus = 'waiting'; state.status = 'waiting'; await saveRecord(); return record;
    }
    await checkBindings(batch.bindings, input.dataEpoch);
    const result = await summarizeVoiceCallRecord({ apiKey: input.apiKey, connection: input.connection, record,
      materials, batch, mode: input.mode, signal: controller.signal,
      canCommit: () => !controller.signal.aborted && canCommitBackupRestoreDataEpoch(input.dataEpoch) && (input.canCommit?.() ?? true) });
    check();
    await checkBindings(batch.bindings, input.dataEpoch);
    if (!segment.summaryValid && result.summaryValid) {
      segment.summary = result.summary; segment.summaryValid = true;
      record.summary = state.segments.find(part => part.summaryValid && part.summary)?.summary ?? '';
      record.summaryStatus = 'ready';
    } else if (!segment.summaryValid) record.summaryStatus = 'failed';
    if (segment.candidateStatus !== 'registered' && result.candidates !== undefined) {
      segment.candidates = result.candidates; segment.candidateStatus = 'cached';
    } else if (segment.candidateStatus !== 'registered') segment.failureReason = result.candidateFailure;
    // Cache the independently parsed result before attempting memory-database writes.
    if (!(await saveRecord())) return record;
    if (segment.candidateStatus === 'cached') await registerSegment(record, segment, segment.mode ?? input.mode, input.dataEpoch,
      () => !controller.signal.aborted && (input.canCommit?.() ?? true));
    record.summaryCompletedAt = Date.now();
    await updateStatus(record);
    await saveRecord();
  } catch (error) {
    state.status = 'failed'; state.failureReason = error instanceof Error ? error.message : 'voice-memory-failed';
    if (record.summaryStatus === 'pending') record.summaryStatus = 'failed';
    if (canCommitBackupRestoreDataEpoch(input.dataEpoch)) await saveRecord().catch(() => false);
  } finally { input.signal?.removeEventListener('abort', abort); unsubscribe(); controller.abort(); notifyMemoryProcessingUpdated(); }
  return record;
}
