import { dateKey } from './scheduleStore';
import { getTodoDatabase as getDatabase } from './todoDatabase';
import { completeTodoItem, updateTodoItem } from './todoStore';

export type TaskExecutionStatus = 'running' | 'paused' | 'finished';
export type TaskExecutionNudgeKind = 'timeReached' | 'stuck' | 'breakNeeded';

export type TaskExecutionSession = {
  id: string;
  todoId: string;
  status: TaskExecutionStatus;
  startedAt: number;
  pausedAt?: number;
  endedAt?: number;
  accumulatedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type TaskExecutionNudge = {
  sessionId: string;
  todoId: string;
  kind: TaskExecutionNudgeKind;
  createdAt: number;
  deliveredAt?: number;
};

export type TaskExecutionSummary = {
  date: string;
  totalMinutes: number;
  minutesByTodoId: Record<string, number>;
};

type SessionRow = {
  id: string;
  todo_id: string;
  status: TaskExecutionStatus;
  started_at: number;
  paused_at: number | null;
  ended_at: number | null;
  accumulated_seconds: number;
  created_at: number;
  updated_at: number;
};

type NudgeRow = {
  session_id: string;
  todo_id: string;
  kind: TaskExecutionNudgeKind;
  created_at: number;
  delivered_at: number | null;
};

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function fromSessionRow(row: SessionRow): TaskExecutionSession {
  return {
    id: row.id,
    todoId: row.todo_id,
    status: row.status,
    startedAt: row.started_at,
    pausedAt: row.paused_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    accumulatedSeconds: Math.max(0, row.accumulated_seconds ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromNudgeRow(row: NudgeRow): TaskExecutionNudge {
  return {
    sessionId: row.session_id,
    todoId: row.todo_id,
    kind: row.kind,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined,
  };
}

function elapsedSecondsForSession(session: TaskExecutionSession, now = Date.now()) {
  if (session.status !== 'running') return session.accumulatedSeconds;
  return Math.max(0, session.accumulatedSeconds + Math.floor((now - session.updatedAt) / 1000));
}

async function persistTrackedMinutes(todoId: string, seconds: number) {
  if (seconds <= 0) return;
  const addedMinutes = Math.round(seconds / 60);
  if (addedMinutes <= 0) return;
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ tracked_minutes: number | null }>(
    'SELECT tracked_minutes FROM todo_items WHERE id = ?',
    todoId,
  );
  const previous = Math.max(0, row?.tracked_minutes ?? 0);
  const next = previous + addedMinutes;
  await updateTodoItem(todoId, { trackedMinutes: next });
}

async function pauseRunningSessions(exceptSessionId?: string, now = Date.now()) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<SessionRow>(
    "SELECT * FROM task_execution_sessions WHERE status = 'running'",
  );
  for (const session of rows.map(fromSessionRow)) {
    if (session.id === exceptSessionId) continue;
    const elapsedSeconds = elapsedSecondsForSession(session, now);
    const deltaSeconds = Math.max(0, elapsedSeconds - session.accumulatedSeconds);
    await database.runAsync(
      "UPDATE task_execution_sessions SET status = 'paused', paused_at = ?, accumulated_seconds = ?, updated_at = ? WHERE id = ?",
      now,
      elapsedSeconds,
      now,
      session.id,
    );
    await persistTrackedMinutes(session.todoId, deltaSeconds);
  }
}

export function getTaskExecutionElapsedSeconds(session: TaskExecutionSession, now = Date.now()) {
  return elapsedSecondsForSession(session, now);
}

export async function startTaskExecution(todoId: string) {
  void todoId;
  await freezeLegacyExecutionSessions();
  return null;
}

export async function loadActiveTaskExecution() {
  const database = await getDatabase();
  const row = await database.getFirstAsync<SessionRow>(
    "SELECT * FROM task_execution_sessions WHERE status IN ('running', 'paused') ORDER BY updated_at DESC LIMIT 1",
  );
  return row ? fromSessionRow(row) : null;
}

export async function pauseTaskExecution() {
  const active = await loadActiveTaskExecution();
  if (!active || active.status !== 'running') return active;
  const database = await getDatabase();
  const now = Date.now();
  const elapsedSeconds = elapsedSecondsForSession(active, now);
  const deltaSeconds = Math.max(0, elapsedSeconds - active.accumulatedSeconds);
  await database.runAsync(
    "UPDATE task_execution_sessions SET status = 'paused', paused_at = ?, accumulated_seconds = ?, updated_at = ? WHERE id = ?",
    now,
    elapsedSeconds,
    now,
    active.id,
  );
  await persistTrackedMinutes(active.todoId, deltaSeconds);
  return { ...active, status: 'paused' as const, pausedAt: now, accumulatedSeconds: elapsedSeconds, updatedAt: now };
}

export async function resumeTaskExecution() {
  await freezeLegacyExecutionSessions();
  return null;
}

export async function freezeLegacyExecutionSessions(now = Date.now()) {
  const database = await getDatabase();
  const marker = await database.getFirstAsync<{ applied_at: number }>(
    "SELECT applied_at FROM task_execution_migrations WHERE key = 'freeze-stopwatch-v1'",
  );
  if (marker) return marker.applied_at;
  const rows = await database.getAllAsync<SessionRow>(
    "SELECT * FROM task_execution_sessions WHERE status IN ('running', 'paused')",
  );
  for (const session of rows.map(fromSessionRow)) {
    const elapsedSeconds = elapsedSecondsForSession(session, now);
    const deltaSeconds = session.status === 'running' ? Math.max(0, elapsedSeconds - session.accumulatedSeconds) : 0;
    await database.runAsync(
      "UPDATE task_execution_sessions SET status = 'finished', ended_at = ?, paused_at = NULL, accumulated_seconds = ?, updated_at = ? WHERE id = ?",
      now,
      elapsedSeconds,
      now,
      session.id,
    );
    await persistTrackedMinutes(session.todoId, deltaSeconds);
  }
  await database.runAsync(
    'UPDATE task_execution_nudges SET delivered_at = COALESCE(delivered_at, ?)',
    now,
  );
  await database.runAsync(
    "INSERT OR IGNORE INTO task_execution_migrations (key, applied_at) VALUES ('freeze-stopwatch-v1', ?)",
    now,
  );
  return now;
}

export async function loadExecutionCutoverAt() {
  const database = await getDatabase();
  const marker = await database.getFirstAsync<{ applied_at: number }>(
    "SELECT applied_at FROM task_execution_migrations WHERE key = 'freeze-stopwatch-v1'",
  );
  return marker?.applied_at;
}

export async function finishTaskExecution(options: { completeTodo?: boolean } = {}) {
  const active = await loadActiveTaskExecution();
  if (!active) return null;
  const database = await getDatabase();
  const now = Date.now();
  const elapsedSeconds = elapsedSecondsForSession(active, now);
  const deltaSeconds = active.status === 'running' ? Math.max(0, elapsedSeconds - active.accumulatedSeconds) : 0;
  await database.runAsync(
    "UPDATE task_execution_sessions SET status = 'finished', ended_at = ?, paused_at = NULL, accumulated_seconds = ?, updated_at = ? WHERE id = ?",
    now,
    elapsedSeconds,
    now,
    active.id,
  );
  await persistTrackedMinutes(active.todoId, deltaSeconds);
  if (options.completeTodo) {
    await completeTodoItem(active.todoId);
  }
  return { ...active, status: 'finished' as const, endedAt: now, pausedAt: undefined, accumulatedSeconds: elapsedSeconds, updatedAt: now };
}

export async function ensureExecutionNudge(session: TaskExecutionSession, kind: TaskExecutionNudgeKind) {
  const database = await getDatabase();
  const existing = await database.getFirstAsync<NudgeRow>(
    'SELECT * FROM task_execution_nudges WHERE session_id = ? AND kind = ?',
    session.id,
    kind,
  );
  if (existing) return fromNudgeRow(existing);
  const now = Date.now();
  await database.runAsync(
    `INSERT INTO task_execution_nudges (session_id, todo_id, kind, created_at)
     VALUES (?, ?, ?, ?)`,
    session.id,
    session.todoId,
    kind,
    now,
  );
  return { sessionId: session.id, todoId: session.todoId, kind, createdAt: now };
}

export async function loadUndeliveredExecutionNudges() {
  const database = await getDatabase();
  const rows = await database.getAllAsync<NudgeRow>(
    'SELECT * FROM task_execution_nudges WHERE delivered_at IS NULL ORDER BY created_at ASC',
  );
  return rows.map(fromNudgeRow);
}

export async function markExecutionNudgeDelivered(nudge: Pick<TaskExecutionNudge, 'sessionId' | 'kind'>) {
  const database = await getDatabase();
  await database.runAsync(
    'UPDATE task_execution_nudges SET delivered_at = ? WHERE session_id = ? AND kind = ?',
    Date.now(),
    nudge.sessionId,
    nudge.kind,
  );
}

export async function loadExecutionSummaryForDate(day: string): Promise<TaskExecutionSummary> {
  const database = await getDatabase();
  const start = new Date(`${day}T00:00:00`).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  const rows = await database.getAllAsync<SessionRow>(
    `SELECT * FROM task_execution_sessions
     WHERE started_at < ? AND COALESCE(ended_at, updated_at, ?) >= ?`,
    end,
    Date.now(),
    start,
  );
  const minutesByTodoId: Record<string, number> = {};
  let totalMinutes = 0;
  rows.map(fromSessionRow).forEach((session) => {
    const sessionEnd = session.endedAt ?? (session.status === 'running' ? Date.now() : session.updatedAt);
    const overlapStart = Math.max(start, session.startedAt);
    const overlapEnd = Math.min(end, sessionEnd);
    const wallSeconds = Math.max(1, Math.round((sessionEnd - session.startedAt) / 1000));
    const focusedSeconds = getTaskExecutionElapsedSeconds(session, sessionEnd);
    const overlapSeconds = Math.round(focusedSeconds * Math.max(0, overlapEnd - overlapStart) / 1000 / wallSeconds);
    const minutes = Math.max(0, Math.round(overlapSeconds / 60));
    if (!minutes) return;
    minutesByTodoId[session.todoId] = (minutesByTodoId[session.todoId] ?? 0) + minutes;
    totalMinutes += minutes;
  });
  return { date: dateKey(new Date(`${day}T12:00:00`)), totalMinutes, minutesByTodoId };
}
