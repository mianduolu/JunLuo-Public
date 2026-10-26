import {
  deleteSecretItem,
  getSecretItem,
  setSecretItem,
} from '../../storage/secretStore';
import { normalizeMiBandAuthKeyHex } from './miBand6AuthProtocol';

const MI_BAND_6_AUTH_KEY_SECRET_PREFIX = 'junluo.bodySignal.miBand6.authKey.';

function secretId(deviceId: string): string {
  const normalized = deviceId.trim().toLowerCase();
  if (!normalized) throw new RangeError('缺少手环设备标识。');
  return `${MI_BAND_6_AUTH_KEY_SECRET_PREFIX}${normalized}`;
}

export async function getMiBand6AuthKey(deviceId: string): Promise<string | null> {
  const value = await getSecretItem(secretId(deviceId));
  if (value === null) return null;
  try {
    return normalizeMiBandAuthKeyHex(value);
  } catch {
    await deleteSecretItem(secretId(deviceId)).catch(() => undefined);
    return null;
  }
}

export async function setMiBand6AuthKey(deviceId: string, authKeyHex: string): Promise<void> {
  await setSecretItem(secretId(deviceId), normalizeMiBandAuthKeyHex(authKeyHex));
}

export async function deleteMiBand6AuthKey(deviceId: string): Promise<void> {
  await deleteSecretItem(secretId(deviceId));
}
