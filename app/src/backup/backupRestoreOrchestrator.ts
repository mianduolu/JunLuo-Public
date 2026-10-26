import { BackupRollbackFailedError, BackupRestoreRolledBackError } from './backupTypes';

export type RestoreCommitJournal = {
  begin: () => Promise<void>;
  clear: () => Promise<void>;
};

export async function runRestoreCommitWithRollback(options: {
  apply: () => Promise<void>;
  rollback: () => Promise<void>;
  snapshotUri: string;
  journal?: RestoreCommitJournal;
  afterApply?: () => Promise<void>;
  afterRollback?: () => Promise<void>;
  beforeApply?: () => Promise<void>;
}) {
  await options.journal?.begin();
  try {
    await options.beforeApply?.();
    await options.apply();
    await options.afterApply?.();
    await options.journal?.clear();
  } catch (originalError) {
    try {
      await options.rollback();
      await options.afterRollback?.();
      await options.journal?.clear();
    } catch (rollbackError) {
      throw new BackupRollbackFailedError(originalError, rollbackError, options.snapshotUri);
    }
    throw new BackupRestoreRolledBackError(originalError);
  }
}
