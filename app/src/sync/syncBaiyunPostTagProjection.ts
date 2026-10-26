import { projectBaiyunPostTagIds, type BaiyunPostMembershipRevision, type BaiyunPostSyncTag } from './syncBaiyunPostTagCoordination';
import { loadSyncBaiyunPostTagHeadMutations, loadSyncRevisionMutation } from './syncMutationStateStore';
import { getMemoryDatabase } from '../memory/memoryStore';
import { runWithMemoryRecordsCaptureSuppressed } from './syncMemoryRecordsSqlitePort';
import { BaiyunPostHeadDependencyError } from './syncBaiyunPostHeadReconciliation';

type RevisionRow = { entity_type: string; entity_id: string; revision_id: string;
  parent_revision_ids_json: string; operation: BaiyunPostMembershipRevision['revision']['operation'];
  schema_version: number; payload_json: string; created_at: number };
type PostRow = { post_id: string; author: 'I' | 'you'; tag_ids_json: string; revision_id: string | null };
const nativeRevisions = `SELECT entity_type, entity_id, revision_id, parent_revision_ids_json,
  operation, schema_version, payload_json, created_at FROM memory_sync_revision_log
  UNION ALL SELECT entity_type, entity_id, revision_id, parent_revision_ids_json,
  operation, schema_version, payload_json, created_at FROM memory_sync_domain_outbox`;
const fromRow = (row: RevisionRow): BaiyunPostMembershipRevision => ({
  entity: { domain: 'memory', type: row.entity_type, id: row.entity_id },
  revision: { id: row.revision_id, parents: JSON.parse(row.parent_revision_ids_json),
    operation: row.operation, schemaVersion: row.schema_version },
  payload: JSON.parse(row.payload_json), createdAt: row.created_at,
});

// No derived full-post revision: only the current native classification is
// projected, with CAS against its actual native head and library snapshot.
export async function reconcileAndroidBaiyunPostTagReferences(onlyPostId?: string) {
  const database = await getMemoryDatabase();
  const tags = await loadSyncBaiyunPostTagHeadMutations();
  const tagRecords = await database.getAllAsync<BaiyunPostSyncTag>('SELECT * FROM baiyun_post_tags ORDER BY id');
  const tagRows = await database.getAllAsync<RevisionRow>(`SELECT * FROM (${nativeRevisions}) WHERE entity_type='post-tag'`);
  const deleted = await database.getAllAsync<{ entity_id: string }>(`SELECT h.entity_id FROM memory_sync_entity_heads h
    JOIN (${nativeRevisions}) r ON r.revision_id=h.revision_id
    WHERE h.entity_type='post-tag' AND r.operation='delete' ORDER BY h.entity_id`);
  const graph = new Map<string, BaiyunPostMembershipRevision>(tagRows.map(row => [row.revision_id, fromRow(row)]));
  for (const tag of tags) graph.set(tag.revision.id, tag);
  const pending = [...graph.values()].flatMap(node => node.revision.parents);
  async function addRevision(id: string) {
    if (graph.has(id)) return graph.get(id)!;
    const native = await database.getFirstAsync<RevisionRow>(`SELECT * FROM (${nativeRevisions}) WHERE revision_id=? LIMIT 1`, id);
    const node = native ? fromRow(native) : await loadSyncRevisionMutation(id);
    if (!node) throw new BaiyunPostHeadDependencyError([id]);
    graph.set(id, node); return node;
  }
  while (pending.length) {
    const id = pending.pop()!; if (graph.has(id)) continue;
    const node = await addRevision(id); pending.push(...node.revision.parents);
  }
  const postSql = `SELECT p.post_id,p.author,p.tag_ids_json,h.revision_id FROM baiyun_post_metadata p
    LEFT JOIN memory_sync_entity_heads h ON h.entity_type='post' AND h.entity_id=p.post_id
    ${onlyPostId ? 'WHERE p.post_id=?' : ''} ORDER BY p.post_id,h.revision_id`;
  const rows = await database.getAllAsync<PostRow>(postSql, ...(onlyPostId ? [onlyPostId] : []));
  const updates: { row: PostRow; next: string }[] = [];
  for (const row of rows) {
    if (!JSON.parse(row.tag_ids_json).length) continue;
    if (rows.some(other => other.post_id === row.post_id && other.revision_id !== row.revision_id)) {
      throw new Error('post-tag-projection-native-heads-pending');
    }
    const post = row.revision_id ? await addRevision(row.revision_id) : null;
    const history: BaiyunPostMembershipRevision[] = [], seen = new Set<string>();
    const ancestry = post ? [post] : [];
    while (ancestry.length) {
      const node = ancestry.pop()!; if (seen.has(node.revision.id)) continue;
      seen.add(node.revision.id); history.push(node);
      for (const id of node.revision.parents) ancestry.push(await addRevision(id));
    }
    const next = JSON.stringify(projectBaiyunPostTagIds({ author: row.author, tagIds: JSON.parse(row.tag_ids_json),
      post, postHistory: history, tags, tagHistory: [...graph.values()].filter(node => node.entity.type === 'post-tag'),
      tagRecords, deletedTagIds: deleted.map(item => item.entity_id) }));
    if (next !== row.tag_ids_json) updates.push({ row, next });
  }
  if (!updates.length) return;
  await runWithMemoryRecordsCaptureSuppressed(async transaction => {
    const actualTags = await transaction.getAllAsync<BaiyunPostSyncTag>('SELECT * FROM baiyun_post_tags ORDER BY id');
    const actualRows = await transaction.getAllAsync<PostRow>(postSql, ...(onlyPostId ? [onlyPostId] : []));
    if (JSON.stringify(actualTags) !== JSON.stringify(tagRecords) || JSON.stringify(actualRows) !== JSON.stringify(rows)) {
      throw new Error('post-tag-projection-data-changed');
    }
    for (const { row, next } of updates) await transaction.runAsync(
      'UPDATE baiyun_post_metadata SET tag_ids_json=? WHERE post_id=?', next, row.post_id);
  });
}
