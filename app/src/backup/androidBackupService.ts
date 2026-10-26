import AsyncStorage from '@react-native-async-storage/async-storage';
import { CHAT_REPLY_DRAFT_KEY } from '../chat/chatReplyDraft';
import { SLEEP_REPLY_DRAFT_KEY } from '../life/sleepPlanPolicy';
import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

import {
  discardNativePhoneActivityLogsForRestore,
  quiescePhoneActivityCollectorForRestore,
  resumePhoneActivityCollectorAfterRestore,
} from '../backend/phoneActivityNative';
import { clearBodySignalDatabase } from '../bodySignal/bodySignalStore';
import { clearExpenseDatabase } from '../expense/expenseStore';
import { clearFocusDatabase } from '../focus/focusStore';
import {
  TOGETHER_WALKED_DRAFT_STORAGE_KEY,
  TOGETHER_WALKED_IMAGE_FOLDER,
  TOGETHER_WALKED_STORAGE_KEY,
  type TogetherWalkedEntry,
} from '../memory/togetherWalkedStore';
import { clearPeriodDatabase } from '../period/periodStore';
import {
  clearPhoneActivityDatabase,
  drainNativePhoneActivityLogsForRestore,
  syncNativePhoneActivityLogs,
} from '../phoneActivity/phoneActivityStore';
import {
  migrateReadingStorageIfNeeded,
  READING_AI_LEGACY_DEBUG_KEY,
  repairReadingBookFiles,
} from '../reading/readingStore';
import {
  purgeRetiredAssistantBusinessData,
} from '../ai/retiredAssistantFeatureCleanup';
import {
  RETIRED_ASSISTANT_FEATURE_BACKUP_EXCLUDED_KEYS,
  sanitizeRetiredAssistantStorage,
} from '../ai/retiredAssistantFeatureData';
import { JUNLUO_INNER_STATE_KEYS } from '../life/junluoInnerState';
import {
  prepareJunluoInnerStateRestoreStorage,
} from '../life/junluoInnerStatePersistence';
import { clearScheduleDatabase } from '../schedule/scheduleStore';
import { clearTodoDatabase } from '../schedule/todoDatabaseBackup';
import {
  LEGACY_SECRET_STORAGE_PREFIX,
} from '../storage/secretStore';
import { restoreDirectorySafely, writeStringFileSafely } from '../storage/safeFileWrite';
import { clearTheaterDatabase } from '../theater/theaterStore';
import { prepareTheaterBackupFile } from '../theater/theaterStoryBackup';
import { resetAutomaticRemoteAiPolicyAfterRestore } from '../runtime/automaticRemoteAiPolicy';
import { AUTOMATIC_REMOTE_AI_POLICY_KEY } from '../runtime/automaticRemoteAiPolicyCore';
import {
  resetAutomaticDataSyncPolicy,
} from '../sync/automaticDataSyncPolicy';
import {
  AUTOMATIC_DATA_SYNC_POLICY_KEY,
  AUTOMATIC_DATA_SYNC_RUNTIME_STATUS_KEY,
} from '../sync/automaticDataSyncPolicyCore';
import {
  cleanupNativeBackupTemporaryFiles,
  createNativeArchive,
  extractNativeArchive,
  validateNativeDatabase,
} from './backupArchiveNative';
import {
  findMissingBackupDatabases,
  validateBackupManifest,
  validateOrdinaryBackupArchiveFiles,
} from './backupFormatValidation';
import {
  CAMERA_OBSERVATION_ARCHIVE_PATH,
  shouldExcludeCameraStorageKey,
  type CameraBackupPrivacyManifest,
} from './cameraBackupPrivacy';
import {
  clearCameraObservationBackup,
  prepareCameraObservationBackup,
  restoreCameraObservationBackup,
  validateCameraObservationBackupPayload,
} from './cameraObservationBackup';
import { captureBackupMediaDirectoryStrict, captureBackupMediaFileStrict } from './backupMediaSnapshot';
import { captureGiftBackupOriginals, readGiftBackupOriginals, restoreGiftBackupOriginals,
  validateGiftBackupOriginals, GIFT_ORIGINALS_BACKUP_PREFIX } from './giftBackupPaths';
import type { GiftOriginal } from '../gifts/giftTypes';
import { pauseFastRefreshForBackupRestore } from './backupRestoreDevGuard';
import { prepareWantsPaperBackupStorage, replaceBackupStorageSafely } from './backupStorageRestore';
import {
  beginBackupRestoreSyncGate,
  clearBackupRestoreSyncGate,
  markBackupRestoreSyncRebuildRequired,
} from './backupRestoreSyncGate';
import { runRestoreCommitWithRollback } from './backupRestoreOrchestrator';
import { createBackupRestoreJournalLifecycle } from './backupRestoreJournalStore';
import { reconcileRestoredNotificationState } from './restoreNotificationState';
import {
  BackupDatabaseValidationError,
  BackupDiskSpaceError,
  BackupFormatError,
  BackupRollbackFailedError,
  BackupRestoreRolledBackError,
  CameraObservationRestoreChoiceRequiredError,
  LegacyBackupSecretsIgnoredNoticeRequiredError,
  PreImportBackupSnapshotError,
  type BackupStageCallback,
  type RestoreBackupOptions,
  type RestoreBackupResult,
} from './backupTypes';
import {
  isOrdinaryBackupStorageKey,
  ORDINARY_BACKUP_FORMAT_VERSION,
  sanitizeOrdinaryBackupStorage,
} from './ordinaryBackupPolicy';
import { createReadingBackupStats, isSafeReadingBackupPathSegment, joinSafeReadingBackupPath } from './readingBackupPaths';
import {
  backupDatabaseToDirectory,
  restoreDatabaseFromDisk,
} from './sqliteBackupFiles';
import {
  isSafeTogetherWalkedBackupRelativePath,
  listTogetherWalkedBackupDirectory,
  rewriteManagedTogetherWalkedImageUri,
} from './togetherWalkedBackupPaths';
import {
  BAIYUN_STICKER_FOLDER,
  isSafeBaiyunStickerBackupRelativePath,
  rewriteRestoredBaiyunStickerUris,
} from './stickerBackupPaths';
import {
  isSafeToolWorkspaceBackupFileName,
  rewriteRestoredToolWorkspaceFileUris,
  TOOL_WORKSPACE_FILE_FOLDER,
} from './toolWorkspaceBackupPaths';

import { capturePostBackup, preparePostBackupImages, restorePostBackupImages, prepareRestoredPostStorage,
  acceptPostMissing, POST_BACKUP_PREFIX, type PreparedPostImages } from './postBackup';
import { openDatabaseImportSource } from './sqliteBackupFiles';
import type { BackupArchiveResult, CreateBackupArchiveOptions } from './backupTypes';
import { captureShiyingBackup, prepareShiyingBackup, restoreShiyingBackup, acceptShiyingMissing,
  type PreparedShiyingBackup } from '../shiying/shiyingBackup';
import { SHIYING_DATABASE_NAME } from '../shiying/shiyingDatabase';

const ROOT_FOLDER = 'JunLuo';
const BACKGROUND_SETTINGS_KEY = 'junluo.backgroundSettings';
const CHAT_MESSAGES_KEY = 'junluo.chat.primaryMessages';
const CHAT_SESSION_MESSAGES_PREFIX = 'junluo.chat.sessionMessages.';
const CHAT_SESSION_MESSAGE_PREFIX = 'junluo.chat.sessionMessage.';
const VOICE_MESSAGES_FOLDER = 'voice-messages';
const READING_FILES_FOLDER = 'reading/books';
const MIN_FREE_BYTES = 64 * 1024 * 1024;
const APP_STORAGE_PREFIX = 'junluo.';
const EXCLUDED_STORAGE_KEYS = new Set([
  READING_AI_LEGACY_DEBUG_KEY,
  AUTOMATIC_REMOTE_AI_POLICY_KEY,
  AUTOMATIC_DATA_SYNC_POLICY_KEY,
  AUTOMATIC_DATA_SYNC_RUNTIME_STATUS_KEY,
  ...RETIRED_ASSISTANT_FEATURE_BACKUP_EXCLUDED_KEYS,
  'junluo.assistant.lifeGenerationDiagnostics.v1',
  'junluo.assistant.statePersistenceDiagnostic.v1',
  'junluo.tools.executionAttempts.local.v1',
]);

const DATABASES = [
  { fileName: 'junluo-memory.db', required: true },
  { fileName: 'junluo-schedule.db', required: false, clear: clearScheduleDatabase },
  { fileName: 'junluo-todo.db', required: false, clear: clearTodoDatabase },
  { fileName: 'junluo-expense.db', required: false, clear: clearExpenseDatabase },
  { fileName: 'junluo-focus.db', required: false, clear: clearFocusDatabase },
  { fileName: 'junluo-period.db', required: false, clear: clearPeriodDatabase },
  { fileName: 'junluo-theater.db', required: false, clear: clearTheaterDatabase },
  { fileName: 'junluo-phone-activity.db', required: false, clear: clearPhoneActivityDatabase },
  { fileName: 'junluo-body-signal.db', required: false, clear: clearBodySignalDatabase },
] as const;

const PERSONALITY_STORAGE_KEYS = [
  ...Object.values(JUNLUO_INNER_STATE_KEYS),
  'junluo.autonomy.settings.v1',
  'junluo.proactiveMessage.settings',
  'junluo.baiyunBehavior.intimacySafety',
  'junluo.life.rhythm.state.v1',
  'junluo.life.socialAgent.settings.v1',
  'junluo.life.socialAgent.actionLog.v1',
  'junluo.life.dreamEngine.pendingDreams',
  'junluo.life.dreamEngine.state',
  'junluo.assistant.conversationAfterglowState',
  'junluo.lifeEngine.state',
  'junluo.aiCallBudget.v1',
];

type BackupManifest = {
  formatVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
  missingPostImageIds?: string[];
  missingShiyingImageIds?: string[];
  exportedAt: string;
  excludesApiKeys: boolean;
  excludesSyncState?: boolean;
  backgroundAssetName?: string;
  includedDatabases?: string[];
  includedFiles?: string[];
  coverageNotes?: string[];
  personalityIncluded?: boolean;
  personalityStorageKeys?: string[];
  personalityDatabaseNotes?: string[];
  readingStats?: ReturnType<typeof createReadingBackupStats>;
  secrets?: Record<string, string>;
  storage: Record<string, string>;
  cameraBackupPrivacy?: CameraBackupPrivacyManifest;
};

type PreparedBackup = {
  operationDirectory: string;
  rootDirectory: string;
  databaseDirectory: string;
  manifest: BackupManifest;
  ignoredLegacySecrets: boolean;
  missingDatabases: string[];
  extractedBytes: number;
  postImages: PreparedPostImages;
  giftOriginals: GiftOriginal[];
  shiying?: PreparedShiyingBackup;
  cameraObservationBytes?: Uint8Array;
};

type Snapshot = { id: string; uri: string; size?: number };


const backupMediaSnapshotIo = {
  getInfoAsync: (uri: string) => FileSystem.getInfoAsync(uri),
  readDirectoryAsync: (uri: string) => FileSystem.readDirectoryAsync(uri),
};

function requireDirectories() {
  if (!FileSystem.cacheDirectory || !FileSystem.documentDirectory) {
    throw new Error('当前设备无法访问应用文件目录。');
  }
  return { cacheDirectory: FileSystem.cacheDirectory, documentDirectory: FileSystem.documentDirectory };
}

function operationDirectory(kind: 'export' | 'restore') {
  const { cacheDirectory } = requireDirectories();
  return `${cacheDirectory}junluo-backup-${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}/`;
}

export async function cleanupAndroidBackupTemporaryFiles() {
  return cleanupNativeBackupTemporaryFiles();
}
function extensionFromUri(uri: string) {
  return uri.match(/\.([a-zA-Z0-9]{1,8})(?:\?.*)?$/)?.[1]?.toLowerCase() ?? 'jpg';
}

function safeFileName(value: string) {
  return value.length > 0 && !value.includes('/') && !value.includes('\\') ? value : '';
}

async function readLocalStorage() {
  const keys = (await AsyncStorage.getAllKeys()).filter(
    (key) =>
      key.startsWith(APP_STORAGE_PREFIX) &&
      isOrdinaryBackupStorageKey(key) &&
      !key.startsWith(LEGACY_SECRET_STORAGE_PREFIX) &&
      !shouldExcludeCameraStorageKey(key) &&
      !EXCLUDED_STORAGE_KEYS.has(key),
  );
  const values = await AsyncStorage.multiGet(keys);
  const storage = Object.fromEntries(
    values.filter((entry): entry is [string, string] => entry[1] !== null),
  );
  return prepareWantsPaperBackupStorage(sanitizeRetiredAssistantStorage(storage).storage);
}

async function ensureFreeDiskSpace(requiredBytes: number) {
  const freeBytes = await FileSystem.getFreeDiskStorageAsync();
  if (freeBytes < requiredBytes) {
    throw new BackupDiskSpaceError(`手机至少还需要 ${Math.ceil((requiredBytes - freeBytes) / 1024 / 1024)} MB 可用空间，已经在覆盖数据前停止。`);
  }
}

async function copyDirectoryContents(sourceDirectory: string, targetDirectory: string, onFile?: (relativePath: string) => void, prefix = '') {
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(sourceDirectory);
  } catch {
    return;
  }
  await FileSystem.makeDirectoryAsync(targetDirectory, { intermediates: true });
  for (const name of names) {
    if (!safeFileName(name)) continue;
    const source = `${sourceDirectory}${name}`;
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const info = await FileSystem.getInfoAsync(source);
    if (!info.exists) continue;
    if (info.isDirectory) {
      await copyDirectoryContents(`${source}/`, `${targetDirectory}${name}/`, onFile, relativePath);
    } else {
      await FileSystem.copyAsync({ from: source, to: `${targetDirectory}${name}` });
      onFile?.(relativePath);
    }
  }
}

async function listArchiveFiles(
  directoryUri: string,
  relativePrefix = '',
): Promise<string[]> {
  const names = await FileSystem.readDirectoryAsync(directoryUri);
  const files: string[] = [];
  for (const name of names) {
    if (!safeFileName(name)) {
      throw new BackupFormatError('备份包含无法安全读取的文件名。');
    }
    const relativePath = relativePrefix ? `${relativePrefix}/${name}` : name;
    const uri = `${directoryUri}${name}`;
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) {
      throw new BackupFormatError('备份文件在检查期间消失了。');
    }
    if (info.isDirectory) {
      files.push(...await listArchiveFiles(`${uri}/`, relativePath));
    } else {
      files.push(`${ROOT_FOLDER}/${relativePath}`);
    }
  }
  return files;
}

async function removeExportedDatabaseSidecars(
  databaseDirectory: string,
  fileName: string,
) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await FileSystem.deleteAsync(`${databaseDirectory}${fileName}${suffix}`, {
      idempotent: true,
    });
  }
}

async function copyDirectoryContentsStrict(
  sourceDirectory: string,
  targetDirectory: string,
  onFile?: (relativePath: string) => void,
  validateRelativePath: (relativePath: string) => boolean = () => true,
) {
  return captureBackupMediaDirectoryStrict({
    sourceDirectoryUri: sourceDirectory,
    io: backupMediaSnapshotIo,
    captureFile: async ({ relativePath, sourceUri }) => {
      if (!validateRelativePath(relativePath)) {
        throw new Error(`媒体路径无法安全恢复：${relativePath}`);
      }
      const slash = relativePath.lastIndexOf('/');
      const targetParent = slash >= 0
        ? `${targetDirectory}${relativePath.slice(0, slash + 1)}`
        : targetDirectory;
      await FileSystem.makeDirectoryAsync(targetParent, { intermediates: true });
      await FileSystem.copyAsync({ from: sourceUri, to: `${targetDirectory}${relativePath}` });
      onFile?.(relativePath);
    },
  });
}

async function copyTogetherWalkedFileLevel(
  sourceDirectory: string,
  targetDirectory: string,
  prefix: '' | 'drafts',
  ignoreFileErrors: boolean,
  onFile?: (relativePath: string) => void,
) {
  const names = await listTogetherWalkedBackupDirectory(
    sourceDirectory,
    backupMediaSnapshotIo,
    ignoreFileErrors ? 'best-effort' : 'restore',
  );
  for (const name of names) {
    const relativePath = prefix ? `${prefix}/${name}` : name;
    if (!isSafeTogetherWalkedBackupRelativePath(relativePath)) continue;
    const sourceUri = `${sourceDirectory}${name}`;
    const copyFile = async () => {
      const info = await FileSystem.getInfoAsync(sourceUri);
      if (!info.exists || info.isDirectory) return;
      await FileSystem.makeDirectoryAsync(targetDirectory, { intermediates: true });
      await FileSystem.copyAsync({ from: sourceUri, to: `${targetDirectory}${name}` });
      onFile?.(relativePath);
    };
    if (ignoreFileErrors) {
      await copyFile().catch(() => {
        // A missing or unreadable trip photo should not block a non-strict backup.
      });
    } else {
      await copyFile();
    }
  }
}

type TogetherWalkedDirectoryCopyMode = 'best-effort' | 'restore' | 'strict-snapshot';

async function copyTogetherWalkedDirectoryContents(
  sourceDirectory: string,
  targetDirectory: string,
  onFile?: (relativePath: string) => void,
  mode: TogetherWalkedDirectoryCopyMode = 'restore',
): Promise<void> {
  if (mode === 'strict-snapshot') {
    await copyDirectoryContentsStrict(
      sourceDirectory,
      targetDirectory,
      onFile,
      isSafeTogetherWalkedBackupRelativePath,
    );
    return;
  }
  const ignoreFileErrors = mode === 'best-effort';
  await copyTogetherWalkedFileLevel(sourceDirectory, targetDirectory, '', ignoreFileErrors, onFile);
  await copyTogetherWalkedFileLevel(
    `${sourceDirectory}drafts/`,
    `${targetDirectory}drafts/`,
    'drafts',
    ignoreFileErrors,
    onFile,
  );
}

async function copyReadingFiles(sourceDirectory: string, targetDirectory: string, manifest: BackupManifest) {
  let bookIds: string[];
  try {
    bookIds = await FileSystem.readDirectoryAsync(sourceDirectory);
  } catch {
    return;
  }
  for (const bookId of bookIds) {
    if (!isSafeReadingBackupPathSegment(bookId)) {
      manifest.readingStats!.skippedFileCount += 1;
      continue;
    }
    manifest.readingStats!.bookDirectoryCount += 1;
    await copyReadingDirectory(`${sourceDirectory}${bookId}/`, `${targetDirectory}${bookId}/`, [bookId], manifest);
  }
}

async function copyReadingDirectory(source: string, target: string, parts: string[], manifest: BackupManifest) {
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(source);
  } catch {
    manifest.readingStats!.failedFileCount += 1;
    return;
  }
  for (const name of names) {
    if (!isSafeReadingBackupPathSegment(name)) {
      manifest.readingStats!.skippedFileCount += 1;
      continue;
    }
    const nextParts = [...parts, name];
    const relativePath = joinSafeReadingBackupPath(nextParts);
    if (!relativePath) {
      manifest.readingStats!.skippedFileCount += 1;
      continue;
    }
    const sourceUri = `${source}${name}`;
    try {
      const info = await FileSystem.getInfoAsync(sourceUri);
      if (info.exists && info.isDirectory) {
        await copyReadingDirectory(`${sourceUri}/`, `${target}${name}/`, nextParts, manifest);
      } else if (info.exists) {
        await FileSystem.makeDirectoryAsync(target, { intermediates: true });
        await FileSystem.copyAsync({ from: sourceUri, to: `${target}${name}` });
        manifest.includedFiles!.push(`${ROOT_FOLDER}/files/${READING_FILES_FOLDER}/${relativePath}`);
        manifest.readingStats!.packedFileCount += 1;
      }
    } catch {
      manifest.readingStats!.failedFileCount += 1;
    }
  }
}

function mapNativeError(error: unknown): Error {
  const code = typeof error === 'object' && error ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : '无法读取备份文件。';
  if (code === 'BACKUP_DISK_SPACE') return new BackupDiskSpaceError(message);
  if (code === 'BACKUP_FORMAT' || code === 'BACKUP_EXTRACT_FAILED') return new BackupFormatError(message);
  return error instanceof Error ? error : new Error(message);
}

export async function createAndroidBackupArchive(
  onStage?: BackupStageCallback,
  options: CreateBackupArchiveOptions = {},
): Promise<BackupArchiveResult> {
  const { cacheDirectory, documentDirectory } = requireDirectories();
  const workDirectory = operationDirectory('export');
  const rootDirectory = `${workDirectory}${ROOT_FOLDER}/`;
  const databaseDirectory = `${rootDirectory}db/`;
  const archiveUri = `${cacheDirectory}JunLuo-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  try {
    onStage?.('export-preparing');
    await ensureFreeDiskSpace(MIN_FREE_BYTES);
    await FileSystem.makeDirectoryAsync(databaseDirectory, { intermediates: true });
    await FileSystem.makeDirectoryAsync(`${rootDirectory}assets/`, { intermediates: true });
    await FileSystem.makeDirectoryAsync(`${rootDirectory}files/`, { intermediates: true });
    await FileSystem.makeDirectoryAsync(`${rootDirectory}fonts/`, { intermediates: true });

    const storage = await readLocalStorage();
    const cameraObservationBackup = await prepareCameraObservationBackup({
      includeForRollback: options.includeCameraObservationsForRollback,
    });
    const manifest: BackupManifest = {
      formatVersion: ORDINARY_BACKUP_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      excludesApiKeys: true,
      excludesSyncState: true,
      includedDatabases: [...DATABASES.map(({ fileName }) => `${ROOT_FOLDER}/db/${fileName}`), `${ROOT_FOLDER}/db/${SHIYING_DATABASE_NAME}`],
      includedFiles: [],
      coverageNotes: [
        'This ordinary backup includes JunLuo business data and local media, but excludes secrets and synchronization state.',
        'Together-walked travel records are included through AsyncStorage and their local photo files are stored under JunLuo/files/together-walked when present.',
        'Co-reading records, result action metadata, EPUB/text source files, covers, and extracted reading images are included through AsyncStorage and JunLuo/files/reading/books when present.',
        'Registered tool workspace files are stored under JunLuo/files/tool-file-cache and restored with portable local URIs.',
        'Gift records, echoes and web progress are in junluo-memory.db; referenced originals are included under JunLuo/files/gift-originals and resolved against this device after restore.',
        'Notifications are recreated by the app after restore and are not stored as device notification records.',
        'Camera temporary frames and photos explicitly saved to an external SAF directory are never included. Structured camera observations are included only as a separately consented sensitive payload.',
      ],
      personalityIncluded: true,
      personalityStorageKeys: PERSONALITY_STORAGE_KEYS,
      personalityDatabaseNotes: [
        'JunLuo/db/junluo-memory.db includes StyleMemory, dreams, life diary, whispers, daily impressions, and memory archive data.',
        'JunLuo/db/junluo-todo.db includes todos, habits, goals, goal progress, daily challenges, task execution records, and day/week reviews.',
      ],
      readingStats: createReadingBackupStats(storage),
      storage: { ...storage },
      cameraBackupPrivacy: cameraObservationBackup.manifest,
    };

    if (cameraObservationBackup.bytes) {
      const sensitiveDirectory = `${rootDirectory}sensitive/`;
      await FileSystem.makeDirectoryAsync(sensitiveDirectory, { intermediates: true });
      const sensitiveFile = new File(`${workDirectory}${CAMERA_OBSERVATION_ARCHIVE_PATH}`);
      sensitiveFile.create({ intermediates: true, overwrite: true });
      sensitiveFile.write(cameraObservationBackup.bytes);
    }

    onStage?.('exporting-databases');
    await syncNativePhoneActivityLogs(0, 500).catch(() => undefined);
    manifest.missingPostImageIds = await capturePostBackup(manifest.storage, options, async () => {
      await backupDatabaseToDirectory('junluo-memory.db', databaseDirectory);
      return openDatabaseImportSource({ directory: databaseDirectory, fileName: 'junluo-memory.db' });
    }, async (image, uri) => {
      const directory = `${rootDirectory}files/post-images/`;
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
      const target = `${directory}${image.id}.jpg`;
      await FileSystem.copyAsync({ from: uri, to: target });
      const info = await FileSystem.getInfoAsync(target);
      if (!info.exists || info.isDirectory || info.size !== image.byte_size) throw new Error('动态图片复制验货失败。');
      manifest.includedFiles!.push(`${POST_BACKUP_PREFIX}${image.id}.jpg`);
    });
    for (const { fileName } of DATABASES) {
      if (fileName !== 'junluo-memory.db') await backupDatabaseToDirectory(fileName, databaseDirectory);
      try {
        await validateNativeDatabase(databaseDirectory + fileName);
      } catch (error) {
        const detail = error instanceof Error ? error.message : '未知错误';
        throw new BackupDatabaseValidationError(fileName + ' 没有通过导出数据库验货：' + detail);
      }
      await removeExportedDatabaseSidecars(databaseDirectory, fileName);
    }
    manifest.missingShiyingImageIds = await captureShiyingBackup(databaseDirectory, rootDirectory, options, manifest.includedFiles!);
    await removeExportedDatabaseSidecars(databaseDirectory, SHIYING_DATABASE_NAME);

    onStage?.('exporting-files');
    const giftDb = await openDatabaseImportSource({ directory: databaseDirectory, fileName: 'junluo-memory.db' });
    try {
      await captureGiftBackupOriginals(await readGiftBackupOriginals(giftDb), async (original, from) => {
        const path = `${GIFT_ORIGINALS_BACKUP_PREFIX}${original.storageName}`;
        const to = `${workDirectory}${path}`;
        await FileSystem.makeDirectoryAsync(`${rootDirectory}files/gift-originals/`, { intermediates: true });
        await FileSystem.copyAsync({ from, to });
        const info = await FileSystem.getInfoAsync(to);
        manifest.includedFiles!.push(path);
        return info.exists && !info.isDirectory ? info.size : -1;
      });
    } finally { await giftDb.closeAsync(); }
    const backgroundRaw = storage[BACKGROUND_SETTINGS_KEY];
    if (backgroundRaw) {
      try {
        const background = JSON.parse(backgroundRaw) as { imageUri?: string };
        if (background.imageUri) {
          const backgroundAssetName = `custom-background.${extensionFromUri(background.imageUri)}`;
          if (options.strictMediaSnapshot) {
            await captureBackupMediaFileStrict({
              sourceUri: background.imageUri,
              relativePath: `assets/${backgroundAssetName}`,
              io: backupMediaSnapshotIo,
              captureFile: ({ sourceUri }) => FileSystem.copyAsync({
                from: sourceUri,
                to: `${rootDirectory}assets/${backgroundAssetName}`,
              }),
            });
          } else {
            await FileSystem.copyAsync({ from: background.imageUri, to: `${rootDirectory}assets/${backgroundAssetName}` });
          }
          manifest.backgroundAssetName = backgroundAssetName;
          manifest.includedFiles!.push(`${ROOT_FOLDER}/assets/${backgroundAssetName}`);
          manifest.storage[BACKGROUND_SETTINGS_KEY] = JSON.stringify({
            ...background,
            imageUri: `${ROOT_FOLDER}/assets/${backgroundAssetName}`,
          });
        }
      } catch (error) {
        if (options.strictMediaSnapshot) throw error;
        // A missing custom image should not block the rest of the backup.
      }
    }
    const copyMediaDirectory = options.strictMediaSnapshot
      ? copyDirectoryContentsStrict
      : copyDirectoryContents;
    await copyMediaDirectory(
      `${documentDirectory}${VOICE_MESSAGES_FOLDER}/`,
      `${rootDirectory}files/${VOICE_MESSAGES_FOLDER}/`,
      (path) => manifest.includedFiles!.push(`${ROOT_FOLDER}/files/${VOICE_MESSAGES_FOLDER}/${path}`),
    );
    const stickerSourceDirectory = `${documentDirectory}${BAIYUN_STICKER_FOLDER}/`;
    const stickerTargetDirectory = `${rootDirectory}files/${BAIYUN_STICKER_FOLDER}/`;
    const onStickerFile = (path: string) =>
      manifest.includedFiles!.push(`${ROOT_FOLDER}/files/${BAIYUN_STICKER_FOLDER}/${path}`);
    if (options.strictMediaSnapshot) {
      await copyDirectoryContentsStrict(
        stickerSourceDirectory,
        stickerTargetDirectory,
        onStickerFile,
        isSafeBaiyunStickerBackupRelativePath,
      );
    } else {
      await copyDirectoryContents(stickerSourceDirectory, stickerTargetDirectory, onStickerFile);
    }
    await copyTogetherWalkedDirectoryContents(
      `${documentDirectory}${TOGETHER_WALKED_IMAGE_FOLDER}/`,
      `${rootDirectory}files/${TOGETHER_WALKED_IMAGE_FOLDER}/`,
      (path) => manifest.includedFiles!.push(`${ROOT_FOLDER}/files/${TOGETHER_WALKED_IMAGE_FOLDER}/${path}`),
      options.strictMediaSnapshot ? 'strict-snapshot' : 'best-effort',
    );
    if (options.strictMediaSnapshot) {
      const result = await copyDirectoryContentsStrict(
        `${documentDirectory}${READING_FILES_FOLDER}/`,
        `${rootDirectory}files/${READING_FILES_FOLDER}/`,
        (path) => {
          manifest.includedFiles!.push(`${ROOT_FOLDER}/files/${READING_FILES_FOLDER}/${path}`);
          manifest.readingStats!.packedFileCount += 1;
        },
      );
      manifest.readingStats!.bookDirectoryCount += new Set(
        result.relativePaths.map((relativePath) => relativePath.split('/')[0]),
      ).size;
    } else {
      await copyReadingFiles(
        `${documentDirectory}${READING_FILES_FOLDER}/`,
        `${rootDirectory}files/${READING_FILES_FOLDER}/`,
        manifest,
      );
    }
    const toolWorkspaceSource =
      `${documentDirectory}${TOOL_WORKSPACE_FILE_FOLDER}/`;
    const toolWorkspaceTarget =
      `${rootDirectory}files/${TOOL_WORKSPACE_FILE_FOLDER}/`;
    const onToolWorkspaceFile = (path: string) =>
      manifest.includedFiles!.push(
        `${ROOT_FOLDER}/files/${TOOL_WORKSPACE_FILE_FOLDER}/${path}`,
      );
    if (options.strictMediaSnapshot) {
      await copyDirectoryContentsStrict(
        toolWorkspaceSource,
        toolWorkspaceTarget,
        onToolWorkspaceFile,
        isSafeToolWorkspaceBackupFileName,
      );
    } else {
      await copyDirectoryContents(
        toolWorkspaceSource,
        toolWorkspaceTarget,
        onToolWorkspaceFile,
      );
    }
    await writeStringFileSafely(`${rootDirectory}config.json`, JSON.stringify(manifest, null, 2));
    validateOrdinaryBackupArchiveFiles(
      manifest,
      await listArchiveFiles(rootDirectory),
    );

    onStage?.('creating-archive');
    await createNativeArchive(workDirectory, archiveUri);
    return { uri: archiveUri, missingPostImageIds: manifest.missingPostImageIds, missingShiyingImageIds: manifest.missingShiyingImageIds };
  } catch (error) {
    await FileSystem.deleteAsync(archiveUri, { idempotent: true }).catch(() => undefined);
    throw mapNativeError(error);
  } finally {
    await FileSystem.deleteAsync(workDirectory, { idempotent: true }).catch(() => undefined);
  }
}

async function prepareBackup(archiveUri: string, onStage?: BackupStageCallback, reuseLocal = true): Promise<PreparedBackup> {
  onStage?.('validating-archive');
  const workDirectory = operationDirectory('restore');
  try {
    let extractResult: Awaited<ReturnType<typeof extractNativeArchive>>;
    try {
      extractResult = await extractNativeArchive(archiveUri, workDirectory);
    } catch (error) {
      throw mapNativeError(error);
    }
    const rootDirectory = `${workDirectory}${ROOT_FOLDER}/`;
    const databaseDirectory = `${rootDirectory}db/`;
    const configInfo = await FileSystem.getInfoAsync(`${rootDirectory}config.json`);
    const memoryInfo = await FileSystem.getInfoAsync(`${databaseDirectory}junluo-memory.db`);
    if (!configInfo.exists || configInfo.isDirectory || !memoryInfo.exists || memoryInfo.isDirectory) {
      throw new BackupFormatError();
    }
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(await FileSystem.readAsStringAsync(rootDirectory + 'config.json'));
    } catch {
      throw new BackupFormatError('备份里的 config.json 已损坏，已经停止还原。');
    }
    const manifest = validateBackupManifest(rawManifest) as BackupManifest;
    const archiveFilePaths = await listArchiveFiles(rootDirectory);
    validateOrdinaryBackupArchiveFiles(
      manifest,
      archiveFilePaths,
    );
    const ignoredLegacySecrets = manifest.formatVersion <= 11
      && Object.keys(manifest.secrets ?? {}).length > 0;
    const cameraObservationManifest = manifest.cameraBackupPrivacy?.structuredObservations;
    const cameraObservationUri = `${workDirectory}${CAMERA_OBSERVATION_ARCHIVE_PATH}`;
    const cameraObservationInfo = await FileSystem.getInfoAsync(cameraObservationUri);
    let cameraObservationBytes: Uint8Array | undefined;
    if (cameraObservationManifest?.included) {
      if (!cameraObservationInfo.exists || cameraObservationInfo.isDirectory || !manifest.cameraBackupPrivacy) {
        throw new BackupFormatError('备份声称包含结构化摄像头观察，但敏感负载缺失，已经停止还原。');
      }
      try {
        cameraObservationBytes = await new File(cameraObservationUri).bytes();
        await validateCameraObservationBackupPayload(manifest.cameraBackupPrivacy, cameraObservationBytes);
      } catch {
        throw new BackupFormatError('结构化摄像头观察敏感负载未通过完整性校验，已经停止还原。');
      }
    } else if (cameraObservationInfo.exists) {
      throw new BackupFormatError('备份包含未在清单中声明的摄像头观察负载，已经停止还原。');
    }
    onStage?.('validating-databases');
    const existingDatabaseNames: string[] = [];
    for (const database of DATABASES) {
      const info = await FileSystem.getInfoAsync(databaseDirectory + database.fileName);
      if (!info.exists || info.isDirectory) continue;
      existingDatabaseNames.push(database.fileName);
      try {
        await validateNativeDatabase(databaseDirectory + database.fileName);
        if (database.fileName === 'junluo-theater.db') {
          await prepareTheaterBackupFile({ directory: databaseDirectory, fileName: database.fileName });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : '未知错误';
        throw new BackupDatabaseValidationError(database.fileName + ' 没有通过数据库验货：' + detail);
      }
    }
    let shiying: PreparedShiyingBackup | undefined;
    if (manifest.formatVersion >= 14) {
      const info = await FileSystem.getInfoAsync(databaseDirectory + SHIYING_DATABASE_NAME);
      if (!info.exists || info.isDirectory) throw new BackupFormatError('备份缺少拾荧数据库，已经停止还原。');
      shiying = await prepareShiyingBackup(databaseDirectory, rootDirectory, manifest.missingShiyingImageIds);
      existingDatabaseNames.push(SHIYING_DATABASE_NAME);
    }
    const missingDatabases = findMissingBackupDatabases(existingDatabaseNames, manifest.formatVersion);
    const postDb = await openDatabaseImportSource({ directory: databaseDirectory, fileName: 'junluo-memory.db' });
    let postImages: PreparedPostImages;
    let giftOriginals: GiftOriginal[];
    try {
      giftOriginals = await readGiftBackupOriginals(postDb);
      await validateGiftBackupOriginals(giftOriginals, archiveFilePaths, async original => {
        const info = await FileSystem.getInfoAsync(`${workDirectory}${GIFT_ORIGINALS_BACKUP_PREFIX}${original.storageName}`);
        return info.exists && !info.isDirectory ? info.size : -1;
      });
      manifest.storage = await prepareRestoredPostStorage(manifest.storage, postDb);
      postImages = await preparePostBackupImages({
        db: postDb, formatVersion: manifest.formatVersion, missingPostImageIds: manifest.missingPostImageIds,
        directory: `${workDirectory}prepared-post-images/`, reuseLocal,
        readArchiveImage: async (image, target) => {
          const from = `${rootDirectory}files/post-images/${image.id}.jpg`;
          const info = await FileSystem.getInfoAsync(from);
          if (!info.exists) return false;
          if (info.isDirectory) throw new Error('动态图片路径是目录。');
          await FileSystem.copyAsync({ from, to: target }); return true;
        },
      });
    } finally { await postDb.closeAsync(); }
    return {
      operationDirectory: workDirectory,
      rootDirectory,
      databaseDirectory,
      manifest,
      ignoredLegacySecrets,
      missingDatabases,
      extractedBytes: extractResult.totalBytes ?? 0,
      postImages,
      giftOriginals,
      shiying,
      cameraObservationBytes,
    };
  } catch (error) {
    await FileSystem.deleteAsync(workDirectory, { idempotent: true }).catch(() => undefined);
    throw error;
  }
}

function rewriteVoiceMessageUri(value: unknown, voiceDirectory: string) {
  if (!value || typeof value !== 'object') return false;
  const message = value as { voice?: { uri?: unknown } };
  const uri = message.voice?.uri;
  if (typeof uri !== 'string') return false;
  const marker = `${VOICE_MESSAGES_FOLDER}/`;
  const markerIndex = uri.lastIndexOf(marker);
  const rawFileName = markerIndex >= 0 ? uri.slice(markerIndex + marker.length) : uri.split('/').pop() ?? '';
  const fileName = safeFileName(rawFileName.split(/[?#]/)[0] ?? '');
  if (!fileName) return false;
  const nextUri = `${voiceDirectory}${fileName}`;
  if (uri === nextUri) return false;
  message.voice!.uri = nextUri;
  return true;
}

function rewriteVoiceUris(serialized: string, voiceDirectory: string) {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (Array.isArray(parsed)) {
      let changed = false;
      for (const item of parsed) changed = rewriteVoiceMessageUri(item, voiceDirectory) || changed;
      return changed ? JSON.stringify(parsed) : serialized;
    }
    return rewriteVoiceMessageUri(parsed, voiceDirectory) ? JSON.stringify(parsed) : serialized;
  } catch {
    return serialized;
  }
}

function rewriteRestoredVoiceUris(storage: Record<string, string>, voiceDirectory: string) {
  const result = { ...storage };
  for (const [key, value] of Object.entries(result)) {
    if (
      key === CHAT_MESSAGES_KEY ||
      key.startsWith(CHAT_SESSION_MESSAGES_PREFIX) ||
      key.startsWith(CHAT_SESSION_MESSAGE_PREFIX)
    ) {
      result[key] = rewriteVoiceUris(value, voiceDirectory);
    }
  }
  return result;
}

function rewriteTogetherWalkedEntryUris(serialized: string | undefined, imageDirectory: string) {
  if (!serialized) return serialized;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed)) return serialized;
    let changed = false;
    const entries = parsed.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const entry = item as TogetherWalkedEntry;
      if (typeof entry.imageUri !== 'string') return entry;
      const nextUri = rewriteManagedTogetherWalkedImageUri(
        entry.imageUri,
        imageDirectory,
        TOGETHER_WALKED_IMAGE_FOLDER,
        'entry',
      );
      if (nextUri === entry.imageUri) return entry;
      changed = true;
      return { ...entry, imageUri: nextUri };
    });
    return changed ? JSON.stringify(entries) : serialized;
  } catch {
    return serialized;
  }
}

function rewriteTogetherWalkedDraftUri(serialized: string | undefined, imageDirectory: string) {
  if (!serialized) return serialized;
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return serialized;
    const draft = parsed as { imageUri?: unknown };
    if (typeof draft.imageUri !== 'string') return serialized;
    const nextUri = rewriteManagedTogetherWalkedImageUri(
      draft.imageUri,
      imageDirectory,
      TOGETHER_WALKED_IMAGE_FOLDER,
      'draft',
    );
    return nextUri === draft.imageUri ? serialized : JSON.stringify({ ...draft, imageUri: nextUri });
  } catch {
    return serialized;
  }
}

function rewriteTogetherWalkedUris(storage: Record<string, string>, imageDirectory: string) {
  const entries = rewriteTogetherWalkedEntryUris(storage[TOGETHER_WALKED_STORAGE_KEY], imageDirectory);
  const draft = rewriteTogetherWalkedDraftUri(storage[TOGETHER_WALKED_DRAFT_STORAGE_KEY], imageDirectory);
  if (
    entries === storage[TOGETHER_WALKED_STORAGE_KEY]
    && draft === storage[TOGETHER_WALKED_DRAFT_STORAGE_KEY]
  ) return storage;
  const result = { ...storage };
  if (entries !== undefined) result[TOGETHER_WALKED_STORAGE_KEY] = entries;
  if (draft !== undefined) result[TOGETHER_WALKED_DRAFT_STORAGE_KEY] = draft;
  return result;
}

async function applyPreparedBackup(
  prepared: PreparedBackup,
  options: {
    cameraObservations?: 'replace' | 'preserve_local';
    clearCameraObservationsWhenMissing?: boolean;
    shiyingLocalState?: PreparedShiyingBackup['localState'];
  } = {},
) {
  await AsyncStorage.removeItem(CHAT_REPLY_DRAFT_KEY);
  await AsyncStorage.removeItem(SLEEP_REPLY_DRAFT_KEY);
  const { documentDirectory } = requireDirectories();
  const { manifest, rootDirectory, databaseDirectory } = prepared;
  const restoredStorage = sanitizeRetiredAssistantStorage(
    sanitizeOrdinaryBackupStorage(manifest.storage),
  ).storage;
  const backgroundDirectory = `${documentDirectory}backgrounds/`;
  let restoredBackgroundUri: string | undefined;
  console.info('[backup-restore] media apply started', { kind: 'background' });
  await restoreDirectorySafely(backgroundDirectory, async (stagingDirectory) => {
    const assetName = manifest.backgroundAssetName ? safeFileName(manifest.backgroundAssetName) : '';
    if (!assetName) return;
    const source = `${rootDirectory}assets/${assetName}`;
    const info = await FileSystem.getInfoAsync(source);
    if (!info.exists || info.isDirectory) return;
    await FileSystem.copyAsync({ from: source, to: `${stagingDirectory}${assetName}` });
    restoredBackgroundUri = `${backgroundDirectory}${assetName}`;
  });
  console.info('[backup-restore] media apply completed', { kind: 'background' });
  if (restoredBackgroundUri) {
    try {
      const background = JSON.parse(restoredStorage[BACKGROUND_SETTINGS_KEY] ?? '{}') as object;
      restoredStorage[BACKGROUND_SETTINGS_KEY] = JSON.stringify({ ...background, imageUri: restoredBackgroundUri });
    } catch {
      // Other restored data remains usable when old background settings are malformed.
    }
  }

  const voiceDirectory = `${documentDirectory}${VOICE_MESSAGES_FOLDER}/`;
  const stickerDirectory = `${documentDirectory}${BAIYUN_STICKER_FOLDER}/`;
  const togetherWalkedDirectory = `${documentDirectory}${TOGETHER_WALKED_IMAGE_FOLDER}/`;
  console.info('[backup-restore] media apply started', { kind: 'voice' });
  await restoreDirectorySafely(voiceDirectory, (staging) => copyDirectoryContents(`${rootDirectory}files/${VOICE_MESSAGES_FOLDER}/`, staging));
  console.info('[backup-restore] media apply completed', { kind: 'voice' });
  console.info('[backup-restore] media apply started', { kind: 'baiyun-stickers' });
  await restoreDirectorySafely(stickerDirectory, (staging) => copyDirectoryContents(`${rootDirectory}files/${BAIYUN_STICKER_FOLDER}/`, staging));
  console.info('[backup-restore] media apply completed', { kind: 'baiyun-stickers' });
  console.info('[backup-restore] media apply started', { kind: 'together-walked' });
  await restoreDirectorySafely(
    togetherWalkedDirectory,
    (staging) => copyTogetherWalkedDirectoryContents(
      `${rootDirectory}files/${TOGETHER_WALKED_IMAGE_FOLDER}/`,
      staging,
    ),
  );
  console.info('[backup-restore] media apply completed', { kind: 'together-walked' });
  console.info('[backup-restore] media apply started', { kind: 'reading' });
  await restoreDirectorySafely(`${documentDirectory}${READING_FILES_FOLDER}/`, (staging) => copyDirectoryContents(`${rootDirectory}files/${READING_FILES_FOLDER}/`, staging));
  console.info('[backup-restore] media apply completed', { kind: 'reading' });
  console.info('[backup-restore] media apply started', { kind: 'tools-workspace' });
  await restoreDirectorySafely(
    `${documentDirectory}${TOOL_WORKSPACE_FILE_FOLDER}/`,
    (staging) => copyDirectoryContents(
      `${rootDirectory}files/${TOOL_WORKSPACE_FILE_FOLDER}/`,
      staging,
    ),
  );
  console.info('[backup-restore] media apply completed', { kind: 'tools-workspace' });
  await restorePostBackupImages(prepared.postImages);
  await restoreGiftBackupOriginals(prepared.giftOriginals, (original, to) => FileSystem.copyAsync({
    from: `${prepared.operationDirectory}${GIFT_ORIGINALS_BACKUP_PREFIX}${original.storageName}`, to,
  }));

  for (const database of DATABASES) {
    const missing = prepared.missingDatabases.includes(`${ROOT_FOLDER}/db/${database.fileName}`);
    console.info('[backup-restore] database apply started', {
      fileName: database.fileName,
      mode: missing ? 'clear' : 'restore',
    });
    if (missing) {
      if ('clear' in database) await database.clear();
    } else {
      await restoreDatabaseFromDisk(
        { directory: databaseDirectory, fileName: database.fileName },
        database.fileName,
      );
    }
    console.info('[backup-restore] database apply completed', { fileName: database.fileName });
  }
  // Older formats deliberately leave the independent 拾荧 database untouched.
  if (prepared.shiying) await restoreShiyingBackup(prepared.shiying, options.shiyingLocalState);
  if (prepared.cameraObservationBytes && options.cameraObservations === 'replace') {
    await restoreCameraObservationBackup(prepared.cameraObservationBytes);
  } else if (!prepared.cameraObservationBytes && options.clearCameraObservationsWhenMissing) {
    await clearCameraObservationBackup();
  }

  const currentStorage = await readLocalStorage();
  const rewrittenStorage = rewriteRestoredToolWorkspaceFileUris(
    rewriteRestoredBaiyunStickerUris(
      rewriteTogetherWalkedUris(
        rewriteRestoredVoiceUris(restoredStorage, voiceDirectory),
        togetherWalkedDirectory,
      ),
      stickerDirectory,
    ),
    documentDirectory,
  );
  const normalizedStorage = prepareWantsPaperBackupStorage(prepareJunluoInnerStateRestoreStorage(
    currentStorage,
    rewrittenStorage,
  ));
  console.info('[backup-restore] storage apply started', {
    currentEntryCount: Object.keys(currentStorage).length,
    restoredEntryCount: Object.keys(normalizedStorage).length,
  });
  const storageResult = await replaceBackupStorageSafely(
    AsyncStorage,
    currentStorage,
    normalizedStorage,
  );
  await purgeRetiredAssistantBusinessData();
  const careCleanup = await import('../ai/behavior/chatCareCleanup');
  await careCleanup.clearCareRecords(
    await (await import('../memory/memoryStore')).getMemoryDatabase('continuity'), careCleanup.restoredCareCleanupScope(rewrittenStorage),
  );
  console.info('[backup-restore] storage apply completed', storageResult);
  await migrateReadingStorageIfNeeded().then(() => repairReadingBookFiles()).catch(() => undefined);
  await reconcileRestoredNotificationState();
  await resetAutomaticRemoteAiPolicyAfterRestore();
  await resetAutomaticDataSyncPolicy();
}

export async function restoreAndroidBackupSnapshotWithoutSnapshot(archiveUri: string, onStage?: BackupStageCallback) {
  pauseFastRefreshForBackupRestore();
  const prepared = await prepareBackup(archiveUri, onStage, false);
  try {
    await ensureFreeDiskSpace(prepared.extractedBytes + MIN_FREE_BYTES);
    if (!await quiescePhoneActivityCollectorForRestore()) {
      throw new PreImportBackupSnapshotError('本机手机活动采集器无法安全暂停，已经在覆盖数据前停止还原。请覆盖安装最新开发版后重试。');
    }
    if (!await discardNativePhoneActivityLogsForRestore()) {
      throw new Error('未能清理受恢复 journal 保护的手机活动 staging，自动恢复已经停止。');
    }
    onStage?.('restoring');
    await applyPreparedBackup(prepared, {
      cameraObservations: 'replace',
      clearCameraObservationsWhenMissing: true,
    });
    return prepared;
  } finally {
    await FileSystem.deleteAsync(prepared.operationDirectory, { idempotent: true }).catch(() => undefined);
  }
}

export async function restoreAndroidBackupArchive(
  archiveUri: string,
  createSnapshot: () => Promise<Snapshot>,
  options: RestoreBackupOptions = {},
): Promise<RestoreBackupResult> {
  const resumeFastRefresh = pauseFastRefreshForBackupRestore();
  let keepFastRefreshPaused = false;
  let prepared: PreparedBackup | undefined;
  let snapshot: Snapshot;
  let rollbackPrepared: PreparedBackup | undefined;
  let collectorQuiesced = false;
  let journalProtectedApplyEntered = false;
  try {
    prepared = await prepareBackup(archiveUri, options.onStage);
    const restorePrepared = prepared;
    acceptPostMissing(prepared.postImages.missing, options.acceptedMissingPostImageIds, 'restore');
    if (prepared.shiying) acceptShiyingMissing(prepared.shiying.missing, options.acceptedMissingShiyingImageIds, 'restore');
    if (restorePrepared.ignoredLegacySecrets && !options.acceptIgnoredLegacySecrets) {
      throw new LegacyBackupSecretsIgnoredNoticeRequiredError();
    }
    if (restorePrepared.cameraObservationBytes && !options.cameraObservations) {
      throw new CameraObservationRestoreChoiceRequiredError(
        restorePrepared.manifest.cameraBackupPrivacy?.structuredObservations.recordCount ?? 0,
      );
    }
    if (!await quiescePhoneActivityCollectorForRestore()) {
      throw new PreImportBackupSnapshotError('本机手机活动采集器无法安全暂停，已经在覆盖数据前停止还原。请覆盖安装最新开发版后重试。');
    }
    collectorQuiesced = true;
    try {
      await drainNativePhoneActivityLogsForRestore();
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误';
      throw new PreImportBackupSnapshotError(`手机活动 staging 未能完整同步到导入前快照，已经停止还原且没有清理 staging。原因：${detail}`);
    }
    options.onStage?.('creating-snapshot');
    try {
      snapshot = await createSnapshot();
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误';
      throw new PreImportBackupSnapshotError(`导入前快照生成失败。为了保护当前数据，已经停止还原。原因：${detail}`);
    }
    try {
      rollbackPrepared = await prepareBackup(snapshot.uri, undefined, false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误';
      throw new PreImportBackupSnapshotError(`导入前快照没有通过恢复预检。为了保护当前数据，已经停止还原。原因：${detail}`);
    }
    await ensureFreeDiskSpace(Math.max(restorePrepared.extractedBytes, rollbackPrepared.extractedBytes) + MIN_FREE_BYTES);
    options.onStage?.('restoring');
    await runRestoreCommitWithRollback({
      beforeApply: async () => {
        await beginBackupRestoreSyncGate(snapshot.id);
      },
      apply: async () => {
        journalProtectedApplyEntered = true;
        keepFastRefreshPaused = true;
        if (!await discardNativePhoneActivityLogsForRestore()) {
          throw new Error('未能清理手机活动 staging，已在覆盖正式数据前停止还原。');
        }
        await applyPreparedBackup(restorePrepared, {
          cameraObservations: options.cameraObservations,
          shiyingLocalState: rollbackPrepared?.shiying?.localState,
        });
      },
      afterApply: async () => {
        await markBackupRestoreSyncRebuildRequired(snapshot.id);
      },
      rollback: async () => {
        options.onStage?.('rolling-back');
        if (!rollbackPrepared) throw new Error('导入前快照尚未通过恢复预检。');
        await applyPreparedBackup(rollbackPrepared, {
          cameraObservations: 'replace',
          clearCameraObservationsWhenMissing: true,
        });
      },
      afterRollback: () => clearBackupRestoreSyncGate(snapshot.id),
      snapshotUri: snapshot.uri,
      journal: createBackupRestoreJournalLifecycle(snapshot.id),
    });
    return {
      preImportSnapshotCreated: true,
      preImportSnapshotUri: snapshot.uri,
      manifestVersion: restorePrepared.manifest.formatVersion,
      ignoredLegacySecrets: restorePrepared.ignoredLegacySecrets,
      syncRebuildRequired: true,
      missingDatabases: restorePrepared.missingDatabases,
      missingPostImageIds: restorePrepared.postImages.missing,
      missingShiyingImageIds: restorePrepared.shiying?.missing.map(image => image.imageId) ?? [],
      cameraObservations: restorePrepared.cameraObservationBytes
        ? options.cameraObservations === 'replace' ? 'replaced' : 'preserved_local'
        : 'not_in_backup',
    };
  } catch (error) {
    if (collectorQuiesced && !journalProtectedApplyEntered) {
      const resumed = await resumePhoneActivityCollectorAfterRestore();
      if (!resumed) {
        const detail = error instanceof Error ? error.message : '未知错误';
        throw new PreImportBackupSnapshotError(`还原预检失败，且手机活动采集器未能恢复运行。请重启君落后再试。原始原因：${detail}`);
      }
    }
    throw error;
  } finally {
    if (!keepFastRefreshPaused) resumeFastRefresh();
    if (prepared) {
      await FileSystem.deleteAsync(prepared.operationDirectory, { idempotent: true }).catch(() => undefined);
    }
    if (rollbackPrepared) {
      await FileSystem.deleteAsync(rollbackPrepared.operationDirectory, { idempotent: true }).catch(() => undefined);
    }
    await cleanupNativeBackupTemporaryFiles().catch(() => undefined);
  }
}
