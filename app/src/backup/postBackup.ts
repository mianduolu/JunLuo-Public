import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import type { SQLiteDatabase } from 'expo-sqlite';
import * as SQLite from 'expo-sqlite';
import { POST_BACKUP_FOLDER, KEYS, NOTICES, validPostImageId, assertMissingPostImageIds, acceptPostMissing, validatePostBackupStorage,
  type PostBackupImage, type PostBackupOptions } from './postBackupContract';
export * from './postBackupContract';
import { runBackupRestoreExclusive } from './backupRestoreCoordinator';
import { restoreDirectorySafely } from '../storage/safeFileWrite';

async function hasTable(db: SQLiteDatabase, name: string) {
  return !!await db.getFirstAsync('SELECT name FROM sqlite_master WHERE name = ?', name);
}
export async function readPostBackupImages(db: SQLiteDatabase): Promise<PostBackupImage[]> {
  if (!await hasTable(db, 'baiyun_post_images')) return [];
  if (!await hasTable(db, 'baiyun_post_image_references')) throw new Error('动态图片引用表缺失。');
  const rows = await db.getAllAsync<PostBackupImage>(`SELECT DISTINCT r.image_id AS id, i.width, i.height, i.byte_size
    FROM baiyun_post_image_references r LEFT JOIN baiyun_post_images i ON i.id = r.image_id ORDER BY r.image_id`);
  for (const row of rows) if (!validPostImageId(row.id) || !Number.isSafeInteger(row.width) || row.width <= 0
    || !Number.isSafeInteger(row.height) || row.height <= 0 || !Number.isSafeInteger(row.byte_size) || row.byte_size <= 0)
    throw new Error('动态图片登记无效。');
  return rows;
}
async function checkedFile(uri: string, image: PostBackupImage) {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) return false;
  if (info.isDirectory || info.size !== image.byte_size) throw new Error('动态图片文件与登记不符。');
  return true;
}
function localImage(id: string) {
  if (!FileSystem.documentDirectory) throw new Error('动态图片目录不可用。');
  return `${FileSystem.documentDirectory}${POST_BACKUP_FOLDER}/${id}.jpg`;
}
/** The callback captures the memory DB into the archive and opens only that captured copy. */
export async function capturePostBackup(
  storage: Record<string, string>, options: PostBackupOptions,
  captureDatabase: () => Promise<SQLiteDatabase>,
  captureImage: (image: PostBackupImage, uri: string) => Promise<void>,
) {
  const capture = async () => {
    for (const [key, value] of await AsyncStorage.multiGet(KEYS)) {
      if (value === null) delete storage[key]; else storage[key] = value;
    }
    validatePostBackupStorage(storage);
    const db = await captureDatabase();
    try {
      const missing: string[] = [];
      for (const image of await readPostBackupImages(db)) {
        const uri = localImage(image.id);
        if (!await checkedFile(uri, image)) { missing.push(image.id); continue; }
        await captureImage(image, uri); // Read/copy errors are never treated as consented absence.
      }
      if (!options.postCaptureAlreadyExclusive) acceptPostMissing(missing, options.acceptedMissingPostImageIds, 'export');
      return missing;
    } finally { await db.closeAsync(); }
  };
  return options.postCaptureAlreadyExclusive ? capture() : runBackupRestoreExclusive(capture);
}

export type PreparedPostImages = { directory: string; missing: string[] };
/** Preflight creates temporary media only; never writes the live DB or photo directory. */
export async function preparePostBackupImages(options: {
  db: SQLiteDatabase; formatVersion: number; missingPostImageIds?: string[];
  directory: string; readArchiveImage: (image: PostBackupImage, target: string) => Promise<boolean>;
  reuseLocal: boolean;
}): Promise<PreparedPostImages> {
  const images = await readPostBackupImages(options.db), declared = options.missingPostImageIds ?? [];
  if (options.formatVersion >= 13) assertMissingPostImageIds(options.missingPostImageIds);
  if (declared.some(id => !images.some(image => image.id === id))) throw new Error('缺图清单引用了不存在的图片。');
  await FileSystem.makeDirectoryAsync(options.directory, { intermediates: true });
  const missing: string[] = [];
  let localDb: SQLiteDatabase | undefined;
  try {
    for (const image of images) {
      const target = `${options.directory}${image.id}.jpg`;
      const packed = await options.readArchiveImage(image, target);
      if (packed) {
        if (declared.includes(image.id) || !await checkedFile(target, image)) throw new Error('备份图片清单与文件不一致。');
        continue;
      }
      if (options.formatVersion >= 13 && !declared.includes(image.id)) throw new Error('备份声明包含的动态图片缺失。');
      if (options.reuseLocal) {
        localDb ??= await SQLite.openDatabaseAsync('junluo-memory.db', { useNewConnection: true, finalizeUnusedStatementsBeforeClosing: false });
        const row = await hasTable(localDb, 'baiyun_post_images')
          ? await localDb.getFirstAsync<PostBackupImage>('SELECT * FROM baiyun_post_images WHERE id = ?', image.id) : null;
        if (row && row.width === image.width && row.height === image.height && row.byte_size === image.byte_size
          && await checkedFile(localImage(image.id), image)) {
          await FileSystem.copyAsync({ from: localImage(image.id), to: target });
          if (!await checkedFile(target, image)) throw new Error('动态原图复制失败。');
          continue;
        }
      }
      missing.push(image.id);
    }
  } finally { await localDb?.closeAsync(); }
  return { directory: options.directory, missing };
}
export async function restorePostBackupImages(prepared: PreparedPostImages) {
  if (!FileSystem.documentDirectory) throw new Error('动态图片目录不可用。');
  await restoreDirectorySafely(`${FileSystem.documentDirectory}${POST_BACKUP_FOLDER}/`, async staging => {
    for (const name of await FileSystem.readDirectoryAsync(prepared.directory)) {
      if (!name.endsWith('.jpg') || !validPostImageId(name.slice(0, -4))) throw new Error('备份动态图片路径无效。');
      await FileSystem.copyAsync({ from: prepared.directory + name, to: staging + name });
    }
  });
}
/** Tray bindings are device-local; reading and paid-work journals are untouched. */
export async function prepareRestoredPostStorage(storage: Record<string, string>, db: SQLiteDatabase) {
  validatePostBackupStorage(storage);
  const journal = JSON.parse(storage[NOTICES] ?? '{}');
  for (const item of Object.values(journal) as any[]) item.phase = 'closed';
  if (await hasTable(db, 'baiyun_post_notification_arrivals')) {
    const groups = await db.getAllAsync<{ group_key: string }>('SELECT DISTINCT group_key FROM baiyun_post_notification_arrivals');
    for (const row of groups) journal[row.group_key] = { phase: 'closed', revision: journal[row.group_key]?.revision ?? 0, signature: '' };
  }
  return { ...storage, [NOTICES]: JSON.stringify(journal) };
}
