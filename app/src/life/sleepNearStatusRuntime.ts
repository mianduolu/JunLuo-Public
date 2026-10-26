import { Platform } from 'react-native';
import { loadAssistantLifeDay, saveAssistantLifeDay, type AssistantLifeDay } from '../ai/assistantLifeTimeline';
import { loadAssistantState, saveAssistantState } from '../ai/assistantState';
import { loadAiConfigPreferencesSnapshot, resolveLifeCreativeConfig } from '../ai/AiConfigPreferences';
import { isAiCostDeferred, runBudgetedAiCall } from '../ai/aiCallBudget';
import { isChatReplyInFlight } from '../ai/aiRuntimeScheduler';
import { AssistantLifeRequestError, buildAssistantStatePairEnvelope, fetchAssistantLifeCompletion } from '../ai/assistantLifePromptEnvelope';
import { buildAssistantLifeShortJsonRequest } from '../ai/assistantLifeShortJsonRequest';
import { fingerprintPromptText } from '../ai/promptCacheMetrics';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { readRelevantSleepNight, withSleepPlanWrite } from './sleepPlanStore';
import { nightSleepPhaseAt, sleepWakeTarget, sleepWakeAlarmAt } from './sleepPlanPolicy';
import { formatSleepExperience, loadSleepExperienceConversation } from './sleepExperienceMaterial';
import { formatChatAfterglowConversation } from '../chat/chatAfterglowProbe';
import { estimateApiMessagesTokens } from '../chat/contextCompression';
import { reconcileSleepNearStatusSlots, selectSleepNearStatusSlot, sleepNearStatusDisplay, type SleepNearStatusSlot } from './sleepNearStatusPolicy';
import { buildSleepNearStatusFacts, parseSleepNearStatus, SLEEP_NEAR_STATUS_TASKS } from './sleepNearStatusPrompt';
import type { SleepNativeWakeTask } from './sleepNativeWake';
import { appendAssistantLifeGenerationDiagnostic, recordAssistantLifeTransport, updateAssistantLifePersistenceDiagnostic } from '../ai/assistantLifeGenerationDiagnostics';
import type { AssistantLifeTransportDiagnostic } from '../ai/assistantLifeGenerationShared';

let active: Promise<boolean> | null = null;
let unjournaled: { nightKey: string; slotId: string; epoch: number | null; revision: number; draft: NonNullable<SleepNearStatusSlot['draft']> } | null = null;
const previousStateKey = (state: Awaited<ReturnType<typeof loadAssistantState>>, nightKey: string) =>
  state.sleepNearStatus?.nightKey === nightKey ? fingerprintPromptText(JSON.stringify([
    state.sleepNearStatus.slotId, state.sleepNearStatus.recordedAt, state.title, state.activity,
  ])) : 'no-previous-sleep-status';

const changedSleepSinceRequest = (day: AssistantLifeDay | null, slot: SleepNearStatusSlot) =>
  slot.attemptedAt !== undefined && day?.nightSleepPlan?.events?.some(event => event.at > slot.attemptedAt!
    && ['sleep', 'sleep_return', 'poke_awake', 'morning_awake', 'get_up'].includes(event.kind));
const sleepDiagnosticKey = (nightKey: string, slotId: string) => `sleep-near-status:${nightKey}:${slotId}`;
async function sleepSourceKey(day: AssistantLifeDay, state: Awaited<ReturnType<typeof loadAssistantState>>, at: number) {
  const source = await loadSleepExperienceConversation(day, at);
  return source.event ? fingerprintPromptText(JSON.stringify([previousStateKey(state, day.dateKey), source]))
    : previousStateKey(state, day.dateKey);
}

async function retryLocal<T>(write: () => Promise<T>, valid: () => boolean) {
  for (let attempt = 0; ; attempt++) {
    if (!valid()) throw new Error('sleep-near-status-stale');
    try { return await write(); }
    catch (error) { if (attempt === 3 || !valid()) throw error; }
  }
}

export async function ensureSleepNearStatusSlots(day: AssistantLifeDay, now: number, epoch = captureBackupRestoreDataEpoch()) {
  const result = await runBackupRestoreDataEpochCommit(epoch, () => withSleepPlanWrite(async () => {
    const latest = await loadAssistantLifeDay(day.dateKey);
    const plan = latest?.nightSleepPlan;
    if (!latest || !plan || plan.actualWakeAt !== undefined || nightSleepPhaseAt(latest, now) === 'awake') return latest ?? day;
    const nearStatus = reconcileSleepNearStatusSlots({ plan, wakeAt: sleepWakeAlarmAt(latest, now), now });
    if (JSON.stringify(nearStatus) === JSON.stringify(plan.nearStatus)) return latest;
    const updated = { ...latest, sleepPlanUpdatedAt: now, nightSleepPlan: { ...plan, nearStatus } };
    await retryLocal(() => saveAssistantLifeDay(updated), () => canCommitBackupRestoreDataEpoch(epoch));
    return updated;
  }));
  const savedDay = result.committed ? result.value : day;
  if (result.committed && savedDay.nightSleepPlan?.nearStatus) {
    const plan = savedDay.nightSleepPlan, nearStatus = savedDay.nightSleepPlan.nearStatus;
    const state = await loadAssistantState(), metadata = state.sleepNearStatus;
    if (metadata?.nightKey === day.dateKey && nearStatus.slots[metadata.slotId]) {
      const next = sleepNearStatusDisplay(day.dateKey, nearStatus, metadata.slotId,
        plan.actualWakeAt ?? sleepWakeAlarmAt(savedDay, now), metadata.recordedAt);
      if (JSON.stringify(next) !== JSON.stringify(metadata)) await runBackupRestoreDataEpochCommit(epoch, () =>
        retryLocal(async () => {
          const current = await loadAssistantState();
          if (current.sleepNearStatus?.nightKey !== day.dateKey || current.sleepNearStatus.slotId !== metadata.slotId) return current;
          return saveAssistantState(current, { ...current, sleepNearStatus: next });
        }, () => canCommitBackupRestoreDataEpoch(epoch)));
    }
  }
  return savedDay;
}

/** Called only by the existing exclusive restore cleanup; no historical night gets fresh allowance. */
export async function resetSleepNearStatusAfterRestore(nightKey: string, now = Date.now()) {
  await withSleepPlanWrite(async () => {
    const day = await loadAssistantLifeDay(nightKey), plan = day?.nightSleepPlan;
    if (!day || !plan || plan.actualSleepAt === undefined || plan.actualWakeAt !== undefined || nightSleepPhaseAt(day, now) !== 'sleeping') return;
    const wakeAt = sleepWakeAlarmAt(day, now);
    if (wakeAt <= now) return;
    const trusted = plan.nearStatus;
    const state = trusted ?? reconcileSleepNearStatusSlots({ plan, wakeAt, now, random: () => 0 });
    if (!state) return;
    const slots = Object.fromEntries(Object.entries(state.slots).map(([id, slot]) => [id,
      !trusted ? { ...slot, status: 'skipped' as const, draft: undefined }
        : slot.status === 'requesting' && !slot.draft ? { ...slot, status: 'failed' as const }
          : (slot.status === 'pending' || slot.status === 'requesting') && slot.expiresAt <= now
            ? { ...slot, status: 'skipped' as const, draft: undefined } : slot,
    ]));
    await saveAssistantLifeDay({ ...day, sleepPlanUpdatedAt: now,
      nightSleepPlan: { ...plan, nearStatus: { ...state, slots, updatedAt: now } } });
  });
}

export function getSleepNearStatusWakeTasks(day: AssistantLifeDay, now: number): SleepNativeWakeTask[] {
  const plan = day.nightSleepPlan;
  if (!plan?.nearStatus || plan.actualWakeAt !== undefined || nightSleepPhaseAt(day, now) === 'awake') return [];
  return Object.entries(plan.nearStatus.slots).filter(([, slot]) => slot.status === 'pending' && now < slot.expiresAt)
    .map(([id, slot]) => ({ id: `${day.dateKey}:sleep_status:${id}`, nightKey: day.dateKey, phase: 'sleep_status', at: slot.at }));
}

async function patchSlot(nightKey: string, slotId: string, epoch: number | null,
  update: (slot: SleepNearStatusSlot, day: AssistantLifeDay) => SleepNearStatusSlot | null) {
  return retryLocal(async () => {
    const result = await runBackupRestoreDataEpochCommit(epoch, () => withSleepPlanWrite(async () => {
      const day = await loadAssistantLifeDay(nightKey), state = day?.nightSleepPlan?.nearStatus;
      const slot = state?.slots[slotId];
      if (!day?.nightSleepPlan || !state || !slot) return false;
      const next = update(slot, day);
      if (!next) return false;
      await saveAssistantLifeDay({ ...day, sleepPlanUpdatedAt: Date.now(), nightSleepPlan: { ...day.nightSleepPlan,
        nearStatus: { ...state, updatedAt: Date.now(), slots: { ...state.slots, [slotId]: next } } } });
      return true;
    }));
    return result.committed && result.value;
  }, () => canCommitBackupRestoreDataEpoch(epoch));
}

async function validNight(nightKey: string, slotId: string, epoch: number | null, revision: number, now: number) {
  if (!canCommitBackupRestoreDataEpoch(epoch) || isChatReplyInFlight()
    || !isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())) return null;
  const [day, state] = await Promise.all([loadAssistantLifeDay(nightKey), loadAssistantState()]);
  const plan = day?.nightSleepPlan, slot = plan?.nearStatus?.slots[slotId];
  if (!day || !plan || !slot || plan.revision !== revision || nightSleepPhaseAt(day, now) !== 'sleeping'
    || changedSleepSinceRequest(day, slot)
    || state.lifeMode !== 'sleeping' || (state.manualWakeUntil ?? 0) > now
    || now < slot.at || now >= slot.expiresAt || now >= sleepWakeTarget(plan, plan.actualSleepAt ?? day.sleepTargetAt)) return null;
  const ownSaved = state.sleepNearStatus?.nightKey === nightKey && state.sleepNearStatus.slotId === slotId
    && slot.draft?.title === state.title && slot.draft?.activity === state.activity;
  if (!ownSaved && slot.sourceStateKey !== undefined && previousStateKey(state, nightKey) !== slot.sourceStateKey
    && await sleepSourceKey(day, state, slot.attemptedAt ?? now) !== slot.sourceStateKey) return null;
  return { day, state, slot };
}

async function commitDraft(nightKey: string, slotId: string, epoch: number | null) {
  const day = await loadAssistantLifeDay(nightKey), slot = day?.nightSleepPlan?.nearStatus?.slots[slotId];
  if (!slot?.draft || slot.sourceRevision === undefined) return false;
  const valid = () => validNight(nightKey, slotId, epoch, slot.sourceRevision!, Date.now());
  const current = await valid();
  if (!current) {
    // Chat can pause a journal; a real wake/sleep transition retires its earlier sleep body.
    const latest = await loadAssistantLifeDay(nightKey), plan = latest?.nightSleepPlan, state = await loadAssistantState();
    if (changedSleepSinceRequest(latest, slot) || plan?.revision !== slot.sourceRevision || plan?.actualWakeAt !== undefined || plan?.morningAwakeAt !== undefined && latest && nightSleepPhaseAt(latest, Date.now()) === 'awake' || Date.now() >= slot.expiresAt
      || (slot.sourceStateKey !== undefined && state.sleepNearStatus?.slotId !== slotId && previousStateKey(state, nightKey) !== slot.sourceStateKey
        && (!latest || await sleepSourceKey(latest, state, slot.attemptedAt ?? Date.now()) !== slot.sourceStateKey))
      || !isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())) {
      await patchSlot(nightKey, slotId, epoch, value => ({ ...value, status: 'failed', draft: undefined }));
      await updateAssistantLifePersistenceDiagnostic(sleepDiagnosticKey(nightKey, slotId),
        { status: 'interrupted', savedParts: [], interruptionReason: 'sleep-source-invalid' }).catch(() => undefined);
    }
    return false;
  }
  await retryLocal(async () => {
    const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
      const latest = await valid();
      if (!latest?.day.nightSleepPlan?.nearStatus) throw new Error('sleep-near-status-stale');
      const metadata = sleepNearStatusDisplay(nightKey, latest.day.nightSleepPlan.nearStatus, slotId,
        sleepWakeTarget(latest.day.nightSleepPlan, latest.day.nightSleepPlan.actualSleepAt!));
      if (latest.state.sleepNearStatus?.nightKey === nightKey && latest.state.sleepNearStatus.slotId === slotId
        && latest.state.title === slot.draft!.title && latest.state.activity === slot.draft!.activity) return;
      await saveAssistantState({ ...slot.draft!, moodId: 'asleep' }, { ...latest.state,
        lifeMode: 'sleeping', sourceType: 'sleep', sleepNearStatus: metadata });
    });
    if (!result.committed) throw new Error('sleep-near-status-epoch');
  }, () => canCommitBackupRestoreDataEpoch(epoch));
  await updateAssistantLifePersistenceDiagnostic(sleepDiagnosticKey(nightKey, slotId),
    { status: 'pending', savedParts: ['nearStatus'], visibleTextSaved: true }).catch(() => undefined);
  await patchSlot(nightKey, slotId, epoch, value => ({ ...value, status: 'complete', draft: undefined }));
  await updateAssistantLifePersistenceDiagnostic(sleepDiagnosticKey(nightKey, slotId),
    { status: 'saved', savedParts: ['nearStatus'], visibleTextSaved: true }).catch(() => undefined);
  return true;
}

/** One saved night owns every foreground/headless attempt; no timer and no catch-up loop. */
export function runSleepNearStatusUpdate(input: { now?: number; nightKey?: string } = {}): Promise<boolean> {
  if (active) return active;
  active = performUpdate(input).catch(() => {
    console.warn('[sleep-near-status] local-persistence-failure');
    return false;
  }).finally(() => { active = null; });
  return active;
}

async function performUpdate(input: { now?: number; nightKey?: string }): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const now = input.now ?? Date.now(), epoch = captureBackupRestoreDataEpoch();
  const night = input.nightKey ? await loadAssistantLifeDay(input.nightKey) : await readRelevantSleepNight(now);
  if (!night?.nightSleepPlan) return false;
  const day = await ensureSleepNearStatusSlots(night, now, epoch), plan = day.nightSleepPlan!;
  if (!plan.nearStatus) return false;
  if (unjournaled) {
    const result = unjournaled;
    if (!isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())) {
      unjournaled = null;
      await patchSlot(result.nightKey, result.slotId, result.epoch, slot => slot.status === 'requesting'
        ? { ...slot, status: 'failed', draft: undefined } : null);
      await updateAssistantLifePersistenceDiagnostic(sleepDiagnosticKey(result.nightKey, result.slotId),
        { status: 'interrupted', savedParts: [], interruptionReason: 'automatic-calls-disabled' }).catch(() => undefined);
      return false;
    }
    if (result.epoch !== epoch || now >= (plan.nearStatus.slots[result.slotId]?.expiresAt ?? 0)
      || result.nightKey !== day.dateKey || plan.revision !== result.revision) {
      unjournaled = null;
      await updateAssistantLifePersistenceDiagnostic(sleepDiagnosticKey(result.nightKey, result.slotId),
        { status: 'interrupted', savedParts: [], interruptionReason: 'sleep-source-invalid' }).catch(() => undefined);
    }
    else {
      if (!await validNight(result.nightKey, result.slotId, epoch, result.revision, now)) return false;
      await patchSlot(result.nightKey, result.slotId, epoch, slot => slot.status === 'requesting' ? { ...slot, draft: result.draft } : null);
      unjournaled = null;
    }
  }
  const latestPlan = (await loadAssistantLifeDay(day.dateKey))?.nightSleepPlan;
  if (!latestPlan?.nearStatus) return false;
  const pending = Object.entries(latestPlan.nearStatus.slots).find(([, slot]) => slot.draft);
  if (pending) return commitDraft(day.dateKey, pending[0], epoch);
  const selected = selectSleepNearStatusSlot(plan.nearStatus, now);
  if (!selected || !await validNight(day.dateKey, selected[0], epoch, plan.revision, now)) return false;
  const [slotId, slot] = selected;
  const prefs = await loadAiConfigPreferencesSnapshot(), config = resolveLifeCreativeConfig(prefs);
  if (!config.connection || !config.apiKey) return false;
  const { connection, apiKey } = config;
  const generationKey = sleepDiagnosticKey(day.dateKey, slotId);
  const diagnosticContext = { generationKey, requestId: generationKey, flow: 'sleep-status' as const,
    attemptOrdinal: 1, model: connection.model, contextSource: 'state' as const,
    responseFormatRequested: connection.chatJsonOutputEnabled === true };
  let transport: AssistantLifeTransportDiagnostic | undefined;
  let parsedRecorded = false;
  let requested = false;
  const result = await runBudgetedAiCall('sleepNearStatus', 'background', async admission => {
    const current = await validNight(day.dateKey, slotId, epoch, plan.revision, Date.now());
    if (!current) return false;
    const facts = buildSleepNearStatusFacts({ now: Date.now(), nightKey: day.dateKey,
      wakeAt: sleepWakeTarget(plan, plan.actualSleepAt!), phase: slot.phase, previous: current.state });
    const sleepSource = await loadSleepExperienceConversation(current.day, Date.now());
    const sourceKey = await sleepSourceKey(current.day, current.state, Date.now());
    const sleepFact = sleepSource.event ? formatSleepExperience(current.day, sleepSource.event) : '';
    const task = SLEEP_NEAR_STATUS_TASKS[slot.phase];
    const envelope = await buildAssistantStatePairEnvelope({ contextSource: 'assistant-life.state', materialPrompt: facts, profile: prefs.profile });
    const material = [facts, sleepFact].filter(Boolean).join('\n\n');
    const apiMessages = [{ role: 'system' as const, content: envelope.stableSystemPrompt },
      { role: 'system' as const, content: material }, { role: 'system' as const, content: task }];
    if (sleepSource.messages.length) {
      const completeRound = formatChatAfterglowConversation(sleepSource.messages);
      const withRound = apiMessages.map((message, index) => index === 1 ? { ...message, content: `${material}\n\n${completeRound}` } : message);
      if (estimateApiMessagesTokens(withRound) + 700 + 512 <= (connection.contextWindowTokens ?? 65536))
        apiMessages[1] = withRound[1];
    }
    let deferred: unknown;
    try {
      const response = await fetchAssistantLifeCompletion({ connection, apiKey, contextSource: 'assistant-life.state', envelope,
        apiMessagesOverride: apiMessages,
        request: { ...buildAssistantLifeShortJsonRequest(connection, 0.45), max_tokens: 700 },
        timeoutMs: 25_000, userPrompt: task,
        onTransportAttempt: event => { transport = event; return recordAssistantLifeTransport(diagnosticContext, event); },
        onRequestStart: async assertTransportReady => {
          try { await admission.beforeTransport(async () => {
            const latest = await validNight(day.dateKey, slotId, epoch, plan.revision, Date.now());
            if (!latest || await sleepSourceKey(latest.day, latest.state, Date.now()) !== sourceKey) throw new Error('sleep-near-status-stale');
            const claimed = await patchSlot(day.dateKey, slotId, epoch, (value, currentDay) => value.status === 'pending'
              && currentDay.nightSleepPlan?.revision === plan.revision && nightSleepPhaseAt(currentDay, Date.now()) === 'sleeping'
              && Date.now() >= value.at && Date.now() < value.expiresAt
              ? { ...value, status: 'requesting', attemptedAt: Date.now(), sourceRevision: plan.revision,
                sourceStateKey: sourceKey } : null);
            if (!claimed) throw new Error('sleep-near-status-already-used');
            requested = true;
          }, assertTransportReady); } catch (error) { if (isAiCostDeferred(error)) deferred = error; throw error; }
        },
      });
      const draft = parseSleepNearStatus(response.content);
      parsedRecorded = true;
      if (transport) await appendAssistantLifeGenerationDiagnostic({ ...diagnosticContext, stage: 'request',
        attemptedAt: transport.startedAt, status: draft ? 'success' : 'failure',
        ...(!draft ? { failureReason: 'invalid-json' as const } : {}),
        persistenceStatus: draft ? 'pending' : 'interrupted', savedParts: [],
        requests: [{ paper: 'visible', status: draft ? 'success' : 'failure', transport,
          outputChars: response.content.length, finishReason: response.finishReason, ...response.usage }],
      }).catch(() => undefined);
      if (!draft || !await validNight(day.dateKey, slotId, epoch, plan.revision, Date.now())) throw new Error('sleep-near-status-unusable');
      unjournaled = { nightKey: day.dateKey, slotId, epoch, revision: plan.revision, draft };
      const journaled = await patchSlot(day.dateKey, slotId, epoch, (value, currentDay) => value.status === 'requesting'
        && currentDay.nightSleepPlan?.revision === plan.revision ? { ...value, draft } : null);
      unjournaled = null;
      return journaled ? await commitDraft(day.dateKey, slotId, epoch) : false;
    } catch (error) {
      if (deferred) throw deferred;
      if (transport && !parsedRecorded) {
        const reason = error instanceof AssistantLifeRequestError ? error.failureReason : 'aborted';
        await appendAssistantLifeGenerationDiagnostic({ ...diagnosticContext, stage: 'request',
          attemptedAt: transport.startedAt, status: 'failure', failureReason: reason,
          requests: [{ paper: 'visible', status: 'failure', outputChars: 0, transport, reason }],
        }).catch(() => undefined);
      }
      if (requested && !unjournaled) {
        const ended = await patchSlot(day.dateKey, slotId, epoch, value => value.draft ? null : { ...value, status: 'failed' });
        if (ended) await updateAssistantLifePersistenceDiagnostic(generationKey,
          { status: 'interrupted', savedParts: [], interruptionReason: 'sleep-result-unusable' }).catch(() => undefined);
      }
      console.warn('[sleep-near-status] request-or-persistence-failure');
      return false;
    }
  }, { connection: config.connection, dataEpoch: epoch, purpose: 'home-status', shouldRecordSuccess: () => requested });
  return result.ok && result.value;
}
