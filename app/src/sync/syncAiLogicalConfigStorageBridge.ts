import RawAsyncStorage from '@react-native-async-storage/async-storage';

import type {
  AiLogicalConfigStorageChange,
} from './syncAiLogicalConfigDerivation';
import { hasCurrentSyncDeviceSelection } from './syncCurrentDeviceSelection';

const GLOBAL_KEYS = new Set([
  'junluo.aiProfile',
  'junluo.aiConnections',
  'junluo.memoryEmbedding.settings',
  'junluo.memoryReranker.settings',
  'junluo.voiceCall.settings.v1',
  'junluo.backend.settings',
]);

async function performCapturedChanges<T>(
  changes: readonly AiLogicalConfigStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const applicable = changes.filter((change) => GLOBAL_KEYS.has(change.key));
  if (!applicable.length) return performBusinessWrite();
  if (!(await hasCurrentSyncDeviceSelection())) return performBusinessWrite();
  const [
    {
      aiLogicalConfigStorageOverrides,
      deriveAiLogicalConfigMutations,
      readAiLogicalConfigProjection,
    },
    { AI_LOGICAL_CONFIG_BATCH_CAPTURE_POLICY },
    { runAiLogicalConfigCaptureExclusive },
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
    import('./syncAiLogicalConfigDerivation'),
    import('./syncAiLogicalConfigApply'),
    import('./syncAiLogicalConfigBootstrap'),
    import('./syncCurrentDevice'),
    import('./syncMutationBatchCapture'),
    import('./syncMutationEnvelope'),
    import('./syncMutationStateStore'),
    import('./syncStore'),
    import('./syncCryptoExpo'),
  ]);
  return runAiLogicalConfigCaptureExclusive(async () => {
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) return performBusinessWrite();
    const now = Date.now();
    const overrides = aiLogicalConfigStorageOverrides(applicable);
    const [previous, next] = await Promise.all([
      readAiLogicalConfigProjection({ reader: RawAsyncStorage }),
      readAiLogicalConfigProjection({
        reader: RawAsyncStorage,
        overrides,
      }),
    ]);
    const mutations = await deriveAiLogicalConfigMutations({
      previous,
      next,
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
      policy: AI_LOGICAL_CONFIG_BATCH_CAPTURE_POLICY,
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

export const aiLogicalConfigStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) => RawAsyncStorage.multiGet([...keys]),
  getAllKeys: () => RawAsyncStorage.getAllKeys(),
  setItem: (key: string, value: string) =>
    performCapturedChanges(
      [{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value),
    ),
  removeItem: (key: string) =>
    performCapturedChanges(
      [{ kind: 'remove', key }],
      () => RawAsyncStorage.removeItem(key),
    ),
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
    performCapturedChanges(
      keys.map((key) => ({ kind: 'remove' as const, key })),
      () => RawAsyncStorage.multiRemove([...keys]),
    ),
};
