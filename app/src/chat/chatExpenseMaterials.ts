import type { ChatExpensePlanCard, ExpensePlanSaveResult } from './chatExpensePlan';
import { expensePlanDateKey } from './chatExpensePlan';
import type { JunLuoToolResult } from '../tools/toolTypes';

/** Historical tool facts, not a new call or a grant to edit old bills. */
export function expensePlanHistoryMaterial(card: ChatExpensePlanCard) {
  const entries: Record<string, unknown>[] = [];
  for (const row of card.rows) {
    const value = row.state === 'saved' ? row.result ?? (row.action === 'delete' ? row.expected : undefined) : row.draft ?? row.expected;
    const entry = { action: row.action, status: row.state,
      ...(value ? { type: value.type, amount: value.amount, date: expensePlanDateKey(value.occurredAt),
        category: value.category, note: value.note.slice(0, 180) } : {}),
      ...(row.code ? { code: row.code } : {}) };
    if (JSON.stringify({ expensePlanCard: { status: card.status, entries: [...entries, entry] } }).length > 4000) break;
    entries.push(entry);
  }
  return JSON.stringify({ expensePlanCard: { status: card.status, entries,
    ...(entries.length < card.rows.length ? { entriesOmitted: true } : {}) } });
}

export function expensePlanSaveReceipts(messageId: string, results: ExpensePlanSaveResult[], card: ChatExpensePlanCard): JunLuoToolResult[] {
  return results.map((row, index) => {
    const entry = row.entry ?? card.rows.find(item => item.id === row.id)?.draft
      ?? card.rows.find(item => item.id === row.id)?.expected;
    const fields = entry ? { type: entry.type, amount: entry.amount, date: expensePlanDateKey(entry.occurredAt),
      category: entry.category, note: entry.note.slice(0, 80), ...(entry.note.length > 80 ? { noteTruncated: true } : {}) } : undefined;
    const data = { item: index + 1, action: row.action, status: row.status,
      ...(fields ? row.status === 'saved' ? { entry: fields } : { requested: fields } : {}),
      ...(row.code ? { code: row.code } : {}) };
    return { callId: `expense-save-${messageId}-${index}`, toolId: 'expense.save_plan',
      ok: row.status === 'saved', status: row.status === 'saved' ? 'success' : 'error',
      summary: JSON.stringify(data), data, startedAt: Date.now(), finishedAt: Date.now() };
  });
}

