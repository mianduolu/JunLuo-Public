import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { ContactMaterialEntry } from '../proactive/unifiedContactMaterials';
import { fingerprintPromptText } from '../ai/promptCacheMetrics';
import { loadChatSessionMessage } from '../chat/chatStorage';
import { loadScheduleReminderEvent } from './scheduleCompanionStore';

const PREFIX = 'schedule-progress:';
export const isChatScheduleProgressId = (id: string) => id.startsWith(PREFIX);

export async function loadChatScheduleProgress(ref: { id: string; version?: string }, now = Date.now()): Promise<ContactMaterialEntry | null> {
  if (!isChatScheduleProgressId(ref.id)) return null;
  let source: unknown;
  try { source = JSON.parse(ref.id.slice(PREFIX.length)); } catch { return null; }
  if (!Array.isArray(source) || source.length !== 3 || !source.every(value => typeof value === 'string')) return null;
  const [sessionId, messageId, eventId] = source as string[];
  const message = await loadChatSessionMessage(sessionId, messageId);
  if (!message || message.role !== 'I' || message.deliveryStatus === 'failed'
    || message.source !== 'schedule-companion' || message.scheduleCompanionEventId !== eventId
    || message.scheduleCompanionKind !== 'timeUp' || message.createdAt > now) return null;
  const event = await loadScheduleReminderEvent(eventId, true);
  if (!event || event.kind !== 'timeUp' || event.status !== 'delivered' || event.occurrence.owner === 'I'
    || event.occurrence.status !== 'pending' || event.scheduledAt > now) return null;
  const text = JSON.stringify({ subject: 'you', title: event.occurrence.title,
    startAt: event.occurrence.scheduledStartAt, endAt: event.occurrence.endAt,
    status: 'unknown', reminderSentAt: message.createdAt });
  const version = fingerprintPromptText(JSON.stringify([text, message.id, message.content, event.itemUpdatedAt]));
  if (ref.version !== undefined && version !== ref.version) return null;
  return { id: ref.id, version, text, occurredAt: message.createdAt, sameSource: event.occurrenceId };
}

/** Only already delivered questions from the existing recent conversation; no extra clock or whole-history scan. */
export async function prepareChatScheduleProgress(sessionId: string, messages: readonly SubjectiveMessage[], now = Date.now()) {
  const entries: ContactMaterialEntry[] = [];
  for (const message of messages) {
    if (message.role !== 'I' || message.scheduleCompanionKind !== 'timeUp' || !message.scheduleCompanionEventId
      || messages.some(reply => reply.role === 'you' && reply.createdAt >= message.createdAt && reply.replyTo?.id === message.id)) continue;
    const entry = await loadChatScheduleProgress({ id: PREFIX + JSON.stringify([sessionId, message.id, message.scheduleCompanionEventId]) }, now);
    if (entry) entries.push(entry);
  }
  return entries;
}
