import {
  TOOLS_AUDIT_ADAPTER_ID,
} from './syncToolsAudit';
import {
  deriveToolsAuditBootstrapMutations,
  TOOLS_AUDIT_LOG_KEY,
  type ToolsAuditEnvelopeFactory,
} from './syncToolsAuditStorageDerivation';
import { syncBootstrapOperationId } from './syncBootstrapContract';
import type { SyncDevicePublicIdentityV1 } from './syncDeviceContract';
import type { SyncDurableIntentState } from './syncRecoveryIntent';
import type { PlainMutationV1 } from './syncProtocol';

export const TOOLS_AUDIT_BOOTSTRAP_VERSION = 1 as const;

export type ToolsAuditBootstrapStatePort = {
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

export type ToolsAuditBootstrapStoragePort = {
  getItem(key: string): Promise<string | null>;
};

export type ToolsAuditBootstrapCapturePort = {
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
};

export type ToolsAuditBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
};

export async function runToolsAuditBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: ToolsAuditBootstrapStatePort;
  storage: ToolsAuditBootstrapStoragePort;
  capture: ToolsAuditBootstrapCapturePort;
  envelopeFactory: ToolsAuditEnvelopeFactory;
  now?: () => number;
}): Promise<ToolsAuditBootstrapResult> {
  const adapterId = TOOLS_AUDIT_ADAPTER_ID;
  const version = TOOLS_AUDIT_BOOTSTRAP_VERSION;
  const sourceDeviceId = input.identity.deviceId;
  const operationId = syncBootstrapOperationId({
    adapterId,
    version,
    sourceDeviceId,
  });
  const stateInput = { adapterId, version, sourceDeviceId };
  const state = await input.state.load(stateInput);
  if (state.completed) {
    return {
      status: 'already-complete',
      operationId,
      mutationCount: 0,
    };
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
    };
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
    };
  }
  const capturedAt = (input.now ?? Date.now)();
  const mutations = await deriveToolsAuditBootstrapMutations({
    raw: await input.storage.getItem(TOOLS_AUDIT_LOG_KEY),
    capturedAt,
    envelopeFactory: input.envelopeFactory,
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
  };
}
