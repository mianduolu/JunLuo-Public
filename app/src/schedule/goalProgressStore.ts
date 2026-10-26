import { loadGoal, loadGoals, updateGoal, type Goal } from './goalStore';
import { determineTodoTimeCreditAction, normalizeGoalTimeCreditMinutes } from './goalTimeCreditLogic';
import { dateKey } from './scheduleStore';
import { getTodoDatabase as getDatabase } from './todoDatabase';
import { makeTodoNaturalRecordId } from './todoIdentity';
import { createTodoItem, loadTodoItemById, loadTodoItemsByGoalId, type TodoCategory } from './todoStore';
import type {
  GoalTimeCreditCardLocator,
  GoalTimeCreditDeliveryWork,
} from './goalTimeCreditDeliveryCore';

export type GoalProgressEventKind = 'todo-completion' | 'todo-time-credit' | 'schedule-completion' | 'manual-adjustment';

export type GoalTimeCreditRequestStatus = 'pending' | 'proposed' | 'confirmed' | 'skipped' | 'cancelled';

export type GoalTimeCreditRequest = {
  id: string;
  todoId: string;
  goalId: string;
  todoTitle: string;
  suggestedMinutes?: number;
  reason: string;
  status: GoalTimeCreditRequestStatus;
  createdAt: number;
  updatedAt: number;
};

export type GoalProgressEvent = {
  id: string;
  goalId: string;
  kind: GoalProgressEventKind;
  sourceId: string;
  amount: number;
  note: string;
  occurredAt: number;
  createdAt: number;
  updatedAt: number;
};

export type GoalProgressSnapshot = {
  goalId: string;
  goalType: Goal['goalType'];
  current: number;
  target?: number;
  unit: string;
  percent: number;
};

type EventRow = {
  id: string;
  goal_id: string;
  kind: GoalProgressEventKind;
  source_id: string;
  amount: number;
  note: string | null;
  occurred_at: number;
  created_at: number;
  updated_at: number;
};

type TimeCreditRow = {
  id: string;
  todo_id: string;
  goal_id: string;
  todo_title: string;
  suggested_minutes: number | null;
  reason: string | null;
  status: GoalTimeCreditRequestStatus;
  created_at: number;
  updated_at: number;
};

type TimeCreditDeliveryWorkRow = TimeCreditRow & {
  locator_request_id: string | null;
  locator_session_id: string | null;
  locator_message_id: string | null;
  locator_applied_status: GoalTimeCreditRequestStatus | null;
  locator_updated_at: number | null;
};

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function timeCreditFromRow(row: TimeCreditRow): GoalTimeCreditRequest {
  return {
    id: row.id,
    todoId: row.todo_id,
    goalId: row.goal_id,
    todoTitle: row.todo_title,
    suggestedMinutes: row.suggested_minutes && row.suggested_minutes > 0 ? row.suggested_minutes : undefined,
    reason: row.reason ?? '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createGoalTimeCreditRequest(todoId: string, goalId: string, todoTitle: string) {
  const database = await getDatabase();
  const now = Date.now();
  await database.runAsync(
    `INSERT INTO goal_time_credit_requests
      (id, todo_id, goal_id, todo_title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(todo_id) DO UPDATE SET
       goal_id = excluded.goal_id,
       todo_title = excluded.todo_title,
       suggested_minutes = NULL,
       reason = '',
       status = 'pending',
       updated_at = excluded.updated_at`,
    makeTodoNaturalRecordId(
      'goal-time-credit',
      [todoId],
    ),
    todoId,
    goalId,
    todoTitle,
    now,
    now,
  );
}

export async function loadPendingGoalTimeCreditRequests() {
  const database = await getDatabase();
  const rows = await database.getAllAsync<TimeCreditRow>(
    "SELECT * FROM goal_time_credit_requests WHERE status IN ('pending', 'proposed') ORDER BY created_at ASC",
  );
  return rows.map(timeCreditFromRow);
}

export async function loadGoalTimeCreditRequest(requestId: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<TimeCreditRow>('SELECT * FROM goal_time_credit_requests WHERE id = ?', requestId);
  return row ? timeCreditFromRow(row) : null;
}

export async function loadGoalTimeCreditDeliveryWork(): Promise<GoalTimeCreditDeliveryWork[]> {
  const database = await getDatabase();
  const rows = await database.getAllAsync<TimeCreditDeliveryWorkRow>(
    `SELECT requests.*,
      locators.request_id AS locator_request_id,
      locators.session_id AS locator_session_id,
      locators.message_id AS locator_message_id,
      locators.applied_status AS locator_applied_status,
      locators.updated_at AS locator_updated_at
     FROM goal_time_credit_requests AS requests
     LEFT JOIN goal_time_credit_card_locators AS locators
       ON locators.request_id = requests.id
     WHERE requests.status IN ('pending', 'proposed')
       OR (locators.request_id IS NOT NULL AND locators.applied_status <> requests.status)
     ORDER BY requests.created_at ASC`,
  );
  return rows.map((row) => ({
    request: timeCreditFromRow(row),
    locator: row.locator_request_id
      && row.locator_session_id
      && row.locator_message_id
      && row.locator_applied_status
      && row.locator_updated_at != null
      ? {
          requestId: row.locator_request_id,
          sessionId: row.locator_session_id,
          messageId: row.locator_message_id,
          appliedStatus: row.locator_applied_status,
          updatedAt: row.locator_updated_at,
        }
      : null,
  }));
}

export async function saveGoalTimeCreditCardLocator(
  locator: Omit<GoalTimeCreditCardLocator, 'updatedAt'>,
) {
  const database = await getDatabase();
  await database.runAsync(
    `INSERT INTO goal_time_credit_card_locators
      (request_id, session_id, message_id, applied_status, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(request_id) DO UPDATE SET
       session_id = excluded.session_id,
       message_id = excluded.message_id,
       applied_status = excluded.applied_status,
       updated_at = excluded.updated_at`,
    locator.requestId,
    locator.sessionId,
    locator.messageId,
    locator.appliedStatus,
    Date.now(),
  );
}

export async function deleteGoalTimeCreditCardLocator(requestId: string) {
  const database = await getDatabase();
  await database.runAsync(
    'DELETE FROM goal_time_credit_card_locators WHERE request_id = ?',
    requestId,
  );
}

export async function saveGoalTimeCreditEstimate(requestId: string, minutes: number, reason = '') {
  const amount = normalizeGoalTimeCreditMinutes(minutes);
  if (!amount) return;
  const database = await getDatabase();
  await database.runAsync(
    "UPDATE goal_time_credit_requests SET suggested_minutes = ?, reason = ?, status = 'proposed', updated_at = ? WHERE id = ? AND status IN ('pending', 'proposed')",
    amount,
    reason.trim().slice(0, 160),
    Date.now(),
    requestId,
  );
}

export async function confirmGoalTimeCredit(requestId: string, minutes?: number) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<TimeCreditRow>('SELECT * FROM goal_time_credit_requests WHERE id = ?', requestId);
  if (!row || (row.status !== 'pending' && row.status !== 'proposed')) return row ? timeCreditFromRow(row) : null;
  const amount = normalizeGoalTimeCreditMinutes(minutes ?? row.suggested_minutes);
  if (!amount) return timeCreditFromRow(row);
  await recordGoalProgressEvent({
    goalId: row.goal_id,
    kind: 'todo-time-credit',
    sourceId: row.todo_id,
    amount,
    note: row.todo_title,
  });
  await database.runAsync(
    "UPDATE goal_time_credit_requests SET suggested_minutes = ?, status = 'confirmed', updated_at = ? WHERE id = ?",
    amount,
    Date.now(),
    requestId,
  );
  return timeCreditFromRow({ ...row, suggested_minutes: amount, status: 'confirmed', updated_at: Date.now() });
}

export async function skipGoalTimeCredit(requestId: string) {
  const database = await getDatabase();
  await database.runAsync(
    "UPDATE goal_time_credit_requests SET status = 'skipped', updated_at = ? WHERE id = ? AND status IN ('pending', 'proposed')",
    Date.now(),
    requestId,
  );
}

export async function cancelGoalTimeCreditForTodo(todoId: string) {
  const database = await getDatabase();
  await database.runAsync(
    "UPDATE goal_time_credit_requests SET status = 'cancelled', updated_at = ? WHERE todo_id = ? AND status IN ('pending', 'proposed')",
    Date.now(),
    todoId,
  );
}

function fromRow(row: EventRow): GoalProgressEvent {
  return {
    id: row.id,
    goalId: row.goal_id,
    kind: row.kind,
    sourceId: row.source_id,
    amount: Math.max(0, row.amount),
    note: row.note ?? '',
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadGoalProgressEvents(goalId: string) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<EventRow>(
    'SELECT * FROM goal_progress_events WHERE goal_id = ? ORDER BY occurred_at ASC',
    goalId,
  );
  return rows.map(fromRow);
}

export async function recordGoalProgressEvent(input: {
  goalId: string;
  kind: GoalProgressEventKind;
  sourceId: string;
  amount: number;
  note?: string;
  occurredAt?: number;
}) {
  const database = await getDatabase();
  const now = Date.now();
  const amount = Math.max(0, Math.round(input.amount));
  await database.runAsync(
    `INSERT INTO goal_progress_events
      (id, goal_id, kind, source_id, amount, note, occurred_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(goal_id, kind, source_id) DO UPDATE SET
       amount = excluded.amount,
       note = excluded.note,
       occurred_at = excluded.occurred_at,
       updated_at = excluded.updated_at`,
    makeTodoNaturalRecordId(
      'goal-progress',
      [input.goalId, input.kind, input.sourceId],
    ),
    input.goalId,
    input.kind,
    input.sourceId,
    amount,
    input.note?.trim().slice(0, 180) ?? '',
    input.occurredAt ?? now,
    now,
    now,
  );
  return recalculateGoalProgress(input.goalId);
}

export async function removeGoalProgressEvent(goalId: string, kind: GoalProgressEventKind, sourceId: string) {
  const database = await getDatabase();
  await database.runAsync('DELETE FROM goal_progress_events WHERE goal_id = ? AND kind = ? AND source_id = ?', goalId, kind, sourceId);
  return recalculateGoalProgress(goalId);
}

export async function adjustGoalTimeContribution(input: {
  goalId: string;
  sourceId?: string;
  minutes: number;
  note?: string;
}) {
  return recordGoalProgressEvent({
    goalId: input.goalId,
    kind: input.sourceId ? 'schedule-completion' : 'manual-adjustment',
    sourceId: input.sourceId ?? makeId('manual'),
    amount: input.minutes,
    note: input.note,
  });
}

export async function recalculateGoalProgress(goalId: string): Promise<GoalProgressSnapshot | null> {
  const goal = await loadGoal(goalId);
  if (!goal) return null;
  if (goal.goalType === 'direction') {
    return { goalId, goalType: goal.goalType, current: goal.progress, unit: '%', percent: goal.progress };
  }
  const events = await loadGoalProgressEvents(goalId);
  const current = events.reduce((total, event) => total + event.amount, 0);
  const target = goal.goalType === 'countdown' ? goal.targetCount : goal.estimatedTotalMinutes;
  const percent = target ? Math.min(100, Math.round(current / target * 100)) : 0;
  await updateGoal(goalId, {
    progress: percent,
    status: target && current >= target ? 'completed' : goal.status === 'completed' ? 'active' : goal.status,
  });
  return {
    goalId,
    goalType: goal.goalType,
    current,
    target,
    unit: goal.goalType === 'countdown' ? goal.targetUnit ?? '次' : '分钟',
    percent,
  };
}

export async function recordTodoGoalCompletion(todoId: string, options: { skipTimeBased?: boolean } = {}) {
  const todo = await loadTodoItemById(todoId);
  if (!todo?.goalId) return null;
  const goal = await loadGoal(todo.goalId);
  if (!goal) return null;
  if (goal.goalType === 'countdown') {
    if (todo.goalContribution <= 0) return null;
    return recordGoalProgressEvent({
      goalId: goal.id,
      kind: 'todo-completion',
      sourceId: todo.id,
      amount: todo.goalContribution,
      note: todo.title,
      occurredAt: todo.completedAt ?? Date.now(),
    });
  }
  const action = determineTodoTimeCreditAction({
    goalType: goal.goalType,
    estimatedMinutes: todo.estimatedMinutes,
    completedBySchedule: options.skipTimeBased,
  });
  if (action.kind === 'credit') {
    return recordGoalProgressEvent({
      goalId: goal.id,
      kind: 'todo-time-credit',
      sourceId: todo.id,
      amount: action.minutes,
      note: todo.title,
      occurredAt: todo.completedAt ?? Date.now(),
    });
  }
  if (action.kind === 'none') return null;
  await createGoalTimeCreditRequest(todo.id, goal.id, todo.title);
  return null;
}

export async function backfillTimeBasedGoalCredits() {
  const goals = (await loadGoals()).filter((goal) => goal.goalType === 'time_based');
  for (const goal of goals) {
    const events = await loadGoalProgressEvents(goal.id);
    const creditedTodoIds = new Set(events.filter((event) => event.kind === 'todo-time-credit').map((event) => event.sourceId));
    const todos = await loadTodoItemsByGoalId(goal.id);
    for (const todo of todos.filter((item) => item.status === 'completed' && !!item.estimatedMinutes && !creditedTodoIds.has(item.id))) {
      const { hasCompletedScheduleOccurrenceForTodo } = await import('./scheduleStore');
      if (await hasCompletedScheduleOccurrenceForTodo(todo.id)) continue;
      await recordGoalProgressEvent({
        goalId: goal.id,
        kind: 'todo-time-credit',
        sourceId: todo.id,
        amount: todo.estimatedMinutes!,
        note: `${todo.title}（升级补记）`,
        occurredAt: todo.completedAt ?? todo.updatedAt,
      });
    }
  }
}

function weekDay(day: string) {
  return new Date(`${day}T12:00:00`).getDay() || 7;
}

function categoryForGoal(goal: Goal): TodoCategory {
  if (goal.lifeArea === 'work') return 'work';
  if (goal.lifeArea === 'health') return 'health';
  if (goal.lifeArea === 'relationships') return 'social';
  if (goal.lifeArea === 'creation') return 'creation';
  if (goal.lifeArea === 'leisure') return 'life';
  return 'study';
}

function goalAppliesOnDate(goal: Goal, day: string) {
  if (goal.goalType !== 'countdown' || goal.status !== 'active') return false;
  if (goal.frequency === 'daily') return true;
  if (goal.frequency === 'weekly') {
    const days = goal.weekDays.length ? goal.weekDays : [weekDay(dateKey(new Date(goal.createdAt)))];
    return days.includes(weekDay(day));
  }
  return false;
}

export async function generateGoalTodosForDate(day: string) {
  const today = dateKey(new Date());
  if (day < today) return [];
  const goals = await loadGoals();
  const created = [];
  for (const goal of goals.filter((item) => goalAppliesOnDate(item, day))) {
    const snapshot = await recalculateGoalProgress(goal.id);
    if (snapshot?.target && snapshot.current >= snapshot.target) continue;
    try {
      created.push(await createTodoItem({
        title: goal.actionTitle || `${goal.title} · 推进 ${goal.actionAmount} ${goal.targetUnit ?? '次'}`,
        notes: `目标：${goal.title}`,
        plannedForDate: day,
        source: 'goal',
        priority: goal.priority,
        quadrant: 'q2',
        category: categoryForGoal(goal),
        goalId: goal.id,
        goalContribution: goal.actionAmount,
        reminderMode: 'followup',
      }, day === today ? 'today' : 'scheduled'));
    } catch {
      // The unique goal/date index makes repeated or concurrent generation idempotent.
    }
  }
  return created;
}
