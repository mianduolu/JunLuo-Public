import type * as SQLite from 'expo-sqlite';
import {
  assertShiyingDeterministicId, assertShiyingLifeDate, assertShiyingUuidV4, canonicalJsonV1,
  type ShiyingSummaryV1,
} from './shiyingContract';
import {
  createShiyingEntryFactContentHash, createShiyingRecordContentHash,
  parseShiyingEventV1, parseShiyingFactSourceV1, parseShiyingRecordV1,
  parseShiyingSummaryV2, serializeShiyingRecordV1,
  type ShiyingEventV1, type ShiyingFactSourceV1, type ShiyingRecordImageV1,
  type ShiyingRecordV1, type ShiyingSummaryV2,
} from './shiyingJournalContract';
import { runShiyingDatabaseOperation, runShiyingTransaction } from './shiyingDatabase';
import {
  loadEntryWithDatabase, loadSummaryWithDatabase, markShiyingFactDependentsDirty,
} from './shiyingStore';
import type { ShiyingSummaryV3 } from './shiyingSummaryContract';

type Database = SQLite.SQLiteDatabase;
type Row = Record<string, unknown>;

function fail(code: string, id?: string): never {
  throw new Error(`shiying_journal_store_${code}${id ? `:${id}` : ''}`);
}

function time(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid_time');
}

// SQLite errors may contain SQL fragments. Only technical codes leave this layer.
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof Error && /^shiying_[a-z_]+(?::[a-zA-Z0-9-]+)?$/u.test(error.message)) throw error;
    return fail('database_operation_failed');
  }
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') fail('invalid_source_json');
  try { return JSON.parse(value) as unknown; } catch { return fail('invalid_source_json'); }
}

async function loadRecord(db: Database, id: string): Promise<ShiyingRecordV1 | null> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM shiying_records WHERE id = ?;', id);
  if (!row) return null;
  const images = await db.getAllAsync<Row>(
    'SELECT * FROM shiying_record_images WHERE record_id = ? ORDER BY ordinal;', id,
  );
  return parseShiyingRecordV1({
    payloadVersion: row.payload_version, id: row.id, recordDate: row.record_date,
    author: row.author, body: row.body, status: row.status,
    nominalFinalizeAt: row.nominal_finalize_at, finalizedAt: row.finalized_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
    images: images.map((image) => ({
      payloadVersion: image.payload_version, id: image.id, recordId: image.record_id,
      ordinal: image.ordinal, contentHash: image.content_hash, mimeType: image.mime_type,
      byteLength: image.byte_length, width: image.width, height: image.height,
    })),
  });
}

async function insertImages(db: Database, images: ShiyingRecordImageV1[]) {
  for (const image of images) await db.runAsync(`INSERT INTO shiying_record_images
    (id,record_id,ordinal,content_hash,mime_type,byte_length,width,height,payload_version)
    VALUES (?,?,?,?,?,?,?,?,1);`, image.id, image.recordId, image.ordinal,
  image.contentHash, image.mimeType, image.byteLength, image.width, image.height);
}

// Transaction helpers: callers already hold the shared database queue and must not nest it.
export { loadRecord as loadShiyingRecordWithDatabase, insertImages as insertShiyingRecordImagesWithDatabase };

export function createShiyingRecord(input: ShiyingRecordV1) {
  const record = parseShiyingRecordV1(input);
  if (record.status !== 'draft') fail('create_requires_draft', record.id);
  return safe(() => runShiyingTransaction(async (db) => {
    const existing = await loadRecord(db, record.id);
    if (existing) {
      if (serializeShiyingRecordV1(existing) !== serializeShiyingRecordV1(record)) fail('record_conflict', record.id);
      return existing;
    }
    await db.runAsync(`INSERT INTO shiying_records
      (id,record_date,author,body,status,nominal_finalize_at,finalized_at,created_at,updated_at,payload_version)
      VALUES (?,?,'you',?,'draft',?,NULL,?,?,1);`, record.id, record.recordDate,
    record.body, record.nominalFinalizeAt, record.createdAt, record.updatedAt);
    await insertImages(db, record.images);
    return record;
  }));
}

export function getShiyingRecordById(id: string) {
  assertShiyingUuidV4(id, 'record_id');
  return safe(() => runShiyingDatabaseOperation((db) => loadRecord(db, id)));
}

export type ShiyingRecordPageCursor = { recordDate: string; id: string };
export function listShiyingRecords(options: {
  before?: ShiyingRecordPageCursor; recordDate?: string;
  status?: 'draft' | 'finalized'; limit?: number;
} = {}): Promise<{ records: ShiyingRecordV1[]; nextBefore: ShiyingRecordPageCursor | null }> {
  const limit = options.limit ?? 30;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid_page_limit');
  if (options.recordDate !== undefined) assertShiyingLifeDate(options.recordDate, 'record_date');
  if (options.before) {
    assertShiyingLifeDate(options.before.recordDate, 'record_date');
    assertShiyingUuidV4(options.before.id, 'record_id');
  }
  if (options.status !== undefined && !['draft', 'finalized'].includes(options.status)) fail('invalid_record_status');
  const where: string[] = [];
  const parameters: (string | number)[] = [];
  if (options.recordDate !== undefined) { where.push('record_date = ?'); parameters.push(options.recordDate); }
  if (options.status !== undefined) { where.push('status = ?'); parameters.push(options.status); }
  if (options.before) {
    where.push('(record_date < ? OR (record_date = ? AND id < ?))');
    parameters.push(options.before.recordDate, options.before.recordDate, options.before.id);
  }
  return safe(() => runShiyingDatabaseOperation(async (db) => {
    const ids = await db.getAllAsync<{ id: string }>(`SELECT id FROM shiying_records
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY record_date DESC,id DESC LIMIT ?;`, ...parameters, limit + 1);
    const records: ShiyingRecordV1[] = [];
    for (const { id } of ids.slice(0, limit)) {
      const record = await loadRecord(db, id);
      if (!record) fail('record_missing', id);
      records.push(record);
    }
    const last = records[records.length - 1];
    return { records, nextBefore: ids.length > limit && last ? { recordDate: last.recordDate, id: last.id } : null };
  }));
}

export function updateShiyingRecordDraft(input: {
  id: string; expectedContentHash: string; body: string; images: ShiyingRecordImageV1[]; updatedAt: number;
}) {
  assertShiyingUuidV4(input.id, 'record_id'); time(input.updatedAt);
  return safe(() => runShiyingTransaction(async (db) => {
    const previous = await loadRecord(db, input.id);
    if (!previous) fail('record_missing', input.id);
    if (previous.status !== 'draft') fail('record_finalized', input.id);
    if (createShiyingRecordContentHash(previous) !== input.expectedContentHash) fail('record_content_conflict', input.id);
    if (input.updatedAt < previous.updatedAt) fail('stale_time', input.id);
    const next = parseShiyingRecordV1({ ...previous, body: input.body, images: input.images, updatedAt: input.updatedAt });
    await db.runAsync('UPDATE shiying_records SET body = ?,updated_at = ? WHERE id = ?;', next.body, next.updatedAt, next.id);
    await db.runAsync('DELETE FROM shiying_record_images WHERE record_id = ?;', next.id);
    await insertImages(db, next.images);
    return next;
  }));
}

export function finalizeShiyingRecord(input: { id: string; finalizedAt: number }) {
  assertShiyingUuidV4(input.id, 'record_id'); time(input.finalizedAt);
  return safe(() => runShiyingTransaction(async (db) => {
    const previous = await loadRecord(db, input.id);
    if (!previous) fail('record_missing', input.id);
    if (previous.status === 'finalized') return previous;
    if (input.finalizedAt < previous.updatedAt) fail('stale_time', input.id);
    const next = parseShiyingRecordV1({ ...previous, status: 'finalized', finalizedAt: input.finalizedAt, updatedAt: input.finalizedAt });
    await db.runAsync(`UPDATE shiying_records SET status = 'finalized',finalized_at = ?,updated_at = ? WHERE id = ?;`,
      next.finalizedAt, next.updatedAt, next.id);
    await db.runAsync('DELETE FROM shiying_record_local_state WHERE record_id = ?;', next.id);
    await (await import('./shiyingReviewStore')).markShiyingReviewPeriodDirtyWithDatabase(db, 'record', next.id, next.recordDate);
    return next;
  })).then(record => { void import('./shiyingMemorySource').then(module => module.notifyShiyingMemorySourceChanged(record.id)).catch(() => undefined); return record; });
}

export function deleteShiyingRecord(input: { id: string; deletedAt: number }) {
  assertShiyingUuidV4(input.id, 'record_id'); time(input.deletedAt);
  return safe(() => runShiyingTransaction(async (db) => {
    const previous = await loadRecord(db, input.id);
    if (!previous) return { deleted: false, unreferencedImageHashes: [] as string[] };
    if (input.deletedAt < previous.updatedAt) fail('stale_time', input.id);
    await markShiyingFactDependentsDirty(db, 'record', input.id, input.deletedAt);
    await db.runAsync('DELETE FROM shiying_records WHERE id = ?;', input.id);
    const unreferencedImageHashes: string[] = [];
    for (const hash of [...new Set(previous.images.map((image) => image.contentHash))].sort()) {
      const used = await db.getFirstAsync<{ id: string }>('SELECT id FROM shiying_record_images WHERE content_hash = ? LIMIT 1;', hash);
      if (!used) unreferencedImageHashes.push(hash);
    }
    return { deleted: true, unreferencedImageHashes };
  })).then(result => { if (result.deleted) void import('./shiyingMemorySource').then(module => module.notifyShiyingMemorySourceChanged(input.id)).catch(() => undefined); return result; });
}

type SourceOwner = 'summary' | 'node';
function sourceTable(owner: SourceOwner) {
  return owner === 'summary'
    ? { table: 'shiying_summary_sources', column: 'summary_id' }
    : { table: 'shiying_event_node_sources', column: 'node_id' };
}

async function loadSources(db: Database, owner: SourceOwner, id: string) {
  const { table, column } = sourceTable(owner);
  const rows = await db.getAllAsync<Row>(`SELECT * FROM ${table} WHERE ${column} = ? ORDER BY ordinal;`, id);
  return rows.map((row, index) => {
    if (row.ordinal !== index) fail('source_order', id);
    return parseShiyingFactSourceV1({ kind: row.source_kind, id: row.source_id,
      contentHash: row.content_hash, imageIds: json(row.image_ids_json) });
  });
}

async function insertSources(db: Database, owner: SourceOwner, id: string, sources: ShiyingFactSourceV1[]) {
  const { table, column } = sourceTable(owner);
  for (const [ordinal, source] of sources.entries()) await db.runAsync(`INSERT INTO ${table}
    (${column},ordinal,source_kind,source_id,content_hash,image_ids_json) VALUES (?,?,?,?,?,?);`,
  id, ordinal, source.kind, source.id, source.contentHash, canonicalJsonV1(source.imageIds));
}

async function validateSources(db: Database, sources: ShiyingFactSourceV1[]) {
  for (const source of sources) {
    if (source.kind === 'entry') {
      const entry = await loadEntryWithDatabase(db, source.id);
      if (!entry || entry.status !== 'active') fail('entry_source_unavailable', source.id);
      if (createShiyingEntryFactContentHash(entry) !== source.contentHash) fail('source_hash_mismatch', source.id);
    } else {
      const record = await loadRecord(db, source.id);
      if (!record || record.status !== 'finalized') fail('record_source_unavailable', source.id);
      if (createShiyingRecordContentHash(record) !== source.contentHash) fail('source_hash_mismatch', source.id);
      const positions = source.imageIds.map((id) => record.images.findIndex((image) => image.id === id));
      if (positions.some((position, index) => position < 0 || (index > 0 && position <= positions[index - 1]))) {
        fail('source_image_ownership_or_order', source.id);
      }
    }
  }
}

async function loadEvent(db: Database, id: string): Promise<ShiyingEventV1 | null> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM shiying_events WHERE id = ?;', id);
  if (!row) return null;
  if (row.payload_version !== 1) fail('event_version_mismatch', id);
  const nodes = await db.getAllAsync<Row>(`SELECT * FROM shiying_event_nodes WHERE event_id = ?
    ORDER BY event_date,ordinal,id;`, id);
  const mappedNodes = [];
  for (const node of nodes) mappedNodes.push({
    payloadVersion: node.payload_version, id: node.id, eventId: node.event_id,
    eventDate: node.event_date, ordinal: node.ordinal, body: node.body,
    createdAt: node.created_at, updatedAt: node.updated_at,
    sources: await loadSources(db, 'node', node.id as string),
  });
  const exclusions = await db.getAllAsync<Row>(`SELECT * FROM shiying_event_exclusions WHERE event_id = ?
    ORDER BY source_kind,source_id;`, id);
  return parseShiyingEventV1({ payloadVersion: row.payload_version, id: row.id,
    title: row.title, overview: row.overview, dirty: row.dirty === 1,
    createdAt: row.created_at, updatedAt: row.updated_at, nodes: mappedNodes,
    exclusions: exclusions.map((source) => ({ kind: source.source_kind, id: source.source_id, updatedAt: source.updated_at })),
  });
}

export function getShiyingEventById(id: string) {
  assertShiyingUuidV4(id, 'event_id');
  return safe(() => runShiyingDatabaseOperation((db) => loadEvent(db, id)));
}

export function saveShiyingEvent(input: ShiyingEventV1) {
  const parsed = parseShiyingEventV1(input);
  return safe(() => runShiyingTransaction(async (db) => {
    const previous = await loadEvent(db, parsed.id);
    const event = { ...parsed, createdAt: previous?.createdAt ?? parsed.createdAt };
    if (previous && event.updatedAt < previous.updatedAt) fail('event_conflict', event.id);
    // Feedback cannot be silently overwritten by a new generated overview.
    if (previous && canonicalJsonV1(event.exclusions) !== canonicalJsonV1(previous.exclusions)) fail('event_feedback_conflict', event.id);
    const excluded = new Set(event.exclusions.map((source) => `${source.kind}:${source.id}`));
    for (const node of event.nodes) {
      if (node.sources.some((source) => excluded.has(`${source.kind}:${source.id}`))) fail('event_source_excluded', event.id);
      const priorNode = await db.getFirstAsync<Row>('SELECT event_id,created_at,updated_at FROM shiying_event_nodes WHERE id = ?;', node.id);
      if (priorNode && (priorNode.event_id !== event.id
        || node.updatedAt < (priorNode.updated_at as number))) fail('event_node_conflict', node.id);
      if (priorNode) node.createdAt = priorNode.created_at as number;
      await validateSources(db, node.sources);
    }
    await db.runAsync(`INSERT INTO shiying_events (id,title,overview,dirty,created_at,updated_at,payload_version)
      VALUES (?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title,overview=excluded.overview,
      dirty=excluded.dirty,updated_at=excluded.updated_at;`, event.id,event.title,event.overview,
    event.dirty ? 1 : 0,event.createdAt,event.updatedAt);
    await db.runAsync('DELETE FROM shiying_event_nodes WHERE event_id = ?;', event.id);
    for (const node of event.nodes) {
      await db.runAsync(`INSERT INTO shiying_event_nodes (id,event_id,event_date,ordinal,body,created_at,updated_at,payload_version)
        VALUES (?,?,?,?,?,?,?,1);`, node.id,event.id,node.eventDate,node.ordinal,node.body,node.createdAt,node.updatedAt);
      await insertSources(db, 'node', node.id, node.sources);
    }
    if (!previous) for (const source of event.exclusions) await db.runAsync(`INSERT INTO shiying_event_exclusions
      (event_id,source_kind,source_id,updated_at) VALUES (?,?,?,?);`, event.id,source.kind,source.id,source.updatedAt);
    return event;
  }));
}

type EventFeedbackInput = { eventId: string; kind: 'entry' | 'record'; id: string; updatedAt: number };
function updateEventExclusion(input: EventFeedbackInput, excluded: boolean) {
  assertShiyingUuidV4(input.eventId, 'event_id'); assertShiyingUuidV4(input.id, 'source_id'); time(input.updatedAt);
  if (!['entry', 'record'].includes(input.kind)) fail('invalid_source_kind');
  return safe(() => runShiyingTransaction(async (db) => {
    const event = await loadEvent(db, input.eventId);
    if (!event) fail('event_missing', input.eventId);
    const exists = event.exclusions.some((source) => source.kind === input.kind && source.id === input.id);
    if (exists === excluded) return event;
    if (input.updatedAt < event.updatedAt) fail('stale_time', input.eventId);
    if (excluded) await db.runAsync(`INSERT INTO shiying_event_exclusions
      (event_id,source_kind,source_id,updated_at) VALUES (?,?,?,?);`, input.eventId,input.kind,input.id,input.updatedAt);
    else await db.runAsync(`DELETE FROM shiying_event_exclusions WHERE event_id = ? AND source_kind = ? AND source_id = ?;`,
      input.eventId,input.kind,input.id);
    await db.runAsync('UPDATE shiying_events SET dirty = 1,updated_at = ? WHERE id = ?;', input.updatedAt,input.eventId);
    const next = await loadEvent(db, input.eventId);
    if (!next) fail('event_missing', input.eventId);
    return next;
  }));
}
export function excludeShiyingEventSource(input: EventFeedbackInput) { return updateEventExclusion(input, true); }
export function undoShiyingEventSourceExclusion(input: EventFeedbackInput) { return updateEventExclusion(input, false); }

async function loadSummary(db: Database, id: string): Promise<ShiyingSummaryV1 | ShiyingSummaryV2 | ShiyingSummaryV3 | null> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM shiying_summaries WHERE id = ?;', id);
  if (!row) return null;
  if (row.payload_version === 1) return loadSummaryWithDatabase(db, id);
  if (row.payload_version === 3) return (await import('./shiyingSummaryStore')).loadShiyingSummaryAnyWithDatabase(db, id) as Promise<ShiyingSummaryV3>;
  return parseShiyingSummaryV2({ payloadVersion: row.payload_version, id: row.id, kind: row.kind,
    periodStartLifeDate: row.period_start_life_date, periodEndLifeDate: row.period_end_life_date,
    factSummary: row.fact_summary, baiyunNote: row.baiyun_note, inputHash: row.input_hash,
    contractVersion: row.contract_version, status: row.status, dirty: row.dirty === 1,
    rejectedAt: row.rejected_at, presentedAt: row.presented_at, createdAt: row.created_at, updatedAt: row.updated_at,
    sources: await loadSources(db, 'summary', id),
  });
}

export function getShiyingSummarySnapshot(id: string) {
  assertShiyingDeterministicId(id, 'summary');
  return safe(() => runShiyingDatabaseOperation((db) => loadSummary(db, id)));
}
export async function getShiyingSummaryV2ById(id: string) {
  const summary = await getShiyingSummarySnapshot(id);
  if (summary && summary.payloadVersion !== 2) fail('summary_version_mismatch', id);
  return summary as ShiyingSummaryV2 | null;
}

export async function saveShiyingSummaryV2WithDatabase(db: Database, input: ShiyingSummaryV2) {
    const summary = parseShiyingSummaryV2(input);
    const previous = await loadSummary(db, summary.id);
    if (previous?.payloadVersion === 3) fail('summary_version_mismatch', summary.id);
    if (previous?.status === 'rejected' && summary.status !== 'rejected') fail('summary_rejected', summary.id);
    if (previous && summary.updatedAt < previous.updatedAt) fail('stale_time', summary.id);
    const next = parseShiyingSummaryV2({ ...summary,
      createdAt: previous?.createdAt ?? summary.createdAt,
      presentedAt: previous?.presentedAt ?? summary.presentedAt,
      rejectedAt: previous?.rejectedAt ?? summary.rejectedAt,
    });
    await validateSources(db, next.sources);
    await db.runAsync(`INSERT INTO shiying_summaries
      (id,kind,period_start_life_date,period_end_life_date,fact_summary,baiyun_note,input_hash,contract_version,
       status,dirty,rejected_at,presented_at,created_at,updated_at,payload_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,2) ON CONFLICT(id) DO UPDATE SET
      fact_summary=excluded.fact_summary,baiyun_note=excluded.baiyun_note,input_hash=excluded.input_hash,
      contract_version=excluded.contract_version,status=excluded.status,dirty=excluded.dirty,
      rejected_at=excluded.rejected_at,presented_at=excluded.presented_at,updated_at=excluded.updated_at,payload_version=2;`,
    next.id,next.kind,next.periodStartLifeDate,next.periodEndLifeDate,next.factSummary,next.baiyunNote,next.inputHash,
    next.contractVersion,next.status,next.dirty ? 1 : 0,next.rejectedAt,next.presentedAt,next.createdAt,next.updatedAt);
    await db.runAsync('DELETE FROM shiying_summary_sources WHERE summary_id = ?;', next.id);
    await insertSources(db, 'summary', next.id, next.sources);
    return next;
}
export function saveShiyingSummaryV2(input: ShiyingSummaryV2) {
  const summary = parseShiyingSummaryV2(input);
  return safe(() => runShiyingTransaction(db => saveShiyingSummaryV2WithDatabase(db, summary)));
}
export { loadSummary as loadShiyingSummarySnapshotWithDatabase, validateSources as validateShiyingFactSourcesWithDatabase };

function mutateSummaryV2(input: { id: string; at: number }, mutation: 'reject' | 'present') {
  assertShiyingDeterministicId(input.id, 'summary');
  time(input.at);
  return safe(() => runShiyingTransaction(async (db) => {
    const previous = await loadSummary(db, input.id);
    if (!previous) fail('summary_missing', input.id);
    if (previous.payloadVersion !== 2) fail('summary_version_mismatch', input.id);
    if (mutation === 'reject' && previous.status === 'rejected') return previous;
    if (mutation === 'present' && previous.status === 'rejected') fail('summary_rejected', input.id);
    if (mutation === 'present' && previous.presentedAt !== null) return previous;
    if (input.at < previous.updatedAt) fail('stale_time', input.id);
    if (mutation === 'reject') await db.runAsync(`UPDATE shiying_summaries SET status='rejected',rejected_at=?,updated_at=? WHERE id=?;`, input.at,input.at,input.id);
    else await db.runAsync('UPDATE shiying_summaries SET presented_at=?,updated_at=? WHERE id=?;', input.at,input.at,input.id);
    return loadSummary(db, input.id) as Promise<ShiyingSummaryV2>;
  }));
}
export function rejectShiyingSummaryV2(input: { id: string; rejectedAt: number }) {
  return mutateSummaryV2({ id: input.id, at: input.rejectedAt }, 'reject');
}
export function markShiyingSummaryV2Presented(input: { id: string; presentedAt: number }) {
  return mutateSummaryV2({ id: input.id, at: input.presentedAt }, 'present');
}
