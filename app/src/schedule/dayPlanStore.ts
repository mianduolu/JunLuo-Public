import type { SQLiteDatabase } from 'expo-sqlite';
import type { DayPlanEntry as LegacyDayPlanEntry } from './dayPlan';
import { getScheduleDatabase } from './scheduleDatabase';
import {
  dateKey, ensureScheduleHorizon, loadScheduleItemById, loadScheduleOccurrence,
  scheduleOwnersOverlap, adjustedScheduleExecution, schedulePlanVersion, type ScheduleOwner, type ScheduleItem, type ScheduleOccurrence,
  type ScheduleReadingChoice, type ScheduleReadingChoiceValue, type ScheduleExecution,
} from './scheduleStore';
import { cancelTodoItem, createTodoItem, loadTodoItemById, updateTodoItem } from './todoStore';
import { loadHabitById } from './habitStore';
import { saveChatHabitPlan, archiveChatHabitPlan } from './habitScheduleStore';
import { applyChatScheduleTimeChange, chatScheduleReminderAt } from './chatSchedulePlanPolicy';
import { resolveScheduleDuration, scheduleOccupiedInterval, type ScheduleDurationIntent, type ScheduleDurationReceipt,
  type ScheduleSaveContext, type ScheduleSaveConflict } from './scheduleDurationPolicy';

const id = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const open = (status: string) => status !== 'completed' && status !== 'cancelled' && status !== 'expired';
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
type DayPlanEntry = LegacyDayPlanEntry & {
  owned?: boolean;
  owner?: ScheduleOwner;
  readingId?: string | null;
  habitId?: string | null;
  sourcePlanVersion?: number;
  duration?: ScheduleDurationIntent;
  conflict?: ScheduleSaveConflict;
  readingChoice?: ScheduleReadingChoice;
  choiceUpdate?: ScheduleReadingChoiceValue;
  choiceExpectedVersion?: number;
  choiceSourcePlanVersion?: number;
  choiceDependencyIds?: string[];
};

export async function prepareDayPlanEntry(input: Partial<DayPlanEntry>, prior?: DayPlanEntry): Promise<DayPlanEntry> {
  const occurrenceId = input.occurrenceId || prior?.occurrenceId;
  const occurrence = occurrenceId ? await loadScheduleOccurrence(occurrenceId) : null;
  const item = occurrence ? await loadScheduleItemById(occurrence.itemId) : null;
  if (input.sourceUpdatedAt !== undefined && item?.updatedAt !== input.sourceUpdatedAt) throw new Error('schedule-target-changed');
  if (occurrenceId && (!occurrence || !item || !open(occurrence.status) || !open(item.status))) throw new Error('schedule-target-unavailable');
  const todoId = input.todoId || prior?.todoId || occurrence?.todoId;
  const todo = todoId ? await loadTodoItemById(todoId, { promoteDue: false }) : null;
  if (input.sourceTodoUpdatedAt !== undefined && todo?.updatedAt !== input.sourceTodoUpdatedAt) throw new Error('todo-target-changed');
  if (todoId && (!todo || !open(todo.status) || todo.type !== 'normal')) throw new Error('todo-target-unavailable');
  const sameSource = !!prior && prior.occurrenceId === occurrenceId && prior.todoId === todoId;
  const youPlan = !input.owned && item?.owner !== 'I';
  const habitId = youPlan ? input.habitId ?? prior?.habitId ?? item?.habitId : undefined;
  const habit = habitId ? await loadHabitById(habitId) : null;
  if (input.sourceHabitUpdatedAt !== undefined && habit?.updatedAt !== input.sourceHabitUpdatedAt) throw new Error('habit-target-changed');
  if (habitId && (!habit || habit.owner === 'I' || habit.status !== 'active')) throw new Error('habit-target-unavailable');
  if (habitId && !input.scope && !prior?.scope) throw new Error('habit-scope-required');
  const base = { startAt: prior ? prior.startAt : occurrence?.scheduledStartAt, endAt: prior ? prior.endAt : occurrence?.endAt,
    durationMinutes: prior ? prior.durationMinutes : item?.durationMinutes, endMode: prior ? prior.endMode : item?.endMode };
  const time = youPlan ? applyChatScheduleTimeChange(base, input) : { ...base, ...input };
  const { startAt, endAt, durationMinutes, endMode } = time;
  const entry: DayPlanEntry = {
    id: prior?.id ?? input.id ?? id('day-plan-entry'),
    action: input.action ?? prior?.action ?? 'schedule',
    title: (input.title ?? prior?.title ?? occurrence?.title ?? todo?.title ?? '').trim(),
    notes: input.notes ?? prior?.notes ?? occurrence?.notes ?? todo?.notes ?? '',
    occurrenceId, todoId, startAt, endAt, durationMinutes, endMode, steps: input.steps ?? prior?.steps,
    habitId, repeat: input.repeat ?? prior?.repeat ?? (habit ? { frequency: habit.frequency === 'custom' ? 'weekly' : habit.frequency,
      weekDays: habit.weekDays, intervalDays: habit.intervalDays } : undefined), scope: input.scope ?? prior?.scope,
    targetHabitId: prior?.targetHabitId ?? habitId ?? (input.repeat ? id('habit') : undefined),
    sourceHabitUpdatedAt: prior?.sourceHabitUpdatedAt ?? habit?.updatedAt,
    parentTodoId: input.parentTodoId ?? prior?.parentTodoId ?? todo?.parentTodoId,
    parentOccurrenceId: input.parentOccurrenceId ?? prior?.parentOccurrenceId ?? todo?.parentOccurrenceId,
    stepOrder: input.stepOrder ?? prior?.stepOrder ?? todo?.stepOrder,
    startSuggested: input.startSuggested ?? (own(input, 'startAt') ? input.startAt !== (prior?.startAt ?? occurrence?.scheduledStartAt) : prior?.startSuggested ?? false),
    endSuggested: input.endSuggested ?? (own(input, 'endAt') ? input.endAt !== (prior ? prior.endAt : occurrence?.endAt) : prior?.endSuggested ?? false),
    reminderMinutesBefore: input.reminderMinutesBefore ?? prior?.reminderMinutesBefore ?? item?.reminderMinutesBefore ?? 15,
    startReminderEnabled: input.startReminderEnabled ?? prior?.startReminderEnabled ?? item?.startReminderEnabled ?? (youPlan ? true : undefined),
    companionEnabled: endAt !== undefined && (input.companionEnabled ?? prior?.companionEnabled ?? item?.companionEnabled ?? youPlan),
    sourceUpdatedAt: sameSource ? prior.sourceUpdatedAt : item?.updatedAt,
    sourceTodoUpdatedAt: sameSource ? prior.sourceTodoUpdatedAt : todo?.updatedAt,
    targetScheduleId: sameSource ? prior.targetScheduleId : item?.recurrence === 'none' ? item.id : id('schedule'),
    targetTodoId: sameSource ? prior.targetTodoId : todoId ?? id('todo'),
  };
  if (entry.action === 'inbox' && !(entry.steps?.length && entry.repeat)) {
    entry.startAt = undefined;
    entry.endAt = undefined;
    entry.companionEnabled = false;
  }
  if (!youPlan) for (const key of ['durationMinutes', 'endMode', 'startReminderEnabled', 'repeat', 'scope', 'targetHabitId',
    'sourceHabitUpdatedAt', 'parentTodoId', 'parentOccurrenceId', 'stepOrder', 'steps'] as const) delete entry[key];
  validateEntry(entry);
  return entry;
}

function validateEntry(entry: DayPlanEntry) {
  if (!entry.title || !entry.id || !entry.targetScheduleId || !entry.targetTodoId) throw new Error('invalid-day-plan-entry');
  if (!['schedule', 'inbox', 'cancel'].includes(entry.action)) throw new Error('invalid-day-plan-action');
  if (entry.action === 'cancel' && !entry.occurrenceId && !entry.habitId && !entry.todoId) throw new Error('schedule-target-required');
  if (entry.action === 'inbox' && entry.occurrenceId && !entry.steps?.length) throw new Error('existing-schedule-requires-cancellation');
  if (entry.action === 'schedule' && (!Number.isFinite(entry.startAt) || Math.abs(entry.startAt!) > 8.64e15
    || (entry.endAt !== undefined && (!Number.isFinite(entry.endAt) || entry.endAt <= entry.startAt! || Math.abs(entry.endAt) > 8.64e15)))) {
    throw new Error('invalid-day-plan-time');
  }
  if (!Number.isFinite(entry.reminderMinutesBefore) || entry.reminderMinutesBefore < 0) throw new Error('invalid-reminder-minutes');
  if (entry.durationMinutes !== undefined && (!Number.isFinite(entry.durationMinutes) || entry.durationMinutes <= 0
    || entry.endAt !== undefined && entry.endAt - entry.startAt! !== entry.durationMinutes * 60000)) throw new Error('schedule-duration-conflict');
}

type Source = { occurrence: ScheduleOccurrence | null; item: ScheduleItem | null };
type Interval = { start: number; end: number };
const interval = (start: number, end?: number): Interval => ({ start, end: end ?? start + 30 * 60_000 });
const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;
const destination = (entry: DayPlanEntry) => entry.action === 'schedule' ? interval(entry.startAt!, entry.endAt) : null;

function sameSchedule(item: ScheduleItem, entry: DayPlanEntry) {
  if (entry.readingChoice) {
    const actual = item.execution?.readingChoice;
    if (!actual || actual.sourceId !== entry.readingChoice.sourceId) return false;
    if ('version' in entry.readingChoice && (!('version' in actual) || actual.operationId !== entry.readingChoice.operationId)) return false;
  }
  if (entry.duration) return item.execution?.durationChange?.operationId === entry.id
    && (entry.duration.minutes === undefined || item.execution.durationChange.remainingMs === entry.duration.minutes * 60_000)
    && item.title === entry.title && item.notes === entry.notes && item.owner === entry.owner
    && (item.readingId ?? null) === (entry.readingId ?? null) && (item.habitId ?? null) === (entry.habitId ?? null);
  return item.status === (entry.action === 'cancel' ? 'cancelled' : 'pending') && item.title === entry.title && item.notes === entry.notes
    && (item.owner ?? 'you') === (entry.owner ?? 'you')
    && (!entry.owned || ((item.readingId ?? null) === (entry.readingId ?? null) && (item.habitId ?? null) === (entry.habitId ?? null)))
    && item.startAt === entry.startAt && item.endAt === entry.endAt
    && item.reminderMinutesBefore === entry.reminderMinutesBefore
    && (entry.action === 'cancel' || item.companionEnabled === (entry.endAt !== undefined && entry.companionEnabled))
    && item.todoId === (entry.todoId ?? (entry.parentTodoId ? entry.targetTodoId : undefined))
    && (entry.startReminderEnabled === undefined || item.startReminderEnabled === entry.startReminderEnabled)
    && (entry.endMode === undefined || item.endMode === entry.endMode)
    && (entry.durationMinutes === undefined || item.durationMinutes === entry.durationMinutes);
}

/** Read-only receipt recovery; never creates a horizon, writes a schedule or finishes a todo. */
export async function isDayPlanSchedulePersisted(entry: DayPlanEntry): Promise<boolean> {
  if (entry.action !== 'schedule' && entry.action !== 'cancel') return false;
  const item = await loadScheduleItemById(entry.targetScheduleId);
  if (entry.choiceUpdate) {
    const choice = (await loadScheduleItemById(entry.choiceUpdate.sourceId))?.execution?.readingChoice;
    if (!choice || !('version' in choice) || choice.operationId !== entry.choiceUpdate.operationId) return false;
  }
  if (item?.recurrence === 'none' && entry.owned && entry.action === 'schedule' && item.status === 'completed'
    && item.execution?.status === 'completed'
    && (item.execution.activityId === `schedule:${item.id}` || item.execution.completionId === `schedule:${item.id}`)
    && sameSchedule({ ...item, status: 'pending' }, entry)) {
    const completed = await loadScheduleOccurrence(`${item.id}:${entry.startAt}`);
    return completed?.itemId === item.id && completed.status === 'completed';
  }
  if (!item || item.recurrence !== 'none' || !sameSchedule(item, entry)) return false;
  const occurrence = await loadScheduleOccurrence(entry.action === 'cancel' ? entry.occurrenceId! : `${item.id}:${entry.duration ? item.startAt : entry.startAt}`);
  return occurrence?.itemId === item.id && (occurrence.status === (entry.action === 'cancel' ? 'cancelled' : 'pending')
    || !!entry.duration && occurrence.status === 'completed');
}

async function invalidateEvents(database: SQLiteDatabase, occurrenceId: string, cancelled: boolean, now: number) {
  await database.runAsync(
    `UPDATE schedule_companion_events SET preparation_json = NULL, reminder_body_json = NULL,
     status = CASE WHEN ? = 1 THEN 'quiet' ELSE status END, updated_at = ? WHERE occurrence_id = ?`,
    cancelled ? 1 : 0, now, occurrenceId,
  );
}

async function writeSchedule(database: SQLiteDatabase, entry: DayPlanEntry, source: Source, duration?: ScheduleDurationReceipt, activityReadingId?: string) {
  const now = duration?.effectiveAt ?? Date.now();
  if (entry.action === 'cancel' || entry.action === 'inbox' && entry.occurrenceId && entry.steps?.length) {
    const result = await database.runAsync(
      "UPDATE schedule_occurrences SET status = 'cancelled' WHERE id = ? AND status = 'pending'", entry.occurrenceId!,
    );
    if (!result.changes) {
      const row = await database.getFirstAsync<{ status: string }>('SELECT status FROM schedule_occurrences WHERE id = ?', entry.occurrenceId!);
      if (row?.status !== 'cancelled') throw new Error('schedule-target-changed');
    }
    if (source.item?.recurrence === 'none') {
      const execution = adjustedScheduleExecution(source.item, entry.id, now, 'cancel');
      await database.runAsync("UPDATE schedule_items SET status = 'cancelled', execution_json = ?, updated_at = ? WHERE id = ?",
        execution ? JSON.stringify(execution) : null, now, source.item.id);
    }
    await invalidateEvents(database, entry.occurrenceId!, true, now);
    return;
  }
  const item = source.item;
  const oldOccurrence = source.occurrence;
  const targetId = entry.targetScheduleId;
  const targetOccurrenceId = `${targetId}:${entry.startAt}`;
  const todoId = entry.todoId ?? (entry.parentTodoId ? entry.targetTodoId : undefined);
  const completionKey = item?.habitCompletionKey ?? (item?.habitId && oldOccurrence ? oldOccurrence.id : undefined);
  const selectedChoice = entry.choiceUpdate ?? (entry.readingChoice && 'version' in entry.readingChoice ? entry.readingChoice : undefined);
  let previousChoice = item?.execution?.readingChoice;
  if (previousChoice && !('version' in previousChoice)) {
    const root = await database.getFirstAsync<{ execution_json: string | null }>('SELECT execution_json FROM schedule_items WHERE id = ?', previousChoice.sourceId);
    previousChoice = root?.execution_json ? (JSON.parse(root.execution_json) as ScheduleExecution).readingChoice : undefined;
  }
  const previousReadingId = previousChoice && 'version' in previousChoice ? previousChoice.currentReadingId : item?.readingId;
  const replacesCurrent = !!item?.execution && item.execution.status !== 'planned' && item.execution.status !== 'ended'
    && item.execution.status !== 'completed' && !!selectedChoice && selectedChoice.currentReadingId !== previousReadingId
    && selectedChoice.currentReadingId !== (activityReadingId ?? previousReadingId);
  const withChoice = (value: ScheduleExecution | undefined): ScheduleExecution | undefined => {
    const readingChoice = entry.readingChoice ?? item?.execution?.readingChoice;
    if (!readingChoice) return value;
    return { ...(value ?? { status: 'planned', updatedAt: now, planRevision: 1,
      totalPlannedMs: Math.max(0, (entry.endAt ?? entry.startAt!) - entry.startAt!) }), readingChoice };
  };
  if (item?.recurrence === 'none') {
    const choiceOnly = !entry.duration && !!entry.readingChoice && entry.startAt === item.startAt && entry.endAt === item.endAt
      && !replacesCurrent;
    let execution = withChoice(choiceOnly ? item.execution ?? undefined : duration?.execution ?? adjustedScheduleExecution(item, entry.id, now, 'reschedule'));
    if (replacesCurrent && execution && item.execution?.status !== 'planned' && item.execution?.activityId) {
      execution = { ...execution, planRevision: Math.max(execution.planRevision ?? 0, (item.execution.planRevision ?? 0) + 1),
        activityPlanRevision: item.execution.activityPlanRevision ?? item.execution.planRevision ?? 0,
        completionId: item.execution.completionId ?? item.execution.activityId,
        originOccurrenceId: item.execution.originOccurrenceId ?? `${item.id}:${item.startAt}`,
        adjustment: { operationId: entry.id, changedAt: now, action: 'reschedule', pending: true,
          ...(!entry.duration?.changeStart ? { readingReplacement: true } : {}) },
        ...(execution.durationChange ? { durationChange: { ...execution.durationChange, pending: false } } : {}) };
    }
    await database.runAsync(
      `UPDATE schedule_items SET title = ?, notes = ?, start_at = ?, end_at = ?,
       reminder_minutes_before = ?, companion_enabled = ?, todo_id = ?, reading_id = ?, habit_id = ?, execution_json = ?,
       start_reminder_enabled = ?, end_mode = ?, duration_minutes = ?, habit_completion_key = ?, updated_at = ? WHERE id = ?`,
      entry.title, entry.notes, entry.startAt!, entry.endAt ?? null, entry.reminderMinutesBefore,
      entry.endAt !== undefined && entry.companionEnabled ? 1 : 0, todoId ?? null,
      entry.owned ? entry.readingId ?? null : item.readingId ?? null,
      entry.owned ? entry.habitId ?? null : item.habitId ?? null, execution ? JSON.stringify(execution) : null,
      entry.startReminderEnabled === undefined ? item.startReminderEnabled === undefined ? null : Number(item.startReminderEnabled) : Number(entry.startReminderEnabled),
      (entry.owned ? entry.endMode ?? item.endMode : entry.endMode) ?? null,
      (entry.owned ? entry.durationMinutes ?? item.durationMinutes : entry.durationMinutes) ?? null, completionKey ?? null, now, item.id,
    );
  } else {
    await database.runAsync(
      `INSERT INTO schedule_items (id, title, notes, start_at, end_at, reminder_minutes_before,
       recurrence, status, reminder_text, reminder_intensity, source, habit_id, todo_id, goal_id,
       plan_id, companion_enabled, letter_ticket_enabled, created_at, updated_at, owner, reading_id, execution_json,
       start_reminder_enabled, end_mode, duration_minutes, habit_completion_key)
       VALUES (?, ?, ?, ?, ?, ?, 'none', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      targetId, entry.title, entry.notes, entry.startAt!, entry.endAt ?? null, entry.reminderMinutesBefore,
      item?.reminderText ?? entry.title, item?.reminderIntensity ?? 'gentle', item?.source ?? 'ai',
      entry.owned ? entry.habitId ?? null : item?.habitId ?? null, todoId ?? null, item?.goalId ?? null, item?.planId ?? null,
      entry.endAt !== undefined && entry.companionEnabled ? 1 : 0, item?.letterTicketEnabled ? 1 : 0, now, now,
      entry.owner ?? item?.owner ?? 'you', entry.owned ? entry.readingId ?? null : item?.readingId ?? null,
      withChoice(duration?.execution ?? item?.execution ?? undefined) ? JSON.stringify(withChoice(duration?.execution ?? item?.execution ?? undefined)) : null,
      entry.startReminderEnabled === undefined ? null : Number(entry.startReminderEnabled), entry.endMode ?? null, entry.durationMinutes ?? null, completionKey ?? null,
    );
  }
  if (oldOccurrence && oldOccurrence.id !== targetOccurrenceId) {
    await database.runAsync("UPDATE schedule_occurrences SET status = 'cancelled' WHERE id = ?", oldOccurrence.id);
    await invalidateEvents(database, oldOccurrence.id, true, now);
  }
  await database.runAsync(
    `INSERT INTO schedule_occurrences (id, item_id, scheduled_start_at, reminder_at, status)
     VALUES (?, ?, ?, ?, 'pending') ON CONFLICT(id) DO UPDATE SET reminder_at = excluded.reminder_at,
     status = CASE WHEN schedule_occurrences.status = 'cancelled' THEN 'pending' ELSE schedule_occurrences.status END`,
    targetOccurrenceId, targetId, entry.startAt!, entry.owned ? entry.startAt! - entry.reminderMinutesBefore * 60_000
      : chatScheduleReminderAt(entry.startAt!, entry.reminderMinutesBefore, now),
  );
  await invalidateEvents(database, targetOccurrenceId, false, now);
  if (entry.choiceUpdate && entry.choiceUpdate.sourceId !== targetId) {
    const row = await database.getFirstAsync<{ execution_json: string | null; start_at: number; end_at: number | null }>(
      'SELECT execution_json, start_at, end_at FROM schedule_items WHERE id = ?', entry.choiceUpdate.sourceId);
    if (!row) throw new Error('reading-choice-source-changed');
    const execution = row.execution_json ? JSON.parse(row.execution_json) as ScheduleExecution : { status: 'planned', updatedAt: now,
      planRevision: 1, totalPlannedMs: Math.max(0, (row.end_at ?? row.start_at) - row.start_at) };
    await database.runAsync('UPDATE schedule_items SET execution_json = ?, updated_at = ? WHERE id = ?',
      JSON.stringify({ ...execution, readingChoice: entry.choiceUpdate }), now, entry.choiceUpdate.sourceId);
  }
}

async function validateReadingChoice(database: SQLiteDatabase, entry: DayPlanEntry) {
  if (!entry.readingChoice) return;
  if (entry.owner !== 'I') throw new Error('schedule-owner-forbidden');
  const sourceId = entry.readingChoice.sourceId;
  const row = await database.getFirstAsync<{ id: string; owner: ScheduleOwner; execution_json: string | null; reading_id: string | null;
    title: string; notes: string; start_at: number; end_at: number | null; status: ScheduleItem['status']; recurrence: ScheduleItem['recurrence']; habit_id: string | null }>(
    'SELECT * FROM schedule_items WHERE id = ?', sourceId);
  if (!row && sourceId === entry.targetScheduleId && !entry.occurrenceId && entry.choiceExpectedVersion === 0) return;
  if (!row || row.owner !== 'I') throw new Error('reading-choice-source-changed');
  const choice = row.execution_json ? (JSON.parse(row.execution_json) as ScheduleExecution).readingChoice : undefined;
  const version = choice && 'version' in choice ? choice.version : 0;
  const update = entry.choiceUpdate ?? ('version' in entry.readingChoice ? entry.readingChoice : undefined);
  if (update && choice && 'operationId' in choice && choice.operationId === update.operationId) return;
  if (version !== entry.choiceExpectedVersion || choice && choice.sourceId !== sourceId) throw new Error('reading-choice-source-changed');
  if (!choice && (!row.reading_id || entry.choiceSourcePlanVersion !== undefined && schedulePlanVersion({
    id: row.id, owner: row.owner, title: row.title, notes: row.notes, startAt: row.start_at, endAt: row.end_at ?? undefined,
    status: row.status, recurrence: row.recurrence, readingId: row.reading_id, habitId: row.habit_id ?? undefined,
    execution: row.execution_json ? JSON.parse(row.execution_json) : undefined,
  } as ScheduleItem) !== entry.choiceSourcePlanVersion)) throw new Error('reading-choice-source-changed');
}

async function finishTodo(entry: DayPlanEntry) {
  if (entry.owned) return;
  if (entry.action === 'cancel') {
    if (entry.todoId && !entry.habitId) {
      const existing = await loadTodoItemById(entry.todoId, { promoteDue: false });
      if (existing?.status === 'cancelled') return;
      if (!existing || !await cancelTodoItem(entry.todoId, entry.sourceTodoUpdatedAt)) throw new Error('todo-target-changed');
    }
    return;
  }
  const todoId = entry.todoId ?? (entry.action === 'inbox' || entry.parentTodoId ? entry.targetTodoId : undefined);
  if (!todoId) return;
  const existing = await loadTodoItemById(todoId, { promoteDue: false });
  const plannedForDate = entry.action === 'schedule' ? dateKey(entry.startAt!) : undefined;
  const status = plannedForDate ? 'scheduled' : 'inbox';
  if (existing) {
    if (!open(existing.status) || existing.type !== 'normal') throw new Error('todo-target-unavailable');
    // A previous attempt may have saved the row before its card result was persisted.
    if (existing.title === entry.title && existing.notes === entry.notes
      && existing.plannedForDate === plannedForDate && existing.status === status
      && existing.parentTodoId === entry.parentTodoId && existing.parentOccurrenceId === entry.parentOccurrenceId
      && (!entry.steps?.length || !entry.habitId || existing.habitId === entry.habitId)) return;
    if (!entry.todoId || existing.updatedAt !== entry.sourceTodoUpdatedAt) throw new Error('todo-target-changed');
    // Existing undated todos remain their original record, including priority and reminder history.
    const changed = await updateTodoItem(todoId, {
      title: entry.title, notes: entry.notes, plannedForDate: plannedForDate ?? '', status,
      parentTodoId: entry.parentTodoId, parentOccurrenceId: entry.parentOccurrenceId, stepOrder: entry.stepOrder,
      ...(entry.steps?.length ? { estimatedMinutes: 0, ...(entry.habitId ? { habitId: entry.habitId } : {}) } : {}),
    }, entry.sourceTodoUpdatedAt);
    if (!changed) throw new Error('todo-target-changed');
  } else {
    if (entry.todoId) throw new Error('todo-target-unavailable');
    await createTodoItem({
      title: entry.title, notes: entry.notes, source: 'ai', priority: 'normal',
      type: 'normal', reminderMode: entry.parentTodoId ? 'none' : 'gentle', plannedForDate,
      parentTodoId: entry.parentTodoId, parentOccurrenceId: entry.parentOccurrenceId, stepOrder: entry.stepOrder,
      habitId: entry.steps?.length ? entry.habitId ?? undefined : undefined,
      estimatedMinutes: entry.steps?.length ? undefined : entry.durationMinutes,
    }, status, entry.targetTodoId);
  }
}

function saveHabitEntry(entry: DayPlanEntry) {
  return (async () => saveChatHabitPlan({ id: entry.targetHabitId!, title: entry.title, notes: entry.notes,
    effectiveAt: entry.occurrenceId ? (await loadScheduleOccurrence(entry.occurrenceId))?.scheduledStartAt : undefined,
    startAt: entry.startAt!, endMode: entry.endMode, endAt: entry.endMode === 'fixed' ? entry.endAt : undefined,
    durationMinutes: entry.endMode === 'fixed' ? undefined : entry.durationMinutes ?? (entry.endAt === undefined ? undefined : (entry.endAt - entry.startAt!) / 60000),
    repeat: entry.repeat!, reminderMinutesBefore: entry.reminderMinutesBefore,
    startReminderEnabled: entry.startReminderEnabled !== false, companionEnabled: entry.companionEnabled,
    sourceUpdatedAt: entry.sourceHabitUpdatedAt, scope: entry.scope }))();
}

export async function saveDayPlanEntries<T extends DayPlanEntry>(entries: T[], context?: ScheduleSaveContext): Promise<T[]> {
  const result = entries.map((entry) => ({ ...entry }));
  const sources = new Map<string, Source>();
  const active: DayPlanEntry[] = [];
  const blockedSteps = new Set<string>();
  const organizedHabits = new Set<string>();
  // A habit rule is saved first, then its real current occurrence is replaced by
  // the organizing todo and current steps. Future occurrences keep the rule.
  for (const parent of result.filter(entry => entry.action === 'inbox' && entry.steps?.length && entry.repeat && !entry.saved)) {
    try {
      validateEntry(parent);
      if (organizedHabits.has(parent.targetHabitId!)) throw new Error('duplicate-habit-target');
      organizedHabits.add(parent.targetHabitId!);
      if (!parent.scheduleSaved && !parent.habitSaved && parent.occurrenceId) {
        const original = await loadScheduleOccurrence(parent.occurrenceId);
        const item = original && await loadScheduleItemById(original.itemId);
        if (!original || !item || original.status !== 'pending' || item.owner === 'I'
          || item.updatedAt !== parent.sourceUpdatedAt) throw new Error('schedule-target-changed');
      }
      if (!parent.scheduleSaved && (!parent.habitId || parent.scope === 'future')) {
        const saved = await saveHabitEntry(parent);
        parent.habitSaved = true;
        if (!saved.nextOccurrence) throw new Error('habit-occurrence-not-found');
        const item = await loadScheduleItemById(saved.nextOccurrence.itemId);
        if (!item || item.owner === 'I') throw new Error('habit-source-unavailable');
        parent.occurrenceId = saved.nextOccurrence.id;
        parent.habitId = saved.habit.id; parent.sourceUpdatedAt = item.updatedAt;
        parent.sourceHabitUpdatedAt = saved.habit.updatedAt;
      }
      if (!parent.occurrenceId || !parent.habitId) throw new Error('habit-source-unavailable');
      parent.parentOccurrenceId = parent.occurrenceId;
      for (const child of result.filter(entry => entry.parentTodoId === parent.targetTodoId)) child.parentOccurrenceId = parent.occurrenceId;
    } catch (error) {
      const receipt = error as { habitSaved?: boolean; habitId?: string };
      if (receipt.habitSaved === true && receipt.habitId === parent.targetHabitId) parent.habitSaved = true;
      parent.error = error instanceof Error ? error.message : 'habit-save-failed';
      blockedSteps.add(parent.id);
      for (const child of result.filter(entry => entry.parentTodoId === parent.targetTodoId)) {
        child.error = 'parent-save-failed'; blockedSteps.add(child.id);
      }
    }
  }
  const durations = new Map<string, ScheduleDurationReceipt>();
  const applyDuration = (entry: DayPlanEntry, item: ScheduleItem | null) => {
    if (!entry.duration) return;
    if (!context) throw new Error('schedule-duration-context-unavailable');
    const resolved = resolveScheduleDuration({ id: entry.id, startAt: entry.startAt!, duration: entry.duration }, item, context);
    entry.startAt = resolved.startAt; entry.endAt = resolved.endAt;
    durations.set(entry.id, resolved);
  };
  const proposedTime = (entry: DayPlanEntry) => {
    const resolved = durations.get(entry.id);
    if (resolved?.execution.resumeUnscheduled) return null;
    const value = destination(entry);
    const execution = sources.get(entry.id)?.item?.execution;
    return value && resolved && execution && execution.status !== 'planned' && !entry.duration?.changeStart
      ? { start: resolved.effectiveAt, end: value.end } : value;
  };
  const usedOccurrences = new Set<string>();
  const usedTodos = new Set<string>();
  const usedHabits = new Set<string>();
  await ensureScheduleHorizon();
  for (const entry of result) {
    if (entry.saved || blockedSteps.has(entry.id)) continue;
    entry.error = undefined;
    entry.conflict = undefined;
    try {
      validateEntry(entry);
      if (entry.repeat && (entry.action === 'cancel' || !entry.steps?.length) && (!entry.habitId || entry.scope === 'future')) {
        if (usedHabits.has(entry.targetHabitId!)) throw new Error('duplicate-habit-target');
        usedHabits.add(entry.targetHabitId!);
        continue;
      }
      if (entry.occurrenceId && usedOccurrences.has(entry.occurrenceId)) throw new Error('duplicate-schedule-target');
      if (entry.todoId && usedTodos.has(entry.todoId)) throw new Error('duplicate-todo-target');
      if (entry.occurrenceId) usedOccurrences.add(entry.occurrenceId);
      if (entry.todoId) usedTodos.add(entry.todoId);
      const occurrence = entry.occurrenceId ? await loadScheduleOccurrence(entry.occurrenceId) : null;
      const item = occurrence ? await loadScheduleItemById(occurrence.itemId) : null;
      if (item && (item.owner ?? 'you') !== (entry.owner ?? 'you')) throw new Error('schedule-owner-forbidden');
      if (entry.owned && entry.owner !== 'I' && entry.owner !== 'I 和 you') throw new Error('schedule-owner-forbidden');
      sources.set(entry.id, { occurrence, item });
      const target = entry.action === 'schedule' ? await loadScheduleItemById(entry.targetScheduleId) : null;
      const targetOccurrence = target ? await loadScheduleOccurrence(`${target.id}:${entry.duration ? target.startAt : entry.startAt}`) : null;
      const sourceChoice = entry.choiceUpdate ? (await loadScheduleItemById(entry.choiceUpdate.sourceId))?.execution?.readingChoice : undefined;
      const choiceWritten = !entry.choiceUpdate || sourceChoice && 'operationId' in sourceChoice && sourceChoice.operationId === entry.choiceUpdate.operationId;
      const alreadyWritten = target && sameSchedule(target, entry) && choiceWritten && targetOccurrence?.status === 'pending';
      if (entry.scheduleSaved && entry.action === 'schedule' && !alreadyWritten) throw new Error('schedule-target-changed');
      if (entry.scheduleSaved && entry.action === 'cancel' && entry.occurrenceId && occurrence?.status !== 'cancelled') throw new Error('schedule-target-changed');
      if (alreadyWritten) { entry.scheduleSaved = true; if (!entry.owned) entry.savedOccurrenceId = targetOccurrence!.id; if (entry.duration) { entry.startAt = target.startAt; entry.endAt = target.endAt; } }
      if (entry.action === 'cancel' && occurrence?.status === 'cancelled') entry.scheduleSaved = true;
      if (entry.action === 'inbox' && entry.steps?.length && occurrence?.status === 'cancelled') entry.scheduleSaved = true;
      if (entry.duration && !entry.scheduleSaved && item?.status === 'cancelled') throw new Error('schedule-duration-cancelled');
      if (entry.duration && !entry.scheduleSaved && (item?.status === 'completed' || item?.execution?.status === 'completed'
        || item?.execution?.status === 'ended' && (entry.duration.minutes !== undefined || !entry.duration.changeStart))) throw new Error('schedule-duration-ended');
      if (entry.occurrenceId && !entry.scheduleSaved && (!occurrence || !item || occurrence.status !== 'pending'
        || item.status !== 'pending' || (entry.sourcePlanVersion === undefined ? item.updatedAt !== entry.sourceUpdatedAt
          : schedulePlanVersion(item) !== entry.sourcePlanVersion))) throw new Error('schedule-target-changed');
      if (target && !alreadyWritten && target.id !== item?.id) throw new Error('schedule-target-changed');
      if (!entry.scheduleSaved) applyDuration(entry, item);
      if (entry.todoId) {
        const todo = await loadTodoItemById(entry.todoId, { promoteDue: false });
        if (entry.action === 'cancel' && !entry.occurrenceId && todo?.status === 'cancelled') { entry.saved = true; continue; }
        if (!todo || !open(todo.status) || todo.type !== 'normal') throw new Error('todo-target-unavailable');
        if (!entry.scheduleSaved && todo.updatedAt !== entry.sourceTodoUpdatedAt) throw new Error('todo-target-changed');
      }
      active.push(entry);
    } catch (error) {
      entry.error = error instanceof Error ? error.message : 'day-plan-save-failed';
    }
  }

  // Old and proposed occupied times connect only the moves that must succeed together (e.g. swaps).
  const intervals = (entry: DayPlanEntry) => {
    const before = sources.get(entry.id)?.occurrence;
    return [before ? interval(before.scheduledStartAt, before.endAt) : null, proposedTime(entry)]
      .filter((value): value is Interval => !!value);
  };
  const waiting = active.filter((entry) => !entry.scheduleSaved && (entry.action === 'schedule' || !!entry.occurrenceId));
  const groups: DayPlanEntry[][] = [];
  while (waiting.length) {
    const group = [waiting.shift()!];
    for (let cursor = 0; cursor < group.length; cursor += 1) {
      for (let index = waiting.length - 1; index >= 0; index -= 1) {
        if (group[cursor].parentTodoId === waiting[index].targetTodoId || waiting[index].parentTodoId === group[cursor].targetTodoId
          || group[cursor].choiceDependencyIds?.includes(waiting[index].id) || waiting[index].choiceDependencyIds?.includes(group[cursor].id)
          || scheduleOwnersOverlap(group[cursor].owner, waiting[index].owner)
          && intervals(group[cursor]).some((a) => intervals(waiting[index]).some((b) => overlaps(a, b)))) {
          group.push(waiting.splice(index, 1)[0]);
        }
      }
    }
    groups.push(group);
  }
  const database = await getScheduleDatabase();
  for (const group of groups) {
    try {
      await database.withExclusiveTransactionAsync(async (transaction) => {
        context = context?.at?.(Date.now()) ?? context;
        const replaced = new Set(group.map((entry) => entry.occurrenceId).filter(Boolean));
        for (const entry of group) {
          const source = sources.get(entry.id)!;
          if (source.item && source.occurrence) {
            const latest = await transaction.getFirstAsync<{ owner: ScheduleOwner; updated_at: number; status: ScheduleItem['status']; occurrence_status: string;
              title: string; notes: string; start_at: number; end_at: number | null; reading_id: string | null;
              habit_id: string | null; recurrence: ScheduleItem['recurrence']; execution_json: string | null }>(
              `SELECT i.*, o.status AS occurrence_status FROM schedule_items i
               JOIN schedule_occurrences o ON o.item_id = i.id WHERE o.id = ?`, source.occurrence.id,
            );
            const current = latest ? { ...source.item, owner: latest.owner, updatedAt: latest.updated_at,
              title: latest.title, notes: latest.notes, startAt: latest.start_at, endAt: latest.end_at ?? undefined,
              status: latest.status, recurrence: latest.recurrence, readingId: latest.reading_id,
              habitId: latest.habit_id ?? undefined, execution: latest.execution_json ? JSON.parse(latest.execution_json) : undefined } : null;
            if (entry.duration && current?.status === 'cancelled') throw new Error('schedule-duration-cancelled');
            if (entry.duration && (current?.status === 'completed' || current?.execution?.status === 'completed'
              || current?.execution?.status === 'ended' && (entry.duration.minutes !== undefined || !entry.duration.changeStart))) throw new Error('schedule-duration-ended');
            if (!latest || !current || (latest.owner ?? 'you') !== (entry.owner ?? 'you')
              || (entry.sourcePlanVersion === undefined ? latest.updated_at !== entry.sourceUpdatedAt
                : schedulePlanVersion(current) !== entry.sourcePlanVersion)
              || latest.status !== 'pending' || latest.occurrence_status !== 'pending') {
              throw new Error('schedule-target-changed');
            }
            if (entry.duration && (current.execution?.status !== source.item.execution?.status
              || current.execution?.activityId !== source.item.execution?.activityId
              || current.execution?.activityPlanRevision !== source.item.execution?.activityPlanRevision)) {
              throw new Error('schedule-duration-context-unavailable');
            }
            source.item = current;
          }
          applyDuration(entry, source.item);
        }
        for (const entry of group) {
          const proposed = proposedTime(entry);
          if (!proposed) continue;
          const sleep = entry.duration ? context?.sleepIntervals.find(v => v.start < proposed.end && proposed.start < v.end) : undefined;
          if (sleep) {
            entry.conflict = { startAt: proposed.start, endAt: proposed.end, title: sleep.title ?? '', kind: 'sleep', conflictStartAt: sleep.start, conflictEndAt: sleep.end };
            throw new Error('schedule-time-conflict');
          }
          const occupied = await transaction.getAllAsync<{ id: string; owner: ScheduleOwner; title: string; scheduled_start_at: number; end_at: number | null; start_at: number; execution_json: string | null }>(
            `SELECT o.id, i.owner, i.title, o.scheduled_start_at, i.start_at, i.end_at, i.execution_json FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
             WHERE o.status = 'pending' AND i.status = 'pending' AND o.scheduled_start_at < ?
             AND (o.scheduled_start_at + COALESCE(i.end_at - i.start_at, 1800000) > ?
             OR CASE WHEN json_valid(i.execution_json) THEN json_extract(i.execution_json, '$.estimatedEndAt') ELSE NULL END > ?)`, proposed.end, proposed.start, proposed.start,
          );
          const occupiedTime = (row: typeof occupied[number]) => scheduleOccupiedInterval({ startAt: row.scheduled_start_at,
            endAt: row.end_at === null ? undefined : row.scheduled_start_at + row.end_at - row.start_at,
            execution: row.execution_json ? JSON.parse(row.execution_json) : undefined } as ScheduleItem, context?.now ?? Date.now());
          const blocking = occupied.find(row => { const value = occupiedTime(row);
            return !replaced.has(row.id) && scheduleOwnersOverlap(row.owner, entry.owner) && value && overlaps(proposed, value); });
          if (blocking) {
            entry.conflict = { startAt: proposed.start, endAt: proposed.end, title: blocking.title,
              conflictStartAt: occupiedTime(blocking)!.start, conflictEndAt: occupiedTime(blocking)!.end };
            throw new Error('schedule-time-conflict');
          }
          const other = group.find(other => other !== entry && scheduleOwnersOverlap(other.owner, entry.owner) && proposedTime(other) && overlaps(proposed, proposedTime(other)!));
          if (other) {
            entry.conflict = { startAt: proposed.start, endAt: proposed.end, title: other.title,
              conflictStartAt: proposedTime(other)!.start, conflictEndAt: proposedTime(other)!.end };
            throw new Error('schedule-time-conflict');
          }
        }
        const written = new Set(result.filter(e => e.saved || e.scheduleSaved).map(e => e.id));
        const pending = [...group];
        while (pending.length) {
          const index = pending.findIndex(e => (e.choiceDependencyIds ?? []).every(id => written.has(id)));
          if (index < 0) throw new Error('reading-choice-dependency-pending');
          const entry = pending.splice(index, 1)[0];
          await validateReadingChoice(transaction, entry);
          await writeSchedule(transaction, entry, sources.get(entry.id)!, durations.get(entry.id), context?.activityReadingIds?.[entry.targetScheduleId]);
          written.add(entry.id);
        }
      });
      for (const entry of group) { entry.scheduleSaved = true; if (!entry.owned && entry.action === 'schedule') entry.savedOccurrenceId = `${entry.targetScheduleId}:${entry.startAt}`; }
    } catch (error) {
      for (const entry of group) entry.error = error instanceof Error ? error.message : 'day-plan-save-failed';
    }
  }
  for (const entry of active) {
    if (entry.error) continue;
    try {
      await finishTodo(entry);
      entry.saved = true;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : 'todo-save-failed';
    }
  }
  // Habit and schedule/todo databases retain their existing separate commits and honest partial receipts.
  for (const entry of result.filter(value => !value.saved && !value.error && value.repeat && (value.action === 'cancel' || !value.steps?.length) && (!value.habitId || value.scope === 'future'))) {
    try {
      if (entry.action === 'cancel') {
        await archiveChatHabitPlan(entry.habitId!, entry.startAt ?? Date.now(), entry.sourceHabitUpdatedAt);
      } else {
        const saved = await saveHabitEntry(entry);
        entry.habitSaved = true;
        entry.savedOccurrenceId = saved.nextOccurrence?.id;
      }
      entry.scheduleSaved = true; entry.saved = true;
    } catch (error) {
      const receipt = error as { habitSaved?: boolean; habitId?: string };
      if (receipt.habitSaved === true && receipt.habitId === entry.targetHabitId) entry.habitSaved = true;
      entry.error = error instanceof Error ? error.message : 'habit-save-failed';
    }
  }
  return result;
}
