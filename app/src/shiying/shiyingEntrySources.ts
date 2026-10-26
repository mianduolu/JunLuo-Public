import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { hasChatSessionMessage, loadChatSessionMessage } from '../chat/chatStorage';
import { projectShiyingChatMessage } from './shiyingChatSource';
import {
  assertShiyingHash,
  parseShiyingMessageCursorV1,
  type ShiyingEntrySourceV1,
} from './shiyingContract';

export type ShiyingEntrySourceStatus = 'matching' | 'changed' | 'unavailable' | 'error';

export type ShiyingEntrySourceCheck = {
  source: ShiyingEntrySourceV1;
  status: ShiyingEntrySourceStatus;
};

export const SHIYING_ENTRY_SOURCE_STATUS_LABELS: Record<ShiyingEntrySourceStatus, string> = {
  matching: '原消息一致',
  changed: '来源内容已变化',
  unavailable: '原消息不可回查',
  error: '暂时无法核对',
};

export type ShiyingEntrySourceReadPort = {
  hasMessage(sessionId: string, messageId: string): Promise<boolean>;
  loadMessage(sessionId: string, messageId: string): Promise<SubjectiveMessage | null>;
};

type ShiyingEntrySourceDependencies = { chatPort?: ShiyingEntrySourceReadPort };

const defaultChatPort: ShiyingEntrySourceReadPort = {
  hasMessage: hasChatSessionMessage,
  loadMessage: loadChatSessionMessage,
};

/** Checks the saved source without replacing its snapshot or entering a pickup scan. */
export async function checkShiyingEntrySource(
  source: ShiyingEntrySourceV1,
  dependencies: ShiyingEntrySourceDependencies = {},
): Promise<ShiyingEntrySourceCheck> {
  const chatPort = dependencies.chatPort ?? defaultChatPort;
  try {
    parseShiyingMessageCursorV1({
      sessionId: source.sessionId,
      messageId: source.messageId,
      messageCreatedAt: source.messageCreatedAt,
    });
    assertShiyingHash(source.contentHash);
    if (source.role !== 'I' && source.role !== 'you') return { source, status: 'error' };

    const exists = await chatPort.hasMessage(source.sessionId, source.messageId);
    if (exists === false) return { source, status: 'unavailable' };
    if (exists !== true) return { source, status: 'error' };
    const message = await chatPort.loadMessage(source.sessionId, source.messageId);
    if (!message || message.id !== source.messageId || message.role !== source.role
      || message.createdAt !== source.messageCreatedAt) return { source, status: 'error' };

    const material = projectShiyingChatMessage(source.sessionId, message).material;
    // Existing but temporarily ineligible material cannot supply a comparable hash.
    if (!material) return { source, status: 'error' };
    return { source, status: material.contentHash === source.contentHash ? 'matching' : 'changed' };
  } catch {
    return { source, status: 'error' };
  }
}

export async function checkShiyingEntrySources(
  sources: readonly ShiyingEntrySourceV1[],
  dependencies: ShiyingEntrySourceDependencies = {},
): Promise<ShiyingEntrySourceCheck[]> {
  return Promise.all(sources.map(source => checkShiyingEntrySource(source, dependencies)));
}
