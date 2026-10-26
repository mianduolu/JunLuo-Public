import { createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import {
  isOneOf,
  isValidTimestamp,
  readNumberInput,
  readOptionalStringInput,
  validationFailed,
} from './builtinToolValidation';
import type { ExpenseEntryType } from '../../expense/expenseStore';
import { expenseChatTools } from '../expenseChatTools';

type ExpenseCreateEntryData = {
  amount: number;
  category: string;
  id: string;
  note: string;
  occurredAt: number;
  type: ExpenseEntryType;
};

const EXPENSE_TYPES = ['expense', 'income'] as const satisfies readonly ExpenseEntryType[];

async function executeExpenseCreateEntry(call: JunLuoToolCall): Promise<JunLuoToolResult<ExpenseCreateEntryData>> {
  const amount = readNumberInput(call.input, 'amount');
  if (amount === undefined || amount <= 0) {
    return validationFailed(call, '金额必须是大于 0 的数字', '没有创建账单');
  }

  const occurredAt = call.input.occurredAt ?? Date.now();
  if (!isValidTimestamp(occurredAt)) return validationFailed(call, '账单发生时间不是有效时间戳', '没有创建账单');

  const type = isOneOf(call.input.type, EXPENSE_TYPES) ? call.input.type : 'expense';
  const { createExpenseEntry } = await import('../../expense/expenseStore');
  const entry = await createExpenseEntry({
    amount,
    category: readOptionalStringInput(call.input, 'category') || '其他',
    note: readOptionalStringInput(call.input, 'note') ?? '',
    occurredAt,
    source: 'chat',
    type,
  });

  const typeLabel = entry.type === 'income' ? '收入' : '支出';
  return createToolSuccessResult<ExpenseCreateEntryData>(call, `已创建${typeLabel}记录：${entry.amount} 元`, {
    amount: entry.amount,
    category: entry.category,
    id: entry.id,
    note: entry.note,
    occurredAt: entry.occurredAt,
    type: entry.type,
  });
}

export const expenseCreateEntryTool: JunLuoToolDefinition<Record<string, unknown>, ExpenseCreateEntryData> = {
  id: 'expense.create_entry',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'expense',
  name: '创建账单',
  description: '创建一条本地支出或收入记录，并返回真实创建出的账单 ID。',
  inputSchema: {
    type: 'object',
    required: ['amount'],
    properties: {
      amount: { type: 'number', description: '金额，必须大于 0' },
      type: { type: 'string', enum: [...EXPENSE_TYPES], description: '账单类型' },
      category: { type: 'string', description: '账单分类' },
      note: { type: 'string', description: '备注' },
      occurredAt: { type: 'number', description: '发生时间，毫秒时间戳' },
    },
  },
  permission: 'ask',
  riskLevel: 'write_local',
  readOnly: false,
  executor: executeExpenseCreateEntry,
};

export const expenseToolPackage: JunLuoToolPackage = {
  id: 'expense',
  name: '记账',
  description: '创建和管理君落本地账单记录。',
  category: 'local_write',
  tools: [expenseCreateEntryTool, ...expenseChatTools],
  defaultEnabled: true,
  riskLevel: 'write_local',
  source: 'builtin',
};
