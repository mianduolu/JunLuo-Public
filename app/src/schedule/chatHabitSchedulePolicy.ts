export type ChatHabitRepeat = { frequency: 'daily' | 'weekly' | 'interval'; weekDays?: number[]; intervalDays?: number };

export type ChatHabitPlanInput = {
  id: string;
  title: string;
  notes?: string;
  startAt: number;
  durationMinutes?: number;
  endMode?: 'duration' | 'fixed';
  endAt?: number;
  repeat: ChatHabitRepeat;
  reminderMinutesBefore: number;
  startReminderEnabled: boolean;
  companionEnabled: boolean;
  sourceUpdatedAt?: number;
  scope?: 'once' | 'future';
  /** Host-bound original occurrence time; never a model-filled argument. */
  effectiveAt?: number;
};

export function validateChatHabitPlan(input: ChatHabitPlanInput) {
  if (!input.id || input.id.length > 240 || !input.title.trim() || input.title.length > 80
    || !Number.isSafeInteger(input.startAt) || input.startAt < 0 || input.startAt > 8.64e15
    || (input.durationMinutes !== undefined && (!Number.isFinite(input.durationMinutes) || input.durationMinutes <= 0
      || !Number.isFinite(new Date(input.startAt + input.durationMinutes * 60000).getTime())))
    || !Number.isSafeInteger(input.reminderMinutesBefore) || input.reminderMinutesBefore < 0 || input.reminderMinutesBefore > 1440
    || typeof input.startReminderEnabled !== 'boolean' || typeof input.companionEnabled !== 'boolean'
    || !['daily', 'weekly', 'interval'].includes(input.repeat?.frequency)) throw new Error('invalid-chat-habit-plan');
  if (input.effectiveAt !== undefined && (!Number.isSafeInteger(input.effectiveAt) || input.effectiveAt < 0
    || input.effectiveAt > 8.64e15)) throw new Error('invalid-chat-habit-effective-time');
  if (input.scope === 'once') throw new Error('chat-habit-once-requires-occurrence-draft');
  if (input.endMode !== undefined && !['duration', 'fixed'].includes(input.endMode)) throw new Error('invalid-chat-habit-end-mode');
  if (input.endAt !== undefined && (!Number.isSafeInteger(input.endAt) || input.endAt <= input.startAt || input.endAt > 8.64e15)) throw new Error('invalid-chat-habit-end-time');
  if (input.endMode === 'fixed' && input.endAt === undefined) throw new Error('chat-habit-fixed-end-required');
  if (input.endMode === 'duration' && input.durationMinutes === undefined) throw new Error('chat-habit-duration-required');
  if (input.endAt !== undefined && input.durationMinutes !== undefined && input.endAt - input.startAt !== input.durationMinutes * 60000) throw new Error('schedule-duration-conflict');
  if (input.repeat.frequency === 'weekly' && (!input.repeat.weekDays?.length
    || input.repeat.weekDays.some(day => !Number.isInteger(day) || day < 1 || day > 7)
    || new Set(input.repeat.weekDays).size !== input.repeat.weekDays.length)) throw new Error('invalid-chat-habit-weekdays');
  if (input.repeat.frequency !== 'weekly' && input.repeat.weekDays?.length) throw new Error('invalid-chat-habit-weekdays');
  if (input.repeat.frequency === 'interval' && (!Number.isSafeInteger(input.repeat.intervalDays)
    || input.repeat.intervalDays! < 1)) throw new Error('invalid-chat-habit-interval');
  if (input.repeat.frequency === 'interval') chatHabitIntervalStart(input.startAt, input.repeat.intervalDays!, input.startAt);
}

export function chatHabitFixedEndAt(startAt: number, originalStartAt: number, originalEndAt: number) {
  const original = new Date(originalStartAt);
  const end = new Date(originalEndAt);
  const dayOffset = (Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) - Date.UTC(original.getFullYear(), original.getMonth(), original.getDate())) / 86400000;
  const next = new Date(startAt);
  next.setDate(next.getDate() + dayOffset);
  next.setHours(end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds());
  if (!Number.isFinite(next.getTime()) || next.getTime() <= startAt) throw new Error('schedule-duration-conflict');
  return next.getTime();
}

export function chatHabitIntervalStart(startAt: number, intervalDays: number, completedAt?: number) {
  if (completedAt === undefined) return startAt;
  const original = new Date(startAt);
  const next = new Date(completedAt);
  next.setDate(next.getDate() + intervalDays);
  next.setHours(original.getHours(), original.getMinutes(), original.getSeconds(), original.getMilliseconds());
  if (!Number.isFinite(next.getTime())) throw new Error('invalid-chat-habit-interval-date');
  return next.getTime();
}

export function chatHabitWeekdayStart(startAt: number, weekDay: number) {
  const date = new Date(startAt);
  date.setDate(date.getDate() + (weekDay - (date.getDay() || 7) + 7) % 7);
  return date.getTime();
}

export function chatHabitCandidateTimes(startAt: number, recurrence: 'none' | 'daily' | 'weekly', now: number) {
  const first = new Date(startAt);
  if (recurrence !== 'none' && startAt < now - 86400000) {
    const near = new Date(now - 86400000);
    near.setHours(first.getHours(), first.getMinutes(), first.getSeconds(), first.getMilliseconds());
    if (recurrence === 'weekly') near.setDate(near.getDate() + (first.getDay() - near.getDay() + 7) % 7);
    first.setTime(Math.max(startAt, near.getTime()));
  }
  const horizon = Math.max(startAt, now + 90 * 86400000);
  const result: number[] = [];
  for (let guard = 0; guard < 92; guard++) {
    const candidate = first.getTime();
    if (candidate > horizon) break;
    if (candidate >= now - 86400000 || recurrence === 'none') result.push(candidate);
    if (recurrence === 'none') break;
    first.setDate(first.getDate() + (recurrence === 'weekly' ? 7 : 1));
  }
  return result;
}
