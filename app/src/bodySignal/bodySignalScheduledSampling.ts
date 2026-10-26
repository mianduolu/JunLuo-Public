export const BODY_SIGNAL_SCHEDULED_SAMPLING_INTERVAL_MINUTES = 30 as const;
export const BODY_SIGNAL_SCHEDULED_SAMPLING_MAX_WINDOW_SECONDS = 120 as const;
export const BODY_SIGNAL_SCHEDULED_SAMPLING_READING_GAP_MS = 15_000;

export type BodySignalScheduledSamplingTrigger =
  | 'enabled'
  | 'native_timer'
  | 'alarm'
  | 'foreground'
  | 'device_ready'
  | 'settings_resume';

export type BodySignalScheduledSamplingReason =
  | 'due'
  | 'disabled'
  | 'cooldown'
  | 'paused'
  | 'guardian_not_ready'
  | 'device_absent'
  | 'permission_missing'
  | 'low_phone_battery'
  | 'low_wearable_battery'
  | 'battery_saver'
  | 'thermal_severe'
  | 'manual_session_active'
  | 'unsupported_device';

export type BodySignalScheduledSamplingResult =
  | 'completed'
  | 'no_data'
  | 'skipped'
  | 'stopped'
  | 'write_failed'
  | 'disconnected';

export type BodySignalScheduledSamplingSettings = {
  enabled: boolean;
  intervalMinutes: 30;
  maxWindowSeconds: 120;
  pauseUntil?: number;
  updatedAt: number;
};

export type BodySignalScheduledSamplingWindow = {
  deviceProfileId: string;
  durationMs: number;
  endedAt: number;
  id: string;
  readingCount: number;
  reason: BodySignalScheduledSamplingReason;
  requestedAt: number;
  result: BodySignalScheduledSamplingResult;
  startedAt?: number;
  trigger: BodySignalScheduledSamplingTrigger;
};

export type BodySignalScheduledSamplingDecisionInput = {
  appeared: boolean;
  enabled: boolean;
  guardianReady: boolean;
  manualSessionActive: boolean;
  nextDueAt?: number;
  now: number;
  pauseUntil?: number;
  permissionsGranted: boolean;
  phoneBatteryPercent?: number;
  phoneCharging: boolean;
  powerSaveMode: boolean;
  supportedDevice: boolean;
  thermalSevere: boolean;
  wearableBattery?: {
    measuredAt: number;
    percent: number;
  };
};

export function defaultBodySignalScheduledSamplingSettings(
  now = Date.now(),
): BodySignalScheduledSamplingSettings {
  return {
    enabled: false,
    intervalMinutes: BODY_SIGNAL_SCHEDULED_SAMPLING_INTERVAL_MINUTES,
    maxWindowSeconds: BODY_SIGNAL_SCHEDULED_SAMPLING_MAX_WINDOW_SECONDS,
    updatedAt: now,
  };
}

export function nextLocalEightAm(now = Date.now()): number {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(8, 0, 0, 0);
  return next.getTime();
}

export function decideBodySignalScheduledSampling(
  input: BodySignalScheduledSamplingDecisionInput,
): BodySignalScheduledSamplingReason {
  if (!input.enabled) return 'disabled';
  if (input.pauseUntil && input.pauseUntil > input.now) return 'paused';
  if (!input.supportedDevice) return 'unsupported_device';
  if (input.manualSessionActive) return 'manual_session_active';
  if (input.nextDueAt && input.nextDueAt > input.now) return 'cooldown';
  if (!input.permissionsGranted || input.phoneBatteryPercent === undefined) {
    return 'permission_missing';
  }
  if (!input.appeared) return 'device_absent';
  if (!input.guardianReady) return 'guardian_not_ready';
  if (input.powerSaveMode) return 'battery_saver';
  if (input.thermalSevere) return 'thermal_severe';
  if (!input.phoneCharging && input.phoneBatteryPercent <= 15) {
    return 'low_phone_battery';
  }
  const wearableBattery = input.wearableBattery;
  if (
    wearableBattery
    && input.now - wearableBattery.measuredAt <= 6 * 60 * 60 * 1000
    && wearableBattery.percent <= 20
  ) {
    return 'low_wearable_battery';
  }
  return 'due';
}

export function hasSecondSeparatedHeartRate(
  firstReadingAt: number | undefined,
  candidateAt: number,
): boolean {
  return firstReadingAt !== undefined
    && candidateAt - firstReadingAt >= BODY_SIGNAL_SCHEDULED_SAMPLING_READING_GAP_MS;
}
