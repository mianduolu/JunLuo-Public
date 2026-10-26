type ShiyingBackupParticipant = {
  flush?: () => Promise<unknown>;
  hasPendingSave?: () => boolean;
  invalidate: () => void;
};

const participants = new Set<ShiyingBackupParticipant>();

/** Mounted text buffers and received model results are not in the SQLite snapshot yet. */
export function registerShiyingBackupParticipant(participant: ShiyingBackupParticipant) {
  participants.add(participant);
  return () => { participants.delete(participant); };
}

export async function flushShiyingBeforeBackup(): Promise<void> {
  for (const participant of [...participants]) await participant.flush?.();
  assertShiyingBackupHasNoPendingSave();
}

/** Safe while exclusive: checking RAM does not wait on a queued database commit. */
export function assertShiyingBackupHasNoPendingSave(): void {
  if ([...participants].some(participant => participant.hasPendingSave?.())) {
    throw new Error('shiying_backup_local_save_pending');
  }
}

/** The caller has already advanced the restore epoch. Never wait for an HTTP flight here. */
export async function invalidateShiyingForRestore(): Promise<void> {
  for (const participant of [...participants]) participant.invalidate();
}

/** Enter before taking the global exclusive lock; never enqueue another record operation inside. */
export async function withShiyingRecordBackupBarrier<T>(action: () => Promise<T>): Promise<T> {
  const { shiyingRecordCoordinator } = await import('./shiyingRecordCoordinator');
  return shiyingRecordCoordinator.backupBarrier(action);
}
