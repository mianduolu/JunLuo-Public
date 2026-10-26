import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { getChatReminderOccurrence } from '../schedule/chatReminderStore';

/** Only reminders referenced by the selected real chat messages, not a store scan. */
export async function reminderExecutionMaterial(messages: readonly SubjectiveMessage[]) {
  const reminders: Record<string, unknown>[] = [];
  const ids = new Set(messages.flatMap(message => message.reminderOccurrenceId ? [message.reminderOccurrenceId] : []));
  for (const id of ids) {
    const record = await getChatReminderOccurrence(id);
    if (!record) continue;
    const meta = record.chatReminder;
    const row = { title: record.title, time: new Date(record.triggerAt).toISOString(), mode: meta.mode,
      ...(meta.terminalReason ? { result: meta.terminalReason } : {}),
      ...(meta.musicEvidence ? { music: meta.musicEvidence.state } : {}),
      ...(meta.musicControl ? { action: meta.musicControl.action, actionTime: new Date(meta.musicControl.at).toISOString(),
        ...(meta.musicControl.minutes ? { minutes: meta.musicControl.minutes } : {}) } : {}) };
    if (JSON.stringify({ reminderResults: [...reminders, row] }).length > 4000) break;
    reminders.push(row);
  }
  return reminders.length ? JSON.stringify({ reminderResults: reminders }) : '';
}
