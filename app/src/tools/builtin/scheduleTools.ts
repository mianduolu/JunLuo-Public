import { createToolSuccessResult } from '../toolResult';
import { scheduleSubmitDayPlanTool } from './dayPlanTool';
import { CHAT_SCHEDULE_COMPLETE_DESCRIPTION } from '../../schedule/chatSchedulePrompts';
import { ownScheduleWriteTool, ownHabitWriteTool } from './ownScheduleTools';
import { userRoutineQueryTool, userRoutineSaveTool } from './userRoutineTools';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import {
  isOneOf,
  isValidTimestamp,
  readBooleanInput,
  readNumberInput,
  readOptionalStringInput,
  readStringInput,
  validationFailed,
} from './builtinToolValidation';
import type {
  ScheduleOccurrenceStatus,
  ScheduleRecurrence,
  ScheduleReminderIntensity,
} from '../../schedule/scheduleStore';
import type {
  TodoCategory,
  TodoPriority,
  TodoQuadrant,
  TodoStatus,
} from '../../schedule/todoStore';

type ScheduleCreateEventData = {
  endAt?: number;
  id: string;
  recurrence: ScheduleRecurrence;
  startAt: number;
  title: string;
};

type ScheduleCompleteOccurrenceData = {
  changed: boolean;
  occurrenceId: string;
  status: 'completed';
  title: string;
};

type ScheduleAgendaData = {
  endDate: string;
  inboxTodos: Array<{
    category: TodoCategory;
    id: string;
    notes: string;
    priority: TodoPriority;
    quadrant: TodoQuadrant;
    status: TodoStatus;
    title: string;
  }>;
  scheduleItems: Array<{
    owner?: string;
    updatedAt?: number;
    readingId?: string | null;
    habitId?: string;
    endAt?: number;
    itemId: string;
    notes: string;
    occurrenceId: string;
    recurrence: ScheduleRecurrence;
    startAt: number;
    status: ScheduleOccurrenceStatus;
    title: string;
    todoId?: string;
  }>;
  scheduledTodos: Array<{
    category: TodoCategory;
    id: string;
    notes: string;
    plannedForDate?: string;
    priority: TodoPriority;
    quadrant: TodoQuadrant;
    status: TodoStatus;
    title: string;
  }>;
  startDate: string;
};

const SCHEDULE_RECURRENCES = ['none', 'daily', 'weekdays', 'legalWorkday', 'weekly', 'monthly', 'yearly', 'lunarYearly'] as const satisfies readonly ScheduleRecurrence[];
const SCHEDULE_REMINDER_INTENSITIES = ['gentle', 'strong', 'blast'] as const satisfies readonly ScheduleReminderIntensity[];

function parseDateKey(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  if (
    year < 1
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return undefined;
  return date;
}

async function executeScheduleQueryAgenda(call: JunLuoToolCall): Promise<JunLuoToolResult<ScheduleAgendaData>> {
  const startDate = readStringInput(call.input, 'startDate');
  const parsedStartDate = parseDateKey(startDate);
  if (!parsedStartDate) return validationFailed(call, '缺少有效的开始日期', '没有读取安排');

  const endDate = readOptionalStringInput(call.input, 'endDate') || startDate;
  const parsedEndDate = parseDateKey(endDate);
  if (!parsedEndDate) return validationFailed(call, '结束日期格式无效', '没有读取安排');
  if (parsedEndDate.getTime() < parsedStartDate.getTime()) {
    return validationFailed(call, '结束日期不能早于开始日期', '没有读取安排');
  }

  const startAt = new Date(
    parsedStartDate.getFullYear(),
    parsedStartDate.getMonth(),
    parsedStartDate.getDate(),
  ).getTime();
  const endExclusive = new Date(
    parsedEndDate.getFullYear(),
    parsedEndDate.getMonth(),
    parsedEndDate.getDate() + 1,
  ).getTime();
  const includeInbox = readBooleanInput(call.input, 'includeInbox') ?? false;
  const [{ loadPendingScheduleOccurrencesBetween, loadScheduleItemById }, { loadInboxTodoItems, loadTodoItemsBetweenDates }] = await Promise.all([
    import('../../schedule/scheduleStore'),
    import('../../schedule/todoStore'),
  ]);
  const [occurrences, scheduledTodos, inboxTodos] = await Promise.all([
    loadPendingScheduleOccurrencesBetween(startAt, endExclusive),
    loadTodoItemsBetweenDates(startDate, endDate),
    includeInbox ? loadInboxTodoItems() : Promise.resolve([]),
  ]);
  const rangeLabel = startDate === endDate ? startDate : `${startDate} 至 ${endDate}`;
  const originals = new Map((await Promise.all([...new Set(occurrences.map(item => item.itemId))].map(loadScheduleItemById)))
    .filter(item => item !== null).map(item => [item!.id, item!]));
  const { loadHabitById } = await import('../../schedule/habitStore');
  const habits = new Map((await Promise.all([...new Set([...occurrences, ...scheduledTodos, ...inboxTodos]
    .flatMap(item => item.habitId ? [item.habitId] : []))].map(loadHabitById)))
    .filter(item => item !== null).map(item => [item!.id, item!]));
  const habitDetails = (habitId?: string) => {
    const habit = habitId ? habits.get(habitId) : undefined;
    return habit ? { habitId: habit!.id, habitUpdatedAt: habit!.updatedAt,
      repeat: { frequency: habit!.frequency, weekDays: habit!.weekDays, intervalDays: habit!.intervalDays } } : {};
  };

  return createToolSuccessResult<ScheduleAgendaData>(
    call,
    `已读取 ${rangeLabel}：${occurrences.length} 条日程，${scheduledTodos.length} 条已安排待办${includeInbox ? `，${inboxTodos.length} 条待办池事项` : ''}`,
    {
      startDate,
      endDate,
      scheduleItems: occurrences.map((item) => ({
        occurrenceId: item.id,
        itemId: item.itemId,
        owner: originals.get(item.itemId)?.owner ?? 'you',
        updatedAt: originals.get(item.itemId)?.updatedAt,
        ...(item.readingId ? { readingId: item.readingId } : {}),
        ...(item.habitId ? { habitId: item.habitId } : {}), ...habitDetails(item.habitId),
        durationMinutes: item.durationMinutes, endMode: item.endMode,
        startReminderEnabled: item.startReminderEnabled, companionEnabled: item.companionEnabled,
        title: item.title,
        notes: item.notes,
        startAt: item.scheduledStartAt,
        endAt: item.endAt,
        status: item.status,
        recurrence: item.recurrence,
        todoId: item.todoId,
      })),
      scheduledTodos: scheduledTodos.map((item) => ({
        id: item.id,
        updatedAt: item.updatedAt, parentTodoId: item.parentTodoId, parentOccurrenceId: item.parentOccurrenceId, stepOrder: item.stepOrder,
        ...habitDetails(item.habitId),
        title: item.title,
        notes: item.notes,
        plannedForDate: item.plannedForDate,
        status: item.status,
        priority: item.priority,
        quadrant: item.quadrant,
        category: item.category,
      })),
      inboxTodos: inboxTodos.map((item) => ({
        id: item.id,
        updatedAt: item.updatedAt, parentTodoId: item.parentTodoId, parentOccurrenceId: item.parentOccurrenceId, stepOrder: item.stepOrder,
        ...habitDetails(item.habitId),
        title: item.title,
        notes: item.notes,
        status: item.status,
        priority: item.priority,
        quadrant: item.quadrant,
        category: item.category,
      })),
    },
  );
}

async function executeScheduleCreateEvent(call: JunLuoToolCall): Promise<JunLuoToolResult<ScheduleCreateEventData>> {
  const title = readStringInput(call.input, 'title');
  if (!title) return validationFailed(call, '缺少日程标题', '没有创建日程');

  const startAt = call.input.startAt;
  if (!isValidTimestamp(startAt)) return validationFailed(call, '缺少有效的日程开始时间', '没有创建日程');

  const endAt = call.input.endAt;
  if (endAt !== undefined && !isValidTimestamp(endAt)) {
    return validationFailed(call, '日程结束时间不是有效时间戳', '没有创建日程');
  }
  if (typeof endAt === 'number' && endAt <= startAt) {
    return validationFailed(call, '日程结束时间必须晚于开始时间', '没有创建日程');
  }
  const validEndAt = typeof endAt === 'number' ? endAt : undefined;

  const recurrence = isOneOf(call.input.recurrence, SCHEDULE_RECURRENCES) ? call.input.recurrence : 'none';
  const reminderIntensity = isOneOf(call.input.reminderIntensity, SCHEDULE_REMINDER_INTENSITIES)
    ? call.input.reminderIntensity
    : 'gentle';
  const reminderMinutesBefore = readNumberInput(call.input, 'reminderMinutesBefore') ?? 10;
  if (reminderMinutesBefore < 0) {
    return validationFailed(call, '提醒提前分钟数不能小于 0', '没有创建日程');
  }

  const { createScheduleItem } = await import('../../schedule/scheduleStore');
  const item = await createScheduleItem({
    title,
    notes: readOptionalStringInput(call.input, 'notes') ?? '',
    startAt,
    endAt: validEndAt,
    reminderMinutesBefore: Math.round(reminderMinutesBefore),
    recurrence,
    reminderText: readOptionalStringInput(call.input, 'reminderText') ?? title,
    reminderIntensity,
    source: 'ai',
    companionEnabled: readBooleanInput(call.input, 'companionEnabled') ?? false,
  });

  const { requestNotificationPermission, syncScheduleNotifications } = await import('../../schedule/scheduleNotifications');
  await (async () => {
    if (await requestNotificationPermission()) await syncScheduleNotifications();
  })().catch(() => undefined);

  return createToolSuccessResult<ScheduleCreateEventData>(call, `已创建日程：${item.title}`, {
    endAt: item.endAt,
    id: item.id,
    recurrence: item.recurrence,
    startAt: item.startAt,
    title: item.title,
  });
}

async function executeScheduleCompleteOccurrence(
  call: JunLuoToolCall,
  context?: import('../toolTypes').JunLuoToolExecutorContext,
): Promise<JunLuoToolResult<ScheduleCompleteOccurrenceData>> {
  if (call.requestedBy === 'chat') return context?.chatSchedule ? context.chatSchedule(call) as Promise<JunLuoToolResult<ScheduleCompleteOccurrenceData>> : validationFailed(call, 'schedule-turn-unavailable', '');
  const occurrenceId = readStringInput(call.input, 'occurrenceId');
  if (!occurrenceId) return validationFailed(call, '缺少日程发生项编号', '没有完成日程');

  const title = readStringInput(call.input, 'title');
  if (!title) return validationFailed(call, '缺少日程标题', '没有完成日程');

  const { loadScheduleOccurrence } = await import('../../schedule/scheduleStore');
  const occurrence = await loadScheduleOccurrence(occurrenceId);
  if (!occurrence) return validationFailed(call, '没有找到这条日程', '没有完成日程');
  if (occurrence.title !== title) {
    return validationFailed(call, '日程编号和标题不对应', '没有完成日程');
  }
  if (occurrence.status === 'cancelled') {
    return validationFailed(call, '这条日程已经取消', '没有完成日程');
  }

  const { completeScheduleOccurrenceOnce } = await import('../../schedule/scheduleCompletionOnce');
  const completion = await completeScheduleOccurrenceOnce(occurrenceId);
  if (completion.notificationIds.length > 0) {
    const { cancelNotifications } = await import('../../schedule/scheduleNotifications');
    await cancelNotifications(completion.notificationIds);
  }
  const completed = await loadScheduleOccurrence(occurrenceId);
  if (completed?.status !== 'completed') {
    return validationFailed(call, '日程没有变为完成状态', '没有完成日程');
  }

  return createToolSuccessResult<ScheduleCompleteOccurrenceData>(
    call,
    `已完成日程：${completed.title}`,
    {
      changed: completion.changed,
      occurrenceId: completed.id,
      status: 'completed',
      title: completed.title,
    },
  );
}

export const scheduleCreateEventTool: JunLuoToolDefinition<Record<string, unknown>, ScheduleCreateEventData> = {
  id: 'schedule.create_event',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'schedule',
  name: '创建 you 的日程',
  description: '为 you 创建日程。',
  inputSchema: {
    type: 'object',
    required: ['title', 'startAt'],
    properties: {
      title: { type: 'string', description: '日程标题' },
      startAt: { type: 'number', description: '开始时间，毫秒时间戳' },
      endAt: { type: 'number', description: '结束时间，毫秒时间戳' },
      notes: { type: 'string', description: '日程备注' },
      reminderMinutesBefore: { type: 'number', description: '提前提醒分钟数' },
      recurrence: { type: 'string', enum: [...SCHEDULE_RECURRENCES], description: '重复规则' },
      reminderText: { type: 'string', description: '提醒文案' },
      reminderIntensity: { type: 'string', enum: [...SCHEDULE_REMINDER_INTENSITIES], description: '提醒强度' },
    },
  },
  permission: 'ask',
  riskLevel: 'write_local',
  readOnly: false,
  executionScope: 'local_device',
  agentEpochMode: 'bounded_local_commits',
  executor: executeScheduleCreateEvent,
};

export const scheduleQueryAgendaTool: JunLuoToolDefinition<Record<string, unknown>, ScheduleAgendaData> = {
  id: 'schedule.query_agenda',
  chatExposure: 'candidate',
  proactiveEligible: false,
  packageId: 'schedule',
  name: '查看日程待办安排',
  description: '读取指定日期范围内的真实日程与已安排待办，也可按需包含待办池。',
  inputSchema: {
    type: 'object',
    required: ['startDate'],
    properties: {
      startDate: { type: 'string', description: '开始日期，格式为 YYYY-MM-DD' },
      endDate: { type: 'string', description: '结束日期，格式为 YYYY-MM-DD；不填时只查开始日期' },
      includeInbox: { type: 'boolean', description: '是否同时读取没有安排日期的待办，默认否' },
    },
  },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeScheduleQueryAgenda,
};

export const scheduleCompleteOccurrenceTool: JunLuoToolDefinition<Record<string, unknown>, ScheduleCompleteOccurrenceData> = {
  id: 'schedule.complete_occurrence',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'schedule',
  name: '完成日程',
  description: CHAT_SCHEDULE_COMPLETE_DESCRIPTION,
  inputSchema: {
    type: 'object',
    required: ['occurrenceId', 'title'],
    properties: {
      occurrenceId: { type: 'string', description: '日程发生项编号' },
      title: { type: 'string', description: '日程标题' },
      completedAt: { type: 'number' },
    },
  },
  permission: 'ask',
  riskLevel: 'write_local',
  readOnly: false,
  executionScope: 'local_device',
  agentEpochMode: 'bounded_local_commits',
  executor: executeScheduleCompleteOccurrence,
};

export const scheduleToolPackage: JunLuoToolPackage = {
  id: 'schedule',
  name: '日程',
  description: '创建和管理君落本地日程事件。',
  category: 'local_write',
  tools: [scheduleCreateEventTool, scheduleQueryAgendaTool, scheduleCompleteOccurrenceTool, scheduleSubmitDayPlanTool, ownScheduleWriteTool, ownHabitWriteTool, userRoutineQueryTool, userRoutineSaveTool],
  defaultEnabled: true,
  riskLevel: 'write_local',
  source: 'builtin',
};
