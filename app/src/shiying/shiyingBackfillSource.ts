import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { loadChatSessionMessageOrder, loadChatSessionMessagePage, loadChatStateFast, type ChatMessagePage } from '../chat/chatStorage';
import { assertShiyingHash } from './shiyingContract';
import { projectShiyingChatMessage } from './shiyingChatSource';
import { getShiyingCoverageKnowledge, type ShiyingCoverageKnowledgeV1 } from './shiyingStore';
import {
  planShiyingBackfillDays, validateSelectedShiyingBackfillLifeDates,
  type ShiyingBackfillPlanInputV1, type ShiyingBackfillReadDayV1,
} from './shiyingBackfillPlan';
import { addShiyingLifeDates, compareShiyingMessageCursor, getShiyingLifeDateStartAt } from './shiyingWindow';

const PAGE_SIZE = 100;
export type ShiyingBackfillReadPort = {
  loadSnapshot(): Promise<{ sessions: Array<{ id: string; messageCount?: number }> }>;
  loadMessageOrder(sessionId: string): Promise<Array<{ id: string; createdAt: number }>>;
  loadPage(sessionId: string, options: { limit: number; beforeIndex: number; waitForPendingWrites: false }): Promise<ChatMessagePage>;
  getCoverage(input: { messageCreatedAtStart: number; messageCreatedAtEnd: number }): Promise<ShiyingCoverageKnowledgeV1>;
};
const defaultPort: ShiyingBackfillReadPort = {
  loadSnapshot: () => loadChatStateFast({ activeMessageLimit: 1 }),
  loadMessageOrder: sessionId => loadChatSessionMessageOrder(sessionId, { strict: true }),
  loadPage: (sessionId, options) => loadChatSessionMessagePage(sessionId, options),
  getCoverage: getShiyingCoverageKnowledge,
};
function sourceError(code: string, sessionId?: string, pageIndex?: number): never {
  throw new Error(`shiying_backfill_source_${code}${sessionId ? `:${sessionId}` : ''}${pageIndex === undefined ? '' : `:${pageIndex}`}`);
}
function assertIdentity(id: unknown, code: string, sessionId?: string) {
  if (typeof id !== 'string' || !id || id !== id.trim() || id.length > 512) sourceError(code, sessionId);
}
function assertTime(time: unknown, code: string, sessionId?: string) {
  if (!Number.isSafeInteger(time) || (time as number) < 0) sourceError(code, sessionId);
}
export function shiyingBackfillSourceIdentity(source: { sessionId: string; messageId: string; contentHash: string }) {
  return JSON.stringify([source.sessionId, source.messageId, source.contentHash]);
}

/** Explicit preview only. Reads selected pages, never a whole-session fallback. */
export async function previewShiyingBackfill(
  input: ShiyingBackfillPlanInputV1,
  ports: Partial<ShiyingBackfillReadPort> = {},
) {
  const lifeDates = validateSelectedShiyingBackfillLifeDates(input.lifeDates, input.triggeredAt);
  if (!lifeDates.length) return planShiyingBackfillDays(input, []);
  const port = { ...defaultPort, ...ports };
  let snapshot: Awaited<ReturnType<ShiyingBackfillReadPort['loadSnapshot']>>;
  try { snapshot = await port.loadSnapshot(); } catch { sourceError('snapshot_load'); }
  if (!snapshot || !Array.isArray(snapshot.sessions)) sourceError('snapshot_invalid');
  const sessionIds = new Set<string>();
  const sessions = snapshot.sessions.map(session => {
    if (!session || typeof session !== 'object') sourceError('session_invalid');
    assertIdentity(session.id, 'session_id');
    if (sessionIds.has(session.id)) sourceError('session_duplicate', session.id);
    sessionIds.add(session.id);
    assertTime(session.messageCount, 'session_count', session.id);
    return { sessionId: session.id, messageCount: session.messageCount! };
  }).sort((left, right) => left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0);
  const frozen = [] as Array<{ sessionId: string; messageCount: number; order: Array<{ id: string; createdAt: number }> }>;
  for (const session of sessions) {
    if (!session.messageCount) continue;
    let order: Awaited<ReturnType<ShiyingBackfillReadPort['loadMessageOrder']>>;
    try { order = await port.loadMessageOrder(session.sessionId); } catch { sourceError('order_load', session.sessionId); }
    if (!Array.isArray(order) || order.length !== session.messageCount) sourceError('order_count', session.sessionId);
    const ids = new Set<string>();
    let previousAt = -1;
    const copiedOrder = order.map(item => {
      if (!item || typeof item !== 'object') sourceError('order_invalid', session.sessionId);
      assertIdentity(item.id, 'order_id', session.sessionId);
      assertTime(item.createdAt, 'order_time', session.sessionId);
      if (ids.has(item.id) || item.createdAt < previousAt) sourceError('order_conflict', session.sessionId);
      ids.add(item.id); previousAt = item.createdAt;
      return { id: item.id, createdAt: item.createdAt };
    });
    frozen.push({ ...session, order: copiedOrder });
  }
  const days: ShiyingBackfillReadDayV1[] = lifeDates.map(lifeDate => ({
    lifeDate, scanFloorAt: getShiyingLifeDateStartAt(lifeDate),
    scanCeilingAt: getShiyingLifeDateStartAt(addShiyingLifeDates(lifeDate, 1)),
    windowEndCursor: null, durableMessageCount: 0, eligibleMessageCount: 0, messages: [],
  }));
  const durable = new Map<string, Array<{ sessionId: string; message: SubjectiveMessage }>>();
  for (const day of days) durable.set(day.lifeDate, []);
  for (const session of frozen) {
    const pageEnds = new Set<number>();
    for (let index = 0; index < session.order.length; index += 1) {
      const time = session.order[index].createdAt;
      if (days.some(day => time >= day.scanFloorAt && time < day.scanCeilingAt)) {
        pageEnds.add(session.messageCount - Math.floor((session.messageCount - 1 - index) / PAGE_SIZE) * PAGE_SIZE);
      }
    }
    for (const beforeIndex of [...pageEnds].sort((left, right) => left - right)) {
      let page: ChatMessagePage;
      try { page = await port.loadPage(session.sessionId, { limit: PAGE_SIZE, beforeIndex, waitForPendingWrites: false }); }
      catch { sourceError('page_load', session.sessionId, beforeIndex); }
      const expectedStart = Math.max(0, beforeIndex - PAGE_SIZE);
      if (!page || !Number.isSafeInteger(page.totalCount) || page.totalCount < session.messageCount
        || page.startIndex !== expectedStart || !Array.isArray(page.messages)
        || page.messages.length !== beforeIndex - expectedStart) sourceError('page_incomplete', session.sessionId, beforeIndex);
      for (let index = 0; index < page.messages.length; index += 1) {
        const message = page.messages[index];
        const identity = session.order[expectedStart + index];
        if (!message || typeof message !== 'object' || message.id !== identity.id
          || message.createdAt !== identity.createdAt) sourceError('page_drift', session.sessionId, beforeIndex);
        if (typeof message.content !== 'string') sourceError('message_content', session.sessionId, beforeIndex);
        if (message.role !== 'I' && message.role !== 'you') sourceError('message_role', session.sessionId, beforeIndex);
        const day = days.find(value => message.createdAt >= value.scanFloorAt && message.createdAt < value.scanCeilingAt);
        if (day) durable.get(day.lifeDate)!.push({ sessionId: session.sessionId, message });
      }
    }
  }
  for (const day of days) {
    const records = durable.get(day.lifeDate)!;
    const sorted = records.sort((left, right) => compareShiyingMessageCursor(
      { sessionId: left.sessionId, messageId: left.message.id, messageCreatedAt: left.message.createdAt },
      { sessionId: right.sessionId, messageId: right.message.id, messageCreatedAt: right.message.createdAt },
    ));
    day.durableMessageCount = sorted.length;
    const last = sorted[sorted.length - 1];
    day.windowEndCursor = last ? { sessionId: last.sessionId, messageId: last.message.id, messageCreatedAt: last.message.createdAt } : null;
    let knowledge: ShiyingCoverageKnowledgeV1;
    try { knowledge = await port.getCoverage({ messageCreatedAtStart: day.scanFloorAt, messageCreatedAtEnd: day.scanCeilingAt - 1 }); }
    catch { sourceError('coverage_load'); }
    if (!knowledge || !Array.isArray(knowledge.coveredSources)) sourceError('coverage_invalid');
    const covered = new Set<string>();
    for (const source of knowledge.coveredSources) {
      assertIdentity(source.sessionId, 'coverage_session'); assertIdentity(source.messageId, 'coverage_message', source.sessionId);
      assertTime(source.messageCreatedAt, 'coverage_time', source.sessionId);
      if (source.role !== 'I' && source.role !== 'you') sourceError('coverage_role', source.sessionId);
      try { assertShiyingHash(source.contentHash, 'backfill_coverage_hash'); } catch { sourceError('coverage_hash', source.sessionId); }
      covered.add(shiyingBackfillSourceIdentity(source));
    }
    for (const record of sorted) {
      const projected = projectShiyingChatMessage(record.sessionId, record.message).material;
      if (!projected) continue;
      day.eligibleMessageCount += 1;
      if (!covered.has(shiyingBackfillSourceIdentity(projected))) day.messages.push(projected);
    }
  }
  return planShiyingBackfillDays(input, days);
}
