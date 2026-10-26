export const HUAMI_2021_SERVICES_ENDPOINT = 0x0000;
export const HUAMI_2021_HEART_RATE_ENDPOINT = 0x001d;

export const HUAMI_2021_SERVICES_REQUEST = Uint8Array.from([0x03]);
export const HUAMI_2021_HEART_RATE_START = Uint8Array.from([0x04, 0x01]);
export const HUAMI_2021_HEART_RATE_CONTINUE = Uint8Array.from([0x04, 0x02]);
export const HUAMI_2021_HEART_RATE_STOP = Uint8Array.from([0x04, 0x00]);

export type MiBand6HeartRateControlPurpose =
  | 'start_manual'
  | 'start_continuous'
  | 'stop_continuous'
  | 'stop_manual';

export const MI_BAND_6_HEART_RATE_START_MANUAL = Uint8Array.from([0x15, 0x02, 0x01]);
export const MI_BAND_6_HEART_RATE_STOP_MANUAL = Uint8Array.from([0x15, 0x02, 0x00]);
export const MI_BAND_6_HEART_RATE_START_CONTINUOUS = Uint8Array.from([0x15, 0x01, 0x01]);
export const MI_BAND_6_HEART_RATE_STOP_CONTINUOUS = Uint8Array.from([0x15, 0x01, 0x00]);

export const MI_BAND_6_REALTIME_HEART_RATE_DURATION_MS = 5 * 60 * 1000;
export const MI_BAND_6_REALTIME_HEART_RATE_SAMPLE_INTERVAL_MS = 15 * 1000;
export const MI_BAND_6_MANUAL_HEART_RATE_TIMEOUT_MS = 45 * 1000;
export const MI_BAND_6_REALTIME_HEART_RATE_TICK_MS = 1000;
export const MI_BAND_6_REALTIME_HEART_RATE_MAX_MISSED_TICKS = 3;

export function isMiBand6RealtimeHeartRateStartInProgress(status: string): boolean {
  return status === 'running' || status === 'starting';
}

export function miBand6RealtimeHeartRateEndsAt(startedAt: number): number {
  return startedAt + MI_BAND_6_REALTIME_HEART_RATE_DURATION_MS;
}

export function shouldStopMiBand6RealtimeHeartRateForMissedTicks(
  issuedTickId: number,
  acknowledgedTickId: number,
): boolean {
  return issuedTickId - acknowledgedTickId >= MI_BAND_6_REALTIME_HEART_RATE_MAX_MISSED_TICKS;
}

export type MiBand6RealtimeSampleAction = 'ack' | 'fallback_continuous' | 'restart_manual';

export function chooseMiBand6RealtimeSampleAction(input: {
  continuousFallbackActive: boolean;
  manualMeasurementReceivedAt?: number;
  manualMeasurementStartedAt?: number;
  now: number;
}): MiBand6RealtimeSampleAction {
  if (input.continuousFallbackActive || input.manualMeasurementStartedAt === undefined) {
    return 'ack';
  }

  if (
    input.manualMeasurementReceivedAt !== undefined
    && input.manualMeasurementReceivedAt >= input.manualMeasurementStartedAt
  ) {
    return input.now - input.manualMeasurementReceivedAt
      >= MI_BAND_6_REALTIME_HEART_RATE_SAMPLE_INTERVAL_MS
      ? 'restart_manual'
      : 'ack';
  }

  return input.now - input.manualMeasurementStartedAt >= MI_BAND_6_MANUAL_HEART_RATE_TIMEOUT_MS
    ? 'fallback_continuous'
    : 'ack';
}

export type Huami2021SafePurpose =
  | 'heart_rate_continue'
  | 'heart_rate_start'
  | 'heart_rate_stop'
  | 'services_list';

export function huami2021HeartRateCommandRequiresAck(
  purpose: Exclude<Huami2021SafePurpose, 'services_list'>,
): boolean {
  return purpose === 'heart_rate_start';
}

export type Huami2021ServiceEntry = {
  encrypted: boolean;
  endpoint: number;
};

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function assertMiBand6HeartRateControlCommand(
  purpose: MiBand6HeartRateControlPurpose,
  payload: Uint8Array,
): void {
  const allowed =
    (purpose === 'start_manual' && bytesEqual(payload, MI_BAND_6_HEART_RATE_START_MANUAL))
    ||
    (purpose === 'stop_manual' && bytesEqual(payload, MI_BAND_6_HEART_RATE_STOP_MANUAL))
    || (purpose === 'start_continuous' && bytesEqual(payload, MI_BAND_6_HEART_RATE_START_CONTINUOUS))
    || (purpose === 'stop_continuous' && bytesEqual(payload, MI_BAND_6_HEART_RATE_STOP_CONTINUOUS));
  if (!allowed) {
    throw new RangeError('拒绝发送未列入白名单的小米手环 6 心率控制指令。');
  }
}

export function assertHuami2021SafeCommand(
  purpose: Huami2021SafePurpose,
  endpoint: number,
  payload: Uint8Array,
  supportedEndpoints?: ReadonlySet<number>,
): void {
  const allowed = purpose === 'services_list'
    ? endpoint === HUAMI_2021_SERVICES_ENDPOINT && bytesEqual(payload, HUAMI_2021_SERVICES_REQUEST)
    : endpoint === HUAMI_2021_HEART_RATE_ENDPOINT
      && (
        (purpose === 'heart_rate_start' && bytesEqual(payload, HUAMI_2021_HEART_RATE_START))
        || (purpose === 'heart_rate_continue' && bytesEqual(payload, HUAMI_2021_HEART_RATE_CONTINUE))
        || (purpose === 'heart_rate_stop' && bytesEqual(payload, HUAMI_2021_HEART_RATE_STOP))
      );

  if (!allowed) {
    throw new RangeError('拒绝发送未列入白名单的 Huami 2021 指令。');
  }
  if (
    supportedEndpoints
    && purpose !== 'services_list'
    && !supportedEndpoints.has(endpoint)
  ) {
    throw new RangeError('手环服务清单没有开放实时心率端点。');
  }
}

export function parseHuami2021ServiceList(payload: Uint8Array): Huami2021ServiceEntry[] {
  if (payload.length < 3 || payload[0] !== 0x04) {
    throw new RangeError('Huami 2021 服务清单结构不合法。');
  }
  const count = payload[1] | (payload[2] << 8);
  const expectedLength = 3 + count * 3;
  if (payload.length !== expectedLength) {
    throw new RangeError('Huami 2021 服务清单长度不匹配。');
  }

  const entries: Huami2021ServiceEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 3 + index * 3;
    const encryptedByte = payload[offset + 2];
    if (encryptedByte !== 0 && encryptedByte !== 1) {
      throw new RangeError('Huami 2021 服务清单包含未知加密标记。');
    }
    entries.push({
      encrypted: encryptedByte === 1,
      endpoint: payload[offset] | (payload[offset + 1] << 8),
    });
  }
  return entries;
}

export function parseHuami2021HeartRateAck(payload: Uint8Array): {
  ok: boolean;
  status: number;
} | undefined {
  if (payload.length < 2 || payload[0] !== 0x05) return undefined;
  return {
    ok: payload[1] === 0,
    status: payload[1],
  };
}
