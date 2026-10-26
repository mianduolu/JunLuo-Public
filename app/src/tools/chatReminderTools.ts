import type { JunLuoToolDefinition, JunLuoToolInputSchema } from './toolTypes';
import { createToolError } from './toolErrors';
import { createToolErrorResult } from './toolResult';

// Verbatim user-approved reminders batch, 2026-10-03.
export const REMINDER_CATALOG_DESCRIPTION = '查看、设置、修改或取消提醒与闹钟。';
export const REMINDER_QUERY_DESCRIPTION = '查看已保存的提醒和闹钟，可以按日期查找。';
export const REMINDER_BODY_INSTRUCTION = '到点时，I 想对 you 说些什么？\n\nreminderMessages：这次的提醒正文列表。\nitem：对应提醒在本次材料中的编号。\ntext：到点时，I 想对 you 说的话。\n这次没有想说的话，就填 ""。';
export const REMINDER_QUERY_SCHEMA: JunLuoToolInputSchema = {
  type: 'object', additionalProperties: false, properties: {
    startDate: { type: 'string', description: '从哪一天开始查，包含这一天。' },
    endDate: { type: 'string', description: '查到哪一天，包含这一天。' },
  },
};
const fields: Record<string, JunLuoToolInputSchema> = {
  date: { type: 'string', description: '提醒或闹钟在哪一天，填写 YYYY-MM-DD。' },
  clock: { type: 'string', description: '这一天几点提醒，填写 HH:mm，使用24小时制。' },
  repeat: { type: 'string', enum: ['once', 'daily', 'weekly'], description: '只这一次 / 每天 / 每周固定星期几。' },
  weekdays: { type: 'array', items: { type: 'number', enum: [0, 1, 2, 3, 4, 5, 6] }, description: '每周在哪几天提醒。' },
  mode: { type: 'string', enum: ['notification', 'music'], description: '消息提醒 / 音乐提醒。' },
  title: { type: 'string', description: '这次要提醒 you 的事情。' },
  note: { type: 'string', description: '需要补充的说明，可以不填。' },
  song: { type: 'object', additionalProperties: false, required: ['title', 'artist'], properties: {
    title: { type: 'string', description: 'I 想递给 you 的那首歌叫什么。' },
    artist: { type: 'string', description: '这首歌是谁唱的，或是谁演奏的。' },
  } },
};
export const REMINDER_CHAT_TOOL_IDS = ['reminder.query', 'reminder.propose_reminders',
  'reminder.propose_updates', 'reminder.propose_cancellations'] as const;
export function isReminderChatTool(id: string) { return (REMINDER_CHAT_TOOL_IDS as readonly string[]).includes(id); }
function rows(properties: Record<string, JunLuoToolInputSchema>, required: string[]): JunLuoToolDefinition['inputSchema'] {
  return { type: 'object', additionalProperties: false, required: ['reminders'], properties: {
    reminders: { type: 'array', items: { type: 'object', additionalProperties: false, properties, required } },
  } };
}
function define(id: typeof REMINDER_CHAT_TOOL_IDS[number], name: string, description: string,
  inputSchema: JunLuoToolDefinition['inputSchema']): JunLuoToolDefinition {
  return { id, name, description, packageId: 'reminder', inputSchema, chatExposure: 'candidate',
    proactiveEligible: false, permission: 'allow', readOnly: true, riskLevel: 'read',
    executor: (call, context) => context?.chatReminder ? context.chatReminder(call)
      : Promise.resolve(createToolErrorResult(call, createToolError('EXECUTION_FAILED', '没有执行工具'), '没有执行工具')) };
}
const item: JunLuoToolInputSchema = { type: 'number', description: '沿用这次查找结果中的编号。' };
export const chatReminderTools: JunLuoToolDefinition[] = [
  define('reminder.query', '查提醒', REMINDER_QUERY_DESCRIPTION, REMINDER_QUERY_SCHEMA as JunLuoToolDefinition['inputSchema']),
  define('reminder.propose_reminders', '设置提醒', '在指定时间提醒 you 做某件事。一次可以安排多条。单次的相对时间填写 afterMinutes；指定日期时间或重复提醒填写 date 和 clock。',
    rows({ ...fields, afterMinutes: { type: 'number', description: '从 you 本条消息发出时算起，多少分钟后提醒。填写大于 0 的分钟数。' } }, ['title', 'mode'])),
  define('reminder.propose_updates', '修改提醒', '先查到 you 要改的提醒或闹钟。只修改 you 明确要求改的内容，一次可以修改多条。',
    rows({ ...fields, item, scope: { type: 'string', enum: ['once', 'future'], description: '只改这一次 / 从这次起每次都改。' } }, ['item', 'scope'])),
  define('reminder.propose_cancellations', '取消提醒', '先查到 you 要取消的提醒或闹钟，再按 you 的要求取消。一次可以取消多条。',
    rows({ item, scope: { type: 'string', enum: ['once', 'future'], description: '只取消这一次 / 从这次起不再提醒。' } }, ['item', 'scope'])),
];
