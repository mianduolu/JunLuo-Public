import { assertSyncUuidV4 } from './syncDeviceContract';
import { assertBase64Url } from './syncProtocol';

export type SyncExecutionOutcomeV2 = 'completed' | 'failed' | 'cancelled';
export type SyncExecutionClaimStateV2 = 'claimed' | 'started' | 'completed';

export type SyncExecutionClaimRequestV2 = {
  protocolVersion: 2;
};

export type SyncExecutionTransitionRequestV2 = {
  protocolVersion: 2;
  claimId: string;
};

export type SyncExecutionCompleteRequestV2 = SyncExecutionTransitionRequestV2 & {
  outcome: SyncExecutionOutcomeV2;
};

export type SyncExecutionClaimV2 = {
  protocolVersion: 2;
  operationId: string;
  state: SyncExecutionClaimStateV2;
  claimantDeviceId: string;
  claimId: string;
  leaseExpiresAt: number | null;
  outcome: SyncExecutionOutcomeV2 | null;
  completedAt: number | null;
  updatedAt: number;
};

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
  if (
    Object.keys(record).some((key) => !keys.includes(key))
    || keys.some((key) => !(key in record))
  ) {
    throw new Error(`${label} 字段不符合 v2 合同。`);
  }
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertOutcome(value: unknown, label: string) {
  if (value !== 'completed' && value !== 'failed' && value !== 'cancelled') {
    throw new Error(`${label} 无效。`);
  }
}

export function assertSyncExecutionClaimV2(
  value: unknown,
): asserts value is SyncExecutionClaimV2 {
  const record = recordOf(value, 'execution claim v2');
  assertExactKeys(record, [
    'protocolVersion', 'operationId', 'state', 'claimantDeviceId', 'claimId',
    'leaseExpiresAt', 'outcome', 'completedAt', 'updatedAt',
  ], 'execution claim v2');
  if (record.protocolVersion !== 2) throw new Error('execution claim v2 版本无效。');
  assertBase64Url(record.operationId, 'execution claim v2 operationId', { exactBytes: 32 });
  if (record.state !== 'claimed' && record.state !== 'started' && record.state !== 'completed') {
    throw new Error('execution claim v2 state 无效。');
  }
  assertSyncUuidV4(record.claimantDeviceId, 'execution claim v2 claimantDeviceId');
  assertSyncUuidV4(record.claimId, 'execution claim v2 claimId');
  assertTimestamp(record.updatedAt, 'execution claim v2 updatedAt');
  if (record.state === 'claimed') {
    assertTimestamp(record.leaseExpiresAt, 'execution claim v2 leaseExpiresAt');
    if (record.outcome !== null || record.completedAt !== null) {
      throw new Error('claimed execution claim v2 不得携带完成结果。');
    }
  } else if (record.state === 'started') {
    if (record.leaseExpiresAt !== null || record.outcome !== null || record.completedAt !== null) {
      throw new Error('started execution claim v2 状态内容无效。');
    }
  } else {
    if (record.leaseExpiresAt !== null || record.outcome === null || record.completedAt === null) {
      throw new Error('completed execution claim v2 状态内容不完整。');
    }
    assertOutcome(record.outcome, 'execution claim v2 outcome');
    assertTimestamp(record.completedAt, 'execution claim v2 completedAt');
  }
}

export function assertSyncExecutionTransitionRequestV2(
  value: unknown,
): asserts value is SyncExecutionTransitionRequestV2 {
  const record = recordOf(value, 'execution transition v2');
  assertExactKeys(record, ['protocolVersion', 'claimId'], 'execution transition v2');
  if (record.protocolVersion !== 2) throw new Error('execution transition v2 版本无效。');
  assertSyncUuidV4(record.claimId, 'execution transition v2 claimId');
}

export function assertSyncExecutionCompleteRequestV2(
  value: unknown,
): asserts value is SyncExecutionCompleteRequestV2 {
  const record = recordOf(value, 'execution completion v2');
  assertExactKeys(record, ['protocolVersion', 'claimId', 'outcome'], 'execution completion v2');
  if (record.protocolVersion !== 2) throw new Error('execution completion v2 版本无效。');
  assertSyncUuidV4(record.claimId, 'execution completion v2 claimId');
  assertOutcome(record.outcome, 'execution completion v2 outcome');
}
