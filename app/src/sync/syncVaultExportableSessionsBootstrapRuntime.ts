import { getSecretItem } from '../storage/secretStore';
import {
  VAULT_EXPORTABLE_SESSIONS_BATCH_CAPTURE_POLICY,
} from './syncVaultExportableSessionsApply';
import {
  runVaultExportableSessionsBootstrap,
  type VaultExportableSessionsBootstrapResult,
} from './syncVaultExportableSessionsBootstrap';
import {
  runVaultExportableSessionsCaptureExclusive,
} from './syncVaultExportableSessionsCaptureQueue';
import { syncBootstrapStatePort } from './syncBootstrapState';
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
import {
  readVaultExportableSessionProjection,
} from './syncVaultExportableSessionsDerivation';

export type VaultExportableSessionsBootstrapRuntimeResult =
  | VaultExportableSessionsBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
    };

export async function runVaultExportableSessionsBootstrapRuntime():
Promise<VaultExportableSessionsBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
    };
  }
  return runVaultExportableSessionsCaptureExclusive(async () => {
    const [
      { expoSyncRandomBytesV1, expoSyncRandomUuidV1 },
      { wrapVaultExportableSessionSecretV1 },
    ] = await Promise.all([
      import('./syncCryptoExpo'),
      import('./syncVaultExportableSessionsCrypto'),
    ]);
    const now = Date.now();
    return runVaultExportableSessionsBootstrap({
      identity: currentDevice.identity,
      state: syncBootstrapStatePort,
      buildProjection: () => readVaultExportableSessionProjection({
        getItem: getSecretItem,
      }),
      envelopeFactory: (entity) => createSyncMutationEnvelope({
        identity: currentDevice.identity,
        entity,
        state: syncMutationStatePort,
        randomUuid: expoSyncRandomUuidV1,
        now: () => now,
      }),
      wrapSecret: ({ definition, secretValue, updatedAt }) =>
        wrapVaultExportableSessionSecretV1({
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
            policy: VAULT_EXPORTABLE_SESSIONS_BATCH_CAPTURE_POLICY,
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
