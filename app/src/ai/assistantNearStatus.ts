import { AssistantLifeRequestError, buildAssistantStatePairEnvelope, fetchAssistantLifeCompletion } from './assistantLifePromptEnvelope';
import type { AssistantLifeGenerationFailureReason } from './assistantLifeGenerationShared';
import type { AssistantLifeGenerationDiagnostic } from './assistantLifeGenerationDiagnostics';
import { ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS, buildAssistantLifeShortJsonRequest } from './assistantLifeShortJsonRequest';
import { isAiCostDeferred, runBudgetedAiCall, runBudgetedAiCallPair, type AiRequestAdmission } from './aiCallBudget';
import { isChatReplyInFlight } from './aiRuntimeScheduler';
import { loadAssistantState, type AssistantState } from './assistantState';
import { loadAssistantLifeDay, listAssistantLifeDays, getLocalDateKey } from './assistantLifeTimeline';
import { buildNearStatusLifeMaterialSnapshot, lifeMaterialSourceRevision, nearStatusLifeSourcesMatch, type LifeMaterialItem } from './lifeMaterialHub';
import { sleepMaterialNightKey, formatSleepTransition, sleepTransitionMatches, sleepTransitionConversationKey, isSleepingTransition,
  loadSleepExperienceConversation, type SleepNearStatusTransition } from '../life/sleepExperienceMaterial';
import { buildSleepNearStatusFacts, parseSleepNearStatus, SLEEP_NEAR_STATUS_TASKS } from '../life/sleepNearStatusPrompt';
import { formatChatAfterglowConversation } from '../chat/chatAfterglowProbe';
import { estimateApiMessagesTokens, estimateTextTokens } from '../chat/contextCompression';
import { fingerprintPromptText } from './promptCacheMetrics';
import { readJsonObjects } from './shortJsonObjects';
import { containsToolProtocolMarkup } from './visibleReplyExtraction';
import type { AiConnection, AiProfile } from './types';
import type { OpenAiCompatibleRequestMessage } from './openAiCompatibleProvider';
import { loadToolProviderCapabilities } from './toolProviderCapabilities';
import { buildToolAgentProviderRequestPolicy, assertToolAgentProviderSupportsCandidates } from './toolAgentProvider';
import { buildToolProviderTransportParameters } from './modelParameters';
import { isOfficialDeepSeekV4Connection } from './toolProviderCapabilities';
import { loadChatStateFast, loadChatSessionMessagePage, loadChatSessionMessage } from '../chat/chatStorage';
import { buildQwenChatLayout, freezeQwenChatSource, isSiliconQwenChatConnection, readQwenChatSource,
  isQwenChatSourceDeferred, QwenChatSourceUnavailable, type QwenChatSource } from './qwenChatLayout';
import { cleanAssistantMessageContent, type SubjectiveMessage } from './subjectiveMessages';
import { loadJunluoAffectState, loadJunluoThoughtState } from '../life/junluoInnerStateStore';
import { selectDueJunluoThoughtReview } from '../life/junluoThoughtLifecycle';
import { canOfferAfterglowCounterIdea } from '../chat/keywordCounterStore';
import { buildNearStatusTask, parseNearStatusPaper, type NearStatusPaper, type NearStatusPart } from './assistantNearStatusPaper';
import { formatNearStatusPhone } from './nearStatusLifeMaterialFormat';
import { getCachedSystemStatusAmbientSnapshot, type SystemStatusAmbientSnapshot } from './systemStatusAmbientContext';
import { BAIYUN_EMOTION_LABELS } from '../life/junluoInnerStatePresentation';
import { loadJunluoDesirePromptPaper } from '../life/junluoDesireRuntime';
import { formatSleepLocalTime } from '../life/sleepPlanPolicy';
import { createNearStatusSleepOpportunity, type NearStatusSleepContinuation } from '../life/sleepPlanRuntime';
import { readSleepSchedule } from '../life/sleepPlanStore';
import { buildSleepFactsMaterial, NEAR_STATUS_SLEEP_MESSAGE_PROMPT } from '../life/sleepPlanGeneration';
import { sleepScheduleWriteTool, sleepScheduleToolPackage, sleepScheduleToolFor } from '../tools/builtin/lifeSleepTools';
import { getToolDefinition, registerToolPackage } from '../tools/toolRegistry';
import { executeToolCall } from '../tools/toolExecution';
import { createToolSuccessResult } from '../tools/toolResult';
import { parseOpenAiToolCalls, toolDefinitionToOpenAiTool, type OpenAiCompatibleToolCallMessage } from '../tools/toolCallProtocol';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { collectReadingActivityMaterial, readingActivityRefsMatch, type ReadingActivityRef } from '../reading/readingActivityMaterial';
import { collectOwnScheduleConflicts, ownScheduleConflictRefsMatch, ownScheduleItemRef, type OwnScheduleConflictRef } from '../schedule/ownScheduleConflict';
import { nearStatusScheduleTool } from '../tools/builtin/ownScheduleTools';

export { NEAR_STATUS_INTERVAL_MS } from './assistantState';

type ChatLine = Pick<SubjectiveMessage, 'id' | 'role' | 'content' | 'createdAt' | 'deliveryStatus'>;

/** Retain six complete exchanges, including consecutive bubbles, then any unanswered you. */
export function selectNearStatusConversation<T extends ChatLine>(messages: readonly T[]): T[] {
  const rounds: T[][] = [];
  for (const message of messages) {
    if (!message.content.trim() || message.deliveryStatus === 'failed') continue;
    const previous = rounds.at(-1);
    if (!previous || (message.role === 'you' && previous.some(line => line.role === 'I'))) rounds.push([message]);
    else previous.push(message);
  }
  const complete = rounds.filter(round => round.some(line => line.role === 'I') && round.some(line => line.role === 'you'));
  const first = complete.slice(-6)[0];
  if (first) return rounds.slice(rounds.indexOf(first)).flat();
  return rounds.flat();
}

export async function loadNearStatusConversation(ignoredMessageId?: string) {
  const stored = await loadChatStateFast({ activeMessageLimit: 1 });
  const session = [...stored.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!session) return { key: '', sessionId: '', messages: [] as SubjectiveMessage[] };
  let beforeIndex = session.messageCount ?? session.messages.length;
  let messages: SubjectiveMessage[] = [];
  while (beforeIndex > 0) {
    const page = await loadChatSessionMessagePage(session.id, { beforeIndex, limit: 60 });
    if (!page.messages.length || page.startIndex >= beforeIndex) break;
    messages = [...page.messages.filter(message => message.id !== ignoredMessageId), ...messages];
    const selected = selectNearStatusConversation(messages);
    // An older, unselected message proves that the first retained round is complete.
    if (selected.length < messages.length) { messages = selected; break; }
    beforeIndex = page.startIndex;
  }
  messages = selectNearStatusConversation(messages);
  return { messages, sessionId: session.id, key: fingerprintPromptText(JSON.stringify([session.id, messages.map(m => [m.id, m.role, m.createdAt, m.content])])) };
}

export async function nearStatusChatSourceMatches(source: QwenChatSource, chatKey: string, ignoredMessageId?: string) {
  try { await readQwenChatSource(source, loadChatSessionMessage); }
  catch (error) { if (isQwenChatSourceDeferred(error)) throw error; return false; }
  try { return (await loadNearStatusConversation(ignoredMessageId)).key === chatKey; }
  catch { throw new QwenChatSourceUnavailable(); }
}

const lifeModeText = { available: '日常', 'self-time': '自处', sleeping: '睡眠' };
const timeText = (at: number) => formatSleepLocalTime(at).replace('T', ' ');
const phoneRevision = (snapshot: SystemStatusAmbientSnapshot) => fingerprintPromptText(JSON.stringify([
  snapshot.battery.percentage, snapshot.battery.level, snapshot.battery.state,
  snapshot.battery.isLowPowerModeEnabled, snapshot.appState,
]));

export type NearStatusSaveResult = {
  status: 'saved' | 'pending' | 'interrupted';
  savedParts: NearStatusPart[];
  /** Positive evidence only; absence means not confirmed, not that the text was lost. */
  visibleTextSaved?: true;
  interruptionReason?: string;
};

export type NearStatusOpportunityRef = { id: string; revision: string; occurredAt: number };

/** Only facts actually selected into this request can open it. The full fingerprints
 * below still validate background facts; they are not spending permissions. */
export function nearStatusLifeOpportunity(item: LifeMaterialItem): NearStatusOpportunityRef | undefined {
  if (item.nearStatusSelfResult) return undefined;
  if (item.nearStatusRevision !== undefined) {
    return { id: item.id, revision: item.nearStatusRevision, occurredAt: item.occurredAt };
  }
  if (item.affectResultAt !== undefined
    && ['co-reading', 'web-voyage', 'github-voyage', 'assistant-schedule'].includes(item.source)) {
    return { id: item.id, revision: String(item.affectResultAt), occurredAt: item.affectResultAt };
  }
  return undefined;
}

export async function collectNearStatusMaterials(now: number, current: AssistantState, transition?: SleepNearStatusTransition, connection?: AiConnection) {
  const useQwen = !transition && connection && isSiliconQwenChatConnection(connection);
  const transitionDay = transition ? await loadAssistantLifeDay(transition.nightKey) : null;
  const transitionEvent = transitionDay?.nightSleepPlan?.events?.find(event => event.id === transition?.eventId);
  const transitionFact = transitionDay && transitionEvent ? formatSleepTransition(transitionDay, transitionEvent) : '';
  if (isSleepingTransition(transition)) {
    if (!transitionDay?.nightSleepPlan || !transitionEvent) throw new Error('near-status-transition-missing');
    const source = await loadSleepExperienceConversation(transitionDay, now);
    const facts = buildSleepNearStatusFacts({ now, nightKey: transitionDay.dateKey, phase: 'sleeping',
      wakeAt: transitionDay.nightSleepPlan.explicitWakeAt ?? transitionDay.nightSleepPlan.originalWakeAt, previous: current });
    return { cloudForm: current.cloudForm ?? 'white', chatKey: fingerprintPromptText(JSON.stringify(source.messages)),
      chatSource: undefined as QwenChatSource | undefined,
      materialKey: fingerprintPromptText(JSON.stringify(transition)), material: [facts, transitionFact].filter(Boolean).join('\n\n'),
      sleepConversation: source.messages.length ? formatChatAfterglowConversation(source.messages) : '',
      counterEnabled: false, opportunityRefs: [] as NearStatusOpportunityRef[],
      lifeRefs: [] as { id: string; revision: string }[], appointmentRefs: [] as { id: string; revision: string }[], activityRefs: [] as ReadingActivityRef[],
      scheduleRefs: [] as OwnScheduleConflictRef[], scheduleVersions: {} as Record<string, number>, scheduleItems: [] as import('../schedule/scheduleStore').ScheduleItem[], thoughtRef: undefined };
  }
  const [chat, day, affect, desirePaper, thoughts, counterEnabled] = await Promise.all([
    loadNearStatusConversation().catch(error => { if (useQwen) throw new QwenChatSourceUnavailable(); throw error; }), loadAssistantLifeDay(getLocalDateKey(new Date(now))),
    loadJunluoAffectState(), loadJunluoDesirePromptPaper(now),
    loadJunluoThoughtState(), canOfferAfterglowCounterIdea(),
  ]);
  const life = await buildNearStatusLifeMaterialSnapshot(now, { homeOnly: true, includeAssistantSchedule: true });
  const lifeRefs = life.promptItems.map(item => {
    const original = { id: item.id, revision: lifeMaterialSourceRevision(item) };
    if (item.id === 'ambient:phone') {
      const phone = getCachedSystemStatusAmbientSnapshot(now);
      if (phone && phone.checkedAt === item.occurredAt && formatNearStatusPhone(phone) === item.promptLine) {
        return { id: `phone-observation:${phone.checkedAt}`, revision: phoneRevision(phone) };
      }
    }
    // If the phone snapshot changed during collection, retain the strict source check.
    return original;
  });
  const emotions = [affect.emotions.primary, ...affect.emotions.secondary.slice(0, 1)].filter(m => m !== null);
  const thought = selectDueJunluoThoughtReview(thoughts, now);
  // These facts exclude this request's clock, the generated near-status itself and passive numerical drift.
  const materialKey = fingerprintPromptText(JSON.stringify({ chat: chat.key, life: life.fingerprint,
    lifeMode: current.lifeMode, emotion: emotions.map(m => m.emotionId) }));
  const opportunityRefs: NearStatusOpportunityRef[] = life.promptItems.flatMap(item => {
    const ref = nearStatusLifeOpportunity(item); return ref ? [ref] : [];
  });
  if (chat.messages.length) opportunityRefs.push({ id: 'chat', revision: chat.key,
    occurredAt: Math.max(...chat.messages.map(message => message.createdAt)) });
  if (emotions.length) opportunityRefs.push({ id: 'emotion',
    revision: fingerprintPromptText(JSON.stringify(emotions.map(emotion => emotion.emotionId))),
    occurredAt: Math.max(...emotions.map(emotion => emotion.occurredAt)) });
  const matchesCurrent = (e: { title: string; activity: string; moodId: string; cloudForm?: string }) =>
    e.title === current.title && e.activity === current.activity && e.moodId === current.moodId
    && (e.cloudForm ?? 'white') === (current.cloudForm ?? 'white');
  let previous = (day?.timelineEntries ?? []).filter(matchesCurrent).at(-1);
  if (!previous) {
    for (const key of await listAssistantLifeDays(90)) {
      if (key === day?.dateKey) continue;
      previous = (await loadAssistantLifeDay(key))?.timelineEntries.filter(matchesCurrent).at(-1);
      if (previous) break;
    }
  }
  // Activity facts accompany an already qualified paper; they never open one.
  const activity = await collectReadingActivityMaterial(now, life.promptItems.length,
    life.promptItems.reduce((sum, item) => sum + (item.promptLine?.length ?? 0), 0));
  const conflicts = transition ? null : await collectOwnScheduleConflicts(now, {
    maxItems: Math.max(0, 8 - life.promptItems.length - activity.refs.length),
    maxCharacters: Math.max(0, 1000 - life.promptItems.reduce((sum, item) => sum + (item.promptLine?.length ?? 0), 0) - activity.material.length),
  });
  const material = [
    `【此刻】\n\n现在：${timeText(now)}\nI 当前的作息状态：${lifeModeText[current.lifeMode]}`,
    `【I 现在的模样】\n\n${current.cloudForm === 'black' ? '乌云' : '白云'}`,
    previous ? `【I 上次写的近况】\n\n记录时间：${timeText(previous.at)}\n${previous.activity}` : '',
    !useQwen && chat.messages.length ? `【最近和 you 聊过的话】\n\n${chat.messages.map(m => `${timeText(m.createdAt)} ${m.role}：${m.content}`).join('\n')}` : '',
    emotions.length ? `【I 最近记录的心情】\n\n心情：${emotions.map(m => BAIYUN_EMOTION_LABELS[m.emotionId]).join('、')}\n记录时间：${timeText(emotions[0].occurredAt)}` : '',
    desirePaper, life.promptContext, activity.material, conflicts?.material,
    transitionFact && !life.promptContext.includes(transitionFact) ? transitionFact : '',
    thought ? `【I 之前记下的念头】\n\nthoughtId：${thought.thoughtId}\n记录时间：${timeText(thought.createdAt)}\n${thought.content}` : '',
  ].filter(Boolean).join('\n\n');
  return { cloudForm: current.cloudForm ?? 'white', chatKey: chat.key, materialKey, material, sleepConversation: '', counterEnabled, opportunityRefs,
    chatSource: useQwen ? freezeQwenChatSource(connection!, chat.sessionId, chat.messages) : undefined,
    lifeRefs, activityRefs: activity.refs,
    scheduleRefs: conflicts?.refs ?? [], scheduleVersions: conflicts?.versions ?? {}, scheduleItems: conflicts?.items ?? [],
    appointmentRefs: [] as { id: string; revision: string }[],
    thoughtRef: thought ? { id: thought.thoughtId, revision: fingerprintPromptText(JSON.stringify(thought)),
      contentRevision: fingerprintPromptText(JSON.stringify([thought.createdAt, thought.content])) } : undefined };
}

export async function nearStatusFactsStillMatch(sources: { lifeRefs: { id: string; revision: string }[]; appointmentRefs: { id: string; revision: string }[]; activityRefs?: ReadingActivityRef[]; scheduleRefs?: OwnScheduleConflictRef[] }, now = Date.now()) {
  const life = await buildNearStatusLifeMaterialSnapshot(now, { homeOnly: true, includeAssistantSchedule: true });
  for (const ref of sources.lifeRefs) {
    if (sleepMaterialNightKey(ref.id)) {
      if (!await nearStatusLifeSourcesMatch([{ ...ref, createdAt: 0 }], life.items)) return false;
    } else if (ref.id.startsWith('phone-observation:')) {
      const at = Number(ref.id.slice('phone-observation:'.length));
      const phone = getCachedSystemStatusAmbientSnapshot(now);
      if (!Number.isFinite(at) || !phone || phone.checkedAt < at
        || (phone.checkedAt === at && phoneRevision(phone) !== ref.revision)) return false;
      // A newer device observation does not edit the dated, non-editable observation already read.
    } else if (ref.id.startsWith('web-voyage:') || ref.id.startsWith('github-voyage:')) {
      if (!await nearStatusLifeSourcesMatch([{ ...ref, createdAt: 0 }], life.items, life.debug?.dropped)) return false;
    } else if (!life.items.some(item => item.id === ref.id && item.fingerprint === ref.revision)) return false;
  }
  return sources.appointmentRefs.length === 0 && await readingActivityRefsMatch(sources.activityRefs ?? [], now)
    && await ownScheduleConflictRefsMatch(sources.scheduleRefs ?? [], now);
}

/** Selected facts and one real tool receipt, never a persona/task or outbound role array. */
export type NearStatusContinuation = {
  nextOrdinal: 2 | 3;
  usedRequests: number;
  inFlight?: true;
  retryAllowed: boolean;
  materials: Omit<Awaited<ReturnType<typeof collectNearStatusMaterials>>, 'scheduleVersions' | 'scheduleItems' | 'opportunityRefs'>;
  controlKey: string;
  sleepFacts: string;
  mixedTools: boolean;
  /** Original home-only authorization, frozen before the paid schedule instruction executes. */
  scheduleSources?: { id: string; revision: string; planVersion: number; planRevision: number; started: boolean; activityId?: string }[];
  sleep?: NearStatusSleepContinuation;
  tool?: { subject: 'I'; callId: string; toolId: string; name: string; input: Record<string, unknown>;
    reasoningContent?: string; receipt: { callId: string; toolId: string; ok: boolean; status: string;
      summary: string; data?: unknown; errorCode?: string } };
  /** Paid output awaiting local adoption; no receipt exists until the tool really ran. */
  received?: { subject: 'I'; kind: 'tool_instruction'; callId: string; toolId: string; name: string;
    input: Record<string, unknown>; reasoningContent?: string }
    | { subject: 'I'; kind: 'sleep_message'; content: string };
  requests: NonNullable<AssistantLifeGenerationDiagnostic['requests']>;
};

export async function generateNearStatus(input: {
  apiKey: string; connection: AiConnection; profile: AiProfile; now: number; dataEpoch: number | null;
  generationKey: string; materials: Awaited<ReturnType<typeof collectNearStatusMaterials>>;
  sleepTransition?: SleepNearStatusTransition;
  continuation?: NearStatusContinuation;
  onContinuation?: (value: NearStatusContinuation | undefined) => Promise<void>;
  onRequestStart: () => Promise<void>;
  onTransportAttempt?: (requests: NonNullable<AssistantLifeGenerationDiagnostic['requests']>) => void;
  save: (paper: NearStatusPaper, canSave: () => Promise<boolean>) => Promise<NearStatusSaveResult>;
}): Promise<{ status: 'success' | 'failure' | 'skipped' | 'handoff' | 'waiting'; requests: number; failureReason?: AssistantLifeGenerationFailureReason;
  interruptionReason?: string; saveResult?: NearStatusSaveResult;
  requestDiagnostics: NonNullable<AssistantLifeGenerationDiagnostic['requests']>;
  papers: Awaited<ReturnType<typeof fetchAssistantLifeCompletion>>[] }> {
  const controller = new AbortController();
  const restored = input.continuation;
  if (restored?.received && (!input.materials.chatSource || input.sleepTransition)) throw new Error('near-status-received-source-missing');
  const useQwen = !input.sleepTransition && (Boolean(input.materials.chatSource) || isSiliconQwenChatConnection(input.connection));
  const early = (status: 'skipped' | 'waiting', interruptionReason: string) => ({ status, interruptionReason,
    requests: restored?.usedRequests ?? 0, papers: [], requestDiagnostics: restored?.requests ?? [] });
  let fixedChat: SubjectiveMessage[] = [];
  if (useQwen) {
    if (!input.materials.chatSource) return early('skipped', 'qwen-legacy-source-unavailable');
    try { fixedChat = await readQwenChatSource(input.materials.chatSource, loadChatSessionMessage, restored?.received ? undefined : input.connection); }
    catch (error) { return early(isQwenChatSourceDeferred(error) ? 'waiting' : 'skipped',
      isQwenChatSourceDeferred(error) ? 'qwen-chat-source-waiting' : 'chat-source-changed'); }
  }
  const capability = await loadToolProviderCapabilities(input.connection);
  const thinkingMode = isOfficialDeepSeekV4Connection(input.connection) ? 'disabled' : undefined;
  const policy = buildToolAgentProviderRequestPolicy({ capabilities: capability.capabilities,
    connection: input.connection, strictToolsRequested: false, thinkingMode });
  let waiting = false;
  const opportunity = input.sleepTransition || restored && !restored.sleep ? null : await createNearStatusSleepOpportunity({ now: input.now, epoch: input.dataEpoch,
    operationId: useQwen ? input.generationKey : `${input.generationKey}:${input.now}`, signal: controller.signal, resume: restored?.sleep,
    receivedHandoff: restored?.received?.kind === 'sleep_message' });
  try {
  const scheduleSources = restored?.scheduleSources ?? (useQwen ? input.materials.scheduleItems.map(item => ({
    ...ownScheduleItemRef(item), planVersion: input.materials.scheduleVersions[item.id],
    planRevision: item.execution?.planRevision ?? 0, started: !!item.execution && item.execution.status !== 'planned',
    ...(item.execution?.activityId ? { activityId: item.execution.activityId } : {}),
  })) : undefined);
  const canSleep = Boolean(opportunity && policy.nativeToolsEnabled);
  assertToolAgentProviderSupportsCandidates(capability.capabilities, thinkingMode,
    !!opportunity || (!input.sleepTransition && !!Object.keys(input.materials.scheduleVersions ?? {}).length));
  let canSchedule = !input.sleepTransition && policy.nativeToolsEnabled && !!Object.keys(input.materials.scheduleVersions ?? {}).length;
  let canWrite = canSleep || canSchedule;
  const offeredTools = [...(canSleep ? [sleepScheduleToolFor('whole')] : []), ...(canSchedule ? [nearStatusScheduleTool()] : [])];
  const envelope = await buildAssistantStatePairEnvelope({ contextSource: 'assistant-life.state', materialPrompt: '', profile: input.profile });
  const sleepFacts = restored?.sleepFacts ?? (canSleep ? await buildSleepFactsMaterial(opportunity!.context) : '');
  const mixedTools = restored?.mixedTools ?? (canSleep && canSchedule);
  const facts = [input.materials.material, sleepFacts,
    mixedTools ? '这一轮，作息工具和日程工具只允许使用其中一种。' : ''].filter(Boolean).join('\n\n');
  const sleeping = isSleepingTransition(input.sleepTransition);
  const originalTask = sleeping ? SLEEP_NEAR_STATUS_TASKS.sleeping : buildNearStatusTask(input.materials.counterEnabled);
  const buildBase = (task: string): OpenAiCompatibleRequestMessage[] => useQwen
    ? buildQwenChatLayout([envelope.stableSystemPrompt, facts], fixedChat, [task])
    : [{ role: 'system', content: envelope.stableSystemPrompt }, { role: 'system', content: facts }, { role: 'system', content: task }];
  const messages: OpenAiCompatibleRequestMessage[] = buildBase(originalTask);
  if (sleeping && input.materials.sleepConversation) {
    const withRound = messages.map((message, index) => index === 1 ? { ...message, content: `${facts}\n\n${input.materials.sleepConversation}` } : message);
    if (estimateApiMessagesTokens(withRound) + 700 + 512 <= (input.connection.contextWindowTokens ?? 65536)) messages[1] = withRound[1];
  }
  const readControlKey = async () => {
    const [state, sleep] = await Promise.all([loadAssistantState(), readSleepSchedule(input.now)]);
    return JSON.stringify([state.lifeMode, state.manualSleepUntil, state.manualWakeUntil,
      sleep?.nightKey, sleep?.revision]);
  };
  const controlKey = restored?.controlKey ?? (opportunity ? '' : await readControlKey());
  let adoptingPaper = false;
  let interruptionReason: string | undefined;
  let saveResult: NearStatusSaveResult | undefined;
  const receivedHandoffMessageId = async () => {
    if (!useQwen || !input.materials.chatSource || received?.kind !== 'sleep_message'
      || tool?.toolId !== sleepScheduleWriteTool.id || !tool.receipt.ok || !opportunity) return undefined;
    const snapshot = opportunity.snapshot(), handoff = snapshot.handoff;
    if (!handoff || !snapshot.savedResult?.ok || snapshot.savedResult.subject !== 'I'
      || handoff.nightKey !== snapshot.context.nightKey || handoff.sessionId !== snapshot.sessionId
      || handoff.sessionId !== input.materials.chatSource.sessionId
      || handoff.messageId !== `sleep-plan:${handoff.nightKey}:prepare`) return undefined;
    try {
      const night = await loadAssistantLifeDay(handoff.nightKey), prepare = night?.nightSleepPlan?.prepare;
      if (night?.dateKey !== handoff.nightKey || night.nightSleepPlan?.revision !== snapshot.expectedRevision
        || !prepare?.toolResult?.ok || prepare.toolResult.subject !== 'I' || prepare.requestCount !== 1
        || prepare.sessionId !== handoff.sessionId || prepare.messageId !== handoff.messageId
        || !['requesting', 'complete'].includes(prepare.status) || prepare.toolCall?.callId !== tool.callId
        || JSON.stringify(prepare.toolCall.input) !== JSON.stringify(tool.input)) return undefined;
      const message = await loadChatSessionMessage(handoff.sessionId, handoff.messageId);
      return message?.id === handoff.messageId && message.role === 'I' && message.source === 'proactive-message'
        && message.content === received.content.trim() ? handoff.messageId : undefined;
    } catch { throw new QwenChatSourceUnavailable(); }
  };
  const valid = async () => {
    const invalid = (reason: string) => { interruptionReason = reason; return false; };
    if (controller.signal.aborted) return invalid('request-cancelled');
    if (!canCommitBackupRestoreDataEpoch(input.dataEpoch)) return invalid('data-epoch-changed');
    if (isChatReplyInFlight()) return invalid('chat-started');
    if (!isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())) return invalid('automatic-calls-disabled');
    if (restored?.sleep && !opportunity) return invalid('sleep-opportunity-unavailable');
    if (input.sleepTransition && (((await loadAssistantState()).lifeMode === 'sleeping') !== sleeping
      || Date.now() - input.sleepTransition.at >= 30 * 60_000)) return invalid('sleep-state-changed');
    if (!adoptingPaper && ((await loadAssistantState()).cloudForm ?? 'white') !== input.materials.cloudForm) return invalid('cloud-form-changed');
    if (input.sleepTransition && !await sleepTransitionMatches(input.sleepTransition)) return invalid('sleep-transition-changed');
    if (sleeping && await sleepTransitionConversationKey(input.sleepTransition!) !== input.materials.chatKey) return invalid('chat-source-changed');
    if (input.materials.chatSource) {
      try { if (!await nearStatusChatSourceMatches(input.materials.chatSource, input.materials.chatKey,
        await receivedHandoffMessageId())) return invalid('chat-source-changed'); }
      catch (error) { if (isQwenChatSourceDeferred(error)) { waiting = true; throw error; } return invalid('chat-source-changed'); }
    }
    if (!sleeping && !input.materials.chatSource && (await loadNearStatusConversation()).key !== input.materials.chatKey) return invalid('chat-source-changed');
    if (!await nearStatusFactsStillMatch(input.materials)) return invalid('life-source-changed');
    if (!adoptingPaper && input.materials.thoughtRef && fingerprintPromptText(JSON.stringify((await loadJunluoThoughtState()).thoughts
      .find(t => t.thoughtId === input.materials.thoughtRef!.id) ?? null)) !== input.materials.thoughtRef.revision) return invalid('thought-source-changed');
    if (!(opportunity ? await opportunity.canContinue() : controlKey === await readControlKey())) return invalid('sleep-opportunity-or-arrangement-changed');
    return true;
  };
  let requests = restored?.usedRequests ?? 0;
  const requestDiagnostics: NonNullable<AssistantLifeGenerationDiagnostic['requests']> = restored?.requests.map(item => ({ ...item })) ?? [];
  while (requestDiagnostics.length < requests) requestDiagnostics.push({ paper: 'visible', status: 'failure', outputChars: 0 });
  let continueWithTool = !!restored?.tool;
  let tool = restored?.tool;
  let received = restored?.received;
  let nextOrdinal: 2 | 3 | undefined = restored?.nextOrdinal;
  let retryAllowed = restored?.retryAllowed ?? false;
  let retryable = false;
  let status: 'success' | 'failure' | 'skipped' | 'handoff' = 'skipped';
  let failureReason: AssistantLifeGenerationFailureReason | undefined = 'invalid-json';
  const papers: Awaited<ReturnType<typeof fetchAssistantLifeCompletion>>[] = [];
  const appendReceipt = () => {
    if (!tool) return;
    if (opportunity?.handoff) {
      if (useQwen) messages.splice(0, messages.length, ...buildBase(NEAR_STATUS_SLEEP_MESSAGE_PROMPT));
      else messages.splice(2, 1);
    }
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: tool.callId, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.input) } }],
      ...(capability.capabilities.reasoningReplay !== 'unsupported' && tool.reasoningContent !== undefined
        ? { reasoning_content: tool.reasoningContent } : {}) });
    messages.push({ role: 'tool', tool_call_id: tool.callId, content: JSON.stringify(tool.receipt) });
    if (opportunity?.handoff && !useQwen) messages.push({ role: 'system', content: NEAR_STATUS_SLEEP_MESSAGE_PROMPT });
  };
  const persistContinuation = async (ordinal: 2 | 3, inFlight = false) => {
    const { scheduleVersions: _versions, scheduleItems: _items, opportunityRefs: _refs, ...materials } = input.materials;
    try { await input.onContinuation?.({ nextOrdinal: ordinal, usedRequests: inFlight ? ordinal : requests,
      ...(inFlight ? { inFlight: true as const } : {}), retryAllowed, materials, controlKey, sleepFacts, mixedTools,
      sleep: opportunity?.snapshot(), tool, ...(useQwen && received ? { received } : {}),
      ...(useQwen && (tool?.toolId === 'schedule.save_own' || received?.kind === 'tool_instruction' && received.toolId === 'schedule.save_own')
        && scheduleSources?.length ? { scheduleSources } : {}), requests: requestDiagnostics }); }
    catch (error) { waiting = true; throw error; }
  };
  const adoptSavedSchedules = async (batch: import('../schedule/ownedDayPlanStore').OwnedDayPlanBatch) => {
    const savedEntries = new Map(batch.entries.filter(entry => entry.saved).map(entry => [entry.targetScheduleId, entry]));
    const savedIds = new Set<string>();
    const store = await import('../schedule/scheduleStore');
    for (const ref of input.materials.scheduleRefs ?? []) if (savedEntries.has(ref.id)) {
      const entry = savedEntries.get(ref.id)!;
      const item = await store.loadScheduleItemById(ref.id);
      const original = input.materials.scheduleItems?.find(value => value.id === ref.id);
      const source = scheduleSources?.find(value => value.id === ref.id);
      if (useQwen && (!source || entry.sourcePlanVersion !== source.planVersion)) continue;
      const wasStarted = source?.started ?? (!!original?.execution && original.execution.status !== 'planned');
      const expectedRevision = (source?.planRevision ?? original?.execution?.planRevision ?? 0)
        + (entry.action === 'cancel' && !wasStarted ? 0 : 1);
      if (item && item.owner === entry.owner && item.title === entry.title && item.notes === entry.notes
        && item.startAt === entry.startAt && item.endAt === entry.endAt
        && (item.readingId ?? null) === (entry.readingId ?? null) && (item.habitId ?? null) === (entry.habitId ?? null)
        && item.status === (entry.action === 'cancel' ? 'cancelled' : 'pending')
        && (item.execution?.planRevision ?? 0) === expectedRevision
        && (!wasStarted || item.execution?.adjustment?.operationId === entry.id
          || item.execution?.durationChange?.operationId === entry.id)) {
        Object.assign(ref, ownScheduleItemRef(item)); savedIds.add(ref.id);
      }
    }
    const affected = useQwen ? (scheduleSources ?? []).filter(source => savedIds.has(source.id)).map(source => source.activityId).filter(Boolean)
      : input.materials.scheduleItems?.filter(item => savedIds.has(item.id)).map(item => item.execution?.activityId).filter(Boolean) ?? [];
    input.materials.activityRefs = (input.materials.activityRefs ?? []).filter(ref => !affected.some(id =>
      ref.id.startsWith('reading-current:') && ref.id.endsWith(`:${id}`) || ref.id === `focus-current:${id}`));
  };
  const recoverScheduleReceipt = async () => {
    const instruction = tool ?? (received?.kind === 'tool_instruction' ? received : undefined);
    if (!useQwen || instruction?.toolId !== 'schedule.save_own') return;
    const callId = `home-schedule:${fingerprintPromptText(JSON.stringify([input.generationKey, instruction.callId]))}`;
    const audit = await (await import('../tools/toolAuditStore')).loadToolAuditRecord(callId);
    const saved = audit?.scheduleSave;
    if (saved && (audit.toolId !== instruction.toolId || saved.dataEpoch !== input.dataEpoch || saved.batch.opId !== callId)) {
      interruptionReason = 'life-source-changed'; return;
    }
    const receiptBatch = tool?.receipt.data as import('../schedule/ownedDayPlanStore').OwnedDayPlanBatch | undefined;
    const originalBatch = saved?.batch ?? (receiptBatch?.opId === callId ? receiptBatch : undefined);
    if (originalBatch) {
      if (!scheduleSources?.length) { interruptionReason = 'life-source-changed'; return; }
      const batch = await (await import('../schedule/ownedDayPlanStore')).reconcileOwnedDayPlanBatch(originalBatch);
      await adoptSavedSchedules(batch);
      if (!tool) {
        if (!batch.entries.some(entry => entry.saved) && saved?.stage !== 'failed') {
          if (!await ownScheduleConflictRefsMatch(input.materials.scheduleRefs)) interruptionReason = 'life-source-changed';
          else { waiting = true; interruptionReason = 'generation-or-local-save-error'; }
          return;
        }
        const ok = batch.entries.every(entry => entry.saved && !entry.choiceError);
        const summary = (await import('../schedule/ownScheduleSave')).ownScheduleSaveSummary({ ...saved!, batch });
        tool = { subject: 'I', callId: instruction.callId, toolId: instruction.toolId, name: instruction.name,
          input: instruction.input, reasoningContent: instruction.reasoningContent,
          receipt: { callId: instruction.callId, toolId: instruction.toolId, ok, status: ok ? 'success' : 'error', summary,
            data: batch, ...(!ok ? { errorCode: 'EXECUTION_FAILED' } : {}) } };
        received = undefined; continueWithTool = true; retryAllowed = true;
      }
      await persistContinuation(nextOrdinal ?? 2);
      return;
    }
    if (received?.kind === 'tool_instruction') {
      if (!scheduleSources?.length) { interruptionReason = 'life-source-changed'; return; }
      const store = await import('../schedule/scheduleStore');
      for (const source of scheduleSources) {
        const item = await store.loadScheduleItemById(source.id);
        if (!item || ownScheduleItemRef(item).revision !== source.revision || store.schedulePlanVersion(item) !== source.planVersion) {
          interruptionReason = 'life-source-changed'; return;
        }
        input.materials.scheduleItems.push(item); input.materials.scheduleVersions[source.id] = source.planVersion;
      }
      canSchedule = policy.nativeToolsEnabled; canWrite = canSleep || canSchedule;
    }
  };
  const recoverSleepReceipt = async () => {
    const instruction = tool ?? (received?.kind === 'tool_instruction' ? received : undefined);
    if (!useQwen || instruction?.toolId !== sleepScheduleWriteTool.id || !opportunity || opportunity.snapshot().savedResult?.ok) return;
    const data = await opportunity.reconcileReceivedDecision?.(instruction.input, instruction.callId);
    if (!data) return;
    const result = createToolSuccessResult({ callId: instruction.callId, toolId: instruction.toolId,
      input: instruction.input, requestedBy: 'life_agent', createdAt: Date.now() }, '', data);
    tool = { subject: 'I', callId: instruction.callId, toolId: instruction.toolId, name: instruction.name,
      input: instruction.input, reasoningContent: instruction.reasoningContent,
      receipt: { callId: instruction.callId, toolId: instruction.toolId, ok: true, status: result.status, summary: result.summary, data } };
    received = undefined; continueWithTool = true; retryAllowed = !opportunity.handoff; nextOrdinal = 2;
    await persistContinuation(2);
  };
  const adoptReceived = async () => {
    if (!received || !await valid()) return;
    waiting = false;
    if (received.kind === 'sleep_message') {
      if (containsToolProtocolMarkup(received.content)) {
        received = undefined; nextOrdinal = undefined; status = 'failure'; failureReason = 'invalid-json'; return;
      }
      if (opportunity?.handoff && await opportunity.finishHandoff(received.content, useQwen)) {
        received = undefined; nextOrdinal = undefined; status = 'handoff'; failureReason = undefined;
        return true;
      } else interruptionReason = 'sleep-handoff-changed';
      return;
    }
    const invocation = received;
    const scheduling = invocation.toolId === 'schedule.save_own';
    if (!canWrite || scheduling && !canSchedule || !scheduling && (invocation.toolId !== sleepScheduleWriteTool.id || !canSleep)) {
      interruptionReason = 'tool-permission-changed'; return;
    }
    if (!getToolDefinition(sleepScheduleWriteTool.id)) registerToolPackage(sleepScheduleToolPackage);
    if (scheduling && !getToolDefinition(invocation.toolId)) registerToolPackage((await import('../tools/builtin/scheduleTools')).scheduleToolPackage);
    const host = scheduling ? await (await import('../tools/ownScheduleTurn')).createOwnScheduleTurn({ dataEpoch: input.dataEpoch!, signal: controller.signal,
      lifeAgent: true, nearStatus: { allowedIds: Object.keys(input.materials.scheduleVersions ?? {}) },
      scheduleVersions: input.materials.scheduleVersions, isCurrent: valid, onSchedulesSaved: adoptSavedSchedules }) : null;
    const result = await executeToolCall({ callId: scheduling ? `home-schedule:${fingerprintPromptText(JSON.stringify([input.generationKey, invocation.callId]))}` : invocation.callId,
      toolId: invocation.toolId, input: invocation.input, requestedBy: 'life_agent', createdAt: Date.now() }, scheduling
      ? { ownSchedule: host!.execute, ownScheduleScope: 'near-status' } : { sleepScheduleDecision: opportunity!.commit });
    if (useQwen && !scheduling && !result.ok) {
      await recoverSleepReceipt();
      if (!received) { appendReceipt(); return; }
    }
    tool = { subject: 'I', callId: invocation.callId, toolId: invocation.toolId,
      name: invocation.name, input: invocation.input, reasoningContent: invocation.reasoningContent, receipt: {
      callId: invocation.callId, toolId: invocation.toolId, ok: result.ok, status: result.status,
      summary: result.summary, ...(result.data ? { data: result.data } : {}), ...(result.error ? { errorCode: result.error.code } : {}),
    } };
    // Retain the actual receipt before any further local source read can fail.
    received = undefined; retryAllowed = !opportunity?.handoff; nextOrdinal = 2;
    if (useQwen) await persistContinuation(2);
    if (scheduling) {
      const batch = result.data as import('../schedule/ownedDayPlanStore').OwnedDayPlanBatch | undefined;
      if (batch?.entries) await adoptSavedSchedules(batch);
    }
    appendReceipt(); continueWithTool = true;
    await persistContinuation(2);
  };
  const attempt = async (ordinal: 1 | 2 | 3, admission: AiRequestAdmission) => {
    retryable = false;
    let deferred: unknown;
    try {
      if (!await valid()) return;
      if (input.materials.chatSource) await readQwenChatSource(input.materials.chatSource, loadChatSessionMessage, input.connection);
      if ((input.materials.scheduleRefs?.length || useQwen) && estimateApiMessagesTokens(messages)
        + estimateTextTokens(JSON.stringify(ordinal === 1 ? offeredTools.map(tool => toolDefinitionToOpenAiTool(tool)) : []))
        + 600 + 512 > (policy.connection.contextWindowTokens ?? 65536)) {
        interruptionReason = 'schedule-material-capacity'; failureReason = undefined; return;
      }
      const shortJsonRequest = buildAssistantLifeShortJsonRequest(policy.connection, sleeping ? 0.45 : 0.75);
      const { thinking: _legacyThinking, ...shortJsonSampling } = shortJsonRequest;
      const completion = await fetchAssistantLifeCompletion({ apiKey: input.apiKey, connection: policy.connection,
        toolCapabilitySource: capability.source,
        contextSource: 'assistant-life.state', metricContextSource: 'inner.near-status', envelope, userPrompt: '', apiMessagesOverride: messages,
        signal: controller.signal, timeoutMs: sleeping ? 25_000 : ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS,
        request: { ...(input.sleepTransition ? shortJsonRequest : shortJsonSampling),
          ...(!input.sleepTransition ? buildToolProviderTransportParameters(policy.connection, thinkingMode) : {}),
          // The full third paper includes thoughts/counter; a sleep handoff is still a short message.
          ...(opportunity?.handoff ? {} : { max_tokens: sleeping ? 700 : 600 }),
          ...(ordinal === 1 && canWrite ? { tools: offeredTools.map(tool => toolDefinitionToOpenAiTool(tool)),
            ...(policy.toolChoice ? { tool_choice: policy.toolChoice } : {}) } : {}) },
        onRequestStart: async assertTransportReady => {
          try { await admission.beforeTransport(async () => {
            if (!await valid()) throw new Error('near-status-stale');
            if (ordinal === 1) await input.onRequestStart();
            else {
              await persistContinuation(ordinal, true);
              if (opportunity?.handoff) await opportunity.onHandoffRequestStart();
            }
            status = 'failure';
          }, async () => {
            if (input.materials.chatSource) await readQwenChatSource(input.materials.chatSource, loadChatSessionMessage, input.connection);
            await assertTransportReady?.();
          });
          if (opportunity?.handoff) await opportunity.onHandoffTransportPrepared();
          } catch (error) {
            if (opportunity?.handoff) await opportunity.onHandoffUnsent();
            if (isAiCostDeferred(error) || isQwenChatSourceDeferred(error)) { deferred = error;
            interruptionReason = isAiCostDeferred(error) ? error.reason : 'qwen-chat-source-waiting'; } throw error; }
        },
        onTransportAttempt: transport => {
          if (transport.outcome === 'started') requests += 1;
          requestDiagnostics[ordinal - 1] = { paper: 'visible', outputChars: 0, status: 'failure', transport };
          input.onTransportAttempt?.(requestDiagnostics.map(item => ({ ...item })));
        },
      });
      papers.push(completion);
      Object.assign(requestDiagnostics[ordinal - 1], { outputChars: completion.content.length,
        finishReason: completion.finishReason, promptTokens: completion.usage.promptTokens,
        completionTokens: completion.usage.completionTokens, cachedPromptTokens: completion.usage.cachedPromptTokens });
      try { if (!await valid()) { failureReason = 'aborted'; return; } }
      catch (error) { if (!isQwenChatSourceDeferred(error)) throw error; }
      const raw = completion.payload.choices?.[0]?.message as (OpenAiCompatibleToolCallMessage & { reasoning_content?: string }) | undefined;
      const parsed = parseOpenAiToolCalls(raw ?? {}, offeredTools);
      if (parsed.rawCallCount) {
        if (ordinal !== 1 || !canWrite || parsed.errors.length || parsed.invocations.length !== 1) return;
        const invocation = parsed.invocations[0];
        requestDiagnostics[ordinal - 1].status = 'success';
        received = { subject: 'I', kind: 'tool_instruction', callId: invocation.callId, toolId: invocation.toolId,
          name: raw!.tool_calls![0].function!.name!, input: invocation.input,
          ...(capability.capabilities.reasoningReplay === 'required_for_tool_calls'
            ? { reasoningContent: completion.reasoningContent }
            : capability.capabilities.reasoningReplay !== 'unsupported' && typeof raw?.reasoning_content === 'string'
              ? { reasoningContent: raw.reasoning_content } : {}) };
        nextOrdinal = 2; retryAllowed = false;
        if (useQwen) await persistContinuation(2);
        await adoptReceived();
        return;
      }
      if (containsToolProtocolMarkup(completion.content)) {
        failureReason = 'invalid-json'; retryable = !opportunity?.handoff; return;
      }
      if (opportunity?.handoff) {
        const value = readJsonObjects(completion.content)[0] as { message?: unknown } | undefined;
        const message = typeof value?.message === 'string' ? cleanAssistantMessageContent(value.message).trim() : '';
        if (message && !containsToolProtocolMarkup(message)) {
          requestDiagnostics[ordinal - 1].status = 'success';
          received = { subject: 'I', kind: 'sleep_message', content: message };
          if (useQwen) await persistContinuation(2);
          await adoptReceived();
        }
      } else {
        const sleepDraft = sleeping ? parseSleepNearStatus(completion.content) : null;
        const paper = sleeping ? sleepDraft ? { nearStatus: sleepDraft, issues: [] } : null
          : parseNearStatusPaper(completion.content, { counterEnabled: input.materials.counterEnabled, thoughtId: input.materials.thoughtRef?.id });
        if (!paper || paper.nearStatus && (containsToolProtocolMarkup(paper.nearStatus.title)
          || containsToolProtocolMarkup(paper.nearStatus.activity))) {
          failureReason = completion.content.trim() ? 'invalid-json' : 'empty-content'; retryable = true; return;
        }
        requestDiagnostics[ordinal - 1].status = 'success';
        // The journal checks source revisions per basket, excluding its own successful writes.
        adoptingPaper = true;
        try { if (!await valid()) { failureReason = 'aborted'; return; } }
        catch (error) { if (!isQwenChatSourceDeferred(error)) throw error; }
        // The runtime owns the journal and the three local-save retries.
        saveResult = await input.save(paper, valid);
        status = saveResult.status === 'saved' ? 'success' : 'failure';
        interruptionReason = saveResult.interruptionReason;
        failureReason = saveResult.status === 'saved' ? undefined : 'aborted';
      }
    } catch (error) {
      if (deferred) { waiting = true; throw deferred; }
      if (isQwenChatSourceDeferred(error)) { waiting = true; interruptionReason = 'qwen-chat-source-waiting'; return; }
      if (useQwen && (received || tool?.toolId === 'schedule.save_own' && !(error instanceof AssistantLifeRequestError))) {
        waiting = true; interruptionReason = 'generation-or-local-save-error'; return;
      }
      if (ordinal > 1 && requests < ordinal) {
        waiting = true;
        await persistContinuation(ordinal as 2 | 3).catch(() => undefined);
        return;
      }
      failureReason = error instanceof AssistantLifeRequestError ? error.failureReason : 'aborted';
      if (!(error instanceof AssistantLifeRequestError)) interruptionReason ??= 'generation-or-local-save-error';
      // Only a transport failure can retry here, never local saving or invalidated sources.
      retryable = !adoptingPaper && error instanceof AssistantLifeRequestError && requests >= ordinal
        && requestDiagnostics[ordinal - 1]?.transport?.outcome !== 'aborted';
    } finally {
      const diagnostic = requestDiagnostics[ordinal - 1];
      if (diagnostic?.status === 'failure') diagnostic.reason = failureReason;
      if (retryable && (ordinal === 1 || ordinal === 2 && continueWithTool && retryAllowed)) {
        nextOrdinal = ordinal === 1 ? 2 : 3;
        await persistContinuation(nextOrdinal);
      }
    }
  };
    if (restored) {
      try { await recoverScheduleReceipt(); await recoverSleepReceipt(); }
      catch { waiting = true; interruptionReason = 'generation-or-local-save-error'; }
      if (waiting || interruptionReason) return { status: waiting ? 'waiting' : status,
        requests, papers, requestDiagnostics, interruptionReason, failureReason: waiting ? undefined : failureReason };
    }
    if (tool) appendReceipt();
    if (!await valid()) return { status, requests, papers, requestDiagnostics, interruptionReason };
    if (restored) {
      if (received) {
        let handoffAdopted = false;
        try { handoffAdopted = await adoptReceived() === true; }
        catch { waiting = true; interruptionReason ??= 'generation-or-local-save-error'; }
        if (waiting || received || handoffAdopted) return { status: waiting ? 'waiting' : status,
          requests, papers, requestDiagnostics, interruptionReason, failureReason: waiting ? undefined : failureReason };
      }
      // A killed transport consumed its original ordinal; only the already permitted tool-body retry remains.
      if (restored.inFlight) {
        if (restored.nextOrdinal !== 2 || !restored.tool || !restored.retryAllowed) {
          return { status: 'failure', requests, papers, requestDiagnostics, interruptionReason: 'continuation-requests-exhausted' };
        }
        nextOrdinal = 3;
        await persistContinuation(3);
      }
      while (nextOrdinal) {
        const ordinal = nextOrdinal;
        nextOrdinal = undefined;
        const before = requests;
        const result = await runBudgetedAiCall('lifeStatePolish', 'background', admission => attempt(ordinal, admission), {
          connection: policy.connection, dataEpoch: input.dataEpoch, purpose: 'home-status',
          continuation: { generationKey: input.generationKey, nextRequest: ordinal },
          shouldRecordSuccess: () => requests > before,
        });
        if (result.ok === false) { waiting = true; interruptionReason = result.reason; break; }
        if (adoptingPaper || !retryable) break;
      }
    } else if (!input.sleepTransition) {
      const result = await runBudgetedAiCallPair('lifeStatePolish', admission => attempt(1, admission), admission => attempt(2, admission), {
      connection: policy.connection, dataEpoch: input.dataEpoch, purpose: 'home-status', shouldContinue: () => continueWithTool || retryable,
      shouldRecordAttempt: ordinal => requests >= ordinal,
      ...(canWrite ? { retrySecond: {
        run: admission => attempt(3, admission),
        shouldRun: () => continueWithTool && retryable && !opportunity?.handoff && !adoptingPaper,
        shouldRecordAttempt: () => requests >= 3,
      } } : {}),
      });
      if (result.ok === false && (waiting || String(result.reason).startsWith('cost-'))) {
        waiting = true; interruptionReason = result.reason;
      }
    } else {
      const result = await runBudgetedAiCall('sleepNearStatus', 'background', admission => attempt(1, admission), {
        connection: policy.connection, dataEpoch: input.dataEpoch, purpose: 'home-status', shouldRecordSuccess: () => requests > 0,
      });
      if (!result.ok && 'reason' in result && String(result.reason).startsWith('cost-')) {
        waiting = true; interruptionReason = result.reason;
      }
    }
    return { status: waiting ? 'waiting' : status, requests, papers, failureReason: waiting ? undefined : failureReason,
      interruptionReason, saveResult, requestDiagnostics };
  } catch (error) {
    // A temporary source/journal read failure is not evidence that a saved handoff was cancelled.
    if (restored) waiting = true;
    throw error;
  } finally { controller.abort(); await opportunity?.dispose(waiting); }
}
