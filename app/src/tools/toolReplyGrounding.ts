import type { JunLuoToolResult } from './toolTypes';
import { isPhoneLimitToolId } from './phoneLimitContract';
import { isBodySignalHistoryTool } from './bodySignalHistoryToolDefinition';
import { buildWishToolResultFallback, isWishToolId } from '../wishPool/wishToolContract';

function isEmptyResearchSearchResult(result: JunLuoToolResult) {
  if (result.toolId !== 'research.search' && result.toolId !== 'research.search_with_diagnostics') return false;
  const data = result.data as { results?: unknown } | undefined;
  return result.ok && Array.isArray(data?.results) && data.results.length === 0;
}

function resultStatusLabel(result: JunLuoToolResult) {
  if (isEmptyResearchSearchResult(result)) return '无结果';
  if (result.ok) return '成功';
  if (result.status === 'permission_denied') return '权限未允许';
  if (result.status === 'cancelled') return '已取消';
  return '失败';
}

function formatResultLine(result: JunLuoToolResult) {
  const error = result.error ? `；错误：${result.error.message}` : '';
  return `${result.toolId}：${resultStatusLabel(result)}；${result.summary}${error}`;
}

function uniqueVisibleResults(results: JunLuoToolResult[]) {
  const callIds = new Set<string>();
  return results.filter((result) => {
    if (result.toolId === 'system.use_package' || isBodySignalHistoryTool(result.toolId) || callIds.has(result.callId)) return false;
    callIds.add(result.callId);
    return true;
  });
}

export function buildToolResultInstruction(
  results: JunLuoToolResult[],
  options: { nativeResultCallIds?: readonly string[] } = {},
) {
  const visibleResults = uniqueVisibleResults(results);
  const wishResults = visibleResults.filter(result => isWishToolId(result.toolId)
    && !options.nativeResultCallIds?.includes(result.callId));
  // Phone facts travel only in the reviewed, paired native tool result. The
  // legacy system fallback must not leak an error when that replay is absent.
  const otherResults = visibleResults.filter(result => !isWishToolId(result.toolId) && !isPhoneLimitToolId(result.toolId)
    && !(result.toolId === 'http.call_named_service' && options.nativeResultCallIds !== undefined));
  const otherInstruction = !otherResults.length ? '' : [
    '【I 刚刚拿到的结果】',
    '',
    ...otherResults.map(formatResultLine),
    '',
    '这些是 I 刚刚实际拿到的结果。做成的事，I 可以安心告诉 you；没有做成，或只走到中间一步的事，I 也告诉 you 现在停在哪里。',
  ].join('\n');
  return [otherInstruction, ...wishResults.map(buildWishToolResultFallback)].filter(Boolean).join('\n\n');
}

