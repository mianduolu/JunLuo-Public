import { Linking } from 'react-native';

import {
  fetchLifeResearchCache,
  fetchLifeResearchPage,
  type LifeResearchPage,
} from '../../backend/backendClient';
import {
  loadRecentBrowserRecords,
  recordBrowserPageVisit,
  type JunLuoBrowserRecord,
  type JunLuoBrowserRecordSource,
} from '../browserStore';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolExecutorContext, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import { readNumberInput, readStringInput, validationFailed } from './builtinToolValidation';

export type BrowserPageData = LifeResearchPage & {
  recordId: string;
};

export type BrowserOpenData = {
  openedAt: number;
  recordId: string;
  url: string;
};

export type BrowserListData = {
  records: JunLuoBrowserRecord[];
};

function getBrowserRecordSource(call: JunLuoToolCall): JunLuoBrowserRecordSource {
  if (call.requestedBy === 'chat' || call.requestedBy === 'life_agent' || call.requestedBy === 'proactive' || call.requestedBy === 'background' || call.requestedBy === 'manual') {
    return call.requestedBy;
  }
  return 'manual';
}

export function isPublicBrowserUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.local')) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    if (host === '::1') return false;
    return true;
  } catch {
    return false;
  }
}

function readBrowserUrl<TData = unknown>(call: JunLuoToolCall) {
  const url = readStringInput(call.input, 'url');
  if (!url) return { error: validationFailed<TData>(call, '缺少网页 URL', '没有处理网页'), url: '' };
  if (!isPublicBrowserUrl(url)) {
    return { error: validationFailed<TData>(call, '只支持公开 http/https 网页，不支持本地、局域网或文件 URL', '没有处理网页'), url: '' };
  }
  return { error: null, url };
}

async function fetchPageForCall(
  call: JunLuoToolCall,
  context?: JunLuoToolExecutorContext,
): Promise<JunLuoToolResult<BrowserPageData>> {
  const cacheId = readStringInput(call.input, 'cacheId');
  let page: LifeResearchPage | null = null;
  if (cacheId) {
    page = await fetchLifeResearchCache(cacheId);
    if (!page) return validationFailed<BrowserPageData>(call, `没有找到网页缓存：${cacheId}`, '没有读取到网页内容');
  } else {
    const urlResult = readBrowserUrl<BrowserPageData>(call);
    if (urlResult.error) return urlResult.error;
    page = await fetchLifeResearchPage(urlResult.url, {
      runMobileCacheCommit: context?.runBackupRestoreDataEpochCommit,
    });
    if (!page) return validationFailed<BrowserPageData>(call, `没有读取到网页：${urlResult.url}`, '没有读取到网页内容');
  }
  const persistRecord = () => recordBrowserPageVisit({
      cacheId: page.cacheId,
      fetchMode: page.fetchMode,
      readAt: Date.now(),
      source: getBrowserRecordSource(call),
      title: page.title,
      url: page.url,
    });
  const record = context?.runBackupRestoreDataEpochCommit
    ? await context.runBackupRestoreDataEpochCommit(persistRecord)
    : await persistRecord();
  return createToolSuccessResult(call, `已读取网页：${page.title}`, {
    ...page,
    recordId: record.recordId,
  });
}

async function executeBrowserOpen(call: JunLuoToolCall, context?: JunLuoToolExecutorContext): Promise<JunLuoToolResult<BrowserOpenData>> {
  const urlResult = readBrowserUrl<BrowserOpenData>(call);
  if (urlResult.error) return urlResult.error;
  if (typeof Linking.openURL !== 'function') {
    return validationFailed<BrowserOpenData>(call, '当前环境没有可用的系统打开能力', '没有打开网页');
  }
  const commit = context?.runBackupRestoreDataEpochCommit ?? (<T>(work: () => Promise<T> | T) => Promise.resolve(work()));
  await commit(() => Linking.openURL(urlResult.url));
  const openedAt = Date.now();
  try {
    const record = await commit(() => recordBrowserPageVisit({
      openedAt,
      source: getBrowserRecordSource(call),
      url: urlResult.url,
    }));
    return createToolSuccessResult(call, '已交给系统打开网页', {
      openedAt,
      recordId: record.recordId,
      url: urlResult.url,
    });
  } catch (error) {
    // The OS handoff already succeeded; a failed local record must never invite replay.
    return createToolErrorResult(call, { code: 'TOOL_OUTCOME_UNKNOWN',
      message: error instanceof Error ? error.message : String(error) }, '');
  }
}

async function executeBrowserSnapshot(call: JunLuoToolCall, context?: JunLuoToolExecutorContext) {
  return fetchPageForCall(call, context);
}

async function executeBrowserReadText(call: JunLuoToolCall, context?: JunLuoToolExecutorContext) {
  return fetchPageForCall(call, context);
}

async function executeBrowserListTabs(call: JunLuoToolCall): Promise<JunLuoToolResult<BrowserListData>> {
  const limit = readNumberInput(call.input, 'limit') ?? 20;
  const records = await loadRecentBrowserRecords(limit);
  return createToolSuccessResult(call, records.length ? `君落记录里有 ${records.length} 条最近网页` : '君落记录里还没有最近网页', {
    records,
  });
}

const urlInputSchema = {
  type: 'object' as const,
  required: ['url'],
  properties: {
    url: { type: 'string' as const, description: '公开 http/https 网页 URL' },
  },
};

export const browserOpenTool: JunLuoToolDefinition<Record<string, unknown>, BrowserOpenData> = {
  id: 'browser.open',
  chatExposure: 'explicit_only',
  proactiveEligible: false,
  packageId: 'browser',
  name: '打开公开网页',
  description: '把公开网页交给手机浏览器打开。',
  inputSchema: { type: 'object', required: ['url'], properties: {
    url: { type: 'string', description: '要打开的公开网页链接。' },
  } },
  permission: 'ask',
  riskLevel: 'device_control',
  readOnly: false,
  agentEpochMode: 'bounded_local_commits',
  backupRestoreSafeOutsideLease: true,
  executor: executeBrowserOpen,
};

export const browserSnapshotTool: JunLuoToolDefinition<Record<string, unknown>, BrowserPageData> = {
  id: 'browser.snapshot',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'browser',
  name: '读取网页摘要',
  description: '读取公开网页标题和正文摘要，底层复用君落公开网页读取链路和可选浏览器兜底。',
  inputSchema: urlInputSchema,
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: true,
  backupRestoreSafeOutsideLease: true,
  executor: executeBrowserSnapshot,
};

export const browserReadTextTool: JunLuoToolDefinition<Record<string, unknown>, BrowserPageData> = {
  id: 'browser.read_text',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'browser',
  name: '读取网页文本',
  description: '按 URL 或 cacheId 读取已缓存或可读取的公开网页摘要；不会返回完整大页面。',
  inputSchema: {
    type: 'object',
    properties: {
      cacheId: { type: 'string', description: '已有网页缓存 ID' },
      url: { type: 'string', description: '公开 http/https 网页 URL' },
    },
  },
  permission: 'ask',
  riskLevel: 'external_network',
  readOnly: true,
  backupRestoreSafeOutsideLease: true,
  executor: executeBrowserReadText,
};

export const browserListTabsTool: JunLuoToolDefinition<Record<string, unknown>, BrowserListData> = {
  id: 'browser.list_tabs',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'browser',
  name: '查看最近网页记录',
  description: '列出君落最近打开或读取过的公开网页记录；不是系统浏览器真实标签页。',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: '最多返回记录数，默认 20，最大 50' },
    },
  },
  permission: 'allow',
  riskLevel: 'read',
  readOnly: true,
  executor: executeBrowserListTabs,
};

export const browserToolPackage: JunLuoToolPackage = {
  id: 'browser',
  name: '网页浏览',
  description: '打开公开网页、读取网页摘要，并管理君落自己的最近网页记录。',
  category: 'external_research',
  tools: [
    browserOpenTool,
    browserSnapshotTool,
    browserReadTextTool,
    browserListTabsTool,
  ],
  defaultEnabled: true,
  riskLevel: 'external_network',
  source: 'builtin',
};

