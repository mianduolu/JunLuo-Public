import type * as SQLite from 'expo-sqlite';
import { assertShiyingHash, assertShiyingUuidV4, canonicalJsonV1 } from './shiyingContract';
import { runShiyingDatabaseOperation, runShiyingTransaction } from './shiyingDatabase';
import { createShiyingRecordContentHash, type ShiyingRecordV1 } from './shiyingJournalContract';
import { loadShiyingRecordWithDatabase } from './shiyingJournalStore';
import { markShiyingFactDependentsDirty } from './shiyingStore';
import {
  concatenateShiyingImageNoteResults, createShiyingImageNoteId, createShiyingImageNoteInputHash,
  createShiyingImageNoteResultHash, deserializeShiyingRecordImageJobV1, deserializeShiyingRecordImageNoteV1,
  parseShiyingRecordImageJobV1, parseShiyingRecordImageNoteV1, serializeShiyingRecordImageJobV1,
  serializeShiyingRecordImageNoteV1, type ShiyingRecordImageJobV1, type ShiyingRecordImageNoteV1,
} from './shiyingImageNoteContract';

type Database = SQLite.SQLiteDatabase;
export type ShiyingImageUnitReference = { recordId: string; unitId: string };
export type ShiyingImageUnitResult = ShiyingImageUnitReference & { text: string };
export type ShiyingImageUnitAttempt = ShiyingImageUnitReference & { inputHash: string; attemptCount: number; startedAt: number | null };
function fail(code: string, id?: string): never { throw new Error(`shiying_image_store_${code}${id ? `:${id}` : ''}`); }
function time(value: number) { if (!Number.isSafeInteger(value) || value < 0) fail('invalid_time'); }
function code(value: string) { if (!/^[a-z][a-z0-9_]{0,119}$/u.test(value)) fail('invalid_error_code'); }
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof Error && /^shiying_[a-z0-9_]+(?::[a-zA-Z0-9-]+)?$/u.test(error.message)) throw error;
    return fail('database_operation_failed');
  }
}
async function loadNote(db: Database, recordId: string) {
  const row = await db.getFirstAsync<{ payload_json: string }>('SELECT payload_json FROM shiying_record_image_notes WHERE record_id = ?;', recordId);
  return row ? deserializeShiyingRecordImageNoteV1(row.payload_json) : null;
}
async function loadJob(db: Database, recordId: string) {
  const row = await db.getFirstAsync<{ payload_json: string }>('SELECT payload_json FROM shiying_record_image_jobs WHERE record_id = ?;', recordId);
  return row ? deserializeShiyingRecordImageJobV1(row.payload_json) : null;
}
async function saveNote(db: Database, value: ShiyingRecordImageNoteV1) {
  const note = parseShiyingRecordImageNoteV1(value);
  await db.runAsync(`INSERT INTO shiying_record_image_notes
    (id,record_id,record_date,record_content_hash,status,body,edited_at,skipped_at,created_at,updated_at,payload_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET
    status=excluded.status,body=excluded.body,edited_at=excluded.edited_at,skipped_at=excluded.skipped_at,
    updated_at=excluded.updated_at,payload_json=excluded.payload_json;`, note.id,note.recordId,note.recordDate,
  note.recordContentHash,note.status,note.body,note.editedAt,note.skippedAt,note.createdAt,note.updatedAt,
  serializeShiyingRecordImageNoteV1(note));
  return note;
}
async function saveJob(db: Database, value: ShiyingRecordImageJobV1) {
  const job = parseShiyingRecordImageJobV1(value);
  await db.runAsync(`INSERT INTO shiying_record_image_jobs
    (record_id,status,last_error_code,created_at,updated_at,payload_json) VALUES (?,?,?,?,?,?)
    ON CONFLICT(record_id) DO UPDATE SET status=excluded.status,last_error_code=excluded.last_error_code,
    updated_at=excluded.updated_at,payload_json=excluded.payload_json;`,job.recordId,job.status,job.errorCode,
  job.createdAt,job.updatedAt,serializeShiyingRecordImageJobV1(job));
  return job;
}
function sameSource(record: ShiyingRecordV1 | null, value: Pick<ShiyingRecordImageJobV1, 'recordId' | 'recordDate' | 'recordContentHash' | 'images'>) {
  return record !== null && record.status === 'finalized' && record.images.length > 0
    && record.id === value.recordId && record.recordDate === value.recordDate
    && createShiyingRecordContentHash(record) === value.recordContentHash
    && canonicalJsonV1(record.images.map(({ id,ordinal,contentHash }) => ({ id,ordinal,contentHash }))) === canonicalJsonV1(value.images);
}
function assertCurrentSource(record: ShiyingRecordV1 | null, value: ShiyingRecordImageJobV1 | ShiyingRecordImageNoteV1) {
  if (!sameSource(record, value)) fail(record ? 'source_mismatch' : 'record_missing', value.recordId);
}
function unicodeBoundary(body: string, index: number) {
  return !(index > 0 && index < body.length && /[\uD800-\uDBFF]/u.test(body[index - 1]) && /[\uDC00-\uDFFF]/u.test(body[index]));
}
function assertPlanMatchesRecord(record: ShiyingRecordV1, job: ShiyingRecordImageJobV1) {
  if (job.inputHash !== createShiyingImageNoteInputHash(job)) fail('input_hash_mismatch', job.recordId);
  if (!job.units.length) return; // Capacity-blocked single-image tasks retain their source identity.
  const count = job.units[0].captionCount;
  const groups = new Map<number, typeof job.units>();
  for (const unit of job.units) {
    if (unit.captionCount !== count || unit.captionEnd > record.body.length
      || !unicodeBoundary(record.body, unit.captionStart) || !unicodeBoundary(record.body, unit.captionEnd)) fail('plan_caption_range', job.recordId);
    const group = groups.get(unit.captionIndex) ?? [];
    group.push(unit); groups.set(unit.captionIndex, group);
  }
  if (groups.size !== count) fail('plan_caption_missing', job.recordId);
  let previousEnd = 0;
  let previousCaption = -1;
  for (const unit of job.units) {
    if (unit.captionIndex < previousCaption) fail('plan_unit_order', job.recordId);
    previousCaption = unit.captionIndex;
  }
  for (let index = 0; index < count; index += 1) {
    const group = groups.get(index);
    if (!group?.length) fail('plan_caption_missing', job.recordId);
    const first = group[0];
    if (first.captionStart !== previousEnd || group.some((unit) => unit.captionStart !== first.captionStart || unit.captionEnd !== first.captionEnd)
      || canonicalJsonV1(group.flatMap((unit) => unit.imageIds)) !== canonicalJsonV1(record.images.map((image) => image.id))) fail('plan_coverage', job.recordId);
    previousEnd = first.captionEnd;
  }
  if (previousEnd !== record.body.length) fail('plan_coverage', job.recordId);
}
function validateReferences(refs: readonly ShiyingImageUnitReference[]) {
  refs.forEach((ref) => { assertShiyingUuidV4(ref.recordId, 'image_record_id');
    if (!/^shiying-image-unit-v1-[0-9a-f]{64}$/u.test(ref.unitId)) fail('unit_id'); });
  if (new Set(refs.map((ref) => `${ref.recordId}:${ref.unitId}`)).size !== refs.length) fail('duplicate_units');
}

export { sameSource as isShiyingImageNoteSourceCurrent,
  loadNote as loadShiyingRecordImageNoteWithDatabase, loadJob as loadShiyingRecordImageJobWithDatabase,
  loadNote as loadShiyingImageNoteWithDatabase, loadJob as loadShiyingImageJobWithDatabase };
export function getShiyingRecordImageNote(recordId: string) {
  assertShiyingUuidV4(recordId, 'image_record_id');
  return safe(() => runShiyingDatabaseOperation((db) => loadNote(db, recordId)));
}
export function getShiyingRecordImageJob(recordId: string) {
  assertShiyingUuidV4(recordId, 'image_record_id');
  return safe(() => runShiyingDatabaseOperation((db) => loadJob(db, recordId)));
}
export function getShiyingImageRecordForProcessing(recordId: string) {
  assertShiyingUuidV4(recordId, 'image_record_id');
  return safe(() => runShiyingDatabaseOperation((db) => loadShiyingRecordWithDatabase(db, recordId)));
}
export function getShiyingImageNoteSnapshot(recordId: string) {
  assertShiyingUuidV4(recordId, 'image_record_id');
  return safe(() => runShiyingDatabaseOperation(async (db) => {
    const note = await loadNote(db, recordId);
    const record = await loadShiyingRecordWithDatabase(db, recordId);
    return { note, sourceCurrent: note ? sameSource(record, note) : false, job: await loadJob(db, recordId) };
  }));
}
export function listShiyingRecordImageJobs(options: { includeSkipped?: boolean } = {}) {
  return safe(() => runShiyingDatabaseOperation(async (db) => {
    const rows = await db.getAllAsync<{ payload_json: string }>(`SELECT j.payload_json FROM shiying_record_image_jobs j
      JOIN shiying_records r ON r.id=j.record_id ${options.includeSkipped ? '' : "WHERE j.status <> 'skipped'"}
      ORDER BY r.record_date,r.created_at,r.id;`);
    return rows.map((row) => deserializeShiyingRecordImageJobV1(row.payload_json));
  }));
}
export function listShiyingImageEligibleRecordIds() {
  return safe(() => runShiyingDatabaseOperation(async (db) => (await db.getAllAsync<{ id: string }>(
    `SELECT r.id FROM shiying_records r WHERE r.status='finalized'
      AND EXISTS (SELECT 1 FROM shiying_record_images i WHERE i.record_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM shiying_record_image_notes n WHERE n.record_id=r.id)
      AND NOT EXISTS (SELECT 1 FROM shiying_record_image_jobs j WHERE j.record_id=r.id)
      ORDER BY r.record_date,r.created_at,r.id;`,
  )).map((row) => row.id)));
}
export function createShiyingRecordImageJob(input: ShiyingRecordImageJobV1) {
  return createShiyingRecordImageJobs([input]).then((jobs) => jobs[0]);
}
export function createShiyingRecordImageJobs(inputs: readonly ShiyingRecordImageJobV1[]) {
  const jobs = inputs.map(parseShiyingRecordImageJobV1);
  if (new Set(jobs.map((job) => job.recordId)).size !== jobs.length) fail('duplicate_records');
  for (const job of jobs) if (job.units.some((unit) => unit.status !== 'pending' || unit.attemptCount !== 0)) fail('new_job_state', job.recordId);
  return safe(() => runShiyingTransaction(async (db) => {
    const saved: ShiyingRecordImageJobV1[] = [];
    for (const job of jobs) {
      const record = await loadShiyingRecordWithDatabase(db, job.recordId);
      assertCurrentSource(record, job);
      assertPlanMatchesRecord(record!, job);
      const previous = await loadJob(db, job.recordId);
      if (previous) {
        if (previous.inputHash !== job.inputHash || previous.frozenConfigHash !== job.frozenConfigHash
          || canonicalJsonV1(previous.units.map(({ id }) => id)) !== canonicalJsonV1(job.units.map(({ id }) => id))) fail('job_conflict', job.recordId);
        saved.push(previous);
        continue;
      }
      const note = await loadNote(db, job.recordId);
      if (note) fail('note_already_exists', job.recordId);
      saved.push(await saveJob(db, job));
    }
    return saved;
  }));
}
export function markShiyingImageUnitsInFlight(input: {
  units: readonly ShiyingImageUnitReference[]; expectedConfigHash: string; startedAt: number;
  expectedUnits?: readonly ShiyingImageUnitAttempt[];
}) {
  validateReferences(input.units); time(input.startedAt); assertShiyingHash(input.expectedConfigHash, 'image_config_hash');
  return safe(() => runShiyingTransaction(async (db) => {
    const jobs: ShiyingRecordImageJobV1[] = [];
    for (const ref of input.units) {
      const job = await loadJob(db, ref.recordId);
      if (!job || job.status === 'skipped') fail('job_unavailable', ref.recordId);
      assertCurrentSource(await loadShiyingRecordWithDatabase(db, ref.recordId), job);
      if (job.frozenConfigHash !== input.expectedConfigHash) fail('config_mismatch', ref.recordId);
      if (input.startedAt < job.updatedAt) fail('stale_time', ref.recordId);
      const unit = job.units.find((unit) => unit.id === ref.unitId);
      if (!unit || unit.status !== 'pending') fail('unit_not_pending', ref.recordId);
      if (input.expectedUnits) {
        const expected = input.expectedUnits.find(item => item.recordId === ref.recordId && item.unitId === ref.unitId);
        if (!expected || expected.inputHash !== job.inputHash || expected.attemptCount !== unit.attemptCount
          || expected.startedAt !== unit.startedAt) fail('retry_identity_changed', ref.recordId);
      }
      jobs.push(await saveJob(db, { ...job, status: 'pending', errorCode: null, updatedAt: input.startedAt,
        units: job.units.map((item) => item.id !== ref.unitId ? item : { ...item, status: 'in_flight',
          attemptCount: item.attemptCount + 1, startedAt: input.startedAt, errorCode: null }) }));
    }
    return jobs;
  }));
}

async function finishNote(db: Database, job: ShiyingRecordImageJobV1, completedAt: number) {
  const previous = await loadNote(db, job.recordId);
  if (previous?.status === 'ready') fail('note_already_exists', job.recordId);
  const note = parseShiyingRecordImageNoteV1({ payloadVersion: 1, id: createShiyingImageNoteId(job.recordId),
    recordId: job.recordId, recordDate: job.recordDate, recordContentHash: job.recordContentHash,
    images: job.images, inputHash: job.inputHash, contractVersion: job.contractVersion,
    promptHash: job.promptHash, modelSource: job.modelSource, status: 'ready',
    body: concatenateShiyingImageNoteResults(job.units.map((unit) => unit.resultText!)),
    editedAt: null, skippedAt: null, createdAt: previous?.createdAt ?? job.createdAt, updatedAt: completedAt });
  await saveNote(db, note);
  await markShiyingFactDependentsDirty(db, 'record', job.recordId, completedAt);
  await db.runAsync('DELETE FROM shiying_record_image_jobs WHERE record_id = ?;', job.recordId);
  return note;
}

export function finalizeShiyingCompletedImageJob(recordId: string, completedAt: number) {
  assertShiyingUuidV4(recordId, 'record_id'); time(completedAt);
  return safe(() => runShiyingTransaction(async db => {
    const job = await loadJob(db, recordId);
    if (!job) return loadNote(db, recordId);
    if (job.status === 'skipped' || !job.units.length || job.units.some(unit => unit.status !== 'completed')) fail('job_not_complete', recordId);
    assertCurrentSource(await loadShiyingRecordWithDatabase(db, recordId), job);
    return finishNote(db, job, Math.max(completedAt, job.updatedAt));
  })).then(note => { if (note?.status === 'ready') void import('./shiyingMemorySource')
    .then(module => module.notifyShiyingMemorySourceChanged(recordId)).catch(() => undefined); return note; });
}

export function settleShiyingImageRequest(input: {
  results: readonly ShiyingImageUnitResult[]; failedUnits?: readonly ShiyingImageUnitReference[];
  errorCode?: string; completedAt: number;
  localRecovery?: { expectedJobs: readonly ShiyingRecordImageJobV1[]; incompleteErrorCode: string };
}) {
  const failed = input.failedUnits ?? [];
  validateReferences([...input.results, ...failed]); time(input.completedAt);
  if (failed.length) code(input.errorCode ?? 'bad_output');
  if (input.localRecovery) code(input.localRecovery.incompleteErrorCode);
  for (const result of input.results) if (typeof result.text !== 'string' || !result.text.trim()) fail('empty_result');
  return safe(() => runShiyingTransaction(async (db) => {
    const notes: ShiyingRecordImageNoteV1[] = [];
    const jobs: ShiyingRecordImageJobV1[] = [];
    const discardedRecordIds: string[] = [];
    const recordIds = [...new Set([...input.results, ...failed].map((item) => item.recordId))];
    for (const recordId of recordIds) {
      let job = await loadJob(db, recordId);
      const record = await loadShiyingRecordWithDatabase(db, recordId);
      const expected = input.localRecovery?.expectedJobs.find((item) => item.recordId === recordId);
      const recordResults = input.results.filter((item) => item.recordId === recordId);
      const recordFailed = failed.filter((item) => item.recordId === recordId);
      if (input.localRecovery) {
        if (!expected || !sameSource(record, expected)) { discardedRecordIds.push(recordId); continue; }
        const note = await loadNote(db, recordId);
        // A committed final result may have lost its acknowledgement, or been corrected since.
        // Its stable input identity, not the current body/result hash, acknowledges that request.
        if (note?.status === 'ready' && note.inputHash === expected.inputHash && sameSource(record, note)) {
          notes.push(note); continue;
        }
        if (!job || job.status === 'skipped' || job.inputHash !== expected.inputHash
          || job.frozenConfigHash !== expected.frozenConfigHash || [...recordResults, ...recordFailed].some((ref) => {
            const unit = job!.units.find((item) => item.id === ref.unitId);
            const original = expected.units.find((item) => item.id === ref.unitId);
            if (!unit || !original || unit.attemptCount !== original.attemptCount || unit.startedAt !== original.startedAt) return true;
            if (unit.status === 'in_flight') return false;
            const result = recordResults.find((item) => item.unitId === unit.id);
            return result ? unit.status !== 'completed' || unit.resultText !== result.text
              : unit.status !== 'pending' || unit.errorCode !== (input.errorCode ?? 'bad_output');
          })) { discardedRecordIds.push(recordId); continue; }
      }
      if (!job || !record) { discardedRecordIds.push(recordId); continue; }
      if (input.completedAt < job.updatedAt) fail('stale_time', recordId);
      if (!sameSource(record, job)) {
        job = { ...job, status: 'blocked', errorCode: 'source_mismatch', updatedAt: input.completedAt,
          units: job.units.map((unit) => unit.status === 'in_flight' ? { ...unit, status: 'pending', errorCode: 'source_mismatch' } : unit) };
        jobs.push(await saveJob(db, job)); discardedRecordIds.push(recordId); continue;
      }
      if (job.status === 'skipped') { discardedRecordIds.push(recordId); continue; }
      const changedIds = [...recordResults, ...recordFailed].map((item) => item.unitId);
      if (!input.localRecovery && changedIds.some((id) => !job!.units.some((unit) => unit.id === id && unit.status === 'in_flight'))) fail('unit_not_in_flight', recordId);
      const failedCode = input.errorCode ?? 'bad_output';
      job = { ...job, status: recordFailed.length || input.localRecovery ? 'blocked' : 'pending',
        errorCode: recordFailed.length ? failedCode : input.localRecovery?.incompleteErrorCode ?? null, updatedAt: input.completedAt,
        units: job.units.map((unit) => {
          if (input.localRecovery && unit.status !== 'in_flight') return unit;
          const result = recordResults.find((item) => item.unitId === unit.id);
          if (result) return { ...unit, status: 'completed', resultText: result.text, errorCode: null, completedAt: input.completedAt };
          if (recordFailed.some((item) => item.unitId === unit.id)) return { ...unit, status: 'pending', errorCode: failedCode };
          return unit;
        }) };
      if (job.units.length && job.units.every((unit) => unit.status === 'completed')) notes.push(await finishNote(db, job, input.completedAt));
      else jobs.push(await saveJob(db, job));
    }
    return { notes, jobs, discardedRecordIds };
  })).then(result => { if (result.notes.length) void import('./shiyingMemorySource').then(module => {
    for (const note of result.notes) module.notifyShiyingMemorySourceChanged(note.recordId);
  }).catch(() => undefined); return result; });
}
export function completeShiyingImageUnits(input: { results: readonly ShiyingImageUnitResult[]; completedAt: number }) {
  return settleShiyingImageRequest(input);
}
export function failShiyingImageUnits(input: { units: readonly ShiyingImageUnitReference[]; errorCode: string; updatedAt: number }) {
  return settleShiyingImageRequest({ results: [], failedUnits: input.units, errorCode: input.errorCode, completedAt: input.updatedAt });
}
export function blockShiyingRecordImageJob(input: { recordId: string; errorCode: string; updatedAt: number }) {
  assertShiyingUuidV4(input.recordId, 'image_record_id'); code(input.errorCode); time(input.updatedAt);
  return safe(() => runShiyingTransaction(async (db) => {
    const job = await loadJob(db, input.recordId);
    if (!job) return null;
    if (input.updatedAt < job.updatedAt) fail('stale_time', job.recordId);
    if (job.status === 'skipped') return job;
    return saveJob(db, { ...job, status: 'blocked', errorCode: input.errorCode, updatedAt: input.updatedAt,
      units: job.units.map((unit) => unit.status === 'in_flight' ? { ...unit, status: 'pending', errorCode: input.errorCode } : unit) });
  }));
}
export function skipShiyingRecordImageJob(input: { recordId: string; skippedAt: number }) {
  assertShiyingUuidV4(input.recordId, 'image_record_id'); time(input.skippedAt);
  return safe(() => runShiyingTransaction(async (db) => {
    const job = await loadJob(db, input.recordId);
    if (!job) fail('job_missing', input.recordId);
    if (job.status === 'skipped') return { job, note: await loadNote(db, input.recordId) };
    if (job.status !== 'blocked') fail('skip_requires_blocked', job.recordId);
    if (input.skippedAt < job.updatedAt) fail('stale_time', job.recordId);
    if (job.units.some((unit) => unit.status === 'in_flight')) fail('request_in_flight', job.recordId);
    const previous = await loadNote(db, job.recordId);
    if (previous?.status === 'ready') fail('note_already_exists', job.recordId);
    const nextJob = await saveJob(db, { ...job, status: 'skipped', errorCode: job.errorCode ?? 'temporarily_skipped', updatedAt: input.skippedAt });
    const note = await saveNote(db, parseShiyingRecordImageNoteV1({ payloadVersion: 1,
      id: createShiyingImageNoteId(job.recordId), recordId: job.recordId, recordDate: job.recordDate,
      recordContentHash: job.recordContentHash, images: job.images, inputHash: job.inputHash,
      contractVersion: job.contractVersion, promptHash: job.promptHash, modelSource: job.modelSource,
      status: 'skipped', body: null, editedAt: null, skippedAt: input.skippedAt,
      createdAt: previous?.createdAt ?? job.createdAt, updatedAt: input.skippedAt }));
    await markShiyingFactDependentsDirty(db, 'record', job.recordId, input.skippedAt);
    return { job: nextJob, note };
  }));
}
export function resumeShiyingRecordImageJob(input: { recordId: string; updatedAt: number }) {
  assertShiyingUuidV4(input.recordId, 'image_record_id'); time(input.updatedAt);
  return safe(() => runShiyingTransaction(async (db) => {
    const job = await loadJob(db, input.recordId);
    if (!job) fail('job_missing', input.recordId);
    if (input.updatedAt < job.updatedAt) fail('stale_time', input.recordId);
    assertCurrentSource(await loadShiyingRecordWithDatabase(db, input.recordId), job);
    if (!job.units.length) return saveJob(db, { ...job, status: 'blocked', errorCode: 'capacity_blocked', updatedAt: input.updatedAt });
    return saveJob(db, { ...job, status: 'pending', errorCode: null, updatedAt: input.updatedAt });
  }));
}
export function recoverShiyingImageJobInterruptions(updatedAt: number, options: { recordIds?: readonly string[] } = {}) {
  time(updatedAt);
  options.recordIds?.forEach((id) => assertShiyingUuidV4(id, 'image_record_id'));
  return safe(() => runShiyingTransaction(async (db) => {
    const rows = await db.getAllAsync<{ payload_json: string }>('SELECT payload_json FROM shiying_record_image_jobs;');
    const recovered: ShiyingRecordImageJobV1[] = [];
    for (const row of rows) {
      const job = deserializeShiyingRecordImageJobV1(row.payload_json);
      if (options.recordIds && !options.recordIds.includes(job.recordId)) continue;
      if (!job.units.some((unit) => unit.status === 'in_flight')) continue;
      recovered.push(await saveJob(db, { ...job, status: 'blocked', errorCode: 'request_interrupted_billing_unknown',
        updatedAt: Math.max(updatedAt, job.updatedAt), units: job.units.map((unit) => unit.status === 'in_flight'
          ? { ...unit, status: 'pending', errorCode: 'request_interrupted_billing_unknown' } : unit) }));
    }
    return recovered;
  }));
}
export function replaceShiyingImageNoteBody(input: { recordId: string; expectedResultHash: string; body: string; editedAt: number }) {
  assertShiyingUuidV4(input.recordId, 'image_record_id'); assertShiyingHash(input.expectedResultHash, 'image_result_hash'); time(input.editedAt);
  return safe(() => runShiyingTransaction(async (db) => {
    const note = await loadNote(db, input.recordId);
    if (!note || note.status !== 'ready') fail('note_not_ready', input.recordId);
    assertCurrentSource(await loadShiyingRecordWithDatabase(db, input.recordId), note);
    if (createShiyingImageNoteResultHash(note) !== input.expectedResultHash) fail('note_content_conflict', input.recordId);
    if (input.editedAt < note.updatedAt) fail('stale_time', input.recordId);
    const next = await saveNote(db, { ...note, body: input.body, editedAt: input.editedAt, updatedAt: input.editedAt });
    await markShiyingFactDependentsDirty(db, 'record', input.recordId, input.editedAt);
    return next;
  })).then(note => { void import('./shiyingMemorySource').then(module => module.notifyShiyingMemorySourceChanged(input.recordId)).catch(() => undefined); return note; });
}
