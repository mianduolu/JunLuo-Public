import type { ChatSession } from './chatStorage';

export type ChatPersistResult = 'persisted' | 'failed';

type PersistRevisionInput = {
  revision: number;
  sessionId: string;
};

type PersistRevisionRequest = PersistRevisionInput & {
  write(): Promise<void>;
  partial?: boolean;
};

// Only in-flight local snapshots are retained; no deleted-ID history is stored here.
const pendingMessageSnapshots = new Set<{
  sessionId: string;
  remove(ids: ReadonlySet<string>): void;
}>();

export function retainChatMessageWriteSnapshot<T extends { id: string }>(sessionId: string, messages: T[]) {
  const snapshot = { messages };
  const pending = { sessionId, remove(ids: ReadonlySet<string>) {
    const kept = snapshot.messages.filter(message => !ids.has(message.id));
    if (kept.length !== snapshot.messages.length) snapshot.messages = kept;
  } };
  pendingMessageSnapshots.add(pending);
  return { get messages() { return snapshot.messages; }, release() { pendingMessageSnapshots.delete(pending); } };
}

export function invalidateChatMessageWriteSnapshots(sessionId: string, deletedMessageIds: readonly string[]) {
  const ids = new Set(deletedMessageIds);
  for (const pending of pendingMessageSnapshots) {
    if (pending.sessionId === sessionId) pending.remove(ids);
  }
}

export function retainChatSessionWriteSnapshots(sessions: ChatSession[]) {
  const snapshots = sessions.map(session => retainChatMessageWriteSnapshot(session.id, session.messages));
  return {
    get sessions() {
      return sessions.map((session, index) => {
        const messages = snapshots[index].messages;
        return messages === session.messages ? session : { ...session, messages,
          messageCount: Math.max(messages.length, (session.messageCount ?? session.messages.length) - (session.messages.length - messages.length)) };
      });
    },
    release() { snapshots.forEach(snapshot => snapshot.release()); },
  };
}

// Only IDs are held while the reply owner saves its answer. Other writes may
// still save new you messages and real tool cards, but cannot adopt this answer.
const pendingReplyIdsBySession = new Map<string, Set<string>>();

export function holdChatReplyMessageIds(sessionId: string, ids: readonly string[]) {
  const pending = pendingReplyIdsBySession.get(sessionId) ?? new Set<string>();
  ids.forEach((id) => pending.add(id));
  pendingReplyIdsBySession.set(sessionId, pending);
  return () => {
    ids.forEach((id) => pending.delete(id));
    if (!pending.size && pendingReplyIdsBySession.get(sessionId) === pending) pendingReplyIdsBySession.delete(sessionId);
  };
}

export function filterPendingChatReplyMessages<T extends { id: string }>(
  sessionId: string, messages: T[], ownedIds: readonly string[] = [],
): T[] {
  const pending = pendingReplyIdsBySession.get(sessionId);
  if (!pending?.size) return messages;
  const owned = new Set(ownedIds);
  const filtered = messages.filter((message) => !pending.has(message.id) || owned.has(message.id));
  return filtered.length === messages.length ? messages : filtered;
}

export function createChatPersistenceCoordinator() {
  const durableRevisionBySession = new Map<string, number>();
  const inFlightByVersion = new Map<string, Promise<ChatPersistResult>>();
  const writeTailBySession = new Map<string, Promise<void>>();

  const runWrite = async (input: PersistRevisionRequest): Promise<ChatPersistResult> => {
    if (input.revision <= (durableRevisionBySession.get(input.sessionId) ?? -1)) return 'persisted';
    try {
      await input.write();
      if (!input.partial) durableRevisionBySession.set(input.sessionId, input.revision);
      return 'persisted';
    } catch {
      return 'failed';
    }
  };

  const persist = (input: PersistRevisionRequest): Promise<ChatPersistResult> => {
    const durableRevision = durableRevisionBySession.get(input.sessionId) ?? -1;
    if (input.revision <= durableRevision) return Promise.resolve('persisted');

    const versionKey = `${input.sessionId}:${input.revision}:${input.partial ? 'partial' : 'full'}`;
    const existing = inFlightByVersion.get(versionKey);
    if (existing) return existing;

    const previousWrite = writeTailBySession.get(input.sessionId);
    const pendingWork = previousWrite ? previousWrite.then(() => runWrite(input)) : runWrite(input);
    const pending = pendingWork.finally(() => {
      if (inFlightByVersion.get(versionKey) === pending) inFlightByVersion.delete(versionKey);
    });
    inFlightByVersion.set(versionKey, pending);
    const writeTail = pending.then(() => undefined, () => undefined);
    writeTailBySession.set(input.sessionId, writeTail);
    void writeTail.finally(() => {
      if (writeTailBySession.get(input.sessionId) === writeTail) writeTailBySession.delete(input.sessionId);
    });
    return pending;
  };

  return { persist };
}
