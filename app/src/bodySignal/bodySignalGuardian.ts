import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { MiBand6BatteryTrigger, MiBand6BatteryValue } from './colmi/miBand6BatteryProtocol';
import type { MiBand6ActivityBatch } from './miBand6ActivityTypes';

import type {
  BodySignalScheduledSamplingReason,
  BodySignalScheduledSamplingResult,
  BodySignalScheduledSamplingTrigger,
} from './bodySignalScheduledSampling';

export type BodySignalGuardianStatus =
  | 'idle'
  | 'starting'
  | 'connecting'
  | 'discovering'
  | 'authenticating'
  | 'ready'
  | 'sampling'
  | 'suspended'
  | 'stopping'
  | 'error';

export type BodySignalConnectionOwner = 'legacy_js' | 'native_guardian';

export type BodySignalSamplingMode = 'manual_5_minute' | 'scheduled_2_minute';

export type BodySignalScheduledSamplingStatus =
  | 'disabled'
  | 'waiting'
  | 'evaluating'
  | 'sampling'
  | 'paused'
  | 'skipped'
  | 'error';

export type BodySignalGuardianSupport = {
  bluetoothConnectPermissionGranted: boolean;
  notificationPermissionGranted: boolean;
  reason?: 'android_api_below_33';
  supported: boolean;
};

export type BodySignalGuardianState = {
  appeared: boolean;
  associationId?: number;
  deviceProfileId?: string;
  enabled: boolean;
  lastConnectedAt?: number;
  lastErrorCode?: string;
  lastHeartRateAt?: number;
  lastTransitionAt: number;
  owner: BodySignalConnectionOwner;
  paused: boolean;
  retryAttempt: number;
  scheduledSamplingEnabled: boolean;
  scheduledSamplingPauseUntil?: number;
  scheduledSamplingStatus: BodySignalScheduledSamplingStatus;
  samplingMode?: BodySignalSamplingMode;
  samplingEndsAt?: number;
  sessionId?: string;
  status: BodySignalGuardianStatus;
  nextSamplingDueAt?: number;
  lastScheduledSamplingStartedAt?: number;
  lastScheduledSamplingEndedAt?: number;
  lastScheduledSamplingResult?: string;
  lastScheduledSamplingReason?: string;
  lastScheduledSamplingReadingCount: number;
};

export type BodySignalGuardianBatteryEvent = {
  eventId: string;
  type: 'battery';
  deviceProfileId: string;
  observedAt: number;
  percent: number;
  charging?: boolean;
};

export type BodySignalGuardianEvent = BodySignalGuardianBatteryEvent
  | { eventId: string; type: 'activity_batch'; deviceProfileId: string; observedAt: number; batch: MiBand6ActivityBatch }
  | {
    bpm: number;
    deviceProfileId: string;
    eventId: string;
    observedAt: number;
    type: 'heart_rate';
  }
  | {
    deviceProfileId: string;
    eventId: string;
    observedAt: number;
    status?: BodySignalGuardianStatus;
    type: 'state';
  }
  | {
    deviceProfileId: string;
    durationMs: number;
    endedAt: number;
    eventId: string;
    observedAt: number;
    readingCount: number;
    reason: BodySignalScheduledSamplingReason;
    requestedAt: number;
    result: BodySignalScheduledSamplingResult;
    startedAt?: number;
    trigger: BodySignalScheduledSamplingTrigger;
    type: 'sampling_window';
    windowId: string;
  };

type BodySignalGuardianNativePayload =
  | { event: BodySignalGuardianEvent; type: 'event' }
  | { state: BodySignalGuardianState; type: 'state' };

type BodySignalGuardianNativeModule = {
  getBodySignalCareState?(): Promise<string | null>;
  compareAndSetBodySignalCareState?(expectedRevision: number, valueJson: string): Promise<boolean>;
  releaseBodySignalCareDispatch?(): Promise<boolean>;
  resetBodySignalCareForRestore?(): Promise<boolean>;
  acknowledgeGuardianEvents(eventIds: string[]): Promise<boolean>;
  addListener(eventName: string): void;
  cancelScheduledSampling(): Promise<boolean>;
  configureScheduledSampling(enabled: boolean, pauseUntil?: number): Promise<boolean>;
  disableGuardian(): Promise<boolean>;
  enableGuardian(): Promise<BodySignalGuardianState>;
  getGuardianState(): Promise<BodySignalGuardianState>;
  getGuardianSupport(): Promise<BodySignalGuardianSupport>;
  getPendingGuardianEvents(): Promise<BodySignalGuardianEvent[]>;
  evaluateScheduledSampling(trigger: string): Promise<boolean>;
  pauseGuardian(): Promise<boolean>;
  provisionPrimaryDevice(
    deviceProfileId: string,
    associationId: number,
    authKeyHex: string,
    appeared: boolean,
  ): Promise<BodySignalGuardianState>;
  releaseGuardianForForegroundScan(): Promise<boolean>;
  removeListeners(count: number): void;
  resumeGuardian(): Promise<boolean>;
  retryGuardianNow(): Promise<boolean>;
  startGuardianFiveMinuteHeartRate(): Promise<boolean>;
  stopGuardianHeartRate(): Promise<boolean>;
  syncGuardianTime?(): Promise<number>;
  readGuardianBatteryReading?(deviceProfileId: string, trigger: MiBand6BatteryTrigger): Promise<BodySignalGuardianBatteryEvent>;
  beginLegacyMiBand6BatteryRead?(deviceProfileId: string, trigger: MiBand6BatteryTrigger): Promise<number>;
  completeLegacyMiBand6BatteryRead?(deviceProfileId: string, trigger: MiBand6BatteryTrigger, attemptedAt: number,
    percent: number, charging: boolean | null, measuredAt: number): Promise<BodySignalGuardianBatteryEvent>;
  restoreSavedGuardianBattery?(deviceProfileId: string, percent: number, measuredAt: number): Promise<boolean>;
};

const GUARDIAN_EVENT_NAME = 'junluoBodySignalGuardian';

export const EMPTY_BODY_SIGNAL_GUARDIAN_STATE: BodySignalGuardianState = {
  appeared: false,
  enabled: false,
  lastTransitionAt: 0,
  owner: 'legacy_js',
  paused: false,
  retryAttempt: 0,
  scheduledSamplingEnabled: false,
  scheduledSamplingStatus: 'disabled',
  lastScheduledSamplingReadingCount: 0,
  status: 'idle',
};

function nativeModule(): BodySignalGuardianNativeModule | undefined {
  if (Platform.OS !== 'android') return undefined;
  return NativeModules.JunLuoBodySignalGuardian as BodySignalGuardianNativeModule | undefined;
}

export async function getGuardianSupport(): Promise<BodySignalGuardianSupport> {
  const module = nativeModule();
  if (!module) {
    return {
      bluetoothConnectPermissionGranted: false,
      notificationPermissionGranted: false,
      reason: 'android_api_below_33',
      supported: false,
    };
  }
  return module.getGuardianSupport();
}

export async function provisionPrimaryDevice(input: {
  appeared: boolean;
  associationId: number;
  authKeyHex: string;
  deviceProfileId: string;
}): Promise<BodySignalGuardianState> {
  const module = nativeModule();
  if (!module) throw new Error('当前安装包缺少全天守候模块，请重新安装 Dev Client。');
  return module.provisionPrimaryDevice(
    input.deviceProfileId,
    input.associationId,
    input.authKeyHex,
    input.appeared,
  );
}

export async function restoreSavedGuardianBattery(profileId: string, percent: number, measuredAt: number) {
  const module = nativeModule();
  if (!module?.restoreSavedGuardianBattery) return;
  if (!await module.restoreSavedGuardianBattery(profileId, percent, measuredAt)) throw new Error('battery_save_failed');
}

export async function enableGuardian(): Promise<BodySignalGuardianState> {
  const module = nativeModule();
  if (!module) throw new Error('当前安装包缺少全天守候模块，请重新安装 Dev Client。');
  return module.enableGuardian();
}

export async function disableGuardian(): Promise<void> {
  await nativeModule()?.disableGuardian();
}

export async function pauseGuardian(): Promise<void> {
  await nativeModule()?.pauseGuardian();
}

export async function resumeGuardian(): Promise<void> {
  await nativeModule()?.resumeGuardian();
}

export async function retryGuardianNow(): Promise<void> {
  await nativeModule()?.retryGuardianNow();
}

export async function releaseGuardianForForegroundScan(): Promise<void> {
  await nativeModule()?.releaseGuardianForForegroundScan();
}

export async function startGuardianFiveMinuteHeartRate(): Promise<void> {
  const module = nativeModule();
  if (!module) throw new Error('当前安装包缺少全天守候模块，请重新安装 Dev Client。');
  await module.startGuardianFiveMinuteHeartRate();
}

export async function syncGuardianTime(): Promise<number> {
  const module = nativeModule();
  if (!module?.syncGuardianTime) throw new Error('time_sync_update_required');
  return module.syncGuardianTime();
}

export async function readGuardianBattery(deviceProfileId: string, trigger: MiBand6BatteryTrigger): Promise<BodySignalGuardianBatteryEvent> {
  const module = nativeModule();
  if (!module?.readGuardianBatteryReading) throw new Error('battery_update_required');
  return module.readGuardianBatteryReading(deviceProfileId, trigger);
}

export async function beginLegacyMiBand6BatteryRead(deviceProfileId: string, trigger: MiBand6BatteryTrigger) {
  const module = nativeModule();
  if (!module?.beginLegacyMiBand6BatteryRead || !module.completeLegacyMiBand6BatteryRead) throw new Error('battery_update_required');
  return module.beginLegacyMiBand6BatteryRead(deviceProfileId, trigger);
}

export async function completeLegacyMiBand6BatteryRead(deviceProfileId: string, trigger: MiBand6BatteryTrigger,
  attemptedAt: number, value: MiBand6BatteryValue, measuredAt: number): Promise<BodySignalGuardianBatteryEvent> {
  const module = nativeModule();
  if (!module?.completeLegacyMiBand6BatteryRead) throw new Error('battery_update_required');
  return module.completeLegacyMiBand6BatteryRead(deviceProfileId, trigger, attemptedAt, value.percent, value.charging ?? null, measuredAt);
}

export async function stopGuardianHeartRate(): Promise<void> {
  await nativeModule()?.stopGuardianHeartRate();
}

export async function configureScheduledSampling(
  enabled: boolean,
  pauseUntil?: number,
): Promise<void> {
  const module = nativeModule();
  if (!module) throw new Error('当前安装包缺少节制采样模块，请重新安装 Dev Client。');
  await module.configureScheduledSampling(enabled, pauseUntil ?? -1);
}

export async function evaluateScheduledSampling(trigger: string): Promise<void> {
  const module = nativeModule();
  if (!module) throw new Error('当前安装包缺少节制采样模块，请重新安装 Dev Client。');
  await module.evaluateScheduledSampling(trigger);
}

export async function cancelScheduledSampling(): Promise<void> {
  await nativeModule()?.cancelScheduledSampling();
}

export async function getGuardianState(): Promise<BodySignalGuardianState> {
  const module = nativeModule();
  return module ? module.getGuardianState() : { ...EMPTY_BODY_SIGNAL_GUARDIAN_STATE };
}

export async function readNativeBodySignalCareState<T extends object = Record<string, unknown>>(): Promise<T | null> {
  const raw = await nativeModule()?.getBodySignalCareState?.();
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export async function writeNativeBodySignalCareState(revision: number, value: object): Promise<boolean> {
  return (await nativeModule()?.compareAndSetBodySignalCareState?.(revision, JSON.stringify(value))) === true;
}

export async function releaseNativeBodySignalCareDispatch(): Promise<void> {
  await nativeModule()?.releaseBodySignalCareDispatch?.();
}

export async function resetNativeBodySignalCareForRestore(): Promise<boolean> {
  return (await nativeModule()?.resetBodySignalCareForRestore?.()) === true;
}

export async function getPendingGuardianEvents(): Promise<BodySignalGuardianEvent[]> {
  return nativeModule()?.getPendingGuardianEvents() ?? [];
}

export async function acknowledgeGuardianEvents(eventIds: readonly string[]): Promise<void> {
  if (!eventIds.length) return;
  await nativeModule()?.acknowledgeGuardianEvents([...eventIds]);
}

export function subscribeGuardian(
  listener: (payload: BodySignalGuardianNativePayload) => void,
): () => void {
  const module = nativeModule();
  if (!module) return () => undefined;
  const emitter = new NativeEventEmitter(module as never);
  const subscription = emitter.addListener(GUARDIAN_EVENT_NAME, (payload: BodySignalGuardianNativePayload) => {
    if (payload?.type === 'state' && payload.state) listener(payload);
    if (payload?.type === 'event' && payload.event?.eventId) listener(payload);
  });
  return () => subscription.remove();
}
