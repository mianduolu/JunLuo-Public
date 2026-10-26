import type * as SQLite from 'expo-sqlite';

import type {
  WalletLedgerBusinessPort,
} from './syncWalletLedgerApply';
import {
  assertWalletLedgerRecord,
  type WalletLedgerDecisionRecord,
  type WalletLedgerEntityType,
  type WalletLedgerHoldingRecord,
  type WalletLedgerPreferenceRecord,
  type WalletLedgerRecord,
  type WalletLedgerReviewRecord,
  type WalletLedgerSnapshotRecord,
  type WalletLedgerTransactionRecord,
  type WalletLedgerWalletRecord,
} from './syncWalletLedger';

type SqlTransaction = Pick<SQLite.SQLiteDatabase, 'runAsync'>;

export async function applyWalletLedgerRecordToSqlite(input: {
  transaction: SqlTransaction;
  entityType: WalletLedgerEntityType;
  entityId: string;
  record: WalletLedgerRecord;
}) {
  assertWalletLedgerRecord(
    input.entityType,
    input.entityId,
    input.record,
  );
  switch (input.entityType) {
    case 'wallet': {
      const record = input.record as WalletLedgerWalletRecord;
      await input.transaction.runAsync(
        `INSERT INTO ai_wallets (
           id, owner, name, total_budget, cash_balance, invested_amount,
           risk_profile, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           owner = excluded.owner,
           name = excluded.name,
           total_budget = excluded.total_budget,
           cash_balance = excluded.cash_balance,
           invested_amount = excluded.invested_amount,
           risk_profile = excluded.risk_profile,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
        record.id,
        record.owner,
        record.name,
        record.totalBudget,
        record.cashBalance,
        record.investedAmount,
        record.riskProfile,
        record.createdAt,
        record.updatedAt,
      );
      return;
    }
    case 'preference': {
      const record = input.record as WalletLedgerPreferenceRecord;
      await input.transaction.runAsync(
        `INSERT INTO wallet_preferences (
           wallet_id, enabled, tendency, preferred_pools_json,
           avoid_types_json, comfort_single_amount, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(wallet_id) DO UPDATE SET
           enabled = excluded.enabled,
           tendency = excluded.tendency,
           preferred_pools_json = excluded.preferred_pools_json,
           avoid_types_json = excluded.avoid_types_json,
           comfort_single_amount = excluded.comfort_single_amount,
           updated_at = excluded.updated_at`,
        record.walletId,
        record.enabled ? 1 : 0,
        record.tendency,
        JSON.stringify(record.preferredPools),
        JSON.stringify(record.avoidTypes),
        record.comfortSingleAmount,
        record.updatedAt,
      );
      return;
    }
    case 'holding': {
      const record = input.record as WalletLedgerHoldingRecord;
      await input.transaction.runAsync(
        `INSERT INTO wallet_holdings (
           id, wallet_id, fund_code, fund_name, fund_type, shares,
           avg_cost_nav, total_cost, latest_nav, market_value,
           floating_profit, floating_profit_pct, warn_down_pct,
           warn_up_pct, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           fund_name = excluded.fund_name,
           fund_type = excluded.fund_type,
           shares = excluded.shares,
           avg_cost_nav = excluded.avg_cost_nav,
           total_cost = excluded.total_cost,
           latest_nav = excluded.latest_nav,
           market_value = excluded.market_value,
           floating_profit = excluded.floating_profit,
           floating_profit_pct = excluded.floating_profit_pct,
           warn_down_pct = excluded.warn_down_pct,
           warn_up_pct = excluded.warn_up_pct,
           updated_at = excluded.updated_at`,
        record.id,
        record.walletId,
        record.fundCode,
        record.fundName,
        record.fundType,
        record.shares,
        record.avgCostNav,
        record.totalCost,
        record.latestNav,
        record.marketValue,
        record.floatingProfit,
        record.floatingProfitPct,
        record.warnDownPct,
        record.warnUpPct,
        record.updatedAt,
      );
      return;
    }
    case 'decision': {
      const record = input.record as WalletLedgerDecisionRecord;
      await input.transaction.runAsync(
        `INSERT INTO wallet_decisions (
           id, wallet_id, fund_code, fund_name, fund_type, action,
           amount, status, confidence, reasoning, risk_warning,
           why_not_more, source, suggested_nav, suggested_nav_source,
           suggested_nav_at, created_at, approved_at, rejected_at,
           executed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           approved_at = excluded.approved_at,
           rejected_at = excluded.rejected_at,
           executed_at = excluded.executed_at`,
        record.id,
        record.walletId,
        record.fundCode,
        record.fundName,
        record.fundType,
        record.action,
        record.amount,
        record.status,
        record.confidence,
        record.reasoning,
        record.riskWarning,
        record.whyNotMore,
        record.source,
        record.suggestedNav,
        record.suggestedNavSource,
        record.suggestedNavAt,
        record.createdAt,
        record.approvedAt,
        record.rejectedAt,
        record.executedAt,
      );
      return;
    }
    case 'transaction': {
      const record = input.record as WalletLedgerTransactionRecord;
      await input.transaction.runAsync(
        `INSERT INTO wallet_transactions (
           id, wallet_id, decision_id, fund_code, fund_name,
           action, amount, shares, nav, fee, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        record.id,
        record.walletId,
        record.decisionId,
        record.fundCode,
        record.fundName,
        record.action,
        record.amount,
        record.shares,
        record.nav,
        record.fee,
        record.createdAt,
      );
      return;
    }
    case 'snapshot': {
      const record = input.record as WalletLedgerSnapshotRecord;
      await input.transaction.runAsync(
        `INSERT INTO wallet_snapshots (
           id, wallet_id, cash_balance, invested_amount, market_value,
           floating_profit, floating_profit_pct, snapshot_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        record.id,
        record.walletId,
        record.cashBalance,
        record.investedAmount,
        record.marketValue,
        record.floatingProfit,
        record.floatingProfitPct,
        record.snapshotAt,
      );
      return;
    }
    case 'review': {
      const record = input.record as WalletLedgerReviewRecord;
      await input.transaction.runAsync(
        `INSERT INTO wallet_decision_reviews (
           id, wallet_id, decision_id, fund_code, fund_name,
           decision_nav, nav_7d, nav_30d, return_7d_pct,
           return_30d_pct, max_drawdown_pct, warning_triggered,
           user_feedback, reason_still_valid, status, reviewed_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           fund_code = excluded.fund_code,
           fund_name = excluded.fund_name,
           decision_nav = excluded.decision_nav,
           nav_7d = excluded.nav_7d,
           nav_30d = excluded.nav_30d,
           return_7d_pct = excluded.return_7d_pct,
           return_30d_pct = excluded.return_30d_pct,
           max_drawdown_pct = excluded.max_drawdown_pct,
           warning_triggered = excluded.warning_triggered,
           user_feedback = excluded.user_feedback,
           reason_still_valid = excluded.reason_still_valid,
           status = excluded.status,
           reviewed_at = excluded.reviewed_at,
           updated_at = excluded.updated_at`,
        record.id,
        record.walletId,
        record.decisionId,
        record.fundCode,
        record.fundName,
        record.decisionNav,
        record.nav7d,
        record.nav30d,
        record.return7dPct,
        record.return30dPct,
        record.maxDrawdownPct,
        record.warningTriggered ? 1 : 0,
        record.userFeedback,
        record.reasonStillValid === null
          ? null
          : record.reasonStillValid
            ? 1
            : 0,
        record.status,
        record.reviewedAt,
        record.updatedAt,
      );
    }
  }
}

async function runSuppressed<T>(
  apply: (transaction: SQLite.SQLiteDatabase) => Promise<T>,
) {
  const { runWithWalletLedgerCaptureSuppressed } =
    await import('./syncWalletLedgerSqlitePort');
  return runWithWalletLedgerCaptureSuppressed(apply);
}

export const walletLedgerSqliteBusinessPort:
WalletLedgerBusinessPort = {
  upsertRecord: async (input) => {
    await runSuppressed(async (transaction) => {
      await applyWalletLedgerRecordToSqlite({
        transaction,
        entityType: input.entityType,
        entityId: input.entityId,
        record: input.record,
      });
    });
  },
};
