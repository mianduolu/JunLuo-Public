import type { ChatReminderMetadata, ChatReminderRepeat } from './chatReminderTypes';

export function isChatReminderSeries(record: { chatReminder?: ChatReminderMetadata }) {
  return record.chatReminder?.kind === 'series';
}

export function isChatReminderOccurrence(record: { chatReminder?: ChatReminderMetadata }) {
  return record.chatReminder?.kind === 'occurrence';
}

export function validateChatReminderRepeat(repeat: ChatReminderRepeat) {
  if (!repeat || !['once', 'daily', 'weekly'].includes(repeat.kind)) throw new Error('chat-reminder-invalid-repeat');
  if (repeat.kind === 'once') return;
  if (!Number.isInteger(repeat.hour) || repeat.hour < 0 || repeat.hour > 23
    || !Number.isInteger(repeat.minute) || repeat.minute < 0 || repeat.minute > 59) {
    throw new Error('chat-reminder-invalid-clock');
  }
  if (repeat.kind === 'weekly' && (!repeat.weekdays.length
    || new Set(repeat.weekdays).size !== repeat.weekdays.length
    || repeat.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6))) {
    throw new Error('chat-reminder-invalid-weekdays');
  }
}

/** Calendar arithmetic intentionally follows the phone's local wall clock. */
export function nextChatReminderAt(repeat: ChatReminderRepeat, after: number): number | null {
  validateChatReminderRepeat(repeat);
  if (repeat.kind === 'once') return null;
  const date = new Date(after);
  date.setSeconds(0, 0);
  date.setHours(repeat.hour, repeat.minute, 0, 0);
  for (let offset = 0; offset < 8; offset += 1) {
    if (date.getTime() > after && (repeat.kind === 'daily' || repeat.weekdays.includes(date.getDay()))) {
      return date.getTime();
    }
    date.setDate(date.getDate() + 1);
  }
  throw new Error('chat-reminder-next-time-unavailable');
}

export function chatReminderOccurrenceId(seriesId: string, scheduledAt: number, seriesRevision = 1) {
  return `${seriesId}:at:${scheduledAt}:v:${seriesRevision}`;
}

export function chatReminderAttemptId(occurrenceId: string, snoozeCount = 0) {
  return `${occurrenceId}:attempt:${snoozeCount}`;
}
