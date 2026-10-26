import {
  captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { runScheduleSemanticCaptureExclusive } from '../sync/syncScheduleSemanticCaptureQueue';
import { chatHabitCandidateTimes, chatHabitFixedEndAt, chatHabitIntervalStart, chatHabitWeekdayStart, validateChatHabitPlan, type ChatHabitPlanInput } from './chatHabitSchedulePolicy';
import { loadHabitById, loadHabitLogForDate, recordYouHabitOccurrenceCompletion, type Habit } from './habitStore';
import { getTodoDatabase } from './todoDatabase';
import { loadTodoItemById, loadTodoSteps, type TodoItem } from './todoStore';
import { getScheduleDatabase } from './scheduleDatabase';
import { cancelNotifications } from './scheduleNotifications';
import { completeScheduleOccurrenceOnce } from './scheduleCompletionOnce';
import {
  createScheduleItem, dateKey, ensureScheduleHorizon, loadPendingScheduleOccurrencesBetween,
  loadScheduleItemsByHabitId, loadScheduleOccurrence, loadScheduleItemById, type ScheduleDraft,
} from './scheduleStore';

export type { ChatHabitPlanInput } from './chatHabitSchedulePolicy';

let habitWriteQueue = Promise.resolve();
function withHabitWrite<T>(work: (assertCurrent: () => void) => Promise<T>, sourceCurrent?: () => boolean | Promise<boolean>) {
  const epoch = captureBackupRestoreDataEpoch();
  const task = habitWriteQueue.catch(() => undefined).then(async () => {
    const assertCurrent = () => { if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('habit-restore-interrupted'); };
    const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
      assertCurrent();
      if (sourceCurrent && !await sourceCurrent()) throw new Error('habit-source-changed');
      assertCurrent();
      const value = await work(assertCurrent);
      assertCurrent();
      return value;
    });
    if (!result.committed) throw new Error('habit-restore-interrupted');
    return result.value;
  });
  habitWriteQueue = task.then(() => undefined, () => undefined);
  return task;
}

function rulePrefix(habit: Habit) { return `${habit.id}:chat:${habit.scheduleInstances.ruleUpdatedAt}:`; }
const chatHabit = (habit: Habit) => habit.owner !== 'I' && habit.kind === 'habit' && habit.scheduleInstances.ruleUpdatedAt !== undefined;

async function habitTodoBinding(todo: TodoItem) {
  if (todo.type !== 'normal' || todo.status !== 'completed' || todo.parentTodoId || !todo.habitId || !todo.parentOccurrenceId
    || !Number.isSafeInteger(todo.completedAt) || todo.completedAt! < 0 || todo.completedAt! > Date.now()) return null;
  const occurrence = await loadScheduleOccurrence(todo.parentOccurrenceId);
  const item = occurrence ? await loadScheduleItemById(occurrence.itemId) : null;
  const habit = await loadHabitById(todo.habitId);
  if (!occurrence || !item || !habit || habit.owner === 'I' || habit.kind !== 'habit'
    || occurrence.owner !== 'you' || (item.owner ?? 'you') !== 'you'
    || occurrence.source !== 'habit' || item.source !== 'habit'
    || occurrence.habitId !== habit.id || item.habitId !== habit.id
    || !['cancelled', 'completed'].includes(occurrence.status)) return null;
  const key = item.habitCompletionKey ?? occurrence.id;
  if (occurrence.habitCompletionKey !== item.habitCompletionKey) return null;
  const origin = key === occurrence.id ? occurrence : await loadScheduleOccurrence(key);
  if (!origin || origin.owner !== 'you' || origin.source !== 'habit' || origin.habitId !== habit.id) return null;
  if (chatHabit(habit)) {
    const originItem = key === occurrence.id ? item : await loadScheduleItemById(origin.itemId);
    if (!originItem?.habitAnchorKey?.startsWith(rulePrefix(habit))
      || item.habitAnchorKey && !item.habitAnchorKey.startsWith(rulePrefix(habit))) return null;
  }
  const steps = await loadTodoSteps(todo.id, occurrence.id);
  if (!steps.length || steps.some(step => !['completed', 'cancelled', 'expired'].includes(step.status))) return null;
  return { habit, occurrence, item, key };
}

async function latestRuleCompletion(habit: Habit) {
  const database = await getScheduleDatabase();
  const rows = await database.getAllAsync<{ id: string; completed_at: number; habit_completion_key?: string | null }>(
    `SELECT o.id, o.completed_at, i.habit_completion_key FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
     WHERE i.habit_id = ? AND substr(i.habit_anchor_key,1,?) = ? AND o.status = 'completed' AND o.completed_at IS NOT NULL
     ORDER BY o.completed_at DESC, o.id DESC`, habit.id, rulePrefix(habit).length, rulePrefix(habit),
  );
  let latest: number | undefined;
  for (const row of rows) {
    const log = await loadHabitLogForDate(habit.id, dateKey(row.completed_at));
    if (log?.completionActivityIds?.includes(row.habit_completion_key ?? row.id)) { latest = row.completed_at; break; }
  }
  const parents = await (await getTodoDatabase()).getAllAsync<{ id: string }>(
    `SELECT id FROM todo_items WHERE habit_id=? AND todo_type='normal' AND status='completed'
     AND parent_todo_id IS NULL AND parent_occurrence_id IS NOT NULL AND completed_at IS NOT NULL`, habit.id);
  for (const parent of parents) {
    const todo = await loadTodoItemById(parent.id, { promoteDue: false });
    if (!todo || latest !== undefined && todo.completedAt! <= latest) continue;
    const binding = await habitTodoBinding(todo);
    if (!binding || binding.habit.scheduleInstances.ruleUpdatedAt !== habit.scheduleInstances.ruleUpdatedAt) continue;
    const log = await loadHabitLogForDate(habit.id, dateKey(todo.completedAt!));
    if (log?.completionActivityIds?.includes(binding.key)) latest = todo.completedAt;
  }
  return latest;
}

async function chatDrafts(habit: Habit): Promise<ScheduleDraft[]> {
  if (!chatHabit(habit) || habit.status !== 'active' || !habit.scheduleInstances.enabled) return [];
  const start = habit.scheduleInstances.startAt;
  if (start === undefined) throw new Error('chat-habit-start-missing');
  const intervalStart = habit.frequency === 'interval'
    ? chatHabitIntervalStart(start, habit.intervalDays!, await latestRuleCompletion(habit)) : start;
  const starts = habit.frequency === 'weekly' || habit.frequency === 'custom'
    ? habit.weekDays.map(day => ({ startAt: chatHabitWeekdayStart(start, day), suffix: `w${day}` }))
    : [{ startAt: intervalStart, suffix: habit.frequency === 'interval' ? `interval:${intervalStart}` : 'daily' }];
  const duration = habit.scheduleInstances.durationMinutes;
  return starts.map(({ startAt, suffix }) => ({
    owner: 'you', title: habit.title, notes: habit.notes ?? '', startAt,
    ...(habit.scheduleInstances.endMode === 'fixed' && habit.scheduleInstances.endAt !== undefined
      ? { endAt: chatHabitFixedEndAt(startAt, start, habit.scheduleInstances.endAt), endMode: 'fixed' as const }
      : duration === undefined ? {} : { endAt: startAt + duration * 60000, durationMinutes: duration, endMode: 'duration' as const }),
    reminderMinutesBefore: habit.scheduleInstances.reminderMinutesBefore,
    startReminderEnabled: habit.scheduleInstances.startReminderEnabled ?? true,
    companionEnabled: (duration !== undefined || habit.scheduleInstances.endAt !== undefined) && habit.scheduleInstances.companionEnabled === true,
    recurrence: habit.frequency === 'interval' ? 'none' : habit.frequency === 'daily' ? 'daily' : 'weekly',
    reminderText: habit.title, reminderIntensity: 'gentle', source: 'habit', habitId: habit.id,
    habitAnchorKey: `${rulePrefix(habit)}${suffix}`,
  }));
}

function samePlan(habit: Habit, input: ChatHabitPlanInput) {
  const endMode = input.endMode ?? (input.endAt !== undefined ? 'fixed' : input.durationMinutes !== undefined ? 'duration' : undefined);
  return habit.status === 'active' && chatHabit(habit) && habit.title === input.title.trim()
    && (habit.notes ?? '') === (input.notes ?? '') && habit.frequency === input.repeat.frequency
    && JSON.stringify(habit.weekDays) === JSON.stringify([...(input.repeat.weekDays ?? [])].sort((a, b) => a - b))
    && habit.intervalDays === (input.repeat.frequency === 'interval' ? input.repeat.intervalDays : undefined)
    && habit.scheduleInstances.startAt === input.startAt && habit.scheduleInstances.durationMinutes === (endMode === 'fixed' ? undefined : input.durationMinutes)
    && habit.scheduleInstances.endMode === endMode && habit.scheduleInstances.endAt === (endMode === 'fixed' ? input.endAt : undefined)
    && habit.scheduleInstances.reminderMinutesBefore === input.reminderMinutesBefore
    && habit.scheduleInstances.startReminderEnabled === input.startReminderEnabled
    && habit.scheduleInstances.companionEnabled === ((input.durationMinutes !== undefined || input.endAt !== undefined) && input.companionEnabled);
}

async function assertNoConflict(habit: Habit, drafts: ScheduleDraft[]) {
  const now = Date.now();
  const candidates = drafts.flatMap(draft => chatHabitCandidateTimes(draft.startAt, draft.recurrence as 'none' | 'daily' | 'weekly', now)
    .map(startAt => ({ startAt, endAt: startAt + (draft.endAt === undefined ? 0 : draft.endAt - draft.startAt) })));
  if (!candidates.length) return;
  const min = Math.min(...candidates.map(value => value.startAt)) - 86400000;
  const max = Math.max(...candidates.map(value => value.endAt)) + 1;
  const existing = await loadPendingScheduleOccurrencesBetween(min, max, true);
  if (candidates.some(candidate => existing.some(other => other.owner !== 'I' && other.habitId !== habit.id
    && candidate.startAt < (other.endAt ?? other.scheduledStartAt)
    && other.scheduledStartAt < candidate.endAt))) throw new Error('chat-habit-schedule-time-conflict');
}

async function stopOldFuture(habit: Habit, effectiveAt: number, keepPrefix?: string, assertCurrent?: () => void | Promise<void>) {
  const database = await getScheduleDatabase();
  const notificationIds: string[] = [];
  await database.withExclusiveTransactionAsync(async transaction => {
    const rows = await transaction.getAllAsync<{ id: string; recurrence: string; habit_anchor_key: string | null }>(
      "SELECT id, recurrence, habit_anchor_key FROM schedule_items WHERE habit_id = ? AND owner != 'I' AND source = 'habit'", habit.id,
    );
    await assertCurrent?.();
    for (const row of rows) {
      if (keepPrefix && row.habit_anchor_key?.startsWith(keepPrefix)) continue;
      const occurrences = await transaction.getAllAsync<{ id: string; notification_id: string | null }>(
        "SELECT id, notification_id FROM schedule_occurrences WHERE item_id = ? AND status = 'pending' AND scheduled_start_at >= ?", row.id, effectiveAt,
      );
      if (row.recurrence !== 'none') {
        await assertCurrent?.();
        // End only the old future rule; never rewrite its title, dates, or prior completed occurrences.
        await transaction.runAsync('UPDATE schedule_items SET range_end_at = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND (range_end_at IS NULL OR range_end_at > ?)',
          effectiveAt - 1, Date.now(), row.id, effectiveAt - 1);
      }
      for (const occurrence of occurrences) {
        if (occurrence.notification_id) notificationIds.push(occurrence.notification_id);
        const events = await transaction.getAllAsync<{ notification_id: string | null }>(
          "SELECT notification_id FROM schedule_companion_events WHERE occurrence_id = ? AND status IN ('pending', 'delivered')", occurrence.id,
        );
        notificationIds.push(...events.map(value => value.notification_id).filter((value): value is string => value !== null));
        await assertCurrent?.();
        await transaction.runAsync("UPDATE schedule_occurrences SET status = 'cancelled', notification_id = NULL WHERE id = ? AND status = 'pending'", occurrence.id);
        await transaction.runAsync("UPDATE schedule_companion_events SET status = 'quiet', notification_id = NULL, preparation_json = NULL, reminder_body_json = NULL, updated_at = ? WHERE occurrence_id = ? AND status IN ('pending', 'delivered')", Date.now(), occurrence.id);
      }
    }
  });
  return notificationIds;
}

async function nextPending(habit: Habit, afterAt?: number) {
  const database = await getScheduleDatabase();
  const row = await database.getFirstAsync<{ id: string }>(
    `SELECT o.id FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
     WHERE i.habit_id = ? AND i.owner != 'I' AND i.status = 'pending' AND o.status = 'pending'
     ${afterAt === undefined ? '' : 'AND o.scheduled_start_at > ?'}
     ORDER BY o.scheduled_start_at, o.id LIMIT 1`, habit.id, ...(afterAt === undefined ? [] : [afterAt]),
  );
  return row ? await loadScheduleOccurrence(row.id) : null;
}

async function syncChatHabit(habit: Habit, assertCurrent?: () => void | Promise<void>, effectiveAt = habit.scheduleInstances.startAt!) {
  if (habit.status === 'archived') return null;
  await assertCurrent?.();
  await ensureScheduleHorizon();
  const drafts = await chatDrafts(habit);
  const notificationIds = await runScheduleSemanticCaptureExclusive(async () => {
    const current = await loadHabitById(habit.id);
    if (!current || current.updatedAt !== habit.updatedAt || current.status !== habit.status) throw new Error('chat-habit-source-changed');
    await assertNoConflict(habit, drafts);
    await assertCurrent?.();
    const ids = await stopOldFuture(habit, effectiveAt, rulePrefix(habit), assertCurrent);
    const existing = await loadScheduleItemsByHabitId(habit.id);
    const database = await getScheduleDatabase();
    for (const draft of drafts) {
      await assertCurrent?.();
      let item = existing.find(value => value.habitAnchorKey === draft.habitAnchorKey);
      if (!item) item = await createScheduleItem(draft);
      await assertCurrent?.();
      // A far-future or overdue first occurrence is still a real saved occurrence, not an inferred result.
      await database.runAsync("INSERT OR IGNORE INTO schedule_occurrences (id,item_id,scheduled_start_at,reminder_at,status) VALUES (?,?,?,?,'pending')",
        `${item.id}:${draft.startAt}`, item.id, draft.startAt,
        draft.startAt - draft.reminderMinutesBefore * 60000);
    }
    return ids;
  });
  if (notificationIds.length) await cancelNotifications(notificationIds);
  return nextPending(habit, habit.scheduleInstances.startAt! - 1);
}

export async function syncChatHabitScheduleInstances(habitId: string) {
  return withHabitWrite(async assertCurrent => {
    const habit = await loadHabitById(habitId);
    if (!habit || !chatHabit(habit)) return null;
    return syncChatHabit(habit, assertCurrent);
  });
}

export async function saveChatHabitPlan(input: ChatHabitPlanInput) {
  validateChatHabitPlan(input);
  return withHabitWrite(async assertCurrent => {
    const database = await getTodoDatabase();
    const old = await loadHabitById(input.id);
    if (old?.owner === 'I' || old?.kind === 'daily-challenge') throw new Error('chat-habit-owner-or-kind');
    if (old?.status === 'archived') throw new Error('chat-habit-archived');
    const alreadySaved = old && samePlan(old, input);
    if (!alreadySaved && ((old && old.updatedAt !== input.sourceUpdatedAt) || (!old && input.sourceUpdatedAt !== undefined))) throw new Error('chat-habit-source-changed');
    const now = Date.now();
    const endMode = input.endMode ?? (input.endAt !== undefined ? 'fixed' : input.durationMinutes !== undefined ? 'duration' : undefined);
    const version = alreadySaved ? old.scheduleInstances.ruleUpdatedAt! : Math.max(now, (old?.scheduleInstances.ruleUpdatedAt ?? old?.updatedAt ?? 0) + 1);
    const planned: Habit = { ...old, id: input.id, owner: 'you', frequencyPeriod: old?.frequencyPeriod ?? 'legacy', minutes: old?.minutes ?? null,
      title: input.title.trim(), notes: input.notes ?? '', category: old?.category ?? 'other', frequency: input.repeat.frequency,
      weekDays: [...(input.repeat.weekDays ?? [])].sort((a, b) => a - b), intervalDays: input.repeat.frequency === 'interval' ? input.repeat.intervalDays : undefined,
      targetCount: old?.targetCount ?? 1, reminderTimes: [new Date(input.startAt).toTimeString().slice(0, 5)],
      streak: old?.streak ?? 0, bestStreak: old?.bestStreak ?? 0, kind: 'habit', status: 'active',
      scheduleInstances: { enabled: true, startAt: input.startAt, ruleUpdatedAt: version, durationMinutes: input.durationMinutes,
        endMode, endAt: endMode === 'fixed' ? input.endAt : undefined,
        reminderMinutesBefore: input.reminderMinutesBefore, startReminderEnabled: input.startReminderEnabled,
        companionEnabled: (input.durationMinutes !== undefined || input.endAt !== undefined) && input.companionEnabled },
      createdAt: old?.createdAt ?? now, updatedAt: alreadySaved ? old.updatedAt : Math.max(now, (old?.updatedAt ?? 0) + 1) };
    if (endMode === 'fixed') planned.scheduleInstances.durationMinutes = undefined;
    await ensureScheduleHorizon();
    await assertNoConflict(planned, await chatDrafts(planned));
    assertCurrent();
    if (!alreadySaved) await database.withExclusiveTransactionAsync(async transaction => {
      const current = await transaction.getFirstAsync<{ owner: string; updated_at: number }>('SELECT owner,updated_at FROM habits WHERE id = ?', input.id);
      if ((old && current?.updated_at !== old.updatedAt) || (!old && current)) throw new Error('chat-habit-source-changed');
      assertCurrent();
      await transaction.runAsync(
        `INSERT INTO habits (id,owner,title,notes,category,frequency,week_days,interval_days,target_count,reminder_times,kind,schedule_enabled,
         schedule_start_at,schedule_rule_updated_at,schedule_duration_minutes,schedule_end_mode,schedule_end_at,schedule_start_reminder_enabled,schedule_companion_enabled,
         schedule_reminder_minutes_before,status,created_at,updated_at)
         VALUES (?,'you',?,?,?,?,?,?,?,?, 'habit',1,?,?,?,?,?,?,?,?,'active',?,?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title,notes=excluded.notes,frequency=excluded.frequency,week_days=excluded.week_days,
           interval_days=excluded.interval_days,reminder_times=excluded.reminder_times,schedule_enabled=1,schedule_start_at=excluded.schedule_start_at,
           schedule_rule_updated_at=excluded.schedule_rule_updated_at,schedule_duration_minutes=excluded.schedule_duration_minutes,
           schedule_end_mode=excluded.schedule_end_mode,schedule_end_at=excluded.schedule_end_at,
           schedule_start_reminder_enabled=excluded.schedule_start_reminder_enabled,schedule_companion_enabled=excluded.schedule_companion_enabled,
           schedule_reminder_minutes_before=excluded.schedule_reminder_minutes_before,updated_at=excluded.updated_at`,
        planned.id, planned.title, planned.notes!, planned.category, planned.frequency, JSON.stringify(planned.weekDays), planned.intervalDays ?? null,
        planned.targetCount, JSON.stringify(planned.reminderTimes), input.startAt, version, planned.scheduleInstances.durationMinutes ?? null, endMode ?? null, planned.scheduleInstances.endAt ?? null,
        input.startReminderEnabled ? 1 : 0, planned.scheduleInstances.companionEnabled ? 1 : 0, input.reminderMinutesBefore, planned.createdAt, planned.updatedAt,
      );
    });
    const habit = await loadHabitById(input.id);
    if (!habit) throw new Error('chat-habit-save-missing');
    try { return { habit, nextOccurrence: await syncChatHabit(habit, assertCurrent, input.effectiveAt) }; }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error('chat-habit-schedule-save-failed'), { habitSaved: true, habitId: habit.id }); }
  });
}

export async function archiveChatHabitPlan(habitId: string, effectiveAt: number, sourceUpdatedAt?: number) {
  if (!Number.isSafeInteger(effectiveAt) || effectiveAt < 0) throw new Error('invalid-habit-archive-time');
  return withHabitWrite(async assertCurrent => {
    const habit = await loadHabitById(habitId);
    if (!habit || habit.owner === 'I' || habit.kind !== 'habit') throw new Error('chat-habit-owner-or-kind');
    if (habit.status !== 'archived' && habit.updatedAt !== sourceUpdatedAt) throw new Error('chat-habit-source-changed');
    assertCurrent();
    if (habit.status !== 'archived') {
      const result = await (await getTodoDatabase()).runAsync("UPDATE habits SET status='archived',updated_at=MAX(updated_at + 1,?) WHERE id=? AND owner='you' AND updated_at=?", Date.now(), habitId, habit.updatedAt);
      if (!result.changes) throw new Error('chat-habit-source-changed');
    }
    const ids = await runScheduleSemanticCaptureExclusive(() => stopOldFuture(habit, effectiveAt, undefined, assertCurrent));
    if (ids.length) await cancelNotifications(ids);
    return { habit: await loadHabitById(habitId), nextOccurrence: null };
  });
}

export async function settleChatHabitOccurrence(occurrenceId: string, completedAt?: number,
  sourceCurrent?: () => boolean | Promise<boolean>) {
  return withHabitWrite(async assertCurrent => {
    const checkSource = async () => {
      assertCurrent();
      if (sourceCurrent && !await sourceCurrent()) throw new Error('habit-source-changed');
      assertCurrent();
    };
    const canComplete = async () => {
      await checkSource();
      return true;
    };
    const occurrence = await loadScheduleOccurrence(occurrenceId);
    if (!occurrence || occurrence.source !== 'habit' || !occurrence.habitId) throw new Error('habit-occurrence-not-found');
    const habit = await loadHabitById(occurrence.habitId);
    if (!habit || habit.owner === 'I' || habit.kind !== 'habit') throw new Error('habit-completion-owner-or-kind');
    if (occurrence.status === 'cancelled') throw new Error('habit-occurrence-cancelled');
    const actualTime = occurrence.completedAt ?? completedAt ?? Date.now();
    if (!Number.isSafeInteger(actualTime) || actualTime < 0) throw new Error('invalid-habit-completion-time');
    await checkSource();
    const result = await completeScheduleOccurrenceOnce(occurrenceId, actualTime, canComplete);
    const current = await loadScheduleOccurrence(occurrenceId);
    if (!current || current.status !== 'completed' || current.completedAt === undefined) throw new Error('habit-occurrence-completion-unconfirmed');
    let recorded: Awaited<ReturnType<typeof recordYouHabitOccurrenceCompletion>> | undefined;
    try {
      await checkSource();
      if (result.notificationIds.length) await cancelNotifications(result.notificationIds);
      recorded = await recordYouHabitOccurrenceCompletion(habit.id, current.habitCompletionKey ?? current.id, current.completedAt, checkSource);
      await checkSource();
      const fresh = await loadHabitById(habit.id);
      await checkSource();
      if (fresh && chatHabit(fresh)) await syncChatHabit(fresh, checkSource);
      await checkSource();
      const nextOccurrence = fresh?.status === 'active' ? await nextPending(fresh,
        fresh.frequency === 'interval' ? undefined : Math.max(current.scheduledStartAt, current.completedAt - 1)) : null;
      await checkSource();
      const total = await (await getTodoDatabase()).getFirstAsync<{ completed_count: number }>(
        `SELECT COALESCE(SUM(CASE WHEN completed_count > 0 THEN completed_count WHEN completed = 1 THEN 1 ELSE 0 END),0) AS completed_count
         FROM habit_logs WHERE habit_id = ?`, habit.id);
      await checkSource();
      return { occurrence: current, log: recorded.log, recorded: recorded.recorded,
        completedCount: total?.completed_count ?? 0, nextOccurrence };
    } catch (error) { throw Object.assign(error instanceof Error ? error : new Error('habit-log-save-failed'), {
      occurrenceCompleted: true, occurrenceId,
      ...(recorded ? { habitLogSaved: true, log: recorded.log } : {}),
    }); }
  }, sourceCurrent);
}

export async function settleChatHabitTodo(todoId: string, sourceCurrent?: () => boolean | Promise<boolean>) {
  return withHabitWrite(async assertCurrent => {
    const todo = await loadTodoItemById(todoId, { promoteDue: false });
    if (!todo || todo.status !== 'completed' || todo.type !== 'normal') throw new Error('habit-todo-not-completed');
    let recorded: Awaited<ReturnType<typeof recordYouHabitOccurrenceCompletion>> | undefined;
    try {
      const binding = await habitTodoBinding(todo);
      if (!binding) throw new Error('habit-todo-source-unavailable');
      const fingerprint = (value: TodoItem, bound: NonNullable<typeof binding>) => JSON.stringify([
        value.id, value.updatedAt, value.status, value.type, value.title, value.notes, value.habitId,
        value.parentTodoId, value.parentOccurrenceId, value.completedAt,
        bound.item.id, bound.item.updatedAt, bound.item.status, bound.item.habitAnchorKey, bound.item.habitCompletionKey,
        bound.occurrence.id, bound.occurrence.status, bound.occurrence.scheduledStartAt, bound.occurrence.completedAt,
        bound.habit.status, bound.habit.frequency, bound.habit.intervalDays, bound.habit.scheduleInstances,
      ]);
      const expected = fingerprint(todo, binding);
      const checkSource = async () => {
        assertCurrent();
        if (sourceCurrent && !await sourceCurrent()) throw new Error('habit-source-changed');
        const actual = await loadTodoItemById(todo.id, { promoteDue: false });
        const bound = actual ? await habitTodoBinding(actual) : null;
        if (!actual || !bound || fingerprint(actual, bound) !== expected) throw new Error('habit-todo-source-changed');
        assertCurrent();
        if (sourceCurrent && !await sourceCurrent()) throw new Error('habit-source-changed');
        assertCurrent();
      };
      await checkSource();
      recorded = await recordYouHabitOccurrenceCompletion(binding.habit.id, binding.key, todo.completedAt!, checkSource);
      await checkSource();
      const fresh = await loadHabitById(binding.habit.id);
      await checkSource();
      // Reuse the queued synchronizer's body; nesting its public queue would wait on this same settlement.
      if (fresh && chatHabit(fresh)) await syncChatHabit(fresh, checkSource);
      await checkSource();
      const nextOccurrence = fresh?.status === 'active' ? await nextPending(fresh,
        fresh.frequency === 'interval' ? undefined : Math.max(binding.occurrence.scheduledStartAt, todo.completedAt! - 1)) : null;
      const total = await (await getTodoDatabase()).getFirstAsync<{ completed_count: number }>(
        `SELECT COALESCE(SUM(CASE WHEN completed_count > 0 THEN completed_count WHEN completed = 1 THEN 1 ELSE 0 END),0) AS completed_count
         FROM habit_logs WHERE habit_id=?`, binding.habit.id);
      await checkSource();
      return { todo, log: recorded.log, completedCount: total?.completed_count ?? 0, nextOccurrence };
    } catch (error) { throw Object.assign(error instanceof Error ? error : new Error('habit-todo-settlement-failed'), {
      todoCompleted: true, todoId: todo.id, ...(recorded ? { habitLogSaved: true, log: recorded.log } : {}),
    }); }
  }, sourceCurrent);
}

export async function loadIntervalHabitIdsForDate(day: string) {
  const start = new Date(`${day}T00:00:00`).getTime();
  const end = new Date(`${day}T00:00:00`); end.setDate(end.getDate() + 1);
  if (!Number.isFinite(start) || dateKey(start) !== day) throw new Error('invalid-habit-date');
  const rows = await (await getScheduleDatabase()).getAllAsync<{ habit_id: string }>(
    `SELECT DISTINCT i.habit_id FROM schedule_items i JOIN schedule_occurrences o ON o.item_id=i.id
     WHERE i.owner != 'I' AND i.habit_id IS NOT NULL AND o.status != 'cancelled'
       AND ((o.status = 'pending' AND o.scheduled_start_at >= ? AND o.scheduled_start_at < ?) OR (o.completed_at >= ? AND o.completed_at < ?)
         OR (o.status = 'pending' AND i.habit_anchor_key LIKE '%:interval:%' AND o.scheduled_start_at < ?))`, start, end.getTime(), start, end.getTime(), end.getTime(),
  );
  return rows.map(value => value.habit_id);
}
