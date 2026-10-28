import { relationshipAuthorizationStorageBridge as AsyncStorage } from '../sync/syncRelationshipAuthorizationStorageBridge';
import { saveLegacyProactiveFields, saveProactiveSettingsFields } from './unifiedContactStore';
import { runUnifiedContact } from './unifiedContactDispatch';
import * as Notifications from 'expo-notifications';
import { DeviceEventEmitter } from 'react-native';

import { buildCompiledSystemPromptResult } from '../ai/builtInSystemPrompt';
import { replaceCompiledMemoryContext } from '../ai/persona/promptCompiler';
import { createMemoryUsageReceipt, settleSavedMemoryUsage, type MemoryUsageReceipt } from '../memory/memoryReplyUsage';
import { runBudgetedAiCallPair } from '../ai/aiCallBudget';
import { PhoneGuardStop, runPhoneGuardDelivery, type PhoneGuardEvent } from './phoneGuardDelivery';
import { registerPhoneCareFollowUp, runPhoneCareFollowUp } from './phoneCareFollowUpRuntime';
import {
  getPromptContextProfileForSource,
  getPromptOutputAudienceForSource,
  type PromptContextSource,
} from '../ai/promptContextProfile';
import {
  buildGlobalCognitionContext,
  shouldSuppressOrdinaryProactive,
  type GlobalCognitionContext,
} from '../ai/globalCognition';
import { buildChatModelParameterPayload } from '../ai/modelParameters';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';
import { recordPromptRuntimeSnapshot } from '../ai/promptDiagnostics';
import { loadAssistantState } from '../ai/assistantState';
import { loadAiConfigPreferencesSnapshot, resolveLifeCreativeConfig } from '../ai/AiConfigPreferences';
import {
  clearPendingPhoneActivityFocusTrigger,
  getPhoneGuardEvent,
  claimPhoneGuardAttempt,
  finishPhoneGuardEvent,
  updatePhoneGuardEventMessage,
  consumeLastPhoneActivityOverlayExit,
  consumePendingPhoneActivityFocusTrigger,
  type InstalledPhoneApp,
} from '../backend/phoneActivityNative';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import {
  isAutomaticRemoteAiAllowed,
  loadAutomaticRemoteAiPolicy,
} from '../runtime/automaticRemoteAiPolicy';
import { executeAgentToolCall } from '../tools/toolAgentExecution';
import {
  loadDueAgentTasks,
  type JunLuoAgentTaskRecord,
} from './agentTaskStore';
import { executeProactiveAgentTaskHandlingOnce } from './proactiveMessageExecutionOnce';
import { createProactiveAgentTaskMessageIdPrefix } from './proactiveMessageExecutionOnceCore';
import { runPhoneActivityPendingProbe } from './phoneActivityPendingProbe';
import {
  buildApiMessages,
  cleanAssistantMessageContent,
  createIMessagesFromApiResponse,
  parseAssistantMessageBubbles,
  type GenerationDiagnostics,
  type SubjectiveMessage,
} from '../ai/subjectiveMessages';
import type { AiConnection, AiProfile } from '../ai/types';
import {
  recordBaiyunCareDelivery,
} from '../ai/behavior/actionExecutionRuntime';
import { loadActiveFocusSession } from '../focus/focusStore';
import { appendMessagesToChatSession, loadChatState, loadChatStateFast } from '../chat/chatStorage';
import { emitChatMessagesAppended } from '../chat/chatMessageEvents';
import { hasPendingSleepingReply } from '../chat/sleepInteraction';
import { JUNLUO_DESIRE_VISIBLE_THRESHOLD, type JunluoDesireEffectiveSnapshot } from '../life/junluoDesireMetabolism';
import { loadJunluoDesireSnapshot } from '../life/junluoDesireRuntime';
import type { JunluoDesireId } from '../life/junluoInnerState';
import { loadJunluoAffectState } from '../life/junluoInnerStateStore';
import { isJunluoAutomaticRelationshipOutletAllowed } from '../life/junluoRelationshipPolicy';
import { youPortraitAssets } from '../assets/youPortraitAssets';
import {
  attachPhoneActivityTriggerEventState,
  findPhoneActivityTrigger,
  loadPhoneActivityProactiveSettings,
  isJunLuoPhoneApp,
  markPhoneActivityTrigger,
  recordPhoneActivityOverlayExit,
  type PhoneActivityJealousyCandidate,
  type PhoneActivityRule,
  type PhoneActivityTrigger,
} from './phoneActivityRules';
import {
  buildPhoneJealousyDismissalMessagePrompt,
  buildPhoneJealousyDismissedReactionPrompt,
  buildPhoneJealousyCandidateUserPrompt,
  PHONE_JEALOUSY_CANDIDATE_SYSTEM_PROMPT,
  PHONE_JEALOUSY_DEFAULT_REASON,
  PHONE_JEALOUSY_DISMISSAL_MESSAGE_FALLBACK,
  PHONE_JEALOUSY_DISMISSED_REACTION_USER_PROMPT,
} from './phoneJealousyPrompt';
import {
  recordActiveMessageDelivery,
  requestActiveMessageSlot,
  type ActiveMessagePriority,
  type ActiveMessageSource,
} from './activeMessageCoordinator';
import { EXTERNAL_ACTION_COMPLETION_CLAIM_PATTERN, formatProactiveIdleDuration, type ProactiveLiteNormalizationDiagnostics, type ProactiveLiteParseResult } from './proactiveLitePrompt';
import {
  buildPhoneActivityLitePrompt,
  fallbackPhoneActivityLiteMessages,
  parsePhoneActivityLiteResponseWithDiagnostics,
} from './phoneActivityPrompt';
import { scheduleNativeIncomingCall } from '../backend/incomingCallNative';
import { readEffectiveUserRoutineRange, readUserRoutine } from '../schedule/userRoutineStore';
import { isAutonomousCallRoutineTimeAllowed } from '../voiceCall/voiceCallIncomingPolicy';
import { fetchVoiceCallReadiness } from '../voiceCall/voiceCallRoomClient';
import { loadVoiceCallSettings } from '../voiceCall/voiceCallSettings';
import {
  countAutonomousCallsToday,
  createVoiceCallInvitation,
  latestAutonomousVoiceCallAt,
  updateVoiceCallInvitationNativeTaskId,
  updateVoiceCallInvitationStatus,
} from '../voiceCall/voiceCallInvitationStore';
import {
  randomAutonomousCallDelay,
  shouldScheduleAutonomousCall,
} from '../voiceCall/voiceCallIncomingPolicy';

const SETTINGS_KEY = 'junluo.proactiveMessage.settings';
const STATE_KEY = 'junluo.proactiveMessage.state';
const AUTONOMOUS_DECISION_COOLDOWN_MS = 8 * 60 * 1000;
const AUTONOMOUS_SENT_COOLDOWN_MS = 18 * 60 * 1000;
const PHONE_GUARD_TASK_AI_TIMEOUT_MS = 25 * 1000;
const PHONE_GUARD_PLACEHOLDER = '我正在抓小仓鼠……';
const PHONE_GUARD_TRIGGER_STALE_MS = 30 * 60 * 1000;
const PHONE_GUARD_CHAT_MESSAGE_EVENT = 'junluoPhoneGuardChatMessage';
const MAX_DAILY_DECISIONS = 24;
let pendingProactiveRun: Promise<number> | undefined;
const phoneGuardTaskInFlightIds = new Set<string>();

export type ProactiveNotificationPreview = 'full' | 'private';

export type ProactiveMessageSettings = {
  enabled: boolean;
  firstPromptAnswered: boolean;
  notificationPreview: ProactiveNotificationPreview;
};

type ProactiveMessageState = {
  dateKey: string;
  decisionCount: number;
  lastDecisionAt: number;
  lastSentAt: number;
};

type MaybeSendOptions = {
  apiKey?: string;
  backupRestoreLeaseHeld?: boolean;
  connection?: AiConnection | null;
  phoneActivityOnly?: boolean;
  profile?: AiProfile;
  socialShareOnly?: boolean;
  unifiedSchedulerHeld?: boolean;
  naturalEarlyWakeOwner?: import('../life/sleepPlanRuntime').NaturalEarlyWakeOwner;
};

type ProactiveGenerationResult = {
  diagnostics: GenerationDiagnostics;
  messages: string[];
};

export type PhoneGuardTriggerPayload = {
  appSource: string;
  appTitle: string;
  durationMs: number;
  kind: 'blacklist' | 'blacklist-return' | 'jealousy';
  ruleId: string;
  ruleKind: 'blacklist' | 'jealousy';
  stage: 1 | 2 | 3;
  triggeredAt: number;
  triggerId: string;
};

const defaultSettings: ProactiveMessageSettings = {
  enabled: true,
  firstPromptAnswered: true,
  notificationPreview: 'private',
};

function buildGenerationDiagnostics({
  contextProfile,
  createdAt = Date.now(),
  eventStage,
  parse,
  reasons = [],
  source,
  triggerKind,
  usedDesire,
  usedFallback,
  usedMemory,
  usedPhoneActivity,
  usedRecentMessages,
  usedSchedule,
  wasTruncated,
}: {
  contextProfile: string;
  createdAt?: number;
  eventStage?: string;
  parse?: Partial<ProactiveLiteParseResult | ProactiveLiteNormalizationDiagnostics> & { rawContentChars?: number };
  reasons?: string[];
  source: GenerationDiagnostics['source'];
  triggerKind?: string;
  usedDesire: boolean;
  usedFallback?: boolean;
  usedMemory: boolean;
  usedPhoneActivity?: boolean;
  usedRecentMessages?: boolean;
  usedSchedule: boolean;
  wasTruncated?: boolean;
}): GenerationDiagnostics {
  const mergedReasons = [
    ...(parse?.reasons ?? []),
    ...reasons,
  ].map((reason) => reason.trim()).filter(Boolean);
  return {
    contextProfile,
    createdAt,
    eventStage,
    keptMessageCount: parse?.keptMessageCount,
    rawContentChars: parse?.rawContentChars,
    rawMessageCount: parse?.rawMessageCount,
    reasons: [...new Set(mergedReasons)],
    source,
    triggerKind,
    usedDesire,
    usedFallback,
    usedMemory,
    usedPhoneActivity,
    usedRecentMessages,
    usedSchedule,
    wasTruncated,
  };
}

function emptyProactiveGenerationResult(
  source: GenerationDiagnostics['source'],
  contextProfile: string,
  reasons: string[],
  options: Partial<Pick<GenerationDiagnostics, 'eventStage' | 'rawContentChars' | 'triggerKind' | 'usedDesire' | 'usedFallback' | 'usedMemory' | 'usedPhoneActivity' | 'usedRecentMessages' | 'usedSchedule' | 'wasTruncated'>> = {},
): ProactiveGenerationResult {
  return {
    diagnostics: buildGenerationDiagnostics({
      contextProfile,
      eventStage: options.eventStage,
      parse: {
        keptMessageCount: 0,
        rawContentChars: options.rawContentChars,
        rawMessageCount: 0,
      },
      reasons,
      source,
      triggerKind: options.triggerKind,
      usedDesire: options.usedDesire ?? false,
      usedFallback: options.usedFallback,
      usedMemory: options.usedMemory ?? false,
      usedPhoneActivity: options.usedPhoneActivity,
      usedRecentMessages: options.usedRecentMessages,
      usedSchedule: options.usedSchedule ?? false,
      wasTruncated: options.wasTruncated,
    }),
    messages: [],
  };
}

function withFallbackGenerationDiagnostics(
  diagnostics: GenerationDiagnostics,
  fallbackMessages: string[],
  reason: string,
): GenerationDiagnostics {
  return {
    ...diagnostics,
    keptMessageCount: fallbackMessages.length,
    reasons: [...new Set([...(diagnostics.reasons ?? []), reason])],
    usedFallback: true,
  };
}

function todayKey(now = Date.now()) {
  const date = new Date(now);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function isQuietHour(now = Date.now()) {
  const hour = new Date(now).getHours();
  return hour >= 23 || hour < 7;
}

function normalizeSettings(value: unknown): ProactiveMessageSettings {
  if (!value || typeof value !== 'object') return defaultSettings;
  const settings = value as Partial<ProactiveMessageSettings>;
  return {
    enabled: settings.enabled !== false || settings.firstPromptAnswered !== true,
    firstPromptAnswered: settings.firstPromptAnswered !== false,
    notificationPreview: settings.notificationPreview === 'full' ? 'full' : 'private',
  };
}

function normalizeState(value: unknown, now = Date.now()): ProactiveMessageState {
  const key = todayKey(now);
  if (!value || typeof value !== 'object') {
    return { dateKey: key, decisionCount: 0, lastDecisionAt: 0, lastSentAt: 0 };
  }
  const state = value as Partial<ProactiveMessageState>;
  if (state.dateKey !== key) {
    return {
      dateKey: key,
      decisionCount: 0,
      lastDecisionAt: 0,
      lastSentAt: 0,
    };
  }
  return {
    dateKey: key,
    decisionCount: typeof state.decisionCount === 'number' ? state.decisionCount : 0,
    lastDecisionAt: typeof state.lastDecisionAt === 'number' ? state.lastDecisionAt : 0,
    lastSentAt: typeof state.lastSentAt === 'number' ? state.lastSentAt : 0,
  };
}

export async function loadProactiveMessageSettings(options?: { strict?: boolean }) {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (raw === null || (!options?.strict && !raw)) return defaultSettings;
  try {
    return normalizeSettings(JSON.parse(raw) as unknown);
  } catch (error) {
    if (options?.strict) throw error;
    return defaultSettings;
  }
}

export async function saveProactiveMessageSettings(settings: ProactiveMessageSettings) {
  await saveProactiveSettingsFields(settings);
}

async function loadState(now = Date.now()) {
  const raw = await AsyncStorage.getItem(STATE_KEY);
  if (!raw) return normalizeState(null, now);
  try {
    return normalizeState(JSON.parse(raw) as unknown, now);
  } catch {
    return normalizeState(null, now);
  }
}

async function saveState(state: ProactiveMessageState) {
  await saveLegacyProactiveFields(state);
}

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readAssistantResponse(payload: {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | Array<{ text?: string }> };
  }>;
}) {
  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  const finishReason = choice?.finish_reason;
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    return { content: '', truncated: true };
  }
  if (typeof content === 'string') {
    return { content: content.trim(), truncated: false };
  }
  if (Array.isArray(content)) {
    return {
      content: content.map((part) => part.text ?? '').join('').trim(),
      truncated: false,
    };
  }
  return { content: '', truncated: false };
}

function readAssistantResponseContent(payload: {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | Array<{ text?: string }> };
  }>;
}) {
  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  const finishReason = choice?.finish_reason;
  const text = typeof content === 'string'
    ? content.trim()
    : Array.isArray(content)
      ? content.map((part) => part.text ?? '').join('').trim()
      : '';
  return {
    content: text,
    finishReason,
    truncated: finishReason === 'length' || finishReason === 'max_tokens',
  };
}

function normalizeProactiveChatMessages(
  messages: string[],
  options: { allowExternalActionClaims?: boolean; maxChars?: number; maxMessages?: number } = {},
) {
  return normalizeProactiveChatMessagesWithDiagnostics(messages, options).messages;
}

function normalizeProactiveChatMessagesWithDiagnostics(
  messages: string[],
  options: { allowExternalActionClaims?: boolean; maxChars?: number; maxMessages?: number } = {},
): { diagnostics: ProactiveLiteNormalizationDiagnostics; messages: string[] } {
  const reasonSet = new Set<string>();
  const normalized = messages
    .map((raw) => ({
      clean: cleanAssistantMessageContent(raw).trim(),
      raw: raw.trim(),
    }))
    .filter(({ clean, raw }) => {
      const reasons: string[] = [];
      if (!clean) reasons.push('清洗为空');
      if (
        !options.allowExternalActionClaims &&
        (EXTERNAL_ACTION_COMPLETION_CLAIM_PATTERN.test(clean) || EXTERNAL_ACTION_COMPLETION_CLAIM_PATTERN.test(raw))
      ) {
        reasons.push('外部动作完成声称');
      }
      reasons.forEach((reason) => reasonSet.add(reason));
      return reasons.length === 0;
    })
    .map(({ clean }) => clean);
  return {
    diagnostics: {
      keptMessageCount: normalized.length,
      rawMessageCount: messages.length,
      reasons: [...reasonSet],
    },
    messages: normalized,
  };
}

function formatIdleDuration(durationMs: number) {
  return formatProactiveIdleDuration(durationMs);
}

type AutonomousProactiveDecision = {
  desireIds: JunluoDesireId[];
  reason: string;
  shouldSend: boolean;
  urge: number;
};

const ORDINARY_PROACTIVE_DESIRE_IDS = new Set<JunluoDesireId>([
  'miss_you',
  'be_chosen',
  'care_for_you',
  'speak_to_you',
  'affection_with_you',
  'desire_you',
]);

function desireIsVisible(snapshot: JunluoDesireEffectiveSnapshot, desireId: JunluoDesireId) {
  const desire = snapshot.desires[desireId];
  return desire.effectiveValue + 1e-9 >= desire.baseline + JUNLUO_DESIRE_VISIBLE_THRESHOLD;
}

// Autonomous calls retain their separately accepted policy; ordinary messages do not use it.
function decideAutonomousVoiceCall(
  snapshot: JunluoDesireEffectiveSnapshot,
  relationshipPhase: Awaited<ReturnType<typeof loadJunluoAffectState>>['relationshipPhase']['phase'],
): AutonomousProactiveDecision {
  if (desireIsVisible(snapshot, 'rest')) {
    return { desireIds: [], reason: 'rest', shouldSend: false, urge: 0 };
  }
  const desireIds = Object.values(snapshot.desires)
    .filter((desire) => (
      ORDINARY_PROACTIVE_DESIRE_IDS.has(desire.id)
      && desireIsVisible(snapshot, desire.id)
      && isJunluoAutomaticRelationshipOutletAllowed({
        driveKey: desire.id,
        outlet: 'ordinary_proactive',
        phase: relationshipPhase,
      })
    ))
    .sort((left, right) => {
      const excess = (right.effectiveValue - right.baseline) - (left.effectiveValue - left.baseline);
      return excess || right.changedAt - left.changedAt;
    })
    .map((desire) => desire.id)
    .slice(0, 2);
  const urge = desireIds.reduce((maximum, desireId) => (
    Math.max(maximum, snapshot.desires[desireId].effectiveValue)
  ), 0);
  return {
    desireIds,
    reason: desireIds.join(','),
    shouldSend: desireIds.length > 0,
    urge,
  };
}

function buildProactiveTriggerMessage(idleDurationMs: number): SubjectiveMessage {
  return {
    id: `proactive-trigger-${Date.now()}`,
    role: 'you',
    content: `【主动探头触发】这不是小仓鼠发来的新消息，而是你在当下时间自己想起她、前来看看她。距离她上次在聊天里说话已经过去 ${formatIdleDuration(idleDurationMs)}。最近聊天只供你理解关系和语境，不要把主动消息写成上一句话的续写、扩写或补完；请像隔了一会儿自然出现那样，带着自己真正想说的内容来和她聊一会儿。`,
    createdAt: Date.now(),
  };
}


function recordProactivePromptRuntimeSnapshot({
  apiMessages,
  connection,
  contextProfile,
  contextSource,
}: {
  apiMessages: ReturnType<typeof buildApiMessages>;
  connection: AiConnection;
  contextProfile: string;
  contextSource: string;
  payload: unknown;
  stablePrefixText?: string;
}) {
  try {
    recordPromptRuntimeSnapshot({ contextProfile, contextSource, messages: apiMessages, model: connection.model.trim() });
  } catch { /* Diagnostics cannot change the business result. */ }
}
type ProactivePromptEnvelopeOptions = {
  refreshMemoryMaterials?: () => Promise<string>;
  contextSource: Extract<PromptContextSource, `proactive.${string}`>;
  memoryContext?: string;
  moduleInstruction: string;
  profile: AiProfile;
  runtimeContext?: string;
  triggerMessages: SubjectiveMessage[];
};

export async function buildProactivePromptEnvelope({
  refreshMemoryMaterials,
  contextSource,
  memoryContext,
  moduleInstruction,
  profile,
  runtimeContext,
  triggerMessages,
}: ProactivePromptEnvelopeOptions) {
  let compiledPrompt = await buildCompiledSystemPromptResult({
    contextProfile: getPromptContextProfileForSource(contextSource),
    memoryContext,
    moduleInstruction,
    outputAudience: getPromptOutputAudienceForSource(contextSource),
    profile,
    runtimeContext,
  });
  if (refreshMemoryMaterials) compiledPrompt = replaceCompiledMemoryContext(compiledPrompt, await refreshMemoryMaterials());
  const apiMessages = buildApiMessages(
    compiledPrompt.stablePrompt,
    triggerMessages,
    undefined,
    undefined,
    compiledPrompt.dynamicPrompt,
  );
  return {
    apiMessages,
    memoryIncluded: !!compiledPrompt.sections.memory,
    stablePrefixText: apiMessages[0]?.content ?? compiledPrompt.stablePrompt,
    stableSystemPrompt: compiledPrompt.stablePrompt,
  };
}

function buildPhoneActivityLiteTriggerMessage(): SubjectiveMessage {
  return {
    id: `phone-activity-trigger-${Date.now()}`,
    role: 'you',
    content: '【手机活动主动触发】这不是 YOU 发来的新消息。请按系统中的【手机活动主动消息】生成 I 的手机活动私聊。',
    createdAt: Date.now(),
  };
}

async function enrichJealousyTriggerWithWindowSummary(
  trigger: PhoneActivityTrigger,
  backupRestoreLeaseHeld?: boolean,
): Promise<PhoneActivityTrigger> {
  if (trigger.kind !== 'jealousy' || trigger.windowSummary) return trigger;
  const snapshotResult = await executeAgentToolCall({
    input: { maxNodes: 80 },
    requestedBy: 'proactive',
    sourceMessageId: `phone-activity:${trigger.ruleId}:${trigger.kind}`,
    toolId: 'device.get_accessibility_snapshot',
  }, {
    backupRestoreLeaseHeld,
  }).catch(() => null);
  const snapshot = snapshotResult?.ok ? snapshotResult.data as {
    nodes?: Array<{ description?: string; text?: string }>;
    ok?: boolean;
    packageName?: string;
  } : null;
  if (!snapshot?.ok || !snapshot.nodes?.length) return trigger;
  if (snapshot.packageName && trigger.appSource && snapshot.packageName !== trigger.appSource) return trigger;
  const seen = new Set<string>();
  const texts = snapshot.nodes
    .map((node) => (node.text || node.description || '').trim())
    .filter((text) => text.length >= 2 && text.length <= 80)
    .filter((text) => {
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    })
    .slice(0, 8);
  if (!texts.length) return trigger;
  return { ...trigger, windowSummary: texts.join(' / ') };
}

async function isAssistantStateBlockingProactiveMessage() {
  const assistantState = await loadAssistantState();
  return (
    assistantState.lifeMode === 'sleeping' ||
    await hasPendingSleepingReply()
  );
}

async function askProactiveMessage({
  onMemoryUsagePrepared,
  canCommit,
  apiKey,
  connection,
  idleDurationMs,
  messages,
  profile,
  cognition,
  jealousyDismissal,
}: {
  onMemoryUsagePrepared: (receipt: MemoryUsageReceipt) => void;
  canCommit: () => boolean;
  apiKey: string;
  connection: AiConnection;
  idleDurationMs: number;
  messages: SubjectiveMessage[];
  profile: AiProfile;
  cognition: GlobalCognitionContext;
  jealousyDismissal: PhoneActivityJealousyCandidate;
}) {
  const recentMessages = messages.slice(-24);
  const diagnosticsSource: GenerationDiagnostics['source'] = 'jealousy-dismissal';
  const moduleInstruction = buildPhoneJealousyDismissalMessagePrompt({
    desireInstruction: '', reason: jealousyDismissal.reason, title: jealousyDismissal.title,
  });
  const proactiveMessagesForApi = [
    ...recentMessages,
    buildProactiveTriggerMessage(idleDurationMs),
  ];
  const promptContextSource = 'proactive.jealousy-dismissal' as const;
  const promptEnvelope = await buildProactivePromptEnvelope({contextSource:promptContextSource,memoryContext:cognition.memoryContext,moduleInstruction,profile,runtimeContext:cognition.runtimeContext,triggerMessages:proactiveMessagesForApi,
    refreshMemoryMaterials: async () => {
      await cognition.refreshMemoryMaterials?.();
      return cognition.memoryContext;
    },
  });

  const apiMessages = promptEnvelope.apiMessages;
  if (!canCommit()) throw new Error('proactive-memory-cancelled');
  onMemoryUsagePrepared(createMemoryUsageReceipt(`jealousy-dismissed:${jealousyDismissal.id}`,
    promptEnvelope.memoryIncluded ? cognition.memoryUsageReferences ?? [] : []));
  const body = JSON.stringify({
      model: connection.model.trim(),
      messages: apiMessages,
      max_tokens: 900,
      temperature: 0.65,
  });
  const metric = beginPromptCacheMetric({ contextProfile: 'proactive-lite', contextSource: diagnosticsSource,
    connection, stablePrefixText: promptEnvelope.stablePrefixText });
  let payload: any;
  try {
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      body,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (!response.ok) throw new Error(`主动消息生成失败：${response.status}`);
    payload = await response.json();
    metric.recordUsage(payload?.usage);
  } finally { void metric.finish(); }
  recordProactivePromptRuntimeSnapshot({
    apiMessages,
    connection,
    contextProfile: 'proactive-lite',
    contextSource: diagnosticsSource,
    payload,
    stablePrefixText: promptEnvelope.stablePrefixText,
  });
  const assistantResponse = readAssistantResponse(payload);
  if (assistantResponse.truncated || !assistantResponse.content) {
    return emptyProactiveGenerationResult(diagnosticsSource, 'proactive-lite', ['模型返回为空或被截断'], {
      rawContentChars: assistantResponse.content.length,
      usedDesire: false,
      usedMemory: !!cognition.memoryContext,
      usedPhoneActivity: !!jealousyDismissal,
      usedRecentMessages: recentMessages.length > 0,
      usedSchedule: true,
      wasTruncated: assistantResponse.truncated,
    });
  }
  const content = assistantResponse.content;
  const raw = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsedMessages: string[];
  let parseResult: ReturnType<typeof normalizeProactiveChatMessagesWithDiagnostics>;
  try {
    const parsed = JSON.parse(raw) as { messages?: unknown };
    parsedMessages = parseAssistantMessageBubbles(JSON.stringify({ messages: parsed.messages }));
    parseResult = normalizeProactiveChatMessagesWithDiagnostics(parsedMessages, {
      allowExternalActionClaims: false,
      maxChars: 120,
      maxMessages: 2,
    });
  } catch {
    parsedMessages = parseAssistantMessageBubbles(content);
    parseResult = normalizeProactiveChatMessagesWithDiagnostics(parsedMessages, {
      allowExternalActionClaims: false,
      maxChars: 120,
      maxMessages: 2,
    });
  }
  const parse = {
    ...parseResult.diagnostics,
    rawContentChars: content.length,
  };
  return {
    diagnostics: buildGenerationDiagnostics({
      contextProfile: 'proactive-lite',
      parse,
      source: diagnosticsSource,
      usedDesire: false,
      usedMemory: !!cognition.memoryContext,
      usedPhoneActivity: !!jealousyDismissal,
      usedRecentMessages: recentMessages.length > 0,
      usedSchedule: true,
      wasTruncated: assistantResponse.truncated,
    }),
    messages: parseResult.messages,
  };
}

async function askPhoneActivityLiteMessage({
  apiKey,
  connection,
  messages,
  phoneTrigger,
  profile,
  signal,
  beforeRequest,
}: {
  apiKey: string;
  connection: AiConnection;
  messages: SubjectiveMessage[];
  phoneTrigger: PhoneActivityTrigger;
  profile: AiProfile;
  signal?: AbortSignal;
  beforeRequest?: () => Promise<void>;
}) {
  const startedAt = Date.now();
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'you')?.content;
  const lastAssistantMessage = [...messages].reverse().find((message) => message.role === 'I')?.content;
  const moduleInstruction = buildPhoneActivityLitePrompt({
    lastAssistantMessage,
    lastUserMessage,
    phoneTrigger,
  });
  const promptEnvelope = await buildProactivePromptEnvelope({contextSource:'proactive.phone-activity',moduleInstruction,profile,triggerMessages:[buildPhoneActivityLiteTriggerMessage()],});
  const httpStartedAt = Date.now();
  const apiMessages = promptEnvelope.apiMessages;
  await beforeRequest?.();
  if (signal?.aborted) throw new PhoneGuardStop('cancelled');
  const body = JSON.stringify({
      model: connection.model.trim(),
      messages: apiMessages,
      temperature: 0.7,
      ...buildChatModelParameterPayload(connection.modelParameters),
  });
  const metric = beginPromptCacheMetric({ contextProfile: 'phone-activity', contextSource: 'proactive.phone-activity',
    connection, stablePrefixText: promptEnvelope.stablePrefixText });
  let payload: any;
  let jsonStartedAt: number;
  try {
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      body,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal,
    });
    const httpCompletedAt = Date.now();
    console.log('[phone-activity] 轻量 AI HTTP 完成', {
      elapsedMs: httpCompletedAt - startedAt,
      httpMs: httpCompletedAt - httpStartedAt,
      status: response.status,
    });

    if (!response.ok) {
      if (beforeRequest && response.status >= 400 && response.status < 500 && response.status !== 408) {
        throw new PhoneGuardStop('blocked');
      }
      throw new Error(`手机活动短消息生成失败：${response.status}`);
    }
    jsonStartedAt = Date.now();
    payload = await response.json();
    metric.recordUsage(payload?.usage);
  } finally { void metric.finish(); }
  recordProactivePromptRuntimeSnapshot({
    apiMessages,
    connection,
    contextProfile: 'phone-activity',
    contextSource: 'proactive.phone-activity',
    payload,
    stablePrefixText: promptEnvelope.stablePrefixText,
  });
  const assistantResponse = readAssistantResponseContent(payload);
  const jsonCompletedAt = Date.now();
  console.log('[phone-activity] 轻量 AI JSON 读取完成', {
    elapsedMs: jsonCompletedAt - startedAt,
    jsonMs: jsonCompletedAt - jsonStartedAt,
  });
  if (!assistantResponse.content) {
    console.warn('[phone-activity] 轻量 AI 短请求空内容', {
      elapsedMs: Date.now() - startedAt,
      finishReason: assistantResponse.finishReason,
      truncated: assistantResponse.truncated,
    });
    return emptyProactiveGenerationResult('phone-activity', 'phone-activity', ['模型返回为空'], {
      eventStage: phoneTrigger.eventStage,
      rawContentChars: 0,
      triggerKind: phoneTrigger.kind,
      usedPhoneActivity: true,
      wasTruncated: assistantResponse.truncated,
    });
  }
  const recovered = parsePhoneActivityLiteResponseWithDiagnostics(assistantResponse.content);
  console.log('[phone-activity] 轻量 AI 解析完成', {
    elapsedMs: Date.now() - startedAt,
    finishReason: assistantResponse.finishReason,
    messageCount: recovered.messages.length,
    rawLength: assistantResponse.content.length,
    truncated: assistantResponse.truncated,
  });
  return {
    diagnostics: buildGenerationDiagnostics({
      contextProfile: 'phone-activity',
      eventStage: phoneTrigger.eventStage,
      parse: recovered,
      source: 'phone-activity',
      triggerKind: phoneTrigger.kind,
      usedDesire: false,
      usedMemory: false,
      usedPhoneActivity: true,
      usedRecentMessages: false,
      usedSchedule: false,
      wasTruncated: assistantResponse.truncated,
    }),
    messages: recovered.messages,
  };
}

function compactInstalledApps(apps: InstalledPhoneApp[], existingRules: PhoneActivityRule[]) {
  const selectedSources = new Set(existingRules.filter((rule) => rule.kind === 'jealousy').map((rule) => rule.source));
  const available = apps
    .filter((app) => app.source && app.title && !selectedSources.has(app.source) && !isJunLuoPhoneApp(app.source, app.title))
    .map((app) => ({ app, score: jealousyAppScore(app) }));
  const likely = available
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.app.title.localeCompare(right.app.title, 'zh-CN'));
  return likely
    .slice(0, JEALOUSY_CANDIDATE_APP_LIMIT)
    .map(({ app }) => ({ title: app.title, source: app.source }));
}

function normalizeCandidateReason(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
}

const JEALOUSY_CANDIDATE_REQUEST_TIMEOUT_MS = 20_000;
const JEALOUSY_CANDIDATE_APP_LIMIT = 36;

function jealousyAppScore(app: InstalledPhoneApp) {
  const text = `${app.title} ${app.source}`.toLowerCase();
  if (
    /设置|系统|安全|银行|支付|钱包|地图|导航|浏览器|相机|相册|文件|文档|邮箱|日历|天气|输入法|商店|应用市场|launcher|settings|browser|camera|gallery|wallet|pay|map|mail|calendar|weather|keyboard|market|store/.test(text)
  ) {
    return -20;
  }
  if (
    /搭着学|学习|自习|计时|专注|番茄|打卡|课程|课表|作业|背单词|单词|词典|翻译|办公|代码|开发|笔记|阅读|网盘|云盘|剪辑|工具|文档|study|focus|timer|pomodoro|todo|task|course|class|homework|word|translate|office|code|dev|note|reader|drive|tool/.test(text)
  ) {
    return -20;
  }
  let score = 0;
  if (/星野|xingye|角色|扮演|陪伴|对话|恋爱|伴侣|虚拟|心动|情感|猫箱|soul|roleplay|character|companion|romance|lover|virtual/.test(text)) score += 12;
  if (/小红书|抖音|快手|微博|bilibili|哔哩|视频|短剧|直播|redbook|douyin|tiktok|kuaishou|weibo|bili|video|live/.test(text)) score += 3;
  return score;
}

function extractJsonObject(text: string) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function compactErrorSnippet(text: string) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function normalizeSettingsReaction(text: string) {
  const candidates = parseAssistantMessageBubbles(text);
  const raw = candidates.length ? candidates[0] : text;
  return cleanAssistantMessageContent(raw).trim();
}

export async function suggestJealousyCandidateApps({
  apiKey,
  apps,
  connection,
  existingRules,
  profile,
}: {
  apiKey: string;
  apps: InstalledPhoneApp[];
  connection: AiConnection;
  existingRules: PhoneActivityRule[];
  profile: AiProfile;
}): Promise<PhoneActivityJealousyCandidate[]> {
  const availableApps = compactInstalledApps(apps, existingRules);
  if (!apiKey.trim() || !connection || !profile || !availableApps.length) return [];
  console.log('[phone-jealousy] 进入轻量候选请求', { appCount: availableApps.length });
  const userPrompt = buildPhoneJealousyCandidateUserPrompt(availableApps);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), JEALOUSY_CANDIDATE_REQUEST_TIMEOUT_MS);
  const apiMessages: ReturnType<typeof buildApiMessages> = [
    { role: 'system', content: PHONE_JEALOUSY_CANDIDATE_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];
  let response: Response;
  let metric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  let responseText: string;
  let assistantResponse: ReturnType<typeof readAssistantResponseContent>;
  try {
    try {
      const body = JSON.stringify({
        model: connection.model.trim(),
        messages: apiMessages,
        max_tokens: 1200,
        temperature: 0.35,
      });
      metric = beginPromptCacheMetric({ contextProfile: 'phone-activity', contextSource: 'phone.jealousy-candidate',
        connection, stablePrefixText: PHONE_JEALOUSY_CANDIDATE_SYSTEM_PROMPT });
      response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
        body,
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('吃醋候选生成超时');
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
    responseText = await response.text();
    console.log('[phone-jealousy] 轻量候选 HTTP 完成', {
      bodyLength: responseText.length,
      status: response.status,
    });
    if (!response.ok) {
      throw new Error(`吃醋候选 HTTP ${response.status}：${compactErrorSnippet(responseText) || '空响应'}`);
    }
    try {
      const payload = JSON.parse(responseText);
      metric.recordUsage(payload?.usage);
      recordProactivePromptRuntimeSnapshot({
        apiMessages,
        connection,
        contextProfile: 'phone-activity',
        contextSource: 'phone.jealousy-candidate',
        payload,
        stablePrefixText: PHONE_JEALOUSY_CANDIDATE_SYSTEM_PROMPT,
      });
      assistantResponse = readAssistantResponseContent(payload);
    } catch (error) {
      throw new Error(`吃醋候选响应不是 JSON：${compactErrorSnippet(responseText) || String(error)}`);
    }
  } finally { void metric?.finish(); }
  if (!assistantResponse.content) {
    throw new Error(assistantResponse.truncated ? '吃醋候选回复被截断' : '吃醋候选空回复');
  }
  const raw = extractJsonObject(assistantResponse.content);
  let parsed: { candidates?: unknown };
  try {
    parsed = JSON.parse(raw) as { candidates?: unknown };
  } catch {
    throw new Error(`吃醋候选 JSON 解析失败：${compactErrorSnippet(assistantResponse.content)}`);
  }
  const list = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const known = new Map(availableApps.map((app) => [app.source, app]));
  const now = Date.now();
  const seen = new Set<string>();
  return list
    .map((item): PhoneActivityJealousyCandidate | null => {
      if (!item || typeof item !== 'object') return null;
      const candidate = item as { title?: unknown; source?: unknown; reason?: unknown };
      const source = typeof candidate.source === 'string' ? candidate.source.trim() : '';
      const app = known.get(source);
      if (!app || seen.has(source)) return null;
      seen.add(source);
      return {
        id: `jealousy-candidate:${source}`.toLowerCase(),
        title: typeof candidate.title === 'string' && candidate.title.trim() ? candidate.title.trim() : app.title,
        source,
        reason: normalizeCandidateReason(candidate.reason) || PHONE_JEALOUSY_DEFAULT_REASON,
        createdAt: now,
        status: 'pending',
      };
    })
    .filter((item): item is PhoneActivityJealousyCandidate => !!item)
    .slice(0, 4);
}

export async function sendJealousyCandidateDismissedMessage({
  apiKey,
  candidate,
  connection,
  profile,
}: {
  apiKey: string;
  candidate: PhoneActivityJealousyCandidate;
  connection: AiConnection;
  profile: AiProfile;
}) {
  if (!apiKey.trim() || !connection || !profile) return 0;
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return 0;
  const canCommit = () => canCommitBackupRestoreDataEpoch(dataEpoch);
  const slot = await requestActiveMessageSlot({
    priority: 'critical',
    source: 'phone-activity',
    topicKey: `jealousy-dismissed:${candidate.source || candidate.id}`,
  });
  if (!slot.allowed) return 0;
  const settings = await loadProactiveMessageSettings();
  const { sessions, activeSessionId } = await loadChatState();
  const active = sessions.find((session) => session.id === activeSessionId);
  if (!active) return 0;
  const latestYou = [...active.messages].reverse().find((message) => message.role === 'you');
  const cognition = await buildGlobalCognitionContext(latestYou?.content ?? '', 'proactive', { touchMemory: false });
  let memoryUsage: MemoryUsageReceipt | undefined;
  const generation = await askProactiveMessage({
    canCommit,
    onMemoryUsagePrepared: receipt => { memoryUsage = receipt; },
    apiKey,
    connection,
    cognition,
    idleDurationMs: latestYou?.createdAt ? Date.now() - latestYou.createdAt : 0,
    jealousyDismissal: candidate,
    messages: active.messages,
    profile,
  }).catch(() => {
    memoryUsage = undefined;
    const fallbackMessages = [PHONE_JEALOUSY_DISMISSAL_MESSAGE_FALLBACK];
    return {
      diagnostics: buildGenerationDiagnostics({
        contextProfile: 'proactive-lite',
        parse: { keptMessageCount: fallbackMessages.length, rawMessageCount: 0 },
        reasons: ['吃醋关闭反应生成失败，使用本地兜底'],
        source: 'jealousy-dismissal',
        usedDesire: false,
        usedFallback: true,
        usedMemory: !!cognition.memoryContext,
        usedPhoneActivity: true,
        usedRecentMessages: active.messages.length > 0,
        usedSchedule: true,
      }),
      messages: fallbackMessages,
    };
  });
  if (!generation.messages.length || !canCommit()) return 0;
  return appendProactiveMessages({
    memoryUsage,
    dataEpoch,
    activeSessionId,
    deliveryPriority: 'critical',
    deliverySource: 'phone-activity',
    generationDiagnostics: generation.diagnostics,
    proactiveMessages: generation.messages,
    settings,
    topicKey: `jealousy-dismissed:${candidate.source || candidate.id}`,
  });
}

export async function generateJealousyCandidateDismissedReaction({
  apiKey,
  candidate,
  connection,
  dismissalCount,
  profile,
}: {
  apiKey: string;
  candidate: PhoneActivityJealousyCandidate;
  connection: AiConnection;
  dismissalCount: number;
  profile: AiProfile;
}) {
  if (!apiKey.trim() || !connection || !profile) return '';
  const prompt = buildPhoneJealousyDismissedReactionPrompt({
    dismissalCount,
    reason: candidate.reason,
    title: candidate.title,
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8_000);
  let metric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  try {
    const apiMessages: ReturnType<typeof buildApiMessages> = [
      { role: 'system', content: prompt },
      { role: 'user', content: PHONE_JEALOUSY_DISMISSED_REACTION_USER_PROMPT },
    ];
    const body = JSON.stringify({
        model: connection.model.trim(),
        messages: apiMessages,
        max_tokens: 120,
        temperature: 0.75,
    });
    metric = beginPromptCacheMetric({ contextProfile: 'phone-activity', contextSource: 'phone.jealousy-dismissed-reaction', connection });
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      body,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn('[phone-jealousy] 删除小反应 HTTP 失败', response.status);
      return '';
    }
    const payload = await response.json();
    metric.recordUsage(payload?.usage);
    recordProactivePromptRuntimeSnapshot({
      apiMessages,
      connection,
      contextProfile: 'phone-activity',
      contextSource: 'phone.jealousy-dismissed-reaction',
      payload,
    });
    const assistantResponse = readAssistantResponseContent(payload);
    return normalizeSettingsReaction(assistantResponse.content || '');
  } catch (error) {
    console.warn('[phone-jealousy] 删除小反应生成失败', error);
    return '';
  } finally {
    void metric?.finish();
    clearTimeout(timeoutId);
  }
}

function normalizePhoneGuardPayload(value: unknown): PhoneGuardTriggerPayload | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<PhoneGuardTriggerPayload> & { createdAt?: number };
  const ruleId = typeof item.ruleId === 'string' ? item.ruleId.trim() : '';
  const kind = item.kind === 'blacklist-return'
    ? 'blacklist-return'
    : item.kind === 'jealousy'
      ? 'jealousy'
      : item.kind === 'blacklist'
        ? 'blacklist'
        : null;
  const ruleKind = item.ruleKind === 'jealousy' || kind === 'jealousy' ? 'jealousy' : 'blacklist';
  const triggeredAt = typeof item.triggeredAt === 'number'
    ? item.triggeredAt
    : typeof item.createdAt === 'number'
      ? item.createdAt
      : Date.now();
  if (!ruleId || !kind) return null;
  return {
    appSource: typeof item.appSource === 'string' ? item.appSource : '',
    appTitle: typeof item.appTitle === 'string' && item.appTitle.trim() ? item.appTitle.trim() : '黑名单 App',
    durationMs: typeof item.durationMs === 'number' ? Math.max(0, item.durationMs) : 0,
    kind,
    ruleId,
    ruleKind,
    stage: item.stage === 2 || item.stage === 3 ? item.stage : 1,
    triggeredAt,
    triggerId: typeof item.triggerId === 'string' && item.triggerId.trim()
      ? item.triggerId.trim()
      : `${ruleId}:${kind}:${triggeredAt}`,
  };
}

function phoneGuardMessageId(payload: PhoneGuardTriggerPayload) {
  return `phone-guard:${payload.triggerId}`;
}

async function upsertPhoneGuardChatMessage(
  payload: PhoneGuardTriggerPayload,
  content: string,
  generationDiagnostics?: GenerationDiagnostics,
) {
  const messageId = phoneGuardMessageId(payload);
  const { sessions, activeSessionId } = await loadChatState();
  const targetSessionId = sessions.find((session) => session.messages.some((message) => message.id === messageId))?.id
    ?? (sessions.some((session) => session.id === activeSessionId && payload.triggeredAt >= session.createdAt) ? activeSessionId : undefined);
  if (!targetSessionId) return 0;
  const nextMessage: SubjectiveMessage = {
    id: messageId, role: 'I', content,
    createdAt: payload.triggeredAt,
    generationDiagnostics, source: 'proactive-message',
  };
  // Merge under the chat store's own write queue; never replace a stale full session.
  const saved = await appendMessagesToChatSession(targetSessionId, [nextMessage], { activeSessionId });
  if (!saved.session || !saved.messages.some((message) => message.id === messageId)) return 0;
  DeviceEventEmitter.emit(PHONE_GUARD_CHAT_MESSAGE_EVENT, { message: nextMessage, sessionId: targetSessionId });
  return 1;
}

export async function handlePhoneGuardTriggerTask(
  input: { payloadJson?: string } | string | PhoneGuardTriggerPayload,
  reportStage?: (stage: string) => void,
) {
  const raw = typeof input === 'string' ? input
    : 'payloadJson' in input && typeof input.payloadJson === 'string' ? input.payloadJson : JSON.stringify(input);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return 0; }
  if (parsed && typeof parsed === 'object' && 'phase' in parsed && parsed.phase === 'phone_emergency_contact') {
    reportStage?.('phone-emergency-contact');
    try { return await import('./unifiedContactDispatch').then(module => module.checkUnifiedContact()); }
    finally { await import('../life/sleepPlanRuntime').then(module => module.reconcileSleepPlanLocally()).catch(() => undefined); }
  }
  if (parsed && typeof parsed === 'object' && 'phase' in parsed && parsed.phase === 'phone_care_follow_up') {
    reportStage?.('phone-care-follow-up');
    return runPhoneCareFollowUp();
  }
  if (parsed && typeof parsed === 'object' && 'phase' in parsed && parsed.phase === 'body_signal_care') {
    try {
      reportStage?.('body-signal-load');
      const { consumeBodySignalGuardianReadings } = await import('../bodySignal/bodySignalGuardianRuntime');
      const { evaluatePendingBodySignalReadings } = await import('../bodySignal/bodySignalCareRuntime');
      const { observeBodySignalCareEpisode } = await import('../bodySignal/bodySignalProactiveCareRuntime');
      reportStage?.('body-signal-readings');
      await consumeBodySignalGuardianReadings();
      reportStage?.('body-signal-evaluate');
      await evaluatePendingBodySignalReadings();
      reportStage?.('body-signal-episode');
      await observeBodySignalCareEpisode();
      reportStage?.('body-signal-contact');
      await import('./unifiedContactDispatch').then(module => module.checkUnifiedContact());
      reportStage?.('body-signal-release');
    }
    finally { const { releaseNativeBodySignalCareDispatch } = await import('../bodySignal/bodySignalGuardian'); await releaseNativeBodySignalCareDispatch(); }
    return 0;
  }
  const payload = normalizePhoneGuardPayload(parsed);
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (!payload || dataEpoch === null || phoneGuardTaskInFlightIds.has(payload.triggerId)) return 0;
  phoneGuardTaskInFlightIds.add(payload.triggerId);
  const current = () => canCommitBackupRestoreDataEpoch(dataEpoch);
  const diagnostic = (stage: string) => {
    console.warn('[phone-guard]', { triggerId: payload.triggerId, stage });
  };
  const commit = async <T,>(work: () => Promise<T>): Promise<T> => {
    const result = await runBackupRestoreDataEpochCommit(dataEpoch, work);
    if (!result.committed) throw new PhoneGuardStop('cancelled');
    return result.value;
  };
  try {
    // A Headless task's payload is not execution evidence: re-read the native event.
    const event = await getPhoneGuardEvent(payload.triggerId);
    if (!current() || !event || event.ruleId !== payload.ruleId) return 0;
    if (event.status !== 'pending') return 0;
    const snapshot = await loadAiConfigPreferencesSnapshot();
    const config = resolveLifeCreativeConfig(snapshot);
    const chat = await loadChatState();
    const sourceSession = chat.sessions.find((session) => session.id === chat.activeSessionId);
    if (!sourceSession || payload.triggeredAt < sourceSession.createdAt) {
      await commit(() => finishPhoneGuardEvent(payload.triggerId, 'cancelled'));
      return 0;
    }
    const activeMessages = sourceSession.messages;
    const trigger: PhoneActivityTrigger = {
      ...payload,
      reason: payload.kind === 'blacklist-return' ? 'return' : payload.ruleKind === 'jealousy' ? 'jealousy' : 'current',
    };
    let generation: GenerationDiagnostics | undefined;
    let careEventId: string | undefined;
    const careItemName = `${payload.appTitle} · ${Math.floor(payload.durationMs / 60_000)} 分钟`;
    const recordOverlay = async (native: PhoneGuardEvent) => commit(async () => {
      // Blacklist interventions stay in chat; the follow-up owns its native trigger, not a diary card.
      if (payload.ruleKind === 'blacklist') return;
      if (!native.overlayShownAt || !native.authorized || !native.overlayPermission || !current()) return;
      const receipt = await recordBaiyunCareDelivery({
        sourceId: payload.triggerId, itemName: careItemName,
        occurredAt: native.overlayShownAt, uiReceiptId: payload.triggerId,
        links: [{ relation: 'source', targetKind: 'phone_guard_event', targetId: payload.triggerId }],
      });
      if (!receipt) throw new Error('overlay-receipt-not-saved');
      careEventId = receipt.id;
    });
    // Previously saved exact-ID formal messages are recovered without another HTTP call.
    const previous = chat.sessions.flatMap((session) => session.messages).find((message) =>
      message.id === phoneGuardMessageId(payload) && message.content.trim()
      && message.content !== PHONE_GUARD_PLACEHOLDER && !!message.generationDiagnostics);
    if (previous) {
      if (event.overlayShownAt && event.authorized && event.overlayPermission) await recordOverlay(event);
      if (careEventId) await commit(() => recordBaiyunCareDelivery({
        sourceId: payload.triggerId, itemName: careItemName, messageIds: [previous.id],
      }));
      await commit(() => finishPhoneGuardEvent(payload.triggerId, 'succeeded'));
      return 0;
    }
    const delivered = await runPhoneGuardDelivery(payload, {
      current, now: Date.now, diagnostic,
      read: () => getPhoneGuardEvent(payload.triggerId),
      claim: () => commit(() => claimPhoneGuardAttempt(payload.triggerId)),
      finish: (status) => commit(() => finishPhoneGuardEvent(payload.triggerId, status)),
      available: async () => {
        if (!current()) return 'cancelled';
        if (!isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy())) return 'disabled';
        const settings = await loadPhoneActivityProactiveSettings();
        if (!settings.enabled || !settings.rules.some((rule) => rule.id === payload.ruleId
          && rule.source === payload.appSource)) return 'cancelled';
        if (payload.ruleKind === 'jealousy') {
          const phase = (await loadJunluoAffectState()).relationshipPhase.phase;
          if (!settings.jealousyEnabled || !isJunluoAutomaticRelationshipOutletAllowed({ outlet: 'phone_jealousy', phase })) {
            return 'cancelled';
          }
        }
        return config.connection && config.apiKey.trim() ? 'ready' : 'blocked';
      },
      request: async (signal, beforeRequest) => {
        if (!config.connection) throw new PhoneGuardStop('blocked');
        const result = await askPhoneActivityLiteMessage({
          apiKey: config.apiKey, connection: config.connection, profile: snapshot.profile,
          messages: activeMessages, phoneTrigger: trigger, signal, beforeRequest,
        });
        if (signal.aborted || !current()) throw new PhoneGuardStop('cancelled');
        generation = result.diagnostics;
        return result.messages.join('\n\n');
      },
      runRequests: async (attempt, shouldContinue, shouldRecordAttempt) => {
        const result = await runBudgetedAiCallPair('proactive', attempt, attempt, {
          connection: config.connection, dataEpoch, shouldContinue, shouldRecordAttempt,
        });
        if (!result.ok) diagnostic('request-blocked');
        return result.ok;
      },
      save: (content) => commit(async () => !!await upsertPhoneGuardChatMessage(payload, content, generation)),
      recordOverlay,
      recordDelivery: () => commit(async () => {
        if (careEventId) {
          const receipt = await recordBaiyunCareDelivery({
            sourceId: payload.triggerId, itemName: careItemName,
            messageIds: [phoneGuardMessageId(payload)],
          });
          if (!receipt) throw new Error('message-receipt-not-saved');
        }
        if (!current()) return;
        await markPhoneActivityTrigger(trigger, Date.now());
        if (!current()) return;
        await recordActiveMessageDelivery({
          messageCount: 1, priority: 'contextual', source: 'phone-activity', topicKey: payload.ruleId,
        });
      }),
      display: (text) => commit(() => updatePhoneGuardEventMessage(payload.ruleId, payload.triggerId, text)),
      timeoutMs: PHONE_GUARD_TASK_AI_TIMEOUT_MS,
    });
    if (delivered && current() && payload.ruleKind === 'blacklist') {
      for (let attempt = 0; attempt < 4 && current(); attempt += 1) {
        try {
          await registerPhoneCareFollowUp({ triggerId: payload.triggerId, ruleId: payload.ruleId,
            messageId: phoneGuardMessageId(payload), careReason: `${payload.appTitle} · ${Math.floor(payload.durationMs / 60_000)} 分钟` });
          break;
        } catch { diagnostic('follow-up-register'); }
      }
    }
    return delivered ? 1 : 0;
  } catch {
    diagnostic('task-failed');
    // Preparation/storage failure is terminal too; polling must not keep restarting it.
    for (let retry = 0; retry < 4 && current(); retry += 1) {
      try {
        await commit(async () => {
          const event = await getPhoneGuardEvent(payload.triggerId);
          if (!event || event.ruleId !== payload.ruleId || event.status !== 'pending') return;
          if (!await finishPhoneGuardEvent(payload.triggerId, 'failed')) throw new Error('finish-not-saved');
          await updatePhoneGuardEventMessage(payload.ruleId, payload.triggerId, '消息生成失败');
        });
        break;
      } catch { diagnostic('task-failure-save'); }
    }
    return 0;
  } finally {
    phoneGuardTaskInFlightIds.delete(payload.triggerId);
  }
}

export async function notifyProactiveMessage(settings: ProactiveMessageSettings, messages: string[]) {
  const first = messages[0]?.trim();
  const body =
    settings.notificationPreview === 'full' && first
      ? messages.length > 1
        ? `${first}  还有 ${messages.length - 1} 句话`
        : first
      : '白云小姐给你留了句话';
  return Notifications.scheduleNotificationAsync({
    content: {
      title: '白云小姐',
      body,
      data: { kind: 'proactive-message' },
    },
    trigger: null,
  });
}

function randomPortraitResourceName() {
  const portrait = youPortraitAssets[Math.floor(Math.random() * youPortraitAssets.length)];
  return portrait?.androidResourceName ?? 'you_portrait_calm';
}

async function consumeOverlayExitRecord() {
  const exit = await consumeLastPhoneActivityOverlayExit();
  if (exit?.ruleId && exit.exitedAt) {
    await recordPhoneActivityOverlayExit(exit.ruleId, exit.exitedAt);
  }
}

type PendingPhoneActivityFocusTrigger = NonNullable<Awaited<
  ReturnType<typeof consumePendingPhoneActivityFocusTrigger>
>>;

async function consumeNativePhoneTrigger(
  pendingOverride?: PendingPhoneActivityFocusTrigger,
): Promise<{ inserted: number; trigger: PhoneActivityTrigger | null }> {
  const pending = pendingOverride ?? await consumePendingPhoneActivityFocusTrigger();
  if (!pending) return { inserted: 0, trigger: null };
  const triggeredAt = typeof pending.triggeredAt === 'number'
    ? pending.triggeredAt
    : typeof pending.createdAt === 'number'
      ? pending.createdAt
      : Date.now();
  const pendingTriggerId = pending.triggerId?.trim() || [pending.ruleId, pending.kind, triggeredAt].join(':');
  if (Date.now() - triggeredAt > PHONE_GUARD_TRIGGER_STALE_MS) {
    await clearPendingPhoneActivityFocusTrigger(pendingTriggerId).catch(() => false);
    return { inserted: 0, trigger: null };
  }

  const inserted = await handlePhoneGuardTriggerTask({
    appTitle: pending.appTitle,
    appSource: pending.appSource,
    durationMs: pending.durationMs,
    kind: pending.kind === 'blacklist-return' ? 'blacklist-return' : pending.kind === 'jealousy' ? 'jealousy' : 'blacklist',
    ruleId: pending.ruleId,
    ruleKind: pending.ruleKind === 'jealousy' || pending.kind === 'jealousy' ? 'jealousy' : 'blacklist',
    stage: pending.stage === 2 || pending.stage === 3 ? pending.stage : 1,
    triggeredAt,
    triggerId: pending.triggerId?.trim() || `${pending.ruleId}:${pending.kind}:${triggeredAt}`,
  }).catch(() => undefined);

  if (inserted) {
    await clearPendingPhoneActivityFocusTrigger(pendingTriggerId).catch(() => false);
  }

  return { inserted: inserted ? 1 : 0, trigger: null };
}

let pendingPhoneActivityProbe: Promise<number> | undefined;
type PhoneActivityProbeOptions = {
  runTriggered?: (task: () => Promise<number>) => Promise<number>;
};

export function probePhoneActivityProactiveMessage(
  options: PhoneActivityProbeOptions = {},
) {
  if (pendingPhoneActivityProbe) return pendingPhoneActivityProbe;
  const run = runPhoneActivityPendingProbe({
    consumeOverlayExit: consumeOverlayExitRecord,
    peekPendingTrigger: consumePendingPhoneActivityFocusTrigger,
    processPendingTrigger: (pendingTrigger) => {
      const task = async () => {
        const result = await consumeNativePhoneTrigger(pendingTrigger);
        return result.inserted;
      };
      return options.runTriggered ? options.runTriggered(task) : task();
    },
  }).finally(() => {
    if (pendingPhoneActivityProbe === run) {
      pendingPhoneActivityProbe = undefined;
    }
  });
  pendingPhoneActivityProbe = run;
  return run;
}

async function appendProactiveMessages({
  memoryUsage,
  dataEpoch,
  activeSessionId,
  deliveryPriority,
  deliverySource,
  generationDiagnostics,
  messageSource = 'proactive-message',
  proactiveMessages,
  settings,
  messageIdPrefix,
  topicKey,
}: {
  memoryUsage?: MemoryUsageReceipt;
  dataEpoch?: number | null;
  activeSessionId: string;
  deliveryPriority: ActiveMessagePriority;
  deliverySource: ActiveMessageSource;
  generationDiagnostics?: GenerationDiagnostics;
  messageSource?: SubjectiveMessage['source'];
  proactiveMessages: string[];
  settings: ProactiveMessageSettings;
  messageIdPrefix?: string;
  requireOriginalSession?: boolean;
  topicKey?: string;
}) {
  const generatedAdditions = createIMessagesFromApiResponse(proactiveMessages, {
    generationDiagnostics,
    source: messageSource,
  });
  const additions = messageIdPrefix
    ? generatedAdditions.map((message, index) => ({
        ...message,
        id: `${messageIdPrefix}-${index}`,
      }))
    : generatedAdditions;
  if (!additions.length) {
    return 0;
  }
  const { sessions: latestSessions, activeSessionId: latestActiveSessionId } = await loadChatState();
  const originalSessionExists = latestSessions.some((session) => session.id === activeSessionId);
  const targetSessionId = originalSessionExists ? activeSessionId : undefined;
  if (!targetSessionId) {
    return 0;
  }
  const active = latestSessions.find((session) => session.id === targetSessionId);
  if (!active) {
    return 0;
  }
  const existingIds = new Set(active.messages.map((message) => message.id));
  const freshAdditions = additions.filter((message) => !existingIds.has(message.id));
  if (!freshAdditions.length) {
    return 0;
  }
  const append = async (messages: SubjectiveMessage[]) => {
    const work = () => appendMessagesToChatSession(targetSessionId, messages, { activeSessionId: latestActiveSessionId });
    if (dataEpoch === undefined) return work();
    const result = await runBackupRestoreDataEpochCommit(dataEpoch, work);
    return result.committed ? result.value : { messages: [] as SubjectiveMessage[] };
  };
  const appendResult = await append(freshAdditions);
  const persistedIds = new Set(appendResult.messages.map((message) => message.id));
  let persistedAdditions = freshAdditions.filter((message) => persistedIds.has(message.id));
  const missingAdditions = freshAdditions.filter((message) => !persistedIds.has(message.id));
  if (missingAdditions.length) {
    console.warn('[proactive] append verification missed messages, retrying once', {
      deliverySource,
      missingCount: missingAdditions.length,
      sessionId: targetSessionId,
    });
    try {
      const retryResult = await append(missingAdditions);
      retryResult.messages.forEach(message => persistedIds.add(message.id));
    } catch (error) {
      if (!persistedAdditions.length) throw error;
      console.warn('[proactive] remaining messages could not be saved', { deliverySource, sessionId: targetSessionId });
    }
    persistedAdditions = freshAdditions.filter((message) => persistedIds.has(message.id));
  }
  if (!persistedAdditions.length) {
    console.warn('[proactive] append verification failed; skip notification', {
      deliverySource,
      messageCount: freshAdditions.length,
      sessionId: targetSessionId,
    });
    return 0;
  }
  if (memoryUsage) await settleSavedMemoryUsage({ receipt: memoryUsage, dataEpoch: dataEpoch ?? null,
    savedAt: Math.max(...persistedAdditions.map(message => message.createdAt)) });
  emitChatMessagesAppended({
    messages: persistedAdditions,
    sessionId: targetSessionId,
    source: deliverySource,
  });
  await recordActiveMessageDelivery({
    messageCount: persistedAdditions.length,
    priority: deliveryPriority,
    source: deliverySource,
    topicKey,
  });
  try {
    await notifyProactiveMessage(
      settings,
      persistedAdditions.map((message) => message.content),
    );
  } catch {
    // 通知权限或系统限制不能影响聊天里真正留下的话。
  }
  return persistedAdditions.length;
}




function buildAgentTaskGenerationDiagnostics(task: JunLuoAgentTaskRecord): GenerationDiagnostics {
  return buildGenerationDiagnostics({
    contextProfile: 'agent-task',
    eventStage: 'agent-task-due',
    parse: {
      keptMessageCount: 1,
      rawMessageCount: 1,
      reasons: ['一次性主动消息到点触发'],
    },
    source: 'agent-task',
    triggerKind: task.title,
    usedDesire: false,
    usedFallback: false,
    usedMemory: false,
    usedRecentMessages: false,
    usedSchedule: false,
  });
}

async function deliverDueAgentTaskMessages({
  activeSessionId,
  settings,
  now,
}: {
  activeSessionId: string;
  now: number;
  settings: ProactiveMessageSettings;
}) {
  if (!settings.enabled || isQuietHour(now)) return 0;
  if (await isAssistantStateBlockingProactiveMessage()) return 0;
  const dueTasks = await loadDueAgentTasks(now).catch(() => []);
  const task = dueTasks[0];
  if (!task) return 0;
  const slot = await requestActiveMessageSlot({
    priority: 'contextual',
    source: 'agent-task',
    topicKey: task.id,
  });
  if (!slot.allowed) return 0;
  let inserted = 0;
  const result = await executeProactiveAgentTaskHandlingOnce(
    task.id,
    async () => {
      inserted = await appendProactiveMessages({
        activeSessionId,
        deliveryPriority: 'contextual',
        deliverySource: 'agent-task',
        generationDiagnostics: buildAgentTaskGenerationDiagnostics(task),
        messageIdPrefix: createProactiveAgentTaskMessageIdPrefix(task.id),
        messageSource: 'agent-task',
        proactiveMessages: [task.message],
        settings,
        topicKey: task.id,
      });
      if (!inserted) {
        throw new Error('proactive-agent-task-chat-insert-failed');
      }
      return 'completed';
    },
  );
  return result.executedNow ? inserted : 0;
}

async function runMaybeSendProactiveMessage({
  apiKey,
  backupRestoreLeaseHeld,
  connection,
  phoneActivityOnly,
  profile,
  socialShareOnly,
  unifiedSchedulerHeld,
  naturalEarlyWakeOwner,
}: MaybeSendOptions) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const settings = await loadProactiveMessageSettings();
  const now = Date.now();
  await consumeOverlayExitRecord();

  const state = await loadState(now);
  const { sessions, activeSessionId } = phoneActivityOnly
    ? await loadChatStateFast({ activeMessageLimit: 30 })
    : await loadChatState();
  const active = sessions.find((session) => session.id === activeSessionId);
  if (!active) return 0;
  if (!phoneActivityOnly && !socialShareOnly) {
    const agentTaskInserted = await deliverDueAgentTaskMessages({ activeSessionId, now, settings });
    if (agentTaskInserted) return agentTaskInserted;
  }
  const runOrdinaryContact = async () => {
    const config = resolveLifeCreativeConfig(await loadAiConfigPreferencesSnapshot());
    if (!config.connection || !config.apiKey.trim() || !profile) return 0;
    return runUnifiedContact({ apiKey: config.apiKey, connection: config.connection, profile,
      backupRestoreLeaseHeld, schedulerHeld: unifiedSchedulerHeld, naturalEarlyWakeOwner });
  };
  if (!profile) return 0;
  if (!apiKey?.trim() || !connection) {
    // Other channels retain their caller's config; ordinary contact has its own saved purpose.
    return phoneActivityOnly ? 0 : runOrdinaryContact();
  }

  const latestYou = [...active.messages].reverse().find((message) => message.role === 'you');
  const [desireSnapshot, relationshipPhase] = await Promise.all([
    loadJunluoDesireSnapshot(now),
    loadJunluoAffectState()
      .then((state) => state.relationshipPhase.phase)
      .catch(() => 'together' as const),
  ]);

  const nativePhoneTriggerResult = socialShareOnly
    ? { inserted: 0, trigger: null }
    : await consumeNativePhoneTrigger();
  if (nativePhoneTriggerResult.inserted) return nativePhoneTriggerResult.inserted;
  const nativePhoneTrigger = nativePhoneTriggerResult.trigger;
  const fallbackPhoneTrigger = nativePhoneTrigger ? null : await findPhoneActivityTrigger(now);
  const rawPhoneTrigger = nativePhoneTrigger ?? (
    fallbackPhoneTrigger?.ruleKind === 'blacklist' || fallbackPhoneTrigger?.ruleKind === 'jealousy'
      ? null
      : fallbackPhoneTrigger
  );
  const statefulPhoneTrigger = rawPhoneTrigger ? await attachPhoneActivityTriggerEventState(rawPhoneTrigger, now) : null;
  const enrichedPhoneTrigger = statefulPhoneTrigger
    ? await enrichJealousyTriggerWithWindowSummary(statefulPhoneTrigger, backupRestoreLeaseHeld)
    : null;
  const phoneJealousyAllowed = isJunluoAutomaticRelationshipOutletAllowed({
    outlet: 'phone_jealousy',
    phase: relationshipPhase,
  });
  if (enrichedPhoneTrigger?.ruleKind === 'jealousy' && !phoneJealousyAllowed) {
    await markPhoneActivityTrigger(enrichedPhoneTrigger, now).catch(() => undefined);
  }
  const phoneTrigger = enrichedPhoneTrigger?.ruleKind === 'jealousy' && !phoneJealousyAllowed
    ? null
    : enrichedPhoneTrigger;
  if (phoneTrigger && settings.enabled && !isQuietHour(now) && !(await isAssistantStateBlockingProactiveMessage())) {
    const slot = await requestActiveMessageSlot({
      bypassQuietHour: false,
      priority: 'contextual',
      source: 'phone-activity',
      topicKey: phoneTrigger.ruleId,
    });
    if (!slot.allowed) return 0;
    const phoneMessageGeneration = askPhoneActivityLiteMessage({
      apiKey,
      connection,
      messages: active.messages,
      phoneTrigger,
      profile,
    }).catch(() => emptyProactiveGenerationResult('phone-activity', 'phone-activity', ['手机活动生成请求失败'], {
      eventStage: phoneTrigger.eventStage,
      triggerKind: phoneTrigger.kind,
      usedPhoneActivity: true,
    }));
    const generatedPhoneMessages = await phoneMessageGeneration;
    const usedFallback = !generatedPhoneMessages.messages.length;
    const proactiveMessages = usedFallback
      ? fallbackPhoneActivityLiteMessages(phoneTrigger)
      : generatedPhoneMessages.messages;
    const generationDiagnostics = usedFallback
      ? withFallbackGenerationDiagnostics(generatedPhoneMessages.diagnostics, proactiveMessages, '手机活动本地兜底')
      : generatedPhoneMessages.diagnostics;
    if (!proactiveMessages.length) return 0;
    const inserted = await appendProactiveMessages({
      activeSessionId,
      deliveryPriority: 'contextual',
      deliverySource: 'phone-activity',
      generationDiagnostics,
      proactiveMessages,
      settings,
      topicKey: phoneTrigger.ruleId,
    });
    if (inserted) {
      await markPhoneActivityTrigger(phoneTrigger, Date.now());
    }
    return inserted;
  }

  if (phoneActivityOnly) return 0;

  const unifiedInserted = await runOrdinaryContact();
  if (unifiedInserted || socialShareOnly) return unifiedInserted;

  const routineStart = new Date(now); routineStart.setHours(0, 0, 0, 0); routineStart.setDate(routineStart.getDate() - 1);
  const routineEnd = new Date(now); routineEnd.setHours(0, 0, 0, 0); routineEnd.setDate(routineEnd.getDate() + 2);
  const [{ settings: voiceCallSettings }, routine, routineSettings] = await Promise.all([
    loadVoiceCallSettings().catch(() => ({ settings: null })),
    readEffectiveUserRoutineRange(routineStart.getTime(), routineEnd.getTime()).catch(() => null),
    readUserRoutine().catch(() => null),
  ]);
  const decision = decideAutonomousVoiceCall(desireSnapshot, relationshipPhase);
  const primaryDesireId = decision.desireIds[0];
  const autonomousCallsAllowed = Boolean(
    voiceCallSettings?.enabled
    && voiceCallSettings.autonomousIncomingCallsEnabled
    && isAutonomousCallRoutineTimeAllowed(now, routineSettings?.status === 'unavailable' || !routineSettings ? null : routine,
      routineSettings?.enabled ?? false)
    && isJunluoAutomaticRelationshipOutletAllowed({
      driveKey: primaryDesireId,
      outlet: 'autonomous_call',
      phase: relationshipPhase,
    }),
  );
  if (!settings.enabled && !autonomousCallsAllowed) return 0;
  if (now - state.lastSentAt < AUTONOMOUS_SENT_COOLDOWN_MS) return 0;
  if (now - state.lastDecisionAt < AUTONOMOUS_DECISION_COOLDOWN_MS) return 0;
  if (state.decisionCount >= MAX_DAILY_DECISIONS) return 0;

  const nextDecisionCount = state.decisionCount + 1;
  const assistantBlocking = await isAssistantStateBlockingProactiveMessage();

  const ordinaryActiveFocus = await loadActiveFocusSession().catch(() => null);
  if (shouldSuppressOrdinaryProactive({ activeFocus: ordinaryActiveFocus })) return 0;
  if (assistantBlocking) return 0;
  const ordinaryRelationshipOutletAllowed = decision.shouldSend;
  if (!decision.shouldSend || (!ordinaryRelationshipOutletAllowed && !autonomousCallsAllowed)) {
    await saveState({ ...state, decisionCount: nextDecisionCount, lastDecisionAt: now });
    return 0;
  }
  if (autonomousCallsAllowed) {
    const [dailyCount, lastCallAt] = await Promise.all([
      countAutonomousCallsToday(now),
      latestAutonomousVoiceCallAt(),
    ]);
    if (shouldScheduleAutonomousCall({
      dailyCount,
      desire: null,
      desireId: primaryDesireId,
      lastCallAt,
      now,
      relationshipPhase,
      urge: decision.urge,
    })) {
      const callSlot = await requestActiveMessageSlot({
        bypassQuietHour: true,
        priority: 'soft',
        source: 'voice-call-autonomous',
      });
      if (callSlot.allowed) {
        try {
          const readiness = await fetchVoiceCallReadiness();
          if (readiness.data.ok) {
            const scheduledAt = now + randomAutonomousCallDelay();
            const invitation = await createVoiceCallInvitation({ kind: 'autonomous', scheduledAt });
            try {
              const scheduled = await scheduleNativeIncomingCall(invitation);
              await updateVoiceCallInvitationNativeTaskId(invitation.invitationId, scheduled.nativeTaskId);
              await recordActiveMessageDelivery({
                deliveredAt: now,
                messageCount: 1,
                priority: 'soft',
                source: 'voice-call-autonomous',
                topicKey: invitation.invitationId,
              });
              await saveState({ ...state, decisionCount: nextDecisionCount, lastDecisionAt: now, lastSentAt: now });
              return 0;
            } catch {
              await updateVoiceCallInvitationStatus(invitation.invitationId, 'failed');
            }
          }
        } catch {
          // Readiness failures preserve the already-verified proactive text route.
        }
      }
    }
  }
  return 0;
}

export function maybeSendProactiveMessage(options: MaybeSendOptions) {
  if (pendingProactiveRun) return pendingProactiveRun;
  const run = runMaybeSendProactiveMessage(options).finally(() => {
    if (pendingProactiveRun === run) pendingProactiveRun = undefined;
  });
  pendingProactiveRun = run;
  return run;
}
