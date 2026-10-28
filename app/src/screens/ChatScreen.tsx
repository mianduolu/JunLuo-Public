import {
  useEffect, useMemo,
  useRef, useState,
} from 'react';
import {
  Alert,
  BackHandler,
  DeviceEventEmitter,
  FlatList,
  InteractionManager,
  Keyboard,
  Platform,
  useWindowDimensions,
} from 'react-native';
import {
  useAnimatedKeyboard,
  useAnimatedStyle,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { styles } from './ChatScreen.styles';

import { useAiConfigPreferences } from '../ai/AiConfigPreferences';
import {
  describeAssistantAvailability,
  refreshAssistantLifeState,
  wakeAssistantByPoke,
} from '../ai/assistantLife';
import { DEFAULT_ASSISTANT_STATE, loadAssistantState, subscribeAssistantStateChanged } from '../ai/assistantState';
import {
  buildGlobalCognitionContext,
  recordGlobalInteraction,
  type GlobalCognitionContext,
} from '../ai/globalCognition';
import { loadPromptCacheMetricsSummary, type PromptCacheMetricsSummary } from '../ai/promptCacheMetrics';
import {
  createSubjectiveMessage,
  type MessageImage,
  type SubjectiveMessage,
} from '../ai/subjectiveMessages';
import type { BackgroundSettings } from '../backgrounds/BackgroundPreferences';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import {
  emptyChatContextCompressionState,
  loadChatSessionMessageOrder,
  editStoredChatMessageContent,
  type ChatContextCompressionState,
} from '../chat/chatStorage';
import {
  buildReplyToMessage,
  hasRenderableChatMessageContent, getDisplayedChatMessageContent,
  isLatestLoadedMessage,
} from '../chat/chatMessageDisplay';
import { shouldMountChatPresentation } from '../chat/chatResidency';
import { pickLocalPokeExpression } from '../chat/chatPokeExpressions';
import { renderInlineMarkdown } from '../chat/ChatInlineMarkdown';
import { formatScheduleDateTime, type ScheduleNudgeState } from '../chat/chatScheduleContext';
import {
  buildScheduleAfterwordFallback,
  type ScheduleAfterwordKind,
} from '../chat/chatScheduleAfterword';
import type { ChatDrawerHandle } from '../chat/ChatDrawer';
import {
  ChatGoalTimeCreditCard,
  ChatScheduleChangeCard,
  ChatSchedulePlanCard,
  ChatToolCallCards,
} from '../chat/ChatMessageCards';
import { ChatMessageBubble } from '../chat/ChatMessageBubble';
import { useChatNotebookMarkers } from '../chat/useChatNotebookMarkers';
import { ChatScreenView } from '../chat/ChatScreenView';
import {
  buildChatSendIntentSnapshot,
  requiresConfiguredChatModelForSend,
  selectChatSendRoute,
} from '../chat/chatSendRouter';
import { createChatSendPersistenceCoordinator, type AcceptedUserMessageContinuation } from '../chat/chatSendPersistence';
import { createChatReplyWaitState, reviseChatReplyDraft } from '../chat/chatReplyWaitState';
import {
  getMessageMusicCards,
} from '../chat/chatMusicLogic';
import { useChatMusicController } from '../chat/useChatMusicController';
import { useChatReplyController, type ChatReplyPhase } from '../chat/useChatReplyController';
import { useChatReplyDiagnostic } from '../chat/useChatReplyDiagnostic';
import type { ChatSendAction } from '../chat/chatReplyDiagnostics';
import { useChatComposerDraft } from '../chat/useChatComposerDraft';
import { isChatReplyDiagnosticForSession } from '../chat/chatReplyDiagnosticPresentation';
import { useChatExpenseController } from '../chat/useChatExpenseController';
import { useChatExpensePlanBridge } from '../chat/useChatExpensePlanBridge';
import { ChatExpensePlanCard } from '../chat/ChatExpensePlanCard';
import { useChatReminderPlanBridge } from '../chat/useChatReminderPlanBridge';
import { ChatReminderPlanCard } from '../chat/ChatReminderPlanCard';
import { ChatReminderMusicControls } from '../chat/ChatReminderMusicControls';
import { useChatContinuityReviewController } from '../chat/useChatContinuityReviewController';
import { useChatImageSender } from '../chat/useChatImageSender';
import { useChatMessageInteractionController } from '../chat/useChatMessageInteractionController';
import {
  useChatScheduleController,
  type ScheduleReviewAction,
} from '../chat/useChatScheduleController';
import { useChatSessionsController } from '../chat/useChatSessionsController';
import { useChatHistorySearchController } from '../chat/useChatHistorySearchController';
import { useChatAppLaunchController } from '../chat/ChatAppLaunchPicker';
import { useChatDialerController } from '../chat/ChatDialerPicker';
import { useChatToolBridge } from '../chat/useChatToolBridge';
import {
  useChatVoiceRecorder,
  type ReleaseChatVoiceAudioForCall,
  type ResumeChatVoiceAudioAfterCall,
} from '../chat/useChatVoiceRecorder';

import { createChatReplyDelivery } from '../chat/chatReplyDelivery';
import { createChatContextCompressor } from '../chat/chatContextCompressor';
import {
  createChatReplyScheduling,
  releaseChatReplyWaitBackground,
  REPLY_IDLE_DELAY_MS,
  wait,
} from '../chat/chatReplyScheduling';
import { beginChatReplyBackground } from '../chat/chatReplyBackground';
import { prepareSavedChatSleepMessage } from '../chat/chatSendSleepRecovery';
import { loadChatPreferences, saveChatPreferences } from '../chat/chatPreferences';
import {
  recordKeywordCounterMessage,
  refreshKeywordCounterDeadlines,
} from '../chat/keywordCounterStore';
import {
  buildNotebookInteractionInstruction,
  consumePendingNotebookInteraction,
  loadPendingNotebookInteraction,
  type NotebookInteractionHandoff,
} from '../chat/notebookStore';
import {
  claimSleepingReply,
  confirmSleepingReply,
  recordPoke,
  recordPokeReplySent,
  recordSleepingMessage,
  releaseSleepingReply,
  updatePokeExperience,
} from '../chat/sleepInteraction';
import { createPokeInteraction, type PokeInteraction } from '../chat/chatPokeExperience';
import { AppTextInput as TextInput } from '../components/AppText';
import { useChatMemoryController } from '../memory/useChatMemoryController';
import { isRetiredMemoryActionReview } from '../chat/chatMemoryActionSuggestions';
import { loadPostHeartNotice, requestPostNoticeOpen, subscribePostNoticeRead, type PostNoticeTarget } from '../posts/baiyunPostNotice';
import { ensurePostReadingStarted } from '../posts/baiyunPostKnown';
import { requestCorrespondenceTab, subscribeBaiyunPosts } from '../posts/baiyunPostStore';
import { useMusicPlayer } from '../music/MusicPlayer';
import { useChatWishController } from '../chat/useChatWishController';
import { deleteGeneratedMemoriesForSourceRange } from '../memory/memoryStore';
import { describeMemoryProvision } from '../memory/memoryDebugExplanation';
import { getOverlayTextStyle, type HomeBackgroundReadability } from '../theme/homeReadability';
import {
  dateKey,
  hasScheduleConflict,
} from '../schedule/scheduleStore';
import { requestNotificationPermission, syncScheduleNotifications } from '../schedule/scheduleNotifications';
import { SCHEDULE_DATA_CHANGED_EVENT, type ScheduleDataChangedPayload } from '../schedule/scheduleEvents';
import { savePendingScheduleRequest } from '../schedule/scheduleHandoff';
import { observeRuntimeWorkload } from '../runtime/runtimeWorkloadDiagnostics';
import { confirmGoalTimeCredit } from '../schedule/goalProgressStore';
import type { PendingSchedulePlan } from '../schedule/dayScheduler';
import {
  expenseDraftToToolInput,
  registerMusicPlaybackExecutor,
  scheduleDraftToToolInput,
  todoDraftToToolInput,
} from '../tools';
import type { Navigate } from '../types/navigation';
import type { SkyTheme } from '../utils/sky';
import { useChatAutomaticSyncBusy } from '../chat/useChatAutomaticSyncBusy';
import type { ChatTheaterBackstagePort } from '../chat/chatTheaterBackstage';
import { TheaterBackstageBanner, TheaterBackstagePanel } from '../theater/TheaterBackstagePanel';
import { usePhoneLockChatHistory } from '../phoneRestriction/usePhoneLockChatHistory';
import { baiyunStatusPortraits } from '../assets/homeImages';

type Props = {
  pendingReadingReference?: import('../reading/readingReference').ReadingReference | null;
  onReadingReferenceSaved?: (reference: import('../reading/readingReference').ReadingReference) => void;
  onRemoveReadingReference?: () => void;
  theaterBackstage?: ChatTheaterBackstagePort;
  active: boolean;
  phoneLockChatVisible?: boolean;
  backgroundReadability: HomeBackgroundReadability;
  backgroundSettings: BackgroundSettings;
  navigate: Navigate;
  onVoiceAudioControlChange?: (control: {
    releaseVoiceAudioForCall: ReleaseChatVoiceAudioForCall;
    resumeVoiceAudioAfterCall: ResumeChatVoiceAudioAfterCall;
  } | null) => void;
  onAutomaticSyncBusyChange?: (busy: boolean) => void;
  externalMessageVersion?: number;
  skyTheme: SkyTheme;
  voiceCallAudioActive?: boolean;
};

type ScheduleChangeCard = NonNullable<SubjectiveMessage['scheduleChangeCard']>;

type ReplyPhase = ChatReplyPhase;

const REPLY_CONTEXT_BUDGET_MS = 300;
const DEV_RUNTIME_DIAGNOSTICS = __DEV__ && process.env.EXPO_PUBLIC_JUNLUO_RUNTIME_DIAGNOSTICS === '1';

const devNow = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now());
const devLogChatPerf = (label: string, fields: Record<string, unknown>) => {
  if (DEV_RUNTIME_DIAGNOSTICS) {
    console.log(`[perf][chat] ${label}`, fields);
  }
};

type ReplyContextCache = {
  cognition?: GlobalCognitionContext;
  dreamInstruction: string;
  scheduleReminderContext: string;
  updatedAt: number;
};

function readLikedStyleReferenceIds(raw: string | null) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && !!item.trim());
  } catch {
    return [];
  }
}


export function ChatScreen({
  pendingReadingReference,
  onReadingReferenceSaved,
  onRemoveReadingReference,
  theaterBackstage,
  active,
  phoneLockChatVisible = false,
  backgroundReadability,
  backgroundSettings,
  navigate,
  onAutomaticSyncBusyChange,
  onVoiceAudioControlChange,
  externalMessageVersion = 0,
  skyTheme,
  voiceCallAudioActive = false,
}: Props) {
  const insets = useSafeAreaInsets();
  const windowDimensions = useWindowDimensions();
  const musicPlayer = useMusicPlayer();
  const {
    chatConnection,
    chatKey,
    loaded: configLoaded,
    memoryOrganizerConnection,
    memoryOrganizerKey,
    profile,


    utilityJsonConnection,
    utilityJsonKey,
    lifeCreativeConnection,
    lifeCreativeKey,
  } = useAiConfigPreferences();
  const lifeCreativeConnectionForUse = lifeCreativeConnection ?? chatConnection;
  const lifeCreativeKeyForUse = lifeCreativeConnection ? lifeCreativeKey : chatKey;
  const [voiceDraftPresent, setVoiceDraftPresent] = useState(false);
  const [sending, setSending] = useState(false);
  const [waitingToReply, setWaitingToReply] = useState(false);
  const [replySessionId, setReplySessionId] = useState<string | null>(null);
  const [preparingReplySessionId, setPreparingReplySessionId] = useState<string | null>(null);
  const [waitingModeEnabled, setWaitingModeEnabled] = useState(true);
  const [morePanelOpen, setMorePanelOpen] = useState(false);
  const [morePanelNotice, setMorePanelNotice] = useState<string | null>(null);
  const [replyPhase, setReplyPhase] = useState<ReplyPhase>('idle');
  const [queuedMessageCount, setQueuedMessageCount] = useState(0);
  const replyDiagnostic = useChatReplyDiagnostic();
  const { error, setError } = replyDiagnostic;
  const [pokeBubble, setPokeBubble] = useState<{ anchorId: string; text: string } | null>(null);
  const [pokePreparingSessionId, setPokePreparingSessionId] = useState<string | null>(null);
  const [memoryRecallOpen, setMemoryRecallOpen] = useState(false);
  const [memoryRecallTechnicalOpen, setMemoryRecallTechnicalOpen] = useState(false);
  const memoryRecallVerticalPadding = Math.max(insets.top, 24) + Math.max(insets.bottom, 24) + 32;
  const memoryRecallPanelHeight = Math.max(
    360,
    Math.min(windowDimensions.height * 0.72, windowDimensions.height - memoryRecallVerticalPadding),
  );
  const [organizedThroughId, setOrganizedThroughId] = useState<string | null>(null);
  const [proactiveReviewedThroughId, setProactiveReviewedThroughId] = useState<string | null>(null);
  const [tokenDetailsOpen, setTokenDetailsOpen] = useState(false);
  const [promptCacheSummary, setPromptCacheSummary] = useState<PromptCacheMetricsSummary | null>(null);
  const [compressingContext, setCompressingContext] = useState(false);
  const [compressionState, setCompressionState] = useState<ChatContextCompressionState>(
    emptyChatContextCompressionState,
  );
  const compressionStateRef = useRef<ChatContextCompressionState>(emptyChatContextCompressionState);
  const historySearch = useChatHistorySearchController(active);
  const appLaunch = useChatAppLaunchController(active);
  const dialer = useChatDialerController(active);
  const [pendingNotebookInteraction, setPendingNotebookInteraction] = useState<NotebookInteractionHandoff | null>(null);

  useEffect(() => {
    if (!tokenDetailsOpen) return;
    let cancelled = false;
    void loadPromptCacheMetricsSummary({ sinceMs: Date.now() - 24 * 60 * 60 * 1000 })
      .then((summary) => {
        if (!cancelled) setPromptCacheSummary(summary);
      })
      .catch(() => {
        if (!cancelled) setPromptCacheSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [compressionState.promptCache, tokenDetailsOpen]);
  useEffect(() => registerMusicPlaybackExecutor((song) => musicPlayer.playSong(song)), [musicPlayer.playSong]);
  const [assistantStatus, setAssistantStatus] = useState(DEFAULT_ASSISTANT_STATE);
  const listRef = useRef<FlatList<SubjectiveMessage>>(null);
  const drawerRef = useRef<ChatDrawerHandle>(null);
  const inputRef = useRef<React.ElementRef<typeof TextInput>>(null);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  const scrollToLatestOnOpenRef = useRef(false);
  const nearBottomRef = useRef(true);
  const scrollToEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollToEndFrameRef = useRef<number | null>(null);
  const scrollToEndBurstTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const chatOpenScrollStateRef = useRef({ compactionVersion: 0, sessionId: null as string | null });
  const requestRef = useRef<AbortController | null>(null);
  const { draftRef, draftResetVersion, updateDraft, clearDraft, finishSend: finishDraftSend } = useChatComposerDraft(setError);
  const clearDraftInput = (preserveStored = false) => {
    const sentDraft = clearDraft(preserveStored);
    inputRef.current?.clear();
    setVoiceDraftPresent(false);
    return sentDraft;
  };
  const replyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const replyWaitStateRef = useRef(createChatReplyWaitState());
  const slowNetworkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitingToReplyRef = useRef(false);
  const replySessionIdRef = useRef<string | null>(null);
  const pendingReplySessionIdRef = useRef<string | null>(null);
  const pendingReplyDataEpochRef = useRef<number | null>(null);
  const pendingNotebookInteractionRef = useRef<NotebookInteractionHandoff | null>(null);
  const notebookSelectionVersionRef = useRef(0);
  const notebookCancellationRef = useRef<Promise<unknown> | null>(null);
  const pendingNotebookReplyRef = useRef<{ handoff: NotebookInteractionHandoff; instruction: string } | null>(null);
  const waitingModeEnabledRef = useRef(true);
  const waitingModeTouchedRef = useRef(false);
  const waitingModeSaveVersionRef = useRef(0);
  const sendingRef = useRef(false);
  const needsFollowUpRef = useRef(false);
  const deliveredScheduleAfterwordIdsRef = useRef(new Set<string>());
  const answeredYouMessageIdsRef = useRef(new Set<string>());
  const lastSendRef = useRef({ at: 0, text: '' });
  const sendDraftInFlightRef = useRef(false);
  const sendPersistenceRef = useRef(createChatSendPersistenceCoordinator());
  const pendingFactMessagesRef = useRef<SubjectiveMessage[]>([]);
  const replyContextCacheRef = useRef<ReplyContextCache>({
    dreamInstruction: '',
    scheduleReminderContext: '',
    updatedAt: 0,
  });
  const lastReplyCompletedAtRef = useRef(0);
  const sendActionRef = useRef<ChatSendAction | null>(null);
  const lastScheduleNudgeRef = useRef<ScheduleNudgeState | null>(null);
  const compressionInFlightRef = useRef(false);
  const messageInteractionResetRef = useRef<() => void>(() => undefined);
  const pokeBubbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pokeInteractionInFlightRef = useRef(false);
  const pokeCancellationVersionRef = useRef(0);
  const pendingPokeRef = useRef<{
    anchorId: string;
    sessionId: string | null;
    resume?: () => Promise<void>;
    input?: { fact: PokeInteraction; dataEpoch: number | null };
  } | null>(null);
  const historyBrowsingRef = useRef(historySearch.browsing);
  historyBrowsingRef.current = historySearch.browsing;
  const {
    activeSessionId, activeSessionRef, activateStoredSessionById,
    commitMessages, commitSessionMessages,
    deleteActiveVoiceCallRecordMessage,
    hiddenHistoryCount,
    historyCompactionVersion,
    historyLoaded,
    loadedMessageStartIndex,
    messages,
    messagesRef,
    messagesSessionIdRef,
    patchSession,
    persistSessionMessages,
    revealOlderMessages,
    rollbackActiveSessionToMessage,
    sessionMessagesLoading,
    sessionsRef,
    updateMessageDeliveryStatus,
  } = useChatSessionsController({
    active,
    compressionState,
    externalMessageVersion,
    sending,
    isSending: () => sendingRef.current,
    onStorageError: (reason) => setError(reason),
    onConversationActivated: () => {
      if (replySessionIdRef.current !== activeSessionRef.current) cancelActiveReply();
      pendingFactMessagesRef.current = [];
      answeredYouMessageIdsRef.current = new Set();
      setMemoryCandidates([]);
      setError(null);
      setMemoryNotice(null);
      messageInteractionResetRef.current();
    },
    onExternalMessagesApplied: () => startScrollToLatestBurst(),
    onSessionContextLoaded: (session) => {
      setOrganizedThroughId(session.memoryOrganizedThroughId);
      setProactiveReviewedThroughId(session.proactiveMemoryReviewedThroughId);
      const nextCompression = session.contextCompression ?? emptyChatContextCompressionState;
      compressionStateRef.current = nextCompression;
      setCompressionState(nextCompression);
    },
    organizedThroughId,
    proactiveReviewedThroughId,
  });

  useEffect(() => replyDiagnostic.clearDiagnostic(), [activeSessionId, replyDiagnostic.clearDiagnostic]);
  const configured = !!chatConnection?.baseUrl.trim() && !!chatConnection?.model.trim() && !!chatKey.trim();
  const utilityJsonConfigured = !!utilityJsonConnection?.baseUrl.trim() && !!utilityJsonConnection?.model.trim();
  const getUtilityJsonModel = () => {
    const connection = utilityJsonConfigured ? utilityJsonConnection : chatConnection;
    const apiKey = utilityJsonConfigured ? utilityJsonKey.trim() : chatKey.trim();
    if (!connection) throw new Error('请先在白云与连接中配置模型，白云才能处理这些小任务。');
    if (!apiKey.trim()) throw new Error(utilityJsonConfigured ? '当前小任务模型还没有 API Key。' : '请先在白云与连接中填写 API Key。');
    return { apiKey, connection };
  };

  const scheduleNoticeCallbackRef = useRef<(message: string, durationMs: number) => void>(() => undefined);
  const schedulePlanCardChangeCallbackRef = useRef<(
    plan: PendingSchedulePlan,
    status?: NonNullable<SubjectiveMessage['schedulePlanCard']>['status'],
  ) => void>(() => undefined);
  const scheduleAfterwordConfirmedCallbackRef = useRef<(
    id: string,
    kind: ScheduleAfterwordKind,
    target: PendingSchedulePlan | ScheduleChangeCard,
  ) => void>(() => undefined);
  const {
    acceptAmbiguousSchedule,
    ambiguousScheduleText,
    beginGoalAdjustment,
    beginGoalTimeCreditEdit,
    beginScheduleAdjustment,
    cancelPendingGoal,
    cancelScheduleChangeCard,
    cancelScheduleReview,
    clearGoalTimeCreditEdit,
    clearPendingPostponeText,
    clearPendingScheduleDateText,
    clearScheduleReviews,
    confirmGoalTimeCreditCard,
    confirmPendingGoal,
    confirmPendingSchedulePlan,
    editDayPlanEntry,
    setDayPlanEndQuestions,
    removeDayPlanEntry,
    consumePendingAdjustment,
    confirmScheduleChangeCard,
    discardPendingSchedulePlan,
    dismissScheduleReview,
    editingGoalTimeCredit,
    pendingGoalProposal,
    pendingSchedulePlan,
    saveHabitReview,
    scheduleAdjustmentMode,
    schedulePlanSaving,
    skipGoalTimeCreditCard,
    takeRejectedAmbiguousScheduleText,
    visibleScheduleReviews,
  } = useChatScheduleController({
    persistDayPlan: async (plan, status, sessionId) => {
      const base = activeSessionRef.current === sessionId ? messagesRef.current
        : sessionsRef.current.find((session) => session.id === sessionId)?.messages;
      if (!base) return false;
      const next = base.map((message) => message.schedulePlanCard?.plan.id === plan.id
        ? { ...message, schedulePlanCard: { plan, status } } : message);
      commitSessionMessages(sessionId, next);
      return await persistSessionMessages(sessionId, next) !== 'failed';
    },
    requestDayPlanReply: (sessionId, results) => runReply({ sourceSessionId: sessionId, dayPlanReceipt: true, toolResults: results }),
    requestDayPlanAdjustment: (plan, canCommit) => runReply({ dayPlanAdjustment: { plan, canCommit } }),
    activeSessionId,
    chatConnection,
    chatKey,
    commitMessages,
    configured,
    emitScheduleDataChanged: (payload) => DeviceEventEmitter.emit(SCHEDULE_DATA_CHANGED_EVENT, payload ?? {}),
    getUtilityJsonModel,
    messages,
    messagesRef,
    onAfterwordCancelled: () => undefined,
    onAfterwordConfirmed: (id, kind, target) => scheduleAfterwordConfirmedCallbackRef.current(id, kind, target),
    onChangeCardStatus: (cardId, status) => {
      commitMessages(messagesRef.current.map((message) => message.scheduleChangeCard?.id === cardId
        ? { ...message, scheduleChangeCard: { ...message.scheduleChangeCard, status } }
        : message));
    },
    onError: setError,
    onNotice: (message, durationMs) => scheduleNoticeCallbackRef.current(message, durationMs),
    onPlanCardChange: (plan, status) => schedulePlanCardChangeCallbackRef.current(plan, status),
    onPlanConflict: () => {
      Alert.alert('方案和新日程撞车了', '确认前出现了新的占用。方案还留着，鼠可以点“调整一下”重新排。');
    },
  });

  const [baiyunHeartUnread, setBaiyunHeartUnread] = useState(false);
  const baiyunHeartTargetRef = useRef<PostNoticeTarget | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true, running = false, again = false;
    const refresh = async () => {
      if (running) { again = true; return; }
      running = true;
      try {
        do {
          again = false;
          const next = await loadPostHeartNotice();
          if (live && !again) {
            baiyunHeartTargetRef.current = next;
            setBaiyunHeartUnread(Boolean(next));
          }
        } while (live && again);
      } catch { /* A temporary read failure must not acknowledge unread content. */ }
      finally { running = false; }
    };
    void refresh();
    const changed = subscribeBaiyunPosts(() => { void refresh(); });
    const viewed = subscribePostNoticeRead(() => { void refresh(); });
    return () => { live = false; changed(); viewed(); };
  }, [active, externalMessageVersion]);

  const openBaiyunHeartTab = () => {
    requestPostNoticeOpen(baiyunHeartTargetRef.current);
    requestCorrespondenceTab('posts');
    navigate('letter');
  };

  const chatMemory = useChatMemoryController({
    activeSessionRef,
    isActive: () => activeRef.current,
    ai: {
      connection: memoryOrganizerConnection,
      key: memoryOrganizerKey,
    },
    automaticExplicitFactMemories: profile.automaticExplicitFactMemories,
    onOrganizedThroughIdChange: setOrganizedThroughId,
    onProactiveReviewedThroughIdChange: setProactiveReviewedThroughId,
    proactiveMemorySuggestions: profile.proactiveMemorySuggestions,
    messages,
  });
  const {
    flagRecallAsIrrelevant,
    flaggedRecallIds,
    currentStateCandidates,
    currentStateResolveCandidates,
    latestMemoryDebug,
    latestMemoryRecall,
    memoryCandidates,
    memoryNotice,
    organizing,
    setLatestRecallFromCognition,
    setMemoryCandidates,
    setMemoryNotice,
    clearSessionMemoryState,
    showTransientMemoryNotice,
  } = chatMemory;
  scheduleNoticeCallbackRef.current = showTransientMemoryNotice;
  const keyboard = useAnimatedKeyboard({
    isNavigationBarTranslucentAndroid: true,
    isStatusBarTranslucentAndroid: true,
  });
  const composerBottomPadding = Math.max(insets.bottom + 12, 28);
  const getComposerLift = (keyboardHeight: number) => {
    'worklet';
    const coveredBottomInset = composerBottomPadding - 12;
    return keyboardHeight > 0 ? Math.max(0, keyboardHeight - coveredBottomInset) : 0;
  };
  const openDrawer = () => {
    const startedAt = devNow();
    Keyboard.dismiss();
    drawerRef.current?.open();
    requestAnimationFrame(() => {
      devLogChatPerf('drawer-open-frame', {
        ms: Math.round(devNow() - startedAt),
        sessions: sessionsRef.current.length,
      });
    });
  };
  const closeDrawer = () => {
    const startedAt = devNow();
    drawerRef.current?.close();
    requestAnimationFrame(() => {
      devLogChatPerf('drawer-close-frame', {
        ms: Math.round(devNow() - startedAt),
        sessions: sessionsRef.current.length,
      });
    });
  };
  const composerKeyboardStyle = useAnimatedStyle(() => {
    const keyboardHeight = Platform.OS === 'android' ? keyboard.height.value : 0;
    return {
      transform: [{ translateY: -keyboardHeight }],
    };
  });
  const composerLiftStyle = useAnimatedStyle(() => {
    const keyboardHeight = Platform.OS === 'android' ? keyboard.height.value : 0;
    const lift = getComposerLift(keyboardHeight);
    return {
      transform: [{ translateY: -lift }],
    };
  });
  const composerDockKeyboardStyle = useAnimatedStyle(() => {
    const keyboardHeight = Platform.OS === 'android' ? keyboard.height.value : 0;
    const lift = getComposerLift(keyboardHeight);
    return {
      transform: [{ translateY: -lift }],
    };
  });
  const titleTextStyle = useMemo(
    () => getOverlayTextStyle(backgroundReadability.headerText),
    [backgroundReadability.headerText],
  );
  const availabilityText = configured ? describeAssistantAvailability(assistantStatus.lifeMode) : '等待连接';
  const contextWindowTokens = chatConnection?.contextWindowTokens ?? 65536;
  const contextUsagePercentage = Math.min(
    100,
    Math.max(0, (compressionState.currentWindowTokens / contextWindowTokens) * 100),
  );
  const compressionThresholdPercentage = (chatConnection?.contextCompressionThreshold ?? 0.7) * 100;
  const shortChatLogs = compressionState.shortLogs ?? [];
  const tokenRingColor =
    contextUsagePercentage >= 90
      ? '#D95F55'
      : contextUsagePercentage >= compressionThresholdPercentage
        ? '#D49A3A'
        : '#6A9EC8';
  const replyBusy = sending || waitingToReply;
  const visibleReplyPreparing = preparingReplySessionId !== null && preparingReplySessionId === activeSessionId;
  const visibleReplyBusy = visibleReplyPreparing || (replyBusy && replySessionId === activeSessionId);
  const visibleReplyPhase = visibleReplyPreparing ? 'waitingForUser' : replyPhase;
  const sendActsAsStop = sending && replySessionId === activeSessionId;
  const {
    cancelVoiceRecording,
    disableVoiceMode,
    finishVoiceRecording,
    hasActiveVoiceCapture,
    hasActiveVoiceOperation,
    releaseVoiceAudioForCall,
    resumeVoiceAudioAfterCall,
    runVoiceResponderAction,
    startVoiceRecording,
    toggleVoiceMode,
    voiceBusy,
    voiceCancelAvailable,
    voiceCaptureActive,
    voiceMode,
    voiceRecordStartedAt,
    voiceRecordingVisible,
    voiceSendAvailable,
    voiceStarting,
  } = useChatVoiceRecorder({
    active,
    configLoaded,
    hasDraft: voiceDraftPresent,
    onBeforeStart: () => {
      Keyboard.dismiss();
      setMorePanelOpen(false);
      setMorePanelNotice(null);
    },
    onError: setError,
    onNotice: showTransientMemoryNotice,
    replyBusy,
    sendVoiceMessage: ({ duplicateKey, onAccepted, prepareAfterPersist, text, voice }) => sendUserMessage(
      text,
      { voice },
      { clearDraft: false, duplicateKey, onAccepted, prepareAfterPersist },
    ),
    transcribeVoice: (input) => executeChatTool('voice.transcribe', input, undefined, { requestedBy: 'manual' }),
    voiceCallAudioActive,
  });
  useEffect(() => {
    onVoiceAudioControlChange?.({
      releaseVoiceAudioForCall,
      resumeVoiceAudioAfterCall,
    });
    return () => onVoiceAudioControlChange?.(null);
  }, [onVoiceAudioControlChange, releaseVoiceAudioForCall, resumeVoiceAudioAfterCall]);
  const visibleMessages = messages;
  const visibleMessageStartIndex = loadedMessageStartIndex;
  const reversedVisibleMessages = useMemo(() => [...visibleMessages].reverse(), [visibleMessages]);
  const exposedLabelTextStyle = useMemo(
    () => getOverlayTextStyle(backgroundReadability.exposedLabelText),
    [backgroundReadability.exposedLabelText],
  );

  const cancelScheduledScrollToEnd = () => {
    if (scrollToEndTimerRef.current) {
      clearTimeout(scrollToEndTimerRef.current);
      scrollToEndTimerRef.current = null;
    }
    if (scrollToEndFrameRef.current !== null) {
      cancelAnimationFrame(scrollToEndFrameRef.current);
      scrollToEndFrameRef.current = null;
    }
  };

  const clearScrollToEndBurstTimers = () => {
    scrollToEndBurstTimersRef.current.forEach((timer) => clearTimeout(timer));
    scrollToEndBurstTimersRef.current = [];
  };

  const scheduleScrollToEnd = (animated = false, delayMs = 60, clearOpenFlag = true) => {
    if (historyBrowsingRef.current) return;
    cancelScheduledScrollToEnd();
    scrollToEndTimerRef.current = setTimeout(() => {
      scrollToEndTimerRef.current = null;
      scrollToEndFrameRef.current = requestAnimationFrame(() => {
        scrollToEndFrameRef.current = null;
        if (historyBrowsingRef.current) return;
        listRef.current?.scrollToOffset({ animated, offset: 0 });
        if (clearOpenFlag) {
          scrollToLatestOnOpenRef.current = false;
        }
        nearBottomRef.current = true;
      });
    }, delayMs);
  };

  const startScrollToLatestBurst = () => {
    if (historyBrowsingRef.current) return;
    clearScrollToEndBurstTimers();
    scrollToLatestOnOpenRef.current = true;
    nearBottomRef.current = true;
    [0, 60, 140, 280, 520, 900, 1400, 2100].forEach((delayMs, index, delays) => {
      const timer = setTimeout(() => {
        if (!mountedRef.current || !activeRef.current) return;
        scheduleScrollToEnd(false, 0, false);
        if (index === delays.length - 1) {
          scrollToLatestOnOpenRef.current = false;
        }
      }, delayMs);
      scrollToEndBurstTimersRef.current.push(timer);
    });
  };

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const scheduleKeyboardEdgeScroll = () => {
      if (active && nearBottomRef.current) {
        scheduleScrollToEnd(false, 30);
      }
    };
    const showSubscription = Keyboard.addListener('keyboardDidShow', scheduleKeyboardEdgeScroll);
    const hideSubscription = Keyboard.addListener('keyboardDidHide', scheduleKeyboardEdgeScroll);
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [active]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      clearScrollToEndBurstTimers();
      scrollToLatestOnOpenRef.current = false;
    }
  }, [active]);

  const { appendAssistantBubbles } = createChatReplyDelivery({
    activeSessionRef, messagesSessionIdRef, messagesRef, sessionsRef,
    commitMessages, commitSessionMessages,
    getCurrentMusicCardLimit: () => getCurrentMusicCardLimit(),
    wait,
  });

  useEffect(() => {
    if (!active) return;
    void refreshKeywordCounterDeadlines().catch(() => undefined);
  }, [active, externalMessageVersion]);

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    const version = ++notebookSelectionVersionRef.current;
    void Promise.resolve(notebookCancellationRef.current).then(() => loadPendingNotebookInteraction())
      .then((handoff) => {
        if (!mounted || version !== notebookSelectionVersionRef.current) return;
        pendingNotebookInteractionRef.current = handoff;
        setPendingNotebookInteraction(handoff);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [active, externalMessageVersion]);

  const cancelNotebookInteraction = () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    ++notebookSelectionVersionRef.current;
    pendingNotebookInteractionRef.current = null;
    setPendingNotebookInteraction(null);
    notebookCancellationRef.current = runBackupRestoreDataEpochCommit(dataEpoch,
      () => consumePendingNotebookInteraction()).catch(() => {
        if (canCommitBackupRestoreDataEpoch(dataEpoch)) setError('小本本选择清除失败，重新进入聊天后请再次取消。');
      });
  };

  useEffect(() => {
    compressionStateRef.current = compressionState;
  }, [compressionState]);

  useEffect(() => {
    waitingModeEnabledRef.current = waitingModeEnabled;
  }, [waitingModeEnabled]);

  useEffect(() => {
    if (!active) {
      setMorePanelOpen(false);
      setMorePanelNotice(null);
    }
  }, [active]);

  useEffect(() => {
    setMemoryRecallOpen(false);
  }, [activeSessionId]);

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    void loadAssistantState().then((state) => {
      if (mounted) setAssistantStatus(state);
    });
    const unsubscribe = subscribeAssistantStateChanged((state) => {
      if (mounted) setAssistantStatus(state);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [active]);

  useEffect(() => {
    if (!active || !configLoaded) return;
    let mounted = true;
    const refreshState = async () => {
      const startedAt = devNow();
      const state = await observeRuntimeWorkload('chat.life_refresh', (span) => refreshAssistantLifeState({
        diagnosticParentToken: span?.token, profile,
      }));
      devLogChatPerf('assistant-state-refresh', {
        ms: Math.round(devNow() - startedAt),
        lifeMode: state.lifeMode,
        sourceType: state.sourceType,
      });
      if (mounted) setAssistantStatus(state);
    };

    void refreshState().catch(() => undefined);
    const intervalId = setInterval(() => void refreshState().catch(() => undefined), 60 * 1000);
    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, [active, configLoaded, profile]);

  useEffect(() => {
    if (!active || !historyLoaded || sendingRef.current) return;
    const controller = new AbortController();
    let prewarmTimer: ReturnType<typeof setTimeout> | null = null;
    const interactionTask = InteractionManager.runAfterInteractions(() => {
      prewarmTimer = setTimeout(() => {
        if (controller.signal.aborted || sendingRef.current) return;
        void observeRuntimeWorkload('chat.cognition_prewarm', (span) => buildGlobalCognitionContext('', 'chat', {
          allowNetwork: false, ambientCacheOnly: true, includeMemory: false, diagnosticParentToken: span?.token,
          signal: controller.signal, useSemanticMemory: false,
          touchMemory: false, numberMemories: true,
        }))
          .then(async (cognition) => {
            if (controller.signal.aborted) return;
            await ensurePostReadingStarted().catch(() => undefined);
            if (controller.signal.aborted) return;
            replyContextCacheRef.current = {
              ...replyContextCacheRef.current,
              cognition,
              updatedAt: Date.now(),
            };
          })
          .catch(() => undefined);
      }, 350);
    });
    return () => {
      controller.abort();
      if (prewarmTimer) clearTimeout(prewarmTimer);
      interactionTask.cancel?.();
    };
  }, [active, historyLoaded]);

  useEffect(() => {
    if (!active) return;
    const backSubscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (hasActiveVoiceOperation()) {
        void cancelVoiceRecording();
        return true;
      }
      if (drawerRef.current?.isOpen()) {
        closeDrawer();
        return true;
      }
      navigate('home');
      return true;
    });

    return () => {
      backSubscription.remove();
    };
  }, [active, navigate]);

  useEffect(() => {
    if (!active || !historyLoaded || !activeSessionId) return;
    const previous = chatOpenScrollStateRef.current;
    const shouldScroll = previous.sessionId !== activeSessionId
      || previous.compactionVersion !== historyCompactionVersion;
    chatOpenScrollStateRef.current = { compactionVersion: historyCompactionVersion, sessionId: activeSessionId };
    if (shouldScroll) startScrollToLatestBurst();
  }, [active, activeSessionId, historyCompactionVersion, historyLoaded]);

  useEffect(() => {
    if (!active || !visibleReplyBusy || visibleReplyPhase === 'idle') return;
    if (nearBottomRef.current) {
      scheduleScrollToEnd(true, 45);
    }
  }, [active, queuedMessageCount, visibleReplyPhase, visibleReplyBusy]);

  useEffect(() => {
    if (!active || !historyLoaded || sessionMessagesLoading || !messages.length) return;
    const latest = messages[messages.length - 1];
    if (scrollToLatestOnOpenRef.current) {
      scheduleScrollToEnd(false, 45, false);
      return;
    }
    if (nearBottomRef.current || latest?.role === 'you' || visibleReplyBusy) {
      scheduleScrollToEnd(true, 45);
    }
  }, [active, historyLoaded, messages.length, sessionMessagesLoading, visibleReplyBusy]);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    void loadChatPreferences().then((preferences) => {
      if (!active) return;
      if (!waitingModeTouchedRef.current) {
        waitingModeEnabledRef.current = preferences.waitingModeEnabled;
        setWaitingModeEnabled(preferences.waitingModeEnabled);
      }
      hydrateMusicPreferences(preferences);
    });
    return () => {
      active = false;
      mountedRef.current = false;
      releaseChatReplyWaitBackground(replyTimerRef);
      if (replyTimerRef.current) clearTimeout(replyTimerRef.current);
      if (slowNetworkTimerRef.current) {
        clearTimeout(slowNetworkTimerRef.current);
        slowNetworkTimerRef.current = null;
      }
      cancelScheduledScrollToEnd();
      clearScrollToEndBurstTimers();
      if (pokeBubbleTimerRef.current) clearTimeout(pokeBubbleTimerRef.current);
    };
  }, []);

  const {
    clearSlowNetworkTimer, startSlowNetworkTimer, cancelPendingReplyWait,
    pausePendingReplyWaitForOutgoingMessage, scheduleReply,
  } = createChatReplyScheduling({
    activeSessionRef, draftRef, pendingNotebookReplyRef, pendingReplyDataEpochRef,
    pendingReplySessionIdRef, replySessionIdRef, replyTimerRef, replyWaitStateRef,
    requestRef, sendingRef, slowNetworkTimerRef, waitingModeEnabledRef, waitingToReplyRef,
    setReplyPhase, setReplySessionId, setWaitingToReply,
    runReply: (options) => runReply(options),
  });
  const emitScheduleDataChanged = (payload: ScheduleDataChangedPayload = {}) => {
    DeviceEventEmitter.emit(SCHEDULE_DATA_CHANGED_EVENT, payload);
  };

  const appendScheduleAfterword = async (
    id: string,
    kind: ScheduleAfterwordKind,
    target: PendingSchedulePlan | ScheduleChangeCard,
  ) => {
    if (deliveredScheduleAfterwordIdsRef.current.has(id)) return;
    deliveredScheduleAfterwordIdsRef.current.add(id);
    const contents = buildScheduleAfterwordFallback(kind, target);
    if (!contents.length) return;
    await appendAssistantBubbles(contents, { source: 'schedule-plan' });
  };

  const upsertSchedulePlanMessage = (
    plan: PendingSchedulePlan,
    status: NonNullable<SubjectiveMessage['schedulePlanCard']>['status'] = 'pending',
  ) => {
    const existingIndex = messagesRef.current.findIndex((message) => message.schedulePlanCard?.plan.id === plan.id);
    if (existingIndex < 0) {
      commitMessages([
        ...messagesRef.current,
        createSubjectiveMessage('I', '我把这一天的安排整理成方案啦，小仓鼠先看看，确认后才会放进日程。', {
          source: 'schedule-plan',
          schedulePlanCard: { plan, status },
        }),
      ]);
      return;
    }
    commitMessages(messagesRef.current.map((message, index) => index === existingIndex
      ? { ...message, schedulePlanCard: { plan, status } }
      : message));
  };
  schedulePlanCardChangeCallbackRef.current = upsertSchedulePlanMessage;
  scheduleAfterwordConfirmedCallbackRef.current = (id, kind, target) => {
    void appendScheduleAfterword(id, kind, target);
  };

  const {
    executeChatTool,
    showToolResultNotice,
  } = useChatToolBridge({
    activeSessionId: activeSessionRef.current,
    commitMessages,
    configured,
    messagesRef,
    onNotice: showTransientMemoryNotice,
    onReplyPhaseChange: (phase) => setReplyPhase(phase),
    onScheduleDataChanged: emitScheduleDataChanged,
    requestToolReply: (results, toolReceiptContexts) => runReply({
      toolResults: results,
      toolReceiptContexts,
    }),
  });

  const {
    actions: {
      adjustMemoryCandidateImportance,
      beginReplyToMessage,
      clearReplyingToMessage,
      closeEditingMessage,
      closeMemorySelection,
      closeOrganizationModal,
      confirmOrganizeMemories,
      confirmSelectedMemoryMessages,
      discardMemoryCandidate,
      getAssistantReplyRound,
      handleMessageLongPress,
      handleOrganizeMemories,
      openSelectedMemoryOrganizer,
      resetConversationInteraction,
      saveCandidate,
      saveCurrentStateCandidate,
      saveCurrentStateResolveCandidate,
      saveEditedMessage,
      toggleMemoryCandidateAnchor,
      toggleMemoryCandidatePinned,
      toggleAssistantReplyRoundHeart,
      toggleSelectedMemoryMessage,
      updateEditingMessageText,
      updateMemoryCandidate,
    },
    showShortMemoryNotice,
    state: {
      editingMessage,
      editingMessageText,
      likedStyleReferenceIds,
      memorySelectionOpen,
      pendingOrganizationMessages,
      pendingOrganizationMode,
      replyingToMessage,
      selectedMemoryMessageIds,
    },
  } = useChatMessageInteractionController({
    memory: {
      controller: chatMemory,
      organizerConnection: memoryOrganizerConnection,
      organizerKey: memoryOrganizerKey,
      organizedThroughId,
    },
    messages: {
      activeSessionId,
      commitMessages,
      messages,
      messagesRef,
      presentedMessages: historySearch.browsing ? historySearch.window?.messages ?? [] : messages,
      saveMessageContent: async (original, content) => {
        const sessionId = activeSessionRef.current;
        if (!sessionId) return false;
        const epoch = captureBackupRestoreDataEpoch();
        try {
          const updated = await editStoredChatMessageContent(sessionId, original.id, content);
          if (!canCommitBackupRestoreDataEpoch(epoch) || sessionId !== activeSessionRef.current) return false;
          if (!updated) {
            setError('这条消息已不存在，未保存修改。');
            return false;
          }
          if (messagesRef.current.some(message => message.id === original.id)) {
            commitMessages(messagesRef.current.map(message => message.id === original.id ? updated : message));
          }
          return true;
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : '消息修改保存失败。');
          return false;
        }
      },
    },
    page: {
      active,
      onError: setError,
      onOpenAiSettings: () => navigate('ai-settings'),
      onRollbackToMessage: (message) => handleRollbackToMessage(message),
      replyBusy,
    },
    tools: {
      executeChatTool,
      showToolResultNotice,
    },
  });
  messageInteractionResetRef.current = resetConversationInteraction;

  const {
    controlMusic,
    getCurrentMusicCardLimit,
    getPreferencesSnapshot,
    hydrateMusicPreferences,
    isMusicEnabled,
    musicAutoplay,
    musicConnectionOpen,
    musicCookieBusy,
    musicCookieDraft,
    musicCookieSaved,
    musicEnabled,
    musicMultipleCardsEnabled,
    musicSettingsOpen,
    playMusicSong,
    resolveMusicCard,
    resolveMusicCardsSequentially,
    saveMusicCookie,
    setMusicAutoplay,
    setMusicCookieDraft,
    setMusicEnabled,
    setMusicMultipleCardsEnabled,
    toggleMusicConnection,
    toggleMusicSettings,
  } = useChatMusicController({
    active,
    commitMessages,
    getWaitingModeEnabled: () => waitingModeEnabledRef.current,
    historyLoaded,
    messages,
    onError: setError,
    onNotice: setMorePanelNotice,
    persistRepairedMessages: async (nextMessages) => {
      if (await persistSessionMessages(activeSessionRef.current, nextMessages) === 'failed') throw new Error('chat_music_repair_persist_failed');
    },
    requestMusicPlayback: (song, sourceMessageId, executionContext) => executeChatTool('music.play', { song }, sourceMessageId, { ...executionContext, requestedBy: 'manual', silent: true }),
    requestMusicControl: (action, sourceMessageId) => executeChatTool('music.control', { action }, sourceMessageId, { requestedBy: 'manual', silent: true }),
    searchMusicCandidates: (input, sourceMessageId, executionContext) => executeChatTool('music.search_candidates', input, sourceMessageId, { ...executionContext, requestedBy: 'manual', silent: true }),
  });

  const {
    applyWalletChatResult,
    beginEditingExpenseReview,
    cancelEditingExpenseReview,
    clearExpenseReviews,
    dismissExpenseReview,
    dismissWalletDecisionReview,
    editingExpenseNote,
    editingExpenseReviewId,
    expenseReviews,
    markWalletDecisionReview,
    openWalletFromReview,
    prepareWalletChatContext,
    reportWalletUnavailable,
    resolveWalletChatIntent,
    saveExpenseReview,
    saveExpenseReviewNote,
    saveWalletDecisionReview,
    updateEditingExpenseNote,
    walletDecisionReviews,
  } = useChatExpenseController({
    active,
    chatConnection,
    chatKey,
    commitMessages,
    configured,
    createExpenseEntry: async (draft, reviewId) => {
      const result = await executeChatTool('expense.create_entry', expenseDraftToToolInput(draft), reviewId, { requestedBy: 'manual' });
      if (!result.ok) {
        showToolResultNotice(result, '');
        return false;
      }
      return true;
    },
    externalMessageVersion,
    getUtilityJsonModel,
    messagesRef,
    onEmptyExpenseNote: () => {
      Alert.alert('备注还空着', '给这笔账留一句简单说明，之后翻小账本才看得懂。');
    },
    onExternalWalletNoticesApplied: startScrollToLatestBurst,
    onNavigateToWallet: () => navigate('expense'),
    onNotice: showTransientMemoryNotice,
  });

  const continuityReviews = useChatContinuityReviewController({
    active,
    messages,
    onError: setError,
    sessionId: activeSessionId,
  });
  const wishDiscussion = useChatWishController({ active: active && historyLoaded,
    busy: replyBusy || !!draftRef.current.trim(), sessionId: activeSessionId });

  const handleWalletChatIntent = async (
    text: string,
    existingMessage?: SubjectiveMessage,
    dataEpoch = captureBackupRestoreDataEpoch(),
  ) => {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    cancelPendingReplyWait();
    if (!existingMessage) {
      const youMessage = createSubjectiveMessage('you', text);
      commitMessages([...messagesRef.current, youMessage]);
      clearDraftInput();
    }
    setError(null);
    waitingToReplyRef.current = true;
    setWaitingToReply(true);
    setReplyPhase('requesting');

    try {
      const walletCommit = await runBackupRestoreDataEpochCommit(
        dataEpoch,
        () => prepareWalletChatContext(text),
      );
      if (!walletCommit.committed) return;
      const result = await resolveWalletChatIntent(text, walletCommit.value);
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      applyWalletChatResult(result);
    } catch {
      reportWalletUnavailable();
    } finally {
      waitingToReplyRef.current = false;
      setWaitingToReply(false);
      setReplyPhase('idle');
    }
  };


  const handleDraftChange = (value: string) => {
    updateDraft(value);
    if (voiceMode) {
      const nextHasDraft = !!value.trim();
      setVoiceDraftPresent((current) => current === nextHasDraft ? current : nextHasDraft);
    }

    if (pokeInteractionInFlightRef.current) return;
    const draftTransition = reviseChatReplyDraft(replyWaitStateRef.current, !!value.trim());
    replyWaitStateRef.current = draftTransition.state;
    if (sendingRef.current) {
      if (activeSessionRef.current === replySessionIdRef.current && value.trim()) {
        needsFollowUpRef.current = true;
        pendingReplySessionIdRef.current = replySessionIdRef.current;
        pendingReplyDataEpochRef.current = captureBackupRestoreDataEpoch();
        waitingToReplyRef.current = true;
        setWaitingToReply(true);
        cancelActiveReply();
      }
      return;
    }
    if (value.trim() && cancelActiveReply()) return;
    if (draftTransition.effect === 'cancel') {
      releaseChatReplyWaitBackground(replyTimerRef);
      if (replyTimerRef.current) clearTimeout(replyTimerRef.current);
      replyTimerRef.current = null;
      waitingToReplyRef.current = true;
      setWaitingToReply(true);
      setReplyPhase('waitingForUser');
      return;
    }
    if (draftTransition.effect === 'schedule') {
      const targetSessionId = pendingReplySessionIdRef.current ?? replySessionIdRef.current ?? activeSessionRef.current;
      scheduleReply(REPLY_IDLE_DELAY_MS, targetSessionId, pendingReplyDataEpochRef.current ?? captureBackupRestoreDataEpoch());
      return;
    }
    if (replyWaitStateRef.current.phase === 'pausedByDraft') return;
    if (value.trim()) {
      const hasPendingReplyState = !!(replyTimerRef.current || slowNetworkTimerRef.current
        || pendingReplySessionIdRef.current || replySessionIdRef.current);
      if (hasPendingReplyState) cancelPendingReplyWait();
      return;
    }
  };
  const toggleMorePanel = () => {
    Keyboard.dismiss();
    setMorePanelOpen((current) => {
      if (current) {
        setMorePanelNotice(null);
      }
      return !current;
    });
  };

  const handleWaitingModeChange = (enabled: boolean) => {
    const saveVersion = waitingModeSaveVersionRef.current + 1;
    waitingModeSaveVersionRef.current = saveVersion;
    waitingModeTouchedRef.current = true;
    waitingModeEnabledRef.current = enabled;
    setWaitingModeEnabled(enabled);
    setMorePanelNotice(null);
    const musicPreferences = getPreferencesSnapshot();
    void saveChatPreferences({
      ...musicPreferences,
      waitingModeEnabled: enabled,
    }).catch(() => {
      if (waitingModeSaveVersionRef.current !== saveVersion) return;
      waitingModeEnabledRef.current = !enabled;
      setWaitingModeEnabled(!enabled);
      setMorePanelNotice('等待模式保存失败，请稍后再试。');
    });

    if (!enabled && replyTimerRef.current) {
      scheduleReply(0, pendingReplySessionIdRef.current ?? activeSessionRef.current, pendingReplyDataEpochRef.current ?? captureBackupRestoreDataEpoch());
    }
  };
  const { compressConversationContext } = createChatContextCompressor({
    activeSessionRef, chatConnection, chatKey, memoryOrganizerConnection, memoryOrganizerKey,
    compressionInFlightRef, compressionStateRef, setCompressingContext, setCompressionState,
    showTransientMemoryNotice, setError, patchSession,
  });
  const { cancelActiveReply, runReply, prepareBackstageCapacityRequest } = useChatReplyController({
    appLaunchPicker: appLaunch.pick, appLaunchIsForeground: appLaunch.isActive,
    dialerPicker: dialer.pick, dialerIsForeground: dialer.isActive,
    theaterBackstage,
    context: {
      replyContextBudgetMs: REPLY_CONTEXT_BUDGET_MS,
      wait,
    },
    memory: chatMemory,
    model: {
      assistantStatus,
      chatConnection,
      chatKey,
      memoryOrganizerConnection,
      memoryOrganizerKey,
      profile,
      proactiveReviewedThroughId,
    },
    music: {
      getPreferencesSnapshot,
      isMusicEnabled,
      resolveMusicCardsSequentially,
    },
    output: {
      onImageSaved: (messageId, image) => updateMessageImageAttachment(messageId, image),
      rememberReplyContinuation: continuation => sendPersistenceRef.current.remember(continuation),
      appendAssistantBubbles,
      compressConversationContext,
      persistSessionMessages,
      scheduleReply,
      showShortMemoryNotice: (notice) => showShortMemoryNotice(notice),
      updateMessageDeliveryStatus,
    },
    runtime: {
      sendActionRef,
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
      setAssistantStatus,
      setCompressionState,
      setError,
      onReplyFailureDiagnostic: replyDiagnostic.onReplyFailureDiagnostic,
      setQueuedMessageCount,
      setReplyPhase,
      setReplySessionId,
      setPreparingReplySessionId,
      setSending,
      startSlowNetworkTimer,
      waitingToReplyRef,
    },
    sessions: {
      activeSessionRef,
      commitSessionMessages,
      messagesRef,
      messagesSessionIdRef,
      sessionsRef,
    },
  });

  useEffect(() => {
    if (!configLoaded || !historyLoaded || sessionMessagesLoading || !activeSessionId) return;
    return theaterBackstage?.bindPreparation?.(prepareBackstageCapacityRequest);
  }, [theaterBackstage, prepareBackstageCapacityRequest, configLoaded, historyLoaded, sessionMessagesLoading, activeSessionId]);

  const attemptSleepingReply = async (instruction: string, preserveConcurrentInput = false, interactionKind?: 'poke', pokeInteraction?: PokeInteraction, dataEpoch?: number | null, canContinue = () => true) => {
    if (sendingRef.current || !configured || !canContinue()) return false;
    const currentState = await loadAssistantState();
    if (currentState.lifeMode === 'sleeping' || !canContinue()) return false;
    const claim = await claimSleepingReply();
    if (!claim) return false;
    if (!canContinue()) {
      await releaseSleepingReply(claim).catch(() => undefined);
      return false;
    }
    const previousSessionId = activeSessionRef.current;
    const targetSession = await activateStoredSessionById(claim.sessionId, 'sleep');
    if (!canContinue()) {
      await releaseSleepingReply(claim).catch(() => undefined);
      return false;
    }
    if (!targetSession) {
      await confirmSleepingReply(claim);
      return false;
    }
    if (previousSessionId !== targetSession.id) {
      await wait(0);
    }
    if (!canContinue()) {
      await releaseSleepingReply(claim).catch(() => undefined);
      return false;
    }
    try {
      const replied = await runReply({
        interactionKind,
        pokeInteraction, dataEpoch,
        interactionInstruction: instruction,
        preserveInteractionReplyDuringConcurrentInput: preserveConcurrentInput,
        sleepClaim: claim,
      });
      if (!replied) await releaseSleepingReply(claim).catch(() => undefined);
      return replied;
    } catch (caught) {
      await releaseSleepingReply(claim).catch(() => undefined);
      throw caught;
    }
  };

  useEffect(() => {
    if (
      !active
      || !historyLoaded
      || assistantStatus.lifeMode === 'sleeping'
      || sendingRef.current
      || pokeInteractionInFlightRef.current
      || (assistantStatus.wakeSource === 'poke'
        && (assistantStatus.manualWakeUntil ?? 0) > Date.now())
    ) return;
    if (Date.now() - lastReplyCompletedAtRef.current < 10 * 1000) return;
    void attemptSleepingReply('你刚刚从睡眠中醒来。小仓鼠睡着期间给你留了消息，请先自然回应这些留言，不要提内部队列或系统机制。');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, assistantStatus.lifeMode, externalMessageVersion, historyLoaded]);

  const showPokeBubble = async (anchorId: string) => {
    const currentState = await loadAssistantState().catch(() => assistantStatus);
    const text = pickLocalPokeExpression(currentState.moodId);
    setPokeBubble({ anchorId, text });
    if (pokeBubbleTimerRef.current) clearTimeout(pokeBubbleTimerRef.current);
    pokeBubbleTimerRef.current = setTimeout(() => setPokeBubble(null), 2000);
  };

  const handlePoke = async (
    anchorId: string,
    resume?: () => Promise<void>,
    input?: { fact: PokeInteraction; dataEpoch: number | null },
  ): Promise<void> => {
    if (memorySelectionOpen && !phoneLockChatVisible) return;
    if (pokeInteractionInFlightRef.current) return;
    input ??= { fact: createPokeInteraction(anchorId, activeSessionRef.current), dataEpoch: captureBackupRestoreDataEpoch() };
    const cancellationVersion = pokeCancellationVersionRef.current;
    const canKeepPoke = () => canCommitBackupRestoreDataEpoch(input!.dataEpoch);
    const canContinuePoke = () => canKeepPoke() && cancellationVersion === pokeCancellationVersionRef.current;
    if (!canKeepPoke()) return;
    if (sendingRef.current) {
      pendingPokeRef.current = { anchorId, sessionId: activeSessionRef.current, resume, input };
      return;
    }
    if (waitingToReplyRef.current) cancelPendingReplyWait();
    pokeInteractionInFlightRef.current = true;
    setPokePreparingSessionId(activeSessionRef.current);
    try {
      if (resume) {
        await resume();
        return;
      }

      const state = await Promise.race([
        loadAssistantState().catch(() => assistantStatus),
        wait(3000).then(() => assistantStatus),
      ]);
      if (!canContinuePoke()) return;
      const wasSleeping = state.lifeMode === 'sleeping';
      const poke = await Promise.race([
        recordPoke(Date.now(), configured ? input.fact : undefined, canKeepPoke).catch(() => ({ shouldRequestReply: false })),
        wait(3000).then(() => ({ shouldRequestReply: false })),
      ]);
      void recordGlobalInteraction('chat');
      if (!canContinuePoke()) return;
      let sleepingWakeHandled = false;
      let sleepingMessageReplyHandled = false;

      const continuePreparedPoke = async (): Promise<void> => {
        if (!canContinuePoke()) return;
        const queuePreparedPoke = () => {
          if (!canContinuePoke()) return;
          pendingPokeRef.current = {
            anchorId,
            sessionId: activeSessionRef.current,
            resume: continuePreparedPoke,
            input,
          };
        };

        if (sendingRef.current) {
          queuePreparedPoke();
          return;
        }

        if (wasSleeping) {
          if (!sleepingWakeHandled) {
            const awake = await wakeAssistantByPoke(Date.now(), wokeAt => { input!.fact = { ...input!.fact, wokeAt }; });
            setAssistantStatus(awake);
            if (configured && poke.shouldRequestReply && input!.fact.wokeAt !== undefined) {
              await updatePokeExperience(input!.fact.id, { wokeAt: input!.fact.wokeAt }, canKeepPoke);
            }
            sleepingWakeHandled = true;
            if (!canContinuePoke()) return;
            if (sendingRef.current) {
              queuePreparedPoke();
              return;
            }
          }

          if (!poke.shouldRequestReply) {
            await showPokeBubble(anchorId);
            return;
          }
          if (!sleepingMessageReplyHandled) {
            const repliedToMessage = await attemptSleepingReply(
              'you 刚刚戳了戳 I，把 I 从睡梦里叫醒了。',
              true, 'poke', input!.fact, input!.dataEpoch, canContinuePoke,
            );
            if (repliedToMessage) {
              await recordPokeReplySent();
              return;
            }
            if (!canContinuePoke()) return;
            if (sendingRef.current) {
              queuePreparedPoke();
              return;
            }
            sleepingMessageReplyHandled = true;
          }

          if (configured) {
            const replied = await runReply({
              interactionKind: 'poke',
              pokeInteraction: input!.fact, dataEpoch: input!.dataEpoch,
              interactionInstruction: 'you 刚刚戳了戳 I，把 I 从睡梦里叫醒了。',
              preserveInteractionReplyDuringConcurrentInput: true,
            });
            if (replied) {
              await recordPokeReplySent();
            } else if (sendingRef.current) {
              queuePreparedPoke();
            }
          } else {
            await showPokeBubble(anchorId);
          }
          return;
        }

        if (!poke.shouldRequestReply || !configured) {
          await showPokeBubble(anchorId);
          return;
        }
        const replied = await runReply({
          interactionKind: 'poke',
          pokeInteraction: input!.fact, dataEpoch: input!.dataEpoch,
          interactionInstruction: 'you 刚刚戳了戳 I。',
          preserveInteractionReplyDuringConcurrentInput: true,
        });
        if (replied) {
          await recordPokeReplySent();
        } else if (sendingRef.current) {
          queuePreparedPoke();
        }
      };

      await continuePreparedPoke();
    } finally {
      setPokePreparingSessionId(null);
      pokeInteractionInFlightRef.current = false;
      const pending = pendingPokeRef.current;
      if (pending && !sendingRef.current) {
        if (pending.sessionId !== activeSessionRef.current) {
          pendingPokeRef.current = null;
        } else {
          pendingPokeRef.current = null;
          void handlePoke(pending.anchorId, pending.resume, pending.input);
        }
      }
    }
  };

  useEffect(() => {
    const pending = pendingPokeRef.current;
    if (!pending || sending || pokeInteractionInFlightRef.current) return;
    if (pending.sessionId !== activeSessionId) {
      pendingPokeRef.current = null;
      return;
    }
    pendingPokeRef.current = null;
    void handlePoke(pending.anchorId, pending.resume, pending.input);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, sending]);

  const persistAlreadyAppendedUserMessage = async (youMessage: SubjectiveMessage, recordAsSleepingMessage: boolean,
    dataEpoch = captureBackupRestoreDataEpoch()) => {
    const sessionId = activeSessionRef.current;
    if (!sessionId) return false;
    const current = () => {
      const message = messagesRef.current.find(item => item.id === youMessage.id);
      return mountedRef.current && canCommitBackupRestoreDataEpoch(dataEpoch) && activeSessionRef.current === sessionId
        && messagesSessionIdRef.current === sessionId && message?.createdAt === youMessage.createdAt
        && message.content === youMessage.content && JSON.stringify(message.voice) === JSON.stringify(youMessage.voice);
    };
    if (!current()) return false;
    const saved = await persistSessionMessages(sessionId, messagesRef.current);
    if (!current()) return false;
    if (saved === 'failed') {
      updateMessageDeliveryStatus(youMessage.id, 'failed', '消息没有保存到本机，请重新发送。');
      return false;
    }
    if (recordAsSleepingMessage) {
      try {
        await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
          if (current()) await recordSleepingMessage(sessionId, youMessage.id, Date.now(), current);
        });
      } catch (error) {
        if (!current() && error instanceof Error && error.message === 'sleep_interaction_stale') return false;
        throw error;
      }
    }
    return current();
  };

  const updateMessageImageAttachment = (
    messageId: string,
    savedImage: MessageImage,
  ) => {
    // The domain has already committed this exact attachment. Only refresh the live window.
    // A historical image must not be inserted into the latest send/context window here.
    let updatedImage: MessageImage | undefined;
    const nextMessages = messagesRef.current.map((message) => {
      if (message.id !== messageId || !message.images?.length) return message;
      const images = message.images.map((image) => {
        if (image.id !== savedImage.id || image.cacheId !== savedImage.cacheId) return image;
        updatedImage = savedImage;
        return updatedImage;
      });
      return { ...message, images };
    });
    if (updatedImage) commitMessages(nextMessages);
    return updatedImage;
  };

  const {
    closeImagePreview,
    imagePreviewUri,
    imageSending,
    openImagePreview,
    pickAndSendImage,
  } = useChatImageSender({
    getDraftText: () => draftRef.current,
    onBeforeImageSend: () => {
      setMorePanelOpen(false);
      setMorePanelNotice(null);
      cancelPendingReplyWait();
    },
    onNotice: setMorePanelNotice,
    sendImageMessage: ({ duplicateKey, image, text }) => sendUserMessage(
      text,
      { images: [image] },
      { duplicateKey },
    ),
  });
  useChatAutomaticSyncBusy({
    active,
    compressingContext,
    onChange: onAutomaticSyncBusyChange,
    replyBusy,
    voiceBusy,
    voiceCaptureActive,
    voiceRecordingVisible,
    voiceStarting,
  });
  const prepareSleepMessage = (message: SubjectiveMessage, sessionId: string, dataEpoch: number | null, resumeVoice = false) =>
    prepareSavedChatSleepMessage({ message, sessionId, dataEpoch,
      current: () => mountedRef.current && activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId
        && (!resumeVoice || messagesRef.current.at(-1)?.id === message.id),
      getMessages: () => messagesRef.current, commitMessages,
      persist: nextMessages => persistSessionMessages(sessionId, nextMessages),
      onError: error => { if (messagesRef.current.at(-1)?.id === message.id) setError(error); },
      prepareVoice: resumeVoice ? async original => {
        const voice = original.voice!;
        const result = await executeChatTool('voice.transcribe', { durationMs: voice.durationMs, transcript: voice.transcript ?? '' }, undefined, { requestedBy: 'manual' });
        const transcript = result.ok && typeof result.data === 'object' && result.data
          ? (result.data as { transcript?: unknown }).transcript : undefined;
        const text = typeof transcript === 'string' && transcript.trim() ? transcript.trim() : voice.transcript?.trim();
        return { content: text || original.content, voice: { ...voice, transcript: text || undefined,
          transcriptionError: result.ok ? undefined : result.summary, transcriptionStatus: result.ok ? 'ready' : 'error' } };
      } : undefined,
    });
  const sendUserMessage = async (
    text: string,
    metadata: Pick<SubjectiveMessage, 'voice' | 'images' | 'readingReference'> = {},
    options: { clearDraft?: boolean; duplicateKey?: string; onAccepted?: () => void; prepareAfterPersist?: () => Promise<{ text: string; voice: NonNullable<SubjectiveMessage['voice']> }> } = {},
  ) => {
    if (!historyLoaded || sessionMessagesLoading || !activeSessionRef.current) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    let trimmedText = text.trim();
    const sendSessionId = activeSessionRef.current;
    const messageImages = metadata.images ?? [];
    const hasImages = messageImages.length > 0;
    if (!trimmedText && !hasImages) return;
    historySearch.returnToLatest();
    const now = Date.now();
    const duplicateKey = options.duplicateKey ?? (hasImages ? [trimmedText, ...messageImages.map((image) => image.id)].join('::') : trimmedText);
    if (lastSendRef.current.text === duplicateKey && now - lastSendRef.current.at < 600) return;
    const finishBackground = beginChatReplyBackground();
    try {
    lastSendRef.current = { at: now, text: duplicateKey };

    const replyTo = replyingToMessage ? buildReplyToMessage(replyingToMessage) : undefined;
    let youMessage = createSubjectiveMessage('you', trimmedText, { ...metadata, replyTo });
    let outgoingMessages = [...messagesRef.current, youMessage];
    if (!commitMessages(outgoingMessages)) return;
    const pendingAdjustment = consumePendingAdjustment();
    options.onAccepted?.();
    const sendAction: ChatSendAction = { messageId: youMessage.id, startedAt: now };
    sendActionRef.current = sendAction;
    const sentDraft = options.clearDraft !== false ? clearDraftInput(true) : null;
    clearReplyingToMessage();
    setError(null);

    let preparedAfterPersist: Awaited<ReturnType<NonNullable<typeof options.prepareAfterPersist>>> | undefined;
    const continuation: AcceptedUserMessageContinuation = {
      messageId: youMessage.id,
      run: async () => {
        sendAction.youPersistedAt ??= Date.now();
        if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        finishDraftSend(sentDraft, true);
        if (metadata.readingReference) onReadingReferenceSaved?.(metadata.readingReference);
        const sleepTurn = { sessionId: sendSessionId, turnId: youMessage.id, dataEpoch };
        const preparation = await prepareSleepMessage(youMessage, sendSessionId, dataEpoch);
        if (preparation !== 'ready') return preparation === 'failed' ? 'retryable_failure' : undefined;
        const sleepChat = await import('../chat/chatSleepSchedule');
        let replyQueued = false;
        sendAction.sleepAcceptedAt ??= Date.now();
        try {
        if (options.prepareAfterPersist) {
          preparedAfterPersist ??= await options.prepareAfterPersist();
          const prepared = preparedAfterPersist;
          if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
          trimmedText = prepared.text.trim();
          youMessage = { ...youMessage, content: trimmedText, voice: prepared.voice };
          outgoingMessages = outgoingMessages.map((message) => message.id === youMessage.id ? youMessage : message);
          const currentVoiceMessage = messagesRef.current.find((message) => message.id === youMessage.id); const preparedAlreadyDurable = currentVoiceMessage?.content === trimmedText && currentVoiceMessage.voice?.transcriptionStatus !== 'pending';
          if (!preparedAlreadyDurable && (!commitMessages(outgoingMessages) || await persistSessionMessages(activeSessionRef.current, outgoingMessages) === 'failed')) {
            sendPersistenceRef.current.remember(continuation);
            updateMessageDeliveryStatus(youMessage.id, 'failed', '消息没有保存到本机，请重新发送。');
            return 'retryable_failure';
          }
          if (preparedAlreadyDurable) { youMessage = currentVoiceMessage; outgoingMessages = messagesRef.current; }
        }
        if (activeSessionRef.current !== sendSessionId) return;
        clearPendingPostponeText();
        clearPendingScheduleDateText();
        const sendIntentSnapshot = buildChatSendIntentSnapshot(trimmedText);
        void runBackupRestoreDataEpochCommit(dataEpoch, () => recordGlobalInteraction('chat', now))
          .catch(() => undefined);
    if (!configured && (pendingAdjustment || requiresConfiguredChatModelForSend(sendIntentSnapshot))) {
      setError('请先在“白云与连接”中填写并测试模型连接。');
      return;
    }
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    void runBackupRestoreDataEpochCommit(dataEpoch, () => recordKeywordCounterMessage(youMessage))
      .catch(() => undefined);

    if (hasImages) {
      // First observation runs inside this real reply's cancellation/source boundary.
      await runReply({ dataEpoch });
      return;
    }

    if (editingGoalTimeCredit) {
      const minutesMatch = trimmedText.match(/(\d{1,4})\s*(?:分钟|分)?/);
      const minutes = minutesMatch ? Number(minutesMatch[1]) : 0;
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
        commitMessages([...outgoingMessages, createSubjectiveMessage('I', '小仓鼠告诉我想记多少分钟就好，比如“45 分钟”。这里可以填写 1 到 1440 分钟。')]);
        return;
      }
      const sourceMessage = outgoingMessages.find((message) => message.id === editingGoalTimeCredit.messageId);
      if (!sourceMessage?.goalTimeCreditCard) {
        clearGoalTimeCreditEdit();
        commitMessages([...outgoingMessages, createSubjectiveMessage('I', '刚才那条投入时间记录已经找不到啦，所以我没有改动目标。')]);
        return;
      }
      const confirmedCommit = await runBackupRestoreDataEpochCommit(
        dataEpoch,
        () => confirmGoalTimeCredit(editingGoalTimeCredit.requestId, minutes),
      );
      if (!confirmedCommit.committed) return;
      const confirmed = confirmedCommit.value;
      clearGoalTimeCreditEdit();
      if (!confirmed || confirmed.status !== 'confirmed') {
        commitMessages([...outgoingMessages, createSubjectiveMessage('I', '这次没有记进去，小仓鼠可以再点一下“改分钟”试试。')]);
        return;
      }
      const updated = outgoingMessages.map((message) => message.id === sourceMessage.id
        ? { ...message, goalTimeCreditCard: { ...message.goalTimeCreditCard!, suggestedMinutes: minutes, status: 'confirmed' as const } }
        : message);
      commitMessages([...updated, createSubjectiveMessage('I', `好，这次按 ${minutes} 分钟记进目标啦。`)]);
      return;
    }

    if (pendingAdjustment) {
      await pendingAdjustment(trimmedText);
      return;
    }


    const currentAssistantState = await Promise.race([
      loadAssistantState().catch(() => assistantStatus),
      wait(3000).then(() => assistantStatus),
    ]);
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (currentAssistantState.lifeMode === 'sleeping') {
      if (!await persistAlreadyAppendedUserMessage(youMessage, true)) return;
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      showTransientMemoryNotice('留言已经放在她枕边啦。', 2200);
      return;
    }

    const sendRoute = selectChatSendRoute(sendIntentSnapshot);
    switch (sendRoute.kind) {
      case 'wallet':
        void handleWalletChatIntent(trimmedText, youMessage, dataEpoch);
        return;
      case 'ordinary_reply':
        break;
    }

    const notebookHandoff = pendingNotebookInteractionRef.current;
    if (notebookHandoff) {
      pendingNotebookInteractionRef.current = null;
      setPendingNotebookInteraction(null);
      pendingNotebookReplyRef.current = {
        handoff: notebookHandoff,
        instruction: buildNotebookInteractionInstruction(notebookHandoff, trimmedText),
      };
      void runBackupRestoreDataEpochCommit(
        dataEpoch,
        () => consumePendingNotebookInteraction(),
      ).catch(() => undefined);
    }

    pendingFactMessagesRef.current.push(youMessage);
    sendAction.replyQueuedAt ??= Date.now();
    replyQueued = true;
    if (sendingRef.current) {
      needsFollowUpRef.current = true;
      setQueuedMessageCount((current) => current + 1);
    } else {
      scheduleReply(undefined, activeSessionRef.current, dataEpoch);
    }
        } finally {
          if (!replyQueued) await sleepChat.finishAcceptedChatSleepMessage(sleepTurn);
        }
      },
    };
    await sendPersistenceRef.current.persistAcceptedMessage({ continuation,
      onFailed: () => {
        updateMessageDeliveryStatus(youMessage.id, 'failed', '消息没有保存到本机，请重新发送。');
        void persistSessionMessages(activeSessionRef.current, messagesRef.current);
      }, persist: async () => {
        const result = await persistSessionMessages(sendSessionId, outgoingMessages);
        if (result === 'failed') finishDraftSend(sentDraft, false);
        return result;
      } });
    } finally { finishBackground(); }
  };

  const handleSend = async () => {
    if (sendDraftInFlightRef.current) return;
    const text = draftRef.current.trim();
    if (!text) return;
    sendDraftInFlightRef.current = true;
    try {
      if (!pausePendingReplyWaitForOutgoingMessage()) {
        cancelPendingReplyWait();
      }
      await sendUserMessage(text, { readingReference: pendingReadingReference ?? undefined });
    } finally {
      sendDraftInFlightRef.current = false;
    }
  };

  const retryFailedMessage = (message: SubjectiveMessage) => {
    const retrySessionId = activeSessionRef.current;
    const retryDataEpoch = captureBackupRestoreDataEpoch();
    void sendPersistenceRef.current.retryFailedMessage({
      beforeRetry: () => {
    cancelPendingReplyWait();
    setError(null);
      },
      commitMessages,
      configured,
      markFailed: (messageId, error) => updateMessageDeliveryStatus(messageId, 'failed', error),
      message,
      messages: messagesRef.current,
      onBlocked: (reason) => setError(reason === 'latest_only' ? '只能重试最新一条未送达的消息。' : '请先在“白云与连接”中填写并测试模型连接。'),
      persist: (nextMessages) => persistSessionMessages(retrySessionId, nextMessages),
      replyBusy,
      requiresConfiguredModel: requiresConfiguredChatModelForSend(buildChatSendIntentSnapshot(message.content)),
      runReply: async () => {
        if (message.sendPreparation !== 'sleep') return runReply();
        if (!retrySessionId || await prepareSleepMessage(message, retrySessionId, retryDataEpoch, true) !== 'ready') return;
        try {
          const preparedMessage = messagesRef.current.find(item => item.id === message.id);
          if (!preparedMessage) return;
          const currentState = await Promise.race([loadAssistantState().catch(() => assistantStatus), wait(3000).then(() => assistantStatus)]);
          if (!mountedRef.current || !canCommitBackupRestoreDataEpoch(retryDataEpoch) || activeSessionRef.current !== retrySessionId) return;
          const currentMessage = messagesRef.current.find(item => item.id === message.id);
          if (!currentMessage || messagesRef.current.at(-1)?.id !== message.id
            || currentMessage.createdAt !== preparedMessage.createdAt || currentMessage.content !== preparedMessage.content
            || JSON.stringify(currentMessage.voice) !== JSON.stringify(preparedMessage.voice)) return;
          if (currentState.lifeMode === 'sleeping') {
            if (await persistAlreadyAppendedUserMessage(currentMessage, true, retryDataEpoch)
              && canCommitBackupRestoreDataEpoch(retryDataEpoch) && activeSessionRef.current === retrySessionId) {
              showTransientMemoryNotice('留言已经放在她枕边啦。', 2200);
            }
            return;
          }
          return await runReply({ dataEpoch: retryDataEpoch, sourceSessionId: retrySessionId });
        } finally {
          const sleepChat = await import('../chat/chatSleepSchedule');
          await sleepChat.finishAcceptedChatSleepMessage({ sessionId: retrySessionId, turnId: message.id, dataEpoch: retryDataEpoch });
        }
      },
    });
  };

  const handleStop = () => {
    pokeCancellationVersionRef.current += 1;
    pendingPokeRef.current = null;
    cancelActiveReply();
    cancelPendingReplyWait();
    needsFollowUpRef.current = false;
    setQueuedMessageCount(0);
  };

  const handleRollbackToMessage = async (message: SubjectiveMessage) => {
    if (replyBusy || !activeSessionId) return;
    const targetSessionId = activeSessionId;
    const dataEpoch = captureBackupRestoreDataEpoch();
    let order;
    try {
      order = await loadChatSessionMessageOrder(targetSessionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取这条消息的位置。');
      return;
    }
    if (!canCommitBackupRestoreDataEpoch(dataEpoch) || activeSessionRef.current !== targetSessionId) return;
    const previewRollbackIndex = order.findIndex((item) => item.id === message.id);
    if (previewRollbackIndex < 0) {
      setError('这条消息已不存在，请重新查找。');
      return;
    }
    const previewRemovedCount = order.length - previewRollbackIndex;

    Alert.alert(
      '回溯到这里？',
      `会清除这条及之后的 ${previewRemovedCount} 条消息，并删除这段消息生成的记忆。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '回溯',
          style: 'destructive',
          onPress: async () => {
            if (!canCommitBackupRestoreDataEpoch(dataEpoch) || activeSessionRef.current !== targetSessionId) return;
            const result = await rollbackActiveSessionToMessage(message.id);
            if (!result) return;
            historySearch.returnToLatest();

            const { keptMessages, removedMessages } = result;
            const removedIds = new Set(removedMessages.map((item) => item.id));
            const removedStartAt = Math.min(...removedMessages.map((item) => item.createdAt));
            const removedEndAt = Math.max(...removedMessages.map((item) => item.createdAt));

            pendingFactMessagesRef.current = pendingFactMessagesRef.current.filter((item) => !removedIds.has(item.id));
            answeredYouMessageIdsRef.current = new Set(
              [...answeredYouMessageIdsRef.current].filter((messageId) =>
                keptMessages.some((item) => item.id === messageId),
              ),
            );
            setMemoryCandidates((current) =>
              current.filter((candidate) => {
                const start = candidate.sourceStartAt;
                const end = candidate.sourceEndAt;
                if (typeof start !== 'number' || typeof end !== 'number') return true;
                return start > removedEndAt || end < removedStartAt;
              }),
            );
            clearScheduleReviews();
            clearExpenseReviews();
            setOrganizedThroughId((current) => (current && keptMessages.some((item) => item.id === current) ? current : null));
            setProactiveReviewedThroughId((current) => (current && keptMessages.some((item) => item.id === current) ? current : null));
            compressionStateRef.current = emptyChatContextCompressionState;
            setCompressionState(emptyChatContextCompressionState);
            clearSessionMemoryState();
            setMemoryRecallOpen(false);
            resetConversationInteraction();
            setError(null);
            setMemoryNotice(null);
            clearReplyingToMessage();
            cancelPendingReplyWait();
            needsFollowUpRef.current = false;
            setQueuedMessageCount(0);
            requestRef.current?.abort();

            showTransientMemoryNotice('已经回溯，正在后台清理相关记忆。', 1600);
            InteractionManager.runAfterInteractions(() => {
              setTimeout(() => {
                void deleteGeneratedMemoriesForSourceRange(removedStartAt, removedEndAt).then((deletedCount) => {
                  showTransientMemoryNotice(
                    deletedCount
                      ? `相关记忆也清掉了：${deletedCount} 条。`
                      : '这段没有找到需要清掉的生成记忆。',
                    2200,
                  );
                }).catch(() => {
                  showTransientMemoryNotice('已经回溯；相关记忆清理时有一步失败了。', 3000);
                });
              }, 0);
            });
          },
        },
      ],
    );
  };

  const saveScheduleReview = async (review: ScheduleReviewAction) => {
    if (review.kind !== 'create' || isRetiredMemoryActionReview(review)) return;
    if (await hasScheduleConflict(review.draft)) {
      Alert.alert('这个时间已有安排', '这条会和已有日程撞在一起。鼠可以去日程页稍微调一下时间。');
      return;
    }
    const result = await executeChatTool('schedule.create_event', scheduleDraftToToolInput(review.draft), review.reviewId, { requestedBy: 'manual' });
    if (!result.ok) {
      showToolResultNotice(result, '');
      return;
    }
    await requestNotificationPermission();
    await syncScheduleNotifications();
    emitScheduleDataChanged({ dateKey: dateKey(review.draft.startAt), reason: 'schedule' });
    dismissScheduleReview(review.reviewId);
    showShortMemoryNotice(`已经收进日程啦：${review.draft.title}`);
  };

  const saveTodoReview = async (review: ScheduleReviewAction, status?: 'inbox' | 'today') => {
    if (review.kind !== 'todo' || isRetiredMemoryActionReview(review)) return;
    const input = todoDraftToToolInput({
      ...review.draft,
      plannedForDate: status === 'today' ? dateKey(Date.now()) : review.draft.plannedForDate,
    });
    const result = await executeChatTool('todo.create', input, review.reviewId, { requestedBy: 'manual' });
    if (!result.ok) {
      showToolResultNotice(result, '');
      return;
    }
    emitScheduleDataChanged({ dateKey: review.draft.plannedForDate, reason: 'todo' });
    dismissScheduleReview(review.reviewId);
    showShortMemoryNotice(status === 'today' ? `已经放进今日待办啦：${review.draft.title}` : `已经收进待办池啦：${review.draft.title}`);
  };

  const scheduleTodoReview = async (review: ScheduleReviewAction) => {
    if (isRetiredMemoryActionReview(review)) return;
    if (review.kind !== 'todo') return;
    await savePendingScheduleRequest(`${review.draft.title}${review.draft.notes ? `：${review.draft.notes}` : ''}`);
    dismissScheduleReview(review.reviewId);
    navigate('schedule');
  };

  const rejectAmbiguousSchedule = () => {
    const text = takeRejectedAmbiguousScheduleText();
    if (!text) return;
    const original = [...messagesRef.current].reverse().find((message) => message.role === 'you' && message.content.trim() === text);
    if (original) pendingFactMessagesRef.current.push(original);
    if (sendingRef.current) {
      needsFollowUpRef.current = true;
      setQueuedMessageCount((current) => current + 1);
    } else {
      void runReply({ interactionInstruction: `小仓鼠刚才说“${text}”。她已经确认这不是创建日程的请求，请把它当作普通聊天，自然回应原句，不要再谈日程识别。` });
    }
  };

  const notebookMarkedMessageIds = useChatNotebookMarkers({ active, externalMessageVersion,
    messages: historySearch.browsing ? historySearch.window?.messages ?? [] : messages });
  const messageRenderRevision = useMemo(() => JSON.stringify({
    notebookMarkedMessageIds: [...notebookMarkedMessageIds],
    likedStyleReferenceIds,
    memorySelectionOpen,
    musicIsPlaying: musicPlayer.isPlaying,
    musicMultipleCardsEnabled,
    playingSongId: musicPlayer.currentSong?.id ?? null,
    pokeBubble,
    replyBusy,
    schedulePlanSaving,
    selectedMemoryMessageIds,
    titleTextStyle,
    transcriptTextStyle: exposedLabelTextStyle,
  }), [
    notebookMarkedMessageIds,
    exposedLabelTextStyle,
    likedStyleReferenceIds,
    memorySelectionOpen,
    musicMultipleCardsEnabled,
    musicPlayer.currentSong?.id,
    musicPlayer.isPlaying,
    pokeBubble,
    replyBusy,
    schedulePlanSaving,
    selectedMemoryMessageIds,
    titleTextStyle,
  ]);

  const expensePlan = useChatExpensePlanBridge({
    getMessages: () => messagesRef.current,
    commitMessages,
    isSending: () => sendingRef.current,
    requestReply: options => runReply(options),
    onError: setError,
  });
  const reminderPlan = useChatReminderPlanBridge({
    getMessages: () => messagesRef.current, commitMessages,
    isSending: () => sendingRef.current, requestReply: options => runReply(options), onError: setError,
  });
  const renderMessageBubble = (message: SubjectiveMessage, messageIndex: number) => {
    if (phoneLockChatVisible) {
      const index = messages.findIndex(item => item.id === message.id);
      messageIndex = index < 0 ? -1 : loadedMessageStartIndex + index;
    }
    const messageSelectionMode = memorySelectionOpen && !phoneLockChatVisible;
    const displayedContent = getDisplayedChatMessageContent(message);
    const messageMusicCards = getMessageMusicCards(message);
    const messageToolCallCards = message.toolCallCards ?? [];
    if (!hasRenderableChatMessageContent(message, displayedContent)) return null;
    const isLatestMessage = !historySearch.browsing && isLatestLoadedMessage(
      messageIndex,
      loadedMessageStartIndex,
      messages.length,
    );
    const assistantRound = message.role === 'I' ? getAssistantReplyRound(message) : null;
    const isAssistantRoundStart = assistantRound?.firstId === message.id;
    const assistantRoundLiked = assistantRound ? likedStyleReferenceIds.includes(assistantRound.firstId) : false;
    const canRetryDelivery =
      message.role === 'you'
      && message.deliveryStatus === 'failed'
      && (isLatestMessage || (!historySearch.browsing && sendPersistenceRef.current.canRetryAfterMessages(message.id, messagesRef.current)))
      && !messageSelectionMode
      && !replyBusy;
    const memorySelected = !phoneLockChatVisible && selectedMemoryMessageIds.includes(message.id);
    const messageSelected = memorySelected;
    const toggleMessageSelection = () => {
      if (memorySelectionOpen) {
        toggleSelectedMemoryMessage(message.id);
      }
    };
    const messageCards = (
      <>
        {message.reminderOccurrenceId && message.reminderAttemptId ? <ChatReminderMusicControls
          occurrenceId={message.reminderOccurrenceId} attemptId={message.reminderAttemptId} /> : null}
        {message.reminderPlanCard ? <ChatReminderPlanCard card={message.reminderPlanCard} busy={reminderPlan.busy || sending}
          onEditRow={(id, patch) => { void reminderPlan.edit(message.id, id, patch); }}
          onRemoveRow={id => { void reminderPlan.edit(message.id, id, null); }}
          onSave={() => { void reminderPlan.save(message.id); }} /> : null}
        {message.expensePlanCard ? (
          <ChatExpensePlanCard
            card={message.expensePlanCard}
            busy={expensePlan.busy || sending}
            onEditRow={(id, patch) => {
              void expensePlan.edit(message.id, id, patch);
            }}
            onRemoveRow={id => {
              void expensePlan.edit(message.id, id, null);
            }}
            onSave={() => {
              void expensePlan.save(message.id);
            }}
          />
        ) : null}
        {message.schedulePlanCard ? (
          <ChatSchedulePlanCard
            card={message.schedulePlanCard}
            onEditEntry={(id, change) => editDayPlanEntry(message.schedulePlanCard!.plan, id, change)}
            onSetEndQuestions={enabled => setDayPlanEndQuestions(message.schedulePlanCard!.plan, enabled)}
            onRemoveEntry={(id) => removeDayPlanEntry(message.schedulePlanCard!.plan, id)}
            onAdjust={() => { beginScheduleAdjustment(message.schedulePlanCard!.plan); inputRef.current?.focus(); }}
            onConfirm={() => { void confirmPendingSchedulePlan(message.schedulePlanCard!.plan); }}
            onDiscard={() => discardPendingSchedulePlan(message.schedulePlanCard!.plan)}
            saving={schedulePlanSaving || !!message.schedulePlanCard.plan.dayPlan && sending}
          />
        ) : null}
        {message.goalTimeCreditCard ? (
          <ChatGoalTimeCreditCard
            card={message.goalTimeCreditCard}
            onConfirm={() => { void confirmGoalTimeCreditCard(message); }}
            onEdit={() => { beginGoalTimeCreditEdit(message); inputRef.current?.focus(); }}
            onSkip={() => { void skipGoalTimeCreditCard(message); }}
          />
        ) : null}
        {message.scheduleChangeCard ? (
          <ChatScheduleChangeCard
            card={message.scheduleChangeCard}
            onCancel={() => cancelScheduleChangeCard(message)}
            onConfirm={() => { void confirmScheduleChangeCard(message); }}
          />
        ) : null}
        <ChatToolCallCards
          cards={messageToolCallCards}
          messageId={message.id}
          wishBusy={wishDiscussion.busy}
          onWishInvite={(callId) => wishDiscussion.onInvite(message.id, callId)}
          onProposalAdjusted={(proposalId, presentation) => {
            commitMessages(messagesRef.current.map((current) => (
              current.id !== message.id || !current.toolCallCards
                ? current
                : {
                    ...current,
                    toolCallCards: current.toolCallCards.map((card) => (
                      card.proposalId === proposalId
                        ? { ...card, confirmationPresentation: presentation }
                        : card
                    )),
                  }
            )));
          }}
        />
      </>
    );

    return (
      <ChatMessageBubble
        modalActionsDisabled={phoneLockChatVisible}
        portraitSource={phoneLockChatVisible && assistantStatus.lifeMode === 'sleeping' ? baiyunStatusPortraits.asleep : undefined}
        assistantRoundLiked={assistantRoundLiked}
        canRetryDelivery={canRetryDelivery}
        cards={messageCards}
        currentSongId={musicPlayer.currentSong?.id}
        displayedContent={displayedContent}
        message={message}
        messageMusicCards={messageMusicCards}
        messageSelected={messageSelected}
        messageSelectionMode={messageSelectionMode} memoryOrganizing={organizing}
        notebookRecorded={notebookMarkedMessageIds.has(message.id)}
        musicIsPlaying={musicPlayer.isPlaying}
        musicShowCandidates={musicMultipleCardsEnabled}
        onLike={() => { void toggleAssistantReplyRoundHeart(message); }}
        onLongPress={phoneLockChatVisible ? undefined : () => message.voiceCallRecord ? void deleteActiveVoiceCallRecordMessage(message.id) : handleMessageLongPress(message)} onOrganizeVoiceCallRecord={phoneLockChatVisible ? undefined : () => { void chatMemory.organizeVoiceCallRecord(message); }}
        onMusicError={setError}
        onControlMusic={(action) => controlMusic(action, message.id)}
        onPlayMusic={(song) => playMusicSong(song, message.id)}
        onPoke={() => { void handlePoke(message.id); }}
        onPreviewImage={openImagePreview}
        onReply={() => {
          beginReplyToMessage(message);
          historySearch.returnToLatest();
        }}
        onRetryDelivery={() => retryFailedMessage(message)}
        onRetryMusic={(keyword, cardIndex) => { void resolveMusicCard(message.id, keyword, cardIndex); }}
        onToggleSelection={toggleMessageSelection}
        pokeBubble={pokeBubble?.anchorId === message.id ? pokeBubble.text : undefined}
        renderedContent={renderInlineMarkdown(displayedContent, message.id)}
        showAssistantRoundLike={isAssistantRoundStart}
        titleTextStyle={titleTextStyle}
        transcriptTextStyle={exposedLabelTextStyle}
      />
    );
  };
  const phoneLockChat = usePhoneLockChatHistory({
    visible: phoneLockChatVisible, sessionId: activeSessionId,
    ready: historyLoaded && !sessionMessagesLoading,
    messages, loadedStartIndex: loadedMessageStartIndex,
  });
  return (
    <ChatScreenView
      phoneLockChat={phoneLockChatVisible ? { ...phoneLockChat, sleeping: assistantStatus.lifeMode === 'sleeping' } : undefined}
      wishDiscussion={wishDiscussion}
      backstage={theaterBackstage ? <><TheaterBackstageBanner session={theaterBackstage.session} />
        <TheaterBackstagePanel session={theaterBackstage.session} /></> : undefined}
      background={{ settings: backgroundSettings, skyTheme }}
      composer={{
        bottomPadding: composerBottomPadding,
        dockKeyboardStyle: composerDockKeyboardStyle,
        liftStyle: composerLiftStyle,
        onLayout: () => {
          if (active && nearBottomRef.current) {
            scheduleScrollToEnd(false, 30);
          }
        },
        props: {
          configLoaded,
          configured,
          draftText: draftRef.current,
          draftResetVersion,
          imageSending,
          inputRef,
          memoryNotice,
          morePanelNotice,
          morePanelOpen,
          musicAutoplay,
          musicConnectionOpen,
          musicCookieBusy,
          musicCookieDraft,
          musicCookieSaved,
          musicEnabled,
          musicMultipleCardsEnabled,
          musicSettingsOpen,
          notebookTitle: pendingNotebookInteraction?.title ?? null,
          readingReference: pendingReadingReference,
          onRemoveReadingReference,
          onCancelNotebook: cancelNotebookInteraction,
          onCancelReply: clearReplyingToMessage,
          onCancelVoice: () => runVoiceResponderAction(() => void cancelVoiceRecording()),
          onChangeDraft: handleDraftChange,
          onChangeMusicAutoplay: setMusicAutoplay,
          onChangeMusicCookie: setMusicCookieDraft,
          onChangeMusicEnabled: setMusicEnabled,
          onChangeMusicMultipleCards: setMusicMultipleCardsEnabled,
          onChangeWaitingMode: handleWaitingModeChange,
          onFinishVoice: () => void finishVoiceRecording(),
          onInputFocus: () => {
            setMorePanelOpen(false);
            setMorePanelNotice(null);
          },
          onPickImage: (source) => void pickAndSendImage(source),
          onReleaseVoice: () => {
            if (voiceCaptureActive || hasActiveVoiceCapture()) {
              runVoiceResponderAction(() => void finishVoiceRecording());
            }
          },
          onRequestFinishVoice: () => runVoiceResponderAction(() => void finishVoiceRecording()),
          onSaveMusicCookie: (testAfterSave) => void saveMusicCookie(testAfterSave),
          onSend: () => void handleSend(),
          onStartVoice: () => void startVoiceRecording(),
          onStop: handleStop,
          onToggleMorePanel: toggleMorePanel,
          onToggleMusicConnection: toggleMusicConnection,
          onToggleMusicSettings: toggleMusicSettings,
          onToggleVoiceMode: () => {
            toggleVoiceMode();
            setVoiceDraftPresent(!!draftRef.current.trim());
            Keyboard.dismiss();
            setMorePanelOpen(false);
          },
          replyingToMessage,
          replyBusy,
          sendBlocked: !historyLoaded || sessionMessagesLoading || !activeSessionId,
          sendActsAsStop,
          voiceBlocked: voiceCallAudioActive,
          voiceBusy,
          voiceCancelAvailable,
          voiceCaptureActive,
          voiceMode,
          voiceRecordStartedAt,
          voiceRecordingVisible,
          voiceSendAvailable,
          voiceStarting,
          waitingModeEnabled,
        },
      }}
      drawer={{
        insets,
        navigate: target => { void chatMemory.flushCandidateDrafts().then(() => navigate(target)).catch(() => undefined); },
        onSearchHistory: historySearch.openSearch,
        ref: drawerRef,
      }}
      historySearch={historySearch}
      appLaunch={appLaunch}
      dialer={dialer}
      error={{
        configured,
        message: error,
        onOpenSettings: () => navigate('ai-settings'),
        onOpenDetails: isChatReplyDiagnosticForSession(replyDiagnostic.diagnostic, activeSessionId)
          ? replyDiagnostic.openDetails : undefined,
        diagnosticEntry: isChatReplyDiagnosticForSession(replyDiagnostic.modalEntry, activeSessionId)
          ? replyDiagnostic.modalEntry : null,
        onCloseDetails: replyDiagnostic.closeDetails,
      }}
      header={{
        availabilityText,
        baiyunHeartUnread,
        configured,
        contextUsagePercentage,
        onOpenBaiyunHeart: () => void openBaiyunHeartTab(),
        onOpenDrawer: openDrawer,
        onOpenSettings: () => navigate('ai-settings'),
        onOpenTokenDetails: () => setTokenDetailsOpen(true),
        titleTextStyle,
        tokenRingColor,
      }}
      insets={insets}
      messages={{
        active,
        configLoaded,
        hiddenHistoryCount,
        historyLoaded,
        listRef,
        messageRenderRevision,
        messages,
        nearBottomRef,
        onContentEdgeChange: () => {
          if (active && scrollToLatestOnOpenRef.current) {
            scheduleScrollToEnd(false, 30, false);
          }
        },
        onPokeEmpty: () => void handlePoke('empty'),
        onRevealOlder: revealOlderMessages,
        onUserScrollBegin: () => { clearScrollToEndBurstTimers(); cancelScheduledScrollToEnd(); scrollToLatestOnOpenRef.current = false; nearBottomRef.current = false; },
        presentationMounted: shouldMountChatPresentation(active, chatOpenScrollStateRef.current.compactionVersion, historyCompactionVersion),
        pokeBubble,
        renderMessageBubble,
        reversedVisibleMessages,
        scrollToLatestOnOpenRef,
        sessionMessagesLoading,
        visibleMessageStartIndex,
      }}
      modals={{
        imagePreview: {
          onClose: closeImagePreview,
          uri: imagePreviewUri,
        },
        legacySelection: {
          messages,
          onClose: closeMemorySelection,
          onConfirm: confirmSelectedMemoryMessages,
          onToggleMessage: toggleSelectedMemoryMessage,
          selectedMessageIds: selectedMemoryMessageIds,
        },
        memoryRecall: {
          flaggedRecallIds,
          insets,
          latestMemoryDebug,
          latestMemoryRecall,
          onClose: () => setMemoryRecallOpen(false),
          onFlagIrrelevant: (item) => void flagRecallAsIrrelevant(item),
          onToggleTechnical: () => setMemoryRecallTechnicalOpen((current) => !current),
          panelHeight: memoryRecallPanelHeight,
          technicalOpen: memoryRecallTechnicalOpen,
          visible: memoryRecallOpen,
        },
        messageEdit: {
          onChangeText: updateEditingMessageText,
          onClose: closeEditingMessage,
          onSave: saveEditedMessage,
          text: editingMessageText,
          visible: !!editingMessage,
        },
        organization: {
          messages: pendingOrganizationMessages,
          mode: pendingOrganizationMode,
          onClose: closeOrganizationModal,
          onConfirm: () => void confirmOrganizeMemories(),
        },
        tokenDetails: {
          compressing: compressingContext,
          compressionEnabled: chatConnection?.contextCompressionEnabled !== false,
          compressionMessageThreshold: chatConnection?.contextCompressionMessageThreshold ?? 16,
          compressionMessageThresholdEnabled: chatConnection?.contextCompressionByMessageCount !== false,
          compressionState,
          compressionThresholdPercentage,
          contextUsagePercentage,
          contextWindowTokens,
          onClose: () => setTokenDetailsOpen(false),
          onCompress: () => void compressConversationContext(messagesRef.current, true),
          promptCacheSummary,
          replyBusy,
          tokenRingColor,
          visible: tokenDetailsOpen,
        },
      }}
      reviews={{
        continuity: {
          busyCandidateIds: continuityReviews.busyCandidateIds,
          items: continuityReviews.items,
          onAccept: (candidate) => void continuityReviews.onAccept(candidate),
          onDismiss: (candidate) => void continuityReviews.onDismiss(candidate),
          onOpen: () => navigate('assistant-diary'),
          onUndo: (candidate) => void continuityReviews.onUndo(candidate),
        },
        currentState: {
          candidates: currentStateCandidates,
          onDiscard: chatMemory.discardCurrentStateCandidate,
          onDiscardResolve: chatMemory.discardCurrentStateResolveCandidate,
          onSave: (reviewId) => void saveCurrentStateCandidate(reviewId),
          onSaveResolve: (reviewId) => void saveCurrentStateResolveCandidate(reviewId),
          resolveCandidates: currentStateResolveCandidates,
        },
        expense: {
          editingNote: editingExpenseNote,
          editingReviewId: editingExpenseReviewId,
          onBeginEditing: beginEditingExpenseReview,
          onCancelEditing: cancelEditingExpenseReview,
          onChangeNote: updateEditingExpenseNote,
          onDismiss: dismissExpenseReview,
          onSave: (review) => void saveExpenseReview(review),
          onSaveNote: saveExpenseReviewNote,
          reviews: expenseReviews,
        },
        keyboardStyle: composerKeyboardStyle,
        memory: {
          candidates: memoryCandidates,
          onAdjustImportance: adjustMemoryCandidateImportance,
          onDiscard: discardMemoryCandidate,
          onSave: (candidate, index) => saveCandidate(candidate, index),
          onToggleAnchor: toggleMemoryCandidateAnchor,
          onTogglePinned: toggleMemoryCandidatePinned,
          onUpdate: updateMemoryCandidate,
        },
        schedule: {
          formatOccurrenceDateTime: formatScheduleDateTime,
          onCancel: (review) => void cancelScheduleReview(review),
          onDismiss: dismissScheduleReview,
          onSaveHabit: (review) => void saveHabitReview(review),
          onSaveSchedule: (review) => void saveScheduleReview(review),
          onSaveTodo: (review, status) => void saveTodoReview(review, status),
          onScheduleTodo: (review) => void scheduleTodoReview(review),
          reviews: visibleScheduleReviews,
        },
        wallet: {
          onMark: (review, status) => void markWalletDecisionReview(review, status),
          onOpenWallet: openWalletFromReview,
          onSave: (review) => void saveWalletDecisionReview(review),
          reviews: walletDecisionReviews,
        },
      }}
      schedulePanels={{
        ambiguousScheduleText,
        composerKeyboardStyle,
        hasPendingPlanMessage: !!pendingSchedulePlan
          && messages.some((message) => message.schedulePlanCard?.plan.id === pendingSchedulePlan.id),
        onAcceptAmbiguousSchedule: acceptAmbiguousSchedule,
        onAdjustGoal: () => {
          beginGoalAdjustment();
          inputRef.current?.focus();
        },
        onAdjustSchedule: () => {
          beginScheduleAdjustment();
          inputRef.current?.focus();
        },
        onCancelGoal: cancelPendingGoal,
        onConfirmGoal: () => void confirmPendingGoal(),
        onConfirmSchedule: () => void confirmPendingSchedulePlan(),
        onDiscardSchedule: () => discardPendingSchedulePlan(),
        onRejectAmbiguousSchedule: rejectAmbiguousSchedule,
        pendingGoalProposal,
        pendingSchedulePlan,
        scheduleAdjustmentMode,
        schedulePlanSaving,
      }}
      selection={{
        composerKeyboardStyle,
        memoryOpen: memorySelectionOpen,
        onCancelMemory: closeMemorySelection,
        onConfirmMemory: confirmSelectedMemoryMessages,
        selectedMemoryCount: selectedMemoryMessageIds.length,
      }}
      tools={{
        latestMemoryRecallCount: latestMemoryRecall ? latestMemoryRecall.length : null,
        latestMemoryRecallLabel: describeMemoryProvision(latestMemoryDebug),
        messagesPresent: !!messages.length,
        onOpenMemoryRecall: () => {
          setMemoryRecallTechnicalOpen(false);
          setMemoryRecallOpen(true);
        },
        onOrganizeMemories: handleOrganizeMemories,
        onStopMemoryOrganization: chatMemory.stopOrganization,
        onContinueMemoryOrganization: () => { void chatMemory.continueSelectedOrganization().then(result => {
          if (result.status === 'failed') showTransientMemoryNotice('上次整理尚未完成，原范围已保留，可稍后继续。', 4200);
        }); },
        unfinishedOrganization: chatMemory.unfinishedOrganization,
        onOrganizeSelected: openSelectedMemoryOrganizer,
        organizing,
        replyBusy,
        titleTextStyle,
      }}
      typing={{
        queuedMessageCount,
        replyPhase: visibleReplyPhase,
        titleTextStyle,
        visible: (pokePreparingSessionId !== null && pokePreparingSessionId === activeSessionId) || (visibleReplyBusy && visibleReplyPhase !== 'idle'),
      }}
    />
  );

}
