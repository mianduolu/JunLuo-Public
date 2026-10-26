import { generateDayReviewFromLocalData, loadDayReview, type DayReview } from './dayReviewStore';
import { loadDailyChallengesForDate } from './dailyChallengeStore';
import { getLifeAreaConfig, loadGoals, type Goal } from './goalStore';
import { loadHabitSummaryForDate } from './habitStore';
import { dateKey } from './scheduleStore';
import { compareWeekReviewMetrics, type WeekReviewComparison, type WeekReviewMetrics } from './reviewMetrics';
import { loadLocalGoalReflectionNotes } from './goalReflection';
import { getTodoDatabase as getDatabase } from './todoDatabase';
import { makeTodoNaturalRecordId } from './todoIdentity';
import {
  loadCompletedTodoItemsForDates,
  loadTodoItemById,
  loadTodoItemsForDates,
  type TodoCategory,
  type TodoItem,
} from './todoStore';

export type WeekReview = {
  id: string;
  weekStart: string;
  weekEnd: string;
  summary: string;
  wins: string[];
  gaps: string[];
  goalProgress: string[];
  habitInsights: string[];
  nextWeekSuggestions: string[];
  baiyunMessage: string;
  metricsSnapshot?: WeekReviewMetrics;
  comparison?: WeekReviewComparison;
  createdAt: number;
  updatedAt: number;
};

export type WeekHabitStat = {
  habitId: string;
  title: string;
  category: TodoCategory;
  doneDays: number;
  totalDays: number;
  completedCount: number;
  targetCount: number;
};

export type WeekReviewLocalData = {
  weekStart: string;
  weekEnd: string;
  days: string[];
  tasks: TodoItem[];
  completedTasks: TodoItem[];
  incompleteTasks: TodoItem[];
  totalTrackedMinutes: number;
  minutesByCategory: Record<TodoCategory, number>;
  habitStats: WeekHabitStat[];
  challengeStats: Array<{ challengeId: string; title: string; completedDays: number; totalDays: number; streak: number }>;
  goalNotes: string[];
  goals: Goal[];
  dayReviews: DayReview[];
  metrics: WeekReviewMetrics;
  comparison?: WeekReviewComparison;
};

type WeekReviewRow = {
  id: string;
  week_start: string;
  week_end: string;
  summary: string;
  wins: string;
  gaps: string;
  goal_progress: string;
  habit_insights: string;
  next_week_suggestions: string;
  baiyun_message: string;
  created_at: number;
  updated_at: number;
  metrics_snapshot: string | null;
  comparison_snapshot: string | null;
};

const TODO_CATEGORIES: TodoCategory[] = ['study', 'work', 'health', 'life', 'social', 'leisure', 'creation', 'other'];
const WEEK_REVIEW_HOUR = 21;

function parseDateKey(key: string) {
  const date = new Date(`${key}T12:00:00`);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

export function weekStartKeyFromDate(date: Date) {
  const start = new Date(date);
  const day = start.getDay() || 7;
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - day + 1);
  return dateKey(start);
}

export function weekKeysFromStart(weekStart: string) {
  const start = parseDateKey(weekStart);
  return Array.from({ length: 7 }, (_, index) => dateKey(addDays(start, index)));
}

function emptyMinutesByCategory(): Record<TodoCategory, number> {
  return TODO_CATEGORIES.reduce((result, category) => {
    result[category] = 0;
    return result;
  }, {} as Record<TodoCategory, number>);
}

function parseStringList(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function fromRow(row: WeekReviewRow): WeekReview {
  return {
    id: row.id,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    summary: row.summary,
    wins: parseStringList(row.wins),
    gaps: parseStringList(row.gaps),
    goalProgress: parseStringList(row.goal_progress),
    habitInsights: parseStringList(row.habit_insights),
    nextWeekSuggestions: parseStringList(row.next_week_suggestions),
    baiyunMessage: row.baiyun_message,
    metricsSnapshot: parseJsonObject<WeekReviewMetrics>(row.metrics_snapshot),
    comparison: parseJsonObject<WeekReviewComparison>(row.comparison_snapshot),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonObject<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
}

export function shouldOfferWeekReview(weekStart: string, now = new Date()) {
  return weekStart === weekStartKeyFromDate(now) && now.getDay() === 0 && now.getHours() >= WEEK_REVIEW_HOUR;
}

export async function loadWeekReview(weekStart: string) {
  const database = await getDatabase();
  const normalizedWeekStart = weekStartKeyFromDate(parseDateKey(weekStart));
  const row = await database.getFirstAsync<WeekReviewRow>(
    'SELECT * FROM week_reviews WHERE week_start = ?',
    normalizedWeekStart,
  );
  return row ? fromRow(row) : null;
}

export async function saveWeekReview(review: WeekReview) {
  const database = await getDatabase();
  await database.runAsync(
    `INSERT INTO week_reviews
      (id, week_start, week_end, summary, wins, gaps, goal_progress, habit_insights, next_week_suggestions, baiyun_message, metrics_snapshot, comparison_snapshot, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(week_start) DO UPDATE SET
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
       updated_at = excluded.updated_at`,
    review.id,
    review.weekStart,
    review.weekEnd,
    review.summary,
    JSON.stringify(review.wins),
    JSON.stringify(review.gaps),
    JSON.stringify(review.goalProgress),
    JSON.stringify(review.habitInsights),
    JSON.stringify(review.nextWeekSuggestions),
    review.baiyunMessage,
    review.metricsSnapshot ? JSON.stringify(review.metricsSnapshot) : null,
    review.comparison ? JSON.stringify(review.comparison) : null,
    review.createdAt,
    review.updatedAt,
  );
}

export async function generateWeekReviewFromLocalData(weekStart: string): Promise<WeekReviewLocalData> {
  const normalizedWeekStart = weekStartKeyFromDate(parseDateKey(weekStart));
  const days = weekKeysFromStart(normalizedWeekStart);
  const weekEnd = days[6];
  const previousWeekStart = dateKey(addDays(parseDateKey(normalizedWeekStart), -7));
  const [tasksForWeek, completedForWeek, goals, habitSummaries, challengeSummaries, dayReviews, previousReview] = await Promise.all([
    loadTodoItemsForDates(days, true),
    loadCompletedTodoItemsForDates(days, 300),
    loadGoals(),
    Promise.all(days.map((day) => loadHabitSummaryForDate(day))),
    Promise.all(days.map((day) => loadDailyChallengesForDate(day, false))),
    Promise.all(days.map((day) => loadDayReview(day))),
    loadWeekReview(previousWeekStart),
  ]);
  const byTaskId = new Map<string, TodoItem>();
  [...tasksForWeek, ...completedForWeek].forEach((task) => byTaskId.set(task.id, task));
  const minutesByCategory = emptyMinutesByCategory();
  const dayMetrics = await Promise.all(days.map(async (day, index) => dayReviews[index]?.metricsSnapshot ?? (await generateDayReviewFromLocalData(day)).metrics));
  const metrics: WeekReviewMetrics = dayMetrics.reduce((result, item) => ({
    plannedCount: result.plannedCount + item.plannedCount,
    plannedCompletedCount: result.plannedCompletedCount + item.plannedCompletedCount,
    actualCompletedCount: result.actualCompletedCount + item.actualCompletedCount,
    habitDone: result.habitDone + item.habitsDone,
    habitTotal: result.habitTotal + item.habitsTotal,
    goalsProgressed: result.goalsProgressed + item.goalsProgressed,
    goalsStalled: result.goalsStalled,
    completedPlannedMinutes: result.completedPlannedMinutes + item.completedPlannedMinutes,
  }), { plannedCount: 0, plannedCompletedCount: 0, actualCompletedCount: 0, habitDone: 0, habitTotal: 0, goalsProgressed: 0, goalsStalled: 0, completedPlannedMinutes: 0 });

  const habitStatsById = new Map<string, WeekHabitStat>();
  habitSummaries.forEach((summary) => {
    summary.habits.forEach((habit) => {
      const current = habitStatsById.get(habit.id) ?? {
        habitId: habit.id,
        title: habit.title,
        category: habit.category,
        doneDays: 0,
        totalDays: 0,
        completedCount: 0,
        targetCount: 0,
      };
      current.totalDays += 1;
      current.targetCount += habit.targetCount;
      current.completedCount += habit.log?.completedCount ?? 0;
      if (habit.completedToday) current.doneDays += 1;
      habitStatsById.set(habit.id, current);
    });
  });

  const tasks = [...byTaskId.values()].filter((task) => task.status !== 'cancelled');
  const completedTasks = tasks.filter((task) => task.status === 'completed');
  const incompleteTasks = tasks.filter((task) => task.status !== 'completed');
  const goalNotes = goals
    .map((goal) => {
      const related = tasks.filter((task) => task.goalId === goal.id);
      if (!related.length) return '';
      const done = related.filter((task) => task.status === 'completed').length;
      const area = getLifeAreaConfig(goal.lifeArea);
      return `${area.icon} ${goal.title}：本周相关 ${related.length} 项，完成 ${done} 项，目标进度 ${goal.progress}%`;
    })
    .filter(Boolean)
    .slice(0, 6);
  goalNotes.push(...await loadLocalGoalReflectionNotes(goals));
  metrics.goalsStalled = goals.filter((goal) => !tasks.some((task) => task.goalId === goal.id && task.status === 'completed')).length;
  const challengeStatsById = new Map<string, { challengeId: string; title: string; completedDays: number; totalDays: number; streak: number }>();
  challengeSummaries.forEach((entries) => {
    entries.forEach((entry) => {
      const current = challengeStatsById.get(entry.challenge.id) ?? {
        challengeId: entry.challenge.id,
        title: entry.challenge.title,
        completedDays: 0,
        totalDays: 0,
        streak: entry.streak,
      };
      current.totalDays += 1;
      if (entry.completed) current.completedDays += 1;
      current.streak = entry.streak;
      challengeStatsById.set(entry.challenge.id, current);
    });
  });

  return {
    weekStart: normalizedWeekStart,
    weekEnd,
    days,
    tasks,
    completedTasks,
    incompleteTasks,
    totalTrackedMinutes: metrics.completedPlannedMinutes,
    minutesByCategory,
    habitStats: [...habitStatsById.values()],
    challengeStats: [...challengeStatsById.values()],
    goalNotes,
    goals,
    dayReviews: dayReviews.filter((review): review is DayReview => review !== null),
    metrics,
    comparison: compareWeekReviewMetrics(metrics, previousReview?.metricsSnapshot),
  };
}

export function hasWeekReviewSourceData(data: WeekReviewLocalData) {
  return !!(
    data.tasks.length ||
    data.totalTrackedMinutes ||
    data.habitStats.length ||
    data.challengeStats.length ||
    data.goalNotes.length ||
    data.dayReviews.length
  );
}

export function makeWeekReview(input: Omit<WeekReview, 'id' | 'createdAt' | 'updatedAt'>): WeekReview {
  const now = Date.now();
  return {
    ...input,
    id: makeTodoNaturalRecordId('week-review', [input.weekStart]),
    createdAt: now,
    updatedAt: now,
  };
}
