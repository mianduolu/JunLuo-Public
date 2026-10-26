import {
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  createExpoSyncWorldBaselineStore,
  getExpoSyncWorldV2Database,
} from './syncNewWorldBaselineExpoStore';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import { activateAndroidGiftSyncCapture, promotePendingAndroidGiftSyncMutations } from './syncGiftsRuntime';
import {
  activateMemoryRecordsCapture,
  ensureMemoryRecordsCaptureSchema,
  loadMemoryRecordsCaptureRuntime,
} from './syncMemoryRecordsSqlitePort';
import { runMemoryRecordsOutboxPromotionRuntime } from './syncMemoryRecordsRuntime';
import {
  isScheduleSemanticEntityType,
} from './syncScheduleSemantic';
import {
  activateScheduleSemanticCapture,
  ensureScheduleSemanticCaptureSchema,
  loadScheduleSemanticCaptureRuntime,
} from './syncScheduleSemanticSqlitePort';
import {
  runScheduleSemanticOutboxPromotionRuntime,
} from './syncScheduleSemanticRuntime';
import {
  isTodoSemanticEntityType,
} from './syncTodoSemantic';
import {
  activateTodoSemanticCapture,
  ensureTodoSemanticCaptureSchema,
  loadTodoSemanticCaptureRuntime,
} from './syncTodoSemanticSqlitePort';
import {
  runTodoSemanticOutboxPromotionRuntime,
} from './syncTodoSemanticRuntime';

type CurrentHeadRow = Readonly<{
  entity_type: string;
  entity_id: string;
  revision_id: string;
  updated_at: number;
}>;

async function seedMissingCurrentHeads(input: {
  table: 'schedule_sync_entity_heads' | 'todo_sync_entity_heads' | 'memory_sync_entity_heads';
  database: Awaited<ReturnType<
    typeof ensureScheduleSemanticCaptureSchema
    | typeof ensureTodoSemanticCaptureSchema
    | typeof ensureMemoryRecordsCaptureSchema
  >>;
  heads: readonly CurrentHeadRow[];
}) {
  await input.database.withExclusiveTransactionAsync(async (transaction) => {
    const existing = new Set((await transaction.getAllAsync<{
      entity_type: string; entity_id: string;
    }>(`SELECT entity_type, entity_id FROM ${input.table}`))
      .map(head => JSON.stringify([head.entity_type, head.entity_id])));
    for (const head of input.heads) {
      if (existing.has(JSON.stringify([head.entity_type, head.entity_id]))) continue;
      await transaction.runAsync(
        `INSERT INTO ${input.table} (
           entity_type, entity_id, revision_id, updated_at
         ) VALUES (?, ?, ?, ?)`,
        head.entity_type,
        head.entity_id,
        head.revision_id,
        head.updated_at,
      );
    }
  });
}

export async function activateAndroidNewWorldLiveCapture(input: {
  identity: SyncDevicePublicIdentityV1;
  updatedAt?: number;
}) {
  const updatedAt = input.updatedAt ?? Date.now();
  await activateAndroidGiftSyncCapture(input.identity);
  const central = await getExpoSyncWorldV2Database();
  const memoryRuntime = await loadMemoryRecordsCaptureRuntime();
  if (!memoryRuntime.captureEnabled) {
    const database = await ensureMemoryRecordsCaptureSchema();
    await seedMissingCurrentHeads({
      table: 'memory_sync_entity_heads',
      database,
      heads: await central.getAllAsync<CurrentHeadRow>(
        `SELECT entity_type, entity_id, revision_id, updated_at
         FROM sync_entity_heads WHERE domain = 'memory'
         ORDER BY entity_type ASC, entity_id ASC, revision_id ASC`,
      ),
    });
  }
  // Resume the existing trigger writer, without bootstrapping old business rows.
  await activateMemoryRecordsCapture(input.identity, updatedAt);
  const heads = await central.getAllAsync<CurrentHeadRow>(
    `SELECT entity_type, entity_id, revision_id, updated_at
     FROM sync_entity_heads
     ORDER BY entity_type ASC, entity_id ASC, revision_id ASC`,
  );

  const [scheduleRuntime, todoRuntime] = await Promise.all([
    loadScheduleSemanticCaptureRuntime(),
    loadTodoSemanticCaptureRuntime(),
  ]);
  if (!scheduleRuntime.captureEnabled) {
    const database = await ensureScheduleSemanticCaptureSchema();
    await seedMissingCurrentHeads({
      table: 'schedule_sync_entity_heads',
      database,
      heads: heads.filter((head) => (
        isScheduleSemanticEntityType(head.entity_type)
      )),
    });
    await activateScheduleSemanticCapture(input.identity, updatedAt);
  }
  if (!todoRuntime.captureEnabled) {
    const database = await ensureTodoSemanticCaptureSchema();
    await seedMissingCurrentHeads({
      table: 'todo_sync_entity_heads',
      database,
      heads: heads.filter((head) => (
        isTodoSemanticEntityType(head.entity_type)
      )),
    });
    await activateTodoSemanticCapture(input.identity, updatedAt);
  }

  return Object.freeze({
    memoryCaptureEnabled: true,
    scheduleCaptureEnabled: true,
    todoCaptureEnabled: true,
  });
}

/** Recovery finishes before the page can accept writes; an unfinished baseline stays paused. */
export async function restoreAndroidNewWorldLiveCapture() {
  const current = await loadCurrentSyncDevice();
  if (!current) return false;
  const checkpoint = await createExpoSyncWorldBaselineStore().loadCheckpoint();
  if (checkpoint?.state !== 'complete') return false;
  if (checkpoint.world.vaultId !== current.identity.vaultId
    || checkpoint.deviceId !== current.identity.deviceId
    || checkpoint.world.keyId !== current.identity.keyId) {
    throw new Error('新世界捕获与已完成的当前快照身份不一致。');
  }
  await activateAndroidNewWorldLiveCapture({ identity: current.identity });
  return true;
}

export async function promoteAndroidNewWorldLiveChanges(input: {
  limit: number;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const current = await loadCurrentSyncDevice();
  const gifts = current ? await promotePendingAndroidGiftSyncMutations(current.identity, current.secrets, input.limit) : null;
  const memory = await runMemoryRecordsOutboxPromotionRuntime({
    batchLimit: input.limit,
    maximumBatches: 1,
    now,
  });
  const schedule = await runScheduleSemanticOutboxPromotionRuntime({
    limit: input.limit,
    now,
  });
  const todo = await runTodoSemanticOutboxPromotionRuntime({
    limit: input.limit,
    now,
  });
  if (memory.status !== 'completed'
    || schedule.status !== 'completed' || todo.status !== 'completed') {
    throw new Error(
      'Android 新世界记忆、动态、日程与待办尚未完整进入中央同步队列。',
    );
  }
  return Object.freeze({ memory, schedule, todo, gifts });
}

export async function hasPendingAndroidNewWorldMemoryChanges() {
  const database = await ensureMemoryRecordsCaptureSchema();
  return Boolean(await database.getFirstAsync(
    "SELECT 1 FROM memory_sync_domain_outbox WHERE state <> 'dispatched' LIMIT 1",
  ));
}

export async function hasPendingAndroidNewWorldScheduleChanges() {
  const database = await ensureScheduleSemanticCaptureSchema();
  return Boolean(await database.getFirstAsync(
    "SELECT 1 FROM schedule_sync_domain_outbox WHERE state <> 'dispatched' LIMIT 1",
  ));
}

export async function hasPendingAndroidNewWorldTodoChanges() {
  const database = await ensureTodoSemanticCaptureSchema();
  return Boolean(await database.getFirstAsync(
    "SELECT 1 FROM todo_sync_domain_outbox WHERE state <> 'dispatched' LIMIT 1",
  ));
}
