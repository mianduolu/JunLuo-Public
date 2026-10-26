import type * as SQLite from 'expo-sqlite';
import { assertShiyingLifeDate, assertShiyingUuidV4 } from './shiyingContract';
import { runShiyingDatabaseOperation, runShiyingTransaction } from './shiyingDatabase';
import {
  createShiyingDraftRecord, createShiyingRecordContentHash, parseShiyingRecordImageV1,
  parseShiyingRecordV1, type ShiyingRecordImageV1, type ShiyingRecordV1,
} from './shiyingJournalContract';
import { insertShiyingRecordImagesWithDatabase, loadShiyingRecordWithDatabase } from './shiyingJournalStore';
import {
  createShiyingYesterdayDraftRecord, getShiyingRecordEffectiveDeadline, getShiyingRecordResumeUntilAt, isShiyingRecordBlank,
  SHIYING_RECORD_IMAGE_LIMIT, SHIYING_RECORD_PREVIEW_LENGTH, type ShiyingRecordLocalState,
  type ShiyingRecordCreationBasis,
} from './shiyingRecordPolicy';
import { markShiyingFactDependentsDirty } from './shiyingStore';

type Database = SQLite.SQLiteDatabase;
type LocalRow = { record_id: string; resume_until_at: number; editing: number };

function fail(code: string, id?: string): never {
  throw new Error(`shiying_record_${code}${id ? `:${id}` : ''}`);
}
function time(now: number) {
  if (!Number.isSafeInteger(now) || now < 0) fail('invalid_time');
}
async function safe<T>(task: () => Promise<T>): Promise<T> {
  try { return await task(); } catch (error) {
    if (error instanceof Error && /^shiying_[a-z_]+(?::[a-zA-Z0-9-]+)?$/u.test(error.message)) throw error;
    return fail('database_operation_failed');
  }
}
async function localState(db: Database, id: string): Promise<ShiyingRecordLocalState | null> {
  const row = await db.getFirstAsync<LocalRow>('SELECT * FROM shiying_record_local_state WHERE record_id = ?;', id);
  return row ? { recordId: row.record_id, resumeUntilAt: row.resume_until_at, editing: row.editing === 1 } : null;
}

async function finishSavedRecord(db: Database, record: ShiyingRecordV1, now: number): Promise<ShiyingRecordV1 | null> {
  const at = Math.max(now, record.updatedAt);
  if (isShiyingRecordBlank(record)) {
    await markShiyingFactDependentsDirty(db, 'record', record.id, at);
    await db.runAsync('DELETE FROM shiying_records WHERE id = ?;', record.id);
    return null;
  }
  if (now < record.nominalFinalizeAt) {
    await db.runAsync('UPDATE shiying_record_local_state SET editing = 0 WHERE record_id = ?;', record.id);
    return record;
  }
  const next = parseShiyingRecordV1({ ...record, status: 'finalized', finalizedAt: at, updatedAt: at });
  await db.runAsync("UPDATE shiying_records SET status = 'finalized',finalized_at = ?,updated_at = ? WHERE id = ?;", at, at, record.id);
  await db.runAsync('DELETE FROM shiying_record_local_state WHERE record_id = ?;', record.id);
  await (await import('./shiyingReviewStore')).markShiyingReviewPeriodDirtyWithDatabase(db, 'record', record.id, record.recordDate);
  return next;
}

async function closePreviousEditor(db: Database, now: number, exceptId?: string) {
  const row = await db.getFirstAsync<LocalRow>('SELECT * FROM shiying_record_local_state WHERE editing = 1;');
  if (!row || row.record_id === exceptId) return;
  const record = await loadShiyingRecordWithDatabase(db, row.record_id);
  if (record?.status === 'draft') await finishSavedRecord(db, record, now);
  else await db.runAsync('DELETE FROM shiying_record_local_state WHERE record_id = ?;', row.record_id);
}

async function settle(db: Database, now: number, liveEditorId: string | null) {
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT r.id FROM shiying_records r LEFT JOIN shiying_record_local_state l ON l.record_id = r.id
      WHERE r.status = 'draft' AND r.nominal_finalize_at <= ?
        AND (? IS NULL OR r.id <> ?)
        AND (l.editing IS NULL OR l.editing = 0 OR l.resume_until_at <= ?);`,
    now, liveEditorId, liveEditorId, now,
  );
  const finalizedIds: string[] = [];
  const deletedIds: string[] = [];
  for (const { id } of rows) {
    const record = await loadShiyingRecordWithDatabase(db, id);
    if (!record) fail('missing', id);
    const result = await finishSavedRecord(db, record, now);
    (result ? finalizedIds : deletedIds).push(id);
  }
  return { finalizedIds, deletedIds };
}

export function createRecordForWriting(now: number, date: 'today' | 'yesterday' = 'today',
  frozenYesterdayDate?: string, basis?: ShiyingRecordCreationBasis): Promise<ShiyingRecordV1> {
  time(now);
  if (date !== 'today' && date !== 'yesterday') fail('invalid_date_choice');
  const fresh = date === 'yesterday' ? createShiyingYesterdayDraftRecord(now, frozenYesterdayDate) : createShiyingDraftRecord({ createdAt: now });
  const record = basis ? parseShiyingRecordV1({ ...fresh, recordDate: basis.recordDate, nominalFinalizeAt: basis.nominalFinalizeAt }) : fresh;
  const resumeUntilAt = basis?.resumeUntilAt ?? getShiyingRecordResumeUntilAt(now);
  time(resumeUntilAt);
  if (resumeUntilAt < record.nominalFinalizeAt || frozenYesterdayDate && frozenYesterdayDate !== record.recordDate) fail('invalid_creation_basis');
  return safe(() => runShiyingTransaction(async (db) => {
    for (;;) {
      // Keep legacy duplicates intact; the date entry consistently opens its first paper.
      const sameDay = await db.getFirstAsync<{ id: string }>(
        'SELECT id FROM shiying_records WHERE record_date = ? ORDER BY created_at ASC,id ASC LIMIT 1;', record.recordDate);
      if (!sameDay) break;
      const existing = await openRecordWithDatabase(db, sameDay.id, now, null);
      if (existing) return existing;
      // Normal expired-empty cleanup may remove that draft; check any remaining legacy paper.
    }
    await closePreviousEditor(db, now);
    await settle(db, now, null);
    await db.runAsync(`INSERT INTO shiying_records
      (id,record_date,author,body,status,nominal_finalize_at,finalized_at,created_at,updated_at,payload_version)
      VALUES (?,?,'you','','draft',?,NULL,?,?,1);`, record.id, record.recordDate, record.nominalFinalizeAt, now, now);
    await db.runAsync('INSERT INTO shiying_record_local_state (record_id,resume_until_at,editing) VALUES (?,?,1);', record.id, resumeUntilAt);
    return record;
  }));
}

async function openRecordWithDatabase(db: Database, id: string, now: number, liveEditorId: string | null) {
    await closePreviousEditor(db, now, id);
    await settle(db, now, liveEditorId === id ? id : null);
    const record = await loadShiyingRecordWithDatabase(db, id);
    if (!record || record.status === 'finalized') return record;
    // Pre-8B/imported drafts have no recovery deadline. They remain editable until their
    // saved nominal cutoff, but do not gain a guessed extra day after a timezone change.
    const state = await localState(db, id);
    if (state) await db.runAsync('UPDATE shiying_record_local_state SET editing = 1 WHERE record_id = ?;', id);
    return record;
}

export function openRecordForWriting(id: string, now: number, liveEditorId: string | null = null): Promise<ShiyingRecordV1 | null> {
  assertShiyingUuidV4(id, 'record_id'); time(now);
  return safe(() => runShiyingTransaction(db => openRecordWithDatabase(db, id, now, liveEditorId)));
}

export function saveRecordForWriting(input: {
  id: string; expectedContentHash: string; body: string; images: ShiyingRecordImageV1[];
  now: number; finish: boolean;
}): Promise<ShiyingRecordV1 | null> {
  assertShiyingUuidV4(input.id, 'record_id'); time(input.now);
  if (input.images.length > SHIYING_RECORD_IMAGE_LIMIT) fail('image_limit', input.id);
  return safe(() => runShiyingTransaction(async (db) => {
    const previous = await loadShiyingRecordWithDatabase(db, input.id);
    if (!previous) fail('missing', input.id);
    if (previous.status !== 'draft') fail('finalized', input.id);
    if (createShiyingRecordContentHash(previous) !== input.expectedContentHash) fail('content_conflict', input.id);
    const record = parseShiyingRecordV1({ ...previous, body: input.body, images: input.images, updatedAt: Math.max(input.now, previous.updatedAt) });
    await db.runAsync('UPDATE shiying_records SET body = ?,updated_at = ? WHERE id = ?;', record.body, record.updatedAt, record.id);
    await db.runAsync('DELETE FROM shiying_record_images WHERE record_id = ?;', record.id);
    await insertShiyingRecordImagesWithDatabase(db, record.images);
    return input.finish ? finishSavedRecord(db, record, input.now) : record;
  })).then(record => { if (record?.status === 'finalized' || !record) void import('./shiyingMemorySource')
    .then(module => module.notifyShiyingMemorySourceChanged(input.id)).catch(() => undefined); return record; });
}

export function settleDueRecords(now: number, liveEditorId: string | null = null) {
  time(now);
  return safe(() => runShiyingTransaction((db) => settle(db, now, liveEditorId))).then(result => {
    void import('./shiyingMemorySource').then(module => {
      for (const id of [...result.finalizedIds, ...result.deletedIds]) module.notifyShiyingMemorySourceChanged(id);
    }).catch(() => undefined);
    return result;
  });
}

export function getShiyingRecordLocalState(id: string) {
  assertShiyingUuidV4(id, 'record_id');
  return safe(() => runShiyingDatabaseOperation((db) => localState(db, id)));
}

export function getNextRecordDeadline(now: number, liveEditorId: string | null = null): Promise<number | null> {
  time(now);
  return safe(() => runShiyingDatabaseOperation(async (db) => {
    const rows = await db.getAllAsync<{
      id: string; nominal_finalize_at: number; resume_until_at: number | null; editing: number | null;
    }>(`SELECT r.id,r.nominal_finalize_at,l.resume_until_at,l.editing
      FROM shiying_records r LEFT JOIN shiying_record_local_state l ON l.record_id = r.id WHERE r.status = 'draft';`);
    let next: number | null = null;
    for (const row of rows) {
      const local = row.resume_until_at === null ? null : { recordId: row.id, resumeUntilAt: row.resume_until_at, editing: row.editing === 1 };
      const deadline = getShiyingRecordEffectiveDeadline({ id: row.id, status: 'draft', nominalFinalizeAt: row.nominal_finalize_at }, local, liveEditorId);
      if (deadline !== null) next = next === null ? Math.max(now, deadline) : Math.min(next, Math.max(now, deadline));
    }
    return next;
  }));
}

export type ShiyingRecordPreviewCursor = { recordDate: string; createdAt: number; id: string };
export type ShiyingRecordPreview = {
  id: string; recordDate: string; status: 'draft' | 'finalized'; createdAt: number;
  bodyPreview: string; images: ShiyingRecordImageV1[];
};
export function listShiyingRecordPreviews(options: { before?: ShiyingRecordPreviewCursor; limit?: number } = {}): Promise<{
  records: ShiyingRecordPreview[]; nextBefore: ShiyingRecordPreviewCursor | null;
}> {
  const limit = options.limit ?? 30;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid_page_limit');
  if (options.before) {
    assertShiyingLifeDate(options.before.recordDate, 'record_date');
    assertShiyingUuidV4(options.before.id, 'record_id'); time(options.before.createdAt);
  }
  return safe(() => runShiyingDatabaseOperation(async (db) => {
    const cursor = options.before;
    const rows = await db.getAllAsync<{
      id: string; record_date: string; status: 'draft' | 'finalized'; created_at: number; body_preview: string;
    }>(`SELECT id,record_date,status,created_at,substr(body,1,${SHIYING_RECORD_PREVIEW_LENGTH}) AS body_preview FROM shiying_records
      ${cursor ? 'WHERE (record_date < ? OR (record_date = ? AND (created_at < ? OR (created_at = ? AND id < ?))))' : ''}
      ORDER BY record_date DESC,created_at DESC,id DESC LIMIT ?;`,
    ...(cursor ? [cursor.recordDate, cursor.recordDate, cursor.createdAt, cursor.createdAt, cursor.id] : []), limit + 1);
    const records: ShiyingRecordPreview[] = [];
    for (const row of rows.slice(0, limit)) {
      const images = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM shiying_record_images WHERE record_id = ? ORDER BY ordinal;', row.id);
      records.push({ id: row.id, recordDate: row.record_date, status: row.status, createdAt: row.created_at, bodyPreview: row.body_preview,
        images: images.map((image) => parseShiyingRecordImageV1({ payloadVersion: image.payload_version, id: image.id, recordId: image.record_id,
          ordinal: image.ordinal, contentHash: image.content_hash, mimeType: image.mime_type, byteLength: image.byte_length, width: image.width, height: image.height })),
      });
    }
    const last = records[records.length - 1];
    return { records, nextBefore: rows.length > limit && last ? { recordDate: last.recordDate, createdAt: last.createdAt, id: last.id } : null };
  }));
}

export function listShiyingReferencedImageHashes(): Promise<string[]> {
  return safe(() => runShiyingDatabaseOperation(async (db) => {
    const rows = await db.getAllAsync<{ content_hash: string }>('SELECT DISTINCT content_hash FROM shiying_record_images ORDER BY content_hash;');
    return rows.map((row) => row.content_hash);
  }));
}
