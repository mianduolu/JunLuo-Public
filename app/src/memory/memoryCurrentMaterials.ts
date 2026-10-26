import { stableMemoryHash } from './memoryAtomicity';
import type { MemoryComment, MemoryEntry } from './memoryStore';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { weeklyTargetHash } from './memoryWeeklyBasis';
import type { MemoryReadSnapshot } from './memoryReadMaterials';
import type { MemorySourceRef } from './memoryStore';
import { withMemoryDatabaseReadContext } from './memoryDatabaseWrites';
import type { MemoryRecallWorkReporter } from './memoryDatabaseWrites';
import type { WeeklyDatabase } from './memoryWeeklyBasis';
import type { PostMemoryReadOptions } from '../posts/baiyunPostMemorySource';

// These are storage-generated before-images, not later observations about the event.
export function isMemoryBeforeUpdateComment(comment: MemoryComment) {
  if (comment.kind !== 'update') return false;
  return (comment.author === 'tool:memory.update' && comment.content.startsWith('工具更新前记录：'))
    || (comment.author === 'tool:memory.update_preference' && comment.content.startsWith('偏好更新前记录：'))
    || (comment.author === '记忆系统' && comment.content.startsWith('更新前正文：'));
}

function newestFirst(comments: readonly MemoryComment[]) {
  return [...comments].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function memoryDehydrationComments(comments: readonly MemoryComment[]) {
  return newestFirst(comments)
    .filter(comment => comment.kind !== 'dehydration' && !isMemoryBeforeUpdateComment(comment))
    .slice(0, 6);
}

export function memoryDehydrationSource(memory: MemoryEntry, comments: readonly MemoryComment[]) {
  const time = memory.eventTime;
  // Only input materials participate. Reads, activity and the resulting summary do not.
  const materials = [
    memory.title, memory.content, memory.domain, memory.tags, memory.createdAt,
    memory.eventAt, memory.date,
    time ? [time.startAt, time.endAt, time.precision, time.basis, time.timeSourceMessageId, time.timeExpression] : null,
    memoryDehydrationComments(comments).map(comment => comment.content),
    ...(memory.understandingSubject ? [memory.understandingSubject] : []),
  ];
  return `memory-dehydration:v1:${stableMemoryHash(JSON.stringify(materials))}`;
}

export function currentMemoryComments(memory: MemoryEntry, comments: readonly MemoryComment[]) {
  const source = memoryDehydrationSource(memory, comments);
  return newestFirst(comments).filter(comment => !isMemoryBeforeUpdateComment(comment)
    && (comment.kind !== 'dehydration' || comment.source === source));
}

export type CurrentMemoryMaterialReason = 'missing' | 'weekly_stale' | 'understanding_stale' | 'post_source_stale' | 'reading_source_stale' | 'shiying_source_stale';

/** A single validity pass shares reference reads; the next pass always rereads. */
async function inspectCurrentMemoryMaterials(database: WeeklyDatabase, memories: readonly MemoryEntry[],
  refs?: ReadonlyMap<string, readonly MemorySourceRef[]>, postOptions: PostMemoryReadOptions = {}) {
  const { inspectPostDerivedTargets } = await import('../posts/baiyunPostMemoryBasis');
  const post = await inspectPostDerivedTargets(database, memories.map(memory => ({
    kind: 'memory' as const, id: memory.id, sourceRefs: refs?.get(memory.id),
  })), postOptions);
  const { getWeeklyContextStatus } = await import('./memoryWeeklyBasis');
  const { getUnderstandingStatus } = await import('./memoryUnderstanding');
  const reading = await (await import('../reading/readingMemoryOrganizationSource')).currentReadingOrganizationMemoryIds(database, memories, refs);
  const shiying = await (await import('../shiying/shiyingMemorySource')).currentShiyingOrganizationMemoryIds(database, memories, refs);
  const result = new Map<string, CurrentMemoryMaterialReason | undefined>();
  for (let index = 0; index < memories.length; index++) {
    const memory = memories[index];
    result.set(memory.id, !reading.has(memory.id) ? 'reading_source_stale'
      : !shiying.has(memory.id) ? 'shiying_source_stale'
      : post[index].status !== 'current' ? 'post_source_stale'
      : await getWeeklyContextStatus(database, memory, postOptions) !== 'current' ? 'weekly_stale'
        : await getUnderstandingStatus(database, memory, postOptions) !== 'current' ? 'understanding_stale' : undefined);
  }
  return result;
}

/** Internal material identity, never part of model input or a copy of memory prose. */
export type MemoryUsageReference = {
  memoryId: string;
  targetHash: string;
  commentsHash?: string;
  sourceVersion?: string;
};

export function memoryUsageCommentsHash(comments: readonly MemoryComment[]) {
  return stableMemoryHash(JSON.stringify(comments));
}

/** History readers deliberately do not use this gate. Archive/category policy belongs to the caller. */
export async function inspectCurrentMemoryMaterial(memory: Pick<MemoryEntry, 'id'>, selectedRow?: MemoryEntry | null): Promise<{
  memory?: MemoryEntry; reason?: CurrentMemoryMaterialReason;
}> {
  const store = await import('./memoryStore');
  const current = selectedRow === undefined ? await store.loadMemory(memory.id) : selectedRow;
  if (!current) return { reason: 'missing' };
  const db = await store.getMemoryDatabase();
  if (!(await (await import('../reading/readingMemoryOrganizationSource')).isReadingOrganizationMemoryCurrent(db, current.id))) {
    return { reason: 'reading_source_stale' };
  }
  if (!(await (await import('../shiying/shiyingMemorySource')).isShiyingOrganizationMemoryCurrent(db, current.id))) {
    return { reason: 'shiying_source_stale' };
  }
  if ((await (await import('../posts/baiyunPostMemoryBasis')).getPostDerivedStatus(db, 'memory', current.id)).status !== 'current') {
    return { reason: 'post_source_stale' };
  }
  const { getWeeklyContextStatus } = await import('./memoryWeeklyBasis');
  const { getUnderstandingStatus } = await import('./memoryUnderstanding');
  if (await getWeeklyContextStatus(db, current) !== 'current') return { reason: 'weekly_stale' };
  if (await getUnderstandingStatus(db, current) !== 'current') return { reason: 'understanding_stale' };
  return { memory: current };
}

export async function availableMemoryMaterialSnapshots(memories: readonly MemoryEntry[]) {
  const { loadMemories } = await import('./memoryStore');
  const ids = new Set((await loadMemories({ currentOnly: true })).map(memory => memory.id));
  return memories.filter(memory => ids.has(memory.id));
}

/** One unsent preparation, shared by selection and transport. No persisted retry state. */
export function createMemoryMaterialPreparation(options: { includeSources?: boolean; signal?: AbortSignal; initialCandidates?: Promise<MemoryEntry[]> } = {}) {
  const epoch = captureBackupRestoreDataEpoch();
  // Candidate selection only. Selected cards still pass refresh(), including again
  // at transport time; this snapshot never certifies a material for sending.
  let initialCandidates = options.initialCandidates;
  let candidateSnapshot: Promise<MemoryEntry[]> | undefined;
  let candidateSnapshotSignal: AbortSignal | undefined;
  const versions = new Map<string, string>();
  const recallVersions = new Map<string, string>();
  const muteOnlyRefreshes = new Set<string>();
  const refreshed = new Set<string>();
  const omitted = new Set<string>();
  const comments = new Map<string, MemoryComment[]>();
  const currentMemories = new Map<string, MemoryEntry>();
  const sourceRefs = new Map<string, MemorySourceRef[]>();
  const sources = new Map<string, MemoryReadSnapshot>();
  const sourceScopes = new Map<string, string>();
  const reasons = new Map<string, CurrentMemoryMaterialReason | 'changed_again' | 'ineligible'>();
  function assertCurrent(stageSignal?: AbortSignal) {
    if (stageSignal?.aborted || options.signal?.aborted || !canCommitBackupRestoreDataEpoch(epoch)) {
      throw Object.assign(new Error('MEMORY_MATERIAL_PREPARATION_CANCELLED'), { name: 'AbortError' });
    }
  }
  return {
    reasons,
    hasCandidateSnapshot: () => candidateSnapshot !== undefined,
    async loadCandidateSnapshot(stageSignal?: AbortSignal, reporter?: MemoryRecallWorkReporter) {
      assertCurrent(stageSignal);
      // A stage timeout may win its race before the cancelled read's catch runs.
      // A following stage must not inherit that already cancelled pending read.
      if (candidateSnapshotSignal?.aborted) candidateSnapshot = undefined;
      if (!candidateSnapshot) {
        // Share only the first raw read; a failed/cancelled stage still rereads.
        const initial = initialCandidates; initialCandidates = undefined;
        const snapshotSignal = stageSignal ?? options.signal;
        candidateSnapshotSignal = snapshotSignal;
        const finish = reporter?.start('candidate_read');
        const pending = import('./memoryStore').then(async store => {
          if (!initial) return store.loadMemories({ currentOnly: true }, { signal: snapshotSignal, reporter });
          const memories = await initial;
          assertCurrent(snapshotSignal);
          const database = withMemoryDatabaseReadContext(await store.getMemoryDatabase(), { signal: snapshotSignal, reporter });
          const finishBasis = reporter?.start('basis_check');
          try { return await store.filterCurrentMemories(database, memories, { signal: snapshotSignal }); }
          finally { finishBasis?.(); }
        }).then(memories => {
            assertCurrent(stageSignal); return memories;
          }).finally(() => finish?.()).catch(error => {
          // Reuse results, not transient failures. A later, already scheduled
          // phase may read again; this does not start an automatic retry.
          if (candidateSnapshot === pending) candidateSnapshot = undefined;
          throw error;
        });
        candidateSnapshot = pending;
      }
      const memories = await candidateSnapshot;
      assertCurrent(stageSignal);
      return memories;
    },
    async filterCandidateSnapshots(memories: readonly MemoryEntry[]) {
      assertCurrent();
      if (!candidateSnapshot) return availableMemoryMaterialSnapshots(memories);
      const ids = new Set((await candidateSnapshot).map(memory => memory.id));
      assertCurrent();
      return memories.filter(memory => ids.has(memory.id));
    },
    wasRefreshed: (id: string) => refreshed.has(id),
    wasOnlySurfaceMuteRefreshed: (id: string) => muteOnlyRefreshes.has(id),
    commentsFor: (id: string) => comments.get(id) ?? [],
    memoryFor: (id: string) => omitted.has(id) ? undefined : currentMemories.get(id),
    sourceRefsFor: (id: string) => sourceRefs.get(id) ?? [],
    sources,
    assertCurrent,
    usageReferences(memories: readonly MemoryEntry[], used: { comments?: boolean; sources?: boolean } = {}): MemoryUsageReference[] {
      assertCurrent();
      return [...new Map(memories.map(memory => [memory.id, memory])).values()].flatMap(memory => {
        const current = currentMemories.get(memory.id);
        if (!current || omitted.has(memory.id) || weeklyTargetHash(current) !== weeklyTargetHash(memory)) return [];
        return [{ memoryId: memory.id, targetHash: weeklyTargetHash(memory),
          ...(used.comments ? { commentsHash: memoryUsageCommentsHash(comments.get(memory.id) ?? []) } : {}),
          ...(used.sources && sources.has(memory.id) ? { sourceVersion: sources.get(memory.id)!.version } : {}),
        }];
      });
    },
    async refresh(memories: readonly MemoryEntry[], eligible: (memory: MemoryEntry) => boolean = () => true, stageSignal?: AbortSignal,
      sourceIds?: ReadonlySet<string>, reporter?: MemoryRecallWorkReporter) {
      assertCurrent(stageSignal);
      const store = await import('./memoryStore');
      assertCurrent(stageSignal);
      const context = { signal: stageSignal ?? options.signal, reporter };
      const database = withMemoryDatabaseReadContext(await store.getMemoryDatabase(), context);
      const batch = await store.loadMemoryMaterialBatch(memories.filter(memory => !omitted.has(memory.id)).map(memory => memory.id), context);
      assertCurrent(stageSignal);
      const finishBasis = reporter?.start('basis_check');
      let statuses: Map<string, CurrentMemoryMaterialReason | undefined>;
      try { statuses = await inspectCurrentMemoryMaterials(database, [...batch.values()].map(value => value.memory),
        new Map([...batch].map(([id, value]) => [id, value.refs])), context); }
      finally { finishBasis?.(); }
      assertCurrent(stageSignal);
      const result: MemoryEntry[] = [];
      // Same reference on several selected cards is read once in this pass only.
      // The next refresh gets new messages, so source edits/deletions remain visible.
      const needsSources = sourceIds ? sourceIds.size > 0 : options.includeSources;
      const sourceReader = needsSources ? await import('./memorySourceReader') : undefined;
      const sourceReads = new Map<string, ReturnType<NonNullable<typeof sourceReader>['loadMemorySourceMessage']>>();
      const readSource = (sessionId: string, messageId: string) => {
        const key = JSON.stringify([sessionId, messageId]);
        let read = sourceReads.get(key);
        if (!read) { read = sourceReader!.loadMemorySourceMessage(sessionId, messageId); sourceReads.set(key, read); }
        return read;
      };
      for (const original of memories) {
        if (omitted.has(original.id)) continue;
        const selected = batch.get(original.id);
        const memory = selected?.memory;
        const reason = statuses.get(original.id);
        if (!memory || reason) {
          omitted.add(original.id);
          reasons.set(original.id, reason ?? 'missing');
          comments.delete(original.id);
          sourceRefs.delete(original.id);
          sources.delete(original.id);
          currentMemories.delete(original.id);
          continue;
        }
        const validComments = currentMemoryComments(memory, selected!.comments);
        assertCurrent(stageSignal);
        const refs = selected!.refs;
        assertCurrent(stageSignal);
        const finishSource = (sourceIds ? sourceIds.has(memory.id) : options.includeSources) ? reporter?.start('source_read') : undefined;
        let source: MemoryReadSnapshot | 'missing' | 'weekly_stale' | 'understanding_stale' | 'unavailable' | undefined;
        try { source = (sourceIds ? sourceIds.has(memory.id) : options.includeSources)
          ? await (await import('./memoryReadMaterials')).loadMemoryReadSnapshot(memory.id, 'source', database,
            { memory, comments: validComments, refs, readSource }) : undefined; }
        finally { finishSource?.(); }
        assertCurrent(stageSignal);
        if (typeof source === 'string') {
          omitted.add(memory.id);
          reasons.set(memory.id, source === 'unavailable' ? 'post_source_stale' : source as CurrentMemoryMaterialReason);
          comments.delete(memory.id);
          sourceRefs.delete(memory.id);
          sources.delete(memory.id);
          currentMemories.delete(memory.id);
          continue;
        }
        const version = stableMemoryHash(JSON.stringify([weeklyTargetHash(memory), validComments, refs]));
        const recallHash = weeklyTargetHash({ ...memory, surfaceMutedAt: undefined });
        const recallVersion = stableMemoryHash(JSON.stringify([recallHash, validComments, refs]));
        const previous = versions.get(memory.id);
        const previousRecall = recallVersions.get(memory.id);
        const previousSource = sources.get(memory.id);
        const sourceScope = stableMemoryHash(JSON.stringify([memory.sourceTraceMode, memory.sourceStartAt, memory.sourceEndAt, refs]));
        // Starting a detail view is not a source edit. Once actually read, changes
        // to that source still consume the same single reread allowance.
        const sourceChanged = source !== undefined && previousSource !== undefined
          && sourceScopes.get(memory.id) === sourceScope
          && (typeof source === 'object' ? source.sourceContentVersion ?? source.version : source)
            !== (previousSource.sourceContentVersion ?? previousSource.version);
        const changed = sourceChanged || (previous === undefined
          ? weeklyTargetHash(original) !== weeklyTargetHash(memory) : previous !== version);
        if (changed && refreshed.has(memory.id)) {
          omitted.add(memory.id);
          reasons.set(memory.id, 'changed_again');
          comments.delete(memory.id);
          sourceRefs.delete(memory.id);
          sources.delete(memory.id);
          currentMemories.delete(memory.id);
          continue;
        }
        if (changed) {
          refreshed.add(memory.id);
          const muteOnly = !sourceChanged && (previousRecall === undefined
            ? weeklyTargetHash({ ...original, surfaceMutedAt: undefined }) === recallHash
            : previousRecall === recallVersion);
          if (muteOnly) muteOnlyRefreshes.add(memory.id);
          else muteOnlyRefreshes.delete(memory.id);
        }
        versions.set(memory.id, version);
        recallVersions.set(memory.id, recallVersion);
        currentMemories.set(memory.id, memory);
        comments.set(memory.id, validComments);
        sourceRefs.set(memory.id, refs);
        if (typeof source === 'object') { sources.set(memory.id, source); sourceScopes.set(memory.id, sourceScope); }
        // Category/date filters belong to an entry point. They must not poison another
        // entry sharing this preparation (for example annual and fresh letter material).
        if (eligible(memory)) result.push(memory);
      }
      // Sources and derived evidence can change during another card's asynchronous
      // read. Validate the whole returned set again, sharing one fresh refs query.
      const finishFinalBasis = reporter?.start('basis_check');
      let finalStatuses: Map<string, CurrentMemoryMaterialReason | undefined>;
      try { finalStatuses = await inspectCurrentMemoryMaterials(database, result, undefined, context); }
      finally { finishFinalBasis?.(); }
      assertCurrent(stageSignal);
      return result.filter(memory => {
        const reason = finalStatuses.get(memory.id);
        if (!reason) return true;
        omitted.add(memory.id); reasons.set(memory.id, reason);
        comments.delete(memory.id); sourceRefs.delete(memory.id); sources.delete(memory.id); currentMemories.delete(memory.id);
        return false;
      });
    },
  };
}

export type MemoryMaterialPreparation = ReturnType<typeof createMemoryMaterialPreparation>;
