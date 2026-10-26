import {
  proactiveLedgerStorageBridge,
} from './syncProactiveLedgerStorageBridge';
import { preserveDailyPlanningSettings } from '../life/autonomySettingsCompatibility';
import {
  RELATIONSHIP_AUTHORIZATION_BATCH_CAPTURE_POLICY,
} from './syncRelationshipAuthorizationApply';
import {
  runRelationshipAuthorizationCaptureExclusive,
} from './syncRelationshipAuthorizationCaptureQueue';
import {
  deriveRelationshipAuthorizationMutationsForStorageChanges,
  RELATIONSHIP_AUTONOMY_SETTINGS_KEY,
  isRelationshipAuthorizationGlobalStorageKey,
  type RelationshipAuthorizationStorageChange,
  type RelationshipAuthorizationStorageReadPort,
} from './syncRelationshipAuthorizationStorageDerivation';
import {
  semanticReviewBudgetStorageBridge,
} from './syncSemanticReviewBudgetStorageBridge';
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

type AsyncStorageBridgePort = RelationshipAuthorizationStorageReadPort & {
  multiGet(
    keys: readonly string[],
  ): Promise<readonly (readonly [string, string | null])[]>;
  getAllKeys(): Promise<readonly string[]>;
  setItem(key: string, value: string): Promise<void>;
  multiSet(entries: readonly (readonly [string, string])[]): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiRemove(keys: readonly string[]): Promise<void>;
};

const durableCapture = {
  prepareSyncDurableIntent,
  advanceSyncDurableIntent,
  enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
};

function createRelationshipAuthorizationStorageBridge(
  BaseAsyncStorage: AsyncStorageBridgePort,
) {
  async function performCapturedChangeUnqueued<T>(
    changes: readonly RelationshipAuthorizationStorageChange[],
    performBusinessWrite: () => Promise<T>,
  ) {
    const globalChanges = changes.filter(
      (change) => isRelationshipAuthorizationGlobalStorageKey(change.key),
    );
    if (!globalChanges.length) return performBusinessWrite();
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) return performBusinessWrite();
    const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
    const now = Date.now();
    const mutations =
      await deriveRelationshipAuthorizationMutationsForStorageChanges({
        changes: globalChanges,
        reader: BaseAsyncStorage,
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
      policy: RELATIONSHIP_AUTHORIZATION_BATCH_CAPTURE_POLICY,
      durableCapture,
      mutations,
      performBusinessWrite: async () => {
        value = await performBusinessWrite();
      },
      now: () => now,
    });
    return value;
  }

  function performCapturedChange<T>(
    changes: readonly RelationshipAuthorizationStorageChange[],
    performBusinessWrite: () => Promise<T>,
  ) {
    return runRelationshipAuthorizationCaptureExclusive(
      () => performCapturedChangeUnqueued(changes, performBusinessWrite),
    );
  }

  return {
    getItem: (key: string) => BaseAsyncStorage.getItem(key),
    multiGet: (keys: readonly string[]) => BaseAsyncStorage.multiGet(keys),
    getAllKeys: () => BaseAsyncStorage.getAllKeys(),
    setItem: (key: string, value: string) => runRelationshipAuthorizationCaptureExclusive(async () => {
      const next = key === RELATIONSHIP_AUTONOMY_SETTINGS_KEY
        ? preserveDailyPlanningSettings(await BaseAsyncStorage.getItem(key), value) : value;
      return performCapturedChangeUnqueued([{ kind: 'set', key, value: next }], () => BaseAsyncStorage.setItem(key, next));
    }),
    multiSet: (entries: readonly (readonly [string, string])[]) => runRelationshipAuthorizationCaptureExclusive(async () => {
      const writableEntries = await Promise.all(entries.map(async ([key, value]): Promise<[string, string]> => [key,
        key === RELATIONSHIP_AUTONOMY_SETTINGS_KEY ? preserveDailyPlanningSettings(await BaseAsyncStorage.getItem(key), value) : value,
      ]));
      return performCapturedChangeUnqueued(
        writableEntries.map(([key, value]) => ({
          kind: 'set' as const,
          key,
          value,
        })),
        () => BaseAsyncStorage.multiSet(writableEntries),
      );
    }),
    removeItem: (key: string) =>
      performCapturedChange(
        [{ kind: 'remove', key }],
        () => BaseAsyncStorage.removeItem(key),
      ),
    multiRemove: (keys: readonly string[]) => {
      const writableKeys = [...keys];
      return performCapturedChange(
        writableKeys.map((key) => ({
          kind: 'remove' as const,
          key,
        })),
        () => BaseAsyncStorage.multiRemove(writableKeys),
      );
    },
  };
}

export const relationshipAuthorizationStorageBridge =
  createRelationshipAuthorizationStorageBridge(
    semanticReviewBudgetStorageBridge,
  );

export const relationshipAuthorizationOverProactiveLedgerStorageBridge =
  createRelationshipAuthorizationStorageBridge(
    proactiveLedgerStorageBridge,
  );
