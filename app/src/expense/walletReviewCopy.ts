import type { WalletHolding, WalletSnapshot } from './walletStore';

export type WalletValuationReview = {
  dataNotes: string[];
  generatedAt: number;
  profitText: string;
  riskNotes: string[];
  summary: string;
};

function formatMoney(value: number) {
  return `¥${value.toFixed(2)}`;
}

function formatPercent(value: number) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function buildWalletValuationReview({
  holdings,
  skippedCount,
  snapshot,
  updatedCount,
  warnings,
}: {
  holdings: WalletHolding[];
  skippedCount: number;
  snapshot: WalletSnapshot | null;
  updatedCount: number;
  warnings: string[];
}): WalletValuationReview {
  const generatedAt = Date.now();
  const marketValue = snapshot?.marketValue ?? holdings.reduce((sum, holding) => sum + holding.marketValue, 0);
  const floatingProfit = snapshot?.floatingProfit ?? holdings.reduce((sum, holding) => sum + holding.floatingProfit, 0);
  const floatingProfitPct = snapshot?.floatingProfitPct ?? 0;
  const riskNotes = holdings.flatMap((holding) => {
    const notes: string[] = [];
    if (holding.warnDownPct !== null && holding.floatingProfitPct <= holding.warnDownPct) {
      notes.push(`${holding.fundName} 已经碰到下行提醒线，我先建议暂停和观察。`);
    }
    if (holding.warnUpPct !== null && holding.floatingProfitPct >= holding.warnUpPct) {
      notes.push(`${holding.fundName} 已经碰到上行提醒线，可以认真复盘一下。`);
    }
    return notes;
  });
  const dataNotes = [
    ...warnings,
    skippedCount > 0 ? `${skippedCount} 只基金这次数据没拿稳，我没有覆盖旧估值。` : '',
  ].filter(Boolean);
  return {
    dataNotes,
    generatedAt,
    profitText: `当前浮盈亏 ${floatingProfit >= 0 ? '+' : ''}${formatMoney(floatingProfit)}（${formatPercent(floatingProfitPct)}）。`,
    riskNotes,
    summary: updatedCount > 0
      ? `我刷新了 ${updatedCount} 只持仓，当前估值 ${formatMoney(marketValue)}。`
      : '这次没有拿到可以更新的净值，我先保留旧估值。',
  };
}
