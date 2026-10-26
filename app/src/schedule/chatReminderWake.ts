import { loadChatReminderOccurrences } from './chatReminderStore';
import { CHAT_REMINDER_PREPARE_MS, prepareStandaloneRemindersIndependently, isIndependentReminderPreparationActive } from './chatReminderPreparation';
import type { ScheduleNativeWakePayload, ScheduleNativeWakeTask } from './scheduleNativeWake';

export const CHAT_REMINDER_WAKE_PREFIX = 'chat-reminder:';
export async function loadChatReminderWakeTasks(): Promise<ScheduleNativeWakeTask[]> {
  return (await loadChatReminderOccurrences()).filter(record => record.status === 'pending')
    .map(record => ({ eventId: `${CHAT_REMINDER_WAKE_PREFIX}${record.id}`, scheduledAt: record.triggerAt, prepareAheadMs: CHAT_REMINDER_PREPARE_MS }));
}
export async function nextChatReminderWakeAt(now = Date.now()) {
  const records = (await loadChatReminderOccurrences()).filter(record => record.status === 'pending');
  if (!records.length) return null;
  return Math.min(...records.map(record => !isIndependentReminderPreparationActive()
    && !record.chatReminder.prepareClaim && !record.chatReminder.preparedBody
    && record.triggerAt - CHAT_REMINDER_PREPARE_MS > now
    ? record.triggerAt - CHAT_REMINDER_PREPARE_MS : record.triggerAt <= now ? now + 1000 : record.triggerAt));
}
export async function handleChatReminderWake(payload: ScheduleNativeWakePayload) {
  if (!payload.eventId.startsWith(CHAT_REMINDER_WAKE_PREFIX)) return;
  const id = payload.eventId.slice(CHAT_REMINDER_WAKE_PREFIX.length);
  const tasks = await loadChatReminderWakeTasks();
  if (!tasks.some(task => task.eventId === payload.eventId && task.scheduledAt === payload.scheduledAt)) return;
  if (payload.phase === 'prepare') await prepareStandaloneRemindersIndependently();
  else if (payload.phase === 'deliver' || payload.phase === 'deadline') {
    const { tickChatReminderDelivery } = await import('./chatReminderDelivery');
    try { await tickChatReminderDelivery({ occurrenceId: id }); }
    finally {
      // Cold Headless has no mounted React alarm observer. Persist the entire
      // updated native list here so the next repeat really gets its wake.
      const { syncScheduleNotifications } = await import('./scheduleNotifications');
      await syncScheduleNotifications();
    }
  }
}
