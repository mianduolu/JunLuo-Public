import RawAsyncStorage from '@react-native-async-storage/async-storage';

import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { resolveAiCallBudgetScope } from '../ai/aiCallBudgetScope';
import {
  SEMANTIC_REVIEW_BUDGET_BATCH_CAPTURE_POLICY,
} from './syncSemanticReviewBudgetApply';
import {
  runSemanticReviewBudgetBootstrap,
  type SemanticReviewBudgetBootstrapResult,
} from './syncSemanticReviewBudgetBootstrap';
import {
  runSemanticReviewBudgetCaptureExclusive,
} from './syncSemanticReviewBudgetCaptureQueue';
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

const durableCapture = {
  prepareSyncDurableIntent,
  advanceSyncDurableIntent,
  enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
};

export type SemanticReviewBudgetBootstrapRuntimeResult =
  | SemanticReviewBudgetBootstrapResult
  | {
      status: 'no-current-device';
      operationId: null;
      mutationCount: 0;
    };

export async function runSemanticReviewBudgetBootstrapRuntime():
Promise<SemanticReviewBudgetBootstrapRuntimeResult> {
  const currentDevice = await loadCurrentSyncDevice();
  if (!currentDevice) {
    return {
      status: 'no-current-device',
      operationId: null,
      mutationCount: 0,
    };
  }
  const config = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
  const byId = new Map(
    config.connections.map((connection) => [connection.id, connection]),
  );
  return runSemanticReviewBudgetCaptureExclusive(async () => {
    const { expoSyncRandomUuidV1 } = await import('./syncCryptoExpo');
    const now = Date.now();
    return runSemanticReviewBudgetBootstrap({
      identity: currentDevice.identity,
      state: syncBootstrapStatePort,
      storage: RawAsyncStorage,
      resolveRemoteAccountId: (connectionId) => {
        const scope = resolveAiCallBudgetScope(byId.get(connectionId));
        return scope.kind === 'remote-account'
          ? scope.remoteAccountId
          : null;
      },
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
            policy: SEMANTIC_REVIEW_BUDGET_BATCH_CAPTURE_POLICY,
            durableCapture,
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
