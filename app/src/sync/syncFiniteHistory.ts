import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalizeJsonBytesV1,
  signEd25519V1,
  verifyEd25519V1,
} from './syncCrypto';
import { assertSyncUuidV4 } from './syncDeviceContract';
import { assertBase64Url } from './syncProtocol';

export const FINITE_DELETION_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const STALE_SYNC_DEVICE_AFTER_MS = 90 * 24 * 60 * 60 * 1_000;
export const FINITE_DELETION_MAX_PER_ROUND = 32;

const FINITE_DELETION_CONTEXT =
  'junluo.sync.v1/finite-deletion-compaction';
const CURRENT_STATE_REFRESH_APPROVAL_CONTEXT =
  'junluo.sync.v1/current-state-refresh-approval';
const CURRENT_STATE_REFRESH_ENTRY_CONTEXT =
  'junluo.sync.v1/current-state-refresh-entry';

export type SyncDeviceFreshnessV2 = {
  version: 2;
  deviceId: string;
  lastAuthenticatedAt: number;
  appliedCursor: number;
  state: 'incremental' | 'refresh-required';
  historyFloorCursor: number;
  refreshRequiredAt: number | null;
};

export type FiniteDeletionTargetV1 = {
  mutationId: string;
  revisionId: string;
  sourceDeviceId: string;
  sourceSequence: number;
  relayCursor: number;
};

export type UnsignedFiniteDeletionCompactionV1 = {
  version: 1;
  compactionId: string;
  vaultId: string;
  sourceDeviceId: string;
  keyId: string;
  domain: string;
  entityType: string;
  entityId: string;
  tombstoneMutationId: string;
  tombstoneRevisionId: string;
  deletedAt: number;
  tombstoneRelayCursor: number;
  targets: FiniteDeletionTargetV1[];
};

export type FiniteDeletionCompactionV1 =
  UnsignedFiniteDeletionCompactionV1 & { signature: string };

export type FiniteDeletionCompactionStatusV1 = {
  version: 1;
  compactionId: string;
  state: 'local-cleanup' | 'receipt-retained' | 'complete';
  targetCount: number;
  acknowledgedDevices: number;
  requiredDevices: number;
  retainUntil: number | null;
};

export type CurrentStateRefreshStatusV1 = {
  version: 1;
  sessionId: string;
  requesterDeviceId: string;
  sourceDeviceId: string | null;
  state: 'waiting-android' | 'uploading' | 'ready' | 'complete' | 'cancelled';
  cutoverCursor: number | null;
  entryCount: number | null;
  uploadedEntries: number;
  requestedAt: number;
  updatedAt: number;
  approval: CurrentStateRefreshApprovalV1 | null;
};

export type UnsignedCurrentStateRefreshApprovalV1 = {
  version: 1;
  sessionId: string;
  vaultId: string;
  sourceDeviceId: string;
  requesterDeviceId: string;
  keyId: string;
  cutoverCursor: number;
  entryCount: number;
  snapshotDigest: string;
  approvedAt: number;
};

export type CurrentStateRefreshApprovalV1 =
  UnsignedCurrentStateRefreshApprovalV1 & { signature: string };

export type UnsignedCurrentStateRefreshEntryV1 = {
  version: 1;
  sessionId: string;
  sourceDeviceId: string;
  entryIndex: number;
  revisionId: string;
  entityKeyDigest: string;
  keyId: string;
  nonce: string;
  ciphertext: string;
  ciphertextSha256: string;
};

export type CurrentStateRefreshEntryV1 =
  UnsignedCurrentStateRefreshEntryV1 & { signature: string };

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertInteger(value: unknown, label: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} 必须是安全整数。`);
  }
}

function assertBounded(value: unknown, label: string, maximum: number) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} 必须是有界非空字符串。`);
  }
}

export function assertSyncDeviceFreshnessV2(
  value: unknown,
): asserts value is SyncDeviceFreshnessV2 {
  const record = asRecord(value, 'SyncDeviceFreshnessV2');
  if (record.version !== 2) throw new Error('设备进度账版本无效。');
  assertSyncUuidV4(record.deviceId, 'deviceId');
  assertInteger(record.lastAuthenticatedAt, 'lastAuthenticatedAt');
  assertInteger(record.appliedCursor, 'appliedCursor');
  assertInteger(record.historyFloorCursor, 'historyFloorCursor');
  if (record.state !== 'incremental' && record.state !== 'refresh-required') {
    throw new Error('设备进度账状态无效。');
  }
  if (record.refreshRequiredAt !== null) {
    assertInteger(record.refreshRequiredAt, 'refreshRequiredAt');
  }
  if ((record.state === 'refresh-required') !== (record.refreshRequiredAt !== null)) {
    throw new Error('设备刷新状态与时间不一致。');
  }
}

function assertFiniteTarget(value: unknown): asserts value is FiniteDeletionTargetV1 {
  const record = asRecord(value, 'finite deletion target');
  assertSyncUuidV4(record.mutationId, 'mutationId');
  assertSyncUuidV4(record.revisionId, 'revisionId');
  assertSyncUuidV4(record.sourceDeviceId, 'sourceDeviceId');
  assertInteger(record.sourceSequence, 'sourceSequence', 1);
  assertInteger(record.relayCursor, 'relayCursor', 1);
}

export function assertUnsignedFiniteDeletionCompactionV1(
  value: unknown,
): asserts value is UnsignedFiniteDeletionCompactionV1 {
  const record = asRecord(value, 'FiniteDeletionCompactionV1');
  if (record.version !== 1) throw new Error('有限删除整理版本无效。');
  for (const key of [
    'compactionId', 'vaultId', 'sourceDeviceId', 'keyId',
    'tombstoneMutationId', 'tombstoneRevisionId',
  ] as const) {
    assertSyncUuidV4(record[key], key);
  }
  assertBounded(record.domain, 'domain', 160);
  assertBounded(record.entityType, 'entityType', 160);
  assertBounded(record.entityId, 'entityId', 512);
  assertInteger(record.deletedAt, 'deletedAt');
  assertInteger(record.tombstoneRelayCursor, 'tombstoneRelayCursor', 1);
  if (!Array.isArray(record.targets) || record.targets.length < 1 || record.targets.length > 4096) {
    throw new Error('有限删除目标数量无效。');
  }
  record.targets.forEach(assertFiniteTarget);
  const mutationIds = record.targets.map((target) => target.mutationId);
  if (
    mutationIds.some((id, index) => index > 0 && id <= mutationIds[index - 1]!)
  ) {
    throw new Error('有限删除目标必须严格升序。');
  }
  const tombstone = record.targets.find(
    (target) => target.mutationId === record.tombstoneMutationId,
  );
  if (
    !tombstone
    || tombstone.revisionId !== record.tombstoneRevisionId
    || tombstone.relayCursor !== record.tombstoneRelayCursor
  ) {
    throw new Error('有限删除目标缺少精确 tombstone。');
  }
}

export function assertFiniteDeletionCompactionV1(
  value: unknown,
): asserts value is FiniteDeletionCompactionV1 {
  const record = asRecord(value, 'FiniteDeletionCompactionV1');
  const { signature, ...unsigned } = record;
  assertUnsignedFiniteDeletionCompactionV1(unsigned);
  assertBase64Url(signature, 'finite deletion signature', { exactBytes: 64 });
}

export function assertFiniteDeletionCompactionStatusV1(
  value: unknown,
): asserts value is FiniteDeletionCompactionStatusV1 {
  const record = asRecord(value, 'FiniteDeletionCompactionStatusV1');
  if (record.version !== 1) throw new Error('有限删除状态版本无效。');
  assertSyncUuidV4(record.compactionId, 'compactionId');
  if (!['local-cleanup', 'receipt-retained', 'complete'].includes(String(record.state))) {
    throw new Error('有限删除状态无效。');
  }
  for (const key of [
    'targetCount', 'acknowledgedDevices', 'requiredDevices',
  ] as const) {
    assertInteger(record[key], key);
  }
  if (record.retainUntil !== null) assertInteger(record.retainUntil, 'retainUntil');
}

function signedInput(context: string, field: string, value: unknown) {
  return canonicalizeJsonBytesV1({ context, [field]: value });
}

export function createFiniteDeletionCompactionV1(
  value: UnsignedFiniteDeletionCompactionV1,
  signingPrivateKey: string,
): FiniteDeletionCompactionV1 {
  assertUnsignedFiniteDeletionCompactionV1(value);
  const signed = {
    ...value,
    signature: bytesToBase64Url(signEd25519V1(
      signedInput(FINITE_DELETION_CONTEXT, 'compaction', value),
      base64UrlToBytes(signingPrivateKey, 'signingPrivateKey', 32),
    )),
  };
  assertFiniteDeletionCompactionV1(signed);
  return signed;
}

export function verifyFiniteDeletionCompactionV1(
  value: FiniteDeletionCompactionV1,
  signingPublicKey: string,
) {
  assertFiniteDeletionCompactionV1(value);
  const { signature, ...unsigned } = value;
  return verifyEd25519V1(
    base64UrlToBytes(signature, 'signature', 64),
    signedInput(FINITE_DELETION_CONTEXT, 'compaction', unsigned),
    base64UrlToBytes(signingPublicKey, 'signingPublicKey', 32),
  );
}

export function createCurrentStateRefreshApprovalV1(
  value: UnsignedCurrentStateRefreshApprovalV1,
  signingPrivateKey: string,
): CurrentStateRefreshApprovalV1 {
  assertSyncUuidV4(value.sessionId, 'sessionId');
  assertBase64Url(value.snapshotDigest, 'snapshotDigest', { exactBytes: 32 });
  return {
    ...value,
    signature: bytesToBase64Url(signEd25519V1(
      signedInput(CURRENT_STATE_REFRESH_APPROVAL_CONTEXT, 'approval', value),
      base64UrlToBytes(signingPrivateKey, 'signingPrivateKey', 32),
    )),
  };
}

export function assertCurrentStateRefreshApprovalV1(
  value: unknown,
): asserts value is CurrentStateRefreshApprovalV1 {
  const record = asRecord(value, 'CurrentStateRefreshApprovalV1');
  if (record.version !== 1) throw new Error('当前状态刷新批准版本无效。');
  for (const key of [
    'sessionId', 'vaultId', 'sourceDeviceId', 'requesterDeviceId', 'keyId',
  ] as const) {
    assertSyncUuidV4(record[key], key);
  }
  assertInteger(record.cutoverCursor, 'cutoverCursor');
  assertInteger(record.entryCount, 'entryCount');
  assertInteger(record.approvedAt, 'approvedAt');
  assertBase64Url(record.snapshotDigest, 'snapshotDigest', {
    exactBytes: 32,
  });
  assertBase64Url(record.signature, 'signature', { exactBytes: 64 });
}

export function verifyCurrentStateRefreshApprovalV1(
  value: CurrentStateRefreshApprovalV1,
  signingPublicKey: string,
) {
  assertCurrentStateRefreshApprovalV1(value);
  const { signature, ...unsigned } = value;
  return verifyEd25519V1(
    base64UrlToBytes(signature, 'signature', 64),
    signedInput(CURRENT_STATE_REFRESH_APPROVAL_CONTEXT, 'approval', unsigned),
    base64UrlToBytes(signingPublicKey, 'signingPublicKey', 32),
  );
}

export function createCurrentStateRefreshEntryV1(
  value: UnsignedCurrentStateRefreshEntryV1,
  signingPrivateKey: string,
): CurrentStateRefreshEntryV1 {
  return {
    ...value,
    signature: bytesToBase64Url(signEd25519V1(
      signedInput(CURRENT_STATE_REFRESH_ENTRY_CONTEXT, 'entry', value),
      base64UrlToBytes(signingPrivateKey, 'signingPrivateKey', 32),
    )),
  };
}

export function assertCurrentStateRefreshEntryV1(
  value: unknown,
): asserts value is CurrentStateRefreshEntryV1 {
  const record = asRecord(value, 'CurrentStateRefreshEntryV1');
  if (record.version !== 1) throw new Error('当前状态刷新条目版本无效。');
  for (const key of [
    'sessionId', 'sourceDeviceId', 'revisionId', 'keyId',
  ] as const) {
    assertSyncUuidV4(record[key], key);
  }
  assertInteger(record.entryIndex, 'entryIndex', 1);
  assertBase64Url(record.entityKeyDigest, 'entityKeyDigest', {
    exactBytes: 32,
  });
  assertBase64Url(record.nonce, 'nonce', { exactBytes: 24 });
  assertBase64Url(record.ciphertext, 'ciphertext', {
    maximumBytes: 1024 * 1024,
  });
  assertBase64Url(record.ciphertextSha256, 'ciphertextSha256', {
    exactBytes: 32,
  });
  assertBase64Url(record.signature, 'signature', { exactBytes: 64 });
}

export function verifyCurrentStateRefreshEntryV1(
  value: CurrentStateRefreshEntryV1,
  signingPublicKey: string,
) {
  const { signature, ...unsigned } = value;
  return verifyEd25519V1(
    base64UrlToBytes(signature, 'signature', 64),
    signedInput(CURRENT_STATE_REFRESH_ENTRY_CONTEXT, 'entry', unsigned),
    base64UrlToBytes(signingPublicKey, 'signingPublicKey', 32),
  );
}

export function assertCurrentStateRefreshStatusV1(
  value: unknown,
): asserts value is CurrentStateRefreshStatusV1 {
  const record = asRecord(value, 'CurrentStateRefreshStatusV1');
  if (record.version !== 1) throw new Error('当前状态刷新版本无效。');
  assertSyncUuidV4(record.sessionId, 'sessionId');
  assertSyncUuidV4(record.requesterDeviceId, 'requesterDeviceId');
  if (record.sourceDeviceId !== null) {
    assertSyncUuidV4(record.sourceDeviceId, 'sourceDeviceId');
  }
  if (!['waiting-android', 'uploading', 'ready', 'complete', 'cancelled'].includes(String(record.state))) {
    throw new Error('当前状态刷新状态无效。');
  }
  for (const key of ['uploadedEntries', 'requestedAt', 'updatedAt'] as const) {
    assertInteger(record[key], key);
  }
  if (record.cutoverCursor !== null) assertInteger(record.cutoverCursor, 'cutoverCursor');
  if (record.entryCount !== null) assertInteger(record.entryCount, 'entryCount');
  if (record.approval !== null) {
    assertCurrentStateRefreshApprovalV1(record.approval);
  }
}
