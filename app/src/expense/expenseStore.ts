import * as SQLite from 'expo-sqlite';
import { openDatabaseImportSource, type DatabaseImportSource } from '../backup/sqliteBackupFiles';
import {
  EXPENSE_LEDGER_FULL_CAPTURE_SCHEMA_SQL,
  EXPENSE_LEDGER_RESET_TECHNICAL_STATE_SQL,
} from '../sync/syncExpenseLedgerSql';
import {
  WALLET_LEDGER_RESET_TECHNICAL_STATE_SQL,
} from '../sync/syncWalletLedgerSql';
import { applyExpenseLedgerRecordToSqlite } from '../sync/syncExpenseLedgerSqliteApply';

export type ExpenseEntryType = 'expense' | 'income' | 'refund';
export type ExpenseEntrySource = 'manual' | 'chat';

export type ExpenseEntry = {
  amount: number;
  category: string;
  createdAt: number;
  id: string;
  note: string;
  occurredAt: number;
  source: ExpenseEntrySource;
  type: ExpenseEntryType;
  updatedAt: number;
  originalExpenseId?: string | null;
};

export type ExpenseDraft = Omit<ExpenseEntry, 'createdAt' | 'id' | 'updatedAt'>;

type ExpenseRow = {
  amount: number;
  category: string;
  created_at: number;
  id: string;
  note: string;
  occurred_at: number;
  source: ExpenseEntrySource;
  type: ExpenseEntryType;
  updated_at: number;
  original_expense_id?: string | null;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;
let expenseLedgerRevision = 0;
export function getExpenseLedgerRevision() { return expenseLedgerRevision; }
export function notifyExpenseLedgerChanged() { expenseLedgerRevision += 1; }

function makeId() {
  return `expense-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function fromRow(row: ExpenseRow): ExpenseEntry {
  return {
    amount: row.amount,
    category: row.category,
    createdAt: row.created_at,
    id: row.id,
    note: row.note,
    occurredAt: row.occurred_at,
    source: row.source,
    type: row.type,
    updatedAt: row.updated_at,
    originalExpenseId: row.original_expense_id ?? null,
  };
}

async function getDatabase() {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync('junluo-expense.db').then(async (database) => {
      try {
        await migrateExpenseDatabase(database);
        return database;
      } catch (error) {
        await database.closeAsync().catch(() => undefined);
        throw error;
      }
    }).catch((error: unknown) => {
      databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise;
}

export async function migrateExpenseDatabase(database: SQLite.SQLiteDatabase) {
  await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(`
        CREATE TABLE IF NOT EXISTS expense_entries (
          id TEXT PRIMARY KEY NOT NULL,
          type TEXT NOT NULL DEFAULT 'expense',
          amount REAL NOT NULL,
          category TEXT NOT NULL DEFAULT '其他',
          note TEXT NOT NULL DEFAULT '',
          occurred_at INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'manual',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          original_expense_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_expense_occurred_at
          ON expense_entries(occurred_at DESC);
      `);
      const columns = await transaction.getAllAsync<{ name: string }>(
        'PRAGMA table_info(expense_entries)',
      );
      if (!columns.some((column) => column.name === 'original_expense_id')) {
        await transaction.execAsync('ALTER TABLE expense_entries ADD COLUMN original_expense_id TEXT');
      }
      const hasMetadata = await transaction.getFirstAsync<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'expense_sync_schema_meta'",
      );
      if (hasMetadata) {
        const metadata = await transaction.getFirstAsync<{
          storage_schema_version: number; capture_schema_version: number;
        }>('SELECT storage_schema_version, capture_schema_version FROM expense_sync_schema_meta WHERE singleton_id = 1');
        if ((metadata?.storage_schema_version ?? 0) > 2 || (metadata?.capture_schema_version ?? 0) > 2) {
          throw new Error('expense.ledger schema is newer than this application');
        }
      }
      await transaction.execAsync(EXPENSE_LEDGER_FULL_CAPTURE_SCHEMA_SQL);
      await transaction.execAsync('CREATE INDEX IF NOT EXISTS idx_expense_original ON expense_entries(original_expense_id)');
  });
}

export async function getExpenseDatabase() {
  return getDatabase();
}

export async function exportExpenseDatabase() {
  const database = await getDatabase();
  return database.serializeAsync();
}

export async function importExpenseDatabase(sourceFile: DatabaseImportSource) {
  if (databasePromise) {
    const openDatabase = await databasePromise;
    await openDatabase.closeAsync();
    databasePromise = undefined;
  }
  const source = await openDatabaseImportSource(sourceFile);
  const destination = await SQLite.openDatabaseAsync('junluo-expense.db');
  try {
    await SQLite.backupDatabaseAsync({ sourceDatabase: source, destDatabase: destination });
  } finally {
    await source.closeAsync();
    await destination.closeAsync();
  }
  databasePromise = undefined;
  const importedDatabase = await getDatabase();
  await importedDatabase.execAsync(EXPENSE_LEDGER_RESET_TECHNICAL_STATE_SQL);
  const { resetWalletSyncAfterExpenseDatabaseImport } =
    await import('./walletStore');
  await resetWalletSyncAfterExpenseDatabaseImport();
  notifyExpenseLedgerChanged();
}

export async function clearExpenseDatabase() {
  const { getWalletDatabase } = await import('./walletStore');
  const database = await getWalletDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.execAsync(`
      UPDATE expense_sync_runtime
      SET capture_enabled = 0, suppress_capture = 0;
      UPDATE wallet_sync_runtime
      SET capture_enabled = 0, suppress_capture = 0;
      DELETE FROM wallet_decision_reviews;
      DELETE FROM wallet_snapshots;
      DELETE FROM wallet_transactions;
      DELETE FROM wallet_holdings;
      DELETE FROM wallet_decisions;
      DELETE FROM wallet_preferences;
      DELETE FROM ai_wallets;
      DELETE FROM expense_entries;
      ${EXPENSE_LEDGER_RESET_TECHNICAL_STATE_SQL}
      ${WALLET_LEDGER_RESET_TECHNICAL_STATE_SQL}
    `);
  });
  notifyExpenseLedgerChanged();
}

export async function createExpenseEntry(draft: ExpenseDraft) {
  const result = await applyExpenseMutation({
    action: draft.type === 'refund' ? 'refund' : 'create',
    id: makeId(), draft, executionAt: Date.now(),
    originalExpected: draft.originalExpenseId
      ? await loadExpenseEntryById(draft.originalExpenseId) ?? undefined : undefined,
  });
  if (result.status !== 'saved' || !result.entry) throw new Error(result.code);
  return result.entry;
}

export async function deleteExpenseEntry(entryId: string) {
  const expected = await loadExpenseEntryById(entryId);
  const result = await applyExpenseMutation({
    action: 'delete', id: entryId, expected: expected ?? undefined, executionAt: Date.now(),
  });
  if (result.status !== 'saved') throw new Error(result.code);
}

export async function updateExpenseEntry(entryId: string, draft: ExpenseDraft) {
  const expected = await loadExpenseEntryById(entryId);
  const result = await applyExpenseMutation({
    action: 'update', id: entryId, draft, expected: expected ?? undefined, executionAt: Date.now(),
    originalExpected: draft.originalExpenseId
      ? await loadExpenseEntryById(draft.originalExpenseId) ?? undefined : undefined,
  });
  if (result.status !== 'saved') throw new Error(result.code);
}

export async function loadExpenseEntries(limit = 100) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<ExpenseRow>(
    'SELECT * FROM expense_entries ORDER BY occurred_at DESC, id DESC LIMIT ?',
    limit,
  );
  return rows.map(fromRow);
}

export async function loadExpenseEntriesBetween(startAt: number, endAt: number) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<ExpenseRow>(
    'SELECT * FROM expense_entries WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at DESC, id DESC',
    startAt,
    endAt,
  );
  return rows.map(fromRow);
}

type ExpenseSql = Pick<SQLite.SQLiteDatabase, 'getFirstAsync' | 'getAllAsync' | 'runAsync'>;

async function entryFromDatabase(database: ExpenseSql, id: string) {
  const row = await database.getFirstAsync<ExpenseRow>('SELECT * FROM expense_entries WHERE id = ?', id);
  return row ? fromRow(row) : null;
}

export async function loadExpenseEntryById(id: string) {
  return entryFromDatabase(await getDatabase(), id);
}

export type ExpenseLedgerCursor = { occurredAt: number; id: string };
export type ExpenseLedgerTotals = { income: number; expense: number; refund: number; netExpense: number };

export async function queryExpenseLedger(input: {
  startAt: number; endAt: number; category?: string;
  cursor?: ExpenseLedgerCursor; limit?: number;
}) {
  if (!Number.isSafeInteger(input.startAt) || !Number.isSafeInteger(input.endAt)
    || input.startAt < 0 || input.endAt < input.startAt) throw new Error('INVALID_RANGE');
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
  if (!Number.isFinite(limit)) throw new Error('INVALID_LIMIT');
  if (input.cursor && (!Number.isSafeInteger(input.cursor.occurredAt)
    || input.cursor.occurredAt < 0 || !input.cursor.id)) throw new Error('INVALID_CURSOR');
  const where = 'occurred_at >= ? AND occurred_at < ?'
    + (input.category !== undefined ? ' AND category = ?' : '');
  const parameters: (number | string)[] = [input.startAt, input.endAt];
  if (input.category !== undefined) parameters.push(input.category);
  const pageWhere = input.cursor
    ? where + ' AND (occurred_at < ? OR (occurred_at = ? AND id < ?))' : where;
  const pageParameters = input.cursor
    ? [...parameters, input.cursor.occurredAt, input.cursor.occurredAt, input.cursor.id, limit + 1]
    : [...parameters, limit + 1];
  const database = await getDatabase();
  let result!: {
    entries: ExpenseEntry[]; totals: ExpenseLedgerTotals;
    hasMore: boolean; nextCursor: ExpenseLedgerCursor | null; revision: number;
  };
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const revision = getExpenseLedgerRevision();
    const sums = await transaction.getFirstAsync<{ income: number; expense: number; refund: number }>(
      `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN ROUND(amount * 100) ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE WHEN type = 'expense' THEN ROUND(amount * 100) ELSE 0 END), 0) AS expense,
       COALESCE(SUM(CASE WHEN type = 'refund' THEN ROUND(amount * 100) ELSE 0 END), 0) AS refund
       FROM expense_entries WHERE ${where}`, ...parameters,
    );
    const rows = await transaction.getAllAsync<ExpenseRow>(
      `SELECT * FROM expense_entries WHERE ${pageWhere} ORDER BY occurred_at DESC, id DESC LIMIT ?`,
      ...pageParameters,
    );
    const entries = rows.slice(0, limit).map(fromRow);
    const last = entries.at(-1);
    const hasMore = rows.length > limit;
    result = { entries, hasMore, revision,
      nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null,
      totals: { income: (sums?.income ?? 0) / 100, expense: (sums?.expense ?? 0) / 100,
        refund: (sums?.refund ?? 0) / 100,
        netExpense: ((sums?.expense ?? 0) - (sums?.refund ?? 0)) / 100 },
    };
  });
  return result;
}

export type ExpenseMutationInput = {
  action: 'create' | 'update' | 'delete' | 'refund';
  id: string; draft?: ExpenseDraft; expected?: ExpenseEntry; originalExpected?: ExpenseEntry;
  executionAt: number; reconcileOnly?: boolean;
};
export type ExpenseMutationResult = {
  status: 'saved' | 'conflict' | 'unknown' | 'failed'; entry?: ExpenseEntry; code?: string;
};

function sameEntry(left: ExpenseEntry | null, right: ExpenseEntry | undefined) {
  return Boolean(left && right && left.id === right.id && left.type === right.type
    && left.amount === right.amount && left.category === right.category && left.note === right.note
    && left.source === right.source && left.occurredAt === right.occurredAt
    && left.createdAt === right.createdAt && left.updatedAt === right.updatedAt
    && (left.originalExpenseId ?? null) === (right.originalExpenseId ?? null));
}

function mutationEntry(input: ExpenseMutationInput): ExpenseEntry | null {
  if (input.action === 'delete') return null;
  const draft = input.draft;
  const unchangedAmount = input.action === 'update' && draft?.amount === input.expected?.amount;
  if (!draft || !Number.isFinite(draft.amount) || (!unchangedAmount && !Number.isSafeInteger(Math.round(draft.amount * 100)))
    || draft.amount < 0 || (Math.round(draft.amount * 100) <= 0
      && !(input.action === 'update' && input.expected?.amount === 0 && draft.amount === 0))
    || !Number.isSafeInteger(draft.occurredAt) || draft.occurredAt < 0
    || !['expense', 'income', 'refund'].includes(draft.type)
    || !['manual', 'chat'].includes(draft.source)
    || typeof draft.note !== 'string' || typeof draft.category !== 'string'
    || (input.action === 'refund' && draft.type !== 'refund')
    || (input.action === 'create' && draft.type === 'refund')
    || (draft.originalExpenseId != null && (draft.type !== 'refund'
      || typeof draft.originalExpenseId !== 'string' || !draft.originalExpenseId
      || draft.originalExpenseId === input.id))) throw new Error('INVALID_DRAFT');
  return { ...draft, id: input.id, amount: unchangedAmount ? draft.amount : Math.round(draft.amount * 100) / 100,
    category: draft.category, note: draft.note,
    originalExpenseId: draft.originalExpenseId ?? null,
    createdAt: input.action === 'update' ? input.expected!.createdAt : input.executionAt,
    updatedAt: input.action === 'update'
      ? Math.max(input.executionAt, input.expected!.updatedAt + 1) : input.executionAt };
}

async function reconcileMutation(database: ExpenseSql, input: ExpenseMutationInput, entry: ExpenseEntry | null): Promise<ExpenseMutationResult> {
  const current = await entryFromDatabase(database, input.id);
  if (entry && sameEntry(current, entry)) return { status: 'saved', entry: current!, code: 'ALREADY_SAVED' };
  if (current && !sameEntry(current, input.expected)) return { status: 'conflict', code: 'VERSION_CHANGED' };
  return { status: 'unknown', code: input.action === 'delete' && !current
    ? 'DELETE_UNVERIFIABLE' : 'NO_EXECUTION_EVIDENCE' };
}

async function validateRefundLimit(database: ExpenseSql, input: ExpenseMutationInput, entry: ExpenseEntry) {
  if (!entry.originalExpenseId) return null;
  const original = await entryFromDatabase(database, entry.originalExpenseId);
  if (!original) return 'ORIGINAL_MISSING';
  if (original.type !== 'expense') return 'ORIGINAL_NOT_EXPENSE';
  if (!sameEntry(original, input.originalExpected)) return 'ORIGINAL_VERSION_CHANGED';
  const total = await database.getFirstAsync<{ cents: number }>(
    "SELECT COALESCE(SUM(ROUND(amount * 100)), 0) AS cents FROM expense_entries WHERE type = 'refund' AND original_expense_id = ? AND id <> ?",
    entry.originalExpenseId, entry.id,
  );
  return (total?.cents ?? 0) + Math.round(entry.amount * 100) > Math.round(original.amount * 100)
    ? 'REFUND_LIMIT' : null;
}

export async function applyExpenseMutation(input: ExpenseMutationInput): Promise<ExpenseMutationResult> {
  if (!input.id || input.id.length > 220 || /[\r\n\0]/u.test(input.id)
    || !Number.isSafeInteger(input.executionAt) || input.executionAt < 0
    || !['create', 'update', 'delete', 'refund'].includes(input.action)) return { status: 'failed', code: 'INVALID_INPUT' };
  if ((input.action === 'update' || input.action === 'delete') && (!input.expected || input.expected.id !== input.id)) {
    return { status: 'conflict', code: 'EXPECTED_REQUIRED' };
  }
  let entry: ExpenseEntry | null;
  try { entry = mutationEntry(input); } catch { return { status: 'failed', code: 'INVALID_DRAFT' }; }
  let database: SQLite.SQLiteDatabase;
  try { database = await getDatabase(); } catch { return { status: 'failed', code: 'DATABASE_UNAVAILABLE' }; }
  if (input.reconcileOnly) {
    try { return await reconcileMutation(database, input, entry); }
    catch { return { status: 'unknown', code: 'READ_UNAVAILABLE' }; }
  }
  let wrote = false;
  let result: ExpenseMutationResult = { status: 'failed', code: 'NOT_APPLIED' };
  try {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const current = await entryFromDatabase(transaction, input.id);
      if (entry && sameEntry(current, entry)) { result = { status: 'saved', entry: current!, code: 'ALREADY_SAVED' }; return; }
      if (input.action === 'create' || input.action === 'refund') {
        if (current) { result = { status: 'conflict', code: 'ID_COLLISION' }; return; }
      } else if (!sameEntry(current, input.expected)) {
        result = { status: 'conflict', code: current ? 'VERSION_CHANGED' : 'TARGET_MISSING' }; return;
      }
      if (entry) {
        if (current && (current.type === 'refund') !== (entry.type === 'refund')) {
          result = { status: 'conflict', code: 'REFUND_TYPE_CHANGED' }; return;
        }
        if (input.action === 'update' && current?.type === 'refund'
          && (current.originalExpenseId ?? null) !== (entry.originalExpenseId ?? null)) {
          result = { status: 'conflict', code: 'REFUND_LINK_CHANGED' }; return;
        }
        const limitError = await validateRefundLimit(transaction, input, entry);
        if (limitError) { result = { status: 'conflict', code: limitError }; return; }
        const linked = await transaction.getFirstAsync<{ cents: number; count: number }>(
          "SELECT COALESCE(SUM(ROUND(amount * 100)), 0) AS cents, COUNT(*) AS count FROM expense_entries WHERE type = 'refund' AND original_expense_id = ?",
          entry.id,
        );
        if (linked?.count && (entry.type !== 'expense' || linked.cents > Math.round(entry.amount * 100))) {
          result = { status: 'conflict', code: 'LINKED_REFUNDS_CONFLICT' }; return;
        }
        wrote = true;
        await applyExpenseLedgerRecordToSqlite({ transaction, entityId: `expense-entry:${entry.id}`, record: entry });
      } else {
        wrote = true;
        await transaction.runAsync('DELETE FROM expense_entries WHERE id = ?', input.id);
      }
      await reconcileExpenseRefundRelations(transaction, {
        originalIds: [input.id, entry?.originalExpenseId ?? current?.originalExpenseId].filter((id): id is string => Boolean(id)),
        deletedOriginalId: input.action === 'delete' && current?.type === 'expense' ? current.id : undefined,
        revisionId: `local:${input.id}:${input.executionAt}`,
        payload: entry ?? { id: input.id, deletedAt: input.executionAt }, now: input.executionAt,
      });
      result = entry ? { status: 'saved', entry } : { status: 'saved' };
    });
    if (wrote && result.status === 'saved') notifyExpenseLedgerChanged();
    return result;
  } catch {
    if (!wrote) return { status: 'failed', code: 'SQLITE_WRITE_FAILED' };
    try {
      const verified = await reconcileMutation(database, input, entry);
      if (verified.status === 'saved') { notifyExpenseLedgerChanged(); return verified; }
    } catch { /* An uncertain write is never replayed here. */ }
    return { status: 'unknown', code: 'SQLITE_WRITE_UNCERTAIN' };
  }
}

// Relationship evidence stays in the existing conflict ledger; it is not a
// model-visible expense record and does not rewrite any incoming record.
async function missingRefundOriginalKind(originalId: string, hasDeletedEvidence: boolean) {
  const { loadSyncEntityHeadOperations } = await import('../sync/syncMutationStateStore');
  const operations = await loadSyncEntityHeadOperations({
    domain: 'expense', type: 'expense-entry', id: `expense-entry:${originalId}`,
  });
  if (operations.includes('delete') && operations.some((operation) => operation !== 'delete')) {
    return 'refund-original-invalid';
  }
  return hasDeletedEvidence || (operations.length > 0 && operations.every((operation) => operation === 'delete'))
    ? 'refund-original-deleted' : 'refund-original-missing';
}

export async function reconcileExpenseRefundRelations(database: ExpenseSql, input: {
  originalIds: string[]; deletedOriginalId?: string; revisionId: string; payload: unknown; now: number;
}) {
  for (const originalId of new Set(input.originalIds)) {
    const refunds = await database.getAllAsync<ExpenseRow>(
      "SELECT * FROM expense_entries WHERE type = 'refund' AND original_expense_id = ?", originalId,
    );
    const conflictId = `refund-relation:${originalId}`;
    const previous = await database.getFirstAsync<{ kind: string }>(
      'SELECT kind FROM expense_sync_conflicts WHERE conflict_id = ?', conflictId,
    );
    if (!refunds.length) {
      if (previous) await database.runAsync("UPDATE expense_sync_conflicts SET state = 'resolved', resolved_at = ? WHERE conflict_id = ?", input.now, conflictId);
      continue;
    }
    const original = await entryFromDatabase(database, originalId);
    const totalCents = refunds.reduce((total, refund) => total + Math.round(refund.amount * 100), 0);
    let kind: string | null = null;
    if (!original) {
      if (input.deletedOriginalId === originalId) {
        kind = 'refund-original-deleted';
      } else {
        kind = await missingRefundOriginalKind(originalId, previous?.kind === 'refund-original-deleted');
      }
    }
    else if (original.type !== 'expense') kind = 'refund-original-invalid';
    else if (totalCents > Math.round(original.amount * 100)) kind = 'refund-limit';
    if (!kind) {
      if (previous) await database.runAsync("UPDATE expense_sync_conflicts SET kind = 'refund-original-resolved', state = 'resolved', resolved_at = ? WHERE conflict_id = ?", input.now, conflictId);
      continue;
    }
    const resolved = kind === 'refund-original-deleted';
    await database.runAsync(
      `INSERT INTO expense_sync_conflicts (
        conflict_id, entity_type, entity_id, local_revision_id, incoming_revision_id,
        kind, local_payload_json, incoming_payload_json, state, created_at, resolved_at
       ) VALUES (?, 'expense-entry', ?, NULL, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conflict_id) DO UPDATE SET incoming_revision_id = excluded.incoming_revision_id,
       kind = excluded.kind, local_payload_json = excluded.local_payload_json,
       incoming_payload_json = excluded.incoming_payload_json, state = excluded.state, resolved_at = excluded.resolved_at`,
      conflictId, `expense-entry:${originalId}`, input.revisionId, kind,
      JSON.stringify({ original, refunds: refunds.map(fromRow) }), JSON.stringify(input.payload),
      resolved ? 'resolved' : 'pending', input.now, resolved ? input.now : null,
    );
  }
}

export async function loadExpenseRefundOriginalState(entry: ExpenseEntry): Promise<'unlinked' | 'available' | 'missing' | 'deleted' | 'inconsistent'> {
  if (!entry.originalExpenseId) return 'unlinked';
  const database = await getDatabase();
  const original = await entryFromDatabase(database, entry.originalExpenseId);
  const evidence = await database.getFirstAsync<{ kind: string }>(
    'SELECT kind FROM expense_sync_conflicts WHERE conflict_id = ?', `refund-relation:${entry.originalExpenseId}`,
  );
  if (original) return original.type === 'expense' && evidence?.kind !== 'refund-limit'
    ? 'available' : 'inconsistent';
  const kind = await missingRefundOriginalKind(entry.originalExpenseId, evidence?.kind === 'refund-original-deleted');
  return kind === 'refund-original-invalid' ? 'inconsistent'
    : kind === 'refund-original-deleted' ? 'deleted' : 'missing';
}
