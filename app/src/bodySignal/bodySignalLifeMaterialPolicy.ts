import type { BodySignalReadingContext } from './bodySignalReadingContext';

export type BodySignalLifeMaterialReading = {
  deviceProfileId?: string;
  sourceProvider?: string;
  sourceDeviceName?: string;
  readingContext?: BodySignalReadingContext;
  confidence: 'high' | 'low' | 'medium' | 'unknown';
  measuredAt: number;
  value: number;
};

export type BodySignalLifeMaterialInput = {
  battery?: BodySignalLifeMaterialReading;
  heartRate?: BodySignalLifeMaterialReading;
};

export type BodySignalLifeMaterial = {
  expiresAt: number;
  fingerprintKey: string;
  id: string;
  importance: 'low' | 'medium' | 'high';
  occurredAt: number;
  promptLine: string;
  summary: string;
};

const HEART_RATE_FRESH_MS = 2 * 60 * 1000;
const HEART_RATE_SIGNIFICANT_RECENT_MS = 30 * 60 * 1000;
const HEART_RATE_HIGH_BPM = 130;
const HEART_RATE_LOW_BPM = 40;
const LOW_BATTERY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const LOW_BATTERY_THRESHOLD = 20;

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

function formatClock(timestamp: number) {
  const date = new Date(timestamp);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function isSameLocalDay(left: number, right: number) {
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  return leftDate.getFullYear() === rightDate.getFullYear()
    && leftDate.getMonth() === rightDate.getMonth()
    && leftDate.getDate() === rightDate.getDate();
}

function previousLocalDateKey(timestamp: number) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - 1);
  return [
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ].join('-');
}

function dateKey(timestamp: number) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ].join('-');
}

function formatRecordedTime(timestamp: number, now: number) {
  const clock = formatClock(timestamp);
  if (isSameLocalDay(timestamp, now)) return `今天 ${clock}`;
  if (dateKey(timestamp) === previousLocalDateKey(now)) return `昨天 ${clock}`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

function confidenceLabel(confidence: BodySignalLifeMaterialReading['confidence']) {
  if (confidence === 'high') return '高';
  if (confidence === 'medium') return '中';
  return null;
}

function hasUsableTimestampAndValue(reading: BodySignalLifeMaterialReading | undefined) {
  return Boolean(
    reading
    && Number.isFinite(reading.measuredAt)
    && Number.isFinite(reading.value)
    && reading.measuredAt > 0
  );
}

function isUsableHeartRate(reading: BodySignalLifeMaterialReading | undefined) {
  return hasUsableTimestampAndValue(reading) && Boolean(reading && reading.value > 0);
}

function isUsableBattery(reading: BodySignalLifeMaterialReading | undefined) {
  return hasUsableTimestampAndValue(reading) && Boolean(reading && reading.value >= 0);
}

function selectHeartRateMaterial(
  reading: BodySignalLifeMaterialReading | undefined,
  now: number,
): BodySignalLifeMaterial | null {
  if (!isUsableHeartRate(reading) || !reading) return null;
  const confidence = confidenceLabel(reading.confidence);
  if (!confidence) return null;
  const age = now - reading.measuredAt;
  if (age < 0) return null;
  const bpm = Math.round(reading.value);
  const significant = bpm >= HEART_RATE_HIGH_BPM || bpm <= HEART_RATE_LOW_BPM;
  const fresh = age <= HEART_RATE_FRESH_MS;
  if (!fresh && (!significant || age > HEART_RATE_SIGNIFICANT_RECENT_MS)) return null;

  return {
    expiresAt: reading.measuredAt + (significant
      ? HEART_RATE_SIGNIFICANT_RECENT_MS
      : HEART_RATE_FRESH_MS),
    fingerprintKey: `heart|${reading.measuredAt}|${bpm}|${reading.confidence}`,
    id: `body-signal:heart:${reading.measuredAt}`,
    importance: fresh && significant ? 'high' : 'medium',
    occurredAt: reading.measuredAt,
    promptLine: fresh
      ? `身体现场信号：戒指刚读到小仓鼠心率 ${bpm} bpm（可信度${confidence}）。I 会结合她当时的活动和身体感受理解这次读数。`
      : `身体现场信号：戒指在 ${formatClock(reading.measuredAt)} 读到小仓鼠心率 ${bpm} bpm（可信度${confidence}）。这是最近半小时内的穿戴设备记录，I 会先留意小仓鼠现在感觉怎么样。`,
    summary: `戒指心率 ${bpm} bpm（可信度${confidence}，${fresh ? '刚读到' : formatRecordedTime(reading.measuredAt, now)}）`,
  };
}

function selectBatteryMaterial(
  reading: BodySignalLifeMaterialReading | undefined,
  now: number,
): BodySignalLifeMaterial | null {
  if (!isUsableBattery(reading) || !reading) return null;
  const age = now - reading.measuredAt;
  if (age < 0 || age > LOW_BATTERY_MAX_AGE_MS) return null;
  const level = Math.max(0, Math.min(100, Math.round(reading.value)));
  if (level > LOW_BATTERY_THRESHOLD) return null;
  const bucket = Math.ceil(level / 5) * 5;
  const timeText = formatRecordedTime(reading.measuredAt, now);
  return {
    expiresAt: reading.measuredAt + LOW_BATTERY_MAX_AGE_MS,
    fingerprintKey: `battery|${dateKey(reading.measuredAt)}|${bucket}`,
    id: `body-signal:battery:${dateKey(reading.measuredAt)}`,
    importance: 'low',
    occurredAt: reading.measuredAt,
    promptLine: `穿戴设备状态：${timeText}记录到电量 ${level}%。I 会把它当作需要充电的设备状态。`,
    summary: `穿戴设备电量 ${level}%（${timeText}）`,
  };
}

export function selectBodySignalLifeMaterials(
  input: BodySignalLifeMaterialInput,
  now = Date.now(),
): BodySignalLifeMaterial[] {
  return [
    selectHeartRateMaterial(input.heartRate, now),
    selectBatteryMaterial(input.battery, now),
  ].filter((item): item is BodySignalLifeMaterial => !!item);
}
