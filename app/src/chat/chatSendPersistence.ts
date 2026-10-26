import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { ChatPersistResult } from './chatPersistenceCoordinator';

export type AcceptedUserMessageContinuation = {
  messageId: string;
  canRetryAfterMessages?: (messages: SubjectiveMessage[]) => boolean;
  run(): Promise<void | 'retryable_failure'>;
};

type RetryFailedMessageInput = {
  beforeRetry(): void;
  commitMessages(messages: SubjectiveMessage[]): boolean;
  configured: boolean;
  markFailed(messageId: string, error?: string): void;
  message: SubjectiveMessage;
  messages: SubjectiveMessage[];
  onBlocked(reason: 'latest_only' | 'model_not_configured'): void;
  persist(messages: SubjectiveMessage[]): Promise<ChatPersistResult>;
  replyBusy: boolean;
  requiresConfiguredModel: boolean;
  runReply(): Promise<unknown>;
};

type PersistAcceptedMessageInput = {
  continuation: AcceptedUserMessageContinuation;
  onFailed(): void;
  persist(): Promise<ChatPersistResult>;
};

export function createChatSendPersistenceCoordinator() {
  const continuations = new Map<string, AcceptedUserMessageContinuation>();
  const retryingMessageIds = new Set<string>();

  const retryFailedMessage = async (input: RetryFailedMessageInput) => {
    const { message, messages } = input;
    if (
      input.replyBusy
      || retryingMessageIds.has(message.id)
      || message.role !== 'you'
      || message.deliveryStatus !== 'failed'
    ) return;
    const messageIndex = messages.findIndex((item) => item.id === message.id);
    const continuation = continuations.get(message.id);
    if (messageIndex < 0 || (continuation?.canRetryAfterMessages && !continuation.canRetryAfterMessages(messages))
      || (messageIndex !== messages.length - 1 && !continuation?.canRetryAfterMessages?.(messages))) {
      input.onBlocked('latest_only');
      return;
    }
    if (!continuation && !input.configured && input.requiresConfiguredModel) {
      input.onBlocked('model_not_configured');
      return;
    }

    retryingMessageIds.add(message.id);
    input.beforeRetry();
    const retryMessages = messages.map((item) => item.id === message.id && item.sendPreparation !== 'sleep'
      ? { ...item, deliveryStatus: undefined, deliveryError: undefined }
      : item);
    if (!input.commitMessages(retryMessages)) {
      retryingMessageIds.delete(message.id);
      return;
    }
    try {
      if (await input.persist(retryMessages) === 'failed') {
        input.markFailed(message.id, message.deliveryError);
        return;
      }
      if (continuation) {
        const outcome = await continuation.run();
        if (outcome !== 'retryable_failure' && continuations.get(message.id) === continuation) continuations.delete(message.id);
      }
      else await input.runReply();
    } finally {
      retryingMessageIds.delete(message.id);
    }
  };

  const persistAcceptedMessage = async (input: PersistAcceptedMessageInput) => {
    const result = await input.persist();
    if (result === 'failed') {
      continuations.set(input.continuation.messageId, input.continuation);
      input.onFailed();
      return result;
    }
    continuations.delete(input.continuation.messageId);
    if (await input.continuation.run() === 'retryable_failure') {
      continuations.set(input.continuation.messageId, input.continuation);
    }
    return result;
  };

  return {
    canRetryAfterMessages: (messageId: string, messages: SubjectiveMessage[]) =>
      continuations.get(messageId)?.canRetryAfterMessages?.(messages) === true,
    forget: (messageId: string) => continuations.delete(messageId),
    remember: (continuation: AcceptedUserMessageContinuation) => {
      continuations.set(continuation.messageId, continuation);
    },
    persistAcceptedMessage,
    retryFailedMessage,
  };
}
