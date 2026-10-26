import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { loadChatState } from '../chat/chatStorage';
import { getScheduleDatabase } from './scheduleDatabase';
import { SCHEDULE_SEND_GRACE_MS } from './scheduleReminderTiming';

const START_KEY = 'junluo.schedule-reminder-recovery.started-at';
let starting: Promise<number> | undefined;

export function initializeScheduleReminderRecovery(now = Date.now()): Promise<number> {
  if (starting) return starting;
  starting = (async () => {
    const stored = Number(await AsyncStorage.getItem(START_KEY));
    if (stored > 0 && Number.isFinite(stored)) return stored;
    await AsyncStorage.setItem(START_KEY, String(now));
    return now;
  })().finally(() => { starting = undefined; });
  return starting;
}

export const SCHEDULE_RECOVERY_INSTRUCTION = `【没接上的提醒】
I 想提醒 you 的几件事，没能及时和 you 说上话。you 这段时间过得怎么样呢？I 有些挂念，想问问 you。`;

type RecoveryRow = {
  id: string;
  occurrenceId: string;
  title: string;
  scheduledAt: number;
  itemUpdatedAt: number;
  notifiedAt: number | null;
};

export type ScheduleRecoveryBatch = {
  sessionId: string;
  events: RecoveryRow[];
  context: string;
};

export function buildScheduleRecoveryContext(rows: RecoveryRow[], latestYouAt: number) {
  const events = rows.filter((row) => row.notifiedAt === null || latestYouAt <= row.notifiedAt);
  const groups = new Map<string, { title: string; reminders: string[] }>();
  for (const row of events) {
    const group = groups.get(row.occurrenceId) ?? { title: row.title, reminders: [] };
    const time = new Date(row.scheduledAt).toLocaleString('zh-CN', { hour12: false });
    const status = row.notifiedAt === null ? '手机未发出' : '已发出、之后尚无 you 的消息';
    group.reminders.push(`${time}：${status}；电脑情况未知`);
    groups.set(row.occurrenceId, group);
  }
  const material = [...groups.values()].map((group) => `${group.title}\n${group.reminders.join('\n')}`).join('\n\n');
  return { events, context: material ? `${SCHEDULE_RECOVERY_INSTRUCTION}\n\n${material}` : '' };
}

export async function loadScheduleRecoveryBatch(
  sessionId: string,
  currentMessages: SubjectiveMessage[] = [],
  now = Date.now(),
  readOnly = false,
): Promise<ScheduleRecoveryBatch> {
  const storedStart = readOnly ? Number(await AsyncStorage.getItem(START_KEY)) : 0;
  const startedAt = readOnly ? storedStart > 0 && Number.isFinite(storedStart) ? storedStart : now
    : await initializeScheduleReminderRecovery(now);
  const database = await getScheduleDatabase();
  const rows = await database.getAllAsync<RecoveryRow>(
    `SELECT e.id, e.occurrence_id AS occurrenceId, i.title, e.scheduled_at AS scheduledAt,
       i.updated_at AS itemUpdatedAt, e.notified_at AS notifiedAt
     FROM schedule_companion_events e
     JOIN schedule_occurrences o ON o.id = e.occurrence_id
     JOIN schedule_items i ON i.id = o.item_id
     WHERE e.scheduled_at >= ? AND e.scheduled_at < ?
       AND e.recovery_handled_at IS NULL AND e.status IN ('pending', 'delivered')
       AND o.status = 'pending' AND i.status = 'pending'
       AND ((e.kind = 'upcoming' AND e.scheduled_at = o.reminder_at)
         OR (i.companion_enabled = 1 AND i.end_at IS NOT NULL
           AND e.scheduled_at = o.scheduled_start_at + i.end_at - i.start_at
             + CASE WHEN e.kind = 'followUp' THEN 300000 ELSE 0 END
           AND (e.kind = 'timeUp' OR (e.kind = 'followUp' AND EXISTS (
             SELECT 1 FROM schedule_companion_events prior
             WHERE prior.occurrence_id = e.occurrence_id AND prior.kind = 'timeUp'
               AND prior.status = 'delivered')))))
     ORDER BY e.scheduled_at, e.id`,
    startedAt, now - SCHEDULE_SEND_GRACE_MS,
  );
  if (!rows.length) return { sessionId, events: [], context: '' };
  const chat = await loadChatState();
  const latestYouAt = [...currentMessages, ...chat.sessions.flatMap((session) => session.messages)]
    .reduce((latest, message) => message.role === 'you' && message.content.trim()
      ? Math.max(latest, message.createdAt) : latest, 0);
  return { sessionId, ...buildScheduleRecoveryContext(rows, latestYouAt) };
}

export async function acknowledgeScheduleRecoveryBatch(batch: ScheduleRecoveryBatch, savedSessionId: string) {
  if (batch.sessionId !== savedSessionId || !batch.events.length) return;
  const database = await getScheduleDatabase();
  for (const event of batch.events) {
    await database.runAsync(
      `UPDATE schedule_companion_events SET recovery_handled_at = ?
       WHERE id = ? AND scheduled_at = ? AND EXISTS (
         SELECT 1 FROM schedule_occurrences o JOIN schedule_items i ON i.id = o.item_id
         WHERE o.id = schedule_companion_events.occurrence_id AND i.updated_at = ?)`,
      Date.now(), event.id, event.scheduledAt, event.itemUpdatedAt,
    );
  }
}
