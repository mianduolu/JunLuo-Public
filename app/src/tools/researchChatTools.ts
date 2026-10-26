import type { JunLuoRegisteredToolDefinition, JunLuoToolResult } from './toolTypes';

export const RESEARCH_CHAT_TOOL_IDS = ['research.search', 'research.fetch_page'];

/** Chat-only wording; the wider research package and web voyage retain their definitions. */
export function researchChatToolDefinition(tool: JunLuoRegisteredToolDefinition): JunLuoRegisteredToolDefinition {
  if (tool.id === 'research.search') return { ...tool, description: '搜索公开网页，返回标题、链接和摘要。' };
  if (tool.id === 'research.fetch_page') return { ...tool, description: '读取公开网页，返回标题、链接、正文摘录和读取时间。' };
  return tool;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Keep the full executor result for cards/audit; only this copy enters ordinary chat. */
export function projectResearchChatResult(result: JunLuoToolResult): JunLuoToolResult {
  if (!result.ok || !RESEARCH_CHAT_TOOL_IDS.includes(result.toolId) || result.data === undefined) return result;
  const data = record(result.data);
  if (result.toolId === 'research.fetch_page') {
    return { ...result, data: { title: data.title, url: data.url, excerpt: data.excerpt, fetchedAt: data.fetchedAt } };
  }
  const warnings = record(data.context).warnings;
  return { ...result, data: {
    query: data.query,
    results: (Array.isArray(data.results) ? data.results : []).map(value => {
      const item = record(value);
      return { title: item.title, url: item.url, snippet: item.snippet };
    }),
    ...(Array.isArray(warnings) && warnings.length ? { warnings: warnings.filter(value => typeof value === 'string') } : {}),
  } };
}
