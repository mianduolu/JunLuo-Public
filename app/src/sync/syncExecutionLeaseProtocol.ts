import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalizeJsonBytesV1,
  signEd25519V1,
  verifyEd25519V1,
} from './syncCrypto';
import { assertSyncUuidV4 } from './syncDeviceContract';
import { assertBase64Url } from './syncProtocol';

export const SYNC_EXECUTION_CATEGORIES_V1 = [
  'proactive-message',
  'life-tick',
  'reminder',
  'alarm',
  'tool-call',
  'wallet-transaction',
  'timer',
] as const;

export const SYNC_EXECUTION_SIGNATURE_CONTEXTS_V1 = Object.freeze({
  intent: 'junluo.sync.v1/execution-intent',
  claim: 'junluo.sync.v1/execution-claim',
  start: 'junluo.sync.v1/execution-start',
  receipt: 'junluo.sync.v1/execution-receipt',
});

export type SyncExecutionCategoryV1 = typeof SYNC_EXECUTION_CATEGORIES_V1[number];
export type SyncExecutionOutcomeV1 = 'completed' | 'failed' | 'cancelled';
export type SyncExecutionStateV1 = 'pending' | 'claimed' | 'started' | 'completed';

export type SyncExecutionIntentV1 = {
  protocolVersion: 1;
  vaultId: string;
  operationId: string;
  keyId: string;
  category: SyncExecutionCategoryV1;
  sourceDeviceId: string;
  createdAt: number;
  notBefore: number;
  signature: string;
};

export type SyncExecutionClaimV1 = {
  protocolVersion: 1;
  vaultId: string;
  operationId: string;
  keyId: string;
  claimantDeviceId: string;
  claimId: string;
  requestedAt: number;
  leaseDurationMs: number;
  signature: string;
};

export type SyncExecutionStartV1 = {
  protocolVersion: 1;
  vaultId: string;
  operationId: string;
  keyId: string;
  executorDeviceId: string;
  claimId: string;
  startedAt: number;
  signature: string;
};

export type SyncExecutionReceiptV1 = {
  protocolVersion: 1;
  vaultId: string;
  operationId: string;
  keyId: string;
  executorDeviceId: string;
  claimId: string;
  receiptId: string;
  outcome: SyncExecutionOutcomeV1;
  completedAt: number;
  signature: string;
};

export type SyncExecutionStatusV1 = {
  state: SyncExecutionStateV1;
  intent: SyncExecutionIntentV1;
  claim: SyncExecutionClaimV1 | null;
  leaseExpiresAt: number | null;
  start: SyncExecutionStartV1 | null;
  receipt: SyncExecutionReceiptV1 | null;
};

type SignedExecutionRecordV1 =
  | SyncExecutionIntentV1
  | SyncExecutionClaimV1
  | SyncExecutionStartV1
  | SyncExecutionReceiptV1;

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
) {
  const actual = Object.keys(record);
  if (
    actual.some((key) => !keys.includes(key))
    || keys.some((key) => !(key in record))
  ) {
    throw new Error(`${label} 字段不符合 v1 合同。`);
  }
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertCommon(record: Record<string, unknown>, label: string) {
  if (record.protocolVersion !== 1) throw new Error(`${label} protocolVersion 无效。`);
  assertSyncUuidV4(record.vaultId, `${label} vaultId`);
  assertBase64Url(record.operationId, `${label} operationId`, { exactBytes: 32 });
  assertSyncUuidV4(record.keyId, `${label} keyId`);
  assertBase64Url(record.signature, `${label} signature`, { exactBytes: 64 });
}

export function assertSyncExecutionIntentV1(
  value: unknown,
): asserts value is SyncExecutionIntentV1 {
  const record = recordOf(value, 'execution intent');
  assertExactKeys(record, [
    'protocolVersion', 'vaultId', 'operationId', 'keyId', 'category',
    'sourceDeviceId', 'createdAt', 'notBefore', 'signature',
  ], 'execution intent');
  assertCommon(record, 'execution intent');
  if (!SYNC_EXECUTION_CATEGORIES_V1.includes(record.category as SyncExecutionCategoryV1)) {
    throw new Error('execution intent category 无效。');
  }
  assertSyncUuidV4(record.sourceDeviceId, 'execution intent sourceDeviceId');
  assertTimestamp(record.createdAt, 'execution intent createdAt');
  assertTimestamp(record.notBefore, 'execution intent notBefore');
}

export function assertSyncExecutionClaimV1(
  value: unknown,
): asserts value is SyncExecutionClaimV1 {
  const record = recordOf(value, 'execution claim');
  assertExactKeys(record, [
    'protocolVersion', 'vaultId', 'operationId', 'keyId', 'claimantDeviceId',
    'claimId', 'requestedAt', 'leaseDurationMs', 'signature',
  ], 'execution claim');
  assertCommon(record, 'execution claim');
  assertSyncUuidV4(record.claimantDeviceId, 'execution claim claimantDeviceId');
  assertSyncUuidV4(record.claimId, 'execution claim claimId');
  assertTimestamp(record.requestedAt, 'execution claim requestedAt');
  if (
    !Number.isSafeInteger(record.leaseDurationMs)
    || Number(record.leaseDurationMs) < 5_000
    || Number(record.leaseDurationMs) > 300_000
  ) {
    throw new Error('execution claim leaseDurationMs 必须在 5–300 秒之间。');
  }
}

export function assertSyncExecutionStartV1(
  value: unknown,
): asserts value is SyncExecutionStartV1 {
  const record = recordOf(value, 'execution start');
  assertExactKeys(record, [
    'protocolVersion', 'vaultId', 'operationId', 'keyId', 'executorDeviceId',
    'claimId', 'startedAt', 'signature',
  ], 'execution start');
  assertCommon(record, 'execution start');
  assertSyncUuidV4(record.executorDeviceId, 'execution start executorDeviceId');
  assertSyncUuidV4(record.claimId, 'execution start claimId');
  assertTimestamp(record.startedAt, 'execution start startedAt');
}

export function assertSyncExecutionReceiptV1(
  value: unknown,
): asserts value is SyncExecutionReceiptV1 {
  const record = recordOf(value, 'execution receipt');
  assertExactKeys(record, [
    'protocolVersion', 'vaultId', 'operationId', 'keyId', 'executorDeviceId',
    'claimId', 'receiptId', 'outcome', 'completedAt', 'signature',
  ], 'execution receipt');
  assertCommon(record, 'execution receipt');
  assertSyncUuidV4(record.executorDeviceId, 'execution receipt executorDeviceId');
  assertSyncUuidV4(record.claimId, 'execution receipt claimId');
  assertBase64Url(record.receiptId, 'execution receipt receiptId', { exactBytes: 32 });
  if (record.outcome !== 'completed' && record.outcome !== 'failed' && record.outcome !== 'cancelled') {
    throw new Error('execution receipt outcome 无效。');
  }
  assertTimestamp(record.completedAt, 'execution receipt completedAt');
}

export function assertSyncExecutionStatusV1(
  value: unknown,
): asserts value is SyncExecutionStatusV1 {
  const record = recordOf(value, 'execution status');
  assertExactKeys(record, [
    'state', 'intent', 'claim', 'leaseExpiresAt', 'start', 'receipt',
  ], 'execution status');
  if (!['pending', 'claimed', 'started', 'completed'].includes(String(record.state))) {
    throw new Error('execution status state 无效。');
  }
  assertSyncExecutionIntentV1(record.intent);
  if (record.claim !== null) assertSyncExecutionClaimV1(record.claim);
  if (record.start !== null) assertSyncExecutionStartV1(record.start);
  if (record.receipt !== null) assertSyncExecutionReceiptV1(record.receipt);
  if (record.leaseExpiresAt !== null) assertTimestamp(record.leaseExpiresAt, 'leaseExpiresAt');
  const status = record as SyncExecutionStatusV1;
  const operationId = status.intent.operationId;
  const scoped = [status.claim, status.start, status.receipt].filter(Boolean) as SignedExecutionRecordV1[];
  if (scoped.some((item) => item.vaultId !== status.intent.vaultId || item.operationId !== operationId)) {
    throw new Error('execution status 包含越界记录。');
  }
  if (status.state === 'pending' && (status.claim || status.start || status.receipt || status.leaseExpiresAt)) {
    throw new Error('pending execution status 不得携带执行状态。');
  }
  if (status.state === 'claimed' && (!status.claim || !status.leaseExpiresAt || status.start || status.receipt)) {
    throw new Error('claimed execution status 不完整。');
  }
  if (status.state === 'started' && (!status.claim || !status.start || status.receipt || status.leaseExpiresAt)) {
    throw new Error('started execution status 不完整。');
  }
  if (status.state === 'completed' && (!status.claim || !status.start || !status.receipt || status.leaseExpiresAt)) {
    throw new Error('completed execution status 不完整。');
  }
}

export function signSyncExecutionRecordV1<T extends Omit<SignedExecutionRecordV1, 'signature'>>(
  context: string,
  field: 'intent' | 'claim' | 'start' | 'receipt',
  record: T,
  signingPrivateKey: string,
) {
  const signature = signEd25519V1(
    canonicalizeJsonBytesV1({ context, [field]: record }),
    base64UrlToBytes(signingPrivateKey, 'signingPrivateKey', 32),
  );
  return { ...record, signature: bytesToBase64Url(signature) };
}

export function verifySyncExecutionRecordSignatureV1(
  context: string,
  field: 'intent' | 'claim' | 'start' | 'receipt',
  record: SignedExecutionRecordV1,
  signingPublicKey: string,
) {
  const { signature, ...unsigned } = record;
  return verifyEd25519V1(
    base64UrlToBytes(signature, 'signature', 64),
    canonicalizeJsonBytesV1({ context, [field]: unsigned }),
    base64UrlToBytes(signingPublicKey, 'signingPublicKey', 32),
  );
}
