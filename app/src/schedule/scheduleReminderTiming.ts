import type { ScheduleReminderPersona } from './scheduleReminderPersona';
import type { MemoryUsageReceipt } from '../memory/memoryReplyUsage';
import type { SQLiteDatabase } from 'expo-sqlite';

export const SCHEDULE_PREPARE_AHEAD_MS = 60_000;
export const SCHEDULE_SEND_GRACE_MS = 30_000;

export type ScheduleReminderPreparation = {
  scheduledAt: number;
  itemUpdatedAt: number;
  sessionId: string;
  persona: ScheduleReminderPersona;
  state: 'generating' | 'ready' | 'quiet' | 'failed';
  body?: string;
  memoryUsage?: MemoryUsageReceipt;
};

/** Restoring a backup is not resuming the original paid request. Keep its body, drop its usage proof. */
export async function clearRestoredScheduleMemoryUsage(database: Pick<SQLiteDatabase, 'getAllAsync' | 'runAsync'>) {
  const columns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(schedule_companion_events)');
  if (!columns.some(column => column.name === 'preparation_json')) return;
  const rows = await database.getAllAsync<{ id: string; preparation_json: string }>(
    'SELECT id, preparation_json FROM schedule_companion_events WHERE preparation_json IS NOT NULL');
  for (const row of rows) {
    let preparation: Record<string, unknown>;
    try { preparation = JSON.parse(row.preparation_json); } catch { continue; }
    if (!preparation || typeof preparation !== 'object' || !('memoryUsage' in preparation)) continue;
    delete preparation.memoryUsage;
    await database.runAsync('UPDATE schedule_companion_events SET preparation_json = ? WHERE id = ?', JSON.stringify(preparation), row.id);
  }
}

export function scheduleReminderWindow(scheduledAt: number, now: number) {
  if (now > scheduledAt + SCHEDULE_SEND_GRACE_MS) return 'expired';
  if (now < scheduledAt - SCHEDULE_PREPARE_AHEAD_MS) return 'future';
  return now < scheduledAt ? 'prepare' : 'deliver';
}

export function preparationMatches(
  preparation: ScheduleReminderPreparation | undefined,
  scheduledAt: number,
  itemUpdatedAt: number,
) {
  return preparation?.scheduledAt === scheduledAt && preparation.itemUpdatedAt === itemUpdatedAt;
}
