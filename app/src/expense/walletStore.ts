import * as SQLite from 'expo-sqlite';
import { getExpenseDatabase } from './expenseStore';
import {
  WALLET_LEDGER_FULL_CAPTURE_SCHEMA_SQL,
  WALLET_LEDGER_RESET_TECHNICAL_STATE_SQL,
} from '../sync/syncWalletLedgerSql';

export type WalletRiskProfile = 'cash_like' | 'low' | 'medium' | 'high';
export type WalletDecisionAction = 'buy' | 'observe' | 'hold' | 'pause';
export type WalletDecisionStatus = 'proposed' | 'approved' | 'rejected' | 'deferred' | 'executed' | 'expired' | 'blocked';
export type WalletDecisionSource = 'manual' | 'chat' | 'baiyun';
export type WalletDecisionNavSource = 'candidate_latest_value' | 'cash_like_unit_nav' | 'nav_history' | 'manual';
export type WalletPreferredPool = 'cash_parking' | 'stable' | 'broad_index';
export type WalletAvoidType = 'watchlist' | 'etf' | 'qdii' | 'commodity' | 'industry';

export type WalletPreferenceConfig = {
  avoidTypes: WalletAvoidType[];
  comfortSingleAmount: number | null;
  enabled: boolean;
  preferredPools: WalletPreferredPool[];
  tendency: string;
  updatedAt: number;
  walletId: string;
};

export type AiWallet = {
  cashBalance: number;
  createdAt: number;
  id: string;
  investedAmount: number;
  name: string;
  owner: string;
  riskProfile: WalletRiskProfile;
  totalBudget: number;
  updatedAt: number;
};

export type WalletDecision = {
  action: WalletDecisionAction;
  amount: number;
  approvedAt: number | null;
  confidence: number;
  createdAt: number;
  executedAt: number | null;
  fundCode: string;
  fundName: string;
  fundType: string;
  id: string;
  rejectedAt: number | null;
  reasoning: string;
  riskWarning: string;
  source: WalletDecisionSource;
  status: WalletDecisionStatus;
  suggestedNav: number | null;
  suggestedNavAt: number | null;
  suggestedNavSource: WalletDecisionNavSource | null;
  walletId: string;
  whyNotMore: string;
};

export type WalletHolding = {
  avgCostNav: number;
  floatingProfit: number;
  floatingProfitPct: number;
  fundCode: string;
  fundName: string;
  fundType: string;
  id: string;
  latestNav: number;
  marketValue: number;
  shares: number;
  totalCost: number;
  updatedAt: number;
  walletId: string;
  warnDownPct: number | null;
  warnUpPct: number | null;
};

export type WalletTransaction = {
  action: WalletDecisionAction;
  amount: number;
  createdAt: number;
  decisionId: string | null;
  fee: number;
  fundCode: string;
  fundName: string;
  id: string;
  nav: number;
  shares: number;
  walletId: string;
};

export type WalletSnapshot = {
  cashBalance: number;
  floatingProfit: number;
  floatingProfitPct: number;
  id: string;
  investedAmount: number;
  marketValue: number;
  snapshotAt: number;
  walletId: string;
};

export type WalletDecisionReviewStatus = 'pending' | 'ready' | 'data_missing';

export type WalletDecisionReview = {
  decisionId: string;
  decisionNav: number | null;
  fundCode: string;
  fundName: string;
  id: string;
  maxDrawdownPct: number | null;
  nav7d: number | null;
  nav30d: number | null;
  reasonStillValid: boolean | null;
  return7dPct: number | null;
  return30dPct: number | null;
  reviewedAt: number | null;
  status: WalletDecisionReviewStatus;
  updatedAt: number;
  userFeedback: string | null;
  walletId: string;
  warningTriggered: boolean;
};

export type WalletDecisionDraft = {
  action: WalletDecisionAction;
  amount?: number;
  confidence?: number;
  fundCode: string;
  fundName: string;
  fundType?: string;
  reasoning: string;
  riskWarning: string;
  source?: WalletDecisionSource;
  suggestedNav?: number | null;
  suggestedNavAt?: number | null;
  suggestedNavSource?: WalletDecisionNavSource | null;
  whyNotMore: string;
};

export type WalletBuyExecution = {
  decisionId: string;
  fee?: number;
  nav: number;
};

export type WalletDecisionApproval = {
  decisionId: string;
};

export type WalletHoldingValuationUpdate = {
  fundCode: string;
  latestNav: number;
  updatedAt?: number;
};

export type WalletManualHoldingImport = {
  avgCostNav?: number | null;
  fundCode: string;
  fundName: string;
  fundType?: string | null;
  latestNav: number;
  shares?: number | null;
  totalCost?: number | null;
  walletId: string;
  warnDownPct?: number | null;
  warnUpPct?: number | null;
};

export type WalletDecisionReviewWrite = Omit<WalletDecisionReview, 'id'> & { id?: string };

type WalletRow = {
  cash_balance: number;
  created_at: number;
  id: string;
  invested_amount: number;
  name: string;
  owner: string;
  risk_profile: WalletRiskProfile;
  total_budget: number;
  updated_at: number;
};

type DecisionRow = {
  action: WalletDecisionAction;
  amount: number;
  approved_at: number | null;
  confidence: number;
  created_at: number;
  executed_at: number | null;
  fund_code: string;
  fund_name: string;
  fund_type: string;
  id: string;
  rejected_at: number | null;
  reasoning: string;
  risk_warning: string;
  source: WalletDecisionSource;
  status: WalletDecisionStatus;
  suggested_nav: number | null;
  suggested_nav_at: number | null;
  suggested_nav_source: WalletDecisionNavSource | null;
  wallet_id: string;
  why_not_more: string;
};

type HoldingRow = {
  avg_cost_nav: number;
  floating_profit: number;
  floating_profit_pct: number;
  fund_code: string;
  fund_name: string;
  fund_type: string;
  id: string;
  latest_nav: number;
  market_value: number;
  shares: number;
  total_cost: number;
  updated_at: number;
  wallet_id: string;
  warn_down_pct: number | null;
  warn_up_pct: number | null;
};

type TransactionRow = {
  action: WalletDecisionAction;
  amount: number;
  created_at: number;
  decision_id: string | null;
  fee: number;
  fund_code: string;
  fund_name: string;
  id: string;
  nav: number;
  shares: number;
  wallet_id: string;
};

type SnapshotRow = {
  cash_balance: number;
  floating_profit: number;
  floating_profit_pct: number;
  id: string;
  invested_amount: number;
  market_value: number;
  snapshot_at: number;
  wallet_id: string;
};

type DecisionReviewRow = {
  decision_id: string;
  decision_nav: number | null;
  fund_code: string;
  fund_name: string;
  id: string;
  max_drawdown_pct: number | null;
  nav_7d: number | null;
  nav_30d: number | null;
  reason_still_valid: number | null;
  return_7d_pct: number | null;
  return_30d_pct: number | null;
  reviewed_at: number | null;
  status: WalletDecisionReviewStatus;
  updated_at: number;
  user_feedback: string | null;
  wallet_id: string;
  warning_triggered: number;
};

type WalletPreferenceRow = {
  avoid_types_json: string;
  comfort_single_amount: number | null;
  enabled: number;
  preferred_pools_json: string;
  tendency: string;
  updated_at: number;
  wallet_id: string;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function roundMoney(value: number) {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function roundShares(value: number) {
  return Math.round(Math.max(0, value) * 10000) / 10000;
}

function roundNav(value: number) {
  return Math.round(Math.max(0, value) * 10000) / 10000;
}

const walletPreferredPools: WalletPreferredPool[] = ['cash_parking', 'stable', 'broad_index'];
const walletAvoidTypes: WalletAvoidType[] = ['watchlist', 'etf', 'qdii', 'commodity', 'industry'];

function defaultWalletPreferences(walletId: string, updatedAt = Date.now()): WalletPreferenceConfig {
  return {
    avoidTypes: [],
    comfortSingleAmount: null,
    enabled: true,
    preferredPools: [],
    tendency: '',
    updatedAt,
    walletId,
  };
}

function parseStringArray<T extends string>(value: string | null | undefined, allowed: readonly T[]) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is T => typeof item === 'string' && allowed.includes(item as T));
  } catch {
    return [];
  }
}

function normalizePercent(value: number) {
  return Math.round(value * 100) / 100;
}

function fromWalletRow(row: WalletRow): AiWallet {
  return {
    cashBalance: row.cash_balance,
    createdAt: row.created_at,
    id: row.id,
    investedAmount: row.invested_amount,
    name: row.name,
    owner: row.owner,
    riskProfile: row.risk_profile,
    totalBudget: row.total_budget,
    updatedAt: row.updated_at,
  };
}

function fromDecisionRow(row: DecisionRow): WalletDecision {
  return {
    action: row.action,
    amount: row.amount,
    approvedAt: row.approved_at,
    confidence: row.confidence,
    createdAt: row.created_at,
    executedAt: row.executed_at,
    fundCode: row.fund_code,
    fundName: row.fund_name,
    fundType: row.fund_type,
    id: row.id,
    rejectedAt: row.rejected_at,
    reasoning: row.reasoning,
    riskWarning: row.risk_warning,
    source: row.source,
    status: row.status,
    suggestedNav: row.suggested_nav,
    suggestedNavAt: row.suggested_nav_at,
    suggestedNavSource: row.suggested_nav_source,
    walletId: row.wallet_id,
    whyNotMore: row.why_not_more,
  };
}

async function addColumnIfMissing(database: SQLite.SQLiteDatabase, table: string, name: string, definition: string) {
  const columns = await database.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!columns.some((column) => column.name === name)) {
    await database.execAsync(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition};`);
  }
}

function fromHoldingRow(row: HoldingRow): WalletHolding {
  return {
    avgCostNav: row.avg_cost_nav,
    floatingProfit: row.floating_profit,
    floatingProfitPct: row.floating_profit_pct,
    fundCode: row.fund_code,
    fundName: row.fund_name,
    fundType: row.fund_type,
    id: row.id,
    latestNav: row.latest_nav,
    marketValue: row.market_value,
    shares: row.shares,
    totalCost: row.total_cost,
    updatedAt: row.updated_at,
    walletId: row.wallet_id,
    warnDownPct: row.warn_down_pct,
    warnUpPct: row.warn_up_pct,
  };
}

function fromTransactionRow(row: TransactionRow): WalletTransaction {
  return {
    action: row.action,
    amount: row.amount,
    createdAt: row.created_at,
    decisionId: row.decision_id,
    fee: row.fee,
    fundCode: row.fund_code,
    fundName: row.fund_name,
    id: row.id,
    nav: row.nav,
    shares: row.shares,
    walletId: row.wallet_id,
  };
}

function fromSnapshotRow(row: SnapshotRow): WalletSnapshot {
  return {
    cashBalance: row.cash_balance,
    floatingProfit: row.floating_profit,
    floatingProfitPct: row.floating_profit_pct,
    id: row.id,
    investedAmount: row.invested_amount,
    marketValue: row.market_value,
    snapshotAt: row.snapshot_at,
    walletId: row.wallet_id,
  };
}

function fromDecisionReviewRow(row: DecisionReviewRow): WalletDecisionReview {
  return {
    decisionId: row.decision_id,
    decisionNav: row.decision_nav,
    fundCode: row.fund_code,
    fundName: row.fund_name,
    id: row.id,
    maxDrawdownPct: row.max_drawdown_pct,
    nav7d: row.nav_7d,
    nav30d: row.nav_30d,
    reasonStillValid: row.reason_still_valid === null ? null : Boolean(row.reason_still_valid),
    return7dPct: row.return_7d_pct,
    return30dPct: row.return_30d_pct,
    reviewedAt: row.reviewed_at,
    status: row.status,
    updatedAt: row.updated_at,
    userFeedback: row.user_feedback,
    walletId: row.wallet_id,
    warningTriggered: Boolean(row.warning_triggered),
  };
}

function fromPreferenceRow(row: WalletPreferenceRow): WalletPreferenceConfig {
  return {
    avoidTypes: parseStringArray(row.avoid_types_json, walletAvoidTypes),
    comfortSingleAmount: row.comfort_single_amount !== null && Number.isFinite(row.comfort_single_amount) && row.comfort_single_amount > 0
      ? roundMoney(row.comfort_single_amount)
      : null,
    enabled: Boolean(row.enabled),
    preferredPools: parseStringArray(row.preferred_pools_json, walletPreferredPools),
    tendency: row.tendency || '',
    updatedAt: row.updated_at,
    walletId: row.wallet_id,
  };
}

async function getDatabase() {
  if (!databasePromise) {
    databasePromise = getExpenseDatabase().then(async (database) => {
      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS ai_wallets (
          id TEXT PRIMARY KEY NOT NULL,
          owner TEXT NOT NULL DEFAULT '小仓鼠',
          name TEXT NOT NULL DEFAULT '白云小金库',
          total_budget REAL NOT NULL DEFAULT 0,
          cash_balance REAL NOT NULL DEFAULT 0,
          invested_amount REAL NOT NULL DEFAULT 0,
          risk_profile TEXT NOT NULL DEFAULT 'low',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wallet_decisions (
          id TEXT PRIMARY KEY NOT NULL,
          wallet_id TEXT NOT NULL,
          fund_code TEXT NOT NULL,
          fund_name TEXT NOT NULL DEFAULT '',
          fund_type TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL,
          amount REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'proposed',
          confidence REAL NOT NULL DEFAULT 0,
          reasoning TEXT NOT NULL DEFAULT '',
          risk_warning TEXT NOT NULL DEFAULT '',
          why_not_more TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'manual',
          suggested_nav REAL,
          suggested_nav_source TEXT,
          suggested_nav_at INTEGER,
          created_at INTEGER NOT NULL,
          approved_at INTEGER,
          rejected_at INTEGER,
          executed_at INTEGER,
          is_debug INTEGER NOT NULL DEFAULT 0 CHECK (is_debug IN (0, 1))
        );

        CREATE TABLE IF NOT EXISTS wallet_holdings (
          id TEXT PRIMARY KEY NOT NULL,
          wallet_id TEXT NOT NULL,
          fund_code TEXT NOT NULL,
          fund_name TEXT NOT NULL DEFAULT '',
          fund_type TEXT NOT NULL DEFAULT '',
          shares REAL NOT NULL DEFAULT 0,
          avg_cost_nav REAL NOT NULL DEFAULT 0,
          total_cost REAL NOT NULL DEFAULT 0,
          latest_nav REAL NOT NULL DEFAULT 0,
          market_value REAL NOT NULL DEFAULT 0,
          floating_profit REAL NOT NULL DEFAULT 0,
          floating_profit_pct REAL NOT NULL DEFAULT 0,
          warn_down_pct REAL,
          warn_up_pct REAL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wallet_transactions (
          id TEXT PRIMARY KEY NOT NULL,
          wallet_id TEXT NOT NULL,
          decision_id TEXT,
          fund_code TEXT NOT NULL,
          fund_name TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL,
          amount REAL NOT NULL DEFAULT 0,
          shares REAL NOT NULL DEFAULT 0,
          nav REAL NOT NULL DEFAULT 0,
          fee REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wallet_snapshots (
          id TEXT PRIMARY KEY NOT NULL,
          wallet_id TEXT NOT NULL,
          cash_balance REAL NOT NULL DEFAULT 0,
          invested_amount REAL NOT NULL DEFAULT 0,
          market_value REAL NOT NULL DEFAULT 0,
          floating_profit REAL NOT NULL DEFAULT 0,
          floating_profit_pct REAL NOT NULL DEFAULT 0,
          snapshot_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wallet_decision_reviews (
          id TEXT PRIMARY KEY NOT NULL,
          wallet_id TEXT NOT NULL,
          decision_id TEXT NOT NULL,
          fund_code TEXT NOT NULL,
          fund_name TEXT NOT NULL DEFAULT '',
          decision_nav REAL,
          nav_7d REAL,
          nav_30d REAL,
          return_7d_pct REAL,
          return_30d_pct REAL,
          max_drawdown_pct REAL,
          warning_triggered INTEGER NOT NULL DEFAULT 0,
          user_feedback TEXT,
          reason_still_valid INTEGER,
          status TEXT NOT NULL DEFAULT 'pending',
          reviewed_at INTEGER,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS wallet_preferences (
          wallet_id TEXT PRIMARY KEY NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          tendency TEXT NOT NULL DEFAULT '',
          preferred_pools_json TEXT NOT NULL DEFAULT '[]',
          avoid_types_json TEXT NOT NULL DEFAULT '[]',
          comfort_single_amount REAL,
          updated_at INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_wallets_owner ON ai_wallets(owner);
        CREATE INDEX IF NOT EXISTS idx_wallet_decisions_wallet_status ON wallet_decisions(wallet_id, status, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_holdings_wallet_fund ON wallet_holdings(wallet_id, fund_code);
        CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_created ON wallet_transactions(wallet_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_wallet_snapshots_wallet_time ON wallet_snapshots(wallet_id, snapshot_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_decision_reviews_decision ON wallet_decision_reviews(decision_id);
        CREATE INDEX IF NOT EXISTS idx_wallet_decision_reviews_wallet_status ON wallet_decision_reviews(wallet_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_wallet_preferences_updated ON wallet_preferences(updated_at DESC);
      `);
      await addColumnIfMissing(database, 'wallet_decisions', 'suggested_nav', 'REAL');
      await addColumnIfMissing(database, 'wallet_decisions', 'suggested_nav_source', 'TEXT');
      await addColumnIfMissing(database, 'wallet_decisions', 'suggested_nav_at', 'INTEGER');
      await addColumnIfMissing(database, 'wallet_decisions', 'is_debug', 'INTEGER NOT NULL DEFAULT 0');
      await database.execAsync(WALLET_LEDGER_FULL_CAPTURE_SCHEMA_SQL);
      return database;
    });
  }
  return databasePromise;
}

export async function getWalletDatabase() {
  return getDatabase();
}

export async function resetWalletSyncAfterExpenseDatabaseImport() {
  databasePromise = undefined;
  const database = await getDatabase();
  await database.execAsync(WALLET_LEDGER_RESET_TECHNICAL_STATE_SQL);
}

async function loadWalletById(walletId: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<WalletRow>('SELECT * FROM ai_wallets WHERE id = ?', walletId);
  return row ? fromWalletRow(row) : null;
}

async function createSnapshot(database: SQLite.SQLiteDatabase, walletId: string, snapshotAt = Date.now()) {
  const walletRow = await database.getFirstAsync<WalletRow>('SELECT * FROM ai_wallets WHERE id = ?', walletId);
  if (!walletRow) throw new Error('wallet-not-found');

  const summary = await database.getFirstAsync<{ market_value: number | null; floating_profit: number | null }>(
    'SELECT SUM(market_value) AS market_value, SUM(floating_profit) AS floating_profit FROM wallet_holdings WHERE wallet_id = ?',
    walletId,
  );
  const marketValue = roundMoney(summary?.market_value ?? 0);
  const floatingProfit = roundMoney(summary?.floating_profit ?? 0);
  const floatingProfitPct = walletRow.invested_amount > 0
    ? normalizePercent((floatingProfit / walletRow.invested_amount) * 100)
    : 0;
  const snapshot: WalletSnapshot = {
    cashBalance: roundMoney(walletRow.cash_balance),
    floatingProfit,
    floatingProfitPct,
    id: makeId('wallet-snapshot'),
    investedAmount: roundMoney(walletRow.invested_amount),
    marketValue,
    snapshotAt,
    walletId,
  };
  await database.runAsync(
    `INSERT INTO wallet_snapshots
      (id, wallet_id, cash_balance, invested_amount, market_value, floating_profit, floating_profit_pct, snapshot_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    snapshot.id,
    snapshot.walletId,
    snapshot.cashBalance,
    snapshot.investedAmount,
    snapshot.marketValue,
    snapshot.floatingProfit,
    snapshot.floatingProfitPct,
    snapshot.snapshotAt,
  );
  return snapshot;
}

export async function loadOrCreateDefaultWallet({
  initialBudget = 100,
  owner = '小仓鼠',
  riskProfile = 'low',
}: {
  initialBudget?: number;
  owner?: string;
  riskProfile?: WalletRiskProfile;
} = {}) {
  const database = await getDatabase();
  const existing = await database.getFirstAsync<WalletRow>('SELECT * FROM ai_wallets WHERE owner = ? LIMIT 1', owner);
  if (existing) return fromWalletRow(existing);

  const now = Date.now();
  const budget = roundMoney(initialBudget);
  const wallet: AiWallet = {
    cashBalance: budget,
    createdAt: now,
    id: makeId('ai-wallet'),
    investedAmount: 0,
    name: '白云小金库',
    owner,
    riskProfile,
    totalBudget: budget,
    updatedAt: now,
  };
  await database.withTransactionAsync(async () => {
    await database.runAsync(
      `INSERT INTO ai_wallets
        (id, owner, name, total_budget, cash_balance, invested_amount, risk_profile, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      wallet.id,
      wallet.owner,
      wallet.name,
      wallet.totalBudget,
      wallet.cashBalance,
      wallet.investedAmount,
      wallet.riskProfile,
      wallet.createdAt,
      wallet.updatedAt,
    );
    await createSnapshot(database, wallet.id, now);
  });
  return wallet;
}

export async function updateWalletBudget(walletId: string, nextBudget: number) {
  const database = await getDatabase();
  const wallet = await loadWalletById(walletId);
  if (!wallet) throw new Error('wallet-not-found');

  const budget = roundMoney(nextBudget);
  if (budget < wallet.investedAmount) throw new Error('wallet-budget-below-invested');
  const cashBalance = roundMoney(Math.max(0, budget - wallet.investedAmount));
  const now = Date.now();
  await database.withTransactionAsync(async () => {
    await database.runAsync(
      'UPDATE ai_wallets SET total_budget = ?, cash_balance = ?, updated_at = ? WHERE id = ?',
      budget,
      cashBalance,
      now,
      walletId,
    );
    await createSnapshot(database, walletId, now);
  });
  return loadWalletById(walletId);
}

export async function updateWalletRiskProfile(walletId: string, riskProfile: WalletRiskProfile) {
  const database = await getDatabase();
  const wallet = await loadWalletById(walletId);
  if (!wallet) throw new Error('wallet-not-found');
  const now = Date.now();
  await database.withTransactionAsync(async () => {
    await database.runAsync(
      'UPDATE ai_wallets SET risk_profile = ?, updated_at = ? WHERE id = ?',
      riskProfile,
      now,
      walletId,
    );
    await createSnapshot(database, walletId, now);
  });
  return loadWalletById(walletId);
}

export async function loadWalletPreferences(walletId: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<WalletPreferenceRow>('SELECT * FROM wallet_preferences WHERE wallet_id = ?', walletId);
  return row ? fromPreferenceRow(row) : null;
}

export async function saveWalletPreferences(walletId: string, patch: Partial<Omit<WalletPreferenceConfig, 'walletId' | 'updatedAt'>>) {
  const database = await getDatabase();
  const existing = await loadWalletPreferences(walletId);
  const now = Date.now();
  const next: WalletPreferenceConfig = {
    ...defaultWalletPreferences(walletId, now),
    ...existing,
    ...patch,
    avoidTypes: patch.avoidTypes ?? existing?.avoidTypes ?? [],
    comfortSingleAmount: typeof patch.comfortSingleAmount === 'number' && Number.isFinite(patch.comfortSingleAmount) && patch.comfortSingleAmount > 0
      ? roundMoney(patch.comfortSingleAmount)
      : patch.comfortSingleAmount === null
        ? null
        : existing?.comfortSingleAmount ?? null,
    preferredPools: patch.preferredPools ?? existing?.preferredPools ?? [],
    tendency: patch.tendency?.trim() ?? existing?.tendency ?? '',
    updatedAt: now,
    walletId,
  };
  await database.runAsync(
    `INSERT INTO wallet_preferences
      (wallet_id, enabled, tendency, preferred_pools_json, avoid_types_json, comfort_single_amount, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wallet_id) DO UPDATE SET
       enabled = excluded.enabled,
       tendency = excluded.tendency,
       preferred_pools_json = excluded.preferred_pools_json,
       avoid_types_json = excluded.avoid_types_json,
       comfort_single_amount = excluded.comfort_single_amount,
       updated_at = excluded.updated_at`,
    next.walletId,
    next.enabled ? 1 : 0,
    next.tendency,
    JSON.stringify(next.preferredPools.filter((pool) => walletPreferredPools.includes(pool))),
    JSON.stringify(next.avoidTypes.filter((type) => walletAvoidTypes.includes(type))),
    next.comfortSingleAmount,
    next.updatedAt,
  );
  return loadWalletPreferences(walletId);
}

export async function loadOrCreateWalletPreferences(walletId: string) {
  const existing = await loadWalletPreferences(walletId);
  if (existing) return existing;
  return saveWalletPreferences(walletId, defaultWalletPreferences(walletId));
}

export async function createWalletDecision(walletId: string, draft: WalletDecisionDraft) {
  const database = await getDatabase();
  const wallet = await loadWalletById(walletId);
  if (!wallet) throw new Error('wallet-not-found');

  const now = Date.now();
  const decision: WalletDecision = {
    action: draft.action,
    amount: roundMoney(draft.amount ?? 0),
    approvedAt: null,
    confidence: Math.min(100, Math.max(0, draft.confidence ?? 0)),
    createdAt: now,
    executedAt: null,
    fundCode: draft.fundCode.trim(),
    fundName: draft.fundName.trim(),
    fundType: draft.fundType?.trim() ?? '',
    id: makeId('wallet-decision'),
    rejectedAt: null,
    reasoning: draft.reasoning.trim(),
    riskWarning: draft.riskWarning.trim(),
    source: draft.source ?? 'manual',
    status: 'proposed',
    suggestedNav: draft.suggestedNav && Number.isFinite(draft.suggestedNav) && draft.suggestedNav > 0
      ? roundNav(draft.suggestedNav)
      : null,
    suggestedNavAt: draft.suggestedNavAt ?? null,
    suggestedNavSource: draft.suggestedNavSource ?? null,
    walletId,
    whyNotMore: draft.whyNotMore.trim(),
  };
  if (!decision.fundCode || !decision.fundName) throw new Error('decision-fund-required');
  if (!decision.reasoning || !decision.riskWarning || !decision.whyNotMore) throw new Error('decision-safety-copy-required');
  const isDebug = (
    decision.fundCode === '000001'
    && decision.fundName === '白云测试稳稳基金'
    && decision.fundType === '测试基金'
  );

  const insert = async (
    target: Pick<SQLite.SQLiteDatabase, 'runAsync'>,
  ) => target.runAsync(
    `INSERT INTO wallet_decisions
      (id, wallet_id, fund_code, fund_name, fund_type, action, amount, status, confidence, reasoning, risk_warning, why_not_more, source, suggested_nav, suggested_nav_source, suggested_nav_at, created_at, approved_at, rejected_at, executed_at, is_debug)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    decision.id,
    decision.walletId,
    decision.fundCode,
    decision.fundName,
    decision.fundType,
    decision.action,
    decision.amount,
    decision.status,
    decision.confidence,
    decision.reasoning,
    decision.riskWarning,
    decision.whyNotMore,
    decision.source,
    decision.suggestedNav,
    decision.suggestedNavSource,
    decision.suggestedNavAt,
    decision.createdAt,
    decision.approvedAt,
    decision.rejectedAt,
    decision.executedAt,
    isDebug ? 1 : 0,
  );
  if (isDebug) {
    await database.withExclusiveTransactionAsync(
      async (transaction) => {
        const runtime = await transaction.getFirstAsync<{
          suppress_capture: number;
        }>(
          `SELECT suppress_capture
           FROM wallet_sync_runtime WHERE singleton_id = 1`,
        );
        if (!runtime || runtime.suppress_capture !== 0) {
          throw new Error('wallet-debug-create-capture-suppression-busy');
        }
        await transaction.runAsync(
          `UPDATE wallet_sync_runtime SET suppress_capture = 1
           WHERE singleton_id = 1 AND suppress_capture = 0`,
        );
        try {
          await insert(transaction);
        } finally {
          await transaction.runAsync(
            `UPDATE wallet_sync_runtime SET suppress_capture = 0
             WHERE singleton_id = 1`,
          );
        }
      },
    );
  } else {
    await insert(database);
  }
  return decision;
}

export async function updateWalletDecisionStatus(decisionId: string, status: Extract<WalletDecisionStatus, 'rejected' | 'deferred' | 'expired' | 'blocked'>) {
  const database = await getDatabase();
  const now = Date.now();
  await database.runAsync(
    `UPDATE wallet_decisions
       SET status = ?, rejected_at = CASE WHEN ? = 'rejected' THEN ? ELSE rejected_at END
     WHERE id = ? AND status = 'proposed'`,
    status,
    status,
    now,
    decisionId,
  );
}

export async function deleteWalletDebugDecisions(walletId: string) {
  const database = await getDatabase();
  let deletedCount = 0;
  await database.withExclusiveTransactionAsync(
    async (transaction) => {
      const runtime = await transaction.getFirstAsync<{
        suppress_capture: number;
      }>(
        `SELECT suppress_capture
         FROM wallet_sync_runtime WHERE singleton_id = 1`,
      );
      if (!runtime || runtime.suppress_capture !== 0) {
        throw new Error('wallet-debug-cleanup-capture-suppression-busy');
      }
      await transaction.runAsync(
        `UPDATE wallet_sync_runtime SET suppress_capture = 1
         WHERE singleton_id = 1 AND suppress_capture = 0`,
      );
      try {
        const rows = await transaction.getAllAsync<{ id: string }>(
          `SELECT id FROM wallet_decisions
           WHERE wallet_id = ?
             AND is_debug = 1
             AND fund_code = '000001'
             AND fund_name = '白云测试稳稳基金'
             AND fund_type = '测试基金'
             AND status IN ('proposed', 'rejected', 'deferred', 'expired', 'blocked')`,
          walletId,
        );
        if (!rows.length) return;
        const ids = rows.map((row) => row.id);
        const placeholders = ids.map(() => '?').join(', ');
        await transaction.runAsync(
          `DELETE FROM wallet_decision_reviews
           WHERE decision_id IN (${placeholders})`,
          ...ids,
        );
        await transaction.runAsync(
          `DELETE FROM wallet_decisions
           WHERE id IN (${placeholders})`,
          ...ids,
        );
        deletedCount = ids.length;
      } finally {
        await transaction.runAsync(
          `UPDATE wallet_sync_runtime SET suppress_capture = 0
           WHERE singleton_id = 1`,
        );
      }
    },
  );
  return deletedCount;
}

export async function approveWalletDecision({ decisionId }: WalletDecisionApproval) {
  const database = await getDatabase();
  const now = Date.now();
  await database.withTransactionAsync(async () => {
    const decisionRow = await database.getFirstAsync<DecisionRow>('SELECT * FROM wallet_decisions WHERE id = ?', decisionId);
    if (!decisionRow) throw new Error('decision-not-found');
    const decision = fromDecisionRow(decisionRow);
    if (decision.status !== 'proposed') throw new Error('decision-not-proposed');
    if (decision.action === 'buy') throw new Error('decision-buy-needs-execution');
    await database.runAsync(
      `UPDATE wallet_decisions
         SET status = 'approved', approved_at = ?
       WHERE id = ?`,
      now,
      decision.id,
    );
    await createSnapshot(database, decision.walletId, now);
  });
  const row = await database.getFirstAsync<DecisionRow>('SELECT * FROM wallet_decisions WHERE id = ?', decisionId);
  if (!row) throw new Error('decision-not-found');
  return fromDecisionRow(row);
}

export async function approveWalletBuyDecision({ decisionId, fee = 0, nav }: WalletBuyExecution) {
  if (!Number.isFinite(nav) || nav <= 0) throw new Error('invalid-nav');
  const database = await getDatabase();
  const now = Date.now();
  let transactionId = '';

  await database.withTransactionAsync(async () => {
    const decisionRow = await database.getFirstAsync<DecisionRow>('SELECT * FROM wallet_decisions WHERE id = ?', decisionId);
    if (!decisionRow) throw new Error('decision-not-found');
    const decision = fromDecisionRow(decisionRow);
    if (decision.status !== 'proposed' && decision.status !== 'approved') throw new Error('decision-not-proposed');
    if (decision.action !== 'buy') throw new Error('decision-not-buy');
    if (decision.amount <= 0) throw new Error('decision-amount-required');

    const walletRow = await database.getFirstAsync<WalletRow>('SELECT * FROM ai_wallets WHERE id = ?', decision.walletId);
    if (!walletRow) throw new Error('wallet-not-found');
    if (decision.amount > walletRow.cash_balance) throw new Error('wallet-cash-not-enough');

    const cleanNav = roundNav(nav);
    const cleanFee = roundMoney(fee);
    const shares = roundShares((decision.amount - cleanFee) / cleanNav);
    if (shares <= 0) throw new Error('wallet-shares-too-small');

    const existingHolding = await database.getFirstAsync<HoldingRow>(
      'SELECT * FROM wallet_holdings WHERE wallet_id = ? AND fund_code = ?',
      decision.walletId,
      decision.fundCode,
    );
    const newTotalCost = roundMoney((existingHolding?.total_cost ?? 0) + decision.amount);
    const newShares = roundShares((existingHolding?.shares ?? 0) + shares);
    const newAvgCostNav = newShares > 0 ? roundNav(newTotalCost / newShares) : cleanNav;
    const marketValue = roundMoney(newShares * cleanNav);
    const floatingProfit = roundMoney(marketValue - newTotalCost);
    const floatingProfitPct = newTotalCost > 0 ? normalizePercent((floatingProfit / newTotalCost) * 100) : 0;

    if (existingHolding) {
      await database.runAsync(
        `UPDATE wallet_holdings
           SET fund_name = ?, fund_type = ?, shares = ?, avg_cost_nav = ?, total_cost = ?,
               latest_nav = ?, market_value = ?, floating_profit = ?, floating_profit_pct = ?, updated_at = ?
         WHERE id = ?`,
        decision.fundName,
        decision.fundType,
        newShares,
        newAvgCostNav,
        newTotalCost,
        cleanNav,
        marketValue,
        floatingProfit,
        floatingProfitPct,
        now,
        existingHolding.id,
      );
    } else {
      await database.runAsync(
        `INSERT INTO wallet_holdings
          (id, wallet_id, fund_code, fund_name, fund_type, shares, avg_cost_nav, total_cost, latest_nav, market_value, floating_profit, floating_profit_pct, warn_down_pct, warn_up_pct, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        makeId('wallet-holding'),
        decision.walletId,
        decision.fundCode,
        decision.fundName,
        decision.fundType,
        newShares,
        newAvgCostNav,
        newTotalCost,
        cleanNav,
        marketValue,
        floatingProfit,
        floatingProfitPct,
        -3,
        15,
        now,
      );
    }

    transactionId = makeId('wallet-transaction');
    await database.runAsync(
      `INSERT INTO wallet_transactions
        (id, wallet_id, decision_id, fund_code, fund_name, action, amount, shares, nav, fee, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      transactionId,
      decision.walletId,
      decision.id,
      decision.fundCode,
      decision.fundName,
      'buy',
      decision.amount,
      shares,
      cleanNav,
      cleanFee,
      now,
    );

    await database.runAsync(
      `UPDATE ai_wallets
         SET cash_balance = ?, invested_amount = ?, updated_at = ?
       WHERE id = ?`,
      roundMoney(walletRow.cash_balance - decision.amount),
      roundMoney(walletRow.invested_amount + decision.amount),
      now,
      decision.walletId,
    );
    await database.runAsync(
      `UPDATE wallet_decisions
         SET status = 'executed', approved_at = COALESCE(approved_at, ?), executed_at = ?
       WHERE id = ?`,
      now,
      now,
      decision.id,
    );
    await createSnapshot(database, decision.walletId, now);
  });

  const row = await database.getFirstAsync<TransactionRow>('SELECT * FROM wallet_transactions WHERE id = ?', transactionId);
  if (!row) throw new Error('transaction-not-found');
  return fromTransactionRow(row);
}


export async function importManualWalletHolding(input: WalletManualHoldingImport) {
  const fundCode = input.fundCode.trim();
  const fundName = input.fundName.trim();
  if (!fundCode || !fundName) throw new Error('wallet-manual-fund-required');
  if (!Number.isFinite(input.latestNav) || input.latestNav <= 0) throw new Error('wallet-manual-nav-required');

  const cleanNav = roundNav(input.latestNav);
  const rawShares = input.shares ?? null;
  const rawAvgCostNav = input.avgCostNav ?? null;
  const rawTotalCost = input.totalCost ?? null;
  let shares = typeof rawShares === 'number' && Number.isFinite(rawShares) && rawShares > 0 ? roundShares(rawShares) : 0;
  let avgCostNav = typeof rawAvgCostNav === 'number' && Number.isFinite(rawAvgCostNav) && rawAvgCostNav > 0 ? roundNav(rawAvgCostNav) : 0;
  let totalCost = typeof rawTotalCost === 'number' && Number.isFinite(rawTotalCost) && rawTotalCost > 0 ? roundMoney(rawTotalCost) : 0;

  if (!totalCost && shares && avgCostNav) totalCost = roundMoney(shares * avgCostNav);
  if (!shares && totalCost && avgCostNav) shares = roundShares(totalCost / avgCostNav);
  if (!avgCostNav && totalCost && shares) avgCostNav = roundNav(totalCost / shares);
  if (!shares || !avgCostNav || !totalCost) throw new Error('wallet-manual-cost-required');

  const database = await getDatabase();
  const now = Date.now();
  let transactionId = '';

  await database.withTransactionAsync(async () => {
    const walletRow = await database.getFirstAsync<WalletRow>('SELECT * FROM ai_wallets WHERE id = ?', input.walletId);
    if (!walletRow) throw new Error('wallet-not-found');
    if (totalCost > walletRow.cash_balance) throw new Error('wallet-cash-not-enough');

    const existingHolding = await database.getFirstAsync<HoldingRow>(
      'SELECT * FROM wallet_holdings WHERE wallet_id = ? AND fund_code = ?',
      input.walletId,
      fundCode,
    );
    const newShares = roundShares((existingHolding?.shares ?? 0) + shares);
    const newTotalCost = roundMoney((existingHolding?.total_cost ?? 0) + totalCost);
    const newAvgCostNav = newShares > 0 ? roundNav(newTotalCost / newShares) : avgCostNav;
    const marketValue = roundMoney(newShares * cleanNav);
    const floatingProfit = roundMoney(marketValue - newTotalCost);
    const floatingProfitPct = newTotalCost > 0 ? normalizePercent((floatingProfit / newTotalCost) * 100) : 0;
    const warnDownPct = input.warnDownPct ?? existingHolding?.warn_down_pct ?? -3;
    const warnUpPct = input.warnUpPct ?? existingHolding?.warn_up_pct ?? 15;
    const fundType = input.fundType?.trim() || existingHolding?.fund_type || '基金';

    if (existingHolding) {
      await database.runAsync(
        `UPDATE wallet_holdings
           SET fund_name = ?, fund_type = ?, shares = ?, avg_cost_nav = ?, total_cost = ?,
               latest_nav = ?, market_value = ?, floating_profit = ?, floating_profit_pct = ?,
               warn_down_pct = ?, warn_up_pct = ?, updated_at = ?
         WHERE id = ?`,
        fundName,
        fundType,
        newShares,
        newAvgCostNav,
        newTotalCost,
        cleanNav,
        marketValue,
        floatingProfit,
        floatingProfitPct,
        warnDownPct,
        warnUpPct,
        now,
        existingHolding.id,
      );
    } else {
      await database.runAsync(
        `INSERT INTO wallet_holdings
          (id, wallet_id, fund_code, fund_name, fund_type, shares, avg_cost_nav, total_cost, latest_nav, market_value, floating_profit, floating_profit_pct, warn_down_pct, warn_up_pct, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        makeId('wallet-holding'),
        input.walletId,
        fundCode,
        fundName,
        fundType,
        newShares,
        newAvgCostNav,
        newTotalCost,
        cleanNav,
        marketValue,
        floatingProfit,
        floatingProfitPct,
        warnDownPct,
        warnUpPct,
        now,
      );
    }

    transactionId = makeId('wallet-transaction');
    await database.runAsync(
      `INSERT INTO wallet_transactions
        (id, wallet_id, decision_id, fund_code, fund_name, action, amount, shares, nav, fee, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      transactionId,
      input.walletId,
      null,
      fundCode,
      fundName,
      'buy',
      totalCost,
      shares,
      cleanNav,
      0,
      now,
    );

    await database.runAsync(
      `UPDATE ai_wallets
         SET cash_balance = ?, invested_amount = ?, updated_at = ?
       WHERE id = ?`,
      roundMoney(walletRow.cash_balance - totalCost),
      roundMoney(walletRow.invested_amount + totalCost),
      now,
      input.walletId,
    );
    await createSnapshot(database, input.walletId, now);
  });

  const row = await database.getFirstAsync<TransactionRow>('SELECT * FROM wallet_transactions WHERE id = ?', transactionId);
  if (!row) throw new Error('transaction-not-found');
  return fromTransactionRow(row);
}

export async function loadWalletDecisions(walletId: string, limit = 50) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<DecisionRow>(
    'SELECT * FROM wallet_decisions WHERE wallet_id = ? ORDER BY created_at DESC LIMIT ?',
    walletId,
    limit,
  );
  return rows.map(fromDecisionRow);
}

export async function loadWalletDecisionById(decisionId: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<DecisionRow>(
    'SELECT * FROM wallet_decisions WHERE id = ?',
    decisionId,
  );
  return row ? fromDecisionRow(row) : null;
}

export async function loadWalletHoldings(walletId: string) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<HoldingRow>(
    'SELECT * FROM wallet_holdings WHERE wallet_id = ? ORDER BY fund_code ASC',
    walletId,
  );
  return rows.map(fromHoldingRow);
}

export async function loadWalletTransactions(walletId: string, limit = 50) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<TransactionRow>(
    'SELECT * FROM wallet_transactions WHERE wallet_id = ? ORDER BY created_at DESC LIMIT ?',
    walletId,
    limit,
  );
  return rows.map(fromTransactionRow);
}

export async function loadWalletTransactionByDecisionId(decisionId: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<TransactionRow>(
    'SELECT * FROM wallet_transactions WHERE decision_id = ? ORDER BY created_at ASC LIMIT 1',
    decisionId,
  );
  return row ? fromTransactionRow(row) : null;
}

export async function loadWalletDecisionReviews(walletId: string, limit = 100) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<DecisionReviewRow>(
    'SELECT * FROM wallet_decision_reviews WHERE wallet_id = ? ORDER BY updated_at DESC LIMIT ?',
    walletId,
    limit,
  );
  return rows.map(fromDecisionReviewRow);
}

export async function saveWalletDecisionReview(review: WalletDecisionReviewWrite) {
  const database = await getDatabase();
  const now = Date.now();
  const id = review.id ?? makeId('wallet-decision-review');
  const updatedAt = review.updatedAt || now;
  await database.runAsync(
    `INSERT INTO wallet_decision_reviews
      (id, wallet_id, decision_id, fund_code, fund_name, decision_nav, nav_7d, nav_30d, return_7d_pct, return_30d_pct,
       max_drawdown_pct, warning_triggered, user_feedback, reason_still_valid, status, reviewed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET
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
    id,
    review.walletId,
    review.decisionId,
    review.fundCode,
    review.fundName,
    review.decisionNav,
    review.nav7d,
    review.nav30d,
    review.return7dPct,
    review.return30dPct,
    review.maxDrawdownPct,
    review.warningTriggered ? 1 : 0,
    review.userFeedback,
    review.reasonStillValid === null ? null : review.reasonStillValid ? 1 : 0,
    review.status,
    review.reviewedAt,
    updatedAt,
  );
  const row = await database.getFirstAsync<DecisionReviewRow>('SELECT * FROM wallet_decision_reviews WHERE id = ?', id);
  if (!row) throw new Error('wallet-review-not-found');
  return fromDecisionReviewRow(row);
}

export async function updateWalletHoldingValuations(walletId: string, updates: WalletHoldingValuationUpdate[]) {
  const database = await getDatabase();
  const cleanUpdates = updates
    .map((update) => ({
      fundCode: update.fundCode.trim(),
      latestNav: roundNav(update.latestNav),
      updatedAt: update.updatedAt ?? Date.now(),
    }))
    .filter((update) => update.fundCode && Number.isFinite(update.latestNav) && update.latestNav > 0);
  if (!cleanUpdates.length) throw new Error('wallet-valuation-empty');

  let snapshot: WalletSnapshot | null = null;
  await database.withTransactionAsync(async () => {
    let changed = 0;
    for (const update of cleanUpdates) {
      const holding = await database.getFirstAsync<HoldingRow>(
        'SELECT * FROM wallet_holdings WHERE wallet_id = ? AND fund_code = ?',
        walletId,
        update.fundCode,
      );
      if (!holding) continue;
      const latestNav = roundNav(update.latestNav);
      const marketValue = roundMoney(holding.shares * latestNav);
      const floatingProfit = roundMoney(marketValue - holding.total_cost);
      const floatingProfitPct = holding.total_cost > 0 ? normalizePercent((floatingProfit / holding.total_cost) * 100) : 0;
      await database.runAsync(
        `UPDATE wallet_holdings
           SET latest_nav = ?, market_value = ?, floating_profit = ?, floating_profit_pct = ?, updated_at = ?
         WHERE id = ?`,
        latestNav,
        marketValue,
        floatingProfit,
        floatingProfitPct,
        update.updatedAt,
        holding.id,
      );
      changed += 1;
    }
    if (!changed) throw new Error('wallet-valuation-no-holdings');
    snapshot = await createSnapshot(database, walletId, Date.now());
  });

  if (!snapshot) throw new Error('wallet-valuation-no-snapshot');
  return snapshot;
}

export async function loadWalletSnapshots(walletId: string, limit = 30) {
  const database = await getDatabase();
  const rows = await database.getAllAsync<SnapshotRow>(
    'SELECT * FROM wallet_snapshots WHERE wallet_id = ? ORDER BY snapshot_at DESC LIMIT ?',
    walletId,
    limit,
  );
  return rows.map(fromSnapshotRow);
}

export async function createWalletSnapshot(walletId: string) {
  const database = await getDatabase();
  return createSnapshot(database, walletId);
}
