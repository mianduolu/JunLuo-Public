import {
  getPhoneAccessibilitySnapshot,
  getPhoneActivityPermissionStatusResult,
  isPhoneActivityNativeAvailable,
  loadNativePhoneActivityLogs,
  type AccessibilitySnapshotNode,
  type PhoneActivityPermissionStatus,
} from '../../backend/phoneActivityNative';
import {
  buildPhoneUsageSummary,
  loadPhoneUsageSummary,
  loadRecentPhoneActivityLogs,
  summarizePhoneActivity,
  type PhoneActivityLog,
  type PhoneUsageSummary,
} from '../../phoneActivity/phoneActivityStore';
import { isVisiblePhoneActivityLog } from '../../phoneActivity/phoneActivityVisibility';
import { createToolError } from '../toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type {
  JunLuoToolCall,
  JunLuoToolDefinition,
  JunLuoToolExecutorContext,
  JunLuoToolPackage,
  JunLuoToolResult,
} from '../toolTypes';
import { readNumberInput } from './builtinToolValidation';

type PhoneContextPermissionStatusData = {
  checkedAt: number;
  nativeAvailable: boolean;
  status: PhoneActivityPermissionStatus;
};

type PhoneContextActivityItem = {
  createdAt: number;
  durationMs?: number;
  endedAt?: number;
  id: string;
  kind: string;
  sensitiveLevel: string;
  source: string;
  startedAt?: number;
  summary?: string;
  title?: string;
};

type PhoneContextRecentActivityData = {
  activities: PhoneContextActivityItem[];
  checkedAt: number;
  limit: number;
  minutes?: number;
};

type PhoneContextAppUsageData = PhoneUsageSummary & {
  checkedAt: number;
  fallbackSource?: 'native_logs';
};

type PhoneContextNotificationData = {
  checkedAt: number;
  limit: number;
  minutes?: number;
  notifications: PhoneContextActivityItem[];
};

type PhoneContextActivitySummaryData = {
  checkedAt: number;
  minutes: number;
  summary: string;
  topApps: string[];
};

type PhoneContextWindowSummaryData = {
  checkedAt: number;
  className?: string;
  nodeCount: number;
  packageName?: string;
  textSnippets: string[];
};

const DEFAULT_RECENT_ACTIVITY_LIMIT = 20;
const DEFAULT_NOTIFICATION_LIMIT = 10;
const DEFAULT_ACTIVITY_MINUTES = 30;
const DEFAULT_WINDOW_NODE_LIMIT = 80;

function clampInteger(value: number | undefined, fallback: number, min: number, max: number) {
  if (typeof value !== 'number') return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function compactText(value: unknown, limit = 90) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function isBlocked(log: PhoneActivityLog) {
  return log.sensitive_level === 'blocked';
}

function isWithinMinutes(log: PhoneActivityLog, minutes?: number) {
  if (!minutes) return true;
  const timestamp = log.created_at || log.started_at || log.ended_at || 0;
  return timestamp >= Date.now() - minutes * 60 * 1000;
}

function toActivityItem(log: PhoneActivityLog): PhoneContextActivityItem {
  return {
    createdAt: log.created_at,
    durationMs: log.duration_ms || undefined,
    endedAt: log.ended_at || undefined,
    id: log.id,
    kind: log.kind,
    sensitiveLevel: log.sensitive_level,
    source: compactText(log.source, 80) ?? 'unknown',
    startedAt: log.started_at || undefined,
    summary: compactText(log.summary, 90),
    title: compactText(log.title, 60),
  };
}

async function loadRecentLogs(limit: number, diagnosticParentToken?: number) {
  const stored = await loadRecentPhoneActivityLogs(limit, diagnosticParentToken).catch(() => []);
  if (stored.length) return stored.filter(isVisiblePhoneActivityLog);
  return loadNativePhoneActivityLogs(0, limit).then((logs) => logs.filter(isVisiblePhoneActivityLog)).catch(() => []);
}

function formatDuration(ms: number) {
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

async function loadUsageSummaryWithFallback(days: number): Promise<PhoneContextAppUsageData> {
  const summary = await loadPhoneUsageSummary(days).catch(() => ({
    days: [],
    segmentCount: 0,
    todayTopApps: [],
    updatedAt: Date.now(),
    weekTopApps: [],
  } satisfies PhoneUsageSummary));
  if (summary.segmentCount || summary.todayTopApps.length || summary.weekTopApps.length) {
    return { ...summary, checkedAt: Date.now() };
  }

  const now = Date.now();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const sinceMs = today.getTime() - (days - 1) * 24 * 60 * 60 * 1000;
  const nativeLogs = await loadNativePhoneActivityLogs(sinceMs, 300).catch(() => []);
  return {
    ...buildPhoneUsageSummary(nativeLogs, days, now, 8),
    checkedAt: now,
    fallbackSource: 'native_logs',
  };
}

function summarizeUsage(data: PhoneContextAppUsageData) {
  const apps = (data.todayTopApps.length ? data.todayTopApps : data.weekTopApps).slice(0, 3);
  if (!data.segmentCount && !apps.length) return '还没有可用的手机使用时长记录';
  const appText = apps.map((app) => `${app.title} ${formatDuration(app.durationMs)}`).join('、');
  const totalDurationMs = data.days.reduce((sum, day) => sum + day.totalDurationMs, 0);
  return appText
    ? `手机使用记录显示：${appText}`
    : `手机使用记录共有 ${data.segmentCount} 段，合计 ${formatDuration(totalDurationMs)}`;
}

function summarizePermissionStatus(status: PhoneActivityPermissionStatus, nativeAvailable: boolean) {
  if (!nativeAvailable) return '当前环境没有可用的本机小管家原生模块';
  const granted = [
    status.usageAccess ? '使用情况' : '',
    status.notificationListener ? '通知监听' : '',
    status.accessibility ? '无障碍' : '',
    status.overlay ? '悬浮窗' : '',
  ].filter(Boolean);
  const missing = [
    !status.usageAccess ? '使用情况' : '',
    !status.notificationListener ? '通知监听' : '',
    !status.accessibility ? '无障碍' : '',
    !status.overlay ? '悬浮窗' : '',
  ].filter(Boolean);
  return `本机小管家权限：${granted.length ? `已授权 ${granted.join('、')}` : '暂无已授权项'}；${missing.length ? `未授权 ${missing.join('、')}` : '关键权限已齐'}；采集器${status.collectorRunning ? '运行中' : '未运行'}`;
}

async function executeGetPermissionStatus(
  call: JunLuoToolCall,
): Promise<JunLuoToolResult<PhoneContextPermissionStatusData>> {
  const nativeAvailable = isPhoneActivityNativeAvailable();
  const result = await getPhoneActivityPermissionStatusResult();
  if (nativeAvailable && !result.available) {
    const summary = summarizePermissionStatus(result.status, false);
    return createToolErrorResult(call, createToolError('EXECUTION_FAILED', summary), summary);
  }
  const status = result.status;
  const data = {
    checkedAt: Date.now(),
    nativeAvailable,
    status,
  };
  return createToolSuccessResult(call, summarizePermissionStatus(status, nativeAvailable), data);
}

async function executeGetRecentActivity(
  call: JunLuoToolCall,
): Promise<JunLuoToolResult<PhoneContextRecentActivityData>> {
  const limit = clampInteger(readNumberInput(call.input, 'limit'), DEFAULT_RECENT_ACTIVITY_LIMIT, 1, 80);
  const minutes = clampInteger(readNumberInput(call.input, 'minutes'), 0, 0, 7 * 24 * 60);
  const logs = (await loadRecentLogs(Math.max(limit, 80)))
    .filter(isVisiblePhoneActivityLog)
    .filter((log) => !isBlocked(log))
    .filter((log) => isWithinMinutes(log, minutes || undefined))
    .slice(0, limit)
    .map(toActivityItem);
  const data = { activities: logs, checkedAt: Date.now(), limit, minutes: minutes || undefined };
  if (!logs.length) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', '没有可用的近期手机活动记录'),
      '没有读取到近期手机活动记录',
    );
  }
  return createToolSuccessResult(call, `最近手机活动摘要：${logs.slice(0, 5).map((item) => item.title || item.summary || item.source).join('、')}`, data);
}

async function executeGetAppUsage(call: JunLuoToolCall): Promise<JunLuoToolResult<PhoneContextAppUsageData>> {
  const days = clampInteger(readNumberInput(call.input, 'days'), 1, 1, 14);
  const data = await loadUsageSummaryWithFallback(days);
  if (!data.segmentCount && !data.todayTopApps.length && !data.weekTopApps.length) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', '没有可用的 App 使用时长记录'),
      '没有读取到 App 使用时长记录',
    );
  }
  return createToolSuccessResult(call, summarizeUsage(data), data);
}

async function executeGetNotifications(
  call: JunLuoToolCall,
): Promise<JunLuoToolResult<PhoneContextNotificationData>> {
  const limit = clampInteger(readNumberInput(call.input, 'limit'), DEFAULT_NOTIFICATION_LIMIT, 1, 30);
  const minutes = clampInteger(readNumberInput(call.input, 'minutes'), 24 * 60, 1, 7 * 24 * 60);
  const logs = (await loadRecentLogs(Math.max(limit, 120)))
    .filter((log) => log.kind === 'notification' && !isBlocked(log))
    .filter((log) => isWithinMinutes(log, minutes))
    .slice(0, limit)
    .map(toActivityItem);
  const data = { checkedAt: Date.now(), limit, minutes, notifications: logs };
  if (!logs.length) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', '没有可用的通知摘要记录'),
      '没有读取到通知摘要',
    );
  }
  return createToolSuccessResult(call, `最近通知摘要：${logs.slice(0, 5).map((item) => item.title || item.source).join('、')}`, data);
}

async function executeSummarizeRecentActivity(
  call: JunLuoToolCall,
  context?: JunLuoToolExecutorContext,
): Promise<JunLuoToolResult<PhoneContextActivitySummaryData>> {
  const minutes = clampInteger(readNumberInput(call.input, 'minutes'), DEFAULT_ACTIVITY_MINUTES, 5, 24 * 60);
  const diagnosticParentToken = context?.diagnosticParentToken;
  const summary = await summarizePhoneActivity(minutes, diagnosticParentToken).catch(() => null);
  if (summary?.summary && !summary.summary.includes('最近没有可用')) {
    return createToolSuccessResult(call, `手机活动摘要：${summary.summary}`, {
      checkedAt: Date.now(),
      minutes,
      summary: summary.summary,
      topApps: [],
    });
  }

  const fallbackLogs = (await loadRecentLogs(80, diagnosticParentToken))
    .filter(isVisiblePhoneActivityLog)
    .filter((log) => !isBlocked(log))
    .filter((log) => isWithinMinutes(log, minutes))
    .filter((log) => log.kind === 'foreground_app_duration');
  const topApps = [...new Set(fallbackLogs.map((log) => compactText(log.title || log.source, 40)).filter(Boolean) as string[])].slice(0, 5);
  if (!topApps.length) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', '没有可用于总结的手机活动记录'),
      '没有读取到可总结的手机活动',
    );
  }
  const fallbackSummary = `最近 ${minutes} 分钟记录显示：${topApps.join('、')}`;
  return createToolSuccessResult(call, `手机活动摘要：${fallbackSummary}`, {
    checkedAt: Date.now(),
    minutes,
    summary: fallbackSummary,
    topApps,
  });
}

function collectTextSnippets(nodes: AccessibilitySnapshotNode[] | undefined) {
  const snippets: string[] = [];
  for (const node of nodes ?? []) {
    const text = compactText(node.text || node.description, 50);
    if (!text || snippets.includes(text)) continue;
    snippets.push(text);
    if (snippets.length >= 12) break;
  }
  return snippets;
}

async function executeGetWindowSummary(
  call: JunLuoToolCall,
): Promise<JunLuoToolResult<PhoneContextWindowSummaryData>> {
  const snapshot = await getPhoneAccessibilitySnapshot(DEFAULT_WINDOW_NODE_LIMIT);
  if (!snapshot.ok) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', snapshot.reason || '没有读取到窗口摘要'),
      '没有读取到当前窗口摘要',
    );
  }
  const textSnippets = collectTextSnippets(snapshot.nodes);
  if (!textSnippets.length) {
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', '窗口快照没有可用文本摘要'),
      '当前窗口没有可用文字摘要',
    );
  }
  const data = {
    checkedAt: Date.now(),
    className: snapshot.className,
    nodeCount: snapshot.nodes?.length ?? 0,
    packageName: snapshot.packageName,
    textSnippets,
  };
  return createToolSuccessResult(call, `当前窗口摘要：${textSnippets.slice(0, 5).join('、')}`, data);
}

const noInputSchema = { type: 'object' as const };
const limitMinutesSchema = {
  type: 'object' as const,
  properties: {
    limit: { type: 'number' as const, description: '最多返回多少条摘要。' },
    minutes: { type: 'number' as const, description: '只读取最近多少分钟内的记录。' },
  },
};

export const phoneContextToolPackage: JunLuoToolPackage = {
  id: 'phone_context',
  name: '手机生活上下文',
  description: '本机小管家只读取授权手机上下文：当前 App、近期活动、通知摘要、窗口摘要和 App 使用时长；不回复消息、不操作账号、不点击按钮。',
  category: 'phone_context',
  defaultEnabled: true,
  riskLevel: 'read',
  source: 'builtin',
  tools: [
    {
      id: 'phone_context.get_permission_status',
      chatExposure: 'candidate',
      proactiveEligible: true,
      packageId: 'phone_context',
      name: '读取本机小管家权限状态',
      description: '读取使用情况权限、通知监听、无障碍、悬浮窗和小管家采集器状态。',
      inputSchema: noInputSchema,
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeGetPermissionStatus,
    },
    {
      id: 'phone_context.get_recent_activity',
      chatExposure: 'candidate',
      proactiveEligible: true,
      packageId: 'phone_context',
      name: '读取近期手机活动',
      description: '读取最近切换过的 App、停留时间和摘要；只按摘要说话，不补全省略信息。',
      inputSchema: limitMinutesSchema,
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeGetRecentActivity,
    },
    {
      id: 'phone_context.get_app_usage',
      chatExposure: 'candidate',
      proactiveEligible: true,
      packageId: 'phone_context',
      name: '读取 App 使用时长',
      description: '读取 App 停留时长；时长只表示停留过，不等于小仓鼠的真实想法或动机。',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '统计最近多少天，默认 1 天，最多 14 天。' },
        },
      },
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeGetAppUsage,
    },
    {
      id: 'phone_context.get_notifications',
      chatExposure: 'candidate',
      proactiveEligible: true,
      packageId: 'phone_context',
      name: '读取通知摘要',
      description: '读取近期通知日志的脱敏摘要，不返回完整通知正文。',
      inputSchema: limitMinutesSchema,
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeGetNotifications,
    },
    {
      id: 'phone_context.summarize_recent_activity',
      chatExposure: 'candidate',
      proactiveEligible: true,
      packageId: 'phone_context',
      name: '总结近期手机活动',
      description: '把近期手机活动压缩成轻量生活上下文；脱敏摘要只按摘要使用。',
      inputSchema: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: '总结最近多少分钟，默认 30 分钟。' },
        },
      },
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeSummarizeRecentActivity,
    },
    {
      id: 'phone_context.get_window_summary',
      chatExposure: 'candidate',
      proactiveEligible: true,
      packageId: 'phone_context',
      name: '读取当前窗口摘要',
      description: '读取当前无障碍窗口的紧凑文字摘要，不暴露完整节点树。',
      inputSchema: noInputSchema,
      permission: 'allow',
      riskLevel: 'read',
      readOnly: true,
      executor: executeGetWindowSummary,
    },
  ],
};

