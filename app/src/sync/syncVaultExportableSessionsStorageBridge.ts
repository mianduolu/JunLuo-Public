import {
  deleteLocalServiceSecretV1,
  setLocalServiceSecretV1,
} from '../secretPackage/localServiceSecretStore';

export function setVaultExportableSessionSecret(
  storageKey: string,
  value: string,
) {
  return setLocalServiceSecretV1(storageKey, value);
}

export function deleteVaultExportableSessionSecret(
  storageKey: string,
) {
  return deleteLocalServiceSecretV1(storageKey);
}
