import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { compareChatAfterglowPositions, formatChatAfterglowConversation,
  type ChatAfterglowBookmark, type ChatAfterglowCandidate, type ChatAfterglowPosition } from './chatAfterglowProbe';
import { innerMaterialKey, type ChatSupplement } from './chatAfterglowState';
import { chatExperienceRevisionValue, type PokeInteraction } from './chatPokeExperience';

type LoadMessage = (sessionId: string, id: string) => Promise<SubjectiveMessage | null>;
export const firstPaperMessageRevision = (message: SubjectiveMessage) => innerMaterialKey({
  message: chatExperienceRevisionValue(message), createdAt: message.createdAt,
  source: message.source, deliveryStatus: message.deliveryStatus, replyTo: message.replyTo,
  voiceCallRecord: message.voiceCallRecord, toolCallCards: message.toolCallCards,
});
const refOf = (message: SubjectiveMessage) => ({ id: message.id, createdAt: message.createdAt,
  revision: firstPaperMessageRevision(message) });
const usable = (message: SubjectiveMessage) => !!message.content.trim()
  && message.deliveryStatus !== 'failed' && !message.voiceCallRecord && !message.toolCallCards?.length;
const unread = (bookmark: ChatAfterglowBookmark, sessionId: string, position: ChatAfterglowPosition) =>
  position.createdAt > bookmark.activatedAt && (bookmark.lateMessages?.[sessionId]?.some(ref => ref.id === position.id)
    || !bookmark.cursors[sessionId] || compareChatAfterglowPositions(position, bookmark.cursors[sessionId]) > 0);

export async function reloadChatSupplement(supplement: ChatSupplement | undefined, loadMessage: LoadMessage) {
  if (!supplement) return true;
  for (const ref of [...supplement.unreadRefs, ...supplement.backgroundRefs]) {
    const message = await loadMessage(supplement.sessionId, ref.id);
    if (!message || message.createdAt !== ref.createdAt || !usable(message)
      || firstPaperMessageRevision(message) !== ref.revision) return false;
  }
  return true;
}

/** Called only after an existing paper opportunity is established; this never claims one. */
export async function prepareFirstPaperChat(input: {
  bookmark: ChatAfterglowBookmark;
  sessions: readonly { id: string }[];
  conversation?: ChatAfterglowCandidate<SubjectiveMessage> | null;
  throughAt: number;
  excludeIds: ReadonlySet<string>;
  loadOrder: (sessionId: string) => Promise<ChatAfterglowPosition[]>;
  loadMessage: LoadMessage;
  frozen?: ChatSupplement;
}) {
  const primary = input.conversation;
  const primaryIds = new Set(primary?.messages.map(message => message.id));
  let sessionId = input.frozen?.sessionId ?? primary?.sessionId;
  let additions: SubjectiveMessage[] = [];
  const cache = new Map<string, SubjectiveMessage | null>();
  const load = async (session: string, id: string) => {
    const key = JSON.stringify([session, id]);
    if (!cache.has(key)) cache.set(key, await input.loadMessage(session, id));
    return cache.get(key)!;
  };
  if (input.frozen) {
    if (!await reloadChatSupplement(input.frozen, load)) throw new Error('first-paper-chat-source-changed');
    additions = await Promise.all(input.frozen.unreadRefs.map(ref => load(sessionId!, ref.id))) as SubjectiveMessage[];
  } else {
    const candidates: { sessionId: string; messages: SubjectiveMessage[] }[] = [];
    for (const session of input.sessions) {
      if (sessionId && session.id !== sessionId) continue;
      const positions = (await input.loadOrder(session.id)).filter(position => position.createdAt <= input.throughAt
        && unread(input.bookmark, session.id, position) && !primaryIds.has(position.id)
        && !input.excludeIds.has(position.id)).sort(compareChatAfterglowPositions);
      const messages: SubjectiveMessage[] = [];
      for (const position of positions) {
        const message = await load(session.id, position.id);
        if (!message || compareChatAfterglowPositions(message, position) !== 0)
          throw new Error('first-paper-chat-order-changed');
        if (usable(message) && message.role === 'I' && message.source === 'proactive-message') messages.push(message);
        if (messages.length === 6) break;
      }
      if (messages.length) candidates.push({ sessionId: session.id, messages });
    }
    candidates.sort((a, b) => compareChatAfterglowPositions(a.messages[0], b.messages[0]) || a.sessionId.localeCompare(b.sessionId));
    if (candidates[0]) { sessionId = candidates[0].sessionId; additions = candidates[0].messages; }
  }
  if (!sessionId) return { maxSupplementCount: 0, select: () => ({ conversation: '', chatSupplement: undefined }) };
  const selectedSession = sessionId;
  const order = (await input.loadOrder(sessionId)).sort(compareChatAfterglowPositions);
  const variants = new Map<string, { messages: SubjectiveMessage[]; background: SubjectiveMessage[]; chatSupplement: ChatSupplement }>();
  for (let rounds = 0; rounds <= (primary?.rounds.length ?? 0); rounds++) {
    const main = primary?.rounds.slice(0, rounds).flat() ?? [];
    const through = main.at(-1)?.createdAt ?? input.throughAt;
    for (let count = 0; count <= additions.length; count++) {
      const extra = additions.slice(0, count).filter(message => message.createdAt <= through && !main.some(item => item.id === message.id));
      const messages = [...main, ...extra].sort(compareChatAfterglowPositions);
      const ids = new Set(messages.map(message => message.id));
      const background: SubjectiveMessage[] = [];
      const addBackground = async (id: string) => {
        if (background.length >= 6 || ids.has(id) || input.excludeIds.has(id) || background.some(message => message.id === id)) return;
        const position = order.find(item => item.id === id);
        if (!position || position.createdAt > through || unread(input.bookmark, selectedSession, position)) return;
        const message = await load(selectedSession, id);
        if (!message) return; // A deleted reply target is never resurrected from the reply card.
        if (compareChatAfterglowPositions(message, position) !== 0) throw new Error('first-paper-chat-order-changed');
        if (usable(message)) background.push(message);
      };
      if (input.frozen) {
        for (const ref of input.frozen.backgroundRefs) background.push((await load(selectedSession, ref.id))!);
      } else if (messages.length) {
        for (const message of messages) if (message.replyTo) await addBackground(message.replyTo.id);
        for (const position of [...order].reverse()) {
          if (background.length >= 6) break;
          if (compareChatAfterglowPositions(position, messages[0]) < 0) await addBackground(position.id);
        }
      }
      background.sort(compareChatAfterglowPositions);
      variants.set(`${rounds}:${count}`, { messages, background, chatSupplement: {
        sessionId: selectedSession, unreadRefs: extra.map(refOf), backgroundRefs: background.map(refOf),
      } });
    }
  }
  return { maxSupplementCount: additions.length,
    select(roundCount: number, supplementCount: number,
      primaryText?: string | ((messages: readonly SubjectiveMessage[]) => string), pokes: readonly PokeInteraction[] = []) {
      const selected = variants.get(`${roundCount}:${supplementCount}`)!;
      const { messages, background } = selected;
      // Keep pre-existing heart/poke annotations on the original primary text, without copying its messages.
      const extra = messages.filter(message => !primaryIds.has(message.id));
      const newText = typeof primaryText === 'function' ? primaryText(messages)
        : primaryText && !extra.length ? primaryText : formatChatAfterglowConversation(messages, pokes);
      return { chatSupplement: selected.chatSupplement, conversation: [
        background.length ? `【前文】\n${formatChatAfterglowConversation(background)}` : '',
        messages.length ? `【这次整理的新交流】\n${newText}` : '',
      ].filter(Boolean).join('\n\n') };
    },
  };
}
