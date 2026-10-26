import { Buffer } from 'buffer';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';

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
  collectLocalSecretPackageValuesV1,
  readSecretPackageIndexV1,
  replaceSecretPackageIndexV1,
  runLocalServiceSecretOperationExclusiveV1,
} from './localServiceSecretStore';
import {
  decryptSecretPackageV1,
  encryptSecretPackageV1,
  SECRET_PACKAGE_MAX_FILE_BYTES_V1,
  secretPackageFileNameV1,
  type SecretPackageEntryV1,
  type SecretPackageProgressV1,
} from './secretPackageCore';
import {
  findSecretPackageDefinitionBySecretIdV1,
  findSecretPackageDefinitionByStorageKeyV1,
} from './secretPackageRegistry';

const SECRET_PACKAGE_IMPORT_JOURNAL_KEY_V1 =
  'junluo.secretPackage.importJournal.v1';
const SECRET_PACKAGE_ROLLBACK_CONTEXT_V1 =
  'junluo.secret-package/import-rollback/v1';
const PREVIEW_TTL_MS = 10 * 60 * 1000;

type SecretPackageImportJournalV1 = {
  version: 1;
  state: 'prepared' | 'committed';
  journalId: string;
  rollbackKey: string;
  nonce: string;
};

type SecretPackageRollbackV1 = {
  version: 1;
  entries: Array<{
    storageKey: string;
    value: string | null;
  }>;
  secretIds: string[];
};

export type SecretPackagePreviewActionV1 =
  | '新增'
  | '更新'
  | '等待相关服务设置';

export type SecretPackagePreviewItemV1 = {
  secretId: string;
  label: string;
  action: SecretPackagePreviewActionV1;
};

export type SecretPackageImportPreviewV1 = {
  handle: string;
  count: number;
  items: SecretPackagePreviewItemV1[];
};

type PendingPreview = {
  createdAt: number;
  entries: SecretPackageEntryV1[];
  preview: SecretPackageImportPreviewV1;
};

const pendingPreviews = new Map<string, PendingPreview>();

function requireDirectories() {
  if (!FileSystem.cacheDirectory || !FileSystem.documentDirectory) {
    throw new Error('当前设备无法访问秘密包私有目录。');
  }
  return {
    cacheDirectory: FileSystem.cacheDirectory,
    documentDirectory: FileSystem.documentDirectory,
  };
}

function rollbackFileUri() {
  return `${requireDirectories().documentDirectory}`
    + 'secret-package-import-rollback.v1.enc';
}

function utf8(value: string) {
  return new TextEncoder().encode(value);
}

function text(value: Uint8Array) {
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

function toBase64Url(value: Uint8Array) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromBase64Url(
  value: string,
  length: number | null,
  label: string,
) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} 编码无效。`);
  }
  const padding = (4 - (value.length % 4)) % 4;
  const bytes = new Uint8Array(Buffer.from(
    `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat(padding)}`,
    'base64',
  ));
  if (
    (length !== null && bytes.byteLength !== length)
    || toBase64Url(bytes) !== value
  ) {
    bytes.fill(0);
    throw new Error(`${label} 长度无效。`);
  }
  return bytes;
}

function rollbackAssociatedData(journalId: string) {
  return utf8(JSON.stringify({
    context: SECRET_PACKAGE_ROLLBACK_CONTEXT_V1,
    journalId,
  }));
}

async function readJournal() {
  const raw = await getSecretItem(SECRET_PACKAGE_IMPORT_JOURNAL_KEY_V1);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<SecretPackageImportJournalV1>;
  if (
    parsed.version !== 1
    || (parsed.state !== 'prepared' && parsed.state !== 'committed')
    || typeof parsed.journalId !== 'string'
    || typeof parsed.rollbackKey !== 'string'
    || typeof parsed.nonce !== 'string'
  ) {
    throw new Error('秘密包导入日志损坏。');
  }
  return parsed as SecretPackageImportJournalV1;
}

async function writeJournal(journal: SecretPackageImportJournalV1) {
  await setSecretItem(
    SECRET_PACKAGE_IMPORT_JOURNAL_KEY_V1,
    JSON.stringify(journal),
  );
}

async function cleanupJournalFiles() {
  // Remove the durable decision first. If the process stops immediately
  // afterwards, startup may safely discard the now-orphaned encrypted file.
  await deleteSecretItem(SECRET_PACKAGE_IMPORT_JOURNAL_KEY_V1);
  await FileSystem.deleteAsync(rollbackFileUri(), { idempotent: true });
}

async function readRollback(journal: SecretPackageImportJournalV1) {
  const key = fromBase64Url(journal.rollbackKey, 32, '回退日志钥匙');
  const nonce = fromBase64Url(journal.nonce, 24, '回退日志 nonce');
  let plaintext: Uint8Array | undefined;
  try {
    const encoded = await FileSystem.readAsStringAsync(rollbackFileUri());
    const ciphertext = fromBase64Url(encoded, null, '回退日志密文');
    try {
      plaintext = xchacha20poly1305(
        key,
        nonce,
        rollbackAssociatedData(journal.journalId),
      ).decrypt(ciphertext);
      const parsed = JSON.parse(text(plaintext)) as Partial<SecretPackageRollbackV1>;
      if (
        parsed.version !== 1
        || !Array.isArray(parsed.entries)
        || !Array.isArray(parsed.secretIds)
        || parsed.entries.some((entry) => (
          !entry
          || typeof entry !== 'object'
          || typeof entry.storageKey !== 'string'
          || (entry.value !== null && typeof entry.value !== 'string')
          || !findSecretPackageDefinitionByStorageKeyV1(entry.storageKey)
        ))
      ) {
        throw new Error('秘密包回退日志结构无效。');
      }
      const entries = parsed.entries as SecretPackageRollbackV1['entries'];
      return {
        version: 1,
        entries,
        secretIds: (parsed.secretIds as unknown[]).filter(
          (item): item is string => (
            typeof item === 'string'
            && !!findSecretPackageDefinitionBySecretIdV1(item)
          ),
        ),
      } satisfies SecretPackageRollbackV1;
    } finally {
      ciphertext.fill(0);
    }
  } finally {
    key.fill(0);
    nonce.fill(0);
    plaintext?.fill(0);
  }
}

async function restoreRollback(rollback: SecretPackageRollbackV1) {
  for (const entry of rollback.entries) {
    if (entry.value === null) {
      await deleteSecretItem(entry.storageKey);
    } else {
      await setSecretItem(entry.storageKey, entry.value);
    }
  }
  await replaceSecretPackageIndexV1(rollback.secretIds);
  for (const entry of rollback.entries) {
    const restored = await getSecretItem(entry.storageKey);
    if (restored !== entry.value) {
      throw new Error('秘密包旧值回读不一致。');
    }
  }
}

export function ensureSecretPackageImportRecoveryV1() {
  return runLocalServiceSecretOperationExclusiveV1(async () => {
    const journal = await readJournal();
    if (!journal) {
      await FileSystem.deleteAsync(rollbackFileUri(), {
        idempotent: true,
      });
      return false;
    }
    if (journal.state === 'committed') {
      await cleanupJournalFiles();
      return false;
    }
    const rollback = await readRollback(journal);
    await restoreRollback(rollback);
    await cleanupJournalFiles();
    return true;
  });
}

async function configuredSecretIds() {
  const [aiSettings, mcpSettings] = await Promise.all([
    AsyncStorage.getItem(VAULT_SHARED_SECRET_AI_SETTINGS_KEY),
    AsyncStorage.getItem(VAULT_SHARED_SECRET_MCP_SETTINGS_KEY),
  ]);
  return new Set(vaultSharedSecretDefinitionsFromStorage({
    [VAULT_SHARED_SECRET_AI_SETTINGS_KEY]: aiSettings,
    [VAULT_SHARED_SECRET_MCP_SETTINGS_KEY]: mcpSettings,
  }).map((definition) => definition.secretId));
}

function cleanupExpiredPreviews(now = Date.now()) {
  for (const [handle, pending] of pendingPreviews) {
    if (now - pending.createdAt > PREVIEW_TTL_MS) {
      for (const entry of pending.entries) entry.value = '';
      pendingPreviews.delete(handle);
    }
  }
}

export async function countExportableLocalSecretsV1() {
  return (await collectLocalSecretPackageValuesV1()).length;
}

export function createAndroidSecretPackageExportV1(input: {
  password: string;
  onProgress?: SecretPackageProgressV1;
}) {
  return runLocalServiceSecretOperationExclusiveV1(async () => {
    const values = await collectLocalSecretPackageValuesV1();
    if (values.length === 0) {
      throw new Error('没有可导出的服务凭据。');
    }
    const entries: SecretPackageEntryV1[] = values.map(
      ({ definition, value }) => ({
        secretId: definition.secretId,
        kind: definition.kind,
        credentialType: definition.credentialType,
        serviceId: definition.serviceId,
        value,
      }),
    );
    try {
      const serialized = await encryptSecretPackageV1({
        entries,
        password: input.password,
        randomBytes: Crypto.getRandomBytesAsync,
        resolveDefinition: findSecretPackageDefinitionBySecretIdV1,
        onProgress: input.onProgress,
      });
      const fileName = secretPackageFileNameV1();
      const uri = `${requireDirectories().cacheDirectory}${fileName}`;
      await FileSystem.writeAsStringAsync(uri, serialized, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      return { uri, fileName, count: entries.length };
    } finally {
      for (const entry of entries) entry.value = '';
    }
  });
}

export async function deleteAndroidSecretPackageExportV1(uri: string) {
  const cacheDirectory = requireDirectories().cacheDirectory;
  if (!uri.startsWith(cacheDirectory) || !uri.endsWith('.jlsecret')) {
    throw new Error('秘密包临时文件不在允许的缓存目录。');
  }
  await FileSystem.deleteAsync(uri, { idempotent: true });
}

export async function previewAndroidSecretPackageImportV1(input: {
  uri: string;
  password: string;
  onProgress?: SecretPackageProgressV1;
}): Promise<SecretPackageImportPreviewV1> {
  cleanupExpiredPreviews();
  const info = await FileSystem.getInfoAsync(input.uri);
  if (!info.exists || info.isDirectory || info.size > SECRET_PACKAGE_MAX_FILE_BYTES_V1) {
    throw new Error('秘密包文件大小无效。');
  }
  const serialized = await FileSystem.readAsStringAsync(input.uri, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  const payload = await decryptSecretPackageV1({
    serialized,
    password: input.password,
    resolveDefinition: findSecretPackageDefinitionBySecretIdV1,
    onProgress: input.onProgress,
  });
  const configured = await configuredSecretIds();
  const items = await Promise.all(payload.entries.map(async (entry) => {
    const definition = findSecretPackageDefinitionBySecretIdV1(
      entry.secretId,
    )!;
    const existing = await getSecretItem(definition.storageKey);
    const action: SecretPackagePreviewActionV1 = existing !== null
      ? '更新'
      : definition.requiresRelatedConfiguration
        && !configured.has(definition.secretId)
        ? '等待相关服务设置'
        : '新增';
    return {
      secretId: entry.secretId,
      label: definition.label,
      action,
    };
  }));
  const handle = Crypto.randomUUID();
  const preview = { handle, count: items.length, items };
  pendingPreviews.set(handle, {
    createdAt: Date.now(),
    entries: payload.entries,
    preview,
  });
  return preview;
}

export function discardAndroidSecretPackagePreviewV1(handle: string) {
  const pending = pendingPreviews.get(handle);
  if (!pending) return;
  for (const entry of pending.entries) entry.value = '';
  pendingPreviews.delete(handle);
}

export function commitAndroidSecretPackageImportV1(handle: string) {
  return runLocalServiceSecretOperationExclusiveV1(async () => {
    cleanupExpiredPreviews();
    const pending = pendingPreviews.get(handle);
    if (!pending) throw new Error('秘密包导入预览已经失效。');
    await ensureSecretPackageImportRecoveryInternalV1();
    const definitions = pending.entries.map((entry) => {
      const definition = findSecretPackageDefinitionBySecretIdV1(
        entry.secretId,
      );
      if (!definition) throw new Error('秘密包条目不在白名单。');
      return definition;
    });
    const oldValues = await Promise.all(definitions.map(async (definition) => ({
      storageKey: definition.storageKey,
      value: await getSecretItem(definition.storageKey),
    })));
    const oldSecretIds = await readSecretPackageIndexV1();
    const rollback = utf8(JSON.stringify({
      version: 1,
      entries: oldValues,
      secretIds: oldSecretIds,
    } satisfies SecretPackageRollbackV1));
    const journalId = Crypto.randomUUID();
    const rollbackKey = await Crypto.getRandomBytesAsync(32);
    const nonce = await Crypto.getRandomBytesAsync(24);
    let encryptedRollback: Uint8Array | undefined;
    const journal: SecretPackageImportJournalV1 = {
      version: 1,
      state: 'prepared',
      journalId,
      rollbackKey: toBase64Url(rollbackKey),
      nonce: toBase64Url(nonce),
    };
    try {
      encryptedRollback = xchacha20poly1305(
        rollbackKey,
        nonce,
        rollbackAssociatedData(journalId),
      ).encrypt(rollback);
      await FileSystem.writeAsStringAsync(
        rollbackFileUri(),
        toBase64Url(encryptedRollback),
        { encoding: FileSystem.EncodingType.UTF8 },
      );
      await writeJournal(journal);
      for (let index = 0; index < pending.entries.length; index += 1) {
        await setSecretItem(
          definitions[index].storageKey,
          pending.entries[index].value,
        );
      }
      await replaceSecretPackageIndexV1([
        ...oldSecretIds,
        ...pending.entries.map((entry) => entry.secretId),
      ]);
      for (let index = 0; index < pending.entries.length; index += 1) {
        const current = await getSecretItem(definitions[index].storageKey);
        if (current !== pending.entries[index].value) {
          throw new Error('秘密包导入回读不一致。');
        }
      }
      await writeJournal({ ...journal, state: 'committed' });
      // The new values are already durable after the committed marker. A
      // cleanup failure must not make the UI report that the import failed;
      // startup recovery will retry removing the encrypted journal.
      await cleanupJournalFiles().catch(() => undefined);
      return pending.preview.count;
    } catch (error) {
      try {
        await ensureSecretPackageImportRecoveryInternalV1();
      } catch (recoveryError) {
        throw new Error('秘密包导入回退失败，相关凭据已暂停使用。', {
          cause: recoveryError,
        });
      }
      throw error;
    } finally {
      rollback.fill(0);
      rollbackKey.fill(0);
      nonce.fill(0);
      encryptedRollback?.fill(0);
      discardAndroidSecretPackagePreviewV1(handle);
    }
  });
}

async function ensureSecretPackageImportRecoveryInternalV1() {
  const journal = await readJournal();
  if (!journal) {
    await FileSystem.deleteAsync(rollbackFileUri(), { idempotent: true });
    return false;
  }
  if (journal.state === 'committed') {
    await cleanupJournalFiles();
    return false;
  }
  const rollback = await readRollback(journal);
  await restoreRollback(rollback);
  await cleanupJournalFiles();
  return true;
}
