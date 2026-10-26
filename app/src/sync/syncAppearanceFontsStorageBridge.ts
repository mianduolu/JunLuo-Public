import RawAsyncStorage from '@react-native-async-storage/async-storage';

import type {
  AppearanceFontStorageChange,
} from './syncAppearanceFontsStorageDerivation';
import { hasCurrentSyncDeviceSelection } from './syncCurrentDeviceSelection';
const FONT_CHOICE_KEY = 'junluo.fontChoice' as const;
const FONT_INDEX_KEY =
  'junluo.sync.appearance.fonts.v1' as const;

async function performCapturedChanges<T>(
  changes: readonly AppearanceFontStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const applicable = changes.filter(
    (change) => change.key === FONT_CHOICE_KEY,
  );
  if (!applicable.length) return performBusinessWrite();
  if (!(await hasCurrentSyncDeviceSelection())) return performBusinessWrite();
  const [
    {
      appearanceFontStorageOverrides,
      deriveAppearanceFontMutations,
      parseAppearanceFontLocalIndex,
      projectAppearanceFonts,
    },
    { APPEARANCE_FONTS_BATCH_CAPTURE_POLICY },
    { runAppearanceFontsCaptureExclusive },
    { loadCurrentSyncDevice },
    { captureSyncMutationBatch },
    { createSyncMutationEnvelope },
    {
      enqueueSyncMutationAndAdvanceHeads,
      loadSyncEntityHeadOperations,
      syncMutationStatePort,
    },
    {
      advanceSyncDurableIntent,
      prepareSyncDurableIntent,
    },
    { expoSyncRandomUuidV1 },
  ] = await Promise.all([
    import('./syncAppearanceFontsStorageDerivation'),
    import('./syncAppearanceFontsApply'),
    import('./syncAppearanceFontsBootstrap'),
    import('./syncCurrentDevice'),
    import('./syncMutationBatchCapture'),
    import('./syncMutationEnvelope'),
    import('./syncMutationStateStore'),
    import('./syncStore'),
    import('./syncCryptoExpo'),
  ]);
  return runAppearanceFontsCaptureExclusive(async () => {
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) return performBusinessWrite();
    const now = Date.now();
    const previousChoiceRaw = await RawAsyncStorage.getItem(
      FONT_CHOICE_KEY,
    );
    const previousIndex = parseAppearanceFontLocalIndex(
      await RawAsyncStorage.getItem(FONT_INDEX_KEY),
    );
    const override = appearanceFontStorageOverrides(applicable);
    const nextChoiceRaw = override === undefined
      ? previousChoiceRaw
      : override;
    const {
      prepareAppearanceFontIndexRuntime,
    } = await import('./syncAppearanceFontsContentRuntime');
    const prepared = await prepareAppearanceFontIndexRuntime({
      choiceRaw: nextChoiceRaw,
      previous: previousIndex,
      identity: currentDevice.identity,
      secrets: currentDevice.secrets,
      now,
    });
    const previous = projectAppearanceFonts({
      choiceRaw: previousChoiceRaw,
      index: previousIndex,
    });
    const next = projectAppearanceFonts({
      choiceRaw: nextChoiceRaw,
      index: prepared.index,
    });
    const mutations = await deriveAppearanceFontMutations({
      previous,
      next,
      capturedAt: now,
      envelopeFactory: async (entity) => ({
        ...await createSyncMutationEnvelope({
          identity: currentDevice.identity,
          entity,
          state: syncMutationStatePort,
          randomUuid: expoSyncRandomUuidV1,
          now: () => now,
        }),
        parentOperations:
          await loadSyncEntityHeadOperations(entity),
      }),
    });
    const write = async () => {
      const value = await performBusinessWrite();
      await RawAsyncStorage.setItem(FONT_INDEX_KEY, prepared.raw);
      return value;
    };
    if (!mutations.length) return write();
    let value!: T;
    await captureSyncMutationBatch({
      operationId: expoSyncRandomUuidV1(),
      policy: APPEARANCE_FONTS_BATCH_CAPTURE_POLICY,
      durableCapture: {
        prepareSyncDurableIntent,
        advanceSyncDurableIntent,
        enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
      },
      mutations,
      performBusinessWrite: async () => {
        value = await write();
      },
      now: () => now,
    });
    return value;
  });
}

export const appearanceFontStorageBridge = {
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
