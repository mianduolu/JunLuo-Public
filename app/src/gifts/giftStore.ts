import { randomUUID } from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { getMemoryDatabase } from '../memory/memoryStore';
import { deleteGiftRelationsWithDatabase, type GiftDeletionMode } from './giftDeletion';
import { emitGiftChanges } from './giftEvents';
import { notifyAutomaticDataSyncWorkAvailable } from '../sync/automaticDataSyncEvents';
import { collectGiftOriginalFiles, copyGiftOriginal, deletePreparedGiftOriginals, giftOriginals } from './giftFiles';
import {
  giftViewFor, type GiftAttachment, type GiftDraftContents, type GiftOriginal, type GiftRecord,
  type GiftSaveResult, type GiftSubject, type GiftVersion, type GiftWorkToken, type GiftView, type GiftReceptionDecision,
  type GiftSupplementAttachmentInput,
} from './giftTypes';

type GiftRow = { id: string; revision: number; record_json: string };
let writer: Promise<unknown> = Promise.resolve();

function assertEpoch(epoch: number | null) {
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('gift-stale-data-epoch');
}

function write<T>(epoch: number | null, work: () => Promise<T>, notifySync = true): Promise<T> {
  const pending = writer.catch(() => undefined).then(async () => {
    const result = await runBackupRestoreDataEpochCommit(epoch, work);
    if (!result.committed) throw new Error('gift-stale-data-epoch');
    if (notifySync) notifyAutomaticDataSyncWorkAvailable();
    return result.value;
  });
  writer = pending;
  return pending;
}

/** Sync projections share the existing gift writer and restore lease. */
export function withGiftStoreWrite<T>(work: () => Promise<T>): Promise<T> {
  return write(captureBackupRestoreDataEpoch(), work, false);
}

function fromRow(row: GiftRow): GiftRecord {
  const gift = JSON.parse(row.record_json) as GiftRecord;
  if (gift.id !== row.id || gift.revision !== row.revision || !['I', 'you'].includes(gift.sender)) {
    throw new Error('gift-invalid-record');
  }
  return { ...gift, receptionDecidedAt: gift.receptionDecidedAt ?? null,
    receptionNextAt: gift.receptionNextAt ?? null, receptionTimeZone: gift.receptionTimeZone ?? null };
}

async function read(database: SQLiteDatabase, id: string): Promise<GiftRecord | null> {
  const row = await database.getFirstAsync<GiftRow>('SELECT * FROM gift_records WHERE id = ?', id);
  return row ? fromRow(row) : null;
}

async function current(database: SQLiteDatabase, version: GiftVersion) {
  const gift = await read(database, version.id);
  if (!gift || gift.revision !== version.revision) throw new Error('gift-stale-version');
  return gift;
}

function assertEditable(gift: GiftRecord) {
  if (gift.openedAt !== null || gift.receptionStatus === 'opened') throw new Error('gift-original-frozen');
  if (gift.deliveryStatus === 'delivered') throw new Error('gift-withdraw-before-edit');
  if (gift.deliveryStatus === 'scheduled') throw new Error('gift-cancel-before-edit');
}

async function persist(database: SQLiteDatabase, gift: GiftRecord, epoch: number | null) {
  assertEpoch(epoch);
  const next = { ...gift, revision: gift.revision + 1, updatedAt: Date.now() };
  const result = await database.runAsync(
    'UPDATE gift_records SET revision = ?, record_json = ? WHERE id = ? AND revision = ?',
    next.revision, JSON.stringify(next), gift.id, gift.revision,
  );
  if (result.changes !== 1) throw new Error('gift-stale-version');
  assertEpoch(epoch);
  return next;
}

async function collect(database: SQLiteDatabase) {
  try {
    const rows = await database.getAllAsync<GiftRow>('SELECT * FROM gift_records');
    return await collectGiftOriginalFiles(new Set(rows.flatMap(row => giftOriginals(fromRow(row))).map(item => item.storageName)));
  } catch {
    // Saving/deleting has already committed. A failed scan is a cleanup failure,
    // not a failed business write; no files are removed without known references.
    return { deleted: 0, failed: 1 };
  }
}

export async function loadGift(id: string) {
  return read(await getMemoryDatabase(), id);
}

export async function loadGiftView(id: string, viewer: GiftSubject) {
  const gift = await loadGift(id);
  return gift ? giftViewFor(gift, viewer) : null;
}

export async function listGiftViews(viewer: GiftSubject): Promise<GiftView[]> {
  const rows = await (await getMemoryDatabase()).getAllAsync<GiftRow>('SELECT * FROM gift_records');
  return rows.map(fromRow).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .map(gift => giftViewFor(gift, viewer)).filter((gift): gift is GiftView => gift !== null);
}

export function createGiftDraft(sender: GiftSubject): Promise<GiftRecord> {
  const epoch = captureBackupRestoreDataEpoch();
  return write(epoch, async () => {
    if (sender !== 'I' && sender !== 'you') throw new Error('gift-invalid-sender');
    const now = Date.now();
    const gift: GiftRecord = { id: `gift-${randomUUID()}`, revision: 1, sender, title: '', note: '',
      cover: null, attachments: [], deliveryStatus: 'draft', receptionStatus: 'unopened',
      scheduledAt: null, scheduledTimeZone: null, deliveredAt: null, openedAt: null,
      receptionDecidedAt: null, receptionNextAt: null, receptionTimeZone: null,
      createdAt: now, updatedAt: now };
    const database = await getMemoryDatabase();
    await database.withExclusiveTransactionAsync(async transaction => {
      assertEpoch(epoch);
      await transaction.runAsync('INSERT INTO gift_records(id, revision, record_json) VALUES (?, ?, ?)',
        gift.id, gift.revision, JSON.stringify(gift));
      assertEpoch(epoch);
    });
    return gift;
  });
}

export function saveGiftDraft(version: GiftVersion, contents: GiftDraftContents): Promise<GiftSaveResult> {
  const epoch = captureBackupRestoreDataEpoch();
  // Snapshot caller-owned arrays before waiting for the writer or file IO.
  const input = JSON.parse(JSON.stringify(contents)) as GiftDraftContents;
  const expected = { ...version };
  return write(epoch, async () => {
    const database = await getMemoryDatabase();
    const previous = await current(database, expected);
    assertEditable(previous);
    if (input.deliveryPlan && (!Number.isFinite(input.deliveryPlan.at) || input.deliveryPlan.at <= 0
      || !input.deliveryPlan.timeZone.trim())) throw new Error('gift-invalid-time');
    const prepared: GiftOriginal[] = [];
    let saved: GiftRecord;
    try {
      let cover: GiftOriginal | null = null;
      if (input.cover) {
        if ('existingOriginalId' in input.cover) {
          const id = input.cover.existingOriginalId;
          cover = giftOriginals(previous).find(item => item.id === id) ?? null;
          if (!cover) throw new Error('gift-original-not-owned');
        } else {
          if (!input.cover.file.mimeType.toLowerCase().startsWith('image/')) throw new Error('gift-invalid-cover');
          cover = await copyGiftOriginal(input.cover.file); prepared.push(cover);
        }
        if (!cover.mimeType.toLowerCase().startsWith('image/')) throw new Error('gift-invalid-cover');
      }
      const attachments: GiftAttachment[] = [];
      for (const item of input.attachments) {
        assertEpoch(epoch);
        if ('existingId' in item) {
          const existing = previous.attachments.find(attachment => attachment.id === item.existingId);
          if (!existing) throw new Error('gift-attachment-not-owned');
          attachments.push(existing);
        } else if (item.kind === 'url') {
          let url: URL;
          try { url = new URL(item.url); } catch { throw new Error('gift-invalid-url'); }
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('gift-invalid-url');
          attachments.push({ id: `gift-item-${randomUUID()}`, kind: 'url', url: item.url });
        } else {
          if (!['image', 'audio', 'html'].includes(item.kind)) throw new Error('gift-invalid-attachment');
          const original = await copyGiftOriginal(item.file);
          prepared.push(original);
          attachments.push({ id: `gift-item-${randomUUID()}`, kind: item.kind, original });
        }
      }
      if (new Set(attachments.map(item => item.id)).size !== attachments.length) throw new Error('gift-duplicate-attachment');
      await database.withExclusiveTransactionAsync(async transaction => {
        const latest = await current(transaction, expected);
        assertEditable(latest);
        saved = await persist(transaction, { ...latest, title: input.title, note: input.note, cover, attachments,
          scheduledAt: input.deliveryPlan === undefined ? latest.scheduledAt : input.deliveryPlan?.at ?? null,
          scheduledTimeZone: input.deliveryPlan === undefined ? latest.scheduledTimeZone : input.deliveryPlan?.timeZone ?? null,
        }, epoch);
        await transaction.runAsync(`DELETE FROM gift_attachment_activity WHERE gift_id = ?
          AND attachment_id NOT IN (SELECT value FROM json_each(?))`, latest.id, JSON.stringify(attachments.map(item => item.id)));
      });
    } catch (error) {
      // The shared lease still holds: restoration has not replaced these unique files.
      await deletePreparedGiftOriginals(prepared);
      throw error;
    }
    return { gift: saved!, collection: await collect(database) };
  });
}

/** Append only: the opened version, its work tokens and existing memories remain valid. */
export function appendGiftAttachments(version: GiftVersion, sender: GiftSubject,
  attachments: readonly GiftSupplementAttachmentInput[]): Promise<GiftSaveResult> {
  const epoch = captureBackupRestoreDataEpoch();
  const expected = { ...version };
  const input = JSON.parse(JSON.stringify(attachments)) as GiftSupplementAttachmentInput[];
  return write(epoch, async () => {
    const database = await getMemoryDatabase();
    const check = (gift: GiftRecord) => {
      if (gift.sender !== sender || !['I', 'you'].includes(sender)) throw Error('gift-sender-only');
      if (gift.deliveryStatus !== 'delivered' || gift.receptionStatus !== 'opened' || gift.openedAt === null) throw Error('gift-not-opened');
    };
    check(await current(database, expected));
    if (!Array.isArray(input) || !input.length) throw Error('gift-empty-supplement');
    const prepared: GiftOriginal[] = [], additions: GiftAttachment[] = [];
    let saved: GiftRecord;
    try {
      for (const item of input) {
        assertEpoch(epoch);
        if (!item || 'existingId' in item) throw Error('gift-invalid-attachment');
        if (item.kind === 'url') {
          let url: URL;
          try { url = new URL(item.url); } catch { throw Error('gift-invalid-url'); }
          if (!['http:', 'https:'].includes(url.protocol)) throw Error('gift-invalid-url');
          additions.push({ id: `gift-item-${randomUUID()}`, kind: 'url', url: item.url });
        } else {
          if (!['image', 'audio', 'html'].includes(item.kind)) throw Error('gift-invalid-attachment');
          const original = await copyGiftOriginal(item.file); prepared.push(original);
          additions.push({ id: `gift-item-${randomUUID()}`, kind: item.kind, original });
        }
      }
      await database.withExclusiveTransactionAsync(async transaction => {
        const latest = await current(transaction, expected); check(latest); assertEpoch(epoch);
        saved = { ...latest, attachments: [...latest.attachments, ...additions],
          supplementalAttachmentIds: [...(latest.supplementalAttachmentIds ?? []), ...additions.map(item => item.id)],
          updatedAt: Date.now() };
        const result = await transaction.runAsync(
          'UPDATE gift_records SET record_json = ? WHERE id = ? AND revision = ?',
          JSON.stringify(saved), latest.id, latest.revision);
        if (result.changes !== 1) throw Error('gift-stale-version');
        assertEpoch(epoch);
      });
    } catch (error) {
      await deletePreparedGiftOriginals(prepared);
      throw error;
    }
    emitGiftChanges();
    return { gift: saved!, collection: await collect(database) };
  });
}

/** Storage facts only. No scheduling, model request or recipient decision runs here. */
export function recordGiftDelivery(version: GiftVersion, deliveredAt = Date.now()) {
  return changeState(version, gift => {
    assertEditable(gift);
    if (!gift.title.trim() || !gift.attachments.length) throw new Error('gift-not-ready');
    if (!Number.isFinite(deliveredAt)) throw new Error('gift-invalid-time');
    return { ...gift, deliveryStatus: 'delivered', receptionStatus: 'unopened', deliveredAt,
      receptionDecidedAt: null, receptionNextAt: null, receptionTimeZone: null };
  });
}

export function scheduleGiftDelivery(version: GiftVersion): Promise<GiftRecord> {
  return changeState(version, gift => {
    if (gift.openedAt !== null || gift.receptionStatus === 'opened') throw Error('gift-original-frozen');
    if (gift.deliveryStatus === 'delivered') throw Error('gift-withdraw-before-edit');
    if (gift.deliveryStatus === 'scheduled') throw Error('gift-cancel-before-edit');
    if (!gift.title.trim() || !gift.attachments.length) throw Error('gift-not-ready');
    if (gift.scheduledAt === null || !Number.isFinite(gift.scheduledAt) || gift.scheduledAt <= 0
      || !Number.isFinite(new Date(gift.scheduledAt).getTime())
      || !gift.scheduledTimeZone?.trim()) throw Error('gift-invalid-time');
    try { new Intl.DateTimeFormat('en', { timeZone: gift.scheduledTimeZone }); }
    catch { throw Error('gift-invalid-time'); }
    return { ...gift, deliveryStatus: 'scheduled' };
  });
}

export function cancelGiftSchedule(version: GiftVersion): Promise<GiftRecord> {
  return changeState(version, gift => {
    if (gift.deliveryStatus !== 'scheduled') throw Error('gift-not-scheduled');
    return { ...gift, deliveryStatus: 'draft' };
  });
}

export async function deliverDueGift(token: GiftWorkToken, now: number): Promise<GiftRecord | null> {
  if (!Number.isFinite(now) || now <= 0 || !Number.isFinite(new Date(now).getTime())) throw Error('gift-invalid-time');
  const expected = { ...token };
  const result = await commitGiftWork(expected, async (transaction, gift) => {
    if (gift.deliveryStatus !== 'scheduled' || gift.scheduledAt === null || gift.scheduledAt > now) return null;
    if (gift.openedAt !== null || !gift.title.trim() || !gift.attachments.length) throw Error('gift-not-ready');
    return persist(transaction, { ...gift, deliveryStatus: 'delivered', receptionStatus: 'unopened', deliveredAt: now,
      receptionDecidedAt: null, receptionNextAt: null, receptionTimeZone: null }, expected.dataEpoch);
  });
  return result.committed ? result.value : null;
}

export async function recordGiftReceptionDecision(token: GiftWorkToken, decision: GiftReceptionDecision,
  decidedAt = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Promise<GiftRecord> {
  const input = { ...decision };
  const expected = { ...token };
  if (!Number.isFinite(decidedAt) || decidedAt <= 0 || !Number.isFinite(new Date(decidedAt).getTime()) || !timeZone?.trim()
    || !['open', 'later', 'decline'].includes(input.choice)) throw Error('gift-invalid-reception');
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { throw Error('gift-invalid-reception'); }
  let nextAt: number | null = null;
  if (input.choice === 'later') {
    if (!Number.isSafeInteger(input.reconsiderAfterMinutes) || input.reconsiderAfterMinutes! <= 0) throw Error('gift-invalid-reception');
    nextAt = decidedAt + input.reconsiderAfterMinutes! * 60_000;
    if (!Number.isFinite(nextAt) || nextAt <= decidedAt || !Number.isFinite(new Date(nextAt).getTime())) throw Error('gift-invalid-reception');
  } else if (input.reconsiderAfterMinutes !== null) throw Error('gift-invalid-reception');
  const result = await commitGiftWork(expected, async (transaction, gift) => {
    if (gift.sender !== 'you') throw Error('gift-recipient-only');
    if (gift.deliveryStatus !== 'delivered') throw Error('gift-not-delivered');
    if (gift.openedAt !== null || gift.receptionStatus === 'opened') throw Error('gift-already-opened');
    if (gift.receptionStatus === 'declined') throw Error('gift-reception-declined');
    if (gift.receptionStatus === 'deferred' && gift.receptionNextAt != null && gift.receptionNextAt > decidedAt) {
      throw Error('gift-reception-not-due');
    }
    return persist(transaction, { ...gift, receptionStatus: input.choice === 'open' ? 'opened'
      : input.choice === 'later' ? 'deferred' : 'declined', openedAt: input.choice === 'open' ? decidedAt : null,
      receptionDecidedAt: decidedAt, receptionNextAt: nextAt, receptionTimeZone: timeZone }, expected.dataEpoch);
  });
  if (!result.committed) throw Error(canCommitBackupRestoreDataEpoch(expected.dataEpoch) ? 'gift-stale-version' : 'gift-stale-data-epoch');
  return result.value;
}

export function withdrawGiftDelivery(version: GiftVersion) {
  return changeState(version, gift => {
    if (gift.openedAt !== null || gift.receptionStatus === 'opened') throw new Error('gift-original-frozen');
    if (gift.deliveryStatus !== 'delivered') throw new Error('gift-not-delivered');
    return { ...gift, deliveryStatus: 'withdrawn', receptionStatus: 'unopened',
      receptionDecidedAt: null, receptionNextAt: null, receptionTimeZone: null };
  });
}

export function recordGiftOpening(version: GiftVersion, openedAt = Date.now()) {
  return changeState(version, gift => {
    if (gift.deliveryStatus !== 'delivered') throw new Error('gift-not-delivered');
    if (gift.openedAt !== null) throw new Error('gift-already-opened');
    if (!Number.isFinite(openedAt)) throw new Error('gift-invalid-time');
    return { ...gift, receptionStatus: 'opened', openedAt };
  });
}

function changeState(version: GiftVersion, change: (gift: GiftRecord) => GiftRecord) {
  const epoch = captureBackupRestoreDataEpoch();
  const expected = { ...version };
  return write(epoch, async () => {
    const database = await getMemoryDatabase();
    let saved: GiftRecord;
    await database.withExclusiveTransactionAsync(async transaction => {
      saved = await persist(transaction, change(await current(transaction, expected)), epoch);
    });
    return saved!;
  });
}

/** The editor's automatic cleanup may still delete only its own editable draft. */
export function deleteGiftDraft(version: GiftVersion) {
  const epoch = captureBackupRestoreDataEpoch();
  const expected = { ...version };
  return write(epoch, async () => {
    const database = await getMemoryDatabase();
    await database.withExclusiveTransactionAsync(async transaction => {
      assertEditable(await current(transaction, expected));
      assertEpoch(epoch);
      const result = await transaction.runAsync('DELETE FROM gift_records WHERE id = ? AND revision = ?', expected.id, expected.revision);
      if (result.changes !== 1) throw new Error('gift-stale-version');
      await transaction.runAsync('DELETE FROM gift_attachment_activity WHERE gift_id = ?', expected.id);
      await transaction.runAsync('DELETE FROM gift_processing_state WHERE gift_id = ?', expected.id);
      await transaction.runAsync('DELETE FROM gift_understanding_receipts WHERE gift_id = ?', expected.id);
      await transaction.runAsync('DELETE FROM gift_echoes WHERE gift_id = ?', expected.id);
      await transaction.runAsync('DELETE FROM gift_echo_reads WHERE gift_id = ?', expected.id);
      assertEpoch(epoch);
    });
    return collect(database);
  });
}

/** Explicit cabinet deletion is available before or after delivery/opening. */
export function deleteGift(version: GiftVersion, mode: GiftDeletionMode) {
  const epoch = captureBackupRestoreDataEpoch(), expected = { ...version };
  return write(epoch, async () => {
    if (!['keep-memory', 'delete-related-memory'].includes(mode)) throw Error('gift-invalid-deletion-mode');
    const { runMemoryDuplicateCleanupBusinessWrite } = await import('../memory/memoryDuplicateCleanupState');
    const { setGiftSyncDeleteMode } = await import('../sync/syncGiftsSql');
    const database = await getMemoryDatabase();
    const removed = await runMemoryDuplicateCleanupBusinessWrite(async () => {
      let result: Awaited<ReturnType<typeof deleteGiftRelationsWithDatabase>>;
      await database.withExclusiveTransactionAsync(async transaction => {
        await current(transaction, expected);
        assertEpoch(epoch);
        await setGiftSyncDeleteMode(transaction, mode);
        const deletion = await transaction.runAsync('DELETE FROM gift_records WHERE id = ? AND revision = ?', expected.id, expected.revision);
        await setGiftSyncDeleteMode(transaction, 'keep-memory');
        if (deletion.changes !== 1) throw Error('gift-stale-version');
        result = await deleteGiftRelationsWithDatabase(transaction, expected.id, mode);
        assertEpoch(epoch);
      });
      return result!;
    });
    const collection = await collect(database);
    emitGiftChanges();
    return { ...removed, collection };
  });
}

export function collectUnusedGiftOriginals() {
  const epoch = captureBackupRestoreDataEpoch();
  return write(epoch, async () => collect(await getMemoryDatabase()));
}

/** Capture before starting asynchronous/model work, never again at its completion. */
export async function captureGiftWork(id: string): Promise<GiftWorkToken | null> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const gift = await loadGift(id);
  assertEpoch(dataEpoch);
  return gift ? { id: gift.id, revision: gift.revision, dataEpoch } : null;
}

/** Commit only SQLite writes here; the model runs outside the writer/restore lease.
 * Use the supplied transaction, not the queued main database connection.
 */
export function commitGiftWork<T>(token: GiftWorkToken,
  commit: (transaction: SQLiteDatabase, gift: GiftRecord) => Promise<T>,
): Promise<{ committed: true; value: T } | { committed: false }> {
  const expected = { ...token };
  return write(expected.dataEpoch, async () => {
    const database = await getMemoryDatabase();
    let value: T;
    await database.withExclusiveTransactionAsync(async transaction => {
      const gift = await current(transaction, expected);
      assertEpoch(expected.dataEpoch);
      value = await commit(transaction, gift);
      assertEpoch(expected.dataEpoch);
    });
    return { committed: true as const, value: value! };
  }).catch(error => {
    if (error instanceof Error && ['gift-stale-data-epoch', 'gift-stale-version'].includes(error.message)) {
      return { committed: false as const };
    }
    throw error;
  });
}
