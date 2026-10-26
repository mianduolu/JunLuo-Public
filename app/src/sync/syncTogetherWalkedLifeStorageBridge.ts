import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  TOGETHER_WALKED_LIFE_BATCH_CAPTURE_POLICY,
} from './syncTogetherWalkedLifeApply';
import {
  enableTogetherWalkedLifeStorageCapture,
  isTogetherWalkedLifeStorageCaptureEnabled,
  runTogetherWalkedLifeCaptureExclusive,
} from './syncTogetherWalkedLifeCaptureQueue';
import {
  prepareTogetherWalkedLifeLocalIndexRuntime,
} from './syncTogetherWalkedLifeContentRuntime';
import {
  loadCurrentSyncDevice,
} from './syncCurrentDevice';
import {
  captureSyncMutationBatch,
} from './syncMutationBatchCapture';
import {
  createSyncMutationEnvelope,
} from './syncMutationEnvelope';
import {
  enqueueSyncMutationAndAdvanceHeads,
  syncMutationStatePort,
} from './syncMutationStateStore';
import {
  deriveTogetherWalkedLifeMutations,
  isTogetherWalkedLifeGlobalStorageKey,
  parseTogetherWalkedLifeLocalIndex,
  serializeTogetherWalkedLifeLocalIndex,
  TOGETHER_WALKED_LIFE_GLOBAL_KEYS,
  TOGETHER_WALKED_LIFE_INDEX_KEY,
  type TogetherWalkedLifeRawSnapshot,
} from './syncTogetherWalkedLifeStorageDerivation';
import {
  advanceSyncDurableIntent,
  prepareSyncDurableIntent,
} from './syncStore';

const durableCapture = {
  prepareSyncDurableIntent,
  advanceSyncDurableIntent,
  enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
};

type StorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

type CaptureOptions = {
  forceCapture?: boolean;
  writeBusinessData?: boolean;
};

async function readRawSnapshot():
Promise<TogetherWalkedLifeRawSnapshot> {
  const values = await RawAsyncStorage.multiGet(
    TOGETHER_WALKED_LIFE_GLOBAL_KEYS,
  );
  return Object.fromEntries(values);
}

function nextRawSnapshot(
  previous: TogetherWalkedLifeRawSnapshot,
  changes: readonly StorageChange[],
) {
  const next: Record<string, string | null> = { ...previous };
  for (const change of changes) {
    if (!isTogetherWalkedLifeGlobalStorageKey(change.key)) continue;
    next[change.key] = change.kind === 'set'
      ? change.value
      : null;
  }
  return next;
}

async function performRawChanges(changes: readonly StorageChange[]) {
  const lastByKey = new Map<string, StorageChange>();
  for (const change of changes) lastByKey.set(change.key, change);
  const sets = [...lastByKey.values()].flatMap((change) =>
    change.kind === 'set'
      ? [[change.key, change.value] as [string, string]]
      : []);
  const removals = [...lastByKey.values()].flatMap((change) =>
    change.kind === 'remove' ? [change.key] : []);
  if (sets.length) await RawAsyncStorage.multiSet(sets);
  if (removals.length) await RawAsyncStorage.multiRemove(removals);
}

// The caller owns the shared queue for the whole read/modify/write operation.
async function captureChangesWhileLocked(
  changes: readonly StorageChange[],
  options: CaptureOptions = {},
) {
  const writeBusinessData = options.writeBusinessData !== false;
  const globalChanges = changes.filter(
    (change) => isTogetherWalkedLifeGlobalStorageKey(change.key),
  );
  if (
    !globalChanges.length
    || (
      !options.forceCapture
      && !isTogetherWalkedLifeStorageCaptureEnabled()
    )
  ) {
    if (writeBusinessData) await performRawChanges(changes);
    return;
  }
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    if (writeBusinessData) await performRawChanges(changes);
    return;
  }
  const now = Date.now();
  const previousRaw = await readRawSnapshot();
  const nextRaw = nextRawSnapshot(previousRaw, globalChanges);
  const previousIndex = parseTogetherWalkedLifeLocalIndex(
    await RawAsyncStorage.getItem(
      TOGETHER_WALKED_LIFE_INDEX_KEY,
    ),
  );
  const nextIndex =
    await prepareTogetherWalkedLifeLocalIndexRuntime({
      raw: nextRaw,
      previous: previousIndex,
      identity: currentDevice.identity,
      secrets: currentDevice.secrets,
      now,
    });
  const {
    expoSyncRandomUuidV1,
  } = await import('./syncCryptoExpo');
  const mutations = await deriveTogetherWalkedLifeMutations({
    previousRaw,
    nextRaw,
    previousIndex,
    nextIndex,
    capturedAt: now,
    envelopeFactory: (entity) => createSyncMutationEnvelope({
      identity: currentDevice.identity,
      entity,
      state: syncMutationStatePort,
      randomUuid: expoSyncRandomUuidV1,
      now: () => now,
    }),
  });
  const nextIndexRaw =
    serializeTogetherWalkedLifeLocalIndex(nextIndex);
  const performBusinessWrite = async () => {
    if (writeBusinessData) await performRawChanges(changes);
    await RawAsyncStorage.setItem(
      TOGETHER_WALKED_LIFE_INDEX_KEY,
      nextIndexRaw,
    );
  };
  if (!mutations.length) {
    await performBusinessWrite();
    return;
  }
  await captureSyncMutationBatch({
    operationId: expoSyncRandomUuidV1(),
    policy: TOGETHER_WALKED_LIFE_BATCH_CAPTURE_POLICY,
    durableCapture,
    mutations,
    performBusinessWrite,
    now: () => now,
  });
}

export async function reconcileTogetherWalkedLifeStorageBridge() {
  await runTogetherWalkedLifeCaptureExclusive(async () => {
    const raw = await readRawSnapshot();
    const changes = TOGETHER_WALKED_LIFE_GLOBAL_KEYS.flatMap(
      (key): StorageChange[] => {
        const value = raw[key];
        return value === null || value === undefined
          ? []
          : [{ kind: 'set', key, value }];
      },
    );
    if (!changes.length) return;
    await captureChangesWhileLocked(changes, {
      forceCapture: true,
      writeBusinessData: false,
    });
    enableTogetherWalkedLifeStorageCapture();
  });
}

const togetherWalkedStorageMutationAdapter = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) =>
    RawAsyncStorage.multiGet([...keys]),
  getAllKeys: () => RawAsyncStorage.getAllKeys(),
  setItem: (key: string, value: string) =>
    captureChangesWhileLocked([{ kind: 'set', key, value }]),
  removeItem: (key: string) =>
    captureChangesWhileLocked([{ kind: 'remove', key }]),
  multiSet: (entries: readonly (readonly [string, string])[]) =>
    captureChangesWhileLocked(entries.map(([key, value]) => ({
      kind: 'set' as const,
      key,
      value,
    }))),
  multiRemove: (keys: readonly string[]) =>
    captureChangesWhileLocked(keys.map((key) => ({
      kind: 'remove' as const,
      key,
    }))),
};

export const togetherWalkedStorageBridge = {
  ...togetherWalkedStorageMutationAdapter,
  setItem: (key: string, value: string) =>
    runTogetherWalkedLifeCaptureExclusive(() =>
      togetherWalkedStorageMutationAdapter.setItem(key, value)),
  removeItem: (key: string) =>
    runTogetherWalkedLifeCaptureExclusive(() =>
      togetherWalkedStorageMutationAdapter.removeItem(key)),
  multiSet: (entries: readonly (readonly [string, string])[]) =>
    runTogetherWalkedLifeCaptureExclusive(() =>
      togetherWalkedStorageMutationAdapter.multiSet(entries)),
  multiRemove: (keys: readonly string[]) =>
    runTogetherWalkedLifeCaptureExclusive(() =>
      togetherWalkedStorageMutationAdapter.multiRemove(keys)),
};

/** Use the supplied adapter for writes; the public bridge would re-enter the queue. */
export function runTogetherWalkedStorageMutation<T>(
  work: (storage: typeof togetherWalkedStorageBridge) => Promise<T>,
): Promise<T> {
  return runTogetherWalkedLifeCaptureExclusive(() =>
    work(togetherWalkedStorageMutationAdapter));
}
