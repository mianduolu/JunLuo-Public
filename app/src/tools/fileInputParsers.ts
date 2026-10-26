export type FileIntentRoute = {
  candidateTools: string[];
  reason:
    | 'file_pick_read'
    | 'file_pick_search'
    | 'file_info'
    | 'file_list_recent'
    | 'file_write_text'
    | 'file_copy'
    | 'file_move'
    | 'file_zip'
    | 'file_unzip'
    | 'file_open'
    | 'file_share'
    | 'file_external_status'
    | 'file_external_search'
    | 'file_external_import'
    | 'file_external_dangerous';
};

const FILE_TEXT_PATTERN = /(?:文件|文档|资料|txt|markdown|md|csv|json|zip|压缩包|epub|电子书|pdf|docx|下载|目录|文件夹|红米)/i;

const FILE_EXTERNAL_STATUS_PATTERN = /(?:全部文件访问|外部文件权限|文件访问权限|访问手机文件|授权文件目录)/i;
const FILE_EXTERNAL_DANGEROUS_PATTERN =
  /(?:删除|删掉|覆盖|改写|移动).{0,24}(?:外部文件|手机文件|下载文件|目录文件|externalFileId)/i;
const FILE_EXTERNAL_IMPORT_PATTERN =
  /(?:导入|加入|加进|收进).{0,28}(?:外部文件|手机文件|下载文件|epub|电子书|共读|externalFileId)|(?:把这本|这本).{0,18}(?:epub|电子书).{0,18}(?:导入|加进|加入|收进)/i;
const FILE_EXTERNAL_SEARCH_PATTERN =
  /(?:找|搜索|搜|查找|揪出).{0,28}(?:手机里|手机文件|外部文件|下载|Download|QQ|微信|目录|文件夹|红米)|(?:手机里|外部文件|下载|Download|QQ|微信|红米).{0,28}(?:找|搜索|搜|查找|文件|文档|epub|pdf|docx)/i;
const FILE_PICK_READ_PATTERN =
  /(?:读(?:一下)?|打开|看看|看一下|总结|概括|读给你看|给你看).{0,18}(?:文件|文档|资料|txt|markdown|md|csv|json)|(?:文件|文档|资料).{0,18}(?:总结|概括|内容|写了什么)/i;
const FILE_SEARCH_PATTERN =
  /(?:在|从).{0,12}(?:文件|文档|资料).{0,18}(?:找|搜索|搜|查找)|(?:文件|文档|资料).{0,18}(?:找|搜索|搜|查找).{0,24}(?:内容|关键词|有没有|哪里)/i;
const FILE_INFO_PATTERN =
  /(?:文件|文档|资料).{0,12}(?:信息|大小|类型|字符数|cacheId|缓存)/i;
const FILE_LIST_PATTERN =
  /(?:最近|已导入|导入过|缓存).{0,12}(?:文件|文档|资料)|(?:文件|文档).{0,12}(?:列表|有哪些)/i;
const FILE_WRITE_PATTERN =
  /(?:保存|存成|保存成|写到|写入|导出|导出成|导出为).{0,18}(?:文件|文档|txt|markdown|md|csv|json)/i;
const FILE_COPY_PATTERN = /(?:复制|拷贝).{0,18}(?:文件|文档|资料|cacheId|缓存)/i;
const FILE_MOVE_PATTERN = /(?:重命名|改名|归档|整理).{0,18}(?:文件|文档|资料|cacheId|缓存)|(?:文件|文档|资料|cacheId|缓存).{0,28}(?:重命名|改名|归档|整理)/i;
const FILE_ZIP_PATTERN = /(?:打包|压缩|zip).{0,24}(?:文件|文档|资料|cacheId|缓存)|(?:文件|文档|资料).{0,80}(?:打包|压缩成|zip)/i;
const FILE_UNZIP_PATTERN = /(?:解压|展开).{0,18}(?:zip|压缩包|文件|文档|资料)|(?:zip|压缩包).{0,18}(?:解压|展开)/i;
const FILE_SHARE_PATTERN = /(?:分享|发送给别人|发出去).{0,18}(?:文件|文档|资料|cacheId|缓存)/i;
const FILE_OPEN_PATTERN = /(?:打开).{0,18}(?:文件|文档|资料|cacheId|缓存)/i;

export function routeFileIntent(text: string): FileIntentRoute | null {
  const trimmed = text.trim();
  if (!trimmed || !FILE_TEXT_PATTERN.test(trimmed)) return null;
  if (FILE_EXTERNAL_STATUS_PATTERN.test(trimmed)) {
    return { candidateTools: ['files.get_external_access_status', 'files.open_external_access_settings'], reason: 'file_external_status' };
  }
  if (FILE_EXTERNAL_DANGEROUS_PATTERN.test(trimmed)) {
    if (/覆盖|改写/.test(trimmed)) return { candidateTools: ['files.overwrite_external_file'], reason: 'file_external_dangerous' };
    if (/移动/.test(trimmed)) return { candidateTools: ['files.move_external_file'], reason: 'file_external_dangerous' };
    return { candidateTools: ['files.delete_external_file'], reason: 'file_external_dangerous' };
  }
  if (FILE_EXTERNAL_IMPORT_PATTERN.test(trimmed)) {
    return { candidateTools: ['files.search_external_files', 'files.import_external_file'], reason: 'file_external_import' };
  }
  if (FILE_EXTERNAL_SEARCH_PATTERN.test(trimmed)) {
    return { candidateTools: ['files.search_external_files'], reason: 'file_external_search' };
  }
  if (FILE_WRITE_PATTERN.test(trimmed)) {
    return { candidateTools: ['files.write_text'], reason: 'file_write_text' };
  }
  if (FILE_UNZIP_PATTERN.test(trimmed)) {
    return { candidateTools: ['files.unzip'], reason: 'file_unzip' };
  }
  if (FILE_ZIP_PATTERN.test(trimmed)) {
    return { candidateTools: ['files.zip'], reason: 'file_zip' };
  }
  if (FILE_SHARE_PATTERN.test(trimmed)) {
    return { candidateTools: ['files.share'], reason: 'file_share' };
  }
  if (FILE_COPY_PATTERN.test(trimmed)) {
    return { candidateTools: ['files.copy'], reason: 'file_copy' };
  }
  if (FILE_MOVE_PATTERN.test(trimmed)) {
    return { candidateTools: ['files.move'], reason: 'file_move' };
  }
  if (FILE_LIST_PATTERN.test(trimmed)) {
    return { candidateTools: ['files.list_recent_imports'], reason: 'file_list_recent' };
  }
  if (FILE_INFO_PATTERN.test(trimmed)) {
    return { candidateTools: ['files.pick_document', 'files.file_info'], reason: 'file_info' };
  }
  if (FILE_SEARCH_PATTERN.test(trimmed)) {
    return { candidateTools: ['files.pick_document', 'files.search_text'], reason: 'file_pick_search' };
  }
  if (FILE_OPEN_PATTERN.test(trimmed)) {
    return { candidateTools: ['files.open'], reason: 'file_open' };
  }
  if (FILE_PICK_READ_PATTERN.test(trimmed)) {
    return { candidateTools: ['files.pick_document', 'files.read_text'], reason: 'file_pick_read' };
  }
  return null;
}

export function parseFileSearchInputFromText(text: string): Record<string, unknown> {
  const patterns = [
    /(?:找|搜索|搜|查找)(?:一下)?[“"']?([^“”"'，。！？?]{1,40})[”"']?/,
    /有没有[“"']?([^“”"'，。！？?]{1,40})[”"']?/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const query = match?.[1]?.replace(/(?:这个|那个)?(?:文件|文档|资料|里|里面|内容|关键词)$/g, '').trim();
    if (query) return { query, limit: 20 };
  }
  return { query: text.trim(), limit: 20 };
}

export function parseFileCacheIdFromText(text: string) {
  return /file-[a-zA-Z0-9-]+/.exec(text)?.[0];
}

export function parseFileCacheIdsFromText(text: string) {
  return Array.from(new Set(text.match(/file-[a-zA-Z0-9-]+/g) ?? []));
}

export function parseFileNameFromText(text: string, fallback: string) {
  const patterns = [
    /(?:文件名|命名为|改名为|重命名为|保存成|导出成|导出为|压缩成|打包成)\s*[“"']?([^“”"'，。！？?\s]+\.(?:txt|md|markdown|json|csv|zip))[”"']?/i,
    /[“"']([^“”"']+\.(?:txt|md|markdown|json|csv|zip))[”"']/i,
    /([^\s，。！？?]+\.(?:txt|md|markdown|json|csv|zip))/i,
  ];
  for (const pattern of patterns) {
    const name = pattern.exec(text)?.[1]?.trim();
    if (name) return name;
  }
  return fallback;
}

export function parseFileWriteInputFromText(text: string): Record<string, unknown> {
  const name = parseFileNameFromText(text, 'junluo-note.md');
  const contentMatch = /[：:](.+)$/s.exec(text);
  const textContent = contentMatch?.[1]?.trim() || text.replace(/(?:保存|存成|保存成|写到|写入|导出|导出成|导出为).{0,24}(?:文件|文档|txt|markdown|md|csv|json)/i, '').trim();
  return { name, text: textContent };
}

export function parseFileCopyInputFromText(text: string): Record<string, unknown> | null {
  const cacheId = parseFileCacheIdFromText(text);
  if (!cacheId) return null;
  return { cacheId, newName: parseFileNameFromText(text, '') || undefined };
}

export function parseFileMoveInputFromText(text: string): Record<string, unknown> | null {
  const cacheId = parseFileCacheIdFromText(text);
  if (!cacheId) return null;
  return { cacheId, newName: parseFileNameFromText(text, '') || undefined };
}

export function parseFileZipInputFromText(text: string): Record<string, unknown> | null {
  const cacheIds = parseFileCacheIdsFromText(text);
  if (!cacheIds.length) return null;
  return { cacheIds, name: parseFileNameFromText(text, 'junluo-files.zip') };
}

export function parseFileCacheIdInputFromText(text: string): Record<string, unknown> | null {
  const cacheId = parseFileCacheIdFromText(text);
  return cacheId ? { cacheId } : null;
}

export function parseExternalFileIdFromText(text: string) {
  return /(?:externalFileId[:：]?\s*)?([A-Za-z0-9_-]{16,}={0,2})/.exec(text)?.[1];
}

export function parseExternalFileSearchInputFromText(text: string): Record<string, unknown> {
  const explicit = /(?:找|搜索|搜|查找|揪出|导入|加入|加进|收进)(?:一下)?[“"']?([^“”"'，。！？?]{1,60})[”"']?/.exec(text)?.[1]?.trim();
  const query = explicit
    ?.replace(/(?:手机里|手机文件|外部文件|下载|Download|QQ|微信|目录|文件夹|红米|这个|那个|文件|文档|资料|epub|电子书|共读)$/g, '')
    .trim()
    || text.replace(/(?:帮我|请|一下|手机里|手机文件|外部文件|下载|Download|QQ|微信|目录|文件夹|红米|文件|文档|资料|找|搜索|搜|查找|揪出|导入|加入|加进|收进|共读)/g, ' ').trim();
  const lower = text.toLowerCase();
  const extensions: string[] = [];
  ['epub', 'pdf', 'docx', 'zip', 'txt', 'md', 'markdown', 'json', 'csv'].forEach((extension) => {
    if (lower.includes(extension)) extensions.push(extension);
  });
  if (/电子书|共读/.test(text) && !extensions.includes('epub')) extensions.push('epub');
  return {
    query: query || undefined,
    extensions: extensions.length ? extensions : undefined,
    limit: 30,
  };
}

export function parseExternalDangerousFileInputFromText(text: string): Record<string, unknown> | null {
  const externalFileId = parseExternalFileIdFromText(text);
  if (!externalFileId) return null;
  const input: Record<string, unknown> = { externalFileId };
  const sourceCacheId = parseFileCacheIdFromText(text);
  if (sourceCacheId) input.sourceCacheId = sourceCacheId;
  const target = /(?:移动到|移到|放到)\s*([a-zA-Z_]+)/.exec(text)?.[1];
  if (target) input.targetDirectoryTag = target;
  return input;
}

