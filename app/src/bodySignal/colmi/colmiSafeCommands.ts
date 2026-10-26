import { COLMI_PACKET_LENGTH, makeColmiPacket } from './colmiPacket';

export const COLMI_COMMAND_SET_TIME = 0x01;
export const COLMI_COMMAND_BATTERY = 0x03;
export const COLMI_COMMAND_PHONE_NAME = 0x04;

export type ColmiBatteryInfo = {
  batteryLevel: number;
  charging: boolean;
  receivedAt: number;
};

function assertByteRange(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${label} must be an integer between 0 and 255`);
  }
}

export function toBcdByte(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 99) {
    throw new RangeError('BCD value must be an integer between 0 and 99');
  }
  return ((Math.floor(value / 10) << 4) | (value % 10)) & 0xff;
}

export function isColmiPacketForCommand(bytes: readonly number[], command: number): boolean {
  assertByteRange(command, 'command');
  return bytes.length === COLMI_PACKET_LENGTH && bytes[0] === command;
}

export function createColmiSetLocalTimePacket(date = new Date()): number[] {
  return makeColmiPacket(COLMI_COMMAND_SET_TIME, [
    toBcdByte(date.getFullYear() % 100),
    toBcdByte(date.getMonth() + 1),
    toBcdByte(date.getDate()),
    toBcdByte(date.getHours()),
    toBcdByte(date.getMinutes()),
    toBcdByte(date.getSeconds()),
  ]);
}

export function createColmiBatteryPacket(): number[] {
  return makeColmiPacket(COLMI_COMMAND_BATTERY);
}

export function createColmiPhoneNamePacket(): number[] {
  return makeColmiPacket(COLMI_COMMAND_PHONE_NAME, [0x02, 0x0a, 0x47, 0x42]);
}

export function parseColmiBatteryPacket(bytes: readonly number[], receivedAt = Date.now()): ColmiBatteryInfo {
  if (!isColmiPacketForCommand(bytes, COLMI_COMMAND_BATTERY)) {
    throw new RangeError('battery packet must be a 16-byte COLMI 0x03 packet');
  }
  const batteryLevel = bytes[1];
  if (!Number.isInteger(batteryLevel) || batteryLevel < 0 || batteryLevel > 100) {
    throw new RangeError('battery level must be between 0 and 100');
  }
  return {
    batteryLevel,
    charging: bytes[2] !== 0,
    receivedAt,
  };
}

