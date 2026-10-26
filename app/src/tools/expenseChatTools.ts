import type { JunLuoToolDefinition, JunLuoToolInputSchema } from './toolTypes';
import { createToolError } from './toolErrors';
import { createToolErrorResult } from './toolResult';
import { allExpenseCategories } from '../expense/expenseParser';

// These descriptions are the user's verbatim approved bookkeeping batch.
export const EXPENSE_CATALOG_DESCRIPTION = '查看日常收支，帮 you 记账、改账或删账。';
export const EXPENSE_OPEN_DESCRIPTION = '打开记账工具包。需要查账时，可以按日期和分类查找，返回合计和对应账单。';
export const EXPENSE_QUERY_PROPERTIES: Record<string, JunLuoToolInputSchema> = {
  startDate: { type: 'string', description: '从哪一天开始查，包含这一天。' },
  endDate: { type: 'string', description: '查到哪一天，包含这一天。' },
  category: { type: 'string', description: '想查哪一类账单。不填就查全部分类。' },
};
export const EXPENSE_QUERY_SCHEMA: JunLuoToolInputSchema = {
  type: 'object', required: ['startDate', 'endDate'], additionalProperties: false,
  properties: EXPENSE_QUERY_PROPERTIES,
};
const fields: Record<string, JunLuoToolInputSchema> = {
  amount: { type: 'number', description: '这笔账多少钱，单位元，填写正数。' },
  type: { type: 'string', enum: ['expense', 'income'], description: '这笔钱是收入还是支出。' },
  date: { type: 'string', description: '这笔账发生在哪一天。没提日期时可以不填。' },
  category: { type: 'string', enum: allExpenseCategories, description: '这笔账属于哪一类。' },
  note: { type: 'string', description: '这笔钱用来做什么，或从哪里来。' },
  item: { type: 'number', description: '沿用这次查账结果中的编号。' },
};
export const EXPENSE_CHAT_TOOL_IDS = ['expense.query_entries', 'expense.more_entries',
  'expense.propose_entries', 'expense.propose_updates', 'expense.propose_deletions', 'expense.propose_refunds'] as const;
export function isExpenseChatTool(id: string) { return (EXPENSE_CHAT_TOOL_IDS as readonly string[]).includes(id); }
export function isExpenseProposalTool(id: string) { return id.startsWith('expense.propose_'); }

function definition(id: typeof EXPENSE_CHAT_TOOL_IDS[number], name: string, description: string,
  inputSchema: JunLuoToolDefinition['inputSchema']): JunLuoToolDefinition {
  return { id, packageId: 'expense', name, description, inputSchema,
    chatExposure: 'candidate', proactiveEligible: false, permission: 'allow', riskLevel: 'read', readOnly: true,
    // Only proposals are produced here. The separately confirmed card owns ledger writes.
    executor: (call, context) => context?.chatExpense ? context.chatExpense(call)
      : Promise.resolve(createToolErrorResult(call, createToolError('EXECUTION_FAILED', '没有执行工具'), '没有执行工具')) };
}
function entriesSchema(properties: Record<string, JunLuoToolInputSchema>, required: string[]): JunLuoToolDefinition['inputSchema'] {
  return { type: 'object', required: ['entries'], additionalProperties: false, properties: {
    entries: { type: 'array', items: { type: 'object', required, properties, additionalProperties: false } },
  } };
}
export const expenseChatTools: JunLuoToolDefinition[] = [
  definition('expense.query_entries', '查账', '查看日常账单，可以按日期和分类查找，返回合计和对应账单。', EXPENSE_QUERY_SCHEMA as JunLuoToolDefinition['inputSchema']),
  definition('expense.more_entries', '续看', '沿用刚才的查账条件，再列出下一批账单。', { type: 'object', properties: {}, additionalProperties: false }),
  definition('expense.propose_entries', '新账', '把 you 已经发生的收入和支出列成待确认账单。一次可以列多笔。',
    entriesSchema(Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'item')), ['amount', 'type'])),
  definition('expense.propose_updates', '修改', '先查到 you 要改的账单，再列出修改后的待确认账单。一次可以修改多笔。I 只改 you 明确要求修改的部分。',
    entriesSchema(fields, ['item'])),
  definition('expense.propose_deletions', '删除', '先查到 you 要删的账单，再列成待确认的删除清单。一次可以列多笔。',
    entriesSchema({ item: fields.item }, ['item'])),
  definition('expense.propose_refunds', '退款', '把已经退回的钱列成待确认的退款账单。查到原来的支出时，就关联那笔支出；查不到时，只记退款。一次可以列多笔。',
    entriesSchema(Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'type')), ['amount'])),
];

