import type { MemoryCandidateReview } from '../memory/memoryCandidateReview';
import type * as SQLite from 'expo-sqlite';
import { beginMemoryCandidateEdit, memoryCandidateEditableHash } from '../memory/memoryCandidateReview';
import { notifyMemoryProcessingUpdated } from '../memory/memoryProcessingSignals';
import { beginMemoryIngestionBatchWithDatabase, registerMemoryIngestionOutcomeWithDatabase } from '../memory/memoryIngestionLedger';
import { getMemoryCandidateReviewStatus } from '../memory/memoryCandidatePersistence';
import { runMemoryCandidateSave, updatePendingMemoryCandidates } from '../memory/memoryIngestionService';
import { runMemoryDuplicateCleanupBusinessWrite } from '../memory/memoryDuplicateCleanupState';
import { createMemory, getMemoryDatabase, loadMemory, loadMemorySourceRefs, memoryFromRow, updateMemory, type MemoryDraft, type MemoryEntry } from '../memory/memoryStore';
import { weeklyTargetHash } from '../memory/memoryWeeklyBasis';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { buildReadingResultMemoryDraft, getReadingResultSource } from './readingMemoryBridge';
import { markReadingResultMemorySaved } from './readingResultActions';
import { loadReadingMemorySource, parseReadingMemorySourceIdentity, readingMemorySourceSession, validateReadingMemoryBinding,
  type ReadingMemoryBinding, type ReadingMemorySourceSnapshot } from './readingMemorySource';
import type { ReadingResultItem } from './readingResults';

export type ReadingMemoryPreview = { version: string; content: string };
export type ReadingMemoryComparison = Awaited<ReturnType<typeof getMemoryCandidateReviewStatus>> & { preview?: ReadingMemoryPreview };
export type ReadingMemoryPreparation = { candidate: MemoryCandidateReview; comparison: ReadingMemoryComparison; savedMemoryId?: never }
  | { savedMemoryId: string; candidate?: never };

const preparations = new Map<string, Promise<ReadingMemoryPreparation>>();
const rechecks = new Map<string, { hash: string; promise: Promise<{ candidate: MemoryCandidateReview; comparison: ReadingMemoryComparison }> }>();
type ReadingLocator = Omit<ReadingMemoryBinding, 'version'>;
type ReadingDatabase = Pick<SQLite.SQLiteDatabase, 'getAllAsync' | 'getFirstAsync'>;

/** Exact persisted provenance joins manual and automatic routes without a title/text guess. */
export async function loadReadingMemoryTargets(database: ReadingDatabase, locator: ReadingLocator) {
  const snapshot = await loadReadingMemorySource(locator);
  if (!snapshot) return [];
  const module = await import('./readingMemoryOrganizationSource');
  const current = module.makeReadingOrganizationSource(snapshot);
  const ids = new Set<string>();
  if (current) {
    const refs = await database.getAllAsync<{ memory_id: string; session_id: string }>(
      "SELECT memory_id, session_id FROM memory_source_refs WHERE relation='direct' AND session_id LIKE 'reading-auto-v1:%'");
    for (const ref of refs) {
      const identity = module.parseReadingOrganizationSource(ref.session_id);
      if (identity && module.readingOrganizationSourceKey(identity) === module.readingOrganizationSourceKey(current.identity)) ids.add(ref.memory_id);
    }
  }
  const rows = await database.getAllAsync<Parameters<typeof memoryFromRow>[0]>(
    `SELECT * FROM memories WHERE source = ?${ids.size ? ` OR id IN (${[...ids].map(() => '?').join(',')})` : ''} ORDER BY created_at,id`,
    getReadingResultSource(snapshot.book, snapshot.item), ...ids);
  return rows.map(memoryFromRow);
}

function snapshotRefs(snapshot: ReadingMemorySourceSnapshot, automatic?: import('./readingMemoryOrganizationSource').ReadingOrganizationSource | null) {
  if (automatic) return [{ sessionId: automatic.sessionId, messageId: automatic.message.id, role: automatic.message.role,
    messageCreatedAt: automatic.message.createdAt, relation: 'direct' as const, excerpt: automatic.message.content }];
  const sessionId = readingMemorySourceSession(snapshot);
  return snapshot.messages.map(message => ({ sessionId, messageId: message.id, role: message.role,
    messageCreatedAt: message.createdAt, relation: 'direct' as const, excerpt: message.content }));
}

function originalDraft(memory: MemoryEntry): MemoryDraft {
  const { id, createdAt, updatedAt, confirmationLevel, sourceTraceMode, ...draft } = memory;
  return draft;
}

async function readingCandidates(database: ReadingDatabase, locator: ReadingLocator) {
  const rows = await database.getAllAsync<{ candidate_json: string }>(
    `SELECT i.candidate_json FROM memory_ingestion_items i JOIN memory_ingestion_batches b ON b.id = i.batch_id
     WHERE i.status IN ('pending', 'waiting') AND b.status IN ('pending', 'ready', 'failed', 'waiting')
       AND json_extract(i.candidate_json, '$.readingBinding.bookId') = ?
       AND json_extract(i.candidate_json, '$.readingBinding.kind') = ?
       AND json_extract(i.candidate_json, '$.readingBinding.resultId') = ?
       AND json_extract(i.candidate_json, '$.readingBinding.chapterIndex') = ? ORDER BY i.created_at, i.batch_id, i.item_key`,
    locator.bookId, locator.kind, locator.resultId, locator.chapterIndex);
  const candidates = new Map<string, MemoryCandidateReview>();
  for (const row of rows) {
    const candidate = JSON.parse(row.candidate_json) as MemoryCandidateReview;
    if (!candidate.readingBinding || !candidate.reviewId || !candidate.ingestionRefs?.length) throw new Error('READING_MEMORY_DRAFT_MISSING');
    candidates.set(candidate.reviewId, beginMemoryCandidateEdit(candidate));
  }
  if (candidates.size > 1) throw new Error('同一阅读原记录有多份草稿，请先核对。');
  return [...candidates.values()][0];
}

export async function loadReadingMemoryCandidateComparison(candidate: MemoryCandidateReview, database?: ReadingDatabase): Promise<ReadingMemoryComparison> {
  const checked = await getMemoryCandidateReviewStatus(database ?? await getMemoryDatabase(), candidate);
  const snapshot = candidate.readingBinding ? await loadReadingMemorySource(candidate.readingBinding) : null;
  const preview = snapshot && candidate.readingBinding && canCommitBackupRestoreDataEpoch(candidate.readingBinding.dataEpoch)
    && snapshot.binding.version === candidate.readingBinding.version
    ? { version: snapshot.binding.version, content: buildReadingResultMemoryDraft(snapshot.book, snapshot.item).content } : undefined;
  return { ...checked, ...(preview ? { preview } : {}), ...(!preview ? { status: 'basis_changed' as const } : {}) };
}

async function candidatePreparation(candidate: MemoryCandidateReview, database?: ReadingDatabase): Promise<ReadingMemoryPreparation> {
  const comparison = await loadReadingMemoryCandidateComparison(candidate, database);
  return { candidate: { ...candidate, reviewStatus: comparison.status }, comparison };
}

/** Only the existing, explicitly pressed reading button creates this draft. */
export function prepareReadingMemoryCandidate(bookId: string, item: ReadingResultItem): Promise<ReadingMemoryPreparation> {
  const locator = { bookId, kind: item.kind, resultId: item.id, chapterIndex: item.chapterIndex };
  const key = JSON.stringify([bookId, item.kind, item.id, item.chapterIndex]);
  const active = preparations.get(key);
  if (active) return active;
  const epoch = captureBackupRestoreDataEpoch();
  const operation = (async (): Promise<ReadingMemoryPreparation> => {
    const database = await getMemoryDatabase();
    const pending = await readingCandidates(database, locator);
    if (pending) return candidatePreparation(pending, database);
    const snapshot = await loadReadingMemorySource(locator);
    if (!snapshot) throw new Error('阅读原记录已不存在。');
    if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('数据正在恢复，请稍后重试。');
    const source = getReadingResultSource(snapshot.book, snapshot.item);
    const now = Date.now();
    const batchId = `reading-review-${now}-${Math.random().toString(36).slice(2, 10)}`;
    const itemKey = 'reading-result';
    const result = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
      let prepared!: ReadingMemoryPreparation;
      await database.withExclusiveTransactionAsync(async transaction => {
        if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
        const already = await readingCandidates(transaction, locator);
        if (already) { prepared = await candidatePreparation(already, transaction); return; }
        if (!(await validateReadingMemoryBinding(snapshot.binding))) throw new Error('阅读原记录已改变，请重新打开核对。');
        const rows = await loadReadingMemoryTargets(transaction, locator);
        if (rows.length > 1) throw new Error('这段阅读对应多张长期记忆，请先核对。');
        const existing = rows[0];
        const refs = existing ? await loadMemorySourceRefs(existing.id, transaction) : [];
        const module = await import('./readingMemoryOrganizationSource');
        const automatic = refs.some(ref => module.isReadingOrganizationSource(ref.sessionId)) ? module.makeReadingOrganizationSource(snapshot) : null;
        if (refs.some(ref => module.isReadingOrganizationSource(ref.sessionId)) && !automatic) throw new Error('阅读原记录无法对应，原卡保留。');
        const newRefs = snapshotRefs(snapshot, automatic);
        const sameVersion = newRefs.length > 0 && refs.length === newRefs.length && refs.every(ref => newRefs.some(expected =>
          ref.sessionId === expected.sessionId && ref.messageId === expected.messageId && ref.role === expected.role
          && ref.relation === 'direct' && ref.messageCreatedAt === expected.messageCreatedAt));
        if (existing && existing.type !== 'archived' && sameVersion) { prepared = { savedMemoryId: existing.id }; return; }
        const draft = buildReadingResultMemoryDraft(snapshot.book, snapshot.item);
        const previousDraft = existing ? originalDraft(existing) : undefined;
        const candidate: MemoryCandidateReview = {
          ...draft, ...(previousDraft ?? {}), content: draft.content, source: draft.source,
          origin: 'digest', reviewId: batchId, extractionBasis: 'manual',
          readingBinding: { ...snapshot.binding, dataEpoch: epoch },
          ...(automatic ? { readingBindings: [module.wholeReadingOrganizationBinding(automatic)] } : {}),
          ...(existing ? { readingReview: { targetMemoryId: existing.id, targetHash: weeklyTargetHash(existing), previousDraft: previousDraft! } } : {}),
          sourceRefs: newRefs, ingestionRefs: [{ batchId, itemKey }], reviewStatus: 'current',
        };
        await beginMemoryIngestionBatchWithDatabase(transaction, { id: batchId, stream: 'manual_digest', advancesCursor: false,
          scopeKey: `reading-result:${key}`, sourceHash: snapshot.binding.version });
        await registerMemoryIngestionOutcomeWithDatabase(transaction, { batchId, pendingItemKeys: [itemKey],
          pendingCandidates: [{ itemKey, candidateJson: JSON.stringify(candidate) }] });
        prepared = await candidatePreparation(candidate, transaction);
      });
      return prepared;
    }));
    if (!result.committed) throw new Error('数据正在恢复，草稿尚未准备，请稍后重试。');
    if (result.value.savedMemoryId) await markReadingResultMemorySaved(bookId, item.id, result.value.savedMemoryId).catch(() => undefined);
    return result.value;
  })();
  preparations.set(key, operation);
  void operation.finally(() => { if (preparations.get(key) === operation) preparations.delete(key); }).catch(() => undefined);
  return operation;
}

/** A local recheck keeps every visible edit and only replaces its verified source. */
export function recheckReadingMemoryCandidate(candidate: MemoryCandidateReview) {
  const hash = memoryCandidateEditableHash(candidate);
  const active = rechecks.get(candidate.reviewId);
  if (active) return active.hash === hash ? active.promise : Promise.reject(new Error('MEMORY_CANDIDATE_CHANGED'));
  const epoch = captureBackupRestoreDataEpoch();
  const promise = (async () => {
    await updatePendingMemoryCandidates([candidate]);
    const database = await getMemoryDatabase();
    const ref = candidate.ingestionRefs?.[0];
    const row = ref ? await database.getFirstAsync<{ candidate_json: string | null }>(
      "SELECT candidate_json FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ? AND status IN ('pending', 'waiting')", ref.batchId, ref.itemKey) : null;
    const original = row?.candidate_json ? JSON.parse(row.candidate_json) as MemoryCandidateReview : null;
    if (!original?.readingBinding || original.reviewId !== candidate.reviewId || memoryCandidateEditableHash(original) !== hash) throw new Error('MEMORY_CANDIDATE_CHANGED');
    const snapshot = await loadReadingMemorySource(original.readingBinding);
    if (!snapshot) throw new Error('阅读原记录已不存在，编辑稿保留。');
    const committed = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
      let updated!: MemoryCandidateReview;
      await database.withExclusiveTransactionAsync(async transaction => {
        if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
        const stored = await readingCandidates(transaction, original.readingBinding!);
        if (!stored || stored.reviewId !== candidate.reviewId || memoryCandidateEditableHash(stored) !== hash
          || JSON.stringify(stored.readingBinding) !== JSON.stringify(original.readingBinding)
          || JSON.stringify(stored.readingReview) !== JSON.stringify(original.readingReview)) throw new Error('MEMORY_CANDIDATE_CHANGED');
        if (!(await validateReadingMemoryBinding(snapshot.binding))) throw new Error('阅读原记录再次改变，编辑稿保留。');
        const module = await import('./readingMemoryOrganizationSource');
        const automatic = stored.readingBindings?.length ? module.makeReadingOrganizationSource(snapshot) : null;
        if (stored.readingBindings?.length && !automatic) throw new Error('阅读原记录无法对应，编辑稿保留。');
        updated = { ...stored, readingBinding: { ...snapshot.binding, dataEpoch: epoch }, sourceRefs: snapshotRefs(snapshot, automatic),
          ...(automatic ? { readingBindings: [module.wholeReadingOrganizationBinding(automatic)] } : {}) };
        updated.reviewStatus = (await getMemoryCandidateReviewStatus(transaction, updated)).status;
        for (const ownedRef of stored.ingestionRefs ?? []) await transaction.runAsync(
          "UPDATE memory_ingestion_items SET candidate_json = ?, updated_at = ? WHERE batch_id = ? AND item_key = ? AND status IN ('pending', 'waiting') AND json_extract(candidate_json, '$.reviewId') = ?",
          JSON.stringify(updated), Date.now(), ownedRef.batchId, ownedRef.itemKey, stored.reviewId);
      });
      return updated;
    }));
    if (!committed.committed) throw new Error('MEMORY_DATA_CHANGED');
    notifyMemoryProcessingUpdated();
    return { candidate: committed.value, comparison: await loadReadingMemoryCandidateComparison(committed.value, database) };
  })();
  rechecks.set(candidate.reviewId, { hash, promise });
  void promise.finally(() => { if (rechecks.get(candidate.reviewId)?.promise === promise) rechecks.delete(candidate.reviewId); }).catch(() => undefined);
  return promise;
}

export async function saveReadingMemoryCandidate(candidate: MemoryCandidateReview) {
  if (!candidate.readingBinding) throw new Error('READING_MEMORY_BINDING_MISSING');
  let savedBinding: MemoryCandidateReview['readingBinding'];
  let committedMemory: MemoryEntry | undefined;
  const id = await runMemoryCandidateSave(candidate, (stored, dataEpoch) => {
    if (!stored.readingBinding) throw new Error('READING_MEMORY_BINDING_MISSING');
    // New reading cards retain their existing limit; updates keep the complete
    // confirmed original reason. Only the persisted host owns that distinction.
    if (!stored.readingReview && (stored.rememberedReason ?? '').trim().length > 80) throw new Error('记住的理由最多80字符，请缩短后保存。');
    savedBinding = stored.readingBinding;
    const options = { confirmationLevel: 'reviewed' as const, sourceRefs: stored.sourceRefs, dataEpoch,
      ingestionResolutions: stored.ingestionRefs, requirePendingIngestion: true,
      ingestionExpectedCandidate: { reviewId: stored.reviewId, editableHash: memoryCandidateEditableHash(stored) } };
    return stored.readingReview
      ? updateMemory(stored.readingReview.targetMemoryId, stored, { ...options, writeIntent: 'update',
        expectedEditableHash: stored.readingReview.targetHash, readingReview: stored.readingReview }).then(memory => { committedMemory = memory; return memory.id; })
      : createMemory(stored, { ...options, returnRecord: true }).then(memory => { committedMemory = memory; return memory.id; });
  });
  // The reading action mirror is not the successful memory transaction.
  // Receipt replays do not trust a caller's editable draft for mirror identity.
  const memory = committedMemory ?? await loadMemory(id);
  if (!memory) throw new Error('MEMORY_NOT_FOUND');
  if (!savedBinding) {
    const refs = await loadMemorySourceRefs(id).catch(() => null);
    if (!refs) return { id, actionRecorded: false, memory };
    const identities = refs.filter(ref => ref.relation === 'direct').map(ref => parseReadingMemorySourceIdentity(ref.sessionId));
    const identity = identities[0];
    if (identity && identities.every(value => value && value.bookId === identity.bookId && value.resultId === identity.resultId
      && value.kind === identity.kind && value.chapterIndex === identity.chapterIndex)
      && memory.source === getReadingResultSource({ id: identity.bookId }, { id: identity.resultId } as ReadingResultItem)) {
      savedBinding = { ...identity, dataEpoch: captureBackupRestoreDataEpoch() };
    }
  }
  if (!savedBinding) return { id, actionRecorded: false, memory };
  let actionRecorded = true;
  try { await markReadingResultMemorySaved(savedBinding.bookId, savedBinding.resultId, id); }
  catch { actionRecorded = false; }
  return { id, actionRecorded, memory };
}

