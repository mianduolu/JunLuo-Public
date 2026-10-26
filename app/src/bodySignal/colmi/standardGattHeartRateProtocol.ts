export const STANDARD_GATT_HEART_RATE_MAX_BPM = 300;
export const STANDARD_GATT_HEART_RATE_MIN_BPM = 1;
export const STANDARD_GATT_HEART_RATE_PERSIST_INTERVAL_MS = 15 * 1000;

export type StandardGattHeartRateMeasurement = {
  bpm: number;
  usesUint16: boolean;
};

export type StandardGattHeartRatePersistenceState = {
  deviceId?: string;
  persistedAt?: number;
};

export function parseStandardGattHeartRateMeasurement(
  bytes: readonly number[],
): StandardGattHeartRateMeasurement | undefined {
  if (bytes.length < 2) return undefined;

  const usesUint16 = (bytes[0] & 0x01) === 0x01;
  if (usesUint16 && bytes.length < 3) return undefined;

  const bpm = usesUint16
    ? bytes[1] | (bytes[2] << 8)
    : bytes[1];
  if (bpm < STANDARD_GATT_HEART_RATE_MIN_BPM || bpm > STANDARD_GATT_HEART_RATE_MAX_BPM) {
    return undefined;
  }

  return { bpm, usesUint16 };
}

export function shouldPersistStandardGattHeartRate(input: {
  deviceId: string;
  receivedAt: number;
  state?: StandardGattHeartRatePersistenceState;
}): boolean {
  if (!input.state?.deviceId || input.state.deviceId !== input.deviceId) return true;
  if (!input.state.persistedAt) return true;
  return input.receivedAt - input.state.persistedAt >= STANDARD_GATT_HEART_RATE_PERSIST_INTERVAL_MS;
}
