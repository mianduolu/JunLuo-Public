import * as FileSystem from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';
import { copyFileSafely } from '../storage/safeFileWrite';
import type { GiftAttachment, GiftFileSource, GiftOriginal, GiftRecord } from './giftTypes';

const ORIGINAL_NAME = /^gift-original-[0-9a-f-]{36}(?:\.[a-z0-9]{1,16})?$/;

function directory() {
  if (!FileSystem.documentDirectory) throw new Error('gift-storage-unavailable');
  return `${FileSystem.documentDirectory}gift-originals/`;
}

export function giftOriginalUri(original: Pick<GiftOriginal, 'storageName'>) {
  if (!ORIGINAL_NAME.test(original.storageName)) throw new Error('gift-invalid-original-path');
  return `${directory()}${original.storageName}`;
}

export function giftOriginals(gift: Pick<GiftRecord, 'cover' | 'attachments'>): GiftOriginal[] {
  return [gift.cover, ...gift.attachments.map((item: GiftAttachment) => item.kind === 'url' ? null : item.original)]
    .filter((item): item is GiftOriginal => item !== null);
}

/** Only called inside the gift writer and the existing restore shared lease. */
export async function copyGiftOriginal(source: GiftFileSource): Promise<GiftOriginal> {
  if (!source.uri.trim() || !source.name.trim() || !source.mimeType.trim()) {
    throw new Error('gift-invalid-original');
  }
  const id = randomUUID();
  const extension = /\.([a-z0-9]{1,16})$/i.exec(source.name)?.[1].toLowerCase();
  const storageName = `gift-original-${id}${extension ? `.${extension}` : ''}`;
  const uri = giftOriginalUri({ storageName });
  try {
    await copyFileSafely({ from: source.uri, to: uri, minimumBytes: 1 });
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || info.isDirectory || info.size < 1) throw new Error('gift-original-missing');
    return { id, storageName, originalName: source.name, mimeType: source.mimeType, byteSize: info.size };
  } catch (error) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
    throw error;
  }
}

/** Callers hold the same lease/writer used by import; unrelated directories are never scanned. */
export async function collectGiftOriginalFiles(keptNames: ReadonlySet<string>) {
  const dir = directory();
  if (!(await FileSystem.getInfoAsync(dir)).exists) return { deleted: 0, failed: 0 };
  let deleted = 0, failed = 0;
  for (const name of await FileSystem.readDirectoryAsync(dir)) {
    const originalName = name.replace(/\.junluo-(?:safe|rollback)-[^/\\]+$/, '');
    if (keptNames.has(name) || !ORIGINAL_NAME.test(originalName)) continue;
    const uri = `${dir}${name}`;
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists || info.isDirectory) continue;
      await FileSystem.deleteAsync(uri, { idempotent: true });
      deleted += 1;
    } catch { failed += 1; }
  }
  return { deleted, failed };
}

export async function deletePreparedGiftOriginals(originals: readonly GiftOriginal[]) {
  for (const original of originals) {
    await FileSystem.deleteAsync(giftOriginalUri(original), { idempotent: true }).catch(() => undefined);
  }
}
