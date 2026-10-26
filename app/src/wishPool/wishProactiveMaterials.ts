import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { loadChatSessionMessage, loadChatSessionMessageOrder } from '../chat/chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { fingerprintPromptText } from '../ai/promptCacheMetrics';
import type { ContactSource } from '../proactive/unifiedContact';
import { loadWishPoolSnapshot, type WishItem } from './wishPoolStore';

const SOURCE_PREFIX = 'wish-pool:candidate:';
const wishVersion = (wish: WishItem) => fingerprintPromptText(JSON.stringify([wish.owner, wish.content, wish.status, wish.updatedAt]));
export const isWishProactiveSource = (ref: ContactSource) => ref.kind === 'life' && ref.id.startsWith(SOURCE_PREFIX);
export async function wishProactiveSourcesCurrent(sources: readonly ContactSource[]) {
  const refs = sources.filter(isWishProactiveSource);
  if (!refs.length) return true;
  const snapshot = await loadWishPoolSnapshot();
  return refs.every(ref => {
    const wish = snapshot.wishes.find(item => `${SOURCE_PREFIX}${item.id}` === ref.id);
    return !!wish && wish.status === 'candidate' && wishVersion(wish) === ref.version;
  });
}

// F1 verbatim: docs/许愿池第2章接口合同与审稿.md. No summary or new instruction.
export async function loadWishProactiveMaterial(input: {
  messages: readonly SubjectiveMessage[];
}) {
  const snapshot = await loadWishPoolSnapshot();
  const wishes = snapshot.wishes.filter((wish) => wish.status === 'candidate')
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .slice(0, 3);
  const sources: ContactSource[] = wishes.map(wish => ({ kind: 'life', id: `${SOURCE_PREFIX}${wish.id}`, version: wishVersion(wish) }));
  const sourceMessages: { id: string; version: string }[] = [];
  if (!wishes.length) return { text: '', sources, sourceMessages };

  const quoteKey = (message: SubjectiveMessage) => JSON.stringify([message.role, message.content]);
  const seenQuotes = new Set(input.messages.map(quoteKey));
  const seenIds = new Set<string>();
  const orders = new Map<string, Awaited<ReturnType<typeof loadChatSessionMessageOrder>>>();
  const lines = ['【还想和 you 商量的愿望】'];
  for (const wish of wishes) {
    lines.push(`${wish.id}｜${wish.owner}｜${wish.content}`);
    const references = new Map<string, { sessionId: string; messageId: string }>();
    const addReference = (sessionId: string, messageId: string | undefined) => {
      if (messageId) references.set(JSON.stringify([sessionId, messageId]), { sessionId, messageId });
    };
    addReference(PRIMARY_CHAT_SESSION_ID, wish.sourceMessageId);
    for (const discussion of snapshot.collaboration?.discussions ?? []) {
      if (discussion.wishId !== wish.id) continue;
      let order = orders.get(discussion.conversationId);
      if (!order) {
        order = await loadChatSessionMessageOrder(discussion.conversationId);
        orders.set(discussion.conversationId, order);
      }
      for (const entry of order) {
        if (entry.createdAt >= discussion.createdAt && entry.createdAt <= discussion.updatedAt) {
          addReference(discussion.conversationId, entry.id);
        }
      }
      addReference(discussion.conversationId, discussion.sourceId);
      addReference(discussion.conversationId, discussion.lastDraftReply?.messageId);
      addReference(discussion.conversationId, discussion.reply?.messageId);
    }
    const quotes: SubjectiveMessage[] = [];
    for (const [key, reference] of references) {
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      const message = await loadChatSessionMessage(reference.sessionId, reference.messageId);
      if (!message || message.deliveryStatus === 'failed' || message.id !== reference.messageId
        || (message.role !== 'I' && message.role !== 'you') || !message.content.trim()) continue;
      const quote = quoteKey(message);
      if (seenQuotes.has(quote)) continue;
      seenQuotes.add(quote);
      quotes.push(message);
      if (reference.sessionId === PRIMARY_CHAT_SESSION_ID) sourceMessages.push({ id: message.id,
        version: fingerprintPromptText(JSON.stringify([message.role, message.content, message.createdAt])) });
    }
    quotes.sort((left, right) => left.createdAt - right.createdAt);
    lines.push(...quotes.map((message) => `之前聊到：${message.role}：${message.content}`));
  }
  lines.push('', '有些愿望，I 还悄悄惦记着，想等一个合适的时候，再问问 you。you 之前说过的难处和心意，I 也会去理解。');
  return { text: lines.join('\n'), sources, sourceMessages };
}
