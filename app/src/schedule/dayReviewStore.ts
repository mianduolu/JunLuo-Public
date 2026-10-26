import { getLifeAreaConfig, loadGoals, type Goal } from './goalStore';
import { loadDailyChallengeSummaryForDate, type DailyChallengeForDate } from './dailyChallengeStore';
import { loadHabitSummaryForDate, type HabitSummaryForDate } from './habitStore';
import { dateKey, loadScheduleCompletionsForDate, loadScheduleItemsForDate, type ScheduleOccurrence } from './scheduleStore';
import { ensureDayTemplateInstances, loadDayTemplateCompletionsForDate, loadDayTemplateInstances } from './dayTemplateInstanceStore';
import { compareDayReviewMetrics, type DayReviewComparison, type DayReviewMetrics } from './reviewMetrics';
import { getTodoDatabase as getDatabase } from './todoDatabase';
import {
  loadCompletedTodoItemsForDates,
  loadActiveInhibitTodosForDate,
  loadInhibitLogsForDate,
  loadTodoCompletionsForDate,
  loadTodoItemsForDate,
  type TodoCategory,
  type TodoItem,
} from './todoStore';

export type DayReview = {
  id: string;
  dateKey: string;
  summary: string;
  completedTaskTitles: string[];
  pendingTaskTitles: string[];
  minutesByCategory: Record<TodoCategory, number>;
  totalTrackedMinutes: number;
  goalNotes: string[];
  habitsDone: number;
  habitsTotal: number;
  habitNotes: string[];
  baiyunMessage: string;
  metricsSnapshot?: DayReviewMetrics;
  comparison?: DayReviewComparison;
  createdAt: number;
  updatedAt: number;
};

export type DayReviewLocalData = {
  dateKey: string;
  tasks: TodoItem[];
  completedTasks: TodoItem[];
  pendingTasks: TodoItem[];
  minutesByCategory: Record<TodoCategory, number>;
  totalTrackedMinutes: number;
  goalNotes: string[];
  habitSummary: HabitSummaryForDate;
  habitNotes: string[];
  dailyChallenges: DailyChallengeForDate[];
  challengeNotes: string[];
  inhibitNotes: string[];
  goals: Goal[];
  scheduleOccurrences: ScheduleOccurrence[];
  metrics: DayReviewMetrics;
  comparison?: DayReviewComparison;
};

type DayReviewRow = {
  id: string;
  date_key: string;
  summary: string;
  completed_task_titles: string;
  pending_task_titles: string;
  minutes_by_category: string;
  total_tracked_minutes: number;
  goal_notes: string;
  habits_done: number | null;
  habits_total: number | null;
  habit_notes: string | null;
  baiyun_message: string;
  created_at: number;
  updated_at: number;
  metrics_snapshot: string | null;
  comparison_snapshot: string | null;
};

const TODO_CATEGORIES: TodoCategory[] = ['study', 'work', 'health', 'life', 'social', 'leisure', 'creation', 'other'];

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

function parseMinutesByCategory(value: string): Record<TodoCategory, number> {
  const minutes = emptyMinutesByCategory();
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    TODO_CATEGORIES.forEach((category) => {
      const raw = parsed[category];
      minutes[category] = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
    });
  } catch {
    // Keep defaults.
  }
  return minutes;
}

function fromRow(row: DayReviewRow): DayReview {
  return {
    id: row.id,
    dateKey: row.date_key,
    summary: row.summary,
    completedTaskTitles: parseStringList(row.completed_task_titles),
    pendingTaskTitles: parseStringList(row.pending_task_titles),
    minutesByCategory: parseMinutesByCategory(row.minutes_by_category),
    totalTrackedMinutes: Math.max(0, row.total_tracked_minutes ?? 0),
    goalNotes: parseStringList(row.goal_notes),
    habitsDone: Math.max(0, row.habits_done ?? 0),
    habitsTotal: Math.max(0, row.habits_total ?? 0),
    habitNotes: parseStringList(row.habit_notes ?? '[]'),
    baiyunMessage: row.baiyun_message,
    metricsSnapshot: parseJsonObject<DayReviewMetrics>(row.metrics_snapshot),
    comparison: parseJsonObject<DayReviewComparison>(row.comparison_snapshot),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonObject<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
}

// Existing reviews are historical input for weekly review only; no daily AI writer remains.
export async function loadDayReview(day: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<DayReviewRow>('SELECT * FROM day_reviews WHERE date_key = ?', day);
  return row ? fromRow(row) : null;
}

// Free local statistics used when a week has no historical daily review cache.
export async function generateDayReviewFromLocalData(day: string): Promise<DayReviewLocalData> {
  await ensureDayTemplateInstances(day);
  const previousDate = new Date(`${day}T12:00:00`);
  previousDate.setDate(previousDate.getDate() - 1);
  const previousReviewPromise = loadDayReview(dateKey(previousDate));
  const [pendingTasks, completedTasks, actualTodoCompletions, goals, scheduleOccurrences, actualScheduleCompletions, templateInstances, actualTemplateCompletions, habitSummary, challengeSummary, activeInhibits, inhibitLogs, previousReview] = await Promise.all([
    loadTodoItemsForDate(day),
    loadCompletedTodoItemsForDates([day], 120),
    loadTodoCompletionsForDate(day),
    loadGoals(),
    loadScheduleItemsForDate(new Date(`${day}T12:00:00`)),
    loadScheduleCompletionsForDate(day),
    loadDayTemplateInstances(day),
    loadDayTemplateCompletionsForDate(day),
    loadHabitSummaryForDate(day),
    loadDailyChallengeSummaryForDate(day),
    loadActiveInhibitTodosForDate(day),
    loadInhibitLogsForDate(day),
    previousReviewPromise,
  ]);
  const byTaskId = new Map<string, TodoItem>();
  [...pendingTasks, ...completedTasks].forEach((task) => byTaskId.set(task.id, task));
  const minutesByCategory = emptyMinutesByCategory();
  const tasks = [...byTaskId.values()];
  const plannedTodoIds = new Set(tasks.map((task) => task.id));
  const standaloneOccurrences = scheduleOccurrences.filter((item) => !item.todoId || !plannedTodoIds.has(item.todoId));
  standaloneOccurrences.filter((item) => item.status === 'completed').forEach((item) => {
    const task = item.todoId ? byTaskId.get(item.todoId) : undefined;
    minutesByCategory[task?.category ?? 'other'] += Math.max(0, Math.round(((item.endAt ?? item.scheduledStartAt) - item.scheduledStartAt) / 60000));
  });
  const completedPlannedMinutes = standaloneOccurrences
    .filter((item) => item.status === 'completed')
    .reduce((sum, item) => sum + Math.max(0, Math.round(((item.endAt ?? item.scheduledStartAt) - item.scheduledStartAt) / 60000)), 0);
  const actualScheduleStandalone = actualScheduleCompletions.filter((item) => !item.todoId || !actualTodoCompletions.some((task) => task.id === item.todoId));
  const progressedGoalIds = new Set(actualTodoCompletions.map((task) => task.goalId).filter((id): id is string => !!id));
  const metrics: DayReviewMetrics = {
    plannedCount: tasks.length + standaloneOccurrences.length + templateInstances.length,
    plannedCompletedCount: tasks.filter((task) => task.status === 'completed').length + standaloneOccurrences.filter((item) => item.status === 'completed').length + templateInstances.filter((item) => item.status === 'completed').length,
    actualCompletedCount: actualTodoCompletions.length + actualScheduleStandalone.length + actualTemplateCompletions.length,
    schedulePlannedCount: standaloneOccurrences.length,
    scheduleCompletedCount: standaloneOccurrences.filter((item) => item.status === 'completed').length,
    templatePlannedCount: templateInstances.length,
    templateCompletedCount: templateInstances.filter((item) => item.status === 'completed').length,
    habitsDone: habitSummary.done,
    habitsTotal: habitSummary.total,
    goalsProgressed: progressedGoalIds.size,
    completedPlannedMinutes,
  };
  const goalNotes = goals
    .map((goal) => {
      const related = tasks.filter((task) => task.goalId === goal.id);
      if (!related.length) return '';
      const done = related.filter((task) => task.status === 'completed').length;
      const area = getLifeAreaConfig(goal.lifeArea);
      return `${area.icon} ${goal.title}：今日相关 ${related.length} 项，完成 ${done} 项，目标进度 ${goal.progress}%`;
    })
    .filter(Boolean)
    .slice(0, 4);
  const habitNotes = habitSummary.habits
    .map((habit) => `${habit.completedToday ? '完成' : '未完成'}：${habit.title}（${habit.log?.completedCount ?? 0}/${habit.targetCount} 次，连续 ${habit.streak} 天）`)
    .slice(0, 6);
  const challengeNotes = challengeSummary.challenges
    .map((entry) => `${entry.completed ? '完成' : '未完成'}：${entry.challenge.title}（连续 ${entry.streak} 天）`)
    .slice(0, 6);
  const inhibitLogByTodoId = new Map(inhibitLogs.map((log) => [log.todoId, log]));
  const inhibitNotes = activeInhibits
    .map((todo) => {
      const outcome = inhibitLogByTodoId.get(todo.id)?.outcome;
      if (outcome === 'kept') return `今天守住了：${todo.title}`;
      if (outcome === 'slipped') return `今天没忍住：${todo.title}`;
      if (outcome === 'unrecorded') return `今天暂不记录：${todo.title}`;
      return '';
    })
    .filter(Boolean)
    .slice(0, 6);
  return {
    dateKey: day,
    tasks,
    completedTasks: actualTodoCompletions,
    pendingTasks: pendingTasks.filter((task) => task.status !== 'cancelled'),
    minutesByCategory,
    totalTrackedMinutes: completedPlannedMinutes,
    goalNotes,
    habitSummary,
    habitNotes,
    dailyChallenges: challengeSummary.challenges,
    challengeNotes,
    inhibitNotes,
    goals,
    scheduleOccurrences,
    metrics,
    comparison: compareDayReviewMetrics(metrics, previousReview?.metricsSnapshot),
  };
}
