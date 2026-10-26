import type * as SQLite from 'expo-sqlite';

import type {
  ExpenseLedgerBusinessPort,
} from './syncExpenseLedgerApply';
import {
  assertExpenseLedgerRecord,
  expenseLedgerLocalId,
  type ExpenseLedgerRecord,
} from './syncExpenseLedger';

type SqlTransaction = Pick<SQLite.SQLiteDatabase, 'runAsync'>;

export async function applyExpenseLedgerRecordToSqlite(input: {
  transaction: SqlTransaction;
  entityId: string;
  record: ExpenseLedgerRecord;
}) {
  assertExpenseLedgerRecord(input.entityId, input.record);
  const result = await input.transaction.runAsync(
    `INSERT INTO expense_entries (
       id, type, amount, category, note, occurred_at,
       source, created_at, updated_at, original_expense_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       amount = excluded.amount,
       category = excluded.category,
       note = excluded.note,
       occurred_at = excluded.occurred_at,
       source = excluded.source,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       original_expense_id = excluded.original_expense_id
     WHERE expense_entries.type IS NOT excluded.type
       OR expense_entries.amount IS NOT excluded.amount
       OR expense_entries.category IS NOT excluded.category
       OR expense_entries.note IS NOT excluded.note
       OR expense_entries.occurred_at IS NOT excluded.occurred_at
       OR expense_entries.source IS NOT excluded.source
       OR expense_entries.created_at IS NOT excluded.created_at
       OR expense_entries.updated_at IS NOT excluded.updated_at
       OR expense_entries.original_expense_id IS NOT excluded.original_expense_id`,
    input.record.id,
    input.record.type,
    input.record.amount,
    input.record.category,
    input.record.note,
    input.record.occurredAt,
    input.record.source,
    input.record.createdAt,
    input.record.updatedAt,
    input.record.originalExpenseId ?? null,
  );
  return result.changes;
}

export async function deleteExpenseLedgerRecordFromSqlite(input: {
  transaction: SqlTransaction;
  entityId: string;
}) {
  const result = await input.transaction.runAsync(
    'DELETE FROM expense_entries WHERE id = ?',
    expenseLedgerLocalId(input.entityId),
  );
  return result.changes;
}

async function runSuppressed<T>(
  apply: (transaction: SQLite.SQLiteDatabase) => Promise<T>,
) {
  const { runWithExpenseLedgerCaptureSuppressed } =
    await import('./syncExpenseLedgerSqlitePort');
  return runWithExpenseLedgerCaptureSuppressed(apply);
}

export const expenseLedgerSqliteBusinessPort:
ExpenseLedgerBusinessPort = {
  upsertRecord: async (input) => {
    let changed = false;
    await runSuppressed(async (transaction) => {
      const previous = await transaction.getFirstAsync<{ original_expense_id: string | null }>(
        'SELECT original_expense_id FROM expense_entries WHERE id = ?', input.record.id,
      );
      changed = await applyExpenseLedgerRecordToSqlite({
        transaction,
        entityId: input.entityId,
        record: input.record,
      }) > 0;
      const { reconcileExpenseRefundRelations } = await import('../expense/expenseStore');
      await reconcileExpenseRefundRelations(transaction, {
        originalIds: [input.record.id, input.record.originalExpenseId, previous?.original_expense_id].filter((id): id is string => Boolean(id)),
        revisionId: input.revision.revisionId,
        payload: { schemaVersion: input.revision.schemaVersion, kind: 'expense-entry', record: input.record },
        now: input.revision.createdAt,
      });
    });
    if (changed) {
      const { notifyExpenseLedgerChanged } = await import('../expense/expenseStore');
      notifyExpenseLedgerChanged();
    }
  },
  deleteRecord: async (input) => {
    let changed = false;
    await runSuppressed(async (transaction) => {
      const localId = expenseLedgerLocalId(input.entityId);
      const previous = await transaction.getFirstAsync<{ original_expense_id: string | null }>(
        'SELECT original_expense_id FROM expense_entries WHERE id = ?', localId,
      );
      changed = await deleteExpenseLedgerRecordFromSqlite({
        transaction,
        entityId: input.entityId,
      }) > 0;
      const { reconcileExpenseRefundRelations } = await import('../expense/expenseStore');
      await reconcileExpenseRefundRelations(transaction, {
        originalIds: [localId, previous?.original_expense_id].filter((id): id is string => Boolean(id)), deletedOriginalId: localId,
        revisionId: input.revision.revisionId,
        payload: { schemaVersion: input.revision.schemaVersion, kind: 'expense-entry', deletedAt: input.deletedAt }, now: input.revision.createdAt,
      });
    });
    if (changed) {
      const { notifyExpenseLedgerChanged } = await import('../expense/expenseStore');
      notifyExpenseLedgerChanged();
    }
  },
};
