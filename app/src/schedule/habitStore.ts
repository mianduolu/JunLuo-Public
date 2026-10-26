import { dateKey } from './scheduleStore';
import { getTodoDatabase as getDatabase } from './todoDatabase';
import { makeTodoNaturalRecordId } from './todoIdentity';
import type { TodoCategory } from './todoStore';
import { chatHabitFixedEndAt } from './chatHabitSchedulePolicy';

export type HabitFrequency = 'daily' | 'weekly' | 'custom' | 'interval';
export type HabitStatus = 'active' | 'archived';
export type HabitKind = 'habit' | 'daily-challenge';
export type HabitScheduleInstances = {
  enabled: boolean;
  reminderMinutesBefore: number;
  startAt?: number;
  ruleUpdatedAt?: number;
  durationMinutes?: number;
  endMode?: 'duration' | 'fixed';
  endAt?: number;
  startReminderEnabled?: boolean;
  companionEnabled?: boolean;
};

export type Habit = {
  id: string;
  owner?: 'I' | 'you';
  frequencyPeriod?: 'legacy' | 'day' | 'week' | 'weekdays';
  minutes?: number | null;
  title: string;
  notes?: string;
  intervalDays?: number;
  goalId?: string;
  category: TodoCategory;
  frequency: HabitFrequency;
  weekDays: number[];
  targetCount: number;
  reminderTimes: string[];
  streak: number;
  bestStreak: number;
  reminderTime?: string;
  kind: HabitKind;
  scheduleInstances: HabitScheduleInstances;
  status: HabitStatus;
  createdAt: number;
  updatedAt: number;
};

export type HabitLog = {
  id: string;
  completionActivityIds?: string[];
  habitId: string;
  dateKey: string;
  completed: boolean;
  completedCount: number;
  note: string;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type HabitDraft = {
  title: string;
  intervalDays?: number;
  goalId?: string;
  category?: TodoCategory;
  frequency?: HabitFrequency;
  weekDays?: number[];
  targetCount?: number;
  reminderTimes?: string[];
  reminderTime?: string;
  kind?: HabitKind;
  scheduleInstances?: Partial<HabitScheduleInstances>;
};

export type HabitForDate = Habit & {
  log?: HabitLog;
  completedToday: boolean;
};

export type HabitSummaryForDate = {
  dateKey: string;
  habits: HabitForDate[];
  completed: HabitForDate[];
  pending: HabitForDate[];
  done: number;
  total: number;
};

type HabitRow = {
  id: string;
  owner?: string;
  frequency_period?: string;
  minutes?: number | null;
  notes?: string | null;
  interval_days?: number | null;
  schedule_start_at?: number | null;
  schedule_rule_updated_at?: number | null;
  schedule_duration_minutes?: number | null;
  schedule_end_mode?: string | null;
  schedule_end_at?: number | null;
  schedule_start_reminder_enabled?: number | null;
  schedule_companion_enabled?: number | null;
  title: string;
  goal_id: string | null;
  category: string | null;
  frequency: string | null;
  week_days: string | null;
  streak: number | null;
  best_streak: number | null;
  reminder_time: string | null;
  target_count: number | null;
  reminder_times: string | null;
  kind: string | null;
  schedule_enabled: number | null;
  schedule_reminder_minutes_before: number | null;
  status: string | null;
  created_at: number;
  updated_at: number;
};

type HabitLogRow = {
  id: string;
  completion_activity_ids?: string;
  habit_id: string;
  date_key: string;
  completed: number | null;
  completed_count: number | null;
  note: string | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
};

const TODO_CATEGORIES: TodoCategory[] = ['study', 'work', 'health', 'life', 'social', 'leisure', 'creation', 'other'];
const FREQUENCIES: HabitFrequency[] = ['daily', 'weekly', 'custom', 'interval'];

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeCategory(value?: string | null): TodoCategory {
  return TODO_CATEGORIES.includes(value as TodoCategory) ? (value as TodoCategory) : 'other';
}

function normalizeFrequency(value?: string | null): HabitFrequency {
  return FREQUENCIES.includes(value as HabitFrequency) ? (value as HabitFrequency) : 'daily';
}

function normalizeWeekDays(value?: string | number[] | null): number[] {
  let raw: unknown = [];
  try {
    raw = Array.isArray(value)
      ? value
      : typeof value === 'string' && value.trim()
        ? JSON.parse(value) as unknown
        : [];
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw
    .map((day) => Math.round(Number(day)))
    .filter((day) => Number.isFinite(day) && day >= 1 && day <= 7))]
    .sort((a, b) => a - b);
}

function normalizeReminderTime(value?: string | null) {
  if (!value) return undefined;
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? value : undefined;
}

function normalizeTargetCount(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) return 1;
  return Math.max(1, Math.min(12, Math.round(value ?? 1)));
}

function normalizeHabitKind(value?: string | null): HabitKind {
  return value === 'daily-challenge' ? 'daily-challenge' : 'habit';
}

function normalizeReminderMinutes(value?: number | null) {
  return Number.isFinite(value ?? NaN) ? Math.max(0, Math.min(24 * 60, Math.round(value ?? 0))) : 10;
}

function normalizeReminderTimes(value?: string | string[] | null, fallback?: string | null): string[] {
  let raw: unknown = [];
  try {
    raw = Array.isArray(value)
      ? value
      : typeof value === 'string' && value.trim()
        ? JSON.parse(value) as unknown
        : [];
  } catch {
    raw = [];
  }
  const times = Array.isArray(raw)
    ? raw.map((item) => normalizeReminderTime(String(item))).filter((item): item is string => !!item)
    : [];
  const fallbackTime = normalizeReminderTime(fallback);
  return [...new Set(fallbackTime ? [fallbackTime, ...times] : times)].slice(0, 12);
}

function weekDayFromDateKey(day: string) {
  const date = new Date(`${day}T12:00:00`);
  return date.getDay() || 7;
}

function previousDateKey(day: string) {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() - 1);
  return dateKey(date);
}

function habitAppliesToDate(habit: Habit, day: string) {
  if (habit.status !== 'active') return false;
  if (habit.owner === 'I' && habit.frequencyPeriod === 'week') return true;
  if (habit.frequency === 'daily') return true;
  if (habit.frequency === 'interval') return false; // The saved pending occurrence, not weekday arithmetic, determines this date.
  const weekDays = habit.weekDays.length ? habit.weekDays : [weekDayFromDateKey(day)];
  return weekDays.includes(weekDayFromDateKey(day));
}

function fromHabitRow(row: HabitRow): Habit {
  return {
    id: row.id,
    owner: row.owner === 'I' ? 'I' : 'you',
    frequencyPeriod: ['day', 'week', 'weekdays'].includes(row.frequency_period ?? '')
      ? row.frequency_period as Habit['frequencyPeriod'] : 'legacy',
    minutes: row.minutes ?? null,
    title: row.title,
    ...(row.notes == null ? {} : { notes: row.notes }),
    ...(row.interval_days == null ? {} : { intervalDays: row.interval_days }),
    goalId: row.goal_id ?? undefined,
    category: normalizeCategory(row.category),
    frequency: normalizeFrequency(row.frequency),
    weekDays: normalizeWeekDays(row.week_days),
    targetCount: row.owner === 'I' ? Math.max(1, row.target_count ?? 1) : normalizeTargetCount(row.target_count),
    reminderTimes: normalizeReminderTimes(row.reminder_times, row.reminder_time),
    streak: Math.max(0, row.streak ?? 0),
    bestStreak: Math.max(0, row.best_streak ?? 0),
    reminderTime: normalizeReminderTime(row.reminder_time),
    kind: normalizeHabitKind(row.kind),
    scheduleInstances: {
      enabled: row.schedule_enabled === 1,
      reminderMinutesBefore: normalizeReminderMinutes(row.schedule_reminder_minutes_before),
      ...(row.schedule_start_at == null ? {} : { startAt: row.schedule_start_at }),
      ...(row.schedule_rule_updated_at == null ? {} : { ruleUpdatedAt: row.schedule_rule_updated_at }),
      ...(row.schedule_duration_minutes == null ? {} : { durationMinutes: row.schedule_duration_minutes }),
      ...(row.schedule_end_mode == null ? {} : { endMode: row.schedule_end_mode as 'duration' | 'fixed' }),
      ...(row.schedule_end_at == null ? {} : { endAt: row.schedule_end_at }),
      ...(row.schedule_start_reminder_enabled == null ? {} : { startReminderEnabled: row.schedule_start_reminder_enabled === 1 }),
      ...(row.schedule_companion_enabled == null ? {} : { companionEnabled: row.schedule_companion_enabled === 1 }),
    },
    status: row.status === 'archived' ? 'archived' : 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromLogRow(row: HabitLogRow): HabitLog {
  return {
    id: row.id,
    completionActivityIds: JSON.parse(row.completion_activity_ids ?? '[]') as string[],
    habitId: row.habit_id,
    dateKey: row.date_key,
    completed: row.completed === 1,
    completedCount: Math.max(0, row.completed_count && row.completed_count > 0 ? row.completed_count : row.completed === 1 ? 1 : 0),
    note: row.note ?? '',
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadHabitById(habitId: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<HabitRow>('SELECT * FROM habits WHERE id = ?', habitId);
  return row ? fromHabitRow(row) : null;
}

async function recomputeHabitStreak(habitId: string, referenceDay = dateKey(new Date())) {
  const database = await getDatabase();
  const habit = await loadHabitById(habitId);
  if (!habit) return;
  const logRows = await database.getAllAsync<HabitLogRow>(
    'SELECT * FROM habit_logs WHERE habit_id = ? ORDER BY date_key DESC',
    habitId,
  );
  const completedDays = new Set(
    logRows
      .map(fromLogRow)
      .filter((log) => log.completedCount >= habit.targetCount)
      .map((log) => log.dateKey),
  );
  let cursor = referenceDay;
  let streak = 0;
  for (let guard = 0; guard < 366; guard += 1) {
    if (habitAppliesToDate(habit, cursor)) {
      if (!completedDays.has(cursor)) break;
      streak += 1;
    }
    cursor = previousDateKey(cursor);
  }
  const bestStreak = Math.max(habit.bestStreak, streak);
  await database.runAsync(
    'UPDATE habits SET streak = ?, best_streak = ?, updated_at = ? WHERE id = ?',
    streak,
    bestStreak,
    Date.now(),
    habitId,
  );
}

export async function createHabit(draft: HabitDraft) {
  const database = await getDatabase();
  const now = Date.now();
  const frequency = normalizeFrequency(draft.frequency);
  const weekDays = frequency === 'daily'
    ? []
    : normalizeWeekDays(draft.weekDays).length
      ? normalizeWeekDays(draft.weekDays)
      : [weekDayFromDateKey(dateKey(new Date()))];
  const habit: Habit = {
    id: makeId('habit'),
    owner: 'you',
    frequencyPeriod: 'legacy',
    minutes: null,
    title: draft.title.trim().slice(0, 80),
    goalId: draft.goalId || undefined,
    category: normalizeCategory(draft.category),
    frequency,
    weekDays,
    targetCount: normalizeTargetCount(draft.targetCount),
    reminderTimes: normalizeReminderTimes(draft.reminderTimes, draft.reminderTime),
    streak: 0,
    bestStreak: 0,
    reminderTime: normalizeReminderTime(draft.reminderTime),
    kind: normalizeHabitKind(draft.kind),
    scheduleInstances: {
      enabled: draft.scheduleInstances?.enabled === true,
      reminderMinutesBefore: normalizeReminderMinutes(draft.scheduleInstances?.reminderMinutesBefore),
    },
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await database.runAsync(
    `INSERT INTO habits
      (id, title, goal_id, category, frequency, week_days, target_count, reminder_times, streak, best_streak, reminder_time, kind, schedule_enabled, schedule_reminder_minutes_before, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    habit.id,
    habit.title,
    habit.goalId ?? null,
    habit.category,
    habit.frequency,
    JSON.stringify(habit.weekDays),
    habit.targetCount,
    JSON.stringify(habit.reminderTimes),
    habit.streak,
    habit.bestStreak,
    habit.reminderTime ?? null,
    habit.kind,
    habit.scheduleInstances.enabled ? 1 : 0,
    habit.scheduleInstances.reminderMinutesBefore,
    habit.status,
    habit.createdAt,
    habit.updatedAt,
  );
  return habit;
}

export async function updateHabit(habitId: string, patch: Partial<HabitDraft>) {
  const database = await getDatabase();
  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  const add = (column: string, value: string | number | null) => {
    updates.push(`${column} = ?`);
    values.push(value);
  };
  if (patch.title !== undefined) add('title', patch.title.trim().slice(0, 80));
  if (patch.goalId !== undefined) add('goal_id', patch.goalId || null);
  if (patch.category !== undefined) add('category', normalizeCategory(patch.category));
  if (patch.frequency !== undefined) add('frequency', normalizeFrequency(patch.frequency));
  if (patch.weekDays !== undefined) add('week_days', JSON.stringify(normalizeWeekDays(patch.weekDays)));
  if (patch.targetCount !== undefined) add('target_count', normalizeTargetCount(patch.targetCount));
  if (patch.reminderTimes !== undefined) add('reminder_times', JSON.stringify(normalizeReminderTimes(patch.reminderTimes, patch.reminderTime)));
  if (patch.reminderTime !== undefined) add('reminder_time', normalizeReminderTime(patch.reminderTime) ?? null);
  if (patch.kind !== undefined) add('kind', normalizeHabitKind(patch.kind));
  if (patch.scheduleInstances?.enabled !== undefined) add('schedule_enabled', patch.scheduleInstances.enabled ? 1 : 0);
  if (patch.scheduleInstances?.reminderMinutesBefore !== undefined) add('schedule_reminder_minutes_before', normalizeReminderMinutes(patch.scheduleInstances.reminderMinutesBefore));
  if (!updates.length) return;
  const now = Date.now();
  const existing = await loadHabitById(habitId);
  if (existing?.owner !== 'I' && existing?.scheduleInstances.ruleUpdatedAt !== undefined) {
    const ruleVersion = Math.max(now, existing.scheduleInstances.ruleUpdatedAt + 1);
    const oldClock = new Date(existing.scheduleInstances.startAt!);
    const clock = normalizeReminderTimes(patch.reminderTimes, patch.reminderTime)[0];
    const nextStart = new Date(now);
    nextStart.setHours(clock ? Number(clock.slice(0, 2)) : oldClock.getHours(), clock ? Number(clock.slice(3, 5)) : oldClock.getMinutes(), 0, 0);
    if (nextStart.getTime() < now) nextStart.setDate(nextStart.getDate() + 1);
    add('schedule_rule_updated_at', ruleVersion);
    add('schedule_start_at', nextStart.getTime());
    if (existing.scheduleInstances.endMode === 'fixed' && existing.scheduleInstances.endAt !== undefined) {
      add('schedule_end_at', chatHabitFixedEndAt(nextStart.getTime(), existing.scheduleInstances.startAt!, existing.scheduleInstances.endAt));
    }
  }
  add('updated_at', now);
  await database.runAsync(`UPDATE habits SET ${updates.join(', ')} WHERE id = ?`, ...values, habitId);
  await recomputeHabitStreak(habitId);
}

export async function archiveHabit(habitId: string) {
  const database = await getDatabase();
  await database.runAsync("UPDATE habits SET status = 'archived', updated_at = ? WHERE id = ?", Date.now(), habitId);
}

export async function loadHabits(includeArchived = false, kind: HabitKind = 'habit') {
  const database = await getDatabase();
  const rows = await database.getAllAsync<HabitRow>(
    `SELECT * FROM habits
     WHERE kind = ? AND owner = 'you' ${includeArchived ? '' : "AND status = 'active'"}
     ORDER BY updated_at DESC`,
    kind,
  );
  return rows.map(fromHabitRow);
}

export async function loadHabitsForDate(day: string): Promise<HabitForDate[]> {
  const database = await getDatabase();
  const all = await loadHabits();
  const scheduledIds = all.filter(habit => habit.scheduleInstances.ruleUpdatedAt !== undefined).map(habit => habit.id);
  const scheduledDue = scheduledIds.length
    ? new Set(await (await import('./habitScheduleStore')).loadIntervalHabitIdsForDate(day))
    : new Set<string>();
  const habits = all.filter((habit) => habit.scheduleInstances.ruleUpdatedAt !== undefined
    ? scheduledDue.has(habit.id) : habitAppliesToDate(habit, day));
  if (!habits.length) return [];
  const logs = await database.getAllAsync<HabitLogRow>(
    `SELECT * FROM habit_logs
     WHERE date_key = ? AND habit_id IN (${habits.map(() => '?').join(',')})`,
    day,
    ...habits.map((habit) => habit.id),
  );
  const logsByHabit = new Map(logs.map((log) => [log.habit_id, fromLogRow(log)]));
  return habits.map((habit) => {
    const log = logsByHabit.get(habit.id);
    return {
      ...habit,
      log,
      completedToday: (log?.completedCount ?? 0) >= habit.targetCount,
    };
  });
}

export async function loadHabitLogForDate(habitId: string, day: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<HabitLogRow>(
    'SELECT * FROM habit_logs WHERE habit_id = ? AND date_key = ?',
    habitId,
    day,
  );
  return row ? fromLogRow(row) : undefined;
}

export async function setHabitLogProgress(habitId: string, day: string, completedCount: number, note = '') {
  const database = await getDatabase();
  const now = Date.now();
  const habit = await loadHabitById(habitId);
  if (habit?.owner === 'I') throw new Error('own-habit-requires-activity-completion');
  const targetCount = habit?.targetCount ?? 1;
  const nextCount = Math.max(0, Math.min(targetCount, Math.round(completedCount)));
  const completed = nextCount >= targetCount;
  await database.runAsync(
    `INSERT INTO habit_logs
      (id, habit_id, date_key, completed, completed_count, note, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(habit_id, date_key) DO UPDATE SET
       completed = excluded.completed,
       completed_count = excluded.completed_count,
       note = excluded.note,
       completed_at = excluded.completed_at,
       updated_at = excluded.updated_at`,
    makeTodoNaturalRecordId(
      'habit-log',
      [habitId, day],
    ),
    habitId,
    day,
    completed ? 1 : 0,
    nextCount,
    note.trim().slice(0, 240),
    completed ? now : null,
    now,
    now,
  );
  await recomputeHabitStreak(habitId, day);
}

/** Calendar completion and its log live in different databases. The occurrence key makes local repair idempotent. */
export async function recordYouHabitOccurrenceCompletion(habitId: string, occurrenceKey: string, completedAt: number, assertCurrent?: () => void | Promise<void>) {
  if (!occurrenceKey || occurrenceKey.length > 500 || !Number.isSafeInteger(completedAt) || completedAt < 0) {
    throw new Error('invalid-habit-occurrence-completion');
  }
  const database = await getDatabase();
  let log: HabitLog | undefined;
  let recorded = false;
  let progressChanged = false;
  await database.withExclusiveTransactionAsync(async transaction => {
    const row = await transaction.getFirstAsync<HabitRow>('SELECT * FROM habits WHERE id = ?', habitId);
    if (!row || row.owner === 'I' || row.kind !== 'habit') throw new Error('habit-completion-owner-or-kind');
    const rows = await transaction.getAllAsync<HabitLogRow>('SELECT * FROM habit_logs WHERE habit_id = ?', habitId);
    const existing = rows.map(fromLogRow).find(value => value.completionActivityIds?.includes(occurrenceKey));
    if (existing) { log = existing; return; }
    const day = dateKey(completedAt);
    const old = rows.find(value => value.date_key === day);
    const ids = [...(old ? fromLogRow(old).completionActivityIds ?? [] : []), occurrenceKey];
    const count = Math.min(row.target_count ?? 1, (old ? fromLogRow(old).completedCount : 0) + 1);
    const completedTime = old && fromLogRow(old).completedCount >= (row.target_count ?? 1) ? old.completed_at ?? completedAt : completedAt;
    await assertCurrent?.();
    await transaction.runAsync(
      `INSERT INTO habit_logs (id, habit_id, date_key, completed, completed_count, completion_activity_ids, note, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(habit_id, date_key) DO UPDATE SET completed = excluded.completed, completed_count = excluded.completed_count,
         completion_activity_ids = excluded.completion_activity_ids, completed_at = excluded.completed_at, updated_at = excluded.updated_at`,
      old?.id ?? makeTodoNaturalRecordId('habit-log', [habitId, day]), habitId, day,
      count >= (row.target_count ?? 1) ? 1 : 0, count, JSON.stringify(ids), old?.note ?? '', completedTime,
      old?.created_at ?? completedAt, Math.max(old?.updated_at ?? 0, completedAt),
    );
    const saved = await transaction.getFirstAsync<HabitLogRow>('SELECT * FROM habit_logs WHERE habit_id = ? AND date_key = ?', habitId, day);
    if (!saved) throw new Error('habit-log-save-missing');
    log = fromLogRow(saved);
    recorded = true;
    progressChanged = count !== (old ? fromLogRow(old).completedCount : 0);
  });
  const habit = await loadHabitById(habitId);
  if (progressChanged && habit?.frequency !== 'interval') await recomputeHabitStreak(habitId, dateKey(completedAt));
  if (!log) throw new Error('habit-log-save-missing');
  return { recorded, log };
}

export async function advanceHabitLogProgress(habitId: string, day: string, amount = 1, note = '') {
  const habit = await loadHabitById(habitId);
  if (!habit) return undefined;
  const log = await loadHabitLogForDate(habitId, day);
  const nextCount = Math.min(habit.targetCount, Math.max(0, (log?.completedCount ?? 0) + amount));
  await setHabitLogProgress(habitId, day, nextCount, note || log?.note || '');
  return nextCount;
}

export async function toggleHabitLog(habitId: string, day: string, completed: boolean, note = '') {
  const habit = await loadHabitById(habitId);
  await setHabitLogProgress(habitId, day, completed ? (habit?.targetCount ?? 1) : 0, note);
}

export async function loadHabitSummaryForDate(day: string): Promise<HabitSummaryForDate> {
  const habits = await loadHabitsForDate(day);
  const completed = habits.filter((habit) => habit.completedToday);
  const pending = habits.filter((habit) => !habit.completedToday);
  return {
    dateKey: day,
    habits,
    completed,
    pending,
    done: completed.length,
    total: habits.length,
  };
}

/** Remove a user habit and its logs together; calendar cleanup is owned by habitScheduleStore. */
export async function deleteHabit(habitId: string) {
  const database = await getDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const habit = await transaction.getFirstAsync<HabitRow>('SELECT * FROM habits WHERE id = ?', habitId);
    if (!habit) return;
    if (habit.owner !== 'you' || habit.kind !== 'habit') throw new Error('habit-delete-owner-or-kind');
    await transaction.runAsync('DELETE FROM habit_logs WHERE habit_id = ?', habitId);
    // Keep real tasks; only detach the link to the removed habit.
    await transaction.runAsync('UPDATE todo_items SET habit_id = NULL, updated_at = ? WHERE habit_id = ?', Date.now(), habitId);
    await transaction.runAsync('DELETE FROM habits WHERE id = ?', habitId);
  });
}

export type OwnHabitEntry = {
  id: string | null;
  title: string;
  frequency: 'daily' | 'weekly' | 'weekdays';
  count: number;
  weekDays: number[];
  minutes: number | null;
};
export type OwnHabitChanges = { entries: OwnHabitEntry[]; stopIds: string[] };
export type OwnHabitSaveResult = {
  entries: Habit[];
  stoppedIds: string[];
  errors: Array<{ id: string; code: string }>;
};

// operationId and now belong to the persisted tool call, including local retries.
export async function saveOwnHabitChanges(
  input: OwnHabitChanges,
  operationId: string,
  now = Date.now(),
  expectedVersions?: Record<string, number>,
): Promise<OwnHabitSaveResult> {
  if (!operationId || operationId.length > 180 || !Number.isSafeInteger(now) || now < 0) {
    throw new Error('invalid-own-habit-operation');
  }
  const result: OwnHabitSaveResult = { entries: [], stoppedIds: [], errors: [] };
  const database = await getDatabase();
  const ids = input.entries.map((entry, index) => entry.id ?? `own-habit:${operationId}:${index}`);
  if (new Set([...ids, ...input.stopIds]).size !== ids.length + input.stopIds.length) {
    throw new Error('duplicate-own-habit-target');
  }
  for (const [index, entry] of input.entries.entries()) {
    const id = ids[index];
    try {
      if (!entry.title.trim() || entry.title.length > 80
        || !['daily', 'weekly', 'weekdays'].includes(entry.frequency)
        || !Number.isSafeInteger(entry.count) || entry.count < 1 || entry.count > 1_000_000
        || !Array.isArray(entry.weekDays) || entry.weekDays.some(day => !Number.isInteger(day) || day < 1 || day > 7)
        || new Set(entry.weekDays).size !== entry.weekDays.length
        || (entry.frequency === 'weekdays' ? !entry.weekDays.length : entry.weekDays.length > 0)
        || (entry.minutes !== null && (!Number.isSafeInteger(entry.minutes) || entry.minutes < 1 || entry.minutes > 1_000_000))) {
        throw new Error('invalid-own-habit-entry');
      }
      await database.withExclusiveTransactionAsync(async transaction => {
        const old = await transaction.getFirstAsync<HabitRow>('SELECT * FROM habits WHERE id = ?', id);
        const period = entry.frequency === 'weekly' ? 'week' : entry.frequency === 'daily' ? 'day' : 'weekdays';
        const frequency = entry.frequency === 'weekdays' ? 'custom' : entry.frequency;
        const weekDays = [...entry.weekDays].sort((a, b) => a - b);
        if (old && old.owner !== 'I') throw new Error('own-habit-target-not-owned');
        if (!old && entry.id !== null) throw new Error('own-habit-target-missing');
        if (old && old.status !== 'active') throw new Error('own-habit-target-stopped');
        if (old && old.updated_at === now && old.title === entry.title.trim()
          && old.frequency_period === period && old.target_count === entry.count
          && (old.minutes ?? null) === entry.minutes && JSON.stringify(normalizeWeekDays(old.week_days)) === JSON.stringify(weekDays)) {
          result.entries.push(fromHabitRow(old));
          return;
        }
        if (old && (entry.id === null || (expectedVersions && old.updated_at !== expectedVersions[id]))) {
          throw new Error('own-habit-target-changed');
        }
        if (old) {
          await transaction.runAsync(
            `UPDATE habits SET title = ?, frequency = ?, frequency_period = ?, week_days = ?, target_count = ?, minutes = ?, updated_at = ? WHERE id = ? AND owner = 'I'`,
            entry.title.trim(), frequency, period, JSON.stringify(weekDays), entry.count, entry.minutes, now, id,
          );
        } else {
          await transaction.runAsync(
            `INSERT INTO habits (id, owner, title, frequency, frequency_period, week_days, target_count, minutes, created_at, updated_at)
             VALUES (?, 'I', ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, entry.title.trim(), frequency, period, JSON.stringify(weekDays), entry.count, entry.minutes, now, now,
          );
        }
        const saved = await transaction.getFirstAsync<HabitRow>('SELECT * FROM habits WHERE id = ?', id);
        if (!saved) throw new Error('own-habit-save-missing');
        result.entries.push(fromHabitRow(saved));
      });
    } catch (error) {
      result.entries = result.entries.filter(item => item.id !== id);
      result.errors.push({ id, code: error instanceof Error ? error.message : 'own-habit-save-failed' });
    }
  }
  for (const id of input.stopIds) {
    try {
      await database.withExclusiveTransactionAsync(async transaction => {
        const old = await transaction.getFirstAsync<HabitRow>('SELECT * FROM habits WHERE id = ?', id);
        if (!old || old.owner !== 'I') throw new Error('own-habit-target-not-owned');
        if (old.status === 'archived' && old.updated_at === now) return;
        if (old.status !== 'active' || (expectedVersions && old.updated_at !== expectedVersions[id])) throw new Error('own-habit-target-changed');
        await transaction.runAsync("UPDATE habits SET status = 'archived', updated_at = ? WHERE id = ? AND owner = 'I'", now, id);
      });
      result.stoppedIds.push(id);
    } catch (error) {
      result.errors.push({ id, code: error instanceof Error ? error.message : 'own-habit-stop-failed' });
    }
  }
  return result;
}

export async function loadOwnActiveHabits(): Promise<Habit[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<HabitRow>("SELECT * FROM habits WHERE owner = 'I' AND status = 'active' AND kind = 'habit' ORDER BY created_at, id");
  return rows.map(fromHabitRow);
}

export function getOwnHabitPeriod(habit: Habit, day: string) {
  const start = new Date(`${day}T12:00:00`);
  if (!Number.isFinite(start.getTime()) || dateKey(start) !== day) throw new Error('invalid-habit-date');
  if (habit.frequencyPeriod === 'week') start.setDate(start.getDate() - ((start.getDay() || 7) - 1));
  const end = new Date(start);
  if (habit.frequencyPeriod === 'week') end.setDate(end.getDate() + 6);
  return { periodStart: dateKey(start), periodEnd: dateKey(end) };
}

export async function getOwnHabitPeriodProgress(habit: Habit, day: string) {
  const period = getOwnHabitPeriod(habit, day);
  const database = await getDatabase();
  const rows = await database.getAllAsync<HabitLogRow>(
    'SELECT * FROM habit_logs WHERE habit_id = ? AND date_key >= ? AND date_key <= ?',
    habit.id, period.periodStart, period.periodEnd,
  );
  const activityIds = new Set(rows.flatMap(row => fromLogRow(row).completionActivityIds ?? []));
  return { ...period, completedCount: activityIds.size, targetCount: habit.targetCount,
    applies: habitAppliesToDate(habit, day), completionActivityIds: [...activityIds] };
}

export async function recordHabitActivityCompletion(habitId: string, activityId: string, completedAt: number) {
  if (!activityId || activityId.length > 240 || !Number.isSafeInteger(completedAt) || completedAt < 0) throw new Error('invalid-habit-activity');
  const database = await getDatabase();
  let recorded = false;
  await database.withExclusiveTransactionAsync(async transaction => {
    const habitRow = await transaction.getFirstAsync<HabitRow>('SELECT * FROM habits WHERE id = ?', habitId);
    if (!habitRow || habitRow.owner !== 'I') throw new Error('own-habit-target-not-owned');
    // Archived habits still accept completion of their already-saved activity.
    const rows = await transaction.getAllAsync<HabitLogRow>('SELECT * FROM habit_logs WHERE habit_id = ?', habitId);
    if (rows.some(row => fromLogRow(row).completionActivityIds?.includes(activityId))) return;
    const day = dateKey(completedAt);
    const old = rows.find(row => row.date_key === day);
    const ids = [...(old ? fromLogRow(old).completionActivityIds ?? [] : []), activityId];
    const period = getOwnHabitPeriod(fromHabitRow(habitRow), day);
    const periodCount = new Set(rows.filter(row => row.date_key >= period.periodStart && row.date_key <= period.periodEnd)
      .flatMap(row => fromLogRow(row).completionActivityIds ?? []).concat(activityId)).size;
    await transaction.runAsync(
      `INSERT INTO habit_logs (id, habit_id, date_key, completed, completed_count, completion_activity_ids, note, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)
       ON CONFLICT(habit_id, date_key) DO UPDATE SET completed = excluded.completed, completed_count = excluded.completed_count,
         completion_activity_ids = excluded.completion_activity_ids, completed_at = excluded.completed_at, updated_at = excluded.updated_at`,
      old?.id ?? makeTodoNaturalRecordId('habit-log', [habitId, day]), habitId, day,
      periodCount >= (habitRow.target_count ?? 1) ? 1 : 0, ids.length, JSON.stringify(ids), completedAt, old?.created_at ?? completedAt, completedAt,
    );
    recorded = true;
  });
  return { recorded };
}
