import { syncBootstrapOperationId } from './syncBootstrapContract';
import type { SyncDevicePublicIdentityV1 } from './syncDeviceContract';
import type { PlainMutationV1 } from './syncProtocol';
import type { SyncDurableIntentState } from './syncRecoveryIntent';
import {
  VAULT_SHARED_SECRETS_ADAPTER_ID,
} from './syncVaultSharedSecrets';
import {
  deriveVaultSharedSecretMutations,
  type VaultSharedSecretEnvelopeFactory,
  type VaultSharedSecretProjection,
  type VaultSharedSecretWrapPort,
} from './syncVaultSharedSecretsDerivation';

export const VAULT_SHARED_SECRETS_BOOTSTRAP_VERSION = 1 as const;

export type VaultSharedSecretsBootstrapStatePort = {
  load(input: {
    adapterId: string;
    version: number;
    sourceDeviceId: string;
  }): Promise<{
    completed: boolean;
    durableIntentState: SyncDurableIntentState | null;
  }>;
  markCompleted(input: {
    adapterId: string;
    version: number;
    sourceDeviceId: string;
    updatedAt: number;
  }): Promise<void>;
};

export type VaultSharedSecretsBootstrapCapturePort = {
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
};

export type VaultSharedSecretsBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
};

export async function runVaultSharedSecretsBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: VaultSharedSecretsBootstrapStatePort;
  buildProjection(): Promise<VaultSharedSecretProjection[]>;
  capture: VaultSharedSecretsBootstrapCapturePort;
  envelopeFactory: VaultSharedSecretEnvelopeFactory;
  wrapSecret: VaultSharedSecretWrapPort;
  now?: () => number;
}) {
  const stateInput = {
    adapterId: VAULT_SHARED_SECRETS_ADAPTER_ID,
    version: VAULT_SHARED_SECRETS_BOOTSTRAP_VERSION,
    sourceDeviceId: input.identity.deviceId,
  };
  const operationId = syncBootstrapOperationId(stateInput);
  const state = await input.state.load(stateInput);
  if (state.completed) {
    return {
      status: 'already-complete',
      operationId,
      mutationCount: 0,
    } satisfies VaultSharedSecretsBootstrapResult;
  }
  if (state.durableIntentState === 'captured') {
    await input.state.markCompleted({
      ...stateInput,
      updatedAt: (input.now ?? Date.now)(),
    });
    return {
      status: 'completed',
      operationId,
      mutationCount: 0,
    } satisfies VaultSharedSecretsBootstrapResult;
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
    } satisfies VaultSharedSecretsBootstrapResult;
  }
  const capturedAt = (input.now ?? Date.now)();
  const mutations = await deriveVaultSharedSecretMutations({
    previous: [],
    next: await input.buildProjection(),
    capturedAt,
    envelopeFactory: input.envelopeFactory,
    wrapSecret: input.wrapSecret,
  });
  if (mutations.length) {
    await input.capture.capture({ operationId, mutations });
  }
  await input.state.markCompleted({
    ...stateInput,
    updatedAt: capturedAt,
  });
  return {
    status: 'completed',
    operationId,
    mutationCount: mutations.length,
  } satisfies VaultSharedSecretsBootstrapResult;
}
