import {
  deleteSecretItem,
  setSecretItem,
} from '../storage/secretStore';
import type {
  VaultSharedSecretBusinessPort,
} from './syncVaultSharedSecretsApply';
import {
  findVaultSharedSecretBySecretId,
} from './syncVaultSharedSecretRegistry';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  unwrapVaultSharedSecretV1,
} from './syncVaultSharedSecretsCrypto';

let vaultSharedSecretApplyQueue = Promise.resolve();

function enqueueVaultSharedSecretApply<T>(
  callback: () => Promise<T>,
) {
  const current = vaultSharedSecretApplyQueue
    .catch(() => undefined)
    .then(callback);
  vaultSharedSecretApplyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

export const vaultSharedSecretStoreBusinessPort:
VaultSharedSecretBusinessPort = {
  upsert: (input) => enqueueVaultSharedSecretApply(async () => {
    const definition = findVaultSharedSecretBySecretId(
      input.record.secretId,
    );
    if (!definition) {
      throw new Error('收到未登记的 shared secret secretId。');
    }
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) {
      throw new Error('没有已登记设备，不能解密 shared secret。');
    }
    const secretValue = unwrapVaultSharedSecretV1({
      record: input.record,
      definition,
      deviceSecrets: currentDevice.secrets,
    });
    await setSecretItem(definition.storageKey, secretValue);
  }),
  revoke: (input) => enqueueVaultSharedSecretApply(async () => {
    const definition = findVaultSharedSecretBySecretId(
      input.secretId,
    );
    if (!definition) {
      throw new Error('收到未登记的 shared secret revoke。');
    }
    await deleteSecretItem(definition.storageKey);
  }),
};
