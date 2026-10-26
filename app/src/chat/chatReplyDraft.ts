import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { BodySignalCareDoorbellPreparation } from '../bodySignal/bodySignalCareDoorbellPolicy';
import type { PostRecallReference } from '../posts/baiyunPostKnown';
import type { ContactChatHandoff } from '../proactive/unifiedContactHandoff';
import type { WebVoyageChatHandoff } from '../proactive/webVoyageChatHandoff';
import type { ChatImageCardSources } from './chatImageRecord';
import type { ReadingMessageSource } from './chatReadingReferences';

// One local, already generated reply. It is neither chat history nor a model task.
export const CHAT_REPLY_DRAFT_KEY = 'junluo.chat.pendingReply.v1';

export type ChatReplyDraft = {
  version: 1;
  replyId: string;
  sessionId: string;
  source: { messageId: string; revision: string };
  turnSources: Array<{ messageId: string; revision: string }>;
  messages: SubjectiveMessage[];
  startedAt: number;
  sleepingSourceIds: string[];
  sources: {
    reading?: ReadingMessageSource[];
    readingCommand?: { id: string; revision: string };
    post?: PostRecallReference;
    image?: { sources: ChatImageCardSources; imageNumber: number; accessAtUse?: string; initiallyUnavailable: boolean };
    bodyCare?: BodySignalCareDoorbellPreparation;
    contact?: ContactChatHandoff;
    web?: WebVoyageChatHandoff;
  };
};

/** Delivery flags and device-local attachment paths do not change the original turn. */
export function chatReplyDraftSourceRevision(message: SubjectiveMessage): string {
  return JSON.stringify([message.id, message.role, message.content, message.createdAt,
    message.replyTo, message.readingReference,
    message.voice ? [message.voice.durationMs, message.voice.transcript, message.voice.transcriptionStatus] : null,
    message.images?.map(image => [image.id, image.cacheId, image.name, image.mimeType,
      image.size, image.width, image.height, image.source, image.createdAt])]);
}

export function readChatReplyDraft(raw: string | null): ChatReplyDraft | null {
  if (raw === null) return null;
  const draft = JSON.parse(raw) as ChatReplyDraft;
  if (!draft || draft.version !== 1 || !draft.replyId || !draft.sessionId
    || !draft.source?.messageId || typeof draft.source.revision !== 'string'
    || !Number.isFinite(draft.startedAt) || !Array.isArray(draft.sleepingSourceIds)
    || !Array.isArray(draft.turnSources) || draft.turnSources.some(source => !source?.messageId || typeof source.revision !== 'string')
    || !draft.sources || !Array.isArray(draft.messages) || !draft.messages.length
    || new Set(draft.messages.map(message => message?.id)).size !== draft.messages.length
    || draft.messages.some(message => !message?.id || message.role !== 'I'
      || typeof message.content !== 'string' || !Number.isFinite(message.createdAt))) {
    throw new Error('chat_reply_draft_invalid');
  }
  return draft;
}

export function isChatReplyDraftSourceCurrent(draft: ChatReplyDraft, messages: readonly SubjectiveMessage[]) {
  const source = messages.find(message => message.id === draft.source.messageId);
  return !!source && source.role === 'you' && source.deliveryStatus !== 'failed'
    && chatReplyDraftSourceRevision(source) === draft.source.revision
    && draft.turnSources.every(ref => {
      const message = messages.find(value => value.id === ref.messageId);
      return !!message && message.role === 'you' && message.deliveryStatus !== 'failed'
        && chatReplyDraftSourceRevision(message) === ref.revision;
    })
    && messages.findLast(message => message.role === 'you')?.id === source.id;
}

/** A same-ID edit is never overwritten by the old generated body. */
export function chatReplyDraftBodyState(draft: ChatReplyDraft, messages: readonly SubjectiveMessage[]) {
  const saved = new Map(messages.map(message => [message.id, message]));
  let complete = true;
  for (const message of draft.messages) {
    const actual = saved.get(message.id);
    if (!actual) { complete = false; continue; }
    if (actual.role !== 'I' || actual.content !== message.content || actual.createdAt !== message.createdAt) return 'changed';
  }
  return complete ? 'complete' : 'incomplete';
}
