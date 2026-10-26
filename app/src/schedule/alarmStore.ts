import {
  scheduleSemanticStorageBridge as AsyncStorage,
} from '../sync/syncScheduleSemanticStorageBridge';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { MusicSong } from '../ai/subjectiveMessages';
import { createAlarmNotificationId } from './localNotificationIdentity';
import type { StrongAlarmNativeRecord, StrongAlarmRingStatus, StrongAlarmRingtone } from '../backend/strongAlarmNative';
import { cancelNotifications, requestNotificationPermission } from './scheduleNotifications';
import type { SyncExecutionOutcomeV2 } from '../sync/syncExecutionClaimV2Protocol';
import { assertChatReminderMetadata } from '../sync/syncScheduleSemantic';
import type { ChatReminderMetadata } from './chatReminderTypes';
import { runAlarmStoreMutation as runAlarmMutation } from '../sync/syncScheduleSemanticCaptureQueue';

export type JunLuoAlarmStatus = 'pending' | 'delivered' | 'cancelled';
export type JunLuoAlarmSoundMode = 'notification' | 'music' | 'strong';
export type JunLuoAlarmMusicPlayStatus = 'pending' | 'played' | 'failed' | 'skipped';

export type JunLuoAlarmRecord = {
  chatReminder?: ChatReminderMetadata;
  id: string;
  title: string;
  message: string;
  triggerAt: number;
  status: JunLuoAlarmStatus;
  soundMode: JunLuoAlarmSoundMode;
  musicKeyword?: string;
  musicSong?: MusicSong;
  musicFallbackToNotification?: boolean;
  musicPlayStatus?: JunLuoAlarmMusicPlayStatus;
  musicPlayAttemptedAt?: number;
  musicPlayResultSummary?: string;
  musicPlayErrorMessage?: string;
  strongAlarmNativeId?: string;
  strongAlarmRingtone?: StrongAlarmRingtone;
  strongAlarmRingStatus?: StrongAlarmRingStatus;
  strongAlarmTriggeredAt?: number;
  strongAlarmNotificationShown?: boolean;
  strongAlarmErrorMessage?: string;
  strongAlarmExactAlarmAllowed?: boolean;
  strongAlarmNotificationEnabled?: boolean;
  strongAlarmBatteryOptimizationIgnored?: boolean;
  vibrate?: boolean;
  notificationId?: string;
  createdAt: number;
  updatedAt: number;
  cancelledAt?: number;
};

const ALARM_STORE_KEY = 'junluo.alarm.records.v1';
const CHANNEL_ID = 'baiyun-reminders';
const alarmRecordsChangedListeners = new Set<() => void>();
export const runAlarmStoreMutation = runAlarmMutation;

export async function loadStoredAlarmRecords(now = Date.now()) {
  return loadRawAlarmRecords(now, { markPastDelivered: false });
}

export function mutateAlarmRecords<T>(
  mutation: (records: JunLuoAlarmRecord[]) => Promise<{ records: JunLuoAlarmRecord[]; value: T }>
    | { records: JunLuoAlarmRecord[]; value: T },
): Promise<T> {
  return runAlarmMutation(async () => {
    const records = await loadStoredAlarmRecords();
    const result = await mutation(records);
    if (JSON.stringify(records) !== JSON.stringify(result.records)) await saveAlarmRecords(result.records);
    return result.value;
  });
}

function createAlarmId() {
  return `alarm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStatus(value: unknown): JunLuoAlarmStatus {
  return value === 'delivered' || value === 'cancelled' ? value : 'pending';
}

function normalizeSoundMode(value: unknown): JunLuoAlarmSoundMode {
  return value === 'music' || value === 'strong' ? value : 'notification';
}

function normalizeMusicPlayStatus(value: unknown): JunLuoAlarmMusicPlayStatus | undefined {
  return value === 'played' || value === 'failed' || value === 'skipped' || value === 'pending'
    ? value
    : undefined;
}

function normalizeMusicSong(value: unknown): MusicSong | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<MusicSong>;
  if (typeof candidate.id !== 'string' || !candidate.id.trim()) return undefined;
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) return undefined;
  return {
    album: typeof candidate.album === 'string' ? candidate.album : '',
    artist: typeof candidate.artist === 'string' ? candidate.artist : '',
    cover: typeof candidate.cover === 'string' ? candidate.cover : '',
    duration: typeof candidate.duration === 'number' && Number.isFinite(candidate.duration) ? candidate.duration : 0,
    id: candidate.id.trim(),
    name: candidate.name.trim(),
  };
}

function normalizeStrongRingStatus(value: unknown): StrongAlarmRingStatus | undefined {
  return value === 'started' || value === 'failed' || value === 'stopped' || value === 'pending'
    ? value
    : undefined;
}

function normalizeRecord(
  value: unknown,
  now = Date.now(),
  options: { markPastDelivered?: boolean } = {},
): JunLuoAlarmRecord | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<JunLuoAlarmRecord>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.title !== 'string' ||
    typeof candidate.triggerAt !== 'number' ||
    !Number.isFinite(candidate.triggerAt)
  ) {
    return null;
  }
  const rawStatus = normalizeStatus(candidate.status);
  const status = rawStatus;
  assertChatReminderMetadata(candidate.chatReminder);
  const soundMode = normalizeSoundMode(candidate.soundMode);
  if (candidate.chatReminder && (!candidate.id.trim() || candidate.id.length > 250 || !candidate.title.trim() || candidate.title.length > 1000
    || !Number.isSafeInteger(candidate.triggerAt) || candidate.triggerAt < 0
    || !Number.isSafeInteger(candidate.createdAt) || Number(candidate.createdAt) < 0
    || !Number.isSafeInteger(candidate.updatedAt) || Number(candidate.updatedAt) < 0
    || !['pending', 'delivered', 'cancelled'].includes(String(candidate.status))
    || candidate.soundMode !== candidate.chatReminder.mode || typeof candidate.message !== 'string' || candidate.message.length > 10_000
    || candidate.chatReminder.mode === 'music' && !normalizeMusicSong(candidate.musicSong))) {
    throw new Error('alarm-store-corrupt-chat-reminder-record');
  }
  const musicPlayStatus = candidate.chatReminder ? undefined
    : normalizeMusicPlayStatus(candidate.musicPlayStatus) ?? (soundMode === 'music' ? 'pending' : undefined);
  return {
    ...(candidate.chatReminder ? { chatReminder: candidate.chatReminder } : {}),
    id: candidate.id,
    title: candidate.title,
    message: typeof candidate.message === 'string' && (candidate.chatReminder || candidate.message.trim()) ? candidate.message : candidate.title,
    triggerAt: candidate.triggerAt,
    status,
    soundMode,
    musicKeyword: typeof candidate.musicKeyword === 'string' && candidate.musicKeyword.trim()
      ? candidate.musicKeyword.trim()
      : undefined,
    musicSong: normalizeMusicSong(candidate.musicSong),
    musicFallbackToNotification: typeof candidate.musicFallbackToNotification === 'boolean'
      ? candidate.musicFallbackToNotification
      : undefined,
    musicPlayStatus,
    musicPlayAttemptedAt: typeof candidate.musicPlayAttemptedAt === 'number' ? candidate.musicPlayAttemptedAt : undefined,
    musicPlayResultSummary: typeof candidate.musicPlayResultSummary === 'string' ? candidate.musicPlayResultSummary : undefined,
    musicPlayErrorMessage: typeof candidate.musicPlayErrorMessage === 'string' ? candidate.musicPlayErrorMessage : undefined,
    strongAlarmNativeId: typeof candidate.strongAlarmNativeId === 'string' ? candidate.strongAlarmNativeId : undefined,
    strongAlarmRingtone: candidate.strongAlarmRingtone === 'gentle' || candidate.strongAlarmRingtone === 'urgent'
      ? candidate.strongAlarmRingtone
      : candidate.strongAlarmRingtone === 'default'
        ? 'default'
        : undefined,
    strongAlarmRingStatus: normalizeStrongRingStatus(candidate.strongAlarmRingStatus),
    strongAlarmTriggeredAt: typeof candidate.strongAlarmTriggeredAt === 'number' ? candidate.strongAlarmTriggeredAt : undefined,
    strongAlarmNotificationShown: typeof candidate.strongAlarmNotificationShown === 'boolean'
      ? candidate.strongAlarmNotificationShown
      : undefined,
    strongAlarmErrorMessage: typeof candidate.strongAlarmErrorMessage === 'string' ? candidate.strongAlarmErrorMessage : undefined,
    strongAlarmExactAlarmAllowed: typeof candidate.strongAlarmExactAlarmAllowed === 'boolean'
      ? candidate.strongAlarmExactAlarmAllowed
      : undefined,
    strongAlarmNotificationEnabled: typeof candidate.strongAlarmNotificationEnabled === 'boolean'
      ? candidate.strongAlarmNotificationEnabled
      : undefined,
    strongAlarmBatteryOptimizationIgnored: typeof candidate.strongAlarmBatteryOptimizationIgnored === 'boolean'
      ? candidate.strongAlarmBatteryOptimizationIgnored
      : undefined,
    vibrate: typeof candidate.vibrate === 'boolean' ? candidate.vibrate : undefined,
    notificationId: typeof candidate.notificationId === 'string' ? candidate.notificationId : undefined,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : now,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : now,
    cancelledAt: typeof candidate.cancelledAt === 'number' ? candidate.cancelledAt : undefined,
  };
}

async function loadRawAlarmRecords(now = Date.now(), options: { markPastDelivered?: boolean } = {}) {
  const raw = await AsyncStorage.getItem(ALARM_STORE_KEY);
  if (raw === null) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('alarm-store-corrupt-json'); }
  if (!Array.isArray(parsed)) throw new Error('alarm-store-corrupt-records');
  const records = parsed.map(item => normalizeRecord(item, now, options));
  if (records.some(item => !item)) throw new Error('alarm-store-corrupt-record');
  const valid = records as JunLuoAlarmRecord[];
  if (new Set(valid.map(item => item.id)).size !== valid.length) throw new Error('alarm-store-duplicate-id');
  return valid.sort((left, right) => left.triggerAt - right.triggerAt);
}

export async function loadAlarmRecordById(alarmId: string) {
  const records = await loadRawAlarmRecords(Date.now(), {
    markPastDelivered: false,
  });
  return records.find((record) => record.id === alarmId) ?? null;
}

export async function loadNextPendingMusicAlarmAt(now = Date.now()) {
  const records = await loadRawAlarmRecords(now, {
    markPastDelivered: false,
  });
  return records.find((record) => (
    record.status === 'pending'
    && !record.chatReminder
    && record.soundMode === 'music'
    && record.musicPlayStatus === 'pending'
  ))?.triggerAt ?? null;
}

export function subscribeAlarmRecordsChanged(listener: () => void) {
  alarmRecordsChangedListeners.add(listener);
  return () => alarmRecordsChangedListeners.delete(listener);
}

async function saveAlarmRecords(records: JunLuoAlarmRecord[]) {
  if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('alarm-store-duplicate-id');
  records.forEach(record => {
    if (!normalizeRecord(record)) throw new Error('alarm-store-invalid-write');
  });
  await AsyncStorage.setItem(ALARM_STORE_KEY, JSON.stringify(records));
  alarmRecordsChangedListeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // A scheduling listener must not make an already durable alarm write fail.
    }
  });
}

function mergeNativeStrongAlarm(records: JunLuoAlarmRecord[], native: StrongAlarmNativeRecord) {
  if (native.status === 'cancelled') return;
  const now = Date.now();
  const existingIndex = records.findIndex((record) =>
    record.strongAlarmNativeId === native.nativeId ||
    (!record.strongAlarmNativeId && record.id === native.nativeId)
  );
  const status: JunLuoAlarmStatus = native.status === 'triggered' ? 'delivered' : 'pending';
  const patch: Partial<JunLuoAlarmRecord> = {
    message: native.message,
    soundMode: 'strong',
    status,
    strongAlarmBatteryOptimizationIgnored: native.batteryOptimizationIgnored,
    strongAlarmErrorMessage: native.errorMessage,
    strongAlarmExactAlarmAllowed: native.exactAlarmAllowed,
    strongAlarmNativeId: native.nativeId,
    strongAlarmNotificationEnabled: native.notificationEnabled,
    strongAlarmNotificationShown: native.notificationShown,
    strongAlarmRingStatus: native.ringStatus,
    strongAlarmRingtone: native.ringtone,
    strongAlarmTriggeredAt: native.triggeredAt,
    title: native.title,
    triggerAt: native.triggerAt,
    updatedAt: native.updatedAt ?? now,
    vibrate: native.vibrate,
  };
  if (existingIndex >= 0) {
    records[existingIndex] = { ...records[existingIndex], ...patch };
    return;
  }
  records.push({
    id: createAlarmId(),
    title: native.title,
    message: native.message,
    triggerAt: native.triggerAt,
    status,
    soundMode: 'strong',
    strongAlarmNativeId: native.nativeId,
    strongAlarmRingtone: native.ringtone,
    strongAlarmRingStatus: native.ringStatus,
    strongAlarmTriggeredAt: native.triggeredAt,
    strongAlarmNotificationShown: native.notificationShown,
    strongAlarmErrorMessage: native.errorMessage,
    strongAlarmExactAlarmAllowed: native.exactAlarmAllowed,
    strongAlarmNotificationEnabled: native.notificationEnabled,
    strongAlarmBatteryOptimizationIgnored: native.batteryOptimizationIgnored,
    vibrate: native.vibrate,
    createdAt: native.createdAt ?? now,
    updatedAt: native.updatedAt ?? now,
  });
}

async function mergeNativeStrongAlarmRecords(records: JunLuoAlarmRecord[]) {
  try {
    const { loadNativeStrongAlarmRecords } = await import('../backend/strongAlarmNative');
    const nativeRecords = await loadNativeStrongAlarmRecords();
    const next = [...records];
    nativeRecords.forEach((record) => mergeNativeStrongAlarm(next, record));
    return next;
  } catch {
    return records;
  }
}

export async function loadAlarmRecords(options: { includePast?: boolean; now?: number } = {}) {
  const now = options.now ?? Date.now();
  const records = await mergeNativeStrongAlarmRecords(await loadRawAlarmRecords(now));
  return records
    .filter((record) => options.includePast || record.status === 'pending' || record.triggerAt >= now)
    .sort((left, right) => left.triggerAt - right.triggerAt);
}

export async function loadPendingAlarmRecordsForInnerState(now = Date.now()) {
  const records = await loadRawAlarmRecords(now, { markPastDelivered: false });
  return records.filter((record) => record.status === 'pending');
}

async function scheduleAlarmNotification(record: Pick<
  JunLuoAlarmRecord,
  'id' | 'message' | 'soundMode' | 'triggerAt'
>) {
  return Notifications.scheduleNotificationAsync({
    identifier: createAlarmNotificationId(record.id),
    content: {
      title: '白云小姐闹钟',
      body: record.message,
      data: { alarmId: record.id, soundMode: record.soundMode },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(record.triggerAt),
      channelId: Platform.OS === 'android' ? CHANNEL_ID : undefined,
    },
  });
}

async function createAlarmRecordLocally({
  message,
  musicFallbackToNotification,
  musicKeyword,
  musicSong,
  soundMode = 'notification',
  title,
  triggerAt,
}: {
  message?: string;
  musicFallbackToNotification?: boolean;
  musicKeyword?: string;
  musicSong?: MusicSong;
  soundMode?: JunLuoAlarmSoundMode;
  title: string;
  triggerAt: number;
}) {
  const granted = await requestNotificationPermission();
  if (!granted) {
    throw new Error('通知权限不可用，不能创建君落闹钟');
  }
  const now = Date.now();
  const record: JunLuoAlarmRecord = {
    id: createAlarmId(),
    title,
    message: message?.trim() || title,
    triggerAt,
    status: 'pending',
    soundMode,
    musicKeyword: musicKeyword?.trim() || undefined,
    musicSong,
    musicFallbackToNotification,
    musicPlayStatus: soundMode === 'music' ? 'pending' : undefined,
    createdAt: now,
    updatedAt: now,
  };
  const records = await loadRawAlarmRecords(now);
  await saveAlarmRecords([...records.filter((item) => item.id !== record.id), record]);
  const notificationId = await scheduleAlarmNotification(record);
  const saved = { ...record, notificationId };
  const latestRecords = await loadRawAlarmRecords(now, { markPastDelivered: false });
  await saveAlarmRecords([
    ...latestRecords.filter((item) => item.id !== record.id),
    saved,
  ]);
  return saved;
}

async function resetAlarmNotificationBindingsLocally() {
  const records = await loadRawAlarmRecords(Date.now(), { markPastDelivered: false });
  const resetCount = records.filter((record) => !!record.notificationId).length;
  if (resetCount) {
    await saveAlarmRecords(records.map((record) => ({ ...record, notificationId: undefined })));
  }
  return resetCount;
}

async function resetRestoredStrongAlarmStateLocally() {
  const { resetNativeStrongAlarmsForRestore } = await import('../backend/strongAlarmNative');
  const nativeReset = await resetNativeStrongAlarmsForRestore();
  const records = await loadRawAlarmRecords(Date.now(), { markPastDelivered: false });
  const bindingsCleared = records.filter((record) => !!record.strongAlarmNativeId).length;
  let changed = bindingsCleared > 0;
  const next = records.map((record) => {
    if (record.soundMode !== 'strong') {
      return record.strongAlarmNativeId
        ? { ...record, strongAlarmNativeId: undefined }
        : record;
    }
    if (record.status !== 'pending') {
      return record.strongAlarmNativeId
        ? { ...record, strongAlarmNativeId: undefined }
        : record;
    }
    if (
      record.strongAlarmRingStatus !== undefined ||
      record.strongAlarmTriggeredAt !== undefined ||
      record.strongAlarmNotificationShown !== undefined ||
      record.strongAlarmErrorMessage !== undefined ||
      record.strongAlarmExactAlarmAllowed !== undefined ||
      record.strongAlarmNotificationEnabled !== undefined ||
      record.strongAlarmBatteryOptimizationIgnored !== undefined
    ) {
      changed = true;
    }
    return {
      ...record,
      strongAlarmBatteryOptimizationIgnored: undefined,
      strongAlarmErrorMessage: undefined,
      strongAlarmExactAlarmAllowed: undefined,
      strongAlarmNativeId: undefined,
      strongAlarmNotificationEnabled: undefined,
      strongAlarmNotificationShown: undefined,
      strongAlarmRingStatus: undefined,
      strongAlarmTriggeredAt: undefined,
    };
  });
  if (changed) await saveAlarmRecords(next);
  return {
    bindingsCleared,
    nativeAlarmsCancelled: nativeReset.cancelledCount,
    usedBatchReset: nativeReset.usedBatchReset,
  };
}

async function rebindRestoredAlarmNotificationsLocally(now = Date.now()) {
  let records = await loadRawAlarmRecords(now, { markPastDelivered: false });
  let scheduled = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (
      record.status !== 'pending' ||
      !!record.chatReminder ||
      record.soundMode === 'strong' ||
      record.triggerAt <= now ||
      record.notificationId
    ) {
      continue;
    }
    const notificationId = await scheduleAlarmNotification(record);
    records = records.map((item, itemIndex) => (
      itemIndex === index ? { ...item, notificationId } : item
    ));
    await saveAlarmRecords(records);
    scheduled += 1;
  }
  return scheduled;
}

async function rebindRestoredStrongAlarmNotificationsLocally(now = Date.now()) {
  let records = await loadRawAlarmRecords(now, { markPastDelivered: false });
  const hasPending = records.some((record) => (
    record.status === 'pending' &&
    !record.chatReminder &&
    record.soundMode === 'strong' &&
    record.triggerAt > now &&
    !record.strongAlarmNativeId
  ));
  if (!hasPending) return true;

  const {
    getStrongAlarmNativeStatus,
    scheduleNativeStrongAlarm,
  } = await import('../backend/strongAlarmNative');
  const nativeStatus = await getStrongAlarmNativeStatus();
  if (!nativeStatus.available || !nativeStatus.canScheduleExactAlarms) {
    const errorMessage = nativeStatus.reason ?? (
      nativeStatus.available
        ? '系统没有允许君落安排精确闹钟'
        : '当前安装包还没有原生闹钟模块'
    );
    records = records.map((record) => (
      record.status === 'pending' &&
      record.soundMode === 'strong' &&
      record.triggerAt > now &&
      !record.strongAlarmNativeId
        ? {
            ...record,
            strongAlarmBatteryOptimizationIgnored: nativeStatus.batteryOptimizationIgnored,
            strongAlarmErrorMessage: errorMessage,
            strongAlarmExactAlarmAllowed: nativeStatus.canScheduleExactAlarms,
            strongAlarmNotificationEnabled: nativeStatus.notificationEnabled,
          }
        : record
    ));
    await saveAlarmRecords(records);
    return false;
  }

  let fullyRebound = true;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (
      record.status !== 'pending' ||
      record.soundMode !== 'strong' ||
      record.triggerAt <= now ||
      record.strongAlarmNativeId
    ) {
      continue;
    }
    if (record.triggerAt <= Date.now() + 1000) {
      records = records.map((item, itemIndex) => (
        itemIndex === index
          ? {
              ...item,
              strongAlarmBatteryOptimizationIgnored: nativeStatus.batteryOptimizationIgnored,
              strongAlarmErrorMessage: '恢复时强闹钟时间已过或太近，未重新安排',
              strongAlarmExactAlarmAllowed: nativeStatus.canScheduleExactAlarms,
              strongAlarmNotificationEnabled: nativeStatus.notificationEnabled,
            }
          : item
      ));
      await saveAlarmRecords(records);
      fullyRebound = false;
      continue;
    }
    const native = await scheduleNativeStrongAlarm({
      message: record.message,
      ringtone: record.strongAlarmRingtone ?? 'default',
      title: record.title,
      triggerAt: record.triggerAt,
      vibrate: record.vibrate,
    });
    if (!native.nativeId) throw new Error('恢复强闹钟时原生模块没有返回有效 ID');
    records = records.map((item, itemIndex) => (
      itemIndex === index
        ? {
            ...item,
            strongAlarmBatteryOptimizationIgnored: native.batteryOptimizationIgnored,
            strongAlarmErrorMessage: undefined,
            strongAlarmExactAlarmAllowed: native.exactAlarmAllowed,
            strongAlarmNativeId: native.nativeId,
            strongAlarmNotificationEnabled: native.notificationEnabled,
            strongAlarmNotificationShown: undefined,
            strongAlarmRingStatus: 'pending',
            strongAlarmTriggeredAt: undefined,
          }
        : item
    ));
    await saveAlarmRecords(records);
  }
  return fullyRebound;
}

async function createStrongAlarmRecordLocally({
  batteryOptimizationIgnored,
  exactAlarmAllowed,
  message,
  nativeId,
  notificationEnabled,
  ringtone = 'default',
  title,
  triggerAt,
  vibrate,
}: {
  batteryOptimizationIgnored?: boolean;
  exactAlarmAllowed?: boolean;
  message?: string;
  nativeId: string;
  notificationEnabled?: boolean;
  ringtone?: StrongAlarmRingtone;
  title: string;
  triggerAt: number;
  vibrate?: boolean;
}) {
  const now = Date.now();
  const record: JunLuoAlarmRecord = {
    id: createAlarmId(),
    title,
    message: message?.trim() || title,
    triggerAt,
    status: 'pending',
    soundMode: 'strong',
    strongAlarmNativeId: nativeId,
    strongAlarmRingtone: ringtone,
    strongAlarmRingStatus: 'pending',
    strongAlarmExactAlarmAllowed: exactAlarmAllowed,
    strongAlarmNotificationEnabled: notificationEnabled,
    strongAlarmBatteryOptimizationIgnored: batteryOptimizationIgnored,
    vibrate,
    createdAt: now,
    updatedAt: now,
  };
  const records = await loadRawAlarmRecords(now);
  await saveAlarmRecords([...records.filter((item) => item.id !== nativeId), record]);
  return record;
}

export async function loadDueMusicAlarms(now = Date.now()) {
  const records = await loadRawAlarmRecords(now, { markPastDelivered: false });
  return records.filter((record) =>
    record.status === 'pending' &&
    record.soundMode === 'music' &&
    record.triggerAt <= now &&
    (record.musicPlayStatus ?? 'pending') === 'pending'
  );
}

async function updateAlarmRecord(alarmId: string, updater: (record: JunLuoAlarmRecord, now: number) => JunLuoAlarmRecord) {
  const now = Date.now();
  const records = await loadRawAlarmRecords(now, { markPastDelivered: false });
  let updated = false;
  const next = records.map((record) => {
    if (record.id !== alarmId) return record;
    updated = true;
    return updater(record, now);
  });
  if (updated) await saveAlarmRecords(next);
  return updated;
}

async function markAlarmMusicPlayedLocally(alarmId: string, summary: string) {
  return updateAlarmRecord(alarmId, (record, now) => ({
    ...record,
    status: 'delivered',
    musicPlayStatus: 'played',
    musicPlayAttemptedAt: now,
    musicPlayResultSummary: summary,
    musicPlayErrorMessage: undefined,
    updatedAt: now,
  }));
}

async function markAlarmMusicFailedLocally(alarmId: string, errorMessage: string) {
  return updateAlarmRecord(alarmId, (record, now) => ({
    ...record,
    status: 'delivered',
    musicPlayStatus: 'failed',
    musicPlayAttemptedAt: now,
    musicPlayErrorMessage: errorMessage,
    updatedAt: now,
  }));
}

async function cancelAlarmDeviceEffects(target: JunLuoAlarmRecord) {
  if (target.soundMode !== 'strong') {
    await cancelNotifications([
      target.notificationId ?? createAlarmNotificationId(target.id),
    ]);
  }
  if (!target.strongAlarmNativeId) return;
  const nativeId = target.strongAlarmNativeId;
  await import('../backend/strongAlarmNative')
    .then(async ({ cancelNativeStrongAlarm, stopNativeStrongAlarm }) => {
      await stopNativeStrongAlarm(nativeId).catch(() => false);
      await cancelNativeStrongAlarm(nativeId).catch(() => false);
    })
    .catch(() => undefined);
}

async function cancelAlarmRecordLocally(alarmId: string) {
  const records = await loadRawAlarmRecords();
  const target = records.find((record) => record.id === alarmId);
  if (!target || target.status !== 'pending') return false;
  await cancelAlarmDeviceEffects(target);
  const now = Date.now();
  await saveAlarmRecords(records.map((record) => (
    record.id === alarmId
      ? { ...record, status: 'cancelled', updatedAt: now, cancelledAt: now }
      : record
  )));
  return true;
}

async function applyAlarmExecutionReceiptLocally(
  alarmId: string,
  outcome: SyncExecutionOutcomeV2,
  completedAt: number,
) {
  if (!Number.isSafeInteger(completedAt) || completedAt < 0) {
    throw new Error('alarm execution receipt 时间无效');
  }
  const records = await loadRawAlarmRecords(Date.now(), {
    markPastDelivered: false,
  });
  const target = records.find((record) => record.id === alarmId);
  if (!target) return false;
  if (target.chatReminder) throw new Error('chat-reminder-requires-independent-evidence');
  await cancelAlarmDeviceEffects(target);

  const updatedAt = Math.max(target.updatedAt, completedAt);
  let nextTarget: JunLuoAlarmRecord;
  if (outcome === 'cancelled') {
    nextTarget = {
      ...target,
      status: 'cancelled',
      cancelledAt: Math.max(target.cancelledAt ?? 0, completedAt),
      updatedAt,
    };
  } else {
    nextTarget = {
      ...target,
      status: 'delivered',
      musicPlayStatus: target.soundMode === 'music'
        ? outcome === 'failed' ? 'failed' : 'played'
        : target.musicPlayStatus,
      musicPlayAttemptedAt: target.soundMode === 'music'
        ? Math.max(target.musicPlayAttemptedAt ?? 0, completedAt)
        : target.musicPlayAttemptedAt,
      strongAlarmRingStatus: target.soundMode === 'strong'
        && outcome === 'failed'
        ? 'failed'
        : target.strongAlarmRingStatus,
      updatedAt,
    };
  }
  if (JSON.stringify(nextTarget) === JSON.stringify(target)) return false;
  await saveAlarmRecords(records.map((record) => (
    record.id === alarmId ? nextTarget : record
  )));
  return true;
}

async function clearAlarmRecordsForTestsLocally() {
  await AsyncStorage.removeItem(ALARM_STORE_KEY);
  alarmRecordsChangedListeners.forEach((listener) => listener());
}

export const createAlarmRecord = (...args: Parameters<typeof createAlarmRecordLocally>) =>
  runAlarmMutation(() => createAlarmRecordLocally(...args));

export const resetAlarmNotificationBindings = (...args: Parameters<typeof resetAlarmNotificationBindingsLocally>) =>
  runAlarmMutation(() => resetAlarmNotificationBindingsLocally(...args));

export const resetRestoredStrongAlarmState = (...args: Parameters<typeof resetRestoredStrongAlarmStateLocally>) =>
  runAlarmMutation(() => resetRestoredStrongAlarmStateLocally(...args));

export const rebindRestoredAlarmNotifications = (...args: Parameters<typeof rebindRestoredAlarmNotificationsLocally>) =>
  runAlarmMutation(() => rebindRestoredAlarmNotificationsLocally(...args));

export const rebindRestoredStrongAlarmNotifications = (...args: Parameters<typeof rebindRestoredStrongAlarmNotificationsLocally>) =>
  runAlarmMutation(() => rebindRestoredStrongAlarmNotificationsLocally(...args));

export const createStrongAlarmRecord = (...args: Parameters<typeof createStrongAlarmRecordLocally>) =>
  runAlarmMutation(() => createStrongAlarmRecordLocally(...args));

export const markAlarmMusicPlayed = (...args: Parameters<typeof markAlarmMusicPlayedLocally>) =>
  runAlarmMutation(() => markAlarmMusicPlayedLocally(...args));

export const markAlarmMusicFailed = (...args: Parameters<typeof markAlarmMusicFailedLocally>) =>
  runAlarmMutation(() => markAlarmMusicFailedLocally(...args));

export const cancelAlarmRecord = (...args: Parameters<typeof cancelAlarmRecordLocally>) =>
  runAlarmMutation(() => cancelAlarmRecordLocally(...args));

export const applyAlarmExecutionReceipt = (...args: Parameters<typeof applyAlarmExecutionReceiptLocally>) =>
  runAlarmMutation(() => applyAlarmExecutionReceiptLocally(...args));

export const clearAlarmRecordsForTests = (...args: Parameters<typeof clearAlarmRecordsForTestsLocally>) =>
  runAlarmMutation(() => clearAlarmRecordsForTestsLocally(...args));
