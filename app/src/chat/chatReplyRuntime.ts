import { Platform, unstable_batchedUpdates } from 'react-native';
import type { AiConnection, AiProfile } from '../ai/types';
import { beginChatReplyBackground } from './chatReplyBackground';
import { loadChatRequestHistory } from './chatRequestHistory';
import { assertQwenChatMessages, isLocalQwenChatConnection, isSiliconQwenChatConnection } from '../ai/qwenChatLayout';
import { isOfficialQwen397bConnection } from '../ai/modelParameters';
import { BackstageCapacityPending, backstagePendingShares, createBackstageRequestPreparation,
  withoutBackstageShares, type ChatTheaterBackstagePort } from './chatTheaterBackstage';
import type { BackstageCapacityInput } from '../theater/theaterBackstageCapacity';
import type { TheaterBackstageMessageSource } from '../ai/subjectiveMessages';
import { recordTheaterBackstageReplySource } from './chatStorage';
import { buildDayPlanDraft, dayPlanModelContext, type DayPlanSubmission } from '../schedule/dayPlanDraft';
import { prepareSavedChatReminders } from '../schedule/chatScheduleSavedReply';
import { chatReminderInstruction, commitChatReminderAnswer, type ChatReminderBatch } from '../schedule/chatScheduleReminders';
import { prepareStandaloneReminderBatch, transmittedStandaloneReminderBatch, commitStandaloneReminderAnswer,
  standaloneReminderBatchCurrent, type StandaloneReminderBatch } from '../schedule/chatReminderPreparation';
import { reminderExecutionMaterial } from './chatReminderRuntimeMaterials';
import { isReminderPlanSourceCurrent, reminderSourceRevision } from './chatReminderPlan';
import { getAmbientTimeContext, getCachedAmbientContext } from '../ai/ambientContext';
import { selectChatAmbientRoute } from '../ai/ambientRouting';
import {
  describeAssistantAvailability,
} from '../ai/assistantLife';
import type { AssistantState } from '../ai/assistantState';


import { attachGlobalMemoryBundle, buildGlobalMemoryBundle, buildGlobalCognitionContext, type GlobalCognitionContext } from '../ai/globalCognition';
import { prepareChatMemoryRecall, type MemoryRecallPreparationDiagnostic } from '../memory/memoryChatPreparation';
import { loadMemories, type MemoryRecallItem } from '../memory/memoryStore';
import { referenceKey, isShiyingReference, isPostReference } from '../memory/memoryReadReference';
import { loadScheduleRecoveryBatch, acknowledgeScheduleRecoveryBatch } from '../schedule/scheduleReminderRecovery';
import {
  AiRequestError,
  buildChatCompletionPromptEnvelope,
  sendChatCompletionResult,
  type ChatReplyDiagnostics,
  type ChatTransportAttemptEvent,
  type OpenAiCompatibleContinuationMessage,
} from '../ai/openAiCompatibleProvider';
import type { PromptContextSource } from '../ai/promptContextProfile';
import { TOOL_AGENT_ACTION_REVIEW_INSTRUCTION, prepareInitialToolAgentChatOptions } from '../ai/toolAgentProvider';
import { markChatReplyFinished, markChatReplyStarted } from '../ai/aiRuntimeScheduler';
import { loadBaiyunIntimacySafetySettings } from '../ai/behavior/actionBehaviorStore';
import { BAIYUN_TRUE_STOP_INSTRUCTION, isBaiyunSafeWordCommand } from '../ai/behavior/actionChat';
import type { BaiyunChatToolReceiptContext } from './toolCallMessageTypes';



import {
  decideBaiyunProviderEmptyRetry,
  getBaiyunChatSemanticOutputForTokenEstimate,
  recoverBaiyunChatSemanticEnvelopeFromReasoning,
} from '../ai/behavior/actionChatSemantic';
import {
  buildBaiyunLatestBadEnvelopeSnapshot,
  saveBaiyunLatestBadEnvelopeSnapshot,
  withBaiyunBadEnvelopeRetryOutcome,
  type BaiyunLatestBadEnvelopeSnapshot,
} from '../ai/behavior/actionChatBadEnvelopeCache';
import {
  consumeBaiyunChatReplyFailureFixture,
  recordBaiyunChatReplyFailureDiagnostic,
  recordBaiyunChatSemanticDiagnostic,
  type BaiyunChatModelAttemptDiagnostic,
  type BaiyunChatReplyFailureDiagnosticEntry,
} from '../ai/behavior/actionChatSemanticStore';
import { createChatReplyDiagnosticCollector, type ChatSendAction } from './chatReplyDiagnostics';
import { describeChatReplyFailure } from './chatReplyDiagnosticPresentation';
import {
  BAIYUN_CHAT_FIXED_SHARE_RESPONSE_GUIDANCE_PROTOCOL,
  parseBaiyunFixedShareResponses,
  type BaiyunFixedShareResponseParseResult,
} from '../ai/behavior/actionShareResponse';
import {
  commitBaiyunFixedShareResponseLedger,
  loadBaiyunPendingSharePromptContext,
} from '../ai/behavior/actionShareResponseStore';
import { listBaiyunContinuityLinks, listChatCareMatters, applyBaiyunCareMatterUpdates } from '../ai/behavior/continuityLedger';
import { buildChatCareGuidance, selectChatCareItems, buildChatCareContext, numberCareMessages, parseChatCareUpdates } from '../ai/behavior/chatCareUpdates';
import { CHAT_PRESENCE_GUIDANCE, commitPresenceUpdate, parsePresenceUpdate } from '../nearby/nearbyPresence';
import { inspectBaiyunFixedChatEnvelope } from '../ai/behavior/actionChatFixedEnvelope';
import {
  createSubjectiveMessage,
  type SubjectiveMessage,
} from '../ai/subjectiveMessages';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
  subscribeBackupRestoreRuntimeState,
} from '../backup/backupRestoreCoordinator';
import {
  commitBodySignalCareDoorbell,
  isBodySignalCareDoorbellCurrent,
  EMPTY_BODY_SIGNAL_CARE_DOORBELL,
  prepareBodySignalCareDoorbell,
} from '../bodySignal/bodySignalCareDoorbell';
import {
  mergeSubjectiveMessages,
  loadChatSessionMessage,
  appendMessagesToChatSession,
  type ChatContextCompressionState,
  type PromptCacheStats,
  type PromptTokenBreakdown,
} from './chatStorage';
import {
  getCurrentYouTurn,
  shouldUseFastReplyPath,
} from './chatReplyText';
import {
  buildCurrentScheduleNudgeContext,
  buildRecentScheduleReminderContext,
  buildScheduleNudgeLifeModeInstruction,
  type ScheduleNudgeContext,
  type ScheduleNudgeState,
} from './chatScheduleContext';
import {
  buildRecentMusicHistoryContext,
} from './chatMusicLogic';
import {
  buildConversationSummaryWithShortLogs,
  estimateTextTokens,
  getReplyTokenReserve,
  getRequestMessages,
} from './contextCompression';
import {
  commitPreparedKeywordCounterInsights,
  prepareKeywordCounterInsights,
  createKeywordCounterTasks,
  extractKeywordCounterRequests,
  type KeywordCounterRequest,
} from './keywordCounterStore';
import {
  extractNotebookEntryRequests,
  type NotebookEntryRequest,
} from './notebookStore';
import {
  commitPreparedNotebookAction,
  prepareNotebookAction,
} from './notebookActionPlanner';
import {
  recordChatAuxiliaryDiagnostic,
  recordChatCareRejection,
  runChatAuxiliaryOperation as runChatAuxiliaryOperationBase,
  shouldMarkChatMessageFailed,
  type ChatAuxiliaryPhase,
  type ChatAuxiliaryStage,
} from './chatAuxiliaryDiagnostics';
import {
  completeSleepingMessages,
  releaseSleepingReply,
  updatePokeExperience,
  removePokeExperiences,
  type SleepReplyClaim,
} from './sleepInteraction';
import { loadJunluoDesirePromptPaper } from '../life/junluoDesireRuntime';
import {
  commitDreamSurface,
  prepareDreamSurfaceInstruction,
  type DreamSurfacePreparation,
} from '../life/dreamEngine';
import type { useChatMemoryController } from '../memory/useChatMemoryController';
import { createMemoryMaterialPreparation } from '../memory/memoryCurrentMaterials';
import { routeMemoryRecallWithAiDetailed } from '../memory/memoryRecallRouter';
import { extractMusicCommand } from '../music/musicCommands';
import { upsertMusicAgentResultCardMessage } from './musicAgentCardDelivery';
import {
  prepareMusicPreferenceMemoryContext,
  isExplicitMusicPreferenceStatement,
} from '../music/musicPreferenceMemory';
import {
  assessToolCompletionGrounding,
  activateToolPackages,
  buildToolResultInstruction,
  inferToolPackageIdsFromResults,
  type JunLuoToolPackageActivation,
  type JunLuoToolResult,
  type JunLuoToolAgentTurnController,
} from '../tools';
import { createChatModelRequestBudget } from './chatModelRequestBudget';
import { holdChatReplyMessageIds } from './chatPersistenceCoordinator';
import { chatReplyDraftSourceRevision, isChatReplyDraftSourceCurrent, type ChatReplyDraft } from './chatReplyDraft';
import { completeChatReplyDraft, isPendingChatReplyDraftCurrent, recoverChatReplyDraft, type ChatReplyDraftReceipt } from './chatReplyDraftRecovery';
import { loadPendingChatReplyDraft, savePendingChatReplyDraft, discardPendingChatReplyDraft } from './chatStorage';
import {
  CHAT_REPLY_FAILURE_CODE,
  CHAT_REPLY_FAILURE_STAGES,
  classifyChatReplyFailure,
  createChatReplyFailure,
  getChatReplyFailureStage,
  type ChatReplyFailureClassification,
  type ChatReplyFailureStage,
} from './chatReplyFailure';
import { runProductionChatToolAgent, prepareProductionChatToolCandidates, withChatReadingReferenceInstruction } from './chatToolAgentProductionRuntime';
import { prepareChatReadingReferences, readingMessageRevision, readingMessageSourcesCurrent, type ReadingMessageSource } from './chatReadingReferences';
import { holdWishChatTurn, prepareWishChatTurn, commitWishChatReply } from '../wishPool/wishPoolChatRuntime';
import { createChatSleepReplyLifecycle, prepareChatSleepScheduleHost, readChatSleepFarewellMaterial } from './chatSleepSchedule';
import { isExpensePlanSourceCurrent } from './chatExpensePlan';
import { upsertToolAgentCardMessage } from './toolAgentCardDelivery';
import { emitChatMessagesAppended } from './chatMessageEvents';
import { cameraReplySourceIsCurrent, recordCameraObservationReply } from '../camera/cameraModelObservationReply';
import { loadRecentCameraObservationMaterial } from '../camera/cameraEvidenceFusion';
import { prepareCameraObservationResponse, cameraObservationIdsFromResults,
  saveCameraResponseDraft, completeCameraResponseDelivery, cameraObservationResponsesCurrent } from '../camera/cameraObservationResponseDelivery';
import { commitMemoryReplyUsage, parseMemoryMentionReceipts } from '../memory/memoryReplyUsage';
import {
  prepareWebVoyageChatHandoff, isWebVoyageChatHandoffCurrent, commitWebVoyageChatHandoff,
} from '../proactive/webVoyageChatHandoff';

const CHAT_LOCAL_PERSIST_FAILURE_MESSAGE = '消息没有保存到本机，请重新发送。';
const CHAT_DELIVERY_FAILED = 'failed' as const;
const CHAT_PERSIST_FAILED = 'failed';
const CHAT_REPLY_IDLE = 'idle';
const CHAT_REPLY_PERSIST_FAILURE_CODE = 'chat_reply_persist_failed';
const BAIYUN_POKE_INTERACTION_KIND = 'poke' as const;
type BaiyunChatInteractionKind = typeof BAIYUN_POKE_INTERACTION_KIND;
import type { useChatMusicController } from './useChatMusicController';
import { createAppLaunchOpportunity } from '../tools/chatAppLaunch';
import { createDialerOpportunity } from '../tools/chatDialer';
import type { useChatSessionsController } from './useChatSessionsController';

export type ChatReplyPhase = 'idle' | 'waitingForUser' | 'requesting' | 'slowNetwork';

export type RunChatReplyOptions = {
  resumeReplyDraft?: boolean;
  cameraObservationReply?: { observationId: string; resumeDraft?: boolean };
  backstageResume?: {
    batchId: string | null; replyId: string; sourceMessageId: string; remainingRequests: number;
    tools?: BackstageCapacityPending['toolContinuation'];
  };
  sourceSessionId?: string;
  dayPlanReceipt?: boolean;
  expenseReceipt?: { sourceMessageId: string; remainingRequests: number; isCurrent: () => Promise<boolean> };
  reminderReceipt?: { sourceMessageId: string; remainingRequests: number; isCurrent: () => Promise<boolean> };
  dayPlanAdjustment?: { plan: import('../schedule/dayScheduler').PendingSchedulePlan; canCommit: () => boolean };
  dataEpoch?: number | null;
  interactionKind?: BaiyunChatInteractionKind;
  pokeInteraction?: import('./chatPokeExperience').PokeInteraction;
  interactionInstruction?: string;
  preserveInteractionReplyDuringConcurrentInput?: boolean;
  sleepClaim?: SleepReplyClaim;
  toolPackageActivations?: JunLuoToolPackageActivation[];
  toolResults?: JunLuoToolResult[];
  toolReceiptContexts?: BaiyunChatToolReceiptContext[];
  unsupportedToolIntent?: boolean;
};

const EMPTY_BAIYUN_PROMPT_CONTEXT = {
  items: [],
  fixedItems: [],
  settlementItems: [],
  instruction: '',
  fixedInstruction: 'pendingShares=[]',
} as const;

type MutableLatestRef<T> = { current: T };
type ReadonlyLatestRef<T> = Readonly<{ current: T }>;
type ChatMemoryController = ReturnType<typeof useChatMemoryController>;
type ChatMusicController = ReturnType<typeof useChatMusicController>;
type ChatSessionsController = ReturnType<typeof useChatSessionsController>;

type ReplyContextCache = {
  cognition?: GlobalCognitionContext;
  scheduleReminderContext: string;
  updatedAt: number;
};

export type ChatReplyControllerOptions = {
  appLaunchPicker?: import('../tools/appLaunchChatHost').AppLaunchPicker;
  dialerPicker?: import('../tools/dialerChatHost').DialerPicker;
  dialerIsForeground?: () => boolean;
  appLaunchIsForeground?: () => boolean;
  theaterBackstage?: ChatTheaterBackstagePort;
  context: {
    replyContextBudgetMs: number;
    wait: (milliseconds: number) => Promise<unknown>;
  };
  memory: Pick<
    ChatMemoryController,
    'captureExplicitFactAfterReply' | 'proposeMemoryAfterReply' | 'setLatestRecallFromCognition'
  >;
  model: {
    assistantStatus: AssistantState;
    chatConnection?: AiConnection | null;
    chatKey: string;
    memoryOrganizerConnection?: AiConnection | null;
    memoryOrganizerKey: string;
    profile: AiProfile;
    proactiveReviewedThroughId: string | null;
  };
  music: Pick<
    ChatMusicController,
    'getPreferencesSnapshot' | 'isMusicEnabled' | 'resolveMusicCardsSequentially'
  >;
  output: {
    onImageSaved?: (messageId: string, image: import('../ai/subjectiveMessages').MessageImage) => void;
    rememberReplyContinuation?: (continuation: import('./chatSendPersistence').AcceptedUserMessageContinuation) => void;
    appendAssistantBubbles: (
      contents: string[],
      metadata?: Pick<SubjectiveMessage, 'theaterBackstage' | 'theaterBackstagePending' | 'pokeInteraction' | 'fallbackDiagnostics' | 'scheduleOccurrenceId' | 'source'>,
      musicKeywords?: string[],
      shouldContinue?: () => boolean | Promise<boolean>,
      options?: {
        baseMessages?: SubjectiveMessage[]; targetSessionId?: string | null;
        preparedMessages?: SubjectiveMessage[];
        onPreparedMessages?: (messages: SubjectiveMessage[]) => void | Promise<void>;
        onFirstBubbleCommitted?: (at: number) => void;
      },
    ) => Promise<SubjectiveMessage[]>;
    compressConversationContext: (messages: SubjectiveMessage[], manual?: boolean) => Promise<void>;
    persistSessionMessages: ChatSessionsController['persistSessionMessages'];
    scheduleReply: (delay?: number, targetSessionId?: string | null, dataEpoch?: number | null) => void;
    showShortMemoryNotice: (notice: string) => void;
    updateMessageDeliveryStatus: ChatSessionsController['updateMessageDeliveryStatus'];
  };
  runtime: {
    sendActionRef?: MutableLatestRef<ChatSendAction | null>;
    answeredYouMessageIdsRef: MutableLatestRef<Set<string>>;
    compressionStateRef: MutableLatestRef<ChatContextCompressionState>;
    devRuntimeDiagnostics: boolean;
    draftRef: MutableLatestRef<string>;
    lastReplyCompletedAtRef: MutableLatestRef<number>;
    lastScheduleNudgeRef: MutableLatestRef<ScheduleNudgeState | null>;
    mountedRef: ReadonlyLatestRef<boolean>;
    needsFollowUpRef: MutableLatestRef<boolean>;
    pendingFactMessagesRef: MutableLatestRef<SubjectiveMessage[]>;
    pendingReplySessionIdRef: MutableLatestRef<string | null>;
    replyContextCacheRef: MutableLatestRef<ReplyContextCache>;
    replySessionIdRef: MutableLatestRef<string | null>;
    requestRef: MutableLatestRef<AbortController | null>;
    sendingRef: MutableLatestRef<boolean>;
    waitingToReplyRef: ReadonlyLatestRef<boolean>;
    clearSlowNetworkTimer: () => void;
    setAssistantStatus: (state: AssistantState) => void;
    setCompressionState: (
      state: ChatContextCompressionState
        | ((current: ChatContextCompressionState) => ChatContextCompressionState),
    ) => void;
    setError: (message: string | null) => void;
    onReplyFailureDiagnostic?: (entry: BaiyunChatReplyFailureDiagnosticEntry) => void;
    setQueuedMessageCount: (count: number) => void;
    setReplyPhase: (phase: ChatReplyPhase) => void;
    setReplySessionId: (sessionId: string | null) => void;
    setPreparingReplySessionId?: (sessionId: string | null) => void;
    setSending: (sending: boolean) => void;
    startSlowNetworkTimer: (controller: AbortController) => void;
  };
  sessions: Pick<
    ChatSessionsController,
    'activeSessionRef' | 'commitSessionMessages' | 'messagesRef' | 'messagesSessionIdRef' | 'sessionsRef'
  >;
};

const CHAT_REPLY_ABORTED_REASON = 'aborted';
const EMPTY_CHAT_REPLY_ERROR_MESSAGE = '白云小姐这次没有返回文字，请稍后再试。';
const AI_EMPTY_RESPONSE_KIND: AiRequestError['kind'] = 'empty_response';
const replyRuntimeStartedControllers = new WeakSet<AbortController>();
const replyLifecycleInterruptedControllers = new WeakSet<AbortController>();
const replyPreparationOwners = new WeakMap<object, { cancelled: boolean; finish: () => void; clearIndicator: () => void }>();
const replyDiagnosticOwners = new WeakMap<object, string>();

function isDatabaseLockedError(error: unknown) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const candidate = current as { cause?: unknown; message?: unknown };
    if (typeof candidate.message === 'string' && /database is locked/iu.test(candidate.message)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export function createChatReplyController({
  appLaunchPicker,
  dialerPicker,
  dialerIsForeground,
  appLaunchIsForeground,
  theaterBackstage,
  context,
  memory,
  model,
  music,
  output,
  runtime,
  sessions,
}: ChatReplyControllerOptions, toolAgentTurnController: JunLuoToolAgentTurnController) {
  const {
    replyContextBudgetMs: REPLY_CONTEXT_BUDGET_MS,
    wait,
  } = context;
  const retryTransientDatabaseLock = async <T,>(task: () => Promise<T>): Promise<T> => {
    const retryDelaysMs = [80, 180, 360, 720];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await task();
      } catch (error) {
        if (!isDatabaseLockedError(error) || attempt >= retryDelaysMs.length) throw error;
        await wait(retryDelaysMs[attempt]);
      }
    }
  };
  const loadChatContinuityPlanningContext = async (readOnly = false) => {
    try {
      return await retryTransientDatabaseLock(
        async () => {
          const events = await listChatCareMatters(readOnly);
          const links = (await Promise.all(events.map((event) => listBaiyunContinuityLinks(event.id, readOnly)))).flat();
          return { events, links, available: true };
        },
      );
    } catch (error) {
      console.warn(
        '[chat-continuity] planning context unavailable; continuing without continuity',
        error instanceof Error ? error.message : String(error),
      );
      if (!readOnly) void recordChatAuxiliaryDiagnostic({
        durationMs: 0,
        error,
        phase: 'read',
        retryAttempted: true,
        stage: 'continuity_ledger',
        step: 'continuity_context',
        status: 'failed',
      });
      return { events: [], links: [], available: false };
    }
  };
  const {
    assistantStatus,
    chatConnection,
    chatKey,
    memoryOrganizerConnection,
    memoryOrganizerKey,
    profile,
    proactiveReviewedThroughId,
  } = model;
  const chatMemory = memory;
  const { setLatestRecallFromCognition } = memory;
  const { getPreferencesSnapshot, isMusicEnabled } = music;
  const {
    appendAssistantBubbles,
    compressConversationContext,
    persistSessionMessages,
    scheduleReply,
    showShortMemoryNotice,
    updateMessageDeliveryStatus,
  } = output;
  const {
    answeredYouMessageIdsRef,
    clearSlowNetworkTimer,
    compressionStateRef,
    devRuntimeDiagnostics: DEV_RUNTIME_DIAGNOSTICS,
    draftRef,
    lastReplyCompletedAtRef,
    lastScheduleNudgeRef,
    mountedRef,
    needsFollowUpRef,
    pendingFactMessagesRef,
    pendingReplySessionIdRef,
    replyContextCacheRef,
    replySessionIdRef,
    requestRef,
    sendingRef,
    setCompressionState,
    setError,
    setQueuedMessageCount,
    setReplyPhase,
    setReplySessionId,
    setSending,
    startSlowNetworkTimer,
    waitingToReplyRef,
  } = runtime;
  const {
    activeSessionRef,
    commitSessionMessages,
    messagesRef,
    messagesSessionIdRef,
    sessionsRef,
  } = sessions;

  // Shared material preparation. The preview path never starts a reply or commits these materials.
  const prepareReplyMaterials = async (input: {
    options: RunChatReplyOptions; sessionId: string; outgoingMessages: SubjectiveMessage[];
    wishTurn: Awaited<ReturnType<typeof prepareWishChatTurn>>;
    latestYouMessage: SubjectiveMessage; currentYouTurn: string; isInteractionReply: boolean;
    currentUnansweredYouMessageBeforeInteraction?: SubjectiveMessage;
    latestYouAlreadyAnswered: boolean; shouldTrackDelivery: boolean; lastOutgoingMessage?: SubjectiveMessage;
    musicEnabledAtRequest: boolean; controller: AbortController;
    replyTiming: { startedAt: number; contextReadyAt: number };
    sleepScheduleHost?: Awaited<ReturnType<typeof prepareChatSleepScheduleHost>>;
    sleepFarewellMaterial: string; scheduleRecovery: Awaited<ReturnType<typeof loadScheduleRecoveryBatch>> | null;
    hasCurrentReplyDataEpoch: () => boolean; canCommitReplySideEffects: () => boolean;
    runChatAuxiliaryOperation: typeof runChatAuxiliaryOperationBase; readOnly?: boolean;
    onMemoryPreparation?: (diagnostic: MemoryRecallPreparationDiagnostic) => void;
    cameraResponseMaterial?: string;
  }) => {
    const { options, sessionId, outgoingMessages, latestYouMessage, currentYouTurn, isInteractionReply,
      currentUnansweredYouMessageBeforeInteraction, latestYouAlreadyAnswered, shouldTrackDelivery, lastOutgoingMessage,
      musicEnabledAtRequest, controller, replyTiming, sleepScheduleHost, sleepFarewellMaterial, scheduleRecovery,
      hasCurrentReplyDataEpoch, canCommitReplySideEffects, runChatAuxiliaryOperation, readOnly = false } = input;
    if (!chatConnection) return false;
    const { wishTurn } = input;
    const wishMode = Boolean(wishTurn.discussion);
    const useStoredRequestHistory = !wishMode && !isInteractionReply && !options.interactionKind
      && !options.pokeInteraction && !options.sleepClaim && !options.cameraObservationReply
      && !options.dayPlanReceipt && !options.dayPlanAdjustment && !options.expenseReceipt
      && !options.reminderReceipt && !options.backstageResume && !options.toolResults?.length
      && !options.toolReceiptContexts?.length && !options.toolPackageActivations?.length;
    if (!hasCurrentReplyDataEpoch() || controller.signal.aborted) return false;
    const query = latestYouMessage.content.trim();
    const shouldPrepareBodySignalCareDoorbell = Boolean(
      !wishMode && shouldTrackDelivery
      && !latestYouAlreadyAnswered
      && lastOutgoingMessage?.role === 'you'
    );
    const [scheduleConflicts, bodySignalCareDoorbellRead] = await Promise.all([
      !isInteractionReply
        ? import('../schedule/ownScheduleConflict').then(module => module.collectOwnScheduleConflicts(replyTiming.startedAt).catch(() => null))
        : null,
      shouldPrepareBodySignalCareDoorbell
        ? runChatAuxiliaryOperation(
          { phase: 'read', stage: 'continuity_ledger', step: 'body_doorbell_read' },
          () => prepareBodySignalCareDoorbell(undefined, runChatAuxiliaryOperation),
        )
        : undefined,
    ]);
    if (!hasCurrentReplyDataEpoch() || controller.signal.aborted) return false;
    const bodySignalCareDoorbell = bodySignalCareDoorbellRead?.ok
      ? bodySignalCareDoorbellRead.value
      : EMPTY_BODY_SIGNAL_CARE_DOORBELL;
    if (!hasCurrentReplyDataEpoch()) return false;
    let currentTurnStart = outgoingMessages.length;
    while (currentTurnStart > 0 && outgoingMessages[currentTurnStart - 1]?.role === 'you') {
      currentTurnStart -= 1;
    }
    const previousSituationMessages = outgoingMessages
      .slice(0, currentTurnStart)
      .filter((message) => message.role === 'I' || message.role === 'you')
      .slice(-2)
      .map((message) => ({
        id: message.id,
        role: message.role,
        sentAt: message.createdAt,
        text: message.content,
      }));
    const currentSituationMessage = {
      id: latestYouMessage.id,
      role: latestYouMessage.role,
      sentAt: latestYouMessage.createdAt,
      text: currentYouTurn || query,
    };
    const currentUnansweredYouSituationMessage = currentUnansweredYouMessageBeforeInteraction
      ? {
          id: currentUnansweredYouMessageBeforeInteraction.id,
          role: 'you' as const,
          sentAt: currentUnansweredYouMessageBeforeInteraction.createdAt,
          text: currentUnansweredYouMessageBeforeInteraction.content,
        }
      : undefined;
    const [
      continuityContext,
      desirePaper,
      intimacySafety,
      pendingShareContext,
    ] = await Promise.all([
      wishMode ? Promise.resolve({ events: [], links: [], available: false }) : loadChatContinuityPlanningContext(readOnly),
      retryTransientDatabaseLock(() => loadJunluoDesirePromptPaper(undefined, readOnly)),
      retryTransientDatabaseLock(() => loadBaiyunIntimacySafetySettings()),
      isInteractionReply || wishMode
        ? Promise.resolve(EMPTY_BAIYUN_PROMPT_CONTEXT)
        : retryTransientDatabaseLock(() => loadBaiyunPendingSharePromptContext(
            sessionId,
            latestYouMessage.replyTo?.id,
          )).catch((error) => {
            if (!readOnly) void recordChatAuxiliaryDiagnostic({
              durationMs: 0,
              error,
              phase: 'read',
              retryAttempted: true,
              stage: 'share_ledger',
              status: 'failed',
            });
            return EMPTY_BAIYUN_PROMPT_CONTEXT;
          }),
    ]);
    if (!hasCurrentReplyDataEpoch()) return false;
    const safeWordInputMessage = options.interactionKind === BAIYUN_POKE_INTERACTION_KIND
      ? currentUnansweredYouSituationMessage
      : currentSituationMessage;
    const forcedSafetyWord = safeWordInputMessage
      ? isBaiyunSafeWordCommand(safeWordInputMessage.text, intimacySafety.safeWord)
      : false;
    const actionInstruction = forcedSafetyWord ? BAIYUN_TRUE_STOP_INSTRUCTION : '';
    const webShareRead = !wishMode && !isInteractionReply && !forcedSafetyWord && !options.dayPlanReceipt
      && !options.dayPlanAdjustment && !options.toolResults?.length
      ? await runChatAuxiliaryOperation(
          { phase: 'prepare', stage: 'share_ledger', step: 'web_share_prepare' },
          () => prepareWebVoyageChatHandoff(),
        ) : null;
    const webShareHandoff = webShareRead?.ok ? webShareRead.value : null;
    const fastReply = shouldUseFastReplyPath(query, lastReplyCompletedAtRef.current);
    const hasScheduleReminder = outgoingMessages.some((message) => message.source === 'schedule-reminder');
    const ambientRoute = selectChatAmbientRoute(query);
    const {
      categories: ambientCategories,
      includeUnavailable: ambientIncludeUnavailable,
      wantsLocation,
      wantsPhoneActivity,
      wantsSchedule,
      wantsTodos,
      wantsWeather,
    } = ambientRoute;
    const routeRecentMessages = outgoingMessages
      .filter((message) => message.id !== latestYouMessage.id && (message.role === 'you' || message.role === 'I'))
      .slice(-6)
      .map((message) => ({ content: message.content, createdAt: message.createdAt, role: message.role }));
    // Both attempts share one material version budget; stage cancellation stays local.
    // The memory bundle opts into its selected raw sources only for a detail view.
    // Other consumers of this shared preparation need current cards, not whole chats.
    const initialMemoryCandidates = !readOnly && useStoredRequestHistory && musicEnabledAtRequest
      ? loadMemories({}, { signal: controller.signal }) : undefined;
    void initialMemoryCandidates?.catch(() => undefined);
    const materialPreparation = createMemoryMaterialPreparation({ signal: controller.signal, initialCandidates: initialMemoryCandidates });
    const memoryPreparationPromise = readOnly ? undefined : prepareChatMemoryRecall({
      signal: controller.signal,
      onDiagnostic: input.onMemoryPreparation,
      // A failed cloud judgment must not veto the configured retrieval itself.
      // Query the actual current words once; do not invent a topic or keywords.
      fallbackRoute: { mode: 'recall', needsRecall: true, needsSourceDetail: false,
        topic: '', keywords: [], routeSource: 'local' },
      route: (signal, timeoutMs) => memoryOrganizerConnection
        ? routeMemoryRecallWithAiDetailed({ apiKey: memoryOrganizerKey, connection: memoryOrganizerConnection,
            recentMessages: routeRecentMessages, signal, source: 'chat', userText: query, timeoutMs })
        : Promise.resolve({ route: null, status: 'not_started' as const, reason: 'configuration_missing',
            startedAt: Date.now(), finishedAt: Date.now() }),
      local: (signal, memoryWorkReporter) => buildGlobalMemoryBundle(query, 'chat', {
        materialPreparation, signal, memoryWorkReporter, numberMemories: true, useSemanticMemory: false, throwOnMemoryError: true,
      }),
      semantic: (route, signal, memoryWorkReporter) => {
        if (!canCommitReplySideEffects() || activeSessionRef.current !== sessionId) {
          controller.abort();
          throw Object.assign(new Error('memory-preparation-cancelled'), { name: 'AbortError' });
        }
        return buildGlobalMemoryBundle(query, 'chat', {
          materialPreparation, signal, memoryWorkReporter, memoryRoute: route, numberMemories: true,
          useSemanticMemory: true, throwOnMemoryError: true,
        });
      },
    });
    // A cancellation may happen while other local preparations are still running.
    void memoryPreparationPromise?.catch(() => undefined);
    const cameraObservationPromise = loadRecentCameraObservationMaterial({
      sessionId,
      recentMessages: outgoingMessages
        .filter((message) => (message.role === 'I' || message.role === 'you') && message.id !== latestYouMessage.id)
        .slice(-4),
    }).catch(() => '');
    const theaterCoCreationSourcesPromise = import('../theater/theaterCoCreationRuntime')
      .then(runtime => runtime.loadTheaterCoCreationSources()).catch(() => []);
    const completed: Partial<ReplyContextCache> & {
      dreamSurface?: DreamSurfacePreparation;
      musicPreferenceContext?: string;
      musicPreferencePreparation?: Awaited<ReturnType<typeof prepareMusicPreferenceMemoryContext>>;
      scheduleNudgeContext?: string;
    } = {};
    const cache = replyContextCacheRef.current;
    const tasks: Promise<unknown>[] = [];
    let cognitionClosed = false;
    const capture = <T,>(
      task: Promise<T>,
      apply: (value: T) => void,
    ) => {
      const guarded = task
        .then((value) => {
          if (!controller.signal.aborted && (readOnly || requestRef.current === controller)) apply(value);
          return value;
        })
        .catch(() => undefined);
      tasks.push(guarded);
      return guarded;
    };

    capture(
      buildGlobalCognitionContext(query, 'chat', {
        readOnly, includeMemory: readOnly, materialPreparation,
        allowNetwork: !readOnly && (wantsWeather || wantsLocation),
        refreshAmbient: !readOnly && (wantsWeather || wantsLocation),
        ambientCategories, ambientIncludeUnavailable,
        signal: controller.signal, touchMemory: false, numberMemories: true, useSemanticMemory: false,
      }),
      (cognition) => {
        if (cognitionClosed || !hasCurrentReplyDataEpoch()) return;
        completed.cognition = cognition;
        if (!readOnly) replyContextCacheRef.current = {
          ...replyContextCacheRef.current, cognition, updatedAt: Date.now(),
        };
      },
    );
    if (!fastReply && !wishMode) {
      capture(
        prepareDreamSurfaceInstruction(query),
        (dreamSurface) => {
          if (dreamSurface) completed.dreamSurface = dreamSurface;
        },
      );
    }
    if (musicEnabledAtRequest && !wishMode) {
      capture(
        prepareMusicPreferenceMemoryContext(materialPreparation, initialMemoryCandidates),
        (musicPreferencePreparation) => {
          if (cognitionClosed) return;
          completed.musicPreferencePreparation = musicPreferencePreparation;
          completed.musicPreferenceContext = musicPreferencePreparation.context;
        },
      );
    }
    if (wantsSchedule || hasScheduleReminder) {
      capture(
        buildRecentScheduleReminderContext(outgoingMessages),
        (scheduleReminderContext) => {
          completed.scheduleReminderContext = scheduleReminderContext;
          if (!readOnly) replyContextCacheRef.current = {
            ...replyContextCacheRef.current,
            scheduleReminderContext,
            updatedAt: Date.now(),
          };
        },
      );
    }
    capture(
      buildCurrentScheduleNudgeContext(lastScheduleNudgeRef.current, readOnly),
      (scheduleNudge) => {
        if (!scheduleNudge) return;
        completed.scheduleNudgeContext = scheduleNudge.context;
        if (!readOnly) lastScheduleNudgeRef.current = {
          occurrenceId: scheduleNudge.occurrenceId,
          nudgedAt: Date.now(),
        };
      },
    );

    const [, memoryPreparation] = await Promise.all([
      readOnly ? Promise.all(tasks) :
      Promise.race([Promise.all(tasks), wait(REPLY_CONTEXT_BUDGET_MS)]),
      memoryPreparationPromise,
    ]);
    cognitionClosed = true;
    if (!canCommitReplySideEffects()) return false;
    replyTiming.contextReadyAt = Date.now();
    // Cached runtime state can help startup; another query's memories and item numbers cannot.
    const cognition: GlobalCognitionContext = completed.cognition ?? {
      activeFocus: cache.cognition?.activeFocus ?? null,
      lastInteractionAt: cache.cognition?.lastInteractionAt ?? null,
      memoryContext: '',
      memoryItems: [],
      runtimeContext: getCachedAmbientContext({ categories: ambientCategories, includeUnavailable: ambientIncludeUnavailable }),
    };
    const memoryRoute = memoryPreparation?.route ?? null;
    if (memoryPreparation?.bundle) attachGlobalMemoryBundle(cognition, memoryPreparation.bundle);
    if (memoryPreparation) cognition.memoryDebug = {
      ...cognition.memoryDebug, counts: cognition.memoryDebug?.counts ?? {},
      dropped: cognition.memoryDebug?.dropped ?? [], preparation: memoryPreparation.diagnostic,
    };
    const dreamSurface = completed.dreamSurface;
    const dreamInstruction = dreamSurface?.instruction ?? '';
    const scheduleReminderContext =
      completed.scheduleReminderContext
      ?? (wantsSchedule || hasScheduleReminder ? cache.scheduleReminderContext : '');
    const keywordCounterPreparationRead = wishMode ? null : await runChatAuxiliaryOperation(
      { phase: 'prepare', stage: 'keyword_counter' },
      () => prepareKeywordCounterInsights(),
    );
    const keywordCounterPreparation = keywordCounterPreparationRead?.ok
      ? keywordCounterPreparationRead.value
      : { insightIds: [], preparedAt: Date.now(), prompt: '', taskIds: [] };
    const keywordCounterInsight = keywordCounterPreparation.prompt;
    let memoryContext = [
      cognition.memoryContext,
      completed.musicPreferenceContext,
    ].filter(Boolean).join('\n\n');
    let postReference = cognition.postReference;
    let postRequestStarted = false;
    let readingSources: ReadingMessageSource[] = [];
    const readingCommand = latestYouMessage.id ? { id: latestYouMessage.id, revision: readingMessageRevision(latestYouMessage) } : undefined;
    const readingSourcesCurrent = () => readingMessageSourcesCurrent(readingSources, id => loadChatSessionMessage(sessionId, id), readingCommand);
    const postSourcesCurrent = async () => await readingSourcesCurrent()
      && (!postReference || await (await import('../posts/baiyunPostKnown')).isPostRecallCurrent(postReference, readOnly));
    const preparePostReference = async () => {
      if (!await readingSourcesCurrent()) throw new Error('reading-chat-source-changed');
      if (await postSourcesCurrent()) return;
      if (postRequestStarted) throw new Error('chat_post_source_changed');
      if (cognition.postContext) memoryContext = memoryContext.replace(cognition.postContext, '').trim();
      postReference = undefined;
    };
    const refreshConversationSummary = async () => {
      try {
        const { prepareChatSummaryCorrectionState } = await import('./chatSummaryCorrectionStore');
        const checked = await prepareChatSummaryCorrectionState(sessionId, compressionStateRef.current, { readOnly });
        return { state: checked.state, text: buildConversationSummaryWithShortLogs(checked.state), failed: false };
      } catch {
        // Read failure cannot certify any old summary; retain the history boundary.
        return { state: compressionStateRef.current, text: '', failed: true };
      }
    };
    const refreshMemoryMaterials = async (preparation?: { continuationMessages: readonly OpenAiCompatibleContinuationMessage[] }) => {
      if (!hasCurrentReplyDataEpoch()) throw new Error('MEMORY_MATERIAL_PREPARATION_CANCELLED');
      if (!readOnly && useStoredRequestHistory && !preparation?.continuationMessages?.length) {
        const music = completed.musicPreferencePreparation;
        if (cognition.refreshMemoryMaterials) await cognition.refreshMemoryMaterials(music?.selectedMemories);
        else if (music) {
          await music.refresh();
          await music.refresh();
        }
        if (music) completed.musicPreferenceContext = music.render();
      } else {
        await cognition.refreshMemoryMaterials?.();
        if (completed.musicPreferencePreparation) {
          completed.musicPreferenceContext = await completed.musicPreferencePreparation.refresh();
          await cognition.refreshMemoryMaterials?.();
          completed.musicPreferenceContext = completed.musicPreferencePreparation.render();
        }
      }
      memoryContext = [cognition.memoryContext, completed.musicPreferenceContext].filter(Boolean).join('\n\n');
      if (!postReference && cognition.postContext) memoryContext = memoryContext.replace(cognition.postContext, '').trim();
      const summary = await refreshConversationSummary();
      if (!hasCurrentReplyDataEpoch()) throw new Error('MEMORY_MATERIAL_PREPARATION_CANCELLED');
      return { memoryContext, conversationSummary: summary.text };
    };
    const cameraObservationContext = await cameraObservationPromise;
    if (!hasCurrentReplyDataEpoch()) return false;
    const recentMusicHistoryContext = musicEnabledAtRequest && !wishMode
      ? buildRecentMusicHistoryContext(outgoingMessages)
      : '';
    const savedScheduleReminders = options.dayPlanReceipt
      ? await prepareSavedChatReminders(sessionId, options.toolResults ?? [], outgoingMessages) : undefined;
    const standaloneReminders = !wishMode && !isInteractionReply
      ? await prepareStandaloneReminderBatch().catch(() => undefined) : undefined;
    const toolResultsAtRequest = [...(savedScheduleReminders?.results ?? options.toolResults ?? [])];
    const inferredPackageIds = new Set([
      ...inferToolPackageIdsFromResults(toolResultsAtRequest),
    ]);
    const providedPackageActivations = options.toolPackageActivations ?? [];
    const providedPackageIds = new Set(providedPackageActivations.map((activation) => activation.packageId));
    const packageIdsToActivate = Array.from(inferredPackageIds).filter((packageId) => !providedPackageIds.has(packageId));
    const inferredPackageActivations = !readOnly && packageIdsToActivate.length
      ? await activateToolPackages(packageIdsToActivate, 'chat:tool_result_or_music')
      : [];
    if (!hasCurrentReplyDataEpoch()) return false;
    const toolPackageActivationsAtRequest = [
      ...providedPackageActivations,
      ...inferredPackageActivations,
    ];
    const toolCompletionGuardContext = {
      phoneLimitDiscoveryResults: [] as JunLuoToolResult[],
      toolPackageActivations: toolPackageActivationsAtRequest,
      toolResults: toolResultsAtRequest,
      unsupportedToolIntent: options.unsupportedToolIntent,
    };
    const preambleMessages = [
      ...(sleepScheduleHost?.material ? [{ role: 'system' as const, content: sleepScheduleHost.material }] : []),
      ...(sleepFarewellMaterial ? [{ role: 'system' as const, content: sleepFarewellMaterial }] : []),
      ...(scheduleRecovery?.context ? [{ role: 'system' as const, content: scheduleRecovery.context }] : []),
      ...(scheduleConflicts?.material ? [{ role: 'system' as const, content: scheduleConflicts.material }] : []),
      ...(options.dayPlanAdjustment ? [{ role: 'system' as const, content: dayPlanModelContext(options.dayPlanAdjustment.plan) }] : []),
    ];
    const currentTimeContext = sleepScheduleHost?.currentTimeContext ?? getAmbientTimeContext();
    const currentAmbientContext = cognition.runtimeContext || currentTimeContext;
    const scheduleNudgeContext = completed.scheduleNudgeContext
      ? `${completed.scheduleNudgeContext}\n${buildScheduleNudgeLifeModeInstruction(assistantStatus.lifeMode)}`
      : '';
    const theaterFactNow = Date.now();
    const theaterCoCreationFact = await theaterCoCreationSourcesPromise
      .then(async sources => (await import('../theater/theaterCoCreationMaterial'))
        .renderLatestTheaterCoCreationFact(sources, theaterFactNow)).catch(() => '');
    if (!canCommitReplySideEffects()) return false;
    const enrichedAmbientContext = [
      currentTimeContext,
      currentAmbientContext.includes(currentTimeContext) ? '' : currentAmbientContext,
      scheduleReminderContext,
      scheduleNudgeContext,
      cameraObservationContext,
      theaterCoCreationFact,
      input.cameraResponseMaterial,
    ].filter(Boolean).join('\n\n');
    const lifeModeText = describeAssistantAvailability(assistantStatus.lifeMode);
    const updatedAtText = assistantStatus.updatedAt > 0
      ? new Date(assistantStatus.updatedAt).toLocaleString('zh-CN')
      : '未记录';
    const trustedLifeStateInstruction = `【I 最近保存的生活状态】

生活模式：${lifeModeText}
状态：${assistantStatus.title}
小动作：${assistantStatus.activity}
记录时间：${updatedAtText}`;
    const contextWindow = chatConnection.contextWindowTokens ?? 65536;
    const checkedSummary = await refreshConversationSummary();
    const requestCompressionState = checkedSummary.state;
    const conversationSummary = checkedSummary.text;
    const requestMessageBudget = Math.max(2048, contextWindow - getReplyTokenReserve(chatConnection) - estimateTextTokens(conversationSummary));
    const historySessionAtRead = activeSessionRef.current;
    const requestHistory = useStoredRequestHistory && outgoingMessages.at(-1)
      ? await loadChatRequestHistory({ sessionId, throughMessage: outgoingMessages.at(-1)!,
          summarizedThroughMessageId: requestCompressionState.summarizedThroughMessageId,
          summarizedThroughAt: requestCompressionState.summarizedThroughAt,
          summaryPaused: checkedSummary.failed || !!requestCompressionState.correctionReview?.pending.length,
          isCurrent: () => !controller.signal.aborted && canCommitReplySideEffects()
            && hasCurrentReplyDataEpoch() && activeSessionRef.current === historySessionAtRead })
      : outgoingMessages;
    let selectedRequestMessages = getRequestMessages(
      requestHistory,
      requestCompressionState,
      requestMessageBudget,
    );
    if (!isInteractionReply && !wishMode) {
      const preparedReferences = await prepareChatReadingReferences(selectedRequestMessages, id => loadChatSessionMessage(sessionId, id));
      selectedRequestMessages = preparedReferences.messages;
      readingSources = preparedReferences.sources;
    }
    const standaloneReminderResults = !wishMode && !isInteractionReply
      ? await reminderExecutionMaterial(selectedRequestMessages).catch(() => '') : '';
    let careSourceMessages = selectedRequestMessages.map((message) => ({
      id: message.id, role: message.role, sentAt: message.createdAt, text: message.content,
    }));
    const careItems = wishMode || isInteractionReply || !continuityContext.available ? [] : selectChatCareItems({
      events: continuityContext.events, links: continuityContext.links, messages: careSourceMessages,
      directReplyTargetId: latestYouMessage.replyTo?.id, now: replyTiming.startedAt,
    });
    const numberedCareMessages = numberCareMessages(careSourceMessages);
    const contactHandoffRead = !wishMode && !isInteractionReply ? await runChatAuxiliaryOperation(
      { phase: 'prepare', stage: 'continuity_ledger' },
      async () => (await import('../proactive/unifiedContactHandoff')).prepareUnifiedContactChatHandoff(readOnly),
    ) : null;
    const unifiedContactHandoff = contactHandoffRead?.ok ? contactHandoffRead.value : null;
    const requestMessages = isInteractionReply || wishMode ? selectedRequestMessages
      : selectedRequestMessages.map((message) => ({
          ...message, content: numberedCareMessages.find((source) => source.id === message.id)!.content,
        }));
    const musicRead = !isInteractionReply && requestMessages.length ? await runChatAuxiliaryOperation(
      { phase: 'prepare', stage: 'continuity_ledger', step: 'music_playback_context' },
      async () => (await import('../music/musicPlaybackMaterial')).prepareMusicPlaybackMaterial({
        from: Math.min(...requestMessages.map(message => message.createdAt)), through: Date.now(),
        excludeToolCallIds: toolResultsAtRequest.map(result => result.callId),
      }),
    ) : null;
    const musicPlaybackEvents = musicRead?.ok ? musicRead.value : [];
    const visibleOnlyResponseInstructions = [
      trustedLifeStateInstruction,
      unifiedContactHandoff?.material ?? '',
      webShareHandoff?.instruction ?? '',
      desirePaper,
      bodySignalCareDoorbell.instruction,
      keywordCounterInsight,
      dreamInstruction,
      recentMusicHistoryContext,
      wishTurn.material,
    ].filter(Boolean);
    const fixedResponseDataInstructions = [
      !wishMode && !isInteractionReply ? [buildChatCareContext(careItems), buildChatCareGuidance(careItems)].filter(Boolean).join('\n\n') : '',
      !wishMode && !isInteractionReply ? CHAT_PRESENCE_GUIDANCE : '',
      pendingShareContext.fixedItems.length
        ? `${BAIYUN_CHAT_FIXED_SHARE_RESPONSE_GUIDANCE_PROTOCOL}\n\n${pendingShareContext.fixedInstruction}`
        : '',
    ];
    type ResponseInstructionScope = 'full' | 'visible_only';
    const buildOrdinaryResponseInstruction = (
      extraInstruction?: string,
      scope: ResponseInstructionScope = 'full',
      includeFixedData = true,
      includeDream = true,
      includeToolResults = true,
    ) => {
      const requestVisibleOnlyResponseInstructions = includeDream
        ? visibleOnlyResponseInstructions
        : visibleOnlyResponseInstructions.filter(
          (instruction) => instruction !== dreamInstruction,
        );
      return [
        ...(scope === 'visible_only' && !wishMode
          ? requestVisibleOnlyResponseInstructions
          : [forcedSafetyWord ? actionInstruction : '', ...requestVisibleOnlyResponseInstructions]),
        ...(scope === 'full' && includeFixedData ? fixedResponseDataInstructions : []),
        includeToolResults ? buildToolResultInstruction(toolResultsAtRequest) : '',
        savedScheduleReminders?.packet ?? '',
        chatReminderInstruction(savedScheduleReminders?.batch),
        standaloneReminders?.packet ?? '',
        standaloneReminders?.instruction ?? '',
        standaloneReminderResults,
        extraInstruction ?? '',
      ].filter(Boolean).join('\n\n') || undefined;
    };

    return { standaloneReminders, savedScheduleReminders, imageSourceMessages: selectedRequestMessages, refreshMemoryMaterials,
      refreshConversationSummary: async () => {
        const summary = await refreshConversationSummary();
        if (!hasCurrentReplyDataEpoch()) throw new Error('MEMORY_MATERIAL_PREPARATION_CANCELLED');
        return summary.text;
      }, query, actionInstruction, memoryRoute, bodySignalCareDoorbell,
      currentSituationMessage, previousSituationMessages, currentUnansweredYouSituationMessage, continuityContext,
      pendingShareContext, forcedSafetyWord, webShareHandoff, cognition, dreamSurface, dreamInstruction,
      keywordCounterPreparation, keywordCounterInsight, get memoryContext() { return memoryContext; },
      preparePostReference, postSourcesCurrent, markPostRequestStarted: () => { postRequestStarted = true; },
      get postReference() { return postReference; },
      readingSources, scheduleConflicts, currentTurnStart, toolResultsAtRequest, toolPackageActivationsAtRequest,
      toolCompletionGuardContext, preambleMessages, enrichedAmbientContext, conversationSummary, requestMessages,
      careItems, careSourceMessages, numberedCareMessages, unifiedContactHandoff, musicPlaybackEvents,
      buildOrdinaryResponseInstruction };
  };

  const prepareBackstageCapacityRequest = async (): Promise<BackstageCapacityInput> => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    const sessionId = activeSessionRef.current;
    if (!chatConnection || !sessionId || dataEpoch === null) throw new Error('backstage-chat-not-ready');
    const outgoingMessages = messagesSessionIdRef.current === sessionId ? [...messagesRef.current]
      : [...(sessionsRef.current.find(session => session.id === sessionId)?.messages ?? [])];
    // Empty lookup values are never appended to the real history or sent as a you message.
    const latestYouMessage = outgoingMessages.findLast(message => message.role === 'you')
      ?? { id: '', role: 'you' as const, content: '', createdAt: 0 };
    const sourceKey = JSON.stringify(outgoingMessages);
    const current = () => canCommitBackupRestoreDataEpoch(dataEpoch) && activeSessionRef.current === sessionId
      && JSON.stringify(messagesSessionIdRef.current === sessionId ? messagesRef.current
        : sessionsRef.current.find(session => session.id === sessionId)?.messages ?? []) === sourceKey;
    const controller = new AbortController();
    const startedAt = Date.now(), musicPreferences = getPreferencesSnapshot();
    const sleepScheduleHost = await prepareChatSleepScheduleHost({ sessionId, turnId: latestYouMessage.id,
      sourceMessageIds: outgoingMessages.filter(message => message.role === 'you').map(message => message.id),
      dataEpoch, startedAt, signal: controller.signal, readOnly: true });
    const scheduleRecovery = await loadScheduleRecoveryBatch(sessionId, outgoingMessages, startedAt, true).catch(() => null);
    const sleepFarewellMaterial = await readChatSleepFarewellMaterial({ sessionId, turnId: latestYouMessage.id });
    const wishTurn = await prepareWishChatTurn(sessionId, false, true);
    const prepared = await prepareReplyMaterials({ wishTurn, options: {}, sessionId, outgoingMessages, latestYouMessage,
      currentYouTurn: getCurrentYouTurn(outgoingMessages), isInteractionReply: false,
      latestYouAlreadyAnswered: answeredYouMessageIdsRef.current.has(latestYouMessage.id),
      shouldTrackDelivery: !!latestYouMessage.id, lastOutgoingMessage: outgoingMessages.at(-1),
      currentUnansweredYouMessageBeforeInteraction: outgoingMessages.at(-1)?.role === 'you' ? outgoingMessages.at(-1) : undefined,
      musicEnabledAtRequest: musicPreferences.musicEnabled, controller, replyTiming: { startedAt, contextReadyAt: 0 },
      sleepScheduleHost, sleepFarewellMaterial, scheduleRecovery, readOnly: true,
      hasCurrentReplyDataEpoch: current, canCommitReplySideEffects: current,
      runChatAuxiliaryOperation: async (_input, operation) => {
        try { return { ok: true, value: await operation() }; } catch (error) { return { ok: false, error, diagnostic: {} }; }
      },
    });
    if (!prepared || !current()) throw new Error('backstage-chat-changed');
    await prepared.preparePostReference();
    const { selected, hasReadingReferences } = await prepareProductionChatToolCandidates({ readOnly: true,
      readingSources: prepared.readingSources,
      imageSourceMessages: prepared.imageSourceMessages,
      sourceMessageId: latestYouMessage.id, sourceSessionId: sessionId, dataEpoch, sleepScheduleHost,
      musicPreferences, youText: getCurrentYouTurn(outgoingMessages) || latestYouMessage.content,
      recentMessages: outgoingMessages.slice(-4).map(message => ({ id: message.id, subject: message.role, content: message.content })),
      chatOptions: { signal: controller.signal, messages: prepared.requestMessages },
    });
    const base = { apiKey: chatKey, connection: chatConnection, profile,
      ambientContext: prepared.enrichedAmbientContext, conversationSummary: prepared.conversationSummary,
      memoryContext: prepared.memoryContext, messages: prepared.requestMessages,
      musicPlaybackEvents: prepared.musicPlaybackEvents, sleepScheduleMessages: prepared.preambleMessages,
      includeToolPromptTokens: true, contextSource: 'chat.main' as const,
      qwenChatLayout: wishTurn.discussion ? undefined : 'ordinary' as const,
      responseEnvelopeMode: 'messages_with_semantic' as const, semanticEnvelopeProtocol: 'single_root_json' as const,
      fixedEnvelopeMode: wishTurn.discussion ? 'wish' as const : undefined,
      responseInstruction: prepared.buildOrdinaryResponseInstruction(),
    };
    const request = selected.selection.mode === 'chat_only' ? base
      : await prepareInitialToolAgentChatOptions(withChatReadingReferenceInstruction(base, hasReadingReferences), selected.selection);
    const envelope = await buildChatCompletionPromptEnvelope({ ...request, readOnlyPreparation: true });
    if (!current()) throw new Error('backstage-chat-changed');
    return withoutBackstageShares({ ...request, preparedCompiledPrompt: envelope.compiledPrompt,
      preparedAmbientContext: envelope.runtimeAmbientContext }, {
      webShare: prepared.webShareHandoff?.instruction ?? '', keywordInsight: prepared.keywordCounterInsight,
      pendingShares: prepared.pendingShareContext.fixedItems,
    });
  };

  const cancelActiveReply = (options: { preservePendingDraft?: boolean } = {}) => {
    const draftSessionId = replySessionIdRef.current ?? activeSessionRef.current;
    if (draftSessionId && !options.preservePendingDraft) void discardPendingChatReplyDraft(draftSessionId).catch(() => {
      if (mountedRef.current && activeSessionRef.current === draftSessionId) setError('停止回复的记录未能保存，请保持当前页面并稍后重试。');
    });
    const preparation = replyPreparationOwners.get(requestRef);
    if (preparation) {
      preparation.cancelled = true;
      preparation.finish();
      preparation.clearIndicator();
      replyPreparationOwners.delete(requestRef);
    }
    toolAgentTurnController.cancel('you_stopped');
    const controller = requestRef.current;
    if (controller) {
      if (options.preservePendingDraft) replyLifecycleInterruptedControllers.add(controller);
      controller.abort();
      if (requestRef.current === controller) requestRef.current = null;
      if (replyRuntimeStartedControllers.delete(controller)) {
        void markChatReplyFinished(CHAT_REPLY_ABORTED_REASON, { persist: false }).catch(() => undefined);
      }
    }
    const hadActiveReply = !!preparation || !!controller || sendingRef.current;
    sendingRef.current = false;
    if (mountedRef.current) setSending(false);
    return hadActiveReply;
  };

  const runReply = async (options: RunChatReplyOptions = {}): Promise<boolean> => {
    // Reuse the existing one-shot, tools-disabled saved-card feedback rail.
    if (options.reminderReceipt) options = { ...options, expenseReceipt: options.reminderReceipt };
    if (sendingRef.current || replyPreparationOwners.has(requestRef)) return false;
    const runReplyEnteredAt = Date.now();
    const sendAction = runtime.sendActionRef?.current;
    // Claim the fresh-send proof before any asynchronous preparation; a failed attempt cannot lend it to a retry.
    if (sendAction) runtime.sendActionRef!.current = null;
    const finishBackground = beginChatReplyBackground();
    const preparation = { cancelled: false, finish: finishBackground, clearIndicator: () => {
      if (mountedRef.current) runtime.setPreparingReplySessionId?.(null);
    } };
    const activeSessionAtEntry = activeSessionRef.current;
    replyPreparationOwners.set(requestRef, preparation);
    const preparationCurrent = () => !preparation.cancelled
      && replyPreparationOwners.get(requestRef) === preparation
      && activeSessionRef.current === activeSessionAtEntry;
    try {
    const isExpenseFeedback = !!options.expenseReceipt;
    // Bind once: a replacement card cannot enter this reply's retries/tool continuations.
    if (options.expenseReceipt && (options.expenseReceipt.remainingRequests !== 1 || !await options.expenseReceipt.isCurrent())) return false;
    if (!preparationCurrent()) return false;
    const dataEpoch = options.dataEpoch === undefined
      ? captureBackupRestoreDataEpoch()
      : options.dataEpoch;
    if (dataEpoch === null || !canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
    const toolAgentDataEpoch = dataEpoch;
    if (sendingRef.current) {
      setReplyPhase('idle');
      return false;
    }

    const sessionId = options.sourceSessionId ?? pendingReplySessionIdRef.current ?? activeSessionRef.current;
    pendingReplySessionIdRef.current = null;
    if (!sessionId) {
      setReplyPhase('idle');
      return false;
    }
    // Resolve a retained body before configuration/material/model work. This branch is local-only.
    const canResumeOrdinary = !options.cameraObservationReply && !options.expenseReceipt && !options.dayPlanReceipt
      && !options.dayPlanAdjustment && !options.interactionInstruction && !options.interactionKind
      && !options.pokeInteraction && !options.sleepClaim;
    if (canResumeOrdinary || options.resumeReplyDraft) {
      let pending: ChatReplyDraft | null;
      try { pending = await loadPendingChatReplyDraft(sessionId); }
      catch {
        if (mountedRef.current) setError('待保存的回复暂时无法读取，请稍后重新打开聊天。');
        return false;
      }
      if (!preparationCurrent() || !canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
      if (pending) {
        const originalSourceId = pending.source.messageId;
        const recoveryController = new AbortController();
        requestRef.current = recoveryController;
        sendingRef.current = true;
        replySessionIdRef.current = sessionId;
        if (mountedRef.current) { setSending(true); setReplySessionId(sessionId); }
        let recovered: 'saved' | 'stale' | 'pending' = 'pending';
        const resident = () => activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
          ? messagesRef.current : sessionsRef.current.find(session => session.id === sessionId)?.messages ?? [];
        try {
          recovered = await recoverChatReplyDraft(pending, { dataEpoch,
            interruptedForLifecycle: () => replyLifecycleInterruptedControllers.has(recoveryController),
            current: () => {
              const latestYou = resident().findLast(message => message.role === 'you');
              return preparationCurrent() && !recoveryController.signal.aborted
                && requestRef.current === recoveryController && !draftRef.current.trim()
                && (!latestYou || latestYou.id === originalSourceId);
            },
            deliver: (draft, current) => appendAssistantBubbles([], {}, [], current,
              { targetSessionId: sessionId, preparedMessages: draft.messages }),
            removeTentative: ids => {
              const removed = new Set(ids);
              commitSessionMessages(sessionId, resident().filter(message => !removed.has(message.id)));
            },
            receiptPending: () => {
              if (mountedRef.current && activeSessionRef.current === sessionId) setError('回复已保存，部分交付确认等待本地补存。');
            },
          });
          if (recovered === 'saved') answeredYouMessageIdsRef.current.add(pending.source.messageId);
        } catch {
          if (mountedRef.current && !recoveryController.signal.aborted) setError('回复原稿已保留，保存尚未完成；重新打开聊天后会继续补存。');
        } finally {
          if (requestRef.current === recoveryController) {
            requestRef.current = null;
            sendingRef.current = false;
            replySessionIdRef.current = null;
            if (mountedRef.current) { setSending(false); setReplySessionId(null); setReplyPhase('idle'); }
          }
        }
        if (options.resumeReplyDraft || recovered === 'pending') return recovered === 'saved';
        if (recovered === 'saved' && resident().findLast(message => message.role === 'you')?.id === pending.source.messageId) return true;
        if (!preparationCurrent()) return false;
      }
    } else await discardPendingChatReplyDraft(sessionId);
    if (options.resumeReplyDraft) return false;
    const cameraResponse = options.cameraObservationReply || (!options.expenseReceipt && !options.dayPlanReceipt && !options.interactionInstruction)
      ? await prepareCameraObservationResponse({ sessionId, dataEpoch,
        observationId: options.cameraObservationReply?.observationId,
        manualShare: !!options.cameraObservationReply && !options.cameraObservationReply.resumeDraft }) : undefined;
    const cameraDraft = cameraResponse?.response.draft;
    if (options.cameraObservationReply && (!cameraResponse || options.cameraObservationReply.resumeDraft && !cameraDraft)) return false;
    // A previously adopted paid body needs only local storage, not model configuration or context preparation.
    if (cameraDraft && cameraResponse) {
      const current = async () => preparationCurrent() && canCommitBackupRestoreDataEpoch(dataEpoch)
        && await cameraResponse.current();
      try {
        let saved: Awaited<ReturnType<typeof appendMessagesToChatSession>> | undefined;
        for (let attempt = 0; attempt < 4 && await current(); attempt += 1) {
          try {
            saved = await appendMessagesToChatSession(sessionId, cameraDraft.messages,
              { dataEpoch, beforeAppend: current });
            if (cameraDraft.messages.every(message => saved?.messages.some(item => item.id === message.id
              && item.role === 'I' && item.content === message.content))) break;
          } catch { /* Retry only the same local draft and stable message IDs. */ }
        }
        if (!saved || !cameraDraft.messages.every(message => saved!.messages.some(item => item.id === message.id
          && item.role === 'I' && item.content === message.content))) throw new Error(CHAT_REPLY_PERSIST_FAILURE_CODE);
        const resident = activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
          ? messagesRef.current : sessionsRef.current.find(session => session.id === sessionId)?.messages ?? [];
        const additions = cameraDraft.messages.filter(message => !resident.some(item => item.id === message.id));
        commitSessionMessages(sessionId, mergeSubjectiveMessages([...resident, ...cameraDraft.messages], resident));
        emitChatMessagesAppended({ sessionId, messages: additions, source: 'camera-same-turn' });
        // The adopted inner reaction is a local write; no memory routing, compression or affect model is rerun.
        const inspection = inspectBaiyunFixedChatEnvelope(cameraDraft.adoptedReply ?? '');
        const inner = inspection.fields.innerReaction;
        if (inner.status === 'valid' && inner.value && await current()) {
          const notebook = await prepareNotebookAction({ assistantContents: cameraDraft.messages.map(message => message.content),
            hiddenRequests: [{ content: inner.value }], mode: 'inner_reaction',
            sourceMessageId: cameraResponse.response.binding.sourceTurnId, userText: '' });
          if (notebook.ready && await current()) {
            const commit = await runBackupRestoreDataEpochCommit(dataEpoch,
              () => current().then(valid => valid ? commitPreparedNotebookAction(notebook) : undefined));
            if (!commit.committed || !commit.value) throw new Error('camera_reply_stale');
            if (!commit.value.ok && commit.value.reason === 'write-failed') throw new Error('notebook_write_failed');
          }
        }
        await completeCameraResponseDelivery({ observationIds: [cameraResponse.record.observationId], sessionId,
          messageIds: cameraDraft.messages.map(message => message.id), dataEpoch, canCommit: preparationCurrent });
        if (!options.cameraObservationReply?.resumeDraft && resident.at(-1)?.role === 'you'
          && resident.at(-1)?.id !== cameraResponse.response.binding.sourceTurnId) {
          needsFollowUpRef.current = true;
          scheduleReply(undefined, sessionId, dataEpoch);
        }
        return true;
      } catch (error) {
        if (preparationCurrent() && canCommitBackupRestoreDataEpoch(dataEpoch)) {
          setError('摄像头回应暂未保存；下一次聊天会补存原稿。');
        }
        return false;
      }
    }
    if (!chatConnection || !chatKey.trim()) {
      setReplyPhase('idle');
      return false;
    }
    const backstageBatchId = options.expenseReceipt ? null : options.backstageResume ? options.backstageResume.batchId : theaterBackstage?.session.beginReply() ?? null;
    const backstageReplyId = options.backstageResume?.replyId ?? (theaterBackstage ? createSubjectiveMessage('I', '').id : '');
    const isCameraExplicitReply = !!options.cameraObservationReply;
    // A button is a technical source, not a you utterance. It never enters outgoingMessages.
    const cameraReplySource: SubjectiveMessage | undefined = isCameraExplicitReply && cameraResponse
      ? { id: cameraResponse.response.binding.sourceTurnId, role: 'I', content: '',
          createdAt: cameraResponse.response.binding.requestedAt }
      : undefined;
    replySessionIdRef.current = sessionId;
    setReplySessionId(sessionId);
    const isReplySessionActive = activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId;
    const targetSession = sessionId ? sessionsRef.current.find((session) => session.id === sessionId) : undefined;
    const persistedMessages = isReplySessionActive
      ? messagesRef.current
      : targetSession?.messages ?? [];
    const replyPoke = options.pokeInteraction ? { ...options.pokeInteraction,
      replyToMessageIds: options.sleepClaim?.messageIds ?? persistedMessages
        .slice(persistedMessages.findLastIndex(message => message.role === 'I') + 1)
        .filter(message => message.role === 'you').map(message => message.id),
      ...(options.sleepClaim ? { sleepMessageIds: options.sleepClaim.messageIds } : {}),
    } : undefined;
    const lastPersistedMessage = persistedMessages[persistedMessages.length - 1];
    const currentUnansweredYouMessageBeforeInteraction = lastPersistedMessage?.role === 'you'
      ? lastPersistedMessage
      : undefined;
    const interactionMessage = options.interactionInstruction
      ? createSubjectiveMessage('you', `【即时互动】${options.interactionInstruction}`)
      : null;
    const isInteractionReply = Boolean(interactionMessage);
    const sleepingReplySourceIds = options.sleepClaim
      ? options.sleepClaim.sessionId === sessionId ? [...options.sleepClaim.messageIds] : []
      : !isInteractionReply && !isCameraExplicitReply && !options.interactionKind && !options.pokeInteraction
        && !options.dayPlanReceipt && !options.dayPlanAdjustment && !options.expenseReceipt && !options.reminderReceipt
        ? persistedMessages.slice(persistedMessages.findLastIndex(message => message.role === 'I') + 1)
          .filter(message => message.role === 'you' && message.deliveryStatus !== CHAT_DELIVERY_FAILED).map(message => message.id)
        : [];
    // An old persistent card need not have its original you in the resident page.
    // Read the actual saved source; keep its original identity/time only in request history.
    const expenseSource = options.expenseReceipt
      ? await loadChatSessionMessage(sessionId, options.expenseReceipt.sourceMessageId) : null;
    if (!preparationCurrent() || !canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
    const requestHistory = expenseSource?.role === 'you'
      ? mergeSubjectiveMessages([expenseSource], persistedMessages) : persistedMessages;
    const outgoingMessages = interactionMessage ? [...requestHistory, interactionMessage] : requestHistory;
    const latestYouMessage = cameraReplySource ?? (options.expenseReceipt
      ? expenseSource?.role === 'you' ? expenseSource : undefined
      : [...outgoingMessages].reverse().find((message) => message.role === 'you'));
    const lastOutgoingMessage = outgoingMessages[outgoingMessages.length - 1];
    const latestYouAlreadyAnswered =
      !isInteractionReply && latestYouMessage
        ? answeredYouMessageIdsRef.current.has(latestYouMessage.id)
        : false;
    if (
      !latestYouMessage ||
      (!options.dayPlanReceipt && !options.expenseReceipt && !isInteractionReply && latestYouMessage.deliveryStatus === CHAT_DELIVERY_FAILED) ||
      (options.backstageResume && latestYouMessage?.id !== options.backstageResume.sourceMessageId) ||
      (!isCameraExplicitReply && !options.backstageResume && !options.dayPlanReceipt && !options.expenseReceipt && !isInteractionReply && lastOutgoingMessage?.role === 'I' && (!needsFollowUpRef.current || latestYouAlreadyAnswered))
    ) {
      replySessionIdRef.current = null;
      setReplySessionId(null);
      setReplyPhase('idle');
      return false;
    }
    const musicPreferencesAtRequest = getPreferencesSnapshot();
    const musicEnabledAtRequest = musicPreferencesAtRequest.musicEnabled;
    const currentYouTurn = isCameraExplicitReply ? latestYouMessage.content : getCurrentYouTurn(outgoingMessages);
    const shouldTrackDelivery = !options.dayPlanReceipt && !options.expenseReceipt && !isInteractionReply && latestYouMessage.role === 'you';
    const preReplyMessages = persistedMessages;
    const replyDiagnostic = createChatReplyDiagnosticCollector({
      sessionId, sourceMessageId: latestYouMessage.id,
      connectionId: chatConnection.id, connectionName: chatConnection.name, model: chatConnection.model,
      replyPurpose: options.dayPlanAdjustment ? 'day_plan_adjustment' : options.dayPlanReceipt ? 'day_plan_receipt' : 'ordinary',
    });
    const appLaunchOpportunity = sendAction?.messageId === latestYouMessage.id && !isInteractionReply && !options.sleepClaim
      && !options.backstageResume && !options.dayPlanReceipt && !options.expenseReceipt
      ? createAppLaunchOpportunity(latestYouMessage.id) : undefined;
    const dialerOpportunity = sendAction?.messageId === latestYouMessage.id && !isInteractionReply && !options.sleepClaim
      && !options.backstageResume && !options.dayPlanReceipt && !options.expenseReceipt
      ? createDialerOpportunity(latestYouMessage.id) : undefined;
    if (sendAction?.messageId === latestYouMessage.id) {
      replyDiagnostic.markSendStartedAt(sendAction.startedAt);
      for (const key of ['youPersistedAt', 'sleepAcceptedAt', 'replyQueuedAt'] as const) {
        if (sendAction[key] !== undefined) replyDiagnostic.markPreparationCheckpoint(key, sendAction[key]);
      }
    }
    replyDiagnostic.markPreparationCheckpoint('runReplyEnteredAt', runReplyEnteredAt);
    replyDiagnosticOwners.set(requestRef, replyDiagnostic.turnAttemptId);
    const ownsDiagnostic = () => replyDiagnosticOwners.get(requestRef) === replyDiagnostic.turnAttemptId;
    if (mountedRef.current && activeSessionRef.current === sessionId) setError(null);
    const runChatAuxiliaryOperation = async <T,>(
      input: Parameters<typeof runChatAuxiliaryOperationBase>[0], operation: () => Promise<T>,
    ) => {
      const result = await runChatAuxiliaryOperationBase(input, operation);
      if (!result.ok) replyDiagnostic.auxiliaryFailures.push({
        phase: input.phase, stage: input.stage, step: input.step, at: Date.now(),
        ...result.diagnostic,
      });
      return result;
    };
    // Presentation only: source saving must not create a gap or start sending early.
    if (mountedRef.current) runtime.setPreparingReplySessionId?.(sessionId);
    const userMessagePersisted = options.expenseReceipt ? await options.expenseReceipt.isCurrent()
      : await persistSessionMessages(sessionId, preReplyMessages) !== CHAT_PERSIST_FAILED;
    if (!preparationCurrent() || !canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
    if (shouldMarkChatMessageFailed({ userMessagePersisted })) {
      const message = CHAT_LOCAL_PERSIST_FAILURE_MESSAGE;
      const entry = replyDiagnostic.failureSnapshot({ code: 'source_message_persist_failed',
        stage: CHAT_REPLY_FAILURE_STAGES.sessionPersist,
      }, { replyPersisted: false, replyPersistAttempts: 0 });
      void recordBaiyunChatReplyFailureDiagnostic(entry).catch(() => undefined);
      if (ownsDiagnostic() && mountedRef.current && activeSessionRef.current === sessionId) {
        setError(describeChatReplyFailure(entry));
        try { runtime.onReplyFailureDiagnostic?.(entry); } catch { /* Observation only. */ }
      }
      if (shouldTrackDelivery) {
        updateMessageDeliveryStatus(latestYouMessage.id, CHAT_DELIVERY_FAILED, message, sessionId);
        const failedMessages = activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
          ? messagesRef.current
          : sessionsRef.current.find((session) => session.id === sessionId)?.messages ?? persistedMessages;
        void persistSessionMessages(sessionId, failedMessages);
      }
      replySessionIdRef.current = null;
      setReplySessionId(null);
      setReplyPhase(CHAT_REPLY_IDLE);
      return false;
    }
    replyDiagnostic.markPreparationCheckpoint('sourceReadyAt');
    if (options.expenseReceipt && (!await options.expenseReceipt.isCurrent() || sendingRef.current)) return false;
    if (!preparationCurrent() || !canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
    if (requestRef.current) {
      requestRef.current.abort();
      requestRef.current = null;
    }

    const outgoingIds = new Set(outgoingMessages.map((message) => message.id));
    const factMessagesInRequest = [...pendingFactMessagesRef.current];
    needsFollowUpRef.current = false;
    unstable_batchedUpdates(() => {
      setQueuedMessageCount(0);
      sendingRef.current = true;
      setSending(true);
      setReplyPhase('requesting');
    });

    let scheduleFollowUpAfterRequest = false;
    let insertedReply = false;
    let replyPersisted = false;
    let backstageCapacityPending = false;
    const modelRequestBudget = createChatModelRequestBudget(options.expenseReceipt?.remainingRequests ?? options.backstageResume?.remainingRequests ?? 3);
    let replyPersistAttempts = 0;
    let insertedMessageCount = 0;
    let parsedReplyDiagnostic: Parameters<typeof recordBaiyunChatSemanticDiagnostic>[0] | undefined;
    let ownedReplyMessageIds: string[] = [];
    let cameraBodyCommitted: (() => Promise<void>) | undefined;
    let releaseReplyMessageIds: (() => void) | undefined;
    let ordinaryReplyDraft: ChatReplyDraft | undefined;
    let ordinaryReplyDraftSaved = false;
    let ordinaryDraftSourcesCurrent: (() => Promise<boolean>) | undefined;
    const ordinaryReceiptsDone = new Set<ChatReplyDraftReceipt>();
    let sleepClaimConfirmed = false;
    const confirmSavedSleepingMessages = async () => {
      if (!insertedReply || !replyPersisted || sleepClaimConfirmed || !sleepingReplySourceIds.length) return;
      // A later cancellation cannot undo a saved reply; only a data restore invalidates this receipt.
      const commit = await runBackupRestoreDataEpochCommit(dataEpoch,
        () => completeSleepingMessages(sessionId, sleepingReplySourceIds));
      if (commit.committed) { sleepClaimConfirmed = true; ordinaryReceiptsDone.add('sleep'); }
    };
    let activeAuxiliaryPhase: ChatAuxiliaryPhase | null = null;
    let activeAuxiliaryStage: ChatAuxiliaryStage | null = null;
    let activeFailureStage: ChatReplyFailureStage = CHAT_REPLY_FAILURE_STAGES.internalPipeline;
    let staleDataEpochRecorded = false;
    const attemptDiagnostics = replyDiagnostic.attempts;
    let diagnosticFinalized = false;
    let lastDiagnosticFailure: ChatReplyFailureClassification | undefined;
    let currentAttemptSnapshot: BaiyunChatModelAttemptDiagnostic | undefined;
    let currentAttemptReplyDiagnostics: ChatReplyDiagnostics | undefined;
    let publishPreparedMemories: (() => void) | undefined;
    const observeTransportAttempt = (event: ChatTransportAttemptEvent) => {
      if (event.phase === 'started') {
        currentAttemptReplyDiagnostics = undefined;
        publishPreparedMemories?.();
      }
      replyDiagnostic.observeTransportAttempt(event);
      currentAttemptSnapshot = replyDiagnostic.current();
      if (event.phase === 'finished') refreshFinalDiagnostic();
    };
    const observeReplyDiagnostics = (diagnostics: ChatReplyDiagnostics) => {
      currentAttemptReplyDiagnostics = diagnostics;
      replyDiagnostic.observeReplyDiagnostics(diagnostics);
      refreshFinalDiagnostic();
    };
    let replyFailureRecorded = false;
    const recordReplyFailure = (failure: ChatReplyFailureClassification) => {
      replyFailureRecorded = true;
      lastDiagnosticFailure = failure;
      const entry = replyDiagnostic.failureSnapshot(failure, { replyPersisted, replyPersistAttempts });
      void recordBaiyunChatReplyFailureDiagnostic(entry).catch(() => undefined);
      return entry;
    };
    const refreshFinalDiagnostic = () => {
      if (!diagnosticFinalized) return;
      if (parsedReplyDiagnostic) void recordBaiyunChatSemanticDiagnostic({
        ...parsedReplyDiagnostic, ...replyDiagnostic.snapshot(), replyPersisted, replyPersistAttempts, insertedMessageCount,
      }).catch(() => undefined);
      const lateFailureCode = replyDiagnostic.current()?.failureCode;
      const failure = lateFailureCode && lateFailureCode !== lastDiagnosticFailure?.code
        ? { code: lateFailureCode, stage: getChatReplyFailureStage(lateFailureCode) } : lastDiagnosticFailure;
      if (failure) recordReplyFailure(failure);
    };
    const displayReplyFailure = (entry: BaiyunChatReplyFailureDiagnosticEntry) => {
      if (!ownsDiagnostic() || !mountedRef.current || activeSessionRef.current !== sessionId || requestRef.current !== controller) return;
      setError(describeChatReplyFailure(entry));
      try { runtime.onReplyFailureDiagnostic?.(entry); } catch { /* Observation cannot change delivery. */ }
    };
    const hasCurrentReplyDataEpoch = () => {
      const current = canCommitBackupRestoreDataEpoch(dataEpoch);
      if (!current && !staleDataEpochRecorded) {
        staleDataEpochRecorded = true;
        recordReplyFailure(classifyChatReplyFailure({
          dataEpochCurrent: false,
          error: undefined,
          stage: activeFailureStage,
        }));
      }
      return current;
    };
    const controller = new AbortController();
    controller.signal.addEventListener('abort', finishBackground, { once: true });
    const sleepReplyStartedAt = Date.now();
    const sleepReply = createChatSleepReplyLifecycle({ sessionId, turnId: latestYouMessage.id, dataEpoch,
      startedAt: sleepReplyStartedAt, sourceMessageIds: persistedMessages.slice(persistedMessages.findLastIndex(message => message.role === 'I') + 1)
        .filter(message => message.role === 'you').map(message => message.id) });
    const canCommitReplySideEffects = () => !controller.signal.aborted
      && requestRef.current === controller && hasCurrentReplyDataEpoch() && sleepReply.active();
    const commitBackstageSource = async (source: TheaterBackstageMessageSource | undefined, messageIds: string[]) => {
      if (!source || !theaterBackstage || !messageIds.length || !canCommitReplySideEffects()) return;
      const saveReceipt = async () => {
        if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('backstage-receipt-restore-invalidated');
        const marked = await recordTheaterBackstageReplySource(sessionId, messageIds, source);
        ordinaryReceiptsDone.add('backstage');
        const current = activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
          ? messagesRef.current : sessionsRef.current.find(session => session.id === sessionId)?.messages;
        const sources = new Map(marked.map(message => [message.id, message.theaterBackstage]));
        if (current) commitSessionMessages(sessionId, current.map(message => sources.has(message.id)
          ? { ...message, theaterBackstage: sources.get(message.id), theaterBackstagePending: undefined } : message));
      };
      await runChatAuxiliaryOperation({ phase: 'commit', stage: 'share_ledger', retryLocalSave: true },
        () => theaterBackstage.session.replySaved(source, saveReceipt));
    };
    requestRef.current = controller;
    preparation.clearIndicator();
    replyPreparationOwners.delete(requestRef);
    const unsubscribeRestore = subscribeBackupRestoreRuntimeState(state => {
      if (state.status !== 'ready') controller.abort();
    });
    const replyTiming = {
      startedAt: Date.now(),
      contextReadyAt: 0,
      firstRequestStartedAt: 0,
      firstResponseAt: 0,
      retryRequestStartedAt: 0,
      retryResponseAt: 0,
    };
    const replyStarted = await runBackupRestoreDataEpochCommit(
      dataEpoch,
      () => markChatReplyStarted(),
    ).catch(() => ({ committed: false as const }));
    if (replyStarted.committed) replyRuntimeStartedControllers.add(controller);
    if (!replyStarted.committed || controller.signal.aborted || requestRef.current !== controller) {
      unsubscribeRestore();
      await sleepReply.finish([], false).catch(() => undefined);
      if (replyRuntimeStartedControllers.delete(controller)) {
        await markChatReplyFinished(CHAT_REPLY_ABORTED_REASON, { persist: false }).catch(() => undefined);
      }
      if (canCommitBackupRestoreDataEpoch(dataEpoch)) void import('../life/sleepPlanRuntime')
        .then(({ reconcileSleepPlan }) => canCommitBackupRestoreDataEpoch(dataEpoch) ? reconcileSleepPlan(Date.now(), dataEpoch, true) : undefined).catch(() => undefined);
      if (requestRef.current === controller) {
        requestRef.current = null;
        sendingRef.current = false;
        if (mountedRef.current) {
          setSending(false);
          if (replySessionIdRef.current === sessionId) {
            replySessionIdRef.current = null;
            setReplySessionId(null);
          }
          setReplyPhase('idle');
        }
      }
      return false;
    }
    let releaseWishTurn: (() => void) | undefined;
    try {
      releaseWishTurn = holdWishChatTurn();
      const wishTurn = await prepareWishChatTurn(sessionId, isInteractionReply, !!options.expenseReceipt);
      const wishMode = Boolean(wishTurn.discussion);
      const directOrdinaryChat = isOfficialQwen397bConnection(chatConnection) && !wishMode
        && !isInteractionReply && !isCameraExplicitReply && !options.interactionKind && !options.pokeInteraction
        && !options.dayPlanReceipt && !options.dayPlanAdjustment && !options.expenseReceipt && !options.sleepClaim;
      const desktopReminderDraft = Platform.OS === 'windows' && !wishMode && !directOrdinaryChat
        && !isLocalQwenChatConnection(chatConnection) && !isSiliconQwenChatConnection(chatConnection)
        && !isInteractionReply && !isCameraExplicitReply && !options.interactionKind && !options.pokeInteraction
        && !options.dayPlanReceipt && !options.dayPlanAdjustment && !options.expenseReceipt && !options.sleepClaim
        && !options.backstageResume;
      const fixedEnvelopeMode = wishMode ? 'wish' as const : desktopReminderDraft ? 'desktop-reminder-draft' as const : undefined;
      if (!await sleepReply.current()) return false;
      const sleepFarewellMaterial = await sleepReply.material();
      const sleepScheduleHost = await prepareChatSleepScheduleHost({ sessionId, turnId: latestYouMessage.id,
        startedAt: replyTiming.startedAt,
        sourceMessageIds: persistedMessages.slice(persistedMessages.findLastIndex(message => message.role === 'I') + 1)
          .filter(message => message.role === 'you').map(message => message.id), dataEpoch: toolAgentDataEpoch,
        signal: controller.signal, readOnly: !!options.expenseReceipt, sourceCurrent: async () => {
          if (!canCommitReplySideEffects()) return false;
          const originals = persistedMessages.slice(persistedMessages.findLastIndex(message => message.role === 'I') + 1)
            .filter(message => message.role === 'you');
          const saved = await Promise.all(originals.map(message => loadChatSessionMessage(sessionId, message.id)));
          return saved.every((message, index) => message?.role === 'you' && message.content === originals[index].content
            && message.createdAt === originals[index].createdAt);
        } });
      if (replyPoke) await updatePokeExperience(replyPoke.id, {
        targetSessionId: sessionId, replyToMessageIds: replyPoke.replyToMessageIds,
        ...(replyPoke.sleepMessageIds ? { sleepMessageIds: replyPoke.sleepMessageIds } : {}),
      }, canCommitReplySideEffects);
      const scheduleRecovery = !isInteractionReply
        ? await loadScheduleRecoveryBatch(sessionId, outgoingMessages, replyTiming.startedAt).catch(() => null)
        : null;
      const failureFixture = await consumeBaiyunChatReplyFailureFixture().catch(() => null);
      if (failureFixture) {
        activeFailureStage = getChatReplyFailureStage(failureFixture);
        throw createChatReplyFailure(failureFixture, activeFailureStage);
      }
      replyDiagnostic.markPreparationCheckpoint('contextStartedAt');
      const prepared = await prepareReplyMaterials({ wishTurn, options, sessionId, outgoingMessages, latestYouMessage,
        currentYouTurn, isInteractionReply, currentUnansweredYouMessageBeforeInteraction, latestYouAlreadyAnswered,
        shouldTrackDelivery, lastOutgoingMessage, musicEnabledAtRequest, controller, replyTiming,
        sleepScheduleHost, sleepFarewellMaterial, scheduleRecovery, hasCurrentReplyDataEpoch,
        canCommitReplySideEffects, runChatAuxiliaryOperation, readOnly: !!options.expenseReceipt,
        cameraResponseMaterial: cameraResponse?.material,
        onMemoryPreparation: diagnostic => replyDiagnostic.observeMemoryPreparation(diagnostic) });
      if (!prepared) return false;
      replyDiagnostic.markPreparationCheckpoint('contextReadyAt');
      const { query, actionInstruction, memoryRoute, bodySignalCareDoorbell, currentSituationMessage, previousSituationMessages, currentUnansweredYouSituationMessage, continuityContext, pendingShareContext, forcedSafetyWord, webShareHandoff, cognition, dreamSurface, dreamInstruction, keywordCounterPreparation, keywordCounterInsight, preparePostReference, postSourcesCurrent, markPostRequestStarted, readingSources, scheduleConflicts, currentTurnStart, toolResultsAtRequest, toolPackageActivationsAtRequest, toolCompletionGuardContext, preambleMessages, enrichedAmbientContext, conversationSummary, requestMessages, careItems, careSourceMessages, numberedCareMessages, unifiedContactHandoff, musicPlaybackEvents, buildOrdinaryResponseInstruction } = prepared;
      const sentMemories = new Map<string, import('../memory/memoryReadReference').MemoryReadReference>();
      let imageSourcesCurrent = async () => true;
      let scheduleReminderBatch: ChatReminderBatch | undefined;
      let standaloneReminderBatch: StandaloneReminderBatch | undefined;
      let chatImageContext: NonNullable<Awaited<ReturnType<typeof import('./chatImageTurn').prepareChatImageTurn>>> | undefined;
      const publishMemories = (items: readonly import('../memory/memoryReadReference').MemoryReadReference[], visible?: ReadonlySet<string>) => {
        if (!canCommitReplySideEffects() || activeSessionRef.current !== sessionId) return;
        for (const item of items) {
          const key = referenceKey(item);
          if (!visible || visible.has(key)) sentMemories.set(key, item);
        }
        setLatestRecallFromCognition({ query, items: [...sentMemories.values()].filter((item): item is MemoryRecallItem => 'memory' in item), debug: {
          ...cognition.memoryDebug, counts: cognition.memoryDebug?.counts ?? {},
          dropped: cognition.memoryDebug?.dropped ?? [], sentCount: sentMemories.size,
          providedPapers: [...sentMemories.values()].flatMap(item => isShiyingReference(item)
            ? [{ id: item.shiying.recordId, recordDate: item.shiying.recordDate }] : []),
          providedPosts: [...sentMemories.values()].flatMap(item => isPostReference(item)
            ? [{ id: item.post.postId, title: item.post.material.post.title || '白云苍狗', createdAt: item.post.material.post.createdAt }] : []),
        } });
      };
      publishMemories([]);
      publishPreparedMemories = () => publishMemories(cognition.memoryMentionItems ?? cognition.memoryItems, cognition.visibleMemoryIds);
      const recordPromptTokens = (
        tokens: number,
        source: 'estimate' | 'api',
        promptBreakdown: PromptTokenBreakdown,
        promptCache: Omit<PromptCacheStats, 'stablePrefixChanged'>,
      ) => {
        setCompressionState((current) => {
          const previousFingerprint = current.promptCache?.stablePrefixFingerprint;
          const next = {
            ...current,
            currentWindowTokens: tokens,
            promptCache: {
              ...promptCache,
              stablePrefixChanged: source === 'estimate'
                ? Boolean(previousFingerprint && previousFingerprint !== promptCache.stablePrefixFingerprint)
                : current.promptCache?.stablePrefixChanged ?? false,
            },
            promptBreakdown,
            tokenSource: source === 'api' || current.tokenSource !== 'api' ? source : current.tokenSource,
          };
          compressionStateRef.current = next;
          return next;
        });
      };
      const prepareBackstageRequest = theaterBackstage && !options.expenseReceipt ? createBackstageRequestPreparation({
        port: theaterBackstage, batchId: backstageBatchId,
        replyId: backstageReplyId,
        webShare: webShareHandoff?.instruction ?? '', keywordInsight: keywordCounterInsight,
        pendingShares: pendingShareContext.fixedItems,
      }) : undefined;
      let nativeToolAgentUsed = false;
      let phoneLimitReplyContinuationMessages: OpenAiCompatibleContinuationMessage[] = [];
      type ResponseInstructionScope = 'full' | 'visible_only';
      const requestReply = async (
        extraInstruction?: string,
        responseEnvelopeMode: 'messages_only' | 'messages_with_semantic' = 'messages_only',
        retryKind: 'tool_fact_correction' | 'quality_retry' = 'quality_retry',
        requestType: 'initial' | 'retry' = 'initial',
        responseInstructionScope: ResponseInstructionScope = 'full',
        contextSource?: PromptContextSource,
      ) => {
        if (wishMode) responseEnvelopeMode = 'messages_with_semantic';
        if (options.expenseReceipt && !await options.expenseReceipt.isCurrent()) throw new Error('expense-save-source-changed');
        if (prepared.savedScheduleReminders && !await prepared.savedScheduleReminders.current()) throw new Error('schedule-save-source-changed');
        if (!await sleepReply.current()) throw new Error('chat_sleep_boundary_reached');
        await preparePostReference();
        markPostRequestStarted();
        const isRetry = requestType === 'retry';
        const desktopReminderFeedback = Platform.OS === 'windows' && !!options.reminderReceipt && !isRetry
          && responseEnvelopeMode === 'messages_with_semantic' && (!contextSource || contextSource === 'chat.main')
          && !isSiliconQwenChatConnection(chatConnection) && !isLocalQwenChatConnection(chatConnection);
        const phoneBodyCorrection = isRetry
          && phoneLimitReplyContinuationMessages.length > 0;
        const qwenTransportAdmission = !wishMode && isSiliconQwenChatConnection(chatConnection);
        if (qwenTransportAdmission) assertQwenChatMessages(requestMessages);
        const admitRequest = () => {
          if (!modelRequestBudget.consume(isRetry ? retryKind : 'initial')) {
            throw new Error('CHAT_MODEL_REQUEST_BUDGET_EXHAUSTED');
          }
          const requestStartedAt = Date.now();
          if (isRetry) replyTiming.retryRequestStartedAt = requestStartedAt;
          else replyTiming.firstRequestStartedAt = requestStartedAt;
        };
        if (!qwenTransportAdmission) admitRequest();
        const semanticEnvelopeProtocol = responseEnvelopeMode === 'messages_with_semantic'
          ? 'single_root_json' as const
          : 'legacy_tagged' as const;
        currentAttemptSnapshot = undefined;
        currentAttemptReplyDiagnostics = undefined;
        const completion = await sendChatCompletionResult({
          ...(phoneBodyCorrection ? {
            continuationMessages: phoneLimitReplyContinuationMessages,
            tools: [], toolMode: 'none' as const, toolAgentProtocolMode: true,
            semanticPrefixCompletionMode: 'disabled' as const,
          } : {}),
          beforeTransportRequest: async () => {
            if (cameraResponse && !await cameraResponse.current()) throw new Error('camera_reply_stale');
            if (options.expenseReceipt && !await options.expenseReceipt.isCurrent()) throw new Error('expense-save-source-changed');
            if (!canCommitReplySideEffects() || !await sleepReply.current()) throw new Error('chat_sleep_boundary_reached');
            if (!await postSourcesCurrent()) throw new Error('chat_attachment_source_changed');
            if (qwenTransportAdmission) admitRequest();
          },
          refreshMemoryMaterials: prepared.refreshMemoryMaterials,
          refreshConversationSummary: prepared.refreshConversationSummary,
          prepareBackstageRequest,
          ambientContext: [enrichedAmbientContext, chatImageContext?.material].filter(Boolean).join('\n\n'),
          beforeChatImageTransport: async materials => {
            if (options.expenseReceipt && !await options.expenseReceipt.isCurrent()) throw new Error('expense-save-source-changed');
            if (chatImageContext) await chatImageContext.beforeTransport(materials);
            scheduleReminderBatch = prepared.savedScheduleReminders?.actuallyTransmitted(materials);
            standaloneReminderBatch = prepared.standaloneReminders && await standaloneReminderBatchCurrent(prepared.standaloneReminders)
              ? transmittedStandaloneReminderBatch(prepared.standaloneReminders, materials) : undefined;
          },
          apiKey: chatKey,
          connection: chatConnection,
          ...(directOrdinaryChat ? { thinkingMode: 'disabled' as const } : {}),
          ...(isCameraExplicitReply && cameraResponse ? { cameraObservationReplyJson: true } : {}),
          messages: requestMessages,
          musicPlaybackEvents,
          includeToolPromptTokens: true,
          conversationSummary,
          memoryContext: prepared.memoryContext,
          sleepScheduleMessages: preambleMessages.length ? preambleMessages : undefined,
          profile,
          contextSource: contextSource ?? (isRetry ? 'chat.quality-retry' : 'chat.main'),
          qwenChatLayout: wishMode ? undefined : 'ordinary',
          responseEnvelopeMode,
          responseInstruction: buildOrdinaryResponseInstruction(
            extraInstruction,
            responseInstructionScope,
            responseEnvelopeMode === 'messages_with_semantic',
            !isRetry,
            !desktopReminderFeedback,
          ),
          semanticEnvelopeProtocol,
          desktopReminderSaveFeedback: Platform.OS === 'windows' && !!options.reminderReceipt && !isRetry,
          desktopReminderSaveFeedbackSourceId: Platform.OS === 'windows' && options.reminderReceipt && !isRetry ? options.reminderReceipt.sourceMessageId : undefined,
          desktopReminderSaveFeedbackInstruction: desktopReminderFeedback ? buildToolResultInstruction(toolResultsAtRequest) : undefined,
          fixedEnvelopeMode,
          signal: controller.signal,
          transportRequestKind: isRetry ? retryKind : 'initial',
          onPreparationCheckpoint: replyDiagnostic.markPreparationCheckpoint,
          onTransportAttempt: observeTransportAttempt,
          onReplyDiagnostics: observeReplyDiagnostics,
          onPromptTokens: recordPromptTokens,
          recoverEmptySemanticEnvelope: (reasoningContent) => recoverBaiyunChatSemanticEnvelopeFromReasoning({
            raw: reasoningContent,
            currentMessage: currentSituationMessage,
            pendingShares: pendingShareContext.items,
          }),
        });
        if (phoneBodyCorrection && (completion.rawToolCallCount > 0
          || completion.toolInvocationErrors.length > 0 || completion.diagnostics.finishReason === 'tool_calls')) {
          throw new AiRequestError(EMPTY_CHAT_REPLY_ERROR_MESSAGE, AI_EMPTY_RESPONSE_KIND);
        }
        if (!await postSourcesCurrent()) throw new Error('chat_post_source_changed');
        if (isRetry) replyTiming.retryResponseAt = Date.now();
        else replyTiming.firstResponseAt = Date.now();
        return {
          theaterBackstage: completion.theaterBackstage,
          contents: completion.contents,
          diagnostics: completion.diagnostics,
          rawEnvelopeForSemanticParsing: completion.rawEnvelopeForSemanticParsing,
          semanticEnvelopeProtocol,
          requestType,
        };
      };
      let additionalRequestUsed = false;
      const requestOneRetry = async (
        instruction?: string,
        retryKind: 'tool_fact_correction' | 'quality_retry' = 'quality_retry',
        options: {
          contextSource?: PromptContextSource;
          responseEnvelopeMode?: 'messages_only' | 'messages_with_semantic';
          responseInstructionScope?: ResponseInstructionScope;
        } = {},
      ) => {
        if (
          isExpenseFeedback
          || additionalRequestUsed
          || modelRequestBudget.getSnapshot().used >= 3
          || modelRequestBudget.getSnapshot().remaining <= 0
        ) return undefined;
        additionalRequestUsed = true;
        try {
          return await requestReply(
            instruction,
            options.responseEnvelopeMode ?? 'messages_only',
            retryKind,
            'retry',
            options.responseInstructionScope ?? 'full',
            options.contextSource,
          );
        } catch (caught) {
          if (
            caught instanceof AiRequestError
            && (
              caught.kind === AI_EMPTY_RESPONSE_KIND
              || caught.message === EMPTY_CHAT_REPLY_ERROR_MESSAGE
            )
          ) {
            return undefined;
          }
          throw caught;
        }
      };
      activeFailureStage = CHAT_REPLY_FAILURE_STAGES.providerRequest;
      startSlowNetworkTimer(controller);
      await preparePostReference();
      markPostRequestStarted();
      let savedTerminalCardId: string | undefined;
      let adoptedBackstageSource: TheaterBackstageMessageSource | undefined;
      const reminderDraftSource = desktopReminderDraft ? { sessionId, messageId: latestYouMessage.id,
        createdAt: latestYouMessage.createdAt, contentRevision: reminderSourceRevision(latestYouMessage) } : undefined;
      const isReminderDraftSourceCurrent = async () => {
        if (!reminderDraftSource || !canCommitReplySideEffects() || !await sleepReply.current()) return false;
        return !controller.signal.aborted && canCommitBackupRestoreDataEpoch(toolAgentDataEpoch) && canCommitReplySideEffects()
          && activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
          && isReminderPlanSourceCurrent(reminderDraftSource, messagesRef.current.find(message => message.id === reminderDraftSource.messageId));
      };
      const productionToolAgent = isCameraExplicitReply || options.dayPlanReceipt || options.expenseReceipt ? { handled: false as const } : await runProductionChatToolAgent({
        disableCameraObservation: !!cameraResponse,
        appLaunchOpportunity,
        dialerOpportunity, dialerPicker, dialerIsForeground,
        appLaunchPicker,
        appLaunchIsForeground,
        resumeCompletedTools: options.backstageResume?.tools?.continuationMessages.length ? options.backstageResume.tools : undefined,
        onDiagnosticToolEvent: event => { replyDiagnostic.observeToolEvent(event); refreshFinalDiagnostic(); },
        onDiagnosticContinuationFailure: (error, stage) => {
          const failure = classifyChatReplyFailure({ dataEpochCurrent: canCommitBackupRestoreDataEpoch(dataEpoch), error, stage });
          replyDiagnostic.markFailure(failure.code);
          recordReplyFailure(failure);
          refreshFinalDiagnostic();
        },
        sleepScheduleHost,
        scheduleVersions: scheduleConflicts?.versions,
        readingSources,
        sourceMessage: latestYouMessage,
        imageSourceMessages: prepared.imageSourceMessages,
        mapConsentSources: { messages: careSourceMessages,
          newMessageIds: outgoingMessages.slice(currentTurnStart).filter(message => message.role === 'you').map(message => message.id) },
        isReplyCurrent: async () => canCommitReplySideEffects() && (!cameraResponse || await cameraResponse.current()) && await sleepReply.current() && await postSourcesCurrent(),
        isReminderDraftSourceCurrent: desktopReminderDraft ? isReminderDraftSourceCurrent : undefined,
        isReplyActive: canCommitReplySideEffects,
        onImageSaved: output.onImageSaved,
        onImageSourceCheck: check => { imageSourcesCurrent = check; },
        onImageContext: host => { chatImageContext = host; },
        onScheduleReminders: batch => { scheduleReminderBatch = batch; },
        get memoryMentionItems() { return cognition.memoryMentionItems; },
        get visibleMemoryIds() { return cognition.visibleMemoryIds; },
        onMemorySent: publishMemories,
        sourceMessageId: latestYouMessage.id,
        sourceSessionId: sessionId,
        dataEpoch: toolAgentDataEpoch,
        musicPreferences: musicPreferencesAtRequest,
        youText: currentYouTurn || query,
        recentMessages: outgoingMessages
          .filter((message) => message.role === 'I' || message.role === 'you')
          .slice(-4)
          .map((message) => ({ id: message.id, subject: message.role, content: message.content })),
        chatOptions: {
          beforeChatImageTransport: async materials => {
            if (cameraResponse && !await cameraResponse.current()) throw new Error('camera_reply_stale');
            standaloneReminderBatch = prepared.standaloneReminders && await standaloneReminderBatchCurrent(prepared.standaloneReminders)
              ? transmittedStandaloneReminderBatch(prepared.standaloneReminders, materials) : undefined;
          },
          refreshMemoryMaterials: prepared.refreshMemoryMaterials,
          refreshConversationSummary: prepared.refreshConversationSummary,
          prepareBackstageRequest,
          ambientContext: enrichedAmbientContext,
          apiKey: chatKey,
          connection: chatConnection,
          ...(directOrdinaryChat ? { thinkingMode: 'disabled' as const } : {}),
          messages: requestMessages,
          musicPlaybackEvents,
          includeToolPromptTokens: true,
          conversationSummary,
          memoryContext: prepared.memoryContext,
          sleepScheduleMessages: preambleMessages.length ? preambleMessages : undefined,
          profile,
          contextSource: 'chat.main',
          qwenChatLayout: wishMode ? undefined : 'ordinary',
          responseEnvelopeMode: 'messages_with_semantic',
          responseInstruction: buildOrdinaryResponseInstruction(),
          fixedEnvelopeMode,
          signal: controller.signal,
          onPreparationCheckpoint: replyDiagnostic.markPreparationCheckpoint,
          onTransportAttempt: observeTransportAttempt,
          onReplyDiagnostics: observeReplyDiagnostics,
          onPromptTokens: recordPromptTokens,
          recoverEmptySemanticEnvelope: (reasoningContent) => recoverBaiyunChatSemanticEnvelopeFromReasoning({
            raw: reasoningContent,
            currentMessage: currentSituationMessage,
            pendingShares: pendingShareContext.items,
          }),
        },
        turnController: toolAgentTurnController,
        requestBudget: modelRequestBudget,
        cameraReplyCurrent: async () => await sleepReply.current() && hasCurrentReplyDataEpoch() && !controller.signal.aborted
          && await cameraReplySourceIsCurrent(sessionId, latestYouMessage.id, latestYouMessage),
        cameraReplyMessages: async () => (await Promise.all(ownedReplyMessageIds.map(id => loadChatSessionMessage(sessionId, id))))
          .filter((message): message is SubjectiveMessage => !!message),
        deliverCameraContinuation: async (contents, result) => {
          const observationIds = cameraObservationIdsFromResults(result ? [result] : []);
          const current = async () => await sleepReply.current() && hasCurrentReplyDataEpoch() && !controller.signal.aborted
            && await cameraReplySourceIsCurrent(sessionId, latestYouMessage.id, latestYouMessage)
            && await cameraObservationResponsesCurrent(observationIds);
          if (!await current()) return [];
          const additions = contents.filter(content => content.trim()).map(content => createSubjectiveMessage('I', content, { source: 'chat' }));
          await saveCameraResponseDraft({ observationIds, replyId: `${replyDiagnostic.turnAttemptId}:camera-late`,
            messages: additions, dataEpoch, canCommit: () => hasCurrentReplyDataEpoch() && !controller.signal.aborted });
          const saved = await appendMessagesToChatSession(sessionId, additions, {
            requireActiveSession: true, dataEpoch, beforeAppend: current,
          });
          const delivered = saved.messages.filter(message => additions.some(item => item.id === message.id));
          await completeCameraResponseDelivery({ observationIds, sessionId, dataEpoch, messageIds: delivered.map(message => message.id) });
          emitChatMessagesAppended({ sessionId, messages: delivered, source: 'camera-same-turn' });
          return delivered;
        },
        deliverExpensePlan: async card => {
          if (!canCommitReplySideEffects() || !await sleepReply.current()) throw new Error('expense-plan-source-changed');
          const saved = await appendMessagesToChatSession(sessionId,
            [createSubjectiveMessage('I', '', { source: 'tool-call', expensePlanCard: card })], {
              requireActiveSession: true, dataEpoch: toolAgentDataEpoch,
              beforeAppend: async targetMessages => canCommitReplySideEffects() && sleepReply.active()
                && isExpensePlanSourceCurrent(card.source, targetMessages.find(message => message.id === card.source.messageId)),
            });
          const message = saved.messages.find(message => message.expensePlanCard === card
            || message.expensePlanCard?.source.messageId === card.source.messageId && message.expensePlanCard?.rows[0]?.id === card.rows[0]?.id);
          if (!message) throw new Error('expense-plan-persist-failed');
          savedTerminalCardId = message.id;
          emitChatMessagesAppended({ sessionId, messages: [message], source: 'expense-plan' });
        },
        deliverReminderPlan: async (card, requireNewCard) => {
          if (!canCommitReplySideEffects() || !await sleepReply.current()) throw new Error('reminder-plan-source-changed');
          if (requireNewCard && !await isReminderDraftSourceCurrent()) throw new Error('reminder-plan-source-changed');
          const reminderMessage = createSubjectiveMessage('I', '', { source: 'tool-call', reminderPlanCard: card });
          const saved = await appendMessagesToChatSession(sessionId,
            [reminderMessage], {
              requireActiveSession: true, dataEpoch: toolAgentDataEpoch,
              beforeAppend: async targetMessages => requireNewCard
                ? await isReminderDraftSourceCurrent() && canCommitReplySideEffects() && sleepReply.active()
                  && canCommitBackupRestoreDataEpoch(toolAgentDataEpoch)
                  && isReminderPlanSourceCurrent(card.source, targetMessages.find(message => message.id === card.source.messageId))
                : canCommitReplySideEffects() && sleepReply.active()
                  && (await import('./chatReminderPlan')).isReminderPlanSourceCurrent(card.source, targetMessages.find(message => message.id === card.source.messageId)),
            });
          const message = saved.messages.find(message => requireNewCard
            ? message.id === reminderMessage.id && JSON.stringify(message.reminderPlanCard) === JSON.stringify(card)
            : message.reminderPlanCard?.source.messageId === card.source.messageId
              && message.reminderPlanCard?.rows[0]?.operationId === card.rows[0]?.operationId);
          if (!message) throw new Error('reminder-plan-persist-failed');
          if (requireNewCard && !await isReminderDraftSourceCurrent()) throw new Error('reminder-plan-source-changed');
          savedTerminalCardId = message.id;
          emitChatMessagesAppended({ sessionId, messages: [message], source: 'reminder-plan' });
          if (requireNewCard) return message.id;
        },
        deliverDayPlan: async (result, source) => {
          if (!await sleepReply.current()) throw new Error('chat_sleep_boundary_reached');
          const submission = result.data as DayPlanSubmission;
          const adjustment = options.dayPlanAdjustment;
          const targetId = adjustment?.plan.id ?? submission.planId;
          const previous = targetId ? persistedMessages.find((message) => message.schedulePlanCard?.plan.id === targetId)?.schedulePlanCard?.plan : undefined;
          const currentMessages = () => activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
            ? messagesRef.current : sessionsRef.current.find((session) => session.id === sessionId)?.messages;
          const canSave = () => {
            if (!canCommitReplySideEffects() || adjustment && !adjustment.canCommit()) return false;
            const current = currentMessages();
            if (!current) return false;
            if (!targetId) return true;
            const card = current.find((message) => message.schedulePlanCard?.plan.id === targetId)?.schedulePlanCard;
            return !!previous && card?.plan === previous && (card.status === 'pending' || card.status === 'conflict');
          };
          if (!canSave()) throw new Error('DAY_PLAN_CHANGED');
          const plan = await buildDayPlanDraft({ ...submission, planId: targetId }, latestYouMessage.content, previous);
          if (!await sleepReply.current()) throw new Error('chat_sleep_boundary_reached');
          if (!canSave()) throw new Error('DAY_PLAN_CHANGED');
          const base = currentMessages()!;
          const card = { plan, status: 'pending' as const };
          const provenance = { theaterBackstage: source, theaterBackstagePending: source ? true as const : undefined };
          const next = previous ? base.map((message) => message.schedulePlanCard?.plan.id === previous.id
            ? { ...message, schedulePlanCard: card, ...provenance } : message)
            : [...base, createSubjectiveMessage('I', '', { source: 'schedule-plan', schedulePlanCard: card, ...provenance })];
          commitSessionMessages(sessionId, next);
          if (await persistSessionMessages(sessionId, next) === CHAT_PERSIST_FAILED) throw new Error('DAY_PLAN_PERSIST_FAILED');
          savedTerminalCardId = next.find(message => message.schedulePlanCard?.plan.id === plan.id)?.id;
        },
        deliverMusic: async (invocation, result, auditId) => {
          if (!await sleepReply.current()) return false;
          if (!hasCurrentReplyDataEpoch() || !sessionsRef.current.some((session) => session.id === sessionId)) return false;
          const base = activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
            ? messagesRef.current : sessionsRef.current.find((session) => session.id === sessionId)?.messages ?? [];
          const delivery = upsertMusicAgentResultCardMessage(base, invocation, result, auditId);
          if (!delivery.claimed) return false;
          commitSessionMessages(sessionId, delivery.messages);
          return await persistSessionMessages(sessionId, delivery.messages) !== CHAT_PERSIST_FAILED;
        },
        deliverCard: async (card, metadata) => {
          if (!await sleepReply.current()) return false;
          if (!hasCurrentReplyDataEpoch()) return false;
          const sessionExists = sessionsRef.current.some((session) => session.id === sessionId);
          if (!sessionExists) return false;
          const baseMessages = activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
            ? messagesRef.current
            : sessionsRef.current.find((session) => session.id === sessionId)?.messages ?? [];
          const nextMessages = upsertToolAgentCardMessage(baseMessages, card);
          if (card.toolId === 'image.describe_local') {
            if (!chatImageContext || !await imageSourcesCurrent()) return false;
            const sources = { ...chatImageContext.cardSources(), existingCardId: metadata.existingImageCardId };
            if (await persistSessionMessages(sessionId, nextMessages, undefined, sources) === CHAT_PERSIST_FAILED) return false;
            if (!await imageSourcesCurrent()) return false;
            // Do not replace the visible window with an old snapshot after the save wait.
            const current = activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
              ? messagesRef.current : sessionsRef.current.find(session => session.id === sessionId)?.messages ?? [];
            commitSessionMessages(sessionId, upsertToolAgentCardMessage(current, card));
            return true;
          }
          commitSessionMessages(sessionId, nextMessages);
          return await persistSessionMessages(sessionId, nextMessages) !== CHAT_PERSIST_FAILED;
        },
      });
      if (!await postSourcesCurrent() || !await imageSourcesCurrent()) throw new Error('chat_attachment_source_changed');
      if (productionToolAgent.handled) cameraBodyCommitted = productionToolAgent.cameraBodyCommitted;
      let reply: string[];
      let replyDiagnostics: ChatReplyDiagnostics | undefined;
      let rawEnvelopeForSemanticParsing: string | undefined;
      let replySemanticEnvelopeProtocol: 'legacy_tagged' | 'single_root_json' = 'legacy_tagged';
      let currentReplyRequestType: 'initial' | 'retry' = 'initial';
      let previousBadEnvelope: BaiyunLatestBadEnvelopeSnapshot | undefined;
      let currentBadEnvelope: BaiyunLatestBadEnvelopeSnapshot | undefined;
      const saveBadEnvelope = (
        snapshot: BaiyunLatestBadEnvelopeSnapshot | undefined,
        outcome: 'not_attempted' | 'recovered' | 'failed',
      ) => {
        if (!snapshot) return;
        void saveBaiyunLatestBadEnvelopeSnapshot(
          withBaiyunBadEnvelopeRetryOutcome(snapshot, outcome),
        ).catch(() => undefined);
      };
      if (productionToolAgent.handled) {
        if (productionToolAgent.turn.reminderDraftIncomplete) {
          replyDiagnostic.observeToolProtocolFailure(productionToolAgent.turn.protocolFailure);
          throw new Error('REMINDER_DRAFT_INCOMPLETE');
        }
        if (productionToolAgent.turn.completedWithVisibleCard) {
          if (!canCommitReplySideEffects() || !await sleepReply.current()) return false;
          answeredYouMessageIdsRef.current.add(latestYouMessage.id);
          updateMessageDeliveryStatus(latestYouMessage.id, undefined, undefined, sessionId);
          replyPersisted = true;
          await commitBackstageSource('theaterBackstage' in productionToolAgent.turn
            ? productionToolAgent.turn.theaterBackstage : undefined, savedTerminalCardId ? [savedTerminalCardId] : []);
          parsedReplyDiagnostic = { attemptedAt: Date.now(), status: 'valid', signalKinds: [],
            connectionId: chatConnection.id, connectionName: chatConnection.name, model: chatConnection.model,
            semanticOutputEstimatedTokens: 0, deliveryKind: 'tool_card' };
          clearSlowNetworkTimer();
          return true;
        }
        nativeToolAgentUsed = true;
        adoptedBackstageSource = 'theaterBackstage' in productionToolAgent.turn
          ? productionToolAgent.turn.theaterBackstage : undefined;
        toolResultsAtRequest.push(...productionToolAgent.turn.results);
        toolCompletionGuardContext.phoneLimitDiscoveryResults.push(...(productionToolAgent.phoneLimitDiscoveryResults ?? []));
        phoneLimitReplyContinuationMessages = productionToolAgent.phoneLimitReplyContinuationMessages ?? [];
        reply = productionToolAgent.turn.contents;
        replyDiagnostics = productionToolAgent.turn.diagnostics;
        rawEnvelopeForSemanticParsing = productionToolAgent.turn.rawEnvelopeForSemanticParsing;
        replySemanticEnvelopeProtocol = productionToolAgent.turn.semanticEnvelopeProtocol;
      } else {
        let initialCompletion: Awaited<ReturnType<typeof requestReply>>;
        try {
          initialCompletion = await requestReply(
            undefined,
            'messages_with_semantic',
            'quality_retry',
            'initial',
          );
        } catch (caught) {
          if (!(caught instanceof AiRequestError && caught.kind === AI_EMPTY_RESPONSE_KIND)) {
            throw caught;
          }
          if (
            !isInteractionReply
            && currentAttemptReplyDiagnostics?.semanticEnvelopeProtocol === 'single_root_json'
          ) {
            previousBadEnvelope = wishMode ? undefined : buildBaiyunLatestBadEnvelopeSnapshot({
              connectionName: chatConnection.name,
              model: chatConnection.model,
              requestType: 'initial',
              envelopeRaw: '',
              rawDirectContent: currentAttemptReplyDiagnostics.fixedEnvelopeRawDirect,
              finishReason: currentAttemptReplyDiagnostics.finishReason,
              semanticPrefixCompletionRequested:
                currentAttemptReplyDiagnostics.semanticPrefixCompletionRequested,
            });
          }
          const emptyRetryDecision = decideBaiyunProviderEmptyRetry({
            technicalCode: currentAttemptSnapshot?.technicalCode,
            additionalRequestUsed,
            remainingRequests: modelRequestBudget.getSnapshot().remaining,
            toolAgentUsed: nativeToolAgentUsed,
          });
          if (emptyRetryDecision.mode === 'none') {
            saveBadEnvelope(previousBadEnvelope, 'not_attempted');
            throw caught;
          }
          replyDiagnostic.markRetry('empty_response');
          const retry = await requestOneRetry(
            forcedSafetyWord ? actionInstruction || undefined : undefined,
            'quality_retry',
            {
              contextSource: emptyRetryDecision.contextSource,
              responseEnvelopeMode: emptyRetryDecision.responseEnvelopeMode,
              responseInstructionScope: emptyRetryDecision.responseInstructionScope,
            },
          );
          if (!retry) {
            saveBadEnvelope(previousBadEnvelope, 'failed');
            throw caught;
          }
          initialCompletion = retry;
        }
        ({
          theaterBackstage: adoptedBackstageSource,
          contents: reply,
          diagnostics: replyDiagnostics,
          rawEnvelopeForSemanticParsing,
          semanticEnvelopeProtocol: replySemanticEnvelopeProtocol,
          requestType: currentReplyRequestType,
        } = initialCompletion);
      }
      if (!canCommitReplySideEffects()) return false;
      const initialToolGrounding = assessToolCompletionGrounding(
        reply,
        toolCompletionGuardContext,
      );
      if (!initialToolGrounding.ok) {
        replyDiagnostic.markFailure('tool_grounding_rejected', initialToolGrounding.reasons);
        replyDiagnostic.markRetry('tool_fact_correction');
        const retry = initialToolGrounding.shouldRegenerate
          ? await requestOneRetry(
              TOOL_AGENT_ACTION_REVIEW_INSTRUCTION,
              'tool_fact_correction',
              {
                contextSource: 'chat.quality-retry',
                responseEnvelopeMode: 'messages_with_semantic',
                responseInstructionScope: 'full',
              },
            )
          : undefined;
        if (!retry || !hasCurrentReplyDataEpoch()) {
          if (hasCurrentReplyDataEpoch()) displayReplyFailure(recordReplyFailure({
            code: CHAT_REPLY_FAILURE_CODE.toolGroundingRejected, stage: CHAT_REPLY_FAILURE_STAGES.toolGrounding,
          }));
          return false;
        }
        reply = retry.contents;
        adoptedBackstageSource = retry.theaterBackstage;
        replyDiagnostics = retry.diagnostics;
        rawEnvelopeForSemanticParsing = retry.rawEnvelopeForSemanticParsing;
        replySemanticEnvelopeProtocol = retry.semanticEnvelopeProtocol;
        currentReplyRequestType = retry.requestType;
        const correctedToolGrounding = assessToolCompletionGrounding(
          reply,
          toolCompletionGuardContext,
        );
        if (!correctedToolGrounding.ok) {
          replyDiagnostic.markFailure('tool_grounding_rejected', correctedToolGrounding.reasons);
          displayReplyFailure(recordReplyFailure({ code: CHAT_REPLY_FAILURE_CODE.toolGroundingRejected, stage: CHAT_REPLY_FAILURE_STAGES.toolGrounding }));
          return false;
        }
      }
      activeFailureStage = CHAT_REPLY_FAILURE_STAGES.visibleEnvelope;
      // The existing short retry deliberately returns only visible messages.
      // It may deliver those messages, but cannot authorize any machine basket.
      const visibleOnlyRescue = replySemanticEnvelopeProtocol !== 'single_root_json'
        && currentReplyRequestType === 'retry'
        && reply.some((content) => content.trim().length > 0);
      const inspectReplyEnvelope = () => inspectBaiyunFixedChatEnvelope(rawEnvelopeForSemanticParsing ?? '', fixedEnvelopeMode, {
        allowUnescapedMessageQuotes: !wishMode && !isInteractionReply
          && isSiliconQwenChatConnection(chatConnection) && replyDiagnostics?.finishReason === 'stop',
      });
      let fixedEnvelopeDiagnostic = inspectReplyEnvelope();
      if (!visibleOnlyRescue && fixedEnvelopeDiagnostic.fields.messages.status !== 'valid') {
        replyDiagnostic.markRetry('visible_envelope_invalid');
        const retry = await requestOneRetry(undefined, 'quality_retry', {
          contextSource: 'chat.quality-retry',
          responseEnvelopeMode: 'messages_with_semantic',
          responseInstructionScope: 'full',
        });
        if (retry) {
          previousBadEnvelope = wishMode ? undefined : buildBaiyunLatestBadEnvelopeSnapshot({
            connectionName: chatConnection.name, model: chatConnection.model,
            requestType: currentReplyRequestType, envelopeRaw: rawEnvelopeForSemanticParsing ?? '',
            rawDirectContent: replyDiagnostics?.fixedEnvelopeRawDirect,
            finishReason: replyDiagnostics?.finishReason,
            semanticPrefixCompletionRequested: replyDiagnostics?.semanticPrefixCompletionRequested ?? false,
          });
          replyDiagnostics = retry.diagnostics;
          adoptedBackstageSource = retry.theaterBackstage;
          rawEnvelopeForSemanticParsing = retry.rawEnvelopeForSemanticParsing;
          replySemanticEnvelopeProtocol = retry.semanticEnvelopeProtocol;
          currentReplyRequestType = 'retry';
          fixedEnvelopeDiagnostic = inspectReplyEnvelope();
          // A retry replaces the complete answer, including every machine basket.
          reply = retry.contents;
        }
      }
      if (!hasCurrentReplyDataEpoch() || controller.signal.aborted) return false;
      if (desktopReminderDraft && (fixedEnvelopeDiagnostic.fields.reminderAction?.status !== 'valid'
        || fixedEnvelopeDiagnostic.fields.reminderAction.value === 'create_draft')) throw new Error('REMINDER_DRAFT_INCOMPLETE');
      const fixedMachineConsumersAuthorized = replySemanticEnvelopeProtocol === 'single_root_json'
        && !isInteractionReply && !options.expenseReceipt;
      const messagesField = fixedEnvelopeDiagnostic.fields.messages;
      if (messagesField.status === 'valid') reply = messagesField.value;
      const careField = fixedEnvelopeDiagnostic.fields.careUpdates;
      const careResult = parseChatCareUpdates({
        value: continuityContext.available && fixedMachineConsumersAuthorized && careField.status === 'valid' ? careField.value : [],
        items: careItems, messages: careSourceMessages,
        newMessages: outgoingMessages.slice(currentTurnStart).filter(message => message.role === 'you')
          .map(message => ({ id: message.id, role: 'you' as const, text: message.content, sentAt: message.createdAt })),
      });
      const shareField = fixedEnvelopeDiagnostic.fields.shareResponses;
      for (const reason of careResult.diagnostic.rejectionCodes) void recordChatCareRejection(reason);
      const fixedShareResponseResult = parseBaiyunFixedShareResponses({
        value: fixedMachineConsumersAuthorized && shareField.status === 'valid' ? shareField.value : undefined,
        pendingShares: adoptedBackstageSource ? backstagePendingShares(pendingShareContext.fixedItems) : pendingShareContext.fixedItems,
      });
      currentBadEnvelope = !wishMode && !isInteractionReply ? buildBaiyunLatestBadEnvelopeSnapshot({
        connectionName: chatConnection.name, model: chatConnection.model,
        requestType: currentReplyRequestType, envelopeRaw: rawEnvelopeForSemanticParsing ?? '',
        rawDirectContent: replyDiagnostics?.fixedEnvelopeRawDirect,
        finishReason: replyDiagnostics?.finishReason,
        semanticPrefixCompletionRequested: replyDiagnostics?.semanticPrefixCompletionRequested ?? false,
        careUpdates: { status: careResult.status, rejectionCodes: careResult.diagnostic.rejectionCodes },
        shareResponses: { status: fixedShareResponseResult.status, rejectionCodes: fixedShareResponseResult.diagnostic.rejectionCodes },
      }) : undefined;
      if (currentBadEnvelope) saveBadEnvelope(currentBadEnvelope, additionalRequestUsed ? 'failed' : 'not_attempted');
      else if (previousBadEnvelope) saveBadEnvelope(previousBadEnvelope, 'recovered');
      parsedReplyDiagnostic = {
        attemptedAt: Date.now(),
        status: messagesField.status !== 'valid' && !visibleOnlyRescue ? 'messages_invalid'
          : wishMode ? (fixedEnvelopeDiagnostic.rootStatus === 'valid' && fixedEnvelopeDiagnostic.messagesFirst
            && fixedEnvelopeDiagnostic.fields.wishDiscussion?.status === 'valid'
            && fixedEnvelopeDiagnostic.fields.innerReaction.status === 'valid'
            && fixedEnvelopeDiagnostic.fields.memoryMentions?.status === 'valid'
            && !fixedEnvelopeDiagnostic.unexpectedRootKeys.length ? 'valid' : 'partial')
          : careResult.status === 'valid' && fixedShareResponseResult.status === 'valid' ? 'valid' : 'partial',
        signalKinds: [],
        basketStatuses: wishMode ? {
          messages: messagesField.status, wishDiscussion: fixedEnvelopeDiagnostic.fields.wishDiscussion?.status ?? 'unavailable',
          innerReaction: fixedEnvelopeDiagnostic.fields.innerReaction.status, memoryMentions: fixedEnvelopeDiagnostic.fields.memoryMentions?.status ?? 'unavailable',
        } : {
          messages: messagesField.status, careUpdates: careField.status,
          shareResponses: shareField.status,
          innerReaction: fixedEnvelopeDiagnostic.fields.innerReaction.status,
        },
        connectionId: chatConnection.id, connectionName: chatConnection.name, model: chatConnection.model,
        promptTokens: replyDiagnostics?.usage?.promptTokens,
        completionTokens: replyDiagnostics?.usage?.completionTokens,
        totalTokens: replyDiagnostics?.usage?.totalTokens,
        cachedPromptTokens: replyDiagnostics?.usage?.cachedPromptTokens,
        modelRequestCount: attemptDiagnostics.length,
        modelAttempts: attemptDiagnostics.map((entry) => ({ ...entry })),
        finishReason: replyDiagnostics?.finishReason,
        jsonOutputRequested: replyDiagnostics?.jsonOutputRequested,
        rawContentFormat: replyDiagnostics?.rawContentFormat,
        rawContentChars: replyDiagnostics?.rawContentChars,
        reasoningContentChars: replyDiagnostics?.reasoningContentChars,
        recoveredFromReasoning: replyDiagnostics?.recoveredFromReasoning,
        responseEnvelopeMode: replyDiagnostics?.responseEnvelopeMode,
        semanticPrefixCompletionRequested: replyDiagnostics?.semanticPrefixCompletionRequested,
        usagePresent: replyDiagnostics?.usagePresent,
        visibleReplyFailureReason: replyDiagnostics?.visibleReplyFailureReason,
        visibleReplySource: replyDiagnostics?.visibleReplySource,
        visibleReplyStatus: replyDiagnostics?.visibleReplyStatus,
        semanticOutputEstimatedTokens: estimateTextTokens(getBaiyunChatSemanticOutputForTokenEstimate(
          rawEnvelopeForSemanticParsing ?? replyDiagnostics?.rawContent ?? '',
        )),
      };
      if (messagesField.status !== 'valid' && !visibleOnlyRescue) {
        throw createChatReplyFailure(CHAT_REPLY_FAILURE_CODE.visibleEnvelopeInvalid,
          CHAT_REPLY_FAILURE_STAGES.visibleEnvelope, new Error(EMPTY_CHAT_REPLY_ERROR_MESSAGE));
      }
      activeFailureStage = CHAT_REPLY_FAILURE_STAGES.internalPipeline;
      const usesFixedNotebookEnvelope = fixedMachineConsumersAuthorized && fixedEnvelopeDiagnostic.candidate;
      const fixedInnerReaction = fixedEnvelopeDiagnostic.fields.innerReaction.status === 'valid'
        ? fixedEnvelopeDiagnostic.fields.innerReaction.value : null;
      const fixedInnerReactionRequests: NotebookEntryRequest[] = fixedInnerReaction
        ? [{ content: fixedInnerReaction }] : [];
      const counterExtraction = extractKeywordCounterRequests(reply);
      const notebookExtraction = extractNotebookEntryRequests(counterExtraction.cleanedContents);
      const pendingCounterRequests: KeywordCounterRequest[] = [];
      const pendingNotebookRequests = usesFixedNotebookEnvelope
        ? fixedInnerReactionRequests
        : [];
      reply = counterExtraction.requests.length || notebookExtraction.requests.length ? notebookExtraction.cleanedContents : reply;
      const latestMessages = activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
        ? messagesRef.current
        : sessionsRef.current.find((session) => session.id === sessionId)?.messages ?? persistedMessages;
      const hasNewYouMessage = latestMessages.some(
        (message) => message.role === 'you' && !outgoingIds.has(message.id),
      );
      const replySessionHasDraft = activeSessionRef.current === sessionId && !!draftRef.current.trim();
      const deferCameraReply = (replySessionHasDraft || hasNewYouMessage)
        && (!!cameraResponse || cameraObservationIdsFromResults(toolResultsAtRequest).length > 0);
      if (
        !deferCameraReply &&
        !options.preserveInteractionReplyDuringConcurrentInput
        && (replySessionHasDraft || hasNewYouMessage)
      ) {
        needsFollowUpRef.current = true;
        scheduleFollowUpAfterRequest = true;
        return false;
      }

      const extractedMusic = extractMusicCommand(reply);
      let parsedMusic = extractedMusic;
      const finalToolCompletionAssessment = assessToolCompletionGrounding(parsedMusic.contents, toolCompletionGuardContext);
      if (!finalToolCompletionAssessment.ok) {
        replyDiagnostic.markFailure('tool_grounding_rejected', finalToolCompletionAssessment.reasons);
        displayReplyFailure(recordReplyFailure({ code: CHAT_REPLY_FAILURE_CODE.toolGroundingRejected, stage: CHAT_REPLY_FAILURE_STAGES.toolGrounding }));
        return false;
      }
      replyDiagnostic.markPreparationCheckpoint('replyReadyAt');
      activeFailureStage = CHAT_REPLY_FAILURE_STAGES.internalPipeline;
      const displayContents = parsedMusic.contents;
      if (!adoptedBackstageSource && webShareHandoff && !await isWebVoyageChatHandoffCurrent(webShareHandoff)) {
        throw new Error('web_share_source_changed_before_reply');
      }
      const bodySourcesCurrent = async () => (!cameraResponse || await cameraResponse.current())
        && await cameraObservationResponsesCurrent(cameraObservationIdsFromResults(toolResultsAtRequest), replyPersisted)
        && (!options.expenseReceipt || await options.expenseReceipt.isCurrent())
        && (chatImageContext ? await imageSourcesCurrent() : await sleepReply.current() && await postSourcesCurrent())
        && await isBodySignalCareDoorbellCurrent(bodySignalCareDoorbell)
        && (!unifiedContactHandoff || await (await import('../proactive/unifiedContactHandoff'))
          .isUnifiedContactChatHandoffCurrent(unifiedContactHandoff));
      if (!await bodySourcesCurrent()) {
        throw new Error('body_care_source_changed_before_reply');
      }
      ordinaryDraftSourcesCurrent = bodySourcesCurrent;
      activeFailureStage = CHAT_REPLY_FAILURE_STAGES.internalPipeline;
      activeFailureStage = CHAT_REPLY_FAILURE_STAGES.replyInsert;
      const insertedAssistantMessages = await appendAssistantBubbles(
        displayContents,
        { ...(replyPoke ? { pokeInteraction: replyPoke } : {}),
          ...(adoptedBackstageSource ? { theaterBackstage: adoptedBackstageSource, theaterBackstagePending: true } : {}) },
        [],
        async () => (
          !deferCameraReply
          &&
          await bodySourcesCurrent()
          && canCommitBackupRestoreDataEpoch(dataEpoch)
          && !controller.signal.aborted
          && requestRef.current === controller
        ),
        {
          baseMessages: latestMessages, targetSessionId: sessionId,
          onFirstBubbleCommitted: at => { replyDiagnostic.markFirstBubbleCommitted(at); refreshFinalDiagnostic(); },
          onPreparedMessages: async (messages) => {
            const observationIds = [...new Set([...(cameraResponse ? [cameraResponse.record.observationId] : []),
              ...cameraObservationIdsFromResults(toolResultsAtRequest)])];
            if (observationIds.length) {
              const draft = { replyId: replyDiagnostic.turnAttemptId, messages,
                ...(rawEnvelopeForSemanticParsing ? { adoptedReply: rawEnvelopeForSemanticParsing } : {}) };
              cameraResponse?.ownDraft(draft);
              await saveCameraResponseDraft({ observationIds, ...draft, dataEpoch, canCommit: canCommitReplySideEffects });
            }
            if (!observationIds.length && !isInteractionReply && !options.interactionKind && !replyPoke
              && !options.dayPlanReceipt && !options.dayPlanAdjustment && !options.expenseReceipt && !options.sleepClaim) {
              ordinaryReplyDraft = { version: 1, replyId: replyDiagnostic.turnAttemptId, sessionId,
                source: { messageId: latestYouMessage.id, revision: chatReplyDraftSourceRevision(latestYouMessage) },
                turnSources: persistedMessages.slice(persistedMessages.findLastIndex(message => message.role === 'I') + 1)
                  .filter(message => message.role === 'you' && message.deliveryStatus !== CHAT_DELIVERY_FAILED)
                  .map(message => ({ messageId: message.id, revision: chatReplyDraftSourceRevision(message) })),
                messages, startedAt: sleepReplyStartedAt, sleepingSourceIds: sleepingReplySourceIds,
                sources: { reading: readingSources,
                  readingCommand: { id: latestYouMessage.id, revision: readingMessageRevision(latestYouMessage) },
                  post: prepared.postReference,
                  ...(chatImageContext ? { image: { sources: chatImageContext.cardSources(), ...chatImageContext.recoveryAccess() } } : {}),
                  bodyCare: { ...bodySignalCareDoorbell, instruction: '' },
                  contact: unifiedContactHandoff ? { ...unifiedContactHandoff, material: '' } : undefined,
                  web: !adoptedBackstageSource && webShareHandoff ? { ...webShareHandoff, instruction: '' } : undefined },
              };
              activeFailureStage = CHAT_REPLY_FAILURE_STAGES.sessionPersist;
              await savePendingChatReplyDraft(ordinaryReplyDraft, { dataEpoch, canCommit: () => {
                if (canCommitReplySideEffects()) return true;
                if (!replyLifecycleInterruptedControllers.has(controller) || !canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
                const resident = activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
                  ? messagesRef.current : sessionsRef.current.find(session => session.id === sessionId)?.messages ?? persistedMessages;
                return (activeSessionRef.current !== sessionId || !draftRef.current.trim())
                  && isChatReplyDraftSourceCurrent(ordinaryReplyDraft!, resident);
              } });
              ordinaryReplyDraftSaved = true;
              activeFailureStage = CHAT_REPLY_FAILURE_STAGES.replyInsert;
            }
            ownedReplyMessageIds = messages.map((message) => message.id);
            releaseReplyMessageIds = holdChatReplyMessageIds(sessionId, ownedReplyMessageIds);
            if (replyPoke) await updatePokeExperience(replyPoke.id, {
              targetSessionId: sessionId, replyMessageIds: ownedReplyMessageIds,
              replyToMessageIds: replyPoke.replyToMessageIds,
              ...(replyPoke.sleepMessageIds ? { sleepMessageIds: replyPoke.sleepMessageIds } : {}),
            }, canCommitReplySideEffects);
          },
        },
      );
      if (deferCameraReply) {
        // The paid body is already durable as a draft; concurrent input cannot buy its regeneration.
        needsFollowUpRef.current = true;
        scheduleFollowUpAfterRequest = true;
        return false;
      }
      if (!canCommitReplySideEffects()) return false;
      clearSlowNetworkTimer();
      if (mountedRef.current) setReplyPhase('idle');
      insertedReply = insertedAssistantMessages.length > 0;
      insertedMessageCount = insertedAssistantMessages.length;
      if (!insertedReply) {
        throw createChatReplyFailure(
          CHAT_REPLY_FAILURE_CODE.replyInsertFailed,
          CHAT_REPLY_FAILURE_STAGES.replyInsert,
          new Error('本轮回复没有插入任何聊天气泡。'),
        );
      }
      let completedMessages = activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
        ? messagesRef.current
        : sessionsRef.current.find((session) => session.id === sessionId)?.messages
          ?? mergeSubjectiveMessages([...persistedMessages, ...insertedAssistantMessages], persistedMessages);
      activeFailureStage = CHAT_REPLY_FAILURE_STAGES.sessionPersist;
      if (!await bodySourcesCurrent()) {
        if (canCommitReplySideEffects()) {
          const unsavedIds = new Set(insertedAssistantMessages.map(message => message.id));
          commitSessionMessages(sessionId, completedMessages.filter(message => !unsavedIds.has(message.id)));
          answeredYouMessageIdsRef.current.delete(latestYouMessage.id);
        }
        throw new Error('body_care_source_changed_before_save');
      }
      if (!canCommitReplySideEffects()) return false;
      let completedPersistResult: 'persisted' | 'failed' = 'failed';
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (!canCommitReplySideEffects() || !await bodySourcesCurrent()) break;
        completedMessages = activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
          ? messagesRef.current
          : sessionsRef.current.find((session) => session.id === sessionId)?.messages ?? completedMessages;
        try {
          replyPersistAttempts += 1;
          completedPersistResult = await persistSessionMessages(sessionId, completedMessages, ownedReplyMessageIds);
        } catch { completedPersistResult = 'failed'; }
        if (completedPersistResult !== CHAT_PERSIST_FAILED) break;
      }
      if (completedPersistResult === CHAT_PERSIST_FAILED) {
        throw createChatReplyFailure(
          CHAT_REPLY_FAILURE_CODE.sessionPersistFailed,
          CHAT_REPLY_FAILURE_STAGES.sessionPersist,
          new Error(CHAT_REPLY_PERSIST_FAILURE_CODE),
        );
      }
      replyPersisted = true;
      await confirmSavedSleepingMessages();
      await completeCameraResponseDelivery({ observationIds: [...new Set([
        ...(cameraResponse ? [cameraResponse.record.observationId] : []), ...cameraObservationIdsFromResults(toolResultsAtRequest),
      ])], sessionId, messageIds: insertedAssistantMessages.map(message => message.id), dataEpoch,
        canCommit: canCommitReplySideEffects });
      if (!options.expenseReceipt && insertedAssistantMessages.length && canCommitReplySideEffects()) {
        const wishSavedReply = { messageId: insertedAssistantMessages[0].id, persistedAt: Date.now() };
        await runChatAuxiliaryOperation(
          { phase: 'commit', stage: 'continuity_ledger', retryLocalSave: true },
          () => commitWishChatReply(wishTurn, replySemanticEnvelopeProtocol === 'single_root_json' ? rawEnvelopeForSemanticParsing : undefined,
            wishSavedReply, canCommitReplySideEffects),
        );
      }
      // Body and provenance were saved together; only now confirm completion for counting.
      await commitBackstageSource(adoptedBackstageSource, insertedAssistantMessages.map(message => message.id));
      completedMessages = (activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
        ? messagesRef.current : sessionsRef.current.find(session => session.id === sessionId)?.messages) ?? completedMessages;
      if (!await sleepReply.current()) return false;
      await runChatAuxiliaryOperation(
        { phase: 'commit', stage: 'memory_usage', retryLocalSave: true },
        async () => {
          const memoryRead = productionToolAgent.handled ? productionToolAgent.memoryRead : undefined;
          const references = memoryRead?.references ?? cognition.memoryMentionItems;
          if (!references?.length || !canCommitReplySideEffects()) return [];
          const saved = await Promise.all(insertedAssistantMessages.map(message => loadChatSessionMessage(sessionId, message.id)));
          return commitMemoryReplyUsage({
            dataEpoch,
            references,
            visibleMemoryIds: memoryRead?.visibleMemoryIds ?? cognition.visibleMemoryIds,
            validateReference: memoryRead?.validateReference,
            receipts: fixedMachineConsumersAuthorized ? parseMemoryMentionReceipts(rawEnvelopeForSemanticParsing) : [],
            messages: saved.filter((message): message is SubjectiveMessage => message?.role === 'I'),
            canCommit: canCommitReplySideEffects,
          });
        },
      );
      if (replyPoke) await removePokeExperiences([replyPoke.id], canCommitReplySideEffects).catch(() => undefined);
      await recordCameraObservationReply({ turnId: latestYouMessage.id, sessionId, dataEpoch,
        results: toolResultsAtRequest, messageIds: insertedAssistantMessages.map(message => message.id) }).catch(() => undefined);
      void cameraBodyCommitted?.().catch(() => undefined);
      releaseReplyMessageIds?.();
      releaseReplyMessageIds = undefined;
      if (shouldTrackDelivery && canCommitReplySideEffects()) {
        answeredYouMessageIdsRef.current.add(latestYouMessage.id);
        updateMessageDeliveryStatus(latestYouMessage.id, undefined, undefined, sessionId);
      }
      await runChatAuxiliaryOperation(
        { phase: 'commit', stage: 'continuity_ledger', retryLocalSave: true },
        async () => {
          if (!canCommitReplySideEffects()) return;
          const { noteOrdinaryContactReply } = await import('../proactive/unifiedContactStore');
          if (!canCommitReplySideEffects()) return;
          await noteOrdinaryContactReply(insertedAssistantMessages.at(-1)!.createdAt);
          ordinaryReceiptsDone.add('ordinaryContact');
          if (unifiedContactHandoff && canCommitReplySideEffects()) {
            const { commitUnifiedContactChatHandoff } = await import('../proactive/unifiedContactHandoff');
            if (canCommitReplySideEffects()) {
              await commitUnifiedContactChatHandoff(unifiedContactHandoff, Date.now(), insertedAssistantMessages, sessionId);
              ordinaryReceiptsDone.add('contact');
            }
          }
        },
      );
      if (!adoptedBackstageSource && webShareHandoff && canCommitReplySideEffects()) {
        const deliveredAt = insertedAssistantMessages.at(-1)!.createdAt;
        await runChatAuxiliaryOperation(
          { phase: 'commit', stage: 'share_ledger', step: 'web_share_commit', retryLocalSave: true },
          async () => {
            const commit = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
              if (!canCommitReplySideEffects()) return;
              await commitWebVoyageChatHandoff({
                handoff: webShareHandoff, messages: insertedAssistantMessages,
                sessionId, deliveredAt, canCommit: canCommitReplySideEffects,
              });
              ordinaryReceiptsDone.add('web');
            });
            if (!commit.committed) throw new Error('web_share_commit_blocked_by_backup_restore');
          },
        );
      }
      if (scheduleRecovery && !controller.signal.aborted && hasCurrentReplyDataEpoch()) {
        await acknowledgeScheduleRecoveryBatch(scheduleRecovery, sessionId).catch(() => undefined);
      }
      if (
        (bodySignalCareDoorbell.eventIds.length > 0 || (bodySignalCareDoorbell.periodIds?.length ?? 0) > 0)
        && !controller.signal.aborted
        && requestRef.current === controller
        && hasCurrentReplyDataEpoch()
      ) {
        await runChatAuxiliaryOperation(
          { phase: 'commit', retryLocalSave: true, stage: 'continuity_ledger', step: 'body_doorbell_commit' },
          async () => {
            if (!canCommitReplySideEffects()) return undefined;
            const commit = await runBackupRestoreDataEpochCommit(
              dataEpoch,
              async () => {
                if (!canCommitReplySideEffects()) return undefined;
                await commitBodySignalCareDoorbell(bodySignalCareDoorbell);
                ordinaryReceiptsDone.add('body');
              },
            );
            if (!commit.committed) {
              throw new Error('body_signal_care_doorbell_blocked_by_backup_restore');
            }
          },
        );
      }
      if (!wishMode && !isInteractionReply && replySemanticEnvelopeProtocol === 'single_root_json') {
        await commitStandaloneReminderAnswer(rawEnvelopeForSemanticParsing ?? '', standaloneReminderBatch,
          { dataEpoch, isCurrent: bodySourcesCurrent, savedReplyIds: insertedAssistantMessages.map(message => message.id) }).catch(() => undefined);
      }
      if (!wishMode && fixedMachineConsumersAuthorized) {
        await commitChatReminderAnswer(rawEnvelopeForSemanticParsing ?? '', scheduleReminderBatch,
          { dataEpoch, isCurrent: async () => canCommitReplySideEffects() && (!prepared.savedScheduleReminders || await prepared.savedScheduleReminders.current()) }).catch(() => undefined);
        const presenceUpdate = parsePresenceUpdate(rawEnvelopeForSemanticParsing ?? '', careSourceMessages,
          outgoingMessages.slice(currentTurnStart).filter(message => message.role === 'you').map(message => message.id), sessionId);
        if (presenceUpdate && canCommitReplySideEffects()) {
          await runChatAuxiliaryOperation(
            { phase: 'commit', retryLocalSave: true, stage: 'continuity_ledger', step: 'presence_update_commit' },
            async () => {
              if (!canCommitReplySideEffects()) return;
              const commit = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
                if (canCommitReplySideEffects()) await commitPresenceUpdate(presenceUpdate);
              });
              if (!commit.committed) throw new Error('presence_update_blocked_by_backup_restore');
            },
          );
        }
        for (const update of careResult.updates) {
          if (controller.signal.aborted || requestRef.current !== controller || !hasCurrentReplyDataEpoch()) break;
          await runChatAuxiliaryOperation(
            { phase: 'commit', retryLocalSave: true, stage: 'continuity_ledger', step: 'care_updates_commit' },
            async () => {
              if (!canCommitReplySideEffects()) return undefined;
              const commit = await runBackupRestoreDataEpochCommit(dataEpoch,
                () => retryTransientDatabaseLock(async () => {
                  if (!canCommitReplySideEffects()) return undefined;
                  return applyBaiyunCareMatterUpdates({ updates: [update], sessionId, now: Date.now(),
                    allowNew: careItems.length < 6, canCommit: canCommitReplySideEffects,
                    onRejected: reason => { careResult.diagnostic.rejectionCodes.push(reason); }, });
                }));
              if (!commit.committed) throw new Error('care_update_blocked_by_backup_restore');
              return commit.value;
            },
          );
        }
      }
      if (!canCommitReplySideEffects()) return false;
      const fixedShareResponses = fixedShareResponseResult?.status === 'valid'
        || fixedShareResponseResult?.status === 'partial'
        ? fixedShareResponseResult.responses
        : [];
      if (fixedShareResponses.length) {
        await runChatAuxiliaryOperation(
            { phase: 'commit', retryLocalSave: true, stage: 'share_ledger' },
            async () => {
              if (!canCommitReplySideEffects()) return undefined;
              const commit = await runBackupRestoreDataEpochCommit(
                dataEpoch,
                async () => {
                  if (!canCommitReplySideEffects()) return undefined;
                  return commitBaiyunFixedShareResponseLedger({
                    responses: fixedShareResponses,
                    responseMessageId: currentSituationMessage.id,
                    sessionId,
                  });
                },
              );
              if (!commit.committed) {
                throw new Error('fixed_share_ledger_write_blocked_by_backup_restore');
              }
              return commit.value;
            },
          );
      }
      activeFailureStage = CHAT_REPLY_FAILURE_STAGES.auxiliaryPipeline;
      if (!canCommitReplySideEffects()) return false;
      if (dreamSurface) {
        await runBackupRestoreDataEpochCommit(
          dataEpoch,
          async () => {
            if (!canCommitReplySideEffects()) return undefined;
            return commitDreamSurface(dreamSurface);
          },
        ).catch(() => undefined);
      }

      if (!adoptedBackstageSource && (keywordCounterPreparation.insightIds.length || keywordCounterPreparation.taskIds.length)) {
        activeAuxiliaryStage = 'keyword_counter';
        activeAuxiliaryPhase = 'commit';
        await runChatAuxiliaryOperation(
          { phase: 'commit', retryLocalSave: true, stage: 'keyword_counter' },
          async () => {
            if (!canCommitReplySideEffects()) return undefined;
            const commit = await runBackupRestoreDataEpochCommit(
              dataEpoch,
              async () => {
                if (!canCommitReplySideEffects()) return undefined;
                return commitPreparedKeywordCounterInsights(keywordCounterPreparation);
              },
            );
            if (!commit.committed) throw new Error('keyword_counter_write_blocked_by_backup_restore');
          },
        );
        activeAuxiliaryStage = null;
        activeAuxiliaryPhase = null;
      }

      if (!canCommitReplySideEffects()) return false;
      const notebookPreparationRead = await runChatAuxiliaryOperation(
        { phase: 'prepare', stage: 'notebook', step: 'notebook_prepare' },
        () => prepareNotebookAction({
          assistantContents: parsedMusic.contents,
          hiddenRequests: pendingNotebookRequests,
          mode: usesFixedNotebookEnvelope ? 'inner_reaction' : 'legacy',
          sourceMessageId: latestYouMessage.id,
          userText: currentYouTurn || latestYouMessage.content,
        }),
      );
      const notebookPreparation = notebookPreparationRead.ok
        ? notebookPreparationRead.value
        : undefined;
      if (notebookPreparation?.ready) {
        activeAuxiliaryStage = 'notebook';
        activeAuxiliaryPhase = 'commit';
        await runChatAuxiliaryOperation(
          { phase: 'commit', retryLocalSave: true, stage: 'notebook', step: 'notebook_commit' },
          async () => {
            if (!canCommitReplySideEffects()) return undefined;
            const commit = await runBackupRestoreDataEpochCommit(
              dataEpoch,
              async () => {
                if (!canCommitReplySideEffects()) return undefined;
                const result = await commitPreparedNotebookAction(notebookPreparation);
                if (!result.ok) throw new Error(`notebook_write_${result.reason}`);
                return result;
              },
            );
            if (!commit.committed) throw new Error('notebook_write_blocked_by_backup_restore');
          },
        );
        activeAuxiliaryStage = null;
        activeAuxiliaryPhase = null;
      }
      if (!canCommitReplySideEffects()) return false;
      if (pendingCounterRequests.length) {
        activeAuxiliaryStage = 'keyword_counter';
        activeAuxiliaryPhase = 'commit';
        await runChatAuxiliaryOperation(
          { phase: 'commit', retryLocalSave: true, stage: 'keyword_counter' },
          async () => {
            if (!canCommitReplySideEffects()) return undefined;
            const commit = await runBackupRestoreDataEpochCommit(
              dataEpoch,
              async () => {
                if (!canCommitReplySideEffects()) return undefined;
                return createKeywordCounterTasks(pendingCounterRequests, {
                  requestedByMessageId: latestYouMessage.id,
                  seedMessages: completedMessages,
                });
              },
            );
            if (!commit.committed) throw new Error('keyword_counter_write_blocked_by_backup_restore');
          },
        );
        activeAuxiliaryStage = null;
        activeAuxiliaryPhase = null;
      }
      if (!canCommitReplySideEffects()) return false;
      void chatMemory.proposeMemoryAfterReply({
        currentMessages: completedMessages,
        dataEpoch,
        memoryRoute,
        proactiveReviewedThroughId,
        recallItems: cognition.memoryItems,
        sessionId,
      });
      factMessagesInRequest.forEach((message) => void chatMemory.captureExplicitFactAfterReply({
        dataEpoch,
        force: isMusicEnabled() && isExplicitMusicPreferenceStatement(message.content),
        message,
        sessionId,
      }).then(() => {
        pendingFactMessagesRef.current = pendingFactMessagesRef.current.filter((pending) => pending.id !== message.id);
      }).catch(() => {
        // Keep the original source available for the next reply if local registration failed.
      }));
      lastReplyCompletedAtRef.current = Date.now();
      if (!canCommitReplySideEffects()) return false;
      void compressConversationContext(completedMessages);
    } catch (caught) {
      if (caught instanceof BackstageCapacityPending) {
        backstageCapacityPending = true;
        if (output.rememberReplyContinuation && canCommitReplySideEffects()) {
          const currentMessages = () => activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
            ? messagesRef.current : sessionsRef.current.find(session => session.id === sessionId)?.messages ?? [];
          const signature = (messages: SubjectiveMessage[]) => JSON.stringify(messages.map(({ deliveryStatus, deliveryError, ...message }) => message));
          const captured = signature(currentMessages());
          const canRetry = (messages: SubjectiveMessage[]) => canCommitBackupRestoreDataEpoch(dataEpoch)
            && messages.findLast(message => message.role === 'you')?.id === latestYouMessage.id
            && signature(messages) === captured;
          output.rememberReplyContinuation({ messageId: latestYouMessage.id, canRetryAfterMessages: canRetry,
            run: async () => {
              if (!canRetry(currentMessages())) return;
              await runReply({ ...options, dataEpoch, sourceSessionId: sessionId, backstageResume: {
                batchId: backstageBatchId, replyId: backstageReplyId, sourceMessageId: latestYouMessage.id,
                remainingRequests: modelRequestBudget.getSnapshot().remaining + 1, tools: caught.toolContinuation,
              } });
            },
          });
          updateMessageDeliveryStatus(latestYouMessage.id, CHAT_DELIVERY_FAILED, undefined, sessionId);
          await persistSessionMessages(sessionId, currentMessages());
        }
        return false;
      }
      // A partially persisted body is still real delivery; the continuation reads
      // only those prepared IDs that are actually present in storage.
      void cameraBodyCommitted?.().catch(() => undefined);
      if (controller.signal.aborted || requestRef.current !== controller) return false;
      if (!(caught instanceof Error && caught.name === 'AbortError')) {
        const failure = classifyChatReplyFailure({
          dataEpochCurrent: canCommitBackupRestoreDataEpoch(dataEpoch),
          error: caught,
          stage: activeFailureStage,
        });
        if (failure.stage === CHAT_REPLY_FAILURE_STAGES.providerRequest && replyDiagnostic.current()?.failureCode) {
          failure.code = replyDiagnostic.current()!.failureCode!;
        }
        if (failure.stage === CHAT_REPLY_FAILURE_STAGES.providerRequest) replyDiagnostic.markFailure(failure.code);
        const failureEntry = failure.code !== CHAT_REPLY_FAILURE_CODE.staleDataEpoch || !staleDataEpochRecorded
          ? recordReplyFailure(failure) : undefined;
        if (failure.code === CHAT_REPLY_FAILURE_CODE.staleDataEpoch) return false;
        if (!replyPersisted) {
          if (failureEntry) displayReplyFailure(failureEntry);
          console.warn('[chat-reply] reply failed after user message persisted', failure.code);
          return false;
        }
        console.warn('[chat-delivery-barrier] auxiliary failure after persisted reply', failure.code);
        if (failureEntry) displayReplyFailure(failureEntry);
        if (activeAuxiliaryStage && activeAuxiliaryPhase) {
          void recordChatAuxiliaryDiagnostic({
            durationMs: 0,
            error: caught,
            phase: activeAuxiliaryPhase,
            retryAttempted: false,
            stage: activeAuxiliaryStage,
            status: 'failed',
          });
        }
        return insertedReply;
      }
    } finally {
      unsubscribeRestore();
      releaseWishTurn?.();
      if (!replyFailureRecorded && controller.signal.aborted && attemptDiagnostics.length) {
        recordReplyFailure({ code: 'model_cancelled', stage: CHAT_REPLY_FAILURE_STAGES.providerRequest });
      }
      if (!replyFailureRecorded && replyDiagnostic.auxiliaryFailures.length) {
        displayReplyFailure(recordReplyFailure({ code: 'auxiliary_pipeline_failed', stage: CHAT_REPLY_FAILURE_STAGES.auxiliaryPipeline }));
      }
      try {
        if (!replyPersisted && ownedReplyMessageIds.length && canCommitBackupRestoreDataEpoch(dataEpoch)) {
          const latest = activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
            ? messagesRef.current : sessionsRef.current.find((session) => session.id === sessionId)?.messages;
          if (latest) {
            const unsaved = new Set(ownedReplyMessageIds);
            insertedMessageCount = Math.max(insertedMessageCount, latest.filter((message) => unsaved.has(message.id)).length);
            commitSessionMessages(sessionId, latest.filter((message) => !unsaved.has(message.id)));
          }
          answeredYouMessageIdsRef.current.delete(latestYouMessage.id);
        }
      } finally {
        releaseReplyMessageIds?.();
      }
      if (ordinaryReplyDraft) {
        const retained = await runChatAuxiliaryOperation({ phase: 'commit', stage: 'share_ledger', retryLocalSave: true }, async () => {
          if (replyLifecycleInterruptedControllers.has(controller)) {
            if (canCommitBackupRestoreDataEpoch(dataEpoch)) {
              try { if (await isPendingChatReplyDraftCurrent(ordinaryReplyDraft!) && canCommitBackupRestoreDataEpoch(dataEpoch)) return false; }
              catch { if (canCommitBackupRestoreDataEpoch(dataEpoch)) return false; } // Recheck a closing host on activation.
            }
            await discardPendingChatReplyDraft(sessionId, ordinaryReplyDraft!.replyId);
            return false;
          }
          if (replyPersisted) { await completeChatReplyDraft(ordinaryReplyDraft!, dataEpoch, ordinaryReceiptsDone, false); return false; }
          if (controller.signal.aborted || requestRef.current !== controller || !canCommitBackupRestoreDataEpoch(dataEpoch)
            || ordinaryDraftSourcesCurrent && !await ordinaryDraftSourcesCurrent()) {
            await discardPendingChatReplyDraft(sessionId, ordinaryReplyDraft!.replyId);
            return false;
          }
          return ordinaryReplyDraftSaved && (await loadPendingChatReplyDraft(sessionId))?.replyId === ordinaryReplyDraft!.replyId;
        });
        if (retained.ok && retained.value && ownsDiagnostic() && mountedRef.current && activeSessionRef.current === sessionId) {
          setError('聊天回复没有保存成功；原稿已保留，重新打开聊天后会继续补存。');
        }
      }
      diagnosticFinalized = true;
      if (parsedReplyDiagnostic) void recordBaiyunChatSemanticDiagnostic({
        ...parsedReplyDiagnostic, ...replyDiagnostic.snapshot(), replyPersisted, replyPersistAttempts, insertedMessageCount,
      }).catch(() => undefined);
      await confirmSavedSleepingMessages().catch(() => undefined);
      if (options.sleepClaim && !sleepClaimConfirmed) {
        await runBackupRestoreDataEpochCommit(
          dataEpoch,
          () => releaseSleepingReply(options.sleepClaim!),
        ).catch(() => undefined);
      }
      await sleepReply.finish(ownedReplyMessageIds, replyPersisted).catch(() => undefined);
      const finishReason = controller.signal.aborted ? 'aborted' : 'finished';
      if (replyRuntimeStartedControllers.delete(controller)) {
        if (canCommitBackupRestoreDataEpoch(dataEpoch)) {
          await runBackupRestoreDataEpochCommit(
            dataEpoch,
            () => markChatReplyFinished(finishReason),
          ).catch(() => undefined);
        } else {
          await markChatReplyFinished(finishReason, { persist: false }).catch(() => undefined);
        }
      }
      const ownsCurrentReply = requestRef.current === controller;
      if (ownsCurrentReply) {
        clearSlowNetworkTimer();
        requestRef.current = null;
        sendingRef.current = false;
        if (mountedRef.current) setSending(false);
        if (
          canCommitBackupRestoreDataEpoch(dataEpoch)
          && !backstageCapacityPending
          && mountedRef.current
          && (scheduleFollowUpAfterRequest || needsFollowUpRef.current)
        ) {
          scheduleReply(undefined, sessionId, dataEpoch);
        } else if (mountedRef.current && !waitingToReplyRef.current) {
          if (replySessionIdRef.current === sessionId) {
            replySessionIdRef.current = null;
            setReplySessionId(null);
          }
          setReplyPhase('idle');
        }
      }
      if (canCommitBackupRestoreDataEpoch(dataEpoch)) {
        // Saved sleep decisions also survive failed/cancelled prose. Reconcile after releasing chat.
        void import('../life/sleepPlanRuntime').then(({ reconcileSleepPlan }) => {
          if (canCommitBackupRestoreDataEpoch(dataEpoch)) return reconcileSleepPlan(Date.now(), dataEpoch, true);
        }).catch(() => undefined);
        if (replyPersisted) void import('../ai/assistantAffectRuntime').then(({ runAssistantAffectUpdate }) => {
          if (canCommitBackupRestoreDataEpoch(dataEpoch)) return runAssistantAffectUpdate();
        }).catch(() => undefined);
      }
      if (DEV_RUNTIME_DIAGNOSTICS) {
        const finishedAt = Date.now();
        console.log('[chat reply timing]', {
          contextMs: replyTiming.contextReadyAt ? replyTiming.contextReadyAt - replyTiming.startedAt : null,
          firstRequestMs: replyTiming.firstResponseAt && replyTiming.firstRequestStartedAt
            ? replyTiming.firstResponseAt - replyTiming.firstRequestStartedAt
            : null,
          retryRequestMs: replyTiming.retryResponseAt && replyTiming.retryRequestStartedAt
            ? replyTiming.retryResponseAt - replyTiming.retryRequestStartedAt
            : null,
          totalMs: finishedAt - replyTiming.startedAt,
        });
      }
    }
    return insertedReply;
    } finally {
      if (replyPreparationOwners.get(requestRef) === preparation) {
        preparation.clearIndicator();
        replyPreparationOwners.delete(requestRef);
      }
      finishBackground();
    }
  };

  return { cancelActiveReply, runReply, prepareBackstageCapacityRequest };
}
