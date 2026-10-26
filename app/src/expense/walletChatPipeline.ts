import type { AiConnection } from '../ai/types';
import {
  loadOrCreateDefaultWallet,
  loadWalletHoldings,
  type AiWallet,
  type WalletHolding,
  type WalletPreferenceConfig,
  type WalletTransaction,
} from './walletStore';
import { buildWalletStatusNotice, walletChatCopy } from './walletChatCopy';
import {
  buildWalletFundDecisionFromText,
  type WalletFundDecisionReview,
} from './walletFundDecisionPipeline';

export type WalletChatIntent = 'wallet_status' | 'wallet_decision' | 'wallet_open' | 'none';

export type WalletDecisionReviewAction = WalletFundDecisionReview;

export type WalletChatPipelineResult =
  | { kind: 'decision_ready'; notice: string; review: WalletDecisionReviewAction }
  | { kind: 'status'; notice: string }
  | { kind: 'open'; notice: string }
  | { kind: 'unavailable'; notice: string; warnings: string[] };

export type WalletChatPipelineInput = {
  apiKey?: string;
  connection?: AiConnection;
  holdings?: WalletHolding[];
  text: string;
  transactions?: WalletTransaction[];
  wallet?: AiWallet;
  walletPreferences?: WalletPreferenceConfig;
};

const FUND_CODE_PATTERN = /\b\d{6}\b/;

function hasAny(text: string, words: string[]) {
  return words.some((word) => text.includes(word));
}

export function classifyWalletChatIntent(text: string): WalletChatIntent {
  const normalized = text.trim();
  if (!normalized) return 'none';
  const mentionsWallet = hasAny(normalized, ['小金库', '基金', '理财']) || /白云今天想买什么/.test(normalized);
  if (!mentionsWallet && !FUND_CODE_PATTERN.test(normalized)) return 'none';
  if (hasAny(normalized, ['打开小金库', '去小金库', '进小金库', '看看小金库页面'])) return 'wallet_open';
  if (hasAny(normalized, ['怎么样', '状态', '余额', '持仓', '赚', '亏']) && hasAny(normalized, ['小金库', '钱包'])) {
    return 'wallet_status';
  }
  if (FUND_CODE_PATTERN.test(normalized) || hasAny(normalized, ['买什么', '想买', '看看', '分析', '观察', '基金', '理财'])) {
    return 'wallet_decision';
  }
  return 'none';
}

export async function buildWalletChatDecisionFromText({
  apiKey,
  connection,
  holdings,
  text,
  transactions,
  wallet,
  walletPreferences,
}: WalletChatPipelineInput): Promise<WalletChatPipelineResult> {
  const intent = classifyWalletChatIntent(text);
  const currentWallet = wallet ?? await loadOrCreateDefaultWallet({ initialBudget: 100 });
  const currentHoldings = holdings ?? await loadWalletHoldings(currentWallet.id);

  if (intent === 'wallet_open') return { kind: 'open', notice: walletChatCopy.walletOpen };
  if (intent === 'wallet_status') {
    return { kind: 'status', notice: buildWalletStatusNotice(currentWallet, currentHoldings.length) };
  }
  if (intent !== 'wallet_decision') {
    return { kind: 'unavailable', notice: walletChatCopy.candidateUnavailable, warnings: [] };
  }

  const result = await buildWalletFundDecisionFromText({
    apiKey,
    connection,
    holdings: currentHoldings,
    includeEtf: /ETF/i.test(text),
    text,
    transactions,
    wallet: currentWallet,
    walletPreferences,
  });
  if (result.kind !== 'decision_ready') {
    return {
      kind: 'unavailable',
      notice: walletChatCopy.candidateUnavailable,
      warnings: result.warnings,
    };
  }

  const stale = result.review.riskAssessment.reasonCodes.includes('fund_data_stale');
  return {
    kind: 'decision_ready',
    notice: stale ? walletChatCopy.staleData : walletChatCopy.decisionReady,
    review: result.review,
  };
}
