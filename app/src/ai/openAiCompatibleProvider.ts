import { Platform } from 'react-native';
import type { AiConnection, AiProfile } from './types';
import { applyConnectionPromptCacheToRequestBody } from './promptCacheRequest';
import { projectWishPackageTools, parseWishPackageToolCalls } from '../wishPool/wishPackageToolProtocol';
import { buildPostImageVisionMessages, type PostVisionImage, type VisionContentPart } from './postImageVisionRequest';
import { buildChatImageVisionPrompt, type ChatImageVisionMaterial } from './chatImageVisionPrompt';
import { getChatTransportErrorDetails, normalizeChatProviderRequestId, readChatProviderHost, requestObservedChatCompletion } from './chatCompletionTransport';
import { buildCompiledSystemPromptResult } from './builtInSystemPrompt';
import { buildAmbientContext } from './ambientContext';
import { isReplyOnlyHistoryLabels } from './replyTransportFormatting';
import { buildChatModelParameterPayload, buildToolProviderTransportParameters, isOfficialQwen27bConnection, isOfficialQwen397bConnection, isOfficialQwenMaxConnection } from './modelParameters';
import type { ToolProviderCapabilitySource } from './toolProviderCapabilities';
import {
  buildApiMessages,
  buildApiMessageContent,
  parseAssistantMessageBubbles,
  SUBJECTIVE_IDENTITY_PROTOCOL,
  SUBJECTIVE_OUTPUT_PROTOCOL,
  type ApiChatMessage,
  type SubjectiveMessage,
} from './subjectiveMessages';
import {
  containsToolProtocolMarkup,
  extractSafeDirectPlainText,
  extractReminderFeedbackReplyRoot,
  extractVisibleReply,
  extractVisibleReplyFromRaw,
  isExplicitPhoneEmergencySilence,
  normalizeVisibleReplyRaw,
  type VisibleReplyExtractionResult,
  type VisibleReplyFailureReason,
  type VisibleReplySource,
  type VisibleReplyStatus,
} from './visibleReplyExtraction';
import { estimateApiMessagesTokens, estimateTextTokens, getReplyTokenReserve, getRequestMessages } from '../chat/contextCompression';
import type { PromptCacheStats, PromptTokenBreakdown } from '../chat/chatStorage';
import {
  beginPromptCacheMetric,
  extractPromptCacheUsageFromResponseUsage,
  type PromptCacheContextSource,
} from './promptCacheMetrics';
import { beginProactiveRequestCapture, finishProactiveRequestCapture, recordPromptRuntimeSnapshot } from './promptDiagnostics';
import {
  getPromptContextProfileForSource,
  getPromptOutputAudienceForSource,
  isPromptContextSource,
  type PromptContextSource,
} from './promptContextProfile';
import { replaceCompiledMemoryContext, replaceCompiledModuleInstruction, type CompiledPromptResult } from './persona/promptCompiler';
import { buildQwenChatLayout, isSiliconQwenChatConnection, isLocalQwenChatConnection,
  mergeLocalQwenSystemMessages, type QwenChatLayoutMode } from './qwenChatLayout';
import {
  BAIYUN_PROVIDER_EMPTY_SUCCESS_CODE,
  BAIYUN_CHAT_FIXED_OUTPUT_PROTOCOL,
  BAIYUN_DESKTOP_REMINDER_DRAFT_OUTPUT_PROTOCOL,
  DESKTOP_REMINDER_DRAFT_CONTINUATION_INSTRUCTION,
  BAIYUN_CHAT_SEMANTIC_ASSISTANT_PREFIX,
  BAIYUN_CHAT_SEMANTIC_GUIDANCE_PROTOCOL,
  BAIYUN_CHAT_SINGLE_ROOT_JSON_ASSISTANT_PREFIX,
  getBaiyunChatSemanticOutputTailProtocol,
  isBaiyunChatSemanticOutputTailProtocol,
  type BaiyunChatSemanticEnvelopeProtocol,
  type BaiyunChatSemanticOutputModules,
} from './behavior/actionChatSemantic';
import { BAIYUN_SEMANTIC_SIGNAL_KINDS } from './behavior/actionSemantic';
import {
  parseOpenAiToolCalls,
  parsePromptJsonToolInvocations,
  toolDefinitionToOpenAiTool,
  type JunLuoChatToolMode,
  type JunLuoToolInvocation,
  type JunLuoToolInvocationParseError,
  type OpenAiCompatibleToolCall,
} from '../tools/toolCallProtocol';
import type { JunLuoToolDefinition } from '../tools/toolTypes';
import { buildTheaterSystemPrompt } from '../theater/theaterPrompt';
import {
  buildTheaterStoryStateSystemPrompt,
  THEATER_STORY_STATE_TASK_PROMPT,
} from '../theater/theaterStoryStatePrompt';
import { buildRecentMissedVoiceCallContext } from '../voiceCall/voiceCallInvitationStore';
import { WISH_CHAT_ENVELOPE_PROTOCOL, WISH_CHAT_RETAINED_OUTPUT_PROTOCOL } from '../wishPool/wishPoolChatContract';

const WISH_CHAT_FIXED_OUTPUT_PROTOCOL = [WISH_CHAT_ENVELOPE_PROTOCOL, WISH_CHAT_RETAINED_OUTPUT_PROTOCOL].join('\n\n');

type ConnectionResult = {
  detail: string;
  ok: boolean;
};

type TestOptions = {
  apiKey: string;
  connection: AiConnection;
};

export type BaiyunChatResponseEnvelopeMode =
  | 'messages_only'
  | 'messages_with_semantic';

export type SemanticPrefixCompletionMode =
  | 'auto'
  | 'disabled';

export type OpenAiCompatibleAssistantToolCallMessage = {
  subject: 'I';
  kind: 'tool_request';
  content: string;
  reasoningContent?: string;
  toolCalls: Array<{
    callId: string;
    type: 'function';
    rawName: string;
    rawArguments: string;
  }>;
};

export type OpenAiCompatibleContinuationMessage =
  | OpenAiCompatibleAssistantToolCallMessage
  | {
      subject: 'I';
      kind: 'tool_result';
      callId: string;
      toolId: string;
      content: string;
    };

export type OpenAiCompatibleRequestMessage =
  | ApiChatMessage
  | {
      role: 'assistant';
      content: string;
      reasoning_content?: string;
      tool_calls: OpenAiCompatibleToolCall[];
    }
  | {
      role: 'tool';
      content: string;
      tool_call_id: string;
    };

export type ChatOptions = TestOptions & {
  qwenChatLayout?: QwenChatLayoutMode;
  /** Candidate main-chat material port; never used by background/model-only tasks. */
  prepareBackstageRequest?: (input: import('../theater/theaterBackstageCapacity').BackstageCapacityInput) => Promise<{
    preambleMessages?: ApiChatMessage[];
    responseInstruction?: string;
    preparedCompiledPrompt?: CompiledPromptResult;
    isCurrent?: () => boolean;
    source?: import('./subjectiveMessages').TheaterBackstageMessageSource;
  }>;
  profile: AiProfile;
  messages: SubjectiveMessage[];
  // Estimate only; history selection remains with the caller.
  includeToolPromptTokens?: boolean;
  /** Used by the unified contact path: validate the assembled request before spending its opportunity. */
  rejectOversizedRequest?: boolean;
  beforeTransportRequest?: () => Promise<void>;
  /** Ordinary image host validates only references present in the final serialized request. */
  beforeChatImageTransport?: (systemMaterials: readonly string[]) => Promise<void>;
  /** Local-only final material check. Runs after asynchronous preparation/preflight, before serialization. */
  refreshMemoryMaterials?: (input?: { continuationMessages: readonly OpenAiCompatibleContinuationMessage[] }) => Promise<{
    memoryContext?: string; conversationSummary?: string; messages?: SubjectiveMessage[]; continuationMessages?: OpenAiCompatibleContinuationMessage[];
    responseInstruction?: string;
  }>;
  /** Summary-only check after all other asynchronous preflight, immediately before transport. */
  refreshConversationSummary?: () => Promise<string>;
  /** Observation only: failures in this callback cannot change a request. */
  onPreparationCheckpoint?: (key: 'providerEnteredAt' | 'envelopeReadyAt' | 'preflightReadyAt', at: number) => void;
  /** Observation only: failures in this callback cannot change a request. */
  onTransportAttempt?: (event: ChatTransportAttemptEvent) => void;
  transportRequestKind?: ChatTransportRequestKind;
  memoryContext?: string;
  ambientContext?: string;
  onReplyDiagnostics?: (diagnostics: ChatReplyDiagnostics) => void;
  preambleMessages?: ApiChatMessage[];
  /** Host-selected sleep/schedule material only; other preambles retain their original position. */
  sleepScheduleMessages?: ApiChatMessage[];
  /** Optional confirmed player facts; never a reason to request or trim necessary chat. */
  musicPlaybackEvents?: readonly import('../music/musicPlaybackMaterial').MusicPlaybackMaterialEvent[];
  recoverEmptySemanticEnvelope?: (reasoningContent: string) => string;
  responseInstruction?: string;
  responseEnvelopeMode?: BaiyunChatResponseEnvelopeMode;
  fixedEnvelopeMode?: import('./behavior/actionChatFixedEnvelope').BaiyunFixedEnvelopeMode;
  desktopReminderDraftContinuation?: boolean;
  semanticEnvelopeProtocol?: BaiyunChatSemanticEnvelopeProtocol;
  semanticOutputModules?: BaiyunChatSemanticOutputModules;
  semanticPrefixCompletionMode?: SemanticPrefixCompletionMode;
  signal?: AbortSignal;
  toolAgentProtocolMode?: boolean;
  allowPhoneEmergencySilence?: boolean;
  wishPackageEntry?: boolean;
  toolMode?: JunLuoChatToolMode;
  toolChoice?: 'auto' | 'required' | 'none';
  strictTools?: boolean;
  thinkingMode?: 'enabled' | 'disabled';
  cameraObservationReplyJson?: boolean;
  /** Local response parsing for the first Windows reminder-save receipt. */
  desktopReminderSaveFeedback?: boolean;
  /** Original save receipt, separate from ambient material for the reviewed Windows feedback order. */
  desktopReminderSaveFeedbackInstruction?: string;
  /** Internal binding only; never serialized as a model-visible field. */
  desktopReminderSaveFeedbackSourceId?: string;
  toolCapabilitySource?: ToolProviderCapabilitySource;
  reasoningEffort?: 'low' | 'high' | 'xhigh' | 'max';
  prefixWithTools?: boolean;
  tools?: JunLuoToolDefinition[];
  continuationMessages?: OpenAiCompatibleContinuationMessage[];
  conversationSummary?: string;
  contextSource?: PromptCacheContextSource;
  metricContextSource?: PromptCacheContextSource;
  onPromptTokens?: (
    tokens: number,
    source: 'estimate' | 'api',
    breakdown: PromptTokenBreakdown,
    promptCache: Omit<PromptCacheStats, 'stablePrefixChanged'>,
  ) => void;
};

export type TheaterCompletionMessage = {
  content: string;
  role: 'you' | 'I' | 'system';
};

export type TheaterCompletionOptions = TestOptions & {
  anchorBlock?: string;
  messages: TheaterCompletionMessage[];
  names?: { I: string; you: string };
  openingPrompt?: string;
  persona: string;
  signal?: AbortSignal;
  storyState?: string;
  temperature?: number;
};

export type TheaterStoryStateOptions = TestOptions & {
  anchorBlock?: string;
  messages: TheaterCompletionMessage[];
  names?: { I: string; you: string };
  persona: string;
  previousStoryState?: string;
  signal?: AbortSignal;
};

export type ChatCompletionPromptEnvelopeOptions = Pick<
  ChatOptions,
  | 'ambientContext'
  | 'connection'
  | 'contextSource'
  | 'qwenChatLayout'
  | 'conversationSummary'
  | 'memoryContext'
  | 'messages'
  | 'preambleMessages'
  | 'sleepScheduleMessages'
  | 'musicPlaybackEvents'
  | 'profile'
  | 'responseInstruction'
  | 'responseEnvelopeMode'
  | 'fixedEnvelopeMode'
  | 'desktopReminderDraftContinuation'
  | 'semanticEnvelopeProtocol'
  | 'semanticOutputModules'
  | 'toolAgentProtocolMode'
  | 'desktopReminderSaveFeedback'
  | 'desktopReminderSaveFeedbackInstruction'
  | 'desktopReminderSaveFeedbackSourceId'
> & {
  desireInstructionOverride?: string;
  readOnlyPreparation?: boolean;
  musicRequestOverheadTokens?: number;
  /** Reuse the same compiled snapshot for offline capacity inspection without rereading state. */
  preparedCompiledPrompt?: CompiledPromptResult;
  /** Includes the already-read missed-call context; prevents duplicate reads/appends. */
  preparedAmbientContext?: string;
};

export type ChatCompletionPromptEnvelope = {
  reassembleMaterials?: (materials: { memoryContext?: string; conversationSummary?: string; messages?: SubjectiveMessage[]; responseInstruction?: string }) => ChatCompletionPromptEnvelope;
  apiMessages: ApiChatMessage[];
  compiledPrompt: CompiledPromptResult;
  contextProfile: CompiledPromptResult['contextProfile'];
  estimatedCacheStats: Omit<PromptCacheStats, 'stablePrefixChanged'>;
  estimatedPromptTokens: number;
  promptBreakdown: PromptTokenBreakdown;
  runtimeAmbientContext: string;
  stablePrefixFingerprint: string;
  stablePrefixText: string;
  stablePrefixTokens: number;
  stableSystemPrompt: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | Array<{ text?: string; type?: string }>;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{
        function?: {
          arguments?: string;
          name?: string;
        };
        id?: string;
        type?: string;
      }>;
    };
  }>;
  error?: {
    code?: string | number;
    message?: string;
  };
  usage?: {
    cached_input_tokens?: number;
    cached_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
};

type VisibleReplyDevFixtureCode = '1' | '2' | '3' | '4' | '5' | '6';

function buildVisibleReplyDevFixturePayload(input: {
  messages: readonly SubjectiveMessage[];
  responseInstruction?: string;
}): ChatCompletionResponse | undefined {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return undefined;
  const currentMessage = [...input.messages].reverse().find((message) => message.role === 'you');
  const messageMatch = currentMessage?.content.trim().match(/^#5F2-([1-6])$/u);
  const instructionMatch = input.responseInstruction?.match(
    /(?:^|\r?\n)(#5F2-([1-6]))(?=\r?\n|$)/u,
  );
  const visibleText = messageMatch
    ? currentMessage?.content.trim() ?? ''
    : instructionMatch?.[1] ?? '';
  const code = (messageMatch?.[1] ?? instructionMatch?.[2]) as VisibleReplyDevFixtureCode | undefined;
  if (!code || !visibleText) return undefined;
  const state = JSON.stringify({
    semantic: {
      signals: [{
        kind: 'ordinary_chat',
        confidence: 0.95,
        evidence: visibleText,
        target: 'none',
        temporality: 'current',
      }],
      careUrgency: 'none',
      uncertain: false,
    },
    continuityResolutions: [],
    shareResponses: [],
    notebookAction: null,
  });
  const tagged = (messages: string[]) => (
    `<state>${state}</state><messages>${JSON.stringify(messages)}</messages>`
  );
  const fixtureByCode: Record<VisibleReplyDevFixtureCode, {
    content: string;
    reasoning_content?: string;
  }> = {
    '1': { content: tagged([visibleText]) },
    '2': { content: '', reasoning_content: tagged([visibleText]) },
    '3': { content: tagged([]), reasoning_content: tagged([visibleText]) },
    '4': { content: `<message>${visibleText}</message>` },
    '5': { content: `${tagged([visibleText])}\nfixture-trailing-structure` },
    '6': { content: '', reasoning_content: visibleText },
  };
  return {
    choices: [{
      finish_reason: 'stop',
      message: fixtureByCode[code],
    }],
  };
}

type ChatCompletionResponseMessage = NonNullable<
  NonNullable<ChatCompletionResponse['choices']>[number]['message']
>;

const CONNECTION_TEST_TIMEOUT_MS = 60_000;
const CHAT_COMPLETION_TIMEOUT_MS = 120_000;
const VISION_COMPLETION_TIMEOUT_MS = 240_000;

function shouldDisableThinkingForSiliconFlowQwen35(connection: AiConnection) {
  if (!/^Qwen\/Qwen3\.5-/u.test(connection.model.trim())) return false;
  try {
    return new URL(connection.baseUrl.trim()).hostname.toLowerCase() === 'api.siliconflow.cn';
  } catch {
    return false;
  }
}

export type ChatReplyDiagnostics = {
  responseObserved?: boolean;
  directContentChars?: number;
  fixedEnvelopeRawDirect?: string;
  finishReason?: string;
  jsonOutputRequested: boolean;
  rawContent: string;
  rawContentChars: number;
  rawContentFormat: 'empty' | 'json_object' | 'json_value' | 'fenced_content' | 'tagged_content' | 'non_json';
  reasoningContentChars?: number;
  recoveredFromReasoning: boolean;
  responseEnvelopeMode: BaiyunChatResponseEnvelopeMode;
  semanticEnvelopeProtocol?: BaiyunChatSemanticEnvelopeProtocol;
  semanticPrefixCompletionRequested: boolean;
  technicalCode?: typeof BAIYUN_PROVIDER_EMPTY_SUCCESS_CODE;
  toolCallCount?: number;
  usagePresent?: boolean;
  visibleReplyFailureReason?: VisibleReplyFailureReason;
  visibleReplySource?: VisibleReplySource;
  visibleReplyStatus?: VisibleReplyStatus;
  wasTruncated: boolean;
  usage?: ChatCompletionUsage;
};

export type ChatTransportRequestKind = 'initial' | 'tool_continuation' | 'protocol_correction'
  | 'tool_fact_correction' | 'quality_retry';
export type ChatTransportAttemptEvent = {
  offeredToolCount?: number;
  toolCapabilitySource?: ToolProviderCapabilitySource;
  phase: 'started' | 'progress' | 'finished';
  requestPurpose?: 'package_discovery' | 'concrete_tools' | 'final';
  retryReason?: 'empty_response' | 'visible_envelope_invalid' | 'tool_fact_correction' | 'protocol_correction';
  requestKind?: ChatTransportRequestKind;
  responseEnvelopeMode: BaiyunChatResponseEnvelopeMode;
  outcome?: 'response_received' | 'http_error' | 'network_error' | 'timeout' | 'aborted';
  httpStatus?: number;
  startedAt?: number;
  headersReceivedAt?: number;
  transportKind?: 'fetch' | 'xhr';
  responseAvailableAt?: number;
  bodyReadStartedAt?: number;
  timeoutMs?: number;
  errorName?: string;
  errorCode?: string;
  causeCode?: string;
  externalAborted?: boolean;
  providerRequestId?: string;
  providerHost?: string;
  firstContentAt?: number;
  responseCompletedAt?: number;
  finishedAt?: number;
  responseChars?: number;
  bodyParseFailure?: 'invalid_json' | 'body_read_failed' | 'invalid_payload';
  stopCause?: 'timeout' | 'aborted';
  providerErrorCode?: string;
  usage?: ChatCompletionUsage;
  usagePresent?: boolean;
};

function observeChatDiagnostic<Args extends unknown[]>(observer: ((...args: Args) => void) | undefined, ...args: Args) {
  try { void Promise.resolve(observer?.(...args)).catch(() => undefined); } catch { /* Observation only. */ }
}

export type ChatCompletionUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
};

function attachTransientFixedEnvelopeRawDirect(
  diagnostics: ChatReplyDiagnostics,
  protocol: BaiyunChatSemanticEnvelopeProtocol | undefined,
  rawDirect: string,
  proactiveLite = false,
) {
  if (protocol !== 'single_root_json' && !proactiveLite) return;
  Object.defineProperty(diagnostics, 'fixedEnvelopeRawDirect', {
    configurable: false,
    enumerable: false,
    value: rawDirect,
    writable: false,
  });
}

function classifyChatReplyRawContent(
  content: string,
): ChatReplyDiagnostics['rawContentFormat'] {
  const trimmed = content.trim();
  if (!trimmed) return 'empty';
  if (/^```(?:json)?\s*[\s\S]*\s*```$/iu.test(trimmed)) return 'fenced_content';
  if (
    /^<(?:state|internal)>\s*[\s\S]*?\s*<\/(?:state|internal)>(?:\s*[\s\S]*)?$/iu.test(trimmed)
  ) {
    return 'tagged_content';
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? 'json_object'
      : 'json_value';
  } catch {
    return 'non_json';
  }
}

function getOfficialDeepSeekPrefixCompletionUrl(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    if (url.hostname.toLowerCase() !== 'api.deepseek.com') return undefined;
    url.pathname = '/beta/chat/completions';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

export function restoreBaiyunSemanticPrefixCompletion(
  raw: string,
  protocol: BaiyunChatSemanticEnvelopeProtocol = 'legacy_tagged',
) {
  const trimmed = raw.trimStart();
  if (!trimmed) return trimmed;
  if (protocol === 'single_root_json') {
    if (trimmed.startsWith('{')) return trimmed;
    return `${BAIYUN_CHAT_SINGLE_ROOT_JSON_ASSISTANT_PREFIX}${trimmed}`;
  }
  if (trimmed.includes('<state>') || trimmed.includes('<internal>')) return trimmed;
  if (trimmed.includes('</state>')) {
    return `${BAIYUN_CHAT_SEMANTIC_ASSISTANT_PREFIX}${trimmed}`;
  }
  if (trimmed.includes('</internal>')) {
    return `<internal>\n{"semantic":{"signals":${trimmed}`;
  }
  return raw;
}

function isCompleteSingleRootJsonCandidate(raw: string) {
  const trimmed = raw
    .replace(/^\uFEFF/u, '')
    .replace(/[\u200B-\u200D\u2060]/gu, '')
    .trim();
  if (!trimmed || /^```/u.test(trimmed)) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function getSemanticEnvelopeForVisibleReply(reply: VisibleReplyExtractionResult) {
  if (reply.structureVariant === 'safe_direct_plain_text') {
    return JSON.stringify({ messages: reply.messages });
  }
  try {
    const parsed = JSON.parse(normalizeVisibleReplyRaw(reply.raw)) as unknown;
    if (Array.isArray(parsed)) return JSON.stringify({ messages: reply.messages });
  } catch {
    // Tagged envelopes keep their exact selected structure.
  }
  return reply.raw;
}

export type ChatCompletionWithToolsResult = {
  silent?: true;
  textualToolProtocol?: boolean;
  theaterBackstage?: import('./subjectiveMessages').TheaterBackstageMessageSource;
  assistantToolCallMessage?: OpenAiCompatibleAssistantToolCallMessage;
  assistantText: string;
  contents: string[];
  diagnostics: ChatReplyDiagnostics;
  finishReason?: string;
  rawToolCallCount: number;
  rawEnvelopeForSemanticParsing?: string;
  reasoningContent: string;
  toolInvocationErrors: JunLuoToolInvocationParseError[];
  toolInvocations: JunLuoToolInvocation[];
  usage?: ChatCompletionUsage;
};

export function mapContinuationMessages(
  messages: readonly OpenAiCompatibleContinuationMessage[],
): OpenAiCompatibleRequestMessage[] {
  return messages.map((message): OpenAiCompatibleRequestMessage => {
    if (message.kind === 'tool_result') {
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.callId,
      };
    }
    return {
      role: 'assistant',
      content: message.content,
      ...(message.reasoningContent !== undefined ? { reasoning_content: message.reasoningContent } : {}),
      tool_calls: message.toolCalls.map((call) => ({
        id: call.callId,
        type: call.type,
        function: {
          name: call.rawName,
          arguments: call.rawArguments,
        },
      })),
    };
  });
}

export function insertContinuationMessages(
  apiMessages: readonly ApiChatMessage[],
  continuationMessages: readonly OpenAiCompatibleContinuationMessage[],
) {
  if (!continuationMessages.length) return [...apiMessages] as OpenAiCompatibleRequestMessage[];
  const continuation = mapContinuationMessages(continuationMessages);
  const semanticTailIndex = apiMessages.findIndex(
    (message) => message.role === 'system'
      && (isBaiyunChatSemanticOutputTailProtocol(message.content)
        || message.content === BAIYUN_CHAT_FIXED_OUTPUT_PROTOCOL
        || message.content === BAIYUN_DESKTOP_REMINDER_DRAFT_OUTPUT_PROTOCOL
        || message.content === DESKTOP_REMINDER_DRAFT_CONTINUATION_INSTRUCTION
        || message.content === WISH_CHAT_FIXED_OUTPUT_PROTOCOL),
  );
  const insertionIndex = semanticTailIndex >= 0 ? semanticTailIndex : apiMessages.length;
  return [
    ...apiMessages.slice(0, insertionIndex),
    ...continuation,
    ...apiMessages.slice(insertionIndex),
  ];
}

export type AiRequestErrorKind =
  | 'authentication'
  | 'timeout'
  | 'network'
  | 'provider_http'
  | 'empty_response';

export class AiRequestError extends Error {
  readonly bodyParseFailure?: ChatTransportAttemptEvent['bodyParseFailure'];
  readonly providerErrorCode?: string;
  readonly stopCause?: ChatTransportAttemptEvent['stopCause'];
  readonly httpStatus?: number;
  readonly kind: AiRequestErrorKind;
  readonly retryable: boolean;

  constructor(
    message: string,
    kind: AiRequestErrorKind,
    options: { httpStatus?: number; retryable?: boolean;
      bodyParseFailure?: ChatTransportAttemptEvent['bodyParseFailure']; providerErrorCode?: string;
      stopCause?: ChatTransportAttemptEvent['stopCause'] } = {},
  ) {
    super(message);
    this.name = 'AiRequestError';
    this.kind = kind;
    this.httpStatus = options.httpStatus;
    this.bodyParseFailure = options.bodyParseFailure;
    this.providerErrorCode = options.providerErrorCode;
    this.stopCause = options.stopCause;
    this.retryable = options.retryable ?? kind !== 'authentication';
  }
}

export async function testOpenAiCompatibleConnection({ apiKey, connection }: TestOptions): Promise<ConnectionResult> {
  const baseUrl = connection.baseUrl.trim().replace(/\/+$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONNECTION_TEST_TIMEOUT_MS);
  let cacheMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;

  try {
    const body = JSON.stringify({
      model: connection.model.trim(),
      ...(shouldDisableThinkingForSiliconFlowQwen35(connection) ? { enable_thinking: false } : {}),
      messages: [{ role: 'user', content: '请只回复：连接成功' }],
      ...buildChatModelParameterPayload(connection.modelParameters),
      max_tokens: 16,
    });
    cacheMetric = beginPromptCacheMetric({ connection, contextProfile: 'connection-test', contextSource: 'connection.test' });
    const response = await fetch(`${baseUrl}/chat/completions`, {
      body,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: controller.signal,
    });

    let payload: ChatCompletionResponse = {};
    try {
      payload = (await response.json()) as ChatCompletionResponse;
    } catch {
      // Some compatible services do not return a JSON body for failed requests.
    }
    cacheMetric.recordUsage(payload?.usage);

    if (response.ok) {
      return { ok: true, detail: '连接成功，模型服务可以访问。' };
    }

    if (response.status === 401 || response.status === 403) {
      return { ok: false, detail: '连接失败，请检查 API Key 是否正确。' };
    }

    return {
      ok: false,
      detail: payload.error?.message || `服务返回错误状态 ${response.status}，请检查 Base URL 或模型参数。`,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, detail: '连接超时，请检查网络或服务地址。' };
    }

    return { ok: false, detail: '无法访问服务，请检查网络与 Base URL。' };
  } finally {
    void cacheMetric?.finish();
    clearTimeout(timeoutId);
  }
}

export class TheaterCapacityError extends Error {
  readonly code = 'theater_capacity';
  constructor(readonly stage: 'preflight' | 'provider') {
    super(`theater-capacity-${stage}`);
    this.name = 'TheaterCapacityError';
  }
}

export async function sendTheaterCompletion({
  anchorBlock,
  apiKey,
  connection,
  messages,
  names,
  openingPrompt,
  persona,
  signal,
  storyState,
  temperature,
}: TheaterCompletionOptions) {
  const theaterMessages = messages
    .filter((message) => (message.role === 'I' || message.role === 'you') && message.content.trim().length > 0)
    .map((message) => ({
      content: message.content,
      role: message.role === 'I' ? 'assistant' : 'user',
    }));
  if (openingPrompt !== undefined && theaterMessages.length) throw new Error('theater-opening-requires-empty-branch');
  const apiMessages = [
    { role: 'system', content: buildTheaterSystemPrompt({ persona, storyState, names, openingPrompt, anchorBlock }) },
    ...theaterMessages,
  ];
  if (estimateApiMessagesTokens(apiMessages) + getReplyTokenReserve(connection) + 512
    > (connection.contextWindowTokens ?? 65536)) throw new TheaterCapacityError('preflight');
  const requestSignal = createChatRequestSignal(signal, 60000);
  let cacheMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;

  try {
    if (requestSignal.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const body = JSON.stringify({
      model: connection.model.trim(), messages: apiMessages,
      ...buildChatModelParameterPayload(connection.modelParameters),
      temperature: Math.max(0, Math.min(2, temperature ?? 0.8)),
    });
    cacheMetric = beginPromptCacheMetric({ connection, contextProfile: 'theater', contextSource: 'theater.reply' });
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      body,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: requestSignal.signal,
    });
    const payload = await readJsonPayload(response);
    cacheMetric.recordUsage(payload?.usage);
    if (requestSignal.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AiRequestError('小剧场模型 API Key 无效或没有调用权限，请回到设置检查连接。', 'authentication', { httpStatus: response.status });
      }
      const capacityDetail = `${payload.error?.code ?? ''} ${payload.error?.message ?? ''}`;
      if ((response.status === 400 || response.status === 413 || response.status === 422)
        && /context[_ -]length[_ -]exceeded|maximum context length|context window.*exceed|too many tokens|token limit.*exceed/i.test(capacityDetail)) {
        throw new TheaterCapacityError('provider');
      }
      throw new AiRequestError(payload.error?.message || `小剧场模型返回错误状态 ${response.status}。`, 'provider_http', { httpStatus: response.status });
    }

    const finishReason = payload.choices?.[0]?.finish_reason;
    if (finishReason && finishReason !== 'stop' && finishReason !== 'end_turn') {
      throw new AiRequestError('小剧场这次没有返回文字，请稍后再试。', 'empty_response');
    }
    const rawContent = payload.choices?.[0]?.message?.content;
    const content = (typeof rawContent === 'string' ? rawContent : Array.isArray(rawContent)
      ? rawContent.filter((part) => !part.type || part.type === 'text' || part.type === 'output_text')
        .map((part) => part.text ?? '').join('') : '').trim();
    if (!content || /^<(?:think|analysis)>/i.test(content)) throw new AiRequestError('小剧场这次没有返回文字，请稍后再试。', 'empty_response');
    return content;
  } catch (error) {
    if (error instanceof TheaterCapacityError || error instanceof AiRequestError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      if (signal?.aborted) throw error;
      throw new AiRequestError('小剧场连接超时，请检查网络或服务地址。', 'timeout');
    }
    if (error instanceof Error && error.message) throw new AiRequestError(`小剧场无法访问：${error.message}`, 'network');
    throw new AiRequestError('小剧场无法访问，请检查网络与 Base URL。', 'network');
  } finally {
    void cacheMetric?.finish();
    requestSignal.cleanup();
  }
}

type TheaterSummaryPreflightOptions = Pick<TheaterStoryStateOptions,
  'connection' | 'messages' | 'persona' | 'names' | 'previousStoryState' | 'anchorBlock'>;

function buildTheaterSummaryApiMessages(options: TheaterSummaryPreflightOptions) {
  const apiMessages = [
    { role: 'system', content: buildTheaterStoryStateSystemPrompt(options) },
    ...options.messages
      .filter(message => (message.role === 'I' || message.role === 'you') && message.content.trim())
      .map(message => ({ role: message.role === 'I' ? 'assistant' : 'user', content: message.content })),
    { role: 'system', content: THEATER_STORY_STATE_TASK_PROMPT },
  ];
  if (estimateApiMessagesTokens(apiMessages) + getReplyTokenReserve(options.connection) + 512
    > (options.connection.contextWindowTokens ?? 65536)) throw new TheaterCapacityError('preflight');
  return apiMessages;
}

/** No network or mutation: run before asking to discard an unsaved editor. */
export function preflightTheaterSummary(options: TheaterSummaryPreflightOptions): void {
  buildTheaterSummaryApiMessages(options);
}

export async function generateTheaterStoryState({
  anchorBlock,
  apiKey,
  connection,
  messages,
  names,
  persona,
  previousStoryState,
  signal,
}: TheaterStoryStateOptions) {
  const apiMessages = buildTheaterSummaryApiMessages({ connection, messages, names, persona, previousStoryState, anchorBlock });
  const requestSignal = createChatRequestSignal(signal, 60000);
  let cacheMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;

  try {
    if (requestSignal.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const body = JSON.stringify({
      model: connection.model.trim(), messages: apiMessages,
      ...buildChatModelParameterPayload(connection.modelParameters), temperature: 0.2,
    });
    cacheMetric = beginPromptCacheMetric({ connection, contextProfile: 'theater', contextSource: 'theater.summary' });
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      body,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: requestSignal.signal,
    });
    const payload = await readJsonPayload(response);
    cacheMetric.recordUsage(payload?.usage);
    if (requestSignal.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AiRequestError('小剧场整理模型 API Key 无效或没有调用权限，请回到设置检查连接。', 'authentication', { httpStatus: response.status });
      }
      const capacityDetail = `${payload.error?.code ?? ''} ${payload.error?.message ?? ''}`;
      if ((response.status === 400 || response.status === 413 || response.status === 422)
        && /context[_ -]length[_ -]exceeded|maximum context length|context window.*exceed|too many tokens|token limit.*exceed/i.test(capacityDetail)) {
        throw new TheaterCapacityError('provider');
      }
      throw new AiRequestError(payload.error?.message || `小剧场整理模型返回错误状态 ${response.status}。`, 'provider_http', { httpStatus: response.status });
    }
    const finishReason = payload.choices?.[0]?.finish_reason;
    if (finishReason && finishReason !== 'stop' && finishReason !== 'end_turn') {
      throw new AiRequestError('小剧场整理这次没有返回文字，请稍后再试。', 'empty_response');
    }
    const rawContent = payload.choices?.[0]?.message?.content;
    const content = (typeof rawContent === 'string' ? rawContent : Array.isArray(rawContent)
      ? rawContent.filter(part => !part.type || part.type === 'text' || part.type === 'output_text')
        .map(part => part.text ?? '').join('') : '').trim();
    if (!content || /^<(?:think|analysis)>/i.test(content)) {
      throw new AiRequestError('小剧场整理这次没有返回文字，请稍后再试。', 'empty_response');
    }
    return content;
  } catch (error) {
    if (error instanceof TheaterCapacityError || error instanceof AiRequestError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      if (signal?.aborted) throw error;
      throw new AiRequestError('小剧场整理连接超时，请检查网络或服务地址。', 'timeout');
    }
    if (error instanceof Error && error.message) throw new AiRequestError(`小剧场整理无法访问：${error.message}`, 'network');
    throw new AiRequestError('小剧场整理无法访问，请检查网络与 Base URL。', 'network');
  } finally {
    void cacheMetric?.finish();
    requestSignal.cleanup();
  }
}

function readAssistantContentRaw(payload: ChatCompletionResponse) {
  const content = payload.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part) => part.text ?? '').join('');
  }

  return '';
}

function readAssistantContent(payload: ChatCompletionResponse) {
  return readAssistantContentRaw(payload).trim();
}

function buildAssistantToolCallMessage(
  message: ChatCompletionResponseMessage | undefined,
  content: string,
  reasoningContent: string | undefined,
): OpenAiCompatibleAssistantToolCallMessage | undefined {
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  if (!toolCalls.length) return undefined;
  const seenCallIds = new Set<string>();
  const calls: OpenAiCompatibleAssistantToolCallMessage['toolCalls'] = [];
  for (const toolCall of toolCalls) {
    const callId = toolCall.id;
    const rawName = toolCall.function?.name;
    const rawArguments = toolCall.function?.arguments;
    if (
      typeof callId !== 'string'
      || !callId.trim()
      || seenCallIds.has(callId)
      || (toolCall.type !== undefined && toolCall.type !== 'function')
      || typeof rawName !== 'string'
      || !rawName.trim()
      || typeof rawArguments !== 'string'
    ) {
      return undefined;
    }
    seenCallIds.add(callId);
    calls.push({
      callId,
      type: 'function',
      rawName,
      rawArguments,
    });
  }
  return {
    subject: 'I',
    kind: 'tool_request',
    content,
    ...(reasoningContent !== undefined ? { reasoningContent } : {}),
    toolCalls: calls,
  };
}

function normalizeCompletionUsage(
  usage: ChatCompletionResponse['usage'],
): ChatCompletionUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cachedPromptTokens: usage.prompt_cache_hit_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.cached_tokens
      ?? usage.cached_input_tokens,
  };
}

async function readJsonPayload(
  response: { json: () => Promise<unknown> },
  onFailure?: (reason: NonNullable<ChatTransportAttemptEvent['bodyParseFailure']>, error?: unknown) => void,
) {
  try {
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      observeChatDiagnostic(onFailure, 'invalid_payload');
    }
    return payload as ChatCompletionResponse;
  } catch (error) {
    observeChatDiagnostic(onFailure, error instanceof SyntaxError ? 'invalid_json' : 'body_read_failed', error);
    return {};
  }
}

function createChatRequestSignal(externalSignal?: AbortSignal, timeoutMs = CHAT_COMPLETION_TIMEOUT_MS) {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromExternalSignal = () => controller.abort();

  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternalSignal);
  }

  const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });
  const throwIfAborted = () => {
    // Native completion or synchronous parsing can run before an already due JS timer.
    if (Date.now() >= deadline) controller.abort();
    if (controller.signal.aborted) throw abortError();
  };
  const readUntilAborted = async <T,>(read: () => Promise<T>): Promise<T> => {
    throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(abortError());
      controller.signal.addEventListener('abort', abort);
    });
    try {
      const value = await Promise.race([read(), cancelled]);
      throwIfAborted();
      return value;
    } finally {
      controller.signal.removeEventListener('abort', abort);
    }
  };

  return {
    signal: controller.signal,
    readUntilAborted,
    clearTimeout: () => {
      clearTimeout(timeoutId);
    },
    cleanup: () => {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', abortFromExternalSignal);
    },
  };
}

function fingerprintText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isOfficialQwen35FlashDraftConnection(connection: AiConnection): boolean {
  if (connection.model.trim() !== 'qwen3.5-flash') return false;
  try {
    const url = new URL(connection.baseUrl.trim());
    return url.protocol === 'https:' && (url.hostname === 'dashscope.aliyuncs.com'
      || url.hostname === 'dashscope-intl.aliyuncs.com'
      || /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com$/.test(url.hostname));
  } catch { return false; }
}

function isOfficialQwenPlus20250428DraftConnection(connection: AiConnection): boolean {
  if (connection.model.trim() !== 'qwen-plus-2025-04-28') return false;
  try {
    const url = new URL(connection.baseUrl.trim());
    return url.protocol === 'https:' && (url.hostname === 'dashscope.aliyuncs.com'
      || url.hostname === 'dashscope-intl.aliyuncs.com'
      || /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com$/.test(url.hostname));
  } catch { return false; }
}

function usesStableOrdinaryChatOrder(connection: AiConnection, contextSource: string | undefined, layout?: QwenChatLayoutMode) {
  return (contextSource ?? 'chat.main') === 'chat.main' && layout === 'ordinary'
    && !isSiliconQwenChatConnection(connection) && !isLocalQwenChatConnection(connection);
}

function getDesktopReminderReceiptInputBudget(options: ChatCompletionPromptEnvelopeOptions) {
  if (Platform.OS !== 'windows' || !options.desktopReminderSaveFeedback
    || (options.contextSource ?? 'chat.main') !== 'chat.main'
    || options.responseEnvelopeMode !== 'messages_with_semantic' || options.semanticEnvelopeProtocol !== 'single_root_json'
    || options.toolAgentProtocolMode || !options.desktopReminderSaveFeedbackInstruction?.trim()
    || !usesStableOrdinaryChatOrder(options.connection, options.contextSource, options.qwenChatLayout)
    || !isOfficialQwenMaxConnection(options.connection)) return undefined;
  return Math.min(30720, Math.min(options.connection.contextWindowTokens ?? 65536, 32768)
    - getReplyTokenReserve(options.connection) - 512);
}

const BAIYUN_CHAT_SEMANTIC_BUBBLE_PROTOCOL = `${BAIYUN_CHAT_SEMANTIC_GUIDANCE_PROTOCOL}

【多气泡输出】
messages 按自然停顿拆分；句子、引号和颜文字保持完整，所有气泡共同组成一次回复。`;


export async function buildChatCompletionPromptEnvelope(options: ChatCompletionPromptEnvelopeOptions): Promise<ChatCompletionPromptEnvelope> {
  const {
  ambientContext,
  connection,
  conversationSummary,
  desireInstructionOverride,
  memoryContext,
  messages,
  preambleMessages,
  sleepScheduleMessages,
  musicPlaybackEvents,
  musicRequestOverheadTokens = 0,
  preparedCompiledPrompt,
  readOnlyPreparation,
  preparedAmbientContext,
  profile,
  responseInstruction,
  responseEnvelopeMode = 'messages_only',
  fixedEnvelopeMode,
  desktopReminderDraftContinuation,
  semanticEnvelopeProtocol = 'legacy_tagged',
  semanticOutputModules,
  toolAgentProtocolMode = false,
  desktopReminderSaveFeedback,
  desktopReminderSaveFeedbackInstruction,
  contextSource = 'chat.main',
  qwenChatLayout,
  } = options;
  const baseUrl = connection.baseUrl.trim().replace(/\/+$/, '');
  const conversationText = messages
    .filter((message) => message.role === 'you')
    .slice(-4)
    .map((message) => message.content)
    .join('\n');
  const resolvedContextSource: PromptContextSource = isPromptContextSource(contextSource)
    ? contextSource
    : 'chat.main';
  const [baseAmbientContext, missedCallContext] = preparedAmbientContext !== undefined ? [preparedAmbientContext, ''] : await Promise.all([
    ambientContext !== undefined ? Promise.resolve(ambientContext) : buildAmbientContext().catch(() => ''),
    resolvedContextSource === 'chat.main'
      ? buildRecentMissedVoiceCallContext().catch(() => '')
      : Promise.resolve(''),
  ]);
  const runtimeAmbientContext = [baseAmbientContext, missedCallContext].filter(Boolean).join('\n\n');
  const contextProfile = getPromptContextProfileForSource(resolvedContextSource);
  const outputAudience = getPromptOutputAudienceForSource(resolvedContextSource);
  const independentContact = resolvedContextSource === 'proactive.ordinary';
  const useQwenLayout = (qwenChatLayout === 'ordinary' || qwenChatLayout === 'important_raw' && independentContact)
    && isSiliconQwenChatConnection(connection);
  if (fixedEnvelopeMode === 'desktop-reminder-draft' && (useQwenLayout || isLocalQwenChatConnection(connection))) {
    throw new Error('REMINDER_DRAFT_LAYOUT_UNSUPPORTED');
  }
  const desireInstruction = typeof desireInstructionOverride === 'string'
    ? desireInstructionOverride
    : '';
  const preparedPrompt = preparedCompiledPrompt ?? await buildCompiledSystemPromptResult({
    readOnly: readOnlyPreparation,
    conversationText,
    contextProfile,
    memoryContext,
    moduleInstruction: [
      desireInstruction,
      responseInstruction?.trim() ?? '',
    ].filter(Boolean).join('\n\n') || undefined,
    outputAudience,
    profile,
  });
  const formatMusic = musicPlaybackEvents?.length
    ? (await import('../music/musicPlaybackMaterial')).formatMusicPlaybackMaterial : undefined;
  const originalMessages = messages;
  const originalConversationSummary = conversationSummary;
  const originalResponseInstruction = responseInstruction;
  const assembleUnfitted = (materials: { memoryContext?: string; conversationSummary?: string; messages?: SubjectiveMessage[]; responseInstruction?: string } = {}): ChatCompletionPromptEnvelope => {
  const conversationSummary = materials.conversationSummary === undefined ? originalConversationSummary : materials.conversationSummary;
  const messages = materials.messages ?? originalMessages;
  const responseInstruction = materials.responseInstruction === undefined ? originalResponseInstruction : materials.responseInstruction;
  const refreshedPrompt = materials.responseInstruction === undefined ? preparedPrompt : replaceCompiledModuleInstruction(preparedPrompt,
    [desireInstruction, originalResponseInstruction?.trim() ?? ''].filter(Boolean).join('\n\n'),
    [desireInstruction, responseInstruction?.trim() ?? ''].filter(Boolean).join('\n\n'));
  const compiledPrompt = materials.memoryContext === undefined ? refreshedPrompt
    : replaceCompiledMemoryContext(refreshedPrompt, materials.memoryContext);
  const fixedEnvelopeRequested = responseEnvelopeMode === 'messages_with_semantic'
    && semanticEnvelopeProtocol === 'single_root_json';
  const legacyEnvelopeRequested = responseEnvelopeMode === 'messages_with_semantic'
    && semanticEnvelopeProtocol === 'legacy_tagged';
  const fixedOutputProtocol = fixedEnvelopeMode === 'wish'
    ? WISH_CHAT_FIXED_OUTPUT_PROTOCOL : fixedEnvelopeMode === 'desktop-reminder-draft'
      ? BAIYUN_DESKTOP_REMINDER_DRAFT_OUTPUT_PROTOCOL : BAIYUN_CHAT_FIXED_OUTPUT_PROTOCOL;
  const desktopReminderReceipt = Platform.OS === 'windows' && desktopReminderSaveFeedback
    && resolvedContextSource === 'chat.main' && fixedEnvelopeRequested && !toolAgentProtocolMode
    && usesStableOrdinaryChatOrder(connection, contextSource, qwenChatLayout)
    && desktopReminderSaveFeedbackInstruction?.trim() ? desktopReminderSaveFeedbackInstruction : undefined;
  const stableSystemPrompt = [
    compiledPrompt.stablePrompt,
    !useQwenLayout && fixedEnvelopeRequested && !toolAgentProtocolMode && !desktopReminderReceipt ? fixedOutputProtocol : '',
    !useQwenLayout && legacyEnvelopeRequested ? SUBJECTIVE_OUTPUT_PROTOCOL : '',
    !useQwenLayout && legacyEnvelopeRequested ? BAIYUN_CHAT_SEMANTIC_BUBBLE_PROTOCOL : '',
  ].filter(Boolean).join('\n\n');
  const moduleTask = [desireInstruction, responseInstruction?.trim() ?? ''].filter(Boolean).join('\n\n');
  const dynamicWithoutTask = useQwenLayout && !independentContact && moduleTask
    && compiledPrompt.sections.scenario.endsWith(moduleTask)
    ? replaceCompiledModuleInstruction(compiledPrompt, moduleTask, '').dynamicPrompt : compiledPrompt.dynamicPrompt;
  // Current sleep/schedule facts keep their original system identity and text.
  // Place them after the real you message, so they do not split reusable history.
  const deferredPreamble = usesStableOrdinaryChatOrder(connection, contextSource, qwenChatLayout)
    && messages.some(message => message.role === 'you' && message.source !== 'voice-call')
    && sleepScheduleMessages?.every(message => message.role === 'system') ? sleepScheduleMessages : undefined;
  const retainedPreamble = [...(deferredPreamble ? [] : sleepScheduleMessages ?? []), ...(preambleMessages ?? [])];
  const apiMessages: ApiChatMessage[] = independentContact ? [
    { role: 'system', content: [SUBJECTIVE_IDENTITY_PROTOCOL, stableSystemPrompt].join('\n\n') },
    ...retainedPreamble,
    ...(responseInstruction?.trim() ? [{ role: 'system' as const, content: responseInstruction.trim() }] : []),
  ] : buildApiMessages(
    stableSystemPrompt,
    messages,
    runtimeAmbientContext,
    conversationSummary,
    dynamicWithoutTask,
    retainedPreamble,
    isLocalQwenChatConnection(connection),
    resolvedContextSource === 'letter.delivery' || resolvedContextSource === 'letter.reply' ? 'letter' : 'chat',
  );
  if (Platform.OS === 'windows' && resolvedContextSource === 'chat.main' && (toolAgentProtocolMode || desktopReminderReceipt)) {
    // Tool-only cards are action records, without spoken text; retain their stored cards and numbering.
    const emptyToolCardHistory = new Set(messages.filter(message => message.role === 'I'
      && ((message.toolCallCards?.length ?? 0) > 0 || !!desktopReminderReceipt && !!message.reminderPlanCard)
      && !message.voice && !message.images?.length
      && /^消息序号 \d+｜发送时间 [^\n]+\n\s*$/.test(message.content)
      && buildApiMessageContent(message) === message.content).map(message => message.content));
    for (let index = apiMessages.length - 1; index >= 0; index--) {
      const message = apiMessages[index];
      if (message.role === 'assistant' && emptyToolCardHistory.has(message.content)) apiMessages.splice(index, 1);
    }
  }
  if (deferredPreamble?.length) {
    apiMessages.splice(apiMessages.findLastIndex(message => message.role === 'user') + 1, 0, ...deferredPreamble);
  }
  if (desktopReminderReceipt) apiMessages.push({ role: 'system', content: desktopReminderReceipt });
  if (fixedEnvelopeMode === 'desktop-reminder-draft' && desktopReminderDraftContinuation) {
    apiMessages.push({ role: 'system', content: DESKTOP_REMINDER_DRAFT_CONTINUATION_INSTRUCTION });
  }
  if (fixedEnvelopeRequested && (toolAgentProtocolMode || desktopReminderReceipt)) {
    apiMessages.push({ role: 'system', content: fixedOutputProtocol });
  }
  if (legacyEnvelopeRequested) {
    const semanticOutputTail = getBaiyunChatSemanticOutputTailProtocol(
      semanticEnvelopeProtocol,
      semanticOutputModules,
    );
    apiMessages.push({
      role: 'system',
      content: semanticOutputTail,
    });
  }
  if (responseEnvelopeMode === 'messages_with_semantic' && getOfficialDeepSeekPrefixCompletionUrl(baseUrl)) {
    apiMessages.push({
      role: 'assistant',
      content: fixedEnvelopeRequested
        ? BAIYUN_CHAT_SINGLE_ROOT_JSON_ASSISTANT_PREFIX
        : BAIYUN_CHAT_SEMANTIC_ASSISTANT_PREFIX,
      prefix: true,
    });
  }
  const promptBreakdown: PromptTokenBreakdown = {
    persona: estimateTextTokens([
      SUBJECTIVE_IDENTITY_PROTOCOL,
      compiledPrompt.sections.persona,
      compiledPrompt.sections.personaState,
    ].filter(Boolean).join('\n')),
    userProfile: estimateTextTokens(compiledPrompt.sections.userProfile),
    scenario: estimateTextTokens(compiledPrompt.sections.scenario),
    expression: estimateTextTokens(compiledPrompt.sections.expression),
    memory: estimateTextTokens(compiledPrompt.sections.memory),
    environment: estimateTextTokens(runtimeAmbientContext),
    summary: estimateTextTokens(conversationSummary ?? ''),
    history: messages.reduce((total, message) => total + 4 + estimateTextTokens(message.content), 2),
  };
  if (musicPlaybackEvents?.length && formatMusic) {
    let selected = [...musicPlaybackEvents];
    while (selected.length) {
      const material = { role: 'system' as const, content: formatMusic(selected) };
      const withMusic = [apiMessages[0], material, ...apiMessages.slice(1)];
      if (estimateApiMessagesTokens(withMusic) + musicRequestOverheadTokens
        + getReplyTokenReserve(connection) + 512 <= (connection.contextWindowTokens ?? 65536)) {
        apiMessages.splice(1, 0, material);
        break;
      }
      selected = selected.slice(1);
    }
  }
  if (useQwenLayout) {
    const tailProtocols = [fixedEnvelopeRequested ? fixedOutputProtocol : '',
      legacyEnvelopeRequested ? SUBJECTIVE_OUTPUT_PROTOCOL : '',
      legacyEnvelopeRequested ? BAIYUN_CHAT_SEMANTIC_BUBBLE_PROTOCOL : '',
      legacyEnvelopeRequested ? getBaiyunChatSemanticOutputTailProtocol(semanticEnvelopeProtocol, semanticOutputModules) : ''].filter(Boolean);
    const systemParts = apiMessages.filter(message => message.role === 'system' && !tailProtocols.includes(message.content)).map(message => message.content);
    // Independent contact already supplies the task separately; remove by source identity, not guessed headings.
    if (independentContact && responseInstruction?.trim()) {
      const index = systemParts.indexOf(responseInstruction.trim());
      if (index >= 0) systemParts.splice(index, 1);
    }
    const arrange = (selected: SubjectiveMessage[]) => buildQwenChatLayout(systemParts, selected, [moduleTask, ...tailProtocols], independentContact, qwenChatLayout);
    // Reuse the original six-turn floor and complete-turn removal; never shorten an original message.
    const selected = independentContact ? messages : getRequestMessages(messages, undefined,
      (connection.contextWindowTokens ?? 65536) - musicRequestOverheadTokens - getReplyTokenReserve(connection) - 512,
      selected => estimateApiMessagesTokens(arrange(selected)));
    const arranged = arrange(selected);
    apiMessages.splice(0, apiMessages.length, ...arranged);
    promptBreakdown.history = estimateApiMessagesTokens(arranged.slice(1));
  }
  const estimatedPromptTokens = estimateApiMessagesTokens(apiMessages);
  const stablePrefixText = [SUBJECTIVE_IDENTITY_PROTOCOL, stableSystemPrompt].join('\n\n');
  const stablePrefixTokens = estimateTextTokens(stablePrefixText);
  const stablePrefixFingerprint = fingerprintText([baseUrl, connection.model.trim(), stablePrefixText].join('\n'));
  const estimatedCacheStats = {
    hitRate: null,
    hitTokens: null,
    missTokens: null,
    stablePrefixFingerprint,
    stablePrefixTokens,
  };

  return {
    reassembleMaterials: assemble,
    apiMessages,
    compiledPrompt,
    contextProfile,
    estimatedCacheStats,
    estimatedPromptTokens,
    promptBreakdown,
    runtimeAmbientContext,
    stablePrefixFingerprint,
    stablePrefixText,
    stablePrefixTokens,
    stableSystemPrompt,
  };
  };
  const inputBudget = getDesktopReminderReceiptInputBudget(options);
  const assemble: NonNullable<ChatCompletionPromptEnvelope['reassembleMaterials']> = (materials = {}) => {
    if (inputBudget === undefined) return assembleUnfitted(materials);
    const messages = materials.messages ?? originalMessages;
    const sourceIndex = messages.findIndex(message => message.role === 'you'
      && message.id === options.desktopReminderSaveFeedbackSourceId);
    if (sourceIndex < 0) throw new Error('UNIFIED_CONTACT_CONTEXT_TOO_LONG');
    const nextYou = messages.findIndex((message, index) => index > sourceIndex && message.role === 'you');
    const sourceTurn = messages.slice(sourceIndex, nextYou < 0 ? undefined : nextYou);
    const retainWholeSource = (selected: SubjectiveMessage[]) => {
      // The shared helper can stop just after the seventh you. Align only a new cut.
      if (selected.length < messages.length && selected[0]?.role === 'I') {
        const nextYou = selected.findIndex(message => message.role === 'you');
        if (nextYou >= 0) selected = selected.slice(nextYou);
      }
      return selected.some(message => message.id === options.desktopReminderSaveFeedbackSourceId)
        ? selected : [...sourceTurn, ...selected];
    };
    // Measure pure assembly, so each existing material refresh fits its own full input.
    const selected = retainWholeSource(getRequestMessages(messages, undefined, inputBudget,
      selected => assembleUnfitted({ ...materials, messages: retainWholeSource(selected) }).estimatedPromptTokens
        + musicRequestOverheadTokens));
    const fitted = assembleUnfitted({ ...materials, messages: selected });
    if (fitted.estimatedPromptTokens + musicRequestOverheadTokens > inputBudget) {
      throw new Error('UNIFIED_CONTACT_CONTEXT_TOO_LONG');
    }
    return fitted;
  };
  return assemble({});
}

async function requestChatCompletion(options: ChatOptions): Promise<ChatCompletionWithToolsResult> {
  observeChatDiagnostic(options.onPreparationCheckpoint, 'providerEnteredAt', Date.now());
  const {
  prepareBackstageRequest,
  ambientContext,
  apiKey,
  connection,
  conversationSummary,
  messages,
  memoryContext,
  onReplyDiagnostics,
  preambleMessages,
  sleepScheduleMessages,
  musicPlaybackEvents,
  profile,
  responseInstruction,
  responseEnvelopeMode,
  fixedEnvelopeMode,
  semanticEnvelopeProtocol = 'legacy_tagged',
  semanticOutputModules,
  semanticPrefixCompletionMode = 'auto',
  signal,
  toolAgentProtocolMode = false,
  allowPhoneEmergencySilence = false,
  wishPackageEntry = false,
  toolMode = 'none',
  toolChoice,
  strictTools = false,
  thinkingMode,
  reasoningEffort,
  prefixWithTools = false,
  tools = [],
  continuationMessages = [],
  includeToolPromptTokens = false,
  rejectOversizedRequest = false,
  beforeTransportRequest,
  onTransportAttempt,
  transportRequestKind,
  onPromptTokens,
  contextSource,
  qwenChatLayout,
  } = options;
  const devFixturePayload = buildVisibleReplyDevFixturePayload({
    messages,
    responseInstruction,
  });
  const baseUrl = connection.baseUrl.trim().replace(/\/+$/, '');
  const enforceCapacity = rejectOversizedRequest || ((qwenChatLayout === 'ordinary'
    || qwenChatLayout === 'important_raw' && contextSource === 'proactive.ordinary') && isSiliconQwenChatConnection(connection));
  const toolRequestEnabled = toolMode === 'openai-tools' && tools.length > 0;
  const semanticPrefixCompletionUrl = semanticPrefixCompletionMode === 'auto'
    && responseEnvelopeMode === 'messages_with_semantic'
    && (!toolRequestEnabled || prefixWithTools)
    ? getOfficialDeepSeekPrefixCompletionUrl(baseUrl)
    : undefined;
  const semanticPrefixCompletionRequested = Boolean(semanticPrefixCompletionUrl);
  const openAiTools = toolRequestEnabled
    ? (wishPackageEntry ? projectWishPackageTools(tools) : tools).map((tool) => {
      const converted = toolDefinitionToOpenAiTool(tool, { strict: strictTools });
      // Ollama 0.35.0 reserializes missing root properties as null, which its
      // schema parser rejects. These two built-ins do not read input parameters;
      // leave dynamic open-object schemas alone rather than constraining them.
      if (isLocalQwenChatConnection(connection) && converted.function.parameters.type === 'object'
        && converted.function.parameters.properties === undefined
        && (tool.id === 'system_status.get_battery' || tool.id === 'system_status.get_device_info')) {
        converted.function.parameters = { ...converted.function.parameters, properties: {} };
      }
      return converted;
    })
    : undefined;
  if (openAiTools && usesStableOrdinaryChatOrder(connection, contextSource, qwenChatLayout)) {
    // Sort only the already selected, converted definitions; never reorder candidates or execution.
    openAiTools.sort((left, right) => left.function.name < right.function.name ? -1
      : left.function.name > right.function.name ? 1 : 0);
  }
  // Include structured calls, reasoning and real receipts, not just visible text.
  const requestOverheadTokens = (openAiTools ? estimateTextTokens(JSON.stringify(openAiTools)) : 0)
    + (continuationMessages.length ? estimateTextTokens(JSON.stringify(mapContinuationMessages(continuationMessages))) : 0);
  const envelopeInput: ChatCompletionPromptEnvelopeOptions = {
    ambientContext,
    connection,
    conversationSummary,
    memoryContext,
    messages,
    preambleMessages,
    sleepScheduleMessages,
    profile,
    responseInstruction,
    responseEnvelopeMode,
    fixedEnvelopeMode,
    desktopReminderDraftContinuation: options.desktopReminderDraftContinuation,
    semanticEnvelopeProtocol,
    semanticOutputModules,
    toolAgentProtocolMode,
    desktopReminderSaveFeedback: options.desktopReminderSaveFeedback,
    desktopReminderSaveFeedbackInstruction: options.desktopReminderSaveFeedbackInstruction,
    desktopReminderSaveFeedbackSourceId: options.desktopReminderSaveFeedbackSourceId,
    contextSource,
    qwenChatLayout,
    musicPlaybackEvents,
    musicRequestOverheadTokens: requestOverheadTokens,
  };
  let envelope = await buildChatCompletionPromptEnvelope(envelopeInput);
  const backstage = await prepareBackstageRequest?.({
    ...envelopeInput, ambientContext: envelope.runtimeAmbientContext,
    preparedAmbientContext: envelope.runtimeAmbientContext,
    preparedCompiledPrompt: envelope.compiledPrompt,
    tools, toolMode, strictTools, continuationMessages, semanticPrefixCompletionMode, prefixWithTools, wishPackageEntry,
  });
  if (backstage) envelope = await buildChatCompletionPromptEnvelope({
    ...envelopeInput, ...backstage, ambientContext: envelope.runtimeAmbientContext,
    preparedAmbientContext: envelope.runtimeAmbientContext,
    preparedCompiledPrompt: backstage.preparedCompiledPrompt ?? envelope.compiledPrompt,
  });
  observeChatDiagnostic(options.onPreparationCheckpoint, 'envelopeReadyAt', Date.now());
  // Preserve the existing opportunity boundary: reject oversized/aborted preparations
  // before the caller marks its request. Refreshed material is checked again below.
  if (enforceCapacity && envelope.estimatedPromptTokens + requestOverheadTokens
    + getReplyTokenReserve(connection) + 512 > (connection.contextWindowTokens ?? 65536)) {
    throw new Error('UNIFIED_CONTACT_CONTEXT_TOO_LONG');
  }
  if (rejectOversizedRequest && signal?.aborted) throw new Error('UNIFIED_CONTACT_REQUEST_ABORTED');
  const cameraReplyJsonOutputRequested = options.cameraObservationReplyJson === true && isOfficialQwen27bConnection(connection);
  const desktopDraftCorrectionJsonOutputRequested = Platform.OS === 'windows'
    && contextSource === 'chat.main' && fixedEnvelopeMode === 'desktop-reminder-draft'
    && toolAgentProtocolMode && semanticEnvelopeProtocol === 'single_root_json'
    && (options.transportRequestKind === 'initial' || options.transportRequestKind === 'tool_continuation'
      || options.transportRequestKind === 'protocol_correction')
    && (isOfficialQwen35FlashDraftConnection(connection) || isOfficialQwenPlus20250428DraftConnection(connection));
  const modelParameterPayload = buildChatModelParameterPayload(connection.modelParameters);
  const serializeRequest = (currentEnvelope: ChatCompletionPromptEnvelope,
    results: readonly OpenAiCompatibleContinuationMessage[]) => {
    const requestMessages = insertContinuationMessages(currentEnvelope.apiMessages, results)
      .filter((message) => !(
        'prefix' in message && message.prefix
        && (semanticPrefixCompletionMode === 'disabled' || (toolRequestEnabled && !prefixWithTools))
      ));
    const receiptInputBudget = options.desktopReminderSaveFeedback ? getDesktopReminderReceiptInputBudget(options) : undefined;
    if (receiptInputBudget !== undefined && estimateApiMessagesTokens(requestMessages)
      + (results.length ? estimateTextTokens(JSON.stringify(mapContinuationMessages(results).map(message => {
        const { content, ...metadata } = message;
        return metadata;
      }))) : 0)
      + (openAiTools ? estimateTextTokens(JSON.stringify(openAiTools)) : 0) > receiptInputBudget) {
      throw new Error('UNIFIED_CONTACT_CONTEXT_TOO_LONG');
    }
    const transportToolChoice = options.desktopReminderDraftContinuation === true
      && Platform.OS === 'windows' && contextSource === 'chat.main' && fixedEnvelopeMode === 'desktop-reminder-draft'
      && toolAgentProtocolMode && toolRequestEnabled && toolChoice === 'required' && thinkingMode === 'disabled'
      && (isOfficialQwenMaxConnection(connection) || isOfficialQwen35FlashDraftConnection(connection))
      && tools.length === 1 && tools[0].id === 'reminder.propose_reminders'
      && openAiTools?.length === 1 && openAiTools[0].type === 'function' && openAiTools[0].function.name
      ? { type: 'function' as const, function: { name: openAiTools[0].function.name } }
      : toolChoice;
    return JSON.stringify({
      model: connection.model.trim(),
      messages: isLocalQwenChatConnection(connection) ? mergeLocalQwenSystemMessages(requestMessages) : requestMessages,
      ...(openAiTools ? {
        ...(transportToolChoice ? { tool_choice: transportToolChoice } : {}),
        tools: openAiTools,
      } : {}),
      // Ollama's OpenAI endpoint expects reasoning_effort, not thinking.type.
      ...(isLocalQwenChatConnection(connection) && thinkingMode === 'disabled' ? { reasoning_effort: 'none' }
        : toolAgentProtocolMode || (thinkingMode !== undefined && isOfficialQwen397bConnection(connection))
          ? buildToolProviderTransportParameters(connection, thinkingMode, reasoningEffort) : {
        ...(thinkingMode ? { thinking: { type: thinkingMode } } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
      ...modelParameterPayload,
      ...(cameraReplyJsonOutputRequested ? { enable_thinking: false, response_format: { type: 'json_object' } } : {}),
      ...(desktopDraftCorrectionJsonOutputRequested
        ? { enable_thinking: false, response_format: { type: 'json_object' } } : {}),
    });
  };
  // Validate serialization before committing the existing request budget. Only
  // the locally refreshed body below is transmitted when this entry uses memory.
  let body = serializeRequest(envelope, continuationMessages);
  const admitAfterMaterials = contextSource === 'proactive.ordinary'
    || (qwenChatLayout === 'ordinary' && isSiliconQwenChatConnection(connection));
  if (!admitAfterMaterials) await beforeTransportRequest?.();
  if (backstage?.isCurrent && !backstage.isCurrent()) {
    return requestChatCompletion({ ...options, beforeTransportRequest: admitAfterMaterials ? beforeTransportRequest : undefined });
  }
  let currentContinuationMessages = continuationMessages;
  let refreshedMaterials: { memoryContext?: string; conversationSummary?: string; messages?: SubjectiveMessage[]; responseInstruction?: string } = {};
  if (options.refreshMemoryMaterials) {
    const materials = await options.refreshMemoryMaterials({ continuationMessages });
    if (signal?.aborted) throw Object.assign(new Error('MEMORY_MATERIAL_PREPARATION_CANCELLED'), { name: 'AbortError' });
    envelope = envelope.reassembleMaterials!(materials);
    refreshedMaterials = materials;
    currentContinuationMessages = materials.continuationMessages ?? continuationMessages;
  }
  if (backstage?.isCurrent && !backstage.isCurrent()) {
    return requestChatCompletion({ ...options, beforeTransportRequest: admitAfterMaterials ? beforeTransportRequest : undefined });
  }
  let { apiMessages, contextProfile, estimatedCacheStats, estimatedPromptTokens,
    promptBreakdown, stablePrefixText } = envelope;
  observeChatDiagnostic(onPromptTokens, estimatedPromptTokens + (includeToolPromptTokens ? requestOverheadTokens : 0), 'estimate', promptBreakdown, estimatedCacheStats);
  const url = semanticPrefixCompletionUrl ?? `${baseUrl}/chat/completions`;
  const headers = {
    Authorization: `Bearer ${apiKey.trim()}`,
    'Content-Type': 'application/json',
  };
  if (enforceCapacity) {
    const currentRequestOverheadTokens = (openAiTools ? estimateTextTokens(JSON.stringify(openAiTools)) : 0)
      + (currentContinuationMessages.length ? estimateTextTokens(JSON.stringify(mapContinuationMessages(currentContinuationMessages))) : 0);
    if (estimatedPromptTokens + currentRequestOverheadTokens
      + getReplyTokenReserve(connection) + 512 > (connection.contextWindowTokens ?? 65536)) {
      throw new Error('UNIFIED_CONTACT_CONTEXT_TOO_LONG');
    }
  }
  if (rejectOversizedRequest && signal?.aborted) throw new Error('UNIFIED_CONTACT_REQUEST_ABORTED');
  if (options.refreshMemoryMaterials) body = serializeRequest(envelope, currentContinuationMessages);
  // Only automatic contact admission moves past local preparation. Other callers
  // keep their existing preflight -> current-memory refresh order.
  if (admitAfterMaterials) await beforeTransportRequest?.();
  if (backstage?.isCurrent && !backstage.isCurrent()) {
    // Preserve the ordinary-chat handoff: this already admitted request drops a
    // dismissed backstage card without buying a second permit.
    return requestChatCompletion({ ...options, beforeTransportRequest: undefined });
  }
  const transportObservation: Partial<ChatTransportAttemptEvent> = {};
  if (options.beforeChatImageTransport) {
    const transmitted = JSON.parse(body) as { messages: ApiChatMessage[] };
    await options.beforeChatImageTransport(transmitted.messages.filter(message => message.role === 'system')
      .map(message => typeof message.content === 'string' ? message.content : ''));
    if (signal?.aborted) throw Object.assign(new Error('CHAT_IMAGE_REQUEST_CANCELLED'), { name: 'AbortError' });
  }
  if (options.refreshConversationSummary) {
    const conversationSummary = await options.refreshConversationSummary();
    if (signal?.aborted) throw Object.assign(new Error('CHAT_SUMMARY_REQUEST_CANCELLED'), { name: 'AbortError' });
    envelope = envelope.reassembleMaterials!({ ...refreshedMaterials, conversationSummary });
    ({ apiMessages, contextProfile, estimatedCacheStats, estimatedPromptTokens, promptBreakdown, stablePrefixText } = envelope);
    body = serializeRequest(envelope, currentContinuationMessages);
    if (enforceCapacity && estimatedPromptTokens
      + (openAiTools ? estimateTextTokens(JSON.stringify(openAiTools)) : 0)
      + (currentContinuationMessages.length ? estimateTextTokens(JSON.stringify(mapContinuationMessages(currentContinuationMessages))) : 0)
      + getReplyTokenReserve(connection) + 512 > (connection.contextWindowTokens ?? 65536)) {
      throw new Error('UNIFIED_CONTACT_CONTEXT_TOO_LONG');
    }
    observeChatDiagnostic(onPromptTokens, estimatedPromptTokens + (includeToolPromptTokens ? requestOverheadTokens : 0),
      'estimate', promptBreakdown, estimatedCacheStats);
  }
  body = applyConnectionPromptCacheToRequestBody(body, connection.promptCacheMode);
  observeChatDiagnostic(options.onPreparationCheckpoint, 'preflightReadyAt', Date.now());
  const notifyTransport = (event: Partial<ChatTransportAttemptEvent> & Pick<ChatTransportAttemptEvent, 'phase'>) =>
    observeChatDiagnostic(onTransportAttempt, {
      ...transportObservation, ...event, requestKind: transportRequestKind,
      externalAborted: signal?.aborted === true,
      responseEnvelopeMode: responseEnvelopeMode ?? 'messages_only',
    });
  let transportStarted = false;
  let capturedRequest: ReturnType<typeof beginProactiveRequestCapture>;
  let capturedTraceId: string | undefined;
  let requestMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  const metricContextSource = contextSource && isPromptContextSource(contextSource) ? contextSource : 'chat.main';
  const beginRequestMetric = () => {
    requestMetric ??= beginPromptCacheMetric({
      connection: { id: connection.id, model: connection.model.trim(), baseUrl: connection.baseUrl },
      requestKind: transportRequestKind,
      contextProfile, contextSource: options.metricContextSource ?? metricContextSource, stablePrefixText, breakdown: promptBreakdown,
    });
  };
  const beginTransportEvidence = () => {
    beginRequestMetric();
    try { requestMetric?.observeSerializedRequest?.(body); } catch { /* Optional observation cannot affect transport. */ }
    if (isLocalQwenChatConnection(connection)
      || (contextSource === 'chat.main' && transportRequestKind === 'tool_continuation' && isOfficialQwen27bConnection(connection))
      || (contextSource === 'proactive.ordinary' && isSiliconQwenChatConnection(connection))) {
      try {
        capturedRequest = beginProactiveRequestCapture(body, qwenChatLayout ?? 'none', transportRequestKind ?? 'unknown');
      } catch { /* Optional capture cannot affect transport. */ }
    }
  };
  const startFetchCompletion = async () => {
    const requestSignal = createChatRequestSignal(signal);
    try {
      transportStarted = true;
      transportObservation.providerHost = readChatProviderHost(url);
      transportObservation.startedAt = Date.now();
      transportObservation.offeredToolCount = openAiTools?.length ?? 0;
      transportObservation.toolCapabilitySource = options.toolCapabilitySource;
      transportObservation.timeoutMs = CHAT_COMPLETION_TIMEOUT_MS;
      const nativeProgressAvailable = Boolean(onTransportAttempt)
        && (contextSource === undefined || contextSource === 'chat.main' || contextSource === 'chat.quality-retry')
        && typeof navigator !== 'undefined' && navigator.product === 'ReactNative'
        && typeof XMLHttpRequest !== 'undefined';
      transportObservation.transportKind = nativeProgressAvailable ? 'xhr' : 'fetch';
      notifyTransport({ phase: 'started' });
      const response = await requestSignal.readUntilAborted(async () => {
        const received = nativeProgressAvailable
          ? await requestObservedChatCompletion({
            url, body, headers, signal: requestSignal.signal,
            onSend: beginTransportEvidence,
            onProgress: (observation) => {
              Object.assign(transportObservation, observation);
              if (transportObservation.providerRequestId === apiKey.trim()) transportObservation.providerRequestId = undefined;
              notifyTransport({ phase: 'progress' });
            },
          })
          : await (() => {
            if (!requestSignal.signal.aborted) {
              beginTransportEvidence();
            }
            return fetch(url, { body, headers, method: 'POST', signal: requestSignal.signal });
          })();
        // A transport which ignores cancellation can settle after the caller has finished.
        if (requestSignal.signal.aborted) return received;
        // fetch may resolve only after receipt on native platforms: do not call this a headers timestamp.
        transportObservation.httpStatus = received.status;
        transportObservation.responseAvailableAt = Date.now();
        try {
          const responseHeaders = (received as { headers?: { get: (name: string) => string | null } }).headers;
          for (const name of ['x-request-id', 'x-dashscope-request-id', 'request-id']) {
            const id = normalizeChatProviderRequestId(responseHeaders?.get(name));
            if (id && id !== apiKey.trim()) { transportObservation.providerRequestId = id; break; }
          }
        } catch { /* Optional response metadata never changes the request. */ }
        notifyTransport({ phase: 'progress' });
        if (capturedRequest) {
          try {
            capturedTraceId = (received as { headers?: { get: (name: string) => string | null } })
              .headers?.get('x-siliconcloud-trace-id') ?? undefined;
          } catch { /* A diagnostic header is optional. */ }
        }
        return received;
      });
      return { requestSignal, response };
    } catch (error) {
      Object.assign(transportObservation, getChatTransportErrorDetails(error));
      if (requestSignal.signal.aborted) transportObservation.stopCause = signal?.aborted ? 'aborted' : 'timeout';
      requestSignal.cleanup();
      throw error;
    }
  };
  const requestNonStreamingCompletion = async () => {
    const { requestSignal, response } = await startFetchCompletion();
    try {
      transportObservation.bodyReadStartedAt = Date.now();
      notifyTransport({ phase: 'progress' });
      const nextPayload = await requestSignal.readUntilAborted(() => readJsonPayload(response, (reason, error) => {
        transportObservation.bodyParseFailure = reason;
        Object.assign(transportObservation, getChatTransportErrorDetails(error));
        if (reason === 'body_read_failed' && requestSignal.signal.aborted) {
          transportObservation.stopCause = signal?.aborted ? 'aborted' : 'timeout';
        }
      }));
      if (transportObservation.bodyParseFailure !== 'body_read_failed') {
        transportObservation.responseCompletedAt ??= Date.now();
      }
      if (capturedRequest) {
        try {
          finishProactiveRequestCapture(capturedRequest, {
            httpStatus: response.status, traceId: capturedTraceId,
            outcome: requestSignal.signal.aborted ? (signal?.aborted ? 'aborted' : 'timeout')
              : response.ok ? 'response_received' : 'http_error',
            bodyParseFailure: transportObservation.bodyParseFailure,
            responseJson: transportObservation.bodyParseFailure === 'invalid_json'
              || transportObservation.bodyParseFailure === 'body_read_failed' ? undefined : JSON.stringify(nextPayload),
          });
        } catch { /* Keep the original response and error behavior. */ }
      }
      return { payload: nextPayload, response };
    } finally {
      requestSignal.cleanup();
    }
  };

  let payload: ChatCompletionResponse = devFixturePayload ?? {};
  let response: { ok: boolean; status: number } = devFixturePayload
    ? { ok: true, status: 200 }
    : { ok: false, status: 0 };
  if (!devFixturePayload) {
    try {
      ({ payload, response } = await requestNonStreamingCompletion());
    } catch (error) {
      if (capturedRequest) observeChatDiagnostic(finishProactiveRequestCapture, capturedRequest, {
        outcome: signal?.aborted ? 'aborted' : error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error',
      });
      Object.assign(transportObservation, getChatTransportErrorDetails(error));
      if (error instanceof Error && error.name === 'AbortError') {
        transportObservation.stopCause = signal?.aborted ? 'aborted' : 'timeout';
      }
      if (transportStarted) notifyTransport({ phase: 'finished', finishedAt: Date.now(), outcome: signal?.aborted ? 'aborted'
        : error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error' });
      if (error instanceof Error && error.name === 'AbortError') {
        if (signal?.aborted) throw Object.assign(error, { stopCause: transportObservation.stopCause });
        throw new AiRequestError('模型服务等待超时，这不一定是网络故障，请稍后重试。', 'timeout', {
          stopCause: transportObservation.stopCause,
        });
      }

      if (error instanceof Error && error.message) {
        throw new AiRequestError(`无法访问服务：${error.message}`, 'network');
      }

      throw new AiRequestError('无法访问服务，请检查网络与 Base URL。', 'network');
    } finally {
      requestMetric?.recordUsage(payload?.usage);
      void requestMetric?.finish();
    }
  }

  const providerCode = payload?.error?.code;
  const providerErrorCode = typeof providerCode === 'string' || typeof providerCode === 'number'
    ? (/^[a-zA-Z0-9_.:-]{1,80}$/u.test(String(providerCode))
      && !/^sk-/iu.test(String(providerCode))
      && !(apiKey.trim() && String(providerCode).includes(apiKey.trim())) ? String(providerCode) : undefined)
    : undefined;
  if (!devFixturePayload) notifyTransport({
    phase: 'finished', finishedAt: Date.now(),
    outcome: transportObservation.stopCause ?? (response.ok ? 'response_received' : 'http_error'), httpStatus: response.status,
    providerErrorCode,
    usage: normalizeCompletionUsage(payload?.usage),
    usagePresent: transportObservation.bodyParseFailure ? undefined : Boolean(payload?.usage),
  });

  // Keep null's existing non-retry failure, but do not lose the finished transport evidence.
  if (payload === null && (response.ok || (response.status !== 401 && response.status !== 403))) {
    throw Object.assign(new TypeError('Provider response payload is null'), {
      bodyParseFailure: transportObservation.bodyParseFailure,
    });
  }

  if (!response.ok) {
    if (response.status === 403 && providerErrorCode === 'AllocationQuota.FreeTierOnly') {
      throw new AiRequestError('当前模型的免费额度已用尽，服务已按“免费额度用完即停”设置停止。', 'provider_http', {
        httpStatus: response.status, providerErrorCode, bodyParseFailure: transportObservation.bodyParseFailure,
        retryable: false,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new AiRequestError('API Key 无效或没有调用权限，请回到设置检查连接。', 'authentication', {
        httpStatus: response.status, providerErrorCode, bodyParseFailure: transportObservation.bodyParseFailure,
      });
    }
    throw new AiRequestError(payload.error?.message || `服务返回错误状态 ${response.status}。`, 'provider_http', {
      httpStatus: response.status, providerErrorCode, bodyParseFailure: transportObservation.bodyParseFailure,
    });
  }

  const message = payload.choices?.[0]?.message;
  const rawAssistantContent = readAssistantContentRaw(payload);
  const rawDirectContent = rawAssistantContent.trim();
  const rawReasoningContent = typeof message?.reasoning_content === 'string'
    ? message.reasoning_content
    : undefined;
  const reasoningContent = rawReasoningContent ?? '';
  // Ollama's OpenAI adapter returns `reasoning`. Count it for diagnostics only:
  // this must not turn internal reasoning into visible replies or tool evidence.
  const diagnosticReasoningContentChars = rawReasoningContent !== undefined
    ? rawReasoningContent.length
    : connection.preset === 'ollama' && typeof message?.reasoning === 'string' ? message.reasoning.length : 0;
  const finishReason = payload.choices?.[0]?.finish_reason;
  const wasTruncated = finishReason === 'length' || finishReason === 'max_tokens';
  const assistantToolCallMessage = buildAssistantToolCallMessage(
    message,
    rawAssistantContent,
    rawReasoningContent,
  );
  const usage = normalizeCompletionUsage(payload.usage);
  let visibleReply: VisibleReplyExtractionResult;
  let rawEnvelopeForSemanticParsing: string | undefined;
  if (semanticEnvelopeProtocol === 'single_root_json') {
    const expectedStructure = devFixturePayload ? 'default' : 'single_root_json';
    const reminderReplyRoot = Platform.OS === 'windows' && options.desktopReminderSaveFeedback === true
      && contextSource === 'chat.main' && options.transportRequestKind === 'initial'
      && finishReason === 'stop' && !devFixturePayload
      ? extractReminderFeedbackReplyRoot(rawDirectContent) : undefined;
    const directStructured = extractVisibleReplyFromRaw({
      raw: reminderReplyRoot ?? rawDirectContent,
      allowPlainText: false,
      expectedStructure,
      allowUnescapedMessageQuotes: qwenChatLayout === 'ordinary'
        && isSiliconQwenChatConnection(connection) && finishReason === 'stop'
        && (contextSource === undefined || contextSource === 'chat.main' || contextSource === 'chat.quality-retry'),
    });
    visibleReply = directStructured;
    let internalEnvelopeCandidate = isCompleteSingleRootJsonCandidate(directStructured.raw)
      ? directStructured.raw
      : isCompleteSingleRootJsonCandidate(rawDirectContent)
        ? rawDirectContent
        : undefined;
    let directPrefixRecoverySucceeded = false;

    if (visibleReply.status !== 'visible' && semanticPrefixCompletionRequested && rawDirectContent) {
      const restoredDirectCandidate = restoreBaiyunSemanticPrefixCompletion(
        rawDirectContent,
        semanticEnvelopeProtocol,
      );
      const recoveredDirect = extractVisibleReplyFromRaw({
        raw: restoredDirectCandidate,
        allowPlainText: false,
        expectedStructure,
      });
      if (isCompleteSingleRootJsonCandidate(recoveredDirect.raw)) {
        directPrefixRecoverySucceeded = true;
        internalEnvelopeCandidate = recoveredDirect.raw;
        if (recoveredDirect.status === 'visible') visibleReply = recoveredDirect;
      }
    }

    if (
      visibleReply.status !== 'visible'
      && !directPrefixRecoverySucceeded
      && finishReason === 'stop'
    ) {
      const safePlainDirect = extractSafeDirectPlainText({
        forbiddenStandaloneTokens: [...BAIYUN_SEMANTIC_SIGNAL_KINDS, 'ordinary_chat'],
        raw: rawDirectContent,
      });
      if (safePlainDirect.status === 'visible') visibleReply = safePlainDirect;
    }

    if (visibleReply.status !== 'visible' && contextSource !== 'proactive.ordinary') {
      let reasoningStructured = extractVisibleReply({
        directContent: '',
        reasoningContent,
        allowReasoningRecovery: true,
        expectedStructure,
      });
      const trimmedReasoning = rawReasoningContent?.trim() ?? '';
      if (semanticPrefixCompletionRequested && trimmedReasoning) {
        const recoveredReasoning = extractVisibleReplyFromRaw({
          raw: restoreBaiyunSemanticPrefixCompletion(trimmedReasoning, semanticEnvelopeProtocol),
          source: 'reasoning_marked_visible',
          allowPlainText: false,
          expectedStructure,
        });
        if (isCompleteSingleRootJsonCandidate(recoveredReasoning.raw)) {
          internalEnvelopeCandidate ??= recoveredReasoning.raw;
          if (recoveredReasoning.status === 'visible') reasoningStructured = recoveredReasoning;
        }
      }
      if (
        !internalEnvelopeCandidate
        && isCompleteSingleRootJsonCandidate(reasoningStructured.raw)
      ) {
        internalEnvelopeCandidate = reasoningStructured.raw;
      }
      if (reasoningStructured.status === 'visible') {
        visibleReply = reasoningStructured;
      } else {
        if (!internalEnvelopeCandidate && isCompleteSingleRootJsonCandidate(trimmedReasoning)) {
          internalEnvelopeCandidate = trimmedReasoning;
        }
        if (
          directStructured.status === 'model_empty'
          && reasoningStructured.status === 'structure_invalid'
        ) {
          visibleReply = reasoningStructured;
        }
      }
    }

    rawEnvelopeForSemanticParsing = visibleReply.status === 'visible'
      ? getSemanticEnvelopeForVisibleReply(visibleReply)
      : internalEnvelopeCandidate;
  } else {
    const directContent = semanticPrefixCompletionRequested
      ? restoreBaiyunSemanticPrefixCompletion(rawDirectContent, semanticEnvelopeProtocol)
      : rawDirectContent;
    const restoredReasoningContent = semanticPrefixCompletionRequested
      ? restoreBaiyunSemanticPrefixCompletion(reasoningContent, semanticEnvelopeProtocol)
      : reasoningContent;
    visibleReply = extractVisibleReply({
      directContent,
      reasoningContent: restoredReasoningContent,
      allowReasoningRecovery: contextSource !== 'proactive.ordinary',
      expectedStructure: 'default',
    });
  }
  const recoveredFromReasoning = visibleReply.status === 'visible'
    && visibleReply.source === 'reasoning_marked_visible';
  const legacyEnvelopeContent = visibleReply.status === 'model_empty'
    ? ''
    : visibleReply.structureVariant === 'legacy_message' && !visibleReply.hiddenPayload
      ? JSON.stringify({ messages: visibleReply.messages })
      : visibleReply.raw;
  const visibleAssistantText = semanticEnvelopeProtocol === 'single_root_json'
    ? (visibleReply.status === 'visible' ? visibleReply.messages.join('\n') : '')
    : legacyEnvelopeContent;
  const contentForToolParsing = semanticEnvelopeProtocol === 'single_root_json'
    ? visibleAssistantText
    : legacyEnvelopeContent;
  const rawOpenAiToolCallCount = Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0;
  const openAiToolCallResult = rawOpenAiToolCallCount > 0
    && (toolAgentProtocolMode || toolMode === 'openai-tools')
    ? (wishPackageEntry ? parseWishPackageToolCalls(message, tools) : parseOpenAiToolCalls(message, tools))
    : { errors: [], invocations: [], rawCallCount: 0 };
  const promptJsonToolCallResult = toolMode === 'prompt-json' && contentForToolParsing
    ? parsePromptJsonToolInvocations(contentForToolParsing)
    : { errors: [], invocations: [], rawCallCount: 0 };
  const toolInvocations = [...openAiToolCallResult.invocations, ...promptJsonToolCallResult.invocations];
  const toolInvocationErrors = [...openAiToolCallResult.errors, ...promptJsonToolCallResult.errors];
  const rawToolCallCount = openAiToolCallResult.rawCallCount + promptJsonToolCallResult.rawCallCount;
  const toolProtocolEmptyResponse = toolAgentProtocolMode
    && payload.choices?.[0]?.finish_reason === 'tool_calls';
  const providerEmptySuccess = rawAssistantContent.length === 0
    && diagnosticReasoningContentChars === 0
    && rawOpenAiToolCallCount === 0;
  const trueProviderEmpty = semanticEnvelopeProtocol === 'single_root_json'
    ? !rawDirectContent && reasoningContent.length === 0
    : !legacyEnvelopeContent;
  const historyLabelsOnly = visibleReply.status === 'visible'
    && isReplyOnlyHistoryLabels(visibleReply.messages.join('\n'));
  // Empty completions must not leave an earlier successful request in the diagnostic view.
  try {
    recordPromptRuntimeSnapshot({ contextProfile, contextSource: metricContextSource,
      messages: apiMessages, model: connection.model.trim() });
  } catch { /* Diagnostics cannot change the business result. */ }
  if (
    (trueProviderEmpty || historyLabelsOnly)
    && !toolInvocations.length
    && !toolInvocationErrors.length
    && !toolProtocolEmptyResponse
  ) {
    const choice = payload.choices?.[0];
    const rawContent = choice?.message?.content as unknown;
    const emptyDiagnostics: ChatReplyDiagnostics = {
      responseObserved: !transportObservation.bodyParseFailure,
      directContentChars: rawAssistantContent.length,
      finishReason,
      jsonOutputRequested: cameraReplyJsonOutputRequested || desktopDraftCorrectionJsonOutputRequested,
      rawContent: '',
      rawContentChars: 0,
      rawContentFormat: 'empty',
      reasoningContentChars: diagnosticReasoningContentChars,
      recoveredFromReasoning: false,
      responseEnvelopeMode: responseEnvelopeMode ?? 'messages_only',
      semanticEnvelopeProtocol,
      semanticPrefixCompletionRequested,
      technicalCode: providerEmptySuccess ? BAIYUN_PROVIDER_EMPTY_SUCCESS_CODE : undefined,
      toolCallCount: rawOpenAiToolCallCount,
      usagePresent: Boolean(payload.usage),
      visibleReplyFailureReason: historyLabelsOnly ? 'no_safe_visible_candidate' : visibleReply.failureReason,
      visibleReplySource: visibleReply.source,
      visibleReplyStatus: historyLabelsOnly ? 'model_empty' : visibleReply.status,
      wasTruncated,
      usage,
    };
    attachTransientFixedEnvelopeRawDirect(
      emptyDiagnostics,
      semanticEnvelopeProtocol,
      rawAssistantContent,
      contextSource === 'proactive.ordinary' && responseEnvelopeMode === 'messages_only' && toolAgentProtocolMode,
    );
    observeChatDiagnostic(onReplyDiagnostics, emptyDiagnostics);
    const sentRequest = JSON.parse(body) as { messages: Array<{ role: string }>; tools?: unknown[] };
    console.warn('[chat-empty-response]', {
      choiceCount: payload.choices?.length ?? 0,
      model: connection.model.trim(),
      contextSource: metricContextSource,
      qwenChatLayout: isSiliconQwenChatConnection(connection)
        && (qwenChatLayout === 'ordinary' || qwenChatLayout === 'important_raw' && contextSource === 'proactive.ordinary')
        ? qwenChatLayout : 'none',
      sentRoleCounts: Object.fromEntries(['system', 'user', 'assistant', 'tool'].map(role =>
        [role, sentRequest.messages.filter(message => message.role === role).length])),
      sentToolCount: sentRequest.tools?.length ?? 0,
      transportRequestKind: transportRequestKind ?? 'unknown',
      directContentChars: rawAssistantContent.length,
      visibleReplyFailureReason: historyLabelsOnly ? 'no_safe_visible_candidate' : visibleReply.failureReason,
      completionTokens: payload.usage?.completion_tokens ?? null,
      contentKind: Array.isArray(rawContent)
        ? 'parts'
        : rawContent === null
          ? 'null'
          : typeof rawContent === 'string'
            ? 'string'
            : 'missing',
      finishReason: finishReason ?? 'missing',
      httpStatus: response.status,
      jsonOutputRequested: cameraReplyJsonOutputRequested || desktopDraftCorrectionJsonOutputRequested,
      promptTokens: payload.usage?.prompt_tokens ?? null,
      reasoningContentChars: diagnosticReasoningContentChars,
      responseEnvelopeMode: responseEnvelopeMode ?? 'messages_only',
      totalTokens: payload.usage?.total_tokens ?? null,
    });
    throw new AiRequestError('白云小姐这次没有返回文字，请稍后再试。', 'empty_response', {
      bodyParseFailure: transportObservation.bodyParseFailure,
      stopCause: transportObservation.stopCause,
    });
  }
  const diagnosticEnvelope = semanticEnvelopeProtocol === 'single_root_json'
    ? rawEnvelopeForSemanticParsing ?? ''
    : legacyEnvelopeContent;
  const diagnostics: ChatReplyDiagnostics = {
    responseObserved: !transportObservation.bodyParseFailure,
    directContentChars: rawAssistantContent.length,
    finishReason,
    jsonOutputRequested: cameraReplyJsonOutputRequested || desktopDraftCorrectionJsonOutputRequested,
    rawContent: semanticEnvelopeProtocol === 'single_root_json' ? '' : legacyEnvelopeContent,
    rawContentChars: diagnosticEnvelope.length,
    rawContentFormat: classifyChatReplyRawContent(diagnosticEnvelope),
    reasoningContentChars: diagnosticReasoningContentChars,
    recoveredFromReasoning,
    responseEnvelopeMode: responseEnvelopeMode ?? 'messages_only',
    semanticEnvelopeProtocol,
    semanticPrefixCompletionRequested,
    toolCallCount: rawOpenAiToolCallCount,
    usagePresent: Boolean(payload.usage),
    visibleReplyFailureReason: visibleReply.failureReason,
    visibleReplySource: visibleReply.source,
    visibleReplyStatus: visibleReply.status,
    wasTruncated,
    usage,
  };
  attachTransientFixedEnvelopeRawDirect(
    diagnostics,
    semanticEnvelopeProtocol,
    rawAssistantContent,
    contextSource === 'proactive.ordinary' && responseEnvelopeMode === 'messages_only' && toolAgentProtocolMode,
  );
  observeChatDiagnostic(onReplyDiagnostics, diagnostics);
  if (typeof payload.usage?.prompt_tokens === 'number' && Number.isFinite(payload.usage.prompt_tokens)) {
    const { hitRate, hitTokens, missTokens } = extractPromptCacheUsageFromResponseUsage(payload.usage);
    observeChatDiagnostic(onPromptTokens, payload.usage.prompt_tokens, 'api', promptBreakdown, {
      ...estimatedCacheStats,
      hitRate,
      hitTokens,
      missTokens,
    });
  }

  const silent = allowPhoneEmergencySilence && toolAgentProtocolMode
    && contextSource === 'proactive.ordinary' && responseEnvelopeMode === 'messages_only'
    && semanticEnvelopeProtocol === 'legacy_tagged' && finishReason === 'stop'
    && !wasTruncated && !transportObservation.bodyParseFailure && !transportObservation.stopCause
    && !signal?.aborted && !payload.error && typeof message?.content === 'string'
    && (message.tool_calls === undefined || Array.isArray(message.tool_calls) && message.tool_calls.length === 0)
    && rawToolCallCount === 0 && !toolInvocationErrors.length
    && isExplicitPhoneEmergencySilence(message.content);
  const contents = visibleReply.status === 'visible'
    ? parseAssistantMessageBubbles(
        JSON.stringify({ messages: visibleReply.messages }),
        { allowRecoverableJson: !wasTruncated },
      )
    : [];
  return {
    ...(silent ? { silent: true as const } : {}),
    theaterBackstage: backstage?.source,
    textualToolProtocol: visibleReply.status === 'structure_invalid' && containsToolProtocolMarkup(visibleReply.raw),
    assistantToolCallMessage,
    assistantText: visibleAssistantText,
    contents,
    diagnostics,
    finishReason,
    rawToolCallCount,
    rawEnvelopeForSemanticParsing,
    reasoningContent,
    toolInvocationErrors,
    toolInvocations,
    usage,
  };
}

export async function describeImageWithVisionModel({
  apiKey,
  connection,
  imageDataUrl,
  mimeType,
  prompt,
  signal,
  chatImageMaterial,
  onRequestStart,
}: {
  apiKey: string;
  connection: AiConnection;
  imageDataUrl: string;
  mimeType: string;
  prompt?: string;
  signal?: AbortSignal;
  chatImageMaterial?: ChatImageVisionMaterial;
  onRequestStart?: (assertTransportReady: () => void) => Promise<void>;
}) {
  let requestSignal: ReturnType<typeof createChatRequestSignal> | undefined;
  let requestStarted = false;
  let cacheMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  const assertTransportReady = () => {
    if (signal?.aborted || requestSignal?.signal.aborted) {
      const error = new Error('chat-image-request-aborted');
      error.name = 'AbortError';
      throw error;
    }
  };
  try {
    const chatPrompt = chatImageMaterial ? buildChatImageVisionPrompt(chatImageMaterial) : undefined;
    const body = JSON.stringify({
        model: connection.model.trim(),
        ...(shouldDisableThinkingForSiliconFlowQwen35(connection) ? { enable_thinking: false } : {}),
        messages: chatPrompt ? [
          { role: 'system', content: chatPrompt.systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: {
                url: imageDataUrl.startsWith('data:') ? imageDataUrl : `data:${mimeType};base64,${imageDataUrl}`,
              } },
              ...(chatPrompt.questionText === undefined ? [] : [{ type: 'text', text: chatPrompt.questionText }]),
            ],
          },
        ] : [
          {
            role: 'system',
            content: '【图片理解】\nI 正在看这张图片，整理其中实际可见的内容，供后续回应 you 时参考。不确定的部分标明不确定。',
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt?.trim() || '写清图片里的主体、可见文字、环境、颜色、表情和构图；如果是截图，也写清界面结构和需要留意的文字。',
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageDataUrl.startsWith('data:') ? imageDataUrl : `data:${mimeType};base64,${imageDataUrl}`,
                },
              },
            ],
          },
        ],
        max_tokens: 800,
        temperature: 0.2,
      });
    assertTransportReady();
    await onRequestStart?.(assertTransportReady);
    assertTransportReady();
    // Local admission/save time is not network time. An admitted attempt is never retried here.
    requestSignal = createChatRequestSignal(signal, VISION_COMPLETION_TIMEOUT_MS);
    assertTransportReady();
    requestStarted = true;
    cacheMetric = beginPromptCacheMetric({ connection, contextProfile: 'vision',
      contextSource: chatImageMaterial ? 'image.chat' : 'image.describe', stablePrefixText: chatPrompt?.systemPrompt });
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      body,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: requestSignal.signal,
    });
    const payload = await readJsonPayload(response);
    cacheMetric.recordUsage(payload?.usage);
    assertTransportReady();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AiRequestError('看图模型 API Key 无效或没有调用权限，请回到设置检查连接。', 'authentication', { httpStatus: response.status });
      }
      throw new AiRequestError(payload.error?.message || `看图模型返回错误状态 ${response.status}。`, 'provider_http', { httpStatus: response.status });
    }
    const content = readAssistantContent(payload);
    if (!content) throw new AiRequestError('看图模型这次没有返回图片理解，请稍后再试。', 'empty_response');
    return content;
  } catch (error) {
    // Keep source/save admission failures intact; they are not network failures.
    if (!requestStarted || (signal?.aborted && error instanceof Error && error.name === 'AbortError')) throw error;
    if (error instanceof AiRequestError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new AiRequestError('看图模型连接超时，请检查网络或服务地址。', 'timeout');
    if (error instanceof Error && error.message) throw new AiRequestError(`看图模型无法访问：${error.message}`, 'network');
    throw new AiRequestError('看图模型无法访问，请检查网络与 Base URL。', 'network');
  } finally {
    void cacheMetric?.finish();
    requestSignal?.cleanup();
  }
}

/** Compiled materials only: no post/chat prompt is introduced in this transport adapter. */
export async function requestCompiledVisionMaterial(input: {
  apiKey: string;
  connection: AiConnection;
  systemPrompt: string;
  material: { role: 'you'; content: readonly VisionContentPart[] };
  maxOutputTokens: number;
  signal?: AbortSignal;
  onRequestStart?: (assertTransportReady: () => void) => Promise<void>;
}) {
  const imageCount = input.material.content.filter(part => part.type === 'image_url').length;
  if (input.material.role !== 'you' || !input.systemPrompt.trim() || imageCount < 1 || imageCount > 9
    || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 8192) {
    throw new Error('compiled_vision_invalid_material');
  }
  let requestSignal: ReturnType<typeof createChatRequestSignal> | undefined;
  let started = false;
  let cacheMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  const ready = () => {
    if (input.signal?.aborted || requestSignal?.signal.aborted) throw new Error('compiled_vision_aborted');
  };
  try {
    const body = JSON.stringify({
      model: input.connection.model.trim(),
      ...(shouldDisableThinkingForSiliconFlowQwen35(input.connection) ? { enable_thinking: false } : {}),
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.material.content },
      ],
      max_tokens: input.maxOutputTokens,
      temperature: 0.2,
      stream: false,
    });
    ready();
    await input.onRequestStart?.(ready);
    ready();
    requestSignal = createChatRequestSignal(input.signal, VISION_COMPLETION_TIMEOUT_MS);
    ready();
    started = true;
    cacheMetric = beginPromptCacheMetric({ connection: input.connection, contextProfile: 'vision', contextSource: 'image.shiying' });
    const response = await fetch(`${input.connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', body, signal: requestSignal.signal,
      headers: { Authorization: `Bearer ${input.apiKey.trim()}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? 'compiled_vision_auth' : `compiled_vision_http_${response.status}`);
    const payload = await readJsonPayload(response);
    cacheMetric.recordUsage(payload?.usage);
    ready();
    const finishReason = payload.choices?.[0]?.finish_reason;
    if (finishReason && finishReason !== 'stop' && finishReason !== 'end_turn') {
      throw new Error('compiled_vision_incomplete_response');
    }
    const content = readAssistantContent(payload);
    if (!content.trim()) throw new Error('compiled_vision_empty_response');
    return content;
  } catch (error) {
    // Provider text and native errors can include material or credentials; retain only codes.
    if (!started) throw error;
    if (error instanceof Error && /^compiled_vision_[a-z0-9_]+$/u.test(error.message)) throw error;
    if (requestSignal?.signal.aborted) throw new Error('compiled_vision_timeout');
    throw new Error('compiled_vision_network_or_response');
  } finally { void cacheMetric?.finish(); requestSignal?.cleanup(); }
}

export async function describeImageGroupWithVisionModel({
  apiKey, connection, images, signal,
}: {
  apiKey: string;
  connection: AiConnection;
  images: readonly PostVisionImage[];
  signal?: AbortSignal;
}) {
  const messages = buildPostImageVisionMessages(images);
  const requestSignal = createChatRequestSignal(signal, VISION_COMPLETION_TIMEOUT_MS);
  let cacheMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  try {
    const body = JSON.stringify({
      model: connection.model.trim(),
      ...(shouldDisableThinkingForSiliconFlowQwen35(connection) ? { enable_thinking: false } : {}),
      messages, max_tokens: 800, temperature: 0.2,
    });
    if (!requestSignal.signal.aborted) {
      cacheMetric = beginPromptCacheMetric({ connection, contextProfile: 'vision', contextSource: 'image.post' });
    }
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      body,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: requestSignal.signal,
    });
    const payload = await readJsonPayload(response);
    cacheMetric?.recordUsage(payload?.usage);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AiRequestError('看图模型 API Key 无效或没有调用权限，请回到设置检查连接。', 'authentication', { httpStatus: response.status });
      }
      throw new AiRequestError(payload.error?.message || `看图模型返回错误状态 ${response.status}。`, 'provider_http', { httpStatus: response.status });
    }
    const finishReason = payload.choices?.[0]?.finish_reason;
    if (finishReason != null && finishReason !== 'stop' && finishReason !== 'end_turn') {
      throw new AiRequestError('看图模型这次没有返回完整图片理解，请稍后再试。', 'empty_response');
    }
    const content = readAssistantContent(payload);
    if (!content) throw new AiRequestError('看图模型这次没有返回图片理解，请稍后再试。', 'empty_response');
    return content;
  } catch (error) {
    if (error instanceof AiRequestError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new AiRequestError('看图模型连接超时，请检查网络或服务地址。', 'timeout');
    if (error instanceof Error && error.message) throw new AiRequestError(`看图模型无法访问：${error.message}`, 'network');
    throw new AiRequestError('看图模型无法访问，请检查网络与 Base URL。', 'network');
  } finally {
    void cacheMetric?.finish();
    requestSignal.cleanup();
  }
}
export async function sendChatCompletionWithTools(options: ChatOptions) {
  return requestChatCompletion(options);
}

export async function sendChatCompletionResult(options: ChatOptions) {
  return requestChatCompletion({ ...options, toolMode: options.toolMode ?? 'none' });
}

export async function sendChatCompletion(options: ChatOptions) {
  const result = await sendChatCompletionResult(options);
  return result.contents;
}
