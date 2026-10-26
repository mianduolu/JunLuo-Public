import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { loadChatSessionMessage, loadChatSessionMessages, loadChatSessionMessagePage } from '../chat/chatStorage';
import { getLetterContextMessageId, loadLetterMemoryPart } from '../letters/letterMemorySource';
import { isVoiceCallMemorySource, loadVoiceCallMemoryMessage, loadVoiceCallMemoryMessages } from '../voiceCall/voiceCallMemorySource';
import { isFocusMemorySource } from '../focus/focusMemorySource';
import type { PostMemoryReadOptions } from '../posts/baiyunPostMemorySource';
import type { CameraObservationRecordV1 } from '../camera/cameraObservationTypes';
import { isLifeSelfMemorySource, loadLifeSelfSource } from '../life/lifeSelfMemorySource';
export { isVoiceCallMemorySource } from '../voiceCall/voiceCallMemorySource';
export function isReadingMemorySource(sessionId: string) {
  return sessionId.startsWith('reading-source:') || sessionId.startsWith('reading-v2:') || sessionId.startsWith('reading-auto-v1:');
}
export function isObservationMemorySource(sessionId: string) { return sessionId.startsWith('observation-source:'); }
export function observationMemorySourceSessionId(observationId: string) { return `observation-source:${observationId}`; }

export type MemorySourceEvidence =
  | { kind: 'message'; message: SubjectiveMessage }
  | { kind: 'observation'; record: CameraObservationRecordV1 };

/** Observations remain records; they never pass through the message adapter. */
export async function loadMemorySourceEvidence(sessionId: string, sourceId: string,
  options: { waitForPendingWrites?: boolean } & PostMemoryReadOptions = {}): Promise<MemorySourceEvidence | null> {
  if (!isObservationMemorySource(sessionId)) {
    const message = await loadMemorySourceMessage(sessionId, sourceId, options);
    return message ? { kind: 'message', message } : null;
  }
  if (sessionId !== observationMemorySourceSessionId(sourceId)) return null;
  try {
    const { getCameraObservationRecord } = await import('../camera/cameraObservationStore');
    return { kind: 'observation', record: await getCameraObservationRecord(sourceId) };
  } catch (error) {
    if (error instanceof Error && error.message === 'camera_observation_not_found') return null;
    throw error;
  }
}

export function isLetterMemorySource(sessionId: string) {
  return sessionId.startsWith('letter:');
}

/** Resolve a source at its original store, never through its chat delivery copy. */
export async function loadMemorySourceMessage(sessionId: string, messageId: string,
  options: { waitForPendingWrites?: boolean } & PostMemoryReadOptions = {}): Promise<SubjectiveMessage | null> {
  if (isLifeSelfMemorySource(sessionId)) return (await loadLifeSelfSource(sessionId, messageId))?.message ?? null;
  if (sessionId.startsWith('shiying-source-v1:')) return (await import('../shiying/shiyingMemorySource')).loadShiyingMemoryMessage(sessionId, messageId);
  if (isObservationMemorySource(sessionId)) return null;
  if (sessionId.startsWith('gift-source:')) return (await import('../gifts/giftMemorySource')).readGiftMemoryMessage(sessionId, messageId, options);
  if (sessionId.startsWith('post-source:')) return (await import('../posts/baiyunPostMemorySource')).loadPostMemorySourceMessage(sessionId, messageId, options);
  if (isFocusMemorySource(sessionId)) return (await import('../focus/focusMemorySource')).loadFocusMemoryMessage(sessionId, messageId);
  if (isReadingMemorySource(sessionId)) return (await import('../reading/readingMemorySource')).loadReadingMemoryMessage(sessionId, messageId);
  if (isVoiceCallMemorySource(sessionId)) return loadVoiceCallMemoryMessage(sessionId, messageId, options);
  if (!isLetterMemorySource(sessionId)) {
    if (options.waitForPendingWrites !== false) return loadChatSessionMessage(sessionId, messageId);
    let beforeIndex: number | undefined;
    for (;;) {
      const page = await loadChatSessionMessagePage(sessionId, { limit: 100, beforeIndex, waitForPendingWrites: false });
      const message = page.messages.find(item => item.id === messageId);
      if (message) return message;
      if (!page.startIndex || beforeIndex !== undefined && page.startIndex >= beforeIndex) return null;
      beforeIndex = page.startIndex;
    }
  }
  const part = await loadLetterMemoryPart(sessionId, messageId);
  return part ? { id: part.messageId, role: part.role, content: part.content, createdAt: part.createdAt, source: 'letter' } : null;
}

export async function loadMemorySourceMessages(sessionId: string, options: PostMemoryReadOptions = {}): Promise<SubjectiveMessage[]> {
  if (isLifeSelfMemorySource(sessionId)) {
    const source = await loadLifeSelfSource(sessionId);
    return source ? [source.message] : [];
  }
  if (sessionId.startsWith('shiying-source-v1:')) return (await import('../shiying/shiyingMemorySource')).loadShiyingMemoryMessages(sessionId);
  if (isObservationMemorySource(sessionId)) return [];
  if (sessionId.startsWith('gift-source:')) return (await import('../gifts/giftMemorySource')).readGiftMemoryMessages(sessionId, options);
  if (sessionId.startsWith('post-source:')) return (await import('../posts/baiyunPostMemorySource')).loadPostMemorySourceMessages(sessionId, options);
  if (isFocusMemorySource(sessionId)) return (await import('../focus/focusMemorySource')).loadFocusMemoryMessages(sessionId);
  if (isReadingMemorySource(sessionId)) return (await import('../reading/readingMemorySource')).loadReadingMemoryMessages(sessionId);
  if (isVoiceCallMemorySource(sessionId)) return loadVoiceCallMemoryMessages(sessionId);
  if (!isLetterMemorySource(sessionId)) return loadChatSessionMessages(sessionId);
  const letterId = sessionId.slice('letter:'.length);
  const messages = await Promise.all((['original', 'reply'] as const).map(part =>
    loadMemorySourceMessage(sessionId, getLetterContextMessageId(letterId, part))));
  return messages.filter((message): message is SubjectiveMessage => message !== null);
}
