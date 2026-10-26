import { Platform } from 'react-native';
import { createNativeToolPackageDiscoveryTool } from '../tools/toolCapabilityDiscovery';
import { BackstageCapacityPending } from '../chat/chatTheaterBackstage';
import {
  sendChatCompletionWithTools,
  type ChatCompletionWithToolsResult,
  type ChatCompletionUsage,
  type ChatOptions,
} from './openAiCompatibleProvider';
import {
  runToolAgentLoop,
  selectFollowUpToolCandidates,
  createToolAgentTurnController,
  createToolAgentPendingExecutionRegistry,
  localToolExecutionAttemptJournal,
  type JunLuoToolAgentContinuationMessage,
  type JunLuoToolAgentModelRequest,
  type JunLuoToolAgentModelTurn,
  type JunLuoToolAgentInvocationExecutionContext,
  type JunLuoToolAgentExecutionPolicy,
  type JunLuoToolAgentProtocolFailure,
  type JunLuoToolCandidateSelection,
  type JunLuoToolInvocation,
  type JunLuoToolResult,
  type JunLuoToolAgentTurnController,
  type JunLuoToolAgentPendingExecutionRegistry,
  type JunLuoToolExecutionAttemptJournal,
  type JunLuoToolAgentInvocationGate,
  buildToolResultInstruction,
} from '../tools';
import {
  getDeepSeekBetaConnection,
  getDeepSeekStandardConnection,
  loadToolProviderCapabilities,
  type ToolProviderCapabilities,
  type ToolProviderCapabilitySource,
} from './toolProviderCapabilities';
import { isBodySignalHistoryTool, withBodySignalHistoryToolDescription } from '../tools/bodySignalHistoryToolDefinition';
import { isWishToolId } from '../wishPool/wishToolContract';
import { isGiftToolId } from '../gifts/giftToolContract';
import { RESEARCH_CHAT_TOOL_IDS } from '../tools/researchChatTools';
import { BROWSER_OPEN_TOOL_ID } from '../tools/browserChatTool';
import { isReminderChatTool } from '../tools/chatReminderTools';
import { inspectBaiyunFixedChatEnvelope } from './behavior/actionChatFixedEnvelope';
import { DESKTOP_REMINDER_DRAFT_CONTINUATION_INSTRUCTION } from './behavior/actionChatSemantic';
import { assertQwenChatMessages, isSiliconQwenChatConnection } from './qwenChatLayout';
import { isToolProviderAlwaysThinking } from './modelParameters';
import { isPhoneLimitToolId, PHONE_LIMIT_PACKAGE_ID } from '../tools/phoneLimitContract';

export const TOOL_AGENT_TURN_INSTRUCTION = `【I 手边的工具】

这轮，I 手边有一些能实际做事的工具。想查清什么，或想替 you 做点什么时，I 可以挑合适的来用；只是想和 you 说说话时，就自然地说话。

本轮标着“允许主动”的工具，I 想用时就可以用，不用等 you 先开口。I 可以顺着自己的好奇去查查看，也可以挑一首想和 you 一起听的歌。

需要用到工具时，I 先使用它。等结果回来后，再依着真正发生的事，把这一轮想对 you 说的话写完。`;

export const TOOL_AGENT_PROTOCOL_CORRECTION_INSTRUCTION = `【刚才的工具没有接上】

刚才那次工具没有顺利接上。I 再看看自己想做的事，也看看手边哪个工具合适。需要的内容还不够时，I 可以先问问 you；原来并不需要工具时，也可以直接回应 you。`;

export const TOOL_AGENT_ACTION_REVIEW_INSTRUCTION = `【再看看刚才的结果】

I 刚才说的话和真正发生的事没有对上。I 想再看看手里的结果，把已经做成的、还没有做成的，以及只走到中间一步的，都重新告诉 you。`;

const DESKTOP_FIXED_OBJECT_CORRECTION_INSTRUCTION = `I 把这轮完整的 JSON 对象写好，从 messages 开始，写到最后的右花括号 }。`;

const DESKTOP_REMINDER_ACTION_CORRECTION_INSTRUCTION = `I 把 reminderAction 填好，连同这轮的完整 JSON 一起发出。`;

const DESKTOP_DRAFT_TOOL_CLASSIFICATION_INSTRUCTIONS = [
  'you 要排日程时，I 用 schedule.submit_day_plan 准备日程草稿，提前提醒也填在同一件安排里。reminderAction 填 null。',
  'you 要单独设提醒或闹钟时，I 用 reminder.propose_reminders 准备提醒草稿，reminderAction 写这次的选择。',
];

type ApprovedProtocolCorrectionErrorCode =
  | 'DUPLICATE_CALL_ID'
  | 'FINISH_REASON_MISMATCH'
  | 'INVALID_ARGUMENTS'
  | 'INVALID_TOOL_CALL_BATCH'
  | 'MISSING_CALL_ID'
  | 'TOOL_NOT_ALLOWED';

function approvedProtocolCorrectionErrorCode(
  code: string,
): ApprovedProtocolCorrectionErrorCode {
  switch (code) {
    case 'DUPLICATE_CALL_ID':
    case 'FINISH_REASON_MISMATCH':
    case 'INVALID_ARGUMENTS':
    case 'INVALID_TOOL_CALL_BATCH':
    case 'MISSING_CALL_ID':
    case 'TOOL_NOT_ALLOWED':
      return code;
    case 'UNKNOWN_TOOL':
      return 'TOOL_NOT_ALLOWED';
    default:
      return 'INVALID_TOOL_CALL_BATCH';
  }
}

function protocolCorrectionEnvelope(code: string) {
  return JSON.stringify({
    ok: false,
    errorCode: approvedProtocolCorrectionErrorCode(code),
    retryable: true,
  });
}

function appendResponseInstruction(base: string | undefined, addition: string) {
  return base?.trim() ? `${base}\n\n${addition}` : addition;
}

function pairableProtocolCorrectionMessages(
  previousTurn: JunLuoToolAgentModelTurn,
  failure: JunLuoToolAgentProtocolFailure,
): JunLuoToolAgentContinuationMessage[] | undefined {
  if (
    failure.rawToolCallCount <= 0
    || failure.code === 'DUPLICATE_CALL_ID'
    || failure.code === 'MISSING_CALL_ID'
    || previousTurn.toolInvocationErrors.some((error) => (
      error.code === 'DUPLICATE_CALL_ID'
      || error.code === 'INVALID_TOOL_CALL_SHAPE'
      || error.code === 'MISSING_CALL_ID'
    ))
  ) {
    return undefined;
  }
  const assistantMessage = previousTurn.assistantToolCallMessage;
  if (!assistantMessage) return undefined;
  const toolIdByCallId = new Map([
    ...previousTurn.toolInvocations.map((invocation) => [
      invocation.callId,
      invocation.toolId,
    ] as const),
    ...previousTurn.toolInvocationErrors.map((error) => [
      error.callId ?? '',
      error.toolId ?? error.rawName ?? '',
    ] as const),
  ]);
  const calls = assistantMessage.toolCalls;
  if (
    calls.length !== failure.rawToolCallCount
    || calls.some((call) => !call.callId.trim() || !toolIdByCallId.get(call.callId)?.trim())
    || new Set(calls.map((call) => call.callId)).size !== calls.length
  ) {
    return undefined;
  }
  const resultMessages = calls.map((call): JunLuoToolAgentContinuationMessage => {
    const callError = failure.callErrors.find((error) => error.callId === call.callId);
    const errorCode = callError
      ? callError.errorCode
      : failure.callErrors.length > 0
        ? 'INVALID_TOOL_CALL_BATCH'
        : failure.code;
    return {
      subject: 'I',
      kind: 'tool_result',
      callId: call.callId,
      toolId: toolIdByCallId.get(call.callId)!,
      content: protocolCorrectionEnvelope(errorCode),
    };
  });
  return [assistantMessage, ...resultMessages];
}

type ToolAgentChatOptions = Omit<
  ChatOptions,
  | 'continuationMessages'
  | 'prefixWithTools'
  | 'semanticEnvelopeProtocol'
  | 'semanticOutputModules'
  | 'semanticPrefixCompletionMode'
  | 'strictTools'
  | 'toolChoice'
  | 'toolAgentProtocolMode'
  | 'toolMode'
  | 'tools'
>;

export type ToolAgentProviderRequestPolicy = {
  connection: ChatOptions['connection'];
  nativeToolsEnabled: boolean;
  prefixWithTools: boolean;
  strictTools: boolean;
  toolChoice?: ChatOptions['toolChoice'];
};

export function buildToolAgentProviderRequestPolicy({
  capabilities,
  connection,
  strictToolsRequested,
  thinkingMode,
}: {
  capabilities: ToolProviderCapabilities;
  connection: ChatOptions['connection'];
  strictToolsRequested: boolean;
  thinkingMode?: ChatOptions['thinkingMode'];
}): ToolAgentProviderRequestPolicy {
  const thinkingEnabled = thinkingMode === 'enabled';
  const nativeToolsEnabled = capabilities.nativeTools
    && (!thinkingEnabled || capabilities.thinkingTools);
  const strictTools = nativeToolsEnabled
    && strictToolsRequested
    && capabilities.strictMode !== 'unsupported';
  const toolChoice = !nativeToolsEnabled || capabilities.toolChoiceMode === 'omit_always'
    || (thinkingEnabled && capabilities.toolChoiceMode === 'omit_when_thinking')
    ? undefined
    : 'auto';
  return {
    connection: strictTools && capabilities.strictMode === 'beta_endpoint'
      ? getDeepSeekBetaConnection(connection)
      : getDeepSeekStandardConnection(connection),
    nativeToolsEnabled,
    prefixWithTools: nativeToolsEnabled && capabilities.prefixWithTools,
    strictTools,
    toolChoice,
  };
}

export function assertToolAgentProviderSupportsCandidates(
  capabilities: ToolProviderCapabilities,
  thinkingMode: ChatOptions['thinkingMode'],
  hasCandidates: boolean,
) {
  if (!hasCandidates) return;
  if (!capabilities.nativeTools) throw new Error('TOOL_PROVIDER_NATIVE_TOOLS_UNSUPPORTED');
  if (thinkingMode === 'enabled' && !capabilities.thinkingTools) {
    throw new Error('TOOL_PROVIDER_THINKING_TOOLS_UNSUPPORTED');
  }
}

function continuationMessagesForCapabilities(
  messages: NonNullable<ChatOptions['continuationMessages']>,
  capabilities: ToolProviderCapabilities,
) {
  if (capabilities.reasoningReplay !== 'unsupported') return messages;
  return messages.map((message) => (
    message.kind === 'tool_request'
      ? { ...message, reasoningContent: undefined }
      : message
  ));
}

export type RunOpenAiCompatibleToolAgentTurnOptions = {
  allowPostMemoryMusic?: boolean;
  sourceMessageId: string;
  sourceSessionId: string;
  dataEpoch: number;
  candidates: JunLuoToolCandidateSelection;
  hostOnlyAllowedToolIds?: readonly string[];
  isToolAvailableForRequest?: (toolId: string) => Promise<boolean>;
  chatOptions: ToolAgentChatOptions;
  emptyResponseRetryInstruction?: string;
  allowEmptyResponseRetry?: boolean;
  allowProtocolCorrection?: boolean;
  bodyOnlyRetry?: Parameters<typeof runToolAgentLoop>[0]['bodyOnlyRetry'];
  beforeModelRequest?: (kind: 'initial' | 'tool_continuation' | 'protocol_correction') => Promise<void>;
  modelRequestTimeoutMs?: number;
  requestPreflightAtTransport?: boolean;
  onTransportAttempt?: ChatOptions['onTransportAttempt'];
  onDiagnosticToolEvent?: Parameters<typeof runToolAgentLoop>[0]['onDiagnosticToolEvent'];
  responseFormat?: 'chat_semantic' | 'proactive_lite';
  executeInvocation: (
    invocation: JunLuoToolInvocation,
    context: JunLuoToolAgentInvocationExecutionContext,
  ) => Promise<JunLuoToolResult>;
  projectResultForModel?: Parameters<typeof runToolAgentLoop>[0]['projectResultForModel'];
  resolvePackageDiscovery?: Parameters<typeof runToolAgentLoop>[0]['resolvePackageDiscovery'];
  onModelToolResults?: (messages: NonNullable<ChatOptions['continuationMessages']>) => void | Promise<void>;
  scheduleReminderInstruction?: (messages: NonNullable<ChatOptions['continuationMessages']>) => string;
  prepareInvocation?: Parameters<typeof runToolAgentLoop>[0]['prepareInvocation'];
  reconfirmMemoryCorrection?: Parameters<typeof runToolAgentLoop>[0]['reconfirmMemoryCorrection'];
  resolveExecutionPolicy?: (
    invocation: JunLuoToolInvocation,
  ) => JunLuoToolAgentExecutionPolicy;
  resolveInvocationGate?: (
    invocation: JunLuoToolInvocation,
    context: Omit<JunLuoToolAgentInvocationExecutionContext, 'gateReceipt'>,
  ) => Promise<JunLuoToolAgentInvocationGate>;
  selectFollowUpCandidates?: (
    current: JunLuoToolCandidateSelection,
    results: readonly JunLuoToolResult[],
  ) => JunLuoToolCandidateSelection;
  requireToolCallForCandidates?: Parameters<typeof runToolAgentLoop>[0]['requireToolCallForCandidates'];
  finalDayPlanRepair?: Parameters<typeof runToolAgentLoop>[0]['finalDayPlanRepair'];
  reminderDraftContract?: Parameters<typeof runToolAgentLoop>[0]['reminderDraftContract'];
  toolInstructionMode?: 'full' | 'schema_only';
  strictTools?: boolean;
  capabilities?: ToolProviderCapabilities;
  toolCapabilitySource?: ToolProviderCapabilitySource;
  resolveCapabilities?: (connection: ChatOptions['connection']) => Promise<ToolProviderCapabilities>;
  sendCompletion?: typeof sendChatCompletionWithTools;
  turnController?: JunLuoToolAgentTurnController;
  executionAttemptJournal?: JunLuoToolExecutionAttemptJournal;
  pendingExecutionRegistry?: JunLuoToolAgentPendingExecutionRegistry;
  onSettlement?: Parameters<typeof runToolAgentLoop>[0]['onSettlement'];
  completeWithVisibleCard?: (results: readonly JunLuoToolResult[],
    source?: ChatCompletionWithToolsResult['theaterBackstage']) => Promise<boolean>;
  onLateSettlement?: Parameters<typeof runToolAgentLoop>[0]['onLateSettlement'];
  consumeModelRequest?: (
    kind: 'initial' | 'tool_continuation' | 'protocol_correction',
  ) => boolean | Promise<boolean>;
};

const providerPendingExecutionRegistry = createToolAgentPendingExecutionRegistry();

export function buildToolAgentCompletionOptions(input: {
  chatOptions: ToolAgentChatOptions; capabilities: ToolProviderCapabilities;
  toolCapabilitySource?: ToolProviderCapabilitySource;
  request: JunLuoToolAgentModelRequest; requestThinkingMode?: ChatOptions['thinkingMode'];
  responseInstruction?: string; includeToolInstruction?: boolean; toolInstructionMode?: 'full' | 'schema_only';
  strictTools?: boolean; proactiveLiteResponse?: boolean;
}): ChatOptions {
  const { chatOptions, capabilities, request, requestThinkingMode, responseInstruction,
    includeToolInstruction = true, toolInstructionMode, strictTools, proactiveLiteResponse = false } = input;
    const policy = buildToolAgentProviderRequestPolicy({
      capabilities,
      connection: chatOptions.connection,
      strictToolsRequested: strictTools === true,
      thinkingMode: requestThinkingMode,
    });
    const effectiveAllowTools = request.allowTools && policy.nativeToolsEnabled;
    assertToolAgentProviderSupportsCandidates(capabilities, requestThinkingMode, request.allowTools);
    if (
      effectiveAllowTools
      && request.toolChoice === 'required'
      && capabilities.toolChoiceMode === 'omit_always'
    ) {
      throw new Error('TOOL_REQUIRED_CHOICE_UNSUPPORTED');
    }
    const replayMessages = continuationMessagesForCapabilities(
      [...request.continuationMessages],
      capabilities,
    );
    const reminderDraftContinuation = chatOptions.fixedEnvelopeMode === 'desktop-reminder-draft'
      && request.responseInstruction === DESKTOP_REMINDER_DRAFT_CONTINUATION_INSTRUCTION;
    const requestResponseInstruction = request.responseInstruction && !reminderDraftContinuation
      ? appendResponseInstruction(responseInstruction, request.responseInstruction)
      : responseInstruction;
    const resultInstruction = buildToolResultInstruction(request.completedResults.filter(result => !isGiftToolId(result.toolId)), {
      nativeResultCallIds: replayMessages.filter(message => message.kind === 'tool_result').map(message => message.callId),
    });
    const responseInstructionWithResults = resultInstruction
      ? appendResponseInstruction(requestResponseInstruction, resultInstruction)
      : requestResponseInstruction;
    const effectiveResponseInstruction = includeToolInstruction
      && effectiveAllowTools
      && request.requestKind === 'concrete_tools'
      && toolInstructionMode !== 'schema_only'
      ? appendResponseInstruction(responseInstructionWithResults, TOOL_AGENT_TURN_INSTRUCTION)
      : responseInstructionWithResults;
    return {
      ...chatOptions,
      allowPhoneEmergencySilence: proactiveLiteResponse && chatOptions.allowPhoneEmergencySilence === true,
      connection: effectiveAllowTools ? policy.connection : chatOptions.connection,
      continuationMessages: replayMessages,
      prefixWithTools: effectiveAllowTools && policy.prefixWithTools,
      responseEnvelopeMode: proactiveLiteResponse ? 'messages_only' : 'messages_with_semantic',
      responseInstruction: effectiveResponseInstruction,
      desktopReminderDraftContinuation: reminderDraftContinuation || undefined,
      semanticEnvelopeProtocol: proactiveLiteResponse ? 'legacy_tagged' : 'single_root_json',
      semanticPrefixCompletionMode: 'disabled',
      signal: request.signal,
      strictTools: effectiveAllowTools && policy.strictTools,
      thinkingMode: requestThinkingMode,
      toolAgentProtocolMode: true,
      toolCapabilitySource: input.toolCapabilitySource,
      toolChoice: effectiveAllowTools
        ? request.toolChoice === 'required' ? 'required' : policy.toolChoice
        : undefined,
      toolMode: effectiveAllowTools ? 'openai-tools' : 'none',
      tools: effectiveAllowTools ? withBodySignalHistoryToolDescription(request.tools) : [],
    };
}

export async function prepareInitialToolAgentChatOptions(chatOptions: ToolAgentChatOptions, candidates: JunLuoToolCandidateSelection): Promise<ChatOptions> {
  const { capabilities, source } = await loadToolProviderCapabilities(chatOptions.connection);
  assertToolAgentProviderSupportsCandidates(capabilities, chatOptions.thinkingMode,
    candidates.executableTools.length > 0 || !!candidates.packageDiscovery);
  const policy = buildToolAgentProviderRequestPolicy({ capabilities, connection: chatOptions.connection,
    strictToolsRequested: false, thinkingMode: chatOptions.thinkingMode });
  const discovery = policy.nativeToolsEnabled ? candidates.packageDiscovery : undefined;
  const tools = !policy.nativeToolsEnabled ? [] : discovery && !discovery.alongsideTools ? [createNativeToolPackageDiscoveryTool(discovery)]
    : candidates.candidates.slice(0, 15 + candidates.candidates.filter(candidate => candidate.tool.packageId === 'proactive_contact' || isBodySignalHistoryTool(candidate.tool.id)
      || candidates.wishPackageEntry && isWishToolId(candidate.tool.id)
      || candidates.giftPackageEntry && isGiftToolId(candidate.tool.id)
      || candidates.desktopReminderTools && isReminderChatTool(candidate.tool.id)
      || RESEARCH_CHAT_TOOL_IDS.includes(candidate.tool.id)
      || candidate.tool.id === BROWSER_OPEN_TOOL_ID
      || ['schedule.query_routine', 'schedule.save_routine'].includes(candidate.tool.id)
      || candidates.readingReferenceTools && ['reading.read_material', 'schedule.save_own'].includes(candidate.tool.id)).length).filter(candidate => candidate.executionMode === 'executable'
      && candidate.authority?.allowedToolIds.includes(candidate.tool.id)).map(candidate => candidate.tool);
  if (discovery?.alongsideTools) tools.push(createNativeToolPackageDiscoveryTool(discovery));
  return buildToolAgentCompletionOptions({ chatOptions: { ...chatOptions, wishPackageEntry: candidates.wishPackageEntry === true }, capabilities, toolCapabilitySource: source, requestThinkingMode: chatOptions.thinkingMode,
    responseInstruction: chatOptions.responseInstruction, request: {
      allowTools: tools.length > 0, tools, completedResults: [], continuationMessages: [],
      requestKind: tools.length ? discovery && !discovery.alongsideTools ? 'package_discovery' : 'concrete_tools' : 'final',
      responseInstruction: tools.length ? discovery?.catalogInstruction : undefined,
      signal: chatOptions.signal ?? new AbortController().signal, toolChoice: 'auto', toolRound: 0,
    } });
}

function projectReminderActionIssue(
  inspection: ReturnType<typeof inspectBaiyunFixedChatEnvelope> | undefined,
  raw: string | undefined,
): NonNullable<JunLuoToolAgentModelTurn['reminderActionIssue']> | 'valid' {
  return !inspection ? 'inspection_not_applicable' : !raw ? 'semantic_envelope_absent'
    : inspection.rootStatus !== 'valid' ? 'root_invalid'
      : !inspection.messagesFirst ? 'messages_not_first'
        : inspection.unexpectedRootKeys.length > 0 ? 'unexpected_root_keys'
          : inspection.fields.messages.status !== 'valid' ? 'messages_invalid'
            : inspection.fields.reminderAction?.status === 'missing' ? 'action_missing'
              : inspection.fields.reminderAction?.status !== 'valid' ? 'action_invalid' : 'valid';
}

export async function runOpenAiCompatibleToolAgentTurn(
  options: RunOpenAiCompatibleToolAgentTurnOptions,
) {
  const sendCompletion = options.sendCompletion ?? sendChatCompletionWithTools;
  const proactiveLiteResponse = options.responseFormat === 'proactive_lite';
  const resolved = !options.capabilities && !options.resolveCapabilities
    ? await loadToolProviderCapabilities(options.chatOptions.connection) : undefined;
  const capabilities = options.capabilities ?? (
    options.resolveCapabilities
      ? await options.resolveCapabilities(options.chatOptions.connection)
      : resolved!.capabilities
  );
  const toolCapabilitySource = resolved?.source ?? options.toolCapabilitySource;
  assertToolAgentProviderSupportsCandidates(capabilities, options.chatOptions.thinkingMode,
    !options.bodyOnlyRetry && (options.candidates.executableTools.length > 0 || !!options.candidates.packageDiscovery));
  const initialPolicy = buildToolAgentProviderRequestPolicy({
    capabilities,
    connection: options.chatOptions.connection,
    strictToolsRequested: options.strictTools === true,
    thinkingMode: options.chatOptions.thinkingMode,
  });
  const executableToolIds = initialPolicy.nativeToolsEnabled && !options.bodyOnlyRetry
    ? options.candidates.mode === 'package_discovery'
      ? ['system.use_package']
      : options.candidates.executableTools.map((tool) => tool.id)
    : [];
  const ownsTurnController = !options.turnController;
  const turnController = options.turnController ?? createToolAgentTurnController();
  const turn = turnController.start({
    turnId: options.sourceMessageId,
    sourceMessageId: options.sourceMessageId,
    sourceSessionId: options.sourceSessionId,
    dataEpoch: options.dataEpoch,
    createdAt: Date.now(),
  }, executableToolIds);
  const externalSignal = options.chatOptions.signal;
  const cancelFromExternalSignal = () => turn.cancel('you_stopped');
  if (externalSignal?.aborted) cancelFromExternalSignal();
  else externalSignal?.addEventListener('abort', cancelFromExternalSignal, { once: true });
  let lastCompletion: ChatCompletionWithToolsResult | undefined;
  let aggregateUsage: ChatCompletionUsage | undefined;
  let cachedUsageComplete = true;
  let currentCandidates = options.candidates;
  let providerRequestCount = 0;
  let previousRequestWasEmpty = false;
  const canDisableThinking = !isToolProviderAlwaysThinking(options.chatOptions.connection);
  let thinkingDisabledForTurn = !!options.bodyOnlyRetry && canDisableThinking;
  const requestCompletion = async (
    request: JunLuoToolAgentModelRequest,
    responseInstruction = options.chatOptions.responseInstruction,
    includeToolInstruction = true,
    budgetKind?: 'initial' | 'tool_continuation' | 'protocol_correction',
  ): Promise<JunLuoToolAgentModelTurn> => {
    const modelRequestKind = budgetKind
      ?? (providerRequestCount === 0 ? 'initial' : 'tool_continuation');
    if (request.toolChoice === 'required' && canDisableThinking) thinkingDisabledForTurn = true;
    const requestThinkingMode = thinkingDisabledForTurn
      ? 'disabled'
      : options.chatOptions.thinkingMode;
    const transportObserver = options.onTransportAttempt ?? options.chatOptions.onTransportAttempt;
    const timingEnabled = options.chatOptions.contextSource === 'proactive.ordinary'
      && options.modelRequestTimeoutMs !== undefined;
    const requestNumber = providerRequestCount + 1;
    let timerStartedAt: number | undefined, admissionStartedAt: number | undefined, admissionFinishedAt: number | undefined;
    let networkStartedAt: number | undefined, networkFinishedAt: number | undefined;
    let timedOut = false, deadlineReported = false, networkReported = false;
    let networkOutcome: string | null = null;
    const elapsed = (end: number | undefined, start: number | undefined) =>
      end !== undefined && start !== undefined && Number.isFinite(end) && Number.isFinite(start) && end >= start ? end - start : null;
    const reportTiming = (stage: 'deadline' | 'network_finished') => {
      if (!timingEnabled || (stage === 'deadline' ? deadlineReported : networkReported)) return;
      if (stage === 'deadline') deadlineReported = true; else networkReported = true;
      try {
        console.info('[proactive-request-timing]', { stage, requestNumber, requestKind: modelRequestKind, timedOut,
          deadlineMs: options.modelRequestTimeoutMs, timerStartedAt: timerStartedAt ?? null,
          preTransportMs: elapsed(networkStartedAt, timerStartedAt), admissionMs: elapsed(admissionFinishedAt, admissionStartedAt),
          networkElapsedMs: elapsed(networkFinishedAt, networkStartedAt),
          networkWaitAtDeadlineMs: stage === 'deadline' ? elapsed(Date.now(), networkStartedAt) : null,
          outcome: networkOutcome });
      } catch { /* Technical diagnostics must not affect transport or its observer. */ }
    };
    const retryReason = previousRequestWasEmpty ? 'empty_response'
      : modelRequestKind === 'protocol_correction' ? 'protocol_correction' : undefined;
    const completionOptions: ChatOptions = {
      ...buildToolAgentCompletionOptions({ chatOptions: options.chatOptions, capabilities, toolCapabilitySource, request, requestThinkingMode,
        responseInstruction, includeToolInstruction, toolInstructionMode: options.toolInstructionMode,
        strictTools: options.strictTools, proactiveLiteResponse }),
      wishPackageEntry: !proactiveLiteResponse && options.candidates.wishPackageEntry === true,
      onTransportAttempt: transportObserver ? event => {
        if (timingEnabled) {
          if (typeof event.startedAt === 'number' && Number.isFinite(event.startedAt)) networkStartedAt ??= event.startedAt;
          if (event.phase === 'finished') {
            if (typeof event.finishedAt === 'number' && Number.isFinite(event.finishedAt)) networkFinishedAt ??= event.finishedAt;
            networkOutcome = ['response_received', 'http_error', 'network_error', 'timeout', 'aborted'].includes(event.outcome ?? '')
              ? event.outcome! : null;
            reportTiming('network_finished');
          }
        }
        try { void Promise.resolve(transportObserver({ ...event, requestPurpose: request.requestKind, retryReason })).catch(() => undefined); }
        catch { /* Diagnostics cannot change the model turn. */ }
      } : undefined,
      transportRequestKind: previousRequestWasEmpty ? 'quality_retry'
        : modelRequestKind === 'initial' && options.bodyOnlyRetry?.completedResults.length ? 'tool_continuation' : modelRequestKind,
      ...(options.requestPreflightAtTransport ? {
        rejectOversizedRequest: true,
        beforeTransportRequest: async () => {
          turn.assertActive();
          await options.beforeModelRequest?.(modelRequestKind);
          turn.assertActive();
        },
      } : {}),
    };
    if (Platform.OS === 'windows' && completionOptions.contextSource === 'chat.main'
      && completionOptions.fixedEnvelopeMode === 'desktop-reminder-draft'
      && completionOptions.toolAgentProtocolMode && completionOptions.semanticEnvelopeProtocol === 'single_root_json'
      && (completionOptions.transportRequestKind === 'tool_continuation'
        || completionOptions.transportRequestKind === 'protocol_correction')
      && completionOptions.toolMode === 'openai-tools'
      && ['schedule.submit_day_plan', 'reminder.propose_reminders'].every(id =>
        completionOptions.tools?.some(tool => tool.id === id))) {
      const missing = DESKTOP_DRAFT_TOOL_CLASSIFICATION_INSTRUCTIONS
        .filter(line => !completionOptions.responseInstruction?.includes(line));
      if (missing.length) completionOptions.responseInstruction = appendResponseInstruction(
        completionOptions.responseInstruction, missing.join('\n'));
    }
    const scheduleInstruction = options.scheduleReminderInstruction?.(completionOptions.continuationMessages ?? []);
    if (scheduleInstruction) completionOptions.responseInstruction = appendResponseInstruction(completionOptions.responseInstruction, scheduleInstruction);
    turn.assertActive();
    const qwenTransportAdmission = (completionOptions.qwenChatLayout === 'ordinary'
      || completionOptions.qwenChatLayout === 'important_raw' && completionOptions.contextSource === 'proactive.ordinary')
      && isSiliconQwenChatConnection(completionOptions.connection);
    if (qwenTransportAdmission) {
      assertQwenChatMessages(completionOptions.messages, completionOptions.qwenChatLayout);
    }
    const consume = async () => {
      if (options.consumeModelRequest && !await options.consumeModelRequest(modelRequestKind)) {
        throw new Error('CHAT_MODEL_REQUEST_BUDGET_EXHAUSTED');
      }
    };
    if (qwenTransportAdmission) {
      const beforeTransport = completionOptions.beforeTransportRequest;
      completionOptions.beforeTransportRequest = async () => {
        turn.assertActive();
        await consume();
        if (beforeTransport) await beforeTransport();
        else await options.beforeModelRequest?.(modelRequestKind);
        turn.assertActive();
      };
    } else {
      await consume();
      if (!options.requestPreflightAtTransport) await options.beforeModelRequest?.(modelRequestKind);
    }
    if (timingEnabled && completionOptions.beforeTransportRequest) {
      const beforeTransport = completionOptions.beforeTransportRequest;
      completionOptions.beforeTransportRequest = async () => {
        admissionStartedAt = Date.now();
        try { await beforeTransport(); } finally { admissionFinishedAt = Date.now(); }
      };
    }
    turn.assertActive();
    providerRequestCount += 1;
    try {
      if (options.modelRequestTimeoutMs !== undefined) {
        const controller = new AbortController();
        const abort = () => controller.abort(request.signal.reason);
        request.signal.addEventListener('abort', abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          lastCompletion = await Promise.race([
            sendCompletion({ ...completionOptions, signal: controller.signal }),
            new Promise<never>((_, reject) => {
              if (timingEnabled) timerStartedAt = Date.now();
              timer = setTimeout(() => {
                if (timingEnabled) { timedOut = true; reportTiming('deadline'); }
                controller.abort();
                reject(new Error('TOOL_AGENT_MODEL_REQUEST_TIMEOUT'));
              }, options.modelRequestTimeoutMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          request.signal.removeEventListener('abort', abort);
        }
      } else lastCompletion = await sendCompletion(completionOptions);
      await options.onModelToolResults?.(completionOptions.continuationMessages ?? []);
      previousRequestWasEmpty = false;
    } catch (error) {
      cachedUsageComplete = false;
      if (error instanceof BackstageCapacityPending) error.toolContinuation = {
        continuationMessages: [...request.continuationMessages], completedResults: [...request.completedResults],
      };
      previousRequestWasEmpty = error instanceof Error && 'kind' in error && error.kind === 'empty_response';
      throw error;
    }
    cachedUsageComplete &&= lastCompletion.usage?.cachedPromptTokens !== undefined;
    if (lastCompletion.usage) {
      aggregateUsage = {
        promptTokens: (aggregateUsage?.promptTokens ?? 0) + (lastCompletion.usage.promptTokens ?? 0),
        completionTokens: (aggregateUsage?.completionTokens ?? 0) + (lastCompletion.usage.completionTokens ?? 0),
        totalTokens: (aggregateUsage?.totalTokens ?? 0) + (lastCompletion.usage.totalTokens ?? 0),
        cachedPromptTokens: (aggregateUsage?.cachedPromptTokens ?? 0) + (lastCompletion.usage.cachedPromptTokens ?? 0),
      };
    }
    const reminderEnvelope = options.reminderDraftContract && options.chatOptions.fixedEnvelopeMode === 'desktop-reminder-draft'
      && (lastCompletion.rawToolCallCount ?? lastCompletion.toolInvocations.length) === 0
      ? inspectBaiyunFixedChatEnvelope(lastCompletion.rawEnvelopeForSemanticParsing ?? '', 'desktop-reminder-draft',
        { includeRootFailure: true }) : undefined;
    const reminderAction = reminderEnvelope?.rootStatus === 'valid' && reminderEnvelope.messagesFirst
      && reminderEnvelope.unexpectedRootKeys.length === 0 && reminderEnvelope.fields.messages.status === 'valid'
      && reminderEnvelope.fields.reminderAction?.status === 'valid' ? reminderEnvelope.fields.reminderAction.value : undefined;
    let reminderDiagnostic: Pick<JunLuoToolAgentModelTurn,
      'reminderActionIssue' | 'reminderActionDirectIssue' | 'reminderVisibleReplySource'
      | 'reminderActionRootFailure' | 'reminderActionDirectRootFailure'> = {};
    if (options.reminderDraftContract && reminderAction === undefined
      && (lastCompletion.rawToolCallCount ?? lastCompletion.toolInvocations.length) === 0
      && lastCompletion.finishReason !== 'tool_calls' && !lastCompletion.textualToolProtocol
      && lastCompletion.toolInvocations.length === 0 && lastCompletion.toolInvocationErrors.length === 0) {
      const issue = projectReminderActionIssue(reminderEnvelope, lastCompletion.rawEnvelopeForSemanticParsing);
      const direct = Object.getOwnPropertyDescriptor(lastCompletion.diagnostics, 'fixedEnvelopeRawDirect')?.value;
      const directInspection = typeof direct === 'string'
        ? inspectBaiyunFixedChatEnvelope(direct, 'desktop-reminder-draft', { includeRootFailure: true }) : undefined;
      const directIssue = typeof direct === 'string' ? projectReminderActionIssue(directInspection, direct) : undefined;
      const source = lastCompletion.diagnostics.visibleReplySource;
      reminderDiagnostic = {
        ...(issue !== 'valid' ? { reminderActionIssue: issue } : {}),
        ...(directIssue ? { reminderActionDirectIssue: directIssue } : {}),
        ...(source === 'direct_content' || source === 'reasoning_marked_visible' ? { reminderVisibleReplySource: source } : {}),
        ...(issue === 'root_invalid' && reminderEnvelope?.rootFailure
          ? { reminderActionRootFailure: reminderEnvelope.rootFailure } : {}),
        ...(directIssue === 'root_invalid' && directInspection?.rootFailure
          ? { reminderActionDirectRootFailure: directInspection.rootFailure } : {}),
      };
    }
    return {
      ...(lastCompletion.silent ? { silent: true as const } : {}),
      ...reminderDiagnostic,
      ...(reminderAction !== undefined ? { reminderAction: { sourceMessageId: options.sourceMessageId, choice: reminderAction } } : {}),
      assistantToolCallMessage: lastCompletion.assistantToolCallMessage,
      assistantText: lastCompletion.assistantText,
      finishReason: lastCompletion.finishReason,
      rawToolCallCount: lastCompletion.rawToolCallCount,
      reasoningContent: lastCompletion.reasoningContent,
      textualToolProtocol: lastCompletion.textualToolProtocol,
      toolInvocationErrors: lastCompletion.toolInvocationErrors,
      toolInvocations: lastCompletion.toolInvocations,
    };
  };
  let loopResult: Awaited<ReturnType<typeof runToolAgentLoop>>;
  try {
    loopResult = await runToolAgentLoop({
      allowPhoneEmergencySilence: proactiveLiteResponse && options.chatOptions.allowPhoneEmergencySilence === true,
      onDiagnosticToolEvent: options.onDiagnosticToolEvent,
      maxCandidates: proactiveLiteResponse
        ? 8 + options.candidates.candidates.filter(candidate => isWishToolId(candidate.tool.id)
          || options.candidates.giftPackageEntry && isGiftToolId(candidate.tool.id)
          || candidate.tool.id === 'camera.read_observations'
          || candidate.tool.packageId === PHONE_LIMIT_PACKAGE_ID && isPhoneLimitToolId(candidate.tool.id)).length
        : 15 + options.candidates.candidates
        .filter(candidate => candidate.tool.packageId === 'proactive_contact' || isBodySignalHistoryTool(candidate.tool.id)
          || options.candidates.wishPackageEntry && isWishToolId(candidate.tool.id)
          || options.candidates.giftPackageEntry && isGiftToolId(candidate.tool.id)
          || RESEARCH_CHAT_TOOL_IDS.includes(candidate.tool.id)
          || options.candidates.desktopReminderTools && isReminderChatTool(candidate.tool.id)
          || candidate.tool.id === BROWSER_OPEN_TOOL_ID
          || candidate.tool.id === 'camera.read_observations'
          || ['schedule.query_routine', 'schedule.save_routine'].includes(candidate.tool.id)
          || options.candidates.readingReferenceTools && ['reading.read_material', 'schedule.save_own'].includes(candidate.tool.id)).length,
      hostOnlyAllowedToolIds: options.hostOnlyAllowedToolIds,
      isToolAvailableForRequest: options.isToolAvailableForRequest,
      allowPostMemoryMusic: options.allowPostMemoryMusic === true && !proactiveLiteResponse,
      turn,
      initialCandidates: initialPolicy.nativeToolsEnabled
        ? options.candidates.candidates
        : [],
      packageDiscovery: initialPolicy.nativeToolsEnabled
        ? options.candidates.packageDiscovery
        : undefined,
      executeInvocation: options.executeInvocation,
      projectResultForModel: options.projectResultForModel,
      resolvePackageDiscovery: options.resolvePackageDiscovery,
      prepareInvocation: options.prepareInvocation,
      resolveInvocationGate: options.resolveInvocationGate,
      reconfirmMemoryCorrection: options.reconfirmMemoryCorrection,
      executionAttemptJournal: options.executionAttemptJournal
        ?? localToolExecutionAttemptJournal,
      pendingExecutionRegistry: options.pendingExecutionRegistry
        ?? providerPendingExecutionRegistry,
      enforceAgentEpochSafety: true,
      onSettlement: options.onSettlement,
      completeWithVisibleCard: options.completeWithVisibleCard
        ? results => options.completeWithVisibleCard!(results, lastCompletion?.theaterBackstage) : undefined,
      onLateSettlement: options.onLateSettlement,
      resolveExecutionPolicy: options.resolveExecutionPolicy,
      emptyResponseRetryInstruction: options.emptyResponseRetryInstruction,
      allowEmptyResponseRetry: options.allowEmptyResponseRetry,
      bodyOnlyRetry: options.bodyOnlyRetry,
      requireToolCallForCandidates: options.requireToolCallForCandidates,
      finalDayPlanRepair: options.finalDayPlanRepair,
      allowFinalDraftCorrection: Platform.OS === 'windows' && options.chatOptions.contextSource === 'chat.main'
        && options.chatOptions.fixedEnvelopeMode === 'desktop-reminder-draft'
        && options.finalDayPlanRepair?.allowed === true && !!options.reminderDraftContract,
      reminderDraftContract: options.reminderDraftContract,
      requestModel: requestCompletion,
      requestProtocolCorrection: options.allowProtocolCorrection === false || options.bodyOnlyRetry ? undefined : async (request) => {
        const pairableMessages = pairableProtocolCorrectionMessages(
          request.previousTurn,
          request.failure,
        );
        const desktopDraftReplyFailure = Platform.OS === 'windows'
          && options.chatOptions.fixedEnvelopeMode === 'desktop-reminder-draft'
          && options.chatOptions.contextSource === 'chat.main'
          && !!options.reminderDraftContract && request.failure.code === 'INVALID_REPLY_FORMAT'
          && request.failure.rawToolCallCount === 0
          && request.failure.replyFormatReason === 'reminder_action_contract_missing';
        const numericRootCorrection = desktopDraftReplyFailure
          && request.failure.reminderVisibleReplySource === 'direct_content'
          && request.failure.reminderActionIssue === 'action_missing'
          && request.failure.reminderActionDirectIssue === 'root_invalid'
          && request.failure.reminderActionDirectRootFailure?.kind === 'non_object_root'
          && request.failure.reminderActionDirectRootFailure.rootType === 'number';
        const correctionInstruction = numericRootCorrection ? DESKTOP_FIXED_OBJECT_CORRECTION_INSTRUCTION
          : desktopDraftReplyFailure && request.failure.reminderActionIssue === 'action_missing'
            ? DESKTOP_REMINDER_ACTION_CORRECTION_INSTRUCTION : TOOL_AGENT_PROTOCOL_CORRECTION_INSTRUCTION;
        return requestCompletion({
          allowTools: request.allowTools,
          completedResults: request.completedResults,
          continuationMessages: pairableMessages
            ? [...request.continuationMessages, ...pairableMessages]
            : request.continuationMessages,
          requestKind: request.requestKind,
          responseInstruction: request.responseInstruction,
          signal: request.signal,
          toolChoice: request.toolChoice,
          toolRound: request.toolRound,
          tools: request.tools,
        }, appendResponseInstruction(
          options.chatOptions.responseInstruction,
          correctionInstruction,
        ), false, 'protocol_correction');
      },
      selectFollowUpCandidates: (results) => {
        currentCandidates = options.selectFollowUpCandidates
          ? options.selectFollowUpCandidates(currentCandidates, results)
          : selectFollowUpToolCandidates(currentCandidates, results);
        return initialPolicy.nativeToolsEnabled ? currentCandidates.candidates : [];
      },
    });
  } finally {
    externalSignal?.removeEventListener('abort', cancelFromExternalSignal);
    if (ownsTurnController) turnController.dispose();
  }
  // Partial or failed requests cannot establish a complete whole-turn cache total.
  if (aggregateUsage && !cachedUsageComplete) aggregateUsage.cachedPromptTokens = undefined;
  if (loopResult.state.status === 'cancelled') {
    return {
      ...loopResult,
      contents: [],
      diagnostics: {
        jsonOutputRequested: false,
        rawContent: '',
        rawContentChars: 0,
        rawContentFormat: 'empty' as const,
        recoveredFromReasoning: false,
        responseEnvelopeMode: proactiveLiteResponse ? 'messages_only' as const : 'messages_with_semantic' as const,
        semanticPrefixCompletionRequested: false,
        toolCallCount: 0,
        wasTruncated: false,
      },
      candidates: options.candidates,
      providerCapabilities: capabilities,
      rawEnvelopeForSemanticParsing: undefined,
      semanticEnvelopeProtocol: proactiveLiteResponse ? 'legacy_tagged' as const : 'single_root_json' as const,
      usage: aggregateUsage,
    };
  }
  if (!lastCompletion) {
    throw new Error('工具代理没有收到模型结果');
  }
  const diagnostics = { ...lastCompletion.diagnostics, usage: aggregateUsage };
  // Object spread omits the provider's non-enumerable, in-memory review payload.
  const directDescriptor = Object.getOwnPropertyDescriptor(lastCompletion.diagnostics, 'fixedEnvelopeRawDirect');
  if (directDescriptor) Object.defineProperty(diagnostics, 'fixedEnvelopeRawDirect', directDescriptor);
  return {
    ...loopResult,
    contents: loopResult.completedWithVisibleCard || loopResult.protocolFailure ? [] : lastCompletion.contents,
    diagnostics,
    candidates: options.candidates,
    providerCapabilities: capabilities,
    rawEnvelopeForSemanticParsing: lastCompletion.rawEnvelopeForSemanticParsing,
    theaterBackstage: lastCompletion.theaterBackstage,
    semanticEnvelopeProtocol: lastCompletion.diagnostics.semanticEnvelopeProtocol
      ?? (proactiveLiteResponse ? 'legacy_tagged' : 'single_root_json'),
    usage: aggregateUsage,
  };
}
