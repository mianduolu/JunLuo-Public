import {
  bytesToBase64Url,
  canonicalizeJsonV1,
  sha256BytesV1,
} from './syncCrypto';

export const SYNC_EXECUTION_CATEGORIES = [
  'proactive-message',
  'life-tick',
  'reminder',
  'alarm',
  'tool-call',
  'wallet-transaction',
  'timer',
] as const;

export type SyncExecutionCategory = typeof SYNC_EXECUTION_CATEGORIES[number];

function assertStablePart(value: string, label: string, maximumLength: number) {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > maximumLength
  ) {
    throw new Error(`${label} 必须是无首尾空白的非空稳定标识。`);
  }
}

// This deliberately preserves the v1 byte-for-byte identity algorithm.
export function createSyncExecutionOperationId(input: {
  category: SyncExecutionCategory;
  scope: string;
  entityId: string;
  action: string;
}) {
  if (!SYNC_EXECUTION_CATEGORIES.includes(input.category)) {
    throw new Error('execution operation category 无效。');
  }
  assertStablePart(input.scope, 'execution operation scope', 128);
  assertStablePart(input.entityId, 'execution operation entityId', 512);
  assertStablePart(input.action, 'execution operation action', 128);
  return bytesToBase64Url(sha256BytesV1(new TextEncoder().encode(
    canonicalizeJsonV1({
      context: 'junluo.sync.v1/execution-operation-id',
      category: input.category,
      scope: input.scope,
      entityId: input.entityId,
      action: input.action,
    }),
  )));
}
