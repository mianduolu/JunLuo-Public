import RawAsyncStorage from '@react-native-async-storage/async-storage';

import { getSecretItem } from '../storage/secretStore';
import {
  VAULT_SHARED_SECRETS_BATCH_CAPTURE_POLICY,
} from './syncVaultSharedSecretsApply';
import {
  runVaultSharedSecretsBootstrap,
  type VaultSharedSecretsBootstrapResult,
} from './syncVaultSharedSecretsBootstrap';
import {
  runVaultSharedSecretsCaptureExclusive,
} from './syncVaultSharedSecretsCaptureQueue';
import { syncBootstrapStatePort } from './syncBootstrapState';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  discoverVaultSharedSecretDefinitions,
} from './syncVaultSharedSecretDiscovery';
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
import {
  readVaultSharedSecretProjection,
} from './syncVaultSharedSecretsDerivation';

export type VaultSharedSecretsBootstrapRuntimeResult =
  | VaultSharedSecretsBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
    };

export async function runVaultSharedSecretsBootstrapRuntime():
Promise<VaultSharedSecretsBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
    };
  }
  const {
    migrateLegacyNearbyWorldAmapKeyForVaultBootstrap,
  } = await import('../nearby/nearbyWorldStore');
  await migrateLegacyNearbyWorldAmapKeyForVaultBootstrap();
  return runVaultSharedSecretsCaptureExclusive(async () => {
    const [
      { expoSyncRandomBytesV1, expoSyncRandomUuidV1 },
      { wrapVaultSharedSecretV1 },
    ] = await Promise.all([
      import('./syncCryptoExpo'),
      import('./syncVaultSharedSecretsCrypto'),
    ]);
    const now = Date.now();
    const definitions = await discoverVaultSharedSecretDefinitions(
      RawAsyncStorage,
    );
    return runVaultSharedSecretsBootstrap({
      identity: currentDevice.identity,
      state: syncBootstrapStatePort,
      buildProjection: () => readVaultSharedSecretProjection(
        { getItem: getSecretItem },
        definitions,
      ),
      envelopeFactory: (entity) => createSyncMutationEnvelope({
        identity: currentDevice.identity,
        entity,
        state: syncMutationStatePort,
        randomUuid: expoSyncRandomUuidV1,
        now: () => now,
      }),
      wrapSecret: ({ definition, secretValue, updatedAt }) =>
        wrapVaultSharedSecretV1({
          definition,
          secretValue,
          deviceSecrets: currentDevice.secrets,
          randomBytes: expoSyncRandomBytesV1,
          updatedAt,
        }),
      capture: {
        capture: async ({ operationId, mutations }) => {
          await captureSyncMutationBatch({
            operationId,
            policy: VAULT_SHARED_SECRETS_BATCH_CAPTURE_POLICY,
            durableCapture: {
              prepareSyncDurableIntent,
              advanceSyncDurableIntent,
              enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
            },
            mutations,
            performBusinessWrite: async () => undefined,
            now: () => now,
          });
        },
      },
      now: () => now,
    });
  });
}
