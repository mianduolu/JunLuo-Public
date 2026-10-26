import {
  canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
  type BackupRestoreDataEpochCommitResult,
} from '../backup/backupRestoreCoordinator';

export type NearbyWorldExternalStepResult<T> =
  | { current: false }
  | { current: true; value: T };

// The restore coordinator shares leases between ordinary writers; serialize this
// domain's read/modify/write commits as well, without holding a lease over HTTP.
let nearbyCommitTail: Promise<unknown> = Promise.resolve();

export async function runNearbyWorldExternalStep<T>(
  dataEpoch: number | null,
  work: () => Promise<T>,
): Promise<NearbyWorldExternalStepResult<T>> {
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return { current: false };
  try {
    const value = await work();
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return { current: false };
    return { current: true, value };
  } catch (error) {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return { current: false };
    throw error;
  }
}

export async function runNearbyWorldDataEpochCommit<T>(
  dataEpoch: number | null,
  work: () => Promise<T>,
): Promise<BackupRestoreDataEpochCommitResult<T>> {
  const pending = nearbyCommitTail.then(() => runBackupRestoreDataEpochCommit(dataEpoch, work));
  nearbyCommitTail = pending.catch(() => undefined);
  const committed = await pending;
  if (!committed.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) {
    return { committed: false };
  }
  return committed;
}
