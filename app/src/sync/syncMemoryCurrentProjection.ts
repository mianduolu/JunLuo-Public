import { mergeMemoryStatsPayload, sameMemoryRecordPayload, type MemoryRecordRevisionValue } from './syncMemoryRecordsMerge';
import type { JsonValue } from './syncProtocol';

function comparable(payload: JsonValue, bodyOnly = false, keepUpdatedAt = false) {
  const normalized = mergeMemoryStatsPayload(payload, 'memory') as { record: Record<string, JsonValue> };
  const record = { ...normalized.record };
  if (!keepUpdatedAt) delete record.updated_at;
  if (bodyOnly) for (const key of ['activation_count', 'last_active_at', 'surface_count', 'stats_semantics_version', 'last_mentioned_at']) delete record[key];
  return record;
}

/** Reconcile a selected whole memory only when every local branch is accounted for. */
export async function planCurrentMemoryProjection(input: {
  incoming: MemoryRecordRevisionValue;
  heads: MemoryRecordRevisionValue[];
  business: JsonValue | null;
  loadRevision(id: string): Promise<MemoryRecordRevisionValue | null>;
}): Promise<{ aligned: boolean; payload: JsonValue; requiresMerge: boolean } | null> {
  if (input.incoming.operation !== 'upsert' || !input.business || !input.heads.length
    || input.heads.some(head => head.operation !== 'upsert')) return null;
  const sameBody = (left: JsonValue, right: JsonValue) => sameMemoryRecordPayload(comparable(left, true), comparable(right, true));
  // An uncaptured business edit is still an edit, even if its native head is stale.
  if (!input.heads.some(head => sameMemoryRecordPayload(
    comparable(head.payload, true, true), comparable(input.business!, true, true)))) return null;
  let payload = mergeMemoryStatsPayload(input.incoming.payload, 'memory', input.business);
  for (const head of input.heads) payload = mergeMemoryStatsPayload(payload, 'memory', head.payload);
  if (input.heads.length === 1 && sameMemoryRecordPayload(comparable(input.heads[0].payload), comparable(payload))
    && sameMemoryRecordPayload(comparable(input.business), comparable(payload))) return { aligned: true, payload, requiresMerge: false };

  const ancestors = new Set([input.incoming.revisionId, ...input.incoming.parentRevisionIds]);
  const pending = [...input.incoming.parentRevisionIds];
  const visited = new Set<string>();
  const cache = new Map<string, MemoryRecordRevisionValue | null>();
  const load = async (id: string) => {
    if (!cache.has(id)) {
      if (cache.size >= 256) return null;
      cache.set(id, await input.loadRevision(id));
    }
    return cache.get(id) ?? null;
  };
  const covered = async (head: MemoryRecordRevisionValue, path = new Set<string>()): Promise<boolean> => {
    if (ancestors.has(head.revisionId)) return true;
    if (path.has(head.revisionId) || !head.parentRevisionIds.length) return false;
    const nextPath = new Set([...path, head.revisionId]);
    for (const id of head.parentRevisionIds) {
      const parent = await load(id);
      if (!parent || parent.operation !== 'upsert' || !sameBody(head.payload, parent.payload)
        || !await covered(parent, nextPath)) return false;
    }
    return true;
  };
  for (;;) {
    let allCovered = true;
    for (const head of input.heads) if (!await covered(head)) { allCovered = false; break; }
    if (allCovered) return { aligned: false, payload,
      requiresMerge: input.heads.some(head => !ancestors.has(head.revisionId)) };
    const id = pending.shift();
    if (!id || visited.size >= 256) return null;
    if (visited.has(id)) continue;
    visited.add(id);
    const revision = await load(id);
    // Missing ancestry cannot authorize absorbing a local branch.
    if (!revision) return null;
    for (const parent of revision.parentRevisionIds) {
      ancestors.add(parent);
      if (!visited.has(parent)) pending.push(parent);
    }
  }
}
