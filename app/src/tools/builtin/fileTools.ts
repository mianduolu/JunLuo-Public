import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { AppState, Linking } from 'react-native';
import {
  copyExternalFileToCache,
  deleteExternalFile,
  getExternalFileInfo,
  getExternalFilesAccessStatus,
  moveExternalFile,
  openExternalFilesAccessSettings,
  overwriteExternalFile,
  scanExternalFiles,
  type ExternalFileSummary,
} from '../../backend/externalFilesNative';
import { importEpubBookFromUri } from '../../reading/epubImport';
import JSZip from 'jszip';
import {
  copyFileRecordToCache,
  getFileImportRecord,
  getSupportedTextFileExtensions,
  isSupportedTextFileName,
  isSupportedZipFileName,
  listRecentFileImports,
  readImportedBase64,
  readImportedText,
  registerPickedTextFile,
  registerPickedZipFile,
  registerRawFileCopy,
  renameFileRecordInCache,
  searchImportedText,
  writeTextFileToCache,
  writeZipFileToCache,
  type JunLuoFileImportRecord,
  type JunLuoFileSearchMatch,
} from '../fileToolStore';
import { createToolError } from '../toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolExecutorContext, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import { readNumberInput, readStringInput, validationFailed } from './builtinToolValidation';
import { TEXT_FILE_CATALOG_DESCRIPTION, TEXT_FILE_ID_DESCRIPTION, textFileDataFits, textFilePart } from '../textFileChatTools';

type FilePickData = JunLuoFileImportRecord & {
  supportedExtensions: string[];
  text: string; start: number; end: number; hasMore: boolean;
};

type FileListData = {
  files: JunLuoFileImportRecord[];
  limit: number;
};

type FileInfoData = {
  file: JunLuoFileImportRecord;
};

type FileReadTextData = {
  cacheId: string;
  name: string;
  text: string;
  charCount: number;
  truncated: false;
  start: number; end: number; hasMore: false;
};

type FileReadPartData = {
  cacheId: string;
  name: string;
  start: number;
  end: number;
  length: number;
  text: string;
  charCount: number;
  partIndex?: number;
  hasMore: boolean;
};

type FileSearchData = {
  cacheId: string;
  name: string;
  query: string;
  matches: JunLuoFileSearchMatch[];
  totalMatchesReturned: number;
};

type FileWriteData = {
  file: JunLuoFileImportRecord;
};

type FileCopyData = {
  source: JunLuoFileImportRecord;
  file: JunLuoFileImportRecord;
};

type FileMoveData = {
  source: JunLuoFileImportRecord;
  file: JunLuoFileImportRecord;
};

type FileZipData = {
  file: JunLuoFileImportRecord;
  sourceFiles: JunLuoFileImportRecord[];
};

type FileUnzipData = {
  archive: JunLuoFileImportRecord;
  files: JunLuoFileImportRecord[];
  skipped: Array<{ name: string; reason: string }>;
};

type FileOpenShareData = {
  file: JunLuoFileImportRecord;
  action: 'open' | 'share';
};

type ExternalFilesStatusData = Awaited<ReturnType<typeof getExternalFilesAccessStatus>>;

type ExternalFilesScanData = {
  files: ExternalFileSummary[];
  diagnostics: unknown[];
  query?: string;
  limit: number;
};

type ExternalFileInfoData = {
  file: ExternalFileSummary;
};

type ExternalFileImportData = {
  externalFile: ExternalFileSummary;
  file?: JunLuoFileImportRecord;
  book?: {
    id: string;
    title: string;
    author: string;
    totalChapters: number;
    fileType: string;
  };
  importKind: string;
};

type ExternalDangerousFileData = {
  externalFile?: ExternalFileSummary;
  backup?: JunLuoFileImportRecord;
  result: unknown;
};


const FULL_TEXT_LIMIT = 12_000;
const DEFAULT_PART_LENGTH = 4_000;
const MAX_PART_LENGTH = 8_000;
const MAX_WRITE_CHARS = 80_000;
const MAX_ZIP_FILES = 20;
const MAX_UNZIP_TEXT_FILES = 20;
const MAX_UNZIP_TOTAL_CHARS = 200_000;
const DEFAULT_ZIP_NAME = 'junluo-files.zip';

function clampInteger(value: number | undefined, fallback: number, min: number, max: number) {
  if (typeof value !== 'number') return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function readStringArrayInput(input: Record<string, unknown> | undefined, key: string) {
  const value = input?.[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
}

function requireCacheId(call: JunLuoToolCall) {
  const cacheId = readStringInput(call.input, 'cacheId');
  return cacheId || undefined;
}

function summarizeFile(record: JunLuoFileImportRecord) {
  const size = typeof record.size === 'number' ? `，约 ${record.size} 字节` : '';
  const chars = typeof record.charCount === 'number' ? `，${record.charCount} 字符` : '';
  return `${record.name}（${record.extension}${size}${chars}）`;
}

function fileError<T>(call: JunLuoToolCall, error: unknown, summary: string): JunLuoToolResult<T> {
  if (error && typeof error === 'object' && 'toolsWorkspaceFileCapturePending' in error
    || error instanceof Error && error.message === '文件保存结果尚未确认') {
    return createToolErrorResult(call, createToolError('TOOL_OUTCOME_UNKNOWN', 'TOOL_OUTCOME_UNKNOWN'), '');
  }
  return createToolErrorResult(
    call,
    createToolError(
      error instanceof Error && /不支持|不能为空|不存在|超过|必须|不是/.test(error.message) ? 'VALIDATION_FAILED' : 'EXECUTION_FAILED',
      error instanceof Error ? error.message : String(error),
    ),
    summary,
  ) as JunLuoToolResult<T>;
}


function requireExternalFileId(call: JunLuoToolCall) {
  return readStringInput(call.input, 'externalFileId') || undefined;
}

function readExtensionsInput(input: Record<string, unknown> | undefined) {
  const extensions = readStringArrayInput(input, 'extensions')
    .map((item) => item.replace(/^\./, '').toLowerCase())
    .filter(Boolean);
  return extensions.length ? extensions : undefined;
}

function externalNativeError<T>(call: JunLuoToolCall, raw: unknown, summary: string): JunLuoToolResult<T> {
  const payload = raw as { code?: string; message?: string };
  const code = payload?.code === 'NO_EXTERNAL_ACCESS' || payload?.code === 'FILE_NOT_FOUND'
    ? 'VALIDATION_FAILED'
    : 'EXECUTION_FAILED';
  return createToolErrorResult(
    call,
    createToolError(code, payload?.message || '外部文件工具执行失败', raw),
    summary,
  ) as JunLuoToolResult<T>;
}

function extensionOfFile(file?: { extension?: string; name?: string }) {
  const extension = file?.extension?.toLowerCase();
  if (extension) return extension;
  return file?.name?.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? '';
}

function isTextExtension(extension: string) {
  return ['txt', 'md', 'markdown', 'json', 'csv'].includes(extension);
}

async function backupExternalFile(call: JunLuoToolCall, externalFileId: string) {
  const copied = await copyExternalFileToCache(externalFileId) as {
    ok?: boolean;
    cacheUri?: string;
    source?: ExternalFileSummary;
    message?: string;
  };
  if (!copied.ok || !copied.cacheUri || !copied.source) {
    throw new Error(copied.message || '危险操作前没有备份成功，已停止执行');
  }
  const extension = extensionOfFile(copied.source);
  if (isTextExtension(extension)) {
    return registerPickedTextFile({
      mimeType: copied.source.mimeType,
      name: `backup-${copied.source.name}`,
      size: copied.source.size,
      uri: copied.cacheUri,
    });
  }
  if (extension === 'zip') {
    return registerPickedZipFile({
      mimeType: copied.source.mimeType,
      name: `backup-${copied.source.name}`,
      size: copied.source.size,
      uri: copied.cacheUri,
    });
  }
  return registerRawFileCopy({
    directoryTag: copied.source.directoryTag,
    externalFileId,
    externalPath: copied.source.path,
    mimeType: copied.source.mimeType,
    name: `backup-${copied.source.name}`,
    size: copied.source.size,
    uri: copied.cacheUri,
  });
}

function inferMimeType(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.csv')) return 'text/csv';
  return 'text/plain';
}

function runToolDataCommit<T>(context: JunLuoToolExecutorContext | undefined, work: () => Promise<T> | T) {
  return context?.runBackupRestoreDataEpochCommit
    ? context.runBackupRestoreDataEpochCommit(work)
    : Promise.resolve(work());
}

async function executePickDocument(
  call: JunLuoToolCall,
  context?: JunLuoToolExecutorContext,
): Promise<JunLuoToolResult<FilePickData>> {
  if (call.requestedBy === 'chat' && (!context?.textFileChat || AppState.currentState !== 'active'
    || !await context.textFileChat.isCurrent())) return validationFailed(call, 'STALE_DATA_EPOCH', '没有导入文件');
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
    type: ['text/plain', 'text/markdown', 'application/json', 'text/csv', 'text/comma-separated-values'],
  });
  if (result.canceled) {
    return { ...createToolErrorResult(
      call,
      createToolError('CANCELLED_BY_YOU', '用户没有选择文件'),
      '没有选择文件',
    ), status: 'cancelled' };
  }
  const asset = result.assets?.[0];
  if (!asset?.uri) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', '文件选择器没有返回可用文件'),
      '没有导入文件',
    );
  }
  if (asset.name && !isSupportedTextFileName(asset.name)) {
    return createToolErrorResult(
      call,
      createToolError('VALIDATION_FAILED', `不支持的文件类型：${asset.name}`),
      '没有导入文件：只支持 txt/md/markdown/json/csv',
    );
  }
  try {
    const record = await runToolDataCommit(context, async () => {
      if (context?.textFileChat && !await context.textFileChat.isCurrent()) throw new Error('STALE_DATA_EPOCH');
      return registerPickedTextFile({
      cacheId: context?.textFileChat?.cacheId,
      mimeType: asset.mimeType,
      name: asset.name,
      size: asset.size,
      uri: asset.uri,
    });
    });
    const { text } = await readImportedText(record.cacheId);
    return createToolSuccessResult(call, `已导入文件：${summarizeFile(record)}`, {
      ...record,
      ...textFilePart(record.cacheId, record.name, text),
      supportedExtensions: getSupportedTextFileExtensions(),
    });
  } catch (error) {
    return fileError(call, error, '没有导入文件');
  }
}

async function executeListRecentImports(call: JunLuoToolCall): Promise<JunLuoToolResult<FileListData>> {
  const limit = clampInteger(readNumberInput(call.input, 'limit'), 10, 1, 50);
  const files = await listRecentFileImports(limit);
  if (!files.length) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', '还没有登记过可读取的文本文件'),
      '还没有最近导入的文本文件',
    );
  }
  return createToolSuccessResult(call, `最近登记了 ${files.length} 个工具文件`, { files, limit });
}

async function executeFileInfo(call: JunLuoToolCall): Promise<JunLuoToolResult<FileInfoData>> {
  const cacheId = requireCacheId(call);
  if (!cacheId) return validationFailed(call, 'cacheId 不能为空', '没有读取文件信息');
  const file = await getFileImportRecord(cacheId);
  if (!file) {
    return createToolErrorResult(
      call,
      createToolError('VALIDATION_FAILED', `文件缓存不存在：${cacheId}`),
      '没有找到这个文件缓存',
    );
  }
  return createToolSuccessResult(call, `文件信息：${summarizeFile(file)}`, { file });
}

async function executeReadText(call: JunLuoToolCall, context?: JunLuoToolExecutorContext): Promise<JunLuoToolResult<FileReadTextData>> {
  const cacheId = requireCacheId(call);
  if (!cacheId) return validationFailed(call, 'cacheId 不能为空', '没有读取文件');
  if (call.requestedBy === 'chat' && !await context?.textFileChat?.canRead(cacheId)) return validationFailed(call, 'INVALID_ARGUMENTS', '没有读取文件');
  try {
    const { record, text } = await readImportedText(cacheId);
    const maxChars = call.requestedBy === 'chat' ? FULL_TEXT_LIMIT : clampInteger(readNumberInput(call.input, 'maxChars'), FULL_TEXT_LIMIT, 1000, FULL_TEXT_LIMIT);
    if (text.length > maxChars || !textFileDataFits({ cacheId, name: record.name, text, charCount: text.length })) {
      return createToolErrorResult(
        call,
        createToolError('VALIDATION_FAILED', `文件有 ${text.length} 字符，超过全文读取上限 ${maxChars}`),
        '文件太大，未读取全文；请使用分片读取',
      );
    }
    return createToolSuccessResult(call, `已读取文件全文：${record.name}`, {
      cacheId,
      name: record.name,
      text,
      charCount: text.length,
      truncated: false,
      start: 0, end: text.length, hasMore: false,
    });
  } catch (error) {
    return fileError(call, error, '没有读取到文件');
  }
}

async function executeReadPart(call: JunLuoToolCall, context?: JunLuoToolExecutorContext): Promise<JunLuoToolResult<FileReadPartData>> {
  const cacheId = requireCacheId(call);
  if (!cacheId) return validationFailed(call, 'cacheId 不能为空', '没有读取文件片段');
  if (call.requestedBy === 'chat' && (!Number.isSafeInteger(call.input.start) || Number(call.input.start) < 0
    || !await context?.textFileChat?.canRead(cacheId))) return validationFailed(call, 'INVALID_ARGUMENTS', '没有读取文件片段');
  try {
    const { record, text } = await readImportedText(cacheId);
    const length = call.requestedBy === 'chat' ? DEFAULT_PART_LENGTH : clampInteger(readNumberInput(call.input, 'length'), DEFAULT_PART_LENGTH, 1, MAX_PART_LENGTH);
    const partIndex = readNumberInput(call.input, 'partIndex');
    const explicitStart = readNumberInput(call.input, 'start');
    const start = Math.max(0, Math.min(text.length, Math.round(
      typeof explicitStart === 'number' ? explicitStart : typeof partIndex === 'number' ? partIndex * length : 0,
    )));
    const part = textFilePart(cacheId, record.name, text, start, length);
    return createToolSuccessResult(call, `已读取 ${record.name} 的 ${start}-${part.end} 字符片段`, part);
  } catch (error) {
    return fileError(call, error, '没有读取到文件片段');
  }
}

async function executeSearchText(call: JunLuoToolCall, context?: JunLuoToolExecutorContext): Promise<JunLuoToolResult<FileSearchData>> {
  const cacheId = requireCacheId(call);
  if (!cacheId) return validationFailed(call, 'cacheId 不能为空', '没有搜索文件');
  if (call.requestedBy === 'chat' && !await context?.textFileChat?.canRead(cacheId)) return validationFailed(call, 'INVALID_ARGUMENTS', '没有搜索文件');
  const query = readStringInput(call.input, 'query');
  if (!query) return validationFailed(call, 'query 不能为空', '没有搜索文件');
  try {
    const { record, text } = await readImportedText(cacheId);
    const limit = call.requestedBy === 'chat' ? 20 : clampInteger(readNumberInput(call.input, 'limit'), 20, 1, 50);
    const matches = searchImportedText(text, query, limit).map(match => {
      if (call.requestedBy !== 'chat') return match;
      const fragment = textFilePart(cacheId, record.name, text, Math.max(0, match.start - 60), Math.min(4000, match.end - match.start + 120));
      return { ...match, excerpt: fragment.text, excerptStart: fragment.start, excerptEnd: fragment.end };
    });
    while (matches.length && !textFileDataFits({ cacheId, name: record.name, matches })) matches.pop();
    if (!matches.length) {
      return createToolErrorResult(
        call,
        createToolError('EXECUTION_FAILED', `没有在 ${record.name} 中找到：${query}`),
        `没有在文件中搜到“${query}”`,
      );
    }
    return createToolSuccessResult(call, `在 ${record.name} 中找到 ${matches.length} 处“${query}”`, {
      cacheId,
      name: record.name,
      query,
      matches,
      totalMatchesReturned: matches.length,
    });
  } catch (error) {
    return fileError(call, error, '没有搜索到文件内容');
  }
}

async function executeWriteText(call: JunLuoToolCall, context?: JunLuoToolExecutorContext): Promise<JunLuoToolResult<FileWriteData>> {
  const rawName = readStringInput(call.input, 'name') || readStringInput(call.input, 'fileName') || 'junluo-note.md';
  const name = /\.[^./\\]+$/.test(rawName) ? rawName : `${rawName}.txt`;
  const text = typeof call.input.text === 'string' ? call.input.text : typeof call.input.content === 'string' ? call.input.content : '';
  if (call.requestedBy === 'chat' && !context?.textFileChat) return validationFailed(call, 'INVALID_ARGUMENTS', '没有保存文件');
  if (!text.trim()) return validationFailed(call, 'text 不能为空', '没有保存文件');
  if (text.length > MAX_WRITE_CHARS) {
    return validationFailed(call, `text 超过 ${MAX_WRITE_CHARS} 字符`, '没有保存文件：内容太长');
  }
  if (!isSupportedTextFileName(name)) {
    return validationFailed(call, `不支持的文件类型：${name}`, '没有保存文件：只支持 txt/md/markdown/json/csv');
  }
  try {
    const file = await runToolDataCommit(context, async () => {
      if (context?.textFileChat && !await context.textFileChat.isCurrent()) throw new Error('STALE_DATA_EPOCH');
      return writeTextFileToCache({ name, text, mimeType: inferMimeType(name), cacheId: context?.textFileChat?.cacheId });
    });
    return createToolSuccessResult(call, `已保存文本文件：${summarizeFile(file)}`, { file });
  } catch (error) {
    return fileError(call, error, '没有保存文件');
  }
}

async function executeCopy(call: JunLuoToolCall): Promise<JunLuoToolResult<FileCopyData>> {
  const cacheId = requireCacheId(call);
  if (!cacheId) return validationFailed(call, 'cacheId 不能为空', '没有复制文件');
  try {
    const source = await getFileImportRecord(cacheId);
    if (!source) throw new Error(`文件缓存不存在：${cacheId}`);
    const file = await copyFileRecordToCache(cacheId, readStringInput(call.input, 'newName'));
    return createToolSuccessResult(call, `已复制文件：${source.name} -> ${file.name}`, { source, file });
  } catch (error) {
    return fileError(call, error, '没有复制文件');
  }
}

async function executeMove(call: JunLuoToolCall): Promise<JunLuoToolResult<FileMoveData>> {
  const cacheId = requireCacheId(call);
  const newName = readStringInput(call.input, 'newName') || readStringInput(call.input, 'name');
  if (!cacheId) return validationFailed(call, 'cacheId 不能为空', '没有归档文件');
  if (!newName) return validationFailed(call, 'newName 不能为空', '没有归档文件');
  try {
    const { source, renamed: file } = await renameFileRecordInCache(cacheId, newName);
    return createToolSuccessResult(call, `已归档并生成新文件名：${source.name} -> ${file.name}`, { source, file });
  } catch (error) {
    return fileError(call, error, '没有归档文件');
  }
}

async function executeZip(call: JunLuoToolCall): Promise<JunLuoToolResult<FileZipData>> {
  const cacheIds = readStringArrayInput(call.input, 'cacheIds');
  const name = readStringInput(call.input, 'name') || DEFAULT_ZIP_NAME;
  if (!cacheIds.length) return validationFailed(call, 'cacheIds 不能为空', '没有打包文件');
  if (cacheIds.length > MAX_ZIP_FILES) return validationFailed(call, `一次最多打包 ${MAX_ZIP_FILES} 个文件`, '没有打包文件：文件太多');
  if (!isSupportedZipFileName(name)) return validationFailed(call, '压缩包文件名必须以 .zip 结尾', '没有打包文件');
  try {
    const zip = new JSZip();
    const sourceFiles: JunLuoFileImportRecord[] = [];
    for (const cacheId of cacheIds) {
      const record = await getFileImportRecord(cacheId);
      if (!record) throw new Error(`文件缓存不存在：${cacheId}`);
      sourceFiles.push(record);
      if ((record.kind ?? (record.extension === 'zip' ? 'zip' : 'text')) === 'zip') {
        const { base64 } = await readImportedBase64(cacheId);
        zip.file(record.name, base64, { base64: true });
      } else {
        const { text } = await readImportedText(cacheId);
        zip.file(record.name, text);
      }
    }
    const base64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const file = await writeZipFileToCache({ name, base64, sourceCacheIds: cacheIds });
    return createToolSuccessResult(call, `已打包 ${sourceFiles.length} 个文件：${file.name}`, { file, sourceFiles });
  } catch (error) {
    return fileError(call, error, '没有打包文件');
  }
}

async function pickZipArchive(call: JunLuoToolCall) {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
    type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
  });
  if (result.canceled) throw new Error('用户没有选择压缩包');
  const asset = result.assets?.[0];
  if (!asset?.uri) throw new Error('文件选择器没有返回可用压缩包');
  if (asset.name && !isSupportedZipFileName(asset.name)) throw new Error(`不支持的压缩包类型：${asset.name}`);
  return registerPickedZipFile({ mimeType: asset.mimeType, name: asset.name, size: asset.size, uri: asset.uri });
}

async function executeUnzip(call: JunLuoToolCall): Promise<JunLuoToolResult<FileUnzipData>> {
  try {
    const inputCacheId = requireCacheId(call);
    const archive = inputCacheId ? await getFileImportRecord(inputCacheId) : await pickZipArchive(call);
    if (!archive) throw new Error(`文件缓存不存在：${inputCacheId}`);
    if ((archive.kind ?? archive.extension) !== 'zip' && archive.extension !== 'zip') {
      throw new Error(`文件不是 zip 压缩包：${archive.name}`);
    }
    const { base64 } = await readImportedBase64(archive.cacheId);
    const zip = await JSZip.loadAsync(base64, { base64: true });
    const files: JunLuoFileImportRecord[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    let totalChars = 0;
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const safeName = entry.name.split(/[\\/]/).pop() || entry.name;
      if (!isSupportedTextFileName(safeName)) {
        skipped.push({ name: entry.name, reason: 'unsupported_extension' });
        continue;
      }
      if (files.length >= MAX_UNZIP_TEXT_FILES) {
        skipped.push({ name: entry.name, reason: 'too_many_files' });
        continue;
      }
      const text = await entry.async('text');
      totalChars += text.length;
      if (totalChars > MAX_UNZIP_TOTAL_CHARS) {
        skipped.push({ name: entry.name, reason: 'too_large' });
        totalChars -= text.length;
        continue;
      }
      files.push(await writeTextFileToCache({
        name: safeName,
        text,
        mimeType: inferMimeType(safeName),
        sourceCacheIds: [archive.cacheId],
      }));
    }
    if (!files.length) {
      return createToolErrorResult(
        call,
        createToolError('EXECUTION_FAILED', '压缩包里没有可登记的 txt/md/markdown/json/csv 文本文件'),
        '没有解压出可用文本文件',
      );
    }
    return createToolSuccessResult(call, `已从 ${archive.name} 解压并登记 ${files.length} 个文本文件`, { archive, files, skipped });
  } catch (error) {
    return fileError(call, error, '没有解压文件');
  }
}


async function executeExternalAccessStatus(call: JunLuoToolCall): Promise<JunLuoToolResult<ExternalFilesStatusData>> {
  const status = await getExternalFilesAccessStatus();
  if (!status.available) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', '当前安装包还没有外部文件访问模块', status),
      '当前安装包还没有外部文件访问模块',
    );
  }
  return createToolSuccessResult(
    call,
    status.hasAllFilesAccess ? '君落已经拥有全部文件访问权限' : '君落还没有全部文件访问权限',
    status,
  );
}

async function executeOpenExternalAccessSettings(call: JunLuoToolCall): Promise<JunLuoToolResult<{ opened: boolean }>> {
  const opened = await openExternalFilesAccessSettings();
  if (!opened) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', '没有打开全部文件访问设置页'),
      '没有打开全部文件访问设置页',
    );
  }
  return createToolSuccessResult(call, '已打开全部文件访问设置页', { opened });
}

async function executeScanExternalFiles(call: JunLuoToolCall): Promise<JunLuoToolResult<ExternalFilesScanData>> {
  const limit = clampInteger(readNumberInput(call.input, 'limit'), 60, 1, 200);
  const query = readStringInput(call.input, 'query');
  const raw = await scanExternalFiles({
    extensions: readExtensionsInput(call.input),
    limit,
    maxDepth: clampInteger(readNumberInput(call.input, 'maxDepth'), 5, 1, 8),
    query,
  }) as { ok?: boolean; files?: ExternalFileSummary[]; diagnostics?: unknown[] };
  if (!raw.ok) return externalNativeError(call, raw, '没有扫描到外部文件');
  const files = Array.isArray(raw.files) ? raw.files : [];
  if (!files.length) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', '没有在外部目录里找到符合条件的文件', raw),
      query ? `没有在手机外部目录里找到“${query}”` : '没有在手机外部目录里找到可用文件',
    );
  }
  return createToolSuccessResult(call, `在手机外部目录里找到 ${files.length} 个候选文件`, {
    files,
    diagnostics: raw.diagnostics ?? [],
    query,
    limit,
  });
}

async function executeSearchExternalFiles(call: JunLuoToolCall): Promise<JunLuoToolResult<ExternalFilesScanData>> {
  const query = readStringInput(call.input, 'query');
  if (!query) return validationFailed(call, 'query 不能为空', '没有搜索外部文件');
  return executeScanExternalFiles({ ...call, input: { ...call.input, query } });
}

async function executeExternalFileInfo(call: JunLuoToolCall): Promise<JunLuoToolResult<ExternalFileInfoData>> {
  const externalFileId = requireExternalFileId(call);
  if (!externalFileId) return validationFailed(call, 'externalFileId 不能为空', '没有读取外部文件信息');
  const raw = await getExternalFileInfo(externalFileId) as { ok?: boolean; file?: ExternalFileSummary };
  if (!raw.ok || !raw.file) return externalNativeError(call, raw, '没有读取外部文件信息');
  return createToolSuccessResult(call, `外部文件信息：${raw.file.name}`, { file: raw.file });
}

async function executeImportExternalFile(
  call: JunLuoToolCall,
  context?: JunLuoToolExecutorContext,
): Promise<JunLuoToolResult<ExternalFileImportData>> {
  const externalFileId = requireExternalFileId(call);
  if (!externalFileId) return validationFailed(call, 'externalFileId 不能为空', '没有导入外部文件');
  const copied = await copyExternalFileToCache(externalFileId) as {
    ok?: boolean;
    cacheUri?: string;
    source?: ExternalFileSummary;
    message?: string;
  };
  if (!copied.ok || !copied.cacheUri || !copied.source) {
    return externalNativeError(call, copied, '没有导入外部文件');
  }
  const cacheUri = copied.cacheUri;
  const externalFile = copied.source;
  const extension = extensionOfFile(externalFile);
  try {
    if (isTextExtension(extension)) {
      const file = await runToolDataCommit(context, () => registerPickedTextFile({
        mimeType: externalFile.mimeType,
        name: externalFile.name,
        size: externalFile.size,
        uri: cacheUri,
      }));
      return createToolSuccessResult(call, `已导入外部文本文件：${summarizeFile(file)}`, {
        externalFile,
        file,
        importKind: 'text',
      });
    }
    if (extension === 'zip') {
      const file = await runToolDataCommit(context, () => registerPickedZipFile({
        mimeType: externalFile.mimeType,
        name: externalFile.name,
        size: externalFile.size,
        uri: cacheUri,
      }));
      return createToolSuccessResult(call, `已导入外部 zip 文件：${summarizeFile(file)}`, {
        externalFile,
        file,
        importKind: 'zip',
      });
    }
    if (extension === 'epub') {
      const book = await importEpubBookFromUri({
        name: externalFile.name,
        size: externalFile.size,
        uri: cacheUri,
      }, {
        runDataEpochCommit: context?.runBackupRestoreDataEpochCommit,
      });
      return createToolSuccessResult(call, `已把 EPUB 导入共读书库：《${book.title}》`, {
        externalFile,
        book: {
          id: book.id,
          title: book.title,
          author: book.author,
          totalChapters: book.totalChapters,
          fileType: book.fileType,
        },
        importKind: 'epub',
      });
    }
    if (extension === 'pdf' || extension === 'docx') {
      const file = await runToolDataCommit(context, () => registerRawFileCopy({
        directoryTag: externalFile.directoryTag,
        externalFileId,
        externalPath: externalFile.path,
        mimeType: externalFile.mimeType,
        name: externalFile.name,
        size: externalFile.size,
        uri: cacheUri,
      }));
      return createToolSuccessResult(call, `已登记外部原始文件：${file.name}（暂不能解析正文）`, {
        externalFile,
        file,
        importKind: 'raw',
      });
    }
    return validationFailed(call, `暂不支持导入 ${extension || 'unknown'} 文件`, '没有导入外部文件');
  } catch (error) {
    return fileError(call, error, '没有导入外部文件');
  }
}

async function executeDeleteExternalFile(call: JunLuoToolCall): Promise<JunLuoToolResult<ExternalDangerousFileData>> {
  const externalFileId = requireExternalFileId(call);
  if (!externalFileId) return validationFailed(call, 'externalFileId 不能为空', '没有删除外部文件');
  try {
    const backup = await backupExternalFile(call, externalFileId);
    const raw = await deleteExternalFile(externalFileId) as { ok?: boolean; file?: ExternalFileSummary; message?: string };
    if (!raw.ok) return externalNativeError(call, raw, '没有删除外部文件');
    return createToolSuccessResult(call, `已备份并删除外部文件`, { externalFile: raw.file, backup, result: raw });
  } catch (error) {
    return fileError(call, error, '没有删除外部文件');
  }
}

async function executeOverwriteExternalFile(call: JunLuoToolCall): Promise<JunLuoToolResult<ExternalDangerousFileData>> {
  const externalFileId = requireExternalFileId(call);
  const sourceCacheId = readStringInput(call.input, 'sourceCacheId');
  if (!externalFileId) return validationFailed(call, 'externalFileId 不能为空', '没有覆盖外部文件');
  if (!sourceCacheId) return validationFailed(call, 'sourceCacheId 不能为空', '没有覆盖外部文件');
  try {
    const source = await getFileImportRecord(sourceCacheId);
    if (!source) throw new Error(`文件缓存不存在：${sourceCacheId}`);
    const backup = await backupExternalFile(call, externalFileId);
    const raw = await overwriteExternalFile(externalFileId, source.uri) as { ok?: boolean; file?: ExternalFileSummary; message?: string };
    if (!raw.ok) return externalNativeError(call, raw, '没有覆盖外部文件');
    return createToolSuccessResult(call, `已备份并覆盖外部文件`, { externalFile: raw.file, backup, result: raw });
  } catch (error) {
    return fileError(call, error, '没有覆盖外部文件');
  }
}

async function executeMoveExternalFile(call: JunLuoToolCall): Promise<JunLuoToolResult<ExternalDangerousFileData>> {
  const externalFileId = requireExternalFileId(call);
  const targetDirectoryTag = readStringInput(call.input, 'targetDirectoryTag');
  if (!externalFileId) return validationFailed(call, 'externalFileId 不能为空', '没有移动外部文件');
  if (!targetDirectoryTag) return validationFailed(call, 'targetDirectoryTag 不能为空', '没有移动外部文件');
  try {
    const backup = await backupExternalFile(call, externalFileId);
    const raw = await moveExternalFile(externalFileId, targetDirectoryTag) as { ok?: boolean; file?: ExternalFileSummary; message?: string };
    if (!raw.ok) return externalNativeError(call, raw, '没有移动外部文件');
    return createToolSuccessResult(call, `已备份并移动外部文件`, { externalFile: raw.file, backup, result: raw });
  } catch (error) {
    return fileError(call, error, '没有移动外部文件');
  }
}

async function executeOpen(call: JunLuoToolCall): Promise<JunLuoToolResult<FileOpenShareData>> {
  const cacheId = requireCacheId(call);
  if (!cacheId) return validationFailed(call, 'cacheId 不能为空', '没有打开文件');
  try {
    const file = await getFileImportRecord(cacheId);
    if (!file) throw new Error(`文件缓存不存在：${cacheId}`);
    if (typeof Linking.openURL !== 'function') throw new Error('当前环境没有可用的系统打开能力');
    await Linking.openURL(file.uri);
    return createToolSuccessResult(call, `已交给系统打开文件：${file.name}`, { file, action: 'open' });
  } catch (error) {
    return fileError(call, error, '没有打开文件');
  }
}

async function executeShare(call: JunLuoToolCall): Promise<JunLuoToolResult<FileOpenShareData>> {
  const cacheId = requireCacheId(call);
  if (!cacheId) return validationFailed(call, 'cacheId 不能为空', '没有打开分享面板');
  try {
    const file = await getFileImportRecord(cacheId);
    if (!file) throw new Error(`文件缓存不存在：${cacheId}`);
    if (!(await Sharing.isAvailableAsync())) throw new Error('当前设备没有可用的系统分享面板');
    await Sharing.shareAsync(file.uri, { mimeType: file.mimeType, dialogTitle: `分享 ${file.name}` });
    return createToolSuccessResult(call, `已打开系统分享面板：${file.name}`, { file, action: 'share' });
  } catch (error) {
    return fileError(call, error, '没有打开分享面板');
  }
}


const externalFileIdSchema = {
  type: 'object' as const,
  properties: {
    externalFileId: { type: 'string' as const, description: '通过 files.scan_external_files / files.search_external_files 返回的外部文件 ID。' },
  },
  required: ['externalFileId'],
};

const cacheIdSchema = {
  type: 'object' as const,
  properties: {
    cacheId: { type: 'string' as const, description: '通过 files.pick_document 或 files.write_text 返回的文件缓存 ID。' },
  },
  required: ['cacheId'],
};

const writableToolCommon: Pick<JunLuoToolDefinition, 'permission' | 'riskLevel' | 'readOnly'> = {
  permission: 'ask',
  riskLevel: 'write_local',
  readOnly: false,
};

export const filesToolPackage: JunLuoToolPackage = {
  id: 'files',
  name: '本地文件',
  description: TEXT_FILE_CATALOG_DESCRIPTION,
  category: 'files',
  defaultEnabled: true,
  riskLevel: 'write_local',
  source: 'builtin',
  tools: [
    {
      id: 'files.pick_document',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '选择文字文件',
      description: '打开系统文件选择器，由 you 选择一份想交给 I 阅读的文字文件，并读取开头最多 4000 字符。',
      inputSchema: { type: 'object' },
      permission: 'allow',
      riskLevel: 'write_local',
      readOnly: false,
      agentEpochMode: 'bounded_local_commits',
      executionScope: 'local_device',
      backupRestoreSafeOutsideLease: true,
      executor: executePickDocument,
    },
    {
      id: 'files.list_recent_imports',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '列出最近登记文件',
      description: '列出最近登记到工具文件缓存的文件摘要。',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多返回多少条，默认 10。' },
        },
      },
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeListRecentImports,
    },
    {
      id: 'files.file_info',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '读取文件信息',
      description: '根据 cacheId 查看文件名、类型、大小、字符数和导入时间。',
      inputSchema: cacheIdSchema,
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeFileInfo,
    },
    {
      id: 'files.read_text',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '读取文件',
      description: '读取已登记文字文件的正文。较长的文件可以分段阅读。',
      inputSchema: {
        type: 'object',
        properties: {
          cacheId: { type: 'string', description: TEXT_FILE_ID_DESCRIPTION },
        },
        required: ['cacheId'],
      },
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeReadText,
    },
    {
      id: 'files.read_part',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '分段读取',
      description: '从指定位置继续读取已登记文字文件，每次最多 4000 字符。',
      inputSchema: {
        type: 'object',
        properties: {
          cacheId: { type: 'string', description: TEXT_FILE_ID_DESCRIPTION },
          start: { type: 'number', description: '首次从 0 开始；继续阅读时，沿用上次回执中的结束位置。' },
        },
        required: ['cacheId'],
      },
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeReadPart,
    },
    {
      id: 'files.search_text',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '查找文件内容',
      description: '在已登记的文字文件里查找关键词，返回命中位置和附近原文。',
      inputSchema: {
        type: 'object',
        properties: {
          cacheId: { type: 'string', description: TEXT_FILE_ID_DESCRIPTION },
          query: { type: 'string', description: '想在文件里查找的文字。' },
        },
        required: ['cacheId', 'query'],
      },
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeSearchText,
    },
    {
      id: 'files.get_external_access_status',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '检查外部文件访问权限',
      description: '检查 Android 全部文件访问权限和可扫描目录状态。',
      inputSchema: { type: 'object' },
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeExternalAccessStatus,
    },
    {
      id: 'files.open_external_access_settings',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '打开全部文件访问设置',
      description: '打开系统设置，让用户授予君落全部文件访问权限。',
      inputSchema: { type: 'object' },
      permission: 'ask',
      riskLevel: 'device_control',
      readOnly: false,
      executor: executeOpenExternalAccessSettings,
    },
    {
      id: 'files.scan_external_files',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '扫描手机外部文件',
      description: '扫描 Download、Documents、QQ/微信接收文件等常见目录，返回候选文件摘要。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选文件名关键词。' },
          extensions: { type: 'array', description: '可选扩展名列表。' },
          limit: { type: 'number', description: '最多返回多少个候选，默认 60。' },
          maxDepth: { type: 'number', description: '扫描深度，默认 5。' },
        },
      },
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeScanExternalFiles,
    },
    {
      id: 'files.search_external_files',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '搜索手机外部文件',
      description: '按文件名、路径或扩展名搜索手机外部文件。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词。' },
          extensions: { type: 'array', description: '可选扩展名列表。' },
          limit: { type: 'number', description: '最多返回多少个候选。' },
        },
        required: ['query'],
      },
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeSearchExternalFiles,
    },
    {
      id: 'files.external_file_info',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '读取外部文件信息',
      description: '根据 externalFileId 查看外部文件路径、大小、类型和修改时间。',
      inputSchema: externalFileIdSchema,
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeExternalFileInfo,
    },
    {
      id: 'files.import_external_file',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '导入外部文件',
      description: '把外部文本/zip 导入文件缓存；EPUB 导入共读书库；PDF/DOCX 只登记原始文件。',
      inputSchema: externalFileIdSchema,
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      backupRestoreSafeOutsideLease: true,
      executor: executeImportExternalFile,
    },
    {
      id: 'files.delete_external_file',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '删除外部文件',
      description: '危险工具：删除外部文件。执行前会尝试备份到君落缓存。',
      inputSchema: externalFileIdSchema,
      permission: 'deny',
      riskLevel: 'dangerous',
      readOnly: false,
      executor: executeDeleteExternalFile,
    },
    {
      id: 'files.overwrite_external_file',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '覆盖外部文件',
      description: '危险工具：用已有缓存文件覆盖外部文件。执行前会尝试备份原文件。',
      inputSchema: {
        type: 'object',
        properties: {
          externalFileId: { type: 'string', description: '外部文件 ID。' },
          sourceCacheId: { type: 'string', description: '用于覆盖的缓存文件 cacheId。' },
        },
        required: ['externalFileId', 'sourceCacheId'],
      },
      permission: 'deny',
      riskLevel: 'dangerous',
      readOnly: false,
      executor: executeOverwriteExternalFile,
    },
    {
      id: 'files.move_external_file',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '移动外部文件',
      description: '危险工具：把外部文件移动到原生桥允许的安全目录标签。执行前会尝试备份。',
      inputSchema: {
        type: 'object',
        properties: {
          externalFileId: { type: 'string', description: '外部文件 ID。' },
          targetDirectoryTag: { type: 'string', description: '目标目录标签，例如 download/documents。' },
        },
        required: ['externalFileId', 'targetDirectoryTag'],
      },
      permission: 'deny',
      riskLevel: 'dangerous',
      readOnly: false,
      executor: executeMoveExternalFile,
    },
    {
      id: 'files.write_text',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '保存新作品',
      description: '在聊天中把文字保存为一份新文件，也可以制作想送给 you 的小作品。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '这份作品的文件名。' },
          text: { type: 'string', description: '要完整保存在文件里的文字。' },
        },
        required: ['name', 'text'],
      },
      ...writableToolCommon,
      permission: 'allow',
      agentEpochMode: 'bounded_local_commits',
      backupRestoreSafeOutsideLease: true,
      executionScope: 'local_device',
      executor: executeWriteText,
    },
    {
      id: 'files.copy',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '复制缓存文件',
      description: '根据 cacheId 复制出新的缓存文件，不覆盖源文件。',
      inputSchema: {
        type: 'object',
        properties: {
          cacheId: { type: 'string', description: '源文件 cacheId。' },
          newName: { type: 'string', description: '可选的新文件名。' },
        },
        required: ['cacheId'],
      },
      ...writableToolCommon,
      executor: executeCopy,
    },
    {
      id: 'files.move',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '归档并改名缓存文件',
      description: '第一版只生成一个改名后的新缓存记录，并标记源记录已归档，不移动到任意系统路径。',
      inputSchema: {
        type: 'object',
        properties: {
          cacheId: { type: 'string', description: '源文件 cacheId。' },
          newName: { type: 'string', description: '新文件名。' },
        },
        required: ['cacheId', 'newName'],
      },
      ...writableToolCommon,
      executor: executeMove,
    },
    {
      id: 'files.zip',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '打包缓存文件',
      description: '把多个已登记缓存文件打成 zip，并登记新的 zip cacheId。',
      inputSchema: {
        type: 'object',
        properties: {
          cacheIds: { type: 'array', description: '要打包的 cacheId 列表。' },
          name: { type: 'string', description: 'zip 文件名，必须以 .zip 结尾。' },
        },
        required: ['cacheIds'],
      },
      ...writableToolCommon,
      executor: executeZip,
    },
    {
      id: 'files.unzip',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '解压安全文本文件',
      description: '从 zip 中解压并登记安全文本文件，只登记 txt/md/markdown/json/csv，跳过其他类型。',
      inputSchema: {
        type: 'object',
        properties: {
          cacheId: { type: 'string', description: '可选 zip 文件 cacheId；不提供时打开系统选择器选择 zip。' },
        },
      },
      ...writableToolCommon,
      executor: executeUnzip,
    },
    {
      id: 'files.open',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '用系统打开文件',
      description: '把缓存文件交给系统打开；失败时返回不可用，不伪装打开成功。',
      inputSchema: cacheIdSchema,
      permission: 'ask',
      riskLevel: 'device_control',
      readOnly: false,
      executor: executeOpen,
    },
    {
      id: 'files.share',
      chatExposure: 'explicit_only',
      proactiveEligible: false,
      packageId: 'files',
      name: '打开系统分享面板',
      description: '调用系统分享面板分享缓存文件；只代表已打开分享流程，不代表用户最终发送。',
      inputSchema: cacheIdSchema,
      permission: 'ask',
      riskLevel: 'social_action',
      readOnly: false,
      executor: executeShare,
    },
  ],
};
