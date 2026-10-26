import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { isChatReplyInFlight, runScheduledAiCall } from '../ai/aiRuntimeScheduler';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { canonicalJsonV1, createShiyingEntryId, createShiyingCoverageId,
  SHIYING_EXTRACTION_CONTRACT_VERSION, type ShiyingEntryV1, type ShiyingCoverageReceiptV1 } from './shiyingContract';
import { resolveShiyingPickupModelConfig, isShiyingPickupExecuting } from './shiyingCoordinator';
import { buildShiyingExtractionStablePrompt } from './shiyingPrompt';
import { estimateShiyingExtractionPromptTokens, requestShiyingExtraction, projectShiyingModelChunkResult,
  finalizeShiyingBatchCandidates, ShiyingExtractionRequestError, type ShiyingBatchCandidateV1 } from './shiyingExtraction';
import { getShiyingManualRun, getShiyingCoverageKnowledge, listShiyingEntries } from './shiyingStore';
import { previewShiyingBackfill, shiyingBackfillSourceIdentity } from './shiyingBackfillSource';
import { createShiyingBackfillCoverageSources, type ShiyingBackfillPreviewV1 } from './shiyingBackfillPlan';
import { getShiyingBackfillTask, createShiyingBackfillTask, changeShiyingBackfillTask,
  saveShiyingBackfillChunk, commitShiyingBackfillDay, deleteShiyingBackfillTask,
  type ShiyingBackfillTask, type ShiyingBackfillDayState, type ShiyingBackfillChunkSave, type ShiyingBackfillDayCommit } from './shiyingBackfillStore';
import { setShiyingBackfillExecuting } from './shiyingBackfillState';
import { startShiyingBackfillBackground, updateShiyingBackfillBackground, stopShiyingBackfillBackground,
  subscribeShiyingBackfillBackgroundEnd } from './shiyingBackfillBackground';
import { flushShiyingBackfillCompletion } from './shiyingNotifications';
import { hashShiyingJson } from './shiyingImageNoteContract';
import { registerShiyingBackupParticipant } from './shiyingBackupRuntime';
import { SHIYING_RESTORE_PAUSED } from './shiyingBackupPolicy';

type Resolved = NonNullable<ReturnType<typeof resolveShiyingPickupModelConfig>>;
export function shiyingBackfillConfigurationHash(config: Resolved) {
  return hashShiyingJson({ prompt: buildShiyingExtractionStablePrompt(config.profile),
    baseUrl: config.connection.baseUrl, model: config.connection.model, provider: config.connection.provider,
    preset: config.connection.preset, parameters: config.connection.modelParameters ?? null,
    contextWindowTokens: config.connection.contextWindowTokens ?? 65_536 });
}
export type ShiyingBackfillRetryConfirmation = { taskId: string; lifeDate: string; chunkId: string;
  attemptCount: number; startedAt: number | null; epoch: number; revision: number };
export type ShiyingBackfillProgress = { task: ShiyingBackfillTask | null; executing: boolean;
  savePending: boolean; retryConfirmation: ShiyingBackfillRetryConfirmation | null; code: string | null };
export type ShiyingBackfillDependencies = {
  getTask?: typeof getShiyingBackfillTask; createTask?: typeof createShiyingBackfillTask;
  changeTask?: typeof changeShiyingBackfillTask; saveChunk?: typeof saveShiyingBackfillChunk;
  commitDay?: typeof commitShiyingBackfillDay; deleteTask?: typeof deleteShiyingBackfillTask;
  getLiveRun?: typeof getShiyingManualRun; pickupBusy?: () => boolean; chatBusy?: () => boolean;
  config?: typeof loadAiConfigPreferencesSnapshot; preview?: typeof previewShiyingBackfill;
  coverage?: typeof getShiyingCoverageKnowledge; entries?: typeof listShiyingEntries;
  request?: typeof requestShiyingExtraction; schedule?: typeof runScheduledAiCall;
  hostStart?: typeof startShiyingBackfillBackground; hostUpdate?: typeof updateShiyingBackfillBackground;
  hostStop?: typeof stopShiyingBackfillBackground; hostEnd?: typeof subscribeShiyingBackfillBackgroundEnd;
  notifyCompleted?: typeof flushShiyingBackfillCompletion; now?: () => number;
  captureEpoch?: typeof captureBackupRestoreDataEpoch; validEpoch?: typeof canCommitBackupRestoreDataEpoch;
  commitEpoch?: typeof runBackupRestoreDataEpochCommit; wait?: (milliseconds: number) => Promise<void>;
};
function code(error: unknown) {
  if (error instanceof ShiyingExtractionRequestError) return error.code;
  const value = error instanceof Error ? error.message.split(':')[0] : '';
  return /^shiying_[a-z0-9_]+$/u.test(value) ? value : 'operation_failed';
}
function fail(value: string): never { throw new Error(`shiying_backfill_${value}`); }

/** One manually authorized runner, independent of screens and AppState. Never starts on construction. */
export function createShiyingBackfillController(dependencies: ShiyingBackfillDependencies = {}) {
  const getTask = dependencies.getTask ?? getShiyingBackfillTask, change = dependencies.changeTask ?? changeShiyingBackfillTask;
  const now = dependencies.now ?? Date.now, capture = dependencies.captureEpoch ?? captureBackupRestoreDataEpoch;
  const valid = dependencies.validEpoch ?? canCommitBackupRestoreDataEpoch;
  const listeners = new Set<() => void>();
  let preview: { value: ShiyingBackfillPreviewV1; epoch: number } | null = null;
  let previewGeneration = 0;
  let activeHost: { taskId: string; hostToken: string } | null = null;
  let flight: Promise<void> | null = null, action = false, stopRequested = false, errorCode: string | null = null;
  let cache: { epoch: number } & ({ kind: 'chunk'; input: ShiyingBackfillChunkSave }
    | { kind: 'day'; input: ShiyingBackfillDayCommit }) | null = null;
  const changed = () => { for (const listener of listeners) { try { listener(); } catch { /* UI only. */ } } };
  async function commit<T>(epoch: number, work: () => Promise<T>): Promise<T> {
    const result = await (dependencies.commitEpoch ?? runBackupRestoreDataEpochCommit)(epoch, work);
    if (!result.committed) fail('epoch_changed'); return result.value;
  }
  async function config() { return resolveShiyingPickupModelConfig(await (dependencies.config ?? loadAiConfigPreferencesSnapshot)({ maxAgeMs: 0, readOnly: true })); }
  function retry(task: ShiyingBackfillTask, epoch: number) {
    const day = task.days.find(day => !day.completed), chunk = day?.chunks.find(chunk => chunk.status !== 'completed');
    return day && chunk && (task.lastErrorCode === 'shiying_restore_paid_unknown'
      || task.lastErrorCode === SHIYING_RESTORE_PAUSED && chunk.attemptCount > 0
      || chunk.attemptCount > 0 && (chunk.status === 'in_flight' || chunk.lastErrorCode !== null))
      ? { taskId: task.id, lifeDate: day.lifeDate, chunkId: chunk.chunkId, attemptCount: chunk.attemptCount,
        startedAt: chunk.startedAt, epoch, revision: task.revision } : null;
  }
  async function state(): Promise<ShiyingBackfillProgress> {
    const epoch = capture();
    if (cache && !valid(cache.epoch)) cache = null;
    const task = await getTask();
    if (cache && task?.id !== cache.input.taskId) cache = null;
    return { task, executing: flight !== null || action, savePending: cache !== null
      || !!task?.days.some(day => !day.completed && day.chunks.every(chunk => chunk.status === 'completed')),
      retryConfirmation: !flight && epoch !== null && task ? retry(task, epoch) : null,
      code: errorCode ?? task?.lastErrorCode ?? null };
  }
  async function finish(task: ShiyingBackfillTask, epoch: number) {
    if (!valid(epoch)) return;
    // Notification claims and OS work are not part of a business commit or an HTTP request.
    await (dependencies.notifyCompleted ?? flushShiyingBackfillCompletion)(task.id).catch(() => undefined);
  }
  async function settleDay(task: ShiyingBackfillTask, day: ShiyingBackfillDayState, epoch: number) {
    const knowledge = await (dependencies.coverage ?? getShiyingCoverageKnowledge)({
      messageCreatedAtStart: day.scanFloorAt, messageCreatedAtEnd: day.scanCeilingAt - 1 });
    const covered = new Set(knowledge.coveredSources.map(shiyingBackfillSourceIdentity));
    const candidates: ShiyingBatchCandidateV1[] = [];
    for (const chunk of day.chunks) {
      const result = projectShiyingModelChunkResult({ rawText: JSON.stringify({ entries: chunk.candidates ?? [] }), materials: chunk.materials });
      if (result.kind === 'invalid') fail('staged_result_invalid');
      result.candidates.forEach((candidate, modelOrder) => {
        if (candidate.sourceMaterials.some(source => source.role === 'you' && !covered.has(shiyingBackfillSourceIdentity(source))))
          candidates.push({ ...candidate, chunkIndex: chunk.chunkIndex, modelOrder });
      });
    }
    const materials = [...new Map(day.chunks.flatMap(chunk => chunk.materials).map(source => [
      JSON.stringify([source.sessionId, source.messageId]), source])).values()];
    const selected = finalizeShiyingBatchCandidates({ candidates, materials,
      existingEntries: await (dependencies.entries ?? listShiyingEntries)({ status: 'all' }) });
    const at = Math.max(task.updatedAt, now());
    const entries: ShiyingEntryV1[] = selected.map(candidate => ({
      payloadVersion: 1, id: createShiyingEntryId(), batchId: day.batchId!, lifeDate: day.lifeDate,
      category: candidate.category, body: candidate.body,
      eventStartedAt: Math.min(...candidate.sourceMaterials.map(source => source.messageCreatedAt)),
      eventEndedAt: Math.max(...candidate.sourceMaterials.map(source => source.messageCreatedAt)),
      status: 'active', editedAt: null, rejectedAt: null, presentedAt: null, createdAt: at, updatedAt: at,
      sources: candidate.sourceMaterials.map((source, ordinal) => ({ ordinal, sessionId: source.sessionId,
        messageId: source.messageId, role: source.role, evidenceKind: source.role === 'you' ? 'primary_you' : 'context_I',
        messageCreatedAt: source.messageCreatedAt, excerptSnapshot: source.text,
        evidenceQuote: source.role === 'you' ? source.text : null, contentHash: source.contentHash })),
    }));
    const coverages: ShiyingCoverageReceiptV1[] = day.chunks.filter(chunk => chunk.attemptCount > 0).map(chunk => {
      const sources = createShiyingBackfillCoverageSources(chunk.materials);
      const ids = new Set(sources.map(source => JSON.stringify([source.sessionId, source.messageId])));
      return { payloadVersion: 1, id: createShiyingCoverageId({ lane: 'backfill', chunkId: chunk.chunkId,
        inputHash: chunk.inputHash, contractVersion: SHIYING_EXTRACTION_CONTRACT_VERSION }), lane: 'backfill',
        batchId: day.batchId!, chunkId: chunk.chunkId, chunkIndex: chunk.chunkIndex, lifeDateStart: day.lifeDate,
        lifeDateEnd: day.lifeDate, windowStartCursor: null, windowEndCursor: day.windowEndCursor!,
        inputHash: chunk.inputHash, contractVersion: SHIYING_EXTRACTION_CONTRACT_VERSION,
        outcome: entries.some(entry => entry.sources.some(source => ids.has(JSON.stringify([source.sessionId, source.messageId])))) ? 'entries' : 'zero',
        executorDeviceId: null, completedAt: chunk.completedAt!, updatedAt: chunk.completedAt!, sources };
    });
    if (!valid(epoch)) fail('epoch_changed');
    cache = { kind: 'day', epoch, input: { taskId: task.id, lifeDate: day.lifeDate, coverages, entries, at } };
    await commit(epoch, () => (dependencies.commitDay ?? commitShiyingBackfillDay)(cache!.input as ShiyingBackfillDayCommit));
    cache = null; changed();
  }
  async function execute(taskId: string, epoch: number, hostToken?: string) {
    const releaseEnd = (dependencies.hostEnd ?? subscribeShiyingBackfillBackgroundEnd)(event => {
      if (event.taskId === taskId) { stopRequested = true; errorCode = 'host_ended'; changed(); }
    });
    try {
      while (valid(epoch)) {
        let task = await getTask(); if (!task || task.id !== taskId) return;
        if (task.days.every(day => day.completed)) {
          if (task.status !== 'completed') task = await commit(epoch, () => change(taskId, task!.revision, value => { value.status = 'completed'; }));
          await finish(task, epoch); return;
        }
        const day = task.days.find(day => !day.completed)!;
        if (day.chunks.every(chunk => chunk.status === 'completed')) {
          await settleDay(task, day, epoch);
          const next = await getTask();
          if (next) await (dependencies.hostUpdate ?? updateShiyingBackfillBackground)(taskId,
            next.days.filter(day => day.completed).length, next.days.length);
          continue;
        }
        // Pausing stops new requests, not local settlement of a day whose last
        // successful response has already arrived and been saved.
        if (stopRequested) break;
        if ((dependencies.chatBusy ?? isChatReplyInFlight)() || (dependencies.pickupBusy ?? isShiyingPickupExecuting)()) {
          await (dependencies.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1_000); continue;
        }
        const resolved = await config();
        if (!resolved) fail('model_config_missing');
        if (shiyingBackfillConfigurationHash(resolved) !== task.configurationHash) fail('configuration_changed');
        const chunk = day.chunks.find(chunk => chunk.status !== 'completed')!;
        const knowledge = await (dependencies.coverage ?? getShiyingCoverageKnowledge)({
          messageCreatedAtStart: day.scanFloorAt, messageCreatedAtEnd: day.scanCeilingAt - 1 });
        const covered = new Set(knowledge.coveredSources.map(shiyingBackfillSourceIdentity));
        if (!chunk.materials.some(source => source.role === 'you' && !covered.has(shiyingBackfillSourceIdentity(source)))) {
          await commit(epoch, () => change(taskId, task!.revision, value => {
            const skipped = value.days.find(value => value.lifeDate === day.lifeDate)!.chunks[chunk.chunkIndex];
            skipped.status = 'completed'; skipped.candidates = []; skipped.completedAt = Math.max(now(), value.updatedAt);
            // No successful request in this chunk: no fabricated receipt.
            skipped.attemptCount = 0;
          })); changed(); continue;
        }
        if (task.usedCalls >= task.authorizedCalls) fail('authorization_exhausted');
        const scheduled = await (dependencies.schedule ?? runScheduledAiCall)('shiying-backfill', 'background', async () => {
          if (stopRequested || !valid(epoch) || (dependencies.chatBusy ?? isChatReplyInFlight)()) return false;
          const startedAt = Math.max(task!.updatedAt, now());
          task = await commit(epoch, () => change(taskId, task!.revision, value => {
            if (value.status !== 'running' || value.usedCalls >= value.authorizedCalls) fail('authorization_exhausted');
            const target = value.days.find(value => value.lifeDate === day.lifeDate)!.chunks[chunk.chunkIndex];
            if (target.status !== 'pending') fail('attempt_conflict');
            target.status = 'in_flight'; target.attemptCount++; target.startedAt = startedAt; target.lastErrorCode = null;
            value.usedCalls++;
          }, startedAt));
          const activeChunk = task.days.find(value => value.lifeDate === day.lifeDate)!.chunks[chunk.chunkIndex];
          changed();
          // Recheck after reservation. A known local cancellation can safely release exactly this attempt.
          if (stopRequested || !valid(epoch) || (dependencies.chatBusy ?? isChatReplyInFlight)()) {
            if (valid(epoch)) await commit(epoch, () => change(taskId, task!.revision, value => {
              const target = value.days.find(value => value.lifeDate === day.lifeDate)!.chunks[chunk.chunkIndex];
              target.status = 'pending'; target.attemptCount--; target.startedAt = null; value.usedCalls--;
            }));
            return false;
          }
          const raw = await (dependencies.request ?? requestShiyingExtraction)({ ...resolved, messages: chunk.materials });
          if (!valid(epoch)) return false;
          const projected = projectShiyingModelChunkResult({ rawText: raw.rawText, materials: chunk.materials });
          if (projected.kind === 'invalid') fail('model_output_invalid');
          const input: ShiyingBackfillChunkSave = { taskId, lifeDate: day.lifeDate, chunkIndex: chunk.chunkIndex,
            chunkId: chunk.chunkId, attemptCount: activeChunk.attemptCount, startedAt,
            completedAt: Math.max(startedAt, now()), candidates: projected.candidates.map(candidate => ({
              category: candidate.category, body: candidate.body, sourceRefs: candidate.sourceMaterials.map(source => ({
                sessionId: source.sessionId, messageId: source.messageId })) })) };
          cache = { kind: 'chunk', epoch, input };
          await commit(epoch, () => (dependencies.saveChunk ?? saveShiyingBackfillChunk)(input));
          cache = null; changed(); return true;
        });
        if (scheduled.skipped || !scheduled.value) await (dependencies.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1_000);
        const next = await getTask();
        if (next) await (dependencies.hostUpdate ?? updateShiyingBackfillBackground)(taskId,
          next.days.filter(day => day.completed).length, next.days.length);
      }
    } catch (error) { errorCode = code(error); }
    finally {
      releaseEnd();
      if (valid(epoch)) {
        const task = await getTask().catch(() => null);
        if (task?.id === taskId && task.status !== 'completed') await commit(epoch, () => change(taskId, task.revision, value => {
          value.status = errorCode || cache ? 'blocked' : 'paused'; value.lastErrorCode = cache ? 'local_save_pending' : errorCode;
        })).catch(() => undefined);
      }
      await (dependencies.hostStop ?? stopShiyingBackfillBackground)(taskId, hostToken).catch(() => false);
      if (activeHost?.taskId === taskId && activeHost.hostToken === hostToken) activeHost = null;
      setShiyingBackfillExecuting(false); flight = null; changed();
    }
  }
  async function continueTask(confirmation?: ShiyingBackfillRetryConfirmation) {
    if (flight || action) return state(); action = true;
    const originalEpoch = capture();
    let originalTaskId: string | null = null;
    try {
      if (cache) return state();
      const epoch = originalEpoch; if (epoch === null) fail('restore_busy');
      let task = await getTask(); if (!task) return state();
      originalTaskId = task.id;
      if (task.status === 'completed') { await finish(task, epoch); return state(); }
      if ((dependencies.pickupBusy ?? isShiyingPickupExecuting)() || await (dependencies.getLiveRun ?? getShiyingManualRun)()) fail('live_run_unfinished');
      const token = retry(task, epoch);
      if (token && canonicalJsonV1(token) !== canonicalJsonV1(confirmation ?? null)) return state();
      if (task.days.some(day => !day.completed && day.chunks.some(chunk => chunk.status !== 'completed'))) {
        const resolved = await config(); if (!resolved) fail('model_config_missing');
        if (shiyingBackfillConfigurationHash(resolved) !== task.configurationHash) fail('configuration_changed');
      }
      task = await commit(epoch, () => change(task!.id, task!.revision, value => {
        value.status = 'running'; value.lastErrorCode = null;
        if (token) {
          // A renewed permission covers all remaining units; old attempts remain charged.
          value.authorizedCalls = value.usedCalls + value.days.flatMap(day => day.chunks).filter(chunk => chunk.status !== 'completed').length;
          const target = value.days.find(day => day.lifeDate === token.lifeDate)!.chunks.find(chunk => chunk.chunkId === token.chunkId)!;
          target.status = 'pending'; target.lastErrorCode = null;
        }
      }));
      errorCode = null; stopRequested = false;
      // Raise the domain guard before the native start await, so live/review cannot race this authorization.
      setShiyingBackfillExecuting(true);
      const host = await (dependencies.hostStart ?? startShiyingBackfillBackground)(task.id,
        task.days.filter(day => day.completed).length, task.days.length);
      if (!host.started) fail(host.code.toLowerCase().replace(/[^a-z0-9_]/gu, '_'));
      if (!valid(epoch)) { await (dependencies.hostStop ?? stopShiyingBackfillBackground)(task.id, host.hostToken); fail('epoch_changed'); }
      activeHost = { taskId: task.id, hostToken: host.hostToken };
      flight = execute(task.id, epoch, host.hostToken); changed(); return state();
    } catch (error) {
      errorCode = code(error); setShiyingBackfillExecuting(false);
      const task = await getTask().catch(() => null);
      if (task?.id === originalTaskId && originalEpoch !== null && valid(originalEpoch))
        await commit(originalEpoch, () => change(task.id, task.revision, value => {
        value.status = 'blocked'; value.lastErrorCode = errorCode;
      })).catch(() => undefined);
      changed(); return state();
    } finally { action = false; changed(); }
  }
  return {
    state, continue: continueTask,
    hasPendingSave: () => cache !== null,
    invalidateForRestore() {
      preview = null; previewGeneration++; cache = null; stopRequested = true; errorCode = null;
      const host = activeHost; activeHost = null;
      if (host) void (dependencies.hostStop ?? stopShiyingBackfillBackground)(host.taskId, host.hostToken).catch(() => false);
      setShiyingBackfillExecuting(false); changed();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    invalidatePreview() { preview = null; previewGeneration++; },
    async preview(lifeDates: string[]) {
      const generation = ++previewGeneration;
      preview = null;
      if (flight || action || await getTask() || await (dependencies.getLiveRun ?? getShiyingManualRun)()) fail('unfinished_task');
      const epoch = capture(); if (epoch === null) fail('restore_busy');
      const resolved = await config(); if (!resolved) fail('model_config_missing');
      const value = await (dependencies.preview ?? previewShiyingBackfill)({ lifeDates, triggeredAt: now(),
        configurationHash: shiyingBackfillConfigurationHash(resolved),
        contextWindowTokens: resolved.connection.contextWindowTokens ?? 65_536,
        estimateTokens: messages => estimateShiyingExtractionPromptTokens({ profile: resolved.profile, messages }) });
      if (!valid(epoch)) fail('epoch_changed');
      if (generation !== previewGeneration) fail('preview_stale');
      preview = { epoch, value }; return value;
    },
    async start(value: ShiyingBackfillPreviewV1) {
      if (flight || action) fail('busy');
      if (!preview || preview.value !== value || !valid(preview.epoch) || !value.days.length || value.blocked) fail('preview_stale');
      const permission = preview;
      action = true;
      try {
      const resolved = await config(); if (!resolved || shiyingBackfillConfigurationHash(resolved) !== value.configurationHash) fail('configuration_changed');
      if (preview !== permission) fail('preview_stale');
      await commit(permission.epoch, () => (dependencies.createTask ?? createShiyingBackfillTask)(value, createShiyingEntryId(), now()));
      preview = null;
      } finally { action = false; changed(); }
      return continueTask();
    },
    async pause() {
      const epoch = capture(); stopRequested = true;
      if (epoch === null) fail('restore_busy');
      const original = await getTask();
      if (flight) await flight;
      if (!valid(epoch)) fail('epoch_changed');
      const task = await getTask();
      if (task && task.id === original?.id && task.status === 'running') await commit(epoch, () => change(task.id, task.revision,
        value => { value.status = 'paused'; })); changed(); return state(); },
    async abandon(taskId: string) {
      const epoch = capture(); stopRequested = true;
      if (epoch === null) fail('restore_busy');
      const original = await getTask();
      if (original?.id !== taskId) fail('task_conflict');
      if (flight) await flight;
      if (!valid(epoch)) fail('epoch_changed');
      const task = await getTask();
      if (!task) { changed(); return; } // The last in-flight day may have completed the whole task.
      if (task?.id !== taskId) fail('task_conflict');
      if (cache?.input.taskId === taskId) cache = null;
      await commit(epoch, () => (dependencies.deleteTask ?? deleteShiyingBackfillTask)(taskId, epoch)); changed();
    },
    async retryLocalSave() {
      if (flight || action) return state(); action = true;
      try {
        const epoch = cache?.epoch ?? capture(); if (epoch === null || !valid(epoch)) { cache = null; fail('epoch_changed'); }
        const pending = cache;
        if (pending?.kind === 'chunk') await commit(epoch, () => (dependencies.saveChunk ?? saveShiyingBackfillChunk)(pending.input));
        else if (pending?.kind === 'day') await commit(epoch, () => (dependencies.commitDay ?? commitShiyingBackfillDay)(pending.input));
        cache = null;
        let task = await getTask();
        if (task) {
          const day = task.days.find(day => !day.completed);
          if (day && day.chunks.every(chunk => chunk.status === 'completed')) await settleDay(task, day, epoch);
          task = await getTask();
          if (task?.status === 'completed') await finish(task, epoch);
          else if (task) await commit(epoch, () => change(task!.id, task!.revision, value => { value.status = 'paused'; value.lastErrorCode = null; }));
        }
        errorCode = null;
      } catch (error) { errorCode = code(error); }
      finally { action = false; changed(); }
      return state();
    },
  };
}
export const shiyingBackfillController = createShiyingBackfillController();
registerShiyingBackupParticipant({ hasPendingSave: shiyingBackfillController.hasPendingSave,
  invalidate: shiyingBackfillController.invalidateForRestore });
