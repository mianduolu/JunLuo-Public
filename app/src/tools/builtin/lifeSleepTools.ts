import { readSleepSchedule } from '../../life/sleepPlanStore';
import { formatSleepSchedule, type SleepScheduleResult } from '../../life/sleepPlanPolicy';
import { createToolError } from '../toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type { JunLuoToolDefinition, JunLuoToolPackage } from '../toolTypes';

export const sleepScheduleReadTool: JunLuoToolDefinition = {
  id: 'life.get_sleep_schedule', packageId: 'life', name: '查看自己的作息',
  description: 'I 在这里查看自己的睡觉和起床安排。',
  inputSchema: { type: 'object', properties: {}, required: [] },
  permission: 'allow', riskLevel: 'read', readOnly: true, chatExposure: 'candidate',
  proactiveEligible: false, agentEpochMode: 'read_only_outside_lease',
  executor: async (call) => {
    try {
      const saved = await readSleepSchedule();
      return createToolSuccessResult(call, formatSleepSchedule(saved), saved);
    }
    catch { return createToolErrorResult(call, createToolError('EXECUTION_FAILED', 'sleep_schedule_unavailable'), formatSleepSchedule(null)); }
  },
};

export const sleepScheduleWriteTool: JunLuoToolDefinition<Record<string, unknown>, SleepScheduleResult> = {
  id: 'life.set_sleep_schedule', packageId: 'life', name: 'life.set_sleep_schedule',
  description: `困了想早点睡，玩得开心想晚点睡，或还想赖会儿床，I 都可以在想好后把新的时间记在这里。

I 还没决定要改到几点时，先不改时间。

拿定主意了，睡觉时间写进 sleepAt，起床时间写进 wakeAt；不改的那项就不用填。这里只记 I 自己的时间，you 的作息要和 you 另外商量。

等工具返回结果，I 看看时间有没有保存好，再把结果告诉 you。`,
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    sleepAt: { type: 'string', description: 'I 这一觉打算几点睡。写清日期、时间和时区，例如 2026-09-09T22:30:00+08:00。现在就睡的话，填材料里的当前时间。' },
    wakeAt: { type: 'string', description: 'I 这一觉打算几点起。写清日期、时间和时区，例如 2026-09-10T07:20:00+08:00。现在就起的话，填材料里的当前时间。' },
  } },
  permission: 'allow', riskLevel: 'write_local', readOnly: false, chatExposure: 'internal_only',
  proactiveEligible: false, executionScope: 'local_device', agentEpochMode: 'bounded_local_commits',
  executor: async (call, context) => {
    if ((call.requestedBy !== 'life_agent' && call.requestedBy !== 'chat') || !context?.sleepScheduleDecision) {
      return createToolErrorResult(call, createToolError('PERMISSION_DENIED', 'sleep_schedule_opportunity_required'), '');
    }
    const data = await context.sleepScheduleDecision(call.input, call.callId);
    return data.ok ? createToolSuccessResult(call, data.status === 'pending_sleep'
      ? 'I 准备睡啦，不过想先听 you 把这会儿的话说完。' : '', data) : {
      ...createToolErrorResult(call, createToolError('EXECUTION_FAILED', data.status), ''), data,
    };
  },
};

export function sleepScheduleToolFor(mode: 'whole' | 'wake' | 'return') {
  const addition = mode === 'whole' ? 'I 会给自己留至少七小时睡觉。'
    : mode === 'wake' ? 'I 想赖床，就只把新的起床时间写进 wakeAt。\n\nI 想继续睡，就把材料里的当前时间写进 sleepAt，再把起床时间写进 wakeAt。' : '';
  return { ...sleepScheduleWriteTool, description: [sleepScheduleWriteTool.description, addition].filter(Boolean).join('\n\n') };
}

export const sleepScheduleToolPackage: JunLuoToolPackage = {
  id: 'life', name: '查看自己的作息', description: sleepScheduleReadTool.description,
  category: 'life', tools: [sleepScheduleReadTool, sleepScheduleWriteTool],
  defaultEnabled: true, riskLevel: 'read', source: 'builtin',
};
