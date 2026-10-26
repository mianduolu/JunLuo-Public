import type { HabitFrequency } from './habitStore';
import type { TodoCategory, TodoItem, TodoQuadrant } from './todoStore';
import type { DayDisplayMode, DisplayRange, ViewMode } from './scheduleViewTypes';

export const quadrantConfig: Array<{ id: TodoQuadrant; title: string; hint: string; color: string; border: string; textColor: string }> = [
  { id: 'q1', title: '重要且紧急', hint: '马上做', color: '#FFF0EC', border: '#F4B4A5', textColor: '#A94E46' },
  { id: 'q2', title: '重要不紧急', hint: '计划做', color: '#FFFBE4', border: '#EAD872', textColor: '#B49205' },
  { id: 'q3', title: '不重要紧急', hint: '快速处理', color: '#EDF6FF', border: '#A9D0EF', textColor: '#4A84B8' },
  { id: 'q4', title: '不重要不紧急', hint: '还可以先放一放', color: '#F4F2F7', border: '#D9D2E4', textColor: '#77757D' },
];

export const categoryConfig: Array<{ id: TodoCategory; label: string; icon: string; color: string }> = [
  { id: 'study', label: '学习', icon: '📚', color: '#FF6B6B' },
  { id: 'work', label: '工作', icon: '💼', color: '#4ECDC4' },
  { id: 'health', label: '健康', icon: '❤', color: '#7BC67E' },
  { id: 'life', label: '生活', icon: '🏠', color: '#FFD93D' },
  { id: 'social', label: '社交', icon: '💬', color: '#C9B1FF' },
  { id: 'leisure', label: '休闲', icon: '🎮', color: '#6BCB77' },
  { id: 'creation', label: '创作', icon: '🎨', color: '#FF9EC7' },
  { id: 'other', label: '其他', icon: '📌', color: '#B0BEC5' },
];

export const priorityLabels: Record<TodoItem['priority'], string> = {
  high: '高',
  normal: '中',
  low: '低',
};

export const displayRangeLabels: Record<DisplayRange, string> = {
  all: '全部',
  today: '今天',
  tomorrow: '明天',
  threeDays: '3天内',
  week: '本周',
  month: '本月',
};

export const viewModeLabels: Record<ViewMode, string> = { day: '日', week: '周', month: '月' };

export const viewModeConfig: Array<{ id: ViewMode; icon: string; label: string }> = [
  { id: 'day', icon: '日', label: '日视图' },
  { id: 'week', icon: '周', label: '周视图' },
  { id: 'month', icon: '月', label: '月视图' },
];

export const habitFrequencyLabels: Record<HabitFrequency, string> = {
  daily: '每天',
  weekly: '每周',
  custom: '自定义',
  interval: '间隔天数',
};

export const dayDisplayModeConfig: Array<{ id: DayDisplayMode; icon: string; label: string }> = [
  { id: 'scheduleList', icon: '☰', label: '今日时间轴' },
  { id: 'quadrant', icon: '▦', label: '四象限' },
  { id: 'category', icon: '◈', label: '分类' },
  { id: 'todoList', icon: '✓', label: '待办列表' },
];

export const priorityRank: Record<TodoItem['priority'], number> = { high: 0, normal: 1, low: 2 };
export const quadrantRank: Record<TodoQuadrant, number> = { q1: 0, q2: 1, q3: 2, q4: 3 };

export function getCategoryConfig(categoryId: TodoCategory) {
  return categoryConfig.find((category) => category.id === categoryId) ?? categoryConfig[categoryConfig.length - 1];
}

export function getQuadrantConfig(quadrantId: TodoQuadrant) {
  return quadrantConfig.find((quadrant) => quadrant.id === quadrantId) ?? quadrantConfig[1];
}
