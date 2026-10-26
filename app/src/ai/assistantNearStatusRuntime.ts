import { Platform } from 'react-native';
import { loadAssistantState, saveAssistantState, setNearStatusUpdating, type AssistantState } from './assistantState';
import { collectNearStatusMaterials, generateNearStatus, loadNearStatusConversation, nearStatusChatSourceMatches, nearStatusFactsStillMatch, NEAR_STATUS_INTERVAL_MS, type NearStatusSaveResult, type NearStatusOpportunityRef, type NearStatusContinuation } from './assistantNearStatus';
import { loadAssistantLifeDay, listAssistantLifeDays, getLocalDateKey, recordAssistantTimelineEntry, resolveAssistantLifeSegment, getLifeScheduleSlot, saveAssistantLifeDay } from './assistantLifeTimeline';
import { withSleepPlanWrite, readSleepSchedule } from '../life/sleepPlanStore';
import { loadJunluoAffectState, loadJunluoThoughtState, updateJunluoThoughtState } from '../life/junluoInnerStateStore';
import { applyJunluoThoughtBasket, resolveBaiyunPortraitState } from '../life/junluoInnerStateGeneration';
import { createAfterglowKeywordCounterTask } from '../chat/keywordCounterStore';
import { isChatReplyInFlight } from './aiRuntimeScheduler';
import { fingerprintPromptText } from './promptCacheMetrics';
import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { appendAssistantLifeGenerationDiagnostic, updateAssistantLifePersistenceDiagnostic } from './assistantLifeGenerationDiagnostics';
import type { AiConnection, AiProfile } from './types';
import type { NearStatusPaper, NearStatusPart } from './assistantNearStatusPaper';
import { readLatestSleepTransition, sleepTransitionMatches, sleepTransitionConversationKey, isSleepingTransition, type SleepNearStatusTransition } from '../life/sleepExperienceMaterial';
import { sleepWakeTarget } from '../life/sleepPlanPolicy';
import { isQwenChatSourceDeferred, QwenChatSourceInvalid, type QwenChatSource } from './qwenChatLayout';

export type NearStatusPending = {
  chatSource?: QwenChatSource;
  cloudForm?: AssistantState['cloudForm'];
  paper: NearStatusPaper;
  chatKey: string;
  controlKey: string;
  lifeRefs: { id: string; revision: string }[];
  appointmentRefs: { id: string; revision: string }[];
  activityRefs?: { id: string; revision: string }[];
  scheduleRefs?: { id: string; revision: string }[];
  thoughtRef?: { id: string; revision: string; contentRevision: string };
  applied: NearStatusPart[];
};
export type NearStatusRunRecord = {
  schemaVersion: 1;
  updatedAt: number;
  attemptedAt: number;
  generationKey: string;
  materialKey: string;
  sleepTransition?: SleepNearStatusTransition;
  opportunity?: { observedAt: number; refs: Pick<NearStatusOpportunityRef, 'id' | 'revision'>[] };
  outcome: 'started' | 'saved' | 'failed' | 'interrupted';
  pending?: NearStatusPending;
  continuation?: NearStatusContinuation;
};

export function hasNearStatusOpportunity(refs: readonly NearStatusOpportunityRef[], now: number,
  previous: NearStatusRunRecord | undefined, lastAttempt: number) {
  return refs.some(ref => {
    if (!Number.isFinite(ref.occurredAt) || ref.occurredAt <= 0 || ref.occurredAt > now) return false;
    const prior = previous?.opportunity?.refs.find(item => item.id === ref.id);
    return prior ? prior.revision !== ref.revision : ref.occurredAt > (previous?.opportunity?.observedAt ?? lastAttempt);
  });
}

type Input = { apiKey: string; connection: AiConnection; profile: AiProfile; now: number; dataEpoch: number | null; currentState: AssistantState; transitionOnly?: boolean };
const parts: NearStatusPart[] = ['nearStatus', 'thoughtNew', 'thoughtDecision', 'counterIdea'];
let active: Promise<void> | undefined;
let unjournaled: { dateKey: string; record: NearStatusRunRecord; epoch: number | null } | undefined;

async function controlKey() {
  const state = await loadAssistantState();
  const sleep = await readSleepSchedule();
  return JSON.stringify([state.lifeMode, state.manualWakeUntil, state.manualSleepUntil, sleep?.nightKey, sleep?.revision]);
}

async function writeRecord(dateKey: string, epoch: number | null, update: (value?: NearStatusRunRecord) => NearStatusRunRecord | undefined) {
  return withSleepPlanWrite(() => runBackupRestoreDataEpochCommit(epoch, async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const day = await loadAssistantLifeDay(dateKey);
        if (!day || !canCommitBackupRestoreDataEpoch(epoch)) throw new Error('near-status-day-unavailable');
        const next = update(day.nearStatus);
        if (!next) return;
        await saveAssistantLifeDay({ ...day, nearStatus: { ...next, updatedAt: Math.max(Date.now(), (day.nearStatus?.updatedAt ?? 0) + 1) } });
        return;
      } catch (error) { if (attempt === 3 || !canCommitBackupRestoreDataEpoch(epoch)) throw error; }
    }
  }));
}

/** One already parsed paper; tests inject only its storage edges, not another production flow. */
export async function commitNearStatusPaper(pending: NearStatusPending, deps: {
  valid: () => Promise<boolean>;
  apply: (part: NearStatusPart) => Promise<void>;
  mark: (part: NearStatusPart) => Promise<void>;
}) {
  for (const part of parts) {
    if (pending.paper[part] === undefined || pending.applied.includes(part)) continue;
    if (!await deps.valid()) return false;
    for (let attempt = 0; ; attempt++) {
      if (!await deps.valid()) return false;
      try { await deps.apply(part); break; }
      catch (error) {
        // The thought writer owns all four save attempts; never multiply its retries here.
        if (attempt === 3 || part === 'thoughtNew' || part === 'thoughtDecision') throw error;
      }
    }
    // The journal owns four attempts; don't nest mark in the apply retry.
    await deps.mark(part);
    pending.applied.push(part);
  }
  return true;
}

async function resume(dateKey: string, record: NearStatusRunRecord, input: Input) {
  const pending = record.pending!;
  let interruptionReason: string | undefined;
  let visibleTextSaved = pending.applied.includes('nearStatus');
  const invalid = (reason: string) => { interruptionReason = reason; return false; };
  const report = async (status: NearStatusSaveResult['status']): Promise<NearStatusSaveResult> => {
    const result: NearStatusSaveResult = { status, savedParts: [...pending.applied],
      visibleTextSaved: visibleTextSaved ? true : undefined, interruptionReason: status === 'saved' ? undefined : interruptionReason };
    if (canCommitBackupRestoreDataEpoch(input.dataEpoch)) await updateAssistantLifePersistenceDiagnostic(record.generationKey, result).catch(() => undefined);
    return result;
  };
  const allowed = async () => {
    if (!canCommitBackupRestoreDataEpoch(input.dataEpoch)) return invalid('data-epoch-changed');
    if (isChatReplyInFlight()) return invalid('chat-started');
    if (!isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())) return invalid('automatic-calls-disabled');
    return true;
  };
  const sourcesValid = async () => {
    if (record.sleepTransition && Date.now() - record.sleepTransition.at >= NEAR_STATUS_INTERVAL_MS) return invalid('sleep-transition-expired');
    if (isSleepingTransition(record.sleepTransition)) {
      if (await sleepTransitionConversationKey(record.sleepTransition!) !== pending.chatKey) return invalid('chat-source-changed');
      if (((await loadAssistantState()).sleepNearStatus?.recordedAt ?? 0) > record.attemptedAt) return invalid('newer-sleep-status-saved');
    }
    if (((await loadAssistantState()).lifeMode === 'sleeping') !== isSleepingTransition(record.sleepTransition)) return invalid('sleep-state-changed');
    if (record.sleepTransition && !await sleepTransitionMatches(record.sleepTransition)) return invalid('sleep-transition-changed');
    const currentForm = (await loadAssistantState()).cloudForm ?? 'white';
    if (pending.cloudForm && currentForm !== pending.cloudForm && currentForm !== pending.paper.nearStatus?.cloudForm) return invalid('cloud-form-changed');
    if (await controlKey() !== pending.controlKey) return invalid('sleep-arrangement-or-life-mode-changed');
    if (!isSleepingTransition(record.sleepTransition) && !pending.chatSource && (await loadNearStatusConversation()).key !== pending.chatKey) return invalid('chat-source-changed');
    if (pending.chatSource) {
      try { if (!await nearStatusChatSourceMatches(pending.chatSource, pending.chatKey)) return invalid('chat-source-changed'); }
      catch (error) { if (isQwenChatSourceDeferred(error)) throw error; return invalid('chat-source-changed'); }
    }
    if (!await nearStatusFactsStillMatch(pending)) return invalid('life-source-changed');
    if (pending.thoughtRef) {
      const thoughts = await loadJunluoThoughtState();
      const currentThought = thoughts.thoughts.find(t => t.thoughtId === pending.thoughtRef!.id);
      const ownReview = thoughts.recentProcessedOperations.some(op => op.operationId === `${record.generationKey}:review:thought-review`);
      if (ownReview) {
        if (!currentThought || !currentThought.lastTransition?.operationId.startsWith(`${record.generationKey}:review:`)
          || fingerprintPromptText(JSON.stringify([currentThought.createdAt, currentThought.content])) !== pending.thoughtRef.contentRevision) return invalid('thought-source-changed');
      } else if (fingerprintPromptText(JSON.stringify(currentThought ?? null)) !== pending.thoughtRef.revision) return invalid('thought-source-changed');
    }
    return true;
  };
  const finish = async (outcome: NearStatusRunRecord['outcome']) => {
    const finished = await writeRecord(dateKey, input.dataEpoch, current => {
      if (current?.generationKey !== record.generationKey) throw new Error('near-status-journal-changed');
      return { ...current, outcome, pending: undefined };
    });
    if (!finished.committed) { invalid('data-epoch-changed'); throw new Error('near-status-finish-uncommitted'); }
  };
  if (!await allowed()) return report('pending');
  try { if (!await sourcesValid()) { await finish('interrupted'); return report('interrupted'); } }
  catch (error) { if (isQwenChatSourceDeferred(error)) return report('pending'); throw error; }
  const valid = async () => await allowed() && await sourcesValid();
  try {
    const complete = await commitNearStatusPaper(pending, {
      valid,
      apply: async part => {
        if (part === 'nearStatus') {
          const committed = await withSleepPlanWrite(() => runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
            const now = Date.now();
            const day = await loadAssistantLifeDay(getLocalDateKey(new Date(now)));
            if (!day || !await valid()) throw new Error('near-status-stale-before-save');
            const current = await loadAssistantState();
            const affect = await loadJunluoAffectState();
            const sleeping = isSleepingTransition(record.sleepTransition);
            const draft = { ...pending.paper.nearStatus!, moodId: resolveBaiyunPortraitState({ affect, sleeping }) };
            const activeSegment = resolveAssistantLifeSegment(day, now);
            const slot = getLifeScheduleSlot(day, activeSegment, false);
            const night = sleeping ? await loadAssistantLifeDay(record.sleepTransition!.nightKey) : null;
            const plan = night?.nightSleepPlan;
            if (sleeping && !plan) throw new Error('near-status-sleep-plan-missing');
            const sleepAt = plan?.actualSleepAt ?? record.sleepTransition?.at ?? now;
            const wakeAt = plan ? sleepWakeTarget(plan, sleepAt) : now;
            const saved = await saveAssistantState(draft, { ...current, sleepNearStatus: sleeping ? {
              nightKey: record.sleepTransition!.nightKey, slotId: `transition:${record.attemptedAt}`, phase: 'sleeping',
              sleepAt, wakeAt, deepAt: sleepAt + (plan!.nearStatus?.postCount ?? 2) * NEAR_STATUS_INTERVAL_MS,
              preWakeAt: wakeAt - (plan!.nearStatus?.wakeCount ?? 1) * 10 * 60_000,
              recordedAt: record.attemptedAt,
            } : undefined,
              cloudFormDecision: pending.paper.nearStatus?.cloudForm, refreshTextTimestamp: true,
              scheduleSlot: current.scheduleSlot ?? slot, sourceType: sleeping ? 'sleep' : 'self-schedule' });
            visibleTextSaved = true;
            // This records the text actually saved above, even if a source changes immediately afterwards.
            await recordAssistantTimelineEntry(saved, { at: record.attemptedAt, operationId: `${record.generationKey}:visible`,
              source: 'life-segment', segmentId: activeSegment.id, scheduleSlot: slot });
          }));
          if (!committed.committed) { invalid('data-epoch-changed'); throw new Error('near-status-visible-uncommitted'); }
        } else if (part === 'thoughtNew' || part === 'thoughtDecision') {
          // Each field is independent: an invalid decision cannot count as a missed review.
          const updated = await updateJunluoThoughtState((state, retainedThoughtIds) => applyJunluoThoughtBasket({
            retainedThoughtIds,
            state, generationKey: `${record.generationKey}:${part === 'thoughtNew' ? 'new' : 'review'}`,
            now: record.attemptedAt, reviewThoughtId: part === 'thoughtDecision' ? pending.thoughtRef?.id : undefined,
            basket: { new: part === 'thoughtNew' ? pending.paper.thoughtNew ?? null : null,
              decision: part === 'thoughtDecision' ? pending.paper.thoughtDecision ?? null : null },
          }), { dataEpoch: input.dataEpoch, shouldCommit: valid });
          if (!updated) throw new Error('near-status-thought-interrupted');
        } else if (pending.paper.counterIdea) {
          const committed = await runBackupRestoreDataEpochCommit(input.dataEpoch, () => createAfterglowKeywordCounterTask(pending.paper.counterIdea!, {
            generationKey: record.generationKey, now: record.attemptedAt, shouldCommit: valid,
          }));
          if (!committed.committed) throw new Error('near-status-counter-interrupted');
        }
      },
      mark: async part => {
        const marked = await writeRecord(dateKey, input.dataEpoch, current => {
          if (current?.generationKey !== record.generationKey || !current.pending) throw new Error('near-status-journal-changed');
          return { ...current, pending: { ...current.pending, applied: [...new Set([...current.pending.applied, part])] } };
        });
        if (!marked.committed) { invalid('data-epoch-changed'); throw new Error('near-status-mark-uncommitted'); }
      },
    });
    if (complete) { await finish('saved'); return report('saved'); }
    if (await allowed() && !await sourcesValid()) { await finish('interrupted'); return report('interrupted'); }
  } catch {
    // The journal remains. Only local persistence is resumed at the next ordinary check.
    interruptionReason ??= 'local-persistence-failed';
  }
  return report('pending');
}

async function perform(input: Input) {
  if (Platform.OS !== 'android' || !canCommitBackupRestoreDataEpoch(input.dataEpoch)) return;
  if (unjournaled && unjournaled.epoch !== input.dataEpoch) unjournaled = undefined;
  if (unjournaled) {
    if (isChatReplyInFlight()
      || !isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())) return;
    await writeRecord(unjournaled.dateKey, input.dataEpoch, () => unjournaled!.record);
    unjournaled = undefined;
  }
  const today = getLocalDateKey(new Date(input.now));
  const yesterday = new Date(input.now); yesterday.setDate(yesterday.getDate() - 1);
  const days = (await Promise.all([loadAssistantLifeDay(today), loadAssistantLifeDay(getLocalDateKey(yesterday))])).filter(d => d !== null);
  // Locate the latest existing journal after a long shutdown; never scan chat bodies.
  if (!days.some(day => day.nearStatus)) {
    for (const key of await listAssistantLifeDays(90)) {
      if (days.some(day => day.dateKey === key)) continue;
      const older = await loadAssistantLifeDay(key);
      if (older?.nearStatus) { days.push(older); break; }
    }
  }
  for (const day of days) if (day.nearStatus?.pending) {
    if ((await resume(day.dateKey, day.nearStatus, input)).status !== 'interrupted') return;
  }
  if (isChatReplyInFlight()
    || !isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())) return;
  const continuing = days.find(day => day.nearStatus?.continuation);
  if (continuing?.nearStatus?.continuation) {
    const record = continuing.nearStatus;
    await runGeneration(input, continuing.dateKey, {
      ...record.continuation!.materials, scheduleItems: [], scheduleVersions: {}, opportunityRefs: [],
    }, record.sleepTransition, record.opportunity, record);
    return;
  }
  const day = days.find(d => d.dateKey === today);
  if (!day) return;
  const previous = days.flatMap(d => d.nearStatus ? [d.nearStatus] : []);
  // Include the old actual attempt timestamps during data transition, never its retired answer.
  const oldAttempts = days.flatMap(d => d.segments.filter(s => s.generationAttemptKey?.startsWith('near-status:')));
  const lastAttempt = Math.max(0, ...previous.map(r => r.attemptedAt), ...oldAttempts.map(s => s.generationAttemptedAt ?? 0));
  const latest = [...previous].sort((a, b) => b.attemptedAt - a.attemptedAt)[0];
  const transition = (await readLatestSleepTransition(input.now))?.ref;
  const sleepTransition = transition && transition.at > lastAttempt && input.now - transition.at < NEAR_STATUS_INTERVAL_MS
    && isSleepingTransition(transition) === (input.currentState.lifeMode === 'sleeping') ? transition : undefined;
  if ((input.transitionOnly || input.currentState.lifeMode === 'sleeping') && !sleepTransition) return;
  if (sleepTransition?.kind === 'morning_awake') {
    const wake = (await loadAssistantLifeDay(sleepTransition.nightKey))?.nightSleepPlan?.wake;
    if (!wake || wake.status === 'requesting') return;
  }
  let materials: Awaited<ReturnType<typeof collectNearStatusMaterials>>;
  try { materials = await collectNearStatusMaterials(input.now, input.currentState, sleepTransition, input.connection); }
  catch (error) { if (error instanceof QwenChatSourceInvalid || isQwenChatSourceDeferred(error)) return; throw error; }
  const opportunity = { observedAt: input.now,
    refs: materials.opportunityRefs.map(({ id, revision }) => ({ id, revision })) };
  const hasOpportunity = hasNearStatusOpportunity(materials.opportunityRefs, input.now, latest, lastAttempt);
  // Seed an old journal's source baseline without inventing a request or changing its attempt time.
  if (latest && !latest.opportunity && !hasOpportunity) {
    const owner = days.find(item => item.nearStatus?.generationKey === latest.generationKey)!;
    await writeRecord(owner.dateKey, input.dataEpoch, current => current?.generationKey === latest.generationKey
      ? { ...current, opportunity } : undefined);
  }
  if (!sleepTransition && (input.now - lastAttempt < NEAR_STATUS_INTERVAL_MS || !hasOpportunity)) return;
  await runGeneration(input, day.dateKey, materials, sleepTransition, opportunity);
}

async function runGeneration(input: Input, dateKey: string, materials: Awaited<ReturnType<typeof collectNearStatusMaterials>>,
  sleepTransition?: SleepNearStatusTransition, opportunity?: NearStatusRunRecord['opportunity'], previous?: NearStatusRunRecord) {
  let record = previous;
  const generationKey = record?.generationKey ?? `near-status:${materials.materialKey}:${input.now}`;
  const result = await generateNearStatus({ ...input, materials, sleepTransition, generationKey, continuation: record?.continuation,
    onRequestStart: async () => {
      const now = Date.now();
      record = { schemaVersion: 1, attemptedAt: now, updatedAt: now, generationKey: `near-status:${materials.materialKey}:${input.now}`,
        materialKey: materials.materialKey, opportunity, ...(sleepTransition ? { sleepTransition } : {}), outcome: 'started' };
      const written = await writeRecord(dateKey, input.dataEpoch, () => record);
      if (!written.committed) throw new Error('near-status-epoch-changed');
    },
    onContinuation: async continuation => {
      if (!record) throw new Error('near-status-record-missing');
      record = { ...record, continuation };
      unjournaled = { dateKey, record, epoch: input.dataEpoch };
      const written = await writeRecord(dateKey, input.dataEpoch, current => {
        if (current?.generationKey !== record!.generationKey) throw new Error('near-status-journal-changed');
        return { ...current, continuation };
      });
      if (!written.committed) throw new Error('near-status-epoch-changed');
      unjournaled = undefined;
    },
    onTransportAttempt: requests => {
      if (!record) return;
      if (!sleepTransition && requests.some(request => request.transport?.outcome === 'started')) setNearStatusUpdating(true);
      void appendAssistantLifeGenerationDiagnostic({ attemptedAt: record.attemptedAt, contextSource: 'state',
        generationKey: record.generationKey, requestId: record.generationKey, flow: 'near-status', stage: 'request',
        model: input.connection.model, responseFormatRequested: input.connection.chatJsonOutputEnabled === true,
        status: 'failure', requests }).catch(() => undefined);
    },
    save: async (paper, canSave) => {
      if (!record) return { status: 'interrupted', savedParts: [], interruptionReason: 'source-or-control-changed-before-journal' };
      try { if (!await canSave()) return { status: 'interrupted', savedParts: [], interruptionReason: 'source-or-control-changed-before-journal' }; }
      catch (error) { if (!isQwenChatSourceDeferred(error)) throw error; }
      if (!record.pending) record = { ...record, continuation: undefined, pending: { paper, cloudForm: materials.cloudForm, chatKey: materials.chatKey,
        controlKey: await controlKey(), thoughtRef: materials.thoughtRef, chatSource: materials.chatSource,
        lifeRefs: materials.lifeRefs, appointmentRefs: materials.appointmentRefs,
        activityRefs: materials.activityRefs, scheduleRefs: materials.scheduleRefs, applied: [] } };
      unjournaled = { dateKey, record, epoch: input.dataEpoch };
      const written = await writeRecord(dateKey, input.dataEpoch, current => current?.pending ? current : record);
      if (!written.committed) throw new Error('near-status-epoch-changed');
      unjournaled = undefined;
      const latest = (await loadAssistantLifeDay(dateKey))?.nearStatus;
      if (latest?.pending) return resume(dateKey, latest, input);
      return { status: 'pending', savedParts: [], interruptionReason: 'local-journal-unavailable' };
    },
  });
  if (!record || !result.requests) return;
  if (result.status !== 'waiting' && (result.status === 'failure' || result.status === 'handoff' || previous?.continuation && result.interruptionReason
    && !['chat-started', 'automatic-calls-disabled', 'sleep-opportunity-unavailable'].includes(result.interruptionReason))) await writeRecord(dateKey, input.dataEpoch, current =>
    current && !current.pending && (result.status === 'handoff' || current.outcome === 'started')
      ? { ...current, continuation: undefined, outcome: result.status === 'handoff' ? 'saved' : result.interruptionReason ? 'interrupted' : 'failed' } : undefined);
  const saved = (await loadAssistantLifeDay(dateKey))?.nearStatus;
  await appendAssistantLifeGenerationDiagnostic({ attemptedAt: record.attemptedAt, contextSource: 'state', generationKey: record.generationKey,
    requestId: record.generationKey, flow: 'near-status', stage: 'request',
    materialFingerprint: materials.materialKey, model: input.connection.model, responseFormatRequested: input.connection.chatJsonOutputEnabled === true,
    status: saved?.outcome === 'saved' || result.status === 'waiting' && result.requestDiagnostics.at(-1)?.status === 'success' ? 'success' : 'failure',
    failureReason: saved?.outcome === 'saved' ? undefined : result.failureReason,
    interruptionReason: result.interruptionReason,
    persistenceStatus: result.status === 'waiting' ? 'pending' : result.saveResult?.status,
    savedParts: result.saveResult?.savedParts,
    visibleTextSaved: result.saveResult?.visibleTextSaved,
    extraFields: record.pending?.paper.issues,
    requests: result.requestDiagnostics,
  }).catch(() => undefined);
}

export function runAssistantNearStatusUpdate(input: Input) {
  if (!active) active = perform(input).finally(() => { active = undefined; setNearStatusUpdating(false); });
  return active;
}

/** Existing wake/sleep/chat entry points call this after local state is saved, never under their write lease. */
export async function runSleepTransitionNearStatusUpdate(now = Date.now()) {
  if (active) { await active; now = Date.now(); }
  if (Platform.OS !== 'android' || isChatReplyInFlight()
    || !isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())) return;
  const { loadAiConfigPreferencesSnapshot, resolveLifeCreativeConfig } = await import('./AiConfigPreferences');
  const { captureBackupRestoreDataEpoch } = await import('../backup/backupRestoreCoordinator');
  const prefs = await loadAiConfigPreferencesSnapshot();
  const { connection, apiKey } = resolveLifeCreativeConfig(prefs);
  if (!connection || !apiKey?.trim()) return;
  await runAssistantNearStatusUpdate({ apiKey, connection, profile: prefs.profile, now,
    dataEpoch: captureBackupRestoreDataEpoch(), currentState: await loadAssistantState(), transitionOnly: true });
}
