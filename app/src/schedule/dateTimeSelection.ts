type ScheduleReminderIntensity = 'gentle' | 'strong' | 'blast';
type ScheduleRecurrence = 'none' | 'daily' | 'weekdays' | 'legalWorkday' | 'weekly' | 'monthly' | 'yearly' | 'lunarYearly';

export type ReminderChoice = 'none' | 'sameDay' | 'oneDay' | 'twoDays' | 'threeDays' | 'oneWeek';

export type DateTimeSelection = {
  date: string;
  endDate?: string;
  // Single occurrence end date; endDate remains the recurrence cutoff.
  endTimeDate?: string;
  endTime?: string;
  estimateMinutes?: number;
  defaultReminderMinutes?: number;
  recurrence: ScheduleRecurrence;
  reminderChoice: ReminderChoice;
  reminderClock: string;
  reminderIntensity: ScheduleReminderIntensity;
  time?: string;
};

export const reminderChoiceOffsets: Record<ReminderChoice, number> = {
  none: 0,
  sameDay: 0,
  oneDay: 1,
  twoDays: 2,
  threeDays: 3,
  oneWeek: 7,
};

export const reminderChoiceLabels: Record<ReminderChoice, string> = {
  none: '无',
  sameDay: '当天',
  oneDay: '提前1天',
  twoDays: '提前2天',
  threeDays: '提前3天',
  oneWeek: '提前1周',
};

export function normalizeClock(value?: string) {
  if (!value) return undefined;
  const match = value.match(/^(\d{1,2})[:：点时]?(\d{0,2})/);
  if (!match) return undefined;
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2] || 0)));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function combineDateTime(date: string, clock: string) {
  const normalized = normalizeClock(clock);
  if (!normalized) return NaN;
  return new Date(`${date}T${normalized}:00`).getTime();
}

export function clockFromTimestamp(timestamp: number) {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function dateKeyFromTimestamp(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function addMinutesToClock(date: string, clock: string, minutes: number) {
  const timestamp = combineDateTime(date, clock);
  if (!Number.isFinite(timestamp)) return undefined;
  return clockFromTimestamp(timestamp + minutes * 60 * 1000);
}

export function minutesBetweenClocks(date: string, startClock?: string, endClock?: string) {
  if (!startClock || !endClock) return undefined;
  const start = combineDateTime(date, startClock);
  const end = combineDateTime(date, endClock);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  return Math.round((end - start) / 60000);
}

export function reminderMinutesFromSelection(selection: DateTimeSelection) {
  if (!selection.time) return 0;
  if (selection.reminderChoice === 'none') return Math.max(0, Math.round(selection.defaultReminderMinutes ?? 0));
  const start = combineDateTime(selection.date, selection.time);
  const reminderDate = new Date(`${selection.date}T00:00:00`);
  reminderDate.setDate(reminderDate.getDate() - reminderChoiceOffsets[selection.reminderChoice]);
  const reminderAt = combineDateTime(
    `${reminderDate.getFullYear()}-${String(reminderDate.getMonth() + 1).padStart(2, '0')}-${String(reminderDate.getDate()).padStart(2, '0')}`,
    selection.reminderClock,
  );
  if (!Number.isFinite(start) || !Number.isFinite(reminderAt) || reminderAt >= start) return 0;
  return Math.round((start - reminderAt) / 60000);
}

export function selectionFromReminderMinutes(date: string, time: string | undefined, minutes: number): Pick<DateTimeSelection, 'reminderChoice' | 'reminderClock'> {
  if (!time || minutes <= 0) return { reminderChoice: 'none', reminderClock: '09:00' };
  const start = combineDateTime(date, time);
  const reminderAt = start - minutes * 60 * 1000;
  const diffDays = Math.max(0, Math.round((new Date(`${date}T00:00:00`).getTime() - new Date(dateKeyFromTimestamp(reminderAt)).getTime()) / (24 * 60 * 60 * 1000)));
  const reminderChoice =
    diffDays >= 7 ? 'oneWeek' :
      diffDays >= 3 ? 'threeDays' :
        diffDays >= 2 ? 'twoDays' :
          diffDays >= 1 ? 'oneDay' :
            'sameDay';
  return { reminderChoice, reminderClock: clockFromTimestamp(reminderAt) };
}
