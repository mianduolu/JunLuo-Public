import type { ExpenseDraft } from '../expense/expenseStore';
import {
  editExpensePlanRow, expensePlanExpectedResult, expensePlanRowSaveError,
  type ChatExpensePlanCard, type ExpensePlanMutationResult, type ExpensePlanRowInput,
  type ExpensePlanSaveResult, type ExpensePlanSource,
} from './chatExpensePlan';

export type ChatExpensePlanControllerPorts = {
  readCard(messageId: string): Promise<ChatExpensePlanCard | null>;
  /** Compare-and-patch the actual stored card, not a page snapshot. */
  patchCard(messageId: string, expectedRevision: number, card: ChatExpensePlanCard): Promise<ChatExpensePlanCard | null>;
  claimFeedback(messageId: string): Promise<ChatExpensePlanCard | null>;
  canSave(): boolean | Promise<boolean>;
  isSourceCurrent(source: ExpensePlanSource): boolean | Promise<boolean>;
  applyMutation(input: ExpensePlanRowInput & { executionAt: number; reconcileOnly?: boolean },
    guard: { messageId: string; revision: number; source: ExpensePlanSource }): Promise<ExpensePlanMutationResult>;
  /** The host sends one tools-disabled, no-retry request; this claim is never replayed. */
  onFeedback(messageId: string, results: ExpensePlanSaveResult[], source: ExpensePlanSource): Promise<void>;
};
export type ChatExpensePlanSaveOutcome = {
  rows: ExpensePlanSaveResult[];
  blocked?: 'missing' | 'restored' | 'permission' | 'source' | 'budget' | 'storage';
  feedback: 'not-needed' | 'sent' | 'failed';
};

const activeSaves = new Map<string, Promise<ChatExpensePlanSaveOutcome>>();
const pendingEdits = new Map<string, Promise<ChatExpensePlanCard | null>>();

/** Small domain controller. It owns no store and never starts work on mount/restart. */
export function createChatExpensePlanController(ports: ChatExpensePlanControllerPorts) {
  function edit(messageId: string, id: string, patch: Partial<ExpenseDraft> | null) {
    if (activeSaves.has(messageId)) return Promise.resolve(null);
    const update = patch ? { ...patch } : null;
    const previous = pendingEdits.get(messageId) ?? Promise.resolve(null);
    const task = previous.catch(() => null).then(async () => {
      const card = await ports.readCard(messageId);
      if (!card) return null;
      const next = editExpensePlanRow(card, id, update);
      return next ? ports.patchCard(messageId, card.revision, next) : null;
    }).finally(() => { if (pendingEdits.get(messageId) === task) pendingEdits.delete(messageId); });
    pendingEdits.set(messageId, task);
    return task;
  }

  async function runSave(messageId: string): Promise<ChatExpensePlanSaveOutcome> {
    let card = await ports.readCard(messageId);
    const outcome: ChatExpensePlanSaveOutcome = { rows: [], feedback: 'not-needed' };
    if (!card) return { ...outcome, blocked: 'missing' };
    if (card.status === 'restored') return { ...outcome, blocked: 'restored' };
    if (!card.feedback.claimed && card.feedback.remainingRequests <= 0) return { ...outcome, blocked: 'budget' };
    const ids = card.rows.map(row => row.id);
    for (const id of ids) {
      card = await ports.readCard(messageId);
      if (!card || card.status !== 'active') return { ...outcome, blocked: card ? 'restored' : 'missing' };
      const row = card.rows.find(item => item.id === id);
      if (!row || row.state === 'saved') continue;
      if (!await ports.canSave()) return { ...outcome, blocked: 'permission' };
      if (!await ports.isSourceCurrent(card.source)) return { ...outcome, blocked: 'source' };
      const reconcileOnly = row.state === 'saving' || row.state === 'unknown';
      const error = expensePlanRowSaveError(row);
      if (error && !reconcileOnly) {
        const next = { ...card, revision: card.revision + 1, rows: card.rows.map(item => item.id === id
          ? { ...item, state: 'failed' as const, code: error } : item) };
        if (!await ports.patchCard(messageId, card.revision, next)) return { ...outcome, blocked: 'storage' };
        continue;
      }
      const executionAt = row.executionAt ?? Math.max(Date.now(), (row.expected?.updatedAt ?? 0) + 1);
      if (!reconcileOnly) {
        const next: ChatExpensePlanCard = { ...card, revision: card.revision + 1,
          rows: card.rows.map(item => item.id === id ? { ...item, state: 'saving', executionAt,
            expectedResult: expensePlanExpectedResult(item, executionAt), code: undefined } : item) };
        card = await ports.patchCard(messageId, card.revision, next);
        if (!card) return { ...outcome, blocked: 'storage' };
      }
      // Permission and source can change while the durable execution marker is being written.
      if (!await ports.canSave()) return { ...outcome, blocked: 'permission' };
      if (!await ports.isSourceCurrent(card.source)) return { ...outcome, blocked: 'source' };
      const current = await ports.readCard(messageId);
      if (!current || current.status !== 'active' || current.revision !== card.revision) {
        return { ...outcome, blocked: current?.status === 'restored' ? 'restored' : 'storage' };
      }
      let result: ExpensePlanMutationResult;
      try {
        result = await ports.applyMutation({ action: row.action, id: row.id, draft: row.draft,
          expected: row.expected, originalExpected: row.originalExpected, executionAt, reconcileOnly },
          { messageId, revision: card.revision, source: card.source });
      } catch {
        result = { status: 'unknown', code: 'execution-interrupted' };
      }
      if (result.status === 'saved' && row.action !== 'delete' && (!result.entry || result.entry.id !== row.id)) {
        result = { status: 'unknown', code: 'saved-entry-missing' };
      }
      const next: ChatExpensePlanCard = { ...card, revision: card.revision + 1,
        rows: card.rows.map(item => item.id === id ? { ...item, state: result.status,
          code: result.code, result: result.entry } : item) };
      if (!await ports.patchCard(messageId, card.revision, next)) return { ...outcome, blocked: 'storage' };
    }
    card = await ports.readCard(messageId);
    if (!card || card.status !== 'active') return { ...outcome, blocked: card ? 'restored' : 'missing' };
    outcome.rows = card.rows.filter(row => ['saved', 'failed', 'conflict', 'unknown'].includes(row.state))
      .map(row => ({ id: row.id, action: row.action, status: row.state as ExpensePlanMutationResult['status'],
        entry: row.result, code: row.code }));
    if (!outcome.rows.length
      || card.rows.some(row => ['pending', 'saving'].includes(row.state))
      || card.feedback.claimed) return outcome;
    if (!await ports.canSave() || !await ports.isSourceCurrent(card.source)) return outcome;
    const claimed = await ports.claimFeedback(messageId);
    if (!claimed) return outcome;
    // After claim: cancellation/failure remains consumed. No automatic feedback recovery.
    try {
      if (!await ports.canSave() || !await ports.isSourceCurrent(claimed.source)) return outcome;
      const current = await ports.readCard(messageId);
      if (!current || current.status !== 'active' || current.revision !== claimed.revision) return outcome;
      await ports.onFeedback(messageId, outcome.rows, claimed.source);
      outcome.feedback = 'sent';
    } catch {
      outcome.feedback = 'failed';
    }
    return outcome;
  }

  function save(messageId: string) {
    const active = activeSaves.get(messageId);
    if (active) return active;
    const edits = pendingEdits.get(messageId) ?? Promise.resolve(null);
    const task = edits.then(() => runSave(messageId)).catch((): ChatExpensePlanSaveOutcome => ({ rows: [], feedback: 'not-needed', blocked: 'storage' }))
      .finally(() => { if (activeSaves.get(messageId) === task) activeSaves.delete(messageId); });
    activeSaves.set(messageId, task);
    return task;
  }
  return { edit, remove: (messageId: string, id: string) => edit(messageId, id, null), save };
}

