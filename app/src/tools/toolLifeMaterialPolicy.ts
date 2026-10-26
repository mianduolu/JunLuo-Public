const DAY_MS = 24 * 60 * 60 * 1000;

export type ToolLifeMaterialSource =
  | 'chat'
  | 'proactive'
  | 'life_agent'
  | 'social_agent'
  | 'background'
  | 'manual';

export type ToolLifeMaterialInput = {
  callId: string;
  createdAt: number;
  errorMessage?: string;
  finishedAt?: number;
  resultSummary?: string;
  source: ToolLifeMaterialSource;
  startedAt?: number;
  status:
    | 'requested'
    | 'awaiting_permission'
    | 'awaiting_confirmation'
    | 'permission_denied'
    | 'running'
    | 'success'
    | 'error'
    | 'cancelled'
    | 'outcome_unknown';
  toolId: string;
};

export type ToolLifeMaterial = {
  expiresAt: number;
  fingerprintKey: string;
  importance: 'low' | 'medium';
  occurredAt: number;
  promptLine: string;
  statusText: string;
  summary: string;
  toolId: string;
  toolLabel: string;
};

const ARRANGEMENT_TOOL_LABELS = new Map([
  ['schedule.create_event', '创建日程'],
  ['todo.create', '创建待办'],
  ['reminder.create', '创建提醒'],
  ['alarm.create', '创建闹钟'],
  ['alarm.strong_create', '创建闹钟'],
  ['alarm.strong_cancel', '取消闹钟'],
  ['agent_task.schedule_once', '安排一次主动消息'],
  ['agent_task.cancel', '取消一次主动消息'],
]);

const CONTEXT_TOOL_LABELS = new Map([
  ['system_status.get_battery', '检查设备电量'],
  ['system_status.get_device_status', '检查设备状态'],
  ['system_status.get_device_info', '检查设备信息'],
]);

const RESEARCH_TOOL_LABELS = new Map([
  ['research.search', '搜索资料'],
  ['research.search_with_diagnostics', '搜索资料'],
  ['research.search_multi', '搜索多份资料'],
  ['research.fetch_page', '读取网页资料'],
  ['research.search_images', '搜索图片资料'],
  ['research.search_academic', '搜索学术资料'],
  ['research.search_doi', '查找 DOI 资料'],
  ['research.compare_sources', '比较资料来源'],
  ['research.verify_claim', '核对资料'],
]);

const GITHUB_TOOL_LABELS = new Map([
  ['github.get_config_status', '检查 GitHub 配置'],
  ['github.search_repositories', '搜索 GitHub 仓库'],
  ['github.get_repository', '读取 GitHub 仓库'],
  ['github.list_issues', '查看 GitHub issue'],
  ['github.list_issue_comments', '查看 GitHub issue 评论'],
  ['github.list_pull_requests', '查看 GitHub PR'],
  ['github.get_pull_request', '读取 GitHub PR'],
  ['github.get_file', '读取 GitHub 文件'],
  ['github.create_issue', '创建 GitHub issue'],
  ['github.comment_issue', '回复 GitHub issue'],
  ['github.create_pull_request', '创建 GitHub PR'],
  ['github.update_file', '更新 GitHub 文件'],
  ['github.delete_file', '删除 GitHub 文件'],
]);

const DIRECT_CONTEXT_SOURCES = new Set<ToolLifeMaterialSource>(['chat', 'manual', 'proactive']);

function compactText(value: unknown, limit = 140) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function localDaySerial(timestamp: number) {
  const date = new Date(timestamp);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

function localDateKey(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}

function localExpiryAt(timestamp: number) {
  const expiry = new Date(timestamp);
  expiry.setHours(0, 0, 0, 0);
  expiry.setDate(expiry.getDate() + 1);
  return expiry.getTime();
}

function isToday(timestamp: number, now: number) {
  return localDaySerial(timestamp) === localDaySerial(now);
}

function getToolLabel(record: ToolLifeMaterialInput) {
  const arrangement = ARRANGEMENT_TOOL_LABELS.get(record.toolId);
  if (arrangement) return arrangement;
  if (!DIRECT_CONTEXT_SOURCES.has(record.source)) return null;
  return CONTEXT_TOOL_LABELS.get(record.toolId) ??
    RESEARCH_TOOL_LABELS.get(record.toolId) ??
    GITHUB_TOOL_LABELS.get(record.toolId) ??
    null;
}

export function selectToolLifeMaterial(
  records: ToolLifeMaterialInput[],
  now = Date.now(),
): ToolLifeMaterial | null {
  const selected = records
    .map((record) => {
      if (record.status !== 'success' && record.status !== 'error') return null;
      const occurredAt = record.finishedAt ?? record.startedAt ?? record.createdAt;
      if (!Number.isFinite(occurredAt) || occurredAt <= 0 || !isToday(occurredAt, now)) return null;
      const toolLabel = getToolLabel(record);
      const statusText = compactText(record.resultSummary);
      if (!toolLabel || !statusText) return null;
      return { occurredAt, record, statusText, toolLabel };
    })
    .filter((item): item is {
      occurredAt: number;
      record: ToolLifeMaterialInput;
      statusText: string;
      toolLabel: string;
    } => !!item)
    .sort((left, right) =>
      right.occurredAt - left.occurredAt ||
      left.record.toolId.localeCompare(right.record.toolId))[0];
  if (!selected) return null;

  return {
    expiresAt: localExpiryAt(selected.occurredAt),
    fingerprintKey: [
      selected.record.toolId,
      selected.record.status,
      selected.statusText,
      localDateKey(selected.occurredAt),
    ].join('|'),
    importance: selected.record.status === 'success' ? 'medium' : 'low',
    occurredAt: selected.occurredAt,
    promptLine: `工具结果：${selected.toolLabel}；${selected.statusText}。这是本次工具执行留下的实际回执。`,
    statusText: selected.statusText,
    summary: `${selected.toolLabel}：${selected.statusText}`,
    toolId: selected.record.toolId,
    toolLabel: selected.toolLabel,
  };
}
