import { loadBackendSettings } from '../backend/backendClient';
import { createAndroidSyncExecutionOnceController } from
  '../sync/syncExecutionOnceExpo';
import type {
  SyncExecutionOutcomeV2,
} from '../sync/syncExecutionClaimV2Protocol';
import { loadCurrentSyncRelayEnrollment } from
  '../sync/syncRelayClientExpo';

import {
  runLifeTickExecutionOnce,
  type LifeTickExecutionIdentity,
} from './lifeTickExecutionOnceCore';

export async function executeLifeTickOnce(
  identity: LifeTickExecutionIdentity,
  callbacks: {
    applyReceipt(
      outcome: SyncExecutionOutcomeV2,
      completedAt: number,
    ): Promise<void>;
    executeLocally(): Promise<SyncExecutionOutcomeV2>;
    reconcileLocally(): Promise<SyncExecutionOutcomeV2 | null>;
  },
) {
  const enrollment = await loadCurrentSyncRelayEnrollment();
  return runLifeTickExecutionOnce(identity, {
    ...callbacks,
    syncEnrollmentReady: enrollment !== null,
    loadRelayBaseUrl: async () => (await loadBackendSettings()).baseUrl,
    createCoordinator: async (baseUrl) => (
      await createAndroidSyncExecutionOnceController({ baseUrl })
    ).coordinator,
  });
}
