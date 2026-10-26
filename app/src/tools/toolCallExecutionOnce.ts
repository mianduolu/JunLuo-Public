import { loadBackendSettings } from '../backend/backendClient';
import { createAndroidSyncExecutionOnceController } from
  '../sync/syncExecutionOnceExpo';
import type {
  SyncExecutionOutcomeV2,
} from '../sync/syncExecutionClaimV2Protocol';
import { loadCurrentSyncRelayEnrollment } from
  '../sync/syncRelayClientExpo';

import {
  runToolCallExecutionOnce,
  type ToolCallExecutionIdentity,
} from './toolCallExecutionOnceCore';

export async function executeToolCallOnce(
  identity: ToolCallExecutionIdentity,
  callbacks: {
    applyReceipt(
      outcome: SyncExecutionOutcomeV2,
      completedAt: number,
    ): Promise<void>;
    executeLocally(): Promise<SyncExecutionOutcomeV2>;
    hasUnresolvedAttempt?(): Promise<boolean>;
    reconcileLocally(): Promise<SyncExecutionOutcomeV2 | null>;
  },
) {
  const enrollment = await loadCurrentSyncRelayEnrollment();
  return runToolCallExecutionOnce(identity, {
    ...callbacks,
    syncEnrollmentReady: enrollment !== null,
    loadRelayBaseUrl: async () => (await loadBackendSettings()).baseUrl,
    createCoordinator: async (baseUrl) => (
      await createAndroidSyncExecutionOnceController({ baseUrl })
    ).coordinator,
  });
}
