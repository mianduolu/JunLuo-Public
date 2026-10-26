import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { loadChatSessionSnapshot } from '../chat/chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';

import {
  checkCameraPermission,
  openCameraPermissionSettings,
  requestCameraPermissionFromUserAction,
  type CameraPermissionStatus,
} from '../camera/cameraPermission';
import { cameraManualActionsRuntime, useCameraManualActionsRuntime } from '../camera/cameraManualActionsRuntime';
import { syncAutomaticObservationPolicy } from '../camera/cameraAutomaticObservationRuntime';
import { CameraVisionStructuredResultView } from '../camera/CameraVisionStructuredResultView';
import { getCameraObservationHistorySummary, getCameraObservationResponse, subscribeSavedCameraObservations } from '../camera/cameraObservationStore';
import type { CameraObservationHistorySummary, CameraObservationResponseBinding, CameraObservationTimelineItem } from '../camera/cameraObservationTypes';
import {
  describeCameraObservationResponseStatus,
  loadCameraManualReplyPreference,
  saveCameraManualReplyPreference,
} from '../camera/cameraManualReplyPreference';
import { armFreshCameraManualReply } from '../camera/cameraObservationResponseDelivery';
import {
  describeCameraVisionErrorCode,
  runCameraVisionStructuredFixtureSelfTest,
  type CameraVisionTransportDiagnostic,
  type CameraVisionValidationIssue,
} from '../camera/cameraVisionStructured';
import { cameraFramePrivacyRuntime, useCameraFramePrivacyRuntime } from '../camera/cameraFramePrivacyRuntime';
import { cameraPerceptionNative } from '../camera/cameraPerceptionNative';
import { useProactiveControlStatus } from '../proactive/useProactiveControlStatus';
import { proactiveContactDeviceLabel, proactiveContactSourceLabel, proactiveContactWaitLabel } from '../proactive/proactiveControlPresentation';
import { cameraPerceptionRuntime, useCameraPerceptionRuntime } from '../camera/cameraPerceptionRuntime';
import {
  cameraCaptureConditionFailure,
  describeCameraCaptureConditionFailure,
  describeCameraRuntimeConditions,
} from '../camera/cameraRuntimeConditions';
import { cameraPreviewRuntime, useCameraPreviewRuntime } from '../camera/cameraPreviewRuntime';
import { JunLuoCameraPreview } from '../camera/cameraPreviewView';
import {
  CAMERA_INTERVAL_MAX_MINUTES,
  CAMERA_INTERVAL_MIN_MINUTES,
  CAMERA_INTERVAL_STEP_MINUTES,
  CAMERA_QUIET_TIME_STEP_MINUTES,
  getDefaultCameraPerceptionSettings,
  loadCameraPerceptionSettings,
  saveCameraPerceptionSettings,
  type CameraPerceptionSettings,
} from '../camera/cameraPerceptionSettings';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';

type Props = { navigate: Navigate };
type Notice = { kind: 'ok' | 'warning'; text: string };

function formatVisionTransportDiagnostic(
  diagnostic?: CameraVisionTransportDiagnostic,
  validationIssues?: Partial<Record<1 | 2, readonly CameraVisionValidationIssue[]>>,
) {
  if (!diagnostic) return '';
  const validationDetail = ([1, 2] as const)
    .flatMap((attemptNumber) => {
      const issues = validationIssues?.[attemptNumber];
      if (!issues?.length) return [];
      const detail = issues
        .slice(0, 4)
        .map((issue) => `${issue.code}（${issue.path}：${issue.message}）`)
        .join('；');
      return [`第${attemptNumber}轮校验 ${detail}`];
    })
    .join(' · ');
  const validationSuffix = validationDetail ? ` · ${validationDetail}` : '';
  return `第 ${diagnostic.attemptNumber}/2 轮 · ${diagnostic.elapsedMs} ms · JSON mode ${diagnostic.responseFormatRequested ? '开' : '关'} · HTTP ${diagnostic.httpStatus ?? '无'} · ${diagnostic.stage} · progress ${diagnostic.progressEventCount} · SSE ${diagnostic.dataEventCount} · 正文 ${diagnostic.contentCharacterCount} 字 · reasoning ${diagnostic.reasoningEventCount} · DONE ${diagnostic.doneReceived ? '是' : '否'} · 分块损坏 ${diagnostic.malformed ? '是' : '否'}${validationSuffix}`;
}
const CAMERA_PREVIEW_FIRST_FRAME_REVEAL_DELAY_MS = 120;
const CAMERA_SETTINGS_LOAD_TIMEOUT_MS = 5_000;

function wrapMinuteOfDay(value: number) {
  return ((value % 1440) + 1440) % 1440;
}

function formatMinuteOfDay(value: number) {
  const normalized = wrapMinuteOfDay(value);
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function formatObservationTime(value?: number) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无';
}

function describePermission(status: CameraPermissionStatus) {
  if (status === 'granted') return '已授权';
  if (status === 'blocked') return '需到系统设置';
  if (status === 'denied') return '本次已拒绝';
  if (status === 'checking') return '检查中';
  if (status === 'unavailable') return '当前平台不可用';
  return '未授权';
}

function describeSession(status: string) {
  if (status === 'starting') return '启动中';
  if (status === 'paused_camera_busy') return '为手动拍照暂停';
  if (status === 'stopping') return '停止中';
  if (status === 'error') return '会话错误';
  if (status === 'running') return '运行中';
  return '未运行';
}

function describePreview(phase: string) {
  if (phase === 'starting') return '启动中';
  if (phase === 'switching') return '切换镜头中';
  if (phase === 'streaming') return '页面预览中';
  if (phase === 'suspended') return '已离页暂停';
  if (phase === 'error') return '预览错误';
  return '摄像头未开启';
}

function describeManualAction(phase: string) {
  if (phase === 'preparing') return '正在检查看图配置';
  if (phase === 'capturing') return '正在抓取一张画面';
  if (phase === 'understanding') return '正在调用一次看图模型';
  if (phase === 'repairing') return 'I 有几处想再确认';
  if (phase === 'cleaning') return '正在清理临时帧';
  if (phase === 'saving') return '正在写入并校验目标文件';
  if (phase === 'cancelled') return '本次动作已取消';
  if (phase === 'error') return '本次动作失败';
  return '当前没有进行中的单次动作';
}

function describeCleanupState(state?: string) {
  if (state === 'verified_deleted') return '已验证删除';
  if (state === 'deleting' || state === 'retrying') return '正在重试';
  if (state === 'failed') return '清理失败';
  return '暂无';
}

function describeAutomaticPhase(phase?: string) {
  if (phase === 'waiting_minimum') return '等待最小间隔';
  if (phase === 'opportunity_open') return '观察机会已开放';
  if (phase === 'quiet_paused') return '静默暂停';
  if (phase === 'prerequisite_blocked') return '前置条件受限';
  if (phase === 'executing') return '正在完成本次观察';
  return '未运行';
}

function StatusLine({
  label,
  value,
  valueLines = 1,
}: {
  label: string;
  value: string;
  valueLines?: 1 | 2;
}) {
  const multiline = valueLines === 2;
  return (
    <View style={[styles.statusLine, multiline && styles.statusLineMultiline]}>
      <Text style={styles.statusLabel}>{label}</Text>
      <Text
        ellipsizeMode="tail"
        numberOfLines={valueLines}
        style={[styles.statusValue, multiline && styles.statusValueMultiline]}
      >
        {value}
      </Text>
    </View>
  );
}

function Stepper({
  decreaseDisabled,
  increaseDisabled,
  label,
  onDecrease,
  onIncrease,
  value,
}: {
  decreaseDisabled: boolean;
  increaseDisabled: boolean;
  label: string;
  onDecrease(): void;
  onIncrease(): void;
  value: string;
}) {
  return (
    <View style={styles.stepperRow}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperControls}>
        <Pressable disabled={decreaseDisabled} onPress={onDecrease} style={[styles.stepperButton, decreaseDisabled && styles.disabled]}>
          <Text style={styles.stepperButtonText}>－</Text>
        </Pressable>
        <View style={styles.stepperValueBox}><Text style={styles.stepperValue}>{value}</Text></View>
        <Pressable disabled={increaseDisabled} onPress={onIncrease} style={[styles.stepperButton, increaseDisabled && styles.disabled]}>
          <Text style={styles.stepperButtonText}>＋</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Fold({
  children,
  expanded,
  onToggle,
  subtitle,
  title,
}: {
  children: ReactNode;
  expanded: boolean;
  onToggle(): void;
  subtitle: string;
  title: string;
}) {
  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" onPress={onToggle} style={styles.foldHeader}>
        <View style={styles.foldCopy}>
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.cardDetail}>{subtitle}</Text>
        </View>
        <Text style={styles.foldChevron}>{expanded ? '⌃' : '⌄'}</Text>
      </Pressable>
      {expanded ? <View style={styles.foldBody}>{children}</View> : null}
    </View>
  );
}

export function CameraPerceptionSettingsScreen({ navigate }: Props) {
  const contactControlStatus = useProactiveControlStatus();
  const cameraRuntime = useCameraPerceptionRuntime();
  const previewRuntime = useCameraPreviewRuntime(cameraRuntime.session);
  const manualActions = useCameraManualActionsRuntime();
  const framePrivacy = useCameraFramePrivacyRuntime();
  const [settings, setSettings] = useState<CameraPerceptionSettings | null>(null);
  const [settingsAuthoritative, setSettingsAuthoritative] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<CameraPermissionStatus>('checking');
  const [permissionPending, setPermissionPending] = useState(false);
  const [notificationPending, setNotificationPending] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [lookSessionStartPending, setLookSessionStartPending] = useState(false);
  const [sessionStartPending, setSessionStartPending] = useState(false);
  const [automaticDebugResult, setAutomaticDebugResult] = useState('尚未运行');
  const [runtimeConditionsDebugResult, setRuntimeConditionsDebugResult] = useState('尚未模拟');
  const [runtimeConditionsDebugPending, setRuntimeConditionsDebugPending] = useState(false);
  const [facingPending, setFacingPending] = useState<'front' | 'back'>();
  const [frameRevealFacing, setFrameRevealFacing] = useState<'front' | 'back'>();
  const [settingsPending, setSettingsPending] = useState(false);
  const [manualReplyPreference, setManualReplyPreference] = useState<boolean | null>(null);
  const [manualReplyPreferencePending, setManualReplyPreferencePending] = useState(false);
  const [manualReplyStatus, setManualReplyStatus] = useState<CameraObservationTimelineItem['responseStatus']>();
  const [selfTestPending, setSelfTestPending] = useState(false);
  const [bridgeSelfTest, setBridgeSelfTest] = useState('尚未运行');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [manualActionNotice, setManualActionNotice] = useState<Notice | null>(null);
  const [permissionExpanded, setPermissionExpanded] = useState(true);
  const [preferenceExpanded, setPreferenceExpanded] = useState(false);
  const [developerExpanded, setDeveloperExpanded] = useState(false);
  const [privacyExpanded, setPrivacyExpanded] = useState(false);
  const [privacyPending, setPrivacyPending] = useState(false);
  const [privacyDebugResult, setPrivacyDebugResult] = useState('尚未运行');
  const [visionRepairSelfTest, setVisionRepairSelfTest] = useState('尚未运行');
  const [visionFixtureSelfTest, setVisionFixtureSelfTest] = useState('尚未运行');
  const [observationSummary, setObservationSummary] = useState<CameraObservationHistorySummary>({ recordCount: 0 });
  const autoFoldedPermission = useRef(false);
  const manualActionStartInFlight = useRef(false);
  const stopAllRequested = useRef(false);
  const facingActionInFlight = useRef(false);
  const facingCompletionInFlight = useRef<'front' | 'back' | undefined>(undefined);
  const frameRevealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settingsWriteGeneration = useRef(0);
  const transientSessionId = useRef<string | undefined>(undefined);
  const pageMounted = useRef(true);

  const manualActionBusy = lookSessionStartPending || (
    manualActions.phase !== 'idle'
    && manualActions.phase !== 'error'
    && manualActions.phase !== 'cancelled'
  );
  const automaticAttemptExecuting = cameraRuntime.nativeSnapshot?.automaticObservation.phase === 'executing';
  const cameraInteractionBusy = manualActionBusy || automaticAttemptExecuting;
  const runtimeConditions = cameraRuntime.prerequisites?.runtimeConditions;
  const runtimeConditionLabels = describeCameraRuntimeConditions(runtimeConditions);
  const manualCaptureBlocked = Boolean(cameraCaptureConditionFailure(runtimeConditions, 'manual'));
  const previewCaptureBlocked = !previewRuntime.intentSessionId && manualCaptureBlocked;
  const currentSessionId = cameraRuntime.session.status === 'stopped'
    ? undefined
    : cameraRuntime.session.sessionId;

  const stopTransientSession = useCallback(async (
    reasonCode: string,
    refreshAfterStop = true,
  ) => {
    const sessionId = transientSessionId.current;
    if (!sessionId) return false;
    transientSessionId.current = undefined;
    const nativeSnapshot = cameraPerceptionRuntime.getSnapshot().nativeSnapshot;
    if (
      nativeSnapshot?.sessionId === sessionId
      && nativeSnapshot.automaticObservation.enabled
    ) {
      return false;
    }
    const receipt = await cameraPerceptionNative.stop(sessionId, reasonCode);
    if (!receipt.ok) {
      if (receipt.failureCode === 'camera_stale_session') return false;
      if (!transientSessionId.current) transientSessionId.current = sessionId;
      throw new Error(receipt.failureCode ?? 'camera_invalid_bridge_payload');
    }
    if (refreshAfterStop) await cameraPerceptionRuntime.refresh(true);
    return true;
  }, []);

  useEffect(() => {
    if (!runtimeConditions?.thermalPaused) return;
    cameraPreviewRuntime.pauseForThermal();
    // End only this page's idle temporary preview session. An acquired frame
    // and its analysis retain their existing cleanup/commit path first.
    if (sessionStartPending || manualActionBusy || automaticAttemptExecuting || !transientSessionId.current) return;
    void stopTransientSession('thermal_preview_closed').catch((error) => {
      if (pageMounted.current) setNotice({
        kind: 'warning',
        text: `温控已关闭预览，但临时会话收尾失败：${error instanceof Error ? error.message : 'camera_stop_failed'}`,
      });
    });
  }, [automaticAttemptExecuting, manualActionBusy, runtimeConditions?.thermalPaused, sessionStartPending, stopTransientSession]);

  useEffect(() => {
    if (!manualActions.structuredAnalysis) return;
    if (
      cameraRuntime.session.status !== 'stopped'
      && manualActions.lookReceipt?.sessionId !== currentSessionId
    ) {
      cameraManualActionsRuntime.clearPageResults();
    }
  }, [cameraRuntime.session.status, currentSessionId, manualActions.lookReceipt?.sessionId, manualActions.structuredAnalysis]);

  useEffect(() => {
    pageMounted.current = true;
    return () => {
      pageMounted.current = false;
      if (frameRevealTimer.current) clearTimeout(frameRevealTimer.current);
      if (!transientSessionId.current) return;
      stopAllRequested.current = true;
      cameraPreviewRuntime.disableExplicit();
      void cameraManualActionsRuntime.cancelCurrent()
        .catch(() => undefined)
        .then(() => stopTransientSession('page_left', false))
        .catch(() => undefined);
    };
  }, [stopTransientSession]);

  useEffect(() => {
    let mounted = true;
    void loadCameraManualReplyPreference().then((enabled) => {
      if (mounted) setManualReplyPreference(enabled);
    }).catch((error) => {
      if (mounted) setNotice({ kind: 'warning', text: `回应设置无法读取：${error instanceof Error ? error.message : 'camera_manual_reply_preference_unavailable'}` });
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;
    const observationId = manualActions.lookReceipt?.observationId;
    setManualReplyStatus(undefined);
    if (!observationId) return;
    const refresh = () => {
      void getCameraObservationResponse(observationId).then((response) => {
        if (mounted) setManualReplyStatus(response?.status ?? 'not_scheduled');
      }).catch(() => {
        if (mounted) setManualReplyStatus(undefined);
      });
    };
    refresh();
    const unsubscribe = subscribeSavedCameraObservations(refresh);
    return () => { mounted = false; unsubscribe(); };
  }, [manualActions.lookReceipt?.observationId]);

  const refreshPermission = useCallback(async () => {
    const status = await checkCameraPermission();
    setPermissionStatus(status);
    return status;
  }, []);

  const refreshObservationSummary = useCallback(async () => {
    try { setObservationSummary(await getCameraObservationHistorySummary()); }
    catch { /* 历史页会显示可诊断的数据库错误；摄像头主页面保持可用。 */ }
  }, []);

  useEffect(() => {
    let mounted = true;
    const initialWriteGeneration = settingsWriteGeneration.current;
    const fallbackTimer = setTimeout(() => {
      if (!mounted || settingsWriteGeneration.current !== initialWriteGeneration) return;
      setSettings((current) => current ?? getDefaultCameraPerceptionSettings());
      setNotice({ kind: 'warning', text: '摄像头偏好读取较慢，暂时使用默认设置。' });
    }, CAMERA_SETTINGS_LOAD_TIMEOUT_MS);
    void loadCameraPerceptionSettings()
      .then((loaded) => {
        clearTimeout(fallbackTimer);
        if (mounted && settingsWriteGeneration.current === initialWriteGeneration) {
          setSettings(loaded);
          setSettingsAuthoritative(true);
        }
      })
      .catch(() => {
        clearTimeout(fallbackTimer);
        if (!mounted || settingsWriteGeneration.current !== initialWriteGeneration) return;
        setSettings(getDefaultCameraPerceptionSettings());
        setSettingsAuthoritative(false);
        setNotice({ kind: 'warning', text: '摄像头设置暂时无法读取，已使用默认设置。' });
      });
    void Promise.allSettled([
      refreshPermission(),
      cameraPerceptionRuntime.refresh(true),
      refreshObservationSummary(),
    ]);
    return () => {
      mounted = false;
      clearTimeout(fallbackTimer);
    };
  }, [refreshObservationSummary, refreshPermission]);

  useEffect(() => {
    if (!settings || !settingsAuthoritative || cameraRuntime.bridgeStatus !== 'ready') return;
    void syncAutomaticObservationPolicy(
      settings,
      observationSummary.latestCapturedAt,
    ).catch((error) => {
      setNotice({
        kind: 'warning',
        text: `自动调度策略暂时未同步：${error instanceof Error ? error.message : 'camera_automatic_policy_sync_failed'}`,
      });
    });
  }, [cameraRuntime.bridgeStatus, observationSummary.latestCapturedAt, settings, settingsAuthoritative]);

  useEffect(() => {
    if (!cameraRuntime.nativeSnapshot?.lastSuccessfulObservationAt) return;
    void refreshObservationSummary();
  }, [cameraRuntime.nativeSnapshot?.lastSuccessfulObservationAt, refreshObservationSummary]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshPermission();
        void cameraPerceptionRuntime.refresh(true);
        void refreshObservationSummary();
      }
    });
    return () => subscription.remove();
  }, [refreshObservationSummary, refreshPermission]);

  useEffect(() => {
    if (
      !autoFoldedPermission.current &&
      permissionStatus === 'granted' &&
      cameraRuntime.prerequisites?.notificationPermissionGranted &&
      cameraRuntime.prerequisites.notificationChannelVisible
    ) {
      autoFoldedPermission.current = true;
      setPermissionExpanded(false);
    }
  }, [cameraRuntime.prerequisites, permissionStatus]);

  useEffect(() => {
    const proof = framePrivacy.privacy?.latestProof;
    if (
      privacyDebugResult === 'watchdog · waiting_120s'
      && proof?.trigger === 'watchdog'
      && proof.deletionVerified
    ) {
      setPrivacyDebugResult('watchdog · verified_deleted');
    }
  }, [framePrivacy.privacy?.latestProof, privacyDebugResult]);

  useEffect(() => {
    if (!facingPending) return;
    if (previewRuntime.phase === 'streaming' && previewRuntime.actualFacing === facingPending) {
      if (facingCompletionInFlight.current === facingPending) return;
      const completedFacing = facingPending;
      facingCompletionInFlight.current = completedFacing;
      if (frameRevealTimer.current) clearTimeout(frameRevealTimer.current);
      frameRevealTimer.current = setTimeout(() => {
        setFrameRevealFacing((current) => current === completedFacing ? undefined : current);
        frameRevealTimer.current = undefined;
      }, CAMERA_PREVIEW_FIRST_FRAME_REVEAL_DELAY_MS);
      void saveCameraPerceptionSettings({ ...settings!, preferredAndroidFacing: facingPending }).then((saved) => {
        setSettings(saved);
        setNotice({ kind: 'ok', text: '镜头真实切换成功，偏好已保存。' });
      }).catch((error) => {
        setNotice({ kind: 'warning', text: error instanceof Error ? error.message : '镜头偏好没有保存成功。' });
      }).finally(() => {
        facingCompletionInFlight.current = undefined;
        facingActionInFlight.current = false;
        setFacingPending(undefined);
      });
    } else if (previewRuntime.failureCode) {
      if (frameRevealTimer.current) clearTimeout(frameRevealTimer.current);
      frameRevealTimer.current = undefined;
      facingCompletionInFlight.current = undefined;
      setFrameRevealFacing(undefined);
      facingActionInFlight.current = false;
      setFacingPending(undefined);
      setNotice({ kind: 'warning', text: previewRuntime.failureCode });
    }
  }, [facingPending, previewRuntime.actualFacing, previewRuntime.failureCode, previewRuntime.phase, settings]);

  const persistSettings = async (next: CameraPerceptionSettings) => {
    if (settingsPending) return;
    setSettingsPending(true);
    try {
      const saved = await saveCameraPerceptionSettings(next);
      settingsWriteGeneration.current += 1;
      setSettings(saved);
      setSettingsAuthoritative(true);
      if (cameraRuntime.bridgeStatus === 'ready') {
        await syncAutomaticObservationPolicy(saved, observationSummary.latestCapturedAt);
      }
    } catch (error) {
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : '摄像头设置没有保存成功。' });
    }
    finally { setSettingsPending(false); }
  };

  const persistManualReplyPreference = async (enabled: boolean) => {
    if (manualReplyPreference === null || manualReplyPreferencePending || manualActionStartInFlight.current || cameraInteractionBusy) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    setManualReplyPreferencePending(true);
    try {
      const result = await runBackupRestoreDataEpochCommit(dataEpoch, () => saveCameraManualReplyPreference(enabled));
      if (result.committed && pageMounted.current && canCommitBackupRestoreDataEpoch(dataEpoch)) {
        setManualReplyPreference(result.value);
      }
    } catch (error) {
      if (pageMounted.current) setNotice({ kind: 'warning', text: `回应设置没有保存成功：${error instanceof Error ? error.message : 'camera_manual_reply_preference_unavailable'}` });
    } finally {
      if (pageMounted.current) setManualReplyPreferencePending(false);
    }
  };

  const requestPermission = async () => {
    if (permissionPending) return;
    setPermissionPending(true);
    setNotice(null);
    try {
      const status = await requestCameraPermissionFromUserAction();
      setPermissionStatus(status);
      setNotice({ kind: status === 'granted' ? 'ok' : 'warning', text: status === 'granted' ? '摄像头权限当前已允许；预览仍需再次点击开启。' : '本次没有获得摄像头权限。' });
      await cameraPerceptionRuntime.refresh(true);
    } finally { setPermissionPending(false); }
  };

  const openPermissionSettings = async () => {
    if (!(await openCameraPermissionSettings())) setNotice({ kind: 'warning', text: '没有成功打开系统设置。' });
  };

  const requestNotificationPermission = async () => {
    if (notificationPending) return;
    setNotificationPending(true);
    setNotice(null);
    try {
      if (Platform.OS !== 'android') throw new Error('当前平台不支持 Android 摄像头通知。');
      if (Number(Platform.Version) >= 33) {
        const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
        if (result !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('本次没有授予通知权限。');
      }
      await cameraPerceptionRuntime.refresh(true);
      setNotice({ kind: 'ok', text: '通知权限当前可用；预览仍需再次点击开启。' });
    } catch (error) {
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : '通知权限暂时无法检查。' });
    } finally { setNotificationPending(false); }
  };

  const openNotificationSettings = async () => {
    const result = await cameraPerceptionNative.openNotificationSettings();
    if (!result.ok) setNotice({ kind: 'warning', text: '没有成功打开通知设置。' });
  };

  const openSystemSettingsGuide = async () => {
    try { await Linking.openSettings(); }
    catch { setNotice({ kind: 'warning', text: '没有成功打开应用系统设置；请从红米系统设置中找到君落。' }); }
  };

  const checkCaptureConditions = async (kind: 'manual' | 'preview') => {
    const prerequisites = await cameraPerceptionNative.getPrerequisites();
    const failureCode = cameraCaptureConditionFailure(prerequisites.runtimeConditions, kind);
    if (failureCode) throw new Error(failureCode);
  };

  const togglePreview = async () => {
    if (!settings || previewPending || cameraInteractionBusy) return;
    if (previewRuntime.intentSessionId) {
      setPreviewPending(true);
      if (frameRevealTimer.current) clearTimeout(frameRevealTimer.current);
      frameRevealTimer.current = undefined;
      setFrameRevealFacing(undefined);
      cameraPreviewRuntime.disableExplicit();
      try {
        const current = cameraPerceptionRuntime.getSnapshot();
        if (
          current.session.status !== 'stopped'
          && current.session.sessionId === previewRuntime.intentSessionId
          && current.nativeSnapshot?.automaticObservation.enabled !== true
        ) {
          transientSessionId.current ??= current.session.sessionId;
        }
        const stoppedTransient = await stopTransientSession('preview_closed');
        setNotice({
          kind: 'ok',
          text: stoppedTransient
            ? '页面预览和本次临时摄像头会话均已关闭。'
            : '页面预览已关闭；摄像头待命继续运行。',
        });
      } catch (error) {
        setNotice({ kind: 'warning', text: error instanceof Error ? error.message : '临时摄像头会话没有停止成功。' });
      } finally {
        setPreviewPending(false);
      }
      return;
    }
    setPreviewPending(true);
    setNotice(null);
    let createdSessionId: string | undefined;
    try {
      await checkCaptureConditions('preview');
      const current = cameraPerceptionRuntime.getSnapshot();
      const sessionId = current.session.status === 'stopped'
        ? (await cameraPerceptionRuntime.startSession(settings.preferredAndroidFacing)).sessionId
        : current.session.sessionId;
      if (!sessionId) throw new Error('camera_stale_session');
      if (current.session.status === 'stopped') createdSessionId = sessionId;
      if (
        current.session.status === 'stopped'
        || current.nativeSnapshot?.automaticObservation.enabled !== true
      ) {
        transientSessionId.current = sessionId;
      }
      // Native start can settle before React commits the matching render. Seed
      // preview state from native truth so this same explicit tap opens CameraX.
      cameraPreviewRuntime.syncSession(cameraPerceptionRuntime.getSnapshot().session);
      cameraPreviewRuntime.enable(sessionId, settings.preferredAndroidFacing);
      setNotice({ kind: 'ok', text: '页面预览已开启。' });
    } catch (error) {
      if (createdSessionId && transientSessionId.current === createdSessionId) {
        await stopTransientSession('preview_start_failed').catch(() => undefined);
      }
      const code = error instanceof Error ? error.message : '页面预览没有启动。';
      setNotice({ kind: 'warning', text: describeCameraCaptureConditionFailure(code) });
    } finally { setPreviewPending(false); }
  };

  const startCameraStandby = async () => {
    if (!settings || !settingsAuthoritative || sessionStartPending || cameraInteractionBusy) return;
    const before = cameraPerceptionRuntime.getSnapshot();
    if (before.session.status !== 'stopped' && before.session.status !== 'running') return;
    setSessionStartPending(true);
    setNotice(null);
    let createdSessionId: string | undefined;
    try {
      const sessionId = before.session.status === 'stopped'
        ? (await cameraPerceptionRuntime.startSession(settings.preferredAndroidFacing)).sessionId
        : before.session.sessionId;
      if (!sessionId) throw new Error('camera_stale_session');
      if (before.session.status === 'stopped') {
        createdSessionId = sessionId;
        transientSessionId.current = sessionId;
      }
      await syncAutomaticObservationPolicy(
        settings,
        observationSummary.latestCapturedAt,
        { enabled: true },
      );
      if (transientSessionId.current === sessionId) transientSessionId.current = undefined;
      setNotice({ kind: 'ok', text: '摄像头待命已开启；当前没有打开摄像头画面。' });
    } catch (error) {
      if (createdSessionId && transientSessionId.current === createdSessionId) {
        await stopTransientSession('standby_enable_failed').catch(() => undefined);
      }
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : '摄像头待命没有开启。' });
    } finally {
      setSessionStartPending(false);
    }
  };

  const runAutomaticDebug = async (mode: string, value?: number) => {
    try {
      const receipt = await cameraPerceptionNative.runAutomaticDebugCommand(mode, value);
      if (!receipt.ok) throw new Error(receipt.failureCode ?? 'camera_automatic_debug_unavailable');
      await cameraPerceptionRuntime.refresh(true);
      setAutomaticDebugResult(`${mode} · 完成`);
    } catch (error) {
      setAutomaticDebugResult(error instanceof Error ? error.message : 'camera_automatic_debug_unavailable');
    }
  };

  const runRuntimeConditionsDebug = async (input: {
    clear?: boolean;
    batteryPercent?: number;
    charging?: boolean;
    thermalStatus?: number;
  }) => {
    if (!__DEV__ || runtimeConditionsDebugPending) return;
    setRuntimeConditionsDebugPending(true);
    try {
      const receipt = await cameraPerceptionNative.setRuntimeConditionsDebug(input);
      if (!receipt.ok) throw new Error(receipt.failureCode ?? 'camera_automatic_debug_unavailable');
      await cameraPerceptionRuntime.refresh(true);
      setRuntimeConditionsDebugResult(input.clear ? '模拟已清除，重新显示系统读数。' : 'Debug 限制模拟已应用；本次未拍摄、未调用模型。');
    } catch (error) {
      setRuntimeConditionsDebugResult(error instanceof Error ? error.message : 'camera_automatic_debug_unavailable');
    } finally { setRuntimeConditionsDebugPending(false); }
  };

  const stopAll = async () => {
    if (stopPending) return;
    stopAllRequested.current = true;
    setStopPending(true);
    setNotice(null);
    setManualActionNotice(null);
    if (frameRevealTimer.current) clearTimeout(frameRevealTimer.current);
    frameRevealTimer.current = undefined;
    setFrameRevealFacing(undefined);
    cameraPreviewRuntime.disableExplicit();
    transientSessionId.current = undefined;
    try {
      await cameraManualActionsRuntime.cancelCurrent();
      cameraManualActionsRuntime.clearPageResults();
      await cameraPerceptionRuntime.stopSession('user_stop');
      setNotice({ kind: 'ok', text: '摄像头待命、页面预览和当前动作均已停止。' });
    } catch (error) {
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : '摄像头待命暂时没有停止成功。' });
    } finally { setStopPending(false); }
  };

  const selectFacing = async (facing: 'front' | 'back') => {
    if (!settings || facingPending || facingActionInFlight.current || cameraInteractionBusy) return;
    if (previewRuntime.phase === 'streaming' && previewRuntime.actualFacing === facing) return;
    facingActionInFlight.current = true;
    setNotice(null);
    if (previewRuntime.phase === 'streaming') {
      try { await checkCaptureConditions('preview'); }
      catch (error) {
        facingActionInFlight.current = false;
        setNotice({ kind: 'warning', text: describeCameraCaptureConditionFailure(error instanceof Error ? error.message : 'camera_invalid_bridge_payload') });
        return;
      }
      setFacingPending(facing);
      setFrameRevealFacing(facing);
      cameraPreviewRuntime.requestFacing(facing);
      return;
    }
    setFacingPending(facing);
    try {
      if (cameraRuntime.session.status !== 'stopped') {
        await checkCaptureConditions('manual');
        await cameraPerceptionRuntime.switchFacing(facing);
      }
      setSettings(await saveCameraPerceptionSettings({ ...settings, preferredAndroidFacing: facing }));
      setNotice({ kind: 'ok', text: cameraRuntime.session.status === 'stopped' ? '已保存下次启动镜头。' : '镜头检查成功，偏好已保存。' });
    } catch (error) {
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : '镜头没有切换成功。' });
    } finally {
      facingActionInFlight.current = false;
      setFacingPending(undefined);
    }
  };

  const runBridgeSelfTest = async () => {
    if (selfTestPending || previewRuntime.active) return;
    setSelfTestPending(true);
    setBridgeSelfTest('正在通过正式桥抓取一张临时帧…');
    let success: Awaited<ReturnType<typeof cameraPerceptionRuntime.captureFrame>> | undefined;
    try {
      await checkCaptureConditions('manual');
      const receipt = await cameraPerceptionRuntime.captureFrame();
      if ('failureCode' in receipt) throw new Error(receipt.failureCode);
      success = receipt;
      setBridgeSelfTest(`${receipt.sourceKind} · ${receipt.width}×${receipt.height} · rotation ${receipt.rotation} · mirrored=${String(receipt.mirrored)} · ${receipt.byteLength} B · sha ${receipt.sha256.slice(0, 12)}…`);
    } catch (error) {
      setBridgeSelfTest(error instanceof Error ? error.message : '桥接自检失败');
    } finally {
      if (success?.captureSucceeded) {
        try {
          const released = await cameraPerceptionRuntime.releaseFrame(success);
          setBridgeSelfTest((current) => `${current}\n删除回执：${released.released || released.alreadyReleased ? '成功' : '失败'}`);
        } catch (error) {
          setBridgeSelfTest((current) => `${current}\n删除回执：${error instanceof Error ? error.message : '失败'}`);
        }
      }
      setSelfTestPending(false);
    }
  };

  const refreshFramePrivacy = async () => {
    if (privacyPending) return;
    setPrivacyPending(true);
    try {
      await cameraFramePrivacyRuntime.refresh(true);
      setNotice({ kind: 'ok', text: '临时缓存已经重新检查。' });
    } catch (error) {
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : 'camera_frame_privacy_state_unavailable' });
    } finally {
      setPrivacyPending(false);
    }
  };

  const runPrivacyDebugSelfTest = async (mode: 'delete_now' | 'fail_once' | 'fail_all' | 'create_orphan' | 'watchdog') => {
    if (privacyPending) return;
    setPrivacyPending(true);
    try {
      const receipt = await cameraFramePrivacyRuntime.runDebugSelfTest(mode);
      if (mode === 'create_orphan') {
        setPrivacyDebugResult('create_orphan · waiting_startup_scan');
        return;
      }
      if (mode === 'watchdog') {
        setPrivacyDebugResult('watchdog · waiting_120s');
        return;
      }
      let cleanupState = receipt.cleanupState;
      if ((mode === 'fail_once' || mode === 'fail_all') && cleanupState === 'retrying') {
        const deadline = Date.now() + 40_000;
        while (Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
          await cameraFramePrivacyRuntime.refresh(false);
          const latest = cameraFramePrivacyRuntime.getSnapshot().privacy?.lastCleanupState;
          if (latest && latest !== 'deleting' && latest !== 'retrying') {
            cleanupState = latest;
            break;
          }
        }
      }
      setPrivacyDebugResult(`${mode} · ${cleanupState ?? receipt.failureCode ?? '完成'}`);
    } catch (error) {
      setPrivacyDebugResult(error instanceof Error ? error.message : 'camera_frame_privacy_state_unavailable');
    } finally {
      setPrivacyPending(false);
    }
  };

  const waitForRunningSession = (sessionId: string) => new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};

    const finish = (result?: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      unsubscribe();
      if (error) reject(error);
      else resolve(result ?? false);
    };

    const inspect = () => {
      if (stopAllRequested.current) {
        finish(false);
        return;
      }
      const current = cameraPerceptionRuntime.getSnapshot().session;
      if (current.status === 'running' && current.sessionId === sessionId) {
        finish(true);
        return;
      }
      if (current.status !== 'stopped' && current.sessionId !== sessionId) {
        finish(undefined, new Error('camera_stale_session'));
        return;
      }
      if (current.status === 'error' && current.sessionId === sessionId) {
        finish(undefined, new Error(current.lastFailureCode ?? 'camera_not_running'));
      }
    };

    timeout = setTimeout(() => finish(undefined, new Error('camera_start_timeout')), 8_000);
    unsubscribe = cameraPerceptionRuntime.subscribe(inspect);
    inspect();
    if (!settled) void cameraPerceptionRuntime.refresh(true).then(inspect);
  });

  const runLookOnce = async (debugForceRepair = false) => {
    if (!settings || manualActionStartInFlight.current || cameraInteractionBusy) return;
    if (!debugForceRepair && (manualReplyPreference === null || manualReplyPreferencePending)) {
      setNotice({ kind: 'warning', text: '回应设置尚未读取完成；本次没有拍摄。' });
      return;
    }
    const replyRequested = !debugForceRepair && manualReplyPreference === true;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (replyRequested && !canCommitBackupRestoreDataEpoch(dataEpoch)) {
      setNotice({ kind: 'warning', text: '数据正在恢复；本次没有拍摄。' });
      return;
    }
    const actionId = cameraPerceptionNative.newId('camera-look');
    const requestedAt = Date.now();
    const replyBinding: CameraObservationResponseBinding | undefined = replyRequested ? {
      targetSessionId: PRIMARY_CHAT_SESSION_ID,
      origin: 'manual_share',
      sourceTurnId: actionId,
      requestedAt,
    } : undefined;
    manualActionStartInFlight.current = true;
    stopAllRequested.current = false;
    setNotice(null);
    setManualActionNotice(null);
    if (debugForceRepair) setVisionRepairSelfTest('正在强制首轮结构无效并等待再次整理');
    cameraManualActionsRuntime.clearPageResults();
    let stopSessionAfterAction = false;
    let replyObservationId: string | undefined;
    let sessionCleanupSucceeded = true;
    try {
      await checkCaptureConditions('manual');
      if (replyBinding) {
        setLookSessionStartPending(true);
        const chat = await loadChatSessionSnapshot(replyBinding.targetSessionId, { messageLimit: 1 });
        if (!chat || !canCommitBackupRestoreDataEpoch(dataEpoch) || !pageMounted.current || stopAllRequested.current) {
          throw new Error('camera_manual_reply_chat_not_ready');
        }
      }
      const currentSession = cameraPerceptionRuntime.getSnapshot().session;
      if (currentSession.status === 'stopped') {
        setLookSessionStartPending(true);
        const started = await cameraPerceptionRuntime.startSession(
          settings.preferredAndroidFacing,
          { refreshAfterStart: false },
        );
        if (!started.sessionId) throw new Error('camera_invalid_bridge_payload');
        transientSessionId.current = started.sessionId;
        stopSessionAfterAction = true;
        if (!(await waitForRunningSession(started.sessionId))) return;
        setLookSessionStartPending(false);
      } else if (currentSession.status !== 'running') {
        throw new Error(currentSession.status === 'paused_camera_busy' ? 'camera_resource_busy' : 'camera_operation_in_progress');
      } else {
        const current = cameraPerceptionRuntime.getSnapshot();
        const previewOwnsSession = cameraPreviewRuntime.getSnapshot().intentSessionId === currentSession.sessionId;
        if (current.nativeSnapshot?.automaticObservation.enabled !== true) {
          transientSessionId.current ??= currentSession.sessionId;
          stopSessionAfterAction = !previewOwnsSession;
        }
      }
      if (stopAllRequested.current) return;
      const receipt = await cameraManualActionsRuntime.lookOnce({
        debugForceRepair,
        actionId,
        replyBinding,
        dataEpoch: dataEpoch ?? undefined,
      });
      if (replyBinding) replyObservationId = receipt.observationId;
      if (debugForceRepair) {
        setVisionRepairSelfTest(receipt.repairUsed && receipt.analysisAttempts === 2
          ? '通过：首轮无效，只再次整理一次，并得到合法结构'
          : '失败：没有得到预期的两次调用回执');
      }
      await refreshObservationSummary();
      const schedulerSyncError = cameraManualActionsRuntime.getSnapshot().schedulerSyncErrorCode;
      setNotice({
        kind: schedulerSyncError ? 'warning' : 'ok',
        text: schedulerSyncError
          ? `观察记录已保存，但调度锚点暂时未同步：${schedulerSyncError}`
          : '结构化画面整理完成；临时帧已验证删除，观察记录已保存。',
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : '单次图片理解失败。';
      if (stopAllRequested.current && code === 'camera_vision_cancelled') {
        cameraManualActionsRuntime.clearPageResults();
        return;
      }
      const text = code === 'camera_thermal_paused' || code === 'camera_low_battery'
        ? describeCameraCaptureConditionFailure(code)
        : code === 'camera_manual_reply_chat_not_ready'
        ? '主聊天尚未就绪；请先打开聊天。本次没有拍摄，也没有调用模型。'
        : code === 'camera_vision_configuration_required'
        ? '未配置看图模型或 API Key；本次没有抓帧，也没有调用模型。'
        : code === 'camera_observation_persist_failed' || code === 'camera_observation_store_unavailable'
          ? '画面已清理，但观察记录保存失败。'
        : describeCameraVisionErrorCode(code);
      const transportDetail = __DEV__
        ? formatVisionTransportDiagnostic(
          cameraManualActionsRuntime.getSnapshot().visionTransportDiagnostic,
          cameraManualActionsRuntime.getSnapshot().visionValidationIssues,
        )
        : '';
      if (debugForceRepair) setVisionRepairSelfTest(`失败：${text}`);
      setManualActionNotice({ kind: 'warning', text: transportDetail ? `${text}\n${transportDetail}` : text });
    } finally {
      if (replyObservationId && transientSessionId.current) {
        cameraPreviewRuntime.disableExplicit();
        stopSessionAfterAction = true;
      }
      if (stopSessionAfterAction) {
        await stopTransientSession('manual_look_completed').catch((error) => {
          sessionCleanupSucceeded = false;
          setNotice({
            kind: 'warning',
            text: `本次动作已经结束，但临时摄像头会话没有停止：${error instanceof Error ? error.message : 'camera_stop_failed'}`,
          });
        });
      }
      manualActionStartInFlight.current = false;
      setLookSessionStartPending(false);
    }
    if (replyObservationId && sessionCleanupSucceeded && pageMounted.current && !stopAllRequested.current && canCommitBackupRestoreDataEpoch(dataEpoch)) {
      armFreshCameraManualReply(replyObservationId, dataEpoch);
      navigate('chat');
    }
  };

  const chooseSaveDestination = async () => {
    if (manualActionBusy) return;
    setNotice(null);
    try {
      const destination = await cameraManualActionsRuntime.chooseDestination();
      setNotice({ kind: 'ok', text: `保存文件夹已设置为“${destination.directoryDisplayName ?? '已选择的文件夹'}”。` });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'camera_manual_save_cancelled';
      if (code !== 'camera_manual_save_cancelled') setNotice({ kind: 'warning', text: code });
    }
  };

  const clearSaveDestination = async () => {
    if (manualActionBusy) return;
    try {
      await cameraManualActionsRuntime.clearDestination();
      setNotice({ kind: 'ok', text: '已清除长期保存文件夹；没有删除此前保存的照片。' });
    } catch (error) {
      setNotice({ kind: 'warning', text: error instanceof Error ? error.message : '保存位置没有清除成功。' });
    }
  };

  const waitForStreamingPreview = async () => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const current = cameraPreviewRuntime.getSnapshot();
      if (current.active && current.phase === 'streaming') return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };

  const confirmSave = (directory: string, fileName: string) => new Promise<boolean>((resolve) => {
    Alert.alert(
      '保存当前画面',
      `文件夹：${directory}\n文件名：${fileName}\n\n本次保存不会调用视觉模型。`,
      [
        { text: '取消', style: 'cancel', onPress: () => resolve(false) },
        { text: '确认保存', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

  const saveCurrentFrame = async () => {
    if (cameraInteractionBusy || previewRuntime.phase !== 'streaming') return;
    setNotice(null);
    cameraManualActionsRuntime.clearPageResults();
    try {
      await checkCaptureConditions('manual');
      let destination = manualActions.destination;
      if (!destination?.configured || !destination.available) {
        destination = await cameraManualActionsRuntime.chooseDestination();
        if (!(await waitForStreamingPreview())) throw new Error('camera_manual_save_requires_preview');
      }
      const fileName = cameraManualActionsRuntime.previewSaveFileName();
      const confirmed = await confirmSave(destination.directoryDisplayName ?? '已选择的文件夹', fileName);
      if (!confirmed) return;
      const receipt = await cameraManualActionsRuntime.saveCurrentFrame(fileName);
      setNotice({ kind: 'ok', text: `照片已保存并校验：${receipt.fileName}` });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'camera_manual_save_write_failed';
      if (code !== 'camera_manual_save_cancelled') setNotice({ kind: 'warning', text: describeCameraCaptureConditionFailure(code) });
    }
  };

  if (!settings) {
    return <SafeAreaView edges={['top', 'bottom']} style={styles.page}><View style={styles.loading}><ActivityIndicator color="#C95F82" /><Text style={styles.loadingText}>正在读取摄像头偏好…</Text></View></SafeAreaView>;
  }

  const session = cameraRuntime.session;
  const nativeSnapshot = cameraRuntime.nativeSnapshot;
  const sessionActive = session.status !== 'stopped';
  const automaticState = nativeSnapshot?.automaticObservation;
  const standbyEnabled = sessionActive && automaticState?.enabled === true;
  const standbyStateLabel = standbyEnabled
    ? '已开启'
    : sessionActive
      ? '手动使用中'
      : '未开启';
  const lookOnceAvailable = !manualCaptureBlocked && !automaticAttemptExecuting && (session.status === 'stopped' || session.status === 'running');
  const notificationPermissionGranted = cameraRuntime.prerequisites?.notificationPermissionGranted === true;
  const notificationChannelVisible = cameraRuntime.prerequisites?.notificationChannelVisible === true;
  const selectedFacing = facingPending ?? previewRuntime.actualFacing ?? settings.preferredAndroidFacing;
  const previewStreaming = previewRuntime.phase === 'streaming';
  const manualActionPhaseLabel = manualActions.phase === 'capturing'
    && !previewStreaming
    && nativeSnapshot?.cameraState !== 'capturing'
    ? '正在打开摄像头'
    : manualActions.phase === 'understanding'
      ? '画面已抓取，整理中'
      : manualActions.phase === 'repairing'
        ? 'I 有几处想再确认'
      : describeManualAction(manualActions.phase);
  const previewRecovering = Boolean(previewRuntime.intentSessionId)
    && Boolean(previewRuntime.previewWidth && previewRuntime.previewHeight)
    && (previewRuntime.phase === 'off' || previewRuntime.phase === 'suspended' || previewRuntime.phase === 'starting');
  const previewBusy = previewPending || Boolean(frameRevealFacing) || previewRuntime.phase === 'starting' || previewRuntime.phase === 'switching' || previewRecovering;
  const previewStateLabel = previewRuntime.phase === 'suspended' && previewRuntime.intentSessionId
    ? '正在恢复页面预览'
    : describePreview(previewRuntime.phase);
  const previewProgressLabel = previewRecovering
    ? '正在恢复实时预览'
    : previewPending
      ? '正在准备临时会话'
      : frameRevealFacing
        ? `正在显示${frameRevealFacing === 'front' ? '前置' : '后置'}镜头`
        : previewStateLabel;
  const saveActionLabel = manualActions.activeKind === 'save'
    ? describeManualAction(manualActions.phase)
    : '保存当前画面';
  const lookActionLabel = lookSessionStartPending
    ? '正在开启临时会话'
    : manualActions.activeKind === 'look'
      ? manualActionPhaseLabel
      : '现在看一眼';
  const manualActionStatusLabel = lookSessionStartPending
    ? '正在开启临时会话'
    : manualActionPhaseLabel;
  const standbyControlDisabled = standbyEnabled
    ? stopPending || sessionStartPending
    : !settingsAuthoritative
      || sessionStartPending
      || stopPending
      || previewPending
      || cameraInteractionBusy
      || (session.status !== 'stopped' && session.status !== 'running');
  const minDownDisabled = settingsPending || settings.minimumIntervalMinutes <= CAMERA_INTERVAL_MIN_MINUTES;
  const minUpDisabled = settingsPending || settings.minimumIntervalMinutes >= CAMERA_INTERVAL_MAX_MINUTES;
  const quietStartDown = wrapMinuteOfDay(settings.quietHours.startMinuteOfDay - CAMERA_QUIET_TIME_STEP_MINUTES);
  const quietStartUp = wrapMinuteOfDay(settings.quietHours.startMinuteOfDay + CAMERA_QUIET_TIME_STEP_MINUTES);
  const quietEndDown = wrapMinuteOfDay(settings.quietHours.endMinuteOfDay - CAMERA_QUIET_TIME_STEP_MINUTES);
  const quietEndUp = wrapMinuteOfDay(settings.quietHours.endMinuteOfDay + CAMERA_QUIET_TIME_STEP_MINUTES);

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.page}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回设置" onPress={() => navigate('settings')} style={styles.backButton}><Text style={styles.backText}>‹</Text></Pressable>
        <View style={styles.headerCopy}><Text style={styles.eyebrow}>CAMERA PERCEPTION</Text><Text style={styles.title}>白云的视线</Text></View>
        <View style={styles.headerSpacer} />
      </View>
      {manualActionNotice ? <View style={[styles.notice, styles.topNotice, manualActionNotice.kind === 'warning' && styles.noticeWarning]}><Text style={styles.noticeText}>{manualActionNotice.text}</Text></View> : null}

      <ScrollView contentContainerStyle={styles.content} removeClippedSubviews={false} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <View style={styles.heroLens}><View style={styles.heroLensInner} /></View>
          <View style={styles.heroCopy}>
            <Text style={styles.heroKicker}>第十三章 · 模型选择观察</Text>
            <Text style={styles.heroTitle}>在明确待命里，按稀疏节奏偶尔看一眼</Text>
            <Text style={styles.heroDetail}>由你在合适场景开启待命；待命期间按设定节奏偶尔观察，真正观察时才短暂打开摄像头。</Text>
          </View>
        </View>

        <View style={styles.previewCard}>
          <JunLuoCameraPreview
            active={previewRuntime.active}
            generation={previewRuntime.generation}
            onPreviewStateChanged={cameraPreviewRuntime.handleEvent.bind(cameraPreviewRuntime)}
            previewId={previewRuntime.previewId}
            requestedFacing={previewRuntime.requestedFacing}
            sessionId={previewRuntime.intentSessionId}
            style={StyleSheet.absoluteFillObject}
          />
          {!previewStreaming && !previewRecovering ? (
            <View style={styles.previewPlaceholder}>
              <View style={styles.placeholderLens}><View style={styles.placeholderLensDot} /></View>
              <Text style={styles.placeholderTitle}>{previewProgressLabel}</Text>
              <Text style={styles.placeholderDetail}>完整 4:3 画面 · 不裁切 · 不传连续 Base64</Text>
            </View>
          ) : null}
          {previewBusy ? <View style={[styles.loadingOverlay, previewRecovering && styles.recoveryOverlay]}><ActivityIndicator color="#FFFFFF" size="large" /><Text style={styles.loadingOverlayText}>{previewProgressLabel}</Text></View> : null}
          <View style={styles.previewBadges}>
            <Text style={styles.previewBadge}>{selectedFacing === 'front' ? '前置镜头' : '后置镜头'}</Text>
            <Text style={styles.previewBadge}>{previewStreaming ? '页面预览中' : previewStateLabel}</Text>
            <Text style={styles.previewBadge}>请求约 15fps</Text>
          </View>
        </View>

        <View style={[styles.card, styles.controlsCard]}>
          <Pressable
            disabled={standbyControlDisabled}
            onPress={() => void (standbyEnabled ? stopAll() : startCameraStandby())}
            style={[standbyEnabled ? styles.stopButton : styles.primaryButton, standbyControlDisabled && styles.disabled]}
          >
            <Text style={standbyEnabled ? styles.stopButtonText : styles.primaryButtonText}>
              {stopPending
                ? '正在结束摄像头待命'
                : sessionStartPending
                  ? '正在开启摄像头待命'
                  : standbyEnabled
                    ? '结束摄像头待命'
                    : '开启摄像头待命'}
            </Text>
          </Pressable>
          <Pressable disabled={previewCaptureBlocked || previewPending || stopPending || cameraInteractionBusy} onPress={() => void togglePreview()} style={[styles.primaryButton, (previewCaptureBlocked || previewPending || stopPending || cameraInteractionBusy) && styles.disabled]}>
            <Text style={styles.primaryButtonText}>{previewRuntime.intentSessionId ? '关闭预览' : '开启预览'}</Text>
          </Pressable>
          <View style={styles.segmentedControl}>
            {(['front', 'back'] as const).map((facing) => (
               <Pressable disabled={manualCaptureBlocked || Boolean(facingPending) || previewBusy || stopPending || cameraInteractionBusy} key={facing} onPress={() => void selectFacing(facing)} style={[styles.segment, selectedFacing === facing && styles.segmentSelected]}>
                <Text style={[styles.segmentText, selectedFacing === facing && styles.segmentTextSelected]}>{facing === 'front' ? '前置镜头' : '后置镜头'}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={[styles.card, styles.manualActionsCard]}>
          <View>
            <Text style={styles.cardTitle}>单次动作</Text>
            <Text style={styles.cardDetail}>待命未开启时，“现在看一眼”只会临时开启一次摄像头会话，完成后自动停止，不会授予持续待命，也不要求打开实时预览；每次会调用一次已配置的看图模型，可能产生费用。“保存当前画面”仍需先开启预览，且不调用模型。</Text>
          </View>
          <View style={styles.switchRow}>
            <View style={styles.foldCopy}>
              <Text style={styles.sectionLabel}>看完让云云回应</Text>
              <Text style={styles.cardDetail}>{manualReplyPreference === null ? '回应设置尚未读取完成。' : '只用于“现在看一眼”；开启后成功保存观察，再返回主聊天生成回应，可能产生聊天模型费用。关闭时只展示观察结果。'}</Text>
            </View>
            <Switch
              accessibilityLabel="看完让云云回应"
              disabled={manualReplyPreference === null || manualReplyPreferencePending || cameraInteractionBusy}
              onValueChange={(enabled) => void persistManualReplyPreference(enabled)}
              trackColor={{ false: '#F0DDE4', true: '#F2A8BE' }}
              thumbColor={manualReplyPreference ? '#C95F82' : '#FFFFFF'}
              value={manualReplyPreference === true}
            />
          </View>
          <View style={styles.actionButtonsRow}>
            <Pressable disabled={manualActionBusy || !lookOnceAvailable || manualReplyPreference === null || manualReplyPreferencePending} onPress={() => void runLookOnce()} style={[styles.actionButton, styles.lookButton, (manualActionBusy || !lookOnceAvailable || manualReplyPreference === null || manualReplyPreferencePending) && styles.disabled]}>
              <Text style={styles.actionButtonText}>{lookActionLabel}</Text>
            </Pressable>
            <Pressable disabled={manualCaptureBlocked || cameraInteractionBusy || !previewStreaming} onPress={() => void saveCurrentFrame()} style={[styles.actionButton, styles.saveButton, (manualCaptureBlocked || cameraInteractionBusy || !previewStreaming) && styles.disabled]}>
              <Text style={styles.actionButtonText}>{saveActionLabel}</Text>
            </Pressable>
          </View>
          <View style={styles.manualMetaBox}>
            <StatusLine
              label="当前看图模型"
              value={(manualActions.visionModelLabel ?? '未选择').replace(' · ', '\n')}
              valueLines={2}
            />
            <StatusLine label="长期保存文件夹" value={manualActions.destination?.configured ? manualActions.destination.directoryDisplayName ?? '已选择的文件夹' : '尚未选择'} />
            <StatusLine label="动作状态" value={manualActionStatusLabel} />
          </View>
          <View style={styles.destinationButtons}>
            <Pressable disabled={manualActionBusy} onPress={() => void chooseSaveDestination()} style={[styles.compactButton, manualActionBusy && styles.disabled]}>
              <Text style={styles.compactButtonText}>{manualActions.destination?.configured ? '更换文件夹' : '选择文件夹'}</Text>
            </Pressable>
            {manualActions.destination?.configured ? <Pressable disabled={manualActionBusy} onPress={() => void clearSaveDestination()} style={[styles.compactButton, styles.clearButton, manualActionBusy && styles.disabled]}>
              <Text style={styles.compactButtonText}>清除保存位置</Text>
            </Pressable> : null}
          </View>
          {manualActionBusy && manualActions.activeKind === 'look' ? <Pressable onPress={() => void cameraManualActionsRuntime.cancelCurrent()} style={styles.cancelActionButton}><Text style={styles.cancelActionText}>取消本次理解</Text></Pressable> : null}
          {manualActions.structuredAnalysis ? <CameraVisionStructuredResultView analysis={manualActions.structuredAnalysis} deletionLabel="已验证删除" persistenceLabel={`本次结果已写入观察记录；回应状态：${manualReplyStatus ? describeCameraObservationResponseStatus(manualReplyStatus) : '读取中／暂不可用'}。`} /> : null}
          {__DEV__ && manualActions.structuredAnalysis ? <View style={styles.visionPerformanceCard}>
            <Text style={styles.visionPerformanceTitle}>第十章性能诊断</Text>
            {([1, 2] as const).map((attemptNumber) => {
              const diagnostic = manualActions.visionAttemptDiagnostics?.[attemptNumber];
              if (!diagnostic) return null;
              return <Text key={attemptNumber} style={styles.visionPerformanceText}>
                第 {attemptNumber} 轮：{diagnostic.elapsedMs} ms · HTTP {diagnostic.httpStatus ?? '无'} · SSE {diagnostic.dataEventCount}
              </Text>;
            })}
            <Text style={styles.visionPerformanceText}>
              首轮校验：{manualActions.visionFirstValidationIssueCodes?.join('、') || '一次通过'}
            </Text>
          </View> : null}
          {manualActions.saveReceipt ? <View style={styles.receiptCard}>
            <Text style={styles.receiptTitle}>照片保存完成</Text>
            <Text style={styles.receiptText}>{manualActions.saveReceipt.fileName}</Text>
            <Text style={styles.receiptText}>文件夹：{manualActions.saveReceipt.directoryDisplayName} · {manualActions.saveReceipt.byteLength} B</Text>
            <Text style={styles.receiptText}>目标校验：通过 · 源帧清理：{manualActions.saveReceipt.sourceFrameCleanup === 'released' ? '完成' : '重试中'}</Text>
          </View> : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>观察历史</Text>
          <Text style={styles.cardDetail}>结构化结果只在临时帧验证删除、数据库事务提交成功后保存。</Text>
          <View style={styles.statusBlock}>
            <StatusLine label="已保存记录" value={`${observationSummary.recordCount} 条`} />
            <StatusLine label="最近观察" value={formatObservationTime(observationSummary.latestCapturedAt)} valueLines={2} />
          </View>
          <Pressable onPress={() => navigate('camera-observation-history')} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>查看全部观察</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>真实状态</Text>
          <View style={styles.statusBlock}>
            <StatusLine label="页面预览" value={previewStateLabel} />
            <StatusLine label="摄像头待命" value={standbyStateLabel} />
            <StatusLine label="摄像头会话" value={describeSession(session.status)} />
            <StatusLine label="当前主动联系端" value={proactiveContactDeviceLabel(contactControlStatus)} />
            <StatusLine label="共同主动次数" value={contactControlStatus?.used === null || !contactControlStatus ? '尚未确认' : `${contactControlStatus.used} / 12（北京时间）`} />
            <StatusLine label="操作信号" value={proactiveContactSourceLabel(contactControlStatus)} valueLines={2} />
            <StatusLine label="主动协调" value={proactiveContactWaitLabel(contactControlStatus)} valueLines={2} />
            <StatusLine label="原生最近心跳" value={formatObservationTime(nativeSnapshot?.lastHeartbeatAt)} valueLines={2} />
            <StatusLine label="新拍摄条件" value={runtimeConditions ? describeCameraCaptureConditionFailure(cameraCaptureConditionFailure(runtimeConditions, 'model')) : '尚未取得原生条件／旧 APK 未提供'} valueLines={2} />
            <StatusLine label="当前镜头" value={selectedFacing === 'front' ? '前置' : '后置'} />
            <StatusLine label="实际预览尺寸" value={previewRuntime.previewWidth && previewRuntime.previewHeight ? `${previewRuntime.previewWidth}×${previewRuntime.previewHeight}` : '暂无'} />
            <StatusLine label="原生 revision" value={String(nativeSnapshot?.revision ?? 0)} />
            <StatusLine label="观察机会" value={standbyEnabled ? describeAutomaticPhase(automaticState?.phase) : '未运行'} valueLines={2} />
            <StatusLine label="上次成功观察" value={formatObservationTime(observationSummary.latestCapturedAt)} valueLines={2} />
            <StatusLine label="下次最早机会" value={formatObservationTime(automaticState?.nextOpportunityAt)} valueLines={2} />
            <StatusLine label="上次观察尝试" value={formatObservationTime(automaticState?.lastAttemptAt)} valueLines={2} />
            <StatusLine label="静默恢复" value={formatObservationTime(automaticState?.resumeAt)} valueLines={2} />
            <StatusLine label="最近失败码" value={automaticState?.lastFailureCode ?? '暂无'} valueLines={2} />
          </View>
        </View>

        <Fold expanded={privacyExpanded} onToggle={() => setPrivacyExpanded((value) => !value)} subtitle={framePrivacy.privacy?.cacheEmpty ? '临时帧缓存为空' : '临时帧仍在处理'} title="隐私与清理">
          <StatusLine label="临时帧缓存" value={framePrivacy.privacy?.retryingFrameCount ? '等待重试' : framePrivacy.privacy?.activeFrameCount ? '处理中' : framePrivacy.privacy?.cacheEmpty ? '空' : '发现待清理残留'} />
          <StatusLine label="最近清理" value={describeCleanupState(framePrivacy.privacy?.lastCleanupState)} />
          <StatusLine label="启动残留" value={framePrivacy.privacy?.orphanFrameCount ? `仍有 ${framePrivacy.privacy.orphanFrameCount} 张待处理` : framePrivacy.privacy?.startupOrphansDeleted ? `已清理 ${framePrivacy.privacy.startupOrphansDeleted} 张` : '未发现'} />
          <StatusLine label="普通备份" value="不包含临时帧和手动保存照片" valueLines={2} />
          <Text style={styles.privacyNote}>“已验证删除”表示文件已经从君落的应用缓存中消失；Android 不提供闪存逐字节物理擦除证明。</Text>
          <Pressable disabled={privacyPending} onPress={() => void refreshFramePrivacy()} style={[styles.secondaryButton, privacyPending && styles.disabled]}>
            <Text style={styles.secondaryButtonText}>{privacyPending ? '正在重新检查' : '重新检查临时缓存'}</Text>
          </Pressable>
        </Fold>

        <Fold expanded={permissionExpanded} onToggle={() => setPermissionExpanded((value) => !value)} subtitle={`${describePermission(permissionStatus)} · ${notificationPermissionGranted && notificationChannelVisible ? '通知可见' : '通知需要设置'}`} title="权限与系统">
          <Text style={styles.sectionLabel}>摄像头权限</Text>
          <Text style={styles.cardDetail}>进入页面只检查状态；只有点击按钮才触发系统授权。</Text>
          <Pressable disabled={permissionPending || permissionStatus === 'checking' || permissionStatus === 'unavailable'} onPress={permissionStatus === 'blocked' ? openPermissionSettings : permissionStatus === 'granted' ? refreshPermission : requestPermission} style={[styles.secondaryButton, permissionPending && styles.disabled]}>
            <Text style={styles.secondaryButtonText}>{permissionStatus === 'blocked' ? '打开系统设置' : permissionStatus === 'granted' ? '重新检查摄像头权限' : '授予摄像头权限'}</Text>
          </Pressable>
          <View style={styles.sectionDivider} />
          <Text style={styles.sectionLabel}>常驻通知</Text>
          <Text style={styles.cardDetail}>会话仅在通知权限和专用渠道可见时启动。</Text>
          <Pressable disabled={notificationPending} onPress={!notificationPermissionGranted ? requestNotificationPermission : !notificationChannelVisible ? openNotificationSettings : () => cameraPerceptionRuntime.refresh(true)} style={[styles.secondaryButton, notificationPending && styles.disabled]}>
            <Text style={styles.secondaryButtonText}>{!notificationPermissionGranted ? '授予通知权限' : !notificationChannelVisible ? '打开通知设置' : '重新检查通知'}</Text>
          </Pressable>
          <View style={styles.sectionDivider} />
          <Text style={styles.sectionLabel}>电量、温控与后台运行</Text>
          <StatusLine label="电量／充电" value={runtimeConditionLabels.battery} valueLines={2} />
          <StatusLine label="系统温控" value={runtimeConditionLabels.thermal} valueLines={2} />
          <StatusLine label="省电模式" value={runtimeConditionLabels.powerSave} />
          <StatusLine label="电池优化" value={runtimeConditionLabels.optimization} valueLines={2} />
          <StatusLine label="后台受限" value={runtimeConditionLabels.background} valueLines={2} />
          <StatusLine label="相机隐私开关" value={runtimeConditionLabels.cameraPrivacy} valueLines={2} />
          <StatusLine label="状态来源" value={runtimeConditionLabels.source} valueLines={2} />
          <StatusLine label="条件检查时间" value={formatObservationTime(runtimeConditions?.checkedAt)} valueLines={2} />
          <Text style={styles.cardDetail}>未充电且电量不高于 20% 时暂停模型新拍摄；充电或达到 25% 后恢复资格。低电时手动看一眼与预览仍可用。严重温控暂停全部新拍摄并关闭预览；恢复不会自行拍摄或重新打开预览。</Text>
          <Text style={styles.cardDetail}>红米后台教程：在君落的系统应用信息中核对通知和摄像头权限，再按当前系统提供的入口检查省电／后台运行；自启动设置无法自动确认，请在系统设置中手动搜索“自启动”。相机隐私总开关也需手动核对。系统结束会话后，回到君落手动开启待命；君落不替你更改这些设置。</Text>
          <Pressable onPress={() => void openSystemSettingsGuide()} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>打开君落的系统应用信息</Text>
          </Pressable>
        </Fold>

        <Fold expanded={preferenceExpanded} onToggle={() => setPreferenceExpanded((value) => !value)} subtitle={`最短 ${settings.minimumIntervalMinutes} 分钟 · 静默${settings.quietHours.enabled ? '开启' : '关闭'}`} title="观察偏好">
          <Text style={styles.sectionLabel}>观察节奏</Text>
          <Text style={styles.cardDetail}>间隔到达只开放观察机会，不会定时拍摄。模型选择观察后才取帧，并可能产生看图费用。</Text>
          <View style={styles.stepperGroup}>
            <Stepper decreaseDisabled={minDownDisabled} increaseDisabled={minUpDisabled} label="最早可以看" onDecrease={() => void persistSettings({ ...settings, minimumIntervalMinutes: settings.minimumIntervalMinutes - CAMERA_INTERVAL_STEP_MINUTES })} onIncrease={() => void persistSettings({ ...settings, minimumIntervalMinutes: settings.minimumIntervalMinutes + CAMERA_INTERVAL_STEP_MINUTES })} value={`${settings.minimumIntervalMinutes} 分钟`} />
          </View>
          <View style={styles.switchRow}>
            <View style={styles.foldCopy}><Text style={styles.sectionLabel}>聊天遵守最短观察间隔</Text><Text style={styles.cardDetail}>默认开启以限制看图频率；关闭后只放开聊天中的间隔限制。主动消息仍遵守最短间隔。</Text></View>
            <Switch disabled={settingsPending} onValueChange={(chatMinimumIntervalEnabled) => void persistSettings({ ...settings, chatMinimumIntervalEnabled })} trackColor={{ false: '#F0DDE4', true: '#F2A8BE' }} thumbColor={settings.chatMinimumIntervalEnabled ? '#C95F82' : '#FFFFFF'} value={settings.chatMinimumIntervalEnabled} />
          </View>
          <View style={styles.sectionDivider} />
          <View style={styles.switchRow}>
            <View style={styles.foldCopy}><Text style={styles.sectionLabel}>静默时段</Text><Text style={styles.cardDetail}>静默期间不抓帧、不打开 CameraX，也不调用模型。</Text></View>
            <Switch disabled={settingsPending} onValueChange={(enabled) => void persistSettings({ ...settings, quietHours: { ...settings.quietHours, enabled } })} trackColor={{ false: '#F0DDE4', true: '#F2A8BE' }} thumbColor={settings.quietHours.enabled ? '#C95F82' : '#FFFFFF'} value={settings.quietHours.enabled} />
          </View>
          {settings.quietHours.enabled ? <View style={styles.stepperGroup}>
            <Stepper decreaseDisabled={settingsPending || quietStartDown === settings.quietHours.endMinuteOfDay} increaseDisabled={settingsPending || quietStartUp === settings.quietHours.endMinuteOfDay} label="开始" onDecrease={() => void persistSettings({ ...settings, quietHours: { ...settings.quietHours, startMinuteOfDay: quietStartDown } })} onIncrease={() => void persistSettings({ ...settings, quietHours: { ...settings.quietHours, startMinuteOfDay: quietStartUp } })} value={formatMinuteOfDay(settings.quietHours.startMinuteOfDay)} />
            <Stepper decreaseDisabled={settingsPending || quietEndDown === settings.quietHours.startMinuteOfDay} increaseDisabled={settingsPending || quietEndUp === settings.quietHours.startMinuteOfDay} label="结束" onDecrease={() => void persistSettings({ ...settings, quietHours: { ...settings.quietHours, endMinuteOfDay: quietEndDown } })} onIncrease={() => void persistSettings({ ...settings, quietHours: { ...settings.quietHours, endMinuteOfDay: quietEndUp } })} value={formatMinuteOfDay(settings.quietHours.endMinuteOfDay)} />
          </View> : null}
        </Fold>

        {__DEV__ ? <Fold expanded={developerExpanded} onToggle={() => setDeveloperExpanded((value) => !value)} subtitle="仅 Debug 构建可见" title="开发验收">
          <Text style={styles.sectionLabel}>第十六章运行条件模拟</Text>
          <Text style={styles.cardDetail}>仅在内存中增加限制，不会覆盖真实系统限制；不拍摄、不调用模型。清除模拟后恢复真实读数，不自动补拍。</Text>
          <Text style={styles.debugReceipt}>{runtimeConditionsDebugResult}</Text>
          <View style={styles.debugButtonGroup}>
            <Pressable disabled={runtimeConditionsDebugPending} onPress={() => void runRuntimeConditionsDebug({ batteryPercent: 20, charging: false })} style={[styles.secondaryButton, runtimeConditionsDebugPending && styles.disabled]}><Text style={styles.secondaryButtonText}>模拟低电 20%（不拍摄）</Text></Pressable>
            <Pressable disabled={runtimeConditionsDebugPending} onPress={() => void runRuntimeConditionsDebug({ thermalStatus: 3 })} style={[styles.secondaryButton, runtimeConditionsDebugPending && styles.disabled]}><Text style={styles.secondaryButtonText}>模拟严重温控（关闭预览）</Text></Pressable>
            <Pressable disabled={runtimeConditionsDebugPending} onPress={() => void runRuntimeConditionsDebug({ clear: true })} style={[styles.secondaryButton, runtimeConditionsDebugPending && styles.disabled]}><Text style={styles.secondaryButtonText}>清除运行条件模拟</Text></Pressable>
          </View>
          <View style={styles.sectionDivider} />
          <Text style={styles.cardDetail}>第六章正式桥抓帧自检；页面预览运行时必须先关闭预览。</Text>
          <StatusLine label="Bridge" value={cameraRuntime.bridgeStatus} />
          <StatusLine label="Resource owner" value={nativeSnapshot?.cameraResourceOwner ?? 'none'} />
          <Text style={styles.debugReceipt}>{bridgeSelfTest}</Text>
          <Pressable disabled={selfTestPending || previewRuntime.active || session.status !== 'running'} onPress={() => void runBridgeSelfTest()} style={[styles.secondaryButton, (selfTestPending || previewRuntime.active || session.status !== 'running') && styles.disabled]}><Text style={styles.secondaryButtonText}>{previewRuntime.active ? '请先关闭页面预览' : '抓一张测试帧并立即删除'}</Text></Pressable>
          <View style={styles.sectionDivider} />
          <Text style={styles.sectionLabel}>第九章临时帧隐私自检</Text>
          <StatusLine label="active / retrying / orphan" value={`${framePrivacy.privacy?.activeFrameCount ?? 0} / ${framePrivacy.privacy?.retryingFrameCount ?? 0} / ${framePrivacy.privacy?.orphanFrameCount ?? 0}`} />
          {framePrivacy.privacy?.latestProof ? <Text style={styles.debugReceipt}>触发：{framePrivacy.privacy.latestProof.trigger}{'\n'}字节：{framePrivacy.privacy.latestProof.byteLength ?? '无'} · SHA 前缀：{framePrivacy.privacy.latestProof.sha256Prefix ?? '无'}{'\n'}尝试：{framePrivacy.privacy.latestProof.attemptCount} · 删除：{framePrivacy.privacy.latestProof.deletionVerified ? '已验证' : '未验证'}</Text> : null}
          <Text style={styles.debugReceipt}>{privacyDebugResult}</Text>
          <View style={styles.debugButtonGroup}>
            <Pressable disabled={privacyPending} onPress={() => void runPrivacyDebugSelfTest('delete_now')} style={[styles.secondaryButton, privacyPending && styles.disabled]}><Text style={styles.secondaryButtonText}>随机测试文件：立即删除</Text></Pressable>
            <Pressable disabled={privacyPending} onPress={() => void runPrivacyDebugSelfTest('fail_once')} style={[styles.secondaryButton, privacyPending && styles.disabled]}><Text style={styles.secondaryButtonText}>模拟首次失败后重试</Text></Pressable>
            <Pressable disabled={privacyPending} onPress={() => void runPrivacyDebugSelfTest('fail_all')} style={[styles.secondaryButton, privacyPending && styles.disabled]}><Text style={styles.secondaryButtonText}>模拟持续失败</Text></Pressable>
            <Pressable disabled={privacyPending} onPress={() => void runPrivacyDebugSelfTest('create_orphan')} style={[styles.secondaryButton, privacyPending && styles.disabled]}><Text style={styles.secondaryButtonText}>创建启动扫描孤儿</Text></Pressable>
            <Pressable disabled={privacyPending} onPress={() => void runPrivacyDebugSelfTest('watchdog')} style={[styles.secondaryButton, privacyPending && styles.disabled]}><Text style={styles.secondaryButtonText}>创建 120 秒 watchdog 文件</Text></Pressable>
          </View>
          <View style={styles.sectionDivider} />
          <Text style={styles.sectionLabel}>第十章结构化视觉自检</Text>
          <Text style={styles.cardDetail}>非法 JSON、代码围栏、缺失／额外字段、悬空引用及身份／设备伪造由本地固定夹具覆盖；下方按钮会真实调用同一张图两次，验证只再次整理一次。</Text>
          <Text style={styles.debugReceipt}>{visionFixtureSelfTest}</Text>
          <Pressable onPress={() => {
            const result = runCameraVisionStructuredFixtureSelfTest();
            setVisionFixtureSelfTest(`${result.success ? '通过' : '失败'}：${result.passed}/${result.total} 个固定夹具`);
          }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>运行固定结构夹具</Text></Pressable>
          <Text style={styles.debugReceipt}>{visionRepairSelfTest}</Text>
          <Pressable disabled={manualActionBusy || previewRuntime.active} onPress={() => void runLookOnce(true)} style={[styles.secondaryButton, (manualActionBusy || previewRuntime.active) && styles.disabled]}><Text style={styles.secondaryButtonText}>{previewRuntime.active ? '请先关闭页面预览' : '强制首轮结构无效并再次整理'}</Text></Pressable>
          <View style={styles.sectionDivider} />
          <Text style={styles.sectionLabel}>第十三章观察机会自检</Text>
          <Text style={styles.debugReceipt}>{automaticDebugResult}</Text>
          <View style={styles.debugButtonGroup}>
            <Pressable onPress={() => void runAutomaticDebug('force_opportunity')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>强制进入机会窗口</Text></Pressable>
            <Pressable onPress={() => void runAutomaticDebug('advance_time', 30)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>推进调试时间 30 分钟</Text></Pressable>
            <Pressable onPress={() => void runAutomaticDebug('reset_time')} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>重置调试时间</Text></Pressable>
          </View>
        </Fold> : null}

        <View style={styles.boundaryNote}><Text style={styles.boundaryText}>待命开启且条件满足时，聊天与主动消息可选择看一眼；不会按固定截止时间自行拍摄。</Text></View>
        {notice ? <View style={[styles.notice, notice.kind === 'warning' && styles.noticeWarning]}><Text style={styles.noticeText}>{notice.text}</Text></View> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#FFF7FA' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { color: colors.muted, fontSize: 14 },
  header: { minHeight: 76, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center' },
  backButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#F7CFDA' },
  backText: { color: colors.ink, fontSize: 32, lineHeight: 34 },
  headerCopy: { flex: 1, alignItems: 'center' },
  eyebrow: { color: '#B66D84', fontSize: 9, fontWeight: '800', letterSpacing: 1.8, marginBottom: 2 },
  title: { color: colors.ink, fontSize: 25, fontWeight: '800' },
  headerSpacer: { width: 44, height: 44 },
  content: { paddingHorizontal: 18, paddingBottom: 38, gap: 14 },
  hero: { minHeight: 136, borderRadius: 28, padding: 20, backgroundColor: '#FFE4EC', borderWidth: 1, borderColor: '#F7C8D6', overflow: 'hidden', flexDirection: 'row', alignItems: 'center' },
  heroLens: { width: 74, height: 74, borderRadius: 37, backgroundColor: '#FFF7FA', alignItems: 'center', justifyContent: 'center', marginRight: 16, borderWidth: 7, borderColor: '#F6B6CA' },
  heroLensInner: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#73485A', borderWidth: 8, borderColor: '#D97598' },
  heroCopy: { flex: 1 },
  heroKicker: { color: '#A85E77', fontSize: 11, fontWeight: '800', marginBottom: 5 },
  heroTitle: { color: '#4B3440', fontSize: 19, lineHeight: 25, fontWeight: '800', marginBottom: 6 },
  heroDetail: { color: '#765A68', fontSize: 11, lineHeight: 18 },
  previewCard: { aspectRatio: 4 / 3, borderRadius: 28, overflow: 'hidden', backgroundColor: '#4E4248', borderWidth: 2, borderColor: '#F2B9CB' },
  previewPlaceholder: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#6D5A63' },
  placeholderLens: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F2A8BE', borderWidth: 8, borderColor: '#F9D4E0' },
  placeholderLensDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#4E3942' },
  placeholderTitle: { color: '#FFF9FB', fontSize: 16, fontWeight: '800', marginTop: 14 },
  placeholderDetail: { color: '#EEDDE4', fontSize: 10, marginTop: 5 },
  loadingOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(73,48,59,0.86)' },
  recoveryOverlay: { backgroundColor: 'rgba(73,48,59,0.54)' },
  loadingOverlayText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800', marginTop: 10 },
  previewBadges: { position: 'absolute', left: 12, right: 12, bottom: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  previewBadge: { color: '#FFF8FB', fontSize: 9, fontWeight: '800', paddingHorizontal: 9, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(77,51,62,0.76)', overflow: 'hidden' },
  card: { borderRadius: 24, padding: 18, backgroundColor: '#FFFCFD', borderWidth: 1, borderColor: '#F3D7E0' },
  controlsCard: { gap: 12 },
  manualActionsCard: { gap: 14, backgroundColor: '#FFF9FC', borderColor: '#F1C8D7' },
  actionButtonsRow: { flexDirection: 'row', gap: 10 },
  actionButton: { flex: 1, minHeight: 50, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  lookButton: { backgroundColor: '#C95F82' },
  saveButton: { backgroundColor: '#8B6574' },
  actionButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800', textAlign: 'center' },
  manualMetaBox: { padding: 12, borderRadius: 16, backgroundColor: '#FFF1F6', borderWidth: 1, borderColor: '#F3D5E0' },
  destinationButtons: { flexDirection: 'row', gap: 10 },
  compactButton: { flex: 1, minHeight: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFE5EE', borderWidth: 1, borderColor: '#F0C4D3' },
  clearButton: { backgroundColor: '#FFF4F7' },
  compactButtonText: { color: '#A95070', fontSize: 12, fontWeight: '800' },
  cancelActionButton: { minHeight: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF0E7', borderWidth: 1, borderColor: '#F1CEBE' },
  cancelActionText: { color: '#9A6654', fontSize: 12, fontWeight: '800' },
  receiptCard: { padding: 13, borderRadius: 16, backgroundColor: '#F3EAF8', borderWidth: 1, borderColor: '#E1CFEA', gap: 4 },
  receiptTitle: { color: '#6D4B76', fontSize: 13, fontWeight: '800' },
  receiptText: { color: '#735F79', fontSize: 11, lineHeight: 17 },
  visionPerformanceCard: { gap: 4, borderRadius: 14, padding: 12, backgroundColor: '#FFF4F8', borderWidth: 1, borderColor: '#F0D1DC' },
  visionPerformanceTitle: { color: '#8D5A6D', fontSize: 12, fontWeight: '700' },
  visionPerformanceText: { color: '#7A6C73', fontSize: 11, lineHeight: 17 },
  cardTitle: { color: colors.ink, fontSize: 17, lineHeight: 23, fontWeight: '800' },
  cardDetail: { color: colors.muted, fontSize: 12, lineHeight: 19, marginTop: 4 },
  primaryButton: { minHeight: 50, borderRadius: 17, backgroundColor: '#C95F82', alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  secondaryButton: { minHeight: 46, borderRadius: 15, backgroundColor: '#FFE6EE', borderWidth: 1, borderColor: '#F2C7D5', alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  secondaryButtonText: { color: '#A95070', fontSize: 13, fontWeight: '800' },
  stopButton: { minHeight: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: '#765762' },
  stopButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  segmentedControl: { padding: 4, borderRadius: 17, backgroundColor: '#FFEAF0', flexDirection: 'row', gap: 4 },
  segment: { flex: 1, minHeight: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  segmentSelected: { backgroundColor: '#D97898' },
  segmentText: { color: '#876B77', fontSize: 13, fontWeight: '700' },
  segmentTextSelected: { color: '#FFFFFF' },
  statusBlock: { marginTop: 12, paddingTop: 6, borderTopWidth: 1, borderTopColor: '#F2E2E8' },
  statusLine: { minHeight: 34, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  statusLineMultiline: { minHeight: 52, alignItems: 'flex-start', paddingVertical: 8 },
  statusLabel: { flexShrink: 0, color: '#796872', fontSize: 12, lineHeight: 18 },
  statusValue: { flex: 1, minWidth: 0, color: colors.ink, fontSize: 12, lineHeight: 18, fontWeight: '700', textAlign: 'right' },
  statusValueMultiline: { minHeight: 36 },
  foldHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  foldCopy: { flex: 1 },
  foldChevron: { color: '#B76380', fontSize: 24, fontWeight: '800' },
  foldBody: { marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#F2E2E8' },
  sectionLabel: { color: '#5C4650', fontSize: 14, fontWeight: '800' },
  sectionDivider: { height: 1, backgroundColor: '#F2E2E8', marginVertical: 16 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  stepperGroup: { marginTop: 12, gap: 10 },
  stepperRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  stepperLabel: { flex: 1, color: '#614E58', fontSize: 12, fontWeight: '700' },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  stepperButton: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFE9F0' },
  stepperButtonText: { color: '#A85270', fontSize: 18, fontWeight: '800' },
  stepperValueBox: { minWidth: 78, height: 40, paddingHorizontal: 8, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF8FA', borderWidth: 1, borderColor: '#F2D5DF' },
  stepperValue: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  debugReceipt: { marginTop: 12, padding: 12, borderRadius: 14, backgroundColor: '#FFF4F7', color: '#745C66', fontSize: 11, lineHeight: 17 },
  debugButtonGroup: { gap: 8 },
  privacyNote: { marginTop: 10, color: '#765A68', fontSize: 11, lineHeight: 18, padding: 12, borderRadius: 14, backgroundColor: '#FFF1F6' },
  boundaryNote: { borderRadius: 18, padding: 14, backgroundColor: '#FFF0E7', borderWidth: 1, borderColor: '#F5D9CA' },
  boundaryText: { color: '#806255', fontSize: 11, lineHeight: 17, textAlign: 'center' },
  notice: { borderRadius: 16, padding: 13, backgroundColor: '#E7F4EE', borderWidth: 1, borderColor: '#CFE6DC' },
  topNotice: { marginHorizontal: 18, marginBottom: 10 },
  noticeWarning: { backgroundColor: '#FFEAE4', borderColor: '#F3CEC3' },
  noticeText: { color: '#664F59', fontSize: 12, lineHeight: 18 },
  disabled: { opacity: 0.45 },
});
