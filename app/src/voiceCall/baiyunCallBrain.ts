import { describeAssistantAvailability } from '../ai/assistantLife';
import { loadAssistantState } from '../ai/assistantState';
import { buildCompiledSystemPromptResult, prewarmPersonaPrompt } from '../ai/builtInSystemPrompt';
import { replaceCompiledMemoryContext } from '../ai/persona/promptCompiler';
import {
  getPromptContextProfileForSource,
  getPromptOutputAudienceForSource,
} from '../ai/promptContextProfile';
import {
  buildGlobalCognitionContext,
  buildGlobalMemoryBundle,
  attachGlobalMemoryBundle,
  type GlobalCognitionContext,
} from '../ai/globalCognition';
import {
  buildChatModelParameterPayload,
  buildOpenAiCompatibilityPayload,
  isOfficialQwen397bConnection,
} from '../ai/modelParameters';
import { runScheduledAiCall } from '../ai/aiRuntimeScheduler';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';
import { isOfficialDeepSeekV4Connection } from '../ai/toolProviderCapabilities';
import {
  buildApiMessages,
  type ApiChatMessage,
  type SubjectiveMessage,
} from '../ai/subjectiveMessages';
import type { AiConnection, AiProfile } from '../ai/types';
import { buildConversationSummaryWithShortLogs } from '../chat/contextCompression';
import { loadChatStateFast } from '../chat/chatStorage';
import { getMemoryDatabase } from '../memory/memoryStore';
import { createMemoryMaterialPreparation } from '../memory/memoryCurrentMaterials';
import type { MemoryBundle } from '../memory/memoryOrchestrator';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { createVoiceCallMemoryUsageReceipt, type VoiceCallMemoryUsageReceipt } from './voiceCallMemoryUsage';
import { loadJunluoDesirePromptPaper } from '../life/junluoDesireRuntime';
import {
  BAIYUN_VOICE_CALL_CARE_PROMPT,
  BAIYUN_VOICE_CALL_FIXED_PROMPT,
  buildBaiyunVoiceCallDynamicMaterial,
  buildBaiyunVoiceCallProfile,
  cleanBaiyunVoiceCallReply,
  getBaiyunVoiceCallEmotionHint,
  type BaiyunCallDirection,
} from './baiyunCallPrompt';
import {
  detectExplicitVoiceCallDistress,
  VoiceCallCarePolicy,
  type VoiceCallCareReason,
  type VoiceCallCareTrigger,
} from './voiceCallCare';
import type {
  VoiceCallEmotionSignalEvent,
  VoiceCallPlaybackEvent,
  VoiceCallTranscriptEvent,
} from './voiceCallRoomClient';
import { buildRecentMissedVoiceCallContext } from './voiceCallInvitationStore';

export type BaiyunCallBrainStatus =
  | 'failed'
  | 'generating'
  | 'idle'
  | 'interrupted'
  | 'ready'
  | 'stopped'
  | 'waiting';

export type BaiyunCallBrainSnapshot = {
  automaticCareAttempt?: number;
  careReason?: VoiceCallCareReason;
  error?: string;
  generatedAt?: number;
  message: string;
  playbackIntent?: 'care_auto' | 'manual' | 'opening_auto';
  replyText: string;
  status: BaiyunCallBrainStatus;
  turnId?: string;
};

type BaiyunCallBrainOptions = {
  apiKey: string;
  callId: string;
  connection: AiConnection | null;
  direction: BaiyunCallDirection;
  emotion2vecEnabled: boolean;
  onDiagnostic?: (
    event: string,
    details: Record<string, boolean | null | number | string | undefined>,
  ) => void;
  onSnapshot: (snapshot: BaiyunCallBrainSnapshot) => void;
  onMemoryUsagePrepared?: (turnId: string, receipt: VoiceCallMemoryUsageReceipt) => void;
  profile: AiProfile;
  startedAt: number;
  openingPrompt?: string;
};

type PendingTurn = {
  careReason?: VoiceCallCareReason;
  emotion?: VoiceCallEmotionSignalEvent;
  timer?: ReturnType<typeof setTimeout>;
  transcript?: VoiceCallTranscriptEvent;
};

type ChatContextSnapshot = {
  messages: SubjectiveMessage[];
  missedCallContext: string;
  summary: string;
  sessionId?: string;
};

type CompletionPayload = {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | Array<{ text?: string; type?: string }> | null;
      reasoning_content?: string;
    };
  }>;
  error?: { message?: string };
  usage?: {
    completion_tokens?: number;
    prompt_tokens?: number;
    total_tokens?: number;
  };
};

type VoiceCallModelResponseDiagnostics = {
  choiceCount: number;
  completionTokens: number | null;
  contentKind: 'missing' | 'null' | 'parts' | 'string';
  finishReason: string;
  promptTokens: number | null;
  rawContentChars: number;
  reasoningContentChars: number;
  totalTokens: number | null;
  wasTruncated: boolean;
  outputAccepted?: boolean;
  cleanedContentChars?: number;
  errorCode?: 'call_reply_not_spoken';
};

type PreparedBaiyunCallRequest = {
  body: string;
  url: string;
  memoryUsageReceipt?: VoiceCallMemoryUsageReceipt;
};

type BaiyunCallPreparationStage =
  | 'assistant_state_ready'
  | 'context_sources_ready'
  | 'global_cognition_ready'
  | 'global_cognition_skipped'
  | 'global_cognition_soft_timeout'
  | 'prompt_compiled'
  | 'request_serialized';

const EMOTION_WAIT_MS = 400;
const CONTEXT_PREP_TIMEOUT_MS = 8_000;
const COGNITION_SOFT_TIMEOUT_MS = 2_500;
const CALL_MEMORY_RECALL_TIMEOUT_MS = 5_000;
const MODEL_TIMEOUT_MS = 25_000;
const MODEL_DEADLINE_GRACE_MS = 1_500;
const VOICE_CALL_MAX_TOKENS = 768;
const RECENT_CHAT_MESSAGE_LIMIT = 10;
const CALL_HISTORY_MESSAGE_LIMIT = 12;
const CHAT_CONTEXT_PREWARM_TTL_MS = 90_000;

const emptyChatContextSnapshot: ChatContextSnapshot = {
  messages: [],
  missedCallContext: '',
  summary: '',
};

let prewarmedChatContext: {
  expiresAt: number;
  promise: Promise<ChatContextSnapshot>;
} | null = null;

function createChatContextPromise() {
  return loadChatContextSnapshot().catch(() => emptyChatContextSnapshot);
}

function getPrewarmedChatContext() {
  if (prewarmedChatContext && prewarmedChatContext.expiresAt > Date.now()) {
    return prewarmedChatContext.promise;
  }
  prewarmedChatContext = null;
  return createChatContextPromise();
}

export async function prewarmBaiyunCallContext(options: { refresh?: boolean } = {}) {
  const now = Date.now();
  if (
    options.refresh
    || !prewarmedChatContext
    || prewarmedChatContext.expiresAt <= now
  ) {
    prewarmedChatContext = {
      expiresAt: now + CHAT_CONTEXT_PREWARM_TTL_MS,
      promise: createChatContextPromise(),
    };
  }
  await Promise.all([
    prewarmedChatContext.promise,
    getMemoryDatabase().catch(() => undefined),
    loadAssistantState().catch(() => undefined),
    prewarmPersonaPrompt({ forceRefresh: options.refresh === true }).catch(() => undefined),
  ]);
}

const emptyVoiceCallCognition: GlobalCognitionContext = {
  activeFocus: null,
  lastInteractionAt: null,
  memoryContext: '',
  memoryItems: [],
  runtimeContext: '',
};

async function buildVoiceCallCognitionContext({
  onStage,
  query,
  signal,
}: {
  onStage?: (stage: BaiyunCallPreparationStage | `global_cognition:${string}`) => void;
  query: string;
  signal: AbortSignal;
}): Promise<GlobalCognitionContext> {
  if (!query.trim()) {
    onStage?.('global_cognition_skipped');
    return emptyVoiceCallCognition;
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  signal.addEventListener('abort', abortFromParent, { once: true });

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutResult = new Promise<GlobalCognitionContext>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      onStage?.('global_cognition_soft_timeout');
      resolve(emptyVoiceCallCognition);
    }, COGNITION_SOFT_TIMEOUT_MS);
  });
  const cognitionResult = buildGlobalCognitionContext(query, 'chat', {
    includeMemory: false,
    allowNetwork: false,
    ambientCacheOnly: true,
    refreshAmbient: false,
    signal: controller.signal,
    touchMemory: false,
    useSemanticMemory: false,
    onStage: (stage) => onStage?.(`global_cognition:${stage}`),
  }).catch((error) => {
    if (signal.aborted) throw error;
    return emptyVoiceCallCognition;
  });

  try {
    return await Promise.race([cognitionResult, timeoutResult]);
  } finally {
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener('abort', abortFromParent);
  }
}

// Both phases share one deadline and one material revision allowance. A stopped
// enhanced phase never replaces an already completed local bundle.
async function prepareVoiceCallMemory(query: string, signal: AbortSignal,
  onStage?: (stage: BaiyunCallPreparationStage | `global_cognition:${string}`) => void) {
  if (!query.trim()) return null;
  const deadline = Date.now() + CALL_MEMORY_RECALL_TIMEOUT_MS;
  const preparation = createMemoryMaterialPreparation({ signal });
  const phase = async (semantic: boolean): Promise<MemoryBundle | null> => {
    const budget = deadline - Date.now();
    if (budget <= 0) return null;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const stop = new Promise<null>(resolve => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); resolve(null); }, budget);
    });
    try {
      const bundle = await awaitVoiceCallStage(Promise.race([
        buildGlobalMemoryBundle(query, 'chat', { materialPreparation: preparation,
          signal: controller.signal, touchMemory: false, useSemanticMemory: semantic,
          allowRerank: false,
          numberMemories: true, throwOnMemoryError: true,
          onStage: stage => onStage?.(`global_cognition:${stage}`),
        }).catch(error => { if (signal.aborted) throw error; return null; }), stop,
      ]), { signal, timeoutMs: budget + 1, timeoutMessage: '通话记忆查找超时。' }).catch(error => {
        if (!(error instanceof VoiceCallStageTimeoutError)) throw error;
        timedOut = true;
        controller.abort();
        return null;
      });
      preparation.assertCurrent(signal);
      return timedOut || Date.now() >= deadline ? null : bundle;
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  };
  const local = await phase(false);
  const semantic = await phase(true);
  preparation.assertCurrent(signal);
  return semantic ?? local;
}

function unnumberVoiceCallMemoryContext(context: string) {
  // Numbering exposes host-only snapshot identities; the existing phone format
  // remains unchanged, including after the final material refresh.
  return context.replace(/(^- )\[记忆 \d+\] /gm, '$1');
}

class VoiceCallStageTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceCallStageTimeoutError';
  }
}

class VoiceCallStageAbortedError extends Error {
  constructor() {
    super('Voice call stage aborted.');
    this.name = 'VoiceCallStageAbortedError';
  }
}

function awaitVoiceCallStage<T>(
  promise: Promise<T>,
  {
    onTimeout,
    signal,
    timeoutMessage,
    timeoutMs,
  }: {
    onTimeout?: () => void;
    signal: AbortSignal;
    timeoutMessage: string;
    timeoutMs: number;
  },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => finish(() => reject(new VoiceCallStageAbortedError()));

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      finish(() => {
        onTimeout?.();
        reject(new VoiceCallStageTimeoutError(timeoutMessage));
      });
    }, timeoutMs);
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export const initialBaiyunCallBrainSnapshot: BaiyunCallBrainSnapshot = {
  message: '通话回复正在等待小仓鼠说话。',
  replyText: '',
  status: 'waiting',
};

function createCallMessage(
  role: 'I' | 'you',
  content: string,
  id: string,
): SubjectiveMessage {
  return {
    content,
    createdAt: Date.now(),
    id,
    role,
  };
}

function readCompletionText(payload: CompletionPayload) {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => part.text ?? '').join('').trim();
  }
  return '';
}

function inspectVoiceCallModelResponse(
  payload: CompletionPayload,
): VoiceCallModelResponseDiagnostics {
  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  const finishReason = choice?.finish_reason ?? 'missing';
  return {
    choiceCount: payload.choices?.length ?? 0,
    completionTokens: payload.usage?.completion_tokens ?? null,
    contentKind: Array.isArray(content)
      ? 'parts'
      : content === null
        ? 'null'
        : typeof content === 'string'
          ? 'string'
          : 'missing',
    finishReason,
    promptTokens: payload.usage?.prompt_tokens ?? null,
    rawContentChars: readCompletionText(payload).length,
    reasoningContentChars: choice?.message?.reasoning_content?.length ?? 0,
    totalTokens: payload.usage?.total_tokens ?? null,
    wasTruncated: finishReason === 'length' || finishReason === 'max_tokens',
  };
}

async function loadChatContextSnapshot(): Promise<ChatContextSnapshot> {
  const [state, missedCallContext] = await Promise.all([
    loadChatStateFast({ activeMessageLimit: 14 }),
    buildRecentMissedVoiceCallContext().catch(() => ''),
  ]);
  const active = state.sessions.find((session) => session.id === state.activeSessionId);
  if (!active) return { messages: [], missedCallContext, summary: '' };
  return {
    messages: active.messages
      .filter((message) => !!message.content.trim())
      .slice(-RECENT_CHAT_MESSAGE_LIMIT),
    missedCallContext,
    summary: '',
    sessionId: active.id,
  };
}

async function currentCallChatSummary(context: ChatContextSnapshot) {
  if (!context.sessionId) return '';
  try {
    const storage = await import('../chat/chatStorage');
    const { prepareChatSummaryCorrectionState } = await import('../chat/chatSummaryCorrectionStore');
    const checked = await prepareChatSummaryCorrectionState(context.sessionId, storage.emptyChatContextCompressionState);
    return buildConversationSummaryWithShortLogs(checked.state);
  } catch { return ''; }
}

function buildTrustedLifeStateInstruction(
  state: Awaited<ReturnType<typeof loadAssistantState>>,
) {
  const lifeModeText = describeAssistantAvailability(state.lifeMode);
  const updatedAtText = state.updatedAt > 0
    ? new Date(state.updatedAt).toLocaleString('zh-CN')
    : '未记录';
  return `【我最近保存的生活状态】
生活模式：${lifeModeText}
状态：${state.title}
小动作：${state.activity}
作息：${state.lifeContext ?? '没有额外作息偏移'}
记录时间：${updatedAtText}

这些是记录时间当时保存的生活状态。围绕明确记录的内容自然回应；小仓鼠猜测未记录的细节时，我按这份状态说清实际记录到的情况。`;
}

async function prepareBaiyunCallReplyRequest({
  careReason,
  callId,
  callHistory,
  recallHistory,
  chatContext,
  connection,
  direction,
  emotion,
  profile,
  onStage,
  signal,
  startedAt,
  transcript,
  openingPrompt,
}: {
  careReason?: VoiceCallCareReason;
  callId: string;
  callHistory: SubjectiveMessage[];
  recallHistory: SubjectiveMessage[];
  chatContext: ChatContextSnapshot;
  connection: AiConnection;
  direction: BaiyunCallDirection;
  emotion?: VoiceCallEmotionSignalEvent;
  profile: AiProfile;
  onStage?: (stage: BaiyunCallPreparationStage | `global_cognition:${string}`) => void;
  signal: AbortSignal;
  startedAt: number;
  transcript: VoiceCallTranscriptEvent;
  openingPrompt?: string;
}): Promise<{ finalRefresh: () => Promise<PreparedBaiyunCallRequest> }> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const currentId = `voice-call-${callId}-${transcript.turnId}-you`;
  const cognitionQuery = [...recallHistory.filter(message => message.id !== currentId).slice(-6)
    .map(message => `${message.role}: ${message.content}`),
    ...(transcript.text.trim() ? [`you: ${transcript.text.trim()}`] : [])].join('\n');
  const [cognition, memoryBundle, assistantState, desirePaper] = await Promise.all([
    buildVoiceCallCognitionContext({
      onStage,
      query: cognitionQuery,
      signal,
    }).then((value) => {
      onStage?.('global_cognition_ready');
      return value;
    }),
    prepareVoiceCallMemory(cognitionQuery, signal, onStage),
    loadAssistantState().then((value) => {
      onStage?.('assistant_state_ready');
      return value;
    }),
    loadJunluoDesirePromptPaper().catch(() => ''),
  ]);
  if (memoryBundle) attachGlobalMemoryBundle(cognition, memoryBundle);
  cognition.memoryContext = unnumberVoiceCallMemoryContext(cognition.memoryContext);
  onStage?.('context_sources_ready');
  const conversationMessages = [...chatContext.messages, ...callHistory];
  const conversationText = conversationMessages
    .filter((message) => message.role === 'you')
    .slice(-4)
    .map((message) => message.content)
    .join('\n');
  const contextSource = 'voice.call' as const;
  const compiledPrompt = await buildCompiledSystemPromptResult({
    contextProfile: getPromptContextProfileForSource(contextSource),
    conversationText,
    memoryContext: cognition.memoryContext,
    outputAudience: getPromptOutputAudienceForSource(contextSource),
    profile: buildBaiyunVoiceCallProfile(profile),
    runtimeContext: cognition.runtimeContext,
  });
  onStage?.('prompt_compiled');
  const serialize = () => {
    const refreshedPrompt = replaceCompiledMemoryContext(compiledPrompt,
      unnumberVoiceCallMemoryContext(cognition.memoryContext));
    const apiMessages = buildApiMessages(
      [
        BAIYUN_VOICE_CALL_FIXED_PROMPT,
        openingPrompt ?? '',
        careReason ? BAIYUN_VOICE_CALL_CARE_PROMPT : '',
        compiledPrompt.stablePrompt,
      ]
        .filter(Boolean)
        .join('\n\n'),
      conversationMessages,
      undefined,
      chatContext.summary,
    );
    apiMessages.push({
      content: [
        refreshedPrompt.dynamicPrompt,
        buildTrustedLifeStateInstruction(assistantState),
        desirePaper,
        buildBaiyunVoiceCallDynamicMaterial({
          careReason,
          direction,
          emotionHint: getBaiyunVoiceCallEmotionHint(emotion),
          startedAt,
        }),
        chatContext.missedCallContext,
      ].filter(Boolean).join('\n\n'),
      role: 'system',
    });

    const modelParameters = buildChatModelParameterPayload(connection.modelParameters);
    const maxTokens = Math.min(
      modelParameters.max_tokens ?? VOICE_CALL_MAX_TOKENS,
      VOICE_CALL_MAX_TOKENS,
    );
    onStage?.('request_serialized');
    return {
      memoryUsageReceipt: createVoiceCallMemoryUsageReceipt(callId, transcript.turnId, dataEpoch, memoryBundle),
      body: JSON.stringify({
        model: connection.model.trim(),
        messages: apiMessages satisfies ApiChatMessage[],
        ...(isOfficialDeepSeekV4Connection(connection)
          ? { thinking: { type: 'disabled' as const } }
          : {}),
        ...(isOfficialQwen397bConnection(connection) ? { enable_thinking: false } : {}),
        ...buildOpenAiCompatibilityPayload(connection),
        ...modelParameters,
        max_tokens: maxTokens,
        stream: false,
      }),
      url: `${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`,
    };
  };
  return { finalRefresh: async () => {
    if (signal.aborted || !canCommitBackupRestoreDataEpoch(dataEpoch)) throw new VoiceCallStageAbortedError();
    await cognition.refreshMemoryMaterials?.();
    chatContext.summary = await currentCallChatSummary(chatContext);
    if (signal.aborted || !canCommitBackupRestoreDataEpoch(dataEpoch)) throw new VoiceCallStageAbortedError();
    return serialize();
  } };
}

function requestChatCompletionWithXhr({
  apiKey,
  connection,
  prepared,
  signal,
}: {
  apiKey: string;
  connection: AiConnection;
  prepared: PreparedBaiyunCallRequest;
  signal: AbortSignal;
}): Promise<CompletionPayload> {
  let cacheMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  return new Promise<CompletionPayload>((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;

    const cleanup = () => signal.removeEventListener('abort', abortRequest);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const abortRequest = () => {
      try {
        request.abort();
      } catch {
        // The request may already be closed by the native networking layer.
      }
      finish(() => reject(new VoiceCallStageAbortedError()));
    };

    request.open('POST', prepared.url);
    request.timeout = MODEL_TIMEOUT_MS;
    request.setRequestHeader('Authorization', `Bearer ${apiKey.trim()}`);
    request.setRequestHeader('Content-Type', 'application/json');
    request.onload = () => {
      let payload: CompletionPayload = {};
      try {
        payload = request.responseText
          ? JSON.parse(request.responseText) as CompletionPayload
          : {};
        cacheMetric?.recordUsage(payload?.usage);
      } catch {
        // Compatible providers may return no JSON body for failed requests.
      }
      if (request.status < 200 || request.status >= 300) {
        finish(() => reject(new Error(
          payload.error?.message || `聊天模型返回错误状态 ${request.status}。`,
        )));
        return;
      }
      finish(() => resolve(payload));
    };
    request.onerror = () => finish(() => reject(
      request.status === 0 && request.responseText === 'timeout'
        ? new VoiceCallStageTimeoutError('通话回复请求超时。')
        : new Error('聊天模型网络请求失败。'),
    ));
    request.ontimeout = () => finish(() => reject(
      new VoiceCallStageTimeoutError('通话回复请求超时。'),
    ));
    request.onabort = () => finish(() => reject(new VoiceCallStageAbortedError()));

    if (signal.aborted) {
      abortRequest();
      return;
    }
    signal.addEventListener('abort', abortRequest, { once: true });
    cacheMetric = beginPromptCacheMetric({ contextProfile: 'voice-call', contextSource: 'voice.call', connection });
    request.send(prepared.body);
  }).finally(() => { void cacheMetric?.finish(); });
}

async function sendBaiyunCallReplyRequest({
  apiKey,
  connection,
  onDiagnostic,
  prepared,
  signal,
}: {
  apiKey: string;
  connection: AiConnection;
  onDiagnostic?: (diagnostics: VoiceCallModelResponseDiagnostics) => void;
  prepared: PreparedBaiyunCallRequest;
  signal: AbortSignal;
}) {
  const payload = await requestChatCompletionWithXhr({ apiKey, connection, prepared, signal });
  const rawText = readCompletionText(payload);
  const diagnostics = inspectVoiceCallModelResponse(payload);
  const cleaned = cleanBaiyunVoiceCallReply(rawText);
  onDiagnostic?.({
    ...diagnostics,
    cleanedContentChars: cleaned.length,
    outputAccepted: !!cleaned,
    ...(!cleaned && rawText ? { errorCode: 'call_reply_not_spoken' as const } : {}),
  });
  if (!cleaned) {
    if (diagnostics.wasTruncated && diagnostics.reasoningContentChars > 0) {
      throw new Error('模型在思考阶段用完了本轮输出额度，没有留下可朗读正文。');
    }
    if (diagnostics.rawContentChars > 0) {
      throw new Error('模型返回的内容清理后没有可用于电话朗读的正文。');
    }
    throw new Error('模型没有返回可用于电话朗读的正文。');
  }
  return cleaned;
}

export class BaiyunCallBrainSession {
  private abortController: AbortController | null = null;
  private activeTurnId: string | null = null;
  private readonly carePolicy: VoiceCallCarePolicy;
  private careSequence = 0;
  private readonly careTurnIds = new Set<string>();
  private callHistory: SubjectiveMessage[] = [];
  private readonly completedPlaybackTurnIds = new Set<string>();
  private readonly chatContextPromise: Promise<ChatContextSnapshot>;
  private generationQueue = Promise.resolve();
  private readonly handledTurnIds = new Set<string>();
  private readonly interruptedPlaybackTurnIds = new Set<string>();
  private readonly openingTurnIds = new Set<string>();
  private latestReplyTurnId: string | null = null;
  private latestTranscriptTurnId: string | null = null;
  private readonly options: BaiyunCallBrainOptions;
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private snapshot = initialBaiyunCallBrainSnapshot;
  private stopped = false;
  private readonly supersededTurnIds = new Set<string>();

  constructor(options: BaiyunCallBrainOptions) {
    this.options = options;
    this.carePolicy = new VoiceCallCarePolicy({
      canTrigger: () => !this.stopped && this.snapshot.status !== 'generating',
      onTrigger: (trigger) => this.queueCareReply(trigger),
    });
    this.chatContextPromise = getPrewarmedChatContext();
    void getMemoryDatabase().catch(() => undefined);
    this.publish(initialBaiyunCallBrainSnapshot);
  }

  getSnapshot() {
    return this.snapshot;
  }

  isAutomaticCareTurn(sourceTurnId: string | undefined) {
    return !!sourceTurnId && this.careTurnIds.has(sourceTurnId);
  }

  isAutomaticPlaybackTurn(sourceTurnId: string | undefined) {
    return !!sourceTurnId && (
      this.careTurnIds.has(sourceTurnId) || this.openingTurnIds.has(sourceTurnId)
    );
  }

  startCare() {
    this.carePolicy.start();
  }

  startOpening() {
    if (this.stopped || !this.options.openingPrompt?.trim()) {
      this.startCare();
      return;
    }
    const turnId = `opening-${Date.now()}`;
    this.latestReplyTurnId = turnId;
    this.openingTurnIds.add(turnId);
    const transcript: VoiceCallTranscriptEvent = {
      callId: this.options.callId,
      confidence: null,
      durationMs: 0,
      fallback: false,
      isFinal: true,
      language: null,
      latencyMs: 0,
      provider: 'funasr-local',
      status: 'ok',
      text: '',
      turnId,
      type: 'transcript',
    };
    this.generationQueue = this.generationQueue
      .catch(() => undefined)
      .then(() => this.generateReply(transcript, undefined, undefined, true));
  }

  handleVoiceActivity(active: boolean) {
    this.carePolicy.handleVoiceActivity(active);
    const openingTurnId = this.activeTurnId && this.openingTurnIds.has(this.activeTurnId)
      ? this.activeTurnId
      : this.snapshot.turnId && this.openingTurnIds.has(this.snapshot.turnId)
        ? this.snapshot.turnId
        : null;
    if (active && openingTurnId) {
      const interruptedTurnId = openingTurnId;
      this.supersededTurnIds.add(interruptedTurnId);
      this.latestReplyTurnId = null;
      this.abortController?.abort();
      this.handlePlaybackInterrupted(interruptedTurnId);
      this.openingTurnIds.delete(interruptedTurnId);
      this.startCare();
      return;
    }
    if (!active || !this.activeTurnId || !this.careTurnIds.has(this.activeTurnId)) return;
    const interruptedTurnId = this.activeTurnId;
    this.supersededTurnIds.add(interruptedTurnId);
    this.latestReplyTurnId = null;
    this.abortController?.abort();
    this.publish({
      automaticCareAttempt: this.carePolicy.getAutomaticAttempts(),
      message: '小仓鼠开口了，云云停下照护回复并继续听。',
      replyText: '',
      status: 'waiting',
      turnId: interruptedTurnId,
    });
  }

  handlePlaybackEvent(event: VoiceCallPlaybackEvent) {
    if (this.stopped || event.callId !== this.options.callId) return;
    if (event.sourceTurnId && event.state === 'completed') this.completedPlaybackTurnIds.add(event.sourceTurnId);
    this.carePolicy.handlePlaybackEvent(event);
    if (event.sourceTurnId && this.openingTurnIds.has(event.sourceTurnId)) {
      if (event.state === 'interrupted' || event.state === 'failed') {
        this.handlePlaybackInterrupted(event.sourceTurnId);
      }
      if (event.state === 'completed' || event.state === 'interrupted' || event.state === 'failed') {
        this.openingTurnIds.delete(event.sourceTurnId);
        this.startCare();
      }
    }
    if (
      event.state === 'interrupted'
      || (event.state === 'failed' && this.isAutomaticCareTurn(event.sourceTurnId))
    ) {
      this.handlePlaybackInterrupted(event.sourceTurnId);
    }
  }

  handleTranscript(event: VoiceCallTranscriptEvent) {
    if (
      this.stopped
      || event.callId !== this.options.callId
      || !event.isFinal
    ) return;
    this.carePolicy.handleTranscript(event);
    if (
      event.status !== 'ok'
      || !event.text.trim()
      || this.handledTurnIds.has(event.turnId)
    ) return;
    this.latestTranscriptTurnId = event.turnId;
    this.latestReplyTurnId = event.turnId;
    this.pendingTurns.forEach((pending, pendingTurnId) => {
      if (pendingTurnId !== event.turnId && pending.timer) clearTimeout(pending.timer);
    });
    this.pendingTurns.clear();
    if (this.activeTurnId && this.activeTurnId !== event.turnId) {
      this.supersededTurnIds.add(this.activeTurnId);
      this.abortController?.abort();
    }
    const pending = this.pendingTurns.get(event.turnId) ?? {};
    pending.transcript = event;
    if (
      detectExplicitVoiceCallDistress(event.text, event.turnId, Date.now())
      && this.carePolicy.claimAutomaticCare('explicit_distress', true)
    ) {
      pending.careReason = 'explicit_distress';
      this.carePolicy.registerCareSourceTurn(event.turnId);
      this.careTurnIds.add(event.turnId);
    }
    this.pendingTurns.set(event.turnId, pending);
    this.schedulePendingTurn(event.turnId);
  }

  handleEmotion(event: VoiceCallEmotionSignalEvent) {
    if (event.callId === this.options.callId) this.carePolicy.handleEmotion(event);
    if (
      this.stopped
      || event.callId !== this.options.callId
      || this.handledTurnIds.has(event.turnId)
    ) return;
    const pending = this.pendingTurns.get(event.turnId) ?? {};
    pending.emotion = event;
    this.pendingTurns.set(event.turnId, pending);
    if (pending.transcript) this.schedulePendingTurn(event.turnId);
  }

  handlePlaybackInterrupted(sourceTurnId: string | undefined) {
    if (
      this.stopped
      || !sourceTurnId
      || this.interruptedPlaybackTurnIds.has(sourceTurnId)
    ) return false;
    const replyMessageId = `voice-call-${this.options.callId}-${sourceTurnId}-I`;
    const previousLength = this.callHistory.length;
    this.callHistory = this.callHistory.filter((message) => message.id !== replyMessageId);
    const removed = this.callHistory.length !== previousLength;
    const clearsCurrentReply = this.snapshot.turnId === sourceTurnId;
    if (!removed && !clearsCurrentReply) return false;
    this.interruptedPlaybackTurnIds.add(sourceTurnId);
    if (clearsCurrentReply) {
      this.publish({
        message: '这轮电话影子回复已被打断。',
        replyText: '',
        status: 'interrupted',
        turnId: sourceTurnId,
      });
    }
    return true;
  }

  handlePlaybackRequestFailed(sourceTurnId: string | undefined) {
    if (!sourceTurnId) return;
    this.handlePlaybackInterrupted(sourceTurnId);
    if (this.openingTurnIds.delete(sourceTurnId)) this.startCare();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController?.abort();
    this.abortController = null;
    this.pendingTurns.forEach((pending) => {
      if (pending.timer) clearTimeout(pending.timer);
    });
    this.pendingTurns.clear();
    this.carePolicy.stop();
    this.careTurnIds.clear();
    this.openingTurnIds.clear();
    this.callHistory = [];
    this.completedPlaybackTurnIds.clear();
    this.interruptedPlaybackTurnIds.clear();
    this.activeTurnId = null;
    this.latestReplyTurnId = null;
    this.latestTranscriptTurnId = null;
    this.supersededTurnIds.clear();
    this.publish({
      message: '本次通话回复会话已经结束。',
      replyText: '',
      status: 'stopped',
    });
  }

  private publish(snapshot: BaiyunCallBrainSnapshot) {
    this.snapshot = snapshot;
    this.options.onSnapshot(snapshot);
  }

  private schedulePendingTurn(turnId: string) {
    const pending = this.pendingTurns.get(turnId);
    if (!pending?.transcript || pending.timer) return;
    if (pending.emotion || !this.options.emotion2vecEnabled) {
      this.queuePendingTurn(turnId);
      return;
    }
    pending.timer = setTimeout(() => this.queuePendingTurn(turnId), EMOTION_WAIT_MS);
  }

  private queuePendingTurn(turnId: string) {
    const pending = this.pendingTurns.get(turnId);
    if (
      !pending?.transcript
      || this.handledTurnIds.has(turnId)
      || this.latestTranscriptTurnId !== turnId
    ) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingTurns.delete(turnId);
    this.handledTurnIds.add(turnId);
    this.generationQueue = this.generationQueue
      .catch(() => undefined)
      .then(() => this.generateReply(
        pending.transcript!,
        pending.emotion,
        pending.careReason,
      ));
  }

  private queueCareReply(trigger: VoiceCallCareTrigger) {
    if (this.stopped) return;
    const turnId = `care-${trigger.reason}-${Date.now()}-${++this.careSequence}`;
    this.latestReplyTurnId = turnId;
    this.carePolicy.registerCareSourceTurn(turnId);
    this.careTurnIds.add(turnId);
    const transcript: VoiceCallTranscriptEvent = {
      callId: this.options.callId,
      confidence: null,
      durationMs: 0,
      fallback: false,
      isFinal: true,
      language: null,
      latencyMs: 0,
      provider: 'funasr-local',
      status: 'ok',
      text: '',
      turnId,
      type: 'transcript',
    };
    this.generationQueue = this.generationQueue
      .catch(() => undefined)
      .then(() => this.generateReply(transcript, trigger.emotion, trigger.reason));
  }

  private async generateReply(
    transcript: VoiceCallTranscriptEvent,
    emotion?: VoiceCallEmotionSignalEvent,
    careReason?: VoiceCallCareReason,
    opening = false,
  ) {
    if (this.stopped || this.latestReplyTurnId !== transcript.turnId) return;
    const { apiKey, connection } = this.options;
    if (!connection || !apiKey.trim()) {
      this.publish({
        automaticCareAttempt: this.carePolicy.getAutomaticAttempts(),
        careReason,
        error: '聊天模型或 API Key 还没有配置。',
        message: '通话回复没有生成：请先配置当前聊天模型与 API Key。',
        replyText: '',
        status: 'failed',
        turnId: transcript.turnId,
      });
      return;
    }
    if (transcript.text.trim()) {
      this.callHistory.push(createCallMessage(
        'you',
        transcript.text.trim(),
        `voice-call-${this.options.callId}-${transcript.turnId}-you`,
      ));
    }
    this.callHistory = this.callHistory.slice(-CALL_HISTORY_MESSAGE_LIMIT);
    this.publish({
      automaticCareAttempt: this.carePolicy.getAutomaticAttempts(),
      careReason,
      message: careReason ? '云云正在准备通话照护回应。' : '云云正在整理通话上下文。',
      playbackIntent: opening ? 'opening_auto' : careReason ? 'care_auto' : 'manual',
      replyText: '',
      status: 'generating',
      turnId: transcript.turnId,
    });
    const controller = new AbortController();
    const dataEpoch = captureBackupRestoreDataEpoch();
    const unsubscribeRestore = subscribeBackupRestoreRuntimeState(() => {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) controller.abort();
    });
    this.abortController = controller;
    this.activeTurnId = transcript.turnId;
    const generationStartedAt = Date.now();
    let modelRequestStartedAt = 0;
    let lastPreparationStage = 'generation_started';
    let cognitionDegraded = false;
    const reportPreparationStage = (stage: string) => {
      const elapsedMs = Date.now() - generationStartedAt;
      lastPreparationStage = stage;
      if (stage === 'global_cognition_skipped' || stage === 'global_cognition_soft_timeout') {
        cognitionDegraded = true;
        this.options.onDiagnostic?.('voice_call_context_degraded', {
          elapsedMs,
          reason: stage,
          turnId: transcript.turnId,
        });
      }
      console.info('[VoiceCallBrain] preparation_stage', {
        elapsedMs,
        stage,
        turnId: transcript.turnId,
      });
    };
    try {
      console.info('[VoiceCallBrain] generation_started', {
        turnId: transcript.turnId,
      });
      const prepared = await awaitVoiceCallStage(
        this.chatContextPromise.then((chatContext) => {
          reportPreparationStage('chat_context_ready');
          return prepareBaiyunCallReplyRequest({
            careReason,
            callId: this.options.callId,
            callHistory: this.callHistory,
            recallHistory: this.callHistory.filter(message => message.role === 'you'
              || [...this.completedPlaybackTurnIds].some(turnId => message.id === `voice-call-${this.options.callId}-${turnId}-I`)),
            chatContext,
            connection,
            direction: this.options.direction,
            emotion,
            profile: this.options.profile,
            onStage: reportPreparationStage,
            signal: controller.signal,
            startedAt: this.options.startedAt,
            transcript,
            openingPrompt: opening ? this.options.openingPrompt : undefined,
          });
        }),
        {
          signal: controller.signal,
          timeoutMessage: '通话上下文整理超时。',
          timeoutMs: CONTEXT_PREP_TIMEOUT_MS,
        },
      );
      if (this.stopped || this.latestReplyTurnId !== transcript.turnId) return;
      console.info('[VoiceCallBrain] context_ready', {
        cognitionDegraded,
        elapsedMs: Date.now() - generationStartedAt,
        turnId: transcript.turnId,
      });
      this.options.onDiagnostic?.('voice_call_context_ready', {
        cognitionDegraded,
        elapsedMs: Date.now() - generationStartedAt,
        lastStage: lastPreparationStage,
        turnId: transcript.turnId,
      });
      this.publish({
        automaticCareAttempt: this.carePolicy.getAutomaticAttempts(),
        careReason,
        message: careReason ? '云云正在组织一两句照护短话。' : '云云正在等待聊天模型回应。',
        playbackIntent: opening ? 'opening_auto' : careReason ? 'care_auto' : 'manual',
        replyText: '',
        status: 'generating',
        turnId: transcript.turnId,
      });
      const modelQueuedAt = Date.now();
      let sentMemoryUsage: VoiceCallMemoryUsageReceipt | undefined;
      this.options.onDiagnostic?.('voice_call_model_queued', { turnId: transcript.turnId });
      const scheduled = await awaitVoiceCallStage(
        runScheduledAiCall(
          'voiceCallReply',
          'urgent',
          async () => {
            const request = await prepared.finalRefresh();
            if (this.stopped || this.latestReplyTurnId !== transcript.turnId || controller.signal.aborted
              || !canCommitBackupRestoreDataEpoch(dataEpoch)) throw new VoiceCallStageAbortedError();
            sentMemoryUsage = request.memoryUsageReceipt;
            modelRequestStartedAt = Date.now();
            this.options.onDiagnostic?.('voice_call_model_request_started', {
              turnId: transcript.turnId,
              latencyMs: modelRequestStartedAt - modelQueuedAt,
            });
            return sendBaiyunCallReplyRequest({
              apiKey,
              connection,
              onDiagnostic: (diagnostics) => this.options.onDiagnostic?.('voice_call_model_response', {
                ...diagnostics,
                turnId: transcript.turnId,
              }),
              prepared: request,
              signal: controller.signal,
            });
          },
        ),
        {
          onTimeout: () => controller.abort(),
          signal: controller.signal,
          timeoutMessage: '通话回复请求超时。',
          timeoutMs: MODEL_TIMEOUT_MS + MODEL_DEADLINE_GRACE_MS,
        },
      );
      if (this.stopped || controller.signal.aborted || this.latestReplyTurnId !== transcript.turnId
        || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      if (scheduled.skipped) throw new Error('当前有另一项模型任务正在运行。');
      this.options.onDiagnostic?.('voice_call_model_request_completed', {
        turnId: transcript.turnId,
        latencyMs: Date.now() - modelRequestStartedAt,
      });
      const replyText = scheduled.value;
      this.callHistory.push(createCallMessage(
        'I',
        replyText,
        `voice-call-${this.options.callId}-${transcript.turnId}-I`,
      ));
      this.callHistory = this.callHistory.slice(-CALL_HISTORY_MESSAGE_LIMIT);
      if (sentMemoryUsage) this.options.onMemoryUsagePrepared?.(transcript.turnId, sentMemoryUsage);
      this.publish({
        automaticCareAttempt: this.carePolicy.getAutomaticAttempts(),
        careReason,
        generatedAt: Date.now(),
        message: careReason ? '通话照护回复已经生成。' : '电话影子回复已经生成。',
        playbackIntent: opening ? 'opening_auto' : careReason ? 'care_auto' : 'manual',
        replyText,
        status: 'ready',
        turnId: transcript.turnId,
      });
      console.info('[VoiceCallBrain] generation_succeeded', {
        elapsedMs: Date.now() - generationStartedAt,
        turnId: transcript.turnId,
      });
    } catch (caught) {
      if (this.stopped) return;
      if (this.supersededTurnIds.delete(transcript.turnId)) return;
      if (modelRequestStartedAt) this.options.onDiagnostic?.('voice_call_model_request_failed', {
        turnId: transcript.turnId,
        latencyMs: Date.now() - modelRequestStartedAt,
      });
      if (caught instanceof VoiceCallStageTimeoutError) {
        this.options.onDiagnostic?.('voice_call_context_timeout', {
          elapsedMs: Date.now() - generationStartedAt,
          lastStage: lastPreparationStage,
          turnId: transcript.turnId,
        });
        this.publish({
          automaticCareAttempt: this.carePolicy.getAutomaticAttempts(),
          careReason,
          error: caught.message,
          message: `${caught.message} 没有生成白云正文。`,
          replyText: '',
          status: 'failed',
          turnId: transcript.turnId,
        });
        console.warn('[VoiceCallBrain] generation_timed_out', {
          elapsedMs: Date.now() - generationStartedAt,
          stage: caught.message,
          turnId: transcript.turnId,
        });
        return;
      }
      if (caught instanceof VoiceCallStageAbortedError || controller.signal.aborted) {
        return;
      }
      const detail = caught instanceof Error ? caught.message : '未知错误';
      this.publish({
        automaticCareAttempt: this.carePolicy.getAutomaticAttempts(),
        careReason,
        error: detail,
        message: `通话回复没有生成：${detail}`,
        replyText: '',
        status: 'failed',
        turnId: transcript.turnId,
      });
      console.warn('[VoiceCallBrain] generation_failed', {
        elapsedMs: Date.now() - generationStartedAt,
        error: detail,
        turnId: transcript.turnId,
      });
    } finally {
      unsubscribeRestore();
      if (this.abortController === controller) this.abortController = null;
      if (this.activeTurnId === transcript.turnId) this.activeTurnId = null;
    }
  }
}
