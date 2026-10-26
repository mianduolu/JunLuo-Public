import * as FileSystem from 'expo-file-system/legacy';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { assertAudioInputSize, audioOriginalFormat, type AudioInputAdapter } from '../ai/audioInputCompatibility';
import { giftOriginalUri } from './giftFiles';
import { loadGiftView } from './giftStore';
import type { GiftWorkToken } from './giftTypes';

/** Current source only. Reading never opens a gift or records loudspeaker playback. */
export async function currentGiftUnderstandingSource(sourceToken: GiftWorkToken, attachmentId: string) {
  const token = { ...sourceToken };
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) throw Error('gift-stale-data-epoch');
  const view = await loadGiftView(token.id, 'I');
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) throw Error('gift-stale-data-epoch');
  if (!view || view.gift.revision !== token.revision) throw Error('gift-stale-version');
  if (!view.revealed || view.gift.sender !== 'you' || view.gift.deliveryStatus !== 'delivered'
    || view.gift.openedAt === null) throw Error('gift-not-opened');
  const attachment = view.gift.attachments.find(item => item.id === attachmentId);
  if (!attachment) throw Error('gift-attachment-not-owned');
  if (attachment.kind !== 'audio' && attachment.kind !== 'image') throw Error('gift-invalid-attachment');
  return { gift: view.gift, attachment };
}

export async function readGiftOriginalMedia(sourceToken: GiftWorkToken, attachmentId: string, adapter: AudioInputAdapter) {
  const token = { ...sourceToken };
  const source = await currentGiftUnderstandingSource(token, attachmentId);
  const { attachment } = source;
  const original = attachment.original;
  const format = attachment.kind === 'audio' ? audioOriginalFormat(original, adapter) : undefined;
  if (attachment.kind === 'audio') assertAudioInputSize(original.byteSize);
  if (attachment.kind === 'image' && !/^image\/(?:png|jpe?g|gif|webp)$/i.test(original.mimeType)) {
    throw Error('gift-image-format-unsupported');
  }
  const uri = giftOriginalUri(original);
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists || info.isDirectory || info.size < 1) throw Error('gift-original-missing');
  if (info.size !== original.byteSize) throw Error('gift-original-changed');
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  // Recheck after the asynchronous read, including restored data with the same IDs.
  await currentGiftUnderstandingSource(token, attachmentId);
  if (base64.length !== Math.ceil(original.byteSize / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw Error('gift-original-changed');
  }
  return { ...source, base64, format };
}
