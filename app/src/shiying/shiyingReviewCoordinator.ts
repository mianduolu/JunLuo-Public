import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { isChatReplyInFlight, runScheduledAiCall } from '../ai/aiRuntimeScheduler';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { createShiyingEntryId, createShiyingSummaryId } from './shiyingContract';
import { type ShiyingSummaryV2 } from './shiyingJournalContract';
import { getShiyingSummarySnapshot, validateShiyingFactSourcesWithDatabase } from './shiyingJournalStore';
import { hashShiyingJson as hash } from './shiyingImageNoteContract';
import { loadShiyingMixedMaterials, type ShiyingMixedMaterialV1 } from './shiyingMixedMaterials';
import { shiyingRecordCoordinator } from './shiyingRecordCoordinator';
import { runShiyingDatabaseOperation } from './shiyingDatabase';
import { createShiyingReviewOperationId, createShiyingReviewOperationIdV2, type ShiyingReviewRun, type ShiyingScopedSourceV1, type ShiyingEventPatch, type ShiyingTopicV1 } from './shiyingReviewContract';
import { createShiyingSummaryStateHash, type ShiyingSummaryV3 } from './shiyingSummaryContract';
import { loadShiyingReviewFactsWithDatabase, loadShiyingReviewImageCoverageWithDatabase, loadShiyingPeriodReviewInputs,
  loadShiyingPeriodReviewInputsWithDatabase, assertShiyingPeriodReviewFrozenSources } from './shiyingPeriodReviewStore';
import { planShiyingPeriodReview, buildShiyingPeriodReviewMaterial, buildShiyingPeriodReviewFinalMaterial,
  collectShiyingPeriodReviewFinalVisible, projectShiyingPeriodReviewSources, parseShiyingPeriodReviewModelResult,
  createShiyingPeriodReviewMembershipHash, shiyingPeriodReviewEligibility, shiyingPeriodForDate, shiyingPeriodReadyAt,
  getShiyingLatestClosedPeriod, type PeriodReviewPlan, type PeriodReviewModelResult } from './shiyingPeriodReview';
import { buildShiyingPeriodReviewPrompt } from './shiyingPeriodReviewPrompt';
import { publishShiyingSummaryChanges } from './shiyingSummaryStore';
import * as store from './shiyingReviewStore';
import { buildShiyingReviewPrompt } from './shiyingReviewPrompt';
import { planShiyingReview, buildShiyingReviewMaterial, buildShiyingReviewFinalMaterial, type ReviewPlan, type ReviewEventContext } from './shiyingReviewPlan';
import { parseShiyingReviewModelResult, type ShiyingReviewModelResult } from './shiyingReviewValidation';
import { shiyingReviewFits, requestShiyingWeeklyReview } from './shiyingReviewRequest';
import { getShiyingReviewWeek, reserveShiyingWeeklyReviewCall, cancelShiyingWeeklyReviewReservation, shiyingWeekForDate } from './shiyingReviewPolicy';
import { resolveShiyingPickupModelConfig } from './shiyingCoordinator';
import { SHIYING_RESTORE_PAUSED } from './shiyingBackupPolicy';
import { registerShiyingBackupParticipant } from './shiyingBackupRuntime';

export type ShiyingReviewProgress = { completed: number; total: number; stage: 'read' | 'final' };
export type ShiyingReviewRetryConfirmation = { runId: string; chunkId: string; attempts: number; epoch: number };
export type ShiyingWeeklyReviewResult = {
  kind: 'completed' | 'direct' | 'no_material' | 'progress' | 'blocked' | 'failed' | 'busy' | 'save_pending' | 'retry_confirmation_required';
  code?: string; progress?: ShiyingReviewProgress; retryConfirmation?: ShiyingReviewRetryConfirmation; summaryId?: string; entryId?: string;
};
type PendingReviewChunk = { epoch: number; run: ShiyingReviewRun; chunkId: string; attempts: number; startedAt: number;
  resultJson: string; completedAt: number };
type PendingReviewFinal = { epoch: number; input: Parameters<typeof store.commitShiyingWeeklyReview>[0] };
type Ports = {
  now: () => number; loadConfig: typeof loadAiConfigPreferencesSnapshot; materials: typeof loadShiyingMixedMaterials;
  store: typeof store; settle: typeof shiyingRecordCoordinator.settle; request: typeof requestShiyingWeeklyReview;
  chatBusy: typeof isChatReplyInFlight; captureEpoch: typeof captureBackupRestoreDataEpoch; epochCurrent: typeof canCommitBackupRestoreDataEpoch;
  commitEpoch: typeof runBackupRestoreDataEpochCommit; schedule: typeof runScheduledAiCall;
  summary: typeof getShiyingSummarySnapshot;
  periodInputs: typeof loadShiyingPeriodReviewInputs;
  hasDrafts: (start: string, end: string) => Promise<boolean>;
};
const listeners = new Set<() => void>();
function changed() { listeners.forEach(listener => { try { listener(); } catch { /* A view cannot undo a committed result. */ } }); }
export function subscribeShiyingWeeklyReviews(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
store.subscribeShiyingReviewChanges(changed);
const codeOf = (error: unknown) => error instanceof Error && /^shiying_[a-z0-9_]+(?::[a-zA-Z0-9.-]+)?$/u.test(error.message)
  ? error.message.split(':')[0] : 'shiying_review_local_failed';
const progressOf = (run: ShiyingReviewRun): ShiyingReviewProgress => ({ completed: run.chunks.filter(chunk => chunk.status === 'completed').length,
  total: run.chunks.length, stage: run.chunks.find(chunk => chunk.status !== 'completed')?.stage ?? 'final' });
const invalidReviewResult = (code: string) => /source_changed|source_conflict|image_note_conflict|task_changed|event_changed|restore_changed|summary_content_conflict|summary_human_edited|summary_rejected|input_summary_stale|input_node_stale|input_root_conflict|source_(?:entry|record|image_note)_stale|source_image_order|source_range_/u.test(code);

export function createShiyingReviewCoordinator(overrides: Partial<Ports> = {}) {
  const ports: Ports = { now: Date.now, loadConfig: loadAiConfigPreferencesSnapshot, materials: loadShiyingMixedMaterials, store,
    settle: shiyingRecordCoordinator.settle, request: requestShiyingWeeklyReview, chatBusy: isChatReplyInFlight,
    captureEpoch: captureBackupRestoreDataEpoch, epochCurrent: canCommitBackupRestoreDataEpoch,
    commitEpoch: runBackupRestoreDataEpochCommit, schedule: runScheduledAiCall, summary: getShiyingSummarySnapshot, periodInputs: loadShiyingPeriodReviewInputs,
    hasDrafts: (start, end) => runShiyingDatabaseOperation(async db => !!(await db.getFirstAsync<{ count: number }>(
      "SELECT COUNT(*) AS count FROM shiying_records WHERE status='draft' AND record_date BETWEEN ? AND ?;", start, end))?.count), ...overrides };
  let running = false;
  let pending: PendingReviewChunk | null = null;
  let finalPending: PendingReviewFinal | null = null;
  const periodPending = new Map<string, PendingReviewChunk>();
  const periodFinalPending = new Map<string, PendingReviewFinal>();
  const protect = async <T,>(epoch: number, work: () => Promise<T>): Promise<T> => {
    const result = await ports.commitEpoch(epoch, work);
    if (!result.committed) throw new Error('shiying_review_restore_changed'); return result.value;
  };
  const loadMaterials = (run: Pick<ShiyingReviewRun, 'periodStart' | 'periodEnd'>) => ports.materials({ dateStart: run.periodStart, dateEnd: run.periodEnd });

  async function contexts(materials: ShiyingMixedMaterialV1[], frozen?: ReviewPlan): Promise<ReviewEventContext[]> {
    let ids: string[];
    if (frozen) ids = frozen.events.map(event => event.id);
    else {
      const index: Awaited<ReturnType<typeof store.listShiyingEvents>>['items'] = [];
      let cursor: Awaited<ReturnType<typeof store.listShiyingEvents>>['nextBefore'] | undefined;
      do { const page = await ports.store.listShiyingEvents({ ...(cursor ? { before: cursor } : {}), limit: 30 }); index.push(...page.items); cursor = page.nextBefore ?? undefined; } while (cursor);
      const linked = new Set(await ports.store.getRelatedShiyingEventIdsForSources(materials.map(({ kind, id }) => ({ kind, id }))));
      const topics = (await Promise.all(materials.map(({ kind, id }) => ports.store.getShiyingTopicsForSource(kind, id)))).flat();
      const topicTitles = topics.map(topic => topic.title.normalize('NFKC').toLowerCase());
      for (const id of await ports.store.getRelatedShiyingEventIdsForSources(topics.flatMap(topic => topic.sources))) linked.add(id);
      const text = materials.map(item => item.body).join('\n').normalize('NFKC').toLowerCase();
      const characters = Array.from(text);
      const grams = new Set(characters.slice(0, -1).map((char, i) => char + characters[i + 1]));
      const score = (title: string) => { const chars = Array.from(title.normalize('NFKC').toLowerCase()); return chars.slice(0, -1).filter((char, i) => grams.has(char + chars[i + 1])).length; };
      const topicMatch = (title: string) => topicTitles.some(topic => topic.includes(title.normalize('NFKC').toLowerCase()));
      index.sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)) || Number(topicMatch(b.title)) - Number(topicMatch(a.title)) || score(b.title) - score(a.title)
        || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
      if (linked.size > 20) throw new Error('shiying_review_capacity_blocked');
      ids = index.slice(0, 20).map(event => event.id);
    }
    const contextSources = (frozen ? frozen.materials : materials).map(({ kind, id }) => ({ kind, id }));
    const snapshots = await Promise.all(ids.map(id => ports.store.getShiyingEventContextSnapshot(id, contextSources)));
    const available = snapshots.filter(event => event !== null);
    // Corrections must retain a target identity even if it was not a lexical match.
    for (let index = 0; index < available.length; index += 1) {
      const event = available[index];
      if (event.payloadVersion === 2) for (const feedback of event.associationFeedback) {
      if (feedback.toEventId && !available.some(item => item.id === feedback.toEventId)) {
        if (available.length >= 20) throw new Error('shiying_review_capacity_blocked');
        const target = await ports.store.getShiyingEventContextSnapshot(feedback.toEventId, contextSources);
        if (!target) throw new Error('shiying_review_event_changed');
        available.push(target);
      }
      }
    }
    const validNodes = new Map<string, Set<string>>();
    for (const event of available) {
      const ids = new Set<string>();
      for (const node of event.nodes) {
        try {
          await runShiyingDatabaseOperation(db => node.payloadVersion === 2
            ? ports.store.validateShiyingScopedSourcesWithDatabase(db, node.sources)
            : validateShiyingFactSourcesWithDatabase(db, node.sources));
          ids.add(node.id);
        } catch (error) {
          if (!/source|record_missing|entry_missing|finalized/u.test(codeOf(error))) throw error;
        }
      }
      validNodes.set(event.id, ids);
    }
    let nodeIndex = 0;
    const result = available.map((event, i): ReviewEventContext => ({ id: event.id, ref: `E${i + 1}`, updatedAt: event.updatedAt,
      title: event.title, overview: event.dirty ? '' : event.overview,
      nodes: event.nodes.filter(node => validNodes.get(event.id)!.has(node.id)).slice(-5).map(node => ({ id: node.id, ref: `N${++nodeIndex}`, date: node.eventDate, body: node.body })), feedback: [] }));
    available.forEach((event, i) => { if (event.payloadVersion === 2) result[i].feedback = event.associationFeedback.map(item => ({
      nodeId: item.nodeId, ref: result.flatMap(event => event.nodes).find(node => node.id === item.nodeId)?.ref ?? `N${++nodeIndex}`,
      body: item.nodeBody, fromRef: result.find(event => event.id === item.fromEventId)?.ref ?? result[i].ref,
      toRef: item.toEventId ? result.find(event => event.id === item.toEventId)?.ref ?? null : null,
    })); });
    if (frozen && (frozen.events.length !== result.length || frozen.events.some(saved => {
      const current = result.find(event => event.id === saved.id); return !current || hash(current) !== saved.hash;
    }))) throw new Error('shiying_review_event_changed');
    return result;
  }
  async function check(run: ShiyingReviewRun) {
    const plan = JSON.parse(run.planJson) as ReviewPlan;
    if (plan.version !== 1 || plan.inputHash !== run.inputHash || !Array.isArray(plan.refs) || !Array.isArray(plan.materials)) throw new Error('shiying_review_plan_invalid');
    const materials = await loadMaterials(run);
    for (const saved of plan.materials) if (!materials.some(item => item.kind === saved.kind && item.id === saved.id && item.materialHash === saved.materialHash)) throw new Error('shiying_review_source_changed');
    const events = await contexts(materials, plan); return { plan, materials, events };
  }
  function scoped(plan: ReviewPlan, labels: string[]): ShiyingScopedSourceV1[] {
    const sources = new Map<string, ShiyingScopedSourceV1>();
    for (const label of labels) {
      const ref = plan.refs.find(ref => ref.ref === label); if (!ref) throw new Error('shiying_review_unknown_source');
      const key = `${ref.kind}:${ref.id}`;
      const source = sources.get(key) ?? { kind: ref.kind, id: ref.id, contentHash: ref.contentHash, imageIds: [], textRanges: [], imageNoteRanges: [], imageNoteHash: null };
      if (ref.component === 'body') source.textRanges.push(ref.range);
      else { source.imageNoteRanges.push(ref.range); source.imageNoteHash = ref.imageNoteHash; source.imageIds = ref.imageIds; }
      sources.set(key, source);
    }
    const merge = (ranges: Array<{ start: number; end: number }>) => ranges.sort((a, b) => a.start - b.start).reduce<typeof ranges>((all, range) => {
      const last = all.at(-1); if (last && range.start <= last.end) last.end = Math.max(last.end, range.end); else all.push({ ...range }); return all;
    }, []);
    return [...sources.values()].map(source => ({ ...source, textRanges: merge(source.textRanges), imageNoteRanges: merge(source.imageNoteRanges) }));
  }
  async function assemble(run: ShiyingReviewRun, result: ShiyingReviewModelResult, plan: ReviewPlan, events: ReviewEventContext[]) {
    const at = Math.max(ports.now(), run.updatedAt); const review = result.review!;
    const summaryId = createShiyingSummaryId({ kind: 'week', periodStartLifeDate: run.periodStart, periodEndLifeDate: run.periodEnd });
    const priorSummary = await ports.summary(summaryId);
    if (priorSummary?.status === 'rejected') throw new Error('shiying_review_rejected');
    const legacySummary: ShiyingSummaryV2 = { payloadVersion: 2, id: summaryId, kind: 'week', periodStartLifeDate: run.periodStart, periodEndLifeDate: run.periodEnd,
      factSummary: `# ${review.title}\n\n${review.factSummary}`, baiyunNote: review.baiyunNote, inputHash: plan.inputHash,
      contractVersion: 1, status: 'active', dirty: false, rejectedAt: null, presentedAt: priorSummary?.presentedAt ?? null,
      createdAt: priorSummary?.createdAt ?? at, updatedAt: Math.max(at, priorSummary?.updatedAt ?? 0),
      sources: scoped(plan, review.sources).map(({ textRanges: _text, imageNoteRanges: _image, imageNoteHash: _hash, ...source }) => source) };
    const summary: ShiyingSummaryV2 | ShiyingSummaryV3 = run.contractVersion === 2 ? { ...legacySummary, payloadVersion: 3,
      title: review.title, factSummary: review.factSummary, editedAt: priorSummary?.payloadVersion === 3 ? priorSummary.editedAt : null,
      sourceInvalidated: false, sources: scoped(plan, review.sources), inputSources: [], contractVersion: 2,
      imageCoverage: plan.imageCoverage ?? { records: [], legacyUnknownSummaryIds: [] } } : legacySummary;
    const patches: ShiyingEventPatch[] = [];
    for (const event of result.events) {
      const context = events.find(item => item.ref === event.ref);
      const id = context?.id ?? createShiyingEntryId();
      const snapshot = context ? await ports.store.getShiyingEventContextSnapshot(id, plan.materials) : null;
      patches.push({ id, title: event.title, overview: event.overview, expectedUpdatedAt: context?.updatedAt ?? null,
        nodes: event.nodes.map(node => {
          const oldId = context?.nodes.find(item => item.ref === node.ref)?.id;
          const prior = snapshot?.nodes.find(item => item.id === oldId); const sources = scoped(plan, node.sources);
          if (prior && !sources.some(source => prior.sources.some(old => old.kind === source.kind && old.id === source.id))) throw new Error('shiying_review_historical_node');
          return { payloadVersion: 2 as const, id: prior?.id ?? createShiyingEntryId(), eventId: id,
            eventDate: prior?.eventDate ?? node.sources.map(label => plan.refs.find(ref => ref.ref === label)!.date).sort().at(-1)!,
            ordinal: 0, body: node.body, sources, createdAt: prior?.createdAt ?? at, updatedAt: Math.max(at, prior?.updatedAt ?? 0) };
        }) });
    }
    const topicMap = new Map<string, ShiyingTopicV1>();
    for (const topic of result.topics) {
      const key = topic.title.normalize('NFKC').toLowerCase(); const current = topicMap.get(key);
      if (current) { current.sources = scoped(plan, [...new Set(result.topics.filter(item => item.title.normalize('NFKC').toLowerCase() === key).flatMap(item => item.sources))]); continue; }
      const prior = (await ports.store.queryShiyingTopics(topic.title)).find(item => item.summaryId === summaryId && item.title.normalize('NFKC').toLowerCase() === key);
      topicMap.set(key, { payloadVersion: 1, id: prior?.id ?? createShiyingEntryId(), summaryId, title: topic.title,
        dirty: false, createdAt: prior?.createdAt ?? at, updatedAt: at, sources: scoped(plan, topic.sources) });
    }
    return { runId: run.id, summary, events: patches, topics: [...topicMap.values()],
      ...(run.contractVersion === 2 ? { expectedSummaryStateHash: plan.expectedSummaryStateHash ?? null,
        allowHumanReplacement: !!plan.regenerationIntentId,
        validateBeforeCommit: async (db: Parameters<typeof loadShiyingReviewFactsWithDatabase>[0]) => {
          const current = await loadShiyingReviewFactsWithDatabase(db, run.periodStart, run.periodEnd);
          for (const saved of plan.materials) if (!current.some(item => item.kind === saved.kind && item.id === saved.id && item.materialHash === saved.materialHash)) throw new Error('shiying_review_source_changed');
          return current.some(item => !plan.materials.some(saved => saved.kind === item.kind && saved.id === item.id));
        } } : {}), receipt: {
      id: run.id, periodStart: run.periodStart, periodEnd: run.periodEnd, inputHash: run.inputHash, basisHash: plan.basisHash,
      promptHash: run.promptHash, outcome: 'review' as const, summaryId, completedAt: at,
      ...(run.contractVersion === 2 ? { kind: 'week' as const, contractVersion: 2 as const, regenerationIntentId: plan.regenerationIntentId ?? null } : {}) } };
  }
  async function finish(run: ShiyingReviewRun, epoch: number) {
    const { plan, events, materials } = await check(run);
    const last = run.chunks.at(-1)!; const result = JSON.parse(last.resultJson!) as ShiyingReviewModelResult;
    const input = await assemble(run, result, plan, events);
    if (!ports.epochCurrent(epoch)) throw new Error('shiying_review_restore_changed');
    finalPending = { epoch, input };
    finalPending.input.summary!.dirty = materials.some(item => !plan.materials.some(saved => saved.kind === item.kind && saved.id === item.id));
    const saved = await protect(epoch, () => ports.store.commitShiyingWeeklyReview(finalPending!.input));
    finalPending = null; return { kind: 'completed' as const, summaryId: saved.summary?.id };
  }
  async function recovery() {
    const epoch = ports.captureEpoch();
    if (pending && !ports.epochCurrent(pending.epoch)) pending = null;
    if (finalPending && !ports.epochCurrent(finalPending.epoch)) finalPending = null;
    if (running) return { kind: 'busy' as const };
    if (pending || finalPending) return { kind: 'save_pending' as const };
    const run = await ports.store.getShiyingReviewRun(); if (!run) return { kind: 'none' as const };
    const progress = progressOf(run);
    if (run.lastErrorCode === SHIYING_RESTORE_PAUSED && run.chunks.every(chunk => chunk.status === 'completed'))
      return { kind: 'blocked' as const, progress, code: SHIYING_RESTORE_PAUSED };
    if (run.chunks.every(chunk => chunk.status === 'completed')) return run.status === 'blocked' && invalidReviewResult(run.lastErrorCode ?? '')
      ? { kind: 'blocked' as const, progress, code: run.lastErrorCode ?? undefined } : { kind: 'finalize' as const, progress };
    const next = run.chunks.find(chunk => chunk.status !== 'completed')!;
    if (epoch !== null && (next.status === 'in_flight' || run.status === 'blocked' && next.attempts > 0
      && !['shiying_review_capacity_blocked', 'shiying_review_local_resume'].includes(run.lastErrorCode ?? ''))) {
      return { kind: 'retry_confirmation_required' as const, progress, code: run.lastErrorCode ?? 'shiying_review_interrupted',
        retryConfirmation: { epoch, runId: run.id, chunkId: next.id, attempts: next.attempts } };
    }
    return { kind: run.status === 'blocked' ? 'blocked' as const : 'normal' as const, code: run.lastErrorCode ?? undefined, progress };
  }
  async function retryLocal(): Promise<ShiyingWeeklyReviewResult> {
    if (running) return { kind: 'busy' }; running = true;
    let targetId = pending?.run.id ?? finalPending?.input.runId ?? null;
    let taskEpoch = pending?.epoch ?? finalPending?.epoch ?? ports.captureEpoch();
    try {
      if (pending) {
        const cache = pending;
        if (!ports.epochCurrent(cache.epoch)) { pending = null; return { kind: 'blocked', code: 'shiying_review_restore_changed' }; }
        const current = await ports.store.getShiyingReviewRun();
        if (!current || current.id !== cache.run.id) { pending = null; return { kind: 'blocked', code: 'shiying_review_task_changed' }; }
        await check(current);
        await protect(cache.epoch, () => ports.store.completeShiyingReviewChunk({ runId: current.id, chunkId: cache.chunkId,
          attempts: cache.attempts, startedAt: cache.startedAt, resultJson: cache.resultJson, completedAt: cache.completedAt })); pending = null;
        const run = (await ports.store.getShiyingReviewRun())!;
        if (run.chunks.every(chunk => chunk.status === 'completed')) return await finish(run, cache.epoch);
        await protect(cache.epoch, () => ports.store.blockShiyingReviewRun({ runId: run.id, errorCode: 'shiying_review_local_resume', at: ports.now() }));
        return { kind: 'progress', progress: progressOf(run) };
      }
      if (finalPending) {
        const cache = finalPending; if (!ports.epochCurrent(cache.epoch)) { finalPending = null; return { kind: 'blocked', code: 'shiying_review_restore_changed' }; }
        const current = await ports.store.getShiyingReviewRun();
        if (current?.id === cache.input.runId) await check(current);
        else if (!await ports.store.getShiyingReviewReceipt(cache.input.receipt.id)) {
          finalPending = null;
          return { kind: 'blocked', code: 'shiying_review_task_changed' };
        }
        const saved = await protect(cache.epoch, () => ports.store.commitShiyingWeeklyReview(cache.input)); finalPending = null;
        return { kind: 'completed', summaryId: saved.summary?.id };
      }
      const run = await ports.store.getShiyingReviewRun(), epoch = ports.captureEpoch();
      targetId = run?.id ?? null; taskEpoch = epoch;
      if (run?.status === 'blocked' && invalidReviewResult(run.lastErrorCode ?? '')) return { kind: 'blocked', code: run.lastErrorCode ?? undefined };
      if (run && epoch !== null && run.lastErrorCode === SHIYING_RESTORE_PAUSED && run.chunks.every(chunk => chunk.status === 'completed'))
        await protect(epoch, () => ports.store.resumeShiyingReviewRun({ runId: run.id, at: ports.now() }));
      if (run && epoch !== null && run.chunks.every(chunk => chunk.status === 'completed')) return await finish(run, epoch);
      return { kind: 'no_material' };
    } catch (error) {
      const code = codeOf(error);
      if (invalidReviewResult(code)) {
        pending = null; finalPending = null;
        if (targetId && taskEpoch !== null && ports.epochCurrent(taskEpoch)) await protect(taskEpoch,
          () => ports.store.blockShiyingReviewRun({ runId: targetId!, errorCode: code, at: ports.now() })).catch(() => undefined);
      }
      return { kind: pending || finalPending ? 'save_pending' : 'blocked', code };
    }
    finally { running = false; changed(); }
  }
  async function weeklyRun(options: { periodStart?: string; automatic?: boolean; regenerate?: boolean; retryConfirmation?: ShiyingReviewRetryConfirmation;
    canRequest?: () => Promise<boolean>; onProgress?: (result: ShiyingWeeklyReviewResult) => void } = {}): Promise<ShiyingWeeklyReviewResult> {
    if (running) return { kind: 'busy' };
    if (pending && !ports.epochCurrent(pending.epoch)) pending = null;
    if (finalPending && !ports.epochCurrent(finalPending.epoch)) finalPending = null;
    if (pending || finalPending) return { kind: 'save_pending' };
    running = true; let current: ShiyingReviewRun | null = null;
    const epoch = ports.captureEpoch();
    try {
      if (epoch === null) return { kind: 'busy', code: 'shiying_review_restore_busy' };
      current = await ports.store.getShiyingReviewRun();
      if (options.retryConfirmation && (!current || current.chunks.every(chunk => chunk.status === 'completed'))
        && (options.retryConfirmation.epoch !== epoch || current?.id !== options.retryConfirmation.runId
        || !current.chunks.some(chunk => chunk.id === options.retryConfirmation!.chunkId && chunk.status !== 'completed'
          && chunk.attempts === options.retryConfirmation!.attempts))) return { kind: 'blocked', code: 'shiying_review_task_changed' };
      if (current?.lastErrorCode === SHIYING_RESTORE_PAUSED && options.automatic)
        return { kind: 'blocked', code: SHIYING_RESTORE_PAUSED, progress: progressOf(current) };
      if (current?.status === 'blocked' && invalidReviewResult(current.lastErrorCode ?? '')) return { kind: 'blocked', code: current.lastErrorCode ?? undefined, progress: progressOf(current) };
      if (current?.chunks.every(chunk => chunk.status === 'completed')) {
        if (current.lastErrorCode === SHIYING_RESTORE_PAUSED)
          await protect(epoch, () => ports.store.resumeShiyingReviewRun({ runId: current!.id, at: ports.now() }));
        return await finish(current, epoch);
      }
      if (ports.chatBusy()) return { kind: 'busy', code: 'shiying_review_chat_busy' };
      const snapshot = await ports.loadConfig({ maxAgeMs: 0, readOnly: true });
      const config = resolveShiyingPickupModelConfig(snapshot);
      const finalPrompt = buildShiyingReviewPrompt(snapshot.profile), readPrompt = buildShiyingReviewPrompt(snapshot.profile, true);
      const promptHash = hash({ finalPrompt, readPrompt });
      if (!current) {
        await ports.settle();
        const week = options.periodStart ? shiyingWeekForDate(options.periodStart) : getShiyingReviewWeek(ports.now());
        if (week.end > getShiyingReviewWeek(ports.now()).end) return { kind: 'blocked', code: 'shiying_review_week_open' };
        if (await ports.hasDrafts(week.start, week.end)) return { kind: 'blocked', code: 'shiying_review_waiting_draft' };
        const materials = await loadMaterials({ periodStart: week.start, periodEnd: week.end });
        const usable = materials.filter(material => material.body.trim() || material.imageNote?.body.trim());
        if (!usable.length && materials.some(material => material.kind === 'record' && material.imageState !== 'none')) return { kind: 'blocked', code: 'shiying_review_waiting_images' };
        const events = usable.length ? await contexts(materials) : [];
        const linked = usable.length === 1 && usable[0].kind === 'entry'
          ? await ports.store.getRelatedShiyingEventIdsForSources([{ kind: 'entry', id: usable[0].id }]) : [];
        const sparse = usable.length === 1 && usable[0].kind === 'entry' && linked.length === 0
          && !events.some(event => event.title && usable[0].body.includes(event.title));
        const plan = planShiyingReview({ periodStart: week.start, periodEnd: week.end, materials, events: sparse ? [] : events, promptHash,
          fits: (text, reading) => !usable.length || sparse || !config || shiyingReviewFits(config.connection, reading ? readPrompt : finalPrompt, text, { kind: 'week', reading }) });
        const id = createShiyingReviewOperationId(plan); const existing = await ports.store.getLatestShiyingReviewReceipt(week.start);
        const summaryId = createShiyingSummaryId({ kind: 'week', periodStartLifeDate: week.start, periodEndLifeDate: week.end });
        const summary = await ports.summary(summaryId);
        if (summary?.status === 'rejected') return { kind: 'blocked', code: 'shiying_review_rejected' };
        if (summary?.payloadVersion === 3 && summary.editedAt !== null && !options.regenerate) return { kind: 'blocked', code: 'shiying_review_human_edited' };
        const periodState = await ports.store.getShiyingReviewPeriodState(week.start, week.end);
        if (!options.regenerate && existing?.basisHash === plan.basisHash) {
          if (periodState?.dirty) await protect(epoch, () => ports.store.reconcileShiyingUnchangedReview({ periodStart: week.start, periodEnd: week.end,
            basisHash: plan.basisHash, expectedMaterials: plan.materials, expectedEvents: plan.events }));
          return { kind: existing.outcome === 'review' ? 'completed' : existing.outcome === 'sparse' ? 'direct' : 'no_material', summaryId: existing.summaryId ?? undefined,
            entryId: existing.outcome === 'sparse' ? usable[0]?.id : undefined };
        }
        if (!usable.length || sparse) {
          await protect(epoch, () => ports.store.commitShiyingWeeklyReview({ runId: null, summary: null, events: [], topics: [], receipt: {
            id, periodStart: week.start, periodEnd: week.end, inputHash: plan.inputHash, basisHash: plan.basisHash, promptHash,
            outcome: sparse ? 'sparse' : 'empty', summaryId: null, completedAt: ports.now() } }));
          return { kind: sparse ? 'direct' : 'no_material', entryId: sparse ? usable[0].id : undefined };
        }
        if (!config) return { kind: 'blocked', code: 'shiying_review_config' };
        plan.contractVersion = 2; plan.expectedSummaryStateHash = summary ? createShiyingSummaryStateHash(summary) : null;
        plan.regenerationIntentId = options.regenerate ? createShiyingEntryId() : null;
        plan.imageCoverage = await runShiyingDatabaseOperation(db => loadShiyingReviewImageCoverageWithDatabase(db, materials));
        const operationId = createShiyingReviewOperationIdV2({ ...plan, kind: 'week', regenerationIntentId: plan.regenerationIntentId });
        const at = ports.now(); const units = plan.chunks.map((refs, index) => ({ id: `shiying-review-unit-v2-${hash({ id: operationId, index, refs }).slice(7)}`,
          runId: operationId, index, stage: plan.direct ? 'final' as const : 'read' as const, status: 'pending' as const,
          payloadJson: JSON.stringify({ refs }), resultJson: null, attempts: 0, startedAt: null, completedAt: null, lastErrorCode: null }));
        if (!plan.direct) units.push({ ...units[0], id: `shiying-review-unit-v2-${hash({ id: operationId, stage: 'final' }).slice(7)}`,
          index: units.length, stage: 'final', payloadJson: JSON.stringify({ refs: plan.refs.map(ref => ref.ref) }) });
        current = { id: operationId, kind: 'week', contractVersion: 2, periodStart: week.start, periodEnd: week.end, inputHash: plan.inputHash, promptHash, status: 'pending', lastErrorCode: null,
          createdAt: at, updatedAt: at, planJson: JSON.stringify(plan), chunks: units };
        await protect(epoch, () => ports.store.createShiyingReviewRun(current!));
      }
      if (!config) return { kind: 'blocked', code: 'shiying_review_config' };
      if (current.promptHash !== promptHash) return { kind: 'blocked', code: 'shiying_review_prompt_changed' };
      const next = current.chunks.find(chunk => chunk.status !== 'completed')!;
      const remoteRetry = next.status === 'in_flight' || current.status === 'blocked' && next.attempts > 0
        && !['shiying_review_capacity_blocked', 'shiying_review_local_resume'].includes(current.lastErrorCode ?? '');
      if (remoteRetry) {
        const token = { epoch, runId: current.id, chunkId: next.id, attempts: next.attempts };
        const consent = options.retryConfirmation;
        if (options.automatic || !consent || consent.epoch !== epoch || consent.runId !== token.runId || consent.chunkId !== token.chunkId || consent.attempts !== token.attempts) return { kind: 'retry_confirmation_required', retryConfirmation: token, progress: progressOf(current) };
      }
      if (current.status === 'blocked' || next.status === 'in_flight') {
        if (options.automatic) return { kind: 'blocked', code: current.lastErrorCode ?? 'shiying_review_interrupted' };
        await protect(epoch, () => ports.store.resumeShiyingReviewRun({ runId: current!.id, at: ports.now() }));
        current = (await ports.store.getShiyingReviewRun())!;
      }
      for (let requests = 0; requests < 2; requests += 1) {
        const { plan, materials, events } = await check(current);
        const chunk = current.chunks.find(chunk => chunk.status !== 'completed')!;
        let refs = (JSON.parse(chunk.payloadJson) as { refs: string[] }).refs;
        if (chunk.stage === 'final' && !plan.direct) {
          const results = current.chunks.filter(chunk => chunk.stage === 'read').map(chunk => JSON.parse(chunk.resultJson!) as ShiyingReviewModelResult);
          refs = [...new Set(results.flatMap(result => [...(result.notes ?? []).flatMap(note => note.sources),
            ...result.events.flatMap(event => event.nodes.flatMap(node => node.sources)), ...result.topics.flatMap(topic => topic.sources)]))];
          if (!refs.length) throw new Error('shiying_review_no_reading_sources');
        }
        const material = chunk.stage === 'read' || plan.direct
          ? buildShiyingReviewMaterial(plan, refs, materials, events, plan.direct ? undefined : { index: chunk.index, total: plan.chunks.length })
          : buildShiyingReviewFinalMaterial(plan, events, current.chunks.filter(chunk => chunk.stage === 'read').map(chunk => chunk.resultJson!));
        const prompt = chunk.stage === 'read' ? readPrompt : finalPrompt;
        const stage = { kind: 'week' as const, reading: chunk.stage === 'read', legacy: current.contractVersion !== 2 };
        if (!shiyingReviewFits(config.connection, prompt, material, stage)) { await protect(epoch, () => ports.store.blockShiyingReviewRun({ runId: current!.id, errorCode: 'shiying_review_capacity_blocked', at: ports.now() })); return { kind: 'blocked', code: 'shiying_review_capacity_blocked', progress: progressOf(current) }; }
        const scheduled = await ports.schedule('shiyingWeeklyReview', 'background', async () => {
          if (ports.chatBusy() || !ports.epochCurrent(epoch) || options.canRequest && !await options.canRequest()) return null;
          const reservation = options.automatic ? await reserveShiyingWeeklyReviewCall(ports.now()) : null;
          if (options.automatic && !reservation) return null;
          let started = false;
          try {
            if (ports.chatBusy() || !ports.epochCurrent(epoch) || options.canRequest && !await options.canRequest()) return null;
            await protect(epoch, () => ports.store.beginShiyingReviewChunk({ runId: current!.id, chunkId: chunk.id, at: ports.now() }));
            const flight = (await ports.store.getShiyingReviewRun())!;
            const unit = flight.chunks.find(item => item.id === chunk.id)!;
            if (ports.chatBusy() || !ports.epochCurrent(epoch) || options.canRequest && !await options.canRequest()) {
              if (ports.epochCurrent(epoch)) await protect(epoch, () => ports.store.resumeShiyingReviewRun({ runId: flight.id, at: ports.now() }));
              return null;
            }
            started = true;
            const raw = await ports.request({ apiKey: config.apiKey, connection: config.connection, prompt, material, stage });
            if (!ports.epochCurrent(epoch)) throw new Error('shiying_review_restore_changed');
            const result = parseShiyingReviewModelResult(raw, { reading: chunk.stage === 'read', refs: plan.refs, visible: refs, events,
              ...(current!.contractVersion === 2 ? { summaryTextLimit: 32000 } : {}) });
            pending = { epoch, run: flight, chunkId: unit.id, attempts: unit.attempts, startedAt: unit.startedAt!, resultJson: JSON.stringify(result), completedAt: Math.max(ports.now(), unit.startedAt!) };
            await check(flight);
            await protect(epoch, () => ports.store.completeShiyingReviewChunk({ runId: flight.id, chunkId: unit.id, attempts: unit.attempts,
              startedAt: unit.startedAt!, resultJson: pending!.resultJson, completedAt: pending!.completedAt })); pending = null;
            return true;
          } finally { if (reservation && !started) await cancelShiyingWeeklyReviewReservation(reservation); }
        });
        if (!scheduled.ok || scheduled.value === null) return { kind: 'progress', progress: progressOf(current) };
        current = (await ports.store.getShiyingReviewRun())!;
        options.onProgress?.({ kind: 'progress', progress: progressOf(current) }); changed();
        if (current.chunks.every(chunk => chunk.status === 'completed')) return await finish(current, epoch);
      }
      return { kind: 'progress', progress: progressOf(current) };
    } catch (error) {
      const code = codeOf(error);
      if (invalidReviewResult(code)) { pending = null; finalPending = null; }
      if (current && epoch !== null && ports.epochCurrent(epoch)) await protect(epoch, () => ports.store.blockShiyingReviewRun({ runId: current!.id, errorCode: code, at: ports.now() })).catch(() => undefined);
      return { kind: pending || finalPending ? 'save_pending' : 'failed', code };
    } finally { running = false; changed(); }
  }
  async function abandon() {
    if (running) throw new Error('shiying_review_busy'); const epoch = ports.captureEpoch(); if (epoch === null) throw new Error('shiying_review_restore_busy');
    const run = await ports.store.getShiyingReviewRun(); if (run) await protect(epoch, () => ports.store.abandonShiyingReviewRun(run.id));
    pending = null; finalPending = null; changed();
  }
  async function checkPeriod(run: ShiyingReviewRun) {
    const plan = JSON.parse(run.planJson) as PeriodReviewPlan & { expectedSummaryStateHash: string | null };
    if (plan.version !== 2 || plan.kind !== run.kind || plan.inputHash !== run.inputHash) throw new Error('shiying_review_plan_invalid');
    const input = await ports.periodInputs(plan.kind, run.periodStart, run.periodEnd);
    assertShiyingPeriodReviewFrozenSources(plan, input);
    return { plan, input };
  }
  const periodCacheFor = (kind: 'month' | 'year') => [...periodPending.values()].find(value => value.run.kind === kind)
    ?? [...periodFinalPending.values()].find(value => value.input.receipt.kind === kind);
  function clearInvalidPeriodCaches() {
    for (const [id, cache] of periodPending) if (!ports.epochCurrent(cache.epoch)) periodPending.delete(id);
    for (const [id, cache] of periodFinalPending) if (!ports.epochCurrent(cache.epoch)) periodFinalPending.delete(id);
  }
  async function finishPeriod(run: ShiyingReviewRun, epoch: number) {
    const { plan, input } = await checkPeriod(run);
    const last = run.chunks.at(-1)!;
    const reading = run.chunks.filter(chunk => chunk.stage === 'read').map(chunk => ({
      visible: (JSON.parse(chunk.payloadJson) as { refs: string[] }).refs, resultJson: chunk.resultJson! }));
    const visible = plan.direct ? plan.chunks[0] : collectShiyingPeriodReviewFinalVisible(plan, reading);
    const result = JSON.parse(last.resultJson!) as PeriodReviewModelResult;
    const review = result.review!;
    const id = createShiyingSummaryId({ kind: plan.kind, periodStartLifeDate: plan.periodStart, periodEndLifeDate: plan.periodEnd });
    const prior = await ports.summary(id); const at = Math.max(ports.now(), run.updatedAt, prior?.updatedAt ?? 0);
    const projection = projectShiyingPeriodReviewSources(plan, review.sources, visible);
    const summary: ShiyingSummaryV3 = { payloadVersion: 3, id, kind: plan.kind, periodStartLifeDate: plan.periodStart, periodEndLifeDate: plan.periodEnd,
      title: review.title, factSummary: review.factSummary, baiyunNote: review.baiyunNote, editedAt: prior?.payloadVersion === 3 ? prior.editedAt : null,
      sourceInvalidated: false, inputHash: run.inputHash, contractVersion: 2, status: 'active', rejectedAt: null,
      presentedAt: prior?.presentedAt ?? null, dirty: createShiyingPeriodReviewMembershipHash(plan.kind, plan.periodStart, plan.periodEnd, input) !== plan.frozenMembershipHash,
      createdAt: prior?.createdAt ?? at, updatedAt: at, ...projection };
    const cached = { epoch, input: { runId: run.id, summary, events: [], topics: [],
      expectedSummaryStateHash: plan.expectedSummaryStateHash ?? null, allowHumanReplacement: plan.regenerationIntentId !== null,
      validateBeforeCommit: async (db: Parameters<typeof loadShiyingPeriodReviewInputsWithDatabase>[0]) => {
        const current = await loadShiyingPeriodReviewInputsWithDatabase(db, plan.kind, plan.periodStart, plan.periodEnd);
        assertShiyingPeriodReviewFrozenSources(plan, current);
        return createShiyingPeriodReviewMembershipHash(plan.kind, plan.periodStart, plan.periodEnd, current) !== plan.frozenMembershipHash;
      }, receipt: { id: run.id, kind: plan.kind, contractVersion: 2 as const, regenerationIntentId: plan.regenerationIntentId,
        periodStart: run.periodStart, periodEnd: run.periodEnd, inputHash: run.inputHash, basisHash: plan.basisHash,
        promptHash: run.promptHash, outcome: 'review' as const, summaryId: id, completedAt: at } } };
    if (!ports.epochCurrent(epoch)) throw new Error('shiying_review_restore_changed');
    periodFinalPending.set(run.id, cached);
    const saved = await protect(epoch, () => ports.store.commitShiyingWeeklyReview(cached.input));
    periodFinalPending.delete(run.id); publishShiyingSummaryChanges();
    return { kind: 'completed' as const, summaryId: saved.summary?.id };
  }
  async function periodRecovery(kind: 'month' | 'year') {
    clearInvalidPeriodCaches();
    if (running) return { kind: 'busy' as const };
    if (periodCacheFor(kind)) return { kind: 'save_pending' as const };
    const run = await ports.store.getShiyingReviewRun(kind); if (!run) return { kind: 'none' as const };
    const progress = progressOf(run);
    if (run.lastErrorCode === SHIYING_RESTORE_PAUSED && run.chunks.every(chunk => chunk.status === 'completed'))
      return { kind: 'blocked' as const, progress, code: SHIYING_RESTORE_PAUSED };
    if (run.chunks.every(chunk => chunk.status === 'completed')) return run.status === 'blocked' && invalidReviewResult(run.lastErrorCode ?? '')
      ? { kind: 'blocked' as const, progress, code: run.lastErrorCode ?? undefined } : { kind: 'finalize' as const, progress };
    const next = run.chunks.find(chunk => chunk.status !== 'completed')!, epoch = ports.captureEpoch();
    if (epoch !== null && (next.status === 'in_flight' || run.status === 'blocked' && next.attempts > 0
      && !['shiying_review_capacity_blocked', 'shiying_review_local_resume'].includes(run.lastErrorCode ?? ''))) return {
      kind: 'retry_confirmation_required' as const, progress, code: run.lastErrorCode ?? 'shiying_review_interrupted',
      retryConfirmation: { epoch, runId: run.id, chunkId: next.id, attempts: next.attempts } };
    return { kind: run.status === 'blocked' ? 'blocked' as const : 'normal' as const, progress, code: run.lastErrorCode ?? undefined };
  }
  async function periodRetryLocal(kind: 'month' | 'year'): Promise<ShiyingWeeklyReviewResult> {
    if (running) return { kind: 'busy' }; running = true;
    clearInvalidPeriodCaches(); let targetId: string | null = null, taskEpoch: number | null = null;
    try {
      const cache = [...periodPending.values()].find(value => value.run.kind === kind);
      if (cache) {
        targetId = cache.run.id; taskEpoch = cache.epoch;
        const current = await ports.store.getShiyingReviewRun(kind);
        if (!current || current.id !== cache.run.id) { periodPending.delete(cache.run.id); return { kind: 'blocked', code: 'shiying_review_task_changed' }; }
        await checkPeriod(current);
        await protect(cache.epoch, () => ports.store.completeShiyingReviewChunk({ runId: current.id, chunkId: cache.chunkId,
          attempts: cache.attempts, startedAt: cache.startedAt, resultJson: cache.resultJson, completedAt: cache.completedAt }));
        periodPending.delete(cache.run.id); const run = (await ports.store.getShiyingReviewRun(kind))!;
        if (run.chunks.every(chunk => chunk.status === 'completed')) return await finishPeriod(run, cache.epoch);
        await protect(cache.epoch, () => ports.store.blockShiyingReviewRun({ runId: run.id, errorCode: 'shiying_review_local_resume', at: ports.now() }));
        return { kind: 'progress', progress: progressOf(run) };
      }
      const final = [...periodFinalPending.values()].find(value => value.input.receipt.kind === kind);
      if (final) {
        targetId = final.input.runId; taskEpoch = final.epoch;
        const current = await ports.store.getShiyingReviewRun(kind);
        if (current?.id === targetId) await checkPeriod(current);
        else if (!await ports.store.getShiyingReviewReceipt(final.input.receipt.id)) {
          periodFinalPending.delete(targetId!); return { kind: 'blocked', code: 'shiying_review_task_changed' };
        }
        const saved = await protect(final.epoch, () => ports.store.commitShiyingWeeklyReview(final.input));
        periodFinalPending.delete(targetId!); publishShiyingSummaryChanges(); return { kind: 'completed', summaryId: saved.summary?.id };
      }
      const run = await ports.store.getShiyingReviewRun(kind), epoch = ports.captureEpoch();
      targetId = run?.id ?? null; taskEpoch = epoch;
      if (run?.status === 'blocked' && invalidReviewResult(run.lastErrorCode ?? '')) return { kind: 'blocked', code: run.lastErrorCode ?? undefined };
      if (run && epoch !== null && run.lastErrorCode === SHIYING_RESTORE_PAUSED && run.chunks.every(chunk => chunk.status === 'completed'))
        await protect(epoch, () => ports.store.resumeShiyingReviewRun({ runId: run.id, at: ports.now() }));
      return run && epoch !== null && run.chunks.every(chunk => chunk.status === 'completed') ? await finishPeriod(run, epoch) : { kind: 'no_material' };
    } catch (error) {
      const code = codeOf(error);
      if (targetId && invalidReviewResult(code)) {
        periodPending.delete(targetId); periodFinalPending.delete(targetId);
        if (taskEpoch !== null && ports.epochCurrent(taskEpoch)) await protect(taskEpoch,
          () => ports.store.blockShiyingReviewRun({ runId: targetId!, errorCode: code, at: ports.now() })).catch(() => undefined);
      }
      return { kind: periodCacheFor(kind) ? 'save_pending' : 'blocked', code };
    } finally { running = false; changed(); }
  }
  async function higherUnfinished(kind: 'month' | 'year') {
    if (pending && !ports.epochCurrent(pending.epoch)) pending = null;
    if (finalPending && !ports.epochCurrent(finalPending.epoch)) finalPending = null;
    clearInvalidPeriodCaches();
    if (pending || finalPending || await ports.store.getShiyingReviewRun('week')) return true;
    return kind === 'year' && (!!periodCacheFor('month') || !!await ports.store.getShiyingReviewRun('month'));
  }
  async function periodRun(kind: 'month' | 'year', options: { periodStart?: string; automatic?: boolean; regenerate?: boolean;
    retryConfirmation?: ShiyingReviewRetryConfirmation; canRequest?: () => Promise<boolean>; onProgress?: (result: ShiyingWeeklyReviewResult) => void }): Promise<ShiyingWeeklyReviewResult> {
    if (running) return { kind: 'busy' };
    clearInvalidPeriodCaches(); if (periodCacheFor(kind)) return { kind: 'save_pending' };
    running = true; let current: ShiyingReviewRun | null = null; const epoch = ports.captureEpoch();
    try {
      if (await higherUnfinished(kind)) return { kind: 'blocked', code: 'shiying_review_waiting_higher' };
      if (epoch === null) return { kind: 'busy', code: 'shiying_review_restore_busy' };
      current = await ports.store.getShiyingReviewRun(kind);
      if (options.retryConfirmation && (!current || current.chunks.every(chunk => chunk.status === 'completed'))
        && (options.retryConfirmation.epoch !== epoch || current?.id !== options.retryConfirmation.runId
        || !current.chunks.some(chunk => chunk.id === options.retryConfirmation!.chunkId && chunk.status !== 'completed'
          && chunk.attempts === options.retryConfirmation!.attempts))) return { kind: 'blocked', code: 'shiying_review_task_changed' };
      if (current?.lastErrorCode === SHIYING_RESTORE_PAUSED && options.automatic)
        return { kind: 'blocked', code: SHIYING_RESTORE_PAUSED, progress: progressOf(current) };
      if (current?.status === 'blocked' && invalidReviewResult(current.lastErrorCode ?? '')) return { kind: 'blocked', code: current.lastErrorCode ?? undefined, progress: progressOf(current) };
      if (current?.chunks.every(chunk => chunk.status === 'completed')) {
        if (current.lastErrorCode === SHIYING_RESTORE_PAUSED)
          await protect(epoch, () => ports.store.resumeShiyingReviewRun({ runId: current!.id, at: ports.now() }));
        return await finishPeriod(current, epoch);
      }
      const configSnapshot = await ports.loadConfig({ maxAgeMs: 0, readOnly: true }), config = resolveShiyingPickupModelConfig(configSnapshot);
      const finalPrompt = buildShiyingPeriodReviewPrompt(configSnapshot.profile, kind), readPrompt = buildShiyingPeriodReviewPrompt(configSnapshot.profile, kind, true);
      const promptHash = hash({ finalPrompt, readPrompt });
      if (!current) {
        await ports.settle();
        const period = options.periodStart ? shiyingPeriodForDate(kind, options.periodStart) : getShiyingLatestClosedPeriod(kind, ports.now());
        if (!period || period.start > period.end || ports.now() < shiyingPeriodReadyAt(kind, period.start)) return { kind: 'blocked', code: 'shiying_review_period_open' };
        if (await ports.hasDrafts(period.start, period.end)) return { kind: 'blocked', code: 'shiying_review_waiting_draft' };
        const input = await ports.periodInputs(kind, period.start, period.end);
        const summaryId = createShiyingSummaryId({ kind, periodStartLifeDate: period.start, periodEndLifeDate: period.end });
        const prior = await ports.summary(summaryId);
        if (prior?.status === 'rejected') return { kind: 'blocked', code: 'shiying_review_rejected' };
        if (prior?.payloadVersion === 3 && prior.editedAt !== null && !options.regenerate) return { kind: 'blocked', code: 'shiying_review_human_edited' };
        const eligibility = shiyingPeriodReviewEligibility(kind, period.start, period.end, input);
        if (eligibility === 'waiting_images') return { kind: 'blocked', code: 'shiying_review_waiting_images' };
        const plan = planShiyingPeriodReview({ ...input, kind, periodStart: period.start, periodEnd: period.end, promptHash,
          regenerationIntentId: options.regenerate ? createShiyingEntryId() : null,
          fits: (material, reading) => eligibility !== 'review' || !config || shiyingReviewFits(config.connection, reading ? readPrompt : finalPrompt, material, { kind, reading }) });
        const operationId = createShiyingReviewOperationIdV2(plan);
        const previous = await ports.store.getLatestShiyingReviewReceipt(period.start, kind);
        if (!options.regenerate && previous?.basisHash === plan.basisHash) {
          const state = await ports.store.getShiyingReviewPeriodState(period.start, period.end, kind);
          if (state?.dirty) await protect(epoch, () => ports.store.reconcileShiyingUnchangedPeriodReview({ kind,
            periodStart: period.start, periodEnd: period.end, basisHash: plan.basisHash,
            validateWithDatabase: async db => {
              const current = await loadShiyingPeriodReviewInputsWithDatabase(db, kind, period.start, period.end);
              assertShiyingPeriodReviewFrozenSources(plan, current);
              if (createShiyingPeriodReviewMembershipHash(kind, period.start, period.end, current) !== plan.frozenMembershipHash) throw new Error('shiying_review_source_changed');
            } }));
          return { kind: previous.outcome === 'review' ? 'completed' : previous.outcome === 'sparse' ? 'direct' : 'no_material', summaryId: previous.summaryId ?? undefined };
        }
        if (eligibility !== 'review') {
          await protect(epoch, () => ports.store.commitShiyingWeeklyReview({ runId: null, summary: null, events: [], topics: [], receipt: {
            id: operationId, kind, contractVersion: 2, regenerationIntentId: plan.regenerationIntentId, periodStart: plan.periodStart, periodEnd: plan.periodEnd,
            inputHash: plan.inputHash, basisHash: plan.basisHash, promptHash, outcome: eligibility, summaryId: null, completedAt: ports.now() } }));
          return { kind: eligibility === 'sparse' ? 'direct' : 'no_material', entryId: eligibility === 'sparse' ? input.facts.find(value => value.kind === 'entry')?.id : undefined };
        }
        if (!config) return { kind: 'blocked', code: 'shiying_review_config' };
        const at = ports.now(); const chunks = plan.chunks.map((refs, index) => ({ id: `shiying-review-unit-v2-${hash({ id: operationId, index, refs }).slice(7)}`,
          runId: operationId, index, stage: plan.direct ? 'final' as const : 'read' as const, status: 'pending' as const,
          payloadJson: JSON.stringify({ refs }), resultJson: null, attempts: 0, startedAt: null, completedAt: null, lastErrorCode: null }));
        if (!plan.direct) chunks.push({ ...chunks[0], id: `shiying-review-unit-v2-${hash({ id: operationId, stage: 'final' }).slice(7)}`,
          index: chunks.length, stage: 'final', payloadJson: JSON.stringify({ refs: [] }) });
        current = { id: operationId, kind, contractVersion: 2, periodStart: period.start, periodEnd: period.end, inputHash: plan.inputHash, promptHash,
          status: 'pending', lastErrorCode: null, createdAt: at, updatedAt: at,
          planJson: JSON.stringify({ ...plan, expectedSummaryStateHash: prior ? createShiyingSummaryStateHash(prior) : null }), chunks };
        await protect(epoch, () => ports.store.createShiyingReviewRun(current!));
      }
      if (!config) return { kind: 'blocked', code: 'shiying_review_config' };
      if (current.promptHash !== promptHash) return { kind: 'blocked', code: 'shiying_review_prompt_changed' };
      const next = current.chunks.find(chunk => chunk.status !== 'completed')!;
      const remoteRetry = next.status === 'in_flight' || current.status === 'blocked' && next.attempts > 0
        && !['shiying_review_capacity_blocked', 'shiying_review_local_resume'].includes(current.lastErrorCode ?? '');
      if (remoteRetry) {
        const token = { epoch, runId: current.id, chunkId: next.id, attempts: next.attempts }, consent = options.retryConfirmation;
        if (options.automatic || !consent || Object.keys(token).some(key => token[key as keyof typeof token] !== consent[key as keyof typeof token]))
          return { kind: 'retry_confirmation_required', retryConfirmation: token, progress: progressOf(current) };
      }
      if (current.status === 'blocked' || next.status === 'in_flight') {
        if (options.automatic) return { kind: 'blocked', code: current.lastErrorCode ?? 'shiying_review_interrupted' };
        await protect(epoch, () => ports.store.resumeShiyingReviewRun({ runId: current!.id, at: ports.now() })); current = (await ports.store.getShiyingReviewRun(kind))!;
      }
      for (let requests = 0; requests < 2; requests++) {
        if (await higherUnfinished(kind)) return { kind: 'progress', code: 'shiying_review_waiting_higher', progress: progressOf(current) };
        const { plan, input } = await checkPeriod(current), chunk = current.chunks.find(value => value.status !== 'completed')!;
        const readResults = current.chunks.filter(value => value.stage === 'read').map(value => ({ visible: JSON.parse(value.payloadJson).refs as string[], resultJson: value.resultJson! }));
        const visible: string[] = chunk.stage === 'final' && !plan.direct ? collectShiyingPeriodReviewFinalVisible(plan, readResults) : JSON.parse(chunk.payloadJson).refs;
        const material = chunk.stage === 'read' || plan.direct ? buildShiyingPeriodReviewMaterial(plan, visible, input.facts, input.lowerReviews, input.events,
          plan.direct ? undefined : { index: chunk.index, total: plan.chunks.length }) : buildShiyingPeriodReviewFinalMaterial(plan, readResults.map(value => value.resultJson));
        const prompt = chunk.stage === 'read' ? readPrompt : finalPrompt, stage = { kind, reading: chunk.stage === 'read' };
        if (!shiyingReviewFits(config.connection, prompt, material, stage)) {
          await protect(epoch, () => ports.store.blockShiyingReviewRun({ runId: current!.id, errorCode: 'shiying_review_capacity_blocked', at: ports.now() }));
          return { kind: 'blocked', code: 'shiying_review_capacity_blocked', progress: progressOf(current) };
        }
        const scheduled = await ports.schedule('shiyingWeeklyReview', 'background', async () => {
          const allowed = async () => !ports.chatBusy() && ports.epochCurrent(epoch) && !await higherUnfinished(kind) && (!options.canRequest || await options.canRequest());
          if (!await allowed()) return null;
          const reservation = options.automatic ? await reserveShiyingWeeklyReviewCall(ports.now(), kind) : null;
          if (options.automatic && !reservation) return null; let started = false;
          try {
            if (!await allowed()) return null;
            await protect(epoch, () => ports.store.beginShiyingReviewChunk({ runId: current!.id, chunkId: chunk.id, at: ports.now() }));
            const flight = (await ports.store.getShiyingReviewRun(kind))!, unit = flight.chunks.find(value => value.id === chunk.id)!;
            if (!await allowed()) { if (ports.epochCurrent(epoch)) await protect(epoch, () => ports.store.resumeShiyingReviewRun({ runId: flight.id, at: ports.now() })); return null; }
            started = true;
            const raw = await ports.request({ apiKey: config.apiKey, connection: config.connection, prompt, material, stage });
            if (!ports.epochCurrent(epoch)) throw new Error('shiying_review_restore_changed');
            const result = parseShiyingPeriodReviewModelResult(raw, { plan, visible, reading: chunk.stage === 'read' });
            const cached = { epoch, run: flight, chunkId: chunk.id, attempts: unit.attempts, startedAt: unit.startedAt!, resultJson: JSON.stringify(result), completedAt: Math.max(ports.now(), unit.startedAt!) };
            periodPending.set(flight.id, cached); await checkPeriod(flight);
            await protect(epoch, () => ports.store.completeShiyingReviewChunk({ runId: flight.id, chunkId: chunk.id, attempts: cached.attempts,
              startedAt: cached.startedAt, resultJson: cached.resultJson, completedAt: cached.completedAt })); periodPending.delete(flight.id);
            return true;
          } finally { if (reservation && !started) await cancelShiyingWeeklyReviewReservation(reservation); }
        });
        if (!scheduled.ok || scheduled.value === null) return { kind: 'progress', progress: progressOf(current) };
        current = (await ports.store.getShiyingReviewRun(kind))!; options.onProgress?.({ kind: 'progress', progress: progressOf(current) }); changed();
        if (current.chunks.every(chunk => chunk.status === 'completed')) return await finishPeriod(current, epoch);
      }
      return { kind: 'progress', progress: progressOf(current) };
    } catch (error) {
      const code = codeOf(error);
      if (current && invalidReviewResult(code)) { periodPending.delete(current.id); periodFinalPending.delete(current.id); }
      if (current && epoch !== null && ports.epochCurrent(epoch)) await protect(epoch, () => ports.store.blockShiyingReviewRun({ runId: current!.id, errorCode: code, at: ports.now() })).catch(() => undefined);
      return { kind: periodCacheFor(kind) ? 'save_pending' : 'failed', code };
    } finally { running = false; changed(); }
  }
  async function run(options: Parameters<typeof weeklyRun>[0] & { kind?: 'week' | 'month' | 'year' } = {}) {
    return options.kind && options.kind !== 'week' ? periodRun(options.kind, options) : weeklyRun(options);
  }
  async function recoveryFor(kind: 'week' | 'month' | 'year' = 'week') { return kind === 'week' ? recovery() : periodRecovery(kind); }
  async function retryFor(kind: 'week' | 'month' | 'year' = 'week') { return kind === 'week' ? retryLocal() : periodRetryLocal(kind); }
  async function abandonFor(kind: 'week' | 'month' | 'year' = 'week') {
    if (kind === 'week') return abandon();
    if (running) throw new Error('shiying_review_busy'); const epoch = ports.captureEpoch(); if (epoch === null) throw new Error('shiying_review_restore_busy');
    const run = await ports.store.getShiyingReviewRun(kind); if (run) await protect(epoch, () => ports.store.abandonShiyingReviewRun(run.id));
    for (const [id, cache] of periodPending) if (cache.run.kind === kind) periodPending.delete(id);
    for (const [id, cache] of periodFinalPending) if (cache.input.receipt.kind === kind) periodFinalPending.delete(id);
    changed();
  }
  return { run, recovery: recoveryFor, retryLocal: retryFor, abandon: abandonFor,
    hasPendingSave: () => pending !== null || finalPending !== null || periodPending.size > 0 || periodFinalPending.size > 0,
    invalidateForRestore: () => { pending = null; finalPending = null; periodPending.clear(); periodFinalPending.clear(); changed(); } };
}
const coordinator = createShiyingReviewCoordinator();
registerShiyingBackupParticipant({ hasPendingSave: coordinator.hasPendingSave, invalidate: coordinator.invalidateForRestore });
export const runShiyingWeeklyReview = coordinator.run;
export const getShiyingReviewRecoveryState = coordinator.recovery;
export const retryShiyingReviewLocalSave = coordinator.retryLocal;
export const abandonShiyingWeeklyReview = coordinator.abandon;
export const runShiyingPeriodReview = coordinator.run;
