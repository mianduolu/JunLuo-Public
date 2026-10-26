import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  TOOLS_WORKSPACE_BATCH_CAPTURE_POLICY,
} from './syncToolsWorkspaceApply';
import {
  runToolsWorkspaceBootstrap,
  type ToolsWorkspaceBootstrapResult,
} from './syncToolsWorkspaceBootstrap';
import {
  runToolsWorkspaceCaptureExclusive,
} from './syncToolsWorkspaceCaptureQueue';
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
  readToolsWorkspaceProjection,
  TOOLS_WORKSPACE_FILES_KEY,
  TOOLS_WORKSPACE_FILE_INDEX_KEY,
} from './syncToolsWorkspaceStorageDerivation';

export type ToolsWorkspaceBootstrapRuntimeResult =
  | ToolsWorkspaceBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
      objectCount: 0;
    };

export async function runToolsWorkspaceBootstrapRuntime():
Promise<ToolsWorkspaceBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
      objectCount: 0,
    };
  }
  return runToolsWorkspaceCaptureExclusive(async () => {
    const [
      { expoSyncRandomUuidV1 },
      { prepareToolsWorkspaceFileIndexRuntime },
    ] = await Promise.all([
      import('./syncCryptoExpo'),
      import('./syncToolsWorkspaceContentRuntime'),
    ]);
    const now = Date.now();
    const filesRaw = await RawAsyncStorage.getItem(
      TOOLS_WORKSPACE_FILES_KEY,
    );
    const prepared = await prepareToolsWorkspaceFileIndexRuntime({
      filesRaw,
      identity: currentDevice.identity,
      secrets: currentDevice.secrets,
      now,
    });
    return runToolsWorkspaceBootstrap({
      identity: currentDevice.identity,
      state: syncBootstrapStatePort,
      buildProjection: () => readToolsWorkspaceProjection({
        reader: RawAsyncStorage,
        capturedAt: now,
        fileIndex: prepared.index,
      }),
      envelopeFactory: (entity) => createSyncMutationEnvelope({
        identity: currentDevice.identity,
        entity,
        state: syncMutationStatePort,
        randomUuid: expoSyncRandomUuidV1,
        now: () => now,
      }),
      capture: {
        capture: async ({ operationId, mutations }) => {
          await captureSyncMutationBatch({
            operationId,
            policy: TOOLS_WORKSPACE_BATCH_CAPTURE_POLICY,
            durableCapture: {
              prepareSyncDurableIntent,
              advanceSyncDurableIntent,
              enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
            },
            mutations,
            performBusinessWrite: () => RawAsyncStorage.setItem(
              TOOLS_WORKSPACE_FILE_INDEX_KEY,
              prepared.raw,
            ),
            now: () => now,
          });
        },
      },
      now: () => now,
    });
  });
}
