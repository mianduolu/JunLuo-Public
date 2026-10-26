import { baiyunExpressionLibrary } from '../ai/persona/expressionLibrary';
import {
  loadStickerLibrary,
  pickRandomSticker,
  type BaiyunStickerMoodId,
} from '../ai/persona/stickerLibrary';
import {
  createIMessagesFromApiResponse,
  type MessageSticker,
  type SubjectiveMessage,
} from '../ai/subjectiveMessages';
import { mergeSubjectiveMessages } from './chatStorage';
import { normalizeMusicKeywords } from './chatMusicLogic';
import type { useChatSessionsController } from './useChatSessionsController';

type ChatSessionsController = ReturnType<typeof useChatSessionsController>;

const ASSISTANT_BUBBLE_DELAY_MS = 320;

const STICKER_COMMAND_PATTERN = /\[\s*STICKER\s*[:：]\s*([a-z-]+)\s*\]/gi;

function isStickerMoodId(value: string): value is BaiyunStickerMoodId {
  return baiyunExpressionLibrary.some((category) => category.id === value);
}

function parseStickerCommand(contents: string[]) {
  let moodId: BaiyunStickerMoodId | null = null;
  const cleanedContents = contents.map((content) =>
    content.replace(STICKER_COMMAND_PATTERN, (_match, rawMood: string) => {
      const normalized = rawMood.trim().toLowerCase();
      if (!moodId && isStickerMoodId(normalized)) moodId = normalized;
      return '';
    }).trim(),
  );
  return { contents: cleanedContents, moodId };
}

function toMessageSticker(sticker: NonNullable<ReturnType<typeof pickRandomSticker>>): MessageSticker {
  return {
    id: sticker.id,
    moodId: sticker.moodId,
    name: sticker.name,
    uri: sticker.uri,
    width: sticker.width,
    height: sticker.height,
  };
}

export type ChatReplyDeliveryOptions = Pick<
  ChatSessionsController,
  'activeSessionRef' | 'messagesSessionIdRef' | 'messagesRef' | 'sessionsRef'
  | 'commitMessages' | 'commitSessionMessages'
> & {
  getCurrentMusicCardLimit: () => number;
  wait: (milliseconds: number) => Promise<unknown>;
};

export function createChatReplyDelivery({
  activeSessionRef,
  messagesSessionIdRef,
  messagesRef,
  sessionsRef,
  commitMessages,
  commitSessionMessages,
  getCurrentMusicCardLimit,
  wait,
}: ChatReplyDeliveryOptions) {
  const appendAssistantBubbles = async (
    contents: string[],
    metadata: Pick<SubjectiveMessage, 'theaterBackstage' | 'theaterBackstagePending' | 'pokeInteraction' | 'fallbackDiagnostics' | 'scheduleOccurrenceId' | 'source'> = {},
    musicKeywords?: string[],
    shouldContinue?: () => boolean | Promise<boolean>,
    options: {
      baseMessages?: SubjectiveMessage[]; targetSessionId?: string | null;
      preparedMessages?: SubjectiveMessage[];
      onPreparedMessages?: (messages: SubjectiveMessage[]) => void | Promise<void>;
      onFirstBubbleCommitted?: (at: number) => void;
    } = {},
  ) => {
    const targetSessionId = options.targetSessionId ?? activeSessionRef.current;
    const stickerCommand = parseStickerCommand(contents);
    const assistantMessages = options.preparedMessages ?? createIMessagesFromApiResponse(stickerCommand.contents, metadata);
    const normalizedMusicKeywords = normalizeMusicKeywords(
      getCurrentMusicCardLimit(),
      musicKeywords,
    );
    if (!options.preparedMessages && normalizedMusicKeywords.length && assistantMessages.length) {
      const musicCards = normalizedMusicKeywords.map((keyword) => ({
        keyword,
        status: 'loading' as const,
      }));
      assistantMessages[assistantMessages.length - 1] = {
        ...assistantMessages[assistantMessages.length - 1],
        musicCard: musicCards[0],
        musicCards,
      };
    }
    if (!options.preparedMessages && stickerCommand.moodId && assistantMessages.length) {
      const stickerLibrary = await loadStickerLibrary().catch(() => null);
      const sticker = stickerLibrary ? pickRandomSticker(stickerLibrary, stickerCommand.moodId) : null;
      if (sticker) {
        assistantMessages[assistantMessages.length - 1] = {
          ...assistantMessages[assistantMessages.length - 1],
          sticker: toMessageSticker(sticker),
        };
      }
    }
    await options.onPreparedMessages?.(assistantMessages);
    const insertedMessages: SubjectiveMessage[] = [];
    let firstBubbleNotified = false;
    let targetMessages = options.baseMessages ?? (
      targetSessionId && activeSessionRef.current === targetSessionId && messagesSessionIdRef.current === targetSessionId
        ? messagesRef.current
        : sessionsRef.current.find((session) => session.id === targetSessionId)?.messages ?? []
    );

    for (const [index, message] of assistantMessages.entries()) {
      if (options.preparedMessages && targetMessages.some(saved => saved.id === message.id && saved.content === message.content)) {
        insertedMessages.push(message);
        continue;
      }
      if (index > 0) await wait(ASSISTANT_BUBBLE_DELAY_MS);
      if (shouldContinue && await shouldContinue() === false) break;
      insertedMessages.push(message);
      const latestTargetMessages = targetSessionId && activeSessionRef.current === targetSessionId
        && messagesSessionIdRef.current === targetSessionId
        ? messagesRef.current
        : sessionsRef.current.find((session) => session.id === targetSessionId)?.messages ?? targetMessages;
      targetMessages = mergeSubjectiveMessages([...latestTargetMessages, message], []);
      let committed = false;
      if (activeSessionRef.current === targetSessionId && messagesSessionIdRef.current === targetSessionId) {
        committed = commitMessages(targetMessages) !== false;
      } else if (targetSessionId) {
        commitSessionMessages(targetSessionId, targetMessages);
        committed = sessionsRef.current.some(session => session.id === targetSessionId
          && session.messages.some(item => item.id === message.id));
      }
      if (committed && !firstBubbleNotified) {
        firstBubbleNotified = true;
        // This observes the list commit, not a native screen paint or durable write.
        try { options.onFirstBubbleCommitted?.(Date.now()); } catch { /* Diagnostics cannot interrupt delivery. */ }
      }
    }

    return insertedMessages;
  };

  return { appendAssistantBubbles };
}
