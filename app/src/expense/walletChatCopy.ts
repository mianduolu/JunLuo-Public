import type { AiWallet, WalletDecisionAction } from './walletStore';

export const walletChatCopy = {
  candidateUnavailable: '这次数据没拿稳，我先不写买入卡。',
  decisionReady: '我把小金库决定卡放好啦，小仓鼠点头才算数噢。',
  deferred: '好，那这张小金库卡先放到以后再说。',
  rejected: '好噢，这张小金库卡我记成不买啦。',
  saved: '已经记进小金库啦。',
  statusEmpty: '小金库还空空的，我先守着预算。',
  staleData: '这份数据有点旧，只放观察卡。',
  walletOpen: '我带小仓鼠去小金库看看。',
};

export function buildWalletStatusNotice(wallet: AiWallet, holdingCount: number) {
  if (wallet.totalBudget <= 0) return walletChatCopy.statusEmpty;
  return `小金库现在总预算 ${wallet.totalBudget.toFixed(2)} 元，剩余现金 ${wallet.cashBalance.toFixed(2)} 元，已经投了 ${wallet.investedAmount.toFixed(2)} 元，持仓 ${holdingCount} 只。`;
}

export function buildWalletReviewTitle(action: WalletDecisionAction) {
  const labels: Record<WalletDecisionAction, string> = {
    buy: '小金库买入卡',
    hold: '小金库保持卡',
    observe: '小金库观察卡',
    pause: '小金库暂停卡',
  };
  return labels[action];
}
