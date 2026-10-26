import type { FundApiResponse } from '../backend/backendClient';
import type { WalletRiskAssessment, WalletRiskReasonCode } from './walletRiskRules';

export type FundDataSafetyStatus = 'fresh' | 'stale' | 'unavailable' | 'expired_cache' | 'incomplete';

export type FundDataSafetyReasonCode =
  | WalletRiskReasonCode
  | 'fund_cache_expired'
  | 'fund_nav_missing'
  | 'purchase_status_unknown';

export type FundDataSafetyState = {
  canBuy: boolean;
  canObserve: boolean;
  reasonCodes: FundDataSafetyReasonCode[];
  status: FundDataSafetyStatus;
  warnings: string[];
};

type FundDataSafetyOptions<T> = {
  requireData?: boolean;
  requireLatestValue?: (data: T | null) => boolean;
  requirePurchaseStatus?: (data: T | null) => boolean;
};

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function baseState(status: FundDataSafetyStatus): FundDataSafetyState {
  return {
    canBuy: status === 'fresh',
    canObserve: status !== 'unavailable',
    reasonCodes: [],
    status,
    warnings: [],
  };
}

function withReason(
  state: FundDataSafetyState,
  code: FundDataSafetyReasonCode,
  warning: string,
): FundDataSafetyState {
  return {
    ...state,
    reasonCodes: unique([...state.reasonCodes, code]),
    warnings: unique([...state.warnings, warning]),
  };
}

export function assessFundApiSafety<T>(
  response: FundApiResponse<T>,
  options: FundDataSafetyOptions<T> = {},
): FundDataSafetyState {
  const data = response.data ?? null;
  if (!response.ok || response.source === 'none') {
    return withReason(
      { ...baseState('unavailable'), canObserve: data !== null },
      'fund_data_unavailable',
      '基金数据不可用，不能作为买入依据。',
    );
  }

  if (response.cache?.isExpired) {
    return withReason(
      { ...baseState('expired_cache'), canBuy: false, canObserve: data !== null },
      'fund_cache_expired',
      '基金缓存已经过期，只能观察。',
    );
  }

  if (response.stale) {
    return withReason(
      { ...baseState('stale'), canBuy: false, canObserve: data !== null },
      'fund_data_stale',
      '基金数据偏旧，只能观察。',
    );
  }

  if (options.requireData && data === null) {
    return withReason(
      { ...baseState('incomplete'), canBuy: false, canObserve: false },
      'fund_data_unavailable',
      '基金数据为空，不能作为买入依据。',
    );
  }

  let state = baseState('fresh');
  if (options.requireLatestValue && !options.requireLatestValue(data)) {
    state = withReason(
      { ...baseState('incomplete'), canBuy: false, canObserve: data !== null },
      'fund_nav_missing',
      '缺少最新净值或价格，只能观察。',
    );
  }

  if (options.requirePurchaseStatus && !options.requirePurchaseStatus(data)) {
    state = withReason(
      { ...state, status: 'incomplete', canBuy: false, canObserve: data !== null },
      'purchase_status_unknown',
      '申购状态不明，只能观察。',
    );
  }

  return state;
}

export function buildDataSafetyNotice(state: FundDataSafetyState) {
  if (state.status === 'fresh') return '数据可用。';
  if (state.status === 'stale') return '数据有点旧，只能观察。';
  if (state.status === 'expired_cache') return '缓存过期，只能观察。';
  if (state.status === 'incomplete') return '关键数据不完整，只能观察。';
  return '基金数据没拿稳，不能作为买入依据。';
}

export function fundDataSafetyToWalletRiskReasons(state: FundDataSafetyState): WalletRiskReasonCode[] {
  const mapped = state.reasonCodes.map((code): WalletRiskReasonCode => {
    if (code === 'fund_data_stale' || code === 'fund_cache_expired') return 'fund_data_stale';
    if (code === 'fund_nav_missing' || code === 'purchase_status_unknown') return 'risk_data_missing';
    return code as WalletRiskReasonCode;
  });
  return unique(mapped);
}

export function applyFundDataSafetyToRisk(
  assessment: WalletRiskAssessment,
  safetyState: FundDataSafetyState,
): WalletRiskAssessment {
  if (safetyState.canBuy) {
    return {
      ...assessment,
      warnings: unique([...assessment.warnings, ...safetyState.warnings]),
    };
  }

  const reasonCodes = fundDataSafetyToWalletRiskReasons(safetyState);
  const allowedActions = assessment.allowedActions.filter((action) => action !== 'buy');
  return {
    ...assessment,
    allowedActions: allowedActions.length ? allowedActions : ['observe', 'hold', 'pause'],
    reasonCodes: unique([...assessment.reasonCodes, ...reasonCodes]),
    reasonParams: reasonCodes.reduce(
      (params, code) => ({
        ...params,
        [code]: params[code] ?? { dataSafetyStatus: safetyState.status },
      }),
      { ...assessment.reasonParams },
    ),
    suggestedMaxAmount: 0,
    warnings: unique([...assessment.warnings, ...safetyState.warnings, buildDataSafetyNotice(safetyState)]),
  };
}
