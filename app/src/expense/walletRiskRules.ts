import type { FundCandidate, FundThoughtAnalysis } from '../backend/backendClient';
import type { AiWallet, WalletDecisionAction, WalletHolding, WalletTransaction } from './walletStore';

export type FundRiskLevel = 'cash_like' | 'low' | 'medium' | 'high' | 'blocked';
export type WalletAllowedAction = Extract<WalletDecisionAction, 'buy' | 'observe' | 'hold' | 'pause'>;

export type WalletRiskReasonCode =
  | 'wallet_cash_too_low'
  | 'fund_blocked'
  | 'observe_only_candidate'
  | 'high_risk_candidate'
  | 'fund_limit_reached'
  | 'category_limit_reached'
  | 'cooldown_7d_frequent_buy'
  | 'cooldown_30d_too_many_buys'
  | 'wallet_drawdown_warning'
  | 'wallet_drawdown_pause'
  | 'risk_data_missing'
  | 'fund_data_stale'
  | 'fund_data_unavailable'
  | 'etf_observe_only'
  | 'min_amount_over_limit'
  | 'suggested_amount_too_small';

export type WalletRiskReasonParams = Record<string, number | string | boolean | null>;

export type WalletRiskAssessment = {
  allowedActions: WalletAllowedAction[];
  blockReasons: string[];
  categoryMaxAmount: number;
  currentCategoryExposure: number;
  currentFundExposure: number;
  fundMaxAmount: number;
  fundRiskLevel: FundRiskLevel;
  reasonCodes: WalletRiskReasonCode[];
  reasonParams: Partial<Record<WalletRiskReasonCode, WalletRiskReasonParams>>;
  remainingWalletLimit: number;
  singleDecisionMaxAmount: number;
  suggestedMaxAmount: number;
  warnings: string[];
};

export type WalletRiskInput = {
  candidate: FundCandidate;
  holdings: WalletHolding[];
  now?: number;
  thoughtAnalysis?: FundThoughtAnalysis | null;
  transactions: WalletTransaction[];
  wallet: AiWallet;
};

type RiskLimitConfig = {
  categoryPct: number;
  fundPct: number;
  singlePct: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_BUY_AMOUNT = 1;

const RISK_LIMITS: Record<Exclude<FundRiskLevel, 'blocked' | 'high'>, RiskLimitConfig> = {
  cash_like: { categoryPct: 1, fundPct: 0.4, singlePct: 0.2 },
  low: { categoryPct: 0.6, fundPct: 0.3, singlePct: 0.15 },
  medium: { categoryPct: 0.4, fundPct: 0.2, singlePct: 0.1 },
};

function roundMoney(value: number) {
  return Math.max(0, Math.floor(value * 100) / 100);
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function addReason(
  codes: WalletRiskReasonCode[],
  params: Partial<Record<WalletRiskReasonCode, WalletRiskReasonParams>>,
  code: WalletRiskReasonCode,
  nextParams: WalletRiskReasonParams = {},
) {
  codes.push(code);
  params[code] = { ...params[code], ...nextParams };
}

function holdingCategory(holding: WalletHolding): FundRiskLevel {
  const text = `${holding.fundName}${holding.fundType}`;
  if (includesAny(text, ['货币', '现金'])) return 'cash_like';
  if (includesAny(text, ['债', '稳健'])) return 'low';
  if (includesAny(text, ['沪深300', '中证500', '中证1000', '中证A500', '创业板', '科创50', '上证50', '红利', '低波', '全指', '宽基', '指数'])) {
    return 'medium';
  }
  return 'high';
}

function hasRiskData(candidate: FundCandidate) {
  if (candidate.sourceType === 'money_fund' || candidate.poolAssessment.category === 'cash_parking') {
    return true;
  }
  return candidate.performance.maxDrawdown1y !== null || candidate.performance.volatility1y !== null;
}

function inferFundRiskLevel(candidate: FundCandidate, thoughtAnalysis?: FundThoughtAnalysis | null): FundRiskLevel {
  if (
    candidate.poolAssessment.status === 'blocked'
    || candidate.score.blockReasons.length > 0
    || thoughtAnalysis?.overallSignal === 'blocked'
  ) {
    return 'blocked';
  }

  const maxDrawdown = candidate.performance.maxDrawdown1y;
  const volatility = candidate.performance.volatility1y;
  if (candidate.poolAssessment.category === 'watchlist' || candidate.sourceType === 'etf') return 'high';
  if ((maxDrawdown !== null && maxDrawdown <= -20) || (volatility !== null && volatility >= 25)) return 'high';
  if (candidate.sourceType === 'money_fund' || candidate.poolAssessment.category === 'cash_parking') return 'cash_like';
  if (candidate.poolAssessment.category === 'stable' || candidate.type.includes('债')) return 'low';
  if (candidate.poolAssessment.category === 'broad_index') return 'medium';
  return 'high';
}

function applyWalletRiskProfile(riskLevel: FundRiskLevel, wallet: AiWallet): FundRiskLevel {
  if (riskLevel === 'blocked') return 'blocked';
  if (wallet.riskProfile === 'cash_like' && riskLevel !== 'cash_like') return 'high';
  if (wallet.riskProfile === 'low' && riskLevel === 'cash_like') return 'cash_like';
  return riskLevel;
}

function countBuysSince(transactions: WalletTransaction[], since: number) {
  return transactions.filter((transaction) => transaction.action === 'buy' && transaction.createdAt >= since).length;
}

function currentWalletDrawdownPct(wallet: AiWallet, holdings: WalletHolding[]) {
  const investedBase = wallet.investedAmount || holdings.reduce((sum, holding) => sum + holding.totalCost, 0);
  if (investedBase <= 0) return 0;
  const floatingProfit = holdings.reduce((sum, holding) => sum + holding.floatingProfit, 0);
  return (floatingProfit / investedBase) * 100;
}

function minPurchaseAmount(candidate: FundCandidate) {
  const value = candidate.extra.minPurchaseAmount;
  return typeof value === 'number' ? value : null;
}

export function assessWalletRisk({
  candidate,
  holdings,
  now = Date.now(),
  thoughtAnalysis = null,
  transactions,
  wallet,
}: WalletRiskInput): WalletRiskAssessment {
  const reasonCodes: WalletRiskReasonCode[] = [];
  const reasonParams: WalletRiskAssessment['reasonParams'] = {};
  const warnings: string[] = [];
  const blockReasons: string[] = [];
  const fundRiskLevel = applyWalletRiskProfile(inferFundRiskLevel(candidate, thoughtAnalysis), wallet);
  const currentFundExposure = roundMoney(
    holdings
      .filter((holding) => holding.fundCode === candidate.code)
      .reduce((sum, holding) => sum + holding.marketValue, 0),
  );
  const currentCategoryExposure = roundMoney(
    holdings
      .filter((holding) => holdingCategory(holding) === fundRiskLevel)
      .reduce((sum, holding) => sum + holding.marketValue, 0),
  );
  const cashBalance = roundMoney(wallet.cashBalance);
  const totalBudget = roundMoney(wallet.totalBudget);

  if (cashBalance < MIN_BUY_AMOUNT) {
    addReason(reasonCodes, reasonParams, 'wallet_cash_too_low', { cashBalance });
    blockReasons.push('wallet_cash_too_low');
  }
  if (fundRiskLevel === 'blocked') {
    addReason(reasonCodes, reasonParams, 'fund_blocked', { blockCount: candidate.score.blockReasons.length });
    blockReasons.push('fund_blocked');
  }
  if (candidate.poolAssessment.status === 'observe_only') {
    addReason(reasonCodes, reasonParams, 'observe_only_candidate', { category: candidate.poolAssessment.category });
    warnings.push('observe_only_candidate');
  }
  if (fundRiskLevel === 'high') {
    addReason(reasonCodes, reasonParams, 'high_risk_candidate', { sourceType: candidate.sourceType });
    warnings.push('high_risk_candidate');
  }
  if (candidate.sourceType === 'etf') {
    addReason(reasonCodes, reasonParams, 'etf_observe_only', { sourceType: candidate.sourceType });
    warnings.push('etf_observe_only');
  }
  if (!hasRiskData(candidate)) {
    addReason(reasonCodes, reasonParams, 'risk_data_missing');
    warnings.push('risk_data_missing');
  }

  const minAmount = minPurchaseAmount(candidate);
  if (minAmount !== null && minAmount > 20) {
    addReason(reasonCodes, reasonParams, 'min_amount_over_limit', { minAmount, limit: 20 });
    warnings.push('min_amount_over_limit');
  }

  const recent7dBuyCount = countBuysSince(transactions, now - 7 * DAY_MS);
  const recent30dBuyCount = countBuysSince(transactions, now - 30 * DAY_MS);
  const drawdownPct = currentWalletDrawdownPct(wallet, holdings);
  let multiplier = 1;
  let coolingToObserve = false;
  let coolingToPause = false;

  if (recent7dBuyCount >= 2) {
    multiplier *= 0.5;
    addReason(reasonCodes, reasonParams, 'cooldown_7d_frequent_buy', { recent7dBuyCount });
    warnings.push('cooldown_7d_frequent_buy');
  }
  if (recent30dBuyCount >= 5) {
    coolingToObserve = true;
    addReason(reasonCodes, reasonParams, 'cooldown_30d_too_many_buys', { recent30dBuyCount });
    warnings.push('cooldown_30d_too_many_buys');
  }
  if (drawdownPct <= -10) {
    coolingToPause = true;
    addReason(reasonCodes, reasonParams, 'wallet_drawdown_pause', { drawdownPct: roundMoney(drawdownPct) });
    blockReasons.push('wallet_drawdown_pause');
  } else if (drawdownPct <= -5) {
    multiplier *= 0.5;
    addReason(reasonCodes, reasonParams, 'wallet_drawdown_warning', { drawdownPct: roundMoney(drawdownPct) });
    warnings.push('wallet_drawdown_warning');
  }

  const limits = fundRiskLevel === 'cash_like' || fundRiskLevel === 'low' || fundRiskLevel === 'medium'
    ? RISK_LIMITS[fundRiskLevel]
    : null;
  const singleDecisionMaxAmount = limits ? roundMoney(totalBudget * limits.singlePct * multiplier) : 0;
  const fundMaxAmount = limits ? roundMoney(totalBudget * limits.fundPct - currentFundExposure) : 0;
  const categoryMaxAmount = limits ? roundMoney(totalBudget * limits.categoryPct - currentCategoryExposure) : 0;
  const remainingWalletLimit = roundMoney(Math.min(cashBalance, singleDecisionMaxAmount, fundMaxAmount, categoryMaxAmount));

  if (limits && fundMaxAmount <= 0) {
    addReason(reasonCodes, reasonParams, 'fund_limit_reached', { currentFundExposure, fundLimit: roundMoney(totalBudget * limits.fundPct) });
    blockReasons.push('fund_limit_reached');
  }
  if (limits && categoryMaxAmount <= 0) {
    addReason(reasonCodes, reasonParams, 'category_limit_reached', { currentCategoryExposure, categoryLimit: roundMoney(totalBudget * limits.categoryPct) });
    blockReasons.push('category_limit_reached');
  }

  let suggestedMaxAmount = roundMoney(remainingWalletLimit);
  if (blockReasons.length > 0 || coolingToPause || fundRiskLevel === 'blocked') {
    suggestedMaxAmount = 0;
  } else if (fundRiskLevel === 'high' || candidate.poolAssessment.status === 'observe_only' || coolingToObserve) {
    suggestedMaxAmount = 0;
  }
  if (suggestedMaxAmount > 0 && suggestedMaxAmount < MIN_BUY_AMOUNT) {
    addReason(reasonCodes, reasonParams, 'suggested_amount_too_small', { suggestedMaxAmount });
    warnings.push('suggested_amount_too_small');
    suggestedMaxAmount = 0;
  }

  let allowedActions: WalletAllowedAction[];
  if (blockReasons.length > 0 || coolingToPause || fundRiskLevel === 'blocked') {
    allowedActions = ['hold', 'pause'];
  } else if (fundRiskLevel === 'high' || candidate.poolAssessment.status === 'observe_only' || coolingToObserve || suggestedMaxAmount <= 0) {
    allowedActions = ['observe', 'hold', 'pause'];
  } else {
    allowedActions = ['buy', 'observe', 'hold', 'pause'];
  }

  return {
    allowedActions,
    blockReasons: unique(blockReasons),
    categoryMaxAmount,
    currentCategoryExposure,
    currentFundExposure,
    fundMaxAmount,
    fundRiskLevel,
    reasonCodes: unique(reasonCodes),
    reasonParams,
    remainingWalletLimit,
    singleDecisionMaxAmount,
    suggestedMaxAmount,
    warnings: unique(warnings),
  };
}
