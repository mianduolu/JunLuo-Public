import { Dimensions, PermissionsAndroid, Platform } from 'react-native';

import { getInstalledPhoneApps, getPhoneActivityPermissionStatus } from '../../backend/phoneActivityNative';
import { getColmiBleManager } from '../../bodySignal/colmi/colmiBleManager';
import { getColmiScanSnapshot, startColmiScan, stopColmiScan } from '../../bodySignal/colmi/colmiScanner';
import { createToolError } from '../toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolResult } from '../toolTypes';
import { isOneOf, readNumberInput, readOptionalStringInput, validationFailed } from './builtinToolValidation';

type InstalledAppSummary = {
  packageName?: string;
  source?: string;
  title?: string;
  updatedAt?: number;
};

type BleDeviceSummary = {
  displayName: string;
  idPreview: string;
  localName?: string | null;
  name?: string | null;
  rssi?: number | null;
};

const SYSTEM_SETTING_KEYS = ['summary', 'permissions', 'display', 'font_scale'] as const;
const MAX_BLE_SCAN_MS = 12_000;
const MIN_BLE_SCAN_MS = 600;

function executionFailed<TData = unknown>(call: JunLuoToolCall, message: string, summary: string): JunLuoToolResult<TData> {
  return createToolErrorResult(call, createToolError('EXECUTION_FAILED', message), summary);
}

function nativeUnavailable<TData = unknown>(call: JunLuoToolCall, message: string, summary: string): JunLuoToolResult<TData> {
  return createToolErrorResult(call, createToolError('EXECUTION_FAILED', message, { reason: 'NATIVE_UNAVAILABLE' }), summary);
}

function clampDurationMs(value: number | undefined) {
  return Math.max(MIN_BLE_SCAN_MS, Math.min(MAX_BLE_SCAN_MS, Math.round(value ?? 4_000)));
}

function idPreview(id: string) {
  if (!id) return '';
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}

async function readBluetoothPermissionStatus() {
  if (Platform.OS !== 'android') {
    return { platform: Platform.OS, granted: false, missingPermissions: [] as string[], supported: false };
  }
  const permissions = (PermissionsAndroid?.PERMISSIONS ?? {}) as Record<string, string | undefined>;
  const candidates = [
    permissions.BLUETOOTH_SCAN ?? 'android.permission.BLUETOOTH_SCAN',
    permissions.BLUETOOTH_CONNECT ?? 'android.permission.BLUETOOTH_CONNECT',
    permissions.ACCESS_FINE_LOCATION ?? 'android.permission.ACCESS_FINE_LOCATION',
  ];
  const missing: string[] = [];
  for (const permission of candidates) {
    const granted = await PermissionsAndroid.check(permission as typeof PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION).catch(() => false);
    if (!granted) missing.push(permission);
  }
  return {
    platform: Platform.OS,
    granted: missing.length === 0,
    missingPermissions: missing,
    supported: true,
  };
}

async function executeListInstalledApps(call: JunLuoToolCall) {
  const apps = await getInstalledPhoneApps().catch(() => []);
  const limit = Math.max(1, Math.min(500, Math.round(readNumberInput(call.input, 'limit') ?? 120)));
  const normalized = apps.slice(0, limit).map((app): InstalledAppSummary => {
    const raw = app as typeof app & { label?: string; packageName?: string; updatedAt?: number };
    return {
      packageName: raw.packageName,
      source: raw.source,
      title: raw.title ?? raw.label,
      updatedAt: raw.updatedAt,
    };
  });
  return createToolSuccessResult(call, `Read installed app summary: ${apps.length} apps`, {
    apps: normalized,
    count: apps.length,
    limit,
    truncated: apps.length > limit,
  });
}

async function executeGetSystemSetting(call: JunLuoToolCall) {
  const key = readOptionalStringInput(call.input, 'key') ?? 'summary';
  if (!isOneOf(key, SYSTEM_SETTING_KEYS)) {
    return validationFailed(call, `Unsupported system setting key: ${key}`, 'No system setting was read');
  }
  const window = Dimensions.get('window');
  const permissionStatus = await getPhoneActivityPermissionStatus().catch(() => null);
  const display = {
    fontScale: window.fontScale,
    height: window.height,
    scale: window.scale,
    width: window.width,
  };
  const permissions = permissionStatus ? {
    accessibility: permissionStatus.accessibility,
    notificationListener: permissionStatus.notificationListener,
    overlay: permissionStatus.overlay,
    usageAccess: permissionStatus.usageAccess,
  } : null;
  return createToolSuccessResult(call, 'Read whitelisted system setting summary', {
    display: key === 'summary' || key === 'display' || key === 'font_scale' ? display : undefined,
    key,
    permissions: key === 'summary' || key === 'permissions' ? permissions : undefined,
    platform: Platform.OS,
    version: Platform.Version,
  });
}

async function executeBluetoothStatus(call: JunLuoToolCall) {
  const manager = getColmiBleManager();
  const permissions = await readBluetoothPermissionStatus();
  if (!manager) {
    return nativeUnavailable(call, 'BLE native module is unavailable', 'No Bluetooth status was read');
  }
  const state = await manager.state().catch(() => 'Unknown');
  return createToolSuccessResult(call, `Bluetooth state: ${state}`, {
    bleNativeAvailable: true,
    bluetoothState: state,
    permissions,
    platform: Platform.OS,
  });
}

async function executeBluetoothScan(call: JunLuoToolCall) {
  const manager = getColmiBleManager();
  if (!manager) {
    return nativeUnavailable(call, 'BLE native module is unavailable', 'No Bluetooth devices were scanned');
  }
  const permissions = await readBluetoothPermissionStatus();
  if (permissions.supported && !permissions.granted) {
    return createToolErrorResult(call, createToolError('PERMISSION_DENIED', 'Missing Bluetooth scan permission'), 'No Bluetooth devices were scanned');
  }
  const state = await manager.state().catch(() => 'Unknown');
  if (state !== 'PoweredOn') {
    return executionFailed(call, `Bluetooth state is ${state}`, 'No Bluetooth devices were scanned');
  }

  const durationMs = clampDurationMs(readNumberInput(call.input, 'durationMs'));
  const devicesById = new Map<string, BleDeviceSummary>();
  let scanError: string | null = null;
  try {
    await manager.startDeviceScan(null, { allowDuplicates: true }, (error: Error | null, device: any | null) => {
      if (error) {
        scanError = error.message || 'Bluetooth scan failed';
        return;
      }
      if (!device) return;
      const displayName = device.name || device.localName || 'Unknown BLE device';
      devicesById.set(device.id, {
        displayName,
        idPreview: idPreview(device.id),
        localName: device.localName,
        name: device.name,
        rssi: device.rssi,
      });
    });
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  } catch (error) {
    return executionFailed(call, error instanceof Error ? error.message : 'Bluetooth scan failed', 'No Bluetooth devices were scanned');
  } finally {
    await manager.stopDeviceScan().catch(() => undefined);
  }

  if (scanError) {
    return executionFailed(call, scanError, 'No Bluetooth devices were scanned');
  }

  const devices = Array.from(devicesById.values()).sort((left, right) => (right.rssi ?? -999) - (left.rssi ?? -999));
  return createToolSuccessResult(call, `Bluetooth scan finished: ${devices.length} candidates`, {
    devices,
    durationMs,
    scannedAt: Date.now(),
  });
}

async function executeColmiScan(call: JunLuoToolCall) {
  const durationMs = clampDurationMs(readNumberInput(call.input, 'durationMs'));
  await startColmiScan({ timeoutMs: durationMs }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, durationMs + 60));
  const snapshot = getColmiScanSnapshot();
  await stopColmiScan().catch(() => undefined);

  if (snapshot.status === 'error') {
    return executionFailed(call, snapshot.errorMessage || 'COLMI scan failed', 'No COLMI candidates were scanned');
  }
  return createToolSuccessResult(call, `COLMI scan finished: ${snapshot.devices.length} candidates`, {
    devices: snapshot.devices.map((device) => ({
      confidence: device.confidence,
      displayName: device.displayName,
      idPreview: idPreview(device.id),
      matchedKeyword: device.matchedKeyword,
      rssi: device.rssi,
      score: device.score,
    })),
    durationMs,
    missingPermissions: snapshot.missingPermissions,
    scannedAt: Date.now(),
  });
}

export const deviceListInstalledAppsTool: JunLuoToolDefinition<Record<string, unknown>, unknown> = {
  id: 'device.list_installed_apps',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'device',
  name: 'List installed apps',
  description: 'Read a summary of installed apps without launching, stopping, installing, or uninstalling apps.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum app count, default 120, max 500' },
    },
  },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeListInstalledApps,
};

export const deviceGetSystemSettingTool: JunLuoToolDefinition<Record<string, unknown>, unknown> = {
  id: 'device.get_system_setting',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'device',
  name: 'Read system setting summary',
  description: 'Read whitelisted system settings and permission status without modifying settings.',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', enum: [...SYSTEM_SETTING_KEYS], description: 'Whitelisted setting key' },
    },
  },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeGetSystemSetting,
};

export const deviceBluetoothStatusTool: JunLuoToolDefinition<Record<string, unknown>, unknown> = {
  id: 'device.bluetooth_status',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'device',
  name: 'Read Bluetooth status',
  description: 'Read BLE native availability, Bluetooth state, and permission status.',
  inputSchema: { type: 'object' },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeBluetoothStatus,
};

export const deviceBluetoothScanTool: JunLuoToolDefinition<Record<string, unknown>, unknown> = {
  id: 'device.bluetooth_scan',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'device',
  name: 'Scan nearby Bluetooth devices',
  description: 'Briefly scan nearby BLE candidates. This does not connect or read services.',
  inputSchema: {
    type: 'object',
    properties: {
      durationMs: { type: 'number', description: 'Scan duration, default 4000ms, range 600-12000ms' },
    },
  },
  permission: 'ask',
  riskLevel: 'device_control',
  readOnly: true,
  executor: executeBluetoothScan,
};

export const deviceColmiScanTool: JunLuoToolDefinition<Record<string, unknown>, unknown> = {
  id: 'device.colmi_scan',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'device',
  name: 'Scan COLMI ring candidates',
  description: 'Reuse the body signal scanner to find likely COLMI R02 candidates. This only scans and never connects.',
  inputSchema: {
    type: 'object',
    properties: {
      durationMs: { type: 'number', description: 'Scan duration, default 4000ms, range 600-12000ms' },
    },
  },
  permission: 'ask',
  riskLevel: 'device_control',
  readOnly: true,
  executor: executeColmiScan,
};

export const deviceSystemBleTools = [
  deviceListInstalledAppsTool,
  deviceGetSystemSettingTool,
  deviceBluetoothStatusTool,
  deviceBluetoothScanTool,
  deviceColmiScanTool,
];
