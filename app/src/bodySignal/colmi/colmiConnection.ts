import AsyncStorage from '@react-native-async-storage/async-storage';
import { Buffer } from 'buffer';
import type { BleError, Characteristic, Device, Subscription } from 'react-native-ble-plx';

import {
  getBackupRestoreRuntimeState,
  runBackupRestoreExclusive,
} from '../../backup/backupRestoreCoordinator';
import type { StoredBodySignalReading } from '../bodySignalTypes';
import { probeBodySignalCapabilities } from '../device/bodySignalCapabilityProbe';
import { registerPersistedBodySignalDevice } from '../device/bodySignalDeviceRepository';
import { findMatchingBodySignalDeviceProfile } from '../device/bodySignalDeviceRegistry';
import type {
  BodySignalConnectionSource,
  BodySignalDeviceProfile,
  BodySignalProviderContext,
} from '../device/bodySignalDeviceTypes';
import {
  detectBodySignalBleCapabilities,
  EMPTY_BODY_SIGNAL_BLE_CAPABILITIES,
  type BodySignalBleCapabilities,
} from './bodySignalBleCapabilities';
import {
  BLUETOOTH_BODY_SENSOR_LOCATION_CHARACTERISTIC_UUID,
  BLUETOOTH_HEART_RATE_CONTROL_POINT_CHARACTERISTIC_UUID,
  BLUETOOTH_GAP_DEVICE_NAME_CHARACTERISTIC_UUID,
  BLUETOOTH_GAP_SERVICE_UUID,
  BLUETOOTH_HEART_RATE_MEASUREMENT_CHARACTERISTIC_UUID,
  BLUETOOTH_HEART_RATE_SERVICE_UUID,
  COLMI_CONNECTION_TIMEOUT_MS,
  COLMI_FEE7_INFO_CHARACTERISTIC_UUID,
  COLMI_FEE7_SERVICE_UUID,
  COLMI_LAST_DEVICE_STORAGE_KEY,
  COLMI_MAX_NOTIFICATION_LOGS,
  COLMI_REQUEST_MTU,
  normalizeColmiUuid,
} from './colmiBleConstants';
import { getColmiBleManager } from './colmiBleManager';
import { receiveMiBand6Activity } from './miBand6ActivityTransfer';
import type { MiBand6ActivityCandidate } from '../miBand6ActivityTypes';
import { createMiBand6CurrentTime, MI_BAND_6_CURRENT_TIME_UUID, supportsMiBand6TimeCalibration } from './miBand6TimeProtocol';
import { MI_BAND_6_BATTERY_SERVICE_UUID, MI_BAND_6_BATTERY_CHARACTERISTIC_UUID,
  MI_BAND_6_BATTERY_READ_TIMEOUT_MS, parseMiBand6Battery, type MiBand6BatteryCandidate } from './miBand6BatteryProtocol';
import {
  assertColmiSafeWrite,
  type ColmiSafeWritePurpose,
} from './colmiCommandSafety';
import {
  resolveColmiCharacteristics,
  type ColmiCharacteristicChannel,
  type ColmiDiscoveredService,
} from './colmiCharacteristicResolver';
import { bytesToHex } from './colmiPacket';
import {
  COLMI_COMMAND_BATTERY,
  createColmiBatteryPacket,
  createColmiPhoneNamePacket,
  createColmiSetLocalTimePacket,
  isColmiPacketForCommand,
  parseColmiBatteryPacket,
  type ColmiBatteryInfo,
} from './colmiSafeCommands';
import {
  parseSmartHealthR99HeartRate,
  SMART_HEALTH_R99_HEART_RATE_PRELUDE_PACKETS,
  SMART_HEALTH_R99_NOTIFY_CHARACTERISTIC_UUID,
  SMART_HEALTH_R99_PRELUDE_DELAY_MS,
  SMART_HEALTH_R99_RECENT_READING_GRACE_MS,
  SMART_HEALTH_R99_SERVICE_UUID,
  SMART_HEALTH_R99_START_DELAY_MS,
  SMART_HEALTH_R99_START_HEART_RATE_PACKET,
  SMART_HEALTH_R99_WRITE_CHARACTERISTIC_UUID,
  type SmartHealthR99HeartRateInfo,
} from './smartHealthR99Protocol';
import {
  parseSmartHealthR99Battery,
  SMART_HEALTH_R99_BATTERY_PREFLIGHT_DELAY_MS,
  SMART_HEALTH_R99_BATTERY_PREFLIGHT_PACKET,
  SMART_HEALTH_R99_BATTERY_REQUEST_PACKET,
  SMART_HEALTH_R99_BATTERY_RESPONSE_WAIT_MS,
  type SmartHealthR99BatteryInfo,
} from './smartHealthR99BatteryProtocol';
import {
  parseStandardGattHeartRateMeasurement,
  shouldPersistStandardGattHeartRate,
  type StandardGattHeartRatePersistenceState,
} from './standardGattHeartRateProtocol';
import {
  authenticateMiBand6,
  type Huami2021AuthenticatedSession,
  type MiBand6AuthStage,
} from './miBand6AuthSession';
import {
  acknowledgeMiBand6RealtimeSampleTick,
  finishMiBand6RealtimeNative,
  isMiBand6RealtimeNativeAvailable,
  startMiBand6RealtimeNative,
  subscribeMiBand6RealtimeNative,
  type MiBand6RealtimeNativeStopReason,
} from './miBand6RealtimeHeartRateNative';
import {
  assertMiBand6HeartRateControlCommand,
  chooseMiBand6RealtimeSampleAction,
  MI_BAND_6_HEART_RATE_START_MANUAL,
  MI_BAND_6_HEART_RATE_START_CONTINUOUS,
  MI_BAND_6_HEART_RATE_STOP_CONTINUOUS,
  MI_BAND_6_HEART_RATE_STOP_MANUAL,
  MI_BAND_6_REALTIME_HEART_RATE_DURATION_MS,
  isMiBand6RealtimeHeartRateStartInProgress,
  miBand6RealtimeHeartRateEndsAt,
  type MiBand6HeartRateControlPurpose,
} from './miBand6RealtimeHeartRateProtocol';
import { getMiBand6AuthKey } from './miBand6AuthStore';
import { stopColmiScan, type ColmiScanDevice } from './colmiScanner';
import { saveBodySignalReading } from '../bodySignalStore';

export type ColmiConnectionStatus =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'discovering'
  | 'error'
  | 'subscribing';

export type ColmiInitializationStatus =
  | 'idle'
  | 'initialized'
  | 'init_error'
  | 'initializing'
  | 'reading_battery'
  | 'setting_time';

export type SmartHealthR99MeasurementStatus = 'error' | 'idle' | 'received' | 'starting' | 'waiting';
export type MiBand6RealtimeHeartRateStatus =
  | 'completed'
  | 'error'
  | 'idle'
  | 'running'
  | 'starting'
  | 'stopping';
export type MiBand6RealtimeHeartRateStopReason =
  | 'disconnect'
  | 'manual'
  | 'task_removed'
  | 'timeout'
  | 'write_failed';
export type MiBand6RealtimeHeartRateSession = {
  endsAt?: number;
  errorMessage?: string;
  lastContinueAt?: number;
  startedAt?: number;
  status: MiBand6RealtimeHeartRateStatus;
  stopReason?: MiBand6RealtimeHeartRateStopReason;
};
export type SmartHealthR99BatteryStatus = 'error' | 'idle' | 'received' | 'starting' | 'waiting';
export type Huami2021AuthStatus =
  | 'authenticated'
  | 'error'
  | 'idle'
  | 'missing_key'
  | 'starting'
  | 'waiting_challenge'
  | 'waiting_confirmation';

export type ColmiNotificationLog = {
  ascii?: string;
  hex: string;
  isExpectedLength: boolean;
  length: number;
  receivedAt: number;
  source: 'candidate' | 'primary' | 'read' | 'standard' | 'tx' | 'v2';
};

export type ColmiConnectedDevice = {
  displayName: string;
  id: string;
};

export type ColmiStandardHeartRateInfo = {
  bpm: number;
  rawHex: string;
  receivedAt: number;
};

export type ColmiStandardGattInfo = {
  bodySensorLocation?: string;
  bodySensorLocationCode?: number;
  deviceName?: string;
  readAt: number;
};

export type ColmiConnectionState = {
  batteryInfo?: ColmiBatteryInfo;
  capabilities: BodySignalBleCapabilities;
  candidateChannels: ColmiCharacteristicChannel[];
  connectedDevice?: ColmiConnectedDevice;
  errorMessage?: string;
  standardGattInfoErrorMessage?: string;
  standardGattInfo?: ColmiStandardGattInfo;
  standardHeartRateErrorMessage?: string;
  standardHeartRateInfo?: ColmiStandardHeartRateInfo;
  hasHuami2021AuthKey: boolean;
  huami2021AuthErrorMessage?: string;
  huami2021AuthStatus: Huami2021AuthStatus;
  miBand6RealtimeHeartRateSession: MiBand6RealtimeHeartRateSession;
  smartHealthR99BatteryErrorMessage?: string;
  smartHealthR99BatteryInfo?: SmartHealthR99BatteryInfo;
  smartHealthR99BatteryStartedAt?: number;
  smartHealthR99BatteryStatus?: SmartHealthR99BatteryStatus;
  smartHealthR99HeartRateInfo?: SmartHealthR99HeartRateInfo;
  smartHealthR99MeasurementErrorMessage?: string;
  smartHealthR99MeasurementLastReceivedAt?: number;
  smartHealthR99MeasurementStartedAt?: number;
  smartHealthR99MeasurementStatus?: SmartHealthR99MeasurementStatus;
  initializationErrorMessage?: string;
  initializationMessage: string;
  initializationStatus: ColmiInitializationStatus;
  isConnected: boolean;
  lastCommandLabel?: string;
  lastRxHex?: string;
  lastRxLength?: number;
  lastRxSource?: ColmiNotificationLog['source'];
  lastRxText?: string;
  lastTxHex?: string;
  lastCommandWriteAt?: number;
  manualDisconnectAt?: number;
  lastTimeSyncAt?: number;
  lastUpdatedAt?: number;
  notificationLogs: ColmiNotificationLog[];
  primaryChannel?: ColmiCharacteristicChannel;
  probeChannelIndex: number;
  characteristicSummaries: string[];
  serviceUUIDs: string[];
  status: ColmiConnectionStatus;
  statusMessage: string;
  v2Channel?: ColmiCharacteristicChannel;
};

type ColmiConnectionListener = (state: ColmiConnectionState) => void;

const COLMI_BATTERY_RESPONSE_WAIT_MS = 1200;
const COLMI_WRITE_TIMEOUT_MS = 1800;
const STANDARD_HEART_RATE_RETRY_DELAY_MS = 450;
const BLE_OPERATION_CANCELLED_ERROR_CODE = 2;
const RETRYABLE_STANDARD_HEART_RATE_ERROR_CODES = new Set([4, 403, 404, 405]);
const STANDARD_HEART_RATE_DIAGNOSTIC_LOG_INTERVAL_MS = 15 * 1000;

const listeners = new Set<ColmiConnectionListener>();
let connectedDevice: Device | null = null;
let miBand6TimeSyncPromise: Promise<number> | null = null;
let miBand6BatteryReadPromise: Promise<MiBand6BatteryCandidate> | null = null;
let miBand6BatteryTimedOutDevice: Device | null = null;
let miBand6BatteryWireBusy = false;
let miBand6ActivityTransfer: ReturnType<typeof receiveMiBand6Activity> | undefined;
let miBand6SleepTransfer: ReturnType<typeof receiveMiBand6Activity> | undefined;
let miBand6ActivityBlockedDevice: Device | undefined;
let disconnectSubscription: Subscription | null = null;
let primaryNotifySubscription: Subscription | null = null;
let probeNotifySubscription: Subscription | null = null;
let smartHealthR99NotifySubscription: Subscription | null = null;
let smartHealthR99WriteIndicationSubscription: Subscription | null = null;
let standardHeartRateSubscription: Subscription | null = null;
let standardHeartRateSubscriptionDeviceId: string | null = null;
let standardHeartRateSubscriptionGeneration = 0;
let huami2021AuthGeneration = 0;
let huami2021AuthPromise: Promise<boolean> | null = null;
let huami2021AuthenticatedDeviceId: string | null = null;
let huami2021AuthenticatedSession: Huami2021AuthenticatedSession | null = null;
let miBand6RealtimeNativeUnsubscribe: (() => void) | null = null;
let miBand6RealtimeStartPromise: Promise<void> | null = null;
let miBand6RealtimeStopPromise: Promise<void> | null = null;
let miBand6RealtimeSamplePromise: Promise<void> | null = null;
let miBand6HeartRateControlPoint: Characteristic | null = null;
let miBand6ManualMeasurementStartedAt: number | undefined;
let miBand6ManualMeasurementReceivedAt: number | undefined;
let miBand6ContinuousFallbackActive = false;
let v2NotifySubscription: Subscription | null = null;
let intentionalDisconnect = false;
let manualDisconnectAt: number | undefined;
let standardHeartRatePersistenceState: StandardGattHeartRatePersistenceState | undefined;
let diagnosticsObserverCount = 0;
let lastStandardHeartRateDiagnosticLogAt = 0;
let currentProviderContext: BodySignalProviderContext | undefined;
let connectQueue: Promise<void> = Promise.resolve();

let connectionState: ColmiConnectionState = {
  candidateChannels: [],
  capabilities: { ...EMPTY_BODY_SIGNAL_BLE_CAPABILITIES },
  hasHuami2021AuthKey: false,
  huami2021AuthStatus: 'idle',
  miBand6RealtimeHeartRateSession: { status: 'idle' },
  characteristicSummaries: [],
  initializationMessage: '等待连接',
  initializationStatus: 'idle',
  isConnected: false,
  notificationLogs: [],
  probeChannelIndex: 0,
  serviceUUIDs: [],
  status: 'disconnected',
  statusMessage: '未连接',
};

function cloneState(): ColmiConnectionState {
  return {
    ...connectionState,
    batteryInfo: connectionState.batteryInfo ? { ...connectionState.batteryInfo } : undefined,
    candidateChannels: connectionState.candidateChannels.map((item) => ({ ...item })),
    capabilities: { ...connectionState.capabilities },
    connectedDevice: connectionState.connectedDevice ? { ...connectionState.connectedDevice } : undefined,
    characteristicSummaries: [...connectionState.characteristicSummaries],
    miBand6RealtimeHeartRateSession: { ...connectionState.miBand6RealtimeHeartRateSession },
    notificationLogs: connectionState.notificationLogs.map((item) => ({ ...item })),
    primaryChannel: connectionState.primaryChannel ? { ...connectionState.primaryChannel } : undefined,
    serviceUUIDs: [...connectionState.serviceUUIDs],
    standardGattInfo: connectionState.standardGattInfo ? { ...connectionState.standardGattInfo } : undefined,
    standardHeartRateInfo: connectionState.standardHeartRateInfo ? { ...connectionState.standardHeartRateInfo } : undefined,
    smartHealthR99BatteryInfo: connectionState.smartHealthR99BatteryInfo
      ? { ...connectionState.smartHealthR99BatteryInfo }
      : undefined,
    smartHealthR99HeartRateInfo: connectionState.smartHealthR99HeartRateInfo
      ? { ...connectionState.smartHealthR99HeartRateInfo }
      : undefined,
    v2Channel: connectionState.v2Channel ? { ...connectionState.v2Channel } : undefined,
  };
}

function emitState(next: Partial<ColmiConnectionState>) {
  connectionState = { ...connectionState, ...next, lastUpdatedAt: Date.now() };
  if (!listeners.size) return;
  const snapshot = cloneState();
  listeners.forEach((listener) => listener(snapshot));
}

function base64ToBytes(value: string): number[] {
  return Array.from(Buffer.from(value, 'base64'));
}

function bytesToBase64(bytes: readonly number[]): string {
  return Buffer.from(bytes).toString('base64');
}

function bytesToDebugText(bytes: readonly number[]): string | undefined {
  if (!bytes.length) return undefined;
  const text = bytes
    .map((byte) => {
      if (byte >= 32 && byte <= 126) return String.fromCharCode(byte);
      return `\\x${byte.toString(16).padStart(2, '0')}`;
    })
    .join('');
  return text.trim() ? text : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bleErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('errorCode' in error)) return undefined;
  const value = (error as { errorCode?: unknown }).errorCode;
  return typeof value === 'number' ? value : undefined;
}

function describeStandardHeartRateError(error: BleError): string {
  const code = bleErrorCode(error);
  const detail = error.reason?.trim() || error.message?.trim();
  const codeText = typeof code === 'number' ? `BLE ${code}` : 'BLE 未知代码';
  if (detail && detail.toLowerCase() !== 'characteristic') {
    return `标准心率监听失败（${codeText}）：${detail}`;
  }
  return `标准心率监听失败（${codeText}）。`;
}

function shouldRetryStandardHeartRateError(error: BleError): boolean {
  const code = bleErrorCode(error);
  return typeof code === 'number' && RETRYABLE_STANDARD_HEART_RATE_ERROR_CODES.has(code);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label}超时`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function batteryInfoFromNotification(bytes: readonly number[], receivedAt: number): ColmiBatteryInfo | undefined {
  if (!isColmiPacketForCommand(bytes, COLMI_COMMAND_BATTERY)) return undefined;
  try {
    return parseColmiBatteryPacket(bytes, receivedAt);
  } catch {
    return undefined;
  }
}

function hasColmiDiagnosticsObserver(): boolean {
  return diagnosticsObserverCount > 0;
}

function buildRxDiagnosticPatch(
  source: ColmiRxSource,
  bytes: readonly number[],
  receivedAt: number,
): Partial<ColmiConnectionState> {
  const hex = bytesToHex(bytes);
  const ascii = bytesToDebugText(bytes);
  const nextLog: ColmiNotificationLog = {
    ...(ascii ? { ascii } : {}),
    hex,
    isExpectedLength: bytes.length === 16,
    length: bytes.length,
    receivedAt,
    source,
  };
  return {
    lastRxHex: hex,
    lastRxLength: bytes.length,
    lastRxSource: source,
    lastRxText: ascii,
    notificationLogs: [nextLog, ...connectionState.notificationLogs].slice(0, COLMI_MAX_NOTIFICATION_LOGS),
  };
}

function pushTxLog(bytes: readonly number[]) {
  if (!hasColmiDiagnosticsObserver()) return;
  const hex = bytesToHex(bytes);
  const ascii = bytesToDebugText(bytes);
  const nextLog: ColmiNotificationLog = {
    ...(ascii ? { ascii } : {}),
    hex,
    isExpectedLength: bytes.length === 16,
    length: bytes.length,
    receivedAt: Date.now(),
    source: 'tx',
  };
  emitState({
    lastTxHex: hex,
    notificationLogs: [nextLog, ...connectionState.notificationLogs].slice(0, COLMI_MAX_NOTIFICATION_LOGS),
  });
}

type ColmiRxSource = Exclude<ColmiNotificationLog['source'], 'tx'>;

function saveBodySignalReadingSafely(reading: StoredBodySignalReading) {
  return runBackupRestoreExclusive(async () => {
    if (getBackupRestoreRuntimeState().status !== 'ready') return;
    await saveBodySignalReading(reading);
  });
}

function pushRxLog(source: ColmiRxSource, bytes: readonly number[]) {
  const receivedAt = Date.now();
  const batteryInfo = batteryInfoFromNotification(bytes, receivedAt);
  const smartHealthR99BatteryInfo = parseSmartHealthR99Battery(bytes, receivedAt);
  const smartHealthR99HeartRate = parseSmartHealthR99HeartRate(bytes);
  const hasSemanticReading = Boolean(batteryInfo || smartHealthR99BatteryInfo || typeof smartHealthR99HeartRate === 'number');
  const includeDiagnostics = hasColmiDiagnosticsObserver();
  if (!hasSemanticReading && !includeDiagnostics) return;

  if (smartHealthR99BatteryInfo) {
    void saveBodySignalReadingSafely({
      confidence: 'high',
      kind: 'battery',
      measuredAt: smartHealthR99BatteryInfo.receivedAt,
      sourceDeviceName: connectionState.connectedDevice?.displayName,
      sourceProvider: 'smarthealth_r99',
      unit: '%',
      value: smartHealthR99BatteryInfo.batteryLevel,
    }).catch(() => undefined);
  }
  if (typeof smartHealthR99HeartRate === 'number') {
    void saveBodySignalReadingSafely({
      confidence: 'high',
      kind: 'heart_rate',
      measuredAt: receivedAt,
      sourceDeviceName: connectionState.connectedDevice?.displayName,
      sourceProvider: 'smarthealth_r99',
      unit: 'bpm',
      value: smartHealthR99HeartRate,
    }).catch(() => undefined);
  }
  const semanticHex = typeof smartHealthR99HeartRate === 'number' ? bytesToHex(bytes) : undefined;
  emitState({
    ...(batteryInfo ? { batteryInfo } : {}),
    ...(smartHealthR99BatteryInfo
      ? {
          initializationMessage: `收到 SmartHealth R99 电量 ${smartHealthR99BatteryInfo.batteryLevel}%`,
          initializationStatus: 'idle' as const,
          smartHealthR99BatteryErrorMessage: undefined,
          smartHealthR99BatteryInfo,
          smartHealthR99BatteryStatus: 'received' as const,
        }
      : {}),
    ...(typeof smartHealthR99HeartRate === 'number'
      ? {
          initializationMessage: `收到 SmartHealth R99 心率 ${smartHealthR99HeartRate} bpm`,
          smartHealthR99HeartRateInfo: {
            bpm: smartHealthR99HeartRate,
            rawHex: semanticHex!,
            receivedAt,
          },
          smartHealthR99MeasurementErrorMessage: undefined,
          smartHealthR99MeasurementLastReceivedAt: receivedAt,
          smartHealthR99MeasurementStatus: 'received',
        }
      : {}),
    ...(includeDiagnostics ? buildRxDiagnosticPatch(source, bytes, receivedAt) : {}),
  });
}

function pushNotificationLog(source: ColmiRxSource, characteristic: Characteristic | null) {
  if (!characteristic?.value) return;
  pushRxLog(source, base64ToBytes(characteristic.value));
}

function bodySensorLocationText(code: number): string {
  if (code === 0) return '其他';
  if (code === 1) return '胸部';
  if (code === 2) return '手腕';
  if (code === 3) return '手指';
  if (code === 4) return '手部';
  if (code === 5) return '耳垂';
  if (code === 6) return '脚部';
  return `未知位置 ${code}`;
}

function characteristicTextValue(characteristic: Characteristic): string | undefined {
  if (!characteristic.value) return undefined;
  const text = Buffer.from(characteristic.value, 'base64').toString('utf8').trim();
  return text || undefined;
}

function characteristicBytesValue(characteristic: Characteristic): number[] {
  return characteristic.value ? base64ToBytes(characteristic.value) : [];
}

function characteristicCapabilityText(characteristic: ColmiDiscoveredService['characteristics'][number]): string {
  const capabilities = [
    characteristic.isWritableWithResponse ? 'write' : '',
    characteristic.isWritableWithoutResponse ? 'writeNoRsp' : '',
    characteristic.isNotifiable ? 'notify' : '',
    characteristic.isIndicatable ? 'indicate' : '',
  ].filter(Boolean);
  return capabilities.length ? capabilities.join('/') : 'read-or-unknown';
}

function summarizeCharacteristics(services: ColmiDiscoveredService[]): string[] {
  return services.flatMap((service) =>
    service.characteristics.map(
      (characteristic) =>
        `${service.uuid} / ${characteristic.uuid} · ${characteristicCapabilityText(characteristic)}`,
    ),
  );
}
async function discoveredServicesForDevice(device: Device): Promise<ColmiDiscoveredService[]> {
  const services = await device.services();
  return Promise.all(
    services.map(async (service) => {
      const characteristics = await device.characteristicsForService(service.uuid);
      return {
        characteristics: characteristics.map((characteristic) => ({
          isIndicatable: characteristic.isIndicatable,
          isNotifiable: characteristic.isNotifiable,
          isReadable: characteristic.isReadable,
          isWritableWithResponse: characteristic.isWritableWithResponse,
          isWritableWithoutResponse: characteristic.isWritableWithoutResponse,
          serviceUUID: characteristic.serviceUUID,
          uuid: characteristic.uuid,
        })),
        uuid: service.uuid,
      };
    }),
  );
}

function removeStandardHeartRateSubscription() {
  standardHeartRateSubscriptionGeneration += 1;
  const subscription = standardHeartRateSubscription;
  standardHeartRateSubscription = null;
  lastStandardHeartRateDiagnosticLogAt = 0;
  standardHeartRateSubscriptionDeviceId = null;
  subscription?.remove();
}

function removeSubscriptions() {
  primaryNotifySubscription?.remove();
  primaryNotifySubscription = null;
  probeNotifySubscription?.remove();
  probeNotifySubscription = null;
  smartHealthR99NotifySubscription?.remove();
  smartHealthR99NotifySubscription = null;
  smartHealthR99WriteIndicationSubscription?.remove();
  smartHealthR99WriteIndicationSubscription = null;
  removeStandardHeartRateSubscription();
  v2NotifySubscription?.remove();
  v2NotifySubscription = null;
  disconnectSubscription?.remove();
  disconnectSubscription = null;
}

function clearConnectionReferences() {
  const activity = miBand6ActivityTransfer;
  miBand6ActivityTransfer = undefined;
  miBand6ActivityBlockedDevice = undefined;
  void activity?.cancel().catch(() => undefined);
  miBand6BatteryReadPromise = null;
  miBand6BatteryTimedOutDevice = null;
  miBand6BatteryWireBusy = false;
  removeSubscriptions();
  huami2021AuthGeneration += 1;
  huami2021AuthPromise = null;
  huami2021AuthenticatedDeviceId = null;
  huami2021AuthenticatedSession?.dispose('穿戴设备连接已结束。');
  huami2021AuthenticatedSession = null;
  miBand6RealtimeNativeUnsubscribe?.();
  miBand6RealtimeNativeUnsubscribe = null;
  miBand6RealtimeStartPromise = null;
  miBand6RealtimeStopPromise = null;
  miBand6RealtimeSamplePromise = null;
  miBand6HeartRateControlPoint = null;
  resetMiBand6RealtimeSampleTracking();
  void finishMiBand6RealtimeNative('disconnect').catch(() => undefined);
  connectedDevice = null;
  standardHeartRatePersistenceState = undefined;
  currentProviderContext = undefined;
}

async function saveLastDevice(device: ColmiConnectedDevice) {
  await AsyncStorage.setItem(
    COLMI_LAST_DEVICE_STORAGE_KEY,
    JSON.stringify({ connectedAt: Date.now(), displayName: device.displayName, id: device.id }),
  ).catch(() => undefined);
}

function subscribeNotify(device: Device, channel: ColmiCharacteristicChannel, source: 'candidate' | 'primary' | 'v2'): Subscription {
  return device.monitorCharacteristicForService(
    channel.serviceUUID,
    channel.notifyCharacteristicUUID,
    (error, characteristic) => {
      if (error) {
        emitState({ errorMessage: error.message || '通知订阅出现错误。' });
        return;
      }
      pushNotificationLog(source, characteristic);
    },
  );
}

export function subscribeColmiConnection(listener: ColmiConnectionListener): () => void {
  listeners.add(listener);
  listener(cloneState());
  return () => {
    listeners.delete(listener);
  };
}

export function retainColmiDiagnostics(): () => void {
  diagnosticsObserverCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    diagnosticsObserverCount = Math.max(0, diagnosticsObserverCount - 1);
  };
}

export function getColmiConnectionSnapshot(): ColmiConnectionState {
  return cloneState();
}
export function getColmiProviderContext(): BodySignalProviderContext | undefined {
  return currentProviderContext
    ? {
        capabilities: { ...currentProviderContext.capabilities },
        profile: { ...currentProviderContext.profile },
      }
    : undefined;
}


export async function disconnectColmiDevice(options: { suppressAutoReconnect?: boolean } = {}): Promise<void> {
  intentionalDisconnect = true;
  const suppressAutoReconnect = options.suppressAutoReconnect !== false;
  manualDisconnectAt = suppressAutoReconnect ? Date.now() : manualDisconnectAt;
  const deviceId = connectedDevice?.id;
  clearConnectionReferences();
  if (deviceId) {
    await getColmiBleManager()?.cancelDeviceConnection(deviceId).catch(() => undefined);
  }
  emitState({
    batteryInfo: undefined,
    candidateChannels: [],
    capabilities: { ...EMPTY_BODY_SIGNAL_BLE_CAPABILITIES },
    connectedDevice: undefined,
    hasHuami2021AuthKey: false,
    huami2021AuthErrorMessage: undefined,
    huami2021AuthStatus: 'idle',
    miBand6RealtimeHeartRateSession: { status: 'idle' },
    errorMessage: undefined,
    initializationErrorMessage: undefined,
    initializationMessage: '等待连接',
    initializationStatus: 'idle',
    isConnected: false,
    lastCommandLabel: undefined,
    lastCommandWriteAt: undefined,
    lastRxHex: undefined,
    lastRxLength: undefined,
    lastRxSource: undefined,
    lastRxText: undefined,
    lastTxHex: undefined,
    standardGattInfoErrorMessage: undefined,
    standardGattInfo: undefined,
    standardHeartRateErrorMessage: undefined,
    standardHeartRateInfo: undefined,
    smartHealthR99BatteryErrorMessage: undefined,
    smartHealthR99BatteryInfo: undefined,
    smartHealthR99BatteryStartedAt: undefined,
    smartHealthR99BatteryStatus: 'idle',
    smartHealthR99HeartRateInfo: undefined,
    smartHealthR99MeasurementErrorMessage: undefined,
    smartHealthR99MeasurementLastReceivedAt: undefined,
    smartHealthR99MeasurementStartedAt: undefined,
    smartHealthR99MeasurementStatus: 'idle',
    lastTimeSyncAt: undefined,
    manualDisconnectAt,
    primaryChannel: undefined,
    probeChannelIndex: 0,
    characteristicSummaries: [],
    serviceUUIDs: [],
    status: 'disconnected',
    statusMessage: '已断开',
    v2Channel: undefined,
  });
}

type ColmiWriteModeOverride = 'withResponse' | 'withoutResponse';

async function writeColmiPacket(
  purpose: ColmiSafeWritePurpose,
  packet: readonly number[],
  label = 'COLMI 指令',
  modeOverride?: ColmiWriteModeOverride,
  channelOverride?: ColmiCharacteristicChannel,
): Promise<void> {
  assertColmiSafeWrite(purpose, packet);
  if (miBand6ActivityTransfer) throw new Error('activity_busy');
  const channel = channelOverride ?? connectionState.primaryChannel;
  if (!connectedDevice || !channel || !connectionState.isConnected) {
    throw new Error('戒指还没有连接，不能发送指令。');
  }

  const writeMode = modeOverride ?? channel.writeMode;
  const payload = bytesToBase64(packet);
  const writePromise = writeMode === 'withoutResponse'
    ? connectedDevice.writeCharacteristicWithoutResponseForService(
        channel.serviceUUID,
        channel.writeCharacteristicUUID,
        payload,
      )
    : connectedDevice.writeCharacteristicWithResponseForService(
        channel.serviceUUID,
        channel.writeCharacteristicUUID,
        payload,
      );

  emitState({
    lastCommandLabel: `${label} · ${writeMode}`,
    lastCommandWriteAt: Date.now(),
  });
  pushTxLog(packet);
  await withTimeout(writePromise, COLMI_WRITE_TIMEOUT_MS, `${label} ${writeMode} 写入`);
}

function alternateWriteMode(mode: ColmiWriteModeOverride): ColmiWriteModeOverride {
  return mode === 'withoutResponse' ? 'withResponse' : 'withoutResponse';
}

export async function syncColmiLocalTime(): Promise<void> {
  emitState({
    initializationErrorMessage: undefined,
    initializationMessage: '正在校准戒指时间',
    initializationStatus: 'setting_time',
  });
  try {
    await writeColmiPacket('set_time', createColmiSetLocalTimePacket(), '设置本地时间 0x01');
    emitState({
      initializationMessage: '已校准戒指时间',
      lastTimeSyncAt: Date.now(),
    });
  } catch (error) {
    emitState({
      initializationErrorMessage: error instanceof Error ? error.message : '校准时间失败。',
      initializationMessage: '校准时间失败',
      initializationStatus: 'init_error',
    });
    throw error;
  }
}

export function syncMiBand6LocalTime(): Promise<number> {
  if (miBand6ActivityTransfer) return Promise.reject(new Error('time_sync_busy'));
  if (miBand6BatteryReadPromise || miBand6BatteryWireBusy) return Promise.reject(new Error('time_sync_busy'));
  if (miBand6TimeSyncPromise) return miBand6TimeSyncPromise;
  const device = connectedDevice;
  const authGeneration = huami2021AuthGeneration;
  const assertReady = () => {
    if (!device || connectedDevice !== device || authGeneration !== huami2021AuthGeneration
      || !connectionState.isConnected || huami2021AuthenticatedDeviceId !== device.id
      || connectionState.huami2021AuthStatus !== 'authenticated') throw new Error('time_sync_not_ready');
    if (!supportsMiBand6TimeCalibration(connectionState.capabilities)) throw new Error('time_sync_unsupported');
    if (['starting', 'running', 'stopping'].includes(connectionState.miBand6RealtimeHeartRateSession.status)) {
      throw new Error('time_sync_measuring');
    }
  };
  const run = async () => {
    assertReady();
    if (!device) throw new Error('time_sync_not_ready');
    const transactionId = `mi-band-6-time-${Date.now()}`;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const work = async () => {
      const services = await device.services();
      for (const service of services) {
        assertReady();
        if (expired) throw new Error('time_sync_timeout');
        const characteristics = await device.characteristicsForService(service.uuid);
        const clock = characteristics.find((item) => normalizeColmiUuid(item.uuid) === MI_BAND_6_CURRENT_TIME_UUID);
        if (!clock) continue;
        assertReady();
        if (expired) throw new Error('time_sync_timeout');
        if (!clock.isWritableWithResponse) throw new Error('time_sync_unsupported');
        await device.writeCharacteristicWithResponseForService(
          service.uuid, clock.uuid, bytesToBase64(createMiBand6CurrentTime()), transactionId,
        );
        assertReady();
        if (expired) throw new Error('time_sync_timeout');
        const writtenAt = Date.now();
        emitState({ lastTimeSyncAt: writtenAt });
        return writtenAt;
      }
      throw new Error('time_sync_unsupported');
    };
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            expired = true;
            void getColmiBleManager()?.cancelTransaction(transactionId).catch(() => undefined);
            reject(new Error('time_sync_timeout'));
          }, 10_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  const pending = run().finally(() => {
    if (miBand6TimeSyncPromise === pending) miBand6TimeSyncPromise = null;
  });
  miBand6TimeSyncPromise = pending;
  return pending;
}

export function readConnectedMiBand6Battery(savedProfile?: BodySignalDeviceProfile): Promise<MiBand6BatteryCandidate> {
  if (miBand6ActivityTransfer) return Promise.reject(new Error('battery_busy'));
  if (miBand6BatteryReadPromise) return miBand6BatteryReadPromise;
  const device = connectedDevice;
  const profile = currentProviderContext?.profile ?? (savedProfile && device
    ? findMatchingBodySignalDeviceProfile([savedProfile], { id: device.id, displayName: '' }) : undefined);
  const generation = huami2021AuthGeneration;
  let expired = false;
  const assertReady = () => {
    if (!profile) throw new Error('battery_profile_missing');
    if (!device || profile.family !== 'mi_band_6'
      || !connectionState.capabilities.supportsHuami2021Auth
      || connectionState.capabilities.heartRateTransport !== 'standard_gatt') throw new Error('battery_unsupported');
    if (connectedDevice !== device || (currentProviderContext && currentProviderContext.profile.id !== profile.id)
      || generation !== huami2021AuthGeneration) throw new Error('battery_disconnected');
    if (!connectionState.isConnected || connectionState.huami2021AuthStatus !== 'authenticated'
      || huami2021AuthenticatedDeviceId !== device.id) throw new Error('battery_not_ready');
    if (miBand6BatteryTimedOutDevice === device) throw new Error('battery_connection_blocked');
    if (miBand6TimeSyncPromise || huami2021AuthPromise || miBand6RealtimeStartPromise
      || miBand6RealtimeStopPromise || ['starting', 'running', 'stopping'].includes(
        connectionState.miBand6RealtimeHeartRateSession.status)
      || ['initializing', 'reading_battery', 'setting_time'].includes(connectionState.initializationStatus)) throw new Error('battery_busy');
    if (expired) throw new Error('battery_timeout');
  };
  const run = async () => {
    assertReady();
    if (!device || !profile) throw new Error('battery_not_ready');
    const transactionId = `mi-band-6-battery-${Date.now()}`;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const work = async () => {
      miBand6BatteryWireBusy = true;
      try {
        const characteristics = await device.characteristicsForService(MI_BAND_6_BATTERY_SERVICE_UUID);
        assertReady();
        const characteristic = characteristics.find(item => normalizeColmiUuid(item.uuid) === MI_BAND_6_BATTERY_CHARACTERISTIC_UUID);
        if (!characteristic) throw new Error('battery_characteristic_missing');
        if (!characteristic.isReadable) throw new Error('battery_not_readable');
        const result = await device.readCharacteristicForService(
          MI_BAND_6_BATTERY_SERVICE_UUID, MI_BAND_6_BATTERY_CHARACTERISTIC_UUID, transactionId,
        );
        assertReady();
        const bytes = result.value ? base64ToBytes(result.value) : [];
        const parsed = parseMiBand6Battery(bytes);
        if (!parsed) throw new Error('battery_invalid_packet');
        return { ...parsed, deviceProfileId: profile.id, measuredAt: Date.now(),
          confidence: 'low' as const, diagnosticPrefix: bytes.slice(0, 3) };
      } finally {
        if (connectedDevice === device && huami2021AuthGeneration === generation) miBand6BatteryWireBusy = false;
      }
    };
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            expired = true;
            if (connectedDevice === device && huami2021AuthGeneration === generation) miBand6BatteryTimedOutDevice = device;
            void getColmiBleManager()?.cancelTransaction(transactionId).catch(() => undefined);
            reject(new Error('battery_timeout'));
          }, MI_BAND_6_BATTERY_READ_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  const pending = run().finally(() => {
    if (miBand6BatteryReadPromise === pending) miBand6BatteryReadPromise = null;
  });
  miBand6BatteryReadPromise = pending;
  return pending;
}

export function readConnectedMiBand6Activity(profile: BodySignalDeviceProfile, since: number,
  observePacket?: Parameters<typeof receiveMiBand6Activity>[0]['observePacket']): Promise<MiBand6ActivityCandidate> {
  if (miBand6ActivityTransfer) {
    if (observePacket || miBand6SleepTransfer === miBand6ActivityTransfer) throw new Error('activity_busy');
    return miBand6ActivityTransfer.promise;
  }
  const device = connectedDevice;
  const generation = huami2021AuthGeneration;
  const assertCurrent = () => {
    if (!device || !connectionState.isConnected || connectedDevice !== device || generation !== huami2021AuthGeneration
      || huami2021AuthenticatedDeviceId !== device.id || connectionState.huami2021AuthStatus !== 'authenticated') {
      throw new Error('activity_not_ready');
    }
    if (profile.family !== 'mi_band_6' || !connectionState.capabilities.supportsHuami2021Auth
      || connectionState.capabilities.heartRateTransport !== 'standard_gatt'
      || !findMatchingBodySignalDeviceProfile([profile], { id: device.id, displayName: '' })) {
      throw new Error('activity_unsupported');
    }
  };
  assertCurrent();
  if (!device) throw new Error('activity_not_ready');
  if (miBand6ActivityBlockedDevice === device) throw new Error('activity_connection_blocked');
  if (miBand6TimeSyncPromise || miBand6BatteryReadPromise || miBand6BatteryWireBusy || huami2021AuthPromise
    || miBand6RealtimeStartPromise || miBand6RealtimeStopPromise
    || ['starting', 'running', 'stopping'].includes(connectionState.miBand6RealtimeHeartRateSession.status)) {
    throw new Error('activity_busy');
  }
  const transfer = receiveMiBand6Activity({ device, since, assertCurrent, observePacket,
    cancelTransaction: async id => { await getColmiBleManager()?.cancelTransaction(id); },
    blockConnection: () => { if (connectedDevice === device) miBand6ActivityBlockedDevice = device; },
    releaseConnection: async () => { if (connectedDevice === device) await disconnectColmiDevice(); },
  });
  miBand6ActivityTransfer = transfer;
  if (observePacket) miBand6SleepTransfer = transfer;
  void transfer.promise.finally(() => {
    if (miBand6ActivityTransfer === transfer) miBand6ActivityTransfer = undefined;
    if (miBand6SleepTransfer === transfer) miBand6SleepTransfer = undefined;
  }).catch(() => undefined);
  return transfer.promise;
}

export async function cancelConnectedMiBand6SleepInspection(): Promise<void> {
  const transfer = miBand6SleepTransfer;
  if (transfer && transfer === miBand6ActivityTransfer) await transfer.cancel();
}

export async function requestColmiBattery(): Promise<void> {
  emitState({
    initializationErrorMessage: undefined,
    initializationMessage: '正在读取戒指电量',
    initializationStatus: 'reading_battery',
  });

  const packet = createColmiBatteryPacket();
  const firstMode = connectionState.primaryChannel?.writeMode ?? 'withoutResponse';
  const previousBatteryAt = connectionState.batteryInfo?.receivedAt;
  const errors: string[] = [];

  try {
    await writeColmiPacket('battery', packet, '读取电量 0x03', firstMode);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : '首选写入失败');
  }

  await delay(COLMI_BATTERY_RESPONSE_WAIT_MS);

  if (connectionState.batteryInfo?.receivedAt === previousBatteryAt) {
    try {
      await writeColmiPacket('battery', packet, '读取电量备用 0x03', alternateWriteMode(firstMode));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : '备用写入失败');
    }
    await delay(COLMI_BATTERY_RESPONSE_WAIT_MS);
  }

  if (connectionState.batteryInfo?.receivedAt !== previousBatteryAt) {
    emitState({
      initializationErrorMessage: undefined,
      initializationMessage: '已读取戒指电量',
      initializationStatus: 'initialized',
    });
    return;
  }

  emitState({
    initializationErrorMessage: errors.length ? errors.join('；') : undefined,
    initializationMessage: '已发送电量请求，未收到回包',
    initializationStatus: errors.length ? 'init_error' : 'initialized',
  });
}

function sameChannel(left?: ColmiCharacteristicChannel, right?: ColmiCharacteristicChannel): boolean {
  return Boolean(
    left
      && right
      && left.serviceUUID === right.serviceUUID
      && left.writeCharacteristicUUID === right.writeCharacteristicUUID
      && left.notifyCharacteristicUUID === right.notifyCharacteristicUUID,
  );
}

function currentProbeChannel(): ColmiCharacteristicChannel | undefined {
  return connectionState.candidateChannels[connectionState.probeChannelIndex] ?? connectionState.primaryChannel;
}

function probeChannelLabel(channel?: ColmiCharacteristicChannel): string {
  if (!channel) return '无可测试通道';
  return `${channel.role} / ${channel.writeMode}`;
}

function ensureProbeNotifySubscription(channel?: ColmiCharacteristicChannel) {
  probeNotifySubscription?.remove();
  probeNotifySubscription = null;
  if (!connectedDevice || !channel) return;
  if (sameChannel(channel, connectionState.primaryChannel) || sameChannel(channel, connectionState.v2Channel)) return;
  probeNotifySubscription = subscribeNotify(connectedDevice, channel, 'candidate');
}

function ensureSmartHealthR99NotificationSubscriptions(channel?: ColmiCharacteristicChannel) {
  if (!connectedDevice || !channel) return;

  if (
    !smartHealthR99NotifySubscription
    && !sameChannel(channel, connectionState.primaryChannel)
    && !sameChannel(channel, connectionState.v2Channel)
  ) {
    smartHealthR99NotifySubscription = subscribeNotify(connectedDevice, channel, 'candidate');
  }

  if (
    !smartHealthR99WriteIndicationSubscription
    && channel.writeCharacteristicUUID !== channel.notifyCharacteristicUUID
  ) {
    smartHealthR99WriteIndicationSubscription = connectedDevice.monitorCharacteristicForService(
      channel.serviceUUID,
      channel.writeCharacteristicUUID,
      (error, characteristic) => {
        if (error) {
          emitState({
            smartHealthR99BatteryErrorMessage: error.message || 'R99 写入特征 indication 订阅出现错误。',
          });
          return;
        }
        pushNotificationLog('candidate', characteristic);
      },
    );
  }
}

export function getColmiProbeChannelLabel(): string {
  return probeChannelLabel(currentProbeChannel());
}

export function selectNextColmiProbeChannel(): void {
  if (!connectionState.candidateChannels.length) return;
  const nextIndex = (connectionState.probeChannelIndex + 1) % connectionState.candidateChannels.length;
  const channel = connectionState.candidateChannels[nextIndex];
  emitState({
    initializationMessage: `已切换测试通道：${probeChannelLabel(channel)}`,
    initializationStatus: 'idle',
    probeChannelIndex: nextIndex,
  });
}
function canAutoInitializeChannel(channel?: ColmiCharacteristicChannel): boolean {
  return Boolean(channel && channel.role !== 'ae00' && channel.role !== 'be94' && channel.role !== 'fallback');
}

function safeCommandUnavailableMessage(channel?: ColmiCharacteristicChannel): string {
  if (channel?.role === 'ae00') return 'ae00 通道待探测，已暂停自动初始化';
  if (channel?.role === 'be94') return 'be94 通道会导致断开，已暂停自动初始化';
  if (channel?.role === 'fallback') return '未知通道待验证，已暂停自动初始化';
  return '等待连接';
}
export async function probeColmiCurrentChannel(): Promise<void> {
  if (!connectedDevice || !connectionState.isConnected) {
    throw new Error('戒指还没有连接，不能探测通道。');
  }

  const channel = currentProbeChannel();
  if (!channel) throw new Error('没有可测试的通信通道。');
  if (channel.role === 'be94') {
    const message = 'be94 是 R99 私有协议通道，已禁止向它发送标准 COLMI 0x03。';
    emitState({
      initializationErrorMessage: undefined,
      initializationMessage: message,
      initializationStatus: 'idle',
    });
    throw new Error(message);
  }
  ensureSmartHealthR99NotificationSubscriptions(channel);
  const previousBatteryAt = connectionState.batteryInfo?.receivedAt;
  emitState({
    initializationErrorMessage: undefined,
    initializationMessage: `正在探测 ${channel.role} 通道，只发送一包 0x03`,
    initializationStatus: 'reading_battery',
  });

  try {
    await writeColmiPacket(
      'channel_probe_battery',
      createColmiBatteryPacket(),
      `通道探测 ${channel.role} 0x03`,
      channel.writeMode,
      channel,
    );
  } catch (error) {
    emitState({
      initializationErrorMessage: error instanceof Error ? error.message : '通道探测写入失败。',
      initializationMessage: '通道探测写入失败',
      initializationStatus: 'init_error',
    });
    throw error;
  }

  await delay(COLMI_BATTERY_RESPONSE_WAIT_MS);
  if (!connectionState.isConnected) return;

  const gotBattery = connectionState.batteryInfo?.receivedAt !== previousBatteryAt;
  emitState({
    initializationErrorMessage: undefined,
    initializationMessage: gotBattery ? '通道探测收到电量回包' : '通道探测已发送，未收到电量回包',
    initializationStatus: gotBattery ? 'initialized' : 'idle',
  });
}
export async function readColmiFee7Info(): Promise<void> {
  if (miBand6ActivityTransfer) throw new Error('activity_busy');
  if (!connectedDevice || !connectionState.isConnected) {
    throw new Error('戒指还没有连接，不能读取 FEE7。');
  }

  emitState({
    initializationErrorMessage: undefined,
    initializationMessage: '正在读取 FEE7 只读特征',
    initializationStatus: 'reading_battery',
    lastCommandLabel: '读取 FEE7 fec9',
    lastCommandWriteAt: Date.now(),
  });

  try {
    const characteristic = await withTimeout(
      connectedDevice.readCharacteristicForService(COLMI_FEE7_SERVICE_UUID, COLMI_FEE7_INFO_CHARACTERISTIC_UUID),
      COLMI_WRITE_TIMEOUT_MS,
      '读取 FEE7 fec9',
    );
    if (characteristic.value) {
      pushRxLog('read', base64ToBytes(characteristic.value));
      emitState({
        initializationErrorMessage: undefined,
        initializationMessage: '已读取 FEE7 只读特征',
        initializationStatus: 'idle',
      });
    } else {
      emitState({
        initializationErrorMessage: undefined,
        initializationMessage: 'FEE7 只读特征没有返回 value',
        initializationStatus: 'idle',
      });
    }
  } catch (error) {
    emitState({
      initializationErrorMessage: error instanceof Error ? error.message : '读取 FEE7 失败。',
      initializationMessage: '读取 FEE7 失败',
      initializationStatus: 'init_error',
    });
    throw error;
  }
}
export async function readColmiStandardGattInfo(): Promise<void> {
  if (miBand6ActivityTransfer) throw new Error('活动记录正在同步，请稍后再读标准信息。');
  if (miBand6BatteryReadPromise || miBand6BatteryWireBusy) throw new Error('电量正在读取，请稍后再读标准信息。');
  if (!connectedDevice || !connectionState.isConnected) {
    throw new Error('戒指还没有连接，不能读取标准信息。');
  }

  const nextInfo: ColmiStandardGattInfo = { readAt: Date.now() };
  const errors: string[] = [];

  emitState({
    initializationErrorMessage: undefined,
    initializationMessage: '正在读取标准 GATT 信息',
    initializationStatus: 'reading_battery',
    lastCommandLabel: '读取标准 GATT 信息',
    lastCommandWriteAt: Date.now(),
    standardGattInfoErrorMessage: undefined,
  });

  try {
    const deviceName = await withTimeout(
      connectedDevice.readCharacteristicForService(
        BLUETOOTH_GAP_SERVICE_UUID,
        BLUETOOTH_GAP_DEVICE_NAME_CHARACTERISTIC_UUID,
      ),
      COLMI_WRITE_TIMEOUT_MS,
      '读取设备名 2a00',
    );
    nextInfo.deviceName = characteristicTextValue(deviceName);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : '读取设备名失败');
  }

  try {
    const bodyLocation = await withTimeout(
      connectedDevice.readCharacteristicForService(
        BLUETOOTH_HEART_RATE_SERVICE_UUID,
        BLUETOOTH_BODY_SENSOR_LOCATION_CHARACTERISTIC_UUID,
      ),
      COLMI_WRITE_TIMEOUT_MS,
      '读取传感器位置 2a38',
    );
    const bytes = characteristicBytesValue(bodyLocation);
    if (bytes.length) {
      nextInfo.bodySensorLocationCode = bytes[0];
      nextInfo.bodySensorLocation = bodySensorLocationText(bytes[0]);
      pushRxLog('read', bytes);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : '读取传感器位置失败');
  }

  emitState({
    initializationMessage: errors.length ? '标准信息部分读取失败' : '已读取标准 GATT 信息',
    initializationStatus: 'idle',
    standardGattInfoErrorMessage: errors.length ? errors.join('；') : undefined,
    standardGattInfo: nextInfo,
  });
}

async function findStandardHeartRateMeasurementCharacteristic(device: Device): Promise<Characteristic> {
  const findMeasurement = async () => {
    const characteristics = await device.characteristicsForService(BLUETOOTH_HEART_RATE_SERVICE_UUID);
    return characteristics.find((characteristic) => (
      normalizeColmiUuid(characteristic.uuid)
        === normalizeColmiUuid(BLUETOOTH_HEART_RATE_MEASUREMENT_CHARACTERISTIC_UUID)
      && (characteristic.isNotifiable || characteristic.isIndicatable)
    ));
  };

  let measurement: Characteristic | undefined;
  try {
    measurement = await findMeasurement();
  } catch {
    await device.discoverAllServicesAndCharacteristics();
    measurement = await findMeasurement();
  }
  if (!measurement) {
    await device.discoverAllServicesAndCharacteristics();
    measurement = await findMeasurement();
  }
  if (!measurement) {
    throw new Error('已发现心率服务，但没有找到可通知的心率测量特征。');
  }
  return measurement;
}

async function findMiBand6HeartRateControlPointCharacteristic(device: Device): Promise<Characteristic> {
  const findControlPoint = async () => {
    const characteristics = await device.characteristicsForService(BLUETOOTH_HEART_RATE_SERVICE_UUID);
    return characteristics.find((characteristic) => (
      normalizeColmiUuid(characteristic.uuid)
        === normalizeColmiUuid(BLUETOOTH_HEART_RATE_CONTROL_POINT_CHARACTERISTIC_UUID)
      && (characteristic.isWritableWithResponse || characteristic.isWritableWithoutResponse)
    ));
  };

  let controlPoint: Characteristic | undefined;
  try {
    controlPoint = await findControlPoint();
  } catch {
    await device.discoverAllServicesAndCharacteristics();
    controlPoint = await findControlPoint();
  }
  if (!controlPoint) {
    await device.discoverAllServicesAndCharacteristics();
    controlPoint = await findControlPoint();
  }
  if (!controlPoint) {
    throw new Error('小米手环没有开放可写的标准心率控制点 2A39。');
  }
  return controlPoint;
}

async function writeMiBand6HeartRateControl(
  purpose: MiBand6HeartRateControlPurpose,
  packet: Uint8Array,
): Promise<void> {
  assertMiBand6HeartRateControlCommand(purpose, packet);
  if (!connectedDevice || !connectionState.isConnected) {
    throw new Error('小米手环还没有连接，不能控制连续心率。');
  }
  const device = connectedDevice;
  const controlPoint = miBand6HeartRateControlPoint
    ?? await findMiBand6HeartRateControlPointCharacteristic(device);
  if (connectedDevice !== device || !connectionState.isConnected) {
    throw new Error('寻找心率控制点时手环连接已经变化。');
  }
  miBand6HeartRateControlPoint = controlPoint;
  const payload = bytesToBase64(Array.from(packet));
  const writePromise = controlPoint.isWritableWithResponse
    ? controlPoint.writeWithResponse(payload)
    : controlPoint.writeWithoutResponse(payload);
  pushTxLog(Array.from(packet));
  await withTimeout(writePromise, COLMI_WRITE_TIMEOUT_MS, `小米手环心率控制 ${purpose}`);
}

async function startColmiStandardHeartRateSubscription(allowRetry: boolean): Promise<void> {
  if (!connectedDevice || !connectionState.isConnected) {
    throw new Error('穿戴设备还没有连接，不能监听标准心率。');
  }
  if (!connectionState.capabilities.supportsStandardHeartRate) {
    throw new Error('当前设备没有开放标准心率通知。');
  }

  const device = connectedDevice;
  if (
    connectionState.capabilities.supportsHuami2021Auth
    && huami2021AuthenticatedDeviceId !== device.id
  ) {
    throw new Error('小米手环需要先完成新认证，才能监听标准心率。');
  }
  if (standardHeartRateSubscription && standardHeartRateSubscriptionDeviceId === device.id) {
    emitState({
      initializationMessage: '标准心率监听中；设备产生新心率后会显示在这里',
      initializationStatus: 'idle',
      standardHeartRateErrorMessage: undefined,
    });
    return;
  }

  removeStandardHeartRateSubscription();
  const generation = standardHeartRateSubscriptionGeneration;
  const measurementCharacteristic = await findStandardHeartRateMeasurementCharacteristic(device);
  if (connectedDevice !== device || !connectionState.isConnected || generation !== standardHeartRateSubscriptionGeneration) {
    return;
  }

  const subscriptionType = measurementCharacteristic.isNotifiable ? 'notification' : 'indication';
  let failedSynchronously = false;
  const subscription = measurementCharacteristic.monitor(
    (error, characteristic) => {
      if (generation !== standardHeartRateSubscriptionGeneration || connectedDevice !== device) return;
      if (error) {
        failedSynchronously = true;
        standardHeartRateSubscription = null;
        standardHeartRateSubscriptionDeviceId = null;
        if (bleErrorCode(error) === BLE_OPERATION_CANCELLED_ERROR_CODE) return;

        const message = describeStandardHeartRateError(error);
        emitState({
          initializationMessage: allowRetry && shouldRetryStandardHeartRateError(error)
            ? '首次心率监听失败，正在重新发现特征后重试'
            : '标准心率监听遇到错误',
          standardHeartRateErrorMessage: message,
        });
        if (allowRetry && shouldRetryStandardHeartRateError(error)) {
          void (async () => {
            await delay(STANDARD_HEART_RATE_RETRY_DELAY_MS);
            if (generation !== standardHeartRateSubscriptionGeneration || connectedDevice !== device) return;
            await device.discoverAllServicesAndCharacteristics();
            if (generation !== standardHeartRateSubscriptionGeneration || connectedDevice !== device) return;
            await startColmiStandardHeartRateSubscription(false);
          })().catch((retryError) => {
            if (generation !== standardHeartRateSubscriptionGeneration || connectedDevice !== device) return;
            emitState({
              initializationMessage: '标准心率重试失败',
              standardHeartRateErrorMessage: retryError instanceof Error
                ? retryError.message
                : '标准心率重试失败。',
            });
          });
        }
        return;
      }
      if (!characteristic?.value) return;
      const bytes = base64ToBytes(characteristic.value);
      const measurement = parseStandardGattHeartRateMeasurement(bytes);
      const receivedAt = Date.now();
      if (!measurement) {
        if (hasColmiDiagnosticsObserver()) {
          emitState(buildRxDiagnosticPatch('standard', bytes, receivedAt));
        }
        return;
      }
      if (measurement) {
        const deviceId = connectionState.connectedDevice?.id;
        if (isMiBand6RealtimeHeartRateStartInProgress(
          connectionState.miBand6RealtimeHeartRateSession.status,
        )) {
          miBand6ManualMeasurementReceivedAt = receivedAt;
        }
        if (deviceId && shouldPersistStandardGattHeartRate({
          deviceId,
          receivedAt,
          state: standardHeartRatePersistenceState,
        })) {
          standardHeartRatePersistenceState = { deviceId, persistedAt: receivedAt };
          void saveBodySignalReadingSafely({
            confidence: 'high',
            kind: 'heart_rate',
            measuredAt: receivedAt,
            sourceDeviceName: connectionState.connectedDevice?.displayName,
            sourceProvider: 'standard_gatt',
            unit: 'bpm',
            value: measurement.bpm,
          }).catch(() => undefined);
        }
        let diagnosticPatch: Partial<ColmiConnectionState> = {};
        if (hasColmiDiagnosticsObserver()
          && receivedAt - lastStandardHeartRateDiagnosticLogAt >= STANDARD_HEART_RATE_DIAGNOSTIC_LOG_INTERVAL_MS) {
          lastStandardHeartRateDiagnosticLogAt = receivedAt;
          diagnosticPatch = buildRxDiagnosticPatch('standard', bytes, receivedAt);
        }
        emitState({
          ...diagnosticPatch,
          initializationMessage: `收到标准心率 ${measurement.bpm} bpm`,
          initializationStatus: 'idle',
          standardHeartRateErrorMessage: undefined,
          standardHeartRateInfo: {
            bpm: measurement.bpm,
            rawHex: bytesToHex(bytes),
            receivedAt,
          },
        });
      }
    },
    `junluo-standard-heart-rate-${generation}`,
    subscriptionType,
  );

  if (failedSynchronously || connectedDevice !== device || generation !== standardHeartRateSubscriptionGeneration) {
    subscription.remove();
    return;
  }

  standardHeartRateSubscription = subscription;
  standardHeartRateSubscriptionDeviceId = device.id;

  emitState({
    initializationErrorMessage: undefined,
    initializationMessage: '标准心率监听中；设备产生新心率后会显示在这里',
    initializationStatus: 'idle',
    standardHeartRateErrorMessage: undefined,
  });
}

export async function subscribeColmiStandardHeartRate(): Promise<void> {
  if (miBand6ActivityTransfer) throw new Error('活动记录正在同步，请稍后再恢复监听。');
  if (miBand6BatteryReadPromise || miBand6BatteryWireBusy) throw new Error('电量正在读取，请稍后再恢复监听。');
  await startColmiStandardHeartRateSubscription(true);
}

function huami2021AuthStageMessage(stage: MiBand6AuthStage): string {
  if (stage === 'starting') return '正在准备小米手环认证';
  if (stage === 'waiting_challenge') return '正在等待手环认证挑战';
  if (stage === 'waiting_confirmation') return '正在等待手环确认密钥';
  return '手环认证成功，正在监听心率';
}

export async function authenticateMiBand6AndSubscribeHeartRate(): Promise<boolean> {
  if (miBand6ActivityTransfer) throw new Error('活动记录正在同步，请稍后再认证。');
  if (miBand6BatteryReadPromise || miBand6BatteryWireBusy) throw new Error('电量正在读取，请稍后再认证。');
  if (!connectedDevice || !connectionState.isConnected) {
    throw new Error('小米手环还没有连接，不能认证。');
  }
  if (!connectionState.capabilities.supportsStandardHeartRate) {
    throw new Error('当前设备没有开放标准心率通知。');
  }
  if (!connectionState.capabilities.supportsHuami2021Auth) {
    await startColmiStandardHeartRateSubscription(true);
    return true;
  }

  const device = connectedDevice;
  if (
    huami2021AuthenticatedDeviceId === device.id
    && huami2021AuthenticatedSession
    && !huami2021AuthenticatedSession.isDisposed()
  ) {
    await startColmiStandardHeartRateSubscription(true);
    return true;
  }
  if (huami2021AuthPromise) return huami2021AuthPromise;

  const generation = huami2021AuthGeneration;
  const run = (async () => {
    try {
      const authKeyHex = await getMiBand6AuthKey(device.id);
      if (
        generation !== huami2021AuthGeneration
        || connectedDevice !== device
        || !connectionState.isConnected
      ) {
        return false;
      }
      emitState({
        hasHuami2021AuthKey: Boolean(authKeyHex),
        huami2021AuthErrorMessage: undefined,
      });
      if (!authKeyHex) {
        emitState({
          huami2021AuthStatus: 'missing_key',
          initializationMessage: '需要先填写这只小米手环的认证密钥',
          standardHeartRateErrorMessage: undefined,
        });
        return false;
      }

      const authenticatedSession = await authenticateMiBand6({
        authKeyHex,
        device,
        onStage: (stage) => {
          if (
            generation !== huami2021AuthGeneration
            || connectedDevice !== device
            || !connectionState.isConnected
          ) return;
          emitState({
            huami2021AuthErrorMessage: undefined,
            huami2021AuthStatus: stage,
            initializationMessage: huami2021AuthStageMessage(stage),
            standardHeartRateErrorMessage: undefined,
          });
        },
      });
      if (
        generation !== huami2021AuthGeneration
        || connectedDevice !== device
        || !connectionState.isConnected
      ) {
        authenticatedSession.dispose('认证完成时设备连接已经变化。');
        return false;
      }
      huami2021AuthenticatedSession?.dispose('新的认证会话已经建立。');
      huami2021AuthenticatedSession = authenticatedSession;
      huami2021AuthenticatedDeviceId = device.id;
      emitState({
        hasHuami2021AuthKey: true,
        huami2021AuthErrorMessage: undefined,
        huami2021AuthStatus: 'authenticated',
        initializationMessage: '小米手环认证成功，正在监听心率',
        standardHeartRateErrorMessage: undefined,
      });
      await startColmiStandardHeartRateSubscription(true);
      return true;
    } catch (error) {
      if (
        generation === huami2021AuthGeneration
        && connectedDevice === device
        && connectionState.isConnected
      ) {
        emitState({
          huami2021AuthErrorMessage: error instanceof Error
            ? error.message
            : '小米手环认证失败。',
          huami2021AuthStatus: 'error',
          initializationMessage: '小米手环认证失败',
          standardHeartRateErrorMessage: undefined,
        });
      }
      return false;
    }
  })();

  huami2021AuthPromise = run;
  try {
    return await run;
  } finally {
    if (huami2021AuthPromise === run) huami2021AuthPromise = null;
  }
}

function resetMiBand6RealtimeSampleTracking(): void {
  miBand6ManualMeasurementStartedAt = undefined;
  miBand6ManualMeasurementReceivedAt = undefined;
  miBand6ContinuousFallbackActive = false;
}

async function triggerMiBand6ManualHeartRateMeasurement(): Promise<void> {
  resetMiBand6RealtimeSampleTracking();
  await writeMiBand6HeartRateControl('stop_continuous', MI_BAND_6_HEART_RATE_STOP_CONTINUOUS);
  await writeMiBand6HeartRateControl('stop_manual', MI_BAND_6_HEART_RATE_STOP_MANUAL);
  await writeMiBand6HeartRateControl('start_manual', MI_BAND_6_HEART_RATE_START_MANUAL);
  miBand6ManualMeasurementStartedAt = Date.now();
}

async function fallbackToMiBand6ContinuousHeartRate(): Promise<void> {
  await writeMiBand6HeartRateControl('stop_manual', MI_BAND_6_HEART_RATE_STOP_MANUAL);
  await writeMiBand6HeartRateControl('start_continuous', MI_BAND_6_HEART_RATE_START_CONTINUOUS);
  miBand6ManualMeasurementStartedAt = undefined;
  miBand6ManualMeasurementReceivedAt = undefined;
  miBand6ContinuousFallbackActive = true;
}

function bindMiBand6RealtimeNativeEvents(): void {
  if (miBand6RealtimeNativeUnsubscribe) return;
  miBand6RealtimeNativeUnsubscribe = subscribeMiBand6RealtimeNative({
    onSampleTick: (tickId) => {
      if (connectionState.miBand6RealtimeHeartRateSession.status !== 'running') return;
      if (miBand6RealtimeSamplePromise) {
        void acknowledgeMiBand6RealtimeSampleTick(tickId).catch(() => undefined);
        return;
      }
      const sample = (async () => {
        const now = Date.now();
        const action = chooseMiBand6RealtimeSampleAction({
          continuousFallbackActive: miBand6ContinuousFallbackActive,
          manualMeasurementReceivedAt: miBand6ManualMeasurementReceivedAt,
          manualMeasurementStartedAt: miBand6ManualMeasurementStartedAt,
          now,
        });
        if (action === 'restart_manual') {
          await triggerMiBand6ManualHeartRateMeasurement();
        } else if (action === 'fallback_continuous') {
          await fallbackToMiBand6ContinuousHeartRate();
        }
        await acknowledgeMiBand6RealtimeSampleTick(tickId);
        emitState({
          miBand6RealtimeHeartRateSession: {
            ...connectionState.miBand6RealtimeHeartRateSession,
            lastContinueAt: now,
          },
        });
      })();
      miBand6RealtimeSamplePromise = sample;
      void sample
        .catch(() => stopMiBand6RealtimeHeartRate('write_failed'))
        .finally(() => {
          if (miBand6RealtimeSamplePromise === sample) miBand6RealtimeSamplePromise = null;
        });
    },
    onStopRequested: (reason) => {
      void stopMiBand6RealtimeHeartRate(reason).catch(() => undefined);
    },
    onStopped: (reason) => {
      miBand6RealtimeNativeUnsubscribe?.();
      miBand6RealtimeNativeUnsubscribe = null;
      resetMiBand6RealtimeSampleTracking();
      const current = connectionState.miBand6RealtimeHeartRateSession;
      if (current.status !== 'running' && current.status !== 'starting') return;
      emitState({
        miBand6RealtimeHeartRateSession: {
          ...current,
          endsAt: undefined,
          errorMessage: reason === 'write_failed' ? '连续心率通信失败。' : undefined,
          status: reason === 'write_failed' ? 'error' : 'completed',
          stopReason: reason,
        },
      });
    },
  });
}

export async function startMiBand6RealtimeHeartRate(): Promise<void> {
  if (miBand6ActivityTransfer) await miBand6ActivityTransfer.cancel();
  if (miBand6BatteryReadPromise || miBand6BatteryWireBusy) throw new Error('电量正在读取，请稍后再开始测量。');
  const currentStatus = connectionState.miBand6RealtimeHeartRateSession.status;
  if (isMiBand6RealtimeHeartRateStartInProgress(currentStatus)) {
    return miBand6RealtimeStartPromise ?? Promise.resolve();
  }
  if (miBand6RealtimeStartPromise) return miBand6RealtimeStartPromise;

  const run = (async () => {
    if (!connectedDevice || !connectionState.isConnected) {
      throw new Error('小米手环还没有连接，不能开始连续心率。');
    }
    if (!connectionState.capabilities.supportsHuami2021Auth) {
      throw new Error('当前设备不支持小米手环 6 连续心率。');
    }
    if (!isMiBand6RealtimeNativeAvailable()) {
      throw new Error('当前安装包缺少连续心率原生模块，请重新覆盖安装 Dev Client。');
    }

    emitState({
      miBand6RealtimeHeartRateSession: {
        startedAt: Date.now(),
        status: 'starting',
      },
    });

    let heartRateStarted = false;
    try {
      const authenticated = await authenticateMiBand6AndSubscribeHeartRate();
      const session = huami2021AuthenticatedSession;
      if (!authenticated || !session || session.isDisposed()) {
        throw new Error('小米手环认证会话没有准备好。');
      }
      await triggerMiBand6ManualHeartRateMeasurement();
      heartRateStarted = true;
      const startedAt = Date.now();
      const endsAt = miBand6RealtimeHeartRateEndsAt(startedAt);
      bindMiBand6RealtimeNativeEvents();
      emitState({
        initializationMessage: '小米手环连续心率运行中',
        miBand6RealtimeHeartRateSession: {
          endsAt,
          startedAt,
          status: 'running',
        },
      });
      await startMiBand6RealtimeNative(MI_BAND_6_REALTIME_HEART_RATE_DURATION_MS);
    } catch (error) {
      if (heartRateStarted && connectionState.isConnected) {
        await writeMiBand6HeartRateControl('stop_continuous', MI_BAND_6_HEART_RATE_STOP_CONTINUOUS)
          .catch(() => undefined);
        await writeMiBand6HeartRateControl('stop_manual', MI_BAND_6_HEART_RATE_STOP_MANUAL)
          .catch(() => undefined);
      }
      await finishMiBand6RealtimeNative('write_failed').catch(() => undefined);
      miBand6RealtimeNativeUnsubscribe?.();
      miBand6RealtimeNativeUnsubscribe = null;
      resetMiBand6RealtimeSampleTracking();
      const message = error instanceof Error ? error.message : '启动连续心率失败。';
      emitState({
        initializationMessage: '连续心率启动失败',
        miBand6RealtimeHeartRateSession: {
          errorMessage: message,
          status: 'error',
          stopReason: 'write_failed',
        },
      });
      throw error;
    }
  })();

  miBand6RealtimeStartPromise = run;
  try {
    await run;
  } finally {
    if (miBand6RealtimeStartPromise === run) miBand6RealtimeStartPromise = null;
  }
}

export async function stopMiBand6RealtimeHeartRate(
  reason: MiBand6RealtimeHeartRateStopReason = 'manual',
): Promise<void> {
  if (miBand6RealtimeStopPromise) return miBand6RealtimeStopPromise;
  const current = connectionState.miBand6RealtimeHeartRateSession;
  if (current.status === 'idle' || current.status === 'completed') {
    await finishMiBand6RealtimeNative(reason).catch(() => undefined);
    return;
  }

  const run = (async () => {
    emitState({
      miBand6RealtimeHeartRateSession: {
        ...connectionState.miBand6RealtimeHeartRateSession,
        status: 'stopping',
        stopReason: reason,
      },
    });
    let stopError: Error | undefined;
    if (connectionState.isConnected) {
      await writeMiBand6HeartRateControl('stop_continuous', MI_BAND_6_HEART_RATE_STOP_CONTINUOUS)
        .catch((error) => {
          stopError = error instanceof Error ? error : new Error('停止连续心率失败。');
        });
      await writeMiBand6HeartRateControl('stop_manual', MI_BAND_6_HEART_RATE_STOP_MANUAL)
        .catch((error) => {
          if (!stopError) {
            stopError = error instanceof Error ? error : new Error('停止连续心率失败。');
          }
        });
    }
    await finishMiBand6RealtimeNative(reason).catch(() => undefined);
    miBand6RealtimeNativeUnsubscribe?.();
    miBand6RealtimeNativeUnsubscribe = null;
    resetMiBand6RealtimeSampleTracking();
    const failed = reason === 'write_failed' || Boolean(stopError);
    emitState({
      initializationMessage: failed ? '连续心率已经安全收尾' : '连续心率已停止',
      miBand6RealtimeHeartRateSession: {
        ...connectionState.miBand6RealtimeHeartRateSession,
        endsAt: undefined,
        errorMessage: stopError?.message
          ?? (reason === 'write_failed' ? '连续心率通信失败，已经停止。' : undefined),
        status: failed ? 'error' : 'completed',
        stopReason: reason,
      },
    });
  })();

  miBand6RealtimeStopPromise = run;
  try {
    await run;
  } finally {
    if (miBand6RealtimeStopPromise === run) miBand6RealtimeStopPromise = null;
  }
}
function hasRecentSmartHealthR99HeartRate(now = Date.now()): boolean {
  return Boolean(
    connectionState.smartHealthR99HeartRateInfo
      && now - connectionState.smartHealthR99HeartRateInfo.receivedAt <= SMART_HEALTH_R99_RECENT_READING_GRACE_MS,
  );
}

function markSmartHealthR99MeasurementCompletedAfterDisconnect(): void {
  emitState({
    errorMessage: undefined,
    initializationErrorMessage: undefined,
    initializationMessage: '已收到心率，忽略随后断开错误',
    initializationStatus: 'idle',
    smartHealthR99MeasurementErrorMessage: undefined,
    smartHealthR99MeasurementStatus: 'received',
    statusMessage: connectionState.isConnected ? connectionState.statusMessage : '测量后已断开',
  });
}

function smartHealthR99Channel(): ColmiCharacteristicChannel | undefined {
  const candidate = connectionState.candidateChannels.find(
    (channel) =>
      channel.serviceUUID.toLowerCase() === SMART_HEALTH_R99_SERVICE_UUID
      && channel.writeCharacteristicUUID.toLowerCase() === SMART_HEALTH_R99_WRITE_CHARACTERISTIC_UUID
      && channel.notifyCharacteristicUUID.toLowerCase() === SMART_HEALTH_R99_NOTIFY_CHARACTERISTIC_UUID,
  );
  if (candidate) return candidate;

  if (!connectionState.serviceUUIDs.includes(SMART_HEALTH_R99_SERVICE_UUID)) return undefined;
  return {
    notifyCharacteristicUUID: SMART_HEALTH_R99_NOTIFY_CHARACTERISTIC_UUID,
    role: 'be94',
    serviceUUID: SMART_HEALTH_R99_SERVICE_UUID,
    source: 'known',
    writeCharacteristicUUID: SMART_HEALTH_R99_WRITE_CHARACTERISTIC_UUID,
    writeMode: 'withResponse',
  };
}

export async function requestSmartHealthR99Battery(): Promise<void> {
  if (!connectedDevice || !connectionState.isConnected) {
    throw new Error('戒指还没有连接，不能读取 R99 电量。');
  }
  if (
    connectionState.smartHealthR99BatteryStatus === 'starting'
    || connectionState.smartHealthR99BatteryStatus === 'waiting'
  ) return;

  const stillConnected = await connectedDevice.isConnected().catch(() => false);
  if (!stillConnected) throw new Error('Android 蓝牙连接已经断开，请重新连接戒指。');

  const channel = smartHealthR99Channel();
  if (!channel) throw new Error('没有找到 SmartHealth R99 的 be94 电量通道。');

  ensureSmartHealthR99NotificationSubscriptions(channel);
  const previousBatteryAt = connectionState.smartHealthR99BatteryInfo?.receivedAt;
  emitState({
    initializationErrorMessage: undefined,
    initializationMessage: '正在手动读取 SmartHealth R99 电量',
    initializationStatus: 'reading_battery',
    smartHealthR99BatteryErrorMessage: undefined,
    smartHealthR99BatteryStartedAt: Date.now(),
    smartHealthR99BatteryStatus: 'starting',
  });

  try {
    await writeColmiPacket(
      'smarthealth_r99_battery',
      SMART_HEALTH_R99_BATTERY_PREFLIGHT_PACKET,
      'SmartHealth R99 查询芯片方案 0x021B',
      'withResponse',
      channel,
    );
    emitState({
      initializationMessage: '已发送 R99 芯片方案查询，准备读取电量',
      smartHealthR99BatteryStatus: 'starting',
    });
    await delay(SMART_HEALTH_R99_BATTERY_PREFLIGHT_DELAY_MS);
    await writeColmiPacket(
      'smarthealth_r99_battery',
      SMART_HEALTH_R99_BATTERY_REQUEST_PACKET,
      'SmartHealth R99 读取电量 0x0200',
      'withResponse',
      channel,
    );
    emitState({
      initializationMessage: '已发送 SmartHealth R99 电量请求，等待回包',
      smartHealthR99BatteryStatus: 'waiting',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SmartHealth R99 电量初始化或请求写入失败。';
    emitState({
      initializationMessage: 'SmartHealth R99 电量请求写入失败',
      initializationStatus: 'idle',
      smartHealthR99BatteryErrorMessage: message,
      smartHealthR99BatteryStatus: 'error',
    });
    throw error;
  }

  await delay(SMART_HEALTH_R99_BATTERY_RESPONSE_WAIT_MS);
  if (connectionState.smartHealthR99BatteryInfo?.receivedAt !== previousBatteryAt) return;

  const message = connectionState.isConnected
    ? '已发送 R99 电量请求，但本轮没有收到合法回包。'
    : '读取 R99 电量时连接已断开。';
  emitState({
    initializationMessage: message,
    initializationStatus: 'idle',
    smartHealthR99BatteryErrorMessage: message,
    smartHealthR99BatteryStatus: 'error',
  });
}

export async function startSmartHealthR99HeartRateExperiment(): Promise<void> {
  if (!connectedDevice || !connectionState.isConnected) {
    const message = '戒指连接已断开，请回设置页重新连接。';
    emitState({
      errorMessage: message,
      initializationMessage: '等待连接',
      initializationStatus: 'idle',
      isConnected: false,
      smartHealthR99MeasurementErrorMessage: message,
      smartHealthR99MeasurementStatus: 'error',
      status: 'disconnected',
      statusMessage: '连接已断开',
    });
    throw new Error(message);
  }

  const stillConnected = await connectedDevice.isConnected().catch(() => false);
  if (!stillConnected) {
    const message = 'Android 蓝牙连接已经断开，请回设置页重新连接。';
    clearConnectionReferences();
    emitState({
      errorMessage: message,
      initializationMessage: '等待连接',
      initializationStatus: 'idle',
      isConnected: false,
      smartHealthR99MeasurementErrorMessage: message,
      smartHealthR99MeasurementStatus: 'error',
      status: 'disconnected',
      statusMessage: '连接已断开',
    });
    throw new Error(message);
  }

  if (hasRecentSmartHealthR99HeartRate()) {
    emitState({
      initializationErrorMessage: undefined,
      initializationMessage: '正在接收 SmartHealth R99 心率，跳过重复开始命令',
      initializationStatus: 'idle',
      smartHealthR99MeasurementErrorMessage: undefined,
      smartHealthR99MeasurementStatus: 'received',
    });
    return;
  }

  const channel = smartHealthR99Channel();
  if (!channel) {
    const message = '没有找到 SmartHealth R99 的 be94 心率通道。';
    emitState({
      initializationErrorMessage: message,
      initializationMessage: 'SmartHealth R99 心率通道不可用',
      initializationStatus: 'init_error',
    });
    throw new Error(message);
  }

  ensureProbeNotifySubscription(channel);
  const startedAt = Date.now();
  emitState({
    initializationErrorMessage: undefined,
    initializationMessage: '正在发送 SmartHealth R99 心率前置命令',
    initializationStatus: 'reading_battery',
    smartHealthR99MeasurementErrorMessage: undefined,
    smartHealthR99MeasurementStartedAt: startedAt,
    smartHealthR99MeasurementStatus: 'starting',
  });

  try {
    for (let index = 0; index < SMART_HEALTH_R99_HEART_RATE_PRELUDE_PACKETS.length; index += 1) {
      await writeColmiPacket(
        'smarthealth_r99_heart_rate',
        SMART_HEALTH_R99_HEART_RATE_PRELUDE_PACKETS[index],
        `SmartHealth R99 心率前置 ${index + 1}`,
        'withResponse',
        channel,
      );
      await delay(SMART_HEALTH_R99_PRELUDE_DELAY_MS);
    }
    await delay(SMART_HEALTH_R99_START_DELAY_MS);
    await writeColmiPacket(
      'smarthealth_r99_heart_rate',
      SMART_HEALTH_R99_START_HEART_RATE_PACKET,
      'SmartHealth R99 开始心率 0x032f',
      'withResponse',
      channel,
    );
    emitState({
      initializationMessage: '已发送 SmartHealth R99 心率命令，等待实时心率回包',
      initializationStatus: 'idle',
      smartHealthR99MeasurementStatus: 'waiting',
      standardHeartRateErrorMessage: undefined,
    });
  } catch (error) {
    if (hasRecentSmartHealthR99HeartRate()) {
      markSmartHealthR99MeasurementCompletedAfterDisconnect();
      return;
    }

    const message = error instanceof Error ? error.message : 'SmartHealth R99 心率命令发送失败。';
    emitState({
      initializationErrorMessage: message,
      initializationMessage: 'SmartHealth R99 心率命令发送失败',
      initializationStatus: 'init_error',
      smartHealthR99MeasurementErrorMessage: message,
      smartHealthR99MeasurementStatus: 'error',
    });
    throw error;
  }
}
async function initializeColmiConnection(): Promise<void> {
  emitState({
    initializationErrorMessage: undefined,
    initializationMessage: '正在安全初始化',
    initializationStatus: 'initializing',
  });

  try {
    await writeColmiPacket('phone_name', createColmiPhoneNamePacket(), '设置手机名 0x04');
    await delay(500);
    await syncColmiLocalTime();
    await delay(500);
    await requestColmiBattery();
    emitState({
      initializationMessage: '已发送安全初始化',
      initializationStatus: 'initialized',
    });
  } catch (error) {
    emitState({
      initializationErrorMessage: error instanceof Error ? error.message : '安全初始化失败。',
      initializationMessage: '安全初始化失败',
      initializationStatus: 'init_error',
    });
  }
}

export type ConnectColmiDeviceOptions = {
  source?: BodySignalConnectionSource;
};

async function connectColmiDeviceOnce(
  scanDevice: ColmiScanDevice,
  options: ConnectColmiDeviceOptions = {},
): Promise<void> {
  const source = options.source ?? 'manual';
  await stopColmiScan();
  await disconnectColmiDevice({ suppressAutoReconnect: false });
  manualDisconnectAt = undefined;

  const manager = getColmiBleManager();
  const selectedDevice = { displayName: scanDevice.displayName, id: scanDevice.id };
  if (!manager) {
    emitState({
      connectedDevice: selectedDevice,
      errorMessage: '当前安装包还没有可用的 BLE 原生模块。',
      isConnected: false,
      status: 'error',
      statusMessage: '连接失败',
    });
    return;
  }

  emitState({
    batteryInfo: undefined,
    candidateChannels: [],
    capabilities: { ...EMPTY_BODY_SIGNAL_BLE_CAPABILITIES },
    connectedDevice: selectedDevice,
    hasHuami2021AuthKey: false,
    huami2021AuthErrorMessage: undefined,
    huami2021AuthStatus: 'idle',
    miBand6RealtimeHeartRateSession: { status: 'idle' },
    errorMessage: undefined,
    initializationErrorMessage: undefined,
    initializationMessage: '等待连接',
    initializationStatus: 'idle',
    isConnected: false,
    lastCommandLabel: undefined,
    lastCommandWriteAt: undefined,
    lastRxHex: undefined,
    lastRxLength: undefined,
    lastRxSource: undefined,
    lastRxText: undefined,
    lastTxHex: undefined,
    standardGattInfoErrorMessage: undefined,
    standardGattInfo: undefined,
    standardHeartRateErrorMessage: undefined,
    standardHeartRateInfo: undefined,
    smartHealthR99BatteryErrorMessage: undefined,
    smartHealthR99BatteryInfo: undefined,
    smartHealthR99BatteryStartedAt: undefined,
    smartHealthR99BatteryStatus: 'idle',
    smartHealthR99HeartRateInfo: undefined,
    smartHealthR99MeasurementErrorMessage: undefined,
    smartHealthR99MeasurementLastReceivedAt: undefined,
    smartHealthR99MeasurementStartedAt: undefined,
    smartHealthR99MeasurementStatus: 'idle',
    lastTimeSyncAt: undefined,
    notificationLogs: [],
    primaryChannel: undefined,
    probeChannelIndex: 0,
    characteristicSummaries: [],
    serviceUUIDs: [],
    status: 'connecting',
    statusMessage: `正在连接 ${scanDevice.displayName}`,
    v2Channel: undefined,
  });

  try {
    connectedDevice = await manager.connectToDevice(scanDevice.id, {
      requestMTU: COLMI_REQUEST_MTU,
      timeout: COLMI_CONNECTION_TIMEOUT_MS,
    });
    intentionalDisconnect = false;
    disconnectSubscription = manager.onDeviceDisconnected(scanDevice.id, (error) => {
      const wasIntentional = intentionalDisconnect;
      const recentR99HeartRate = hasRecentSmartHealthR99HeartRate();
      clearConnectionReferences();
      intentionalDisconnect = false;
      emitState({
        errorMessage: wasIntentional || recentR99HeartRate ? undefined : error?.message,
        initializationErrorMessage: undefined,
        initializationMessage: recentR99HeartRate ? '已收到心率，戒指随后断开' : '等待连接',
        initializationStatus: 'idle',
        isConnected: false,
        hasHuami2021AuthKey: false,
        huami2021AuthErrorMessage: undefined,
        huami2021AuthStatus: 'idle',
        miBand6RealtimeHeartRateSession: { status: 'idle' },
        standardGattInfoErrorMessage: undefined,
        standardHeartRateErrorMessage: undefined,
        smartHealthR99MeasurementErrorMessage: undefined,
        smartHealthR99MeasurementStatus: recentR99HeartRate ? 'received' : 'idle',
        status: 'disconnected',
        statusMessage: wasIntentional ? '已断开' : recentR99HeartRate ? '测量后已断开' : '连接已断开',
      });
    });

    emitState({ status: 'discovering', statusMessage: '正在发现服务' });
    await connectedDevice.discoverAllServicesAndCharacteristics();
    const services = await discoveredServicesForDevice(connectedDevice);
    const resolution = resolveColmiCharacteristics(services);
    const primaryChannel = resolution.ok ? resolution.primary : undefined;
    const capabilities = detectBodySignalBleCapabilities(services, primaryChannel);
    const providerProbe = probeBodySignalCapabilities({ primaryChannel, services });
    if (!resolution.ok && !capabilities.supportsStandardHeartRate) {
      throw new Error(`没有找到可用通信通道：${(resolution as { reason: string }).reason}`);
    }

    emitState({
      candidateChannels: resolution.ok ? resolution.candidates : [],
      capabilities,
      primaryChannel,
      probeChannelIndex: 0,
      characteristicSummaries: summarizeCharacteristics(services),
      serviceUUIDs: resolution.serviceUUIDs,
      status: 'subscribing',
      statusMessage: capabilities.heartRateTransport === 'standard_gatt'
        ? capabilities.supportsHuami2021Auth
          ? '等待小米手环认证'
          : '正在订阅标准心率'
        : '正在订阅通知',
      v2Channel: resolution.ok ? resolution.v2 : undefined,
    });

    if (resolution.ok && !capabilities.supportsHuami2021Auth) {
      primaryNotifySubscription = subscribeNotify(connectedDevice, resolution.primary, 'primary');
      if (resolution.v2) {
        v2NotifySubscription = subscribeNotify(connectedDevice, resolution.v2, 'v2');
      }
      ensureSmartHealthR99NotificationSubscriptions(smartHealthR99Channel());
    }
    const profile = await registerPersistedBodySignalDevice({
      probe: providerProbe,
      source,
      target: {
        authorizedAssociationId: scanDevice.authorizedAssociationId,
        displayName: selectedDevice.displayName,
        id: selectedDevice.id,
        protocolIdentity: scanDevice.protocolIdentity,
      },
    }).catch(() => undefined);
    currentProviderContext = profile
      ? { capabilities: { ...providerProbe.capabilities }, profile }
      : undefined;
    if (source === 'manual') await saveLastDevice(selectedDevice);
    emitState({
      errorMessage: undefined,
      isConnected: true,
      status: 'connected',
      statusMessage: `已连接 ${scanDevice.displayName}`,
    });
    if (capabilities.heartRateTransport === 'standard_gatt') {
      await authenticateMiBand6AndSubscribeHeartRate();
      return;
    }
    await delay(800);
    if (canAutoInitializeChannel(primaryChannel)) {
      await initializeColmiConnection();
    } else {
      emitState({
        initializationErrorMessage: undefined,
        initializationMessage: safeCommandUnavailableMessage(primaryChannel),
        initializationStatus: 'idle',
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '连接失败。';
    const failedDeviceId = connectedDevice?.id ?? scanDevice.id;
    clearConnectionReferences();
    intentionalDisconnect = false;
    await manager.cancelDeviceConnection(failedDeviceId).catch(() => undefined);
    emitState({
      connectedDevice: selectedDevice,
      errorMessage: message,
      initializationErrorMessage: undefined,
      initializationMessage: '等待连接',
      initializationStatus: 'idle',
      isConnected: false,
      status: 'error',
      statusMessage: '连接失败',
    });
  }
}

export function connectColmiDevice(
  scanDevice: ColmiScanDevice,
  options: ConnectColmiDeviceOptions = {},
): Promise<void> {
  const operation = connectQueue.then(() => connectColmiDeviceOnce(scanDevice, options));
  connectQueue = operation.catch(() => undefined);
  return operation;
}

export function destroyColmiConnectionForTests(): void {
  clearConnectionReferences();
  intentionalDisconnect = false;
  manualDisconnectAt = undefined;
  connectQueue = Promise.resolve();
  listeners.clear();
  diagnosticsObserverCount = 0;
  lastStandardHeartRateDiagnosticLogAt = 0;
  connectionState = {
    candidateChannels: [],
    capabilities: { ...EMPTY_BODY_SIGNAL_BLE_CAPABILITIES },
    hasHuami2021AuthKey: false,
    huami2021AuthStatus: 'idle',
    miBand6RealtimeHeartRateSession: { status: 'idle' },
    initializationMessage: '等待连接',
    initializationStatus: 'idle',
    isConnected: false,
    notificationLogs: [],
    probeChannelIndex: 0,
    characteristicSummaries: [],
    serviceUUIDs: [],
    status: 'disconnected',
    statusMessage: '未连接',
  };
}
