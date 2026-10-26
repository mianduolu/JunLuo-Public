import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { AppState } from 'react-native';

import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
} from '../backup/backupRestoreCoordinator';
import { fetchAmapNearbySnapshot, fetchAmapNearbyPois, fetchAmapReverseGeocode } from './amapNearbyProvider';
import { runAmapQuery } from './amapQueryPolicy';
import { isFreshLocation, isFreshNearbyStatus, validLocationPoint, resolveNearbyPresence, shouldAttemptAutomaticMap } from './nearbyLocationPolicy';
import { withValidPresenceReport } from './nearbyPresence';
import {
  createNearbyWorldActiveEvent,
  enqueueNearbyWorldActiveEvent,
  selectNearbyWorldActiveEventKind,
  recordNearbyOutingPointWithinCommit,
} from './nearbyWorldActiveEvents';
import {
  loadNearbyWorldSettings,
  loadNearbyWorldStatus,
  pauseNearbyWorldAutoTogether,
  saveNearbyWorldSettings,
  saveNearbyWorldStatus,
  startNearbyWorldPrecisionMode,
  stopNearbyWorldPrecisionMode,
  type NearbyWorldBackgroundProfile,
  type NearbyWorldBatteryState,
  type NearbyWorldGpsQuality,
  type NearbyWorldPermissionStatus,
  type NearbyWorldPresence,
  type NearbyWorldPrecisionMode,
  type NearbyWorldSettings,
  type NearbyWorldSnapshot,
  type NearbyWorldStatus,
  type NearbyWorldStopReason,
} from './nearbyWorldStore';
import {
  runNearbyWorldDataEpochCommit,
  runNearbyWorldExternalStep,
} from './nearbyWorldEpochCoordinator';
import { loadEmergencySyncWorldRebuildSnapshot } from '../sync/syncEmergencyWorldRebuildStore';

export const NEARBY_WORLD_LOCATION_TASK = 'junluo-nearby-world-location';

type LocationTaskData = {
  locations?: Location.LocationObject[];
};

type NearbyWorldWatcher = { generation: number };

async function maybeEnqueueNearbyWorldActiveEvent(
  previous: NearbyWorldStatus,
  next: NearbyWorldStatus,
  dataEpoch: number | null,
  now = Date.now(),
) {
  const kind = selectNearbyWorldActiveEventKind(previous, next);
  if (!kind) return;
  await enqueueNearbyWorldActiveEvent(createNearbyWorldActiveEvent(kind, next, now), dataEpoch).catch((error) => {
    console.warn('[NearbyWorld] Failed to enqueue active message event', error);
  });
}

async function maybeEnqueueNearbyWorldUnstableEvent(
  status: NearbyWorldStatus,
  dataEpoch: number | null,
  now = Date.now(),
) {
  if (status.precisionMode === 'off') return;
  await enqueueNearbyWorldActiveEvent(createNearbyWorldActiveEvent('location-unstable', status, now), dataEpoch).catch((error) => {
    console.warn('[NearbyWorld] Failed to enqueue unstable location event', error);
  });
}

const HOME_RADIUS_METERS = 220;
const LOW_ACCURACY_WARNING_METERS = 1000;
const SET_HOME_MAX_ACCURACY_METERS = 50;
const BACKGROUND_WORSE_ACCURACY_GRACE_MS = 2 * 60 * 60 * 1000;
const MANUAL_WORSE_ACCURACY_GRACE_MS = 10 * 60 * 1000;
const PRECISE_LOCATION_ATTEMPTS = 3;
const PRECISION_SAMPLE_LIMIT = 8;
const PRECISION_STALE_QUALITY_MS = 5 * 60 * 1000;
const PRECISION_TINY_DRIFT_METERS = 1;
const PRECISION_POOR_ACCURACY_METERS = 50;
const PRECISION_WORSE_ACCURACY_MARGIN_METERS = 50;
const PRECISION_BETTER_SAMPLE_MARGIN_METERS = 40;
const PRECISION_LARGE_JUMP_METERS = 5000;
const MAX_REASONABLE_WALKING_SPEED_MPS = 8;
const MAX_REASONABLE_TRANSIT_SPEED_MPS = 120;
const DAILY_BACKGROUND_DISTANCE_METERS = 20;
const DAILY_BACKGROUND_INTERVAL_MS = 60 * 1000;
const PRECISION_BACKGROUND_DISTANCE_METERS = 20;
const PRECISION_BACKGROUND_INTERVAL_MS = 60 * 1000;
const ARRIVED_HOME_STABLE_MS = 10 * 60 * 1000;
const WALKING_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const TRANSIT_IDLE_TIMEOUT_MS = 90 * 60 * 1000;
const LOW_BATTERY_LEVEL = 0.2;
const AUTO_TOGETHER_SAMPLE_LIMIT = 6;
const AUTO_TOGETHER_SAMPLE_MAX_AGE_MS = 10 * 60 * 1000;
const AUTO_TOGETHER_TRUSTED_ACCURACY_METERS = 50;
const AUTO_TOGETHER_PAUSE_MS = 2 * 60 * 60 * 1000;
const AUTO_WALKING_REQUIRED_SAMPLES = 3;
const AUTO_WALKING_MIN_DISTANCE_METERS = 20;
const AUTO_WALKING_MIN_SPEED_MPS = 0.4;
const AUTO_WALKING_MAX_SPEED_MPS = 2.5;
const AUTO_TRANSIT_MIN_SPEED_MPS = 4;
const AUTO_TRANSIT_MIN_DISTANCE_METERS = 250;
const AUTO_TRANSIT_WINDOW_MS = 60 * 1000;
const AUTO_STILL_DISTANCE_METERS = 8;

let precisionWatcher: Location.LocationSubscription | null = null;
let watcherGeneration = 0;
function isCurrentNearbyWorldWatcher(watcher?: NearbyWorldWatcher): boolean {
  return !watcher || watcher.generation === watcherGeneration;
}
let precisionWatcherMode: NearbyWorldPrecisionMode | null = null;
let automaticMapInFlight = false;
let precisionSamples: Location.LocationObject[] = [];
let autoTogetherSamples: Location.LocationObject[] = [];
let precisionQualityTimeout: ReturnType<typeof setTimeout> | null = null;
let backgroundSyncTail: Promise<void> = Promise.resolve();

if (!TaskManager.isTaskDefined(NEARBY_WORLD_LOCATION_TASK)) {
  TaskManager.defineTask(NEARBY_WORLD_LOCATION_TASK, async ({ data, error }) => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    try {
      const rebuild = await loadEmergencySyncWorldRebuildSnapshot();
      if (rebuild.active) return;
      if (error) {
        await runNearbyWorldDataEpochCommit(
          dataEpoch,
          () => mergeNearbyWorldStatus({ lastError: error.message, backgroundActive: false }),
        );
        return;
      }
      const location = (data as LocationTaskData | undefined)?.locations
        ?.filter(point => validLocationPoint({ ...point.coords, timestamp: point.timestamp }))
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      if (!location) return;
      await handleNearbyWorldBackgroundLocation(location, dataEpoch);
    } catch {
      return;
    }
  });
}

export async function requestNearbyWorldPermissions(
  options: { background?: boolean; dataEpoch?: number | null; watcher?: NearbyWorldWatcher } = {},
): Promise<NearbyWorldPermissionStatus | null> {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  if (!isCurrentNearbyWorldWatcher(options.watcher)) return null;
  const foregroundStep = await runNearbyWorldExternalStep(
    dataEpoch,
    () => Location.requestForegroundPermissionsAsync(),
  );
  if (!foregroundStep.current || !isCurrentNearbyWorldWatcher(options.watcher)) return null;
  const foreground = foregroundStep.value;
  if (!foreground.granted) {
    const status = await commitNearbyWorldStatusMutation(
      dataEpoch,
      () => mergeNearbyWorldStatus({ permissionStatus: 'denied', backgroundActive: false }),
      options.watcher,
    );
    return status ? 'denied' : null;
  }
  if (!options.background) {
    const status = await commitNearbyWorldStatusMutation(
      dataEpoch,
      () => mergeNearbyWorldStatus({ permissionStatus: 'foreground' }),
      options.watcher,
    );
    return status ? 'foreground' : null;
  }
  const backgroundStep = await runNearbyWorldExternalStep(
    dataEpoch,
    () => Location.requestBackgroundPermissionsAsync(),
  );
  if (!backgroundStep.current || !isCurrentNearbyWorldWatcher(options.watcher)) return null;
  const background = backgroundStep.value;
  const permissionStatus: NearbyWorldPermissionStatus = background.granted ? 'background' : 'foreground';
  const status = await commitNearbyWorldStatusMutation(
    dataEpoch,
    () => mergeNearbyWorldStatus({ permissionStatus }),
    options.watcher,
  );
  return status ? permissionStatus : null;
}

export function syncNearbyWorldBackgroundTask(
  options: { dataEpoch?: number | null } = {},
): Promise<boolean> {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const run = () => syncNearbyWorldBackgroundTaskNow(dataEpoch);
  const result = backgroundSyncTail.then(run, run);
  backgroundSyncTail = result.then(() => undefined, () => undefined);
  return result;
}

async function syncNearbyWorldBackgroundTaskNow(dataEpoch: number | null): Promise<boolean> {
  const reconciled = await reconcileNearbyWorldPrecisionState({ dataEpoch, syncBackground: false });
  if (!reconciled) return false;
  const snapshotCommit = await runNearbyWorldDataEpochCommit(dataEpoch, async () => {
    const [settings, status] = await Promise.all([loadNearbyWorldSettings(), loadNearbyWorldStatus()]);
    return { settings, status };
  });
  if (!snapshotCommit.committed) return false;
  const { settings, status } = snapshotCommit.value;
  if (!settings.enabled || !settings.backgroundEnabled) {
    if (!settings.enabled || AppState.currentState !== 'active') await clearPrecisionWatcher(dataEpoch);
    await stopNearbyWorldBackgroundTask({ dataEpoch });
    return false;
  }
  if (AppState.currentState === 'active') {
    await stopNearbyWorldBackgroundTask({ dataEpoch });
    return false;
  }
  await clearPrecisionWatcher(dataEpoch);
  const desiredProfile = getDesiredBackgroundProfile(status);
  const permissionStep = await runNearbyWorldExternalStep(dataEpoch, () => readExistingPermissionStatus());
  if (!permissionStep.current) return false;
  const permissionStatus = permissionStep.value;
  if (permissionStatus !== 'background') {
    await stopNearbyWorldBackgroundTask({ dataEpoch });
    await runNearbyWorldDataEpochCommit(
      dataEpoch,
      () => mergeNearbyWorldStatus({ permissionStatus, backgroundActive: false, backgroundProfile: undefined }),
    );
    return false;
  }
  let observedBackgroundActive = status.backgroundActive;
  let observedBackgroundProfile = status.backgroundProfile;
  try {
    const startedStep = await runNearbyWorldExternalStep(
      dataEpoch,
      () => Location.hasStartedLocationUpdatesAsync(NEARBY_WORLD_LOCATION_TASK),
    );
    if (!startedStep.current) return false;
    const started = startedStep.value;
    observedBackgroundActive = started;
    if (!started) observedBackgroundProfile = undefined;
    if (started && status.backgroundProfile !== desiredProfile) {
      const stopStep = await runNearbyWorldExternalStep(
        dataEpoch,
        () => Location.stopLocationUpdatesAsync(NEARBY_WORLD_LOCATION_TASK),
      );
      if (!stopStep.current) return false;
      observedBackgroundActive = false;
      observedBackgroundProfile = undefined;
    }
    if (!started || status.backgroundProfile !== desiredProfile) {
      const startStep = await runNearbyWorldExternalStep(
        dataEpoch,
        () => Location.startLocationUpdatesAsync(NEARBY_WORLD_LOCATION_TASK, getBackgroundTaskOptions(desiredProfile)),
      );
      if (!startStep.current) {
        await Location.stopLocationUpdatesAsync(NEARBY_WORLD_LOCATION_TASK).catch(() => undefined);
        return false;
      }
      observedBackgroundActive = true;
      observedBackgroundProfile = desiredProfile;
    }
    const committed = await runNearbyWorldDataEpochCommit(dataEpoch, () => mergeNearbyWorldStatus({
        permissionStatus: 'background',
        backgroundActive: true,
        backgroundProfile: desiredProfile,
        lastError: undefined,
      }));
    return committed.committed;
  } catch (error) {
    console.warn('[NearbyWorld] Failed to start background location', error);
    await runNearbyWorldDataEpochCommit(dataEpoch, () => mergeNearbyWorldStatus({
        permissionStatus,
        backgroundActive: observedBackgroundActive,
        backgroundProfile: observedBackgroundProfile,
        lastError: error instanceof Error ? error.message : '后台位置心跳启动失败',
      }));
    return false;
  }
}

export async function reconcileNearbyWorldPrecisionState(
  options: { dataEpoch?: number | null; syncBackground?: boolean; watcher?: NearbyWorldWatcher } = {},
): Promise<NearbyWorldStatus | null> {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const watcher = options.watcher ?? { generation: watcherGeneration };
  const now = Date.now();
  const snapshotCommit = await runNearbyWorldDataEpochCommit(dataEpoch, async () => {
    const [settings, status] = await Promise.all([loadNearbyWorldSettings(), loadNearbyWorldStatus()]);
    return { settings, status };
  });
  if (!snapshotCommit.committed || !isCurrentNearbyWorldWatcher(watcher)) return null;
  const { settings } = snapshotCommit.value;
  let { status } = snapshotCommit.value;
  status = await withValidPresenceReport(status);
  const batteryStep = await runNearbyWorldExternalStep(dataEpoch, () => readBatteryStatusPatch(now));
  if (!batteryStep.current || !isCurrentNearbyWorldWatcher(watcher)) return null;
  const batteryPatch = batteryStep.value;
  if (Object.keys(batteryPatch).length) {
    const next = await commitNearbyWorldStatusMutation(dataEpoch, () => mergeNearbyWorldStatus(batteryPatch), watcher);
    if (!next) return null;
    status = await withValidPresenceReport(next);
  }

  if (!settings.enabled) {
    if (!await clearPrecisionWatcher(dataEpoch, watcher)) return null;
    if (status.precisionMode !== 'off') {
      if (!await clearPrecisionWatcher(dataEpoch, watcher)) return null;
      const stopped = await commitNearbyWorldStatusMutation(dataEpoch, () => stopNearbyWorldPrecisionMode('disabled'), watcher);
      if (!stopped) return null;
      status = stopped;
    }
    if (options.syncBackground !== false) await syncNearbyWorldBackgroundTask({ dataEpoch });
    return canCommitBackupRestoreDataEpoch(dataEpoch) ? status : null;
  }

  if (status.precisionMode === 'off') {
    if (options.syncBackground !== false) await syncNearbyWorldBackgroundTask({ dataEpoch });
    return canCommitBackupRestoreDataEpoch(dataEpoch) ? status : null;
  }

  if (typeof status.precisionExpiresAt === 'number' && status.precisionExpiresAt <= now) {
    if (!await clearPrecisionWatcher(dataEpoch, watcher)) return null;
    const stopped = await commitNearbyWorldStatusMutation(
      dataEpoch,
      () => stopNearbyWorldPrecisionMode('system_interrupted'),
      watcher,
    );
    if (!stopped) return null;
    status = stopped;
    if (options.syncBackground !== false) await syncNearbyWorldBackgroundTask({ dataEpoch });
    return canCommitBackupRestoreDataEpoch(dataEpoch) ? status : null;
  }

  const permissionStep = await runNearbyWorldExternalStep(dataEpoch, () => readExistingPermissionStatus());
  if (!permissionStep.current || !isCurrentNearbyWorldWatcher(watcher)) return null;
  const permissionStatus = permissionStep.value;
  if (permissionStatus !== 'foreground' && permissionStatus !== 'background') {
    if (!await clearPrecisionWatcher(dataEpoch, watcher)) return null;
    const stopped = await commitNearbyWorldStatusMutation(dataEpoch, async () => {
      await mergeNearbyWorldStatus({ permissionStatus, backgroundActive: false });
      return stopNearbyWorldPrecisionMode('permission_lost');
    }, watcher);
    if (!stopped) return null;
    status = stopped;
    if (options.syncBackground !== false) await syncNearbyWorldBackgroundTask({ dataEpoch });
    return canCommitBackupRestoreDataEpoch(dataEpoch) ? status : null;
  }

  const stopReason = getPrecisionAutoStopReason(status, now);
  if (stopReason) {
    if (!await clearPrecisionWatcher(dataEpoch, watcher)) return null;
    const stopped = await commitNearbyWorldStatusMutation(dataEpoch, () => stopNearbyWorldPrecisionMode(stopReason), watcher);
    if (!stopped) return null;
    status = stopped;
    if (options.syncBackground !== false) await syncNearbyWorldBackgroundTask({ dataEpoch });
    return canCommitBackupRestoreDataEpoch(dataEpoch) ? status : null;
  }

  const next = await commitNearbyWorldStatusMutation(dataEpoch, () => mergeNearbyWorldStatus({ permissionStatus }), watcher);
  if (!next) return null;
  if (options.syncBackground !== false) await syncNearbyWorldBackgroundTask({ dataEpoch });
  return canCommitBackupRestoreDataEpoch(dataEpoch) ? next : null;
}

export async function stopNearbyWorldBackgroundTask(
  options: { dataEpoch?: number | null } = {},
): Promise<boolean> {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  try {
    const startedStep = await runNearbyWorldExternalStep(
      dataEpoch,
      () => Location.hasStartedLocationUpdatesAsync(NEARBY_WORLD_LOCATION_TASK),
    );
    if (!startedStep.current) return false;
    if (startedStep.value) {
      const stopStep = await runNearbyWorldExternalStep(
        dataEpoch,
        () => Location.stopLocationUpdatesAsync(NEARBY_WORLD_LOCATION_TASK),
      );
      if (!stopStep.current) return false;
    }
  } catch (error) {
    console.warn('[NearbyWorld] Failed to stop background location', error);
    throw error;
  }
  const committed = await runNearbyWorldDataEpochCommit(
    dataEpoch,
    () => mergeNearbyWorldStatus({ backgroundActive: false, backgroundProfile: undefined }),
  );
  return committed.committed;
}

export async function startNearbyWorldPrecisionWatcher(
  mode: Exclude<NearbyWorldPrecisionMode, 'off'>,
  metadata: {
    autoTogetherReason?: 'walking_detected' | 'transit_detected' | null;
    dataEpoch?: number | null;
    watcher?: NearbyWorldWatcher;
  } = {},
): Promise<NearbyWorldStatus | null> {
  const dataEpoch = metadata.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : metadata.dataEpoch;
  const snapshotCommit = await runNearbyWorldDataEpochCommit(dataEpoch, async () => ({
    settings: await loadNearbyWorldSettings(),
    status: await loadNearbyWorldStatus(),
  }));
  if (!snapshotCommit.committed || !isCurrentNearbyWorldWatcher(metadata.watcher)) return null;
  const { settings } = snapshotCommit.value;
  if (!settings.enabled) {
    if (!await clearPrecisionWatcher(dataEpoch, metadata.watcher)) return null;
    const status = await commitNearbyWorldStatusMutation(dataEpoch, () => stopNearbyWorldPrecisionMode('disabled'), metadata.watcher);
    if (!status) return null;
    await syncNearbyWorldBackgroundTask({ dataEpoch });
    return status;
  }
  const permissionStep = await runNearbyWorldExternalStep(dataEpoch, () => (
    ensureLocationPermissionForForegroundUse({ dataEpoch, watcher: metadata.watcher })
  ));
  if (!permissionStep.current || !isCurrentNearbyWorldWatcher(metadata.watcher)) return null;
  const permissionStatus = permissionStep.value;
  if (permissionStatus === null) return null;
  if (permissionStatus === 'denied' || permissionStatus === 'unavailable') {
    if (!await clearPrecisionWatcher(dataEpoch, metadata.watcher)) return null;
    const status = await commitNearbyWorldStatusMutation(dataEpoch, async () => {
      await mergeNearbyWorldStatus({ permissionStatus, backgroundActive: false });
      return stopNearbyWorldPrecisionMode('permission_lost');
    }, metadata.watcher);
    if (!status) return null;
    await syncNearbyWorldBackgroundTask({ dataEpoch });
    return status;
  }
  const modeStatus = await commitNearbyWorldStatusMutation(
    dataEpoch,
    () => startNearbyWorldPrecisionMode(mode, {
      motionState: mode,
      autoTogetherReason: metadata.autoTogetherReason ?? null,
    }),
    metadata.watcher,
  );
  if (!modeStatus || !isCurrentNearbyWorldWatcher(metadata.watcher)) return null;
  const started = await beginPrecisionWatcher(mode, dataEpoch, metadata.watcher);
  if (!isCurrentNearbyWorldWatcher(metadata.watcher)) return null;
  if (!started) {
    await syncNearbyWorldBackgroundTask({ dataEpoch });
    const statusCommit = await runNearbyWorldDataEpochCommit(dataEpoch, () => loadNearbyWorldStatus());
    return statusCommit.committed ? statusCommit.value : null;
  }
  await syncNearbyWorldBackgroundTask({ dataEpoch });
  return commitNearbyWorldStatusMutation(
    dataEpoch,
    () => mergeNearbyWorldStatus({ permissionStatus, lastError: undefined }),
    metadata.watcher,
  );
}

export async function stopNearbyWorldPrecisionWatcher(
  reason: NearbyWorldStopReason,
  options: { dataEpoch?: number | null } = {},
): Promise<NearbyWorldStatus | null> {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  if (!await clearPrecisionWatcher(dataEpoch)) return null;
  const committed = await runNearbyWorldDataEpochCommit(dataEpoch, async () => {
    if (reason === 'manual') {
      await pauseNearbyWorldAutoTogether(Date.now() + AUTO_TOGETHER_PAUSE_MS);
    }
    return stopNearbyWorldPrecisionMode(reason);
  });
  if (!committed.committed) return null;
  await syncNearbyWorldBackgroundTask({ dataEpoch });
  return canCommitBackupRestoreDataEpoch(dataEpoch) ? committed.value : null;
}

export async function pauseNearbyWorldAutoTogetherForCurrentTrip(
  until = Date.now() + AUTO_TOGETHER_PAUSE_MS,
  options: { dataEpoch?: number | null } = {},
): Promise<NearbyWorldStatus | null> {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const committed = await runNearbyWorldDataEpochCommit(
    dataEpoch,
    () => pauseNearbyWorldAutoTogether(until),
  );
  return committed.committed ? committed.value : null;
}

export async function resumeNearbyWorldPrecisionWatcherIfNeeded(): Promise<boolean> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return false;
  const watcher = { generation: watcherGeneration };
  const reconciled = await reconcileNearbyWorldPrecisionState({ dataEpoch, syncBackground: false, watcher });
  if (!reconciled) return false;
  const snapshotCommit = await runNearbyWorldDataEpochCommit(dataEpoch, async () => {
    const [settings, status] = await Promise.all([loadNearbyWorldSettings(), loadNearbyWorldStatus()]);
    return { settings, status };
  });
  if (!snapshotCommit.committed || !isCurrentNearbyWorldWatcher(watcher)) return false;
  const { settings, status } = snapshotCommit.value;
  if (!settings.enabled) {
    if (status.precisionMode !== 'off') {
      await stopNearbyWorldPrecisionWatcher('disabled', { dataEpoch });
    } else {
      await syncNearbyWorldBackgroundTask({ dataEpoch });
    }
    return false;
  }
  if (AppState.currentState !== 'active') {
    await syncNearbyWorldBackgroundTask({ dataEpoch });
    return false;
  }
  if (precisionWatcher && precisionWatcherMode === status.precisionMode) {
    await syncNearbyWorldBackgroundTask({ dataEpoch });
    return canCommitBackupRestoreDataEpoch(dataEpoch);
  }
  const permissionStep = await runNearbyWorldExternalStep(dataEpoch, () => readExistingPermissionStatus());
  if (!permissionStep.current || !isCurrentNearbyWorldWatcher(watcher)) return false;
  const permissionStatus = permissionStep.value;
  if (permissionStatus !== 'foreground' && permissionStatus !== 'background') {
    const status = await commitNearbyWorldStatusMutation(
      dataEpoch,
      () => mergeNearbyWorldStatus({ permissionStatus, backgroundActive: false }),
      watcher,
    );
    if (!status || !isCurrentNearbyWorldWatcher(watcher)) return false;
    await stopNearbyWorldPrecisionWatcher('permission_lost', { dataEpoch });
    return false;
  }
  const started = await beginPrecisionWatcher(status.precisionMode, dataEpoch, watcher);
  if (!isCurrentNearbyWorldWatcher(watcher)) return false;
  await syncNearbyWorldBackgroundTask({ dataEpoch });
  return started && canCommitBackupRestoreDataEpoch(dataEpoch);
}

export async function refreshNearbyWorldNow(
  options: { dataEpoch?: number | null } = {},
): Promise<NearbyWorldStatus | null> {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  if (dataEpoch === null) return null;
  const reconciled = await reconcileNearbyWorldPrecisionState({ dataEpoch, syncBackground: false });
  if (!reconciled) return null;
  const settingsCommit = await runNearbyWorldDataEpochCommit(dataEpoch, () => loadNearbyWorldSettings());
  if (!settingsCommit.committed) return null;
  const settings = settingsCommit.value;
  if (!settings.enabled) {
    const stopped = await stopNearbyWorldPrecisionWatcher('disabled', { dataEpoch });
    if (!stopped) return null;
    return commitNearbyWorldStatusMutation(
      dataEpoch,
      () => mergeNearbyWorldStatus({ presence: 'unknown', lastError: undefined }),
    );
  }
  const permissionStatus = await ensureLocationPermissionForForegroundUse({ dataEpoch });
  if (permissionStatus === null) return null;
  if (permissionStatus === 'denied' || permissionStatus === 'unavailable') {
    const statusCommit = await runNearbyWorldDataEpochCommit(dataEpoch, () => loadNearbyWorldStatus());
    return statusCommit.committed ? statusCommit.value : null;
  }
  const locationStep = await runNearbyWorldExternalStep(dataEpoch, () => getPreciseForegroundLocation());
  if (!locationStep.current) return null;
  const processed = await processNearbyWorldLocation(
    locationStep.value,
    { backgroundActive: false, dataEpoch, source: 'manual' },
  );
  if (!processed) return null;
  return reconcileNearbyWorldPrecisionState({ dataEpoch, syncBackground: true });
}

export async function refreshNearbyWorldIfAllowed(options?: { explicit?: boolean }): Promise<NearbyWorldStatus | null> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return null;
  const settingsCommit = await runNearbyWorldDataEpochCommit(dataEpoch, () => loadNearbyWorldSettings());
  if (!settingsCommit.committed) return null;
  const settings = settingsCommit.value;
  if (!settings.enabled) return null;
  const permissionStep = await runNearbyWorldExternalStep(dataEpoch, () => readExistingPermissionStatus());
  if (!permissionStep.current) return null;
  const permissionStatus = permissionStep.value;
  if (permissionStatus !== 'foreground' && permissionStatus !== 'background') {
    const committed = await runNearbyWorldDataEpochCommit(
      dataEpoch,
      () => mergeNearbyWorldStatus({ permissionStatus }),
    );
    if (!committed.committed) return null;
    return reconcileNearbyWorldPrecisionState({ dataEpoch, syncBackground: true });
  }
  try {
    const locationStep = await runNearbyWorldExternalStep(dataEpoch, () => Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
        mayShowUserSettingsDialog: false,
      }));
    if (!locationStep.current) return null;
    return processNearbyWorldLocation(
      locationStep.value,
      { backgroundActive: permissionStatus === 'background', dataEpoch, enrich: options?.explicit ? true : undefined },
    );
  } catch (error) {
    return commitNearbyWorldStatusMutation(dataEpoch, () => mergeNearbyWorldStatus({
        permissionStatus,
        lastError: error instanceof Error ? error.message : '附近世界刷新失败',
      }));
  }
}

export async function setNearbyWorldHomeToCurrentLocation(
  options: { dataEpoch?: number | null } = {},
): Promise<NearbyWorldSnapshot | null> {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const permissionStatus = await ensureLocationPermissionForForegroundUse({ dataEpoch });
  if (permissionStatus === null) return null;
  if (permissionStatus === 'denied' || permissionStatus === 'unavailable') {
    throw new Error('还没有位置权限，不能设置家。');
  }
  const locationStep = await runNearbyWorldExternalStep(dataEpoch, () => getPreciseForegroundLocation());
  if (!locationStep.current) return null;
  const location = locationStep.value;
  const accuracy = location.coords.accuracy;
  if (!isFreshLocation({ ...location.coords, timestamp: location.timestamp }, Date.now(), SET_HOME_MAX_ACCURACY_METERS)) {
    throw new Error('暂时没有足够准确的新定位。');
  }
  const now = Date.now();
  const committed = await runNearbyWorldDataEpochCommit(dataEpoch, async () => {
    const [settings, previous] = await Promise.all([loadNearbyWorldSettings(), loadNearbyWorldStatus()]);
    const updated = await saveNearbyWorldSettings({
      ...settings,
      home: {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        label: '家',
        setAt: now,
      },
    });
    const newerCurrent = previous.coordinateSystem === 'wgs84' && validLocationPoint({
      latitude: previous.latitude!, longitude: previous.longitude!, timestamp: previous.updatedAt!,
    }, Date.now()) && previous.updatedAt! > location.timestamp;
    const currentPoint = newerCurrent ? {
      latitude: previous.latitude!, longitude: previous.longitude!, accuracy: previous.accuracy,
      updatedAt: previous.updatedAt!,
    } : {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      accuracy, updatedAt: location.timestamp,
    };
    const distanceFromHome = calculateDistanceMeters(currentPoint.latitude, currentPoint.longitude,
      location.coords.latitude, location.coords.longitude);
    const status = await saveNearbyWorldStatus({
      ...previous,
      ...currentPoint,
      distanceFromHome,
      presence: 'unknown',
      nearHome: distanceFromHome <= HOME_RADIUS_METERS,
      coordinateSystem: 'wgs84',
      permissionStatus,
      backgroundActive: false,
      precisionArrivedHomeSince: undefined,
      lastError: describeLowAccuracy(accuracy),
    });
    return { settings: updated, status };
  });
  return committed.committed ? committed.value : null;
}

export async function processNearbyWorldLocation(
  location: Location.LocationObject,
  options?: {
    backgroundActive?: boolean;
    dataEpoch?: number | null;
    enrich?: boolean;
    source?: 'background' | 'manual' | 'auto';
    watcher?: NearbyWorldWatcher;
  },
): Promise<NearbyWorldStatus | null> {
  const dataEpoch = options?.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const snapshotCommit = await runNearbyWorldDataEpochCommit(dataEpoch, async () => {
    const settings = await loadNearbyWorldSettings();
    const previous = await loadNearbyWorldStatus();
    return { previous, settings };
  });
  if (!snapshotCommit.committed || !isCurrentNearbyWorldWatcher(options?.watcher)) return null;
  const { previous, settings } = snapshotCommit.value;
  if (!settings.enabled) {
    return previous;
  }
  const now = Date.now();
  const latitude = location.coords.latitude;
  const longitude = location.coords.longitude;
  const locationSource = options?.source ?? (options?.backgroundActive ? 'background' : 'auto');
  if (previous.updatedAt && previous.updatedAt <= now && previous.coordinateSystem === 'wgs84'
    && location.timestamp <= previous.updatedAt) return previous;
  if (shouldKeepPreviousLocation(previous, location, locationSource)) {
    const savedCommit = await runNearbyWorldDataEpochCommit(dataEpoch, async () => {
      const latest = await loadNearbyWorldStatus();
      if (!isCurrentNearbyWorldWatcher(options?.watcher)) return null;
      return saveNearbyWorldStatus({
        ...latest,
        permissionStatus: options?.backgroundActive ? 'background' : latest.permissionStatus === 'background' ? 'background' : 'foreground',
        backgroundActive: options?.backgroundActive ?? latest.backgroundActive,
        lastError: locationSource === 'manual'
          ? '这次刷新拿到的位置比上次更粗，已保留上次可信位置。'
          : '后台心跳拿到的位置不够可信，已保留上次可信位置。',
      });
    });
    if (!savedCommit.committed || !savedCommit.value || !isCurrentNearbyWorldWatcher(options?.watcher)) return null;
    const saved = savedCommit.value;
    void maybeEnqueueNearbyWorldUnstableEvent(saved, dataEpoch, now);
    return canCommitBackupRestoreDataEpoch(dataEpoch) ? saved : null;
  }
  const distanceFromHome = settings.home
    ? calculateDistanceMeters(latitude, longitude, settings.home.latitude, settings.home.longitude)
    : undefined;
  let enrichment:
    | { kind: 'amap'; snapshot: Awaited<ReturnType<typeof fetchAmapNearbySnapshot>> }
    | { kind: 'error'; message: string }
    | { kind: 'none' } = { kind: 'none' };
  const point = { ...location.coords, timestamp: location.timestamp };
  const explicit = options?.enrich === true || locationSource === 'manual';
  let enrich = options?.enrich !== false && isFreshLocation(point, now) && Boolean(settings.amapKey.trim())
    && (explicit || (!automaticMapInFlight && shouldAttemptAutomaticMap(previous, point, now)));
  if (enrich && !explicit) {
    const reserved = await runNearbyWorldDataEpochCommit(dataEpoch, async () => {
      const current = await loadNearbyWorldStatus();
      if (!isCurrentNearbyWorldWatcher(options?.watcher) || automaticMapInFlight || !shouldAttemptAutomaticMap(current, point, now)) return false;
      await saveNearbyWorldStatus({ ...current, mapAttempt: { at: now, latitude, longitude, accuracy: point.accuracy! } });
      automaticMapInFlight = true;
      return true;
    });
    enrich = reserved.committed && reserved.value;
  }
  if (!isCurrentNearbyWorldWatcher(options?.watcher)) {
    if (enrich && !explicit) automaticMapInFlight = false;
    return null;
  }
  if (enrich) {
    try {
      if (settings.amapKey.trim()) {
        const amapStep = await runNearbyWorldExternalStep(dataEpoch, async () => {
          const input = {
          key: settings.amapKey,
          latitude,
          longitude,
          categories: settings.poiCategories,
          now,
          ambient: locationSource !== 'manual',
          coordinateSystem: 'wgs84' as const,
          };
          if (locationSource !== 'manual') {
            return runAmapQuery({ service: 'regeo', dataEpoch }, () => fetchAmapNearbySnapshot(input));
          }
          // Retry the actually exhausted service first. A failure stops this manual
          // refresh before another interface spends quota; normal refresh is still two requests.
          const retryService = (await loadNearbyWorldStatus()).mapQuotaPause?.service;
          const readPlace = () => runAmapQuery({ service: 'regeo', dataEpoch, explicitRetry: true },
            () => fetchAmapReverseGeocode({ key: input.key, location: `${longitude},${latitude}`, coordinateSystem: 'wgs84' }));
          const readPois = () => runAmapQuery({ service: 'place', dataEpoch, explicitRetry: true },
            () => fetchAmapNearbyPois({ ...input, mixed: true }));
          if (retryService === 'place') {
            const pois = await readPois();
            return { pois, place: await readPlace() };
          }
          const place = await readPlace();
          return { place, pois: await readPois() };
        });
        if (!amapStep.current || !isCurrentNearbyWorldWatcher(options?.watcher)) return null;
        enrichment = { kind: 'amap', snapshot: amapStep.value };
      }
    } catch (error) {
      console.warn('[NearbyWorld] Failed to enrich location', error);
      enrichment = { kind: 'error', message: error instanceof Error ? error.message : '附近世界刷新失败' };
    } finally {
      if (!explicit) automaticMapInFlight = false;
    }
  }
  let locationAccepted = false;
  const savedCommit = await runNearbyWorldDataEpochCommit(dataEpoch, async () => {
    const latest = await withValidPresenceReport(await loadNearbyWorldStatus());
    if (!isCurrentNearbyWorldWatcher(options?.watcher)) return null;
    const acceptLocation = !shouldKeepPreviousLocation(latest, location, locationSource);
    const acceptEnrichment = enrichment.kind === 'amap' && now >= (latest.addressUpdatedAt ?? 0) && now >= (latest.poiUpdatedAt ?? 0);
    if (!acceptLocation && !acceptEnrichment) return latest;
    const patch: Partial<NearbyWorldStatus> = acceptLocation ? {
      latitude,
      longitude,
      accuracy: location.coords.accuracy,
      distanceFromHome,
      coordinateSystem: 'wgs84',
      nearHome: distanceFromHome == null ? undefined : distanceFromHome <= HOME_RADIUS_METERS,
      updatedAt: location.timestamp,
      permissionStatus: options?.backgroundActive ? 'background' : latest.permissionStatus === 'background' ? 'background' : 'foreground',
      backgroundActive: options?.backgroundActive ?? latest.backgroundActive,
      lastError: enrichment.kind === 'error' ? enrichment.message : describeLowAccuracy(location.coords.accuracy),
    } : {};
    if (enrichment.kind === 'amap' && acceptEnrichment) {
      patch.placeLabel = enrichment.snapshot.place.placeLabel;
      patch.address = enrichment.snapshot.place.address;
      patch.city = enrichment.snapshot.place.city;
      patch.district = enrichment.snapshot.place.district;
      patch.township = enrichment.snapshot.place.township;
      patch.nearbyAoi = enrichment.snapshot.place.nearbyAoi;
      patch.nearbyPoi = enrichment.snapshot.place.nearbyPoi;
      patch.nearbyRoad = enrichment.snapshot.place.nearbyRoad;
      patch.poiCache = enrichment.snapshot.pois;
      patch.poiUpdatedAt = now;
      patch.addressUpdatedAt = now;
      patch.addressCenter = { latitude, longitude };
      patch.poiCenter = { latitude, longitude };
    }
    const next = { ...latest, ...patch };
    next.presence = resolveNearbyPresence(next, now);
    next.precisionArrivedHomeSince = next.precisionMode !== 'off' && next.presenceReport?.state === '在家'
      && next.presence !== 'outside' ? latest.precisionArrivedHomeSince ?? next.presenceReport.sentAt : undefined;
    if (acceptLocation) {
      const currentSettings = await loadNearbyWorldSettings();
      if (!isCurrentNearbyWorldWatcher(options?.watcher)) return null;
      if (!currentSettings.enabled) return latest;
      const matchedReference = next.addressCenter?.latitude === latitude && next.addressCenter?.longitude === longitude
        && (next.addressUpdatedAt ?? 0) >= location.timestamp
        ? next.nearbyPoi || next.nearbyAoi || next.nearbyRoad : undefined;
      // Persist evidence before the status cursor. If this write fails, the same fix remains retryable.
      await recordNearbyOutingPointWithinCommit(point, { now: Date.now(), home: currentSettings.home,
        homeReportAt: next.presenceReport?.state === '在家' ? next.presenceReport.sentAt : undefined,
        nearbyReference: matchedReference });
    }
    if (!isCurrentNearbyWorldWatcher(options?.watcher)) return null;
    const saved = await saveNearbyWorldStatus(next);
    locationAccepted = acceptLocation;
    return saved;
  });
  if (!savedCommit.committed || !savedCommit.value || !isCurrentNearbyWorldWatcher(options?.watcher)) return null;
  const saved = savedCommit.value;
  if (!locationAccepted) return saved;
  const autoStatus = await evaluateNearbyWorldAutoTogether(location, locationSource, { dataEpoch, watcher: options?.watcher }).catch((error) => {
    console.warn('[NearbyWorld] Failed to evaluate auto together', error);
    return null;
  });
  if (!isCurrentNearbyWorldWatcher(options?.watcher) || (!autoStatus && !canCommitBackupRestoreDataEpoch(dataEpoch))) return null;
  const finalStatus = autoStatus ?? saved;
  void maybeEnqueueNearbyWorldActiveEvent(previous, finalStatus, dataEpoch, location.timestamp);
  if (finalStatus.precisionMode !== 'off') {
    void reconcileNearbyWorldPrecisionState({ dataEpoch, syncBackground: false, watcher: options?.watcher }).catch((error) => {
      console.warn('[NearbyWorld] Failed to reconcile precision state after location update', error);
    });
  }
  return canCommitBackupRestoreDataEpoch(dataEpoch) ? finalStatus : null;
}

export async function evaluateNearbyWorldAutoTogether(
  location: Location.LocationObject,
  source: 'background' | 'manual' | 'auto' = 'auto',
  options: { dataEpoch?: number | null; watcher?: NearbyWorldWatcher } = {},
): Promise<NearbyWorldStatus | null> {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const snapshotCommit = await runNearbyWorldDataEpochCommit(dataEpoch, async () => {
    const [settings, status] = await Promise.all([loadNearbyWorldSettings(), loadNearbyWorldStatus()]);
    return { settings, status };
  });
  if (!snapshotCommit.committed || !isCurrentNearbyWorldWatcher(options.watcher)) return null;
  const { settings, status } = snapshotCommit.value;
  if (!settings.enabled) return status;

  const gpsQuality = getNearbyWorldGpsQuality(location.coords.accuracy);
  const qualityPatch = (current: NearbyWorldStatus) => isFreshLocation(
    { ...location.coords, timestamp: location.timestamp }, Date.now(), Number.POSITIVE_INFINITY,
  ) && location.timestamp >= (current.updatedAt ?? 0) ? { gpsQuality } : {};
  if (!isTrustedAutoTogetherSample(location)) {
    return commitNearbyWorldStatusMutation(dataEpoch, async () => {
      const current = await loadNearbyWorldStatus();
      return saveNearbyWorldStatus({ ...current, ...qualityPatch(current) });
    }, options.watcher);
  }

  registerAutoTogetherSample(location);
  const motion = classifyAutoTogetherMotion(autoTogetherSamples);
  const now = Date.now();
  const motionPatch = {
    motionState: motion.state,
    lastMotionDetectedAt: motion.state === 'unknown' || motion.state === 'still'
      ? status.lastMotionDetectedAt
      : location.timestamp,
  };

  if (status.precisionMode === 'walking' && motion.state === 'transit') {
    if (source === 'background') {
      const next = await commitNearbyWorldStatusMutation(
        dataEpoch,
        () => startNearbyWorldPrecisionMode('transit', {
          motionState: 'transit',
          autoTogetherReason: 'transit_detected',
        }),
      );
      if (!next) return null;
      await syncNearbyWorldBackgroundTask({ dataEpoch });
      return next;
    }
    return startNearbyWorldPrecisionWatcher('transit', { autoTogetherReason: 'transit_detected', dataEpoch, watcher: options.watcher });
  }

  if (status.precisionMode !== 'off') {
    return commitNearbyWorldStatusMutation(dataEpoch, async () => {
      const current = await loadNearbyWorldStatus();
      return saveNearbyWorldStatus({ ...current, ...motionPatch, ...qualityPatch(current),
        ...(motion.state === 'still' || motion.state === 'unknown' ? {} : { precisionLastActiveAt: location.timestamp }) });
    }, options.watcher);
  }

  const pausedUntil = typeof status.autoTogetherPausedUntil === 'number' ? status.autoTogetherPausedUntil : 0;
  const canAutoStart =
    settings.autoTogetherEnabled &&
    pausedUntil <= now &&
    status.presence !== 'at_home' &&
    (status.permissionStatus === 'foreground' || status.permissionStatus === 'background');

  if (!canAutoStart) {
    return commitNearbyWorldStatusMutation(dataEpoch, async () => {
      const current = await loadNearbyWorldStatus();
      return saveNearbyWorldStatus({ ...current, ...motionPatch, ...qualityPatch(current) });
    }, options.watcher);
  }

  if (motion.state === 'walking') {
    if (source === 'background') {
      const next = await commitNearbyWorldStatusMutation(
        dataEpoch,
        () => startNearbyWorldPrecisionMode('walking', {
          motionState: 'walking',
          autoTogetherReason: 'walking_detected',
        }),
      );
      if (!next) return null;
      await syncNearbyWorldBackgroundTask({ dataEpoch });
      return next;
    }
    return startNearbyWorldPrecisionWatcher('walking', { autoTogetherReason: 'walking_detected', dataEpoch, watcher: options.watcher });
  }

  if (motion.state === 'transit') {
    if (source === 'background') {
      const next = await commitNearbyWorldStatusMutation(
        dataEpoch,
        () => startNearbyWorldPrecisionMode('transit', {
          motionState: 'transit',
          autoTogetherReason: 'transit_detected',
        }),
      );
      if (!next) return null;
      await syncNearbyWorldBackgroundTask({ dataEpoch });
      return next;
    }
    return startNearbyWorldPrecisionWatcher('transit', { autoTogetherReason: 'transit_detected', dataEpoch, watcher: options.watcher });
  }

  return commitNearbyWorldStatusMutation(dataEpoch, async () => {
    const current = await loadNearbyWorldStatus();
    return saveNearbyWorldStatus({ ...current, ...motionPatch, ...qualityPatch(current) });
  }, options.watcher);
}

export function isNearbyWorldQuietHours(settings: NearbyWorldSettings, now = new Date()): boolean {
  if (!settings.quietHours.enabled) return false;
  const hour = now.getHours();
  const { startHour, endHour } = settings.quietHours;
  if (startHour === endHour) return true;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

async function readExistingPermissionStatus(): Promise<NearbyWorldPermissionStatus> {
  try {
    const foreground = await Location.getForegroundPermissionsAsync();
    if (!foreground.granted) return foreground.canAskAgain === false ? 'denied' : 'unknown';
    const background = await Location.getBackgroundPermissionsAsync();
    if (background.granted) return 'background';
    return 'foreground';
  } catch (error) {
    console.warn('[NearbyWorld] Failed to read permission status', error);
    return 'unavailable';
  }
}

async function handleNearbyWorldBackgroundLocation(
  location: Location.LocationObject,
  dataEpoch: number | null,
): Promise<void> {
  const status = await processNearbyWorldLocation(location, {
    backgroundActive: true,
    dataEpoch,
    source: 'background',
  });
  if (!status) return;
  await reconcileNearbyWorldPrecisionState({ dataEpoch, syncBackground: false });
}

function getDesiredBackgroundProfile(status: NearbyWorldStatus): NearbyWorldBackgroundProfile {
  return status.precisionMode === 'off' ? 'daily' : 'precision';
}

function getBackgroundTaskOptions(profile: NearbyWorldBackgroundProfile): Location.LocationTaskOptions {
  if (profile === 'precision') {
    return {
      accuracy: Location.Accuracy.High,
      distanceInterval: PRECISION_BACKGROUND_DISTANCE_METERS,
      timeInterval: PRECISION_BACKGROUND_INTERVAL_MS,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: false,
      foregroundService: {
        notificationTitle: '君落附近世界',
        notificationBody: '白云正在和小仓鼠一起走',
      },
    };
  }
  return {
    accuracy: Location.Accuracy.High,
    distanceInterval: DAILY_BACKGROUND_DISTANCE_METERS,
    timeInterval: DAILY_BACKGROUND_INTERVAL_MS,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: false,
    foregroundService: {
      notificationTitle: '君落附近世界',
      notificationBody: '白云小姐正在低频更新附近世界。',
    },
  };
}

async function mergeNearbyWorldStatus(patch: Partial<NearbyWorldStatus>): Promise<NearbyWorldStatus> {
  const previous = await loadNearbyWorldStatus();
  return saveNearbyWorldStatus({ ...previous, ...patch });
}

async function commitNearbyWorldStatusMutation(
  dataEpoch: number | null,
  mutation: () => Promise<NearbyWorldStatus>,
  watcher?: NearbyWorldWatcher,
): Promise<NearbyWorldStatus | null> {
  const committed = await runNearbyWorldDataEpochCommit(dataEpoch, () => (
    isCurrentNearbyWorldWatcher(watcher) ? mutation() : Promise.resolve(null)
  ));
  return committed.committed ? committed.value : null;
}

async function beginPrecisionWatcher(
  mode: NearbyWorldPrecisionMode,
  dataEpoch: number | null = captureBackupRestoreDataEpoch(),
  watcher?: NearbyWorldWatcher,
): Promise<boolean> {
  if (!clearPrecisionWatcher(dataEpoch, watcher)) return false;
  if (AppState.currentState !== 'active') return canCommitBackupRestoreDataEpoch(dataEpoch);
  const generation = watcherGeneration;
  let subscription: Location.LocationSubscription | null = null;
  try {
    subscription = await Location.watchPositionAsync(getPrecisionWatchOptions(mode), (location) => {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch) || generation !== watcherGeneration || AppState.currentState !== 'active') return;
      if (mode === 'off') {
        void processNearbyWorldLocation(location, { dataEpoch, source: 'auto', watcher: { generation } }).catch(() => undefined);
      } else {
        void handlePrecisionLocation(location, mode, dataEpoch, generation).catch(() => undefined);
      }
    });
    let qualityDelay: number | undefined;
    if (mode !== 'off') {
      const quality = await runNearbyWorldDataEpochCommit(dataEpoch, async () => {
        const status = await loadNearbyWorldStatus();
        if (!canCommitBackupRestoreDataEpoch(dataEpoch) || generation !== watcherGeneration
          || AppState.currentState !== 'active' || status.precisionMode !== mode) return null;
        const now = Date.now();
        if (!isFreshNearbyStatus(status, now)) {
          await saveNearbyWorldStatus({ ...status, gpsQuality: 'poor' });
          return PRECISION_STALE_QUALITY_MS;
        }
        return Math.max(0, PRECISION_STALE_QUALITY_MS - (now - status.updatedAt!));
      });
      if (!quality.committed || quality.value === null) { subscription.remove(); return false; }
      qualityDelay = quality.value;
    }
    if (!canCommitBackupRestoreDataEpoch(dataEpoch) || generation !== watcherGeneration || AppState.currentState !== 'active') {
      subscription.remove();
      return false;
    }
    precisionWatcher = subscription;
    precisionWatcherMode = mode;
    precisionSamples = [];
    if (qualityDelay !== undefined && !precisionQualityTimeout) schedulePrecisionQualityDowngrade(dataEpoch, qualityDelay);
    return true;
  } catch (error) {
    subscription?.remove();
    if (!canCommitBackupRestoreDataEpoch(dataEpoch) || generation !== watcherGeneration) return false;
    await clearPrecisionWatcher(dataEpoch, watcher);
    console.warn('[NearbyWorld] Failed to start precision watcher', error);
    await commitNearbyWorldStatusMutation(dataEpoch, async () => {
      await stopNearbyWorldPrecisionMode('system_interrupted');
      return mergeNearbyWorldStatus({
        lastError: error instanceof Error ? error.message : '前台高精度定位启动失败',
      });
    }, watcher);
    return false;
  }
}

function clearPrecisionWatcher(
  dataEpoch: number | null = captureBackupRestoreDataEpoch(),
  watcher?: NearbyWorldWatcher,
): boolean {
  if (!canCommitBackupRestoreDataEpoch(dataEpoch) || !isCurrentNearbyWorldWatcher(watcher)) return false;
  watcherGeneration += 1;
  // Only this live continuation follows its own mode switch into the new watch.
  if (watcher) watcher.generation = watcherGeneration;
  if (precisionWatcher) {
    precisionWatcher.remove();
    precisionWatcher = null;
  }
  precisionWatcherMode = null;
  precisionSamples = [];
  if (precisionQualityTimeout) {
    clearTimeout(precisionQualityTimeout);
    precisionQualityTimeout = null;
  }
  return true;
}

function getPrecisionWatchOptions(mode: NearbyWorldPrecisionMode): Location.LocationOptions {
  if (mode === 'off') return {
    accuracy: Location.Accuracy.High, distanceInterval: 20, timeInterval: 60 * 1000,
    mayShowUserSettingsDialog: false,
  };
  if (mode === 'transit') {
    return {
      accuracy: Location.Accuracy.High,
      distanceInterval: 20,
      mayShowUserSettingsDialog: true,
      timeInterval: 5000,
    };
  }
  return {
    accuracy: Location.Accuracy.BestForNavigation,
    distanceInterval: 1,
    mayShowUserSettingsDialog: true,
    timeInterval: 2000,
  };
}

async function handlePrecisionLocation(
  location: Location.LocationObject,
  mode: Exclude<NearbyWorldPrecisionMode, 'off'>,
  dataEpoch: number | null,
  generation: number,
): Promise<void> {
  const watcher = { generation };
  try {
    const previous = await loadNearbyWorldStatus();
    if (!canCommitBackupRestoreDataEpoch(dataEpoch) || generation !== watcherGeneration) return;
    const now = Date.now();
    const qualityCurrent = isFreshLocation({ ...location.coords, timestamp: location.timestamp }, now, Number.POSITIVE_INFINITY)
      && location.timestamp >= (previous.updatedAt ?? 0);
    if (qualityCurrent && location.timestamp >= (precisionSamples.at(-1)?.timestamp ?? 0)) {
      registerPrecisionSample(location);
      schedulePrecisionQualityDowngrade(dataEpoch, Math.max(0, PRECISION_STALE_QUALITY_MS - (now - location.timestamp)));
    }
    const decision = shouldAcceptPrecisionLocation(previous, location, precisionSamples, mode);
    if (!decision.accept) {
      await runNearbyWorldDataEpochCommit(
        dataEpoch,
        async () => {
          const current = await loadNearbyWorldStatus();
          if (!canCommitBackupRestoreDataEpoch(dataEpoch) || generation !== watcherGeneration) return current;
          return saveNearbyWorldStatus({ ...current,
            ...(qualityCurrent && isFreshLocation({ ...location.coords, timestamp: location.timestamp }, Date.now(), Number.POSITIVE_INFINITY)
              && location.timestamp >= (current.updatedAt ?? 0)
              ? { gpsQuality: getNearbyWorldGpsQuality(location.coords.accuracy) } : {}),
            lastError: decision.reason, motionState: mode });
        },
      );
      if (isCurrentNearbyWorldWatcher(watcher)) await reconcileNearbyWorldPrecisionState({ dataEpoch, syncBackground: false, watcher });
      return;
    }
    const status = await processNearbyWorldLocation(location, {
      backgroundActive: false,
      dataEpoch,
      source: 'auto',
      watcher,
    });
    if (!status || !isCurrentNearbyWorldWatcher(watcher)) return;
    await reconcileNearbyWorldPrecisionState({ dataEpoch, syncBackground: false, watcher });
  } catch (error) {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch) || !isCurrentNearbyWorldWatcher(watcher)) return;
    console.warn('[NearbyWorld] Failed to handle precision location', error);
    await commitNearbyWorldStatusMutation(
      dataEpoch,
      () => mergeNearbyWorldStatus({
        lastError: error instanceof Error ? error.message : '前台高精度定位更新失败',
      }),
      watcher,
    );
  }
}

async function readBatteryStatusPatch(now: number): Promise<Partial<NearbyWorldStatus>> {
  try {
    const [batteryLevel, batteryStateValue] = await Promise.all([
      Battery.getBatteryLevelAsync(),
      Battery.getBatteryStateAsync(),
    ]);
    const batteryState = normalizeExpoBatteryState(batteryStateValue);
    const validLevel = typeof batteryLevel === 'number' && Number.isFinite(batteryLevel)
      ? Math.max(0, Math.min(1, batteryLevel))
      : undefined;
    return {
      batteryCheckedAt: now,
      batteryLevel: validLevel,
      batteryState,
      batteryWarning: typeof validLevel === 'number' && validLevel <= LOW_BATTERY_LEVEL && batteryState === 'unplugged',
    };
  } catch (error) {
    console.warn('[NearbyWorld] Failed to read battery status', error);
    return {};
  }
}

function normalizeExpoBatteryState(value: Battery.BatteryState): NearbyWorldBatteryState {
  if (value === Battery.BatteryState.UNPLUGGED) return 'unplugged';
  if (value === Battery.BatteryState.CHARGING) return 'charging';
  if (value === Battery.BatteryState.FULL) return 'full';
  return 'unknown';
}

function getPrecisionAutoStopReason(status: NearbyWorldStatus, now: number): NearbyWorldStopReason | null {
  if (status.precisionMode === 'off') return null;
  if (status.presenceReport?.state === '在家' && status.presence !== 'outside'
    && status.precisionArrivedHomeSince && now - status.precisionArrivedHomeSince >= ARRIVED_HOME_STABLE_MS) {
    return 'arrived_home';
  }
  const lastActiveAt = status.precisionLastActiveAt ?? status.precisionStartedAt;
  if (!lastActiveAt) return null;
  const idleMs = now - lastActiveAt;
  const timeout = status.precisionMode === 'transit' ? TRANSIT_IDLE_TIMEOUT_MS : WALKING_IDLE_TIMEOUT_MS;
  return idleMs >= timeout ? 'idle_timeout' : null;
}

function registerPrecisionSample(location: Location.LocationObject) {
  precisionSamples = [...precisionSamples, location]
    .filter((item) => hasValidCoordinates(item))
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-PRECISION_SAMPLE_LIMIT);
}

function registerAutoTogetherSample(location: Location.LocationObject) {
  autoTogetherSamples = [...autoTogetherSamples, location]
    .filter((item) => hasValidCoordinates(item))
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-AUTO_TOGETHER_SAMPLE_LIMIT);
}

function isTrustedAutoTogetherSample(location: Location.LocationObject): boolean {
  if (!hasValidCoordinates(location)) return false;
  const accuracy = getFiniteAccuracy(location.coords.accuracy);
  return accuracy != null && accuracy < AUTO_TOGETHER_TRUSTED_ACCURACY_METERS;
}

function classifyAutoTogetherMotion(samples: Location.LocationObject[]): { state: 'still' | 'walking' | 'transit' | 'unknown' } {
  const sorted = samples.filter(isTrustedAutoTogetherSample).sort((left, right) => left.timestamp - right.timestamp);
  const latest = sorted[sorted.length - 1]?.timestamp;
  const trusted = typeof latest === 'number'
    ? sorted.filter((item) => latest - item.timestamp <= AUTO_TOGETHER_SAMPLE_MAX_AGE_MS)
    : sorted;
  if (trusted.length < 2) return { state: 'unknown' };

  const segments = getMotionSegments(trusted);
  if (!segments.length) return { state: 'unknown' };

  const recentWindow = trusted.filter((item) => trusted[trusted.length - 1].timestamp - item.timestamp <= AUTO_TRANSIT_WINDOW_MS);
  const recentDistance = calculateCumulativeDistanceMeters(recentWindow);
  const transitSegments = segments.filter((segment) => segment.speedMps >= AUTO_TRANSIT_MIN_SPEED_MPS);
  if (transitSegments.length >= 2 || recentDistance >= AUTO_TRANSIT_MIN_DISTANCE_METERS) {
    return { state: 'transit' };
  }

  const recent = trusted.slice(-AUTO_WALKING_REQUIRED_SAMPLES);
  const recentSegments = getMotionSegments(recent);
  const walkingDistance = calculateCumulativeDistanceMeters(recent);
  const walkingSegments = recentSegments.filter(
    (segment) =>
      segment.speedMps >= AUTO_WALKING_MIN_SPEED_MPS &&
      segment.speedMps <= AUTO_WALKING_MAX_SPEED_MPS,
  );
  if (
    recent.length >= AUTO_WALKING_REQUIRED_SAMPLES &&
    walkingDistance >= AUTO_WALKING_MIN_DISTANCE_METERS &&
    walkingSegments.length >= AUTO_WALKING_REQUIRED_SAMPLES - 1
  ) {
    return { state: 'walking' };
  }

  const totalDistance = calculateCumulativeDistanceMeters(trusted.slice(-AUTO_WALKING_REQUIRED_SAMPLES));
  if (totalDistance <= AUTO_STILL_DISTANCE_METERS) return { state: 'still' };
  return { state: 'unknown' };
}

function getMotionSegments(samples: Location.LocationObject[]): Array<{ distanceMeters: number; speedMps: number }> {
  const segments: Array<{ distanceMeters: number; speedMps: number }> = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const distanceMeters = calculateDistanceMeters(
      previous.coords.latitude,
      previous.coords.longitude,
      current.coords.latitude,
      current.coords.longitude,
    );
    const elapsedSeconds = Math.max(1, (current.timestamp - previous.timestamp) / 1000);
    const calculatedSpeed = distanceMeters / elapsedSeconds;
    const reportedSpeed = typeof current.coords.speed === 'number' && Number.isFinite(current.coords.speed) && current.coords.speed > 0
      ? current.coords.speed
      : undefined;
    segments.push({
      distanceMeters,
      speedMps: reportedSpeed ?? calculatedSpeed,
    });
  }
  return segments;
}

function calculateCumulativeDistanceMeters(samples: Location.LocationObject[]): number {
  return getMotionSegments(samples).reduce((sum, segment) => sum + segment.distanceMeters, 0);
}

function schedulePrecisionQualityDowngrade(dataEpoch: number | null, delay = PRECISION_STALE_QUALITY_MS) {
  if (precisionQualityTimeout) clearTimeout(precisionQualityTimeout);
  const generation = watcherGeneration;
  const timeout = setTimeout(() => {
    void runNearbyWorldDataEpochCommit(dataEpoch, async () => {
      const status = await loadNearbyWorldStatus();
      if (!canCommitBackupRestoreDataEpoch(dataEpoch) || generation !== watcherGeneration
        || precisionQualityTimeout !== timeout) return status;
      if (status.precisionMode !== 'off') {
        return saveNearbyWorldStatus({ ...status, gpsQuality: 'poor' });
      }
      return status;
    })
      .catch((error) => {
        console.warn('[NearbyWorld] Failed to downgrade stale GPS quality', error);
      })
      .finally(() => { if (precisionQualityTimeout === timeout) precisionQualityTimeout = null; });
  }, delay);
  precisionQualityTimeout = timeout;
}

function getNearbyWorldGpsQuality(accuracy?: number | null): NearbyWorldGpsQuality {
  if (typeof accuracy !== 'number' || !Number.isFinite(accuracy)) return 'poor';
  if (accuracy < 10) return 'excellent';
  if (accuracy < 25) return 'good';
  if (accuracy < 50) return 'fair';
  return 'poor';
}

function shouldAcceptPrecisionLocation(
  previous: NearbyWorldStatus,
  location: Location.LocationObject,
  samples: Location.LocationObject[],
  mode: Exclude<NearbyWorldPrecisionMode, 'off'>,
): { accept: boolean; reason?: string } {
  if (!hasValidCoordinates(location)) {
    return { accept: false, reason: '这次定位没有拿到有效坐标，已保留上次可信位置。' };
  }
  if (typeof previous.latitude !== 'number' || typeof previous.longitude !== 'number' || !previous.updatedAt) {
    return { accept: true };
  }

  const movedMeters = calculateDistanceMeters(
    previous.latitude,
    previous.longitude,
    location.coords.latitude,
    location.coords.longitude,
  );
  if (movedMeters < PRECISION_TINY_DRIFT_METERS) {
    return { accept: false, reason: '这次只是很小的定位抖动，已保留上次可信位置。' };
  }

  const previousAccuracy = getFiniteAccuracy(previous.accuracy);
  const nextAccuracy = getFiniteAccuracy(location.coords.accuracy);
  const bestRecentAccuracy = getBestRecentAccuracy(samples);
  if (
    nextAccuracy != null &&
    bestRecentAccuracy != null &&
    nextAccuracy >= PRECISION_POOR_ACCURACY_METERS &&
    nextAccuracy > bestRecentAccuracy + PRECISION_BETTER_SAMPLE_MARGIN_METERS
  ) {
    return { accept: false, reason: '这次定位有些不稳，已保留最近更可信的位置。' };
  }

  if (
    previousAccuracy != null &&
    nextAccuracy != null &&
    nextAccuracy > previousAccuracy + PRECISION_WORSE_ACCURACY_MARGIN_METERS &&
    movedMeters <= nextAccuracy + previousAccuracy
  ) {
    return { accept: false, reason: '这次定位比上次粗很多，已保留上次可信位置。' };
  }

  if (movedMeters > PRECISION_LARGE_JUMP_METERS) {
    const elapsedSeconds = Math.max(1, (location.timestamp - previous.updatedAt) / 1000);
    const speed = movedMeters / elapsedSeconds;
    const maxSpeed = mode === 'transit' ? MAX_REASONABLE_TRANSIT_SPEED_MPS : MAX_REASONABLE_WALKING_SPEED_MPS;
    if (speed > maxSpeed) {
      return { accept: false, reason: '这次定位像是突然跳点，已保留上次可信位置。' };
    }
  }

  return { accept: true };
}

function hasValidCoordinates(location: Location.LocationObject): boolean {
  return validLocationPoint({ ...location.coords, timestamp: location.timestamp });
}

function getFiniteAccuracy(value?: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function getBestRecentAccuracy(samples: Location.LocationObject[]): number | null {
  const best = samples
    .map((item) => getFiniteAccuracy(item.coords.accuracy))
    .filter((item): item is number => item != null)
    .sort((left, right) => left - right)[0];
  return typeof best === 'number' ? best : null;
}

async function ensureLocationPermissionForForegroundUse(
  options: { dataEpoch?: number | null; watcher?: NearbyWorldWatcher } = {},
): Promise<NearbyWorldPermissionStatus | null> {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const existingStep = await runNearbyWorldExternalStep(dataEpoch, () => readExistingPermissionStatus());
  if (!existingStep.current || !isCurrentNearbyWorldWatcher(options.watcher)) return null;
  const existing = existingStep.value;
  if (existing === 'foreground' || existing === 'background') return existing;
  return requestNearbyWorldPermissions({ background: false, dataEpoch, watcher: options.watcher });
}

async function getPreciseForegroundLocation(): Promise<Location.LocationObject> {
  const attempts: Location.LocationObject[] = [];
  for (let index = 0; index < PRECISE_LOCATION_ATTEMPTS; index += 1) {
    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.BestForNavigation,
      mayShowUserSettingsDialog: true,
    });
    if (validLocationPoint({ ...location.coords, timestamp: location.timestamp })) attempts.push(location);
    if (typeof location.coords.accuracy === 'number' && location.coords.accuracy <= 20) break;
  }

  const best = attempts.sort(compareLocationAccuracy)[0];
  if (!best) throw new Error('暂时没有足够准确的新定位。');
  return best;
}

function compareLocationAccuracy(left: Location.LocationObject, right: Location.LocationObject) {
  const leftAccuracy = typeof left.coords.accuracy === 'number' && Number.isFinite(left.coords.accuracy)
    ? left.coords.accuracy
    : Number.POSITIVE_INFINITY;
  const rightAccuracy = typeof right.coords.accuracy === 'number' && Number.isFinite(right.coords.accuracy)
    ? right.coords.accuracy
    : Number.POSITIVE_INFINITY;
  if (leftAccuracy !== rightAccuracy) return leftAccuracy - rightAccuracy;
  return right.timestamp - left.timestamp;
}

function calculateDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(earthRadius * c);
}

function describeLowAccuracy(accuracy?: number | null): string | undefined {
  if (typeof accuracy !== 'number' || !Number.isFinite(accuracy)) return undefined;
  if (accuracy <= LOW_ACCURACY_WARNING_METERS) return undefined;
  return `当前位置精度较低，约 ${Math.round(accuracy)} 米，地址可能会漂移。`;
}

function shouldKeepPreviousLocation(
  previous: NearbyWorldStatus,
  location: Location.LocationObject,
  source: 'background' | 'manual' | 'auto',
): boolean {
  if (!validLocationPoint({ ...location.coords, timestamp: location.timestamp })) return true;
  if (previous.coordinateSystem !== 'wgs84' || !validLocationPoint({
    latitude: previous.latitude!, longitude: previous.longitude!, timestamp: previous.updatedAt!, accuracy: previous.accuracy,
  })) return false;
  if (previous.updatedAt && location.timestamp <= previous.updatedAt) return true;
  if (!previous.updatedAt || typeof previous.latitude !== 'number' || typeof previous.longitude !== 'number') return false;
  const age = Date.now() - previous.updatedAt;
  const movedMeters = calculateDistanceMeters(
    previous.latitude,
    previous.longitude,
    location.coords.latitude,
    location.coords.longitude,
  );
  if (movedMeters > PRECISION_LARGE_JUMP_METERS && isUnreasonableLocationJump(previous, location, movedMeters)) return true;
  const worseAccuracyGrace = source === 'manual' ? MANUAL_WORSE_ACCURACY_GRACE_MS : BACKGROUND_WORSE_ACCURACY_GRACE_MS;
  if (age > worseAccuracyGrace) return false;
  const previousAccuracy = previous.accuracy;
  const nextAccuracy = location.coords.accuracy;
  if (typeof previousAccuracy !== 'number' || typeof nextAccuracy !== 'number') return false;
  if (!Number.isFinite(previousAccuracy) || !Number.isFinite(nextAccuracy)) return false;
  if (nextAccuracy <= previousAccuracy + 30) return false;
  return movedMeters <= nextAccuracy + previousAccuracy;
}

function isUnreasonableLocationJump(
  previous: NearbyWorldStatus,
  location: Location.LocationObject,
  movedMeters: number,
): boolean {
  if (!previous.updatedAt) return false;
  const elapsedSeconds = Math.max(1, (location.timestamp - previous.updatedAt) / 1000);
  const speed = Math.max(0, movedMeters - (getFiniteAccuracy(previous.accuracy) ?? 0) - (getFiniteAccuracy(location.coords.accuracy) ?? 0)) / elapsedSeconds;
  return speed > MAX_REASONABLE_TRANSIT_SPEED_MPS;
}

function toRad(value: number): number {
  return (value * Math.PI) / 180;
}

