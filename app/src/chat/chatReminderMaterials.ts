import type { ChatReminderPlanCard, ReminderPlanResult } from './chatReminderPlan';
import type { JunLuoToolResult } from '../tools/toolTypes';

function fields(row: ChatReminderPlanCard['rows'][number]) {
  const value = row.state === 'saved' ? row.result : row.draft ?? row.expected;
  if (!value) return {};
  const d = new Date(value.triggerAt);
  const note = 'note' in value ? value.note : value.chatReminder?.note;
  return { title: value.title, date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    clock: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    mode: 'mode' in value ? value.mode : value.chatReminder?.mode ?? value.soundMode,
    ...(note ? { note: note.slice(0, 180) } : {}),
    ...(value.musicSong ? { song: { title: value.musicSong.name, artist: value.musicSong.artist } } : {}) };
}
export function reminderPlanHistoryMaterial(card: ChatReminderPlanCard) {
  const reminders: Record<string, unknown>[] = [];
  for (const row of card.rows) {
    const item = { action: row.action, scope: row.scope, status: row.state, ...fields(row), ...(row.code ? { code: row.code } : {}) };
    if (JSON.stringify({ reminderPlanCard: { status: card.status, reminders: [...reminders, item] } }).length > 4000) break;
    reminders.push(item);
  }
  return JSON.stringify({ reminderPlanCard: { status: card.status, reminders,
    ...(reminders.length < card.rows.length ? { remindersOmitted: true } : {}) } });
}
export function reminderPlanSaveReceipts(messageId: string, results: ReminderPlanResult[], card: ChatReminderPlanCard): JunLuoToolResult[] {
  return results.map((row, index) => {
    const original = card.rows.find(item => item.id === row.id)!;
    const data = { item: index + 1, action: row.action, status: row.state, ...fields(original), ...(row.code ? { code: row.code } : {}) };
    return { callId: `reminder-save-${messageId}-${index}`, toolId: 'reminder.save_plan', ok: row.state === 'saved',
      status: row.state === 'saved' ? 'success' : 'error', summary: JSON.stringify(data), data,
      startedAt: Date.now(), finishedAt: Date.now() };
  });
}
