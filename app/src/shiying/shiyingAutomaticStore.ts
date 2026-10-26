import type * as SQLite from 'expo-sqlite';
import { assertShiyingDeterministicId, assertShiyingLifeDate } from './shiyingContract';
import { runShiyingDatabaseOperation, runShiyingTransaction } from './shiyingDatabase';
import { getShiyingLifeDate, getShiyingLifeDateStartAt } from './shiyingWindow';
import { SHIYING_AUTOMATIC_CALL_LIMIT, type ShiyingAutomaticState } from './shiyingAutomaticPolicy';

export type { ShiyingAutomaticState } from './shiyingAutomaticPolicy';
type Database = Pick<SQLite.SQLiteDatabase, 'getFirstAsync' | 'runAsync'>;
type Row = {
  id: number; enabled: number; first_enabled_life_date: string | null; scan_floor_at: number | null;
  night_life_date: string | null; reserved_calls: number; closed: number; batch_id: string | null;
  last_error_code: string | null; updated_at: number;
};
type BatchInput = { batchId: string; nightLifeDate: string; at: number };
const listeners = new Set<() => void>();

function fail(code: string): never { throw new Error(`shiying_automatic_${code}`); }
function time(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) fail('time_invalid');
}
function errorCode(value: string) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/u.test(value)) fail('error_code_invalid');
}
function validate(state: ShiyingAutomaticState) {
  if (typeof state.enabled !== 'boolean' || typeof state.closed !== 'boolean') fail('boolean_invalid');
  time(state.updatedAt);
  if (state.firstEnabledLifeDate !== null) assertShiyingLifeDate(state.firstEnabledLifeDate);
  if (state.scanFloorAt !== null) time(state.scanFloorAt);
  if ((state.firstEnabledLifeDate === null) !== (state.scanFloorAt === null)
    || state.enabled && state.firstEnabledLifeDate === null) fail('anchor_invalid');
  if (!Number.isSafeInteger(state.reservedCalls) || state.reservedCalls < 0
    || state.reservedCalls > SHIYING_AUTOMATIC_CALL_LIMIT) fail('calls_invalid');
  if (state.nightLifeDate !== null) {
    assertShiyingLifeDate(state.nightLifeDate);
    if (state.firstEnabledLifeDate === null || state.nightLifeDate < state.firstEnabledLifeDate) fail('night_invalid');
  } else if (state.reservedCalls !== 0 || state.closed || state.batchId !== null || state.lastErrorCode !== null) {
    fail('night_missing');
  }
  if (state.batchId !== null) assertShiyingDeterministicId(state.batchId, 'batch');
  if (state.lastErrorCode !== null) errorCode(state.lastErrorCode);
  return state;
}

export async function loadShiyingAutomaticStateInTransaction(db: Database): Promise<ShiyingAutomaticState> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM shiying_automatic_state WHERE id = 1;');
  if (!row || row.id !== 1 || ![0, 1].includes(row.enabled) || ![0, 1].includes(row.closed)) fail('state_invalid');
  return validate({
    enabled: row.enabled === 1, firstEnabledLifeDate: row.first_enabled_life_date,
    scanFloorAt: row.scan_floor_at, nightLifeDate: row.night_life_date, reservedCalls: row.reserved_calls,
    closed: row.closed === 1, batchId: row.batch_id, lastErrorCode: row.last_error_code, updatedAt: row.updated_at,
  });
}

async function save(db: Database, state: ShiyingAutomaticState) {
  validate(state);
  const result = await db.runAsync(`UPDATE shiying_automatic_state SET enabled = ?, first_enabled_life_date = ?,
    scan_floor_at = ?, night_life_date = ?, reserved_calls = ?, closed = ?, batch_id = ?, last_error_code = ?,
    updated_at = ? WHERE id = 1;`, state.enabled ? 1 : 0, state.firstEnabledLifeDate, state.scanFloorAt,
  state.nightLifeDate, state.reservedCalls, state.closed ? 1 : 0, state.batchId, state.lastErrorCode, state.updatedAt);
  if (result.changes !== 1) fail('state_missing');
  return state;
}

export function subscribeShiyingAutomaticState(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyShiyingAutomaticStateChanged() {
  for (const listener of listeners) {
    try { listener(); } catch { /* A subscription cannot undo a committed transaction. */ }
  }
}
export function loadShiyingAutomaticState(): Promise<ShiyingAutomaticState> {
  return runShiyingDatabaseOperation(loadShiyingAutomaticStateInTransaction);
}

export async function setShiyingAutomaticEnabled(enabled: boolean, now = Date.now()): Promise<ShiyingAutomaticState> {
  time(now);
  if (typeof enabled !== 'boolean') fail('boolean_invalid');
  let changed = false;
  const result = await runShiyingTransaction(async (db) => {
    const state = await loadShiyingAutomaticStateInTransaction(db);
    if (state.enabled === enabled) return state;
    changed = true;
    const firstEnabledLifeDate = state.firstEnabledLifeDate ?? (enabled ? getShiyingLifeDate(now) : null);
    return save(db, { ...state, enabled, firstEnabledLifeDate,
      scanFloorAt: state.scanFloorAt ?? (firstEnabledLifeDate ? getShiyingLifeDateStartAt(firstEnabledLifeDate) : null),
      updatedAt: Math.max(state.updatedAt, now) });
  });
  if (changed) notifyShiyingAutomaticStateChanged();
  return result;
}

export async function beginShiyingAutomaticNight(nightLifeDate: string, now: number): Promise<ShiyingAutomaticState> {
  assertShiyingLifeDate(nightLifeDate);
  time(now);
  let changed = false;
  const result = await runShiyingTransaction(async (db) => {
    const state = await loadShiyingAutomaticStateInTransaction(db);
    if (!state.enabled || state.firstEnabledLifeDate === null || nightLifeDate < state.firstEnabledLifeDate
      || state.nightLifeDate !== null && nightLifeDate <= state.nightLifeDate) return state;
    changed = true;
    // Preserve the error across nights, including failures before a run exists. The coordinator stops on it.
    return save(db, { ...state, nightLifeDate, reservedCalls: 0, closed: false,
      batchId: state.closed && state.lastErrorCode === null ? null : state.batchId,
      updatedAt: Math.max(state.updatedAt, now) });
  });
  if (changed) notifyShiyingAutomaticStateChanged();
  return result;
}

function batchInput(input: BatchInput) {
  assertShiyingDeterministicId(input.batchId, 'batch');
  assertShiyingLifeDate(input.nightLifeDate);
  time(input.at);
}
function canCall(state: ShiyingAutomaticState, input: BatchInput) {
  return state.enabled && state.nightLifeDate === input.nightLifeDate && !state.closed
    && state.reservedCalls < SHIYING_AUTOMATIC_CALL_LIMIT;
}
// These helpers only use their caller's transaction. The caller publishes after its commit succeeds.
export async function bindShiyingAutomaticBatchInTransaction(db: Database, input: BatchInput): Promise<boolean> {
  batchInput(input);
  const state = await loadShiyingAutomaticStateInTransaction(db);
  if (!canCall(state, input) || state.batchId !== null && state.batchId !== input.batchId) return false;
  if (state.batchId === input.batchId) return true;
  await save(db, { ...state, batchId: input.batchId, updatedAt: Math.max(state.updatedAt, input.at) });
  return true;
}
export async function reserveShiyingAutomaticCallInTransaction(db: Database, input: BatchInput): Promise<boolean> {
  batchInput(input);
  const state = await loadShiyingAutomaticStateInTransaction(db);
  if (!canCall(state, input) || state.batchId !== input.batchId) return false;
  await save(db, { ...state, reservedCalls: state.reservedCalls + 1, updatedAt: Math.max(state.updatedAt, input.at) });
  return true;
}
// Only the same transaction that restores a never-sent in-flight chunk to pending may release its reservation.
export async function releaseShiyingAutomaticCallBeforeRequestInTransaction(db: Database, input: BatchInput): Promise<void> {
  batchInput(input);
  const state = await loadShiyingAutomaticStateInTransaction(db);
  if (state.nightLifeDate !== input.nightLifeDate || state.batchId !== input.batchId || state.reservedCalls === 0) return;
  await save(db, { ...state, reservedCalls: state.reservedCalls - 1, updatedAt: Math.max(state.updatedAt, input.at) });
}
export async function closeShiyingAutomaticBatchInTransaction(db: Database, input: { batchId: string; at: number }): Promise<void> {
  assertShiyingDeterministicId(input.batchId, 'batch');
  time(input.at);
  const state = await loadShiyingAutomaticStateInTransaction(db);
  if (state.batchId !== input.batchId || state.closed && state.lastErrorCode === null) return;
  await save(db, { ...state, closed: true, lastErrorCode: null, updatedAt: Math.max(state.updatedAt, input.at) });
}

export async function blockShiyingAutomaticNight(nightLifeDate: string, code: string, at: number): Promise<void> {
  assertShiyingLifeDate(nightLifeDate);
  errorCode(code);
  time(at);
  let changed = false;
  await runShiyingTransaction(async (db) => {
    const state = await loadShiyingAutomaticStateInTransaction(db);
    if (state.nightLifeDate !== nightLifeDate) return;
    changed = true;
    await save(db, { ...state, closed: true, lastErrorCode: code, updatedAt: Math.max(state.updatedAt, at) });
  });
  if (changed) notifyShiyingAutomaticStateChanged();
}

// Only a successful, explicitly requested manual collection resolves a failure with no run to close.
export async function resolveShiyingAutomaticLocalBlock(at: number): Promise<void> {
  time(at);
  let changed = false;
  await runShiyingTransaction(async (db) => {
    const state = await loadShiyingAutomaticStateInTransaction(db);
    if (state.batchId !== null || state.lastErrorCode === null) return;
    changed = true;
    await save(db, { ...state, closed: true, lastErrorCode: null, updatedAt: Math.max(state.updatedAt, at) });
  });
  if (changed) notifyShiyingAutomaticStateChanged();
}
