import { syncBootstrapOperationId } from './syncBootstrapContract';
import type { SyncDevicePublicIdentityV1 } from './syncDeviceContract';
import type { PlainMutationV1 } from './syncProtocol';
import type { SyncDurableIntentState } from './syncRecoveryIntent';
import { TOOLS_WORKSPACE_ADAPTER_ID } from './syncToolsWorkspace';
import type {
  ToolsWorkspaceEnvelopeFactory,
  ToolsWorkspaceProjection,
} from './syncToolsWorkspaceStorageDerivation';
import { deriveToolsWorkspaceMutations } from './syncToolsWorkspaceStorageDerivation';

export const TOOLS_WORKSPACE_BOOTSTRAP_VERSION = 1 as const;

export type ToolsWorkspaceBootstrapStatePort = {
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

export type ToolsWorkspaceBootstrapCapturePort = {
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
};

export type ToolsWorkspaceBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
  objectCount: number;
};

export async function runToolsWorkspaceBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: ToolsWorkspaceBootstrapStatePort;
  buildProjection(): Promise<ToolsWorkspaceProjection[]>;
  capture: ToolsWorkspaceBootstrapCapturePort;
  envelopeFactory: ToolsWorkspaceEnvelopeFactory;
  now?: () => number;
}) {
  const stateInput = {
    adapterId: TOOLS_WORKSPACE_ADAPTER_ID,
    version: TOOLS_WORKSPACE_BOOTSTRAP_VERSION,
    sourceDeviceId: input.identity.deviceId,
  };
  const operationId = syncBootstrapOperationId(stateInput);
  const state = await input.state.load(stateInput);
  if (state.completed) {
    return {
      status: 'already-complete',
      operationId,
      mutationCount: 0,
      objectCount: 0,
    } satisfies ToolsWorkspaceBootstrapResult;
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
      objectCount: 0,
    } satisfies ToolsWorkspaceBootstrapResult;
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
      objectCount: 0,
    } satisfies ToolsWorkspaceBootstrapResult;
  }
  const capturedAt = (input.now ?? Date.now)();
  const next = await input.buildProjection();
  const mutations = await deriveToolsWorkspaceMutations({
    previous: [],
    next,
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
    objectCount: next.filter((record) => record.kind === 'file-object').length,
  } satisfies ToolsWorkspaceBootstrapResult;
}
