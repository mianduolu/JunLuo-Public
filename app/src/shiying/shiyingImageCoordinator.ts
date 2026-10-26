import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { isChatReplyInFlight, runScheduledAiCall } from '../ai/aiRuntimeScheduler';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { createShiyingImageNoteInputHash, hashShiyingJson, type ShiyingRecordImageJobV1 } from './shiyingImageNoteContract';
import * as store from './shiyingImageNoteStore';
import { buildShiyingImageStablePrompt } from './shiyingImagePrompt';
import { planShiyingRecordImages, planShiyingImageRequests, projectShiyingImageOutput, SHIYING_IMAGE_REQUEST_LIMIT } from './shiyingImagePlan';
import { buildShiyingImageRequestMaterial, requestShiyingImageNotes } from './shiyingImageRequest';
import type { ShiyingRecordV1 } from './shiyingJournalContract';
import { SHIYING_RESTORE_PAUSED } from './shiyingBackupPolicy';
import { registerShiyingBackupParticipant } from './shiyingBackupRuntime';

export type ShiyingImageProgress = {
  records: number; totalUnits: number; completedUnits: number;
  blocked: Array<{ recordId: string; code: string }>;
  skippedRecordIds: string[];
};
export type ShiyingImagePreparationResult = {
  kind: 'complete' | 'progress' | 'blocked' | 'no_material' | 'busy' | 'config_missing' | 'failed' | 'save_pending' | 'retry_confirmation_required';
  callsThisAttempt: number; completedRecordIds: string[]; estimatedRequests: number;
  progress: ShiyingImageProgress; code?: string;
};
export type ShiyingImageRetryConfirmation = {
  epoch: number;
  targets: store.ShiyingImageUnitAttempt[];
};
export type ShiyingImageRecoveryState = {
  kind: 'none' | 'save_pending' | 'retry_confirmation_required';
  recordIds: string[]; retryConfirmation: ShiyingImageRetryConfirmation | null;
};
type PendingImageSave = {
  epoch: number; jobs: ShiyingRecordImageJobV1[]; results: store.ShiyingImageUnitResult[];
  failedUnits: store.ShiyingImageUnitReference[]; errorCode?: string; completedAt: number;
};
type Config = Awaited<ReturnType<typeof loadAiConfigPreferencesSnapshot>>;
export type ShiyingImageCoordinatorPorts = {
  loadConfig: typeof loadAiConfigPreferencesSnapshot; now: () => number;
  chatBusy: typeof isChatReplyInFlight; schedule: typeof runScheduledAiCall;
  captureEpoch: typeof captureBackupRestoreDataEpoch; epochCurrent: typeof canCommitBackupRestoreDataEpoch;
  commitEpoch: typeof runBackupRestoreDataEpochCommit;
  material: typeof buildShiyingImageRequestMaterial; request: typeof requestShiyingImageNotes;
  store: typeof store; changed: (workAvailable?: boolean) => void;
};

export function resolveShiyingImageConfig(config: Config) {
  const connection = config.visionConnection;
  if (!connection || !config.visionKey?.trim()) return null;
  let endpoint: URL;
  try { endpoint = new URL(connection.baseUrl); } catch { return null; }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !connection.model.trim()) return null;
  const stablePrompt = buildShiyingImageStablePrompt(config.profile);
  const promptHash = hashShiyingJson(stablePrompt);
  const modelSource = { baseUrl: connection.baseUrl.trim(), model: connection.model.trim() };
  // Keys and display names never enter stable identities, jobs or provenance.
  const frozenConfigHash = hashShiyingJson({ contractVersion: 1, promptHash, modelSource,
    contextWindowTokens: connection.contextWindowTokens ?? 65536,
    outputLimit: connection.modelParameters?.maxTokens?.enabled ? connection.modelParameters.maxTokens.value : 8192,
    temperature: 0.2 });
  return { apiKey: config.visionKey, connection, stablePrompt, promptHash, modelSource, frozenConfigHash };
}

function technicalCode(error: unknown) {
  const text = error instanceof Error ? error.message : '';
  const code = text.split(':')[0];
  return /^(?:shiying_image|compiled_vision)_[a-z0-9_]+$/u.test(code) ? code : 'image_preparation_failed';
}
export function projectShiyingImageProgress(jobs: readonly ShiyingRecordImageJobV1[]): ShiyingImageProgress {
  const active = jobs.filter(job => job.status !== 'skipped');
  return { records: active.length, totalUnits: active.reduce((n, job) => n + job.units.length, 0),
    completedUnits: active.reduce((n, job) => n + job.units.filter(unit => unit.status === 'completed').length, 0),
    blocked: active.filter(job => job.status === 'blocked' || job.units.some(unit => unit.status === 'in_flight'))
      .map(job => ({ recordId: job.recordId, code: job.units.some(unit => unit.status === 'in_flight')
        ? 'request_interrupted_billing_unknown' : job.errorCode ?? 'image_preparation_failed' })),
    skippedRecordIds: jobs.filter(job => job.status === 'skipped').map(job => job.recordId) };
}

/** One manual or automatic opportunity; both share the same two-request ceiling. */
export function createShiyingImageCoordinator(overrides: Partial<ShiyingImageCoordinatorPorts> = {}) {
  const ports: ShiyingImageCoordinatorPorts = {
    loadConfig: loadAiConfigPreferencesSnapshot, now: Date.now, chatBusy: isChatReplyInFlight,
    schedule: runScheduledAiCall, captureEpoch: captureBackupRestoreDataEpoch,
    epochCurrent: canCommitBackupRestoreDataEpoch, commitEpoch: runBackupRestoreDataEpochCommit,
    material: buildShiyingImageRequestMaterial, request: requestShiyingImageNotes, store, changed: () => {}, ...overrides,
  };
  let running = false;
  let pendingSave: PendingImageSave | null = null;
  let recoveryConflict: string | null = null;
  async function progress() { return projectShiyingImageProgress(await ports.store.listShiyingRecordImageJobs({ includeSkipped: true })); }
  const emptyResult = (): ShiyingImagePreparationResult => ({ kind: 'progress', callsThisAttempt: 0, completedRecordIds: [], estimatedRequests: 0,
    progress: { records: 0, totalUnits: 0, completedUnits: 0, blocked: [], skippedRecordIds: [] } });
  function discardCachedRecords(recordIds: readonly string[]) {
    if (!pendingSave) return;
    pendingSave = { ...pendingSave, jobs: pendingSave.jobs.filter(job => !recordIds.includes(job.recordId)),
      results: pendingSave.results.filter(item => !recordIds.includes(item.recordId)),
      failedUnits: pendingSave.failedUnits.filter(item => !recordIds.includes(item.recordId)) };
    if (!pendingSave.jobs.length) pendingSave = null;
  }
  async function prunePendingSave() {
    const cached = pendingSave;
    if (!cached) return;
    if (!ports.epochCurrent(cached.epoch)) { pendingSave = null; recoveryConflict = 'shiying_image_restore_changed'; return; }
    const discarded: string[] = [];
    let conflict: string | null = null;
    let completedAt = cached.completedAt;
    for (const original of cached.jobs) {
      const snapshot = await ports.store.getShiyingImageNoteSnapshot(original.recordId);
      completedAt = Math.max(completedAt, snapshot.job?.updatedAt ?? 0);
      if (snapshot.note?.status === 'ready' && snapshot.sourceCurrent && snapshot.note.inputHash === original.inputHash) continue;
      const record = await ports.store.getShiyingImageRecordForProcessing(original.recordId);
      const refs = [...cached.results, ...cached.failedUnits].filter(ref => ref.recordId === original.recordId);
      if (!record || snapshot.job?.status === 'skipped') { discarded.push(original.recordId); continue; }
      if (!snapshot.job || snapshot.job.inputHash !== original.inputHash || !store.isShiyingImageNoteSourceCurrent(record, original)) {
        discarded.push(original.recordId); conflict ??= 'shiying_image_source_changed'; continue;
      }
      if (refs.some(ref => {
          const unit = snapshot.job!.units.find(item => item.id === ref.unitId);
          const previous = original.units.find(item => item.id === ref.unitId);
          return !unit || !previous || unit.attemptCount !== previous.attemptCount || unit.startedAt !== previous.startedAt;
        })) { discarded.push(original.recordId); conflict ??= 'shiying_image_retry_identity_changed'; }
    }
    // A read-only UI query can overlap the successful local save or a skip.
    if (pendingSave !== cached) return;
    if (!ports.epochCurrent(cached.epoch)) { pendingSave = null; recoveryConflict = 'shiying_image_restore_changed'; return; }
    cached.completedAt = completedAt;
    discardCachedRecords(discarded);
    recoveryConflict ??= conflict;
  }
  function retryTargets(jobs: readonly ShiyingRecordImageJobV1[]) {
    return jobs.flatMap(job => job.units.filter(unit => unit.status !== 'completed' && unit.attemptCount > 0)
      .map(unit => ({ recordId: job.recordId, inputHash: job.inputHash, unitId: unit.id,
        attemptCount: unit.attemptCount, startedAt: unit.startedAt })));
  }
  async function recoveryState(recordId?: string): Promise<ShiyingImageRecoveryState> {
    await prunePendingSave();
    if (pendingSave && (!recordId || pendingSave.jobs.some(job => job.recordId === recordId))) {
      return { kind: 'save_pending', recordIds: pendingSave.jobs.map(job => job.recordId), retryConfirmation: null };
    }
    const epoch = ports.captureEpoch();
    const jobs = (await ports.store.listShiyingRecordImageJobs({ includeSkipped: !!recordId }))
      .filter(job => !recordId || job.recordId === recordId);
    const targets = retryTargets(jobs);
    if (epoch !== null && ports.epochCurrent(epoch) && targets.length) return { kind: 'retry_confirmation_required',
      recordIds: [...new Set(targets.map(target => target.recordId))], retryConfirmation: { epoch, targets } };
    return { kind: 'none', recordIds: [], retryConfirmation: null };
  }
  async function retryLocalSave(recordId?: string) {
    const result = emptyResult();
    if (running) return { ...result, kind: 'busy' as const, code: 'single_flight' };
    running = true;
    try {
      await prunePendingSave();
      if (recoveryConflict) {
        result.kind = 'blocked'; result.code = recoveryConflict; recoveryConflict = null; return result;
      }
      const cached = pendingSave;
      if (!cached || recordId && !cached.jobs.some(job => job.recordId === recordId)) {
        result.kind = 'no_material'; result.code = 'local_save_unavailable'; return result;
      }
      const commit = await ports.commitEpoch(cached.epoch, () => ports.store.settleShiyingImageRequest({
        results: cached.results, failedUnits: cached.failedUnits, errorCode: cached.errorCode,
        completedAt: Math.max(ports.now(), cached.completedAt, ...cached.jobs.map(job => job.updatedAt)),
        localRecovery: { expectedJobs: cached.jobs, incompleteErrorCode: 'local_save_continuation_paused' },
      }));
      if (!commit.committed) { pendingSave = null; result.kind = 'blocked'; result.code = 'shiying_image_restore_changed'; return result; }
      pendingSave = null;
      result.completedRecordIds = commit.value.notes.map(note => note.recordId);
      result.kind = commit.value.jobs.length || commit.value.discardedRecordIds.length ? 'blocked' : 'complete';
      if (result.kind === 'blocked') result.code = commit.value.discardedRecordIds.length ? 'source_unavailable' : 'local_save_continuation_paused';
      result.progress = await progress();
      return result;
    } catch {
      result.kind = pendingSave ? 'save_pending' : 'failed'; result.code = 'image_result_save_failed';
      try { result.progress = await progress(); } catch { /* Keep the paid result even while storage is unavailable. */ }
      return result;
    } finally { running = false; ports.changed(false); }
  }
  async function run(options: { resumeRecordId?: string; targetRecordId?: string; retryConfirmation?: ShiyingImageRetryConfirmation;
    onProgress?: (value: ShiyingImagePreparationResult) => void;
    automatic?: boolean; canRequest?: () => boolean | Promise<boolean> } = {}) {
    const result = emptyResult();
    const update = async () => { result.progress = await progress(); ports.changed(); options.onProgress?.({ ...result }); };
    if (running) return { ...result, kind: 'busy' as const, code: 'single_flight' };
    running = true;
    let lastWriteAt = 0;
    const writeTime = (...floors: number[]) => (lastWriteAt = Math.max(ports.now(), lastWriteAt, ...floors));
    const epoch = ports.captureEpoch();
    const requestAllowed = async () => !options.automatic || !!options.canRequest && await options.canRequest();
    const guarded = async <T,>(work: () => Promise<T>) => {
      const commit = await ports.commitEpoch(epoch, work);
      if (!commit.committed) throw new Error('shiying_image_restore_changed');
      return commit.value;
    };
    let currentRefs: store.ShiyingImageUnitReference[] = [];
    let flightJobs: ShiyingRecordImageJobV1[] = [];
    const targetRecordId = options.targetRecordId ?? options.resumeRecordId;
    const scopeIds = targetRecordId ? [targetRecordId] : options.retryConfirmation
      ? [...new Set(options.retryConfirmation.targets.map(target => target.recordId))] : undefined;
    const inScope = (job: ShiyingRecordImageJobV1) => !scopeIds || scopeIds.includes(job.recordId);
    try {
      if (epoch === null || !ports.epochCurrent(epoch)) { result.kind = 'busy'; result.code = 'restore_busy'; return result; }
      await prunePendingSave();
      if (recoveryConflict) {
        result.kind = 'blocked'; result.code = recoveryConflict;
        if (!options.automatic) recoveryConflict = null;
        await update(); return result;
      }
      if (pendingSave) {
        result.kind = targetRecordId && !pendingSave.jobs.some(job => job.recordId === targetRecordId) ? 'busy' : 'save_pending';
        result.code = result.kind === 'busy' ? 'local_save_pending_other_record' : 'image_result_save_failed';
        await update(); return result;
      }
      if (!await requestAllowed()) { result.kind = 'busy'; result.code = 'automatic_paused'; return result; }
      const loadedScopedJobs = (await ports.store.listShiyingRecordImageJobs({ includeSkipped: true })).filter(inScope);
      const existingScopedJobs = loadedScopedJobs.filter(job => job.status !== 'skipped');
      const confirmationJobs = loadedScopedJobs.filter(job => job.status !== 'skipped' || !!targetRecordId);
      const restoredJobs = existingScopedJobs.filter(job => job.errorCode === SHIYING_RESTORE_PAUSED);
      if (restoredJobs.length && options.automatic) {
        result.kind = 'blocked'; result.code = SHIYING_RESTORE_PAUSED; await update(); return result;
      }
      if (options.retryConfirmation && (options.automatic || options.retryConfirmation.epoch !== epoch
        || !retryTargets(confirmationJobs).length
        || hashShiyingJson(retryTargets(confirmationJobs)) !== hashShiyingJson(options.retryConfirmation.targets))) {
        result.kind = 'retry_confirmation_required'; result.code = 'retry_confirmation_changed'; await update(); return result;
      }
      if (!options.automatic) {
        const completed = existingScopedJobs.filter(job => job.units.length && job.units.every(unit => unit.status === 'completed'));
        for (const job of completed) {
          const note = await guarded(() => ports.store.finalizeShiyingCompletedImageJob(job.recordId, writeTime(job.updatedAt)));
          if (!note) throw new Error('shiying_image_job_missing');
          result.completedRecordIds.push(note.recordId);
        }
        if (completed.length && completed.length === existingScopedJobs.length) {
          result.kind = 'complete'; await update(); return result;
        }
      }
      if (ports.chatBusy()) { result.kind = 'busy'; result.code = 'chat_busy'; return result; }
      await guarded(() => ports.store.recoverShiyingImageJobInterruptions(writeTime(), { recordIds: scopeIds }));
      const scopedJobs = (await ports.store.listShiyingRecordImageJobs({ includeSkipped: !!targetRecordId })).filter(inScope);
      const targets = retryTargets(scopedJobs);
      if (options.retryConfirmation) {
        const confirmed = options.retryConfirmation;
        if (options.automatic || confirmed.epoch !== epoch || !targets.length
          || hashShiyingJson(targets) !== hashShiyingJson(confirmed.targets)) {
          result.kind = 'retry_confirmation_required'; result.code = 'retry_confirmation_changed'; await update(); return result;
        }
      } else if (targets.length && !options.automatic) {
        result.kind = 'retry_confirmation_required'; result.code = 'request_retry_billing_unknown'; await update(); return result;
      }
      const config = resolveShiyingImageConfig(await ports.loadConfig({ readOnly: true, maxAgeMs: 0 }));
      if (!config) { result.kind = 'config_missing'; return result; }
      if (!options.automatic) for (const previous of scopedJobs.filter(job => job.status !== 'pending')) {
        await guarded(() => ports.store.resumeShiyingRecordImageJob({ recordId: previous.recordId, updatedAt: writeTime(previous.updatedAt) }));
      }
      let jobs = (await ports.store.listShiyingRecordImageJobs()).filter(inScope);
      // Existing frozen work wins. New finalized records never enter this opportunity midway.
      if (!jobs.length && !options.retryConfirmation) {
        const ids = (await ports.store.listShiyingImageEligibleRecordIds()).filter(id => !targetRecordId || id === targetRecordId);
        const created: ShiyingRecordImageJobV1[] = [];
        for (const id of ids) {
          const record = await ports.store.getShiyingImageRecordForProcessing(id);
          if (!record) continue;
          const plan = planShiyingRecordImages({ record, stablePrompt: config.stablePrompt, connection: config.connection });
          const at = writeTime(record.updatedAt);
          const images = record.images.map(({ id, ordinal, contentHash }) => ({ id, ordinal, contentHash }));
          created.push({ payloadVersion: 1, recordId: id, recordDate: record.recordDate, recordContentHash: plan.recordContentHash,
            images, contractVersion: 1, promptHash: config.promptHash, modelSource: config.modelSource,
            inputHash: createShiyingImageNoteInputHash({ recordId: id, recordContentHash: plan.recordContentHash, images,
              contractVersion: 1, promptHash: config.promptHash }), frozenConfigHash: config.frozenConfigHash,
            status: plan.kind === 'blocked' ? 'blocked' : 'pending', errorCode: plan.errorCode, createdAt: at, updatedAt: at,
            units: plan.units.map(unit => ({ ...unit, status: 'pending', attemptCount: 0, resultText: null,
              errorCode: null, startedAt: null, completedAt: null })) });
        }
        jobs = await guarded(() => ports.store.createShiyingRecordImageJobs(created));
      }
      if (!jobs.length) { result.kind = 'no_material'; await update(); return result; }
      // A failed or interrupted request needs an explicit retry, even after restarting the App.
      const blocked = options.automatic ? jobs.find(job => job.status === 'blocked') : undefined;
      if (blocked) {
        result.kind = 'blocked'; result.code = blocked.errorCode ?? 'image_preparation_failed';
        await update(); return result;
      }
      const records: ShiyingRecordV1[] = [];
      for (const job of jobs) {
        const record = await ports.store.getShiyingImageRecordForProcessing(job.recordId);
        const reason = job.frozenConfigHash !== config.frozenConfigHash ? 'frozen_config_mismatch'
          : !store.isShiyingImageNoteSourceCurrent(record, job) ? 'source_mismatch'
            : !job.units.length ? 'capacity_blocked' : null;
        if (reason) {
          await guarded(() => ports.store.blockShiyingRecordImageJob({ recordId: job.recordId, errorCode: reason,
            updatedAt: writeTime(job.updatedAt) }));
          result.kind = 'blocked'; result.code = reason; await update(); return result;
        }
        records.push(record!);
      }
      const requests = planShiyingImageRequests({ records, stablePrompt: config.stablePrompt, connection: config.connection,
        units: jobs.flatMap(job => job.units.filter(unit => unit.status !== 'completed').map(unit => ({ recordId: job.recordId, unit }))) });
      result.estimatedRequests = requests.length;
      await update();
      for (const plan of requests.slice(0, SHIYING_IMAGE_REQUEST_LIMIT)) {
        if (!await requestAllowed()) { result.kind = 'busy'; result.code = 'automatic_paused'; break; }
        if (ports.chatBusy() || !ports.epochCurrent(epoch)) { result.kind = 'busy'; result.code = ports.chatBusy() ? 'chat_busy' : 'restore_busy'; break; }
        currentRefs = plan.units.map(({ recordId, unit }) => ({ recordId, unitId: unit.id }));
        let material: Awaited<ReturnType<typeof buildShiyingImageRequestMaterial>>;
        try { material = await ports.material({ plan, records }); }
        catch (error) {
          const recordId = error instanceof Error ? error.message.split(':')[1] : undefined;
          const blocked = recordId ? jobs.filter(job => job.recordId === recordId) : jobs.filter(job => currentRefs.some(ref => ref.recordId === job.recordId));
          for (const job of blocked) await guarded(() => ports.store.blockShiyingRecordImageJob({ recordId: job.recordId,
            errorCode: 'file_unavailable', updatedAt: writeTime(job.updatedAt) }));
          result.kind = 'blocked'; result.code = 'file_unavailable'; currentRefs = []; break;
        }
        const scheduled = await ports.schedule('shiyingImageNotes', 'background', async () => {
          return ports.request({ ...config, material, outputTokens: plan.outputTokens,
            onRequestStart: async assertTransportReady => {
              if (!await requestAllowed()) throw new Error('shiying_image_automatic_paused');
              if (ports.chatBusy()) throw new Error('shiying_image_chat_busy');
              if (!ports.epochCurrent(epoch)) throw new Error('shiying_image_restore_changed');
              const fresh = resolveShiyingImageConfig(await ports.loadConfig({ readOnly: true, maxAgeMs: 0 }));
              if (fresh?.frozenConfigHash !== config.frozenConfigHash) throw new Error('shiying_image_frozen_config_mismatch');
              assertTransportReady();
              flightJobs = await guarded(() => ports.store.markShiyingImageUnitsInFlight({ units: currentRefs,
                expectedUnits: currentRefs.map(ref => {
                  const job = jobs.find(item => item.recordId === ref.recordId)!;
                  const unit = job.units.find(item => item.id === ref.unitId)!;
                  return { ...ref, inputHash: job.inputHash, attemptCount: unit.attemptCount, startedAt: unit.startedAt };
                }),
                expectedConfigHash: config.frozenConfigHash, startedAt: writeTime(...jobs.map(job => job.updatedAt)) }));
              assertTransportReady();
              if (!await requestAllowed()) throw new Error('shiying_image_automatic_paused');
              if (ports.chatBusy() || !ports.epochCurrent(epoch)) throw new Error('shiying_image_request_not_allowed');
              result.callsThisAttempt += 1;
              ports.changed(); options.onProgress?.({ ...result });
            } });
        });
        if (!scheduled.ok) { result.kind = 'busy'; result.code = 'shared_scheduler_busy'; currentRefs = []; break; }
        if (!ports.epochCurrent(epoch)) throw new Error('shiying_image_restore_changed');
        const output = projectShiyingImageOutput(scheduled.value, plan.units.map(unit => unit.recordId));
        const valid = output.validItems.map(item => ({ recordId: item.recordId, unitId: currentRefs.find(ref => ref.recordId === item.recordId)!.unitId, text: item.text }));
        const failed = currentRefs.filter(ref => !valid.some(item => item.recordId === ref.recordId));
        const completedAt = writeTime(...jobs.map(job => job.updatedAt));
        if (valid.length) pendingSave = { epoch, jobs: flightJobs, results: valid, failedUnits: failed,
          errorCode: output.hadInvalid ? 'bad_output' : undefined, completedAt };
        const settled = await guarded(() => ports.store.settleShiyingImageRequest({ results: valid, failedUnits: failed,
          errorCode: output.hadInvalid ? 'bad_output' : undefined, completedAt }));
        pendingSave = null;
        currentRefs = [];
        jobs = (await ports.store.listShiyingRecordImageJobs()).filter(inScope);
        result.completedRecordIds.push(...settled.notes.map(note => note.recordId));
        await update();
        if (output.hadInvalid || settled.discardedRecordIds.length) { result.kind = 'blocked'; result.code = output.hadInvalid ? 'bad_output' : 'source_unavailable'; break; }
      }
      if (result.kind === 'progress' && !jobs.length) result.kind = 'complete';
      await update();
      return result;
    } catch (error) {
      if (pendingSave && ports.epochCurrent(pendingSave.epoch)) {
        result.kind = 'save_pending'; result.code = 'image_result_save_failed';
        try { await update(); } catch { /* The received legal result remains in RAM for local-only save. */ }
        return result;
      }
      pendingSave = null;
      result.kind = 'blocked'; result.code = technicalCode(error);
      const deferred = result.code === 'shiying_image_automatic_paused' || result.code === 'shiying_image_chat_busy';
      if (deferred) result.kind = 'busy';
      if (currentRefs.length && ports.epochCurrent(epoch)) {
        try {
          // Only units actually marked in-flight can be failed; before-send failures remain pending.
          const refs: store.ShiyingImageUnitReference[] = [];
          for (const ref of currentRefs) {
            const job = await ports.store.getShiyingRecordImageJob(ref.recordId);
            if (job?.units.some(unit => unit.id === ref.unitId && unit.status === 'in_flight')) refs.push(ref);
            else if (!deferred && job && job.status !== 'skipped') await guarded(() => ports.store.blockShiyingRecordImageJob({
              recordId: job.recordId, errorCode: result.code!, updatedAt: writeTime(job.updatedAt) }));
          }
          if (refs.length) await guarded(async () => ports.store.failShiyingImageUnits({ units: refs, errorCode: result.code!,
            updatedAt: writeTime(...(await ports.store.listShiyingRecordImageJobs()).map(job => job.updatedAt)) }));
        } catch { result.code = 'image_result_save_failed'; }
      }
      try { await update(); } catch { result.kind = 'failed'; result.code = 'image_progress_read_failed'; }
      return result;
    } finally { running = false; ports.changed(!options.automatic && !pendingSave
      && !['blocked', 'failed', 'save_pending', 'retry_confirmation_required'].includes(result.kind)); }
  }
  async function skip(recordId: string) {
    if (running) throw new Error('shiying_image_single_flight');
    running = true;
    try {
      discardCachedRecords([recordId]);
      const epoch = ports.captureEpoch();
      const commit = await ports.commitEpoch(epoch, async () => {
        await ports.store.recoverShiyingImageJobInterruptions(ports.now(), { recordIds: [recordId] });
        const job = await ports.store.getShiyingRecordImageJob(recordId);
        return ports.store.skipShiyingRecordImageJob({ recordId, skippedAt: Math.max(ports.now(), job?.updatedAt ?? 0) });
      });
      if (!commit.committed) throw new Error('shiying_image_restore_changed');
      recoveryConflict = null;
      return commit.value;
    } finally { running = false; ports.changed(true); }
  }
  return { run, progress, skip, recoveryState, retryLocalSave, isRunning: () => running,
    hasPendingSave: () => pendingSave !== null,
    invalidateForRestore: () => { pendingSave = null; recoveryConflict = null; ports.changed(false); } };
}

const listeners = new Set<(workAvailable?: boolean) => void>();
export function notifyShiyingImageNotesChanged(workAvailable = false) { for (const listener of listeners) { try { listener(workAvailable); } catch { /* Listeners never interrupt a persisted request. */ } } }
export function subscribeShiyingImageNotes(listener: (workAvailable?: boolean) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
const coordinator = createShiyingImageCoordinator({ changed: notifyShiyingImageNotesChanged });
registerShiyingBackupParticipant({ hasPendingSave: coordinator.hasPendingSave, invalidate: coordinator.invalidateForRestore });
export const prepareShiyingRecordImages = coordinator.run;
export const getShiyingImagePreparationProgress = coordinator.progress;
export const skipShiyingImagePreparation = coordinator.skip;
export const isShiyingImagePreparationRunning = coordinator.isRunning;
export const getShiyingImageRecoveryState = coordinator.recoveryState;
export const retryShiyingImageLocalSave = coordinator.retryLocalSave;
