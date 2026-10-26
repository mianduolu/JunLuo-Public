import type { ScheduleOccurrence } from './scheduleStore';
import type { DayTemplateInstance } from './dayTemplateInstanceStore';
import type { TodoCategory, TodoItem, TodoQuadrant } from './todoStore';

export type DisplayRange = 'all' | 'today' | 'tomorrow' | 'threeDays' | 'week' | 'month';
export type ViewMode = 'day' | 'week' | 'month';
export type DayDisplayMode = 'dayView' | 'scheduleList' | 'quadrant' | 'category' | 'todoList';

export type ScheduleViewTask = {
  category: TodoCategory;
  completed: boolean;
  completedAt?: number;
  dateKey: string;
  endAt?: number;
  id: string;
  kind: 'todo' | 'schedule' | 'template';
  occurrence?: ScheduleOccurrence;
  executionLabel?: string;
  priority: TodoItem['priority'];
  quadrant: TodoQuadrant;
  sourceId: string;
  startAt?: number;
  title: string;
  todo?: TodoItem;
  templateInstance?: DayTemplateInstance;
};
