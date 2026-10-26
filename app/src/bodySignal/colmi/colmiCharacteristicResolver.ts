import {
  COLMI_AE00_NOTIFY_CHARACTERISTIC_UUID,
  COLMI_AE00_SERVICE_UUID,
  COLMI_AE00_WRITE_CHARACTERISTIC_UUID,
  COLMI_BE94_NOTIFY_CHARACTERISTIC_UUID,
  COLMI_BE94_SERVICE_UUID,
  COLMI_BE94_WRITE_CHARACTERISTIC_UUID,
  COLMI_FEE7_NOTIFY_CHARACTERISTIC_UUID,
  COLMI_FEE7_SERVICE_UUID,
  COLMI_FEE7_WRITE_CHARACTERISTIC_UUID,
  COLMI_NORDIC_UART_SERVICE_UUID,
  COLMI_UART_FFF0_SERVICE_UUID,
  COLMI_UART_NOTIFY_CHARACTERISTIC_UUID,
  COLMI_UART_WRITE_CHARACTERISTIC_UUID,
  COLMI_V2_NOTIFY_CHARACTERISTIC_UUID,
  COLMI_V2_SERVICE_UUID,
  COLMI_V2_WRITE_CHARACTERISTIC_UUID,
  isStandardBluetoothServiceUuid,
  normalizeColmiUuid,
} from './colmiBleConstants';

export type ColmiDiscoveredCharacteristic = {
  isReadable?: boolean;
  isIndicatable?: boolean;
  isNotifiable?: boolean;
  isWritableWithResponse?: boolean;
  isWritableWithoutResponse?: boolean;
  serviceUUID: string;
  uuid: string;
};

export type ColmiDiscoveredService = {
  characteristics: ColmiDiscoveredCharacteristic[];
  uuid: string;
};

export type ColmiChannelRole = 'ae00' | 'fee7' | 'be94' | 'uart-fff0' | 'nordic-uart' | 'v2' | 'fallback';
export type ColmiChannelSource = 'known' | 'fallback';
export type ColmiWriteMode = 'withResponse' | 'withoutResponse';

export type ColmiCharacteristicChannel = {
  notifyCharacteristicUUID: string;
  role: ColmiChannelRole;
  serviceUUID: string;
  source: ColmiChannelSource;
  writeCharacteristicUUID: string;
  writeMode: ColmiWriteMode;
};

export type ColmiCharacteristicResolution =
  | {
      ok: true;
      candidates: ColmiCharacteristicChannel[];
      primary: ColmiCharacteristicChannel;
      serviceUUIDs: string[];
      v2?: ColmiCharacteristicChannel;
    }
  | {
      ok: false;
      reason: 'missing_channel' | 'missing_notify' | 'missing_write';
      serviceUUIDs: string[];
    };

type KnownChannelDefinition = {
  notifyUUID: string;
  preferredWriteMode?: ColmiWriteMode;
  role: Exclude<ColmiChannelRole, 'fallback'>;
  serviceUUID: string;
  writeUUID: string;
};

const KNOWN_CHANNELS: KnownChannelDefinition[] = [
  {
    notifyUUID: COLMI_AE00_NOTIFY_CHARACTERISTIC_UUID,
    preferredWriteMode: 'withoutResponse',
    role: 'ae00',
    serviceUUID: COLMI_AE00_SERVICE_UUID,
    writeUUID: COLMI_AE00_WRITE_CHARACTERISTIC_UUID,
  },
  {
    notifyUUID: COLMI_FEE7_NOTIFY_CHARACTERISTIC_UUID,
    preferredWriteMode: 'withoutResponse',
    role: 'fee7',
    serviceUUID: COLMI_FEE7_SERVICE_UUID,
    writeUUID: COLMI_FEE7_WRITE_CHARACTERISTIC_UUID,
  },
  {
    notifyUUID: COLMI_UART_NOTIFY_CHARACTERISTIC_UUID,
    role: 'uart-fff0',
    serviceUUID: COLMI_UART_FFF0_SERVICE_UUID,
    writeUUID: COLMI_UART_WRITE_CHARACTERISTIC_UUID,
  },
  {
    notifyUUID: COLMI_UART_NOTIFY_CHARACTERISTIC_UUID,
    role: 'nordic-uart',
    serviceUUID: COLMI_NORDIC_UART_SERVICE_UUID,
    writeUUID: COLMI_UART_WRITE_CHARACTERISTIC_UUID,
  },
  {
    notifyUUID: COLMI_BE94_NOTIFY_CHARACTERISTIC_UUID,
    preferredWriteMode: 'withResponse',
    role: 'be94',
    serviceUUID: COLMI_BE94_SERVICE_UUID,
    writeUUID: COLMI_BE94_WRITE_CHARACTERISTIC_UUID,
  },
  {
    notifyUUID: COLMI_V2_NOTIFY_CHARACTERISTIC_UUID,
    role: 'v2',
    serviceUUID: COLMI_V2_SERVICE_UUID,
    writeUUID: COLMI_V2_WRITE_CHARACTERISTIC_UUID,
  },
];

function normalizeServices(services: ColmiDiscoveredService[]): ColmiDiscoveredService[] {
  return services.map((service) => ({
    characteristics: service.characteristics.map((characteristic) => ({
      ...characteristic,
      serviceUUID: normalizeColmiUuid(characteristic.serviceUUID || service.uuid),
      uuid: normalizeColmiUuid(characteristic.uuid),
    })),
    uuid: normalizeColmiUuid(service.uuid),
  }));
}

function canWrite(characteristic: ColmiDiscoveredCharacteristic): boolean {
  return Boolean(characteristic.isWritableWithResponse || characteristic.isWritableWithoutResponse);
}

function canNotify(characteristic: ColmiDiscoveredCharacteristic): boolean {
  return Boolean(characteristic.isNotifiable || characteristic.isIndicatable);
}

function writeMode(characteristic?: ColmiDiscoveredCharacteristic, preferred?: ColmiWriteMode): ColmiWriteMode {
  if (preferred === 'withResponse' && characteristic?.isWritableWithResponse) return 'withResponse';
  if (preferred === 'withoutResponse' && characteristic?.isWritableWithoutResponse) return 'withoutResponse';
  return characteristic?.isWritableWithoutResponse ? 'withoutResponse' : 'withResponse';
}

function findKnownChannel(
  services: ColmiDiscoveredService[],
  definition: KnownChannelDefinition,
): ColmiCharacteristicChannel | null {
  const service = services.find((item) => item.uuid === definition.serviceUUID);
  if (!service) return null;
  const write = service.characteristics.find((characteristic) => characteristic.uuid === definition.writeUUID);
  const notify = service.characteristics.find((characteristic) => characteristic.uuid === definition.notifyUUID);
  if (!write || !notify) return null;
  return {
    notifyCharacteristicUUID: notify.uuid,
    role: definition.role,
    serviceUUID: service.uuid,
    source: 'known',
    writeCharacteristicUUID: write.uuid,
    writeMode: writeMode(write, definition.preferredWriteMode),
  };
}

function findFallbackChannel(services: ColmiDiscoveredService[]): ColmiCharacteristicChannel | null {
  for (const service of services) {
    if (isStandardBluetoothServiceUuid(service.uuid)) continue;
    const write = service.characteristics.find(canWrite);
    const notify = service.characteristics.find(canNotify);
    if (write && notify) {
      return {
        notifyCharacteristicUUID: notify.uuid,
        role: 'fallback',
        serviceUUID: service.uuid,
        source: 'fallback',
        writeCharacteristicUUID: write.uuid,
        writeMode: writeMode(write),
      };
    }
  }
  return null;
}

function sameChannel(left?: ColmiCharacteristicChannel, right?: ColmiCharacteristicChannel): boolean {
  return Boolean(
    left
      && right
      && left.serviceUUID === right.serviceUUID
      && left.writeCharacteristicUUID === right.writeCharacteristicUUID
      && left.notifyCharacteristicUUID === right.notifyCharacteristicUUID,
  );
}

function isDefaultProbeCandidate(channel: ColmiCharacteristicChannel): boolean {
  return channel.role !== 'v2' && channel.role !== 'be94';
}
function missingReason(services: ColmiDiscoveredService[]): 'missing_channel' | 'missing_notify' | 'missing_write' {
  const nonStandardCharacteristics = services
    .filter((service) => !isStandardBluetoothServiceUuid(service.uuid))
    .flatMap((service) => service.characteristics);
  if (!nonStandardCharacteristics.some(canWrite)) return 'missing_write';
  if (!nonStandardCharacteristics.some(canNotify)) return 'missing_notify';
  return 'missing_channel';
}

export function resolveColmiCharacteristics(services: ColmiDiscoveredService[]): ColmiCharacteristicResolution {
  const normalizedServices = normalizeServices(services);
  const serviceUUIDs = normalizedServices.map((service) => service.uuid);
  const known = KNOWN_CHANNELS.map((definition) => findKnownChannel(normalizedServices, definition)).filter(
    (channel): channel is ColmiCharacteristicChannel => Boolean(channel),
  );
  const v2 = known.find((channel) => channel.role === 'v2');
  const fallback = findFallbackChannel(normalizedServices);
  const primaryKnown = known.find((channel) => channel.role !== 'v2');
  const primary = primaryKnown ?? v2 ?? fallback;
  if (!primary) {
    return { ok: false, reason: missingReason(normalizedServices), serviceUUIDs };
  }
  const explicitCandidates = known.filter(isDefaultProbeCandidate);
  const candidates = fallback && !known.some((channel) => sameChannel(channel, fallback))
    ? [...explicitCandidates, fallback]
    : explicitCandidates;
  return {
    ok: true,
    candidates,
    primary,
    serviceUUIDs,
    v2: v2 && v2 !== primary ? v2 : undefined,
  };
}
