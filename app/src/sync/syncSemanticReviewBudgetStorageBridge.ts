import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { resolveAiCallBudgetScope } from '../ai/aiCallBudgetScope';
import {
  behaviorRoutingStorageBridge as BaseAsyncStorage,
} from './syncBehaviorRoutingStorageBridge';
import {
  SEMANTIC_REVIEW_BUDGET_BATCH_CAPTURE_POLICY,
} from './syncSemanticReviewBudgetApply';
import {
  runSemanticReviewBudgetCaptureExclusive,
} from './syncSemanticReviewBudgetCaptureQueue';
import {
  deriveSemanticReviewBudgetMutationsForStorageChanges,
  isSemanticReviewBudgetGlobalStorageKey,
  type SemanticReviewRemoteAccountResolver,
  type SemanticReviewBudgetStorageChange,
} from './syncSemanticReviewBudgetStorageDerivation';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import { captureSyncMutationBatch } from './syncMutationBatchCapture';
import { createSyncMutationEnvelope } from './syncMutationEnvelope';
import {
  enqueueSyncMutationAndAdvanceHeads,
  syncMutationStatePort,
} from './syncMutationStateStore';
import {
  advanceSyncDurableIntent,
  prepareSyncDurableIntent,
} from './syncStore';

const durableCapture = {
  prepareSyncDurableIntent,
  advanceSyncDurableIntent,
  enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
};

async function remoteAccountResolver():
Promise<SemanticReviewRemoteAccountResolver> {
  const config = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
  const byId = new Map(
    config.connections.map((connection) => [connection.id, connection]),
  );
  return (connectionId) => {
    const connection = byId.get(connectionId);
    const scope = resolveAiCallBudgetScope(connection);
    return scope.kind === 'remote-account'
      ? scope.remoteAccountId
      : null;
  };
}

async function performCapturedSemanticReviewBudgetChangeUnqueued<T>(
  changes: readonly SemanticReviewBudgetStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const globalChanges = changes.filter(
    (change) => isSemanticReviewBudgetGlobalStorageKey(change.key),
  );
  if (!globalChanges.length) return performBusinessWrite();
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) return performBusinessWrite();
  const resolveRemoteAccountId = await remoteAccountResolver();
  const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
  const now = Date.now();
  const mutations =
    await deriveSemanticReviewBudgetMutationsForStorageChanges({
      changes: globalChanges,
      reader: BaseAsyncStorage,
      sourceDeviceId: currentDevice.identity.deviceId,
      resolveRemoteAccountId,
      capturedAt: now,
      envelopeFactory: (entity) => createSyncMutationEnvelope({
        identity: currentDevice.identity,
        entity,
        state: syncMutationStatePort,
        randomUuid: expoSyncRandomUuidV1,
        now: () => now,
      }),
    });
  if (!mutations.length) return performBusinessWrite();
  let value!: T;
  await captureSyncMutationBatch({
    operationId: expoSyncRandomUuidV1(),
    policy: SEMANTIC_REVIEW_BUDGET_BATCH_CAPTURE_POLICY,
    durableCapture,
    mutations,
    performBusinessWrite: async () => {
      value = await performBusinessWrite();
    },
    now: () => now,
  });
  return value;
}

function performCapturedSemanticReviewBudgetChange<T>(
  changes: readonly SemanticReviewBudgetStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  return runSemanticReviewBudgetCaptureExclusive(
    () => performCapturedSemanticReviewBudgetChangeUnqueued(
      changes,
      performBusinessWrite,
    ),
  );
}

export const semanticReviewBudgetStorageBridge = {
  getItem: (key: string) => BaseAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) => BaseAsyncStorage.multiGet(keys),
  getAllKeys: () => BaseAsyncStorage.getAllKeys(),
  setItem: (key: string, value: string) =>
    performCapturedSemanticReviewBudgetChange(
      [{ kind: 'set', key, value }],
      () => BaseAsyncStorage.setItem(key, value),
    ),
  multiSet: (entries: readonly (readonly [string, string])[]) => {
    const writableEntries = entries.map(
      ([key, value]) => [key, value] as [string, string],
    );
    return performCapturedSemanticReviewBudgetChange(
      writableEntries.map(([key, value]) => ({
        kind: 'set' as const,
        key,
        value,
      })),
      () => BaseAsyncStorage.multiSet(writableEntries),
    );
  },
  removeItem: (key: string) =>
    performCapturedSemanticReviewBudgetChange(
      [{ kind: 'remove', key }],
      () => BaseAsyncStorage.removeItem(key),
    ),
  multiRemove: (keys: readonly string[]) => {
    const writableKeys = [...keys];
    return performCapturedSemanticReviewBudgetChange(
      writableKeys.map((key) => ({
        kind: 'remove' as const,
        key,
      })),
      () => BaseAsyncStorage.multiRemove(writableKeys),
    );
  },
};
