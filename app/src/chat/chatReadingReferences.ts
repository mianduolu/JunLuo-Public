import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { fingerprintPromptText } from '../ai/promptCacheMetrics';
import { isReadingReference } from '../reading/readingReference';

export type ReadingMessageSource = { messageId: string; revision: string; readingId: string };
type SourceMessage = Pick<SubjectiveMessage, 'id' | 'role' | 'content' | 'createdAt' | 'readingReference'>;

/** Legacy messages keep their exact old fingerprint. Attachment edits change the source. */
export function readingMessageRevision(message: SourceMessage): string {
  return fingerprintPromptText(JSON.stringify([message.id, message.role, message.content, message.createdAt,
    ...(message.readingReference ? [message.readingReference] : [])]));
}

export async function readingMessageSourcesCurrent(
  sources: readonly ReadingMessageSource[],
  load: (id: string) => Promise<SubjectiveMessage | null>,
  command?: { id: string; revision: string },
): Promise<boolean> {
  if (sources.length && command) {
    const message = await load(command.id);
    if (!message || message.role !== 'you' || readingMessageRevision(message) !== command.revision) return false;
  }
  for (const source of sources) {
    const message = await load(source.messageId);
    if (!message || message.role !== 'you' || !isReadingReference(message.readingReference)
      || message.readingReference.readingId !== source.readingId
      || readingMessageRevision(message) !== source.revision) return false;
  }
  return true;
}

/** Only selected messages and explicitly replied-to originals can grant a reference. */
export async function prepareChatReadingReferences(
  selected: readonly SubjectiveMessage[],
  load: (id: string) => Promise<SubjectiveMessage | null>,
): Promise<{ messages: SubjectiveMessage[]; sources: ReadingMessageSource[] }> {
  const messages = selected.map(message => ({ ...message }));
  const sources = new Map<string, ReadingMessageSource>();
  for (const selectedMessage of selected) {
    if (selectedMessage.role !== 'you') continue;
    const original = selectedMessage.readingReference || selectedMessage.replyTo ? await load(selectedMessage.id) : null;
    if (selectedMessage.readingReference && (!original
      || readingMessageRevision(original) !== readingMessageRevision(selectedMessage))) {
      throw new Error('reading-chat-source-changed');
    }
    if (original?.role === 'you' && isReadingReference(original.readingReference)) {
      sources.set(original.id, { messageId: original.id, readingId: original.readingReference.readingId, revision: readingMessageRevision(original) });
    }
    if (!original?.replyTo) continue;
    const replied = await load(original.replyTo.id);
    if (!replied || replied.role !== 'you' || !isReadingReference(replied.readingReference)) continue;
    if (readingMessageRevision(original) !== readingMessageRevision(selectedMessage)
      || JSON.stringify(original.replyTo) !== JSON.stringify(selectedMessage.replyTo)) throw new Error('reading-chat-source-changed');
    if (replied.role !== original.replyTo.role || replied.createdAt !== original.replyTo.createdAt
      || replied.content !== original.replyTo.content) continue;
    sources.set(replied.id, { messageId: replied.id, readingId: replied.readingReference.readingId, revision: readingMessageRevision(replied) });
    if (!messages.some(message => message.id === replied.id)) {
      messages.splice(messages.findIndex(message => message.id === selectedMessage.id), 0, replied);
    }
  }
  return { messages, sources: [...sources.values()] };
}
