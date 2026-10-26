import { buildRecentMemoryAdmissionSummary } from './memoryAdmissionControl';
import { buildMemoryCatalogSnapshot } from './memoryCatalog';
import { loadMemoryCurrentStates } from './memoryCurrentStateStore';
import { buildRecentMemoryHealthSummary } from './memoryHealthReport';
import { buildRecentMemoryImportanceGateSummary } from './memoryImportanceGate';
import { buildRecentMemoryRetrievalTraceSummary } from './memoryRetrievalTrace';
import { loadMemories, loadRecentRecallFeedback } from './memoryStore';
import {
  buildMemorySystemHealthSnapshot,
  type MemorySystemHealthSnapshot,
} from './memorySystemHealth';
import { buildMemorySystemDiagnosticsSnapshot } from './memorySystemDiagnostics';
import { loadMemoryProcessingWorkerSummary } from './memoryProcessingWorker';
export type MemoryMaintenanceSeverity = 'ok' | 'notice' | 'warning';

export type MemoryMaintenanceActionTarget =
  | 'memory_health'
  | 'system_health'
  | 'current_states'
  | 'star_graph'
  | 'topic_profiles'
  | 'memory_catalog'
  | 'candidate_reviews'
  | 'memory_detail'
  | 'memory_processing';

export type MemoryMaintenanceItem = {
  actionLabel?: string;
  actionTarget?: MemoryMaintenanceActionTarget;
  count: number;
  detail: string;
  id: string;
  severity: MemoryMaintenanceSeverity;
  targetId?: string;
  title: string;
};

export type MemoryMaintenanceSection = {
  id: string;
  items: MemoryMaintenanceItem[];
  title: string;
};

export type MemoryMaintenanceSnapshot = {
  sections: MemoryMaintenanceSection[];
  summary: string;
  title: string;
};

type BuildMemoryMaintenanceSnapshotOptions = {
  activeCurrentStateCount?: number;
  memoryOrganizerLabel?: string;
  memoryOrganizerReady?: boolean;
  memoryRerankerLabel?: string;
  memoryRerankerReady?: boolean;
  pendingCandidateCount?: number;
  systemHealth?: MemorySystemHealthSnapshot | null;
};

const DAY_MS = 86400000;

function severityFromCount(count: number, warningAt = 1): MemoryMaintenanceSeverity {
  if (count >= warningAt) return 'warning';
  return 'ok';
}

function okItem(id: string, title: string, detail: string): MemoryMaintenanceItem {
  return { count: 0, detail, id, severity: 'ok', title };
}

function firstMemoryId(ids?: string[]) {
  return ids?.find(Boolean);
}

export async function buildMemoryMaintenanceSnapshot(
  options: BuildMemoryMaintenanceSnapshotOptions = {},
): Promise<MemoryMaintenanceSnapshot> {
  const now = Date.now();
  const [
    systemHealth,
    healthSummary,
    admissionSummary,
    importanceGateSummary,
    currentStates,
    allCurrentStates,
    memories,
    sourceCorrectionFeedback,
    traceSummary,
    catalogSnapshot,
    systemDiagnostics,
    processingSummary,
  ] = await Promise.all([
    options.systemHealth
      ? Promise.resolve(options.systemHealth)
      : buildMemorySystemHealthSnapshot({
        memoryOrganizerLabel: options.memoryOrganizerLabel,
        memoryOrganizerReady: options.memoryOrganizerReady ?? false,
        memoryRerankerLabel: options.memoryRerankerLabel,
        memoryRerankerReady: options.memoryRerankerReady,
      }).catch(() => null),
    buildRecentMemoryHealthSummary().catch(() => null),
    Promise.resolve(buildRecentMemoryAdmissionSummary()),
    Promise.resolve(buildRecentMemoryImportanceGateSummary()),
    loadMemoryCurrentStates({ includeResolved: false, limit: 100 }).catch(() => []),
    loadMemoryCurrentStates({ includeResolved: true, limit: 100 }).catch(() => []),
    loadMemories({ includeArchived: true }).catch(() => []),
    loadRecentRecallFeedback({ kinds: ['corrected', 'outdated'], limit: 100, since: now - 30 * DAY_MS }).catch(() => []),
    Promise.resolve(buildRecentMemoryRetrievalTraceSummary()),
    buildMemoryCatalogSnapshot({ limitPerGroup: 6 }).catch(() => null),
    buildMemorySystemDiagnosticsSnapshot().catch(() => null),
    loadMemoryProcessingWorkerSummary().catch(() => null),
  ]);

  const healthCounts = healthSummary?.counts ?? {};
  const healthActionByKind = new Map(healthSummary?.actionItems.map((item) => [item.kind, item]) ?? []);
  const systemProblemCount = systemHealth?.items.filter((item) => item.severity !== 'ok').length ?? 0;
  const expiredCurrentStates = allCurrentStates.filter((state) => state.status === 'expired');
  const activeCurrentStateCount = options.activeCurrentStateCount ?? currentStates.length;
  const missingSourceMemories = memories.filter((memory) => (
    memory.type !== 'archived'
    && memory.type !== 'feel'
    && !memory.sourceStartAt
    && !memory.sourceEndAt
  ));
  const highEmotion = memories.filter((memory) => (
    memory.type !== 'archived'
    && memory.arousal >= 0.65
  ));
  const pendingCandidateCount = options.pendingCandidateCount ?? 0;
  const admissionIssueCount = admissionSummary.suppress + admissionSummary.review;
  const longGateIssueCount = importanceGateSummary.suppress + importanceGateSummary.review;
  const graphWarning = healthActionByKind.get('graph_warning');
  const dehydrationReady = healthActionByKind.get('dehydration_ready');
  const sourceCorrectedCount = sourceCorrectionFeedback.filter((item) => item.kind === 'corrected').length;
  const sourceOutdatedCount = sourceCorrectionFeedback.filter((item) => item.kind === 'outdated').length;
  const processingPending = (processingSummary?.pending ?? 0) + (processingSummary?.leased ?? 0);
  const processingBlocked = processingSummary?.blocked ?? 0;
  const processingFailed = processingSummary?.failed ?? 0;

  const sections: MemoryMaintenanceSection[] = [
    {
      id: 'system',
      title: '系统诊断',
      items: [
        processingFailed
          ? {
            actionLabel: '对账并重试',
            actionTarget: 'memory_processing',
            count: processingFailed,
            detail: `有 ${processingFailed} 项连续失败后已暂停；正文仍然安全，可以手动重新排队。`,
            id: 'memory-processing-failed',
            severity: 'warning',
            title: '记忆加工需要重试',
          }
          : processingBlocked
            ? {
              actionLabel: '对账并重试',
              actionTarget: 'memory_processing',
              count: processingBlocked,
              detail: `有 ${processingBlocked} 项正在等待 embedding 或记忆整理连接配置。`,
              id: 'memory-processing-blocked',
              severity: 'notice',
              title: '记忆加工等待配置',
            }
            : processingPending
              ? {
                actionLabel: '对账并重试',
                actionTarget: 'memory_processing',
                count: processingPending,
                detail: `等待 ${processingSummary?.pending ?? 0} 项，正在加工 ${processingSummary?.leased ?? 0} 项。`,
                id: 'memory-processing-pending',
                severity: 'notice',
                title: '记忆加工正在排队',
              }
              : okItem('memory-processing-ok', '记忆加工正常', '当前没有等待、阻塞或失败的加工项。'),
        systemProblemCount
          ? {
            actionLabel: '查看状态',
            actionTarget: 'system_health',
            count: systemProblemCount,
            detail: systemHealth?.summary ?? '有几项配置或索引需要看一眼。',
            id: 'system-health',
            severity: 'warning',
            title: '记忆系统有提醒',
          }
          : okItem('system-health-ok', '记忆健康安静', '整理模型、文字检索和索引状态没有新的阻塞。'),
        ...(systemDiagnostics?.items.map((item) => ({
          actionLabel: item.actionLabel,
          actionTarget: item.actionTarget,
          count: item.count ?? 0,
          detail: item.detail,
          id: 'diagnostics-' + item.id,
          severity: item.severity,
          title: item.title,
        })) ?? [
          {
            count: 1,
            detail: '系统诊断聚合失败；这不会影响记忆查看，但需要之后再看一眼。',
            id: 'diagnostics-unavailable',
            severity: 'warning' as const,
            title: '系统诊断暂不可用',
          },
        ]),
        traceSummary.recentCount
          ? {
            count: traceSummary.totalDropped,
            detail: traceSummary.totalDropped
              ? `最近 ${traceSummary.recentCount} 次召回平均最终想起 ${traceSummary.averageFinalCount} 条，裁剪 ${traceSummary.totalDropped} 个候选；最多发生在“${traceSummary.topDroppedStages[0]?.label ?? '总控'}”。`
              : `最近 ${traceSummary.recentCount} 次召回平均最终想起 ${traceSummary.averageFinalCount} 条，没有明显裁剪堆积。`,
            id: 'retrieval-trace',
            severity: traceSummary.totalDropped ? 'notice' : 'ok',
            title: traceSummary.totalDropped ? '检索小抄有裁剪记录' : '检索小抄安静',
          }
          : okItem('retrieval-trace-ok', '检索小抄等待聊天', '聊天后会记录为什么想起、哪里裁剪和最终想起几条。'),
      ],
    },
    {
      id: 'candidates',
      title: '候选与闸门',
      items: [
        pendingCandidateCount
          ? {
            actionLabel: '看候选',
            actionTarget: 'candidate_reviews',
            count: pendingCandidateCount,
            detail: '统计全部已持久化的待确认稿，包含等待同目标处理的草稿；未生成的整理任务不计入。',
            id: 'pending-candidates',
            severity: 'notice',
            title: '有待确认候选',
          }
          : okItem('pending-candidates-ok', '没有待确认稿', '当前没有已持久化的待确认稿；未生成的整理任务不计入。'),
        admissionIssueCount
          ? {
            count: admissionIssueCount,
            detail: `最近自动候选里有 ${admissionSummary.suppress} 条被跳过，${admissionSummary.review} 条需要看一眼。`,
            id: 'candidate-admission',
            severity: admissionSummary.suppress ? 'warning' : 'notice',
            title: '候选准入有记录',
          }
          : okItem('candidate-admission-ok', '候选准入安静', '最近没有明显重复或太薄的自动候选记录。'),
        longGateIssueCount
          ? {
            count: longGateIssueCount,
            detail: `最近长卡闸门跳过 ${importanceGateSummary.suppress} 条，需要看一眼 ${importanceGateSummary.review} 条。`,
            id: 'importance-gate',
            severity: importanceGateSummary.suppress ? 'warning' : 'notice',
            title: '长卡闸门在工作',
          }
          : okItem('importance-gate-ok', '长卡闸门安静', '最近没有压住新的阶段长卡。'),
        okItem('confirmed-candidate-preservation', '候选正文已保护', '小仓鼠确认保存后的候选不会被后台自动删掉、改写或压缩。'),
      ],
    },
    {
      id: 'graph',
      title: '关系与星图',
      items: [
        graphWarning
          ? {
            actionLabel: '看关系',
            actionTarget: firstMemoryId(graphWarning.memoryIds) ? 'memory_detail' : 'star_graph',
            count: graphWarning.count,
            detail: '有些关系线可能方向、时间或强弱需要看一眼。',
            id: 'graph-warning',
            severity: 'warning',
            targetId: firstMemoryId(graphWarning.memoryIds),
            title: '关系需要看一眼',
          }
          : okItem('graph-warning-ok', '关系图谱安静', '最近没有新的可疑关系提醒。'),
      ],
    },
    {
      id: 'current-states',
      title: '当前状态',
      items: [
        activeCurrentStateCount
          ? {
            actionLabel: '看状态',
            actionTarget: 'current_states',
            count: activeCurrentStateCount,
            detail: '这些是正在生效的近期便利贴，会影响白云理解现在。',
            id: 'active-current-states',
            severity: 'notice',
            title: '有生效中的便利贴',
          }
          : okItem('active-current-states-ok', '当前状态安静', '现在没有正在生效的近期便利贴。'),
        expiredCurrentStates.length
          ? {
            count: expiredCurrentStates.length,
            detail: '这些已经不再进入现在的聊天上下文，只保留记录。',
            id: 'expired-current-states',
            severity: 'ok',
            title: '有已过期状态记录',
          }
          : okItem('expired-current-states-ok', '没有积压的过期状态', '当前状态没有需要额外处理的过期堆积。'),
      ],
    },
    {
      id: 'maintenance',
      title: '记忆整理',
      items: [
        catalogSnapshot
          ? {
            actionLabel: '看目录',
            actionTarget: 'memory_catalog',
            count: catalogSnapshot.groups.reduce((sum, group) => sum + group.lines.length, 0),
            detail: catalogSnapshot.summary,
            id: 'memory-catalog',
            severity: catalogSnapshot.groups.some((group) => group.lines.length) ? 'notice' : 'ok',
            title: '记忆目录小抄',
          }
          : okItem('memory-catalog-empty', '记忆目录暂时没整理', '目录小抄只读现有记忆，不会自动写入新内容。'),
        dehydrationReady
          ? {
            actionLabel: '看记忆',
            actionTarget: firstMemoryId(dehydrationReady.memoryIds) ? 'memory_detail' : 'memory_health',
            count: dehydrationReady.count,
            detail: '有旧长记忆适合整理成年轮摘要，但不会自动动它。',
            id: 'dehydration-ready',
            severity: 'notice',
            targetId: firstMemoryId(dehydrationReady.memoryIds),
            title: '可整理旧长记忆',
          }
          : okItem('dehydration-ready-ok', '旧长记忆暂不催', '最近没有特别需要整理的旧长记忆。'),
        missingSourceMemories.length
          ? {
            count: missingSourceMemories.length,
            detail: '多半是旧记忆或手动记忆；不是错误，只是来源小票不完整。',
            id: 'missing-source',
            severity: 'notice',
            title: '有旧记忆暂无来源片段',
          }
          : okItem('missing-source-ok', '来源片段状态良好', '普通记忆大多带着可追溯来源。'),
      ],
    },
    {
      id: 'feedback',
      title: '反馈痕迹',
      items: [
        healthCounts.muted
          ? {
            count: healthCounts.muted,
            detail: '这些记忆还在，但不会主动被白云拿出来提。',
            id: 'muted',
            severity: 'notice',
            title: '别主动提',
          }
          : okItem('muted-ok', '没有新的别主动提', '主动提起限制没有新的堆积。'),
        healthCounts.suppressed
          ? {
            count: healthCounts.suppressed,
            detail: '这些记忆暂时冷却，不会连续冒出来。',
            id: 'suppressed',
            severity: 'notice',
            title: '浮现冷却中',
          }
          : okItem('suppressed-ok', '浮现冷却安静', '最近没有明显的主动浮现冷却堆积。'),
        (healthCounts.corrected ?? 0) + (healthCounts.outdated ?? 0) + (healthCounts.confirmed ?? 0)
          ? {
            actionLabel: '看体检',
            actionTarget: 'memory_health',
            count: (healthCounts.corrected ?? 0) + (healthCounts.outdated ?? 0) + (healthCounts.confirmed ?? 0),
            detail: `纠正 ${healthCounts.corrected ?? 0}，过期 ${healthCounts.outdated ?? 0}，确认 ${healthCounts.confirmed ?? 0}。`,
            id: 'feedback-recent',
            severity: 'notice',
            title: '最近有召回反馈',
          }
          : okItem('feedback-recent-ok', '最近反馈安静', '没有新的纠正、过期或确认反馈。'),
        sourceCorrectionFeedback.length
          ? {
            actionLabel: '看体检',
            actionTarget: 'memory_health',
            count: sourceCorrectionFeedback.length,
            detail: `最近 30 天来源纠错 ${sourceCorrectedCount} 次，来源过期 ${sourceOutdatedCount} 次。`,
            id: 'source-correction-feedback',
            severity: 'notice',
            title: '最近有来源纠错',
          }
          : okItem('source-correction-feedback-ok', '来源纠错安静', '最近没有新的来源纠错或来源过期记录。'),
        highEmotion.length
          ? {
            count: highEmotion.length,
            detail: '这些不是要立刻处理的任务，只是提醒白云近期承接时更小心。',
            id: 'high-emotion',
            severity: 'notice',
            title: '高情绪记忆',
          }
          : okItem('high-emotion-ok', '高情绪安静', '没有新的高情绪记忆。'),
      ],
    },
  ];

  const warningCount = sections.flatMap((section) => section.items).filter((item) => item.severity === 'warning').length;
  const noticeCount = sections.flatMap((section) => section.items).filter((item) => item.severity === 'notice').length;
  const summary = warningCount
    ? `有 ${warningCount} 项需要看一眼，另外 ${noticeCount} 项可以稍后处理。`
    : noticeCount
      ? `没有阻塞项，有 ${noticeCount} 项可以慢慢看。`
      : '记忆检查暂时很安静。';

  return {
    sections,
    summary,
    title: warningCount ? '记忆系统诊断有提醒' : noticeCount ? '记忆系统诊断有小纸条' : '记忆系统诊断很安静',
  };
}
