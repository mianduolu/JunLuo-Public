import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { cleanReplyTransportFormatting } from '../ai/replyTransportFormatting';

export function isLetterChatProjection(message: Pick<SubjectiveMessage, 'id' | 'source'>) {
  return message.source === 'letter' || /^letter-.+-(original|reply)$/.test(message.id);
}

export function getDisplayedChatMessageContent(message: SubjectiveMessage) {
  return message.role === 'I' ? cleanReplyTransportFormatting(message.content) : message.content;
}

export function isLatestLoadedMessage(
  messageIndex: number,
  loadedMessageStartIndex: number,
  loadedMessageCount: number,
) {
  return loadedMessageCount > 0
    && messageIndex === loadedMessageStartIndex + loadedMessageCount - 1;
}

export function hasRenderableChatMessageContent(
  message: SubjectiveMessage,
  displayedContent: string,
) {
  if (isLetterChatProjection(message)) return false;
  return !!(
    displayedContent
    || message.voice
    || message.images?.length
    || message.sticker
    || message.musicCards?.length
    || message.musicCard
    || message.toolCallCards?.length
    || message.schedulePlanCard
    || message.expensePlanCard
    || message.reminderPlanCard
    || message.goalTimeCreditCard
    || message.scheduleChangeCard
    || message.voiceCallRecord
    || (
      message.role === 'I'
      && message.deliveryStatus === 'failed'
      && message.deliveryError?.trim()
    )
  );
}

export function compactReplyText(value: string, limit = 72) {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit)}...`;
}

export function buildReplyToMessage(message: SubjectiveMessage) {
  return {
    id: message.id,
    role: message.role,
    content: compactReplyText(message.content, 140),
    createdAt: message.createdAt,
  };
}

export function getReplyAuthorLabel(role: SubjectiveMessage['role']) {
  return role === 'I' ? '白云小姐' : '小仓鼠';
}

export function formatMessageTime(createdAt: number) {
  return new Date(createdAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatChatBubbleDateTime(createdAt: number) {
  const date = new Date(createdAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
