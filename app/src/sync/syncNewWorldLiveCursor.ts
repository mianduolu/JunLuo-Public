import type {
  SyncCurrentBaselineV1,
} from './syncCurrentBaseline';
import {
  assertSyncDevicePublicIdentityV1,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  parseSyncWorldBaselineCheckpoint,
  NEW_WORLD_BASELINE_OPERATION_ID,
} from './syncNewWorldBaselineSqliteStore';

type CountRow = {
  total: number;
  acknowledged: number;
  minimum_sequence: number | null;
  maximum_sequence: number | null;
};

type CursorRow = {
  cursor_value: number;
};

type IntentRow = {
  intent_json: string;
  state: string;
};

export interface NewWorldLiveCursorQueryPort {
  getFirstAsync<T>(source: string, ...parameters: unknown[]): Promise<T | null>;
  runAsync(source: string, ...parameters: unknown[]): Promise<{ changes: number }>;
}

export interface NewWorldLiveCursorDatabasePort {
  withTransaction<T>(
    task: (transaction: NewWorldLiveCursorQueryPort) => Promise<T>,
  ): Promise<T>;
}

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

export async function initializeNewWorldLiveCursor(input: {
  database: NewWorldLiveCursorDatabasePort;
  identity: SyncDevicePublicIdentityV1;
  baseline: SyncCurrentBaselineV1;
  now: number;
}) {
  assertSyncDevicePublicIdentityV1(input.identity);
  assertTimestamp(input.now, 'new-world live cursor now');
  if (
    input.baseline.vaultId !== input.identity.vaultId
    || input.baseline.sourceDeviceId !== input.identity.deviceId
    || input.baseline.keyId !== input.identity.keyId
  ) {
    throw new Error('新世界基线回执不属于当前 Android 设备。');
  }

  return input.database.withTransaction(async (transaction) => {
    const current = await transaction.getFirstAsync<CursorRow>(
      "SELECT cursor_value FROM sync_cursors WHERE stream_id = 'relay-v1'",
    );
    if (current?.cursor_value === input.baseline.relayCursor) {
      return Object.freeze({
        state: 'already-initialized' as const,
        relayCursor: current.cursor_value,
      });
    }
    if (current && current.cursor_value !== 0) {
      throw new Error('新世界实时游标已经开始推进，不能重新跳到基线末尾。');
    }

    const intent = await transaction.getFirstAsync<IntentRow>(
      `SELECT intent_json, state FROM sync_durable_intents
       WHERE operation_id = ?`,
      NEW_WORLD_BASELINE_OPERATION_ID,
    );
    if (!intent || intent.state !== 'captured') {
      throw new Error('新世界当前快照尚未完整落盘。');
    }
    const checkpoint = parseSyncWorldBaselineCheckpoint(
      intent.intent_json,
    );
    if (
      checkpoint.state !== 'complete'
      || checkpoint.world.vaultId !== input.identity.vaultId
      || checkpoint.deviceId !== input.identity.deviceId
      || checkpoint.world.keyId !== input.identity.keyId
      // Current phone changes can be acknowledged after snapshot capture and
      // before its first relay receipt. The full receipt prefix must still be
      // present and acknowledged below; it cannot omit captured records.
      || checkpoint.mutationCount > input.baseline.mutationCount
    ) {
      throw new Error('新世界本机快照与中继完成回执不一致。');
    }

    const outbox = await transaction.getFirstAsync<CountRow>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN state = 'acked' THEN 1 ELSE 0 END), 0)
                AS acknowledged,
              MIN(source_sequence) AS minimum_sequence,
              MAX(source_sequence) AS maximum_sequence
       FROM sync_outbox
       WHERE vault_id = ? AND source_device_id = ?
         AND source_sequence <= ?`,
      input.identity.vaultId,
      input.identity.deviceId,
      input.baseline.mutationCount,
    );
    if (
      !outbox
      || outbox.total !== input.baseline.mutationCount
      || outbox.acknowledged !== outbox.total
      || (
        input.baseline.mutationCount > 0
        && (
          outbox.minimum_sequence !== 1
          || outbox.maximum_sequence !== input.baseline.mutationCount
        )
      )
    ) {
      throw new Error('新世界基线 outbox 尚未全部得到中继确认。');
    }
    const inbox = await transaction.getFirstAsync<{ total: number }>(
      'SELECT COUNT(*) AS total FROM sync_inbox',
    );
    if (!inbox || inbox.total !== 0) {
      throw new Error('新世界已经存在接收队列，不能跳过其游标。');
    }

    const result = await transaction.runAsync(
      `INSERT INTO sync_cursors (stream_id, cursor_value, updated_at)
       VALUES ('relay-v1', ?, ?)
       ON CONFLICT(stream_id) DO UPDATE SET
         cursor_value = excluded.cursor_value,
         updated_at = excluded.updated_at`,
      input.baseline.relayCursor,
      input.now,
    );
    if (result.changes !== 1) {
      throw new Error('新世界实时游标没有完整落盘。');
    }
    return Object.freeze({
      state: 'initialized' as const,
      relayCursor: input.baseline.relayCursor,
    });
  });
}
