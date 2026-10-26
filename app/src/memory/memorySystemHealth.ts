import { loadEmbeddingSettings, getMissingEmbeddingCount } from './memoryEmbedding';
import { buildRecentMemoryHealthSummary } from './memoryHealthReport';
import { buildRecentMemoryRetrievalTraceSummary } from './memoryRetrievalTrace';
import { buildRecentMemoryAdmissionSummary } from './memoryAdmissionControl';
import { buildRecentMemoryImportanceGateSummary } from './memoryImportanceGate';
import { getMemoryRetrievalDiagnostics } from './memoryStore';
import { memoryModelBoundaryByLane } from './memoryModelBoundaries';
import { getLastMemoryRerankerStatus, loadMemoryRerankerSettings } from './memoryReranker';

export type MemorySystemHealthSeverity = 'ok' | 'warning' | 'blocked';

export type MemorySystemHealthItem = {
  actionLabel?: string;
  actionTarget?: 'ai-settings' | 'backup' | 'memory';
  detail: string;
  kind: string;
  severity: MemorySystemHealthSeverity;
  title: string;
};

export type MemorySystemHealthSnapshot = {
  items: MemorySystemHealthItem[];
  overall: MemorySystemHealthSeverity;
  summary: string;
  title: string;
};

type BuildMemorySystemHealthSnapshotOptions = {
  memoryOrganizerLabel?: string;
  memoryOrganizerReady: boolean;
  memoryRerankerLabel?: string;
  memoryRerankerReady?: boolean;
};

const severityWeight: Record<MemorySystemHealthSeverity, number> = {
  blocked: 3,
  warning: 2,
  ok: 1,
};

function pickOverall(items: MemorySystemHealthItem[]): MemorySystemHealthSeverity {
  if (items.some((item) => item.severity === 'blocked')) return 'blocked';
  if (items.some((item) => item.severity === 'warning')) return 'warning';
  return 'ok';
}

function summarize(overall: MemorySystemHealthSeverity, items: MemorySystemHealthItem[]) {
  if (overall === 'ok') return '记忆系统运行正常；语义召回、文字召回和整理模型都可以使用。';
  const visible = items
    .filter((item) => item.severity !== 'ok')
    .sort((left, right) => severityWeight[right.severity] - severityWeight[left.severity])
    .slice(0, 2)
    .map((item) => item.title);
  return visible.length ? `需要看一眼：${visible.join('、')}。` : '有些增强功能暂时不可用，但普通记忆仍能查看。';
}

export async function buildMemorySystemHealthSnapshot(
  options: BuildMemorySystemHealthSnapshotOptions,
): Promise<MemorySystemHealthSnapshot> {
  const [
    embedding,
    missingEmbeddings,
    retrieval,
    rerankerSettings,
    healthSummary,
    traceSummary,
    admissionSummary,
    importanceGateSummary,
  ] = await Promise.all([
    loadEmbeddingSettings(),
    getMissingEmbeddingCount().catch(() => 0),
    getMemoryRetrievalDiagnostics().catch(() => null),
    loadMemoryRerankerSettings().catch(() => null),
    buildRecentMemoryHealthSummary().catch(() => null),
    Promise.resolve(buildRecentMemoryRetrievalTraceSummary()),
    Promise.resolve(buildRecentMemoryAdmissionSummary()),
    Promise.resolve(buildRecentMemoryImportanceGateSummary()),
  ]);

  const items: MemorySystemHealthItem[] = [];
  const organizerName = options.memoryOrganizerLabel?.trim() || '记忆整理模型';
  if (options.memoryOrganizerReady) {
    items.push({
      detail: `${organizerName} 已可用，可以整理回忆、导入历史、整理旧记忆和转行动候选。`,
      kind: 'memory_organizer',
      severity: 'ok',
      title: '整理模型已配置',
    });
  } else {
    items.push({
      actionLabel: '去配置 AI',
      actionTarget: 'ai-settings',
      detail: '需要在 AI 设置的连接抽屉里选择“用于整理”的连接，并保存 API Key。',
      kind: 'memory_organizer',
      severity: 'blocked',
      title: '整理模型未配置',
    });
  }

  const rerankerBoundary = memoryModelBoundaryByLane.reranker;
  const rerankerName = options.memoryRerankerLabel?.trim() || rerankerBoundary.label;
  const rerankerStatus = getLastMemoryRerankerStatus();
  if (!rerankerSettings?.enabled) {
    items.push({
      detail: `${rerankerBoundary.label}未启用；君落会继续使用本地排序，记忆召回仍可工作。`,
      kind: 'memory_reranker',
      severity: 'ok',
      title: '重排模型未启用',
    });
  } else if (!options.memoryRerankerReady) {
    items.push({
      actionLabel: '去配置 AI',
      actionTarget: 'ai-settings',
      detail: `已打开记忆重排，但需要在 AI 设置里选择“用于重排”的连接，并保存 API Key。当前策略：${rerankerBoundary.fallbackPolicy}`,
      kind: 'memory_reranker',
      severity: 'warning',
      title: '重排模型缺少连接',
    });
  } else {
    items.push({
      detail: `${rerankerName} 已可用；${rerankerStatus.detail || '候选过多时会辅助选择相关记忆。'}`,
      kind: 'memory_reranker',
      severity: rerankerStatus.kind === 'fallback' ? 'warning' : 'ok',
      title: rerankerStatus.kind === 'fallback' ? '重排模型最近回退' : '重排模型可用',
    });
  }
  if (!embedding.settings.enabled) {
    items.push({
      actionLabel: '去配置 AI',
      actionTarget: 'ai-settings',
      detail: '语义召回未启用；君落仍会使用文字搜索和关系召回。',
      kind: 'embedding',
      severity: 'warning',
      title: '语义索引未启用',
    });
  } else if (!embedding.apiKey.trim()) {
    items.push({
      actionLabel: '去配置 AI',
      actionTarget: 'ai-settings',
      detail: '已打开向量检索，但缺少 Embedding API Key，语义召回会自动回落。',
      kind: 'embedding',
      severity: 'warning',
      title: '语义索引缺少密钥',
    });
  } else if (missingEmbeddings > 0) {
    items.push({
      actionLabel: '去配置 AI',
      actionTarget: 'ai-settings',
      detail: `还有 ${missingEmbeddings} 条普通记忆缺少语义索引，可以在 AI 设置里补齐。`,
      kind: 'embedding',
      severity: 'warning',
      title: '语义索引未补齐',
    });
  } else {
    items.push({
      detail: `语义索引已启用，模型 ${embedding.settings.model}。`,
      kind: 'embedding',
      severity: 'ok',
      title: '语义索引可用',
    });
  }

  if (retrieval?.ftsAvailable === false) {
    items.push({
      detail: retrieval.ftsError ? `文字检索已降级：${retrieval.ftsError}` : '文字检索已降级，仍会尝试使用备用匹配。',
      kind: 'fts',
      severity: 'warning',
      title: '全文检索降级',
    });
  } else {
    items.push({
      detail: retrieval
        ? `文字检索可用；当前普通记忆 ${retrieval.memoryCount} 条，向量覆盖 ${retrieval.vectorIndexedCount}/${retrieval.memoryCount}。`
        : '文字检索可用。',
      kind: 'fts',
      severity: 'ok',
      title: '全文检索可用',
    });
  }

  if (traceSummary.recentCount && traceSummary.totalDropped > 0) {
    const mainDrop = traceSummary.topDroppedStages[0];
    items.push({
      detail: mainDrop
        ? `最近 ${traceSummary.recentCount} 次召回平均最终想起 ${traceSummary.averageFinalCount} 条，总控裁剪了 ${traceSummary.totalDropped} 个候选，最多发生在“${mainDrop.label}”。`
        : `最近 ${traceSummary.recentCount} 次召回平均最终想起 ${traceSummary.averageFinalCount} 条，有候选被总控裁剪。`,
      kind: 'retrieval_trace',
      severity: 'warning',
      title: '检索小抄有裁剪记录',
    });
  } else {
    items.push({
      detail: traceSummary.recentCount
        ? `最近 ${traceSummary.recentCount} 次召回平均最终想起 ${traceSummary.averageFinalCount} 条，没有明显裁剪堆积。`
        : '打开聊天后会记录最近召回小抄，方便调试为什么想起。',
      kind: 'retrieval_trace',
      severity: 'ok',
      title: '检索小抄可用',
    });
  }

  if (admissionSummary.suppress > 0 || admissionSummary.review > 0) {
    const mainAdmissionReason = admissionSummary.suppressReasons[0] ?? admissionSummary.topReasons[0];
    const reasonText = mainAdmissionReason
      ? `主要原因：${mainAdmissionReason.reason}（${mainAdmissionReason.count} 次）。`
      : '';
    items.push({
      detail: `最近候选准入：建议保存 ${admissionSummary.admit}，需要看一眼 ${admissionSummary.review}，自动跳过 ${admissionSummary.suppress}。${reasonText}`,
      kind: 'candidate_admission',
      severity: admissionSummary.suppress > 0 ? 'warning' : 'ok',
      title: admissionSummary.suppress > 0 ? '自动候选已降噪' : '候选准入在工作',
    });
  }

  if (importanceGateSummary.suppress > 0 || importanceGateSummary.review > 0) {
    const mainGateReason = importanceGateSummary.suppressReasons[0] ?? importanceGateSummary.topReasons[0];
    const reasonText = mainGateReason
      ? `主要原因：${mainGateReason.reason}（${mainGateReason.count} 次）。`
      : '';
    items.push({
      detail: `最近长卡闸门：通过 ${importanceGateSummary.admit}，需要看一眼 ${importanceGateSummary.review}，自动跳过 ${importanceGateSummary.suppress}。${reasonText}`,
      kind: 'importance_gate',
      severity: importanceGateSummary.suppress > 0 ? 'warning' : 'ok',
      title: importanceGateSummary.suppress > 0 ? '长卡闸门已降噪' : '长卡闸门在工作',
    });
  }

  const maintenanceCount = healthSummary?.actionItems.reduce((sum, item) => sum + item.count, 0) ?? 0;
  if (maintenanceCount > 0) {
    items.push({
      actionLabel: '查看最近体检',
      actionTarget: 'memory',
      detail: `最近体检有 ${maintenanceCount} 个提醒，包括冷却、纠正、关系或旧长记忆整理等。`,
      kind: 'maintenance',
      severity: 'warning',
      title: '最近维护有提醒',
    });
  } else {
    items.push({
      detail: '最近体检没有需要立刻处理的提醒。',
      kind: 'maintenance',
      severity: 'ok',
      title: '最近维护安静',
    });
  }

  const sorted = [...items].sort((left, right) => severityWeight[right.severity] - severityWeight[left.severity]);
  const overall = pickOverall(sorted);
  return {
    items: sorted,
    overall,
    summary: summarize(overall, sorted),
    title: overall === 'blocked' ? '记忆系统需要配置' : overall === 'warning' ? '记忆系统有提醒' : '记忆系统状态良好',
  };
}



