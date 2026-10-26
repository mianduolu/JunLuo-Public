import {
  assertSyncUuidV4,
} from './syncDeviceContract';

export type SyncCurrentBaselineCommitV1 = Readonly<{
  version: 1;
  vaultId: string;
  sourceDeviceId: string;
  keyId: string;
  completedAt: number;
}>;

export type SyncCurrentBaselineV1 = Readonly<{
  version: 1;
  vaultId: string;
  sourceDeviceId: string;
  keyId: string;
  mutationCount: number;
  relayCursor: number;
  completedAt: number;
}>;

export function assertSyncCurrentBaselineCommitV1(
  value: unknown,
): asserts value is SyncCurrentBaselineCommitV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('current baseline commit must be an object');
  }
  const record = value as Record<string, unknown>;
  const expected = [
    'version', 'vaultId', 'sourceDeviceId', 'keyId', 'completedAt',
  ];
  if (
    Object.keys(record).some((key) => !expected.includes(key))
    || expected.some((key) => !(key in record))
    || record.version !== 1
  ) {
    throw new Error('current baseline commit fields do not match v1');
  }
  assertSyncUuidV4(record.vaultId, 'current baseline vaultId');
  assertSyncUuidV4(record.sourceDeviceId, 'current baseline sourceDeviceId');
  assertSyncUuidV4(record.keyId, 'current baseline keyId');
  if (!Number.isSafeInteger(record.completedAt) || Number(record.completedAt) < 0) {
    throw new Error('current baseline completedAt is invalid');
  }
}

export function assertSyncCurrentBaselineV1(
  value: unknown,
): asserts value is SyncCurrentBaselineV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('current baseline receipt must be an object');
  }
  const record = value as Record<string, unknown>;
  const expected = [
    'version',
    'vaultId',
    'sourceDeviceId',
    'keyId',
    'mutationCount',
    'relayCursor',
    'completedAt',
  ];
  if (
    Object.keys(record).some((key) => !expected.includes(key))
    || expected.some((key) => !(key in record))
    || record.version !== 1
  ) {
    throw new Error('current baseline receipt fields do not match v1');
  }
  assertSyncUuidV4(record.vaultId, 'current baseline vaultId');
  assertSyncUuidV4(record.sourceDeviceId, 'current baseline sourceDeviceId');
  assertSyncUuidV4(record.keyId, 'current baseline keyId');
  for (const field of ['mutationCount', 'relayCursor', 'completedAt'] as const) {
    if (!Number.isSafeInteger(record[field]) || Number(record[field]) < 0) {
      throw new Error(`current baseline ${field} is invalid`);
    }
  }
}
