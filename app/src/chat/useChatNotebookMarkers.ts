import { useEffect, useMemo, useState } from 'react';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { getDisplayedChatMessageContent, hasRenderableChatMessageContent } from './chatMessageDisplay';
import { loadNotebookSnapshot, subscribeNotebookChanged, type NotebookEntry } from './notebookStore';

type NoteSource = Pick<NotebookEntry, 'sourceMessageId' | 'sourceType'>;

export function getNotebookMarkedMessageIds(messages: SubjectiveMessage[], entries: readonly NoteSource[]) {
  const sources = new Set(entries.filter(entry => entry.sourceType.startsWith('assistant_'))
    .map(entry => entry.sourceMessageId).filter((id): id is string => !!id));
  const marked = new Set<string>();
  let sourceTurn = false;
  for (const message of messages) {
    if (message.role === 'you') { sourceTurn = sources.has(message.id); continue; }
    if (message.role !== 'I' || message.deliveryStatus === 'failed'
      || !hasRenderableChatMessageContent(message, getDisplayedChatMessageContent(message))) continue;
    if (sourceTurn || sources.has(message.id)) {
      marked.add(message.id);
      sourceTurn = false;
    }
  }
  return marked;
}

export function useChatNotebookMarkers({ active, messages, externalMessageVersion }: {
  active: boolean; messages: SubjectiveMessage[]; externalMessageVersion: number;
}) {
  const [entries, setEntries] = useState<NoteSource[]>([]);
  useEffect(() => {
    if (!active) return;
    let live = true, changed = false;
    const unsubscribe = subscribeNotebookChanged(snapshot => {
      changed = true;
      if (live) setEntries(snapshot.entries);
    });
    void loadNotebookSnapshot().then(snapshot => {
      if (live && !changed) setEntries(snapshot.entries);
    }).catch(() => { /* Keep the last confirmed view until a successful refresh. */ });
    return () => { live = false; unsubscribe(); };
  }, [active, externalMessageVersion]);
  return useMemo(() => getNotebookMarkedMessageIds(messages, entries), [messages, entries]);
}
