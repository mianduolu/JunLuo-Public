import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  authenticateMiBand6AndSubscribeHeartRate,
  connectColmiDevice,
  getColmiConnectionSnapshot,
  startMiBand6RealtimeHeartRate,
  startSmartHealthR99HeartRateExperiment,
} from './colmi/colmiConnection';
import { COLMI_LAST_DEVICE_STORAGE_KEY } from './colmi/colmiBleConstants';
import {
  getColmiScanSnapshot,
  startColmiScan,
  stopColmiScan,
  subscribeColmiScan,
  type ColmiScanDevice,
} from './colmi/colmiScanner';
import { loadPersistedPrimaryBodySignalDeviceProfile } from './device/bodySignalDeviceRepository';
import {
  DEFAULT_BODY_SIGNAL_RUNTIME_SETTINGS,
  loadBodySignalRuntimeSettings,
  saveBodySignalRuntimeSettings,
  type BodySignalRuntimeSettings,
} from './bodySignalSettingsStore';
import {
  selectBodySignalReconnectCandidate,
  selectBodySignalHeartRateResumeAction,
  shouldAutoReconnectBodySignal,
  type BodySignalRuntimeReason,
  type BodySignalRuntimeSkipReason,
} from './bodySignalRuntimePolicy';
import {
  retryGuardianNow,
  startGuardianFiveMinuteHeartRate,
} from './bodySignalGuardian';
import { guardianOwnsBodySignalConnection } from './bodySignalGuardianPolicy';
import { getBodySignalGuardianRuntimeState } from './bodySignalGuardianRuntime';

export type { BodySignalRuntimeReason, BodySignalRuntimeSettings };

export type BodySignalRuntimeSnapshot = {
  isAutoMeasureAfterReconnectEnabled: boolean;
  isAutoReconnectEnabled: boolean;
  isResuming: boolean;
  lastAttemptAt?: number;
  lastAutoMeasureAt?: number;
  lastConnectedAt?: number;
  lastErrorMessage?: string;
  lastSkipReason?: BodySignalRuntimeSkipReason;
  lastUpdatedAt?: number;
};

type BodySignalRuntimeListener = (snapshot: BodySignalRuntimeSnapshot) => void;

type SavedColmiDevice = {
  authorizedAssociationId?: string;
  connectedAt?: number;
  displayName?: string;
  id?: string;
  protocolIdentity?: string;
};

const BODY_SIGNAL_AUTO_RECONNECT_COOLDOWN_MS = 90 * 1000;
const BODY_SIGNAL_AUTO_MEASURE_COOLDOWN_MS = 60 * 1000;
const BODY_SIGNAL_AUTO_DISCOVERY_TIMEOUT_MS = 10 * 1000;
const BODY_SIGNAL_RECONNECT_RETRY_DELAY_MS = 1600;
const BODY_SIGNAL_POST_CONNECT_SETTLE_MS = 1600;

const listeners = new Set<BodySignalRuntimeListener>();
let settingsPromise: Promise<BodySignalRuntimeSettings> | null = null;
let resumeInFlight = false;

let runtimeState: BodySignalRuntimeSnapshot = {
  isAutoMeasureAfterReconnectEnabled: DEFAULT_BODY_SIGNAL_RUNTIME_SETTINGS.autoMeasureAfterReconnect,
  isAutoReconnectEnabled: DEFAULT_BODY_SIGNAL_RUNTIME_SETTINGS.autoReconnectEnabled,
  isResuming: false,
};

function cloneRuntimeState(): BodySignalRuntimeSnapshot {
  return { ...runtimeState };
}

function emitRuntimeState(next: Partial<BodySignalRuntimeSnapshot>) {
  runtimeState = { ...runtimeState, ...next, lastUpdatedAt: Date.now() };
  const snapshot = cloneRuntimeState();
  listeners.forEach((listener) => listener(snapshot));
}

async function loadSettingsOnce(): Promise<BodySignalRuntimeSettings> {
  if (!settingsPromise) {
    settingsPromise = loadBodySignalRuntimeSettings().then((settings) => {
      emitRuntimeState({
        isAutoMeasureAfterReconnectEnabled: settings.autoMeasureAfterReconnect,
        isAutoReconnectEnabled: settings.autoReconnectEnabled,
      });
      return settings;
    });
  }
  return settingsPromise;
}

async function loadLastColmiDevice(): Promise<SavedColmiDevice | undefined> {
  const primary = await loadPersistedPrimaryBodySignalDeviceProfile().catch(() => undefined);
  if (primary?.lastAdvertisingId) {
    return {
      authorizedAssociationId: primary.authorizedAssociationId,
      connectedAt: primary.lastConnectedAt,
      displayName: primary.displayName,
      id: primary.lastAdvertisingId,
      protocolIdentity: primary.protocolIdentity,
    };
  }

  const raw = await AsyncStorage.getItem(COLMI_LAST_DEVICE_STORAGE_KEY).catch(() => null);
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as SavedColmiDevice;
    return parsed.id ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSavedDeviceReconnectTarget(device: SavedColmiDevice): ColmiScanDevice {
  return {
    confidence: 'model',
    authorizedAssociationId: device.authorizedAssociationId,
    displayName: device.displayName || '上次连接的穿戴设备',
    id: device.id!,
    lastSeenAt: device.connectedAt ?? 0,
    matchedKeyword: 'saved-device',
    score: 0,
    protocolIdentity: device.protocolIdentity,
  };
}

async function discoverLastColmiDevice(device: SavedColmiDevice): Promise<ColmiScanDevice | undefined> {
  let freshScanStarted = false;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: () => void = () => undefined;

  const discovered = new Promise<ColmiScanDevice | undefined>((resolve, reject) => {
    const finish = (candidate?: ColmiScanDevice, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      unsubscribe();
      if (error) reject(error);
      else resolve(candidate);
    };

    unsubscribe = subscribeColmiScan((state) => {
      if (state.status === 'requesting_permission' || state.status === 'scanning') freshScanStarted = true;
      if (!freshScanStarted) return;

      const candidate = selectBodySignalReconnectCandidate(state.devices, {
        authorizedAssociationId: device.authorizedAssociationId,
        lastAdvertisingId: device.id,
        protocolIdentity: device.protocolIdentity,
      });
      if (candidate) {
        finish(candidate);
      } else if (state.status === 'error') {
        finish(undefined, new Error(state.errorMessage || '自动扫描穿戴设备失败。'));
      } else if (state.status === 'idle' && !state.isScanning) {
        finish();
      }
    });

    timeout = setTimeout(() => finish(), BODY_SIGNAL_AUTO_DISCOVERY_TIMEOUT_MS + 500);
  });

  try {
    await startColmiScan({ requestPermissions: false, timeoutMs: BODY_SIGNAL_AUTO_DISCOVERY_TIMEOUT_MS });
    return await discovered;
  } finally {
    await stopColmiScan().catch(() => undefined);
    unsubscribe();
    if (timeout) clearTimeout(timeout);
  }
}

export function subscribeBodySignalRuntime(listener: BodySignalRuntimeListener): () => void {
  listeners.add(listener);
  listener(cloneRuntimeState());
  void loadSettingsOnce().catch(() => undefined);
  return () => {
    listeners.delete(listener);
  };
}

export function getBodySignalRuntimeSnapshot(): BodySignalRuntimeSnapshot {
  void loadSettingsOnce().catch(() => undefined);
  return cloneRuntimeState();
}

export async function updateBodySignalRuntimeSettings(
  patch: Partial<BodySignalRuntimeSettings>,
): Promise<BodySignalRuntimeSettings> {
  const current = await loadSettingsOnce();
  const next = { ...current, ...patch };
  settingsPromise = Promise.resolve(next);
  emitRuntimeState({
    isAutoMeasureAfterReconnectEnabled: next.autoMeasureAfterReconnect,
    isAutoReconnectEnabled: next.autoReconnectEnabled,
    lastErrorMessage: undefined,
  });
  try {
    await saveBodySignalRuntimeSettings(next);
  } catch (error) {
    emitRuntimeState({
      lastErrorMessage: error instanceof Error ? error.message : '保存自动恢复设置失败。',
    });
    throw error;
  }
  return next;
}

export async function resumeConnectedBodySignalHeartRate(): Promise<boolean> {
  const settings = await loadSettingsOnce();
  const now = Date.now();
  const guardian = getBodySignalGuardianRuntimeState();
  if (guardianOwnsBodySignalConnection(guardian)) {
    if (!settings.autoMeasureAfterReconnect || guardian.status !== 'ready') return false;
    if (runtimeState.lastAutoMeasureAt && now - runtimeState.lastAutoMeasureAt < BODY_SIGNAL_AUTO_MEASURE_COOLDOWN_MS) {
      return false;
    }
    await startGuardianFiveMinuteHeartRate();
    emitRuntimeState({ lastAutoMeasureAt: Date.now() });
    return true;
  }
  const connection = getColmiConnectionSnapshot();
  const resumeAction = selectBodySignalHeartRateResumeAction({
    connection,
    lastAutoMeasureAt: runtimeState.lastAutoMeasureAt,
    minMeasureIntervalMs: BODY_SIGNAL_AUTO_MEASURE_COOLDOWN_MS,
    now,
    settings,
  });
  if (resumeAction === 'none') return false;

  await delay(BODY_SIGNAL_POST_CONNECT_SETTLE_MS);
  const settledConnection = getColmiConnectionSnapshot();
  if (!settledConnection.isConnected || settledConnection.status !== 'connected') {
    throw new Error(settledConnection.errorMessage || '穿戴设备连接尚未稳定，暂未恢复心率。');
  }

  if (resumeAction === 'r99_measure') {
    await startSmartHealthR99HeartRateExperiment().catch((error) => {
      const freshState = getColmiConnectionSnapshot();
      if (freshState.smartHealthR99MeasurementStatus !== 'received') throw error;
    });
  } else if (resumeAction === 'mi_band_6_continuous') {
    await startMiBand6RealtimeHeartRate();
  } else {
    const listening = await authenticateMiBand6AndSubscribeHeartRate();
    if (!listening) return false;
  }
  emitRuntimeState({ lastAutoMeasureAt: Date.now() });
  return true;
}

export async function resumeBodySignalRuntime(reason: BodySignalRuntimeReason): Promise<void> {
  const guardian = getBodySignalGuardianRuntimeState();
  if (guardianOwnsBodySignalConnection(guardian)) {
    if (reason === 'manual' || guardian.status === 'suspended' || guardian.status === 'error') {
      await retryGuardianNow().catch((error) => {
        emitRuntimeState({
          lastErrorMessage: error instanceof Error ? error.message : '全天守候恢复失败。',
        });
      });
    }
    emitRuntimeState({ lastSkipReason: 'native_guardian_active' });
    return;
  }
  if (resumeInFlight) {
    emitRuntimeState({ lastSkipReason: 'scan_or_connection_busy' });
    return;
  }

  const now = Date.now();
  const settings = await loadSettingsOnce();
  const lastDevice = await loadLastColmiDevice();
  const connection = getColmiConnectionSnapshot();
  const scan = getColmiScanSnapshot();
  const policy = shouldAutoReconnectBodySignal({
    connection,
    lastAttemptAt: runtimeState.lastAttemptAt,
    lastDeviceId: lastDevice?.id,
    manualDisconnectAt: connection.manualDisconnectAt,
    minReconnectIntervalMs: reason === 'manual' ? 0 : BODY_SIGNAL_AUTO_RECONNECT_COOLDOWN_MS,
    now,
    scan,
    settings,
  });

  if ('reason' in policy) {
    emitRuntimeState({
      lastErrorMessage: undefined,
      lastSkipReason: policy.reason,
    });
    return;
  }

  resumeInFlight = true;
  emitRuntimeState({
    isResuming: true,
    lastAttemptAt: now,
    lastErrorMessage: undefined,
    lastSkipReason: undefined,
  });

  try {
    await connectColmiDevice(createSavedDeviceReconnectTarget(lastDevice!), { source: 'automatic' });
    let afterConnect = getColmiConnectionSnapshot();

    if (!afterConnect.isConnected || afterConnect.status !== 'connected') {
      await delay(BODY_SIGNAL_RECONNECT_RETRY_DELAY_MS);
      const retryDevice = await discoverLastColmiDevice(lastDevice!);
      if (!retryDevice) {
        throw new Error(afterConnect.errorMessage || '自动恢复连接失败，重试时没有发现穿戴设备。');
      }
      await connectColmiDevice(retryDevice, { source: 'automatic' });
      afterConnect = getColmiConnectionSnapshot();
    }

    if (!afterConnect.isConnected || afterConnect.status !== 'connected') {
      throw new Error(afterConnect.errorMessage || '自动恢复没有建立稳定连接。');
    }

    const connectedAt = Date.now();
    emitRuntimeState({ lastConnectedAt: connectedAt });

    await resumeConnectedBodySignalHeartRate();
  } catch (error) {
    emitRuntimeState({
      lastErrorMessage: error instanceof Error ? error.message : '自动恢复身体信号失败。',
    });
  } finally {
    resumeInFlight = false;
    emitRuntimeState({ isResuming: false });
  }
}

export function resetBodySignalRuntimeForTests(): void {
  settingsPromise = null;
  resumeInFlight = false;
  runtimeState = {
    isAutoMeasureAfterReconnectEnabled: DEFAULT_BODY_SIGNAL_RUNTIME_SETTINGS.autoMeasureAfterReconnect,
    isAutoReconnectEnabled: DEFAULT_BODY_SIGNAL_RUNTIME_SETTINGS.autoReconnectEnabled,
    isResuming: false,
  };
  listeners.clear();
}
