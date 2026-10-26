import RawAsyncStorage from '@react-native-async-storage/async-storage';

import type {
  ResearchMaterialsStorageChange,
} from './syncResearchMaterialsStorageDerivation';
import { hasCurrentSyncDeviceSelection } from './syncCurrentDeviceSelection';
const MOBILE_CACHE_PREFIX =
  'junluo.lifeResearch.mobileCache.' as const;

async function performCapturedChanges<T>(
  changes: readonly ResearchMaterialsStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const applicable = changes.filter((change) => (
    change.kind === 'set'
    && change.key.startsWith(MOBILE_CACHE_PREFIX)
  ));
  if (!applicable.length) return performBusinessWrite();
  if (!(await hasCurrentSyncDeviceSelection())) return performBusinessWrite();
  const [
    {
      deriveMobileResearchMaterialMutations,
      projectMobileResearchMaterials,
    },
    { RESEARCH_MATERIALS_BATCH_CAPTURE_POLICY },
    { runResearchMaterialsCaptureExclusive },
    { loadCurrentSyncDevice },
    { captureSyncMutationBatch },
    { createSyncMutationEnvelope },
    {
      enqueueSyncMutationAndAdvanceHeads,
      syncMutationStatePort,
    },
    {
      advanceSyncDurableIntent,
      prepareSyncDurableIntent,
    },
    { expoSyncRandomUuidV1 },
  ] = await Promise.all([
    import('./syncResearchMaterialsStorageDerivation'),
    import('./syncResearchMaterialsApply'),
    import('./syncResearchMaterialsBootstrap'),
    import('./syncCurrentDevice'),
    import('./syncMutationBatchCapture'),
    import('./syncMutationEnvelope'),
    import('./syncMutationStateStore'),
    import('./syncStore'),
    import('./syncCryptoExpo'),
  ]);
  return runResearchMaterialsCaptureExclusive(async () => {
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) return performBusinessWrite();
    const keys = [...new Set(applicable.map((change) => change.key))];
    const previousEntries = await RawAsyncStorage.multiGet(keys);
    const nextByKey = new Map(previousEntries);
    for (const change of applicable) {
      if (change.kind === 'set') {
        nextByKey.set(change.key, change.value);
      }
    }
    const now = Date.now();
    const mutations = await deriveMobileResearchMaterialMutations({
      previous: projectMobileResearchMaterials(previousEntries),
      next: projectMobileResearchMaterials([...nextByKey.entries()]),
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
      policy: RESEARCH_MATERIALS_BATCH_CAPTURE_POLICY,
      durableCapture: {
        prepareSyncDurableIntent,
        advanceSyncDurableIntent,
        enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
      },
      mutations,
      performBusinessWrite: async () => {
        value = await performBusinessWrite();
      },
      now: () => now,
    });
    return value;
  });
}

export const researchMaterialsStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) =>
    RawAsyncStorage.multiGet([...keys]),
  getAllKeys: () => RawAsyncStorage.getAllKeys(),
  setItem: (key: string, value: string) =>
    performCapturedChanges(
      [{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value),
    ),
  removeItem: (key: string) =>
    RawAsyncStorage.removeItem(key),
  multiSet: (entries: readonly (readonly [string, string])[]) =>
    performCapturedChanges(
      entries.map(([key, value]) => ({
        kind: 'set' as const,
        key,
        value,
      })),
      () => RawAsyncStorage.multiSet(
        entries.map(([key, value]) => [key, value]),
      ),
    ),
  multiRemove: (keys: readonly string[]) =>
    RawAsyncStorage.multiRemove([...keys]),
};
