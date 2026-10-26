import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { loadPrimaryChatSession } from '../chat/chatStorage';

export function reminderNormalConversation(messages: readonly SubjectiveMessage[]) {
  return messages.filter(message => !!message.content.trim() && (message.role === 'I' || message.role === 'you')
    && message.deliveryStatus !== 'failed' && !message.toolCallCards?.length && !message.theaterBackstage
    && !message.expensePlanCard && !message.reminderPlanCard && !message.reminderOccurrenceId).slice(-6);
}
export function reminderConversationRevision(messages: readonly SubjectiveMessage[]) {
  return JSON.stringify(reminderNormalConversation(messages).map(message => [message.id, message.role, message.createdAt, message.content]));
}
export async function loadReminderConversationRevision() {
  const session = await loadPrimaryChatSession({ messageLimit: 50 });
  return reminderConversationRevision(session?.messages ?? []);
}
