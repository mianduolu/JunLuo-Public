import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { runBackupRestoreExclusive } from '../backup/backupRestoreCoordinator';
import { backupDatabaseToDirectory, openDatabaseImportSource, restoreDatabaseFromDisk } from '../backup/sqliteBackupFiles';
import { restoreDirectorySafely } from '../storage/safeFileWrite';
import { ShiyingMissingImagesError, type CreateBackupArchiveOptions, type ShiyingBackupMissingImage } from '../backup/backupTypes';
import { SHIYING_DATABASE_NAME, SHIYING_DATABASE_VERSION, initializeShiyingDatabaseSchema,
  runShiyingDatabaseMaintenance, runShiyingDatabaseOperation } from './shiyingDatabase';
import { loadShiyingAutomaticStateInTransaction, type ShiyingAutomaticState } from './shiyingAutomaticStore';
import { readShiyingBackfillTaskWithDatabase, writeShiyingBackfillTaskWithDatabase,
  type ShiyingBackfillTask } from './shiyingBackfillStore';
import { canonicalJsonV1 } from './shiyingContract';
import { loadManualRunWithDatabase, loadEntryWithDatabase, loadCoverageWithDatabase } from './shiyingStore';
import { loadShiyingRecordWithDatabase, loadShiyingSummarySnapshotWithDatabase } from './shiyingJournalStore';
import { deserializeShiyingRecordImageJobV1, deserializeShiyingRecordImageNoteV1,
  serializeShiyingRecordImageJobV1 } from './shiyingImageNoteContract';
import { loadRun, loadShiyingEventSnapshotWithDatabase, loadTopic } from './shiyingReviewStore';
import type { ShiyingReviewRun } from './shiyingReviewContract';
import { SHIYING_BACKUP_MEDIA_FOLDER, SHIYING_BACKUP_MEDIA_PREFIX, SHIYING_RESTORE_PAUSED } from './shiyingBackupPolicy';
import { assertShiyingBackupHasNoPendingSave } from './shiyingBackupRuntime';

type Database = SQLite.SQLiteDatabase;
export type ShiyingBackupImage = ShiyingBackupMissingImage & { contentHash: string; byteSize: number };
export type PreparedShiyingBackup = { databaseDirectory: string; mediaDirectory: string;
  images: ShiyingBackupImage[]; missing: ShiyingBackupMissingImage[];
  localState: { automatic: ShiyingAutomaticState; backfill: ShiyingBackfillTask | null } };
export const readShiyingBackupLocalState = () => runShiyingDatabaseOperation(async db => ({
  automatic: await loadShiyingAutomaticStateInTransaction(db), backfill: await readShiyingBackfillTaskWithDatabase(db),
}));
function fail(code: string): never { throw new Error(`shiying_backup_${code}`); }
function mediaDirectory() {
  if (!FileSystem.documentDirectory) fail('storage_unavailable');
  return `${FileSystem.documentDirectory}${SHIYING_BACKUP_MEDIA_FOLDER}/`;
}
const fileName = (image: ShiyingBackupImage) => image.contentHash.slice(7);

// Validate the supported structure against the same migrations that create a new
// database. This reference contains no user data and is closed immediately.
let expectedStructure: Promise<string> | undefined;
async function structure(db: Database) {
  const tables = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'shiying_%' ORDER BY name;");
  const result = [];
  for (const { name } of tables) {
    if (!/^shiying_[a-z_]+$/u.test(name)) fail('structure_invalid');
    const indexes = await db.getAllAsync<{ name: string }>(`PRAGMA index_list(${name});`);
    const indexColumns = [];
    for (const index of indexes) {
      if (!/^[a-zA-Z0-9_]+$/u.test(index.name)) fail('structure_invalid');
      indexColumns.push({ name: index.name, columns: await db.getAllAsync(`PRAGMA index_info(${index.name});`) });
    }
    result.push({ name, columns: await db.getAllAsync(`PRAGMA table_info(${name});`),
      foreignKeys: await db.getAllAsync(`PRAGMA foreign_key_list(${name});`),
      indexes, indexColumns });
  }
  return canonicalJsonV1(result);
}
async function supportedStructure() {
  if (!expectedStructure) expectedStructure = (async () => {
    const db = await SQLite.openDatabaseAsync(':memory:', { useNewConnection: true });
    try { await initializeShiyingDatabaseSchema(db); return await structure(db); }
    finally { await db.closeAsync(); }
  })().catch(error => { expectedStructure = undefined; throw error; });
  return expectedStructure;
}

function validateReviewPayload(run: ShiyingReviewRun) {
  const plan = JSON.parse(run.planJson);
  if (!plan || plan.version !== ((run.kind ?? 'week') === 'week' ? 1 : 2)
    || plan.inputHash !== run.inputHash || plan.promptHash !== run.promptHash
    || plan.periodStart !== run.periodStart || plan.periodEnd !== run.periodEnd
    || !Array.isArray(plan.refs) || !Array.isArray(plan.materials) || !Array.isArray(plan.chunks)
    || typeof plan.direct !== 'boolean') fail('review_plan');
  const labels = new Set<string>(), rangeKeys = new Set<string>();
  for (const ref of plan.refs) {
    const key = plan.version === 1 ? ref?.ref : ref?.key;
    if (!ref || typeof ref.ref !== 'string' || !ref.ref || typeof key !== 'string' || !key || rangeKeys.has(key)
      || typeof ref.parent !== 'string' || typeof ref.id !== 'string'
      || !ref.range || !Number.isSafeInteger(ref.range.start) || !Number.isSafeInteger(ref.range.end)
      || ref.range.start < 0 || ref.range.end <= ref.range.start) fail('review_refs');
    labels.add(ref.ref); rangeKeys.add(key);
    if (plan.version === 2) labels.add(ref.parent);
  }
  const sources = (value: unknown) => {
    if (!Array.isArray(value) || !value.length || value.some(ref => typeof ref !== 'string' || !labels.has(ref))) fail('review_sources');
  };
  const text = (value: unknown) => { if (typeof value !== 'string' || !value.trim()) fail('review_text'); };
  for (const chunk of run.chunks) {
    const payload = JSON.parse(chunk.payloadJson);
    if (!payload || Object.keys(payload).join(',') !== 'refs' || !Array.isArray(payload.refs)
      || payload.refs.some((ref: unknown) => typeof ref !== 'string' || !rangeKeys.has(ref))) fail('review_payload');
    if (chunk.resultJson === null) continue;
    const result = JSON.parse(chunk.resultJson);
    const expected = (run.kind ?? 'week') === 'week'
      ? [chunk.stage === 'read' ? 'notes' : 'review', 'events', 'topics'] : [chunk.stage === 'read' ? 'notes' : 'review'];
    if (!result || Object.keys(result).sort().join(',') !== expected.sort().join(',')) fail('review_result');
    if (chunk.stage === 'read') {
      if (!Array.isArray(result.notes) || !result.notes.length) fail('review_notes');
      for (const note of result.notes) { text(note.text); sources(note.sources); }
    } else { text(result.review?.title); text(result.review?.factSummary); text(result.review?.baiyunNote); sources(result.review?.sources); }
    if ((run.kind ?? 'week') === 'week') {
      if (!Array.isArray(result.events) || !Array.isArray(result.topics)) fail('review_result');
      for (const event of result.events) {
        text(event.title); text(event.overview);
        if (!Array.isArray(event.nodes) || !event.nodes.length) fail('review_event');
        for (const node of event.nodes) { text(node.body); sources(node.sources); }
      }
      for (const topic of result.topics) { text(topic.title); sources(topic.sources); }
    }
  }
}

export async function validateShiyingBackupDatabase(db: Database) {
  try {
    const version = (await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;'))?.user_version;
    if (!Number.isSafeInteger(version) || !version || version > SHIYING_DATABASE_VERSION) fail('schema_unsupported');
    const check = await db.getFirstAsync<{ quick_check: string }>('PRAGMA quick_check;');
    if (check?.quick_check !== 'ok') fail('quick_check');
    // Only the captured/staged copy is migrated, never the live import target.
    await initializeShiyingDatabaseSchema(db);
    if (await structure(db) !== await supportedStructure()) fail('structure_invalid');
    await loadShiyingAutomaticStateInTransaction(db);
    await loadManualRunWithDatabase(db);
    for (const kind of ['week', 'month', 'year'] as const) {
      const run = await loadRun(db, kind); if (run) validateReviewPayload(run);
    }
    await readShiyingBackfillTaskWithDatabase(db);
    for (const [table, load] of [
      ['shiying_records', loadShiyingRecordWithDatabase], ['shiying_entries', loadEntryWithDatabase],
      ['shiying_summaries', loadShiyingSummarySnapshotWithDatabase], ['shiying_coverage_receipts', loadCoverageWithDatabase],
      ['shiying_events', loadShiyingEventSnapshotWithDatabase], ['shiying_topics', loadTopic],
    ] as const) {
      // Read bounded identity pages; bodies are validated one entity at a time.
      let after: string | null = null;
      for (;;) {
        const rows: Array<{ id: string }> = after === null
          ? await db.getAllAsync<{ id: string }>(`SELECT id FROM ${table} ORDER BY id LIMIT 100;`)
          : await db.getAllAsync<{ id: string }>(`SELECT id FROM ${table} WHERE id>? ORDER BY id LIMIT 100;`, after);
        if (!rows.length) break;
        for (const row of rows) await load(db, row.id);
        after = rows[rows.length - 1].id;
      }
    }
    for (const row of await db.getAllAsync<{ id: string; record_id: string; body: string | null; status: string; payload_json: string }>('SELECT * FROM shiying_record_image_notes;')) {
      const note = deserializeShiyingRecordImageNoteV1(row.payload_json);
      if (row.id !== note.id || row.record_id !== note.recordId || row.body !== note.body || row.status !== note.status) fail('image_note_identity');
    }
    for (const row of await db.getAllAsync<{ record_id: string; status: string; last_error_code: string | null; payload_json: string }>('SELECT * FROM shiying_record_image_jobs;')) {
      const job = deserializeShiyingRecordImageJobV1(row.payload_json);
      if (row.record_id !== job.recordId || row.status !== job.status || row.last_error_code !== job.errorCode) fail('image_job_identity');
      const record = await loadShiyingRecordWithDatabase(db, job.recordId);
      if (!record || record.status !== 'finalized') fail('image_job_record');
      for (const unit of job.units) if (unit.captionEnd > record.body.length) fail('image_job_range');
    }
  } catch { fail('database_invalid'); }
}

export async function readShiyingBackupImages(db: Database): Promise<ShiyingBackupImage[]> {
  const rows = await db.getAllAsync<{ id: string; record_id: string; record_date: string; created_at: number;
    ordinal: number; content_hash: string; byte_length: number }>(`SELECT i.*,r.record_date,r.created_at
      FROM shiying_record_images i JOIN shiying_records r ON r.id=i.record_id
      ORDER BY r.record_date,r.created_at,r.id,i.ordinal;`);
  return rows.map(row => ({ imageId: row.id, recordId: row.record_id, recordDate: row.record_date,
    createdAt: row.created_at, imageOrdinal: row.ordinal, contentHash: row.content_hash, byteSize: row.byte_length }));
}

export function acceptShiyingMissing(images: ShiyingBackupMissingImage[], accepted: readonly string[] | undefined,
  operation: 'export' | 'restore') {
  if (images.some(image => !accepted?.includes(image.imageId))) throw new ShiyingMissingImagesError(images, operation);
}
async function validateImage(uri: string, image: ShiyingBackupImage) {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || info.isDirectory || info.size !== image.byteSize) fail('image_bytes');
    const bytes = Buffer.from(await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }), 'base64');
    if (bytes.length !== image.byteSize || `sha256:${bytesToHex(sha256(bytes))}` !== image.contentHash) fail('image_hash');
  } catch { fail('image_invalid'); }
}
function imageGroups(images: ShiyingBackupImage[]) {
  const groups = new Map<string, ShiyingBackupImage[]>();
  for (const image of images) {
    const group = groups.get(image.contentHash) ?? [];
    if (group.some(other => other.byteSize !== image.byteSize)) fail('shared_image_metadata');
    group.push(image); groups.set(image.contentHash, group);
  }
  return [...groups.values()];
}

export async function captureShiyingBackup(databaseDirectory: string, rootDirectory: string,
  options: CreateBackupArchiveOptions, includedFiles: string[]) {
  const capture = () => runShiyingDatabaseOperation(async () => {
    assertShiyingBackupHasNoPendingSave();
    await backupDatabaseToDirectory(SHIYING_DATABASE_NAME, databaseDirectory);
    const db = await openDatabaseImportSource({ directory: databaseDirectory, fileName: SHIYING_DATABASE_NAME });
    try {
      await validateShiyingBackupDatabase(db);
      const images = await readShiyingBackupImages(db);
      const missing: ShiyingBackupMissingImage[] = [];
      const target = `${rootDirectory}files/${SHIYING_BACKUP_MEDIA_FOLDER}/`;
      await FileSystem.makeDirectoryAsync(target, { intermediates: true });
      for (const group of imageGroups(images)) {
        const image = group[0], source = `${mediaDirectory()}${fileName(image)}`;
        const info = await FileSystem.getInfoAsync(source);
        if (!info.exists) { missing.push(...group); continue; }
        await validateImage(source, image);
        await FileSystem.copyAsync({ from: source, to: `${target}${fileName(image)}` });
        await validateImage(`${target}${fileName(image)}`, image);
        includedFiles.push(`${SHIYING_BACKUP_MEDIA_PREFIX}${fileName(image)}`);
      }
      if (!options.preserveShiyingLocalStateForRollback) {
        acceptShiyingMissing(missing, options.acceptedMissingShiyingImageIds, 'export');
        await db.runAsync(`UPDATE shiying_automatic_state SET enabled=0,first_enabled_life_date=NULL,scan_floor_at=NULL,
          night_life_date=NULL,reserved_calls=0,closed=0,batch_id=NULL,last_error_code=NULL,updated_at=0 WHERE id=1;`);
      }
      assertShiyingBackupHasNoPendingSave();
      return missing.map(image => image.imageId);
    } finally { await db.closeAsync(); }
  });
  return options.shiyingCaptureAlreadyExclusive ? capture() : runBackupRestoreExclusive(capture);
}

export async function prepareShiyingBackup(databaseDirectory: string, rootDirectory: string,
  declaredMissing: readonly string[] | undefined): Promise<PreparedShiyingBackup> {
  const db = await openDatabaseImportSource({ directory: databaseDirectory, fileName: SHIYING_DATABASE_NAME });
  try {
    await validateShiyingBackupDatabase(db);
    const images = await readShiyingBackupImages(db);
    const declared = new Set(declaredMissing ?? []);
    if (declared.size !== (declaredMissing?.length ?? 0) || [...declared].some(id => !images.some(image => image.imageId === id))) fail('missing_declaration');
    const directory = `${rootDirectory}files/${SHIYING_BACKUP_MEDIA_FOLDER}/`;
    for (const group of imageGroups(images)) {
      const count = group.filter(image => declared.has(image.imageId)).length;
      if (count && count !== group.length) fail('shared_missing_declaration');
      if (count) {
        if ((await FileSystem.getInfoAsync(`${directory}${fileName(group[0])}`)).exists) fail('missing_file_present');
      } else await validateImage(`${directory}${fileName(group[0])}`, group[0]);
    }
    const info = await FileSystem.getInfoAsync(directory);
    if (info.exists) for (const name of await FileSystem.readDirectoryAsync(directory)) {
      if (!/^[a-f0-9]{64}$/u.test(name) || !images.some(image => fileName(image) === name && !declared.has(image.imageId))) fail('unexpected_media');
    }
    return { databaseDirectory, mediaDirectory: directory, images,
      missing: images.filter(image => declared.has(image.imageId)), localState: {
        automatic: await loadShiyingAutomaticStateInTransaction(db), backfill: await readShiyingBackfillTaskWithDatabase(db),
      } };
  } finally { await db.closeAsync(); }
}

function sameBackfillInput(a: ShiyingBackfillTask, b: ShiyingBackfillTask) {
  const identity = (task: ShiyingBackfillTask) => ({ id: task.id, configurationHash: task.configurationHash,
    triggeredAt: task.triggeredAt, tokenLimit: task.tokenLimit, days: task.days.map(day => ({ lifeDate: day.lifeDate,
      batchId: day.batchId, scanFloorAt: day.scanFloorAt, scanCeilingAt: day.scanCeilingAt, windowEndCursor: day.windowEndCursor })) });
  return canonicalJsonV1(identity(a)) === canonicalJsonV1(identity(b));
}
export async function pauseRestoredShiyingTasks(db: Database, local: PreparedShiyingBackup['localState']) {
  await db.execAsync('BEGIN EXCLUSIVE;');
  try {
    const automatic = { ...local.automatic };
    if (automatic.batchId && !await db.getFirstAsync('SELECT batch_id FROM shiying_runs WHERE batch_id=?;', automatic.batchId)) {
      automatic.batchId = null;
      if (automatic.nightLifeDate) automatic.closed = true;
    }
    await db.runAsync(`UPDATE shiying_automatic_state SET enabled=?,first_enabled_life_date=?,scan_floor_at=?,night_life_date=?,
      reserved_calls=?,closed=?,batch_id=?,last_error_code=?,updated_at=? WHERE id=1;`,
    automatic.enabled ? 1 : 0, automatic.firstEnabledLifeDate, automatic.scanFloorAt, automatic.nightLifeDate,
    automatic.reservedCalls, automatic.closed ? 1 : 0, automatic.batchId, automatic.lastErrorCode, automatic.updatedAt);
    // A zero-chunk capacity-blocked run retains its existing valid obstruction.
    await db.runAsync("UPDATE shiying_runs SET status='blocked',last_error_code=? WHERE EXISTS (SELECT 1 FROM shiying_run_chunks c WHERE c.run_id=shiying_runs.batch_id);", SHIYING_RESTORE_PAUSED);
    await db.runAsync("UPDATE shiying_review_runs SET status='blocked',last_error_code=?;", SHIYING_RESTORE_PAUSED);
    for (const row of await db.getAllAsync<{ payload_json: string }>('SELECT payload_json FROM shiying_record_image_jobs;')) {
      const job = deserializeShiyingRecordImageJobV1(row.payload_json);
      if (job.status === 'skipped') continue;
      job.status = 'blocked'; job.errorCode = SHIYING_RESTORE_PAUSED;
      await db.runAsync('UPDATE shiying_record_image_jobs SET status=?,last_error_code=?,payload_json=? WHERE record_id=?;',
        job.status, job.errorCode, serializeShiyingRecordImageJobV1(job), job.recordId);
    }
    const task = await readShiyingBackfillTaskWithDatabase(db);
    if (task) {
      const previous = local.backfill;
      const sameInput = previous && sameBackfillInput(task, previous);
      if (sameInput) {
        task.authorizedCalls = Math.max(task.authorizedCalls, previous.authorizedCalls);
        task.usedCalls = Math.max(task.usedCalls, previous.usedCalls);
      }
      if (task.status !== 'completed') {
        task.status = 'paused'; task.lastErrorCode = SHIYING_RESTORE_PAUSED;
        if (sameInput) {
          for (const day of task.days) for (const chunk of day.chunks) {
            const old = previous.days.find(value => value.lifeDate === day.lifeDate)?.chunks
              .find(value => value.operationId === chunk.operationId && value.inputHash === chunk.inputHash);
            if (chunk.status === 'completed' && old) {
              // Keep the saved answer and its timestamps; attempts are device billing history.
              chunk.attemptCount = Math.max(chunk.attemptCount, old.attemptCount);
            } else if (chunk.status !== 'completed' && old && old.attemptCount > 0 &&
              (old.attemptCount > chunk.attemptCount || old.status !== 'pending' || old.lastErrorCode)) {
              chunk.attemptCount = Math.max(chunk.attemptCount, old.attemptCount);
              chunk.startedAt = Math.max(chunk.startedAt ?? 0, old.startedAt ?? 0) || null;
              chunk.lastErrorCode = 'shiying_restore_paid_unknown';
            } else if (chunk.status !== 'completed' && !old && previous.usedCalls > task.days.reduce((sum, value) => sum + value.chunks.reduce((n, unit) => n + unit.attemptCount, 0), 0)) {
              task.lastErrorCode = 'shiying_restore_paid_unknown';
            }
          }
        }
      }
      // An old completed task must not publish a new completion notification.
      if (task.status === 'completed') task.notificationClaimed = true;
      task.revision++;
      await writeShiyingBackfillTaskWithDatabase(db, task);
    }
    await db.execAsync('COMMIT;');
  } catch (error) { await db.execAsync('ROLLBACK;'); throw error; }
}

export async function restoreShiyingBackup(prepared: PreparedShiyingBackup,
  local = prepared.localState) {
  await runShiyingDatabaseMaintenance(async () => {
    await restoreDatabaseFromDisk({ directory: prepared.databaseDirectory, fileName: SHIYING_DATABASE_NAME }, SHIYING_DATABASE_NAME);
    await restoreDirectorySafely(mediaDirectory(), async staging => {
      const absent = new Set(prepared.missing.map(image => image.imageId));
      for (const group of imageGroups(prepared.images)) {
        if (absent.has(group[0].imageId)) continue;
        const target = `${staging}${fileName(group[0])}`;
        await FileSystem.copyAsync({ from: `${prepared.mediaDirectory}${fileName(group[0])}`, to: target });
        await validateImage(target, group[0]);
      }
    });
    const db = await SQLite.openDatabaseAsync(SHIYING_DATABASE_NAME, { useNewConnection: true });
    try { await db.execAsync('PRAGMA foreign_keys=ON;'); await pauseRestoredShiyingTasks(db, local); }
    finally { await db.closeAsync(); }
  });
}
