import type { BodySignalLiveSnapshot } from '../bodySignalTypes';

export type BodySignalDeviceFamily =
  | 'mi_band_6'
  | 'smarthealth_r99'
  | 'standard_gatt'
  | 'unknown';

export type BodySignalHeartRateCapability = 'continuous' | 'history' | 'none' | 'single';

export type BodySignalProviderCapabilities = {
  activity: boolean;
  battery: boolean;
  heartRate: BodySignalHeartRateCapability;
  hrv: boolean;
  sleep: boolean;
  spo2: boolean;
  stress: boolean;
  workout: boolean;
};

export const EMPTY_BODY_SIGNAL_PROVIDER_CAPABILITIES: BodySignalProviderCapabilities = {
  activity: false,
  battery: false,
  heartRate: 'none',
  hrv: false,
  sleep: false,
  spo2: false,
  stress: false,
  workout: false,
};

export type BodySignalDeviceProfile = {
  authorizedAssociationId?: string;
  createdAt: number;
  displayName: string;
  family: BodySignalDeviceFamily;
  id: string;
  isPrimary: boolean;
  lastAdvertisingId?: string;
  lastConnectedAt?: number;
  protocolIdentity?: string;
  serviceFingerprint?: string;
  transportIdentity?: string;
  updatedAt: number;
};

export type BodySignalDeviceTarget = {
  authorizedAssociationId?: string;
  displayName: string;
  id: string;
  protocolIdentity?: string;
};

export type BodySignalConnectionSource = 'automatic' | 'manual';

export type BodySignalProviderContext = {
  capabilities: BodySignalProviderCapabilities;
  profile: BodySignalDeviceProfile;
};

export type BodySignalCapabilityProbeResult = {
  capabilities: BodySignalProviderCapabilities;
  family: BodySignalDeviceFamily;
  serviceFingerprint: string;
  verifiedCapabilityIds: string[];
  verifiedWritePurposes: string[];
};

export type BodySignalProviderListener = (snapshot: BodySignalLiveSnapshot) => void;
