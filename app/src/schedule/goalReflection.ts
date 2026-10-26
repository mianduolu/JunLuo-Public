import {
  scheduleSemanticStorageBridge as AsyncStorage,
} from '../sync/syncScheduleSemanticStorageBridge';

import { dateKey } from './scheduleStore';
import { updateGoal, type Goal, type LifeAreaType } from './goalStore';
import { loadCompletedTodoItemsForDates, type TodoCategory, type TodoItem } from './todoStore';

const COOLDOWN_KEY = 'junluo.schedule.goal-suggestion-cooldowns.v1';
const DAY_MS = 24 * 60 * 60 * 1000;

const AREA_BY_CATEGORY: Record<TodoCategory, LifeAreaType> = {
  study: 'growth',
  work: 'work',
  health: 'health',
  life: 'leisure',
  social: 'relationships',
  leisure: 'leisure',
  creation: 'creation',
  other: 'other',
};
const CATEGORY_LABELS: Record<TodoCategory, string> = {
  study: '学习', work: '工作', health: '健康', life: '生活', social: '社交', leisure: '休闲', creation: '创作', other: '其他',
};

async function loadCooldowns() {
  try {
    return JSON.parse(await AsyncStorage.getItem(COOLDOWN_KEY) || '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

export async function dismissLocalGoalSuggestion(category: TodoCategory, now = Date.now()) {
  const cooldowns = await loadCooldowns();
  cooldowns[category] = now + 28 * DAY_MS;
  await AsyncStorage.setItem(COOLDOWN_KEY, JSON.stringify(cooldowns));
}

function recentDateKeys(days: number, now = new Date()) {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(now);
    date.setDate(date.getDate() - index);
    return dateKey(date);
  });
}

function hasRecentGoalActivity(goal: Goal, tasks: TodoItem[]) {
  return tasks.some((task) => task.goalId === goal.id);
}

export async function loadLocalGoalReflectionNotes(goals: Goal[], now = Date.now()) {
  const tasks = await loadCompletedTodoItemsForDates(recentDateKeys(28, new Date(now)), 500);
  const notes: string[] = [];
  for (const goal of goals.filter((item) => item.goalType === 'direction' && item.status === 'active')) {
    const due = !goal.lastDirectionCheckAt || now - goal.lastDirectionCheckAt >= 28 * DAY_MS;
    if (due && !hasRecentGoalActivity(goal, tasks)) {
      notes.push(`“${goal.title}”最近 28 天没有关联活动。它现在还重要吗？不用急着回答。`);
      await updateGoal(goal.id, { lastDirectionCheckAt: now });
    }
  }

  const recent14Start = now - 14 * DAY_MS;
  const counts = new Map<TodoCategory, number>();
  tasks.filter((task) => (task.completedAt ?? 0) >= recent14Start).forEach((task) => {
    counts.set(task.category, (counts.get(task.category) ?? 0) + 1);
  });
  const cooldowns = await loadCooldowns();
  const suggestion = [...counts.entries()]
    .filter(([category, count]) => count >= 5 && (cooldowns[category] ?? 0) <= now)
    .filter(([category]) => !goals.some((goal) => goal.status === 'active' && goal.lifeArea === AREA_BY_CATEGORY[category]))
    .sort((a, b) => b[1] - a[1])[0];
  if (suggestion) {
    const [category, count] = suggestion;
    notes.push(`近两周鼠完成了 ${count} 项“${CATEGORY_LABELS[category]}”相关小事。要不要把它收成一个目标？不建也完全没关系。`);
  }
  return notes.slice(0, 2);
}
