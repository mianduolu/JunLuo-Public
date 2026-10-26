import {
  scheduleSemanticStorageBridge as AsyncStorage,
} from '../sync/syncScheduleSemanticStorageBridge';
import { userRoutineIdentity } from './userRoutineSaveState';

export type MealTemplate = {
  enabled: boolean;
  startTime: string;
  durationMinutes?: number;
};

export type DayTemplate = {
  version: 1;
  enabled: boolean;
  wakeTime: string;
  sleepTime: string;
  wakeEnabled?: boolean;
  sleepEnabled?: boolean;
  operationId?: string;
  breakfast: MealTemplate;
  lunch: MealTemplate;
  dinner: MealTemplate;
  nap: {
    enabled: boolean;
    startTime: string;
    endTime: string;
    durationMinutes?: number;
  };
  autoBreaks: boolean;
  focusBreakMinutes: number;
  physicalBreakMinutes: number;
};

const STORAGE_KEY = 'junluo.schedule.day-template.v1';
const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export const DEFAULT_DAY_TEMPLATE: DayTemplate = {
  version: 1,
  enabled: false,
  wakeTime: '',
  sleepTime: '',
  wakeEnabled: false,
  sleepEnabled: false,
  breakfast: { enabled: false, startTime: '' },
  lunch: { enabled: false, startTime: '' },
  dinner: { enabled: false, startTime: '' },
  nap: { enabled: false, startTime: '', endTime: '' },
  autoBreaks: true,
  focusBreakMinutes: 15,
  physicalBreakMinutes: 10,
};

function isClock(value: unknown): value is string {
  return typeof value === 'string' && CLOCK_PATTERN.test(value);
}

function boundedMinutes(value: unknown, fallback: number, min = 0, max = 240) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function normalizeMeal(value: unknown, fallback: MealTemplate): MealTemplate {
  const meal = typeof value === 'object' && value !== null ? value as Partial<MealTemplate> : {};
  return {
    enabled: typeof meal.enabled === 'boolean' ? meal.enabled : fallback.enabled,
    startTime: isClock(meal.startTime) ? meal.startTime : fallback.startTime,
    ...(Number.isSafeInteger(meal.durationMinutes) && Number(meal.durationMinutes) > 0
      ? { durationMinutes: meal.durationMinutes } : {}),
  };
}

export function validateDayTemplate(value: unknown): DayTemplate {
  const input = typeof value === 'object' && value !== null ? value as Partial<DayTemplate> : {};
  const nap: Partial<DayTemplate['nap']> = typeof input.nap === 'object' && input.nap !== null ? input.nap : {};
  return {
    version: 1,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_DAY_TEMPLATE.enabled,
    wakeTime: isClock(input.wakeTime) ? input.wakeTime : DEFAULT_DAY_TEMPLATE.wakeTime,
    sleepTime: isClock(input.sleepTime) ? input.sleepTime : DEFAULT_DAY_TEMPLATE.sleepTime,
    wakeEnabled: typeof input.wakeEnabled === 'boolean' ? input.wakeEnabled : isClock(input.wakeTime),
    sleepEnabled: typeof input.sleepEnabled === 'boolean' ? input.sleepEnabled : isClock(input.sleepTime),
    ...(typeof input.operationId === 'string' ? { operationId: input.operationId } : {}),
    breakfast: normalizeMeal(input.breakfast, DEFAULT_DAY_TEMPLATE.breakfast),
    lunch: normalizeMeal(input.lunch, DEFAULT_DAY_TEMPLATE.lunch),
    dinner: normalizeMeal(input.dinner, DEFAULT_DAY_TEMPLATE.dinner),
    nap: {
      enabled: typeof nap.enabled === 'boolean' ? nap.enabled : DEFAULT_DAY_TEMPLATE.nap.enabled,
      startTime: isClock(nap.startTime) ? nap.startTime : DEFAULT_DAY_TEMPLATE.nap.startTime,
      endTime: isClock(nap.endTime) ? nap.endTime : DEFAULT_DAY_TEMPLATE.nap.endTime,
      ...(Number.isSafeInteger(nap.durationMinutes) && Number(nap.durationMinutes) > 0 ? { durationMinutes: nap.durationMinutes } : {}),
    },
    autoBreaks: typeof input.autoBreaks === 'boolean' ? input.autoBreaks : DEFAULT_DAY_TEMPLATE.autoBreaks,
    focusBreakMinutes: boundedMinutes(input.focusBreakMinutes, DEFAULT_DAY_TEMPLATE.focusBreakMinutes, 0, 60),
    physicalBreakMinutes: boundedMinutes(input.physicalBreakMinutes, DEFAULT_DAY_TEMPLATE.physicalBreakMinutes, 0, 60),
  };
}

function parseStoredDayTemplate(raw: string | null): DayTemplate {
  if (!raw) return validateDayTemplate(null);
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('routine-template-invalid');
  const input = parsed as Record<string, unknown>;
  const optionalClock = (value: unknown) => value === undefined || value === '' || isClock(value);
  if (input.version !== undefined && input.version !== 1
    || ['enabled', 'wakeEnabled', 'sleepEnabled', 'autoBreaks'].some(key => input[key] !== undefined && typeof input[key] !== 'boolean')
    || !optionalClock(input.wakeTime) || !optionalClock(input.sleepTime)) throw new Error('routine-template-invalid');
  for (const kind of ['breakfast', 'lunch', 'dinner', 'nap']) {
    if (input[kind] === undefined) continue;
    const item = input[kind] as Record<string, unknown>;
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || item.enabled !== undefined && typeof item.enabled !== 'boolean' || !optionalClock(item.startTime)
      || kind === 'nap' && !optionalClock(item.endTime)
      || item.durationMinutes != null && (!Number.isSafeInteger(item.durationMinutes) || Number(item.durationMinutes) <= 0)) throw new Error('routine-template-invalid');
  }
  return validateDayTemplate(parsed);
}

export async function loadDayTemplate(): Promise<DayTemplate> {
  return parseStoredDayTemplate(await AsyncStorage.getItem(STORAGE_KEY));
}

let routineWrite = Promise.resolve<unknown>(undefined);
/** Shared by the page and host-bound tool. No lock spans a model/network request. */
export function runUserRoutineWrite<T>(work: () => Promise<T>): Promise<T> {
  const next = routineWrite.catch(() => undefined).then(work);
  routineWrite = next;
  return next;
}

export async function persistDayTemplate(template: DayTemplate, expectedTemplate: DayTemplate): Promise<DayTemplate> {
  const normalized = validateDayTemplate(template);
  await AsyncStorage.setItemIfCurrent(STORAGE_KEY, JSON.stringify(normalized), raw => {
    try { return userRoutineIdentity(parseStoredDayTemplate(raw)) === userRoutineIdentity(expectedTemplate); }
    catch { return false; }
  });
  return normalized;
}

export async function saveDayTemplate(template: DayTemplate, options?: {
  expectedTemplate?: DayTemplate; dataEpoch?: number; isCurrent?: () => boolean | Promise<boolean>; operationId?: string;
}): Promise<DayTemplate> {
  const { saveUserRoutineTemplate } = await import('./userRoutineStore');
  const operationId = options?.operationId ?? `routine-page:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const result = await saveUserRoutineTemplate(template, { ...options,
    operationId });
  if (result.status !== 'saved') throw new Error(result.reason ?? `routine-${result.status}`);
  return { ...validateDayTemplate(template), operationId };
}
