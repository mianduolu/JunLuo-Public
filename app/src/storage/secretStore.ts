import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const SECRET_PREFIX = 'junluo.fallbackSecret.';
const SECURE_SECRET_PREFIX = 'junluo.secret.v1.';
const LEGACY_DIRECT_SECURE_KEYS = ['junluo.voiceCall.backend.apiToken'] as const;

export const LEGACY_SECRET_STORAGE_PREFIX = SECRET_PREFIX;

function legacyKeyFor(id: string) {
  return `${SECRET_PREFIX}${encodeURIComponent(id)}`;
}

function secureKeyFor(id: string) {
  let encoded = '';
  for (let index = 0; index < id.length; index += 1) {
    encoded += id.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return `${SECURE_SECRET_PREFIX}${encoded}`;
}

function decodeLegacyStorageKey(storageKey: string) {
  const encoded = storageKey.slice(SECRET_PREFIX.length);
  if (!encoded) throw new Error('旧密钥条目名称无法安全解码。');
  try {
    const id = decodeURIComponent(encoded);
    if (legacyKeyFor(id) !== storageKey) {
      throw new Error('旧密钥条目名称不是规范编码。');
    }
    return id;
  } catch {
    throw new Error('旧密钥条目名称无法安全解码。');
  }
}

function isLegacyDirectSecureKey(key: string): key is (typeof LEGACY_DIRECT_SECURE_KEYS)[number] {
  return (LEGACY_DIRECT_SECURE_KEYS as readonly string[]).includes(key);
}

async function migrateLegacyDirectSecureItem(key: (typeof LEGACY_DIRECT_SECURE_KEYS)[number]) {
  const directValue = await SecureStore.getItemAsync(key);
  if (directValue === null) return;
  const secureKey = secureKeyFor(key);
  const mappedValue = await SecureStore.getItemAsync(secureKey);
  if (mappedValue === null) {
    await SecureStore.setItemAsync(secureKey, directValue);
  }
  await SecureStore.deleteItemAsync(key);
}

async function readLegacyDirectSecureItem(key: string) {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function deleteLegacyDirectSecureItem(key: string) {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // Some historical or third-party ids are not valid raw SecureStore keys.
  }
}

async function removeLegacyCopies(key: string) {
  await AsyncStorage.removeItem(legacyKeyFor(key));
  await deleteLegacyDirectSecureItem(key);
}

export async function migrateLegacySecretStorage() {
  for (const key of LEGACY_DIRECT_SECURE_KEYS) {
    await migrateLegacyDirectSecureItem(key);
  }

  const storageKeys = await AsyncStorage.getAllKeys();
  for (const storageKey of storageKeys) {
    if (!storageKey.startsWith(SECRET_PREFIX)) continue;
    const key = decodeLegacyStorageKey(storageKey);
    const legacyValue = await AsyncStorage.getItem(storageKey);
    if (legacyValue === null) continue;

    if (isLegacyDirectSecureKey(key)) {
      await migrateLegacyDirectSecureItem(key);
    }
    const secureKey = secureKeyFor(key);
    const secureValue = await SecureStore.getItemAsync(secureKey);
    if (secureValue === null) {
      await SecureStore.setItemAsync(secureKey, legacyValue);
    }
    await AsyncStorage.removeItem(storageKey);
  }
}

export async function getSecretItem(key: string, readOnly = false, strictReadOnly = false) {
  const secureKey = secureKeyFor(key);
  const secureValue = await SecureStore.getItemAsync(secureKey);
  if (secureValue !== null) {
    if (!readOnly) await removeLegacyCopies(key).catch(() => undefined);
    return secureValue;
  }

  // A strict inspection must distinguish damaged storage from a missing saved secret.
  const directSecureValue = readOnly && strictReadOnly
    ? await SecureStore.getItemAsync(key)
    : await readLegacyDirectSecureItem(key);
  if (directSecureValue !== null) {
    if (!readOnly) {
      await SecureStore.setItemAsync(secureKey, directSecureValue);
      await removeLegacyCopies(key);
    }
    return directSecureValue;
  }

  const legacyValue = await AsyncStorage.getItem(legacyKeyFor(key));
  if (legacyValue === null) return null;
  if (!readOnly) {
    await SecureStore.setItemAsync(secureKey, legacyValue);
    await removeLegacyCopies(key);
  }
  return legacyValue;
}

export async function setSecretItem(key: string, value: string) {
  await SecureStore.setItemAsync(secureKeyFor(key), value);
  await removeLegacyCopies(key);
}

export async function deleteSecretItem(key: string) {
  await SecureStore.deleteItemAsync(secureKeyFor(key));
  await removeLegacyCopies(key);
}
