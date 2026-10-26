import * as FileSystem from 'expo-file-system/legacy';

import { writeStringFileSafely } from '../storage/safeFileWrite';
import type { RestoreCommitJournal } from './backupRestoreOrchestrator';
import {
  createBackupRestoreJournal,
  parseBackupRestoreJournal,
  PRE_IMPORT_SNAPSHOT_FOLDER,
  RESTORE_JOURNAL_FILE_NAME,
  RESTORE_JOURNAL_MAX_BYTES,
  type BackupRestoreJournal,
} from './backupRestoreJournalState';

function requireDocumentDirectory() {
  if (!FileSystem.documentDirectory) {
    throw new Error('当前设备无法访问应用文件目录。');
  }
  return FileSystem.documentDirectory;
}

function restoreJournalDirectory() {
  return `${requireDocumentDirectory()}${PRE_IMPORT_SNAPSHOT_FOLDER}/`;
}

function restoreJournalUri() {
  return `${restoreJournalDirectory()}${RESTORE_JOURNAL_FILE_NAME}`;
}

export function resolveBackupRestoreJournalSnapshotUri(journal: BackupRestoreJournal) {
  return `${restoreJournalDirectory()}${journal.snapshotId}`;
}

export async function readBackupRestoreJournal(): Promise<BackupRestoreJournal | null> {
  const uri = restoreJournalUri();
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) return null;
  if (info.isDirectory || typeof info.size !== 'number' || info.size <= 0 || info.size > RESTORE_JOURNAL_MAX_BYTES) {
    throw new Error('未完成的备份恢复记录大小异常。');
  }
  return parseBackupRestoreJournal(await FileSystem.readAsStringAsync(uri));
}

async function writeBackupRestoreJournal(journal: BackupRestoreJournal) {
  const serialized = JSON.stringify(journal);
  if (serialized.length > RESTORE_JOURNAL_MAX_BYTES) {
    throw new Error('未完成的备份恢复记录过大。');
  }
  await writeStringFileSafely(restoreJournalUri(), serialized, { minimumBytes: 2 });
}

export async function clearBackupRestoreJournal() {
  await FileSystem.deleteAsync(restoreJournalUri(), { idempotent: true });
}

export function createBackupRestoreJournalLifecycle(snapshotId: string): RestoreCommitJournal {
  const journal = createBackupRestoreJournal(snapshotId);
  return {
    begin: async () => {
      if (await readBackupRestoreJournal()) {
        throw new Error('上一次备份恢复还没有处理完成。');
      }
      await writeBackupRestoreJournal(journal);
    },
    clear: clearBackupRestoreJournal,
  };
}
