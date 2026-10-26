import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { commentFromRow, getMemoryDatabase, memoryFromRow, type MemoryRecallItem } from './memoryStore';
import { currentMemoryComments, memoryUsageCommentsHash, type MemoryUsageReference } from './memoryCurrentMaterials';
import { getWeeklyContextStatus, weeklyTargetHash, type WeeklyDatabase } from './memoryWeeklyBasis';
import { getUnderstandingStatus } from './memoryUnderstanding';
import { runMemoryDuplicateCleanupDataEpochCommit } from './memoryDuplicateCleanupState';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { isCurrentStateReference, isMemoryReference, isShiyingReference, isPostReference, referenceKey, type MemoryReadReference } from './memoryReadReference';
import { loadMemoryCurrentState, currentStateVersion } from './memoryCurrentStateStore';

export type { MemoryUsageReference } from './memoryCurrentMaterials';
export type MemoryUsageReceipt = { version: 1; operationId: string; references: MemoryUsageReference[] };
export type MemoryUsageSettlementResult = 'settled' | 'skipped' | 'failed';

export function createMemoryUsageReceipt(operationId: string, references: readonly MemoryUsageReference[]): MemoryUsageReceipt {
  return { version: 1, operationId, references: [...new Map(references.map(reference => [reference.memoryId, { ...reference }])).values()] };
}

function validUsageReceipt(receipt: MemoryUsageReceipt | undefined): receipt is MemoryUsageReceipt {
  return !!receipt && receipt.version === 1 && typeof receipt.operationId === 'string' && !!receipt.operationId
    && Array.isArray(receipt.references) && receipt.references.every(reference => !!reference
      && typeof reference.memoryId === 'string' && typeof reference.targetHash === 'string'
      && (reference.commentsHash === undefined || typeof reference.commentsHash === 'string')
      && (reference.sourceVersion === undefined || typeof reference.sourceVersion === 'string'));
}

async function writeMemoryUsageAt(database: Pick<Awaited<ReturnType<typeof getMemoryDatabase>>, 'runAsync'>, memoryId: string, at: number, spoken: boolean) {
  await database.runAsync(`UPDATE memories SET last_active_at = ?, activation_count = activation_count + 1,
    tier = CASE WHEN tier = 'peripheral' THEN 'working'
      WHEN tier = 'working' AND activation_count + 1 >= 8 AND importance >= 7 THEN 'core' ELSE tier END,
    updated_at = MAX(updated_at, ?) WHERE id = ? AND stats_semantics_version = 1 AND last_active_at < ?`, at, at, memoryId, at);
  if (spoken) await database.runAsync(`UPDATE memories SET last_mentioned_at = ?,
    last_surfaced_at = MAX(COALESCE(last_surfaced_at, 0), ?), surface_count = COALESCE(surface_count, 0) + 1,
    updated_at = MAX(updated_at, ?) WHERE id = ? AND stats_semantics_version = 1 AND (last_mentioned_at IS NULL OR last_mentioned_at < ?)`,
  at, at, at, memoryId, at);
}

/** Call only after the corresponding model body was persisted. Failure must not undo that body. */
export async function settleSavedMemoryUsage(input: {
  receipt?: MemoryUsageReceipt; savedAt: number; dataEpoch: number | null; canCommit?: () => boolean;
  onResult?: (result: MemoryUsageSettlementResult) => void;
  commentsScope?: 'supplements';
  validateReference?: (reference: MemoryUsageReference, database: WeeklyDatabase) => Promise<boolean>;
}): Promise<void> {
  const report = (result: MemoryUsageSettlementResult) => {
    try { input.onResult?.(result); }
    catch { console.warn('[memory] usage settlement result callback failed'); }
  };
  if (!validUsageReceipt(input.receipt) || !input.receipt.references.length || !Number.isFinite(input.savedAt) || input.savedAt <= 0) {
    report('skipped'); return;
  }
  const receipt = input.receipt;
  const canCommit = () => canCommitBackupRestoreDataEpoch(input.dataEpoch) && (input.canCommit?.() ?? true);
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (!canCommit()) { report('skipped'); return; }
    let result: MemoryUsageSettlementResult;
    try {
      const committed = await runMemoryDuplicateCleanupDataEpochCommit(input.dataEpoch, async () => {
        if (!canCommit()) return false;
        let settled = false;
        const db = await getMemoryDatabase();
        const { getPostDerivedStatus, preloadPostDerivedReadOptions } = await import('../posts/baiyunPostMemoryBasis');
        const postOptions = await preloadPostDerivedReadOptions(db, receipt.references.map(reference => ({ kind: 'memory' as const, id: reference.memoryId })));
        await db.withExclusiveTransactionAsync(async transaction => {
          for (const reference of new Map(receipt.references.map(item => [item.memoryId, item])).values()) {
            const row = await transaction.getFirstAsync<Parameters<typeof memoryFromRow>[0]>('SELECT * FROM memories WHERE id = ?', reference.memoryId);
            if (!row) continue;
            const memory = memoryFromRow(row);
            if (!(await (await import('../reading/readingMemoryOrganizationSource')).isReadingOrganizationMemoryCurrent(transaction, memory.id))
              || !(await (await import('../shiying/shiyingMemorySource')).isShiyingOrganizationMemoryCurrent(transaction, memory.id))) continue;
            if (memory.type === 'archived' || memory.type === 'feel' || weeklyTargetHash(memory) !== reference.targetHash
              || (await getPostDerivedStatus(transaction, 'memory', memory.id, undefined, postOptions)).status !== 'current'
              || await getWeeklyContextStatus(transaction, memory, postOptions) !== 'current'
              || await getUnderstandingStatus(transaction, memory, postOptions) !== 'current') continue;
            if (reference.commentsHash !== undefined) {
              const rows = await transaction.getAllAsync<Parameters<typeof commentFromRow>[0]>(
                'SELECT * FROM memory_comments WHERE memory_id = ?', memory.id);
              const comments = currentMemoryComments(memory, rows.map(commentFromRow));
              if (memoryUsageCommentsHash(input.commentsScope === 'supplements'
                ? comments.filter(comment => comment.kind !== 'dehydration') : comments) !== reference.commentsHash) continue;
            }
            if (reference.sourceVersion !== undefined) {
              const snapshot = await (await import('./memoryReadMaterials')).loadMemoryReadSnapshot(memory.id, 'source', transaction, undefined, postOptions);
              if (typeof snapshot === 'string' || snapshot.version !== reference.sourceVersion) continue;
            }
            if (input.validateReference && !await input.validateReference(reference, transaction)) continue;
            if (!canCommit()) throw new Error('memory_usage_cancelled');
            await writeMemoryUsageAt(transaction, memory.id, input.savedAt, false);
            settled = true;
          }
          if (!canCommit()) throw new Error('memory_usage_cancelled');
        });
        return settled;
      });
      result = committed.committed && committed.value && canCommit() ? 'settled' : 'skipped';
    } catch {
      if (!canCommit()) { report('skipped'); return; }
      if (attempt !== 3) continue;
      console.warn('[memory] usage settlement failed', { operationId: receipt.operationId });
      result = 'failed';
    }
    report(result); return;
  }
}

export type MemoryMentionReceipt = { item: number; quote: string };

export function parseMemoryMentionReceipts(raw: string | undefined): MemoryMentionReceipt[] {
  try {
    const value: unknown = JSON.parse(raw ?? '');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const entries = (value as Record<string, unknown>).memoryMentions;
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry): entry is MemoryMentionReceipt => (
      !!entry && typeof entry === 'object' && !Array.isArray(entry)
      && Number.isInteger(entry.item) && entry.item > 0
      && typeof entry.quote === 'string' && !!entry.quote.trim()
      && Object.keys(entry).every(key => key === 'item' || key === 'quote')
    ));
  } catch { return []; }
}

export function findSpokenMemoryItems<T extends MemoryReadReference>(
  references: readonly T[], receipts: readonly MemoryMentionReceipt[],
  messages: readonly Pick<SubjectiveMessage, 'role' | 'content'>[],
) {
  const ids = new Set<string>();
  const items: T[] = [];
  for (const receipt of receipts) {
    const item = references[receipt.item - 1];
    if (!item || ids.has(referenceKey(item))) continue;
    if (!messages.some(message => message.role === 'I' && message.content.includes(receipt.quote.trim()))) continue;
    ids.add(referenceKey(item));
    items.push(item);
  }
  return items;
}

export async function commitMemoryReplyUsage(input: {
  dataEpoch: number | null;
  references: readonly MemoryReadReference[];
  receipts: readonly MemoryMentionReceipt[];
  messages: readonly Pick<SubjectiveMessage, 'id' | 'role' | 'content' | 'createdAt'>[];
  canCommit: () => boolean;
  visibleMemoryIds?: ReadonlySet<string>;
  validateReference?: (reference: MemoryReadReference, database: WeeklyDatabase,
    postOptions?: import('../posts/baiyunPostMemorySource').PostMemoryReadOptions) => Promise<boolean>;
}): Promise<MemoryRecallItem[]> {
  const messages = input.messages.filter(message => message.role === 'I' && !!message.content.trim());
  const replyAt = Math.max(...messages.map(message => message.createdAt));
  if (!input.references.length || !messages.length || !Number.isFinite(replyAt) || replyAt <= 0 || !input.canCommit()) return [];
  const spokenIds = new Set(findSpokenMemoryItems(input.references, input.receipts, messages).map(referenceKey));
  const references = [...new Map(input.references.map(item => [referenceKey(item), item])).values()];
  const committed = await runMemoryDuplicateCleanupDataEpochCommit(input.dataEpoch, async () => {
    if (!input.canCommit()) return [];
    const db = await getMemoryDatabase();
    const spoken: MemoryRecallItem[] = [];
    const { getPostDerivedStatus, preloadPostDerivedReadOptions } = await import('../posts/baiyunPostMemoryBasis');
    const postOptions = await preloadPostDerivedReadOptions(db, references.flatMap<{ kind: 'current_state' | 'memory'; id: string }>(item => isCurrentStateReference(item)
      ? [{ kind: 'current_state' as const, id: item.currentState.id }]
      : isMemoryReference(item) ? [{ kind: 'memory' as const, id: item.memory.id }] : []));
    await db.withExclusiveTransactionAsync(async transaction => {
      for (const item of references) {
        if (input.visibleMemoryIds && !input.visibleMemoryIds.has(referenceKey(item))) continue;
        // A raw paper is an independent source, never a formal card whose counters we may update.
        if (isShiyingReference(item) || isPostReference(item)) continue;
        if (isCurrentStateReference(item)) {
          const current = await loadMemoryCurrentState(item.currentState.id, transaction);
          if (!current || current.status !== 'active' || currentStateVersion(current) !== item.version) continue;
          if (!(await (await import('../shiying/shiyingMemorySource')).isShiyingOrganizationMemoryCurrent(transaction, current.id, current.sourceRefs))) continue;
          if ((await getPostDerivedStatus(transaction, 'current_state', current.id, current.sourceRefs, postOptions)).status !== 'current') continue;
          if (input.validateReference && !await input.validateReference(item, transaction, postOptions)) continue;
          if (item.sourceVersion) {
            const source = await (await import('./memoryReadMaterials')).loadCurrentStateReadSnapshot(current.id, 'source', transaction, undefined, { postOptions });
            if (typeof source === 'string' || source.version !== item.sourceVersion) continue;
          }
          if (!input.canCommit()) throw new Error('memory_reply_usage_cancelled');
          await transaction.runAsync(`UPDATE memory_current_states SET last_used_at = MAX(COALESCE(last_used_at, 0), ?),
            last_spoken_at = CASE WHEN ? THEN MAX(COALESCE(last_spoken_at, 0), ?) ELSE last_spoken_at END WHERE id = ?`,
          replyAt, spokenIds.has(referenceKey(item)) ? 1 : 0, replyAt, current.id);
          continue;
        }
        const row = await transaction.getFirstAsync<Parameters<typeof memoryFromRow>[0]>('SELECT * FROM memories WHERE id = ?', item.memory.id);
        if (!row) continue;
        const current = memoryFromRow(row);
        if (!(await (await import('../reading/readingMemoryOrganizationSource')).isReadingOrganizationMemoryCurrent(transaction, current.id))
          || !(await (await import('../shiying/shiyingMemorySource')).isShiyingOrganizationMemoryCurrent(transaction, current.id))) continue;
        if (current.type === 'archived' || current.type === 'feel'
          || weeklyTargetHash(current) !== weeklyTargetHash(item.memory)
          || (await getPostDerivedStatus(transaction, 'memory', current.id, undefined, postOptions)).status !== 'current'
          || await getWeeklyContextStatus(transaction, current, postOptions) !== 'current'
          || await getUnderstandingStatus(transaction, current, postOptions) !== 'current') continue;
        if (input.validateReference && !await input.validateReference(item, transaction, postOptions)) continue;
        if (item.commentsChecked || item.latestComment) {
          const rows = await transaction.getAllAsync<Parameters<typeof commentFromRow>[0]>(
            'SELECT * FROM memory_comments WHERE memory_id = ?', current.id,
          );
          const comments = currentMemoryComments(current, rows.map(commentFromRow));
          const latest = comments.find(comment => comment.kind === 'dehydration') ?? comments[0];
          if (latest?.id !== item.latestComment?.id || latest?.content !== item.latestComment?.content
            || latest?.kind !== item.latestComment?.kind || latest?.source !== item.latestComment?.source) continue;
        }
        if (!input.canCommit()) throw new Error('memory_reply_usage_cancelled');
        // Fixed reply timestamps make retries idempotent; reading and speaking have separate clocks.
        await writeMemoryUsageAt(transaction, current.id, replyAt, spokenIds.has(current.id));
        if (spokenIds.has(current.id)) {
          spoken.push(item);
        }
      }
      if (!input.canCommit()) throw new Error('memory_reply_usage_cancelled');
    });
    return spoken;
  });
  return committed.committed ? committed.value : [];
}
