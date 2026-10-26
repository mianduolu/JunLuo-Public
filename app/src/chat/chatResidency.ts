export const CHAT_RESIDENCY_MESSAGE_LIMIT = 30;
export const CHAT_RESIDENCY_GRACE_PERIOD_MS = 5 * 60 * 1000;

export type ChatResidencySession<TMessage> = {
  id: string;
  messageCount?: number;
  messages: TMessage[];
  messagesLoaded?: boolean;
};

export type HiddenChatCompactionDecision = 'compact' | 'keep' | 'pending';

function getMessageCount<TMessage>(session: ChatResidencySession<TMessage>) {
  return Math.max(session.messageCount ?? session.messages.length, session.messages.length);
}

export function toChatSessionIndexResidency<
  TMessage,
  TSession extends ChatResidencySession<TMessage>,
>(session: TSession): TSession {
  return {
    ...session,
    messageCount: getMessageCount(session),
    messages: [],
    messagesLoaded: false,
  };
}

export function compactInactiveChatSessions<
  TMessage,
  TSession extends ChatResidencySession<TMessage>,
>(sessions: TSession[], activeSessionId: string) {
  return sessions.map((session) => (
    session.id === activeSessionId ? session : toChatSessionIndexResidency(session)
  ));
}

export function compactHiddenChatResidency<
  TMessage,
  TSession extends ChatResidencySession<TMessage>,
>(sessions: TSession[], activeSessionId: string, activeMessages: TMessage[]) {
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const messageCount = activeSession
    ? Math.max(getMessageCount(activeSession), activeMessages.length)
    : activeMessages.length;
  const messages = activeMessages.slice(-CHAT_RESIDENCY_MESSAGE_LIMIT);
  const loadedMessageStartIndex = Math.max(0, messageCount - messages.length);
  return {
    loadedMessageStartIndex,
    messages,
    sessions: sessions.map((session) => {
      if (session.id !== activeSessionId) return toChatSessionIndexResidency(session);
      return {
        ...session,
        messageCount,
        messages,
        messagesLoaded: loadedMessageStartIndex === 0,
      };
    }),
  };
}

export function decideHiddenChatCompaction(hiddenForMs: number, busy: boolean): HiddenChatCompactionDecision {
  if (hiddenForMs < CHAT_RESIDENCY_GRACE_PERIOD_MS) return 'keep';
  return busy ? 'pending' : 'compact';
}

export function shouldMountChatPresentation(
  active: boolean,
  visibleCompactionVersion: number,
  currentCompactionVersion: number,
) {
  return active || visibleCompactionVersion === currentCompactionVersion;
}
