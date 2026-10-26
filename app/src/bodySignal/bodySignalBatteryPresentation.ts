import type { BodySignalSnapshot } from './bodySignalTypes';

export function bodySignalBatteryHint(snapshot: Pick<BodySignalSnapshot, 'battery' | 'batteryCharging'>, now = Date.now()): string {
  const reading = snapshot.battery;
  if (!reading) return '尚未读取电量';
  const date = new Date(reading.measuredAt);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  const time = sameDay ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const charging = snapshot.batteryCharging === true ? ' · 充电中' : snapshot.batteryCharging === false ? ' · 未充电' : '';
  return `${reading.stale ? '上次记录' : '刚读到'} · ${time}${charging}`;
}
