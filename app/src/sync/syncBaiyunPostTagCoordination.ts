import { selectBaiyunPostHeads, BaiyunPostHeadDependencyError,
  type BaiyunPostHeadSelection } from './syncBaiyunPostHeadReconciliation';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type BaiyunPostSyncTag = {
  id: string; name: string; scope: 'I' | 'you' | 'both';
  merged_into_id: string | null; merged_at: number | null;
  updated_at: number; version_id: string;
};
export type BaiyunPostMembershipRevision = Pick<PlainMutationV1, 'entity' | 'payload' | 'revision' | 'createdAt'>;
const payloadRecord = (mutation: BaiyunPostMembershipRevision) =>
  (mutation.payload as { record: Record<string, JsonValue> }).record;

// v5 has no separate business stamp. Its original signed revision owns that
// stamp; callers select its original winner before normalizing generated heads.
export function readBaiyunPostSyncTag(mutation: BaiyunPostMembershipRevision): BaiyunPostSyncTag | null {
  if (mutation.revision.operation === 'delete') return null;
  const row = payloadRecord(mutation);
  return { id: String(row.id), name: String(row.name), scope: row.scope as BaiyunPostSyncTag['scope'],
    merged_into_id: typeof row.merged_into_id === 'string' ? row.merged_into_id : null,
    merged_at: typeof row.merged_at === 'number' ? row.merged_at : null,
    updated_at: typeof row.updated_at === 'number' ? row.updated_at : mutation.createdAt,
    version_id: typeof row.version_id === 'string' ? row.version_id : mutation.revision.id };
}
function preferredStamp(left: BaiyunPostSyncTag, right: BaiyunPostSyncTag) {
  return left.updated_at !== right.updated_at ? left.updated_at > right.updated_at ? left : right
    : left.version_id < right.version_id ? left : right;
}
const unionScope = (rows: readonly BaiyunPostSyncTag[]): BaiyunPostSyncTag['scope'] =>
  rows.every(row => row.scope === rows[0].scope) ? rows[0].scope : 'both';
const allows = (tag: BaiyunPostSyncTag, author: 'I' | 'you') => tag.scope === 'both' || tag.scope === author;
const tagPayload = (record: BaiyunPostSyncTag): JsonValue => ({ schemaVersion: 7, record: { ...record } });

export function planBaiyunPostTagLibrary(selected: readonly PlainMutationV1[]) {
  const records = new Map(selected.flatMap(mutation => {
    const tag = readBaiyunPostSyncTag(mutation); return tag ? [[tag.id, tag] as const] : [];
  }));
  const originals = new Map(records);
  // Concurrent A→B and B→A merges have real source snapshots, so a cycle can
  // select a stable existing ID without inventing a tag or losing either scope.
  for (const id of [...records.keys()].sort()) {
    const path: string[] = [], positions = new Map<string, number>();
    let current: string | null = id;
    while (current && records.has(current)) {
      const position = positions.get(current);
      if (position !== undefined) {
        const cycle = path.slice(position), root = [...cycle].sort()[0];
        const rows = cycle.map(key => records.get(key)!), stamp = rows.reduce(preferredStamp);
        const at = Math.max(...rows.map(row => row.merged_at ?? row.updated_at));
        records.set(root, { ...records.get(root)!, scope: unionScope(rows), merged_into_id: null, merged_at: null,
          updated_at: stamp.updated_at, version_id: stamp.version_id });
        for (const key of cycle) if (key !== root) records.set(key, { ...records.get(key)!,
          merged_into_id: root, merged_at: at, updated_at: stamp.updated_at, version_id: stamp.version_id });
        break;
      }
      positions.set(current, path.length); path.push(current);
      current = records.get(current)!.merged_into_id;
    }
  }
  const byName = new Map<string, BaiyunPostSyncTag[]>();
  for (const row of records.values()) if (!row.merged_into_id) {
    const name = row.name.normalize('NFC'); byName.set(name, [...(byName.get(name) ?? []), row]);
  }
  for (const rows of byName.values()) {
    if (rows.length < 2) continue;
    const ordered = [...rows].sort((a, b) => a.id < b.id ? -1 : 1);
    const root = ordered[0], stamp = ordered.reduce(preferredStamp);
    records.set(root.id, { ...root, scope: unionScope(ordered), updated_at: stamp.updated_at, version_id: stamp.version_id });
    for (const row of ordered.slice(1)) records.set(row.id, { ...row, merged_into_id: root.id,
      merged_at: stamp.updated_at, updated_at: stamp.updated_at, version_id: stamp.version_id });
  }
  return [...records.values()].filter(row => JSON.stringify(row) !== JSON.stringify(originals.get(row.id)));
}

async function historyOf(heads: readonly PlainMutationV1[], load: (id: string) => Promise<PlainMutationV1 | null>) {
  const graph = new Map(heads.map(head => [head.revision.id, head]));
  const pending = heads.flatMap(head => head.revision.parents), missing = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!; if (graph.has(id) || missing.has(id)) continue;
    const mutation = await load(id);
    if (!mutation) { missing.add(id); continue; }
    graph.set(id, mutation); pending.push(...mutation.revision.parents);
  }
  if (missing.size) throw new BaiyunPostHeadDependencyError([...missing].sort());
  return [...graph.values()];
}

export async function reconcileBaiyunPostTagLibrary(input: {
  loadHeads(): Promise<PlainMutationV1[]>;
  loadRevision(id: string): Promise<PlainMutationV1 | null>;
  capture(selection: BaiyunPostHeadSelection, parentIds: string[]): Promise<PlainMutationV1>;
  materialize(mutation: PlainMutationV1): Promise<unknown>;
}): Promise<PlainMutationV1[]> {
  const all = await input.loadHeads(), groups = new Map<string, PlainMutationV1[]>();
  for (const head of all) {
    if (head.entity.domain !== 'memory' || head.entity.type !== 'post-tag') throw new Error('post-tag-library-identity');
    groups.set(head.entity.id, [...(groups.get(head.entity.id) ?? []), head]);
  }
  const selected = new Map<string, PlainMutationV1>(), origins = new Map<string, PlainMutationV1>();
  for (const [id, heads] of groups) {
    const choice = selectBaiyunPostHeads(heads, await historyOf(heads, input.loadRevision))!;
    const mutation = choice.headRevisionIds.length > 1 ? await input.capture(choice, choice.headRevisionIds) : heads[0];
    selected.set(id, mutation);
    origins.set(id, { ...choice.template, payload: choice.payload, revision: { ...choice.template.revision, operation: choice.operation } });
  }
  for (const row of planBaiyunPostTagLibrary([...origins.values()])) {
    const current = selected.get(row.id)!;
    const parents = [current.revision.id];
    const selection: BaiyunPostHeadSelection = { template: current, payload: tagPayload(row),
      operation: current.revision.operation === 'delete' ? 'restore' : 'upsert', schemaVersion: 7, objectRefs: [],
      headRevisionIds: parents, effectiveHeadRevisionIds: parents, winnerRevisionId: current.revision.id };
    selected.set(row.id, await input.capture(selection, parents));
  }
  // Hide former IDs before installing a same-name canonical row. A failure
  // leaves captured heads in the original queue, and retry reuses those heads.
  const ordered = [...selected.values()].sort((a, b) => {
    const rank = (mutation: PlainMutationV1) => mutation.revision.operation === 'delete' ? 0
      : readBaiyunPostSyncTag(mutation)!.merged_into_id ? 1 : 2;
    return rank(a) - rank(b) || (a.entity.id < b.entity.id ? -1 : 1);
  });
  for (const mutation of ordered) await input.materialize(mutation);
  return ordered;
}

/** Project only supplied references. Widening a library never creates tags on
 * another post. Original signed snapshots/history remain unchanged. */
export function projectBaiyunPostTagIds(input: {
  author: 'I' | 'you'; tagIds: string[]; post: BaiyunPostMembershipRevision | null;
  postHistory: readonly BaiyunPostMembershipRevision[]; tags: readonly PlainMutationV1[];
  tagHistory: readonly BaiyunPostMembershipRevision[];
  tagRecords?: readonly BaiyunPostSyncTag[]; deletedTagIds?: readonly string[];
}) {
  const tags = new Map(input.tags.map(mutation => [mutation.entity.id, readBaiyunPostSyncTag(mutation)]));
  if (input.tagRecords) {
    tags.clear();
    for (const id of input.deletedTagIds ?? []) tags.set(id, null);
    for (const row of input.tagRecords) tags.set(row.id, row);
  }
  const tagGraph = new Map(input.tagHistory.map(mutation => [mutation.revision.id, mutation]));
  function actualTagVersion(mutation: BaiyunPostMembershipRevision, seen = new Set<string>()): BaiyunPostMembershipRevision {
    if (mutation.revision.operation === 'delete' || typeof payloadRecord(mutation).updated_at === 'number') return mutation;
    if (seen.has(mutation.revision.id)) throw new Error('post-tag-history-cycle');
    const next = new Set(seen).add(mutation.revision.id), row = readBaiyunPostSyncTag(mutation)!;
    const copies = mutation.revision.parents.length < 2 ? [] : mutation.revision.parents
      .map(id => tagGraph.get(id)).filter((parent): parent is BaiyunPostMembershipRevision => Boolean(parent)
        && parent!.revision.operation !== 'delete' && parent!.entity.id === mutation.entity.id)
      .filter(parent => {
        const before = readBaiyunPostSyncTag(parent)!;
        return before.name === row.name && before.scope === row.scope && before.merged_into_id === row.merged_into_id;
      }).map(parent => actualTagVersion(parent, next));
    return copies.sort((a, b) => b.createdAt - a.createdAt || (a.revision.id < b.revision.id ? -1 : 1))[0] ?? mutation;
  }
  function target(source: string) {
    let id = source; const seen = new Set<string>();
    const trail: { id: string; mergedAt: number | null }[] = [];
    while (tags.has(id)) {
      if (seen.has(id)) throw new Error('post-tag-alias-cycle');
      seen.add(id); const tag = tags.get(id);
      if (!tag) return null;
      if (!tag.merged_into_id) return { id, trail: [...trail, { id, mergedAt: null }], tag };
      trail.push({ id, mergedAt: tag.merged_at ?? tag.updated_at }); id = tag.merged_into_id;
    }
    // A real merge may precede its target. Keep the reference, without creating
    // any target row; its actual scope/deletion will resolve it when it arrives.
    return { id, trail: [...trail, { id, mergedAt: null }], tag: null };
  }
  const graph = new Map(input.postHistory.map(mutation => [mutation.revision.id, mutation]));
  if (input.post) graph.set(input.post.revision.id, input.post);
  const rawIds = (mutation: BaiyunPostMembershipRevision) => mutation.revision.operation === 'delete' ? []
    : JSON.parse(String(payloadRecord(mutation).tag_ids_json)) as string[];
  const memo = new Map<string, number>();
  function introduced(mutation: BaiyunPostMembershipRevision, tagId: string, visiting = new Set<string>()): number {
    const key = JSON.stringify([mutation.revision.id, tagId]);
    if (memo.has(key)) return memo.get(key)!;
    if (visiting.has(mutation.revision.id)) throw new Error('post-tag-membership-cycle');
    const nextVisited = new Set(visiting).add(mutation.revision.id);
    const parents = mutation.revision.parents.map(id => {
      const parent = graph.get(id);
      if (!parent) throw new BaiyunPostHeadDependencyError([id]);
      return parent;
    }).filter(parent => rawIds(parent).includes(tagId));
    const at = parents.length ? Math.min(...parents.map(parent => introduced(parent, tagId, nextVisited))) : mutation.createdAt;
    memo.set(key, at); return at;
  }
  const result: string[] = [];
  for (const source of input.tagIds) {
    const resolved = target(source); if (!resolved || resolved.tag && !allows(resolved.tag, input.author)) continue;
    const sources = input.post ? rawIds(input.post).filter(id => target(id)?.id === resolved.id) : [];
    // A later widening/rename cannot restore a membership that a real earlier
    // scope restriction/deletion already removed. Body edits inherit its
    // original introduction; an actual remove→re-add starts a new membership.
    const retained = (sources.length ? sources : [source]).some(member => {
      let at = input.post && sources.length ? introduced(input.post, member)
        : input.post?.createdAt ?? Number.MAX_SAFE_INTEGER;
      let afterMerge = false;
      // A merge moves surviving memberships. It cannot revive a source
      // membership already removed before the merge. Each real alias hop
      // starts target classification after that hop's business timestamp.
      for (const hop of target(member)!.trail) {
        const restricted = input.tagHistory.some(mutation => {
          if (mutation.entity.id !== hop.id) return false;
          const row = readBaiyunPostSyncTag(actualTagVersion(mutation));
          const time = row?.updated_at ?? mutation.createdAt;
          return (row ? !row.merged_into_id && !allows(row, input.author) : true)
            && (afterMerge ? time > at : time >= at)
            && (hop.mergedAt === null || time < hop.mergedAt);
        });
        if (restricted) return false;
        if (hop.mergedAt !== null) { at = Math.max(at, hop.mergedAt); afterMerge = true; }
      }
      return true;
    });
    if (retained && !result.includes(resolved.id)) result.push(resolved.id);
  }
  return result.slice(0, 3);
}
