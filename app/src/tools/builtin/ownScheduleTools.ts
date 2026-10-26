import type { JunLuoToolDefinition, JunLuoToolInputSchema } from '../toolTypes';
import { createToolError } from '../toolErrors';
import { createToolErrorResult } from '../toolResult';
import { OWN_DAY_PLAN_ENTRY_INSTRUCTION, OWN_DAY_PLAN_EDIT_INSTRUCTION, OWN_DAY_PLAN_HABIT_INSTRUCTION,
  OWN_HABIT_INSTRUCTION, OWN_READING_CONTINUATION_INSTRUCTION } from '../../schedule/ownDayPlanPrompt';

const ids: JunLuoToolInputSchema = { type: 'array', items: { type: 'string' } };
export const ownScheduleWriteTool: JunLuoToolDefinition = {
  id: 'schedule.save_own', packageId: 'schedule', name: '记下日程',
  description: '保存或调整 I 自己的安排，以及 I 和 you 已经说定的共同安排。',
  inputSchema: { type: 'object', additionalProperties: false, required: ['entries', 'cancelIds'],
    description: [OWN_DAY_PLAN_ENTRY_INSTRUCTION, OWN_READING_CONTINUATION_INSTRUCTION, OWN_DAY_PLAN_EDIT_INSTRUCTION, OWN_DAY_PLAN_HABIT_INSTRUCTION].join('\n\n'),
    properties: {
      entries: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['id', 'title', 'owner'], properties: {
          id: { type: 'string', nullable: true }, title: { type: 'string' }, startAt: { type: 'string' }, minutes: { type: 'number' },
          readingId: { type: 'string', nullable: true }, habitId: { type: 'string' },
          localId: { type: 'string' }, continueFrom: { type: 'string' }, nextReadingId: { type: 'string', nullable: true },
          owner: { type: 'string', enum: ['I', 'I 和 you'], description: 'owner：I 自己的安排写 I；I 和 you 的共同安排写 I 和 you。' },
        } } }, cancelIds: ids,
    } },
  permission: 'allow', riskLevel: 'write_local', readOnly: false, chatExposure: 'candidate', proactiveEligible: false,
  executionScope: 'local_device', agentEpochMode: 'bounded_local_commits',
  executor: (call, context) => {
    if ((call.requestedBy !== 'chat' && !(call.requestedBy === 'life_agent' && context?.ownScheduleScope === 'near-status')) || !context?.ownSchedule) return createToolErrorResult(call,
      createToolError('PERMISSION_DENIED', 'schedule-chat-host-required'), '');
    return context.ownSchedule(call);
  },
};

export function nearStatusScheduleTool(): JunLuoToolDefinition {
  const entries = ownScheduleWriteTool.inputSchema.properties!.entries;
  const item = entries.items!;
  const { localId: _localId, continueFrom: _continueFrom, nextReadingId: _nextReadingId, ...restrictedProperties } = item.properties!;
  return { ...ownScheduleWriteTool, description: '修改或取消 I 待调整的安排。', inputSchema: {
    ...ownScheduleWriteTool.inputSchema,
    description: ['I 把调整后的完整安排写进 entries，id 填那项安排的编号。',
      '想取消的安排，把编号填进 cancelIds。', '不变的安排不用写；没有内容的数组写 []。',
      OWN_DAY_PLAN_ENTRY_INSTRUCTION, OWN_DAY_PLAN_HABIT_INSTRUCTION].join('\n\n'),
    properties: { ...ownScheduleWriteTool.inputSchema.properties, entries: { ...entries, items: { ...item,
      required: ['id', 'title', 'readingId', 'owner'],
      properties: { ...restrictedProperties, id: { type: 'string' }, owner: { ...item.properties!.owner, enum: ['I'] } } } } },
  } };
}
export const ownHabitWriteTool: JunLuoToolDefinition = {
  id: 'schedule.save_own_habits', packageId: 'schedule', name: '记下自己的习惯',
  description: '保存 I 想长期重复做的事，也可以修改或停止已有习惯。',
  inputSchema: { type: 'object', additionalProperties: false, required: ['entries', 'stopIds'], description: OWN_HABIT_INSTRUCTION,
    properties: { entries: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['id', 'title', 'frequency', 'count', 'weekDays', 'minutes'], properties: {
        id: { type: 'string', nullable: true }, title: { type: 'string' }, frequency: { type: 'string', enum: ['daily', 'weekly', 'weekdays'] },
        count: { type: 'number' }, weekDays: { type: 'array', items: { type: 'number' } }, minutes: { type: 'number', nullable: true },
      } } }, stopIds: ids } },
  permission: 'allow', riskLevel: 'write_local', readOnly: false, chatExposure: 'candidate', proactiveEligible: false,
  executionScope: 'local_device', agentEpochMode: 'bounded_local_commits',
  executor: (call, context) => {
    if (!['chat', 'life_agent'].includes(call.requestedBy) || !context?.ownSchedule) return createToolErrorResult(call,
      createToolError('PERMISSION_DENIED', 'habit-host-required'), '');
    return context.ownSchedule(call);
  },
};
