import { readNativeBodySignalCareState, writeNativeBodySignalCareState } from './bodySignalGuardian';
import type { HeartCareState } from './bodySignalProactiveCare';
import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';

export async function readHeartCareState(readOnly = false): Promise<HeartCareState | null> {
  const raw = await readNativeBodySignalCareState<Record<string, unknown>>();
  if (!raw || !Number.isInteger(raw.revision)) return null;
  if (raw.schemaVersion === 2 && !raw.resetForRestore) return raw as HeartCareState;
  if (readOnly) return null;
  if (raw.schemaVersion !== 1 && !raw.resetForRestore) return null;
  const now = Date.now();
  const next: HeartCareState = { schemaVersion: 2, revision: Number(raw.revision) + 1,
    deviceProfileId: raw.resetForRestore ? '' : String(raw.deviceProfileId ?? ''),
    eligibleSince: now, lastReadingId: '', lastMeasuredAt: now, nextCheckAt: 0,
    status: !raw.resetForRestore && raw.status !== 'idle' ? 'active' : 'idle' };
  const previous = { revision: Number(raw.revision) } as HeartCareState;
  if (await writeHeartCareState(previous, next)) return next;
  throw new Error('heart-care-upgrade-raced');
}

export async function writeHeartCareState(previous: HeartCareState | null, next: HeartCareState) {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return false;
  const result = await runBackupRestoreDataEpochCommit(epoch,
    () => writeNativeBodySignalCareState(previous?.revision ?? 0, next));
  return result.committed && result.value;
}
