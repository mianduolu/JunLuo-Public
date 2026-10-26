export const RECENT_DEVICE_USE_POLL_MS = 5_000;
export const RECENT_DEVICE_USE_HEARTBEAT_MS = 10_000;

export type RecentDeviceUseSampleStatus =
  | 'ready' | 'permission_missing' | 'locked' | 'suspended' | 'unsupported' | 'unknown';

export type RawRecentDeviceUseSample = {
  runtimeEpoch: string;
  /** Local deduplication only. Never include application, window or input contents. */
  inputToken: string | null;
  inputAgeMs: number | null;
  /** Android elapsedRealtime / Windows GetTickCount64, including sleep. */
  sampledMonotonicMs: number;
  sampleStatus: RecentDeviceUseSampleStatus;
};

export type RecentDeviceUseSnapshotV1 = Omit<RawRecentDeviceUseSample, 'inputToken'> & {
  version: 1;
  deviceId: string;
  platform: 'android' | 'windows';
  eventSequence: number;
};

export type RecentDeviceUseSampleState = {
  snapshot: RecentDeviceUseSnapshotV1;
  inputToken: string | null;
  inputMonotonicMs: number | null;
};

const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Sampling and sync are observations; only a newly observed input advances sequence. */
export function sampleRecentDeviceUse(
  previous: RecentDeviceUseSampleState | null,
  raw: RawRecentDeviceUseSample,
  identity: Pick<RecentDeviceUseSnapshotV1, 'deviceId' | 'platform'>,
): RecentDeviceUseSampleState {
  const sameRuntime = previous?.snapshot.runtimeEpoch === raw.runtimeEpoch
    && previous.snapshot.deviceId === identity.deviceId && previous.snapshot.platform === identity.platform;
  const prior = sameRuntime ? previous : null;
  const monotonicValid = nonnegative(raw.sampledMonotonicMs)
    && (!prior || raw.sampledMonotonicMs >= prior.snapshot.sampledMonotonicMs);
  const sampledMonotonicMs = monotonicValid ? raw.sampledMonotonicMs : prior?.snapshot.sampledMonotonicMs ?? 0;
  const ready = raw.sampleStatus === 'ready' && monotonicValid
    && typeof raw.runtimeEpoch === 'string' && raw.runtimeEpoch.length > 0
    && typeof raw.inputToken === 'string' && raw.inputToken.length > 0
    && nonnegative(raw.inputAgeMs);
  let sampleStatus: RecentDeviceUseSampleStatus = raw.sampleStatus === 'ready' ? 'unknown' : raw.sampleStatus;
  let inputToken = prior?.inputToken ?? null;
  let inputMonotonicMs = prior?.inputMonotonicMs ?? null;
  let eventSequence = prior?.snapshot.eventSequence ?? 0;
  let inputAgeMs: number | null = null;
  if (ready) {
    const observedInput = sampledMonotonicMs - raw.inputAgeMs!;
    if (inputToken === raw.inputToken && inputMonotonicMs !== null) {
      inputAgeMs = sampledMonotonicMs - inputMonotonicMs;
      sampleStatus = 'ready';
    } else if (inputMonotonicMs === null || observedInput > inputMonotonicMs) {
      // A gap/resume is not input. A strictly newer OS input still has its own sequence.
      if (inputToken !== null) eventSequence += 1;
      inputToken = raw.inputToken;
      inputMonotonicMs = observedInput;
      inputAgeMs = raw.inputAgeMs;
      sampleStatus = 'ready';
    }
  }
  return { inputToken, inputMonotonicMs, snapshot: {
    version: 1, ...identity, runtimeEpoch: raw.runtimeEpoch, eventSequence,
    inputAgeMs, sampledMonotonicMs, sampleStatus,
  } };
}

export type RecentDeviceUseClockCalibration = {
  runtimeEpoch: string;
  offsetMs: number;
  uncertaintyMs: number;
};

/** Local interval helper; the proactive-control server owns authoritative calibration. */
export function calibrateRecentDeviceUseClock(input: {
  runtimeEpoch: string;
  sentMonotonicMs: number;
  receivedMonotonicMs: number;
  serverTimeMs: number;
}): RecentDeviceUseClockCalibration | null {
  if (!input.runtimeEpoch || !nonnegative(input.sentMonotonicMs)
    || !nonnegative(input.receivedMonotonicMs) || !nonnegative(input.serverTimeMs)
    || input.receivedMonotonicMs < input.sentMonotonicMs) return null;
  const roundtrip = input.receivedMonotonicMs - input.sentMonotonicMs;
  return { runtimeEpoch: input.runtimeEpoch, uncertaintyMs: roundtrip / 2,
    offsetMs: input.serverTimeMs - (input.sentMonotonicMs + roundtrip / 2) };
}

export function recentDeviceUseInputInterval(
  snapshot: RecentDeviceUseSnapshotV1,
  calibration: RecentDeviceUseClockCalibration | null,
  nowMonotonicMs: number,
): { earliestServerTimeMs: number; latestServerTimeMs: number } | null {
  if (!calibration || snapshot.sampleStatus !== 'ready' || !nonnegative(snapshot.inputAgeMs)
    || !nonnegative(nowMonotonicMs) || nowMonotonicMs < snapshot.sampledMonotonicMs
    || calibration.runtimeEpoch !== snapshot.runtimeEpoch) return null;
  const center = snapshot.sampledMonotonicMs - snapshot.inputAgeMs + calibration.offsetMs;
  return { earliestServerTimeMs: center - calibration.uncertaintyMs,
    latestServerTimeMs: center + calibration.uncertaintyMs };
}
