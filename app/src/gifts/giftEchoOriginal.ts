import type { SQLiteDatabase } from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { getMemoryDatabase } from '../memory/memoryStore';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { assertAudioInputSize, audioOriginalFormat, type AudioInputAdapter } from '../ai/audioInputCompatibility';
import { giftOriginalUri } from './giftFiles';
import type { GiftRecord, GiftWorkToken } from './giftTypes';

export function assertGiftEchoEpoch(token: GiftWorkToken) {
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) throw Error('gift-stale-data-epoch');
}

/** Re-reading supports either sender, after an actual opening. No playback or opening action. */
export async function currentGiftEchoGift(token: GiftWorkToken, database?: SQLiteDatabase): Promise<GiftRecord> {
  assertGiftEchoEpoch(token);
  const row = await (database ?? await getMemoryDatabase()).getFirstAsync<{ revision: number; record_json: string }>(
    'SELECT revision,record_json FROM gift_records WHERE id=?', token.id);
  assertGiftEchoEpoch(token);
  if (!row || row.revision !== token.revision) throw Error('gift-stale-version');
  const gift = JSON.parse(row.record_json) as GiftRecord;
  if (gift.id !== token.id || gift.revision !== token.revision) throw Error('gift-stale-version');
  if (gift.deliveryStatus !== 'delivered' || gift.receptionStatus !== 'opened' || gift.openedAt === null) throw Error('gift-not-opened');
  return gift;
}

export async function inspectGiftEchoOriginal(token: GiftWorkToken, attachmentId: string, adapter: AudioInputAdapter) {
  const gift = await currentGiftEchoGift(token);
  const attachment = gift.attachments.find(item => item.id === attachmentId);
  if (!attachment || attachment.kind === 'url') throw Error('gift-attachment-not-owned');
  const original = attachment.original;
  const format = attachment.kind === 'audio' ? audioOriginalFormat(original, adapter) : undefined;
  if (attachment.kind === 'audio') assertAudioInputSize(original.byteSize);
  if (attachment.kind === 'image' && !/^image\/(?:png|jpe?g|gif|webp)$/i.test(original.mimeType)) throw Error('gift-image-format-unsupported');
  const uri = giftOriginalUri(original), info = await FileSystem.getInfoAsync(uri);
  if (!info.exists || info.isDirectory || info.size < 1) throw Error('gift-original-missing');
  if (info.size !== original.byteSize) throw Error('gift-original-changed');
  await currentGiftEchoGift(token); assertGiftEchoEpoch(token);
  return { gift, attachment, uri, format };
}

export async function readGiftEchoOriginal(token: GiftWorkToken, attachmentId: string, adapter: AudioInputAdapter) {
  const source = await inspectGiftEchoOriginal(token, attachmentId, adapter);
  if (source.attachment.kind === 'html') {
    const content = await FileSystem.readAsStringAsync(source.uri, { encoding: FileSystem.EncodingType.UTF8 });
    await inspectGiftEchoOriginal(token, attachmentId, adapter); assertGiftEchoEpoch(token);
    let through = Math.min(12000, content.length);
    if (through < content.length && /[\uD800-\uDBFF]/.test(content[through - 1])) through--;
    return { ...source, html: { from: 0, through, total: content.length, content: content.slice(0, through) }, media: undefined };
  }
  const base64 = await FileSystem.readAsStringAsync(source.uri, { encoding: FileSystem.EncodingType.Base64 });
  await inspectGiftEchoOriginal(token, attachmentId, adapter); assertGiftEchoEpoch(token);
  if (base64.length !== Math.ceil(source.attachment.original.byteSize / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw Error('gift-original-changed');
  return { ...source, html: undefined, media: { kind: source.attachment.kind,
    mimeType: source.attachment.original.mimeType, base64, format: source.format } };
}
