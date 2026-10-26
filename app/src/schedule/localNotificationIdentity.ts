const LOCAL_NOTIFICATION_PREFIX = 'junluo.local.v1';

function encodeIdentityPart(value: string | number) {
  return encodeURIComponent(String(value));
}

export function createScheduleOccurrenceNotificationId(occurrenceId: string) {
  return `${LOCAL_NOTIFICATION_PREFIX}.schedule.${encodeIdentityPart(occurrenceId)}`;
}

export function createTodoReminderNotificationId(todoId: string, stage: number) {
  return `${LOCAL_NOTIFICATION_PREFIX}.todo.${encodeIdentityPart(todoId)}.${encodeIdentityPart(stage)}`;
}

export function createCompanionNotificationId(companionEventId: string) {
  return `${LOCAL_NOTIFICATION_PREFIX}.companion.${encodeIdentityPart(companionEventId)}`;
}

export function createAlarmNotificationId(alarmId: string) {
  return `${LOCAL_NOTIFICATION_PREFIX}.alarm.${encodeIdentityPart(alarmId)}`;
}

export function createShiyingBatchNotificationId(batchId: string) {
  return `${LOCAL_NOTIFICATION_PREFIX}.shiying.${encodeIdentityPart(batchId)}`;
}
