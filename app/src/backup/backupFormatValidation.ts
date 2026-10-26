import { BackupFormatError } from './backupTypes';
import { assertMissingPostImageIds, validatePostBackupStorage } from './postBackupContract';
import type { CameraBackupPrivacyManifest } from './cameraBackupPrivacy';
import { validateLegacyBackgroundAssetName } from './legacyBackupValidation';
import { assertPrimaryChatBackupStorage } from '../chat/primaryChat';
import {
  VAULT_EXPORTABLE_SESSION_SECRET_KEYS,
} from '../sync/syncVaultExportableSessionRegistry';
import {
  vaultSharedSecretDefinitionsFromStorage,
} from '../sync/syncVaultSharedSecretDiscovery';
import { voiceCallSecretKeyList } from '../voiceCall/voiceCallSecretKeys';
import {
  isSyncTechnicalStorageKey,
  ORDINARY_BACKUP_FORMAT_VERSION,
} from './ordinaryBackupPolicy';

const APP_STORAGE_PREFIX = 'junluo.';
const CONNECTION_SETTINGS_KEY = 'junluo.aiConnections';
const LEGACY_API_KEY_KEY = 'junluo.aiApiKey';
const MEMORY_EMBEDDING_API_KEY_KEY = 'junluo.memoryEmbedding.apiKey';
const connectionApiKey = (id: string) => `junluo.aiApiKey.${id}`;

export const BACKUP_DATABASE_FILES = [
  'junluo-memory.db',
  'junluo-schedule.db',
  'junluo-todo.db',
  'junluo-expense.db',
  'junluo-focus.db',
  'junluo-period.db',
  'junluo-theater.db',
  'junluo-phone-activity.db',
  'junluo-body-signal.db',
] as const;

const V8_REQUIRED_DATABASE_FILES = BACKUP_DATABASE_FILES.slice(0, 8);

export const BACKUP_V14_DATABASE_FILES = [...BACKUP_DATABASE_FILES, 'junluo-shiying.db'] as const;

export type BackupFormatVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export function requiredDatabasesForBackupVersion(version: BackupFormatVersion) {
  if (version >= 14) return BACKUP_V14_DATABASE_FILES;
  if (version >= 9) return BACKUP_DATABASE_FILES;
  if (version === 8) return V8_REQUIRED_DATABASE_FILES;
  return BACKUP_DATABASE_FILES.slice(0, 1);
}

export function assertMissingShiyingImageIds(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length
    || value.some(id => typeof id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id))) {
    throw new BackupFormatError('拾荧缺图清单无效，已经停止还原。');
  }
}

export type ValidatedBackupManifest = {
  formatVersion: BackupFormatVersion;
  missingPostImageIds?: string[];
  missingShiyingImageIds?: string[];
  excludesApiKeys?: boolean;
  excludesSyncState?: boolean;
  backgroundAssetName?: string;
  includedDatabases?: string[];
  includedFiles?: string[];
  secrets?: Record<string, string>;
  storage: Record<string, string>;
  cameraBackupPrivacy?: CameraBackupPrivacyManifest;
};

function getConnectionSecretKeys(storage: Record<string, string>) {
  const raw = storage[CONNECTION_SETTINGS_KEY];
  if (!raw) return [];
  try {
    const settings = JSON.parse(raw) as { connections?: unknown };
    if (!Array.isArray(settings?.connections)) return [];
    return settings.connections
      .map((connection) => {
        if (!connection || typeof connection !== 'object' || Array.isArray(connection)) return '';
        const id = (connection as { id?: unknown }).id;
        return typeof id === 'string' && id.length > 0 ? connectionApiKey(id) : '';
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function validateBackupManifest(value: unknown) {
  if (!value || typeof value !== 'object') {
    throw new BackupFormatError('备份里的 config.json 已损坏，已经停止还原。');
  }
  const manifest = value as {
    formatVersion?: unknown;
    missingPostImageIds?: unknown;
    missingShiyingImageIds?: unknown;
    excludesApiKeys?: unknown;
    excludesSyncState?: unknown;
    backgroundAssetName?: unknown;
    includedDatabases?: unknown;
    includedFiles?: unknown;
    secrets?: unknown;
    storage?: unknown;
    cameraBackupPrivacy?: unknown;
  };
  if (
    typeof manifest.formatVersion !== 'number' ||
    !Number.isInteger(manifest.formatVersion) ||
    manifest.formatVersion < 1 ||
    manifest.formatVersion > ORDINARY_BACKUP_FORMAT_VERSION ||
    !manifest.storage ||
    typeof manifest.storage !== 'object' ||
    Array.isArray(manifest.storage)
  ) {
    throw new BackupFormatError('这个备份版本暂时无法读取。');
  }

  if (manifest.formatVersion === 10) {
    const camera = manifest.cameraBackupPrivacy as {
      temporaryFramesIncluded?: unknown;
      manuallySavedPhotosIncluded?: unknown;
      structuredObservations?: unknown;
    } | undefined;
    const structured = camera?.structuredObservations as {
      sensitive?: unknown;
      consentGranted?: unknown;
      included?: unknown;
      recordCount?: unknown;
    } | undefined;
    if (
      camera?.temporaryFramesIncluded !== false
      || camera.manuallySavedPhotosIncluded !== false
      || structured?.sensitive !== true
      || typeof structured.consentGranted !== 'boolean'
      || structured.included !== false
      || structured.recordCount !== 0
    ) {
      throw new BackupFormatError('备份中的摄像头隐私清单已损坏，已经停止还原。');
    }
  }
  if (manifest.formatVersion >= 11) {
    const camera = manifest.cameraBackupPrivacy as {
      temporaryFramesIncluded?: unknown;
      manuallySavedPhotosIncluded?: unknown;
      structuredObservations?: unknown;
    } | undefined;
    const structured = camera?.structuredObservations as {
      sensitive?: unknown;
      consentGranted?: unknown;
      included?: unknown;
      recordCount?: unknown;
      archivePath?: unknown;
      schemaVersion?: unknown;
      byteLength?: unknown;
      sha256?: unknown;
    } | undefined;
    const commonValid = camera?.temporaryFramesIncluded === false
      && camera.manuallySavedPhotosIncluded === false
      && structured?.sensitive === true
      && typeof structured.consentGranted === 'boolean'
      && typeof structured.included === 'boolean'
      && typeof structured.recordCount === 'number'
      && Number.isSafeInteger(structured.recordCount)
      && structured.recordCount >= 0;
    const includedValid = structured?.included === true
      && structured.consentGranted === true
      && typeof structured.recordCount === 'number'
      && structured.recordCount > 0
      && structured.archivePath === 'JunLuo/sensitive/camera-observations-v1.sqlite'
      && [1, 2, 3].includes(structured.schemaVersion as number)
      && typeof structured.byteLength === 'number'
      && Number.isSafeInteger(structured.byteLength)
      && structured.byteLength > 0
      && typeof structured.sha256 === 'string'
      && /^[0-9a-f]{64}$/.test(structured.sha256);
    const excludedValid = structured?.included === false
      && structured.recordCount === 0
      && structured.archivePath === undefined
      && structured.schemaVersion === undefined
      && structured.byteLength === undefined
      && structured.sha256 === undefined;
    if (!commonValid || (!includedValid && !excludedValid)) {
      throw new BackupFormatError('备份中的摄像头隐私清单已损坏，已经停止还原。');
    }
  }
  const storage = manifest.storage as Record<string, unknown>;
  if (
    Object.entries(storage).some(
      ([key, entryValue]) =>
        key.length === 0 ||
        !key.startsWith(APP_STORAGE_PREFIX) ||
        typeof entryValue !== 'string',
    )
  ) {
    throw new BackupFormatError('备份中的应用设置已损坏，已经停止还原。');
  }

  const validatedStorage = storage as Record<string, string>;
  try {
    assertPrimaryChatBackupStorage(validatedStorage);
  } catch (error) {
    throw new BackupFormatError(error instanceof Error ? error.message : '备份聊天结构无法恢复。');
  }
  validatePostBackupStorage(validatedStorage);
  if (manifest.formatVersion >= 13) assertMissingPostImageIds(manifest.missingPostImageIds);
  if (manifest.formatVersion >= 14) assertMissingShiyingImageIds(manifest.missingShiyingImageIds);
  if (manifest.formatVersion >= 12) {
    if (
      manifest.excludesApiKeys !== true
      || manifest.excludesSyncState !== true
      || manifest.secrets !== undefined
      || Object.keys(validatedStorage).some(isSyncTechnicalStorageKey)
      || !Array.isArray(manifest.includedDatabases)
      || !Array.isArray(manifest.includedFiles)
    ) {
      throw new BackupFormatError(`君落 v${manifest.formatVersion} 普通备份包含秘密或旧同步状态，已经停止还原。`);
    }
    const expectedDatabases = requiredDatabasesForBackupVersion(manifest.formatVersion as BackupFormatVersion).map(
      (fileName) => `JunLuo/db/${fileName}`,
    );
    if (
      manifest.includedDatabases.length !== expectedDatabases.length
      || manifest.includedDatabases.some(
        (entry, index) => entry !== expectedDatabases[index],
      )
      || manifest.includedFiles.some(
        (entry) => typeof entry !== 'string'
          || !entry.startsWith('JunLuo/')
          || entry.includes('..')
          || entry.includes('\\')
          || ((manifest.formatVersion as number) >= 14
            && entry.startsWith('JunLuo/files/shiying-media')
            && !/^JunLuo\/files\/shiying-media\/[0-9a-f]{64}$/.test(entry)),
      )
      || new Set(manifest.includedFiles).size !== manifest.includedFiles.length
    ) {
      throw new BackupFormatError(`君落 v${manifest.formatVersion} 普通备份清单已损坏，已经停止还原。`);
    }
  }
  if (manifest.secrets !== undefined) {
    if (!manifest.secrets || typeof manifest.secrets !== 'object' || Array.isArray(manifest.secrets)) {
      throw new BackupFormatError('备份中的密钥清单已损坏，已经停止还原。');
    }
    const allowedSecretKeys = new Set([
      LEGACY_API_KEY_KEY,
      MEMORY_EMBEDDING_API_KEY_KEY,
      ...voiceCallSecretKeyList,
      ...VAULT_EXPORTABLE_SESSION_SECRET_KEYS,
      ...vaultSharedSecretDefinitionsFromStorage(validatedStorage).map(
        (definition) => definition.storageKey,
      ),
      ...getConnectionSecretKeys(validatedStorage),
    ]);
    if (
      Object.entries(manifest.secrets).some(
        ([key, entryValue]) => !allowedSecretKeys.has(key) || typeof entryValue !== 'string',
      )
    ) {
      throw new BackupFormatError('备份包含无法识别的密钥记录，已经停止还原。');
    }
  }

  validateLegacyBackgroundAssetName(manifest.backgroundAssetName);
  return value as ValidatedBackupManifest;
}

export function validateOrdinaryBackupArchiveFiles(
  manifest: ValidatedBackupManifest,
  archiveFilePaths: Iterable<string>,
) {
  if (manifest.formatVersion < 12) return;
  const cameraPath = manifest.cameraBackupPrivacy?.structuredObservations.included
    ? 'JunLuo/sensitive/camera-observations-v1.sqlite'
    : null;
  const expected = new Set([
    'JunLuo/config.json',
    ...(manifest.includedDatabases ?? []),
    ...(manifest.includedFiles ?? []),
    ...(cameraPath ? [cameraPath] : []),
  ]);
  const actual = new Set(archiveFilePaths);
  if (
    expected.size !== actual.size
    || [...expected].some((path) => !actual.has(path))
  ) {
    throw new BackupFormatError(`君落 v${manifest.formatVersion} 普通备份清单与实际文件不一致，已经停止还原。`);
  }
}

export function findMissingBackupDatabases(
  existingFileNames: Iterable<string>,
  formatVersion: BackupFormatVersion = 7,
) {
  const existing = new Set(existingFileNames);
  if (!existing.has(BACKUP_DATABASE_FILES[0])) {
    throw new BackupFormatError('备份缺少君落的必需记忆数据库。');
  }
  const databaseFiles = formatVersion >= 14 ? BACKUP_V14_DATABASE_FILES : BACKUP_DATABASE_FILES;
  const missingDatabases = databaseFiles.slice(1)
    .filter((fileName) => !existing.has(fileName))
    .map((fileName) => `JunLuo/db/${fileName}`);
  if (
    formatVersion === 8
    && V8_REQUIRED_DATABASE_FILES.some((fileName) => !existing.has(fileName))
  ) {
    throw new BackupFormatError('备份缺少君落 v8 的必需数据库，已经停止还原。');
  }
  if (formatVersion >= 9 && missingDatabases.length > 0) {
    throw new BackupFormatError(`备份缺少君落 v${formatVersion} 的必需数据库，已经停止还原。`);
  }
  return missingDatabases;
}
