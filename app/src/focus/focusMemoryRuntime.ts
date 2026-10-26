import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { CHAT_MEMORY_PREPARATION_TIMEOUT_MS } from '../memory/memoryChatPreparation';
import { createMemoryMaterialPreparation } from '../memory/memoryCurrentMaterials';
import { loadEmbeddingSettingsSnapshot } from '../memory/memoryEmbedding';
import { buildTemporalMemoryLine } from '../memory/memoryOrchestrator';
import { buildLocalMemoryRecallOnly, buildMemoryRecall, memoryLocalRecallQuery } from '../memory/memoryRecall';
import { commitMemoryReplyUsage, parseMemoryMentionReceipts } from '../memory/memoryReplyUsage';
import { isMemoryReference, type MemoryReadReference } from '../memory/memoryReadReference';
import { createShiyingRecallRefresh, formatShiyingRecallMaterial, shiyingReadReference, type ShiyingRecallSelection } from '../memory/memoryShiyingRecall';
import { isMemoryRecallEligible, selectRefreshedMemoryRecallItems, type MemoryRecallItem } from '../memory/memoryStore';
import type { FocusLogEntry } from './focusStore';

export type FocusMemoryRequest = {
  sessionId: string;
  operationId: string;
  canCommit: () => boolean;
  signal?: AbortSignal;
};
export type FocusMemoryReceipt = {
  sessionId: string;
  operationId: string;
  dataEpoch: number | null;
  references: MemoryReadReference[];
  sent: boolean;
  canCommit: () => boolean;
};

/** One request-local slot. No care/background bundle, cloud route or persisted paper copy. */
export async function prepareFocusMemory(input: {
  request?: FocusMemoryRequest;
  userActivity: string;
  userMessage?: string;
  logs: readonly Pick<FocusLogEntry, 'role' | 'content'>[];
}) {
  const request = input.request;
  if (!request) return null;
  const dataEpoch = captureBackupRestoreDataEpoch();
  const current = () => !request.signal?.aborted && request.canCommit() && canCommitBackupRestoreDataEpoch(dataEpoch);
  if (!current()) return null;
  const query = { userText: input.userMessage ?? input.userActivity,
    activeContext: [input.userActivity, ...input.logs.filter(log => log.role === 'I' || log.role === 'you').slice(-6)
      .map(log => `${log.role}：${log.content}`)].join('\n') };
  const localQuery = memoryLocalRecallQuery(query);
  const controller = new AbortController();
  let stop!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(Object.assign(new Error('FOCUS_MEMORY_PREPARATION_CANCELLED'), { name: 'AbortError' }));
  });
  const abort = () => { controller.abort(); stop(); };
  request.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, CHAT_MEMORY_PREPARATION_TIMEOUT_MS.total);
  const preparation = createMemoryMaterialPreparation({ signal: controller.signal });
  const papers: ShiyingRecallSelection = { items: [] };
  let formal: MemoryRecallItem | undefined;
  try {
    const result = await Promise.race([stopped, (async () => {
      const settings = await loadEmbeddingSettingsSnapshot();
      if (!current() || controller.signal.aborted) return null;
      return (settings.enabled ? buildMemoryRecall : buildLocalMemoryRecallOnly)(query, {
        allowRerank: false, maxResults: 1, touch: false, materialPreparation: preparation,
        signal: controller.signal, shiyingSelection: papers,
      });
    })()]);
    if (!result || !current() || controller.signal.aborted) return null;
    formal = result.items.find(item => item.relevanceTier !== undefined && item.relevanceTier !== 'weak');
  } catch {
    // Recall is optional; a failed local read never manufactures a remembered fact.
    return null;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', abort);
  }
  const paper = papers.items[0];
  const paperWins = paper && (!formal || paper.textScore + paper.semanticScore > (formal.score ?? 0));
  const refreshPaper = paperWins ? createShiyingRecallRefresh(paper.snapshot, localQuery) : undefined;
  if (paperWins) formal = undefined;
  const receipt: FocusMemoryReceipt = { sessionId: request.sessionId, operationId: request.operationId,
    dataEpoch, references: [], sent: false, canCommit: current };
  let text = '';
  return {
    receipt,
    get text() { return text; },
    async refresh() {
      text = ''; receipt.references = [];
      if (!current()) return '';
      if (refreshPaper) {
        const snapshot = await refreshPaper();
        if (snapshot && current()) {
          text = formatShiyingRecallMaterial(snapshot, 1, 180, localQuery);
          if (text) receipt.references = [shiyingReadReference(snapshot)];
        }
      } else if (formal) {
        const memories = await preparation.refresh([formal.memory], isMemoryRecallEligible);
        if (!current()) return '';
        formal = selectRefreshedMemoryRecallItems([formal], localQuery, preparation, memories, { requireRelevant: true })[0];
        if (formal) {
          text = buildTemporalMemoryLine(formal, new Map([[formal.memory.id, 1]]), preparation, {}, true);
          if (text) receipt.references = [formal];
        }
      }
      if (!current()) { text = ''; receipt.references = []; }
      return text;
    },
    markSent() {
      if (text && current()) receipt.sent = true;
      return receipt;
    },
  };
}

/** Run after exact generated logs were read back from the original focus journal. */
export async function settleFocusMemoryUsage(receipt: FocusMemoryReceipt | undefined,
  logs: readonly Omit<FocusLogEntry, 'sessionId'>[], rawEnvelope: string, canCommit: () => boolean, sessionId: string) {
  if (!receipt?.sent || receipt.sessionId !== sessionId || !receipt.operationId
    || !receipt.references.length || !receipt.canCommit() || !canCommit()) return;
  const references = receipt.references.filter(isMemoryReference);
  if (!references.length) return; // Raw papers have no formal-memory activity counters.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await commitMemoryReplyUsage({ dataEpoch: receipt.dataEpoch, references,
        receipts: parseMemoryMentionReceipts(rawEnvelope), messages: logs.filter(log => log.role === 'I')
          .map(log => ({ id: log.id, role: 'I' as const, content: log.content, createdAt: log.createdAt })),
        canCommit: () => receipt.canCommit() && canCommit() });
      return;
    } catch {
      if (!receipt.canCommit() || !canCommit()) return;
    }
  }
  console.warn('[focus] memory usage settlement failed', { operationId: receipt.operationId });
}
