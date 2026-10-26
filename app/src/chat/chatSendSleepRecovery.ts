import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import type { ChatPersistResult } from './chatPersistenceCoordinator';

type SleepSendPreparationInput = {
  message: SubjectiveMessage;
  sessionId: string;
  dataEpoch: number | null;
  current(): boolean;
  getMessages(): SubjectiveMessage[];
  commitMessages(messages: SubjectiveMessage[]): boolean;
  persist(messages: SubjectiveMessage[]): Promise<ChatPersistResult>;
  onError(message: string): void;
  prepareVoice?: (message: SubjectiveMessage) => Promise<Pick<SubjectiveMessage, 'content' | 'voice'>>;
};

/** Only the preparation before reply/tool dispatch is retried here. */
export async function prepareSavedChatSleepMessage(input: SleepSendPreparationInput): Promise<'ready' | 'failed' | 'stale'> {
  let expected = input.message;
  const currentMessage = () => {
    if (!input.current() || !canCommitBackupRestoreDataEpoch(input.dataEpoch)) return;
    const message = input.getMessages().find(item => item.id === expected.id);
    return message?.role === 'you' && message.createdAt === expected.createdAt && message.content === expected.content
      && JSON.stringify(message.voice) === JSON.stringify(expected.voice) ? message : undefined;
  };
  const fail = async (): Promise<'failed' | 'stale'> => {
    const current = currentMessage();
    if (!current) return 'stale';
    const error = '消息已保存，但回复准备暂未完成。请点这条消息旁的“重新发送”。';
    const messages = input.getMessages().map(message => message.id === current.id
      ? { ...message, deliveryStatus: 'failed' as const, deliveryError: error, sendPreparation: 'sleep' as const }
      : message);
    if (!input.commitMessages(messages)) return 'stale';
    input.onError(error);
    // If storage is still unavailable, the visible failure and RAM continuation remain.
    await input.persist(messages).catch(() => 'failed');
    return currentMessage() ? 'failed' : 'stale';
  };
  if (!currentMessage()) return 'stale';
  let preparedVoice: Pick<SubjectiveMessage, 'content' | 'voice'> | undefined;
  let sleepChat: typeof import('./chatSleepSchedule') | undefined;
  let ready = false;
  try {
    try {
      sleepChat = await import('./chatSleepSchedule');
      if (!currentMessage()) return 'stale';
      await sleepChat.acceptChatSleepMessage({ sessionId: input.sessionId, turnId: expected.id,
        sourceMessageIds: [expected.id], now: expected.createdAt, dataEpoch: input.dataEpoch });
      if (!currentMessage()) return 'stale';
      if (input.prepareVoice && expected.voice?.transcriptionStatus === 'pending') {
        preparedVoice = await input.prepareVoice(expected);
        if (!currentMessage()) return 'stale';
      }
    } catch {
      return await fail();
    }
    const current = currentMessage();
    if (!current) return 'stale';
    if (current.sendPreparation === 'sleep') {
      const prepared = { ...current, ...preparedVoice, sendPreparation: undefined, deliveryStatus: undefined, deliveryError: undefined };
      const messages = input.getMessages().map(message => message.id === current.id ? prepared : message);
      if (!input.commitMessages(messages)) return 'stale';
      expected = prepared;
      if (await input.persist(messages).catch(() => 'failed') === 'failed') return await fail();
      if (!currentMessage()) return 'stale';
    }
    ready = true;
    return 'ready';
  } finally {
    if (!ready) sleepChat?.releaseAcceptedChatSleepMessage({ sessionId: input.sessionId, turnId: input.message.id });
  }
}
