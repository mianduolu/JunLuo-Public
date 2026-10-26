import {
  base64UrlToBytes,
  bytesToBase64Url,
  exchangePublicKeyFromPrivateV1,
  signingPublicKeyFromPrivateV1,
} from './syncCrypto';
import {
  assertSyncDevicePublicIdentityV1,
  assertSyncDeviceSecretsV1,
  type SyncDevicePublicIdentityV1,
  type SyncDeviceSecretsV1,
  type SyncPlatform,
} from './syncDeviceContract';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SyncRandomBytesV1 = (
  length: number,
) => Uint8Array | Promise<Uint8Array>;

export type SyncRandomUuidV1 = () => string | Promise<string>;

export type PendingSyncDeviceSecretsV1 = {
  version: 1;
  vaultId: string;
  deviceId: string;
  keyId: string;
  signingPrivateKey: string;
  exchangePrivateKey: string;
};

type CreateDeviceBaseV1 = {
  platform: SyncPlatform;
  displayName: string;
  createdAt: number;
  randomBytes: SyncRandomBytesV1;
  randomUuid: SyncRandomUuidV1;
};

export type CreateInitialSyncDeviceInputV1 = CreateDeviceBaseV1;

export type CreatePendingSyncDeviceInputV1 = CreateDeviceBaseV1 & {
  vaultId: string;
  keyId: string;
};

function assertCanonicalUuidV4(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new Error(`${label} 必须是小写 UUID v4。`);
  }
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
) {
  const keys = Object.keys(record);
  if (
    keys.some((key) => !expected.includes(key))
    || expected.some((key) => !(key in record))
  ) {
    throw new Error(`${label} 字段不符合 v1 合同。`);
  }
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

async function randomBytesExact(
  source: SyncRandomBytesV1,
  length: number,
  label: string,
) {
  const value = await source(length);
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new Error(`${label} 必须由 CSPRNG 返回正好 ${length} bytes。`);
  }
  return value;
}

async function randomUuid(source: SyncRandomUuidV1, label: string) {
  const value = await source();
  assertCanonicalUuidV4(value, label);
  return value;
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function createPublicIdentity(
  input: {
    vaultId: string;
    deviceId: string;
    keyId: string;
    platform: SyncPlatform;
    displayName: string;
    createdAt: number;
    signingPrivateKey: Uint8Array;
    exchangePrivateKey: Uint8Array;
  },
  state: 'active' | 'pending',
): SyncDevicePublicIdentityV1 {
  const identity: SyncDevicePublicIdentityV1 = {
    version: 1,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    keyId: input.keyId,
    platform: input.platform,
    displayName: input.displayName,
    signingPublicKey: bytesToBase64Url(
      signingPublicKeyFromPrivateV1(input.signingPrivateKey),
    ),
    exchangePublicKey: bytesToBase64Url(
      exchangePublicKeyFromPrivateV1(input.exchangePrivateKey),
    ),
    state,
    createdAt: input.createdAt,
    revokedAt: null,
  };
  assertSyncDevicePublicIdentityV1(identity);
  return identity;
}

export function assertPendingSyncDeviceSecretsV1(
  value: unknown,
): asserts value is PendingSyncDeviceSecretsV1 {
  const record = recordOf(value, '待配对设备秘密');
  assertExactKeys(
    record,
    [
      'version',
      'vaultId',
      'deviceId',
      'keyId',
      'signingPrivateKey',
      'exchangePrivateKey',
    ],
    '待配对设备秘密',
  );
  if (record.version !== 1) throw new Error('待配对设备秘密版本不受支持。');
  assertCanonicalUuidV4(record.vaultId, 'vaultId');
  assertCanonicalUuidV4(record.deviceId, 'deviceId');
  assertCanonicalUuidV4(record.keyId, 'keyId');
  base64UrlToBytes(record.signingPrivateKey as string, 'signingPrivateKey', 32);
  base64UrlToBytes(record.exchangePrivateKey as string, 'exchangePrivateKey', 32);
}

export async function createLocalSyncWorldDeviceV1(
  input: CreateInitialSyncDeviceInputV1,
) {
  assertTimestamp(input.createdAt, 'createdAt');
  const vaultId = await randomUuid(input.randomUuid, 'vaultId');
  const deviceId = await randomUuid(input.randomUuid, 'deviceId');
  const keyId = await randomUuid(input.randomUuid, 'keyId');
  const vaultRootSecret = await randomBytesExact(
    input.randomBytes,
    32,
    'vaultRootSecret',
  );
  const signingPrivateKey = await randomBytesExact(
    input.randomBytes,
    32,
    'signingPrivateKey',
  );
  const exchangePrivateKey = await randomBytesExact(
    input.randomBytes,
    32,
    'exchangePrivateKey',
  );
  const publicIdentity = createPublicIdentity({
    ...input,
    vaultId,
    deviceId,
    keyId,
    signingPrivateKey,
    exchangePrivateKey,
  }, 'active');
  const secrets: SyncDeviceSecretsV1 = {
    version: 1,
    vaultId,
    deviceId,
    keyId,
    vaultRootSecret: bytesToBase64Url(vaultRootSecret),
    signingPrivateKey: bytesToBase64Url(signingPrivateKey),
    exchangePrivateKey: bytesToBase64Url(exchangePrivateKey),
  };
  assertSyncDeviceSecretsV1(secrets);
  return { publicIdentity, secrets };
}

export async function createInitialSyncDeviceV1(
  input: CreateInitialSyncDeviceInputV1,
) {
  return createLocalSyncWorldDeviceV1(input);
}

export async function createPendingSyncDeviceV1(
  input: CreatePendingSyncDeviceInputV1,
) {
  assertCanonicalUuidV4(input.vaultId, 'vaultId');
  assertCanonicalUuidV4(input.keyId, 'keyId');
  assertTimestamp(input.createdAt, 'createdAt');
  const deviceId = await randomUuid(input.randomUuid, 'deviceId');
  const signingPrivateKey = await randomBytesExact(
    input.randomBytes,
    32,
    'signingPrivateKey',
  );
  const exchangePrivateKey = await randomBytesExact(
    input.randomBytes,
    32,
    'exchangePrivateKey',
  );
  const publicIdentity = createPublicIdentity({
    ...input,
    deviceId,
    signingPrivateKey,
    exchangePrivateKey,
  }, 'pending');
  const pendingSecrets: PendingSyncDeviceSecretsV1 = {
    version: 1,
    vaultId: input.vaultId,
    deviceId,
    keyId: input.keyId,
    signingPrivateKey: bytesToBase64Url(signingPrivateKey),
    exchangePrivateKey: bytesToBase64Url(exchangePrivateKey),
  };
  assertPendingSyncDeviceSecretsV1(pendingSecrets);
  return { publicIdentity, pendingSecrets };
}

export function finalizePairedSyncDeviceSecretsV1(
  pending: PendingSyncDeviceSecretsV1,
  vaultRootSecret: Uint8Array,
) {
  assertPendingSyncDeviceSecretsV1(pending);
  const secrets: SyncDeviceSecretsV1 = {
    ...pending,
    vaultRootSecret: bytesToBase64Url(vaultRootSecret),
  };
  assertSyncDeviceSecretsV1(secrets);
  return secrets;
}
