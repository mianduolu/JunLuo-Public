import * as Notifications from 'expo-notifications';

import { loadAssistantState } from '../ai/assistantState';
import { createIMessagesFromApiResponse } from '../ai/subjectiveMessages';
import type { BackendEvent } from '../backend/backendClient';
import { appendMessagesToChatSession, loadChatState } from '../chat/chatStorage';
import { recordActiveMessageDelivery, requestActiveMessageSlot } from '../proactive/activeMessageCoordinator';
import { loadProactiveMessageSettings } from '../proactive/proactiveMessages';

async function notifyLifeMessage(messages: string[]) {
  const settings = await loadProactiveMessageSettings();
  const first = messages[0]?.trim();
  const body = settings.notificationPreview === 'full' && first ? first : '白云小姐给你留了句话';
  try {
    return await Notifications.scheduleNotificationAsync({
      content: { title: '白云小姐', body, data: { kind: 'life-message' } },
      trigger: null,
    });
  } catch {
    // Notification availability should not block chat insertion.
  }
}

async function deliverLifeMessage(event: BackendEvent) {
  if (event.type !== 'life_message_due') return 0;
  const assistantState = await loadAssistantState();
  if (assistantState.lifeMode === 'sleeping') return 0;
  const rawMessages = Array.isArray(event.payload.messages)
    ? event.payload.messages.filter((item): item is string => typeof item === 'string')
    : [];
  if (!rawMessages.length) return 0;
  const slot = await requestActiveMessageSlot({
    messageCount: rawMessages.length,
    priority: 'soft',
    source: 'life-message',
    topicKey: event.id,
  });
  if (!slot.allowed) return 0;
  const additions = createIMessagesFromApiResponse(rawMessages, {
    source: 'life-message',
  });
  if (!additions.length) return 0;
  const { sessions, activeSessionId } = await loadChatState();
  const active = sessions.find((session) => session.id === activeSessionId);
  if (!active) return 0;
  const existingLifeIds = new Set(active.messages.map((message) => message.id));
  const freshAdditions = additions.filter((message) => !existingLifeIds.has(message.id));
  if (!freshAdditions.length) return 0;
  const saved = await appendMessagesToChatSession(active.id, freshAdditions, { activeSessionId });
  const savedIds = new Set(saved.messages.map((message) => message.id));
  const persisted = freshAdditions.filter((message) => savedIds.has(message.id));
  if (!persisted.length) {
    return 0;
  }
  await recordActiveMessageDelivery({
    messageCount: persisted.length,
    priority: 'soft',
    source: 'life-message',
    topicKey: event.id,
  });
  await notifyLifeMessage(
    persisted.map((message) => message.content),
  );
  return persisted.length;
}

export async function deliverBackendLifeEvents(events: BackendEvent[]) {
  let inserted = 0;
  for (const event of events) {
    inserted += await deliverLifeMessage(event);
  }
  return inserted;
}
