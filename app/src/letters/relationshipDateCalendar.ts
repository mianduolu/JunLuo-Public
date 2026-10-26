import { Lunar } from 'lunar-javascript';

export type RelationshipDateMode =
  | 'solar_yearly'
  | 'lunar_yearly'
  | 'once';

export type RelationshipDateV1 = {
  schemaVersion: 1;
  id: string;
  title: string;
  note?: string;
  mode: RelationshipDateMode;
  originDateKey: string;
  lunarMonth?: number;
  lunarDay?: number;
  lunarIsLeapMonth?: boolean;
  openTimeMinutes: number;
  letterEnabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type RelationshipDateOccurrence = {
  id: string;
  relationshipDateId: string;
  localDateKey: string;
  scheduledAt: number;
  annual: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const ANNUAL_SEARCH_YEARS = 40;

export function formatLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseLocalDateKey(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return null;
  return { day, month, year };
}

export function localDateAtMinutes(dateKey: string, minutes: number) {
  const parsed = parseLocalDateKey(dateKey);
  if (!parsed || !Number.isInteger(minutes) || minutes < 0 || minutes > 1439) return null;
  const date = new Date(parsed.year, parsed.month - 1, parsed.day, 0, minutes, 0, 0);
  return date.getTime();
}

export function relationshipDateOccurrenceId(relationshipDateId: string, localDateKey: string) {
  return `relationship-date:${relationshipDateId}:${localDateKey}`;
}

export function getLunarFieldsForDateKey(dateKey: string) {
  const at = localDateAtMinutes(dateKey, 12 * 60);
  if (at === null) return null;
  const lunar = Lunar.fromDate(new Date(at));
  return {
    lunarDay: lunar.getDay(),
    lunarIsLeapMonth: lunar.getMonth() < 0,
    lunarMonth: Math.abs(lunar.getMonth()),
  };
}

function solarDateKeyForYear(record: RelationshipDateV1, year: number) {
  const origin = parseLocalDateKey(record.originDateKey);
  if (!origin) return null;
  const date = new Date(year, origin.month - 1, origin.day, 12, 0, 0, 0);
  if (date.getMonth() !== origin.month - 1 || date.getDate() !== origin.day) return null;
  return formatLocalDateKey(date);
}

function lunarDateKeyForYear(record: RelationshipDateV1, lunarYear: number) {
  if (
    !Number.isInteger(record.lunarMonth)
    || !Number.isInteger(record.lunarDay)
    || record.lunarMonth! < 1
    || record.lunarMonth! > 12
    || record.lunarDay! < 1
    || record.lunarDay! > 30
  ) return null;
  try {
    const lunarMonth = record.lunarIsLeapMonth ? -record.lunarMonth! : record.lunarMonth!;
    const solar = Lunar.fromYmd(lunarYear, lunarMonth, record.lunarDay!).getSolar();
    const date = new Date(solar.getYear(), solar.getMonth() - 1, solar.getDay(), 12, 0, 0, 0);
    const roundTrip = Lunar.fromDate(date);
    if (
      roundTrip.getYear() !== lunarYear
      || roundTrip.getMonth() !== lunarMonth
      || roundTrip.getDay() !== record.lunarDay
    ) return null;
    return formatLocalDateKey(date);
  } catch {
    return null;
  }
}

function occurrenceFromDateKey(record: RelationshipDateV1, dateKey: string): RelationshipDateOccurrence | null {
  const scheduledAt = localDateAtMinutes(dateKey, record.openTimeMinutes);
  if (scheduledAt === null) return null;
  return {
    id: relationshipDateOccurrenceId(record.id, dateKey),
    relationshipDateId: record.id,
    localDateKey: dateKey,
    scheduledAt,
    annual: record.mode !== 'once',
  };
}

export function listRelationshipDateOccurrencesBetween(
  record: RelationshipDateV1,
  startAt: number,
  endAt: number,
) {
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt) return [];
  if (record.mode === 'once') {
    const occurrence = occurrenceFromDateKey(record, record.originDateKey);
    return occurrence && occurrence.scheduledAt >= startAt && occurrence.scheduledAt <= endAt
      ? [occurrence]
      : [];
  }

  const startYear = new Date(startAt - 370 * DAY_MS).getFullYear();
  const endYear = new Date(endAt + 370 * DAY_MS).getFullYear();
  const byId = new Map<string, RelationshipDateOccurrence>();
  for (let year = startYear; year <= endYear; year += 1) {
    const dateKey = record.mode === 'solar_yearly'
      ? solarDateKeyForYear(record, year)
      : lunarDateKeyForYear(record, year);
    if (!dateKey) continue;
    const occurrence = occurrenceFromDateKey(record, dateKey);
    if (
      occurrence
      && occurrence.scheduledAt >= startAt
      && occurrence.scheduledAt <= endAt
      && occurrence.localDateKey >= record.originDateKey
    ) byId.set(occurrence.id, occurrence);
  }
  return [...byId.values()].sort((left, right) => left.scheduledAt - right.scheduledAt);
}

export function getNextRelationshipDateOccurrence(record: RelationshipDateV1, now = Date.now()) {
  if (record.mode === 'once') {
    const occurrence = occurrenceFromDateKey(record, record.originDateKey);
    return occurrence && occurrence.scheduledAt >= now ? occurrence : null;
  }
  return listRelationshipDateOccurrencesBetween(
    record,
    now,
    now + ANNUAL_SEARCH_YEARS * 370 * DAY_MS,
  )[0] ?? null;
}

export function getPreviousRelationshipDateOccurrence(
  record: RelationshipDateV1,
  beforeAt: number,
) {
  if (record.mode === 'once') return null;
  const occurrences = listRelationshipDateOccurrencesBetween(
    record,
    beforeAt - ANNUAL_SEARCH_YEARS * 370 * DAY_MS,
    beforeAt - 1,
  );
  return occurrences[occurrences.length - 1] ?? null;
}
