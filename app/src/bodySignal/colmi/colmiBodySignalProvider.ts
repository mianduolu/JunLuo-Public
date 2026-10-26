import {
  authenticateMiBand6AndSubscribeHeartRate,
  connectColmiDevice,
  disconnectColmiDevice,
  getColmiProviderContext,
  stopMiBand6RealtimeHeartRate,
  getColmiConnectionSnapshot,
  subscribeColmiStandardHeartRate,
  subscribeColmiConnection,
  type ColmiConnectionState,
} from './colmiConnection';
import { standardGattConnectionToBodySignalLiveSnapshot } from './standardGattBodySignalProvider';
import type {
  BodySignalLiveSnapshot,
  BodySignalProviderAdapter,
  StoredBodySignalReading,
} from '../bodySignalTypes';
import type { BodySignalDeviceTarget } from '../device/bodySignalDeviceTypes';
import {
  pauseGuardian,
  releaseGuardianForForegroundScan,
  retryGuardianNow,
  stopGuardianHeartRate,
} from '../bodySignalGuardian';
import { guardianOwnsBodySignalConnection } from '../bodySignalGuardianPolicy';
import {
  getBodySignalGuardianRuntimeState,
  getGuardianBodySignalLiveSnapshot,
  getSavedMiBand6Battery,
  subscribeBodySignalGuardianRuntime,
} from '../bodySignalGuardianRuntime';

function isColmiConnectionBusy(state: ColmiConnectionState): boolean {
  return state.status === 'connecting'
    || state.status === 'discovering'
    || state.status === 'subscribing'
    || state.initializationStatus === 'initializing'
    || state.initializationStatus === 'setting_time'
    || state.initializationStatus === 'reading_battery';
}

function makeHeartRateReading(state: ColmiConnectionState): StoredBodySignalReading | undefined {
  if (state.smartHealthR99HeartRateInfo) {
    return {
      confidence: 'high',
      kind: 'heart_rate',
      measuredAt: state.smartHealthR99HeartRateInfo.receivedAt,
      sourceDeviceName: state.connectedDevice?.displayName,
      sourceProvider: 'smarthealth_r99',
      unit: 'bpm',
      value: state.smartHealthR99HeartRateInfo.bpm,
    };
  }

  return undefined;
}

function makeBatteryReading(state: ColmiConnectionState): StoredBodySignalReading | undefined {
  if (state.smartHealthR99BatteryInfo) {
    return {
      confidence: 'high',
      kind: 'battery',
      measuredAt: state.smartHealthR99BatteryInfo.receivedAt,
      sourceDeviceName: state.connectedDevice?.displayName,
      sourceProvider: 'smarthealth_r99',
      unit: '%',
      value: state.smartHealthR99BatteryInfo.batteryLevel,
    };
  }

  if (!state.batteryInfo) return undefined;
  return {
    confidence: 'medium',
    kind: 'battery',
    measuredAt: state.batteryInfo.receivedAt,
    sourceDeviceName: state.connectedDevice?.displayName,
    sourceProvider: 'colmi_rxx',
    unit: '%',
    value: state.batteryInfo.batteryLevel,
  };
}

export function colmiConnectionToBodySignalLiveSnapshot(state: ColmiConnectionState): BodySignalLiveSnapshot {
  if (state.capabilities.heartRateTransport === 'standard_gatt') {
    return standardGattConnectionToBodySignalLiveSnapshot(state);
  }
  const isConnectionBusy = isColmiConnectionBusy(state);
  return {
    battery: makeBatteryReading(state),
    canMeasureHeartRate: state.status === 'connected'
      && state.isConnected
      && !isConnectionBusy
      && state.capabilities.supportsSmartHealthR99,
    connection: {
      deviceName: state.connectedDevice?.displayName,
      isConnected: state.isConnected,
      statusMessage: state.statusMessage,
    },
    heartRate: makeHeartRateReading(state),
    heartRateControlMode: state.capabilities.supportsSmartHealthR99 ? 'single' : 'none',
    heartRateMeasurementErrorMessage: state.smartHealthR99MeasurementErrorMessage,
    heartRateMeasurementStatus: state.smartHealthR99MeasurementStatus ?? 'idle',
    isConnectionBusy,
  };
}

function targetToScanDevice(target: BodySignalDeviceTarget) {
  return {
    authorizedAssociationId: target.authorizedAssociationId,
    confidence: 'model' as const,
    displayName: target.displayName,
    id: target.id,
    lastSeenAt: Date.now(),
    matchedKeyword: 'provider-target',
    protocolIdentity: target.protocolIdentity,
    score: 0,
  };
}

function getActiveBodySignalLiveSnapshot(): BodySignalLiveSnapshot {
  const guardian = getBodySignalGuardianRuntimeState();
  if (guardianOwnsBodySignalConnection(guardian)) return getGuardianBodySignalLiveSnapshot();
  const snapshot = colmiConnectionToBodySignalLiveSnapshot(getColmiConnectionSnapshot());
  const profile = getColmiProviderContext()?.profile;
  return {
    ...snapshot,
    ...(snapshot.battery && profile ? { battery: { ...snapshot.battery, deviceProfileId: profile.id } } : {}),
    ...(profile?.family === 'mi_band_6' ? getSavedMiBand6Battery(profile.id, snapshot.connection.isConnected, profile.lastConnectedAt) : {}),
    connection: { ...snapshot.connection, deviceProfileId: profile?.id, deviceFamily: profile?.family },
  };
}

export const colmiBodySignalProvider: BodySignalProviderAdapter = {
  connect: async (target, options) => {
    if (guardianOwnsBodySignalConnection(getBodySignalGuardianRuntimeState())) {
      await releaseGuardianForForegroundScan();
    }
    await connectColmiDevice(targetToScanDevice(target), { source: options?.source });
    return getColmiProviderContext();
  },
  disconnect: async (options) => {
    if (guardianOwnsBodySignalConnection(getBodySignalGuardianRuntimeState())) {
      await pauseGuardian();
      return;
    }
    await disconnectColmiDevice(options);
  },
  getSnapshot: getActiveBodySignalLiveSnapshot,
  probeCapabilities: async () => getColmiProviderContext(),
  readSnapshot: getActiveBodySignalLiveSnapshot,
  resume: async () => {
    if (guardianOwnsBodySignalConnection(getBodySignalGuardianRuntimeState())) {
      await retryGuardianNow();
      return;
    }
    const family = getColmiProviderContext()?.profile.family;
    if (family === 'mi_band_6') {
      await authenticateMiBand6AndSubscribeHeartRate();
    } else if (family === 'standard_gatt') {
      await subscribeColmiStandardHeartRate();
    }
  },
  subscribe: (listener) => {
    const emitActive = () => listener(getActiveBodySignalLiveSnapshot());
    const unsubscribeLegacy = subscribeColmiConnection(emitActive);
    const unsubscribeGuardian = subscribeBodySignalGuardianRuntime(emitActive);
    return () => {
      unsubscribeLegacy();
      unsubscribeGuardian();
    };
  },
  suspend: async () => {
    const guardian = getBodySignalGuardianRuntimeState();
    if (guardianOwnsBodySignalConnection(guardian)) {
      if (guardian.status === 'sampling') await stopGuardianHeartRate();
      return;
    }
    const status = getColmiConnectionSnapshot().miBand6RealtimeHeartRateSession.status;
    if (status === 'running' || status === 'starting') await stopMiBand6RealtimeHeartRate('manual');
  },
};
