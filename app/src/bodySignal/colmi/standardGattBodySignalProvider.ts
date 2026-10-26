import type {
  BodySignalLiveSnapshot,
  BodySignalProviderAdapter,
  StoredBodySignalReading,
} from '../bodySignalTypes';
import type { BodySignalDeviceTarget } from '../device/bodySignalDeviceTypes';
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

function isConnectionBusy(state: ColmiConnectionState): boolean {
  return state.status === 'connecting'
    || state.status === 'discovering'
    || state.status === 'subscribing'
    || state.initializationStatus === 'initializing'
    || state.initializationStatus === 'setting_time'
    || state.initializationStatus === 'reading_battery';
}

export function makeStandardGattHeartRateReading(
  state: ColmiConnectionState,
): StoredBodySignalReading | undefined {
  if (!state.standardHeartRateInfo) return undefined;
  return {
    confidence: 'high',
    kind: 'heart_rate',
    measuredAt: state.standardHeartRateInfo.receivedAt,
    sourceDeviceName: state.connectedDevice?.displayName,
    sourceProvider: 'standard_gatt',
    unit: 'bpm',
    value: state.standardHeartRateInfo.bpm,
  };
}

export function standardGattConnectionToBodySignalLiveSnapshot(
  state: ColmiConnectionState,
): BodySignalLiveSnapshot {
  const busy = isConnectionBusy(state);
  const heartRate = makeStandardGattHeartRateReading(state);
  const continuousSession = state.capabilities.supportsHuami2021Auth
    ? { ...state.miBand6RealtimeHeartRateSession }
    : undefined;
  const continuousStatus = continuousSession?.status;
  return {
    canMeasureHeartRate: Boolean(
      state.isConnected
      && state.capabilities.supportsHuami2021Auth
      && state.hasHuami2021AuthKey,
    ),
    connection: {
      deviceName: state.connectedDevice?.displayName,
      isConnected: state.isConnected,
      statusMessage: state.statusMessage,
    },
    heartRate,
    heartRateContinuousSession: continuousSession,
    heartRateControlMode: state.capabilities.supportsHuami2021Auth
      ? 'continuous'
      : 'none',
    heartRateMeasurementErrorMessage: continuousSession?.errorMessage
      ?? (state.standardHeartRateErrorMessage
        ? '标准心率监听暂时失败，请到设置页重新监听。'
        : undefined),
    heartRateMeasurementStatus: continuousStatus === 'error'
      ? 'error'
      : continuousStatus === 'starting' || continuousStatus === 'stopping'
        ? 'starting'
        : continuousStatus === 'running'
          ? heartRate ? 'received' : 'waiting'
          : heartRate ? 'received' : 'idle',
    isConnectionBusy: busy,
  };
}

function targetToScanDevice(target: BodySignalDeviceTarget) {
  return {
    authorizedAssociationId: target.authorizedAssociationId,
    confidence: 'model' as const,
    displayName: target.displayName,
    id: target.id,
    lastSeenAt: Date.now(),
    matchedKeyword: 'standard-gatt-provider-target',
    protocolIdentity: target.protocolIdentity,
    score: 0,
  };
}

export const standardGattBodySignalProvider: BodySignalProviderAdapter = {
  getSnapshot: () => standardGattConnectionToBodySignalLiveSnapshot(getColmiConnectionSnapshot()),
  connect: async (target, options) => {
    await connectColmiDevice(targetToScanDevice(target), { source: options?.source });
    const context = getColmiProviderContext();
    return context?.profile.family === 'mi_band_6' || context?.profile.family === 'standard_gatt'
      ? context
      : undefined;
  },
  disconnect: disconnectColmiDevice,
  probeCapabilities: async () => {
    const context = getColmiProviderContext();
    return context?.profile.family === 'mi_band_6' || context?.profile.family === 'standard_gatt'
      ? context
      : undefined;
  },
  readSnapshot: () => standardGattConnectionToBodySignalLiveSnapshot(getColmiConnectionSnapshot()),
  resume: async () => {
    const family = getColmiProviderContext()?.profile.family;
    if (family === 'mi_band_6') {
      await authenticateMiBand6AndSubscribeHeartRate();
    } else if (family === 'standard_gatt') {
      await subscribeColmiStandardHeartRate();
    }
  },
  subscribe: (listener) => subscribeColmiConnection((state) => {
    listener(standardGattConnectionToBodySignalLiveSnapshot(state));
  }),
  suspend: async () => {
    const status = getColmiConnectionSnapshot().miBand6RealtimeHeartRateSession.status;
    if (status === 'running' || status === 'starting') await stopMiBand6RealtimeHeartRate('manual');
  },
};
