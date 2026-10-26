import type { BodySignalDeviceProfile } from './device/bodySignalDeviceTypes';
import type { BodySignalCompanionAssociation } from './device/bodySignalCompanionTypes';
import type { BodySignalGuardianState, BodySignalGuardianSupport } from './bodySignalGuardian';

export type BodySignalGuardianEnableCheck = {
  ok: boolean;
  reason?:
    | 'association_inactive'
    | 'auth_key_missing'
    | 'bluetooth_permission_missing'
    | 'not_primary_mi_band_6'
    | 'notification_permission_missing'
    | 'unsupported';
};

export const BODY_SIGNAL_GUARDIAN_LEAVE_GRACE_MS = 30_000;
export const BODY_SIGNAL_GUARDIAN_HEART_RATE_INTERVAL_MS = 15_000;
export const BODY_SIGNAL_GUARDIAN_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 60_000] as const;

export function nextBodySignalGuardianRetryDelay(attempt: number): number | undefined {
  if (!Number.isInteger(attempt) || attempt < 1) return undefined;
  return BODY_SIGNAL_GUARDIAN_RETRY_DELAYS_MS[attempt - 1];
}

export function shouldPersistBodySignalGuardianHeartRate(
  lastPersistedAt: number | undefined,
  observedAt: number,
): boolean {
  if (!Number.isFinite(observedAt) || observedAt < 0) return false;
  if (lastPersistedAt === undefined) return true;
  return observedAt - lastPersistedAt >= BODY_SIGNAL_GUARDIAN_HEART_RATE_INTERVAL_MS;
}

export function canEnableBodySignalGuardian(input: {
  association?: BodySignalCompanionAssociation;
  authKeyHex?: string | null;
  profile?: BodySignalDeviceProfile;
  support: BodySignalGuardianSupport;
}): BodySignalGuardianEnableCheck {
  if (!input.support.supported) return { ok: false, reason: 'unsupported' };
  if (!input.support.notificationPermissionGranted) return { ok: false, reason: 'notification_permission_missing' };
  if (!input.support.bluetoothConnectPermissionGranted) return { ok: false, reason: 'bluetooth_permission_missing' };
  if (!input.profile?.isPrimary || input.profile.family !== 'mi_band_6') {
    return { ok: false, reason: 'not_primary_mi_band_6' };
  }
  if (
    input.association?.deviceProfileId !== input.profile.id
    || input.association.status !== 'active'
    || !input.association.observationEnabled
  ) return { ok: false, reason: 'association_inactive' };
  if (!/^[0-9a-f]{32}$/i.test(input.authKeyHex ?? '')) return { ok: false, reason: 'auth_key_missing' };
  return { ok: true };
}

export function guardianOwnsBodySignalConnection(state: BodySignalGuardianState): boolean {
  return state.enabled && state.owner === 'native_guardian';
}

export function bodySignalGuardianStatusMessage(state: BodySignalGuardianState): string {
  if (!state.enabled) return '全天连接守候尚未开启。';
  if (state.paused) return '全天连接守候已暂停。';
  if (state.status === 'starting') return '正在启动全天守候。';
  if (state.status === 'connecting') return '正在连接手环。';
  if (state.status === 'discovering') return '正在确认手环服务。';
  if (state.status === 'authenticating') return '正在认证手环。';
  if (state.status === 'ready') return '已就绪，传感器保持关闭。';
  if (state.status === 'sampling') return '正在读取心率。';
  if (state.status === 'suspended') return '多次重试未成功，已暂停等待。';
  if (state.status === 'stopping') return '正在安全停止。';
  if (state.status === 'error') return '全天守候遇到错误。';
  return state.appeared ? '等待建立守候连接。' : '等待穿戴设备出现。';
}
