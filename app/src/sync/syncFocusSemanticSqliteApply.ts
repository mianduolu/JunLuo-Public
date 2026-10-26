import type * as SQLite from 'expo-sqlite';

import type {
  FocusSemanticBusinessPort,
} from './syncFocusSemanticApply';
import {
  assertFocusSemanticRecord,
  type FocusSemanticRecordKind,
} from './syncFocusSemantic';
import type { JsonValue } from './syncProtocol';

type SqlTransaction = Pick<SQLite.SQLiteDatabase, 'runAsync'>;
type FocusRecord = JsonValue & Record<string, JsonValue>;

function localId(kind: FocusSemanticRecordKind, entityId: string) {
  const prefixes: Partial<Record<FocusSemanticRecordKind, string>> = {
    'focus-session': 'focus-session:',
    'focus-log': 'focus-log:',
  };
  const prefix = prefixes[kind];
  if (!prefix || !entityId.startsWith(prefix)) {
    throw new Error(`focus.semantic ${kind} entity id 无效。`);
  }
  const value = entityId.slice(prefix.length);
  if (!value) throw new Error(`focus.semantic ${kind} local id 为空。`);
  return value;
}

async function writeFocusSession(
  transaction: SqlTransaction,
  record: FocusRecord,
) {
  await transaction.runAsync(
    `INSERT INTO focus_sessions (
       id, mode, user_activity, baiyun_activity, started_at, ended_at,
       duration_seconds, quality, heart_rate_avg, temperature_avg, created_at, review_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mode = excluded.mode,
       user_activity = excluded.user_activity,
       baiyun_activity = excluded.baiyun_activity,
       started_at = excluded.started_at,
       ended_at = excluded.ended_at,
       duration_seconds = excluded.duration_seconds,
       quality = excluded.quality,
       heart_rate_avg = excluded.heart_rate_avg,
       temperature_avg = excluded.temperature_avg,
       created_at = excluded.created_at,
       review_json = COALESCE(excluded.review_json, focus_sessions.review_json)`,
    record.id as string,
    record.mode as string,
    record.userActivity as string,
    record.baiyunActivity as string,
    record.startedAt as number,
    record.endedAt as number,
    record.durationSeconds as number,
    record.quality as string,
    record.heartRateAvg as number,
    record.temperatureAvg as number,
    record.createdAt as number,
    record.review == null ? null : JSON.stringify(record.review),
  );
}

async function writeFocusLog(
  transaction: SqlTransaction,
  record: FocusRecord,
) {
  await transaction.runAsync(
    `INSERT INTO focus_logs (
       id, session_id, role, content, created_at, elapsed_seconds, trigger
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       session_id = excluded.session_id,
       role = excluded.role,
       content = excluded.content,
       created_at = excluded.created_at,
       elapsed_seconds = excluded.elapsed_seconds,
       trigger = excluded.trigger`,
    record.id as string,
    record.sessionId as string,
    record.role as string,
    record.content as string,
    record.createdAt as number,
    record.elapsedSeconds as number,
    record.trigger as string,
  );
}

export async function applyFocusSemanticRecordToSqlite(input: {
  transaction: SqlTransaction;
  kind: 'focus-session' | 'focus-log';
  record: FocusRecord;
}) {
  assertFocusSemanticRecord(input.kind, input.record);
  if (input.kind === 'focus-session') {
    await writeFocusSession(input.transaction, input.record);
  } else {
    await writeFocusLog(input.transaction, input.record);
  }
}

export async function deleteFocusSemanticRecordFromSqlite(input: {
  transaction: SqlTransaction;
  kind: 'focus-session' | 'focus-log';
  entityId: string;
}) {
  if (input.kind === 'focus-session') {
    const sessionId = localId(input.kind, input.entityId);
    await input.transaction.runAsync(
      'DELETE FROM focus_logs WHERE session_id = ?',
      sessionId,
    );
    await input.transaction.runAsync(
      'DELETE FROM focus_sessions WHERE id = ?',
      sessionId,
    );
    return;
  }
  await input.transaction.runAsync(
    'DELETE FROM focus_logs WHERE id = ?',
    localId(input.kind, input.entityId),
  );
}

async function runSuppressed<T>(
  apply: (transaction: SQLite.SQLiteDatabase) => Promise<T>,
) {
  const { runWithFocusSemanticCaptureSuppressed } =
    await import('./syncFocusSemanticSqlitePort');
  return runWithFocusSemanticCaptureSuppressed(apply);
}

export const focusSemanticSqliteBusinessPort:
FocusSemanticBusinessPort = {
  upsertRecord: async (input) => {
    if (
      input.kind !== 'focus-session'
      && input.kind !== 'focus-log'
    ) {
      throw new Error(`focus SQLite 不处理 ${input.kind}。`);
    }
    const kind = input.kind;
    let youMessageAt: number | null = null;
    await runSuppressed(async (transaction) => {
      if (kind === 'focus-log' && input.record.role === 'you' && String(input.record.content).trim()) {
        const existing = await transaction.getFirstAsync<{ id: string }>(
          'SELECT id FROM focus_logs WHERE id = ?', input.record.id as string,
        );
        if (!existing) youMessageAt = input.record.createdAt as number;
      }
      await applyFocusSemanticRecordToSqlite({
        transaction,
        kind,
        record: input.record,
      });
    });
    if (youMessageAt !== null) {
      await (await import('../life/junluoDesireRuntime')).noteJunluoYouMessage(youMessageAt);
    }
  },
  deleteRecord: async (input) => {
    if (
      input.kind !== 'focus-session'
      && input.kind !== 'focus-log'
    ) {
      throw new Error(`focus SQLite 不处理 ${input.kind} tombstone。`);
    }
    const kind = input.kind;
    await runSuppressed(async (transaction) => {
      await deleteFocusSemanticRecordFromSqlite({
        transaction,
        kind,
        entityId: input.entityId,
      });
    });
  },
};
