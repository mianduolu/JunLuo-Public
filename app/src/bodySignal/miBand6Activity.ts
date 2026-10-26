import { getGuardianState } from './bodySignalGuardian';
import { persistGuardianActivityEvent } from './bodySignalGuardianRuntime';
import { loadBodySignalSyncCursor } from './bodySignalSyncCursorStore';
import { getColmiConnectionSnapshot, getColmiProviderContext, readConnectedMiBand6Activity } from './colmi/colmiConnection';
import { loadPersistedBodySignalDeviceProfiles } from './device/bodySignalDeviceRepository';
import { findMatchingBodySignalDeviceProfile } from './device/bodySignalDeviceRegistry';
import { MI_BAND_6_ACTIVITY_VERIFIED } from './colmi/miBand6ActivityProtocol';
import type { MiBand6ActivityBatch, MiBand6ActivitySyncTrigger } from './miBand6ActivityTypes';
import { beginLegacyMiBand6Activity, finishLegacyMiBand6Activity, loadNativeMiBand6ActivityState,
  readNativeMiBand6Activity, restoreNativeMiBand6ActivityCursor } from './miBand6ActivityNative';

let pending: { key: string; task: Promise<MiBand6ActivityBatch> } | undefined;

async function target() {
  const guardian = await getGuardianState();
  const native = guardian.owner === 'native_guardian';
  const connection = getColmiConnectionSnapshot();
  const profiles = await loadPersistedBodySignalDeviceProfiles();
  const profileId = native ? guardian.deviceProfileId : getColmiProviderContext()?.profile.id;
  const profile = profileId ? profiles.find(item => item.id === profileId)
    : !native && connection.connectedDevice ? findMatchingBodySignalDeviceProfile(profiles, connection.connectedDevice) : undefined;
  if (!profile) throw new Error('activity_profile_missing');
  if (profile.family !== 'mi_band_6') throw new Error('activity_unsupported');
  return { native, guardian, connection, profile };
}

export async function getMiBand6ActivitySyncState() {
  const { profile } = await target();
  const state = await loadNativeMiBand6ActivityState(profile.id);
  const cursor = await loadBodySignalSyncCursor(profile.id, 'mi_band_6', 'activity_history');
  return { ...state, syncedThroughAt: cursor?.syncedThroughAt };
}

async function synchronize(trigger: MiBand6ActivitySyncTrigger, deviceProfileId?: string): Promise<MiBand6ActivityBatch> {
  if (!MI_BAND_6_ACTIVITY_VERIFIED) throw new Error('activity_evidence_required');
  const { native, guardian, connection, profile } = await target();
  if (deviceProfileId && profile.id !== deviceProfileId) throw new Error('activity_disconnected');
  const key = `${guardian.owner}:${profile.id}:${native ? guardian.sessionId : profile.lastConnectedAt}`;
  if (pending) {
    if (pending.key === key) return pending.task;
    throw new Error('activity_busy');
  }
  const run = async () => {
    const support = await loadNativeMiBand6ActivityState(profile.id);
    if (support.formallyVerified !== true) throw new Error('activity_update_required');
    const cursor = await loadBodySignalSyncCursor(profile.id, 'mi_band_6', 'activity_history');
    if (cursor?.syncedThroughAt) await restoreNativeMiBand6ActivityCursor(profile.id, cursor.syncedThroughAt);
    let result;
    if (native) result = await readNativeMiBand6Activity(profile.id, trigger, false);
    else {
      if (!connection.isConnected) throw new Error('activity_not_ready');
      const attempt = await beginLegacyMiBand6Activity(profile.id, trigger, false);
      let batch: MiBand6ActivityBatch | undefined;
      let failure: string | undefined;
      try {
        batch = await readConnectedMiBand6Activity(profile, attempt.since);
        const current = await target();
        if (current.native || current.profile.id !== profile.id
          || current.connection.connectedDevice?.id !== connection.connectedDevice?.id) throw new Error('activity_disconnected');
      } catch (error) {
        failure = error instanceof Error && error.message.startsWith('activity_') ? error.message : 'activity_transfer_failed';
      }
      result = await finishLegacyMiBand6Activity(profile.id, trigger, attempt.attemptedAt, batch, failure, false);
    }
    if (!result || typeof result !== 'object') throw new Error('activity_invalid_batch');
    if (!('type' in result) || result.type !== 'activity_batch' || result.deviceProfileId !== profile.id) throw new Error('activity_invalid_batch');
    await persistGuardianActivityEvent(result);
    return result.batch;
  };
  const task = run().finally(() => { if (pending?.task === task) pending = undefined; });
  pending = { key, task };
  return task;
}

export function syncMiBand6ActivityHistory({ trigger, deviceProfileId }: { trigger: MiBand6ActivitySyncTrigger; deviceProfileId?: string }) {
  return synchronize(trigger, deviceProfileId);
}
