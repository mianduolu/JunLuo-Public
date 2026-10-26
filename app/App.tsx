import { StatusBar } from 'expo-status-bar';
import { usePhoneLockChatVisibility } from './src/phoneRestriction/phoneLockChatSurface';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, DeviceEventEmitter, InteractionManager, LogBox, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView as InsetsSafeAreaView } from 'react-native-safe-area-context';

import { AiConfigPreferencesProvider, useAiConfigPreferences } from './src/ai/AiConfigPreferences';
import { PhoneRestrictionRecoveryNotice } from './src/components/PhoneRestrictionRecoveryNotice';
import { startBodySignalCompanionRuntime } from './src/bodySignal/bodySignalCompanionRuntime';
import { startBodySignalCareRuntime } from './src/bodySignal/bodySignalCareRuntime';
import { startBodySignalGuardianRuntime } from './src/bodySignal/bodySignalGuardianRuntime';
import { startMiBand6BatteryRuntime } from './src/bodySignal/miBand6BatteryRuntime';
import { startMiBand6ActivityRuntime } from './src/bodySignal/miBand6ActivityRuntime';
import { startMiBand6SleepRuntime } from './src/bodySignal/miBand6SleepRuntime';
import type { SubjectiveMessage } from './src/ai/subjectiveMessages';
import { referenceFromBook, type ReadingReference } from './src/reading/readingReference';
import { BackgroundPreferencesProvider, useBackgroundPreferences } from './src/backgrounds/BackgroundPreferences';
import {
  ensureBackupRestoreRecovery,
  reloadAfterBackupRestore,
  runBackupProtectedTask,
} from './src/backup/backupService';
import {
  getBackupRestoreRuntimeState,
  canCommitBackupRestoreDataEpoch,
  subscribeBackupRestoreRuntimeState,
} from './src/backup/backupRestoreCoordinator';
import { useCameraPerceptionRuntime } from './src/camera/cameraPerceptionRuntime';
import { useProactiveDeviceControl } from './src/proactive/proactiveDeviceControlAndroid';
import { FontPreferencesProvider } from './src/fonts/FontPreferences';
import { useMemoryProcessingRuntime } from './src/memory/useMemoryProcessingRuntime';
import { recoverMemoryDuplicateCleanupAfterRestart } from './src/memory/memoryDuplicateCleanup';
import { AiSettingsScreen } from './src/screens/AiSettingsScreen';
import { isAiSettingsSection } from './src/screens/aiSettingsSections';
import { AppearanceSettingsScreen } from './src/screens/AppearanceSettingsScreen';
import { AssistantDiaryScreen } from './src/screens/AssistantDiaryScreen';
import { BackupScreen } from './src/screens/BackupScreen';
import { BodySignalScreen } from './src/screens/BodySignalScreen';
import { BodySignalActivityScreen } from './src/screens/BodySignalActivityScreen';
import { BodySignalSleepScreen } from './src/screens/BodySignalSleepScreen';
import { DeviceSyncSettingsScreen } from './src/screens/DeviceSyncSettingsScreen';
import { CameraPerceptionSettingsScreen } from './src/screens/CameraPerceptionSettingsScreen';
import { CameraObservationHistoryScreen } from './src/screens/CameraObservationHistoryScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { CoReadingScreen } from './src/screens/CoReadingScreen';
import { ExpenseScreen } from './src/screens/ExpenseScreen';
import { FocusScreen } from './src/screens/FocusScreen';
import { FavoritesScreen } from './src/screens/FavoritesScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { LetterScreen } from './src/screens/LetterScreen';
import { MemoryDuplicateCleanupScreen } from './src/screens/MemoryDuplicateCleanupScreen';
import { MemoryScreen } from './src/screens/MemoryScreen';
import { MemoryBrowserScreen } from './src/screens/MemoryBrowserScreen';
import { NearbyWorldSettingsScreen } from './src/screens/NearbyWorldSettingsScreen';
import { PeriodScreen } from './src/screens/PeriodScreen';
import type { ShiyingOpenRequest } from './src/shiying/shiyingNotificationPolicy';
import { useTheaterFeature } from './src/theater/useTheaterFeature';
import type { BodyDataDestination } from './src/bodySignal/BodyDataFeature';
import { ScheduleScreen } from './src/screens/ScheduleScreen';
import { SecretPackageScreen } from './src/screens/SecretPackageScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SocialDraftBoxScreen } from './src/screens/SocialDraftBoxScreen';
import { PromptDiagnosticsScreen } from './src/screens/PromptDiagnosticsScreen';
import { TodayTimelineScreen } from './src/screens/TodayTimelineScreen';
import { ToolSettingsScreen } from './src/screens/ToolSettingsScreen';
import { VoiceCallSettingsScreen } from './src/screens/VoiceCallSettingsScreen';
import { requestNotificationPermission } from './src/schedule/scheduleNotifications';
import { backfillTimeBasedGoalCredits } from './src/schedule/goalProgressStore';
import { ScheduleMessageBanner, type ScheduleMessageBannerItem } from './src/schedule/ScheduleMessageBanner';
import {
  loadProactiveMessageSettings,
  probePhoneActivityProactiveMessage,
  saveProactiveMessageSettings,
} from './src/proactive/proactiveMessages';
import {
  loadPhoneActivityProactiveSettings,
  savePhoneActivityProactiveSettings,
} from './src/proactive/phoneActivityRules';
import {
  consumeInitialPhoneGuardLaunchRequest,
  consumePhoneGuardLaunchRequest,
  type PhoneGuardLaunchRequest,
} from './src/backend/phoneActivityNative';
import { MusicPlayerProvider } from './src/music/MusicPlayer';
import { CHAT_VOICE_AUDIO_RELEASE_TOTAL_TIMEOUT_MS } from './src/chat/chatVoiceLifecycle';
import { loadChatStateFast } from './src/chat/chatStorage';
import type {
  ReleaseChatVoiceAudioForCall,
  ResumeChatVoiceAudioAfterCall,
} from './src/chat/useChatVoiceRecorder';
import { useAppRuntimeScheduler } from './src/runtime/useAppRuntimeScheduler';
import { useAutomaticDataSyncScheduler } from './src/sync/useAutomaticDataSyncScheduler';
import { restoreAndroidNewWorldLiveCapture } from './src/sync/syncAndroidNewWorldLiveCapture';
import { AutomaticDataSyncCapsule } from './src/sync/AutomaticDataSyncCapsule';
import {
  emergencySyncWorldRebuildSnapshot,
  loadEmergencySyncWorldRebuildSnapshot,
  recoverEmergencySyncWorldCutover,
  subscribeEmergencySyncWorldRebuild,
  type EmergencySyncWorldRebuildSnapshot,
} from './src/sync';
import {
  beginRuntimeWorkload,
  type RuntimeWorkloadStage,
} from './src/runtime/runtimeWorkloadDiagnostics';
import {
  appResidencyDiagnosticsEnabled,
  createAppResidencyLifecycleTracker,
  normalizeAppResidencyScreen,
  recordAppResidencySnapshot,
} from './src/runtime/appResidencyDiagnostics';
import { colors } from './src/theme/colors';
import { getSkyBackgroundReadability, resolveBackgroundReadability } from './src/theme/homeReadability';
import type { ScreenName } from './src/types/navigation';
import { ensureSecretPackageImportRecoveryV1 } from './src/secretPackage/secretPackageAndroidController';
import { getCurrentSkyTheme, skyThemes } from './src/utils/sky';
import { useToolExecutionAttemptRecoveryRuntime } from './src/tools/useToolExecutionAttemptRecoveryRuntime';
import {
  BaiyunCallBrainSession,
  initialBaiyunCallBrainSnapshot,
  prewarmBaiyunCallContext,
  type BaiyunCallBrainSnapshot,
} from './src/voiceCall/baiyunCallBrain';
import {
  VoiceCallOverlay,
  type VoiceCallAuditionState,
  type VoiceCallUiState,
} from './src/voiceCall/VoiceCallOverlay';
import {
  describeVoiceCallAttemptError,
  voiceCallRoomBridge,
  type PreparedVoiceCallAttempt,
  type VoiceCallRoomSnapshot,
} from './src/voiceCall/voiceCallClient';
import {
  VoiceCallRecordCollector,
  type VoiceCallEndReason,
} from './src/voiceCall/voiceCallRecord';
import {
  appendVoiceCallDiagnosticToRecord,
  finishVoiceCallDiagnostic,
  getActiveVoiceCallDiagnostic,
  markVoiceCallDiagnosticConnected,
  updateVoiceCallDiagnostic,
} from './src/voiceCall/voiceCallDiagnostics';
import {
  finalizeVoiceCallRecord,
  persistActiveVoiceCallRecordDraft,
  recoverInterruptedVoiceCallRecord,
} from './src/voiceCall/voiceCallRecordStorage';
import {
  defaultVoiceCallSettings,
  loadVoiceCallSettings,
  type VoiceCallSettings,
} from './src/voiceCall/voiceCallSettings';
import {
  answerNativeIncomingCall,
  consumePendingIncomingCallAction,
  declineNativeIncomingCall,
  loadNativeIncomingCallRecords,
  setNativeIncomingCallUiVisible,
  suppressNativeIncomingCall,
  subscribeIncomingCallActions,
  type IncomingCallNativeAction,
} from './src/backend/incomingCallNative';
import {
  updateVoiceCallInvitationStatus,
  type VoiceCallInvitationKind,
} from './src/voiceCall/voiceCallInvitationStore';
import {
  BAIYUN_AUTONOMOUS_CALL_OPENING_PROMPT,
  BAIYUN_SCHEDULED_CALL_OPENING_PROMPT,
  buildScheduledVoiceCallMaterial,
} from './src/voiceCall/voiceCallInvitationPrompt';
import {
  VoiceAudioTransitionCoordinator,
  type VoiceAudioAcceptResult,
  type VoiceAudioReservation,
} from './src/voiceCall/voiceAudioTransition';

const APP_SCREEN_DIAGNOSTIC_STAGES: Partial<Record<ScreenName, RuntimeWorkloadStage>> = {
  home: 'app.screen.home_active',
  chat: 'app.screen.chat_active',
  settings: 'app.screen.settings_active',
  schedule: 'app.screen.schedule_active',
  focus: 'app.screen.focus_active',
  memory: 'app.screen.memory_active',
};
import {
  fetchVoiceCallDiagnostics,
  prewarmVoiceCallSpeech,
  requestVoiceCallTestSpeech,
  stopPrewarmedVoiceCallSpeech,
  VoiceCallTokenError,
} from './src/voiceCall/voiceCallRoomClient';
import { WeatherAnimationPreferencesProvider, useWeatherAnimationPreferences } from './src/weather/WeatherAnimationPreferences';

const SKY_THEME_REFRESH_INTERVAL_MS = 60 * 1000;
const PHONE_GUARD_LAUNCH_TTL_MS = 15_000;
const VOICE_CALL_CONNECTING_DELAY_MS = 900;
const VOICE_CALL_CONNECT_TIMEOUT_MS = 15_000;
const VOICE_CALL_BACKGROUND_CLEANUP_DELAY_MS = 5000;

function voiceCallTtsTechnicalStatus(caught: unknown) {
  if (caught instanceof VoiceCallTokenError) {
    if (caught.code === 'daily_tts_budget_exhausted') {
      return '今日语音额度已用完，文字回复仍可查看。';
    }
    if (caught.code === 'call_tts_budget_exhausted') {
      return '本通电话的新语音次数已用完。';
    }
  }
  return '这次语音没有生成，文字回复仍可查看。';
}

function voiceCallAuditionFailureState(caught: unknown): VoiceCallAuditionState {
  if (caught instanceof VoiceCallTokenError) {
    if (caught.code === 'daily_tts_budget_exhausted') return 'daily-limit';
    if (caught.code === 'call_tts_budget_exhausted') return 'call-limit';
  }
  return 'failed';
}

function isSameSkyTheme(
  left: ReturnType<typeof getCurrentSkyTheme>,
  right: ReturnType<typeof getCurrentSkyTheme>,
) {
  return left.key === right.key
    && left.colors.length === right.colors.length
    && left.colors.every((color, index) => color === right.colors[index]);
}

LogBox.ignoreLogs([
  'unable to set offer',
  'cannot send signal request before connected, type: leave',
]);

type VoiceCallMode = 'shell' | 'livekit';
type ActiveVoiceCallDescriptor = {
  direction: 'incoming' | 'test';
  invitationId?: string;
  kind?: VoiceCallInvitationKind;
  nativeRinging?: boolean;
  note?: string;
  origin: 'autonomous' | 'manual-test' | 'scheduled';
  scheduledAt?: number;
};
type ChatVoiceAudioControl = {
  releaseVoiceAudioForCall: ReleaseChatVoiceAudioForCall;
  resumeVoiceAudioAfterCall: ResumeChatVoiceAudioAfterCall;
};

function messageForVoiceAudioFailure(result: VoiceAudioAcceptResult) {
  if (result.status !== 'failed') return '电话线音频交接已取消。';
  if (
    result.stage === 'connect-room'
    && result.error instanceof Error
    && /Voice audio step connect-room timed out/i.test(result.error.message)
  ) return '电话线加入房间超时。';
  if (result.error !== undefined) return describeVoiceCallAttemptError(result.error);
  if (result.stage === 'release-chat') return '聊天录音还没有安全释放，电话线没有接通。';
  if (result.stage === 'audio-not-free') return '上一次音频资源还没有安全释放，电话线没有接通。';
  return '电话线音频准备失败。';
}

function isChatMessageNotificationData(data: Record<string, unknown> | undefined) {
  return data?.kind === 'proactive-message' || data?.kind === 'life-message';
}

function isReminderNotificationData(data: Record<string, unknown> | undefined) {
  return typeof data?.occurrenceId === 'string'
    || typeof data?.companionEventId === 'string'
    || typeof data?.todoId === 'string'
    || typeof data?.periodReminderId === 'string';
}

function isFreshPhoneGuardLaunchRequest(request: PhoneGuardLaunchRequest | null) {
  return !!request && request.targetScreen === 'chat' && Date.now() - request.createdAt <= PHONE_GUARD_LAUNCH_TTL_MS;
}

type AppLaunchProps = {
  initialRoute?: ScreenName;
  junluoSource?: string;
  junluoTriggerId?: string;
};

export default function App(props: AppLaunchProps) {
  const [backupRecoveryStatus, setBackupRecoveryStatus] = useState<'checking' | 'restoring' | 'ready' | 'failed' | 'restart-required'>('checking');
  const [backupRecoveryError, setBackupRecoveryError] = useState('');
  const [backupRestartInFlight, setBackupRestartInFlight] = useState(false);
  const [emergencyRebuildSnapshot, setEmergencyRebuildSnapshot] =
    useState<EmergencySyncWorldRebuildSnapshot>(() => (
      emergencySyncWorldRebuildSnapshot(null)
    ));
  const runtimeReady = backupRecoveryStatus === 'ready'
    && !emergencyRebuildSnapshot.active;
  useMemoryProcessingRuntime(runtimeReady);
  useProactiveDeviceControl(runtimeReady);
  useToolExecutionAttemptRecoveryRuntime(runtimeReady);
  const backupRestartAttemptedRef = useRef(false);
  const backupRestartInFlightRef = useRef(false);
  const showBackupRestartRequired = useCallback((detail: string) => {
    setBackupRecoveryError(detail);
    setBackupRecoveryStatus('restart-required');
  }, []);
  const runBackupRecovery = useCallback(async () => {
    const currentRuntimeState = getBackupRestoreRuntimeState();
    if (currentRuntimeState.status === 'restart-required') {
      showBackupRestartRequired(currentRuntimeState.detail);
      return;
    }
    setBackupRecoveryStatus('checking');
    setBackupRecoveryError('');
    try {
      await ensureSecretPackageImportRecoveryV1();
      await ensureBackupRestoreRecovery();
      await recoverEmergencySyncWorldCutover();
      await recoverMemoryDuplicateCleanupAfterRestart();
      setEmergencyRebuildSnapshot(
        await loadEmergencySyncWorldRebuildSnapshot(),
      );
      const runtimeState = getBackupRestoreRuntimeState();
      if (runtimeState.status === 'restart-required') {
        showBackupRestartRequired(runtimeState.detail);
        return;
      }
      if (runtimeState.status === 'recovery-blocked') {
        throw new Error(runtimeState.detail);
      }
      if (runtimeState.status === 'restoring') {
        setBackupRecoveryError(runtimeState.detail);
        setBackupRecoveryStatus('restoring');
        return;
      }
      if (!(await loadEmergencySyncWorldRebuildSnapshot()).active) {
        await restoreAndroidNewWorldLiveCapture().catch(error => {
          // Sync recovery must not turn a local editor into a backup error page.
          // The next manual round retries and reports this failure before sending.
          console.warn('junluo-sync-live-capture-resume-deferred', error);
        });
      }
      setBackupRecoveryStatus('ready');
    } catch (error) {
      setBackupRecoveryError(error instanceof Error ? error.message : '无法恢复到导入前状态。');
      setBackupRecoveryStatus('failed');
    }
  }, [showBackupRestartRequired]);

  const runBackupRestart = useCallback(async () => {
    if (backupRestartInFlightRef.current) return;
    backupRestartInFlightRef.current = true;
    setBackupRestartInFlight(true);
    try {
      await reloadAfterBackupRestore();
    } catch (error) {
      setBackupRecoveryError(
        '君落没能自动重新打开，请手动完全关闭后再打开。原因：' +
          (error instanceof Error ? error.message : '未知错误'),
      );
    } finally {
      backupRestartInFlightRef.current = false;
      setBackupRestartInFlight(false);
    }
  }, []);

  useEffect(() => subscribeBackupRestoreRuntimeState((runtimeState) => {
    if (runtimeState.status === 'restart-required') {
      showBackupRestartRequired(runtimeState.detail);
    } else if (runtimeState.status === 'recovery-blocked') {
      setBackupRecoveryError(runtimeState.detail);
      setBackupRecoveryStatus('failed');
    } else if (runtimeState.status === 'restoring') {
      setBackupRecoveryError(runtimeState.detail);
      setBackupRecoveryStatus('restoring');
    } else {
      setBackupRecoveryError('');
      setBackupRecoveryStatus('ready');
    }
  }), [showBackupRestartRequired]);

  useEffect(() => {
    void runBackupRecovery();
  }, [runBackupRecovery]);

  useEffect(() => subscribeEmergencySyncWorldRebuild(
    setEmergencyRebuildSnapshot,
  ), []);

  useEffect(() => {
    if (backupRecoveryStatus !== 'restart-required' || backupRestartAttemptedRef.current) return undefined;
    backupRestartAttemptedRef.current = true;
    const timer = setTimeout(() => void runBackupRestart(), 150);
    return () => clearTimeout(timer);
  }, [backupRecoveryStatus, runBackupRestart]);

  if (backupRecoveryStatus !== 'ready') {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.backupRecoveryRoot}>
          {backupRecoveryStatus === 'checking' ? (
            <ActivityIndicator color={colors.primary} size="large" />
          ) : backupRecoveryStatus === 'restoring' ? (
            <>
              <ActivityIndicator color={colors.primary} size="large" />
              <Text style={styles.backupRecoveryTitle}>正在安全切换数据</Text>
              <Text style={styles.backupRecoveryText}>{backupRecoveryError}</Text>
            </>
          ) : backupRecoveryStatus === 'restart-required' ? (
            <>
              <Text style={styles.backupRecoveryTitle}>数据已经安全切换</Text>
              <Text style={styles.backupRecoveryText}>{backupRecoveryError}</Text>
              <Pressable
                disabled={backupRestartInFlight}
                onPress={() => void runBackupRestart()}
                style={[styles.backupRecoveryButton, backupRestartInFlight ? styles.backupRecoveryButtonDisabled : null]}
              >
                <Text style={styles.backupRecoveryButtonText}>{backupRestartInFlight ? '正在重新打开…' : '立即重新打开'}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.backupRecoveryTitle}>上次还原没有完整结束</Text>
              <Text style={styles.backupRecoveryText}>君落已暂停启动，避免继续使用混合状态的数据。{backupRecoveryError}</Text>
              <Pressable onPress={() => void runBackupRecovery()} style={styles.backupRecoveryButton}>
                <Text style={styles.backupRecoveryButtonText}>重试恢复原状</Text>
              </Pressable>
            </>
          )}
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      {runtimeReady ? <PhoneRestrictionRecoveryNotice /> : null}
      <FontPreferencesProvider>
        <BackgroundPreferencesProvider>
          <AiConfigPreferencesProvider>
            <WeatherAnimationPreferencesProvider>
              <MusicPlayerProvider>
                <AppContent
                  emergencyRebuildActive={emergencyRebuildSnapshot.active}
                  initialRoute={props.initialRoute}
                />
              </MusicPlayerProvider>
            </WeatherAnimationPreferencesProvider>
          </AiConfigPreferencesProvider>
        </BackgroundPreferencesProvider>
      </FontPreferencesProvider>
    </SafeAreaProvider>
  );
}

function AppContent({
  emergencyRebuildActive,
  initialRoute,
}: {
  emergencyRebuildActive: boolean;
  initialRoute?: ScreenName;
}) {
  useCameraPerceptionRuntime(!emergencyRebuildActive);
  const initialPhoneGuardLaunchRef = useRef(consumeInitialPhoneGuardLaunchRequest());
  const initialScreen: ScreenName = initialRoute === 'chat' || isFreshPhoneGuardLaunchRequest(initialPhoneGuardLaunchRef.current)
    ? 'chat'
    : 'home';
  const [screen, setScreen] = useState<ScreenName>(initialScreen);
  const [pendingReadingReference, setPendingReadingReference] = useState<ReadingReference | null>(null);
  const clearSavedReadingReference = useCallback((sent: ReadingReference) => {
    setPendingReadingReference(current => current === sent ? null : current);
  }, []);
  const [bodyDataDestination, setBodyDataDestination] = useState<BodyDataDestination>();
  const [shiyingOpenRequest, setShiyingOpenRequest] = useState<ShiyingOpenRequest | null>(null);
  useEffect(() => subscribeBackupRestoreRuntimeState(state => {
    if (state.status !== 'ready') setShiyingOpenRequest(null);
  }), []);
  const screenRef = useRef<ScreenName>(initialScreen);
  const chatRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatRefreshInteractionRef = useRef<ReturnType<typeof InteractionManager.runAfterInteractions> | null>(null);
  const [homeMounted, setHomeMounted] = useState(initialScreen === 'home');
  const [focusMounted, setFocusMounted] = useState(false);
  const [scheduleMounted, setScheduleMounted] = useState(false);
  const [chatMounted, setChatMounted] = useState(initialScreen === 'chat');
  const phoneLockChatVisible = usePhoneLockChatVisibility();
  useEffect(() => { if (phoneLockChatVisible) setChatMounted(true); }, [phoneLockChatVisible]);
  const appResidencyLifecycleTrackerRef = useRef<ReturnType<typeof createAppResidencyLifecycleTracker> | null>(null);
  const [chatAutomaticSyncBusy, setChatAutomaticSyncBusy] = useState(true);
  const [automaticSyncExclusiveBusy, setAutomaticSyncExclusiveBusy] =
    useState(false);
  const chatMountFrameRef = useRef<number | null>(null);
  const [chatRefreshVersion, setChatRefreshVersion] = useState(0);
  const [voiceCallState, setVoiceCallState] = useState<VoiceCallUiState | null>(null);
  const voiceCallStateRef = useRef(voiceCallState);
  voiceCallStateRef.current = voiceCallState;
  const [voiceCallMode, setVoiceCallMode] = useState<VoiceCallMode | null>(null);
  const [voiceCallDescriptor, setVoiceCallDescriptor] = useState<ActiveVoiceCallDescriptor>({
    direction: 'test',
    origin: 'manual-test',
  });
  const voiceCallDescriptorRef = useRef(voiceCallDescriptor);
  const [voiceCallRoomSnapshot, setVoiceCallRoomSnapshot] = useState<VoiceCallRoomSnapshot>(voiceCallRoomBridge.getSnapshot());
  const [voiceCallStartedAt, setVoiceCallStartedAt] = useState<number | null>(null);
  const [voiceCallBrainSnapshot, setVoiceCallBrainSnapshot] = useState<BaiyunCallBrainSnapshot>(
    initialBaiyunCallBrainSnapshot,
  );
  const [voiceCallAuditionState, setVoiceCallAuditionState] = useState<VoiceCallAuditionState>('idle');
  const [voiceCallAudioReserved, setVoiceCallAudioReserved] = useState(false);
  const [voiceCallBudgetNotice, setVoiceCallBudgetNotice] = useState<string | null>(null);
  const [voiceCallDurationNotice, setVoiceCallDurationNotice] = useState<string | null>(null);
  const [scheduleBannerQueue, setScheduleBannerQueue] = useState<ScheduleMessageBannerItem[]>([]);
  const voiceCallTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceCallBackgroundCleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceCallBrainSessionRef = useRef<BaiyunCallBrainSession | null>(null);
  const voiceCallRecordCollectorRef = useRef<VoiceCallRecordCollector | null>(null);
  const voiceCallRecordDraftWriteRef = useRef<Promise<void>>(Promise.resolve());
  const voiceCallAuditionUsedRef = useRef(false);
  const voiceCallAutomaticPlaybackTurnIdsRef = useRef(new Set<string>());
  const handledIncomingCallActionsRef = useRef(new Set<string>());
  const voiceCallAcceptHandlerRef = useRef<() => void>(() => undefined);
  const voiceCallAudioCoordinatorRef = useRef<VoiceAudioTransitionCoordinator | null>(null);
  if (!voiceCallAudioCoordinatorRef.current) {
    voiceCallAudioCoordinatorRef.current = new VoiceAudioTransitionCoordinator({
      connectRoomTimeoutMs: VOICE_CALL_CONNECT_TIMEOUT_MS,
      releaseChatTimeoutMs: CHAT_VOICE_AUDIO_RELEASE_TOTAL_TIMEOUT_MS,
    });
  }
  const voiceCallPreparedAttemptRef = useRef<PreparedVoiceCallAttempt | null>(null);
  const voiceCallAudioReservationRef = useRef<VoiceAudioReservation | null>(null);
  const voiceCallGenerationRef = useRef(0);
  const voiceCallAcceptPromiseRef = useRef<Promise<void> | null>(null);
  const voiceCallFinishPromiseRef = useRef<Promise<boolean> | null>(null);
  const voiceCallConnectedRef = useRef(false);
  const voiceCallRuntimeSettingsRef = useRef<VoiceCallSettings>(defaultVoiceCallSettings);
  const chatVoiceAudioControlRef = useRef<ChatVoiceAudioControl | null>(null);
  const chatMountedStateRef = useRef(chatMounted);
  chatMountedStateRef.current = chatMounted;
  const queuedScheduleMessageIdsRef = useRef(new Set<string>());
  const handledNotificationResponseIdsRef = useRef(new Set<string>());
  const [skyNow, setSkyNow] = useState(() => new Date());
  const {
    chatConnection,
    chatKey,
    loaded: aiConfigLoaded,
    memoryOrganizerConnection,
    memoryOrganizerKey,
    profile,
  } = useAiConfigPreferences();
  const { settings: backgroundSettings } = useBackgroundPreferences();
  const { enabled: weatherAnimationsEnabled, setEnabled: setWeatherAnimationsEnabled } = useWeatherAnimationPreferences();
  const aiConfigRef = useRef({ chatConnection, chatKey, profile });
  useEffect(() => {
    aiConfigRef.current = { chatConnection, chatKey, profile };
  }, [chatConnection, chatKey, profile]);

  const queueVoiceCallRecordDraft = (collector = voiceCallRecordCollectorRef.current) => {
    if (!collector) return;
    const draft = collector.toDraft();
    voiceCallRecordDraftWriteRef.current = voiceCallRecordDraftWriteRef.current
      .catch(() => undefined)
      .then(async () => { await persistActiveVoiceCallRecordDraft(draft); });
  };

  useEffect(() => {
    void recoverInterruptedVoiceCallRecord().catch(() => undefined);
  }, []);

  const sky = backgroundSettings.mode === 'fixed' ? skyThemes[backgroundSettings.fixedPeriod] : getCurrentSkyTheme(skyNow);
  const displaysImageBackground = backgroundSettings.mode === 'image' && !!backgroundSettings.imageUri;
  const defaultReadability =
    displaysImageBackground
      ? { headerText: 'light' as const, exposedLabelText: 'light' as const }
      : getSkyBackgroundReadability(sky);
  const homeReadability = resolveBackgroundReadability(defaultReadability, backgroundSettings);
  const skyBottomColor = sky.colors[sky.colors.length - 1];
  const usesSkySurface =
    screen === 'home' || screen === 'chat' || screen === 'focus' || screen === 'today-timeline' || screen === 'period';

  useEffect(() => {
    screenRef.current = screen;
    if (screen === 'focus') setFocusMounted(true);
    if (screen === 'chat') setScheduleBannerQueue([]);
  }, [screen]);

  useEffect(() => {
    const stage = APP_SCREEN_DIAGNOSTIC_STAGES[screen];
    if (!stage) return undefined;
    const span = beginRuntimeWorkload(stage);
    return () => span?.finish('ok');
  }, [screen]);

  useEffect(() => {
    if (!chatMounted) return;
    beginRuntimeWorkload('app.mount.chat')?.finish('ok');
  }, [chatMounted]);

  useEffect(() => {
    if (!scheduleMounted) return;
    beginRuntimeWorkload('app.mount.schedule')?.finish('ok');
  }, [scheduleMounted]);

  useEffect(() => {
    if (!focusMounted) return;
    beginRuntimeWorkload('app.mount.focus')?.finish('ok');
  }, [focusMounted]);

  useEffect(() => {
    if (!appResidencyDiagnosticsEnabled) return undefined;
    const tracker = appResidencyLifecycleTrackerRef.current ?? createAppResidencyLifecycleTracker();
    appResidencyLifecycleTrackerRef.current = tracker;
    const capture = () => recordAppResidencySnapshot(tracker.capture({
      chatMounted,
      focusMounted,
      homeMounted,
      scheduleMounted,
      screen: normalizeAppResidencyScreen(screen),
    }));
    capture();
    const subscription = AppState.addEventListener('change', capture);
    return () => subscription.remove();
  }, [chatMounted, focusMounted, homeMounted, scheduleMounted, screen]);

  useEffect(() => {
    return voiceCallRoomBridge.subscribeTurnEvents((event) => {
      const session = voiceCallBrainSessionRef.current;
      const collector = voiceCallRecordCollectorRef.current;
      if (event.type === 'voice_call_playback') {
        collector?.handlePlayback(event);
        queueVoiceCallRecordDraft(collector);
        const automaticCarePlayback = session?.isAutomaticPlaybackTurn(event.sourceTurnId) ?? false;
        session?.handlePlaybackEvent(event);
        if (event.state === 'interrupted') {
          if (!automaticCarePlayback) {
            setVoiceCallAuditionState('interrupted');
          }
        } else if (event.state === 'failed') {
          setVoiceCallBudgetNotice('这次语音没有生成，文字回复仍可查看。');
          if (!automaticCarePlayback) {
            setVoiceCallAuditionState('failed');
          }
        }
        return;
      }
      if (event.type === 'transcript') {
        collector?.handleTranscript(event);
        queueVoiceCallRecordDraft(collector);
        if (!session) return;
        session.handleTranscript(event);
        return;
      }
      collector?.handleEmotion(event);
      queueVoiceCallRecordDraft(collector);
      if (!session) return;
      session.handleEmotion(event);
    });
  }, []);

  const mountChatAfterFrame = useCallback(() => {
    if (chatMounted || chatMountFrameRef.current !== null) return;
    chatMountFrameRef.current = requestAnimationFrame(() => {
      chatMountFrameRef.current = null;
      setChatMounted(true);
    });
  }, [chatMounted]);

  const theaterNavigateRef = useRef<() => void>(() => {});
  const theater = useTheaterFeature({
    getModel: () => aiConfigRef.current.chatKey.trim() && aiConfigRef.current.chatConnection
      ? { apiKey: aiConfigRef.current.chatKey.trim(), connection: aiConfigRef.current.chatConnection } : null,
    mountChat: mountChatAfterFrame,
    onBringToChat: () => theaterNavigateRef.current(),
  });
  const navigate = useCallback((nextScreen: ScreenName) => {
    const proceed = () => {
    setShiyingOpenRequest(null);
    setBodyDataDestination(undefined);
    if (nextScreen === 'chat') {
      setScreen(nextScreen);
      mountChatAfterFrame();
      return;
    }
    if (nextScreen === 'home') setHomeMounted(true);
    if (nextScreen === 'schedule') setScheduleMounted(true);
    setScreen(nextScreen);
    };
    if (screenRef.current === 'period' && nextScreen !== 'period') theater.requestLeave(proceed);
    else proceed();
  }, [mountChatAfterFrame, theater.requestLeave]);
  theaterNavigateRef.current = () => navigate('chat');

  const openShiyingNotification = useCallback((request: ShiyingOpenRequest) => {
    if (!canCommitBackupRestoreDataEpoch(request.dataEpoch)) return;
    const open = () => {
      if (!canCommitBackupRestoreDataEpoch(request.dataEpoch)) return;
      navigate('period');
      setShiyingOpenRequest(request);
    };
    // A period-to-period destination would otherwise bypass the existing theater leave guard.
    if (screenRef.current === 'period') theater.requestLeave(open);
    else open();
  }, [navigate, theater.requestLeave]);
  const consumeShiyingOpenRequest = useCallback((requestId: string) => {
    setShiyingOpenRequest(current => current?.requestId === requestId ? null : current);
  }, []);

  const openBodyData = useCallback((destination: BodyDataDestination = {}) => {
    navigate('period');
    setBodyDataDestination(destination);
  }, [navigate]);

  const clearVoiceCallTransitionTimer = useCallback(() => {
    if (!voiceCallTransitionTimerRef.current) return;
    clearTimeout(voiceCallTransitionTimerRef.current);
    voiceCallTransitionTimerRef.current = null;
  }, []);

  const clearVoiceCallBackgroundCleanupTimer = useCallback(() => {
    if (!voiceCallBackgroundCleanupTimerRef.current) return;
    clearTimeout(voiceCallBackgroundCleanupTimerRef.current);
    voiceCallBackgroundCleanupTimerRef.current = null;
  }, []);

  const resetVoiceCallBrainSession = useCallback(() => {
    voiceCallBrainSessionRef.current?.stop();
    voiceCallBrainSessionRef.current = null;
    voiceCallAuditionUsedRef.current = false;
    voiceCallAutomaticPlaybackTurnIdsRef.current.clear();
    setVoiceCallBrainSnapshot(initialBaiyunCallBrainSnapshot);
    setVoiceCallAuditionState('idle');
    setVoiceCallBudgetNotice(null);
    setVoiceCallDurationNotice(null);
  }, []);

  const finalizeFrozenVoiceCallRecord = useCallback((
    frozen: ReturnType<VoiceCallRecordCollector['freeze']>,
  ) => {
    const config = aiConfigRef.current;
    const diagnosticId = getActiveVoiceCallDiagnostic()?.id;
    void voiceCallRecordDraftWriteRef.current
      .catch(() => undefined)
      .then(async () => {
        const { settings } = await loadVoiceCallSettings();
        const result = await finalizeVoiceCallRecord({
          ai: {
            apiKey: config.chatKey,
            connection: config.chatConnection ?? null,
          },
          record: frozen.record,
          dataEpoch: frozen.dataEpoch,
          saveCallSummary: settings.saveCallSummary,
          targetSessionId: frozen.targetSessionId,
        });
        if (diagnosticId) void updateVoiceCallDiagnostic(diagnosticId, {
          summaryStatus: result?.summaryStatus ?? 'not_saved',
          candidateCount: result?.memoryCandidates.length ?? 0,
        });
      })
      .catch(() => {
        if (diagnosticId) void updateVoiceCallDiagnostic(diagnosticId, { summaryStatus: 'failed' });
      });
  }, []);

  const handleChatVoiceAudioControlChange = useCallback((control: ChatVoiceAudioControl | null) => {
    chatVoiceAudioControlRef.current = control;
  }, []);

  const startTestVoiceCall = useCallback(() => {
    if (
      voiceCallAcceptPromiseRef.current
      || voiceCallFinishPromiseRef.current
      || voiceCallAudioCoordinatorRef.current?.isReserved()
    ) return;
    voiceCallGenerationRef.current += 1;
    voiceCallConnectedRef.current = false;
    resetVoiceCallBrainSession();
    clearVoiceCallTransitionTimer();
    clearVoiceCallBackgroundCleanupTimer();
    chatVoiceAudioControlRef.current?.resumeVoiceAudioAfterCall();
    setVoiceCallAudioReserved(false);
    voiceCallDescriptorRef.current = { direction: 'test', origin: 'manual-test' };
    setVoiceCallDescriptor(voiceCallDescriptorRef.current);
    setVoiceCallMode('shell');
    setVoiceCallRoomSnapshot(voiceCallRoomBridge.getSnapshot());
    setVoiceCallStartedAt(null);
    setVoiceCallState('incoming');
  }, [clearVoiceCallBackgroundCleanupTimer, clearVoiceCallTransitionTimer, resetVoiceCallBrainSession]);

  const startRealVoiceCallTest = useCallback(() => {
    if (
      voiceCallAcceptPromiseRef.current
      || voiceCallFinishPromiseRef.current
      || voiceCallAudioCoordinatorRef.current?.isReserved()
    ) return;
    voiceCallGenerationRef.current += 1;
    voiceCallConnectedRef.current = false;
    resetVoiceCallBrainSession();
    clearVoiceCallTransitionTimer();
    clearVoiceCallBackgroundCleanupTimer();
    chatVoiceAudioControlRef.current?.resumeVoiceAudioAfterCall();
    setVoiceCallAudioReserved(false);
    voiceCallDescriptorRef.current = { direction: 'test', origin: 'manual-test' };
    setVoiceCallDescriptor(voiceCallDescriptorRef.current);
    setVoiceCallMode('livekit');
    setVoiceCallRoomSnapshot(voiceCallRoomBridge.getSnapshot());
    setVoiceCallStartedAt(null);
    setVoiceCallState('incoming');
  }, [clearVoiceCallBackgroundCleanupTimer, clearVoiceCallTransitionTimer, resetVoiceCallBrainSession]);

  const finishLiveKitVoiceCall = useCallback((reason: 'background' | 'close' | 'duration-limit' | 'hangup' | 'remote-disconnect') => {
    const diagnosticCallId = getActiveVoiceCallDiagnostic()?.callId;
    void setNativeIncomingCallUiVisible(false);
    const dismissOverlayImmediately = reason !== 'remote-disconnect';
    clearVoiceCallTransitionTimer();
    clearVoiceCallBackgroundCleanupTimer();
    const endReason: VoiceCallEndReason = reason === 'remote-disconnect'
      ? 'line-disconnected'
      : reason === 'background'
        ? 'app-left'
        : reason === 'duration-limit'
          ? 'duration-limit'
          : 'user-hangup';
    const frozenRecord = voiceCallRecordCollectorRef.current?.freeze(endReason);
    voiceCallRecordCollectorRef.current = null;
    if (frozenRecord) finalizeFrozenVoiceCallRecord(frozenRecord);
    resetVoiceCallBrainSession();
    voiceCallRoomBridge.sendDiagnostic('call_finish_requested', {
      appState: AppState.currentState,
      reason,
      roomStatus: voiceCallRoomBridge.getSnapshot().status,
    });
    const diagnosticId = finishVoiceCallDiagnostic(reason);
    if (dismissOverlayImmediately) {
      setVoiceCallMode(null);
      setVoiceCallState(null);
      setVoiceCallStartedAt(null);
    }
    const currentFinish = voiceCallFinishPromiseRef.current;
    if (currentFinish) return currentFinish;

    const remoteDisconnectSnapshot = reason === 'remote-disconnect'
      ? voiceCallRoomBridge.getSnapshot()
      : null;
    const generation = voiceCallGenerationRef.current + 1;
    voiceCallGenerationRef.current = generation;
    voiceCallConnectedRef.current = false;
    voiceCallAcceptPromiseRef.current = null;
    const prepared = voiceCallPreparedAttemptRef.current;
    const reservation = voiceCallAudioReservationRef.current;
    prepared?.cancel();

    const finishPromise = Promise.resolve().then(async () => {
      try {
        if (reservation) {
          const disconnectResult = await voiceCallAudioCoordinatorRef.current!.disconnect(reservation);
          if (!disconnectResult.released) {
            if (generation === voiceCallGenerationRef.current) {
              const message = '电话音频还没有安全释放。为了避免抢麦克风，聊天录音会继续暂停；请重启君落后再试。';
              setVoiceCallRoomSnapshot((current) => ({
                ...current,
                error: message,
                message,
                status: 'failed',
              }));
            }
            return false;
          }
          if (prepared) {
            voiceCallRoomBridge.finalizeAttempt(prepared);
          } else {
            await voiceCallRoomBridge.disconnect();
          }
        } else if (prepared) {
          voiceCallRoomBridge.finalizeAttempt(prepared);
        } else {
          await voiceCallRoomBridge.disconnect();
        }

        if (generation !== voiceCallGenerationRef.current) return true;
        if (voiceCallPreparedAttemptRef.current === prepared) {
          voiceCallPreparedAttemptRef.current = null;
        }
        if (voiceCallAudioReservationRef.current === reservation) {
          voiceCallAudioReservationRef.current = null;
        }
        chatVoiceAudioControlRef.current?.resumeVoiceAudioAfterCall();
        setVoiceCallAudioReserved(false);
        if (remoteDisconnectSnapshot) {
          const message = remoteDisconnectSnapshot.error || '电话线意外断开。';
          setVoiceCallRoomSnapshot({
            ...remoteDisconnectSnapshot,
            error: message,
            localAudioLevel: 0,
            localMicEnabled: false,
            localSpeaking: false,
            message,
            remoteAudioSubscribed: false,
            status: 'failed',
          });
          setVoiceCallState((current) => current === null ? null : 'active');
          setVoiceCallStartedAt(null);
        } else {
          setVoiceCallMode(null);
          setVoiceCallRoomSnapshot(voiceCallRoomBridge.getSnapshot());
          setVoiceCallState(null);
          setVoiceCallStartedAt(null);
        }
        return true;
      } catch (caught) {
        if (generation === voiceCallGenerationRef.current) {
          const detail = describeVoiceCallAttemptError(caught);
          const message = `电话线清理失败：${detail} 为了避免抢麦克风，聊天录音会继续暂停；请重启君落后再试。`;
          setVoiceCallRoomSnapshot((current) => ({
            ...current,
            error: message,
            message,
            status: 'failed',
          }));
        }
        return false;
      }
    }).then((released) => {
      if (diagnosticId) void appendVoiceCallDiagnosticToRecord(diagnosticId, 'audio_release_result', {
        success: released, errorCode: released ? undefined : 'audio_release_failed',
      });
      return released;
    }).finally(() => {
      if (diagnosticId && diagnosticCallId) {
        void fetchVoiceCallDiagnostics(diagnosticCallId)
          .then((backend) => updateVoiceCallDiagnostic(diagnosticId, {
            backend, backendFetchedAt: Date.now(), backendFetchError: undefined,
          }))
          .catch(() => updateVoiceCallDiagnostic(diagnosticId, { backendFetchError: 'backend_unavailable' }));
      }
      if (voiceCallFinishPromiseRef.current === finishPromise) {
        voiceCallFinishPromiseRef.current = null;
      }
    });
    voiceCallFinishPromiseRef.current = finishPromise;
    return finishPromise;
  }, [clearVoiceCallBackgroundCleanupTimer, clearVoiceCallTransitionTimer, finalizeFrozenVoiceCallRecord, resetVoiceCallBrainSession]);

  useEffect(() => {
    if (
      voiceCallMode !== 'livekit'
      || voiceCallState !== 'active'
      || voiceCallStartedAt === null
    ) return undefined;
    const maximumDurationMs = voiceCallRuntimeSettingsRef.current.maxCallMinutes * 60_000;
    const deadline = voiceCallStartedAt + maximumDurationMs;
    const warningAt = deadline - 60_000;
    let warningTimer: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

    const checkDeadline = () => {
      const now = Date.now();
      if (now >= deadline) {
        void finishLiveKitVoiceCall('duration-limit');
        return;
      }
      if (now >= warningAt) {
        setVoiceCallDurationNotice('本次通话将在 1 分钟后达到时长上限。');
      }
    };

    checkDeadline();
    const now = Date.now();
    if (warningAt > now) {
      warningTimer = setTimeout(() => {
        setVoiceCallDurationNotice('本次通话将在 1 分钟后达到时长上限。');
      }, warningAt - now);
    }
    if (deadline > now) {
      deadlineTimer = setTimeout(() => {
        void finishLiveKitVoiceCall('duration-limit');
      }, deadline - now);
    }
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') checkDeadline();
    });
    return () => {
      if (warningTimer) clearTimeout(warningTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      appStateSubscription.remove();
    };
  }, [finishLiveKitVoiceCall, voiceCallMode, voiceCallStartedAt, voiceCallState]);

  const closeVoiceCall = useCallback(() => {
    void setNativeIncomingCallUiVisible(false);
    clearVoiceCallTransitionTimer();
    clearVoiceCallBackgroundCleanupTimer();
    if (voiceCallMode === 'livekit') {
      void finishLiveKitVoiceCall('close');
      return;
    }
    resetVoiceCallBrainSession();
    setVoiceCallMode(null);
    setVoiceCallRoomSnapshot(voiceCallRoomBridge.getSnapshot());
    setVoiceCallState(null);
    setVoiceCallStartedAt(null);
  }, [
    clearVoiceCallBackgroundCleanupTimer,
    clearVoiceCallTransitionTimer,
    finishLiveKitVoiceCall,
    resetVoiceCallBrainSession,
    voiceCallMode,
  ]);

  const acceptVoiceCall = useCallback(() => {
    if (
      voiceCallState !== 'incoming'
      || voiceCallTransitionTimerRef.current
      || voiceCallAcceptPromiseRef.current
      || voiceCallFinishPromiseRef.current
      || voiceCallAudioCoordinatorRef.current?.isReserved()
    ) return;
    clearVoiceCallTransitionTimer();
    voiceCallConnectedRef.current = false;
    setVoiceCallStartedAt(null);
    setVoiceCallState('connecting');
    if (voiceCallMode !== 'livekit') {
      voiceCallTransitionTimerRef.current = setTimeout(() => {
        voiceCallTransitionTimerRef.current = null;
        setVoiceCallStartedAt(Date.now());
        setVoiceCallState('active');
      }, VOICE_CALL_CONNECTING_DELAY_MS);
      return;
    }

    const generation = voiceCallGenerationRef.current + 1;
    const activeDescriptor = voiceCallDescriptorRef.current;
    voiceCallGenerationRef.current = generation;
    setVoiceCallAudioReserved(true);

    const acceptPromise = Promise.resolve().then(async () => {
      const runtimeSettingsPromise = loadVoiceCallSettings()
        .then((snapshot) => snapshot.settings)
        .catch(() => defaultVoiceCallSettings);
      let prepared: PreparedVoiceCallAttempt;
      try {
        prepared = await voiceCallRoomBridge.prepareAttempt((snapshot) => {
          if (generation !== voiceCallGenerationRef.current) return;
          voiceCallBrainSessionRef.current?.handleVoiceActivity(snapshot.localSpeaking);
          setVoiceCallRoomSnapshot(snapshot);
          if (
            (snapshot.status === 'idle' || snapshot.status === 'failed')
            && voiceCallConnectedRef.current
          ) {
            void finishLiveKitVoiceCall('remote-disconnect');
          }
        }, activeDescriptor.invitationId, activeDescriptor.direction);
      } catch (caught) {
        if (generation !== voiceCallGenerationRef.current) return;
        voiceCallConnectedRef.current = false;
        const message = describeVoiceCallAttemptError(caught);
        await voiceCallRoomBridge.disconnect({
          error: message,
          keepListener: true,
          nextStatus: 'failed',
        });
        if (generation !== voiceCallGenerationRef.current) return;
        chatVoiceAudioControlRef.current?.resumeVoiceAudioAfterCall();
        setVoiceCallAudioReserved(false);
        setVoiceCallRoomSnapshot(voiceCallRoomBridge.getSnapshot());
        return;
      }

      if (generation !== voiceCallGenerationRef.current) {
        prepared.cancel();
        voiceCallRoomBridge.finalizeAttempt(prepared);
        return;
      }
      voiceCallPreparedAttemptRef.current = prepared;
      const reservation = voiceCallAudioCoordinatorRef.current!.reserve({
        releaseChatAudio: async () => {
          const control = chatVoiceAudioControlRef.current;
          if (control) return await control.releaseVoiceAudioForCall();
          return !chatMountedStateRef.current;
        },
        ...prepared.operations,
      });
      voiceCallAudioReservationRef.current = reservation;
      const result = await voiceCallAudioCoordinatorRef.current!.accept(reservation);
      if (generation !== voiceCallGenerationRef.current) return;

      if (result.status === 'connected') {
        const runtimeSettings = await runtimeSettingsPromise;
        voiceCallRuntimeSettingsRef.current = runtimeSettings;
        clearVoiceCallBackgroundCleanupTimer();
        const snapshot = voiceCallRoomBridge.getSnapshot();
        if (snapshot.status === 'idle' || snapshot.status === 'failed') {
          void finishLiveKitVoiceCall('remote-disconnect');
          return;
        }
        const callStartedAt = Date.now();
        voiceCallConnectedRef.current = true;
        markVoiceCallDiagnosticConnected();
        setVoiceCallRoomSnapshot(snapshot);
        setVoiceCallStartedAt(callStartedAt);
        setVoiceCallState('active');
        if (snapshot.callId) {
          const config = aiConfigRef.current;
          const collector = new VoiceCallRecordCollector({
            callId: snapshot.callId,
            direction: activeDescriptor.direction === 'incoming' ? 'incoming' : 'test',
            startedAt: callStartedAt,
          });
          voiceCallRecordCollectorRef.current = collector;
          queueVoiceCallRecordDraft(collector);
          void loadChatStateFast({ activeMessageLimit: 1 }).then((chatState) => {
            if (voiceCallRecordCollectorRef.current !== collector) return;
            collector.setTargetSessionId(chatState.activeSessionId);
            queueVoiceCallRecordDraft(collector);
          }).catch(() => undefined);
          voiceCallAuditionUsedRef.current = false;
          setVoiceCallBrainSnapshot(initialBaiyunCallBrainSnapshot);
          setVoiceCallAuditionState('idle');
          const openingPrompt = activeDescriptor.origin === 'scheduled'
            ? [
                BAIYUN_SCHEDULED_CALL_OPENING_PROMPT,
                activeDescriptor.scheduledAt && activeDescriptor.note
                  ? buildScheduledVoiceCallMaterial(activeDescriptor.scheduledAt, activeDescriptor.note)
                  : '',
              ].filter(Boolean).join('\n\n')
            : activeDescriptor.origin === 'autonomous'
              ? BAIYUN_AUTONOMOUS_CALL_OPENING_PROMPT
              : undefined;
          const session = new BaiyunCallBrainSession({
            apiKey: config.chatKey,
            callId: snapshot.callId,
            connection: config.chatConnection ?? null,
            direction: activeDescriptor.direction === 'incoming' ? 'I-outgoing' : 'test',
            emotion2vecEnabled: snapshot.emotion2vecEnabled,
            openingPrompt,
            onDiagnostic: (event, details) => {
              if (generation !== voiceCallGenerationRef.current) return;
              voiceCallRoomBridge.sendDiagnostic(event, details);
            },
            onMemoryUsagePrepared: (turnId, receipt) => {
              if (generation !== voiceCallGenerationRef.current) return;
              voiceCallRecordCollectorRef.current?.recordMemoryUsage(turnId, receipt);
              queueVoiceCallRecordDraft();
            },
            onSnapshot: (nextSnapshot) => {
              if (generation !== voiceCallGenerationRef.current) return;
              if (nextSnapshot.status === 'ready' && nextSnapshot.replyText && nextSnapshot.turnId) {
                voiceCallRecordCollectorRef.current?.recordIReply({
                  at: nextSnapshot.generatedAt,
                  text: nextSnapshot.replyText,
                  turnId: nextSnapshot.turnId,
                });
                queueVoiceCallRecordDraft();
              }
              setVoiceCallBrainSnapshot(nextSnapshot);
              if (
                nextSnapshot.status === 'ready'
                && (nextSnapshot.playbackIntent === 'care_auto' || nextSnapshot.playbackIntent === 'opening_auto')
                && nextSnapshot.replyText
                && nextSnapshot.turnId
                && !voiceCallAutomaticPlaybackTurnIdsRef.current.has(nextSnapshot.turnId)
              ) {
                const roomSnapshot = voiceCallRoomBridge.getSnapshot();
                voiceCallAutomaticPlaybackTurnIdsRef.current.add(nextSnapshot.turnId);
                setVoiceCallAuditionState('idle');
                if (!roomSnapshot.callId || roomSnapshot.localSpeaking) {
                  voiceCallBrainSessionRef.current?.handlePlaybackRequestFailed(nextSnapshot.turnId);
                  return;
                }
                const callId = roomSnapshot.callId;
                const requestStartedAt = Date.now();
                voiceCallRoomBridge.sendDiagnostic('care_auto_playback_requested', {
                  automaticCareAttempt: nextSnapshot.automaticCareAttempt,
                  careReason: nextSnapshot.careReason,
                  sourceTurnId: nextSnapshot.turnId,
                });
                void requestVoiceCallTestSpeech(
                  callId,
                  nextSnapshot.replyText,
                  roomSnapshot.uplinkMode ?? 'livekit',
                  nextSnapshot.turnId,
                  {
                    dailyLimitUtf8Bytes: voiceCallRuntimeSettingsRef.current.dailyCharacterLimit * 3,
                    intent: nextSnapshot.playbackIntent,
                    perCallNewSynthesisLimit: voiceCallRuntimeSettingsRef.current.maxNewSynthesesPerCall,
                  },
                ).then((speechResult) => {
                  if (generation !== voiceCallGenerationRef.current) return;
                  setVoiceCallBudgetNotice(null);
                  voiceCallRecordCollectorRef.current?.markPlaybackQueued({
                    playbackId: speechResult.data.playbackId,
                    sourceTurnId: speechResult.data.sourceTurnId,
                  });
                  queueVoiceCallRecordDraft();
                  voiceCallRoomBridge.registerQueuedPlayback({
                    callId,
                    playbackId: speechResult.data.playbackId,
                    requestStartedAt,
                    sourceTurnId: speechResult.data.sourceTurnId,
                  });
                  voiceCallRoomBridge.sendDiagnostic('care_auto_playback_queued', {
                    automaticCareAttempt: nextSnapshot.automaticCareAttempt,
                    careReason: nextSnapshot.careReason,
                    latencyMs: Date.now() - requestStartedAt,
                    playbackId: speechResult.data.playbackId,
                    sourceTurnId: speechResult.data.sourceTurnId,
                  });
                }).catch((caught) => {
                  if (generation !== voiceCallGenerationRef.current) return;
                  const message = caught instanceof VoiceCallTokenError
                    ? caught.message
                    : '这次通话照护声音没有启动。';
                  setVoiceCallBudgetNotice(voiceCallTtsTechnicalStatus(caught));
                  voiceCallBrainSessionRef.current?.handlePlaybackRequestFailed(nextSnapshot.turnId);
                  voiceCallRecordCollectorRef.current?.markPlaybackFailed(
                    nextSnapshot.turnId,
                    caught instanceof VoiceCallTokenError ? caught.code : undefined,
                  );
                  queueVoiceCallRecordDraft();
                  voiceCallRoomBridge.sendDiagnostic('care_auto_playback_failed', {
                    automaticCareAttempt: nextSnapshot.automaticCareAttempt,
                    careReason: nextSnapshot.careReason,
                    error: message,
                    latencyMs: Date.now() - requestStartedAt,
                    sourceTurnId: nextSnapshot.turnId,
                  });
                });
                return;
              }
              if (voiceCallAuditionUsedRef.current) return;
              setVoiceCallAuditionState(
                nextSnapshot.status === 'ready' && nextSnapshot.playbackIntent === 'manual'
                  ? 'available'
                  : 'idle',
              );
            },
            profile: config.profile,
            startedAt: callStartedAt,
          });
          voiceCallBrainSessionRef.current = session;
          if (openingPrompt) session.startOpening();
          else session.startCare();
        }
        return;
      }

      const message = messageForVoiceAudioFailure(result);
      voiceCallConnectedRef.current = false;
      const disconnectResult = await voiceCallAudioCoordinatorRef.current!.disconnect(reservation);
      if (generation !== voiceCallGenerationRef.current) return;
      if (!disconnectResult.released) {
        const cleanupMessage = `${message} 电话音频没有安全释放；聊天录音会继续暂停，请重启君落后再试。`;
        setVoiceCallRoomSnapshot((current) => ({
          ...current,
          error: cleanupMessage,
          message: cleanupMessage,
          status: 'failed',
        }));
        return;
      }
      voiceCallRoomBridge.finalizeAttempt(prepared, { error: message, keepListener: true });
      if (voiceCallPreparedAttemptRef.current === prepared) {
        voiceCallPreparedAttemptRef.current = null;
      }
      if (voiceCallAudioReservationRef.current === reservation) {
        voiceCallAudioReservationRef.current = null;
      }
      chatVoiceAudioControlRef.current?.resumeVoiceAudioAfterCall();
      setVoiceCallAudioReserved(false);
      setVoiceCallRoomSnapshot(voiceCallRoomBridge.getSnapshot());
    }).finally(() => {
      if (voiceCallAcceptPromiseRef.current === acceptPromise) {
        voiceCallAcceptPromiseRef.current = null;
      }
    });
    voiceCallAcceptPromiseRef.current = acceptPromise;
  }, [clearVoiceCallBackgroundCleanupTimer, clearVoiceCallTransitionTimer, finishLiveKitVoiceCall, voiceCallMode, voiceCallState]);

  useEffect(() => {
    voiceCallAcceptHandlerRef.current = acceptVoiceCall;
  }, [acceptVoiceCall]);

  useEffect(() => {
    let mounted = true;
    let pendingIncomingVersion = 0;
    let pendingIncomingInvitationId: string | null = null;
    const handleIncomingAction = async (event: IncomingCallNativeAction | null) => {
      if (!mounted || !event?.invitationId) return;
      const actionKey = `${event.invitationId}:${event.action}:${event.updatedAt}`;
      if (handledIncomingCallActionsRef.current.has(actionKey)) return;
      handledIncomingCallActionsRef.current.add(actionKey);
      if ((event.action === 'ringing' || event.action === 'answered')
        && (voiceCallFinishPromiseRef.current || event.action === 'answered' || voiceCallStateRef.current === null)) {
        const version = ++pendingIncomingVersion;
        const finishing = voiceCallFinishPromiseRef.current;
        pendingIncomingInvitationId = finishing ? event.invitationId : null;
        if (finishing) {
          try {
            if (!await finishing || !mounted || version !== pendingIncomingVersion) return;
            const records = await loadNativeIncomingCallRecords();
            if (!mounted || version !== pendingIncomingVersion || voiceCallFinishPromiseRef.current
              || voiceCallAudioCoordinatorRef.current?.isReserved()) return;
            const record = records.find(item => item.invitationId === event!.invitationId);
            if (!record || (record.status !== 'ringing' && record.status !== 'answered')) return;
            event = { ...record, action: record.status };
            const refreshedActionKey = `${event.invitationId}:${event.action}:${event.updatedAt}`;
            if (refreshedActionKey !== actionKey) {
              if (handledIncomingCallActionsRef.current.has(refreshedActionKey)) return;
              handledIncomingCallActionsRef.current.add(refreshedActionKey);
            }
          } catch {
            return;
          } finally {
            if (version === pendingIncomingVersion) pendingIncomingInvitationId = null;
          }
        }
      } else if (event.action !== 'ringing'
        && event.invitationId === (pendingIncomingInvitationId ?? voiceCallDescriptorRef.current.invitationId)) {
        pendingIncomingVersion++;
        pendingIncomingInvitationId = null;
      }
      if (event.action === 'ringing') {
        if (voiceCallStateRef.current !== null) {
          void suppressNativeIncomingCall(event.invitationId);
          void updateVoiceCallInvitationStatus(event.invitationId, 'suppressed_busy', event.updatedAt);
          return;
        }
        void updateVoiceCallInvitationStatus(event.invitationId, 'ringing', event.updatedAt);
        void prewarmBaiyunCallContext({ refresh: true });
        void prewarmVoiceCallSpeech(event.invitationId).catch(() => undefined);
        const descriptor: ActiveVoiceCallDescriptor = {
          direction: 'incoming',
          invitationId: event.invitationId,
          kind: event.kind,
          nativeRinging: true,
          note: event.note,
          origin: event.kind === 'scheduled' ? 'scheduled' : 'autonomous',
          scheduledAt: event.scheduledAt,
        };
        voiceCallDescriptorRef.current = descriptor;
        setVoiceCallDescriptor(descriptor);
        setVoiceCallMode('livekit');
        setVoiceCallRoomSnapshot(voiceCallRoomBridge.getSnapshot());
        setVoiceCallStartedAt(null);
        setVoiceCallState('incoming');
        return;
      }
      if (event.action === 'answered') {
        void updateVoiceCallInvitationStatus(event.invitationId, 'answered', event.updatedAt);
        void prewarmBaiyunCallContext();
        void prewarmVoiceCallSpeech(event.invitationId).catch(() => undefined);
        const descriptor: ActiveVoiceCallDescriptor = {
          direction: 'incoming',
          invitationId: event.invitationId,
          kind: event.kind,
          nativeRinging: true,
          note: event.note,
          origin: event.kind === 'scheduled' ? 'scheduled' : 'autonomous',
          scheduledAt: event.scheduledAt,
        };
        voiceCallDescriptorRef.current = descriptor;
        setVoiceCallDescriptor(descriptor);
        setVoiceCallMode('livekit');
        setVoiceCallState('incoming');
        const acceptVersion = pendingIncomingVersion;
        requestAnimationFrame(() => {
          if (mounted && acceptVersion === pendingIncomingVersion
            && voiceCallDescriptorRef.current.invitationId === descriptor.invitationId) voiceCallAcceptHandlerRef.current();
        });
        return;
      }
      if (event.action === 'suppressed_busy') {
        void updateVoiceCallInvitationStatus(event.invitationId, 'suppressed_busy', event.updatedAt);
        return;
      }
      const status = event.action === 'declined' ? 'declined' : 'timed_out';
      void setNativeIncomingCallUiVisible(false);
      void stopPrewarmedVoiceCallSpeech(event.invitationId).catch(() => undefined);
      void updateVoiceCallInvitationStatus(event.invitationId, status, event.updatedAt);
      setVoiceCallMode(null);
      setVoiceCallState(null);
      setVoiceCallStartedAt(null);
    };
    const unsubscribe = subscribeIncomingCallActions(handleIncomingAction);
    void loadNativeIncomingCallRecords().then((records) => Promise.all(
      records.map((record) => updateVoiceCallInvitationStatus(
        record.invitationId,
        record.status,
        record.updatedAt,
      )),
    )).catch(() => undefined);
    void consumePendingIncomingCallAction().then(handleIncomingAction).catch(() => undefined);
    return () => { mounted = false; pendingIncomingVersion++; unsubscribe(); };
  }, []);

  const acceptVisibleVoiceCall = useCallback(() => {
    if (voiceCallDescriptor.nativeRinging && voiceCallDescriptor.invitationId) {
      void answerNativeIncomingCall(voiceCallDescriptor.invitationId);
      return;
    }
    acceptVoiceCall();
  }, [acceptVoiceCall, voiceCallDescriptor]);

  const auditionVoiceCallReply = useCallback(() => {
    const brainSnapshot = voiceCallBrainSessionRef.current?.getSnapshot();
    const roomSnapshot = voiceCallRoomBridge.getSnapshot();
    if (
      voiceCallAuditionUsedRef.current
      || brainSnapshot?.status !== 'ready'
      || !brainSnapshot.replyText
      || !brainSnapshot.turnId
      || !roomSnapshot.callId
    ) return;
    const generation = voiceCallGenerationRef.current;
    const callId = roomSnapshot.callId;
    const sourceTurnId = brainSnapshot.turnId;
    voiceCallAuditionUsedRef.current = true;
    setVoiceCallAuditionState('requesting');
    const requestStartedAt = Date.now();
    voiceCallRoomBridge.sendDiagnostic('call_reply_audition_started');
    void requestVoiceCallTestSpeech(
      callId,
      brainSnapshot.replyText,
      roomSnapshot.uplinkMode ?? 'livekit',
      sourceTurnId,
      {
        dailyLimitUtf8Bytes: voiceCallRuntimeSettingsRef.current.dailyCharacterLimit * 3,
        intent: 'manual',
        perCallNewSynthesisLimit: voiceCallRuntimeSettingsRef.current.maxNewSynthesesPerCall,
      },
    ).then((speechResult) => {
      if (generation !== voiceCallGenerationRef.current) return;
      setVoiceCallBudgetNotice(null);
      voiceCallRecordCollectorRef.current?.markPlaybackQueued({
        playbackId: speechResult.data.playbackId,
        sourceTurnId: speechResult.data.sourceTurnId,
      });
      queueVoiceCallRecordDraft();
      voiceCallRoomBridge.registerQueuedPlayback({
        callId,
        playbackId: speechResult.data.playbackId,
        requestStartedAt,
        sourceTurnId: speechResult.data.sourceTurnId,
      });
      voiceCallRoomBridge.sendDiagnostic('call_reply_audition_completed', {
        latencyMs: Date.now() - requestStartedAt,
        playbackId: speechResult.data.playbackId,
        reusedConnectionContext: speechResult.reusedConnectionContext,
        sourceTurnId: speechResult.data.sourceTurnId,
      });
      const playbackSnapshot = voiceCallRoomBridge.getSnapshot();
      if (
        playbackSnapshot.playbackId === speechResult.data.playbackId
        && playbackSnapshot.playbackState === 'interrupted'
      ) {
        setVoiceCallAuditionState('interrupted');
      } else if (
        playbackSnapshot.playbackId === speechResult.data.playbackId
        && playbackSnapshot.playbackState === 'failed'
      ) {
        setVoiceCallAuditionState('failed');
      } else {
        setVoiceCallAuditionState('used');
      }
    }).catch((caught) => {
      if (generation !== voiceCallGenerationRef.current) return;
      const message = caught instanceof VoiceCallTokenError
        ? caught.message
        : '这次试听没有启动。';
      voiceCallRoomBridge.sendDiagnostic('call_reply_audition_failed', {
        error: message,
        latencyMs: Date.now() - requestStartedAt,
      });
      voiceCallRecordCollectorRef.current?.markPlaybackFailed(
        sourceTurnId,
        caught instanceof VoiceCallTokenError ? caught.code : undefined,
      );
      queueVoiceCallRecordDraft();
      setVoiceCallBudgetNotice(voiceCallTtsTechnicalStatus(caught));
      setVoiceCallAuditionState(voiceCallAuditionFailureState(caught));
    });
  }, []);

  const hangupVoiceCall = useCallback(() => {
    void setNativeIncomingCallUiVisible(false);
    clearVoiceCallTransitionTimer();
    clearVoiceCallBackgroundCleanupTimer();
    if (
      voiceCallState === 'incoming'
      && voiceCallDescriptor.nativeRinging
      && voiceCallDescriptor.invitationId
    ) {
      void declineNativeIncomingCall(voiceCallDescriptor.invitationId);
      return;
    }
    if (voiceCallMode === 'livekit') {
      void finishLiveKitVoiceCall('hangup');
      return;
    }
    resetVoiceCallBrainSession();
    setVoiceCallMode(null);
    setVoiceCallState(null);
    setVoiceCallStartedAt(null);
    setVoiceCallRoomSnapshot(voiceCallRoomBridge.getSnapshot());
  }, [
    clearVoiceCallBackgroundCleanupTimer,
    clearVoiceCallTransitionTimer,
    finishLiveKitVoiceCall,
    resetVoiceCallBrainSession,
    voiceCallDescriptor,
    voiceCallMode,
    voiceCallState,
  ]);


  useEffect(() => () => {
    if (chatMountFrameRef.current !== null) {
      cancelAnimationFrame(chatMountFrameRef.current);
    }
    clearVoiceCallTransitionTimer();
    clearVoiceCallBackgroundCleanupTimer();
    queueVoiceCallRecordDraft();
    voiceCallBrainSessionRef.current?.stop();
    voiceCallBrainSessionRef.current = null;
    voiceCallGenerationRef.current += 1;
    voiceCallConnectedRef.current = false;
    voiceCallAcceptPromiseRef.current = null;
    const prepared = voiceCallPreparedAttemptRef.current;
    const reservation = voiceCallAudioReservationRef.current;
    prepared?.cancel();
    if (reservation) {
      void voiceCallAudioCoordinatorRef.current!.disconnect(reservation).then((result) => {
        if (result.released && prepared) voiceCallRoomBridge.finalizeAttempt(prepared);
      });
    } else {
      void voiceCallRoomBridge.disconnect();
    }
  }, [clearVoiceCallBackgroundCleanupTimer, clearVoiceCallTransitionTimer]);

  useEffect(() => {
    const handleVoiceCallAppStateChange = (nextState: string) => {
      if (voiceCallMode !== 'livekit' || voiceCallState === null) return;
      voiceCallRoomBridge.sendDiagnostic('app_state_changed', {
        appState: nextState,
        callConnected: voiceCallConnectedRef.current,
      });
      if (nextState === 'active') {
        clearVoiceCallBackgroundCleanupTimer();
        return;
      }
      if (voiceCallConnectedRef.current) {
        clearVoiceCallBackgroundCleanupTimer();
        return;
      }
      if (voiceCallBackgroundCleanupTimerRef.current) return;
      voiceCallBackgroundCleanupTimerRef.current = setTimeout(() => {
        voiceCallBackgroundCleanupTimerRef.current = null;
        void finishLiveKitVoiceCall('background');
      }, VOICE_CALL_BACKGROUND_CLEANUP_DELAY_MS);
    };
    const subscription = AppState.addEventListener('change', handleVoiceCallAppStateChange);
    handleVoiceCallAppStateChange(AppState.currentState);
    return () => subscription.remove();
  }, [clearVoiceCallBackgroundCleanupTimer, finishLiveKitVoiceCall, voiceCallMode, voiceCallState]);

  useEffect(() => {
    if (emergencyRebuildActive) return undefined;
    return startBodySignalCompanionRuntime();
  }, [emergencyRebuildActive]);

  useEffect(() => {
    if (emergencyRebuildActive) return undefined;
    return startBodySignalCareRuntime();
  }, [emergencyRebuildActive]);

  useEffect(() => {
    if (emergencyRebuildActive) return undefined;
    const stopGuardian = startBodySignalGuardianRuntime();
    const stopBattery = startMiBand6BatteryRuntime();
    const stopActivity = startMiBand6ActivityRuntime();
    const stopSleep = startMiBand6SleepRuntime();
    return () => { stopSleep(); stopActivity(); stopBattery(); stopGuardian(); };
  }, [emergencyRebuildActive]);

  const scheduleChatRefresh = (delayMs = 700, afterInteractions = true) => {
    if (chatRefreshTimerRef.current) {
      clearTimeout(chatRefreshTimerRef.current);
      chatRefreshTimerRef.current = null;
    }
    chatRefreshInteractionRef.current?.cancel?.();
    if (!afterInteractions) {
      chatRefreshInteractionRef.current = null;
      setChatRefreshVersion((current) => current + 1);
      return;
    }
    chatRefreshInteractionRef.current = InteractionManager.runAfterInteractions(() => {
      chatRefreshTimerRef.current = setTimeout(() => {
        chatRefreshTimerRef.current = null;
        setChatRefreshVersion((current) => current + 1);
      }, delayMs);
    });
  };

  const schedulePhoneGuardChatRefresh = () => {
    [0, 80, 180, 360, 700, 1100, 1700, 2600, 4200, 6500].forEach((delayMs) => {
      setTimeout(() => {
        setChatRefreshVersion((current) => current + 1);
      }, delayMs);
    });
  };

  const flushPhoneGuardMessageNow = () => {
    [0, 250, 900, 1800].forEach((delayMs) => {
      setTimeout(() => {
        void probePhoneActivityProactiveMessage({
          runTriggered: async (task) => {
            const result = await runBackupProtectedTask(task);
            return result.ran ? result.value : 0;
          },
        }).then((inserted) => {
          if (inserted) schedulePhoneGuardChatRefresh();
        }).catch(() => undefined);
      }, delayMs);
    });
  };

  const openPhoneGuardChat = () => {
    setScheduleBannerQueue([]);
    setChatMounted(true);
    setScreen('chat');
    schedulePhoneGuardChatRefresh();
    flushPhoneGuardMessageNow();
  };

  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener('junluoPhoneGuardLaunch', (request: PhoneGuardLaunchRequest) => {
      if (!isFreshPhoneGuardLaunchRequest(request)) return;
      openPhoneGuardChat();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => () => {
    chatRefreshInteractionRef.current?.cancel?.();
    if (chatRefreshTimerRef.current) clearTimeout(chatRefreshTimerRef.current);
  }, []);

  const enqueueScheduleMessages = (messages: SubjectiveMessage[]) => {
    if (AppState.currentState !== 'active' || screenRef.current === 'chat') return;
    const additions = messages
      .filter((message) =>
        message.source === 'schedule-reminder'
        || message.source === 'todo-reminder'
        || message.source === 'schedule-companion'
        || message.source === 'period-companion',
      )
      .filter((message) => {
        if (queuedScheduleMessageIdsRef.current.has(message.id)) return false;
        queuedScheduleMessageIdsRef.current.add(message.id);
        return true;
      })
      .map((message) => ({ message }));
    if (additions.length) setScheduleBannerQueue((current) => [...current, ...additions]);
  };

  const dismissScheduleBanner = () => {
    setScheduleBannerQueue((current) => current.slice(1));
  };

  const openChatFromMessageSurface = () => {
    setScheduleBannerQueue([]);
    if (screenRef.current !== 'focus') navigate('chat');
    scheduleChatRefresh(700);
  };

  const consumePhoneGuardChatLaunch = () => {
    void consumePhoneGuardLaunchRequest()
      .then((request) => {
        if (!isFreshPhoneGuardLaunchRequest(request)) return;
        openPhoneGuardChat();
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    if (!scheduleBannerQueue.length) return undefined;
    const timer = setTimeout(dismissScheduleBanner, 6000);
    return () => clearTimeout(timer);
  }, [scheduleBannerQueue[0]?.message.id]);

  useEffect(() => {
    if (emergencyRebuildActive) return;
    if (isFreshPhoneGuardLaunchRequest(initialPhoneGuardLaunchRef.current)) {
      schedulePhoneGuardChatRefresh();
      flushPhoneGuardMessageNow();
      initialPhoneGuardLaunchRef.current = null;
    }
    void loadPhoneActivityProactiveSettings().then(savePhoneActivityProactiveSettings);
    void backfillTimeBasedGoalCredits().catch(() => undefined);
    consumePhoneGuardChatLaunch();
  }, [emergencyRebuildActive]);

  useEffect(() => {
    if (backgroundSettings.mode === 'fixed') return;

    const refreshSkyNow = () => {
      setSkyNow((current) => {
        const next = new Date();
        return isSameSkyTheme(getCurrentSkyTheme(current), getCurrentSkyTheme(next)) ? current : next;
      });
    };
    const intervalId = setInterval(refreshSkyNow, SKY_THEME_REFRESH_INTERVAL_MS);
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        refreshSkyNow();
      }
    });

    return () => {
      clearInterval(intervalId);
      appStateSubscription.remove();
    };
  }, [backgroundSettings.mode]);

  useAppRuntimeScheduler({
    chatConnection,
    chatKey,
    consumePhoneGuardChatLaunch,
    enabled: aiConfigLoaded && !emergencyRebuildActive,
    enqueueScheduleMessages,
    handledNotificationResponseIdsRef,
    isChatMessageNotificationData: (value) => isChatMessageNotificationData(
      value as Record<string, unknown> | undefined,
    ),
    isReminderNotificationData: (value) => isReminderNotificationData(
      value as Record<string, unknown> | undefined,
    ),
    memoryOrganizerConnection,
    memoryOrganizerKey,
    navigate,
    onOpenShiyingNotification: openShiyingNotification,
    openChatFromMessageSurface,
    profile,
    scheduleChatRefresh,
    screenRef,
  });
  useAutomaticDataSyncScheduler({
    screen,
    screenRef,
    chatBusy: chatAutomaticSyncBusy,
    exclusiveBusy: automaticSyncExclusiveBusy || emergencyRebuildActive,
    voiceCallActive: voiceCallState !== null,
  });

  useEffect(() => {
    if (!aiConfigLoaded) return;
    let mounted = true;
    void loadProactiveMessageSettings().then((settings) => {
      if (!mounted || settings.firstPromptAnswered) return;
      Alert.alert('允许白云小姐偶尔探头吗？', '白天你很久没说话时，她可以偶尔判断要不要给你留一句话。', [
        {
          text: '先不要',
          style: 'cancel',
          onPress: () => void saveProactiveMessageSettings({ ...settings, firstPromptAnswered: true, enabled: false }),
        },
        {
          text: '允许',
          onPress: () => {
            void requestNotificationPermission();
            void saveProactiveMessageSettings({ ...settings, firstPromptAnswered: true, enabled: true });
          },
        },
      ]);
    });
    return () => {
      mounted = false;
    };
  }, [aiConfigLoaded]);

  return (
    <View style={[styles.root, usesSkySurface ? { backgroundColor: skyBottomColor } : null]}>
      <StatusBar
        style={usesSkySurface && homeReadability.headerText === 'light' ? 'light' : 'dark'}
        translucent
      />
      {homeMounted ? (
        <View
          pointerEvents={screen === 'home' ? 'auto' : 'none'}
          style={[styles.homeHost, screen !== 'home' && styles.dormantHome]}
        >
          <HomeScreen
            active={screen === 'home'}
            backgroundReadability={homeReadability}
            backgroundSettings={backgroundSettings}
            navigate={navigate}
            skyTheme={sky}
            weatherAnimationsEnabled={weatherAnimationsEnabled}
          />
        </View>
      ) : null}
      {screen === 'chat' && !chatMounted ? (
        <SafeAreaView style={[styles.chatLoadingShell, { backgroundColor: skyBottomColor }]}>
          <ActivityIndicator color={colors.primary} />
        </SafeAreaView>
      ) : null}
      {chatMounted ? (
        <View style={[styles.chatHost, screen !== 'chat' && styles.hiddenScreen]}>
          <ChatScreen
            theaterBackstage={theater.runtime?.backstageOwner.port}
            pendingReadingReference={pendingReadingReference}
            onReadingReferenceSaved={clearSavedReadingReference}
            onRemoveReadingReference={() => setPendingReadingReference(null)}
            active={screen === 'chat' || phoneLockChatVisible}
            phoneLockChatVisible={phoneLockChatVisible}
            backgroundReadability={homeReadability}
            backgroundSettings={backgroundSettings}
            navigate={navigate}
            onAutomaticSyncBusyChange={setChatAutomaticSyncBusy}
            onVoiceAudioControlChange={handleChatVoiceAudioControlChange}
            externalMessageVersion={chatRefreshVersion}
            skyTheme={sky}
            voiceCallAudioActive={voiceCallAudioReserved}
          />
        </View>
      ) : null}
      {screen === 'memory' ? (
        <SafeAreaView style={styles.safeArea}>
          <MemoryScreen navigate={navigate} />
        </SafeAreaView>
      ) : null}
      {screen === 'memory-maintenance' ? (
        <SafeAreaView style={styles.safeArea}>
          <MemoryDuplicateCleanupScreen navigate={navigate} />
        </SafeAreaView>
      ) : null}
      {screen === 'memory-current-states' || screen === 'memory-understandings' || screen === 'memory-pending' ? (
        <SafeAreaView style={styles.safeArea}>
          <MemoryBrowserScreen key={screen} navigate={navigate} section={screen === 'memory-current-states' ? 'current_states' : screen === 'memory-understandings' ? 'understandings' : 'pending'} />
        </SafeAreaView>
      ) : null}
      {screen === 'letter' ? (
        <SafeAreaView style={styles.safeArea}>
          <LetterScreen navigate={navigate} />
        </SafeAreaView>
      ) : null}
      {screen === 'co-reading' ? (
        <SafeAreaView style={styles.safeArea}>
          <CoReadingScreen navigate={navigate} onBringToChat={(book) => {
            setPendingReadingReference(referenceFromBook(book));
            navigate('chat');
          }} />
        </SafeAreaView>
      ) : null}
      {screen === 'favorites' ? (
        <SafeAreaView style={styles.safeArea}>
          <FavoritesScreen navigate={navigate} />
        </SafeAreaView>
      ) : null}
      {screen === 'expense' ? (
        <SafeAreaView style={styles.safeArea}>
          <ExpenseScreen navigate={navigate} />
        </SafeAreaView>
      ) : null}
      {screen === 'period' ? (
        <PeriodScreen
          theater={theater}
          initialBodyData={bodyDataDestination}
          shiyingOpenRequest={shiyingOpenRequest}
          onShiyingOpenRequestConsumed={consumeShiyingOpenRequest}
          backgroundReadability={homeReadability}
          backgroundSettings={backgroundSettings}
          navigate={navigate}
          skyTheme={sky}
        />
      ) : null}
      {focusMounted ? (
        <View style={[styles.focusHost, screen !== 'focus' && styles.hiddenScreen]}>
        <FocusScreen
          active={screen === 'focus'}
          backgroundSettings={backgroundSettings}
          navigate={navigate}
          skyTheme={sky}
        />
        </View>
      ) : null}
      {scheduleMounted ? (
        <SafeAreaView style={[styles.safeArea, screen !== 'schedule' && styles.hiddenScreen]}>
          <ScheduleScreen active={screen === 'schedule'} navigate={navigate} />
        </SafeAreaView>
      ) : null}
      {screen === 'assistant-diary' ? (
        <SafeAreaView style={styles.safeArea}>
          <AssistantDiaryScreen navigate={navigate} />
        </SafeAreaView>
      ) : null}
      {screen === 'social-drafts' ? (
        <SafeAreaView style={styles.safeArea}>
          <SocialDraftBoxScreen navigate={navigate} />
        </SafeAreaView>
      ) : null}
      {screen === 'today-timeline' ? (
        <TodayTimelineScreen
          backgroundSettings={backgroundSettings}
          navigate={navigate}
          skyTheme={sky}
        />
      ) : null}
      {screen === 'settings' ? (
        <InsetsSafeAreaView style={styles.safeArea}>
          <SettingsScreen navigate={navigate} />
        </InsetsSafeAreaView>
      ) : null}
      {screen === 'device-sync' ? (
        <SafeAreaView style={styles.safeArea}>
          <DeviceSyncSettingsScreen
            navigate={navigate}
            onAutomaticSyncExclusiveBusyChange={setAutomaticSyncExclusiveBusy}
          />
        </SafeAreaView>
      ) : null}
      {screen === 'tool-settings' ? (
        <SafeAreaView style={styles.safeArea}>
          <ToolSettingsScreen navigate={navigate} />
        </SafeAreaView>
      ) : null}
      {screen === 'appearance' ? (
        <SafeAreaView style={styles.safeArea}>
          <AppearanceSettingsScreen
            navigate={navigate}
            weatherAnimationsEnabled={weatherAnimationsEnabled}
            setWeatherAnimationsEnabled={setWeatherAnimationsEnabled}
          />
        </SafeAreaView>
      ) : null}
      {isAiSettingsSection(screen) ? (
        <InsetsSafeAreaView style={styles.safeArea}>
          <AiSettingsScreen key={screen} section={screen} navigate={navigate} />
        </InsetsSafeAreaView>
      ) : null}
      {screen === 'prompt-diagnostics' ? (
        <SafeAreaView style={styles.safeArea}>
          <PromptDiagnosticsScreen navigate={navigate} />
        </SafeAreaView>
      ) : null}
      {screen === 'voice-call-settings' ? (
        <SafeAreaView style={styles.safeArea}>
          <VoiceCallSettingsScreen
            navigate={navigate}
            onStartRealVoiceCallTest={startRealVoiceCallTest}
            onStartVoiceCallTest={startTestVoiceCall}
          />
        </SafeAreaView>
      ) : null}
      {screen === 'nearby-world' ? (
        <SafeAreaView style={styles.safeArea}>
          <NearbyWorldSettingsScreen navigate={navigate} />
        </SafeAreaView>
      ) : null}
      {screen === 'camera-perception' ? (
        <CameraPerceptionSettingsScreen navigate={navigate} />
      ) : null}
      {screen === 'camera-observation-history' ? (
        <CameraObservationHistoryScreen navigate={navigate} />
      ) : null}
      {screen === 'body-signal-activity' ? <BodySignalActivityScreen navigate={navigate} onOpenBodyData={openBodyData} /> : null}
      {screen === 'body-signal-sleep' ? <BodySignalSleepScreen navigate={navigate} onOpenBodyData={openBodyData} /> : null}
      {screen === 'body-signal' ? (
        <SafeAreaView style={styles.safeArea}>
          <BodySignalScreen navigate={navigate} onOpenBodyData={openBodyData} />
        </SafeAreaView>
      ) : null}

      {screen === 'backup' ? (
        <SafeAreaView style={styles.safeArea}>
          <BackupScreen navigate={navigate} />
        </SafeAreaView>
      ) : null}
      {screen === 'secret-package' ? (
        <SafeAreaView style={styles.safeArea}>
          <SecretPackageScreen navigate={navigate} />
        </SafeAreaView>
      ) : null}
      {scheduleBannerQueue[0] && screen !== 'chat' ? (
        <ScheduleMessageBanner
          item={scheduleBannerQueue[0]}
          onClose={dismissScheduleBanner}
          onOpen={openChatFromMessageSurface}
        />
      ) : null}
      <AutomaticDataSyncCapsule
        hidden={
          voiceCallState !== null
          || screen === 'camera-perception'
          || screen === 'camera-observation-history'
          || screen === 'backup'
          || screen === 'secret-package'
        }
        navigate={navigate}
      />
      <VoiceCallOverlay
        auditionState={voiceCallAuditionState}
        brainSnapshot={voiceCallMode === 'livekit' && voiceCallState === 'active' ? voiceCallBrainSnapshot : undefined}
        callStartedAt={voiceCallStartedAt}
        nativeRinging={voiceCallDescriptor.nativeRinging === true}
        onAccept={acceptVisibleVoiceCall}
        onAuditionReply={auditionVoiceCallReply}
        onHangup={hangupVoiceCall}
        onMissed={closeVoiceCall}
        roomSnapshot={voiceCallMode === 'livekit' ? voiceCallRoomSnapshot : undefined}
        state={voiceCallState}
        technicalNotices={[voiceCallBudgetNotice, voiceCallDurationNotice].filter((item): item is string => Boolean(item))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  backupRecoveryRoot: {
    alignItems: 'center',
    backgroundColor: '#FFF9F4',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  backupRecoveryTitle: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 10,
    textAlign: 'center',
  },
  backupRecoveryText: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
  },
  backupRecoveryButton: {
    backgroundColor: '#EE8D7D',
    borderRadius: 14,
    marginTop: 20,
    paddingHorizontal: 22,
    paddingVertical: 13,
  },
  backupRecoveryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  backupRecoveryButtonDisabled: {
    opacity: 0.6,
  },
  root: {
    flex: 1,
    backgroundColor: colors.skyFallback,
  },
  safeArea: {
    flex: 1,
  },
  chatHost: {
    flex: 1,
  },
  homeHost: {
    ...StyleSheet.absoluteFillObject,
  },
  dormantHome: {
    opacity: 0,
  },
  chatLoadingShell: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  focusHost: {
    flex: 1,
  },
  hiddenScreen: {
    display: 'none',
  },
});

