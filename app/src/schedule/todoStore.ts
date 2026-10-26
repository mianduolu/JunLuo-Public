import { dateKey } from './scheduleStore';
import { getTodoDatabase as getDatabase } from './todoDatabase';
import { nextMondayKey, type PostponeTarget } from './postponeLogic';
import { inferTodoType, type InhibitOutcome, type TodoType } from './todoTypeLogic';
import { makeTodoNaturalRecordId } from './todoIdentity';
export { inferTodoType, type InhibitOutcome, type TodoType } from './todoTypeLogic';

export type TodoStatus = 'inbox' | 'today' | 'scheduled' | 'completed' | 'cancelled' | 'expired';
export type TodoSource = 'manual' | 'ai' | 'daily-challenge' | 'goal';
export type TodoPriority = 'low' | 'normal' | 'high';
export type TodoReminderMode = 'none' | 'gentle' | 'followup';
export type TodoQuadrant = 'q1' | 'q2' | 'q3' | 'q4';
export type TodoCategory = 'study' | 'work' | 'health' | 'life' | 'social' | 'leisure' | 'creation' | 'other';

export type TodoItem = {
  id: string;
  title: string;
  notes: string;
  status: TodoStatus;
  plannedForDate?: string;
  source: TodoSource;
  priority: TodoPriority;
  quadrant: TodoQuadrant;
  category: TodoCategory;
  estimatedMinutes?: number;
  trackedMinutes: number;
  goalId?: string;
  goalContribution: number;
  dueDate?: string;
  challengeId?: string;
  habitId?: string;
  type: TodoType;
  inhibitActiveFrom?: string;
  inhibitEndedAt?: number;
  postponeCount: number;
  reminderMode: TodoReminderMode;
  reminderStage: number;
  lastRemindedAt?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  completionRound?: number;
  parentTodoId?: string;
  parentOccurrenceId?: string;
  stepOrder?: number;
};

export type TodoDraft = {
  parentTodoId?: string;
  parentOccurrenceId?: string;
  stepOrder?: number;
  title: string;
  notes: string;
  plannedForDate?: string;
  source: TodoSource;
  priority: TodoPriority;
  quadrant?: TodoQuadrant;
  category?: TodoCategory;
  estimatedMinutes?: number;
  goalId?: string;
  goalContribution?: number;
  dueDate?: string;
  challengeId?: string;
  habitId?: string;
  type?: TodoType;
  reminderMode: TodoReminderMode;
};

export type TodoPatch = Partial<Pick<
  TodoItem,
  'title' | 'notes' | 'status' | 'plannedForDate' | 'priority' | 'quadrant' | 'category' | 'estimatedMinutes' | 'trackedMinutes' | 'goalId' | 'dueDate' | 'reminderMode' | 'type' | 'parentTodoId' | 'parentOccurrenceId' | 'stepOrder' | 'habitId'
>>;

export type TodoInhibitLog = {
  id: string;
  todoId: string;
  dateKey: string;
  acknowledgedAt?: number;
  outcome: InhibitOutcome;
  createdAt: number;
  updatedAt: number;
};

export type TodoReminderNotificationRecord = {
  todoId: string;
  stage: number;
  notificationId: string;
  scheduledAt: number;
};

type TodoRow = {
  parent_todo_id?: string | null;
  parent_occurrence_id?: string | null;
  step_order?: number | null;
  id: string;
  title: string;
  notes: string;
  status: TodoStatus;
  planned_for_date: string | null;
  source: TodoSource;
  priority: TodoPriority;
  quadrant: TodoQuadrant | null;
  category: TodoCategory | null;
  estimated_minutes: number | null;
  tracked_minutes: number | null;
  goal_id: string | null;
  goal_contribution: number | null;
  due_date: string | null;
  challenge_id: string | null;
  habit_id: string | null;
  todo_type: TodoType | null;
  inhibit_active_from: string | null;
  inhibit_ended_at: number | null;
  postpone_count: number | null;
  reminder_mode: TodoReminderMode;
  reminder_stage: number;
  last_reminded_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  completion_round: number;
};

type InhibitLogRow = {
  id: string;
  todo_id: string;
  date_key: string;
  acknowledged_at: number | null;
  outcome: InhibitOutcome | null;
  created_at: number;
  updated_at: number;
};

const MORNING_REMINDER_HOUR = 9;
const FOLLOWUP_REMINDER_HOUR = 15;
const TODO_QUADRANTS: TodoQuadrant[] = ['q1', 'q2', 'q3', 'q4'];
const TODO_CATEGORIES: TodoCategory[] = ['study', 'work', 'health', 'life', 'social', 'leisure', 'creation', 'other'];

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function todayKey() {
  return dateKey(new Date());
}

function normalizeQuadrant(value?: string | null): TodoQuadrant {
  return TODO_QUADRANTS.includes(value as TodoQuadrant) ? (value as TodoQuadrant) : 'q2';
}

function normalizeCategory(value?: string | null): TodoCategory {
  return TODO_CATEGORIES.includes(value as TodoCategory) ? (value as TodoCategory) : 'other';
}

function normalizeMinutes(value?: number | null) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function fromRow(row: TodoRow): TodoItem {
  return {
    parentTodoId: row.parent_todo_id ?? undefined,
    parentOccurrenceId: row.parent_occurrence_id ?? undefined,
    stepOrder: row.step_order ?? undefined,
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    plannedForDate: row.planned_for_date ?? undefined,
    source: row.source,
    priority: row.priority ?? 'normal',
    quadrant: normalizeQuadrant(row.quadrant),
    category: normalizeCategory(row.category),
    estimatedMinutes: normalizeMinutes(row.estimated_minutes),
    trackedMinutes: Math.max(0, row.tracked_minutes ?? 0),
    goalId: row.goal_id ?? undefined,
    goalContribution: Math.max(0, row.goal_contribution ?? 0),
    dueDate: normalizePlannedDate(row.due_date ?? undefined),
    challengeId: row.challenge_id ?? undefined,
    habitId: row.habit_id ?? undefined,
    type: row.todo_type === 'inhibit' ? 'inhibit' : 'normal',
    inhibitActiveFrom: row.inhibit_active_from ?? undefined,
    inhibitEndedAt: row.inhibit_ended_at ?? undefined,
    postponeCount: Math.max(0, row.postpone_count ?? 0),
    reminderMode: row.reminder_mode ?? 'followup',
    reminderStage: row.reminder_stage ?? 0,
    lastRemindedAt: row.last_reminded_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    completionRound: row.completion_round ?? 0,
  };
}

function inhibitLogFromRow(row: InhibitLogRow): TodoInhibitLog {
  return {
    id: row.id,
    todoId: row.todo_id,
    dateKey: row.date_key,
    acknowledgedAt: row.acknowledged_at ?? undefined,
    outcome: row.outcome === 'kept' || row.outcome === 'slipped' ? row.outcome : 'unrecorded',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizePlannedDate(value?: string) {
  if (!value) return undefined;
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isFinite(parsed.getTime()) ? dateKey(parsed) : undefined;
}

function normalizeOptionalMinutes(value?: number) {
  if (value === undefined || value === null) return undefined;
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

export function todoDraftFromTitle(title: string, plannedForDate?: string): TodoDraft | null {
  const trimmed = title.trim();
  if (!trimmed) return null;
  return {
    title: trimmed.slice(0, 60),
    notes: '',
    plannedForDate: normalizePlannedDate(plannedForDate),
    source: 'manual',
    priority: 'normal',
    quadrant: 'q2',
    category: 'other',
    reminderMode: 'followup',
    type: inferTodoType(trimmed),
  };
}

export async function promoteDueTodoItems(now = new Date()) {
  const database = await getDatabase();
  const key = dateKey(now);
  const timestamp = Date.now();
  await database.runAsync(
    `UPDATE todo_items
     SET status = 'today', updated_at = ?
     WHERE status = 'inbox' AND planned_for_date IS NOT NULL AND planned_for_date <= ?`,
    timestamp,
    key,
  );
}

export async function createTodoItem(draft: TodoDraft, status?: TodoStatus, recordId?: string) {
  const database = await getDatabase();
  const now = Date.now();
  const plannedForDate = normalizePlannedDate(draft.plannedForDate);
  const type = draft.type ?? inferTodoType(draft.title);
  const inhibitActiveFrom = type === 'inhibit' ? plannedForDate ?? todayKey() : undefined;
  const initialStatus = status ?? (type === 'inhibit' || plannedForDate === todayKey() ? 'today' : 'inbox');
  const generatedId = plannedForDate
    && draft.source === 'daily-challenge'
    && draft.challengeId
    ? makeTodoNaturalRecordId(
        'generated-todo',
        [draft.source, draft.challengeId, plannedForDate],
      )
    : plannedForDate && draft.source === 'goal' && draft.goalId
      ? makeTodoNaturalRecordId(
          'generated-todo',
          [draft.source, draft.goalId, plannedForDate],
        )
      : undefined;
  const item: TodoItem = {
    id: recordId ?? generatedId ?? makeId('todo'),
    title: draft.title.trim(),
    notes: draft.notes.trim(),
    status: initialStatus,
    plannedForDate,
    source: draft.source,
    priority: draft.priority,
    quadrant: normalizeQuadrant(draft.quadrant),
    category: normalizeCategory(draft.category),
    estimatedMinutes: normalizeOptionalMinutes(draft.estimatedMinutes),
    trackedMinutes: 0,
    goalId: draft.goalId,
    goalContribution: Math.max(0, Math.round(draft.goalContribution ?? 0)),
    dueDate: normalizePlannedDate(draft.dueDate),
    challengeId: draft.challengeId,
    habitId: draft.habitId,
    parentTodoId: draft.parentTodoId,
    parentOccurrenceId: draft.parentOccurrenceId,
    stepOrder: draft.stepOrder,
    type,
    inhibitActiveFrom,
    postponeCount: 0,
    reminderMode: draft.reminderMode,
    reminderStage: 0,
    createdAt: now,
    updatedAt: now,
    completionRound: 0,
  };
  await database.runAsync(
    `INSERT INTO todo_items
      (id, title, notes, status, planned_for_date, source, priority, quadrant, category, estimated_minutes, tracked_minutes, goal_id, goal_contribution, due_date, challenge_id, habit_id, todo_type, inhibit_active_from, reminder_mode, reminder_stage, created_at, updated_at, parent_todo_id, parent_occurrence_id, step_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    item.id,
    item.title,
    item.notes,
    item.status,
    item.plannedForDate ?? null,
    item.source,
    item.priority,
    item.quadrant,
    item.category,
    item.estimatedMinutes ?? null,
    item.trackedMinutes,
    item.goalId ?? null,
    item.goalContribution,
    item.dueDate ?? null,
    item.challengeId ?? null,
    item.habitId ?? null,
    item.type,
    item.inhibitActiveFrom ?? null,
    item.reminderMode,
    item.reminderStage,
    item.createdAt,
    item.updatedAt,
    item.parentTodoId ?? null,
    item.parentOccurrenceId ?? null,
    item.stepOrder ?? null,
  );
  return item;
}

export async function loadTodayTodoItems() {
  await promoteDueTodoItems();
  const database = await getDatabase();
  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items
     WHERE status = 'today' AND todo_type = 'normal'
     ORDER BY CASE quadrant WHEN 'q1' THEN 0 WHEN 'q2' THEN 1 WHEN 'q3' THEN 2 ELSE 3 END,
       CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at ASC`,
  );
  return rows.map(fromRow);
}

export async function loadTodoItemsForDate(day: string) {
  await promoteDueTodoItems();
  const database = await getDatabase();
  const normalizedDay = normalizePlannedDate(day) ?? day;
  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items
     WHERE status IN ('today', 'scheduled') AND todo_type = 'normal' AND planned_for_date = ?
     ORDER BY CASE quadrant WHEN 'q1' THEN 0 WHEN 'q2' THEN 1 WHEN 'q3' THEN 2 ELSE 3 END,
       CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at ASC`,
    normalizedDay,
  );
  return rows.map(fromRow);
}

export async function loadTodoItemsForDates(days: string[], includeCompleted = false) {
  await promoteDueTodoItems();
  const normalizedDays = Array.from(new Set(days.map((day) => normalizePlannedDate(day) ?? day).filter(Boolean)));
  if (!normalizedDays.length) return [];
  const database = await getDatabase();
  const placeholders = normalizedDays.map(() => '?').join(', ');
  const statusClause = includeCompleted ? "('today', 'scheduled', 'completed')" : "('today', 'scheduled')";
  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items
     WHERE status IN ${statusClause} AND todo_type = 'normal' AND planned_for_date IN (${placeholders})
     ORDER BY planned_for_date ASC,
       CASE quadrant WHEN 'q1' THEN 0 WHEN 'q2' THEN 1 WHEN 'q3' THEN 2 ELSE 3 END,
       CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
       created_at ASC`,
    ...normalizedDays,
  );
  return rows.map(fromRow);
}

export async function loadTodoItemsBetweenDates(startDay: string, endDay: string) {
  await promoteDueTodoItems();
  const database = await getDatabase();
  const normalizedStart = normalizePlannedDate(startDay) ?? startDay;
  const normalizedEnd = normalizePlannedDate(endDay) ?? endDay;
  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items
     WHERE status IN ('today', 'scheduled') AND todo_type = 'normal'
       AND planned_for_date >= ? AND planned_for_date <= ?
     ORDER BY planned_for_date ASC,
       CASE quadrant WHEN 'q1' THEN 0 WHEN 'q2' THEN 1 WHEN 'q3' THEN 2 ELSE 3 END,
       CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
       created_at ASC`,
    normalizedStart,
    normalizedEnd,
  );
  return rows.map(fromRow);
}

export async function loadInboxTodoItems() {
  await promoteDueTodoItems();
  const database = await getDatabase();
  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items
     WHERE status = 'inbox' AND todo_type = 'normal'
     ORDER BY CASE WHEN planned_for_date IS NULL THEN 1 ELSE 0 END, planned_for_date ASC, created_at DESC`,
  );
  return rows.map(fromRow);
}

export async function loadProactiveInboxTodoCandidates() {
  const database = await getDatabase();
  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items
     WHERE status = 'inbox' AND todo_type = 'normal'
       AND planned_for_date IS NULL AND due_date IS NULL AND reminder_mode != 'none'
     ORDER BY last_reminded_at ASC,
       CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
       created_at ASC, id ASC
     LIMIT 3`,
  );
  return rows.map(fromRow);
}

export async function markProactiveTodoMentioned(
  candidate: Pick<TodoItem, 'id' | 'updatedAt'>,
  now = Date.now(),
) {
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE todo_items SET last_reminded_at = ?, updated_at = ?
     WHERE id = ? AND updated_at = ? AND status = 'inbox' AND todo_type = 'normal'
       AND planned_for_date IS NULL AND due_date IS NULL AND reminder_mode != 'none'`,
    now, now, candidate.id, candidate.updatedAt,
  );
}

export async function loadOpenTodoItems(limit = 20) {
  await promoteDueTodoItems();
  const database = await getDatabase();
  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items
     WHERE status IN ('inbox', 'today') AND todo_type = 'normal'
     ORDER BY status DESC, updated_at DESC
     LIMIT ?`,
    limit,
  );
  return rows.map(fromRow);
}

export async function loadPostponableTodoItems(limit = 80) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items WHERE status IN ('inbox', 'today', 'scheduled') AND todo_type = 'normal'
     ORDER BY COALESCE(planned_for_date, '') ASC, updated_at DESC LIMIT ?`,
    limit,
  );
  return rows.map(fromRow);
}

export async function loadTodoCompletionsForDate(day: string, limit = 160) {
  const database = await getDatabase();
  const start = new Date(`${day}T00:00:00`).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items WHERE status = 'completed' AND todo_type = 'normal' AND completed_at >= ? AND completed_at < ?
     ORDER BY completed_at ASC LIMIT ?`,
    start,
    end,
    limit,
  );
  return rows.map(fromRow);
}

export async function loadTodoItemsByGoalId(goalId: string, includeCompleted = true) {
  await promoteDueTodoItems();
  const database = await getDatabase();
  const statusClause = includeCompleted ? "status != 'cancelled'" : "status IN ('inbox', 'today', 'scheduled')";
  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items
     WHERE goal_id = ? AND ${statusClause}
     ORDER BY CASE status WHEN 'completed' THEN 1 ELSE 0 END,
       CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
       COALESCE(planned_for_date, due_date, '') ASC,
       created_at ASC`,
    goalId,
  );
  return rows.map(fromRow);
}

export async function loadTodoItemById(todoId: string, options: { promoteDue?: boolean } = {}) {
  if (options.promoteDue !== false) await promoteDueTodoItems();
  const database = await getDatabase();
  const row = await database.getFirstAsync<TodoRow>('SELECT * FROM todo_items WHERE id = ?', todoId);
  return row ? fromRow(row) : null;
}

export async function loadActiveInhibitTodosForDate(day: string) {
  const normalizedDay = normalizePlannedDate(day) ?? day;
  const dayStart = new Date(`${normalizedDay}T00:00:00`).getTime();
  const database = await getDatabase();
  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items
     WHERE todo_type = 'inhibit'
       AND status != 'cancelled'
       AND COALESCE(inhibit_active_from, planned_for_date, '') <= ?
       AND (inhibit_ended_at IS NULL OR inhibit_ended_at >= ?)
     ORDER BY created_at ASC`,
    normalizedDay,
    dayStart,
  );
  return rows.map(fromRow);
}

export async function loadInhibitLogsForDate(day: string) {
  const normalizedDay = normalizePlannedDate(day) ?? day;
  const database = await getDatabase();
  const rows = await database.getAllAsync<InhibitLogRow>(
    'SELECT * FROM todo_inhibit_logs WHERE date_key = ? ORDER BY created_at ASC',
    normalizedDay,
  );
  return rows.map(inhibitLogFromRow);
}

export async function loadInhibitLogsForTodo(todoId: string, limit = 120) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<InhibitLogRow>(
    'SELECT * FROM todo_inhibit_logs WHERE todo_id = ? ORDER BY date_key ASC LIMIT ?',
    todoId,
    Math.max(1, Math.min(500, Math.round(limit))),
  );
  return rows.map(inhibitLogFromRow);
}

async function upsertInhibitLog(todoId: string, day: string, patch: { acknowledgedAt?: number; outcome?: InhibitOutcome }) {
  const database = await getDatabase();
  const normalizedDay = normalizePlannedDate(day) ?? day;
  const current = await database.getFirstAsync<InhibitLogRow>(
    'SELECT * FROM todo_inhibit_logs WHERE todo_id = ? AND date_key = ?',
    todoId,
    normalizedDay,
  );
  const now = Date.now();
  if (current) {
    await database.runAsync(
      'UPDATE todo_inhibit_logs SET acknowledged_at = ?, outcome = ?, updated_at = ? WHERE id = ?',
      patch.acknowledgedAt ?? current.acknowledged_at,
      patch.outcome ?? current.outcome ?? 'unrecorded',
      now,
      current.id,
    );
    const next = await database.getFirstAsync<InhibitLogRow>('SELECT * FROM todo_inhibit_logs WHERE id = ?', current.id);
    return next ? inhibitLogFromRow(next) : null;
  }
  const id = makeTodoNaturalRecordId(
    'inhibit-log',
    [todoId, normalizedDay],
  );
  await database.runAsync(
    `INSERT INTO todo_inhibit_logs
      (id, todo_id, date_key, acknowledged_at, outcome, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    todoId,
    normalizedDay,
    patch.acknowledgedAt ?? null,
    patch.outcome ?? 'unrecorded',
    now,
    now,
  );
  return {
    id,
    todoId,
    dateKey: normalizedDay,
    acknowledgedAt: patch.acknowledgedAt,
    outcome: patch.outcome ?? 'unrecorded',
    createdAt: now,
    updatedAt: now,
  } satisfies TodoInhibitLog;
}

export async function acknowledgeInhibitTodo(todoId: string, day: string) {
  return upsertInhibitLog(todoId, day, { acknowledgedAt: Date.now() });
}

export async function setInhibitOutcome(todoId: string, day: string, outcome: InhibitOutcome) {
  const todo = await loadTodoItemById(todoId);
  if (!todo || todo.type !== 'inhibit') return null;
  const log = await upsertInhibitLog(todoId, day, { outcome });
  if (outcome !== 'unrecorded') {
    void import('./scheduleMemoryBridge')
      .then(({ recordInhibitOutcomeMemory }) => recordInhibitOutcomeMemory(todo, day, outcome))
      .catch(() => undefined);
  }
  return log;
}

export async function endInhibitTodo(todoId: string) {
  const database = await getDatabase();
  const now = Date.now();
  await database.runAsync(
    "UPDATE todo_items SET inhibit_ended_at = ?, updated_at = ? WHERE id = ? AND todo_type = 'inhibit' AND inhibit_ended_at IS NULL",
    now,
    now,
    todoId,
  );
  return loadTodoItemById(todoId);
}

export async function loadCompletedTodoItemsForDates(days?: string[], limit = 80) {
  await promoteDueTodoItems();
  const database = await getDatabase();
  if (days?.length) {
    const placeholders = days.map(() => '?').join(', ');
    const rows = await database.getAllAsync<TodoRow>(
      `SELECT * FROM todo_items
       WHERE status = 'completed' AND todo_type = 'normal' AND planned_for_date IN (${placeholders})
       ORDER BY completed_at DESC, updated_at DESC
       LIMIT ?`,
      ...days,
      limit,
    );
    return rows.map(fromRow);
  }

  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items
     WHERE status = 'completed' AND todo_type = 'normal'
     ORDER BY completed_at DESC, updated_at DESC
     LIMIT ?`,
    limit,
  );
  return rows.map(fromRow);
}

export async function updateTodoItem(todoId: string, patch: TodoPatch, expectedUpdatedAt?: number) {
  const database = await getDatabase();
  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  const add = (column: string, value: string | number | null) => {
    updates.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.title !== undefined) add('title', patch.title.trim().slice(0, 60));
  if (patch.notes !== undefined) add('notes', patch.notes.trim().slice(0, 180));
  if (patch.status !== undefined) add('status', patch.status);
  if (patch.plannedForDate !== undefined) add('planned_for_date', normalizePlannedDate(patch.plannedForDate) ?? null);
  if (patch.priority !== undefined) add('priority', patch.priority);
  if (patch.quadrant !== undefined) add('quadrant', normalizeQuadrant(patch.quadrant));
  if (patch.category !== undefined) add('category', normalizeCategory(patch.category));
  if (patch.estimatedMinutes !== undefined) add('estimated_minutes', normalizeOptionalMinutes(patch.estimatedMinutes) ?? null);
  if (patch.trackedMinutes !== undefined) add('tracked_minutes', Math.max(0, Math.round(patch.trackedMinutes)));
  if (patch.goalId !== undefined) add('goal_id', patch.goalId || null);
  if (patch.dueDate !== undefined) add('due_date', normalizePlannedDate(patch.dueDate) ?? null);
  if (patch.reminderMode !== undefined) add('reminder_mode', patch.reminderMode);
  if (patch.parentTodoId !== undefined) add('parent_todo_id', patch.parentTodoId || null);
  if (patch.parentOccurrenceId !== undefined) add('parent_occurrence_id', patch.parentOccurrenceId || null);
  if (patch.habitId !== undefined) add('habit_id', patch.habitId || null);
  if (patch.stepOrder !== undefined) add('step_order', patch.stepOrder);
  if (patch.type !== undefined) {
    add('todo_type', patch.type);
    add('inhibit_active_from', patch.type === 'inhibit' ? normalizePlannedDate(patch.plannedForDate) ?? todayKey() : null);
    add('inhibit_ended_at', null);
    if (patch.type === 'inhibit') add('status', 'today');
  }
  if (!updates.length) return;

  add('updated_at', Date.now());
  const result = await database.runAsync(
    `UPDATE todo_items SET ${updates.join(', ')} WHERE id = ?${expectedUpdatedAt === undefined ? '' : ' AND updated_at = ?'}`,
    ...values, todoId, ...(expectedUpdatedAt === undefined ? [] : [expectedUpdatedAt]),
  );
  return result.changes > 0;
}

export async function moveTodoToQuadrant(todoId: string, quadrant: TodoQuadrant) {
  await updateTodoItem(todoId, { quadrant });
}

export async function loadTodoSteps(parentTodoId: string, parentOccurrenceId?: string) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items WHERE parent_todo_id = ? AND ${parentOccurrenceId ? 'parent_occurrence_id = ?' : 'parent_occurrence_id IS NULL'} ORDER BY step_order, created_at, id`,
    parentTodoId, ...(parentOccurrenceId ? [parentOccurrenceId] : []));
  return rows.map(fromRow);
}

export async function completeTodoItem(todoId: string, options: { skipTimeBasedGoalCredit?: boolean; skipGoalCredit?: boolean; completedAt?: number; expectedCompletionRound?: number } = {}) {
  const database = await getDatabase();
  const currentRow = await database.getFirstAsync<TodoRow>('SELECT * FROM todo_items WHERE id = ?', todoId);
  if (currentRow && options.expectedCompletionRound !== undefined && (currentRow.completion_round ?? 0) !== options.expectedCompletionRound) {
    throw new Error('todo-completion-source-changed');
  }
  if (!currentRow || currentRow.status === 'completed' || currentRow.todo_type === 'inhibit') return currentRow ? fromRow(currentRow) : null;
  const now = options.completedAt ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > Date.now()) throw new Error('todo-completion-time-invalid');
  const result = await database.runAsync(
    "UPDATE todo_items SET status = 'completed', completed_at = ?, postpone_count = 0, updated_at = ? WHERE id = ? AND status != 'completed' AND completion_round = ?",
    now,
    now,
    todoId,
    currentRow.completion_round ?? 0,
  );
  if (!result.changes) return loadTodoItemById(todoId);
  const item = fromRow(currentRow);
  if (item.source === 'daily-challenge' && item.habitId) {
    const { advanceHabitLogProgress } = await import('./habitStore');
    await advanceHabitLogProgress(item.habitId, item.plannedForDate ?? todayKey(), 1);
  }
  if (item.goalId && !options.skipGoalCredit) {
    const { recordTodoGoalCompletion } = await import('./goalProgressStore');
    await recordTodoGoalCompletion(todoId, { skipTimeBased: options.skipTimeBasedGoalCredit });
  }
  const completedItem = {
    ...item,
    status: 'completed' as const,
    completedAt: now,
    postponeCount: 0,
    updatedAt: now,
  };
  try {
    const { createMemoryFromScheduleCompletion } = await import('./scheduleMemoryBridge');
    await createMemoryFromScheduleCompletion({ todo: completedItem });
  } catch {
    // Memory is a best-effort side effect; task completion remains authoritative.
  }
  try {
    const { recordBaiyunScheduleCompletionReceipt } = await import(
      '../ai/behavior/actionExecutionRuntime'
    );
    await recordBaiyunScheduleCompletionReceipt({
      targetKind: 'todo_item',
      targetId: todoId,
      occurredAt: now,
    });
  } catch {
    // The deterministic reconciler can retry continuity projection later.
  }
  return completedItem;
}

export async function reopenTodoItem(todoId: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<TodoRow>('SELECT * FROM todo_items WHERE id = ?', todoId);
  if (!row || row.status !== 'completed') return row ? fromRow(row) : null;
  const item = fromRow(row);
  const today = todayKey();
  const nextStatus: TodoStatus = !item.plannedForDate ? 'inbox' : item.plannedForDate <= today ? 'today' : 'scheduled';
  const now = Date.now();
  const result = await database.runAsync(
    "UPDATE todo_items SET status = ?, completed_at = NULL, updated_at = ?, completion_round = completion_round + 1 WHERE id = ? AND status = 'completed' AND completion_round = ?",
    nextStatus,
    now,
    todoId,
    item.completionRound ?? 0,
  );
  if (!result.changes) return loadTodoItemById(todoId);
  if (item.source === 'daily-challenge' && item.habitId) {
    const { advanceHabitLogProgress } = await import('./habitStore');
    await advanceHabitLogProgress(item.habitId, item.plannedForDate ?? today, -1);
  }
  if (item.goalId && item.goalContribution > 0) {
    const { removeGoalProgressEvent } = await import('./goalProgressStore');
    await removeGoalProgressEvent(item.goalId, 'todo-completion', item.id);
  }
  if (item.goalId) {
    const { cancelGoalTimeCreditForTodo, removeGoalProgressEvent } = await import('./goalProgressStore');
    await removeGoalProgressEvent(item.goalId, 'todo-time-credit', item.id);
    await cancelGoalTimeCreditForTodo(item.id);
  }
  const reopenedItem = {
    ...item,
    status: nextStatus,
    completedAt: undefined,
    updatedAt: now,
    completionRound: (item.completionRound ?? 0) + 1,
  };
  try {
    const { reopenBaiyunScheduleContinuity } = await import(
      '../ai/behavior/actionExecutionRuntime'
    );
    await reopenBaiyunScheduleContinuity({
      targetKind: 'todo_item',
      targetId: todoId,
      reopenRevision: now,
      occurredAt: now,
    });
  } catch {
    // Reopening the task remains authoritative; continuity can be reconciled later.
  }
  return reopenedItem;
}

function addDaysKey(day: string, amount: number) {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return dateKey(date);
}

export async function postponeTodoItem(todoId: string, target: PostponeTarget) {
  const item = await loadTodoItemById(todoId);
  if (!item || item.type === 'inhibit' || item.status === 'completed' || item.status === 'cancelled' || item.status === 'expired') return null;
  let targetDate: string;
  if (target.kind === 'tomorrow') targetDate = addDaysKey(todayKey(), 1);
  else if (target.kind === 'next_week') targetDate = nextMondayKey();
  else if (target.kind === 'specific_date') targetDate = target.date;
  else {
    const { loadGoal } = await import('./goalStore');
    const goal = await loadGoal(target.goalId);
    if (!goal?.targetDate) return null;
    targetDate = addDaysKey(goal.targetDate, 1);
  }
  const database = await getDatabase();
  const status: TodoStatus = targetDate <= todayKey() ? 'today' : 'scheduled';
  const updatedAt = Date.now();
  await database.runAsync(
    'UPDATE todo_items SET status = ?, planned_for_date = ?, reminder_stage = 0, last_reminded_at = NULL, postpone_count = postpone_count + 1, updated_at = ? WHERE id = ?',
    status,
    targetDate,
    updatedAt,
    todoId,
  );
  const next = { ...item, status, plannedForDate: targetDate, postponeCount: item.postponeCount + 1, updatedAt };
  void import('./scheduleMemoryBridge')
    .then(({ recordRepeatedPostponeMemory }) => recordRepeatedPostponeMemory(next))
    .catch(() => undefined);
  return { previous: item, item: next };
}

export async function expireDailyChallengeTodosBefore(day: string) {
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE todo_items
     SET status = 'expired', updated_at = ?
     WHERE source = 'daily-challenge'
       AND status IN ('inbox', 'today', 'scheduled')
       AND planned_for_date < ?`,
    Date.now(),
    normalizePlannedDate(day) ?? day,
  );
}

export async function loadDailyChallengeTodo(challengeId: string, day: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<TodoRow>(
    'SELECT * FROM todo_items WHERE challenge_id = ? AND planned_for_date = ?',
    challengeId,
    normalizePlannedDate(day) ?? day,
  );
  return row ? fromRow(row) : null;
}

export async function loadDailyChallengeTodosForDate(day: string) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items
     WHERE source = 'daily-challenge' AND planned_for_date = ? AND status != 'cancelled'
     ORDER BY created_at ASC`,
    normalizePlannedDate(day) ?? day,
  );
  return rows.map(fromRow);
}

export async function cancelOpenDailyChallengeTodos(challengeId: string, fromDay = todayKey()) {
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE todo_items
     SET status = 'cancelled', updated_at = ?
     WHERE challenge_id = ?
       AND planned_for_date >= ?
       AND status IN ('inbox', 'today', 'scheduled')`,
    Date.now(),
    challengeId,
    fromDay,
  );
}

export async function updateOpenDailyChallengeTodos(
  challengeId: string,
  patch: Pick<TodoItem, 'title' | 'category' | 'quadrant'> & { estimatedMinutes: number },
) {
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE todo_items
     SET title = ?, category = ?, quadrant = ?, estimated_minutes = ?, updated_at = ?
     WHERE challenge_id = ? AND status IN ('inbox', 'today', 'scheduled')`,
    patch.title.trim().slice(0, 60),
    normalizeCategory(patch.category),
    normalizeQuadrant(patch.quadrant),
    normalizeOptionalMinutes(patch.estimatedMinutes) ?? null,
    Date.now(),
    challengeId,
  );
}

export async function ensureTodoStoreReady() {
  await getDatabase();
}

export async function cancelTodoItem(todoId: string, expectedUpdatedAt?: number) {
  const database = await getDatabase();
  const result = await database.runAsync("UPDATE todo_items SET status = 'cancelled', updated_at = ? WHERE id = ?"
    + (expectedUpdatedAt === undefined ? '' : " AND updated_at = ? AND status NOT IN ('completed', 'expired', 'cancelled')"),
  Date.now(), todoId, ...(expectedUpdatedAt === undefined ? [] : [expectedUpdatedAt]));
  return result.changes > 0;
}

export async function moveTodoToToday(todoId: string, plannedForDate = todayKey()) {
  const database = await getDatabase();
  await database.runAsync(
    "UPDATE todo_items SET status = 'today', planned_for_date = ?, reminder_stage = 0, last_reminded_at = NULL, updated_at = ? WHERE id = ?",
    plannedForDate,
    Date.now(),
    todoId,
  );
}

export async function moveTodoToInbox(todoId: string) {
  const database = await getDatabase();
  await database.runAsync(
    "UPDATE todo_items SET status = 'inbox', reminder_stage = 0, last_reminded_at = NULL, updated_at = ? WHERE id = ?",
    Date.now(),
    todoId,
  );
}

export async function postponeTodoToTomorrow(todoId: string) {
  return postponeTodoItem(todoId, { kind: 'tomorrow' });
}

function reminderHourDue(now: Date, hour: number) {
  return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= 0);
}

export async function loadDueTodoReminderItems(now = new Date()) {
  await promoteDueTodoItems(now);
  const database = await getDatabase();
  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items
     WHERE status = 'today' AND todo_type = 'normal' AND reminder_mode != 'none' AND reminder_stage < 2
     ORDER BY created_at ASC`,
  );
  return rows.map(fromRow).filter((item) => {
    if (item.reminderStage <= 0) return reminderHourDue(now, MORNING_REMINDER_HOUR);
    return item.reminderMode === 'followup' && reminderHourDue(now, FOLLOWUP_REMINDER_HOUR);
  });
}

export async function loadTodoReminderNotificationCandidates() {
  const database = await getDatabase();
  const rows = await database.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items
     WHERE status IN ('today', 'scheduled')
       AND todo_type = 'normal'
       AND planned_for_date IS NOT NULL
       AND reminder_mode != 'none'
       AND reminder_stage < 2
     ORDER BY planned_for_date ASC, created_at ASC`,
  );
  return rows.map(fromRow);
}

export async function loadTodoReminderNotificationRecords() {
  const database = await getDatabase();
  return database.getAllAsync<TodoReminderNotificationRecord>(
    `SELECT todo_id AS todoId, stage, notification_id AS notificationId, scheduled_at AS scheduledAt
     FROM todo_reminder_notifications`,
  );
}

export async function saveTodoReminderNotificationRecord(record: TodoReminderNotificationRecord) {
  const database = await getDatabase();
  await database.runAsync(
    `INSERT INTO todo_reminder_notifications (todo_id, stage, notification_id, scheduled_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(todo_id, stage) DO UPDATE SET
       notification_id = excluded.notification_id,
       scheduled_at = excluded.scheduled_at`,
    record.todoId,
    record.stage,
    record.notificationId,
    record.scheduledAt,
  );
}

export async function removeTodoReminderNotificationRecords(keys: Array<{ todoId: string; stage: number }>) {
  if (!keys.length) return;
  const database = await getDatabase();
  await Promise.all(keys.map(({ todoId, stage }) => database.runAsync(
    'DELETE FROM todo_reminder_notifications WHERE todo_id = ? AND stage = ?',
    todoId,
    stage,
  )));
}

export async function resetTodoReminderNotificationBindings() {
  const database = await getDatabase();
  const result = await database.runAsync('DELETE FROM todo_reminder_notifications');
  return result.changes;
}

export async function markTodoReminderDelivered(todoId: string, stage: number) {
  const database = await getDatabase();
  await database.runAsync(
    'UPDATE todo_items SET reminder_stage = ?, last_reminded_at = ?, updated_at = ? WHERE id = ?',
    stage,
    Date.now(),
    Date.now(),
    todoId,
  );
  await database.runAsync('DELETE FROM todo_reminder_notifications WHERE todo_id = ? AND stage < ?', todoId, stage);
}
