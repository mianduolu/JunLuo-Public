import { buildOpenAiCompatibilityPayload } from '../ai/modelParameters';
import type { AiConnection } from '../ai/types';
import { allExpenseCategories, looksLikeExpenseIntent } from './expenseParser';
import type { ExpenseDraft, ExpenseEntryType } from './expenseStore';

type ExpenseAiResponse = {
  amount?: unknown;
  category?: unknown;
  confidence?: unknown;
  note?: unknown;
  occurredAt?: unknown;
  type?: unknown;
};

const categorySet = new Set(allExpenseCategories);

function stripCodeFence(text: string) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function normalizeType(value: unknown): ExpenseEntryType | null {
  return value === 'income' || value === 'expense' ? value : null;
}

function normalizeTimestamp(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function validateExpenseAiResponse(value: unknown): ExpenseDraft | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as ExpenseAiResponse;
  const type = normalizeType(candidate.type);
  const amount = typeof candidate.amount === 'number' ? candidate.amount : Number(candidate.amount);
  const confidence = typeof candidate.confidence === 'number' ? candidate.confidence : Number(candidate.confidence ?? 0);
  if (!type || !Number.isFinite(amount) || amount <= 0 || confidence < 0.65) return null;

  const fallbackCategory = type === 'income' ? '其他收入' : '其他';
  const category = typeof candidate.category === 'string' && categorySet.has(candidate.category)
    ? candidate.category
    : fallbackCategory;
  const note = typeof candidate.note === 'string'
    ? candidate.note.replace(/\s+/g, ' ').trim().slice(0, 36)
    : '';
  if (!note) return null;

  return {
    amount: Math.round(amount * 100) / 100,
    category,
    note,
    occurredAt: normalizeTimestamp(candidate.occurredAt),
    source: 'chat',
    type,
  };
}

export async function generateExpenseDraftFromText({
  apiKey,
  connection,
  text,
}: {
  apiKey: string;
  connection: AiConnection;
  text: string;
}) {
  if (!looksLikeExpenseIntent(text)) return null;

  const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: connection.model.trim(),
      ...buildOpenAiCompatibilityPayload(connection),
      messages: [
        {
          role: 'system',
          content: `【记账解析】
当前任务：从小仓鼠这一轮聊天原文中提取一笔待确认账单。

只返回严格 JSON。

输出格式：
{"valid":true,"type":"expense|income","amount":数字,"category":"分类","note":"内容","occurredAt":"ISO时间","confidence":0到1}
或：
{"valid":false}

允许的 category：
${allExpenseCategories.join('、')}

提取原则：
只有小仓鼠明确在记录已经发生、正在发生，或明确准备记下来的消费 / 收入，并且金额能确定时，返回 valid=true。

type：
- 花钱、买入、支付、扣款、充值，归为 expense。
- 收到工资、转账、红包、退款、报销，归为 income。

amount：
金额用人民币数字。
“三千块”=3000，“三千五”=3500，“3k”=3000。

note：
写这笔钱对应的内容，不超过 36 字。
例如“买扫地机”“收到报销”“充值 API”。

category：
按小仓鼠说出的内容选择最贴近的分类。
扫地机、家电、日用品归入“生活用品”。
API、模型、Token、开发素材归入“养云”。

返回 valid=false 的情况：
- 只是在聊天、吐槽、测试 prompt、排查 bug 或讨论模型。
- 只出现年龄、日期、时间、年份、持续时长、次数、数量。
- 只是想买、假设买、比较价格、问值不值得买。
- 只是收到礼物、不喜欢礼物、说补偿，金额或转账事实没说清。
- 金额、收支方向或记账意图不够明确。`,
        },
        {
          role: 'user',
          content: `当前时间：${new Date().toISOString()}
聊天原文：${text}`,
        },
      ],
      temperature: 0.1,
    }),
  });

  if (!response.ok) throw new Error(`expense-parser-http-${response.status}`);
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) return null;
  try {
    const parsed = JSON.parse(stripCodeFence(content)) as unknown;
    return validateExpenseAiResponse(parsed);
  } catch {
    return null;
  }
}
