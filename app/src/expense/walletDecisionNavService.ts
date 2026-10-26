import { fetchFundCandidate, fetchFundNavHistory, type FundNavPoint } from '../backend/backendClient';
import { assessFundApiSafety } from './walletFundDataSafety';
import type { WalletDecisionNavSource, WalletDecision } from './walletStore';

export type WalletBuyNavResolution = {
  nav: number | null;
  ok: boolean;
  resolvedAt: number;
  source: WalletDecisionNavSource | 'none';
  warnings: string[];
};

function latestValidUnitNav(points: FundNavPoint[] | null) {
  return [...(points ?? [])].reverse().find((point) => point.unitNav !== null && point.unitNav > 0)?.unitNav ?? null;
}

function cleanNav(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 10000) / 10000;
}

function isCashLikeCandidate(data: Awaited<ReturnType<typeof fetchFundCandidate>>['data']) {
  return data?.sourceType === 'money_fund' || data?.poolAssessment.category === 'cash_parking';
}

export async function resolveWalletBuyNav(decision: Pick<WalletDecision, 'fundCode'>): Promise<WalletBuyNavResolution> {
  const warnings: string[] = [];
  const resolvedAt = Date.now();

  try {
    const history = await fetchFundNavHistory(decision.fundCode, 30);
    const historySafety = assessFundApiSafety(history, { requireData: true });
    const historyNav = historySafety.canBuy
      ? cleanNav(latestValidUnitNav(history.data))
      : null;
    if (historyNav) {
      return {
        nav: historyNav,
        ok: true,
        resolvedAt,
        source: 'nav_history',
        warnings: [...history.warnings, ...historySafety.warnings],
      };
    }
    warnings.push(...history.warnings, ...historySafety.warnings);
    if (!historySafety.canBuy) warnings.push(`nav_history_${historySafety.status}`);
  } catch {
    warnings.push('nav_history_unavailable');
  }

  try {
    const candidate = await fetchFundCandidate(decision.fundCode);
    const candidateSafety = assessFundApiSafety(candidate, {
      requireData: true,
      requireLatestValue: (data) => isCashLikeCandidate(data) || cleanNav(data?.latestValue) !== null,
    });
    if (candidateSafety.canBuy && isCashLikeCandidate(candidate.data)) {
      return {
        nav: 1,
        ok: true,
        resolvedAt,
        source: 'cash_like_unit_nav',
        warnings: [...warnings, ...candidate.warnings, ...candidateSafety.warnings],
      };
    }
    const candidateNav = candidateSafety.canBuy
      ? cleanNav(candidate.data?.latestValue)
      : null;
    if (candidateNav) {
      return {
        nav: candidateNav,
        ok: true,
        resolvedAt,
        source: 'candidate_latest_value',
        warnings: [...warnings, ...candidate.warnings, ...candidateSafety.warnings],
      };
    }
    warnings.push(...candidate.warnings, ...candidateSafety.warnings);
    if (!candidateSafety.canBuy) warnings.push(`candidate_latest_value_${candidateSafety.status}`);
  } catch {
    warnings.push('candidate_latest_value_unavailable');
  }

  return {
    nav: null,
    ok: false,
    resolvedAt,
    source: 'none',
    warnings: Array.from(new Set(warnings.filter(Boolean))),
  };
}
