import type { BodySignalRuntimeSettings } from './bodySignalSettingsStore';

export type BodySignalRuntimeReason = 'foreground' | 'manual' | 'screen_focus' | 'startup';

export type BodySignalRuntimeSkipReason =
  | 'already_connected'
  | 'auto_reconnect_disabled'
  | 'cooldown'
  | 'manual_disconnect'
  | 'last_device_not_found'
  | 'missing_last_device'
  | 'native_guardian_active'
  | 'scan_or_connection_busy';

export type BodySignalHeartRateResumeAction =
  | 'mi_band_6_continuous'
  | 'none'
  | 'r99_measure'
  | 'standard_subscribe';

type RuntimeScanDevice = {
  authorizedAssociationId?: string;
  displayName: string;
  id: string;
  protocolIdentity?: string;
};

export type BodySignalReconnectIdentity = {
  authorizedAssociationId?: string;
  lastAdvertisingId?: string;
  protocolIdentity?: string;
};

export function selectBodySignalReconnectCandidate<T extends RuntimeScanDevice>(
  devices: readonly T[],
  identity: BodySignalReconnectIdentity,
): T | undefined {
  const normalize = (value?: string) => value?.trim().toLowerCase() || undefined;
  const association = normalize(identity.authorizedAssociationId);
  if (association) {
    const match = devices.find((device) => normalize(device.authorizedAssociationId) === association);
    if (match) return match;
  }
  const protocolIdentity = normalize(identity.protocolIdentity);
  if (protocolIdentity) {
    const match = devices.find((device) => normalize(device.protocolIdentity) === protocolIdentity);
    if (match) return match;
  }
  const advertisingId = normalize(identity.lastAdvertisingId);
  return advertisingId
    ? devices.find((device) => normalize(device.id) === advertisingId)
    : undefined;
}

type RuntimeConnectionState = {
  capabilities?: {
    heartRateTransport: 'none' | 'smarthealth_r99' | 'standard_gatt';
    supportsHuami2021Auth?: boolean;
  };
  isConnected: boolean;
  manualDisconnectAt?: number;
  serviceUUIDs: string[];
  status: 'connected' | 'connecting' | 'disconnected' | 'discovering' | 'error' | 'subscribing';
};

type RuntimeScanState = {
  isScanning: boolean;
};

export type BodySignalReconnectPolicyInput = {
  connection: RuntimeConnectionState;
  lastAttemptAt?: number;
  lastDeviceId?: string;
  manualDisconnectAt?: number;
  minReconnectIntervalMs: number;
  now: number;
  scan: RuntimeScanState;
  settings: BodySignalRuntimeSettings;
};

export type BodySignalReconnectPolicyResult =
  | { ok: true }
  | { ok: false; reason: BodySignalRuntimeSkipReason };

export function shouldAutoReconnectBodySignal(input: BodySignalReconnectPolicyInput): BodySignalReconnectPolicyResult {
  if (!input.settings.autoReconnectEnabled) return { ok: false, reason: 'auto_reconnect_disabled' };
  if (!input.lastDeviceId) return { ok: false, reason: 'missing_last_device' };
  if (input.manualDisconnectAt) return { ok: false, reason: 'manual_disconnect' };
  if (input.connection.isConnected) return { ok: false, reason: 'already_connected' };
  if (
    input.scan.isScanning
    || input.connection.status === 'connecting'
    || input.connection.status === 'discovering'
    || input.connection.status === 'subscribing'
  ) {
    return { ok: false, reason: 'scan_or_connection_busy' };
  }
  if (input.lastAttemptAt && input.now - input.lastAttemptAt < input.minReconnectIntervalMs) {
    return { ok: false, reason: 'cooldown' };
  }
  return { ok: true };
}

export type BodySignalAutoMeasurePolicyInput = {
  connection: RuntimeConnectionState;
  lastAutoMeasureAt?: number;
  minMeasureIntervalMs: number;
  now: number;
  settings: BodySignalRuntimeSettings;
};

export function shouldAutoMeasureHeartRateAfterReconnect(input: BodySignalAutoMeasurePolicyInput): boolean {
  const action = selectBodySignalHeartRateResumeAction(input);
  return action === 'r99_measure' || action === 'mi_band_6_continuous';
}

export function selectBodySignalHeartRateResumeAction(
  input: BodySignalAutoMeasurePolicyInput,
): BodySignalHeartRateResumeAction {
  if (!input.settings.autoMeasureAfterReconnect) return 'none';
  if (!input.connection.isConnected || input.connection.status !== 'connected') return 'none';
  if (input.lastAutoMeasureAt && input.now - input.lastAutoMeasureAt < input.minMeasureIntervalMs) return 'none';
  const transport = input.connection.capabilities?.heartRateTransport
    ?? (input.connection.serviceUUIDs.includes('be940000-7333-be46-b7ae-689e71722bd5')
      ? 'smarthealth_r99'
      : input.connection.serviceUUIDs.includes('0000180d-0000-1000-8000-00805f9b34fb')
        ? 'standard_gatt'
        : 'none');
  if (transport === 'smarthealth_r99') return 'r99_measure';
  if (transport === 'standard_gatt' && input.connection.capabilities?.supportsHuami2021Auth) {
    return 'mi_band_6_continuous';
  }
  if (transport === 'standard_gatt') return 'standard_subscribe';
  return 'none';
}
