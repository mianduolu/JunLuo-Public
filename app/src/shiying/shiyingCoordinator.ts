import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { isChatReplyInFlight, runScheduledAiCall } from '../ai/aiRuntimeScheduler';
import type { AiConnection, AiProfile } from '../ai/types';
import { ensureBackupRestoreRecovery, runBackupProtectedTask } from '../backup/backupService';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import {
  SHIYING_EXTRACTION_CONTRACT_VERSION,
  canonicalJsonV1,
  createShiyingBatchId,
  createShiyingChunkId,
  createShiyingCoverageId,
  createShiyingEntryId,
  createShiyingInputHash,
  createShiyingOperationId,
  type ShiyingCoverageReceiptV1,
  type ShiyingCoverageSourceV1,
  type ShiyingEntryV1,
} from './shiyingContract';
import {
  loadShiyingMaterialWindow,
  type ShiyingChatMaterialV1,
  type ShiyingMaterialWindowV1,
} from './shiyingChatSource';
import {
  ShiyingExtractionRequestError,
  estimateShiyingExtractionPromptTokens,
  finalizeShiyingBatchCandidates,
  projectShiyingModelChunkResult,
  requestShiyingExtraction,
  type ShiyingBatchCandidateV1,
  type ShiyingValidatedCandidateV1,
} from './shiyingExtraction';
import {
  SHIYING_CHUNK_MESSAGE_LIMIT,
  planShiyingMaterialSegments,
} from './shiyingSegmentation';
import type {
  ShiyingManualRunV1,
  ShiyingRunCandidateV1,
  ShiyingRunChunkV1,
} from './shiyingRunState';
import {
  abandonShiyingManualRun,
  commitShiyingManualRunResult,
  createShiyingManualRun,
  getShiyingManualRun,
  listShiyingEntries,
  replaceShiyingManualRun,
  saveShiyingManualRunChunkResult,
  isShiyingManualRunResultCommitted,
  startShiyingAutomaticRunChunk,
  cancelShiyingAutomaticRunChunkBeforeRequest,
} from './shiyingStore';
import { resolveShiyingAutomaticLocalBlock } from './shiyingAutomaticStore';
import { getShiyingLifeDate } from './shiyingWindow';
import { isShiyingBackfillExecuting } from './shiyingBackfillState';
import { SHIYING_RESTORE_PAUSED } from './shiyingBackupPolicy';
import { registerShiyingBackupParticipant } from './shiyingBackupRuntime';

export const SHIYING_MANUAL_MESSAGE_LIMIT = SHIYING_CHUNK_MESSAGE_LIMIT;
export const SHIYING_MANUAL_PROMPT_TOKEN_LIMIT = 30_000;
export const SHIYING_MANUAL_CALL_LIMIT = 2;
const SHIYING_CONTEXT_OUTPUT_RESERVE = 2_048;

export type ShiyingManualRunStatus =
  | {
      kind: 'progress';
      batchId: string;
      completedChunks: number;
      totalChunks: number;
      remainingChunks: number;
    }
  | {
      kind: 'blocked';
      batchId: string;
      completedChunks: number;
      totalChunks: number;
      code: string;
    };

export type ShiyingManualPickupResult =
  | {
      kind: 'entries';
      batchId: string;
      operationIds: string[];
      entries: ShiyingEntryV1[];
    }
  | { kind: 'zero'; batchId: string; operationIds: string[] }
  | (Extract<ShiyingManualRunStatus, { kind: 'progress' }> & { callsThisAttempt: number })
  | (Extract<ShiyingManualRunStatus, { kind: 'blocked' }> & { callsThisAttempt: number })
  | { kind: 'no_material' }
  | { kind: 'chat_busy' }
  | { kind: 'model_config_missing' }
  | { kind: 'restore_busy' }
  | ShiyingPickupRecoveryState
  | { kind: 'recovery_stale' }
  | { kind: 'failed'; code: string };

export type ShiyingPickupRetryConfirmation = {
  batchId: string; chunkIndex: number; chunkId: string; inputHash: string;
  attemptCount: number; startedAt: number | null; epoch: number;
};
export type ShiyingPickupRecoveryState =
  | { kind: 'recovery_stale' }
  | { kind: 'save_pending'; stage: 'chunk' | 'batch'; batchId: string; chunkIndex: number | null;
      completedChunks: number; totalChunks: number; code: string }
  | { kind: 'retry_confirmation_required'; batchId: string; completedChunks: number;
      totalChunks: number; code: string; confirmation: ShiyingPickupRetryConfirmation };
export type ShiyingManualPickupOptions = { retryConfirmation?: ShiyingPickupRetryConfirmation };
export type ShiyingPickupLocalSaveTarget = { batchId: string; epoch: number };

type ShiyingResolvedModelConfig = {
  apiKey: string;
  connection: AiConnection;
  profile: AiProfile;
};

type BackupProtectedResult<T> =
  | { ran: false; reason: string }
  | { ran: true; value: T };

type ShiyingRunCommitInput = Parameters<typeof commitShiyingManualRunResult>[0];

export type ShiyingCoordinatorDependencies = {
  commitRun?: (input: ShiyingRunCommitInput) => ReturnType<typeof commitShiyingManualRunResult>;
  createRun?: typeof createShiyingManualRun;
  getRun?: typeof getShiyingManualRun;
  isChatBusy?: typeof isChatReplyInFlight;
  listEntries?: typeof listShiyingEntries;
  loadConfig?: typeof loadAiConfigPreferencesSnapshot;
  loadWindow?: typeof loadShiyingMaterialWindow;
  now?: () => number;
  onPhase?: (
    phase: 'checking' | 'calling',
    progress?: { chunkIndex: number; totalChunks: number; callsThisAttempt: number },
  ) => void;
  replaceRun?: typeof replaceShiyingManualRun;
  requestExtraction?: typeof requestShiyingExtraction;
  runBackupProtected?: <T>(task: () => Promise<T>) => Promise<BackupProtectedResult<T>>;
  startAutomaticChunk?: typeof startShiyingAutomaticRunChunk;
  cancelAutomaticChunk?: typeof cancelShiyingAutomaticRunChunkBeforeRequest;
  resolveAutomaticBlock?: typeof resolveShiyingAutomaticLocalBlock;
  scheduleAutomatic?: typeof runScheduledAiCall;
  saveChunk?: typeof saveShiyingManualRunChunkResult;
  captureEpoch?: typeof captureBackupRestoreDataEpoch;
  canCommitEpoch?: typeof canCommitBackupRestoreDataEpoch;
  commitEpoch?: typeof runBackupRestoreDataEpochCommit;
  isResultCommitted?: typeof isShiyingManualRunResultCommitted;
  reservedLifeDates?: () => Promise<string[]>;
};

let manualPickupFlight: Promise<ShiyingManualPickupResult> | null = null;
export function isShiyingPickupExecuting() { return manualPickupFlight !== null; }
let pickupFlightKind: 'manual' | 'automatic' | 'local' | null = null;
const pickupListeners = new Set<() => void>();
type LocalSaveCache = {
  epoch: number;
  state: Extract<ShiyingPickupRecoveryState, { kind: 'save_pending' }>;
} & (
  | { stage: 'chunk'; input: Parameters<typeof saveShiyingManualRunChunkResult>[0] }
  | { stage: 'batch'; input: ShiyingRunCommitInput; operationIds: string[] }
);
let localSaveCache: LocalSaveCache | null = null;
registerShiyingBackupParticipant({
  hasPendingSave: () => localSaveCache !== null,
  invalidate: () => { localSaveCache = null; notifyPickupChanges(); },
});

function currentLocalSaveCache(dependencies: ShiyingCoordinatorDependencies) {
  if (localSaveCache && !(dependencies.canCommitEpoch ?? canCommitBackupRestoreDataEpoch)(localSaveCache.epoch)) {
    localSaveCache = null;
    notifyPickupChanges();
  }
  return localSaveCache;
}
function pendingSaveState(run: ShiyingManualRunV1, stage: 'chunk' | 'batch', chunkIndex: number | null,
  code = 'local_save_pending'): Extract<ShiyingPickupRecoveryState, { kind: 'save_pending' }> {
  return { kind: 'save_pending', stage, batchId: run.batchId, chunkIndex,
    completedChunks: run.chunks.filter(chunk => chunk.status === 'completed').length,
    totalChunks: run.chunks.length, code };
}
function retryConfirmationState(run: ShiyingManualRunV1, epoch: number): ShiyingPickupRecoveryState | null {
  const chunk = run.chunks.find(item => item.status !== 'completed');
  if (!chunk || chunk.attemptCount === 0 || (run.status !== 'blocked'
    && chunk.status !== 'in_flight' && chunk.lastErrorCode === null)) return null;
  return { kind: 'retry_confirmation_required', batchId: run.batchId,
    completedChunks: run.chunks.filter(item => item.status === 'completed').length, totalChunks: run.chunks.length,
    code: chunk.status === 'in_flight' ? 'interrupted_request' : chunk.lastErrorCode ?? run.lastErrorCode ?? 'unknown',
    confirmation: { batchId: run.batchId, chunkIndex: chunk.chunkIndex, chunkId: chunk.chunkId,
      inputHash: chunk.inputHash, attemptCount: chunk.attemptCount, startedAt: chunk.startedAt, epoch } };
}
function runExecutionIdentity(run: ShiyingManualRunV1) {
  return canonicalJsonV1({ batchId: run.batchId, status: run.status,
    chunks: run.chunks.map(({ chunkId, inputHash, status, attemptCount, startedAt, completedAt }) => (
      { chunkId, inputHash, status, attemptCount, startedAt, completedAt }
    )) });
}
export async function getShiyingPickupRecoveryState(
  dependencies: ShiyingCoordinatorDependencies = {},
): Promise<ShiyingPickupRecoveryState | null> {
  const hadCache = localSaveCache !== null;
  const cached = currentLocalSaveCache(dependencies);
  if (hadCache && !cached) return { kind: 'recovery_stale' };
  const epoch = (dependencies.captureEpoch ?? captureBackupRestoreDataEpoch)();
  if (epoch === null) return null;
  const run = await (dependencies.getRun ?? getShiyingManualRun)();
  if (cached) {
    let valid = false;
    if (run?.batchId === cached.state.batchId) {
      if (cached.stage === 'chunk') {
        const chunk = run.chunks[cached.input.chunkIndex];
        valid = !!chunk && chunk.chunkId === cached.input.chunkId && chunk.inputHash === cached.input.inputHash
          && chunk.attemptCount === cached.input.attemptCount && chunk.startedAt === cached.input.startedAt
          && (chunk.status === 'in_flight' || chunk.status === 'completed'
            && chunk.completedAt === cached.input.completedAt
            && canonicalJsonV1(chunk.candidates) === canonicalJsonV1(cached.input.candidates));
      } else valid = run.chunks.length === cached.input.coverages.length && run.chunks.every((chunk, index) => {
        const coverage = cached.input.coverages[index];
        return chunk.status === 'completed' && chunk.chunkId === coverage.chunkId
          && chunk.inputHash === coverage.inputHash && chunk.completedAt === coverage.completedAt;
      });
    } else if (cached.stage === 'batch') {
      valid = await (dependencies.isResultCommitted ?? isShiyingManualRunResultCommitted)(cached.input);
    }
    if (!(dependencies.canCommitEpoch ?? canCommitBackupRestoreDataEpoch)(cached.epoch)) valid = false;
    if (valid) return { ...cached.state };
    if (localSaveCache === cached) { localSaveCache = null; notifyPickupChanges(); }
    return { kind: 'recovery_stale' };
  }
  if (!run || !(dependencies.canCommitEpoch ?? canCommitBackupRestoreDataEpoch)(epoch)) return null;
  if (run.chunks.length && run.chunks.every(chunk => chunk.status === 'completed')) return pendingSaveState(run, 'batch', null);
  return retryConfirmationState(run, epoch);
}

export function subscribeShiyingPickupChanges(listener: () => void): () => void {
  pickupListeners.add(listener);
  return () => { pickupListeners.delete(listener); };
}
function notifyPickupChanges() {
  for (const listener of pickupListeners) {
    try { listener(); } catch { /* Committed work is independent of its page. */ }
  }
}

export type ShiyingAutomaticPickupOptions = {
  nightLifeDate: string;
  scanFloorAt: number;
  batchId: string | null;
  canRequest: (connection: AiConnection) => boolean | Promise<boolean>;
};

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceIdentity(source: { sessionId: string; messageId: string }) {
  return JSON.stringify([source.sessionId, source.messageId]);
}

export function resolveShiyingPickupModelConfig(
  snapshot: Awaited<ReturnType<typeof loadAiConfigPreferencesSnapshot>>,
): ShiyingResolvedModelConfig | null {
  const connection = snapshot.memoryOrganizerConnection ?? snapshot.chatConnection;
  const apiKey = snapshot.memoryOrganizerConnection
    ? snapshot.memoryOrganizerKey
    : snapshot.chatKey;
  if (
    !connection
    || !apiKey.trim()
    || !connection.baseUrl.trim()
    || !connection.model.trim()
  ) {
    return null;
  }
  return { apiKey, connection, profile: snapshot.profile };
}

function buildCoverageSources(messages: readonly ShiyingChatMaterialV1[]) {
  return messages.map((message, ordinal): ShiyingCoverageSourceV1 => ({
    ordinal,
    sessionId: message.sessionId,
    messageId: message.messageId,
    role: message.role,
    messageCreatedAt: message.messageCreatedAt,
    contentHash: message.contentHash,
  }));
}

function buildEntry(input: {
  batchId: string;
  candidate: ShiyingValidatedCandidateV1;
  completedAt: number;
}): ShiyingEntryV1 {
  const eventTimes = input.candidate.sourceMaterials.map((source) => source.messageCreatedAt);
  const youTimes = input.candidate.sourceMaterials
    .filter((source) => source.role === 'you')
    .map((source) => source.messageCreatedAt);
  return {
    payloadVersion: 1,
    id: createShiyingEntryId(),
    batchId: input.batchId,
    lifeDate: getShiyingLifeDate(Math.max(...youTimes)),
    category: input.candidate.category,
    body: input.candidate.body,
    eventStartedAt: Math.min(...eventTimes),
    eventEndedAt: Math.max(...eventTimes),
    status: 'active',
    editedAt: null,
    rejectedAt: null,
    presentedAt: null,
    createdAt: input.completedAt,
    updatedAt: input.completedAt,
    sources: input.candidate.sourceMaterials.map((source, ordinal) => ({
      ordinal,
      sessionId: source.sessionId,
      messageId: source.messageId,
      role: source.role,
      evidenceKind: source.role === 'you' ? 'primary_you' : 'context_I',
      messageCreatedAt: source.messageCreatedAt,
      excerptSnapshot: source.text,
      evidenceQuote: source.role === 'you' ? source.text : null,
      contentHash: source.contentHash,
    })),
  };
}

function technicalCode(error: unknown) {
  if (error instanceof ShiyingExtractionRequestError) return error.code;
  const raw = error instanceof Error ? error.message.split(':', 1)[0] : '';
  // Arbitrary storage/network messages can contain private content. Only domain codes are visible.
  return /^shiying_[a-z]+_[a-z0-9_]{1,100}$/u.test(raw)
    ? raw.replace(/^shiying_[a-z]+_/u, '') : 'unknown';
}

function runStatus(run: ShiyingManualRunV1, requestActive = false): ShiyingManualRunStatus {
  const completedChunks = run.chunks.filter((chunk) => chunk.status === 'completed').length;
  const interrupted = !requestActive && run.chunks.some((chunk) => chunk.status === 'in_flight');
  if (run.status === 'blocked' || interrupted) {
    return {
      kind: 'blocked',
      batchId: run.batchId,
      completedChunks,
      totalChunks: run.chunks.length,
      code: interrupted ? 'interrupted_request' : run.lastErrorCode ?? 'unknown',
    };
  }
  return {
    kind: 'progress',
    batchId: run.batchId,
    completedChunks,
    totalChunks: run.chunks.length,
    remainingChunks: run.chunks.length - completedChunks,
  };
}

function blockedPickupResult(
  run: ShiyingManualRunV1,
  callsThisAttempt: number,
): ShiyingManualPickupResult {
  const status = runStatus(run);
  if (status.kind !== 'blocked') throw new Error('shiying_manual_blocked_status_missing');
  return { ...status, callsThisAttempt };
}

function progressPickupResult(
  run: ShiyingManualRunV1,
  callsThisAttempt: number,
): ShiyingManualPickupResult {
  const status = runStatus(run);
  if (status.kind !== 'progress') throw new Error('shiying_manual_progress_status_missing');
  return { ...status, callsThisAttempt };
}

export async function getManualShiyingRunStatus(): Promise<ShiyingManualRunStatus | null> {
  const run = await getShiyingManualRun();
  return run ? runStatus(run, manualPickupFlight !== null) : null;
}

function createRunChunk(input: {
  batchId: string;
  chunkIndex: number;
  estimatedTokens: number;
  messages: ShiyingChatMaterialV1[];
  overlapFromPrevious: number;
}): ShiyingRunChunkV1 {
  const sources = buildCoverageSources(input.messages);
  const chunkId = createShiyingChunkId({
    batchId: input.batchId,
    chunkIndex: input.chunkIndex,
    sources,
  });
  return {
    chunkIndex: input.chunkIndex,
    chunkId,
    operationId: createShiyingOperationId({
      lane: 'live',
      chunkId,
      contractVersion: SHIYING_EXTRACTION_CONTRACT_VERSION,
    }),
    inputHash: createShiyingInputHash(sources),
    overlapFromPrevious: input.overlapFromPrevious,
    estimatedTokens: input.estimatedTokens,
    status: 'pending',
    attemptCount: 0,
    lastErrorCode: null,
    startedAt: null,
    completedAt: null,
    materials: input.messages,
    candidates: null,
  };
}

function createRunFromWindow(input: {
  config: ShiyingResolvedModelConfig;
  now: number;
  window: ShiyingMaterialWindowV1;
}): ShiyingManualRunV1 {
  if (!input.window.windowEndCursor) throw new Error('shiying_manual_window_end_missing');
  const batchId = createShiyingBatchId({
    lane: 'live',
    lifeDateStart: input.window.lifeDateStart,
    lifeDateEnd: input.window.lifeDateEnd,
    windowStartCursor: input.window.windowStartCursor,
    windowEndCursor: input.window.windowEndCursor,
  });
  const connectionInputLimit = Math.max(
    1,
    (input.config.connection.contextWindowTokens ?? 65_536) - SHIYING_CONTEXT_OUTPUT_RESERVE,
  );
  const plan = planShiyingMaterialSegments({
    messages: input.window.messages,
    tokenLimit: Math.min(SHIYING_MANUAL_PROMPT_TOKEN_LIMIT, connectionInputLimit),
    estimateTokens: (messages) => estimateShiyingExtractionPromptTokens({
      profile: input.config.profile,
      messages,
    }),
  });
  if (plan.kind === 'blocked') {
    return {
      batchId,
      lane: 'live',
      lifeDateStart: input.window.lifeDateStart,
      lifeDateEnd: input.window.lifeDateEnd,
      windowStartCursor: input.window.windowStartCursor,
      windowEndCursor: input.window.windowEndCursor,
      status: 'blocked',
      lastErrorCode: 'input_too_large',
      createdAt: input.now,
      updatedAt: input.now,
      chunks: [],
    };
  }
  if (!plan.chunks.length) throw new Error('shiying_manual_segment_empty');
  return {
    batchId,
    lane: 'live',
    lifeDateStart: input.window.lifeDateStart,
    lifeDateEnd: input.window.lifeDateEnd,
    windowStartCursor: input.window.windowStartCursor,
    windowEndCursor: input.window.windowEndCursor,
    status: 'pending',
    lastErrorCode: null,
    createdAt: input.now,
    updatedAt: input.now,
    chunks: plan.chunks.map((chunk) => createRunChunk({
      batchId,
      chunkIndex: chunk.chunkIndex,
      estimatedTokens: chunk.estimatedTokens,
      messages: chunk.messages,
      overlapFromPrevious: chunk.overlapFromPrevious,
    })),
  };
}

function resumeRun(run: ShiyingManualRunV1, updatedAt: number): ShiyingManualRunV1 {
  return {
    ...run,
    status: 'pending',
    lastErrorCode: null,
    updatedAt: Math.max(run.updatedAt, updatedAt),
    chunks: run.chunks.map((chunk) => chunk.status === 'completed' ? chunk : {
      ...chunk,
      status: 'pending',
      lastErrorCode: null,
      completedAt: null,
      candidates: null,
    }),
  };
}

function markRunBlocked(
  run: ShiyingManualRunV1,
  chunkIndex: number,
  code: string,
  updatedAt: number,
): ShiyingManualRunV1 {
  return {
    ...run,
    status: 'blocked',
    lastErrorCode: code,
    updatedAt: Math.max(run.updatedAt, updatedAt),
    chunks: run.chunks.map((chunk) => chunk.chunkIndex === chunkIndex ? {
      ...chunk,
      status: 'pending',
      lastErrorCode: code,
      completedAt: null,
      candidates: null,
    } : chunk),
  };
}

function storeCandidates(candidates: readonly ShiyingValidatedCandidateV1[]) {
  return candidates.map((candidate): ShiyingRunCandidateV1 => ({
    category: candidate.category,
    body: candidate.body,
    sourceRefs: candidate.sourceMaterials.map((source) => ({
      sessionId: source.sessionId,
      messageId: source.messageId,
    })),
  }));
}

function allRunMaterials(run: ShiyingManualRunV1) {
  const byIdentity = new Map<string, ShiyingChatMaterialV1>();
  run.chunks.forEach((chunk) => chunk.materials.forEach((material) => {
    byIdentity.set(sourceIdentity(material), material);
  }));
  return [...byIdentity.values()].sort((left, right) => (
    left.messageCreatedAt - right.messageCreatedAt
    || compareStrings(left.sessionId, right.sessionId)
    || compareStrings(left.messageId, right.messageId)
  ));
}

function hydrateRunCandidates(run: ShiyingManualRunV1) {
  const candidates: ShiyingBatchCandidateV1[] = [];
  for (const chunk of run.chunks) {
    if (chunk.status !== 'completed' || chunk.candidates === null) {
      throw new Error('shiying_manual_run_not_completed');
    }
    const projected = projectShiyingModelChunkResult({
      rawText: JSON.stringify({ entries: chunk.candidates }),
      materials: chunk.materials,
    });
    if (projected.kind === 'invalid') throw new Error('shiying_manual_staged_candidates_invalid');
    if (projected.kind === 'entries') {
      projected.candidates.forEach((candidate, modelOrder) => candidates.push({
        ...candidate,
        chunkIndex: chunk.chunkIndex,
        modelOrder,
      }));
    }
  }
  return candidates;
}

function buildCoverage(
  run: ShiyingManualRunV1,
  chunk: ShiyingRunChunkV1,
  entries: readonly ShiyingEntryV1[],
): ShiyingCoverageReceiptV1 {
  if (chunk.completedAt === null) throw new Error('shiying_manual_chunk_completion_missing');
  const sources = buildCoverageSources(chunk.materials);
  const sourceIds = new Set(sources.map(sourceIdentity));
  const hasSelectedSource = entries.some((entry) => entry.sources.some(
    (source) => sourceIds.has(sourceIdentity(source)),
  ));
  return {
    payloadVersion: 1,
    id: createShiyingCoverageId({
      lane: 'live',
      chunkId: chunk.chunkId,
      inputHash: chunk.inputHash,
      contractVersion: SHIYING_EXTRACTION_CONTRACT_VERSION,
    }),
    lane: 'live',
    batchId: run.batchId,
    chunkId: chunk.chunkId,
    chunkIndex: chunk.chunkIndex,
    lifeDateStart: run.lifeDateStart,
    lifeDateEnd: run.lifeDateEnd,
    windowStartCursor: run.windowStartCursor,
    windowEndCursor: run.windowEndCursor,
    inputHash: chunk.inputHash,
    contractVersion: SHIYING_EXTRACTION_CONTRACT_VERSION,
    outcome: hasSelectedSource ? 'entries' : 'zero',
    executorDeviceId: null,
    completedAt: chunk.completedAt,
    updatedAt: chunk.completedAt,
    sources,
  };
}

async function finalizeRun(
  run: ShiyingManualRunV1,
  dependencies: ShiyingCoordinatorDependencies,
  completedAt: number,
  epoch: number,
): Promise<ShiyingManualPickupResult> {
  const listEntries = dependencies.listEntries ?? listShiyingEntries;
  const existingEntries = await listEntries({ status: 'all' });
  const materials = allRunMaterials(run);
  const selected = finalizeShiyingBatchCandidates({
    candidates: hydrateRunCandidates(run),
    existingEntries,
    materials,
  });
  const entries = selected.map((candidate) => buildEntry({
    batchId: run.batchId,
    candidate,
    completedAt,
  }));
  const coverages = run.chunks.map((chunk) => buildCoverage(run, chunk, entries));
  const operationIds = run.chunks.map((chunk) => chunk.operationId);
  if (!(dependencies.canCommitEpoch ?? canCommitBackupRestoreDataEpoch)(epoch)) return { kind: 'recovery_stale' };
  const cache: LocalSaveCache = { stage: 'batch', epoch, operationIds,
    input: { batchId: run.batchId, coverages, entries }, state: pendingSaveState(run, 'batch', null) };
  localSaveCache = cache;
  return saveCachedBatch(cache, dependencies);
}

function localSaveFailure(cache: LocalSaveCache, error: unknown, dependencies: ShiyingCoordinatorDependencies): ShiyingManualPickupResult {
  if (!(dependencies.canCommitEpoch ?? canCommitBackupRestoreDataEpoch)(cache.epoch)) {
    if (localSaveCache === cache) localSaveCache = null;
    return { kind: 'recovery_stale' };
  }
  const code = technicalCode(error);
  if (code === 'run_missing' || code.includes('conflict') || code.startsWith('run_coverage_') || code === 'run_not_completed') {
    if (localSaveCache === cache) localSaveCache = null;
    notifyPickupChanges();
    return code === 'run_missing' ? { kind: 'recovery_stale' } : { kind: 'failed', code };
  }
  cache.state = { ...cache.state, code };
  notifyPickupChanges();
  return { ...cache.state };
}

async function saveCachedBatch(cache: Extract<LocalSaveCache, { stage: 'batch' }>,
  dependencies: ShiyingCoordinatorDependencies): Promise<ShiyingManualPickupResult> {
  let committed: Awaited<ReturnType<typeof commitShiyingManualRunResult>>;
  try {
    const result = await (dependencies.commitEpoch ?? runBackupRestoreDataEpochCommit)(cache.epoch,
      () => (dependencies.commitRun ?? commitShiyingManualRunResult)(cache.input));
    if (!result.committed) {
      if (localSaveCache === cache) localSaveCache = null;
      return { kind: 'recovery_stale' };
    }
    committed = result.value;
    if (localSaveCache === cache) localSaveCache = null;
    notifyPickupChanges();
  } catch (error) { return localSaveFailure(cache, error, dependencies); }
  return committed.entries.length ? {
    kind: 'entries',
    batchId: cache.input.batchId,
    operationIds: cache.operationIds,
    entries: committed.entries,
  } : {
    kind: 'zero',
    batchId: cache.input.batchId,
    operationIds: cache.operationIds,
  };
}

async function writeCachedChunk(cache: Extract<LocalSaveCache, { stage: 'chunk' }>,
  dependencies: ShiyingCoordinatorDependencies): Promise<ShiyingManualRunV1 | null> {
  const result = await (dependencies.commitEpoch ?? runBackupRestoreDataEpochCommit)(cache.epoch,
    () => (dependencies.saveChunk ?? saveShiyingManualRunChunkResult)(cache.input));
  if (!result.committed) { if (localSaveCache === cache) localSaveCache = null; return null; }
  if (localSaveCache === cache) localSaveCache = null;
  notifyPickupChanges();
  return result.value;
}

async function commitPickupEpoch<T>(epoch: number, dependencies: ShiyingCoordinatorDependencies,
  work: () => Promise<T>): Promise<T> {
  const result = await (dependencies.commitEpoch ?? runBackupRestoreDataEpochCommit)(epoch, work);
  if (!result.committed) throw new Error('shiying_manual_recovery_epoch_changed');
  return result.value;
}

async function executeManualPickup(
  dependencies: ShiyingCoordinatorDependencies,
  automatic?: ShiyingAutomaticPickupOptions,
  options?: ShiyingManualPickupOptions,
  epoch = (dependencies.captureEpoch ?? captureBackupRestoreDataEpoch)(),
): Promise<ShiyingManualPickupResult> {
  dependencies.onPhase?.('checking');
  if (isShiyingBackfillExecuting()) return { kind: 'chat_busy' };
  const isChatBusy = dependencies.isChatBusy ?? isChatReplyInFlight;
  if (epoch === null) return { kind: 'restore_busy' };
  const cached = currentLocalSaveCache(dependencies);
  if (cached) return { ...cached.state };

  const getRun = dependencies.getRun ?? getShiyingManualRun;
  const createRun = dependencies.createRun ?? createShiyingManualRun;
  const replaceRun = dependencies.replaceRun ?? replaceShiyingManualRun;
  const now = dependencies.now ?? Date.now;
  let run = await getRun();
  if (!(dependencies.canCommitEpoch ?? canCommitBackupRestoreDataEpoch)(epoch)) return { kind: 'restore_busy' };
  if (options?.retryConfirmation) {
    const token = options.retryConfirmation;
    const chunk = run?.chunks[token.chunkIndex];
    if (!run || run.batchId !== token.batchId || token.epoch !== epoch || !chunk
      || chunk.status === 'completed' || chunk.chunkId !== token.chunkId || chunk.inputHash !== token.inputHash
      || chunk.attemptCount !== token.attemptCount || chunk.startedAt !== token.startedAt) return { kind: 'recovery_stale' };
  }
  if (automatic && run && run.batchId !== automatic.batchId) return { kind: 'chat_busy' };
  if (automatic && run?.lastErrorCode === SHIYING_RESTORE_PAUSED) return blockedPickupResult(run, 0);
  if (run?.chunks.length && run.chunks.every(chunk => chunk.status === 'completed')) {
    if (run.lastErrorCode === SHIYING_RESTORE_PAUSED) {
      const previous = run;
      run = await commitPickupEpoch(epoch, dependencies, () => replaceRun(resumeRun(previous, now())));
    }
    return finalizeRun(run, dependencies, now(), epoch);
  }
  if (automatic && run && runStatus(run).kind === 'blocked') return blockedPickupResult(run, 0);
  if (run?.status === 'blocked' && run.chunks.length === 0) {
    return blockedPickupResult(run, 0);
  }
  if (run && !automatic) {
    const confirmation = retryConfirmationState(run, epoch);
    if (confirmation?.kind === 'retry_confirmation_required'
      && canonicalJsonV1(confirmation.confirmation) !== canonicalJsonV1(options?.retryConfirmation ?? null)) return confirmation;
  }
  if (isChatBusy()) return { kind: 'chat_busy' };

  const loadConfig = dependencies.loadConfig ?? loadAiConfigPreferencesSnapshot;
  const config = resolveShiyingPickupModelConfig(await loadConfig({ maxAgeMs: 0 }));
  if (!config) return { kind: 'model_config_missing' };
  if (run) {
    const current = await getRun();
    if (!current || runExecutionIdentity(current) !== runExecutionIdentity(run)
      || !(dependencies.canCommitEpoch ?? canCommitBackupRestoreDataEpoch)(epoch)) return { kind: 'recovery_stale' };
    run = current;
  }
  if (automatic && !await automatic.canRequest(config.connection)) return { kind: 'chat_busy' };

  if (!run) {
    const loadWindow = dependencies.loadWindow ?? loadShiyingMaterialWindow;
    const excludedLifeDates = dependencies.reservedLifeDates
      ? await dependencies.reservedLifeDates()
      : dependencies.loadWindow ? [] : await (await import('./shiyingBackfillStore')).getShiyingBackfillReservedLifeDates();
    const window = await loadWindow({ triggered: true, triggeredAt: now(),
      excludedLifeDates,
      ...(automatic ? { automaticScanFloorAt: automatic.scanFloorAt } : {}),
    });
    if (
      !window
      || !window.windowEndCursor
      || window.uncoveredYouCount === 0
      || window.messages.length === 0
    ) {
      return { kind: 'no_material' };
    }
    if (automatic && !await automatic.canRequest(config.connection)) return { kind: 'chat_busy' };
    run = await commitPickupEpoch(epoch, dependencies, () => createRun(createRunFromWindow({ config, now: now(), window }),
      automatic ? { nightLifeDate: automatic.nightLifeDate } : undefined));
    notifyPickupChanges();
    if (run.status === 'blocked') {
      return blockedPickupResult(run, 0);
    }
  } else if (run.status === 'blocked' || run.chunks.some((chunk) => chunk.status === 'in_flight')) {
    const previous = run;
    run = await commitPickupEpoch(epoch, dependencies, () => replaceRun(resumeRun(previous, now())));
    notifyPickupChanges();
  }

  const requestExtraction = dependencies.requestExtraction ?? requestShiyingExtraction;
  let callsThisAttempt = 0;
  while (callsThisAttempt < SHIYING_MANUAL_CALL_LIMIT) {
    const pendingChunk = run.chunks.find((chunk) => chunk.status !== 'completed');
    if (!pendingChunk) return finalizeRun(run, dependencies, now(), epoch);
    if (isChatBusy()) {
      if (callsThisAttempt === 0) return { kind: 'chat_busy' };
      return progressPickupResult(run, callsThisAttempt);
    }

    const startedAt = now();
    let previousRun = run;
    let executionChanged = false;
    const markStarted = async () => {
      const fresh = await getRun();
      const freshChunk = fresh?.chunks[pendingChunk.chunkIndex];
      if (!fresh || fresh.batchId !== previousRun.batchId || !freshChunk
        || freshChunk.status !== 'pending' || freshChunk.chunkId !== pendingChunk.chunkId
        || freshChunk.inputHash !== pendingChunk.inputHash || freshChunk.attemptCount !== pendingChunk.attemptCount
        || freshChunk.startedAt !== pendingChunk.startedAt) { executionChanged = true; return null; }
      previousRun = fresh;
      if (automatic) return (dependencies.startAutomaticChunk ?? startShiyingAutomaticRunChunk)({
        batchId: previousRun.batchId, chunkIndex: pendingChunk.chunkIndex,
        nightLifeDate: automatic.nightLifeDate, startedAt,
      });
      return replaceRun({
      ...previousRun,
      status: 'pending',
      lastErrorCode: null,
      updatedAt: Math.max(previousRun.updatedAt, startedAt),
      chunks: previousRun.chunks.map((chunk) => chunk.chunkIndex === pendingChunk.chunkIndex ? {
        ...chunk,
        status: 'in_flight',
        attemptCount: chunk.attemptCount + 1,
        lastErrorCode: null,
        startedAt,
        completedAt: null,
        candidates: null,
      } : chunk),
      } as ShiyingManualRunV1);
    };

    let rawText: string;
    let inFlightChunk = pendingChunk;
    try {
      const call = async () => {
        if (automatic && (!await automatic.canRequest(config.connection) || isChatBusy())) return null;
        const started = await commitPickupEpoch(epoch, dependencies, markStarted);
        if (!started) return null;
        run = started;
        inFlightChunk = run.chunks[pendingChunk.chunkIndex];
        if (automatic && (!await automatic.canRequest(config.connection) || isChatBusy())) {
          run = await (dependencies.cancelAutomaticChunk ?? cancelShiyingAutomaticRunChunkBeforeRequest)({
            batchId: run.batchId, chunkIndex: inFlightChunk.chunkIndex,
            nightLifeDate: automatic.nightLifeDate, startedAt, at: now(),
          });
          return null;
        }
        callsThisAttempt += 1;
        dependencies.onPhase?.('calling', {
          chunkIndex: inFlightChunk.chunkIndex, totalChunks: run.chunks.length, callsThisAttempt,
        });
        notifyPickupChanges();
        return (await requestExtraction({
        apiKey: config.apiKey,
        connection: config.connection,
        profile: config.profile,
        messages: inFlightChunk.materials,
        })).rawText;
      };
      const scheduled = automatic
        ? await (dependencies.scheduleAutomatic ?? runScheduledAiCall)('shiying-pickup', 'background', call)
        : { skipped: false as const, value: await call() };
      if (executionChanged) return { kind: 'recovery_stale' };
      if (scheduled.skipped || scheduled.value === null) return progressPickupResult(run, callsThisAttempt);
      rawText = scheduled.value;
    } catch (error) {
      if (!(dependencies.canCommitEpoch ?? canCommitBackupRestoreDataEpoch)(epoch)) return { kind: 'recovery_stale' };
      const code = error instanceof ShiyingExtractionRequestError
        && (error.code === 'empty' || error.code === 'response_json')
        ? 'model_output_invalid'
        : technicalCode(error);
      const blocked = markRunBlocked(run, inFlightChunk.chunkIndex, code, now());
      run = await commitPickupEpoch(epoch, dependencies, () => replaceRun(blocked));
      notifyPickupChanges();
      return blockedPickupResult(run, callsThisAttempt);
    }

    const projected = projectShiyingModelChunkResult({
      rawText,
      materials: inFlightChunk.materials,
    });
    if (projected.kind === 'invalid') {
      const blocked = markRunBlocked(
        run,
        inFlightChunk.chunkIndex,
        'model_output_invalid',
        now(),
      );
      run = await commitPickupEpoch(epoch, dependencies, () => replaceRun(blocked));
      notifyPickupChanges();
      return blockedPickupResult(run, callsThisAttempt);
    }

    const completedAt = now();
    if (!(dependencies.canCommitEpoch ?? canCommitBackupRestoreDataEpoch)(epoch)) return { kind: 'recovery_stale' };
    const cache: LocalSaveCache = { stage: 'chunk', epoch,
      state: pendingSaveState(run, 'chunk', inFlightChunk.chunkIndex),
      input: { batchId: run.batchId, chunkIndex: inFlightChunk.chunkIndex, chunkId: inFlightChunk.chunkId,
        inputHash: inFlightChunk.inputHash, attemptCount: inFlightChunk.attemptCount, startedAt: inFlightChunk.startedAt,
        completedAt, candidates: projected.kind === 'entries' ? storeCandidates(projected.candidates) : [] } };
    localSaveCache = cache;
    try {
      const saved = await writeCachedChunk(cache, dependencies);
      if (!saved) return { kind: 'recovery_stale' };
      run = saved;
    } catch (error) { return localSaveFailure(cache, error, dependencies); }
  }

  if (run.chunks.every((chunk) => chunk.status === 'completed')) {
    return finalizeRun(run, dependencies, now(), epoch);
  }
  return progressPickupResult(run, callsThisAttempt);
}

export function runManualShiyingPickup(
  dependencies: ShiyingCoordinatorDependencies = {},
  options?: ShiyingManualPickupOptions,
) {
  if (manualPickupFlight) return pickupFlightKind === 'manual'
    ? manualPickupFlight : Promise.resolve<ShiyingManualPickupResult>({ kind: 'chat_busy' });
  return startPickupFlight(dependencies, undefined, options);
}

export function runAutomaticShiyingPickup(
  options: ShiyingAutomaticPickupOptions,
  dependencies: ShiyingCoordinatorDependencies = {},
) {
  if (manualPickupFlight) return Promise.resolve<ShiyingManualPickupResult>({ kind: 'chat_busy' });
  return startPickupFlight(dependencies, options);
}

function startPickupFlight(dependencies: ShiyingCoordinatorDependencies, automatic?: ShiyingAutomaticPickupOptions,
  options?: ShiyingManualPickupOptions, localOnly = false, localTarget?: ShiyingPickupLocalSaveTarget) {
  const runBackupProtected = dependencies.runBackupProtected ?? (async <T,>(task: () => Promise<T>): Promise<BackupProtectedResult<T>> => {
    if (await ensureBackupRestoreRecovery()) return { ran: false, reason: 'recovery-performed' };
    const epoch = captureBackupRestoreDataEpoch();
    if (!canCommitBackupRestoreDataEpoch(epoch)) return { ran: false, reason: 'data-epoch-changed' };
    // Only local commits take shared protection. HTTP cannot hold up a restore.
    return { ran: true, value: await task() };
  });
  const flight = runBackupProtected(async () => {
    const result = localOnly ? await executeLocalSave(dependencies, localTarget) : await executeManualPickup(dependencies, automatic, options);
    if (!automatic && ['entries', 'zero', 'no_material'].includes(result.kind)) {
      await (dependencies.resolveAutomaticBlock ?? resolveShiyingAutomaticLocalBlock)((dependencies.now ?? Date.now)());
    }
    return result;
  })
    .then((result): ShiyingManualPickupResult => (
      result.ran ? result.value : { kind: 'restore_busy' }
    ))
    .catch((error): ShiyingManualPickupResult => {
      const code = technicalCode(error);
      if (automatic && code === 'automatic_not_permitted') return { kind: 'chat_busy' };
      return { kind: 'failed', code };
    })
    .finally(() => {
      if (manualPickupFlight === flight) { manualPickupFlight = null; pickupFlightKind = null; }
      notifyPickupChanges();
    });
  manualPickupFlight = flight;
  pickupFlightKind = localOnly ? 'local' : automatic ? 'automatic' : 'manual';
  return flight;
}

async function executeLocalSave(dependencies: ShiyingCoordinatorDependencies,
  target?: ShiyingPickupLocalSaveTarget): Promise<ShiyingManualPickupResult> {
  const hadCache = localSaveCache !== null;
  const cache = currentLocalSaveCache(dependencies);
  if (hadCache && !cache) return { kind: 'recovery_stale' };
  if (target && (!(dependencies.canCommitEpoch ?? canCommitBackupRestoreDataEpoch)(target.epoch)
    || cache && (cache.state.batchId !== target.batchId || cache.epoch !== target.epoch))) return { kind: 'recovery_stale' };
  if (cache?.stage === 'batch') return saveCachedBatch(cache, dependencies);
  if (cache?.stage === 'chunk') {
    try {
      const run = await writeCachedChunk(cache, dependencies);
      if (!run) return { kind: 'recovery_stale' };
      // Local finalization is allowed, but this path never requests the next pending chunk.
      return run.chunks.every(chunk => chunk.status === 'completed')
        ? finalizeRun(run, dependencies, (dependencies.now ?? Date.now)(), cache.epoch)
        : progressPickupResult(run, 0);
    } catch (error) { return localSaveFailure(cache, error, dependencies); }
  }
  const epoch = (dependencies.captureEpoch ?? captureBackupRestoreDataEpoch)();
  if (epoch === null) return { kind: 'restore_busy' };
  let run = await (dependencies.getRun ?? getShiyingManualRun)();
  if (!(dependencies.canCommitEpoch ?? canCommitBackupRestoreDataEpoch)(epoch)) return { kind: 'recovery_stale' };
  if (target && (target.epoch !== epoch || run?.batchId !== target.batchId)) return { kind: 'recovery_stale' };
  if (run?.lastErrorCode === SHIYING_RESTORE_PAUSED && run.chunks.length && run.chunks.every(chunk => chunk.status === 'completed')) {
    const previous = run;
    run = await commitPickupEpoch(epoch, dependencies, () => (dependencies.replaceRun ?? replaceShiyingManualRun)(resumeRun(previous, (dependencies.now ?? Date.now)())));
  }
  return run?.chunks.length && run.chunks.every(chunk => chunk.status === 'completed')
    ? finalizeRun(run, dependencies, (dependencies.now ?? Date.now)(), epoch) : { kind: 'recovery_stale' };
}

export function retryShiyingPickupLocalSave(dependencies: ShiyingCoordinatorDependencies = {},
  target?: ShiyingPickupLocalSaveTarget) {
  if (manualPickupFlight) return pickupFlightKind === 'local' ? manualPickupFlight
    : Promise.resolve<ShiyingManualPickupResult>({ kind: 'chat_busy' });
  return startPickupFlight(dependencies, undefined, undefined, true, target);
}

export async function abandonManualShiyingPickup(dependencies: ShiyingCoordinatorDependencies = {}) {
  if (manualPickupFlight) return false;
  const result = await (dependencies.runBackupProtected ?? runBackupProtectedTask)(async () => {
    const run = await (dependencies.getRun ?? getShiyingManualRun)();
    const cache = currentLocalSaveCache(dependencies);
    if (cache && (!run || run.batchId !== cache.state.batchId)) {
      if (cache.stage === 'batch') {
        try { await commitPickupEpoch(cache.epoch, dependencies,
          () => (dependencies.commitRun ?? commitShiyingManualRunResult)(cache.input)); }
        catch (error) { if (technicalCode(error) !== 'run_missing') return false; }
      }
      if (localSaveCache === cache) localSaveCache = null;
      return true;
    }
    if (!run) return false;
    if (runStatus(run).kind !== 'blocked' && cache?.state.batchId !== run.batchId
      && !run.chunks.every(chunk => chunk.status === 'completed')) return false;
    const abandoned = await abandonShiyingManualRun(run.batchId);
    if (abandoned && cache?.state.batchId === run.batchId) localSaveCache = null;
    return abandoned;
  });
  if (result.ran && result.value) notifyPickupChanges();
  return result.ran ? result.value : false;
}
