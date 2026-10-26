import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { loadChatSessionMessageOrder, loadChatSessionMessagePage } from './chatStorage';

/** Request-only history. The caller has already saved the current real message. */
export async function loadChatRequestHistory(input: {
  sessionId: string;
  throughMessage: SubjectiveMessage;
  summarizedThroughMessageId?: string | null;
  summarizedThroughAt?: number | null;
  summaryPaused?: boolean;
  isCurrent: () => boolean;
}): Promise<SubjectiveMessage[]> {
  const assertCurrent = () => {
    if (!input.isCurrent()) throw Object.assign(new Error('chat_request_history_cancelled'), { name: 'AbortError' });
  };
  assertCurrent();
  const order = await loadChatSessionMessageOrder(input.sessionId, { strict: true });
  assertCurrent();
  const end = order.findIndex(message => message.id === input.throughMessage.id) + 1;
  if (!end) throw new Error('chat_request_history_source_missing');
  const boundary = order.findIndex(message => message.id === input.summarizedThroughMessageId);
  const safeTimeBoundary = input.summaryPaused && typeof input.summarizedThroughAt === 'number'
    ? order.slice(0, end).findIndex(message => message.createdAt > input.summarizedThroughAt!) : -1;
  const start = boundary >= 0 && boundary < end ? boundary + 1
    : input.summaryPaused ? safeTimeBoundary >= 0 ? safeTimeBoundary : Math.max(0, end - 12) : 0;
  const expected = order.slice(start, end);
  const page = await loadChatSessionMessagePage(input.sessionId, { beforeIndex: end, limit: end - start });
  assertCurrent();
  const currentOrder = await loadChatSessionMessageOrder(input.sessionId, { strict: true });
  assertCurrent();
  // A deletion/reorder during the read invalidates offsets. Later appended turns
  // remain outside this request; nothing from the resident page is merged back.
  if (currentOrder.length < end || order.slice(0, end).some((message, index) =>
    currentOrder[index]?.id !== message.id || currentOrder[index]?.createdAt !== message.createdAt)
    || page.startIndex !== start || page.messages.length !== expected.length
    || page.messages.some((message, index) => message.id !== expected[index].id)) {
    throw new Error('chat_request_history_changed');
  }
  const source = page.messages.at(-1);
  if (source && (source.id !== input.throughMessage.id || source.role !== input.throughMessage.role
    || source.content !== input.throughMessage.content || source.createdAt !== input.throughMessage.createdAt)) {
    throw new Error('chat_request_history_source_changed');
  }
  return page.messages;
}
