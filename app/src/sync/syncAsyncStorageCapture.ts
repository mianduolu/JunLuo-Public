import {
  assertPlainMutationV1,
  type PlainMutationV1,
} from './syncProtocol';
import {
  assertSyncDurableIntent,
  type SyncDurableIntent,
  type SyncDurableIntentState,
} from './syncRecoveryIntent';

export const ASYNC_STORAGE_WRITE_CAPTURE_KIND = 'async-storage-write-v1' as const;

export type AsyncStorageWriteCaptureIntentV1 = {
  kind: typeof ASYNC_STORAGE_WRITE_CAPTURE_KIND;
  storageKey: string;
  serializedValue: string;
  mutation: PlainMutationV1;
};

export interface SyncAsyncStorageWriter {
  setItem(storageKey: string, serializedValue: string): Promise<void>;
}

export interface SyncDurableCapturePort {
  prepareSyncDurableIntent(intent: SyncDurableIntent): Promise<void>;
  advanceSyncDurableIntent(input: {
    operationId: string;
    from: SyncDurableIntentState;
    to: SyncDurableIntentState;
    updatedAt: number;
  }): Promise<void>;
  enqueueSyncMutation(mutation: PlainMutationV1): Promise<void>;
}

export type SyncAsyncStorageCapturePolicy = {
  adapterId: string;
  isStorageKeyAllowed(storageKey: string): boolean;
};

type CaptureDependencies = {
  policy: SyncAsyncStorageCapturePolicy;
  writer: SyncAsyncStorageWriter;
  durableCapture: SyncDurableCapturePort;
  now?: () => number;
};

export type CaptureAsyncStorageSetInput = CaptureDependencies & {
  storageKey: string;
  serializedValue: string;
  mutation: PlainMutationV1;
};

export type RecoverAsyncStorageSetInput = CaptureDependencies & {
  durableIntent: SyncDurableIntent;
};

export type AsyncStorageCaptureResult = {
  operationId: string;
  replayedBusinessWrite: boolean;
  replayedOutboxEnqueue: boolean;
};

const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
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

function assertStorageKey(storageKey: unknown): asserts storageKey is string {
  if (typeof storageKey !== 'string' || storageKey.length < 1 || storageKey.length > 1024) {
    throw new Error('AsyncStorage key 长度必须在 1–1024 之间。');
  }
}

function readTimestamp(now: (() => number) | undefined, minimum: number) {
  const timestamp = (now ?? Date.now)();
  if (!Number.isSafeInteger(timestamp) || timestamp < minimum) {
    throw new Error(`同步捕获时间必须是大于等于 ${minimum} 的 Unix 毫秒整数。`);
  }
  return timestamp;
}

function assertPolicyAllowsKey(
  policy: SyncAsyncStorageCapturePolicy,
  storageKey: string,
) {
  assertAdapterId(policy.adapterId);
  if (!policy.isStorageKeyAllowed(storageKey)) {
    throw new Error(`适配器 ${policy.adapterId} 不允许捕获 AsyncStorage key：${storageKey}。`);
  }
}

export function assertAsyncStorageWriteCaptureIntentV1(
  value: unknown,
): asserts value is AsyncStorageWriteCaptureIntentV1 {
  const intent = recordOf(value, 'AsyncStorageWriteCaptureIntentV1');
  assertExactKeys(
    intent,
    ['kind', 'storageKey', 'serializedValue', 'mutation'],
    'AsyncStorageWriteCaptureIntentV1',
  );
  if (intent.kind !== ASYNC_STORAGE_WRITE_CAPTURE_KIND) {
    throw new Error('AsyncStorage durable intent kind 不受支持。');
  }
  assertStorageKey(intent.storageKey);
  if (typeof intent.serializedValue !== 'string') {
    throw new Error('AsyncStorage durable intent 的 serializedValue 必须是字符串。');
  }
  assertPlainMutationV1(intent.mutation);
}

function buildCaptureIntent(input: CaptureAsyncStorageSetInput) {
  assertPolicyAllowsKey(input.policy, input.storageKey);
  assertPlainMutationV1(input.mutation);
  const intent: AsyncStorageWriteCaptureIntentV1 = {
    kind: ASYNC_STORAGE_WRITE_CAPTURE_KIND,
    storageKey: input.storageKey,
    serializedValue: input.serializedValue,
    mutation: input.mutation,
  };
  assertAsyncStorageWriteCaptureIntentV1(intent);
  return intent;
}

export async function captureAsyncStorageSet(
  input: CaptureAsyncStorageSetInput,
): Promise<AsyncStorageCaptureResult> {
  const intent = buildCaptureIntent(input);
  const createdAt = readTimestamp(input.now, 0);
  const durableIntent: SyncDurableIntent = {
    operationId: intent.mutation.mutationId,
    adapterId: input.policy.adapterId,
    intent,
    state: 'prepared',
    createdAt,
    updatedAt: createdAt,
  };
  assertSyncDurableIntent(durableIntent);
  await input.durableCapture.prepareSyncDurableIntent(durableIntent);
  return recoverAsyncStorageSet({
    policy: input.policy,
    writer: input.writer,
    durableCapture: input.durableCapture,
    durableIntent,
    now: input.now,
  });
}

export async function recoverAsyncStorageSet(
  input: RecoverAsyncStorageSetInput,
): Promise<AsyncStorageCaptureResult> {
  assertSyncDurableIntent(input.durableIntent);
  if (!DURABLE_INTENT_STATES.has(input.durableIntent.state)) {
    throw new Error('AsyncStorage durable intent 状态无效。');
  }
  assertAdapterId(input.policy.adapterId);
  if (input.durableIntent.adapterId !== input.policy.adapterId) {
    throw new Error(
      `durable intent 属于 ${input.durableIntent.adapterId}，不能由 ${input.policy.adapterId} 恢复。`,
    );
  }
  assertAsyncStorageWriteCaptureIntentV1(input.durableIntent.intent);
  const intent = input.durableIntent.intent;
  assertPolicyAllowsKey(input.policy, intent.storageKey);
  if (input.durableIntent.operationId !== intent.mutation.mutationId) {
    throw new Error('durable intent operationId 与 mutationId 不一致。');
  }

  let state = input.durableIntent.state;
  let replayedBusinessWrite = false;
  let replayedOutboxEnqueue = false;

  if (state === 'prepared') {
    await input.writer.setItem(intent.storageKey, intent.serializedValue);
    replayedBusinessWrite = true;
    await input.durableCapture.advanceSyncDurableIntent({
      operationId: input.durableIntent.operationId,
      from: 'prepared',
      to: 'business_written',
      updatedAt: readTimestamp(input.now, input.durableIntent.createdAt),
    });
    state = 'business_written';
  }

  if (state === 'business_written') {
    await input.durableCapture.enqueueSyncMutation(intent.mutation);
    replayedOutboxEnqueue = true;
    await input.durableCapture.advanceSyncDurableIntent({
      operationId: input.durableIntent.operationId,
      from: 'business_written',
      to: 'captured',
      updatedAt: readTimestamp(input.now, input.durableIntent.createdAt),
    });
  }

  return {
    operationId: input.durableIntent.operationId,
    replayedBusinessWrite,
    replayedOutboxEnqueue,
  };
}
