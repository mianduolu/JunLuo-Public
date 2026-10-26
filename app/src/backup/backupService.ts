import AsyncStorage from '@react-native-async-storage/async-storage';
import { CHAT_REPLY_DRAFT_KEY } from '../chat/chatReplyDraft';
import { SLEEP_REPLY_DRAFT_KEY } from '../life/sleepPlanPolicy';
import * as FileSystem from 'expo-file-system/legacy';
import JSZip from 'jszip';
import { Platform } from 'react-native';

import {
  clearBodySignalDatabase,
  exportBodySignalDatabase,
  importBodySignalDatabase,
} from '../bodySignal/bodySignalStore';
import {
  exportMemoryDatabase,
  importMemoryDatabase,
} from '../memory/memoryStore';
import { clearExpenseDatabase, exportExpenseDatabase, importExpenseDatabase } from '../expense/expenseStore';
import { clearFocusDatabase, exportFocusDatabase, importFocusDatabase } from '../focus/focusStore';
import { clearPeriodDatabase, exportPeriodDatabase, importPeriodDatabase } from '../period/periodStore';
import { clearPhoneActivityDatabase, exportPhoneActivityDatabase, importPhoneActivityDatabase } from '../phoneActivity/phoneActivityStore';
import { clearScheduleDatabase, exportScheduleDatabase, importScheduleDatabase } from '../schedule/scheduleStore';
import { clearTodoDatabase, exportTodoDatabase, importTodoDatabase } from '../schedule/todoDatabaseBackup';
import { clearTheaterDatabase, exportTheaterDatabase, importTheaterDatabase } from '../theater/theaterStore';
import { prepareTheaterBackupBytes } from '../theater/theaterStoryBackup';
import {
  LEGACY_SECRET_STORAGE_PREFIX,
  migrateLegacySecretStorage,
} from '../storage/secretStore';
import { copyFileSafely, restoreDirectorySafely, writeStringFileSafely } from '../storage/safeFileWrite';
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
  TOGETHER_WALKED_DRAFT_STORAGE_KEY,
  TOGETHER_WALKED_IMAGE_FOLDER,
  TOGETHER_WALKED_STORAGE_KEY,
  type TogetherWalkedEntry,
} from '../memory/togetherWalkedStore';
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
import {
  cleanupAndroidBackupTemporaryFiles,
  createAndroidBackupArchive,
  restoreAndroidBackupArchive,
  restoreAndroidBackupSnapshotWithoutSnapshot,
} from './androidBackupService';
import { canUseNativeBackupArchive, reloadJunLuoApplication } from './backupArchiveNative';
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
import { assertGiftBackupByteSize, captureGiftBackupOriginals, readGiftBackupOriginals,
  restoreGiftBackupOriginals, validateGiftBackupOriginals, GIFT_ORIGINALS_BACKUP_PREFIX } from './giftBackupPaths';
import type { GiftOriginal } from '../gifts/giftTypes';
import { prepareWantsPaperBackupStorage, replaceBackupStorageSafely } from './backupStorageRestore';
import {
  beginBackupRestoreSyncGate,
  clearBackupRestoreSyncGate,
  markBackupRestoreSyncRebuildRequired,
} from './backupRestoreSyncGate';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  getBackupRestoreRuntimeState,
  markBackupRestoreRecoveryBlocked,
  markBackupRestoreRestoring,
  markBackupRestoreRestartRequired,
  markBackupRestoreRuntimeReady,
  runBackupRestoreExclusive,
  runBackupRestoreRecoverySingleFlight,
  runBackupRestoreShared,
} from './backupRestoreCoordinator';
import { runRestoreCommitWithRollback } from './backupRestoreOrchestrator';
import {
  clearBackupRestoreJournal,
  createBackupRestoreJournalLifecycle,
  readBackupRestoreJournal,
  resolveBackupRestoreJournalSnapshotUri,
} from './backupRestoreJournalStore';
import {
  isPreImportSnapshotFileName,
  PRE_IMPORT_SNAPSHOT_FOLDER,
  PRE_IMPORT_SNAPSHOT_PREFIX,
  PRE_IMPORT_SNAPSHOT_SUFFIX,
} from './backupRestoreJournalState';
import {
  validateLegacyArchiveEntries,
  validateLegacyArchiveFileSize,
} from './legacyBackupValidation';
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
import {
  createReadingBackupStats,
  isSafeReadingBackupPathSegment,
  joinSafeReadingBackupPath,
  splitSafeReadingBackupPath,
  type ReadingBackupStats,
} from './readingBackupPaths';
import { validateDatabaseFile, openDatabaseImportSource } from './sqliteBackupFiles';
import { capturePostBackup, preparePostBackupImages, restorePostBackupImages, prepareRestoredPostStorage,
  acceptPostMissing, POST_BACKUP_PREFIX } from './postBackup';
import type { BackupArchiveResult, CreateBackupArchiveOptions } from './backupTypes';
import { reconcileRestoredNotificationState } from './restoreNotificationState';
import { flushShiyingBeforeBackup, invalidateShiyingForRestore, withShiyingRecordBackupBarrier } from '../shiying/shiyingBackupRuntime';
import { captureShiyingBackup, prepareShiyingBackup, restoreShiyingBackup, acceptShiyingMissing, readShiyingBackupLocalState,
  type PreparedShiyingBackup } from '../shiying/shiyingBackup';
import { SHIYING_DATABASE_NAME } from '../shiying/shiyingDatabase';
import {
  isSafeTogetherWalkedBackupRelativePath,
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

const ROOT_FOLDER = 'JunLuo';
const BACKGROUND_SETTINGS_KEY = 'junluo.backgroundSettings';
const CHAT_MESSAGES_KEY = 'junluo.chat.primaryMessages';
const CHAT_SESSION_MESSAGES_PREFIX = 'junluo.chat.sessionMessages.';
const CHAT_SESSION_MESSAGE_PREFIX = 'junluo.chat.sessionMessage.';
const VOICE_MESSAGES_FOLDER = 'voice-messages';
const READING_FILES_FOLDER = 'reading/books';
const DEFAULT_PRE_IMPORT_SNAPSHOT_LIMIT = 1;
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

type BackupManifest = {
  formatVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
  missingShiyingImageIds?: string[];
  missingPostImageIds?: string[];
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
  readingStats?: ReadingBackupStats;
  secrets?: Record<string, string>;
  storage: Record<string, string>;
  cameraBackupPrivacy?: CameraBackupPrivacyManifest;
};




export type PreImportBackupSnapshot = {
  id: string;
  uri: string;
  createdAt: string;
  size?: number;
};

const backupMediaSnapshotIo = {
  getInfoAsync: (uri: string) => FileSystem.getInfoAsync(uri),
  readDirectoryAsync: (uri: string) => FileSystem.readDirectoryAsync(uri),
};
let legacySecretStorageMigrationComplete = false;

async function ensureLegacySecretStorageMigration() {
  if (legacySecretStorageMigrationComplete) return;
  await migrateLegacySecretStorage();
  legacySecretStorageMigrationComplete = true;
}

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

function requireDocumentDirectory() {
  if (!FileSystem.documentDirectory || !FileSystem.cacheDirectory) {
    throw new Error('当前设备无法访问应用文件目录。');
  }
  return {
    cacheDirectory: FileSystem.cacheDirectory,
    documentDirectory: FileSystem.documentDirectory,
  };
}

function extensionFromUri(uri: string) {
  const match = uri.match(/\.([a-zA-Z0-9]{1,8})(?:\?.*)?$/);
  return match ? match[1].toLowerCase() : 'jpg';
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

async function addMediaDirectoryToArchiveStrict(options: {
  archiveFolder: JSZip;
  archivePrefix: string;
  documentDirectory: string;
  manifest: BackupManifest;
  sourceFolder: string;
  validateRelativePath: (relativePath: string) => boolean;
  onFile?: (relativePath: string) => void;
}) {
  return captureBackupMediaDirectoryStrict({
    sourceDirectoryUri: `${options.documentDirectory}${options.sourceFolder}/`,
    io: backupMediaSnapshotIo,
    captureFile: async ({ relativePath, sourceUri }) => {
      if (!options.validateRelativePath(relativePath)) {
        throw new Error(`媒体路径无法安全恢复：${relativePath}`);
      }
      const fileBase64 = await FileSystem.readAsStringAsync(sourceUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      options.archiveFolder.file(relativePath, fileBase64, { base64: true });
      options.manifest.includedFiles?.push(`${ROOT_FOLDER}/files/${options.archivePrefix}/${relativePath}`);
      options.onFile?.(relativePath);
    },
  });
}

async function addVoiceMessagesToArchive(root: JSZip, documentDirectory: string, manifest: BackupManifest) {
  const voiceDirectory = `${documentDirectory}${VOICE_MESSAGES_FOLDER}/`;
  let fileNames: string[];
  try {
    fileNames = await FileSystem.readDirectoryAsync(voiceDirectory);
  } catch {
    return;
  }
  if (!fileNames.length) return;

  const voiceFolder = root.folder('files')!.folder(VOICE_MESSAGES_FOLDER)!;
  for (const fileName of fileNames) {
    if (!safeFileName(fileName)) continue;
    try {
      const uri = `${voiceDirectory}${fileName}`;
      const fileBase64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      voiceFolder.file(fileName, fileBase64, { base64: true });
      manifest.includedFiles?.push(`${ROOT_FOLDER}/files/${VOICE_MESSAGES_FOLDER}/${fileName}`);
    } catch {
      // Missing or unreadable voice files should not block the rest of the backup.
    }
  }
}

async function addBaiyunStickersToArchive(
  root: JSZip,
  documentDirectory: string,
  manifest: BackupManifest,
) {
  const sourceRoot = `${documentDirectory}${BAIYUN_STICKER_FOLDER}/`;
  let moodIds: string[];
  try {
    moodIds = await FileSystem.readDirectoryAsync(sourceRoot);
  } catch {
    return;
  }
  const archiveFolder = root.folder('files')!.folder(BAIYUN_STICKER_FOLDER)!;
  for (const moodId of moodIds) {
    let fileNames: string[];
    try {
      fileNames = await FileSystem.readDirectoryAsync(`${sourceRoot}${moodId}/`);
    } catch {
      continue;
    }
    for (const fileName of fileNames) {
      const relativePath = `${moodId}/${fileName}`;
      if (!isSafeBaiyunStickerBackupRelativePath(relativePath)) continue;
      try {
        const sourceUri = `${sourceRoot}${relativePath}`;
        const info = await FileSystem.getInfoAsync(sourceUri);
        if (!info.exists || info.isDirectory) continue;
        const base64 = await FileSystem.readAsStringAsync(sourceUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        archiveFolder.file(relativePath, base64, { base64: true });
        manifest.includedFiles?.push(`${ROOT_FOLDER}/files/${BAIYUN_STICKER_FOLDER}/${relativePath}`);
      } catch {
        // A missing or unreadable sticker does not block a best-effort backup.
      }
    }
  }
}

async function addTogetherWalkedImageLevelToArchive(
  imageFolder: JSZip,
  sourceDirectory: string,
  prefix: '' | 'drafts',
  manifest: BackupManifest,
) {
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(sourceDirectory);
  } catch {
    return;
  }
  for (const name of names) {
    const relativePath = prefix ? `${prefix}/${name}` : name;
    if (!isSafeTogetherWalkedBackupRelativePath(relativePath)) continue;
    try {
      const sourceUri = `${sourceDirectory}${name}`;
      const info = await FileSystem.getInfoAsync(sourceUri);
      if (!info.exists || info.isDirectory) continue;
      const imageBase64 = await FileSystem.readAsStringAsync(sourceUri, { encoding: FileSystem.EncodingType.Base64 });
      imageFolder.file(relativePath, imageBase64, { base64: true });
      manifest.includedFiles?.push(`${ROOT_FOLDER}/files/${TOGETHER_WALKED_IMAGE_FOLDER}/${relativePath}`);
    } catch {
      // Missing or unreadable trip photos should not block the rest of the backup.
    }
  }
}

async function addTogetherWalkedImagesToArchive(root: JSZip, documentDirectory: string, manifest: BackupManifest) {
  const imageDirectory = `${documentDirectory}${TOGETHER_WALKED_IMAGE_FOLDER}/`;
  const imageFolder = root.folder('files')!.folder(TOGETHER_WALKED_IMAGE_FOLDER)!;
  await addTogetherWalkedImageLevelToArchive(imageFolder, imageDirectory, '', manifest);
  await addTogetherWalkedImageLevelToArchive(imageFolder, `${imageDirectory}drafts/`, 'drafts', manifest);
}

async function addReadingFilesToArchive(root: JSZip, documentDirectory: string, manifest: BackupManifest) {
  const readingDirectory = `${documentDirectory}${READING_FILES_FOLDER}/`;
  let bookIds: string[];
  try {
    bookIds = await FileSystem.readDirectoryAsync(readingDirectory);
  } catch {
    return;
  }
  if (!bookIds.length) return;

  const readingFolder = root.folder('files')!.folder(READING_FILES_FOLDER)!;
  for (const bookId of bookIds) {
    if (!isSafeReadingBackupPathSegment(bookId)) {
      if (manifest.readingStats) manifest.readingStats.skippedFileCount += 1;
      continue;
    }
    if (manifest.readingStats) manifest.readingStats.bookDirectoryCount += 1;
    await addReadingDirectoryToArchive(readingFolder, `${readingDirectory}${bookId}/`, [bookId], manifest);
  }
}

async function addReadingDirectoryToArchive(
  readingFolder: JSZip,
  directoryUri: string,
  relativeParts: string[],
  manifest: BackupManifest,
) {
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(directoryUri);
  } catch {
    if (manifest.readingStats) manifest.readingStats.failedFileCount += 1;
    return;
  }

  for (const name of names) {
    if (!isSafeReadingBackupPathSegment(name)) {
      if (manifest.readingStats) manifest.readingStats.skippedFileCount += 1;
      continue;
    }
    const nextParts = [...relativeParts, name];
    const relativePath = joinSafeReadingBackupPath(nextParts);
    if (!relativePath) {
      if (manifest.readingStats) manifest.readingStats.skippedFileCount += 1;
      continue;
    }
    const uri = `${directoryUri}${name}`;
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists && info.isDirectory) {
        await addReadingDirectoryToArchive(readingFolder, `${uri}/`, nextParts, manifest);
        continue;
      }
      const fileBase64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      readingFolder.file(relativePath, fileBase64, { base64: true });
      manifest.includedFiles?.push(`${ROOT_FOLDER}/files/${READING_FILES_FOLDER}/${relativePath}`);
      if (manifest.readingStats) manifest.readingStats.packedFileCount += 1;
    } catch {
      if (manifest.readingStats) manifest.readingStats.failedFileCount += 1;
      // Missing or unreadable reading files should not block the rest of the backup.
    }
  }
}

function rewriteVoiceMessageUri(value: unknown, voiceDirectory: string): boolean {
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

function rewriteVoiceUrisInMessages(serialized: string, voiceDirectory: string) {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (Array.isArray(parsed)) {
      let changed = false;
      for (const item of parsed) {
        changed = rewriteVoiceMessageUri(item, voiceDirectory) || changed;
      }
      return changed ? JSON.stringify(parsed) : serialized;
    }
    return rewriteVoiceMessageUri(parsed, voiceDirectory) ? JSON.stringify(parsed) : serialized;
  } catch {
    return serialized;
  }
}

function rewriteRestoredVoiceMessageUris(storage: Record<string, string>, voiceDirectory: string) {
  const nextStorage = { ...storage };
  for (const [key, value] of Object.entries(nextStorage)) {
    if (
      key !== CHAT_MESSAGES_KEY &&
      !key.startsWith(CHAT_SESSION_MESSAGES_PREFIX) &&
      !key.startsWith(CHAT_SESSION_MESSAGE_PREFIX)
    ) continue;
    nextStorage[key] = rewriteVoiceUrisInMessages(value, voiceDirectory);
  }
  return nextStorage;
}

function rewriteTogetherWalkedImageUris(serialized: string | undefined, imageDirectory: string) {
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

function rewriteRestoredTogetherWalkedUris(storage: Record<string, string>, imageDirectory: string) {
  const nextStorage = { ...storage };
  const rewritten = rewriteTogetherWalkedImageUris(nextStorage[TOGETHER_WALKED_STORAGE_KEY], imageDirectory);
  if (rewritten) nextStorage[TOGETHER_WALKED_STORAGE_KEY] = rewritten;
  const rewrittenDraft = rewriteTogetherWalkedDraftUri(
    nextStorage[TOGETHER_WALKED_DRAFT_STORAGE_KEY],
    imageDirectory,
  );
  if (rewrittenDraft) nextStorage[TOGETHER_WALKED_DRAFT_STORAGE_KEY] = rewrittenDraft;
  return nextStorage;
}

async function restoreVoiceMessages(zip: JSZip, documentDirectory: string, manifest: Partial<BackupManifest>) {
  const voiceDirectory = `${documentDirectory}${VOICE_MESSAGES_FOLDER}/`;
  const prefix = `${ROOT_FOLDER}/files/${VOICE_MESSAGES_FOLDER}/`;
  const archiveFiles = Object.values(zip.files).filter((file) => !file.dir && file.name.startsWith(prefix));

  await restoreDirectorySafely(voiceDirectory, async (stagingDirectory) => {
    for (const archiveFile of archiveFiles) {
      const fileName = safeFileName(archiveFile.name.slice(prefix.length));
      if (!fileName) continue;
      const base64 = await archiveFile.async('base64');
      await writeStringFileSafely(`${stagingDirectory}${fileName}`, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }
  });
  if (archiveFiles.length) manifest.includedFiles = manifest.includedFiles ?? archiveFiles.map((file) => file.name);
  return voiceDirectory;
}

async function restoreToolWorkspaceFiles(
  zip: JSZip,
  documentDirectory: string,
  manifest: Partial<BackupManifest>,
) {
  const directory =
    `${documentDirectory}${TOOL_WORKSPACE_FILE_FOLDER}/`;
  const prefix =
    `${ROOT_FOLDER}/files/${TOOL_WORKSPACE_FILE_FOLDER}/`;
  const archiveFiles = Object.values(zip.files).filter(
    (file) => !file.dir && file.name.startsWith(prefix),
  );
  await restoreDirectorySafely(directory, async (stagingDirectory) => {
    for (const archiveFile of archiveFiles) {
      const fileName = archiveFile.name.slice(prefix.length);
      if (!isSafeToolWorkspaceBackupFileName(fileName)) continue;
      const base64 = await archiveFile.async('base64');
      await writeStringFileSafely(`${stagingDirectory}${fileName}`, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }
  });
  if (archiveFiles.length) {
    manifest.includedFiles =
      manifest.includedFiles ?? archiveFiles.map((file) => file.name);
  }
  return directory;
}

async function restoreBaiyunStickers(
  zip: JSZip,
  documentDirectory: string,
  manifest: Partial<BackupManifest>,
) {
  const stickerDirectory = `${documentDirectory}${BAIYUN_STICKER_FOLDER}/`;
  const prefix = `${ROOT_FOLDER}/files/${BAIYUN_STICKER_FOLDER}/`;
  const archiveFiles = Object.values(zip.files).filter(
    (file) => !file.dir && file.name.startsWith(prefix),
  );
  const restoredArchiveFileNames: string[] = [];
  await restoreDirectorySafely(stickerDirectory, async (stagingDirectory) => {
    for (const archiveFile of archiveFiles) {
      const relativePath = archiveFile.name.slice(prefix.length);
      if (!isSafeBaiyunStickerBackupRelativePath(relativePath)) continue;
      const slash = relativePath.lastIndexOf('/');
      await FileSystem.makeDirectoryAsync(
        `${stagingDirectory}${relativePath.slice(0, slash + 1)}`,
        { intermediates: true },
      );
      const base64 = await archiveFile.async('base64');
      await writeStringFileSafely(
        `${stagingDirectory}${relativePath}`,
        base64,
        { encoding: FileSystem.EncodingType.Base64 },
      );
      restoredArchiveFileNames.push(archiveFile.name);
    }
  });
  if (restoredArchiveFileNames.length) {
    manifest.includedFiles = manifest.includedFiles ?? restoredArchiveFileNames;
  }
  return stickerDirectory;
}

async function restoreTogetherWalkedImages(zip: JSZip, documentDirectory: string, manifest: Partial<BackupManifest>) {
  const imageDirectory = `${documentDirectory}${TOGETHER_WALKED_IMAGE_FOLDER}/`;
  const prefix = `${ROOT_FOLDER}/files/${TOGETHER_WALKED_IMAGE_FOLDER}/`;
  const archiveFiles = Object.values(zip.files).filter((file) => !file.dir && file.name.startsWith(prefix));
  const restoredArchiveFileNames: string[] = [];

  await restoreDirectorySafely(imageDirectory, async (stagingDirectory) => {
    for (const archiveFile of archiveFiles) {
      const relativePath = archiveFile.name.slice(prefix.length);
      if (!isSafeTogetherWalkedBackupRelativePath(relativePath)) continue;
      const slash = relativePath.lastIndexOf('/');
      const targetParent = slash >= 0
        ? `${stagingDirectory}${relativePath.slice(0, slash + 1)}`
        : stagingDirectory;
      await FileSystem.makeDirectoryAsync(targetParent, { intermediates: true });
      const base64 = await archiveFile.async('base64');
      await writeStringFileSafely(`${stagingDirectory}${relativePath}`, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      restoredArchiveFileNames.push(archiveFile.name);
    }
  });
  if (restoredArchiveFileNames.length) {
    manifest.includedFiles = manifest.includedFiles ?? restoredArchiveFileNames;
  }
  return imageDirectory;
}

async function restoreReadingFiles(zip: JSZip, documentDirectory: string, manifest: Partial<BackupManifest>) {
  const readingDirectory = `${documentDirectory}${READING_FILES_FOLDER}/`;
  const prefix = `${ROOT_FOLDER}/files/${READING_FILES_FOLDER}/`;
  const archiveFiles = Object.values(zip.files).filter((file) => !file.dir && file.name.startsWith(prefix));

  await restoreDirectorySafely(readingDirectory, async (stagingDirectory) => {
    for (const archiveFile of archiveFiles) {
      const relativePath = archiveFile.name.slice(prefix.length);
      const parts = splitSafeReadingBackupPath(relativePath);
      if (!parts) {
        if (manifest.readingStats) manifest.readingStats.skippedFileCount += 1;
        continue;
      }
      const fileName = parts[parts.length - 1];
      const directoryParts = parts.slice(0, -1);
      const targetDirectory = directoryParts.length ? `${stagingDirectory}${directoryParts.join('/')}/` : stagingDirectory;
      const base64 = await archiveFile.async('base64');
      await writeStringFileSafely(`${targetDirectory}${fileName}`, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (manifest.readingStats) manifest.readingStats.restoredFileCount += 1;
    }
  });
  if (archiveFiles.length) manifest.includedFiles = manifest.includedFiles ?? archiveFiles.map((file) => file.name);
  return readingDirectory;
}

async function addLegacyDatabaseToArchive(
  folder: JSZip,
  fileName: string,
  exportDatabase: () => Promise<Uint8Array>,
) {
  const bytes = await exportDatabase();
  try {
    await validateDatabaseFile(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '未知错误';
    throw new BackupDatabaseValidationError(`${fileName} 没有通过导出数据库验货：${detail}`);
  }
  folder.file(fileName, bytes);
}

async function createLegacyBackupArchive(options: CreateBackupArchiveOptions = {}): Promise<BackupArchiveResult> {
  const { cacheDirectory, documentDirectory } = requireDocumentDirectory();
  const storage = await readLocalStorage();
  const cameraObservationBackup = await prepareCameraObservationBackup({
    includeForRollback: options.includeCameraObservationsForRollback,
  });
  const manifest: BackupManifest = {
    formatVersion: ORDINARY_BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    excludesApiKeys: true,
    excludesSyncState: true,
    includedDatabases: [
      'JunLuo/db/junluo-memory.db',
      'JunLuo/db/junluo-schedule.db',
      'JunLuo/db/junluo-todo.db',
      'JunLuo/db/junluo-expense.db',
      'JunLuo/db/junluo-focus.db',
      'JunLuo/db/junluo-period.db',
      'JunLuo/db/junluo-theater.db',
      'JunLuo/db/junluo-phone-activity.db',
      'JunLuo/db/junluo-body-signal.db',
      'JunLuo/db/junluo-shiying.db',
    ],
    includedFiles: [],
    coverageNotes: [
      'This ordinary backup includes JunLuo business data and local media, but excludes secrets and synchronization state.',
      'Together-walked travel records are included through AsyncStorage and their local photo files are stored under JunLuo/files/together-walked when present.',
      'Co-reading records, result action metadata, EPUB/text source files, covers, and extracted reading images are included through AsyncStorage and JunLuo/files/reading/books when present.',
      'Registered tool workspace files are stored under JunLuo/files/tool-file-cache and restored with portable local URIs.',
      'Gift records, echoes and web progress are in junluo-memory.db; referenced originals are included under JunLuo/files/gift-originals and resolved against this device after restore.',
      'Notifications are recreated by the app after restore and are not stored as device notification records.',
      'Camera temporary frames and photos explicitly saved to an external SAF directory are never included. Structured camera observations are included only with explicit sensitive-backup consent.',
    ],
    personalityIncluded: true,
    personalityDatabaseNotes: [
      'JunLuo/db/junluo-memory.db includes StyleMemory, dreams, life diary, whispers, daily impressions, and memory archive data.',
      'JunLuo/db/junluo-todo.db includes todos, habits, goals, goal progress, daily challenges, task execution records, and day/week reviews.',
    ],
    personalityStorageKeys: PERSONALITY_STORAGE_KEYS,
    readingStats: createReadingBackupStats(storage),
    storage: { ...storage },
    cameraBackupPrivacy: cameraObservationBackup.manifest,
  };
  const zip = new JSZip();
  const root = zip.folder(ROOT_FOLDER)!;
  if (cameraObservationBackup.bytes) {
    root.folder('sensitive')!.file('camera-observations-v1.sqlite', cameraObservationBackup.bytes);
  }
  const databaseFolder = root.folder('db')!;
  manifest.missingPostImageIds = await capturePostBackup(manifest.storage, options, async () => {
    const bytes = await exportMemoryDatabase();
    await validateDatabaseFile(bytes);
    databaseFolder.file('junluo-memory.db', bytes);
    return openDatabaseImportSource(bytes);
  }, async (image, uri) => {
    const data = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    if (Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) !== image.byte_size)
      throw new Error('动态图片读取验货失败。');
    zip.file(`${POST_BACKUP_PREFIX}${image.id}.jpg`, data, { base64: true });
    manifest.includedFiles!.push(`${POST_BACKUP_PREFIX}${image.id}.jpg`);
  });
  const giftDb = await openDatabaseImportSource(await databaseFolder.file('junluo-memory.db')!.async('uint8array'));
  try {
    await captureGiftBackupOriginals(await readGiftBackupOriginals(giftDb), async (original, uri) => {
      const data = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const byteSize = Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      assertGiftBackupByteSize(original, byteSize);
      const path = `${GIFT_ORIGINALS_BACKUP_PREFIX}${original.storageName}`;
      zip.file(path, data, { base64: true });
      manifest.includedFiles!.push(path);
      return byteSize;
    });
  } finally { await giftDb.closeAsync(); }
  await addLegacyDatabaseToArchive(databaseFolder, 'junluo-schedule.db', exportScheduleDatabase);
  await addLegacyDatabaseToArchive(databaseFolder, 'junluo-todo.db', exportTodoDatabase);
  await addLegacyDatabaseToArchive(databaseFolder, 'junluo-expense.db', exportExpenseDatabase);
  await addLegacyDatabaseToArchive(databaseFolder, 'junluo-focus.db', exportFocusDatabase);
  await addLegacyDatabaseToArchive(databaseFolder, 'junluo-period.db', exportPeriodDatabase);
  await addLegacyDatabaseToArchive(databaseFolder, 'junluo-theater.db', exportTheaterDatabase);
  await addLegacyDatabaseToArchive(databaseFolder, 'junluo-phone-activity.db', exportPhoneActivityDatabase);
  await addLegacyDatabaseToArchive(databaseFolder, 'junluo-body-signal.db', exportBodySignalDatabase);
  const shiyingWork = `${cacheDirectory}shiying-legacy-export-${Date.now()}-${Math.random().toString(36).slice(2)}/`;
  try {
    const shiyingRoot = `${shiyingWork}JunLuo/`, shiyingDb = `${shiyingRoot}db/`;
    await FileSystem.makeDirectoryAsync(shiyingDb, { intermediates: true });
    manifest.missingShiyingImageIds = await captureShiyingBackup(shiyingDb, shiyingRoot, options, manifest.includedFiles!);
    for (const path of [`JunLuo/db/${SHIYING_DATABASE_NAME}`, ...manifest.includedFiles!.filter(path => path.startsWith('JunLuo/files/shiying-media/'))]) {
      zip.file(path, await FileSystem.readAsStringAsync(`${shiyingWork}${path}`, { encoding: FileSystem.EncodingType.Base64 }), { base64: true });
    }
  } finally { await FileSystem.deleteAsync(shiyingWork, { idempotent: true }); }
  root.folder('assets');
  root.folder('files');
  root.folder('fonts');

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
            captureFile: async ({ sourceUri }) => {
              const imageBase64 = await FileSystem.readAsStringAsync(sourceUri, {
                encoding: FileSystem.EncodingType.Base64,
              });
              root.folder('assets')!.file(backgroundAssetName, imageBase64, { base64: true });
            },
          });
        } else {
          const imageBase64 = await FileSystem.readAsStringAsync(background.imageUri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          root.folder('assets')!.file(backgroundAssetName, imageBase64, { base64: true });
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

  if (options.strictMediaSnapshot) {
    await addMediaDirectoryToArchiveStrict({
      archiveFolder: root.folder('files')!.folder(VOICE_MESSAGES_FOLDER)!,
      archivePrefix: VOICE_MESSAGES_FOLDER,
      documentDirectory,
      manifest,
      sourceFolder: VOICE_MESSAGES_FOLDER,
      validateRelativePath: (relativePath) => !!safeFileName(relativePath),
    });
    await addMediaDirectoryToArchiveStrict({
      archiveFolder: root.folder('files')!.folder(BAIYUN_STICKER_FOLDER)!,
      archivePrefix: BAIYUN_STICKER_FOLDER,
      documentDirectory,
      manifest,
      sourceFolder: BAIYUN_STICKER_FOLDER,
      validateRelativePath: isSafeBaiyunStickerBackupRelativePath,
    });
    await addMediaDirectoryToArchiveStrict({
      archiveFolder: root.folder('files')!.folder(TOGETHER_WALKED_IMAGE_FOLDER)!,
      archivePrefix: TOGETHER_WALKED_IMAGE_FOLDER,
      documentDirectory,
      manifest,
      sourceFolder: TOGETHER_WALKED_IMAGE_FOLDER,
      validateRelativePath: isSafeTogetherWalkedBackupRelativePath,
    });
    const readingResult = await addMediaDirectoryToArchiveStrict({
      archiveFolder: root.folder('files')!.folder(READING_FILES_FOLDER)!,
      archivePrefix: READING_FILES_FOLDER,
      documentDirectory,
      manifest,
      sourceFolder: READING_FILES_FOLDER,
      validateRelativePath: (relativePath) => splitSafeReadingBackupPath(relativePath) !== null,
      onFile: () => {
        if (manifest.readingStats) manifest.readingStats.packedFileCount += 1;
      },
    });
    if (manifest.readingStats) {
      manifest.readingStats.bookDirectoryCount += new Set(
        readingResult.relativePaths.map((relativePath) => relativePath.split('/')[0]),
      ).size;
    }
  } else {
    await addVoiceMessagesToArchive(root, documentDirectory, manifest);
    await addBaiyunStickersToArchive(root, documentDirectory, manifest);
    await addTogetherWalkedImagesToArchive(root, documentDirectory, manifest);
    await addReadingFilesToArchive(root, documentDirectory, manifest);
  }

  await addMediaDirectoryToArchiveStrict({
    archiveFolder: root.folder('files')!
      .folder(TOOL_WORKSPACE_FILE_FOLDER)!,
    archivePrefix: TOOL_WORKSPACE_FILE_FOLDER,
    documentDirectory,
    manifest,
    sourceFolder: TOOL_WORKSPACE_FILE_FOLDER,
    validateRelativePath: isSafeToolWorkspaceBackupFileName,
  });

  root.file('config.json', JSON.stringify(manifest, null, 2));
  validateOrdinaryBackupArchiveFiles(
    manifest,
    Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name),
  );
  await validateLegacyArchiveEntries(describeLegacyArchiveEntries(zip));
  const zipBase64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveUri = `${cacheDirectory}JunLuo-backup-${stamp}.zip`;
  await writeStringFileSafely(archiveUri, zipBase64, { encoding: FileSystem.EncodingType.Base64 });
  return { uri: archiveUri, missingPostImageIds: manifest.missingPostImageIds, missingShiyingImageIds: manifest.missingShiyingImageIds ?? [] };
}


function preImportSnapshotDirectory(documentDirectory: string) {
  return `${documentDirectory}${PRE_IMPORT_SNAPSHOT_FOLDER}/`;
}

async function ensurePreImportSnapshotDirectory(documentDirectory: string) {
  const directory = preImportSnapshotDirectory(documentDirectory);
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  return directory;
}

export async function listPreImportBackupSnapshots(): Promise<PreImportBackupSnapshot[]> {
  const { documentDirectory } = requireDocumentDirectory();
  const directory = preImportSnapshotDirectory(documentDirectory);
  let fileNames: string[];
  try {
    fileNames = await FileSystem.readDirectoryAsync(directory);
  } catch {
    return [];
  }

  const snapshots = await Promise.all(
    fileNames
      .filter(isPreImportSnapshotFileName)
      .map(async (fileName) => {
        const uri = `${directory}${fileName}`;
        const info = await FileSystem.getInfoAsync(uri);
        if (!info.exists || info.isDirectory) return null;
        const createdAt = typeof info.modificationTime === 'number'
          ? new Date(info.modificationTime * 1000).toISOString()
          : new Date(0).toISOString();
        const snapshot: PreImportBackupSnapshot = {
          id: fileName,
          uri,
          createdAt,
        };
        if (typeof info.size === 'number') snapshot.size = info.size;
        return snapshot;
      }),
  );

  return snapshots
    .filter((snapshot): snapshot is PreImportBackupSnapshot => snapshot !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export async function deletePreImportBackupSnapshot(id: string) {
  if (!isPreImportSnapshotFileName(id) || id.includes('/') || id.includes('\\')) {
    throw new Error('无法识别这份导入前快照。');
  }
  const journal = await readBackupRestoreJournal();
  if (journal?.snapshotId === id) {
    throw new Error('这份快照正在保护一次尚未完成的恢复，不能删除。');
  }
  const { documentDirectory } = requireDocumentDirectory();
  await FileSystem.deleteAsync(`${preImportSnapshotDirectory(documentDirectory)}${id}`, { idempotent: true });
}

export async function prunePreImportBackupSnapshots(max = DEFAULT_PRE_IMPORT_SNAPSHOT_LIMIT) {
  const snapshots = await listPreImportBackupSnapshots();
  const keepCount = Math.max(0, max);
  const extra = snapshots.slice(keepCount);
  await Promise.all(extra.map((snapshot) => deletePreImportBackupSnapshot(snapshot.id).catch(() => undefined)));
  return snapshots.slice(0, keepCount);
}

export async function createPreImportBackupSnapshot(): Promise<PreImportBackupSnapshot> {
  const { documentDirectory } = requireDocumentDirectory();
  const snapshotDirectory = await ensurePreImportSnapshotDirectory(documentDirectory);
  const { uri: archiveUri } = await createBackupArchive(undefined, {
    strictMediaSnapshot: true,
    includeCameraObservationsForRollback: true,
    postCaptureAlreadyExclusive: true,
    shiyingCaptureAlreadyExclusive: true,
    preserveShiyingLocalStateForRollback: true,
  });
  try {
    const archiveInfo = await FileSystem.getInfoAsync(archiveUri);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = PRE_IMPORT_SNAPSHOT_PREFIX + stamp + PRE_IMPORT_SNAPSHOT_SUFFIX;
    const targetUri = snapshotDirectory + fileName;

    await copyFileSafely({
      from: archiveUri,
      to: targetUri,
      minimumBytes: archiveInfo.exists && !archiveInfo.isDirectory && typeof archiveInfo.size === 'number' ? archiveInfo.size : 1,
    });
    await prunePreImportBackupSnapshots(DEFAULT_PRE_IMPORT_SNAPSHOT_LIMIT);

    const info = await FileSystem.getInfoAsync(targetUri);
    return {
      id: fileName,
      uri: targetUri,
      createdAt: new Date().toISOString(),
      size: info.exists && !info.isDirectory && typeof info.size === 'number' ? info.size : undefined,
    };
  } finally {
    await FileSystem.deleteAsync(archiveUri, { idempotent: true }).catch(() => undefined);
  }
}

type LegacyStreamableZipObject = JSZip.JSZipObject & {
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
};

export type BackupProtectedTaskResult<T> =
  | { ran: true; value: T }
  | { ran: false; reason: 'data-epoch-changed' | 'recovery-performed' | 'restart-required' };

function streamLegacyArchiveEntryBytes(
  archiveFile: JSZip.JSZipObject,
  onChunk: (byteLength: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const stream = (archiveFile as LegacyStreamableZipObject).internalStream('uint8array');
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      stream.pause();
      reject(error);
    };

    stream
      .on('data', (chunk) => {
        if (settled) return;
        try {
          onChunk(chunk.byteLength);
        } catch (error) {
          fail(error);
        }
      })
      .on('error', fail)
      .on('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      })
      .resume();
  });
}

function describeLegacyArchiveEntries(zip: JSZip) {
  return Object.values(zip.files).map((archiveFile) => {
    const compressedData = (archiveFile as JSZip.JSZipObject & {
      _data?: { uncompressedSize?: unknown };
    })._data;
    return {
      name: archiveFile.name,
      unsafeOriginalName: archiveFile.unsafeOriginalName,
      isDirectory: archiveFile.dir,
      uncompressedSize:
        typeof compressedData?.uncompressedSize === 'number'
          ? compressedData.uncompressedSize
          : undefined,
      streamUncompressedBytes: archiveFile.dir
        ? undefined
        : async (onChunk: (byteLength: number) => void) => {
          await streamLegacyArchiveEntryBytes(archiveFile, onChunk);
        },
    };
  });
}

async function validateLegacyDatabaseFiles(databases: Array<{
  fileName: string;
  archiveFile: JSZip.JSZipObject | null;
}>) {
  let preparedTheaterBytes: Uint8Array | undefined;
  for (const { fileName, archiveFile } of databases) {
    if (!archiveFile) continue;
    try {
      const bytes = await archiveFile.async('uint8array');
      if (fileName === 'junluo-theater.db') {
        preparedTheaterBytes = await prepareTheaterBackupBytes(bytes);
      } else {
        await validateDatabaseFile(bytes);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误';
      throw new BackupDatabaseValidationError(`${fileName} 没有通过数据库验货：${detail}`);
    }
  }
  return preparedTheaterBytes;
}

async function restoreLegacyBackupArchive(
  archiveUri: string,
  options: RestoreBackupOptions = {},
  mode: 'transaction' | 'rollback' = 'transaction',
): Promise<RestoreBackupResult> {
  const { documentDirectory } = requireDocumentDirectory();
  const archiveInfo = await FileSystem.getInfoAsync(archiveUri);
  if (!archiveInfo.exists || archiveInfo.isDirectory) {
    throw new BackupFormatError('无法读取这份君落备份文件。');
  }
  validateLegacyArchiveFileSize(archiveInfo.size);
  const archiveBase64 = await FileSystem.readAsStringAsync(archiveUri, { encoding: FileSystem.EncodingType.Base64 });
  const zip = await JSZip.loadAsync(archiveBase64, { base64: true });
  await validateLegacyArchiveEntries(describeLegacyArchiveEntries(zip));
  // Inspect declared expansion limits before CRC checking decompresses entries.
  await JSZip.loadAsync(archiveBase64, { base64: true, checkCRC32: true });
  const manifestFile = zip.file(`${ROOT_FOLDER}/config.json`);
  const databaseFile = zip.file(`${ROOT_FOLDER}/db/junluo-memory.db`);
  const scheduleDatabaseFile = zip.file(`${ROOT_FOLDER}/db/junluo-schedule.db`);
  const todoDatabaseFile = zip.file(`${ROOT_FOLDER}/db/junluo-todo.db`);
  const expenseDatabaseFile = zip.file(`${ROOT_FOLDER}/db/junluo-expense.db`);
  const focusDatabaseFile = zip.file(`${ROOT_FOLDER}/db/junluo-focus.db`);
  const periodDatabaseFile = zip.file(`${ROOT_FOLDER}/db/junluo-period.db`);
  const theaterDatabaseFile = zip.file(`${ROOT_FOLDER}/db/junluo-theater.db`);
  const phoneActivityDatabaseFile = zip.file(`${ROOT_FOLDER}/db/junluo-phone-activity.db`);
  const bodySignalDatabaseFile = zip.file(`${ROOT_FOLDER}/db/junluo-body-signal.db`);
  if (!manifestFile || !databaseFile) {
    throw new BackupFormatError('这不是可识别的君落备份文件。');
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(await manifestFile.async('string'));
  } catch {
    throw new BackupFormatError('备份里的 config.json 已损坏，已经停止还原。');
  }
  const manifest = validateBackupManifest(rawManifest) as BackupManifest;
  validateOrdinaryBackupArchiveFiles(
    manifest,
    Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name),
  );
  const postDirectory = `${requireDocumentDirectory().cacheDirectory}post-restore-${Date.now()}-${Math.random().toString(36).slice(2)}/`;
  try {
  let shiying: PreparedShiyingBackup | undefined;
  if (manifest.formatVersion >= 14) {
    const root = `${postDirectory}JunLuo/`, directory = `${root}db/`;
    const database = zip.file(`JunLuo/db/${SHIYING_DATABASE_NAME}`);
    if (!database) throw new BackupFormatError('备份缺少拾荧数据库，已经停止还原。');
    await writeStringFileSafely(`${directory}${SHIYING_DATABASE_NAME}`, await database.async('base64'), { encoding: FileSystem.EncodingType.Base64 });
    for (const file of Object.values(zip.files).filter(file => !file.dir && file.name.startsWith('JunLuo/files/shiying-media/'))) {
      await writeStringFileSafely(`${postDirectory}${file.name}`, await file.async('base64'), { encoding: FileSystem.EncodingType.Base64 });
    }
    shiying = await prepareShiyingBackup(directory, root, manifest.missingShiyingImageIds);
    if (mode === 'transaction') acceptShiyingMissing(shiying.missing, options.acceptedMissingShiyingImageIds, 'restore');
  }
  const postDb = await openDatabaseImportSource(await databaseFile.async('uint8array'));
  let giftOriginals: GiftOriginal[];
  const postImages = await (async () => {
    try {
      giftOriginals = await readGiftBackupOriginals(postDb);
      await validateGiftBackupOriginals(giftOriginals, Object.values(zip.files).filter(file => !file.dir).map(file => file.name),
        async original => (await zip.file(`${GIFT_ORIGINALS_BACKUP_PREFIX}${original.storageName}`)!.async('uint8array')).length);
      manifest.storage = await prepareRestoredPostStorage(manifest.storage, postDb);
      return await preparePostBackupImages({
        db: postDb, formatVersion: manifest.formatVersion, missingPostImageIds: manifest.missingPostImageIds,
        directory: postDirectory, reuseLocal: mode === 'transaction',
        readArchiveImage: async (image, target) => {
          const file = zip.file(`${POST_BACKUP_PREFIX}${image.id}.jpg`);
          if (!file) return false;
          await writeStringFileSafely(target, await file.async('base64'), { encoding: FileSystem.EncodingType.Base64 });
          return true;
        },
      });
    } finally { await postDb.closeAsync(); }
  })();
  if (mode === 'transaction') acceptPostMissing(postImages.missing, options.acceptedMissingPostImageIds, 'restore');
  const ignoredLegacySecrets = manifest.formatVersion <= 11
    && Object.keys(manifest.secrets ?? {}).length > 0;
  if (ignoredLegacySecrets && mode === 'transaction' && !options.acceptIgnoredLegacySecrets) {
    throw new LegacyBackupSecretsIgnoredNoticeRequiredError();
  }
  const backgroundAssetName = manifest.backgroundAssetName;
  const cameraObservationArchiveFile = zip.file(CAMERA_OBSERVATION_ARCHIVE_PATH);
  const cameraObservationManifest = manifest.cameraBackupPrivacy?.structuredObservations;
  let cameraObservationBytes: Uint8Array | undefined;
  if (cameraObservationManifest?.included) {
    if (!cameraObservationArchiveFile) {
      throw new BackupFormatError('备份声明包含摄像头观察，但敏感负载缺失。');
    }
    cameraObservationBytes = await cameraObservationArchiveFile.async('uint8array');
    try {
      await validateCameraObservationBackupPayload(manifest.cameraBackupPrivacy!, cameraObservationBytes);
    } catch {
      throw new BackupFormatError('备份中的摄像头观察负载已损坏，已经停止还原。');
    }
    if (mode === 'transaction' && !options.cameraObservations) {
      throw new CameraObservationRestoreChoiceRequiredError(cameraObservationManifest.recordCount);
    }
  } else if (cameraObservationArchiveFile) {
    throw new BackupFormatError('备份包含清单未授权的摄像头观察负载，已经停止还原。');
  }

  const existingDatabaseNames = [
    'junluo-memory.db',
    scheduleDatabaseFile ? 'junluo-schedule.db' : null,
    todoDatabaseFile ? 'junluo-todo.db' : null,
    expenseDatabaseFile ? 'junluo-expense.db' : null,
    focusDatabaseFile ? 'junluo-focus.db' : null,
    periodDatabaseFile ? 'junluo-period.db' : null,
    theaterDatabaseFile ? 'junluo-theater.db' : null,
    phoneActivityDatabaseFile ? 'junluo-phone-activity.db' : null,
    bodySignalDatabaseFile ? 'junluo-body-signal.db' : null,
    shiying ? SHIYING_DATABASE_NAME : null,
  ].filter((fileName): fileName is string => fileName !== null);
  const missingDatabases = findMissingBackupDatabases(existingDatabaseNames, manifest.formatVersion);

  options.onStage?.('validating-databases');
  const preparedTheaterBytes = await validateLegacyDatabaseFiles([
    { fileName: 'junluo-memory.db', archiveFile: databaseFile },
    { fileName: 'junluo-schedule.db', archiveFile: scheduleDatabaseFile },
    { fileName: 'junluo-todo.db', archiveFile: todoDatabaseFile },
    { fileName: 'junluo-expense.db', archiveFile: expenseDatabaseFile },
    { fileName: 'junluo-focus.db', archiveFile: focusDatabaseFile },
    { fileName: 'junluo-period.db', archiveFile: periodDatabaseFile },
    { fileName: 'junluo-theater.db', archiveFile: theaterDatabaseFile },
    { fileName: 'junluo-phone-activity.db', archiveFile: phoneActivityDatabaseFile },
    { fileName: 'junluo-body-signal.db', archiveFile: bodySignalDatabaseFile },
  ]);

  let preImportSnapshot: PreImportBackupSnapshot | undefined;
  if (mode === 'transaction') {
    try {
      options.onStage?.('creating-snapshot');
      preImportSnapshot = await createPreImportBackupSnapshot();
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误';
      throw new PreImportBackupSnapshotError(`导入前快照生成失败。为了保护当前数据，已经停止还原。原因：${detail}`);
    }
  }

  const shiyingLocalState = shiying && mode === 'transaction' ? await readShiyingBackupLocalState() : undefined;
  const apply = async () => {
  await AsyncStorage.removeItem(CHAT_REPLY_DRAFT_KEY);
  await AsyncStorage.removeItem(SLEEP_REPLY_DRAFT_KEY);
  const restoredStorage = sanitizeRetiredAssistantStorage(
    sanitizeOrdinaryBackupStorage(manifest.storage),
  ).storage;
  const backgroundDirectory = `${documentDirectory}backgrounds/`;
  let restoredBackgroundUri: string | undefined;
  await restoreDirectorySafely(backgroundDirectory, async (stagingDirectory) => {
    if (!backgroundAssetName) return;
    const assetFile = zip.file(`${ROOT_FOLDER}/assets/${backgroundAssetName}`);
    if (!assetFile) return;
    const assetBase64 = await assetFile.async('base64');
    await writeStringFileSafely(`${stagingDirectory}${backgroundAssetName}`, assetBase64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    restoredBackgroundUri = `${backgroundDirectory}${backgroundAssetName}`;
  });
  if (restoredBackgroundUri) {
    try {
      const background = JSON.parse(restoredStorage[BACKGROUND_SETTINGS_KEY] ?? '{}') as object;
      restoredStorage[BACKGROUND_SETTINGS_KEY] = JSON.stringify({ ...background, imageUri: restoredBackgroundUri });
    } catch {
      // Invalid background settings can be ignored while other data is restored.
    }
  }

  const voiceDirectory = await restoreVoiceMessages(zip, documentDirectory, manifest);
  const stickerDirectory = await restoreBaiyunStickers(zip, documentDirectory, manifest);
  const togetherWalkedDirectory = await restoreTogetherWalkedImages(zip, documentDirectory, manifest);
  await restoreReadingFiles(zip, documentDirectory, manifest);
  await restoreToolWorkspaceFiles(zip, documentDirectory, manifest);
  await restorePostBackupImages(postImages);
  await restoreGiftBackupOriginals(giftOriginals!, async (original, target) => {
    const file = zip.file(`${GIFT_ORIGINALS_BACKUP_PREFIX}${original.storageName}`)!;
    await writeStringFileSafely(target, await file.async('base64'), { encoding: FileSystem.EncodingType.Base64 });
  });
  const currentStorage = await readLocalStorage();
  const rewrittenStorage = rewriteRestoredToolWorkspaceFileUris(
    rewriteRestoredBaiyunStickerUris(
      rewriteRestoredTogetherWalkedUris(
        rewriteRestoredVoiceMessageUris(restoredStorage, voiceDirectory),
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
  await replaceBackupStorageSafely(AsyncStorage, currentStorage, normalizedStorage);
  await purgeRetiredAssistantBusinessData();
  await migrateReadingStorageIfNeeded().then(() => repairReadingBookFiles()).catch(() => undefined);
  await importMemoryDatabase(await databaseFile.async('uint8array'));
  const careCleanup = await import('../ai/behavior/chatCareCleanup');
  await careCleanup.clearCareRecords(
    await (await import('../memory/memoryStore')).getMemoryDatabase('continuity'), careCleanup.restoredCareCleanupScope(rewrittenStorage),
  );
  if (scheduleDatabaseFile) {
    await importScheduleDatabase(await scheduleDatabaseFile.async('uint8array'));
  } else {
    await clearScheduleDatabase();
  }
  if (todoDatabaseFile) {
    await importTodoDatabase(await todoDatabaseFile.async('uint8array'));
  } else {
    await clearTodoDatabase();
  }
  if (expenseDatabaseFile) {
    await importExpenseDatabase(await expenseDatabaseFile.async('uint8array'));
  } else {
    await clearExpenseDatabase();
  }
  if (focusDatabaseFile) {
    await importFocusDatabase(await focusDatabaseFile.async('uint8array'));
  } else {
    await clearFocusDatabase();
  }
  if (periodDatabaseFile) {
    await importPeriodDatabase(await periodDatabaseFile.async('uint8array'));
  } else {
    await clearPeriodDatabase();
  }
  if (preparedTheaterBytes) {
    await importTheaterDatabase(preparedTheaterBytes);
  } else {
    await clearTheaterDatabase();
  }
  if (phoneActivityDatabaseFile) {
    await importPhoneActivityDatabase(await phoneActivityDatabaseFile.async('uint8array'));
  } else {
    await clearPhoneActivityDatabase();
  }
  if (bodySignalDatabaseFile) {
    await importBodySignalDatabase(await bodySignalDatabaseFile.async('uint8array'));
  } else {
    await clearBodySignalDatabase();
  }
  if (shiying) await restoreShiyingBackup(shiying, mode === 'rollback' ? shiying.localState : shiyingLocalState);
  if (cameraObservationBytes && options.cameraObservations === 'replace') {
    await restoreCameraObservationBackup(cameraObservationBytes);
  } else if (mode === 'rollback' && !cameraObservationBytes) {
    await clearCameraObservationBackup();
  }
  await reconcileRestoredNotificationState();
  await resetAutomaticRemoteAiPolicyAfterRestore();
  await resetAutomaticDataSyncPolicy();

  };
  if (preImportSnapshot) {
    await runRestoreCommitWithRollback({
      beforeApply: async () => {
        await beginBackupRestoreSyncGate(preImportSnapshot!.id);
      },
      apply,
      afterApply: async () => {
        await markBackupRestoreSyncRebuildRequired(preImportSnapshot!.id);
      },
      rollback: async () => {
        options.onStage?.('rolling-back');
        await restoreLegacyBackupArchive(
          preImportSnapshot.uri,
          { cameraObservations: 'replace' },
          'rollback',
        );
      },
      afterRollback: () => clearBackupRestoreSyncGate(preImportSnapshot!.id),
      snapshotUri: preImportSnapshot.uri,
      journal: createBackupRestoreJournalLifecycle(preImportSnapshot.id),
    });
  } else {
    await apply();
  }

  return {
    preImportSnapshotCreated: !!preImportSnapshot,
    preImportSnapshotUri: preImportSnapshot?.uri,
    manifestVersion: manifest.formatVersion,
    ignoredLegacySecrets,
    syncRebuildRequired: mode === 'transaction',
    missingDatabases,
    missingPostImageIds: postImages.missing,
    missingShiyingImageIds: shiying?.missing.map(image => image.imageId) ?? [],
    cameraObservations: cameraObservationBytes
      ? options.cameraObservations === 'replace' ? 'replaced' : 'preserved_local'
      : 'not_in_backup',
  };
  } finally { await FileSystem.deleteAsync(postDirectory, { idempotent: true }).catch(() => undefined); }
}

async function recoverInterruptedBackupRestoreUnsafe() {
  if (!FileSystem.documentDirectory) return false;
  const journal = await readBackupRestoreJournal();
  if (!journal) return false;
  markBackupRestoreRestoring('正在恢复上一次未完成的备份还原。');
  await invalidateShiyingForRestore();
  const snapshotUri = resolveBackupRestoreJournalSnapshotUri(journal);
  const originalError = new Error('上一次备份恢复在完成前被中断。');
  try {
    const snapshotInfo = await FileSystem.getInfoAsync(snapshotUri);
    if (!snapshotInfo.exists || snapshotInfo.isDirectory) {
      throw new Error('用于自动恢复原状的导入前快照不存在。');
    }
    if (Platform.OS === 'android') {
      if (!canUseNativeBackupArchive()) {
        throw new Error('当前开发版缺少恢复导入前快照所需的流式备份模块。');
      }
      await restoreAndroidBackupSnapshotWithoutSnapshot(snapshotUri);
    } else {
      await restoreLegacyBackupArchive(
        snapshotUri,
        { cameraObservations: 'replace' },
        'rollback',
      );
    }
    await clearBackupRestoreSyncGate(journal.snapshotId);
    await clearBackupRestoreJournal();
    await cleanupBackupTemporaryFiles().catch(() => undefined);
    return true;
  } catch (rollbackError) {
    throw new BackupRollbackFailedError(originalError, rollbackError, snapshotUri);
  }
}

let backupRestoreRecoveryReady: Promise<boolean> | null = null;

export function ensureBackupRestoreRecovery() {
  if (backupRestoreRecoveryReady) return backupRestoreRecoveryReady;
  const flight = runBackupRestoreRecoverySingleFlight(async () => {
    const recovered = await recoverInterruptedBackupRestoreUnsafe();
    await AsyncStorage.removeItem('junluo.baiyunBehavior.currentAction');
    if (!recovered) {
      await ensureLegacySecretStorageMigration();
    }
    return recovered;
  }).catch((error) => {
    if (backupRestoreRecoveryReady === flight) backupRestoreRecoveryReady = null;
    throw error;
  });
  backupRestoreRecoveryReady = flight;
  return flight;
}

export async function runBackupProtectedTask<T>(
  task: () => Promise<T>,
): Promise<BackupProtectedTaskResult<T>> {
  const recovered = await ensureBackupRestoreRecovery();
  if (recovered) return { ran: false, reason: 'recovery-performed' };
  const dataEpoch = captureBackupRestoreDataEpoch();
  return runBackupRestoreShared(async () => {
    const runtimeState = getBackupRestoreRuntimeState();
    if (runtimeState.status === 'restart-required') {
      return { ran: false, reason: 'restart-required' };
    }
    if (runtimeState.status === 'recovery-blocked') {
      throw new Error(runtimeState.detail);
    }
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) {
      return { ran: false, reason: 'data-epoch-changed' };
    }
    return { ran: true, value: await task() };
  });
}
export async function cleanupBackupTemporaryFiles() {
  if (Platform.OS === 'android') {
    return cleanupAndroidBackupTemporaryFiles();
  }
}

export async function createBackupArchive(
  onStage?: BackupStageCallback,
  options: CreateBackupArchiveOptions = {},
): Promise<BackupArchiveResult> {
  if (!options.shiyingCaptureAlreadyExclusive) {
    await flushShiyingBeforeBackup();
    return withShiyingRecordBackupBarrier(() => runBackupRestoreExclusive(() => createBackupArchive(onStage, {
      ...options, shiyingCaptureAlreadyExclusive: true, postCaptureAlreadyExclusive: true })));
  }
  if (Platform.OS === 'android') {
    if (!canUseNativeBackupArchive()) {
      throw new Error('当前开发版还没有流式备份模块，请覆盖安装最新的君落开发版。');
    }
    return createAndroidBackupArchive(onStage, options);
  }
  onStage?.('export-preparing');
  return createLegacyBackupArchive(options);
}

export async function restoreBackupArchive(
  archiveUri: string,
  options: RestoreBackupOptions = {},
): Promise<RestoreBackupResult> {
  await flushShiyingBeforeBackup();
  return withShiyingRecordBackupBarrier(() => runBackupRestoreExclusive(async () => {
    const runtimeState = getBackupRestoreRuntimeState();
    if (runtimeState.status !== 'ready') {
      throw new Error(runtimeState.detail);
    }
    markBackupRestoreRestoring();
    try {
      await invalidateShiyingForRestore();
      let result: RestoreBackupResult;
      if (Platform.OS === 'android') {
        if (!canUseNativeBackupArchive()) {
          throw new Error('当前开发版还没有流式备份模块，请覆盖安装最新的君落开发版。');
        }
        result = await restoreAndroidBackupArchive(
          archiveUri,
          createPreImportBackupSnapshot,
          options,
        );
      } else {
        options.onStage?.('validating-archive');
        result = await restoreLegacyBackupArchive(archiveUri, options);
      }
      markBackupRestoreRestartRequired('备份还原已经完成，需要重新打开君落以载入新数据。');
      return result;
    } catch (error) {
      if (error instanceof BackupRestoreRolledBackError) {
        markBackupRestoreRestartRequired('还原没有完成，君落已恢复到导入前状态，需要重新打开。');
      } else if (error instanceof BackupRollbackFailedError) {
        markBackupRestoreRecoveryBlocked(error);
      } else if (getBackupRestoreRuntimeState().status === 'restoring') {
        markBackupRestoreRuntimeReady();
      }
      throw error;
    }
  }));
}

export async function reloadAfterBackupRestore(onStage?: BackupStageCallback) {
  onStage?.('reloading');
  await reloadJunLuoApplication();
}

export {
  BackupDatabaseValidationError,
  BackupDiskSpaceError,
  BackupFormatError,
  BackupRollbackFailedError,
  BackupRestoreRolledBackError,
  CameraObservationRestoreChoiceRequiredError,
  LegacyBackupSecretsIgnoredNoticeRequiredError,
  PreImportBackupSnapshotError,
};
export type { BackupProgressStage, BackupStageCallback, RestoreBackupOptions, RestoreBackupResult } from './backupTypes';
