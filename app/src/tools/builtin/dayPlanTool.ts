import type { JunLuoToolDefinition } from '../toolTypes';
import { createToolSuccessResult } from '../toolResult';
import { parseDayPlanSubmission } from '../../schedule/dayPlanDraft';
import { CHAT_SCHEDULE_PLAN_DESCRIPTION } from '../../schedule/chatSchedulePrompts';
import { validationFailed } from './builtinToolValidation';

export const scheduleSubmitDayPlanTool: JunLuoToolDefinition = {
  id: 'schedule.submit_day_plan', packageId: 'schedule', name: '整理一天的安排',
  description: CHAT_SCHEDULE_PLAN_DESCRIPTION,
  inputSchema: {
    type: 'object', required: ['dateKey', 'entries'], properties: {
      dateKey: { type: 'string' }, planId: { type: 'string' },
      entries: { type: 'array', items: { type: 'object', required: ['action'], properties: {
        id: { type: 'string' }, action: { type: 'string', enum: ['schedule', 'inbox', 'cancel', 'remove'] },
        occurrenceId: { type: 'string', description: '修改或取消已有日程时，I 把“查看安排”返回的 occurrenceId 原样填在这里。新建日程时留空。' },
        todoId: { type: 'string', description: '使用已有待办时，I 把“查看安排”返回的这条待办的 id 原样填在这里。新想到的事项留空。' },
        title: { type: 'string' }, notes: { type: 'string' },
        startLocal: { type: 'string', description: 'I 填开始的日期和钟点，格式 YYYY-MM-DDTHH:mm。' },
        endLocal: { type: 'string', description: 'you 定好结束时间时，I 填结束的日期和钟点，格式 YYYY-MM-DDTHH:mm。' },
        startAt: { type: 'number', description: 'I 沿用查询返回的开始时间；新时间填 startLocal。' },
        endAt: { type: 'number', description: 'I 沿用查询返回的结束时间；新时间填 endLocal。' },
        clearEndAt: { type: 'boolean', description: 'you 明确要去掉这件事的结束时间时，I 填 true，endLocal、endAt 和 durationMinutes 留空。其余情况填 false。' },
        durationMinutes: { type: 'number', description: '这件事预计要做多少分钟。' },
        habitId: { type: 'string' }, scope: { type: 'string', enum: ['once', 'future'], description: '这次修改是只改这一次，还是从这次起，以后的安排都改。' },
        repeat: { type: 'object', description: '重复方式：每天、每周固定星期几，或每隔几天一次。', required: ['frequency'], properties: {
          frequency: { type: 'string', enum: ['daily', 'weekly', 'interval'] },
          weekDays: { type: 'array', items: { type: 'number' }, description: '每周在哪几天做。' },
          intervalDays: { type: 'number', description: '做完一次后，隔几天再做下一次。' },
        } },
        steps: { type: 'array', minItems: 1, description: '这次要安排的小步骤。每一步填写要做什么、开始时间和时长。', items: { type: 'object', required: ['title', 'durationMinutes'], properties: {
          id: { type: 'string' }, occurrenceId: { type: 'string' }, todoId: { type: 'string' }, title: { type: 'string' },
          startLocal: { type: 'string', description: 'I 填开始的日期和钟点，格式 YYYY-MM-DDTHH:mm。' },
          startAt: { type: 'number', description: 'I 沿用查询返回的开始时间；新时间填 startLocal。' },
          durationMinutes: { type: 'number' }, startSuggested: { type: 'boolean' }, endSuggested: { type: 'boolean' },
        } } },
        startReminderEnabled: { type: 'boolean' }, companionEnabled: { type: 'boolean' },
        reminderMinutesBefore: { type: 'number' }, startSuggested: { type: 'boolean' }, endSuggested: { type: 'boolean' },
      } } },
    },
  },
  chatExposure: 'candidate', proactiveEligible: false,
  permission: 'allow', riskLevel: 'read', readOnly: true,
  executor: (call, context) => {
    if (call.requestedBy === 'chat') return context?.chatSchedule ? context.chatSchedule(call) : validationFailed(call, 'schedule-turn-unavailable', '');
    try { return createToolSuccessResult(call, '', parseDayPlanSubmission(call.input)); }
    catch { return validationFailed(call, 'INVALID_ARGUMENTS', 'INVALID_ARGUMENTS'); }
  },
};
