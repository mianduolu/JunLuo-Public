import * as Crypto from 'expo-crypto';
import { DeviceEventEmitter } from 'react-native';
import { buildCompiledSystemPromptResult } from '../ai/builtInSystemPrompt';
import { loadAiConfigPreferencesSnapshot, resolveLifeCreativeConfig } from '../ai/AiConfigPreferences';
import { loadAssistantState } from '../ai/assistantState';
import { fetchAssistantLifeCompletion } from '../ai/assistantLifePromptEnvelope';
import { runBudgetedAiCall } from '../ai/aiCallBudget';
import { isChatReplyInFlight } from '../ai/aiRuntimeScheduler';
import { SUBJECTIVE_IDENTITY_PROTOCOL, type SubjectiveMessage } from '../ai/subjectiveMessages';
import { cancelBaiyunContinuityEvent, getBaiyunContinuityEvent } from '../ai/behavior/continuityLedger';
import { appendMessagesToChatSession, findChatSessionContainingMessage, loadChatSessionMessages } from '../chat/chatStorage';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { getPhoneGuardEvent, readNativePhoneCareUsage, releaseNativePhoneCareDispatch, writeNativePhoneCareFollowUp } from '../backend/phoneActivityNative';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { captureSleepPlanContext } from '../life/sleepPlanStore';
import { formatSleepLocalTime } from '../life/sleepPlanPolicy';
import { requestActiveMessageSlot, recordActiveMessageDelivery } from './activeMessageCoordinator';
import { loadPhoneActivityProactiveSettings } from './phoneActivityRules';
import { parseOrdinaryProactiveLiteResponseWithDiagnostics } from './proactiveLitePrompt';
import { buildPhoneCareFacts, choosePhoneCareDelayMs, decidePhoneCareFollowUp, PHONE_CARE_GRACE_MS, PHONE_CARE_TASKS, type PhoneCareFollowUp } from './phoneCareFollowUp';
import { changePhoneCareFollowUp, readPhoneCareFollowUp } from './phoneCareFollowUpStore';

const settled = new Set<string>();
let running: Promise<number> | null = null;

async function bodyKey(messages: readonly SubjectiveMessage[]) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(messages.map((m) => [
    m.id, m.role, m.content, m.images, m.voice, m.sticker, m.replyTo,
  ])));
}

function inputs(task: PhoneCareFollowUp, messages: readonly SubjectiveMessage[]) {
  const sourceIndex = messages.findIndex((m) => m.id === task.lastIMessageId && m.role === 'I');
  const source = messages[sourceIndex];
  const youMessages = messages.slice(sourceIndex + 1).filter((m) => m.role === 'you');
  const latestYou = messages.filter((m) => m.role === 'you').at(-1);
  let lastYouIndex = messages.length - 1;
  while (lastYouIndex > sourceIndex && messages[lastYouIndex]?.role !== 'you') lastYouIndex -= 1;
  const round: SubjectiveMessage[] = [];
  while (lastYouIndex > sourceIndex && messages[lastYouIndex]?.role === 'you') round.unshift(messages[lastYouIndex--]);
  return { source, latestYou, youMessages, round, all: source ? [source, ...youMessages] : [] };
}

async function end(task: PhoneCareFollowUp, reason: string) {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return;
  const ended = task.status === 'finished' ? task : await changePhoneCareFollowUp(task, {
    status: 'finished', finishedReason: reason, preparedMessage: undefined,
  });
  if (!ended) throw new Error('phone-care-finish-raced');
  if (!ended.eventId || ended.finishedReason === 'restore' || settled.has(ended.eventId)) return;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const event = await getBaiyunContinuityEvent(ended.eventId);
      if (!canCommitBackupRestoreDataEpoch(epoch)) return;
      if (event && event.status !== 'completed' && event.status !== 'cancelled') await cancelBaiyunContinuityEvent({
        eventId: event.id, expectedRevision: event.revision,
        reasonCode: `phone_care_${ended.finishedReason ?? reason}`,
        operationId: `phone-care:${event.id}:finish`,
      });
      settled.add(ended.eventId);
      if (settled.size > 16) settled.delete(settled.values().next().value!);
      return;
    } catch { console.warn('[phone-care]', { eventId: ended.eventId, stage: 'finish' }); }
  }
}

export async function registerPhoneCareFollowUp(input: {
  triggerId: string; ruleId: string; messageId: string; careReason: string; eventId?: string;
}) {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return;
  const sessionId = await findChatSessionContainingMessage(input.messageId);
  if (!sessionId) return;
  const messages = await loadChatSessionMessages(sessionId);
  const source = messages.find((m) => m.id === input.messageId && m.role === 'I');
  if (!source?.content.trim()) return;
  if (messages.slice(messages.indexOf(source) + 1).some((m) => m.role === 'you')) return;
  if (input.eventId) {
    const event = await getBaiyunContinuityEvent(input.eventId);
    if (!event || event.schemaVersion !== 2 || event.kind !== 'care_process' || event.source.kind !== 'real_care'
      || event.source.sourceId !== input.triggerId || event.status === 'completed' || event.status === 'cancelled') return;
  } else {
    const event = await getPhoneGuardEvent(input.triggerId);
    if (!event || event.triggerId !== input.triggerId || event.ruleId !== input.ruleId
      || !event.overlayShownAt || !event.authorized || !event.overlayPermission
      || input.messageId !== `phone-guard:${input.triggerId}`) return;
  }
  const old = await readPhoneCareFollowUp();
  if (old?.triggerId === input.triggerId) return;
  const now = Date.now();
  if (old && old.status !== 'finished' && now <= old.expiresAt) return; // Keep the original deadline and exact ticket.
  if (old) await end(old, old.finishedReason ?? 'expired');
  const latest = await readPhoneCareFollowUp();
  const lastYouMessageId = messages.filter((m) => m.role === 'you').at(-1)?.id;
  const sleep = await captureSleepPlanContext(now);
  const dueAt = now + choosePhoneCareDelayMs();
  const value: PhoneCareFollowUp = {
    schemaVersion: 1, triggerId: input.triggerId, ruleId: input.ruleId, careReason: input.careReason,
    lastIMessageId: input.messageId, sessionId, eventId: input.eventId,
    lastContactAt: now, dueAt, expiresAt: dueAt + PHONE_CARE_GRACE_MS,
    nextCheckAt: Math.min(now + 30_000, dueAt, sleep && sleep.currentSleepAt > now ? Math.max(now, sleep.currentSleepAt - 60_000) : dueAt),
    revision: (latest?.revision ?? 0) + 1, requestClaimed: false, status: 'waiting',
    lastYouMessageId, lastIContentKey: await bodyKey([source]),
  };
  const saved = await runBackupRestoreDataEpochCommit(epoch, () => writeNativePhoneCareFollowUp(latest?.revision ?? 0, value));
  if (saved.committed && !saved.value) throw new Error('phone-care-register-raced');
}


async function run() {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return 0;
  const current = () => canCommitBackupRestoreDataEpoch(epoch);
  let task = await readPhoneCareFollowUp();
  if (!task) return 0;
  const finish = async (reason: string) => { if (current()) await end(task!, reason); return 0; };
  if (task.status === 'finished') return finish(task.finishedReason ?? 'finished');
  if (!task.sessionId) return finish('source_missing');
  const allowed = async () => {
    const settings = await loadPhoneActivityProactiveSettings();
    return isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy()) && settings.enabled
      && settings.rules.some((rule) => rule.id === task!.ruleId && rule.kind === 'blacklist');
  };
  if (!await allowed()) return finish('disabled');
  if (task.eventId) {
    const event = await getBaiyunContinuityEvent(task.eventId);
    if (!event || event.status === 'completed' || event.status === 'cancelled') return finish('care_closed');
  }
  const messages = await loadChatSessionMessages(task.sessionId);
  const material = inputs(task, messages);
  const contactId = task.eventId ?? `phone-guard:${task.triggerId}`;
  const messageId = `phone-care:${contactId}`;
  if (messages.some((m) => m.id === messageId)) return finish('delivered');
  if (!material.source || await bodyKey([material.source]) !== task.lastIContentKey) return finish('input_changed');
  if (material.latestYou?.id !== task.lastYouMessageId || task.pausedYouMessageId) return finish('you_replied');
  const contextKey = await bodyKey(material.all);
  if (task.preparedContextKey && task.preparedContextKey !== contextKey) return finish('input_changed');
  const sleeping = (await loadAssistantState()).lifeMode === 'sleeping';
  const sleepAt = sleeping ? undefined : (await captureSleepPlanContext())?.currentSleepAt;
  const decision = decidePhoneCareFollowUp({ task, now: Date.now(), sleeping, sleepAt,
    usage: await readNativePhoneCareUsage() ?? undefined });
  if (decision.kind === 'finish') return finish(decision.reason);
  if (decision.kind === 'wait') {
    // Recheck the existing task as sleep plans change; this is not a new timer.
    await changePhoneCareFollowUp(task, { nextCheckAt: Math.min(decision.at, Date.now() + 30_000) });
    return 0;
  }
  // Preparing a note does not send it; delivery cooldown applies when it is due.
  const slot = decision.kind === 'request' && decision.variant === 'before_sleep'
    ? { allowed: !isChatReplyInFlight() }
    : await requestActiveMessageSlot({ source: 'phone-activity', priority: 'contextual',
        topicKey: contactId, bypassQuietHour: true });
  if (!slot.allowed) {
    await changePhoneCareFollowUp(task, { nextCheckAt: Math.min(task.expiresAt, Date.now() + 30_000) });
    return 0;
  }
  const valid = async (targetMessages?: SubjectiveMessage[]) => {
    if (!current() || Date.now() > task!.expiresAt || !await allowed()) return false;
    const latest = await readPhoneCareFollowUp();
    if (latest?.revision !== task!.revision || latest.status === 'finished') return false;
    const actual = inputs(task!, targetMessages ?? await loadChatSessionMessages(task!.sessionId!));
    return !!actual.source && await bodyKey(actual.all) === contextKey;
  };
  if (decision.kind === 'request') {
    const snapshot = await loadAiConfigPreferencesSnapshot();
    const config = resolveLifeCreativeConfig(snapshot);
    if (!config.connection || !config.apiKey.trim()) return finish('configuration');
    const compiled = await buildCompiledSystemPromptResult({ contextProfile: 'chat-full', outputAudience: 'private_visible_text', profile: snapshot.profile });
    const stable = [SUBJECTIVE_IDENTITY_PROTOCOL, compiled.stablePrompt].filter(Boolean).join('\n\n');
    const facts = buildPhoneCareFacts({ lastContactAt: formatSleepLocalTime(task.lastContactAt), careReason: task.careReason,
      lastIMessage: material.source.content, youReply: material.round.map((m) => m.content).join('\n'), currentTime: formatSleepLocalTime(Date.now()) });
    const taskPrompt = PHONE_CARE_TASKS[decision.variant];
    const apiMessages = [{ role: 'system' as const, content: [stable, compiled.sections.expression, facts, taskPrompt].filter(Boolean).join('\n\n') }];
    const result = await runBudgetedAiCall('proactive', 'background', async () => {
      try {
        const response = await fetchAssistantLifeCompletion({ apiKey: config.apiKey, connection: config.connection!,
          contextSource: 'proactive.phone-care', timeoutMs: 25_000, userPrompt: '', apiMessagesOverride: apiMessages,
          envelope: { apiMessages, contextProfile: 'assistant-life', stablePrefixText: stable, stablePrefixFingerprint: '',
            stableSystemPrompt: stable, taskPromptText: taskPrompt,
            promptBreakdown: { stableSystemPrompt: stable, dynamicSystemPrompt: compiled.sections.expression, taskPromptText: taskPrompt } },
          onRequestStart: async () => {
            if (!await valid()) throw new Error('phone-care-stale');
            if (isChatReplyInFlight()) throw new Error('phone-care-chat-started');
            const nowSleeping = (await loadAssistantState()).lifeMode === 'sleeping';
            if (nowSleeping !== (decision.variant === 'sleeping')) throw new Error('phone-care-sleep-changed');
            if (nowSleeping) {
              const usage = await readNativePhoneCareUsage();
              if (!usage?.usingManagedApp || Date.now() - usage.observedAt < 0 || Date.now() - usage.observedAt > 10_000) throw new Error('phone-care-usage-changed');
            }
            const claimed = await changePhoneCareFollowUp(task!, { requestClaimed: true });
            if (!claimed || !current()) throw new Error('phone-care-claim');
            task = claimed;
          },
        });
        return parseOrdinaryProactiveLiteResponseWithDiagnostics(response.content).messages[0] ?? '';
      } catch { return ''; }
    }, { connection: config.connection, dataEpoch: epoch, shouldRecordSuccess: () => task!.requestClaimed });
    if (!current()) return 0;
    if (!result.ok) {
      await changePhoneCareFollowUp(task, { nextCheckAt: Math.min(task.expiresAt, Date.now() + 30_000) });
      return 0;
    }
    if (!await valid()) return finish('input_changed');
    if (!task.requestClaimed) {
      await changePhoneCareFollowUp(task, { nextCheckAt: Math.min(task.expiresAt, Date.now() + 30_000) });
      return 0;
    }
    if (!result.value) return finish('request_failed');
    const prepared = await changePhoneCareFollowUp(task, { status: 'prepared', preparedMessage: result.value,
      preparedContextKey: contextKey, nextCheckAt: task.dueAt });
    if (!prepared) return 0;
    task = prepared;
    if (Date.now() < task.dueAt) return 0;
  }
  const message: SubjectiveMessage = { id: messageId, role: 'I', content: task.preparedMessage!, createdAt: Date.now(), source: 'proactive-message' };
  let delivered = false;
  for (let attempt = 0; attempt < 4 && current(); attempt += 1) {
    try {
      if (!await valid()) return finish('input_changed');
      const saved = await runBackupRestoreDataEpochCommit(epoch, () => appendMessagesToChatSession(task!.sessionId!, [message], {
        beforeAppend: async (actual) => Date.now() >= task!.dueAt && await valid(actual),
      }));
      if (!saved.committed || !saved.value.session || !saved.value.messages.some((m) => m.id === messageId)) return finish('save_cancelled');
      delivered = true;
      break;
    } catch { console.warn('[phone-care]', { eventId: task.eventId, stage: 'save' }); }
  }
  if (delivered) {
    // Receipt retries must not append the body again or replay its UI notification.
    if (current()) DeviceEventEmitter.emit('junluoPhoneGuardChatMessage', { message, sessionId: task.sessionId });
    await finish('delivered');
    if (current()) await recordActiveMessageDelivery({ source: 'phone-activity', priority: 'contextual', messageCount: 1, topicKey: contactId });
    return 1;
  }
  return finish('save_failed');
}

export function runPhoneCareFollowUp() {
  if (!running) running = run().catch(() => 0).finally(async () => {
    running = null;
    await releaseNativePhoneCareDispatch();
  });
  return running;
}
