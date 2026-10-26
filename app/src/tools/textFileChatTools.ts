import type { JunLuoToolResult } from './toolTypes';

export const TEXT_FILE_CHAT_TOOL_IDS = [
  'files.pick_document', 'files.read_text', 'files.read_part', 'files.search_text', 'files.write_text',
] as const;
export const TEXT_FILE_WRITE_TOOL_IDS: readonly string[] = ['files.pick_document', 'files.write_text'];
export const TEXT_FILE_CATALOG_DESCRIPTION = '选择、读取和查找文字文件，也可以在聊天中保存一份新作品。';
export const TEXT_FILE_ID_DESCRIPTION = '要读取或查找的文件编号，沿用工具返回的编号。';
export function isTextFileChatTool(id: string) {
  return (TEXT_FILE_CHAT_TOOL_IDS as readonly string[]).includes(id);
}

/** Reserve envelope/summary space inside the existing 12000-character tool receipt. */
export function textFileDataFits(data: unknown) {
  return JSON.stringify(data).length <= 10_000;
}

export function textFilePart(cacheId: string, name: string, text: string, start = 0, length = 4000) {
  let end = Math.min(text.length, start + length);
  const data = () => ({ cacheId, name, start, end, text: text.slice(start, end),
    charCount: text.length, hasMore: end < text.length });
  while (end > start && !textFileDataFits(data())) end = start + Math.floor((end - start) * 0.8);
  // Do not cut a UTF-16 surrogate pair; offsets still match String.slice.
  if (end < text.length && end > start && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return { ...data(), length: end - start };
}

/** Raw local receipts remain available to the card; model receipts never contain local URIs. */
export function projectTextFileResult(result: JunLuoToolResult): JunLuoToolResult {
  if (!isTextFileChatTool(result.toolId)) return result;
  if (!result.ok) return { ...result, data: undefined, error: result.error ? {
    ...result.error, message: result.summary || result.error.code, details: undefined,
  } : undefined };
  if (!result.data) return result;
  const raw = result.data as Record<string, unknown>;
  const data = result.toolId === 'files.write_text' ? raw.file as Record<string, unknown> : raw;
  if (!data) return { ...result, data: undefined };
  const keys = result.toolId === 'files.write_text' ? ['cacheId', 'name', 'charCount']
    : ['cacheId', 'name', 'text', 'start', 'end', 'charCount', 'hasMore', 'matches'];
  return { ...result, data: Object.fromEntries(keys.filter(key => data[key] !== undefined).map(key => [key, data[key]])) };
}
