import {
  BLUETOOTH_HEART_RATE_MEASUREMENT_CHARACTERISTIC_UUID,
  BLUETOOTH_HEART_RATE_SERVICE_UUID,
  HUAMI_2021_CHUNKED_READ_CHARACTERISTIC_UUID,
  HUAMI_2021_CHUNKED_WRITE_CHARACTERISTIC_UUID,
  normalizeColmiUuid,
} from './colmiBleConstants';
import type {
  ColmiCharacteristicChannel,
  ColmiDiscoveredService,
} from './colmiCharacteristicResolver';
import {
  SMART_HEALTH_R99_NOTIFY_CHARACTERISTIC_UUID,
  SMART_HEALTH_R99_SERVICE_UUID,
  SMART_HEALTH_R99_WRITE_CHARACTERISTIC_UUID,
} from './smartHealthR99Protocol';

export type BodySignalHeartRateTransport = 'none' | 'smarthealth_r99' | 'standard_gatt';

export type BodySignalBleCapabilities = {
  heartRateTransport: BodySignalHeartRateTransport;
  supportsColmiSafeCommands: boolean;
  supportsHuami2021Auth: boolean;
  supportsSmartHealthR99: boolean;
  supportsStandardHeartRate: boolean;
};

export const EMPTY_BODY_SIGNAL_BLE_CAPABILITIES: BodySignalBleCapabilities = {
  heartRateTransport: 'none',
  supportsColmiSafeCommands: false,
  supportsHuami2021Auth: false,
  supportsSmartHealthR99: false,
  supportsStandardHeartRate: false,
};

function hasCharacteristicAnywhere(
  services: readonly ColmiDiscoveredService[],
  characteristicUUID: string,
  predicate: (characteristic: ColmiDiscoveredService['characteristics'][number]) => boolean,
): boolean {
  const normalizedCharacteristicUUID = normalizeColmiUuid(characteristicUUID);
  return services.some((service) => service.characteristics.some(
    (characteristic) => (
      normalizeColmiUuid(characteristic.uuid) === normalizedCharacteristicUUID
      && predicate(characteristic)
    ),
  ));
}

function hasCharacteristic(
  services: readonly ColmiDiscoveredService[],
  serviceUUID: string,
  characteristicUUID: string,
  predicate: (characteristic: ColmiDiscoveredService['characteristics'][number]) => boolean = () => true,
): boolean {
  const normalizedServiceUUID = normalizeColmiUuid(serviceUUID);
  const normalizedCharacteristicUUID = normalizeColmiUuid(characteristicUUID);
  return services.some((service) => (
    normalizeColmiUuid(service.uuid) === normalizedServiceUUID
    && service.characteristics.some(
      (characteristic) => (
        normalizeColmiUuid(characteristic.uuid) === normalizedCharacteristicUUID
        && predicate(characteristic)
      ),
    )
  ));
}

export function detectBodySignalBleCapabilities(
  services: readonly ColmiDiscoveredService[],
  primaryChannel?: ColmiCharacteristicChannel,
): BodySignalBleCapabilities {
  const supportsSmartHealthR99 = hasCharacteristic(
    services,
    SMART_HEALTH_R99_SERVICE_UUID,
    SMART_HEALTH_R99_WRITE_CHARACTERISTIC_UUID,
  ) && hasCharacteristic(
    services,
    SMART_HEALTH_R99_SERVICE_UUID,
    SMART_HEALTH_R99_NOTIFY_CHARACTERISTIC_UUID,
  );
  const supportsStandardHeartRate = hasCharacteristic(
    services,
    BLUETOOTH_HEART_RATE_SERVICE_UUID,
    BLUETOOTH_HEART_RATE_MEASUREMENT_CHARACTERISTIC_UUID,
    (characteristic) => Boolean(characteristic.isNotifiable || characteristic.isIndicatable),
  );
  const supportsHuami2021Auth = hasCharacteristicAnywhere(
    services,
    HUAMI_2021_CHUNKED_WRITE_CHARACTERISTIC_UUID,
    (characteristic) => Boolean(
      characteristic.isWritableWithResponse || characteristic.isWritableWithoutResponse,
    ),
  ) && hasCharacteristicAnywhere(
    services,
    HUAMI_2021_CHUNKED_READ_CHARACTERISTIC_UUID,
    (characteristic) => Boolean(
      (characteristic.isNotifiable || characteristic.isIndicatable)
      && (characteristic.isWritableWithResponse || characteristic.isWritableWithoutResponse),
    ),
  );
  const supportsColmiSafeCommands = Boolean(
    primaryChannel
      && primaryChannel.role !== 'ae00'
      && primaryChannel.role !== 'be94'
      && primaryChannel.role !== 'fallback',
  );

  return {
    heartRateTransport: supportsSmartHealthR99
      ? 'smarthealth_r99'
      : supportsStandardHeartRate
        ? 'standard_gatt'
        : 'none',
    supportsColmiSafeCommands,
    supportsHuami2021Auth,
    supportsSmartHealthR99,
    supportsStandardHeartRate,
  };
}
