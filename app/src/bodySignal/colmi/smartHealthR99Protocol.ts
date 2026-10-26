export const SMART_HEALTH_R99_SERVICE_UUID = 'be940000-7333-be46-b7ae-689e71722bd5';
export const SMART_HEALTH_R99_WRITE_CHARACTERISTIC_UUID = 'be940001-7333-be46-b7ae-689e71722bd5';
export const SMART_HEALTH_R99_NOTIFY_CHARACTERISTIC_UUID = 'be940003-7333-be46-b7ae-689e71722bd5';

export const SMART_HEALTH_R99_HEART_RATE_PRELUDE_PACKETS = [
  [0x03, 0x09, 0x09, 0x00, 0x01, 0x00, 0x02, 0xa0, 0xde],
  [0x03, 0x09, 0x09, 0x00, 0x00, 0x00, 0x02, 0x90, 0xe9],
] as const;

export const SMART_HEALTH_R99_PRELUDE_DELAY_MS = 1000;
export const SMART_HEALTH_R99_START_DELAY_MS = 3200;
export const SMART_HEALTH_R99_RECENT_READING_GRACE_MS = 15000;

export const SMART_HEALTH_R99_START_HEART_RATE_PACKET = [
  0x03, 0x2f, 0x08, 0x00, 0x01, 0x00, 0x4f, 0x1b,
] as const;

export type SmartHealthR99HeartRateInfo = {
  bpm: number;
  rawHex: string;
  receivedAt: number;
};

export function parseSmartHealthR99HeartRate(bytes: readonly number[]): number | undefined {
  if (bytes.length < 5) return undefined;
  if (bytes[0] !== 0x06 || bytes[1] !== 0x01 || bytes[2] !== 0x07) return undefined;
  const bpm = bytes[4];
  if (bpm <= 0 || bpm > 240) return undefined;
  return bpm;
}