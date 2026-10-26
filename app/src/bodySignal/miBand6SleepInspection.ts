import { NativeModules, Platform } from 'react-native';
import { getGuardianState } from './bodySignalGuardian';
import { getColmiConnectionSnapshot, getColmiProviderContext, readConnectedMiBand6Activity,
  cancelConnectedMiBand6SleepInspection } from './colmi/colmiConnection';
import { loadPersistedBodySignalDeviceProfiles } from './device/bodySignalDeviceRepository';
import { findMatchingBodySignalDeviceProfile } from './device/bodySignalDeviceRegistry';
import { decodeMiBand6SleepCapture, MiBand6SleepCaptureRecorder, miBand6SleepSince,
  type MiBand6SleepWindow } from './miBand6SleepProtocol';

type SleepNative = {
  inspectMiBand6SleepHistory(profile: string, window: MiBand6SleepWindow): Promise<string>;
  cancelMiBand6SleepInspection(profile: string): Promise<boolean>;
  beginLegacyMiBand6SleepInspection(profile: string, window: MiBand6SleepWindow): Promise<{ since: number; token: string; requestedAt: number }>;
  finishLegacyMiBand6SleepInspection(token: string): Promise<boolean>;
};
function nativeModule(): SleepNative {
  const module = Platform.OS === 'android' ? NativeModules.JunLuoBodySignalGuardian as SleepNative | undefined : undefined;
  if (!module?.inspectMiBand6SleepHistory || !module.cancelMiBand6SleepInspection
    || !module.beginLegacyMiBand6SleepInspection || !module.finishLegacyMiBand6SleepInspection) {
    throw new Error('sleep_update_required');
  }
  return module;
}
export type MiBand6SleepRead = ReturnType<typeof decodeMiBand6SleepCapture> & {
  deviceProfileId: string;
  connectionKey: string;
};
type Pending = { window: MiBand6SleepWindow; expectedProfile?: string; task: Promise<MiBand6SleepRead>; cancelled: boolean; cancel?: () => Promise<unknown> };
let pending: Pending | undefined;

export async function getMiBand6SleepConnection() {
  const state = await getGuardianState();
  const native = state.owner === 'native_guardian';
  const connection = getColmiConnectionSnapshot();
  const profiles = await loadPersistedBodySignalDeviceProfiles();
  const id = native ? state.deviceProfileId : getColmiProviderContext()?.profile.id;
  const profile = id ? profiles.find(item => item.id === id)
    : !native && connection.connectedDevice ? findMatchingBodySignalDeviceProfile(profiles, connection.connectedDevice) : undefined;
  if (!profile || profile.family !== 'mi_band_6') throw new Error('activity_profile_missing');
  if (native ? state.status !== 'ready' : !connection.isConnected || connection.huami2021AuthStatus !== 'authenticated') {
    throw new Error('activity_not_ready');
  }
  return { deviceProfileId: profile.id,
    connectionKey: `${state.owner}:${profile.id}:${native ? state.sessionId : profile.lastConnectedAt}` };
}

// Shared read transport. Storage and automatic scheduling belong to the caller.
// The existing native lease still owns mutual exclusion and heart-rate priority.
export function readMiBand6SleepHistory({ window, signal, deviceProfileId }: {
  window: MiBand6SleepWindow; signal?: AbortSignal; deviceProfileId?: string;
}): Promise<MiBand6SleepRead> {
  miBand6SleepSince(window, Date.now());
  if (signal?.aborted) return Promise.reject(new Error('sleep_cancelled'));
  if (pending) return pending.window === window && pending.expectedProfile === deviceProfileId
    ? pending.task : Promise.reject(new Error('activity_busy'));
  const operation = { window, expectedProfile: deviceProfileId, cancelled: false } as Pending;
  const assertActive = () => { if (operation.cancelled || signal?.aborted) throw new Error('sleep_cancelled'); };
  const abort = () => {
    operation.cancelled = true;
    void operation.cancel?.().catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  const run = async () => {
    assertActive();
    const native = nativeModule();
    const state = await getGuardianState();
    assertActive();
    const isNative = state.owner === 'native_guardian';
    const connection = getColmiConnectionSnapshot();
    const profiles = await loadPersistedBodySignalDeviceProfiles();
    assertActive();
    const profileId = isNative ? state.deviceProfileId : getColmiProviderContext()?.profile.id;
    const profile = profileId ? profiles.find(item => item.id === profileId)
      : !isNative && connection.connectedDevice ? findMatchingBodySignalDeviceProfile(profiles, connection.connectedDevice) : undefined;
    if (!profile) throw new Error('activity_profile_missing');
    if (profile.family !== 'mi_band_6') throw new Error('activity_unsupported');
    if (deviceProfileId && deviceProfileId !== profile.id) throw new Error('activity_disconnected');
    if (state.paused || (state.scheduledSamplingPauseUntil ?? 0) > Date.now()) throw new Error('sleep_paused');
    if (state.samplingMode || state.scheduledSamplingStatus === 'sampling'
      || state.scheduledSamplingEnabled && (state.nextSamplingDueAt ?? Date.now()) <= Date.now() + 95_000) {
      throw new Error('sleep_heart_rate_due');
    }
    let result;
    if (isNative) {
      operation.cancel = () => native.cancelMiBand6SleepInspection(profile.id);
      assertActive();
      result = await native.inspectMiBand6SleepHistory(profile.id, window);
    } else {
      if (!connection.isConnected || connection.huami2021AuthStatus !== 'authenticated') throw new Error('activity_not_ready');
      if (['starting', 'running', 'stopping'].includes(connection.miBand6RealtimeHeartRateSession.status)
        || ['initializing', 'reading_battery', 'setting_time'].includes(connection.initializationStatus)) throw new Error('activity_busy');
      const lease = await native.beginLegacyMiBand6SleepInspection(profile.id, window);
      let recorder: MiBand6SleepCaptureRecorder | undefined;
      try {
        assertActive();
        recorder = new MiBand6SleepCaptureRecorder(lease.since, lease.requestedAt);
        operation.cancel = cancelConnectedMiBand6SleepInspection;
        await readConnectedMiBand6Activity(profile, lease.since, (kind, bytes, observedAt, elapsedMs) => {
          assertActive(); recorder!.record(kind, bytes, observedAt, elapsedMs);
        });
        assertActive();
        const after = getColmiConnectionSnapshot();
        if (!after.isConnected || after.connectedDevice?.id !== connection.connectedDevice?.id) throw new Error('activity_disconnected');
        result = recorder.complete();
      } finally {
        recorder?.clear();
        await native.finishLegacyMiBand6SleepInspection(lease.token);
      }
    }
    assertActive();
    const after = await getGuardianState();
    assertActive();
    if (after.owner !== state.owner || after.sessionId !== state.sessionId
      || isNative && after.deviceProfileId !== profile.id) throw new Error('activity_disconnected');
    return { ...decodeMiBand6SleepCapture(result), deviceProfileId: profile.id,
      connectionKey: `${state.owner}:${profile.id}:${isNative ? state.sessionId : profile.lastConnectedAt}` };
  };
  pending = operation;
  operation.task = run().finally(() => {
    signal?.removeEventListener('abort', abort);
    operation.cancel = undefined;
    if (pending === operation) pending = undefined;
  });
  return operation.task;
}
