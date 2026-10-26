import { AppState } from 'react-native';
import { saveMiBand6ActivityBatch } from './bodySignalActivityStore';
import { MI_BAND_6_ACTIVITY_VERIFIED } from './colmi/miBand6ActivityProtocol';
import type { MiBand6ActivityEvent } from './miBand6ActivityNative';

import {
  acknowledgeGuardianEvents,
  EMPTY_BODY_SIGNAL_GUARDIAN_STATE,
  configureScheduledSampling,
  evaluateScheduledSampling,
  getGuardianState,
  getPendingGuardianEvents,
  subscribeGuardian,
  type BodySignalGuardianEvent,
  type BodySignalGuardianBatteryEvent,
  type BodySignalGuardianState,
} from './bodySignalGuardian';
import { bodySignalGuardianStatusMessage, guardianOwnsBodySignalConnection } from './bodySignalGuardianPolicy';
import {
  loadScheduledSamplingSettings,
  saveBodySignalGuardianReading,
  saveScheduledSamplingSettings,
  saveScheduledSamplingWindow,
} from './bodySignalStore';
import type { BodySignalLiveSnapshot, StoredBodySignalReading } from './bodySignalTypes';
import { loadPersistedBodySignalDeviceProfiles, loadPersistedPrimaryBodySignalDeviceProfile } from './device/bodySignalDeviceRepository';

type GuardianRuntimeListener = (snapshot: BodySignalLiveSnapshot) => void;
type GuardianStateListener = (state: BodySignalGuardianState) => void;

let state: BodySignalGuardianState = { ...EMPTY_BODY_SIGNAL_GUARDIAN_STATE };
let latestHeartRate: StoredBodySignalReading | undefined;
let latestBattery: StoredBodySignalReading | undefined;
let latestBatteryCharging: boolean | undefined;
let started = false;
let nativeSubscription: (() => void) | undefined;
let appStateSubscription: { remove(): void } | undefined;
let persistenceTail: Promise<void> = Promise.resolve();
const listeners = new Set<GuardianRuntimeListener>();
const stateListeners = new Set<GuardianStateListener>();
const activitySavedListeners = new Set<() => void>();

export function subscribeGuardianActivitySaved(listener: () => void): () => void {
  activitySavedListeners.add(listener);
  return () => { activitySavedListeners.delete(listener); };
}

function notifyActivitySaved() {
  for (const listener of activitySavedListeners) {
    try { listener(); } catch { /* UI listeners cannot invalidate an acknowledged batch. */ }
  }
}

function toContinuousStatus(current: BodySignalGuardianState) {
  if (current.status === 'sampling') return 'running' as const;
  if (current.status === 'starting') return 'starting' as const;
  if (current.status === 'stopping') return 'stopping' as const;
  if (current.status === 'error') return 'error' as const;
  return 'idle' as const;
}

export function getGuardianBodySignalLiveSnapshot(): BodySignalLiveSnapshot {
  const heartRate = latestHeartRate?.deviceProfileId === state.deviceProfileId ? latestHeartRate : undefined;
  const owned = guardianOwnsBodySignalConnection(state);
  const connected = owned && (state.status === 'ready' || state.status === 'sampling');
  const busy = owned && ['starting', 'connecting', 'discovering', 'authenticating', 'stopping'].includes(state.status);
  return {
    ...getSavedMiBand6Battery(state.deviceProfileId, connected, state.lastConnectedAt),
    canMeasureHeartRate: connected,
    connection: {
      deviceProfileId: state.deviceProfileId,
      deviceFamily: 'mi_band_6',
      deviceName: heartRate?.sourceDeviceName,
      isConnected: connected,
      statusMessage: bodySignalGuardianStatusMessage(state),
    },
    heartRate,
    heartRateContinuousSession: owned ? {
      ...(state.samplingEndsAt ? { endsAt: state.samplingEndsAt } : {}),
      ...(state.lastErrorCode ? { errorMessage: state.lastErrorCode } : {}),
      status: toContinuousStatus(state),
    } : undefined,
    heartRateControlMode: owned ? 'continuous' : 'none',
    heartRateMeasurementErrorMessage: state.status === 'error' ? '全天守候暂时遇到错误，请到设置页重试。' : undefined,
    heartRateMeasurementStatus: state.status === 'error'
      ? 'error'
      : state.status === 'sampling'
        ? heartRate ? 'received' : 'waiting'
        : busy ? 'starting' : heartRate ? 'received' : 'idle',
    isConnectionBusy: busy,
  };
}

export function getSavedMiBand6Battery(profileId: string | undefined, connected: boolean, connectedAt?: number) {
  const battery = profileId && latestBattery?.deviceProfileId === profileId ? latestBattery : undefined;
  return {
    battery,
    batteryCharging: battery && connected && connectedAt !== undefined && battery.measuredAt >= connectedAt
      && Date.now() - battery.measuredAt <= 120_000 ? latestBatteryCharging : undefined,
  };
}

function emit(): void {
  const snapshot = getGuardianBodySignalLiveSnapshot();
  listeners.forEach((listener) => listener(snapshot));
  const stateSnapshot = { ...state };
  stateListeners.forEach((listener) => listener(stateSnapshot));
}

async function persistEvent(event: BodySignalGuardianEvent): Promise<boolean> {
  if (event.type === 'activity_batch') {
    if (!MI_BAND_6_ACTIVITY_VERIFIED) return false;
    await saveMiBand6ActivityBatch(event.deviceProfileId, event.batch);
    return true;
  }
  if (event.type === 'sampling_window') {
    await saveScheduledSamplingWindow({
      deviceProfileId: event.deviceProfileId,
      durationMs: event.durationMs,
      endedAt: event.endedAt,
      id: event.windowId,
      readingCount: event.readingCount,
      reason: event.reason,
      requestedAt: event.requestedAt,
      result: event.result,
      ...(event.startedAt ? { startedAt: event.startedAt } : {}),
      trigger: event.trigger,
    });
    return true;
  }
  if (event.type !== 'heart_rate' && event.type !== 'battery') return true;
  const profile = (await loadPersistedBodySignalDeviceProfiles()).find(item => item.id === event.deviceProfileId);
  if (!profile) return false;
  const reading: StoredBodySignalReading = {
    confidence: 'high',
    deviceProfileId: event.deviceProfileId,
    kind: event.type,
    measuredAt: event.observedAt,
    sourceDeviceName: profile.displayName,
    ...(event.type === 'battery'
      ? { sourceProvider: 'mi_band_6' as const, unit: '%', value: event.percent }
      : { sourceProvider: 'standard_gatt' as const, unit: 'bpm', value: event.bpm }),
  };
  const result = await saveBodySignalGuardianReading(event.eventId, reading);
  const primary = result === 'saved' ? await loadPersistedPrimaryBodySignalDeviceProfile() : undefined;
  if (event.type === 'battery') {
    if (primary?.id === reading.deviceProfileId && (!latestBattery
      || latestBattery.deviceProfileId !== reading.deviceProfileId || reading.measuredAt > latestBattery.measuredAt)) {
      latestBattery = reading;
      latestBatteryCharging = event.charging;
      emit();
    }
    return true;
  }
  if (primary?.id === reading.deviceProfileId && state.deviceProfileId === reading.deviceProfileId
    && (!latestHeartRate || latestHeartRate.deviceProfileId !== reading.deviceProfileId
      || reading.measuredAt > latestHeartRate.measuredAt)) {
    latestHeartRate = reading;
    emit();
  }
  return true;
}

async function consumeEvents(events: readonly BodySignalGuardianEvent[]): Promise<void> {
  const acknowledged: string[] = [];
  for (const event of events) {
    try {
      if (await persistEvent(event)) acknowledged.push(event.eventId);
    } catch {
      if (event.type === 'activity_batch') continue;
      break;
    }
  }
  await acknowledgeGuardianEvents(acknowledged);
  if (events.some(event => event.type === 'activity_batch' && acknowledged.includes(event.eventId))) notifyActivitySaved();
}

function enqueueEvents(events: readonly BodySignalGuardianEvent[]): Promise<void> {
  const task = persistenceTail.then(() => consumeEvents(events));
  persistenceTail = task.catch(() => undefined);
  return task;
}

export function persistGuardianBatteryEvent(event: BodySignalGuardianBatteryEvent): Promise<void> {
  const task = persistenceTail.then(async () => {
    if (!await persistEvent(event)) throw new Error('battery_profile_missing');
    await acknowledgeGuardianEvents([event.eventId]);
  });
  persistenceTail = task.catch(() => undefined);
  return task;
}

export function persistGuardianActivityEvent(event: MiBand6ActivityEvent): Promise<void> {
  const task = persistenceTail.then(async () => {
    if (!await persistEvent(event)) throw new Error('activity_evidence_required');
    await acknowledgeGuardianEvents([event.eventId]);
    notifyActivitySaved();
  });
  persistenceTail = task.catch(() => undefined);
  return task;
}

export async function refreshBodySignalGuardianRuntime(
  trigger?: 'foreground' | 'settings_resume',
): Promise<void> {
  const [nextState, events] = await Promise.all([
    getGuardianState(),
    getPendingGuardianEvents(),
  ]);
  state = nextState;
  emit();
  await enqueueEvents(events);
  const settings = await loadScheduledSamplingSettings();
  if (!nextState.enabled && settings.enabled) {
    await saveScheduledSamplingSettings({ enabled: false });
  } else if (nextState.enabled && (
    settings.enabled !== nextState.scheduledSamplingEnabled
    || settings.pauseUntil !== nextState.scheduledSamplingPauseUntil
  )) {
    await configureScheduledSampling(settings.enabled, settings.pauseUntil);
  }
  if (trigger && settings.enabled && nextState.enabled) {
    await evaluateScheduledSampling(trigger);
  }
}

export function getBodySignalGuardianRuntimeState(): BodySignalGuardianState {
  return { ...state };
}

// Care consumes actual readings only; it must never reconcile or start sampling.
export async function consumeBodySignalGuardianReadings(): Promise<void> {
  await enqueueEvents(await getPendingGuardianEvents());
}

export function subscribeBodySignalGuardianRuntime(listener: GuardianRuntimeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function subscribeBodySignalGuardianState(listener: GuardianStateListener): () => void {
  stateListeners.add(listener);
  listener({ ...state });
  return () => stateListeners.delete(listener);
}

export function startBodySignalGuardianRuntime(): () => void {
  if (started) return () => undefined;
  started = true;
  nativeSubscription = subscribeGuardian((payload) => {
    if (payload.type === 'state') {
      state = payload.state;
      emit();
      return;
    }
    void enqueueEvents([payload.event]).catch(() => undefined);
  });
  appStateSubscription = AppState.addEventListener('change', (next) => {
    if (next === 'active') void refreshBodySignalGuardianRuntime('foreground').catch(() => undefined);
  });
  void refreshBodySignalGuardianRuntime().catch(() => undefined);
  return () => {
    nativeSubscription?.();
    appStateSubscription?.remove();
    nativeSubscription = undefined;
    appStateSubscription = undefined;
    started = false;
  };
}
