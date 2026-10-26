import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const WALLET_LEDGER_ADAPTER_ID = 'wallet.ledger' as const;
export const WALLET_LEDGER_SCHEMA_VERSION = 1 as const;
export const WALLET_LEDGER_RETENTION_CLASS =
  'financial-ledger' as const;
export const WALLET_LEDGER_ENTITY_TYPES = [
  'wallet',
  'preference',
  'holding',
  'decision',
  'transaction',
  'snapshot',
  'review',
] as const;

export type WalletLedgerEntityType =
  (typeof WALLET_LEDGER_ENTITY_TYPES)[number];

export type WalletLedgerWalletRecord = {
  id: string;
  owner: string;
  name: string;
  totalBudget: number;
  cashBalance: number;
  investedAmount: number;
  riskProfile: 'cash_like' | 'low' | 'medium' | 'high';
  createdAt: number;
  updatedAt: number;
};

export type WalletLedgerPreferenceRecord = {
  walletId: string;
  enabled: boolean;
  tendency: string;
  preferredPools: Array<'cash_parking' | 'stable' | 'broad_index'>;
  avoidTypes: Array<'watchlist' | 'etf' | 'qdii' | 'commodity' | 'industry'>;
  comfortSingleAmount: number | null;
  updatedAt: number;
};

export type WalletLedgerHoldingRecord = {
  id: string;
  walletId: string;
  fundCode: string;
  fundName: string;
  fundType: string;
  shares: number;
  avgCostNav: number;
  totalCost: number;
  latestNav: number;
  marketValue: number;
  floatingProfit: number;
  floatingProfitPct: number;
  warnDownPct: number | null;
  warnUpPct: number | null;
  updatedAt: number;
};

export type WalletLedgerDecisionRecord = {
  id: string;
  walletId: string;
  fundCode: string;
  fundName: string;
  fundType: string;
  action: 'buy' | 'observe' | 'hold' | 'pause';
  amount: number;
  status:
    | 'proposed'
    | 'approved'
    | 'rejected'
    | 'deferred'
    | 'executed'
    | 'expired'
    | 'blocked';
  confidence: number;
  reasoning: string;
  riskWarning: string;
  whyNotMore: string;
  source: 'manual' | 'chat' | 'baiyun';
  suggestedNav: number | null;
  suggestedNavSource:
    | 'candidate_latest_value'
    | 'cash_like_unit_nav'
    | 'nav_history'
    | 'manual'
    | null;
  suggestedNavAt: number | null;
  createdAt: number;
  approvedAt: number | null;
  rejectedAt: number | null;
  executedAt: number | null;
};

export type WalletLedgerTransactionRecord = {
  id: string;
  walletId: string;
  decisionId: string | null;
  fundCode: string;
  fundName: string;
  action: 'buy' | 'observe' | 'hold' | 'pause';
  amount: number;
  shares: number;
  nav: number;
  fee: number;
  createdAt: number;
};

export type WalletLedgerSnapshotRecord = {
  id: string;
  walletId: string;
  cashBalance: number;
  investedAmount: number;
  marketValue: number;
  floatingProfit: number;
  floatingProfitPct: number;
  snapshotAt: number;
};

export type WalletLedgerReviewRecord = {
  id: string;
  walletId: string;
  decisionId: string;
  fundCode: string;
  fundName: string;
  decisionNav: number | null;
  nav7d: number | null;
  nav30d: number | null;
  return7dPct: number | null;
  return30dPct: number | null;
  maxDrawdownPct: number | null;
  warningTriggered: boolean;
  userFeedback: string | null;
  reasonStillValid: boolean | null;
  status: 'pending' | 'ready' | 'data_missing';
  reviewedAt: number | null;
  updatedAt: number;
};

export type WalletLedgerRecordByKind = {
  wallet: WalletLedgerWalletRecord;
  preference: WalletLedgerPreferenceRecord;
  holding: WalletLedgerHoldingRecord;
  decision: WalletLedgerDecisionRecord;
  transaction: WalletLedgerTransactionRecord;
  snapshot: WalletLedgerSnapshotRecord;
  review: WalletLedgerReviewRecord;
};

export type WalletLedgerRecord =
  WalletLedgerRecordByKind[WalletLedgerEntityType];

export type WalletLedgerPayloadV1 = {
  [Kind in WalletLedgerEntityType]: {
    schemaVersion: typeof WALLET_LEDGER_SCHEMA_VERSION;
    kind: Kind;
    record: WalletLedgerRecordByKind[Kind];
  };
}[WalletLedgerEntityType];

type UnknownRecord = Record<string, unknown>;

function recordOf(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as UnknownRecord;
}

function assertExactKeys(
  record: UnknownRecord,
  keys: readonly string[],
  label: string,
) {
  const expected = new Set(keys);
  const extras = Object.keys(record).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !(key in record));
  if (extras.length || missing.length) {
    throw new Error(
      `${label} 字段无效`
      + `${extras.length ? `，多余：${extras.sort().join(', ')}` : ''}`
      + `${missing.length ? `，缺少：${missing.join(', ')}` : ''}。`,
    );
  }
}

function assertString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): asserts value is string {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || value.length > maximum
    || value.includes('\0')
  ) {
    throw new Error(`${label} 必须是有效且不超过 ${maximum} 字符的文本。`);
  }
}

function assertLocalId(value: unknown, label: string): asserts value is string {
  assertString(value, label, 220);
  if (/[\r\n]/u.test(value)) {
    throw new Error(`${label} 不能包含换行。`);
  }
}

function assertTimestamp(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertNullableTimestamp(
  value: unknown,
  label: string,
): asserts value is number | null {
  if (value !== null) assertTimestamp(value, label);
}

function assertFiniteNumber(
  value: unknown,
  label: string,
  input: { minimum?: number; maximum?: number } = {},
): asserts value is number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || Math.abs(value) > Number.MAX_SAFE_INTEGER
    || (
      input.minimum !== undefined
      && value < input.minimum
    )
    || (
      input.maximum !== undefined
      && value > input.maximum
    )
  ) {
    throw new Error(`${label} 必须是范围内的有限数值。`);
  }
}

function assertNullableFiniteNumber(
  value: unknown,
  label: string,
  input: { minimum?: number; maximum?: number } = {},
): asserts value is number | null {
  if (value !== null) assertFiniteNumber(value, label, input);
}

function assertBoolean(
  value: unknown,
  label: string,
): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} 必须是布尔值。`);
  }
}

function assertNullableBoolean(
  value: unknown,
  label: string,
): asserts value is boolean | null {
  if (value !== null) assertBoolean(value, label);
}

function assertNullableString(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is string | null {
  if (value !== null) assertString(value, label, maximum, true);
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} 无效。`);
  }
}

function assertNullableEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T | null {
  if (value !== null) assertEnum(value, allowed, label);
}

function assertUniqueEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T[] {
  if (
    !Array.isArray(value)
    || value.length > allowed.length
    || value.some(
      (item) => typeof item !== 'string' || !allowed.includes(item as T),
    )
    || new Set(value).size !== value.length
  ) {
    throw new Error(`${label} 必须是无重复的允许值数组。`);
  }
}

export function isWalletLedgerEntityType(
  value: unknown,
): value is WalletLedgerEntityType {
  return (
    typeof value === 'string'
    && (WALLET_LEDGER_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

export function walletLedgerEntityId(
  kind: WalletLedgerEntityType,
  localId: string,
) {
  assertLocalId(localId, `wallet ${kind} local id`);
  return `${kind}:${localId}`;
}

export function walletLedgerLocalId(
  kind: WalletLedgerEntityType,
  entityId: string,
) {
  assertString(entityId, `wallet ${kind} entity id`, 256);
  const prefix = `${kind}:`;
  if (!entityId.startsWith(prefix)) {
    throw new Error(`wallet ${kind} entity id 前缀无效。`);
  }
  const localId = entityId.slice(prefix.length);
  assertLocalId(localId, `wallet ${kind} local id`);
  return localId;
}

function assertWalletRecord(
  entityId: string,
  value: unknown,
): asserts value is WalletLedgerWalletRecord {
  const record = recordOf(value, 'wallet record');
  assertExactKeys(record, [
    'id',
    'owner',
    'name',
    'totalBudget',
    'cashBalance',
    'investedAmount',
    'riskProfile',
    'createdAt',
    'updatedAt',
  ], 'wallet record');
  assertLocalId(record.id, 'wallet id');
  if (walletLedgerEntityId('wallet', record.id) !== entityId) {
    throw new Error('wallet id 与 entity id 不一致。');
  }
  assertString(record.owner, 'wallet owner', 10_000);
  assertString(record.name, 'wallet name', 10_000);
  assertFiniteNumber(record.totalBudget, 'wallet totalBudget', { minimum: 0 });
  assertFiniteNumber(record.cashBalance, 'wallet cashBalance', { minimum: 0 });
  assertFiniteNumber(record.investedAmount, 'wallet investedAmount', { minimum: 0 });
  if (
    (record.cashBalance as number) + (record.investedAmount as number)
    > (record.totalBudget as number) + 0.011
  ) {
    throw new Error('wallet 余额与已投入金额不能超过总预算。');
  }
  assertEnum(
    record.riskProfile,
    ['cash_like', 'low', 'medium', 'high'],
    'wallet riskProfile',
  );
  assertTimestamp(record.createdAt, 'wallet createdAt');
  assertTimestamp(record.updatedAt, 'wallet updatedAt');
}

function assertPreferenceRecord(
  entityId: string,
  value: unknown,
): asserts value is WalletLedgerPreferenceRecord {
  const record = recordOf(value, 'wallet preference record');
  assertExactKeys(record, [
    'walletId',
    'enabled',
    'tendency',
    'preferredPools',
    'avoidTypes',
    'comfortSingleAmount',
    'updatedAt',
  ], 'wallet preference record');
  assertLocalId(record.walletId, 'wallet preference walletId');
  if (walletLedgerEntityId('preference', record.walletId) !== entityId) {
    throw new Error('wallet preference walletId 与 entity id 不一致。');
  }
  assertBoolean(record.enabled, 'wallet preference enabled');
  assertString(record.tendency, 'wallet preference tendency', 100_000, true);
  assertUniqueEnumArray(
    record.preferredPools,
    ['cash_parking', 'stable', 'broad_index'],
    'wallet preference preferredPools',
  );
  assertUniqueEnumArray(
    record.avoidTypes,
    ['watchlist', 'etf', 'qdii', 'commodity', 'industry'],
    'wallet preference avoidTypes',
  );
  assertNullableFiniteNumber(
    record.comfortSingleAmount,
    'wallet preference comfortSingleAmount',
    { minimum: 0 },
  );
  assertTimestamp(record.updatedAt, 'wallet preference updatedAt');
}

function assertHoldingRecord(
  entityId: string,
  value: unknown,
): asserts value is WalletLedgerHoldingRecord {
  const record = recordOf(value, 'wallet holding record');
  assertExactKeys(record, [
    'id',
    'walletId',
    'fundCode',
    'fundName',
    'fundType',
    'shares',
    'avgCostNav',
    'totalCost',
    'latestNav',
    'marketValue',
    'floatingProfit',
    'floatingProfitPct',
    'warnDownPct',
    'warnUpPct',
    'updatedAt',
  ], 'wallet holding record');
  assertLocalId(record.id, 'wallet holding id');
  if (walletLedgerEntityId('holding', record.id) !== entityId) {
    throw new Error('wallet holding id 与 entity id 不一致。');
  }
  assertLocalId(record.walletId, 'wallet holding walletId');
  assertString(record.fundCode, 'wallet holding fundCode', 10_000);
  assertString(record.fundName, 'wallet holding fundName', 100_000);
  assertString(record.fundType, 'wallet holding fundType', 10_000, true);
  assertFiniteNumber(record.shares, 'wallet holding shares', { minimum: 0 });
  assertFiniteNumber(record.avgCostNav, 'wallet holding avgCostNav', { minimum: 0 });
  assertFiniteNumber(record.totalCost, 'wallet holding totalCost', { minimum: 0 });
  assertFiniteNumber(record.latestNav, 'wallet holding latestNav', { minimum: 0 });
  assertFiniteNumber(record.marketValue, 'wallet holding marketValue', { minimum: 0 });
  assertFiniteNumber(record.floatingProfit, 'wallet holding floatingProfit');
  assertFiniteNumber(record.floatingProfitPct, 'wallet holding floatingProfitPct');
  assertNullableFiniteNumber(record.warnDownPct, 'wallet holding warnDownPct');
  assertNullableFiniteNumber(record.warnUpPct, 'wallet holding warnUpPct');
  assertTimestamp(record.updatedAt, 'wallet holding updatedAt');
}

function assertDecisionRecord(
  entityId: string,
  value: unknown,
): asserts value is WalletLedgerDecisionRecord {
  const record = recordOf(value, 'wallet decision record');
  assertExactKeys(record, [
    'id',
    'walletId',
    'fundCode',
    'fundName',
    'fundType',
    'action',
    'amount',
    'status',
    'confidence',
    'reasoning',
    'riskWarning',
    'whyNotMore',
    'source',
    'suggestedNav',
    'suggestedNavSource',
    'suggestedNavAt',
    'createdAt',
    'approvedAt',
    'rejectedAt',
    'executedAt',
  ], 'wallet decision record');
  assertLocalId(record.id, 'wallet decision id');
  if (walletLedgerEntityId('decision', record.id) !== entityId) {
    throw new Error('wallet decision id 与 entity id 不一致。');
  }
  assertLocalId(record.walletId, 'wallet decision walletId');
  assertString(record.fundCode, 'wallet decision fundCode', 10_000);
  assertString(record.fundName, 'wallet decision fundName', 100_000);
  assertString(record.fundType, 'wallet decision fundType', 10_000, true);
  assertEnum(record.action, ['buy', 'observe', 'hold', 'pause'], 'wallet decision action');
  assertFiniteNumber(record.amount, 'wallet decision amount', { minimum: 0 });
  assertEnum(
    record.status,
    ['proposed', 'approved', 'rejected', 'deferred', 'executed', 'expired', 'blocked'],
    'wallet decision status',
  );
  assertFiniteNumber(record.confidence, 'wallet decision confidence', {
    minimum: 0,
    maximum: 100,
  });
  assertString(record.reasoning, 'wallet decision reasoning', 850_000);
  assertString(record.riskWarning, 'wallet decision riskWarning', 850_000);
  assertString(record.whyNotMore, 'wallet decision whyNotMore', 850_000);
  assertEnum(record.source, ['manual', 'chat', 'baiyun'], 'wallet decision source');
  assertNullableFiniteNumber(record.suggestedNav, 'wallet decision suggestedNav', {
    minimum: 0,
  });
  assertNullableEnum(
    record.suggestedNavSource,
    ['candidate_latest_value', 'cash_like_unit_nav', 'nav_history', 'manual'],
    'wallet decision suggestedNavSource',
  );
  assertNullableTimestamp(record.suggestedNavAt, 'wallet decision suggestedNavAt');
  assertTimestamp(record.createdAt, 'wallet decision createdAt');
  assertNullableTimestamp(record.approvedAt, 'wallet decision approvedAt');
  assertNullableTimestamp(record.rejectedAt, 'wallet decision rejectedAt');
  assertNullableTimestamp(record.executedAt, 'wallet decision executedAt');
  if (
    record.status === 'proposed'
    || record.status === 'deferred'
    || record.status === 'expired'
    || record.status === 'blocked'
  ) {
    if (
      record.approvedAt !== null
      || record.rejectedAt !== null
      || record.executedAt !== null
    ) {
      throw new Error('wallet decision 非终结状态不能携带审批或执行时间。');
    }
  } else if (record.status === 'approved') {
    if (
      record.approvedAt === null
      || record.rejectedAt !== null
      || record.executedAt !== null
    ) {
      throw new Error('wallet decision approved 状态时间字段无效。');
    }
  } else if (record.status === 'rejected') {
    if (
      record.approvedAt !== null
      || record.rejectedAt === null
      || record.executedAt !== null
    ) {
      throw new Error('wallet decision rejected 状态时间字段无效。');
    }
  } else if (
    record.approvedAt === null
    || record.executedAt === null
    || record.rejectedAt !== null
  ) {
    throw new Error('wallet decision executed 状态时间字段无效。');
  }
}

function assertTransactionRecord(
  entityId: string,
  value: unknown,
): asserts value is WalletLedgerTransactionRecord {
  const record = recordOf(value, 'wallet transaction record');
  assertExactKeys(record, [
    'id',
    'walletId',
    'decisionId',
    'fundCode',
    'fundName',
    'action',
    'amount',
    'shares',
    'nav',
    'fee',
    'createdAt',
  ], 'wallet transaction record');
  assertLocalId(record.id, 'wallet transaction id');
  if (walletLedgerEntityId('transaction', record.id) !== entityId) {
    throw new Error('wallet transaction id 与 entity id 不一致。');
  }
  assertLocalId(record.walletId, 'wallet transaction walletId');
  if (record.decisionId !== null) {
    assertLocalId(record.decisionId, 'wallet transaction decisionId');
  }
  assertString(record.fundCode, 'wallet transaction fundCode', 10_000);
  assertString(record.fundName, 'wallet transaction fundName', 100_000);
  assertEnum(record.action, ['buy', 'observe', 'hold', 'pause'], 'wallet transaction action');
  assertFiniteNumber(record.amount, 'wallet transaction amount', { minimum: 0 });
  assertFiniteNumber(record.shares, 'wallet transaction shares', { minimum: 0 });
  assertFiniteNumber(record.nav, 'wallet transaction nav', { minimum: 0 });
  assertFiniteNumber(record.fee, 'wallet transaction fee', { minimum: 0 });
  assertTimestamp(record.createdAt, 'wallet transaction createdAt');
}

function assertSnapshotRecord(
  entityId: string,
  value: unknown,
): asserts value is WalletLedgerSnapshotRecord {
  const record = recordOf(value, 'wallet snapshot record');
  assertExactKeys(record, [
    'id',
    'walletId',
    'cashBalance',
    'investedAmount',
    'marketValue',
    'floatingProfit',
    'floatingProfitPct',
    'snapshotAt',
  ], 'wallet snapshot record');
  assertLocalId(record.id, 'wallet snapshot id');
  if (walletLedgerEntityId('snapshot', record.id) !== entityId) {
    throw new Error('wallet snapshot id 与 entity id 不一致。');
  }
  assertLocalId(record.walletId, 'wallet snapshot walletId');
  assertFiniteNumber(record.cashBalance, 'wallet snapshot cashBalance', { minimum: 0 });
  assertFiniteNumber(record.investedAmount, 'wallet snapshot investedAmount', { minimum: 0 });
  assertFiniteNumber(record.marketValue, 'wallet snapshot marketValue', { minimum: 0 });
  assertFiniteNumber(record.floatingProfit, 'wallet snapshot floatingProfit');
  assertFiniteNumber(record.floatingProfitPct, 'wallet snapshot floatingProfitPct');
  assertTimestamp(record.snapshotAt, 'wallet snapshot snapshotAt');
}

function assertReviewRecord(
  entityId: string,
  value: unknown,
): asserts value is WalletLedgerReviewRecord {
  const record = recordOf(value, 'wallet review record');
  assertExactKeys(record, [
    'id',
    'walletId',
    'decisionId',
    'fundCode',
    'fundName',
    'decisionNav',
    'nav7d',
    'nav30d',
    'return7dPct',
    'return30dPct',
    'maxDrawdownPct',
    'warningTriggered',
    'userFeedback',
    'reasonStillValid',
    'status',
    'reviewedAt',
    'updatedAt',
  ], 'wallet review record');
  assertLocalId(record.id, 'wallet review id');
  if (walletLedgerEntityId('review', record.id) !== entityId) {
    throw new Error('wallet review id 与 entity id 不一致。');
  }
  assertLocalId(record.walletId, 'wallet review walletId');
  assertLocalId(record.decisionId, 'wallet review decisionId');
  assertString(record.fundCode, 'wallet review fundCode', 10_000);
  assertString(record.fundName, 'wallet review fundName', 100_000);
  assertNullableFiniteNumber(record.decisionNav, 'wallet review decisionNav', { minimum: 0 });
  assertNullableFiniteNumber(record.nav7d, 'wallet review nav7d', { minimum: 0 });
  assertNullableFiniteNumber(record.nav30d, 'wallet review nav30d', { minimum: 0 });
  assertNullableFiniteNumber(record.return7dPct, 'wallet review return7dPct');
  assertNullableFiniteNumber(record.return30dPct, 'wallet review return30dPct');
  assertNullableFiniteNumber(record.maxDrawdownPct, 'wallet review maxDrawdownPct');
  assertBoolean(record.warningTriggered, 'wallet review warningTriggered');
  assertNullableString(record.userFeedback, 'wallet review userFeedback', 850_000);
  assertNullableBoolean(record.reasonStillValid, 'wallet review reasonStillValid');
  assertEnum(record.status, ['pending', 'ready', 'data_missing'], 'wallet review status');
  assertNullableTimestamp(record.reviewedAt, 'wallet review reviewedAt');
  assertTimestamp(record.updatedAt, 'wallet review updatedAt');
}

export function assertWalletLedgerRecord(
  kind: WalletLedgerEntityType,
  entityId: string,
  value: unknown,
): asserts value is WalletLedgerRecord {
  switch (kind) {
    case 'wallet':
      assertWalletRecord(entityId, value);
      return;
    case 'preference':
      assertPreferenceRecord(entityId, value);
      return;
    case 'holding':
      assertHoldingRecord(entityId, value);
      return;
    case 'decision':
      assertDecisionRecord(entityId, value);
      return;
    case 'transaction':
      assertTransactionRecord(entityId, value);
      return;
    case 'snapshot':
      assertSnapshotRecord(entityId, value);
      return;
    case 'review':
      assertReviewRecord(entityId, value);
  }
}

export function assertWalletLedgerPayload(
  entityType: string,
  entityId: string,
  operation: string,
  value: unknown,
): asserts value is WalletLedgerPayloadV1 {
  if (!isWalletLedgerEntityType(entityType)) {
    throw new Error('wallet.ledger entity type 无效。');
  }
  if (operation !== 'upsert') {
    throw new Error('wallet.ledger 只允许状态提交或追加记录的 upsert。');
  }
  const payload = recordOf(value, 'wallet.ledger payload');
  assertExactKeys(
    payload,
    ['schemaVersion', 'kind', 'record'],
    'wallet.ledger payload',
  );
  if (
    payload.schemaVersion !== WALLET_LEDGER_SCHEMA_VERSION
    || payload.kind !== entityType
  ) {
    throw new Error('wallet.ledger payload 版本或 kind 无效。');
  }
  walletLedgerLocalId(entityType, entityId);
  assertWalletLedgerRecord(entityType, entityId, payload.record);
}

export function assertWalletLedgerMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'wallet'
    || !isWalletLedgerEntityType(value.entity.type)
  ) {
    throw new Error('wallet.ledger mutation entity 无效。');
  }
  if (value.revision.schemaVersion !== WALLET_LEDGER_SCHEMA_VERSION) {
    throw new Error('wallet.ledger schemaVersion 无效。');
  }
  if (value.revision.operation !== 'upsert') {
    throw new Error('wallet.ledger operation 无效。');
  }
  if (
    value.sensitivity !== 'highest'
    || value.retentionClass !== WALLET_LEDGER_RETENTION_CLASS
  ) {
    throw new Error('wallet.ledger 最高敏留存合同无效。');
  }
  if (value.objectRefs.length !== 0) {
    throw new Error('wallet.ledger 不接受对象引用。');
  }
  assertWalletLedgerPayload(
    value.entity.type,
    value.entity.id,
    value.revision.operation,
    value.payload,
  );
}

export function walletLedgerPayload(mutation: PlainMutationV1) {
  assertWalletLedgerMutationV1(mutation);
  return mutation.payload as WalletLedgerPayloadV1;
}

export function buildWalletLedgerMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: WalletLedgerEntityType;
  entityId: string;
  payload: WalletLedgerPayloadV1;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'wallet',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: 'upsert',
      schemaVersion: WALLET_LEDGER_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: input.payload,
    objectRefs: [],
    retentionClass: WALLET_LEDGER_RETENTION_CLASS,
  };
  assertWalletLedgerMutationV1(mutation);
  return mutation;
}

export function walletLedgerRecordPayload(input: {
  entityType: WalletLedgerEntityType;
  entityId: string;
  record: JsonValue & Record<string, JsonValue>;
}): WalletLedgerPayloadV1 {
  assertWalletLedgerRecord(
    input.entityType,
    input.entityId,
    input.record,
  );
  return {
    schemaVersion: WALLET_LEDGER_SCHEMA_VERSION,
    kind: input.entityType,
    record: input.record,
  } as WalletLedgerPayloadV1;
}
