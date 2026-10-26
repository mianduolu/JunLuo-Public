import { syncBootstrapOperationId } from './syncBootstrapContract';
import type { SyncDevicePublicIdentityV1 } from './syncDeviceContract';
import type { PlainMutationV1 } from './syncProtocol';
import type { SyncDurableIntentState } from './syncRecoveryIntent';
import {
  VAULT_EXPORTABLE_SESSIONS_ADAPTER_ID,
} from './syncVaultExportableSessions';
import {
  deriveVaultExportableSessionMutations,
  type VaultExportableSessionEnvelopeFactory,
  type VaultExportableSessionProjection,
  type VaultExportableSessionWrapPort,
} from './syncVaultExportableSessionsDerivation';

export const VAULT_EXPORTABLE_SESSIONS_BOOTSTRAP_VERSION =
  1 as const;

export type VaultExportableSessionsBootstrapStatePort = {
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

export type VaultExportableSessionsBootstrapCapturePort = {
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
};

export type VaultExportableSessionsBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
};

export async function runVaultExportableSessionsBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: VaultExportableSessionsBootstrapStatePort;
  buildProjection(): Promise<VaultExportableSessionProjection[]>;
  capture: VaultExportableSessionsBootstrapCapturePort;
  envelopeFactory: VaultExportableSessionEnvelopeFactory;
  wrapSecret: VaultExportableSessionWrapPort;
  now?: () => number;
}) {
  const stateInput = {
    adapterId: VAULT_EXPORTABLE_SESSIONS_ADAPTER_ID,
    version: VAULT_EXPORTABLE_SESSIONS_BOOTSTRAP_VERSION,
    sourceDeviceId: input.identity.deviceId,
  };
  const operationId = syncBootstrapOperationId(stateInput);
  const state = await input.state.load(stateInput);
  if (state.completed) {
    return {
      status: 'already-complete',
      operationId,
      mutationCount: 0,
    } satisfies VaultExportableSessionsBootstrapResult;
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
    } satisfies VaultExportableSessionsBootstrapResult;
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
    } satisfies VaultExportableSessionsBootstrapResult;
  }
  const capturedAt = (input.now ?? Date.now)();
  const mutations = await deriveVaultExportableSessionMutations({
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
  } satisfies VaultExportableSessionsBootstrapResult;
}
