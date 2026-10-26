export const PRE_IMPORT_SNAPSHOT_FOLDER = 'backup-snapshots/pre-import';
export const PRE_IMPORT_SNAPSHOT_PREFIX = 'JunLuo-pre-import-';
export const PRE_IMPORT_SNAPSHOT_SUFFIX = '.zip';
export const RESTORE_JOURNAL_FILE_NAME = 'restore-journal.v1.json';
export const RESTORE_JOURNAL_MAX_BYTES = 16 * 1024;

export type BackupRestoreJournal = {
  version: 1;
  snapshotId: string;
  startedAt: string;
};

export function isPreImportSnapshotFileName(fileName: string) {
  return fileName.startsWith(PRE_IMPORT_SNAPSHOT_PREFIX)
    && fileName.endsWith(PRE_IMPORT_SNAPSHOT_SUFFIX)
    && fileName.length <= 255
    && /^[A-Za-z0-9._-]+$/.test(fileName);
}

function assertJournal(value: unknown): asserts value is BackupRestoreJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('无法识别未完成的备份恢复记录。');
  }
  const journal = value as Partial<BackupRestoreJournal>;
  if (
    journal.version !== 1
    || !isPreImportSnapshotFileName(journal.snapshotId ?? '')
    || typeof journal.startedAt !== 'string'
    || !Number.isFinite(Date.parse(journal.startedAt))
  ) {
    throw new Error('未完成的备份恢复记录已损坏。');
  }
}

export function createBackupRestoreJournal(snapshotId: string, startedAt = new Date().toISOString()): BackupRestoreJournal {
  const journal: BackupRestoreJournal = {
    version: 1,
    snapshotId,
    startedAt,
  };
  assertJournal(journal);
  return journal;
}

export function parseBackupRestoreJournal(serialized: string): BackupRestoreJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('未完成的备份恢复记录不是有效 JSON。');
  }
  assertJournal(parsed);
  return parsed;
}
