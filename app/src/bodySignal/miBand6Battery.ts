import { beginLegacyMiBand6BatteryRead, completeLegacyMiBand6BatteryRead, getGuardianState, readGuardianBattery, restoreSavedGuardianBattery } from './bodySignalGuardian';
import { loadLatestBodySignalReading } from './bodySignalStore';
import { persistGuardianBatteryEvent } from './bodySignalGuardianRuntime';
import { getColmiConnectionSnapshot, getColmiProviderContext, readConnectedMiBand6Battery } from './colmi/colmiConnection';
import { loadPersistedBodySignalDeviceProfiles } from './device/bodySignalDeviceRepository';
import { findMatchingBodySignalDeviceProfile } from './device/bodySignalDeviceRegistry';
import { parseMiBand6Battery, type MiBand6BatteryReading, type MiBand6BatteryTrigger } from './colmi/miBand6BatteryProtocol';

let pending: { key: string; task: Promise<MiBand6BatteryReading> } | undefined;

export async function restorePersistedMiBand6Battery(profileId: string): Promise<void> {
  const reading = await loadLatestBodySignalReading('battery', profileId);
  if (reading?.deviceProfileId === profileId && reading.sourceProvider === 'mi_band_6' && reading.confidence === 'high') {
    await restoreSavedGuardianBattery(profileId, reading.value, reading.measuredAt);
  }
}

export async function readMiBand6Battery({ trigger }: { trigger: MiBand6BatteryTrigger }): Promise<MiBand6BatteryReading> {
  const guardian = await getGuardianState();
  const native = guardian.owner === 'native_guardian';
  const connection = native ? undefined : getColmiConnectionSnapshot();
  const context = getColmiProviderContext();
  const profiles = await loadPersistedBodySignalDeviceProfiles();
  const profile = native || context?.profile.id
    ? profiles.find(candidate => candidate.id === (native ? guardian.deviceProfileId : context?.profile.id))
    : connection?.isConnected && connection.connectedDevice
      ? findMatchingBodySignalDeviceProfile(profiles, connection.connectedDevice) : undefined;
  if (!profile) throw new Error('battery_profile_missing');
  if (profile.family !== 'mi_band_6') throw new Error('battery_unsupported');
  const key = `${guardian.owner}:${profile.id}:${native ? guardian.sessionId : profile.lastConnectedAt}`;
  if (pending) {
    if (pending.key === key) return pending.task;
    throw new Error('battery_busy');
  }
  const run = async (): Promise<MiBand6BatteryReading> => {
    let event;
    if (native) event = await readGuardianBattery(profile.id, trigger);
    else {
      if (!connection?.isConnected) throw new Error('battery_not_ready');
      const attemptedAt = await beginLegacyMiBand6BatteryRead(profile.id, trigger);
      const candidate = await readConnectedMiBand6Battery(profile);
      const current = await getGuardianState();
      const currentConnection = getColmiConnectionSnapshot();
      const currentProfile = getColmiProviderContext()?.profile;
      if (current.owner !== 'legacy_js' || !currentConnection.isConnected
        || currentConnection.connectedDevice?.id !== connection.connectedDevice?.id
        || (currentProfile && (currentProfile.id !== profile.id || currentProfile.lastConnectedAt !== context?.profile.lastConnectedAt))) {
        throw new Error('battery_disconnected');
      }
      const parsed = parseMiBand6Battery(candidate.diagnosticPrefix);
      if (!parsed || candidate.deviceProfileId !== profile.id || parsed.percent !== candidate.percent
        || parsed.charging !== candidate.charging || !Number.isFinite(candidate.measuredAt)) throw new Error('battery_invalid_packet');
      event = await completeLegacyMiBand6BatteryRead(profile.id, trigger, attemptedAt, parsed, candidate.measuredAt);
    }
    if (event.type !== 'battery' || event.deviceProfileId !== profile.id || !Number.isInteger(event.percent)
      || event.percent < 0 || event.percent > 100 || !Number.isFinite(event.observedAt) || event.observedAt <= 0) {
      throw new Error('battery_invalid_packet');
    }
    await persistGuardianBatteryEvent(event);
    return { deviceProfileId: event.deviceProfileId, percent: event.percent, charging: event.charging,
      measuredAt: event.observedAt, confidence: 'high' };
  };
  const task = run().finally(() => { if (pending?.task === task) pending = undefined; });
  pending = { key, task };
  return task;
}
