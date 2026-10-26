import { createToolSuccessResult } from '../toolResult';
import { CHAT_SCHEDULE_COMPLETE_DESCRIPTION } from '../../schedule/chatSchedulePrompts';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import {
  isOneOf,
  readNumberInput,
  readOptionalStringInput,
  readStringInput,
  validationFailed,
} from './builtinToolValidation';
import type { TodoCategory, TodoPriority, TodoQuadrant, TodoReminderMode } from '../../schedule/todoStore';

type TodoCreateData = {
  id: string;
  plannedForDate?: string;
  status: string;
  title: string;
};

type TodoCompleteData = {
  id: string;
  status: 'completed';
  title: string;
};

const TODO_PRIORITIES = ['low', 'normal', 'high'] as const satisfies readonly TodoPriority[];
const TODO_QUADRANTS = ['q1', 'q2', 'q3', 'q4'] as const satisfies readonly TodoQuadrant[];
const TODO_CATEGORIES = ['study', 'work', 'health', 'life', 'social', 'leisure', 'creation', 'other'] as const satisfies readonly TodoCategory[];
const TODO_REMINDER_MODES = ['none', 'gentle', 'followup'] as const satisfies readonly TodoReminderMode[];

async function executeTodoCreate(call: JunLuoToolCall): Promise<JunLuoToolResult<TodoCreateData>> {
  const title = readStringInput(call.input, 'title');
  if (!title) return validationFailed(call, '缺少待办标题', '没有创建待办');

  const priority = isOneOf(call.input.priority, TODO_PRIORITIES) ? call.input.priority : 'normal';
  const quadrant = isOneOf(call.input.quadrant, TODO_QUADRANTS) ? call.input.quadrant : undefined;
  const category = isOneOf(call.input.category, TODO_CATEGORIES) ? call.input.category : undefined;
  const reminderMode = isOneOf(call.input.reminderMode, TODO_REMINDER_MODES) ? call.input.reminderMode : 'followup';
  const estimatedMinutes = readNumberInput(call.input, 'estimatedMinutes');
  const { createTodoItem } = await import('../../schedule/todoStore');
  const item = await createTodoItem({
    title,
    notes: readOptionalStringInput(call.input, 'notes') ?? '',
    plannedForDate: readOptionalStringInput(call.input, 'plannedForDate'),
    source: 'ai',
    priority,
    quadrant,
    category,
    estimatedMinutes,
    reminderMode,
  });

  return createToolSuccessResult<TodoCreateData>(call, `已创建待办：${item.title}`, {
    id: item.id,
    plannedForDate: item.plannedForDate,
    status: item.status,
    title: item.title,
  });
}

async function executeTodoComplete(call: JunLuoToolCall, context?: import('../toolTypes').JunLuoToolExecutorContext): Promise<JunLuoToolResult<TodoCompleteData>> {
  if (call.requestedBy === 'chat') return context?.chatSchedule ? context.chatSchedule(call) as Promise<JunLuoToolResult<TodoCompleteData>> : validationFailed(call, 'schedule-turn-unavailable', '');
  const todoId = readStringInput(call.input, 'todoId');
  if (!todoId) return validationFailed(call, '缺少待办编号', '没有完成待办');

  const title = readStringInput(call.input, 'title');
  if (!title) return validationFailed(call, '缺少待办标题', '没有完成待办');

  const { loadTodoItemById } = await import('../../schedule/todoStore');
  const todo = await loadTodoItemById(todoId);
  if (!todo) return validationFailed(call, '没有找到这条待办', '没有完成待办');
  if (todo.title !== title) {
    return validationFailed(call, '待办编号和标题不对应', '没有完成待办');
  }
  if (todo.status === 'cancelled' || todo.status === 'expired') {
    return validationFailed(call, '这条待办不能标记为完成', '没有完成待办');
  }

  const { completeTodoItemOnce } = await import('../../schedule/todoCompletionOnce');
  const completed = await completeTodoItemOnce(todoId);
  if (completed?.status !== 'completed') {
    return validationFailed(call, '待办没有变为完成状态', '没有完成待办');
  }

  return createToolSuccessResult<TodoCompleteData>(call, `已完成待办：${completed.title}`, {
    id: completed.id,
    status: 'completed',
    title: completed.title,
  });
}

export const todoCreateTool: JunLuoToolDefinition<Record<string, unknown>, TodoCreateData> = {
  id: 'todo.create',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'todo',
  name: '创建待办',
  description: '创建一个本地待办事项，并返回真实创建出的待办 ID。',
  inputSchema: {
    type: 'object',
    required: ['title'],
    properties: {
      title: { type: 'string', description: '待办标题' },
      notes: { type: 'string', description: '待办备注' },
      plannedForDate: { type: 'string', description: '计划日期，格式为 YYYY-MM-DD' },
      priority: { type: 'string', enum: [...TODO_PRIORITIES], description: '待办优先级' },
      quadrant: { type: 'string', enum: [...TODO_QUADRANTS], description: '四象限分类' },
      category: { type: 'string', enum: [...TODO_CATEGORIES], description: '待办类别' },
      estimatedMinutes: { type: 'number', description: '预计耗时，单位分钟' },
      reminderMode: { type: 'string', enum: [...TODO_REMINDER_MODES], description: '提醒模式' },
    },
  },
  permission: 'ask',
  riskLevel: 'write_local',
  readOnly: false,
  executionScope: 'local_device',
  agentEpochMode: 'bounded_local_commits',
  executor: executeTodoCreate,
};

export const todoCompleteTool: JunLuoToolDefinition<Record<string, unknown>, TodoCompleteData> = {
  id: 'todo.complete',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'todo',
  name: '完成待办',
  description: CHAT_SCHEDULE_COMPLETE_DESCRIPTION,
  inputSchema: {
    type: 'object',
    required: ['todoId', 'title'],
    properties: {
      todoId: { type: 'string', description: '待办编号' },
      title: { type: 'string', description: '待办标题' },
      completedAt: { type: 'number' },
    },
  },
  permission: 'ask',
  riskLevel: 'write_local',
  readOnly: false,
  executionScope: 'local_device',
  agentEpochMode: 'bounded_local_commits',
  executor: executeTodoComplete,
};

export const todoToolPackage: JunLuoToolPackage = {
  id: 'todo',
  name: '待办',
  description: '创建和管理君落本地待办事项。',
  category: 'local_write',
  tools: [todoCreateTool, todoCompleteTool],
  defaultEnabled: true,
  riskLevel: 'write_local',
  source: 'builtin',
};
