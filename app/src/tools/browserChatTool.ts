import type { JunLuoToolResult } from './toolTypes';

export const BROWSER_OPEN_TOOL_ID = 'browser.open';

/** The original receipt keeps its local record ID for cards and audit. */
export function projectBrowserOpenResult(result: JunLuoToolResult): JunLuoToolResult {
  if (!result.ok || result.toolId !== BROWSER_OPEN_TOOL_ID || !result.data) return result;
  const data = result.data as Record<string, unknown>;
  return { ...result, data: { url: data.url, openedAt: data.openedAt } };
}
