import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  PERSONA_EXPRESSION_OBJECTS_BATCH_CAPTURE_POLICY,
} from './syncPersonaExpressionObjectsApply';
import {
  runPersonaExpressionObjectsCaptureExclusive,
} from './syncPersonaExpressionObjectsCaptureQueue';
import {
  preparePersonaExpressionObjectsStorageChangesRuntime,
} from './syncPersonaExpressionObjectsContentRuntime';
import {
  derivePersonaExpressionObjectsMutationsForStorageChanges,
  type PersonaExpressionObjectsStorageChange,
} from './syncPersonaExpressionObjectsStorageDerivation';
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
  advanceSyncDurableIntent,
  prepareSyncDurableIntent,
} from './syncStore';

const durableCapture = {
  prepareSyncDurableIntent,
  advanceSyncDurableIntent,
  enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
};

async function performRawChanges(
  changes: readonly PersonaExpressionObjectsStorageChange[],
) {
  const sets = changes.flatMap((change) => (
    change.kind === 'set'
      ? [[change.key, change.value] as [string, string]]
      : []
  ));
  const removals = changes.flatMap((change) => (
    change.kind === 'remove' ? [change.key] : []
  ));
  if (sets.length) await RawAsyncStorage.multiSet(sets);
  if (removals.length) await RawAsyncStorage.multiRemove(removals);
}

async function performCapturedPersonaExpressionObjectsChangeUnqueued(
  changes: readonly PersonaExpressionObjectsStorageChange[],
) {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    await performRawChanges(changes);
    return;
  }
  const {
    expoSyncRandomUuidV1,
  } = await import('./syncCryptoExpo');
  const now = Date.now();
  const preparedChanges =
    await preparePersonaExpressionObjectsStorageChangesRuntime({
      changes,
      identity: currentDevice.identity,
      secrets: currentDevice.secrets,
      now,
    });
  const mutations =
    await derivePersonaExpressionObjectsMutationsForStorageChanges({
      changes: preparedChanges,
      reader: RawAsyncStorage,
      capturedAt: now,
      envelopeFactory: (entity) => createSyncMutationEnvelope({
        identity: currentDevice.identity,
        entity,
        state: syncMutationStatePort,
        randomUuid: expoSyncRandomUuidV1,
        now: () => now,
      }),
    });
  if (!mutations.length) {
    await performRawChanges(preparedChanges);
    return;
  }
  await captureSyncMutationBatch({
    operationId: expoSyncRandomUuidV1(),
    policy: PERSONA_EXPRESSION_OBJECTS_BATCH_CAPTURE_POLICY,
    durableCapture,
    mutations,
    performBusinessWrite: () => performRawChanges(preparedChanges),
    now: () => now,
  });
}

function performCapturedPersonaExpressionObjectsChange(
  changes: readonly PersonaExpressionObjectsStorageChange[],
) {
  return runPersonaExpressionObjectsCaptureExclusive(
    () => performCapturedPersonaExpressionObjectsChangeUnqueued(changes),
  );
}

export const personaExpressionObjectsStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) => RawAsyncStorage.multiGet(keys),
  getAllKeys: () => RawAsyncStorage.getAllKeys(),
  setItem: (key: string, value: string) =>
    performCapturedPersonaExpressionObjectsChange([
      { kind: 'set', key, value },
    ]),
  multiSet: (entries: readonly (readonly [string, string])[]) =>
    performCapturedPersonaExpressionObjectsChange(
      entries.map(([key, value]) => ({
        kind: 'set' as const,
        key,
        value,
      })),
    ),
  removeItem: (key: string) =>
    performCapturedPersonaExpressionObjectsChange([
      { kind: 'remove', key },
    ]),
  multiRemove: (keys: readonly string[]) =>
    performCapturedPersonaExpressionObjectsChange(
      keys.map((key) => ({ kind: 'remove' as const, key })),
    ),
};
