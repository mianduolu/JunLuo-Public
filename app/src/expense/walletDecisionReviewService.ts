import { fetchFundCandidate, fetchFundNavHistory, type FundNavPoint } from '../backend/backendClient';
import {
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { assessFundApiSafety } from './walletFundDataSafety';
import { runWalletDataEpochOperation } from './walletDataEpochCoordinator';
import {
  loadWalletDecisionReviews,
  loadWalletDecisions,
  loadWalletTransactions,
  saveWalletDecisionReview,
  type WalletDecision,
  type WalletDecisionReview,
  type WalletDecisionReviewStatus,
  type WalletTransaction,
} from './walletStore';

export type WalletDecisionReviewRefreshResult = {
  committed: boolean;
  createdCount: number;
  ok: boolean;
  reviews: WalletDecisionReview[];
  skippedCount: number;
  updatedCount: number;
  updatedAt: number;
  warnings: string[];
};

export type WalletDecisionReviewRefreshOptions = {
  dataEpoch?: number | null;
};

const dayMs = 24 * 60 * 60 * 1000;

function roundNav(value: number | null) {
  return value === null ? null : Math.round(value * 10000) / 10000;
}

function roundPct(value: number | null) {
  return value === null ? null : Math.round(value * 100) / 100;
}

function dateTextToTime(value: string) {
  const parsed = new Date(`${value}T00:00:00+08:00`).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function navPointsWithTime(points: FundNavPoint[]) {
  return points
    .map((point) => ({ ...point, time: dateTextToTime(point.date) }))
    .filter((point): point is FundNavPoint & { time: number } => point.time !== null && point.unitNav !== null && point.unitNav > 0)
    .sort((left, right) => left.time - right.time);
}

function pointAtOrAfter(points: Array<FundNavPoint & { time: number }>, time: number) {
  return points.find((point) => point.time >= time)?.unitNav ?? points[points.length - 1]?.unitNav ?? null;
}

function maxDrawdownPct(points: Array<FundNavPoint & { time: number }>, fromTime: number, toTime: number) {
  const values = points
    .filter((point) => point.time >= fromTime && point.time <= toTime)
    .map((point) => point.unitNav)
    .filter((value): value is number => value !== null && value > 0);
  if (values.length < 2) return null;
  let peak = values[0];
  let drawdown = 0;
  values.forEach((value) => {
    peak = Math.max(peak, value);
    drawdown = Math.min(drawdown, peak ? (value / peak - 1) * 100 : 0);
  });
  return Math.round(drawdown * 100) / 100;
}

function returnPct(base: number | null, next: number | null) {
  if (!base || !next) return null;
  return roundPct((next / base - 1) * 100);
}

function reviewableDecision(decision: WalletDecision) {
  return decision.status === 'executed' || decision.status === 'approved';
}

function decisionTime(decision: WalletDecision) {
  return decision.executedAt ?? decision.approvedAt ?? decision.createdAt;
}

function decisionTransaction(decision: WalletDecision, transactions: WalletTransaction[]) {
  return transactions.find((transaction) => transaction.decisionId === decision.id) ?? null;
}

async function latestValueFallback(decision: WalletDecision) {
  const candidate = await fetchFundCandidate(decision.fundCode);
  const safety = assessFundApiSafety(candidate, {
    requireData: true,
    requireLatestValue: (data) => typeof data?.latestValue === 'number' && data.latestValue > 0,
  });
  return safety.canBuy && candidate.data?.latestValue && candidate.data.latestValue > 0
    ? candidate.data.latestValue
    : null;
}

async function buildDecisionReview({
  decision,
  existing,
  now,
  transactions,
}: {
  decision: WalletDecision;
  existing: WalletDecisionReview | null;
  now: number;
  transactions: WalletTransaction[];
}): Promise<{ review: WalletDecisionReview; warning: string | null }> {
  const baseAt = decisionTime(decision);
  const ageDays = Math.floor((now - baseAt) / dayMs);
  const tx = decisionTransaction(decision, transactions);
  const requestedDays = Math.max(40, Math.min(3650, ageDays + 35));
  const history = await fetchFundNavHistory(decision.fundCode, requestedDays);
  const historySafety = assessFundApiSafety(history, { requireData: true });
  const points = historySafety.canBuy ? navPointsWithTime(history.data ?? []) : [];
  const baseNav = roundNav(tx?.nav ?? existing?.decisionNav ?? pointAtOrAfter(points, baseAt));
  const fallbackNav = baseNav ?? await latestValueFallback(decision);
  const decisionNav = roundNav(fallbackNav);
  const nav7d = ageDays >= 7 ? roundNav(pointAtOrAfter(points, baseAt + 7 * dayMs)) : existing?.nav7d ?? null;
  const nav30d = ageDays >= 30 ? roundNav(pointAtOrAfter(points, baseAt + 30 * dayMs)) : existing?.nav30d ?? null;
  const return7dPct = ageDays >= 7 ? returnPct(decisionNav, nav7d) : existing?.return7dPct ?? null;
  const return30dPct = ageDays >= 30 ? returnPct(decisionNav, nav30d) : existing?.return30dPct ?? null;
  const drawdown = decisionNav
    ? maxDrawdownPct(points, baseAt, Math.min(now, baseAt + 30 * dayMs))
    : existing?.maxDrawdownPct ?? null;
  const warningTriggered = drawdown !== null && drawdown <= -3;
  const due = ageDays >= 7;
  const hasReturn = return7dPct !== null || return30dPct !== null;
  const status: WalletDecisionReviewStatus = !due ? 'pending' : hasReturn ? 'ready' : 'data_missing';
  const warning = status === 'data_missing'
    ? `${decision.fundName} 的复盘净值没拿稳，我没有硬算收益。`
    : historySafety.warnings[0] ?? history.warnings[0] ?? null;
  return {
    review: {
      decisionId: decision.id,
      decisionNav,
      fundCode: decision.fundCode,
      fundName: decision.fundName,
      id: existing?.id ?? '',
      maxDrawdownPct: drawdown,
      nav7d,
      nav30d,
      reasonStillValid: existing?.reasonStillValid ?? null,
      return7dPct,
      return30dPct,
      reviewedAt: status === 'ready' ? now : existing?.reviewedAt ?? null,
      status,
      updatedAt: now,
      userFeedback: existing?.userFeedback ?? null,
      walletId: decision.walletId,
      warningTriggered,
    },
    warning,
  };
}

export async function refreshWalletDecisionReviews(
  walletId: string,
  { dataEpoch }: WalletDecisionReviewRefreshOptions = {},
): Promise<WalletDecisionReviewRefreshResult> {
  const now = Date.now();
  const operationDataEpoch = dataEpoch === undefined
    ? captureBackupRestoreDataEpoch()
    : dataEpoch;
  const initial = await runBackupRestoreDataEpochCommit(operationDataEpoch, async () => {
    const [decisions, transactions, existingReviews] = await Promise.all([
      loadWalletDecisions(walletId, 120),
      loadWalletTransactions(walletId, 200),
      loadWalletDecisionReviews(walletId, 200),
    ]);
    return { decisions, existingReviews, transactions };
  });
  if (!initial.committed) {
    return {
      committed: false,
      createdCount: 0,
      ok: false,
      reviews: [],
      skippedCount: 0,
      updatedAt: now,
      updatedCount: 0,
      warnings: [],
    };
  }

  const operation = await runWalletDataEpochOperation({
    dataEpoch: operationDataEpoch,
    coordinator: {
      captureDataEpoch: captureBackupRestoreDataEpoch,
      runDataEpochCommit: runBackupRestoreDataEpochCommit,
    },
    prepare: async () => {
      const byDecisionId = new Map(initial.value.existingReviews.map((review) => [review.decisionId, review]));
      const items: Array<{
        existing: WalletDecisionReview | null;
        review: WalletDecisionReview;
      }> = [];
      const warnings: string[] = [];
      let skippedCount = 0;

      for (const decision of initial.value.decisions) {
        if (!reviewableDecision(decision)) {
          skippedCount += 1;
          continue;
        }
        try {
          const existing = byDecisionId.get(decision.id) ?? null;
          const result = await buildDecisionReview({
            decision,
            existing,
            now,
            transactions: initial.value.transactions,
          });
          items.push({ existing, review: result.review });
          if (result.warning) warnings.push(result.warning);
        } catch {
          warnings.push(`${decision.fundName} 的复盘这次没跑完，我先不改旧记录。`);
        }
      }
      return { items, skippedCount, warnings };
    },
    commit: async (prepared) => {
      let createdCount = 0;
      let updatedCount = 0;
      for (const item of prepared.items) {
        await saveWalletDecisionReview(item.review);
        if (item.existing) updatedCount += 1;
        else createdCount += 1;
      }
      const reviews = await loadWalletDecisionReviews(walletId, 200);
      return { ...prepared, createdCount, reviews, updatedCount };
    },
  });

  if (!operation.committed) {
    return {
      committed: false,
      createdCount: 0,
      ok: false,
      reviews: [],
      skippedCount: initial.value.decisions.filter((decision) => !reviewableDecision(decision)).length,
      updatedAt: now,
      updatedCount: 0,
      warnings: [],
    };
  }

  const { createdCount, reviews, skippedCount, updatedCount, warnings } = operation.value;
  return {
    committed: true,
    createdCount,
    ok: createdCount + updatedCount > 0 || reviews.length > 0,
    reviews,
    skippedCount,
    updatedAt: now,
    updatedCount,
    warnings: Array.from(new Set(warnings)).slice(0, 8),
  };
}
