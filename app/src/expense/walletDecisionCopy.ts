import type { WalletDecisionAction } from './walletStore';
import type { FundRiskLevel, WalletRiskReasonCode, WalletRiskReasonParams } from './walletRiskRules';

export type WalletDecisionCopyContext = {
  action: WalletDecisionAction;
  amount: number;
  fundName: string;
  fundRiskLevel: FundRiskLevel;
  reasonCodes: WalletRiskReasonCode[];
  reasonParams: Partial<Record<WalletRiskReasonCode, WalletRiskReasonParams>>;
  suggestedMaxAmount: number;
};

export type WalletDecisionCopy = {
  reasoning: string;
  riskWarning: string;
  whyNotMore: string;
};

const reasonFallbackCopy: Record<WalletRiskReasonCode, string> = {
  category_limit_reached: '这一类基金仓位已经满了不能再买了><',
  cooldown_7d_frequent_buy: '最近七天买得太频繁了，先观察一段时间再考虑买入吧(●ˇ∀ˇ●)',
  cooldown_30d_too_many_buys: '最近三十天买入次数太多了Σ(っ °Д °;)っ不要继续买啦！',
  etf_observe_only: '这只ETF目前处于观察期，先不买(・∀・*)',
  fund_data_stale: '这份基金数据有点旧了，先观察不买(・∀・*)',
  fund_data_unavailable: '基金数据没拿稳，不买它！(╯‵□′)╯',
  fund_blocked: '这只基金被规则拦住，现在暂时买不到噢！T T',
  fund_limit_reached: '这只基金今天/这一段时间允许大家买入的总额度已经用完了，买不到了(つд⊂)',
  high_risk_candidate: '这只基金风险较高，要谨慎考虑喔！(⊙ˍ⊙)',
  min_amount_over_limit: '起购金额超过小额测试线了，先不要买啦(ˉ▽ˉ；)...',
  observe_only_candidate: '这只基金目前处于观察期，先不买(・∀・*)',
  risk_data_missing: '基金风险数据不完整，不买它！(╯‵□′)╯',
  suggested_amount_too_small: '算出来能买的金额太小了……( ´•̥̥̥ω•̥̥̥` )',
  wallet_cash_too_low: '钱包……要空空的了……(´°̥̥̥̥̥̥̥̥ω°̥̥̥̥̥̥̥̥｀)',
  wallet_drawdown_pause: '小金库浮亏过大，暂停买入(つд⊂)',
  wallet_drawdown_warning: '小金库有浮亏！要减少金额或暂停买入(つД`)',
};

const actionFallbackCopy: Record<WalletDecisionAction, string> = {
  buy: '买一点点试试……伸手手(●ˇ∀ˇ●)',
  hold: '保持不动！(ง •̀_•́)ง',
  observe: '观察一下(・∀・*)',
  pause: '暂停(つд⊂)',
};

const riskLevelFallbackCopy: Record<FundRiskLevel, string> = {
  blocked: '被规则拦住了，买不到(｡･∀･)',
  cash_like: '现金类/货币类基金，风险很低(●ˇ∀ˇ●)',
  high: '高风险！Σ(っ °Д °;)っ',
  low: '低风险/稳健(●ˇ∀ˇ●)',
  medium: '中等风险/宽基指数(・∀・*)',
};

function primaryReason(context: WalletDecisionCopyContext) {
  const code = context.reasonCodes[0];
  return code ? reasonFallbackCopy[code] : actionFallbackCopy[context.action];
}

export function buildLocalWalletDecisionCopy(context: WalletDecisionCopyContext): WalletDecisionCopy {
  return {
    reasoning: `${actionFallbackCopy[context.action]} ${primaryReason(context)}`.trim(),
    riskWarning: riskLevelFallbackCopy[context.fundRiskLevel],
    whyNotMore: `这次我最多只看到 ${context.suggestedMaxAmount} 元，再多就有点危险啦！(´°̥̥̥̥̥̥̥̥ω°̥̥̥̥̥̥̥̥｀)`,
  };
}
