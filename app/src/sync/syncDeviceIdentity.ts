import {
  deleteSecretItem,
  getSecretItem,
  setSecretItem,
} from '../storage/secretStore';
import {
  assertSyncDeviceSecretsV1,
  assertSyncUuidV4,
  type SyncDeviceSecretsV1,
} from './syncDeviceContract';

export * from './syncDeviceContract';

const SECRET_STORAGE_PREFIX = 'junluo.sync.device-secrets.v1.';

function storageKey(deviceId: string) {
  assertSyncUuidV4(deviceId, 'deviceId');
  return `${SECRET_STORAGE_PREFIX}${deviceId}`;
}

export async function loadSyncDeviceSecrets(deviceId: string) {
  const raw = await getSecretItem(storageKey(deviceId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('设备秘密记录不是有效 JSON，已停止同步等待恢复。');
  }
  assertSyncDeviceSecretsV1(parsed);
  if (parsed.deviceId !== deviceId) {
    throw new Error('设备秘密记录与请求设备不一致，已停止同步等待恢复。');
  }
  return parsed;
}

export async function saveSyncDeviceSecrets(secrets: SyncDeviceSecretsV1) {
  assertSyncDeviceSecretsV1(secrets);
  await setSecretItem(storageKey(secrets.deviceId), JSON.stringify(secrets));
}

export async function deleteSyncDeviceSecrets(deviceId: string) {
  await deleteSecretItem(storageKey(deviceId));
}
