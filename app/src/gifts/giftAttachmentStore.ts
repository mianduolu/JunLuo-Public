import type { SQLiteDatabase } from 'expo-sqlite';
import { getMemoryDatabase } from '../memory/memoryStore';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { captureGiftWork, commitGiftWork, loadGiftView } from './giftStore';
import { giftViewFor, type GiftAttachment, type GiftAttachmentAccess, type GiftAttachmentActivity,
  type GiftAttachmentToken, type GiftSubject, type GiftVersion, type GiftWebProgress } from './giftTypes';

const empty = (): GiftAttachmentActivity => ({ revision: 0,
  progress: { state: null, storage: {}, summary: '' }, progressUpdatedAt: null, lastPlayedAt: null });

async function readActivity(database: SQLiteDatabase, token: GiftAttachmentToken): Promise<GiftAttachmentActivity> {
  const row = await database.getFirstAsync<{ record_json: string }>(
    'SELECT record_json FROM gift_attachment_activity WHERE gift_id = ? AND attachment_id = ? AND viewer = ?',
    token.id, token.attachmentId, token.viewer);
  return row ? JSON.parse(row.record_json) as GiftAttachmentActivity : empty();
}

export async function openGiftAttachment(version: GiftVersion, attachmentId: string, viewer: GiftSubject): Promise<GiftAttachmentAccess> {
  const work = await captureGiftWork(version.id);
  if (!work || work.revision !== version.revision) throw Error('gift-stale-version');
  const token = { ...work, attachmentId, viewer };
  const view = await loadGiftView(version.id, viewer);
  if (!view?.revealed) throw Error('gift-not-opened');
  const attachment = view.gift.attachments.find(item => item.id === attachmentId);
  if (!attachment) throw Error('gift-attachment-not-owned');
  const activity = await readActivity(await getMemoryDatabase(), token);
  const latest = await loadGiftView(version.id, viewer);
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) throw Error('gift-stale-data-epoch');
  if (!latest?.revealed || latest.gift.revision !== version.revision) throw Error('gift-stale-version');
  return { token, attachment, activity };
}

export function normalizeGiftWebProgress(value: GiftWebProgress): GiftWebProgress {
  if (!value || typeof value.summary !== 'string' || !value.storage || typeof value.storage !== 'object'
    || Array.isArray(value.storage) || Object.values(value.storage).some(item => typeof item !== 'string')) throw Error('gift-invalid-progress');
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw Error('gift-invalid-progress'); }
  const result = JSON.parse(serialized) as GiftWebProgress;
  if (!Object.hasOwn(result, 'state')) throw Error('gift-invalid-progress');
  return { state: result.state, storage: result.storage, summary: result.summary };
}

async function updateActivity(token: GiftAttachmentToken, expectedRevision: number | null,
  update: (activity: GiftAttachmentActivity, attachment: GiftAttachment) => GiftAttachmentActivity) {
  const result = await commitGiftWork(token, async (transaction, gift) => {
    const view = giftViewFor(gift, token.viewer);
    if (!view?.revealed) throw Error('gift-not-opened');
    const attachment = gift.attachments.find(item => item.id === token.attachmentId);
    if (!attachment) throw Error('gift-attachment-not-owned');
    const previous = await readActivity(transaction, token);
    if (expectedRevision !== null && previous.revision !== expectedRevision) throw Error('gift-progress-conflict');
    const next = { ...update(previous, attachment), revision: previous.revision + 1 };
    await transaction.runAsync(`INSERT INTO gift_attachment_activity(gift_id,attachment_id,viewer,revision,record_json)
      VALUES(?,?,?,?,?) ON CONFLICT(gift_id,attachment_id,viewer) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json`,
      token.id, token.attachmentId, token.viewer, next.revision, JSON.stringify(next));
    return next;
  });
  if (!result.committed) throw Error('gift-stale-version');
  return result.value;
}

/** Only call after the local player confirms actual playback. Reading bytes never records playback. */
export function recordGiftPlayback(token: GiftAttachmentToken) {
  return updateActivity(token, null, (activity, attachment) => {
    if (attachment.kind !== 'audio') throw Error('gift-invalid-attachment');
    return { ...activity, lastPlayedAt: Date.now() };
  });
}

export function saveGiftWebProgress(token: GiftAttachmentToken, revision: number, value: GiftWebProgress) {
  const progress = normalizeGiftWebProgress(value);
  return updateActivity(token, revision, (activity, attachment) => {
    if (attachment.kind !== 'html') throw Error('gift-invalid-attachment');
    return { ...activity, progress, progressUpdatedAt: Date.now() };
  });
}

export function resetGiftWebProgress(token: GiftAttachmentToken, revision: number) {
  return saveGiftWebProgress(token, revision, { state: null, storage: {}, summary: '' });
}
