import type * as SQLite from 'expo-sqlite';

import { canonicalizeJsonV1 } from './syncCrypto';
import {
  getCurrentDeviceDatabase,
} from './syncCurrentDevice';
import {
  enqueueSyncDatabaseOperation,
  runSyncDatabaseTransaction,
} from './syncDatabaseOperationQueue';
import {
  assertSyncExecutionClaimV1,
  assertSyncExecutionReceiptV1,
  assertSyncExecutionStartV1,
  type SyncExecutionClaimV1,
  type SyncExecutionReceiptV1,
  type SyncExecutionStartV1,
} from './syncExecutionLeaseProtocol';
import {
  assertSyncExecutionFenceRecordV1,
  type SyncExecutionFencePortV1,
  type SyncExecutionFenceRecordV1,
} from './syncExecutionOnceController';
import {
  assertSyncExecutionClaimV2,
  assertSyncExecutionCompleteRequestV2,
  type SyncExecutionClaimV2,
  type SyncExecutionCompleteRequestV2,
} from './syncExecutionClaimV2Protocol';
import {
  assertSyncExecutionFenceRecordV2,
  type SyncExecutionFencePortV2,
  type SyncExecutionFenceRecordV2,
} from './syncExecutionOnceV2Controller';

type ExecutionFenceRow = {
  operation_id: string;
  category: SyncExecutionFenceRecordV1['category'];
  claim_id: string;
  claim_json: string;
  start_json: string | null;
  receipt_json: string | null;
  state: SyncExecutionFenceRecordV1['state'];
  created_at: number;
  updated_at: number;
};

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function parseCanonicalJson<T>(
  source: string,
  label: string,
  assertValue: (value: unknown) => asserts value is T,
) {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON。`, { cause: error });
  }
  assertValue(value);
  if (canonicalizeJsonV1(value) !== source) {
    throw new Error(`${label} 不是正规 JSON。`);
  }
  return value;
}

function fenceRecordFromRow(
  row: ExecutionFenceRow,
): SyncExecutionFenceRecordV1 {
  const claim = parseCanonicalJson(
    row.claim_json,
    'execution fence claim',
    assertSyncExecutionClaimV1,
  );
  const start = row.start_json === null
    ? null
    : parseCanonicalJson(
      row.start_json,
      'execution fence start',
      assertSyncExecutionStartV1,
    );
  const receipt = row.receipt_json === null
    ? null
    : parseCanonicalJson(
      row.receipt_json,
      'execution fence receipt',
      assertSyncExecutionReceiptV1,
    );
  if (row.claim_id !== claim.claimId) {
    throw new Error('execution fence claimId 与 claim 正文不一致。');
  }
  const record: SyncExecutionFenceRecordV1 = {
    operationId: row.operation_id,
    category: row.category,
    claim,
    start,
    receipt,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  assertSyncExecutionFenceRecordV1(record);
  return record;
}

async function loadRow(
  database: SQLite.SQLiteDatabase,
  operationId: string,
) {
  return database.getFirstAsync<ExecutionFenceRow>(
    `SELECT operation_id, category, claim_id, claim_json,
            start_json, receipt_json, state, created_at, updated_at
     FROM sync_execution_fences
     WHERE operation_id = ?`,
    operationId,
  );
}

function sameSignedRecord(left: unknown, right: unknown) {
  return canonicalizeJsonV1(left) === canonicalizeJsonV1(right);
}

export class AndroidSyncExecutionFenceSqlitePort
implements SyncExecutionFencePortV1 {
  async load(operationId: string) {
    const database = await getCurrentDeviceDatabase();
    const row = await enqueueSyncDatabaseOperation(
      () => loadRow(database, operationId),
    );
    return row ? fenceRecordFromRow(row) : null;
  }

  async saveClaimed(input: {
    category: SyncExecutionFenceRecordV1['category'];
    claim: SyncExecutionClaimV1;
    updatedAt: number;
  }) {
    assertSyncExecutionClaimV1(input.claim);
    assertTimestamp(input.updatedAt, 'execution fence updatedAt');
    const database = await getCurrentDeviceDatabase();
    return runSyncDatabaseTransaction(database, async (transaction) => {
      const existingRow = await loadRow(
        transaction,
        input.claim.operationId,
      );
      if (!existingRow) {
        const claimJson = canonicalizeJsonV1(input.claim);
        await transaction.runAsync(
          `INSERT INTO sync_execution_fences (
             operation_id, category, claim_id, claim_json,
             start_json, receipt_json, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, NULL, 'claimed', ?, ?)`,
          input.claim.operationId,
          input.category,
          input.claim.claimId,
          claimJson,
          input.updatedAt,
          input.updatedAt,
        );
        return fenceRecordFromRow((await loadRow(
          transaction,
          input.claim.operationId,
        ))!);
      }
      const existing = fenceRecordFromRow(existingRow);
      if (
        existing.category !== input.category
        || input.updatedAt < existing.updatedAt
      ) {
        throw new Error('execution fence claim 发生领域冲突或时间回退。');
      }
      if (existing.state !== 'claimed') {
        if (!sameSignedRecord(existing.claim, input.claim)) {
          throw new Error('已开始的 execution fence 禁止更换 claim。');
        }
        return existing;
      }
      if (sameSignedRecord(existing.claim, input.claim)) return existing;
      await transaction.runAsync(
        `UPDATE sync_execution_fences
         SET claim_id = ?, claim_json = ?, updated_at = ?
         WHERE operation_id = ? AND state = 'claimed'`,
        input.claim.claimId,
        canonicalizeJsonV1(input.claim),
        input.updatedAt,
        input.claim.operationId,
      );
      return fenceRecordFromRow((await loadRow(
        transaction,
        input.claim.operationId,
      ))!);
    });
  }

  async saveStarted(input: {
    start: SyncExecutionStartV1;
    updatedAt: number;
  }) {
    assertSyncExecutionStartV1(input.start);
    assertTimestamp(input.updatedAt, 'execution fence updatedAt');
    const database = await getCurrentDeviceDatabase();
    return runSyncDatabaseTransaction(database, async (transaction) => {
      const row = await loadRow(transaction, input.start.operationId);
      if (!row) throw new Error('execution fence claim 不存在。');
      const current = fenceRecordFromRow(row);
      if (
        current.claim.claimId !== input.start.claimId
        || input.updatedAt < current.updatedAt
      ) {
        throw new Error('execution fence start 与 claim 不一致或时间回退。');
      }
      if (current.start) {
        if (!sameSignedRecord(current.start, input.start)) {
          throw new Error('execution fence 已对应另一份 start。');
        }
        return current;
      }
      if (current.state !== 'claimed') {
        throw new Error('execution fence 无法从当前状态开始。');
      }
      await transaction.runAsync(
        `UPDATE sync_execution_fences
         SET start_json = ?, state = 'started', updated_at = ?
         WHERE operation_id = ? AND state = 'claimed'`,
        canonicalizeJsonV1(input.start),
        input.updatedAt,
        input.start.operationId,
      );
      return fenceRecordFromRow((await loadRow(
        transaction,
        input.start.operationId,
      ))!);
    });
  }

  async saveCompletionPrepared(input: {
    receipt: SyncExecutionReceiptV1;
    updatedAt: number;
  }) {
    assertSyncExecutionReceiptV1(input.receipt);
    assertTimestamp(input.updatedAt, 'execution fence updatedAt');
    const database = await getCurrentDeviceDatabase();
    return runSyncDatabaseTransaction(database, async (transaction) => {
      const row = await loadRow(transaction, input.receipt.operationId);
      if (!row) throw new Error('execution fence start 不存在。');
      const current = fenceRecordFromRow(row);
      if (
        !current.start
        || current.claim.claimId !== input.receipt.claimId
        || input.updatedAt < current.updatedAt
      ) {
        throw new Error('execution receipt 与 start 不一致或时间回退。');
      }
      if (current.receipt) {
        if (!sameSignedRecord(current.receipt, input.receipt)) {
          throw new Error('execution fence 已对应另一份 receipt。');
        }
        return current;
      }
      if (current.state !== 'started') {
        throw new Error('execution fence 无法从当前状态准备回执。');
      }
      await transaction.runAsync(
        `UPDATE sync_execution_fences
         SET receipt_json = ?, state = 'completion-prepared',
             updated_at = ?
         WHERE operation_id = ? AND state = 'started'`,
        canonicalizeJsonV1(input.receipt),
        input.updatedAt,
        input.receipt.operationId,
      );
      return fenceRecordFromRow((await loadRow(
        transaction,
        input.receipt.operationId,
      ))!);
    });
  }

  async markCompleted(input: {
    receipt: SyncExecutionReceiptV1;
    updatedAt: number;
  }) {
    assertSyncExecutionReceiptV1(input.receipt);
    assertTimestamp(input.updatedAt, 'execution fence updatedAt');
    const database = await getCurrentDeviceDatabase();
    return runSyncDatabaseTransaction(database, async (transaction) => {
      const row = await loadRow(transaction, input.receipt.operationId);
      if (!row) throw new Error('execution fence receipt 不存在。');
      const current = fenceRecordFromRow(row);
      if (
        !current.receipt
        || !sameSignedRecord(current.receipt, input.receipt)
        || input.updatedAt < current.updatedAt
      ) {
        throw new Error('execution fence 完成回执不一致或时间回退。');
      }
      if (current.state === 'completed') return current;
      if (current.state !== 'completion-prepared') {
        throw new Error('execution fence 无法从当前状态完成。');
      }
      await transaction.runAsync(
        `UPDATE sync_execution_fences
         SET state = 'completed', updated_at = ?
         WHERE operation_id = ? AND state = 'completion-prepared'`,
        input.updatedAt,
        input.receipt.operationId,
      );
      return fenceRecordFromRow((await loadRow(
        transaction,
        input.receipt.operationId,
      ))!);
    });
  }
}

function isProtocolV2Json(source: string) {
  try {
    const value = JSON.parse(source) as { protocolVersion?: unknown };
    return value?.protocolVersion === 2;
  } catch {
    return false;
  }
}

function fenceRecordV2FromRow(
  row: ExecutionFenceRow,
): SyncExecutionFenceRecordV2 {
  const claim = parseCanonicalJson(
    row.claim_json,
    'execution fence v2 claim',
    assertSyncExecutionClaimV2,
  );
  const start = row.start_json === null
    ? null
    : parseCanonicalJson(
      row.start_json,
      'execution fence v2 start',
      assertSyncExecutionClaimV2,
    );
  let completion: SyncExecutionCompleteRequestV2 | SyncExecutionClaimV2 | null = null;
  if (row.receipt_json !== null) {
    completion = row.state === 'completed'
      ? parseCanonicalJson(
        row.receipt_json,
        'execution fence v2 completed status',
        assertSyncExecutionClaimV2,
      )
      : parseCanonicalJson(
        row.receipt_json,
        'execution fence v2 completion request',
        assertSyncExecutionCompleteRequestV2,
      );
  }
  if (row.claim_id !== claim.claimId) {
    throw new Error('execution fence v2 claimId 与 claim 正文不一致。');
  }
  const record: SyncExecutionFenceRecordV2 = {
    protocolVersion: 2,
    operationId: row.operation_id,
    category: row.category,
    claim,
    start,
    completion,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  assertSyncExecutionFenceRecordV2(record);
  return record;
}

export class AndroidSyncExecutionFenceV2SqlitePort
implements SyncExecutionFencePortV2 {
  async load(operationId: string) {
    const database = await getCurrentDeviceDatabase();
    const row = await enqueueSyncDatabaseOperation(
      () => loadRow(database, operationId),
    );
    if (!row) return null;
    if (!isProtocolV2Json(row.claim_json)) {
      return { protocolVersion: 1 as const, operationId };
    }
    return fenceRecordV2FromRow(row);
  }

  async saveClaimed(input: {
    category: SyncExecutionFenceRecordV2['category'];
    claim: SyncExecutionClaimV2;
    updatedAt: number;
  }) {
    assertSyncExecutionClaimV2(input.claim);
    if (input.claim.state !== 'claimed') {
      throw new Error('execution fence v2 只能保存 claimed 状态。');
    }
    assertTimestamp(input.updatedAt, 'execution fence v2 updatedAt');
    const database = await getCurrentDeviceDatabase();
    return runSyncDatabaseTransaction(database, async (transaction) => {
      const existingRow = await loadRow(transaction, input.claim.operationId);
      if (!existingRow) {
        await transaction.runAsync(
          `INSERT INTO sync_execution_fences (
             operation_id, category, claim_id, claim_json,
             start_json, receipt_json, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, NULL, 'claimed', ?, ?)`,
          input.claim.operationId,
          input.category,
          input.claim.claimId,
          canonicalizeJsonV1(input.claim),
          input.updatedAt,
          input.updatedAt,
        );
        return fenceRecordV2FromRow((await loadRow(
          transaction,
          input.claim.operationId,
        ))!);
      }
      if (!isProtocolV2Json(existingRow.claim_json)) {
        throw new Error('旧 execution fence 必须先走 V1 安全续办。');
      }
      const existing = fenceRecordV2FromRow(existingRow);
      if (existing.category !== input.category || input.updatedAt < existing.updatedAt) {
        throw new Error('execution fence v2 发生领域冲突或时间回退。');
      }
      if (existing.state !== 'claimed') {
        if (existing.claim.claimId !== input.claim.claimId) {
          throw new Error('已开始的 execution fence v2 禁止更换 claim。');
        }
        return existing;
      }
      if (canonicalizeJsonV1(existing.claim) === canonicalizeJsonV1(input.claim)) {
        return existing;
      }
      await transaction.runAsync(
        `UPDATE sync_execution_fences
         SET claim_id = ?, claim_json = ?, updated_at = ?
         WHERE operation_id = ? AND state = 'claimed'`,
        input.claim.claimId,
        canonicalizeJsonV1(input.claim),
        input.updatedAt,
        input.claim.operationId,
      );
      return fenceRecordV2FromRow((await loadRow(
        transaction,
        input.claim.operationId,
      ))!);
    });
  }

  async saveStarted(input: {
    start: SyncExecutionClaimV2;
    updatedAt: number;
  }) {
    assertSyncExecutionClaimV2(input.start);
    if (input.start.state !== 'started') {
      throw new Error('execution fence v2 start 状态无效。');
    }
    assertTimestamp(input.updatedAt, 'execution fence v2 updatedAt');
    const database = await getCurrentDeviceDatabase();
    return runSyncDatabaseTransaction(database, async (transaction) => {
      const row = await loadRow(transaction, input.start.operationId);
      if (!row || !isProtocolV2Json(row.claim_json)) {
        throw new Error('execution fence v2 claim 不存在。');
      }
      const current = fenceRecordV2FromRow(row);
      if (
        current.claim.claimId !== input.start.claimId
        || input.updatedAt < current.updatedAt
      ) {
        throw new Error('execution fence v2 start 与 claim 不一致或时间回退。');
      }
      if (current.start) {
        if (canonicalizeJsonV1(current.start) !== canonicalizeJsonV1(input.start)) {
          throw new Error('execution fence v2 已对应另一份 start。');
        }
        return current;
      }
      await transaction.runAsync(
        `UPDATE sync_execution_fences
         SET start_json = ?, state = 'started', updated_at = ?
         WHERE operation_id = ? AND state = 'claimed'`,
        canonicalizeJsonV1(input.start),
        input.updatedAt,
        input.start.operationId,
      );
      return fenceRecordV2FromRow((await loadRow(
        transaction,
        input.start.operationId,
      ))!);
    });
  }

  async saveCompletionPrepared(input: {
    operationId: string;
    completion: SyncExecutionCompleteRequestV2;
    updatedAt: number;
  }) {
    assertSyncExecutionCompleteRequestV2(input.completion);
    assertTimestamp(input.updatedAt, 'execution fence v2 updatedAt');
    const database = await getCurrentDeviceDatabase();
    return runSyncDatabaseTransaction(database, async (transaction) => {
      const row = await loadRow(transaction, input.operationId);
      if (!row || !isProtocolV2Json(row.claim_json)) {
        throw new Error('execution fence v2 start 不存在。');
      }
      const current = fenceRecordV2FromRow(row);
      if (
        !current.start
        || current.claim.claimId !== input.completion.claimId
        || input.updatedAt < current.updatedAt
      ) {
        throw new Error('execution completion v2 与 start 不一致或时间回退。');
      }
      if (current.completion) {
        if (canonicalizeJsonV1(current.completion) !== canonicalizeJsonV1(input.completion)) {
          throw new Error('execution fence v2 已对应另一份完成结果。');
        }
        return current;
      }
      await transaction.runAsync(
        `UPDATE sync_execution_fences
         SET receipt_json = ?, state = 'completion-prepared', updated_at = ?
         WHERE operation_id = ? AND state = 'started'`,
        canonicalizeJsonV1(input.completion),
        input.updatedAt,
        input.operationId,
      );
      return fenceRecordV2FromRow((await loadRow(transaction, input.operationId))!);
    });
  }

  async markCompleted(input: {
    completed: SyncExecutionClaimV2;
    updatedAt: number;
  }) {
    assertSyncExecutionClaimV2(input.completed);
    if (input.completed.state !== 'completed') {
      throw new Error('execution fence v2 completed 状态无效。');
    }
    assertTimestamp(input.updatedAt, 'execution fence v2 updatedAt');
    const database = await getCurrentDeviceDatabase();
    return runSyncDatabaseTransaction(database, async (transaction) => {
      const row = await loadRow(transaction, input.completed.operationId);
      if (!row || !isProtocolV2Json(row.claim_json)) {
        throw new Error('execution fence v2 completion 不存在。');
      }
      const current = fenceRecordV2FromRow(row);
      if (
        current.claim.claimId !== input.completed.claimId
        || input.updatedAt < current.updatedAt
      ) {
        throw new Error('execution fence v2 完成状态与 claim 不一致或时间回退。');
      }
      if (current.state === 'completed') {
        if (canonicalizeJsonV1(current.completion) !== canonicalizeJsonV1(input.completed)) {
          throw new Error('execution fence v2 已完成为另一结果。');
        }
        return current;
      }
      if (current.state !== 'completion-prepared') {
        throw new Error('execution fence v2 无法从当前状态完成。');
      }
      await transaction.runAsync(
        `UPDATE sync_execution_fences
         SET receipt_json = ?, state = 'completed', updated_at = ?
         WHERE operation_id = ? AND state = 'completion-prepared'`,
        canonicalizeJsonV1(input.completed),
        input.updatedAt,
        input.completed.operationId,
      );
      return fenceRecordV2FromRow((await loadRow(
        transaction,
        input.completed.operationId,
      ))!);
    });
  }
}
