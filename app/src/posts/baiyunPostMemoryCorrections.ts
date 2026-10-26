import { stableMemoryHash } from '../memory/memoryAtomicity';
import { getMemoryDatabase, loadMemory, memoryFromRow } from '../memory/memoryStore';
import { currentStateVersion, loadMemoryCurrentStates, type MemoryCurrentState } from '../memory/memoryCurrentStateStore';
import { weeklyTargetHash } from '../memory/memoryWeeklyBasis';
import type { MemoryIngestionBatch } from '../memory/memoryIngestionLedger';
import { inspectPostDerivedTargets } from './baiyunPostMemoryBasis';
import type { PostMemoryOriginal } from './baiyunPostMemorySource';

export type PostCorrectionTarget = { kind: 'memory' | 'current_state'; id: string; key: string;
  sourceIds: string[]; targetHash: string };

/** Exact source identities find comparison targets; shared words never bind an update. */
export async function preparePostCorrectionTargets(originals: PostMemoryOriginal[], batches: MemoryIngestionBatch[],
  options: { retry?: boolean; target?: { kind: 'memory' | 'current_state'; id: string } } = {}) {
  const database = await getMemoryDatabase();
  const rows = await database.getAllAsync<Parameters<typeof memoryFromRow>[0]>(
    "SELECT DISTINCT m.* FROM memories m JOIN memory_source_refs r ON r.memory_id = m.id WHERE m.type <> 'archived' AND r.session_id LIKE 'post-source:%' AND r.relation = 'direct' ORDER BY m.id");
  const memories = rows.map(memoryFromRow);
  const sourceRows = await database.getAllAsync<{ memory_id: string; session_id: string; message_id: string; relation: 'direct' }>(
    "SELECT memory_id, session_id, message_id, relation FROM memory_source_refs WHERE session_id LIKE 'post-source:%' AND relation = 'direct'");
  const states: MemoryCurrentState[] = [];
  for (;;) {
    const page = await loadMemoryCurrentStates({ limit: 100, offset: states.length });
    states.push(...page);
    if (page.length < 100) break;
  }
  const targets = [
    ...memories.map(memory => ({ kind: 'memory' as const, id: memory.id,
      sourceRefs: sourceRows.filter(row => row.memory_id === memory.id).map(row => ({ sessionId: row.session_id,
        messageId: row.message_id, relation: row.relation })), targetHash: weeklyTargetHash(memory) })),
    ...states.filter(state => state.sourceRefs.some(ref => ref.sessionId.startsWith('post-source:')))
      .map(state => ({ kind: 'current_state' as const, id: state.id, sourceRefs: state.sourceRefs, targetHash: currentStateVersion(state) })),
  ];
  const inspected = await inspectPostDerivedTargets(database, targets);
  const settled = new Set(batches.filter(batch => ['resolved', 'no_value'].includes(batch.status))
    .flatMap(batch => batch.workMetadata?.post?.corrections?.map(target => target.key) ?? []));
  const corrections: PostCorrectionTarget[] = [];
  for (const target of targets) {
    if (options.target && (target.kind !== options.target.kind || target.id !== options.target.id)) continue;
    const inspectedTarget = inspected.find(item => item.kind === target.kind && item.id === target.id)!;
    if (inspectedTarget.status === 'current' && !options.target) continue;
    const refs = target.sourceRefs.filter(ref => ref.relation !== 'derived' && ref.sessionId.startsWith('post-source:'));
    const sources = refs.map(ref => originals.find(original => original.sessionId === ref.sessionId && original.messageId === ref.messageId));
    // Deleted/unread originals remain unavailable; do not invent correction material.
    if (!sources.length || sources.some(source => !source)) continue;
    const sourceIds = sources.map(source => source!.messageId);
    const key = stableMemoryHash(JSON.stringify([target.kind, target.id, target.targetHash,
      sources.map(source => [source!.sessionId, source!.messageId, source!.sourceHash]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
    if (!options.retry && settled.has(key)) continue;
    corrections.push({ kind: target.kind, id: target.id, key, sourceIds, targetHash: target.targetHash });
  }
  return corrections;
}

export async function validatePostCorrectionTargets(targets: readonly PostCorrectionTarget[]) {
  const database = await getMemoryDatabase();
  for (const target of targets) {
    if (target.kind === 'memory') {
      const memory = await loadMemory(target.id);
      if (!memory || memory.type === 'archived' || weeklyTargetHash(memory) !== target.targetHash) throw new Error('POST_MEMORY_CORRECTION_TARGET_CHANGED');
    } else {
      const state = await (await import('../memory/memoryCurrentStateStore')).loadMemoryCurrentState(target.id, database);
      if (!state || state.status !== 'active' || currentStateVersion(state) !== target.targetHash) throw new Error('POST_MEMORY_CORRECTION_TARGET_CHANGED');
    }
  }
}
