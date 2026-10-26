import {
  fetchFundCandidates,
  type FundCandidate,
  type FundCandidateType,
  type FundPoolCategory,
  type FundPoolFilter,
} from '../backend/backendClient';
import { assessFundApiSafety, buildDataSafetyNotice, type FundDataSafetyState } from './walletFundDataSafety';
import { buildWatchlistReason, walletWatchlistGroupTitles } from './walletWatchlistCopy';

export type WalletWatchlistItem = {
  candidate: FundCandidate;
  displayScore: number | null;
  heatLabel: string;
  metricLine: string;
  observeOnly: boolean;
  reason: string;
  riskLabels: string[];
};

export type WalletWatchlistGroup = {
  id: FundPoolCategory;
  items: WalletWatchlistItem[];
  title: string;
};

export type WalletWatchlistResult = {
  groups: WalletWatchlistGroup[];
  ok: boolean;
  stale: boolean;
  updatedAt: number;
  warnings: string[];
};

type CandidateWithState = {
  candidate: FundCandidate;
  safety: FundDataSafetyState;
  stale: boolean;
};

type CandidateRequest = {
  limit: number;
  pool: FundPoolFilter;
  type: FundCandidateType;
};

const candidateRequests: CandidateRequest[] = [
  { type: 'money', limit: 30, pool: 'cash_parking' },
  { type: 'bond', limit: 30, pool: 'stable' },
  { type: 'index', limit: 30, pool: 'broad_index' },
  { type: 'index', limit: 30, pool: 'watchlist' },
  { type: 'etf', limit: 30, pool: 'watchlist' },
];
const groupOrder: FundPoolCategory[] = ['cash_parking', 'stable', 'broad_index', 'watchlist'];
const bridgeUnavailablePattern = /基金数据桥没连上|小管家没连上|AKShare|Network request failed|Failed to fetch|候选池这次没有拿稳|HTTPSConnectionPool|SSLError|Max retries|Traceback|EOF occurred|ConnectionError/i;

function valueOrZero(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function requestLabel({ type, pool }: CandidateRequest) {
  if (pool === 'cash_parking') return '现金停泊';
  if (pool === 'stable') return '稳健观察';
  if (pool === 'broad_index') return '宽基观察';
  if (type === 'etf') return 'ETF观察';
  if (pool === 'watchlist') return '主题观察';
  return `${type}候选`;
}

function valueFromExtra(candidate: FundCandidate, key: string) {
  const value = candidate.extra[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finalScore(candidate: FundCandidate) {
  return typeof candidate.score.finalScore === 'number' ? candidate.score.finalScore : null;
}

function formatPlainPercent(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : '-';
}

function formatSignedPercent(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function formatNumber(value: number | null | undefined, digits = 4) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '-';
}

function isShortTermHot(candidate: FundCandidate) {
  const oneMonth = candidate.performance.return1m ?? candidate.return1m;
  const threeMonth = candidate.performance.return3m ?? candidate.return3m;
  const oneYear = candidate.performance.return1y ?? candidate.return1y;
  if (oneMonth === null || oneMonth === undefined) return false;
  const mediumAnchor = Math.max(valueOrZero(threeMonth), valueOrZero(oneYear) / 4);
  return oneMonth >= 8 && oneMonth > mediumAnchor + 5;
}

function watchlistSortScore(candidate: FundCandidate) {
  const warnings = candidate.score.warningReasons.length + candidate.poolAssessment.warnings.length;
  return (
    valueOrZero(candidate.score.finalScore) * 1.5
    + valueOrZero(candidate.performance.return3m ?? candidate.return3m)
    + valueOrZero(candidate.performance.return1y ?? candidate.return1y) * 0.35
    - warnings * 8
  );
}

function isCashLikeCandidate(candidate: FundCandidate) {
  return candidate.sourceType === 'money_fund' || candidate.poolAssessment.category === 'cash_parking';
}

function isCashLikeInapplicableRiskWarning(warning: string) {
  return /缺少\s*1\s*年最大回撤|缺少\s*1\s*年波动率|最大回撤|波动率|缺少近\s*3\s*月\/6\s*月\/1\s*年收益/.test(warning);
}

function isLowSignalCompletenessWarning(warning: string) {
  return /基金经理从业时间暂缺|基金经理数据暂缺|成立日期暂缺|基金规模资料暂缺|基金公司规模资料暂缺|基金评级资料暂缺|增强费率表暂缺/.test(warning);
}

function isEtfInapplicableRiskWarning(candidate: FundCandidate, warning: string) {
  return candidate.sourceType === 'etf' && /缺少\s*1\s*年最大回撤|缺少\s*1\s*年波动率/.test(warning);
}

function metricLineFor(candidate: FundCandidate) {
  if (isCashLikeCandidate(candidate)) {
    const sevenDay = valueFromExtra(candidate, 'sevenDayAnnualizedPct');
    const income = valueFromExtra(candidate, 'tenThousandIncome') ?? candidate.latestValue;
    return `7日年化 ${formatPlainPercent(sevenDay)} · 万份收益 ${formatNumber(income, 4)}`;
  }
  return `近1月 ${formatSignedPercent(candidate.performance.return1m ?? candidate.return1m)} · 近3月 ${formatSignedPercent(candidate.performance.return3m ?? candidate.return3m)} · 近1年 ${formatSignedPercent(candidate.performance.return1y ?? candidate.return1y)}`;
}

function riskLabelsFor(candidate: FundCandidate, stale: boolean, safety: FundDataSafetyState) {
  const labels = new Set<string>();
  if (stale) labels.add(buildDataSafetyNotice(safety));
  if (candidate.poolAssessment.status === 'observe_only') labels.add('只观察');
  if (candidate.sourceType === 'etf') labels.add('ETF观察');
  if (candidate.poolAssessment.category === 'watchlist') labels.add('主题观察');
  if (isShortTermHot(candidate)) labels.add('短期过热');
  const warningReasons = candidate.score.warningReasons.filter((warning) => (
    !isLowSignalCompletenessWarning(warning)
    && !isEtfInapplicableRiskWarning(candidate, warning)
    && (!isCashLikeCandidate(candidate) || !isCashLikeInapplicableRiskWarning(warning))
  ));
  warningReasons
    .slice(0, 2)
    .forEach((warning) => labels.add(warning));
  return Array.from(labels).slice(0, 4);
}

function toWatchlistItem(candidate: FundCandidate, stale: boolean, safety: FundDataSafetyState): WalletWatchlistItem {
  const score = finalScore(candidate);
  const hot = isShortTermHot(candidate);
  const observeOnly = !safety.canBuy
    || stale
    || candidate.sourceType === 'etf'
    || candidate.poolAssessment.category === 'watchlist'
    || candidate.poolAssessment.status !== 'eligible';
  return {
    candidate,
    displayScore: score,
    heatLabel: hot ? '短期很亮' : '稳稳观察',
    metricLine: metricLineFor(candidate),
    observeOnly,
    reason: buildWatchlistReason({ isHot: hot, observeOnly, score }),
    riskLabels: riskLabelsFor(candidate, stale, safety),
  };
}

function emptyGroups(): WalletWatchlistGroup[] {
  return groupOrder.map((id) => ({
    id,
    items: [],
    title: walletWatchlistGroupTitles[id],
  }));
}

function normalizeWatchlistWarnings(rawWarnings: string[], hasItems: boolean) {
  const unique = Array.from(new Set(rawWarnings.filter(Boolean)));
  if (!hasItems) return unique.slice(0, 8);

  let hidBridgeWarning = false;
  const filtered = unique.filter((warning) => {
    const isBridgeWarning = bridgeUnavailablePattern.test(warning);
    if (isBridgeWarning) hidBridgeWarning = true;
    return !isBridgeWarning;
  });
  if (hidBridgeWarning) filtered.push('有一小格数据没拿稳，已先展示拿到的观察名单。');
  return filtered.slice(0, 8);
}

export async function refreshWalletWatchlist(): Promise<WalletWatchlistResult> {
  const updatedAt = Date.now();
  const warnings: string[] = [];
  let stale = false;
  const candidates: CandidateWithState[] = [];

  const appendCandidates = async (request: CandidateRequest) => {
    const { type, limit, pool } = request;
    const response = await fetchFundCandidates(type, limit, pool);
    warnings.push(...response.warnings);
    const responseSafety = assessFundApiSafety(response, { requireData: true });
    warnings.push(...responseSafety.warnings);
    stale = stale || response.stale || responseSafety.status === 'expired_cache';
    if (!response.ok || !response.data) {
      warnings.push(`${requestLabel(request)}这次没有拿稳。`);
      return;
    }
    candidates.push(...response.data.map((candidate) => ({
      candidate,
      safety: responseSafety,
      stale: response.stale || responseSafety.status === 'expired_cache',
    })));
  };

  await Promise.all(candidateRequests.map(appendCandidates));

  const hasVisibleCategory = (category: FundPoolCategory) => candidates.some(({ candidate }) => (
    candidate.poolAssessment.category === category
    && candidate.poolAssessment.status !== 'blocked'
    && candidate.score.blockReasons.length === 0
  ));
  const fallbackRequests: CandidateRequest[] = [];
  if (!hasVisibleCategory('stable')) fallbackRequests.push({ type: 'bond', limit: 30, pool: 'all' });
  if (!hasVisibleCategory('broad_index')) fallbackRequests.push({ type: 'index', limit: 120, pool: 'all' });
  if (fallbackRequests.length) {
    await Promise.all(fallbackRequests.map(appendCandidates));
  }

  const byCode = new Map<string, CandidateWithState>();
  candidates.forEach((item) => {
    const { candidate } = item;
    if (!candidate.code || !candidate.name) return;
    if (candidate.poolAssessment.status === 'blocked' || candidate.score.blockReasons.length) {
      warnings.push(`${candidate.name} 被规则拦住，没有放进热门观察。`);
      return;
    }
    const previous = byCode.get(candidate.code);
    if (!previous || watchlistSortScore(candidate) > watchlistSortScore(previous.candidate)) {
      byCode.set(candidate.code, item);
    }
  });

  const grouped = emptyGroups();
  groupOrder.forEach((groupId) => {
    const group = grouped.find((item) => item.id === groupId);
    if (!group) return;
    Array.from(byCode.values())
      .filter(({ candidate }) => candidate.poolAssessment.category === groupId)
      .sort((left, right) => watchlistSortScore(right.candidate) - watchlistSortScore(left.candidate))
      .slice(0, 5)
      .forEach(({ candidate, safety, stale: candidateStale }) => {
        group.items.push(toWatchlistItem(candidate, candidateStale, safety));
      });
  });

  const hasItems = grouped.some((group) => group.items.length > 0);

  return {
    groups: grouped,
    ok: hasItems,
    stale,
    updatedAt,
    warnings: normalizeWatchlistWarnings(warnings, hasItems),
  };
}
