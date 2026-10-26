import type { ExpenseDraft, ExpenseEntry } from '../expense/expenseStore';

export type ExpensePlanAction = 'create' | 'update' | 'delete' | 'refund';
export type ExpensePlanSource = {
  sessionId: string;
  messageId: string;
  contentRevision: string;
  createdAt: number;
};
export type ExpensePlanRowInput = {
  action: ExpensePlanAction;
  /** Real target ID, or host-preallocated ID for a new entry. Never a model-supplied ID. */
  id: string;
  draft?: ExpenseDraft;
  expected?: ExpenseEntry;
  originalExpected?: ExpenseEntry;
};
export type ExpensePlanRow = ExpensePlanRowInput & {
  state: 'pending' | 'saving' | 'saved' | 'conflict' | 'unknown' | 'failed';
  executionAt?: number;
  /** Persisted before execution, for exact read-only reconciliation after interruption. */
  expectedResult?: ExpenseEntry | null;
  result?: ExpenseEntry;
  code?: string;
};
export type ChatExpensePlanCard = {
  version: 1;
  revision: number;
  source: ExpensePlanSource;
  rows: ExpensePlanRow[];
  status: 'active' | 'restored';
  feedback: { remainingRequests: number; claimed: boolean };
};
export type ExpensePlanMutationResult = {
  status: 'saved' | 'conflict' | 'unknown' | 'failed';
  entry?: ExpenseEntry;
  code?: string;
};
export type ExpensePlanSaveResult = ExpensePlanMutationResult & { id: string; action: ExpensePlanAction };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function expensePlanSourceRevision(source: { content: string; createdAt: number }) {
  return JSON.stringify([source.createdAt, source.content]);
}

export function isExpensePlanSourceCurrent(source: ExpensePlanSource, message: {
  id: string; role: string; content: string; createdAt: number;
} | null | undefined, sessionId = source.sessionId) {
  return !!message && sessionId === source.sessionId && message.role === 'you'
    && message.id === source.messageId && message.createdAt === source.createdAt
    && expensePlanSourceRevision(message) === source.contentRevision;
}

function isDraft(value: unknown): value is ExpenseDraft {
  return record(value) && timestamp(value.amount) && typeof value.category === 'string'
    && typeof value.note === 'string' && timestamp(value.occurredAt)
    && (value.source === 'chat' || value.source === 'manual')
    && (value.type === 'expense' || value.type === 'income' || value.type === 'refund')
    && (value.originalExpenseId === undefined || value.originalExpenseId === null || text(value.originalExpenseId));
}

function isEntry(value: unknown): value is ExpenseEntry {
  if (!record(value) || !text(value.id) || !timestamp(value.createdAt) || !timestamp(value.updatedAt)) return false;
  return isDraft(value);
}

export function isChatExpensePlanCard(value: unknown): value is ChatExpensePlanCard {
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || (value.status !== 'active' && value.status !== 'restored') || !record(value.source)
    || !text(value.source.sessionId) || !text(value.source.messageId) || !text(value.source.contentRevision)
    || !timestamp(value.source.createdAt) || !record(value.feedback)
    || !Number.isSafeInteger(value.feedback.remainingRequests) || (value.feedback.remainingRequests as number) < 0
    || (value.feedback.remainingRequests as number) > 3 || typeof value.feedback.claimed !== 'boolean'
    || !Array.isArray(value.rows)) return false;
  const ids = new Set<string>();
  return value.rows.every(row => {
    if (!record(row) || !text(row.id) || ids.has(row.id)
      || !['create', 'update', 'delete', 'refund'].includes(row.action as string)
      || !['pending', 'saving', 'saved', 'conflict', 'unknown', 'failed'].includes(row.state as string)
      || (row.code !== undefined && typeof row.code !== 'string')
      || (row.draft !== undefined && !isDraft(row.draft))
      || (row.expected !== undefined && !isEntry(row.expected))
      || (row.originalExpected !== undefined && !isEntry(row.originalExpected))
      || (row.result !== undefined && (!isEntry(row.result) || row.result.id !== row.id))) return false;
    ids.add(row.id);
    // The guards above validate every present record. Explicit locals also work
    // in the project's isolated eval compiler where strictNullChecks is disabled.
    const draft = row.draft as ExpenseDraft | undefined;
    const expected = row.expected as ExpenseEntry | undefined;
    const originalExpected = row.originalExpected as ExpenseEntry | undefined;
    if ((row.action === 'update' || row.action === 'delete') && (!isEntry(expected) || expected.id !== row.id)) return false;
    if (row.action !== 'delete' && !isDraft(draft)) return false;
    if (row.action === 'refund' && draft?.type !== 'refund') return false;
    if (originalExpected && (!['refund', 'update'].includes(row.action as string) || draft?.originalExpenseId !== originalExpected.id)) return false;
    if (row.executionAt !== undefined && !timestamp(row.executionAt)) return false;
    if (row.expectedResult !== undefined && row.expectedResult !== null && (!isEntry(row.expectedResult) || row.expectedResult.id !== row.id)) return false;
    if (['saving', 'unknown', 'saved'].includes(row.state as string)
      && (!timestamp(row.executionAt) || row.expectedResult === undefined)) return false;
    if (row.expectedResult !== undefined && (row.action === 'delete'
      ? row.expectedResult !== null : row.expectedResult === null)) return false;
    return true;
  });
}

export function createExpensePlanCard(source: {
  sessionId: string; messageId: string; content: string; createdAt: number;
}, rows: ExpensePlanRowInput[], remaining: number): ChatExpensePlanCard {
  const card: ChatExpensePlanCard = {
    version: 1, revision: 0, status: 'active',
    source: { sessionId: source.sessionId, messageId: source.messageId,
      createdAt: source.createdAt, contentRevision: expensePlanSourceRevision(source) },
    rows: rows.map(row => ({ ...row, state: 'pending' })),
    feedback: { remainingRequests: remaining, claimed: false },
  };
  if (!isChatExpensePlanCard(card)) throw new Error('expense-plan-card-invalid');
  return JSON.parse(JSON.stringify(card)) as ChatExpensePlanCard;
}

export function appendExpensePlanRows(card: ChatExpensePlanCard, rows: ExpensePlanRowInput[]) {
  const next = { ...card, revision: card.revision + 1, rows: [...card.rows, ...rows.map(row => ({ ...row, state: 'pending' as const }))] };
  if (card.status !== 'active' || card.feedback.claimed || !isChatExpensePlanCard(next)) throw new Error('expense-plan-append-invalid');
  return next;
}

export function canEditExpensePlanRow(card: ChatExpensePlanCard, row: ExpensePlanRow) {
  return card.status === 'active' && !['saved', 'saving', 'unknown'].includes(row.state);
}

export function editExpensePlanRow(card: ChatExpensePlanCard, id: string, patch: Partial<ExpenseDraft> | null) {
  const row = card.rows.find(item => item.id === id);
  if (!row || !canEditExpensePlanRow(card, row)) return null;
  const rows = patch === null ? card.rows.filter(item => item.id !== id) : card.rows.map(item => item.id === id
    ? { ...item, draft: item.draft ? { ...item.draft, ...patch } : undefined, state: 'pending' as const,
      executionAt: undefined, expectedResult: undefined, code: undefined } : item);
  const next = { ...card, revision: card.revision + 1, rows };
  return isChatExpensePlanCard(next) ? next : null;
}

export function expensePlanRowSaveError(row: ExpensePlanRow) {
  if (row.action === 'delete') return null;
  const draft = row.draft;
  if (!draft || (!draft.category.length && draft.category !== row.expected?.category)) return 'category-required';
  const unchangedAmount = row.action === 'update' && draft.amount === row.expected?.amount;
  if (!unchangedAmount && !Number.isSafeInteger(Math.round(draft.amount * 100))) return 'amount-range';
  if (!unchangedAmount && Math.abs(Math.round(draft.amount * 100) - draft.amount * 100) > 0.000001) return 'amount-precision';
  if (draft.amount <= 0 && !(row.action === 'update' && row.expected?.amount === 0 && draft.amount === 0)) return 'amount-required';
  if (row.action === 'refund' && draft.type !== 'refund') return 'refund-type-required';
  if (draft.type === 'refund' && draft.originalExpenseId && row.originalExpected?.id !== draft.originalExpenseId) return 'refund-source-required';
  return null;
}

export function expensePlanExpectedResult(row: ExpensePlanRow, executionAt: number): ExpenseEntry | null {
  if (row.action === 'delete') return null;
  if (!row.draft) throw new Error('expense-plan-draft-missing');
  return { ...row.draft, amount: row.action === 'update' && row.draft.amount === row.expected?.amount
    ? row.draft.amount : Math.round(row.draft.amount * 100) / 100,
    originalExpenseId: row.draft.originalExpenseId ?? null,
    id: row.id, createdAt: row.expected?.createdAt ?? executionAt,
    updatedAt: Math.max(executionAt, (row.expected?.updatedAt ?? -1) + 1) };
}

export function invalidateRestoredExpensePlan(card: ChatExpensePlanCard): ChatExpensePlanCard {
  return { ...card, revision: card.revision + 1, status: 'restored',
    feedback: { remainingRequests: 0, claimed: true } };
}

/** Rewrite only existing chat encodings, including legacy session-embedded messages. */
export function restoreExpensePlanCardsInStorage(storage: Record<string, string>) {
  const next = { ...storage };
  const transform = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(transform);
    if (!record(value)) return value;
    const result = { ...value };
    if (isChatExpensePlanCard(result.expensePlanCard)) result.expensePlanCard = invalidateRestoredExpensePlan(result.expensePlanCard);
    if (Array.isArray(result.messages)) result.messages = result.messages.map(transform);
    return result;
  };
  for (const [key, raw] of Object.entries(storage)) {
    if (key !== 'junluo.chat.sessions' && key !== 'junluo.chat.primaryMessages' && !key.startsWith('junluo.chat.sessionMessages.')
      && !key.startsWith('junluo.chat.sessionMessage.')) continue;
    const parsed: unknown = JSON.parse(raw);
    next[key] = JSON.stringify(transform(parsed));
  }
  return next;
}

export function expensePlanDateKey(at: number) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Strict local-calendar date; preserve the original clock, reject rollover dates. */
export function expensePlanDateTimestamp(dateKey: string, originalAt: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  const original = new Date(originalAt);
  const next = new Date(originalAt);
  next.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  next.setHours(original.getHours(), original.getMinutes(), original.getSeconds(), original.getMilliseconds());
  return expensePlanDateKey(next.getTime()) === dateKey ? next.getTime() : null;
}

