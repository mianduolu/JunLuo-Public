import RawAsyncStorage from '@react-native-async-storage/async-storage';

import type {
  AppearanceBackgroundStorageChange,
} from './syncAppearanceBackgroundStorageDerivation';
import { hasCurrentSyncDeviceSelection } from './syncCurrentDeviceSelection';
const BACKGROUND_SETTINGS_KEY =
  'junluo.backgroundSettings' as const;
const BACKGROUND_INDEX_KEY =
  'junluo.sync.appearance.background.v1' as const;

async function performCapturedChanges<T>(
  changes: readonly AppearanceBackgroundStorageChange[],
  performBusinessWrite: () => Promise<T>,
) {
  const applicable = changes.filter(
    (change) => change.key === BACKGROUND_SETTINGS_KEY,
  );
  if (!applicable.length) return performBusinessWrite();
  if (!(await hasCurrentSyncDeviceSelection())) return performBusinessWrite();
  const [
    {
      appearanceBackgroundStorageOverride,
      deriveAppearanceBackgroundMutations,
      parseAppearanceBackgroundLocalIndex,
      parseAppearanceBackgroundSettings,
      projectAppearanceBackground,
    },
    { APPEARANCE_BACKGROUND_BATCH_CAPTURE_POLICY },
    { runAppearanceBackgroundCaptureExclusive },
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
    import('./syncAppearanceBackgroundStorageDerivation'),
    import('./syncAppearanceBackgroundApply'),
    import('./syncAppearanceBackgroundBootstrap'),
    import('./syncCurrentDevice'),
    import('./syncMutationBatchCapture'),
    import('./syncMutationEnvelope'),
    import('./syncMutationStateStore'),
    import('./syncStore'),
    import('./syncCryptoExpo'),
  ]);
  return runAppearanceBackgroundCaptureExclusive(async () => {
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) return performBusinessWrite();
    const now = Date.now();
    const previousSettingsRaw = await RawAsyncStorage.getItem(
      BACKGROUND_SETTINGS_KEY,
    );
    const previousIndex = parseAppearanceBackgroundLocalIndex(
      await RawAsyncStorage.getItem(BACKGROUND_INDEX_KEY),
    );
    const override = appearanceBackgroundStorageOverride(applicable);
    const nextSettingsRaw = override === undefined
      ? previousSettingsRaw
      : override;
    const {
      prepareAppearanceBackgroundIndexRuntime,
    } = await import('./syncAppearanceBackgroundContentRuntime');
    const prepared = await prepareAppearanceBackgroundIndexRuntime({
      settingsRaw: nextSettingsRaw,
      previous: previousIndex,
      identity: currentDevice.identity,
      secrets: currentDevice.secrets,
      now,
    });
    const previousSettings = parseAppearanceBackgroundSettings(
      previousSettingsRaw,
    );
    const previous = (
      previousSettings.mode === 'image'
      && !previousIndex.selectedObjectId
    )
      ? []
      : projectAppearanceBackground({
        settingsRaw: previousSettingsRaw,
        index: previousIndex,
      });
    const next = projectAppearanceBackground({
      settingsRaw: nextSettingsRaw,
      index: prepared.index,
    });
    const mutations = await deriveAppearanceBackgroundMutations({
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
    const write = async () => {
      const value = await performBusinessWrite();
      await RawAsyncStorage.setItem(
        BACKGROUND_INDEX_KEY,
        prepared.raw,
      );
      return value;
    };
    if (!mutations.length) return write();
    let value!: T;
    await captureSyncMutationBatch({
      operationId: expoSyncRandomUuidV1(),
      policy: APPEARANCE_BACKGROUND_BATCH_CAPTURE_POLICY,
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

export const appearanceBackgroundStorageBridge = {
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
