// Local time data only. Persistence, authorization and execution are connected in 4B.
export const PHONE_RESTRICTION_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type PhoneRestrictionWeekday = typeof PHONE_RESTRICTION_WEEKDAYS[number];
export type PhoneRestrictionDates =
  | { localDate: string; weekdays?: never }
  | { weekdays: PhoneRestrictionWeekday[]; localDate?: never };
export type PhoneRestrictionTimeWindow = { id: string; startTime: string; endTime: string };
export type PhoneRestrictionSchedule = {
  id: string;
  enabled: boolean;
  dates: PhoneRestrictionDates;
  windows: PhoneRestrictionTimeWindow[];
  mode: 'warning' | 'direct';
  warningMs: number;
};
export type PhoneRestrictionAppTimes = {
  enabled: boolean;
  dates: PhoneRestrictionDates | null;
  allowed: PhoneRestrictionTimeWindow[];
  blocked: PhoneRestrictionTimeWindow[];
};
export type PhoneRestrictionOccurrence = {
  id: string;
  scheduleId: string;
  windowId: string;
  localDate: string;
  timeZoneId: string;
  startsAt: number;
  warningUntil: number;
  endsAt: number;
};
export type PhoneRestrictionPlanAllowance = {
  dates: PhoneRestrictionDates;
  windows: PhoneRestrictionTimeWindow[];
};
export type PhoneRestrictionPlanInput = {
  schedule: PhoneRestrictionSchedule;
  authorizationId: string;
  actor: 'I' | 'you';
  scope: 'phone' | 'apps';
  packages: string[];
};
export type PhoneRestrictionSavedPlan = PhoneRestrictionPlanInput & { createdAt: number; futureFrom: number };
export type PhoneRestrictionAppTimeRule = {
  id: string;
  authorizationId: string;
  packageName: string;
  times: PhoneRestrictionAppTimes;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function id(value: unknown): value is string { return typeof value === 'string' && !!value.trim(); }

export function isPhoneRestrictionLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

export function parsePhoneRestrictionDates(value: unknown): PhoneRestrictionDates | null {
  const input = object(value);
  if (!input) return null;
  if (input.localDate !== undefined) {
    return input.weekdays === undefined && isPhoneRestrictionLocalDate(input.localDate)
      ? { localDate: input.localDate } : null;
  }
  const days = input.weekdays;
  if (!Array.isArray(days) || days.length === 0
    || !days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)
    || new Set(days).size !== days.length) return null;
  return { weekdays: [...days].sort((a, b) => a - b) as PhoneRestrictionWeekday[] };
}

function windows(value: unknown): PhoneRestrictionTimeWindow[] | null {
  if (!Array.isArray(value)) return null;
  const result: PhoneRestrictionTimeWindow[] = [];
  for (const entry of value) {
    const input = object(entry);
    if (!input || !id(input.id) || typeof input.startTime !== 'string' || typeof input.endTime !== 'string'
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime)
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.endTime)
      || input.startTime === input.endTime) return null; // Ambiguous; never infer a whole day.
    result.push({ id: input.id, startTime: input.startTime, endTime: input.endTime });
  }
  return new Set(result.map((window) => window.id)).size === result.length ? result : null;
}

export function parsePhoneRestrictionSchedule(value: unknown): PhoneRestrictionSchedule | null {
  const input = object(value);
  if (!input || !id(input.id) || typeof input.enabled !== 'boolean'
    || (input.mode !== 'warning' && input.mode !== 'direct')
    || !Number.isSafeInteger(input.warningMs) || (input.warningMs as number) < 0) return null;
  const dates = parsePhoneRestrictionDates(input.dates);
  const spans = windows(input.windows);
  return dates && spans && spans.length > 0 ? {
    id: input.id, enabled: input.enabled, dates, windows: spans,
    mode: input.mode as PhoneRestrictionSchedule['mode'], warningMs: input.warningMs as number,
  } : null;
}

export function parsePhoneRestrictionAppTimes(value: unknown): PhoneRestrictionAppTimes | null {
  const input = object(value);
  if (!input || typeof input.enabled !== 'boolean') return null;
  const dates = input.dates === null ? null : parsePhoneRestrictionDates(input.dates);
  const allowed = windows(input.allowed);
  const blocked = windows(input.blocked);
  if (!allowed || !blocked || (input.dates !== null && !dates)
    || (input.enabled && (!dates || allowed.length + blocked.length === 0))) return null;
  return { enabled: input.enabled, dates, allowed, blocked };
}

export function parsePhoneRestrictionPlanAllowance(value: unknown): PhoneRestrictionPlanAllowance | null {
  const input = object(value);
  if (!input) return null;
  const dates = parsePhoneRestrictionDates(input.dates);
  const spans = windows(input.windows);
  return dates && spans && spans.length > 0 ? { dates, windows: spans } : null;
}

export function parsePhoneRestrictionPlanInput(value: unknown): PhoneRestrictionPlanInput | null {
  const input = object(value);
  if (!input || !id(input.authorizationId) || (input.actor !== 'I' && input.actor !== 'you')
    || (input.scope !== 'phone' && input.scope !== 'apps') || !Array.isArray(input.packages)
    || !input.packages.every(id) || new Set(input.packages).size !== input.packages.length
    || (input.scope === 'apps' ? input.packages.length === 0 : input.packages.length !== 0)) return null;
  const schedule = parsePhoneRestrictionSchedule(input.schedule);
  return schedule ? { schedule, authorizationId: input.authorizationId, actor: input.actor,
    scope: input.scope, packages: [...input.packages] } : null;
}

export function parsePhoneRestrictionAppTimeRule(value: unknown): PhoneRestrictionAppTimeRule | null {
  const input = object(value);
  if (!input || !id(input.id) || !id(input.authorizationId) || !id(input.packageName)) return null;
  const times = parsePhoneRestrictionAppTimes(input.times);
  return times ? { id: input.id, authorizationId: input.authorizationId, packageName: input.packageName, times } : null;
}

export function parsePhoneRestrictionOccurrence(value: unknown): PhoneRestrictionOccurrence | null {
  const input = object(value);
  if (!input || ![input.id, input.scheduleId, input.windowId, input.timeZoneId].every(id)
    || !isPhoneRestrictionLocalDate(input.localDate)
    || ![input.startsAt, input.warningUntil, input.endsAt].every((time) => typeof time === 'number' && Number.isSafeInteger(time) && time > 0)
    || (input.warningUntil as number) < (input.startsAt as number) || (input.endsAt as number) <= (input.startsAt as number)
    || (input.warningUntil as number) > (input.endsAt as number)) return null;
  try {
    const tuple: unknown = JSON.parse(input.id as string);
    if (!Array.isArray(tuple) || tuple.length !== 3 || tuple[0] !== input.scheduleId
      || tuple[1] !== input.windowId || tuple[2] !== input.localDate) return null;
  } catch { return null; }
  return input as PhoneRestrictionOccurrence;
}
