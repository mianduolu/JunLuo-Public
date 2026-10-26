import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { lettersLifeStorageBridge as AsyncStorage } from '../sync/syncLettersLifeStorageBridge';
import {
  formatLocalDateKey,
  getLunarFieldsForDateKey,
  getNextRelationshipDateOccurrence,
  parseLocalDateKey,
  type RelationshipDateMode,
  type RelationshipDateV1,
} from './relationshipDateCalendar';

export const RELATIONSHIP_DATES_STORAGE_KEY = 'junluo.relationshipDates.v1' as const;

export type RelationshipDateDraft = {
  id?: string;
  title: string;
  note?: string;
  mode: RelationshipDateMode;
  originDateKey: string;
  openTimeMinutes: number;
  letterEnabled: boolean;
};

function makeId() {
  return `relationship-date-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeRecord(value: unknown): RelationshipDateV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<RelationshipDateV1>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const note = typeof record.note === 'string' ? record.note.trim() : '';
  if (
    record.schemaVersion !== 1
    || typeof record.id !== 'string'
    || !record.id
    || !title
    || title.length > 80
    || note.length > 1000
    || (record.mode !== 'solar_yearly' && record.mode !== 'lunar_yearly' && record.mode !== 'once')
    || typeof record.originDateKey !== 'string'
    || !parseLocalDateKey(record.originDateKey)
    || !Number.isInteger(record.openTimeMinutes)
    || record.openTimeMinutes! < 0
    || record.openTimeMinutes! > 1439
    || typeof record.letterEnabled !== 'boolean'
    || !Number.isSafeInteger(record.createdAt)
    || !Number.isSafeInteger(record.updatedAt)
    || record.createdAt! < 0
    || record.updatedAt! < 0
  ) return null;

  const lunar = record.mode === 'lunar_yearly'
    ? (
      Number.isInteger(record.lunarMonth)
      && Number.isInteger(record.lunarDay)
      && typeof record.lunarIsLeapMonth === 'boolean'
        ? {
          lunarDay: record.lunarDay!,
          lunarIsLeapMonth: record.lunarIsLeapMonth,
          lunarMonth: record.lunarMonth!,
        }
        : getLunarFieldsForDateKey(record.originDateKey)
    )
    : null;
  if (record.mode === 'lunar_yearly' && !lunar) return null;
  return {
    schemaVersion: 1,
    id: record.id,
    title,
    ...(note ? { note } : {}),
    mode: record.mode,
    originDateKey: record.originDateKey,
    ...(lunar ?? {}),
    openTimeMinutes: record.openTimeMinutes!,
    letterEnabled: record.letterEnabled,
    createdAt: record.createdAt!,
    updatedAt: record.updatedAt!,
  };
}

function sortRecords(records: readonly RelationshipDateV1[], now = Date.now()) {
  return [...records].sort((left, right) => {
    const leftAt = getNextRelationshipDateOccurrence(left, now)?.scheduledAt ?? Number.POSITIVE_INFINITY;
    const rightAt = getNextRelationshipDateOccurrence(right, now)?.scheduledAt ?? Number.POSITIVE_INFINITY;
    return leftAt - rightAt || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
  });
}

export async function loadRelationshipDates(now = Date.now()) {
  const raw = await AsyncStorage.getItem(RELATIONSHIP_DATES_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? sortRecords(parsed.map(normalizeRecord).filter((item): item is RelationshipDateV1 => !!item), now)
      : [];
  } catch {
    return [];
  }
}

async function saveRelationshipDates(records: readonly RelationshipDateV1[]) {
  const serialized = JSON.stringify(sortRecords(records));
  try {
    await AsyncStorage.setItem(RELATIONSHIP_DATES_STORAGE_KEY, serialized);
  } catch {
    await AsyncStorage.setItem(RELATIONSHIP_DATES_STORAGE_KEY, serialized);
  }
}

function validateDraft(draft: RelationshipDateDraft) {
  const title = draft.title.trim();
  const note = draft.note?.trim() ?? '';
  if (!title) throw new Error('纪念日名称不能为空。');
  if (title.length > 80) throw new Error('纪念日名称不能超过 80 字。');
  if (note.length > 1000) throw new Error('备注不能超过 1000 字。');
  if (!parseLocalDateKey(draft.originDateKey)) throw new Error('日期格式无效。');
  if (!Number.isInteger(draft.openTimeMinutes) || draft.openTimeMinutes < 0 || draft.openTimeMinutes > 1439) {
    throw new Error('开信时间无效。');
  }
  return { note, title };
}

export async function upsertRelationshipDate(
  draft: RelationshipDateDraft,
  options: { dataEpoch?: number | null; now?: number } = {},
) {
  const cleaned = validateDraft(draft);
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  if (dataEpoch === null || !canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
  const now = options.now ?? Date.now();
  const lunar = draft.mode === 'lunar_yearly' ? getLunarFieldsForDateKey(draft.originDateKey) : null;
  if (draft.mode === 'lunar_yearly' && !lunar) throw new Error('农历日期换算失败。');
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    const records = await loadRelationshipDates(now);
    const existing = draft.id ? records.find((record) => record.id === draft.id) : undefined;
    const next: RelationshipDateV1 = {
      schemaVersion: 1,
      id: existing?.id ?? makeId(),
      title: cleaned.title,
      ...(cleaned.note ? { note: cleaned.note } : {}),
      mode: draft.mode,
      originDateKey: draft.originDateKey,
      ...(lunar ?? {}),
      openTimeMinutes: draft.openTimeMinutes,
      letterEnabled: draft.letterEnabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await saveRelationshipDates([next, ...records.filter((record) => record.id !== next.id)]);
    return next;
  });
  return committed.committed ? committed.value : null;
}

export async function deleteRelationshipDate(
  relationshipDateId: string,
  options: { dataEpoch?: number | null; now?: number } = {},
) {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  if (dataEpoch === null || !canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    const records = await loadRelationshipDates(options.now);
    const target = records.find((record) => record.id === relationshipDateId) ?? null;
    if (!target) return null;
    await saveRelationshipDates(records.filter((record) => record.id !== relationshipDateId));
    return target;
  });
  return committed.committed ? committed.value : null;
}

export function makeDefaultRelationshipDateDraft(now = Date.now()): RelationshipDateDraft {
  return {
    title: '',
    mode: 'solar_yearly',
    originDateKey: formatLocalDateKey(new Date(now)),
    openTimeMinutes: 9 * 60,
    letterEnabled: false,
  };
}
