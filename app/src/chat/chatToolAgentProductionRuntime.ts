import { Platform } from 'react-native';
import {
  runOpenAiCompatibleToolAgentTurn,
  type RunOpenAiCompatibleToolAgentTurnOptions,
} from '../ai/toolAgentProvider';
import {
  executeNativeChatToolInvocation,
  getToolDefinition,
  promptForToolPermission,
  recordToolAgentAuditMetadata,
  recordToolAgentAuditStatus,
  recordToolCallRequested,
  recordToolPermissionDecision,
  resolveNativeChatToolInvocationGate,
  selectProductionChatToolAgentCandidates,
  createToolAgentGateRejectedResult,
  createToolAgentHostCallId,
  constrainWeatherMapNearbyInvocationInput,
  createWeatherMapNearbySingleInvocationGuard,
  createWeatherMapNearbyInputRequiredResult,
  isWeatherMapNearbyAgentToolId,
  parseMapSearchNearbyInputFromText,
  projectWeatherMapNearbyResultForModel,
  resolveWeatherMapNearbyPendingInput,
  type JunLuoToolAgentInvocationExecutionContext,
  type JunLuoToolAgentTurnController,
  type JunLuoToolCandidateMessage,
  type JunLuoToolCandidateSelection,
  type JunLuoToolInvocation,
  type JunLuoToolResult,
  type WeatherMapNearbyIntentEvidence,
  type WeatherMapNearbyPendingInput,
} from '../tools';
import type { ChatModelRequestBudget } from './chatModelRequestBudget';
import {
  createToolAgentConfirmationCard,
  createToolAgentPermissionCard,
  createToolAgentResultCard as createUnprojectedToolAgentResultCard,
} from './toolAgentCardDelivery';
import type { JunLuoToolCallCard } from './toolCallMessageTypes';
import { createMemoryCorrectionTurnBinding, memoryCorrectionPresentation, MEMORY_CORRECTION_EDITABLE_HASH, MEMORY_CORRECTION_VERSION } from '../tools/memoryCorrection';
import { weeklyTargetHash } from '../memory/memoryWeeklyBasis';
import { chatMusicSearchKeyword, type MusicAgentPreferenceSnapshot } from '../tools/musicAgentPolicy';
import { MUSIC_PLAYBACK_INTENT_SIDE_EFFECT_GATE_POLICY_ID, CAMERA_STANDBY_SIDE_EFFECT_GATE_POLICY_ID, SLEEP_CHAT_WINDOW_SIDE_EFFECT_GATE_POLICY_ID } from '../tools/toolAgentSideEffectGatePolicy';
import type { ChatSleepScheduleHost } from './chatSleepSchedule';
import { prepareCameraModelObservationHost } from '../camera/cameraModelObservationRuntime';
import { CAMERA_LOOK_ONCE_TOOL_ID } from '../camera/cameraModelObservationMaterials';
import { createCameraReplyContinuation, recordCameraObservationReply } from '../camera/cameraModelObservationReply';
import type { SubjectiveMessage, TheaterBackstageMessageSource } from '../ai/subjectiveMessages';
import type { OpenAiCompatibleContinuationMessage } from '../ai/openAiCompatibleProvider';
import { createToolErrorResult } from '../tools/toolResult';
import { createToolError } from '../tools/toolErrors';
import { projectMusicAgentResultForModel } from '../tools/musicAgentModelResultProjector';
import { projectResearchChatResult } from '../tools/researchChatTools';
import { BROWSER_OPEN_TOOL_ID, projectBrowserOpenResult } from '../tools/browserChatTool';
import { BROWSER_OPEN_SIDE_EFFECT_GATE_POLICY_ID } from '../tools/toolAgentSideEffectGatePolicy';
import { createMemoryReadTurn, type MemoryReadTurn } from '../tools/memoryReadTurn';
import { createMapSearchChatHost } from '../tools/mapSearchChatHost';
import { markMapSearchResultsDelivered } from '../tools/mapSearchSession';
import { MAP_QUERY_SIDE_EFFECT_GATE_POLICY_ID, MAP_QUERY_STATE_TOOL_IDS } from '../tools/toolAgentSideEffectGatePolicy';
import type { MemoryReadReference } from '../memory/memoryReadReference';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { createReadingControlTurn } from '../tools/readingControlTurn';
import { createReadingMaterialTurn } from '../tools/readingMaterialTurn';
import type { ReadingMessageSource } from './chatReadingReferences';
import { createOwnScheduleTurn } from '../tools/ownScheduleTurn';
import { createUserRoutineTurn } from '../tools/userRoutineTurn';
import { OWN_SCHEDULE_SIDE_EFFECT_GATE_POLICY_ID, READING_ACTIVITY_SIDE_EFFECT_GATE_POLICY_ID, CONTACT_CHAT_SIDE_EFFECT_GATE_POLICY_ID, WISH_SIDE_EFFECT_GATE_POLICY_ID } from '../tools/toolAgentSideEffectGatePolicy';
import { createContactManagementTurn } from '../proactive/contactManagement';
import { createWishToolTurn } from '../wishPool/wishToolTurn';
import { isWishToolId, WISH_TOOL_SUMMARIES } from '../wishPool/wishToolContract';
import { isGiftToolId, projectGiftToolCardResult } from '../gifts/giftToolContract';
import { createGiftToolTurn } from '../gifts/giftToolTurn';
import { GIFT_SIDE_EFFECT_GATE_POLICY_ID } from '../tools/toolAgentSideEffectGatePolicy';
import { createToolSuccessResult } from '../tools/toolResult';
import { isTextFileChatTool, projectTextFileResult, TEXT_FILE_WRITE_TOOL_IDS } from '../tools/textFileChatTools';
import { TEXT_FILE_CHAT_SIDE_EFFECT_GATE_POLICY_ID } from '../tools/toolAgentSideEffectGatePolicy';
import { createTextFileChatHost } from '../tools/textFileChatHost';
import { prepareChatImageTurn } from './chatImageTurn';
import { CHAT_IMAGE_TOOL_ID, projectChatImageResult } from './chatImageMaterials';
import { CHAT_IMAGE_SIDE_EFFECT_GATE_POLICY_ID } from '../tools/toolAgentSideEffectGatePolicy';
import { CHAT_SCHEDULE_SIDE_EFFECT_GATE_POLICY_ID } from '../tools/toolAgentSideEffectGatePolicy';
import { createChatScheduleTurn, CHAT_SCHEDULE_COMPLETION_TOOLS } from '../schedule/chatScheduleTurn';
import { chatReminderInstruction, sameReminderCandidates, type ChatReminderBatch } from '../schedule/chatScheduleReminders';
import { createExpenseChatHost } from '../tools/expenseChatHost';
import { createReminderChatHost } from '../tools/chatReminderHost';
import { isReminderPlanSourceCurrent, type ChatReminderPlanCard } from './chatReminderPlan';
import { DESKTOP_REMINDER_DRAFT_CONTINUATION_INSTRUCTION } from '../ai/behavior/actionChatSemantic';
import { checkToolPermission } from '../tools/toolPermissions';
import { createAppLaunchChatHost, type AppLaunchPicker } from '../tools/appLaunchChatHost';
import { createDialerChatHost, type DialerPicker } from '../tools/dialerChatHost';
import { createBackendOverviewChatHost } from '../tools/backendOverviewChatHost';
import { BACKEND_OVERVIEW_TOOL_ID, BACKEND_OVERVIEW_TOOL_NAME, projectBackendOverviewResult, invalidateBackendOverviewReplay } from '../tools/chatBackendOverview';
import { DIALER_TOOL_ID, projectDialerResult, type DialerOpportunity } from '../tools/chatDialer';
import { DIALER_SIDE_EFFECT_GATE_POLICY_ID } from '../tools/toolAgentSideEffectGatePolicy';
import { APP_LAUNCH_TOOL_ID, projectAppLaunchResult, type AppLaunchOpportunity } from '../tools/chatAppLaunch';
import { APP_LAUNCH_SIDE_EFFECT_GATE_POLICY_ID } from '../tools/toolAgentSideEffectGatePolicy';
import type { ChatExpensePlanCard } from './chatExpensePlan';
import { createPhoneLimitToolTurn } from '../tools/phoneLimitToolTurn';
import { isPhoneLimitToolId } from '../tools/phoneLimitContract';
import { phoneLimitDiscoveryAttachment, serializePhoneLimitDiscoveryResult } from '../tools/phoneLimitModelResult';
import { PHONE_LIMIT_SIDE_EFFECT_GATE_POLICY_ID } from '../tools/toolAgentSideEffectGatePolicy';
import { TOOL_AGENT_MAX_MODEL_RESULT_CHARACTERS } from '../tools/toolAgentLoop';

const createToolAgentResultCard: typeof createUnprojectedToolAgentResultCard = input =>
  createUnprojectedToolAgentResultCard({ ...input, result: projectGiftToolCardResult(input.result) });

type ToolAgentTurnResult = Awaited<ReturnType<typeof runOpenAiCompatibleToolAgentTurn>>;

export type ChatToolAgentCardDelivery = (
  card: JunLuoToolCallCard,
  metadata: { late: boolean; existingImageCardId?: string },
) => void | boolean | Promise<void | boolean>;

export type RunProductionChatToolAgentInput = {
  disableCameraObservation?: boolean;
  appLaunchOpportunity?: AppLaunchOpportunity;
  dialerOpportunity?: DialerOpportunity;
  dialerPicker?: DialerPicker;
  dialerIsForeground?: () => boolean;
  appLaunchPicker?: AppLaunchPicker;
  appLaunchIsForeground?: () => boolean;
  readingSources?: readonly ReadingMessageSource[];
  imageSourceMessages?: readonly SubjectiveMessage[];
  scheduleVersions?: Record<string, number>;
  sourceMessage?: Pick<SubjectiveMessage, 'id' | 'role' | 'content' | 'createdAt' | 'replyTo'>;
  mapConsentSources?: { messages: readonly import('../ai/behavior/chatCareUpdates').CareSourceMessage[]; newMessageIds: readonly string[] };
  resumeCompletedTools?: RunOpenAiCompatibleToolAgentTurnOptions['bodyOnlyRetry'];
  onDiagnosticToolEvent?: RunOpenAiCompatibleToolAgentTurnOptions['onDiagnosticToolEvent'];
  onDiagnosticContinuationFailure?: (error: unknown, stage: 'provider_request' | 'session_persist') => void;
  sleepScheduleHost?: ChatSleepScheduleHost;
  isReplyCurrent?: () => Promise<boolean>;
  isReminderDraftSourceCurrent?: () => Promise<boolean>;
  isReplyActive?: () => boolean;
  onImageSaved?: (messageId: string, image: import('../ai/subjectiveMessages').MessageImage) => void;
  onImageSourceCheck?: (check: () => Promise<boolean>) => void;
  onImageContext?: (host: NonNullable<Awaited<ReturnType<typeof prepareChatImageTurn>>>) => void;
  onScheduleReminders?: (batch: ChatReminderBatch | undefined) => void;
  memoryMentionItems?: readonly MemoryReadReference[];
  visibleMemoryIds?: ReadonlySet<string>;
  onMemorySent?: (items: readonly MemoryReadReference[], visible: ReadonlySet<string>) => void;
  sourceMessageId: string;
  sourceSessionId: string;
  dataEpoch: number;
  youText: string;
  recentMessages: readonly JunLuoToolCandidateMessage[];
  chatOptions: RunOpenAiCompatibleToolAgentTurnOptions['chatOptions'];
  turnController: JunLuoToolAgentTurnController;
  requestBudget: ChatModelRequestBudget;
  deliverCard?: ChatToolAgentCardDelivery;
  deliverDayPlan?: (result: JunLuoToolResult, source?: TheaterBackstageMessageSource) => Promise<void>;
  deliverExpensePlan?: (card: ChatExpensePlanCard) => Promise<void>;
  deliverReminderPlan?: (card: ChatReminderPlanCard, requireNewCard?: boolean) => Promise<string | void>;
  musicPreferences?: MusicAgentPreferenceSnapshot;
  deliverMusic?: (invocation: JunLuoToolInvocation, result: JunLuoToolResult, auditId: string) => Promise<boolean>;
  cameraReplyCurrent?: () => Promise<boolean>;
  cameraReplyMessages?: () => Promise<SubjectiveMessage[]>;
  deliverCameraContinuation?: (contents: string[], result?: JunLuoToolResult) => Promise<SubjectiveMessage[]>;
};

export type RunProductionChatToolAgentDependencies = {
  createBackendOverviewHost?: typeof createBackendOverviewChatHost;
  createAppLaunchHost?: typeof createAppLaunchChatHost;
  createDialerHost?: typeof createDialerChatHost;
  selectCandidates?: typeof selectProductionChatToolAgentCandidates;
  runTurn?: typeof runOpenAiCompatibleToolAgentTurn;
  resolveGate?: typeof resolveNativeChatToolInvocationGate;
  executeInvocation?: typeof executeNativeChatToolInvocation;
  prepareCameraHost?: typeof prepareCameraModelObservationHost;
};

export type ProductionChatToolAgentResult =
  | {
      handled: false;
      selection: JunLuoToolCandidateSelection;
      shadowCandidateToolIds: string[];
    }
  | {
      handled: true;
      selection: JunLuoToolCandidateSelection;
      shadowCandidateToolIds: string[];
      turn: ToolAgentTurnResult;
      phoneLimitDiscoveryResults?: JunLuoToolResult[];
      phoneLimitReplyContinuationMessages?: OpenAiCompatibleContinuationMessage[];
      cameraBodyCommitted?: () => Promise<void>;
      memoryRead?: MemoryReadTurn;
    };

const WEATHER_MAP_PENDING_INPUT_TTL_MS = 15 * 60 * 1000;
const weatherMapPendingInputs = new Map<string, WeatherMapNearbyPendingInput>();

export function clearWeatherMapNearbyPendingInputsForTests() {
  weatherMapPendingInputs.clear();
}

export function listWeatherMapNearbyPendingInputsForTests() {
  return [...weatherMapPendingInputs.values()].map((pending) => ({ ...pending }));
}

function permissionPromptWithAbort(
  toolId: string,
  call: Parameters<typeof promptForToolPermission>[1],
  signal: AbortSignal,
) {
  const tool = getToolDefinition(toolId);
  if (!tool || signal.aborted) return Promise.resolve('cancelled' as const);
  return new Promise<'allowed' | 'cancelled'>((resolve) => {
    let settled = false;
    const finish = (decision: 'allowed' | 'cancelled') => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(decision);
    };
    const abort = () => finish('cancelled');
    signal.addEventListener('abort', abort, { once: true });
    void promptForToolPermission(tool, isGiftToolId(toolId) ? { ...call, input: {} } : call).then(finish, () => finish('cancelled'));
  });
}

/** Read candidate schemas only; no turn, execution, permission prompt or model is started. */
export async function prepareProductionChatToolCandidates(
  input: Pick<RunProductionChatToolAgentInput, 'disableCameraObservation' | 'youText' | 'recentMessages' | 'dataEpoch' | 'sourceMessageId' | 'sourceSessionId' | 'musicPreferences' | 'sleepScheduleHost' | 'readingSources' | 'imageSourceMessages' | 'appLaunchOpportunity' | 'dialerOpportunity'> & { chatOptions: Pick<RunProductionChatToolAgentInput['chatOptions'], 'signal' | 'messages'>; readOnly?: boolean },
  dependencies: RunProductionChatToolAgentDependencies = {},
) {
  const readingSources = input.readingSources?.filter(source => input.chatOptions.messages.some(message => message.id === source.messageId && message.role === 'you' && message.readingReference?.readingId === source.readingId));
  const hasReadingReferences = !!readingSources?.length;
  const pendingFollowUp = resolvePendingWeatherMapNearbyFollowUp(input, input.readOnly);
  const sleepHost = input.sleepScheduleHost && await input.sleepScheduleHost.available() ? input.sleepScheduleHost : undefined;
  const sleepReservation = sleepHost?.addCandidate({ candidates: [], tools: [], executableTools: [],
    discoveryToolIds: [], truncated: false, reasons: [], packages: [], mode: 'chat_only', serializedCharacterCount: 0 });
  const imageHost = await prepareChatImageTurn({ ...input, messages: (input.imageSourceMessages ?? input.chatOptions.messages)
    .filter(message => input.chatOptions.messages.some(selected => selected.id === message.id)),
    signal: input.chatOptions.signal });
  const selected = await (dependencies.selectCandidates ?? selectProductionChatToolAgentCandidates)({
    dataEpoch: input.dataEpoch,
    youText: input.youText,
    recentMessages: input.recentMessages,
    allowProactive: false,
    includeAppLaunch: !input.readOnly && input.appLaunchOpportunity?.sourceMessageId === input.sourceMessageId && input.appLaunchOpportunity.available(),
    includeDialer: !input.readOnly && input.dialerOpportunity?.sourceMessageId === input.sourceMessageId && input.dialerOpportunity.available(),
    weatherMapNearbyFollowUp: pendingFollowUp,
    musicPreferences: input.musicPreferences,
    includeReadingReference: hasReadingReferences,
    ...(sleepReservation || imageHost ? { maxTools: 15 - (sleepReservation ? 1 : 0) - (imageHost ? 1 : 0),
      maxSerializedCharacters: 8000 - (sleepReservation?.serializedCharacterCount ?? 0) - (imageHost ? 500 : 0) } : {}),
  });
  if (sleepHost && await sleepHost.available()) selected.selection = sleepHost.addCandidate(selected.selection);
  if (imageHost) selected.selection = imageHost.addCandidate(selected.selection);
  const cameraHost = input.disableCameraObservation ? undefined : await (dependencies.prepareCameraHost ?? prepareCameraModelObservationHost)({
    entry: 'chat_reply', sourceMessageId: input.sourceMessageId, sourceSessionId: input.sourceSessionId, dataEpoch: input.dataEpoch,
    readOnly: input.readOnly,
    signal: input.chatOptions.signal,
  });
  if (cameraHost) selected.selection = cameraHost.addCandidate(selected.selection);
  return { selected, sleepHost, cameraHost, imageHost, readingSources, hasReadingReferences };
}

export function withChatReadingReferenceInstruction(chatOptions: RunProductionChatToolAgentInput['chatOptions'], hasReadingReferences: boolean) {
  return { ...chatOptions, responseInstruction: [chatOptions.responseInstruction,
    hasReadingReferences ? 'I 要开始或安排自己的阅读时，用「记下日程」保存这场安排，readingId 填阅读卡片里的作品编号。' : ''].filter(Boolean).join('\n\n') };
}

export async function runProductionChatToolAgent(
  input: RunProductionChatToolAgentInput,
  dependencies: RunProductionChatToolAgentDependencies = {},
): Promise<ProductionChatToolAgentResult> {
  const { selected, sleepHost, cameraHost, imageHost, readingSources, hasReadingReferences } = await prepareProductionChatToolCandidates(input, dependencies);
  if (imageHost) {
    imageHost.setCallbacks(input.isReplyCurrent, input.onImageSaved);
    await imageHost.prepareFirst();
    input.onImageContext?.(imageHost);
    input.onImageSourceCheck?.(() => imageHost.checkSources());
  }
  if (selected.selection.mode === 'chat_only' && !input.resumeCompletedTools) {
    return {
      handled: false,
      selection: selected.selection,
      shadowCandidateToolIds: selected.shadow.candidateToolIds,
    };
  }

  const candidateByToolId = new Map(
    selected.selection.candidates.map((candidate) => [candidate.tool.id, candidate]),
  );
  const candidateForToolId = (toolId: string) => candidateByToolId.get(toolId);
  const expandedWeatherToolIds = new Set<string>();
  const visibleAuditIds = new Set<string>();
  const savedFileCards = new Set<string>();
  const savedImageCards = new Set<string>();
  const recordedAuditIds = new Set<string>();
  const roundByCallId = new Map<string, 1 | 2 | 3>();
  const settledResults = new Map<string, JunLuoToolResult>();
  const scheduleHost = await createChatScheduleTurn({ ...input, signal: input.chatOptions.signal, isCurrent: input.isReplyCurrent });
  const fileHost = await createTextFileChatHost({ ...input, messages: input.chatOptions.messages, signal: input.chatOptions.signal,
    isExecuting: () => input.turnController.getSnapshot()?.status === 'executing' });
  let failedMapOperation: JunLuoToolResult | undefined;
  let reminderPlanTurn = false;
  let otherPlanTurn = false;
  const lateCameraCallIds = new Set<string>();
  const correctionMessages = input.chatOptions.messages.filter(message => message.id === input.sourceMessageId && message.role === 'you');
  const proactiveContact = createContactManagementTurn({ sessionId: input.sourceSessionId,
    message: correctionMessages.length === 1 ? correctionMessages[0] : undefined,
    dataEpoch: input.dataEpoch, signal: input.chatOptions.signal, isCurrent: input.isReplyCurrent });
  const memoryCorrection = createMemoryCorrectionTurnBinding({
    sessionId: input.sourceSessionId,
    message: correctionMessages.length === 1 ? correctionMessages[0] : undefined,
  });
  const memoryRead = createMemoryReadTurn({ references: input.memoryMentionItems,
    canRead: () => !input.chatOptions.signal?.aborted && canCommitBackupRestoreDataEpoch(input.dataEpoch) });
  const expenseHost = createExpenseChatHost({ source: input.sourceMessage?.role === 'you'
    && input.sourceMessage.id === input.sourceMessageId ? { sessionId: input.sourceSessionId,
      messageId: input.sourceMessageId, content: input.sourceMessage.content, createdAt: input.sourceMessage.createdAt } : undefined,
    dataEpoch: input.dataEpoch, signal: input.chatOptions.signal, isCurrent: input.isReplyCurrent,
    remainingRequests: () => input.requestBudget.getSnapshot().remaining });
  let reminderDraftRequired = false;
  let reminderCardDelivered = false;
  const reminderDraftCurrent = async () => {
    if (!input.isReminderDraftSourceCurrent || input.isReplyCurrent && !await input.isReplyCurrent()) return false;
    if (!await input.isReminderDraftSourceCurrent()) return false;
    return !input.chatOptions.signal?.aborted && canCommitBackupRestoreDataEpoch(input.dataEpoch)
      && (!input.isReplyActive || input.isReplyActive());
  };
  const reminderHost = createReminderChatHost({ source: input.sourceMessage?.role === 'you'
    && input.sourceMessage.id === input.sourceMessageId ? { sessionId: input.sourceSessionId,
      messageId: input.sourceMessageId, content: input.sourceMessage.content, createdAt: input.sourceMessage.createdAt } : undefined,
    dataEpoch: input.dataEpoch, signal: input.chatOptions.signal,
    isCurrent: () => reminderDraftRequired ? reminderDraftCurrent() : input.isReplyCurrent?.() ?? Promise.resolve(true),
    remainingRequests: () => input.requestBudget.getSnapshot().remaining,
    allowFinalCreate: () => reminderDraftRequired });
  let preparedMemoryResults: import('../ai/openAiCompatibleProvider').OpenAiCompatibleContinuationMessage[] | undefined;
  const mapSearch = createMapSearchChatHost({ ...input, signal: input.chatOptions.signal,
    sources: input.mapConsentSources });
  const appLaunchHost = (dependencies.createAppLaunchHost ?? createAppLaunchChatHost)({ ...input,
    signal: input.chatOptions.signal, opportunity: input.appLaunchOpportunity, pick: input.appLaunchPicker,
    isChatForeground: input.appLaunchIsForeground });
  const dialerHost = (dependencies.createDialerHost ?? createDialerChatHost)({ ...input,
    signal: input.chatOptions.signal, opportunity: input.dialerOpportunity, pick: input.dialerPicker,
    isChatForeground: input.dialerIsForeground });
  const backendOverviewHost = (dependencies.createBackendOverviewHost ?? createBackendOverviewChatHost)({ ...input,
    signal: input.chatOptions.signal });
  let backendOverviewExpanded = false;
  let dialerStatusSave = Promise.resolve();
  const readingControl = candidateByToolId.has('reading.control')
    || selected.selection.packageDiscovery?.catalogPackageIds.includes('reading')
    ? await createReadingControlTurn({ dataEpoch: input.dataEpoch, signal: input.chatOptions.signal })
    : null;
  const readingMaterial = createReadingMaterialTurn({ sessionId: input.sourceSessionId, sources: readingSources ?? [],
    dataEpoch: input.dataEpoch, signal: input.chatOptions.signal, isCurrent: input.isReplyCurrent });
  // Load the host lazily only when a schedule tool actually executes, not on every chat.
  let ownScheduleHost: Awaited<ReturnType<typeof createOwnScheduleTurn>> | undefined;
  const phoneLimit = createPhoneLimitToolTurn({ dataEpoch: input.dataEpoch, sourceMessageId: input.sourceMessageId,
    signal: input.chatOptions.signal, isCurrent: input.isReplyCurrent });
  const userRoutine = createUserRoutineTurn({ dataEpoch: input.dataEpoch, signal: input.chatOptions.signal,
    sourceMessage: input.sourceMessage,
    sourceMessageId: input.sourceMessageId, sourceSessionId: input.sourceSessionId, isCurrent: input.isReplyCurrent });
  const ownSchedule = async (call: import('../tools/toolTypes').JunLuoToolCall) => {
    ownScheduleHost ??= await createOwnScheduleTurn({ dataEpoch: input.dataEpoch, signal: input.chatOptions.signal,
      scheduleVersions: input.scheduleVersions,
      readingSources: hasReadingReferences ? [...readingSources!] : undefined,
      sourceMessageId: input.sourceMessageId, sourceSessionId: input.sourceSessionId, isCurrent: input.isReplyCurrent });
    return ownScheduleHost.execute(call);
  };
  const musicAuditIds = new Set<string>();
  let musicRequested = false;
  const deliverMusic = async (invocation: JunLuoToolInvocation, result: JunLuoToolResult) => {
    if (invocation.toolId !== 'music.play' || !input.deliverMusic) return;
    const auditId = createToolAgentHostCallId(input.sourceMessageId, invocation.callId);
    if (await input.deliverMusic(invocation, result, auditId)) musicAuditIds.add(auditId);
  };
  const acceptWeatherMapNearbyInvocation = createWeatherMapNearbySingleInvocationGuard();
  const wishProviderCallIds = new Map<string, string>();
  const correctionDrafts = new Map<string, Readonly<Record<string, unknown>>>();
  const correctionRetryRoots = new Map<string, string>();
  let correctionRetryNumber = 0;
  const deliver = async (card: JunLuoToolCallCard, late = false) => {
    if (isGiftToolId(card.toolId)) card = { ...card, inputPreview: {}, confirmationPresentation: undefined };
    if (card.toolId === BACKEND_OVERVIEW_TOOL_ID && !await backendOverviewHost.isCurrent()) return false;
    if (card.toolId === APP_LAUNCH_TOOL_ID && !await appLaunchHost.isSourceCurrent()) return false;
    if (card.toolId === DIALER_TOOL_ID && !await dialerHost.isSourceCurrent()) return false;
    const fileCard = isTextFileChatTool(card.toolId);
    const identity = card.auditId ?? card.callId;
    if (card.toolId === CHAT_IMAGE_TOOL_ID) {
      if (!imageHost || !await imageHost.checkSources()) return false;
      if (savedImageCards.has(identity)) {
        const { loadChatSessionMessage } = await import('./chatStorage');
        if (!await loadChatSessionMessage(input.sourceSessionId, `image-card-${identity}`)) return false;
      }
    }
    if (fileCard) {
      if (input.isReplyCurrent && !await input.isReplyCurrent()) return false;
      if (!canCommitBackupRestoreDataEpoch(input.dataEpoch)) return false;
      if (savedFileCards.has(identity)) {
        const { loadChatSessionMessage } = await import('./chatStorage');
        if (!await loadChatSessionMessage(input.sourceSessionId, `file-card-${identity}`)) return false;
      }
    }
    visibleAuditIds.add(card.auditId ?? card.callId);
    if (musicAuditIds.has(card.auditId ?? card.callId)) return;
    let visibleCard = card.toolId === CHAT_IMAGE_TOOL_ID ? { ...card, toolName: '再看图片' } : card;
    if (card.toolId === BACKEND_OVERVIEW_TOOL_ID) visibleCard = { ...visibleCard, toolName: BACKEND_OVERVIEW_TOOL_NAME };
    if (card.toolId === 'memory.update' && card.providerCallId) {
      const draft = correctionDrafts.get(card.providerCallId);
      const original = draft && memoryCorrection.original(draft.memoryId);
      if (draft && original && ['running', 'error', 'success'].includes(card.status)) {
        const presentation = memoryCorrectionPresentation(original, draft);
        visibleCard = { ...visibleCard, confirmationPresentation: card.status === 'success'
          ? { ...presentation, fields: presentation.fields.filter(field => !field.label.startsWith('原')) }
          : presentation };
      }
      const root = correctionRetryRoots.get(card.providerCallId);
      if (root) {
        const auditId = createToolAgentHostCallId(input.sourceMessageId, root);
        visibleCard = { ...visibleCard, callId: auditId, auditId, providerCallId: root };
      }
      if (card.status === 'awaiting_confirmation') visibleCard = {
        ...visibleCard, resultSummary: undefined, errorMessage: undefined, finishedAt: undefined,
      };
    }
    const delivered = await input.deliverCard?.(visibleCard, { late,
      ...(card.toolId === CHAT_IMAGE_TOOL_ID && savedImageCards.has(identity) ? { existingImageCardId: `image-card-${identity}` } : {}) });
    if (fileCard && delivered === true) savedFileCards.add(identity);
    if (card.toolId === CHAT_IMAGE_TOOL_ID && delivered === true) savedImageCards.add(identity);
    return delivered;
  };
  const wishPool = createWishToolTurn({ dataEpoch: input.dataEpoch, signal: input.chatOptions.signal,
    sourceMessageId: input.sourceMessageId, sourceSessionId: input.sourceSessionId, isCurrent: input.isReplyCurrent,
    deliverInvitation: async (call, wish) => {
      const card = createToolAgentResultCard({ auditId: call.callId, providerCallId: wishProviderCallIds.get(call.callId) ?? call.callId,
        result: createToolSuccessResult(call, WISH_TOOL_SUMMARIES.invited) });
      card.inputPreview = { wishId: wish.id, purpose: String(call.input.purpose), content: wish.content };
      return await deliver(card) === true;
    } });
  const giftCabinet = createGiftToolTurn({ dataEpoch: input.dataEpoch, signal: input.chatOptions.signal,
    isCurrent: input.isReplyCurrent });
  const ensureGateAudit = async (
    invocation: JunLuoToolInvocation,
    context: Omit<JunLuoToolAgentInvocationExecutionContext, 'gateReceipt'>,
  ) => {
    const auditId = createToolAgentHostCallId(context.turnId, context.providerCallId);
    if (recordedAuditIds.has(auditId)) return auditId;
    const candidate = candidateForToolId(invocation.toolId);
    await recordToolCallRequested({
      callId: auditId,
      toolId: invocation.toolId,
      input: isGiftToolId(invocation.toolId) ? {} : invocation.input,
      requestedBy: 'chat',
      createdAt: Date.now(),
      sourceMessageId: context.sourceMessageId,
    }, `tool-agent:${auditId}`, {
      auditId,
      turnId: context.turnId,
      providerCallId: context.providerCallId,
      toolRound: context.round,
      candidateSource: candidate?.source,
      authorityKind: candidate?.authority?.kind,
      dataEpoch: context.dataEpoch,
    });
    recordedAuditIds.add(auditId);
    return auditId;
  };

  const resolveGate = dependencies.resolveGate ?? resolveNativeChatToolInvocationGate;
  const executeInvocation = dependencies.executeInvocation ?? executeNativeChatToolInvocation;
  const cameraContinuation = createCameraReplyContinuation({
    current: async () => !input.chatOptions.signal?.aborted && !!await input.cameraReplyCurrent?.(),
    delivered: async () => await input.cameraReplyMessages?.() ?? [],
    continue: async (event, instruction) => {
      let diagnosticStage: 'provider_request' | 'session_persist' = 'provider_request';
      try {
      const continued = await (dependencies.runTurn ?? runOpenAiCompatibleToolAgentTurn)({
        sourceMessageId: input.sourceMessageId, sourceSessionId: input.sourceSessionId, dataEpoch: input.dataEpoch,
        candidates: { ...selected.selection, mode: 'chat_only', candidates: [], executableTools: [], tools: [],
          discoveryToolIds: [], packages: [], reasons: [], packageDiscovery: undefined, serializedCharacterCount: 0 },
        chatOptions: { ...input.chatOptions, responseInstruction: [input.chatOptions.responseInstruction, instruction].filter(Boolean).join('\n\n') },
        bodyOnlyRetry: { continuationMessages: event.continuationMessages, completedResults: [event.result] },
        allowEmptyResponseRetry: false, allowProtocolCorrection: false,
        requestPreflightAtTransport: true,
        consumeModelRequest: kind => input.requestBudget.consume(kind),
        beforeModelRequest: async () => { if (!await input.cameraReplyCurrent?.()) throw new Error('camera_reply_stale'); },
        executeInvocation: async () => { throw new Error('camera_reply_tools_disabled'); },
      });
      if (!await input.cameraReplyCurrent?.() || !continued.contents.length) return;
      diagnosticStage = 'session_persist';
      const delivered = await input.deliverCameraContinuation?.(continued.contents, event.result) ?? [];
      await recordCameraObservationReply({ turnId: input.sourceMessageId, sessionId: input.sourceSessionId,
        dataEpoch: input.dataEpoch, results: [event.result], messageIds: delivered.map(message => message.id) });
      } catch (error) {
        try { input.onDiagnosticContinuationFailure?.(error, diagnosticStage); } catch { /* Observation only. */ }
        throw error;
      }
    },
  });
  const phoneLimitDiscoveryResults: JunLuoToolResult[] = [];
  let phoneLimitReplyContinuationMessages: OpenAiCompatibleContinuationMessage[] | undefined;
  const turn = await (dependencies.runTurn ?? runOpenAiCompatibleToolAgentTurn)({
    resolvePackageDiscovery: async (invocation, result) => {
      if (result.snapshot.status === 'tools_ready' && result.snapshot.packageIds.includes('http')) {
        const candidate = result.candidates.find(entry => entry.tool.id === BACKEND_OVERVIEW_TOOL_ID);
        if (candidate?.executionMode === 'executable' && candidate.authority?.dataEpoch === input.dataEpoch
          && candidate.authority.allowedToolIds.includes(BACKEND_OVERVIEW_TOOL_ID)) {
          backendOverviewExpanded = true;
          candidateByToolId.set(BACKEND_OVERVIEW_TOOL_ID, candidate);
        }
      }
      if (result.snapshot.status === 'tools_ready' && result.snapshot.packageIds.includes('phone_limit')) {
        for (const candidate of result.candidates) {
          if (isPhoneLimitToolId(candidate.tool.id) && candidate.executionMode === 'executable'
            && candidate.authority?.dataEpoch === input.dataEpoch
            && candidate.authority.allowedToolIds.includes(candidate.tool.id)) candidateByToolId.set(candidate.tool.id, candidate);
        }
        const candidate = result.candidates.find(entry => entry.tool.id === 'phone_limit.get_status');
        const call = { callId: invocation.callId, toolId: 'phone_limit.get_status', input: {},
          requestedBy: 'chat' as const, createdAt: Date.now(), sourceMessageId: input.sourceMessageId };
        const permission = candidate && candidate.executionMode === 'executable'
          && candidate.authority?.dataEpoch === input.dataEpoch
          && candidate.authority.allowedToolIds.includes(call.toolId)
          && await phoneLimit.available() ? await checkToolPermission(candidate.tool, call) : undefined;
        if (permission?.decision === 'allowed') {
          const queryResult = await phoneLimit.execute(call);
          if (queryResult.status !== 'permission_denied') {
            phoneLimitDiscoveryResults.push(queryResult);
            result = { ...result, content: serializePhoneLimitDiscoveryResult(JSON.parse(result.content),
              phoneLimitDiscoveryAttachment(queryResult), TOOL_AGENT_MAX_MODEL_RESULT_CHARACTERS) };
          }
        }
      }
      if (result.snapshot.status === 'tools_ready' && result.snapshot.packageIds.includes('weather')) {
        for (const candidate of result.candidates) {
          if (!['weather.get_current', 'weather.get_forecast'].includes(candidate.tool.id)
            || candidate.executionMode !== 'executable'
            || candidate.authority?.dataEpoch !== input.dataEpoch
            || !candidate.authority.allowedToolIds.includes(candidate.tool.id)) continue;
          expandedWeatherToolIds.add(candidate.tool.id);
          candidateByToolId.set(candidate.tool.id, candidate);
        }
      }
      if (invocation.input.reminderQuery !== undefined && result.snapshot.status === 'tools_ready'
        && result.snapshot.packageIds.includes('reminder') && result.snapshot.toolIds.includes('reminder.query')) {
        const call = { callId: invocation.callId, toolId: 'reminder.query', input: invocation.input.reminderQuery as Record<string, unknown>,
          requestedBy: 'chat' as const, createdAt: Date.now(), sourceMessageId: input.sourceMessageId };
        const tool = getToolDefinition(call.toolId); const permission = tool ? await checkToolPermission(tool, call) : undefined;
        const queryResult = permission?.decision === 'allowed' ? await reminderHost.execute(call)
          : createToolErrorResult(call, createToolError('PERMISSION_DENIED', '没有执行工具'), '没有执行工具');
        const packet = JSON.parse(result.content);
        packet.reminderQueryResult = { ok: queryResult.ok, status: queryResult.status, data: queryResult.data,
          ...(queryResult.error ? { errorCode: queryResult.error.code } : {}) };
        result = { ...result, content: JSON.stringify(packet) };
      }
      if (invocation.input.expenseQuery === undefined || result.snapshot.status !== 'tools_ready') return result;
      if (!result.snapshot.packageIds.includes('expense') || !result.snapshot.toolIds.includes('expense.query_entries')) return result;
      const call = { callId: invocation.callId, toolId: 'expense.query_entries', input: invocation.input.expenseQuery as Record<string, unknown>,
        requestedBy: 'chat' as const, createdAt: Date.now(), sourceMessageId: input.sourceMessageId };
      const tool = getToolDefinition(call.toolId);
      const permission = tool ? await checkToolPermission(tool, call) : undefined;
      const queryResult = permission?.decision === 'allowed' ? await expenseHost.execute(call)
        : createToolErrorResult(call, createToolError('PERMISSION_DENIED', '没有执行工具'), '没有执行工具');
      const packet = JSON.parse(result.content);
      packet.expenseQueryResult = { ok: queryResult.ok, status: queryResult.status, data: queryResult.data,
        ...(queryResult.error ? { errorCode: queryResult.error.code } : {}) };
      return { ...result, content: JSON.stringify(packet) };
    },
    scheduleReminderInstruction: messages => {
      const instructions: string[] = [];
      for (const message of messages) {
        if (message.kind !== 'tool_result') continue;
        const batch = scheduleHost.batches.get(message.callId);
        if (!batch) continue;
        try {
          const receipt = JSON.parse(message.content);
          if (receipt.ok && !receipt.dataOmitted && sameReminderCandidates(receipt.data?.reminderCandidates, batch)) instructions.push(chatReminderInstruction(batch));
        } catch { /* No reminder body without the complete numbered candidate packet. */ }
      }
      return [...new Set(instructions.filter(Boolean))].join('\n\n');
    },
    bodyOnlyRetry: input.resumeCompletedTools ? invalidateBackendOverviewReplay(input.resumeCompletedTools) : undefined,
    onDiagnosticToolEvent: input.onDiagnosticToolEvent,
    sourceMessageId: input.sourceMessageId,
    sourceSessionId: input.sourceSessionId,
    dataEpoch: input.dataEpoch,
    candidates: selected.selection,
    hostOnlyAllowedToolIds: [...(imageHost ? [CHAT_IMAGE_TOOL_ID] : []), ...(cameraHost ? [CAMERA_LOOK_ONCE_TOOL_ID] : []), ...(sleepHost ? ['life.set_sleep_schedule'] : [])],
    isToolAvailableForRequest: async toolId => toolId === 'life.set_sleep_schedule' ? !!await sleepHost?.available()
      : toolId === DIALER_TOOL_ID ? dialerHost.available()
      : toolId === CHAT_IMAGE_TOOL_ID ? !!await imageHost?.available()
      : toolId === 'reading.read_material' ? hasReadingReferences
      : toolId === 'reading.control' ? !!readingControl
      : toolId !== CAMERA_LOOK_ONCE_TOOL_ID || !!await cameraHost?.available(),
    allowPostMemoryMusic: true,
    chatOptions: withChatReadingReferenceInstruction({ ...input.chatOptions,
      ambientContext: [input.chatOptions.ambientContext, fileHost.material, imageHost?.material].filter(Boolean).join('\n\n'),
      beforeChatImageTransport: async materials => {
        await input.chatOptions.beforeChatImageTransport?.(materials);
        await imageHost?.beforeTransport(materials);
      },
      beforeTransportRequest: async () => {
        await input.chatOptions.beforeTransportRequest?.();
        await fileHost.checkMaterial();
        if (!await backendOverviewHost.isCurrent()) throw new Error('BACKEND_OVERVIEW_STALE');
      },
      onTransportAttempt: event => {
        if (event.phase === 'started') {
          expenseHost.observeDelivered(preparedMemoryResults ?? []);
          reminderHost.observeDelivered(preparedMemoryResults ?? []);
          memoryRead.observeMessages(preparedMemoryResults ?? []);
          try { input.onMemorySent?.(memoryRead.references, memoryRead.visibleMemoryIds); } catch { /* Diagnostic only. */ }
        }
        input.chatOptions.onTransportAttempt?.(event);
      },
      refreshMemoryMaterials: async preparation => {
        // Empty continuations need only the final material pass below.
        const materials = preparation?.continuationMessages?.length
          ? await input.chatOptions.refreshMemoryMaterials?.(preparation) ?? {}
          : {};
        const continuations = await memoryRead.refreshModelResults(preparation?.continuationMessages ?? []);
        // The final pass shares the same reread allowance and removes a second change.
        const checked = await memoryRead.refreshModelResults(continuations);
        const finalMaterials = await input.chatOptions.refreshMemoryMaterials?.(preparation) ?? materials;
        preparedMemoryResults = checked;
        memoryRead.syncInitialReferences(input.memoryMentionItems ?? [], input.visibleMemoryIds);
        if (!await backendOverviewHost.isCurrent()) throw new Error('BACKEND_OVERVIEW_STALE');
        return { ...finalMaterials, continuationMessages: checked };
      },
    }, hasReadingReferences),
    turnController: input.turnController,
    consumeModelRequest: async (kind) => {
      if (input.isReplyCurrent && !await input.isReplyCurrent()) throw new Error('CHAT_REPLY_SOURCE_STALE');
      if (reminderDraftRequired && !await reminderDraftCurrent()) throw new Error('REMINDER_DRAFT_INCOMPLETE');
      return input.requestBudget.consume(kind);
    },
    finalDayPlanRepair: Platform.OS === 'windows' && input.chatOptions.contextSource === 'chat.main'
      && !input.resumeCompletedTools && selected.selection.candidates.some(candidate => candidate.tool.id === 'schedule.submit_day_plan'
        && candidate.executionMode === 'executable' && candidate.authority?.dataEpoch === input.dataEpoch
        && candidate.authority.allowedToolIds.includes(candidate.tool.id))
      ? { allowed: true, remainingRequests: () => input.requestBudget.getSnapshot().remaining } : undefined,
    reminderDraftContract: input.chatOptions.fixedEnvelopeMode === 'desktop-reminder-draft' ? {
      continuationInstruction: DESKTOP_REMINDER_DRAFT_CONTINUATION_INSTRUCTION,
      remainingRequests: () => input.requestBudget.getSnapshot().remaining,
      onRequired: () => { reminderDraftRequired = true; },
      isCurrent: reminderDraftCurrent,
      cardDelivered: () => reminderCardDelivered,
    } : undefined,
    completeWithVisibleCard: async (results, source) => {
      const reminderCard = reminderHost.card(results);
      if (reminderCard && input.deliverReminderPlan) {
        if (reminderDraftRequired && (!results.some(result => result.ok && result.toolId === 'reminder.propose_reminders')
          || !reminderCard.rows.length || reminderCard.rows.some(row => row.action !== 'create')
          || reminderCard.source.sessionId !== input.sourceSessionId
          || reminderCard.source.createdAt !== input.sourceMessage?.createdAt
          || !isReminderPlanSourceCurrent(reminderCard.source, input.sourceMessage)
          || !await reminderDraftCurrent())) throw new Error('REMINDER_DRAFT_INCOMPLETE');
        const savedCardId = await input.deliverReminderPlan(reminderCard, reminderDraftRequired || undefined);
        if (reminderDraftRequired) {
          if (typeof savedCardId !== 'string' || !savedCardId.trim() || !await reminderDraftCurrent()) throw new Error('REMINDER_DRAFT_INCOMPLETE');
          reminderCardDelivered = true;
        }
        return true;
      }
      if (reminderDraftRequired) return false;
      const expenseCard = expenseHost.card(results);
      if (expenseCard && input.deliverExpensePlan) {
        await input.deliverExpensePlan(expenseCard);
        return true;
      }
      const draft = results.find((result) => result.toolId === 'schedule.submit_day_plan' && result.ok);
      if (!draft || !input.deliverDayPlan) return false;
      await input.deliverDayPlan(draft, source);
      return true;
    },
    prepareInvocation: (invocation) => {
      if (invocation.toolId === BACKEND_OVERVIEW_TOOL_ID) {
        return backendOverviewExpanded && Object.keys(invocation.input).length === 0
          ? { kind: 'ready', input: invocation.input }
          : { kind: 'rejected', result: createToolErrorResult({ ...invocation, requestedBy: 'chat', createdAt: Date.now() },
            createToolError('INVALID_ARGUMENTS', 'INVALID_ARGUMENTS'), '') };
      }
      if (invocation.toolId === DIALER_TOOL_ID) return dialerHost.prepare(invocation);
      if (invocation.toolId === APP_LAUNCH_TOOL_ID) return appLaunchHost.prepare(invocation);
      const isReminderPlan = /^reminder\.propose_/.test(invocation.toolId);
      const isOtherPlan = /^expense\.propose_/.test(invocation.toolId) || invocation.toolId === 'schedule.submit_day_plan';
      if (isReminderPlan && otherPlanTurn || isOtherPlan && reminderPlanTurn) {
        return { kind: 'rejected', result: createToolErrorResult({ ...invocation, requestedBy: 'chat', createdAt: Date.now() },
          createToolError('INVALID_ARGUMENTS', 'REMINDER_PLAN_TURN_CONFLICT'), '') };
      }
      if (isReminderPlan) reminderPlanTurn = true;
      if (isOtherPlan) otherPlanTurn = true;
      if (failedMapOperation && (invocation.toolId.startsWith('map.') || invocation.toolId === 'nearby.describe_place_context')) {
        return { kind: 'rejected', result: { ...failedMapOperation, callId: invocation.callId, toolId: invocation.toolId } };
      }
      if (['map.search_nearby', 'map.search_destination', 'map.more_results'].includes(invocation.toolId)) {
        return { kind: 'ready', input: invocation.input };
      }
      if (invocation.toolId === 'memory.get') return memoryRead.prepare(invocation);
      if (invocation.toolId === 'memory.update') return memoryCorrection.prepare(invocation, memoryRead.searchedMemory(invocation.input.item));
      if (invocation.toolId === 'music.play') {
        const keyword = chatMusicSearchKeyword(invocation.input);
        if (!keyword || musicRequested) {
          return { kind: 'rejected', result: createToolErrorResult({
            ...invocation, requestedBy: 'chat', createdAt: Date.now(),
          }, createToolError(musicRequested ? 'DUPLICATE_TOOL_CALL' : 'INVALID_ARGUMENTS', '缺少歌曲或搜歌关键词'), '没有播放音乐') };
        }
        musicRequested = true;
        return { kind: 'ready', input: { keyword } };
      }
      if (invocation.toolId === 'weather.get_current' || invocation.toolId === 'weather.get_forecast') {
        const authority = candidateForToolId(invocation.toolId)?.authority;
        if (!expandedWeatherToolIds.has(invocation.toolId) || authority?.dataEpoch !== input.dataEpoch
          || !authority.allowedToolIds.includes(invocation.toolId)) {
          return { kind: 'rejected', result: createPreparationFailureResult(invocation) };
        }
        if (!acceptWeatherMapNearbyInvocation(invocation.toolId)) {
          return { kind: 'rejected', result: createDuplicateInvocationResult(invocation) };
        }
        return { kind: 'ready', input: invocation.input };
      }
      if (!isWeatherMapNearbyAgentToolId(invocation.toolId)) {
        return { kind: 'ready', input: invocation.input };
      }
      const evidence = selected.selection.weatherMapNearbyEvidence;
      if (!evidence) {
        return { kind: 'rejected', result: createPreparationFailureResult(invocation) };
      }
      const decision = constrainWeatherMapNearbyInvocationInput(evidence, invocation);
      if (decision.kind === 'rejected') {
        return { kind: 'rejected', result: createPreparationFailureResult(invocation) };
      }
      const requiresPlace = invocation.toolId === 'map.geocode_place'
        || invocation.toolId === 'map.search_destination';
      if (
        requiresPlace
        && !['place', 'destination', 'query', 'address'].some((key) => (
          typeof decision.input[key] === 'string' && decision.input[key].trim().length > 0
        ))
      ) {
        return {
          kind: 'rejected',
          result: createWeatherMapNearbyInputRequiredResult(invocation),
        };
      }
      if (!acceptWeatherMapNearbyInvocation(invocation.toolId)) {
        return { kind: 'rejected', result: createDuplicateInvocationResult(invocation) };
      }
      return decision;
    },
    reconfirmMemoryCorrection: async (invocation) => {
      const draft = correctionDrafts.get(invocation.callId);
      if (!draft || typeof draft.memoryId !== 'string' || input.chatOptions.signal?.aborted
        || !canCommitBackupRestoreDataEpoch(input.dataEpoch)
        || input.isReplyCurrent && !await input.isReplyCurrent()) return null;
      const { loadMemory } = await import('../memory/memoryStore');
      const current = await loadMemory(draft.memoryId);
      if (!current || current.type === 'archived' || !canCommitBackupRestoreDataEpoch(input.dataEpoch)) return null;
      memoryCorrection.replaceOriginal(current);
      const root = correctionRetryRoots.get(invocation.callId) ?? invocation.callId;
      const callId = `${root}:memory-review:${++correctionRetryNumber}`;
      correctionRetryRoots.set(callId, root);
      return { ...invocation, callId, input: { ...draft,
        [MEMORY_CORRECTION_VERSION]: current.updatedAt,
        [MEMORY_CORRECTION_EDITABLE_HASH]: weeklyTargetHash(current),
      } };
    },
    projectResultForModel: (invocation, result) => projectBackendOverviewResult(projectDialerResult(projectAppLaunchResult(memoryRead.project(projectChatImageResult(projectTextFileResult(projectBrowserOpenResult(projectResearchChatResult(projectMusicAgentResultForModel(invocation, projectWeatherMapNearbyResultForModel(invocation, result)))))))))),
    onModelToolResults: async messages => {
      const transmitted = preparedMemoryResults ?? messages;
      if (phoneLimitDiscoveryResults.length || transmitted.some(message =>
        message.kind === 'tool_result' && isPhoneLimitToolId(message.toolId))) {
        // Keep every paired call/result, including other tools in the same round.
        phoneLimitReplyContinuationMessages = [...transmitted];
      }
      scheduleHost.observe(messages);
      input.onScheduleReminders?.(scheduleHost.deliveredBatch);
      for (const message of messages) {
        if (message.kind !== 'tool_result' || !isTextFileChatTool(message.toolId)) continue;
        try {
          const receipt = JSON.parse(message.content);
          if (receipt.ok && !receipt.dataOmitted && typeof receipt.data?.cacheId === 'string') {
            fileHost.remember(receipt.data.cacheId);
            const result = settledResults.get(message.callId);
            if (result?.data && typeof receipt.data.end === 'number') {
              (result.data as Record<string, unknown>).deliveredEnd = receipt.data.end;
            }
          }
        } catch { /* No delivered file evidence. */ }
      }
      memoryRead.observeMessages(preparedMemoryResults ?? messages);
      const delivered = messages.filter(message => {
        if (message.kind !== 'tool_result' || !['map.search_nearby', 'map.search_destination', 'map.more_results'].includes(message.toolId)) return false;
        try {
          const receipt = JSON.parse(message.content);
          return receipt.ok === true && !receipt.dataOmitted && Array.isArray(receipt.data?.candidates) && receipt.data.candidates.length > 0;
        } catch { return false; }
      }).map(message => message.kind === 'tool_result' ? createToolAgentHostCallId(input.sourceMessageId, message.callId) : '');
      await markMapSearchResultsDelivered(delivered, input.sourceSessionId).catch(error => {
        console.warn('[MapSearch] Could not validate delivered page source', error);
      });
    },
    resolveInvocationGate: async (invocation, context) => {
      const auditId = await ensureGateAudit(invocation, context);
      const gate = await resolveGate(invocation, context, {
        ...(invocation.toolId === 'memory.update' ? {
          confirmationPresentation: {
            ...memoryCorrectionPresentation(memoryCorrection.original(invocation.input.memoryId)!, invocation.input),
            ...(correctionRetryRoots.has(invocation.callId) ? {
              summary: '原卡已更新，编辑稿已保留。请对照最新原卡，再确认保存。',
            } : {}),
          },
        } : {}),
        createRejectedResult: createToolAgentGateRejectedResult,
        allowSideEffectWithoutConfirmation: ({ policyId, invocation: proposed }) => (
          isPhoneLimitToolId(proposed.toolId) && proposed.toolId !== 'phone_limit.get_status'
            && policyId === PHONE_LIMIT_SIDE_EFFECT_GATE_POLICY_ID
          ||
          proposed.toolId === APP_LAUNCH_TOOL_ID && !!input.appLaunchOpportunity && policyId === APP_LAUNCH_SIDE_EFFECT_GATE_POLICY_ID
          || proposed.toolId === DIALER_TOOL_ID && !!input.dialerOpportunity && policyId === DIALER_SIDE_EFFECT_GATE_POLICY_ID
          ||
          !!imageHost && proposed.toolId === CHAT_IMAGE_TOOL_ID && policyId === CHAT_IMAGE_SIDE_EFFECT_GATE_POLICY_ID
          ||
          TEXT_FILE_WRITE_TOOL_IDS.includes(proposed.toolId) && policyId === TEXT_FILE_CHAT_SIDE_EFFECT_GATE_POLICY_ID
          ||
          proposed.toolId === BROWSER_OPEN_TOOL_ID && policyId === BROWSER_OPEN_SIDE_EFFECT_GATE_POLICY_ID
          ||
          MAP_QUERY_STATE_TOOL_IDS.has(proposed.toolId) && policyId === MAP_QUERY_SIDE_EFFECT_GATE_POLICY_ID
          ||
          proposed.toolId === 'music.play' && policyId === MUSIC_PLAYBACK_INTENT_SIDE_EFFECT_GATE_POLICY_ID
          || !!cameraHost && proposed.toolId === CAMERA_LOOK_ONCE_TOOL_ID && policyId === CAMERA_STANDBY_SIDE_EFFECT_GATE_POLICY_ID
          || !!sleepHost && proposed.toolId === 'life.set_sleep_schedule' && policyId === SLEEP_CHAT_WINDOW_SIDE_EFFECT_GATE_POLICY_ID
          || ['proactive_contact.pause', 'proactive_contact.resume'].includes(proposed.toolId) && policyId === CONTACT_CHAT_SIDE_EFFECT_GATE_POLICY_ID
          || !!readingControl && proposed.toolId === 'reading.control' && policyId === READING_ACTIVITY_SIDE_EFFECT_GATE_POLICY_ID
          || ['schedule.save_own', 'schedule.save_own_habits', 'schedule.save_routine'].includes(proposed.toolId) && policyId === OWN_SCHEDULE_SIDE_EFFECT_GATE_POLICY_ID
          || isWishToolId(proposed.toolId) && policyId === WISH_SIDE_EFFECT_GATE_POLICY_ID
          || isGiftToolId(proposed.toolId) && policyId === GIFT_SIDE_EFFECT_GATE_POLICY_ID
          || CHAT_SCHEDULE_COMPLETION_TOOLS.has(proposed.toolId) && policyId === CHAT_SCHEDULE_SIDE_EFFECT_GATE_POLICY_ID
        ),
        promptForReadPermission: (toolId, call, signal) => toolId === APP_LAUNCH_TOOL_ID
          ? appLaunchHost.select(call, signal, true) : toolId === DIALER_TOOL_ID
            ? dialerHost.select(call, signal, true) : permissionPromptWithAbort(toolId, call, signal),
        onHostCancellation: () => input.turnController.cancel('confirmation_expired'),
        onGateStatus: async (event) => {
          await ensureGateAudit(invocation, context);
          if (event.status === 'awaiting_permission') {
            await recordToolAgentAuditStatus(auditId, 'awaiting_permission');
            await deliver(createToolAgentPermissionCard({
              auditId,
              providerCallId: invocation.callId,
              toolId: invocation.toolId,
            }));
            return;
          }
          if (event.status === 'awaiting_confirmation' && event.proposal) {
            await recordToolAgentAuditStatus(auditId, 'awaiting_confirmation');
            await recordToolAgentAuditMetadata(auditId, {
              proposalId: event.proposal.proposalId,
            }).catch(() => undefined);
            await deliver(createToolAgentConfirmationCard({
              proposal: event.proposal,
              permission: event.permission,
            }));
            return;
          }
          if (event.status === 'confirmation_expired' && event.proposal) {
            await recordToolPermissionDecision(auditId, 'cancelled', `tool-agent:${auditId}`, {
              source: event.permission.source,
              grantId: event.permission.grantId,
              expiresAt: event.permission.expiresAt,
              silent: event.permission.silent,
            });
            await recordToolAgentAuditMetadata(auditId, {
              proposalId: event.proposal.proposalId,
              confirmationDecision: 'expired',
            }).catch(() => undefined);
            await deliver({
              ...createToolAgentConfirmationCard({
                proposal: event.proposal,
                permission: event.permission,
              }),
              status: 'cancelled',
              confirmationDecision: 'expired',
            });
            return;
          }
          const decision = event.status === 'permission_denied' ? 'denied' : 'cancelled';
          await recordToolPermissionDecision(auditId, decision, `tool-agent:${auditId}`, {
            source: event.permission.source,
            grantId: event.permission.grantId,
            expiresAt: event.permission.expiresAt,
            silent: event.permission.silent,
          });
          if (event.proposal) {
            await recordToolAgentAuditMetadata(auditId, {
              proposalId: event.proposal.proposalId,
              confirmationDecision: event.status === 'cancelled' ? 'declined' : undefined,
            }).catch(() => undefined);
          }
          await deliver(createToolAgentResultCard({
            auditId,
            providerCallId: invocation.callId,
            result: createToolAgentGateRejectedResult(invocation, event.status === 'permission_denied'
              ? 'permission_denied'
              : 'cancelled'),
          }));
        },
      });
      if (invocation.toolId !== APP_LAUNCH_TOOL_ID && invocation.toolId !== DIALER_TOOL_ID) return gate;
      const openingHost = invocation.toolId === DIALER_TOOL_ID ? dialerHost : appLaunchHost;
      const call = { ...invocation, callId: auditId, requestedBy: 'chat' as const, createdAt: Date.now(), sourceMessageId: input.sourceMessageId };
      if (gate.kind === 'none') return { kind: 'permission' as const, wait: async (signal: AbortSignal) => {
        const decision = await openingHost.select(call, signal, false);
        const failure = openingHost.failure(invocation.callId);
        return failure ? { decision: 'result' as const, result: failure }
          : decision === 'allowed' ? { decision: 'execute' as const, receipt: gate.receipt }
            : { decision: 'result' as const, result: createToolAgentGateRejectedResult(invocation, 'cancelled') };
      } };
      return { ...gate, wait: async (signal: AbortSignal) => {
        const resolution = await gate.wait(signal);
        const failure = openingHost.failure(invocation.callId);
        return failure ? { decision: 'result' as const, result: failure } : resolution;
      } };
    },
    executeInvocation: async (invocation, context) => {
      if (failedMapOperation && (invocation.toolId.startsWith('map.') || invocation.toolId === 'nearby.describe_place_context')) {
        return { ...failedMapOperation, callId: invocation.callId, toolId: invocation.toolId };
      }
      if (input.isReplyCurrent && !await input.isReplyCurrent()) {
        return createToolErrorResult({ ...invocation, requestedBy: 'chat', createdAt: Date.now() },
          createToolError('PERMISSION_DENIED', 'chat_sleep_boundary_reached'), '');
      }
      roundByCallId.set(invocation.callId, context.round);
      if (isWishToolId(invocation.toolId)) wishProviderCallIds.set(createToolAgentHostCallId(context.turnId, context.providerCallId), context.providerCallId);
      const tool = getToolDefinition(invocation.toolId);
      if (invocation.toolId === 'memory.update' && context.gateReceipt) {
        correctionDrafts.set(invocation.callId, context.gateReceipt.frozenInput);
        const root = correctionRetryRoots.get(invocation.callId);
        if (root) correctionDrafts.set(root, context.gateReceipt.frozenInput);
      }
      return executeInvocation(invocation, context, {
        candidateSource: candidateForToolId(invocation.toolId)?.source,
        authorityKind: candidateForToolId(invocation.toolId)?.authority?.kind,
        executionOptions: {
          backendOverviewChat: call => backendOverviewHost.execute(call, context.signal, context.gateReceipt?.permission.decision === 'allowed'),
          appLaunchChat: call => appLaunchHost.execute(call, context.signal),
          dialerChat: async call => { await dialerStatusSave; return dialerHost.execute(call, context.signal); },
          chatExpense: call => expenseHost.execute(call, invocation.callId),
          chatReminder: call => reminderHost.execute(call, invocation.callId),
          textFileChat: isTextFileChatTool(invocation.toolId) ? fileHost.context(invocation.toolId, context.hostExecutionId, context.signal, invocation.input) : undefined,
          chatImage: imageHost ? call => imageHost.execute(call, context.signal) : undefined,
          sleepScheduleDecision: sleepHost ? (values, callId) => sleepHost.execute(values, callId) : undefined,
          cameraObservation: cameraHost ? call => cameraHost.execute(call, context.signal) : undefined,
          memoryRead: call => memoryRead.execute(call, invocation.callId),
          mapSearch: invocation.toolId.startsWith('weather.') ? {
            ...mapSearch,
            isSourceCurrent: async () => !context.signal?.aborted && !input.chatOptions.signal?.aborted
              && (!input.isReplyCurrent || await input.isReplyCurrent()) && await mapSearch.isSourceCurrent(),
          } : mapSearch,
          proactiveContact,
          readingControl: readingControl ?? undefined,
          readingMaterial,
          ownSchedule,
          chatSchedule: scheduleHost.execute,
          userRoutine,
          phoneLimit: call => phoneLimit.execute(call, context.signal),
          wishPool,
          giftCabinet,
          onStatusChange: (event) => {
            if (tool?.readOnly && !visibleAuditIds.has(event.call.callId)) return;
            const saveStatus = () => deliver({
              ...event.card,
              auditId: event.call.callId,
              providerCallId: invocation.callId,
            }, false).catch(error => {
              // Status is provisional; the awaited settlement below owns delivery.
              console.warn('[ToolAgent] Could not save execution status card', error);
            });
            // This tool's own provisional card must finish before its final source
            // revision check, otherwise a normal card write looks like source editing.
            if (invocation.toolId === DIALER_TOOL_ID) dialerStatusSave = dialerStatusSave.then(saveStatus).then(() => undefined);
            else void saveStatus();
          },
        },
      });
    },
    onSettlement: async ({ invocation, result }) => {
      if (invocation.toolId === DIALER_TOOL_ID) await dialerStatusSave;
      settledResults.set(invocation.callId, result);
      if ((TEXT_FILE_WRITE_TOOL_IDS.includes(invocation.toolId) || invocation.toolId === CHAT_IMAGE_TOOL_ID || invocation.toolId === APP_LAUNCH_TOOL_ID || invocation.toolId === DIALER_TOOL_ID) && result.ok) {
        const saved = await deliver(createToolAgentResultCard({
          auditId: createToolAgentHostCallId(input.sourceMessageId, invocation.callId),
          providerCallId: invocation.callId, result,
        }));
        // The existing journal stays pending delivery; never rerun the file write.
        if (saved !== true) throw new Error(invocation.toolId === DIALER_TOOL_ID ? 'DIALER_CARD_SAVE_FAILED' : invocation.toolId === APP_LAUNCH_TOOL_ID ? 'APP_LAUNCH_CARD_SAVE_FAILED' : invocation.toolId === CHAT_IMAGE_TOOL_ID ? 'IMAGE_CARD_SAVE_FAILED' : 'FILE_CARD_SAVE_FAILED');
      }
      if (!result.ok && (invocation.toolId.startsWith('map.') || invocation.toolId === 'nearby.describe_place_context')) failedMapOperation = result;
      if (result.ok && result.toolId === 'schedule.query_agenda') {
        ownScheduleHost ??= await createOwnScheduleTurn({ dataEpoch: input.dataEpoch, signal: input.chatOptions.signal,
          readingSources: hasReadingReferences ? [...readingSources!] : undefined,
          scheduleVersions: input.scheduleVersions, sourceMessageId: input.sourceMessageId,
          sourceSessionId: input.sourceSessionId, isCurrent: input.isReplyCurrent });
        await ownScheduleHost.observe(result);
      }
      memoryCorrection.remember(result);
      await memoryRead.rememberSearch(result);
      await deliverMusic(invocation, result);
      const auditId = createToolAgentHostCallId(input.sourceMessageId, invocation.callId);
      await recordToolAgentAuditMetadata(auditId, {
        settlement: result.error?.code === 'TOOL_TIMEOUT' ? 'aborted' : 'settled',
      }).catch(() => undefined);
      if (result.error?.code === 'TOOL_OUTCOME_UNKNOWN') {
        await recordToolAgentAuditStatus(auditId, 'outcome_unknown').catch(() => undefined);
      }
    },
    onLateSettlement: async (event) => {
      const { invocation, result, dataEpochStillCurrent } = event;
      try {
        input.onDiagnosticToolEvent?.({ kind: 'execution', callId: result.callId, name: result.toolId,
          status: result.ok ? 'success' : result.status === 'cancelled' ? 'cancelled' : 'failed', at: result.finishedAt });
      } catch { /* Observation only. */ }
      if (invocation.toolId === CAMERA_LOOK_ONCE_TOOL_ID) {
        lateCameraCallIds.add(invocation.callId);
        settledResults.set(invocation.callId, result);
      }
      const auditId = createToolAgentHostCallId(input.sourceMessageId, invocation.callId);
      await recordToolAgentAuditMetadata(auditId, { settlement: 'settled' }).catch(() => undefined);
      if (dataEpochStillCurrent) {
        await deliverMusic(invocation, result);
        const delivered = await deliver(createToolAgentResultCard({
          auditId,
          providerCallId: invocation.callId,
          result,
        }), true);
        if ((TEXT_FILE_WRITE_TOOL_IDS.includes(invocation.toolId) || invocation.toolId === CHAT_IMAGE_TOOL_ID) && result.ok && delivered !== true) {
          throw new Error('FILE_CARD_SAVE_FAILED');
        }
        await cameraContinuation.settled(event);
      }
    },
  }).catch(async (error: unknown) => {
    // Read-only result cards normally wait for the final reply. A provider
    // failure must not hide the tool work that has already settled.
    for (const [callId, result] of settledResults) {
      if (result.toolId === 'schedule.submit_day_plan') continue;
      if (result.error?.code === 'DUPLICATE_TOOL_CALL') continue;
      await deliver(createToolAgentResultCard({
        auditId: createToolAgentHostCallId(input.sourceMessageId, callId),
        providerCallId: callId,
        result,
      })).catch(() => undefined);
    }
    throw error;
  });

  rememberWeatherMapNearbyPendingInput(input, selected.selection, turn);

  const finalRound = Math.max(0, ...turn.results.map((result) => roundByCallId.get(result.callId) ?? 0));
  for (const result of turn.results) {
    if (result.toolId === CAMERA_LOOK_ONCE_TOOL_ID && lateCameraCallIds.has(result.callId)) continue;
    if (result.toolId === 'schedule.submit_day_plan' && turn.completedWithVisibleCard) continue;
    if (result.error?.code === 'DUPLICATE_TOOL_CALL') continue;
    const auditId = createToolAgentHostCallId(input.sourceMessageId, result.callId);
    const shouldDisplay = visibleAuditIds.has(auditId)
      || !result.ok
      || (roundByCallId.get(result.callId) ?? 0) === finalRound;
    if (!shouldDisplay) continue;
    if (result.error?.code === 'TOOL_OUTCOME_UNKNOWN') {
      await recordToolAgentAuditStatus(auditId, 'outcome_unknown').catch(() => undefined);
    }
    await deliver(createToolAgentResultCard({
      auditId,
      providerCallId: result.callId,
      result,
    }));
  }

  if (!await backendOverviewHost.isCurrent()) throw new Error('BACKEND_OVERVIEW_STALE');
  return {
    handled: true,
    selection: selected.selection,
    shadowCandidateToolIds: selected.shadow.candidateToolIds,
    turn,
    phoneLimitDiscoveryResults,
    phoneLimitReplyContinuationMessages,
    cameraBodyCommitted: () => cameraContinuation.bodyCommitted(),
    memoryRead,
  };
}

function resolvePendingWeatherMapNearbyFollowUp(
  input: Pick<RunProductionChatToolAgentInput, 'recentMessages' | 'sourceSessionId' | 'dataEpoch' | 'youText'>,
  readOnly = false,
): { actionId: string; evidence: WeatherMapNearbyIntentEvidence } | undefined {
  const now = Date.now();
  const sourceMessageIds = new Set(
    input.recentMessages
      .filter((message) => message.subject === 'you' && message.id)
      .map((message) => message.id as string),
  );
  for (const [actionId, pending] of weatherMapPendingInputs) {
    if (
      pending.primaryToolId.startsWith('weather.')
      || pending.sourceSessionId !== input.sourceSessionId
      || pending.dataEpoch !== input.dataEpoch
      || pending.expiresAt <= now
      || !sourceMessageIds.has(pending.sourceMessageId)
    ) {
      if (!readOnly) weatherMapPendingInputs.delete(actionId);
    }
  }
  const pendingForSession = [...weatherMapPendingInputs.values()]
    .filter((pending) => !pending.primaryToolId.startsWith('weather.') && pending.sourceSessionId === input.sourceSessionId
      && pending.dataEpoch === input.dataEpoch && pending.expiresAt > now && sourceMessageIds.has(pending.sourceMessageId));
  const resolution = resolveWeatherMapNearbyPendingInput(
    pendingForSession,
    input.youText,
    { dataEpoch: input.dataEpoch, now },
  );
  if (resolution.kind === 'cancel') {
    if (!readOnly) weatherMapPendingInputs.delete(resolution.actionId);
    return undefined;
  }
  if (resolution.kind !== 'place') return undefined;
  const pending = weatherMapPendingInputs.get(resolution.actionId);
  if (!pending) return undefined;
  const sourceText = input.recentMessages.find((message) => (
    message.id === pending.sourceMessageId && message.subject === 'you'
  ))?.content ?? '';
  const evidence = buildPendingPlaceEvidence(pending, resolution.place, sourceText);
  if (!evidence) return undefined;
  if (!readOnly) weatherMapPendingInputs.delete(resolution.actionId);
  return { actionId: resolution.actionId, evidence };
}

function buildPendingPlaceEvidence(
  pending: WeatherMapNearbyPendingInput,
  place: string,
  sourceText: string,
): WeatherMapNearbyIntentEvidence | undefined {
  if (
    pending.primaryToolId === 'map.search_nearby'
    && pending.fallbackToolIds.includes('map.search_destination')
  ) {
    const nearbyInput = parseMapSearchNearbyInputFromText(sourceText);
    return {
      primaryToolId: 'map.search_destination',
      strength: 'strong',
      locationScope: 'explicit_place',
      deterministicInput: {
        destination: place,
        ...(nearbyInput.category ? { category: nearbyInput.category } : {}),
        ...(nearbyInput.limit ? { limit: nearbyInput.limit } : {}),
        ...(nearbyInput.query ? { topic: nearbyInput.query } : {}),
      },
      fallbackToolIds: [],
      requiresCurrentLocation: false,
    };
  }
  return undefined;
}

function rememberWeatherMapNearbyPendingInput(
  input: RunProductionChatToolAgentInput,
  selection: JunLuoToolCandidateSelection,
  turn: ToolAgentTurnResult,
) {
  const evidence = selection.weatherMapNearbyEvidence;
  if (!evidence?.requiresCurrentLocation || evidence.strength !== 'strong') return;
  const denied = turn.results.some((result) => (
    result.toolId === evidence.primaryToolId
    && result.error?.code === 'PERMISSION_DENIED'
  ));
  if (!denied || !turn.contents.some(isExplicitPlaceQuestion)) return;
  const fallbackToolIds = evidence.primaryToolId === 'map.search_nearby'
    ? ['map.search_destination']
    : [];
  if (!fallbackToolIds.length) return;
  const now = Date.now();
  const actionId = `weather-map-input:${input.sourceMessageId}`;
  weatherMapPendingInputs.set(actionId, {
    actionId,
    sourceSessionId: input.sourceSessionId,
    sourceMessageId: input.sourceMessageId,
    primaryToolId: evidence.primaryToolId,
    fallbackToolIds,
    requiredInputKeys: ['place'],
    dataEpoch: input.dataEpoch,
    createdAt: now,
    expiresAt: now + WEATHER_MAP_PENDING_INPUT_TTL_MS,
  });
}

function isExplicitPlaceQuestion(content: string) {
  const text = content.trim();
  return /(?:城市|地点|地方|位置|哪里|哪儿).{0,24}[？?]|[？?].{0,24}(?:城市|地点|地方|位置|哪里|哪儿)/u.test(text);
}

function createPreparationFailureResult(invocation: JunLuoToolInvocation): JunLuoToolResult {
  const now = Date.now();
  return {
    callId: invocation.callId,
    toolId: invocation.toolId,
    ok: false,
    status: 'error',
    summary: '',
    error: { code: 'EXECUTION_FAILED', message: 'EXECUTION_FAILED' },
    startedAt: now,
    finishedAt: now,
  };
}

function createDuplicateInvocationResult(invocation: JunLuoToolInvocation): JunLuoToolResult {
  const now = Date.now();
  return {
    callId: invocation.callId,
    toolId: invocation.toolId,
    ok: false,
    status: 'error',
    summary: '',
    error: { code: 'DUPLICATE_TOOL_CALL', message: 'DUPLICATE_TOOL_CALL' },
    startedAt: now,
    finishedAt: now,
  };
}
