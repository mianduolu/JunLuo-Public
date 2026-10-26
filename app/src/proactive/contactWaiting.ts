import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { formatChatAfterglowMessageTime } from '../chat/chatAfterglowProbe';

type MessageRef = { id: string; createdAt: number; revision: string };
// Old generic proactive IDs also include body/phone care, so their subtype is unknown.
export const ORDINARY_CONTACT_ID_PREFIX = 'unified-contact:ordinary:';
/** References to existing chat only; these do not consume the six-round bookmark. */
export type ContactWaiting = {
  sessionId: string;
  firstI: MessageRef;
  latestYou: MessageRef;
  refs: MessageRef[];
};

const usable = (message: SubjectiveMessage, now: number) => message.deliveryStatus !== 'failed'
  && (message.role === 'you' || !!message.content.trim())
  && Number.isFinite(message.createdAt) && message.createdAt > 0 && message.createdAt <= now;
function refFor(message: SubjectiveMessage): MessageRef {
  const text = JSON.stringify([message.role, message.content, message.createdAt, message.source ?? null,
    message.deliveryStatus ?? null, message.pokeInteraction ?? null, message.theaterBackstage ?? null]);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return { id: message.id, createdAt: message.createdAt, revision: (hash >>> 0).toString(16) };
}

export function selectContactWaiting(sessionId: string, messages: readonly SubjectiveMessage[], now: number): ContactWaiting | undefined {
  const lastYouIndex = messages.findLastIndex(message => message.role === 'you' && message.deliveryStatus !== 'failed');
  if (lastYouIndex < 0) return;
  const latestYou = messages[lastYouIndex];
  if (!usable(latestYou, now)) return;
  const firstI = messages.slice(lastYouIndex + 1).find(message => message.role === 'I'
    && message.source === 'proactive-message' && message.id.startsWith(ORDINARY_CONTACT_ID_PREFIX)
    && message.deliveryStatus !== 'failed' && !!message.content.trim());
  if (!firstI || !usable(firstI, now) || firstI.createdAt < latestYou.createdAt) return;
  return { sessionId, latestYou: refFor(latestYou), firstI: refFor(firstI),
    refs: messages.filter(message => usable(message, now)).map(refFor) };
}

export function formatContactWaitingDuration(now: number, since?: number): string {
  if (since === undefined || !Number.isFinite(since) || since <= 0 || !Number.isFinite(now) || since > now) return '';
  const hours = Math.floor((now - since) / 3_600_000);
  if (!hours) return '不到 1 小时';
  const days = Math.floor(hours / 24);
  return [days ? `${days} 天` : '', hours % 24 ? `${hours % 24} 小时` : ''].filter(Boolean).join(' ');
}

export function formatContactWaiting(waiting: ContactWaiting | undefined, now: number): string {
  const elapsed = formatContactWaitingDuration(now, waiting?.firstI.createdAt);
  return waiting && elapsed ? `【I 来找 you 之后】\n\nI 在 ${formatChatAfterglowMessageTime(waiting.firstI.createdAt)} 来找过 you。\n到现在，已经过了 ${elapsed}，还没有收到 you 的新留言。` : '';
}

export async function loadContactWaitingMessages(sessionId: string): Promise<SubjectiveMessage[]> {
  const { loadChatSessionMessageOrder, loadChatSessionMessagePage } = await import('../chat/chatStorage');
  const { selectNearStatusConversation } = await import('../ai/assistantNearStatus');
  let beforeIndex = (await loadChatSessionMessageOrder(sessionId, { strict: true })).length;
  let messages: SubjectiveMessage[] = [];
  while (beforeIndex > 0) {
    const page = await loadChatSessionMessagePage(sessionId, { beforeIndex, limit: 60 });
    if (!page.messages.length || page.startIndex >= beforeIndex) throw Error('contact-wait-chat-unavailable');
    messages = [...page.messages, ...messages];
    const selected = selectNearStatusConversation(messages);
    if (selected.length < messages.length && selected.length)
      return messages.slice(messages.findIndex(message => message.id === selected[0].id));
    beforeIndex = page.startIndex;
  }
  const selected = selectNearStatusConversation(messages);
  return selected.length ? messages.slice(messages.findIndex(message => message.id === selected[0].id)) : messages;
}

export async function readContactWaitingMessages(waiting: ContactWaiting): Promise<SubjectiveMessage[] | null> {
  const { loadChatStateFast, loadChatSessionMessage } = await import('../chat/chatStorage');
  if ((await loadChatStateFast({ activeMessageLimit: 1 })).activeSessionId !== waiting.sessionId) return null;
  const current = selectContactWaiting(waiting.sessionId, await loadContactWaitingMessages(waiting.sessionId), Date.now());
  const sameRef = (a: MessageRef, b: MessageRef) => a.id === b.id && a.createdAt === b.createdAt && a.revision === b.revision;
  if (!current || !sameRef(current.firstI, waiting.firstI) || !sameRef(current.latestYou, waiting.latestYou)) return null;
  const messages: SubjectiveMessage[] = [];
  for (const ref of waiting.refs) {
    const message = await loadChatSessionMessage(waiting.sessionId, ref.id);
    if (!message || !usable(message, Date.now()) || !sameRef(refFor(message), ref)) return null;
    messages.push(message);
  }
  return messages;
}
