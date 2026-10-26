import type { HeartRateTodaySummary } from './bodySignalHistory';
import type {
  BodySignalConnectionSource,
  BodySignalDeviceTarget,
  BodySignalProviderContext,
  BodySignalProviderListener,
} from './device/bodySignalDeviceTypes';

export type BodySignalKind = 'battery' | 'heart_rate' | 'hrv' | 'spo2' | 'stress';

export type BodySignalProvider = 'colmi_rxx' | 'smarthealth_r99' | 'standard_gatt' | 'mi_band_6' | 'unknown';

export type BodySignalConfidence = 'high' | 'low' | 'medium' | 'unknown';

export type BodySignalMeasurementStatus = 'error' | 'idle' | 'received' | 'starting' | 'waiting';

export type BodySignalHeartRateControlMode = 'continuous' | 'none' | 'single';

export type BodySignalContinuousHeartRateStatus =
  | 'completed'
  | 'error'
  | 'idle'
  | 'running'
  | 'starting'
  | 'stopping';

export type BodySignalContinuousHeartRateSession = {
  endsAt?: number;
  errorMessage?: string;
  startedAt?: number;
  status: BodySignalContinuousHeartRateStatus;
};

export type BodySignalReading = {
  confidence: BodySignalConfidence;
  deviceProfileId?: string;
  kind: BodySignalKind;
  measuredAt: number;
  sourceDeviceName?: string;
  sourceProvider: BodySignalProvider;
  stale: boolean;
  unit: string;
  value: number;
};

export type StoredBodySignalReading = Omit<BodySignalReading, 'stale'>;

export type BodySignalConnectionSummary = {
  deviceFamily?: import('./device/bodySignalDeviceTypes').BodySignalDeviceFamily;
  deviceProfileId?: string;
  deviceName?: string;
  isConnected: boolean;
  statusMessage: string;
};

export type BodySignalLiveSnapshot = {
  battery?: StoredBodySignalReading;
  batteryCharging?: boolean;
  canMeasureHeartRate: boolean;
  connection: BodySignalConnectionSummary;
  heartRate?: StoredBodySignalReading;
  heartRateContinuousSession?: BodySignalContinuousHeartRateSession;
  heartRateControlMode: BodySignalHeartRateControlMode;
  heartRateMeasurementErrorMessage?: string;
  heartRateMeasurementStatus: BodySignalMeasurementStatus;
  isConnectionBusy: boolean;
};

export type BodySignalSnapshot = {
  battery?: BodySignalReading;
  batteryCharging?: boolean;
  canMeasureHeartRate: boolean;
  connection: BodySignalConnectionSummary;
  heartRate?: BodySignalReading;
  heartRateContinuousSession?: BodySignalContinuousHeartRateSession;
  heartRateControlMode: BodySignalHeartRateControlMode;
  heartRateMeasurementErrorMessage?: string;
  heartRateMeasurementStatus: BodySignalMeasurementStatus;
  heartRateTodaySummary?: HeartRateTodaySummary;
  isConnectionBusy: boolean;
  isMeasuringHeartRate: boolean;
  isReceivingHeartRate: boolean;
  recentHeartRates: BodySignalReading[];
};

export type BodySignalProviderAdapter = {
  connect: (target: BodySignalDeviceTarget, options?: { source?: BodySignalConnectionSource }) => Promise<BodySignalProviderContext | undefined>;
  disconnect: (options?: { suppressAutoReconnect?: boolean }) => Promise<void>;
  getSnapshot: () => BodySignalLiveSnapshot;
  probeCapabilities: () => Promise<BodySignalProviderContext | undefined>;
  readSnapshot: () => BodySignalLiveSnapshot;
  resume: () => Promise<void>;
  subscribe: (listener: BodySignalProviderListener) => () => void;
  suspend: () => Promise<void>;
};
