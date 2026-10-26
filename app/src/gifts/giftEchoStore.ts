import type { SQLiteDatabase } from 'expo-sqlite';
import { getMemoryDatabase } from '../memory/memoryStore';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { commitGiftWork, loadGiftView } from './giftStore';
import type { GiftEcho, GiftEchoThread, GiftRecord, GiftSubject, GiftVersion, GiftWorkToken } from './giftTypes';

type EchoRow = {
  id: string; gift_id: string; gift_revision: number; sequence: number; subject: GiftSubject;
  content: string; created_at: number; origin: GiftEcho['origin']; reply_to_id: string | null;
  attachment_id: string | null; original_id: string | null; read_at: number | null;
};
type ReceiptRow = { attachment_id: string; original_id: string; subject: string; content: string; understood_at: number };

function echo(row: EchoRow): GiftEcho {
  return { id: row.id, giftId: row.gift_id, giftRevision: row.gift_revision, sequence: row.sequence,
    subject: row.subject, content: row.content, createdAt: row.created_at, origin: row.origin,
    replyToId: row.reply_to_id, attachmentId: row.attachment_id, originalId: row.original_id, readAt: row.read_at };
}
function assertEpoch(epoch: number | null) {
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw Error('gift-stale-data-epoch');
}
function assertOpened(gift: GiftRecord) {
  if (gift.deliveryStatus !== 'delivered' || gift.openedAt === null || gift.receptionStatus !== 'opened') throw Error('gift-not-opened');
}
function validId(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && value === value.trim(); }
function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime());
}
function assertText(content: string, createdAt: number) {
  if (typeof content !== 'string' || !content.trim() || !validTime(createdAt)) throw Error('gift-invalid-echo');
}
async function byId(transaction: SQLiteDatabase, giftId: string, id: string) {
  const row = await transaction.getFirstAsync<EchoRow>('SELECT * FROM gift_echoes WHERE gift_id=? AND id=?', giftId, id);
  return row ? echo(row) : null;
}
async function insert(transaction: SQLiteDatabase, value: Omit<GiftEcho, 'sequence'>): Promise<GiftEcho> {
  const next = await transaction.getFirstAsync<{ next: number }>(
    'SELECT COALESCE(MAX(sequence),0)+1 AS next FROM gift_echoes WHERE gift_id=?', value.giftId);
  const result = { ...value, sequence: next!.next };
  await transaction.runAsync(`INSERT INTO gift_echoes(gift_id,id,gift_revision,sequence,subject,content,created_at,origin,
    reply_to_id,attachment_id,original_id,read_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    result.giftId, result.id, result.giftRevision, result.sequence, result.subject, result.content, result.createdAt,
    result.origin, result.replyToId, result.attachmentId, result.originalId, result.readAt);
  return result;
}
async function writeEcho<T>(token: GiftWorkToken, work: (transaction: SQLiteDatabase, gift: GiftRecord) => Promise<T>) {
  const expected = { ...token };
  const result = await commitGiftWork(expected, async (transaction, gift) => { assertOpened(gift); return work(transaction, gift); });
  if (!result.committed) {
    assertEpoch(expected.dataEpoch);
    throw Error('gift-stale-version');
  }
  return result.value;
}

/** Pure read: receipt adoption is an explicit separate operation. */
export async function loadGiftEchoThread(version: GiftVersion, viewer: GiftSubject): Promise<GiftEchoThread> {
  const expected = { ...version }, dataEpoch = captureBackupRestoreDataEpoch();
  assertEpoch(dataEpoch);
  if (viewer !== 'I' && viewer !== 'you') throw Error('gift-invalid-subject');
  const view = await loadGiftView(expected.id, viewer);
  if (!view) throw Error('gift-not-opened');
  if (view.gift.revision !== expected.revision) throw Error('gift-stale-version');
  if (!view.revealed) throw Error('gift-not-opened');
  assertOpened(view.gift);
  const rows = await (await getMemoryDatabase()).getAllAsync<EchoRow>(
    'SELECT * FROM gift_echoes WHERE gift_id=? ORDER BY sequence', expected.id);
  const latest = await loadGiftView(expected.id, viewer);
  assertEpoch(dataEpoch);
  if (!latest) throw Error('gift-not-opened');
  if (latest.gift.revision !== expected.revision) throw Error('gift-stale-version');
  if (!latest.revealed) throw Error('gift-not-opened');
  assertOpened(latest.gift);
  const messages = rows.map(echo), answered = new Set(messages.filter(item => item.subject === 'I' && item.origin === 'reply').map(item => item.replyToId));
  return { token: { ...expected, dataEpoch }, messages,
    pendingYouIds: messages.filter(item => item.subject === 'you' && item.origin === 'message' && !answered.has(item.id)).map(item => item.id) };
}

/** Both native and desktop human ports append only you, regardless of extra caller fields. */
export function appendGiftYouEcho(token: GiftWorkToken, input: { id: string; content: string; createdAt: number }): Promise<GiftEcho> {
  const value = { id: input.id, content: input.content, createdAt: input.createdAt };
  return writeEcho(token, async (transaction, gift) => {
    if (!validId(value.id)) throw Error('gift-invalid-echo');
    assertText(value.content, value.createdAt);
    const previous = await byId(transaction, gift.id, value.id);
    if (previous) {
      if (previous.subject !== 'you' || previous.origin !== 'message' || previous.content !== value.content || previous.createdAt !== value.createdAt) throw Error('gift-echo-conflict');
      return previous;
    }
    return insert(transaction, { ...value, giftId: gift.id, giftRevision: gift.revision, subject: 'you', origin: 'message',
      replyToId: null, attachmentId: null, originalId: null, readAt: null });
  });
}

/** Receipts retain their original words/time, ordered by the saved attachment list. */
export function adoptGiftUnderstandingEchoes(token: GiftWorkToken): Promise<GiftEcho[]> {
  return writeEcho(token, async (transaction, gift) => {
    const rows = await transaction.getAllAsync<ReceiptRow>(
      'SELECT * FROM gift_understanding_receipts WHERE gift_id=? AND gift_revision=?', gift.id, gift.revision);
    for (const row of rows) {
      const attachment = gift.attachments.find(item => item.id === row.attachment_id);
      if (gift.sender !== 'you' || row.subject !== 'I' || !attachment || attachment.kind === 'url' || attachment.kind === 'html'
        || attachment.original.id !== row.original_id) throw Error('gift-attachment-not-owned');
      assertText(row.content, row.understood_at);
    }
    const result: GiftEcho[] = [];
    for (const attachment of gift.attachments) {
      const receipt = rows.find(row => row.attachment_id === attachment.id);
      if (!receipt) continue;
      const id = `gift-understanding:${gift.revision}:${attachment.id}`, previous = await byId(transaction, gift.id, id);
      if (previous) {
        if (previous.subject !== 'I' || previous.origin !== 'understanding' || previous.giftRevision !== gift.revision
          || previous.attachmentId !== attachment.id || previous.originalId !== receipt.original_id
          || previous.content !== receipt.content || previous.createdAt !== receipt.understood_at || previous.readAt !== receipt.understood_at) throw Error('gift-echo-conflict');
        result.push(previous);
      } else result.push(await insert(transaction, { id, giftId: gift.id, giftRevision: gift.revision, subject: 'I',
        content: receipt.content, createdAt: receipt.understood_at, origin: 'understanding', replyToId: null,
        attachmentId: attachment.id, originalId: receipt.original_id, readAt: receipt.understood_at }));
    }
    return result;
  });
}

export function commitGiftEchoReply(token: GiftWorkToken, input: {
  replyToId: string; content: string; createdAt: number; attachmentId?: string; originalId?: string; readAt?: number;
}): Promise<GiftEcho> {
  const value = { ...input };
  return writeEcho(token, async (transaction, gift) => {
    if (!validId(value.replyToId)) throw Error('gift-invalid-echo');
    assertText(value.content, value.createdAt);
    const target = await byId(transaction, gift.id, value.replyToId);
    if (!target || target.subject !== 'you' || target.origin !== 'message') throw Error('gift-echo-target-missing');
    const hasOriginal = value.attachmentId !== undefined || value.originalId !== undefined || value.readAt !== undefined;
    if (hasOriginal) {
      const attachment = gift.attachments.find(item => item.id === value.attachmentId);
      if (!validId(value.attachmentId) || !validId(value.originalId) || !validTime(value.readAt)
        || !attachment || attachment.kind === 'url' || attachment.original.id !== value.originalId) throw Error('gift-attachment-not-owned');
    }
    await transaction.runAsync('DELETE FROM gift_processing_state WHERE gift_id=? AND gift_revision=? AND stage IN (?,?)',
      gift.id, gift.revision, `echo-select:${value.replyToId}`, `echo-read:${value.replyToId}`);
    const row = await transaction.getFirstAsync<EchoRow>('SELECT * FROM gift_echoes WHERE gift_id=? AND reply_to_id=?', gift.id, value.replyToId);
    if (row) return echo(row);
    const id = `gift-reply:${value.replyToId}`;
    if (await byId(transaction, gift.id, id)) throw Error('gift-echo-conflict');
    return insert(transaction, { id, giftId: gift.id, giftRevision: gift.revision, subject: 'I',
      content: value.content, createdAt: value.createdAt, origin: 'reply', replyToId: value.replyToId,
      attachmentId: value.attachmentId ?? null, originalId: value.originalId ?? null, readAt: value.readAt ?? null });
  });
}

export async function listPendingGiftEchoVersions(): Promise<GiftVersion[]> {
  const epoch = captureBackupRestoreDataEpoch(); assertEpoch(epoch);
  const rows = await (await getMemoryDatabase()).getAllAsync<GiftVersion>(`SELECT g.id,g.revision FROM gift_records g
    WHERE json_extract(g.record_json,'$.deliveryStatus')='delivered' AND json_extract(g.record_json,'$.openedAt') IS NOT NULL
      AND json_extract(g.record_json,'$.receptionStatus')='opened' AND EXISTS (
        SELECT 1 FROM gift_echoes m WHERE m.gift_id=g.id AND m.subject='you' AND m.origin='message'
        AND NOT EXISTS (SELECT 1 FROM gift_echoes r WHERE r.gift_id=g.id AND r.reply_to_id=m.id AND r.subject='I' AND r.origin='reply'))
    ORDER BY g.id`);
  assertEpoch(epoch);
  return rows.map(row => ({ id: row.id, revision: row.revision }));
}
