export const SMART_HEALTH_R99_BATTERY_COMMAND = 0x0200;
export const SMART_HEALTH_R99_BATTERY_PREFLIGHT_COMMAND = 0x021b;

// YCBT SDK getChipScheme(): the real R99 capture sends this before getDeviceInfo().
export const SMART_HEALTH_R99_BATTERY_PREFLIGHT_PACKET = [
  0x02, 0x1b, 0x06, 0x00, 0x9c, 0x70,
] as const;

// The captured reply arrived in 18 ms and getDeviceInfo followed 46 ms later.
export const SMART_HEALTH_R99_BATTERY_PREFLIGHT_DELAY_MS = 100;

// YCBT SDK getDeviceInfo(): command 0x0200, payload 0x47 0x43, CRC16 low byte first.
export const SMART_HEALTH_R99_BATTERY_REQUEST_PACKET = [
  0x02, 0x00, 0x08, 0x00, 0x47, 0x43, 0x6f, 0xec,
] as const;

export const SMART_HEALTH_R99_BATTERY_RESPONSE_WAIT_MS = 1800;

// Automatic reads stay closed until a second capture proves a different percentage.
export const SMART_HEALTH_R99_BATTERY_AUTOMATION_VERIFIED = false;

export type SmartHealthR99BatteryInfo = {
  batteryLevel: number;
  deviceBatteryState: number;
  rawHex: string;
  receivedAt: number;
};

export function calculateSmartHealthR99Crc16(
  bytes: readonly number[],
  initialValue = 0xffff,
): number {
  let crc = initialValue & 0xffff;
  for (const byte of bytes) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new RangeError('CRC input bytes must be integers from 0 to 255.');
    }
    crc = (((crc >> 8) & 0xff) | ((crc << 8) & 0xff00)) ^ byte;
    crc ^= (crc & 0xff) >> 4;
    crc ^= (crc << 12) & 0xffff;
    crc ^= ((crc & 0xff) << 5) & 0xffff;
    crc &= 0xffff;
  }
  return crc;
}

function isValidSmartHealthR99Frame(bytes: readonly number[]): boolean {
  if (bytes.length < 6) return false;
  const declaredLength = bytes[2] | (bytes[3] << 8);
  if (declaredLength !== bytes.length) return false;

  const expectedCrc = calculateSmartHealthR99Crc16(bytes.slice(0, -2));
  return bytes[bytes.length - 2] === (expectedCrc & 0xff)
    && bytes[bytes.length - 1] === ((expectedCrc >> 8) & 0xff);
}

export function isSmartHealthR99BatteryPreflightResponse(bytes: readonly number[]): boolean {
  if (!isValidSmartHealthR99Frame(bytes)) return false;
  return ((bytes[0] << 8) | bytes[1]) === SMART_HEALTH_R99_BATTERY_PREFLIGHT_COMMAND;
}

export function parseSmartHealthR99Battery(
  bytes: readonly number[],
  receivedAt = Date.now(),
): SmartHealthR99BatteryInfo | undefined {
  // Header (4) + device-info payload through battery byte (6) + CRC (2).
  if (bytes.length < 12 || !isValidSmartHealthR99Frame(bytes)) return undefined;
  const command = (bytes[0] << 8) | bytes[1];
  if (command !== SMART_HEALTH_R99_BATTERY_COMMAND) return undefined;

  const deviceBatteryState = bytes[8];
  const batteryLevel = bytes[9];
  if (batteryLevel < 0 || batteryLevel > 100) return undefined;

  return {
    batteryLevel,
    deviceBatteryState,
    rawHex: bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
    receivedAt,
  };
}
