import type { WalletDecision, WalletDecisionReview } from './walletStore';

export type WalletLearningSummary = {
  averageReturn7dPct: number | null;
  averageReturn30dPct: number | null;
  bestReview: WalletDecisionReview | null;
  maxDrawdownPct: number | null;
  notes: string[];
  pendingCount: number;
  reflectionReview: WalletDecisionReview | null;
  reviewedCount: number;
  summary: string;
  warnings: string[];
};

function average(values: Array<number | null>) {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!known.length) return null;
  return Math.round((known.reduce((sum, value) => sum + value, 0) / known.length) * 100) / 100;
}

function formatPercent(value: number | null) {
  if (value === null) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function reviewReturn(review: WalletDecisionReview) {
  return review.return30dPct ?? review.return7dPct;
}

function decisionType(decisions: WalletDecision[], review: WalletDecisionReview) {
  return decisions.find((decision) => decision.id === review.decisionId)?.fundType || '基金';
}

export function buildWalletLearningSummary(
  reviews: WalletDecisionReview[],
  decisions: WalletDecision[],
): WalletLearningSummary {
  const ready = reviews.filter((review) => review.status === 'ready');
  const pending = reviews.filter((review) => review.status === 'pending');
  const missing = reviews.filter((review) => review.status === 'data_missing');
  const averageReturn7dPct = average(ready.map((review) => review.return7dPct));
  const averageReturn30dPct = average(ready.map((review) => review.return30dPct));
  const drawdowns = ready
    .map((review) => review.maxDrawdownPct)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const maxDrawdownPct = drawdowns.length ? Math.min(...drawdowns) : null;
  const sorted = [...ready].sort((left, right) => (reviewReturn(right) ?? -Infinity) - (reviewReturn(left) ?? -Infinity));
  const bestReview = sorted[0] ?? null;
  const reflectionReview = [...ready]
    .sort((left, right) => (reviewReturn(left) ?? Infinity) - (reviewReturn(right) ?? Infinity))[0] ?? null;
  const typeScores = new Map<string, number[]>();
  ready.forEach((review) => {
    const value = review.return30dPct ?? review.return7dPct;
    if (value === null) return;
    const type = decisionType(decisions, review);
    typeScores.set(type, [...(typeScores.get(type) ?? []), value]);
  });
  const bestType = Array.from(typeScores.entries())
    .map(([type, values]) => ({ type, value: average(values) ?? 0 }))
    .sort((left, right) => right.value - left.value)[0];
  const notes = [
    bestType ? `目前 ${bestType.type} 的复盘表现相对更稳，平均 ${formatPercent(bestType.value)}。` : '',
    bestReview ? `${bestReview.fundName} 是目前表现最亮的一张复盘卡。` : '',
    reflectionReview && (reviewReturn(reflectionReview) ?? 0) < 0
      ? `${reflectionReview.fundName} 需要我以后更谨慎地复查理由。`
      : '',
  ].filter(Boolean);
  const warnings = [
    missing.length ? `${missing.length} 张决定卡数据没拿稳，我没有硬算收益。` : '',
    pending.length ? `${pending.length} 张决定卡还没到复盘时间。` : '',
    maxDrawdownPct !== null && maxDrawdownPct <= -5 ? `最大浮亏到过 ${formatPercent(maxDrawdownPct)}，后面要更会踩刹车。` : '',
  ].filter(Boolean);
  return {
    averageReturn7dPct,
    averageReturn30dPct,
    bestReview,
    maxDrawdownPct,
    notes,
    pendingCount: pending.length,
    reflectionReview,
    reviewedCount: ready.length,
    summary: ready.length
      ? `我复盘了 ${ready.length} 张决定卡，7 天平均 ${formatPercent(averageReturn7dPct)}，30 天平均 ${formatPercent(averageReturn30dPct)}。`
      : '还没有足够的决定卡可以复盘，我先把小本本准备好。',
    warnings,
  };
}
