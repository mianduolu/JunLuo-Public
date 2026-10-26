import { calculateColmiChecksum, COLMI_PACKET_LENGTH } from './colmiPacket';
import {
  COLMI_COMMAND_SET_TIME,
  createColmiBatteryPacket,
  createColmiPhoneNamePacket,
} from './colmiSafeCommands';
import {
  SMART_HEALTH_R99_HEART_RATE_PRELUDE_PACKETS,
  SMART_HEALTH_R99_START_HEART_RATE_PACKET,
} from './smartHealthR99Protocol';
import {
  SMART_HEALTH_R99_BATTERY_PREFLIGHT_PACKET,
  SMART_HEALTH_R99_BATTERY_REQUEST_PACKET,
} from './smartHealthR99BatteryProtocol';

export type ColmiSafeWritePurpose =
  | 'set_time'
  | 'battery'
  | 'phone_name'
  | 'channel_probe_battery'
  | 'smarthealth_r99_battery'
  | 'smarthealth_r99_heart_rate';

const SAFE_WRITE_PURPOSES = new Set<ColmiSafeWritePurpose>([
  'set_time',
  'battery',
  'phone_name',
  'channel_probe_battery',
  'smarthealth_r99_battery',
  'smarthealth_r99_heart_rate',
]);

function packetsEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function isValidColmiPacket(packet: readonly number[], command: number): boolean {
  if (packet.length !== COLMI_PACKET_LENGTH || packet[0] !== command) return false;
  try {
    return packet[COLMI_PACKET_LENGTH - 1]
      === calculateColmiChecksum(packet.slice(0, COLMI_PACKET_LENGTH - 1));
  } catch {
    return false;
  }
}

function decodeBcdByte(byte: number): number | undefined {
  const high = (byte >> 4) & 0x0f;
  const low = byte & 0x0f;
  return high <= 9 && low <= 9 ? high * 10 + low : undefined;
}

function isValidSetTimePacket(packet: readonly number[]): boolean {
  if (!isValidColmiPacket(packet, COLMI_COMMAND_SET_TIME)) return false;
  if (!packet.slice(7, COLMI_PACKET_LENGTH - 1).every((byte) => byte === 0)) return false;

  const [year, month, day, hours, minutes, seconds] = packet
    .slice(1, 7)
    .map(decodeBcdByte);
  if (
    year === undefined
    || month === undefined
    || day === undefined
    || hours === undefined
    || minutes === undefined
    || seconds === undefined
    || month < 1
    || month > 12
    || day < 1
    || day > 31
    || hours > 23
    || minutes > 59
    || seconds > 59
  ) return false;

  const date = new Date(Date.UTC(2000 + year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isKnownSmartHealthHeartRatePacket(packet: readonly number[]): boolean {
  return SMART_HEALTH_R99_HEART_RATE_PRELUDE_PACKETS.some((candidate) => packetsEqual(packet, candidate))
    || packetsEqual(packet, SMART_HEALTH_R99_START_HEART_RATE_PACKET);
}

export function assertColmiSafeWrite(
  purpose: ColmiSafeWritePurpose,
  packet: readonly number[],
): void {
  if (!SAFE_WRITE_PURPOSES.has(purpose)) {
    throw new Error(`BLE write denied: unknown purpose ${String(purpose)}`);
  }

  const allowed = purpose === 'set_time'
    ? isValidSetTimePacket(packet)
    : purpose === 'battery' || purpose === 'channel_probe_battery'
      ? packetsEqual(packet, createColmiBatteryPacket())
      : purpose === 'phone_name'
        ? packetsEqual(packet, createColmiPhoneNamePacket())
        : purpose === 'smarthealth_r99_battery'
          ? packetsEqual(packet, SMART_HEALTH_R99_BATTERY_PREFLIGHT_PACKET)
            || packetsEqual(packet, SMART_HEALTH_R99_BATTERY_REQUEST_PACKET)
          : isKnownSmartHealthHeartRatePacket(packet);

  if (!allowed) {
    throw new Error(`BLE write denied: packet does not match purpose ${purpose}`);
  }
}
