/** Formal source receipts only. No candidate text or paid-work journal travels. */
export type PostConfirmationRecord = {
  batch_id: string; item_key: string; memory_id: string | null; current_state_id: string | null;
  confirmed_at: number; refs_json: string; bindings_json: string;
};
type Ref = { sessionId: string; messageId: string };
type Binding = Ref & { version: 1; postId: string; sourceHash: string; sentHash: string;
  start: number; end: number; purpose: 'new' | 'context' };
const refKey = (ref: Ref) => JSON.stringify([ref.sessionId, ref.messageId]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new Error('post confirmation fields 无效。');
}
function isRef(value: unknown): value is Ref {
  return object(value) && typeof value.sessionId === 'string' && value.sessionId.startsWith('post-source:')
    && value.sessionId.length > 12 && typeof value.messageId === 'string' && !!value.messageId;
}
function isBinding(value: unknown): value is Binding {
  if (!object(value) || !isRef(value)) return false;
  const binding = value as Record<string, unknown>;
  return binding.version === 1 && typeof binding.postId === 'string' && !!binding.postId
    && binding.sessionId === `post-source:${binding.postId}` && typeof binding.sourceHash === 'string' && !!binding.sourceHash
    && typeof binding.sentHash === 'string' && !!binding.sentHash && Number.isSafeInteger(binding.start)
    && Number.isSafeInteger(binding.end) && Number(binding.start) >= 0 && Number(binding.end) > Number(binding.start)
    && (binding.purpose === 'new' || binding.purpose === 'context');
}
export function assertPostConfirmationRecord(record: Record<string, unknown>) {
  for (const key of ['batch_id', 'item_key']) if (typeof record[key] !== 'string' || !record[key]) throw new Error('post confirmation identity 无效。');
  for (const key of ['memory_id', 'current_state_id']) if (record[key] !== null && (typeof record[key] !== 'string' || !record[key])) throw new Error('post confirmation target 无效。');
  if (record.memory_id === null && record.current_state_id === null) throw new Error('post confirmation 缺少正式目标。');
  if (!Number.isSafeInteger(record.confirmed_at) || Number(record.confirmed_at) < 0) throw new Error('post confirmation time 无效。');
  const refs: unknown = JSON.parse(String(record.refs_json)), bindings: unknown = JSON.parse(String(record.bindings_json));
  if (!Array.isArray(refs) || !refs.length || !refs.every(isRef) || new Set(refs.map(refKey)).size !== refs.length
    || !Array.isArray(bindings) || !bindings.every(isBinding)) throw new Error('post confirmation references 无效。');
  for (const ref of refs) exact(ref, ['sessionId', 'messageId']);
  for (const binding of bindings) {
    exact(binding, ['version', 'postId', 'sessionId', 'messageId', 'sourceHash', 'sentHash', 'start', 'end', 'purpose']);
    if (!refs.some(ref => refKey(ref) === refKey(binding))) throw new Error('post confirmation binding 越过已确认来源。');
  }
}

/** Stable JSON member order for immutable receipt replay; array order stays exact. */
export function normalizePostConfirmationRecord(record: Record<string, unknown>): PostConfirmationRecord {
  assertPostConfirmationRecord(record);
  return { batch_id: record.batch_id as string, item_key: record.item_key as string,
    memory_id: record.memory_id as string | null, current_state_id: record.current_state_id as string | null,
    confirmed_at: record.confirmed_at as number,
    refs_json: JSON.stringify((JSON.parse(String(record.refs_json)) as Ref[]).map(ref => ({ sessionId: ref.sessionId, messageId: ref.messageId }))),
    bindings_json: JSON.stringify((JSON.parse(String(record.bindings_json)) as Binding[]).map(binding => ({
      version: binding.version, postId: binding.postId, sessionId: binding.sessionId, messageId: binding.messageId,
      sourceHash: binding.sourceHash, sentHash: binding.sentHash, start: binding.start, end: binding.end, purpose: binding.purpose,
    }))),
  };
}

export const POST_CONFIRMATIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS baiyun_post_confirmations (
  batch_id TEXT NOT NULL, item_key TEXT NOT NULL, memory_id TEXT, current_state_id TEXT,
  confirmed_at INTEGER NOT NULL, refs_json TEXT NOT NULL, bindings_json TEXT NOT NULL,
  PRIMARY KEY (batch_id, item_key)
);
CREATE TRIGGER IF NOT EXISTS baiyun_post_confirmation_memory_delete AFTER DELETE ON memories
BEGIN DELETE FROM baiyun_post_confirmations WHERE memory_id = OLD.id; END;
CREATE TRIGGER IF NOT EXISTS baiyun_post_confirmation_state_delete AFTER DELETE ON memory_current_states
BEGIN DELETE FROM baiyun_post_confirmations WHERE current_state_id = OLD.id; END;
`;

type SavedRow = { batch_id: string; item_key: string; memory_id: string | null; candidate_json: string | null;
  resolved_at: number | null; work_metadata_json: string | null };
export function projectSavedPostConfirmation(row: SavedRow): PostConfirmationRecord | null {
  let receipt, work;
  try { receipt = JSON.parse(row.candidate_json ?? 'null'); work = JSON.parse(row.work_metadata_json ?? 'null'); }
  catch { return null; }
  if (!Number.isSafeInteger(row.resolved_at) || row.resolved_at! < 0 || !Array.isArray(receipt?.reviewedSourceRefs)) return null;
  const refs = [...new Map<string, Ref>(receipt.reviewedSourceRefs.filter(isRef)
    .map((ref: Ref) => [refKey(ref), { sessionId: ref.sessionId, messageId: ref.messageId }] as const)).values()];
  const currentStateId = typeof receipt.savedCurrentStateId === 'string' && receipt.savedCurrentStateId ? receipt.savedCurrentStateId : null;
  if (!refs.length || !row.memory_id && !currentStateId) return null;
  const bindings = Array.isArray(work?.post?.bindings) ? work.post.bindings.filter(isBinding)
    .filter((binding: Binding) => refs.some(ref => refKey(ref) === refKey(binding)))
    .map((binding: Binding) => ({ version: binding.version, postId: binding.postId, sessionId: binding.sessionId,
      messageId: binding.messageId, sourceHash: binding.sourceHash, sentHash: binding.sentHash,
      start: binding.start, end: binding.end, purpose: binding.purpose })) : [];
  const record = { batch_id: row.batch_id, item_key: row.item_key, memory_id: row.memory_id,
    current_state_id: currentStateId, confirmed_at: row.resolved_at!, refs_json: JSON.stringify(refs), bindings_json: JSON.stringify(bindings) };
  assertPostConfirmationRecord(record);
  return record;
}

type Database = {
  getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<unknown>;
};
/** Call within the original save transaction, or during normal schema initialization. */
export async function retainSavedPostConfirmations(database: Database, batchId?: string) {
  const rows = await database.getAllAsync<SavedRow>(`SELECT i.batch_id,i.item_key,i.memory_id,i.candidate_json,i.resolved_at,b.work_metadata_json
    FROM memory_ingestion_items i JOIN memory_ingestion_batches b ON b.id=i.batch_id
    WHERE i.status='saved' AND b.stream='post'${batchId ? ' AND i.batch_id=?' : ''}`, ...(batchId ? [batchId] : []));
  for (const row of rows) {
    const record = projectSavedPostConfirmation(row);
    if (!record) continue;
    const liveTargets = await database.getAllAsync(`SELECT 1 WHERE
      (? IS NULL OR EXISTS (SELECT 1 FROM memories WHERE id=?))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM memory_current_states WHERE id=?))`,
    record.memory_id, record.memory_id, record.current_state_id, record.current_state_id);
    if (!liveTargets.length) continue;
    const deletedTargets = await database.getAllAsync(`SELECT 1 FROM memory_sync_entity_heads h
      JOIN memory_sync_revision_log r ON r.revision_id=h.revision_id
      WHERE r.operation='delete' AND ((h.entity_type='memory' AND h.entity_id=?)
        OR (h.entity_type='current-state' AND h.entity_id=?)) LIMIT 1`, record.memory_id, record.current_state_id);
    if (deletedTargets.length) continue;
    // A receipt identity is immutable; no imported receipt changes a local paid-work row.
    await database.runAsync(`INSERT OR IGNORE INTO baiyun_post_confirmations
      (batch_id,item_key,memory_id,current_state_id,confirmed_at,refs_json,bindings_json) VALUES (?,?,?,?,?,?,?)`,
    record.batch_id, record.item_key, record.memory_id, record.current_state_id, record.confirmed_at, record.refs_json, record.bindings_json);
  }
}
