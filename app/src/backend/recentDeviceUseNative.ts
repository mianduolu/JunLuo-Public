import { NativeModules, Platform } from 'react-native';
import type { RawRecentDeviceUseSample, RecentDeviceUseSampleStatus } from '../proactive/recentDeviceUse';

type RecentDeviceUseNative = {
  readSample(): Promise<RawRecentDeviceUseSample>;
  getMonotonicTime(): Promise<number>;
};
const native = NativeModules.JunLuoRecentDeviceUse as RecentDeviceUseNative | undefined;
const statuses = new Set<RecentDeviceUseSampleStatus>([
  'ready', 'permission_missing', 'locked', 'suspended', 'unsupported', 'unknown',
]);

/** Same Android elapsedRealtime clock as readSample; never use JS performance.now here. */
export async function getAndroidRecentDeviceUseMonotonicTime(): Promise<number | null> {
  if (Platform.OS !== 'android' || !native?.getMonotonicTime) return null;
  try {
    const value = await native.getMonotonicTime();
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch { return null; }
}

export async function readAndroidRecentDeviceUse(): Promise<RawRecentDeviceUseSample> {
  const unavailable: RawRecentDeviceUseSample = { runtimeEpoch: 'android-unavailable',
    inputToken: null, inputAgeMs: null, sampledMonotonicMs: 0, sampleStatus: 'unsupported' };
  if (Platform.OS !== 'android' || !native?.readSample) return unavailable;
  try {
    const value = await native.readSample();
    if (!value || typeof value.runtimeEpoch !== 'string' || !value.runtimeEpoch
      || !statuses.has(value.sampleStatus) || !Number.isFinite(value.sampledMonotonicMs)
      || value.sampledMonotonicMs < 0
      || (value.inputToken !== null && typeof value.inputToken !== 'string')
      || (value.inputAgeMs !== null && (!Number.isFinite(value.inputAgeMs) || value.inputAgeMs < 0))) {
      return { ...unavailable, sampleStatus: 'unknown' };
    }
    return { runtimeEpoch: value.runtimeEpoch, inputToken: value.inputToken,
      inputAgeMs: value.inputAgeMs, sampledMonotonicMs: value.sampledMonotonicMs,
      sampleStatus: value.sampleStatus };
  } catch { return { ...unavailable, sampleStatus: 'unknown' }; }
}
