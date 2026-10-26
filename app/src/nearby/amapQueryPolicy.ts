import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { AmapServiceError } from './amapNearbyProvider';
import { runNearbyWorldDataEpochCommit } from './nearbyWorldEpochCoordinator';
import { loadNearbyWorldStatus, saveNearbyWorldStatus, type NearbyWorldStatus } from './nearbyWorldStore';

// If persistence itself fails, this process still stops spending quota. A restored
// data epoch does not inherit an in-flight operation's transient state.
let unsavedPause: { epoch: number | null; service: 'regeo' | 'place' | 'geocode'; at: number } | undefined;

export function getEffectiveAmapPause(status: NearbyWorldStatus, epoch = captureBackupRestoreDataEpoch()) {
  return unsavedPause?.epoch === epoch ? unsavedPause : status.mapQuotaPause;
}

export class AmapQueryPausedError extends Error {
  constructor() { super('自动地图查询已暂停，等待明确重试。'); }
}

/** No switches are changed. Only a successful explicit retry of the failed service clears its pause. */
export async function runAmapQuery<T>(options: {
  service: 'regeo' | 'place' | 'geocode'; explicitRetry?: boolean; dataEpoch?: number | null;
}, work: () => Promise<T>): Promise<T> {
  const epoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const before = await runNearbyWorldDataEpochCommit(epoch, () => loadNearbyWorldStatus());
  if (!before.committed) throw new Error('STALE_DATA_EPOCH');
  const pause = getEffectiveAmapPause(before.value, epoch);
  if (pause && !(options.explicitRetry && options.service === pause.service)) {
    // A failed save must not masquerade as a durable pause in the tool receipt.
    if (unsavedPause?.epoch === epoch) throw new Error('MAP_QUOTA_PAUSE_SAVE_FAILED');
    throw new AmapQueryPausedError();
  }
  try {
    const result = await work();
    if (pause && options.explicitRetry && pause.service === options.service) {
      const cleared = await runNearbyWorldDataEpochCommit(epoch, async () => {
        const current = await loadNearbyWorldStatus();
        if (current.mapQuotaPause?.at === pause.at && current.mapQuotaPause.service === pause.service) {
          await saveNearbyWorldStatus({ ...current, mapQuotaPause: undefined });
        }
      });
      if (!cleared.committed) throw new Error('STALE_DATA_EPOCH');
      if (unsavedPause?.epoch === epoch && unsavedPause.at === pause.at) unsavedPause = undefined;
    }
    return result;
  } catch (error) {
    if (error instanceof AmapServiceError && error.kind === 'quota') {
      const quota = { service: error.service, at: Date.now() };
      unsavedPause = { ...quota, epoch };
      const saved = await runNearbyWorldDataEpochCommit(epoch, async () => {
        const current = await loadNearbyWorldStatus();
        await saveNearbyWorldStatus({ ...current, mapQuotaPause: quota });
      });
      if (!saved.committed) throw new Error('STALE_DATA_EPOCH');
      if (unsavedPause?.epoch === epoch && unsavedPause.at === quota.at) unsavedPause = undefined;
    }
    throw error;
  }
}
