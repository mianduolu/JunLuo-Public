import { assertMemoryRecordsMutationV1, getMemoryRecordObjectRefs } from './syncMemoryRecords';
import { mergeMemoryStatsPayload, memoryRecordCorrectionMarker } from './syncMemoryRecordsMerge';
import { assertMemoryExperienceMutationV1, mergePostReadingSyncValuesV1, mergePostNoticeReadSyncValuesV1,
  type PostReadingSyncValueV1, type PostNoticeReadSyncValueV1 } from './syncMemoryExperience';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

type Entity = PlainMutationV1['entity'];
export type BaiyunPostHeadSelection = {
  template: PlainMutationV1;
  payload: JsonValue;
  operation: 'upsert' | 'restore' | 'delete';
  schemaVersion: number;
  objectRefs: string[];
  headRevisionIds: string[];
  effectiveHeadRevisionIds: string[];
  winnerRevisionId: string | null;
  settledRevisionId?: string | null;
};

export class BaiyunPostHeadDependencyError extends Error {
  constructor(readonly missingRevisionIds: string[]) {
    super(`baiyun-post-head-parent-pending:${missingRevisionIds.join(',')}`);
    this.name = 'BaiyunPostHeadDependencyError';
  }
}

export function isBaiyunPostHeadEntity(entity: Entity) {
  return entity.domain === 'memory' && (['post', 'post-comment', 'post-tag'].includes(entity.type)
    || entity.type === 'interaction-fact' && ['post-reading', 'post-notice-read'].includes(entity.id));
}
export function isBaiyunPostHeadMutation(mutation: PlainMutationV1) {
  return isBaiyunPostHeadEntity(mutation.entity);
}
function sameEntity(left: Entity, right: Entity) {
  return left.domain === right.domain && left.type === right.type && left.id === right.id;
}
function validate(mutation: PlainMutationV1, entity: Entity, vaultId: string) {
  if (!sameEntity(mutation.entity, entity) || mutation.vaultId !== vaultId) throw new Error('baiyun-post-head-history-identity-mismatch');
  if (entity.type === 'interaction-fact') assertMemoryExperienceMutationV1(mutation);
  else assertMemoryRecordsMutationV1(mutation);
}
function record(payload: JsonValue) { return (payload as { record: Record<string, JsonValue> }).record; }
function correctionBlocksLegacy(current: PlainMutationV1, incoming: PlainMutationV1) {
  return ['memory', 'post'].includes(current.entity.type) && current.revision.operation !== 'delete'
    && incoming.revision.operation !== 'delete' && incoming.revision.schemaVersion !== 10
    && !!memoryRecordCorrectionMarker(current.entity.type as 'memory' | 'post', current.revision.operation, current.payload);
}
function deleted(mutation: PlainMutationV1) {
  return mutation.revision.operation === 'delete'
    || mutation.entity.type === 'post-comment' && record(mutation.payload).deleted === 1;
}

// Embedded JSON is part of a complete version. SQLite and JS may serialize its
// members/numbers differently; that alone cannot turn a merge into a new edit.
function canonical(value: JsonValue, field = ''): string {
  if (typeof value === 'string' && field.endsWith('_json')) {
    try { return canonical(JSON.parse(value) as JsonValue); } catch { /* Validated contract owns text format. */ }
  }
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key], key)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function sameBaiyunPostPayloads(left: JsonValue, right: JsonValue) {
  return canonical(left) === canonical(right);
}
function versionTime(mutation: PlainMutationV1) {
  if (mutation.revision.operation === 'delete') return mutation.createdAt;
  if (mutation.entity.type === 'memory') return Number(record(mutation.payload).updated_at);
  if (mutation.entity.type === 'post') return Number((JSON.parse(String(record(mutation.payload).memory_json)) as { updated_at: number }).updated_at);
  if (mutation.entity.type === 'post-comment') return Number(record(mutation.payload).updated_at);
  if (mutation.entity.type === 'post-tag') return Number(record(mutation.payload).updated_at ?? mutation.createdAt);
  return mutation.createdAt;
}
function preferred(left: PlainMutationV1, right: PlainMutationV1, time = versionTime) {
  if (correctionBlocksLegacy(left, right)) return left;
  if (correctionBlocksLegacy(right, left)) return right;
  if (deleted(left) !== deleted(right)) return deleted(left) ? right : left;
  if (left.entity.type === 'post-tag' && !deleted(left)) {
    const leftAlias = Boolean(record(left.payload).merged_into_id), rightAlias = Boolean(record(right.payload).merged_into_id);
    if (leftAlias !== rightAlias) return leftAlias ? left : right;
  }
  const difference = time(left) - time(right);
  if (left.entity.type === 'post-tag' && !difference && !deleted(left)) {
    const leftVersion = String(record(left.payload).version_id ?? left.revision.id);
    const rightVersion = String(record(right.payload).version_id ?? right.revision.id);
    if (leftVersion !== rightVersion) return leftVersion < rightVersion ? left : right;
    // A derived union can share its real business stamp with its source.
    // Delivery-created revision IDs cannot shrink that union on a peer echo.
    if (record(left.payload).scope !== record(right.payload).scope) {
      if (record(left.payload).scope === 'both') return left;
      if (record(right.payload).scope === 'both') return right;
    }
  }
  return difference ? difference > 0 ? left : right
    : left.revision.id < right.revision.id ? left : right;
}

/** All history must be present: an absent ancestor is never guessed concurrent. */
export function selectBaiyunPostHeads(heads: readonly PlainMutationV1[], history: readonly PlainMutationV1[], postMemoryShadow = false): BaiyunPostHeadSelection | null {
  if (!heads.length || !(isBaiyunPostHeadEntity(heads[0].entity)
    || postMemoryShadow && heads[0].entity.domain === 'memory' && heads[0].entity.type === 'memory')) return null;
  const entity = heads[0].entity, vaultId = heads[0].vaultId;
  const graph = new Map<string, PlainMutationV1>();
  for (const mutation of [...history, ...heads]) {
    validate(mutation, entity, vaultId);
    const previous = graph.get(mutation.revision.id);
    if (previous && canonical(previous as unknown as JsonValue) !== canonical(mutation as unknown as JsonValue)) {
      throw new Error('baiyun-post-head-revision-payload-mismatch');
    }
    graph.set(mutation.revision.id, mutation);
  }
  const missing = new Set<string>();
  for (const mutation of graph.values()) for (const parent of mutation.revision.parents) if (!graph.has(parent)) missing.add(parent);
  if (missing.size) throw new BaiyunPostHeadDependencyError([...missing].sort());
  if (entity.type === 'memory' && [...graph.values()].some(mutation => mutation.revision.operation !== 'delete'
    && (record(mutation.payload).source !== 'baiyun-post' || record(mutation.payload).period !== 'post'))) return null;
  const ancestors = new Map<string, Set<string>>();
  function ancestorsOf(id: string) {
    const cached = ancestors.get(id); if (cached) return cached;
    const result = new Set<string>(), pending = [...graph.get(id)!.revision.parents];
    while (pending.length) {
      const parent = pending.pop()!;
      if (parent === id) throw new Error('baiyun-post-head-ancestry-cycle');
      if (result.has(parent)) continue;
      result.add(parent); pending.push(...graph.get(parent)!.revision.parents);
    }
    ancestors.set(id, result); return result;
  }
  for (const id of graph.keys()) ancestorsOf(id);
  const uniqueHeads = [...new Map(heads.map(head => [head.revision.id, head])).values()];
  const effective = uniqueHeads.filter(head => !uniqueHeads.some(other => other.revision.id !== head.revision.id
    && ancestorsOf(other.revision.id).has(head.revision.id)));
  if (['post', 'post-comment'].includes(entity.type)) {
    const authors = new Set([...graph.values()].filter(head => head.revision.operation !== 'delete').map(head => record(head.payload).author));
    if (authors.size > 1) throw new Error('post author 不可变。');
  }

  const origins = new Map<string, PlainMutationV1>();
  const bodyTimes = new Map<string, number>();
  function bodyKey(head: PlainMutationV1) {
    if (head.revision.operation === 'delete') return '';
    const row = { ...record(head.payload) };
    const body = { ...(JSON.parse(String(row.memory_json)) as Record<string, JsonValue>) };
    delete body.updated_at; delete row.tag_ids_json;
    for (const field of ['activation_count', 'last_active_at', 'surface_count', 'stats_semantics_version', 'last_mentioned_at']) delete body[field];
    row.memory_json = JSON.stringify(body);
    return canonical(row);
  }
  function rankTime(head: PlainMutationV1): number {
    if (entity.type !== 'post' || head.revision.operation === 'delete') return versionTime(head);
    const cached = bodyTimes.get(head.revision.id); if (cached !== undefined) return cached;
    // Local tag management retains its frozen updated_at behavior. A captured
    // classification-only snapshot must not outrank a real concurrent body
    // edit merely because it re-stamped that unchanged body.
    const key = bodyKey(head);
    const copies = head.revision.parents.map(id => graph.get(id)!)
      .filter(parent => parent.revision.operation !== 'delete' && bodyKey(parent) === key);
    const at = copies.length ? Math.max(...copies.map(rankTime)) : versionTime(head);
    bodyTimes.set(head.revision.id, at); return at;
  }
  function chooseOrigins(items: PlainMutationV1[]) {
    // A merge can retain an early snapshot while later packets complete that
    // same edit. Remove superseded originals before ranking concurrent ones;
    // pairwise causal preference would depend on the arrival order of three heads.
    const unique = [...new Map(items.map(item => [item.revision.id, item])).values()];
    return unique.filter(item => !unique.some(other => other.revision.id !== item.revision.id
      && ancestorsOf(other.revision.id).has(item.revision.id) && !correctionBlocksLegacy(item, other)))
      .reduce((left, right) => preferred(left, right, rankTime));
  }
  function origin(head: PlainMutationV1): PlainMutationV1 {
    const cached = origins.get(head.revision.id); if (cached) return cached;
    const parents = head.revision.parents.map(id => graph.get(id)!);
    let matches = parents.length >= 2 ? parents
      .filter(parent => deleted(parent) === deleted(head) && canonical(parent.payload) === canonical(head.payload)) : [];
    // The legacy native field merge can combine shadow fields without copying
    // one parent verbatim. An unchanged business clock is still a derived
    // receipt; a real later edit retains its newer updated_at.
    if (entity.type === 'memory' && parents.length >= 2 && !deleted(head)
      && versionTime(head) <= Math.max(...parents.filter(parent => !deleted(parent)).map(versionTime))) matches = parents;
    const selected = matches.length ? chooseOrigins(matches.map(origin)) : head;
    origins.set(head.revision.id, selected); return selected;
  }
  const headRevisionIds = uniqueHeads.map(head => head.revision.id).sort();
  const effectiveHeadRevisionIds = effective.map(head => head.revision.id).sort();
  let template = effective[0], payload = template.payload, winnerRevisionId: string | null = null;
  if (entity.type === 'interaction-fact' && effective.length > 1) {
    const tombstones = effective.filter(head => head.revision.operation === 'delete');
    if (tombstones.length) template = tombstones.map(origin).reduce((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt ? left : right;
      return left.revision.id > right.revision.id ? left : right;
    });
    else {
      const ordered = [...effective].sort((left, right) => left.revision.id < right.revision.id ? -1 : 1);
      template = ordered[0];
      const values = ordered.map(head => (head.payload as { value: JsonValue }).value);
      const value = entity.id === 'post-reading'
        ? (values as unknown as PostReadingSyncValueV1[]).reduce((left, right) => mergePostReadingSyncValuesV1(left, right))
        : (values as unknown as PostNoticeReadSyncValueV1[]).reduce((left, right) => mergePostNoticeReadSyncValuesV1(left, right));
      payload = { ...(template.payload as Record<string, JsonValue>), value: value as unknown as JsonValue };
    }
    if (tombstones.length) payload = template.payload;
  } else if (entity.type !== 'interaction-fact') {
    // Generated merges copy a result, not a new business edit. Retain the
    // original changes in their whole ancestry, including a later causal
    // deletion which an older generated restore may have failed to copy.
    const evidence = [...graph.values()].filter(item => effective.some(head => head.revision.id === item.revision.id
      || ancestorsOf(head.revision.id).has(item.revision.id)));
    const winner = chooseOrigins(evidence.map(origin));
    winnerRevisionId = winner.revision.id;
    // Copy a whole winning snapshot, including its image version/object refs.
    // The original winner may be behind a generated merge head.
    template = winner; payload = winner.payload;
  }
  if (['post', 'memory'].includes(entity.type) && template.revision.operation !== 'delete') {
    const imageSource = [...graph.values()].filter(revision => revision.revision.operation !== 'delete'
      && 'image_assets_json' in (revision.payload as { record: Record<string, JsonValue> }).record)
      .sort((left, right) => right.createdAt-left.createdAt || left.revision.id.localeCompare(right.revision.id))[0];
    payload = mergeMemoryStatsPayload(payload, entity.type as 'post' | 'memory', imageSource?.payload);
    for (const revision of graph.values()) if (revision.revision.operation !== 'delete') {
      payload = mergeMemoryStatsPayload(payload, entity.type as 'post' | 'memory', revision.payload);
    }
  }
  const operation: BaiyunPostHeadSelection['operation'] = template.revision.operation === 'delete' ? 'delete'
    : uniqueHeads.some(head => head.revision.operation === 'delete') ? 'restore' : 'upsert';
  if (operation === 'delete' && ['post', 'memory'].includes(entity.type)) {
    const marker = memoryRecordCorrectionMarker(entity.type as 'post' | 'memory', 'delete', payload)
      ?? [...graph.values()].sort((left, right) => versionTime(right) - versionTime(left)
        || left.revision.id.localeCompare(right.revision.id))
        .map(revision => memoryRecordCorrectionMarker(entity.type as 'post' | 'memory', revision.revision.operation, revision.payload))
        .find((value): value is string => value !== null) ?? null;
    if (marker !== null) payload = { ...(payload as Record<string, JsonValue>), schemaVersion: 10, chatSummaryCorrection: marker };
  }
  const equivalent = effective.filter(head => head.revision.operation === operation
    && canonical(head.payload) === canonical(payload));
  const coveredAncestors = new Set(effective.flatMap(head => [...ancestorsOf(head.revision.id)]));
  const settled = equivalent.filter(head => [...coveredAncestors].every(id => ancestorsOf(head.revision.id).has(id)));
  const settledRevisionId = equivalent.length === effective.length && settled.length
    ? settled.map(head => head.revision.id).sort()[0] : null;
  return { template, payload, operation, schemaVersion: Number((payload as { schemaVersion: number }).schemaVersion),
    objectRefs: operation === 'delete' ? [] : ['post', 'memory'].includes(entity.type)
      ? getMemoryRecordObjectRefs(payload) : [...template.objectRefs], headRevisionIds, effectiveHeadRevisionIds, winnerRevisionId, settledRevisionId };
}

export async function reconcileBaiyunPostHeads(input: {
  entity: Entity;
  postMemoryShadow?: boolean;
  loadHeads(): Promise<PlainMutationV1[]>;
  loadRevision(revisionId: string): Promise<PlainMutationV1 | null>;
  captureMerge(selection: BaiyunPostHeadSelection, parentIds: string[]): Promise<PlainMutationV1>;
  collapseHeads?(revisionId: string, expectedHeadIds: string[]): Promise<void>;
  loadMemoryStatsRecord?(): Promise<Record<string, JsonValue> | null>;
  materialize(mutation: PlainMutationV1): Promise<unknown>;
}): Promise<PlainMutationV1 | null> {
  if (!(isBaiyunPostHeadEntity(input.entity)
    || input.postMemoryShadow && input.entity.domain === 'memory' && input.entity.type === 'memory')) return null;
  const heads = await input.loadHeads();
  if (!heads.length) return null;
  const graph = new Map(heads.map(head => [head.revision.id, head]));
  const pending = heads.flatMap(head => head.revision.parents), missing = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!; if (graph.has(id) || missing.has(id)) continue;
    const revision = await input.loadRevision(id);
    if (!revision) { missing.add(id); continue; }
    graph.set(id, revision); pending.push(...revision.revision.parents);
  }
  if (missing.size) throw new BaiyunPostHeadDependencyError([...missing].sort());
  const selected = selectBaiyunPostHeads(heads, [...graph.values()], input.postMemoryShadow);
  if (!selected) return null;
  if (selected.operation !== 'delete' && ['memory', 'post'].includes(input.entity.type) && input.loadMemoryStatsRecord) {
    const stats = await input.loadMemoryStatsRecord();
    if (stats) {
      const kind = input.entity.type as 'memory' | 'post';
      const payload = mergeMemoryStatsPayload(selected.payload, kind, { schemaVersion: 9,
        record: kind === 'memory' ? stats : { memory_json: JSON.stringify(stats) } });
      if (!sameBaiyunPostPayloads(selected.payload, payload)) {
        selected.payload = payload; selected.schemaVersion = Number((payload as { schemaVersion: number }).schemaVersion); selected.settledRevisionId = null;
      }
    }
  }
  if (!sameEntity(selected.template.entity, input.entity)) throw new Error('baiyun-post-head-entity-mismatch');
  let mutation = heads[0];
  if (selected.headRevisionIds.length > 1 || !sameBaiyunPostPayloads(mutation.payload, selected.payload)
    || mutation.revision.operation !== selected.operation) {
    if (selected.settledRevisionId && input.collapseHeads) {
      await input.collapseHeads(selected.settledRevisionId, selected.headRevisionIds);
      mutation = heads.find(head => head.revision.id === selected.settledRevisionId)!;
    } else mutation = await input.captureMerge(selected, selected.headRevisionIds);
  }
  await input.materialize(mutation);
  return mutation;
}
