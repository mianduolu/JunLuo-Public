import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { loadAiConfigPreferencesSnapshot, resolveLifeCreativeConfig } from '../ai/AiConfigPreferences';
import { loadAssistantState, saveAssistantState } from '../ai/assistantState';
import { refreshAssistantLifeState } from '../ai/assistantLife';
import { getLifeScheduleSlot, getLocalDateKey, listAssistantLifeDays, loadAssistantLifeDay, resolveAssistantLifeSegment } from '../ai/assistantLifeTimeline';
import { runBudgetedAiCall } from '../ai/aiCallBudget';
import { isChatReplyInFlight, runScheduledAiCall } from '../ai/aiRuntimeScheduler';
import { type SubjectiveMessage } from '../ai/subjectiveMessages';
import { fingerprintPromptText } from '../ai/promptCacheMetrics';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { appendMessagesToChatSession, loadChatSessionMessage, loadChatStateFast } from '../chat/chatStorage';
import { emitChatMessagesAppended } from '../chat/chatMessageEvents';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { replaceSleepNativeWakeTasks, type SleepNativeWakeTask } from './sleepNativeWake';
import { generateSleepPlan } from './sleepPlanGeneration';
import { runRhythmTick } from './lifeRhythm';
import { localSleepNightKey, pendingSleepTaskAt, sleepWakeAlarmAt, sleepWakeTarget, isNightWakeDecisionPending, parseSleepScheduleTime, formatSleepLocalTime,
  SLEEP_PREPARE_LEAD_MS, type SleepOpportunity, type SleepReplyDraft, type SleepScheduleResult } from './sleepPlanPolicy';
import { captureNearStatusSleepContext, commitSleepScheduleDecision, finishChatSleepTurn, markSleepWakeSettled, readRelevantSleepNight, settleSleepNight, sleepContext, upcomingSleepNights, updateSleepOpportunity,
  loadPendingSleepReply, savePendingSleepReply, discardPendingSleepReply, isPendingSleepReplyCurrent } from './sleepPlanStore';
import { ensureSleepNearStatusSlots, getSleepNearStatusWakeTasks, resetSleepNearStatusAfterRestore, runSleepNearStatusUpdate } from './sleepNearStatusRuntime';

export type { SleepPlanContext } from './sleepPlanPolicy';

export type NearStatusSleepContinuation = {
  context: import('./sleepPlanPolicy').SleepPlanContext;
  expectedRevision: number;
  sessionId: string;
  activeSessionId: string;
  messageKey: string;
  savedResult?: SleepScheduleResult;
  handoff: { nightKey: string; messageId: string; sessionId: string } | null;
};

const RETRY_MS = 60_000;
const NO_CONTEXT_MESSAGE_ID = 'sleep-plan:no-context-message';
let activeTick: Promise<boolean> | null = null;
let activeRequest: AbortController | null = null;
let activeNearStatus: object | null = null;
let pendingReconcile: Promise<unknown> = Promise.resolve();

async function appendSleepMessage(sessionId: string, message: SubjectiveMessage, epoch: number | null, valid: () => Promise<boolean>, reconcileExisting = false,
  writerValid?: (messages: readonly SubjectiveMessage[]) => Promise<boolean>) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!await valid()) throw new Error('sleep-opportunity-stale');
    try {
      if (reconcileExisting) {
        const existing = await loadChatSessionMessage(sessionId, message.id);
        if (existing) {
          if (existing.role !== 'I' || existing.source !== message.source || existing.content !== message.content || existing.createdAt !== message.createdAt) throw new Error('sleep-message-changed');
          return false;
        }
      }
      let alreadySaved = false;
      const saved = await runBackupRestoreDataEpochCommit(epoch, async () => {
        if (!await valid()) throw new Error('sleep-opportunity-stale');
        const chat = await loadChatStateFast({ activeMessageLimit: 0 });
        if (!chat.sessions.some((session) => session.id === sessionId)) throw new Error('sleep-session-gone');
        return appendMessagesToChatSession(sessionId, [message], { activeSessionId: chat.activeSessionId, dataEpoch: epoch ?? undefined,
          ...(writerValid ? { requireActiveSession: true, beforeAppend: async messages => {
            if (!await writerValid(messages)) return false;
            const existing = messages.find(value => value.id === message.id);
            if (!existing) return true;
            if (existing.role !== 'I' || existing.source !== message.source || existing.content !== message.content
              || existing.createdAt !== message.createdAt) throw new Error('sleep-message-changed');
            alreadySaved = true; return false;
          } } : {}),
        });
      });
      if (saved.committed && alreadySaved) return false;
      if (!saved.committed || !saved.value.messages.some((item) => item.id === message.id)) throw new Error('sleep-message-not-saved');
      emitChatMessagesAppended({ sessionId, messages: [message], source: 'proactive-message' });
      return true;
    } catch (error) {
      if (attempt === 3 || !canCommitBackupRestoreDataEpoch(epoch)) throw error;
    }
  }
}

const sleepReplyContextKey = (messages: readonly SubjectiveMessage[], messageId: string) =>
  fingerprintPromptText(JSON.stringify(messages.filter(message => message.id !== messageId).slice(-24)));
const sleepReplyEventsKey = (day: Awaited<ReturnType<typeof loadAssistantLifeDay>>) =>
  fingerprintPromptText(JSON.stringify(day?.nightSleepPlan?.events?.filter(event => event.kind !== 'get_up') ?? []));

async function retainSleepReply(input: { nightKey: string; phase: 'prepare' | 'wake'; sessionId: string;
  activeSessionId: string | null; message: SubjectiveMessage; contextKey: string; epoch: number | null;
  current: () => Promise<boolean> }) {
  const day = await loadAssistantLifeDay(input.nightKey), state = await loadAssistantState();
  const plan = day?.nightSleepPlan, opportunity = plan?.[input.phase];
  if (!plan || !opportunity || opportunity.sessionId !== input.sessionId || opportunity.messageId !== input.message.id) throw new Error('sleep-opportunity-stale');
  const draft: SleepReplyDraft = { version: 1, nightKey: input.nightKey, phase: input.phase,
    sessionId: input.sessionId, activeSessionId: input.activeSessionId, message: input.message,
    revision: plan.revision, requestCount: opportunity.requestCount, contextKey: input.contextKey,
    eventsKey: sleepReplyEventsKey(day), sleepAt: day.sleepTargetAt, wakeAt: sleepWakeTarget(plan, plan.actualSleepAt ?? day.sleepTargetAt),
    originalSleepAt: plan.originalSleepAt, originalWakeAt: plan.originalWakeAt,
    manualWakeUntil: state.manualWakeUntil ?? 0, manualSleepUntil: state.manualSleepUntil ?? 0, hasDecision: !!opportunity.toolResult?.ok };
  await savePendingSleepReply(draft, input.epoch, input.current);
  return draft;
}

async function sleepReplySourcesCurrent(draft: SleepReplyDraft, epoch: number | null, writingMessages?: readonly SubjectiveMessage[]) {
  if (!canCommitBackupRestoreDataEpoch(epoch) || !await isPendingSleepReplyCurrent(draft)) return false;
  const day = await loadAssistantLifeDay(draft.nightKey), plan = day?.nightSleepPlan, opportunity = plan?.[draft.phase];
  if (!day || !plan || plan.revision !== draft.revision || plan.originalSleepAt !== draft.originalSleepAt
    || plan.originalWakeAt !== draft.originalWakeAt || day.sleepTargetAt !== draft.sleepAt
    || sleepWakeTarget(plan, plan.actualSleepAt ?? day.sleepTargetAt) !== draft.wakeAt
    || sleepReplyEventsKey(day) !== draft.eventsKey || opportunity?.sessionId !== draft.sessionId
    || opportunity.messageId !== draft.message.id || opportunity.requestCount !== draft.requestCount) return false;
  const state = await loadAssistantState(), now = Date.now();
  if ((state.manualWakeUntil ?? 0) !== draft.manualWakeUntil || (state.manualSleepUntil ?? 0) !== draft.manualSleepUntil) return false;
  if (draft.phase === 'prepare') {
    if (plan.actualWakeAt !== undefined || now >= draft.wakeAt || !draft.hasDecision && now >= draft.sleepAt) return false;
  } else {
    if (getLocalDateKey(new Date(now)) !== getLocalDateKey(new Date(draft.message.createdAt))) return false;
    if (draft.hasDecision && draft.wakeAt > draft.message.createdAt) {
      if (now >= draft.wakeAt || plan.actualWakeAt !== undefined) return false;
    } else if (plan.actualWakeAt !== undefined && plan.actualWakeAt !== draft.wakeAt) return false;
    const currentNight = await readRelevantSleepNight(now);
    if (currentNight && currentNight.dateKey !== draft.nightKey
      && ((currentNight.nightSleepPlan?.actualSleepAt ?? -Infinity) >= draft.message.createdAt
        || (currentNight.nightSleepPlan?.scheduleChangedAt ?? -Infinity) >= draft.message.createdAt)) return false;
  }
  if (writingMessages) return sleepReplyContextKey(writingMessages, draft.message.id) === draft.contextKey
    && await isPendingSleepReplyCurrent(draft) && canCommitBackupRestoreDataEpoch(epoch);
  const chat = await loadChatStateFast({ activeMessageLimit: 25 });
  const session = chat.sessions.find(value => value.id === draft.sessionId);
  return chat.activeSessionId === draft.activeSessionId && !!session
    && sleepReplyContextKey(session.messages, draft.message.id) === draft.contextKey
    && await isPendingSleepReplyCurrent(draft) && canCommitBackupRestoreDataEpoch(epoch);
}

async function sleepReplyDeliveryCurrent(draft: SleepReplyDraft, epoch: number | null, messages?: readonly SubjectiveMessage[]) {
  return !isChatReplyInFlight() && isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())
    && await sleepReplySourcesCurrent(draft, epoch, messages) && !isChatReplyInFlight()
    && isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy());
}

async function recoverPendingSleepReply(epoch: number | null): Promise<'none' | 'pending' | 'saved'> {
  if (!canCommitBackupRestoreDataEpoch(epoch)) return 'pending';
  const draft = await loadPendingSleepReply();
  if (!draft) return 'none';
  const existing = await loadChatSessionMessage(draft.sessionId, draft.message.id);
  if (existing && (existing.role !== 'I' || existing.source !== draft.message.source || existing.content !== draft.message.content
    || existing.createdAt !== draft.message.createdAt)) { await discardPendingSleepReply(draft); return 'none'; }
  if (!existing && !await sleepReplySourcesCurrent(draft, epoch)) { await discardPendingSleepReply(draft); return 'none'; }
  if (!existing && (isChatReplyInFlight() || !isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy()))) return 'pending';
  try {
    const appended = !existing && await appendSleepMessage(draft.sessionId, draft.message, epoch,
      () => sleepReplyDeliveryCurrent(draft, epoch), true, messages => sleepReplyDeliveryCurrent(draft, epoch, messages));
    if (!await isPendingSleepReplyCurrent(draft)) return 'none';
    const current = await sleepReplySourcesCurrent(draft, epoch);
    if (draft.phase === 'wake' && current && !draft.hasDecision && Date.now() < draft.wakeAt) {
      await runBackupRestoreDataEpochCommit(epoch, () => markSleepWakeSettled(draft.nightKey, Date.now(), draft.revision));
    }
    const receipt = await runBackupRestoreDataEpochCommit(epoch, () => updateSleepOpportunity(draft.nightKey, draft.phase,
      opportunity => opportunity?.sessionId === draft.sessionId && opportunity.messageId === draft.message.id
        && opportunity.requestCount === draft.requestCount ? { ...opportunity, status: 'complete', deliveredAt: Date.now(), retryAt: undefined } : undefined));
    if (!receipt.committed || !receipt.value) return 'pending';
    await discardPendingSleepReply(draft);
    if (appended && draft.phase === 'prepare') await Notifications.scheduleNotificationAsync({ identifier: draft.message.id,
      content: { title: '白云小姐', body: draft.message.content, data: { kind: 'proactive-message' } }, trigger: null }).catch(() => undefined);
    return 'saved';
  } catch { return 'pending'; }
}

/** The one full replacement includes sleep, unified contact and reading alarms. */
export function reconcileSleepPlan(now = Date.now(), epoch = captureBackupRestoreDataEpoch(), requestTransition = false) {
  return reconcileSleepPlanLocally(now, epoch).then(() => runBackupRestoreDataEpochCommit(epoch, async () => {
    const state = await refreshAssistantLifeState({ now, afterSleepPlanChange: true });
    await runRhythmTick({ now, manualOverrideStartedAt: state.updatedAt,
      manualSleepUntil: state.manualSleepUntil, manualWakeUntil: state.manualWakeUntil });
  })).then(() => requestTransition && canCommitBackupRestoreDataEpoch(epoch) ? refreshTransitionNearStatus() : undefined);
}

async function refreshTransitionNearStatus() {
  if (activeTick || activeRequest || activeNearStatus) return;
  const plan = (await readRelevantSleepNight())?.nightSleepPlan;
  // Wake choice owns the intermediate awake fact. Show its actual final choice, not a draft mid-tool.
  if (plan?.morningAwakeAt !== undefined && plan.actualWakeAt === undefined
    && (!plan.wake || plan.wake.status === 'requesting')) return;
  await (await import('../ai/assistantNearStatusRuntime')).runSleepTransitionNearStatusUpdate().catch(() => undefined);
}

/** Native writes finish their queue before any caller waits on a life refresh. */
export function reconcileSleepPlanLocally(now = Date.now(), epoch = captureBackupRestoreDataEpoch()) {
  const task = pendingReconcile.then(() => runBackupRestoreDataEpochCommit(epoch, () => performReconcileSleepPlan(now)));
  pendingReconcile = task.catch(() => undefined);
  return task.then(() => undefined);
}

async function performReconcileSleepPlan(now: number) {
  if (Platform.OS !== 'android') return;
  const prior = await readRelevantSleepNight(now), plan = prior?.nightSleepPlan, wake = plan?.wake;
  // Recover a delivered choice before the local deadline can close the unfinished night.
  // Read outside the sleep writer; an unreadable source must not become a missing reply.
  if (prior && plan && plan.actualWakeAt === undefined && plan.morningAwakeAt !== undefined
    && wake?.status === 'complete' && wake.sessionId && wake.messageId
    && !wake.toolResult?.ok && plan.lastMessageId !== wake.messageId) {
    const saved = await loadChatSessionMessage(wake.sessionId, wake.messageId);
    if (saved?.id === wake.messageId && saved.role === 'I' && saved.source === 'proactive-message'
      && saved.createdAt >= plan.morningAwakeAt && saved.createdAt <= now
      && (plan.scheduleChangedAt ?? -Infinity) < saved.createdAt) {
      const pending = await loadPendingSleepReply();
      const confirmedAt = pending?.phase === 'wake' && pending.nightKey === prior.dateKey
        && pending.message.id === saved.id && !pending.hasDecision
        && now < sleepWakeTarget(plan, plan.actualSleepAt ?? prior.sleepTargetAt) ? now : saved.createdAt;
      await markSleepWakeSettled(prior.dateKey, confirmedAt, plan.revision);
    }
  }
  const interrupted = plan?.pendingSleep;
  if (interrupted && interrupted.turnEndedAt === undefined && !isChatReplyInFlight()
    && !(await import('../chat/chatSleepSchedule')).isLiveChatSleepTurn(interrupted.sessionId, interrupted.turnId)) {
    await finishChatSleepTurn({ sessionId: interrupted.sessionId, turnId: interrupted.turnId, now });
  }
  await settleSleepNight(now);
  const days = await upcomingSleepNights(now);
  const tasks: SleepNativeWakeTask[] = [];
  for (const sourceDay of days) {
    const day = await ensureSleepNearStatusSlots(sourceDay, now);
    const plan = day.nightSleepPlan!;
    tasks.push(...getSleepNearStatusWakeTasks(day, now));
    if (!plan.pendingSleep && !plan.prepare && !plan.prepareStatus && now < day.sleepTargetAt) {
      tasks.push({ id: `${day.dateKey}:prepare`, at: day.sleepTargetAt - SLEEP_PREPARE_LEAD_MS, nightKey: day.dateKey, phase: 'prepare' });
    }
    if (!plan.pendingSleep && plan.prepare?.status === 'retry' && plan.prepare.retryAt !== undefined && now < day.sleepTargetAt) {
      tasks.push({ id: `${day.dateKey}:prepare_retry`, at: plan.prepare.retryAt, nightKey: day.dateKey, phase: 'prepare_retry' });
    }
    const sleepAt = pendingSleepTaskAt(plan) ?? day.sleepTargetAt;
    if (sleepAt > now && (plan.pendingSleep || plan.actualSleepAt === undefined)) tasks.push({ id: `${day.dateKey}:sleep`, at: sleepAt, nightKey: day.dateKey, phase: 'sleep' });
    const wakeAt = sleepWakeAlarmAt(day, now);
    if (wakeAt > now && !plan.actualWakeAt) tasks.push({ id: `${day.dateKey}:wake`, at: wakeAt, nightKey: day.dateKey, phase: 'wake' });
  }
  const { getNextUnifiedContactAt } = await import('../proactive/unifiedContactDispatch');
  const contactAt = await getNextUnifiedContactAt(now);
  if (contactAt !== null && Number.isFinite(contactAt) && contactAt > 0) {
    tasks.push({ id: 'unified-contact', at: contactAt, nightKey: getLocalDateKey(new Date(contactAt)), phase: 'unified_contact' });
  }
  const readingTask = await (await import('./readingActivityRuntime')).getReadingActivityWakeTask(now);
  if (readingTask) tasks.push(readingTask);
  const dayPlanTask = await (await import('./ownDayPlanRuntime')).getOwnDayPlanWakeTask(now);
  if (dayPlanTask) tasks.push(dayPlanTask);
  const activityAt = await (await import('../schedule/ownScheduleExecution')).getOwnScheduleWakeAt(now);
  if (activityAt !== null) tasks.push({ id: 'own-schedule-activity', at: activityAt,
    nightKey: getLocalDateKey(new Date(activityAt)), phase: 'activity_start' });
  await replaceSleepNativeWakeTasks(tasks);
}

async function applyNearStatusSleepLocally(nightKey: string, epoch: number | null) {
  const now = Date.now();
  await runBackupRestoreDataEpochCommit(epoch, async () => {
    await settleSleepNight(now);
    const night = await loadAssistantLifeDay(nightKey);
    const plan = night?.nightSleepPlan;
    let state = await loadAssistantState();
    if (night && plan?.actualSleepAt !== undefined && plan.actualWakeAt === undefined
      && now < sleepWakeTarget(plan, plan.actualSleepAt) && (state.manualWakeUntil ?? 0) <= now) {
      const day = await loadAssistantLifeDay(getLocalDateKey(new Date(now))) ?? night;
      const segment = resolveAssistantLifeSegment(day, now);
      const scheduleSlot = getLifeScheduleSlot(day, segment, false);
      if (segment.lifeMode === 'sleeping' && (state.lifeMode !== 'sleeping' || state.scheduleSlot !== scheduleSlot)) state = await saveAssistantState(state, {
        ...state, lifeMode: 'sleeping', sourceType: 'sleep', scheduleSlot,
      });
    }
    await runRhythmTick({ now, manualOverrideStartedAt: state.updatedAt,
      manualSleepUntil: state.manualSleepUntil, manualWakeUntil: state.manualWakeUntil });
  });
  await reconcileSleepPlanLocally(now, epoch);
}

/** One near-status lifecycle shares C's opportunity; its caller owns both HTTP requests. */
export async function createNearStatusSleepOpportunity(input: {
  now?: number; operationId: string; epoch: number | null; signal: AbortSignal;
  resume?: NearStatusSleepContinuation;
  receivedHandoff?: boolean;
}) {
  if (activeTick || activeNearStatus || input.signal.aborted || !canCommitBackupRestoreDataEpoch(input.epoch)) return null;
  if (await recoverPendingSleepReply(input.epoch) !== 'none') return null;
  if (activeTick || activeNearStatus || input.signal.aborted || !canCommitBackupRestoreDataEpoch(input.epoch)) return null;
  const owner = {};
  activeNearStatus = owner;
  try {
    const captured = input.resume ? { committed: true, value: input.resume.context }
      : await runBackupRestoreDataEpochCommit(input.epoch, () => captureNearStatusSleepContext(input.now ?? Date.now()));
    const context = captured.committed ? captured.value : null;
    if (!context) { activeNearStatus = null; return null; }
    const chat = await loadChatStateFast({ activeMessageLimit: 25 });
    const session = chat.sessions.find((item) => item.id === (input.resume?.sessionId ?? chat.activeSessionId));
    if (!session) { activeNearStatus = null; return null; }
    const messageId = `sleep-plan:${context.nightKey}:prepare`;
    const activeSessionId = input.resume?.activeSessionId ?? chat.activeSessionId;
    const messageKey = input.resume?.messageKey ?? sleepReplyContextKey(session.messages, messageId);
    let expectedRevision = input.resume?.expectedRevision ?? context.revision;
    let savedResult = input.resume?.savedResult;
    let handoff = input.resume?.handoff ?? null;
    let handoffStarted = false;
    let finished = false;
    let disposed = false;
    const canContinue = async () => {
      if (disposed || activeNearStatus !== owner || input.signal.aborted || !canCommitBackupRestoreDataEpoch(input.epoch)
        || isChatReplyInFlight() || !isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())) return false;
      const latestChat = await loadChatStateFast({ activeMessageLimit: 25 });
      if (latestChat.activeSessionId !== activeSessionId
        || sleepReplyContextKey(latestChat.sessions.find((item) => item.id === session.id)?.messages ?? [], messageId) !== messageKey) return false;
      const latest = await loadAssistantLifeDay(context.nightKey);
      const state = await loadAssistantState();
      return latest?.nightSleepPlan?.revision === expectedRevision && latest.nightSleepPlan.actualWakeAt === undefined
        && (state.manualWakeUntil ?? 0) <= Date.now() && (state.manualSleepUntil ?? 0) <= Date.now()
        && (!!savedResult?.ok || state.lifeMode !== 'sleeping' && Date.now() < latest.sleepTargetAt);
    };
    const update = (fn: (current: SleepOpportunity | undefined) => SleepOpportunity | undefined) =>
      runBackupRestoreDataEpochCommit(input.epoch, () => updateSleepOpportunity(context.nightKey, 'prepare', fn));
    const reconcileReceivedDecision = async (values: Record<string, unknown>, callId: string): Promise<SleepScheduleResult | null> => {
      if (savedResult?.ok) return savedResult;
      const latest = await loadAssistantLifeDay(context.nightKey), plan = latest?.nightSleepPlan;
      const event = plan?.events?.find(value => value.id === `schedule:${input.operationId}` && value.kind === 'schedule'
        && value.toolCallId === input.operationId && value.turnId === input.operationId && value.sessionId === undefined);
      if (!latest || !plan || !event || plan.lastMessageId !== input.operationId || expectedRevision !== context.revision
        || plan.revision !== expectedRevision + 1 || plan.scheduleChangedAt !== event.at || event.at < context.requestAt
        || plan.originalSleepAt !== context.originalSleepAt || plan.originalWakeAt !== context.originalWakeAt
        || plan.actualWakeAt !== undefined || Object.keys(values).some(key => key !== 'sleepAt' && key !== 'wakeAt')
        || values.sleepAt === undefined && values.wakeAt === undefined) return null;
      const sleep = values.sleepAt === undefined ? context.currentSleepAt : parseSleepScheduleTime(values.sleepAt);
      const wake = values.wakeAt === undefined ? undefined : parseSleepScheduleTime(values.wakeAt);
      if (sleep === null || wake === null) return null;
      const expectedSleep = values.sleepAt === undefined ? sleep : Math.max(event.at, sleep);
      if (latest.sleepTargetAt !== expectedSleep || event.sleepAt !== undefined && event.sleepAt !== expectedSleep
        || values.wakeAt === undefined && event.wakeAt !== undefined
        || wake !== undefined && sleepWakeTarget(plan, plan.actualSleepAt ?? expectedSleep) !== Math.max(event.at, wake)) return null;
      if (expectedSleep <= event.at && (plan.actualSleepAt !== expectedSleep || !plan.events?.some(value =>
        value.kind === 'sleep' && value.toolCallId === input.operationId && value.turnId === input.operationId && value.at === expectedSleep))) return null;
      savedResult = { subject: 'I', ok: true, status: 'applied', sleepAt: formatSleepLocalTime(latest.sleepTargetAt),
        wakeAt: formatSleepLocalTime(sleepWakeTarget(plan, plan.actualSleepAt ?? latest.sleepTargetAt)) };
      expectedRevision = plan.revision;
      if (!await canContinue()) { savedResult = undefined; expectedRevision = context.revision; return null; }
      if (values.sleepAt !== undefined && latest.sleepTargetAt <= Date.now()
        && !session.messages.some(message => message.id === messageId)) {
        const claimed = await update(current => current?.toolCall?.callId === callId && current.sessionId === session.id && current.messageId === messageId
          ? current : current || latest.nightSleepPlan!.prepareStatus ? undefined : {
            status: 'requesting', requestCount: 0, retryUsed: true, sessionId: session.id, messageId,
            contextMessageId: session.messages.at(-1)?.id ?? NO_CONTEXT_MESSAGE_ID, toolResult: savedResult,
            toolCall: { callId, input: values },
          });
        if (claimed.committed && claimed.value) handoff = { nightKey: context.nightKey, messageId, sessionId: session.id };
      }
      await applyNearStatusSleepLocally(context.nightKey, input.epoch).catch(() => undefined);
      return savedResult;
    };
    const finishHandoff = async (content?: string, received = false) => {
      if (!handoff || finished) return false;
      if ((received || input.receivedHandoff) && content?.trim()) {
        // This is adoption of an already paid answer, never a second request claim.
        if (!await canContinue()) {
          await update(current => current && { ...current, status: 'failed', retryAt: undefined });
          finished = true; return false;
        }
        const night = await loadAssistantLifeDay(context.nightKey);
        const prepare = night?.nightSleepPlan?.prepare;
        if (handoff.nightKey !== context.nightKey || handoff.sessionId !== session.id || handoff.messageId !== messageId
          || !savedResult?.ok || !prepare?.toolResult?.ok || prepare.requestCount !== 1
          || prepare.sessionId !== session.id || prepare.messageId !== messageId
          || !['requesting', 'complete'].includes(prepare.status)) { finished = true; return false; }
        const existing = await loadChatSessionMessage(session.id, messageId);
        if (existing && (existing.role !== 'I' || existing.source !== 'proactive-message' || existing.content !== content.trim())) {
          finished = true; return false;
        }
        const message: SubjectiveMessage = existing ?? { id: messageId, role: 'I', content: content.trim(),
          createdAt: Date.now(), source: 'proactive-message' };
        const retained = !existing ? await retainSleepReply({ nightKey: context.nightKey, phase: 'prepare', sessionId: session.id,
          activeSessionId, message, contextKey: messageKey, epoch: input.epoch, current: canContinue }) : undefined;
        const terminal = await update(current => current?.requestCount === 1 && current.sessionId === session.id
          && current.messageId === messageId && ['requesting', 'complete'].includes(current.status)
          ? { ...current, status: 'complete', retryAt: undefined } : undefined);
        if (!terminal.committed || !terminal.value) return false;
        const appended = !existing && await appendSleepMessage(session.id, message, input.epoch, canContinue, true,
          retained ? messages => sleepReplyDeliveryCurrent(retained, input.epoch, messages) : undefined);
        const delivered = await update(current => current?.status === 'complete' && current.requestCount === 1
          && current.sessionId === session.id && current.messageId === messageId
          ? { ...current, deliveredAt: message.createdAt } : undefined);
        if (!delivered.committed || !delivered.value) return false;
        if (retained) await discardPendingSleepReply(retained);
        finished = true;
        if (appended) await Notifications.scheduleNotificationAsync({ identifier: messageId,
          content: { title: '白云小姐', body: message.content, data: { kind: 'proactive-message' } }, trigger: null }).catch(() => undefined);
        return true;
      }
      finished = true;
      try {
        if (!content?.trim() || !handoffStarted || !await canContinue()) {
          await update((current) => current && { ...current, status: 'failed', retryAt: undefined });
          return false;
        }
        const message: SubjectiveMessage = { id: messageId, role: 'I', content: content.trim(),
          createdAt: Date.now(), source: 'proactive-message' };
        const retained = await retainSleepReply({ nightKey: context.nightKey, phase: 'prepare', sessionId: session.id,
          activeSessionId, message, contextKey: messageKey, epoch: input.epoch, current: canContinue });
        const terminal = await update((current) => current && { ...current, status: 'complete', retryAt: undefined });
        if (!terminal.committed || !terminal.value) return false;
        await appendSleepMessage(session.id, message, input.epoch, canContinue, true,
          messages => sleepReplyDeliveryCurrent(retained, input.epoch, messages));
        let recorded = false;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try { await update((current) => current && { ...current, deliveredAt: message.createdAt }); recorded = true; break; }
          catch { if (attempt === 3 || !canCommitBackupRestoreDataEpoch(input.epoch)) break; }
        }
        if (recorded) await discardPendingSleepReply(retained);
        await Notifications.scheduleNotificationAsync({ identifier: messageId,
          content: { title: '白云小姐', body: message.content, data: { kind: 'proactive-message' } }, trigger: null }).catch(() => undefined);
        return true;
      } catch {
        await update((current) => current && current.status !== 'complete'
          ? { ...current, status: 'failed', retryAt: undefined } : undefined).catch(() => undefined);
        return false;
      }
    };
    return {
      context, canContinue, reconcileReceivedDecision,
      snapshot: (): NearStatusSleepContinuation => ({ context, expectedRevision, sessionId: session.id,
        activeSessionId, messageKey, savedResult, handoff }),
      get handoff() { return handoff; },
      commit: async (values: Record<string, unknown>, callId: string): Promise<SleepScheduleResult> => {
        if (!await canContinue()) throw new Error('near-status-sleep-stale');
        if (savedResult?.ok) return savedResult;
        if (Object.keys(values).some((key) => key !== 'sleepAt' && key !== 'wakeAt')) throw new Error('invalid-sleep-tool-input');
        const committed = await runBackupRestoreDataEpochCommit(input.epoch, async () => {
          if (!await canContinue()) throw new Error('near-status-sleep-stale');
          const result = await commitSleepScheduleDecision({ ...values, context: { ...context, revision: expectedRevision },
            messageId: input.operationId, phase: 'near-status' });
          if (result.ok) {
            savedResult = result;
            const latest = await loadAssistantLifeDay(context.nightKey);
            expectedRevision = latest!.nightSleepPlan!.revision;
            if (values.sleepAt !== undefined && latest!.sleepTargetAt <= Date.now()
              && !session.messages.some((message) => message.id === messageId)) {
              const claimed = await updateSleepOpportunity(context.nightKey, 'prepare', (current, day) =>
                current || day.nightSleepPlan!.prepareStatus ? undefined : {
                  status: 'requesting', requestCount: 0, retryUsed: true, sessionId: session.id, messageId,
                  contextMessageId: session.messages.at(-1)?.id ?? NO_CONTEXT_MESSAGE_ID, toolResult: result, toolCall: { callId, input: values },
                }).catch(() => null);
              if (claimed) handoff = { nightKey: context.nightKey, messageId, sessionId: session.id };
            }
          }
          return result;
        });
        if (!committed.committed) throw new Error('near-status-sleep-epoch-stale');
        if (committed.value.ok) await applyNearStatusSleepLocally(context.nightKey, input.epoch).catch(() => undefined);
        return committed.value;
      },
      onHandoffRequestStart: async () => {
        if (!handoff || handoffStarted || finished || !await canContinue()) throw new Error('near-status-handoff-stale');
        const counted = await update((current) => current?.status === 'requesting' && current.requestCount === 0
          ? { ...current, requestCount: 1 } : undefined);
        if (!counted.committed || !counted.value) throw new Error('near-status-handoff-request-limit');
        handoffStarted = true;
      },
      finishHandoff,
      dispose: async (waiting = false) => {
        if (disposed) return;
        try { if (!waiting) await finishHandoff(); }
        finally {
          disposed = true;
          if (activeNearStatus === owner) activeNearStatus = null;
          await applyNearStatusSleepLocally(context.nightKey, input.epoch).catch(() => undefined);
          // The current third paper must release its owner before the transition paper can run.
          if (!waiting) void refreshTransitionNearStatus().catch(() => undefined);
        }
      },
    };
  } catch (error) {
    if (activeNearStatus === owner) activeNearStatus = null;
    throw error;
  }
}

export async function runSleepPlanTick(options: { now?: number; allowRequest?: boolean; scheduledWakeNight?: string } = {}): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  // Local deadlines do not wait for a near-status or sleep-decision network owner.
  const now = options.now ?? Date.now();
  const before = await readRelevantSleepNight(now);
  await reconcileSleepPlan(now);
  const after = await readRelevantSleepNight(now);
  if (!options.scheduledWakeNight && before?.dateKey === after?.dateKey
    && before?.nightSleepPlan?.morningAwakeAt === undefined && after?.nightSleepPlan?.morningAwakeAt === now
    && !after.nightSleepPlan.wake) options = { ...options, scheduledWakeNight: after.dateKey };
  if (activeNearStatus) return false;
  if (activeTick) return activeTick;
  activeTick = (async () => {
    const recovered = await recoverPendingSleepReply(captureBackupRestoreDataEpoch());
    return recovered === 'none' ? performSleepPlanTick(options) : recovered === 'saved';
  })().finally(async () => {
    activeTick = null;
    if (options.allowRequest !== false) await refreshTransitionNearStatus();
  });
  return activeTick;
}

async function performSleepPlanTick(options: { now?: number; allowRequest?: boolean; scheduledWakeNight?: string }) {
  const now = options.now ?? Date.now();
  const epoch = captureBackupRestoreDataEpoch();
  const initialized = await runBackupRestoreDataEpochCommit(epoch, async () => {
    const days = await upcomingSleepNights(now);
    await settleSleepNight(now);
    for (const previous of days) {
      const plan = previous.nightSleepPlan!;
      const target = sleepWakeTarget(plan, plan.actualSleepAt ?? previous.sleepTargetAt);
      const awakeChoiceDue = isNightWakeDecisionPending(previous, now);
      if (previous.dateKey !== options.scheduledWakeNight && !plan.actualWakeAt && (now >= target || awakeChoiceDue)) {
        await updateSleepOpportunity(previous.dateKey, 'wake', (current) => ({ ...current,
          requestCount: current?.requestCount ?? 0, status: current?.status === 'complete' ? 'complete' : 'skipped' }));
        if (now >= target) await markSleepWakeSettled(previous.dateKey, target, plan.revision);
      }
    }
    return days;
  });
  if (!initialized.committed) return false;
  const key = options.scheduledWakeNight ?? (await readRelevantSleepNight(now))?.dateKey ?? localSleepNightKey(now);
  let day = await loadAssistantLifeDay(key);
  if (!day?.nightSleepPlan) { await reconcileSleepPlan(now, epoch); return false; }
  const wakeAt = sleepWakeTarget(day.nightSleepPlan, day.nightSleepPlan.actualSleepAt ?? day.sleepTargetAt);
  const isWake = (now >= wakeAt || day.nightSleepPlan.morningAwakeAt !== undefined
    && now >= day.nightSleepPlan.morningAwakeAt) && !day.nightSleepPlan.actualWakeAt;
  const phase = isWake ? 'wake' as const : 'prepare' as const;
  let opportunity = day.nightSleepPlan[phase];
  if (phase === 'prepare' && opportunity?.status === 'requesting') {
    const currentDay = await loadAssistantLifeDay(getLocalDateKey(new Date(now)));
    const waitingHandoff = [day, currentDay].some(owner => {
      const pending = owner?.nearStatus?.continuation?.sleep;
      return pending?.handoff?.nightKey === key && pending.handoff.messageId === opportunity?.messageId
        && pending.expectedRevision === day!.nightSleepPlan!.revision;
    });
    if (waitingHandoff) { await reconcileSleepPlan(now, epoch); return false; }
  }
  let expectedRevision = day.nightSleepPlan.revision;
  let successfulReplyAt: number | undefined;
  const terminal = opportunity && ['complete', 'failed', 'skipped'].includes(opportunity.status);
  const update = async (fn: (current: SleepOpportunity | undefined) => SleepOpportunity | undefined) => {
    const result = await runBackupRestoreDataEpochCommit(epoch, () => updateSleepOpportunity(key, phase, fn));
    if (!result.committed) throw new Error('sleep-epoch-stale');
    opportunity = result.value ?? opportunity;
    return result.value;
  };
  const finishWake = async (replyAt = successfulReplyAt) => {
    const latest = await loadAssistantLifeDay(key);
    if (latest?.nightSleepPlan?.revision !== expectedRevision) return;
    if (replyAt !== undefined && (latest.nightSleepPlan.scheduleChangedAt ?? -Infinity) >= replyAt
      && latest.nightSleepPlan.lastMessageId !== messageId) replyAt = undefined;
    const target = latest?.nightSleepPlan && sleepWakeTarget(latest.nightSleepPlan, latest.nightSleepPlan.actualSleepAt ?? latest.sleepTargetAt);
    const decisionSaved = opportunity?.toolResult?.ok || latest?.nightSleepPlan?.lastMessageId === messageId;
    if (target !== undefined && (Date.now() >= target || replyAt !== undefined && !decisionSaved)) {
      const settledAt = replyAt !== undefined && !decisionSaved ? replyAt : target;
      await runBackupRestoreDataEpochCommit(epoch, () => markSleepWakeSettled(key, settledAt, expectedRevision));
    }
  };
  const recordDelivered = async (deliveredAt: number) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await update((current) => ({ ...current, requestCount: current?.requestCount ?? 0,
          status: 'complete', deliveredAt, retryAt: undefined }));
        return;
      } catch (error) { if (attempt === 3 || !canCommitBackupRestoreDataEpoch(epoch)) throw error; }
    }
  };
  const messageId = opportunity?.messageId ?? `sleep-plan:${key}:${phase}`;
  const chat = await loadChatStateFast({ activeMessageLimit: 24 });
  const session = chat.sessions.find((item) => item.id === (opportunity?.sessionId ?? chat.activeSessionId));
  const savedMessage = session?.messages.find((message) => message.id === messageId);
  if (savedMessage) {
    if (!opportunity?.deliveredAt) await recordDelivered(savedMessage.createdAt);
    if (isWake) await finishWake(savedMessage.createdAt);
    await reconcileSleepPlan(now, epoch); return false;
  }
  if (opportunity?.contextMessageId !== undefined && opportunity.contextMessageId !== (session?.messages.at(-1)?.id ?? NO_CONTEXT_MESSAGE_ID)) {
    await update((current) => ({ ...current!, status: 'failed', retryAt: undefined }));
    if (isWake) await finishWake();
    await reconcileSleepPlan(now, epoch); return false;
  }
  if (day.nightSleepPlan.lastMessageId === messageId && !opportunity?.toolResult?.ok) {
    await update((current) => ({ ...current, requestCount: current?.requestCount ?? 0, status: 'failed' }));
    if (isWake) await finishWake();
    await reconcileSleepPlan(now, epoch); return false;
  }
  if (terminal || (!isWake && (day.nightSleepPlan.pendingSleep || now >= day.sleepTargetAt || !opportunity && now < day.sleepTargetAt - SLEEP_PREPARE_LEAD_MS || day.nightSleepPlan.prepareStatus))) {
    if (isWake) await finishWake();
    await reconcileSleepPlan(now, epoch); return false;
  }
  // A restored/ordinary tick does not replay a missed wake decision.
  if (isWake && (options.scheduledWakeNight !== key || opportunity?.status === 'requesting')) {
    await update((current) => ({ ...current, requestCount: current?.requestCount ?? 0, status: 'skipped' }));
    await finishWake(); await reconcileSleepPlan(now, epoch); return false;
  }
  if (opportunity?.status === 'retry' && now < (opportunity.retryAt ?? 0)) { await reconcileSleepPlan(now, epoch); return false; }
  // Interrupted C requests may use their one remaining retry, never a fresh budget.
  if (!isWake && opportunity?.status === 'requesting') {
    await update((current) => ({ ...current!, status: current!.retryUsed || current!.requestCount >= 3 ? 'failed' : 'retry', retryAt: now + RETRY_MS }));
    await reconcileSleepPlan(now, epoch); return false;
  }
  const allowed = options.allowRequest !== false && isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy());
  if (isWake) await reconcileSleepPlan(now, epoch);
  const state = await loadAssistantState();
  if (!allowed || (!isWake && state.lifeMode === 'sleeping')) {
    if (isWake || !isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())) {
      await update((current) => ({ ...current, requestCount: current?.requestCount ?? 0, status: 'skipped' }));
    }
    if (isWake) await finishWake();
    await reconcileSleepPlan(now, epoch); return false;
  }
  const config = await loadAiConfigPreferencesSnapshot();
  const { connection, apiKey } = resolveLifeCreativeConfig(config);
  if (!session || !connection || !apiKey?.trim()) {
    await update((current) => ({ ...current, requestCount: current?.requestCount ?? 0, status: 'failed' }));
    if (isWake) await finishWake();
    await reconcileSleepPlan(now, epoch); return false;
  }
  const controller = new AbortController();
  activeRequest = controller;
  const messageSnapshot = JSON.stringify(session.messages);
  const startedAsRetry = opportunity?.status === 'retry';
  const valid = async () => {
    if (controller.signal.aborted || !canCommitBackupRestoreDataEpoch(epoch) || isChatReplyInFlight()
      || !isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())) return false;
    const latestChat = await loadChatStateFast({ activeMessageLimit: 25 });
    if (latestChat.activeSessionId !== chat.activeSessionId
      || JSON.stringify(latestChat.sessions.find((item) => item.id === session.id)?.messages.filter((message) => message.id !== messageId).slice(-24)) !== messageSnapshot) return false;
    const latest = await loadAssistantLifeDay(key);
    const currentState = await loadAssistantState();
    if (latest?.nightSleepPlan?.lastMessageId === messageId && !opportunity?.toolResult?.ok) return false;
    return latest?.nightSleepPlan?.revision === expectedRevision
      && !(currentState.wakeSource === 'poke' && (currentState.manualWakeUntil ?? 0) > (state.manualWakeUntil ?? 0))
      && (isWake || opportunity?.toolResult?.ok || Date.now() < latest.sleepTargetAt);
  };
  let attempted = false;
  let deliveryStarted = false;
  try {
    const generate = async () => {
      // Advance actual sleep before supplying D, without crossing its pending wake boundary.
      await runBackupRestoreDataEpochCommit(epoch, () => runRhythmTick({ now: Date.now(),
        manualOverrideStartedAt: state.updatedAt, manualSleepUntil: state.manualSleepUntil, manualWakeUntil: state.manualWakeUntil }));
      day = (await loadAssistantLifeDay(key))!;
      const context = { ...sleepContext(day, Date.now()), manualWakeUntil: state.manualWakeUntil };
      try {
        const value = await generateSleepPlan({
          apiKey, connection, profile: config.profile, context, messages: session.messages, phase,
          remainingRequests: 3 - (opportunity?.requestCount ?? 0), signal: controller.signal, canContinue: valid,
          savedTool: opportunity?.toolResult && opportunity.toolCall ? { ...opportunity.toolCall, result: opportunity.toolResult } : undefined,
          onRequestStart: async () => {
            if (!await valid()) throw new Error('sleep-opportunity-stale');
            const counted = await update((current) => {
              if ((current?.requestCount ?? 0) >= 3) return undefined;
              return { ...current, status: 'requesting', requestCount: (current?.requestCount ?? 0) + 1,
                retryUsed: current?.retryUsed || startedAsRetry, sessionId: session.id, messageId,
                contextMessageId: current?.contextMessageId ?? session.messages.at(-1)?.id ?? NO_CONTEXT_MESSAGE_ID };
            });
            if (!counted) throw new Error('sleep-opportunity-request-limit');
            attempted = true;
          },
          commit: async (values, callId) => {
            if (!await valid()) throw new Error('sleep-opportunity-stale');
            if (opportunity?.toolResult?.ok) return opportunity.toolResult;
            if (Object.keys(values).some((key) => key !== 'sleepAt' && key !== 'wakeAt')) throw new Error('invalid-sleep-tool-input');
            const committed = await runBackupRestoreDataEpochCommit(epoch, async () => {
              if (!await valid()) throw new Error('sleep-opportunity-stale');
              const result = await commitSleepScheduleDecision({ ...values, context: { ...context, revision: expectedRevision }, messageId, phase });
              if (result.ok) {
                const latest = await loadAssistantLifeDay(key);
                expectedRevision = latest!.nightSleepPlan!.revision;
                await update((current) => ({ ...current!, toolResult: result, toolCall: { callId, input: values } }));
                if (isWake) await reconcileSleepPlan(Date.now(), epoch);
              }
              return result;
            });
            if (!committed.committed) throw new Error('sleep-epoch-stale');
            return committed.value;
          },
        });
        return { value };
      } catch (error) { return { error }; }
    };
    const budgeted = startedAsRetry && (opportunity?.requestCount ?? 0) > 0
      ? await runScheduledAiCall('proactive', 'background', generate)
      : await runBudgetedAiCall('proactive', 'background', generate,
        { connection, dataEpoch: epoch, shouldRecordSuccess: () => attempted });
    if (!budgeted.ok) {
      if (isWake) await update((current) => ({ ...current, requestCount: current?.requestCount ?? 0, status: 'skipped' }));
      return false;
    }
    if (!('value' in budgeted.value) || !budgeted.value.value) throw new Error('sleep-generation-failed');
    if (!await valid()) throw new Error('sleep-opportunity-stale');
    const message: SubjectiveMessage = { id: messageId, role: 'I', content: budgeted.value.value.message,
      createdAt: Date.now(), source: 'proactive-message' };
    // Model work is terminal before local delivery. Neither a save nor a receipt failure buys another HTTP.
    deliveryStarted = true;
    const retained = await retainSleepReply({ nightKey: key, phase, sessionId: session.id, activeSessionId: chat.activeSessionId,
      message, contextKey: sleepReplyContextKey(session.messages, messageId), epoch, current: valid });
    await update((current) => ({ ...current!, status: 'complete', retryAt: undefined }));
    await appendSleepMessage(session.id, message, epoch, valid, true, messages => sleepReplyDeliveryCurrent(retained, epoch, messages));
    successfulReplyAt = message.createdAt;
    await recordDelivered(Date.now());
    await discardPendingSleepReply(retained);
    if (!isWake) await Notifications.scheduleNotificationAsync({
      identifier: messageId, content: { title: '白云小姐', body: message.content, data: { kind: 'proactive-message' } }, trigger: null,
    }).catch(() => undefined);
    return true;
  } catch {
    if (canCommitBackupRestoreDataEpoch(epoch)) {
      const currentDay = await loadAssistantLifeDay(key);
      const canRetry = !deliveryStarted && !isWake && attempted && !startedAsRetry && (opportunity?.requestCount ?? 0) < 3
        && currentDay && Date.now() + RETRY_MS < currentDay.sleepTargetAt
        && (await loadAssistantState()).lifeMode !== 'sleeping'
        && await valid();
      if (!deliveryStarted || opportunity?.status !== 'complete') {
        await update((current) => ({ ...current, requestCount: current?.requestCount ?? 0,
          status: canRetry ? 'retry' : 'failed', retryAt: canRetry ? Date.now() + RETRY_MS : undefined }));
      }
    }
    return attempted;
  } finally {
    if (activeRequest === controller) activeRequest = null;
    if (canCommitBackupRestoreDataEpoch(epoch)) {
      if (isWake) await finishWake();
      await reconcileSleepPlan(Date.now(), epoch);
    }
  }
}

export async function handleSleepPlanTask(payload: SleepNativeWakeTask) {
  if (!payload || typeof payload.nightKey !== 'string' || !Number.isFinite(payload.at)) return;
  if (payload.phase === 'day_plan' || payload.phase === 'activity_start') {
    const epoch = captureBackupRestoreDataEpoch();
    if (epoch === null || Date.now() < payload.at) return;
    // Each host re-reads its actual opportunity/source. Late alarms cannot replay an expired window.
    try {
      if (payload.phase === 'day_plan' && payload.id === 'own-day-plan') await (await import('./ownDayPlanRuntime')).runOwnDayPlanTick();
      if (payload.phase === 'activity_start' && payload.id === 'own-schedule-activity')
        await (await import('../schedule/ownScheduleExecution')).runOwnScheduleExecution();
    } finally { await reconcileSleepPlanLocally(Date.now(), epoch); }
    return;
  }
  if (payload.phase === 'reading') {
    const epoch = captureBackupRestoreDataEpoch();
    if (epoch === null || Date.now() < payload.at) return;
    const reading = await import('./readingActivityRuntime');
    const current = await reading.getReadingActivityWakeTask();
    if (current?.id === payload.id && current.nightKey === payload.nightKey && current.at <= Date.now()) {
      await reading.runReadingActivityTick();
      await (await import('../schedule/ownScheduleExecution')).runOwnScheduleExecution();
    }
    await reconcileSleepPlanLocally(Date.now(), epoch);
    return;
  }
  if (payload.phase === 'unified_contact') {
    const epoch = captureBackupRestoreDataEpoch();
    if (epoch === null) return;
    const { getNextUnifiedContactAt, checkUnifiedContact } = await import('../proactive/unifiedContactDispatch');
    const now = Date.now();
    const currentAt = await getNextUnifiedContactAt(now);
    if (!canCommitBackupRestoreDataEpoch(epoch)) return;
    if (payload.id !== 'unified-contact' || currentAt === null || currentAt !== payload.at
      || payload.nightKey !== getLocalDateKey(new Date(currentAt)) || now < currentAt) {
      await reconcileSleepPlanLocally(Date.now(), epoch); return;
    }
    // The shared replacement queue is not held during network work.
    try { await checkUnifiedContact(); }
    finally { await reconcileSleepPlanLocally(Date.now(), epoch); }
    return;
  }
  if (payload.phase === 'sleep_status') {
    const day = await loadAssistantLifeDay(payload.nightKey);
    if (!day || !getSleepNearStatusWakeTasks(day, Date.now()).some(task => task.id === payload.id && task.at === payload.at)) {
      await reconcileSleepPlan(); return;
    }
    await runSleepNearStatusUpdate({ now: Date.now(), nightKey: payload.nightKey });
    await reconcileSleepPlan(); return;
  }
  if (!['prepare', 'prepare_retry', 'sleep', 'wake'].includes(payload.phase)) return;
  if ((payload.phase === 'prepare' || payload.phase === 'prepare_retry')
    && payload.nightKey !== (await readRelevantSleepNight())?.dateKey) return;
  const day = await loadAssistantLifeDay(payload.nightKey);
  if (!day?.nightSleepPlan) return;
  const currentAt = payload.phase === 'prepare' ? day.sleepTargetAt - SLEEP_PREPARE_LEAD_MS
    : payload.phase === 'prepare_retry' ? day.nightSleepPlan.prepare?.retryAt
      : payload.phase === 'sleep' ? pendingSleepTaskAt(day.nightSleepPlan) ?? day.sleepTargetAt : sleepWakeAlarmAt(day, payload.at);
  if (payload.at !== currentAt) { await reconcileSleepPlan(); return; }
  if (Date.now() < currentAt!) return;
  if (payload.phase === 'sleep' || payload.phase === 'wake' && day.nightSleepPlan.wake
    && ['complete', 'failed', 'skipped'].includes(day.nightSleepPlan.wake.status)) {
    await reconcileSleepPlan(Date.now(), captureBackupRestoreDataEpoch(), true);
    return;
  }
  if (activeTick) await activeTick;
  await runSleepPlanTick({ now: Date.now(), allowRequest: true,
    ...(payload.phase === 'wake' ? { scheduledWakeNight: payload.nightKey } : {}) });
}

export async function resetSleepOpportunitiesAfterRestore() {
  activeRequest?.abort();
  await discardPendingSleepReply();
  // Restore owns an exclusive lease. Queued reconciles fail their old epoch after it releases.
  await replaceSleepNativeWakeTasks([]);
  for (const key of await listAssistantLifeDays(90)) {
    await resetSleepNearStatusAfterRestore(key);
    for (const phase of ['prepare', 'wake'] as const) {
      await updateSleepOpportunity(key, phase, (current) => current && ['requesting', 'retry'].includes(current.status)
        ? { ...current, status: 'failed', retryAt: undefined } : undefined);
    }
  }
}
