/** Shared drafts and requests; only the canonical phone owner executes a review. */
import { assertPlainMutationV1, type PlainMutationV1 } from './syncProtocol';
export const POST_REVIEW_RECORDS_SCHEMA_VERSION = 8 as const;
export type PostReviewStatus = 'pending' | 'waiting' | 'saved' | 'discarded' | 'suppressed';
export type PostReviewAction = 'edit' | 'save' | 'discard' | 'compare';
export type PostReviewActionState = 'pending' | 'applied' | 'rejected';
export type PostReviewRecord = {
  batch_id: string; item_key: string; review_id: string; owner_device_id: string;
  batch_source_hash: string; batch_created_at: number; status: PostReviewStatus;
  memory_id: string | null; candidate_json: string | null; created_at: number;
  updated_at: number; resolved_at: number | null;
};
export type PostReviewActionRecord = {
  id: string; review_id: string; owner_device_id: string; action: PostReviewAction;
  expected_editable_hash: string; candidate_json: string; target_hash: string | null;
  state: PostReviewActionState; error: string | null; created_at: number; resolved_at: number | null;
};
export type PostReviewDatabase = {
  getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<unknown>;
  execAsync(sql: string): Promise<unknown>;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const statuses: readonly string[] = ['pending', 'waiting', 'saved', 'discarded', 'suppressed'];
const reviewKeys = ['batch_id', 'item_key', 'review_id', 'owner_device_id', 'batch_source_hash',
  'batch_created_at', 'status', 'memory_id', 'candidate_json', 'created_at', 'updated_at', 'resolved_at'];
const actionKeys = ['id', 'review_id', 'owner_device_id', 'action', 'expected_editable_hash',
  'candidate_json', 'target_hash', 'state', 'error', 'created_at', 'resolved_at'];
function text(value: unknown, name: string, max = 2048): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`post review ${name} 无效。`);
}
function timestamp(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`post review ${name} 无效。`);
}
function nullableText(value: unknown, name: string) { if (value !== null) text(value, name); }
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new Error('post review fields 无效。');
}
function parseCandidate(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error('post review candidate_json 无效。');
  const result: unknown = JSON.parse(value);
  if (!object(result)) throw new Error('post review candidate_json 必须为对象。');
  return result;
}
/** Keep editor object/array order: the existing editable hash is order-sensitive. */
export function normalizePostReviewCandidateJson(value: string | null): string | null {
  if (value === null) return null;
  const candidate = parseCandidate(value);
  delete candidate.postDataEpoch;
  for (const key of ['understandingReview', 'continuationReview', 'currentStateReview']) {
    if (object(candidate[key])) delete candidate[key].dataEpoch;
  }
  return JSON.stringify(candidate);
}
function assertCandidate(value: unknown, reviewId: string, full: boolean) {
  if (value === null) {
    if (full) throw new Error('post review 缺少待审草稿。');
    return;
  }
  const candidate = parseCandidate(value);
  if ('postDataEpoch' in candidate || ['understandingReview', 'continuationReview', 'currentStateReview']
    .some(key => object(candidate[key]) && 'dataEpoch' in candidate[key])) throw new Error('post review 不共享本机纪元。');
  for (const key of ['work_metadata_json', 'workMetadata', 'cachedCandidates', 'cursors']) {
    if (key in candidate) throw new Error('post review 不共享付费工作资料。');
  }
  for (const key of ['reviewId', 'savedReviewId']) {
    if (key in candidate && candidate[key] !== reviewId) throw new Error('post review candidate identity 不一致。');
  }
  if (!full) return;
  if (candidate.origin !== 'post' || candidate.reviewId !== reviewId
    || typeof candidate.title !== 'string' || typeof candidate.content !== 'string'
    || !Array.isArray(candidate.tags) || !candidate.tags.every(tag => typeof tag === 'string')) {
    throw new Error('post review 待审草稿无效。');
  }
  if (!Array.isArray(candidate.sourceRefs) || !candidate.sourceRefs.length || !candidate.sourceRefs.every(ref =>
    object(ref) && (ref.role === 'I' || ref.role === 'you') && typeof ref.sessionId === 'string'
    && !!ref.sessionId && typeof ref.messageId === 'string' && !!ref.messageId
    && Number.isSafeInteger(ref.messageCreatedAt) && Number(ref.messageCreatedAt) >= 0
    && (ref.relation === 'direct' || ref.relation === 'derived'))) throw new Error('post review 来源主体无效。');
  if (candidate.understandingSubject !== undefined && candidate.understandingSubject !== 'I'
    && candidate.understandingSubject !== 'you') throw new Error('post review 认识主体无效。');
  if (!Array.isArray(candidate.postBindings) || !candidate.postBindings.length || !candidate.postBindings.every(binding =>
    object(binding) && binding.version === 1 && typeof binding.postId === 'string' && !!binding.postId
    && binding.sessionId === `post-source:${binding.postId}` && typeof binding.messageId === 'string' && !!binding.messageId
    && typeof binding.sourceHash === 'string' && !!binding.sourceHash && typeof binding.sentHash === 'string' && !!binding.sentHash
    && Number.isSafeInteger(binding.start) && Number(binding.start) >= 0
    && Number.isSafeInteger(binding.end) && Number(binding.end) > Number(binding.start)
    && (binding.purpose === 'new' || binding.purpose === 'context'))) throw new Error('post review 来源绑定无效。');
  const bindings = candidate.postBindings as Record<string, unknown>[];
  if (!(candidate.sourceRefs as Record<string, unknown>[]).some(ref => ref.relation === 'direct'
    && bindings.some(binding => binding.purpose === 'new' && binding.sessionId === ref.sessionId
      && binding.messageId === ref.messageId))) throw new Error('post review 缺少新来源依据。');
}
export function assertPostReviewRecord(record: Record<string, unknown>) {
  exact(record, reviewKeys);
  for (const key of ['batch_id', 'item_key', 'review_id', 'owner_device_id', 'batch_source_hash']) text(record[key], key);
  if (!statuses.includes(String(record.status))) throw new Error('post review status 无效。');
  for (const key of ['batch_created_at', 'created_at', 'updated_at']) timestamp(record[key], key);
  nullableText(record.memory_id, 'memory_id');
  const full = record.status === 'pending' || record.status === 'waiting';
  if (full && (record.resolved_at !== null || record.memory_id !== null)) throw new Error('post review 待审状态与结果不一致。');
  if (!full) timestamp(record.resolved_at, 'resolved_at');
  if (record.status !== 'saved' && record.memory_id !== null) throw new Error('post review 非保存状态不能绑定正式卡。');
  assertCandidate(record.candidate_json, record.review_id as string, full);
}
export function normalizePostReviewRecord(record: Record<string, unknown>): PostReviewRecord {
  const normalized: Record<string, unknown> = { ...record, candidate_json: normalizePostReviewCandidateJson(record.candidate_json as string | null) };
  assertPostReviewRecord(normalized);
  return Object.fromEntries(reviewKeys.map(key => [key, normalized[key]])) as PostReviewRecord;
}
export function assertPostReviewActionRecord(record: Record<string, unknown>) {
  exact(record, actionKeys);
  for (const key of ['id', 'review_id', 'owner_device_id', 'expected_editable_hash']) text(record[key], key);
  if (!['edit', 'save', 'discard', 'compare'].includes(String(record.action))) throw new Error('post review action 无效。');
  if (!['pending', 'applied', 'rejected'].includes(String(record.state))) throw new Error('post review action state 无效。');
  timestamp(record.created_at, 'created_at'); nullableText(record.target_hash, 'target_hash'); nullableText(record.error, 'error');
  if (record.state === 'pending') {
    if (record.resolved_at !== null || record.error !== null) throw new Error('post review pending action 带有结果。');
  } else {
    timestamp(record.resolved_at, 'resolved_at');
    if (record.state === 'applied' && record.error !== null || record.state === 'rejected' && record.error === null) {
      throw new Error('post review action 结果不完整。');
    }
  }
  assertCandidate(record.candidate_json, record.review_id as string, true);
}
export function normalizePostReviewActionRecord(record: Record<string, unknown>): PostReviewActionRecord {
  const normalized: Record<string, unknown> = { ...record, candidate_json: normalizePostReviewCandidateJson(record.candidate_json as string) };
  assertPostReviewActionRecord(normalized);
  return Object.fromEntries(actionKeys.map(key => [key, normalized[key]])) as PostReviewActionRecord;
}

const reviewIdSql = (row: string) => `COALESCE(${row}.post_review_id, CASE WHEN json_valid(${row}.candidate_json)
  THEN COALESCE(json_extract(${row}.candidate_json,'$.reviewId'),json_extract(${row}.candidate_json,'$.savedReviewId')) END)`;
const runtimeOwnerSql = '(SELECT source_device_id FROM memory_sync_runtime WHERE singleton_id=1)';
const fillIdentitySql = (row: string) => `UPDATE memory_ingestion_items SET
  post_review_id=${reviewIdSql(row)}, post_review_owner_device_id=COALESCE(${row}.post_review_owner_device_id,${runtimeOwnerSql})
  WHERE batch_id=${row}.batch_id AND item_key=${row}.item_key;`;
/** Capture stamps before reading the view, including an old draft's terminal update. */
export function buildPostReviewCaptureIdentitySql(action: 'insert' | 'update'): string {
  const identity = action === 'update' ? `COALESCE(${reviewIdSql('NEW')},${reviewIdSql('OLD')})` : reviewIdSql('NEW');
  return `UPDATE memory_ingestion_items SET post_review_id=${identity},
    post_review_owner_device_id=COALESCE(NEW.post_review_owner_device_id,${runtimeOwnerSql})
    WHERE batch_id=NEW.batch_id AND item_key=NEW.item_key;`;
}
export function buildPostReviewCapturePredicate(action: 'insert' | 'update'): string {
  const identity = action === 'update' ? `COALESCE(${reviewIdSql('NEW')},${reviewIdSql('OLD')})` : reviewIdSql('NEW');
  return `EXISTS(SELECT 1 FROM memory_ingestion_batches WHERE id=NEW.batch_id AND stream='post')
    AND ${identity} IS NOT NULL
    AND COALESCE(NEW.post_review_owner_device_id,${runtimeOwnerSql})=${runtimeOwnerSql}`;
}
export const POST_REVIEW_SCHEMA_SQL = `
CREATE TRIGGER IF NOT EXISTS memory_post_review_identity_insert AFTER INSERT ON memory_ingestion_items
WHEN EXISTS (SELECT 1 FROM memory_ingestion_batches WHERE id=NEW.batch_id AND stream='post')
  AND ${reviewIdSql('NEW')} IS NOT NULL
  AND (NEW.post_review_id IS NULL OR NEW.post_review_owner_device_id IS NULL)
BEGIN ${fillIdentitySql('NEW')} END;
CREATE TRIGGER IF NOT EXISTS memory_post_review_identity_update AFTER UPDATE OF candidate_json ON memory_ingestion_items
WHEN EXISTS (SELECT 1 FROM memory_ingestion_batches WHERE id=NEW.batch_id AND stream='post')
  AND ${reviewIdSql('NEW')} IS NOT NULL
  AND (NEW.post_review_id IS NULL OR NEW.post_review_owner_device_id IS NULL)
BEGIN ${fillIdentitySql('NEW')} END;
CREATE TRIGGER IF NOT EXISTS memory_post_review_identity_immutable BEFORE UPDATE OF post_review_id,post_review_owner_device_id ON memory_ingestion_items
WHEN (OLD.post_review_id IS NOT NULL AND NEW.post_review_id IS NOT OLD.post_review_id)
  OR (OLD.post_review_owner_device_id IS NOT NULL AND NEW.post_review_owner_device_id IS NOT OLD.post_review_owner_device_id)
BEGIN SELECT RAISE(ABORT,'post review ownership is immutable'); END;
CREATE VIEW IF NOT EXISTS memory_sync_post_reviews AS SELECT i.batch_id,i.item_key,
  ${reviewIdSql('i')} AS review_id,COALESCE(i.post_review_owner_device_id,${runtimeOwnerSql}) AS owner_device_id,
  b.source_hash AS batch_source_hash,b.created_at AS batch_created_at,i.status,i.memory_id,
  CASE WHEN json_valid(i.candidate_json) THEN json_remove(i.candidate_json,'$.postDataEpoch',
    '$.understandingReview.dataEpoch','$.continuationReview.dataEpoch','$.currentStateReview.dataEpoch')
    ELSE i.candidate_json END AS candidate_json,i.created_at,i.updated_at,i.resolved_at
  FROM memory_ingestion_items i JOIN memory_ingestion_batches b ON b.id=i.batch_id
  WHERE b.stream='post' AND ${reviewIdSql('i')} IS NOT NULL;
CREATE TABLE IF NOT EXISTS baiyun_post_review_actions (
  id TEXT PRIMARY KEY NOT NULL CHECK(typeof(id)='text' AND length(trim(id))>0),
  review_id TEXT NOT NULL CHECK(typeof(review_id)='text' AND length(trim(review_id))>0),
  owner_device_id TEXT NOT NULL CHECK(typeof(owner_device_id)='text' AND length(trim(owner_device_id))>0),
  action TEXT NOT NULL CHECK(action IN ('edit','save','discard','compare')),
  expected_editable_hash TEXT NOT NULL CHECK(typeof(expected_editable_hash)='text' AND length(trim(expected_editable_hash))>0),
  candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json) AND json_type(candidate_json)='object'),
  target_hash TEXT CHECK(target_hash IS NULL OR (typeof(target_hash)='text' AND length(trim(target_hash))>0)),
  state TEXT NOT NULL CHECK(state IN ('pending','applied','rejected')),
  error TEXT CHECK(error IS NULL OR (typeof(error)='text' AND length(trim(error))>0)),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
  resolved_at INTEGER CHECK(resolved_at IS NULL OR (typeof(resolved_at)='integer' AND resolved_at BETWEEN 0 AND 9007199254740991)),
  CHECK((state='pending' AND resolved_at IS NULL AND error IS NULL)
    OR (state='applied' AND resolved_at IS NOT NULL AND error IS NULL)
    OR (state='rejected' AND resolved_at IS NOT NULL AND error IS NOT NULL)),
  CHECK(COALESCE(json_extract(candidate_json,'$.origin')='post'
    AND json_extract(candidate_json,'$.reviewId')=review_id
    AND json_type(candidate_json,'$.title')='text' AND json_type(candidate_json,'$.content')='text'
    AND json_type(candidate_json,'$.tags')='array'
    AND json_type(candidate_json,'$.sourceRefs')='array' AND json_array_length(candidate_json,'$.sourceRefs')>0
    AND json_type(candidate_json,'$.postBindings')='array' AND json_array_length(candidate_json,'$.postBindings')>0,0)),
  CHECK(json_type(candidate_json,'$.postDataEpoch') IS NULL AND json_type(candidate_json,'$.understandingReview.dataEpoch') IS NULL
    AND json_type(candidate_json,'$.continuationReview.dataEpoch') IS NULL AND json_type(candidate_json,'$.currentStateReview.dataEpoch') IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_baiyun_post_review_actions_owner ON baiyun_post_review_actions(owner_device_id,state,created_at,id);
CREATE TRIGGER IF NOT EXISTS baiyun_post_review_action_identity_immutable BEFORE UPDATE ON baiyun_post_review_actions
WHEN NEW.id IS NOT OLD.id OR NEW.review_id IS NOT OLD.review_id OR NEW.owner_device_id IS NOT OLD.owner_device_id
  OR NEW.action IS NOT OLD.action OR NEW.expected_editable_hash IS NOT OLD.expected_editable_hash
  OR NEW.candidate_json IS NOT OLD.candidate_json OR NEW.target_hash IS NOT OLD.target_hash OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'post review action body is immutable'); END;
CREATE TRIGGER IF NOT EXISTS baiyun_post_review_action_result_immutable BEFORE UPDATE ON baiyun_post_review_actions
WHEN OLD.state IN ('applied','rejected') AND (NEW.state IS NOT OLD.state OR NEW.error IS NOT OLD.error OR NEW.resolved_at IS NOT OLD.resolved_at)
BEGIN SELECT RAISE(ABORT,'post review action result is immutable'); END;
`;

/** Run after the original ingestion and memory_sync_runtime schema exists. */
export function buildPostReviewColumnUpgradeSql(columnNames: readonly string[]): string {
  return [...['post_review_id', 'post_review_owner_device_id'].filter(column => !columnNames.includes(column))
    .map(column => `ALTER TABLE memory_ingestion_items ADD COLUMN ${column} TEXT;`),
    `UPDATE memory_ingestion_items SET post_review_id=${reviewIdSql('memory_ingestion_items')},
    post_review_owner_device_id=COALESCE(post_review_owner_device_id,${runtimeOwnerSql})
    WHERE EXISTS (SELECT 1 FROM memory_ingestion_batches b WHERE b.id=memory_ingestion_items.batch_id AND b.stream='post')
      AND ${reviewIdSql('memory_ingestion_items')} IS NOT NULL
      AND (post_review_id IS NULL OR post_review_owner_device_id IS NULL);`].join('\n');
}
export async function ensurePostReviewColumns(database: PostReviewDatabase) {
  const columns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(memory_ingestion_items)');
  await database.execAsync(buildPostReviewColumnUpgradeSql(columns.map(column => column.name)));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function assertPostReviewActionIntentUnchanged(previous: Record<string, unknown>, incoming: Record<string, unknown>) {
  const leftRecord = normalizePostReviewActionRecord(previous), rightRecord = normalizePostReviewActionRecord(incoming);
  for (const key of actionKeys.filter(key => !['state', 'error', 'resolved_at'].includes(key))) {
    const left = leftRecord[key as keyof PostReviewActionRecord], right = rightRecord[key as keyof PostReviewActionRecord];
    if ((key === 'candidate_json' ? canonical(JSON.parse(String(left))) : canonical(left))
      !== (key === 'candidate_json' ? canonical(JSON.parse(String(right))) : canonical(right))) {
      throw new Error('post review action 本体不可变。');
    }
  }
  if (leftRecord.state !== 'pending' && rightRecord.state !== 'pending'
    && (leftRecord.state !== rightRecord.state || leftRecord.error !== rightRecord.error || leftRecord.resolved_at !== rightRecord.resolved_at)) {
    throw new Error('post review action 结果不可变。');
  }
}
function retainLocalEpochs(incoming: string | null, previous: string | null) {
  if (incoming === null || previous === null) return incoming;
  const next = parseCandidate(incoming), old = parseCandidate(previous);
  if (next.origin !== 'post') return incoming;
  if ('postDataEpoch' in old) next.postDataEpoch = old.postDataEpoch;
  for (const key of ['understandingReview', 'continuationReview', 'currentStateReview']) {
    if (object(next[key]) && object(old[key]) && 'dataEpoch' in old[key]) next[key].dataEpoch = old[key].dataEpoch;
  }
  return JSON.stringify(next);
}
export type PostReviewSqlStatement = { sql: string; params: (string | number | null)[] };
export type PostReviewPreviousBatch = { stream: string; source_hash: string };
export type PostReviewPreviousItem = {
  status: PostReviewStatus; review_id: string | null; owner_device_id: string | null;
  /** Read the original item, not the epoch-stripped shared view. */
  candidate_json: string | null;
};
export const POST_REVIEW_PREVIOUS_BATCH_SQL = 'SELECT stream,source_hash FROM memory_ingestion_batches WHERE id=?';
export const POST_REVIEW_PREVIOUS_ITEM_SQL = `SELECT status,${reviewIdSql('i')} AS review_id,
  COALESCE(post_review_owner_device_id,${runtimeOwnerSql}) AS owner_device_id,candidate_json
  FROM memory_ingestion_items i WHERE batch_id=? AND item_key=?`;
export const POST_REVIEW_PREVIOUS_ACTION_SQL = 'SELECT * FROM baiyun_post_review_actions WHERE id=?';

/** Both hosts execute these statements inside their original suppressed transaction. */
export function buildSharedPostReviewStatements(input: Record<string, unknown>,
  previous?: PostReviewPreviousItem | null, batch?: PostReviewPreviousBatch | null): PostReviewSqlStatement[] {
  const record = normalizePostReviewRecord(input);
  if (batch && (batch.stream !== 'post' || batch.source_hash !== record.batch_source_hash)) {
    throw new Error('post review batch identity 不一致。');
  }
  if (previous && !statuses.includes(previous.status)) throw new Error('post review previous status 无效。');
  if (previous && (previous.review_id !== record.review_id || previous.owner_device_id !== null && previous.owner_device_id !== record.owner_device_id)) {
    throw new Error('post review ownership 不一致。');
  }
  if (previous && ['saved', 'discarded', 'suppressed'].includes(previous.status) && ['pending', 'waiting'].includes(record.status)) return [];
  return [{ sql: `INSERT OR IGNORE INTO memory_ingestion_batches
    (id,stream,scope_key,source_hash,advances_cursor,status,item_count,resolved_count,created_at,updated_at)
    VALUES (?,'post','post-memory',?,0,'ready',0,0,?,?)`,
    params: [record.batch_id, record.batch_source_hash, record.batch_created_at, record.updated_at] },
  { sql: `INSERT INTO memory_ingestion_items
    (batch_id,item_key,status,memory_id,candidate_json,created_at,updated_at,resolved_at,post_review_id,post_review_owner_device_id)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(batch_id,item_key) DO UPDATE SET status=excluded.status,
      memory_id=excluded.memory_id,candidate_json=excluded.candidate_json,updated_at=excluded.updated_at,
      resolved_at=excluded.resolved_at,post_review_id=excluded.post_review_id,post_review_owner_device_id=excluded.post_review_owner_device_id`,
    params: [record.batch_id, record.item_key, record.status, record.memory_id,
    retainLocalEpochs(record.candidate_json, previous?.candidate_json ?? null),
    record.created_at, record.updated_at, record.resolved_at, record.review_id, record.owner_device_id] },
  // Remote stubs have no paid-work metadata. Preserve real local batch work/status.
  { sql: `UPDATE memory_ingestion_batches SET
    item_count=(SELECT count(*) FROM memory_ingestion_items WHERE batch_id=?),
    resolved_count=(SELECT count(*) FROM memory_ingestion_items WHERE batch_id=? AND status IN ('saved','discarded','suppressed')),
    status=CASE WHEN EXISTS(SELECT 1 FROM memory_ingestion_items WHERE batch_id=? AND status='pending') THEN 'ready'
      WHEN EXISTS(SELECT 1 FROM memory_ingestion_items WHERE batch_id=? AND status='waiting') THEN 'waiting' ELSE 'resolved' END,
    updated_at=? WHERE id=? AND work_metadata_json IS NULL`,
    params: [record.batch_id, record.batch_id, record.batch_id, record.batch_id, record.updated_at, record.batch_id] }];
}
/** Store a request or the owner's result, never execute a save or a model call. */
export function buildSharedPostReviewActionStatements(input: Record<string, unknown>,
  previous?: PostReviewActionRecord | null): PostReviewSqlStatement[] {
  const record = normalizePostReviewActionRecord(input);
  if (previous) {
    assertPostReviewActionIntentUnchanged(previous, record);
    if (previous.state !== 'pending') {
      if (record.state === 'pending') return [];
      if (previous.state !== record.state || previous.error !== record.error || previous.resolved_at !== record.resolved_at) {
        throw new Error('post review action 结果不可变。');
      }
      return [];
    }
    if (record.state === 'pending') return [];
    return [{ sql: "UPDATE baiyun_post_review_actions SET state=?,error=?,resolved_at=? WHERE id=? AND state='pending'",
      params: [record.state, record.error, record.resolved_at, record.id] }];
  }
  return [{ sql: `INSERT INTO baiyun_post_review_actions
    (id,review_id,owner_device_id,action,expected_editable_hash,candidate_json,target_hash,state,error,created_at,resolved_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, params: actionKeys.map(key => record[key as keyof PostReviewActionRecord]) }];
}
/** Caller owns the transaction/capture suppression. No paid work is executed. */
export async function applySharedPostReview(database: PostReviewDatabase, input: Record<string, unknown>): Promise<boolean> {
  const record = normalizePostReviewRecord(input);
  const [batch] = await database.getAllAsync<PostReviewPreviousBatch>(POST_REVIEW_PREVIOUS_BATCH_SQL, record.batch_id);
  const [previous] = await database.getAllAsync<PostReviewPreviousItem>(POST_REVIEW_PREVIOUS_ITEM_SQL, record.batch_id, record.item_key);
  const statements = buildSharedPostReviewStatements(record, previous, batch);
  for (const statement of statements) await database.runAsync(statement.sql, ...statement.params);
  return statements.length > 0;
}
export async function applySharedPostReviewAction(database: PostReviewDatabase, input: Record<string, unknown>): Promise<boolean> {
  const record = normalizePostReviewActionRecord(input);
  const [previous] = await database.getAllAsync<PostReviewActionRecord>(POST_REVIEW_PREVIOUS_ACTION_SQL, record.id);
  const statements = buildSharedPostReviewActionStatements(record, previous);
  for (const statement of statements) await database.runAsync(statement.sql, ...statement.params);
  return statements.length > 0;
}

export function isSharedPostReviewHeadEntity(entity: { domain: string; type: string }): boolean {
  return entity.domain === 'memory' && (entity.type === 'post-review' || entity.type === 'post-review-action');
}
function signedReviewRecord(mutation: PlainMutationV1): PostReviewRecord | PostReviewActionRecord {
  assertPlainMutationV1(mutation);
  if (!isSharedPostReviewHeadEntity(mutation.entity) || mutation.revision.operation !== 'upsert'
    || mutation.revision.schemaVersion !== POST_REVIEW_RECORDS_SCHEMA_VERSION
    || mutation.sensitivity !== 'high' || mutation.retentionClass !== 'relationship-history'
    || mutation.objectRefs.length || !object(mutation.payload)
    || mutation.payload.schemaVersion !== POST_REVIEW_RECORDS_SCHEMA_VERSION || !object(mutation.payload.record)
    || Object.keys(mutation.payload).length !== 2) throw new Error('post review signed head 无效。');
  const record = mutation.payload.record;
  if (mutation.entity.type === 'post-review') {
    assertPostReviewRecord(record);
    if (mutation.entity.id !== JSON.stringify([record.batch_id, record.item_key])
      || mutation.sourceDeviceId !== record.owner_device_id) throw new Error('post review signed owner 不一致。');
    return normalizePostReviewRecord(record);
  }
  assertPostReviewActionRecord(record);
  if (mutation.entity.id !== record.id || record.state !== 'pending' && mutation.sourceDeviceId !== record.owner_device_id) {
    throw new Error('post review action signed owner 不一致。');
  }
  return normalizePostReviewActionRecord(record);
}

/** Select an existing signed version. No receiver manufactures an owner result. */
export function selectSharedPostReviewSignedHead(heads: readonly PlainMutationV1[],
  history: readonly PlainMutationV1[] = heads): PlainMutationV1 | null {
  if (!heads.length || !isSharedPostReviewHeadEntity(heads[0].entity)) return null;
  const entity = heads[0].entity, vaultId = heads[0].vaultId;
  const graph = new Map<string, PlainMutationV1>();
  const records = new Map<string, PostReviewRecord | PostReviewActionRecord>();
  for (const mutation of [...history, ...heads]) {
    if (mutation.vaultId !== vaultId || mutation.entity.domain !== entity.domain
      || mutation.entity.type !== entity.type || mutation.entity.id !== entity.id) throw new Error('post review ancestor entity 不一致。');
    graph.set(mutation.revision.id, mutation); records.set(mutation.revision.id, signedReviewRecord(mutation));
  }
  const first = records.get(heads[0].revision.id)!;
  for (const record of records.values()) {
    if (entity.type === 'post-review-action') assertPostReviewActionIntentUnchanged(first, record);
    else for (const key of ['batch_id', 'item_key', 'review_id', 'owner_device_id', 'batch_source_hash', 'batch_created_at', 'created_at'] as const) {
      if ((record as PostReviewRecord)[key] !== (first as PostReviewRecord)[key]) throw new Error('post review signed identity 不可变。');
    }
  }
  const cache = new Map<string, Set<string>>(), visiting = new Set<string>();
  const ancestors = (id: string): Set<string> => {
    if (cache.has(id)) return cache.get(id)!;
    if (visiting.has(id)) throw new Error('post review ancestor cycle 无效。');
    const mutation = graph.get(id);
    if (!mutation) throw new Error('post review 缺少原签名祖先，需补齐后重试。');
    visiting.add(id); const result = new Set<string>();
    for (const parent of mutation.revision.parents) {
      result.add(parent); for (const prior of ancestors(parent)) result.add(prior);
    }
    visiting.delete(id); cache.set(id, result); return result;
  };
  for (const head of heads) ancestors(head.revision.id);
  const terminal = (record: PostReviewRecord | PostReviewActionRecord) => 'state' in record
    ? record.state !== 'pending' : ['saved', 'discarded', 'suppressed'].includes(record.status);
  // A stale pending successor cannot reopen a terminal receipt. Its parent may
  // have been loaded only into the central ledger during dependency lookahead.
  const terminalHistory = [...graph.values()].filter(mutation => terminal(records.get(mutation.revision.id)!));
  const candidates = terminalHistory.length ? terminalHistory : heads;
  const live = candidates.filter(head => !candidates.some(other => other.revision.id !== head.revision.id
    && ancestors(other.revision.id).has(head.revision.id)));
  if (!live.length) throw new Error('post review 没有有效签名头。');
  const businessKey = (record: PostReviewRecord | PostReviewActionRecord) => canonical({ ...record,
    candidate_json: record.candidate_json === null ? null : JSON.parse(record.candidate_json) });
  return live.reduce((selected, next) => {
    const a = records.get(selected.revision.id)!, b = records.get(next.revision.id)!;
    if (terminal(a) !== terminal(b)) return terminal(a) ? selected : next;
    const atA = 'updated_at' in a ? a.updated_at : a.resolved_at ?? 0;
    const atB = 'updated_at' in b ? b.updated_at : b.resolved_at ?? 0;
    if (atA !== atB) return atA > atB ? selected : next;
    if ('status' in a && 'status' in b && a.status !== b.status && (a.status === 'waiting' || b.status === 'waiting')) {
      return a.status === 'waiting' ? selected : next;
    }
    const keyA = businessKey(a), keyB = businessKey(b);
    return keyA !== keyB ? keyA < keyB ? selected : next
      : selected.revision.id < next.revision.id ? selected : next;
  });
}

export async function reconcileSharedPostReviewSignedHeads(input: {
  entity: { domain: string; type: string; id: string };
  loadHeads(): Promise<PlainMutationV1[]>;
  loadRevision(id: string): Promise<PlainMutationV1 | null>;
  materialize(mutation: PlainMutationV1): Promise<unknown> | unknown;
}): Promise<PlainMutationV1 | null> {
  if (!isSharedPostReviewHeadEntity(input.entity)) return null;
  const heads = await input.loadHeads();
  if (!heads.length) return null;
  if (heads.some(head => head.entity.domain !== input.entity.domain || head.entity.type !== input.entity.type
    || head.entity.id !== input.entity.id)) throw new Error('post review head route 不一致。');
  const graph = new Map(heads.map(head => [head.revision.id, head]));
  const pending = heads.flatMap(head => head.revision.parents);
  while (pending.length) {
    const id = pending.pop()!; if (graph.has(id)) continue;
    const mutation = await input.loadRevision(id);
    if (!mutation) throw new Error('post review 缺少原签名祖先，需补齐后重试。');
    graph.set(id, mutation); pending.push(...mutation.revision.parents);
  }
  const selected = selectSharedPostReviewSignedHead(heads, [...graph.values()]);
  if (selected) await input.materialize(selected);
  return selected;
}
