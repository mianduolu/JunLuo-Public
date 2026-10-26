import { BODY_SIGNAL_STALE_MS } from './bodySignalSnapshot';
import { formatBodySignalReadingContext, type BodySignalReadingContext } from './bodySignalReadingContext';
import type {
  BodySignalConfidence,
  BodySignalReading,
  BodySignalSnapshot,
} from './bodySignalTypes';

export const BODY_SIGNAL_TOOL_PACKAGE_DESCRIPTION = '只读君落已保存的身体信号。';
export const BODY_SIGNAL_LATEST_TOOL_DESCRIPTION = '读取最近记录及时间、新鲜度、来源和可信度。';
export const BODY_SIGNAL_SUMMARY_TOOL_DESCRIPTION = '读取今日心率的最近值、次数、平均值、范围和最近记录；不发起测量。';
export const BODY_SIGNAL_BATTERY_TOOL_DESCRIPTION = '读取君落本地已保存的最近一次穿戴设备电量及时间、新鲜度、来源和可信度；只读取，不连接或测量。';
export const BODY_SIGNAL_EMPTY_TEXT = '君落本地暂时没有身体信号记录。';
export const BODY_SIGNAL_BATTERY_EMPTY_TEXT = '君落本地暂时没有穿戴设备电量记录。';
export const BODY_SIGNAL_LOW_BATTERY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const BODY_SIGNAL_LOW_BATTERY_THRESHOLD = 20;

export const BODY_SIGNAL_AMBIENT_TEMPLATE = `【you 最近保存的身体信号】

最近心率：{心率} bpm；记录于 {时间}；{新鲜度}；来源：{设备名}。
今天共记录 {次数} 次；平均 {平均值} bpm；范围 {最低值}-{最高值} bpm。
最近几次：{最近五次心率与时间}。

这些是穿戴设备在所标时间留下的生活记录。单次心率不表示 you 是否睡着。`;

export const BODY_SIGNAL_LOW_BATTERY_AMBIENT_TEMPLATE = `【you 的穿戴设备最近保存的电量】

设备：{设备名}
电量：{电量}%；记录于 {时间}。
这是穿戴设备的电量，不是 you 的身体状态。`;

export type BodySignalAiFreshness = '刚读到' | '较早记录';

export type BodySignalAiReading = {
  confidence: BodySignalConfidence;
  freshness: BodySignalAiFreshness;
  measuredAt: number;
  sourceDeviceName: string;
  unit: string;
  value: number;
};

export type BodySignalAiTodaySummary = {
  average: number;
  count: number;
  latestMeasuredAt: number;
  max: number;
  min: number;
};

export type BodySignalAiSnapshot = {
  checkedAt: number;
  latestBattery?: BodySignalAiReading;
  latestHeartRate?: BodySignalAiReading;
  recentHeartRates: BodySignalAiReading[];
  todaySummary?: BodySignalAiTodaySummary;
};

const INTERNAL_DEVICE_PATTERN = /(?:\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b|\bbe94\b|\bfee7\b|\bprovider\b|\bhex\b)/i;

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

function sanitizeDeviceName(value: string | undefined) {
  const normalized = value?.replace(/[\r\n\t]+/g, ' ').trim();
  if (!normalized || INTERNAL_DEVICE_PATTERN.test(normalized)) return '穿戴设备';
  return normalized.slice(0, 80);
}

export function isSameLocalDay(left: number, right: number) {
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  return leftDate.getFullYear() === rightDate.getFullYear()
    && leftDate.getMonth() === rightDate.getMonth()
    && leftDate.getDate() === rightDate.getDate();
}

export function formatBodySignalTime(time: number, now: number) {
  const date = new Date(time);
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (isSameLocalDay(time, now)) return `今天 ${clock}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

function toAiReading(reading: BodySignalReading, now: number): BodySignalAiReading {
  return {
    confidence: reading.confidence,
    freshness: now - reading.measuredAt <= BODY_SIGNAL_STALE_MS ? '刚读到' : '较早记录',
    measuredAt: reading.measuredAt,
    sourceDeviceName: sanitizeDeviceName(reading.sourceDeviceName),
    unit: reading.unit,
    value: reading.value,
  };
}

export function presentBodySignalSnapshot(
  snapshot: BodySignalSnapshot,
  now = Date.now(),
): BodySignalAiSnapshot {
  const latestHeartRate = snapshot.heartRate
    ? toAiReading(snapshot.heartRate, now)
    : undefined;
  const latestBattery = snapshot.battery
    ? toAiReading(snapshot.battery, now)
    : undefined;
  const recentHeartRates = snapshot.recentHeartRates
    .filter((reading) => reading.kind === 'heart_rate' && Number.isFinite(reading.value) && reading.value > 0)
    .slice(0, 5)
    .map((reading) => toAiReading(reading, now));

  return {
    checkedAt: now,
    latestBattery,
    latestHeartRate,
    recentHeartRates,
    ...(snapshot.heartRateTodaySummary
      ? { todaySummary: { ...snapshot.heartRateTodaySummary } }
      : {}),
  };
}

function confidenceLabel(confidence: BodySignalConfidence) {
  const labels: Record<BodySignalConfidence, string> = {
    high: '高',
    low: '低',
    medium: '中',
    unknown: '未知',
  };
  return labels[confidence];
}

function formatRecentHeartRates(readings: BodySignalAiReading[], now: number) {
  return readings
    .map((reading) => `${reading.value} bpm（${formatBodySignalTime(reading.measuredAt, now)}）`)
    .join('、');
}

export function formatLatestBodySignalForTool(data: BodySignalAiSnapshot) {
  const reading = data.latestHeartRate;
  if (!reading) return BODY_SIGNAL_EMPTY_TEXT;
  return `最近心率：${reading.value} bpm；记录于${formatBodySignalTime(reading.measuredAt, data.checkedAt)}；${reading.freshness}；来源：${reading.sourceDeviceName}；可信度：${confidenceLabel(reading.confidence)}。`;
}

export function formatLatestBatteryForTool(data: BodySignalAiSnapshot) {
  const reading = data.latestBattery;
  if (!reading) return BODY_SIGNAL_BATTERY_EMPTY_TEXT;
  return `最近穿戴设备电量：${reading.value}%；记录于${formatBodySignalTime(reading.measuredAt, data.checkedAt)}；${reading.freshness}；来源：${reading.sourceDeviceName}；可信度：${confidenceLabel(reading.confidence)}。`;
}

export function formatBodySignalSummaryForTool(data: BodySignalAiSnapshot) {
  const latest = data.latestHeartRate;
  const summary = data.todaySummary;
  if (!latest && !summary) return BODY_SIGNAL_EMPTY_TEXT;
  if (!summary) return BODY_SIGNAL_EMPTY_TEXT;
  const recent = formatRecentHeartRates(
    data.recentHeartRates.filter((reading) => isSameLocalDay(reading.measuredAt, data.checkedAt)),
    data.checkedAt,
  );
  return [
    latest ? formatLatestBodySignalForTool(data) : '',
    `今日心率：共 ${summary.count} 次；平均 ${summary.average} bpm；范围 ${summary.min}-${summary.max} bpm。`,
    `最近几次：${recent || '暂无'}。`,
  ].filter(Boolean).join('\n');
}

function formatHeartRateAmbientContext(data: BodySignalAiSnapshot, readingContext?: BodySignalReadingContext) {
  const latest = data.latestHeartRate;
  if (!latest || !isSameLocalDay(latest.measuredAt, data.checkedAt)) return '';

  const summary = data.todaySummary ?? {
    average: latest.value,
    count: 1,
    latestMeasuredAt: latest.measuredAt,
    max: latest.value,
    min: latest.value,
  };
  const recent = formatRecentHeartRates(
    data.recentHeartRates.filter((reading) => isSameLocalDay(reading.measuredAt, data.checkedAt)),
    data.checkedAt,
  ) || `${latest.value} bpm（${formatBodySignalTime(latest.measuredAt, data.checkedAt)}）`;

  return BODY_SIGNAL_AMBIENT_TEMPLATE
    .replace('{心率}', String(latest.value))
    .replace('{时间}', formatBodySignalTime(latest.measuredAt, data.checkedAt))
    .replace('{新鲜度}', latest.freshness)
    .replace('{设备名}。', () => `${latest.sourceDeviceName}。${readingContext ? `\n${formatBodySignalReadingContext(readingContext)}` : ''}`)
    .replace('{次数}', String(summary.count))
    .replace('{平均值}', String(summary.average))
    .replace('{最低值}', String(summary.min))
    .replace('{最高值}', String(summary.max))
    .replace('{最近五次心率与时间}', recent);
}

function formatLowBatteryAmbientContext(data: BodySignalAiSnapshot) {
  const battery = data.latestBattery;
  if (!battery || battery.value > BODY_SIGNAL_LOW_BATTERY_THRESHOLD) return '';
  const age = data.checkedAt - battery.measuredAt;
  if (age < 0 || age > BODY_SIGNAL_LOW_BATTERY_MAX_AGE_MS) return '';
  return BODY_SIGNAL_LOW_BATTERY_AMBIENT_TEMPLATE
    .replace('{电量}', String(battery.value))
    .replace('{时间}', formatBodySignalTime(battery.measuredAt, data.checkedAt))
    .replace('{设备名}', battery.sourceDeviceName);
}

export function formatBodySignalAmbientContext(data: BodySignalAiSnapshot, readingContext?: BodySignalReadingContext) {
  return [
    formatHeartRateAmbientContext(data, readingContext),
    formatLowBatteryAmbientContext(data),
  ].filter(Boolean).join('\n');
}
