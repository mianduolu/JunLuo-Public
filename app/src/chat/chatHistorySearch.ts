import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { isLetterChatProjection } from './chatMessageDisplay';

export const CHAT_SEARCH_PAGE_SIZE = 50;
export const CHAT_CONTEXT_RADIUS = 30;
export type ChatHistoryQuery = { text: string; startDate?: string; endDate?: string };
export type ChatSearchHit = Pick<SubjectiveMessage, 'id' | 'role' | 'createdAt' | 'source'> & {
  excerpt: string;
  matchStart: number;
  matchLength: number;
};
export type ChatSearchCursor = { beforeIndex: number; revision: number; queryKey: string };
export type ChatSearchPage = { hits: ChatSearchHit[]; next: ChatSearchCursor | null };
export type ChatHistoryWindow = {
  messages: SubjectiveMessage[];
  startIndex: number;
  endIndex: number;
  totalCount: number;
  anchorId: string;
};
export type ChatHistoryReadPort = {
  order(): Promise<ReadonlyArray<{ id: string; createdAt: number }>>;
  page(beforeIndex: number, limit: number): Promise<SubjectiveMessage[]>;
  revision(): number;
};

function localDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效日期。');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error('请选择有效日期。');
  }
  return date;
}

export function chatHistoryDateBounds(query: ChatHistoryQuery) {
  const start = query.startDate ? localDay(query.startDate) : null;
  const end = query.endDate ? localDay(query.endDate) : start ? new Date(start) : null;
  if (start && end && end < start) throw new Error('结束日期不能早于开始日期。');
  if (end) end.setDate(end.getDate() + 1);
  return { from: start?.getTime() ?? -Infinity, until: end?.getTime() ?? Infinity };
}

// Only user-readable stored text, never serialized diagnostics, memory candidates or model materials.
export function chatHistoryVisibleText(message: SubjectiveMessage) {
  const technicalFailure = message.role === 'I' && message.deliveryStatus === 'failed' && !!message.deliveryError?.trim();
  const music = [...(message.musicCards ?? []), ...(message.musicCard ? [message.musicCard] : [])];
  const plan = message.schedulePlanCard?.plan;
  return [technicalFailure ? '' : message.content, message.voice?.transcript, message.replyTo?.content,
    message.voiceCallRecord?.summary, ...(message.voiceCallRecord?.turns.map(turn => turn.text) ?? []),
    message.sticker?.name,
    ...music.flatMap(card => [card.keyword, card.song?.name, card.song?.artist, card.song?.album]),
    message.goalTimeCreditCard?.todoTitle, message.goalTimeCreditCard?.reason,
    message.scheduleChangeCard?.title, message.scheduleChangeCard?.before, message.scheduleChangeCard?.after,
    ...(plan?.dayPlan ? plan.dayPlan.entries.flatMap(entry => [entry.title, entry.notes]) : [
      ...(plan?.scheduled.slots.map(slot => slot.displayTitle) ?? []),
      ...(plan?.scheduled.floatingCommitments.map(item => item.title) ?? []),
      ...(plan?.scheduled.unscheduled.map(item => item.task.title) ?? []),
      ...(plan?.inhibitTasks?.map(item => item.title) ?? []), ...(plan?.reviewSuggestions ?? []),
    ]),
    ...(message.toolCallCards?.flatMap(card => [card.toolName, card.resultSummary,
      card.confirmationPresentation?.summary,
      ...(card.confirmationPresentation?.fields.map(field => `${field.label}：${field.value}`) ?? []),
    ]) ?? []),
  ].filter((value): value is string => typeof value === 'string' && !!value.trim()).join('\n');
}

export function chatHistoryHit(message: SubjectiveMessage, text: string): ChatSearchHit | null {
  if (isLetterChatProjection(message)) return null;
  const visible = chatHistoryVisibleText(message);
  const fold = (value: string) => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
  const needle = fold(text.trim());
  const found = needle ? fold(visible).indexOf(needle) : -1;
  if (needle && found < 0) return null;
  const start = Math.max(0, found - 45);
  const prefix = start ? '…' : '';
  const body = visible.slice(start, Math.max(start + 160, found + needle.length));
  const excerpt = prefix + body + (start + body.length < visible.length ? '…' : '');
  return { id: message.id, role: message.role, createdAt: message.createdAt, source: message.source,
    excerpt: excerpt || (message.images?.length ? '图片' : message.voice ? '语音' : '消息记录'),
    matchStart: found < 0 ? -1 : prefix.length + found - start, matchLength: needle.length };
}

export class ChatHistoryChangedError extends Error {
  constructor() { super('聊天记录已更新，请重新查找。'); }
}

export function createChatHistoryReader(port: ChatHistoryReadPort) {
  const check = (revision: number) => { if (port.revision() !== revision) throw new ChatHistoryChangedError(); };
  return {
    async search(query: ChatHistoryQuery, cursor?: ChatSearchCursor | null): Promise<ChatSearchPage> {
      const normalized = { ...query, text: query.text.trim() };
      if (!normalized.text && !query.startDate && !query.endDate) return { hits: [], next: null };
      const { from, until } = chatHistoryDateBounds(normalized);
      const queryKey = JSON.stringify(normalized);
      const revision = port.revision();
      if (cursor && (cursor.revision !== revision || cursor.queryKey !== queryKey)) throw new ChatHistoryChangedError();
      const order = await port.order();
      check(revision);
      let beforeIndex = Math.min(cursor?.beforeIndex ?? order.length, order.length);
      const hits: ChatSearchHit[] = [];
      while (beforeIndex > 0 && hits.length < CHAT_SEARCH_PAGE_SIZE) {
        const start = Math.max(0, beforeIndex - 100);
        const positions = order.slice(start, beforeIndex);
        const hasDate = positions.some(entry => entry.createdAt >= from && entry.createdAt < until);
        const batch = hasDate ? await port.page(beforeIndex, beforeIndex - start) : [];
        check(revision);
        const byId = new Map(batch.map(message => [message.id, message]));
        for (let index = beforeIndex - 1; index >= start; index -= 1) {
          beforeIndex = index;
          const entry = order[index];
          if (entry.createdAt < from || entry.createdAt >= until) continue;
          const message = byId.get(entry.id);
          if (!message) continue;
          const hit = chatHistoryHit(message, normalized.text);
          if (hit) hits.push(hit);
          if (hits.length === CHAT_SEARCH_PAGE_SIZE) break;
        }
      }
      check(revision);
      return { hits, next: beforeIndex > 0 ? { beforeIndex, revision, queryKey } : null };
    },
    async context(messageId: string, direction?: 'older' | 'newer'): Promise<ChatHistoryWindow | null> {
      const revision = port.revision();
      const order = await port.order();
      check(revision);
      const index = order.findIndex(entry => entry.id === messageId);
      if (index < 0) return null;
      const startIndex = direction === 'newer' ? index + 1
        : Math.max(0, index - (direction === 'older' ? 61 : CHAT_CONTEXT_RADIUS));
      const endIndex = direction === 'older' ? index : Math.min(order.length,
        index + (direction === 'newer' ? 62 : CHAT_CONTEXT_RADIUS + 1));
      const messages = await port.page(endIndex, Math.max(0, endIndex - startIndex));
      check(revision);
      if (!direction && !messages.some(message => message.id === messageId)) return null;
      const anchorId = direction === 'older' ? messages.at(-1)?.id
        : direction === 'newer' ? messages[0]?.id : messageId;
      return { messages, startIndex, endIndex, totalCount: order.length, anchorId: anchorId ?? messageId };
    },
  };
}
