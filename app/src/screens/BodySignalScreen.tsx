import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';

import {
  authenticateMiBand6AndSubscribeHeartRate,
  connectColmiDevice,
  disconnectColmiDevice,
  getColmiConnectionSnapshot,
  probeColmiCurrentChannel,
  readColmiFee7Info,
  readColmiStandardGattInfo,
  requestColmiBattery,
  requestSmartHealthR99Battery,
  startMiBand6RealtimeHeartRate,
  stopMiBand6RealtimeHeartRate,
  subscribeColmiStandardHeartRate,
  startSmartHealthR99HeartRateExperiment,
  selectNextColmiProbeChannel,
  retainColmiDiagnostics,
  subscribeColmiConnection,
  syncColmiLocalTime,
  syncMiBand6LocalTime,
  type ColmiConnectionState,
} from '../bodySignal/colmi/colmiConnection';
import { getMiBand6AuthKey, setMiBand6AuthKey } from '../bodySignal/colmi/miBand6AuthStore';
import { miBand6TimeSyncErrorMessage, supportsMiBand6TimeCalibration } from '../bodySignal/colmi/miBand6TimeProtocol';
import { readMiBand6Battery, restorePersistedMiBand6Battery } from '../bodySignal/miBand6Battery';
import { MiBand6ActivitySection } from '../bodySignal/MiBand6ActivitySection';
import { BodyDataSyncStatus } from '../bodySignal/BodyDataSyncStatus';
import type { BodyDataDestination } from '../bodySignal/BodyDataFeature';
import { miBand6BatteryErrorMessage } from '../bodySignal/colmi/miBand6BatteryProtocol';
import { bodySignalBatteryHint } from '../bodySignal/bodySignalBatteryPresentation';
import {
  getColmiScanSnapshot,
  startColmiScan,
  stopColmiScan,
  subscribeColmiScan,
  type ColmiScanDevice,
  type ColmiScanState,
} from '../bodySignal/colmi/colmiScanner';
import {
  getBodySignalRuntimeSnapshot,
  resumeConnectedBodySignalHeartRate,
  resumeBodySignalRuntime,
  subscribeBodySignalRuntime,
  updateBodySignalRuntimeSettings,
  type BodySignalRuntimeSnapshot,
} from '../bodySignal/bodySignalRuntime';
import {
  disableBodySignalActivityContext,
  getBodySignalCareRuntimeSnapshot,
  requestAndEnableBodySignalActivityContext,
  subscribeBodySignalCareRuntime,
  type BodySignalCareRuntimeSnapshot,
} from '../bodySignal/bodySignalCareRuntime';
import { persistBodySignalCompanionPresenceEvent } from '../bodySignal/bodySignalCompanionRuntime';
import {
  formatBodySignalHeartRateRemaining,
  startBodySignalContinuousHeartRate,
  stopBodySignalContinuousHeartRate,
} from '../bodySignal/bodySignalHeartRateControl';
import {
  disableGuardian,
  enableGuardian,
  getGuardianSupport,
  pauseGuardian,
  provisionPrimaryDevice,
  releaseGuardianForForegroundScan,
  resumeGuardian,
  retryGuardianNow,
  syncGuardianTime,
  type BodySignalGuardianState,
  type BodySignalGuardianSupport,
} from '../bodySignal/bodySignalGuardian';
import {
  bodySignalGuardianStatusMessage,
  canEnableBodySignalGuardian,
  guardianOwnsBodySignalConnection,
} from '../bodySignal/bodySignalGuardianPolicy';
import {
  getBodySignalGuardianRuntimeState,
  refreshBodySignalGuardianRuntime,
  subscribeBodySignalGuardianState,
} from '../bodySignal/bodySignalGuardianRuntime';
import {
  loadRecentScheduledSamplingWindows,
  loadScheduledSamplingSettings,
  pauseScheduledSamplingUntilTomorrow,
  resumeScheduledSampling,
  saveScheduledSamplingEnabled,
  type BodySignalScheduledSamplingSettings,
  type BodySignalScheduledSamplingWindow,
} from '../bodySignal/bodySignalScheduledSamplingRuntime';
import { defaultBodySignalScheduledSamplingSettings } from '../bodySignal/bodySignalScheduledSampling';
import {
  beginBodySignalPrimaryDeviceAssociation,
  getBodySignalCompanionSupport,
  isBodySignalCompanionAssociationMissingError,
  pauseBodySignalPrimaryDeviceObservation,
  revokeBodySignalPrimaryDeviceAssociation,
  resumeBodySignalPrimaryDeviceObservation,
  subscribeBodySignalCompanionPresence,
  type BodySignalCompanionSupport,
} from '../bodySignal/bodySignalCompanion';
import {
  loadBodySignalCompanionAssociation,
  saveBodySignalCompanionAssociation,
  updateBodySignalCompanionAssociationStatus,
} from '../bodySignal/device/bodySignalCompanionStore';
import { loadPersistedPrimaryBodySignalDeviceProfile, setPersistedBodySignalDeviceCompanionAssociation } from '../bodySignal/device/bodySignalDeviceRepository';
import {
  activateBodySignalCompanionAssociation,
  fromBodySignalCompanionIdentity,
  shouldReplaceBodySignalCompanionAssociation,
} from '../bodySignal/device/bodySignalCompanionPolicy';
import type { BodySignalCompanionAssociation } from '../bodySignal/device/bodySignalCompanionTypes';
import type { BodySignalDeviceProfile } from '../bodySignal/device/bodySignalDeviceTypes';
import { useBodySignalSnapshot } from '../bodySignal/useBodySignalSnapshot';
import { openPhoneNotificationListenerSettings } from '../backend/phoneActivityNative';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';

type Props = {
  navigate: Navigate;
  onOpenBodyData?: (destination?: BodyDataDestination) => void;
};

function scanCounts(state: ColmiScanState): { nearby: number; supported: number } {
  const nearby = state.devices.filter((device) => device.confidence === 'nearby').length;
  return { nearby, supported: state.devices.length - nearby };
}

function statusText(state: ColmiScanState): string {
  if (state.status === 'requesting_permission') return '正在请求权限';
  if (state.status === 'error') return '需要处理';
  const counts = scanCounts(state);
  const suffix = counts.nearby ? `，另有 ${counts.nearby} 个附近设备` : '';
  if (state.status === 'scanning') return `扫描中 · ${counts.supported} 个支持设备${suffix}`;
  return counts.supported || counts.nearby ? `已找到 ${counts.supported} 个支持设备${suffix}` : '待扫描';
}

function confidenceText(device: ColmiScanDevice): string {
  if (device.confidence === 'strong') return '强匹配';
  if (device.confidence === 'model') return '型号匹配';
  if (device.confidence === 'weak') return '弱匹配';
  if (device.confidence === 'nearby') return '附近设备';
  return '未知';
}


function deviceDebugLines(device: ColmiScanDevice): string[] {
  const lines: string[] = [];
  if (device.name) lines.push(`name: ${device.name}`);
  if (device.localName && device.localName !== device.name) lines.push(`local: ${device.localName}`);
  if (device.matchedKeyword) lines.push(`match: ${device.matchedKeyword}`);
  if (typeof device.txPowerLevel === 'number') lines.push(`tx: ${device.txPowerLevel}`);
  if (device.serviceUUIDs?.length) lines.push(`services: ${device.serviceUUIDs.join(', ')}`);
  if (device.manufacturerDataHex) lines.push(`mfg: ${device.manufacturerDataHex}`);
  if (device.serviceDataHex?.length) lines.push(...device.serviceDataHex.map((row) => `svcData: ${row}`));
  return lines;
}
function connectionTitle(state: ColmiConnectionState): string {
  if (state.status === 'connected') return '已连接';
  if (state.status === 'connecting') return '连接中';
  if (state.status === 'discovering') return '发现服务中';
  if (state.status === 'subscribing') return '订阅通知中';
  if (state.status === 'error') return '连接失败';
  return '未连接';
}

function isConnectionBusy(state: ColmiConnectionState): boolean {
  return state.status === 'connecting' || state.status === 'discovering' || state.status === 'subscribing';
}

function isSafeCommandChannel(state: ColmiConnectionState): boolean {
  return Boolean(state.primaryChannel && state.primaryChannel.role !== 'ae00' && state.primaryChannel.role !== 'be94' && state.primaryChannel.role !== 'fallback');
}
function isInitializationBusy(state: ColmiConnectionState): boolean {
  return state.initializationStatus === 'initializing'
    || state.initializationStatus === 'setting_time'
    || state.initializationStatus === 'reading_battery';
}

function shouldShowConnectionError(state: ColmiConnectionState): boolean {
  if (!state.errorMessage) return false;
  if (state.statusMessage === '测量后已断开') return false;
  if (state.smartHealthR99MeasurementStatus === 'received' && /disconnect|disconnected|断开/i.test(state.errorMessage)) {
    return false;
  }
  return true;
}

function probeChannelText(state: ColmiConnectionState): string {
  const channel = state.candidateChannels[state.probeChannelIndex] ?? state.primaryChannel;
  if (!channel) return '暂无可测试通道';
  const indexText = state.candidateChannels.length ? `${state.probeChannelIndex + 1}/${state.candidateChannels.length}` : '1/1';
  return `${indexText} · ${channel.role} · ${channel.writeMode}`;
}
function channelText(state: ColmiConnectionState): string {
  if (!state.primaryChannel) return '等待连接后显示 write / notify 通道';
  return `write ${state.primaryChannel.writeCharacteristicUUID}\nnotify ${state.primaryChannel.notifyCharacteristicUUID}\nmode ${state.primaryChannel.writeMode}\nrole ${state.primaryChannel.role}`;
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '暂未记录';
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function runtimeSkipText(reason?: BodySignalRuntimeSnapshot['lastSkipReason']): string {
  if (reason === 'already_connected') return '已连接，暂不重复恢复';
  if (reason === 'auto_reconnect_disabled') return '自动恢复已关闭';
  if (reason === 'cooldown') return '刚尝试过，稍等再试';
  if (reason === 'manual_disconnect') return '本次已手动断开，暂不自动重连';
  if (reason === 'last_device_not_found') return '本轮没有发现上次连接的穿戴设备';
  if (reason === 'missing_last_device') return '还没有上次连接设备';
  if (reason === 'native_guardian_active') return '全天守候正在管理当前设备';
  if (reason === 'scan_or_connection_busy') return '扫描或连接中，暂不打扰';
  return '等待前台恢复';
}

function runtimeStatusText(state: BodySignalRuntimeSnapshot): string {
  if (state.isResuming) return '正在尝试找回戒指';
  if (state.lastErrorMessage) return state.lastErrorMessage;
  return runtimeSkipText(state.lastSkipReason);
}
function batteryLevelText(state: ColmiConnectionState): string {
  if (!state.batteryInfo) return '暂未读到';
  return `${state.batteryInfo.batteryLevel}%`;
}

function smartHealthR99BatteryText(state: ColmiConnectionState): string {
  if (!state.smartHealthR99BatteryInfo) return '暂未读到';
  return `${state.smartHealthR99BatteryInfo.batteryLevel}%`;
}

function smartHealthR99BatteryStatusText(state: ColmiConnectionState): string {
  if (state.smartHealthR99BatteryStatus === 'starting') return '正在发送请求';
  if (state.smartHealthR99BatteryStatus === 'waiting') return '等待合法回包';
  if (state.smartHealthR99BatteryStatus === 'received') return '已收到合法回包';
  if (state.smartHealthR99BatteryStatus === 'error') return state.smartHealthR99BatteryErrorMessage ?? '读取失败';
  return '等待手动读取';
}

function chargingText(state: ColmiConnectionState): string {
  if (!state.batteryInfo) return '等待回包';
  return state.batteryInfo.charging ? '充电中' : '未充电';
}

function latestRxText(state: ColmiConnectionState): string {
  if (!state.lastRxHex) return '暂未接收';
  const source = state.lastRxSource ?? 'rx';
  const length = typeof state.lastRxLength === 'number' ? `${state.lastRxLength} bytes` : '未知长度';
  return `${source} · ${length} · ${state.lastRxHex}`;
}

function standardHeartRateText(state: ColmiConnectionState): string {
  if (!state.standardHeartRateInfo) return '暂未读到';
  return `${state.standardHeartRateInfo.bpm} bpm`;
}

function smartHealthR99HeartRateText(state: ColmiConnectionState): string {
  if (!state.smartHealthR99HeartRateInfo) return '暂未读到';
  return `${state.smartHealthR99HeartRateInfo.bpm} bpm`;
}

function activeHeartRateValue(state: ColmiConnectionState): string {
  const info = state.capabilities.heartRateTransport === 'standard_gatt'
    ? state.standardHeartRateInfo
    : state.smartHealthR99HeartRateInfo;
  return info ? String(info.bpm) : '--';
}

function activeHeartRateTime(state: ColmiConnectionState): string {
  const timestamp = state.capabilities.heartRateTransport === 'standard_gatt'
    ? state.standardHeartRateInfo?.receivedAt
    : state.smartHealthR99HeartRateInfo?.receivedAt;
  if (!timestamp) return '暂未记录';
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function measurementStatusText(state: ColmiConnectionState): string {
  if (state.capabilities.heartRateTransport === 'standard_gatt') {
    const realtime = state.miBand6RealtimeHeartRateSession;
    if (realtime.status === 'starting') return '正在启动五分钟测量';
    if (realtime.status === 'running') return '正在连续读取心率';
    if (realtime.status === 'stopping') return '正在安全停止';
    if (realtime.status === 'completed') return '本轮连续测量已完成';
    if (realtime.status === 'error') return realtime.errorMessage ?? '连续测量遇到错误';
    if (state.capabilities.supportsHuami2021Auth && state.huami2021AuthStatus !== 'authenticated') {
      if (state.huami2021AuthStatus === 'missing_key') return '等待填写认证密钥';
      if (state.huami2021AuthStatus === 'error') return '手环认证遇到错误';
      return state.huami2021AuthStatus === 'idle' ? '等待手环认证' : '正在认证手环';
    }
    if (state.standardHeartRateErrorMessage) return '心率监听遇到错误';
    if (state.standardHeartRateInfo) return '已收到心率';
    return state.isConnected ? '监听中，等待设备回报' : '等待连接';
  }
  if (state.smartHealthR99MeasurementStatus === 'starting') return '正在启动测量';
  if (state.smartHealthR99MeasurementStatus === 'waiting') return '正在接收心率';
  if (state.smartHealthR99MeasurementStatus === 'received') return '已收到心率';
  if (state.smartHealthR99MeasurementStatus === 'error') return '测量遇到错误';
  return '等待测量';
}

function standardGattInfoText(state: ColmiConnectionState): string {
  const info = state.standardGattInfo;
  if (!info) return '暂未读取';
  const parts = [
    info.deviceName ? `设备名 ${info.deviceName}` : undefined,
    info.bodySensorLocation ? `传感器 ${info.bodySensorLocation}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : '已读取，但没有可显示字段';
}

function companionPresenceSummary(association: BodySignalCompanionAssociation | undefined): string {
  if (!association) return 'Android 尚未关联这台主穿戴设备。';
  if (association.status === 'paused') return '后台感知已暂停，系统暂时不会记录它是否在附近。';
  if (association.status === 'revoked') return '这台设备的 Android 关联已取消。';
  return '已允许系统在后台感知这台设备。';
}

function guardianEnableErrorText(reason?: ReturnType<typeof canEnableBodySignalGuardian>['reason']): string {
  if (reason === 'unsupported') return '当前系统或安装包暂不支持全天连接守候。';
  if (reason === 'notification_permission_missing') return '请先在系统设置中允许君落发送通知。';
  if (reason === 'bluetooth_permission_missing') return '请先允许君落连接附近的蓝牙设备。';
  if (reason === 'not_primary_mi_band_6') return '全天守候目前只支持当前主设备为 Mi Band 6。';
  if (reason === 'association_inactive') return '请先完成上方 Android 后台找回关联，并保持感知开启。';
  if (reason === 'auth_key_missing') return '君落还没有找到这只手环的有效认证密钥。';
  return '全天守候暂时无法开启。';
}

function companionSupportSummary(support: BodySignalCompanionSupport): string {
  if (support.supported) return '';
  return support.reason === 'android_api_below_33'
    ? '当前 Android 版本不支持这项后台存在感知。'
    : '当前安装包暂不能使用 Android 后台存在感知。';
}

function scheduledSamplingStatusText(state: BodySignalGuardianState): string {
  if (!state.scheduledSamplingEnabled) return '未开启';
  if (state.scheduledSamplingStatus === 'sampling') return '正在节制读取心率';
  if (state.scheduledSamplingStatus === 'evaluating') return '正在检查本轮条件';
  if (state.scheduledSamplingStatus === 'paused') return '已暂停到明天';
  if (state.scheduledSamplingStatus === 'skipped') return '本轮已安静跳过';
  if (state.scheduledSamplingStatus === 'error') return '本轮遇到错误';
  return '等待下次尝试';
}

function scheduledSamplingReasonText(reason?: string): string {
  const labels: Record<string, string> = {
    battery_saver: '手机正在省电模式',
    cooldown: '还在 30 分钟冷却内',
    device_absent: '穿戴设备不在附近',
    disabled: '节制采样没有开启',
    due: '已经到计划采样时间',
    guardian_not_ready: '全天守候尚未就绪',
    low_phone_battery: '手机电量不高于 15%',
    low_wearable_battery: '穿戴设备近期电量不高于 20%',
    manual_session_active: '手动五分钟正在运行',
    paused: '用户已暂停',
    permission_missing: '系统权限或手机电量信息不可用',
    thermal_severe: '手机温度较高',
    unsupported_device: '当前设备不支持原生节制采样',
  };
  return reason ? labels[reason] ?? reason : '暂未记录';
}

function scheduledSamplingSkipReasonText(
  state: BodySignalGuardianState,
  window?: BodySignalScheduledSamplingWindow,
): string | undefined {
  const stateIsNewer = (state.lastScheduledSamplingEndedAt ?? 0) > (window?.endedAt ?? 0);
  const result = stateIsNewer
    ? state.lastScheduledSamplingResult
    : window?.result ?? state.lastScheduledSamplingResult;
  if (result !== 'skipped') return undefined;
  const reason = stateIsNewer
    ? state.lastScheduledSamplingReason
    : window?.reason ?? state.lastScheduledSamplingReason;
  return `这轮为什么跳过：${scheduledSamplingReasonText(reason)}`;
}

function scheduledSamplingResultText(window?: BodySignalScheduledSamplingWindow): string {
  if (!window) return '暂未记录';
  if (window.result === 'completed') return `完成 · ${window.readingCount} 条 · ${Math.round(window.durationMs / 1000)} 秒`;
  if (window.result === 'no_data') return '两分钟内没有读到有效心率';
  if (window.result === 'skipped') return `跳过 · ${scheduledSamplingReasonText(window.reason)}`;
  if (window.result === 'stopped') return '已停止';
  if (window.result === 'disconnected') return '设备中途离开';
  return '写入命令失败';
}

function bodySignalContextText(context: BodySignalCareRuntimeSnapshot['currentContext']): string {
  if (context === 'sleeping') return '睡眠';
  if (context === 'resting') return '休息';
  if (context === 'active') return '活动';
  if (context === 'navigation') return '导航外出';
  return '未知';
}

function bodySignalContextSourceText(source: BodySignalCareRuntimeSnapshot['currentContextSource']): string {
  if (source === 'sleep') return '睡眠记录';
  if (source === 'workout') return '运动记录';
  if (source === 'navigation_app') return '导航与活动线索';
  if (source === 'activity_transition') return '手机活动识别';
  return '证据不足';
}

function bodySignalBaselineProgressText(state: BodySignalCareRuntimeSnapshot): string {
  const baseline = state.baseline;
  if (!baseline) return '正在学习平常状态 · 0/7 天，0/20 组';
  if (baseline.readiness === 'mature') {
    return `已学会这类平常状态 · ${baseline.dateCount} 天，${baseline.bucketCount} 组`;
  }
  return `正在学习平常状态 · ${Math.min(baseline.dateCount, 7)}/7 天，${Math.min(baseline.bucketCount, 20)}/20 组`;
}

export function BodySignalScreen({ navigate, onOpenBodyData }: Props) {
  const bodySignalSnapshot = useBodySignalSnapshot();
  const [scanState, setScanState] = useState<ColmiScanState>(() => getColmiScanSnapshot());
  const [connectionState, setConnectionState] = useState<ColmiConnectionState>(() => getColmiConnectionSnapshot());
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [miBandAuthKeyInput, setMiBandAuthKeyInput] = useState('');
  const [miBandAuthKeySaving, setMiBandAuthKeySaving] = useState(false);
  const [miBandAuthKeyUiError, setMiBandAuthKeyUiError] = useState<string | undefined>();
  const [runtimeState, setRuntimeState] = useState<BodySignalRuntimeSnapshot>(() => getBodySignalRuntimeSnapshot());
  const [careRuntimeState, setCareRuntimeState] = useState<BodySignalCareRuntimeSnapshot>(
    () => getBodySignalCareRuntimeSnapshot(),
  );
  const [activityContextBusy, setActivityContextBusy] = useState(false);
  const [activityContextError, setActivityContextError] = useState<string | undefined>();
  const [companionSupport, setCompanionSupport] = useState<BodySignalCompanionSupport>({ supported: false });
  const [companionAssociation, setCompanionAssociation] = useState<BodySignalCompanionAssociation | undefined>();
  const [primaryDeviceProfile, setPrimaryDeviceProfile] = useState<BodySignalDeviceProfile | undefined>();
  const [companionActionBusy, setCompanionActionBusy] = useState(false);
  const [companionActionError, setCompanionActionError] = useState<string | undefined>();
  const [guardianSupport, setGuardianSupport] = useState<BodySignalGuardianSupport>({
    bluetoothConnectPermissionGranted: false,
    notificationPermissionGranted: false,
    supported: false,
  });
  const [guardianState, setGuardianState] = useState<BodySignalGuardianState>(() => getBodySignalGuardianRuntimeState());
  const [guardianActionBusy, setGuardianActionBusy] = useState(false);
  const [guardianActionError, setGuardianActionError] = useState<string | undefined>();
  const [scheduledSamplingSettings, setScheduledSamplingSettings] = useState<BodySignalScheduledSamplingSettings>(
    () => defaultBodySignalScheduledSamplingSettings(),
  );
  const [scheduledSamplingWindows, setScheduledSamplingWindows] = useState<BodySignalScheduledSamplingWindow[]>([]);
  const [scheduledSamplingBusy, setScheduledSamplingBusy] = useState(false);
  const [scheduledSamplingError, setScheduledSamplingError] = useState<string | undefined>();
  const [realtimeClockNow, setRealtimeClockNow] = useState(() => Date.now());
  const [bandTimeSyncBusy, setBandTimeSyncBusy] = useState(false);
  const [bandTimeSyncMessage, setBandTimeSyncMessage] = useState<string>();
  const [batteryBusy, setBatteryBusy] = useState(false);
  const [batteryError, setBatteryError] = useState<string>();
  useEffect(() => {
    setBandTimeSyncMessage(undefined);
  }, [connectionState.connectedDevice?.id, connectionState.isConnected, guardianState.sessionId, guardianState.owner]);
  const scheduledSamplingSkipReason = scheduledSamplingSkipReasonText(guardianState, scheduledSamplingWindows[0]);
  const guardianOwnsConnection = guardianOwnsBodySignalConnection(guardianState);
  const guardianConnected = guardianOwnsConnection
    && (guardianState.status === 'ready' || guardianState.status === 'sampling');
  const heartRateTransport = guardianOwnsConnection
    ? 'standard_gatt'
    : connectionState.capabilities.heartRateTransport;
  const supportsSmartHealthR99 = heartRateTransport === 'smarthealth_r99';
  const supportsStandardHeartRate = heartRateTransport === 'standard_gatt';

  useEffect(() => {
    const unsubscribeScan = subscribeColmiScan(setScanState);
    const unsubscribeConnection = subscribeColmiConnection(setConnectionState);
    const unsubscribeRuntime = subscribeBodySignalRuntime(setRuntimeState);
    void resumeBodySignalRuntime('screen_focus').catch(() => undefined);
    return () => {
      unsubscribeScan();
      unsubscribeConnection();
      unsubscribeRuntime();
      void stopColmiScan();
    };
  }, []);

  useEffect(() => subscribeBodySignalCareRuntime(setCareRuntimeState), []);

  const refreshScheduledSampling = useCallback(async () => {
    const [settings, windows] = await Promise.all([
      loadScheduledSamplingSettings(),
      loadRecentScheduledSamplingWindows(1),
    ]);
    setScheduledSamplingSettings(settings);
    setScheduledSamplingWindows(windows);
  }, []);

  useEffect(() => {
    void refreshScheduledSampling().catch(() => undefined);
  }, [guardianState.lastScheduledSamplingEndedAt, guardianState.scheduledSamplingEnabled, refreshScheduledSampling]);

  useEffect(() => {
    const unsubscribe = subscribeBodySignalGuardianState(setGuardianState);
    void Promise.all([
      getGuardianSupport(),
      refreshBodySignalGuardianRuntime(),
    ]).then(([support]) => setGuardianSupport(support)).catch(() => undefined);
    return unsubscribe;
  }, []);

  const refreshCompanionState = useCallback(async () => {
    const [support, profile] = await Promise.all([
      getBodySignalCompanionSupport(),
      loadPersistedPrimaryBodySignalDeviceProfile(),
    ]);
    const preferredAssociationId = fromBodySignalCompanionIdentity(profile?.authorizedAssociationId);
    const association = profile
      ? await loadBodySignalCompanionAssociation(profile.id, preferredAssociationId)
      : undefined;
    setCompanionSupport(support);
    setPrimaryDeviceProfile(profile);
    setCompanionAssociation(association);
  }, []);

  useEffect(() => {
    void refreshCompanionState().catch(() => undefined);
    const unsubscribe = subscribeBodySignalCompanionPresence((event) => {
      void (async () => {
        await persistBodySignalCompanionPresenceEvent(event);
        await refreshCompanionState();
      })().catch(() => undefined);
    });
    return unsubscribe;
  }, [connectionState.connectedDevice?.id, refreshCompanionState]);

  useEffect(() => {
    if (!diagnosticsExpanded) return undefined;
    return retainColmiDiagnostics();
  }, [diagnosticsExpanded]);

  useEffect(() => {
    setMiBandAuthKeyInput('');
    setMiBandAuthKeyUiError(undefined);
  }, [connectionState.connectedDevice?.id]);

  useEffect(() => {
    const running = guardianOwnsConnection
      ? guardianState.status === 'sampling'
      : connectionState.miBand6RealtimeHeartRateSession.status === 'running';
    if (!running) return undefined;
    const timer = setInterval(() => setRealtimeClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connectionState.miBand6RealtimeHeartRateSession.status, guardianOwnsConnection, guardianState.status]);

  const handleScanPress = () => {
    if (scanState.isScanning) {
      void stopColmiScan();
    } else {
      void (async () => {
        if (guardianOwnsBodySignalConnection(getBodySignalGuardianRuntimeState())) {
          await releaseGuardianForForegroundScan();
          await refreshBodySignalGuardianRuntime();
        }
        if (connectionState.status !== 'disconnected') {
          await disconnectColmiDevice({ suppressAutoReconnect: false });
        }
        await startColmiScan();
      })();
    }
  };

  const handleDevicePress = (device: ColmiScanDevice) => {
    if (isConnectionBusy(connectionState)) return;
    void (async () => {
      await connectColmiDevice(device);
      const profile = primaryDeviceProfile;
      if (
        guardianState.enabled
        && profile?.family === 'mi_band_6'
        && profile.lastAdvertisingId?.toLowerCase() === device.id.toLowerCase()
      ) {
        await disconnectColmiDevice({ suppressAutoReconnect: false });
        await resumeGuardian();
        await refreshBodySignalGuardianRuntime();
        return;
      }
      await resumeConnectedBodySignalHeartRate();
    })().catch(() => undefined);
  };

  const handleDisconnectPress = () => {
    if (guardianOwnsConnection) {
      void pauseGuardian()
        .then(() => refreshBodySignalGuardianRuntime())
        .catch(() => undefined);
      return;
    }
    void disconnectColmiDevice();
  };

  const handleToggleAutoReconnect = (value: boolean) => {
    void updateBodySignalRuntimeSettings({ autoReconnectEnabled: value }).catch(() => undefined);
  };

  const handleToggleAutoMeasure = (value: boolean) => {
    void updateBodySignalRuntimeSettings({ autoMeasureAfterReconnect: value }).catch(() => undefined);
  };

  const handleRuntimeResumePress = () => {
    void resumeBodySignalRuntime('manual').catch(() => undefined);
  };

  const handleCompanionAssociationPress = () => {
    const deviceAddress = connectionState.connectedDevice?.id;
    const profile = primaryDeviceProfile;
    if (!connectionState.isConnected || !deviceAddress || !profile?.isPrimary || companionActionBusy) {
      setCompanionActionError('请先手动连接当前主穿戴设备，再允许 Android 在后台感知它。');
      return;
    }

    void (async () => {
      setCompanionActionBusy(true);
      setCompanionActionError(undefined);
      const previousAssociation = companionAssociation;
      try {
        await stopColmiScan();
        const nativeAssociation = await beginBodySignalPrimaryDeviceAssociation({
          deviceAddress,
          deviceProfileId: profile.id,
        });
        const nextAssociation = activateBodySignalCompanionAssociation(previousAssociation, {
          associationId: nativeAssociation.associationId,
          deviceProfileId: profile.id,
          observationEnabled: nativeAssociation.observationEnabled,
          updatedAt: Date.now(),
        });
        await saveBodySignalCompanionAssociation(nextAssociation);
        try {
          await setPersistedBodySignalDeviceCompanionAssociation(profile.id, nextAssociation.associationId);
        } catch (error) {
          // Keep the user-approved Android association. A retry can reuse it and
          // repair the local device-profile pointer without reopening the chooser.
          throw error;
        }

        if (
          previousAssociation
          && previousAssociation.associationId !== nextAssociation.associationId
          && shouldReplaceBodySignalCompanionAssociation(true)
        ) {
          try {
            await revokeBodySignalPrimaryDeviceAssociation(previousAssociation.associationId);
            await updateBodySignalCompanionAssociationStatus(previousAssociation, 'revoked', false);
          } catch {
            await updateBodySignalCompanionAssociationStatus(
              previousAssociation,
              previousAssociation.status,
              previousAssociation.observationEnabled,
              'previous_association_revoke_failed',
            );
          }
        }
        await saveBodySignalCompanionAssociation({
          ...nextAssociation,
          updatedAt: Date.now(),
        });
        await refreshCompanionState();
      } catch {
        setCompanionActionError('Android 后台感知暂时没有完成，请稍后重新试一次。');
      } finally {
        setCompanionActionBusy(false);
      }
    })();
  };

  const handleCompanionObservationPress = (enabled: boolean) => {
    if (!companionAssociation || companionActionBusy) return;
    void (async () => {
      setCompanionActionBusy(true);
      setCompanionActionError(undefined);
      try {
        if (enabled) {
          await resumeBodySignalPrimaryDeviceObservation(companionAssociation.associationId);
          await updateBodySignalCompanionAssociationStatus(companionAssociation, 'active', true);
        } else {
          await pauseBodySignalPrimaryDeviceObservation(companionAssociation.associationId);
          await updateBodySignalCompanionAssociationStatus(companionAssociation, 'paused', false);
        }
        await refreshCompanionState();
      } catch (error) {
        if (isBodySignalCompanionAssociationMissingError(error)) {
          await updateBodySignalCompanionAssociationStatus(
            companionAssociation,
            'revoked',
            false,
            'android_association_missing',
          ).catch(() => undefined);
          await setPersistedBodySignalDeviceCompanionAssociation(
            companionAssociation.deviceProfileId,
            undefined,
          ).catch(() => undefined);
          await refreshCompanionState().catch(() => undefined);
          setCompanionActionError('Android 中的旧关联已经失效，请重新授权后台感知。');
        } else {
          setCompanionActionError('Android 后台感知状态没有更新，请稍后重新试一次。');
        }
      } finally {
        setCompanionActionBusy(false);
      }
    })();
  };

  const handleCompanionRevokePress = () => {
    if (!companionAssociation || companionActionBusy) return;
    void (async () => {
      setCompanionActionBusy(true);
      setCompanionActionError(undefined);
      try {
        try {
          await revokeBodySignalPrimaryDeviceAssociation(companionAssociation.associationId);
        } catch (error) {
          if (!isBodySignalCompanionAssociationMissingError(error)) throw error;
        }
        await updateBodySignalCompanionAssociationStatus(companionAssociation, 'revoked', false);
        await setPersistedBodySignalDeviceCompanionAssociation(companionAssociation.deviceProfileId, undefined);
        await refreshCompanionState();
      } catch {
        setCompanionActionError('Android 关联没有取消，请稍后重新试一次。');
      } finally {
        setCompanionActionBusy(false);
      }
    })();
  };

  const handleGuardianEnablePress = (enabled: boolean) => {
    if (guardianActionBusy) return;
    void (async () => {
      setGuardianActionBusy(true);
      setGuardianActionError(undefined);
      try {
        if (!enabled) {
          if (scheduledSamplingSettings.enabled) {
            await saveScheduledSamplingEnabled(false);
            await refreshScheduledSampling();
          }
          await disableGuardian();
          await refreshBodySignalGuardianRuntime();
          return;
        }

        const [support, profile] = await Promise.all([
          getGuardianSupport(),
          loadPersistedPrimaryBodySignalDeviceProfile(),
        ]);
        const associationId = fromBodySignalCompanionIdentity(profile?.authorizedAssociationId);
        const association = profile && associationId !== undefined
          ? await loadBodySignalCompanionAssociation(profile.id, associationId)
          : undefined;
        const authKeyHex = profile?.lastAdvertisingId
          ? await getMiBand6AuthKey(profile.lastAdvertisingId)
          : null;
        const check = canEnableBodySignalGuardian({ association, authKeyHex, profile, support });
        setGuardianSupport(support);
        if (!check.ok || !profile || !association || !authKeyHex) {
          throw new Error(guardianEnableErrorText(check.reason));
        }

        await stopColmiScan();
        const legacySession = getColmiConnectionSnapshot().miBand6RealtimeHeartRateSession.status;
        if (legacySession === 'running' || legacySession === 'starting') {
          await stopMiBand6RealtimeHeartRate('manual').catch(() => undefined);
        }
        if (getColmiConnectionSnapshot().status !== 'disconnected') {
          await disconnectColmiDevice({ suppressAutoReconnect: false });
        }
        const appeared = Boolean(
          association.lastAppearedAt
          && association.lastAppearedAt >= (association.lastDisappearedAt ?? 0),
        );
        await provisionPrimaryDevice({
          appeared,
          associationId: association.associationId,
          authKeyHex,
          deviceProfileId: profile.id,
        });
        await restorePersistedMiBand6Battery(profile.id);
        await enableGuardian();
        await refreshBodySignalGuardianRuntime();
      } catch (error) {
        setGuardianActionError(error instanceof Error ? error.message : '全天守候状态没有更新。');
      } finally {
        setGuardianActionBusy(false);
      }
    })();
  };

  const handleGuardianPausePress = () => {
    if (guardianActionBusy) return;
    void (async () => {
      setGuardianActionBusy(true);
      setGuardianActionError(undefined);
      try {
        if (guardianState.paused) await resumeGuardian();
        else await pauseGuardian();
        await refreshBodySignalGuardianRuntime();
      } catch (error) {
        setGuardianActionError(error instanceof Error ? error.message : '全天守候暂停状态没有更新。');
      } finally {
        setGuardianActionBusy(false);
      }
    })();
  };

  const handleGuardianRetryPress = () => {
    if (guardianActionBusy) return;
    void (async () => {
      setGuardianActionBusy(true);
      setGuardianActionError(undefined);
      try {
        await retryGuardianNow();
        await refreshBodySignalGuardianRuntime();
      } catch (error) {
        setGuardianActionError(error instanceof Error ? error.message : '全天守候重试没有完成。');
      } finally {
        setGuardianActionBusy(false);
      }
    })();
  };

  const handleScheduledSamplingToggle = (enabled: boolean) => {
    if (scheduledSamplingBusy) return;
    void (async () => {
      setScheduledSamplingBusy(true);
      setScheduledSamplingError(undefined);
      try {
        const settings = await saveScheduledSamplingEnabled(enabled);
        setScheduledSamplingSettings(settings);
        await refreshBodySignalGuardianRuntime('settings_resume');
        await refreshScheduledSampling();
      } catch (error) {
        setScheduledSamplingError(error instanceof Error ? error.message : '节制采样设置没有保存。');
      } finally {
        setScheduledSamplingBusy(false);
      }
    })();
  };

  const handleScheduledSamplingPause = () => {
    if (scheduledSamplingBusy) return;
    void (async () => {
      setScheduledSamplingBusy(true);
      setScheduledSamplingError(undefined);
      try {
        const settings = await pauseScheduledSamplingUntilTomorrow();
        setScheduledSamplingSettings(settings);
        await refreshBodySignalGuardianRuntime();
      } catch (error) {
        setScheduledSamplingError(error instanceof Error ? error.message : '暂停节制采样没有完成。');
      } finally {
        setScheduledSamplingBusy(false);
      }
    })();
  };

  const handleScheduledSamplingResume = () => {
    if (scheduledSamplingBusy) return;
    void (async () => {
      setScheduledSamplingBusy(true);
      setScheduledSamplingError(undefined);
      try {
        const settings = await resumeScheduledSampling();
        setScheduledSamplingSettings(settings);
        await refreshBodySignalGuardianRuntime();
      } catch (error) {
        setScheduledSamplingError(error instanceof Error ? error.message : '恢复节制采样没有完成。');
      } finally {
        setScheduledSamplingBusy(false);
      }
    })();
  };

  const handleActivityContextToggle = (enabled: boolean) => {
    if (activityContextBusy) return;
    void (async () => {
      setActivityContextBusy(true);
      setActivityContextError(undefined);
      try {
        if (enabled) {
          const didEnable = await requestAndEnableBodySignalActivityContext();
          if (!didEnable) {
            setActivityContextError('活动识别没有开启；君落会把当前情境保守地记为未知。');
          }
        } else {
          await disableBodySignalActivityContext();
        }
      } catch {
        setActivityContextError('活动识别状态没有更新；原有心率采样不会受影响。');
      } finally {
        setActivityContextBusy(false);
      }
    })();
  };

  const handleNextProbeChannelPress = () => {
    if (!connectionState.isConnected || isInitializationBusy(connectionState)) return;
    selectNextColmiProbeChannel();
  };
  const handleProbePress = () => {
    if (!connectionState.isConnected || isInitializationBusy(connectionState)) return;
    void probeColmiCurrentChannel().catch(() => undefined);
  };

  const handleReadFee7Press = () => {
    if (!connectionState.isConnected || isInitializationBusy(connectionState)) return;
    void readColmiFee7Info().catch(() => undefined);
  };

  const handleStandardInfoPress = () => {
    if (!connectionState.isConnected || isInitializationBusy(connectionState)) return;
    void readColmiStandardGattInfo().catch(() => undefined);
  };

  const handleStandardHeartRatePress = () => {
    if (!connectionState.isConnected || isInitializationBusy(connectionState)) return;
    if (connectionState.capabilities.supportsHuami2021Auth) {
      void authenticateMiBand6AndSubscribeHeartRate().catch(() => undefined);
      return;
    }
    void subscribeColmiStandardHeartRate().catch(() => undefined);
  };

  const handleMiBand6RealtimeHeartRatePress = () => {
    const status = guardianOwnsConnection
      ? guardianState.status === 'sampling' ? 'running' : guardianState.status
      : connectionState.miBand6RealtimeHeartRateSession.status;
    if (status === 'running') {
      void stopBodySignalContinuousHeartRate().catch(() => undefined);
      return;
    }
    if ((!connectionState.isConnected && !guardianConnected) || status === 'starting' || status === 'stopping') return;
    void startBodySignalContinuousHeartRate().catch(() => undefined);
  };

  const handleMiBandAuthPress = () => {
    const deviceId = connectionState.connectedDevice?.id;
    if (!deviceId || miBandAuthKeySaving) return;
    void (async () => {
      setMiBandAuthKeySaving(true);
      setMiBandAuthKeyUiError(undefined);
      try {
        if (miBandAuthKeyInput.trim()) {
          await setMiBand6AuthKey(deviceId, miBandAuthKeyInput);
          setMiBandAuthKeyInput('');
        } else if (!connectionState.hasHuami2021AuthKey) {
          throw new Error('请先填写这只手环的 32 位认证密钥。');
        }
        await authenticateMiBand6AndSubscribeHeartRate();
      } catch (error) {
        setMiBandAuthKeyUiError(error instanceof Error ? error.message : '保存认证密钥失败。');
      } finally {
        setMiBandAuthKeySaving(false);
      }
    })();
  };

  const handleSmartHealthR99HeartRatePress = () => {
    if (!connectionState.isConnected || isInitializationBusy(connectionState)) return;
    void startSmartHealthR99HeartRateExperiment().catch(() => undefined);
  };
  const handleBatteryPress = () => {
    if (!connectionState.isConnected || isInitializationBusy(connectionState)) return;
    void requestColmiBattery().catch(() => undefined);
  };

  const handleSmartHealthR99BatteryPress = () => {
    if (!connectionState.isConnected || isInitializationBusy(connectionState)) return;
    void requestSmartHealthR99Battery().catch(() => undefined);
  };

  const handleTimePress = () => {
    if (!connectionState.isConnected || isInitializationBusy(connectionState)) return;
    void syncColmiLocalTime().catch(() => undefined);
  };

  const handleBandTimePress = async () => {
    if (bandTimeSyncBusy) return;
    setBandTimeSyncBusy(true);
    setBandTimeSyncMessage(undefined);
    try {
      const nativeOwns = guardianOwnsBodySignalConnection(getBodySignalGuardianRuntimeState());
      await (nativeOwns ? syncGuardianTime() : syncMiBand6LocalTime());
      setBandTimeSyncMessage('手机时间已写入，请看一下手环表盘。');
    } catch (error) {
      setBandTimeSyncMessage(miBand6TimeSyncErrorMessage(error));
    } finally {
      setBandTimeSyncBusy(false);
    }
  };

  const commandButtonsDisabled = !connectionState.isConnected || !isSafeCommandChannel(connectionState) || isInitializationBusy(connectionState);
  const probeButtonDisabled = !connectionState.isConnected || isInitializationBusy(connectionState);
  const nextProbeButtonDisabled = !connectionState.isConnected || isInitializationBusy(connectionState) || connectionState.candidateChannels.length < 2;
  const readFee7ButtonDisabled = !connectionState.isConnected || isInitializationBusy(connectionState);
  const huamiAuthBusy = connectionState.huami2021AuthStatus === 'starting'
    || connectionState.huami2021AuthStatus === 'waiting_challenge'
    || connectionState.huami2021AuthStatus === 'waiting_confirmation';
  const standardGattButtonDisabled = !connectionState.isConnected
    || !connectionState.capabilities.supportsStandardHeartRate
    || isInitializationBusy(connectionState)
    || huamiAuthBusy;
  const miBand6RealtimeStatus = guardianOwnsConnection
    ? guardianState.status === 'sampling' ? 'running' : guardianState.status
    : connectionState.miBand6RealtimeHeartRateSession.status;
  const miBand6RealtimeButtonDisabled = (!connectionState.isConnected && !guardianConnected)
    || (!guardianOwnsConnection && !connectionState.capabilities.supportsHuami2021Auth)
    || miBand6RealtimeStatus === 'starting'
    || miBand6RealtimeStatus === 'stopping';
  const supportsMiBand6ContinuousHeartRate = guardianOwnsConnection
    || connectionState.capabilities.supportsHuami2021Auth;
  const miBand6RealtimeButtonText = miBand6RealtimeStatus === 'running'
    ? `停止连续测量 · ${formatBodySignalHeartRateRemaining(
      guardianOwnsConnection ? guardianState.samplingEndsAt : connectionState.miBand6RealtimeHeartRateSession.endsAt,
      realtimeClockNow,
      guardianOwnsConnection ? guardianState.lastTransitionAt : connectionState.miBand6RealtimeHeartRateSession.startedAt,
    )}`
    : miBand6RealtimeStatus === 'starting'
      ? '正在启动'
      : miBand6RealtimeStatus === 'stopping'
        ? '正在停止'
        : '连续测量 5 分钟';
  const smartHealthR99ButtonDisabled = !connectionState.isConnected || !supportsSmartHealthR99 || isInitializationBusy(connectionState);
  const smartHealthR99BatteryButtonDisabled = !connectionState.isConnected || !supportsSmartHealthR99 || isInitializationBusy(connectionState);
  // Guardian is Mi Band 6-only; live BLE capability does not depend on a persisted profile.
  const supportsBandTimeSync = guardianOwnsConnection
    || supportsMiBand6TimeCalibration(connectionState.capabilities);
  const bandTimeReady = guardianOwnsConnection
    ? guardianState.status === 'ready' && !guardianState.paused
    : connectionState.isConnected && connectionState.huami2021AuthStatus === 'authenticated';
  const bandTimeMeasuring = ['starting', 'running', 'stopping'].includes(miBand6RealtimeStatus);
  const bandTimeDisabled = bandTimeSyncBusy || !bandTimeReady || bandTimeMeasuring;
  const batteryForegroundReadyRef = useRef(false);
  batteryForegroundReadyRef.current = supportsBandTimeSync && bandTimeReady && !bandTimeMeasuring && !bandTimeSyncBusy;

  useEffect(() => {
    setBatteryError(undefined);
    const refresh = () => {
      if (batteryForegroundReadyRef.current) {
        void readMiBand6Battery({ trigger: 'foreground' }).catch(() => undefined);
      }
    };
    refresh();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    return () => subscription.remove();
  }, [supportsBandTimeSync, bandTimeReady, guardianState.sessionId, connectionState.connectedDevice?.id]);

  const refreshBattery = async () => {
    if (batteryBusy) return;
    setBatteryBusy(true);
    setBatteryError(undefined);
    try { await readMiBand6Battery({ trigger: 'manual' }); }
    catch (error) { setBatteryError(miBand6BatteryErrorMessage(error)); }
    finally { setBatteryBusy(false); }
  };

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回设置" onPress={() => navigate('settings')} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>身体感知</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.panel}>
          <View style={styles.statusRow}>
            <View>
              <Text style={styles.panelTitle}>穿戴设备</Text>
              <Text style={styles.statusText}>{statusText(scanState)}</Text>
            </View>
            {scanState.isScanning ? <ActivityIndicator color="#7A9F79" /> : null}
          </View>

          {scanState.errorMessage ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorTitle}>{scanState.errorMessage}</Text>
              {scanState.missingPermissions.length ? (
                <Text style={styles.errorText}>缺少权限：{scanState.missingPermissions.join('、')}</Text>
              ) : null}
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            onPress={handleScanPress}
            style={({ pressed }) => [styles.scanButton, scanState.isScanning && styles.stopButton, pressed && styles.buttonPressed]}
          >
            <Text style={styles.scanButtonText}>{scanState.isScanning ? '停止扫描' : '扫描设备'}</Text>
          </Pressable>
        </View>

        <View style={styles.panel}>
          <View style={styles.statusRow}>
            <View style={styles.connectionHeaderText}>
              <Text style={styles.panelTitle}>{guardianOwnsConnection ? (guardianConnected ? '已连接' : '全天守候') : connectionTitle(connectionState)}</Text>
              <Text style={styles.statusText}>{guardianOwnsConnection ? bodySignalGuardianStatusMessage(guardianState) : connectionState.statusMessage}</Text>
            </View>
            {(!guardianOwnsConnection && isConnectionBusy(connectionState))
              || (!guardianOwnsConnection && isInitializationBusy(connectionState))
              || (guardianOwnsConnection && ['starting', 'connecting', 'discovering', 'authenticating', 'stopping'].includes(guardianState.status))
              ? <ActivityIndicator color="#7A9F79" /> : null}
          </View>

          {guardianOwnsConnection && primaryDeviceProfile ? (
            <View style={styles.connectionBlock}>
              <Text style={styles.connectionLabel}>设备</Text>
              <Text style={styles.connectionValue}>{primaryDeviceProfile.displayName}</Text>
              <Text style={styles.connectionId}>由 Android 全天守候服务管理</Text>
            </View>
          ) : connectionState.connectedDevice ? (
            <View style={styles.connectionBlock}>
              <Text style={styles.connectionLabel}>设备</Text>
              <Text style={styles.connectionValue}>{connectionState.connectedDevice.displayName}</Text>
              <Text style={styles.connectionId}>{connectionState.connectedDevice.id}</Text>
            </View>
          ) : null}

          {!guardianOwnsConnection && shouldShowConnectionError(connectionState) ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorTitle}>{connectionState.errorMessage}</Text>
            </View>
          ) : null}

          {!guardianOwnsConnection && connectionState.initializationErrorMessage ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorTitle}>{connectionState.initializationErrorMessage}</Text>
            </View>
          ) : null}

          {!guardianOwnsConnection && connectionState.isConnected && connectionState.capabilities.supportsHuami2021Auth ? (
            <View style={styles.authPanel}>
              <View style={styles.runtimeHeaderRow}>
                <View style={styles.connectionHeaderText}>
                  <Text style={styles.connectionLabel}>小米手环认证</Text>
                  <Text style={styles.statusText}>
                    {connectionState.huami2021AuthStatus === 'authenticated'
                      ? '认证已通过，标准心率监听已经解锁。'
                      : connectionState.hasHuami2021AuthKey
                        ? '君落已安全保存这只手环的密钥。'
                        : '输入从 Zepp Life 取得的 32 位认证密钥，只保存在手机安全区。'}
                  </Text>
                </View>
                {huamiAuthBusy || miBandAuthKeySaving ? <ActivityIndicator color="#7A9F79" /> : null}
              </View>
              {connectionState.huami2021AuthStatus !== 'authenticated' ? (
                <>
                  <TextInput
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!huamiAuthBusy && !miBandAuthKeySaving}
                    onChangeText={setMiBandAuthKeyInput}
                    placeholder={connectionState.hasHuami2021AuthKey ? '留空即可使用已保存密钥' : '32 位认证密钥'}
                    placeholderTextColor="#98A294"
                    secureTextEntry
                    style={styles.authKeyInput}
                    value={miBandAuthKeyInput}
                  />
                  <Pressable
                    accessibilityRole="button"
                    disabled={huamiAuthBusy || miBandAuthKeySaving}
                    onPress={handleMiBandAuthPress}
                    style={({ pressed }) => [
                      styles.readButton,
                      (huamiAuthBusy || miBandAuthKeySaving) && styles.disabledButton,
                      pressed && styles.buttonPressed,
                    ]}
                  >
                    <Text style={styles.probeButtonText}>
                      {connectionState.hasHuami2021AuthKey && !miBandAuthKeyInput.trim()
                        ? '使用已保存密钥认证'
                        : '安全保存并认证'}
                    </Text>
                  </Pressable>
                </>
              ) : null}
              {miBandAuthKeyUiError ? <Text style={styles.authError}>{miBandAuthKeyUiError}</Text> : null}
              {connectionState.huami2021AuthErrorMessage ? (
                <Text style={styles.authError}>{connectionState.huami2021AuthErrorMessage}</Text>
              ) : null}
            </View>
          ) : null}

          <View style={styles.metricGrid}>
            <View style={styles.metricItemLarge}>
              <Text style={styles.metricLabel}>最近心率</Text>
              <View style={styles.heartValueRow}>
              <Text style={styles.heartValue}>{bodySignalSnapshot.heartRate?.value ?? '--'}</Text>
                <Text style={styles.heartUnit}>bpm</Text>
              </View>
              <Text style={styles.metricHint}>{guardianOwnsConnection ? bodySignalGuardianStatusMessage(guardianState) : measurementStatusText(connectionState)}</Text>
            </View>
            <View style={styles.metricItemLarge}>
              <Text style={styles.metricLabel}>读取时间</Text>
              <Text style={styles.metricValue}>{formatTime(bodySignalSnapshot.heartRate?.measuredAt)}</Text>
              <Text style={styles.metricHint}>趋势在与你页查看</Text>
            </View>
          </View>

          <View style={styles.batterySummary}>
            <View>
              <Text style={styles.metricLabel}>设备电量</Text>
              <Text style={styles.metricValue}>
                {bodySignalSnapshot.battery ? `${bodySignalSnapshot.battery.value}%` : supportsBandTimeSync ? '暂未读到' : '暂未接入'}
              </Text>
            </View>
            <Text style={[styles.metricHint, { flex: 1, marginLeft: 12 }]}>
              {bodySignalSnapshot.battery || supportsBandTimeSync ? bodySignalBatteryHint(bodySignalSnapshot) : '等待支持设备'}
            </Text>
            {supportsBandTimeSync ? <Pressable accessibilityRole="button" accessibilityLabel="刷新手环电量"
              disabled={batteryBusy || bandTimeDisabled} onPress={() => { void refreshBattery(); }}
              style={[{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, (batteryBusy || bandTimeDisabled) && styles.disabledButton]}>
              {batteryBusy ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.metricValue}>↻</Text>}
            </Pressable> : null}
          </View>
          {batteryError ? <Text style={styles.statusText}>{batteryError}</Text> : null}

          {supportsSmartHealthR99 ? (
            <Pressable
              accessibilityRole="button"
              disabled={smartHealthR99BatteryButtonDisabled}
              onPress={handleSmartHealthR99BatteryPress}
              style={({ pressed }) => [styles.readButton, smartHealthR99BatteryButtonDisabled && styles.disabledButton, pressed && styles.buttonPressed]}
            >
              <Text style={styles.probeButtonText}>读取 R99 电量</Text>
            </Pressable>
          ) : null}

          <View style={styles.actionRowWrap}>
            {supportsSmartHealthR99 ? (
              <Pressable
                accessibilityRole="button"
                disabled={smartHealthR99ButtonDisabled}
                onPress={handleSmartHealthR99HeartRatePress}
                style={({ pressed }) => [styles.primaryActionButton, smartHealthR99ButtonDisabled && styles.disabledButton, pressed && styles.buttonPressed]}
              >
                <Text style={styles.primaryActionButtonText}>测量 R99 心率</Text>
              </Pressable>
            ) : null}
            {supportsStandardHeartRate ? (
              <Pressable
                accessibilityRole="button"
                disabled={supportsMiBand6ContinuousHeartRate
                  ? miBand6RealtimeButtonDisabled
                  : standardGattButtonDisabled}
                onPress={supportsMiBand6ContinuousHeartRate
                  ? handleMiBand6RealtimeHeartRatePress
                  : handleStandardHeartRatePress}
                style={({ pressed }) => [
                  styles.primaryActionButton,
                  (supportsMiBand6ContinuousHeartRate
                    ? miBand6RealtimeButtonDisabled
                    : standardGattButtonDisabled) && styles.disabledButton,
                  pressed && styles.buttonPressed,
                ]}
              >
                <Text style={styles.primaryActionButtonText}>
                  {supportsMiBand6ContinuousHeartRate
                    ? miBand6RealtimeButtonText
                    : connectionState.standardHeartRateInfo
                      ? '重新监听心率'
                      : '标准心率监听中'}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => onOpenBodyData?.({})}
              style={({ pressed }) => [styles.secondaryOutlineButton, pressed && styles.buttonPressed]}
            >
              <Text style={styles.secondaryOutlineButtonText}>去与你查看身体数据</Text>
            </Pressable>
          </View>

          {supportsBandTimeSync ? (
            <>
              <Pressable
                accessibilityRole="button"
                disabled={bandTimeDisabled}
                onPress={() => void handleBandTimePress()}
                style={({ pressed }) => [styles.readButton, bandTimeDisabled && styles.disabledButton, pressed && styles.buttonPressed]}
              >
                <Text style={styles.probeButtonText}>{bandTimeSyncBusy ? '正在校时' : '校准手环时间'}</Text>
              </Pressable>
              <Text style={styles.metricHint}>
                {bandTimeSyncMessage || (bandTimeMeasuring ? '请先停止心率测量，再校准时间。'
                  : !bandTimeReady ? '连接并认证完成后可校时。' : '使用手机当前日期、时间和时区。')}
              </Text>
            </>
          ) : null}

          <View style={styles.runtimePanel}>
            <View style={styles.runtimeHeaderRow}>
              <View style={styles.connectionHeaderText}>
                <Text style={styles.connectionLabel}>Android 后台找回</Text>
                <Text style={styles.statusText}>
                  {companionSupportSummary(companionSupport) || companionPresenceSummary(companionAssociation)}
                </Text>
                {companionAssociation?.lastAppearedAt ? (
                  <Text style={styles.statusText}>最近出现：{formatTime(companionAssociation.lastAppearedAt)}</Text>
                ) : null}
                {companionAssociation?.lastDisappearedAt ? (
                  <Text style={styles.statusText}>最近离开：{formatTime(companionAssociation.lastDisappearedAt)}</Text>
                ) : null}
              </View>
              {companionActionBusy ? <ActivityIndicator color="#7A9F79" /> : null}
            </View>
            {companionActionError ? <Text style={styles.authError}>{companionActionError}</Text> : null}
            {companionSupport.supported ? (
              companionAssociation?.status === 'active' ? (
                <View style={styles.actionRowWrap}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={companionActionBusy}
                    onPress={() => handleCompanionObservationPress(false)}
                    style={({ pressed }) => [styles.secondaryOutlineButton, companionActionBusy && styles.disabledButton, pressed && styles.buttonPressed]}
                  >
                    <Text style={styles.secondaryOutlineButtonText}>暂停感知</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={companionActionBusy}
                    onPress={handleCompanionRevokePress}
                    style={({ pressed }) => [styles.secondaryOutlineButton, companionActionBusy && styles.disabledButton, pressed && styles.buttonPressed]}
                  >
                    <Text style={styles.secondaryOutlineButtonText}>取消关联</Text>
                  </Pressable>
                </View>
              ) : companionAssociation?.status === 'paused' ? (
                <View style={styles.actionRowWrap}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={companionActionBusy}
                    onPress={() => handleCompanionObservationPress(true)}
                    style={({ pressed }) => [styles.readButton, companionActionBusy && styles.disabledButton, pressed && styles.buttonPressed]}
                  >
                    <Text style={styles.probeButtonText}>恢复感知</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={companionActionBusy}
                    onPress={handleCompanionRevokePress}
                    style={({ pressed }) => [styles.secondaryOutlineButton, companionActionBusy && styles.disabledButton, pressed && styles.buttonPressed]}
                  >
                    <Text style={styles.secondaryOutlineButtonText}>取消关联</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  disabled={companionActionBusy || !connectionState.isConnected || !primaryDeviceProfile?.isPrimary}
                  onPress={handleCompanionAssociationPress}
                  style={({ pressed }) => [styles.readButton, (companionActionBusy || !connectionState.isConnected || !primaryDeviceProfile?.isPrimary) && styles.disabledButton, pressed && styles.buttonPressed]}
                >
                  <Text style={styles.probeButtonText}>允许 Android 在后台感知此设备</Text>
                </Pressable>
              )
            ) : null}
          </View>

          <View style={styles.runtimePanel}>
            <View style={styles.runtimeHeaderRow}>
              <View style={styles.connectionHeaderText}>
                <Text style={styles.connectionLabel}>身体状态情境</Text>
                <Text style={styles.statusText}>用活动、导航、睡眠与运动线索理解心率所处的状态，不读取位置。</Text>
              </View>
              {activityContextBusy || careRuntimeState.isEvaluating ? <ActivityIndicator color="#7A9F79" /> : null}
            </View>
            <View style={styles.autoSettingRow}>
              <View style={styles.autoSettingText}>
                <Text style={styles.autoSettingTitle}>识别休息与活动</Text>
                <Text style={styles.autoSettingHint}>只记录活动类别与切换时间，不保存路线或坐标。</Text>
              </View>
              <Switch
                disabled={activityContextBusy || !careRuntimeState.activitySupport.supported}
                onValueChange={handleActivityContextToggle}
                value={careRuntimeState.activitySupport.enabled}
                trackColor={{ false: '#D8DED3', true: '#B9D2B4' }}
                thumbColor={careRuntimeState.activitySupport.enabled ? '#6F946C' : '#F7F7F7'}
              />
            </View>
            <View style={styles.runtimeStatusBox}>
              <Text style={styles.connectionId}>当前情境：{bodySignalContextText(careRuntimeState.currentContext)}</Text>
              <Text style={styles.connectionId}>判断来源：{bodySignalContextSourceText(careRuntimeState.currentContextSource)}</Text>
              <Text style={styles.connectionId}>证据时间：{formatTime(careRuntimeState.currentContextUpdatedAt)}</Text>
              <Text style={styles.connectionId}>
                {careRuntimeState.activitySupport.navigationEvidenceActive
                  ? `导航线索：地图持续通知存在 · ${formatTime(careRuntimeState.activitySupport.lastNavigationObservedAt)}`
                  : careRuntimeState.activitySupport.navigationEvidenceAvailable
                    ? '导航线索：可用，仅识别地图持续通知'
                    : '导航线索：未开启，不会读取路线或位置'}
              </Text>
              <Text style={styles.connectionId}>{bodySignalBaselineProgressText(careRuntimeState)}</Text>
            </View>
            {!careRuntimeState.activitySupport.navigationEvidenceAvailable ? (
              <Pressable
                accessibilityRole="button"
                onPress={openPhoneNotificationListenerSettings}
                style={({ pressed }) => [styles.secondaryOutlineButton, pressed && styles.buttonPressed]}
              >
                <Text style={styles.secondaryOutlineButtonText}>打开通知读取设置</Text>
              </Pressable>
            ) : null}
            {!careRuntimeState.activitySupport.supported ? (
              <Text style={styles.statusText}>这台手机暂不支持活动变化识别，情境会保持为未知，心率采样仍可正常使用。</Text>
            ) : null}
            {careRuntimeState.activitySupport.supported && !careRuntimeState.activitySupport.permissionGranted ? (
              <Text style={styles.statusText}>尚未允许“身体活动”权限；开启开关时 Android 会询问一次。</Text>
            ) : null}
            {activityContextError ? <Text style={styles.authError}>{activityContextError}</Text> : null}
          </View>

          <View style={styles.runtimePanel}>
            <View style={styles.runtimeHeaderRow}>
              <View style={styles.connectionHeaderText}>
                <Text style={styles.connectionLabel}>每 30 分钟节制采样</Text>
                <Text style={styles.statusText}>全天尝试，每轮最多两分钟；系统可能延迟，不会补跑堆积。</Text>
              </View>
              {scheduledSamplingBusy ? <ActivityIndicator color="#7A9F79" /> : null}
            </View>
            <View style={styles.autoSettingRow}>
              <View style={styles.autoSettingText}>
                <Text style={styles.autoSettingTitle}>启用节制采样</Text>
                <Text style={styles.autoSettingHint}>仅由已就绪的 Mi Band 6 全天守候服务执行。</Text>
              </View>
              <Switch
                disabled={scheduledSamplingBusy || !guardianState.enabled}
                onValueChange={handleScheduledSamplingToggle}
                value={scheduledSamplingSettings.enabled}
                trackColor={{ false: '#D8DED3', true: '#B9D2B4' }}
                thumbColor={scheduledSamplingSettings.enabled ? '#6F946C' : '#F7F7F7'}
              />
            </View>
            <View style={styles.runtimeStatusBox}>
              <Text style={styles.connectionId}>状态：{scheduledSamplingStatusText(guardianState)}</Text>
              <Text style={styles.connectionId}>预计下次尝试：{formatTime(guardianState.nextSamplingDueAt)}</Text>
              <Text style={styles.connectionId}>最近一轮：{scheduledSamplingResultText(scheduledSamplingWindows[0])}</Text>
              {scheduledSamplingSkipReason ? (
                <Text style={styles.connectionId}>{scheduledSamplingSkipReason}</Text>
              ) : null}
            </View>
            {scheduledSamplingError ? <Text style={styles.authError}>{scheduledSamplingError}</Text> : null}
            {scheduledSamplingSettings.enabled ? (
              <View style={styles.actionRowWrap}>
                {scheduledSamplingSettings.pauseUntil && scheduledSamplingSettings.pauseUntil > Date.now() ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={scheduledSamplingBusy}
                    onPress={handleScheduledSamplingResume}
                    style={({ pressed }) => [styles.secondaryOutlineButton, scheduledSamplingBusy && styles.disabledButton, pressed && styles.buttonPressed]}
                  >
                    <Text style={styles.secondaryOutlineButtonText}>恢复节制采样</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    disabled={scheduledSamplingBusy}
                    onPress={handleScheduledSamplingPause}
                    style={({ pressed }) => [styles.secondaryOutlineButton, scheduledSamplingBusy && styles.disabledButton, pressed && styles.buttonPressed]}
                  >
                    <Text style={styles.secondaryOutlineButtonText}>暂停到明天 08:00</Text>
                  </Pressable>
                )}
              </View>
            ) : null}
          </View>

          <View style={styles.runtimePanel}>
            <View style={styles.runtimeHeaderRow}>
              <View style={styles.connectionHeaderText}>
                <Text style={styles.connectionLabel}>全天连接守候</Text>
                <Text style={styles.statusText}>锁屏或切换 App 后继续守候主手环；待机时不会持续点亮心率传感器。</Text>
              </View>
              {guardianActionBusy ? <ActivityIndicator color="#7A9F79" /> : null}
            </View>
            <View style={styles.autoSettingRow}>
              <View style={styles.autoSettingText}>
                <Text style={styles.autoSettingTitle}>启用全天守候</Text>
                <Text style={styles.autoSettingHint}>目前只支持已关联且已保存认证密钥的 Mi Band 6。</Text>
              </View>
              <Switch
                disabled={guardianActionBusy}
                onValueChange={handleGuardianEnablePress}
                value={guardianState.enabled}
                trackColor={{ false: '#D8DED3', true: '#B9D2B4' }}
                thumbColor={guardianState.enabled ? '#6F946C' : '#F7F7F7'}
              />
            </View>
            <View style={styles.runtimeStatusBox}>
              <Text style={styles.connectionId}>状态：{bodySignalGuardianStatusMessage(guardianState)}</Text>
              <Text style={styles.connectionId}>最近连接：{formatTime(guardianState.lastConnectedAt)}</Text>
              <Text style={styles.connectionId}>最近心率：{formatTime(guardianState.lastHeartRateAt)}</Text>
              {guardianState.retryAttempt ? <Text style={styles.connectionId}>本轮重试：{guardianState.retryAttempt}/5</Text> : null}
            </View>
            {!guardianSupport.supported ? (
              <Text style={styles.authError}>当前 Android 版本或安装包暂不支持全天连接守候。</Text>
            ) : null}
            {guardianActionError ? <Text style={styles.authError}>{guardianActionError}</Text> : null}
            {guardianState.enabled ? (
              <View style={styles.actionRowWrap}>
                <Pressable
                  accessibilityRole="button"
                  disabled={guardianActionBusy}
                  onPress={handleGuardianPausePress}
                  style={({ pressed }) => [styles.secondaryOutlineButton, guardianActionBusy && styles.disabledButton, pressed && styles.buttonPressed]}
                >
                  <Text style={styles.secondaryOutlineButtonText}>{guardianState.paused ? '恢复守候' : '暂停守候'}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={guardianActionBusy || guardianState.paused}
                  onPress={handleGuardianRetryPress}
                  style={({ pressed }) => [styles.secondaryOutlineButton, (guardianActionBusy || guardianState.paused) && styles.disabledButton, pressed && styles.buttonPressed]}
                >
                  <Text style={styles.secondaryOutlineButtonText}>立即重试</Text>
                </Pressable>
              </View>
            ) : null}
          </View>

          <View style={styles.runtimePanel}>
            <View style={styles.runtimeHeaderRow}>
              <View style={styles.connectionHeaderText}>
                <Text style={styles.connectionLabel}>随身自动恢复</Text>
                <Text style={styles.statusText}>打开君落或回到前台时，尽量找回上次连接的穿戴设备。</Text>
              </View>
              {runtimeState.isResuming ? <ActivityIndicator color="#7A9F79" /> : null}
            </View>
            <View style={styles.autoSettingRow}>
              <View style={styles.autoSettingText}>
                <Text style={styles.autoSettingTitle}>自动恢复穿戴设备</Text>
                <Text style={styles.autoSettingHint}>不会后台常驻，只在 App 前台轻轻尝试。</Text>
              </View>
              <Switch
                onValueChange={handleToggleAutoReconnect}
                value={runtimeState.isAutoReconnectEnabled}
                trackColor={{ false: '#D8DED3', true: '#B9D2B4' }}
                thumbColor={runtimeState.isAutoReconnectEnabled ? '#6F946C' : '#F7F7F7'}
              />
            </View>
            <View style={styles.autoSettingRow}>
              <View style={styles.autoSettingText}>
                <Text style={styles.autoSettingTitle}>重连后恢复心率</Text>
                <Text style={styles.autoSettingHint}>R99 测一次；手环 6 自动开始一轮五分钟；其他标准设备只恢复监听。</Text>
              </View>
              <Switch
                onValueChange={handleToggleAutoMeasure}
                value={runtimeState.isAutoMeasureAfterReconnectEnabled}
                trackColor={{ false: '#D8DED3', true: '#B9D2B4' }}
                thumbColor={runtimeState.isAutoMeasureAfterReconnectEnabled ? '#6F946C' : '#F7F7F7'}
              />
            </View>
            <View style={styles.runtimeStatusBox}>
              <Text style={styles.connectionId}>状态：{runtimeStatusText(runtimeState)}</Text>
              <Text style={styles.connectionId}>最近尝试：{formatTime(runtimeState.lastAttemptAt)}</Text>
              <Text style={styles.connectionId}>最近连上：{formatTime(runtimeState.lastConnectedAt)}</Text>
              <Text style={styles.connectionId}>最近恢复心率：{formatTime(runtimeState.lastAutoMeasureAt)}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={runtimeState.isResuming}
              onPress={handleRuntimeResumePress}
              style={({ pressed }) => [styles.secondaryOutlineButton, runtimeState.isResuming && styles.disabledButton, pressed && styles.buttonPressed]}
            >
              <Text style={styles.secondaryOutlineButtonText}>立即尝试恢复</Text>
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => setDiagnosticsExpanded((value) => !value)}
            style={({ pressed }) => [styles.diagnosticToggle, pressed && styles.buttonPressed]}
          >
            <View style={styles.connectionHeaderText}>
              <Text style={styles.connectionLabel}>诊断与破译工具</Text>
              <Text style={styles.statusText}>用于排查设备协议，不是日常使用。</Text>
            </View>
            <Text style={styles.expandText}>{diagnosticsExpanded ? '收起' : '展开'}</Text>
          </Pressable>

          {supportsBandTimeSync ? (
            <MiBand6ActivitySection ready={bandTimeReady && !bandTimeMeasuring && !bandTimeSyncBusy}
              identity={guardianState.sessionId ?? connectionState.connectedDevice?.id} showManualAction={false} />
          ) : null}
          <BodyDataSyncStatus onOpen={() => onOpenBodyData?.({ section: 'sleep' })} />
          {connectionState.isConnected && diagnosticsExpanded ? (
            <View style={styles.connectionBlock}>
              <Text style={styles.connectionLabel}>安全初始化</Text>
              <Text style={styles.statusText}>{connectionState.initializationMessage}</Text>
              {!isSafeCommandChannel(connectionState) ? (
                <Text style={styles.connectionId}>当前通道暂不自动发送命令，避免戒指再次断开。</Text>
              ) : null}
              <View style={styles.metricGrid}>
                <View style={styles.metricItem}>
                  <Text style={styles.metricLabel}>电量</Text>
                  <Text style={styles.metricValue}>{batteryLevelText(connectionState)}</Text>
                </View>
                <View style={styles.metricItem}>
                  <Text style={styles.metricLabel}>标准心率</Text>
                  <Text style={styles.metricValue}>{standardHeartRateText(connectionState)}</Text>
                </View>
                <View style={styles.metricItem}>
                  <Text style={styles.metricLabel}>R99 心率</Text>
                  <Text style={styles.metricValue}>{smartHealthR99HeartRateText(connectionState)}</Text>
                </View>
                <View style={styles.metricItem}>
                  <Text style={styles.metricLabel}>R99 电量</Text>
                  <Text style={styles.metricValue}>{smartHealthR99BatteryText(connectionState)}</Text>
                </View>
              </View>
              <Text style={styles.connectionId}>R99 电量状态：{smartHealthR99BatteryStatusText(connectionState)}</Text>
              {connectionState.smartHealthR99BatteryInfo ? (
                <Text style={styles.connectionId}>
                  原始状态码：{connectionState.smartHealthR99BatteryInfo.deviceBatteryState} · {formatTime(connectionState.smartHealthR99BatteryInfo.receivedAt)}
                </Text>
              ) : null}
              <Text style={styles.connectionId}>标准信息：{standardGattInfoText(connectionState)}</Text>
              {connectionState.standardGattInfoErrorMessage ? (
                <Text style={styles.connectionId}>标准信息读取提示：{connectionState.standardGattInfoErrorMessage}</Text>
              ) : null}
              {!guardianOwnsConnection ? (
                <>
                  <Text style={styles.connectionId}>新认证状态：{connectionState.huami2021AuthStatus}</Text>
                  {connectionState.huami2021AuthErrorMessage ? (
                    <Text style={styles.connectionId}>新认证提示：{connectionState.huami2021AuthErrorMessage}</Text>
                  ) : null}
                </>
              ) : null}
              {connectionState.standardHeartRateErrorMessage ? (
                <Text style={styles.connectionId}>心率监听错误：{connectionState.standardHeartRateErrorMessage}</Text>
              ) : null}
              <Text style={styles.connectionId}>最近校时：{formatTime(connectionState.lastTimeSyncAt)}</Text>
              <Text style={styles.connectionId}>最近写入：{connectionState.lastCommandLabel ?? '暂未写入'} · {formatTime(connectionState.lastCommandWriteAt)}</Text>
              <Text numberOfLines={1} style={styles.connectionId}>最近发送：{connectionState.lastTxHex ?? '暂未发送'}</Text>
              <Text numberOfLines={2} style={styles.connectionId}>最近接收：{latestRxText(connectionState)}</Text>
              <Text numberOfLines={1} style={styles.connectionId}>接收文本：{connectionState.lastRxText ?? '暂未接收'}</Text>
              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  disabled={commandButtonsDisabled}
                  onPress={handleBatteryPress}
                  style={({ pressed }) => [styles.secondaryButton, commandButtonsDisabled && styles.disabledButton, pressed && styles.buttonPressed]}
                >
                  <Text style={styles.secondaryButtonText}>读取标准 COLMI 电量</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={commandButtonsDisabled}
                  onPress={handleTimePress}
                  style={({ pressed }) => [styles.secondaryButton, commandButtonsDisabled && styles.disabledButton, pressed && styles.buttonPressed]}
                >
                  <Text style={styles.secondaryButtonText}>重新校准时间</Text>
                </Pressable>
              </View>
              <Text style={styles.connectionId}>
                当前只有 100% 的第一份真实抓包；取得第二个不同电量值前，不会自动读取。
              </Text>
              <Text style={styles.connectionId}>当前测试：{probeChannelText(connectionState)}</Text>
              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  disabled={probeButtonDisabled}
                  onPress={handleProbePress}
                  style={({ pressed }) => [styles.probeButton, probeButtonDisabled && styles.disabledButton, pressed && styles.buttonPressed]}
                >
                  <Text style={styles.probeButtonText}>测试通道</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={nextProbeButtonDisabled}
                  onPress={handleNextProbeChannelPress}
                  style={({ pressed }) => [styles.probeButton, nextProbeButtonDisabled && styles.disabledButton, pressed && styles.buttonPressed]}
                >
                  <Text style={styles.probeButtonText}>换下个通道</Text>
                </Pressable>
              </View>
              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  disabled={standardGattButtonDisabled}
                  onPress={handleStandardInfoPress}
                  style={({ pressed }) => [styles.probeButton, standardGattButtonDisabled && styles.disabledButton, pressed && styles.buttonPressed]}
                >
                  <Text style={styles.probeButtonText}>读取标准信息</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={standardGattButtonDisabled}
                  onPress={handleStandardHeartRatePress}
                  style={({ pressed }) => [styles.probeButton, standardGattButtonDisabled && styles.disabledButton, pressed && styles.buttonPressed]}
                >
                  <Text style={styles.probeButtonText}>监听标准心率</Text>
                </Pressable>
              </View>
              <Text style={styles.connectionId}>标准心率使用 180d/2a37，只订阅通知，不写入命令。</Text>
              <Pressable
                accessibilityRole="button"
                disabled={readFee7ButtonDisabled}
                onPress={handleReadFee7Press}
                style={({ pressed }) => [styles.readButton, readFee7ButtonDisabled && styles.disabledButton, pressed && styles.buttonPressed]}
              >
                <Text style={styles.probeButtonText}>读取 FEE7</Text>
              </Pressable>
              <Text style={styles.connectionId}>测试通道只发送一包 0x03；读取 FEE7 只读 fec9，不写入命令。</Text>
            </View>
          ) : null}

          {diagnosticsExpanded && companionAssociation ? (
            <View style={styles.connectionBlock}>
              <Text style={styles.connectionLabel}>Android 关联诊断</Text>
              <Text style={styles.connectionId}>关联状态：{companionAssociation.status}</Text>
              <Text style={styles.connectionId}>关联编号：{companionAssociation.associationId}</Text>
              <Text style={styles.connectionId}>观察：{companionAssociation.observationEnabled ? '已启用' : '已暂停'}</Text>
              {companionAssociation.lastErrorCode ? <Text style={styles.connectionId}>最近技术状态：{companionAssociation.lastErrorCode}</Text> : null}
            </View>
          ) : null}

          {diagnosticsExpanded ? (
            <View style={styles.connectionBlock}>
              <Text style={styles.connectionLabel}>身体事件引擎诊断</Text>
              <Text style={styles.connectionId}>情境置信度：{careRuntimeState.currentContextConfidence.toFixed(2)}</Text>
              <Text style={styles.connectionId}>基线状态：{careRuntimeState.baseline?.readiness ?? '尚未建立'}</Text>
              <Text style={styles.connectionId}>原生待入库事件：{careRuntimeState.activitySupport.pendingEventCount ?? 0}</Text>
              {careRuntimeState.activitySupport.lastReceiverAt ? (
                <Text style={styles.connectionId}>最近收到系统广播：{formatTime(careRuntimeState.activitySupport.lastReceiverAt)}</Text>
              ) : null}
              {careRuntimeState.activitySupport.lastRegistrationAt ? (
                <Text style={styles.connectionId}>最近登记活动监听：{formatTime(careRuntimeState.activitySupport.lastRegistrationAt)}</Text>
              ) : null}
              {careRuntimeState.activitySupport.lastNativeEventAt ? (
                <Text style={styles.connectionId}>
                  最近系统活动：{careRuntimeState.activitySupport.lastNativeActivity ?? 'unknown'} / {careRuntimeState.activitySupport.lastNativeTransition ?? 'unknown'} · {formatTime(careRuntimeState.activitySupport.lastNativeEventAt)}
                </Text>
              ) : null}
              {careRuntimeState.activitySupport.lastNativeObservationAt ? (
                <Text style={styles.connectionId}>
                  最近低频补查：{careRuntimeState.activitySupport.lastNativeActivity ?? 'unknown'} · 置信度 {careRuntimeState.activitySupport.lastNativeConfidence ?? 0}% · {formatTime(careRuntimeState.activitySupport.lastNativeObservationAt)}
                </Text>
              ) : null}
              {careRuntimeState.activitySupport.lastNativeErrorCode ? (
                <Text style={styles.connectionId}>原生活动状态：{careRuntimeState.activitySupport.lastNativeErrorCode}</Text>
              ) : null}
              {careRuntimeState.activitySupport.lastRegistrationErrorCode ? (
                <Text style={styles.connectionId}>活动监听登记状态：{careRuntimeState.activitySupport.lastRegistrationErrorCode}</Text>
              ) : null}
              {careRuntimeState.lastErrorCode ? (
                <Text style={styles.connectionId}>最近技术状态：{careRuntimeState.lastErrorCode}</Text>
              ) : null}
              {careRuntimeState.recentEvents.length ? (
                careRuntimeState.recentEvents.slice(0, 5).map((event) => (
                  <Text key={event.id} numberOfLines={2} style={styles.connectionId}>
                    结构化事件 · {event.severity} · {event.context} · {event.direction} · {event.reason} · {formatTime(event.observedAt)}
                  </Text>
                ))
              ) : (
                <Text style={styles.connectionId}>暂时没有结构化事件。</Text>
              )}
            </View>
          ) : null}

          {diagnosticsExpanded ? (
            <>
              <View style={styles.connectionBlock}>
                <Text style={styles.connectionLabel}>通信通道</Text>
                <Text style={styles.monoText}>{channelText(connectionState)}</Text>
                {connectionState.v2Channel ? <Text style={styles.statusText}>已发现 V2 通道</Text> : null}
              </View>

              {connectionState.serviceUUIDs.length ? (
                <View style={styles.connectionBlock}>
                  <Text style={styles.connectionLabel}>服务</Text>
                  {connectionState.serviceUUIDs.map((uuid) => (
                    <Text key={uuid} numberOfLines={1} style={styles.connectionId}>{uuid}</Text>
                  ))}
                </View>
              ) : null}
              {connectionState.characteristicSummaries.length ? (
                <View style={styles.connectionBlock}>
                  <Text style={styles.connectionLabel}>特征权限</Text>
                  {connectionState.characteristicSummaries.map((summary, index) => (
                    <Text key={`${index}-${summary}`} numberOfLines={2} style={styles.connectionId}>{summary}</Text>
                  ))}
                </View>
              ) : null}
            </>
          ) : null}

          {connectionState.isConnected ? (
            <Pressable
              accessibilityRole="button"
              onPress={handleDisconnectPress}
              style={({ pressed }) => [styles.disconnectButton, pressed && styles.buttonPressed]}
            >
              <Text style={styles.disconnectButtonText}>断开连接</Text>
            </Pressable>
          ) : null}
        </View>

        <Text style={styles.sectionTitle}>支持的设备与附近设备</Text>
        <View style={styles.deviceList}>
          {scanState.devices.length ? (
            scanState.devices.map((device) => {
              const busy = isConnectionBusy(connectionState);
              return (
                <Pressable
                  key={device.id}
                  disabled={busy}
                  onPress={() => handleDevicePress(device)}
                  style={({ pressed }) => [styles.deviceRow, pressed && styles.devicePressed, busy && styles.disabledRow]}
                >
                  <View style={styles.deviceMain}>
                    <Text numberOfLines={1} style={styles.deviceName}>{device.displayName}</Text>
                    <Text numberOfLines={1} style={styles.deviceId}>{device.id}</Text>
                  </View>
                  <View style={styles.deviceMeta}>
                    <Text style={styles.confidence}>{confidenceText(device)}</Text>
                    <Text style={styles.rssi}>{typeof device.rssi === 'number' ? `${device.rssi} dBm` : 'RSSI --'}</Text>
                  </View>
                </Pressable>
              );
            })
          ) : (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>还没有发现支持的穿戴设备。让设备保持唤醒并靠近手机，确认蓝牙和定位服务开启后再试。近距离未知设备也会显示在这里。</Text>
            </View>
          )}
        </View>
        {diagnosticsExpanded ? (
          <>
            {scanState.devices.length ? (
              <>
                <Text style={styles.sectionTitle}>扫描细节</Text>
                <View style={styles.logList}>
                  {scanState.devices.map((device) => (
                    <View key={device.id} style={styles.logRow}>
                      <Text style={styles.logMeta}>{device.displayName}</Text>
                      {deviceDebugLines(device).length ? (
                        deviceDebugLines(device).map((line) => (
                          <Text key={line} numberOfLines={2} style={styles.deviceDebug}>{line}</Text>
                        ))
                      ) : (
                        <Text style={styles.connectionId}>暂无广播细节</Text>
                      )}
                    </View>
                  ))}
                </View>
              </>
            ) : null}

            <Text style={styles.sectionTitle}>最近原始通知</Text>
            <View style={styles.logList}>
              {connectionState.notificationLogs.length ? (
                connectionState.notificationLogs.map((log) => (
                  <View key={`${log.receivedAt}-${log.source}`} style={styles.logRow}>
                    <Text style={styles.logMeta}>{log.source} · {log.length} bytes{log.isExpectedLength ? '' : ' · 长度异常'}</Text>
                    <Text style={styles.monoText}>{log.hex}</Text>
                    {log.ascii ? <Text style={styles.connectionId}>text {log.ascii}</Text> : null}
                  </View>
                ))
              ) : (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyText}>连接后如果设备主动发通知，原始 hex 会出现在这里。</Text>
                </View>
              )}
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    paddingTop: 24,
    paddingHorizontal: 18,
    backgroundColor: '#F8FBF5',
  },
  header: {
    height: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 18,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DDEDD4',
  },
  backText: {
    color: colors.ink,
    fontSize: 32,
    lineHeight: 34,
  },
  title: {
    color: colors.ink,
    fontSize: 27,
    fontWeight: '600',
  },
  headerSpacer: {
    width: 44,
    height: 44,
  },
  content: {
    paddingBottom: 32,
  },
  panel: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E0EAD8',
    padding: 16,
    marginBottom: 18,
  },
  statusRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  connectionHeaderText: {
    flex: 1,
    minWidth: 0,
  },
  panelTitle: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '600',
  },
  statusText: {
    color: '#6F7B69',
    fontSize: 13,
    marginTop: 4,
  },
  errorBox: {
    marginTop: 14,
    borderRadius: 8,
    backgroundColor: '#FFF3EE',
    borderWidth: 1,
    borderColor: '#F6C9B7',
    padding: 12,
  },
  errorTitle: {
    color: '#8B3F2E',
    fontSize: 14,
    fontWeight: '600',
  },
  errorText: {
    color: '#8B3F2E',
    fontSize: 12,
    marginTop: 4,
  },
  scanButton: {
    height: 48,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#7A9F79',
    marginTop: 16,
  },
  stopButton: {
    backgroundColor: '#B9786A',
  },
  buttonPressed: {
    opacity: 0.82,
  },
  scanButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  disconnectButton: {
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#B9786A',
    marginTop: 14,
  },
  disconnectButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  sectionTitle: {
    color: '#71798A',
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 7,
    marginBottom: 9,
  },
  deviceList: {
    gap: 10,
    marginBottom: 18,
  },
  deviceRow: {
    minHeight: 78,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E0EAD8',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  devicePressed: {
    backgroundColor: '#F1F7EC',
  },
  disabledRow: {
    opacity: 0.58,
  },
  deviceMain: {
    flex: 1,
    minWidth: 0,
  },
  deviceName: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '600',
  },
  deviceId: {
    color: '#7C8677',
    fontSize: 12,
    marginTop: 5,
  },
  deviceDebug: {
    color: '#87917F',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 3,
  },
  deviceMeta: {
    minWidth: 72,
    alignItems: 'flex-end',
  },
  confidence: {
    color: '#5E865B',
    fontSize: 12,
    fontWeight: '600',
  },
  rssi: {
    color: '#7C8677',
    fontSize: 12,
    marginTop: 5,
  },
  emptyBox: {
    minHeight: 92,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#CFDEC7',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
  },
  emptyText: {
    color: '#697663',
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  connectionBlock: {
    marginTop: 14,
    borderTopWidth: 1,
    borderTopColor: '#EDF2E9',
    paddingTop: 12,
  },
  connectionLabel: {
    color: '#71798A',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 5,
  },
  connectionValue: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  connectionId: {
    color: '#7C8677',
    fontSize: 12,
    lineHeight: 18,
  },
  metricGrid: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
    marginBottom: 8,
  },
  metricItem: {
    flex: 1,
    minHeight: 58,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E0EAD8',
    backgroundColor: '#F8FBF5',
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  metricLabel: {
    color: '#6F7B69',
    fontSize: 12,
    fontWeight: '600',
  },
  metricValue: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '600',
    marginTop: 3,
  },
  metricItemLarge: {
    flex: 1,
    minHeight: 82,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E0EAD8',
    backgroundColor: '#F8FBF5',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  batterySummary: {
    alignItems: 'center',
    backgroundColor: '#F8FBF5',
    borderColor: '#E0EAD8',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 66,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  metricHint: {
    color: '#7C8677',
    fontSize: 11,
    lineHeight: 15,
    marginTop: 4,
  },
  heartValueRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 5,
    marginTop: 2,
  },
  heartValue: {
    color: colors.ink,
    fontSize: 30,
    fontWeight: '600',
    letterSpacing: 0,
  },
  heartUnit: {
    color: '#6F7B69',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 5,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  actionRowWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 12,
  },
  primaryActionButton: {
    flexGrow: 1,
    minHeight: 44,
    minWidth: 142,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#7A9F79',
    paddingHorizontal: 14,
  },
  primaryActionButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  secondaryOutlineButton: {
    flexGrow: 1,
    minHeight: 44,
    minWidth: 142,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#B9CDAF',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
  },
  secondaryOutlineButtonText: {
    color: '#5E865B',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  secondaryButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#7A9F79',
    paddingHorizontal: 8,
  },
  secondaryButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  probeButton: {
    minHeight: 42,
    borderRadius: 8,
    backgroundColor: '#A7B889',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    marginTop: 10,
  },
  probeButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },

  readButton: {
    minHeight: 42,
    borderRadius: 8,
    backgroundColor: '#8EA779',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    marginTop: 10,
  },
  disabledButton: {
    opacity: 0.52,
  },
  authPanel: {
    backgroundColor: '#F8FBF5',
    borderColor: '#DCE8D6',
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    marginTop: 14,
    padding: 12,
  },
  authKeyInput: {
    backgroundColor: '#FFFFFF',
    borderColor: '#C9D8C2',
    borderRadius: 8,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 14,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  authError: {
    color: '#8B3F2E',
    fontSize: 12,
    lineHeight: 18,
  },
  runtimePanel: {
    borderTopColor: '#EDF2E9',
    borderTopWidth: 1,
    gap: 10,
    marginTop: 14,
    paddingTop: 12,
  },
  runtimeHeaderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  autoSettingRow: {
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: '#F8FBF5',
    borderWidth: 1,
    borderColor: '#E0EAD8',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  autoSettingText: {
    flex: 1,
    minWidth: 0,
  },
  autoSettingTitle: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '600',
  },
  autoSettingHint: {
    color: '#7C8677',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 3,
  },
  runtimeStatusBox: {
    borderRadius: 8,
    backgroundColor: '#FBF8F1',
    borderWidth: 1,
    borderColor: '#E9DFCC',
    padding: 10,
  },
  diagnosticToggle: {
    alignItems: 'center',
    borderTopColor: '#EDF2E9',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginTop: 14,
    minHeight: 56,
    paddingTop: 12,
  },
  expandText: {
    color: '#5E865B',
    fontSize: 13,
    fontWeight: '600',
  },
  monoText: {
    color: '#394054',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 17,
  },
  logList: {
    gap: 10,
  },
  logRow: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E0EAD8',
    padding: 12,
  },
  logMeta: {
    color: '#5E865B',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 5,
  },
});
