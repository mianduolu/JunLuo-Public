import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';
import { createToolError } from './toolErrors';
import { createToolErrorResult } from './toolResult';
import { readReadingMaterial, type ReadingMaterialPorts } from '../reading/readingMaterialReader';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { readingMessageSourcesCurrent, type ReadingMessageSource } from '../chat/chatReadingReferences';

/** One chat turn owns reference evidence; cursors are tied to the runtime epoch and source. */
export function createReadingMaterialTurn(input: {
  sessionId: string; sources: readonly ReadingMessageSource[]; dataEpoch: number;
  signal?: AbortSignal; isCurrent?: () => boolean | Promise<boolean>;
}) {
  const sources = input.sources.map(source => ({ ...source }));
  const isCurrent = async () => !input.signal?.aborted && canCommitBackupRestoreDataEpoch(input.dataEpoch)
    && (!input.isCurrent || await input.isCurrent())
    && await readingMessageSourcesCurrent(sources, async id =>
      (await import('../chat/chatStorage')).loadChatSessionMessage(input.sessionId, id));
  const ports: ReadingMaterialPorts = {
    dataEpoch: input.dataEpoch,
    isCurrent,
    loadBook: async id => (await (await import('../reading/readingStore')).loadReadingLibraryStrict()).find(book => book.id === id) ?? null,
    loadChapter: async (id, index) => (await import('../reading/readingStore')).loadReadingChapter(id, index, true),
  };
  return async (call: JunLuoToolCall): Promise<JunLuoToolResult> => {
    if (call.requestedBy !== 'chat' || !sources.some(source => source.readingId === call.input.readingId)) {
      return createToolErrorResult(call, createToolError('PERMISSION_DENIED', 'reading-chat-reference-required'), '');
    }
    // Reuse the reading store's short local critical section, never hold it for model/network work.
    return (await import('../reading/readingStore')).runReadingStoreExclusive(() => readReadingMaterial(call, ports));
  };
}
