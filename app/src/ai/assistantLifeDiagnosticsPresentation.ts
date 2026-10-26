import type { AssistantLifeGenerationFailureReason } from './assistantLifeGenerationShared';
import type { AssistantLifeGenerationDiagnostic } from './assistantLifeGenerationDiagnostics';
import type { LifeMaterialImportance, LifeMaterialItem, LifeMaterialSource } from './lifeMaterialHub';

export type AssistantLifeDiagnosticClassification =
  | 'allowed-retry'
  | 'budget-skipped'
  | 'duplicate'
  | 'local'
  | 'unknown'
  | 'request';

export type ClassifiedAssistantLifeDiagnostic = {
  classification: AssistantLifeDiagnosticClassification;
  diagnostic: AssistantLifeGenerationDiagnostic;
};

export type AssistantLifeDiagnosticSummary = {
  allowedRetryCount: number;
  budgetSkippedCount: number;
  completionTokens: number;
  duplicateRequestCount: number;
  failureCount: number;
  promptTokens: number;
  realRequestCount: number;
  unknownRecordCount: number;
  localOnlyCount: number;
  records: ClassifiedAssistantLifeDiagnostic[];
  successCount: number;
};

export function assistantLifeRequestCount(diagnostic: AssistantLifeGenerationDiagnostic): number | null {
  if (diagnostic.stage === 'local' || diagnostic.status === 'budget-skipped') return 0;
  if (!diagnostic.requests) return null;
  return diagnostic.requests.filter(request => request.status !== 'not-started'
    && (!diagnostic.flow || !!request.transport)).length;
}

export function assistantLifeFlowLabel(flow: AssistantLifeGenerationDiagnostic['flow']) {
  return flow ? { wants: '第一卷·十维', affect: '第二卷·感受', 'near-status': '第三卷·近况', 'sleep-status': '第三卷·睡眠近况' }[flow] : '旧记录未区分卷子';
}

const FAILURE_LABELS: Record<AssistantLifeGenerationFailureReason, string> = {
  aborted: '请求被中止',
  'auth-or-config': '连接配置异常',
  'empty-content': '模型没有返回正文',
  'http-transient': '服务临时异常',
  'invalid-activity': '状态正文不合格',
  'invalid-json': 'JSON 没有读懂',
  'invalid-mood': '情绪值不合格',
  'invalid-title': '标题不合格',
  'rate-limited': '请求过于频繁',
  timeout: '请求超时',
  'truncated-output': '模型输出被截断',
};

const SOURCE_LABELS: Record<LifeMaterialSource, string> = {
  'active-message': '主动消息状态',
  'assistant-schedule': '云云的日程',
  ambient: '当前环境',
  'body-signal': '戒指现场信号',
  browser: '网页记录',
  'co-reading': '共读',
  focus: '共同专注',
  'github-voyage': 'GitHub 逛街',
  period: '身体记录',
  'tool-audit': '工具结果',
  'web-voyage': '网页远游',
  'wish-pool': '许愿池',
};

const IMPORTANCE_LABELS: Record<LifeMaterialImportance, string> = {
  high: '优先',
  low: '轻量',
  medium: '普通',
};

const FRESHNESS_LABELS: Record<LifeMaterialItem['freshness'], string> = {
  fresh: '刚刚',
  recent: '近期',
  stale: '较早',
};

function diagnosticTime(diagnostic: AssistantLifeGenerationDiagnostic) {
  return diagnostic.attemptedAt;
}

export function classifyAssistantLifeDiagnostics(
  diagnostics: AssistantLifeGenerationDiagnostic[],
  contextSource: AssistantLifeGenerationDiagnostic['contextSource'],
): ClassifiedAssistantLifeDiagnostic[] {
  const lastRealRequestByKey = new Map<string, AssistantLifeGenerationDiagnostic>();
  return diagnostics
    .filter((diagnostic) => diagnostic.contextSource === contextSource)
    .slice()
    .sort((left, right) => diagnosticTime(left) - diagnosticTime(right))
    .map((diagnostic) => {
      if (diagnostic.status === 'budget-skipped') {
        return { classification: 'budget-skipped' as const, diagnostic };
      }
      const count = assistantLifeRequestCount(diagnostic);
      if (count === null) return { classification: 'unknown' as const, diagnostic };
      if (count === 0) return { classification: 'local' as const, diagnostic };
      const previous = lastRealRequestByKey.get(diagnostic.generationKey);
      let classification: AssistantLifeDiagnosticClassification = 'request';
      if (previous) {
        const previousEnd = Math.max(...(previous.requests ?? []).map(item => item.transport?.finishedAt ?? previous.attemptedAt), previous.attemptedAt);
        const retryAllowed = (diagnostic.flow === 'wants' || diagnostic.flow === 'affect')
          && diagnostic.attemptOrdinal === (previous.attemptOrdinal ?? 0) + 1
          && diagnostic.attemptOrdinal <= 3 && previous.requests?.some(item => item.status === 'failure')
          && diagnostic.attemptedAt - previousEnd >= 5 * 60_000;
        classification = retryAllowed ? 'allowed-retry' : diagnostic.requestId && previous.requestId ? 'duplicate' : 'unknown';
      } else if ((diagnostic.flow === 'wants' || diagnostic.flow === 'affect')
        && (diagnostic.attemptOrdinal ?? 0) > 1 && diagnostic.attemptOrdinal! <= 3) {
        classification = 'allowed-retry';
      }
      lastRealRequestByKey.set(diagnostic.generationKey, diagnostic);
      return { classification, diagnostic };
    });
}

export function summarizeAssistantLifeDiagnostics(
  diagnostics: AssistantLifeGenerationDiagnostic[],
  contextSource: AssistantLifeGenerationDiagnostic['contextSource'],
): AssistantLifeDiagnosticSummary {
  const records = classifyAssistantLifeDiagnostics(diagnostics, contextSource);
  return records.reduce<AssistantLifeDiagnosticSummary>((summary, record) => {
    const { diagnostic } = record;
    if (diagnostic.status === 'budget-skipped') {
      summary.budgetSkippedCount += diagnostic.occurrenceCount ?? 1;
    } else {
      const count = assistantLifeRequestCount(diagnostic);
      if (count === null) summary.unknownRecordCount += 1;
      else if (count === 0) summary.localOnlyCount += 1;
      else {
        summary.realRequestCount += count;
        const requests = diagnostic.requests!.filter(request => request.status !== 'not-started'
          && (!diagnostic.flow || !!request.transport));
        for (const request of requests) {
          summary.promptTokens += request.promptTokens ?? 0;
          summary.completionTokens += request.completionTokens ?? 0;
          if (request.status === 'success') summary.successCount += 1;
          else if (request.transport?.outcome !== 'started') summary.failureCount += 1;
        }
      }
      if (record.classification === 'allowed-retry') summary.allowedRetryCount += 1;
      if (record.classification === 'duplicate') summary.duplicateRequestCount += 1;
    }
    return summary;
  }, {
    allowedRetryCount: 0,
    budgetSkippedCount: 0,
    completionTokens: 0,
    duplicateRequestCount: 0,
    failureCount: 0,
    promptTokens: 0,
    realRequestCount: 0,
    unknownRecordCount: 0,
    localOnlyCount: 0,
    records,
    successCount: 0,
  });
}

export function assistantLifeFailureReasonLabel(reason?: AssistantLifeGenerationFailureReason) {
  return reason ? FAILURE_LABELS[reason] : '原因未记录';
}

export function lifeMaterialSourceLabel(source: LifeMaterialSource) {
  return SOURCE_LABELS[source];
}

export function lifeMaterialImportanceLabel(importance: LifeMaterialImportance) {
  return IMPORTANCE_LABELS[importance];
}

export function lifeMaterialFreshnessLabel(freshness: LifeMaterialItem['freshness']) {
  return FRESHNESS_LABELS[freshness];
}
