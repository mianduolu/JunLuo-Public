import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  DeviceEventEmitter,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { useAiConfigPreferences } from '../ai/AiConfigPreferences';
import { recordGlobalInteraction } from '../ai/globalCognition';
import { runAssistantAffectUpdate } from '../ai/assistantAffectRuntime';
import { subscribeAssistantStateChanged } from '../ai/assistantState';
import { markChatReplyFinished, markChatReplyStarted } from '../ai/aiRuntimeScheduler';
import type { BackgroundSettings } from '../backgrounds/BackgroundPreferences';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { BackgroundSurface } from '../components/BackgroundSurface';
import { loadChatPreferences } from '../chat/chatPreferences';
import { CHAT_MESSAGES_APPENDED_EVENT } from '../chat/chatMessageEvents';
import type { Navigate } from '../types/navigation';
import {
  selectJunluoFocusDueMilestones,
  generateFocusLog,
  generateFocusOpening,
  generateFocusReply,
  generateFocusSleepLog,
} from '../focus/focusCompanion';
import {
  executeFocusTimerCompletionOnce,
} from '../focus/focusTimerExecutionOnce';
import {
  commitJunluoFocusChatTurn,
  prepareJunluoFocusChatTurn,
} from '../focus/focusChatProtocol';
import { makeFocusSessionId } from '../focus/focusIdentity';
import { settleFocusMemoryUsage, type FocusMemoryReceipt } from '../focus/focusMemoryRuntime';
import { FocusJournalEntry, FocusJournalList, focusJournalPalette } from '../focus/FocusJournal';
import { createFocusReplyWait } from '../focus/focusReplyWait';
import { FOCUS_CHAT_SAVE_FAILURE_TEXT, focusChatReplyLogId, isFocusChatFailure,
  focusGenerationReplyLogId, isFocusGenerationFailureResolved, persistFocusChatDelivery, type FocusChatDelivery } from '../focus/focusChatDelivery';
import { formatFocusGenerationFailure, focusReplyGenerationFailure, classifyFocusGenerationFailure,
  type FocusGenerationFailure } from '../focus/focusGenerationFailure';
import { focusYouMessageTrigger, isFocusSleepMessage, isFocusSleeping } from '../focus/focusSleepReplies';
import { createFocusSleepRuntime, readFocusSleepSnapshot, type FocusSleepSnapshot } from '../focus/focusSleepRuntime';
import { focusSleepLogTrigger } from '../focus/focusSleepPolicy';
import { createFocusSleepReplyRuntime } from '../focus/focusSleepReplyRuntime';
import { isFocusSleepReplyReceipt, makeFocusSleepReplyReceipts, selectFocusSleepReplySources } from '../focus/focusSleepReplyPolicy';
import { bindFocusReadingSession, focusReadingOpeningActivity, focusReadingRetryOpeningActivity, recoverFailedFocusReadingStart, saveFocusNextActivityChoice } from '../focus/focusReadingRuntime';
import {
  clearActiveFocusSession,
  deleteFocusSession,
  getActiveFocusElapsed,
  loadActiveFocusSession,
  loadFocusSessionById,
  loadFocusLogs,
  loadRecentFocusSessions,
  saveFocusSession,
  saveActiveFocusSession,
  updateActiveFocusFailureReason,
  loadPendingFocusInvite,
  takePendingFocusInvite,
  type ActiveFocusSession,
  type FocusLogEntry,
  type FocusMode,
  type FocusSession,
  type FocusTimerMode,
  type PendingFocusInvite,
} from '../focus/focusStore';
import { organizeFocusSession } from '../focus/focusOrganizationRuntime';
import { FocusSummarySection } from '../focus/FocusSummarySection';
import { FocusReviewEntrance } from '../focus/FocusReviewEntrance';
import { FocusHistoryReview } from '../focus/FocusHistoryReview';
import { FocusTagPicker } from '../focus/FocusTagPicker';
import { focusCategoryFromActivity, focusNoteWithoutTag, type FocusTagSnapshot } from '../focus/focusReviewData';
import { finishFocusTiming, focusElapsedAt, pauseFocusTiming, resumeFocusTiming, startFocusTiming, type FocusTimingEvidence } from '../focus/focusTiming';
import { isFocusOrganizationLog } from '../focus/focusSummaryRecord';
import { loadCurrentReadingActivity } from '../reading/readingDailyRuntime';
import { colors } from '../theme/colors';
import type { WeatherKind } from '../types/weather';
import type { SkyTheme } from '../utils/sky';

type Props = {
  active?: boolean;
  backgroundSettings: BackgroundSettings;
  navigate: Navigate;
  skyTheme: SkyTheme;
  weatherKind?: WeatherKind;
};

type FocusPhase = 'prepare' | 'running' | 'summary';
type RuntimeLog = Omit<FocusLogEntry, 'sessionId'>;
type CategoryOption = {
  id: string;
  label: string;
};

const TIMER_TICK_MS = 1000;
const POMODORO_WORK_SECONDS = 25 * 60;
const POMODORO_SHORT_BREAK_SECONDS = 5 * 60;
const POMODORO_LONG_BREAK_SECONDS = 15 * 60;
const FOCUS_GENERATION_FAILURE_TEXT = '本次生成失败，专注计时仍在继续。';
const focusPalette = {
  peach: '#FFA18A',
  blue: '#B2D9FF',
  mint: '#CBF4EC',
  cream: '#FFF7EF',
  panel: 'rgba(255,255,255,0.64)',
};

const USER_CATEGORIES: CategoryOption[] = [
  { id: 'required-study', label: '不得不学' },
  { id: 'curious-study', label: '想学这个' },
  { id: 'work', label: '工作' },
  { id: 'create', label: '创作' },
  { id: 'exercise', label: '运动' },
  { id: 'meal', label: '吃饭' },
  { id: 'home', label: '家务' },
  { id: 'entertainment', label: '娱乐' },
  { id: 'on-the-way', label: '在路上' },
  { id: 'rest', label: '休息' },
  { id: 'custom', label: '自定义' },
];

const BAIYUN_CATEGORIES: CategoryOption[] = USER_CATEGORIES;

const BAIYUN_SUPPORT_CATEGORIES: CategoryOption[] = [
  { id: 'quiet', label: '安静专注' },
  { id: 'relaxed-chat', label: '放松闲聊' },
  { id: 'gentle-nudge', label: '温柔监督' },
  { id: 'strict-nudge', label: '严格监督' },
  { id: 'cheer', label: '夸夸打气' },
  { id: 'comfort', label: '接住情绪' },
];

function makeLog(
  role: RuntimeLog['role'],
  content: string,
  elapsedSeconds: number,
  trigger: string,
  createdAt = Date.now(),
): RuntimeLog {
  return {
    id: `focus-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt,
    elapsedSeconds,
    trigger,
  };
}

function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function minutesToSeconds(value: string, fallback: number) {
  return Math.max(1, Number(value) || fallback) * 60;
}

function getPomodoroState(
  elapsedSeconds: number,
  workSeconds: number,
  shortBreakSeconds: number,
  longBreakSeconds: number,
) {
  let remainingElapsed = elapsedSeconds;
  let round = 1;
  while (true) {
    if (remainingElapsed < workSeconds) {
      return {
        key: `work-${round}`,
        label: `第 ${round} 个番茄 · 专注中`,
        remainingSeconds: workSeconds - remainingElapsed,
        round,
        segment: 'work' as const,
      };
    }
    remainingElapsed -= workSeconds;
    const longBreak = round % 4 === 0;
    const breakSeconds = longBreak ? longBreakSeconds : shortBreakSeconds;
    if (remainingElapsed < breakSeconds) {
      return {
        key: `${longBreak ? 'long-break' : 'break'}-${round}`,
        label: longBreak ? `第 ${round} 个番茄后 · 长休息` : `第 ${round} 个番茄后 · 短休息`,
        remainingSeconds: breakSeconds - remainingElapsed,
        round,
        segment: longBreak ? 'longBreak' as const : 'break' as const,
      };
    }
    remainingElapsed -= breakSeconds;
    round += 1;
  }
}

function getPomodoroCompletionSeconds(goal: number, workSeconds: number, shortBreakSeconds: number, longBreakSeconds: number) {
  let total = 0;
  for (let round = 1; round <= goal; round += 1) {
    total += workSeconds;
    if (round < goal) total += round % 4 === 0 ? longBreakSeconds : shortBreakSeconds;
  }
  return total;
}

function timerModeLabel(timerMode: FocusTimerMode, pomodoroLabel?: string) {
  if (timerMode === 'pomodoro') return pomodoroLabel ?? '番茄钟';
  if (timerMode === 'countdown') return '倒计时';
  return '正计时';
}

function formatClock(value: number) {
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatDate(value: number) {
  return new Date(value).toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
}

function getLastTimedLogAttemptElapsed(logs: RuntimeLog[]) {
  return logs.reduce((latest, log) => (
    log.trigger === 'timed-log' || log.trigger === 'focus-generation-failed'
      ? Math.max(latest, log.elapsedSeconds)
      : latest
  ), 0);
}

function modeLabel(mode: FocusMode) {
  return mode === 'cowork' ? '各忙各的' : '陪我做事';
}

function labelForCategory(options: CategoryOption[], id: string) {
  return options.find((option) => option.id === id)?.label ?? options[0]?.label ?? '';
}

function inferBaiyunCategory(activity: string, mode: FocusMode) {
  if (mode === 'support') {
    if (/严格|使用日志|偷懒/.test(activity)) return 'strict-nudge';
    if (/监督|催|盯|进度|bug|开发|代码|报错|测试/.test(activity)) return 'gentle-nudge';
    if (/闲聊|聊天|放松/.test(activity)) return 'relaxed-chat';
    if (/夸|打气|鼓励/.test(activity)) return 'cheer';
    if (/难过|情绪|安慰|接住/.test(activity)) return 'comfort';
    return 'quiet';
  }
  if (/考试|作业|中医|网课|公开课|学习/.test(activity)) return 'required-study';
  if (/想学|研究|心理|营养|React Native|文档/.test(activity)) return 'curious-study';
  if (/小说|闲书|轻松的书|翻书|看书|读书|读一半|文章/.test(activity)) return 'entertainment';
  if (/游戏|剧|动画|漫画|音乐|听歌|歌/.test(activity)) return 'entertainment';
  if (/开发|代码|工作|整理|书桌|便签/.test(activity)) return 'work';
  if (/手账|书签|画|信|草稿|写|做/.test(activity)) return 'create';
  if (/吃饭|做饭|点餐|便当|午饭|晚饭|早饭|早餐|午餐|晚餐|夜宵/.test(activity)) return 'meal';
  if (/路上|通勤|车|走路|排队/.test(activity)) return 'on-the-way';
  if (/睡|躺|晒|休息/.test(activity)) return 'rest';
  return 'custom';
}

function composeActivity(categoryLabel: string, note: string) {
  const trimmed = note.trim();
  return trimmed ? `${categoryLabel}：${trimmed}` : categoryLabel;
}

function splitActivityText(options: CategoryOption[], activity: string, fallbackCategoryId: string) {
  const trimmed = activity.trim();
  for (const option of options) {
    for (const separator of ['：', ':']) {
      const prefix = `${option.label}${separator}`;
      if (trimmed.startsWith(prefix)) {
        return { categoryId: option.id, note: trimmed.slice(prefix.length).trim() };
      }
    }
    if (trimmed === option.label) return { categoryId: option.id, note: '' };
  }
  return { categoryId: fallbackCategoryId, note: trimmed };
}

function PauseGlyph({ paused }: { paused: boolean }) {
  if (paused) {
    return (
      <Svg height={38} viewBox="0 0 48 48" width={38}>
        <Path d="M19 14 Q19 11 21.8 12.6 L35 21 Q39 24 35 27 L21.8 35.4 Q19 37 19 34 Z" fill={focusPalette.peach} />
      </Svg>
    );
  }

  return (
    <View style={styles.pauseGlyph}>
      <View style={styles.pauseBar} />
      <View style={styles.pauseBar} />
    </View>
  );
}

export function FocusScreen({
  active = true,
  backgroundSettings,
  navigate,
  skyTheme,
  weatherKind,
}: Props) {
  const insets = useSafeAreaInsets();
  const {
    chatConnection,
    chatKey,
    lifeCreativeConnection,
    lifeCreativeKey,
    memoryOrganizerConnection,
    memoryOrganizerKey,
    profile,
  } = useAiConfigPreferences();
  const [phase, setPhase] = useState<FocusPhase>('prepare');
  const [mode, setMode] = useState<FocusMode>('cowork');
  const [timerMode, setTimerMode] = useState<FocusTimerMode>('pomodoro');
  const [targetMinutes, setTargetMinutes] = useState('25');
  const [pomodoroGoal, setPomodoroGoal] = useState('4');
  const [pomodoroLongBreakMinutes, setPomodoroLongBreakMinutes] = useState('15');
  const [pomodoroShortBreakMinutes, setPomodoroShortBreakMinutes] = useState('5');
  const [pomodoroWorkMinutes, setPomodoroWorkMinutes] = useState('25');
  const [userCategory, setUserCategory] = useState('required-study');
  const [baiyunCategory, setBaiyunCategory] = useState('required-study');
  const [userActivity, setUserActivity] = useState('');
  const [baiyunActivity, setBaiyunActivity] = useState('');
  const [sleepDisplay, setSleepDisplay] = useState<{ snapshot: FocusSleepSnapshot; hasSlept: boolean }>();
  const preparationEditedRef = useRef(false);
  const [canPrefillReading, setCanPrefillReading] = useState(false);
  const readingPrefilledRef = useRef(false);
  const [recentSessions, setRecentSessions] = useState<FocusSession[]>([]);
  const recentSessionsReadRef = useRef({ version: 0, mounted: true });
  useEffect(() => {
    recentSessionsReadRef.current.mounted = true;
    return () => {
      recentSessionsReadRef.current.mounted = false;
      recentSessionsReadRef.current.version += 1;
    };
  }, []);
  const focusRestoreReadyRef = useRef(false);
  const focusRestoreLoadingRef = useRef(false);
  const [focusRestoreState, setFocusRestoreState] = useState<'loading' | 'failed' | 'ready'>('loading');
  const [focusRestoreAttempt, setFocusRestoreAttempt] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [endedAt, setEndedAt] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [logNow, setLogNow] = useState(() => Date.now());
  const [paused, setPausedState] = useState(false);
  const timerPausedRef = useRef(paused);
  const setPaused = (value: boolean) => {
    timerPausedRef.current = value;
    setPausedState(value);
  };
  const [pausedAt, setPausedAt] = useState<number | undefined>();
  const [totalPausedMs, setTotalPausedMs] = useState(0);
  const [logs, setLogs] = useState<RuntimeLog[]>([]);
  const [draft, setDraft] = useState('');
  const [savedSession, setSavedSession] = useState<FocusSession | null>(null);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedTag, setSelectedTag] = useState<FocusTagSnapshot>();
  const timingRef = useRef<FocusTimingEvidence | undefined>(undefined);
  const sceneCategoryRef = useRef<string | undefined>(undefined);
  const sceneTagRef = useRef<FocusTagSnapshot | undefined>(undefined);
  const committingMessageRef = useRef(false);
  const finishingRef = useRef(false);
  const generatingLogRef = useRef(false);
  const startingRef = useRef(false);
  const resettingFocusRef = useRef(false);
  const pomodoroKeyRef = useRef('');
  const elapsedSecondsRef = useRef(0);
  const logsRef = useRef<RuntimeLog[]>([]);
  const runningScrollRef = useRef<ScrollView>(null);
  const composerFocusedRef = useRef(false);
  const readingInviteRef = useRef<Pick<PendingFocusInvite, 'readingId' | 'readingActivityId'>>({});
  const readingBindingRef = useRef<ActiveFocusSession['reading']>(undefined);
  const appStateRef = useRef(AppState.currentState);
  const draftRef = useRef('');
  const focusStartedAtRef = useRef(0);
  const awakeTimedBaselineRef = useRef(0);
  const awakeTimedSleepKeyRef = useRef('');
  const timedCatchUpRef = useRef(false);
  const sleepTransitionRevisionRef = useRef(0);
  const observedSleepingRef = useRef<boolean | undefined>(undefined);
  const sleepDisplayRef = useRef<typeof sleepDisplay>(undefined);
  const sleepRuntimeRef = useRef<ReturnType<typeof createFocusSleepRuntime> | null>(null);
  const sleepScreenRef = useRef({ active, phase, baiyunActivity, aiOptions: {} as Parameters<typeof generateFocusSleepLog>[0] });
  const focusReplyWaitRef = useRef<ReturnType<typeof createFocusReplyWait> | null>(null);
  const normalFocusReplyCountRef = useRef(0);
  const pendingChatDeliveriesRef = useRef(new Map<string, FocusChatDelivery>());
  const sleepReplyRuntimeRef = useRef<ReturnType<typeof createFocusSleepReplyRuntime> | null>(null);
  const sleepReplyScreenRef = useRef({ active, phase, chatAiOptions: {} as typeof chatAiOptions,
    baiyunActivity, buildSession: () => ({} as ActiveFocusSession) });
  if (!focusReplyWaitRef.current) {
    focusReplyWaitRef.current = createFocusReplyWait({
      getDraft: () => draftRef.current,
      loadWaitingMode: async () => (await loadChatPreferences()).waitingModeEnabled,
    });
  }
  const handleDraftChange = (value: string) => {
    draftRef.current = value;
    setDraft(value);
    focusReplyWaitRef.current!.draftChanged();
  };
  const keepComposerVisible = () => {
    if (composerFocusedRef.current) runningScrollRef.current?.scrollToEnd({ animated: false });
  };

  const aiOptions = useMemo(() => ({
    apiKey: lifeCreativeConnection ? lifeCreativeKey : chatKey,
    connection: lifeCreativeConnection ?? chatConnection,
    profile,
    readTimerPaused: () => timerPausedRef.current,
  }), [chatConnection, chatKey, lifeCreativeConnection, lifeCreativeKey, profile]);
  const chatAiOptions = useMemo(() => ({
    apiKey: chatKey,
    connection: chatConnection,
    profile,
    readTimerPaused: () => timerPausedRef.current,
  }), [chatConnection, chatKey, profile]);
  sleepScreenRef.current = { active, phase, baiyunActivity, aiOptions: { ...aiOptions, kind: 'motion', userActivity } };
  const sleeping = sleepDisplay?.snapshot.sleeping === true;
  const effectiveBaiyunActivity = phase === 'running' && sleepDisplay?.hasSlept
    ? sleeping ? '休息：睡觉' : sleepDisplay.snapshot.awakeActivity ?? ''
    : baiyunActivity;
  const pomodoroWorkSeconds = minutesToSeconds(pomodoroWorkMinutes, 25);
  const pomodoroShortBreakSeconds = minutesToSeconds(pomodoroShortBreakMinutes, 5);
  const pomodoroLongBreakSeconds = minutesToSeconds(pomodoroLongBreakMinutes, 15);
  const pomodoroGoalCount = Math.max(1, Number(pomodoroGoal) || 4);
  const pomodoroCompletionSeconds = getPomodoroCompletionSeconds(
    pomodoroGoalCount,
    pomodoroWorkSeconds,
    pomodoroShortBreakSeconds,
    pomodoroLongBreakSeconds,
  );
  const targetSeconds = timerMode === 'countdown' ? minutesToSeconds(targetMinutes, 25) : undefined;
  const buildActiveFocusSession = (
    overrides: Partial<ActiveFocusSession> = {},
  ): ActiveFocusSession => ({
    baiyunActivity,
    elapsedSeconds: elapsedSecondsRef.current,
    logs: logsRef.current,
    mode,
    paused,
    pausedAt,
    pomodoroGoal: pomodoroGoalCount,
    pomodoroLongBreakSeconds,
    pomodoroShortBreakSeconds,
    pomodoroWorkSeconds,
    startedAt,
    targetSeconds,
    timerMode,
    totalPausedMs,
    userActivity,
    reading: readingBindingRef.current,
    timing: timingRef.current,
    categoryId: sceneCategoryRef.current,
    tag: sceneTagRef.current,
    ...overrides,
  });
  sleepReplyScreenRef.current = { active, phase, chatAiOptions, baiyunActivity: effectiveBaiyunActivity,
    buildSession: buildActiveFocusSession };
  const saveChatReplyDelivery = async (delivery: FocusChatDelivery) => {
    const current = () => !finishingRef.current && focusStartedAtRef.current === delivery.source.startedAt
      && canCommitBackupRestoreDataEpoch(delivery.epoch) && (delivery.canCommit?.() ?? true);
    if (!current()) {
      pendingChatDeliveriesRef.current.delete(delivery.failure.id);
      return false;
    }
    pendingChatDeliveriesRef.current.set(delivery.failure.id, delivery);
    const committed = await runBackupRestoreDataEpochCommit(delivery.epoch, () => persistFocusChatDelivery(delivery, {
      current, read: () => loadActiveFocusSession(true),
      save: session => saveActiveFocusSession(session, {
        expectedSessionId: makeFocusSessionId(delivery.source), canCommit: current,
        beforeSave: delivery.beforeSave,
      }),
      elapsed: () => elapsedSecondsRef.current,
    })).catch(error => {
      console.warn('[focus] chat reply readback unavailable', error);
      return null;
    });
    const stillEligible = delivery.beforeSave ? await delivery.beforeSave().catch(() => null) : true;
    if (!current() || stillEligible === false) {
      pendingChatDeliveriesRef.current.delete(delivery.failure.id);
      return false;
    }
    if (!committed?.committed || !committed.value || stillEligible !== true) {
      if (!logsRef.current.some(log => log.id === delivery.failure.id)) {
        logsRef.current = [...logsRef.current, delivery.failure];
      }
      setLogs(logsRef.current);
      return false;
    }
    pendingChatDeliveriesRef.current.delete(delivery.failure.id);
    logsRef.current = [...logsRef.current, ...committed.value.filter(log => !logsRef.current.some(old => old.id === log.id))];
    setLogs(logsRef.current);
    if (delivery.prepared && delivery.rawEnvelope) {
      const commit = () => runBackupRestoreDataEpochCommit(delivery.epoch, () => commitJunluoFocusChatTurn({
        assistantLogs: delivery.logs, prepared: delivery.prepared!, rawEnvelope: delivery.rawEnvelope, canCommit: current,
      }));
      let sideEffects = await commit().catch(() => null);
      if (!sideEffects?.committed && current()) sideEffects = await commit().catch(() => null);
      void sideEffects;
    }
    if (delivery.memoryUsage) await settleFocusMemoryUsage(delivery.memoryUsage, delivery.logs,
      delivery.rawEnvelope, current, makeFocusSessionId(delivery.source)).catch(() => undefined);
    return true;
  };
  const saveSleepReplyLogs = async (newLogs: RuntimeLog[], sourceSession: ActiveFocusSession,
    dataEpoch: ReturnType<typeof captureBackupRestoreDataEpoch>) => {
    const canSave = () => !finishingRef.current && focusStartedAtRef.current === sourceSession.startedAt
      && sleepReplyScreenRef.current.active && AppState.currentState === 'active'
      && canCommitBackupRestoreDataEpoch(dataEpoch);
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      if (!canSave()) return null;
      const current = await loadActiveFocusSession(true);
      if (!current || makeFocusSessionId(current) !== makeFocusSessionId(sourceSession)) return null;
      const next = [...current.logs, ...newLogs.filter(log => !current.logs.some(old => old.id === log.id))];
      try {
        await saveActiveFocusSession({ ...current, elapsedSeconds: elapsedSecondsRef.current, logs: next }, {
          expectedSessionId: makeFocusSessionId(sourceSession), canCommit: canSave,
        });
      } catch (error) {
        // The original writer can fail in an auxiliary hook after the raw journal was saved.
        console.warn('[focus] sleep reply save needs readback', error);
      }
      const actual = await loadActiveFocusSession(true);
      if (!actual || makeFocusSessionId(actual) !== makeFocusSessionId(sourceSession)
        || newLogs.some(log => !actual.logs.some(saved => saved.id === log.id && saved.role === log.role
          && saved.trigger === log.trigger && saved.content === log.content))) return null;
      if (!canSave()) return null;
      logsRef.current = [...logsRef.current, ...actual.logs.filter(log => !logsRef.current.some(old => old.id === log.id))];
      return logsRef.current;
    });
    if (!committed.committed || !committed.value || !canSave()) return false;
    setLogs(committed.value);
    return true;
  };
  if (!sleepReplyRuntimeRef.current) {
    sleepReplyRuntimeRef.current = createFocusSleepReplyRuntime({
      getSession: () => sleepReplyScreenRef.current.phase === 'running' && !finishingRef.current
        ? sleepReplyScreenRef.current.buildSession() : null,
      readSession: () => loadActiveFocusSession(true),
      isVisible: () => sleepReplyScreenRef.current.active && sleepReplyScreenRef.current.phase === 'running'
        && AppState.currentState === 'active' && !finishingRef.current,
      isBusy: () => normalFocusReplyCountRef.current > 0 || committingMessageRef.current || generatingLogRef.current,
      wait: () => focusReplyWaitRef.current!.wait(),
      cancelWait: () => focusReplyWaitRef.current!.cancel(),
      captureEpoch: captureBackupRestoreDataEpoch, canCommit: canCommitBackupRestoreDataEpoch,
      makeLog, failureText: FOCUS_GENERATION_FAILURE_TEXT,
      started: markChatReplyStarted,
      finished: async (saved, epoch) => {
        await markChatReplyFinished(saved ? 'finished' : 'aborted', { persist: canCommitBackupRestoreDataEpoch(epoch) });
        if (saved && sleepReplyScreenRef.current.buildSession().mode === 'cowork' && canCommitBackupRestoreDataEpoch(epoch)) {
          void runAssistantAffectUpdate().catch(() => undefined);
        }
      },
      generate: async (session, sources, epoch) => {
        const firstSource = session.logs.findIndex(log => log.id === sources[0].id);
        const currentYouMessages = session.logs.slice(firstSource).filter(log => log.role === 'you');
        const prepared = await prepareJunluoFocusChatTurn({ logs: session.logs,
          sessionId: makeFocusSessionId(session), youMessage: currentYouMessages.at(-1)!, youMessages: currentYouMessages }).catch(() => null);
        const canStartRequest = async () => !finishingRef.current && focusStartedAtRef.current === session.startedAt
          && sleepReplyScreenRef.current.active && AppState.currentState === 'active'
          && canCommitBackupRestoreDataEpoch(epoch)
          && (!prepared || canCommitBackupRestoreDataEpoch(prepared.dataEpoch)) && !await isFocusSleeping();
        const reply = await generateFocusReply({ ...sleepReplyScreenRef.current.chatAiOptions,
          baiyunActivity: sleepReplyScreenRef.current.baiyunActivity, elapsedSeconds: elapsedSecondsRef.current,
          logs: session.logs, mode: session.mode, userActivity: session.userActivity,
          userMessage: sources.map(log => log.content).join('\n\n'), sleepReplySources: sources,
          fixedResponseInstruction: prepared?.responseInstruction, canStartRequest,
        }).catch(focusReplyGenerationFailure);
        return { ...reply, prepared };
      },
      save: (newLogs, session, epoch) => saveSleepReplyLogs(newLogs, session, epoch),
      commit: async ({ logs: newLogs, reply, session, epoch }) => {
        if (!reply.prepared || !reply.rawEnvelope) return;
        await runBackupRestoreDataEpochCommit(epoch, () => commitJunluoFocusChatTurn({
          assistantLogs: newLogs.filter(log => log.role === 'I'), prepared: reply.prepared!, rawEnvelope: reply.rawEnvelope,
          canCommit: () => !finishingRef.current && focusStartedAtRef.current === session.startedAt
            && canCommitBackupRestoreDataEpoch(epoch),
        }));
      },
    });
  }
  const pomodoroState = timerMode === 'pomodoro'
    ? getPomodoroState(elapsedSeconds, pomodoroWorkSeconds, pomodoroShortBreakSeconds, pomodoroLongBreakSeconds)
    : undefined;
  const displayedSeconds = timerMode === 'pomodoro'
    ? pomodoroState?.remainingSeconds ?? POMODORO_WORK_SECONDS
    : timerMode === 'countdown' && targetSeconds
      ? Math.max(0, targetSeconds - elapsedSeconds)
      : elapsedSeconds;
  const baiyunCategories = mode === 'cowork' ? BAIYUN_CATEGORIES : BAIYUN_SUPPORT_CATEGORIES;
  const displayedBaiyunCategories = sleeping ? [{ id: 'rest', label: '休息' }] : baiyunCategories;

  if (!sleepRuntimeRef.current) {
    sleepRuntimeRef.current = createFocusSleepRuntime({
      isVisible: () => sleepScreenRef.current.active && sleepScreenRef.current.phase !== 'summary'
        && AppState.currentState === 'active' && !finishingRef.current,
      getSession: () => sleepScreenRef.current.phase === 'running' && focusStartedAtRef.current
        ? { startedAt: focusStartedAtRef.current, userActivity: sleepScreenRef.current.aiOptions.userActivity,
          logs: logsRef.current, baiyunActivity: sleepScreenRef.current.baiyunActivity,
          elapsedSeconds: elapsedSecondsRef.current } : null,
      generate: (kind, activity) => generateFocusSleepLog({ ...sleepScreenRef.current.aiOptions, kind, userActivity: activity }),
      captureEpoch: captureBackupRestoreDataEpoch,
      canCommit: canCommitBackupRestoreDataEpoch,
      onState: (snapshot, hasSlept) => {
        if (observedSleepingRef.current !== undefined && observedSleepingRef.current !== snapshot.sleeping) {
          sleepTransitionRevisionRef.current += 1;
        }
        observedSleepingRef.current = snapshot.sleeping;
        if (snapshot.sleeping) {
          awakeTimedBaselineRef.current = elapsedSecondsRef.current;
        }
        const next = { snapshot, hasSlept };
        sleepDisplayRef.current = next;
        setSleepDisplay(current => current?.hasSlept === hasSlept
          && current.snapshot.sleeping === snapshot.sleeping
          && current.snapshot.awakeActivity === snapshot.awakeActivity ? current : next);
        void sleepReplyRuntimeRef.current?.tick();
      },
      save: async (log, expectedStartedAt, dataEpoch, canSave) => {
        const currentScene = () => !finishingRef.current && focusStartedAtRef.current === expectedStartedAt
          && sleepScreenRef.current.active && AppState.currentState === 'active'
          && canCommitBackupRestoreDataEpoch(dataEpoch);
        const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
          if (!currentScene() || !await canSave()) return null;
          const current = await loadActiveFocusSession(true);
          if (!currentScene() || !current || current.startedAt !== expectedStartedAt) return null;
          const saved = await saveActiveFocusSession({ ...current, elapsedSeconds: elapsedSecondsRef.current,
            logs: current.logs.some(item => item.id === log.id) ? current.logs : [...current.logs, log] }, {
            expectedSessionId: makeFocusSessionId(current),
            canCommit: currentScene,
            beforeSave: canSave,
          });
          if (!saved || !currentScene()) return null;
          const merged = [...logsRef.current, ...saved.logs.filter(item => !logsRef.current.some(old => old.id === item.id))];
          logsRef.current = merged;
          return merged;
        });
        if (!committed.committed || !committed.value || !currentScene()) return false;
        setLogs(committed.value);
        return true;
      },
    });
  }

  useEffect(() => {
    const runtime = sleepRuntimeRef.current!;
    if (!active || phase === 'summary') { runtime.suspend(); sleepReplyRuntimeRef.current?.suspend(); return; }
    void runtime.tick();
    const interval = setInterval(() => void runtime.tick(), 30_000);
    const unsubscribe = subscribeAssistantStateChanged(state => {
      const nextSleeping = state.lifeMode === 'sleeping';
      if (observedSleepingRef.current !== undefined && observedSleepingRef.current !== nextSleeping) {
        sleepTransitionRevisionRef.current += 1;
      }
      observedSleepingRef.current = nextSleeping;
      void runtime.tick();
    });
    const messages = DeviceEventEmitter.addListener(CHAT_MESSAGES_APPENDED_EVENT, () => void runtime.tick());
    const appState = AppState.addEventListener('change', state => {
      runtime.suspend();
      sleepReplyRuntimeRef.current?.suspend();
      if (state === 'active') void runtime.tick();
    });
    return () => { clearInterval(interval); unsubscribe(); messages.remove(); appState.remove(); runtime.suspend(); sleepReplyRuntimeRef.current?.suspend(); };
  }, [active, phase]);

  useEffect(() => {
    if (phase !== 'prepare' || !sleepDisplay?.hasSlept) return;
    readingInviteRef.current = {};
    if (sleeping) return;
    preparationEditedRef.current = true;
    setBaiyunCategory('custom');
    setBaiyunActivity(sleepDisplay.snapshot.awakeActivity ?? '');
  }, [phase, sleepDisplay, sleeping]);

  useEffect(() => () => focusReplyWaitRef.current?.cancel(), []);

  useEffect(() => {
    for (const [id, delivery] of pendingChatDeliveriesRef.current) {
      if (phase !== 'running' || delivery.source.startedAt !== startedAt
        || !canCommitBackupRestoreDataEpoch(delivery.epoch)) pendingChatDeliveriesRef.current.delete(id);
    }
  }, [phase, startedAt]);

  useEffect(() => {
    const alreadyRestored = focusRestoreReadyRef.current;
    if (!active || (alreadyRestored && phase !== 'prepare')) return;
    const recentReadVersion = alreadyRestored ? recentSessionsReadRef.current.version
      : ++recentSessionsReadRef.current.version;
    let cancelled = false;
    let restored = false;
    focusRestoreReadyRef.current = false;
    focusRestoreLoadingRef.current = true;
    setFocusRestoreState('loading');
    const dataEpoch = captureBackupRestoreDataEpoch();
    void (async () => {
      if (dataEpoch === null) return;
      const loaded = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        if (alreadyRestored) return { active: null, invite: await loadPendingFocusInvite(), sessions: null };
        const sessions = await loadRecentFocusSessions();
        const active = await loadActiveFocusSession();
        const invite = active ? null : await loadPendingFocusInvite();
        return { active, invite, sessions };
      });
      if (
        cancelled
        || !loaded.committed
        || !canCommitBackupRestoreDataEpoch(dataEpoch)
      ) return;
      restored = true;
      const { active, invite, sessions } = loaded.value;
      if (sessions && recentSessionsReadRef.current.mounted
        && recentReadVersion === recentSessionsReadRef.current.version) setRecentSessions(sessions);
      if (active) {
        readingBindingRef.current = active.reading;
        timingRef.current = active.timing;
        sceneCategoryRef.current = active.categoryId;
        sceneTagRef.current = active.tag;
        const parsedUser = splitActivityText(USER_CATEGORIES, active.userActivity, userCategory);
        const parsedBaiyun = splitActivityText(
          active.mode === 'cowork' ? BAIYUN_CATEGORIES : BAIYUN_SUPPORT_CATEGORIES,
          active.baiyunActivity,
          inferBaiyunCategory(active.baiyunActivity, active.mode),
        );
        setMode(active.mode);
        setTimerMode(active.timerMode);
        setTargetMinutes(active.targetSeconds ? String(Math.max(1, Math.round(active.targetSeconds / 60))) : '25');
        setPomodoroGoal(active.pomodoroGoal ? String(active.pomodoroGoal) : '4');
        setPomodoroLongBreakMinutes(active.pomodoroLongBreakSeconds ? String(Math.max(1, Math.round(active.pomodoroLongBreakSeconds / 60))) : '15');
        setPomodoroShortBreakMinutes(active.pomodoroShortBreakSeconds ? String(Math.max(1, Math.round(active.pomodoroShortBreakSeconds / 60))) : '5');
        setPomodoroWorkMinutes(active.pomodoroWorkSeconds ? String(Math.max(1, Math.round(active.pomodoroWorkSeconds / 60))) : '25');
        setUserCategory(parsedUser.categoryId);
        setBaiyunCategory(parsedBaiyun.categoryId);
        setUserActivity(active.userActivity);
        setBaiyunActivity(active.baiyunActivity);
        setStartedAt(active.startedAt);
        focusStartedAtRef.current = active.startedAt;
        const activeElapsedSeconds = getActiveFocusElapsed(active);
        elapsedSecondsRef.current = activeElapsedSeconds;
        timedCatchUpRef.current = true;
        logsRef.current = active.logs;
        setElapsedSeconds(activeElapsedSeconds);
        setPaused(active.paused);
        setPausedAt(active.pausedAt);
        setTotalPausedMs(active.totalPausedMs);
        setLogs(active.logs);
        setHistoryOpen(false);
        setPhase('running');
        return;
      }

      if (!invite) {
        setCanPrefillReading(true);
        return;
      }
      const nextCategory = inferBaiyunCategory(invite.baiyunActivity, invite.mode);
      readingInviteRef.current = { readingId: invite.readingId, readingActivityId: invite.readingActivityId };
      const parsed = splitActivityText(
        invite.mode === 'cowork' ? BAIYUN_CATEGORIES : BAIYUN_SUPPORT_CATEGORIES,
        invite.baiyunActivity,
        nextCategory,
      );
      setMode(invite.mode);
      setBaiyunCategory(parsed.categoryId);
      setBaiyunActivity(invite.mode === 'cowork' ? parsed.note : invite.baiyunActivity);
      await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        if (!cancelled) await takePendingFocusInvite(invite);
      });
    })().catch(error => {
      restored = false;
      if (!cancelled) console.warn('[focus] saved session restore unavailable', error);
    }).finally(() => {
      if (cancelled) return;
      focusRestoreLoadingRef.current = false;
      focusRestoreReadyRef.current = restored && canCommitBackupRestoreDataEpoch(dataEpoch);
      setFocusRestoreState(focusRestoreReadyRef.current ? 'ready' : 'failed');
    });
    return () => {
      cancelled = true;
      focusRestoreReadyRef.current = (restored || alreadyRestored) && canCommitBackupRestoreDataEpoch(dataEpoch);
      focusRestoreLoadingRef.current = false;
    };
  }, [active, phase, focusRestoreAttempt]);

  useEffect(() => {
    if (!active || phase !== 'prepare' || sleeping || !canPrefillReading || preparationEditedRef.current) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    let cancelled = false;
    void loadCurrentReadingActivity().then(current => {
      if (cancelled || sleepDisplayRef.current?.snapshot.sleeping || preparationEditedRef.current || startingRef.current
        || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      if (!current || !['reading', 'preparing'].includes(current.status) || current.startedAt > Date.now()) {
        if (readingPrefilledRef.current) {
          readingInviteRef.current = {};
          readingPrefilledRef.current = false;
          setBaiyunCategory('required-study');
          setBaiyunActivity('');
        }
        return;
      }
      // Carry only the existing activity identity: opening this page never starts a book.
      readingInviteRef.current = { readingActivityId: current.activityId };
      readingPrefilledRef.current = true;
      setBaiyunCategory('custom');
      setBaiyunActivity(`读《${current.title}》`);
    }).catch(error => console.warn('[focus] current reading prefill unavailable', error));
    return () => { cancelled = true; };
  }, [active, phase, sleeping, canPrefillReading]);

  useEffect(() => {
    if (baiyunCategories.some((category) => category.id === baiyunCategory)) return;
    setBaiyunCategory(baiyunCategories[0]?.id ?? 'required-study');
  }, [baiyunCategories, baiyunCategory]);

  useEffect(() => {
    if (!active || phase !== 'running' || !startedAt || finishingRef.current) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    void runBackupRestoreDataEpochCommit(dataEpoch, () => (
      saveActiveFocusSession(buildActiveFocusSession())
    )).catch(() => undefined);
  }, [active, baiyunActivity, logs, mode, paused, pausedAt, phase, pomodoroGoalCount, pomodoroLongBreakSeconds, pomodoroShortBreakSeconds, pomodoroWorkSeconds, startedAt, targetSeconds, timerMode, totalPausedMs, userActivity]);

  useEffect(() => {
    if (!active || phase !== 'running' || paused || !startedAt) return undefined;
    const syncElapsed = () => {
      const next = Math.max(0, Math.floor((Date.now() - startedAt - totalPausedMs) / 1000));
      elapsedSecondsRef.current = next;
      setElapsedSeconds((current) => current === next ? current : next);
    };
    syncElapsed();
    const intervalId = setInterval(() => {
      syncElapsed();
    }, TIMER_TICK_MS);
    return () => clearInterval(intervalId);
  }, [active, paused, phase, startedAt, totalPausedMs]);

  useEffect(() => {
    if (!active || phase !== 'running' || !startedAt || finishingRef.current) return undefined;
    let cancelled = false;
    let checkpointRevision = 0;
    let appliedCheckpointRevision = 0;
    const syncLogNow = () => {
      if (!finishingRef.current) setLogNow(Date.now());
    };
    syncLogNow();
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') syncLogNow();
    });
    const intervalId = setInterval(() => {
      if (finishingRef.current) return;
      syncLogNow();
      const dataEpoch = captureBackupRestoreDataEpoch();
      if (dataEpoch === null) return;
      const revision = ++checkpointRevision;
      void runBackupRestoreDataEpochCommit(dataEpoch, () => (
        saveActiveFocusSession(buildActiveFocusSession())
      )).then(result => {
        if (!result.committed || !result.value || !canCommitBackupRestoreDataEpoch(dataEpoch)
          || cancelled || finishingRef.current || focusStartedAtRef.current !== startedAt
          || revision < appliedCheckpointRevision) return;
        appliedCheckpointRevision = revision;
        readingBindingRef.current = result.value.reading;
        if (result.value.reading?.transition) {
          setBaiyunActivity(result.value.baiyunActivity);
          const merged = [...logsRef.current,
            ...result.value.logs.filter(log => !logsRef.current.some(current => current.id === log.id))]
            .sort((left, right) => left.createdAt - right.createdAt);
          logsRef.current = merged;
          setLogs(merged);
        }
      }).catch(() => undefined);
    }, 30 * 1000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
      appStateSubscription.remove();
    };
  }, [active, baiyunActivity, mode, paused, pausedAt, phase, pomodoroGoalCount, pomodoroLongBreakSeconds, pomodoroShortBreakSeconds, pomodoroWorkSeconds, startedAt, targetSeconds, timerMode, totalPausedMs, userActivity]);

  useEffect(() => {
    if (!active || phase !== 'running' || timerMode !== 'countdown' || !targetSeconds || elapsedSeconds < targetSeconds) return;
    void finishFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, elapsedSeconds, phase, targetSeconds, timerMode]);

  useEffect(() => {
    if (!active || phase !== 'running' || timerMode !== 'pomodoro' || elapsedSeconds < pomodoroCompletionSeconds) return;
    void finishFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, elapsedSeconds, phase, pomodoroCompletionSeconds, timerMode]);

  useEffect(() => {
    if (!active || phase !== 'running' || timerMode !== 'pomodoro' || !pomodoroState || finishingRef.current) return;
    if (!pomodoroKeyRef.current) {
      pomodoroKeyRef.current = pomodoroState.key;
      return;
    }
    if (pomodoroKeyRef.current === pomodoroState.key) return;
    pomodoroKeyRef.current = pomodoroState.key;
    const content = pomodoroState.segment === 'work'
      ? `休息结束，第 ${pomodoroState.round} 个番茄钟开始`
      : pomodoroState.segment === 'longBreak'
        ? `第 ${pomodoroState.round} 个番茄钟结束，长休息 ${Math.round(pomodoroLongBreakSeconds / 60)} 分钟`
        : `第 ${pomodoroState.round} 个番茄钟结束，短休息 ${Math.round(pomodoroShortBreakSeconds / 60)} 分钟`;
    setLogs(() => {
      const next = [...logsRef.current, makeLog('system', content, elapsedSecondsRef.current, 'pomodoro-transition')];
      logsRef.current = next;
      return next;
    });
  }, [active, elapsedSeconds, phase, pomodoroLongBreakSeconds, pomodoroShortBreakSeconds, pomodoroState, timerMode]);

  useEffect(() => {
    if (!active && phase === 'running') timedCatchUpRef.current = true;
  }, [active, phase]);

  useEffect(() => {
    if (!active || phase !== 'running' || paused) return undefined;
    void addDueTimedLogs();
    const intervalId = setInterval(() => {
      void addDueTimedLogs();
    }, 60 * 1000);
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      const previous = appStateRef.current;
      appStateRef.current = state;
      if (state !== 'active' || previous === 'active') return;
      const nextElapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt - totalPausedMs) / 1000));
      elapsedSecondsRef.current = nextElapsedSeconds;
      setElapsedSeconds(nextElapsedSeconds);
      void addDueTimedLogs(nextElapsedSeconds, true);
    });
    return () => {
      clearInterval(intervalId);
      appStateSubscription.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, paused, phase, startedAt, totalPausedMs]);

  const addDueTimedLogs = async (elapsedOverride?: number, resumedFromBackground = false) => {
    if (generatingLogRef.current || phase !== 'running' || finishingRef.current) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    const sourceSession = buildActiveFocusSession();
    const expectedSessionId = makeFocusSessionId(sourceSession);
    const currentScene = () => !finishingRef.current && focusStartedAtRef.current === sourceSession.startedAt
      && canCommitBackupRestoreDataEpoch(dataEpoch);
    if (!currentScene()) return;
    const initialSleep = await readFocusSleepSnapshot().catch(() => null);
    if (!initialSleep || !currentScene()) return;
    if (initialSleep.sleeping) {
      awakeTimedBaselineRef.current = elapsedOverride ?? elapsedSecondsRef.current;
      return;
    }
    if (sleepDisplayRef.current?.hasSlept && !sleepDisplayRef.current.snapshot.awakeActivity) return;
    const currentLogs = logsRef.current;
    const currentElapsedSeconds = elapsedOverride ?? elapsedSecondsRef.current;
    const wakeAt = initialSleep.lastWakeAt ?? 0;
    const wokeThisSession = wakeAt >= sourceSession.startedAt && wakeAt >= (initialSleep.lastSleepAt ?? -Infinity);
    const sleptThisSession = (initialSleep.lastSleepAt ?? -Infinity) >= sourceSession.startedAt
      || currentLogs.some(log => log.trigger === 'focus-sleep-opening'
        || log.trigger === 'focus-sleep-motion' || log.trigger === 'focus-sleep-opening-failed'
        || log.trigger.startsWith('focus-sleep-waking'));
    if (wokeThisSession || sleptThisSession) {
      const key = JSON.stringify([sourceSession.startedAt, initialSleep.sleepKey, initialSleep.lastSleepAt, wakeAt]);
      if (awakeTimedSleepKeyRef.current !== key) {
        awakeTimedSleepKeyRef.current = key;
        const wakeElapsed = wokeThisSession ? focusElapsedAt(timingRef.current, wakeAt) : undefined;
        awakeTimedBaselineRef.current = Math.max(awakeTimedBaselineRef.current, wakeElapsed ?? currentElapsedSeconds);
      }
    }
    const catchUp = resumedFromBackground || timedCatchUpRef.current;
    timedCatchUpRef.current = false;
    const dueElapsedSeconds = selectJunluoFocusDueMilestones({
      currentElapsedSeconds,
      lastAttemptedElapsedSeconds: Math.max(getLastTimedLogAttemptElapsed(currentLogs), awakeTimedBaselineRef.current),
      resumedFromBackground: catchUp,
    });
    if (!dueElapsedSeconds.length) return;
    if (generatingLogRef.current) return;
    generatingLogRef.current = true;
    try {
      const batchSleep = await readFocusSleepSnapshot();
      if (!currentScene()) return;
      const batchSleepRevision = sleepTransitionRevisionRef.current;
      let nextLogs = currentLogs;
      const generatedLogs: RuntimeLog[] = [];
      for (const dueElapsedSecond of dueElapsedSeconds) {
        const generationSleep = await readFocusSleepSnapshot();
        if (!currentScene() || generationSleep.sleeping) return;
        const sleepRevision = sleepTransitionRevisionRef.current;
        let failure: FocusGenerationFailure | undefined;
        const content = await generateFocusLog({
          ...aiOptions,
          onFailure: reason => { failure = reason; },
          baiyunActivity: effectiveBaiyunActivity,
          elapsedSeconds: dueElapsedSecond,
          logs: nextLogs,
          mode,
          userActivity,
        }).catch(error => { failure = classifyFocusGenerationFailure(error, 20_000); return ''; });
        const currentSleep = await readFocusSleepSnapshot();
        if (currentSleep.sleeping || currentSleep.sleepKey !== generationSleep.sleepKey
          || sleepTransitionRevisionRef.current !== sleepRevision
          || !currentScene()) return;
        const generatedAt = Date.now();
        const nextLog = content
          ? makeLog('I', content, dueElapsedSecond, 'timed-log', generatedAt)
          : makeLog(
              'system',
              formatFocusGenerationFailure(failure, FOCUS_GENERATION_FAILURE_TEXT),
              dueElapsedSecond,
              'focus-generation-failed',
              generatedAt,
            );
        generatedLogs.push(nextLog);
        nextLogs = [...nextLogs, nextLog];
      }
      const currentSleep = await readFocusSleepSnapshot();
      if (!currentScene() || currentSleep.sleeping || currentSleep.sleepKey !== batchSleep.sleepKey
        || sleepTransitionRevisionRef.current !== batchSleepRevision) return;
      const current = await loadActiveFocusSession(true);
      if (!currentScene() || !current || makeFocusSessionId(current) !== expectedSessionId) return;
      const existingTimedLogElapsed = new Set([...logsRef.current, ...current.logs]
        .filter(log => log.trigger === 'timed-log' || log.trigger === 'focus-generation-failed')
        .map(log => log.elapsedSeconds));
      const missingLogs = generatedLogs.filter(log => !existingTimedLogElapsed.has(log.elapsedSeconds));
      if (!missingLogs.length) return;
      const failure = missingLogs.some(log => log.role === 'I')
        ? makeLog('system', FOCUS_CHAT_SAVE_FAILURE_TEXT, missingLogs.at(-1)!.elapsedSeconds, 'focus-generation-failed')
        : missingLogs.at(-1)!;
      let answerIndex = 0;
      const answerLogs = missingLogs.map(log => log.role === 'I'
        ? { ...log, id: focusGenerationReplyLogId(failure.id, answerIndex++) } : log);
      await saveChatReplyDelivery({ source: sourceSession, epoch: dataEpoch, failure, logs: answerLogs,
        prepared: null, rawEnvelope: '',
        canCommit: () => sleepTransitionRevisionRef.current === batchSleepRevision,
        beforeSave: async () => {
          const latestSleep = await readFocusSleepSnapshot();
          return currentScene() && !latestSleep.sleeping && latestSleep.sleepKey === batchSleep.sleepKey
            && sleepTransitionRevisionRef.current === batchSleepRevision;
        } });
    } catch (error) {
      console.warn('[focus] timed companion unavailable', error);
    } finally {
      generatingLogRef.current = false;
    }
  };

  const retryFocusRestore = () => {
    if (focusRestoreLoadingRef.current || focusRestoreReadyRef.current) return;
    focusRestoreLoadingRef.current = true;
    setFocusRestoreState('loading');
    setFocusRestoreAttempt(attempt => attempt + 1);
  };

  const startFocus = async () => {
    if (!focusRestoreReadyRef.current) return;
    if (startingRef.current) return;
    const note = [selectedTag?.label, userActivity.trim()].filter(Boolean).join(' · ');
    const normalizedUserActivity = composeActivity(labelForCategory(USER_CATEGORIES, userCategory), note);
    let normalizedBaiyunActivity = mode === 'cowork'
      ? composeActivity(labelForCategory(baiyunCategories, baiyunCategory), baiyunActivity)
      : labelForCategory(baiyunCategories, baiyunCategory);
    if (!note && userCategory !== 'rest') {
      Alert.alert('先写下小仓鼠要做什么', '我想知道要和你守住哪件事。');
      return;
    }
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    const sleepingAtStart = await isFocusSleeping().catch(() => null);
    if (sleepingAtStart === null || startingRef.current || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (sleepingAtStart) normalizedBaiyunActivity = '休息：睡觉';
    const now = Date.now();
    const initialLogs = [makeLog('system', `${modeLabel(mode)}开始了`, 0, 'start')];
    preparationEditedRef.current = true;
    startingRef.current = true;
    let startingSession: ActiveFocusSession | undefined;
    const started = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const initialSession = buildActiveFocusSession({
        reading: undefined,
        baiyunActivity: normalizedBaiyunActivity,
        elapsedSeconds: 0,
        logs: initialLogs,
        paused: false,
        pausedAt: undefined,
        startedAt: now,
        totalPausedMs: 0,
        userActivity: normalizedUserActivity,
        timing: startFocusTiming(now),
        categoryId: userCategory,
        tag: selectedTag,
      });
      startingSession = sleepingAtStart ? initialSession
        : await bindFocusReadingSession(initialSession, readingInviteRef.current, now);
      normalizedBaiyunActivity = startingSession.baiyunActivity;
      readingBindingRef.current = startingSession.reading;
      await saveActiveFocusSession(startingSession);
      await recordGlobalInteraction('focus', now).catch(() => undefined);
    }).catch(async error => {
      const saved = startingSession && canCommitBackupRestoreDataEpoch(dataEpoch)
        ? await recoverFailedFocusReadingStart(startingSession).catch(() => null) : null;
      if (saved) { startingSession = saved; return { committed: true as const, value: undefined }; }
      Alert.alert('无法开始专注', error instanceof Error ? error.message : '阅读记录暂时无法读取。');
      return { committed: false as const };
    }).finally(() => {
      startingRef.current = false;
    });
    if (!started.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    timingRef.current = startingSession?.timing;
    sceneCategoryRef.current = startingSession?.categoryId;
    sceneTagRef.current = startingSession?.tag;
    readingInviteRef.current = {};
    finishingRef.current = false;
    pomodoroKeyRef.current = timerMode === 'pomodoro'
      ? getPomodoroState(0, pomodoroWorkSeconds, pomodoroShortBreakSeconds, pomodoroLongBreakSeconds).key
      : '';
    setStartedAt(now);
    focusStartedAtRef.current = now;
    setEndedAt(0);
    setElapsedSeconds(0);
    setPausedAt(undefined);
    setTotalPausedMs(0);
    setPaused(false);
    setSavedSession(null);
    elapsedSecondsRef.current = 0;
    awakeTimedBaselineRef.current = 0;
    timedCatchUpRef.current = false;
    logsRef.current = initialLogs;
    setUserActivity(normalizedUserActivity);
    setBaiyunActivity(normalizedBaiyunActivity);
    setLogs(initialLogs);
    setHistoryOpen(false);
    setPhase('running');
    const openingCurrent = () => !finishingRef.current && focusStartedAtRef.current === now
      && canCommitBackupRestoreDataEpoch(dataEpoch);
    const openingSleep = await readFocusSleepSnapshot().catch(() => null);
    if (!openingCurrent() || !openingSleep || openingSleep.sleeping !== sleepingAtStart) return;
    observedSleepingRef.current = sleepingAtStart;
    const openingSleepRevision = sleepTransitionRevisionRef.current;
    let openingFailure: FocusGenerationFailure | undefined;
    let openingMemoryUsage: FocusMemoryReceipt | undefined;
    const onOpeningFailure = (reason: FocusGenerationFailure) => { openingFailure = reason; };
    const opening = sleepingAtStart ? await generateFocusSleepLog({
      ...aiOptions, onFailure: onOpeningFailure, kind: 'opening', userActivity: normalizedUserActivity,
    }).catch(error => { openingFailure = classifyFocusGenerationFailure(error, 20_000); return ''; }) : await generateFocusOpening({
      ...aiOptions,
      onFailure: onOpeningFailure,
      baiyunActivity: normalizedBaiyunActivity,
      elapsedSeconds: 0,
      logs: [],
      mode,
      userActivity: normalizedUserActivity,
      memoryRequest: { sessionId: makeFocusSessionId({ startedAt: now, mode, userActivity: normalizedUserActivity }),
        operationId: `focus-opening:${now}`, canCommit: openingCurrent },
      onMemoryPrepared: receipt => { openingMemoryUsage = receipt; },
      openingActivity: startingSession ? focusReadingOpeningActivity(startingSession) : undefined,
      onNextActivity: startingSession?.reading ? async choice => {
        if (!openingCurrent()
          || sleepTransitionRevisionRef.current !== openingSleepRevision || await isFocusSleeping()) return;
        const currentSleep = await readFocusSleepSnapshot();
        if (currentSleep.sleeping || currentSleep.sleepKey !== openingSleep.sleepKey) return;
        await saveFocusNextActivityChoice(makeFocusSessionId(startingSession!), startingSession!.reading!.sourceActivityId, choice, Date.now(), dataEpoch);
      } : undefined,
    }).catch(error => { openingFailure = classifyFocusGenerationFailure(error, 20_000); return ''; });
    const afterOpeningSleep = await readFocusSleepSnapshot().catch(() => null);
    if (!openingCurrent() || !afterOpeningSleep
      || sleepTransitionRevisionRef.current !== openingSleepRevision
      || afterOpeningSleep.sleepKey !== openingSleep.sleepKey || afterOpeningSleep.sleeping !== sleepingAtStart) return;
    if (sleepingAtStart && (!sleepScreenRef.current.active || AppState.currentState !== 'active')) return;
    const openingLog = opening
      ? makeLog('I', opening, 0, sleepingAtStart ? focusSleepLogTrigger('opening') : 'opening')
      : makeLog('system', formatFocusGenerationFailure(openingFailure, FOCUS_GENERATION_FAILURE_TEXT), 0,
        sleepingAtStart ? 'focus-sleep-opening-failed' : 'focus-opening-failed');
    const failure = opening ? makeLog('system', FOCUS_CHAT_SAVE_FAILURE_TEXT, 0,
      sleepingAtStart ? 'focus-sleep-opening-failed' : 'focus-opening-failed') : openingLog;
    const answer = opening ? { ...openingLog, id: sleepingAtStart
      ? `${failure.id}:sleep-opening-retry` : focusGenerationReplyLogId(failure.id, 0) } : openingLog;
    const openingVisible = () => !sleepingAtStart || sleepScreenRef.current.active && AppState.currentState === 'active';
    await saveChatReplyDelivery({ source: { startedAt: now, mode, userActivity: normalizedUserActivity },
      epoch: dataEpoch, failure, logs: [answer], prepared: null, rawEnvelope: '',
      ...(opening ? { memoryUsage: openingMemoryUsage } : {}),
      canCommit: () => sleepTransitionRevisionRef.current === openingSleepRevision && openingVisible(),
      beforeSave: async () => {
        const latestSleep = await readFocusSleepSnapshot();
        return openingCurrent() && openingVisible() && latestSleep.sleeping === sleepingAtStart
          && latestSleep.sleepKey === openingSleep.sleepKey && sleepTransitionRevisionRef.current === openingSleepRevision;
      } });
  };

  const togglePaused = () => {
    const now = Date.now();
    if (paused) {
      timingRef.current = resumeFocusTiming(timingRef.current, now);
      const nextTotalPausedMs = totalPausedMs + (pausedAt ? now - pausedAt : 0);
      setTotalPausedMs(nextTotalPausedMs);
      setPausedAt(undefined);
      setPaused(false);
    } else {
      timingRef.current = pauseFocusTiming(timingRef.current, now);
      const nextElapsedSeconds = Math.max(0, Math.floor((now - startedAt - totalPausedMs) / 1000));
      elapsedSecondsRef.current = nextElapsedSeconds;
      setElapsedSeconds(nextElapsedSeconds);
      setPausedAt(now);
      setPaused(true);
    }
  };

  const sendMessage = async () => {
    const content = draft.trim();
    if (
      !content
      || phase !== 'running'
      || finishingRef.current
      || committingMessageRef.current
    ) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    let occupied = false;
    let savedReply = false;
    let sleepClaim: RuntimeLog[] = [];
    normalFocusReplyCountRef.current += 1;
    committingMessageRef.current = true;
    try {
      const sleeping = await isFocusSleeping();
      await markChatReplyStarted();
      occupied = true;
      const userLog = makeLog('you', content, elapsedSecondsRef.current, focusYouMessageTrigger(sleeping));
      const now = Date.now();
      const userSaved = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        const userLogs = [...logsRef.current, userLog];
        const saved = await saveActiveFocusSession(buildActiveFocusSession({
          elapsedSeconds: elapsedSecondsRef.current,
          logs: userLogs,
        }));
        if (!saved || finishingRef.current || focusStartedAtRef.current !== startedAt) return null;
        await recordGlobalInteraction('focus', now).catch(() => undefined);
        if (finishingRef.current || focusStartedAtRef.current !== startedAt
          || !canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
        const current = logsRef.current;
        const committedLogs = [...current, ...saved.logs.filter(log => !current.some(item => item.id === log.id))];
        logsRef.current = committedLogs;
        return committedLogs;
      }).finally(() => {
        committingMessageRef.current = false;
      });
      if (
        !userSaved.committed
        || !userSaved.value
        || finishingRef.current
        || focusStartedAtRef.current !== startedAt
        || !canCommitBackupRestoreDataEpoch(dataEpoch)
      ) return;
      if (draftRef.current.trim() === content) handleDraftChange('');
      setLogs(logsRef.current);
      if (sleeping) {
        focusReplyWaitRef.current!.cancel();
        return;
      }
      const ready = await focusReplyWaitRef.current!.wait();
      if (!ready || finishingRef.current || focusStartedAtRef.current !== startedAt
        || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const sleepingBeforeReply = await isFocusSleeping();
      if (sleepingBeforeReply || finishingRef.current || focusStartedAtRef.current !== startedAt
        || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const requestLogs = [...logsRef.current];
      const sleepSelection = selectFocusSleepReplySources(requestLogs);
      const claimed = new Set(sleepReplyRuntimeRef.current?.claimedSourceIds() ?? []);
      const candidates = sleepSelection.blocked || claimed.size ? [] : sleepSelection.pending;
      const sleepReplySources = candidates.length && sleepReplyRuntimeRef.current?.claimSources(candidates) ? candidates : [];
      sleepClaim = sleepReplySources;
      const firstSleepSource = sleepReplySources.length ? requestLogs.findIndex(log => log.id === sleepReplySources[0].id) : -1;
      const focusSessionId = makeFocusSessionId({ startedAt, mode, userActivity });
      const preparedTurn = await prepareJunluoFocusChatTurn({
        logs: requestLogs,
        sessionId: focusSessionId,
        youMessage: userLog,
        ...(sleepReplySources.length ? { youMessages: requestLogs.slice(firstSleepSource).filter(log => log.role === 'you') } : {}),
      }).catch(() => null);
      if (await isFocusSleeping() || finishingRef.current || focusStartedAtRef.current !== startedAt
        || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const reply = await generateFocusReply({
        ...chatAiOptions,
        baiyunActivity: effectiveBaiyunActivity,
        elapsedSeconds: elapsedSecondsRef.current,
        fixedResponseInstruction: preparedTurn?.responseInstruction,
        logs: requestLogs,
        mode,
        userActivity,
        userMessage: content,
        ...(!sleepReplySources.length ? { memoryRequest: { sessionId: focusSessionId,
          operationId: userLog.id, canCommit: () => !finishingRef.current && focusStartedAtRef.current === startedAt
            && canCommitBackupRestoreDataEpoch(dataEpoch) } } : {}),
        ...(sleepReplySources.length ? { sleepReplySources } : {}),
        canStartRequest: async () => !await isFocusSleeping() && !finishingRef.current
          && focusStartedAtRef.current === startedAt && canCommitBackupRestoreDataEpoch(dataEpoch),
      }).catch(focusReplyGenerationFailure);
      if ('cancelled' in reply && reply.cancelled) return;
      if (sleepReplySources.length) sleepReplyRuntimeRef.current?.noteAttempt(sleepReplySources);
      if (finishingRef.current || focusStartedAtRef.current !== startedAt
        || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const replyLogs = reply.contents.length
        ? reply.contents.map((message) => makeLog('I', message, elapsedSecondsRef.current, sleepReplySources.length ? 'focus-sleep-reply' : 'chat-reply'))
        : [makeLog('system', formatFocusGenerationFailure(reply.failure, FOCUS_GENERATION_FAILURE_TEXT), elapsedSecondsRef.current,
          sleepReplySources.length ? 'focus-sleep-reply-failed' : 'focus-chat-failed')];
      if (reply.contents.length && !sleepReplySources.length) {
        const failure = makeLog('system', FOCUS_CHAT_SAVE_FAILURE_TEXT, elapsedSecondsRef.current, 'focus-chat-save-failed');
        const answerLogs = replyLogs.map((log, index) => ({ ...log, id: focusChatReplyLogId(failure.id, index) }));
        savedReply = await saveChatReplyDelivery({ source: { startedAt, mode, userActivity }, epoch: dataEpoch,
          failure, logs: answerLogs, prepared: preparedTurn, rawEnvelope: reply.rawEnvelope,
          memoryUsage: 'memoryUsage' in reply ? reply.memoryUsage : undefined });
        return;
      }
      const sleepReceipts = reply.contents.length && sleepReplySources.length
        ? makeFocusSleepReplyReceipts(sleepReplySources, replyLogs) : [];
      const replySaved = sleepReplySources.length ? { committed: true as const,
        value: await sleepReplyRuntimeRef.current!.deliver({
          session: buildActiveFocusSession(), epoch: dataEpoch, sources: sleepReplySources,
          reply: { ...reply, prepared: preparedTurn }, logs: [...replyLogs, ...sleepReceipts],
        }) ? logsRef.current : null,
      } : await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        if (finishingRef.current || focusStartedAtRef.current !== startedAt) return null;
        const finalLogs = [...logsRef.current, ...replyLogs, ...sleepReceipts];
        const saved = await saveActiveFocusSession(buildActiveFocusSession({
          elapsedSeconds: elapsedSecondsRef.current,
          logs: finalLogs,
        }));
        if (!saved || finishingRef.current || focusStartedAtRef.current !== startedAt) return null;
        const current = logsRef.current;
        const committedLogs = [...current, ...saved.logs.filter(log => !current.some(item => item.id === log.id))];
        logsRef.current = committedLogs;
        return committedLogs;
      });
      if (
        !replySaved.committed
        || !replySaved.value
        || finishingRef.current
        || focusStartedAtRef.current !== startedAt
        || !canCommitBackupRestoreDataEpoch(dataEpoch)
      ) return;
      setLogs(logsRef.current);
      savedReply = reply.contents.length > 0;
    } finally {
      sleepReplyRuntimeRef.current?.releaseSources(sleepClaim, startedAt, dataEpoch);
      normalFocusReplyCountRef.current -= 1;
      if (!occupied) committingMessageRef.current = false;
      if (occupied) await markChatReplyFinished(savedReply ? 'finished' : 'aborted', {
        persist: canCommitBackupRestoreDataEpoch(dataEpoch),
      }).catch(() => undefined);
      if (savedReply && mode === 'cowork' && !finishingRef.current && canCommitBackupRestoreDataEpoch(dataEpoch)) {
        void runAssistantAffectUpdate().catch(() => undefined);
      }
      void sleepReplyRuntimeRef.current?.tick();
    }
  };

  const finishFocus = async () => {
    if (finishingRef.current || phase !== 'running' || savedSession) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    const finishCurrent = () => focusStartedAtRef.current === startedAt && canCommitBackupRestoreDataEpoch(dataEpoch);
    if (!finishCurrent()) return;
    finishingRef.current = true;
    const finishedAt = Date.now();
    const limit = timerMode === 'countdown' ? targetSeconds
      : timerMode === 'pomodoro' ? pomodoroCompletionSeconds : undefined;
    const durationSeconds = Math.max(1, Math.min(elapsedSecondsRef.current, limit ?? Infinity));
    // New evidence uses the actual finish instant, including a sub-second last run.
    // Countdown/pomodoro limits are applied to spans, not to the frozen display timer.
    const sessionEndedAt = timingRef.current ? finishedAt
      : Math.min(finishedAt, startedAt + totalPausedMs + durationSeconds * 1000);
    const spans = finishFocusTiming(timingRef.current, sessionEndedAt, buildActiveFocusSession());
    const review = spans ? { version: 1 as const,
      categoryId: sceneCategoryRef.current ?? focusCategoryFromActivity(userActivity),
      tag: sceneTagRef.current, spans } : undefined;
    let finished:
      | { committed: false }
      | { committed: true; value: { finalLogs: RuntimeLog[]; session: FocusSession } }
      | undefined;
    let completedNow = false;
    try {
      const finalLog = makeLog('system', '学习结束', durationSeconds, 'finish', sessionEndedAt);
      const sessionId = makeFocusSessionId({ startedAt, mode, userActivity: userActivity.trim() });
      const once = await executeFocusTimerCompletionOnce({
        sessionId,
        startedAt,
      }, {
        reconcileLocally: async () => {
          const existing = await loadFocusSessionById(sessionId);
          if (!finishCurrent()) throw new Error('focus-timer-source-changed');
          return existing ? 'completed' : null;
        },
        executeLocally: async () => {
          finished = await runBackupRestoreDataEpochCommit(
            dataEpoch,
            async () => {
              // A reply may be in the raw journal while its auxiliary save hook is still pending.
              const activeAtFinish = await loadActiveFocusSession(true);
              if (!finishCurrent()) throw new Error('focus-timer-source-changed');
              const storedLogs = activeAtFinish && makeFocusSessionId(activeAtFinish) === sessionId
                ? activeAtFinish.logs : [];
              const finalLogs = [...logsRef.current,
                ...storedLogs.filter(log => !logsRef.current.some(old => old.id === log.id)), finalLog];
              const session = await saveFocusSession({
                baiyunActivity: effectiveBaiyunActivity.trim(),
                durationSeconds,
                endedAt: sessionEndedAt,
                heartRateAvg: 0,
                logs: finalLogs,
                mode,
                startedAt,
                temperatureAvg: 0,
                userActivity: userActivity.trim(),
                review,
              });
              if (!finishCurrent()) throw new Error('focus-timer-source-changed');
              await clearActiveFocusSession(sessionId);
              if (!finishCurrent()) throw new Error('focus-timer-source-changed');
              await recordGlobalInteraction('focus', finishedAt)
                .catch(() => undefined);
              return { finalLogs, session };
            },
          );
          if (!finished.committed) {
            throw new Error('focus-timer-data-epoch-changed');
          }
          return 'completed' as const;
        },
        applyReceipt: async (outcome) => {
          if (outcome !== 'completed') return;
          if (!finishCurrent()) throw new Error('focus-timer-source-changed');
          const cleared = await runBackupRestoreDataEpochCommit(
            dataEpoch,
            () => clearActiveFocusSession(sessionId),
          );
          if (!cleared.committed || !finishCurrent()) {
            throw new Error('focus-timer-receipt-data-epoch-changed');
          }
        },
      });
      if (!finishCurrent()) return;
      if (once.outcome !== 'completed') {
        finishingRef.current = false;
        return;
      }
      completedNow = once.executedNow;
      if (!once.executedNow) {
        // Local history may already be saved even when the previous cleanup failed.
        finished = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
          const session = await loadFocusSessionById(sessionId);
          if (!finishCurrent() || !session || session.id !== sessionId) throw new Error('focus-timer-history-unavailable');
          const finalLogs = await loadFocusLogs(session.id);
          if (!finishCurrent()) throw new Error('focus-timer-source-changed');
          return { session, finalLogs };
        });
      }
    } catch {
      if (!finishCurrent()) return;
      finishingRef.current = false;
      timingRef.current = pauseFocusTiming(timingRef.current, finishedAt);
      if (!paused) setPausedAt(finishedAt);
      setPaused(true);
      Alert.alert('专注暂未结束', '专注收尾未完成。请再次点击“结束”；已有记录会先核对，不会重复保存。');
      return;
    }
    if (!finished?.committed || !finishCurrent()) {
      if (finishCurrent()) finishingRef.current = false;
      return;
    }
    const { finalLogs, session } = finished.value;
    logsRef.current = finalLogs;
    focusReplyWaitRef.current?.cancel();
    setPaused(true);
    setLogs(finalLogs);
    setEndedAt(session.endedAt);
    setSavedSession(session);
    setReviewOnly(false);
    setPhase('summary');
    if (mode === 'cowork' && completedNow) void runAssistantAffectUpdate().catch(() => undefined);
    if (memoryOrganizerConnection && memoryOrganizerKey.trim()) {
      void organizeFocusSession({ sessionId: session.id, apiKey: memoryOrganizerKey,
        connection: memoryOrganizerConnection, dataEpoch }).catch(() => undefined);
    }
    const recentReadVersion = ++recentSessionsReadRef.current.version;
    void runBackupRestoreDataEpochCommit(dataEpoch, loadRecentFocusSessions)
      .then((recent) => {
        if (recent.committed && canCommitBackupRestoreDataEpoch(dataEpoch)
          && recentSessionsReadRef.current.mounted && recentReadVersion === recentSessionsReadRef.current.version) {
          setRecentSessions(recent.value);
        }
      })
      .catch(() => undefined);
  };

  const resetFocus = async () => {
    if (resettingFocusRef.current || !savedSession) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    const sourceStartedAt = focusStartedAtRef.current;
    resettingFocusRef.current = true;
    const cleared = await runBackupRestoreDataEpochCommit(
      dataEpoch,
      () => clearActiveFocusSession(savedSession.id),
    ).finally(() => { resettingFocusRef.current = false; });
    if (!cleared.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)
      || focusStartedAtRef.current !== sourceStartedAt) return;
    focusReplyWaitRef.current?.cancel();
    focusStartedAtRef.current = 0;
    finishingRef.current = false;
    pomodoroKeyRef.current = '';
    if (savedSession) {
      const parsedUser = splitActivityText(USER_CATEGORIES, savedSession.userActivity, userCategory);
      const parsedBaiyun = splitActivityText(
        mode === 'cowork' ? BAIYUN_CATEGORIES : BAIYUN_SUPPORT_CATEGORIES,
        savedSession.baiyunActivity,
        inferBaiyunCategory(savedSession.baiyunActivity, mode),
      );
      setUserCategory(parsedUser.categoryId);
      setUserActivity(focusNoteWithoutTag(parsedUser.note, savedSession.review?.tag));
      if (parsedUser.categoryId === 'rest') setTimerMode('stopwatch');
      setBaiyunCategory(parsedBaiyun.categoryId);
      setBaiyunActivity(mode === 'cowork' ? parsedBaiyun.note : savedSession.baiyunActivity);
    }
    setPhase('prepare');
    elapsedSecondsRef.current = 0;
    logsRef.current = [];
    setElapsedSeconds(0);
    setLogs([]);
    handleDraftChange('');
    setSavedSession(null);
    setSelectedTag(undefined);
    timingRef.current = undefined;
    sceneCategoryRef.current = undefined;
    sceneTagRef.current = undefined;
  };

  const confirmDeleteSession = (session: FocusSession) => {
    Alert.alert('删除这条专注记录吗？', '功能测试留下的记录可以从这里清掉。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          const dataEpoch = captureBackupRestoreDataEpoch();
          if (dataEpoch === null) return;
          let deleteCommitted = false;
          let recentReadVersion = 0;
          void (async () => {
            const deleted = await runBackupRestoreDataEpochCommit(dataEpoch, () => deleteFocusSession(session.id));
            if (!deleted.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)
              || !recentSessionsReadRef.current.mounted) return;
            deleteCommitted = true;
            recentReadVersion = ++recentSessionsReadRef.current.version;
            setRecentSessions(current => current.filter(record => record.id !== session.id));
            const recent = await runBackupRestoreDataEpochCommit(dataEpoch, loadRecentFocusSessions);
            if (recent.committed && canCommitBackupRestoreDataEpoch(dataEpoch)
              && recentSessionsReadRef.current.mounted && recentReadVersion === recentSessionsReadRef.current.version) {
              setRecentSessions(recent.value);
            }
          })().catch(() => {
            if (!recentSessionsReadRef.current.mounted || !sleepScreenRef.current.active
              || sleepScreenRef.current.phase !== 'prepare' || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
            if (deleteCommitted && recentReadVersion !== recentSessionsReadRef.current.version) return;
            Alert.alert(deleteCommitted ? '专注记录已删除' : '专注记录删除失败',
              deleteCommitted ? '最近记录暂未刷新。' : '请重试。');
          });
        },
      },
    ]);
  };

  const exitToHome = async () => {
    if (phase === 'running' && !finishingRef.current) {
      const dataEpoch = captureBackupRestoreDataEpoch();
      if (dataEpoch === null) return;
      const saved = await runBackupRestoreDataEpochCommit(dataEpoch, () => (
        saveActiveFocusSession(buildActiveFocusSession({
          elapsedSeconds: elapsedSecondsRef.current,
          logs: logsRef.current,
        }))
      ));
      if (!saved.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      navigate('home');
      return;
    }
    navigate('home');
  };

  const retryFocusGeneration = async (failedLog: RuntimeLog) => {
    if (generatingLogRef.current || finishingRef.current || phase !== 'running') return;
    if (isFocusGenerationFailureResolved(failedLog, logsRef.current)) return;
    if (failedLog.trigger === 'focus-sleep-reply-failed') {
      await sleepReplyRuntimeRef.current?.retry();
      return;
    }
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    const retryCurrent = () => !finishingRef.current && focusStartedAtRef.current === startedAt
      && canCommitBackupRestoreDataEpoch(dataEpoch);
    if (!retryCurrent()) return;
    generatingLogRef.current = true;
    let occupied = false;
    let savedReply = false;
    try {
      const chatFailure = isFocusChatFailure(failedLog);
      const pendingDelivery = pendingChatDeliveriesRef.current.get(failedLog.id);
      if (pendingDelivery) {
        if (!chatFailure && await isFocusSleeping() !== (failedLog.trigger === 'focus-sleep-opening-failed')) return;
        if (chatFailure) { await markChatReplyStarted(); occupied = true; }
        const persisted = await saveChatReplyDelivery(pendingDelivery);
        savedReply = chatFailure && persisted;
        return;
      }
      // With no page-local answer after restart, use the existing current-history generation path.
      if (chatFailure) {
        if (await isFocusSleeping() || finishingRef.current || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        await markChatReplyStarted();
        occupied = true;
      }
      const contextLogs = logsRef.current.filter((log) => log.id !== failedLog.id);
      let replacementContents: string[] = [];
      let retryPreparedTurn: Awaited<ReturnType<typeof prepareJunluoFocusChatTurn>> | null = null;
      let retryRawEnvelope = '';
      let retryMemoryUsage: FocusMemoryReceipt | undefined;
      let retryFailure: FocusGenerationFailure | undefined;
      const retryAiOptions = { ...aiOptions, onFailure: (reason: FocusGenerationFailure) => { retryFailure = reason; } };
      const onRetryException = (error: unknown) => { retryFailure = classifyFocusGenerationFailure(error, 20_000); return ''; };
      const retrySleep = !chatFailure ? await readFocusSleepSnapshot() : null;
      const retrySleepRevision = retrySleep ? sleepTransitionRevisionRef.current : 0;
      if (failedLog.trigger === 'focus-sleep-opening-failed') {
        if (contextLogs.some(log => log.id === `${failedLog.id}:sleep-opening-retry`)) return;
        if (!sleepScreenRef.current.active || AppState.currentState !== 'active') return;
        if (!await isFocusSleeping()) return;
        const message = await generateFocusSleepLog({ ...retryAiOptions, kind: 'opening', userActivity }).catch(onRetryException);
        if (!await isFocusSleeping()) return;
        if (message) replacementContents = [message];
      } else if (failedLog.trigger === 'focus-opening-failed') {
        if (await isFocusSleeping()) return;
        const openingSession = await loadActiveFocusSession(true).catch(() => null);
        const sessionId = makeFocusSessionId({ startedAt, mode, userActivity });
        if (!retryCurrent() || !openingSession || makeFocusSessionId(openingSession) !== sessionId) return;
        const openingActivity = openingSession.reading ? focusReadingRetryOpeningActivity(openingSession) : undefined;
        const reading = openingActivity ? openingSession.reading : undefined;
        const message = await generateFocusOpening({
          ...retryAiOptions,
          baiyunActivity: reading ? openingSession.baiyunActivity : effectiveBaiyunActivity,
          elapsedSeconds: 0,
          logs: contextLogs,
          mode,
          userActivity,
          openingActivity,
          memoryRequest: { sessionId, operationId: failedLog.id, canCommit: retryCurrent },
          onMemoryPrepared: receipt => { retryMemoryUsage = receipt; },
          onNextActivity: reading ? async choice => {
            if (!retryCurrent() || sleepTransitionRevisionRef.current !== retrySleepRevision) return;
            const currentSleep = await readFocusSleepSnapshot();
            if (currentSleep.sleeping || currentSleep.sleepKey !== retrySleep?.sleepKey
              || !retryCurrent() || sleepTransitionRevisionRef.current !== retrySleepRevision) return;
            await saveFocusNextActivityChoice(sessionId, reading.sourceActivityId, choice, Date.now(), dataEpoch, latest =>
              retryCurrent() && sleepTransitionRevisionRef.current === retrySleepRevision
              && latest.reading?.sourceOperationId === reading.sourceOperationId
              && latest.reading.bookId === reading.bookId
              && latest.reading.originalRemainingMs === reading.originalRemainingMs
              && latest.reading.boundWorkMs === reading.boundWorkMs
              && latest.baiyunActivity === openingSession.baiyunActivity
              && focusReadingRetryOpeningActivity(latest)?.focusMinutes === openingActivity?.focusMinutes);
          } : undefined,
        }).catch(onRetryException);
        if (await isFocusSleeping()) return;
        if (message) replacementContents = [message];
      } else if (failedLog.trigger === 'focus-generation-failed') {
        if (await isFocusSleeping()) return;
        const message = await generateFocusLog({
          ...retryAiOptions,
          baiyunActivity: effectiveBaiyunActivity,
          elapsedSeconds: failedLog.elapsedSeconds,
          logs: contextLogs,
          mode,
          userActivity,
        }).catch(onRetryException);
        if (await isFocusSleeping()) return;
        if (message) replacementContents = [message];
      } else if (chatFailure) {
        const lastYouMessage = [...contextLogs].reverse().find((log) => log.role === 'you' && !isFocusSleepMessage(log));
        if (lastYouMessage) {
          retryPreparedTurn = await prepareJunluoFocusChatTurn({
            logs: contextLogs,
            sessionId: makeFocusSessionId({ startedAt, mode, userActivity }),
            youMessage: lastYouMessage,
          }).catch(() => null);
          if (await isFocusSleeping() || finishingRef.current || focusStartedAtRef.current !== startedAt
            || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
          const reply = await generateFocusReply({
            ...chatAiOptions,
            baiyunActivity: effectiveBaiyunActivity,
            elapsedSeconds: failedLog.elapsedSeconds,
            fixedResponseInstruction: retryPreparedTurn?.responseInstruction,
            logs: contextLogs,
            mode,
            userActivity,
            userMessage: lastYouMessage.content,
            memoryRequest: { sessionId: makeFocusSessionId({ startedAt, mode, userActivity }),
              operationId: lastYouMessage.id, canCommit: retryCurrent },
            canStartRequest: async () => retryCurrent() && !await isFocusSleeping(),
          }).catch(focusReplyGenerationFailure);
          replacementContents = reply.contents;
          retryRawEnvelope = reply.rawEnvelope;
          retryFailure = reply.failure;
          retryMemoryUsage = 'memoryUsage' in reply ? reply.memoryUsage : undefined;
        }
      }
      if (!retryCurrent()) return;
      if (!replacementContents.length) {
        if (!retryFailure) return;
        if (failedLog.trigger === 'focus-sleep-opening-failed'
          && (!sleepScreenRef.current.active || AppState.currentState !== 'active')) return;
        if (retrySleep) {
          const currentSleep = await readFocusSleepSnapshot();
          if (currentSleep.sleeping !== retrySleep.sleeping || currentSleep.sleepKey !== retrySleep.sleepKey
            || sleepTransitionRevisionRef.current !== retrySleepRevision) return;
        }
        const actual = await updateActiveFocusFailureReason(makeFocusSessionId({ startedAt, mode, userActivity }), failedLog.id,
          formatFocusGenerationFailure(retryFailure, FOCUS_GENERATION_FAILURE_TEXT),
          () => retryCurrent() && (!retrySleep || sleepTransitionRevisionRef.current === retrySleepRevision), dataEpoch).catch(() => null);
        if (actual && retryCurrent()) {
          const updatedFailure = actual.logs.find(log => log.id === failedLog.id);
          const current = logsRef.current;
          const merged = current.map(log => log.id === failedLog.id ? updatedFailure ?? log : log);
          merged.push(...actual.logs.filter(log => !current.some(old => old.id === log.id)));
          logsRef.current = merged;
          setLogs(merged);
        }
        return;
      }
      if (chatFailure) {
        if (focusStartedAtRef.current !== startedAt) return;
        const answerLogs = replacementContents.map((content, index) => ({
          ...makeLog('I', content, failedLog.elapsedSeconds, 'chat-reply'), id: focusChatReplyLogId(failedLog.id, index),
        }));
        savedReply = await saveChatReplyDelivery({ source: { startedAt, mode, userActivity }, epoch: dataEpoch,
          failure: failedLog, logs: answerLogs, prepared: retryPreparedTurn, rawEnvelope: retryRawEnvelope,
          memoryUsage: retryMemoryUsage });
        return;
      }
      if (failedLog.trigger === 'focus-sleep-opening-failed'
        && (!sleepScreenRef.current.active || AppState.currentState !== 'active')) return;
      if (retrySleep) {
        const currentSleep = await readFocusSleepSnapshot();
        if (currentSleep.sleeping !== retrySleep.sleeping || currentSleep.sleepKey !== retrySleep.sleepKey
          || sleepTransitionRevisionRef.current !== retrySleepRevision) return;
      }
      if (failedLog.trigger === 'focus-opening-failed' || failedLog.trigger === 'focus-generation-failed'
        || failedLog.trigger === 'focus-sleep-opening-failed') {
        if (!retryCurrent() || !logsRef.current.some(log => log.id === failedLog.id)) return;
        const asleepOpening = failedLog.trigger === 'focus-sleep-opening-failed';
        const trigger = asleepOpening ? focusSleepLogTrigger('opening')
          : failedLog.trigger === 'focus-opening-failed' ? 'opening' : 'timed-log';
        const answerLogs = replacementContents.map((content, index) => ({
          ...makeLog('I', content, failedLog.elapsedSeconds, trigger), id: asleepOpening
            ? `${failedLog.id}:sleep-opening-retry` : focusGenerationReplyLogId(failedLog.id, index),
        }));
        await saveChatReplyDelivery({ source: { startedAt, mode, userActivity }, epoch: dataEpoch,
          failure: failedLog, logs: answerLogs, prepared: null, rawEnvelope: '',
          memoryUsage: retryMemoryUsage,
          canCommit: () => sleepTransitionRevisionRef.current === retrySleepRevision
            && (!asleepOpening || sleepScreenRef.current.active && AppState.currentState === 'active'),
          beforeSave: async () => {
            const latestSleep = await readFocusSleepSnapshot();
            return retryCurrent() && latestSleep.sleeping === asleepOpening && latestSleep.sleepKey === retrySleep?.sleepKey
              && sleepTransitionRevisionRef.current === retrySleepRevision
              && (!asleepOpening || sleepScreenRef.current.active && AppState.currentState === 'active');
          } });
        return;
      }
    } finally {
      generatingLogRef.current = false;
      if (occupied) await markChatReplyFinished(savedReply ? 'finished' : 'aborted', {
        persist: canCommitBackupRestoreDataEpoch(dataEpoch),
      }).catch(() => undefined);
      if (savedReply && mode === 'cowork' && !finishingRef.current && canCommitBackupRestoreDataEpoch(dataEpoch)) {
        void runAssistantAffectUpdate().catch(() => undefined);
      }
    }
  };

  return (
    <BackgroundSurface
      active={active}
      settings={backgroundSettings}
      skyTheme={skyTheme}
      weatherKind={weatherKind}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : phase === 'prepare' ? undefined : 'height'}
        enabled={Platform.OS === 'ios' || phase !== 'prepare'}
        style={[styles.root, { paddingTop: insets.top + 10 }]}
      >
      <View style={styles.header}>
        <Pressable onPress={() => historyOpen ? setHistoryOpen(false) : void exitToHome()} style={styles.closeButton}>
          <Text style={styles.closeText}>×</Text>
        </Pressable>
        {historyOpen ? <Text style={styles.headerTitle}>专注回顾</Text> : <Text style={styles.headerTitle}>一起专注</Text>}
        {phase === 'running' ? (
          <Pressable onPress={() => Alert.alert('结束这次专注吗？', '结束后会生成这次总结。', [
            { text: '继续专注', style: 'cancel' },
            { text: '结束', style: 'destructive', onPress: () => void finishFocus() },
          ])} style={styles.endButton}>
            <Text style={styles.endButtonText}>结束</Text>
          </Pressable>
        ) : <View style={styles.headerPlaceholder} />}
      </View>

      {phase === 'prepare' && historyOpen ? <FocusHistoryReview active={active} apiKey={memoryOrganizerKey} connection={memoryOrganizerConnection} /> : null}
      {phase === 'prepare' && !historyOpen ? (
        <ScrollView contentContainerStyle={styles.prepareContent} keyboardShouldPersistTaps="handled">
          <View style={styles.modeSwitch}>
            {(['cowork', 'support'] as FocusMode[]).map((item) => (
              <Pressable key={item} onPress={() => { preparationEditedRef.current = true; setMode(item); }} style={[styles.modeButton, mode === item ? styles.modeButtonActive : null]}>
                <Text style={[styles.modeText, mode === item ? styles.modeTextActive : null]}>{modeLabel(item)}</Text>
              </Pressable>
            ))}
          </View>

          {userCategory !== 'rest' ? <View style={styles.timerModeBlock}>
            <Text style={styles.prepareLabel}>计时方式</Text>
            <View style={styles.timerModeRow}>
              {([
                ['pomodoro', '番茄钟'],
                ['countdown', '倒计时'],
                ['stopwatch', '正计时'],
              ] as Array<[FocusTimerMode, string]>).map(([value, label]) => (
                <Pressable
                  key={value}
                  onPress={() => setTimerMode(value)}
                  style={[styles.timerModeButton, timerMode === value ? styles.timerModeButtonActive : null]}
                >
                  <Text style={[styles.timerModeText, timerMode === value ? styles.timerModeTextActive : null]}>{label}</Text>
                </Pressable>
              ))}
            </View>
            {timerMode === 'pomodoro' ? (
              <View style={styles.pomodoroGrid}>
                <View style={styles.pomodoroField}>
                  <Text style={styles.pomodoroFieldLabel}>专注</Text>
                  <TextInput
                    keyboardType="number-pad"
                    onChangeText={(value) => setPomodoroWorkMinutes(value.replace(/[^\d]/g, '').slice(0, 3))}
                    style={styles.pomodoroInput}
                    underlineColorAndroid="transparent"
                    value={pomodoroWorkMinutes}
                  />
                  <Text style={styles.pomodoroFieldUnit}>分钟</Text>
                </View>
                <View style={styles.pomodoroField}>
                  <Text style={styles.pomodoroFieldLabel}>番茄</Text>
                  <TextInput
                    keyboardType="number-pad"
                    onChangeText={(value) => setPomodoroGoal(value.replace(/[^\d]/g, '').slice(0, 2))}
                    style={styles.pomodoroInput}
                    underlineColorAndroid="transparent"
                    value={pomodoroGoal}
                  />
                  <Text style={styles.pomodoroFieldUnit}>个</Text>
                </View>
                <View style={styles.pomodoroField}>
                  <Text style={styles.pomodoroFieldLabel}>短休</Text>
                  <TextInput
                    keyboardType="number-pad"
                    onChangeText={(value) => setPomodoroShortBreakMinutes(value.replace(/[^\d]/g, '').slice(0, 3))}
                    style={styles.pomodoroInput}
                    underlineColorAndroid="transparent"
                    value={pomodoroShortBreakMinutes}
                  />
                  <Text style={styles.pomodoroFieldUnit}>分钟</Text>
                </View>
                <View style={styles.pomodoroField}>
                  <Text style={styles.pomodoroFieldLabel}>长休</Text>
                  <TextInput
                    keyboardType="number-pad"
                    onChangeText={(value) => setPomodoroLongBreakMinutes(value.replace(/[^\d]/g, '').slice(0, 3))}
                    style={styles.pomodoroInput}
                    underlineColorAndroid="transparent"
                    value={pomodoroLongBreakMinutes}
                  />
                  <Text style={styles.pomodoroFieldUnit}>分钟</Text>
                </View>
              </View>
            ) : null}
            {timerMode === 'countdown' ? (
              <View style={styles.minutesRow}>
                {['15', '25', '45'].map((minutes) => (
                  <Pressable key={minutes} onPress={() => setTargetMinutes(minutes)} style={[styles.minuteChip, targetMinutes === minutes ? styles.minuteChipActive : null]}>
                    <Text style={[styles.minuteChipText, targetMinutes === minutes ? styles.minuteChipTextActive : null]}>{minutes} 分钟</Text>
                  </Pressable>
                ))}
                <TextInput
                  keyboardType="number-pad"
                  onChangeText={(value) => setTargetMinutes(value.replace(/[^\d]/g, '').slice(0, 3))}
                  placeholder="自定"
                  placeholderTextColor="rgba(56,64,82,0.42)"
                  style={styles.minuteInput}
                  underlineColorAndroid="transparent"
                  value={targetMinutes}
                />
              </View>
            ) : null}
          </View> : null}

          <View style={styles.notePair}>
            <View style={[styles.noteCard, mode === 'support' ? styles.supportNoteCard : null]}>
              <Text style={styles.noteLabel}>小仓鼠现在要——</Text>
              <View style={styles.categoryGrid}>
                {USER_CATEGORIES.map((category) => (
                  <Pressable
                    key={category.id}
                    onPress={() => { setUserCategory(category.id); setSelectedTag(undefined); if (category.id === 'rest') setTimerMode('stopwatch'); }}
                    style={[styles.categoryChip, userCategory === category.id ? styles.userCategoryChipActive : null]}
                  >
                    <Text style={[styles.categoryChipText, userCategory === category.id ? styles.userCategoryChipTextActive : null]}>{category.label}</Text>
                  </Pressable>
                ))}
              </View>
              <FocusTagPicker categoryId={userCategory} selected={selectedTag} onSelect={setSelectedTag} />
              <TextInput
                multiline
                onChangeText={setUserActivity}
                placeholder="本次备注"
                placeholderTextColor="rgba(56,64,82,0.42)"
                style={styles.noteInput}
                underlineColorAndroid="transparent"
                value={userActivity}
              />
            </View>
            <View style={[styles.noteCard, mode === 'support' ? styles.supportNoteCard : null]}>
              <View style={styles.noteHeader}>
                <Text style={styles.noteLabel}>{mode === 'cowork' ? '我现在要——' : '我这边想'}</Text>
              </View>
              <View style={styles.categoryGrid}>
                {displayedBaiyunCategories.map((category) => (
                  <Pressable
                    disabled={sleeping}
                    key={category.id}
                    onPress={() => { preparationEditedRef.current = true; setBaiyunCategory(category.id); }}
                    style={[styles.categoryChip, (sleeping || baiyunCategory === category.id) ? styles.categoryChipActive : null]}
                  >
                    <Text style={[styles.categoryChipText, (sleeping || baiyunCategory === category.id) ? styles.categoryChipTextActive : null]}>{category.label}</Text>
                  </Pressable>
                ))}
              </View>
              {mode === 'cowork' || sleeping ? (
                <TextInput
                  editable={!sleeping}
                  multiline
                  onChangeText={(value) => { preparationEditedRef.current = true; setBaiyunActivity(value); }}
                  placeholder="备注"
                  placeholderTextColor="rgba(56,64,82,0.42)"
                  style={styles.noteInput}
                  underlineColorAndroid="transparent"
                  value={sleeping ? '睡觉' : baiyunActivity}
                />
              ) : null}
            </View>
          </View>

          <Pressable disabled={focusRestoreState === 'loading'}
            onPress={() => focusRestoreState === 'failed' ? retryFocusRestore() : void startFocus()} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>{focusRestoreState === 'loading' ? '读取专注记录中…'
              : focusRestoreState === 'failed' ? '重试读取专注记录' : '一起开始'}</Text>
          </Pressable>

          <FocusReviewEntrance active={active} onSelect={(session, savedLogs) => {
            setMode(session.mode); setSavedSession(session); setEndedAt(session.endedAt);
            setLogs(savedLogs); setReviewOnly(true); setPhase('summary');
          }} />

          <View style={styles.historyBlock}>
            <Pressable accessibilityRole="button" onPress={() => setHistoryOpen(true)} style={styles.historyItem}>
              <Text style={styles.historyTitle}>专注回顾</Text>
              <Text style={styles.historyMeta}>日／周／月／年 · 时间占比 · 历史日志</Text>
            </Pressable>
            <Text style={styles.sectionTitle}>最近专注</Text>
            {recentSessions.length ? recentSessions.slice(0, 4).map((session) => (
              <Pressable key={session.id} onLongPress={() => confirmDeleteSession(session)} style={styles.historyItem}>
                <Text style={styles.historyTitle}>{session.userActivity}</Text>
                <Text style={styles.historyMeta}>
                  {formatDate(session.startedAt)} · {Math.floor(session.durationSeconds / 60)} 分钟
                </Text>
              </Pressable>
            )) : <Text style={styles.emptyText}>还没有专注记录，今天可以留下第一条。</Text>}
            {recentSessions.length ? <Text style={styles.historyHint}>长按记录可删除</Text> : null}
          </View>
        </ScrollView>
      ) : null}

      {phase === 'running' ? (
        <ScrollView
          ref={runningScrollRef}
          style={styles.runningViewport}
          contentContainerStyle={[styles.runningContent, { paddingBottom: 20 + insets.bottom }]}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          onLayout={keepComposerVisible}
          onContentSizeChange={keepComposerVisible}
        >
          <View style={styles.timerBlock}>
            <Text style={styles.timer}>{formatDuration(displayedSeconds)}</Text>
            <Text style={styles.modeLine}>
              {modeLabel(mode)} · {timerModeLabel(timerMode, pomodoroState?.label)} · {paused ? '暂停中' : '进行中'}
            </Text>
            <Pressable onPress={togglePaused} style={styles.pauseButton}>
              <PauseGlyph paused={paused} />
            </Pressable>
          </View>

          <View style={styles.activityStrip}>
            <Text numberOfLines={2} style={styles.activityText}>小仓鼠：{userActivity}</Text>
            <Text numberOfLines={2} style={styles.activityText}>白云小姐：{effectiveBaiyunActivity || '当前活动待更新'}</Text>
          </View>

          <View style={styles.logPanel}>
            <View style={styles.logHeading}>
              <View style={styles.logHeadingMark} />
              <Text style={styles.logTitle}>专注日志</Text>
            </View>
            <FocusJournalList
              nested
              logs={logs}
              now={logNow}
              onRetry={(log) => void retryFocusGeneration(log)}
            />
            <View style={styles.inputRow}>
              <TextInput
                onFocus={() => { composerFocusedRef.current = true; keepComposerVisible(); }}
                onBlur={() => { composerFocusedRef.current = false; }}
                onChangeText={handleDraftChange}
                onSubmitEditing={() => void sendMessage()}
                placeholder="轻轻说一句..."
                placeholderTextColor="rgba(56,64,82,0.42)"
                style={styles.chatInput}
                underlineColorAndroid="transparent"
                value={draft}
              />
              <Pressable onPress={() => void sendMessage()} style={styles.sendButton}>
                <Text style={styles.sendText}>发送</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      ) : null}

      {phase === 'summary' && savedSession ? (
        <ScrollView contentContainerStyle={[styles.summaryContent, { paddingBottom: 42 + insets.bottom }]} keyboardShouldPersistTaps="handled">
          <Text style={styles.summaryDate}>{formatDate(savedSession.startedAt)}</Text>
          <Text style={styles.summaryTitle}>白云小姐和你一起{mode === 'cowork' ? '各忙各的' : '专注了一会儿'}</Text>
          <View style={styles.summaryGrid}>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>开始时间</Text>
              <Text style={styles.summaryValue}>{formatClock(savedSession.startedAt)}</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>结束时间</Text>
              <Text style={styles.summaryValue}>{formatClock(endedAt)}</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>专注时长</Text>
              <Text style={styles.summaryValue}>{Math.floor(savedSession.durationSeconds / 60)} 分钟</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>专注内容</Text>
              <Text style={styles.summaryActivity}>{savedSession.userActivity}</Text>
            </View>
          </View>

          <View style={styles.summarySection}>
            <FocusSummarySection key={savedSession.id} sessionId={savedSession.id} apiKey={memoryOrganizerKey}
              connection={memoryOrganizerConnection} active={active} autoOrganize={!reviewOnly} />
          </View>

          <View style={styles.summaryLogPanel}>
            <View style={styles.logHeading}>
              <View style={styles.logHeadingMark} />
              <Text style={styles.logTitle}>专注日志</Text>
            </View>
            {logs.filter(log => !isFocusSleepReplyReceipt(log) && !isFocusOrganizationLog(log)
              && !isFocusGenerationFailureResolved(log, logs)).map((log) => <FocusJournalEntry key={log.id} log={log} showDate />)}
          </View>

          <View style={styles.summaryButtons}>
            <Pressable onPress={() => void resetFocus()} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>再来一次</Text>
            </Pressable>
            <Pressable onPress={() => navigate('home')} style={styles.primaryButtonInline}>
              <Text style={styles.primaryButtonText}>回首页</Text>
            </Pressable>
          </View>
        </ScrollView>
      ) : null}
      </KeyboardAvoidingView>
    </BackgroundSurface>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  closeButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(56,64,82,0.22)',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  headerPlaceholder: {
    height: 40,
    width: 40,
  },
  endButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.28)',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    paddingHorizontal: 13,
  },
  endButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  closeText: {
    color: '#FFFFFF',
    fontSize: 34,
    lineHeight: 36,
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '500',
  },
  prepareContent: {
    padding: 20,
    paddingBottom: 40,
  },
  modeSwitch: {
    backgroundColor: 'rgba(255,247,239,0.34)',
    borderRadius: 26,
    flexDirection: 'row',
    padding: 5,
  },
  modeButton: {
    alignItems: 'center',
    borderRadius: 22,
    flex: 1,
    paddingVertical: 11,
  },
  modeButtonActive: {
    backgroundColor: focusPalette.cream,
  },
  modeText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 15,
    fontWeight: '700',
  },
  modeTextActive: {
    color: colors.ink,
  },
  timerModeBlock: {
    backgroundColor: 'rgba(255,255,255,0.26)',
    borderRadius: 24,
    marginTop: 14,
    padding: 14,
  },
  prepareLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 10,
  },
  timerModeRow: {
    flexDirection: 'row',
    gap: 10,
  },
  timerModeButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(178,217,255,0.32)',
    borderRadius: 18,
    flex: 1,
    paddingVertical: 10,
  },
  timerModeButtonActive: {
    backgroundColor: focusPalette.cream,
  },
  timerModeText: {
    color: 'rgba(56,64,82,0.62)',
    fontSize: 14,
    fontWeight: '600',
  },
  timerModeTextActive: {
    color: '#2D79A8',
  },
  minutesRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  minuteChip: {
    backgroundColor: 'rgba(178,217,255,0.36)',
    borderRadius: 15,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  minuteChipActive: {
    backgroundColor: focusPalette.mint,
  },
  minuteChipText: {
    color: 'rgba(56,64,82,0.62)',
    fontSize: 13,
    fontWeight: '600',
  },
  minuteChipTextActive: {
    color: '#2D79A8',
  },
  minuteInput: {
    backgroundColor: 'rgba(255,247,239,0.9)',
    borderRadius: 15,
    color: colors.ink,
    fontSize: 13,
    fontWeight: '600',
    minWidth: 70,
    paddingHorizontal: 12,
    paddingVertical: 7,
    textAlign: 'center',
  },
  pomodoroGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'center',
    marginTop: 12,
  },
  pomodoroField: {
    alignItems: 'center',
    backgroundColor: 'rgba(178,217,255,0.36)',
    borderRadius: 18,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minWidth: 132,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pomodoroFieldLabel: {
    color: 'rgba(56,64,82,0.62)',
    fontSize: 13,
    fontWeight: '600',
  },
  pomodoroFieldUnit: {
    color: 'rgba(56,64,82,0.62)',
    fontSize: 13,
    fontWeight: '600',
  },
  pomodoroInput: {
    backgroundColor: 'rgba(255,247,239,0.9)',
    borderBottomColor: 'transparent',
    borderBottomWidth: 0,
    borderRadius: 12,
    color: colors.ink,
    fontSize: 13,
    fontWeight: '600',
    minWidth: 40,
    paddingHorizontal: 8,
    paddingVertical: 5,
    textAlign: 'center',
  },
  notePair: {
    gap: 14,
    marginTop: 18,
  },
  noteCard: {
    backgroundColor: focusPalette.panel,
    borderRadius: 28,
    minHeight: 206,
    padding: 18,
  },
  supportNoteCard: {
    minHeight: 0,
    paddingBottom: 14,
    paddingTop: 16,
  },
  noteHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  noteLabel: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '500',
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  categoryChip: {
    backgroundColor: 'rgba(178,217,255,0.36)',
    borderRadius: 14,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  categoryChipActive: {
    backgroundColor: '#FFFFFF',
  },
  userCategoryChipActive: {
    backgroundColor: focusPalette.peach,
  },
  categoryChipText: {
    color: 'rgba(56,64,82,0.62)',
    fontSize: 13,
    fontWeight: '500',
  },
  categoryChipTextActive: {
    color: '#2D79A8',
    fontWeight: '700',
  },
  userCategoryChipTextActive: {
    color: '#FFFFFF',
  },
  noteInput: {
    backgroundColor: 'rgba(255,255,255,0.58)',
    borderBottomColor: 'transparent',
    borderBottomWidth: 0,
    borderRadius: 18,
    color: colors.ink,
    fontSize: 17,
    lineHeight: 24,
    marginTop: 14,
    minHeight: 72,
    paddingHorizontal: 14,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: focusPalette.cream,
    borderRadius: 26,
    marginTop: 18,
    paddingVertical: 16,
  },
  primaryButtonText: {
    color: '#D66E5A',
    fontSize: 18,
    fontWeight: '500',
  },
  historyBlock: {
    backgroundColor: 'rgba(255,255,255,0.26)',
    borderRadius: 24,
    marginTop: 26,
    padding: 14,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 19,
    fontWeight: '500',
    marginBottom: 10,
  },
  historyItem: {
    backgroundColor: 'rgba(255,255,255,0.58)',
    borderRadius: 18,
    marginBottom: 10,
    padding: 14,
  },
  historyTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '500',
  },
  historyMeta: {
    color: 'rgba(56,64,82,0.58)',
    fontSize: 13,
    fontWeight: '400',
    marginTop: 4,
  },
  emptyText: {
    color: 'rgba(56,64,82,0.58)',
    fontSize: 14,
    fontWeight: '400',
  },
  historyHint: {
    color: 'rgba(56,64,82,0.5)',
    fontSize: 12,
    fontWeight: '400',
    textAlign: 'center',
  },
  runningViewport: {
    flex: 1,
    minHeight: 0,
  },
  runningContent: {
    flexGrow: 1,
    padding: 20,
    paddingTop: 12,
  },
  timerBlock: {
    minHeight: 112,
    justifyContent: 'center',
    paddingRight: 96,
  },
  timer: {
    color: '#FFFFFF',
    fontSize: 54,
    fontWeight: '500',
    letterSpacing: 0,
  },
  modeLine: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: 17,
    fontWeight: '500',
    marginTop: 6,
  },
  pauseButton: {
    alignItems: 'center',
    backgroundColor: focusPalette.cream,
    borderRadius: 38,
    height: 76,
    justifyContent: 'center',
    position: 'absolute',
    right: 0,
    top: 18,
    width: 76,
  },
  pauseGlyph: {
    flexDirection: 'row',
    gap: 8,
  },
  pauseBar: {
    backgroundColor: focusPalette.peach,
    borderRadius: 8,
    height: 32,
    width: 10,
  },
  activityStrip: {
    gap: 5,
    marginBottom: 6,
  },
  activityText: {
    color: 'rgba(255,255,255,0.88)',
    fontSize: 15,
    fontWeight: '500',
  },
  logPanel: {
    backgroundColor: focusJournalPalette.paper,
    borderRadius: 28,
    flex: 1,
    minHeight: 280,
    marginTop: 12,
    padding: 18,
  },
  logHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingBottom: 14,
  },
  logHeadingMark: {
    backgroundColor: focusPalette.peach,
    height: 2,
    width: 24,
  },
  logTitle: {
    color: colors.ink,
    fontSize: 21,
    fontWeight: '500',
  },
  inputRow: {
    alignItems: 'center',
    borderTopColor: 'rgba(56,64,82,0.12)',
    borderTopWidth: 1,
    flexDirection: 'row',
    flexShrink: 0,
    gap: 10,
    paddingTop: 12,
  },
  chatInput: {
    backgroundColor: 'rgba(255,253,250,0.75)',
    borderBottomColor: 'transparent',
    borderBottomWidth: 0,
    borderRadius: 18,
    color: colors.ink,
    flex: 1,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 10,
    textAlignVertical: 'center',
  },
  sendButton: {
    backgroundColor: focusPalette.blue,
    borderRadius: 18,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  sendText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '400',
  },
  summaryContent: {
    padding: 20,
    paddingBottom: 42,
  },
  summaryDate: {
    color: 'rgba(255,255,255,0.58)',
    fontSize: 20,
    fontWeight: '400',
    marginTop: 26,
    textAlign: 'center',
  },
  summaryTitle: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '500',
    lineHeight: 32,
    marginBottom: 22,
    marginTop: 18,
    textAlign: 'center',
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  summaryCard: {
    backgroundColor: focusPalette.panel,
    borderRadius: 22,
    flexGrow: 1,
    minHeight: 96,
    padding: 16,
    width: '47%',
  },
  summaryLabel: {
    color: 'rgba(56,64,82,0.54)',
    fontSize: 14,
    fontWeight: '400',
  },
  summaryValue: {
    color: colors.ink,
    fontSize: 24,
    fontWeight: '500',
    marginTop: 12,
  },
  summaryActivity: {
    color: colors.ink,
    fontSize: 16,
    lineHeight: 24,
    marginTop: 12,
  },
  summarySection: {
    marginTop: 24,
  },
  summaryLogPanel: {
    backgroundColor: '#FDFDFC',
    borderRadius: 24,
    marginTop: 24,
    padding: 18,
  },
  summaryButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 22,
  },
  secondaryButton: {
    alignItems: 'center',
    borderColor: 'rgba(255,255,255,0.5)',
    borderRadius: 23,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 14,
  },
  secondaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  primaryButtonInline: {
    alignItems: 'center',
    backgroundColor: focusPalette.cream,
    borderRadius: 23,
    flex: 1,
    paddingVertical: 14,
  },
});
