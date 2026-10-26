import { assertShiyingLifeDate } from './shiyingContract';
import {
  addShiyingLifeDates, getShiyingLifeDate, getShiyingLifeDateStartAt,
  SHIYING_LIFE_DAY_BOUNDARY_HOUR,
} from './shiyingWindow';

export const SHIYING_AUTOMATIC_CALL_LIMIT = 2;
export const SHIYING_AUTOMATIC_EXPLANATION = '夜里空闲时自动捡一捡，每晚最多 2 次模型调用，一批留下 0～3 条荧迹。没捡完的，下次接着捡。';

export type ShiyingAutomaticState = {
  enabled: boolean;
  firstEnabledLifeDate: string | null;
  scanFloorAt: number | null;
  nightLifeDate: string | null;
  reservedCalls: number;
  closed: boolean;
  batchId: string | null;
  lastErrorCode: string | null;
  updatedAt: number;
};

export type ShiyingAutomaticSleepTemplate = {
  enabled: boolean;
  sleepEnabled?: boolean;
  sleepTime: string;
};

export function createShiyingAutomaticState(): ShiyingAutomaticState {
  return {
    enabled: false, firstEnabledLifeDate: null, scanFloorAt: null,
    nightLifeDate: null, reservedCalls: 0, closed: false, batchId: null,
    lastErrorCode: null, updatedAt: 0,
  };
}

export function getShiyingAutomaticNight(input: {
  now: number;
  template: ShiyingAutomaticSleepTemplate | null;
  firstEnabledLifeDate: string | null;
}): { nightLifeDate: string; dueAt: number; idleMs: number } | null {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new Error('shiying_automatic_time_invalid');
  }
  if (input.firstEnabledLifeDate === null) return null;
  assertShiyingLifeDate(input.firstEnabledLifeDate);
  const hasSleepTime = input.template?.enabled === true
    && input.template.sleepEnabled !== false
    && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(input.template.sleepTime);
  const [hour, minute] = (hasSleepTime ? input.template!.sleepTime : '22:30').split(':').map(Number);
  let nightLifeDate = getShiyingLifeDate(input.now);
  const sleepAt = (lifeDate: string) => {
    const date = new Date(getShiyingLifeDateStartAt(lifeDate));
    if (hour < SHIYING_LIFE_DAY_BOUNDARY_HOUR) date.setDate(date.getDate() + 1);
    date.setHours(hour, minute, 0, 0);
    return date.getTime();
  };
  let dueAt = sleepAt(nightLifeDate);
  if (input.now < dueAt) {
    nightLifeDate = addShiyingLifeDates(nightLifeDate, -1);
    dueAt = sleepAt(nightLifeDate);
  }
  if (nightLifeDate < input.firstEnabledLifeDate) return null;
  return { nightLifeDate, dueAt, idleMs: (hasSleepTime ? 45 : 60) * 60_000 };
}
