import * as FileSystem from 'expo-file-system/legacy';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { GiftOriginal } from '../gifts/giftTypes';
import { restoreDirectorySafely } from '../storage/safeFileWrite';
import { captureBackupMediaFileStrict } from './backupMediaSnapshot';

export const GIFT_ORIGINALS_BACKUP_FOLDER = 'gift-originals';
export const GIFT_ORIGINALS_BACKUP_PREFIX = `JunLuo/files/${GIFT_ORIGINALS_BACKUP_FOLDER}/`;
const ORIGINAL_NAME = /^gift-original-[0-9a-f-]{36}(?:\.[a-z0-9]{1,16})?$/;

/** Read the captured database, never the live gift store or synchronization cache. */
export async function readGiftBackupOriginals(db: SQLiteDatabase): Promise<GiftOriginal[]> {
  if (!await db.getFirstAsync("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gift_records'")) return [];
  const originals = new Map<string, GiftOriginal>();
  const add = (value: unknown) => {
    const original = value as GiftOriginal | null;
    if (!original || typeof original.id !== 'string' || !original.id
      || typeof original.storageName !== 'string' || !ORIGINAL_NAME.test(original.storageName)
      || !Number.isSafeInteger(original.byteSize) || original.byteSize < 1) throw Error('礼物原件登记无效，已停止备份或还原。');
    const previous = originals.get(original.storageName);
    if (previous && (previous.id !== original.id || previous.byteSize !== original.byteSize)) {
      throw Error('礼物原件登记冲突，已停止备份或还原。');
    }
    originals.set(original.storageName, original);
  };
  for (const row of await db.getAllAsync<{ record_json: string }>('SELECT record_json FROM gift_records ORDER BY id')) {
    const record = JSON.parse(row.record_json) as { cover: unknown; attachments: { kind: string; original?: unknown }[] };
    if (!record || !Array.isArray(record.attachments)) throw Error('礼物原件记录无效，已停止备份或还原。');
    if (record.cover !== null) add(record.cover);
    for (const item of record.attachments) {
      if (!item || !['url', 'image', 'audio', 'html'].includes(item.kind)) throw Error('礼物原件记录无效，已停止备份或还原。');
      if (item.kind !== 'url') add(item.original);
    }
  }
  return [...originals.values()].sort((a, b) => a.storageName.localeCompare(b.storageName));
}

export function assertGiftBackupByteSize(original: GiftOriginal, byteSize: number) {
  if (byteSize !== original.byteSize) throw Error('礼物原件缺失或大小与登记不符，已停止备份或还原。');
}

async function checkedFile(uri: string, original: GiftOriginal) {
  const info = await FileSystem.getInfoAsync(uri);
  assertGiftBackupByteSize(original, info.exists && !info.isDirectory ? info.size : -1);
}

function localDirectory() {
  if (!FileSystem.documentDirectory) throw Error('礼物原件目录不可用。');
  return `${FileSystem.documentDirectory}${GIFT_ORIGINALS_BACKUP_FOLDER}/`;
}

/** The existing exclusive backup lease keeps captured references and originals together. */
export async function captureGiftBackupOriginals(
  originals: readonly GiftOriginal[],
  captureFile: (original: GiftOriginal, sourceUri: string) => Promise<number>,
) {
  const directory = localDirectory();
  for (const original of originals) {
    const sourceUri = `${directory}${original.storageName}`;
    await checkedFile(sourceUri, original);
    await captureBackupMediaFileStrict({
      sourceUri, relativePath: original.storageName,
      io: { getInfoAsync: FileSystem.getInfoAsync, readDirectoryAsync: FileSystem.readDirectoryAsync },
      captureFile: async () => assertGiftBackupByteSize(original, await captureFile(original, sourceUri)),
    });
  }
}

/** Old databases without gift records accept no gift payload and restore an empty directory. */
export async function validateGiftBackupOriginals(
  originals: readonly GiftOriginal[],
  archiveFilePaths: Iterable<string>,
  readByteSize: (original: GiftOriginal) => Promise<number>,
) {
  const expected = new Set(originals.map(original => `${GIFT_ORIGINALS_BACKUP_PREFIX}${original.storageName}`));
  const actual = [...archiveFilePaths].filter(name => name.startsWith(GIFT_ORIGINALS_BACKUP_PREFIX));
  if (actual.length !== expected.size || actual.some(name => !expected.has(name))) {
    throw Error('礼物原件清单与记录不一致，已停止还原。');
  }
  for (const original of originals) assertGiftBackupByteSize(original, await readByteSize(original));
}

/** storageName is portable; giftOriginalUri resolves it against this device after restore. */
export async function restoreGiftBackupOriginals(
  originals: readonly GiftOriginal[],
  writeFile: (original: GiftOriginal, target: string) => Promise<void>,
) {
  await restoreDirectorySafely(localDirectory(), async staging => {
    for (const original of originals) {
      const target = `${staging}${original.storageName}`;
      await writeFile(original, target);
      await checkedFile(target, original);
    }
  });
}
