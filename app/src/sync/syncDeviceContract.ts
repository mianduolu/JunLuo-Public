import { assertBase64Url } from './syncProtocol';

export type SyncPlatform = 'android' | 'windows';
export type SyncDeviceState = 'pending' | 'active' | 'revoked';

export type SyncDevicePublicIdentityV1 = {
  version: 1;
  vaultId: string;
  deviceId: string;
  keyId: string;
  platform: SyncPlatform;
  displayName: string;
  signingPublicKey: string;
  exchangePublicKey: string;
  state: SyncDeviceState;
  createdAt: number;
  revokedAt: number | null;
};

export type SyncDeviceSecretsV1 = {
  version: 1;
  vaultId: string;
  deviceId: string;
  keyId: string;
  vaultRootSecret: string;
  signingPrivateKey: string;
  exchangePrivateKey: string;
};

export type SyncDeviceRenameRequestV1 = {
  version: 1;
  displayName: string;
};

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function normalizeSyncDeviceDisplayName(value: unknown) {
  if (typeof value !== 'string') {
    throw new Error('设备昵称必须是文字。');
  }
  const normalized = value.normalize('NFC').trim();
  const characterCount = Array.from(normalized).length;
  if (characterCount < 1 || characterCount > 20) {
    throw new Error('设备昵称长度必须在 1–20 个字符之间。');
  }
  return normalized;
}

export function syncDevicePlatformPresentation(platform: SyncPlatform) {
  return platform === 'android'
    ? { deviceType: '手机', platformName: 'Android' }
    : { deviceType: '电脑', platformName: 'Windows' };
}

export function sameSyncDeviceIdentityExceptDisplayNameV1(
  left: SyncDevicePublicIdentityV1,
  right: SyncDevicePublicIdentityV1,
) {
  return left.version === right.version
    && left.vaultId === right.vaultId
    && left.deviceId === right.deviceId
    && left.keyId === right.keyId
    && left.platform === right.platform
    && left.signingPublicKey === right.signingPublicKey
    && left.exchangePublicKey === right.exchangePublicKey
    && left.state === right.state
    && left.createdAt === right.createdAt
    && left.revokedAt === right.revokedAt;
}

export function assertSyncUuidV4(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new Error(`${label} 必须是小写 UUID v4。`);
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('设备身份或秘密记录必须是对象。');
  }
  return value as Record<string, unknown>;
}

export function assertSyncDevicePublicIdentityV1(
  value: unknown,
): asserts value is SyncDevicePublicIdentityV1 {
  const record = recordOf(value);
  const expected = [
    'version',
    'vaultId',
    'deviceId',
    'keyId',
    'platform',
    'displayName',
    'signingPublicKey',
    'exchangePublicKey',
    'state',
    'createdAt',
    'revokedAt',
  ];
  const keys = Object.keys(record);
  if (
    keys.some((key) => !expected.includes(key))
    || expected.some((key) => !(key in record))
  ) {
    throw new Error('设备公开身份字段不符合 v1 合同。');
  }
  if (record.version !== 1) throw new Error('设备公开身份版本不受支持。');
  assertSyncUuidV4(record.vaultId, 'vaultId');
  assertSyncUuidV4(record.deviceId, 'deviceId');
  assertSyncUuidV4(record.keyId, 'keyId');
  if (record.platform !== 'android' && record.platform !== 'windows') {
    throw new Error('设备平台不受支持。');
  }
  if (
    typeof record.displayName !== 'string'
    || record.displayName.trim().length < 1
    || record.displayName.length > 80
  ) {
    throw new Error('设备名称长度必须在 1–80 之间。');
  }
  assertBase64Url(record.signingPublicKey, 'signingPublicKey', { exactBytes: 32 });
  assertBase64Url(record.exchangePublicKey, 'exchangePublicKey', { exactBytes: 32 });
  if (record.state !== 'pending' && record.state !== 'active' && record.state !== 'revoked') {
    throw new Error('设备状态不受支持。');
  }
  if (!Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0) {
    throw new Error('设备创建时间必须是非负 Unix 毫秒整数。');
  }
  if (
    record.revokedAt !== null
    && (!Number.isSafeInteger(record.revokedAt) || (record.revokedAt as number) < 0)
  ) {
    throw new Error('设备撤销时间必须是 null 或非负 Unix 毫秒整数。');
  }
  if ((record.state === 'revoked') !== (record.revokedAt !== null)) {
    throw new Error('设备撤销状态与撤销时间不一致。');
  }
}

export function assertSyncDeviceSecretsV1(
  value: unknown,
): asserts value is SyncDeviceSecretsV1 {
  const record = recordOf(value);
  const expected = [
    'version',
    'vaultId',
    'deviceId',
    'keyId',
    'vaultRootSecret',
    'signingPrivateKey',
    'exchangePrivateKey',
  ];
  const keys = Object.keys(record);
  const extra = keys.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !(key in record));
  if (extra.length > 0 || missing.length > 0) {
    throw new Error('设备秘密记录字段不符合 v1 合同。');
  }
  if (record.version !== 1) {
    throw new Error('设备秘密记录版本不受支持。');
  }
  assertSyncUuidV4(record.vaultId, 'vaultId');
  assertSyncUuidV4(record.deviceId, 'deviceId');
  assertSyncUuidV4(record.keyId, 'keyId');
  assertBase64Url(record.vaultRootSecret, 'vaultRootSecret', { exactBytes: 32 });
  assertBase64Url(record.signingPrivateKey, 'signingPrivateKey', { exactBytes: 32 });
  assertBase64Url(record.exchangePrivateKey, 'exchangePrivateKey', { exactBytes: 32 });
}
