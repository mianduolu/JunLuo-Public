import {
  archiveHabit,
  createHabit,
  loadHabitById,
  loadHabitLogForDate,
  updateHabit,
} from './habitStore';
import { dateKey } from './scheduleStore';
import { getTodoDatabase as getDatabase } from './todoDatabase';
import {
  cancelOpenDailyChallengeTodos,
  createTodoItem,
  expireDailyChallengeTodosBefore,
  loadDailyChallengeTodo,
  loadDailyChallengeTodosForDate,
  updateOpenDailyChallengeTodos,
  type TodoCategory,
  type TodoItem,
  type TodoQuadrant,
} from './todoStore';

export type DailyChallengeStatus = 'active' | 'archived';

export type DailyChallenge = {
  id: string;
  title: string;
  category: TodoCategory;
  quadrant: TodoQuadrant;
  estimatedMinutes: number;
  habitId: string;
  status: DailyChallengeStatus;
  createdAt: number;
  updatedAt: number;
};

export type DailyChallengeDraft = Pick<DailyChallenge, 'title' | 'category' | 'quadrant' | 'estimatedMinutes'>;

export type DailyChallengeForDate = {
  challenge: DailyChallenge;
  todo: TodoItem;
  completed: boolean;
  streak: number;
  bestStreak: number;
};

export type DailyChallengeSummaryForDate = {
  dateKey: string;
  challenges: DailyChallengeForDate[];
  completed: DailyChallengeForDate[];
  pending: DailyChallengeForDate[];
};

type DailyChallengeRow = {
  id: string;
  title: string;
  category: TodoCategory;
  quadrant: TodoQuadrant;
  estimated_minutes: number;
  habit_id: string;
  status: DailyChallengeStatus;
  created_at: number;
  updated_at: number;
};

const CATEGORIES: TodoCategory[] = ['study', 'work', 'health', 'life', 'social', 'leisure', 'creation', 'other'];
const QUADRANTS: TodoQuadrant[] = ['q1', 'q2', 'q3', 'q4'];

function makeId() {
  return `challenge-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeDraft(draft: DailyChallengeDraft): DailyChallengeDraft {
  return {
    title: draft.title.trim().slice(0, 80),
    category: CATEGORIES.includes(draft.category) ? draft.category : 'other',
    quadrant: QUADRANTS.includes(draft.quadrant) ? draft.quadrant : 'q2',
    estimatedMinutes: Math.max(5, Math.min(24 * 60, Math.round(draft.estimatedMinutes))),
  };
}

function fromRow(row: DailyChallengeRow): DailyChallenge {
  return {
    id: row.id,
    title: row.title,
    category: CATEGORIES.includes(row.category) ? row.category : 'other',
    quadrant: QUADRANTS.includes(row.quadrant) ? row.quadrant : 'q2',
    estimatedMinutes: Math.max(5, row.estimated_minutes),
    habitId: row.habit_id,
    status: row.status === 'archived' ? 'archived' : 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadDailyChallenge(challengeId: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<DailyChallengeRow>(
    'SELECT * FROM daily_challenges WHERE id = ?',
    challengeId,
  );
  return row ? fromRow(row) : null;
}

export async function loadDailyChallenges(includeArchived = false) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<DailyChallengeRow>(
    `SELECT * FROM daily_challenges ${includeArchived ? '' : "WHERE status = 'active'"} ORDER BY updated_at DESC`,
  );
  return rows.map(fromRow);
}

export async function createDailyChallenge(draft: DailyChallengeDraft) {
  const normalized = normalizeDraft(draft);
  if (!normalized.title) throw new Error('挑战标题不能为空');
  if (!Number.isFinite(draft.estimatedMinutes) || draft.estimatedMinutes <= 0) {
    throw new Error('每日挑战需要填写估时');
  }
  const backingHabit = await createHabit({
    title: normalized.title,
    category: normalized.category,
    frequency: 'daily',
    targetCount: 1,
    kind: 'daily-challenge',
    scheduleInstances: { enabled: false, reminderMinutesBefore: 0 },
  });
  const database = await getDatabase();
  const now = Date.now();
  const challenge: DailyChallenge = {
    id: makeId(),
    ...normalized,
    habitId: backingHabit.id,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  try {
    await database.runAsync(
      `INSERT INTO daily_challenges
        (id, title, category, quadrant, estimated_minutes, habit_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      challenge.id,
      challenge.title,
      challenge.category,
      challenge.quadrant,
      challenge.estimatedMinutes,
      challenge.habitId,
      challenge.status,
      challenge.createdAt,
      challenge.updatedAt,
    );
  } catch (error) {
    await archiveHabit(backingHabit.id);
    throw error;
  }
  return challenge;
}

export async function updateDailyChallenge(challengeId: string, patch: Partial<DailyChallengeDraft>) {
  const current = await loadDailyChallenge(challengeId);
  if (!current) return null;
  const next = normalizeDraft({
    title: patch.title ?? current.title,
    category: patch.category ?? current.category,
    quadrant: patch.quadrant ?? current.quadrant,
    estimatedMinutes: patch.estimatedMinutes ?? current.estimatedMinutes,
  });
  if (!next.title) throw new Error('挑战标题不能为空');
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE daily_challenges
     SET title = ?, category = ?, quadrant = ?, estimated_minutes = ?, updated_at = ?
     WHERE id = ?`,
    next.title,
    next.category,
    next.quadrant,
    next.estimatedMinutes,
    Date.now(),
    challengeId,
  );
  await updateHabit(current.habitId, { title: next.title, category: next.category });
  await updateOpenDailyChallengeTodos(challengeId, next);
  return loadDailyChallenge(challengeId);
}

export async function archiveDailyChallenge(challengeId: string) {
  const challenge = await loadDailyChallenge(challengeId);
  if (!challenge) return;
  const database = await getDatabase();
  await database.runAsync(
    "UPDATE daily_challenges SET status = 'archived', updated_at = ? WHERE id = ?",
    Date.now(),
    challengeId,
  );
  await archiveHabit(challenge.habitId);
  await cancelOpenDailyChallengeTodos(challengeId);
}

function isPastDate(day: string) {
  return day < dateKey(new Date());
}

export async function generateDailyChallenges(day: string) {
  const normalizedDay = day.slice(0, 10);
  await expireDailyChallengeTodosBefore(dateKey(new Date()));
  if (isPastDate(normalizedDay)) return loadDailyChallengesForDate(normalizedDay, false);
  const challenges = await loadDailyChallenges();
  for (const challenge of challenges) {
    const existing = await loadDailyChallengeTodo(challenge.id, normalizedDay);
    if (existing) continue;
    try {
      await createTodoItem({
        title: challenge.title,
        notes: '',
        plannedForDate: normalizedDay,
        source: 'daily-challenge',
        priority: 'normal',
        quadrant: challenge.quadrant,
        category: challenge.category,
        estimatedMinutes: challenge.estimatedMinutes,
        challengeId: challenge.id,
        habitId: challenge.habitId,
        reminderMode: 'none',
      }, normalizedDay === dateKey(new Date()) ? 'today' : 'scheduled');
    } catch (error) {
      const raced = await loadDailyChallengeTodo(challenge.id, normalizedDay);
      if (!raced) throw error;
    }
  }
  return loadDailyChallengesForDate(normalizedDay, false);
}

export async function loadDailyChallengesForDate(day: string, generate = true): Promise<DailyChallengeForDate[]> {
  if (generate && !isPastDate(day)) return generateDailyChallenges(day);
  const [todos, challenges] = await Promise.all([
    loadDailyChallengeTodosForDate(day),
    loadDailyChallenges(true),
  ]);
  const challengeById = new Map(challenges.map((challenge) => [challenge.id, challenge]));
  const result: DailyChallengeForDate[] = [];
  for (const todo of todos) {
    const challenge = todo.challengeId ? challengeById.get(todo.challengeId) : undefined;
    if (!challenge) continue;
    const [habit, log] = await Promise.all([
      loadHabitById(challenge.habitId),
      loadHabitLogForDate(challenge.habitId, day),
    ]);
    result.push({
      challenge,
      todo,
      completed: todo.status === 'completed' || (log?.completedCount ?? 0) >= 1,
      streak: habit?.streak ?? 0,
      bestStreak: habit?.bestStreak ?? 0,
    });
  }
  return result;
}

export async function loadDailyChallengeSummaryForDate(day: string): Promise<DailyChallengeSummaryForDate> {
  const challenges = await loadDailyChallengesForDate(day);
  return {
    dateKey: day,
    challenges,
    completed: challenges.filter((item) => item.completed),
    pending: challenges.filter((item) => !item.completed),
  };
}
