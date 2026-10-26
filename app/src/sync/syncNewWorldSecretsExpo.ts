import {
  deleteSecretItem,
  getSecretItem,
  setSecretItem,
} from '../storage/secretStore';
import {
  assertSyncDevicePublicIdentityV1,
  assertSyncDeviceSecretsV1,
  sameSyncDeviceIdentityExceptDisplayNameV1,
  type SyncDevicePublicIdentityV1,
  type SyncDeviceSecretsV1,
} from './syncDeviceContract';
import {
  expoSyncRandomBytesV1,
  expoSyncRandomUuidV1,
} from './syncCryptoExpo';
import {
  createLocalSyncWorldDeviceV1,
} from './syncDeviceProvisioning';
import {
  assertSyncWorldDescriptorV2,
  createSyncWorldDescriptorV2,
  type SyncWorldDescriptorV2,
} from './syncWorld';
import { resetAutomaticDataSyncPolicy } from './automaticDataSyncPolicy';

export const NEW_WORLD_CURRENT_SECRET_KEY =
  'junluo.sync.v2.staging.device.v1' as const;
export const NEW_WORLD_REBUILD_PENDING_SECRET_KEY =
  'junluo.sync.v2.rebuild-pending.device.v1' as const;
export const NEW_WORLD_REBUILD_ROLLBACK_SECRET_KEY =
  'junluo.sync.v2.rebuild-rollback.device.v1' as const;

export type NewWorldAndroidStagingSecretV1 = Readonly<{
  version: 1;
  world: SyncWorldDescriptorV2;
  identity: SyncDevicePublicIdentityV1;
  secrets: SyncDeviceSecretsV1;
  createdAt: number;
}>;

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative timestamp`);
  }
}

export function assertNewWorldAndroidStagingSecretV1(
  value: unknown,
): asserts value is NewWorldAndroidStagingSecretV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('new-world Android staging secret must be an object');
  }
  const record = value as Record<string, unknown>;
  const expected = ['version', 'world', 'identity', 'secrets', 'createdAt'];
  if (
    Object.keys(record).some((key) => !expected.includes(key))
    || expected.some((key) => !(key in record))
  ) {
    throw new Error('new-world Android staging secret fields do not match v1');
  }
  if (record.version !== 1) {
    throw new Error('new-world Android staging secret version is unsupported');
  }
  assertSyncWorldDescriptorV2(record.world);
  assertSyncDevicePublicIdentityV1(record.identity);
  assertSyncDeviceSecretsV1(record.secrets);
  assertTimestamp(record.createdAt, 'new-world Android staging createdAt');
  const world = record.world as SyncWorldDescriptorV2;
  const identity = record.identity as SyncDevicePublicIdentityV1;
  const secrets = record.secrets as SyncDeviceSecretsV1;
  if (
    identity.platform !== 'android'
    || identity.state !== 'active'
    || identity.revokedAt !== null
    || identity.vaultId !== world.vaultId
    || identity.keyId !== world.keyId
    || secrets.vaultId !== world.vaultId
    || secrets.keyId !== world.keyId
    || secrets.deviceId !== identity.deviceId
  ) {
    throw new Error('new-world Android staging identity is inconsistent');
  }
}

export async function loadNewWorldAndroidStagingSecret() {
  return loadNewWorldAndroidSecretSlot(NEW_WORLD_CURRENT_SECRET_KEY);
}

export async function loadNewWorldAndroidSecretSlot(key: string) {
  const raw = await getSecretItem(key);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('new-world Android staging secret is not valid JSON');
  }
  assertNewWorldAndroidStagingSecretV1(parsed);
  return parsed;
}

export async function saveNewWorldAndroidSecretSlot(
  key: string,
  value: NewWorldAndroidStagingSecretV1,
) {
  assertNewWorldAndroidStagingSecretV1(value);
  const serialized = JSON.stringify(value);
  await setSecretItem(key, serialized);
  const readBack = await getSecretItem(key);
  if (readBack !== serialized) {
    throw new Error('new-world Android secret slot read-back did not match');
  }
  return value;
}

export async function updateNewWorldAndroidCurrentIdentity(
  identity: SyncDevicePublicIdentityV1,
) {
  assertSyncDevicePublicIdentityV1(identity);
  const current = await loadNewWorldAndroidStagingSecret();
  if (!current) {
    throw new Error('新世界当前设备安全记录不存在。');
  }
  if (!sameSyncDeviceIdentityExceptDisplayNameV1(
    current.identity,
    identity,
  )) {
    throw new Error('昵称更新不能改变 Android 设备的加密身份。');
  }
  return saveNewWorldAndroidSecretSlot(
    NEW_WORLD_CURRENT_SECRET_KEY,
    Object.freeze({ ...current, identity }),
  );
}

export async function deleteNewWorldAndroidSecretSlot(key: string) {
  await deleteSecretItem(key);
}

export async function createNewWorldAndroidStagingSecret(input: {
  displayName: string;
  createdAt?: number;
}) {
  const existing = await loadNewWorldAndroidStagingSecret();
  if (existing) return existing;
  const value = await generateNewWorldAndroidSecret(input);
  const serialized = JSON.stringify(value);
  await setSecretItem(NEW_WORLD_CURRENT_SECRET_KEY, serialized);
  const readBack = await getSecretItem(NEW_WORLD_CURRENT_SECRET_KEY);
  if (readBack !== serialized) {
    throw new Error('new-world Android staging secret read-back did not match');
  }
  await resetAutomaticDataSyncPolicy();
  return value;
}

export async function generateNewWorldAndroidSecret(input: {
  displayName: string;
  createdAt?: number;
}) {
  const createdAt = input.createdAt ?? Date.now();
  const created = await createLocalSyncWorldDeviceV1({
    platform: 'android',
    displayName: input.displayName,
    createdAt,
    randomBytes: expoSyncRandomBytesV1,
    randomUuid: expoSyncRandomUuidV1,
  });
  const value: NewWorldAndroidStagingSecretV1 = Object.freeze({
    version: 1,
    world: createSyncWorldDescriptorV2({
      vaultId: created.publicIdentity.vaultId,
      keyId: created.publicIdentity.keyId,
    }),
    identity: created.publicIdentity,
    secrets: created.secrets,
    createdAt,
  });
  assertNewWorldAndroidStagingSecretV1(value);
  return value;
}
