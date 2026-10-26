import { loadPendingAlarmRecordsForInnerState } from '../schedule/alarmStore';
import {
  loadUndeliveredDueOccurrences,
  loadUpcomingUndeliveredOccurrences,
} from '../schedule/scheduleStore';
import {
  loadTodoReminderNotificationCandidates,
  loadTodoReminderNotificationRecords,
} from '../schedule/todoStore';
import {
  JUNLUO_REMINDER_LOOKBACK_MS,
  calculateRemindYouValue,
  type StructuredReminderCandidate,
} from './junluoInnerStateGeneration';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export async function loadJunluoRemindYouValue(now = Date.now(), readOnly = false) {
  const [dueSchedules, upcomingSchedules, todos, todoNotifications, alarms] = await Promise.all([
    loadUndeliveredDueOccurrences(now - JUNLUO_REMINDER_LOOKBACK_MS),
    loadUpcomingUndeliveredOccurrences(now, now + SIX_HOURS_MS, readOnly),
    loadTodoReminderNotificationCandidates(),
    loadTodoReminderNotificationRecords(),
    loadPendingAlarmRecordsForInnerState(now),
  ]);
  const candidates: StructuredReminderCandidate[] = [
    ...[...dueSchedules, ...upcomingSchedules].map((entry) => ({
      dueAt: entry.reminderAt,
      id: `schedule:${entry.id}`,
      intensity: entry.reminderIntensity,
    } as const)),
    ...todos.flatMap((todo) => todoNotifications
      .filter((entry) => entry.todoId === todo.id && entry.stage > todo.reminderStage)
      .map((entry) => ({
        dueAt: entry.scheduledAt,
        id: `todo:${todo.id}:${entry.stage}`,
        intensity: todo.priority,
      } as const))),
    ...alarms.map((alarm) => ({
      dueAt: alarm.triggerAt,
      id: `alarm:${alarm.id}`,
      intensity: alarm.soundMode === 'notification' ? 'ordinary' as const : alarm.soundMode,
    })),
  ];
  return calculateRemindYouValue(candidates, now);
}
