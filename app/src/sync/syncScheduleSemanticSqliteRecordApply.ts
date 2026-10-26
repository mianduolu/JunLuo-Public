import type * as SQLite from 'expo-sqlite';

import {
  assertScheduleSemanticRecord,
  retainDayTemplateRecord,
  retainScheduleExecution,
  type ScheduleSemanticRecordKind,
} from './syncScheduleSemantic';
import type { JsonValue } from './syncProtocol';

type ScheduleRecord = JsonValue & Record<string, JsonValue>;

function localId(
  kind: ScheduleSemanticRecordKind,
  entityId: string,
) {
  const prefix = `${kind}:`;
  if (!entityId.startsWith(prefix) || entityId.length <= prefix.length) {
    throw new Error(`schedule.semantic ${kind} entity id 无效。`);
  }
  return entityId.slice(prefix.length);
}

async function writeScheduleItem(
  transaction: SQLite.SQLiteDatabase,
  record: ScheduleRecord,
) {
  const previous = await transaction.getFirstAsync<{ execution_json: string | null }>(
    'SELECT execution_json FROM schedule_items WHERE id = ?', record.id as string,
  );
  const execution = retainScheduleExecution(previous?.execution_json ? JSON.parse(previous.execution_json) : null, record.execution);
  await transaction.runAsync(
    `INSERT INTO schedule_items (
       id, title, notes, start_at, end_at, reminder_minutes_before,
       recurrence, recurrence_rule, range_end_at, status, reminder_text,
       reminder_intensity, source, habit_id, habit_anchor_key, todo_id,
       goal_id, plan_id, companion_enabled, letter_ticket_enabled, created_at, updated_at, owner, reading_id, execution_json,
       start_reminder_enabled, end_mode, duration_minutes, habit_completion_key
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       notes = excluded.notes,
       start_at = excluded.start_at,
       end_at = excluded.end_at,
       reminder_minutes_before = excluded.reminder_minutes_before,
       recurrence = excluded.recurrence,
       recurrence_rule = excluded.recurrence_rule,
       range_end_at = excluded.range_end_at,
       status = CASE WHEN ? = 0 AND schedule_items.status != 'pending' THEN schedule_items.status ELSE excluded.status END,
       reminder_text = excluded.reminder_text,
       reminder_intensity = excluded.reminder_intensity,
       source = excluded.source,
       habit_id = excluded.habit_id,
       habit_anchor_key = excluded.habit_anchor_key,
       todo_id = excluded.todo_id,
       goal_id = excluded.goal_id,
       plan_id = excluded.plan_id,
       companion_enabled = excluded.companion_enabled,
       letter_ticket_enabled = excluded.letter_ticket_enabled,
       owner = CASE WHEN ? = 1 THEN excluded.owner ELSE schedule_items.owner END,
       reading_id = CASE WHEN ? = 1 THEN excluded.reading_id ELSE schedule_items.reading_id END,
       execution_json = CASE WHEN ? = 1 THEN excluded.execution_json ELSE schedule_items.execution_json END,
       start_reminder_enabled = CASE WHEN ? = 1 THEN excluded.start_reminder_enabled ELSE schedule_items.start_reminder_enabled END,
       end_mode = CASE WHEN ? = 1 THEN excluded.end_mode ELSE schedule_items.end_mode END,
       duration_minutes = CASE WHEN ? = 1 THEN excluded.duration_minutes ELSE schedule_items.duration_minutes END,
       habit_completion_key = CASE WHEN ? = 1 THEN excluded.habit_completion_key ELSE schedule_items.habit_completion_key END,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.title as string,
    record.notes as string,
    record.startAt as number,
    record.endAt as number | null,
    record.reminderMinutesBefore as number,
    record.recurrence as string,
    JSON.stringify(record.recurrenceRule),
    record.rangeEndAt as number | null,
    record.status as string,
    record.reminderText as string,
    record.reminderIntensity as string,
    record.source as string,
    record.habitId as string | null,
    record.habitAnchorKey as string | null,
    record.todoId as string | null,
    record.goalId as string | null,
    record.planId as string | null,
    record.companionEnabled ? 1 : 0,
    record.letterTicketEnabled ? 1 : 0,
    record.createdAt as number,
    record.updatedAt as number,
    record.owner as string ?? 'you',
    record.readingId as string | null ?? null,
    execution ? JSON.stringify(execution) : null,
    record.startReminderEnabled == null ? null : record.startReminderEnabled ? 1 : 0,
    record.endMode as string ?? null,
    record.durationMinutes as number ?? null,
    record.habitCompletionKey as string ?? null,
    'owner' in record ? 1 : 0,
    'owner' in record ? 1 : 0,
    'readingId' in record ? 1 : 0,
    'execution' in record ? 1 : 0,
    'startReminderEnabled' in record ? 1 : 0,
    'endMode' in record ? 1 : 0,
    'durationMinutes' in record ? 1 : 0,
    'habitCompletionKey' in record ? 1 : 0,
  );
}

async function writeOccurrenceDelivery(
  transaction: SQLite.SQLiteDatabase,
  record: ScheduleRecord,
  pendingUpdatedAt: number,
  allowPending: boolean,
) {
  const terminalStatus = record.status === 'completed'
    || record.status === 'cancelled'
    ? record.status
    : null;
  const result = await transaction.runAsync(
    `UPDATE schedule_occurrences
     SET reminder_at = ?,
         status = CASE WHEN completion_round > 0 OR ? IS NULL THEN status ELSE ? END,
         chat_delivered_at = ?
     WHERE id = ?`,
    record.scheduledAt as number,
    terminalStatus,
    terminalStatus,
    record.deliveredAt as number | null,
    record.occurrenceId as string,
  );
  if (result.changes === 1) {
    await transaction.runAsync(
      `DELETE FROM schedule_sync_pending_delivery_apply
       WHERE entity_id = ?`,
      record.occurrenceId as string,
    );
    return;
  }
  if (!allowPending) {
    throw new Error(
      'schedule occurrence 写入后仍无法应用 pending delivery。',
    );
  }
  await transaction.runAsync(
    `INSERT INTO schedule_sync_pending_delivery_apply (
       entity_id, record_json, updated_at
     ) VALUES (?, ?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET
       record_json = excluded.record_json,
       updated_at = excluded.updated_at`,
    record.occurrenceId as string,
    JSON.stringify(record),
    pendingUpdatedAt,
  );
}

async function applyPendingOccurrenceDelivery(
  transaction: SQLite.SQLiteDatabase,
  occurrenceId: string,
) {
  const pending = await transaction.getFirstAsync<{
    record_json: string;
    updated_at: number;
  }>(
    `SELECT record_json, updated_at
     FROM schedule_sync_pending_delivery_apply
     WHERE entity_id = ?`,
    occurrenceId,
  );
  if (!pending) return;
  const record = JSON.parse(pending.record_json) as ScheduleRecord;
  assertScheduleSemanticRecord('schedule-occurrence-delivery', record);
  await writeOccurrenceDelivery(
    transaction,
    record,
    pending.updated_at,
    false,
  );
}

async function writeScheduleOccurrence(
  transaction: SQLite.SQLiteDatabase,
  record: ScheduleRecord,
) {
  await transaction.runAsync(
    `INSERT INTO schedule_occurrences (
       id, item_id, scheduled_start_at, reminder_at, status, completed_at, completion_round
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       item_id = excluded.item_id,
       scheduled_start_at = excluded.scheduled_start_at,
       reminder_at = excluded.reminder_at,
       status = CASE WHEN excluded.completion_round < schedule_occurrences.completion_round THEN schedule_occurrences.status ELSE excluded.status END,
       completed_at = CASE WHEN excluded.completion_round < schedule_occurrences.completion_round THEN schedule_occurrences.completed_at ELSE excluded.completed_at END,
       completion_round = max(schedule_occurrences.completion_round, excluded.completion_round)`,
    record.id as string,
    record.itemId as string,
    record.scheduledStartAt as number,
    record.reminderAt as number,
    record.status as string,
    record.completedAt as number | null,
    (record.completionRound ?? 0) as number,
  );
  await applyPendingOccurrenceDelivery(
    transaction,
    record.id as string,
  );
}

async function writeDayTemplateInstance(
  transaction: SQLite.SQLiteDatabase,
  record: ScheduleRecord,
) {
  const previous = await transaction.getFirstAsync<Record<string, JsonValue>>(
    `SELECT id, date_key AS dateKey, kind, title, start_at AS startAt, end_at AS endAt,
      status, completed_at AS completedAt, template_hash AS templateHash, created_at AS createdAt,
      updated_at AS updatedAt, source, enabled, operation_id AS operationId FROM day_template_instances WHERE id = ?`,
    record.id as string,
  );
  record = retainDayTemplateRecord('day-template-instance', previous
    ? { ...previous, enabled: previous.enabled === 1 } : {}, record);
  await transaction.runAsync(
    `INSERT INTO day_template_instances (
       id, date_key, kind, title, start_at, end_at, status,
       completed_at, template_hash, created_at, updated_at, source, enabled, operation_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       date_key = excluded.date_key,
       kind = excluded.kind,
       title = excluded.title,
       start_at = excluded.start_at,
       end_at = excluded.end_at,
       status = excluded.status,
       completed_at = excluded.completed_at,
       template_hash = excluded.template_hash,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       source = excluded.source,
       enabled = excluded.enabled,
       operation_id = excluded.operation_id`,
    record.id as string,
    record.dateKey as string,
    record.kind as string,
    record.title as string,
    record.startAt as number | null,
    record.endAt as number | null,
    record.status as string,
    record.completedAt as number | null,
    record.templateHash as string,
    record.createdAt as number,
    record.updatedAt as number,
    record.source as string,
    record.enabled ? 1 : 0,
    record.operationId as string | null,
  );
}

async function writeScheduleCompanionDelivery(
  transaction: SQLite.SQLiteDatabase,
  record: ScheduleRecord,
) {
  await transaction.runAsync(
    `INSERT INTO schedule_companion_events (
       id, occurrence_id, kind, scheduled_at, status, delivered_at,
       responded_at, created_at, updated_at, reminder_body_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       occurrence_id = excluded.occurrence_id,
       kind = excluded.kind,
       notified_at = CASE WHEN schedule_companion_events.scheduled_at = excluded.scheduled_at
         THEN schedule_companion_events.notified_at ELSE NULL END,
       recovery_handled_at = CASE WHEN schedule_companion_events.scheduled_at = excluded.scheduled_at
         THEN schedule_companion_events.recovery_handled_at ELSE NULL END,
       scheduled_at = excluded.scheduled_at,
       status = excluded.status,
       delivered_at = excluded.delivered_at,
       responded_at = excluded.responded_at,
       reminder_body_json = excluded.reminder_body_json,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.occurrenceId as string,
    record.eventKind as string,
    record.scheduledAt as number,
    record.status as string,
    record.deliveredAt as number | null,
    record.respondedAt as number | null,
    record.createdAt as number,
    record.updatedAt as number,
    record.reminderBody ? JSON.stringify(record.reminderBody) : null,
  );
}

export async function writeSqliteRecord(input: {
  transaction: SQLite.SQLiteDatabase;
  kind: ScheduleSemanticRecordKind;
  record: ScheduleRecord;
  createdAt: number;
}) {
  assertScheduleSemanticRecord(input.kind, input.record);
  if (input.kind === 'schedule-item') {
    return writeScheduleItem(input.transaction, input.record);
  }
  if (input.kind === 'schedule-occurrence') {
    return writeScheduleOccurrence(input.transaction, input.record);
  }
  if (input.kind === 'day-template-instance') {
    return writeDayTemplateInstance(input.transaction, input.record);
  }
  if (input.kind === 'schedule-occurrence-delivery') {
    return writeOccurrenceDelivery(
      input.transaction,
      input.record,
      input.createdAt,
      true,
    );
  }
  if (input.kind === 'schedule-companion-delivery') {
    return writeScheduleCompanionDelivery(input.transaction, input.record);
  }
  throw new Error(
    `schedule.semantic SQLite port 不处理 ${input.kind}。`,
  );
}

export async function deleteSqliteRecord(input: {
  transaction: SQLite.SQLiteDatabase;
  kind: ScheduleSemanticRecordKind;
  entityId: string;
}) {
  if (input.kind === 'schedule-item') {
    await input.transaction.runAsync(
      'DELETE FROM schedule_items WHERE id = ?',
      localId(input.kind, input.entityId),
    );
    return;
  }
  if (input.kind === 'schedule-occurrence') {
    const id = localId(input.kind, input.entityId);
    await input.transaction.runAsync(
      'DELETE FROM schedule_occurrences WHERE id = ?',
      id,
    );
    await input.transaction.runAsync(
      `DELETE FROM schedule_sync_pending_delivery_apply
       WHERE entity_id = ?`,
      id,
    );
    return;
  }
  if (input.kind === 'day-template-instance') {
    await input.transaction.runAsync(
      'DELETE FROM day_template_instances WHERE id = ?',
      localId(input.kind, input.entityId),
    );
    return;
  }
  if (input.kind === 'schedule-occurrence-delivery') {
    const id = localId(input.kind, input.entityId);
    await input.transaction.runAsync(
      `UPDATE schedule_occurrences
       SET chat_delivered_at = NULL
       WHERE id = ?`,
      id,
    );
    await input.transaction.runAsync(
      `DELETE FROM schedule_sync_pending_delivery_apply
       WHERE entity_id = ?`,
      id,
    );
    return;
  }
  if (input.kind === 'schedule-companion-delivery') {
    await input.transaction.runAsync(
      'DELETE FROM schedule_companion_events WHERE id = ?',
      localId(input.kind, input.entityId),
    );
    return;
  }
  throw new Error(
    `schedule.semantic SQLite port 不处理 ${input.kind} tombstone。`,
  );
}
