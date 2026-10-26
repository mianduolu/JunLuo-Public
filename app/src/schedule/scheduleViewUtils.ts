import { dateKey, type ScheduleOccurrence } from './scheduleStore';
import type { TodoCategory, TodoItem, TodoQuadrant } from './todoStore';
import { categoryConfig, priorityRank, quadrantConfig, quadrantRank } from './taskMeta';
import type { DisplayRange, ScheduleViewTask } from './scheduleViewTypes';
import type { DayTemplateInstance } from './dayTemplateInstanceStore';
import type { ReadingBook } from '../reading/readingTypes';

export type ScheduleReadingSnapshot = { status: 'loading' } | { status: 'failed' } | { status: 'loaded'; books: ReadingBook[] };

export type ScheduleTaskGestureState = { long: boolean; moved: boolean; cancelled: boolean; dragged: boolean; x: number; y: number };
type TaskTouch = { nativeEvent: { pageX: number; pageY: number } };
export function scheduleTaskGesture(state: ScheduleTaskGestureState, onPress: () => void,
  onDragStart?: (x: number, y: number) => void) {
  return {
    delayLongPress: 260,
    onTouchStart: (event: TaskTouch) => Object.assign(state, { long: false, moved: false, cancelled: false, dragged: false,
      x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }),
    onLongPress: (event: TaskTouch) => {
      if (state.cancelled) return;
      state.long = true; state.x = event.nativeEvent.pageX; state.y = event.nativeEvent.pageY;
    },
    onTouchMove: (event: TaskTouch) => {
      if (!state.long || state.cancelled || state.dragged) return;
      if (Math.hypot(event.nativeEvent.pageX - state.x, event.nativeEvent.pageY - state.y) <= 8) return;
      state.moved = true;
      if (onDragStart) { state.dragged = true; onDragStart(event.nativeEvent.pageX, event.nativeEvent.pageY); }
    },
    onTouchEnd: () => { if (state.long && !state.moved && !state.cancelled) { state.cancelled = true; onPress(); } },
    onTouchCancel: () => { state.cancelled = true; },
    onPress: () => { if (!state.long && !state.cancelled) onPress(); },
  };
}

export function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

export function dateKeysForRange(range: DisplayRange, baseDate = new Date()) {
  if (range === 'all') return [];
  if (range === 'today') return [dateKey(baseDate)];
  if (range === 'tomorrow') return [dateKey(addDays(baseDate, 1))];
  if (range === 'threeDays') return [0, 1, 2].map((offset) => dateKey(addDays(baseDate, offset)));
  const start = new Date(baseDate);
  const end = new Date(baseDate);
  if (range === 'week') {
    const day = start.getDay() || 7;
    start.setDate(start.getDate() - day + 1);
    end.setDate(start.getDate() + 6);
  } else {
    start.setDate(1);
    end.setMonth(start.getMonth() + 1, 0);
  }
  const keys: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    keys.push(dateKey(cursor));
  }
  return keys;
}

export function dateKeysForDisplayRange(range: DisplayRange, baseKey: string) {
  const baseDate = dateFromKey(baseKey);
  if (range !== 'all') return dateKeysForRange(range, baseDate);
  return Array.from({ length: 122 }, (_, index) => dateKey(addDays(baseDate, index - 31)));
}

export function dateFromKey(key: string) {
  return new Date(`${key}T12:00:00`);
}

export function startOfWeek(date: Date) {
  const start = new Date(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

export function weekKeysForDate(key: string) {
  const start = startOfWeek(dateFromKey(key));
  return Array.from({ length: 7 }, (_, index) => dateKey(addDays(start, index)));
}

export function monthKeysForDate(key: string) {
  const base = dateFromKey(key);
  const start = new Date(base.getFullYear(), base.getMonth(), 1, 12);
  const end = new Date(base.getFullYear(), base.getMonth() + 1, 0, 12);
  const keys: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    keys.push(dateKey(cursor));
  }
  return keys;
}

export function monthGridKeys(key: string) {
  const monthKeys = monthKeysForDate(key);
  const first = dateFromKey(monthKeys[0]);
  const leading = (first.getDay() + 6) % 7;
  const cells: Array<{ dayKey: string; inMonth: boolean }> = [];
  for (let index = leading; index > 0; index -= 1) {
    cells.push({ dayKey: dateKey(addDays(first, -index)), inMonth: false });
  }
  monthKeys.forEach((dayKey) => cells.push({ dayKey, inMonth: true }));
  while (cells.length % 7 !== 0) {
    cells.push({ dayKey: dateKey(addDays(dateFromKey(cells[cells.length - 1].dayKey), 1)), inMonth: false });
  }
  return cells;
}

export function buildViewTasks(todos: TodoItem[], scheduleOccurrences: ScheduleOccurrence[], templateInstances: DayTemplateInstance[] = [],
  readingSnapshot?: ScheduleReadingSnapshot, now = Date.now()) {
  const todoTasks: ScheduleViewTask[] = todos.map((todo) => ({
    category: todo.category,
    completed: todo.status === 'completed',
    completedAt: todo.completedAt,
    dateKey: todo.plannedForDate ?? dateKey(new Date()),
    id: `todo-${todo.id}`,
    kind: 'todo',
    priority: todo.priority,
    quadrant: todo.quadrant,
    sourceId: todo.id,
    title: todo.title,
    todo,
  }));
  const scheduleTasks: ScheduleViewTask[] = scheduleOccurrences.map((occurrence) => ({
    category: inferScheduleCategory(occurrence.notes),
    completed: occurrence.status === 'completed',
    dateKey: dateKey(occurrence.scheduledStartAt),
    endAt: occurrence.endAt,
    id: `schedule-${occurrence.id}`,
    kind: 'schedule',
    occurrence,
    executionLabel: scheduleExecutionLabel(occurrence, readingSnapshot, now),
    priority: 'normal',
    quadrant: inferScheduleQuadrant(occurrence.notes),
    sourceId: occurrence.id,
    startAt: occurrence.scheduledStartAt,
    title: occurrence.title,
  }));
  const templateTasks: ScheduleViewTask[] = templateInstances.filter(instance => instance.enabled !== false || instance.status === 'completed').map((instance) => ({
    category: 'life', completed: instance.status === 'completed', completedAt: instance.completedAt, dateKey: instance.startAt === undefined ? instance.dateKey : dateKey(instance.startAt),
    endAt: instance.endAt, id: `template-${instance.id}`, kind: 'template', priority: 'normal', quadrant: 'q4', sourceId: instance.id,
    startAt: instance.startAt, title: instance.title, templateInstance: instance,
  }));
  return [...todoTasks, ...scheduleTasks, ...templateTasks].sort(sortViewTasks);
}

function inferScheduleCategory(notes: string): TodoCategory {
  const match = notes.match(/分类：(.+)/);
  const value = match?.[1]?.trim();
  return categoryConfig.find((category) => category.id === value || category.label === value)?.id ?? 'other';
}

function inferScheduleQuadrant(notes: string): TodoQuadrant {
  const match = notes.match(/象限：(.+)/);
  const value = match?.[1]?.trim();
  return quadrantConfig.find((quadrant) => quadrant.id === value || quadrant.title === value)?.id ?? 'q2';
}

export function sortViewTasks(a: ScheduleViewTask, b: ScheduleViewTask) {
  if (a.completed !== b.completed) return a.completed ? 1 : -1;
  if (quadrantRank[a.quadrant] !== quadrantRank[b.quadrant]) return quadrantRank[a.quadrant] - quadrantRank[b.quadrant];
  if (priorityRank[a.priority] !== priorityRank[b.priority]) return priorityRank[a.priority] - priorityRank[b.priority];
  const aTime = a.startAt ?? Number.MAX_SAFE_INTEGER;
  const bTime = b.startAt ?? Number.MAX_SAFE_INTEGER;
  if (aTime !== bTime) return aTime - bTime;
  return a.title.localeCompare(b.title, 'zh-CN');
}

export function sortTasksByTime(a: ScheduleViewTask, b: ScheduleViewTask) {
  if (a.dateKey !== b.dateKey) return a.dateKey.localeCompare(b.dateKey);
  const aTime = a.startAt ?? a.completedAt ?? Number.MAX_SAFE_INTEGER;
  const bTime = b.startAt ?? b.completedAt ?? Number.MAX_SAFE_INTEGER;
  if (aTime !== bTime) return aTime - bTime;
  return a.title.localeCompare(b.title, 'zh-CN');
}

export function taskTimeLabel(task: ScheduleViewTask) {
  if (!task.startAt) return task.kind === 'todo' ? '待办' : '无时间';
  const original = task.occurrence?.execution?.resumeUnscheduled;
  return `${original ? '原计划 ' : ''}${task.endAt ? `${formatTime(task.startAt)}-${formatTime(task.endAt)}` : formatTime(task.startAt)}`;
}

export function scheduleOwnerAppearance(owner: ScheduleOccurrence['owner'] = 'you') {
  if (owner === 'I') return { label: '白云', color: '#417FB8', background: '#EDF5FC' };
  if (owner === 'I 和 you') return { label: '白云与小仓鼠', color: '#657B96', background: '#F0F3F8' };
  return { label: '小仓鼠', color: '#C97838', background: '#FFF4E9' };
}

function scheduleMaterialLabel(occurrence: ScheduleOccurrence, snapshot?: ScheduleReadingSnapshot) {
  if (!occurrence.readingId) return '仅有计划 · 无执行记录';
  if (!snapshot || snapshot.status === 'loading') return '材料状态读取中';
  if (snapshot.status === 'failed') return '材料状态读取失败';
  const book = snapshot.books.find(item => item.id === occurrence.readingId);
  if (!book) return '关联来源已移除';
  if (book.programme?.preparation === 'failed') return '材料准备失败';
  if (book.programme?.preparation === 'preparing') return '材料准备中';
  if (book.programme?.preparation === 'missing') return '材料未准备';
  return '材料已就绪';
}

export function scheduleExecutionLabel(occurrence: ScheduleOccurrence, snapshot?: ScheduleReadingSnapshot, now = Date.now()) {
  if (occurrence.status === 'cancelled') return '已取消';
  const execution = occurrence.execution;
  if (execution?.status === 'completed') return '已完成';
  if (execution?.status === 'running') return '进行中';
  if (execution?.status === 'paused') return '已暂停';
  if (execution?.status === 'ended') return '已结束 · 未完成';
  if (occurrence.status === 'completed') return '已标记完成';
  if (occurrence.owner !== 'I') return '尚未开始';
  if (occurrence.scheduledStartAt > now) return '未到时间';
  const material = scheduleMaterialLabel(occurrence, snapshot);
  if (material !== '材料已就绪') return material;
  return occurrence.endAt !== undefined && occurrence.endAt <= now ? '已过计划时间 · 未开始' : '尚未开始';
}

export function scheduleExecutionDetails(occurrence: ScheduleOccurrence, snapshot?: ScheduleReadingSnapshot, now = Date.now()) {
  const stamp = (time: number) => `${dateKey(time)} ${formatTime(time)}`;
  const execution = occurrence.execution;
  const remaining = execution?.totalPlannedMs !== undefined
    ? Math.max(0, execution.totalPlannedMs - (execution.elapsedMs ?? 0)) : undefined;
  const active = execution?.status === 'running' || execution?.status === 'paused';
  const book = snapshot?.status === 'loaded' ? snapshot.books.find(item => item.id === occurrence.readingId) : undefined;
  return [
    `${scheduleOwnerAppearance(occurrence.owner).label} · ${scheduleExecutionLabel(occurrence, snapshot, now)}`,
    `${execution?.resumeUnscheduled ? '原计划' : '计划'}：${stamp(occurrence.scheduledStartAt)}${occurrence.endAt ? ` — ${stamp(occurrence.endAt)}` : ''}`,
    ...(execution?.startedAt !== undefined ? [`实际开始：${stamp(execution.startedAt)}`] : []),
    ...(execution?.endedAt !== undefined ? [`实际结束：${stamp(execution.endedAt)}`] : []),
    ...(execution?.elapsedMs !== undefined ? [`有效活动：${Math.floor(execution.elapsedMs / 60_000)} 分钟`] : []),
    ...(active && remaining !== undefined ? [`剩余：${Number((remaining / 60_000).toFixed(2))} 分钟`,
      execution.status === 'paused' ? '预计结束：待继续后确定'
        : `预计结束：${stamp(execution.estimatedEndAt ?? execution.updatedAt + remaining)}`] : []),
    ...(execution?.completedUnitCount !== undefined ? [`有效成果：${execution.completedUnitCount} 段`] : []),
    ...(occurrence.readingId ? [`关联材料：${scheduleMaterialLabel(occurrence, snapshot)}`,
      ...(book?.programme?.preparation === 'failed' && book.programme.errorCode ? [`准备错误：${book.programme.errorCode}`] : [])] : []),
  ].join('\n');
}

export function scheduleCalendarMarks(occurrences: ScheduleOccurrence[]) {
  const owners = new Map<string, Set<NonNullable<ScheduleOccurrence['owner']>>>();
  for (const occurrence of occurrences) {
    if (occurrence.status === 'cancelled') continue;
    const day = dateKey(occurrence.scheduledStartAt);
    const dayOwners = owners.get(day) ?? new Set();
    dayOwners.add(occurrence.owner ?? 'you');
    owners.set(day, dayOwners);
  }
  return Object.fromEntries([...owners].map(([day, values]) => [day, {
    dots: [...values].map(owner => ({ key: owner, color: scheduleOwnerAppearance(owner).color })),
  }]));
}

export function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatExecutionMinutes(seconds: number) {
  const minutes = Math.max(0, Math.floor(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${rest}m` : `${hours}h`;
}

export function executionProgressPercent(todo: TodoItem, elapsedSeconds: number) {
  if (!todo.estimatedMinutes) return 0;
  return Math.min(100, Math.round((elapsedSeconds / 60 / todo.estimatedMinutes) * 100));
}
