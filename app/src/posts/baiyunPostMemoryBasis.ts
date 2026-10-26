import type { SQLiteDatabase } from 'expo-sqlite';
import type { PostMaterialBinding, PostMemoryReadOptions } from './baiyunPostMemorySource';

export type PostDerivedReader = Pick<SQLiteDatabase, 'getFirstAsync' | 'getAllAsync'>;
export type PostDerivedSourceRef = { sessionId: string; messageId: string; relation?: 'direct' | 'derived' };
export type PostDerivedTarget = {
  kind: 'memory' | 'current_state';
  id: string;
  status: 'current' | 'changed' | 'unverified';
  bindings: PostMaterialBinding[];
};
type TargetInput = Pick<PostDerivedTarget, 'kind' | 'id'> & { sourceRefs?: readonly PostDerivedSourceRef[] };
type SavedRow = { memory_id: string | null; candidate_json: string | null; resolved_at: number | null; work_metadata_json: string | null };
type Confirmation = { at: number; bindings: PostMaterialBinding[]; incomplete: boolean };
const sourceKey = (ref: Pick<PostDerivedSourceRef, 'sessionId' | 'messageId'>) => JSON.stringify([ref.sessionId, ref.messageId]);
const targetKey = (target: Pick<PostDerivedTarget, 'kind' | 'id'>) => JSON.stringify([target.kind, target.id]);
const hasPostNamespace = (ref: PostDerivedSourceRef) => typeof ref.sessionId === 'string'
  && ref.sessionId.startsWith('post-source:') && ref.sessionId.length > 12;
const isPostSource = (ref: PostDerivedSourceRef) => ref.relation !== 'derived' && hasPostNamespace(ref);
function parse(value: string | null): unknown {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

async function readTargetRefs(database: PostDerivedReader, targets: readonly TargetInput[]) {
  const byTarget = new Map<string, { sourceRefs: readonly PostDerivedSourceRef[]; invalid?: boolean }>();
  const memoryIds = [...new Set(targets.filter(target => target.kind === 'memory' && target.sourceRefs === undefined).map(target => target.id))];
  const stateIds = [...new Set(targets.filter(target => target.kind === 'current_state' && target.sourceRefs === undefined).map(target => target.id))];
  if (memoryIds.length) {
    const rows = await database.getAllAsync<{ memory_id: string; session_id: string; message_id: string; relation: 'direct' | 'derived' }>(
      `SELECT memory_id, session_id, message_id, relation FROM memory_source_refs WHERE memory_id IN (SELECT value FROM json_each(?))`, JSON.stringify(memoryIds));
    const refsByMemory = new Map<string, PostDerivedSourceRef[]>();
    for (const row of rows) {
      const id = row.memory_id;
      let refs = refsByMemory.get(id);
      if (!refs) { refs = []; refsByMemory.set(id, refs); }
      refs.push({ sessionId: row.session_id, messageId: row.message_id, relation: row.relation });
    }
    for (const id of memoryIds) byTarget.set(targetKey({ kind: 'memory', id }), { sourceRefs: refsByMemory.get(id) ?? [] });
  }
  if (stateIds.length) {
    const rows = await database.getAllAsync<{ id: string; source_refs_json: string | null }>(
      'SELECT id, source_refs_json FROM memory_current_states WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(stateIds));
    for (const row of rows) {
      const refs = parse(row.source_refs_json);
      const valid = Array.isArray(refs) && refs.every(ref => ref && typeof ref.sessionId === 'string' && typeof ref.messageId === 'string'
        && (ref.relation === undefined || ref.relation === 'direct' || ref.relation === 'derived'));
      byTarget.set(targetKey({ kind: 'current_state', id: row.id }), { sourceRefs: valid ? refs : [], invalid: !!row.source_refs_json && !valid });
    }
  }
  return targets.map(target => target.sourceRefs !== undefined ? { sourceRefs: target.sourceRefs }
    : byTarget.get(targetKey(target)) ?? { sourceRefs: [] });
}

/** Saved items certify only their own precise direct references, never their entire batch. */
export async function inspectPostDerivedTargets(database: PostDerivedReader, targets: readonly TargetInput[],
  options: PostMemoryReadOptions = {}): Promise<PostDerivedTarget[]> {
  const targetRefs = await readTargetRefs(database, targets);
  const directRefs = targetRefs.map(target => [...new Map(target.sourceRefs.filter(isPostSource).map(ref => [sourceKey(ref), ref])).values()]);
  if (!directRefs.some(refs => refs.length)) return targets.map(({ kind, id }, index) => ({ kind, id,
    status: targetRefs[index].invalid ? 'unverified' : 'current', bindings: [] }));
  const sources = await import('./baiyunPostMemorySource');
  const memoryIds = [...new Set(targets.filter((target, index) => directRefs[index].length && target.kind === 'memory').map(target => target.id))];
  const stateIds = [...new Set(targets.filter((target, index) => directRefs[index].length && target.kind === 'current_state').map(target => target.id))];
  const rows = await database.getAllAsync<SavedRow>(
    `SELECT i.memory_id, i.candidate_json, i.resolved_at, b.work_metadata_json
     FROM memory_ingestion_items i JOIN memory_ingestion_batches b ON b.id = i.batch_id
     WHERE i.status = 'saved' AND b.stream = 'post'
       AND (i.memory_id IN (SELECT value FROM json_each(?))
         OR CASE WHEN json_valid(i.candidate_json) THEN json_extract(i.candidate_json, '$.savedCurrentStateId') END
           IN (SELECT value FROM json_each(?)))
     UNION ALL SELECT memory_id,
       json_object('reviewedSourceRefs',json(refs_json),'savedCurrentStateId',current_state_id), confirmed_at,
       json_object('post',json_object('bindings',json(bindings_json)))
     FROM baiyun_post_confirmations WHERE memory_id IN (SELECT value FROM json_each(?))
       OR current_state_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(memoryIds), JSON.stringify(stateIds), JSON.stringify(memoryIds), JSON.stringify(stateIds));
  const confirmations = new Map<string, Map<string, Confirmation>>();
  for (const row of rows) {
    const receipt = parse(row.candidate_json) as { reviewedSourceRefs?: PostDerivedSourceRef[]; savedCurrentStateId?: string } | null;
    const work = parse(row.work_metadata_json) as { post?: { bindings?: unknown[] } } | null;
    if (!Array.isArray(receipt?.reviewedSourceRefs) || !Number.isSafeInteger(row.resolved_at) || row.resolved_at! < 0) continue;
    const keys = [row.memory_id ? targetKey({ kind: 'memory', id: row.memory_id }) : null,
      typeof receipt.savedCurrentStateId === 'string' ? targetKey({ kind: 'current_state', id: receipt.savedCurrentStateId }) : null].filter((key): key is string => key !== null);
    const valid = Array.isArray(work?.post?.bindings) ? work.post.bindings.filter(sources.isPostMaterialBinding) : [];
    for (const key of keys) {
      let confirmed = confirmations.get(key);
      if (!confirmed) { confirmed = new Map(); confirmations.set(key, confirmed); }
      for (const ref of receipt.reviewedSourceRefs) {
        if (!ref || typeof ref.sessionId !== 'string' || typeof ref.messageId !== 'string') continue;
        const refKey = sourceKey(ref), bindings = valid.filter(binding => sourceKey(binding) === refKey);
        const previous = confirmed.get(refKey), at = row.resolved_at!;
        if (!previous || previous.at < at) confirmed.set(refKey, { at, bindings, incomplete: !bindings.length });
        else if (previous.at === at) { previous.bindings.push(...bindings); previous.incomplete ||= !bindings.length; }
      }
    }
  }
  const selected = targets.map((target, index) => {
    const confirmed = confirmations.get(targetKey(target));
    let incomplete = !!targetRefs[index].invalid;
    const bindings = directRefs[index].flatMap(ref => {
      const proof = confirmed?.get(sourceKey(ref));
      if (!proof || proof.incomplete || new Set(proof.bindings.map(binding => binding.sourceHash)).size !== 1) incomplete = true;
      // Keep usable source identities even when another source still needs verification.
      return proof?.bindings.length ? [proof.bindings[0]] : [];
    });
    return { incomplete, bindings };
  });
  const postIds = [...new Set(selected.flatMap(item => item.bindings.map(binding => binding.postId)))];
  const originals = postIds.length ? await sources.loadPostMemoryOriginals(postIds, { ...options, database }) : [];
  const current = new Map(originals.map(original => [sourceKey(original), original.sourceHash]));
  return targets.map(({ kind, id }, index) => ({ kind, id, bindings: selected[index].bindings,
    status: selected[index].incomplete ? 'unverified'
      : selected[index].bindings.some(binding => current.get(sourceKey(binding)) !== binding.sourceHash) ? 'changed' : 'current' }));
}

/** Omitted references are read from the existing target; original/detail readers remain unrestricted. */
export async function getPostDerivedStatus(database: PostDerivedReader, kind: PostDerivedTarget['kind'], id: string,
  sourceRefs?: readonly PostDerivedSourceRef[], options: PostMemoryReadOptions = {}): Promise<PostDerivedTarget> {
  return (await inspectPostDerivedTargets(database, [{ kind, id, sourceRefs }], options))[0];
}

/** Prepare the only non-SQL snapshot before acquiring a memory transaction. */
export async function preloadPostDerivedReadOptions(database: PostDerivedReader,
  targets: readonly TargetInput[],
  options: PostMemoryReadOptions = {}): Promise<PostMemoryReadOptions> {
  if (options.knowledge) return options;
  const hasPost = (await readTargetRefs(database, targets)).some(target => target.sourceRefs.some(hasPostNamespace));
  return hasPost ? { ...options, knowledge: await (await import('./baiyunPostMemorySource')).loadPostMemoryKnowledgeSnapshot(database) } : options;
}
