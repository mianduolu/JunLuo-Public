import * as FileSystem from 'expo-file-system/legacy';

import { toolsWorkspaceStorageBridge as AsyncStorage, runToolsWorkspaceFileRecordsExclusive } from '../sync/syncToolsWorkspaceStorageBridge';
import { copyFileSafely, writeStringFileSafely } from '../storage/safeFileWrite';

export type JunLuoFileImportRecord = {
  cacheId: string;
  name: string;
  extension: string;
  mimeType?: string;
  uri: string;
  kind?: 'text' | 'zip' | 'raw' | 'image';
  width?: number;
  height?: number;
  mediaSource?: 'picker' | 'camera' | 'test' | 'generated';
  size?: number;
  charCount?: number;
  importedAt: number;
  archivedAt?: number;
  movedToCacheId?: string;
  sourceCacheIds?: string[];
  externalFileId?: string;
  externalPath?: string;
  directoryTag?: string;
};

export type JunLuoFileSearchMatch = {
  index: number;
  start: number;
  end: number;
  excerpt: string;
};

const FILE_IMPORTS_KEY = 'junluo.tools.files.imports.v1';
const FILE_CACHE_FOLDER = 'tool-file-cache';
const MAX_PICKED_TEXT_BYTES = 1024 * 1024;
const SUPPORTED_TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'json', 'csv'] as const;
const SUPPORTED_RAW_EXTENSIONS = ['pdf', 'docx', 'epub'] as const;
const SUPPORTED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif'] as const;
const ZIP_EXTENSION = 'zip';

type SupportedTextExtension = typeof SUPPORTED_TEXT_EXTENSIONS[number];

function getCacheDirectory() {
  if (!FileSystem.documentDirectory) {
    throw new Error('当前设备无法访问文件缓存目录');
  }
  return `${FileSystem.documentDirectory}${FILE_CACHE_FOLDER}/`;
}

function normalizeExtension(name: string) {
  const match = /\.([^.\/\\]+)$/.exec(name.trim());
  return match?.[1]?.toLowerCase() ?? '';
}

export function isSupportedTextFileName(name: string) {
  return SUPPORTED_TEXT_EXTENSIONS.includes(normalizeExtension(name) as SupportedTextExtension);
}

export function getSupportedTextFileExtensions() {
  return [...SUPPORTED_TEXT_EXTENSIONS];
}

export function isSupportedZipFileName(name: string) {
  return normalizeExtension(name) === ZIP_EXTENSION;
}

export function isSupportedRawFileName(name: string) {
  return SUPPORTED_RAW_EXTENSIONS.includes(normalizeExtension(name) as typeof SUPPORTED_RAW_EXTENSIONS[number]);
}

export function isSupportedImageFileName(name: string) {
  return SUPPORTED_IMAGE_EXTENSIONS.includes(normalizeExtension(name) as typeof SUPPORTED_IMAGE_EXTENSIONS[number]);
}

export function getSupportedImageFileExtensions() {
  return [...SUPPORTED_IMAGE_EXTENSIONS];
}

function sanitizeFileName(name: string) {
  const cleaned = name.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/\s+/g, ' ');
  return cleaned || 'document.txt';
}

function ensureExtension(name: string, fallbackExtension: string) {
  const safeName = sanitizeFileName(name);
  const extension = normalizeExtension(safeName);
  if (extension) return safeName;
  return `${safeName}.${fallbackExtension}`;
}

function createCacheId() {
  return `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureCacheDirectory() {
  await FileSystem.makeDirectoryAsync(getCacheDirectory(), { intermediates: true });
}

async function loadRecords() {
  const raw = await AsyncStorage.getItem(FILE_IMPORTS_KEY);
  if (raw === null) return [] as JunLuoFileImportRecord[];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) throw new Error('文件登记记录损坏');
  if (new Set(parsed.map((record) => record.cacheId)).size !== parsed.length) throw new Error('文件登记编号重复');
  return parsed;
}

function isRecord(value: unknown): value is JunLuoFileImportRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<JunLuoFileImportRecord>;
  return typeof record.cacheId === 'string' &&
    typeof record.name === 'string' &&
    typeof record.extension === 'string' &&
    typeof record.uri === 'string' &&
    typeof record.importedAt === 'number' && Number.isFinite(record.importedAt);
}

async function saveRecords(records: JunLuoFileImportRecord[]) {
  await AsyncStorage.setItem(FILE_IMPORTS_KEY, JSON.stringify(
    [...records].sort((a, b) => b.importedAt - a.importedAt),
  ));
}

async function registerRecord(record: JunLuoFileImportRecord) {
  await runToolsWorkspaceFileRecordsExclusive(async () => {
    await saveRecords([record, ...(await loadRecords()).filter((item) => item.cacheId !== record.cacheId)]);
  });
}

function hostCacheId(value?: string) {
  if (value === undefined) return createCacheId();
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new Error('文件编号无效');
  return value;
}

async function deleteCertainlyUnregisteredFile(cacheId: string, uri: string, error: unknown) {
  // A failed sync capture can have committed locally. Unreadable state is not
  // proof of rollback; retain that file and let the execution journal report it.
  if (error && typeof error === 'object' && 'toolsWorkspaceFileCapturePending' in error) return;
  const records = await loadRecords().catch(() => undefined);
  if (records && !records.some((record) => record.cacheId === cacheId)) {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  }
}

function inferKind(extension: string): JunLuoFileImportRecord['kind'] {
  if (SUPPORTED_RAW_EXTENSIONS.includes(extension as typeof SUPPORTED_RAW_EXTENSIONS[number])) return 'raw';
  if (SUPPORTED_IMAGE_EXTENSIONS.includes(extension as typeof SUPPORTED_IMAGE_EXTENSIONS[number])) return 'image';
  return extension === ZIP_EXTENSION ? 'zip' : 'text';
}

function isTextRecord(record: JunLuoFileImportRecord) {
  return (record.kind ?? inferKind(record.extension)) === 'text' && isSupportedTextFileName(record.name);
}

export async function listRecentFileImports(limit = 20) {
  const records = await loadRecords();
  return records
    .sort((a, b) => b.importedAt - a.importedAt)
    .slice(0, Math.max(1, Math.min(100, Math.round(limit))));
}

export async function getFileImportRecord(cacheId: string) {
  const records = await loadRecords();
  return records.find((record) => record.cacheId === cacheId);
}

export async function registerPickedTextFile(asset: {
  cacheId?: string;
  mimeType?: string;
  name?: string;
  size?: number;
  uri: string;
}) {
  const name = sanitizeFileName(asset.name ?? 'document.txt');
  const extension = normalizeExtension(name);
  if (!isSupportedTextFileName(name)) {
    throw new Error(`不支持的文件类型：${extension || 'unknown'}`);
  }
  return runToolsWorkspaceFileRecordsExclusive(async () => {
    const records = await loadRecords();
    const cacheId = hostCacheId(asset.cacheId);
    const existing = records.find((record) => record.cacheId === cacheId);
    if (existing) {
      if (existing.name !== name || !isTextRecord(existing)) throw new Error('文件编号已用于其它文件');
      await readImportedText(cacheId);
      return existing;
    }
    const sourceInfo = await FileSystem.getInfoAsync(asset.uri);
    if (sourceInfo.exists && !sourceInfo.isDirectory && sourceInfo.size > MAX_PICKED_TEXT_BYTES) {
      throw new Error('文字文件超过 1 MiB');
    }
    await ensureCacheDirectory();
    const safeName = sanitizeFileName(name);
    const targetUri = `${getCacheDirectory()}${cacheId}-${safeName}`;
    if ((await FileSystem.getInfoAsync(targetUri)).exists) throw new Error('文件保存结果尚未确认');
    try {
      await copyFileSafely({ from: asset.uri, to: targetUri });
      const info = await FileSystem.getInfoAsync(targetUri);
      if (!info.exists || info.isDirectory || !Number.isFinite(info.size) || info.size > MAX_PICKED_TEXT_BYTES) {
        throw new Error('文字文件大小无法确认或超过 1 MiB');
      }
      const content = await FileSystem.readAsStringAsync(targetUri, { encoding: FileSystem.EncodingType.UTF8 });
      const record: JunLuoFileImportRecord = {
        cacheId,
        name: safeName,
        extension,
        mimeType: asset.mimeType,
        uri: targetUri,
        kind: 'text',
        size: info.size,
        charCount: content.length,
        importedAt: Date.now(),
      };
      await saveRecords([record, ...records]);
      return record;
    } catch (error) {
      await deleteCertainlyUnregisteredFile(cacheId, targetUri, error);
      throw error;
    }
  });
}

export async function registerPickedZipFile(asset: {
  mimeType?: string;
  name?: string;
  size?: number;
  uri: string;
}) {
  const name = ensureExtension(asset.name ?? 'archive.zip', ZIP_EXTENSION);
  const extension = normalizeExtension(name);
  if (extension !== ZIP_EXTENSION) {
    throw new Error(`不支持的压缩包类型：${extension || 'unknown'}`);
  }
  await ensureCacheDirectory();
  const cacheId = createCacheId();
  const targetUri = `${getCacheDirectory()}${cacheId}-${name}`;
  await copyFileSafely({ from: asset.uri, to: targetUri });
  const info = await FileSystem.getInfoAsync(targetUri);
  const record: JunLuoFileImportRecord = {
    cacheId,
    name,
    extension,
    mimeType: asset.mimeType ?? 'application/zip',
    uri: targetUri,
    kind: 'zip',
    size: typeof asset.size === 'number'
      ? asset.size
      : info.exists && typeof info.size === 'number'
        ? info.size
        : undefined,
    importedAt: Date.now(),
  };
  await registerRecord(record);
  return record;
}


export async function registerRawFileCopy(input: {
  externalFileId?: string;
  externalPath?: string;
  directoryTag?: string;
  mimeType?: string;
  name?: string;
  size?: number;
  uri: string;
}) {
  const name = ensureExtension(input.name ?? 'document.pdf', 'pdf');
  const extension = normalizeExtension(name);
  if (!isSupportedRawFileName(name)) {
    throw new Error(`不支持登记为原始文件的类型：${extension || 'unknown'}`);
  }
  await ensureCacheDirectory();
  const cacheId = createCacheId();
  const targetUri = `${getCacheDirectory()}${cacheId}-${name}`;
  await copyFileSafely({ from: input.uri, to: targetUri });
  const info = await FileSystem.getInfoAsync(targetUri);
  const record: JunLuoFileImportRecord = {
    cacheId,
    name,
    extension,
    mimeType: input.mimeType,
    uri: targetUri,
    kind: 'raw',
    size: typeof input.size === 'number'
      ? input.size
      : info.exists && typeof info.size === 'number'
        ? info.size
        : undefined,
    importedAt: Date.now(),
    externalFileId: input.externalFileId,
    externalPath: input.externalPath,
    directoryTag: input.directoryTag,
  };
  await registerRecord(record);
  return record;
}

export async function registerImageFileCopy(input: {
  uri: string;
  name?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
  mediaSource?: JunLuoFileImportRecord['mediaSource'];
}) {
  const safeName = ensureExtension(input.name || 'junluo-image.jpg', 'jpg');
  if (!isSupportedImageFileName(safeName)) {
    throw new Error(`不支持的图片类型：${normalizeExtension(safeName) || 'unknown'}`);
  }
  await ensureCacheDirectory();
  const cacheId = createCacheId();
  const targetUri = `${getCacheDirectory()}${cacheId}-${safeName}`;
  await copyFileSafely({ from: input.uri, to: targetUri });
  const info = await FileSystem.getInfoAsync(targetUri);
  const record: JunLuoFileImportRecord = {
    cacheId,
    name: safeName,
    extension: normalizeExtension(safeName),
    mimeType: input.mimeType,
    uri: targetUri,
    size: input.size ?? (info.exists && !info.isDirectory ? info.size : undefined),
    kind: 'image',
    width: input.width,
    height: input.height,
    mediaSource: input.mediaSource,
    importedAt: Date.now(),
  };
  await registerRecord(record);
  return record;
}
export async function registerTextFileForTests(name: string, content: string, mimeType?: string) {
  return writeTextFileToCache({ name, text: content, mimeType });
}

export async function registerImageFileForTests(name: string, base64: string, mimeType = 'image/png', width?: number, height?: number) {
  const safeName = ensureExtension(name, normalizeExtension(name) || 'png');
  if (!isSupportedImageFileName(safeName)) {
    throw new Error(`不支持的图片类型：${normalizeExtension(safeName) || 'unknown'}`);
  }
  await ensureCacheDirectory();
  const cacheId = createCacheId();
  const targetUri = `${getCacheDirectory()}${cacheId}-${safeName}`;
  await writeStringFileSafely(targetUri, base64, { encoding: FileSystem.EncodingType.Base64 });
  const info = await FileSystem.getInfoAsync(targetUri);
  const record: JunLuoFileImportRecord = {
    cacheId,
    name: safeName,
    extension: normalizeExtension(safeName),
    mimeType,
    uri: targetUri,
    size: info.exists && !info.isDirectory ? info.size : undefined,
    kind: 'image',
    width,
    height,
    mediaSource: 'test',
    importedAt: Date.now(),
  };
  await registerRecord(record);
  return record;
}
export async function registerZipFileForTests(name: string, base64: string, mimeType = 'application/zip') {
  return writeZipFileToCache({ name, base64, mimeType });
}

export async function writeTextFileToCache(input: {
  cacheId?: string;
  name: string;
  text: string;
  mimeType?: string;
  sourceCacheIds?: string[];
}) {
  const safeName = ensureExtension(input.name, 'txt');
  const extension = normalizeExtension(safeName);
  if (!isSupportedTextFileName(safeName)) {
    throw new Error(`不支持的文件类型：${extension || 'unknown'}`);
  }
  return runToolsWorkspaceFileRecordsExclusive(async () => {
    const records = await loadRecords();
    const cacheId = hostCacheId(input.cacheId);
    const existing = records.find((record) => record.cacheId === cacheId);
    if (existing) {
      if (existing.name !== safeName || (await readImportedText(cacheId)).text !== input.text) {
        throw new Error('文件编号已用于其它文件');
      }
      return existing;
    }
    await ensureCacheDirectory();
    const targetUri = `${getCacheDirectory()}${cacheId}-${safeName}`;
    if ((await FileSystem.getInfoAsync(targetUri)).exists) throw new Error('文件保存结果尚未确认');
    try {
      await writeStringFileSafely(targetUri, input.text, { encoding: FileSystem.EncodingType.UTF8 });
      const info = await FileSystem.getInfoAsync(targetUri);
      const record: JunLuoFileImportRecord = {
        cacheId,
        name: safeName,
        extension,
        mimeType: input.mimeType,
        uri: targetUri,
        kind: 'text',
        size: info.exists && !info.isDirectory ? info.size : undefined,
        charCount: input.text.length,
        importedAt: Date.now(),
        sourceCacheIds: input.sourceCacheIds,
      };
      await saveRecords([record, ...records]);
      return record;
    } catch (error) {
      await deleteCertainlyUnregisteredFile(cacheId, targetUri, error);
      throw error;
    }
  });
}

export async function writeZipFileToCache(input: {
  name: string;
  base64: string;
  mimeType?: string;
  sourceCacheIds?: string[];
}) {
  const safeName = ensureExtension(input.name, ZIP_EXTENSION);
  if (normalizeExtension(safeName) !== ZIP_EXTENSION) {
    throw new Error('压缩包文件名必须使用 zip 扩展名');
  }
  await ensureCacheDirectory();
  const cacheId = createCacheId();
  const targetUri = `${getCacheDirectory()}${cacheId}-${safeName}`;
  await writeStringFileSafely(targetUri, input.base64, { encoding: FileSystem.EncodingType.Base64 });
  const record: JunLuoFileImportRecord = {
    cacheId,
    name: safeName,
    extension: ZIP_EXTENSION,
    mimeType: input.mimeType ?? 'application/zip',
    uri: targetUri,
    kind: 'zip',
    size: input.base64.length,
    importedAt: Date.now(),
    sourceCacheIds: input.sourceCacheIds,
  };
  await registerRecord(record);
  return record;
}

export async function copyFileRecordToCache(cacheId: string, newName?: string) {
  const source = await getFileImportRecord(cacheId);
  if (!source) throw new Error(`文件缓存不存在：${cacheId}`);
  const safeName = ensureExtension(newName || `copy-${source.name}`, source.extension || 'txt');
  if ((source.kind ?? inferKind(source.extension)) === 'text' && !isSupportedTextFileName(safeName)) {
    throw new Error(`不支持的文件类型：${normalizeExtension(safeName) || 'unknown'}`);
  }
  if ((source.kind ?? inferKind(source.extension)) === 'zip' && normalizeExtension(safeName) !== ZIP_EXTENSION) {
    throw new Error('压缩包复制后仍必须使用 zip 扩展名');
  }
  await ensureCacheDirectory();
  const newCacheId = createCacheId();
  const targetUri = `${getCacheDirectory()}${newCacheId}-${safeName}`;
  await copyFileSafely({ from: source.uri, to: targetUri });
  const record: JunLuoFileImportRecord = {
    ...source,
    cacheId: newCacheId,
    name: safeName,
    extension: normalizeExtension(safeName),
    uri: targetUri,
    importedAt: Date.now(),
    archivedAt: undefined,
    movedToCacheId: undefined,
    sourceCacheIds: [source.cacheId],
  };
  await registerRecord(record);
  return record;
}

export async function renameFileRecordInCache(cacheId: string, newName: string) {
  const source = await getFileImportRecord(cacheId);
  if (!source) throw new Error(`文件缓存不存在：${cacheId}`);
  const renamed = await copyFileRecordToCache(cacheId, newName);
  await runToolsWorkspaceFileRecordsExclusive(async () => {
    const records = await loadRecords();
    await saveRecords(records.map((record) =>
      record.cacheId === cacheId
        ? { ...record, archivedAt: Date.now(), movedToCacheId: renamed.cacheId }
        : record
    ));
  });
  return { source, renamed };
}

export async function readImportedText(cacheId: string) {
  const record = await getFileImportRecord(cacheId);
  if (!record) {
    throw new Error(`文件缓存不存在：${cacheId}`);
  }
  if (!isTextRecord(record)) {
    throw new Error(`文件不是可直接读取的文本：${record.name}`);
  }
  const info = await FileSystem.getInfoAsync(record.uri);
  if (!info.exists) {
    throw new Error(`文件缓存已丢失：${cacheId}`);
  }
  return {
    record,
    text: await FileSystem.readAsStringAsync(record.uri, { encoding: FileSystem.EncodingType.UTF8 }),
  };
}

export async function readImportedBase64(cacheId: string) {
  const record = await getFileImportRecord(cacheId);
  if (!record) {
    throw new Error(`文件缓存不存在：${cacheId}`);
  }
  const info = await FileSystem.getInfoAsync(record.uri);
  if (!info.exists) {
    throw new Error(`文件缓存已丢失：${cacheId}`);
  }
  return {
    record,
    base64: await FileSystem.readAsStringAsync(record.uri, { encoding: FileSystem.EncodingType.Base64 }),
  };
}

export function searchImportedText(text: string, query: string, limit = 20): JunLuoFileSearchMatch[] {
  const needle = query.trim();
  if (!needle) return [];
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const matches: JunLuoFileSearchMatch[] = [];
  let cursor = 0;
  while (matches.length < limit) {
    const start = lowerText.indexOf(lowerNeedle, cursor);
    if (start < 0) break;
    const end = start + needle.length;
    const excerptStart = Math.max(0, start - 60);
    const excerptEnd = Math.min(text.length, end + 60);
    matches.push({
      index: matches.length,
      start,
      end,
      excerpt: `${excerptStart > 0 ? '...' : ''}${text.slice(excerptStart, excerptEnd)}${excerptEnd < text.length ? '...' : ''}`,
    });
    cursor = end;
  }
  return matches;
}

export async function clearFileImportsForTests() {
  await runToolsWorkspaceFileRecordsExclusive(() => AsyncStorage.removeItem(FILE_IMPORTS_KEY));
}

