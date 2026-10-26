import { ensureUpcomingScheduleReminderEvent, loadScheduleReminderEvent, saveScheduleReminderBody, type ScheduleReminderEvent } from './scheduleCompanionStore';
import { loadScheduleOccurrence } from './scheduleStore';
import { CHAT_SCHEDULE_SAVED_REMINDERS, CHAT_SCHEDULE_HABIT_REMINDER } from './chatSchedulePrompts';
import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';

export type ChatReminderCandidate = { item: number; title: string; startAt: number; endAt?: number; completedCount?: number; completedAt?: number };
export type ChatReminderBatch = {
  mode: 'saved' | 'habit'; candidates: ChatReminderCandidate[]; events: ScheduleReminderEvent[];
};
export async function prepareChatReminderBatch(ids: readonly string[], mode: ChatReminderBatch['mode'],
  completed?: { completedCount: number; completedAt?: number }): Promise<ChatReminderBatch> {
  const events: ScheduleReminderEvent[] = [];
  const habits = new Set<string>();
  for (const id of new Set(ids)) {
    const occurrence = await loadScheduleOccurrence(id);
    if (!occurrence || occurrence.status !== 'pending' || occurrence.owner === 'I' || occurrence.startReminderEnabled === false) continue;
    if (occurrence.habitId && habits.has(occurrence.habitId)) continue;
    const event = await ensureUpcomingScheduleReminderEvent(id);
    if (!event) continue;
    events.push(event);
    if (occurrence.habitId) habits.add(occurrence.habitId);
  }
  return { mode, events, candidates: events.map((event, index) => ({ item: index + 1, title: event.occurrence.title,
    startAt: event.occurrence.scheduledStartAt, endAt: event.occurrence.endAt, ...completed })) };
}
export function chatReminderInstruction(batch: ChatReminderBatch | undefined) {
  if (!batch?.candidates.length) return '';
  return batch.mode === 'saved' ? CHAT_SCHEDULE_SAVED_REMINDERS
    : [CHAT_SCHEDULE_HABIT_REMINDER, CHAT_SCHEDULE_SAVED_REMINDERS.slice(CHAT_SCHEDULE_SAVED_REMINDERS.indexOf('I 把提前提醒'))].join('\n\n');
}
export function sameReminderCandidates(raw: unknown, batch: ChatReminderBatch) {
  return JSON.stringify(raw) === JSON.stringify(batch.candidates);
}
export async function commitChatReminderAnswer(raw: string, batch: ChatReminderBatch | undefined,
  input: { dataEpoch: number; isCurrent: () => boolean | Promise<boolean> }) {
  if (!batch?.candidates.length || !canCommitBackupRestoreDataEpoch(input.dataEpoch) || !await input.isCurrent()) return;
  let rows: unknown;
  try { rows = JSON.parse(raw).scheduleReminders; } catch { return; }
  if (!Array.isArray(rows)) return;
  const valid = rows.filter((row): row is { item: number; text: string } => !!row && typeof row === 'object'
    && Number.isInteger(row.item) && batch.candidates.some(candidate => candidate.item === row.item) && typeof row.text === 'string'
    && !!row.text.trim() && row.text.length <= 4000);
  const selected = new Map(valid.map(row => [row.item, row.text]));
  const minimum = batch.mode === 'habit' ? batch.candidates.length : Math.min(3, batch.candidates.length);
  if (selected.size < minimum || selected.size > Math.min(5, batch.candidates.length)) return;
  await runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
    for (const [item, text] of selected) {
      if (!await input.isCurrent()) return;
      const expected = batch.events[batch.candidates.findIndex(candidate => candidate.item === item)];
      const current = await loadScheduleReminderEvent(expected.id);
      if (!current || current.status !== 'pending' || current.itemUpdatedAt !== expected.itemUpdatedAt
        || current.scheduledAt !== expected.scheduledAt || current.scheduledAt <= Date.now()) continue;
      await saveScheduleReminderBody(current, text);
    }
  });
}

