import type { BaiyunChatCareQuote, BaiyunContinuityEvent } from './continuityEvent';
import { listBaiyunContinuityLinks, listBaiyunContinuityTransitions } from './continuityLedger';
import { findChatSessionContainingMessage, loadChatSessionMessage } from '../../chat/chatStorage';
import { findFocusConversationContainingMessage } from '../../focus/focusStore';
import { isHeartCareMatter, loadHeartCareDeviceRecord } from './heartCareMatter';

export type ContinuitySourceMessage = {
  id: string;
  role: 'I' | 'you';
  content: string;
  createdAt: number;
};

export type ContinuitySourceMessages = {
  kind: 'origin' | 'related' | 'missing' | 'error';
  messages: ContinuitySourceMessage[];
  deviceRecord?: string;
  excerpts?: {
    kind: 'origin' | 'latest';
    evidence: BaiyunChatCareQuote;
    status: 'found' | 'missing' | 'changed' | 'error';
    message?: ContinuitySourceMessage;
  }[];
};

/** Diary-only exact lookup. Never infer a source from similar words or nearby times. */
export async function loadContinuitySourceMessages(events: readonly BaiyunContinuityEvent[]) {
  const cache = new Map<string, Promise<ContinuitySourceMessage | null>>();
  const readMessage = (id: string, sessionIds: readonly string[], exactSession = false) => {
    const key = JSON.stringify([id, sessionIds, exactSession]);
    let pending = cache.get(key);
    if (!pending) {
      pending = (async () => {
        const discovered = exactSession ? null : await findChatSessionContainingMessage(id);
        for (const sessionId of new Set([...(discovered ? [discovered] : []), ...sessionIds])) {
          const message = await loadChatSessionMessage(sessionId, id);
          if (message?.id === id && (message.role === 'I' || message.role === 'you')) {
            return { id, role: message.role, content: message.content, createdAt: message.createdAt };
          }
        }
        const focus = await findFocusConversationContainingMessage(id);
        const log = (!exactSession || focus && sessionIds.includes(focus.sessionId))
          ? focus?.logs.find((entry) => entry.id === id) : undefined;
        return log && (log.role === 'I' || log.role === 'you')
          ? { id, role: log.role, content: log.content, createdAt: log.createdAt } : null;
      })();
      cache.set(key, pending);
    }
    return pending;
  };
  const result: Record<string, ContinuitySourceMessages> = {};
  for (const event of events) {
    let deviceRecord: string | undefined;
    if (isHeartCareMatter(event)) {
      try { deviceRecord = await loadHeartCareDeviceRecord(event); }
      catch { result[event.id] = { kind: 'error', messages: [] }; continue; }
      if (!event.careEvidence) {
        result[event.id] = { kind: 'origin', deviceRecord, messages: [] }; continue;
      }
    }
    if ((event.schemaVersion === 3 || isHeartCareMatter(event)) && event.careEvidence) {
      const excerpts: NonNullable<ContinuitySourceMessages['excerpts']> = [];
      for (const kind of ['origin', 'latest'] as const) {
        const evidence = event.careEvidence[kind];
        if (!evidence) continue;
        try {
          const message = await readMessage(evidence.messageId, [evidence.sessionId], true);
          if (!message || message.role !== 'you' || message.createdAt !== evidence.sentAt) {
            excerpts.push({ kind, evidence, status: 'missing' });
          } else {
            excerpts.push({ kind, evidence, message,
              status: message.content.includes(evidence.quote) ? 'found' : 'changed' });
          }
        } catch {
          excerpts.push({ kind, evidence, status: 'error' });
        }
      }
      result[event.id] = { kind: 'origin', deviceRecord, excerpts,
        messages: excerpts.flatMap(excerpt => excerpt.message ? [excerpt.message] : []) };
      continue;
    }
    try {
      const links = await listBaiyunContinuityLinks(event.id, true);
      const sessions = links.filter((link) => link.targetKind === 'chat_session').map((link) => link.targetId);
      const origin = await readMessage(event.source.sourceId, sessions);
      if (origin) {
        result[event.id] = { kind: 'origin', messages: [origin] };
        continue;
      }
      // Older system-triggered cards may only link the delivered reminder, not a you message.
      const messageLinks = links.filter((link) => link.targetKind === 'chat_message')
        .sort((left, right) => left.createdAt - right.createdAt);
      const firstAt = messageLinks[0]?.createdAt;
      const ids = messageLinks.filter((link) => link.createdAt === firstAt).map((link) => link.targetId);
      if (!ids.length) {
        const transitions = await listBaiyunContinuityTransitions(event.id, true);
        const receipts = transitions.flatMap((transition) => transition.evidence
          && transition.evidence.outcome === 'succeeded'
          && ['chat_message_persisted', 'proactive_message_persisted', 'return_message_persisted']
            .includes(transition.evidence.kind) ? [transition.evidence] : []);
        const firstReceiptAt = receipts[0]?.occurredAt;
        ids.push(...receipts.filter((receipt) => receipt.occurredAt === firstReceiptAt).map((receipt) => receipt.sourceId));
      }
      const messages = (await Promise.all([...new Set(ids)].map((id) => readMessage(id, sessions))))
        .filter((message): message is ContinuitySourceMessage => message !== null);
      result[event.id] = { kind: messages.length ? 'related' : 'missing', messages };
    } catch {
      result[event.id] = { kind: 'error', messages: [] };
    }
  }
  return result;
}
