import type {
  LifeResearchSearchDiagnostic,
  LifeResearchSearchResponse,
  LifeResearchSearchScope,
} from '../backend/backendClient';

export type DiagnosticScopeGroup = {
  diagnostics: LifeResearchSearchDiagnostic[];
  key: 'phone' | 'backend' | 'other';
  label: string;
};

function diagnosticScopeKey(scope?: LifeResearchSearchScope) {
  if (scope === 'phone' || scope === 'backend') return scope;
  return 'other';
}

function formatDiagnosticTime(value: number) {
  const date = new Date(value);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

export function diagnosticScopeLabel(scope?: LifeResearchSearchScope) {
  if (scope === 'phone') return '手机端引擎';
  if (scope === 'backend') return '电脑后端';
  return '其他诊断';
}

export function diagnosticStatusLabel(status: string) {
  const labels: Record<string, string> = {
    failed: '失败',
    skipped: '跳过',
    success: '成功',
  };
  return labels[status] ?? status;
}

export function formatElapsedMs(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (value < 1000) return `${Math.max(0, Math.round(value))}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

export function formatTriedAt(value?: number) {
  if (!value) return '';
  return formatDiagnosticTime(value);
}

export function diagnosticFacts(diagnostic: LifeResearchSearchDiagnostic) {
  const facts: string[] = [];
  if (diagnostic.engine) facts.push(`引擎 ${diagnostic.engine}`);
  if (diagnostic.role) facts.push(`角色 ${diagnostic.role}`);
  if (typeof diagnostic.resultCount === 'number') facts.push(`结果 ${diagnostic.resultCount} 条`);
  if (typeof diagnostic.httpStatus === 'number') facts.push(`HTTP ${diagnostic.httpStatus}`);
  if (typeof diagnostic.attemptCount === 'number') facts.push(`尝试 ${diagnostic.attemptCount} 次`);
  const elapsed = formatElapsedMs(diagnostic.elapsedMs);
  if (elapsed) facts.push(`耗时 ${elapsed}`);
  const triedAt = formatTriedAt(diagnostic.triedAt);
  if (triedAt) facts.push(`尝试于 ${triedAt}`);
  if (!diagnostic.engine && diagnostic.engines.length) facts.push(`引擎 ${diagnostic.engines.join(' / ')}`);
  return facts;
}

export function groupSearchDiagnostics(diagnostics: LifeResearchSearchDiagnostic[]) {
  const groups: DiagnosticScopeGroup[] = [
    { diagnostics: [], key: 'phone', label: diagnosticScopeLabel('phone') },
    { diagnostics: [], key: 'backend', label: diagnosticScopeLabel('backend') },
    { diagnostics: [], key: 'other', label: diagnosticScopeLabel() },
  ];
  const byKey = new Map(groups.map((group) => [group.key, group]));
  diagnostics.forEach((diagnostic) => {
    byKey.get(diagnosticScopeKey(diagnostic.scope))?.diagnostics.push(diagnostic);
  });
  return groups.filter((group) => group.diagnostics.length > 0);
}

export function describeManualSearchNotice(response: LifeResearchSearchResponse, backendBaseUrl = '') {
  const phoneSuccess = response.diagnostics.find((diagnostic) =>
    diagnostic.scope === 'phone' &&
    diagnostic.status === 'success' &&
    (diagnostic.resultCount ?? 0) > 0);
  if (phoneSuccess) {
    const engine = phoneSuccess.engine ? `：${phoneSuccess.engine}` : '';
    return `已使用手机端多源搜索${engine}。${backendBaseUrl ? '电脑后端未参与本次结果。' : ''}`;
  }

  const backendSuccess = response.diagnostics.find((diagnostic) =>
    diagnostic.scope === 'backend' &&
    diagnostic.status === 'success' &&
    (diagnostic.resultCount ?? 0) > 0);
  if (backendSuccess) {
    return backendBaseUrl
      ? `手机端没有返回结果，已使用电脑后端增强：${backendBaseUrl}`
      : '手机端没有返回结果，已使用电脑后端增强。';
  }

  if (response.results.some((result) => result.provider?.startsWith('mobile_'))) {
    return '已返回手机端搜索结果。';
  }
  if (response.results.length) return '已返回公开网页搜索结果。';
  return backendBaseUrl
    ? `已尝试手机端多源搜索；电脑后端地址已保存：${backendBaseUrl}`
    : '已尝试手机端多源搜索，没有填写电脑后端地址。';
}
