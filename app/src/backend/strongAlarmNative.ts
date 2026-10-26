import { NativeModules, Platform } from 'react-native';

export type StrongAlarmRingtone = 'default' | 'gentle' | 'urgent';
export type StrongAlarmRingStatus = 'pending' | 'started' | 'failed' | 'stopped';
export type StrongAlarmNativeRecord = {
  batteryOptimizationIgnored?: boolean;
  createdAt?: number;
  errorMessage?: string;
  exactAlarmAllowed?: boolean;
  message: string;
  nativeId: string;
  notificationEnabled?: boolean;
  notificationShown?: boolean;
  ringStatus?: StrongAlarmRingStatus;
  ringtone?: StrongAlarmRingtone;
  status?: 'pending' | 'triggered' | 'cancelled';
  title: string;
  triggeredAt?: number;
  triggerAt: number;
  updatedAt?: number;
  vibrate?: boolean;
};

export type StrongAlarmStatus = {
  available: boolean;
  batteryOptimizationIgnored?: boolean;
  canScheduleExactAlarms: boolean;
  notificationEnabled: boolean;
  platform: string;
  reason?: string;
};

export type StrongAlarmScheduleInput = {
  message?: string;
  ringtone?: StrongAlarmRingtone;
  title: string;
  triggerAt: number;
  vibrate?: boolean;
};

export type StrongAlarmScheduleResult = {
  batteryOptimizationIgnored?: boolean;
  exactAlarmAllowed?: boolean;
  nativeId: string;
  notificationEnabled?: boolean;
  scheduledAt: number;
};

type JunLuoStrongAlarmNative = {
  cancelAlarm: (nativeId: string) => Promise<string>;
  getStatus: () => Promise<string>;
  loadRecords: () => Promise<string>;
  resetAlarms?: () => Promise<string>;
  scheduleAlarm: (payloadJson: string) => Promise<string>;
  stopRinging?: (nativeId: string) => Promise<string>;
};

const nativeModule = NativeModules.JunLuoStrongAlarm as JunLuoStrongAlarmNative | undefined;

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function isStrongAlarmNativeAvailable() {
  return Platform.OS === 'android' && !!nativeModule;
}

export async function getStrongAlarmNativeStatus(): Promise<StrongAlarmStatus> {
  if (!isStrongAlarmNativeAvailable() || !nativeModule) {
    return {
      available: false,
      canScheduleExactAlarms: false,
      notificationEnabled: false,
      platform: Platform.OS,
      reason: '当前安装包还没有原生闹钟模块',
    };
  }
  try {
    return parseJson<StrongAlarmStatus>(await nativeModule.getStatus(), {
      available: false,
      canScheduleExactAlarms: false,
      notificationEnabled: false,
      platform: Platform.OS,
      reason: '原生闹钟状态解析失败',
    });
  } catch (error) {
    return {
      available: false,
      canScheduleExactAlarms: false,
      notificationEnabled: false,
      platform: Platform.OS,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function scheduleNativeStrongAlarm(input: StrongAlarmScheduleInput): Promise<StrongAlarmScheduleResult> {
  if (!isStrongAlarmNativeAvailable() || !nativeModule) {
    throw new Error('当前安装包还没有原生闹钟模块');
  }
  const raw = await nativeModule.scheduleAlarm(JSON.stringify(input));
  return parseJson<StrongAlarmScheduleResult>(raw, {
    nativeId: '',
    scheduledAt: Date.now(),
  });
}

export async function cancelNativeStrongAlarm(nativeId: string) {
  if (!isStrongAlarmNativeAvailable() || !nativeModule) return false;
  const raw = await nativeModule.cancelAlarm(nativeId);
  const parsed = parseJson<{ ok?: boolean }>(raw, { ok: false });
  return parsed.ok === true;
}

export async function loadNativeStrongAlarmRecords() {
  if (!isStrongAlarmNativeAvailable() || !nativeModule) return [];
  const raw = await nativeModule.loadRecords();
  return parseJson<StrongAlarmNativeRecord[]>(raw, []);
}

export async function resetNativeStrongAlarmsForRestore() {
  if (!isStrongAlarmNativeAvailable() || !nativeModule) {
    return { cancelledCount: 0, usedBatchReset: false };
  }
  if (typeof nativeModule.resetAlarms === 'function') {
    const parsed = parseJson<{ cancelledCount?: number; ok?: boolean } | null>(
      await nativeModule.resetAlarms(),
      null,
    );
    if (!parsed?.ok) throw new Error('原生强闹钟批量清理失败');
    return {
      cancelledCount: typeof parsed.cancelledCount === 'number'
        ? Math.max(0, Math.floor(parsed.cancelledCount))
        : 0,
      usedBatchReset: true,
    };
  }

  const records = await loadNativeStrongAlarmRecords();
  const nativeIds = [...new Set(records.map((record) => record.nativeId).filter(Boolean))];
  let cancelledCount = 0;
  for (const nativeId of nativeIds) {
    if (await cancelNativeStrongAlarm(nativeId)) cancelledCount += 1;
  }
  return { cancelledCount, usedBatchReset: false };
}

export async function stopNativeStrongAlarm(nativeId: string) {
  if (!isStrongAlarmNativeAvailable() || !nativeModule || typeof nativeModule.stopRinging !== 'function') return false;
  const raw = await nativeModule.stopRinging(nativeId);
  const parsed = parseJson<{ ok?: boolean }>(raw, { ok: false });
  return parsed.ok === true;
}
