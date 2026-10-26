import {
  assertPlainMutationV1,
  type PlainMutationV1,
} from './syncProtocol';
import {
  assertSyncDurableIntent,
  type SyncDurableIntent,
  type SyncDurableIntentState,
} from './syncRecoveryIntent';
import type {
  SyncDurableCapturePort,
} from './syncAsyncStorageCapture';

export const SYNC_MUTATION_BATCH_CAPTURE_KIND = 'sync-mutation-batch-v1' as const;

export type SyncMutationBatchCaptureIntentV1 = {
  kind: typeof SYNC_MUTATION_BATCH_CAPTURE_KIND;
  mutations: PlainMutationV1[];
};

export type SyncMutationBatchCapturePolicy = {
  adapterId: string;
  isMutationAllowed(mutation: PlainMutationV1): boolean;
};

export interface SyncMutationBusinessApplier {
  applySyncMutation(mutation: PlainMutationV1): Promise<void>;
}

type CaptureDependencies = {
  policy: SyncMutationBatchCapturePolicy;
  durableCapture: SyncDurableCapturePort;
  now?: () => number;
};

export type CaptureSyncMutationBatchInput = CaptureDependencies & {
  operationId: string;
  mutations: PlainMutationV1[];
  performBusinessWrite(): Promise<void>;
};

export type RecoverSyncMutationBatchInput = CaptureDependencies & {
  durableIntent: SyncDurableIntent;
  businessApplier: SyncMutationBusinessApplier;
};

export type SyncMutationBatchCaptureResult = {
  operationId: string;
  replayedBusinessMutationCount: number;
  replayedOutboxMutationCount: number;
};

const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const DURABLE_INTENT_STATES = new Set<SyncDurableIntentState>([
  'prepared',
  'business_written',
  'captured',
]);

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string) {
  const expectedKeys = new Set(expected);
  const extra = Object.keys(record).filter((key) => !expectedKeys.has(key));
  if (extra.length) {
    throw new Error(`${label} 包含未允许字段：${extra.sort().join(', ')}。`);
  }
  const missing = expected.filter((key) => !(key in record));
  if (missing.length) {
    throw new Error(`${label} 缺少字段：${missing.join(', ')}。`);
  }
}

function assertAdapterId(adapterId: unknown): asserts adapterId is string {
  if (
    typeof adapterId !== 'string'
    || adapterId.length > 160
    || !ADAPTER_ID_PATTERN.test(adapterId)
  ) {
    throw new Error('adapterId 格式无效。');
  }
}

function assertOperationId(operationId: unknown): asserts operationId is string {
  if (
    typeof operationId !== 'string'
    || operationId.length < 1
    || operationId.length > 160
    || !OPERATION_ID_PATTERN.test(operationId)
  ) {
    throw new Error('operationId 格式无效。');
  }
}

function readTimestamp(now: (() => number) | undefined, minimum: number) {
  const value = (now ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`同步捕获时间必须是大于等于 ${minimum} 的 Unix 毫秒整数。`);
  }
  return value;
}

function assertPolicyAllowsMutations(
  policy: SyncMutationBatchCapturePolicy,
  mutations: readonly PlainMutationV1[],
) {
  assertAdapterId(policy.adapterId);
  if (!mutations.length) throw new Error('mutation batch 不能为空。');
  const mutationIds = new Set<string>();
  for (const mutation of mutations) {
    assertPlainMutationV1(mutation);
    if (!policy.isMutationAllowed(mutation)) {
      throw new Error(`适配器 ${policy.adapterId} 不允许 mutation ${mutation.mutationId}。`);
    }
    if (mutationIds.has(mutation.mutationId)) {
      throw new Error('mutation batch 不能包含重复 mutationId。');
    }
    mutationIds.add(mutation.mutationId);
  }
}

export function assertSyncMutationBatchCaptureIntentV1(
  value: unknown,
): asserts value is SyncMutationBatchCaptureIntentV1 {
  const intent = recordOf(value, 'SyncMutationBatchCaptureIntentV1');
  assertExactKeys(intent, ['kind', 'mutations'], 'SyncMutationBatchCaptureIntentV1');
  if (intent.kind !== SYNC_MUTATION_BATCH_CAPTURE_KIND) {
    throw new Error('mutation batch durable intent kind 不受支持。');
  }
  if (!Array.isArray(intent.mutations) || !intent.mutations.length) {
    throw new Error('mutation batch durable intent 不能为空。');
  }
  const mutationIds = new Set<string>();
  for (const mutation of intent.mutations) {
    assertPlainMutationV1(mutation);
    if (mutationIds.has(mutation.mutationId)) {
      throw new Error('mutation batch durable intent 不能包含重复 mutationId。');
    }
    mutationIds.add(mutation.mutationId);
  }
}

function buildIntent(input: CaptureSyncMutationBatchInput) {
  assertOperationId(input.operationId);
  assertPolicyAllowsMutations(input.policy, input.mutations);
  const intent: SyncMutationBatchCaptureIntentV1 = {
    kind: SYNC_MUTATION_BATCH_CAPTURE_KIND,
    mutations: input.mutations,
  };
  assertSyncMutationBatchCaptureIntentV1(intent);
  return intent;
}

async function enqueueBatch(
  durableCapture: SyncDurableCapturePort,
  mutations: readonly PlainMutationV1[],
) {
  for (const mutation of mutations) {
    await durableCapture.enqueueSyncMutation(mutation);
  }
}

export async function captureSyncMutationBatch(
  input: CaptureSyncMutationBatchInput,
): Promise<SyncMutationBatchCaptureResult> {
  const intent = buildIntent(input);
  const createdAt = readTimestamp(input.now, 0);
  const durableIntent: SyncDurableIntent = {
    operationId: input.operationId,
    adapterId: input.policy.adapterId,
    intent,
    state: 'prepared',
    createdAt,
    updatedAt: createdAt,
  };
  assertSyncDurableIntent(durableIntent);
  await input.durableCapture.prepareSyncDurableIntent(durableIntent);
  await input.performBusinessWrite();
  await input.durableCapture.advanceSyncDurableIntent({
    operationId: input.operationId,
    from: 'prepared',
    to: 'business_written',
    updatedAt: readTimestamp(input.now, createdAt),
  });
  await enqueueBatch(input.durableCapture, intent.mutations);
  await input.durableCapture.advanceSyncDurableIntent({
    operationId: input.operationId,
    from: 'business_written',
    to: 'captured',
    updatedAt: readTimestamp(input.now, createdAt),
  });
  return {
    operationId: input.operationId,
    replayedBusinessMutationCount: 0,
    replayedOutboxMutationCount: intent.mutations.length,
  };
}

export async function recoverSyncMutationBatch(
  input: RecoverSyncMutationBatchInput,
): Promise<SyncMutationBatchCaptureResult> {
  assertSyncDurableIntent(input.durableIntent);
  if (!DURABLE_INTENT_STATES.has(input.durableIntent.state)) {
    throw new Error('mutation batch durable intent 状态无效。');
  }
  assertAdapterId(input.policy.adapterId);
  if (input.durableIntent.adapterId !== input.policy.adapterId) {
    throw new Error(
      `durable intent 属于 ${input.durableIntent.adapterId}，不能由 ${input.policy.adapterId} 恢复。`,
    );
  }
  assertOperationId(input.durableIntent.operationId);
  assertSyncMutationBatchCaptureIntentV1(input.durableIntent.intent);
  const intent = input.durableIntent.intent;
  assertPolicyAllowsMutations(input.policy, intent.mutations);

  let state = input.durableIntent.state;
  let replayedBusinessMutationCount = 0;
  let replayedOutboxMutationCount = 0;
  if (state === 'prepared') {
    for (const mutation of intent.mutations) {
      await input.businessApplier.applySyncMutation(mutation);
      replayedBusinessMutationCount += 1;
    }
    await input.durableCapture.advanceSyncDurableIntent({
      operationId: input.durableIntent.operationId,
      from: 'prepared',
      to: 'business_written',
      updatedAt: readTimestamp(input.now, input.durableIntent.createdAt),
    });
    state = 'business_written';
  }
  if (state === 'business_written') {
    for (const mutation of intent.mutations) {
      await input.durableCapture.enqueueSyncMutation(mutation);
      replayedOutboxMutationCount += 1;
    }
    await input.durableCapture.advanceSyncDurableIntent({
      operationId: input.durableIntent.operationId,
      from: 'business_written',
      to: 'captured',
      updatedAt: readTimestamp(input.now, input.durableIntent.createdAt),
    });
  }
  return {
    operationId: input.durableIntent.operationId,
    replayedBusinessMutationCount,
    replayedOutboxMutationCount,
  };
}
