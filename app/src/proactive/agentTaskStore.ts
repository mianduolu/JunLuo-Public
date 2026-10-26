import {
  proactiveLedgerStorageBridge as AsyncStorage,
} from '../sync/syncProactiveLedgerStorageBridge';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { cancelNotifications, requestNotificationPermission } from '../schedule/scheduleNotifications';
import type { SyncExecutionOutcomeV2 } from '../sync/syncExecutionClaimV2Protocol';

export type JunLuoAgentTaskStatus = 'pending' | 'delivered' | 'cancelled' | 'expired';

export type JunLuoAgentTaskRecord = {
  id: string;
  title: string;
  message: string;
  triggerAt: number;
  status: JunLuoAgentTaskStatus;
  notificationId?: string;
  sourceMessageId?: string;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  cancelledAt?: number;
};

const AGENT_TASK_STORE_KEY = 'junluo.agentTask.once.v1';
const CHANNEL_ID = 'baiyun-reminders';
const MAX_AGENT_TASK_RECORDS = 200;

function createAgentTaskId() {
  return `agent-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStatus(value: unknown): JunLuoAgentTaskStatus {
  return value === 'delivered' || value === 'cancelled' || value === 'expired' ? value : 'pending';
}

function normalizeRecord(value: unknown): JunLuoAgentTaskRecord | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<JunLuoAgentTaskRecord>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.title !== 'string' ||
    typeof candidate.message !== 'string' ||
    typeof candidate.triggerAt !== 'number' ||
    !Number.isFinite(candidate.triggerAt)
  ) {
    return null;
  }
  const now = Date.now();
  return {
    id: candidate.id,
    title: candidate.title,
    message: candidate.message,
    triggerAt: candidate.triggerAt,
    status: normalizeStatus(candidate.status),
    notificationId: typeof candidate.notificationId === 'string' ? candidate.notificationId : undefined,
    sourceMessageId: typeof candidate.sourceMessageId === 'string' ? candidate.sourceMessageId : undefined,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : now,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : now,
    deliveredAt: typeof candidate.deliveredAt === 'number' ? candidate.deliveredAt : undefined,
    cancelledAt: typeof candidate.cancelledAt === 'number' ? candidate.cancelledAt : undefined,
  };
}

async function loadRawAgentTasks() {
  try {
    const raw = await AsyncStorage.getItem(AGENT_TASK_STORE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeRecord)
      .filter((item): item is JunLuoAgentTaskRecord => !!item)
      .sort((left, right) => left.triggerAt - right.triggerAt)
      .slice(-MAX_AGENT_TASK_RECORDS);
  } catch {
    return [];
  }
}

async function saveAgentTasks(records: JunLuoAgentTaskRecord[]) {
  await AsyncStorage.setItem(AGENT_TASK_STORE_KEY, JSON.stringify(records.slice(-MAX_AGENT_TASK_RECORDS)));
}

export async function loadAgentTasks(options: { includePast?: boolean; now?: number } = {}) {
  const now = options.now ?? Date.now();
  const records = await loadRawAgentTasks();
  return records.filter((record) => options.includePast || record.status === 'pending' || record.triggerAt >= now);
}

export async function loadAgentTaskById(taskId: string) {
  const records = await loadRawAgentTasks();
  return records.find((record) => record.id === taskId) ?? null;
}

async function scheduleAgentTaskNotification(record: Pick<
  JunLuoAgentTaskRecord,
  'id' | 'message' | 'triggerAt'
>) {
  return Notifications.scheduleNotificationAsync({
    content: {
      title: '白云小姐到点来找你',
      body: record.message,
      data: { agentTaskId: record.id },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(record.triggerAt),
      channelId: Platform.OS === 'android' ? CHANNEL_ID : undefined,
    },
  });
}

export async function scheduleOneTimeAgentTask({
  message,
  sourceMessageId,
  title,
  triggerAt,
}: {
  message: string;
  sourceMessageId?: string;
  title: string;
  triggerAt: number;
}) {
  const granted = await requestNotificationPermission();
  if (!granted) {
    throw new Error('通知权限不可用，不能保证到点主动找你');
  }
  const now = Date.now();
  const record: JunLuoAgentTaskRecord = {
    id: createAgentTaskId(),
    title,
    message,
    triggerAt,
    status: 'pending',
    sourceMessageId,
    createdAt: now,
    updatedAt: now,
  };
  const notificationId = await scheduleAgentTaskNotification(record);
  const saved = { ...record, notificationId };
  const records = await loadRawAgentTasks();
  await saveAgentTasks([...records, saved]);
  return saved;
}

export async function resetAgentTaskNotificationBindings() {
  const records = await loadRawAgentTasks();
  const resetCount = records.filter((record) => !!record.notificationId).length;
  if (resetCount) {
    await saveAgentTasks(records.map((record) => ({ ...record, notificationId: undefined })));
  }
  return resetCount;
}

export async function rebindRestoredAgentTaskNotifications(now = Date.now()) {
  let records = await loadRawAgentTasks();
  let scheduled = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.status !== 'pending' || record.triggerAt <= now || record.notificationId) continue;
    const notificationId = await scheduleAgentTaskNotification(record);
    records = records.map((item, itemIndex) => (
      itemIndex === index ? { ...item, notificationId } : item
    ));
    await saveAgentTasks(records);
    scheduled += 1;
  }
  return scheduled;
}

export async function cancelAgentTask(taskId: string) {
  const records = await loadRawAgentTasks();
  const target = records.find((record) => record.id === taskId);
  if (!target || target.status !== 'pending') return false;
  if (target.notificationId) await cancelNotifications([target.notificationId]);
  const now = Date.now();
  await saveAgentTasks(records.map((record) => (
    record.id === taskId
      ? { ...record, status: 'cancelled', updatedAt: now, cancelledAt: now }
      : record
  )));
  return true;
}

export async function loadDueAgentTasks(now = Date.now()) {
  const records = await loadRawAgentTasks();
  return records.filter((record) => record.status === 'pending' && record.triggerAt <= now);
}

export async function markAgentTaskDelivered(taskId: string, deliveredAt = Date.now()) {
  const records = await loadRawAgentTasks();
  const target = records.find((record) => record.id === taskId);
  if (!target || target.status !== 'pending') return false;
  await saveAgentTasks(records.map((record) => (
    record.id === taskId
      ? { ...record, status: 'delivered', updatedAt: deliveredAt, deliveredAt }
      : record
  )));
  return true;
}

export async function applyAgentTaskExecutionReceipt(
  taskId: string,
  outcome: SyncExecutionOutcomeV2,
  completedAt: number,
) {
  const records = await loadRawAgentTasks();
  const target = records.find((record) => record.id === taskId);
  if (!target) return false;
  const status: JunLuoAgentTaskStatus = outcome === 'completed'
    ? 'delivered'
    : outcome === 'cancelled'
      ? 'cancelled'
      : 'expired';
  if (
    target.status === status
    && target.updatedAt === completedAt
  ) {
    return false;
  }
  if (target.notificationId) {
    await cancelNotifications([target.notificationId]);
  }
  await saveAgentTasks(records.map((record) => (
    record.id === taskId
      ? {
          ...record,
          status,
          updatedAt: completedAt,
          deliveredAt: status === 'delivered' ? completedAt : undefined,
          cancelledAt: status === 'cancelled' ? completedAt : undefined,
        }
      : record
  )));
  return true;
}

export async function expireAgentTask(taskId: string, expiredAt = Date.now()) {
  const records = await loadRawAgentTasks();
  const target = records.find((record) => record.id === taskId);
  if (!target || target.status !== 'pending') return false;
  await saveAgentTasks(records.map((record) => (
    record.id === taskId
      ? { ...record, status: 'expired', updatedAt: expiredAt }
      : record
  )));
  return true;
}

export async function clearAgentTasksForTests() {
  await AsyncStorage.removeItem(AGENT_TASK_STORE_KEY);
}
