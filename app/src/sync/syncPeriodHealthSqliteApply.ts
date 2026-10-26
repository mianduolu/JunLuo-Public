import type * as SQLite from 'expo-sqlite';

import type {
  PeriodHealthBusinessPort,
} from './syncPeriodHealthApply';
import {
  assertPeriodHealthRecord,
  periodHealthLocalId,
  type PeriodHealthRecord,
  type PeriodHealthRecordKind,
} from './syncPeriodHealth';

type SqlTransaction = Pick<
  SQLite.SQLiteDatabase,
  'runAsync' | 'getFirstAsync'
>;

async function applyEntry(
  transaction: SqlTransaction,
  record: Extract<PeriodHealthRecord, { startAt: number }>,
) {
  await transaction.runAsync(
    `INSERT INTO period_entries (
       id, start_at, end_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       start_at = excluded.start_at,
       end_at = excluded.end_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id,
    record.startAt,
    record.endAt,
    record.createdAt,
    record.updatedAt,
  );
}

async function applyDailyLog(
  transaction: SqlTransaction,
  record: Extract<PeriodHealthRecord, { bodyState: string }>,
) {
  await transaction.runAsync(
    `INSERT INTO period_daily_logs (
       id, date_key, period_id, body_state, flow, pain_level,
       symptoms, note, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       period_id = excluded.period_id,
       body_state = excluded.body_state,
       flow = excluded.flow,
       pain_level = excluded.pain_level,
       symptoms = excluded.symptoms,
       note = excluded.note,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id,
    record.dateKey,
    record.periodId,
    record.bodyState,
    record.flow,
    record.painLevel,
    JSON.stringify(record.symptoms),
    record.note,
    record.createdAt,
    record.updatedAt,
  );
}

async function applyReminderSettings(
  transaction: SqlTransaction,
  record: Extract<PeriodHealthRecord, { careFrequency: string }>,
) {
  await transaction.runAsync(
    `INSERT INTO period_reminder_settings (
       id, care_enabled, care_frequency, muted_date_key,
       updated_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       care_enabled = excluded.care_enabled,
       care_frequency = excluded.care_frequency,
       muted_date_key = excluded.muted_date_key,
       updated_at = excluded.updated_at`,
    record.id,
    record.careEnabled ? 1 : 0,
    record.careFrequency,
    record.mutedDateKey,
    record.updatedAt,
  );
}

export async function applyPeriodHealthRecordToSqlite(input: {
  transaction: SqlTransaction;
  kind: PeriodHealthRecordKind;
  entityId: string;
  record: PeriodHealthRecord;
}) {
  assertPeriodHealthRecord(input.kind, input.entityId, input.record);
  if (input.kind === 'period-entry') {
    await applyEntry(
      input.transaction,
      input.record as Extract<PeriodHealthRecord, { startAt: number }>,
    );
  } else if (input.kind === 'period-daily-log') {
    await applyDailyLog(
      input.transaction,
      input.record as Extract<PeriodHealthRecord, { bodyState: string }>,
    );
  } else if (input.kind === 'period-reminder-settings') {
    await applyReminderSettings(
      input.transaction,
      input.record as Extract<
        PeriodHealthRecord,
        { careFrequency: string }
      >,
    );
  }
}

export async function deletePeriodHealthRecordFromSqlite(input: {
  transaction: SqlTransaction;
  kind: PeriodHealthRecordKind;
  entityId: string;
}) {
  const localId = periodHealthLocalId(input.kind, input.entityId);
  if (input.kind === 'period-entry') {
    await input.transaction.runAsync(
      'DELETE FROM period_entries WHERE id = ?',
      localId,
    );
  } else if (input.kind === 'period-daily-log') {
    await input.transaction.runAsync(
      'DELETE FROM period_daily_logs WHERE id = ?',
      localId,
    );
  } else if (input.kind === 'period-reminder-settings') {
    await input.transaction.runAsync(
      'DELETE FROM period_reminder_settings WHERE id = ?',
      localId,
    );
  }
}

async function runSuppressed<T>(
  apply: (transaction: SQLite.SQLiteDatabase) => Promise<T>,
) {
  const { runWithPeriodHealthCaptureSuppressed } =
    await import('./syncPeriodHealthSqlitePort');
  return runWithPeriodHealthCaptureSuppressed(apply);
}

export const periodHealthSqliteBusinessPort:
PeriodHealthBusinessPort = {
  upsertRecord: async (input) => {
    await runSuppressed(async (transaction) => {
      await applyPeriodHealthRecordToSqlite({
        transaction,
        kind: input.kind,
        entityId: input.entityId,
        record: input.record,
      });
    });
  },
  deleteRecord: async (input) => {
    await runSuppressed(async (transaction) => {
      await deletePeriodHealthRecordFromSqlite({
        transaction,
        kind: input.kind,
        entityId: input.entityId,
      });
    });
  },
};
