import { AppState, Platform } from 'react-native';
import { postNotificationBehavior } from '../posts/baiyunPostNotificationPolicy';
import { isShiyingNotificationDomain, shiyingNotificationBehavior } from '../shiying/shiyingNotificationPolicy';
import { initializeScheduleReminderRecovery } from './scheduleReminderRecovery';
import * as Notifications from 'expo-notifications';

import {
  takeRetiredScheduleOccurrenceNotificationIds,
} from './scheduleStore';
import {
  loadScheduleReminderTasks,
  loadScheduleReminderEvent,
  discardChangedScheduleReminderPreparations,
  syncScheduleCompanionEvents,
  type DueScheduleCompanionEvent,
} from './scheduleCompanionStore';
import { replaceScheduleNativeWakeTasks, cancelScheduleNativeWakeTask } from './scheduleNativeWake';
import { loadChatReminderWakeTasks } from './chatReminderWake';
import {
  loadTodoReminderNotificationCandidates,
  loadTodoReminderNotificationRecords,
  removeTodoReminderNotificationRecords,
  saveTodoReminderNotificationRecord,
} from './todoStore';
import {
  createCompanionNotificationId,
  createTodoReminderNotificationId,
} from './localNotificationIdentity';

const CHANNEL_ID = 'baiyun-reminders';
const TODO_MORNING_HOUR = 9;
const TODO_FOLLOWUP_HOUR = 15;

Notifications.setNotificationHandler({
  handleNotification: async notification => shiyingNotificationBehavior(notification.request.content.data, AppState.currentState === 'active')
    ?? postNotificationBehavior(notification.request.content.data, AppState.currentState === 'active') ?? ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function initializeScheduleNotifications() {
  await initializeScheduleReminderRecovery();
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: '白云小姐提醒',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 180, 90, 180],
    });
  }
}

export async function hasNotificationPermission() {
  const permission = await Notifications.getPermissionsAsync();
  return permission.granted;
}

export async function requestNotificationPermission() {
  await initializeScheduleNotifications();
  const permission = await Notifications.requestPermissionsAsync();
  return permission.granted;
}

function todoReminderAt(date: string, hour: number) {
  const value = new Date(`${date}T12:00:00`);
  value.setHours(hour, 0, 0, 0);
  return value.getTime();
}

async function syncTodoReminderNotifications(now = Date.now()) {
  const candidates = await loadTodoReminderNotificationCandidates();
  const desired = candidates.flatMap((todo) => {
    if (!todo.plannedForDate) return [];
    const stages: Array<{ stage: number; scheduledAt: number }> = [];
    const morningAt = todoReminderAt(todo.plannedForDate, TODO_MORNING_HOUR);
    const followUpAt = todoReminderAt(todo.plannedForDate, TODO_FOLLOWUP_HOUR);
    if (todo.reminderStage <= 0 && morningAt > now) stages.push({ stage: 0, scheduledAt: morningAt });
    if (todo.reminderMode === 'followup' && todo.reminderStage <= 1 && followUpAt > now) {
      stages.push({ stage: 1, scheduledAt: followUpAt });
    }
    return stages.map((stage) => ({ ...stage, todo }));
  });
  const desiredByKey = new Map(desired.map((item) => [`${item.todo.id}:${item.stage}`, item]));
  const records = await loadTodoReminderNotificationRecords();
  const stale = records.filter((record) => {
    const target = desiredByKey.get(`${record.todoId}:${record.stage}`);
    return !target || target.scheduledAt !== record.scheduledAt;
  });
  await cancelNotifications(stale.map((record) => record.notificationId));
  await removeTodoReminderNotificationRecords(stale.map((record) => ({ todoId: record.todoId, stage: record.stage })));
  const currentKeys = new Set(records
    .filter((record) => !stale.includes(record))
    .map((record) => `${record.todoId}:${record.stage}`));
  for (const item of desired) {
    const key = `${item.todo.id}:${item.stage}`;
    if (currentKeys.has(key)) continue;
    const identifier = await Notifications.scheduleNotificationAsync({
      identifier: createTodoReminderNotificationId(item.todo.id, item.stage),
      content: {
        title: '白云小姐来看看鼠',
        body: item.stage === 0
          ? `今天还有“${item.todo.title}”。先摸到第一小步就很好。`
          : `“${item.todo.title}”现在怎么样啦？要不要一起调整一下？`,
        data: { todoId: item.todo.id, todoReminderStage: item.stage },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(item.scheduledAt),
        channelId: Platform.OS === 'android' ? CHANNEL_ID : undefined,
      },
    });
    await saveTodoReminderNotificationRecord({
      todoId: item.todo.id,
      stage: item.stage,
      notificationId: identifier,
      scheduledAt: item.scheduledAt,
    });
  }
}

let scheduleSync = Promise.resolve(false);
export function syncScheduleNotifications(): Promise<boolean> {
  scheduleSync = scheduleSync.catch(() => false).then(syncScheduleNotificationTasks);
  return scheduleSync;
}

async function syncScheduleNotificationTasks() {
  const notificationAllowed = await hasNotificationPermission();
  const retiredOccurrenceNotificationIds = await takeRetiredScheduleOccurrenceNotificationIds();
  await cancelNotifications(retiredOccurrenceNotificationIds);
  if (notificationAllowed) await syncTodoReminderNotifications();
  const changedCompanionNotificationIds = await syncScheduleCompanionEvents();
  await cancelNotifications(changedCompanionNotificationIds);
  const oldNotifications = await Notifications.getAllScheduledNotificationsAsync();
  await cancelNotifications(oldNotifications
    .filter((notification) => typeof notification.content.data?.companionEventId === 'string')
    .map((notification) => notification.identifier));
  const tasks = await loadScheduleReminderTasks();
  const changed = await discardChangedScheduleReminderPreparations();
  await Promise.all(changed.map(cancelScheduleNativeWakeTask));
  const nativeReady = await replaceScheduleNativeWakeTasks([...tasks, ...await loadChatReminderWakeTasks()]);
  if (!nativeReady) console.warn('[schedule-reminder] native exact wake unavailable');
  return nativeReady && notificationAllowed;
}

export async function notifyScheduleReminderBody(event: DueScheduleCompanionEvent, body: string) {
  if (!(await hasNotificationPermission())) return false;
  await initializeScheduleNotifications();
  const current = await loadScheduleReminderEvent(event.id, true);
  if (!current || current.scheduledAt !== event.scheduledAt
    || ('itemUpdatedAt' in event && current.itemUpdatedAt !== event.itemUpdatedAt)) return false;
  await Notifications.scheduleNotificationAsync({
    identifier: createCompanionNotificationId(event.id),
    content: {
      title: '白云小姐来看看鼠',
      body,
      data: { companionEventId: event.id, occurrenceId: event.occurrenceId, kind: event.kind },
    },
    trigger: { channelId: CHANNEL_ID },
  });
  return true;
}

export async function cancelNotifications(notificationIds: string[]) {
  await Promise.all(notificationIds.map((identifier) => Notifications.cancelScheduledNotificationAsync(identifier)));
}

export function observeScheduleNotifications(onReminder: (opened: boolean, companion: boolean) => void) {
  const received = Notifications.addNotificationReceivedListener((notification) => {
    if (isShiyingNotificationDomain(notification.request.content.data)) return;
    onReminder(false, typeof notification.request.content.data?.companionEventId === 'string');
  });
  const responded = Notifications.addNotificationResponseReceivedListener((response) => {
    if (isShiyingNotificationDomain(response.notification.request.content.data)) return;
    onReminder(true, typeof response.notification.request.content.data?.companionEventId === 'string');
  });
  return () => {
    received.remove();
    responded.remove();
  };
}
