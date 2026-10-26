import { DeviceEventEmitter } from 'react-native';

import type { SubjectiveMessage } from '../ai/subjectiveMessages';

export const CHAT_MESSAGES_APPENDED_EVENT = 'junluoChatMessagesAppended';

export type ChatMessagesAppendedEvent = {
  messages: SubjectiveMessage[];
  sessionId: string;
  source?: string;
};

export function emitChatMessagesAppended(event: ChatMessagesAppendedEvent) {
  if (!event.sessionId || !event.messages.length) return;
  DeviceEventEmitter.emit(CHAT_MESSAGES_APPENDED_EVENT, event);
}
