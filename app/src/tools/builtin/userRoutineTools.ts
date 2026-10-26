import type { JunLuoToolDefinition, JunLuoToolInputSchema } from '../toolTypes';
import { createToolError } from '../toolErrors';
import { createToolErrorResult } from '../toolResult';

export const USER_ROUTINE_INPUT = `date：修改平常作息填 usual；修改某一天填 YYYY-MM-DD。

只填写要改的项目，其它保持原样：
wake 起床、breakfast 早餐、lunch 午餐、nap 午休、dinner 晚餐、sleep 睡觉。

每项按需填写：
time：平常作息填 HH:mm；某一天填 YYYY-MM-DD HH:mm。
minutes：吃饭或午休持续多少分钟。
enabled：启用写 true，不启用写 false。`;

const item: JunLuoToolInputSchema = { type: 'object', additionalProperties: false,
  properties: { time: { type: 'string' }, minutes: { type: 'number' }, enabled: { type: 'boolean' } } };
const execute: JunLuoToolDefinition['executor'] = (call, context) => {
  if (call.requestedBy !== 'chat' || !context?.userRoutine) return createToolErrorResult(call,
    createToolError('PERMISSION_DENIED', 'routine-chat-host-required'), '');
  return context.userRoutine(call);
};

export const userRoutineQueryTool: JunLuoToolDefinition = {
  id: 'schedule.query_routine', packageId: 'schedule', name: '查看 you 的作息',
  description: '查看 you 平常几点起床、吃饭和睡觉，也可以查某一天。那天改过时间，就显示改后的时间；到点不等于已经做了。',
  inputSchema: { type: 'object', additionalProperties: false,
    description: 'date：查某一天，填 YYYY-MM-DD；查平常作息，省略。', properties: { date: { type: 'string' } } },
  permission: 'allow', riskLevel: 'read', readOnly: true, chatExposure: 'candidate', proactiveEligible: false,
  executionScope: 'local_device', agentEpochMode: 'read_only_outside_lease', executor: execute,
};

export const userRoutineSaveTool: JunLuoToolDefinition = {
  id: 'schedule.save_routine', packageId: 'schedule', name: '记下鼠的作息',
  description: '按 you 明确说定的时间修改作息。临时变化只改指定日期；you 明确要长期调整时，才改平常作息。',
  inputSchema: { type: 'object', additionalProperties: false, required: ['date'], description: USER_ROUTINE_INPUT,
    properties: { date: { type: 'string' }, wake: { ...item, properties: { time: { type: 'string' }, enabled: { type: 'boolean' } } },
      breakfast: item, lunch: item, nap: item, dinner: item,
      sleep: { ...item, properties: { time: { type: 'string' }, enabled: { type: 'boolean' } } } } },
  permission: 'allow', riskLevel: 'write_local', readOnly: false, chatExposure: 'candidate', proactiveEligible: false,
  executionScope: 'local_device', agentEpochMode: 'bounded_local_commits', executor: execute,
};
