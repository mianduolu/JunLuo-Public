import {
  WALLET_LEDGER_SCHEMA_VERSION,
  type WalletLedgerEntityType,
} from './syncWalletLedger';

export const WALLET_LEDGER_CAPTURE_SCHEMA_VERSION = 1 as const;
export const WALLET_LEDGER_STORAGE_SCHEMA_VERSION = 1 as const;
export const WALLET_LEDGER_CAPTURE_LEASE_MS = 60_000;
export const WALLET_LEDGER_EXPECTED_CAPTURE_TRIGGER_COUNT = 12;

type RowAlias = 'NEW' | 'OLD' | 'ROW';

type CaptureDefinition = {
  kind: WalletLedgerEntityType;
  table: string;
  updateColumns: readonly string[];
  immutableColumns: readonly string[];
  appendOnly?: boolean;
};

const CAPTURE_DEFINITIONS: readonly CaptureDefinition[] = [
  {
    kind: 'wallet',
    table: 'ai_wallets',
    updateColumns: [
      'owner',
      'name',
      'total_budget',
      'cash_balance',
      'invested_amount',
      'risk_profile',
      'created_at',
      'updated_at',
    ],
    immutableColumns: ['id'],
  },
  {
    kind: 'preference',
    table: 'wallet_preferences',
    updateColumns: [
      'enabled',
      'tendency',
      'preferred_pools_json',
      'avoid_types_json',
      'comfort_single_amount',
      'updated_at',
    ],
    immutableColumns: ['wallet_id'],
  },
  {
    kind: 'holding',
    table: 'wallet_holdings',
    updateColumns: [
      'fund_name',
      'fund_type',
      'shares',
      'avg_cost_nav',
      'total_cost',
      'latest_nav',
      'market_value',
      'floating_profit',
      'floating_profit_pct',
      'warn_down_pct',
      'warn_up_pct',
      'updated_at',
    ],
    immutableColumns: ['id', 'wallet_id', 'fund_code'],
  },
  {
    kind: 'decision',
    table: 'wallet_decisions',
    updateColumns: [
      'status',
      'approved_at',
      'rejected_at',
      'executed_at',
    ],
    immutableColumns: [
      'id',
      'wallet_id',
      'fund_code',
      'fund_name',
      'fund_type',
      'action',
      'amount',
      'confidence',
      'reasoning',
      'risk_warning',
      'why_not_more',
      'source',
      'suggested_nav',
      'suggested_nav_source',
      'suggested_nav_at',
      'created_at',
      'is_debug',
    ],
  },
  {
    kind: 'transaction',
    table: 'wallet_transactions',
    updateColumns: [],
    immutableColumns: [],
    appendOnly: true,
  },
  {
    kind: 'snapshot',
    table: 'wallet_snapshots',
    updateColumns: [],
    immutableColumns: [],
    appendOnly: true,
  },
  {
    kind: 'review',
    table: 'wallet_decision_reviews',
    updateColumns: [
      'fund_code',
      'fund_name',
      'decision_nav',
      'nav_7d',
      'nav_30d',
      'return_7d_pct',
      'return_30d_pct',
      'max_drawdown_pct',
      'warning_triggered',
      'user_feedback',
      'reason_still_valid',
      'status',
      'reviewed_at',
      'updated_at',
    ],
    immutableColumns: ['id', 'wallet_id', 'decision_id'],
  },
];

function uuidV4Expression() {
  return `(
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    lower(hex(randomblob(6)))
  )`;
}

function unixMillisecondsExpression() {
  return `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;
}

function jsonBoolean(expression: string) {
  return `json(CASE WHEN ${expression} THEN 'true' ELSE 'false' END)`;
}

function jsonNullableBoolean(expression: string) {
  return `CASE
    WHEN ${expression} IS NULL THEN NULL
    ELSE ${jsonBoolean(`${expression} <> 0`)}
  END`;
}

function localIdExpression(
  kind: WalletLedgerEntityType,
  row: RowAlias,
) {
  return kind === 'preference'
    ? `CAST(${row}.wallet_id AS TEXT)`
    : `CAST(${row}.id AS TEXT)`;
}

function entityIdExpression(
  kind: WalletLedgerEntityType,
  row: RowAlias,
) {
  return `'${kind}:' || ${localIdExpression(kind, row)}`;
}

function recordExpression(
  kind: WalletLedgerEntityType,
  row: RowAlias,
) {
  switch (kind) {
    case 'wallet':
      return `json_object(
        'id', ${row}.id,
        'owner', ${row}.owner,
        'name', ${row}.name,
        'totalBudget', ${row}.total_budget,
        'cashBalance', ${row}.cash_balance,
        'investedAmount', ${row}.invested_amount,
        'riskProfile', ${row}.risk_profile,
        'createdAt', ${row}.created_at,
        'updatedAt', ${row}.updated_at
      )`;
    case 'preference':
      return `json_object(
        'walletId', ${row}.wallet_id,
        'enabled', ${jsonBoolean(`${row}.enabled <> 0`)},
        'tendency', ${row}.tendency,
        'preferredPools', json(${row}.preferred_pools_json),
        'avoidTypes', json(${row}.avoid_types_json),
        'comfortSingleAmount', ${row}.comfort_single_amount,
        'updatedAt', ${row}.updated_at
      )`;
    case 'holding':
      return `json_object(
        'id', ${row}.id,
        'walletId', ${row}.wallet_id,
        'fundCode', ${row}.fund_code,
        'fundName', ${row}.fund_name,
        'fundType', ${row}.fund_type,
        'shares', ${row}.shares,
        'avgCostNav', ${row}.avg_cost_nav,
        'totalCost', ${row}.total_cost,
        'latestNav', ${row}.latest_nav,
        'marketValue', ${row}.market_value,
        'floatingProfit', ${row}.floating_profit,
        'floatingProfitPct', ${row}.floating_profit_pct,
        'warnDownPct', ${row}.warn_down_pct,
        'warnUpPct', ${row}.warn_up_pct,
        'updatedAt', ${row}.updated_at
      )`;
    case 'decision':
      return `json_object(
        'id', ${row}.id,
        'walletId', ${row}.wallet_id,
        'fundCode', ${row}.fund_code,
        'fundName', ${row}.fund_name,
        'fundType', ${row}.fund_type,
        'action', ${row}.action,
        'amount', ${row}.amount,
        'status', ${row}.status,
        'confidence', ${row}.confidence,
        'reasoning', ${row}.reasoning,
        'riskWarning', ${row}.risk_warning,
        'whyNotMore', ${row}.why_not_more,
        'source', ${row}.source,
        'suggestedNav', ${row}.suggested_nav,
        'suggestedNavSource', ${row}.suggested_nav_source,
        'suggestedNavAt', ${row}.suggested_nav_at,
        'createdAt', ${row}.created_at,
        'approvedAt', ${row}.approved_at,
        'rejectedAt', ${row}.rejected_at,
        'executedAt', ${row}.executed_at
      )`;
    case 'transaction':
      return `json_object(
        'id', ${row}.id,
        'walletId', ${row}.wallet_id,
        'decisionId', ${row}.decision_id,
        'fundCode', ${row}.fund_code,
        'fundName', ${row}.fund_name,
        'action', ${row}.action,
        'amount', ${row}.amount,
        'shares', ${row}.shares,
        'nav', ${row}.nav,
        'fee', ${row}.fee,
        'createdAt', ${row}.created_at
      )`;
    case 'snapshot':
      return `json_object(
        'id', ${row}.id,
        'walletId', ${row}.wallet_id,
        'cashBalance', ${row}.cash_balance,
        'investedAmount', ${row}.invested_amount,
        'marketValue', ${row}.market_value,
        'floatingProfit', ${row}.floating_profit,
        'floatingProfitPct', ${row}.floating_profit_pct,
        'snapshotAt', ${row}.snapshot_at
      )`;
    case 'review':
      return `json_object(
        'id', ${row}.id,
        'walletId', ${row}.wallet_id,
        'decisionId', ${row}.decision_id,
        'fundCode', ${row}.fund_code,
        'fundName', ${row}.fund_name,
        'decisionNav', ${row}.decision_nav,
        'nav7d', ${row}.nav_7d,
        'nav30d', ${row}.nav_30d,
        'return7dPct', ${row}.return_7d_pct,
        'return30dPct', ${row}.return_30d_pct,
        'maxDrawdownPct', ${row}.max_drawdown_pct,
        'warningTriggered', ${jsonBoolean(`${row}.warning_triggered <> 0`)},
        'userFeedback', ${row}.user_feedback,
        'reasonStillValid', ${jsonNullableBoolean(`${row}.reason_still_valid`)},
        'status', ${row}.status,
        'reviewedAt', ${row}.reviewed_at,
        'updatedAt', ${row}.updated_at
      )`;
  }
}

function captureEnabledPredicate() {
  return `EXISTS (
    SELECT 1 FROM wallet_sync_runtime
    WHERE singleton_id = 1
      AND capture_enabled = 1
      AND suppress_capture = 0
      AND vault_id IS NOT NULL
      AND source_device_id IS NOT NULL
  )`;
}

function reviewDebugFlag(row: RowAlias) {
  return `COALESCE((
    SELECT debug_decision.is_debug
    FROM wallet_decisions AS debug_decision
    WHERE debug_decision.id = ${row}.decision_id
    LIMIT 1
  ), 0)`;
}

function sharedRowPredicate(
  kind: WalletLedgerEntityType,
  row: RowAlias,
) {
  if (kind === 'decision') {
    return `${row}.is_debug = 0`;
  }
  if (kind === 'review') {
    return `${reviewDebugFlag(row)} = 0`;
  }
  return '1 = 1';
}

function parentRevisionIdsExpression(
  kind: WalletLedgerEntityType,
  row: RowAlias,
) {
  return `COALESCE((
    SELECT json_group_array(revision_id)
    FROM (
      SELECT revision_id
      FROM wallet_sync_entity_heads
      WHERE entity_type = '${kind}'
        AND entity_id = ${entityIdExpression(kind, row)}
      ORDER BY revision_id ASC
    )
  ), json('[]'))`;
}

function insertOutboxStatement(
  kind: WalletLedgerEntityType,
  row: RowAlias,
) {
  return `INSERT INTO wallet_sync_domain_outbox (
    mutation_id, revision_id, parent_revision_ids_json,
    vault_id, source_device_id, entity_type, entity_id,
    operation, schema_version, payload_json, state,
    available_at, created_at, updated_at
  )
  SELECT
    ${uuidV4Expression()},
    ${uuidV4Expression()},
    ${parentRevisionIdsExpression(kind, row)},
    vault_id,
    source_device_id,
    '${kind}',
    ${entityIdExpression(kind, row)},
    'upsert',
    ${WALLET_LEDGER_SCHEMA_VERSION},
    json_object(
      'schemaVersion', ${WALLET_LEDGER_SCHEMA_VERSION},
      'kind', '${kind}',
      'record', ${recordExpression(kind, row)}
    ),
    'pending',
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()},
    ${unixMillisecondsExpression()}
  FROM wallet_sync_runtime
  WHERE singleton_id = 1;`;
}

function advanceHeadsStatements(
  kind: WalletLedgerEntityType,
  row: RowAlias,
) {
  return `
  DELETE FROM wallet_sync_entity_heads
  WHERE entity_type = '${kind}'
    AND entity_id = ${entityIdExpression(kind, row)};

  INSERT INTO wallet_sync_entity_heads (
    entity_type, entity_id, revision_id, updated_at
  )
  SELECT
    '${kind}',
    ${entityIdExpression(kind, row)},
    revision_id,
    created_at
  FROM wallet_sync_domain_outbox
  WHERE local_sequence = last_insert_rowid();`;
}

function updateChangedPredicate(columns: readonly string[]) {
  return columns
    .map((column) => `OLD.${column} IS NOT NEW.${column}`)
    .join('\n    OR ');
}

function captureTriggers(definition: CaptureDefinition) {
  const insert = `
CREATE TRIGGER IF NOT EXISTS wallet_sync_capture_${definition.kind}_insert
AFTER INSERT ON ${definition.table}
WHEN ${captureEnabledPredicate()}
  AND ${sharedRowPredicate(definition.kind, 'NEW')}
BEGIN
  ${insertOutboxStatement(definition.kind, 'NEW')}
  ${advanceHeadsStatements(definition.kind, 'NEW')}
END;`;
  if (definition.appendOnly) return insert;
  return `${insert}

CREATE TRIGGER IF NOT EXISTS wallet_sync_capture_${definition.kind}_update
AFTER UPDATE ON ${definition.table}
WHEN ${captureEnabledPredicate()}
  AND ${sharedRowPredicate(definition.kind, 'NEW')}
  AND (
    ${updateChangedPredicate(definition.updateColumns)}
  )
BEGIN
  ${insertOutboxStatement(definition.kind, 'NEW')}
  ${advanceHeadsStatements(definition.kind, 'NEW')}
END;`;
}

function immutableUpdateGuard(definition: CaptureDefinition) {
  if (definition.appendOnly || !definition.immutableColumns.length) return '';
  return `
CREATE TRIGGER IF NOT EXISTS wallet_sync_guard_${definition.kind}_identity
BEFORE UPDATE OF ${definition.immutableColumns.join(', ')}
ON ${definition.table}
WHEN ${definition.immutableColumns
    .map((column) => `OLD.${column} IS NOT NEW.${column}`)
    .join('\n  OR ')}
BEGIN
  SELECT RAISE(ABORT, 'wallet ${definition.kind} identity is immutable');
END;`;
}

function deleteGuard(definition: CaptureDefinition) {
  if (definition.kind === 'decision') {
    return `
CREATE TRIGGER IF NOT EXISTS wallet_sync_guard_decision_delete
BEFORE DELETE ON wallet_decisions
WHEN ${captureEnabledPredicate()}
BEGIN
  SELECT RAISE(ABORT, 'wallet decision is state-transition only');
END;`;
  }
  if (definition.kind === 'review') {
    return `
CREATE TRIGGER IF NOT EXISTS wallet_sync_guard_review_delete
BEFORE DELETE ON wallet_decision_reviews
WHEN ${captureEnabledPredicate()}
BEGIN
  SELECT RAISE(ABORT, 'wallet review is state-transition only');
END;`;
  }
  return `
CREATE TRIGGER IF NOT EXISTS wallet_sync_guard_${definition.kind}_delete
BEFORE DELETE ON ${definition.table}
WHEN ${captureEnabledPredicate()}
BEGIN
  SELECT RAISE(ABORT, 'wallet ${definition.kind} deletion is not allowed');
END;`;
}

function appendOnlyGuards(definition: CaptureDefinition) {
  if (!definition.appendOnly) return '';
  return `
CREATE TRIGGER IF NOT EXISTS wallet_sync_guard_${definition.kind}_update
BEFORE UPDATE ON ${definition.table}
BEGIN
  SELECT RAISE(ABORT, 'wallet ${definition.kind} is append-only');
END;

${deleteGuard(definition)}`;
}

export const WALLET_LEDGER_CAPTURE_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS wallet_sync_runtime (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  capture_enabled INTEGER NOT NULL DEFAULT 0 CHECK (capture_enabled IN (0, 1)),
  suppress_capture INTEGER NOT NULL DEFAULT 0 CHECK (suppress_capture IN (0, 1)),
  vault_id TEXT,
  source_device_id TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO wallet_sync_runtime (
  singleton_id, capture_enabled, suppress_capture,
  vault_id, source_device_id, updated_at
) VALUES (1, 0, 0, NULL, NULL, 0);

CREATE TABLE IF NOT EXISTS wallet_sync_domain_outbox (
  local_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL UNIQUE,
  revision_id TEXT NOT NULL UNIQUE,
  parent_revision_ids_json TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  source_sequence INTEGER,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'wallet', 'preference', 'holding', 'decision',
      'transaction', 'snapshot', 'review'
    )
  ),
  entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 256),
  operation TEXT NOT NULL CHECK (operation = 'upsert'),
  schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'leased', 'dispatched', 'quarantined')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_id TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  dispatched_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source_device_id, source_sequence)
);

CREATE INDEX IF NOT EXISTS idx_wallet_sync_outbox_ready
  ON wallet_sync_domain_outbox(state, available_at, local_sequence);

CREATE TABLE IF NOT EXISTS wallet_sync_entity_heads (
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'wallet', 'preference', 'holding', 'decision',
      'transaction', 'snapshot', 'review'
    )
  ),
  entity_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id, revision_id)
);

CREATE TABLE IF NOT EXISTS wallet_sync_conflicts (
  conflict_id TEXT PRIMARY KEY NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  local_revision_id TEXT,
  incoming_revision_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  local_payload_json TEXT,
  incoming_payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'resolved')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS wallet_sync_bootstrap_state (
  adapter_id TEXT NOT NULL,
  bootstrap_version INTEGER NOT NULL,
  vault_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (adapter_id, bootstrap_version, vault_id, source_device_id)
);

CREATE TABLE IF NOT EXISTS wallet_sync_schema_meta (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  storage_schema_version INTEGER NOT NULL,
  capture_schema_version INTEGER NOT NULL,
  trigger_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO wallet_sync_schema_meta (
  singleton_id, storage_schema_version, capture_schema_version,
  trigger_count, updated_at
) VALUES (
  1,
  ${WALLET_LEDGER_STORAGE_SCHEMA_VERSION},
  ${WALLET_LEDGER_CAPTURE_SCHEMA_VERSION},
  ${WALLET_LEDGER_EXPECTED_CAPTURE_TRIGGER_COUNT},
  ${unixMillisecondsExpression()}
)
ON CONFLICT(singleton_id) DO UPDATE SET
  storage_schema_version = excluded.storage_schema_version,
  capture_schema_version = excluded.capture_schema_version,
  trigger_count = excluded.trigger_count,
  updated_at = excluded.updated_at;
`;

export const WALLET_LEDGER_CAPTURE_TRIGGER_SQL =
  CAPTURE_DEFINITIONS.map(captureTriggers).join('\n');

export const WALLET_LEDGER_WRITE_GUARD_SQL =
  CAPTURE_DEFINITIONS.map((definition) => [
    immutableUpdateGuard(definition),
    appendOnlyGuards(definition),
    definition.appendOnly ? '' : deleteGuard(definition),
  ].filter(Boolean).join('\n')).join('\n');

export const WALLET_LEDGER_FULL_CAPTURE_SCHEMA_SQL = `
${WALLET_LEDGER_CAPTURE_TABLE_SCHEMA_SQL}
${WALLET_LEDGER_CAPTURE_TRIGGER_SQL}
${WALLET_LEDGER_WRITE_GUARD_SQL}
`;

function bootstrapInsertSql(definition: CaptureDefinition) {
  const sharedPredicate =
    sharedRowPredicate(definition.kind, 'ROW');
  return `
INSERT INTO wallet_sync_domain_outbox (
  mutation_id, revision_id, parent_revision_ids_json,
  vault_id, source_device_id, entity_type, entity_id,
  operation, schema_version, payload_json, state,
  available_at, created_at, updated_at
)
SELECT
  ${uuidV4Expression()},
  ${uuidV4Expression()},
  ${parentRevisionIdsExpression(definition.kind, 'ROW')},
  runtime.vault_id,
  runtime.source_device_id,
  '${definition.kind}',
  ${entityIdExpression(definition.kind, 'ROW')},
  'upsert',
  ${WALLET_LEDGER_SCHEMA_VERSION},
  json_object(
    'schemaVersion', ${WALLET_LEDGER_SCHEMA_VERSION},
    'kind', '${definition.kind}',
    'record', ${recordExpression(definition.kind, 'ROW')}
  ),
  'pending',
  ?,
  ?,
  ?
FROM ${definition.table} AS ROW
CROSS JOIN wallet_sync_runtime AS runtime
WHERE runtime.singleton_id = 1
  AND ${sharedPredicate}
ORDER BY ${localIdExpression(definition.kind, 'ROW')} ASC;
`;
}

export const WALLET_LEDGER_BOOTSTRAP_INSERT_SQL =
  CAPTURE_DEFINITIONS.map(bootstrapInsertSql);

function currentSnapshotSelectSql(definition: CaptureDefinition) {
  const sharedPredicate = sharedRowPredicate(definition.kind, 'ROW');
  return `SELECT
    '${definition.kind}' AS entity_type,
    ${entityIdExpression(definition.kind, 'ROW')} AS entity_id,
    'upsert' AS operation,
    ${WALLET_LEDGER_SCHEMA_VERSION} AS schema_version,
    json_object(
      'schemaVersion', ${WALLET_LEDGER_SCHEMA_VERSION},
      'kind', '${definition.kind}',
      'record', ${recordExpression(definition.kind, 'ROW')}
    ) AS payload_json
  FROM ${definition.table} AS ROW
  WHERE ${sharedPredicate}
  ORDER BY ${localIdExpression(definition.kind, 'ROW')} ASC`;
}

export const WALLET_LEDGER_CURRENT_SNAPSHOT_SELECT_SQL =
  CAPTURE_DEFINITIONS.map(currentSnapshotSelectSql);

export const WALLET_LEDGER_RESET_TECHNICAL_STATE_SQL = `
DELETE FROM wallet_sync_domain_outbox;
DELETE FROM wallet_sync_entity_heads;
DELETE FROM wallet_sync_conflicts;
DELETE FROM wallet_sync_bootstrap_state;
UPDATE wallet_sync_runtime
SET capture_enabled = 0,
    suppress_capture = 0,
    vault_id = NULL,
    source_device_id = NULL,
    updated_at = 0
WHERE singleton_id = 1;
`;
