import { Buffer } from 'buffer';
import { ScanCallbackType, type Device } from 'react-native-ble-plx';

import { destroyColmiBleManagerForTests, getColmiBleManager } from './colmiBleManager';
import { rankColmiScanCandidate, shouldShowNearbyBleDebugCandidate, type ColmiScanConfidence } from './colmiDeviceFilter';
import { checkColmiScannerPermissions, requestColmiScannerPermissions } from './colmiScannerPermissions';

export type ColmiScanStatus = 'idle' | 'requesting_permission' | 'scanning' | 'error';

export type ColmiScanErrorReason = 'bluetooth_off' | 'permission_denied' | 'native_unavailable' | 'scan_failed';

export type ColmiScanDevice = {
  authorizedAssociationId?: string;
  confidence: ColmiScanConfidence;
  displayName: string;
  id: string;
  lastSeenAt: number;
  localName?: string | null;
  manufacturerDataHex?: string;
  matchedKeyword?: string;
  name?: string | null;
  protocolIdentity?: string;
  rssi?: number | null;
  score: number;
serviceDataHex?: string[];
  serviceUUIDs?: string[];
  txPowerLevel?: number | null;
};

export type ColmiScanState = {
  devices: ColmiScanDevice[];
  errorMessage?: string;
  errorReason?: ColmiScanErrorReason;
  isScanning: boolean;
  lastUpdatedAt?: number;
  missingPermissions: string[];
  status: ColmiScanStatus;
};

type ColmiScanListener = (state: ColmiScanState) => void;

const DEFAULT_SCAN_TIMEOUT_MS = 10_000;

let scanTimeout: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<ColmiScanListener>();
const devicesById = new Map<string, ColmiScanDevice>();

let scanState: ColmiScanState = {
  devices: [],
  isScanning: false,
  missingPermissions: [],
  status: 'idle',
};

function cloneState(): ColmiScanState {
  return { ...scanState, devices: scanState.devices.map((device) => ({ ...device })) };
}

function emitState(next: Partial<ColmiScanState>) {
  scanState = { ...scanState, ...next, lastUpdatedAt: Date.now() };
  const snapshot = cloneState();
  listeners.forEach((listener) => listener(snapshot));
}


type BleAdvertisementExtras = {
  manufacturerData?: string | null;
  serviceData?: Record<string, string | null | undefined> | null;
  serviceUUIDs?: string[] | null;
  txPowerLevel?: number | null;
};

function base64ToHex(value?: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const bytes = Array.from(Buffer.from(value, 'base64'));
    if (!bytes.length) return undefined;
    return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
  } catch {
    return undefined;
  }
}

function serviceDataToHex(value?: Record<string, string | null | undefined> | null): string[] | undefined {
  if (!value) return undefined;
  const rows = Object.entries(value)
    .map(([uuid, payload]) => {
      const hex = base64ToHex(payload);
      return hex ? `${uuid}: ${hex}` : undefined;
    })
    .filter((row): row is string => Boolean(row));
  return rows.length ? rows : undefined;
}
function clearScanTimeout() {
  if (scanTimeout) {
    clearTimeout(scanTimeout);
    scanTimeout = null;
  }
}


function sortDevices(devices: ColmiScanDevice[]): ColmiScanDevice[] {
  return devices.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if ((right.rssi ?? -999) !== (left.rssi ?? -999)) return (right.rssi ?? -999) - (left.rssi ?? -999);
    if (right.lastSeenAt !== left.lastSeenAt) return right.lastSeenAt - left.lastSeenAt;
    return left.displayName.localeCompare(right.displayName);
  });
}

function updateDevice(device: Device) {
  const advertisement = device as Device & BleAdvertisementExtras;
  const candidate = {
    id: device.id,
    localName: device.localName,
    name: device.name,
  };
  const rank = rankColmiScanCandidate(candidate);
  const showNearbyDebug = shouldShowNearbyBleDebugCandidate(candidate, device.rssi);
  if (!rank.isMatch && !showNearbyDebug) return;

  const previous = devicesById.get(device.id);
  const nearbyScore = typeof device.rssi === 'number' ? 10 + Math.max(0, device.rssi + 72) : 10;
  const next: ColmiScanDevice = {
    confidence: rank.isMatch ? rank.confidence : 'nearby',
    displayName: rank.isMatch ? rank.displayName : rank.displayName === 'Unknown COLMI device' ? '附近未知 BLE 设备' : rank.displayName,
    id: device.id,
    lastSeenAt: Date.now(),
    localName: device.localName,
    manufacturerDataHex: base64ToHex(advertisement.manufacturerData),
    matchedKeyword: rank.isMatch ? rank.matchedKeyword : 'nearby-rssi',
    name: device.name,
    rssi: device.rssi,
    score: rank.isMatch ? rank.score : nearbyScore,
    serviceDataHex: serviceDataToHex(advertisement.serviceData),
    serviceUUIDs: advertisement.serviceUUIDs ?? undefined,
    txPowerLevel: advertisement.txPowerLevel,
  };

  devicesById.set(device.id, {
    ...previous,
    ...next,
    displayName: previous?.displayName && next.displayName === 'Unknown COLMI device' ? previous.displayName : next.displayName,
    manufacturerDataHex: next.manufacturerDataHex ?? previous?.manufacturerDataHex,
    serviceDataHex: next.serviceDataHex ?? previous?.serviceDataHex,
    serviceUUIDs: next.serviceUUIDs ?? previous?.serviceUUIDs,
    txPowerLevel: next.txPowerLevel ?? previous?.txPowerLevel,
  });
  emitState({ devices: sortDevices(Array.from(devicesById.values())) });
}

function failScan(reason: ColmiScanErrorReason, message: string, missingPermissions: string[] = []) {
  clearScanTimeout();
  emitState({
    errorMessage: message,
    errorReason: reason,
    isScanning: false,
    missingPermissions,
    status: 'error',
  });
}

export function subscribeColmiScan(listener: ColmiScanListener): () => void {
  listeners.add(listener);
  listener(cloneState());
  return () => {
    listeners.delete(listener);
  };
}

export function getColmiScanSnapshot(): ColmiScanState {
  return cloneState();
}

export async function stopColmiScan(): Promise<void> {
  clearScanTimeout();
  await getColmiBleManager()?.stopDeviceScan().catch(() => undefined);
  emitState({ isScanning: false, status: 'idle' });
}

export async function startColmiScan(options: { requestPermissions?: boolean; timeoutMs?: number } = {}): Promise<void> {
  await stopColmiScan();
  devicesById.clear();
  emitState({
    devices: [],
    errorMessage: undefined,
    errorReason: undefined,
    isScanning: false,
    missingPermissions: [],
    status: 'requesting_permission',
  });

  const permissions = options.requestPermissions === false
    ? await checkColmiScannerPermissions()
    : await requestColmiScannerPermissions();
  if (!permissions.ok) {
    failScan('permission_denied', '没有拿到蓝牙扫描权限。', permissions.missing);
    return;
  }

  const currentManager = getColmiBleManager();
  if (!currentManager) {
    failScan('native_unavailable', '当前安装包还没有可用的 BLE 原生模块。');
    return;
  }

  const bluetoothState = await currentManager.state().catch(() => 'Unknown');
  if (bluetoothState !== 'PoweredOn') {
    failScan('bluetooth_off', '手机蓝牙没有打开，暂时不能扫描穿戴设备。');
    return;
  }

  emitState({ isScanning: true, status: 'scanning' });

  try {
    // Keep discovery bounded if a dev reload destroys JS before its timeout can stop native scanning.
    await currentManager.startDeviceScan(null, {
      allowDuplicates: false,
      callbackType: ScanCallbackType.FirstMatch,
    }, (error, device) => {
      if (error) {
        failScan('scan_failed', error.message || '扫描失败。');
        return;
      }
      if (device) updateDevice(device);
    });
  } catch (error) {
    failScan('scan_failed', error instanceof Error ? error.message : '扫描失败。');
    return;
  }

  scanTimeout = setTimeout(() => {
    void stopColmiScan();
  }, options.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS);
}

export function destroyColmiScannerForTests(): void {
  clearScanTimeout();
  devicesById.clear();
  destroyColmiBleManagerForTests();
  scanState = {
    devices: [],
    isScanning: false,
    missingPermissions: [],
    status: 'idle',
  };
  listeners.clear();
}
