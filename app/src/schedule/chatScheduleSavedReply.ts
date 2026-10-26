import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { JunLuoToolResult } from '../tools/toolTypes';
import { loadChatSessionMessage } from '../chat/chatStorage';
import { prepareChatReminderBatch, type ChatReminderBatch } from './chatScheduleReminders';

export async function prepareSavedChatReminders(sessionId: string, results: readonly JunLuoToolResult[],
  messages: readonly SubjectiveMessage[]) {
  let batch: ChatReminderBatch | undefined;
  const sources: Array<{ id: string; card: string }> = [];
  const projected = [];
  for (const result of results) {
    if (result.toolId !== 'schedule.submit_day_plan') { projected.push(result); continue; }
    const data = result.data as { planId?: string; entries?: Array<{ id: string; saved: boolean; savedOccurrenceId?: string }> } | undefined;
    const source = messages.find(message => message.schedulePlanCard?.plan.id === data?.planId);
    if (!source?.schedulePlanCard?.plan.dayPlan || !['confirmed', 'conflict'].includes(source.schedulePlanCard.status)) { projected.push(result); continue; }
    const entries = source.schedulePlanCard.plan.dayPlan.entries;
    const ids = (data?.entries ?? []).filter(row => row.saved && row.savedOccurrenceId && entries.some(entry =>
      entry.id === row.id && entry.saved && entry.savedOccurrenceId === row.savedOccurrenceId)).map(row => row.savedOccurrenceId!);
    batch = await prepareChatReminderBatch(ids, 'saved');
    sources.push({ id: source.id, card: JSON.stringify(source.schedulePlanCard) });
    projected.push({ ...result, data: { ...data, reminderCandidates: batch.candidates } });
  }
  const current = async () => {
    for (const source of sources) {
      const actual = await loadChatSessionMessage(sessionId, source.id);
      if (!actual || JSON.stringify(actual.schedulePlanCard) !== source.card) return false;
    }
    return true;
  };
  const packet = JSON.stringify({ subject: 'you', toolResults: projected.map(result => ({
    toolId: result.toolId, ok: result.ok, summary: result.summary, data: result.data })) });
  const actuallyTransmitted = (materials: readonly string[]) => batch?.candidates.length
    && materials.some(material => material.includes(packet)) ? batch : undefined;
  return { batch, results: projected, current, packet, actuallyTransmitted };
}

