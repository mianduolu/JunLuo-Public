import type { DayTemplate } from './dayTemplate';
import { formatOwnDayPlanTime, parseOwnDayPlanTime } from './ownDayPlanPolicy';
import type { UserRoutinePatch, UserRoutineKind } from './userRoutineSaveState';
export type { UserRoutinePatch, UserRoutineKind, UserRoutineSaveState } from './userRoutineSaveState';
export { normalizeUserRoutineSave, mergeUserRoutineSaves } from './userRoutineSaveState';

export const USER_ROUTINE_KINDS = ['wake', 'breakfast', 'lunch', 'nap', 'dinner', 'sleep'] as const;
export const USER_ROUTINE_TITLES: Record<UserRoutineKind, string> = {
  wake: '起床', breakfast: '早餐', lunch: '午餐', nap: '午休', dinner: '晚餐', sleep: '睡觉',
};
export type RoutineItem = { enabled: boolean; time?: string; minutes?: number; source: 'usual' | 'day' };
export type UserRoutineRead = {
  status: 'ok' | 'unset' | 'unavailable'; subject: 'you'; date: string; enabled: boolean;
  items: Partial<Record<UserRoutineKind, RoutineItem>>; version: string;
};

export function isRoutineDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function userRoutineTimeDates(day: string): string[] {
  if (!isRoutineDate(day)) return [];
  const next = new Date(`${day}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return [day, next.toISOString().slice(0, 10)];
}

export function parseUserRoutinePatch(value: unknown, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): UserRoutinePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('routine-input-invalid');
  const input = value as Record<string, unknown>;
  if (input.date !== 'usual' && !isRoutineDate(input.date)) throw new Error('routine-date-invalid');
  if (Object.keys(input).some(key => key !== 'date' && !USER_ROUTINE_KINDS.includes(key as UserRoutineKind))) throw new Error('routine-field-invalid');
  const patch: UserRoutinePatch = { date: input.date as string };
  for (const kind of USER_ROUTINE_KINDS) {
    if (!(kind in input)) continue;
    const item = input[kind];
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('routine-item-invalid');
    const fields = item as Record<string, unknown>;
    if (!Object.keys(fields).length || Object.keys(fields).some(key => !['time', 'minutes', 'enabled'].includes(key))) throw new Error('routine-item-field-invalid');
    if ('enabled' in fields && typeof fields.enabled !== 'boolean') throw new Error('routine-enabled-invalid');
    if ('minutes' in fields && (kind === 'wake' || kind === 'sleep' || !Number.isSafeInteger(fields.minutes) || Number(fields.minutes) <= 0)) throw new Error('routine-minutes-invalid');
    if ('time' in fields) {
      if (typeof fields.time !== 'string') throw new Error('routine-time-invalid');
      if (input.date === 'usual') {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(fields.time)) throw new Error('routine-time-invalid');
      } else {
        if (!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/.test(fields.time)) throw new Error('routine-time-invalid');
        parseOwnDayPlanTime(fields.time, timeZone);
        if (!userRoutineTimeDates(input.date as string).includes(fields.time.slice(0, 10))) throw new Error('routine-time-date-invalid');
      }
    }
    patch[kind] = { ...fields } as NonNullable<UserRoutinePatch[UserRoutineKind]>;
  }
  if (Object.keys(patch).length === 1) throw new Error('routine-empty-patch');
  return patch;
}

export function usualRoutineItems(template: DayTemplate): UserRoutineRead['items'] {
  const items: UserRoutineRead['items'] = {};
  for (const kind of USER_ROUTINE_KINDS) {
    if (kind === 'wake' || kind === 'sleep') {
      const time = kind === 'wake' ? template.wakeTime : template.sleepTime;
      const enabled = kind === 'wake' ? template.wakeEnabled ?? !!time : template.sleepEnabled ?? !!time;
      if (time || enabled) items[kind] = { source: 'usual', enabled, ...(time ? { time } : {}) };
    } else {
      const value = template[kind];
      if (!value.startTime && !value.enabled) continue;
      let minutes: number | undefined;
      if (kind === 'nap') {
        if (template.nap.durationMinutes) minutes = template.nap.durationMinutes;
        else if (template.nap.startTime && template.nap.endTime) {
          const clock = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
          minutes = (clock(template.nap.endTime) - clock(template.nap.startTime) + 1440) % 1440 || 1440;
        }
      } else minutes = template[kind].durationMinutes;
      items[kind] = { source: 'usual', enabled: value.enabled, ...(value.startTime ? { time: value.startTime } : {}), ...(minutes ? { minutes } : {}) };
    }
  }
  return items;
}

export function mergeRoutineItem(previous: RoutineItem | undefined, patch: NonNullable<UserRoutinePatch[UserRoutineKind]>, source: 'usual' | 'day'): RoutineItem {
  const result: RoutineItem = { ...previous, ...patch, source, enabled: patch.enabled ?? previous?.enabled ?? !!patch.time };
  if (result.enabled && !result.time) throw new Error('routine-enabled-without-time');
  return result;
}

export function patchUsualRoutine(template: DayTemplate, patch: UserRoutinePatch, operationId: string): DayTemplate {
  const next: DayTemplate = { ...template, breakfast: { ...template.breakfast }, lunch: { ...template.lunch },
    dinner: { ...template.dinner }, nap: { ...template.nap }, operationId };
  const items = usualRoutineItems(template);
  for (const kind of USER_ROUTINE_KINDS) {
    if (!patch[kind]) continue;
    const item = mergeRoutineItem(items[kind], patch[kind]!, 'usual');
    if (item.minutes && (!Number.isSafeInteger(item.minutes * 60000) || Date.now() + item.minutes * 60000 > 8.64e15)) throw new Error('routine-duration-invalid');
    if (kind === 'wake') { next.wakeTime = item.time ?? ''; next.wakeEnabled = item.enabled; }
    else if (kind === 'sleep') { next.sleepTime = item.time ?? ''; next.sleepEnabled = item.enabled; }
    else if (kind === 'nap') {
      const total = item.time && item.minutes ? Number(item.time.slice(0, 2)) * 60 + Number(item.time.slice(3)) + item.minutes : undefined;
      next.nap = { enabled: item.enabled, startTime: item.time ?? '', ...(item.minutes ? { durationMinutes: item.minutes } : {}), endTime: total === undefined ? ''
        : `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}` };
    } else next[kind] = { enabled: item.enabled, startTime: item.time ?? '', ...(item.minutes ? { durationMinutes: item.minutes } : {}) };
  }
  return next;
}

export function routineTimeAt(day: string, time: string, timeZone: string, nextDay = false) {
  let key = day;
  if (nextDay) { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); key = date.toISOString().slice(0, 10); }
  return parseOwnDayPlanTime(`${key} ${time}`, timeZone);
}

export function routineTimestampText(at: number, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  return formatOwnDayPlanTime(at, timeZone);
}
