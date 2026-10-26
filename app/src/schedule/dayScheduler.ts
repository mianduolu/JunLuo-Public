import type { DayTemplate } from './dayTemplate';
import type { TodoType } from './todoTypeLogic';

type TodoQuadrant = 'q1' | 'q2' | 'q3' | 'q4';
type TodoCategory = 'study' | 'work' | 'health' | 'life' | 'social' | 'leisure' | 'creation' | 'other';

export type ExtractedTask = {
  id: string;
  title: string;
  userEstimatedMinutes?: number;
  requestedSegments?: number;
  type?: TodoType;
};

export type ClassifiedTask = ExtractedTask & {
  category: TodoCategory;
  quadrant: TodoQuadrant;
  estimatedMinutes?: number;
};

export type ScheduleConstraint = {
  taskId: string;
  fixedStartTime?: string;
  preferredPeriod?: 'morning' | 'afternoon' | 'evening';
};

export type OccupiedInterval = {
  startAt: number;
  endAt: number;
  title?: string;
};

export type ScheduleSlot = {
  taskId: string;
  title: string;
  displayTitle: string;
  category: TodoCategory;
  quadrant: TodoQuadrant;
  estimatedMinutes: number;
  startAt: number;
  endAt: number;
  segmentIndex: number;
  segmentCount: number;
};

export type UnscheduledTask = {
  task: ClassifiedTask;
  reason: 'missing-estimate' | 'no-space';
};

export type FloatingCommitment = {
  id: string;
  title: string;
  category: TodoCategory;
  quadrant: TodoQuadrant;
  estimatedMinutes: number;
  source: 'daily-challenge';
  sourceId: string;
  streak: number;
  completed: boolean;
};

export type ScheduledPlan = {
  dateKey: string;
  slots: ScheduleSlot[];
  unscheduled: UnscheduledTask[];
  floatingCommitments: FloatingCommitment[];
};

export type ScheduleAdjustmentOperation =
  | { kind: 'move'; taskId: string; fixedStartTime?: string; preferredPeriod?: ScheduleConstraint['preferredPeriod'] }
  | { kind: 'duration'; taskId: string; estimatedMinutes: number }
  | { kind: 'segments'; taskId: string; requestedSegments: number }
  | { kind: 'remove'; taskId: string }
  | { kind: 'add'; title: string; estimatedMinutes?: number };

export type ScheduleMemoryReference = {
  id: string;
  title: string;
  summary: string;
  domain: '相处' | '称呼' | '喜好' | '边界' | '经历' | '约定' | '日常' | '其他';
  importance: number;
  valence: number;
};

export type PendingSchedulePlan = {
  dayPlan?: import('./dayPlan').DayPlan;
  id: string;
  originalText: string;
  dateKey: string;
  tasks: ClassifiedTask[];
  constraints: ScheduleConstraint[];
  scheduled: ScheduledPlan;
  reviewSuggestions: string[];
  memoryReferences: ScheduleMemoryReference[];
  inhibitTasks: ClassifiedTask[];
};

export type ScheduleDayInput = {
  dateKey: string;
  tasks: ClassifiedTask[];
  occupied: OccupiedInterval[];
  template: DayTemplate;
  routine?: Array<{ kind: string; startAt?: number; endAt?: number; enabled: boolean }>;
  constraints?: ScheduleConstraint[];
  floatingCommitments?: FloatingCommitment[];
};

type MinuteInterval = { start: number; end: number };
const QUADRANT_ORDER: Record<TodoQuadrant, number> = { q1: 0, q2: 1, q3: 2, q4: 3 };
const FOCUS_CATEGORIES = new Set<TodoCategory>(['study', 'work', 'creation']);

function clockMinutes(clock: string) {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours * 60 + minutes;
}

function startOfDate(dateKey: string) {
  return new Date(`${dateKey}T00:00:00`).getTime();
}

function absoluteMinute(base: number, timestamp: number) {
  return Math.round((timestamp - base) / 60000);
}

function normalizeAcrossWake(minute: number, wakeMinute: number) {
  return minute < wakeMinute ? minute + 1440 : minute;
}

function mergeIntervals(intervals: MinuteInterval[]) {
  const sorted = intervals
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start);
  const merged: MinuteInterval[] = [];
  sorted.forEach((interval) => {
    const previous = merged[merged.length - 1];
    if (!previous || interval.start > previous.end) merged.push({ ...interval });
    else previous.end = Math.max(previous.end, interval.end);
  });
  return merged;
}

function blockedByTemplate(template: DayTemplate, wakeMinute: number): MinuteInterval[] {
  if (!template.enabled) return [];
  const meals = [template.breakfast, template.lunch, template.dinner]
    .filter((meal) => meal.enabled && meal.startTime && meal.durationMinutes)
    .map((meal) => {
      const start = normalizeAcrossWake(clockMinutes(meal.startTime), wakeMinute);
      return { start, end: start + meal.durationMinutes! };
    });
  if (!template.nap.enabled || !template.nap.startTime || !template.nap.endTime) return meals;
  const napStart = normalizeAcrossWake(clockMinutes(template.nap.startTime), wakeMinute);
  let napEnd = normalizeAcrossWake(clockMinutes(template.nap.endTime), wakeMinute);
  if (napEnd <= napStart) napEnd += 1440;
  return [...meals, { start: napStart, end: napEnd }];
}

function orderTasks(tasks: ClassifiedTask[]) {
  const ordered: ClassifiedTask[] = [];
  (['q1', 'q2', 'q3', 'q4'] as TodoQuadrant[]).forEach((quadrant) => {
    const remaining = tasks
      .filter((task) => task.quadrant === quadrant)
      .sort((a, b) => (b.estimatedMinutes ?? 0) - (a.estimatedMinutes ?? 0));
    while (remaining.length) {
      const previousCategory = ordered[ordered.length - 1]?.quadrant === quadrant ? ordered[ordered.length - 1]?.category : undefined;
      const nextIndex = previousCategory ? remaining.findIndex((task) => task.category !== previousCategory) : 0;
      ordered.push(remaining.splice(nextIndex >= 0 ? nextIndex : 0, 1)[0]);
    }
  });
  return ordered;
}

function periodBounds(period: ScheduleConstraint['preferredPeriod'], dayStart: number, dayEnd: number) {
  if (period === 'morning') return { start: Math.max(dayStart, 6 * 60), end: Math.min(dayEnd, 12 * 60) };
  if (period === 'afternoon') return { start: Math.max(dayStart, 12 * 60), end: Math.min(dayEnd, 18 * 60) };
  if (period === 'evening') return { start: Math.max(dayStart, 18 * 60), end: dayEnd };
  return { start: dayStart, end: dayEnd };
}

function findStart(blocked: MinuteInterval[], duration: number, range: MinuteInterval, exact?: number) {
  if (exact !== undefined) {
    if (exact < range.start || exact + duration > range.end) return undefined;
    return blocked.some((item) => exact < item.end && exact + duration > item.start) ? undefined : exact;
  }
  let cursor = range.start;
  for (const item of blocked) {
    if (item.end <= cursor) continue;
    if (item.start >= range.end) break;
    if (cursor + duration <= item.start) return cursor;
    cursor = Math.max(cursor, item.end);
    if (cursor + duration > range.end) return undefined;
  }
  return cursor + duration <= range.end ? cursor : undefined;
}

function intervalMinutesWithin(intervals: MinuteInterval[], start: number, end: number) {
  return mergeIntervals(intervals.map((interval) => ({
    start: Math.max(start, interval.start),
    end: Math.min(end, interval.end),
  }))).reduce((total, interval) => total + Math.max(0, interval.end - interval.start), 0);
}

function splitTaskMinutes(totalMinutes: number, requestedSegments?: number) {
  const segmentCount = requestedSegments && Number.isFinite(requestedSegments)
    ? Math.max(1, Math.min(12, Math.round(requestedSegments)))
    : Math.ceil(totalMinutes / 120);
  const baseDuration = Math.floor(totalMinutes / segmentCount);
  const remainder = totalMinutes % segmentCount;
  return Array.from({ length: segmentCount }, (_, index) => baseDuration + (index < remainder ? 1 : 0))
    .filter((duration) => duration > 0);
}

export function scheduleDay({ dateKey, tasks, occupied, template, routine, constraints = [], floatingCommitments = [] }: ScheduleDayInput): ScheduledPlan {
  const base = startOfDate(dateKey);
  const effective = routine?.filter(item => item.enabled && item.startAt !== undefined) ?? [];
  const wake = effective.find(item => item.kind === 'wake' && item.startAt! >= base && item.startAt! < base + 1440 * 60000);
  const sleep = effective.find(item => item.kind === 'sleep' && item.startAt! >= (wake?.startAt ?? base));
  const knownWake = routine ? wake?.startAt !== undefined : template.enabled && (template.wakeEnabled ?? true) && !!template.wakeTime;
  const knownSleep = routine ? sleep?.startAt !== undefined : template.enabled && (template.sleepEnabled ?? true) && !!template.sleepTime;
  const wakeMinute = routine ? wake ? absoluteMinute(base, wake.startAt!) : 0 : knownWake ? clockMinutes(template.wakeTime) : 0;
  let sleepMinute = routine ? sleep ? absoluteMinute(base, sleep.startAt!) : 1440 : knownSleep ? clockMinutes(template.sleepTime) : 1440;
  if (sleepMinute <= wakeMinute) sleepMinute += 1440;
  const dayStart = wakeMinute + (knownWake ? 30 : 0);
  const dayEnd = sleepMinute - (knownSleep ? 30 : 0);
  const occupiedMinutes = occupied.map((item) => ({
    start: absoluteMinute(base, item.startAt),
    end: absoluteMinute(base, item.endAt),
  }));
  const routineBlocks = routine ? effective.filter(item => item.endAt !== undefined && item.startAt !== undefined)
    .map(item => ({ start: absoluteMinute(base, item.startAt!), end: absoluteMinute(base, item.endAt!) })) : blockedByTemplate(template, wakeMinute);
  let blocked = mergeIntervals([...routineBlocks, ...occupiedMinutes]);
  const availableMinutes = Math.max(0, dayEnd - dayStart - intervalMinutesWithin(blocked, dayStart, dayEnd));
  const reservedMinutes = floatingCommitments.reduce(
    (total, item) => total + (item.completed ? 0 : Math.max(0, item.estimatedMinutes)),
    0,
  );
  let remainingTaskCapacity = Math.max(0, availableMinutes - reservedMinutes);
  const constraintByTask = new Map(constraints.map((constraint) => [constraint.taskId, constraint]));
  const slots: ScheduleSlot[] = [];
  const unscheduled: UnscheduledTask[] = [];

  orderTasks(tasks).forEach((task) => {
    if (!task.estimatedMinutes) {
      unscheduled.push({ task, reason: 'missing-estimate' });
      return;
    }
    const taskMinutes = task.estimatedMinutes;
    if (taskMinutes > remainingTaskCapacity) {
      unscheduled.push({ task, reason: 'no-space' });
      return;
    }
    const segmentDurations = splitTaskMinutes(taskMinutes, task.requestedSegments);
    const segmentCount = segmentDurations.length;
    const constraint = constraintByTask.get(task.id);
    const taskSlots: ScheduleSlot[] = [];
    const blockedBeforeTask = blocked;
    let failed = false;
    segmentDurations.forEach((duration, index) => {
      if (failed) return;
      const bounds = periodBounds(constraint?.preferredPeriod, dayStart, dayEnd);
      const exact = index === 0 && constraint?.fixedStartTime
        ? normalizeAcrossWake(clockMinutes(constraint.fixedStartTime), wakeMinute)
        : undefined;
      const start = findStart(blocked, duration, bounds, exact);
      if (start === undefined) {
        failed = true;
        return;
      }
      const end = start + duration;
      taskSlots.push({
        taskId: task.id,
        title: task.title,
        displayTitle: segmentCount > 1 ? `${task.title}（${index + 1}/${segmentCount}）` : task.title,
        category: task.category,
        quadrant: task.quadrant,
        estimatedMinutes: duration,
        startAt: base + start * 60000,
        endAt: base + end * 60000,
        segmentIndex: index + 1,
        segmentCount,
      });
      const breakMinutes = template.enabled && template.autoBreaks
        ? (FOCUS_CATEGORIES.has(task.category) ? template.focusBreakMinutes : template.physicalBreakMinutes)
        : 0;
      blocked = mergeIntervals([...blocked, { start, end: end + breakMinutes }]);
    });
    if (failed) {
      blocked = blockedBeforeTask;
      unscheduled.push({ task, reason: 'no-space' });
    } else {
      slots.push(...taskSlots);
      remainingTaskCapacity = Math.max(0, remainingTaskCapacity - taskMinutes);
    }
  });

  return {
    dateKey,
    slots: slots.sort((a, b) => a.startAt - b.startAt),
    unscheduled,
    floatingCommitments,
  };
}
