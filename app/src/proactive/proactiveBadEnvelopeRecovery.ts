import { loadBaiyunLatestBadEnvelopeSnapshot, type BaiyunLatestBadEnvelopeSnapshot } from '../ai/behavior/actionChatBadEnvelopeCache';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { appendMessagesToChatSession, loadChatSessionMessage, loadChatSessionMessageOrder } from '../chat/chatStorage';
import { emitChatMessagesAppended } from '../chat/chatMessageEvents';
import { extractCompleteProactiveLiteMessages, normalizeProactiveLiteMessages } from './proactiveLitePrompt';

function fail(code: string): never { throw new Error(`PROACTIVE_BAD_ENVELOPE_${code}`); }

function sameSnapshot(actual: BaiyunLatestBadEnvelopeSnapshot, expected: BaiyunLatestBadEnvelopeSnapshot) {
  return actual.capturedAt === expected.capturedAt && actual.rawDirectContent === expected.rawDirectContent
    && actual.proactiveSource?.opportunityId === expected.proactiveSource?.opportunityId
    && actual.proactiveSource?.requestToken === expected.proactiveSource?.requestToken
    && actual.proactiveSource?.sessionId === expected.proactiveSource?.sessionId;
}

function sameMessage(actual: SubjectiveMessage, expected: SubjectiveMessage) {
  return actual.id === expected.id && actual.role === 'I' && actual.content === expected.content
    && actual.source === 'proactive-message' && actual.createdAt === expected.createdAt;
}

export async function restoreProactiveBadEnvelope(expected: BaiyunLatestBadEnvelopeSnapshot): Promise<{
  savedCount: number; existingCount: number; sessionId: string; messageIds: string[];
}> {
  const epoch = captureBackupRestoreDataEpoch();
  const snapshot = await loadBaiyunLatestBadEnvelopeSnapshot({ strict: true });
  if (!snapshot || !sameSnapshot(snapshot, expected)) fail('SNAPSHOT_CHANGED');
  const source = snapshot.proactiveSource;
  if (!source || !source.opportunityId || !source.sessionId || !source.requestToken
    || typeof snapshot.rawDirectContent !== 'string' || !Number.isFinite(snapshot.capturedAt)) fail('SOURCE_INVALID');
  if (epoch === null || !canCommitBackupRestoreDataEpoch(epoch)) fail('EPOCH_CHANGED');

  const contents = extractCompleteProactiveLiteMessages(snapshot.rawDirectContent);
  if (!contents?.length) fail('BODY_UNCONFIRMED');
  const normalized = normalizeProactiveLiteMessages(contents);
  if (normalized.length !== contents.length) fail('BODY_FILTERED');

  const sessionId = source.sessionId;
  const naturalPrefix = `${source.opportunityId}:message:`;
  const additions: SubjectiveMessage[] = contents.map((content, index) => ({
    id: `${source.opportunityId}:bad-envelope-recovery:${encodeURIComponent(source.requestToken)}:message:${index}`,
    role: 'I', content, createdAt: snapshot.capturedAt, source: 'proactive-message',
  }));
  const order = await loadChatSessionMessageOrder(sessionId, { strict: true });
  const naturalIds = [...new Set(order.filter(entry => entry.id.startsWith(naturalPrefix)).map(entry => entry.id))];
  const exactIds = [...new Set([...naturalIds, ...additions.map(message => message.id)])];
  const rows = new Map(await Promise.all(exactIds.map(async id => [id, await loadChatSessionMessage(sessionId, id)] as const)));
  const natural = naturalIds.map(id => rows.get(id) ?? fail('SOURCE_CHAT_CHANGED'));
  const duplicateContent = (stored: SubjectiveMessage, index: number) => stored.role === 'I'
    && (stored.content === contents[index] || stored.content === normalized[index]);
  for (const message of additions) {
    const stored = rows.get(message.id);
    if (stored && !sameMessage(stored, message)) fail('ID_COLLISION');
  }
  const selected = additions.map((message, index) => {
    const duplicate = natural.find(stored => duplicateContent(stored, index));
    return duplicate ?? message;
  });
  const pending = additions.filter((message, index) => selected[index].id === message.id && !rows.get(message.id));
  let newlySavedIds = new Set<string>();

  if (pending.length) {
    await appendMessagesToChatSession(sessionId, pending, {
      dataEpoch: epoch, requireActiveSession: true,
      beforeAppend: async current => {
        if (!canCommitBackupRestoreDataEpoch(epoch)) fail('EPOCH_CHANGED');
        const currentNatural = current.filter(message => message.id.startsWith(naturalPrefix));
        if (currentNatural.length !== natural.length || natural.some(previous => !currentNatural.some(message => (
          message.id === previous.id && message.role === previous.role && message.content === previous.content
        )))) fail('SOURCE_CHAT_CHANGED');
        newlySavedIds = new Set();
        for (const message of additions) {
          const stored = current.find(item => item.id === message.id);
          if (stored && !sameMessage(stored, message)) fail('ID_COLLISION');
          if (rows.get(message.id) && !stored) fail('SOURCE_CHAT_CHANGED');
        }
        for (const message of pending) {
          const index = additions.findIndex(addition => addition.id === message.id);
          if (currentNatural.some(stored => duplicateContent(stored, index))) fail('SOURCE_CHAT_CHANGED');
          if (!current.some(stored => stored.id === message.id)) newlySavedIds.add(message.id);
        }
        return true;
      },
    });
  }

  if (!canCommitBackupRestoreDataEpoch(epoch)) fail('EPOCH_CHANGED');
  const confirmed = await Promise.all(selected.map(async message => {
    const stored = await loadChatSessionMessage(sessionId, message.id);
    if (!stored || stored.role !== 'I' || stored.content !== message.content
      || (message.id.startsWith(`${source.opportunityId}:bad-envelope-recovery:`) && !sameMessage(stored, message))) fail('SAVE_UNCONFIRMED');
    return stored;
  }));
  if (!canCommitBackupRestoreDataEpoch(epoch)) fail('EPOCH_CHANGED');
  // Re-emit confirmed recovery IDs after an unknown acknowledgement, without allocating new IDs.
  const recovered = confirmed.filter(message => additions.some(addition => addition.id === message.id));
  if (recovered.length) emitChatMessagesAppended({ sessionId, messages: recovered, source: 'proactive-message' });
  return { savedCount: newlySavedIds.size, existingCount: contents.length - newlySavedIds.size,
    sessionId, messageIds: confirmed.map(message => message.id) };
}
