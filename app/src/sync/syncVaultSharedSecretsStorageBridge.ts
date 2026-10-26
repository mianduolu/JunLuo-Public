import {
  deleteLocalServiceSecretV1,
  setLocalServiceSecretV1,
} from '../secretPackage/localServiceSecretStore';

export function setVaultSharedSecret(
  storageKey: string,
  value: string,
) {
  const normalized = value.trim();
  return normalized
    ? setLocalServiceSecretV1(storageKey, normalized)
    : deleteLocalServiceSecretV1(storageKey);
}

export function deleteVaultSharedSecret(storageKey: string) {
  return deleteLocalServiceSecretV1(storageKey);
}
