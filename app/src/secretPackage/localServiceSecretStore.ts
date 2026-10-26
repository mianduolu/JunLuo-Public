import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  deleteSecretItem,
  getSecretItem,
  setSecretItem,
} from '../storage/secretStore';
import {
  VAULT_SHARED_SECRET_AI_SETTINGS_KEY,
  VAULT_SHARED_SECRET_MCP_SETTINGS_KEY,
  vaultSharedSecretDefinitionsFromStorage,
} from '../sync/syncVaultSharedSecretDiscovery';
import {
  collectSecretPackageDefinitionsV1,
  findSecretPackageDefinitionBySecretIdV1,
  findSecretPackageDefinitionByStorageKeyV1,
  type SecretPackageDefinitionV1,
} from './secretPackageRegistry';

export const SECRET_PACKAGE_INDEX_STORAGE_KEY_V1 =
  'junluo.secretPackage.index.v1' as const;

type SecretPackageIndexV1 = {
  version: 1;
  secretIds: string[];
};

let indexMutationQueue: Promise<void> = Promise.resolve();
let secretOperationQueue: Promise<void> = Promise.resolve();

export function runLocalServiceSecretOperationExclusiveV1<T>(
  operation: () => Promise<T>,
) {
  const current = secretOperationQueue.then(operation);
  secretOperationQueue = current.then(() => undefined, () => undefined);
  return current;
}

function normalizeSecretIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(
    (item): item is string => (
      typeof item === 'string'
      && !!findSecretPackageDefinitionBySecretIdV1(item)
    ),
  ))).sort();
}

export async function readSecretPackageIndexV1() {
  const raw = await getSecretItem(SECRET_PACKAGE_INDEX_STORAGE_KEY_V1);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<SecretPackageIndexV1>;
    return parsed.version === 1
      ? normalizeSecretIds(parsed.secretIds)
      : [];
  } catch {
    return [];
  }
}

export async function replaceSecretPackageIndexV1(secretIds: readonly string[]) {
  const normalized = normalizeSecretIds(secretIds);
  await setSecretItem(
    SECRET_PACKAGE_INDEX_STORAGE_KEY_V1,
    JSON.stringify({ version: 1, secretIds: normalized }),
  );
}

function mutateIndex(operation: (current: string[]) => string[]) {
  const current = indexMutationQueue.then(async () => {
    const existing = await readSecretPackageIndexV1();
    await replaceSecretPackageIndexV1(operation(existing));
  });
  indexMutationQueue = current.catch(() => undefined);
  return current;
}

async function setLocalServiceSecretInternalV1(
  storageKey: string,
  value: string,
) {
  const definition = findSecretPackageDefinitionByStorageKeyV1(storageKey);
  if (!definition) {
    throw new Error('秘密条目不在君落秘密包白名单中。');
  }
  if (!value) {
    await deleteLocalServiceSecretInternalV1(storageKey);
    return;
  }
  await setSecretItem(storageKey, value);
  await mutateIndex((current) => [...current, definition.secretId]);
}

async function deleteLocalServiceSecretInternalV1(storageKey: string) {
  const definition = findSecretPackageDefinitionByStorageKeyV1(storageKey);
  if (!definition) {
    throw new Error('秘密条目不在君落秘密包白名单中。');
  }
  await deleteSecretItem(storageKey);
  await mutateIndex((current) => current.filter(
    (secretId) => secretId !== definition.secretId,
  ));
}

export function setLocalServiceSecretV1(
  storageKey: string,
  value: string,
) {
  return runLocalServiceSecretOperationExclusiveV1(
    () => setLocalServiceSecretInternalV1(storageKey, value),
  );
}

export function deleteLocalServiceSecretV1(storageKey: string) {
  return runLocalServiceSecretOperationExclusiveV1(
    () => deleteLocalServiceSecretInternalV1(storageKey),
  );
}

export async function discoverLocalSecretPackageDefinitionsV1() {
  const [aiSettings, mcpSettings, indexedSecretIds] = await Promise.all([
    AsyncStorage.getItem(VAULT_SHARED_SECRET_AI_SETTINGS_KEY),
    AsyncStorage.getItem(VAULT_SHARED_SECRET_MCP_SETTINGS_KEY),
    readSecretPackageIndexV1(),
  ]);
  const configured = vaultSharedSecretDefinitionsFromStorage({
    [VAULT_SHARED_SECRET_AI_SETTINGS_KEY]: aiSettings,
    [VAULT_SHARED_SECRET_MCP_SETTINGS_KEY]: mcpSettings,
  });
  return collectSecretPackageDefinitionsV1([
    ...configured.map((definition) => definition.secretId),
    ...indexedSecretIds,
  ]);
}

export async function collectLocalSecretPackageValuesV1() {
  const definitions = await discoverLocalSecretPackageDefinitionsV1();
  const values = await Promise.all(definitions.map(async (definition) => ({
    definition,
    value: await getSecretItem(definition.storageKey),
  })));
  return values.filter(
    (item): item is {
      definition: SecretPackageDefinitionV1;
      value: string;
    } => typeof item.value === 'string' && item.value.length > 0,
  );
}
