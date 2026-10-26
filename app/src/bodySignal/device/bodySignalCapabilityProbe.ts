import { detectBodySignalBleCapabilities } from '../colmi/bodySignalBleCapabilities';
import { MI_BAND_6_BATTERY_CHARACTERISTIC_UUID, MI_BAND_6_BATTERY_SERVICE_UUID } from '../colmi/miBand6BatteryProtocol';
import { MI_BAND_6_ACTIVITY_CONTROL, MI_BAND_6_ACTIVITY_DATA, MI_BAND_6_ACTIVITY_SERVICE } from '../colmi/miBand6ActivityProtocol';
import { normalizeColmiUuid } from '../colmi/colmiBleConstants';
import type {
  ColmiCharacteristicChannel,
  ColmiDiscoveredService,
} from '../colmi/colmiCharacteristicResolver';
import { decideBodySignalCapability } from '../evidence/bodySignalCapabilityLedger';
import { BODY_SIGNAL_CAPABILITY_LEDGER } from '../evidence/bodySignalCapabilityLedgerData';
import {
  EMPTY_BODY_SIGNAL_PROVIDER_CAPABILITIES,
  type BodySignalCapabilityProbeResult,
  type BodySignalDeviceFamily,
  type BodySignalProviderCapabilities,
} from './bodySignalDeviceTypes';

export type BodySignalCapabilityProbeInput = {
  primaryChannel?: ColmiCharacteristicChannel;
  services: readonly ColmiDiscoveredService[];
};

function ledgerFamily(family: BodySignalDeviceFamily): string {
  return family === 'standard_gatt' ? 'standard_gatt_heart_rate' : family;
}

function decision(family: BodySignalDeviceFamily, capability: string) {
  return decideBodySignalCapability(
    BODY_SIGNAL_CAPABILITY_LEDGER,
    ledgerFamily(family),
    capability,
  );
}

export function createBodySignalServiceFingerprint(
  services: readonly ColmiDiscoveredService[],
): string {
  return services
    .map((service) => service.uuid.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('|');
}

export function probeBodySignalCapabilities({
  primaryChannel,
  services,
}: BodySignalCapabilityProbeInput): BodySignalCapabilityProbeResult {
  const detected = detectBodySignalBleCapabilities(services, primaryChannel);
  const family: BodySignalDeviceFamily = detected.supportsSmartHealthR99
    ? 'smarthealth_r99'
    : detected.supportsStandardHeartRate && detected.supportsHuami2021Auth
      ? 'mi_band_6'
      : detected.supportsStandardHeartRate
        ? 'standard_gatt'
        : 'unknown';
  const realtime = decision(family, 'realtime_heart_rate');
  const continuous = decision(family, 'continuous_heart_rate_control');
  const activity = decision(family, 'activity_history');
  const capabilities: BodySignalProviderCapabilities = {
    ...EMPTY_BODY_SIGNAL_PROVIDER_CAPABILITIES,
    heartRate: family === 'mi_band_6' && realtime.isVerified && continuous.isVerified
      ? 'continuous'
      : family === 'smarthealth_r99' && realtime.isVerified
        ? 'single'
        : family === 'standard_gatt' && realtime.isVerified
          ? 'continuous'
          : 'none',
    battery: family === 'mi_band_6' && decision(family, 'battery').isVerified && services.some(service =>
      normalizeColmiUuid(service.uuid) === MI_BAND_6_BATTERY_SERVICE_UUID && service.characteristics.some(characteristic =>
        normalizeColmiUuid(characteristic.uuid) === MI_BAND_6_BATTERY_CHARACTERISTIC_UUID && characteristic.isReadable === true)),
    activity: family === 'mi_band_6' && activity.isVerified && services.some(service =>
      normalizeColmiUuid(service.uuid) === MI_BAND_6_ACTIVITY_SERVICE
      && service.characteristics.some(characteristic =>
        normalizeColmiUuid(characteristic.uuid) === MI_BAND_6_ACTIVITY_CONTROL
        && (characteristic.isWritableWithResponse === true || characteristic.isWritableWithoutResponse === true)
        && (characteristic.isNotifiable === true || characteristic.isIndicatable === true))
      && service.characteristics.some(characteristic =>
        normalizeColmiUuid(characteristic.uuid) === MI_BAND_6_ACTIVITY_DATA
        && (characteristic.isNotifiable === true || characteristic.isIndicatable === true))),
  };
  const verifiedCapabilityIds: string[] = [];
  if (capabilities.battery) verifiedCapabilityIds.push('battery');
  if (capabilities.activity) verifiedCapabilityIds.push('activity_history');
  if (capabilities.heartRate !== 'none') verifiedCapabilityIds.push('realtime_heart_rate');
  if (family === 'mi_band_6' && capabilities.heartRate === 'continuous') {
    verifiedCapabilityIds.push('authentication', 'continuous_heart_rate_control');
  }
  const verifiedWritePurposes = family === 'smarthealth_r99'
    ? [...realtime.authorizedWritePurposes]
    : family === 'mi_band_6'
      ? [...continuous.authorizedWritePurposes]
      : [];
  if (capabilities.activity) verifiedWritePurposes.push(...activity.authorizedWritePurposes);

  return {
    capabilities,
    family,
    serviceFingerprint: createBodySignalServiceFingerprint(services),
    verifiedCapabilityIds,
    verifiedWritePurposes,
  };
}
