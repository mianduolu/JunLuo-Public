import {
  deleteSecretItem,
  setSecretItem,
} from '../storage/secretStore';
import type {
  VaultExportableSessionBusinessPort,
} from './syncVaultExportableSessionsApply';
import {
  findVaultExportableSessionBySecretId,
} from './syncVaultExportableSessionRegistry';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  unwrapVaultExportableSessionSecretV1,
} from './syncVaultExportableSessionsCrypto';

let vaultExportableSessionApplyQueue = Promise.resolve();

function enqueueVaultExportableSessionApply<T>(
  callback: () => Promise<T>,
) {
  const current = vaultExportableSessionApplyQueue
    .catch(() => undefined)
    .then(callback);
  vaultExportableSessionApplyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

export const vaultExportableSessionSecretStoreBusinessPort:
VaultExportableSessionBusinessPort = {
  upsert: (input) => enqueueVaultExportableSessionApply(async () => {
    const definition = findVaultExportableSessionBySecretId(
      input.record.secretId,
    );
    if (!definition) {
      throw new Error('收到未登记的 exportable session secretId。');
    }
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) {
      throw new Error('没有已登记设备，不能解密 exportable session。');
    }
    const secretValue = unwrapVaultExportableSessionSecretV1({
      record: input.record,
      definition,
      deviceSecrets: currentDevice.secrets,
    });
    await setSecretItem(definition.storageKey, secretValue);
  }),
  revoke: (input) => enqueueVaultExportableSessionApply(async () => {
    const definition = findVaultExportableSessionBySecretId(
      input.secretId,
    );
    if (!definition) {
      throw new Error('收到未登记的 exportable session revoke。');
    }
    await deleteSecretItem(definition.storageKey);
  }),
};
