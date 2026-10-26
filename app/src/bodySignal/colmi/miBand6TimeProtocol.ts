import type { BodySignalBleCapabilities } from './bodySignalBleCapabilities';

export const MI_BAND_6_CURRENT_TIME_UUID = '00002a2b-0000-1000-8000-00805f9b34fb';

export function supportsMiBand6TimeCalibration(capabilities: BodySignalBleCapabilities): boolean {
  return capabilities.heartRateTransport === 'standard_gatt'
    && capabilities.supportsStandardHeartRate
    && capabilities.supportsHuami2021Auth
    && !capabilities.supportsSmartHealthR99;
}

// Huami's current-time value includes a DST-inclusive, signed quarter-hour UTC offset.
export function createMiBand6CurrentTime(now = new Date()): number[] {
  const year = now.getFullYear();
  const offset = -now.getTimezoneOffset() / 15;
  if (!Number.isFinite(now.getTime()) || year < 1582 || year > 9999
    || !Number.isInteger(offset) || offset < -48 || offset > 56) {
    throw new Error('time_sync_invalid_clock');
  }
  return [
    year & 0xff, year >>> 8, now.getMonth() + 1, now.getDate(),
    now.getHours(), now.getMinutes(), now.getSeconds(), (now.getDay() + 6) % 7 + 1,
    0, 0, offset & 0xff,
  ];
}

export function miBand6TimeSyncErrorMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code) : error instanceof Error ? error.message : '';
  switch (code) {
    case 'time_sync_not_ready':
    case 'time_sync_disconnected': return '请等手环连接并认证完成，再校准时间。';
    case 'time_sync_measuring': return '请先停止心率测量，再校准时间。';
    case 'time_sync_busy': return '手环正在处理操作，请稍后再校时。';
    case 'time_sync_unsupported': return '当前设备没有可用的手环校时通道。';
    case 'time_sync_update_required': return '当前安装包还不支持手环校时，请更新安装包。';
    case 'time_sync_timeout': return '校时没有及时收到确认，请检查连接后重试。';
    case 'time_sync_invalid_clock': return '手机日期或时区无效，请先检查手机时间设置。';
    default: return '未能确认手机时间已写入，请检查手环连接后重试。';
  }
}
