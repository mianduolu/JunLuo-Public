import type * as SQLite from 'expo-sqlite';

import {
  assertTodoSemanticRecord,
  type TodoSemanticRecordKind,
} from './syncTodoSemantic';
import type {
  TodoSemanticBusinessPort,
  TodoSemanticRevisionContext,
} from './syncTodoSemanticApply';
import type { JsonValue } from './syncProtocol';

type TodoRecord = JsonValue & Record<string, JsonValue>;
type SqlTransaction = Pick<SQLite.SQLiteDatabase, 'runAsync'>;

function localId(
  kind: TodoSemanticRecordKind,
  entityId: string,
) {
  const prefixByKind: Readonly<Record<TodoSemanticRecordKind, string>> = {
    'todo-item': 'todo:',
    'todo-inhibit-log': 'todo-inhibit-log:',
    habit: 'habit:',
    'habit-log': 'habit-log:',
    'future-self': 'future-self:',
    goal: 'goal:',
    'goal-progress-event': 'goal-progress:',
    'goal-time-credit-request': 'goal-time-credit:',
    'daily-challenge': 'challenge:',
    'day-review': 'day-review:',
    'week-review': 'week-review:',
    'task-execution-session': 'task-execution:',
    'task-execution-nudge': 'task-execution-nudge:',
  };
  const prefix = prefixByKind[kind];
  if (!entityId.startsWith(prefix) || entityId.length <= prefix.length) {
    throw new Error(`todo.semantic ${kind} entity id 无效。`);
  }
  return entityId.slice(prefix.length);
}

function nullableJson(value: JsonValue) {
  return value === null ? null : JSON.stringify(value);
}

async function writeTodoItem(
  transaction: SqlTransaction,
  record: TodoRecord,
) {
  await transaction.runAsync(
    `INSERT INTO todo_items (
       id, title, notes, status, planned_for_date, source, priority,
       reminder_mode, reminder_stage, last_reminded_at, quadrant, category,
       estimated_minutes, tracked_minutes, goal_id, goal_contribution,
       due_date, challenge_id, habit_id, todo_type, inhibit_active_from,
       inhibit_ended_at, postpone_count, created_at, updated_at, completed_at,
       parent_todo_id, parent_occurrence_id, step_order, completion_round
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       notes = excluded.notes,
       status = CASE WHEN excluded.completion_round < todo_items.completion_round THEN todo_items.status ELSE excluded.status END,
       planned_for_date = excluded.planned_for_date,
       source = excluded.source,
       priority = excluded.priority,
       reminder_mode = excluded.reminder_mode,
       reminder_stage = excluded.reminder_stage,
       last_reminded_at = excluded.last_reminded_at,
       quadrant = excluded.quadrant,
       category = excluded.category,
       estimated_minutes = excluded.estimated_minutes,
       tracked_minutes = excluded.tracked_minutes,
       goal_id = excluded.goal_id,
       goal_contribution = excluded.goal_contribution,
       due_date = excluded.due_date,
       challenge_id = excluded.challenge_id,
       habit_id = excluded.habit_id,
       todo_type = excluded.todo_type,
       inhibit_active_from = excluded.inhibit_active_from,
       inhibit_ended_at = excluded.inhibit_ended_at,
       postpone_count = excluded.postpone_count,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       completed_at = CASE WHEN excluded.completion_round < todo_items.completion_round THEN todo_items.completed_at ELSE excluded.completed_at END,
       completion_round = max(todo_items.completion_round, excluded.completion_round),
       parent_todo_id = CASE WHEN ? THEN excluded.parent_todo_id ELSE todo_items.parent_todo_id END,
       parent_occurrence_id = CASE WHEN ? THEN excluded.parent_occurrence_id ELSE todo_items.parent_occurrence_id END,
       step_order = CASE WHEN ? THEN excluded.step_order ELSE todo_items.step_order END`,
    record.id as string,
    record.title as string,
    record.notes as string,
    record.status as string,
    record.plannedForDate as string | null,
    record.source as string,
    record.priority as string,
    record.reminderMode as string,
    record.reminderStage as number,
    record.lastRemindedAt as number | null,
    record.quadrant as string,
    record.category as string,
    record.estimatedMinutes as number | null,
    record.trackedMinutes as number,
    record.goalId as string | null,
    record.goalContribution as number,
    record.dueDate as string | null,
    record.challengeId as string | null,
    record.habitId as string | null,
    record.type as string,
    record.inhibitActiveFrom as string | null,
    record.inhibitEndedAt as number | null,
    record.postponeCount as number,
    record.createdAt as number,
    record.updatedAt as number,
    record.completedAt as number | null,
    (record.parentTodoId ?? null) as string | null,
    (record.parentOccurrenceId ?? null) as string | null,
    (record.stepOrder ?? null) as number | null,
    (record.completionRound ?? 0) as number,
    'parentTodoId' in record ? 1 : 0,
    'parentOccurrenceId' in record ? 1 : 0,
    'stepOrder' in record ? 1 : 0,
  );
}

async function writeTodoInhibitLog(
  transaction: SqlTransaction,
  record: TodoRecord,
) {
  await transaction.runAsync(
    `INSERT INTO todo_inhibit_logs (
       id, todo_id, date_key, acknowledged_at, outcome, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       todo_id = excluded.todo_id,
       date_key = excluded.date_key,
       acknowledged_at = excluded.acknowledged_at,
       outcome = excluded.outcome,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.todoId as string,
    record.dateKey as string,
    record.acknowledgedAt as number | null,
    record.outcome as string,
    record.createdAt as number,
    record.updatedAt as number,
  );
}

async function writeHabit(
  transaction: SqlTransaction,
  record: TodoRecord,
) {
  const instances = (record.scheduleInstances ?? {}) as Record<string, JsonValue>;
  await transaction.runAsync(
    `INSERT INTO habits (
       id, title, goal_id, category, frequency, week_days, target_count,
       reminder_times, streak, best_streak, reminder_time, kind,
       schedule_enabled, schedule_reminder_minutes_before, status,
       created_at, updated_at, owner, frequency_period, minutes,
       notes, interval_days, schedule_start_at, schedule_rule_updated_at,
       schedule_duration_minutes, schedule_start_reminder_enabled,
       schedule_companion_enabled, schedule_end_mode, schedule_end_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       owner = CASE WHEN ? THEN excluded.owner ELSE habits.owner END,
       frequency_period = CASE WHEN ? THEN excluded.frequency_period ELSE habits.frequency_period END,
       minutes = CASE WHEN ? THEN excluded.minutes ELSE habits.minutes END,
       status = CASE WHEN ? = 0 AND habits.owner = 'I' AND habits.status = 'archived' THEN habits.status ELSE excluded.status END,
       title = excluded.title,
       goal_id = excluded.goal_id,
       category = excluded.category,
       frequency = CASE WHEN ? = 0 AND habits.frequency = 'interval' THEN habits.frequency ELSE excluded.frequency END,
       notes = CASE WHEN ? THEN excluded.notes ELSE habits.notes END,
       interval_days = CASE WHEN ? THEN excluded.interval_days ELSE habits.interval_days END,
       schedule_start_at = CASE WHEN ? THEN excluded.schedule_start_at ELSE habits.schedule_start_at END,
       schedule_rule_updated_at = CASE WHEN ? THEN excluded.schedule_rule_updated_at ELSE habits.schedule_rule_updated_at END,
       schedule_duration_minutes = CASE WHEN ? THEN excluded.schedule_duration_minutes ELSE habits.schedule_duration_minutes END,
       schedule_start_reminder_enabled = CASE WHEN ? THEN excluded.schedule_start_reminder_enabled ELSE habits.schedule_start_reminder_enabled END,
       schedule_companion_enabled = CASE WHEN ? THEN excluded.schedule_companion_enabled ELSE habits.schedule_companion_enabled END,
       schedule_end_mode = CASE WHEN ? THEN excluded.schedule_end_mode ELSE habits.schedule_end_mode END,
       schedule_end_at = CASE WHEN ? THEN excluded.schedule_end_at ELSE habits.schedule_end_at END,
       week_days = excluded.week_days,
       target_count = excluded.target_count,
       reminder_times = excluded.reminder_times,
       streak = excluded.streak,
       best_streak = excluded.best_streak,
       reminder_time = excluded.reminder_time,
       kind = excluded.kind,
       schedule_enabled = excluded.schedule_enabled,
       schedule_reminder_minutes_before =
         excluded.schedule_reminder_minutes_before,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.title as string,
    record.goalId as string | null,
    record.category as string,
    record.frequency as string,
    JSON.stringify(record.weekDays),
    record.targetCount as number,
    JSON.stringify(record.reminderTimes),
    record.streak as number,
    record.bestStreak as number,
    record.reminderTime as string | null,
    record.kind as string,
    record.scheduleEnabled ? 1 : 0,
    record.scheduleReminderMinutesBefore as number,
    record.status as string,
    record.createdAt as number,
    record.updatedAt as number,
    (record.owner ?? 'you') as string,
    (record.frequencyPeriod ?? 'legacy') as string,
    (record.minutes ?? null) as number | null,
    (record.notes ?? null) as string | null,
    (record.intervalDays ?? null) as number | null,
    (instances.startAt ?? null) as number | null,
    (instances.ruleUpdatedAt ?? null) as number | null,
    (instances.durationMinutes ?? null) as number | null,
    instances.startReminderEnabled == null ? null : instances.startReminderEnabled ? 1 : 0,
    instances.companionEnabled == null ? null : instances.companionEnabled ? 1 : 0,
    (instances.endMode ?? null) as string | null,
    (instances.endAt ?? null) as number | null,
    'owner' in record ? 1 : 0,
    'frequencyPeriod' in record ? 1 : 0,
    'minutes' in record ? 1 : 0,
    'owner' in record ? 1 : 0,
    'intervalDays' in record ? 1 : 0,
    'notes' in record ? 1 : 0,
    'intervalDays' in record ? 1 : 0,
    'startAt' in instances ? 1 : 0,
    'ruleUpdatedAt' in instances ? 1 : 0,
    'durationMinutes' in instances ? 1 : 0,
    'startReminderEnabled' in instances ? 1 : 0,
    'companionEnabled' in instances ? 1 : 0,
    'endMode' in instances ? 1 : 0,
    'endAt' in instances ? 1 : 0,
  );
}

async function writeHabitLog(
  transaction: SqlTransaction,
  record: TodoRecord,
) {
  await transaction.runAsync(
    `INSERT INTO habit_logs (
       id, habit_id, date_key, completed, completed_count, note,
       completed_at, created_at, updated_at, completion_activity_ids
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       habit_id = excluded.habit_id,
       date_key = excluded.date_key,
       completion_activity_ids = (SELECT json_group_array(value) FROM (SELECT value FROM json_each(habit_logs.completion_activity_ids) UNION SELECT value FROM json_each(excluded.completion_activity_ids))),
       completed = CASE WHEN json_array_length(habit_logs.completion_activity_ids) > 0 THEN max(habit_logs.completed, excluded.completed) ELSE excluded.completed END,
       completed_count = CASE WHEN json_array_length(habit_logs.completion_activity_ids) > 0 THEN max(habit_logs.completed_count, excluded.completed_count, (SELECT count(DISTINCT value) FROM (SELECT value FROM json_each(habit_logs.completion_activity_ids) UNION SELECT value FROM json_each(excluded.completion_activity_ids)))) ELSE excluded.completed_count END,
       note = excluded.note,
       completed_at = CASE WHEN json_array_length(habit_logs.completion_activity_ids) > 0 THEN max(coalesce(habit_logs.completed_at, 0), coalesce(excluded.completed_at, 0)) ELSE excluded.completed_at END,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.habitId as string,
    record.dateKey as string,
    record.completed ? 1 : 0,
    record.completedCount as number,
    record.note as string,
    record.completedAt as number | null,
    record.createdAt as number,
    record.updatedAt as number,
    JSON.stringify(record.completionActivityIds ?? []),
  );
}

async function writeFutureSelf(
  transaction: SqlTransaction,
  record: TodoRecord,
) {
  await transaction.runAsync(
    `INSERT INTO future_self (
       id, identity_statement, notes, updated_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       identity_statement = excluded.identity_statement,
       notes = excluded.notes,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.identityStatement as string,
    record.notes as string,
    record.updatedAt as number,
  );
}

async function writeGoal(
  transaction: SqlTransaction,
  record: TodoRecord,
) {
  await transaction.runAsync(
    `INSERT INTO goal_items (
       id, title, description, life_area, status, priority, target_date,
       progress, goal_type, target_count, target_unit, estimated_total_minutes,
       frequency, week_days, action_title, action_amount,
       last_direction_check_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       life_area = excluded.life_area,
       status = excluded.status,
       priority = excluded.priority,
       target_date = excluded.target_date,
       progress = excluded.progress,
       goal_type = excluded.goal_type,
       target_count = excluded.target_count,
       target_unit = excluded.target_unit,
       estimated_total_minutes = excluded.estimated_total_minutes,
       frequency = excluded.frequency,
       week_days = excluded.week_days,
       action_title = excluded.action_title,
       action_amount = excluded.action_amount,
       last_direction_check_at = excluded.last_direction_check_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.title as string,
    record.description as string,
    record.lifeArea as string,
    record.status as string,
    record.priority as string,
    record.targetDate as string | null,
    record.progress as number,
    record.goalType as string,
    record.targetCount as number | null,
    record.targetUnit as string | null,
    record.estimatedTotalMinutes as number | null,
    record.frequency as string,
    JSON.stringify(record.weekDays),
    record.actionTitle as string | null,
    record.actionAmount as number,
    record.lastDirectionCheckAt as number | null,
    record.createdAt as number,
    record.updatedAt as number,
  );
}

async function writeGoalProgressEvent(
  transaction: SqlTransaction,
  record: TodoRecord,
) {
  await transaction.runAsync(
    `INSERT INTO goal_progress_events (
       id, goal_id, kind, source_id, amount, note, occurred_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       goal_id = excluded.goal_id,
       kind = excluded.kind,
       source_id = excluded.source_id,
       amount = excluded.amount,
       note = excluded.note,
       occurred_at = excluded.occurred_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.goalId as string,
    record.kind as string,
    record.sourceId as string,
    record.amount as number,
    record.note as string,
    record.occurredAt as number,
    record.createdAt as number,
    record.updatedAt as number,
  );
}

async function writeGoalTimeCredit(
  transaction: SqlTransaction,
  record: TodoRecord,
) {
  await transaction.runAsync(
    `INSERT INTO goal_time_credit_requests (
       id, todo_id, goal_id, todo_title, suggested_minutes, reason,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       todo_id = excluded.todo_id,
       goal_id = excluded.goal_id,
       todo_title = excluded.todo_title,
       suggested_minutes = excluded.suggested_minutes,
       reason = excluded.reason,
       status = excluded.status,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.todoId as string,
    record.goalId as string,
    record.todoTitle as string,
    record.suggestedMinutes as number | null,
    record.reason as string,
    record.status as string,
    record.createdAt as number,
    record.updatedAt as number,
  );
}

async function writeDailyChallenge(
  transaction: SqlTransaction,
  record: TodoRecord,
) {
  await transaction.runAsync(
    `INSERT INTO daily_challenges (
       id, title, category, quadrant, estimated_minutes, habit_id,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       category = excluded.category,
       quadrant = excluded.quadrant,
       estimated_minutes = excluded.estimated_minutes,
       habit_id = excluded.habit_id,
       status = excluded.status,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.title as string,
    record.category as string,
    record.quadrant as string,
    record.estimatedMinutes as number,
    record.habitId as string,
    record.status as string,
    record.createdAt as number,
    record.updatedAt as number,
  );
}

async function writeDayReview(
  transaction: SqlTransaction,
  record: TodoRecord,
) {
  await transaction.runAsync(
    `INSERT INTO day_reviews (
       id, date_key, summary, completed_task_titles, pending_task_titles,
       minutes_by_category, total_tracked_minutes, goal_notes, habits_done,
       habits_total, habit_notes, baiyun_message, metrics_snapshot,
       comparison_snapshot, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       date_key = excluded.date_key,
       summary = excluded.summary,
       completed_task_titles = excluded.completed_task_titles,
       pending_task_titles = excluded.pending_task_titles,
       minutes_by_category = excluded.minutes_by_category,
       total_tracked_minutes = excluded.total_tracked_minutes,
       goal_notes = excluded.goal_notes,
       habits_done = excluded.habits_done,
       habits_total = excluded.habits_total,
       habit_notes = excluded.habit_notes,
       baiyun_message = excluded.baiyun_message,
       metrics_snapshot = excluded.metrics_snapshot,
       comparison_snapshot = excluded.comparison_snapshot,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.dateKey as string,
    record.summary as string,
    JSON.stringify(record.completedTaskTitles),
    JSON.stringify(record.pendingTaskTitles),
    JSON.stringify(record.minutesByCategory),
    record.totalTrackedMinutes as number,
    JSON.stringify(record.goalNotes),
    record.habitsDone as number,
    record.habitsTotal as number,
    JSON.stringify(record.habitNotes),
    record.baiyunMessage as string,
    nullableJson(record.metricsSnapshot),
    nullableJson(record.comparison),
    record.createdAt as number,
    record.updatedAt as number,
  );
}

async function writeWeekReview(
  transaction: SqlTransaction,
  record: TodoRecord,
) {
  await transaction.runAsync(
    `INSERT INTO week_reviews (
       id, week_start, week_end, summary, wins, gaps, goal_progress,
       habit_insights, next_week_suggestions, baiyun_message,
       metrics_snapshot, comparison_snapshot, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       week_start = excluded.week_start,
       week_end = excluded.week_end,
       summary = excluded.summary,
       wins = excluded.wins,
       gaps = excluded.gaps,
       goal_progress = excluded.goal_progress,
       habit_insights = excluded.habit_insights,
       next_week_suggestions = excluded.next_week_suggestions,
       baiyun_message = excluded.baiyun_message,
       metrics_snapshot = excluded.metrics_snapshot,
       comparison_snapshot = excluded.comparison_snapshot,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.weekStart as string,
    record.weekEnd as string,
    record.summary as string,
    JSON.stringify(record.wins),
    JSON.stringify(record.gaps),
    JSON.stringify(record.goalProgress),
    JSON.stringify(record.habitInsights),
    JSON.stringify(record.nextWeekSuggestions),
    record.baiyunMessage as string,
    nullableJson(record.metricsSnapshot),
    nullableJson(record.comparison),
    record.createdAt as number,
    record.updatedAt as number,
  );
}

async function writeTaskExecution(
  transaction: SqlTransaction,
  record: TodoRecord,
) {
  await transaction.runAsync(
    `INSERT INTO task_execution_sessions (
       id, todo_id, status, started_at, paused_at, ended_at,
       accumulated_seconds, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       todo_id = excluded.todo_id,
       status = excluded.status,
       started_at = excluded.started_at,
       paused_at = excluded.paused_at,
       ended_at = excluded.ended_at,
       accumulated_seconds = excluded.accumulated_seconds,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.todoId as string,
    record.status as string,
    record.startedAt as number,
    record.pausedAt as null,
    record.endedAt as number,
    record.accumulatedSeconds as number,
    record.createdAt as number,
    record.updatedAt as number,
  );
}

async function writeTaskExecutionNudge(
  transaction: SqlTransaction,
  record: TodoRecord,
) {
  await transaction.runAsync(
    `INSERT INTO task_execution_nudges (
       session_id, todo_id, kind, created_at, delivered_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, kind) DO UPDATE SET
       todo_id = excluded.todo_id,
       created_at = excluded.created_at,
       delivered_at = excluded.delivered_at`,
    record.sessionId as string,
    record.todoId as string,
    record.kind as string,
    record.createdAt as number,
    record.deliveredAt as number | null,
  );
}

export async function applyTodoSemanticRecordToSqlite(input: {
  transaction: SqlTransaction;
  kind: TodoSemanticRecordKind;
  record: TodoRecord;
}) {
  assertTodoSemanticRecord(input.kind, input.record);
  const writers: Readonly<Record<
    TodoSemanticRecordKind,
    (transaction: SqlTransaction, record: TodoRecord) => Promise<void>
  >> = {
    'todo-item': writeTodoItem,
    'todo-inhibit-log': writeTodoInhibitLog,
    habit: writeHabit,
    'habit-log': writeHabitLog,
    'future-self': writeFutureSelf,
    goal: writeGoal,
    'goal-progress-event': writeGoalProgressEvent,
    'goal-time-credit-request': writeGoalTimeCredit,
    'daily-challenge': writeDailyChallenge,
    'day-review': writeDayReview,
    'week-review': writeWeekReview,
    'task-execution-session': writeTaskExecution,
    'task-execution-nudge': writeTaskExecutionNudge,
  };
  await writers[input.kind](input.transaction, input.record);
}

function taskExecutionNudgeIdentity(entityId: string) {
  const value = localId('task-execution-nudge', entityId);
  const kinds = ['timeReached', 'stuck', 'breakNeeded'] as const;
  const kind = kinds.find((candidate) => value.endsWith(`:${candidate}`));
  if (!kind) {
    throw new Error('todo.semantic task execution nudge entity id 无效。');
  }
  const sessionId = value.slice(0, -(kind.length + 1));
  if (!sessionId) {
    throw new Error('todo.semantic task execution nudge session id 无效。');
  }
  return { sessionId, kind };
}

export async function deleteTodoSemanticRecordFromSqlite(input: {
  transaction: SqlTransaction;
  kind: TodoSemanticRecordKind;
  entityId: string;
}) {
  const tableAndIdColumn:
  Partial<Record<TodoSemanticRecordKind, readonly [string, string]>> = {
    'todo-item': ['todo_items', 'id'],
    'todo-inhibit-log': ['todo_inhibit_logs', 'id'],
    habit: ['habits', 'id'],
    'habit-log': ['habit_logs', 'id'],
    'future-self': ['future_self', 'id'],
    goal: ['goal_items', 'id'],
    'goal-progress-event': ['goal_progress_events', 'id'],
    'goal-time-credit-request': ['goal_time_credit_requests', 'id'],
    'daily-challenge': ['daily_challenges', 'id'],
    'day-review': ['day_reviews', 'id'],
    'week-review': ['week_reviews', 'id'],
    'task-execution-session': ['task_execution_sessions', 'id'],
  };
  if (input.kind === 'task-execution-nudge') {
    const identity = taskExecutionNudgeIdentity(input.entityId);
    await input.transaction.runAsync(
      `DELETE FROM task_execution_nudges
       WHERE session_id = ? AND kind = ?`,
      identity.sessionId,
      identity.kind,
    );
    return;
  }
  const route = tableAndIdColumn[input.kind];
  if (!route) {
    throw new Error(`todo.semantic 不处理 ${input.kind} tombstone。`);
  }
  const [tableName, idColumn] = route;
  await input.transaction.runAsync(
    `DELETE FROM ${tableName} WHERE ${idColumn} = ?`,
    localId(input.kind, input.entityId),
  );
}

async function runSuppressed<T>(
  apply: (transaction: SQLite.SQLiteDatabase) => Promise<T>,
) {
  const { runWithTodoSemanticCaptureSuppressed } =
    await import('./syncTodoSemanticSqlitePort');
  return runWithTodoSemanticCaptureSuppressed(apply);
}

type IncomingTodoRevision = {
  entityType: string;
  entityId: string;
  revision: TodoSemanticRevisionContext;
};

async function shouldApplyReceivedRevision(
  transaction: SQLite.SQLiteDatabase,
  input: IncomingTodoRevision,
) {
  const heads = await transaction.getAllAsync<{ revision_id: string }>(
    'SELECT revision_id FROM todo_sync_entity_heads WHERE entity_type = ? AND entity_id = ?',
    input.entityType, input.entityId,
  );
  if (heads.length === 0) return true;
  if (heads.every(head => head.revision_id === input.revision.revisionId)) return false;
  if (heads.every(head => input.revision.parentRevisionIds.includes(head.revision_id))) return true;
  const parentsByRevision = new Map<string, string[]>([
    [input.revision.revisionId, input.revision.parentRevisionIds],
  ]);
  async function parentsOf(revisionId: string) {
    const cached = parentsByRevision.get(revisionId);
    if (cached) return cached;
    const local = await transaction.getFirstAsync<{ parent_revision_ids_json: string }>(
      `SELECT parent_revision_ids_json FROM todo_sync_domain_outbox
       WHERE revision_id = ? AND entity_type = ? AND entity_id = ?`,
      revisionId, input.entityType, input.entityId,
    );
    let parents: string[];
    if (local) {
      const value: unknown = JSON.parse(local.parent_revision_ids_json);
      if (!Array.isArray(value) || value.some(parent => typeof parent !== 'string')) {
        throw new Error('todo.semantic 本地父版本登记无效，已保留收件。');
      }
      parents = value;
    } else {
      const { loadSyncRevisionMutation } = await import('./syncMutationStateStore');
      const mutation = await loadSyncRevisionMutation(revisionId);
      if (!mutation || mutation.entity.domain !== 'todo'
        || mutation.entity.type !== input.entityType || mutation.entity.id !== input.entityId) {
        throw new Error('todo.semantic 父版本证据尚未齐全，已保留收件。');
      }
      parents = mutation.revision.parents;
    }
    parentsByRevision.set(revisionId, parents);
    return parents;
  }
  async function isAncestor(ancestor: string, descendant: string) {
    const pending = [descendant];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const revisionId = pending.pop()!;
      if (revisionId === ancestor) return true;
      if (visited.has(revisionId)) continue;
      visited.add(revisionId);
      pending.push(...await parentsOf(revisionId));
    }
    return false;
  }
  // Replayed receipts must not overwrite a later local edit, including edits
  // captured by SQLite that have not yet reached the central ledger.
  let alreadyAhead = true;
  for (const head of heads) {
    if (!await isAncestor(input.revision.revisionId, head.revision_id)) alreadyAhead = false;
  }
  if (alreadyAhead) return false;
  for (const head of heads) {
    if (!await isAncestor(head.revision_id, input.revision.revisionId)) {
      throw new Error('todo.semantic 本机修改与来信并发，已保留业务、待发记录和收件。');
    }
  }
  return true;
}

async function registerReceivedRevision(
  transaction: SQLite.SQLiteDatabase,
  input: IncomingTodoRevision,
) {
  await transaction.runAsync(
    'DELETE FROM todo_sync_entity_heads WHERE entity_type = ? AND entity_id = ?',
    input.entityType, input.entityId,
  );
  await transaction.runAsync(
    `INSERT INTO todo_sync_entity_heads (entity_type, entity_id, revision_id, updated_at)
     VALUES (?, ?, ?, ?)`,
    input.entityType, input.entityId, input.revision.revisionId, input.revision.createdAt,
  );
}

export const todoSemanticSqliteBusinessPort: TodoSemanticBusinessPort = {
  upsertRecord: (input) => (
    runSuppressed(async (transaction) => {
      if (!await shouldApplyReceivedRevision(transaction, input)) return;
      await applyTodoSemanticRecordToSqlite({
        transaction,
        kind: input.kind,
        record: input.record,
      });
      await registerReceivedRevision(transaction, input);
    })
  ),
  deleteRecord: (input) => (
    runSuppressed(async (transaction) => {
      if (!await shouldApplyReceivedRevision(transaction, input)) return;
      await deleteTodoSemanticRecordFromSqlite({
        transaction,
        kind: input.kind,
        entityId: input.entityId,
      });
      await registerReceivedRevision(transaction, input);
    })
  ),
};
