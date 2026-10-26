export const MI_BAND_6_BATTERY_SERVICE_UUID = '0000fee0-0000-1000-8000-00805f9b34fb';
export const MI_BAND_6_BATTERY_CHARACTERISTIC_UUID = '00000006-0000-3512-2118-0009af100700';
export const MI_BAND_6_BATTERY_READ_TIMEOUT_MS = 5_000;
export const MI_BAND_6_BATTERY_MANUAL_INTERVAL_MS = 10_000;

export type MiBand6BatteryValue = { percent: number; charging?: boolean };
export type MiBand6BatteryTrigger = 'manual' | 'connected' | 'foreground' | 'scheduled_check';
export type MiBand6BatteryReading = MiBand6BatteryValue & { deviceProfileId: string; measuredAt: number; confidence: 'high' };
export type MiBand6BatteryCandidate = MiBand6BatteryValue & {
  deviceProfileId: string;
  measuredAt: number;
  confidence: 'low';
  // Only the three battery bytes, never the unverified tail or device identifiers.
  diagnosticPrefix: number[];
};

// Reference: Gadgetbridge 0a067d7313d0, HuamiBatteryInfo; no fabricated 50% fallback.
export function parseMiBand6Battery(bytes: readonly number[]): MiBand6BatteryValue | undefined {
  if (bytes.length < 3) return undefined;
  for (const value of bytes) if (!Number.isInteger(value) || value < 0 || value > 255) return undefined;
  const percent = bytes[1];
  if (percent > 100) return undefined;
  return { percent, ...(bytes[2] === 0 ? { charging: false } : bytes[2] === 1 ? { charging: true } : {}) };
}

export function miBand6BatteryErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : (error as { code?: string })?.code;
  switch (code) {
    case 'battery_update_required': return '当前安装包不支持正式手环电量读取，需要覆盖安装新版。';
    case 'battery_unverified': return '电量尚待真机验证，暂不自动读取。';
    case 'battery_profile_missing': return '当前连接的设备档案尚未就绪，暂不能读取电量。';
    case 'battery_characteristic_missing': return '当前连接没有发现小米手环电量通道。';
    case 'battery_not_readable': return '手环电量通道没有声明可读取，已停止本次读取。';
    case 'battery_unsupported': return '当前设备没有经过识别的可读电量通道。';
    case 'battery_not_ready': return '请先连接并完成手环认证。';
    case 'battery_busy': return '通道正在使用，请在心率测量或校时结束后再试。';
    case 'battery_cooldown': return '刚刚尝试过，请至少间隔十秒再读取。';
    case 'battery_timeout':
    case 'battery_connection_blocked': return '电量读取超时；本次连接不再读取电量，重连后可再试。';
    case 'battery_disconnected': return '连接已改变，本次结果已丢弃。';
    case 'battery_invalid_packet': return '未收到合法电量，保留上一次记录。';
    default: return '本次电量读取失败，保留上一次记录。';
  }
}
