import type { SQLiteDatabase } from 'expo-sqlite';
import { getMemoryDatabase } from '../memory/memoryStore';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { commitGiftWork, loadGiftView } from './giftStore';
import type { GiftRecord, GiftWorkToken } from './giftTypes';

/** I's internal original choice, not a statement or a successful-read receipt. */
export type GiftEchoReadSelection = {
  giftId: string; giftRevision: number; replyToId: string; attachmentId: string; originalId: string; selectedAt: number;
};
type SelectionRow = {
  gift_id: string; gift_revision: number; reply_to_id: string; attachment_id: string; original_id: string; selected_at: number;
};
const validId = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value === value.trim();
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
  && value >= 0 && Number.isFinite(new Date(value).getTime());
function assertEpoch(token: GiftWorkToken) {
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) throw Error('gift-stale-data-epoch');
}
function assertOpened(gift: GiftRecord) {
  if (gift.deliveryStatus !== 'delivered' || gift.openedAt === null || gift.receptionStatus !== 'opened') throw Error('gift-not-opened');
}
async function current(token: GiftWorkToken) {
  assertEpoch(token);
  const view = await loadGiftView(token.id, 'I');
  assertEpoch(token);
  if (!view || view.gift.revision !== token.revision) throw Error('gift-stale-version');
  if (!view.revealed) throw Error('gift-not-opened');
  assertOpened(view.gift);
  return view.gift;
}
function selection(row: SelectionRow): GiftEchoReadSelection {
  return { giftId: row.gift_id, giftRevision: row.gift_revision, replyToId: row.reply_to_id,
    attachmentId: row.attachment_id, originalId: row.original_id, selectedAt: row.selected_at };
}
async function saved(database: SQLiteDatabase, token: GiftWorkToken, replyToId: string) {
  return database.getFirstAsync<SelectionRow>(
    'SELECT * FROM gift_echo_reads WHERE gift_id=? AND gift_revision=? AND reply_to_id=?', token.id, token.revision, replyToId);
}

/** Pure read. The original work token survives every asynchronous boundary. */
export async function loadGiftEchoReadSelection(token: GiftWorkToken, replyToId: string): Promise<GiftEchoReadSelection | null> {
  const expected = { ...token };
  if (!validId(replyToId)) throw Error('gift-invalid-echo');
  await current(expected);
  const row = await (await getMemoryDatabase()).getFirstAsync<SelectionRow & { target_subject: string; target_origin: string }>(
    `SELECT r.*,e.subject AS target_subject,e.origin AS target_origin FROM gift_echo_reads r
      JOIN gift_echoes e ON e.gift_id=r.gift_id AND e.id=r.reply_to_id
      WHERE r.gift_id=? AND r.gift_revision=? AND r.reply_to_id=?`, expected.id, expected.revision, replyToId);
  const latest = await current(expected);
  assertEpoch(expected);
  if (!row || row.target_subject !== 'you' || row.target_origin !== 'message' || !validTime(row.selected_at)) return null;
  const attachment = latest.attachments.find(item => item.id === row.attachment_id);
  if (!attachment || !('original' in attachment) || !['audio', 'image', 'html'].includes(attachment.kind)
    || attachment.original.id !== row.original_id) return null;
  return selection(row);
}

export async function saveGiftEchoReadSelection(token: GiftWorkToken, input: {
  replyToId: string; attachmentId: string; selectedAt: number;
}): Promise<GiftEchoReadSelection> {
  const expected = { ...token }, value = { replyToId: input.replyToId, attachmentId: input.attachmentId, selectedAt: input.selectedAt };
  if (!validId(value.replyToId) || !validId(value.attachmentId) || !validTime(value.selectedAt)) throw Error('gift-invalid-echo');
  const result = await commitGiftWork(expected, async (transaction, gift) => {
    assertOpened(gift);
    const target = await transaction.getFirstAsync<{ subject: string; origin: string }>(
      'SELECT subject,origin FROM gift_echoes WHERE gift_id=? AND id=?', gift.id, value.replyToId);
    if (!target || target.subject !== 'you' || target.origin !== 'message') throw Error('gift-echo-target-missing');
    const attachment = gift.attachments.find(item => item.id === value.attachmentId);
    if (!attachment || !('original' in attachment) || !['audio', 'image', 'html'].includes(attachment.kind)
      || !validId(attachment.original.id)) throw Error('gift-attachment-not-owned');
    const previous = await saved(transaction, expected, value.replyToId);
    if (previous) {
      if (previous.attachment_id !== attachment.id) throw Error('gift-echo-conflict');
      if (previous.original_id !== attachment.original.id) throw Error('gift-attachment-not-owned');
      await transaction.runAsync('DELETE FROM gift_processing_state WHERE gift_id=? AND gift_revision=? AND stage=?',
        gift.id, gift.revision, `echo-select:${value.replyToId}`);
      return selection(previous);
    }
    if (await transaction.getFirstAsync(`SELECT 1 FROM gift_echoes
      WHERE gift_id=? AND reply_to_id=? AND subject='I' AND origin='reply'`, gift.id, value.replyToId)) throw Error('gift-echo-already-replied');
    const row: SelectionRow = { gift_id: gift.id, gift_revision: gift.revision, reply_to_id: value.replyToId,
      attachment_id: attachment.id, original_id: attachment.original.id, selected_at: value.selectedAt };
    await transaction.runAsync(`INSERT INTO gift_echo_reads(gift_id,gift_revision,reply_to_id,attachment_id,original_id,selected_at)
      VALUES(?,?,?,?,?,?)`, row.gift_id, row.gift_revision, row.reply_to_id, row.attachment_id, row.original_id, row.selected_at);
    await transaction.runAsync('DELETE FROM gift_processing_state WHERE gift_id=? AND gift_revision=? AND stage=?',
      gift.id, gift.revision, `echo-select:${value.replyToId}`);
    return selection(row);
  });
  if (!result.committed) { assertEpoch(expected); throw Error('gift-stale-version'); }
  return result.value;
}
