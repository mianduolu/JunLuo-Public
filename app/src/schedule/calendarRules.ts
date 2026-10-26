import type { ScheduleRecurrence } from './scheduleStore';

export type LunarDate = {
  day: number;
  isLeapMonth: boolean;
  month: number;
};

export type RecurrenceRule = {
  lunarDay?: number;
  lunarIsLeapMonth?: boolean;
  lunarMonth?: number;
  month?: number;
  monthDay?: number;
  type: ScheduleRecurrence;
  weekDay?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const lunarMonths = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];
const lunarDays = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
];

const lunarNewYearByYear: Record<number, string> = {
  2026: '2026-02-17',
  2027: '2027-02-06',
  2028: '2028-01-26',
  2029: '2029-02-13',
};

const lunarMonthLengthsByYear: Record<number, number[]> = {
  2026: [29, 30, 29, 30, 29, 30, 29, 29, 30, 30, 30, 29],
  2027: [30, 29, 30, 29, 30, 29, 30, 29, 30, 29, 30, 30],
  2028: [30, 29, 30, 30, 29, 30, 29, 29, 30, 29, 30, 29],
  2029: [30, 29, 30, 29, 30, 30, 29, 30, 29, 30, 29, 30],
};

const legalHolidays = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
]);

const legalWorkdays = new Set([
  '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10',
]);

const festivalLabels: Record<string, string> = {
  '01-01': '春节',
  '01-15': '元宵',
  '05-05': '端午',
  '07-07': '七夕',
  '08-15': '中秋',
  '09-09': '重阳',
};

export function dateKey(value: Date | number) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

export function startOfLocalDay(value: Date | number) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function parseDateKey(key: string) {
  return new Date(`${key}T00:00:00`);
}

function daysBetween(from: string, to: string) {
  return Math.round((parseDateKey(to).getTime() - parseDateKey(from).getTime()) / DAY_MS);
}

export function getLunarDate(date: Date): LunarDate | undefined {
  const key = dateKey(date);
  const year = date.getFullYear();
  const newYearKey = lunarNewYearByYear[year] && key >= lunarNewYearByYear[year] ? lunarNewYearByYear[year] : lunarNewYearByYear[year - 1];
  if (!newYearKey) return undefined;
  const lunarYear = Number(newYearKey.slice(0, 4));
  const lengths = lunarMonthLengthsByYear[lunarYear];
  if (!lengths) return undefined;
  let offset = daysBetween(newYearKey, key);
  if (offset < 0) return undefined;
  for (let index = 0; index < lengths.length; index += 1) {
    if (offset < lengths[index]) {
      return { month: index + 1, day: offset + 1, isLeapMonth: false };
    }
    offset -= lengths[index];
  }
  return undefined;
}

export function lunarToSolar(year: number, month: number, day: number) {
  const newYearKey = lunarNewYearByYear[year];
  const lengths = lunarMonthLengthsByYear[year];
  if (!newYearKey || !lengths || month < 1 || month > 12) return undefined;
  const maxDay = lengths[month - 1];
  if (day < 1 || day > maxDay) return undefined;
  const offset = lengths.slice(0, month - 1).reduce((sum, value) => sum + value, 0) + day - 1;
  return dateKey(addDays(parseDateKey(newYearKey), offset));
}

export function formatLunarDate(date: Date) {
  const lunar = getLunarDate(date);
  if (!lunar) return '';
  const key = `${String(lunar.month).padStart(2, '0')}-${String(lunar.day).padStart(2, '0')}`;
  return festivalLabels[key] ?? (lunar.day === 1 ? lunarMonths[lunar.month - 1] : lunarDays[lunar.day - 1]);
}

export function isLegalWorkday(date: Date) {
  const key = dateKey(date);
  if (legalWorkdays.has(key)) return true;
  if (legalHolidays.has(key)) return false;
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

export function buildRecurrenceRule(type: ScheduleRecurrence, startAt: number): RecurrenceRule {
  const date = new Date(startAt);
  const lunar = getLunarDate(date);
  return {
    type,
    weekDay: date.getDay(),
    monthDay: date.getDate(),
    month: date.getMonth() + 1,
    lunarMonth: lunar?.month,
    lunarDay: lunar?.day,
    lunarIsLeapMonth: lunar?.isLeapMonth,
  };
}

export function recurrenceMatches(rule: RecurrenceRule, date: Date) {
  if (rule.type === 'daily') return true;
  if (rule.type === 'weekdays') return date.getDay() >= 1 && date.getDay() <= 5;
  if (rule.type === 'legalWorkday') return isLegalWorkday(date);
  if (rule.type === 'weekly') return date.getDay() === rule.weekDay;
  if (rule.type === 'monthly') return date.getDate() === rule.monthDay;
  if (rule.type === 'yearly') return date.getMonth() + 1 === rule.month && date.getDate() === rule.monthDay;
  if (rule.type === 'lunarYearly') {
    const lunar = getLunarDate(date);
    return !!lunar && lunar.month === rule.lunarMonth && lunar.day === rule.lunarDay && lunar.isLeapMonth === !!rule.lunarIsLeapMonth;
  }
  return false;
}

export function formatRecurrenceLabel(rule: RecurrenceRule) {
  if (rule.type === 'none') return '不重复';
  if (rule.type === 'daily') return '每天';
  if (rule.type === 'weekdays') return '工作日';
  if (rule.type === 'legalWorkday') return '法定工作日';
  if (rule.type === 'weekly') return `每周${['日', '一', '二', '三', '四', '五', '六'][rule.weekDay ?? 0]}`;
  if (rule.type === 'monthly') return `每月${rule.monthDay ?? 1}日`;
  if (rule.type === 'yearly') return `每年${rule.month ?? 1}月${rule.monthDay ?? 1}日`;
  if (rule.type === 'lunarYearly') return `每年农历${lunarMonths[(rule.lunarMonth ?? 1) - 1]}${lunarDays[(rule.lunarDay ?? 1) - 1]}`;
  return '不重复';
}
