import type * as SQLite from 'expo-sqlite';
import { assertShiyingUuidV4, assertShiyingHash, assertShiyingLifeDate, canonicalJsonV1, parseShiyingCoverageReceiptV1,
  type ShiyingCoverageReceiptV1, type ShiyingEntryV1 } from './shiyingContract';
import { runShiyingDatabaseOperation, runShiyingTransaction } from './shiyingDatabase';
import { commitShiyingBackfillDayWithDatabase, notifyShiyingEntryChanges } from './shiyingStore';
import { parseShiyingBackfillPreviewV1, type ShiyingBackfillPreviewV1, type ShiyingBackfillDayV1 } from './shiyingBackfillPlan';
import type { ShiyingRunCandidateV1 } from './shiyingRunState';
import { hashShiyingJson } from './shiyingImageNoteContract';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';

export type ShiyingBackfillDayState = ShiyingBackfillDayV1 & { completed: boolean; entryIds: string[];
  receiptRowId: number; receipts: Array<{ id: string; payloadHash: string }> };
export type ShiyingBackfillTask = {
  id: string; status: 'paused' | 'running' | 'blocked' | 'completed'; revision: number;
  configurationHash: string; authorizedCalls: number; usedCalls: number;
  triggeredAt: number; tokenLimit: number;
  lastErrorCode: string | null; createdAt: number; updatedAt: number;
  notificationClaimed: boolean; days: ShiyingBackfillDayState[];
};
type TaskRow = { id: string; status: ShiyingBackfillTask['status']; revision: number; payload_json: string };
function fail(code: string): never { throw new Error(`shiying_backfill_${code}`); }
function validate(task: ShiyingBackfillTask) {
  const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
  assertShiyingUuidV4(task.id, 'backfill_task');
  if (!['paused', 'running', 'blocked', 'completed'].includes(task.status)
    || !integer(task.revision) || !integer(task.authorizedCalls) || !integer(task.usedCalls)
    || task.usedCalls > task.authorizedCalls || !integer(task.createdAt) || !integer(task.updatedAt)
    || task.updatedAt < task.createdAt || typeof task.notificationClaimed !== 'boolean'
    || task.lastErrorCode !== null && (typeof task.lastErrorCode !== 'string' || !/^[a-z0-9_]{1,120}$/u.test(task.lastErrorCode))
    || !Array.isArray(task.days) || task.days.length < 1 || task.days.length > 31) fail('stored_task_invalid');
  let previousDate = '';
  for (const day of task.days) {
    assertShiyingLifeDate(day.lifeDate, 'backfill_day');
    if (day.lifeDate <= previousDate || typeof day.completed !== 'boolean' || !integer(day.receiptRowId)
      || !Array.isArray(day.entryIds) || day.entryIds.length > 3 || new Set(day.entryIds).size !== day.entryIds.length
      || !Array.isArray(day.receipts) || new Set(day.receipts.map(receipt => receipt.id)).size !== day.receipts.length
      || day.completed && day.chunks.length || !day.completed && (day.entryIds.length || day.receipts.length)) fail('stored_task_invalid');
    day.entryIds.forEach(id => assertShiyingUuidV4(id, 'backfill_entry'));
    day.receipts.forEach(receipt => {
      if (!/^shiying-coverage-v1-[a-f0-9]{64}$/u.test(receipt.id)) fail('stored_receipt_invalid');
      assertShiyingHash(receipt.payloadHash, 'backfill_receipt_hash');
    });
    // Completed metadata still keeps its frozen boundary and business identity, not its text.
    parseShiyingBackfillPreviewV1({ triggeredAt: task.triggeredAt, tokenLimit: task.tokenLimit,
      configurationHash: task.configurationHash, totalCalls: day.chunks.length, blocked: false,
      days: [{ ...day, reason: day.completed ? (day.reason === 'no_chat' ? 'no_chat' : 'covered') : day.reason }] });
    previousDate = day.lifeDate;
  }
  if (task.status === 'completed' && task.days.some(day => !day.completed)) fail('stored_task_invalid');
}
export async function readShiyingBackfillTaskWithDatabase(database: SQLite.SQLiteDatabase): Promise<ShiyingBackfillTask | null> {
  const row = await database.getFirstAsync<TaskRow>('SELECT * FROM shiying_backfill_tasks LIMIT 1;');
  if (!row) return null;
  const task = JSON.parse(row.payload_json) as ShiyingBackfillTask;
  if (task.id !== row.id || task.status !== row.status || task.revision !== row.revision
    || !Array.isArray(task.days) || task.days.length < 1 || task.days.length > 31
    || !Number.isSafeInteger(task.usedCalls) || task.usedCalls < 0 || task.usedCalls > task.authorizedCalls) fail('stored_task_invalid');
  const chunks = await database.getAllAsync<{ life_date: string; chunk_index: number; payload_json: string }>(
    'SELECT * FROM shiying_backfill_chunks WHERE task_id=? ORDER BY life_date,chunk_index;', task.id);
  for (const day of task.days) day.chunks = chunks.filter(chunk => chunk.life_date === day.lifeDate)
    .map(chunk => JSON.parse(chunk.payload_json));
  if (chunks.some(chunk => !task.days.some(day => day.lifeDate === chunk.life_date))
    || chunks.some(chunk => JSON.parse(chunk.payload_json).chunkIndex !== chunk.chunk_index)) fail('stored_chunk_invalid');
  validate(task);
  // Reuse frozen plan validation for remaining days only; completed days no longer contain text.
  parseShiyingBackfillPreviewV1({ triggeredAt: task.triggeredAt, tokenLimit: task.tokenLimit,
    configurationHash: task.configurationHash, blocked: false,
    days: task.days.filter(day => !day.completed),
    totalCalls: task.days.filter(day => !day.completed).reduce((sum, day) => sum + day.chunks.length, 0) });
  return task;
}
export async function writeShiyingBackfillTaskWithDatabase(database: SQLite.SQLiteDatabase, task: ShiyingBackfillTask) {
  validate(task);
  const payload = { ...task, days: task.days.map(({ chunks: _chunks, ...day }) => day) };
  await database.runAsync(
    `UPDATE shiying_backfill_tasks SET status=?,revision=?,payload_json=?,updated_at=? WHERE id=?;`,
    task.status, task.revision, canonicalJsonV1(payload), task.updatedAt, task.id);
  await database.runAsync('DELETE FROM shiying_backfill_chunks WHERE task_id=?;', task.id);
  for (const day of task.days) for (const chunk of day.chunks) await database.runAsync(
    'INSERT INTO shiying_backfill_chunks(task_id,life_date,chunk_index,payload_json) VALUES(?,?,?,?);',
    task.id, day.lifeDate, chunk.chunkIndex, canonicalJsonV1(chunk));
  return task;
}
const read = readShiyingBackfillTaskWithDatabase;
const write = writeShiyingBackfillTaskWithDatabase;
export const getShiyingBackfillTask = () => runShiyingDatabaseOperation(read);
export async function getShiyingBackfillReservedLifeDates() {
  const task = await getShiyingBackfillTask();
  return task?.status !== 'completed' ? task?.days.filter(day => !day.completed).map(day => day.lifeDate) ?? [] : [];
}
export async function createShiyingBackfillTask(preview: ShiyingBackfillPreviewV1, id: string, now: number) {
  preview = parseShiyingBackfillPreviewV1(preview);
  assertShiyingUuidV4(id, 'backfill_task');
  if (preview.blocked) fail('capacity_blocked');
  return runShiyingTransaction(async database => {
    if (await read(database)) fail('task_already_exists');
    if (await database.getFirstAsync('SELECT batch_id FROM shiying_runs LIMIT 1;')) fail('live_run_unfinished');
    const task: ShiyingBackfillTask = {
      id, status: 'paused', revision: 0, configurationHash: preview.configurationHash,
      authorizedCalls: preview.totalCalls, usedCalls: 0, lastErrorCode: null,
      triggeredAt: preview.triggeredAt, tokenLimit: preview.tokenLimit,
      createdAt: now, updatedAt: now, notificationClaimed: false,
      days: preview.days.map(day => ({ ...day, completed: day.reason !== 'ready', entryIds: [], receiptRowId: 0, receipts: [] })),
    };
    await database.runAsync(
      'INSERT INTO shiying_backfill_tasks(id,status,revision,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?);',
      task.id, task.status, 0, '{}', now, now);
    return write(database, task);
  });
}
export function changeShiyingBackfillTask(id: string, revision: number,
  change: (task: ShiyingBackfillTask) => void, at = Date.now()) {
  return runShiyingTransaction(async database => {
    const task = await read(database);
    if (!task || task.id !== id || task.revision !== revision) fail('task_conflict');
    change(task); task.revision++; task.updatedAt = Math.max(task.updatedAt, at);
    return write(database, task);
  });
}
export type ShiyingBackfillChunkSave = {
  taskId: string; lifeDate: string; chunkIndex: number; chunkId: string;
  attemptCount: number; startedAt: number; completedAt: number; candidates: ShiyingRunCandidateV1[];
};
export function saveShiyingBackfillChunk(input: ShiyingBackfillChunkSave) {
  return runShiyingTransaction(async database => {
    const task = await read(database), day = task?.days.find(day => day.lifeDate === input.lifeDate);
    const chunk = day?.chunks[input.chunkIndex];
    if (!task || task.id !== input.taskId || !chunk || chunk.chunkId !== input.chunkId
      || chunk.attemptCount !== input.attemptCount || chunk.startedAt !== input.startedAt) fail('attempt_conflict');
    if (chunk.status === 'completed') {
      if (chunk.completedAt !== input.completedAt || canonicalJsonV1(chunk.candidates) !== canonicalJsonV1(input.candidates)) fail('result_conflict');
      return task;
    }
    if (chunk.status !== 'in_flight') fail('attempt_conflict');
    chunk.status = 'completed'; chunk.candidates = input.candidates;
    chunk.completedAt = input.completedAt; chunk.lastErrorCode = null;
    task.revision++; task.updatedAt = Math.max(task.updatedAt, input.completedAt);
    return write(database, task);
  });
}
export type ShiyingBackfillDayCommit = { taskId: string; lifeDate: string;
  coverages: ShiyingCoverageReceiptV1[]; entries: ShiyingEntryV1[]; at: number };
export async function commitShiyingBackfillDay(input: ShiyingBackfillDayCommit) {
  const result = await runShiyingTransaction(async database => {
    const task = await read(database), day = task?.days.find(day => day.lifeDate === input.lifeDate);
    if (!task || task.id !== input.taskId || !day || !day.batchId) fail('task_conflict');
    // A completed day retains only identities; exact replay never restores its materials.
    if (!day.completed) {
      if (day.chunks.some(chunk => chunk.status !== 'completed')
        || input.coverages.length !== day.chunks.filter(chunk => chunk.attemptCount > 0).length) fail('day_incomplete');
      for (const raw of input.coverages) {
        const receipt = parseShiyingCoverageReceiptV1(raw), chunk = day.chunks.find(item => item.chunkId === receipt.chunkId);
        if (!chunk || chunk.inputHash !== receipt.inputHash || chunk.completedAt !== receipt.completedAt
          || receipt.chunkIndex !== chunk.chunkIndex) fail('day_receipt_mismatch');
      }
    } else if (canonicalJsonV1(day.entryIds) !== canonicalJsonV1(input.entries.map(entry => entry.id))
      || canonicalJsonV1(day.receipts) !== canonicalJsonV1(input.coverages.map(receipt => ({
        id: receipt.id, payloadHash: hashShiyingJson(parseShiyingCoverageReceiptV1(receipt)),
      })))) fail('day_replay_conflict');
    if (!input.coverages.length && input.entries.length) fail('day_receipt_mismatch');
    const entries = input.coverages.length ? await commitShiyingBackfillDayWithDatabase(database, {
      batchId: day.batchId, lifeDate: day.lifeDate, coverages: input.coverages, entries: input.entries,
    }) : [];
    day.completed = true; day.entryIds = entries.map(entry => entry.id); day.chunks = [];
    day.receipts = input.coverages.map(receipt => ({ id: receipt.id, payloadHash: hashShiyingJson(receipt) }));
    day.receiptRowId = (await database.getFirstAsync<{ rowId: number }>(
      'SELECT COALESCE(MAX(rowid),0) AS rowId FROM shiying_coverage_receipts WHERE batch_id=?;', day.batchId))?.rowId ?? 0;
    task.revision++; task.updatedAt = Math.max(task.updatedAt, input.at);
    if (task.days.every(day => day.completed)) task.status = 'completed';
    await write(database, task);
    return { task, entries };
  });
  notifyShiyingEntryChanges(); return result;
}
export function deleteShiyingBackfillTask(id: string, expectedEpoch?: number) {
  return runShiyingTransaction(async database => {
    if (expectedEpoch !== undefined && !canCommitBackupRestoreDataEpoch(expectedEpoch)) return;
    await database.runAsync('DELETE FROM shiying_backfill_tasks WHERE id=?;', id);
  });
}
/** Claimed before crossing the OS boundary; a failed/unknown notification is not retried. */
export function claimShiyingBackfillCompletion(id: string, expectedEpoch?: number) {
  return runShiyingTransaction(async database => {
    const task = await read(database);
    if (!task || task.id !== id || task.status !== 'completed' || task.notificationClaimed
      || expectedEpoch !== undefined && !canCommitBackupRestoreDataEpoch(expectedEpoch)) return null;
    task.notificationClaimed = true; task.revision++;
    await write(database, task);
    const row = await database.getFirstAsync<{ rowId: number }>(
      `SELECT COALESCE(MAX(rowid),0) AS rowId FROM shiying_coverage_receipts
       WHERE batch_id IN (${task.days.map(() => '?').join(',')});`, ...task.days.map(day => day.batchId ?? ''));
    return { task, receiptRowId: row?.rowId ?? 0 };
  });
}
