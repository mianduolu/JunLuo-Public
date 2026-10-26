import type * as SQLite from 'expo-sqlite';

import { loadCurrentSyncDevice } from './syncCurrentDevice';
import type {
  SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  assertScheduleSemanticRecord,
  scheduleSemanticEntityId,
  scheduleSemanticEntityTypeForKind,
  SCHEDULE_SEMANTIC_ADAPTER_ID,
  SCHEDULE_SEMANTIC_SCHEMA_VERSION,
  type ScheduleSemanticRecordKind,
} from './syncScheduleSemantic';
import {
  runScheduleSemanticStorageBootstrapRuntime,
  type ScheduleSemanticStorageBootstrapRuntimeResult,
} from './syncScheduleSemanticBootstrapRuntime';
import {
  promoteScheduleSemanticDomainOutbox,
  type PromoteScheduleSemanticOutboxReport,
} from './syncScheduleSemanticOutbox';
import {
  deactivateScheduleSemanticCapture,
  ensureScheduleSemanticCaptureSchema,
  recoverExpiredScheduleSemanticOutboxLeases,
  scheduleSemanticDomainOutboxPort,
} from './syncScheduleSemanticSqlitePort';
import {
  SCHEDULE_SEMANTIC_CAPTURE_LEASE_MS,
} from './syncScheduleSemanticSql';
import {
  enqueueCapturedScheduleSemanticMutation,
  syncMutationStatePort,
} from './syncMutationStateStore';
import type { JsonValue } from './syncProtocol';

export const SCHEDULE_SEMANTIC_SQLITE_BOOTSTRAP_VERSION = 1 as const;

export type ScheduleSemanticSqliteBootstrapRuntimeResult =
  | {
      status: 'no-current-device';
      mutationCount: 0;
      captureEnabled: false;
    }
  | {
      status: 'already-complete' | 'completed';
      mutationCount: number;
      captureEnabled: true;
    };

export type ScheduleSemanticBootstrapRuntimeResult = {
  sqlite: ScheduleSemanticSqliteBootstrapRuntimeResult;
  storage: ScheduleSemanticStorageBootstrapRuntimeResult;
};

export type ScheduleSemanticPromotionRuntimeResult =
  | {
      status: 'no-current-device';
      recoveredLeaseCount: number;
      report: PromoteScheduleSemanticOutboxReport;
    }
  | {
      status: 'completed' | 'partial-failure';
      recoveredLeaseCount: number;
      report: PromoteScheduleSemanticOutboxReport;
    };

type BootstrapStateRow = {
  completed_at: number;
};

type RuntimeRow = {
  capture_enabled: number;
  suppress_capture: number;
  vault_id: string | null;
  source_device_id: string | null;
};

type HeadRow = {
  revision_id: string;
};

type GeneratedIdsRow = {
  mutation_id: string;
  revision_id: string;
};

type ScheduleItemRow = {
  start_reminder_enabled?: number | null;
  end_mode?: string | null;
  duration_minutes?: number | null;
  habit_completion_key?: string | null;
  owner?: string;
  reading_id?: string | null;
  execution_json?: string | null;
  id: string;
  title: string;
  notes: string;
  start_at: number;
  end_at: number | null;
  reminder_minutes_before: number;
  recurrence: string;
  recurrence_rule: string | null;
  range_end_at: number | null;
  status: string;
  reminder_text: string;
  reminder_intensity: string;
  source: string;
  habit_id: string | null;
  habit_anchor_key: string | null;
  todo_id: string | null;
  goal_id: string | null;
  plan_id: string | null;
  companion_enabled: number;
  letter_ticket_enabled: number;
  created_at: number;
  updated_at: number;
};

type ScheduleOccurrenceRow = {
  id: string;
  item_id: string;
  scheduled_start_at: number;
  reminder_at: number;
  status: string;
  chat_delivered_at: number | null;
  completed_at: number | null;
};

type DayTemplateInstanceRow = {
  id: string;
  date_key: string;
  kind: string;
  title: string;
  start_at: number | null;
  source: 'usual' | 'day';
  enabled: number;
  operation_id: string | null;
  end_at: number | null;
  status: string;
  completed_at: number | null;
  template_hash: string;
  created_at: number;
  updated_at: number;
};

type ScheduleCompanionRow = {
  id: string;
  occurrence_id: string;
  kind: string;
  scheduled_at: number;
  status: string;
  delivered_at: number | null;
  responded_at: number | null;
  reminder_body_json: string | null;
  created_at: number;
  updated_at: number;
};

const UUID_V4_SQL = `(
  lower(hex(randomblob(4))) || '-' ||
  lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
  substr('89ab', (random() & 3) + 1, 1) ||
  substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
  lower(hex(randomblob(6)))
)`;

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function recurrenceRule(row: ScheduleItemRow) {
  if (row.recurrence_rule) {
    try {
      return JSON.parse(row.recurrence_rule) as JsonValue;
    } catch {
      // Match the live capture fallback for malformed legacy recurrence data.
    }
  }
  return { type: row.recurrence };
}

function itemRecord(row: ScheduleItemRow) {
  return {
    startReminderEnabled: row.start_reminder_enabled == null ? null : row.start_reminder_enabled === 1,
    endMode: row.end_mode ?? null,
    durationMinutes: row.duration_minutes ?? null,
    habitCompletionKey: row.habit_completion_key ?? null,
    owner: row.owner ?? 'you',
    readingId: row.reading_id ?? null,
    execution: row.execution_json ? JSON.parse(row.execution_json) as JsonValue : null,
    id: row.id,
    title: row.title,
    notes: row.notes,
    startAt: row.start_at,
    endAt: row.end_at,
    reminderMinutesBefore: row.reminder_minutes_before,
    recurrence: row.recurrence,
    recurrenceRule: recurrenceRule(row),
    rangeEndAt: row.range_end_at,
    status: row.status,
    reminderText: row.reminder_text,
    reminderIntensity: row.reminder_intensity,
    source: row.source,
    habitId: row.habit_id,
    habitAnchorKey: row.habit_anchor_key,
    todoId: row.todo_id,
    goalId: row.goal_id,
    planId: row.plan_id,
    companionEnabled: row.companion_enabled === 1,
    letterTicketEnabled: row.letter_ticket_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function occurrenceRecord(row: ScheduleOccurrenceRow) {
  return {
    id: row.id,
    itemId: row.item_id,
    scheduledStartAt: row.scheduled_start_at,
    reminderAt: row.reminder_at,
    status: row.status,
    completedAt: row.completed_at,
  };
}

function occurrenceDeliveryRecord(row: ScheduleOccurrenceRow) {
  return {
    occurrenceId: row.id,
    scheduledAt: row.reminder_at,
    status: row.status === 'cancelled'
      ? 'cancelled'
      : row.status === 'completed'
        ? 'completed'
        : row.chat_delivered_at !== null
          ? 'delivered'
          : 'pending',
    deliveredAt: row.chat_delivered_at,
  };
}

function dayTemplateInstanceRecord(row: DayTemplateInstanceRow) {
  return {
    source: row.source,
    enabled: row.enabled === 1,
    operationId: row.operation_id,
    id: row.id,
    dateKey: row.date_key,
    kind: row.kind,
    title: row.title,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status,
    completedAt: row.completed_at,
    templateHash: row.template_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function companionDeliveryRecord(row: ScheduleCompanionRow) {
  return {
    id: row.id,
    occurrenceId: row.occurrence_id,
    eventKind: row.kind,
    scheduledAt: row.scheduled_at,
    status: row.status,
    deliveredAt: row.delivered_at,
    respondedAt: row.responded_at,
    reminderBody: row.reminder_body_json ? JSON.parse(row.reminder_body_json) as JsonValue : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function generatedIds(transaction: SQLite.SQLiteDatabase) {
  const row = await transaction.getFirstAsync<GeneratedIdsRow>(
    `SELECT ${UUID_V4_SQL} AS mutation_id, ${UUID_V4_SQL} AS revision_id`,
  );
  if (!row) {
    throw new Error(
      'schedule.semantic bootstrap 无法生成 mutation/revision ID。',
    );
  }
  return row;
}

async function snapshotRecord(input: {
  transaction: SQLite.SQLiteDatabase;
  identity: SyncDevicePublicIdentityV1;
  kind: ScheduleSemanticRecordKind;
  record: JsonValue & Record<string, JsonValue>;
  operation: 'upsert' | 'append';
  createdAt: number;
}) {
  assertScheduleSemanticRecord(input.kind, input.record);
  const entityType = scheduleSemanticEntityTypeForKind(input.kind);
  const entityId = scheduleSemanticEntityId(input.kind, input.record);
  if (entityId.length > 256) {
    throw new Error(
      `schedule.semantic ${input.kind} entityId 超过 256 字符。`,
    );
  }
  const parents = await input.transaction.getAllAsync<HeadRow>(
    `SELECT revision_id
     FROM schedule_sync_entity_heads
     WHERE entity_type = ? AND entity_id = ?
     ORDER BY revision_id ASC`,
    entityType,
    entityId,
  );
  if (parents.length > 32) {
    throw new Error('schedule.semantic bootstrap entity heads 超过协议上限。');
  }
  const ids = await generatedIds(input.transaction);
  await input.transaction.runAsync(
    `INSERT INTO schedule_sync_domain_outbox (
       mutation_id, revision_id, parent_revision_ids_json,
       vault_id, source_device_id, entity_type, entity_id,
       operation, schema_version, payload_json, state,
       available_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ids.mutation_id,
    ids.revision_id,
    JSON.stringify(parents.map((parent) => parent.revision_id)),
    input.identity.vaultId,
    input.identity.deviceId,
    entityType,
    entityId,
    input.operation,
    SCHEDULE_SEMANTIC_SCHEMA_VERSION,
    JSON.stringify({
      schemaVersion: SCHEDULE_SEMANTIC_SCHEMA_VERSION,
      kind: input.kind,
      record: input.record,
    }),
    input.createdAt,
    input.createdAt,
    input.createdAt,
  );
  await input.transaction.runAsync(
    `DELETE FROM schedule_sync_entity_heads
     WHERE entity_type = ? AND entity_id = ?`,
    entityType,
    entityId,
  );
  await input.transaction.runAsync(
    `INSERT INTO schedule_sync_entity_heads (
       entity_type, entity_id, revision_id, updated_at
     ) VALUES (?, ?, ?, ?)`,
    entityType,
    entityId,
    ids.revision_id,
    input.createdAt,
  );
}

async function snapshotBusinessRows(input: {
  transaction: SQLite.SQLiteDatabase;
  identity: SyncDevicePublicIdentityV1;
  createdAt: number;
}) {
  let mutationCount = 0;
  const items = await input.transaction.getAllAsync<ScheduleItemRow>(
    'SELECT * FROM schedule_items ORDER BY id ASC',
  );
  for (const row of items) {
    await snapshotRecord({
      ...input,
      kind: 'schedule-item',
      record: itemRecord(row),
      operation: 'upsert',
    });
    mutationCount += 1;
  }
  const occurrences =
    await input.transaction.getAllAsync<ScheduleOccurrenceRow>(
      'SELECT * FROM schedule_occurrences ORDER BY id ASC',
    );
  for (const row of occurrences) {
    await snapshotRecord({
      ...input,
      kind: 'schedule-occurrence',
      record: occurrenceRecord(row),
      operation: 'upsert',
    });
    await snapshotRecord({
      ...input,
      kind: 'schedule-occurrence-delivery',
      record: occurrenceDeliveryRecord(row),
      operation: 'upsert',
    });
    mutationCount += 2;
  }
  const templateInstances =
    await input.transaction.getAllAsync<DayTemplateInstanceRow>(
      'SELECT * FROM day_template_instances ORDER BY id ASC',
    );
  for (const row of templateInstances) {
    await snapshotRecord({
      ...input,
      kind: 'day-template-instance',
      record: dayTemplateInstanceRecord(row),
      operation: 'upsert',
    });
    mutationCount += 1;
  }
  const companionEvents =
    await input.transaction.getAllAsync<ScheduleCompanionRow>(
      'SELECT * FROM schedule_companion_events ORDER BY id ASC',
    );
  for (const row of companionEvents) {
    await snapshotRecord({
      ...input,
      kind: 'schedule-companion-delivery',
      record: companionDeliveryRecord(row),
      operation: 'append',
    });
    mutationCount += 1;
  }
  return mutationCount;
}

export async function bootstrapScheduleSemanticSqliteForIdentity(input: {
  identity: SyncDevicePublicIdentityV1;
  now: number;
}): Promise<ScheduleSemanticSqliteBootstrapRuntimeResult> {
  assertTimestamp(input.now, 'schedule.semantic SQLite bootstrap now');
  const database = await ensureScheduleSemanticCaptureSchema();
  let status: 'already-complete' | 'completed' = 'completed';
  let mutationCount = 0;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const runtime = await transaction.getFirstAsync<RuntimeRow>(
      `SELECT capture_enabled, suppress_capture, vault_id, source_device_id
       FROM schedule_sync_runtime WHERE singleton_id = 1`,
    );
    if (
      runtime?.capture_enabled === 1
      && (
        runtime.vault_id !== input.identity.vaultId
        || runtime.source_device_id !== input.identity.deviceId
      )
    ) {
      throw new Error(
        'schedule.semantic 已绑定另一 active vault/device，拒绝静默换绑。',
      );
    }
    if (runtime?.suppress_capture === 1) {
      throw new Error(
        'schedule.semantic 正在应用远端变更，不能同时执行 bootstrap。',
      );
    }
    await transaction.runAsync(
      `UPDATE schedule_sync_runtime
       SET capture_enabled = 0,
           suppress_capture = 0,
           vault_id = ?,
           source_device_id = ?,
           updated_at = ?
       WHERE singleton_id = 1`,
      input.identity.vaultId,
      input.identity.deviceId,
      input.now,
    );
    const completed = await transaction.getFirstAsync<BootstrapStateRow>(
      `SELECT completed_at
       FROM schedule_sync_bootstrap_state
       WHERE adapter_id = ?
         AND bootstrap_version = ?
         AND vault_id = ?
         AND source_device_id = ?`,
      SCHEDULE_SEMANTIC_ADAPTER_ID,
      SCHEDULE_SEMANTIC_SQLITE_BOOTSTRAP_VERSION,
      input.identity.vaultId,
      input.identity.deviceId,
    );
    if (completed) {
      status = 'already-complete';
    } else {
      mutationCount = await snapshotBusinessRows({
        transaction,
        identity: input.identity,
        createdAt: input.now,
      });
      await transaction.runAsync(
        `INSERT INTO schedule_sync_bootstrap_state (
           adapter_id, bootstrap_version, vault_id,
           source_device_id, completed_at
         ) VALUES (?, ?, ?, ?, ?)`,
        SCHEDULE_SEMANTIC_ADAPTER_ID,
        SCHEDULE_SEMANTIC_SQLITE_BOOTSTRAP_VERSION,
        input.identity.vaultId,
        input.identity.deviceId,
        input.now,
      );
    }
    await transaction.runAsync(
      `UPDATE schedule_sync_runtime
       SET capture_enabled = 1,
           suppress_capture = 0,
           vault_id = ?,
           source_device_id = ?,
           updated_at = ?
       WHERE singleton_id = 1`,
      input.identity.vaultId,
      input.identity.deviceId,
      input.now,
    );
  });
  return {
    status,
    mutationCount,
    captureEnabled: true,
  };
}

export async function runScheduleSemanticSqliteBootstrapRuntime(
  now = Date.now(),
): Promise<ScheduleSemanticSqliteBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    await deactivateScheduleSemanticCapture(now);
    return {
      status: 'no-current-device',
      mutationCount: 0,
      captureEnabled: false,
    };
  }
  return bootstrapScheduleSemanticSqliteForIdentity({
    identity: currentDevice.identity,
    now,
  });
}

export async function runScheduleSemanticBootstrapRuntime():
Promise<ScheduleSemanticBootstrapRuntimeResult> {
  const sqlite = await runScheduleSemanticSqliteBootstrapRuntime();
  const storage = await runScheduleSemanticStorageBootstrapRuntime();
  return { sqlite, storage };
}

function emptyPromotionReport(): PromoteScheduleSemanticOutboxReport {
  return {
    claimedCount: 0,
    dispatchedCount: 0,
    failed: [],
  };
}

export async function runScheduleSemanticOutboxPromotionRuntime(input: {
  limit?: number;
  now?: number;
} = {}): Promise<ScheduleSemanticPromotionRuntimeResult> {
  const now = input.now ?? Date.now();
  assertTimestamp(now, 'schedule.semantic promotion now');
  const recoveredLeaseCount =
    await recoverExpiredScheduleSemanticOutboxLeases(now);
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      recoveredLeaseCount,
      report: emptyPromotionReport(),
    };
  }
  const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
  const report = await promoteScheduleSemanticDomainOutbox({
    identity: currentDevice.identity,
    leaseId: `schedule-semantic:${expoSyncRandomUuidV1()}`,
    now,
    limit: input.limit ?? 100,
    leaseDurationMs: SCHEDULE_SEMANTIC_CAPTURE_LEASE_MS,
    domainOutbox: scheduleSemanticDomainOutboxPort,
    mutationState: syncMutationStatePort,
    centralOutbox: {
      enqueueSyncMutation: enqueueCapturedScheduleSemanticMutation,
    },
  });
  return {
    status: report.failed.length ? 'partial-failure' : 'completed',
    recoveredLeaseCount,
    report,
  };
}

