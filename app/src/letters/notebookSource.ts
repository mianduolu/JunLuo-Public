import type { NotebookEntry } from '../chat/notebookStore';

export async function resolveNotebookSource(
  entry: Pick<NotebookEntry, 'sourceMessageId' | 'sourceExcerpt'>,
  findMessage: (id: string) => Promise<{ role: string; content: string } | null>,
): Promise<string | null> {
  if (!entry.sourceMessageId) return entry.sourceExcerpt || null;
  const message = await findMessage(entry.sourceMessageId);
  return message?.role === 'you' && message.content.trim() ? message.content : null;
}
