import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { expenseCategories, incomeCategories } from '../expense/expenseParser';
import { getExpenseLedgerRevision, loadExpenseEntryById, queryExpenseLedger, type ExpenseDraft, type ExpenseEntry } from '../expense/expenseStore';
import { createExpensePlanCard, type ChatExpensePlanCard } from '../chat/chatExpensePlan';
import { createToolError } from './toolErrors';
import { createToolErrorResult, createToolSuccessResult } from './toolResult';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';
import type { JunLuoToolAgentContinuationMessage } from './toolAgentMessages';

type Source = { sessionId: string; messageId: string; content: string; createdAt: number };
type PlanInput = Parameters<typeof createExpensePlanCard>[1][number];
type Query = { startDate: string; endDate: string; category?: string };
type VisibleEntry = { item: number; type: string; amount: number; date: string; category: string; note: string };
const PAGE_SIZE = 50;
const RECEIPT_BUDGET = 10000;
function localDate(at: number) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function dateAt(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('INVALID_ARGUMENTS');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (localDate(date.getTime()) !== value) throw new Error('INVALID_ARGUMENTS');
  return date.getTime();
}
function sameEntry(a: ExpenseEntry, b: ExpenseEntry) { return JSON.stringify(a) === JSON.stringify(b); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ARGUMENTS');
  return value as Record<string, unknown>;
}
function amount(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0
    || value > Number.MAX_SAFE_INTEGER / 100 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) throw new Error('INVALID_ARGUMENTS');
  return value;
}
function newId() { return `expense-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`; }

/** Short-lived turn bindings; only the actual transport grants an item, never settlement. */
export function createExpenseChatHost(input: {
  source?: Source; dataEpoch: number; signal?: AbortSignal; isCurrent?: () => Promise<boolean>;
  remainingRequests: () => number;
}) {
  let query: Query | undefined;
  let cursor: { occurredAt: number; id: string } | undefined;
  let totals: Awaited<ReturnType<typeof queryExpenseLedger>>['totals'] | undefined;
  let hasMore = false;
  let ledgerRevision: number | undefined;
  let nextItem = 1;
  const pages = new Map<string, { visible: VisibleEntry[]; entries: Map<number, ExpenseEntry> }>();
  const delivered = new Map<number, ExpenseEntry>();
  const proposals = new Map<string, PlanInput[]>();
  const current = async () => !!input.source && !input.signal?.aborted
    && canCommitBackupRestoreDataEpoch(input.dataEpoch) && (!input.isCurrent || await input.isCurrent());
  const failure = (call: JunLuoToolCall, code: string) => createToolErrorResult(call,
    createToolError(code === 'INVALID_ARGUMENTS' ? 'INVALID_ARGUMENTS' : 'EXECUTION_FAILED', code), '没有执行工具');
  const target = async (item: unknown) => {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1) throw new Error('INVALID_ARGUMENTS');
    const original = delivered.get(item);
    if (!original) throw new Error('INVALID_ARGUMENTS');
    if (ledgerRevision !== getExpenseLedgerRevision()) throw new Error('EXPENSE_QUERY_EXPIRED');
    const latest = await loadExpenseEntryById(original.id);
    if (!latest || !sameEntry(original, latest)) throw new Error('EXPENSE_SOURCE_CHANGED');
    return original;
  };
  const executeQuery = async (call: JunLuoToolCall, more = false, providerCallId = call.callId) => {
    if (!more) {
      const values = call.input;
      if (Object.keys(values).some(key => !['startDate', 'endDate', 'category'].includes(key))) throw new Error('INVALID_ARGUMENTS');
      const startAt = dateAt(values.startDate); const endAt = dateAt(values.endDate);
      if (endAt < startAt || (values.category !== undefined && typeof values.category !== 'string')) throw new Error('INVALID_ARGUMENTS');
      query = { startDate: String(values.startDate), endDate: String(values.endDate),
        ...(values.category !== undefined ? { category: String(values.category) } : {}) };
      cursor = undefined; totals = undefined; ledgerRevision = undefined; pages.clear(); delivered.clear(); nextItem = 1;
    } else {
      if (Object.keys(call.input).length || !query || !hasMore) throw new Error('EXPENSE_QUERY_EXPIRED');
      if (ledgerRevision !== getExpenseLedgerRevision()) throw new Error('EXPENSE_QUERY_EXPIRED');
      for (const original of delivered.values()) {
        const latest = await loadExpenseEntryById(original.id);
        if (!latest || !sameEntry(latest, original)) throw new Error('EXPENSE_QUERY_EXPIRED');
      }
    }
    if (!query) throw new Error('EXPENSE_QUERY_EXPIRED');
    const exclusiveEnd = new Date(dateAt(query.endDate)); exclusiveEnd.setDate(exclusiveEnd.getDate() + 1);
    const page = await queryExpenseLedger({ startAt: dateAt(query.startDate), endAt: exclusiveEnd.getTime(),
      category: query.category, cursor, limit: PAGE_SIZE });
    if (!await current()) throw new Error('EXPENSE_SOURCE_CHANGED');
    if (ledgerRevision !== undefined && ledgerRevision !== page.revision) throw new Error('EXPENSE_QUERY_EXPIRED');
    ledgerRevision = page.revision;
    if (totals && JSON.stringify(totals) !== JSON.stringify(page.totals)) throw new Error('EXPENSE_QUERY_EXPIRED');
    totals = page.totals;
    const visible = page.entries.map((entry, index): VisibleEntry => ({ item: nextItem + index, type: entry.type,
      amount: entry.amount, date: localDate(entry.occurredAt), category: entry.category, note: entry.note }));
    const data = { query, totals, entries: visible, hasMore: page.hasMore };
    while (visible.length && JSON.stringify(data).length > RECEIPT_BUDGET) { visible.pop(); data.hasMore = true; }
    if (!visible.length && page.entries.length) { hasMore = false; throw new Error('EXPENSE_RECEIPT_TOO_LARGE'); }
    const selected = page.entries.slice(0, visible.length);
    const entries = new Map(selected.map((entry, index) => [nextItem + index, entry]));
    nextItem += visible.length;
    cursor = selected.length ? { occurredAt: selected.at(-1)!.occurredAt, id: selected.at(-1)!.id } : cursor;
    hasMore = data.hasMore;
    pages.set(providerCallId, { visible, entries });
    return createToolSuccessResult(call, '', data);
  };
  const buildDraft = (values: Record<string, unknown>, original?: ExpenseEntry, refund = false): ExpenseDraft => {
    const type = refund ? 'refund' : values.type ?? original?.type;
    if (!['expense', 'income', 'refund'].includes(String(type)) || (!refund && !original && type === 'refund')) throw new Error('INVALID_ARGUMENTS');
    const category = values.category ?? original?.category ?? (type === 'income' ? '其他收入' : '其他');
    const note = values.note ?? original?.note ?? '';
    if (typeof category !== 'string' || typeof note !== 'string' || note.length > 10000
      || (!original || values.category !== undefined) && !(type === 'income' ? incomeCategories : expenseCategories).includes(category)) throw new Error('INVALID_ARGUMENTS');
    return { amount: values.amount !== undefined ? amount(values.amount) : original!.amount,
      type: type as ExpenseDraft['type'], category, note,
      occurredAt: values.date !== undefined ? dateAt(values.date) : original?.occurredAt ?? dateAt(localDate(input.source!.createdAt)),
      source: original?.source ?? 'chat',
      ...(original?.originalExpenseId ? { originalExpenseId: original.originalExpenseId } : {}) };
  };
  const execute = async (call: JunLuoToolCall, providerCallId = call.callId): Promise<JunLuoToolResult> => {
    try {
      if (!await current()) throw new Error('EXPENSE_SOURCE_CHANGED');
      if (call.toolId === 'expense.query_entries') return await executeQuery(call, false, providerCallId);
      if (call.toolId === 'expense.more_entries') return await executeQuery(call, true, providerCallId);
      if (input.remainingRequests() < 1) throw new Error('CHAT_MODEL_REQUEST_BUDGET_EXHAUSTED');
      if (proposals.has(providerCallId)) return createToolSuccessResult(call, '', { proposed: proposals.get(providerCallId)!.length });
      if (Object.keys(call.input).some(key => key !== 'entries') || !Array.isArray(call.input.entries)
        || !call.input.entries.length || call.input.entries.length > 50) throw new Error('INVALID_ARGUMENTS');
      const rows: PlanInput[] = [];
      for (const value of call.input.entries) {
        const values = record(value);
        if (Object.keys(values).some(key => !['amount', 'type', 'date', 'category', 'note', 'item'].includes(key))) throw new Error('INVALID_ARGUMENTS');
        if (call.toolId === 'expense.propose_entries') {
          if (values.item !== undefined || values.amount === undefined || values.type === undefined) throw new Error('INVALID_ARGUMENTS');
          rows.push({ action: 'create', id: newId(), draft: buildDraft(values) });
        } else if (call.toolId === 'expense.propose_updates') {
          if (Object.keys(values).length < 2) throw new Error('INVALID_ARGUMENTS');
          const expected = await target(values.item);
          const originalExpected = expected.originalExpenseId ? await loadExpenseEntryById(expected.originalExpenseId) : undefined;
          if (expected.originalExpenseId && (!originalExpected || originalExpected.type !== 'expense')) throw new Error('EXPENSE_SOURCE_CHANGED');
          rows.push({ action: 'update', id: expected.id, expected, draft: buildDraft(values, expected), originalExpected: originalExpected ?? undefined });
        } else if (call.toolId === 'expense.propose_deletions') {
          if (Object.keys(values).some(key => key !== 'item')) throw new Error('INVALID_ARGUMENTS');
          const expected = await target(values.item); rows.push({ action: 'delete', id: expected.id, expected });
        } else if (call.toolId === 'expense.propose_refunds') {
          if (values.type !== undefined || values.amount === undefined) throw new Error('INVALID_ARGUMENTS');
          const originalExpected = values.item !== undefined ? await target(values.item) : undefined;
          if (originalExpected && originalExpected.type !== 'expense') throw new Error('INVALID_ARGUMENTS');
          const draft = buildDraft({ ...values, type: 'refund' }, undefined, true);
          if (originalExpected) draft.originalExpenseId = originalExpected.id;
          if (originalExpected && values.category === undefined) draft.category = originalExpected.category;
          rows.push({ action: 'refund', id: newId(), draft, originalExpected });
        } else throw new Error('INVALID_ARGUMENTS');
      }
      const proposedIds = new Set([...proposals.values()].flatMap(batch => batch.map(row => row.id)));
      for (const row of rows) {
        if (proposedIds.has(row.id)) throw new Error('INVALID_ARGUMENTS');
        proposedIds.add(row.id);
      }
      if (!await current()) throw new Error('EXPENSE_SOURCE_CHANGED');
      proposals.set(providerCallId, rows);
      return createToolSuccessResult(call, '', { proposed: rows.length });
    } catch (error) { return failure(call, error instanceof Error ? error.message : 'EXECUTION_FAILED'); }
  };
  return {
    execute,
    observeDelivered(messages: readonly JunLuoToolAgentContinuationMessage[]) {
      delivered.clear();
      for (const message of messages) {
        if (message.kind !== 'tool_result') continue;
        const page = pages.get(message.callId); if (!page) continue;
        try {
          const receipt = JSON.parse(message.content);
          const data = message.toolId === 'system.use_package' ? receipt.expenseQueryResult?.data : receipt.data;
          if (!data || receipt.dataOmitted || JSON.stringify(data.entries) !== JSON.stringify(page.visible)) continue;
          page.entries.forEach((entry, item) => delivered.set(item, entry));
        } catch { /* An omitted or changed packet grants no items. */ }
      }
    },
    card(results: readonly JunLuoToolResult[]): ChatExpensePlanCard | undefined {
      const rows = results.filter(result => result.ok).flatMap(result => proposals.get(result.callId) ?? []);
      if (!rows.length || !input.source || input.remainingRequests() < 1) return undefined;
      return createExpensePlanCard(input.source, rows, Math.min(1, input.remainingRequests()));
    },
  };
}

