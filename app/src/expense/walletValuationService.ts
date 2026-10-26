import { fetchFundCandidate, fetchFundNavHistory } from '../backend/backendClient';
import {
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { assessFundApiSafety, buildDataSafetyNotice } from './walletFundDataSafety';
import { runWalletDataEpochOperation } from './walletDataEpochCoordinator';
import { buildWalletValuationReview, type WalletValuationReview } from './walletReviewCopy';
import {
  updateWalletHoldingValuations,
  type AiWallet,
  type WalletHolding,
  type WalletHoldingValuationUpdate,
  type WalletSnapshot,
} from './walletStore';

export type WalletValuationRefreshItem = {
  fundCode: string;
  fundName: string;
  latestNav: number | null;
  ok: boolean;
  reason: string;
};

export type WalletValuationRefreshResult = {
  committed: boolean;
  items: WalletValuationRefreshItem[];
  ok: boolean;
  review: WalletValuationReview;
  skippedCount: number;
  snapshot: WalletSnapshot | null;
  updatedAt: number;
  updatedCount: number;
  warnings: string[];
};

function isMoneyFund(holding: WalletHolding) {
  return `${holding.fundName}${holding.fundType}`.includes('货币');
}

function latestNavFromHistory(points: Awaited<ReturnType<typeof fetchFundNavHistory>>['data']) {
  const latest = [...(points ?? [])].reverse().find((point) => point.unitNav !== null && point.unitNav > 0);
  return latest?.unitNav ?? null;
}

async function fetchHoldingLatestNav(holding: WalletHolding): Promise<WalletValuationRefreshItem> {
  if (isMoneyFund(holding)) {
    return {
      fundCode: holding.fundCode,
      fundName: holding.fundName,
      latestNav: null,
      ok: false,
      reason: '货币基金估值口径还没接完整。',
    };
  }

  const navHistory = await fetchFundNavHistory(holding.fundCode, 30);
  const historySafety = assessFundApiSafety(navHistory, { requireData: true });
  const historyNav = historySafety.canBuy ? latestNavFromHistory(navHistory.data) : null;
  if (historyNav) {
    return {
      fundCode: holding.fundCode,
      fundName: holding.fundName,
      latestNav: historyNav,
      ok: true,
      reason: 'nav_history',
    };
  }

  const candidate = await fetchFundCandidate(holding.fundCode);
  const candidateSafety = assessFundApiSafety(candidate, {
    requireData: true,
    requireLatestValue: (data) => typeof data?.latestValue === 'number' && data.latestValue > 0,
  });
  const fallbackNav = candidateSafety.canBuy && candidate.data?.latestValue && candidate.data.latestValue > 0
    ? candidate.data.latestValue
    : null;
  if (fallbackNav) {
    return {
      fundCode: holding.fundCode,
      fundName: holding.fundName,
      latestNav: fallbackNav,
      ok: true,
      reason: 'candidate_latest_value',
    };
  }

  return {
    fundCode: holding.fundCode,
    fundName: holding.fundName,
    latestNav: null,
    ok: false,
    reason: [
      ...historySafety.warnings,
      ...candidateSafety.warnings,
      buildDataSafetyNotice(candidateSafety.status === 'fresh' ? historySafety : candidateSafety),
    ].filter(Boolean).join('；') || '数据没拿稳。',
  };
}

export async function refreshWalletValuations({
  dataEpoch,
  holdings,
  wallet,
}: {
  dataEpoch?: number | null;
  holdings: WalletHolding[];
  wallet: AiWallet;
}): Promise<WalletValuationRefreshResult> {
  const updatedAt = Date.now();
  const operation = await runWalletDataEpochOperation({
    dataEpoch,
    coordinator: {
      captureDataEpoch: captureBackupRestoreDataEpoch,
      runDataEpochCommit: runBackupRestoreDataEpochCommit,
    },
    prepare: async () => {
      const items = holdings.length
        ? await Promise.all(holdings.map(fetchHoldingLatestNav))
        : [];
      const updates: WalletHoldingValuationUpdate[] = items
        .filter((item): item is WalletValuationRefreshItem & { latestNav: number } => item.ok && item.latestNav !== null)
        .map((item) => ({
          fundCode: item.fundCode,
          latestNav: item.latestNav,
          updatedAt,
        }));
      const warnings = items.filter((item) => !item.ok).map((item) => `${item.fundName}：${item.reason}`);
      return { items, updates, warnings };
    },
    commit: async (prepared) => {
      const snapshot = prepared.updates.length
        ? await updateWalletHoldingValuations(wallet.id, prepared.updates)
        : null;
      return { ...prepared, snapshot };
    },
  });

  if (!operation.committed) {
    const review = buildWalletValuationReview({
      holdings,
      skippedCount: holdings.length,
      snapshot: null,
      updatedCount: 0,
      warnings: [],
    });
    return {
      committed: false,
      items: [],
      ok: false,
      review,
      skippedCount: holdings.length,
      snapshot: null,
      updatedAt,
      updatedCount: 0,
      warnings: [],
    };
  }

  const { items, snapshot, updates, warnings } = operation.value;
  if (!holdings.length) {
    const review = buildWalletValuationReview({
      holdings,
      skippedCount: 0,
      snapshot: null,
      updatedCount: 0,
      warnings: ['小金库还没有持仓，我先不用刷新估值。'],
    });
    return {
      committed: true,
      items: [],
      ok: true,
      review,
      skippedCount: 0,
      snapshot: null,
      updatedAt,
      updatedCount: 0,
      warnings: review.dataNotes,
    };
  }
  const updatedHoldings = holdings.map((holding) => {
    const update = updates.find((item) => item.fundCode === holding.fundCode);
    if (!update) return holding;
    const marketValue = Math.round(holding.shares * update.latestNav * 100) / 100;
    const floatingProfit = Math.round((marketValue - holding.totalCost) * 100) / 100;
    const floatingProfitPct = holding.totalCost > 0 ? Math.round((floatingProfit / holding.totalCost) * 10000) / 100 : 0;
    return {
      ...holding,
      floatingProfit,
      floatingProfitPct,
      latestNav: update.latestNav,
      marketValue,
      updatedAt,
    };
  });
  const review = buildWalletValuationReview({
    holdings: updatedHoldings,
    skippedCount: holdings.length - updates.length,
    snapshot,
    updatedCount: updates.length,
    warnings,
  });
  return {
    committed: true,
    items,
    ok: updates.length > 0,
    review,
    skippedCount: holdings.length - updates.length,
    snapshot,
    updatedAt,
    updatedCount: updates.length,
    warnings,
  };
}
