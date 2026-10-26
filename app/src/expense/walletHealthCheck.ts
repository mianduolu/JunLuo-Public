import type { FundCacheStatusItem } from '../backend/backendClient';
import type {
  AiWallet,
  WalletDecision,
  WalletDecisionReview,
  WalletHolding,
  WalletSnapshot,
  WalletTransaction,
} from './walletStore';

export type WalletHealthStatus = 'ok' | 'warning' | 'blocked';

export type WalletHealthCapability = {
  detail: string;
  id: string;
  label: string;
  status: WalletHealthStatus;
};

export type WalletHealthReport = {
  completedCapabilities: WalletHealthCapability[];
  lastCheckedAt: number;
  missingCapabilities: WalletHealthCapability[];
  overallStatus: WalletHealthStatus;
  safeBoundaries: string[];
  warnings: string[];
};

export type WalletHealthInput = {
  cacheStatus?: FundCacheStatusItem[] | null;
  decisions: WalletDecision[];
  holdings: WalletHolding[];
  reviews: WalletDecisionReview[];
  snapshots: WalletSnapshot[];
  transactions: WalletTransaction[];
  wallet: AiWallet | null;
};

const safeBoundaries = [
  '不自动真实下单',
  '不登录券商账户',
  '不从支付宝或微信扣款',
  '不做杠杆、期货、期权',
  '不做个股短线交易',
  '不承诺收益',
  '小仓鼠确认后才记录',
];

function capability(id: string, label: string, status: WalletHealthStatus, detail: string): WalletHealthCapability {
  return { detail, id, label, status };
}

function hasPendingDecision(decisions: WalletDecision[]) {
  return decisions.some((decision) => decision.status === 'proposed');
}

function hasHandledDecision(decisions: WalletDecision[]) {
  return decisions.some((decision) => decision.status !== 'proposed');
}

function cacheDetail(cacheStatus: FundCacheStatusItem[] | null | undefined) {
  if (!cacheStatus) return capability('cache', '缓存兜底', 'warning', '缓存状态还没有读取；不影响本地小金库，只是数据桥体检不完整。');
  if (!cacheStatus.length) return capability('cache', '缓存兜底', 'warning', '还没有基金缓存记录；后端拿不到数据时只能温柔失败。');
  const expiredCount = cacheStatus.filter((item) => item.isExpired).length;
  if (expiredCount) {
    return capability('cache', '缓存兜底', 'warning', `已看到 ${cacheStatus.length} 条缓存，其中 ${expiredCount} 条过期；过期数据只能观察。`);
  }
  return capability('cache', '缓存兜底', 'ok', `已看到 ${cacheStatus.length} 条基金缓存状态。`);
}

export function buildWalletHealthReport({
  cacheStatus = null,
  decisions,
  holdings,
  reviews,
  snapshots,
  transactions,
  wallet,
}: WalletHealthInput): WalletHealthReport {
  const capabilities: WalletHealthCapability[] = [
    capability(
      'wallet',
      '小金库账户',
      wallet ? 'ok' : 'warning',
      wallet ? `预算 ${wallet.totalBudget.toFixed(2)} 元，现金 ${wallet.cashBalance.toFixed(2)} 元。` : '还没有读到默认小金库账户。',
    ),
    capability(
      'local-ledger',
      '本地账本',
      wallet ? 'ok' : 'warning',
      '钱包、决定、持仓、交易、快照、复盘都保存在本地账本里。',
    ),
    capability(
      'decision-card',
      '确认卡',
      hasPendingDecision(decisions) || hasHandledDecision(decisions) ? 'ok' : 'warning',
      decisions.length ? `已经有 ${decisions.length} 张决定卡记录。` : '还没有决定卡记录，可以先用测试卡或聊天生成。',
    ),
    capability(
      'holdings',
      '持仓与估值',
      holdings.length || snapshots.length ? 'ok' : 'warning',
      holdings.length ? `当前记录 ${holdings.length} 只持仓，${snapshots.length} 条快照。` : '还没有持仓或快照，估值能力待实际记录后验证。',
    ),
    capability(
      'transactions',
      '模拟交易记录',
      transactions.length ? 'ok' : 'warning',
      transactions.length ? `已经有 ${transactions.length} 条本地模拟交易。` : '还没有模拟交易记录。',
    ),
    capability(
      'review-learning',
      '复盘学习',
      reviews.length ? 'ok' : 'warning',
      reviews.length ? `已经有 ${reviews.length} 条决定后复盘记录。` : '还没有可复盘记录，等决定满 7/30 天后再看。',
    ),
    cacheDetail(cacheStatus),
    capability('risk-brake', '风险刹车', 'ok', '买入前会经过候选池、规则评分、风险上限和结构化校验。'),
    capability('chat-link', '聊天联动', 'ok', '聊天可以生成待确认卡，但不会自动执行。'),
    capability('safe-boundary', '安全边界', 'ok', '白云小姐只分析、提醒和记录，真实动作始终等小仓鼠确认。'),
  ];

  const completedCapabilities = capabilities.filter((item) => item.status === 'ok');
  const missingCapabilities = capabilities.filter((item) => item.status !== 'ok');
  const warnings = missingCapabilities.map((item) => `${item.label}：${item.detail}`);
  const overallStatus: WalletHealthStatus = capabilities.some((item) => item.status === 'blocked')
    ? 'blocked'
    : missingCapabilities.length
      ? 'warning'
      : 'ok';

  return {
    completedCapabilities,
    lastCheckedAt: Date.now(),
    missingCapabilities,
    overallStatus,
    safeBoundaries,
    warnings,
  };
}
