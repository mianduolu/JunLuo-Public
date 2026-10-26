import { loadReminderOccurrencesBetween, loadScheduleOccurrence, loadScheduleItemById, type ScheduleOccurrence } from './scheduleStore';
import { preparationMatches, SCHEDULE_SEND_GRACE_MS, type ScheduleReminderPreparation } from './scheduleReminderTiming';
import { getScheduleDatabase } from './scheduleDatabase';
import { requestScheduleNotificationRefresh } from './scheduleNotificationRefresh';
import { initializeScheduleReminderRecovery } from './scheduleReminderRecovery';
import { notifyAutomaticDataSyncWorkAvailable } from '../sync/automaticDataSyncEvents';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import {
  getCompanionResponseKinds,
  getScheduleCompanionEventSchedule,
  type ScheduleCompanionEventKind,
} from './scheduleCompanionLogic';

export type { ScheduleCompanionEventKind } from './scheduleCompanionLogic';
export type ScheduleCompanionEventStatus = 'pending' | 'delivered' | 'responded' | 'quiet';

export type ScheduleCompanionEvent = {
  id: string;
  occurrenceId: string;
  kind: ScheduleCompanionEventKind;
  scheduledAt: number;
  status: ScheduleCompanionEventStatus;
  notificationId?: string;
  deliveredAt?: number;
  respondedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type DueScheduleCompanionEvent = ScheduleCompanionEvent & { occurrence: ScheduleOccurrence };
export type ScheduleReminderEvent = DueScheduleCompanionEvent & {
  itemUpdatedAt: number;
  preparation?: ScheduleReminderPreparation;
  reminderBody?: { body: string; scheduledAt: number; itemUpdatedAt: number };
  notifiedAt?: number;
};

type EventRow = {
  id: string;
  occurrence_id: string;
  kind: ScheduleCompanionEventKind;
  scheduled_at: number;
  status: ScheduleCompanionEventStatus;
  notification_id: string | null;
  delivered_at: number | null;
  responded_at: number | null;
  created_at: number;
  updated_at: number;
  preparation_json: string | null;
  reminder_body_json: string | null;
  notified_at: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
async function getDatabase() {
  return getScheduleDatabase();
}

function fromRow(row: EventRow): ScheduleCompanionEvent {
  return {
    id: row.id,
    occurrenceId: row.occurrence_id,
    kind: row.kind,
    scheduledAt: row.scheduled_at,
    status: row.status,
    notificationId: row.notification_id ?? undefined,
    deliveredAt: row.delivered_at ?? undefined,
    respondedAt: row.responded_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function syncScheduleCompanionEvents(now = Date.now()) {
  const database = await getDatabase();
  const recoveryStartedAt = await initializeScheduleReminderRecovery(now);
  const occurrences = await loadReminderOccurrencesBetween(Math.min(now - DAY_MS, recoveryStartedAt), now + 90 * DAY_MS);
  const timestamp = Date.now();
  const notificationIdsToCancel: string[] = [];
  for (const occurrence of occurrences) {
    const desired = getScheduleCompanionEventSchedule({
      completionFollowUpEnabled: occurrence.companionEnabled,
      endAt: occurrence.endAt,
      owner: occurrence.owner ?? 'you',
      reminderAt: occurrence.reminderAt,
      startReminderEnabled: occurrence.startReminderEnabled,
    });
    const desiredKinds = new Set(desired.map((event) => event.kind));
    const existing = await database.getAllAsync<EventRow>(
      'SELECT * FROM schedule_companion_events WHERE occurrence_id = ?',
      occurrence.id,
    );
    for (const event of existing) {
      if (event.status !== 'pending' || desiredKinds.has(event.kind)) continue;
      if (event.notification_id) notificationIdsToCancel.push(event.notification_id);
      await database.runAsync(
        "DELETE FROM schedule_companion_events WHERE id = ? AND status = 'pending'",
        event.id,
      );
    }
    for (const { kind, scheduledAt } of desired) {
      if (scheduledAt < recoveryStartedAt && kind === 'upcoming' && occurrence.scheduledStartAt <= now) continue;
      const current = existing.find((event) => event.kind === kind);
      if (current?.status === 'pending' && current.scheduled_at !== scheduledAt) {
        if (current.notification_id) notificationIdsToCancel.push(current.notification_id);
        await database.runAsync(
          `UPDATE schedule_companion_events
           SET scheduled_at = ?, notification_id = NULL, preparation_json = NULL,
             reminder_body_json = NULL, notified_at = NULL, recovery_handled_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
          scheduledAt,
          timestamp,
          current.id,
        );
        continue;
      }
      if (current) continue;
      await database.runAsync(
        `INSERT INTO schedule_companion_events
          (id, occurrence_id, kind, scheduled_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        `${occurrence.id}:${kind}`,
        occurrence.id,
        kind,
        scheduledAt,
        timestamp,
        timestamp,
      );
    }
  }
  return notificationIdsToCancel;
}

export async function loadScheduleReminderEvent(eventId: string, includeDelivered = false): Promise<ScheduleReminderEvent | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<EventRow>(
    `SELECT * FROM schedule_companion_events WHERE id = ? AND (status = 'pending' OR (? = 1 AND status = 'delivered'))`, eventId, includeDelivered ? 1 : 0,
  );
  if (!row) return null;
  const occurrence = await loadScheduleOccurrence(row.occurrence_id);
  if (!occurrence || occurrence.status !== 'pending' || occurrence.owner === 'I') return null;
  const item = await loadScheduleItemById(occurrence.itemId);
  if (!item || item.status !== 'pending') return null;
  const expected = getScheduleCompanionEventSchedule({
    completionFollowUpEnabled: occurrence.companionEnabled,
    endAt: occurrence.endAt,
    owner: item.owner ?? 'you',
    reminderAt: occurrence.reminderAt,
    startReminderEnabled: item.startReminderEnabled,
  }).find((event) => event.kind === row.kind);
  if (!expected || expected.scheduledAt !== row.scheduled_at) return null;
  if (!(await shouldDeliverFollowUp(fromRow(row)))) return null;
  let preparation: ScheduleReminderPreparation | undefined;
  try {
    const saved: unknown = row.preparation_json ? JSON.parse(row.preparation_json) : undefined;
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      const candidate = saved as ScheduleReminderPreparation;
      if (candidate.scheduledAt === row.scheduled_at && candidate.itemUpdatedAt === item.updatedAt
        && typeof candidate.sessionId === 'string' && candidate.sessionId.trim()
        && ['live', 'prepared-note', 'sleep-talk'].includes(candidate.persona)
        && ['generating', 'ready', 'quiet', 'failed'].includes(candidate.state)
        && (candidate.body === undefined || typeof candidate.body === 'string')
        && (candidate.state !== 'ready' || candidate.body?.trim())) preparation = candidate;
    }
  } catch { /* Rebuild unreadable temporary preparation. */ }
  let reminderBody: ScheduleReminderEvent['reminderBody'];
  try {
    const saved: unknown = row.reminder_body_json ? JSON.parse(row.reminder_body_json) : undefined;
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      const candidate = saved as NonNullable<ScheduleReminderEvent['reminderBody']>;
      if (typeof candidate.body === 'string' && candidate.body.trim()
        && candidate.scheduledAt === row.scheduled_at && candidate.itemUpdatedAt === item.updatedAt) reminderBody = candidate;
    }
  } catch { /* An unreadable body is not a prepared reminder. */ }
  return { ...fromRow(row), occurrence, itemUpdatedAt: item.updatedAt, preparation, reminderBody, notifiedAt: row.notified_at ?? undefined };
}

/** Register the ordinary upcoming event only; callers bind this exact occurrence and item version. */
export async function ensureUpcomingScheduleReminderEvent(occurrenceId: string, now = Date.now()): Promise<ScheduleReminderEvent | null> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return null;
  const occurrence = await loadScheduleOccurrence(occurrenceId);
  if (!occurrence || occurrence.status !== 'pending' || occurrence.owner === 'I' || occurrence.reminderAt <= now) return null;
  const item = await loadScheduleItemById(occurrence.itemId);
  if (!item || item.owner === 'I' || item.status !== 'pending' || item.startReminderEnabled === false) return null;
  const eventId = `${occurrenceId}:upcoming`;
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    const database = await getDatabase();
    await database.runAsync(
      `INSERT OR IGNORE INTO schedule_companion_events
        (id, occurrence_id, kind, scheduled_at, status, created_at, updated_at)
       SELECT ?, ?, 'upcoming', ?, 'pending', ?, ? WHERE EXISTS (
         SELECT 1 FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
         WHERE o.id = ? AND o.status = 'pending' AND o.reminder_at = ?
           AND i.status = 'pending' AND i.owner != 'I' AND i.updated_at = ?
           AND COALESCE(i.start_reminder_enabled, 1) != 0)`,
      eventId, occurrenceId, occurrence.reminderAt, now, now, occurrenceId, occurrence.reminderAt, item.updatedAt,
    );
    const event = await loadScheduleReminderEvent(eventId);
    return event && event.itemUpdatedAt === item.updatedAt && event.scheduledAt > Date.now() ? event : null;
  });
  return committed.committed && canCommitBackupRestoreDataEpoch(dataEpoch) ? committed.value : null;
}

export async function loadScheduleReminderTasks(now = Date.now()) {
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE schedule_companion_events SET preparation_json = NULL
     WHERE preparation_json IS NOT NULL AND (status != 'pending' OR scheduled_at < ?)`,
    now - SCHEDULE_SEND_GRACE_MS,
  );
  const cleared = await database.runAsync(
    `UPDATE schedule_companion_events SET reminder_body_json = NULL, updated_at = ?
     WHERE reminder_body_json IS NOT NULL AND (status IN ('quiet', 'responded') OR scheduled_at < ?)`,
    now, now - SCHEDULE_SEND_GRACE_MS,
  );
  if (cleared.changes) notifyAutomaticDataSyncWorkAvailable();
  return database.getAllAsync<{ eventId: string; scheduledAt: number }>(
    `SELECT e.id AS eventId, e.scheduled_at AS scheduledAt
     FROM schedule_companion_events e
     JOIN schedule_occurrences o ON o.id = e.occurrence_id
     JOIN schedule_items i ON i.id = o.item_id AND i.owner != 'I'
     WHERE e.status = 'pending' AND o.status = 'pending' AND i.status = 'pending'
       AND e.kind IN ('upcoming', 'timeUp')
       AND (e.kind != 'upcoming' OR COALESCE(i.start_reminder_enabled, 1) != 0)
       AND e.scheduled_at >= ? ORDER BY e.scheduled_at`,
    now - SCHEDULE_SEND_GRACE_MS,
  );
}

export async function saveScheduleReminderPreparation(eventId: string, preparation: ScheduleReminderPreparation) {
  const database = await getDatabase();
  const result = await database.runAsync(
    `UPDATE schedule_companion_events SET preparation_json = ?
     WHERE id = ? AND status = 'pending' AND scheduled_at = ? AND EXISTS (
       SELECT 1 FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
       WHERE o.id = schedule_companion_events.occurrence_id AND o.status = 'pending'
         AND i.status = 'pending' AND i.owner != 'I' AND i.updated_at = ?)`,
    JSON.stringify(preparation), eventId, preparation.scheduledAt, preparation.itemUpdatedAt,
  );
  return result.changes > 0;
}

export async function saveScheduleReminderBody(event: ScheduleReminderEvent, body: string) {
  if (!body.trim()) return false;
  const database = await getDatabase();
  const result = await database.runAsync(
    `UPDATE schedule_companion_events SET reminder_body_json = ?, updated_at = ?
     WHERE id = ? AND scheduled_at = ? AND status IN ('pending', 'delivered') AND EXISTS (
       SELECT 1 FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id AND i.owner != 'I'
       WHERE o.id = schedule_companion_events.occurrence_id AND o.status = 'pending'
         AND i.status = 'pending' AND i.updated_at = ?
         AND (schedule_companion_events.kind != 'upcoming' OR (o.reminder_at = schedule_companion_events.scheduled_at
           AND COALESCE(i.start_reminder_enabled, 1) != 0)))`,
    JSON.stringify({ body, scheduledAt: event.scheduledAt, itemUpdatedAt: event.itemUpdatedAt }),
    Date.now(), event.id, event.scheduledAt, event.itemUpdatedAt,
  );
  if (result.changes) {
    notifyAutomaticDataSyncWorkAvailable();
    // Headless wakes have no mounted React sync listener. Use the existing automatic route too.
    void import('../sync/automaticDataSyncRuntime').then(({ runAndroidAutomaticDataSyncCheck }) =>
      runAndroidAutomaticDataSyncCheck({ source: 'local-change', allowFullSync: true }),
    ).catch(() => undefined);
  }
  return result.changes > 0;
}

export async function markScheduleReminderNotified(eventId: string, scheduledAt: number) {
  const database = await getDatabase();
  await database.runAsync(
    'UPDATE schedule_companion_events SET notified_at = ? WHERE id = ? AND scheduled_at = ? AND notified_at IS NULL',
    Date.now(), eventId, scheduledAt,
  );
}

export async function discardChangedScheduleReminderPreparations() {
  const database = await getDatabase();
  const rows = await database.getAllAsync<Pick<EventRow, 'id' | 'preparation_json' | 'reminder_body_json'>>(
    "SELECT id, preparation_json, reminder_body_json FROM schedule_companion_events WHERE status = 'pending' AND (preparation_json IS NOT NULL OR reminder_body_json IS NOT NULL)",
  );
  const changed: string[] = [];
  for (const row of rows) {
    const current = await loadScheduleReminderEvent(row.id);
    if (current && (!row.preparation_json || preparationMatches(current.preparation, current.scheduledAt, current.itemUpdatedAt))
      && (!row.reminder_body_json || current.reminderBody)) continue;
    await database.runAsync('UPDATE schedule_companion_events SET preparation_json = NULL, reminder_body_json = NULL, updated_at = ? WHERE id = ?', Date.now(), row.id);
    changed.push(row.id);
  }
  return changed;
}

export async function loadPendingCompanionNotificationEvents() {
  await syncScheduleCompanionEvents();
  const database = await getDatabase();
  const rows = await database.getAllAsync<EventRow>(
    `SELECT * FROM schedule_companion_events
     WHERE status = 'pending' AND notification_id IS NULL AND scheduled_at > ?
     ORDER BY scheduled_at ASC`,
    Date.now(),
  );
  const result: DueScheduleCompanionEvent[] = [];
  for (const row of rows) {
    const event = fromRow(row);
    const occurrence = await loadScheduleOccurrence(event.occurrenceId);
    if (!occurrence || occurrence.status !== 'pending') {
      await database.runAsync("UPDATE schedule_companion_events SET status = 'quiet', updated_at = ? WHERE id = ?", Date.now(), event.id);
      continue;
    }
    result.push({ ...event, occurrence });
  }
  return result;
}

export async function saveCompanionNotificationId(eventId: string, notificationId: string) {
  const database = await getDatabase();
  await database.runAsync(
    'UPDATE schedule_companion_events SET notification_id = ?, updated_at = ? WHERE id = ?',
    notificationId,
    Date.now(),
    eventId,
  );
}

export async function resetScheduleCompanionNotificationBindings() {
  const database = await getDatabase();
  const result = await database.runAsync(
    'UPDATE schedule_companion_events SET notification_id = NULL WHERE notification_id IS NOT NULL',
  );
  return result.changes;
}

async function shouldDeliverFollowUp(event: ScheduleCompanionEvent) {
  if (event.kind !== 'followUp') return true;
  const database = await getDatabase();
  const timeUp = await database.getFirstAsync<EventRow>(
    "SELECT * FROM schedule_companion_events WHERE occurrence_id = ? AND kind = 'timeUp'",
    event.occurrenceId,
  );
  return !!timeUp && timeUp.status === 'delivered';
}

export async function loadDueScheduleCompanionEvents(since = Date.now() - DAY_MS) {
  await syncScheduleCompanionEvents();
  const database = await getDatabase();
  const rows = await database.getAllAsync<EventRow>(
    `SELECT * FROM schedule_companion_events
     WHERE status = 'pending' AND scheduled_at >= ? AND scheduled_at <= ?
     ORDER BY scheduled_at ASC`,
    since,
    Date.now(),
  );
  const result: DueScheduleCompanionEvent[] = [];
  for (const row of rows) {
    const event = fromRow(row);
    if (!(await shouldDeliverFollowUp(event))) {
      if (event.kind === 'followUp') {
        await database.runAsync("UPDATE schedule_companion_events SET status = 'quiet', updated_at = ? WHERE id = ?", Date.now(), event.id);
      }
      continue;
    }
    const occurrence = await loadScheduleOccurrence(event.occurrenceId);
    if (!occurrence || occurrence.status !== 'pending') {
      await database.runAsync("UPDATE schedule_companion_events SET status = 'quiet', updated_at = ? WHERE id = ?", Date.now(), event.id);
      continue;
    }
    result.push({ ...event, occurrence });
  }
  return result;
}

export async function markScheduleCompanionEventDelivered(
  eventId: string,
  expected: Pick<ScheduleReminderEvent, 'scheduledAt' | 'itemUpdatedAt'>,
) {
  const database = await getDatabase();
  const now = Date.now();
  await database.runAsync(
    `UPDATE schedule_companion_events
     SET status = 'delivered', preparation_json = NULL, delivered_at = ?, updated_at = ?
     WHERE id = ? AND status = 'pending' AND scheduled_at = ? AND EXISTS (
       SELECT 1 FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
       WHERE o.id = schedule_companion_events.occurrence_id AND o.status = 'pending'
         AND i.status = 'pending' AND i.owner != 'I' AND i.updated_at = ?)`,
    now,
    now,
    eventId,
    expected.scheduledAt,
    expected.itemUpdatedAt,
  );
  // A saved chat body can outlive its first closeout. Keep notification recovery
  // for that same delivered event without rewriting its original deliveredAt.
  const current = await loadScheduleReminderEvent(eventId, true);
  return current?.status === 'delivered' && current.scheduledAt === expected.scheduledAt
    && current.itemUpdatedAt === expected.itemUpdatedAt;
}

export async function loadPendingScheduleCompanionResponse() {
  const database = await getDatabase();
  const row = await database.getFirstAsync<EventRow>(
    `SELECT * FROM schedule_companion_events
     WHERE status = 'delivered'
     ORDER BY delivered_at DESC LIMIT 1`,
  );
  if (!row) return null;
  const event = fromRow(row);
  const occurrence = await loadScheduleOccurrence(event.occurrenceId);
  if (!occurrence || occurrence.status !== 'pending') return null;
  return { ...event, occurrence };
}

export async function loadScheduleCompanionResponseById(eventId: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<EventRow>(
    "SELECT * FROM schedule_companion_events WHERE id = ? AND status = 'delivered'",
    eventId,
  );
  if (!row) return null;
  const event = fromRow(row);
  const occurrence = await loadScheduleOccurrence(event.occurrenceId);
  if (!occurrence || occurrence.status !== 'pending') return null;
  return { ...event, occurrence };
}

export async function respondToScheduleCompanionEvent(eventId: string) {
  const database = await getDatabase();
  const now = Date.now();
  const event = await database.getFirstAsync<EventRow>('SELECT * FROM schedule_companion_events WHERE id = ?', eventId);
  if (!event) return [] as string[];
  const kinds = getCompanionResponseKinds(event.kind);
  const placeholders = kinds.map(() => '?').join(',');
  const rows = await database.getAllAsync<EventRow>(
    `SELECT * FROM schedule_companion_events WHERE occurrence_id = ? AND kind IN (${placeholders}) AND status IN ('pending', 'delivered')`,
    event.occurrence_id,
    ...kinds,
  );
  await database.runAsync(
    `UPDATE schedule_companion_events
     SET status = 'responded', responded_at = ?, updated_at = ?
     WHERE occurrence_id = ? AND kind IN (${placeholders}) AND status IN ('pending', 'delivered')`,
    now,
    now,
    event.occurrence_id,
    ...kinds,
  );
  requestScheduleNotificationRefresh();
  return rows.map((row) => row.notification_id).filter((id): id is string => !!id);
}

export async function closeScheduleCompanionOccurrence(occurrenceId: string) {
  const database = await getDatabase();
  const now = Date.now();
  const rows = await database.getAllAsync<EventRow>(
    "SELECT * FROM schedule_companion_events WHERE occurrence_id = ? AND status IN ('pending', 'delivered')",
    occurrenceId,
  );
  await database.runAsync(
    `UPDATE schedule_companion_events
     SET status = 'responded', responded_at = ?, updated_at = ?
     WHERE occurrence_id = ? AND status IN ('pending', 'delivered')`,
    now,
    now,
    occurrenceId,
  );
  requestScheduleNotificationRefresh();
  return rows.map((row) => row.notification_id).filter((id): id is string => !!id);
}

export async function quietScheduleCompanionOccurrence(occurrenceId: string) {
  const database = await getDatabase();
  await database.runAsync(
    `UPDATE schedule_companion_events SET status = 'quiet', updated_at = ?
     WHERE occurrence_id = ? AND status IN ('pending', 'delivered')`,
    Date.now(),
    occurrenceId,
  );
}

export async function removeScheduleCompanionEvents(occurrenceIds: string[]) {
  if (!occurrenceIds.length) return [] as string[];
  const database = await getDatabase();
  const placeholders = occurrenceIds.map(() => '?').join(',');
  const rows = await database.getAllAsync<EventRow>(
    `SELECT * FROM schedule_companion_events WHERE occurrence_id IN (${placeholders})`,
    ...occurrenceIds,
  );
  await database.runAsync(
    `DELETE FROM schedule_companion_events WHERE occurrence_id IN (${placeholders})`,
    ...occurrenceIds,
  );
  return rows.map((row) => row.notification_id).filter((id): id is string => !!id);
}
