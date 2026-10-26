import * as SQLite from 'expo-sqlite';
import { chatScheduleReminderAt } from './chatSchedulePlanPolicy';
import { clearRestoredScheduleMemoryUsage } from './scheduleReminderTiming';
import { openDatabaseImportSource, type DatabaseImportSource } from '../backup/sqliteBackupFiles';
import type { PostponeTarget } from './postponeLogic';
import { nextMondayKey } from './postponeLogic';
import { buildRecurrenceRule, recurrenceMatches, type RecurrenceRule } from './calendarRules';
import {
  closeScheduleDatabase,
  getScheduleDatabase,
} from './scheduleDatabase';
import { createScheduleOccurrenceNotificationId } from './localNotificationIdentity';
import { requestScheduleNotificationRefresh } from './scheduleNotificationRefresh';
import { runScheduleSemanticCaptureExclusive, runScheduleSemanticOperation } from '../sync/syncScheduleSemanticCaptureQueue';

export type ScheduleRecurrence = 'none' | 'daily' | 'weekdays' | 'legalWorkday' | 'weekly' | 'monthly' | 'yearly' | 'lunarYearly';
export type ScheduleReminderIntensity = 'gentle' | 'strong' | 'blast';
export type ScheduleItemStatus = 'pending' | 'completed' | 'cancelled';
export type ScheduleSource = 'manual' | 'ai' | 'habit';
export type ScheduleOccurrenceStatus = 'pending' | 'completed' | 'cancelled';
export type ScheduleOwner = 'I' | 'you' | 'I 和 you';
export type ScheduleReadingChoiceValue = {
  sourceId: string; version: number; currentReadingId: string | null; nextReadingId: string | null; operationId: string;
};
export type ScheduleReadingChoice = ScheduleReadingChoiceValue | { sourceId: string };
export type ScheduleExecution = {
  readingChoice?: ScheduleReadingChoice;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
  elapsedMs?: number;
  completedUnitCount?: number;
  planRevision?: number;
  activityPlanRevision?: number;
  totalPlannedMs?: number;
  completionId?: string;
  originOccurrenceId?: string;
  durationChange?: { operationId: string; effectiveAt: number; elapsedMs: number; remainingMs: number; pending: boolean; applyAttempts?: number };
  resumeUnscheduled?: boolean;
  estimatedEndAt?: number | null;
  adjustment?: { operationId: string; changedAt: number; action: 'reschedule' | 'cancel'; pending: boolean; cleanupAttempts?: number; readingReplacement?: boolean };
} & ({ status: 'planned'; activityId?: never; totalPlannedMs: number; planRevision: number }
  | { status: 'running' | 'paused' | 'ended' | 'completed'; activityId: string });

/** A saved plan edit, unlike a progress tick, invalidates the old execution segment. */
export function adjustedScheduleExecution(item: ScheduleItem, operationId: string, now: number,
  action: 'reschedule' | 'cancel'): ScheduleExecution | undefined {
  const prior = item.execution;
  if (item.owner !== 'I' || prior?.status === 'completed') return prior ?? undefined;
  if (!prior || prior.status === 'planned') {
    if (action === 'cancel') return prior ?? undefined;
    return { status: 'planned', updatedAt: now, planRevision: (prior?.planRevision ?? 0) + 1,
      ...(prior?.readingChoice ? { readingChoice: prior.readingChoice } : {}),
      totalPlannedMs: prior?.totalPlannedMs ?? Math.max(0, (item.endAt ?? item.startAt) - item.startAt) };
  }
  return { ...prior, planRevision: (prior.planRevision ?? 0) + 1,
    activityPlanRevision: prior.activityPlanRevision ?? prior.planRevision ?? 0,
    totalPlannedMs: prior.totalPlannedMs ?? Math.max(0, (item.endAt ?? item.startAt) - item.startAt),
    completionId: prior.completionId ?? prior.activityId,
    originOccurrenceId: prior.originOccurrenceId ?? `${item.id}:${item.startAt}`,
    adjustment: { operationId, changedAt: prior.adjustment?.pending ? prior.adjustment.changedAt : now, action, pending: true,
      ...(prior.adjustment?.pending ? { cleanupAttempts: prior.adjustment.cleanupAttempts ?? 0 } : {}) } };
}

/** Stable during progress/checkpoint writes; only actual plan choices change this token. */
export function schedulePlanVersion(item: ScheduleItem): number {
  const value = JSON.stringify([item.id, item.owner ?? 'you', item.title, item.notes, item.startAt, item.endAt ?? null,
    item.status, item.recurrence, item.readingId ?? null, item.habitId ?? null, item.execution?.planRevision ?? 0]);
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export function scheduleOwnersOverlap(left: ScheduleOwner = 'you', right: ScheduleOwner = 'you') {
  return left === right || left === 'I 和 you' || right === 'I 和 you';
}

function parseExecution(raw?: string | null): ScheduleExecution | undefined {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as ScheduleExecution; } catch { return undefined; }
}

export type ScheduleItem = {
  startReminderEnabled?: boolean;
  endMode?: 'duration' | 'fixed';
  durationMinutes?: number;
  habitCompletionKey?: string;
  owner?: ScheduleOwner;
  readingId?: string | null;
  execution?: ScheduleExecution | null;
  id: string;
  title: string;
  notes: string;
  startAt: number;
  endAt?: number;
  reminderMinutesBefore: number;
  recurrence: ScheduleRecurrence;
  recurrenceRule?: RecurrenceRule;
  rangeEndAt?: number;
  status: ScheduleItemStatus;
  reminderText: string;
  reminderIntensity: ScheduleReminderIntensity;
  source: ScheduleSource;
  habitId?: string;
  habitAnchorKey?: string;
  todoId?: string;
  goalId?: string;
  planId?: string;
  companionEnabled: boolean;
  letterTicketEnabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ScheduleDraft = Omit<ScheduleItem, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'companionEnabled' | 'letterTicketEnabled'> & {
  companionEnabled?: boolean;
  letterTicketEnabled?: boolean;
};

export type ScheduleOccurrence = {
  completionRound?: number;
  startReminderEnabled?: boolean;
  endMode?: 'duration' | 'fixed';
  durationMinutes?: number;
  habitCompletionKey?: string;
  completedAt?: number;
  owner?: ScheduleOwner;
  readingId?: string | null;
  execution?: ScheduleExecution | null;
  id: string;
  itemId: string;
  scheduledStartAt: number;
  reminderAt: number;
  status: ScheduleOccurrenceStatus;
  notificationId?: string;
  chatDeliveredAt?: number;
  title: string;
  reminderText: string;
  reminderIntensity: ScheduleReminderIntensity;
  source: ScheduleSource;
  habitId?: string;
  habitAnchorKey?: string;
  todoId?: string;
  goalId?: string;
  planId?: string;
  companionEnabled: boolean;
  letterTicketEnabled?: boolean;
  notes: string;
  endAt?: number;
  rangeEndAt?: number;
  reminderMinutesBefore: number;
  recurrence: ScheduleRecurrence;
};

type ItemRow = {
  start_reminder_enabled?: number | null;
  end_mode?: 'duration' | 'fixed' | null;
  duration_minutes?: number | null;
  habit_completion_key?: string | null;
  owner?: ScheduleOwner;
  reading_id?: string | null;
  execution_json?: string | null;
  id: string;
  title: string;
  notes: string;
  start_at: number;
  end_at: number | null;
  reminder_minutes_before: number;
  recurrence: ScheduleRecurrence;
  recurrence_rule: string | null;
  range_end_at: number | null;
  status: ScheduleItemStatus;
  reminder_text: string;
  reminder_intensity: ScheduleReminderIntensity;
  source: ScheduleSource;
  habit_id: string | null;
  habit_anchor_key: string | null;
  todo_id: string | null;
  goal_id: string | null;
  plan_id: string | null;
  companion_enabled: number | null;
  letter_ticket_enabled: number | null;
  created_at: number;
  updated_at: number;
};

type OccurrenceRow = {
  completion_round?: number;
  start_reminder_enabled?: number | null;
  end_mode?: 'duration' | 'fixed' | null;
  duration_minutes?: number | null;
  habit_completion_key?: string | null;
  completed_at?: number | null;
  owner?: ScheduleOwner;
  reading_id?: string | null;
  execution_json?: string | null;
  id: string;
  item_id: string;
  scheduled_start_at: number;
  reminder_at: number;
  status: ScheduleOccurrenceStatus;
  notification_id: string | null;
  chat_delivered_at: number | null;
  title: string;
  reminder_text: string;
  reminder_intensity: ScheduleReminderIntensity;
  source: ScheduleSource;
  habit_id: string | null;
  habit_anchor_key: string | null;
  todo_id: string | null;
  goal_id: string | null;
  plan_id: string | null;
  companion_enabled: number | null;
  letter_ticket_enabled: number | null;
  notes: string;
  item_end_at: number | null;
  item_start_at: number;
  reminder_minutes_before: number;
  recurrence: ScheduleRecurrence;
  range_end_at: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HORIZON_DAYS = 90;
let horizonPromise: Promise<void> | undefined;

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function fromItemRow(row: ItemRow): ScheduleItem {
  const recurrenceRule = parseRecurrenceRule(row.recurrence_rule, row.recurrence, row.start_at);
  return {
    startReminderEnabled: row.start_reminder_enabled == null ? undefined : row.start_reminder_enabled === 1,
    endMode: row.end_mode ?? undefined,
    durationMinutes: row.duration_minutes ?? undefined,
    habitCompletionKey: row.habit_completion_key ?? undefined,
    owner: row.owner ?? 'you',
    readingId: row.reading_id ?? undefined,
    execution: parseExecution(row.execution_json),
    id: row.id,
    title: row.title,
    notes: row.notes,
    startAt: row.start_at,
    endAt: row.end_at ?? undefined,
    reminderMinutesBefore: row.reminder_minutes_before,
    recurrence: normalizeRecurrence(row.recurrence),
    recurrenceRule,
    rangeEndAt: row.range_end_at ?? undefined,
    status: row.status,
    reminderText: row.reminder_text,
    reminderIntensity: row.reminder_intensity ?? 'gentle',
    source: row.source,
    habitId: row.habit_id ?? undefined,
    habitAnchorKey: row.habit_anchor_key ?? undefined,
    todoId: row.todo_id ?? undefined,
    goalId: row.goal_id ?? undefined,
    planId: row.plan_id ?? undefined,
    companionEnabled: row.companion_enabled === 1,
    letterTicketEnabled: row.letter_ticket_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeRecurrence(value?: string | null): ScheduleRecurrence {
  return value === 'daily' || value === 'weekdays' || value === 'legalWorkday' || value === 'weekly' || value === 'monthly' || value === 'yearly' || value === 'lunarYearly'
    ? value
    : 'none';
}

function parseRecurrenceRule(value: string | null, recurrence: ScheduleRecurrence, startAt: number): RecurrenceRule {
  if (value) {
    try {
      const parsed = JSON.parse(value) as Partial<RecurrenceRule>;
      return { ...buildRecurrenceRule(normalizeRecurrence(parsed.type ?? recurrence), startAt), ...parsed, type: normalizeRecurrence(parsed.type ?? recurrence) };
    } catch {
      // Fall back to a rule derived from the start date.
    }
  }
  return buildRecurrenceRule(normalizeRecurrence(recurrence), startAt);
}

function serializeRecurrenceRule(item: Pick<ScheduleItem, 'recurrence' | 'recurrenceRule' | 'startAt'>) {
  return JSON.stringify(item.recurrenceRule ?? buildRecurrenceRule(item.recurrence, item.startAt));
}

function fromOccurrenceRow(row: OccurrenceRow): ScheduleOccurrence {
  return {
    completionRound: row.completion_round ?? 0,
    startReminderEnabled: row.start_reminder_enabled == null ? undefined : row.start_reminder_enabled === 1,
    endMode: row.end_mode ?? undefined,
    durationMinutes: row.duration_minutes ?? undefined,
    habitCompletionKey: row.habit_completion_key ?? undefined,
    completedAt: row.completed_at ?? undefined,
    owner: row.owner ?? 'you',
    readingId: row.reading_id ?? undefined,
    execution: parseExecution(row.execution_json),
    id: row.id,
    itemId: row.item_id,
    scheduledStartAt: row.scheduled_start_at,
    reminderAt: row.reminder_at,
    status: row.status,
    notificationId: row.notification_id ?? undefined,
    chatDeliveredAt: row.chat_delivered_at ?? undefined,
    title: row.title,
    reminderText: row.reminder_text,
    reminderIntensity: row.reminder_intensity ?? 'gentle',
    source: row.source,
    habitId: row.habit_id ?? undefined,
    habitAnchorKey: row.habit_anchor_key ?? undefined,
    todoId: row.todo_id ?? undefined,
    goalId: row.goal_id ?? undefined,
    planId: row.plan_id ?? undefined,
    companionEnabled: row.companion_enabled === 1,
    letterTicketEnabled: row.letter_ticket_enabled === 1,
    notes: row.notes,
    endAt: row.item_end_at === null ? undefined : row.scheduled_start_at + (row.item_end_at - row.item_start_at),
    rangeEndAt: row.range_end_at ?? undefined,
    reminderMinutesBefore: row.reminder_minutes_before,
    recurrence: row.recurrence,
  };
}

function startOfDay(value: number) {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function dateKey(value: number | Date) {
  const date = value instanceof Date ? value : new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

async function getDatabase() {
  return getScheduleDatabase();
}

export async function exportScheduleDatabase() {
  const database = await getDatabase();
  return database.serializeAsync();
}

export async function importScheduleDatabase(sourceFile: DatabaseImportSource) {
  const source = await openDatabaseImportSource(sourceFile);
  let destination: SQLite.SQLiteDatabase | undefined;
  try {
    const columns = await source.getAllAsync<{ name: string }>('PRAGMA table_info(schedule_items)');
    const definitions = [['owner', "TEXT NOT NULL DEFAULT 'you'"], ['reading_id', 'TEXT'], ['execution_json', 'TEXT']] as const;
    const absent = definitions.filter(([name]) => !columns.some(column => column.name === name));
    const current = absent.length ? await (await getDatabase()).getAllAsync<ItemRow>('SELECT * FROM schedule_items') : [];
    await closeScheduleDatabase();
    destination = await SQLite.openDatabaseAsync('junluo-schedule.db');
    await SQLite.backupDatabaseAsync({ sourceDatabase: source, destDatabase: destination });
    await clearRestoredScheduleMemoryUsage(destination);
    // Old backups have no opinion about fields introduced after they were written.
    for (const [name, definition] of absent) {
      await destination.execAsync(`ALTER TABLE schedule_items ADD COLUMN ${name} ${definition};`);
      for (const row of current) {
        const value = row[name] ?? (name === 'owner' ? 'you' : null);
        await destination.runAsync(`UPDATE schedule_items SET ${name} = ? WHERE id = ?`, value, row.id);
      }
    }
  } finally {
    await source.closeAsync();
    await destination?.closeAsync();
  }
}

export async function clearScheduleDatabase() {
  const database = await getDatabase();
  await database.execAsync('DELETE FROM schedule_occurrences; DELETE FROM schedule_items;');
}

async function loadItem(itemId: string, connection?: SQLite.SQLiteDatabase) {
  const database = connection ?? await getDatabase();
  const row = await database.getFirstAsync<ItemRow>('SELECT * FROM schedule_items WHERE id = ?', itemId);
  return row ? fromItemRow(row) : null;
}

export async function loadScheduleItemById(itemId: string) {
  return loadItem(itemId);
}

export async function loadOwnedScheduleItems(startAt: number, endAt: number, options: { includeTerminal?: boolean } = {}) {
  await ensureScheduleHorizon();
  const database = await getDatabase();
  const rows = await database.getAllAsync<ItemRow>(
    `SELECT * FROM schedule_items WHERE recurrence = 'none' AND start_at < ? AND (COALESCE(end_at, start_at + 1800000) > ?
     OR CASE WHEN json_valid(execution_json) THEN json_extract(execution_json, '$.estimatedEndAt') ELSE NULL END > ?)
     ${options.includeTerminal ? '' : "AND status = 'pending'"} ORDER BY start_at ASC`, endAt, startAt,
    startAt,
  );
  const recurring = await database.getAllAsync<ItemRow & { occurrence_start_at: number; occurrence_status: ScheduleOccurrenceStatus }>(
    `SELECT i.*, o.scheduled_start_at AS occurrence_start_at, o.status AS occurrence_status FROM schedule_items i
     JOIN schedule_occurrences o ON o.item_id = i.id WHERE i.recurrence != 'none'
     AND o.scheduled_start_at < ? AND o.scheduled_start_at + COALESCE(i.end_at - i.start_at, 1800000) > ?
     ${options.includeTerminal ? '' : "AND i.status = 'pending' AND o.status = 'pending'"}`, endAt, startAt,
  );
  return [...rows.map(fromItemRow), ...recurring.map((row) => ({ ...fromItemRow(row), startAt: row.occurrence_start_at, status: row.occurrence_status,
    endAt: row.end_at === null ? undefined : row.occurrence_start_at + row.end_at - row.start_at }))]
    .sort((left, right) => left.startAt - right.startAt);
}

export async function saveScheduleExecution(itemId: string, execution: ScheduleExecution, expectedUpdatedAt?: number) {
  const database = await getDatabase();
  const result = await database.runAsync(
    `UPDATE schedule_items SET execution_json = ?, updated_at = MAX(updated_at + 1, ?)
     WHERE id = ? AND owner = 'I' ${expectedUpdatedAt === undefined ? '' : 'AND updated_at = ?'}`,
    JSON.stringify(execution), execution.updatedAt, itemId, ...(expectedUpdatedAt === undefined ? [] : [expectedUpdatedAt]),
  );
  if (!result.changes) throw new Error('schedule-target-changed');
  return loadItem(itemId);
}

export async function loadPendingOwnScheduleItems(): Promise<ScheduleItem[]> {
  const rows = await (await getDatabase()).getAllAsync<ItemRow>(
    "SELECT * FROM schedule_items WHERE owner = 'I' AND status = 'pending' AND recurrence = 'none' ORDER BY start_at, id",
  );
  return rows.map(fromItemRow);
}

export async function loadOwnScheduleAdjustments(): Promise<ScheduleItem[]> {
  const rows = await (await getDatabase()).getAllAsync<ItemRow>(
    "SELECT * FROM schedule_items WHERE owner = 'I' AND recurrence = 'none' AND execution_json IS NOT NULL",
  );
  return rows.map(fromItemRow).filter(item => item.execution?.adjustment?.pending || item.execution?.durationChange?.pending);
}

function occurrenceTimes(item: ScheduleItem, now = Date.now()) {
  if (item.status !== 'pending') return [];
  const firstDay = startOfDay(Math.max(item.startAt, now - DAY_MS));
  const horizon = now + HORIZON_DAYS * DAY_MS;
  const original = new Date(item.startAt);
  const rule = item.recurrenceRule ?? buildRecurrenceRule(item.recurrence, item.startAt);
  const occurrences: number[] = [];

  if (item.recurrence === 'none') {
    return item.startAt >= now - DAY_MS ? [item.startAt] : [];
  }

  for (let cursor = firstDay; cursor <= horizon; cursor += DAY_MS) {
    const date = new Date(cursor);
    if (date.getTime() < startOfDay(item.startAt)) continue;
    if (!recurrenceMatches(rule, date)) continue;
    const scheduled = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      original.getHours(),
      original.getMinutes(),
    ).getTime();
    if (scheduled >= item.startAt && scheduled <= horizon && (!item.rangeEndAt || scheduled <= item.rangeEndAt)) occurrences.push(scheduled);
  }
  return occurrences;
}

async function ensureItemOccurrences(
  item: ScheduleItem,
  retainedOccurrences?: ReadonlyMap<string, Pick<OccurrenceRow, 'status' | 'completed_at' | 'completion_round'>>,
  connection?: SQLite.SQLiteDatabase,
) {
  const database = connection ?? await getDatabase();
  const times = occurrenceTimes(item);
  if (!times.length) return;

  if (item.recurrence !== 'none') {
    const newest = await database.getFirstAsync<{ latest: number | null }>(
      'SELECT MAX(scheduled_start_at) AS latest FROM schedule_occurrences WHERE item_id = ?',
      item.id,
    );
    if (newest?.latest != null && newest.latest >= times[times.length - 1]) return;
  }

  for (const scheduledStartAt of times) {
    const id = `${item.id}:${scheduledStartAt}`;
    const retained = retainedOccurrences?.get(id);
    await database.runAsync(
      `INSERT OR IGNORE INTO schedule_occurrences
       (id, item_id, scheduled_start_at, reminder_at, status, completed_at, completion_round)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      item.id,
      scheduledStartAt,
      item.owner !== 'I' && item.startReminderEnabled !== undefined
        ? chatScheduleReminderAt(scheduledStartAt, item.reminderMinutesBefore, item.createdAt)
        : scheduledStartAt - item.reminderMinutesBefore * 60 * 1000,
      retained?.status ?? 'pending',
      retained?.completed_at ?? null,
      retained?.completion_round ?? 0,
    );
  }
}

export async function ensureScheduleHorizon() {
  return runScheduleSemanticOperation(async () => {
    if (!horizonPromise) {
      horizonPromise = runScheduleSemanticCaptureExclusive(async () => {
        const database = await getDatabase();
        const rows = await database.getAllAsync<ItemRow>("SELECT * FROM schedule_items WHERE status = 'pending'");
        // Keep every write inside the shared gate, including when one fails.
        for (const row of rows) await ensureItemOccurrences(fromItemRow(row));
      }).finally(() => {
        horizonPromise = undefined;
      });
    }
    await horizonPromise;
  });
}

export async function createScheduleItem(draft: ScheduleDraft) {
  const database = await getDatabase();
  const now = Date.now();
  const item: ScheduleItem = {
    ...draft,
    owner: draft.owner ?? 'you',
    companionEnabled: draft.companionEnabled === true,
    letterTicketEnabled: draft.letterTicketEnabled === true,
    recurrence: normalizeRecurrence(draft.recurrence),
    recurrenceRule: draft.recurrenceRule ?? buildRecurrenceRule(normalizeRecurrence(draft.recurrence), draft.startAt),
    id: makeId('schedule'),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  await database.runAsync(
    `INSERT INTO schedule_items
      (id, title, notes, start_at, end_at, reminder_minutes_before, recurrence, recurrence_rule, range_end_at, status, reminder_text, reminder_intensity, source, habit_id, habit_anchor_key, todo_id, goal_id, plan_id, companion_enabled, letter_ticket_enabled, created_at, updated_at, owner, reading_id, execution_json, start_reminder_enabled, end_mode, duration_minutes, habit_completion_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    item.id,
    item.title.trim(),
    item.notes.trim(),
    item.startAt,
    item.endAt ?? null,
    item.reminderMinutesBefore,
    item.recurrence,
    serializeRecurrenceRule(item),
    item.rangeEndAt ?? null,
    item.status,
    item.reminderText.trim(),
    item.reminderIntensity,
    item.source,
    item.habitId ?? null,
    item.habitAnchorKey ?? null,
    item.todoId ?? null,
    item.goalId ?? null,
    item.planId ?? null,
    item.companionEnabled ? 1 : 0,
    item.letterTicketEnabled ? 1 : 0,
    item.createdAt,
    item.updatedAt,
    item.owner ?? 'you',
    item.readingId ?? null,
    item.execution ? JSON.stringify(item.execution) : null,
    item.startReminderEnabled === undefined ? null : item.startReminderEnabled ? 1 : 0,
    item.endMode ?? null, item.durationMinutes ?? null, item.habitCompletionKey ?? null,
  );
  await ensureItemOccurrences(item);
  requestScheduleNotificationRefresh();
  return item;
}

export async function hasScheduleConflict(draft: ScheduleDraft, excludedItemId?: string) {
  await ensureScheduleHorizon();
  const database = await getDatabase();
  const candidate: ScheduleItem = {
    ...draft,
    companionEnabled: draft.companionEnabled === true,
    letterTicketEnabled: draft.letterTicketEnabled === true,
    id: 'candidate',
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const duration = Math.max(30 * 60 * 1000, (draft.endAt ?? draft.startAt + 30 * 60 * 1000) - draft.startAt);
  for (const startAt of occurrenceTimes(candidate)) {
    const row = await database.getFirstAsync<{ id: string }>(
      `SELECT o.id FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
       WHERE i.status = 'pending' AND o.status = 'pending' AND i.id != ?
       AND (COALESCE(i.owner, 'you') = ? OR i.owner = 'I 和 you' OR ? = 'I 和 you')
       AND o.scheduled_start_at < ?
       AND o.scheduled_start_at + CASE WHEN i.end_at IS NULL THEN ? ELSE i.end_at - i.start_at END > ?
       LIMIT 1`,
      excludedItemId ?? '',
      draft.owner ?? 'you',
      draft.owner ?? 'you',
      startAt + duration,
      30 * 60 * 1000,
      startAt,
    );
    if (row) return true;
  }
  return false;
}

async function takeFutureNotificationIds(itemId: string, connection?: SQLite.SQLiteDatabase, now?: number) {
  const database = connection ?? await getDatabase();
  const rows = await database.getAllAsync<{ notification_id: string | null }>(
    'SELECT notification_id FROM schedule_occurrences WHERE item_id = ? AND reminder_at > ?',
    itemId,
    now ?? Date.now(),
  );
  return rows.map((row) => row.notification_id).filter((id): id is string => !!id);
}

export async function updateScheduleItem(itemId: string, draft: ScheduleDraft) {
  const database = await getDatabase();
  let result!: { item: ScheduleItem | null; notificationIds: string[] };
  // Business rows and their captured sync changes commit or roll back together.
  await database.withExclusiveTransactionAsync(async transaction => {
    const prior = await loadItem(itemId, transaction);
    // Legacy editors omit the new metadata; omission must never unlink an existing activity.
    draft = { ...draft, owner: draft.owner ?? prior?.owner ?? 'you',
      readingId: draft.readingId === undefined ? prior?.readingId : draft.readingId,
      execution: draft.execution === undefined ? prior?.execution : draft.execution,
      habitId: draft.habitId === undefined ? prior?.habitId : draft.habitId,
      habitAnchorKey: draft.habitAnchorKey === undefined ? prior?.habitAnchorKey : draft.habitAnchorKey,
      todoId: draft.todoId === undefined ? prior?.todoId : draft.todoId,
      goalId: draft.goalId === undefined ? prior?.goalId : draft.goalId,
      planId: draft.planId === undefined ? prior?.planId : draft.planId,
      startReminderEnabled: draft.startReminderEnabled ?? prior?.startReminderEnabled,
      endMode: draft.endMode ?? prior?.endMode, durationMinutes: draft.durationMinutes ?? prior?.durationMinutes,
      habitCompletionKey: draft.habitCompletionKey ?? prior?.habitCompletionKey };
    const now = Date.now();
    const notificationIds = await takeFutureNotificationIds(itemId, transaction, now);
    const retainCompletion = prior?.owner !== 'I' && prior?.source !== 'habit' && !prior?.habitId;
    const itemStatus = retainCompletion && prior?.status === 'completed'
      && prior.recurrence === 'none' && normalizeRecurrence(draft.recurrence) === 'none'
      && prior.startAt === draft.startAt ? 'completed' : 'pending';
    if (prior && (prior.startAt !== draft.startAt || prior.endAt !== draft.endAt
      || prior.readingId !== draft.readingId || prior.title !== draft.title || prior.habitId !== draft.habitId)) {
      draft.execution = adjustedScheduleExecution(prior, `schedule-edit:${itemId}:${now}`, now, 'reschedule');
    }
    await transaction.runAsync(
      `UPDATE schedule_items SET title = ?, notes = ?, start_at = ?, end_at = ?, reminder_minutes_before = ?,
        recurrence = ?, recurrence_rule = ?, range_end_at = ?, reminder_text = ?, reminder_intensity = ?, source = ?, habit_id = ?, habit_anchor_key = ?, todo_id = ?, goal_id = ?, plan_id = ?, companion_enabled = ?, letter_ticket_enabled = ?, status = ?, owner = ?, reading_id = ?, execution_json = ?, start_reminder_enabled = ?, end_mode = ?, duration_minutes = ?, habit_completion_key = ?, updated_at = ? WHERE id = ?`,
      draft.title.trim(),
      draft.notes.trim(),
      draft.startAt,
      draft.endAt ?? null,
      draft.reminderMinutesBefore,
      normalizeRecurrence(draft.recurrence),
      serializeRecurrenceRule({
        startAt: draft.startAt,
        recurrence: normalizeRecurrence(draft.recurrence),
        recurrenceRule: draft.recurrenceRule ?? buildRecurrenceRule(normalizeRecurrence(draft.recurrence), draft.startAt),
      }),
      draft.rangeEndAt ?? null,
      draft.reminderText.trim(),
      draft.reminderIntensity,
      draft.source,
      draft.habitId ?? null,
      draft.habitAnchorKey ?? null,
      draft.todoId ?? null,
      draft.goalId ?? null,
      draft.planId ?? null,
      draft.companionEnabled ? 1 : 0,
      draft.letterTicketEnabled ? 1 : 0,
      itemStatus,
      draft.owner ?? 'you',
      draft.readingId ?? null,
      draft.execution ? JSON.stringify(draft.execution) : null,
      draft.startReminderEnabled === undefined ? null : draft.startReminderEnabled ? 1 : 0,
      draft.endMode ?? null, draft.durationMinutes ?? null, draft.habitCompletionKey ?? null,
      now,
      itemId,
    );
    const retainedOccurrences = await transaction.getAllAsync<Pick<OccurrenceRow, 'id' | 'status' | 'completed_at' | 'completion_round'>>(
      'SELECT id, status, completed_at, completion_round FROM schedule_occurrences WHERE item_id = ? AND reminder_at > ?',
      itemId, now,
    );
    await transaction.runAsync('DELETE FROM schedule_occurrences WHERE item_id = ? AND reminder_at > ?', itemId, now);
    const item = await loadItem(itemId, transaction);
    if (item) await ensureItemOccurrences(itemStatus === 'completed' ? { ...item, status: 'pending' } : item,
      new Map(retainedOccurrences.map(row => [row.id, retainCompletion && row.status !== 'cancelled'
        ? row : { ...row, status: 'pending' as const, completed_at: null }])), transaction);
    result = { item, notificationIds };
  });
  requestScheduleNotificationRefresh();
  return result;
}

export async function cancelScheduleItem(itemId: string) {
  const database = await getDatabase();
  const notificationIds = await takeFutureNotificationIds(itemId);
  const prior = await loadItem(itemId), now = Date.now();
  const execution = prior && prior.status !== 'cancelled'
    ? adjustedScheduleExecution(prior, `schedule-cancel:${itemId}:${now}`, now, 'cancel') : prior?.execution;
  await database.runAsync("UPDATE schedule_items SET status = 'cancelled', execution_json = ?, updated_at = ? WHERE id = ?",
    execution ? JSON.stringify(execution) : null, now, itemId);
  await database.runAsync("UPDATE schedule_occurrences SET status = 'cancelled' WHERE item_id = ? AND status = 'pending'", itemId);
  requestScheduleNotificationRefresh();
  return notificationIds;
}

export async function cancelScheduleOccurrence(occurrenceId: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ notification_id: string | null }>(
    'SELECT notification_id FROM schedule_occurrences WHERE id = ?',
    occurrenceId,
  );
  await database.runAsync(
    "UPDATE schedule_occurrences SET status = 'cancelled', notification_id = NULL WHERE id = ?",
    occurrenceId,
  );
  requestScheduleNotificationRefresh();
  return row?.notification_id ? [row.notification_id] : [];
}
export async function deleteScheduleItem(itemId: string) {
  const database = await getDatabase();
  const notificationIds = await takeFutureNotificationIds(itemId);
  await database.runAsync('DELETE FROM schedule_occurrences WHERE item_id = ?', itemId);
  await database.runAsync('DELETE FROM schedule_items WHERE id = ?', itemId);
  requestScheduleNotificationRefresh();
  return notificationIds;
}

export async function loadScheduleItemsForDate(date: Date, includeCompleted = false, readOnly = false) {
  if (!readOnly) await ensureScheduleHorizon();
  const database = await getDatabase();
  const start = startOfDay(date.getTime());
  const end = start + DAY_MS;
  const occurrenceStatusClause = includeCompleted ? "o.status IN ('pending', 'completed')" : "o.status = 'pending'";
  const itemStatusClause = includeCompleted ? "i.status IN ('pending', 'completed')" : "i.status = 'pending'";
  const rows = await database.getAllAsync<OccurrenceRow>(
    `SELECT o.*, i.title, i.notes, i.start_at AS item_start_at, i.end_at AS item_end_at, i.reminder_minutes_before, i.recurrence, i.range_end_at, i.reminder_text, i.reminder_intensity, i.source, i.owner, i.reading_id, i.execution_json, i.habit_id, i.habit_anchor_key, i.todo_id, i.goal_id, i.plan_id, i.companion_enabled, i.letter_ticket_enabled, i.start_reminder_enabled, i.end_mode, i.duration_minutes, i.habit_completion_key
     FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
     WHERE o.scheduled_start_at >= ? AND o.scheduled_start_at < ? AND ${itemStatusClause} AND ${occurrenceStatusClause}
     ORDER BY o.scheduled_start_at ASC`,
    start,
    end,
  );
  return rows.map(fromOccurrenceRow);
}

export async function loadScheduleOccurrence(occurrenceId: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<OccurrenceRow>(
    `SELECT o.*, i.title, i.notes, i.start_at AS item_start_at, i.end_at AS item_end_at, i.reminder_minutes_before, i.recurrence, i.range_end_at, i.reminder_text, i.reminder_intensity, i.source, i.owner, i.reading_id, i.execution_json, i.habit_id, i.habit_anchor_key, i.todo_id, i.goal_id, i.plan_id, i.companion_enabled, i.letter_ticket_enabled, i.start_reminder_enabled, i.end_mode, i.duration_minutes, i.habit_completion_key
     FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
     WHERE o.id = ?
     LIMIT 1`,
    occurrenceId,
  );
  return row ? fromOccurrenceRow(row) : null;
}

export async function moveScheduleOccurrenceToQuadrant(occurrenceId: string, quadrantTitle: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ item_id: string; notes: string }>(
    `SELECT o.item_id, i.notes
     FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
     WHERE o.id = ?`,
    occurrenceId,
  );
  if (!row) return false;
  const quadrantLine = `象限：${quadrantTitle}`;
  const notes = /^象限：.*$/m.test(row.notes)
    ? row.notes.replace(/^象限：.*$/m, quadrantLine)
    : [row.notes.trim(), quadrantLine].filter(Boolean).join('\n');
  const result = await database.runAsync(
    'UPDATE schedule_items SET notes = ?, updated_at = ? WHERE id = ?',
    notes,
    Date.now(),
    row.item_id,
  );
  return result.changes > 0;
}

export async function loadDatesWithSchedules(startAt: number, endAt: number) {
  await ensureScheduleHorizon();
  const database = await getDatabase();
  const rows = await database.getAllAsync<{ scheduled_start_at: number }>(
    `SELECT DISTINCT o.scheduled_start_at FROM schedule_occurrences o
     JOIN schedule_items i ON i.id = o.item_id
     WHERE o.scheduled_start_at >= ? AND o.scheduled_start_at < ? AND i.status = 'pending' AND o.status = 'pending'`,
    startAt,
    endAt,
  );
  return [...new Set(rows.map((row) => dateKey(row.scheduled_start_at)))];
}

export async function loadPendingNotificationOccurrences() {
  await ensureScheduleHorizon();
  const database = await getDatabase();
  const rows = await database.getAllAsync<OccurrenceRow>(
    `SELECT o.*, i.title, i.notes, i.start_at AS item_start_at, i.end_at AS item_end_at, i.reminder_minutes_before, i.recurrence, i.range_end_at, i.reminder_text, i.reminder_intensity, i.source, i.owner, i.reading_id, i.execution_json, i.habit_id, i.habit_anchor_key, i.todo_id, i.goal_id, i.plan_id, i.companion_enabled, i.letter_ticket_enabled, i.start_reminder_enabled, i.end_mode, i.duration_minutes, i.habit_completion_key
     FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
     WHERE o.status = 'pending' AND o.reminder_at > ? AND o.notification_id IS NULL AND i.status = 'pending' AND i.companion_enabled = 0 AND i.owner != 'I'
     ORDER BY o.reminder_at ASC`,
    Date.now(),
  );
  return rows.map(fromOccurrenceRow);
}

export async function takeRetiredScheduleOccurrenceNotificationIds() {
  const database = await getDatabase();
  const rows = await database.getAllAsync<{ id: string; notification_id: string }>(
    `SELECT o.id, o.notification_id
     FROM schedule_occurrences o
     JOIN schedule_items i ON i.id = o.item_id
     WHERE o.notification_id IS NOT NULL`,
  );
  if (!rows.length) return [] as string[];
  await database.runAsync(
    `UPDATE schedule_occurrences
     SET notification_id = NULL
     WHERE id IN (${rows.map(() => '?').join(',')})`,
    ...rows.map((row) => row.id),
  );
  return rows.map((row) => row.notification_id);
}

export async function saveOccurrenceNotificationId(occurrenceId: string, notificationId: string) {
  const database = await getDatabase();
  await database.runAsync('UPDATE schedule_occurrences SET notification_id = ? WHERE id = ?', notificationId, occurrenceId);
}

export async function resetScheduleOccurrenceNotificationBindings() {
  const database = await getDatabase();
  const result = await database.runAsync(
    'UPDATE schedule_occurrences SET notification_id = NULL WHERE notification_id IS NOT NULL',
  );
  return result.changes;
}

export async function loadUndeliveredDueOccurrences(since: number) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<OccurrenceRow>(
    `SELECT o.*, i.title, i.notes, i.start_at AS item_start_at, i.end_at AS item_end_at, i.reminder_minutes_before, i.recurrence, i.range_end_at, i.reminder_text, i.reminder_intensity, i.source, i.owner, i.reading_id, i.execution_json, i.habit_id, i.habit_anchor_key, i.todo_id, i.goal_id, i.plan_id, i.companion_enabled, i.letter_ticket_enabled, i.start_reminder_enabled, i.end_mode, i.duration_minutes, i.habit_completion_key
     FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
     WHERE o.reminder_at <= ? AND o.reminder_at >= ? AND o.chat_delivered_at IS NULL AND i.status = 'pending' AND o.status = 'pending' AND i.companion_enabled = 0 AND i.owner != 'I'
     ORDER BY o.reminder_at ASC`,
    Date.now(),
    since,
  );
  return rows.map(fromOccurrenceRow);
}

export async function loadUpcomingUndeliveredOccurrences(startAt: number, endAt: number, readOnly = false) {
  if (!readOnly) await ensureScheduleHorizon();
  const database = await getDatabase();
  const rows = await database.getAllAsync<OccurrenceRow>(
    `SELECT o.*, i.title, i.notes, i.start_at AS item_start_at, i.end_at AS item_end_at, i.reminder_minutes_before, i.recurrence, i.range_end_at, i.reminder_text, i.reminder_intensity, i.source, i.owner, i.reading_id, i.execution_json, i.habit_id, i.habit_anchor_key, i.todo_id, i.goal_id, i.plan_id, i.companion_enabled, i.letter_ticket_enabled, i.start_reminder_enabled, i.end_mode, i.duration_minutes, i.habit_completion_key
     FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
     WHERE o.reminder_at > ? AND o.reminder_at <= ? AND o.chat_delivered_at IS NULL AND i.status = 'pending' AND o.status = 'pending' AND i.companion_enabled = 0 AND i.owner != 'I'
     ORDER BY o.reminder_at ASC`,
    startAt,
    endAt,
  );
  return rows.map(fromOccurrenceRow);
}

export async function markOccurrenceDelivered(occurrenceId: string) {
  const database = await getDatabase();
  await database.runAsync('UPDATE schedule_occurrences SET chat_delivered_at = ? WHERE id = ?', Date.now(), occurrenceId);
}

export async function completeOccurrenceOnce(occurrenceId: string, actualCompletedAt?: number, expectedCompletionRound?: number) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ item_id: string; notification_id: string | null; status: ScheduleOccurrenceStatus; completion_round: number }>(
    'SELECT item_id, notification_id, status, completion_round FROM schedule_occurrences WHERE id = ?',
    occurrenceId,
  );
  if (row && expectedCompletionRound !== undefined && row.completion_round !== expectedCompletionRound) throw new Error('schedule-completion-source-changed');
  if (!row || row.status !== 'pending') return { changed: false, notificationIds: [] as string[] };
  const completedAt = actualCompletedAt ?? Date.now();
  if (!Number.isSafeInteger(completedAt) || completedAt < 0 || completedAt > Date.now()) throw new Error('schedule-completion-time-invalid');
  const result = await database.runAsync(
    "UPDATE schedule_occurrences SET status = 'completed', completed_at = ?, notification_id = NULL WHERE id = ? AND status = 'pending' AND completion_round = ?",
    completedAt,
    occurrenceId,
    row.completion_round,
  );
  let companionNotificationIds: string[] = [];
  if (result.changes) {
    requestScheduleNotificationRefresh();
    try {
      const { closeScheduleCompanionOccurrence } = await import('./scheduleCompanionStore');
      companionNotificationIds = await closeScheduleCompanionOccurrence(occurrenceId);
    } catch {
      companionNotificationIds = [];
    }
    await database.runAsync(
      `UPDATE schedule_items SET status = 'completed', updated_at = ?
       WHERE id = ? AND recurrence = 'none' AND EXISTS
         (SELECT 1 FROM schedule_occurrences WHERE id = ? AND status = 'completed' AND completion_round = ?)`,
      Date.now(),
      row.item_id,
      occurrenceId,
      row.completion_round,
    );
    const occurrence = await loadScheduleOccurrence(occurrenceId);
    let linkedGoalId = occurrence?.goalId;
    if (occurrence?.todoId) {
      const { completeTodoItem, loadTodoItemById } = await import('./todoStore');
      const linkedTodo = await loadTodoItemById(occurrence.todoId);
      linkedGoalId = linkedGoalId ?? linkedTodo?.goalId;
      await completeTodoItem(occurrence.todoId, { skipTimeBasedGoalCredit: true, completedAt });
    }
    if (occurrence && linkedGoalId) {
      const { loadGoal } = await import('./goalStore');
      const goal = await loadGoal(linkedGoalId);
      if (goal?.goalType === 'time_based') {
        const {
          cancelGoalTimeCreditForTodo,
          recordGoalProgressEvent,
          removeGoalProgressEvent,
        } = await import('./goalProgressStore');
        if (occurrence.todoId) {
          await removeGoalProgressEvent(linkedGoalId, 'todo-time-credit', occurrence.todoId);
          await cancelGoalTimeCreditForTodo(occurrence.todoId);
        }
        await recordGoalProgressEvent({
          goalId: linkedGoalId,
          kind: 'schedule-completion',
          sourceId: occurrence.id,
          amount: Math.max(1, Math.round(((occurrence.endAt ?? occurrence.scheduledStartAt) - occurrence.scheduledStartAt) / 60000)),
        });
      }
    }
    if (occurrence && !occurrence.todoId) {
      try {
        const { createMemoryFromOccurrenceCompletion } = await import('./scheduleMemoryBridge');
        await createMemoryFromOccurrenceCompletion(occurrence);
      } catch {
        // Memory creation is best-effort and never rolls back completion.
      }
    }
    try {
      const { recordBaiyunScheduleCompletionReceipt } = await import(
        '../ai/behavior/actionExecutionRuntime'
      );
      await recordBaiyunScheduleCompletionReceipt({
        targetKind: 'schedule_occurrence',
        targetId: occurrenceId,
        occurredAt: completedAt,
      });
    } catch {
      // The deterministic reconciler can retry continuity projection later.
    }
  }
  return {
    changed: result.changes > 0,
    notificationIds: result.changes ? [
      row.notification_id ?? createScheduleOccurrenceNotificationId(occurrenceId),
      ...companionNotificationIds,
    ] : [],
  };
}

export async function applyOccurrenceCompletionReceipt(
  occurrenceId: string,
  completedAt: number,
  expectedCompletionRound?: number,
) {
  if (!Number.isSafeInteger(completedAt) || completedAt < 0) {
    throw new Error('schedule-completion-receipt-time-invalid');
  }
  const database = await getDatabase();
  const row = await database.getFirstAsync<{
    item_id: string;
    notification_id: string | null;
    recurrence: ScheduleRecurrence;
    status: ScheduleOccurrenceStatus;
    completion_round: number;
  }>(
    `SELECT o.item_id, o.notification_id, o.status, o.completion_round, i.recurrence
     FROM schedule_occurrences o
     JOIN schedule_items i ON i.id = o.item_id
     WHERE o.id = ?`,
    occurrenceId,
  );
  if (!row) return { changed: false, notificationIds: [] as string[] };
  if (expectedCompletionRound !== undefined && row.completion_round !== expectedCompletionRound) throw new Error('schedule-completion-source-changed');
  if (row.status === 'cancelled') {
    throw new Error('schedule-occurrence-terminal-conflict');
  }
  const result = row.status === 'pending'
    ? await database.runAsync(
        "UPDATE schedule_occurrences SET status = 'completed', completed_at = ?, notification_id = NULL WHERE id = ? AND status = 'pending' AND completion_round = ?",
        completedAt,
        occurrenceId,
        row.completion_round,
      )
    : { changes: 0 };
  if (!result.changes && row.status === 'pending') return { changed: false, notificationIds: [] as string[] };
  if (result.changes && row.recurrence === 'none') {
    await database.runAsync(
      `UPDATE schedule_items SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'pending'
       AND EXISTS (SELECT 1 FROM schedule_occurrences WHERE id = ? AND status = 'completed' AND completion_round = ?)`,
      completedAt,
      row.item_id,
      occurrenceId,
      row.completion_round,
    );
  }
  let companionNotificationIds: string[] = [];
  try {
    const { closeScheduleCompanionOccurrence } = await import('./scheduleCompanionStore');
    companionNotificationIds = await closeScheduleCompanionOccurrence(occurrenceId);
  } catch {
    companionNotificationIds = [];
  }
  return {
    changed: result.changes > 0,
    notificationIds: [
      row.notification_id ?? createScheduleOccurrenceNotificationId(occurrenceId),
      ...companionNotificationIds,
    ],
  };
}

export async function completeOccurrence(occurrenceId: string) {
  return (await completeOccurrenceOnce(occurrenceId)).notificationIds;
}

export async function reopenScheduleOccurrence(occurrenceId: string) {
  const database = await getDatabase();
  const occurrence = await loadScheduleOccurrence(occurrenceId);
  if (!occurrence || occurrence.status !== 'completed') return { changed: false, occurrence };
  const reopenedAt = Date.now();
  const result = await database.runAsync(
    "UPDATE schedule_occurrences SET status = 'pending', completed_at = NULL, completion_round = completion_round + 1 WHERE id = ? AND status = 'completed' AND completion_round = ?",
    occurrenceId,
    occurrence.completionRound ?? 0,
  );
  if (!result.changes) return { changed: false, occurrence: await loadScheduleOccurrence(occurrenceId) };
  if (occurrence.recurrence === 'none') {
    await database.runAsync(`UPDATE schedule_items SET status = 'pending', updated_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM schedule_occurrences WHERE id = ? AND status = 'pending' AND completion_round = ?)`,
      Date.now(), occurrence.itemId, occurrenceId, (occurrence.completionRound ?? 0) + 1);
  }
  let linkedGoalId = occurrence.goalId;
  if (occurrence.todoId) {
    const { loadTodoItemById, reopenTodoItem } = await import('./todoStore');
    linkedGoalId = linkedGoalId ?? (await loadTodoItemById(occurrence.todoId))?.goalId;
    await reopenTodoItem(occurrence.todoId);
  }
  if (linkedGoalId) {
    const { removeGoalProgressEvent } = await import('./goalProgressStore');
    await removeGoalProgressEvent(linkedGoalId, 'schedule-completion', occurrence.id);
  }
  if (occurrence.habitId) {
    const { advanceHabitLogProgress } = await import('./habitStore');
    await advanceHabitLogProgress(occurrence.habitId, dateKey(occurrence.scheduledStartAt), -1);
  }
  try {
    const { reopenBaiyunScheduleContinuity } = await import(
      '../ai/behavior/actionExecutionRuntime'
    );
    await reopenBaiyunScheduleContinuity({
      targetKind: 'schedule_occurrence',
      targetId: occurrenceId,
      reopenRevision: reopenedAt,
      occurredAt: reopenedAt,
    });
  } catch {
    // Reopening the occurrence remains authoritative; continuity can reconcile later.
  }
  return { changed: true, occurrence: await loadScheduleOccurrence(occurrenceId) };
}

export async function hasCompletedScheduleOccurrenceForTodo(todoId: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ id: string }>(
    `SELECT o.id FROM schedule_occurrences o
     JOIN schedule_items i ON i.id = o.item_id
     WHERE i.todo_id = ? AND o.status = 'completed' LIMIT 1`,
    todoId,
  );
  return !!row;
}

export async function snoozeOccurrence(occurrenceId: string, minutes = 10) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ notification_id: string | null }>(
    'SELECT notification_id FROM schedule_occurrences WHERE id = ?',
    occurrenceId,
  );
  await database.runAsync(
    "UPDATE schedule_occurrences SET reminder_at = ?, notification_id = NULL, status = 'pending' WHERE id = ?",
    Date.now() + minutes * 60 * 1000,
    occurrenceId,
  );
  return row?.notification_id ? [row.notification_id] : [];
}

function dateAtClock(day: string, source: number) {
  const date = new Date(`${day}T12:00:00`);
  const clock = new Date(source);
  date.setHours(clock.getHours(), clock.getMinutes(), clock.getSeconds(), clock.getMilliseconds());
  return date.getTime();
}

async function targetDateForPostpone(target: PostponeTarget) {
  if (target.kind === 'specific_date') return target.date;
  if (target.kind === 'next_week') return nextMondayKey();
  if (target.kind === 'tomorrow') {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    return dateKey(date);
  }
  const { loadGoal } = await import('./goalStore');
  const goal = await loadGoal(target.goalId);
  if (!goal?.targetDate) return undefined;
  const date = new Date(`${goal.targetDate}T12:00:00`);
  date.setDate(date.getDate() + 1);
  return dateKey(date);
}

export async function postponeScheduleOccurrence(occurrenceId: string, target: PostponeTarget) {
  const occurrence = await loadScheduleOccurrence(occurrenceId);
  if (!occurrence || occurrence.status !== 'pending') return { ok: false as const, notificationIds: [] as string[] };
  const item = await loadItem(occurrence.itemId);
  if (!item) return { ok: false as const, notificationIds: [] as string[] };
  const targetDate = await targetDateForPostpone(target);
  if (!targetDate) return { ok: false as const, notificationIds: [] as string[] };
  const startAt = dateAtClock(targetDate, occurrence.scheduledStartAt);
  const duration = Math.max(0, (occurrence.endAt ?? occurrence.scheduledStartAt) - occurrence.scheduledStartAt);
  const draft: ScheduleDraft = {
    owner: item.owner, readingId: item.readingId, execution: item.execution,
    title: item.title,
    notes: item.notes,
    startAt,
    endAt: item.endAt ? startAt + duration : undefined,
    reminderMinutesBefore: item.reminderMinutesBefore,
    recurrence: item.recurrence,
    recurrenceRule: item.recurrenceRule,
    rangeEndAt: item.rangeEndAt ? dateAtClock(targetDate, item.rangeEndAt) : undefined,
    reminderText: item.reminderText,
    reminderIntensity: item.reminderIntensity,
    source: item.source,
    habitId: item.habitId,
    habitAnchorKey: item.habitAnchorKey,
    todoId: item.todoId,
    goalId: item.goalId,
    planId: item.planId,
    companionEnabled: item.companionEnabled,
    letterTicketEnabled: item.letterTicketEnabled,
  };
  if (await hasScheduleConflict({ ...draft, recurrence: 'none', recurrenceRule: undefined, rangeEndAt: undefined }, item.id)) {
    return { ok: false as const, reason: 'conflict' as const, notificationIds: [] as string[] };
  }
  let notificationIds: string[] = [];
  const originalDraft: ScheduleDraft = {
    owner: item.owner, readingId: item.readingId, execution: item.execution,
    title: item.title,
    notes: item.notes,
    startAt: item.startAt,
    endAt: item.endAt,
    reminderMinutesBefore: item.reminderMinutesBefore,
    recurrence: item.recurrence,
    recurrenceRule: item.recurrenceRule,
    rangeEndAt: item.rangeEndAt,
    reminderText: item.reminderText,
    reminderIntensity: item.reminderIntensity,
    source: item.source,
    habitId: item.habitId,
    habitAnchorKey: item.habitAnchorKey,
    todoId: item.todoId,
    goalId: item.goalId,
    planId: item.planId,
    companionEnabled: item.companionEnabled,
    letterTicketEnabled: item.letterTicketEnabled,
  };
  if (item.recurrence === 'none') {
    const result = await updateScheduleItem(item.id, draft);
    notificationIds = result.notificationIds;
  } else {
    const database = await getDatabase();
    const row = await database.getFirstAsync<{ notification_id: string | null }>('SELECT notification_id FROM schedule_occurrences WHERE id = ?', occurrenceId);
    await database.runAsync(
      'UPDATE schedule_occurrences SET scheduled_start_at = ?, end_at = ?, reminder_at = ?, notification_id = NULL WHERE id = ? AND status = ?',
      startAt,
      occurrence.endAt ? startAt + duration : null,
      startAt - item.reminderMinutesBefore * 60 * 1000,
      occurrenceId,
      'pending',
    );
    if (row?.notification_id) notificationIds.push(row.notification_id);
  }
  if (occurrence.todoId) {
    const { postponeTodoItem } = await import('./todoStore');
    const movedTodo = await postponeTodoItem(occurrence.todoId, target);
    if (!movedTodo) {
      if (item.recurrence === 'none') {
        await updateScheduleItem(item.id, originalDraft);
      } else {
        const database = await getDatabase();
        await database.runAsync(
          'UPDATE schedule_occurrences SET scheduled_start_at = ?, end_at = ?, reminder_at = ?, notification_id = NULL WHERE id = ?',
          occurrence.scheduledStartAt,
          occurrence.endAt ?? null,
          occurrence.reminderAt,
          occurrenceId,
        );
      }
      return { ok: false as const, reason: 'linked-todo' as const, notificationIds };
    }
  }
  return { ok: true as const, notificationIds, targetDate };
}

export async function postponeScheduleOccurrenceToTomorrow(occurrenceId: string) {
  return postponeScheduleOccurrence(occurrenceId, { kind: 'tomorrow' });
}

export async function loadScheduleItemsBetween(startAt: number, endAt: number) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<ItemRow>(
    "SELECT * FROM schedule_items WHERE status = 'pending' AND start_at < ? ORDER BY start_at ASC",
    endAt,
  );
  return rows.map(fromItemRow).filter((item) => item.recurrence !== 'none' || item.startAt >= startAt);
}

export async function loadScheduleItemsByHabitId(habitId: string) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<ItemRow>(
    'SELECT * FROM schedule_items WHERE habit_id = ? ORDER BY created_at ASC',
    habitId,
  );
  return rows.map(fromItemRow);
}

export async function loadHabitOccurrencesForDate(habitId: string, day: string) {
  const occurrences = await loadScheduleItemsForDate(new Date(`${day}T12:00:00`));
  return occurrences.filter((occurrence) => occurrence.habitId === habitId);
}

export async function loadReminderOccurrencesBetween(startAt: number, endAt: number) {
  await ensureScheduleHorizon();
  const database = await getDatabase();
  const rows = await database.getAllAsync<OccurrenceRow>(
    `SELECT o.*, i.title, i.notes, i.start_at AS item_start_at, i.end_at AS item_end_at, i.reminder_minutes_before, i.recurrence, i.range_end_at, i.reminder_text, i.reminder_intensity, i.source, i.owner, i.reading_id, i.execution_json, i.habit_id, i.habit_anchor_key, i.todo_id, i.goal_id, i.plan_id, i.companion_enabled, i.letter_ticket_enabled, i.start_reminder_enabled, i.end_mode, i.duration_minutes, i.habit_completion_key
     FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
     WHERE o.scheduled_start_at >= ? AND o.scheduled_start_at < ?
       AND o.status = 'pending' AND i.status = 'pending' AND i.owner != 'I'
     ORDER BY o.scheduled_start_at ASC`,
    startAt,
    endAt,
  );
  return rows.map(fromOccurrenceRow);
}

export async function loadPendingScheduleOccurrencesBetween(startAt: number, endAt: number, readOnly = false) {
  if (!readOnly) await ensureScheduleHorizon();
  const database = await getDatabase();
  const rows = await database.getAllAsync<OccurrenceRow>(
    `SELECT o.*, i.title, i.notes, i.start_at AS item_start_at, i.end_at AS item_end_at, i.reminder_minutes_before, i.recurrence, i.range_end_at, i.reminder_text, i.reminder_intensity, i.source, i.owner, i.reading_id, i.execution_json, i.habit_id, i.habit_anchor_key, i.todo_id, i.goal_id, i.plan_id, i.companion_enabled, i.letter_ticket_enabled, i.start_reminder_enabled, i.end_mode, i.duration_minutes, i.habit_completion_key
     FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
     WHERE o.scheduled_start_at >= ? AND o.scheduled_start_at < ? AND o.status = 'pending' AND i.status = 'pending'
     ORDER BY o.scheduled_start_at ASC`,
    startAt,
    endAt,
  );
  return rows.map(fromOccurrenceRow);
}

export async function loadLetterTicketOccurrencesBetween(startAt: number, endAt: number) {
  await ensureScheduleHorizon();
  const database = await getDatabase();
  const rows = await database.getAllAsync<OccurrenceRow>(
    `SELECT o.*, i.title, i.notes, i.start_at AS item_start_at, i.end_at AS item_end_at, i.reminder_minutes_before, i.recurrence, i.range_end_at, i.reminder_text, i.reminder_intensity, i.source, i.owner, i.reading_id, i.execution_json, i.habit_id, i.habit_anchor_key, i.todo_id, i.goal_id, i.plan_id, i.companion_enabled, i.letter_ticket_enabled, i.start_reminder_enabled, i.end_mode, i.duration_minutes, i.habit_completion_key
     FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
     WHERE o.scheduled_start_at >= ? AND o.scheduled_start_at < ?
       AND o.status = 'pending' AND i.status = 'pending' AND i.letter_ticket_enabled = 1 AND i.owner != 'I'
     ORDER BY o.scheduled_start_at ASC`,
    startAt,
    endAt,
  );
  return rows.map(fromOccurrenceRow);
}
export async function loadScheduleCompletionsForDate(day: string) {
  const database = await getDatabase();
  const start = new Date(`${day}T00:00:00`).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  const rows = await database.getAllAsync<OccurrenceRow>(
    `SELECT o.*, i.title, i.notes, i.start_at AS item_start_at, i.end_at AS item_end_at, i.reminder_minutes_before, i.recurrence, i.range_end_at, i.reminder_text, i.reminder_intensity, i.source, i.owner, i.reading_id, i.execution_json, i.habit_id, i.habit_anchor_key, i.todo_id, i.goal_id, i.plan_id, i.companion_enabled, i.letter_ticket_enabled, i.start_reminder_enabled, i.end_mode, i.duration_minutes, i.habit_completion_key
     FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
     WHERE o.status = 'completed' AND o.completed_at >= ? AND o.completed_at < ? ORDER BY o.completed_at ASC`,
    start,
    end,
  );
  return rows.map(fromOccurrenceRow);
}

export async function loadCompletedScheduleEffortForDate(day: string, completedAfter = 0) {
  const database = await getDatabase();
  const start = new Date(`${day}T00:00:00`).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  const rows = await database.getAllAsync<{
    occurrence_id: string;
    todo_id: string | null;
    start_at: number;
    end_at: number | null;
  }>(
    `SELECT o.id AS occurrence_id, i.todo_id, o.scheduled_start_at AS start_at, i.end_at
     FROM schedule_occurrences o
     INNER JOIN schedule_items i ON i.id = o.item_id
     WHERE o.status = 'completed' AND o.scheduled_start_at >= ? AND o.scheduled_start_at < ?
       AND COALESCE(o.completed_at, 0) >= ?`,
    start,
    end,
    completedAfter,
  );
  return rows.map((row) => ({
    occurrenceId: row.occurrence_id,
    todoId: row.todo_id ?? undefined,
    minutes: Math.max(1, Math.round(((row.end_at ?? row.start_at) - row.start_at) / 60000)),
  }));
}

export type ExtendScheduleSlotResult =
  | { ok: true; notificationIds: string[]; invalidatedOccurrenceIds: string[] }
  | { ok: false; reason: 'missing' | 'not-plan-slot' | 'cross-day' | 'conflict'; conflictTitle?: string };

export async function extendSchedulePlanSlot(occurrenceId: string, extraMinutes: number): Promise<ExtendScheduleSlotResult> {
  const occurrence = await loadScheduleOccurrence(occurrenceId);
  if (!occurrence?.endAt) return { ok: false, reason: 'missing' };
  if (!occurrence.planId || occurrence.source !== 'ai') return { ok: false, reason: 'not-plan-slot' };
  const database = await getDatabase();
  const extraMs = Math.max(5, Math.min(120, Math.round(extraMinutes))) * 60 * 1000;
  const planRows = await database.getAllAsync<ItemRow>(
    `SELECT * FROM schedule_items
     WHERE plan_id = ? AND source = 'ai' AND status = 'pending' AND recurrence = 'none' AND start_at >= ?
     ORDER BY start_at ASC`,
    occurrence.planId,
    occurrence.scheduledStartAt,
  );
  if (!planRows.length) return { ok: false, reason: 'missing' };
  const items = planRows.map(fromItemRow);
  const mutations = items.map((item, index) => ({
    item,
    startAt: index === 0 ? item.startAt : item.startAt + extraMs,
    endAt: item.endAt === undefined ? undefined : item.endAt + extraMs,
  }));
  const lastEnd = mutations[mutations.length - 1].endAt ?? mutations[mutations.length - 1].startAt;
  if (dateKey(lastEnd) !== dateKey(occurrence.scheduledStartAt)) return { ok: false, reason: 'cross-day' };
  const involvedIds = new Set(items.map((item) => item.id));
  for (const mutation of mutations) {
    const duration = Math.max(30 * 60 * 1000, (mutation.endAt ?? mutation.startAt + 30 * 60 * 1000) - mutation.startAt);
    const conflicts = await database.getAllAsync<{ item_id: string; title: string; owner: ScheduleOwner }>(
      `SELECT o.item_id, i.title, i.owner FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
       WHERE o.status = 'pending' AND i.status = 'pending'
         AND o.scheduled_start_at < ?
         AND o.scheduled_start_at + CASE WHEN i.end_at IS NULL THEN ? ELSE i.end_at - i.start_at END > ?`,
      mutation.startAt + duration,
      30 * 60 * 1000,
      mutation.startAt,
    );
    const conflict = conflicts.find((entry) => !involvedIds.has(entry.item_id) && scheduleOwnersOverlap(entry.owner, mutation.item.owner));
    if (conflict) return { ok: false, reason: 'conflict', conflictTitle: conflict.title };
  }
  const notificationIds = (await Promise.all(items.map((item) => takeFutureNotificationIds(item.id)))).flat();
  const invalidatedOccurrenceRows = await database.getAllAsync<{ id: string }>(
    `SELECT id FROM schedule_occurrences WHERE status = 'pending' AND item_id IN (${items.map(() => '?').join(',')})`,
    ...items.map((item) => item.id),
  );
  await database.withTransactionAsync(async () => {
    for (const mutation of mutations) {
      await database.runAsync(
        'UPDATE schedule_items SET start_at = ?, end_at = ?, updated_at = ? WHERE id = ?',
        mutation.startAt,
        mutation.endAt ?? null,
        Date.now(),
        mutation.item.id,
      );
      await database.runAsync('DELETE FROM schedule_occurrences WHERE item_id = ? AND status = ?', mutation.item.id, 'pending');
    }
  });
  for (const mutation of mutations) {
    const updated = await loadItem(mutation.item.id);
    if (updated) await ensureItemOccurrences(updated);
  }
  return { ok: true, notificationIds, invalidatedOccurrenceIds: invalidatedOccurrenceRows.map((row) => row.id) };
}
